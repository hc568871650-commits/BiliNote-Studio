"""Reading-only protocol adapters; the video GPTFactory path is unchanged."""
import json
import re
import hashlib
from types import SimpleNamespace
from urllib.parse import urlsplit, urlunsplit

import httpx


class Message:
    def __init__(self, content, tool_calls, *, native=None):
        self.role = 'assistant'
        self.content = content
        self.tool_calls = tool_calls
        self.native = native

    def model_dump(self, **kwargs):
        result = {'role': self.role, 'content': self.content}
        if self.tool_calls:
            result['tool_calls'] = [{'id': call.id, 'type': 'function',
                                    'function': vars(call.function)} for call in self.tool_calls]
        return result


def _dict(value):
    return value if isinstance(value, dict) else value.model_dump(exclude_none=True)


def _response(text, calls, count, reason='stop', native=None, raw_usage=None, request_id=None, reasoning=None):
    return SimpleNamespace(choices=[SimpleNamespace(message=Message(text, calls, native=native),
                                                  finish_reason=reason)],
                           usage=SimpleNamespace(prompt_tokens=count), raw_usage=raw_usage or {},
                           request_id=request_id, effective_reasoning=reasoning,
                           web_sources=_web_sources(native or []),
                           web_search_used=any(item.get('type') == 'web_search_call' and item.get('status') == 'completed' for item in (native or [])))


def _web_sources(output):
    """Only structured tool/citation output is evidence of a web source."""
    sources = {}
    for item in output:
        entries = list((item.get('action') or {}).get('sources') or []) if item.get('type') == 'web_search_call' else []
        if item.get('type') == 'message':
            for block in item.get('content') or []:
                entries.extend(a for a in block.get('annotations') or [] if a.get('type') == 'url_citation')
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            url = entry.get('url')
            if not isinstance(url, str) or len(url) > 4096:
                continue
            try:
                parsed = urlsplit(url)
                parsed.port
            except ValueError:
                continue
            if parsed.scheme not in ('http', 'https') or not parsed.netloc or parsed.username or parsed.password:
                continue
            if url not in sources:
                sources[url] = {'source_type': 'web', 'source_id': 'web-' + hashlib.sha256(url.encode()).hexdigest()[:16],
                                'url': url, 'title': str(entry.get('title') or parsed.hostname)[:300],
                                'text': str(entry.get('title') or '')[:500]}
    return list(sources.values())[:30]


def responses_options(model, messages, options):
    options = dict(options)
    kwargs = {'model': model, 'input': _responses_input(messages), 'store': False,
              'include': ['reasoning.encrypted_content']}
    effort = options.pop('reasoning_effort', None)
    if effort is not None:
        kwargs['reasoning'] = {'effort': effort}
    for key in ('max_completion_tokens', 'max_tokens'):
        if key in options:
            kwargs['max_output_tokens'] = options.pop(key)
    tools = options.pop('tools', None)
    if tools:
        kwargs['tools'] = []
        for tool in tools:
            if tool.get('type') == 'function':
                kwargs['tools'].append({'type': 'function', 'strict': False, **tool['function']})
            elif tool.get('type') == 'web_search':
                kwargs['tools'].append(dict(tool))
                kwargs['include'].append('web_search_call.action.sources')
            else:
                raise ValueError('Responses 工具类型尚未适配')
    kwargs.update(options)
    return kwargs


def _call(identifier, name, arguments):
    return SimpleNamespace(id=identifier, function=SimpleNamespace(name=name, arguments=arguments))


