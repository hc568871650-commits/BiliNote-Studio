"""多 P 合集 / 播放列表解析、去重标记、自动归文件夹与批量入队引擎。

注意：yt_dlp 仅在真正解析合集时懒加载，不拖慢后端冷启动。
"""

from __future__ import annotations

import re
from typing import Any, Callable
import unicodedata
from urllib.parse import parse_qs, urlparse
import uuid

from app.enums.note_enums import DownloadQuality
from app.jobs.manager import get_job_manager
from app.jobs.models import JobKind, JobSpec, JobStatus
from app.services import note_folders, note_storage
from app.utils.logger import get_logger
from app.utils.url_parser import detect_video_platform, normalize_video_url

logger = get_logger(__name__)

_BV_RE = re.compile(r"(BV[0-9A-Za-z]{10})", re.IGNORECASE)


def _canonical_url_key(url: str) -> str:
    raw = normalize_video_url(str(url or "").strip())
    if not raw:
        return ""
    parsed = urlparse(raw)
    host = (parsed.netloc or "").lower().removeprefix("www.")
    path = parsed.path.rstrip("/")
    qs = parse_qs(parsed.query)
    keep_parts: list[str] = []
    for key in ("v", "p", "bvid"):
        vals = qs.get(key)
        if vals and vals[0]:
            keep_parts.append(f"{key}={vals[0]}")
    query_part = "&".join(keep_parts)
    return f"{host}{path}?{query_part}" if query_part else f"{host}{path}"


def _build_existing_index(existing_tasks: list[dict[str, Any]] | None = None) -> tuple[dict[str, str], dict[str, str]]:
    tasks = existing_tasks if existing_tasks is not None else note_storage.list_tasks()
    by_url: dict[str, str] = {}
    by_video_id: dict[str, str] = {}
    for task in tasks or []:
        if not isinstance(task, dict) or task.get("archived_at"):
            continue
        tid = str(task.get("id") or "").strip()
        if not tid:
            continue
        form_data = task.get("formData") or {}
        audio_meta = task.get("audioMeta") or {}
        url_key = _canonical_url_key(str(form_data.get("video_url") or ""))
        if url_key and url_key not in by_url:
            by_url[url_key] = tid
        vid = str(audio_meta.get("video_id") or "").strip()
        if vid and vid not in by_video_id:
            by_video_id[vid] = tid
    return by_url, by_video_id


def _default_extract_flat(url: str) -> dict[str, Any]:
    import yt_dlp  # 懒加载，严禁顶层导入

    ydl_opts: dict[str, Any] = {
        "extract_flat": "in_playlist",
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "ignoreerrors": True,
        "socket_timeout": 20,
    }
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url, download=False)
    if not isinstance(info, dict):
        raise ValueError("未能解析该链接的媒体信息，请检查链接是否有效或可公开访问")
    return info


def _normalize_entry_url(
    entry: dict[str, Any],
    *,
    source_url: str,
    platform: str,
    index: int,
) -> str:
    candidate = str(entry.get("webpage_url") or entry.get("url") or "").strip()
    if candidate.startswith(("http://", "https://")):
        return candidate
    eid = str(entry.get("id") or "").strip()
    if platform == "youtube":
        if eid:
            return f"https://www.youtube.com/watch?v={eid}"
    if platform == "bilibili":
        bv_match = _BV_RE.search(eid) or _BV_RE.search(source_url)
        if bv_match:
            bvid = bv_match.group(1)
            return f"https://www.bilibili.com/video/{bvid}?p={index}"
    return candidate or source_url


