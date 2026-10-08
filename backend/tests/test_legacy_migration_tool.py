import json
import tempfile
import unittest
from pathlib import Path

from tools.legacy_migration import inventory, rehearse


class LegacyMigrationToolTests(unittest.TestCase):
    def test_inventory_and_isolated_copy_preserve_shared_images(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            root = base / "app"
            notes = root / "note_results"
            images = root / "static" / "screenshots"
            notes.mkdir(parents=True)
            images.mkdir(parents=True)
            (images / "shared.jpg").write_bytes(b"image")
            (images / "orphan.jpg").write_bytes(b"orphan")
            for task in ("one", "two"):
                (notes / f"{task}.json").write_text(json.dumps({"markdown": "![](/static/screenshots/shared.jpg)"}), encoding="utf-8")
            (notes / "one_transcript.json").write_text("{}", encoding="utf-8")
            (notes / "abandoned.status.json").write_text("{}", encoding="utf-8")
            export = base / "frontend.json"
            export.write_text(json.dumps({"state": {"tasks": [{"id": "one", "markdown": [
                {"ver_id": "old", "content": "![](/static/screenshots/missing.jpg)"},
                {"ver_id": "new", "content": "![](/static/screenshots/shared.jpg)"}]}]}}), encoding="utf-8")
            report = inventory(root, export)
            self.assertEqual(report["shared_images"], {"static/screenshots/shared.jpg": ["one", "two"]})
            self.assertEqual(report["entries"][0]["frontend_versions"], 2)
            self.assertEqual(report["entries"][0]["missing_images"], ["/static/screenshots/missing.jpg"])
            self.assertTrue(report["entries"][1]["backend_only_candidate"])
            self.assertEqual(report["unreferenced_screenshots"], ["static/screenshots/orphan.jpg"])
            self.assertEqual(report["unattached_note_files"], ["abandoned.status.json"])
            target = base / "rehearsal"
            result = rehearse(root, target, report)
            self.assertEqual(result["copied_files"], 4)
            self.assertEqual((target / "static/screenshots/shared.jpg").read_bytes(), b"image")
            self.assertTrue((notes / "one.json").exists())
            with self.assertRaises(ValueError):
                rehearse(root, target, report)

    def test_rejects_path_traversal_and_marks_unverified_frontend(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "app"
            notes = root / "note_results"
            notes.mkdir(parents=True)
            (notes / "one.json").write_text(json.dumps({"markdown": "![](/static/../outside.jpg)"}), encoding="utf-8")
            report = inventory(root)
            self.assertTrue(report["frontend_history_unverified"])
            self.assertEqual(report["entries"][0]["other_image_refs"], ["/static/../outside.jpg"])
            with self.assertRaises(ValueError):
                rehearse(root, root / "copy", report)


if __name__ == "__main__":
    unittest.main()
