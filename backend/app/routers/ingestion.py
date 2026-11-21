"""课程级批量导入与旧版笔记批量结构化升级路由。"""

from __future__ import annotations

from typing import Literal, Optional
import uuid

from fastapi import APIRouter
from pydantic import BaseModel, Field

from app.domains.ingestion.collection import enqueue_batch_items, resolve_collection
from app.enums.note_enums import DownloadQuality
from app.jobs.manager import get_job_manager
from app.jobs.models import JobKind, JobSpec, JobStatus
from app.models.generation_options import GenerationOptions
from app.services import note_storage, note_upgrade
from app.utils.logger import get_logger
from app.utils.response import ResponseWrapper as R

logger = get_logger(__name__)

router = APIRouter(tags=["ingestion"])


class ResolveCollectionRequest(BaseModel):
    url: str = Field(min_length=1, max_length=2000)


class BatchItemPayload(BaseModel):
    title: str = Field(default="", max_length=200)
    url: str = Field(min_length=1, max_length=2000)
    platform: Optional[str] = None


class EnqueueBatchRequest(BaseModel):
    items: list[BatchItemPayload] = Field(min_length=1, max_length=200)
    model_name: str = Field(min_length=1, max_length=200)
    provider_id: str = Field(min_length=1, max_length=100)
    quality: DownloadQuality = DownloadQuality.medium
    style: str = "knowledge"
    format: Optional[list[str]] = Field(default_factory=lambda: ["link"])
    extras: Optional[str] = None
    screenshot: bool = False
    link: bool = True
    video_understanding: bool = False
    video_interval: int = 0
    grid_size: Optional[list[int]] = Field(default_factory=list)
    frame_mode: Literal["dynamic", "fixed"] = "dynamic"
    generation_options: Optional[GenerationOptions] = None
    create_folder: bool = False
    folder_name: Optional[str] = None
    folder_id: Optional[str] = None


class BatchUpgradeStructuredRequest(BaseModel):
    task_ids: list[str] = Field(min_length=1, max_length=200)
    provider_id: str = Field(min_length=1, max_length=100)
    model_name: str = Field(min_length=1, max_length=200)
    protocol: Optional[Literal["openai-chat", "openai-responses", "anthropic", "gemini"]] = None
    style: Optional[Literal["tutorial", "knowledge"]] = None
    extras: Optional[str] = None
    generation_options: Optional[GenerationOptions] = None


def _is_already_structured(task: dict) -> bool:
    versions = task.get("markdown") if isinstance(task.get("markdown"), list) else []
    if not versions or not isinstance(versions[0], dict):
        return False
    structured = versions[0].get("structured")
    return (
        isinstance(structured, dict)
        and structured.get("schema_version") == 1
        and isinstance(structured.get("sections"), list)
        and len(structured.get("sections")) > 0
    )


def _has_upgrade_source(task_id: str, task: dict) -> bool:
    try:
        segments = note_upgrade.load_cached_transcript(task_id, task)
        if segments:
            return True
    except Exception:
        pass
    versions = task.get("markdown") if isinstance(task.get("markdown"), list) else []
    if versions and isinstance(versions[0], dict):
        content = str(versions[0].get("content") or "").strip()
        if content:
            return True
    return False


@router.post("/ingestion/resolve-collection")
def resolve_collection_endpoint(data: ResolveCollectionRequest):
    try:
        result = resolve_collection(data.url)
        return R.success(result)
    except ValueError as exc:
        return R.error(str(exc), code=400)
    except Exception as exc:
        logger.warning("合集解析失败 url=%s: %s", data.url, exc)
        return R.error(f"合集解析失败：{exc}", code=502)


@router.post("/ingestion/enqueue-batch")
def enqueue_batch_endpoint(data: EnqueueBatchRequest):
    try:
        result = enqueue_batch_items(
            items=[item.model_dump() for item in data.items],
            model_name=data.model_name,
            provider_id=data.provider_id,
            quality=data.quality,
            style=data.style,
            formats=data.format,
            extras=data.extras,
            screenshot=data.screenshot,
            link=data.link,
            video_understanding=data.video_understanding,
            video_interval=data.video_interval,
            grid_size=data.grid_size,
            frame_mode=data.frame_mode,
            generation_options=data.generation_options,
            create_folder=data.create_folder,
            folder_name=data.folder_name,
            folder_id=data.folder_id,
        )
        return R.success(result)
    except ValueError as exc:
        return R.error(str(exc), code=400)
    except Exception as exc:
        logger.exception("批量入队失败: %s", exc)
        return R.error(f"批量入队失败：{exc}", code=500)


@router.post("/notes/batch-upgrade-structured")
def batch_upgrade_structured_endpoint(data: BatchUpgradeStructuredRequest):
    manager = get_job_manager()
    batch_id = f"upgrade-{uuid.uuid4().hex[:12]}"
    enqueued: list[dict] = []
    skipped: list[dict] = []
    seen: set[str] = set()

    for raw_id in data.task_ids:
        task_id = str(raw_id or "").strip()
        if not task_id or task_id in seen:
            continue
        seen.add(task_id)
        try:
            note_storage.valid_id(task_id)
        except ValueError:
            skipped.append({"task_id": task_id, "reason": "无效的任务 ID"})
            continue

        task = note_storage.get_task(task_id)
        if not task or task.get("archived_at"):
            skipped.append({"task_id": task_id, "reason": "笔记不存在或已归档"})
            continue
        if _is_already_structured(task):
            skipped.append({"task_id": task_id, "reason": "已是结构化版本，已自动跳过"})
            continue
        if not _has_upgrade_source(task_id, task):
            skipped.append({"task_id": task_id, "reason": "缺少可用正文或字幕缓存，已跳过"})
            continue
        if manager.get_active_job_for_task(task_id) is not None:
            skipped.append({"task_id": task_id, "reason": "该笔记已在队列中"})
            continue

        title = str(((task.get("audioMeta") or {}).get("title")) or task_id)[:160]

        def _make_upgrade_runner(_task_id: str = task_id):
            def _runner(_record, token, updater):
                token.raise_if_cancelled()
                updater(status=JobStatus.SUMMARIZING, progress=42, stage_message="正在升级为结构化笔记")
                note_upgrade.upgrade_note_to_structured(
                    _task_id,
                    provider_id=data.provider_id,
                    model_name=data.model_name,
                    protocol=data.protocol,
                    style=data.style,
                    extras=data.extras,
                    generation_options=data.generation_options,
                )
                token.raise_if_cancelled()

            return _runner

        job = manager.enqueue(
            JobSpec(
                task_id=task_id,
                kind=JobKind.UPGRADE_STRUCTURED,
                title=title,
                model_name=data.model_name,
                provider_id=data.provider_id,
                batch_id=batch_id,
            ),
            _make_upgrade_runner(),
        )
        enqueued.append({"task_id": task_id, "job_id": job.job_id, "title": title})

    return R.success(
        {
            "batch_id": batch_id,
            "enqueued": enqueued,
            "skipped": skipped,
        }
    )
