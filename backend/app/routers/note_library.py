import logging
from typing import Any
from fastapi import APIRouter
from pydantic import BaseModel, Field, ConfigDict
from app.services import note_library as library
from app.utils.response import ResponseWrapper as R

router = APIRouter(prefix='/note_library')
logger = logging.getLogger(__name__)


class LibraryUpdate(BaseModel):
    model_config = ConfigDict(extra='forbid')
    task_ids: list[str] = Field(min_length=1, max_length=500)
    changes: dict[str, Any]


def _call(action, *args):
    try:
        return R.success(action(*args))
    except FileNotFoundError as exc:
        return R.error(str(exc), code=404)
    except ValueError as exc:
        return R.error(str(exc), code=400)
    except library.InvalidLibraryState as exc:
        logger.exception('Cannot read learning metadata')
        return R.error(str(exc), code=500)
    except OSError:
        logger.exception('Cannot save learning metadata')
        return R.error('学习信息保存失败，操作未完成，请检查磁盘后重试', code=500)


@router.get('')
def list_entries():
    return _call(library.list_entries)


@router.post('/update')
def update_entries(data: LibraryUpdate):
    return _call(library.update_entries, data.task_ids, data.changes)
