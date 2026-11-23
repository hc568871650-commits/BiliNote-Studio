"""Milestone 4C 单元测试：自建批注、轻量 SRS 复习调度、专题综合自测与库内相关笔记推荐。"""
from __future__ import annotations

import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from app import create_app
from app.services import learning_state, note_folders, note_library, note_storage, related_notes


def _make_structured_note(task_id: str, title: str, sec_id: str, sec_title: str, *, quiz_key: str = "A", pit_id: str = "p1") -> dict:
    structured = {
        "schema_version": 1,
        "title": title,
        "sections": [
            {
                "id": sec_id,
                "title": sec_title,
                "level": 2,
                "time_ranges": [{"start": 10, "end": 45, "label": "00:10"}],
                "core_takeaways": [
                    {"spans": [{"text": f"{sec_title} 核心结论", "emphasis": "hl", "annotation_id": pit_id}]}
                ],
                "blocks": [
                    {"type": "paragraph", "spans": [{"text": f"深入解析 {sec_title} 的底层机制与最佳实践。", "emphasis": "plain"}]}
                ],
                "annotations": [
                    {
                        "id": pit_id,
                        "kind": "pit",
                        "short_hint": f"{sec_title} 常见误区",
                        "full_detail": f"务必检查 {sec_title} 的边界条件与连接池配置。",
                        "timestamp": 25,
                        "timestamp_label": "00:25",
                    }
                ],
                "quiz": {
                    "short_prompt": f"关于 {sec_title} 的关键判断",
                    "full_question": f"在 {sec_title} 场景下，以下哪项配置最合理？",
                    "options": [
                        {"key": "A", "text": "开启连接池上限与超时控制"},
                        {"key": "B", "text": "无限创建新连接"},
                    ],
                    "correct_key": quiz_key,
                    "explanation": "限制连接池规模可避免数据库过载。",
                },
            }
        ],
    }
    return {
        "id": task_id,
        "status": "SUCCESS",
        "createdAt": "2026-11-22T10:00:00Z",
        "audioMeta": {"title": title, "platform": "web", "raw_info": {"tags": []}},
        "formData": {"platform": "web", "video_url": f"https://example.com/{task_id}"},
        "markdown": [
            {
                "ver_id": f"v-{task_id}",
                "content": f"## {sec_title}\n\n{sec_title} 内容",
                "structured": structured,
                "style": "knowledge",
                "model_name": "test-model",
            }
        ],
    }


def _seed_note(root: Path, task: dict) -> Path:
    task_id = task["id"]
    folder = root / f"Note__{task_id}"
    (folder / "_meta").mkdir(parents=True, exist_ok=True)
    (folder / "versions").mkdir(parents=True, exist_ok=True)
    ver = task["markdown"][0]
    (folder / "versions" / f"{ver['ver_id']}.json").write_text(
        json.dumps(ver["structured"], ensure_ascii=False), encoding="utf-8"
    )
    manifest = {
        "schema_version": 2,
        "task_id": task_id,
        "task": task,
    }
    (folder / "_meta" / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False), encoding="utf-8"
    )
    return folder


