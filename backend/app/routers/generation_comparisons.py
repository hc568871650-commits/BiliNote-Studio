from fastapi import APIRouter
from app.models.generation_comparison import ComparisonRequest
from app.services import generation_comparisons as service
from app.utils.response import ResponseWrapper as R

router = APIRouter()


def respond(action):
    try:
        return R.success(action())
    except (ValueError, FileNotFoundError) as exc:
        return R.error(str(exc), code=400)
    except Exception:
        return R.error('对比记录处理失败，原笔记未修改', code=500)


@router.post('/generation-comparisons')
def create(data: ComparisonRequest):
    return respond(lambda: service.create_run(data))


@router.get('/generation-comparisons')
def listing(task_id: str):
    return respond(lambda: service.list_runs(task_id))


@router.get('/generation-comparisons/{run_id}')
def read(run_id: str):
    return respond(lambda: service.get_run(run_id))


@router.post('/generation-comparisons/{run_id}/cancel')
def cancel(run_id: str):
    return respond(lambda: service.cancel_run(run_id))
