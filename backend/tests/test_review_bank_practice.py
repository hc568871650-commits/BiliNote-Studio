"""Task 10: 错题重练、避坑掌握状态流转与锚点元数据测试。"""
from __future__ import annotations

from contextlib import asynccontextmanager
import json
import sys
from pathlib import Path

from fastapi.testclient import TestClient

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app import create_app
from app.services import note_storage


@asynccontextmanager
async def _noop_lifespan(_app):
    yield


def _seed_structured_note(root: Path, task_id: str) -> None:
    folder = root / f"演示笔记__{task_id}"
    (folder / "_meta").mkdir(parents=True, exist_ok=True)
    (folder / "versions").mkdir(parents=True, exist_ok=True)
    structured = {
        "schema_version": 1,
        "note_style": "knowledge",
        "title": "数据库连接池调优",
        "sections": [
            {
                "id": "sec-pool",
                "title": "核心参数与上限公式",
                "level": 2,
                "time_ranges": [{"start": 728, "end": 760, "label": "12:08"}],
                "core_takeaways": [],
                "blocks": [],
                "annotations": [
                    {
                        "id": "pit-lifetime",
                        "kind": "pit",
                        "short_hint": "maxLifetime 必须短于 wait_timeout",
                        "full_detail": "至少比数据库服务端 wait_timeout 短 60 秒，避免半开连接报错。",
                        "timestamp": 2055,
                        "timestamp_label": "34:15",
                    }
                ],
                "quiz": {
                    "short_prompt": "8 核机器连接数应设多少？",
                    "full_question": "8 核 CPU 的 OLTP 服务，连接池上限优先设在哪个区间？",
                    "options": [
                        {"key": "A", "text": "200 左右"},
                        {"key": "B", "text": "16~20 左右"},
                        {"key": "C", "text": "越多越好"},
                    ],
                    "correct_key": "B",
                    "explanation": "按 CPU 核数 × 2 + 1 估算，过多会引发上下文切换雪崩。",
                },
            }
        ],
    }
    manifest = {
        "schema_version": 2,
        "task": {
            "id": task_id,
            "status": "SUCCESS",
            "createdAt": "2026-11-20T10:00:00Z",
            "archived_at": None,
            "audioMeta": {"title": "数据库连接池调优"},
            "markdown": [
                {
                    "ver_id": "v1",
                    "content": "# 数据库连接池调优",
                    "structured": structured,
                    "style": "knowledge",
                    "model_name": "gpt-5.4",
                }
            ],
        },
    }
    (folder / "_meta" / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")


def test_review_bank_practice_and_mastery_flow(tmp_path, monkeypatch):
    monkeypatch.setattr(note_storage, "ROOT", tmp_path)
    task_id = "task-review-demo-1"
    _seed_structured_note(tmp_path, task_id)

    app = create_app(_noop_lifespan)
    client = TestClient(app)

    # 1. 先记录一次答错（兼容 picked_key 字段）
    save_resp = client.put(
        f"/api/learning/notes/{task_id}/state",
        json={
            "quiz_attempts": {
                "sec-pool": {
                    "picked_key": "A",
                    "correct_key": "B",
                    "is_correct": False,
                }
            }
        },
    )
    assert save_resp.status_code == 200
    assert save_resp.json()["code"] == 0

    # 2. 待复习池中应出现该错题与避坑条目，并包含完整锚点元数据
    pending_resp = client.get("/api/learning/review-bank?status=pending")
    assert pending_resp.status_code == 200
    pending_data = pending_resp.json()["data"]
    assert len(pending_data["wrong_quizzes"]) == 1
    assert len(pending_data["pit_annotations"]) == 1
    quiz_item = pending_data["wrong_quizzes"][0]
    assert quiz_item["section_id"] == "sec-pool"
    assert quiz_item["quiz_id"] == "sec-pool"
    assert quiz_item["mastered"] is False
    assert len(quiz_item["options"]) == 3

    pit_item = pending_data["pit_annotations"][0]
    assert pit_item["section_id"] == "sec-pool"
    assert pit_item["annotation_id"] == "pit-lifetime"
    assert pit_item["mastered"] is False

    # 3. 原位重练答对并标为已掌握
    practice_resp = client.post(
        "/api/learning/review-bank/practice",
        json={
            "task_id": task_id,
            "section_id": "sec-pool",
            "selected_key": "B",
            "mastered": True,
        },
    )
    assert practice_resp.status_code == 200
    practice_data = practice_resp.json()["data"]
    assert practice_data["is_correct"] is True
    assert practice_data["mastered"] is True
    assert practice_data["review_count"] >= 1

    # 4. 避坑项标为已掌握
    pit_resp = client.post(
        "/api/learning/review-bank/pit-status",
        json={
            "task_id": task_id,
            "section_id": "sec-pool",
            "annotation_id": "pit-lifetime",
            "mastered": True,
        },
    )
    assert pit_resp.status_code == 200
    assert pit_resp.json()["data"]["mastered"] is True

    # 5. 待复习池清零，已掌握池出现 2 项
    pending_after = client.get("/api/learning/review-bank?status=pending").json()["data"]
    assert len(pending_after["wrong_quizzes"]) == 0
    assert len(pending_after["pit_annotations"]) == 0

    mastered_after = client.get("/api/learning/review-bank?status=mastered").json()["data"]
    assert len(mastered_after["wrong_quizzes"]) == 1
    assert len(mastered_after["pit_annotations"]) == 1
    assert mastered_after["wrong_quizzes"][0]["mastered"] is True
    assert mastered_after["pit_annotations"][0]["mastered"] is True
