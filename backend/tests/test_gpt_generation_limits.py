"""Offline clients exercise actual chunk planning, checkpoints and gateway errors."""
import importlib.util
import json
import pathlib
import tempfile
import types
import unittest
try:
    from .test_universal_gpt_content_format import _load_universal_gpt_class
except ImportError:
    from test_universal_gpt_content_format import _load_universal_gpt_class

UniversalGPT = _load_universal_gpt_class()
ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('limits_request_chunker', ROOT / 'app/gpt/request_chunker.py')
chunker_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(chunker_module)
RequestChunker = chunker_module.RequestChunker
UniversalGPT.summarize.__globals__['RequestChunker'] = RequestChunker
UniversalGPT.create_messages.__globals__['generate_base_prompt'] = lambda **kwargs: kwargs.get('segment_text', '')


def segment(start, end, text):
    return types.SimpleNamespace(start=start, end=end, text=text)


def reply(text, reason='stop'):
    return types.SimpleNamespace(choices=[types.SimpleNamespace(finish_reason=reason,
        message=types.SimpleNamespace(content=text, refusal=None))])


def source(segments, images=(), ranges=None):
    return types.SimpleNamespace(screenshot=bool(images), link=True, segment=segments,
        video_img_urls=list(images), video_image_ranges=ranges, checkpoint_key='offline',
        title='fixture', tags=[], _format=['link'], style='tutorial', extras='', frame_evidence=[])


