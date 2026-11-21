"""One-click upgrade of legacy notes to structured Schema v1 using cached transcripts."""
from __future__ import annotations

import json
import math
import uuid
from datetime import datetime, timezone
from typing import Any

from app.gpt.prompt_builder import normalize_note_style
from app.models.generation_options import GenerationOptions
from app.models.gpt_model import GPTSource
from app.models.structured_note import extract_structured_note_json, serialize_structured_note_to_markdown
from app.models.transcriber_model import TranscriptSegment
from app.services import note_storage as notes
from app.services.ai_client import close_client, get_client


def load_cached_transcript(task_id: str, task: dict[str, Any] | None = None) -> list[TranscriptSegment]:
    task_obj = task if task is not None else notes.get_task(task_id)
    raw_transcript = (task_obj or {}).get("transcript") or {}
    raw_segments = raw_transcript.get("segments") if isinstance(raw_transcript, dict) else None

    if not raw_segments:
        cache_path = notes.cache_path(task_id, "transcript")
        if cache_path.is_file():
            try:
                cached = json.loads(cache_path.read_text(encoding="utf-8"))
                raw_segments = cached.get("segments") if isinstance(cached, dict) else None
            except (OSError, ValueError):
                raw_segments = None

    segments: list[TranscriptSegment] = []
    for item in raw_segments or []:
        if not isinstance(item, dict):
            continue
        try:
            start = float(item["start"])
            end = float(item["end"])
            text = str(item["text"]).strip()
            if text and math.isfinite(start) and math.isfinite(end) and 0 <= start <= end:
                segments.append(TranscriptSegment(start=start, end=end, text=text))
        except (KeyError, TypeError, ValueError):
            continue

    if not segments:
        versions = (task_obj or {}).get("markdown") if isinstance((task_obj or {}).get("markdown"), list) else []
        latest_md = str((versions[0] or {}).get("content") or "").strip() if versions and isinstance(versions[0], dict) else ""
        if latest_md:
            paragraphs = [part.strip() for part in latest_md.split("\n\n") if part.strip()]
            return [TranscriptSegment(start=0.0, end=0.0, text=part) for part in paragraphs]
        raise ValueError("该笔记缺少可用的缓存转写字幕或历史正文，无法升级结构化版本")
    return sorted(segments, key=lambda s: s.start)


def upgrade_note_to_structured(
    task_id: str,
    *,
    provider_id: str,
    model_name: str,
    protocol: str | None = None,
    style: str | None = None,
    extras: str | None = None,
    generation_options: GenerationOptions | dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Re-distill an existing note into a new structured Schema v1 version while preserving all old versions."""
    notes.valid_id(task_id)
    task = notes.get_task(task_id)
    if not task or task.get("archived_at"):
        raise ValueError("笔记不存在或已归档，请先恢复后再升级")

    segments = load_cached_transcript(task_id, task)
    versions = task.get("markdown") if isinstance(task.get("markdown"), list) else []
    latest = versions[0] if versions and isinstance(versions[0], dict) else {}
    form_data = task.get("formData") or {}
    audio_meta = task.get("audioMeta") or {}

    resolved_style = normalize_note_style(style or latest.get("style") or form_data.get("style") or "tutorial")
    resolved_extras = extras if extras is not None else (form_data.get("extras") or "")
    title = str(audio_meta.get("title") or task_id)
    platform = str(audio_meta.get("platform") or form_data.get("platform") or "")
    video_id = str(audio_meta.get("video_id") or "")
    source_url = str(form_data.get("video_url") or "")

    source = GPTSource(
        title=title,
        segment=segments,
        tags="",
        style=resolved_style,
        extras=resolved_extras,
        _format=["link"],
        checkpoint_key=None,
        structured=True,
    )

    gpt = get_client(provider_id, model_name, protocol)
    try:
        if generation_options is not None and hasattr(gpt, "configure_generation"):
            opts = (
                generation_options
                if isinstance(generation_options, GenerationOptions)
                else GenerationOptions.model_validate(generation_options)
            )
            gpt.configure_generation(opts)
        raw_output = gpt.summarize(source)
    finally:
        close_client(gpt.client)

    structured_doc = extract_structured_note_json(
        raw_output,
        fallback_title=title,
        default_style=resolved_style,
        source_url=source_url,
        platform=platform,
        video_id=video_id,
    )
    if structured_doc is None:
        raise ValueError("模型未返回有效的结构化笔记内容，原笔记未修改")

    markdown_text = serialize_structured_note_to_markdown(structured_doc)
    new_ver_id = uuid.uuid4().hex
    ver: dict[str, Any] = {
        "ver_id": new_ver_id,
        "content": markdown_text,
        "structured": structured_doc,
        "style": resolved_style,
        "model_name": model_name,
        "provider_id": provider_id,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "upgraded_from_version": latest.get("ver_id") or None,
    }
    if protocol:
        ver["protocol"] = protocol

    updated_task = notes.save_task({"id": task_id, "status": "SUCCESS", "markdown": [ver]})
    try:
        from app.services.vector_store import VectorStoreManager
        VectorStoreManager().index_task(task_id)
    except Exception:
        pass
    return updated_task
