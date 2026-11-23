"""Milestone 4D 后端测试：存储统计、临时缓存清理、低码率回看策略、整库 .zip 脱敏备份与预备份恢复、检查更新。"""
from __future__ import annotations

import io
import json
import os
import sqlite3
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import MagicMock, patch

from fastapi.testclient import TestClient

from app import create_app
from app.services import note_storage, system_maintenance


class Milestone4DMaintenanceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.data_dir = root / "data"
        self.notes_dir = root / "note_results"
        self.static_dir = root / "static"
        self.shots_dir = self.static_dir / "screenshots"
        self.vector_dir = root / "vector_db"
        self.config_dir = root / "config"
        self.backups_dir = root / "backups"
        self.db_path = root / "bili_note.db"

        for d in (self.data_dir, self.notes_dir, self.shots_dir, self.vector_dir, self.config_dir, self.backups_dir):
            d.mkdir(parents=True, exist_ok=True)

        # 初始化测试 SQLite（含 providers 明文密钥以验证脱敏导出）
        conn = sqlite3.connect(str(self.db_path))
        conn.execute("CREATE TABLE providers (id TEXT PRIMARY KEY, name TEXT, api_key TEXT)")
        conn.execute("INSERT INTO providers (id, name, api_key) VALUES ('p1', 'DeepSeek', 'sk-secret-key-demo')")
        conn.commit()
        conn.close()

        # 造测试数据：临时音视频、用户上传文档、笔记、截图、敏感与普通配置
        (self.data_dir / "temp_video.mp4").write_bytes(b"V" * 4096)
        (self.data_dir / "temp_audio.m4a").write_bytes(b"A" * 2048)
        (self.data_dir / "note_folders.json").write_text('{"schema_version":1,"folders":[],"assignments":{}}', encoding="utf-8")
        (self.data_dir / "uploads").mkdir(parents=True, exist_ok=True)
        (self.data_dir / "uploads" / "doc.pdf").write_bytes(b"%PDF-1.4\n")
        (self.notes_dir / "Demo__n1" / "_meta").mkdir(parents=True, exist_ok=True)
        (self.notes_dir / "Demo__n1" / "_meta" / "manifest.json").write_text('{"task":{"id":"n1"}}', encoding="utf-8")
        (self.shots_dir / "shot_1.jpg").write_bytes(b"IMG" * 100)
        (self.config_dir / "cookies.json").write_text('{"bilibili":"SESSDATA=secret"}', encoding="utf-8")
        (self.config_dir / "proxy.json").write_text('{"proxy":"http://127.0.0.1:7890"}', encoding="utf-8")

        self.env_patch = patch.dict(
            os.environ,
            {
                "DATA_DIR": str(self.data_dir),
                "STATIC_DIR": str(self.static_dir),
                "VECTOR_DB_DIR": str(self.vector_dir),
                "CONFIG_DIR": str(self.config_dir),
                "BACKUP_DIR": str(self.backups_dir),
                "DATABASE_URL": f"sqlite:///{self.db_path}",
            },
        )
        self.env_patch.start()
        self.addCleanup(self.env_patch.stop)

        self.root_patch = patch.object(note_storage, "ROOT", self.notes_dir)
        self.root_patch.start()
        self.addCleanup(self.root_patch.stop)

        self.client = TestClient(create_app(None))

    def test_storage_summary_and_safe_cache_cleanup(self):
        res = self.client.get("/api/system/storage")
        self.assertEqual(res.status_code, 200)
        data = res.json()["data"]
        cats = {c["id"]: c for c in data["categories"]}
        self.assertEqual(cats["temp_media"]["bytes"], 6144)
        self.assertEqual(cats["temp_media"]["files"], 2)
        self.assertGreater(cats["note_results"]["bytes"], 0)
        self.assertGreater(cats["screenshots"]["bytes"], 0)

        # 一键清理临时音视频：仅清 temp_media，严格保留 note_folders.json / uploads / note_results / screenshots / db
        cleared = self.client.post("/api/system/storage/clear-cache").json()["data"]
        self.assertEqual(cleared["deleted_files"], 2)
        self.assertEqual(cleared["freed_bytes"], 6144)
        self.assertFalse((self.data_dir / "temp_video.mp4").exists())
        self.assertTrue((self.data_dir / "note_folders.json").is_file())
        self.assertTrue((self.data_dir / "uploads" / "doc.pdf").is_file())
        self.assertTrue((self.notes_dir / "Demo__n1" / "_meta" / "manifest.json").is_file())
        self.assertTrue((self.shots_dir / "shot_1.jpg").is_file())
        self.assertTrue(self.db_path.is_file())

    def test_playback_cache_policy_crud(self):
        r0 = self.client.get("/api/system/playback-cache").json()["data"]
        self.assertFalse(r0["enabled"])
        self.assertEqual(r0["retention_days"], 7)

        r1 = self.client.put(
            "/api/system/playback-cache",
            json={"enabled": True, "retention_days": 30, "max_size_mb": 2048},
        ).json()["data"]
        self.assertTrue(r1["enabled"])
        self.assertEqual(r1["retention_days"], 30)
        self.assertEqual(r1["max_size_mb"], 2048)

        bad = self.client.put("/api/system/playback-cache", json={"retention_days": 999})
        self.assertEqual(bad.json()["code"], 400)

    def test_backup_excludes_secrets_by_default_and_restore_creates_pre_backup(self):
        # 1. 默认导出排除明文凭据（排除 cookies.json，且快照 DB 内 api_key 清空，原 DB 不受影响）
        resp = self.client.get("/api/system/backup?include_secrets=false")
        self.assertEqual(resp.status_code, 200)
        zip_bytes = resp.content
        with zipfile.ZipFile(io.BytesIO(zip_bytes), "r") as zf:
            names = set(zf.namelist())
            self.assertIn("backup_manifest.json", names)
            self.assertIn("bili_note.db", names)
            self.assertIn("config/proxy.json", names)
            self.assertNotIn("config/cookies.json", names)
            # 检验打包副本内 api_key 已清空
            db_copy = Path(self.tmp.name) / "inspected.db"
            db_copy.write_bytes(zf.read("bili_note.db"))
            conn = sqlite3.connect(str(db_copy))
            key_in_zip = conn.execute("SELECT api_key FROM providers WHERE id='p1'").fetchone()[0]
            conn.close()
            self.assertEqual(key_in_zip, "")

        # 原库 api_key 完好无损
        conn_orig = sqlite3.connect(str(self.db_path))
        self.assertEqual(conn_orig.execute("SELECT api_key FROM providers WHERE id='p1'").fetchone()[0], "sk-secret-key-demo")
        conn_orig.close()

        # 2. 修改笔记后恢复：恢复成功、强制生成预备份、且原本地 api_key 自动保留
        (self.notes_dir / "Demo__n1" / "_meta" / "manifest.json").write_text('{"task":{"id":"modified"}}', encoding="utf-8")
        restore_resp = self.client.post(
            "/api/system/restore",
            files={"file": ("backup.zip", zip_bytes, "application/zip")},
        )
        self.assertEqual(restore_resp.status_code, 200)
        rdata = restore_resp.json()["data"]
        self.assertTrue(Path(rdata["pre_backup_path"]).is_file())
        self.assertEqual(
            json.loads((self.notes_dir / "Demo__n1" / "_meta" / "manifest.json").read_text(encoding="utf-8"))["task"]["id"],
            "n1",
        )
        conn_after = sqlite3.connect(str(self.db_path))
        self.assertEqual(conn_after.execute("SELECT api_key FROM providers WHERE id='p1'").fetchone()[0], "sk-secret-key-demo")
        conn_after.close()

        # 3. 路径穿越恶意 zip 必须被拒绝
        bad_buf = io.BytesIO()
        with zipfile.ZipFile(bad_buf, "w") as zf:
            zf.writestr("backup_manifest.json", '{"schema_version":1}')
            zf.writestr("../evil.txt", "boom")
        bad_resp = self.client.post(
            "/api/system/restore",
            files={"file": ("bad.zip", bad_buf.getvalue(), "application/zip")},
        )
        self.assertEqual(bad_resp.json()["code"], 400)

    def test_semver_and_check_update(self):
        self.assertTrue(system_maintenance.is_newer_version("0.4.1", "0.4.0"))
        self.assertTrue(system_maintenance.is_newer_version("0.4.0", "0.4.0-preview.1"))
        self.assertFalse(system_maintenance.is_newer_version("0.4.0", "0.4.0"))
        self.assertFalse(system_maintenance.is_newer_version("0.3.9", "0.4.0"))

        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {
            "tag_name": "v0.5.0",
            "html_url": "https://github.com/hc568871650-commits/BiliNote-Studio/releases/tag/v0.5.0",
            "body": "新增多源学习能力与桌面效率升级",
            "published_at": "2026-11-23T00:00:00Z",
        }
        mock_client = MagicMock()
        mock_client.__enter__.return_value.get.return_value = mock_resp

        with patch("httpx.Client", return_value=mock_client):
            res = self.client.get("/api/system/check-update?current_version=0.4.0").json()["data"]
        self.assertTrue(res["has_update"])
        self.assertEqual(res["latest_version"], "0.5.0")


if __name__ == "__main__":
    unittest.main()
