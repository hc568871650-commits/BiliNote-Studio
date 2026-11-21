"""Task 14: 旧版 Markdown 笔记批量结构化升级过滤与单任务失败隔离测试。"""
from __future__ import annotations

from contextlib import asynccontextmanager
import json
import sys
import time
from pathlib import Path

from fastapi.testclient import TestClient

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app import create_app
from app.jobs.manager import JobManager, reset_job_manager, set_job_manager
from app.services import note_storage


@asynccontextmanager
async def _noop_lifespan(_app):
    yield


def _seed_note(
    root: Path,
    task_id: str,
    *,
    title: str,
    content: str = "",
    structured: dict | None = None,
    has_transcript: bool = True,
) -> None:
    folder = root / f"{title}__{task_id}"
    (folder / "_meta").mkdir(parents=True, exist_ok=True)
    (folder / "versions").mkdir(parents=True, exist_ok=True)
    ver: dict = {"ver_id": "v1", "content": content}
    if structured is not None:
        ver["structured"] = structured
    task: dict = {
        "id": task_id,
        "status": "SUCCESS",
        "createdAt": "2026-11-20T10:00:00Z",
        "archived_at": None,
        "audioMeta": {"title": title},
        "markdown": [ver] if (content or structured) else [],
    }
    if has_transcript:
        task["transcript"] = {
            "language": "zh",
            "full_text": "这是一段示例转写文本",
            "segments": [{"start": 0.0, "end": 5.0, "text": "这是一段示例转写文本"}],
        }
    manifest = {
        "schema_version": 2,
        "task": task,
        "versions": {"v1": "versions/v1.md"} if (content or structured) else {},
    }
    if content or structured:
        (folder / "versions" / "v1.md").write_text(content or "# 结构化", encoding="utf-8")
    (folder / "_meta" / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")


def test_batch_upgrade_filters_structured_and_empty_and_isolates_failures(tmp_path, monkeypatch):
    from app.services import note_upgrade

    notes_root = tmp_path / "note_results"
    notes_root.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(note_storage, "ROOT", notes_root)

    # 1. 已结构化 -> 应跳过
    _seed_note(
        notes_root,
        "already-structured",
        title="已结构化笔记",
        content="# 已结构化",
        structured={"schema_version": 1, "sections": [{"id": "s1", "title": "章节"}]},
    )
    # 2. 无正文也无字幕 -> 应跳过
    _seed_note(
        notes_root,
        "empty-note",
        title="空白失败笔记",
        content="",
        structured=None,
        has_transcript=False,
    )
    # 3. 旧版 Markdown（成功升级）
    _seed_note(
        notes_root,
        "legacy-ok",
        title="旧版可升级笔记A",
        content="# 旧版笔记A\n核心知识点说明",
        structured=None,
    )
    # 4. 旧版 Markdown（模拟模型调用异常，验证不影响 legacy-ok）
    _seed_note(
        notes_root,
        "legacy-fail",
        title="旧版模拟失败笔记B",
        content="# 旧版笔记B\n将会失败",
        structured=None,
    )

    manager = JobManager(max_concurrency=2, state_file=tmp_path / "jobs_state.json")
    set_job_manager(manager)

    upgraded_ids: list[str] = []

    def _stub_upgrade(task_id: str, **_kwargs):
        if task_id == "legacy-fail":
            raise RuntimeError("模拟单篇模型超时")
        upgraded_ids.append(task_id)
        return {"id": task_id, "status": "SUCCESS"}

    monkeypatch.setattr(note_upgrade, "upgrade_note_to_structured", _stub_upgrade)

    try:
        app = create_app(_noop_lifespan)
        client = TestClient(app)

        resp = client.post(
            "/api/notes/batch-upgrade-structured",
            json={
                "task_ids": ["already-structured", "empty-note", "legacy-ok", "legacy-fail"],
                "provider_id": "openai-default",
                "model_name": "gpt-5.4",
            },
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["code"] == 0
        data = body["data"]
        assert data["batch_id"].startswith("upgrade-")
        enqueued_ids = [item["task_id"] for item in data["enqueued"]]
        skipped_map = {item["task_id"]: item["reason"] for item in data["skipped"]}

        assert set(enqueued_ids) == {"legacy-ok", "legacy-fail"}
        assert "already-structured" in skipped_map
        assert "empty-note" in skipped_map

        # 等待全部任务结束
        deadline = time.time() + 5.0
        while time.time() < deadline:
            snap = manager.list_jobs()
            if snap.active_count == 0 and len(snap.recent) >= 2:
                break
            time.sleep(0.05)

        assert upgraded_ids == ["legacy-ok"]
        jobs_by_task = {j["task_id"]: j for j in manager.list_jobs().recent}
        assert jobs_by_task["legacy-ok"]["status"] == "SUCCESS"
        assert jobs_by_task["legacy-fail"]["status"] == "FAILED"
        assert "超时" in (jobs_by_task["legacy-fail"]["error_summary"] or "")
    finally:
        manager.shutdown(wait=True)
        reset_job_manager()
