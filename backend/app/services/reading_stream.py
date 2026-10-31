"""True upstream deltas, normalized to the existing reading response shape."""
import json

from app.services.protocol_clients import _dict, _response, _call, _responses_input, _anthropic_input, responses_options, anthropic_options
from app.utils.ai_errors import SafeAIError, error_details, ProtocolResponseError
from app.utils.protocol_response import require_sse, event_json
from app.utils.ai_errors import ResponseFormatError


def _data(value):
    return value if isinstance(value, dict) else _dict(value)


def _request_id(stream):
    identifier = getattr(stream, '_request_id', None)
    if isinstance(identifier, str):
        return identifier
    headers = getattr(getattr(stream, 'response', None), 'headers', {})
    return headers.get('x-request-id') or headers.get('request-id')


def _track(upstream, cancellation):
    if cancellation is not None:
        from app.services.ai_client import close_client
        cancellation['stream_close'] = lambda: close_client(upstream)
        if cancellation.get('cancelled'):
            close_client(upstream)
            raise ValueError('流式请求已取消')


def _chat(client, model, messages, options, cancellation):
    try:
        upstream = client.chat.completions.create(model=model, messages=[_dict(m) for m in messages], stream=True,
                                                 stream_options={'include_usage': True}, **options)
    except TypeError:
        raise ValueError('当前 SDK 不支持 Chat Completions 流式参数；未重试，请关闭流式或更新开发依赖') from None
    text, calls, count, reason, finished = [], {}, None, 'stop', False
    annotations = []
    reasoning_parts, reasoning_seen = [], False
    usage = {}
    try:
        _track(upstream, cancellation)
        require_sse(getattr(upstream, 'response', None))
        for chunk in upstream:
            data = _data(chunk)
            if data.get('error'):
                raise ProtocolResponseError(data['error'], request_id=_request_id(upstream))
            if data.get('usage'):
                count = data['usage'].get('prompt_tokens')
                usage.update(data['usage'])
            for choice in data.get('choices') or []:
                if choice.get('index', 0) != 0:
                    continue
                if choice.get('finish_reason'):
                    reason, finished = choice['finish_reason'], True
                delta = choice.get('delta') or {}
                if isinstance(delta.get('reasoning_content'), str):
                    reasoning_seen = True
                    reasoning_parts.append(delta['reasoning_content'])
                annotations.extend(delta.get('annotations') or [])
                annotations.extend((choice.get('message') or {}).get('annotations') or [])
                if delta.get('content'):
                    text.append(delta['content'])
                    yield {'type': 'delta', 'text': delta['content']}
                for call in delta.get('tool_calls') or []:
                    acc = calls.setdefault(call['index'], {'id': '', 'name': '', 'arguments': ''})
                    if call.get('id'):
                        acc['id'] = call['id']
                    function = call.get('function') or {}
                    acc['name'] += function.get('name') or ''
                    acc['arguments'] += function.get('arguments') or ''
        if not finished:
            raise ValueError('流式连接提前结束，未收到完成标记')
        response = _response(''.join(text), [_call(c['id'], c['name'], c['arguments']) for _, c in sorted(calls.items())], count, reason,
                             raw_usage=usage, request_id=_request_id(upstream))
        from app.services.native_search import chat_sources
        response.web_sources = chat_sources(annotations)
        if reasoning_seen:
            # Some Chat-compatible thinking models require this provider artifact
            # on subsequent tool rounds. It is never emitted as visible text.
            response.choices[0].message.reasoning_content = ''.join(reasoning_parts)
        response.web_search_used = bool(response.web_sources)
        return response
    except json.JSONDecodeError:
        raise ResponseFormatError('sse-json', 'invalid-json', request_id=_request_id(upstream)) from None
    finally:
        upstream.close()


def _responses(client, model, messages, options, cancellation):
    kwargs = responses_options(model, messages, options)
    kwargs['stream'] = True
    try:
        upstream = client.client.responses.create(**kwargs)
    except TypeError:
        raise ValueError('当前 SDK 不支持 Responses 流式参数；未重试，请关闭流式或更新开发依赖') from None
    final = None
    try:
        _track(upstream, cancellation)
        require_sse(getattr(upstream, 'response', None))
        for event in upstream:
            data = _data(event)
            kind = data.get('type')
            if kind == 'response.output_text.delta':
                yield {'type': 'delta', 'text': data.get('delta') or ''}
            elif kind in ('response.web_search_call.in_progress', 'response.web_search_call.searching'):
                yield {'type': 'status', 'phase': 'searching'}
            elif kind in ('error', 'response.failed'):
                failed = data.get('response') or data
                raise ProtocolResponseError(failed.get('error') or failed, request_id=_request_id(upstream))
            elif kind in ('response.completed', 'response.incomplete'):
                final = data['response']
        if final is None:
            raise ValueError('Responses 流式连接提前结束，未收到完成标记')
        native = final.get('output') or []
        text, calls = [], []
        for item in native:
            if item.get('type') == 'message':
                text.extend(b['text'] for b in item.get('content', []) if b.get('type') == 'output_text')
            elif item.get('type') == 'function_call':
                calls.append(_call(item['call_id'], item['name'], item['arguments']))
        reason = 'length' if (final.get('incomplete_details') or {}).get('reason') == 'max_output_tokens' else 'content_filter' if final.get('status') == 'incomplete' else 'stop'
        return _response(''.join(text), calls, (final.get('usage') or {}).get('input_tokens'), reason, native,
                         final.get('usage'), _request_id(upstream), final.get('reasoning'))
    except json.JSONDecodeError:
        raise ResponseFormatError('sse-json', 'invalid-json', request_id=_request_id(upstream)) from None
    finally:
        upstream.close()


