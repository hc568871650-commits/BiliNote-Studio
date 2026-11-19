from urllib.parse import urlsplit
from uuid import uuid4
from fastapi.encoders import jsonable_encoder

from app.db.models.providers import Provider
from app.db.provider_dao import (
    insert_provider,
    get_all_providers,
    get_provider_by_name,
    get_provider_by_id,
    update_provider,
    delete_provider, get_enabled_providers,
)
from app.gpt.gpt_factory import GPTFactory
from app.models.model_config import ModelConfig
from app.utils.secret_store import decrypt_secret, encrypt_secret

VALID_PROTOCOLS = ("openai-chat", "openai-responses", "anthropic", "gemini")


def infer_provider_protocol(base_url: str | None, explicit_protocol: str | None = None) -> str:
    if isinstance(explicit_protocol, str) and explicit_protocol.strip() in VALID_PROTOCOLS:
        return explicit_protocol.strip()
    host = (urlsplit(str(base_url or "")).hostname or "").lower()
    if "anthropic.com" in host:
        return "anthropic"
    if "generativelanguage.googleapis.com" in host:
        return "gemini"
    return "openai-chat"


class ProviderService:

    @staticmethod
    def serialize_provider(row: Provider) -> dict:
        if not row:
            return None
        row = ProviderService.provider_to_dict(row)
        return {
            "id": row.get("id"),
            "name": row.get("name"),
            "logo": row.get("logo"),
            "type": row.get("type"),
            "enabled": row.get("enabled"),
            "base_url": row.get("base_url"),
            "protocol": row.get("protocol"),
            "api_key": row.get("api_key"),
            "created_at": jsonable_encoder(row.get("created_at")),
        }

    @staticmethod
    def serialize_provider_safe(row: Provider) -> dict:
        if not row:
            return None
        row = ProviderService.provider_to_dict(row)
        plain_key = row.get("api_key") or ""
        return {
            "id": row.get("id"),
            "name": row.get("name"),
            "logo": row.get("logo"),
            "type": row.get("type"),
            "enabled": row.get("enabled"),
            "base_url": row.get("base_url"),
            "protocol": row.get("protocol"),
            "api_key": ProviderService.mask_key(plain_key),
            "api_key_configured": bool(plain_key),
            "created_at": jsonable_encoder(row.get("created_at")),
        }

    @staticmethod
    def mask_key(key: str) -> str:
        if not key or len(key) < 8:
            return '*' * len(key or '')
        return key[:4] + '*' * (len(key) - 8) + key[-4:]

    @staticmethod
    def add_provider(
        name: str,
        api_key: str,
        base_url: str,
        logo: str,
        type_: str,
        enabled: int = 1,
        protocol: str | None = None,
    ):
        try:
            # 内置供应商（type='built-in'）只能由 seed 流程写入；API 创建一律落到 'custom'，
            # 否则历史上出现过批量伪内置脏数据
            if type_ != 'custom':
                type_ = 'custom'
            existing = get_provider_by_name(name)
            if existing is not None:
                raise ValueError(f'供应商名称已存在: {name}')
            id = str(uuid4())
            logo = logo or 'custom'
            resolved_protocol = infer_provider_protocol(base_url, protocol)
            protected_key = encrypt_secret(api_key)
            return insert_provider(
                id, name, protected_key, base_url, logo, type_, enabled, protocol=resolved_protocol
            )
        except Exception as e:
            print('创建模式失败', e)
            raise

    @staticmethod
    def provider_to_dict(p: Provider):
        plain_key = decrypt_secret(p.api_key)
        return {
            "id": p.id,
            "name": p.name,
            "logo": p.logo,
            "type": p.type,
            "api_key": plain_key,
            "base_url": p.base_url,
            "protocol": infer_provider_protocol(p.base_url, getattr(p, "protocol", None)),
            "enabled": p.enabled,
            "created_at": p.created_at,
        }

    @staticmethod
    def get_all_providers():
        rows = get_all_providers()
        if rows is None:
            return []

        return [ProviderService.serialize_provider(row) for row in rows] if rows else []

    @staticmethod
    def get_all_providers_safe():
        rows = get_all_providers()
        return [ProviderService.serialize_provider_safe(row) for row in rows] if rows else []

    @staticmethod
    def get_provider_by_name(name: str):
        row = get_provider_by_name(name)
        return ProviderService.serialize_provider(row)

    @staticmethod
    def get_provider_by_id(id: str):  # 已改为 str 类型
        row = get_provider_by_id(id)
        return ProviderService.serialize_provider(row)

    @staticmethod
    def get_provider_by_id_safe(id: str):  # 已改为 str 类型
        row = get_provider_by_id(id)
        return ProviderService.serialize_provider_safe(row)

    @staticmethod
    def update_provider(id: str, data: dict) -> dict | None:
        try:
            filtered_data = {k: v for k, v in data.items() if v is not None and k != 'id'}
            # 防御掩码污染：前端展示时 api_key 被 mask_key() 处理过（如 a92f****...2d3a），
            # 如果用户未重新输入直接保存，带星号的值不应覆盖原 key。
            if 'api_key' in filtered_data:
                raw_key = str(filtered_data.get('api_key', ''))
                if '*' in raw_key:
                    filtered_data.pop('api_key')
                else:
                    filtered_data['api_key'] = encrypt_secret(raw_key)
            if 'protocol' in filtered_data:
                proto = str(filtered_data['protocol']).strip()
                if proto not in VALID_PROTOCOLS:
                    raise ValueError(f'不支持的接口协议: {proto}')
                filtered_data['protocol'] = proto
            print('更新模型供应商', id)
            update_provider(id, **filtered_data)
            updated_provider = get_provider_by_id(id)
            if not updated_provider:
                return None
            return {
                'id': id,
                'enabled': updated_provider.enabled,
                'protocol': infer_provider_protocol(updated_provider.base_url, getattr(updated_provider, 'protocol', None)),
            }

        except Exception as e:
            print('更新模型供应商失败：', e)
            return None

    @staticmethod
    def delete_provider(id: str):
        row = get_provider_by_id(id)
        if not row:
            raise ValueError('供应商不存在')
        if row.type == 'built-in':
            raise ValueError('内置预设供应商不可删除，可改为关闭启用状态')
        return delete_provider(id)
