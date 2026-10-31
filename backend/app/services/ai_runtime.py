"""Shared chat controls. No retries, hidden model substitution, or paid token counting."""
import json
import re

DEFAULT_CONTEXT_LIMIT = 272000  # Legacy upper bound; callers resolve each model's input budget.
REQUEST_EFFORTS = ('none', 'low', 'medium', 'high', 'xhigh', 'max')


def reasoning_choices(model, protocol='openai-chat'):
    if protocol == 'gemini':
        name = model.lower().removeprefix('models/')
        if not re.match(r'gemini-3(?:[.-]|$)', name):
            return ['auto']
        if 'image' in name:
            return ['auto', 'high']
        return ['auto', 'low', 'high'] if re.match(r'gemini-3-pro(?:-|$)', name) else ['auto', 'low', 'medium', 'high']
    if protocol == 'anthropic':
        return ['auto']
    name = model.lower().split('/')[-1]
    if re.match(r'gpt-6\.1-sol(?:-|$)', name):
        return ['auto', 'low', 'medium', 'high', 'xhigh', 'max']
    if re.match(r'gpt-6-(?:sol|astra)(?:-|$)', name):
        return ['auto', 'low', 'medium', 'high', 'xhigh', 'max'] if 'astra' in name else ['auto', 'none', 'low', 'medium', 'high', 'xhigh', 'max']
    if re.match(r'gpt-5\.[245](?:-|$)', name):
        return ['auto', 'medium', 'high', 'xhigh'] if '-pro' in name else ['auto', 'none', 'low', 'medium', 'high', 'xhigh']
    if re.match(r'gpt-5(?:-|$)|o[134](?:-|$)', name):
        return ['auto', 'low', 'medium', 'high']
    if re.match(r'gemini-(?:2\.5|3)(?:[.-]|$)', name):
        # A conservative common subset; 3.8 Flash explicitly supports medium.
        return ['auto', 'low', 'medium', 'high'] if 'flash' in name else ['auto', 'low', 'high']
    return ['auto']


def request_effort_choices(model, protocol='openai-chat'):
    # Tests describe observed compatibility; they do not authorize requests.
    # Gemini's adapter maps only model-specific thinking levels.
    return reasoning_choices(model, protocol) if protocol == 'gemini' else ['auto', *REQUEST_EFFORTS]


def allows_chat_tools(model, effort, protocol='openai-chat'):
    return protocol in ('openai-chat', 'openai-responses', 'anthropic', 'gemini')


def request_options(model, effort='auto', temperature=0.7, protocol='openai-chat', provider_id=None, probe=False):
    choices = request_effort_choices(model, protocol)
    if effort not in choices and not (probe and effort in REQUEST_EFFORTS):
        raise ValueError('所选模型不支持此思考档位，请选择自动或该模型支持的档位')
    result = {} if effort == 'auto' else {'reasoning_effort': effort}
    # Reasoning models may reject temperature even when effort was omitted.
    if effort == 'auto' and protocol != 'anthropic' and not re.match(r'(?:gpt-[56]|o[134])(?:[.-]|$)', model.lower().split('/')[-1]):
        result['temperature'] = temperature
    return result


def _plain(value):
    if hasattr(value, 'model_dump'):
        return value.model_dump(exclude_none=True)
    if hasattr(value, '__dict__'):
        return vars(value)
    raise TypeError('Unsupported message value')


def estimate_context(messages, tools=None):
    # UTF-8 bytes deliberately overestimate ordinary text tokens. Image accounting
    # is approximate and cannot promise a third-party gateway's billed token count.
    def compact(value):
        if isinstance(value, list):
            return [compact(item) for item in value]
        if not isinstance(value, (dict, str, int, float, bool, type(None))):
            native = getattr(value, 'native', None)
            if isinstance(native, list):
                return compact(native)
            value = _plain(value)
        if isinstance(value, dict):
            if value.get('type') == 'image_url':
                return {'image_token_reserve': 'x' * 16384}
            return {key: compact(item) for key, item in value.items()}
        return value
    return len(json.dumps(compact({'messages': messages, 'tools': tools or []}), ensure_ascii=False).encode('utf-8')) + 1024


