from fastapi import APIRouter

from app.models.organizer_requests import (PlanRequest, PlanActionRequest, SessionCreateRequest,
                                          SessionMessageRequest, SessionActionRequest, SessionCompactRequest,
                                          RetentionPreviewRequest, RetentionUpdateRequest)
from app.services import organizer
from app.utils.response import ResponseWrapper as R
from app.utils.logger import get_logger
from app.utils.ai_errors import SafeAIError

router = APIRouter(prefix='/organizer')
logger = get_logger(__name__)


def _call(fn, *args, **kwargs):
    try:
        return R.success(data=fn(*args, **kwargs))
    except SafeAIError as exc:
        return R.error(msg=str(exc), code=500, data={'error_details': exc.details})
    except FileNotFoundError as exc:
        return R.error(msg=str(exc), code=404)
    except ValueError as exc:
        return R.error(msg=str(exc), code=409, data=getattr(exc, 'data', None))
    except Exception as exc:
        logger.exception('整理助手请求失败')
        if isinstance(exc, RuntimeError):
            return R.error(msg=str(exc), code=500)
        return R.error(msg='整理助手请求失败，请检查所选模型连接或后端日志；未自动更换模型', code=500)


@router.post('/plan')
def plan(data: PlanRequest):
    return _call(organizer.plan, data.instruction, data.scope.model_dump(), data.provider_id, data.model_name,
                 reasoning_effort=data.reasoning_effort, context_limit=data.context_limit,
                 protocol=data.protocol, web_search=data.web_search, web_search_mode=data.web_search_mode)


@router.post('/execute')
def execute(data: PlanActionRequest):
    return _call(organizer.execute, data.plan_id)


@router.post('/undo')
def undo(data: PlanActionRequest):
    return _call(organizer.undo, data.plan_id)


@router.post('/recover')
def recover(data: PlanActionRequest):
    return _call(organizer.recover, data.plan_id)


# Import lazily so legacy integrations do not require the optional agent stack.
def _sessions():
    from app.services import organizer_sessions
    return organizer_sessions


@router.get('/sessions')
def sessions_list():
    return _call(_sessions().list_sessions)


@router.post('/sessions')
def sessions_create(data: SessionCreateRequest):
    return _call(_sessions().create, data.scope.model_dump(), data.provider_id, data.model_name,
                 data.confirmation_token, data.request_id, protocol=data.protocol)


@router.get('/retention')
def retention_get():
    return _call(_sessions().retention)


@router.post('/retention/preview')
def retention_preview(data: RetentionPreviewRequest):
    return _call(_sessions().retention_preview, data.operation, data.limit)


@router.patch('/retention')
def retention_update(data: RetentionUpdateRequest):
    return _call(_sessions().set_retention, data.limit, data.confirmation_token, data.request_id)


@router.get('/sessions/{session_id}')
def sessions_get(session_id: str):
    return _call(_sessions().get, session_id)


@router.post('/sessions/{session_id}/message')
def sessions_message(session_id: str, data: SessionMessageRequest):
    return _call(_sessions().message, session_id, data.model_dump())


@router.post('/sessions/{session_id}/compact')
def sessions_compact(session_id: str, data: SessionCompactRequest):
    return _call(_sessions().compact, session_id, data.model_dump())


@router.post('/sessions/{session_id}/cancel-compaction')
def sessions_cancel_compaction(session_id: str, data: SessionActionRequest):
    return _call(_sessions().cancel_compaction, session_id, data.model_dump())


@router.post('/sessions/{session_id}/{action}')
def sessions_action(session_id: str, action: str, data: SessionActionRequest):
    if action not in ('approve', 'cancel', 'undo', 'recover'):
        return R.error(msg='未知会话操作', code=409)
    return _call(_sessions().action, session_id, action, data.model_dump())
