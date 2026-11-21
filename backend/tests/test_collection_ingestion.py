"""Task 12: 多 P 合集 / 播放列表解析、去重标记、自动归文件夹与批量入队测试。"""
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
from app.services import note_folders, note_storage


@asynccontextmanager
async def _noop_lifespan(_app):
    yield


def _seed_existing_note(root: Path, task_id: str, video_url: str, video_id: str, title: str) -> None:
    folder = root / f"{title}__{task_id}"
    (folder / "_meta").mkdir(parents=True, exist_ok=True)
    (folder / "versions").mkdir(parents=True, exist_ok=True)
    manifest = {
        "schema_version": 2,
        "task": {
            "id": task_id,
            "status": "SUCCESS",
            "createdAt": "2026-11-20T10:00:00Z",
            "archived_at": None,
            "formData": {"video_url": video_url, "platform": "bilibili"},
            "audioMeta": {"title": title, "video_id": video_id, "platform": "bilibili"},
            "markdown": [{"ver_id": "v1", "content": "# 已存在笔记"}],
        },
        "versions": {"v1": "versions/v1.md"},
    }
    (folder / "versions" / "v1.md").write_text("# 已存在笔记", encoding="utf-8")
    (folder / "_meta" / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")


def test_resolve_collection_marks_duplicates_and_normalizes_urls(tmp_path, monkeypatch):
    from app.domains.ingestion.collection import resolve_collection

    notes_root = tmp_path / "note_results"
    notes_root.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(note_storage, "ROOT", notes_root)
    _seed_existing_note(
        notes_root,
        "existing-p1",
        "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
        "BV1xx411c7mD_p1",
        "第一讲：系统架构总览",
    )

    def _stub_extractor(url: str) -> dict:
        assert "BV1xx411c7mD" in url
        return {
            "title": "分布式系统实战全套课",
            "webpage_url": "https://www.bilibili.com/video/BV1xx411c7mD",
            "entries": [
                {
                    "id": "BV1xx411c7mD_p1",
                    "title": "P1 第一讲：系统架构总览",
                    "url": "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
                    "duration": 620,
                },
                {
                    "id": "BV1xx411c7mD_p2",
                    "title": "P2 第二讲：一致性哈希与分片",
                    "url": "https://www.bilibili.com/video/BV1xx411c7mD?p=2",
                    "duration": 845,
                },
                {
                    "id": "BV1xx411c7mD_p3",
                    "title": "P3 第三讲：高可用与熔断降级",
                    "url": "https://www.bilibili.com/video/BV1xx411c7mD?p=3",
                    "duration": 730,
                },
            ],
        }

    result = resolve_collection(
        "https://www.bilibili.com/video/BV1xx411c7mD",
        extractor=_stub_extractor,
    )
    assert result["is_collection"] is True
    assert result["collection_title"] == "分布式系统实战全套课"
    assert result["platform"] == "bilibili"
    assert result["total_count"] == 3
    assert result["items"][0]["already_exists"] is True
    assert result["items"][0]["existing_task_id"] == "existing-p1"
    assert result["items"][1]["already_exists"] is False
    assert result["items"][1]["existing_task_id"] is None
    assert result["items"][2]["duration"] == 730


def test_enqueue_batch_creates_folder_assigns_tasks_and_runs_queue(tmp_path, monkeypatch):
    from app.domains.ingestion import collection as collection_mod

    notes_root = tmp_path / "note_results"
    notes_root.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(note_storage, "ROOT", notes_root)
    monkeypatch.setattr(note_folders, "STATE_PATH", tmp_path / "data" / "note_folders.json")

    manager = JobManager(max_concurrency=2, state_file=tmp_path / "jobs_state.json")
    set_job_manager(manager)

    executed: list[tuple[str, str]] = []

    def _fake_note_runner(**kwargs):
        executed.append((kwargs["task_id"], kwargs["video_url"]))
        note_storage.save_task({
            "id": kwargs["task_id"],
            "status": "SUCCESS",
            "audioMeta": {"title": kwargs.get("title") or kwargs["task_id"]},
            "markdown": [{"ver_id": "v1", "content": f"# {kwargs['video_url']}"}],
        })

    monkeypatch.setattr(collection_mod, "_run_single_batch_item", _fake_note_runner)

    try:
        app = create_app(_noop_lifespan)
        client = TestClient(app)

        resp = client.post(
            "/api/ingestion/enqueue-batch",
            json={
                "items": [
                    {
                        "title": "P2 一致性哈希",
                        "url": "https://www.bilibili.com/video/BV1xx411c7mD?p=2",
                        "platform": "bilibili",
                    },
                    {
                        "title": "P3 熔断降级",
                        "url": "https://www.bilibili.com/video/BV1xx411c7mD?p=3",
                        "platform": "bilibili",
                    },
                ],
                "model_name": "gpt-5.4",
                "provider_id": "openai-default",
                "style": "knowledge",
                "quality": "medium",
                "create_folder": True,
                "folder_name": "分布式系统实战全套课",
            },
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["code"] == 0
        data = body["data"]
        assert data["batch_id"].startswith("batch-")
        assert len(data["enqueued"]) == 2
        assert data["folder"]["name"] == "分布式系统实战全套课"

        # 等待队列执行完成
        deadline = time.time() + 5.0
        while time.time() < deadline:
            snap = manager.list_jobs()
            if snap.active_count == 0 and len(snap.recent) >= 2:
                break
            time.sleep(0.05)

        assert len(executed) == 2
        folders_state = note_folders.list_folders()
        target_folder_id = data["folder"]["id"]
        for item in data["enqueued"]:
            assert folders_state["assignments"].get(item["task_id"]) == target_folder_id

        # 再次使用同名文件夹应复用而不报错
        resp2 = client.post(
            "/api/ingestion/enqueue-batch",
            json={
                "items": [
                    {
                        "title": "P4 分布式锁",
                        "url": "https://www.bilibili.com/video/BV1xx411c7mD?p=4",
                        "platform": "bilibili",
                    }
                ],
                "model_name": "gpt-5.4",
                "provider_id": "openai-default",
                "create_folder": True,
                "folder_name": "分布式系统实战全套课",
            },
        )
        assert resp2.status_code == 200
        assert resp2.json()["data"]["folder"]["id"] == target_folder_id
    finally:
        manager.shutdown(wait=True)
        reset_job_manager()
