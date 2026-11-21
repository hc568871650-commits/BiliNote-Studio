"""统一蒸馏任务队列与 SSE 实时事件流路由。"""

from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import StreamingResponse

from app.jobs.manager import get_job_manager
from app.utils.response import ResponseWrapper as R

router = APIRouter(prefix="/jobs", tags=["jobs"])


@router.get("")
def list_jobs():
    manager = get_job_manager()
    return R.success(manager.list_jobs().to_dict())


@router.get("/events")
async def stream_job_events(once: bool = False):
    manager = get_job_manager()
    return StreamingResponse(
        manager.event_bus.iter_sse(
            lambda: manager.list_jobs().to_dict(),
            once=once,
        ),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.post("/{job_id}/cancel")
def cancel_job(job_id: str):
    manager = get_job_manager()
    ok = manager.cancel(job_id)
    if not ok:
        return R.error("任务不存在或已结束，无法取消", code=409)
    return R.success({"job_id": job_id, "cancelled": True})


@router.post("/{job_id}/retry")
def retry_job(job_id: str):
    manager = get_job_manager()
    try:
        new_job = manager.retry(job_id)
        return R.success(new_job.to_public_dict())
    except KeyError as exc:
        return R.error(str(exc), code=404)
    except ValueError as exc:
        return R.error(str(exc), code=409)


@router.post("/clear-finished")
def clear_finished_jobs():
    manager = get_job_manager()
    cleared = manager.clear_finished()
    return R.success({"cleared": cleared})
