"""Incomplete gateway replies must not become notes or completed checkpoints."""
import json
import tempfile
import types
import unittest
from pathlib import Path
try:
    from .test_universal_gpt_content_format import UniversalGPT
except ImportError:
    from test_universal_gpt_content_format import UniversalGPT


def response(content='完整正文', reason='stop', refusal=None):
    return types.SimpleNamespace(choices=[types.SimpleNamespace(finish_reason=reason,
        message=types.SimpleNamespace(content=content, refusal=refusal))])


class IncompleteResponseTests(unittest.TestCase):
    def test_rejects_truncation_filter_refusal_and_missing_body(self):
        cases = [
            (response('半截正文', 'length'), '截断'),
            (response('被过滤', 'content_filter'), '过滤'),
            (response('  '), '空正文'),
            (response(None), '空正文'),
            (response(reason=None), '缺失'),
            (response(reason='tool_calls'), '正常结束'),
            (response(refusal='refused'), '拒绝'),
            (types.SimpleNamespace(choices=[]), 'choices为空'),
            (types.SimpleNamespace(), 'choices为空'),
            (types.SimpleNamespace(choices='malformed'), 'choices为空'),
        ]
        for item, diagnostic in cases:
            with self.subTest(diagnostic=diagnostic):
                with self.assertRaisesRegex(ValueError, diagnostic):
                    UniversalGPT._validated_response(item)
        self.assertEqual(UniversalGPT._validated_response(response(' 完整正文 ')), '完整正文')

    def make_gpt(self, directory, replies):
        gpt = UniversalGPT.__new__(UniversalGPT)
        gpt.model, gpt.temperature, gpt.max_request_bytes = 'fixture', .7, 100000
        gpt.checkpoint_dir = Path(directory)
        calls = []
        def create(messages):
            calls.append(messages)
            return replies[len(calls) - 1]
        gpt._chat_completion_create = create
        return gpt, calls

    def test_generation_never_checkpoints_truncated_chunk_and_does_not_retry(self):
        namespace = UniversalGPT.summarize.__globals__
        original = namespace['RequestChunker']
        class TwoChunks:
            def __init__(self, *args): pass
            def chunk(self, *args, **kwargs):
                return [types.SimpleNamespace(segments=[], image_urls=[]) for _ in range(2)]
        namespace['RequestChunker'] = TwoChunks
        try:
            with tempfile.TemporaryDirectory() as folder:
                gpt, calls = self.make_gpt(folder, [response('第一段完整'), response('第二段半截', 'length')])
                source = types.SimpleNamespace(screenshot=False, link=True, segment=[types.SimpleNamespace(start=0, end=2, text='字幕')],
                    video_img_urls=[], checkpoint_key='fixture', title='标题', tags='', _format=['link'], style='tutorial', extras='')
                with self.assertRaisesRegex(ValueError, '截断'):
                    gpt.summarize(source)
                checkpoint = json.loads(gpt._checkpoint_path('fixture').read_text(encoding='utf-8'))
                self.assertEqual(checkpoint['partials'], ['第一段完整'])
                self.assertEqual(len(calls), 2)
        finally:
            namespace['RequestChunker'] = original

    def test_merge_retains_complete_inputs_without_saving_truncated_merge(self):
        with tempfile.TemporaryDirectory() as folder:
            gpt, calls = self.make_gpt(folder, [response('合并半截', 'length')])
            result = gpt._merge_partials(['完整A', '完整B'], 'fixture', 'signature')
            self.assertIn('完整A', result)
            self.assertIn('完整B', result)
            self.assertIn('未进行跨段模型合并', result)
            self.assertNotIn('合并半截', result)
            self.assertFalse(gpt._checkpoint_path('fixture').exists())
            self.assertEqual(len(calls), 1)

    def test_new_response_contract_invalidates_old_checkpoints(self):
        with tempfile.TemporaryDirectory() as folder:
            gpt, _ = self.make_gpt(folder, [])
            source = types.SimpleNamespace(segment=[], video_img_urls=[], title='', tags='', _format=[], style='tutorial', extras='')
            signature = gpt._build_source_signature(source)
            gpt._save_checkpoint('fixture', 'old-signature', ['半截历史正文'], 'summarize')
            self.assertIsNone(gpt._load_checkpoint('fixture', signature))

    def test_visual_budget_failure_is_not_retried_without_images(self):
        namespace = UniversalGPT.summarize.__globals__
        original = namespace['RequestChunker']
        chunk_calls = []
        class RejectVisual:
            def __init__(self, *args): pass
            def chunk(self, segments, images, **kwargs):
                chunk_calls.append(images)
                raise ValueError('单张视频图片超过请求预算，未降级为无图')
        namespace['RequestChunker'] = RejectVisual
        try:
            with tempfile.TemporaryDirectory() as folder:
                gpt, model_calls = self.make_gpt(folder, [])
                source = types.SimpleNamespace(screenshot=True, link=True, segment=[], video_img_urls=['large-image'],
                    checkpoint_key='fixture', title='标题', tags='', _format=['link', 'screenshot'], style='tutorial', extras='',
                    video_image_ranges=[{'start': 0, 'end': 2}])
                with self.assertRaisesRegex(ValueError, '未降级为无图'):
                    gpt.summarize(source)
                self.assertEqual(chunk_calls, [['large-image']])
                self.assertEqual(model_calls, [])
                self.assertFalse(gpt._checkpoint_path('fixture').exists())
        finally:
            namespace['RequestChunker'] = original


if __name__ == '__main__':
    unittest.main()
