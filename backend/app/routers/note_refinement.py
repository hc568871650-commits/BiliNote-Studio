from typing import Literal
from fastapi import APIRouter
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from app.services import note_refinement as service
from app.utils.response import ResponseWrapper as R
from app.utils.ai_errors import SafeAIError

router = APIRouter()


class Selection(BaseModel):
    version_id: str = Field(min_length=1, max_length=100)
    texts: list[str] = Field(min_length=1, max_length=80)


class Preview(Selection):
    start_time: float = Field(ge=0, allow_inf_nan=False)
    end_time: float = Field(gt=0, allow_inf_nan=False)
    instruction: str = Field(default='', max_length=1500)
    provider_id: str = Field(min_length=1, max_length=100)
    model_name: str = Field(min_length=1, max_length=200)
    protocol: Literal['openai-chat', 'openai-responses', 'anthropic'] = 'openai-chat'
    use_video: bool = False


class Apply(BaseModel):
    draft_id: str = Field(pattern=r'^[a-f0-9]{32}$')


def respond(action):
    try:
        return R.success(action())
    except SafeAIError as exc:
        return R.error(str(exc), code=502, data={'details': exc.details})
    except (ValueError, FileNotFoundError) as exc:
        return R.error(str(exc), code=400)
    except Exception:
        return R.error('局部蒸馏未完成，原笔记没有修改；请检查源视频与模型后重试', code=500)


@router.post('/notes/{task_id}/refine/context')
def context(task_id: str, data: Selection):
    return respond(lambda: service.source_context(task_id, data.version_id, data.texts))


@router.post('/notes/{task_id}/refine/preview')
def preview(task_id: str, data: Preview):
    return respond(lambda: service.preview(task_id, data.model_dump()))


@router.post('/notes/{task_id}/refine/apply')
def apply(task_id: str, data: Apply):
    return respond(lambda: service.apply(task_id, data.draft_id))


@router.get('/notes/{task_id}/refine/{draft_id}/frames/{name}')
def frame(task_id: str, draft_id: str, name: str):
    try:
        return FileResponse(service.frame_asset(task_id, draft_id, name), media_type='image/jpeg')
    except ValueError:
        from fastapi import HTTPException
        raise HTTPException(404, '截图不可用') from None
