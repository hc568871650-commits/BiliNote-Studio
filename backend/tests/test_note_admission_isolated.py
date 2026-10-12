"""Real router/status methods and durable storage, with no service startup/model calls."""
import ast
from dataclasses import dataclass
import hashlib
import json
import logging
import math
import os
from pathlib import Path
import shutil
import sys
import tempfile
import threading
import time
import types
import unittest
import uuid
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]


def methods(path, names, namespace, class_name=None):
    tree = ast.parse(path.read_text(encoding='utf-8-sig'))
    selected = [ast.ImportFrom(module='__future__', names=[ast.alias(name='annotations')], level=0)]
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name in names:
            node.decorator_list = []
            selected.append(node)
        elif isinstance(node, ast.ClassDef) and node.name == class_name:
            node.body = [x for x in node.body if isinstance(x, ast.FunctionDef) and x.name in names]
            selected.append(node)
    exec(compile(ast.fix_missing_locations(ast.Module(body=selected, type_ignores=[])), str(path), 'exec'), namespace)


class Response:
    @staticmethod
    def success(data):
        return {'code': 0, 'data': data}

    @staticmethod
    def error(msg='', code=500, data=None):
        return {'code': code, 'msg': msg, 'data': data}


class Request:
    def __init__(self, **changes):
        self.__dict__.update(video_url='local.mp4', platform='local', quality='medium', link=True,
                             screenshot=False, model_name='test', provider_id='test', format=['link'],
                             task_id='test-task', request_id='attempt-1', style='tutorial', extras=None,
                             video_understanding=False, video_interval=0, grid_size=[], frame_mode='dynamic',
                             prefetched_transcript=None)
        self.__dict__.update(changes)

    def model_dump(self, mode=None, exclude=()):
        return {k: v for k, v in vars(self).items() if k not in exclude}


class HTTPError(Exception):
    def __init__(self, status_code, detail):
        self.status_code, self.detail = status_code, detail


@dataclass
class Note:
    markdown: str = '# new result'
    transcript: dict = None
    audio_meta: dict = None


class AdmissionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        storage = types.ModuleType('isolated_storage')
        with patch.dict(os.environ, {'NOTE_OUTPUT_DIR': str(self.root / 'notes')}):
            exec(compile((ROOT / 'app/services/note_storage.py').read_text(encoding='utf-8-sig'), 'storage', 'exec'), storage.__dict__)
        self.storage = storage
        self.ns = {'Path': Path, 'json': json, 'hashlib': hashlib, 'uuid': uuid, 'os': os, 'math': math,
                   'shutil': shutil, 'logger': Mock(spec=logging.Logger), 'note_storage': storage,
                   'R': Response, 'HTTPException': HTTPError, 'NOTE_OUTPUT_DIR': storage.ROOT,
                   '_active_tasks': set(), '_active_requests': {}, '_active_lock': threading.RLock(),
                   'task_serial_executor': types.SimpleNamespace(run=lambda call: call())}
        exec(compile((ROOT / 'app/enmus/task_status_enums.py').read_text(), 'enums', 'exec'), self.ns)
        exec(compile((ROOT / 'app/models/transcriber_model.py').read_text(encoding='utf-8'), 'transcript', 'exec'), self.ns)
        methods(ROOT / 'app/services/note.py', {'_update_status', '_read_transcript_cache'}, self.ns, 'NoteGenerator')
        light = self.ns['NoteGenerator']
        self.constructed = 0
        owner = self

        class SlowGenerator(light):
            def __init__(self):
                owner.constructed += 1
                time.sleep(.1)  # would delay admission if it accidentally initializes

            def generate(self, **kwargs):
                return Note(transcript={'segments': [], 'full_text': 'test'},
                            audio_meta={'title': 'test', 'platform': 'local'})

        self.ns['NoteGenerator'] = SlowGenerator
        methods(ROOT / 'app/routers/note.py', {'generate_note', 'get_task_status', 'run_note_task', '_poll_result',
                                              '_persist_prefetched_transcript'}, self.ns)
        self.background = Mock()
        self.readiness = Mock(return_value={'ready': True})
        config = types.ModuleType('app.services.transcriber_config_manager')
        config.TranscriberConfigManager = lambda: types.SimpleNamespace(is_model_ready=self.readiness)
        vector = types.ModuleType('app.services.vector_store')
        vector.VectorStoreManager = Mock()
        self.modules = patch.dict(sys.modules, {'app.services.transcriber_config_manager': config,
                                                'app.services.vector_store': vector})
        self.modules.start()
        self.addCleanup(self.modules.stop)

    def admit(self, **changes):
        return self.ns['generate_note'](Request(**changes), self.background)

    def poll(self):
        return self.ns['get_task_status']('test-task')

    def test_admission_does_not_initialize_slow_transcriber_and_polls_pending(self):
        self.assertEqual(self.admit()['code'], 0)
        self.assertEqual(self.constructed, 0)
        self.background.add_task.assert_called_once()
        self.assertEqual(self.poll()['data']['status'], 'PENDING')
        self.assertEqual(self.poll()['data']['request_id'], 'attempt-1')
        self.readiness.assert_called_once()

    def test_duplicate_active_request_is_reused_without_check_or_queue(self):
        self.admit()
        self.readiness.side_effect = AssertionError('reconnect must skip readiness')
        self.assertTrue(self.admit()['data']['reused'])
        self.assertEqual(self.admit(extras='different')['code'], 409)
        self.assertEqual(self.admit(request_id='different')['code'], 409)
        self.background.add_task.assert_called_once()

    def test_not_ready_rejects_without_model_or_draft(self):
        self.readiness.return_value = dict(ready=False, reason='not ready', transcriber_type='fast-whisper',
                                          model_size='base', downloading=True)
        self.assertEqual(self.admit()['code'], 300102)
        self.assertEqual(self.constructed, 0)
        self.background.add_task.assert_not_called()
        self.assertEqual(self.poll()['code'], 404)

    def test_failed_status_is_success_envelope_with_diagnostic_message(self):
        self.admit()
        self.storage.set_status('test-task', 'FAILED')
        self.ns['NoteGenerator']._update_status('test-task', self.ns['TaskStatus'].FAILED, 'provider unavailable')
        result = self.poll()
        self.assertEqual(result['code'], 0)
        self.assertEqual({key: result['data'][key] for key in ('status', 'message', 'task_id', 'request_id', 'last_active_status')},
                         dict(status='FAILED', message='provider unavailable', task_id='test-task',
                              request_id='attempt-1', last_active_status='PENDING'))

    def test_missing_job_is_404_unknown_and_missing_status_is_unknown(self):
        self.assertEqual(self.poll()['code'], 404)
        self.assertEqual(self.poll()['data']['status'], 'UNKNOWN')
        self.admit()
        self.storage.status_path('test-task').unlink()
        self.assertEqual(self.poll()['data']['status'], 'UNKNOWN')
        self.assertEqual(self.poll()['data']['request_id'], 'attempt-1')

    def test_background_success_only_initializes_generator_once(self):
        self.admit()
        self.ns['run_note_task']('test-task', 'local.mp4', 'local', 'medium', model_name='test', provider_id='test')
        self.assertEqual(self.constructed, 1)
        self.assertEqual(self.poll()['data']['status'], 'SUCCESS')
        self.assertNotIn('test-task', self.ns['_active_tasks'])
        self.assertEqual(self.poll()['data']['request_id'], 'attempt-1')
        self.assertEqual(self.admit()['data']['status'], 'SUCCESS')
        self.assertEqual(self.admit(request_id=None)['data']['status'], 'SUCCESS')
        self.assertEqual(self.admit(extras='different')['code'], 409)
        self.background.add_task.assert_called_once()

    def test_background_failure_does_not_reinitialize_to_write_status(self):
        self.admit()
        self.ns['task_serial_executor'].run = Mock(side_effect=RuntimeError('worker failed'))
        self.ns['run_note_task']('test-task', 'local.mp4', 'local', 'medium', model_name='test', provider_id='test')
        self.assertEqual(self.constructed, 0)
        self.assertEqual(self.poll()['data']['status'], 'FAILED')
        self.assertEqual(self.poll()['data']['message'], 'worker failed')
        self.assertFalse(self.ns['_active_tasks'])

    def test_new_attempt_preserves_versions_and_updates_request_identity(self):
        self.admit()
        self.ns['run_note_task']('test-task', 'local.mp4', 'local', 'medium', model_name='test', provider_id='test')
        previous = self.storage.get_task('test-task')['markdown']
        self.assertEqual(self.admit(request_id='attempt-2', style='outline')['code'], 0)
        task = self.storage.get_task('test-task')
        self.assertEqual(task['markdown'], previous)
        self.assertEqual(task['formData']['request_id'], 'attempt-2')
        self.assertEqual(task['formData']['style'], 'outline')
        self.assertEqual(self.poll()['data']['request_id'], 'attempt-2')
        self.assertEqual(self.poll()['data']['status'], 'PENDING')
        self.assertEqual(self.background.add_task.call_count, 2)

    def test_simultaneous_matching_admissions_queue_once(self):
        barrier = threading.Barrier(2)
        self.readiness.side_effect = lambda: (barrier.wait(timeout=3), {'ready': True})[1]
        results = []
        threads = [threading.Thread(target=lambda: results.append(self.admit())) for _ in range(2)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=5)
        self.assertEqual(len(results), 2)
        self.assertTrue(all(result['code'] == 0 for result in results))
        self.background.add_task.assert_called_once()
        self.assertEqual(self.constructed, 0)

    def test_submission_failure_exposes_failed_state_and_releases_active(self):
        self.background.add_task.side_effect = RuntimeError('queue unavailable')
        with self.assertRaises(HTTPError):
            self.admit()
        self.assertEqual(self.poll()['data']['status'], 'FAILED')
        self.assertFalse(self.ns['_active_tasks'])
        self.assertFalse(self.ns['_active_requests'])

    def test_failure_detail_and_last_stage_survive_poll_reload_and_missing_status(self):
        self.admit()
        update = self.ns['NoteGenerator']._update_status
        update('test-task', 'SUMMARIZING')
        update('test-task', 'FAILED', 'finish_reason=length: output truncated')
        update('test-task', 'FAILED', 'finish_reason=length: output truncated')
        for task in (self.poll()['data'], self.storage.get_task('test-task'), self.storage.list_tasks()[0]):
            self.assertEqual(task['last_active_status'], 'SUMMARIZING')
            self.assertIn('finish_reason=length', task.get('message') or task.get('statusMessage'))
        self.storage.status_path('test-task').unlink()
        self.assertEqual(self.poll()['data']['last_active_status'], 'SUMMARIZING')
        self.assertIn('finish_reason=length', self.poll()['data']['message'])
        update('test-task', 'PENDING')
        self.assertEqual(self.poll()['data']['last_active_status'], 'PENDING')
        self.assertEqual(self.storage.get_task('test-task')['statusMessage'], '')

    def test_legacy_status_error_is_exposed_on_library_reload(self):
        self.admit()
        self.storage.status_path('test-task').write_text(json.dumps({
            'status': 'FAILED', 'message': 'legacy concrete error'}), encoding='utf-8')
        task = self.storage.get_task('test-task')
        self.assertEqual(task['statusMessage'], 'legacy concrete error')
        self.assertEqual(task['status'], 'FAILED')

    def test_restart_recovery_retains_actual_stage(self):
        self.admit()
        self.ns['NoteGenerator']._update_status('test-task', 'SUMMARIZING')
        self.assertEqual(self.storage.recover_interrupted_runs(), ['test-task'])
        self.assertEqual(self.poll()['data']['last_active_status'], 'SUMMARIZING')
        self.assertIn('中断', self.storage.get_task('test-task')['statusMessage'])

    def test_terminal_clock_is_fixed_and_new_attempt_resets_it(self):
        self.admit()
        update = self.ns['NoteGenerator']._update_status
        update('test-task', 'SUMMARIZING')
        update('test-task', 'FAILED', 'length')
        first = self.poll()['data']
        self.assertIsNotNone(first['started_at'])
        self.assertIsNotNone(first['finished_at'])
        update('test-task', 'FAILED', 'length')
        self.assertEqual(first['finished_at'], self.poll()['data']['finished_at'])
        self.assertEqual(first['finished_at'], self.storage.get_task('test-task')['finished_at'])
        update('test-task', 'PENDING')
        self.assertIsNone(self.poll()['data']['finished_at'])

    def test_title_is_available_before_generation_and_updated_from_metadata(self):
        self.admit(video_url=r'C:\videos\邮箱贴图1.mp4')
        self.assertEqual(self.poll()['data']['audio_meta']['title'], '邮箱贴图1')
        self.storage.update_audio_metadata('test-task', {'title': '解析得到的标题', 'duration': 3571})
        self.assertEqual(self.poll()['data']['audio_meta']['title'], '解析得到的标题')
        self.assertEqual(self.storage.get_task('test-task')['audioMeta']['title'], '解析得到的标题')

    def test_legacy_failed_task_reads_title_cache_and_stable_file_time(self):
        self.admit()
        manifest_path = self.storage._note_dir('test-task') / '_meta' / 'manifest.json'
        manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
        manifest['task']['audioMeta']['title'] = ''
        manifest_path.write_text(json.dumps(manifest), encoding='utf-8')
        self.storage.cache_path('test-task', 'audio').write_text(json.dumps({'title': '历史来源标题'}), encoding='utf-8')
        self.storage.status_path('test-task').write_text(json.dumps({'status': 'FAILED', 'message': 'length'}), encoding='utf-8')
        first = self.poll()['data']
        self.assertEqual(first['audio_meta']['title'], '历史来源标题')
        self.assertIsNotNone(first['finished_at'])
        self.assertEqual(first['finished_at'], self.poll()['data']['finished_at'])

    def test_retry_metadata_preserves_transcription_cache_after_model_failure(self):
        self.admit()
        cache = self.storage.cache_path('test-task', 'transcript')
        transcript = {'full_text': '已经完成的转写', 'segments': [{'start': 0, 'end': 2, 'text': '已经完成的转写'}]}
        cache.write_text(json.dumps(transcript), encoding='utf-8')
        self.ns['NoteGenerator']._update_status('test-task', 'FAILED', 'HTTP 413')
        self.ns['_active_tasks'].clear()
        self.ns['_active_requests'].clear()
        self.assertEqual(self.admit(request_id='attempt-2')['code'], 0)
        self.assertEqual(json.loads(cache.read_text(encoding='utf-8')), transcript)

    def test_failed_attempt_replay_is_idempotent_but_explicit_new_attempt_runs(self):
        self.admit()
        self.ns['task_serial_executor'].run = Mock(side_effect=RuntimeError('model failure'))
        self.ns['run_note_task']('test-task', 'local.mp4', 'local', 'medium', model_name='test', provider_id='test')
        self.background.reset_mock()
        response = self.admit()
        self.assertEqual(response['data']['status'], 'FAILED')
        self.assertTrue(response['data']['reused'])
        self.background.add_task.assert_not_called()
        self.assertEqual(self.admit(extras='changed')['code'], 409)
        self.assertEqual(self.admit(request_id='attempt-2')['code'], 0)
        self.background.add_task.assert_called_once()

    def test_valid_cached_subtitles_bypass_readiness_but_invalid_cache_does_not(self):
        self.admit()
        self.ns['NoteGenerator']._update_status('test-task', 'FAILED', 'model failure')
        self.ns['_active_tasks'].clear()
        self.ns['_active_requests'].clear()
        self.readiness.return_value = dict(ready=False, reason='not ready', transcriber_type='fast-whisper',
                                          model_size='base', downloading=True)
        cache = self.storage.cache_path('test-task', 'transcript')
        for content in ('{}', '{invalid', json.dumps({'segments': [{'start': -1, 'end': 1, 'text': 'bad'}]})):
            cache.write_text(content, encoding='utf-8')
            self.assertEqual(self.admit(request_id='attempt-2')['code'], 300102)
        cache.write_text(json.dumps({'segments': [{'start': 0, 'end': 1, 'text': 'ready'}]}), encoding='utf-8')
        self.readiness.reset_mock()
        self.assertEqual(self.admit(request_id='attempt-2')['code'], 0)
        self.readiness.assert_not_called()


if __name__ == '__main__':
    unittest.main()
