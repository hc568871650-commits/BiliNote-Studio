"""Native Gemini wire adapter; it never changes the configured host or model."""
import base64
import copy
import json
import re
from types import SimpleNamespace
from urllib.parse import quote, urlsplit, urlunsplit

import httpx
from app.utils.protocol_response import json_response, require_sse, event_json

from app.services.protocol_clients import Message, _dict, _response, _call, _web_sources
from app.utils.ai_errors import ProtocolResponseError


def gemini_base_url(base_url):
    parts = urlsplit(str(base_url or '').strip())
    if (parts.scheme not in ('https', 'http') or not parts.netloc or parts.username or
            parts.password or parts.query or parts.fragment):
        raise ValueError('Gemini API 地址须为有效 HTTP(S) 地址，不能含凭据、查询或片段')
    parts.port
    path = parts.path.rstrip('/')
    path = re.sub(r'/(v1beta|v1)/openai$', r'/\1', path)
    path = re.sub(r'/models/[^/]+:(?:streamGenerateContent|generateContent)$', '', path)
    path = re.sub(r'/(?:v1beta|v1)$', '', path)
    return urlunsplit((parts.scheme, parts.netloc, path + '/v1beta', '', ''))


def _parts(content):
    blocks = content if isinstance(content, list) else ([{'type': 'text', 'text': content}] if content else [])
    result = []
    for block in blocks:
        if block.get('type') == 'text' and isinstance(block.get('text'), str):
            result.append({'text': block['text']})
        elif block.get('type') == 'image_url':
            url = (block.get('image_url') or {}).get('url', '')
            match = re.fullmatch(r'data:(image/[\w.+-]+);base64,([A-Za-z0-9+/=\r\n]+)', url)
            if not match:
                raise ValueError('Gemini 图片仅支持内联 base64')
            data = match[2].replace('\r', '').replace('\n', '')
            try:
                base64.b64decode(data, validate=True)
            except ValueError:
                raise ValueError('Gemini 图片 base64 无效') from None
            result.append({'inlineData': {'mimeType': match[1], 'data': data}})
        else:
            raise ValueError('Gemini 不支持此消息内容类型')
    return result


def gemini_input(messages):
    system, contents, call_names = [], [], {}
    for original in messages:
        message = _dict(original)
        role = message.get('role')
        if role == 'system':
            blocks = _parts(message.get('content'))
            if any('text' not in block for block in blocks):
                raise ValueError('Gemini 系统消息仅支持文本')
            system.extend(blocks)
            continue
        if role not in ('user', 'assistant', 'tool'):
            raise ValueError('Gemini 不支持此消息角色')
        if isinstance(original, Message) and original.native is not None:
            blocks = copy.deepcopy(original.native)
            calls = iter(message.get('tool_calls') or [])
            for block in blocks:
                if 'functionCall' in block:
                    call = next(calls, None)
                    identifier = (call or {}).get('id') or block['functionCall'].get('id')
                    if identifier:
                        call_names[identifier] = block['functionCall']['name']
        elif role == 'tool':
            identifier = message.get('tool_call_id')
            name = call_names.get(identifier)
            if not name:
                raise ValueError('Gemini 工具结果没有对应的函数调用')
            content = message.get('content')
            try:
                value = json.loads(content) if isinstance(content, str) else content
            except ValueError:
                value = content
            blocks = [{'functionResponse': {'name': name, 'response': {'result': value}}}]
        else:
            blocks = _parts(message.get('content'))
            for call in message.get('tool_calls') or []:
                function = call['function']
                args = json.loads(function['arguments'])
                if not isinstance(args, dict):
                    raise ValueError('Gemini 函数参数必须是对象')
                call_names[call['id']] = function['name']
                blocks.append({'functionCall': {'name': function['name'], 'args': args}})
        wire_role = 'model' if role == 'assistant' else 'user'
        if blocks:
            if contents and contents[-1]['role'] == wire_role:
                contents[-1]['parts'].extend(blocks)
            else:
                contents.append({'role': wire_role, 'parts': blocks})
    return system, contents


