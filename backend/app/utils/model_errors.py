"""Human-readable model errors without credentials or raw request bodies."""
import re


def model_error(exc, api_key=None):
    status = getattr(exc, 'status_code', None)
    hints = {400: '请求参数或模型协议不兼容', 401: 'API Key 无效或已过期',
             403: '此密钥没有模型访问权限', 404: '模型或 API 地址不存在',
             429: '供应商限流或额度不足', 500: '供应商内部错误',
             502: '供应商上游连接失败', 503: '模型暂不可用', 504: '供应商上游超时'}
    if status:
        return f'模型调用失败（HTTP {status}）：{hints.get(status, "供应商拒绝请求")}。请核对 API 地址、完整模型名与供应商状态。'
    if 'timeout' in type(exc).__name__.lower():
        return '模型响应超时，请稍后重试或检查上游状态；未自动切换模型。'
    if 'connection' in type(exc).__name__.lower():
        return '无法连接模型 API，请检查地址、网络及代理设置。'
    detail = str(exc)
    if api_key:
        detail = detail.replace(api_key, '[已隐藏]')
    detail = re.sub(r'(?i)\bsk-[\w-]+|Bearer\s+\S+', '[已隐藏]', detail)
    return detail[:800] or '模型调用失败，供应商未提供错误详情。'
