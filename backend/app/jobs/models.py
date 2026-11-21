"""统一蒸馏队列任务数据模型与协作式取消令牌。"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
import threading
from typing import Any


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class JobStatus(str, Enum):
    QUEUED = "QUEUED"
    PARSING = "PARSING"
    DOWNLOADING = "DOWNLOADING"
    TRANSCRIBING = "TRANSCRIBING"
    SUMMARIZING = "SUMMARIZING"
    FORMATTING = "FORMATTING"
    SAVING = "SAVING"
    SUCCESS = "SUCCESS"
    FAILED = "FAILED"
    CANCELLED = "CANCELLED"


ACTIVE_JOB_STATUSES = frozenset({
    JobStatus.QUEUED,
    JobStatus.PARSING,
    JobStatus.DOWNLOADING,
    JobStatus.TRANSCRIBING,
    JobStatus.SUMMARIZING,
    JobStatus.FORMATTING,
    JobStatus.SAVING,
})

TERMINAL_JOB_STATUSES = frozenset({
    JobStatus.SUCCESS,
    JobStatus.FAILED,
    JobStatus.CANCELLED,
})

STAGE_DEFAULT_PROGRESS: dict[JobStatus, int] = {
    JobStatus.QUEUED: 2,
    JobStatus.PARSING: 10,
    JobStatus.DOWNLOADING: 25,
    JobStatus.TRANSCRIBING: 48,
    JobStatus.SUMMARIZING: 74,
    JobStatus.FORMATTING: 88,
    JobStatus.SAVING: 95,
    JobStatus.SUCCESS: 100,
    JobStatus.FAILED: 100,
    JobStatus.CANCELLED: 100,
}


class JobKind(str, Enum):
    GENERATE = "generate"
    REGENERATE = "regenerate"
    UPGRADE_STRUCTURED = "upgrade_structured"
    BATCH_ITEM = "batch_item"


class JobCancelledError(RuntimeError):
    """协作式取消异常，带有 cancelled=True 标识以兼容既有取消处理逻辑。"""

    def __init__(self, message: str = "任务已取消"):
        super().__init__(message)
        self.cancelled = True


class CancellationToken:
    """线程安全的协作式取消令牌。"""

    def __init__(self) -> None:
        self._event = threading.Event()
        self._reason: str = "任务已取消"

    def cancel(self, reason: str = "任务已取消") -> None:
        self._reason = reason or "任务已取消"
        self._event.set()

    @property
    def is_cancelled(self) -> bool:
        return self._event.is_set()

    def raise_if_cancelled(self) -> None:
        if self._event.is_set():
            raise JobCancelledError(self._reason)


@dataclass
class JobSpec:
    task_id: str
    kind: JobKind = JobKind.GENERATE
    title: str = ""
    model_name: str = ""
    provider_id: str = ""
    batch_id: str | None = None
    payload: dict[str, Any] = field(default_factory=dict)


@dataclass
class JobRecord:
    job_id: str
    task_id: str
    kind: JobKind
    title: str = ""
    status: JobStatus = JobStatus.QUEUED
    progress: int = 2
    stage_message: str = "等待开始"
    model_name: str = ""
    provider_id: str = ""
    batch_id: str | None = None
    created_at: str = field(default_factory=utc_now_iso)
    started_at: str | None = None
    finished_at: str | None = None
    updated_at: str = field(default_factory=utc_now_iso)
    error_summary: str | None = None
    retryable: bool = False

    @property
    def is_active(self) -> bool:
        return self.status in ACTIVE_JOB_STATUSES

    def to_public_dict(self) -> dict[str, Any]:
        return {
            "job_id": self.job_id,
            "task_id": self.task_id,
            "kind": self.kind.value if isinstance(self.kind, JobKind) else str(self.kind),
            "batch_id": self.batch_id,
            "title": self.title,
            "status": self.status.value if isinstance(self.status, JobStatus) else str(self.status),
            "progress": max(0, min(100, int(self.progress))),
            "stage_message": self.stage_message,
            "model_name": self.model_name,
            "provider_id": self.provider_id,
            "created_at": self.created_at,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "updated_at": self.updated_at,
            "error_summary": self.error_summary,
            "retryable": bool(self.retryable),
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "JobRecord":
        raw_kind = str(data.get("kind") or JobKind.GENERATE.value)
        try:
            kind = JobKind(raw_kind)
        except ValueError:
            kind = JobKind.GENERATE
        raw_status = str(data.get("status") or JobStatus.FAILED.value)
        try:
            status = JobStatus(raw_status)
        except ValueError:
            status = JobStatus.FAILED
        return cls(
            job_id=str(data.get("job_id") or ""),
            task_id=str(data.get("task_id") or ""),
            kind=kind,
            title=str(data.get("title") or ""),
            status=status,
            progress=int(data.get("progress") or 0),
            stage_message=str(data.get("stage_message") or ""),
            model_name=str(data.get("model_name") or ""),
            provider_id=str(data.get("provider_id") or ""),
            batch_id=data.get("batch_id"),
            created_at=str(data.get("created_at") or utc_now_iso()),
            started_at=data.get("started_at"),
            finished_at=data.get("finished_at"),
            updated_at=str(data.get("updated_at") or utc_now_iso()),
            error_summary=data.get("error_summary"),
            retryable=bool(data.get("retryable", False)),
        )


@dataclass
class JobSnapshot:
    active: list[dict[str, Any]]
    recent: list[dict[str, Any]]
    active_count: int

    def to_dict(self) -> dict[str, Any]:
        return {
            "active": self.active,
            "recent": self.recent,
            "active_count": self.active_count,
        }
