from fastapi import APIRouter
from pydantic import BaseModel, Field

from app.services.model import ModelService
from app.utils.response import ResponseWrapper as R
router = APIRouter()
modelService = ModelService()
class CreateModelRequest(BaseModel):
    provider_id: str
    model_name: str
    display_name: str | None = Field(default=None, max_length=200)

class UpdateModelDisplayNameRequest(BaseModel):
    id: int
    display_name: str | None = Field(default=None, max_length=200)


class UpdateModelRequest(BaseModel):
    id: int | None = None
    model_name: str | None = Field(default=None, min_length=1, max_length=200)
    display_name: str | None = Field(default=None, max_length=200)


class BatchModelItem(BaseModel):
    model_name: str = Field(min_length=1, max_length=200)
    display_name: str | None = Field(default=None, max_length=200)


class BatchCreateModelsRequest(BaseModel):
    provider_id: str = Field(min_length=1, max_length=100)
    models: list[BatchModelItem] = Field(min_length=1, max_length=200)


class BatchDeleteModelsRequest(BaseModel):
    ids: list[int] = Field(min_length=1, max_length=200)

# 返回体：模型信息
class ModelItem(BaseModel):
    id: int
    model_name: str
@router.get("/model_list")
def model_list():
    try:
        return R.success(modelService.get_all_models(True),msg="获取模型列表成功")
    except Exception as e:
        return R.error(e)
@router.get("/models/delete/{model_id}")
def delete_model(model_id: int):
    try:
        success = modelService.delete_model_by_id(model_id)
        if success:
            return R.success(msg="模型删除成功")
        else:
            return R.error("模型不存在或删除失败")
    except Exception as e:
        return R.error(f"删除模型失败: {e}")
@router.get("/model_list/{provider_id}")
def model_list(provider_id):

    return R.success(modelService.get_all_models_by_id(provider_id))


@router.post("/models")
def create_model(data: CreateModelRequest):
    success = ModelService.add_new_model(data.provider_id, data.model_name, data.display_name)
    if not success:
        return R.error("模型添加失败")
    return R.success(msg="模型添加成功")

@router.post("/models/display_name")
def update_model_display_name(data: UpdateModelDisplayNameRequest):
    try:
        model = ModelService.set_display_name(data.id, data.display_name)
        if not model:
            return R.error("模型不存在")
        return R.success(model, msg="模型展示名已更新")
    except Exception as e:
        return R.error(f"更新模型展示名失败: {e}")


@router.put("/models/{model_id}")
def update_model_by_id(model_id: int, data: UpdateModelRequest):
    try:
        fields = data.model_fields_set
        model = ModelService.update_model_full(
            model_id,
            model_name=data.model_name if "model_name" in fields else None,
            display_name=data.display_name,
            update_display_name="display_name" in fields,
        )
        if not model:
            return R.error("模型不存在", code=404)
        return R.success(model, msg="模型配置已更新")
    except ValueError as e:
        return R.error(str(e), code=400)
    except Exception as e:
        return R.error(f"更新模型失败: {e}")


@router.post("/models/update")
def update_model_compat(data: UpdateModelRequest):
    if data.id is None:
        return R.error("缺少模型 ID", code=400)
    return update_model_by_id(data.id, data)


@router.post("/models/batch")
def batch_create_models(data: BatchCreateModelsRequest):
    try:
        res = ModelService.add_models_batch(
            data.provider_id,
            [item.model_dump() for item in data.models],
        )
        return R.success(res, msg="批量添加模型完成")
    except ValueError as e:
        return R.error(str(e), code=400)
    except Exception as e:
        return R.error(f"批量添加模型失败: {e}")


@router.post("/models/batch-delete")
def batch_delete_models(data: BatchDeleteModelsRequest):
    try:
        deleted = ModelService.delete_models_batch(data.ids)
        return R.success({"deleted": deleted}, msg="批量删除模型完成")
    except Exception as e:
        return R.error(f"批量删除模型失败: {e}")

@router.get("/model_enable/{provider_id}")
def get_enabled_models_by_provider(provider_id: str):
    try:
        models = modelService.get_enabled_models_by_provider(provider_id)
        return R.success(models, msg="获取启用模型成功")
    except Exception as e:
        return R.error(f"获取启用模型失败: {e}")
