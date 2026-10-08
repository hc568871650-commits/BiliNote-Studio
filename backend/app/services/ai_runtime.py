"""Shared chat controls. No retries, hidden model substitution, or paid token counting."""
import json
import re

DEFAULT_CONTEXT_LIMIT = 272000  # GPT-5.4 long-context pricing boundary, not every model's capacity.


def reasoning_choices(model, protocol='openai-chat'):
    if protocol == 'anthropic':
        return ['auto']
    name = model.lower().split('/')[-1]
    if re.match(r'gpt-6-(?:sol|astra)(?:-|$)', name):
        return ['auto', 'low', 'medium', 'high', 'xhigh'] if 'astra' in name else ['auto', 'none', 'low', 'medium', 'high', 'xhigh']
    if re.match(r'gpt-5\.[245](?:-|$)', name):
        return ['auto', 'medium', 'high', 'xhigh'] if '-pro' in name else ['auto', 'none', 'low', 'medium', 'high', 'xhigh']
    if re.match(r'gpt-5(?:-|$)|o[134](?:-|$)', name):
        return ['auto', 'low', 'medium', 'high']
    if re.match(r'gemini-(?:2\.5|3)(?:[.-]|$)', name):
        # A conservative common subset; 3.8 Flash explicitly supports medium.
        return ['auto', 'low', 'medium', 'high'] if 'flash' in name else ['auto', 'low', 'high']
    return ['auto']


def allows_chat_tools(model, effort, protocol='openai-chat'):
    if protocol != 'openai-chat':
        return True
    # GPT-6 reasoning + function calling requires Responses; this application uses
    # Chat Completions, so supply note context directly for its reasoning modes.
    return not re.match(r'gpt-6(?:[.-]|$)', model.lower().split('/')[-1]) or effort == 'none'


def request_options(model, effort='auto', temperature=0.7, protocol='openai-chat'):
    if effort not in reasoning_choices(model, protocol):
        raise ValueError('所选模型不支持此思考档位，请选择自动或该模型支持的档位')
    result = {} if effort == 'auto' else {'reasoning_effort': effort}
    # Reasoning models may reject temperature even when effort was omitted.
    if protocol != 'anthropic' and not re.match(r'(?:gpt-[56]|o[134])(?:[.-]|$)', model.lower().split('/')[-1]):
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
             temperature=0.7, tools=None, final=False, max_output_tokens=None, stream=False, cancellation=None):
    if context_limit != DEFAULT_CONTEXT_LIMIT:
        raise ValueError('上下文窗口固定为 272K')
    estimate = estimate_context(messages, tools)
    # Leave headroom for server formatting/vision accounting. Never silently drop
    # attachments, tool replies or the user's current question to meet the budget.
    if estimate > context_limit * .95:
        raise ValueError(f'上下文接近 {context_limit // 1000}K 预算，请减少附件或开始新对话；未继续请求模型')
    protocol = getattr(client, 'protocol', 'openai-chat')
    protocol = protocol if isinstance(protocol, str) else 'openai-chat'
    options = request_options(model, reasoning_effort, temperature, protocol)
    if max_output_tokens is not None:
        parameter = 'max_completion_tokens' if re.match(r'(?:gpt-[56]|o[134])(?:[.-]|$)', model.lower().split('/')[-1]) else 'max_tokens'
        options[parameter] = max_output_tokens
    if tools:
        options['tools'] = tools
        if final:
            options['tool_choice'] = 'none'
    if stream:
        from app.services.reading_stream import stream_completion
        return stream_completion(client, model, messages, options, estimate, context_limit, protocol, cancellation)
    try:
        response = client.chat.completions.create(model=model, messages=messages, **options)
    except Exception as exc:
        from app.utils.ai_errors import SafeAIError, error_details
        raise SafeAIError(error_details(exc, protocol, getattr(client, 'api_key', None))) from None
    usage = getattr(response, 'usage', None)
    count = getattr(usage, 'prompt_tokens', None)
    measured = isinstance(count, int) and not isinstance(count, bool) and count >= 0
    context = {'input_tokens': count if measured else estimate, 'estimated': not measured,
               'limit': context_limit, 'warning': bool(measured and count > context_limit)}
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
