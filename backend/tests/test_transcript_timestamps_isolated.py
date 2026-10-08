"""Exercise the source timestamp functions without importing app/bootstrap."""
import ast
import unittest
from pathlib import Path
from types import SimpleNamespace


def source_functions():
    path = Path(__file__).resolve().parents[1] / 'app' / 'gpt' / 'universal_gpt.py'
    module = ast.parse(path.read_text(encoding='utf-8'), filename=str(path))
    provider = next(node for node in module.body if isinstance(node, ast.ClassDef) and node.name == 'UniversalGPT')
    functions = [node for node in provider.body if isinstance(node, ast.FunctionDef)
                 and node.name in {'_format_time', '_build_segment_text'}]
    namespace = {'List': list, 'TranscriptSegment': SimpleNamespace}
    exec(compile(ast.Module(body=functions, type_ignores=[]), str(path), 'exec'), namespace)
    return type('TimestampFunctions', (), {node.name: namespace[node.name] for node in functions})()


class TranscriptTimestampTests(unittest.TestCase):
    def setUp(self):
        self.formatter = source_functions()

    def test_sub_hour_minutes_and_seconds(self):
        for value, expected in [(0, '00:00'), (9, '00:09'), (65.9, '01:05'), (3599, '59:59')]:
            with self.subTest(seconds=value):
                self.assertEqual(self.formatter._format_time(value), expected)

    def test_hour_boundary_and_real_video_duration(self):
        for value, expected in [(3600, '01:00:00'), (6256, '01:44:16'), (6256.99, '01:44:16')]:
            with self.subTest(seconds=value):
                self.assertEqual(self.formatter._format_time(value), expected)

    def test_hours_do_not_wrap_at_one_day(self):
        for value, expected in [(86400, '24:00:00'), (90061, '25:01:01'), (360000, '100:00:00')]:
            with self.subTest(seconds=value):
                self.assertEqual(self.formatter._format_time(value), expected)

    def test_segment_prompt_preserves_long_video_timestamps(self):
        segments = [SimpleNamespace(start=3599.5, text=' before hour '),
                    SimpleNamespace(start=6256, text=' long video '),
                    SimpleNamespace(start=90061, text=' after day ')]
        self.assertEqual(self.formatter._build_segment_text(segments),
                         '59:59 - before hour\n01:44:16 - long video\n25:01:01 - after day')


if __name__ == '__main__':
    unittest.main(verbosity=2)
