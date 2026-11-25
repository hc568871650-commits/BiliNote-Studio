"""测试后端统一任务队列（jobs/）并发控制、取消、重试与 SSE 实时事件流。"""

from __future__ import annotations

import json
import threading
import time
from pathlib import Path

from fastapi.testclient import TestClient


def _wait_until(predicate, timeout: float = 5.0, interval: float = 0.02) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(interval)
    return False


def test_job_manager_concurrency_queue_and_drained_event(tmp_path: Path):
    """验证并发度上限、有序排队、状态推进以及全部完成后触发 queue.drained。"""
    from app.jobs.manager import JobManager
    from app.jobs.models import JobKind, JobSpec, JobStatus

    manager = JobManager(max_concurrency=2, state_file=tmp_path / "jobs_state.json")
    events: list[tuple[str, dict]] = []
    sub_id, q = manager.event_bus.subscribe()

    running = 0
    peak_running = 0
    lock = threading.Lock()
    gate = threading.Event()

    def worker(record, token, update):
        nonlocal running, peak_running
        with lock:
            running += 1
            peak_running = max(peak_running, running)
        update(status=JobStatus.SUMMARIZING, progress=55, stage_message="模型整理中")
        gate.wait(timeout=3.0)
        token.raise_if_cancelled()
        with lock:
            running -= 1
        return {"ok": True}

    try:
        j1 = manager.enqueue(JobSpec(task_id="t1", kind=JobKind.GENERATE, title="任务1"), worker)
        j2 = manager.enqueue(JobSpec(task_id="t2", kind=JobKind.GENERATE, title="任务2"), worker)
        j3 = manager.enqueue(JobSpec(task_id="t3", kind=JobKind.GENERATE, title="任务3"), worker)

        assert _wait_until(lambda: peak_running == 2)
        snap = manager.list_jobs()
        assert snap.active_count == 3
        statuses = {item["job_id"]: item["status"] for item in snap.active}
        assert statuses[j3.job_id] == JobStatus.QUEUED.value

        gate.set()
        assert _wait_until(lambda: manager.list_jobs().active_count == 0)
        assert peak_running == 2

        while not q.empty():
            events.append(q.get_nowait())

        event_types = [etype for etype, _ in events]
        assert event_types.count("job.completed") == 3
        assert "queue.drained" in event_types
        final_snap = manager.list_jobs()
        assert final_snap.active_count == 0
        assert len(final_snap.recent) == 3
        assert {item["job_id"] for item in final_snap.recent} == {j1.job_id, j2.job_id, j3.job_id}
    finally:
        manager.event_bus.unsubscribe(sub_id)
        manager.shutdown()


def test_job_manager_cancel_queued_and_running_and_retry(tmp_path: Path):
    """验证取消排队中任务、取消执行中任务以及失败/取消后的单项重试。"""
    from app.jobs.manager import JobManager
    from app.jobs.models import JobKind, JobSpec, JobStatus

    manager = JobManager(max_concurrency=1, state_file=tmp_path / "jobs_state.json")
    started = threading.Event()
    release_first = threading.Event()

    def slow_worker(record, token, update):
        started.set()
        for _ in range(100):
            token.raise_if_cancelled()
            if release_first.wait(timeout=0.02):
                break
        token.raise_if_cancelled()
        return {"done": True}

    attempts = {"count": 0}

    def flaky_worker(record, token, update):
        attempts["count"] += 1
        if attempts["count"] == 1:
            raise RuntimeError("模拟网络波动")
        return {"recovered": True}

    try:
        j1 = manager.enqueue(JobSpec(task_id="r1", kind=JobKind.GENERATE, title="执行中任务"), slow_worker)
        assert started.wait(timeout=3.0)
        j2 = manager.enqueue(JobSpec(task_id="r2", kind=JobKind.GENERATE, title="排队中任务"), slow_worker)

        # 1) 取消排队中的任务
        assert manager.cancel(j2.job_id) is True
        assert manager.get_job(j2.job_id).status == JobStatus.CANCELLED
        # 重复取消返回 False 且计数不为负
        assert manager.cancel(j2.job_id) is False

        # 2) 取消正在执行的任务
        assert manager.cancel(j1.job_id) is True
        assert _wait_until(lambda: manager.list_jobs().active_count == 0)
        assert manager.get_job(j1.job_id).status == JobStatus.CANCELLED

        # 3) 失败任务支持单项重试
        j3 = manager.enqueue(JobSpec(task_id="r3", kind=JobKind.GENERATE, title="可重试任务"), flaky_worker)
        assert _wait_until(lambda: manager.get_job(j3.job_id).status == JobStatus.FAILED)
        retried = manager.retry(j3.job_id)
        assert retried.job_id != j3.job_id
        assert retried.task_id == "r3"
        assert _wait_until(lambda: manager.get_job(retried.job_id).status == JobStatus.SUCCESS)
        assert manager.list_jobs().active_count == 0
    finally:
        release_first.set()
        manager.shutdown()


