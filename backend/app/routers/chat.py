from fastapi import APIRouter, BackgroundTasks
from fastapi.responses import StreamingResponse
import json
import anyio
from pydantic import BaseModel, Field
from app.models.ai_requests import AskRequest, CompactRequest

from app.services.chat_service import chat as chat_service
from app.services.chat_service import chat_stream
from app.services.vector_store import VectorStoreManager
from app.utils.logger import get_logger
from app.utils.response import ResponseWrapper as R
from app.utils.ai_errors import error_details

logger = get_logger(__name__)

router = APIRouter()

# 索引状态追踪: task_id -> "indexing" | "indexed" | "failed"
_index_status: dict[str, str] = {}


class IndexRequest(BaseModel):
    task_id: str = Field(pattern=r'^[a-zA-Z0-9_-]{1,100}$')


def _do_index(task_id: str):
    """后台执行索引任务。"""
    try:
        _index_status[task_id] = "indexing"
        store = VectorStoreManager()
        store.index_task(task_id)
        _index_status[task_id] = "indexed"
        logger.info(f"索引完成: {task_id}")
    except Exception as e:
        _index_status[task_id] = "failed"
        logger.error(f"索引失败: {task_id}, {e}")


@router.post("/chat/index")
def index_task(data: IndexRequest, background_tasks: BackgroundTasks):
    """触发后台索引，立即返回。"""
    if _index_status.get(data.task_id) == "indexing":
        return R.success(msg="正在索引中")

    # 如果已经索引过，直接返回
    store = VectorStoreManager()
    if store.is_indexed(data.task_id):
        _index_status[data.task_id] = "indexed"
        return R.success(msg="已完成索引")

    _index_status[data.task_id] = "indexing"
    background_tasks.add_task(_do_index, data.task_id)
    return R.success(msg="开始索引")


@router.get("/chat/status")
def chat_status(task_id: str):
    """返回索引状态：idle / indexing / indexed / failed。"""
    try:
        # 优先检查内存状态
        status = _index_status.get(task_id)
        if status:
            return R.success(data={"status": status, "indexed": status == "indexed"})

        # 内存没有记录，检查持久化
        store = VectorStoreManager()
        indexed = store.is_indexed(task_id)
        if indexed:
            _index_status[task_id] = "indexed"
        return R.success(data={"status": "indexed" if indexed else "idle", "indexed": indexed})
    except Exception as e:
        logger.error(f"查询索引状态失败: {e}")
        return R.success(data={"status": "idle", "indexed": False})


@router.post("/chat/ask")
def ask_question(data: AskRequest):
    """基于笔记内容的 RAG 问答。"""
    try:
        history = [m.model_dump(exclude_none=True) for m in data.history]
        result = chat_service(
            task_id=data.task_id,
            question=data.question,
            history=history,
            provider_id=data.provider_id,
            model_name=data.model_name,
            attachments=[a.model_dump(exclude_none=True) for a in data.attachments],
            context_mode=data.context_mode,
            reasoning_effort=data.reasoning_effort,
            context_limit=data.context_limit,
            summary=data.summary,
            protocol=data.protocol,
            web_search=data.web_search,
            web_search_mode=data.web_search_mode,
        )
        return R.success(data=result)
    except Exception as e:
        details = error_details(e, data.protocol)
        logger.warning('Chat 问答失败: %s', details)
        return R.error(msg=details['detail'], data={'error_details': details})


@router.post('/chat/ask/stream')
def ask_question_stream(data: AskRequest):
    """POST SSE; HTTP validation is unchanged, model failures are error events."""
    async def events():
        cancellation = {}
        iterator = chat_stream(**data.model_dump(exclude_none=True), cancellation=cancellation)
        sentinel = object()
        advancing = False
        def advance():
            try:
                return next(iterator, sentinel)
            finally:
                if cancellation.get('cancelled'):
                    iterator.close()
        try:
            while True:
                advancing = True
                event = await anyio.to_thread.run_sync(advance, abandon_on_cancel=True)
                advancing = False
                if event is sentinel:
                    break
                yield 'data: ' + json.dumps(event, ensure_ascii=False) + '\n\n'
        except Exception as exc:
            details = error_details(exc, data.protocol)
            logger.warning('Chat 流式问答失败: %s', details)
            yield 'data: ' + json.dumps({'type': 'error', 'msg': details['detail'],
                'data': {'error_details': details}}, ensure_ascii=False) + '\n\n'
        finally:
            cancellation['cancelled'] = True
            stream_close = cancellation.get('stream_close')
            if stream_close:
                stream_close()
            close = cancellation.get('close')
            if close:
                close()
            if not advancing:
                iterator.close()
    return StreamingResponse(events(), media_type='text/event-stream',
                             headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'})


@router.post('/chat/compact')
def compact_question_history(data: CompactRequest):
    from app.services.ai_client import get_client, close_client
    from app.services.context_compaction import compact_history
    gpt = None
    try:
        gpt = get_client(data.provider_id, data.model_name, protocol=data.protocol)
        return R.success(data=compact_history(gpt.client, data.model_name,
            [m.model_dump(exclude_none=True) for m in data.history], data.summary, data.keep_recent))
    except Exception as exc:
        details = error_details(exc, data.protocol)
        logger.warning('阅读上下文压缩失败，原始记录未修改: %s', details)
        return R.error(msg=details['detail'], data={'error_details': details})
    finally:
        if gpt is not None:
            close_client(gpt.client)