def complete(client, model, messages, *, reasoning_effort='auto', context_limit=DEFAULT_CONTEXT_LIMIT,
             temperature=0.7, tools=None, final=False, max_output_tokens=None, stream=False, cancellation=None,
             web_search=False, web_search_mode='native', search_query=None, probe=False, require_web=False):
    if (not isinstance(context_limit, int) or isinstance(context_limit, bool)
            or not 4096 <= context_limit <= DEFAULT_CONTEXT_LIMIT):
        raise ValueError('有效输入预算须为 4,096 至 272,000 之间的整数')
    if max_output_tokens is not None and (not isinstance(max_output_tokens, int)
            or isinstance(max_output_tokens, bool) or not 1 <= max_output_tokens <= 65536):
        raise ValueError('输出上限须为 1 至 65,536 之间的整数')
    protocol = getattr(client, 'protocol', 'openai-chat')
    protocol = protocol if isinstance(protocol, str) else 'openai-chat'
    provider_id = getattr(client, 'bilinote_provider_id', None)
    options = request_options(model, reasoning_effort, temperature, protocol, provider_id if isinstance(provider_id, str) else None, probe)
    if estimate_context(messages, tools) > context_limit * .95:
        raise ValueError('上下文接近预算，请减少附件或开始新对话；未请求检索或模型')
    def cancelled():
        return bool(cancellation() if callable(cancellation) else cancellation and cancellation.get('cancelled'))
    if cancelled():
        raise ValueError('请求已取消')
    if web_search:
        if web_search_mode == 'native':
            if protocol == 'openai-chat':
                options['web_search_options'] = {}
            elif protocol in ('openai-responses', 'anthropic', 'gemini'):
                tools = [*(tools or []), {'type': 'web_search'}]
            else:
                raise ValueError('当前协议尚未接入原生联网')
        elif web_search_mode == 'external':
            from app.services.web_search import available
            from app.services.search_tool import external_tools
            if available():
                tools = [*(tools or []), *external_tools()]
        else:
            raise ValueError('不支持的联网方式')
    estimate = estimate_context(messages, tools)
    # Leave headroom for server formatting/vision accounting. Never silently drop
    # attachments, tool replies or the user's current question to meet the budget.
    if estimate > context_limit * .95:
        raise ValueError(f'上下文接近 {context_limit // 1000}K 预算，请减少附件或开始新对话；未继续请求模型')
    if max_output_tokens is not None:
        parameter = 'max_completion_tokens' if re.match(r'(?:gpt-[56]|o[134])(?:[.-]|$)', model.lower().split('/')[-1]) else 'max_tokens'
        options[parameter] = max_output_tokens
    if tools:
        options['tools'] = tools
        if final:
            options['tool_choice'] = 'none'
    if require_web and protocol == 'openai-responses':
        options['tool_choice'] = {'type': 'web_search'}
    if cancelled():
        raise ValueError('请求已取消，未继续调用模型')
    if stream:
        from app.services.reading_stream import stream_completion
        iterator = stream_completion(client, model, messages, options, estimate, context_limit, protocol, cancellation if isinstance(cancellation, dict) else None)
        def streamed():
            response, context = yield from iterator
            return response, context
        return streamed()
    try:
        response = client.chat.completions.create(model=model, messages=messages, **options)
    except Exception as exc:
        from app.utils.ai_errors import SafeAIError, error_details
        raise SafeAIError(error_details(exc, protocol, getattr(client, 'api_key', None))) from None
    from app.utils.protocol_response import validate_chat_response
    validate_chat_response(response)
    usage = getattr(response, 'usage', None)
    if protocol == 'openai-chat':
        from app.services.native_search import attach_chat_search
        attach_chat_search(response)
    count = getattr(usage, 'prompt_tokens', None)
    measured = isinstance(count, int) and not isinstance(count, bool) and count >= 0
    context = {'input_tokens': count if measured else estimate, 'estimated': not measured,
               'limit': context_limit, 'warning': bool(measured and count > context_limit),
               'upstream_protocol': protocol}
    return response, context


def visible_answer(response):
    choices = getattr(response, 'choices', None)
    if not choices:
        raise ValueError('模型未返回有效回答（响应没有候选结果），请检查模型或服务商兼容性')
    message = choices[0].message
    content = getattr(message, 'content', None)
    if getattr(message, 'tool_calls', None) or not isinstance(content, str) or not content.strip():
        reason = getattr(choices[0], 'finish_reason', None)
        detail = '达到输出上限' if reason == 'length' else '内容被模型过滤' if reason == 'content_filter' else '没有正文'
        raise ValueError(f'模型未返回有效回答（{detail}），请调整思考强度或检查服务商兼容性后重试')
    return content.strip()
