"""Long video markers loaded directly; no app/bootstrap, network or configuration."""
import importlib.util
import unittest
from pathlib import Path
from urllib.parse import parse_qs, urlparse


def load_utility(name):
    path = Path(__file__).resolve().parents[1] / 'app' / 'utils' / (name + '.py')
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


screenshots = load_utility('screenshot_marker')
notes = load_utility('note_helper')


class LongMarkerTests(unittest.TestCase):
    def test_screenshot_minutes_hours_brackets_and_stars(self):
        for marker in ['Screenshot-104:16', '*Screenshot-[104:16]*',
                       'Screenshot-01:44:16', '*Screenshot-[01:44:16]']:
            with self.subTest(marker=marker):
                self.assertEqual(screenshots.extract_screenshot_timestamps(marker), [(marker, 6256)])
        self.assertEqual(screenshots.extract_screenshot_timestamps('Screenshot-25:01:01'), [('Screenshot-25:01:01', 90061)])

    def test_invalid_timestamps_are_not_partially_replaced(self):
        invalid = ['01:60', '104:60', '01:60:00', '01:44:60', '01:44:160',
                   '01:44:16:20', '01:44:16.5', '01:44:16abc']
        for timestamp in invalid:
            for brackets in [False, True]:
                with self.subTest(timestamp=timestamp, brackets=brackets):
                    value = '[' + timestamp + ']' if brackets else timestamp
                    self.assertEqual(screenshots.extract_screenshot_timestamps('Screenshot-' + value), [])
                    marker = 'Content-' + value
                    self.assertEqual(notes.replace_content_markers(marker, 'BVtest'), marker)

    def test_bilibili_without_part_has_valid_time_query(self):
        result = notes.replace_content_markers('*Content-[01:44:16]*', 'BVtest')
        self.assertEqual(result, '[原片 @ 01:44:16](https://www.bilibili.com/video/BVtest?t=6256)')

    def test_bilibili_part_is_preserved_for_accumulated_minutes(self):
        result = notes.replace_content_markers('Content-104:16', 'BVtest_p12')
        self.assertEqual(result, '[原片 @ 104:16](https://www.bilibili.com/video/BVtest?p=12&t=6256)')
        parsed = urlparse(result.split('](')[1][:-1])
        self.assertEqual(parse_qs(parsed.query), {'p': ['12'], 't': ['6256']})

    def test_multiple_markers_do_not_mutate_video_id(self):
        result = notes.replace_content_markers('Content-00:09 Content-25:01:01', 'BVtest_p2')
        self.assertIn('/BVtest?p=2&t=9)', result)
        self.assertIn('/BVtest?p=2&t=90061)', result)

    def test_youtube_and_douyin_long_timestamp(self):
        self.assertEqual(notes.replace_content_markers('Content-01:44:16', 'yt-id', 'youtube'),
                         '[原片 @ 01:44:16](https://www.youtube.com/watch?v=yt-id&t=6256s)')
        self.assertEqual(notes.replace_content_markers('Content-104:16', '123', 'douyin'),
                         '[原片 @ 104:16](https://www.douyin.com/video/123)')


if __name__ == '__main__':
    unittest.main(verbosity=2)