class Milestone4CLearningTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / "note_results"
        self.root.mkdir(parents=True, exist_ok=True)
        self.folders_path = Path(self.tmp.name) / "note_folders.json"
        self.library_path = Path(self.tmp.name) / "note_library.json"

        patches = [
            patch.object(note_storage, "ROOT", self.root),
            patch.object(note_folders, "STATE_PATH", self.folders_path),
            patch.object(note_library, "STATE_PATH", self.library_path),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

        self.task_pg = "note-pg-pool-001"
        self.task_pg2 = "note-pg-index-002"
        self.task_cook = "note-cooking-003"

        _seed_note(self.root, _make_structured_note(self.task_pg, "PostgreSQL 连接池与超时调优实战", "sec-1", "连接池上限控制"))
        _seed_note(self.root, _make_structured_note(self.task_pg2, "PostgreSQL 索引与连接池瓶颈排查", "sec-1", "连接池与慢查询优化"))
        _seed_note(self.root, _make_structured_note(self.task_cook, "法式烘焙可颂折叠温度控制", "sec-1", "黄油起酥温度"))

        note_library.update_entries([self.task_pg, self.task_pg2], {"tags": ["PostgreSQL", "数据库"]})
        note_library.update_entries([self.task_cook], {"tags": ["烘焙"]})
        note_folders.move_notes([self.task_pg, self.task_pg2], "learn")

        self.app = create_app(None)
        self.client = TestClient(self.app)

    def test_user_annotation_crud_and_persistence(self):
        # 1. 创建手工批注与助手沉淀批注
        r1 = self.client.post(
            f"/api/learning/notes/{self.task_pg}/annotations",
            json={
                "section_id": "sec-1",
                "section_title": "连接池上限控制",
                "block_id": "note-block-s-1",
                "anchor_text": "连接池上限与超时控制",
                "title": "线上参数备忘",
                "detail": "生产库连接数上限建议控制在 CPU 核数 * 2 + 磁盘数。",
                "source": "manual",
            },
        )
        self.assertEqual(r1.status_code, 200)
        created = r1.json()["data"]
        self.assertTrue(created["id"].startswith("ua_"))
        self.assertEqual(created["source"], "manual")

        r2 = self.client.post(
            f"/api/learning/notes/{self.task_pg}/annotations",
            json={
                "section_id": "sec-1",
                "detail": "PgBouncer 事务池模式可把数千前端连接复用到几十个后端连接。",
                "source": "assistant",
            },
        )
        self.assertEqual(r2.status_code, 200)
        assistant_anno = r2.json()["data"]
        self.assertEqual(assistant_anno["source"], "assistant")
        self.assertTrue(bool(assistant_anno["title"]))

        # 2. 读取状态包含 2 条批注
        state = self.client.get(f"/api/learning/notes/{self.task_pg}/state").json()["data"]
        self.assertEqual(len(state["user_annotations"]), 2)

        # 3. 编辑与删除
        upd = self.client.put(
            f"/api/learning/notes/{self.task_pg}/annotations/{created['id']}",
            json={"title": "更新后的备忘", "detail": "结合 PgBouncer 统一收口连接。"},
        )
        self.assertEqual(upd.status_code, 200)
        self.assertEqual(upd.json()["data"]["title"], "更新后的备忘")

        deleted = self.client.delete(f"/api/learning/notes/{self.task_pg}/annotations/{created['id']}")
        self.assertEqual(deleted.status_code, 200)
        self.assertTrue(deleted.json()["data"]["deleted"])

        state_after = learning_state.get_learning_state(self.task_pg)
        self.assertEqual([a["id"] for a in state_after["user_annotations"]], [assistant_anno["id"]])

    def test_srs_progression_and_due_filtering(self):
        # 首次答错 -> 立即进入今日到期错题池 (interval_days = 1)
        learning_state.update_learning_state(
            self.task_pg,
            {
                "quiz_attempts": {
                    "sec-1": {
                        "picked_key": "B",
                        "correct_key": "A",
                        "is_correct": False,
                    }
                }
            },
        )
        due_bank = learning_state.query_review_bank(kind="wrong_quiz", status="due")
        self.assertEqual(len(due_bank["wrong_quizzes"]), 1)
        self.assertTrue(due_bank["wrong_quizzes"][0]["is_due"])
        self.assertEqual(due_bank["counts"]["due_wrong_quizzes"], 1)

        # 第一次答对重练 -> 推进到 3 天后（因为之前 interval=1）
        res1 = learning_state.record_quiz_practice(self.task_pg, "sec-1", selected_key="A")
        self.assertTrue(res1["is_correct"])
        self.assertEqual(res1["interval_days"], 3)
        self.assertFalse(res1["is_due"])

        # 今日到期筛选此时应为空，但待复习（pending）仍保留
        due_after = learning_state.query_review_bank(kind="wrong_quiz", status="due")
        self.assertEqual(len(due_after["wrong_quizzes"]), 0)
        pending_after = learning_state.query_review_bank(kind="wrong_quiz", status="pending")
        self.assertEqual(len(pending_after["wrong_quizzes"]), 1)

        # 继续答对 -> 7 天 -> 21 天；答错 -> 回退到 1 天且立即可复习
        res2 = learning_state.record_quiz_practice(self.task_pg, "sec-1", selected_key="A")
        self.assertEqual(res2["interval_days"], 7)
        res3 = learning_state.record_quiz_practice(self.task_pg, "sec-1", selected_key="A")
        self.assertEqual(res3["interval_days"], 21)
        res_fail = learning_state.record_quiz_practice(self.task_pg, "sec-1", selected_key="B")
        self.assertFalse(res_fail["is_correct"])
        self.assertEqual(res_fail["interval_days"], 1)
        self.assertTrue(res_fail["is_due"])

        # 高频避坑支持 remembered=True 推进 SRS 而不永久标为掌握
        pit_res = self.client.post(
            "/api/learning/review-bank/pit-status",
            json={"task_id": self.task_pg, "section_id": "sec-1", "annotation_id": "p1", "remembered": True},
        ).json()["data"]
        self.assertFalse(pit_res["mastered"])
        self.assertEqual(pit_res["interval_days"], 1)
        self.assertFalse(pit_res["is_due"])

    def test_topic_quiz_collection_and_writeback(self):
        # 按文件夹 learn 抽题，只应抽到 2 篇 PostgreSQL 笔记，不含烘焙笔记
        resp = self.client.post("/api/learning/topic-quiz", json={"folder_id": "learn", "limit": 10})
        self.assertEqual(resp.status_code, 200)
        data = resp.json()["data"]
        self.assertEqual(data["note_count"], 2)
        self.assertEqual(len(data["questions"]), 2)
        returned_ids = {q["task_id"] for q in data["questions"]}
        self.assertEqual(returned_ids, {self.task_pg, self.task_pg2})

        # 专题测验答对不应误入错题池
        ok = learning_state.record_quiz_practice(self.task_pg2, "sec-1", selected_key="A")
        self.assertTrue(ok["is_correct"])
        bank = learning_state.query_review_bank(kind="wrong_quiz", status="all")
        self.assertEqual(len(bank["wrong_quizzes"]), 0)

        # 专题测验答错自动回写错题池
        wrong = learning_state.record_quiz_practice(self.task_pg2, "sec-1", selected_key="B")
        self.assertFalse(wrong["is_correct"])
        bank_after = learning_state.query_review_bank(kind="wrong_quiz", status="due")
        self.assertEqual(len(bank_after["wrong_quizzes"]), 1)
        self.assertEqual(bank_after["wrong_quizzes"][0]["task_id"], self.task_pg2)

    def test_related_notes_recommends_relevant_and_hides_unrelated(self):
        # PostgreSQL 连接池笔记应推荐 PostgreSQL 索引笔记，不推荐法式烘焙
        resp = self.client.get(f"/api/learning/notes/{self.task_pg}/related?limit=3")
        self.assertEqual(resp.status_code, 200)
        items = resp.json()["data"]["items"]
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["task_id"], self.task_pg2)
        self.assertIn("PostgreSQL", items[0]["shared_tags"])

        # 无关主题（法式烘焙）无相关笔记时返回空列表，不强行凑数
        cook_resp = self.client.get(f"/api/learning/notes/{self.task_cook}/related?limit=3")
        self.assertEqual(cook_resp.status_code, 200)
        self.assertEqual(cook_resp.json()["data"]["items"], [])


if __name__ == "__main__":
    unittest.main()
