from typing import Optional
from fastapi import APIRouter
from pydantic import BaseModel
from typing import Literal

from app.exceptions.provider import ProviderError
from app.models.model_config import ModelConfig
from app.services.model import ModelService
from app.utils.response import ResponseWrapper as R
from app.services.provider import ProviderService

router = APIRouter()

#  新增 type / protocol 字段
ProtocolType = Literal['openai-chat', 'openai-responses', 'anthropic', 'gemini']


class ProviderRequest(BaseModel):
    name: str
    api_key: str
    base_url: str
    logo: Optional[str] = None
    type: str
    protocol: Optional[ProtocolType] = None
    enabled: Literal[0, 1] = 0


class TestRequest(BaseModel):
    id: str
    # 可选：指定用哪个 model 跑连通性测试；不传则用该 provider 在 DB 里的第一个模型
    model: Optional[str] = None
    protocol: Optional[ProtocolType] = None


class ProviderUpdateRequest(BaseModel):
    id: str
    name: Optional[str] = None
    api_key: Optional[str] = None
    base_url: Optional[str] = None
    logo: Optional[str] = None
    type: Optional[str] = None
    protocol: Optional[ProtocolType] = None
    enabled: Optional[int] = None


class PurposePreferencesUpdateRequest(BaseModel):
    generation: Optional[dict] = None
    reading: Optional[dict] = None
    organizer: Optional[dict] = None
    translation: Optional[dict] = None


@router.post("/add_provider")
def add_provider(data: ProviderRequest):
    try:
        res = ProviderService.add_provider(
            name=data.name,
            api_key=data.api_key,
            base_url=data.base_url,
            logo=data.logo,
            type_=data.type,
            enabled=data.enabled,
            protocol=data.protocol,
        )
        return R.success(msg='添加模型供应商成功', data=res)
    except Exception as e:
        return R.error(msg=str(e))


@router.get("/get_all_providers")
def get_all_providers():
    try:
        res = ProviderService.get_all_providers_safe()
        return R.success(data=res)
    except Exception as e:
        return R.error(msg=str(e))


@router.get("/get_provider_by_id/{id}")
def get_provider_by_id(id: str):
    try:
        res = ProviderService.get_provider_by_id_safe(id)
        return R.success(data=res)
    except Exception as e:
        return R.error(msg=str(e))


@router.post("/update_provider")
def update_provider(data: ProviderUpdateRequest):
    try:
        if all(
            field is None
            for field in [data.name, data.api_key, data.base_url, data.logo, data.type, data.protocol, data.enabled]
        ):
            return R.error(msg='请至少填写一个参数')

        updated_provider = ProviderService.update_provider(
            id=data.id,
            data=data.model_dump()
        )
        if updated_provider:
            return R.success(msg='更新模型供应商成功', data=updated_provider)
        else:
            return R.error(msg='更新模型供应商失败')
    except Exception as e:
        print(e)
        return R.error(msg=str(e))


@router.delete("/providers/{id}")
@router.post("/delete_provider/{id}")
def delete_provider(id: str):
    try:
        ok = ProviderService.delete_provider(id)
        if ok:
            return R.success(msg='删除自定义供应商成功', data={'id': id})
        return R.error(msg='删除供应商失败', code=400)
    except ValueError as e:
        return R.error(msg=str(e), code=400)
    except Exception as e:
        return R.error(msg=str(e), code=500)


@router.post('/connect_test')
def gpt_connect_test(data: TestRequest):
    try:
        ModelService().connect_test(data.id, model=data.model, protocol=data.protocol)
        return R.success(msg='连接测试成功')
    except ProviderError as exc:
        return R.error(msg=exc.message, code=exc.code, data={'error_details': getattr(exc, 'error_details', None)})


@router.get("/ai_purposes")
def get_ai_purposes():
    from app.services.purpose_preferences import get_purpose_preferences
    return R.success(data=get_purpose_preferences())


@router.put("/ai_purposes")
@router.post("/ai_purposes")
def save_ai_purposes(data: PurposePreferencesUpdateRequest):
    from app.services.purpose_preferences import update_purpose_preferences
    try:
        changes = data.model_dump(exclude_unset=True)
        return R.success(data=update_purpose_preferences(changes), msg="用途偏好已保存")
    except ValueError as exc:
        return R.error(msg=str(exc), code=400)
