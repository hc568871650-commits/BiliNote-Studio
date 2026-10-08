"""Integration checks for task status and incomplete image grids."""

from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.enmus.task_status_enums import TaskStatus
from app.services.note import NoteGenerator
from app.utils.video_reader import VideoReader


class NoteStatusAndGridTests(unittest.TestCase):
    def test_summary_updates_the_original_task_status(self):
        with tempfile.TemporaryDirectory() as directory:
            note = NoteGenerator.__new__(NoteGenerator)
            note._update_status = Mock()
            seen_keys = []
            gpt = SimpleNamespace(summarize=lambda source: seen_keys.append(source.checkpoint_key) or "summary")
            markdown = Path(directory) / "task-id_markdown.md"
            result = note._summarize_text(
                audio_meta=SimpleNamespace(title="test", raw_info={}),
                transcript=SimpleNamespace(segments=[]), gpt=gpt,
                markdown_cache_file=markdown, link=False, screenshot=False,
                formats=[], style=None, extras=None, video_img_urls=[],
            )
            self.assertEqual(result, "summary")
            self.assertEqual(markdown.read_text(encoding="utf-8"), "summary")
            note._update_status.assert_called_once_with("task-id", TaskStatus.SUMMARIZING)
            self.assertEqual(seen_keys, ["task-id"])

    def test_partial_grid_keeps_real_frames(self):
        with tempfile.TemporaryDirectory() as directory:
            reader = VideoReader(video_path="unused.mp4", grid_size=(2, 2),
                                 frame_dir=str(Path(directory) / "frames"),
                                 grid_dir=str(Path(directory) / "grids"),
                                 font_path="", unit_width=100, unit_height=60)

            def create_frames():
                for index in range(2):
                    Image.new("RGB", (100, 60), (220, 20, 20)).save(
                        Path(reader.frame_dir) / f"frame_00_0{index}.jpg")

            reader.extract_frames = create_frames
            urls = reader.run()
            self.assertEqual(len(urls), 1)
            with Image.open(Path(reader.grid_dir) / "grid_1.jpg") as grid:
                self.assertEqual(grid.size, (200, 120))
                self.assertGreater(grid.getpixel((50, 30))[0], 150)
                self.assertGreater(grid.getpixel((50, 90))[0], 200)


if __name__ == "__main__":
    unittest.main()
