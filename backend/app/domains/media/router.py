"""独立媒体域路由（/api/media/*）与旧路径（/api/notes/{task_id}/media）兼容别名。"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel

from app.utils.response import ResponseWrapper as R

router = APIRouter(tags=["media"])


class TranslateCaptionsRequest(BaseModel):
    target_lang: str = "zh-CN"
    force: bool = False
    provider_id: Optional[str] = None
    model_name: Optional[str] = None


def _resolve_concat_segments(task_id: str, media_path: Path) -> list[dict]:
    """读取自动拼接视频的时间分界点（优先笔记元数据，其次同目录 .clips.json）。"""
    from app.services import note_storage

    try:
        task = note_storage.get_task(task_id) or {}
        audio_meta = task.get("audioMeta") if isinstance(task.get("audioMeta"), dict) else {}
        raw_info = audio_meta.get("raw_info") if isinstance(audio_meta.get("raw_info"), dict) else {}
        segs = raw_info.get("concat_segments")
        if isinstance(segs, list) and len(segs) >= 2:
            return [s for s in segs if isinstance(s, dict)]
    except Exception:
        pass

    try:
        cache_file = note_storage.cache_path(task_id, "audio")
        if cache_file.is_file() and not cache_file.is_symlink():
            cached = json.loads(cache_file.read_text(encoding="utf-8"))
            raw_info = cached.get("raw_info") if isinstance(cached, dict) and isinstance(cached.get("raw_info"), dict) else {}
            segs = raw_info.get("concat_segments")
            if isinstance(segs, list) and len(segs) >= 2:
                return [s for s in segs if isinstance(s, dict)]
    except Exception:
        pass

    try:
        sidecar = media_path.with_suffix(".clips.json")
        if sidecar.is_file() and not sidecar.is_symlink():
            data = json.loads(sidecar.read_text(encoding="utf-8"))
            segs = data.get("segments") if isinstance(data, dict) else None
            if isinstance(segs, list) and len(segs) >= 2:
                return [s for s in segs if isinstance(s, dict)]
    except Exception:
        pass

    return []


@router.get("/media/{task_id}/info")
def get_note_media_info(task_id: str):
    """轻量探测笔记是否存在可用的本地音视频回看流，并附带拼接分界节点。"""
    from app.services import media_stream

    try:
        media_path = media_stream.resolve_note_media_path(task_id)
    except (ValueError, FileNotFoundError):
        return R.success({
            "available": False,
            "media_type": None,
            "size": 0,
            "url": None,
            "concat_segments": [],
        })

    file_size = media_path.stat().st_size
    media_type = media_stream.guess_media_type(media_path)
    concat_segments = _resolve_concat_segments(task_id, media_path)
    return R.success({
        "available": True,
        "media_type": media_type,
        "size": file_size,
        "url": f"/api/media/{task_id}",
        "concat_segments": concat_segments,
    })


@router.post("/media/{task_id}/translate-captions")
@router.post("/notes/{task_id}/translate-captions")
def translate_note_captions_endpoint(task_id: str, req: Optional[TranslateCaptionsRequest] = None):
    """按需将外语视频转写字幕翻译为简体中文并写入笔记本地永久缓存。"""
    from app.services.transcript_translator import translate_note_captions

    body = req or TranslateCaptionsRequest()
    try:
        result = translate_note_captions(
            task_id,
            target_lang=body.target_lang,
            force=body.force,
            provider_id=body.provider_id,
            model_name=body.model_name,
        )
        return R.success(result)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"字幕翻译失败：{exc}")


@router.get("/media/{task_id}")
@router.get("/notes/{task_id}/media")
def stream_note_media(task_id: str, request: Request):
    from app.services import media_stream

    try:
        media_path = media_stream.resolve_note_media_path(task_id)
    except (ValueError, FileNotFoundError) as exc:
        raise HTTPException(status_code=404, detail=str(exc))

    file_size = media_path.stat().st_size
    media_type = media_stream.guess_media_type(media_path)
    range_header = request.headers.get("range")
    if range_header:
        try:
            byte_range = media_stream.parse_http_range(range_header, file_size)
        except ValueError:
            return Response(
                status_code=416,
                headers={"Content-Range": f"bytes */{file_size}", "Accept-Ranges": "bytes"},
            )
        start, end = byte_range
        content_length = end - start + 1
        headers = {
            "Content-Range": f"bytes {start}-{end}/{file_size}",
            "Accept-Ranges": "bytes",
            "Content-Length": str(content_length),
            "X-Content-Type-Options": "nosniff",
        }
        return StreamingResponse(
            media_stream.iter_file_range(media_path, start, end),
            status_code=206,
            media_type=media_type,
            headers=headers,
        )

    headers = {
        "Accept-Ranges": "bytes",
        "Content-Length": str(file_size),
        "X-Content-Type-Options": "nosniff",
    }
    return StreamingResponse(
        media_stream.iter_file_range(media_path, 0, max(0, file_size - 1)),
        status_code=200,
        media_type=media_type,
        headers=headers,
    )
