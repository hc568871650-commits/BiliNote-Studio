import json
import tempfile
import unittest
from dataclasses import dataclass
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from app.routers import note as note_router
from app.services.note import NoteGenerator, _cache_task_id
from app.enmus.task_status_enums import TaskStatus
from app.services import note_storage as storage


class NoteStorageArchiveTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "notes"
        self.images = Path(self.temp.name) / "old_images"
        self.images.mkdir()
        (self.images / "shared.jpg").write_bytes(b"old image")
        root = patch.object(storage, "ROOT", self.root)
        root.start()
        self.addCleanup(root.stop)
        out_dir = patch.dict("os.environ", {"OUT_DIR": str(self.images)})
        out_dir.start()
        self.addCleanup(out_dir.stop)

    def task(self, task_id, markdown=None):
        return {"id": task_id, "status": "SUCCESS", "createdAt": "2026-09-19T12:00:00Z",
                "audioMeta": {"title": "Guide:/?"}, "transcript": {"full_text": "Transcript"},
                "markdown": markdown or [{"ver_id": "v1", "created_at": "2026-09-19T12:00:00Z",
                                          "content": "![frame](/static/screenshots/shared.jpg)"}]}

    def test_archive_versions_and_scoped_delete(self):
        first = storage.save_task(self.task("one"))
        second = storage.save_task(self.task("two"))
        self.assertEqual(len(storage.list_tasks()), 2)
        self.assertIn("../images/", first["markdown"][0]["content"])
        self.assertTrue((self.root / "Guide_____one" / "笔记.md").exists())
        image_link = first["markdown"][0]["content"].split("(")[1].split(")")[0]
        self.assertTrue(storage.asset("one", image_link.removeprefix("../")).exists())
        with self.assertRaises(ValueError):
            storage.delete_task("one")
        storage.set_archived("one", True)
        with patch("app.services.vector_store.VectorStoreManager.delete_index"), patch("app.db.video_task_dao.delete_task_by_id"):
            storage.delete_task("one")
        self.assertIsNone(storage.get_task("one"))
        self.assertEqual(storage.get_task("two")["id"], second["id"])
        self.assertTrue((self.images / "shared.jpg").exists())
        with self.assertRaises(ValueError):
            storage.save_task(self.task("one"), import_legacy=True)

    def test_failure_preserves_retry_and_blocks_path_escape(self):
        task = storage.save_task(self.task("recover"))
        folder = storage._note_dir("recover")
        storage.set_archived("recover", True)
        with patch("app.services.vector_store.VectorStoreManager.delete_index", side_effect=OSError("locked")):
            with self.assertRaises(OSError):
                storage.delete_task("recover")
        self.assertTrue(storage.get_task("recover")["archived_at"])
        self.assertTrue(json.loads((folder / "_meta" / "manifest.json").read_text(encoding="utf-8"))["deletion_pending"])
        with self.assertRaises(ValueError):
            storage.asset("recover", "../_meta/manifest.json")
        with self.assertRaises(ValueError):
            storage.asset("recover", "../../outside.jpg")

    def test_partial_filesystem_failure_keeps_retry_journal(self):
        storage.save_task(self.task("partial"))
        storage.set_archived("partial", True)
        folder = storage._note_dir("partial")

        def interrupted_remove(path):
            (path / "_meta" / "manifest.json").unlink()
            raise PermissionError("file in use")

        with patch("app.services.vector_store.VectorStoreManager.delete_index"), patch("app.db.video_task_dao.delete_task_by_id"):
            with patch.object(storage.shutil, "rmtree", side_effect=interrupted_remove):
                with self.assertRaises(PermissionError):
                    storage.delete_task("partial")
            self.assertTrue(storage.get_task("partial")["archived_at"])
            self.assertIn("partial", [item["id"] for item in storage.list_tasks()])
            storage.delete_task("partial")
        self.assertFalse(folder.exists())
        self.assertFalse((self.root / "_pending_deletions" / "partial.json").exists())

    def test_cleanup_only_successful_isolated_runs(self):
        storage.save_task(self.task("complete"))
        storage.save_task(self.task("failed"))
        temp_root = Path(self.temp.name) / "Temp" / "note_jobs"
        for task_id in ("complete", "failed"):
            run = temp_root / task_id / "run1"
            run.mkdir(parents=True)
            (run / "frames.jpg").write_bytes(b"frame")
            (self.root / f"{task_id}.status.json").write_text(json.dumps({"status": "SUCCESS" if task_id == "complete" else "FAILED"}))
        self.assertEqual(storage.cleanup_completed_runs(temp_root), [])
        self.assertFalse((temp_root / "complete" / "run1").exists())
        self.assertTrue((temp_root / "failed" / "run1").exists())

    def test_pending_import_receives_final_title_and_failure_is_durable(self):
        pending = {"id": "pending", "status": "PENDING", "markdown": "",
                   "audioMeta": {"title": ""}, "createdAt": "2026-09-19T12:00:00Z"}
        storage.save_task(pending, import_legacy=True)
        self.assertEqual(storage._note_dir("pending").name, "pending__pending")
        storage.save_task(self.task("pending"))
        self.assertEqual(storage._note_dir("pending").name, "Guide_____pending")
        storage.set_status("pending", "FAILED")
        self.assertEqual(storage.get_task("pending")["status"], "FAILED")

    def test_draft_cache_and_status_live_with_tutorial(self):
        storage.create_draft("draft", {"video_url": "https://example.invalid", "platform": "bilibili"})
        self.assertEqual(storage.cache_path("draft", "transcript").parent.name, "_meta")
        self.assertEqual(storage.status_path("draft").parent.name, "_meta")
        self.assertEqual(storage.get_task("draft")["status"], "PENDING")
        self.assertEqual(_cache_task_id(storage.cache_path("draft", "audio"), "audio"), "draft")
        self.assertEqual(_cache_task_id(storage.cache_path("draft", "transcript"), "transcript"), "draft")
        self.assertEqual(_cache_task_id(storage.cache_path("draft", "markdown"), "markdown"), "draft")
        response = note_router.get_task_status("draft")
        self.assertEqual(json.loads(response.body)["data"]["status"], "PENDING")
        self.assertEqual(storage.recover_interrupted_runs(), ["draft"])
        self.assertEqual(storage.get_task("draft")["status"], "FAILED")

    def test_result_commits_before_success_status(self):
        storage.create_draft("generated", {"platform": "bilibili"})

        @dataclass
        class FakeResult:
            markdown: str
            transcript: dict
            audio_meta: dict

        class FakeGenerator:
            def generate(self, **kwargs):
                return FakeResult("# Generated", {"full_text": "source"}, {"title": "Final title"})

            def _update_status(self, task_id, status, message=None):
                if status.value == "SUCCESS":
                    assert storage.result_path(task_id).exists()
                storage.status_path(task_id).write_text(json.dumps({"status": status.value}))

        with patch.object(note_router, "NoteGenerator", FakeGenerator), \
             patch.object(note_router.task_serial_executor, "run", side_effect=lambda action: action()), \
             patch("app.services.vector_store.VectorStoreManager.index_task"):
            note_router.run_note_task("generated", "url", "bilibili", "medium",
                                      model_name="fixture", provider_id="fixture")
        self.assertEqual(storage.get_task("generated")["status"], "SUCCESS")
        self.assertEqual(storage._note_dir("generated").name, "Final title__generated")
        self.assertEqual(json.loads(note_router.get_task_status("generated").body)["data"]["status"], "SUCCESS")

    def test_status_write_failure_does_not_publish_fake_success(self):
        storage.create_draft("io-failure", {"platform": "bilibili"})
        path = storage.status_path("io-failure")
        path.write_text('{"status":"SAVING"}', encoding="utf-8")
        with patch.object(Path, "open", side_effect=PermissionError("locked")):
            with self.assertRaises(PermissionError):
                NoteGenerator.__new__(NoteGenerator)._update_status("io-failure", TaskStatus.SUCCESS)
        self.assertEqual(json.loads(path.read_text(encoding="utf-8"))["status"], "SAVING")

    def test_api_archive_read_restore_and_delete_guard(self):
        app = FastAPI()
        app.include_router(note_router.router, prefix="/api")
        client = TestClient(app)
        task = self.task("api-one")
        imported = client.post("/api/notes/import", json={"tasks": [task]})
        self.assertEqual(imported.json()["code"], 0)
        self.assertEqual(client.get("/api/notes").json()["data"][0]["id"], "api-one")
        self.assertNotEqual(client.delete("/api/notes/api-one").json()["code"], 0)
        archived = client.post("/api/notes/api-one/archive").json()["data"]
        self.assertTrue(archived["archived_at"])
        self.assertIn("../images/", client.get("/api/notes/api-one").json()["data"]["markdown"][0]["content"])
        image = archived["markdown"][0]["content"].split("(")[1].split(")")[0].removeprefix("../")
        self.assertEqual(client.get(f"/api/notes/api-one/assets/{image}").status_code, 200)
        self.assertEqual(client.get("/api/notes/api-one/assets/../_meta/manifest.json").status_code, 404)
        client.post("/api/notes/api-one/restore")
        self.assertFalse(client.get("/api/notes/api-one").json()["data"]["archived_at"])
        client.post("/api/notes/api-one/archive")
        with patch("app.services.vector_store.VectorStoreManager.delete_index"), patch("app.db.video_task_dao.delete_task_by_id"):
            self.assertEqual(client.delete("/api/notes/api-one").json()["code"], 0)
        self.assertEqual(client.post("/api/notes/import", json={"tasks": [task]}).json()["data"], [])
        self.assertEqual(client.post("/api/delete_task", json={"video_id": "v", "platform": "bilibili"}).json()["code"], 410)


if __name__ == "__main__":
    unittest.main()
