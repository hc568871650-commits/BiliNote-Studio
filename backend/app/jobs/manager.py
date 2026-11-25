"""统一蒸馏任务队列管理器。

职责：
1. 管理有并发上限的任务执行（默认并发 2，支持环境变量 BILINOTE_JOB_CONCURRENCY）；
2. 支持排队取消、运行中协作取消与失败/取消后单项重试；
3. 支持外部既有任务（如 generate_note / upgrade-structured）桥接追踪，实时推送 SSE；
4. 轻量持久化近期状态至 data/jobs_state.json，不改动既有 bili_note.db 表结构。
"""

from __future__ import annotations

from collections import deque
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import threading
import uuid
from typing import Any, Callable

from app.core.runtime import get_runtime
from app.jobs.events import JobEventBus
from app.jobs.models import (
    ACTIVE_JOB_STATUSES,
    STAGE_DEFAULT_PROGRESS,
    TERMINAL_JOB_STATUSES,
    CancellationToken,
    JobCancelledError,
    JobKind,
    JobRecord,
    JobSnapshot,
    JobSpec,
    JobStatus,
    utc_now_iso,
)
from app.utils.logger import get_logger

logger = get_logger(__name__)

ProgressUpdater = Callable[..., None]
JobRunner = Callable[[JobRecord, CancellationToken, ProgressUpdater], Any]

_MAX_RECENT_JOBS = 50


def _coerce_status(raw: JobStatus | str) -> JobStatus:
    if isinstance(raw, JobStatus):
        return raw
    text = str(raw or "").strip().upper()
    aliases = {
        "PENDING": JobStatus.QUEUED,
        "QUEUE": JobStatus.QUEUED,
        "QUEUED": JobStatus.QUEUED,
        "PARSING": JobStatus.PARSING,
        "DOWNLOADING": JobStatus.DOWNLOADING,
        "TRANSCRIBING": JobStatus.TRANSCRIBING,
        "SUMMARIZING": JobStatus.SUMMARIZING,
        "FORMATTING": JobStatus.FORMATTING,
        "SAVING": JobStatus.SAVING,
        "SUCCESS": JobStatus.SUCCESS,
        "FAILED": JobStatus.FAILED,
        "CANCELLED": JobStatus.CANCELLED,
    }
    return aliases.get(text, JobStatus.SUMMARIZING)


class _QueuedEntry:
    def __init__(
        self,
        record: JobRecord,
        spec: JobSpec,
        runner: JobRunner | None,
        token: CancellationToken,
        on_cancel: Callable[[], None] | None = None,
    ) -> None:
        self.record = record
        self.spec = spec
        self.runner = runner
        self.token = token
        self.on_cancel = on_cancel


