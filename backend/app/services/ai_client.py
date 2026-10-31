"""Explicit per-request model; no model substitution or paid retries."""
from urllib.parse import urlsplit


def _deepseek_search_base(base_url, model_name):
    # Restrict the protocol bridge to documented model IDs and the exact official
    # endpoint. A relay's DeepSeek model name never authorizes sending its key here.
    if model_name not in ('deepseek-flash', 'deepseek-v4-pro'):
        return None
    try:
        url = urlsplit(str(base_url or '').strip())
        if (url.scheme == 'https' and url.hostname == 'api.deepseek.com' and url.port in (None, 443)
                and not (url.username or url.password or url.query or url.fragment)
                and url.path.rstrip('/') in ('', '/v1')):
            return 'https://api.deepseek.com/anthropic'
    except ValueError:
        pass
    return None


def close_client(client):
    """Close owned per-request transports without masking the request result."""
    close = getattr(client, 'close', None)
    if callable(close):
        try:
            close()
        except Exception:
            from app.utils.logger import get_logger
            get_logger(__name__).warning('阅读模型客户端释放失败')


def get_client(provider_id, model_name, protocol='openai-chat', *, native_search=False):
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
    requested_protocol = protocol
    native_base = _deepseek_search_base(provider['base_url'], model_name) if native_search else None
    if native_base and protocol in ('openai-chat', 'openai-responses'):
        protocol = 'anthropic'
    if protocol == 'gemini':
        from types import SimpleNamespace
        from app.services.gemini_client import GeminiClient
        from app.services.proxy_config_manager import ProxyConfigManager
        client = GeminiClient(provider['api_key'], provider['base_url'], proxy=ProxyConfigManager().get_proxy_url())
        client.bilinote_provider_id = provider_id
        return SimpleNamespace(model=model_name, client=client)
    if protocol == 'anthropic':
        from types import SimpleNamespace
        from app.services.protocol_clients import AnthropicClient
        from app.services.proxy_config_manager import ProxyConfigManager
        client = AnthropicClient(provider['api_key'], native_base or provider['base_url'], proxy=ProxyConfigManager().get_proxy_url())
        client.bilinote_provider_id = provider_id
        if (client.url == 'https://api.deepseek.com/anthropic/v1/messages'
                and model_name in ('deepseek-flash', 'deepseek-v4-pro')):
            client.bilinote_official_deepseek = True
        if native_search and getattr(client, 'bilinote_official_deepseek', False) is True:
            client.bilinote_native_search_route = 'deepseek-anthropic'
            client.bilinote_requested_protocol = requested_protocol
        return SimpleNamespace(model=model_name, client=client)
    if protocol == 'openai-responses':
        from types import SimpleNamespace
        from app.services.protocol_clients import ResponsesClient
        from app.utils.openai_client import build_openai_client
        client = build_openai_client(provider['api_key'], provider['base_url'], timeout=120.0).with_options(max_retries=0)
        adapted = ResponsesClient(client)
        adapted.bilinote_provider_id = provider_id
        return SimpleNamespace(model=model_name, client=adapted)
    if protocol != 'openai-chat':
        raise ValueError('不支持所选阅读协议')
    config = ModelConfig(api_key=provider['api_key'], base_url=provider['base_url'],
                         model_name=model_name, provider=provider['type'], name=provider['name'])
    gpt = GPTFactory.from_config(config)
    # UI can cancel waiting; keep synchronous provider work bounded and avoid SDK retries.
    gpt.client = gpt.client.with_options(max_retries=0, timeout=120.0)
    gpt.client.bilinote_provider_id = provider_id
    return gpt
