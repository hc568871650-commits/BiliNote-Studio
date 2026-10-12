import importlib.util
import pathlib
import unittest
from dataclasses import dataclass

ROOT = pathlib.Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "app" / "gpt" / "request_chunker.py"
spec = importlib.util.spec_from_file_location("request_chunker", MODULE_PATH)
if spec is None or spec.loader is None:
    raise ImportError("request_chunker module spec not found")
request_chunker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(request_chunker)
RequestChunker = request_chunker.RequestChunker


@dataclass
class DummySeg:
    start: float
    end: float
    text: str


def build_messages(segments, image_urls, **_):
    content = [{"type": "text", "text": "".join(s.text for s in segments)}]
    for url in image_urls:
        content.append({"type": "image_url", "image_url": {"url": url, "detail": "auto"}})
    return [{"role": "user", "content": content}]


def size_estimator(messages):
    size = 0
    for part in messages[0]["content"]:
        if part["type"] == "text":
            size += len(part["text"])
        else:
            size += len(part["image_url"]["url"])
    return size


class TestRequestChunker(unittest.TestCase):
    def test_chunk_segments_preserves_order_and_content(self):
        segments = [
            DummySeg(0, 1, "aaaa"),
            DummySeg(1, 2, "bbbb"),
            DummySeg(2, 3, "cccc"),
        ]
        chunker = RequestChunker(build_messages, max_bytes=8, size_estimator=size_estimator)
        chunks = chunker.chunk(segments, [])
        texts = ["".join(seg.text for seg in c.segments) for c in chunks]
        self.assertEqual("".join(texts), "aaaabbbbcccc")
        self.assertTrue(all(texts))

    def test_chunk_images_distributed_across_batches(self):
        segments = [DummySeg(0, 1, "aa")]
        images = ["i" * 6, "j" * 6, "k" * 6]
        chunker = RequestChunker(build_messages, max_bytes=10, size_estimator=size_estimator)
        chunks = chunker.chunk(segments, images)
        all_images = [img for c in chunks for img in c.image_urls]
        self.assertEqual(all_images, images)

    def test_chunk_images_are_not_front_loaded_when_multiple_segment_chunks(self):
        segments = [
            DummySeg(0, 1, "aaaaaa"),
            DummySeg(1, 2, "bbbbbb"),
            DummySeg(2, 3, "cccccc"),
        ]
        images = ["11111", "22222", "33333"]
        chunker = RequestChunker(build_messages, max_bytes=12, size_estimator=size_estimator)
        chunks = chunker.chunk(segments, images)

        self.assertGreaterEqual(len(chunks), 3)
        image_counts = [len(c.image_urls) for c in chunks]
        self.assertGreater(image_counts[1], 0)
        self.assertGreater(image_counts[2], 0)
        all_images = [img for c in chunks for img in c.image_urls]
        self.assertEqual(all_images, images)

    def test_split_oversized_segment(self):
        segments = [DummySeg(0, 1, "x" * 25)]
        chunker = RequestChunker(build_messages, max_bytes=10, size_estimator=size_estimator)
        chunks = chunker.chunk(segments, [])
        combined = "".join(seg.text for c in chunks for seg in c.segments)
        self.assertEqual(combined, "x" * 25)

    def test_group_texts_by_budget(self):
        chunker = RequestChunker(build_messages, max_bytes=10, size_estimator=size_estimator)

        def build_text_messages(texts, *_args, **_kwargs):
            content = [{"type": "text", "text": "".join(texts)}]
            return [{"role": "user", "content": content}]

        groups = chunker.group_texts_by_budget(["aaaaa", "bbbbb", "ccccc"], build_text_messages)
        self.assertEqual(groups, [["aaaaa", "bbbbb"], ["ccccc"]])

    def test_dynamic_nonuniform_frames_use_actual_time_not_index(self):
        chunker = RequestChunker(build_messages, 8, size_estimator)
        segments = [DummySeg(0, 10, 'aaaaaa'), DummySeg(10, 20, 'bbbbbb'), DummySeg(20, 30, 'cccccc')]
        chunks = chunker.chunk(segments, ['A', 'B'], video_image_ranges=[{'start': 22, 'end': 22}, {'start': 25, 'end': 25}])
        self.assertEqual([c.image_urls for c in chunks], [[], [], ['A', 'B']])
        self.assertEqual([c.segments[0].start for c in chunks], [0, 10, 20])

    def test_long_video_and_grid_crossing_boundary_repeat_only_matching_chunks(self):
        chunker = RequestChunker(build_messages, 8, size_estimator)
        chunks = chunker.chunk([DummySeg(3590, 3600, 'aaaaaa'), DummySeg(3600, 3610, 'bbbbbb'), DummySeg(3610, 3620, 'cccccc')],
            ['G'], video_image_ranges=[{'start': 3595, 'end': 3605}])
        self.assertEqual([c.image_urls for c in chunks], [['G'], ['G'], []])
        self.assertEqual(chunks[1].video_image_ranges, [{'start': 3595, 'end': 3605}])

    def test_point_frame_on_boundary_goes_to_later_subtitle(self):
        chunks = RequestChunker(build_messages, 8, size_estimator).chunk(
            [DummySeg(0, 10, 'aaaaaa'), DummySeg(10, 20, 'bbbbbb')], ['P'], video_image_ranges=[{'start': 10, 'end': 10}])
        self.assertEqual([c.image_urls for c in chunks], [[], ['P']])

    def test_image_budget_splits_matching_text_without_dropping_frames(self):
        chunks = RequestChunker(build_messages, 8, size_estimator).chunk(
            [DummySeg(0, 10, 'abcdefghij')], ['IMAGE'], video_image_ranges=[{'start': 5, 'end': 5}])
        self.assertEqual(''.join(s.text for c in chunks for s in c.segments), 'abcdefghij')
        self.assertTrue(all(c.image_urls == ['IMAGE'] for c in chunks))
        self.assertTrue(all(size_estimator(build_messages(c.segments, c.image_urls)) <= 8 for c in chunks))

    def test_unmatched_frame_is_not_attached_to_unrelated_subtitles(self):
        chunks = RequestChunker(build_messages, 8, size_estimator).chunk(
            [DummySeg(0, 10, 'aaaaaa')], ['I'], video_image_ranges=[{'start': 20, 'end': 20}])
        self.assertEqual(chunks[0].image_urls, [])
        self.assertEqual(chunks[1].segments, [])
        self.assertEqual(chunks[1].video_image_ranges, [{'start': 20, 'end': 20}])

    def test_oversized_visual_and_invalid_ranges_are_explicit_errors(self):
        chunker = RequestChunker(build_messages, 8, size_estimator)
        with self.assertRaisesRegex(ValueError, '超过请求预算'):
            chunker.chunk([DummySeg(0, 1, 'a')], ['TOO-LARGE-IMAGE'], video_image_ranges=[{'start': 0, 'end': 1}])
        with self.assertRaisesRegex(ValueError, '数量不一致'):
            chunker.chunk([], ['I'], video_image_ranges=[])
        with self.assertRaisesRegex(ValueError, '时间范围无效'):
            chunker.chunk([], ['I'], video_image_ranges=[{'start': float('nan'), 'end': 1}])


if __name__ == "__main__":
    unittest.main()