class GenerationLimitsTests(unittest.TestCase):
    def test_same_model_from_different_provider_cannot_reuse_checkpoint(self):
        with tempfile.TemporaryDirectory() as directory:
            gpt, _ = self.make_gpt(directory, [])
            item = source([segment(0, 1, '字幕')])
            gpt.backend_identity = 'provider-a|https://one.invalid/v1'
            first = gpt._build_source_signature(item)
            gpt._save_checkpoint('offline', first, ['供应商A正文'], 'summarize')
            self.assertIsNotNone(gpt._load_checkpoint('offline', first))
            gpt.backend_identity = 'provider-b|https://two.invalid/v1'
            second = gpt._build_source_signature(item)
            self.assertNotEqual(first, second)
            self.assertIsNone(gpt._load_checkpoint('offline', second))

    def make_gpt(self, directory, answers):
        calls = []
        def create(**kwargs):
            calls.append(kwargs['messages'])
            result = answers(len(calls), kwargs['messages']) if callable(answers) else answers[len(calls) - 1]
            if isinstance(result, Exception):
                raise result
            return result
        client = types.SimpleNamespace(chat=types.SimpleNamespace(completions=types.SimpleNamespace(create=create)))
        gpt = UniversalGPT(client, 'offline')
        gpt.checkpoint_dir = pathlib.Path(directory)
        gpt._max_retry_attempts, gpt._retry_base_backoff = 3, 0
        return gpt, calls

    def test_6256_seconds_and_34244_chars_split_despite_45mib_budget(self):
        # Equivalent counts/duration to the incident; no real media or network.
        count, duration = 3054, 6256.4
        texts = ['字' * 11 for _ in range(count)]
        texts[-1] += '字' * (34244 - sum(map(len, texts)))
        segments = [segment(i * duration / count, (i + 1) * duration / count, text)
                    for i, text in enumerate(texts)]
        ranges = [{'start': i * duration / 30, 'end': (i + 1) * duration / 30} for i in range(30)]
        images = [f'grid-{i}' for i in range(30)]
        builder = lambda batch, pictures, **kwargs: [{'role': 'user', 'content': ''.join(s.text for s in batch) + ''.join(pictures)}]
        chunks = RequestChunker(builder, 45 * 1024 * 1024, None, 8000, 600).chunk(segments, images, video_image_ranges=ranges)
        self.assertEqual(len(chunks), 11)
        self.assertEqual(''.join(s.text for c in chunks for s in c.segments), ''.join(texts))
        self.assertEqual(set(img for c in chunks for img in c.image_urls), set(images))
        for chunk in chunks:
            self.assertLessEqual(sum(len(s.text) for s in chunk.segments), 8000)
            self.assertLessEqual(max(s.end for s in chunk.segments) - min(s.start for s in chunk.segments), 600)
            for img, bounds in zip(chunk.image_urls, chunk.video_image_ranges):
                self.assertEqual(bounds, ranges[images.index(img)])
                self.assertTrue(any(RequestChunker._overlaps(s.start, s.end, bounds) for s in chunk.segments))

    def test_single_long_subtitle_preserves_time_when_text_is_split(self):
        builder = lambda batch, pictures, **kwargs: [{'role': 'user', 'content': ''.join(s.text for s in batch)}]
        chunks = RequestChunker(builder, 100000, None, 4, 600).chunk([segment(0, 2000, 'abcdefghij')],
            ['grid'], video_image_ranges=[{'start': 900, 'end': 1100}])
        self.assertEqual(''.join(s.text for c in chunks for s in c.segments), 'abcdefghij')
        self.assertTrue(all(s.start == 0 and s.end == 2000 for c in chunks for s in c.segments))
        self.assertTrue(all(c.image_urls == ['grid'] for c in chunks))

    def test_length_is_split_once_and_only_complete_subresults_are_assembled(self):
        with tempfile.TemporaryDirectory() as directory:
            gpt, calls = self.make_gpt(directory, [reply('INCOMPLETE', 'length'), reply('完整A'), reply('完整B')])
            result = gpt.summarize(source([segment(0, 20, 'abcdefghijklmnop')], ['grid'], [{'start': 5, 'end': 10}]))
            self.assertEqual(len(calls), 3)
            self.assertIn('完整A', result)
            self.assertIn('完整B', result)
            self.assertNotIn('INCOMPLETE', result)
            self.assertTrue(all(len(m[0]['content']) == 2 for m in calls))
            self.assertFalse(gpt._checkpoint_path('offline').exists())

    def test_repeated_length_reaches_bounded_limit_without_saving_body(self):
        with tempfile.TemporaryDirectory() as directory:
            gpt, calls = self.make_gpt(directory, lambda *_: reply('INCOMPLETE', 'length'))
            with self.assertRaisesRegex(ValueError, '有界细分上限'):
                gpt.summarize(source([segment(0, 20, 'a' * 128)]))
            self.assertEqual(len(calls), 3)  # Fail on the first deepest branch.
            saved = json.loads(gpt._checkpoint_path('offline').read_text(encoding='utf-8'))
            self.assertEqual(saved['partials'], [])

    def test_adaptive_checkpoint_skips_truncated_parent_and_completed_child(self):
        with tempfile.TemporaryDirectory() as directory:
            src = source([segment(0, 20, 'a' * 16)])
            gpt, calls = self.make_gpt(directory, [reply('INCOMPLETE', 'length'), reply('complete-A'), Exception('terminal error')])
            with self.assertRaisesRegex(Exception, 'terminal error'):
                gpt.summarize(src)
            saved = json.loads(gpt._checkpoint_path('offline').read_text(encoding='utf-8'))
            self.assertEqual(saved['partials'], [])
            self.assertEqual(saved['chunk_progress']['root'], {'split': True})
            self.assertEqual(saved['chunk_progress']['root/0'], {'text': 'complete-A'})
            resumed, resumed_calls = self.make_gpt(directory, [reply('complete-B')])
            result = resumed.summarize(src)
            self.assertIn('complete-A', result)
            self.assertIn('complete-B', result)
            self.assertEqual(len(resumed_calls), 1)
            self.assertEqual(len(calls), 3)

    def test_adaptive_total_budget_stops_before_another_call(self):
        with tempfile.TemporaryDirectory() as directory:
            gpt, calls = self.make_gpt(directory, [])
            chunk = chunker_module.ChunkPayload([segment(0, 20, 'a' * 16)], [])
            builder = lambda batch, images, **kwargs: gpt.create_messages(batch, video_img_urls=images, **kwargs)
            with self.assertRaisesRegex(ValueError, '15个生成请求'):
                gpt._summarize_chunk(chunk, source(chunk.segments), builder, budget={'remaining': 0})
            self.assertEqual(calls, [])

    def test_real_wrapped_413_is_not_retried_and_diagnostics_are_private(self):
        error = Exception("Error code: 413 - {'error': {'message': 'openai_error', 'type': 'bad_response_status_code', 'param': '', 'code': 'bad_response_status_code'}}")
        with tempfile.TemporaryDirectory() as directory:
            gpt, calls = self.make_gpt(directory, [error])
            with self.assertRaisesRegex(ValueError, 'HTTP 413') as caught:
                gpt.summarize(source([segment(0, 1, 'SECRET_SUBTITLE')], ['SECRET_IMAGE'], [{'start': 0, 'end': 1}]))
            self.assertEqual(len(calls), 1)
            self.assertIn('messages_json_bytes=', str(caught.exception))
            self.assertIn('image_count=1', str(caught.exception))
            self.assertNotIn('SECRET_', str(caught.exception))
            self.assertFalse(UniversalGPT._is_retryable_error(error))
            status_error = Exception('bad_response_status_code')
            status_error.status_code = 413
            self.assertFalse(UniversalGPT._is_retryable_error(status_error))
            self.assertTrue(UniversalGPT._is_retryable_error(Exception('Error code: 524 - bad_response_status_code')))
            self.assertFalse(UniversalGPT._is_retryable_error(Exception('bad_response_status_code')))

    def test_merge_checkpoint_resumes_merge_without_regenerating_source(self):
        with tempfile.TemporaryDirectory() as directory:
            gpt, calls = self.make_gpt(directory, [reply('已合并')])
            src = source([segment(0, 1, 'SOURCE_MUST_NOT_BE_SENT')])
            signature = gpt._build_source_signature(src)
            gpt._save_checkpoint('offline', signature, ['complete-A', 'complete-B'], 'merge')
            self.assertEqual(gpt.summarize(src), '已合并')
            self.assertEqual(len(calls), 1)
            self.assertNotIn('SOURCE_MUST_NOT_BE_SENT', str(calls))
            self.assertIn('complete-A', str(calls))
            self.assertFalse(gpt._checkpoint_path('offline').exists())

    def test_summarize_checkpoint_skips_only_completed_source_chunks(self):
        with tempfile.TemporaryDirectory() as directory:
            gpt, calls = self.make_gpt(directory, [reply('complete-B'), reply('merged')])
            gpt.max_chunk_text_chars = 4
            src = source([segment(0, 1, 'AAAA'), segment(1, 2, 'BBBB')])
            gpt._save_checkpoint('offline', gpt._build_source_signature(src), ['complete-A'], 'summarize')
            self.assertEqual(gpt.summarize(src), 'merged')
            self.assertEqual(len(calls), 2)
            self.assertNotIn('AAAA', str(calls))
            self.assertIn('BBBB', str(calls[0]))

    def test_merge_failure_retains_successful_earlier_merge_group(self):
        with tempfile.TemporaryDirectory() as directory:
            gpt, calls = self.make_gpt(directory, [reply('complete-AB'), Exception('terminal error')])
            original_size = gpt._estimate_messages_bytes
            gpt._estimate_messages_bytes = lambda messages: 3 if messages[0]['content'].count('\n\n---\n\n') < 2 else 1000
            gpt.max_request_bytes = 100
            with self.assertRaisesRegex(Exception, 'terminal error'):
                gpt._merge_partials(['A', 'B', 'C', 'D'], 'offline', 'sig')
            saved = json.loads(gpt._checkpoint_path('offline').read_text(encoding='utf-8'))
            self.assertEqual(saved['partials'], ['complete-AB', 'C', 'D'])
            self.assertEqual(saved['phase'], 'merge')
            self.assertEqual(len(calls), 2)
            gpt._estimate_messages_bytes = original_size

    def test_singleton_merge_groups_and_long_merge_do_not_call_model(self):
        with tempfile.TemporaryDirectory() as directory:
            gpt, calls = self.make_gpt(directory, [])
            gpt._estimate_messages_bytes = lambda messages: 3 if '\n\n---\n\n' not in messages[0]['content'] else 1000
            gpt.max_request_bytes = 100
            result = gpt._merge_partials(['complete-A', 'complete-B'], None, None)
            self.assertIn('complete-A', result)
            self.assertIn('complete-B', result)
            self.assertIn('未进行跨段模型合并', result)
            gpt.max_merge_text_chars = 10
            self.assertIn('complete-A', gpt._merge_partials(['complete-A', 'complete-B'], None, None))
            self.assertEqual(calls, [])


if __name__ == '__main__':
    unittest.main()