def gemini_options(model, messages, options):
    options = dict(options)
    system, contents = gemini_input(messages)
    payload = {'contents': contents}
    if system:
        payload['systemInstruction'] = {'parts': system}
    config = {}
    effort = options.pop('reasoning_effort', 'auto')
    if effort not in (None, 'auto'):
        name = model.lower().removeprefix('models/')
        if (effort not in ('low', 'medium', 'high') or not re.match(r'gemini-3(?:[.-]|$)', name) or
                (effort == 'medium' and re.match(r'gemini-3-pro(?:-|$)', name)) or
                ('image' in name and effort != 'high')):
            raise ValueError('此 Gemini 模型不支持所选原生思考档位；2.5 系列请使用自动')
        config['thinkingConfig'] = {'thinkingLevel': effort}
    if 'temperature' in options:
        config['temperature'] = options.pop('temperature')
    for key in ('max_tokens', 'max_completion_tokens'):
        if key in options:
            config['maxOutputTokens'] = options.pop(key)
    if config:
        payload['generationConfig'] = config
    tools, functions = [], []
    for tool in options.pop('tools', None) or []:
        if tool.get('type') == 'web_search':
            tools.append({'googleSearch': {}})
        elif tool.get('type') == 'function':
            function = tool['function']
            functions.append({'name': function['name'], 'description': function.get('description', ''),
                              'parametersJsonSchema': copy.deepcopy(function['parameters'])})
        else:
            raise ValueError('Gemini 工具类型尚未适配')
    if functions:
        tools.append({'functionDeclarations': functions})
    if tools:
        payload['tools'] = tools
    choice = options.pop('tool_choice', None)
    if choice == 'none':
        if functions:
            payload['toolConfig'] = {'functionCallingConfig': {'mode': 'NONE'}}
            payload['tools'] = [{'functionDeclarations': functions}]
        else:
            payload.pop('tools', None)
        # Built-in search has no functionCallingConfig equivalent to NONE.
    elif choice not in (None, 'auto'):
        raise ValueError('Gemini 原生搜索不能通过 tool_choice 强制执行；请根据搜索证据判断')
    if options:
        raise ValueError('Gemini 不支持这些请求参数：' + ', '.join(sorted(options)))
    return payload


def _error(data, request_id=None, status_code=None):
    if data.get('error'):
        raise ProtocolResponseError(data['error'], request_id=request_id, status_code=status_code)


def gemini_response(data, request_id=None):
    _error(data, request_id)
    candidates = data.get('candidates') or []
    candidate = next((item for item in candidates if item.get('index', 0) == 0), None)
    if candidate is None:
        raise ValueError('Gemini 未返回有效候选结果')
    finish = candidate.get('finishReason')
    if not finish or finish == 'FINISH_REASON_UNSPECIFIED':
        raise ValueError('Gemini 未返回完成标记')
    if finish not in ('STOP', 'MAX_TOKENS', 'SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY', 'IMAGE_PROHIBITED_CONTENT'):
        raise ValueError('Gemini 未正常完成回答：' + str(finish))
    parts = candidate.get('content', {}).get('parts') or []
    text, calls = [], []
    for index, part in enumerate(parts):
        if 'text' in part and not part.get('thought'):
            text.append(part['text'])
        if 'functionCall' in part:
            call = part['functionCall']
            calls.append(_call(call.get('id') or f'gemini-call-{index}', call['name'],
                               json.dumps(call.get('args') or {}, ensure_ascii=False)))
    reason = 'stop' if finish == 'STOP' else 'length' if finish == 'MAX_TOKENS' else 'content_filter'
    usage = data.get('usageMetadata') or {}
    response = _response(''.join(text), calls, usage.get('promptTokenCount'), reason,
                         raw_usage=usage, request_id=request_id)
    response.choices[0].message.native = copy.deepcopy(parts)
    metadata = candidate.get('groundingMetadata') or {}
    sources = [chunk['web'] for chunk in metadata.get('groundingChunks') or []
               if isinstance(chunk, dict) and isinstance(chunk.get('web'), dict)]
    response.web_sources = _web_sources([{'type': 'web_search_call', 'action': {'sources': [
        {'url': source.get('uri'), 'title': source.get('title')} for source in sources]}}])
    queries = metadata.get('webSearchQueries') or []
    response.web_search_used = bool(response.web_sources and isinstance(queries, list) and
                                    any(isinstance(query, str) and query.strip() for query in queries))
    response.gemini_grounding_metadata = copy.deepcopy(metadata)
    response.search_entry_point = copy.deepcopy(metadata.get('searchEntryPoint') or {})
    suggestions = response.search_entry_point.get('renderedContent')
    if response.web_sources and isinstance(suggestions, str) and len(suggestions.encode('utf-8')) <= 50000:
        response.web_sources[0]['search_suggestions_html'] = suggestions
        response.web_sources[0]['search_provider'] = 'google'
    return response


