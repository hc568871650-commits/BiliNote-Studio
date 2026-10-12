import copy
import json
import os
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch

from app.models.generation_comparison import ComparisonRequest
from app.services import generation_comparisons as service, note_storage as notes
from app.gpt.universal_gpt import UniversalGPT


class ComparisonTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name)
        self.env = patch.dict(os.environ, {'GENERATION_COMPARISON_DIR': str(self.base / 'comparisons'), 'NOTE_OUTPUT_DIR': str(self.base / 'checkpoints')})
        self.env.start()
        self.old_root = notes.ROOT
        notes.ROOT = self.base / 'notes'
        service.ACTIVE.clear()
        service.CANCELLED.clear()
        self.note = {'id': 'source-note', 'status': 'SUCCESS', 'audioMeta': {'title': '合成测试'},
            'transcript': {'segments': [{'start': 0, 'end': 5, 'text': '设置半径为42，然后保存。'}]},
            'formData': {'style': 'tutorial', 'format': ['link']},
            'markdown': [{'ver_id': 'source-v1', 'content': '原始笔记，不得覆盖。', 'style': 'tutorial'}]}
        notes.save_task(self.note)
        self.request = {'task_id': 'source-note', 'version_id': 'source-v1', 'request_id': 'compare-request',
            'variants': [{'provider_id': 'mock', 'model_name': name, 'options': {'max_requests': 2}} for name in ('model-a', 'model-b')]}

    def tearDown(self):
        service.ACTIVE.clear()
        service.CANCELLED.clear()
        notes.ROOT = self.old_root
        self.env.stop()
        self.temp.cleanup()

    def fake(self, calls):
        def client(provider, model):
            def create(**kwargs):
                calls.append(copy.deepcopy(kwargs))
                return types.SimpleNamespace(choices=[types.SimpleNamespace(finish_reason='stop', message=types.SimpleNamespace(content='## 设置 *Content-[00:00]\n半径42，保存。'))],
                    usage=types.SimpleNamespace(prompt_tokens=40, completion_tokens=20, total_tokens=60))
            return UniversalGPT(types.SimpleNamespace(chat=types.SimpleNamespace(completions=types.SimpleNamespace(create=create))), model)
        return client

    def test_same_snapshot_two_models_and_original_unchanged(self):
        before = {str(p): p.read_bytes() for p in notes.ROOT.rglob('*') if p.is_file()}
        run = service.create_run(self.request, submit=False)
        calls = []
        with patch('app.services.ai_client.get_client', side_effect=self.fake(calls)):
            service.execute_run(run['id'])
        result = service.get_run(run['id'])
        self.assertEqual(result['status'], 'completed')
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0]['messages'], calls[1]['messages'])
        self.assertNotEqual(calls[0]['model'], calls[1]['model'])
        self.assertEqual(before, {str(p): p.read_bytes() for p in notes.ROOT.rglob('*') if p.is_file()})
        self.assertEqual(result['variants'][0]['report']['summary']['attempt_count'], 1)
        self.assertNotIn('markdown', service.list_runs('source-note')[0]['variants'][0])

    def test_idempotency_and_changed_request_rejected(self):
        first = service.create_run(self.request, submit=False)
        self.assertEqual(service.create_run(self.request, submit=False)['id'], first['id'])
        changed = copy.deepcopy(self.request)
        changed['variants'][1]['model_name'] = 'different'
        with self.assertRaisesRegex(ValueError, '请求ID'):
            service.create_run(changed, submit=False)

    def test_cancel_before_start_makes_no_call(self):
        run = service.create_run(self.request, submit=False)
        service.cancel_run(run['id'])
        with patch('app.services.ai_client.get_client') as get_client:
            service.execute_run(run['id'])
        get_client.assert_not_called()
        self.assertEqual(service.get_run(run['id'])['status'], 'cancelled')

    def test_restart_never_resubmits(self):
        run = service.create_run(self.request, submit=False)
        service.ACTIVE.clear()
        self.assertEqual(service.get_run(run['id'])['status'], 'interrupted')
        self.assertEqual(service.create_run(self.request, submit=False)['id'], run['id'])

    def test_missing_images_rejected_not_silently_downgraded(self):
        with self.assertRaisesRegex(ValueError, '没有可复用'):
            service.create_run(dict(self.request, use_images=True), submit=False)
        self.assertFalse(service.root().exists())

    def test_both_variants_receive_identical_frozen_images(self):
        import base64
        stage = self.base / 'stage'
        stage.mkdir()
        image = stage / 'frame.png'
        image.write_bytes(base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfasAAAAASUVORK5CYII='))
        notes.save_task({'id': 'source-note', 'markdown': [{'ver_id': 'vision-v1', 'content': '图像来源',
            'evidence': {'frames': [{'time': 2, 'path': 'frame.png', 'reason': 'test'}]}}]}, staging=stage)
        request = dict(self.request, version_id='vision-v1', use_images=True)
        run = service.create_run(request, submit=False)
        calls = []
        with patch('app.services.ai_client.get_client', side_effect=self.fake(calls)):
            service.execute_run(run['id'])
        self.assertEqual(service.get_run(run['id'])['status'], 'completed')
        self.assertEqual(calls[0]['messages'], calls[1]['messages'])
        self.assertEqual(run['source']['image_count'], 1)
        self.assertEqual(calls[0]['messages'][0]['content'][1]['type'], 'image_url')

    def test_mismatched_chunking_and_range_rejected(self):
        changed = copy.deepcopy(self.request)
        changed['variants'][1]['options']['chunk_seconds'] = 120
        with self.assertRaises(ValueError): ComparisonRequest.model_validate(changed)
        with self.assertRaises(ValueError): ComparisonRequest.model_validate(dict(self.request, start_time=20, end_time=10))
        with self.assertRaises(ValueError): service.get_run('../escape')

    def test_old_version_does_not_mix_latest_source(self):
        notes.save_task({'id': 'source-note', 'markdown': [{'ver_id': 'new-version', 'content': '新版本'}]})
        with self.assertRaisesRegex(ValueError, '最新版本'):
            service.create_run(self.request, submit=False)

    def test_executor_failure_releases_slot_without_calls(self):
        with patch.object(service.EXECUTOR, 'submit', side_effect=RuntimeError('closed')):
            with self.assertRaises(RuntimeError): service.create_run(self.request)
        self.assertFalse(service.ACTIVE)
        self.assertEqual(service.list_runs('source-note')[0]['status'], 'failed')

    def test_corrupt_snapshot_releases_slot(self):
        run = service.create_run(self.request, submit=False)
        (service.folder(run['id']) / 'source.json').write_text('broken', encoding='utf-8')
        service.execute_run(run['id'])
        self.assertFalse(service.ACTIVE)
        self.assertEqual(service.get_run(run['id'])['status'], 'failed')

    def test_transient_save_failure_preserves_completed_body(self):
        run = service.create_run(self.request, submit=False)
        calls, failed = [], []
        original = service.save
        def save(value):
            if any(v.get('markdown') for v in value['variants']) and not failed:
                failed.append(True)
                raise OSError('temporary')
            original(value)
        with patch('app.services.ai_client.get_client', side_effect=self.fake(calls)), patch.object(service, 'save', side_effect=save):
            service.execute_run(run['id'])
        self.assertEqual(len(calls), 1)
        result = service.get_run(run['id'])
        self.assertIn('42', result['variants'][0]['markdown'])
        self.assertTrue((service.folder(run['id']) / 'variant-0.md').exists())
        self.assertFalse(service.ACTIVE)

    def test_cancellation_stops_second_variant(self):
        calls = []
        factory = self.fake(calls)
        run = service.create_run(self.request, submit=False)
        def cancel_after_call(provider, model):
            gpt = factory(provider, model)
            original = gpt.summarize
            def summarize(source):
                value = original(source)
                service.cancel_run(run['id'])
                return value
            gpt.summarize = summarize
            return gpt
        with patch('app.services.ai_client.get_client', side_effect=cancel_after_call):
            service.execute_run(run['id'])
        self.assertEqual(len(calls), 1)
        self.assertEqual(service.get_run(run['id'])['status'], 'cancelled')


if __name__ == '__main__': unittest.main()