def resolve_collection(
    raw_url: str,
    *,
    extractor: Callable[[str], dict[str, Any]] | None = None,
    existing_tasks: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    cleaned_url = normalize_video_url(str(raw_url or "").strip())
    if not cleaned_url:
        raise ValueError("请输入有效的视频或合集链接")

    platform = detect_video_platform(cleaned_url) or "unknown"
    fn = extractor or _default_extract_flat
    info = fn(cleaned_url)
    if not isinstance(info, dict):
        raise ValueError("合集解析返回了无效数据")

    raw_entries = info.get("entries")
    entries_list = [e for e in (raw_entries or []) if isinstance(e, dict)] if isinstance(raw_entries, list) else []

    by_url, by_video_id = _build_existing_index(existing_tasks)
    items: list[dict[str, Any]] = []

    if entries_list:
        for idx, entry in enumerate(entries_list, start=1):
            item_url = _normalize_entry_url(entry, source_url=cleaned_url, platform=platform, index=idx)
            item_platform = detect_video_platform(item_url) or platform
            video_id = str(entry.get("id") or "").strip()
            title = str(entry.get("title") or f"第 {idx} 集").strip()
            raw_dur = entry.get("duration")
            duration = int(raw_dur) if isinstance(raw_dur, (int, float)) and raw_dur >= 0 else None

            existing_id = by_url.get(_canonical_url_key(item_url)) or (by_video_id.get(video_id) if video_id else None)
            items.append(
                {
                    "index": idx,
                    "title": title,
                    "url": item_url,
                    "video_id": video_id,
                    "duration": duration,
                    "platform": item_platform,
                    "already_exists": bool(existing_id),
                    "existing_task_id": existing_id,
                }
            )
    else:
        # 单视频回退：仍返回结构一致的结果，便于前端优雅降级
        single_url = str(info.get("webpage_url") or cleaned_url).strip()
        video_id = str(info.get("id") or "").strip()
        title = str(info.get("title") or single_url).strip()
        raw_dur = info.get("duration")
        duration = int(raw_dur) if isinstance(raw_dur, (int, float)) and raw_dur >= 0 else None
        existing_id = by_url.get(_canonical_url_key(single_url)) or (by_video_id.get(video_id) if video_id else None)
        items.append(
            {
                "index": 1,
                "title": title,
                "url": single_url,
                "video_id": video_id,
                "duration": duration,
                "platform": detect_video_platform(single_url) or platform,
                "already_exists": bool(existing_id),
                "existing_task_id": existing_id,
            }
        )

    collection_title = str(info.get("title") or (items[0]["title"] if items else "未命名合集")).strip()
    return {
        "collection_title": collection_title,
        "platform": platform,
        "source_url": cleaned_url,
        "is_collection": len(items) > 1,
        "total_count": len(items),
        "items": items,
    }


def _sanitize_folder_name(raw_name: str) -> str:
    cleaned = unicodedata.normalize("NFKC", str(raw_name or "")).strip()
    cleaned = "".join(ch for ch in cleaned if not unicodedata.category(ch).startswith("C"))
    cleaned = cleaned.strip() or "课程合集"
    return cleaned[:60]


def ensure_or_create_folder(name: str) -> dict[str, str]:
    target_name = _sanitize_folder_name(name)
    state = note_folders.list_folders()
    for folder in state.get("folders") or []:
        if str(folder.get("name", "")).casefold() == target_name.casefold():
            return {"id": str(folder["id"]), "name": str(folder["name"])}
    updated = note_folders.create_folder(target_name)
    for folder in updated.get("folders") or []:
        if str(folder.get("name", "")).casefold() == target_name.casefold():
            return {"id": str(folder["id"]), "name": str(folder["name"])}
    raise RuntimeError("创建合集文件夹后未找到对应记录")


def _run_single_batch_item(
    *,
    task_id: str,
    title: str,
    video_url: str,
    platform: str,
    quality: DownloadQuality,
    model_name: str,
    provider_id: str,
    style: str,
    _format: list[str],
    extras: str | None,
    screenshot: bool,
    link: bool,
    video_understanding: bool,
    video_interval: int,
    grid_size: list[int],
    frame_mode: str,
    generation_options: Any,
    request_id: str,
) -> None:
    from app.routers.note import run_note_task

    run_note_task(
        task_id=task_id,
        video_url=video_url,
        platform=platform,
        quality=quality,
        link=link,
        screenshot=screenshot,
        model_name=model_name,
        provider_id=provider_id,
        _format=_format,
        style=style,
        extras=extras,
        video_understanding=video_understanding,
        video_interval=video_interval,
        grid_size=grid_size,
        frame_mode=frame_mode,
        generation_options=generation_options,
        request_id=request_id,
    )


def enqueue_batch_items(
    *,
    items: list[dict[str, Any]],
    model_name: str,
    provider_id: str,
    quality: DownloadQuality = DownloadQuality.medium,
    style: str = "knowledge",
    formats: list[str] | None = None,
    extras: str | None = None,
    screenshot: bool = False,
    link: bool = True,
    video_understanding: bool = False,
    video_interval: int = 0,
    grid_size: list[int] | None = None,
    frame_mode: str = "dynamic",
    generation_options: Any = None,
    create_folder: bool = False,
    folder_name: str | None = None,
    folder_id: str | None = None,
) -> dict[str, Any]:
    if not items:
        raise ValueError("请至少勾选 1 个视频条目")
    if not model_name or not provider_id:
        raise ValueError("请选择模型和模型供应商")

    target_folder: dict[str, str] | None = None
    if create_folder and folder_name:
        target_folder = ensure_or_create_folder(folder_name)
    elif folder_id:
        state = note_folders.list_folders()
        matched = next((f for f in state.get("folders") or [] if f.get("id") == folder_id), None)
        if matched:
            target_folder = {"id": str(matched["id"]), "name": str(matched["name"])}

    batch_id = f"batch-{uuid.uuid4().hex[:12]}"
    manager = get_job_manager()
    enqueued: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    fmt_list = list(formats or ["link"])
    grid_list = list(grid_size or [])

    for idx, raw_item in enumerate(items, start=1):
        url = normalize_video_url(str(raw_item.get("url") or "").strip())
        if not url:
            skipped.append({"index": idx, "reason": "链接为空"})
            continue
        platform = str(raw_item.get("platform") or detect_video_platform(url) or "bilibili").strip()
        title = str(raw_item.get("title") or url).strip()[:160]
        task_id = str(uuid.uuid4())
        request_id = str(uuid.uuid4())

        form_data = {
            "video_url": url,
            "platform": platform,
            "quality": quality.value if isinstance(quality, DownloadQuality) else str(quality),
            "model_name": model_name,
            "provider_id": provider_id,
            "style": style,
            "format": fmt_list,
            "extras": extras or "",
            "screenshot": screenshot,
            "link": link,
            "video_understanding": video_understanding,
            "video_interval": video_interval,
            "grid_size": grid_list,
            "frame_mode": frame_mode,
            "request_id": request_id,
            "batch_id": batch_id,
        }
        note_storage.create_draft(task_id, form_data)
        note_storage.save_task(
            {
                "id": task_id,
                "status": "PENDING",
                "formData": form_data,
                "audioMeta": {"title": title, "platform": platform},
            }
        )
        if target_folder and target_folder["id"] != note_folders.DEFAULT_ID:
            try:
                note_folders.move_notes([task_id], target_folder["id"])
            except Exception as exc:
                logger.warning("批量任务归入文件夹失败 task_id=%s: %s", task_id, exc)

        def _make_runner(
            *,
            _task_id: str = task_id,
            _title: str = title,
            _url: str = url,
            _platform: str = platform,
            _request_id: str = request_id,
        ):
            def _runner(_record, token, updater):
                token.raise_if_cancelled()
                updater(status=JobStatus.DOWNLOADING, progress=18, stage_message="正在拉取课程视频与字幕")
                _run_single_batch_item(
                    task_id=_task_id,
                    title=_title,
                    video_url=_url,
                    platform=_platform,
                    quality=quality,
                    model_name=model_name,
                    provider_id=provider_id,
                    style=style,
                    _format=fmt_list,
                    extras=extras,
                    screenshot=screenshot,
                    link=link,
                    video_understanding=video_understanding,
                    video_interval=video_interval,
                    grid_size=grid_list,
                    frame_mode=frame_mode,
                    generation_options=generation_options,
                    request_id=_request_id,
                )
                token.raise_if_cancelled()
                stored = note_storage.get_task(_task_id) or {}
                if stored.get("status") == "FAILED":
                    raise RuntimeError(stored.get("statusMessage") or "生成失败")

            return _runner

        record = manager.enqueue(
            JobSpec(
                task_id=task_id,
                kind=JobKind.BATCH_ITEM,
                title=title,
                model_name=model_name,
                provider_id=provider_id,
                batch_id=batch_id,
            ),
            _make_runner(),
            on_cancel=lambda tid=task_id, rid=request_id: note_storage.request_cancellation(tid, rid),
        )
        enqueued.append(
            {
                "task_id": task_id,
                "job_id": record.job_id,
                "title": title,
                "url": url,
                "platform": platform,
            }
        )

    return {
        "batch_id": batch_id,
        "folder": target_folder,
        "enqueued": enqueued,
        "skipped": skipped,
    }
