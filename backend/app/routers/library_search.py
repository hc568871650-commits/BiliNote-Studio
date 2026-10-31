import logging
from typing import Literal

from fastapi import APIRouter, Query

from app.services import library_search, note_folders
from app.utils.response import ResponseWrapper as R

router = APIRouter(prefix='/library')
logger = logging.getLogger(__name__)


@router.get('/search')
def search(query: str = Query(min_length=1, max_length=500),
           scope: Literal['all', 'folder'] = 'all', folder_id: str | None = None,
           offset: int = Query(default=0, ge=0), limit: int = Query(default=20, ge=1, le=30)):
    # A synchronous route puts filesystem traversal in FastAPI's worker pool.
    try:
        return R.success(library_search.search_notes(query, scope, folder_id, offset, limit))
    except FileNotFoundError as error:
        return R.error(str(error), code=404)
    except ValueError as error:
        return R.error(str(error), code=400)
    except note_folders.InvalidFolderState as error:
        return R.error(str(error), code=500)
    except OSError:
        logger.exception('Cannot search library')
        return R.error('笔记暂时无法读取，请检查磁盘后重试', code=500)
