from openai import OpenAI
from urllib.parse import urlsplit

from app.gpt.base import GPT
from app.gpt.provider.OpenAI_compatible_provider import OpenAICompatibleProvider
from app.gpt.universal_gpt import UniversalGPT
from app.models.model_config import ModelConfig


class GPTFactory:
    @staticmethod
    def from_config(config: ModelConfig, backend_id: str = "") -> GPT:
        client = OpenAICompatibleProvider(api_key=config.api_key, base_url=config.base_url).get_client
        endpoint = urlsplit(config.base_url)
        # No credentials, userinfo or query parameters in checkpoint identity.
        identity = f"{backend_id}|{config.provider}|{endpoint.scheme}://{endpoint.hostname}:{endpoint.port or ''}{endpoint.path.rstrip('/')}"
        return UniversalGPT(client=client, model=config.model_name, backend_identity=identity)