class GeminiClient:
    protocol = 'gemini'

    def __init__(self, api_key, base_url, *, http_client=None, proxy=None):
        self.api_key = api_key
        self.url = gemini_base_url(base_url)
        self.client = http_client or httpx.Client(timeout=120.0, proxy=proxy)
        self.chat = SimpleNamespace(completions=SimpleNamespace(create=self.create))

    def endpoint(self, model, *, stream=False):
        model = str(model).removeprefix('models/')
        if not model or '/' in model or '?' in model or '#' in model:
            raise ValueError('Gemini 模型调用名无效')
        method = 'streamGenerateContent?alt=sse' if stream else 'generateContent'
        return self.url + '/models/' + quote(model, safe='') + ':' + method

    def headers(self):
        return {'x-goog-api-key': self.api_key, 'Authorization': 'Bearer ' + self.api_key,
                'content-type': 'application/json'}

    def create(self, *, model, messages, **options):
        response = self.client.post(self.endpoint(model), headers=self.headers(),
                                    json=gemini_options(model, messages, options))
        response.raise_for_status()
        return gemini_response(json_response(response), response.headers.get('x-request-id') or response.headers.get('request-id'))

    def close(self):
        self.client.close()


def gemini_stream(client, model, messages, options, cancellation=None):
    from app.services.reading_stream import _track
    payload = gemini_options(model, messages, options)
    aggregate = {'candidates': [{'index': 0, 'content': {'parts': []}}]}
    target = aggregate['candidates'][0]
    with client.client.stream('POST', client.endpoint(model, stream=True), headers=client.headers(), json=payload) as upstream:
        _track(upstream, cancellation)
        if upstream.is_error:
            upstream.read()
        upstream.raise_for_status()
        require_sse(upstream)
        request_id = upstream.headers.get('x-request-id') or upstream.headers.get('request-id')
        lines = []
        def events():
            for line in upstream.iter_lines():
                if not line:
                    if lines:
                        yield event_json('\n'.join(lines), upstream)
                        lines.clear()
                elif line.startswith('data:'):
                    lines.append(line[5:].lstrip())
            if lines:
                yield event_json('\n'.join(lines), upstream)
        for data in events():
            if cancellation and cancellation.get('cancelled'):
                raise ValueError('流式请求已取消')
            _error(data, request_id, upstream.status_code)
            if data.get('usageMetadata'):
                aggregate['usageMetadata'] = data['usageMetadata']
            for candidate in data.get('candidates') or []:
                if candidate.get('index', 0) != 0:
                    continue
                if candidate.get('finishReason'):
                    target['finishReason'] = candidate['finishReason']
                if candidate.get('groundingMetadata'):
                    target.setdefault('groundingMetadata', {}).update(candidate['groundingMetadata'])
                for part in candidate.get('content', {}).get('parts') or []:
                    target['content']['parts'].append(part)
                    if 'text' in part and not part.get('thought'):
                        yield {'type': 'delta', 'text': part['text']}
        return gemini_response(aggregate, request_id)
