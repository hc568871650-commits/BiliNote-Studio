import hashlib
import json
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from app.routers import note_folders as router
from app.services import note_folders as folders, note_storage as notes


class LogicalFoldersTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        for target, value in (("ROOT", self.root / "note_results"),):
            context = patch.object(notes, target, value)
            context.start()
            self.addCleanup(context.stop)
        context = patch.object(folders, "STATE_PATH", self.root / "data/note_folders.json")
        context.start()
        self.addCleanup(context.stop)
        for task_id in ("one", "two", "three"):
            notes.save_task({"id": task_id, "status": "SUCCESS", "markdown": "# 原有教程",
                             "audioMeta": {"title": "中文标题 " + task_id}})
            (notes._note_dir(task_id) / "images").mkdir(exist_ok=True)
            (notes._note_dir(task_id) / "images/original.png").write_bytes(b"original image")
        notes.set_archived("two", True)
        app = FastAPI()
        app.include_router(router.router, prefix="/api")
        self.client = TestClient(app)

    def snapshot(self):
        return {str(p.relative_to(notes.ROOT)): hashlib.sha256(p.read_bytes()).hexdigest()
                for p in notes.ROOT.rglob("*") if p.is_file()}

    def test_full_lifecycle_preserves_all_tutorial_files_and_archive_state(self):
        before = self.snapshot()
        initial = folders.list_folders()
        self.assertEqual([f["name"] for f in initial["folders"]], ["默认文件夹", "蒸馏视频", "学习视频"])
        self.assertFalse(folders.STATE_PATH.exists())
        created = folders.create_folder("  材质练习  ")
        folder_id = created["folders"][-1]["id"]
        folders.move_notes(["one", "two"], folder_id)
        folders.rename_folder(folder_id, "材质课程")
        # Reading again loads persisted state; names do not serve as identity.
        reread = folders.list_folders()
        self.assertEqual(reread["assignments"], {"one": folder_id, "two": folder_id})
        self.assertEqual(reread["folders"][-1]["name"], "材质课程")
        folders.move_notes(["three"], "learn")
        released = folders.delete_folder(folder_id)
        self.assertEqual(released["assignments"], {"three": "learn"})
        self.assertTrue(notes.get_task("two")["archived_at"])
        self.assertEqual(before, self.snapshot())
        folders.delete_folder("distill")
        folders.delete_folder("learn")
        # Seed folders must not reappear after deletion/restart/read.
        self.assertEqual(folders.list_folders(), {"folders": [folders.DEFAULT_FOLDER], "assignments": {}})

    def test_invalid_requests_do_not_partially_move_or_reset_state(self):
        folders.move_notes(["one"], "learn")
        before = folders.STATE_PATH.read_bytes()
        for action in (
            lambda: folders.delete_folder("default"),
            lambda: folders.rename_folder("default", "其他"),
            lambda: folders.create_folder(" 学习视频 "),
            lambda: folders.create_folder(""),
            lambda: folders.create_folder("a\nname"),
            lambda: folders.create_folder("x" * 61),
            lambda: folders.move_notes(["one", "missing"], "distill"),
            lambda: folders.move_notes(["one"], "missing"),
            lambda: folders.move_notes(["../outside"], "learn"),
        ):
            with self.assertRaises((ValueError, FileNotFoundError)):
                action()
            self.assertEqual(before, folders.STATE_PATH.read_bytes())

    def test_storage_failure_and_corruption_keep_original_bytes(self):
        folders.move_notes(["one"], "learn")
        before = folders.STATE_PATH.read_bytes()
        with patch.object(folders.os, "replace", side_effect=PermissionError("locked")):
            with self.assertRaises(PermissionError):
                folders.delete_folder("learn")
        self.assertEqual(before, folders.STATE_PATH.read_bytes())
        self.assertFalse(list(folders.STATE_PATH.parent.glob(".folders-*.tmp")))
        for damaged in (b'{"truncated":', b'{"schema_version":2}',
                        b'{"schema_version":1,"folders":[],"assignments":{"one":"lost"}}'):
            folders.STATE_PATH.write_bytes(damaged)
            result = self.client.post("/api/note_folders", json={"name": "新分类"}).json()
            self.assertNotEqual(result["code"], 0)
            self.assertEqual(folders.STATE_PATH.read_bytes(), damaged)

    def test_regeneration_and_archive_do_not_change_membership(self):
        folders.move_notes(["one"], "distill")
        notes.set_archived("one", True)
        notes.set_archived("one", False)
        notes.save_task({"id": "one", "status": "SUCCESS", "markdown": "# 新版本",
                         "audioMeta": {"title": "更新后的标题"}})
        self.assertEqual(folders.list_folders()["assignments"]["one"], "distill")
        folders.move_notes(["one"], "default")
        self.assertNotIn("one", folders.list_folders()["assignments"])

    def test_pending_deletion_cannot_be_moved(self):
        path = notes._note_dir("one") / "_meta/manifest.json"
        manifest = json.loads(path.read_text(encoding="utf-8"))
        manifest["deletion_pending"] = True
        path.write_text(json.dumps(manifest), encoding="utf-8")
        before = self.snapshot()
        with self.assertRaises(FileNotFoundError):
            folders.move_notes(["two", "one"], "learn")
        self.assertEqual(before, self.snapshot())
        self.assertFalse(folders.STATE_PATH.exists())

    def test_concurrent_mutations_do_not_lose_updates(self):
        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(lambda n: folders.create_folder(f"分类 {n}"), range(12)))
        self.assertEqual(len(folders.list_folders()["folders"]), 15)
        with ThreadPoolExecutor(max_workers=3) as pool:
            list(pool.map(lambda task: folders.move_notes([task], "learn"), ["one", "two", "three"]))
        self.assertEqual(len(folders.list_folders()["assignments"]), 3)

    def test_http_contract_default_protection_and_non_destructive_delete(self):
        before = self.snapshot()
        created = self.client.post("/api/note_folders", json={"name": "测试课程"}).json()
        self.assertEqual(created["code"], 0)
        folder_id = created["data"]["folders"][-1]["id"]
        moved = self.client.post("/api/note_folders/move", json={"task_ids": ["one", "two"], "folder_id": folder_id}).json()
        self.assertEqual(moved["data"]["assignments"]["two"], folder_id)
        self.assertEqual(self.client.patch(f"/api/note_folders/{folder_id}", json={"name": "已改名"}).json()["code"], 0)
        self.assertNotEqual(self.client.delete("/api/note_folders/default").json()["code"], 0)
        self.assertEqual(self.client.delete(f"/api/note_folders/{folder_id}").json()["data"]["assignments"], {})
        self.assertEqual(self.client.get("/api/note_folders").json()["code"], 0)
        self.assertEqual(before, self.snapshot())


if __name__ == "__main__":
    unittest.main()