def _responses_input(messages):
    result = []
    for original in messages:
        if isinstance(original, Message) and original.native is not None:
            result.extend(original.native)
            continue
        message = _dict(original)
        role, content = message['role'], message.get('content')
        if role == 'tool':
            result.append({'type': 'function_call_output', 'call_id': message['tool_call_id'], 'output': content})
            continue
        if content is not None:
            if isinstance(content, list):
                blocks = []
                for block in content:
                    if block['type'] == 'text':
                        blocks.append({'type': 'output_text' if role == 'assistant' else 'input_text', 'text': block['text']})
                    elif block['type'] == 'image_url':
                        blocks.append({'type': 'input_image', 'image_url': block['image_url']['url']})
                    else:
                        raise ValueError('Responses 不支持此消息内容类型')
                content = blocks
            result.append({'role': role, 'content': content})
        for call in message.get('tool_calls') or []:
            result.append({'type': 'function_call', 'call_id': call['id'],
                           'name': call['function']['name'], 'arguments': call['function']['arguments']})
    return result


class ResponsesClient:
    protocol = 'openai-responses'

    def __init__(self, client):
        self.client = client
        self.api_key = client.api_key
        if not callable(getattr(getattr(client, 'responses', None), 'create', None)):
            client.close()
            raise ValueError('当前 OpenAI SDK 不支持 Responses，请在开发环境升级依赖后使用此协议')
        self.chat = SimpleNamespace(completions=SimpleNamespace(create=self.create))

    def create(self, *, model, messages, **options):
        kwargs = responses_options(model, messages, options)
        response = self.client.responses.create(**kwargs)
        data = _dict(response)
        if data.get('error'):
            from app.utils.ai_errors import ProtocolResponseError
            raise ProtocolResponseError(data['error'], request_id=getattr(response, '_request_id', None))
        output = data.get('output') or []
        text, calls = [], []
        for item in output:
            if item.get('type') == 'message':
                text.extend(block['text'] for block in item.get('content', []) if block.get('type') == 'output_text')
            elif item.get('type') == 'function_call':
                calls.append(_call(item['call_id'], item['name'], item['arguments']))
        reason = 'length' if (data.get('incomplete_details') or {}).get('reason') == 'max_output_tokens' else 'stop'
        if data.get('status') in ('failed', 'cancelled', 'in_progress', 'queued'):
            raise ValueError('Responses 未返回完成的回答')
        if data.get('status') == 'incomplete' and reason != 'length':
            reason = 'content_filter'
        return _response(''.join(text), calls, (data.get('usage') or {}).get('input_tokens'), reason, output,
                         data.get('usage'), getattr(response, '_request_id', None), data.get('reasoning'))

    def close(self):
        self.client.close()


def anthropic_messages_url(base_url):
    parts = urlsplit(str(base_url or '').strip())
    if parts.scheme not in ('https', 'http') or not parts.netloc or parts.username or parts.password or parts.query or parts.fragment:
        raise ValueError('Anthropic API 地址须为有效 HTTP(S) 地址，不能含凭据、查询或片段')
    path = parts.path.rstrip('/')
    if path.endswith('/messages'):
        path = path[:-len('/messages')]
    if not path.endswith('/v1'):
        path += '/v1'
    return urlunsplit((parts.scheme, parts.netloc, path + '/messages', '', ''))


def _anthropic_input(messages):
    system, result = [], []
    for original in messages:
        message = _dict(original)
        role, content = message['role'], message.get('content')
        if role == 'system':
            system.append(content)
            continue
        if isinstance(original, Message) and original.native is not None:
            blocks = original.native
        elif role == 'tool':
            role = 'user'
            blocks = [{'type': 'tool_result', 'tool_use_id': message['tool_call_id'], 'content': content}]
        else:
            blocks = []
            for block in content if isinstance(content, list) else ([{'type': 'text', 'text': content}] if content else []):
                if block['type'] == 'text':
                    blocks.append(block)
                elif block['type'] == 'image_url':
                    url = block['image_url']['url']
                    if not url.startswith('data:image/') or ';base64,' not in url:
                        raise ValueError('Anthropic 图片仅支持内联 base64')
                    mime, data = url[5:].split(';base64,', 1)
                    blocks.append({'type': 'image', 'source': {'type': 'base64', 'media_type': mime, 'data': data}})
                else:
                    raise ValueError('Anthropic 不支持此消息内容类型')
            for call in message.get('tool_calls') or []:
                blocks.append({'type': 'tool_use', 'id': call['id'], 'name': call['function']['name'],
                               'input': json.loads(call['function']['arguments'])})
        # Consecutive tool results must be in the same user turn.
        if result and result[-1]['role'] == role:
            result[-1]['content'].extend(blocks)
        else:
            result.append({'role': role, 'content': blocks})
    return '\n\n'.join(system), result


