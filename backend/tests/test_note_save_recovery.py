"""Save recovery fault injection; no models, real notes or running services."""
import errno
import importlib.util
import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import Mock, patch

SOURCE = Path(__file__).resolve().parents[1] / 'app/services/note_storage.py'
spec = importlib.util.spec_from_file_location('save_recovery_storage', SOURCE)
storage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(storage)


class SaveRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.old_root = storage.ROOT
        storage.ROOT = self.root / 'notes'
        self.addCleanup(setattr, storage, 'ROOT', self.old_root)
        self.events = Mock()
        self.diag = patch.object(storage, '_diagnostic', self.events)
        self.diag.start(); self.addCleanup(self.diag.stop)
        self.sleep = patch.object(storage.time, 'sleep')
        self.sleep.start(); self.addCleanup(self.sleep.stop)
        self.task_id = 'save-fixture'
        storage.create_draft(self.task_id, {'video_url': 'fixture.mp4', 'request_id': 'run-1', 'model_name': 'mock'})
        storage.write_status(self.task_id, 'PENDING')
        storage.write_status(self.task_id, 'SAVING')
        self.folder = storage._note_dir(self.task_id)
        self.real_replace = storage.os.replace

    def publish(self):
        return storage.save_task({'id': self.task_id, 'status': 'SUCCESS', 'markdown': '# Generated private fixture\n',
                                  'transcript': {'full_text': 'private transcript'}, 'audioMeta': {'title': 'Fixture'}}, recoverable=True)

    def fail_manifest(self):
        def replace(source, target):
            if Path(target).name == 'manifest.json':
                raise PermissionError(errno.EACCES, 'private upstream message')
            return self.real_replace(source, target)
        with patch.object(storage.os, 'replace', side_effect=replace):
            with self.assertRaises(PermissionError):
                self.publish()
        storage.write_status(self.task_id, 'FAILED', 'fixture manifest write denied')
        self.folder = storage._note_dir(self.task_id)

    def test_transient_replace_retries_then_preserves_complete_file(self):
        target = self.folder / '_meta/manifest.json'
        previous = target.read_bytes()
        attempts = 0
        def replace(source, destination):
            nonlocal attempts
            attempts += 1
            if attempts < 3:
                self.assertEqual(target.read_bytes(), previous)
                raise PermissionError(errno.EACCES, 'fixture lock')
            return self.real_replace(source, destination)
        with patch.object(storage.os, 'replace', side_effect=replace):
            storage._atomic_json(target, {'complete': True})
        self.assertEqual(attempts, 3)
        self.assertEqual(json.loads(target.read_text()), {'complete': True})
        self.assertEqual(sum(call.args[1] == 'replace_retry' for call in self.events.call_args_list), 2)

    def test_disk_full_is_not_retried_or_partial(self):
        target = self.folder / '_meta/manifest.json'; before = target.read_bytes()
        with patch.object(storage.os, 'replace', side_effect=OSError(errno.ENOSPC, 'full')) as replace:
            with self.assertRaises(OSError): storage._atomic_json(target, {'changed': True})
        self.assertEqual(replace.call_count, 1)
        self.assertEqual(target.read_bytes(), before)

    def test_metadata_probe_does_not_replace_original_error(self):
        original = PermissionError(errno.EACCES, 'original failure')
        original.winerror = 32
        with patch.object(storage.os, 'replace', side_effect=original), patch.object(Path, 'exists', side_effect=PermissionError(errno.EIO, 'probe failed')):
            with self.assertRaises(PermissionError) as caught:
                storage._replace_note_file('source', self.folder / '_meta/manifest.json')
        self.assertIs(caught.exception, original)
        self.assertEqual(caught.exception.winerror, 32)

    def test_failed_manifest_can_restore_without_new_version(self):
        self.fail_manifest()
        self.assertTrue(storage.save_recovery_summary(self.task_id)['available'])
        versions = list((self.folder / 'versions').glob('*.md'))
        original = {p.name: p.read_bytes() for p in versions}
        recovered = storage.retry_saved_result(self.task_id)
        self.assertEqual(recovered['status'], 'SUCCESS')
        self.assertEqual(len(recovered['markdown']), 1)
        self.assertEqual({p.name: p.read_bytes() for p in (self.folder / 'versions').glob('*.md')}, original)
        self.assertEqual(recovered['transcript']['full_text'], 'private transcript')
        self.assertFalse((self.folder / '_meta/save-recovery.json').exists())
        before = (self.folder / '_meta/manifest.json').read_bytes()
        with self.assertRaises(ValueError): storage.retry_saved_result(self.task_id)
        self.assertEqual(before, (self.folder / '_meta/manifest.json').read_bytes())

    def test_journal_failure_does_not_publish_untracked_version(self):
        def replace(source, target):
            if Path(target).name == 'save-recovery.json': raise PermissionError(errno.EACCES, 'checkpoint denied')
            return self.real_replace(source, target)
        with patch.object(storage.os, 'replace', side_effect=replace):
            with self.assertRaises(PermissionError): self.publish()
        self.folder = storage._note_dir(self.task_id)
        self.assertEqual(list((self.folder / 'versions').glob('*.md')), [])
        self.assertEqual(storage.get_task(self.task_id)['markdown'], [])

    def test_journal_can_recover_initial_version_write_failure(self):
        def replace(source, target):
            if Path(target).parent.name == 'versions': raise PermissionError(errno.EACCES, 'version denied')
            return self.real_replace(source, target)
        with patch.object(storage.os, 'replace', side_effect=replace):
            with self.assertRaises(PermissionError): self.publish()
        storage.write_status(self.task_id, 'FAILED', 'fixture body publish denied')
        self.assertTrue(storage.save_recovery_summary(self.task_id)['available'])
        saved = storage.retry_saved_result(self.task_id)
        self.assertEqual(saved['status'], 'SUCCESS')
        self.assertEqual(len(saved['markdown']), 1)

    def test_modified_body_or_new_request_blocks_recovery(self):
        self.fail_manifest()
        version = next((self.folder / 'versions').glob('*.md'))
        body = version.read_bytes(); version.write_text('user changed body', encoding='utf-8')
        self.assertFalse(storage.save_recovery_summary(self.task_id)['available'])
        version.write_bytes(body)
        storage.save_task({'id': self.task_id, 'formData': {'request_id': 'run-2'}})
        self.assertFalse(storage.save_recovery_summary(self.task_id)['available'])

    def test_retry_failure_keeps_checkpoint_for_another_attempt(self):
        self.fail_manifest()
        def replace(source, target):
            if Path(target).name == 'result.json': raise PermissionError(errno.EACCES, 'busy')
            return self.real_replace(source, target)
        with patch.object(storage.os, 'replace', side_effect=replace):
            with self.assertRaises(PermissionError): storage.retry_saved_result(self.task_id)
        self.assertTrue(storage.save_recovery_summary(self.task_id)['available'])
        self.assertEqual(storage.retry_saved_result(self.task_id)['status'], 'SUCCESS')

    def test_external_edit_to_published_markdown_is_preserved(self):
        self.fail_manifest()
        note = self.folder / '笔记.md'
        note.write_text('User-edited published content', encoding='utf-8')
        before = note.read_bytes()
        self.assertFalse(storage.save_recovery_summary(self.task_id)['available'])
        with self.assertRaises(ValueError): storage.retry_saved_result(self.task_id)
        self.assertEqual(note.read_bytes(), before)

    def test_legacy_repair_requires_this_attempt_and_matching_published_result(self):
        self.publish(); self.folder = storage._note_dir(self.task_id)
        storage.complete_save_recovery(self.task_id)
        storage.write_status(self.task_id, 'FAILED', '[WinError 5] fixture')
        self.assertTrue(storage.save_recovery_summary(self.task_id)['available'])
        original = (self.folder / '_meta/result.json').read_bytes()
        (self.folder / '_meta/result.json').write_text('{}')
        self.assertFalse(storage.save_recovery_summary(self.task_id)['available'])
        (self.folder / '_meta/result.json').write_bytes(original)
        # A new attempt cannot claim an older version as its own saved output.
        time.sleep(.002)
        storage.write_status(self.task_id, 'PENDING'); storage.write_status(self.task_id, 'SAVING')
        storage.write_status(self.task_id, 'FAILED', 'new attempt failed')
        self.assertFalse(storage.save_recovery_summary(self.task_id)['available'])

    def test_archived_and_corrupt_journal_are_not_repaired(self):
        self.fail_manifest()
        storage.set_archived(self.task_id, True)
        self.assertFalse(storage.save_recovery_summary(self.task_id)['available'])
        storage.set_archived(self.task_id, False)
        journal = self.folder / '_meta/save-recovery.json'
        journal.write_text('{"schema_version":1,"manifest":{"task":{"id":"another-task"}}}')
        self.assertFalse(storage.save_recovery_summary(self.task_id)['available'])


if __name__ == '__main__': unittest.main()
