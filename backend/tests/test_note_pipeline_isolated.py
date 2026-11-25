"""Exercise real pipeline methods via AST, without importing app startup or services."""

import ast
from dataclasses import asdict, dataclass
import json
import logging
import math
from pathlib import Path
import tempfile
import types
import unittest
import uuid
from unittest.mock import Mock, patch


ROOT = Path(__file__).resolve().parents[1]


def load_pipeline():
    namespace = {'Path': Path, 'json': json, 'math': math, 'asdict': asdict,
                 'uuid': uuid, 'logger': Mock(spec=logging.Logger)}
    # These models/enums only import the standard library and have no app startup.
    for relative in ('app/models/audio_model.py', 'app/models/transcriber_model.py',
                     'app/enmus/task_status_enums.py', 'app/enmus/note_enums.py'):
        file = ROOT / relative
        exec(compile(file.read_text(encoding='utf-8-sig'), str(file), 'exec'), namespace)

    @dataclass
    class NoteResult:
        markdown: str
        transcript: object
        audio_meta: object
        evidence: object = None

    namespace['NoteResult'] = NoteResult
    namespace['prepend_source_link'] = lambda markdown, _: markdown
    namespace['VideoReader'] = Mock()
    namespace['note_diagnostics'] = Mock()
    source = ROOT / 'app/services/note.py'
    tree = ast.parse(source.read_text(encoding='utf-8-sig'), filename=str(source))
    methods = {
        'generate',
        '_download_media',
        '_get_transcript',
        '_transcribe_audio',
        '_prepare_video_evidence',
        '_prepare_local_image_evidence',
        '_summarize_text',
    }
    selected = [ast.ImportFrom(module='__future__', names=[ast.alias(name='annotations')], level=0)]
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name in {'_cache_task_id', '_read_transcript_cache'}:
            selected.append(node)
        elif isinstance(node, ast.ClassDef) and node.name == 'NoteGenerator':
            node.body = [method for method in node.body if isinstance(method, ast.FunctionDef) and method.name in methods]
            selected.append(node)
    module = ast.fix_missing_locations(ast.Module(body=selected, type_ignores=[]))
    exec(compile(module, str(source), 'exec'), namespace)
    return namespace


PIPELINE = load_pipeline()


class PipelineRegressionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.video = self.root / 'source.mp4'
        self.audio = self.root / 'audio.mp3'
        self.video.write_bytes(b'mocked video')
        self.audio.write_bytes(b'mocked audio')
        self.paths = {kind: self.root / f'test_{kind}.json' for kind in ('audio', 'transcript', 'markdown')}
        self.original_video = self.video.read_bytes()
        self.transcript = PIPELINE['TranscriptResult']('zh', '真实字幕', [PIPELINE['TranscriptSegment'](0, 5, '真实字幕')])
        self.audio_meta = PIPELINE['AudioDownloadResult'](str(self.audio), '测试', 6256.4, None, 'local', 'local-id', {}, str(self.video))
        self.downloader = Mock()
        self.downloader.download_subtitles.return_value = None
        self.downloader.download.return_value = self.audio_meta
        self.downloader.download_video.return_value = str(self.video)
        self.generator = PIPELINE['NoteGenerator']()
        self.generator.video_path = None
        self.generator.video_img_urls = []
        self.generator.run_dir = self.root / 'run'
        self.generator.transcriber = Mock()
        self.generator.transcriber.transcript.return_value = self.transcript
        self.generator._update_status = Mock()
        self.generator._handle_exception = Mock()
        self.generator._get_downloader = Mock(return_value=self.downloader)
        self.generator._get_gpt = Mock(return_value=types.SimpleNamespace())
        self.generator._summarize_text = Mock(return_value='# 生成笔记')
        self.generator._save_metadata = Mock()
        self.generator._post_process_markdown = Mock(return_value='# 截图笔记')
        self.storage = types.SimpleNamespace(cache_path=lambda task, kind: self.paths[kind], update_audio_metadata=Mock())
        self.reader = Mock()
        self.reader.return_value.run.return_value = ['mock-grid.jpg']
        self.reader.return_value.grouped_ranges = [{'start': 1, 'end': 1}]
        self.reader.return_value.evidence = [{'time': 1, 'reasons': ['stable_frame'],
                                              'path': str(self.generator.run_dir / 'frames' / 'frame_00_01_000.jpg'),
                                              'fingerprint': 'private-dedupe-hash'}]
        self.reader.return_value.duration = 6256.4
        self.patch = patch.dict(PIPELINE, {'note_storage': self.storage, 'VideoReader': self.reader})
        self.patch.start()
        self.addCleanup(self.patch.stop)

    def write_transcript(self, transcript):
        self.paths['transcript'].write_text(json.dumps(asdict(transcript), ensure_ascii=False), encoding='utf-8')

    def test_cancel_during_transcription_never_summarizes(self):
        class Cancelled(Exception):
            cancelled = True
        stopped = False
        def check():
            if stopped:
                raise Cancelled()
        def transcribe(**kwargs):
            nonlocal stopped
            stopped = True
            return self.transcript
        self.generator.generation_cancel_check = check
        self.generator.transcriber.transcript.side_effect = transcribe
        with self.assertRaises(Cancelled):
            self.generate()
        self.generator._summarize_text.assert_not_called()
        self.generator._save_metadata.assert_not_called()

    def test_cancel_after_model_discards_late_result(self):
        class Cancelled(Exception):
            cancelled = True
        stopped = False
        def check():
            if stopped:
                raise Cancelled()
        def summarize(**kwargs):
            nonlocal stopped
            stopped = True
            return '# late result'
        self.generator.generation_cancel_check = check
        self.generator._summarize_text.side_effect = summarize
        with self.assertRaises(Cancelled):
            self.generate()
        self.generator._save_metadata.assert_not_called()

    def generate(self, **kwargs):
        return self.generator.generate(str(self.video), 'local', task_id='test', output_path=str(self.root / 'run'), **kwargs)

    def test_empty_draft_cache_calls_real_transcription_path_then_summarizes(self):
        empty = PIPELINE['TranscriptResult']('zh', '', [])
        self.write_transcript(empty)
        result = self.generate()
        self.assertIsNotNone(result)
        self.generator.transcriber.transcript.assert_called_once_with(file_path=str(self.audio))
        self.generator._summarize_text.assert_called_once()
        self.assertEqual(result.transcript.full_text, '真实字幕')
        persisted = json.loads(self.paths['transcript'].read_text(encoding='utf-8'))
        self.assertEqual(len(persisted['segments']), 1)
        self.storage.update_audio_metadata.assert_called_once_with('test', asdict(self.audio_meta))

    def test_valid_cache_skips_subtitle_and_transcriber_calls(self):
        self.write_transcript(self.transcript)
        result = self.generate()
        self.assertIsNotNone(result)
        self.generator.transcriber.transcript.assert_not_called()
        self.downloader.download_subtitles.assert_not_called()
        self.generator._summarize_text.assert_called_once()

    def test_valid_cache_does_not_initialize_transcriber(self):
        self.write_transcript(self.transcript)
        self.generator.transcriber = None
        self.generator._init_transcriber = Mock(side_effect=AssertionError('must stay lazy'))
        self.assertIsNotNone(self.generate())
        self.generator._init_transcriber.assert_not_called()

    def test_missing_cache_initializes_transcriber_only_when_needed(self):
        engine = self.generator.transcriber
        self.generator.transcriber = None
        self.generator._init_transcriber = Mock(return_value=engine)
        self.assertIsNotNone(self.generate())
        self.generator._init_transcriber.assert_called_once()
        engine.transcript.assert_called_once()

    def test_empty_transcriber_output_does_not_call_summarize(self):
        self.write_transcript(PIPELINE['TranscriptResult']('zh', '', []))
        self.generator.transcriber.transcript.return_value = PIPELINE['TranscriptResult']('zh', '', [])
        self.assertIsNone(self.generate())
        self.generator.transcriber.transcript.assert_called_once()
        self.generator._summarize_text.assert_not_called()
        self.generator._save_metadata.assert_not_called()
        self.generator._update_status.assert_any_call('test', PIPELINE['TaskStatus'].FAILED,
            message='转写引擎未返回有效文本和时间戳，未调用笔记生成模型；请检查音轨或转写服务')

    def test_screenshot_only_selects_evidence_without_sending_images(self):
        result = self.generate(screenshot=True, _format=['screenshot'])
        self.assertIsNotNone(result)
        self.reader.return_value.extract_frames.assert_called_once()
        self.reader.return_value.run.assert_not_called()
        self.assertEqual(self.generator.video_img_urls, [])
        self.assertEqual(self.generator.video_image_ranges, [])
        self.assertEqual(self.generator.video_path, self.video)
        self.generator._post_process_markdown.assert_called_once()
        self.assertEqual(self.generator._post_process_markdown.call_args.kwargs['video_path'], self.video)
        self.assertEqual(self.video.read_bytes(), self.original_video)
        self.assertEqual(result.evidence['frame_mode'], 'dynamic')
        frame = result.evidence['frames'][0]
        self.assertEqual(frame['path'], 'frames/frame_00_01_000.jpg')
        self.assertNotIn('fingerprint', frame)
        self.assertEqual(frame['source_spans'], [{'start': 0, 'end': 5, 'text': '真实字幕'}])

    def test_video_understanding_constructs_reader_with_isolated_directories(self):
        result = self.generate(video_understanding=True)
        self.assertIsNotNone(result)
        self.reader.assert_called_once()
        params = self.reader.call_args.kwargs
        self.assertEqual(params['grid_size'], (2, 2))
        self.assertEqual(params['video_path'], str(self.video))
        self.assertTrue(Path(params['frame_dir']).is_relative_to(self.generator.run_dir))
        self.assertTrue(Path(params['grid_dir']).is_relative_to(self.generator.run_dir))
        self.assertEqual(self.generator.video_img_urls, ['mock-grid.jpg'])
        self.assertEqual(self.generator.video_image_ranges, [{'start': 1, 'end': 1}])
        self.assertEqual(result.evidence['video_image_ranges'], [{'start': 1, 'end': 1}])

    def test_summarize_source_includes_staged_actual_image_ranges(self):
        self.generator.video_image_ranges = [{'start': 2.0, 'end': 7.0}, {'start': 9.0, 'end': 9.0}]
        self.generator.frame_evidence = []
        source_factory = Mock(side_effect=lambda **kwargs: types.SimpleNamespace(**kwargs))
        gpt = Mock()
        gpt.summarize.return_value = '# 结果'
        with patch.dict(PIPELINE, {'GPTSource': source_factory}):
            result = PIPELINE['NoteGenerator']._summarize_text(self.generator, self.audio_meta, self.transcript,
                gpt, self.paths['markdown'], False, True, ['screenshot'], None, None, ['grid1', 'grid2'])
        self.assertEqual(result, '# 结果')
        source = gpt.summarize.call_args.args[0]
        self.assertEqual(source.video_image_ranges, self.generator.video_image_ranges)
        self.assertEqual(len(source.video_img_urls), len(source.video_image_ranges))

    def test_cached_screenshot_restores_video_path_without_audio_download(self):
        self.paths['audio'].write_text(json.dumps(asdict(self.audio_meta)), encoding='utf-8')
        self.assertIsNotNone(self.generate(screenshot=True, _format=['screenshot']))
        self.reader.return_value.extract_frames.assert_called_once()
        self.downloader.download.assert_not_called()
        self.downloader.download_video.assert_not_called()
        self.assertEqual(self.generator.video_path, self.video)
        self.assertEqual(self.generator._post_process_markdown.call_args.kwargs['video_path'], self.video)

    def test_legacy_audio_cache_recovers_missing_video_path(self):
        data = asdict(self.audio_meta)
        data['video_path'] = None
        self.paths['audio'].write_text(json.dumps(data), encoding='utf-8')
        self.assertIsNotNone(self.generate(screenshot=True))
        self.downloader.download.assert_not_called()
        self.downloader.download_video.assert_called_once_with(str(self.video))
        self.reader.return_value.extract_frames.assert_called_once()
        self.assertEqual(self.generator.video_path, self.video)

    def test_cached_video_understanding_uses_one_download_and_waits_for_transcription(self):
        data = asdict(self.audio_meta)
        data['video_path'] = None
        self.paths['audio'].write_text(json.dumps(data), encoding='utf-8')
        order = []
        self.generator.transcriber.transcript.side_effect = lambda **_: (order.append('transcript') or self.transcript)
        self.reader.return_value.run.side_effect = lambda: (order.append('frames') or ['grid'])
        self.assertIsNotNone(self.generate(video_understanding=True, frame_mode='fixed'))
        self.assertEqual(order, ['transcript', 'frames'])
        self.downloader.download_video.assert_called_once_with(str(self.video))
        self.downloader.download.assert_not_called()
        self.assertEqual(self.reader.call_args.kwargs['subtitle_segments'], self.transcript.segments)
        self.assertEqual(self.reader.call_args.kwargs['frame_mode'], 'fixed')

    def test_format_screenshot_alone_prepares_candidates_without_images(self):
        self.assertIsNotNone(self.generate(_format=['screenshot']))
        self.reader.return_value.extract_frames.assert_called_once()
        self.reader.return_value.run.assert_not_called()
        self.assertEqual(self.generator.video_img_urls, [])

    def _make_tiny_png(self, name: str) -> Path:
        import base64
        path = self.root / name
        path.write_bytes(base64.b64decode(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfasAAAAASUVORK5CYII='
        ))
        return path

    def test_same_generator_switches_between_video_and_static_text_post_without_leaking_ranges(self):
        png_path = self._make_tiny_png('post_img_1.png')
        post_transcript = PIPELINE['TranscriptResult'](
            'zh', '图文正文', [PIPELINE['TranscriptSegment'](0.0, 0.0, '图文正文')]
        )
        post_meta = PIPELINE['AudioDownloadResult'](
            '', 'X 图文测试', 0.0, None, 'x', 'x-post-1',
            {
                'media_kind': 'text_post',
                'local_images': [{'local_path': str(png_path), 'web_url': '/static/screenshots/x_1.png', 'caption': '配图1'}],
            },
            None,
        )

        # 1) 视频（开启 video_understanding）-> 产出带时间范围的视频图
        video_res = self.generate(video_understanding=True)
        self.assertIsNotNone(video_res)
        self.assertEqual(self.generator.video_img_urls, ['mock-grid.jpg'])
        self.assertEqual(self.generator.video_image_ranges, [{'start': 1, 'end': 1}])
        self.assertEqual(video_res.evidence['video_image_ranges'], [{'start': 1, 'end': 1}])

        # 清理缓存后，同一实例紧接着处理带静态图的图文
        for path in self.paths.values():
            path.unlink(missing_ok=True)
        post_downloader = Mock()
        post_downloader.download_subtitles.return_value = post_transcript
        post_downloader.is_text_post.return_value = True
        post_downloader.download.return_value = post_meta
        self.generator._get_downloader.return_value = post_downloader

        post_res = self.generator.generate(
            'https://x.com/demo/status/1', 'x', task_id='test', output_path=str(self.root / 'run'),
            video_understanding=True,
        )
        self.assertIsNotNone(post_res)
        self.assertEqual(len(self.generator.video_img_urls), 1)
        self.assertTrue(self.generator.video_img_urls[0].startswith('data:image/'))
        self.assertIsNone(self.generator.video_image_ranges)
        # 落盘 evidence 维持数组形状 []
        self.assertEqual(post_res.evidence['video_image_ranges'], [])

        # 3) 反向顺序：同一实例再处理视频，状态不串
        for path in self.paths.values():
            path.unlink(missing_ok=True)
        self.generator._get_downloader.return_value = self.downloader
        video_res_2 = self.generate(video_understanding=True)
        self.assertIsNotNone(video_res_2)
        self.assertEqual(self.generator.video_img_urls, ['mock-grid.jpg'])
        self.assertEqual(self.generator.video_image_ranges, [{'start': 1, 'end': 1}])
        self.assertEqual(video_res_2.evidence['video_image_ranges'], [{'start': 1, 'end': 1}])

    def test_local_image_evidence_producer_to_real_chunker_short_long_and_all_failed(self):
        from app.gpt.request_chunker import RequestChunker
        from app.models.gpt_model import GPTSource

        png_path = self._make_tiny_png('single_static.png')
        self.generator._prepare_local_image_evidence([
            {'local_path': str(png_path), 'web_url': '/static/screenshots/single.png'},
        ])
        self.assertEqual(len(self.generator.video_img_urls), 1)
        self.assertIsNone(self.generator.video_image_ranges)

        def builder(segs, imgs, **_):
            return [{'role': 'user', 'content': ''.join(s.text for s in segs) + '|'.join(imgs)}]

        # 短文本与超长文本均须通过真实 RequestChunker
        for segments in (
            [PIPELINE['TranscriptSegment'](0.0, 0.0, '短图文')],
            [PIPELINE['TranscriptSegment'](0.0, 0.0, f'段落{i}' * 120) for i in range(10)],
        ):
            src = GPTSource(
                segment=segments, title='静态图测试', tags='',
                video_img_urls=list(self.generator.video_img_urls),
                video_image_ranges=self.generator.video_image_ranges,
            )
            chunker = RequestChunker(builder, max_bytes=1024 * 1024, max_text_chars=500)
            chunks = chunker.chunk(src.segment, src.video_img_urls, video_image_ranges=src.video_image_ranges)
            self.assertGreaterEqual(len(chunks), 1)
            self.assertEqual([img for c in chunks for img in c.image_urls], src.video_img_urls)

        # 文件缺失或空文件导致编码全部失败 -> urls=[] 且 ranges=[]，可通过分块器
        empty_file = self.root / 'empty.png'
        empty_file.write_bytes(b'')
        self.generator._prepare_local_image_evidence([
            {'local_path': str(self.root / 'missing.png')},
            {'local_path': str(empty_file)},
        ])
        self.assertEqual(self.generator.video_img_urls, [])
        self.assertEqual(self.generator.video_image_ranges, [])
        chunker = RequestChunker(builder, max_bytes=1024 * 1024, max_text_chars=500)
        chunks = chunker.chunk(
            [PIPELINE['TranscriptSegment'](0.0, 0.0, '仅文本')],
            self.generator.video_img_urls,
            video_image_ranges=self.generator.video_image_ranges,
        )
        self.assertEqual(len(chunks), 1)
        self.assertEqual(chunks[0].image_urls, [])

    def test_video_understanding_empty_frames_raises_explicit_error(self):
        self.reader.return_value.run.return_value = []
        self.reader.return_value.grouped_ranges = []
        self.generator.video_path = self.video
        with self.assertRaisesRegex(ValueError, '未取得视频画面'):
            self.generator._prepare_video_evidence(
                self.transcript, 'test', frame_mode='dynamic', video_understanding=True
            )
        # 完整 generate 链路也必须失败收敛，不得静默进入总结
        result = self.generate(video_understanding=True)
        self.assertIsNone(result)
        self.generator._summarize_text.assert_not_called()
        failed_calls = [
            call for call in self.generator._update_status.call_args_list
            if len(call.args) >= 2 and call.args[1] == PIPELINE['TaskStatus'].FAILED
        ]
        self.assertTrue(failed_calls)
        self.assertIn('未取得视频画面', failed_calls[-1].kwargs.get('message', ''))


if __name__ == '__main__':
    unittest.main()
