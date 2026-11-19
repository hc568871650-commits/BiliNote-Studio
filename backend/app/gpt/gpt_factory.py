from urllib.parse import urlsplit

from app.gpt.base import GPT
from app.gpt.provider.OpenAI_compatible_provider import OpenAICompatibleProvider
from app.gpt.universal_gpt import UniversalGPT
from app.models.model_config import ModelConfig


class GPTFactory:
    @staticmethod
    def from_config(config: ModelConfig, backend_id: str = "") -> GPT:
        protocol = (getattr(config, "protocol", None) or "openai-chat").strip() or "openai-chat"
        if protocol == "anthropic":
            from app.services.protocol_clients import AnthropicClient
            from app.services.proxy_config_manager import ProxyConfigManager
            client = AnthropicClient(config.api_key, config.base_url, proxy=ProxyConfigManager().get_proxy_url())
        elif protocol == "gemini":
            from app.services.gemini_client import GeminiClient
            from app.services.proxy_config_manager import ProxyConfigManager
            client = GeminiClient(config.api_key, config.base_url, proxy=ProxyConfigManager().get_proxy_url())
        elif protocol == "openai-responses":
            from app.services.protocol_clients import ResponsesClient
            raw_client = OpenAICompatibleProvider(api_key=config.api_key, base_url=config.base_url).get_client
            client = ResponsesClient(raw_client)
        else:
            client = OpenAICompatibleProvider(api_key=config.api_key, base_url=config.base_url).get_client
        endpoint = urlsplit(config.base_url)
        # No credentials, userinfo or query parameters in checkpoint identity.
        identity = f"{backend_id}|{protocol}|{config.provider}|{endpoint.scheme}://{endpoint.hostname}:{endpoint.port or ''}{endpoint.path.rstrip('/')}"
        return UniversalGPT(client=client, model=config.model_name, backend_identity=identity)
