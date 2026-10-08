"""Small safe error records, never serialize SDK requests or response bodies."""
import re
from datetime import datetime, timezone


class ProtocolResponseError(RuntimeError):
    def __init__(self, error, request_id=None, status_code=None):
        super().__init__('上游返回错误')
        self.body = {'error': error}
        self.request_id = request_id
        self.status_code = status_code


class SafeAIError(RuntimeError):
    def __init__(self, details):
        super().__init__(details['detail'])
        self.details = details


def _safe(value, secret=None, limit=800):
    if not isinstance(value, (str, int)) or isinstance(value, bool):
        return ''
    text = str(value)
    if isinstance(secret, str) and secret:
        text = text.replace(secret, '[已隐藏]')
    # Strip echoed JSON / prompts completely rather than exposing request data.
    text = re.split(r'(?i)\b(?:request\s*(?:body|payload)|messages|input|prompt|attachments)\s*[:=]', text)[0]
    text = re.sub(r'\{.*|\[\s*[\{"].*', '[详情已隐藏]', text, flags=re.S)
    text = re.sub(r'(?i)\bsk-[\w-]+|\bBearer\s+\S+', '[已隐藏]', text)
    text = re.sub(r'(?i)((?:api[-_ ]?key|authorization|cookie|access[-_ ]?token|secret)\s*[:=]\s*)[^\s,;]+', r'\1[已隐藏]', text)
    text = re.sub(r'https?://\S+', '[地址已隐藏]', text)
    text = re.sub(r'data:[^\s]+', '[附件已隐藏]', text, flags=re.I)
    return re.sub(r'[\x00-\x1f\x7f]', ' ', text).strip()[:limit]


def error_details(exc, protocol='openai-chat', api_key=None):
    if isinstance(exc, SafeAIError):
        return exc.details
    response = getattr(exc, 'response', None)
    status = getattr(exc, 'status_code', None)
    if status is None and response is not None:
        status = getattr(response, 'status_code', None)
    status = status if type(status) is int and 100 <= status <= 599 else None
    body = getattr(exc, 'body', None)
    if not isinstance(body, dict) and response is not None:
        try:
            body = response.json()
        except Exception:
            body = None
    upstream = body.get('error', body) if isinstance(body, dict) else {}
    upstream = upstream if isinstance(upstream, dict) else {}
    code = _safe(upstream.get('code') or upstream.get('type'), api_key, 100) or None
    request_id = getattr(exc, 'request_id', None)
    if not isinstance(request_id, str) and response is not None:
        headers = getattr(response, 'headers', {})
        request_id = headers.get('x-request-id') or headers.get('request-id')
    name = type(exc).__name__.lower()
    timeout = 'timeout' in name
    kind = 'upstream_http' if status else 'timeout' if timeout else 'connection' if ('connection' in name or 'connect' in name) else 'validation' if isinstance(exc, ValueError) else 'upstream' if upstream else 'internal'
    detail = _safe(upstream.get('message'), api_key)
    if not detail:
        detail = (_safe(str(exc), api_key) if isinstance(exc, ValueError) else
                  '模型响应超时，请检查上游状态' if timeout else
                  '无法连接模型 API，请检查网络和代理' if kind == 'connection' else
                  f'供应商拒绝请求（HTTP {status}）' if status else '模型调用失败，请检查模型连接和协议')
    return {'http_status': status, 'upstream_code': code, 'request_id': _safe(request_id, api_key, 160) or None,
            'occurred_at': datetime.now(timezone.utc).isoformat(), 'kind': kind,
            'detail': detail, 'protocol': protocol}