def _anthropic(client, model, messages, options, cancellation):
    payload = anthropic_options(model, messages, options,
                                deepseek=getattr(client, 'bilinote_official_deepseek', False) is True)
    payload['stream'] = True
    blocks, arguments, count, reason, finished = {}, {}, None, 'stop', False
    usage = {}
    with client.client.stream('POST', client.url, headers={'x-api-key': client.api_key,
            'anthropic-version': '2023-06-01', 'content-type': 'application/json'}, json=payload) as upstream:
        _track(upstream, cancellation)
        if upstream.is_error:
            upstream.read()
        upstream.raise_for_status()
        require_sse(upstream)
        request_id = upstream.headers.get('request-id') or upstream.headers.get('x-request-id')
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
            kind = data.get('type')
            if kind == 'error':
                raise ProtocolResponseError(data.get('error') or data, request_id=upstream.headers.get('request-id'),
                                            status_code=upstream.status_code)
            if kind == 'message_start':
                usage.update(data['message'].get('usage') or {})
                value = usage.get('input_tokens')
                if type(value) is int:
                    count = value + usage.get('cache_creation_input_tokens', 0) + usage.get('cache_read_input_tokens', 0)
            elif kind == 'content_block_start':
                blocks[data['index']] = dict(data['content_block'])
                if data['content_block'].get('type') == 'server_tool_use' and data['content_block'].get('name') == 'web_search':
                    yield {'type': 'status', 'phase': 'searching'}
            elif kind == 'content_block_delta':
                index, delta = data['index'], data['delta']
                if delta['type'] == 'text_delta':
                    fragment = delta.get('text') or ''
                    blocks[index]['text'] = blocks[index].get('text', '') + fragment
                    yield {'type': 'delta', 'text': fragment}
                elif delta['type'] == 'input_json_delta':
                    arguments[index] = arguments.get(index, '') + delta.get('partial_json', '')
                elif delta['type'] == 'thinking_delta':
                    blocks[index]['thinking'] = blocks[index].get('thinking', '') + delta.get('thinking', '')
                elif delta['type'] == 'signature_delta':
                    blocks[index]['signature'] = blocks[index].get('signature', '') + delta.get('signature', '')
                elif delta['type'] == 'citations_delta':
                    blocks[index].setdefault('citations', []).append(delta.get('citation') or {})
            elif kind == 'message_delta':
                usage.update(data.get('usage') or {})
                stop = data.get('delta', {}).get('stop_reason')
                reason = 'length' if stop == 'max_tokens' else 'content_filter' if stop == 'refusal' else 'stop'
            elif kind == 'message_stop':
                finished = True
        if not finished:
            raise ValueError('Anthropic 流式连接提前结束，未收到完成标记')
    native, text, calls = [], [], []
    for index, block in sorted(blocks.items()):
        if block['type'] == 'server_tool_use' and index in arguments:
            block['input'] = json.loads(arguments[index])
        if block['type'] == 'tool_use':
            if index in arguments:
                block['input'] = json.loads(arguments[index])
            calls.append(_call(block['id'], block['name'], json.dumps(block.get('input') or {}, ensure_ascii=False)))
        elif block['type'] == 'text':
            text.append(block.get('text', ''))
        native.append(block)
    return _response(''.join(text), calls, count, reason, native, usage, request_id)


def stream_completion(client, model, messages, options, estimate, limit, protocol, cancellation=None):
    if protocol == 'gemini':
        from app.services.gemini_client import gemini_stream
        iterator = gemini_stream(client, model, messages, options, cancellation)
    else:
        iterator = {'openai-chat': _chat, 'openai-responses': _responses, 'anthropic': _anthropic}[protocol](client, model, messages, options, cancellation)
    try:
        response = yield from iterator
    except Exception as exc:
        raise SafeAIError(error_details(exc, protocol, getattr(client, 'api_key', None))) from None
    finally:
        iterator.close()
        if cancellation is not None:
            cancellation.pop('stream_close', None)
    count = getattr(response.usage, 'prompt_tokens', None)
    measured = type(count) is int and count >= 0
    return response, {'input_tokens': count if measured else estimate, 'estimated': not measured,
                      'limit': limit, 'warning': bool(measured and count > limit), 'upstream_protocol': protocol}
