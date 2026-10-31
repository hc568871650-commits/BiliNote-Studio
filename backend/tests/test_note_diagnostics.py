"""Offline trace/privacy checks. Only TemporaryDirectory data is accessed."""
import io
import importlib.util
import json
import sys
import tempfile
import types
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

def _load_services():
    # These services are stdlib-only; avoid app.__init__ and its database startup.
    folder = Path(__file__).resolve().parents[1] / 'app' / 'services'
    storage_spec = importlib.util.spec_from_file_location('diagnostic_test_storage', folder / 'note_storage.py')
    storage = importlib.util.module_from_spec(storage_spec)
    storage_spec.loader.exec_module(storage)
    services = types.ModuleType('app.services')
    services.note_storage = storage
    spec = importlib.util.spec_from_file_location('diagnostic_test_service', folder / 'note_diagnostics.py')
    module = importlib.util.module_from_spec(spec)
    with patch.dict(sys.modules, {'app': types.ModuleType('app'), 'app.services': services}):
        spec.loader.exec_module(module)
    return storage, module


note_storage, diagnostics = _load_services()


class NoteDiagnosticsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'notes'
        self.patch_root = patch.object(note_storage, 'ROOT', self.root)
        self.patch_root.start()
        self.addCleanup(self.patch_root.stop)
        diagnostics._ACTIVE.clear()
        self.addCleanup(diagnostics._ACTIVE.clear)

    def test_historical_lookup_is_read_only(self):
        summary = diagnostics.get_summary('old-task')
        self.assertTrue(summary['historical'])
        self.assertIsNone(summary['trace_id'])
        self.assertEqual(summary['app_version'], 'unknown')
        self.assertIn('reporting_app_version', summary)
        self.assertFalse(self.root.exists())
        with self.assertRaises(ValueError):
            diagnostics.get_summary('../outside')

    def test_stages_outcomes_milliseconds_and_reload(self):
        trace = diagnostics.start_run('one', 'local-request')
        diagnostics.record_stage('one', 'PARSING')
        diagnostics.record_stage('one', 'SUMMARIZING')
        diagnostics.record_event('one', 'model_completed')
        diagnostics.record_event('one', 'content_saved')
        diagnostics.record_stage('one', 'SAVING')
        self.assertTrue(diagnostics.get_summary('one')['outcomes']['content_saved'])
        self.assertFalse(diagnostics.get_summary('one')['outcomes']['index_saved'])
        diagnostics.record_event('one', 'index_saved')
        diagnostics.record_stage('one', 'SUCCESS')
        summary = diagnostics.get_summary('one')
        self.assertEqual(summary['trace_id'], trace)
        self.assertFalse(summary['historical'])
        self.assertEqual([row['name'] for row in summary['stages']],
                         ['PARSING', 'SUMMARIZING', 'SAVING', 'SUCCESS'])
        self.assertTrue(all(row['duration_ms'] >= 0 for row in summary['stages']))
        self.assertTrue(all(summary['outcomes'].values()))
        self.assertNotIn('one', diagnostics._ACTIVE)
        self.assertTrue(all('pid' in event and 'thread_id' in event and 'elapsed_ms' in event
                            for event in summary['events']))

    def test_exception_bodies_and_unknown_fields_never_exported(self):
        secret = 'apikey=DO_NOT_EXPORT cookie=secret prompt=private https://secret.example/full'
        diagnostics.start_run('one', secret)
        diagnostics.record_event('one', 'replace_retry', attempt=1, errno=13, target='index',
                                 prompt=secret, url=secret, path=secret, message=secret, phase=secret)
        diagnostics.record_event('one', secret, prompt=secret)
        try:
            raise PermissionError(13, secret, 'C:/private/username/note.md')
        except PermissionError as exc:
            diagnostics.record_failure('one', exc)
        diagnostics.record_failure('one', RuntimeError('secondary failure'))
        summary = diagnostics.get_summary('one')
        self.assertEqual(summary['error']['category'], 'permission')
        self.assertEqual(summary['error']['type'], 'PermissionError')
        self.assertEqual(summary['error']['errno'], 13)
        self.assertEqual(set(summary['error']['frames'][0]), {'file', 'function', 'line'})
        with zipfile.ZipFile(io.BytesIO(diagnostics.export_bundle('one'))) as archive:
            output = '\n'.join(archive.read(name).decode() for name in archive.namelist())
        for forbidden in ('DO_NOT_EXPORT', 'secret.example', 'C:/private', 'secondary failure', 'source_line', 'locals'):
            self.assertNotIn(forbidden, output)

    def test_http_request_metadata_only(self):
        error = RuntimeError('raw upstream body with secret')
        error.status_code = 503
        error.response = types.SimpleNamespace(headers={'x-request-id': 'req-a123', 'authorization': 'hidden'})
        diagnostics.start_run('one')
        diagnostics.record_failure('one', error)
        summary = diagnostics.get_summary('one')
        self.assertEqual(summary['error']['http_status'], 503)
        self.assertEqual(summary['error']['request_id'], 'req-a123')
        self.assertNotIn('hidden', json.dumps(summary))
        error.response.headers['x-request-id'] = 'https://secret/private'
        self.assertIsNone(diagnostics.response_request_id(error))

    def test_event_run_and_global_retention(self):
        with patch.object(diagnostics, 'MAX_EVENTS', 5):
            diagnostics.start_run('one')
            for i in range(9):
                diagnostics.record_event('one', 'replace_retry', attempt=i)
            summary = diagnostics.get_summary('one')
            self.assertEqual(len(summary['events']), 5)
            self.assertEqual(summary['events_dropped'], 5)
        for _ in range(4):
            diagnostics.start_run('one')
        self.assertEqual(len(list((self.root / '_diagnostics' / 'one').glob('*.json'))), 3)
        with patch.object(diagnostics, 'MAX_BYTES', 800):
            for i in range(5):
                diagnostics.start_run('task-' + str(i))
        self.assertLessEqual(sum(p.stat().st_size for p in (self.root / '_diagnostics').glob('*/*.json')), 800)

    def test_retry_links_previous_trace_and_exports_bounded_runs(self):
        origin = diagnostics.start_run('one')
        diagnostics.record_stage('one', 'FAILED')
        latest = diagnostics.start_run('one')
        diagnostics.record_event('one', 'save_retry_started', origin_trace_id=origin,
                                 existed=True, read_only=False, parent_exists=True)
        diagnostics.record_event('one', 'model_completed', trace_id=origin)
        summary = diagnostics.get_summary('one')
        self.assertEqual(summary['origin_trace_id'], origin)
        self.assertIsNone(summary['outcomes']['model_completed'])
        self.assertEqual(summary['trace_id'], latest)
        with zipfile.ZipFile(io.BytesIO(diagnostics.export_bundle('one'))) as archive:
            self.assertEqual(len([name for name in archive.namelist() if name.startswith('runs/')]), 2)

    def test_saving_initializes_outcomes_without_resetting_progress(self):
        diagnostics.start_run('one')
        self.assertIsNone(diagnostics.get_summary('one')['outcomes']['index_saved'])
        diagnostics.record_event('one', 'model_completed')
        diagnostics.record_stage('one', 'SAVING')
        self.assertEqual(diagnostics.get_summary('one')['outcomes'],
                         {'model_completed': True, 'content_saved': False, 'index_saved': False})
        diagnostics.record_event('one', 'content_saved')
        diagnostics.record_stage('one', 'SAVING')
        self.assertTrue(diagnostics.get_summary('one')['outcomes']['content_saved'])
        diagnostics.record_stage('one', 'FAILED')
        diagnostics.start_run('one')
        diagnostics.record_stage('one', 'SAVING')
        self.assertEqual(diagnostics.get_summary('one')['outcomes'],
                         {'model_completed': None, 'content_saved': False, 'index_saved': False})

    def test_diagnostic_failures_do_not_raise_into_task(self):
        with patch.object(diagnostics, '_persist', side_effect=PermissionError('locked')):
            self.assertEqual(len(diagnostics.start_run('one')), 32)
            diagnostics.record_event('one', 'model_completed')
            diagnostics.record_stage('one', 'PARSING')
            diagnostics.record_failure('one', RuntimeError('primary'))
        self.assertEqual(diagnostics._ACTIVE['one']['error']['type'], 'RuntimeError')

    def test_zip_exports_storage_summary_and_guide(self):
        bundle = diagnostics.export_bundle('old', {'retry_available': True})
        with zipfile.ZipFile(io.BytesIO(bundle)) as archive:
            self.assertEqual(set(archive.namelist()),
                             {'README.txt', 'summary.json', 'events.json', 'system-capture-guide.txt'})
            value = json.loads(archive.read('summary.json'))
            self.assertTrue(value['historical'])
            self.assertTrue(value['storage']['retry_available'])

    def test_linked_directory_not_followed(self):
        with patch.object(Path, 'is_symlink', return_value=True):
            diagnostics.start_run('one')
            self.assertFalse(self.root.exists())
            with self.assertRaises(ValueError):
                diagnostics.get_summary('one')

    def test_disk_injection_is_filtered_and_oversized_file_is_skipped(self):
        trace = diagnostics.start_run('one')
        path = self.root / '_diagnostics' / 'one' / (trace + '.json')
        data = json.loads(path.read_text(encoding='utf-8'))
        data['prompt'] = 'DISK_SECRET'
        data['events'][0]['body'] = 'DISK_SECRET'
        data['error'] = dict(category='permission', type='PermissionError', message='DISK_SECRET',
                             request_id='sk-credential', frames=[dict(file='private_filename.py',
                             function='run', line=1, locals='DISK_SECRET', source_line='DISK_SECRET')])
        path.write_text(json.dumps(data), encoding='utf-8')
        summary = diagnostics.get_summary('one')
        self.assertIsNone(summary['error']['request_id'])
        self.assertEqual(summary['error']['frames'][0]['file'], '<external>')
        with zipfile.ZipFile(io.BytesIO(diagnostics.export_bundle('one'))) as archive:
            public = '\n'.join(archive.read(name).decode() for name in archive.namelist())
        self.assertNotIn('DISK_SECRET', public)
        self.assertNotIn('sk-credential', public)
        self.assertNotIn('private_filename', public)
        with patch.object(diagnostics, 'MAX_FILE_BYTES', 1):
            self.assertTrue(diagnostics.get_summary('one')['historical'])

    def test_build_version_and_runtime_are_bounded(self):
        root = Path(self.temp.name)
        (root / 'build-info.json').write_text(json.dumps({'version': '0.1.0-preview.15',
                                                       'secret': 'NEVER_EXPORT'}), encoding='utf-8')
        with patch.object(sys, '_MEIPASS', str(root), create=True):
            diagnostics.start_run('one')
        summary = diagnostics.get_summary('one')
        self.assertEqual(summary['app_version'], '0.1.0-preview.15')
        self.assertEqual(summary['schema_version'], 1)
        self.assertNotIn('NEVER_EXPORT', json.dumps(summary))
        self.assertNotIn(str(root), json.dumps(summary))

    def test_quota_and_reads_reject_directory_links_to_other_note_data(self):
        foreign = (self.root / 'actual-note' / 'private-data').resolve()
        foreign.mkdir(parents=True)
        protected = foreign / ('b' * 32 + '.json')
        protected.write_text('PRIVATE_NOTE_DATA', encoding='utf-8')
        base = (self.root / '_diagnostics').resolve()
        base.mkdir()
        linked = base / 'linked-task'
        try:
            linked.symlink_to(foreign, target_is_directory=True)
        except OSError:
            # resolve mismatch models a Windows junction without elevated setup.
            linked.mkdir()
        real_resolve = Path.resolve
        def resolve(path, *args, **kwargs):
            return real_resolve(foreign) if path == linked else real_resolve(path, *args, **kwargs)
        with patch.object(Path, 'resolve', resolve):
            self.assertEqual(diagnostics._trace_files(), [])
            with self.assertRaises(ValueError):
                diagnostics.get_summary('linked-task')
            with self.assertRaises(ValueError):
                diagnostics.export_bundle('linked-task')
            with patch.object(diagnostics, 'MAX_BYTES', 1):
                diagnostics.start_run('normal-task')
            self.assertEqual(protected.read_text(encoding='utf-8'), 'PRIVATE_NOTE_DATA')


if __name__ == '__main__':
    unittest.main()
