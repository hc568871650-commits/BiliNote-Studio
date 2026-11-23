"""系统存储维护、低码率回看缓存策略、整库备份恢复与检查更新路由。"""
from __future__ import annotations

import os
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, File, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

from app.utils.response import ResponseWrapper as R

router = APIRouter(tags=["system_maintenance"])


class PlaybackCachePolicyRequest(BaseModel):
    enabled: Optional[bool] = None
    retention_days: Optional[int] = None
    max_size_mb: Optional[int] = None


@router.get("/system/storage")
def get_system_storage():
    from app.services import system_maintenance

    return R.success(system_maintenance.get_storage_summary())


@router.post("/system/storage/clear-cache")
def clear_system_temp_cache():
    from app.services import system_maintenance

    return R.success(system_maintenance.clear_temp_media_cache(), msg="临时音视频缓存已清理")


@router.get("/system/playback-cache")
def get_playback_cache_policy():
    from app.services import system_maintenance

    return R.success(system_maintenance.get_playback_cache_policy())


@router.put("/system/playback-cache")
def update_playback_cache_policy(data: PlaybackCachePolicyRequest):
    from app.services import system_maintenance

    try:
        updated = system_maintenance.update_playback_cache_policy(data.model_dump(exclude_none=True))
        if updated.get("enabled"):
            system_maintenance.enforce_playback_cache_policy()
        return R.success(updated, msg="回看缓存策略已更新")
    except ValueError as exc:
        return R.error(str(exc), code=400)


def _remove_file_quietly(path: str) -> None:
    try:
        if os.path.exists(path):
            os.unlink(path)
    except OSError:
        pass


@router.get("/system/backup")
def download_library_backup(background_tasks: BackgroundTasks, include_secrets: bool = False):
    from app.services import system_maintenance

    zip_path = system_maintenance.create_library_backup_zip(include_secrets=include_secrets)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    filename = f"bilinote-studio-backup-{stamp}.zip"
    background_tasks.add_task(_remove_file_quietly, str(zip_path))
    return FileResponse(
        path=str(zip_path),
        media_type="application/zip",
        filename=filename,
    )


@router.post("/system/restore")
async def restore_library_backup(file: UploadFile = File(...)):
    from app.services import system_maintenance

    try:
        raw = await file.read()
        result = system_maintenance.restore_library_backup_zip(raw)
        return R.success(result, msg="整库备份已恢复，恢复前已自动生成安全预备份")
    except ValueError as exc:
        return R.error(str(exc), code=400)
    except Exception as exc:
        return R.error(f"恢复失败：{exc}", code=500)


@router.get("/system/check-update")
def check_app_update(current_version: Optional[str] = None):
    from app.services import system_maintenance

    try:
        return R.success(system_maintenance.check_latest_release(current_version=current_version))
    except RuntimeError as exc:
        return R.error(str(exc), code=502)
