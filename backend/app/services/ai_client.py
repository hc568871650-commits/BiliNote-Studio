"""Explicit per-request model; no model substitution or paid retries."""


def close_client(client):
    """Close owned per-request transports without masking the request result."""
    close = getattr(client, 'close', None)
    if callable(close):
        try:
            close()
        except Exception:
            from app.utils.logger import get_logger
            get_logger(__name__).warning('阅读模型客户端释放失败')


def get_client(provider_id, model_name, protocol='openai-chat'):
    from app.gpt.gpt_factory import GPTFactory
    from app.models.model_config import ModelConfig
    from app.services.provider import ProviderService
    if not isinstance(model_name, str) or not model_name.strip():
        raise ValueError('请选择模型')
    provider = ProviderService.get_provider_by_id(provider_id)
    if not provider:
        raise ValueError('未找到所选供应商')
    if not provider.get('enabled', True):
        raise ValueError('所选供应商已禁用')
    if not provider.get('api_key'):
        raise ValueError('所选供应商未配置 API Key')
    if protocol == 'anthropic':
        from types import SimpleNamespace
        from app.services.protocol_clients import AnthropicClient
        from app.services.proxy_config_manager import ProxyConfigManager
        return SimpleNamespace(model=model_name, client=AnthropicClient(provider['api_key'], provider['base_url'],
                                                                       proxy=ProxyConfigManager().get_proxy_url()))
    if protocol == 'openai-responses':
        from types import SimpleNamespace
        from app.services.protocol_clients import ResponsesClient
        from app.utils.openai_client import build_openai_client
        client = build_openai_client(provider['api_key'], provider['base_url'], timeout=120.0).with_options(max_retries=0)
        return SimpleNamespace(model=model_name, client=ResponsesClient(client))
    if protocol != 'openai-chat':
        raise ValueError('不支持所选阅读协议')
    config = ModelConfig(api_key=provider['api_key'], base_url=provider['base_url'],
                         model_name=model_name, provider=provider['type'], name=provider['name'])
    gpt = GPTFactory.from_config(config)
    # UI can cancel waiting; keep synchronous provider work bounded and avoid SDK retries.
    gpt.client = gpt.client.with_options(max_retries=0, timeout=120.0)
    return gpt
