"""Actual diagnostic/retry router functions with temporary, real storage and traces.

AST loading avoids app startup and model dependencies; response wrappers only capture
the returned JSON/ZIP. No formal installation, service or model is accessed.
"""
import ast
import io
import json
import re
import sys
import tempfile
import threading
import types
import unittest
import zipfile
from datetime import datetime
from pathlib import Path
from unittest.mock import Mock, patch

from .test_note_diagnostics import _load_services


class Response:
    @staticmethod
    def success(data):
        return {'code': 0, 'data': data}

    @staticmethod
    def error(msg='', code=500, data=None):
        return {'code': code, 'msg': msg, 'data': data}


class StreamResponse:
    def __init__(self, content, media_type=None, headers=None):
        self.body = content.getvalue()
        self.media_type = media_type
        self.headers = headers


class NoteDiagnosticsRouteTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'private-note-output'
        self.storage, self.diagnostics = _load_services()
        self.storage.ROOT = self.root
        services = types.ModuleType('app.services')
        services.note_storage = self.storage
        services.note_diagnostics = self.diagnostics
        modules = patch.dict(sys.modules, {'app': types.ModuleType('app'), 'app.services': services,
            'app.services.note_storage': self.storage, 'app.services.note_diagnostics': self.diagnostics})
        modules.start()
        self.addCleanup(modules.stop)
        self.model = Mock(side_effect=AssertionError('retry-save must not construct a model/generator'))
        self.ns = dict(note_storage=self.storage, note_diagnostics=self.diagnostics,
                       _active_tasks=set(), _active_lock=threading.RLock(),
                       R=Response, StreamingResponse=StreamResponse, io=io, re=re,
                       datetime=datetime, NoteGenerator=self.model)
        path = Path(__file__).resolve().parents[1] / 'app/routers/note.py'
        names = {'_diagnostics_payload', 'get_note_diagnostics', 'export_note_diagnostics', 'retry_note_save'}
        selected = []
        for node in ast.parse(path.read_text(encoding='utf-8-sig')).body:
            if isinstance(node, ast.FunctionDef) and node.name in names:
                node.decorator_list = []
                selected.append(node)
        self.assertEqual(len(selected), len(names))
        exec(compile(ast.fix_missing_locations(ast.Module(body=selected, type_ignores=[])), str(path), 'exec'), self.ns)
        self.task = 'diagnostic-fixture'

    def draft(self, trace=False):
        if trace:
            self.diagnostics.start_run(self.task, 'request-one')
        self.storage.create_draft(self.task, {'platform': 'local', 'video_url': 'PRIVATE_SOURCE_PATH.mp4',
                                             'request_id': 'request-one'})
        self.storage.write_status(self.task, 'PENDING')
        self.storage.write_status(self.task, 'SAVING')
        self.folder = self.storage._note_dir(self.task)

    def publish(self, recoverable=True):
        return self.storage.save_task({'id': self.task, 'status': 'SUCCESS',
                                      'markdown': '# PRIVATE_NOTE_BODY_SENTINEL',
                                      'transcript': {'full_text': 'PRIVATE_TRANSCRIPT_SENTINEL'},
                                      'audioMeta': {'title': self.task, 'file_path': 'PRIVATE_AUDIO_PATH_SENTINEL'}},
                                     recoverable=recoverable)

    def failed_journal_task(self, missing_version=False, trace=True):
        self.draft(trace=trace)
        if trace:
            self.diagnostics.record_event(self.task, 'model_completed')
        if missing_version:
            real = self.storage._atomic_text
            def fail(path, content):
                if path.parent.name == 'versions':
                    raise PermissionError(13, 'PRIVATE_ERROR_BODY_SENTINEL')
                return real(path, content)
            function = '_atomic_text'
        else:
            real = self.storage._atomic_json
            def fail(path, content):
                if path.name == 'manifest.json':
                    raise PermissionError(13, 'PRIVATE_ERROR_BODY_SENTINEL')
                return real(path, content)
            function = '_atomic_json'
        with patch.object(self.storage, function, side_effect=fail):
            with self.assertRaises(PermissionError) as captured:
                self.publish()
        if trace:
            self.diagnostics.record_failure(self.task, captured.exception)
        self.storage.write_status(self.task, 'FAILED', 'PRIVATE_ERROR_BODY_SENTINEL')
        self.folder = self.storage._note_dir(self.task)
        self.assertTrue(self.storage.save_recovery_summary(self.task)['available'])

    def legacy_task(self):
        self.draft()
        self.publish(recoverable=False)
        self.storage.write_status(self.task, 'FAILED', '[WinError 5] PRIVATE_ERROR_BODY_SENTINEL')
        self.assertFalse((self.folder / '_meta/save-recovery.json').exists())

    def exported_text(self):
        response = self.ns['export_note_diagnostics'](self.task)
        self.assertIsInstance(response, StreamResponse)
        self.assertEqual(response.media_type, 'application/zip')
        self.assertEqual(response.headers['Cache-Control'], 'no-store')
        with zipfile.ZipFile(io.BytesIO(response.body)) as archive:
            return '\n'.join(archive.read(name).decode('utf-8') for name in archive.namelist())

    def test_historical_sensitive_timestamp_and_message_are_not_json_or_zip(self):
        self.legacy_task()
        status = self.storage.status_path(self.task)
        state = json.loads(status.read_text(encoding='utf-8'))
        state['finished_at'] = 'PRIVATE_TIME_SENTINEL'
        state['message'] = '[WinError 32] apikey=PRIVATE_APIKEY_SENTINEL'
        status.write_text(json.dumps(state), encoding='utf-8')
        response = self.ns['get_note_diagnostics'](self.task)
        self.assertEqual(response['code'], 0)
        summary = response['data']
        self.assertTrue(summary['historical'])
        self.assertIsNone(summary['stages'][0]['finished_at'])
        self.assertEqual(summary['error']['winerror'], 32)
        public = json.dumps(response) + self.exported_text()
        for secret in ('PRIVATE_TIME_SENTINEL', 'PRIVATE_APIKEY_SENTINEL', 'PRIVATE_NOTE_BODY_SENTINEL',
                       'PRIVATE_TRANSCRIPT_SENTINEL', 'PRIVATE_AUDIO_PATH_SENTINEL', str(self.root)):
            self.assertNotIn(secret, public)

    def test_legacy_summary_and_save_only_recovery(self):
        self.legacy_task()
        summary = self.ns['get_note_diagnostics'](self.task)['data']
        self.assertTrue(summary['historical'])
        self.assertTrue(summary['save_recovery']['available'])
        self.assertEqual(summary['stages'][0]['name'], 'SAVING')
        self.assertEqual(summary['error']['winerror'], 5)
        self.assertTrue(summary['outcomes']['content_saved'])
        before = {path.name: path.read_bytes() for path in (self.folder / 'versions').glob('*.md')}
        recovered = self.ns['retry_note_save'](self.task)
        self.assertEqual(recovered['code'], 0)
        self.assertEqual(recovered['data']['task']['status'], 'SUCCESS')
        self.assertEqual({path.name: path.read_bytes() for path in (self.folder / 'versions').glob('*.md')}, before)
        self.model.assert_not_called()

    def test_journal_restores_missing_version_with_same_id_and_no_model(self):
        self.failed_journal_task(missing_version=True)
        journal = json.loads((self.folder / '_meta/save-recovery.json').read_text(encoding='utf-8'))
        expected = journal['manifest']['task']['markdown'][0]['ver_id']
        self.assertEqual(list((self.folder / 'versions').glob('*.md')), [])
        result = self.ns['retry_note_save'](self.task)
        self.assertEqual(result['code'], 0)
        task = result['data']['task']
        self.assertEqual(len(task['markdown']), 1)
        self.assertEqual(task['markdown'][0]['ver_id'], expected)
        self.assertEqual((self.folder / 'versions' / (expected + '.md')).read_text(), '# PRIVATE_NOTE_BODY_SENTINEL')
        self.assertEqual(self.ns['retry_note_save'](self.task)['code'], 409)
        self.assertEqual(len(list((self.folder / 'versions').glob('*.md'))), 1)
        self.assertFalse((self.folder / '_meta/save-recovery.json').exists())
        self.model.assert_not_called()

    def test_concurrent_double_click_runs_one_save_only(self):
        self.failed_journal_task()
        entered, release = threading.Event(), threading.Event()
        original = self.storage.retry_saved_result
        result = []
        def delayed(task_id):
            entered.set()
            if not release.wait(3):
                raise AssertionError('test did not release save')
            return original(task_id)
        with patch.object(self.storage, 'retry_saved_result', side_effect=delayed) as retry:
            thread = threading.Thread(target=lambda: result.append(self.ns['retry_note_save'](self.task)))
            thread.start()
            try:
                self.assertTrue(entered.wait(3))
                blocked = self.ns['retry_note_save'](self.task)
                self.assertEqual(blocked['code'], 409)
                summary = self.ns['get_note_diagnostics'](self.task)['data']
                self.assertFalse(summary['save_recovery']['available'])
            finally:
                release.set()
                thread.join(3)
            self.assertFalse(thread.is_alive())
            self.assertEqual(retry.call_count, 1)
        self.assertEqual(result[0]['code'], 0)
        self.assertNotIn(self.task, self.ns['_active_tasks'])
        self.model.assert_not_called()

    def test_new_request_invalidates_old_journal_without_publishing(self):
        self.failed_journal_task()
        before = (self.folder / '笔记.md').read_bytes()
        self.storage.save_task({'id': self.task, 'formData': {'request_id': 'new-request'}})
        result = self.ns['retry_note_save'](self.task)
        self.assertEqual(result['code'], 409)
        self.assertEqual((self.folder / '笔记.md').read_bytes(), before)
        self.assertEqual(len(self.storage.get_task(self.task)['markdown']), 0)
        self.model.assert_not_called()

    def test_archived_task_refuses_recovery(self):
        self.failed_journal_task()
        self.storage.set_archived(self.task, True)
        self.assertEqual(self.ns['retry_note_save'](self.task)['code'], 409)
        self.assertTrue((self.folder / '_meta/save-recovery.json').exists())
        self.model.assert_not_called()

    def test_diagnostic_read_failure_does_not_block_successful_save(self):
        self.failed_journal_task()
        with patch.object(self.diagnostics, 'get_summary', side_effect=PermissionError('diagnostics locked')):
            result = self.ns['retry_note_save'](self.task)
        self.assertEqual(result['code'], 0)
        self.assertEqual(result['data']['task']['status'], 'SUCCESS')
        self.assertTrue(result['data']['diagnostics']['outcomes']['index_saved'])
        self.assertFalse((self.folder / '_meta/save-recovery.json').exists())
        self.model.assert_not_called()

    def test_export_keeps_safe_codes_frames_and_never_content(self):
        self.failed_journal_task()
        trace = self.diagnostics.start_run(self.task)
        error = PermissionError(13, 'PRIVATE_ERROR_BODY_SENTINEL apikey=PRIVATE_APIKEY_SENTINEL',
                                'C:/PRIVATE_FULL_PATH_SENTINEL/note.md')
        error.winerror = 32
        self.diagnostics.record_failure(self.task, error)
        path = self.root / '_diagnostics' / self.task / (trace + '.json')
        data = json.loads(path.read_text(encoding='utf-8'))
        data['error']['frames'] = [{'file': 'note_storage.py', 'function': '_replace_note_file', 'line': 42,
                                   'source_line': 'PRIVATE_SOURCE_SENTINEL', 'locals': 'PRIVATE_LOCALS_SENTINEL'},
                                  {'file': 'PRIVATE_SCRIPT_FILENAME.py', 'function': 'run', 'line': 1}]
        data['body'] = 'PRIVATE_BODY_INJECTED_SENTINEL'
        data['events'][0]['authorization'] = 'PRIVATE_APIKEY_SENTINEL'
        path.write_text(json.dumps(data), encoding='utf-8')
        summary = self.ns['get_note_diagnostics'](self.task)['data']
        self.assertEqual(summary['error']['winerror'], 32)
        self.assertEqual(summary['error']['frames'][0],
                         {'file': 'note_storage.py', 'function': '_replace_note_file', 'line': 42})
        self.assertEqual(summary['error']['frames'][1]['file'], '<external>')
        exported = self.exported_text()
        self.assertIn('_replace_note_file', exported)
        self.assertIn('note_storage.py', exported)
        for forbidden in ('PRIVATE_', str(self.root), 'save-recovery.json', 'manifest.json', 'transcript.json'):
            self.assertNotIn(forbidden, exported)

    def test_invalid_and_unknown_task_ids_return_safe_errors(self):
        self.assertEqual(self.ns['get_note_diagnostics']('../invalid')['code'], 400)
        self.assertEqual(self.ns['export_note_diagnostics']('missing')['code'], 404)
        self.assertEqual(self.ns['retry_note_save']('../invalid')['code'], 400)


if __name__ == '__main__':
    unittest.main()
