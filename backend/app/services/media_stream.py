"""Sandboxed local media streaming with HTTP Range (206 Partial Content) support."""
from __future__ import annotations

import json
import mimetypes
import os
import re
import stat
from pathlib import Path
from typing import Iterator

from app.services import note_storage

ALLOWED_MEDIA_EXTENSIONS = {
    ".mp4", ".mkv", ".mov", ".webm", ".avi", ".m4v",
    ".mp3", ".m4a", ".wav", ".aac", ".ogg", ".flac",
}
_RANGE_RE = re.compile(r"^bytes=(\d*)-(\d*)$")
_BLOCKED_PREFIXES_WIN = ("windows", "program files", "program files (x86)", "programdata")
CHUNK_SIZE = 64 * 1024


def _is_forbidden_system_path(resolved: Path) -> bool:
    parts = [p.lower() for p in resolved.parts]
    if os.name == "nt" and len(parts) >= 2:
        if parts[1] in _BLOCKED_PREFIXES_WIN:
            return True
    if os.name != "nt" and len(parts) >= 2 and parts[1] in ("etc", "proc", "sys", "dev", "root", "boot"):
        return True
    return False


def _validate_media_candidate(raw_path: str, allowed_roots: list[Path] | None = None) -> Path | None:
    if not isinstance(raw_path, str):
        return None
    text = raw_path.strip()
    if not text or re.match(r"^https?://", text, re.IGNORECASE):
        return None
    # Reject explicit traversal segments before resolution.
    raw_parts = Path(text).parts
    if ".." in raw_parts:
        return None
    candidate = Path(text)
    if candidate.suffix.lower() not in ALLOWED_MEDIA_EXTENSIONS:
        return None
    try:
        linfo = candidate.lstat()
    except OSError:
        return None
    if stat.S_ISLNK(linfo.st_mode) or (getattr(linfo, "st_file_attributes", 0) & 0x400):
        return None
    if not stat.S_ISREG(linfo.st_mode):
        return None
    resolved = candidate.resolve()
    if _is_forbidden_system_path(resolved):
        return None
    if allowed_roots:
        if not any(resolved.is_relative_to(root.resolve()) for root in allowed_roots if root is not None):
            return None
    return resolved


def resolve_note_media_path(task_id: str) -> Path:
    """Resolve the verified local audio/video file belonging to a saved note."""
    note_storage.valid_id(task_id)
    task = note_storage.get_task(task_id)
    if not task:
        raise FileNotFoundError("笔记不存在")

    audio_meta = task.get("audioMeta") or {}
    form_data = task.get("formData") or {}

    # Priority 1: paths recorded inside trusted note metadata & cache
    candidates: list[str] = []
    for key in ("video_path", "file_path"):
        val = audio_meta.get(key)
        if isinstance(val, str) and val.strip():
            candidates.append(val)

    cache_file = note_storage.cache_path(task_id, "audio")
    if cache_file.is_file() and not cache_file.is_symlink():
        try:
            cached = json.loads(cache_file.read_text(encoding="utf-8"))
            if isinstance(cached, dict):
                for key in ("video_path", "file_path"):
                    val = cached.get(key)
                    if isinstance(val, str) and val.strip():
                        candidates.append(val)
        except (OSError, ValueError):
            pass

    if form_data.get("platform") == "local" and isinstance(form_data.get("video_url"), str):
        candidates.append(form_data["video_url"])

    # Optional strict sandbox root override via env (defaults to trusting verified note metadata paths outside system dirs).
    env_roots = os.getenv("MEDIA_STREAM_ALLOWED_ROOTS", "").strip()
    allowed_roots = [Path(p.strip()) for p in env_roots.split(os.pathsep) if p.strip()] if env_roots else None

    for raw in candidates:
        valid = _validate_media_candidate(raw, allowed_roots=allowed_roots)
        if valid is not None:
            return valid

    raise FileNotFoundError("该笔记没有可播放的本地原片音视频文件")


def parse_http_range(range_header: str | None, file_size: int) -> tuple[int, int] | None:
    """Parse RFC 7233 single byte range. Returns (start, end) inclusive, or None if no Range header.

    Raises ValueError on unsatisfiable or malformed Range header (caller maps to HTTP 416).
    """
    if not range_header:
        return None
    header = range_header.strip()
    if "," in header:
        raise ValueError("暂不支持多段并发 Range 请求")
    match = _RANGE_RE.fullmatch(header)
    if not match or file_size <= 0:
        raise ValueError("无效的 Range 范围")
    start_s, end_s = match.group(1), match.group(2)
    if not start_s and not end_s:
        raise ValueError("无效的 Range 范围")
    if not start_s:
        suffix = int(end_s)
        if suffix <= 0:
            raise ValueError("无效的 Range 范围")
        start = max(0, file_size - suffix)
        end = file_size - 1
    else:
        start = int(start_s)
        end = int(end_s) if end_s else file_size - 1
        if start >= file_size or end < start:
            raise ValueError("请求的字节范围越界")
        end = min(end, file_size - 1)
    return start, end


def guess_media_type(path: Path) -> str:
    ext = path.suffix.lower()
    explicit = {
        ".mp4": "video/mp4",
        ".m4v": "video/mp4",
        ".webm": "video/webm",
        ".mkv": "video/x-matroska",
        ".mov": "video/quicktime",
        ".avi": "video/x-msvideo",
        ".mp3": "audio/mpeg",
        ".m4a": "audio/mp4",
        ".wav": "audio/wav",
        ".aac": "audio/aac",
        ".ogg": "audio/ogg",
        ".flac": "audio/flac",
    }
    if ext in explicit:
        return explicit[ext]
    guessed, _ = mimetypes.guess_type(str(path))
    return guessed or "application/octet-stream"


def iter_file_range(path: Path, start: int, end: int, chunk_size: int = CHUNK_SIZE) -> Iterator[bytes]:
    remaining = end - start + 1
    with path.open("rb") as fh:
        fh.seek(start)
        while remaining > 0:
            chunk = fh.read(min(chunk_size, remaining))
            if not chunk:
                break
            remaining -= len(chunk)
            yield chunk