def anthropic_options(model, messages, options):
    options = dict(options)
    effort = options.pop('reasoning_effort', None)
    system, wire = _anthropic_input(messages)
    payload = {'model': model, 'messages': wire, 'max_tokens': options.pop('max_tokens', options.pop('max_completion_tokens', 4096))}
    if system:
        payload['system'] = system
    if effort is not None:
        if effort == 'none':
            payload['thinking'] = {'type': 'disabled'}
        elif effort in ('low', 'medium', 'high', 'xhigh', 'max'):
            legacy = bool(re.search(r'(?:claude-)?(?:opus|sonnet|haiku)-[34](?:-[0-5])?(?:-|$)', model.lower())) and not re.search(r'-4-[6-9]', model.lower())
            if legacy:
                budget = {'low': 1024, 'medium': 2048, 'high': 4096, 'xhigh': 8192, 'max': 16384}[effort]
                payload['thinking'] = {'type': 'enabled', 'budget_tokens': budget}
                payload['max_tokens'] = max(payload['max_tokens'], budget + 1024)
            else:
                payload['thinking'] = {'type': 'adaptive'}
                payload['output_config'] = {'effort': effort}
        else:
            raise ValueError('Anthropic 思考档位未适配')
    tools = options.pop('tools', None)
    if tools:
        payload['tools'] = [{'name': tool['function']['name'], 'description': tool['function'].get('description', ''),
                             'input_schema': tool['function']['parameters']} for tool in tools]
    if options.pop('tool_choice', None) == 'none':
        payload['tool_choice'] = {'type': 'none'}
    payload.update(options)
    return payload


class AnthropicClient:
    protocol = 'anthropic'

    def __init__(self, api_key, base_url, *, http_client=None, proxy=None):
        self.api_key = api_key
        self.url = anthropic_messages_url(base_url)
        self.client = http_client or httpx.Client(timeout=120.0, proxy=proxy)
        self.chat = SimpleNamespace(completions=SimpleNamespace(create=self.create))

    def create(self, *, model, messages, **options):
        payload = anthropic_options(model, messages, options)
        response = self.client.post(self.url, headers={'x-api-key': self.api_key, 'anthropic-version': '2023-06-01',
                                                      'content-type': 'application/json'}, json=payload)
        response.raise_for_status()
        data = response.json()
        if data.get('type') == 'error' or data.get('error'):
            from app.utils.ai_errors import ProtocolResponseError
            raise ProtocolResponseError(data.get('error') or {}, request_id=response.headers.get('request-id'),
                                        status_code=response.status_code)
        native = data.get('content') or []
        text, calls = [], []
        for item in native:
            if item.get('type') == 'text':
                text.append(item['text'])
            elif item.get('type') == 'tool_use':
                calls.append(_call(item['id'], item['name'], json.dumps(item['input'], ensure_ascii=False)))
        reason = 'length' if data.get('stop_reason') == 'max_tokens' else 'content_filter' if data.get('stop_reason') == 'refusal' else 'stop'
        usage = data.get('usage') or {}
        count = usage.get('input_tokens')
        if type(count) is int and count >= 0:
            cached = [usage.get('cache_creation_input_tokens', 0), usage.get('cache_read_input_tokens', 0)]
            if all(type(value) is int and value >= 0 for value in cached):
                count += sum(cached)
        return _response(''.join(text), calls, count, reason, native, usage, response.headers.get('request-id'))

    def close(self):
        self.client.close()