class JobManager:
    def __init__(
        self,
        *,
        max_concurrency: int | None = None,
        state_file: Path | None = None,
    ) -> None:
        raw_conc = max_concurrency or int(os.getenv("BILINOTE_JOB_CONCURRENCY", "2"))
        self._max_concurrency = max(1, raw_conc)
        self._state_file = state_file or (get_runtime().data_dir / "jobs_state.json")
        self._lock = threading.RLock()
        self._entries: dict[str, _QueuedEntry] = {}
        self._task_to_active_job: dict[str, str] = {}
        self._pending_queue: deque[str] = deque()
        self._running_ids: set[str] = set()
        self._pool = ThreadPoolExecutor(max_workers=self._max_concurrency, thread_name_prefix="bilinote-job")
        self.event_bus = JobEventBus()
        self._load_state()

    # ---------------- 持久化与启动恢复 ----------------

    def _load_state(self) -> None:
        if not self._state_file.is_file():
            return
        try:
            raw = json.loads(self._state_file.read_text(encoding="utf-8"))
        except Exception:
            return
        items = raw.get("jobs") if isinstance(raw, dict) else None
        if not isinstance(items, list):
            return
        changed = False
        for item in items[-_MAX_RECENT_JOBS:]:
            if not isinstance(item, dict) or not item.get("job_id"):
                continue
            record = JobRecord.from_dict(item)
            if record.status in ACTIVE_JOB_STATUSES:
                # 进程重启后，上次遗留的活跃任务自动收敛为可重试失败态
                record.status = JobStatus.FAILED
                record.progress = 100
                record.stage_message = "上次运行已中断，可重试"
                record.error_summary = record.error_summary or "服务重启导致任务中断"
                record.finished_at = record.finished_at or utc_now_iso()
                record.updated_at = utc_now_iso()
                changed = True
            spec = JobSpec(
                task_id=record.task_id,
                kind=record.kind,
                title=record.title,
                model_name=record.model_name,
                provider_id=record.provider_id,
                batch_id=record.batch_id,
            )
            self._entries[record.job_id] = _QueuedEntry(record, spec, None, CancellationToken())
        if changed:
            self._persist_state_locked()

    def _persist_state_locked(self) -> None:
        try:
            self._state_file.parent.mkdir(parents=True, exist_ok=True)
            records = self._ordered_records_locked()
            active = [r.to_public_dict() for r in records if r.is_active]
            recent = [r.to_public_dict() for r in records if not r.is_active][:_MAX_RECENT_JOBS]
            payload = {"schema_version": 1, "jobs": active + recent}
            tmp = self._state_file.with_suffix(".tmp")
            tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
            tmp.replace(self._state_file)
        except Exception as exc:
            logger.debug("保存任务队列状态失败（不影响运行）: %s", exc)

    def _ordered_records_locked(self) -> list[JobRecord]:
        return sorted(
            (entry.record for entry in self._entries.values()),
            key=lambda r: r.created_at,
            reverse=True,
        )

    def _active_count_locked(self) -> int:
        return sum(1 for entry in self._entries.values() if entry.record.is_active)

    def _prune_recent_locked(self) -> None:
        terminals = [
            entry.record
            for entry in self._entries.values()
            if not entry.record.is_active
        ]
        if len(terminals) <= _MAX_RECENT_JOBS:
            return
        terminals.sort(key=lambda r: r.finished_at or r.updated_at, reverse=True)
        for obsolete in terminals[_MAX_RECENT_JOBS:]:
            self._entries.pop(obsolete.job_id, None)

    # ---------------- 核心队列调度 ----------------

    def enqueue(
        self,
        spec: JobSpec,
        runner: JobRunner,
        *,
        job_id: str | None = None,
        on_cancel: Callable[[], None] | None = None,
    ) -> JobRecord:
        jid = job_id or uuid.uuid4().hex
        record = JobRecord(
            job_id=jid,
            task_id=spec.task_id,
            kind=spec.kind,
            title=spec.title or spec.task_id,
            status=JobStatus.QUEUED,
            progress=STAGE_DEFAULT_PROGRESS[JobStatus.QUEUED],
            stage_message="排队等待中",
            model_name=spec.model_name,
            provider_id=spec.provider_id,
            batch_id=spec.batch_id,
            retryable=True,
        )
        token = CancellationToken()
        entry = _QueuedEntry(record, spec, runner, token, on_cancel=on_cancel)
        with self._lock:
            self._entries[jid] = entry
            self._task_to_active_job[spec.task_id] = jid
            self._pending_queue.append(jid)
            self._persist_state_locked()
            public = record.to_public_dict()
            active_count = self._active_count_locked()
        self.event_bus.publish("job.updated", {"job": public, "active_count": active_count})
        self._dispatch_locked_wrapper()
        return record

    def register_external_job(
        self,
        spec: JobSpec,
        *,
        job_id: str | None = None,
        on_cancel: Callable[[], None] | None = None,
        retry_runner: JobRunner | None = None,
    ) -> JobRecord:
        """为既有外部执行流（如 FastAPI BackgroundTasks）注册追踪记录。"""
        jid = job_id or uuid.uuid4().hex
        record = JobRecord(
            job_id=jid,
            task_id=spec.task_id,
            kind=spec.kind,
            title=spec.title or spec.task_id,
            status=JobStatus.QUEUED,
            progress=STAGE_DEFAULT_PROGRESS[JobStatus.QUEUED],
            stage_message="已入队，等待执行",
            model_name=spec.model_name,
            provider_id=spec.provider_id,
            batch_id=spec.batch_id,
            retryable=callable(retry_runner),
        )
        entry = _QueuedEntry(record, spec, retry_runner, CancellationToken(), on_cancel=on_cancel)
        with self._lock:
            self._entries[jid] = entry
            self._task_to_active_job[spec.task_id] = jid
            self._persist_state_locked()
            public = record.to_public_dict()
            active_count = self._active_count_locked()
        self.event_bus.publish("job.updated", {"job": public, "active_count": active_count})
        return record

    def _dispatch_locked_wrapper(self) -> None:
        to_start: list[str] = []
        with self._lock:
            while len(self._running_ids) < self._max_concurrency and self._pending_queue:
                jid = self._pending_queue.popleft()
                entry = self._entries.get(jid)
                if entry is None or not entry.record.is_active or entry.token.is_cancelled:
                    continue
                self._running_ids.add(jid)
                entry.record.started_at = entry.record.started_at or utc_now_iso()
                entry.record.status = JobStatus.PARSING
                entry.record.progress = STAGE_DEFAULT_PROGRESS[JobStatus.PARSING]
                entry.record.stage_message = "正在启动任务"
                entry.record.updated_at = utc_now_iso()
                self._persist_state_locked()
                to_start.append(jid)
                self.event_bus.publish(
                    "job.updated",
                    {"job": entry.record.to_public_dict(), "active_count": self._active_count_locked()},
                )
        for jid in to_start:
            self._pool.submit(self._execute_entry, jid)

    def _execute_entry(self, job_id: str) -> None:
        with self._lock:
            entry = self._entries.get(job_id)
        if entry is None or entry.runner is None:
            return

        def _updater(
            *,
            status: JobStatus | str | None = None,
            progress: int | None = None,
            stage_message: str | None = None,
            title: str | None = None,
        ) -> None:
            self.update_job(
                job_id,
                status=status,
                progress=progress,
                stage_message=stage_message,
                title=title,
            )

        try:
            entry.token.raise_if_cancelled()
            entry.runner(entry.record, entry.token, _updater)
            entry.token.raise_if_cancelled()
            self.complete_job(job_id)
        except Exception as exc:
            if isinstance(exc, JobCancelledError) or getattr(exc, "cancelled", False) or entry.token.is_cancelled:
                self.mark_cancelled(job_id, message=str(exc) or "任务已取消")
            else:
                self.fail_job(job_id, error_summary=str(exc) or exc.__class__.__name__)
        finally:
            with self._lock:
                self._running_ids.discard(job_id)
            self._dispatch_locked_wrapper()

    # ---------------- 状态更新与终态收敛 ----------------

    def update_job(
        self,
        job_id: str,
        *,
        status: JobStatus | str | None = None,
        progress: int | None = None,
        stage_message: str | None = None,
        title: str | None = None,
    ) -> JobRecord | None:
        with self._lock:
            entry = self._entries.get(job_id)
            if entry is None or not entry.record.is_active:
                return None
            rec = entry.record
            if status is not None:
                coerced = _coerce_status(status)
                if coerced in TERMINAL_JOB_STATUSES:
                    # 终态应走 complete_job / fail_job / mark_cancelled
                    if coerced == JobStatus.SUCCESS:
                        return self.complete_job(job_id, stage_message=stage_message)
                    if coerced == JobStatus.CANCELLED:
                        return self.mark_cancelled(job_id, message=stage_message or "任务已取消")
                    return self.fail_job(job_id, error_summary=stage_message or "任务失败")
                rec.status = coerced
                if rec.started_at is None and coerced != JobStatus.QUEUED:
                    rec.started_at = utc_now_iso()
                if progress is None:
                    rec.progress = max(rec.progress, STAGE_DEFAULT_PROGRESS.get(coerced, rec.progress))
            if progress is not None:
                rec.progress = max(0, min(99, int(progress)))
            if stage_message is not None:
                rec.stage_message = stage_message
            if title:
                rec.title = title
            rec.updated_at = utc_now_iso()
            self._persist_state_locked()
            public = rec.to_public_dict()
            active_count = self._active_count_locked()
        self.event_bus.publish("job.updated", {"job": public, "active_count": active_count})
        return rec

    def sync_task_status(
        self,
        task_id: str,
        status: JobStatus | str,
        *,
        stage_message: str | None = None,
        title: str | None = None,
        cancelled: bool = False,
    ) -> JobRecord | None:
        """供 NoteGenerator._update_status 等既有代码按 task_id 同步当前活跃任务进度。"""
        with self._lock:
            job_id = self._task_to_active_job.get(task_id)
        if not job_id:
            return None
        if cancelled:
            return self.mark_cancelled(job_id, message=stage_message or "任务已取消")
        coerced = _coerce_status(status)
        if coerced == JobStatus.SUCCESS:
            return self.complete_job(job_id, stage_message=stage_message or "生成完成", title=title)
        if coerced == JobStatus.FAILED:
            return self.fail_job(job_id, error_summary=stage_message or "任务执行失败")
        if coerced == JobStatus.CANCELLED:
            return self.mark_cancelled(job_id, message=stage_message or "任务已取消")
        return self.update_job(job_id, status=coerced, stage_message=stage_message, title=title)

    def _finish_locked(
        self,
        job_id: str,
        *,
        final_status: JobStatus,
        event_name: str,
        stage_message: str,
        error_summary: str | None = None,
        title: str | None = None,
    ) -> tuple[JobRecord | None, dict[str, Any] | None, int, bool]:
        entry = self._entries.get(job_id)
        if entry is None:
            return None, None, self._active_count_locked(), False
        rec = entry.record
        if not rec.is_active:
            return rec, None, self._active_count_locked(), False
        prev_active = self._active_count_locked()
        rec.status = final_status
        rec.progress = 100
        rec.stage_message = stage_message
        rec.error_summary = error_summary
        if title:
            rec.title = title
        now = utc_now_iso()
        rec.finished_at = now
        rec.updated_at = now
        if self._task_to_active_job.get(rec.task_id) == job_id:
            self._task_to_active_job.pop(rec.task_id, None)
        try:
            self._pending_queue.remove(job_id)
        except ValueError:
            pass
        self._prune_recent_locked()
        self._persist_state_locked()
        new_active = self._active_count_locked()
        drained = prev_active > 0 and new_active == 0
        return rec, rec.to_public_dict(), new_active, drained

    def complete_job(self, job_id: str, *, stage_message: str = "生成完成", title: str | None = None) -> JobRecord | None:
        with self._lock:
            rec, public, active_count, drained = self._finish_locked(
                job_id,
                final_status=JobStatus.SUCCESS,
                event_name="job.completed",
                stage_message=stage_message,
                error_summary=None,
                title=title,
            )
        if public is not None:
            self.event_bus.publish("job.completed", {"job": public, "active_count": active_count})
            if drained:
                self.event_bus.publish("queue.drained", {"active_count": 0, "last_job": public})
        return rec

    def fail_job(self, job_id: str, *, error_summary: str) -> JobRecord | None:
        with self._lock:
            rec, public, active_count, drained = self._finish_locked(
                job_id,
                final_status=JobStatus.FAILED,
                event_name="job.failed",
                stage_message="执行失败",
                error_summary=error_summary,
            )
        if public is not None:
            self.event_bus.publish("job.failed", {"job": public, "active_count": active_count})
            if drained:
                self.event_bus.publish("queue.drained", {"active_count": 0, "last_job": public})
        return rec

    def mark_cancelled(self, job_id: str, *, message: str = "任务已取消") -> JobRecord | None:
        with self._lock:
            rec, public, active_count, drained = self._finish_locked(
                job_id,
                final_status=JobStatus.CANCELLED,
                event_name="job.cancelled",
                stage_message=message,
                error_summary=None,
            )
        if public is not None:
            self.event_bus.publish("job.cancelled", {"job": public, "active_count": active_count})
            if drained:
                self.event_bus.publish("queue.drained", {"active_count": 0, "last_job": public})
        return rec

    # ---------------- 用户控制操作 ----------------

    def cancel(self, job_id: str) -> bool:
        callback: Callable[[], None] | None = None
        cancelled_immediately = False
        with self._lock:
            entry = self._entries.get(job_id)
            if entry is None or not entry.record.is_active:
                return False
            entry.token.cancel("用户主动取消")
            callback = entry.on_cancel
            if job_id in self._pending_queue:
                try:
                    self._pending_queue.remove(job_id)
                except ValueError:
                    pass
                cancelled_immediately = True
            elif entry.runner is None and job_id not in self._running_ids:
                # 外部追踪任务：标记取消并触发外部回调
                cancelled_immediately = False
        if callable(callback):
            try:
                callback()
            except Exception as exc:
                logger.warning("执行任务取消回调失败 job_id=%s: %s", job_id, exc)
        if cancelled_immediately:
            self.mark_cancelled(job_id, message="已从队列取消")
        return True

    def _reset_note_storage_for_retry(self, task_id: str) -> None:
        """重试重新入队前重置 note_storage 终态，避免并发满排队期间读取到旧 FAILED 状态。"""
        if not task_id:
            return
        try:
            from app.services import note_storage

            note_storage.valid_id(task_id)
            has_stored_note = (
                note_storage.get_task(task_id) is not None
                or note_storage.status_path(task_id).is_file()
            )
            if not has_stored_note:
                return
            note_storage.clear_cancellation(task_id)
            note_storage.write_status(task_id, "PENDING", "已重新排队，等待执行")
        except Exception as exc:
            logger.debug("重试前同步重置 note_storage 状态失败 task_id=%s: %s", task_id, exc)

    def retry(self, job_id: str) -> JobRecord:
        with self._lock:
            entry = self._entries.get(job_id)
            if entry is None:
                raise KeyError("未找到指定任务")
            if entry.record.is_active:
                raise ValueError("任务正在运行，无需重复重试")
            if entry.runner is None:
                raise ValueError("该历史任务不支持队列直接重试，请在笔记详情中重新生成")
            spec = entry.spec
            runner = entry.runner
            on_cancel = entry.on_cancel
        self._reset_note_storage_for_retry(spec.task_id)
        return self.enqueue(spec, runner, on_cancel=on_cancel)

    def clear_finished(self) -> int:
        with self._lock:
            finished_ids = [jid for jid, entry in self._entries.items() if not entry.record.is_active]
            for jid in finished_ids:
                self._entries.pop(jid, None)
            self._persist_state_locked()
            snap = self.list_jobs().to_dict()
        if finished_ids:
            self.event_bus.publish("snapshot", snap)
        return len(finished_ids)

    # ---------------- 查询接口 ----------------

    def get_job(self, job_id: str) -> JobRecord | None:
        with self._lock:
            entry = self._entries.get(job_id)
            return entry.record if entry else None

    def get_active_job_for_task(self, task_id: str) -> JobRecord | None:
        with self._lock:
            jid = self._task_to_active_job.get(task_id)
            if not jid:
                return None
            entry = self._entries.get(jid)
            return entry.record if entry and entry.record.is_active else None

    def list_jobs(self) -> JobSnapshot:
        with self._lock:
            ordered = self._ordered_records_locked()
            active = [r.to_public_dict() for r in ordered if r.is_active]
            recent = [r.to_public_dict() for r in ordered if not r.is_active][:_MAX_RECENT_JOBS]
            return JobSnapshot(active=active, recent=recent, active_count=len(active))

    def shutdown(self, wait: bool = True) -> None:
        self._pool.shutdown(wait=wait)


_manager_lock = threading.Lock()
_manager_instance: JobManager | None = None


def get_job_manager() -> JobManager:
    global _manager_instance
    if _manager_instance is None:
        with _manager_lock:
            if _manager_instance is None:
                _manager_instance = JobManager()
    return _manager_instance


def set_job_manager(manager: JobManager) -> JobManager:
    global _manager_instance
    with _manager_lock:
        _manager_instance = manager
        return manager


def reset_job_manager() -> None:
    global _manager_instance
    with _manager_lock:
        _manager_instance = None
