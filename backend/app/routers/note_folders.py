import logging
from fastapi import APIRouter
from pydantic import BaseModel, Field

from app.services import note_folders as folders
from app.utils.response import ResponseWrapper as R

router = APIRouter(prefix="/note_folders")
logger = logging.getLogger(__name__)


class FolderName(BaseModel):
    name: str


class MoveNotes(BaseModel):
    task_ids: list[str] = Field(min_length=1, max_length=500)
    folder_id: str


def _call(action, *args):
    try:
        return R.success(action(*args))
    except FileNotFoundError as exc:
        return R.error(str(exc), code=404)
    except ValueError as exc:
        return R.error(str(exc), code=400)
    except folders.InvalidFolderState as exc:
        logger.exception("Cannot read logical folder state")
        return R.error(str(exc), code=500)
    except OSError:
        logger.exception("Cannot save logical folder state")
        return R.error("文件夹记录保存失败，操作未完成，请检查磁盘后重试", code=500)


@router.get("")
def list_folders():
    return _call(folders.list_folders)


@router.post("")
def create_folder(data: FolderName):
    return _call(folders.create_folder, data.name)


@router.post("/move")
def move_notes(data: MoveNotes):
    return _call(folders.move_notes, data.task_ids, data.folder_id)


@router.patch("/{folder_id}")
def rename_folder(folder_id: str, data: FolderName):
    return _call(folders.rename_folder, folder_id, data.name)


@router.delete("/{folder_id}")
def delete_folder(folder_id: str):
    return _call(folders.delete_folder, folder_id)