def test_jobs_router_snapshot_and_sse_no_historical_replay(tmp_path: Path):
    """验证 /api/jobs 与 /api/jobs/events：历史终态仅在首包 snapshot 出现，不重放完成事件。"""
    from app import create_app
    from app.jobs.manager import JobManager, reset_job_manager, set_job_manager
    from app.jobs.models import JobKind, JobSpec, JobStatus

    manager = JobManager(max_concurrency=1, state_file=tmp_path / "jobs_state.json")
    try:
        j_old = manager.enqueue(
            JobSpec(task_id="old-1", kind=JobKind.GENERATE, title="历史已完成任务"),
            lambda rec, tok, upd: {"ok": True},
        )
        assert _wait_until(lambda: manager.get_job(j_old.job_id).status == JobStatus.SUCCESS)

        set_job_manager(manager)
        app = create_app(lifespan=None)
        client = TestClient(app)

        # REST 快照校验
        resp = client.get("/api/jobs")
        assert resp.status_code == 200
        body = resp.json()
        assert body["code"] == 0
        assert body["data"]["active_count"] == 0
        assert len(body["data"]["recent"]) == 1
        assert body["data"]["recent"][0]["job_id"] == j_old.job_id

        # SSE 首包校验（once=true 参数用于单帧同步验证，或读取首条事件）
        with client.stream("GET", "/api/jobs/events?once=1") as stream:
            assert stream.status_code == 200
            raw = "".join(stream.iter_text())

        assert "event: snapshot" in raw
        assert "event: job.completed" not in raw
        data_line = next(line for line in raw.splitlines() if line.startswith("data: "))
        snap_payload = json.loads(data_line.removeprefix("data: "))
        assert snap_payload["active_count"] == 0
        assert snap_payload["recent"][0]["job_id"] == j_old.job_id

        # 清空已完成校验
        clr = client.post("/api/jobs/clear-finished")
        assert clr.status_code == 200
        assert clr.json()["data"]["cleared"] == 1
        assert client.get("/api/jobs").json()["data"]["recent"] == []
    finally:
        reset_job_manager()
        manager.shutdown()


def test_job_manager_retry_resets_note_storage_status_while_queued(tmp_path: Path, monkeypatch):
    """验证并发满排队期间重试作业会先将 note_storage 状态重置为 PENDING，清空旧 FAILED 终态。"""
    from app.jobs.manager import JobManager
    from app.jobs.models import JobKind, JobSpec, JobStatus
    from app.services import note_storage

    notes_dir = tmp_path / "notes"
    monkeypatch.setattr(note_storage, "ROOT", notes_dir)

    task_id = "retry-queued-note"
    note_storage.save_task({
        "id": task_id,
        "status": "PENDING",
        "markdown": "",
        "audioMeta": {"title": "排队重试笔记", "video_id": "", "platform": "bilibili"},
        "transcript": {"full_text": "", "segments": []},
        "formData": {"video_url": "https://www.bilibili.com/video/BV1xx", "platform": "bilibili"},
    })
    note_storage.request_cancellation(task_id, "req-old")
    note_storage.write_status(task_id, "FAILED", "旧失败错误", cancelled=True)

    failed_snapshot = note_storage.get_task(task_id)
    assert failed_snapshot is not None
    assert failed_snapshot["status"] == "FAILED"
    assert failed_snapshot["cancelled"] is True
    assert failed_snapshot["finished_at"] is not None

    manager = JobManager(max_concurrency=1, state_file=tmp_path / "jobs_state.json")
    blocker_started = threading.Event()
    release_blocker = threading.Event()
    retry_attempts = {"count": 0}

    def blocking_worker(record, token, update):
        blocker_started.set()
        release_blocker.wait(timeout=3.0)
        return {"ok": True}

    def flaky_worker(record, token, update):
        retry_attempts["count"] += 1
        if retry_attempts["count"] == 1:
            raise RuntimeError("首次执行失败")
        return {"ok": True}

    try:
        j_fail = manager.enqueue(JobSpec(task_id=task_id, kind=JobKind.GENERATE, title="排队重试笔记"), flaky_worker)
        assert _wait_until(lambda: manager.get_job(j_fail.job_id).status == JobStatus.FAILED)

        # 占满唯一并发槽，使接下来的重试停留在 QUEUED 状态
        manager.enqueue(JobSpec(task_id="blocker-task", kind=JobKind.GENERATE, title="占位任务"), blocking_worker)
        assert blocker_started.wait(timeout=3.0)

        retried = manager.retry(j_fail.job_id)
        assert retried.status == JobStatus.QUEUED

        # 排队期间拉取 note_storage 不得再看到旧 FAILED / cancelled / finished_at
        queued_snapshot = note_storage.get_task(task_id)
        assert queued_snapshot is not None
        assert queued_snapshot["status"] == "PENDING"
        assert queued_snapshot["cancelled"] is False
        assert queued_snapshot["finished_at"] is None
        assert "旧失败错误" not in (queued_snapshot.get("statusMessage") or "")
        assert not note_storage.status_path(task_id).with_suffix(".cancel.json").exists()

        release_blocker.set()
        assert _wait_until(lambda: manager.get_job(retried.job_id).status == JobStatus.SUCCESS)
    finally:
        release_blocker.set()
        manager.shutdown()
