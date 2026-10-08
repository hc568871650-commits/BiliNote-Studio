"""True upstream deltas, normalized to the existing reading response shape."""
import json

from app.services.protocol_clients import _dict, _response, _call, _responses_input, _anthropic_input
from app.utils.ai_errors import SafeAIError, error_details, ProtocolResponseError


def _data(value):
    return value if isinstance(value, dict) else _dict(value)


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
    try:
        _track(upstream, cancellation)
        for chunk in upstream:
            data = _data(chunk)
            if data.get('error'):
                raise ProtocolResponseError(data['error'])
            if data.get('usage'):
                count = data['usage'].get('prompt_tokens')
            for choice in data.get('choices') or []:
                if choice.get('index', 0) != 0:
                    continue
                if choice.get('finish_reason'):
                    reason, finished = choice['finish_reason'], True
                delta = choice.get('delta') or {}
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
        return _response(''.join(text), [_call(c['id'], c['name'], c['arguments']) for _, c in sorted(calls.items())], count, reason)
    finally:
        upstream.close()


def _responses(client, model, messages, options, cancellation):
    kwargs = {'model': model, 'input': _responses_input(messages), 'store': False,
              'include': ['reasoning.encrypted_content'], 'stream': True}
    options = dict(options)
    effort = options.pop('reasoning_effort', None)
    if effort is not None:
        kwargs['reasoning'] = {'effort': effort}
    for key in ('max_tokens', 'max_completion_tokens'):
        if key in options:
            kwargs['max_output_tokens'] = options.pop(key)
    tools = options.pop('tools', None)
    if tools:
        kwargs['tools'] = [{'type': 'function', 'strict': False, **t['function']} for t in tools]
    kwargs.update(options)
    try:
        upstream = client.client.responses.create(**kwargs)
    except TypeError:
        raise ValueError('当前 SDK 不支持 Responses 流式参数；未重试，请关闭流式或更新开发依赖') from None
    final = None
    try:
        _track(upstream, cancellation)
        for event in upstream:
            data = _data(event)
            kind = data.get('type')
            if kind == 'response.output_text.delta':
                yield {'type': 'delta', 'text': data.get('delta') or ''}
            elif kind in ('error', 'response.failed'):
                failed = data.get('response') or data
                raise ProtocolResponseError(failed.get('error') or failed)
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
        return _response(''.join(text), calls, (final.get('usage') or {}).get('input_tokens'), reason, native)
    finally:
        upstream.close()


def _anthropic(client, model, messages, options, cancellation):
    system, wire = _anthropic_input(messages)
    options = dict(options)
    payload = {'model': model, 'messages': wire, 'stream': True,
               'max_tokens': options.pop('max_tokens', options.pop('max_completion_tokens', 4096))}
    if system:
        payload['system'] = system
    tools = options.pop('tools', None)
    if tools:
        payload['tools'] = [{'name': t['function']['name'], 'description': t['function'].get('description', ''),
                             'input_schema': t['function']['parameters']} for t in tools]
    if options.pop('tool_choice', None) == 'none':
        payload['tool_choice'] = {'type': 'none'}
    payload.update(options)
    blocks, arguments, count, reason, finished = {}, {}, None, 'stop', False
    with client.client.stream('POST', client.url, headers={'x-api-key': client.api_key,
            'anthropic-version': '2023-06-01', 'content-type': 'application/json'}, json=payload) as upstream:
        _track(upstream, cancellation)
        if upstream.is_error:
            upstream.read()
        upstream.raise_for_status()
        lines = []
        def events():
            for line in upstream.iter_lines():
                if not line:
                    if lines:
                        yield json.loads('\n'.join(lines))
                        lines.clear()
                elif line.startswith('data:'):
                    lines.append(line[5:].lstrip())
            if lines:
                yield json.loads('\n'.join(lines))
        for data in events():
            kind = data.get('type')
            if kind == 'error':
                raise ProtocolResponseError(data.get('error') or data, request_id=upstream.headers.get('request-id'),
                                            status_code=upstream.status_code)
            if kind == 'message_start':
                usage = data['message'].get('usage') or {}
                value = usage.get('input_tokens')
                if type(value) is int:
                    count = value + usage.get('cache_creation_input_tokens', 0) + usage.get('cache_read_input_tokens', 0)
            elif kind == 'content_block_start':
                blocks[data['index']] = dict(data['content_block'])
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
            elif kind == 'message_delta':
                stop = data.get('delta', {}).get('stop_reason')
                reason = 'length' if stop == 'max_tokens' else 'content_filter' if stop == 'refusal' else 'stop'
            elif kind == 'message_stop':
                finished = True
        if not finished:
            raise ValueError('Anthropic 流式连接提前结束，未收到完成标记')
    native, text, calls = [], [], []
    for index, block in sorted(blocks.items()):
        if block['type'] == 'tool_use':
            if index in arguments:
                block['input'] = json.loads(arguments[index])
            calls.append(_call(block['id'], block['name'], json.dumps(block.get('input') or {}, ensure_ascii=False)))
        elif block['type'] == 'text':
            text.append(block.get('text', ''))
        native.append(block)
    return _response(''.join(text), calls, count, reason, native)


def stream_completion(client, model, messages, options, estimate, limit, protocol, cancellation=None):
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
                      'limit': limit, 'warning': bool(measured and count > limit)}
