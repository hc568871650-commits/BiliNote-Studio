"""独立媒体域路由（/api/media/*）与旧路径（/api/notes/{task_id}/media）兼容别名。"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response, StreamingResponse

from app.utils.response import ResponseWrapper as R

router = APIRouter(tags=["media"])


@router.get("/media/{task_id}/info")
def get_note_media_info(task_id: str):
    """轻量探测笔记是否存在可用的本地音视频回看流。"""
    from app.services import media_stream

    try:
        media_path = media_stream.resolve_note_media_path(task_id)
    except (ValueError, FileNotFoundError):
        return R.success({"available": False, "media_type": None, "size": 0, "url": None})

    file_size = media_path.stat().st_size
    media_type = media_stream.guess_media_type(media_path)
    return R.success({
        "available": True,
        "media_type": media_type,
        "size": file_size,
        "url": f"/api/media/{task_id}",
    })


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
