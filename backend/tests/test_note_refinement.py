"""Offline refinement acceptance tests with real temporary note storage.

Run standalone; app bootstrap is deliberately bypassed. Models and frame extraction
are mocked, and no installed application, credentials, or video are read.
"""
import importlib
import json
import math
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import Mock, patch

BACKEND = Path(__file__).resolve().parents[1]


def bootstrap():
    sys.path.insert(0, str(BACKEND))
    app = types.ModuleType('app')
    app.__path__ = [str(BACKEND / 'app')]
    if 'app' not in sys.modules:
        sys.modules['app'] = app
    return importlib.import_module('app.services.note_storage'), importlib.import_module('app.services.note_refinement')


NOTES, REFINE = bootstrap()
from app.models.audio_model import AudioDownloadResult
from app.models.notes_model import NoteResult
from app.models.transcriber_model import TranscriptResult, TranscriptSegment
CONTENT = ('# 测试教程\n\n## 第一节 [原片 @ 00:10](https://example.invalid?t=10)\n\n'
           '初始步骤。\n\n第二段说明。\n\n'
           '## 第二节 [原片 @ 01:00](https://example.invalid?t=60)\n\n其余步骤。')


class RefinementTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.storage = patch.object(NOTES, 'ROOT', self.root / 'notes')
        self.storage.start()
        self.addCleanup(self.storage.stop)
        self.task = self.save_task()
        self.client = Mock()
        self.get_client = patch.object(REFINE, 'get_client', return_value=types.SimpleNamespace(client=self.client))
        self.complete = patch.object(REFINE, 'complete', return_value=(self.response('修订步骤。'), {'usage': {}}))
        self.get_client_mock = self.get_client.start()
        self.complete_mock = self.complete.start()
        self.addCleanup(self.get_client.stop)
        self.addCleanup(self.complete.stop)

    @staticmethod
    def response(content, finish='stop'):
        return types.SimpleNamespace(choices=[types.SimpleNamespace(finish_reason=finish,
            message=types.SimpleNamespace(content=content, tool_calls=None))])

    def save_task(self, content=CONTENT, task_id='refine-test', segments=None, duration=120):
        return NOTES.save_task({'id': task_id, 'status': 'SUCCESS', 'createdAt': '2026-10-11T00:00:00Z',
            'audioMeta': {'title': '测试教程', 'duration': duration, 'platform': 'local', 'video_id': 'local-test'},
            'formData': {'platform': 'local', 'video_url': '', 'provider_id': 'old-provider', 'model_name': 'old-model'},
            'transcript': {'segments': segments if segments is not None else [
                {'start': 0, 'end': 12, 'text': '前置对象。'},
                {'start': 12, 'end': 35, 'text': '设置参数为 2 mm。'},
                {'start': 35, 'end': 65, 'text': '最后修正为 3 mm。'},
                {'start': 65, 'end': 120, 'text': '其余步骤。'}]},
            'markdown': [{'ver_id': 'original', 'content': content, 'style': 'tutorial',
                'model_name': 'old-model', 'created_at': '2026-10-11T00:00:00Z'}]})

    def request(self, **overrides):
        return dict(version_id='original', texts=['初始步骤。'], start_time=10, end_time=60,
                    provider_id='new-provider', model_name='new-model', protocol='anthropic',
                    instruction='请核对参数。', use_video=False, **overrides)

    def preview(self, **overrides):
        data = self.request()
        data.update(overrides)
        return REFINE.preview('refine-test', data)

    def note_snapshot(self):
        folder = NOTES._note_dir('refine-test')
        return {path.relative_to(folder).as_posix(): path.read_bytes() for path in folder.rglob('*') if path.is_file()}

    def fake_video_reader(self, image_available=True):
        module = types.ModuleType('app.utils.video_reader')
        class Reader:
            def __init__(reader, path, **options):
                reader.options = options
                reader.evidence = []

            def run(reader):
                directory = Path(reader.options['frame_dir'])
                directory.mkdir(parents=True)
                frame = directory / 'frame_00_20_000.jpg'
                frame.write_bytes(b'new-frame-evidence')
                reader.evidence = [{'time': 20, 'reason': 'subtitle_step', 'path': str(frame)}]
                return ['data:image/jpeg;base64,bW9ja2Vk'] if image_available else []
        module.VideoReader = Reader
        video = self.root / 'source.mp4'
        video.write_bytes(b'offline fake video')
        return patch.dict(sys.modules, {'app.utils.video_reader': module}), patch.object(REFINE, 'local_video', return_value=video)

    def test_contiguous_selection_is_located_as_exact_source(self):
        task, version, content, begin, end = REFINE.selected_source('refine-test', 'original', ['初始步骤。', '第二段说明。'])
        self.assertEqual(content[begin:end], '初始步骤。\n\n第二段说明。')
        self.assertEqual(task['id'], 'refine-test')
        self.assertEqual(version['ver_id'], 'original')

    def test_duplicate_and_noncontiguous_selections_are_rejected(self):
        for texts in (['初始步骤。', '初始步骤。'], ['初始步骤。', '其余步骤。'], ['初始步骤。', '步骤。'], ['不存在'], []):
            with self.subTest(texts=texts), self.assertRaises(ValueError):
                REFINE.selected_source('refine-test', 'original', texts)
        self.save_task('同文。\n\n同文。', task_id='duplicate')
        with self.assertRaises(ValueError):
            REFINE.selected_source('duplicate', 'original', ['同文。'])

    def test_context_uses_heading_anchors_and_not_prose_numbers(self):
        context = REFINE.source_context('refine-test', 'original', ['初始步骤。'])
        self.assertEqual((context['start_time'], context['end_time']), (10, 60))
        text = '# 教程\n\n在 00:10 设置参数。\n\n操作内容。'
        begin = text.index('操作内容。')
        self.assertEqual(REFINE.infer_window(text, begin, len(text), 120), (None, None))

    def test_hour_anchor_and_last_heading_duration(self):
        text = '# 教程\n\n## 操作 Content-[01:02:03]\n\n实际步骤。'
        begin = text.index('实际步骤。')
        self.assertEqual(REFINE.infer_window(text, begin, len(text), 3800), (3723, 3800))
        self.assertEqual(REFINE.infer_window(text, begin, len(text), 5000), (None, None))

    def test_supported_heading_time_formats_infer_same_window(self):
        for marker in ('(00:10)', 'Content-[00:10]', '[原片 @ 00:10](https://example.invalid?t=10)'):
            text = f'## 第一节 {marker}\n\n步骤。\n\n## 第二节 Content-[01:00]\n\n其他内容。'
            begin = text.index('步骤。')
            with self.subTest(marker=marker):
                self.assertEqual(REFINE.infer_window(text, begin, begin + len('步骤。'), 120), (10, 60))

    def test_no_transcript_rejected_without_model_call(self):
        self.save_task(segments=[], task_id='no-subtitles')
        with self.assertRaises(ValueError):
            REFINE.preview('no-subtitles', self.request())
        self.get_client_mock.assert_not_called()

    def test_invalid_time_window_rejected_without_model_call(self):
        for start, end in ((math.nan, 60), (10, math.inf), (-1, 60), (60, 60), (70, 60), (0, 901), (10, 121)):
            with self.subTest(start=start, end=end), self.assertRaises(ValueError):
                self.preview(start_time=start, end_time=end)
        self.get_client_mock.assert_not_called()

    def test_15_minute_window_is_allowed_at_boundary(self):
        self.save_task(task_id='long', duration=1000)
        result = REFINE.preview('long', dict(self.request(), start_time=0, end_time=900))
        self.assertEqual(result['end_time'], 900)
        with self.assertRaises(ValueError):
            REFINE.preview('long', dict(self.request(), start_time=0, end_time=900.01))

    def test_source_segments_overlap_window_without_boundary_leak(self):
        result = self.preview(start_time=12, end_time=35)
        self.assertEqual(result['evidence']['transcript'], [{'start': 12, 'end': 35, 'text': '设置参数为 2 mm。'}])
        prompt = json.loads(self.complete_mock.call_args.args[2][1]['content'])
        self.assertEqual(prompt['range'], [12, 35])
        self.assertEqual(prompt['original_transcript'], result['evidence']['transcript'])
        self.assertFalse(prompt['images_provided'])

    def test_preview_does_not_modify_original_note(self):
        before = self.note_snapshot()
        result = self.preview()
        self.assertEqual(self.note_snapshot(), before)
        self.assertEqual(result['before'], '初始步骤。')
        self.assertEqual(result['after'], '修订步骤。')
        self.assertTrue((REFINE.draft_dir('refine-test', result['draft_id']) / 'draft.json').is_file())
        self.client.close.assert_called_once()

    def test_apply_adds_new_version_preserves_source_and_model_identity(self):
        result = self.preview()
        updated = REFINE.apply('refine-test', result['draft_id'])
        self.assertEqual(len(updated['markdown']), 2)
        new, old = updated['markdown']
        self.assertEqual(old['content'], CONTENT)
        self.assertEqual(old['ver_id'], 'original')
        self.assertEqual(new['content'], CONTENT.replace('初始步骤。', '修订步骤。'))
        self.assertEqual(new['model_name'], 'new-model')
        self.assertEqual(new['provider_id'], 'new-provider')
        self.assertEqual(new['protocol'], 'anthropic')
        self.assertEqual(new['refinement']['parent_version'], 'original')

    def test_apply_is_idempotent(self):
        result = self.preview()
        first = REFINE.apply('refine-test', result['draft_id'])
        before = self.note_snapshot()
        second = REFINE.apply('refine-test', result['draft_id'])
        self.assertEqual(first, second)
        self.assertEqual(self.note_snapshot(), before)

    def test_second_draft_conflicts_after_first_is_accepted(self):
        first, second = self.preview(), self.preview()
        REFINE.apply('refine-test', first['draft_id'])
        snapshot = self.note_snapshot()
        with self.assertRaises(ValueError):
            REFINE.apply('refine-test', second['draft_id'])
        self.assertEqual(self.note_snapshot(), snapshot)

    def test_changed_original_hash_rejects_apply_without_further_changes(self):
        result = self.preview()
        folder = NOTES._note_dir('refine-test')
        path = folder / '_meta' / 'manifest.json'
        manifest = json.loads(path.read_text(encoding='utf-8'))
        manifest['task']['markdown'][0]['content'] += '\n\n外部修订。'
        NOTES._atomic_json(path, manifest)
        before = self.note_snapshot()
        with self.assertRaises(ValueError):
            REFINE.apply('refine-test', result['draft_id'])
        self.assertEqual(self.note_snapshot(), before)

    def test_expired_draft_rejects_apply(self):
        result = self.preview()
        path = REFINE.draft_dir('refine-test', result['draft_id']) / 'draft.json'
        draft = json.loads(path.read_text(encoding='utf-8'))
        with patch.object(REFINE.time, 'time', return_value=draft['created'] + 86401), self.assertRaises(ValueError):
            REFINE.apply('refine-test', result['draft_id'])
        self.assertEqual(len(NOTES.get_task('refine-test')['markdown']), 1)

    def test_frame_asset_rejects_traversal_and_unknown_extensions(self):
        for name in ('../draft.json', 'draft.json', 'frame_00_20_000.png', 'frame_00_20_000.jpg'):
            with self.subTest(name=name), self.assertRaises(ValueError):
                REFINE.frame_asset('refine-test', 'missing-draft', name)

    def test_archived_note_rejects_context_preview_and_apply(self):
        result = self.preview()
        NOTES.set_archived('refine-test', True)
        snapshot = self.note_snapshot()
        for operation in (lambda: REFINE.source_context('refine-test', 'original', ['初始步骤。']),
                          lambda: self.preview(), lambda: REFINE.apply('refine-test', result['draft_id'])):
            with self.assertRaises(ValueError):
                operation()
        self.assertEqual(self.note_snapshot(), snapshot)

    def test_fenced_empty_and_missing_choices_reject_without_note_change(self):
        snapshot = self.note_snapshot()
        for response in (self.response('```markdown\n\n```'), types.SimpleNamespace(choices=[])):
            self.complete_mock.return_value = response, {}
            with self.subTest(response=response), self.assertRaises(ValueError):
                self.preview()
        self.assertEqual(self.note_snapshot(), snapshot)
        self.assertEqual(self.client.close.call_count, 2)

    def test_model_truncation_rejected(self):
        self.complete_mock.return_value = self.response('未完成的步骤', 'length'), {}
        with self.assertRaises(ValueError):
            self.preview()
        self.assertEqual(len(NOTES.get_task('refine-test')['markdown']), 1)

    def test_without_video_new_images_or_screenshots_rejected(self):
        for answer in ('修订 *Screenshot-[00:20]', '![未经核对](https://example.invalid/new.jpg)'):
            self.complete_mock.return_value = self.response(answer), {}
            with self.subTest(answer=answer), self.assertRaises(ValueError):
                self.preview()

    def test_video_request_with_no_images_is_rejected(self):
        frame_patch, video_patch = self.fake_video_reader(image_available=False)
        with frame_patch, video_patch, self.assertRaises(ValueError):
            self.preview(use_video=True)
        self.get_client_mock.assert_not_called()

    def test_screenshots_copied_to_new_version_and_old_assets_preserved(self):
        stage = self.root / 'old-staging'
        (stage / 'images').mkdir(parents=True)
        (stage / 'images' / 'old.jpg').write_bytes(b'old-image')
        content = CONTENT + '\n\n![旧图](images/old.jpg)'
        # A distinct ID allows the initial version to be persisted with its image.
        NOTES.save_task({'id': 'images', 'status': 'SUCCESS', 'audioMeta': self.task['audioMeta'],
            'formData': self.task['formData'], 'transcript': self.task['transcript'],
            'markdown': [{'ver_id': 'original', 'content': content, 'style': 'tutorial', 'model_name': 'old-model'}]}, staging=stage)
        original = NOTES.get_task('images')['markdown'][0]['content']
        old_url = NOTES.IMAGE_LINK.search(original)[2]
        old_asset = NOTES.asset('images', 'versions/' + old_url)
        self.complete_mock.return_value = self.response('修订步骤。\n\n*Screenshot-[00:20]'), {}
        frame_patch, video_patch = self.fake_video_reader()
        with frame_patch, video_patch:
            result = REFINE.preview('images', dict(self.request(), use_video=True))
        self.assertEqual(len(result['evidence']['frames']), 1)
        frame = result['evidence']['frames'][0]
        self.assertTrue(frame['image_url'].startswith('/api/notes/images/refine/'))
        updated = REFINE.apply('images', result['draft_id'])
        self.assertEqual(updated['markdown'][1]['content'], original)
        links = [m[2] for m in NOTES.IMAGE_LINK.finditer(updated['markdown'][0]['content'])]
        self.assertEqual(len(links), 2)
        self.assertEqual(NOTES.asset('images', 'versions/' + links[0]).read_bytes(), b'new-frame-evidence')
        self.assertEqual(old_asset.read_bytes(), b'old-image')
        self.assertEqual(NOTES.asset('images', 'versions/' + links[1]).read_bytes(), b'old-image')

    def evidence_note(self, evidence, markdown=CONTENT):
        return NoteResult(markdown=markdown,
            transcript=TranscriptResult('zh', '设置参数为 2 mm。', [TranscriptSegment(12, 35, '设置参数为 2 mm。')]),
            audio_meta=AudioDownloadResult('', '测试教程', 120, None, 'local', 'offline-video', {}),
            evidence=evidence)

    def test_save_result_evidence_survives_staging_move_and_preserves_source_spans(self):
        stage = self.root / 'generated-staging'
        for folder in ('frames', 'images'):
            (stage / folder).mkdir(parents=True)
        (stage / 'frames' / 'frame_00_20_000.jpg').write_bytes(b'generated-candidate')
        (stage / 'images' / 'screenshot.jpg').write_bytes(b'generated-screenshot')
        spans = [{'start': 12, 'end': 35, 'text': '设置参数为 2 mm。'}]
        evidence = {'schema_version': 1, 'duration': 120, 'frame_mode': 'dynamic',
            'frames': [{'time': 20, 'reason': 'subtitle_step', 'path': 'frames/frame_00_20_000.jpg', 'source_spans': spans}],
            'screenshots': [{'time': 20, 'path': 'images/screenshot.jpg', 'source_spans': spans}]}
        saved = NOTES.save_result('refine-test', self.evidence_note(evidence, CONTENT + '\n\n![生成截图](images/screenshot.jpg)'), staging=stage)
        published = saved['markdown'][0]['evidence']
        self.assertEqual(published['frames'][0]['source_spans'], spans)
        self.assertEqual(published['screenshots'][0]['source_spans'], spans)
        self.assertEqual(evidence['frames'][0]['path'], 'frames/frame_00_20_000.jpg')
        self.assertEqual(evidence['screenshots'][0]['path'], 'images/screenshot.jpg')
        self.assertNotIn(str(stage), json.dumps(published))
        stage.rename(self.root / 'moved-away-staging')
        self.assertFalse(stage.exists())
        for group, expected in (('frames', b'generated-candidate'), ('screenshots', b'generated-screenshot')):
            for item in published[group]:
                self.assertTrue(item['path'].startswith('../images/'))
                self.assertFalse(Path(item['path']).is_absolute())
                self.assertEqual(NOTES.asset('refine-test', 'versions/' + item['path']).read_bytes(), expected)
        image_url = NOTES.IMAGE_LINK.search(saved['markdown'][0]['content'])[2]
        self.assertEqual(NOTES.asset('refine-test', 'versions/' + image_url).read_bytes(), b'generated-screenshot')
        self.assertEqual(saved['markdown'][1]['content'], CONTENT)

    def test_save_result_rejects_evidence_path_escape_without_publishing_version(self):
        stage = self.root / 'unsafe-staging'
        stage.mkdir()
        outside = self.root / 'outside.jpg'
        outside.write_bytes(b'must-not-be-published')
        before = self.note_snapshot()
        for group in ('frames', 'screenshots'):
            for path in ('../outside.jpg', str(outside.resolve())):
                evidence = {group: [{'time': 20, 'path': path}]}
                with self.subTest(group=group, path=path), self.assertRaises(ValueError):
                    NOTES.save_result('refine-test', self.evidence_note(evidence), staging=stage)
                self.assertEqual(self.note_snapshot(), before)
        self.assertEqual(outside.read_bytes(), b'must-not-be-published')


if __name__ == '__main__':
    unittest.main()
