import hashlib
import json
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from app.services import note_library as library, note_storage as notes
from app.routers import note_library as router


class NoteLibraryTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        for obj, name, value in ((notes, 'ROOT', root / 'notes'), (library, 'STATE_PATH', root / 'data/library.json')):
            context = patch.object(obj, name, value)
            context.start()
            self.addCleanup(context.stop)
        for task_id in ('one', 'two'):
            notes.save_task({'id': task_id, 'status': 'SUCCESS', 'markdown': '# 正文', 'audioMeta': {'title': task_id}})
        app = FastAPI()
        app.include_router(router.router, prefix='/api')
        self.client = TestClient(app)

    def snapshot(self):
        return {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in notes.ROOT.rglob('*') if p.is_file()}

    def test_full_lifecycle_and_normalization_preserve_tutorials(self):
        before = self.snapshot()
        self.assertEqual(library.list_entries(), {'entries': {}})
        self.assertFalse(library.STATE_PATH.exists())
        result = library.update_entries(['one', 'two'], {'favorite': True, 'tags': [' ＵＶ ', 'uv', '烘焙'], 'remark': ' 学习重点 '})
        self.assertEqual(result['entries']['one']['tags'], ['UV', '烘焙'])
        self.assertEqual(result['entries']['one']['remark'], '学习重点')
        library.update_entries(['one'], {'learning_status': 'done', 'pinned': True})
        self.assertEqual(library.list_entries()['entries']['two']['learning_status'], 'unread')
        self.assertTrue(library.list_entries()['entries']['one']['favorite'])
        self.assertEqual(before, self.snapshot())

    def test_invalid_batches_are_atomic(self):
        library.update_entries(['one'], {'favorite': True})
        before = library.STATE_PATH.read_bytes()
        for ids, changes in [(['one', 'missing'], {'pinned': True}), (['../outside'], {'pinned': True}),
                             ([], {'pinned': True}), (['one'] * 501, {'pinned': True}),
                             (['one'], {'favorite': 1}), (['one'], {'learning_status': 'other'}),
                             (['one'], {'tags': ['x' * 25]}), (['one'], {'tags': ['a'] * 11}),
                             (['one'], {'tags': ['a\nb']}), (['one'], {'tags': 'abc'}),
                             (['one'], {'remark': 'x' * 2001}), (['one'], {'unknown': True}), (['one'], {})]:
            with self.subTest(ids=ids[:2], changes=str(changes)[:80]):
                with self.assertRaises((ValueError, FileNotFoundError)):
                    library.update_entries(ids, changes)
                self.assertEqual(before, library.STATE_PATH.read_bytes())

    def test_corruption_and_write_failure_preserve_bytes(self):
        library.update_entries(['one'], {'pinned': True})
        before = library.STATE_PATH.read_bytes()
        with patch.object(notes.os, 'replace', side_effect=PermissionError('locked')):
            with self.assertRaises(PermissionError):
                library.update_entries(['one'], {'pinned': False})
        self.assertEqual(before, library.STATE_PATH.read_bytes())
        self.assertFalse(list(library.STATE_PATH.parent.glob('.note-*')))
        for damaged in (b'{', b'{"schema_version":2,"entries":{}}', b'{"schema_version":1,"entries":{"one":null}}'):
            library.STATE_PATH.write_bytes(damaged)
            self.assertEqual(self.client.get('/api/note_library').json()['code'], 500)
            self.assertEqual(self.client.post('/api/note_library/update', json={'task_ids': ['one'], 'changes': {'favorite': True}}).json()['code'], 500)
            self.assertEqual(damaged, library.STATE_PATH.read_bytes())

    def test_concurrent_independent_fields_survive(self):
        changes = [{'favorite': True}, {'pinned': True}, {'learning_status': 'learning'}, {'tags': ['并发']}, {'remark': '保留'}]
        with ThreadPoolExecutor(max_workers=5) as pool:
            list(pool.map(lambda c: library.update_entries(['one'], c), changes))
        self.assertEqual(library.list_entries()['entries']['one'], {'favorite': True, 'pinned': True, 'learning_status': 'learning', 'tags': ['并发'], 'remark': '保留'})

    def test_archive_regeneration_and_pending_deletion(self):
        library.update_entries(['one'], {'learning_status': 'done'})
        notes.set_archived('one', True)
        notes.set_archived('one', False)
        notes.save_task({'id': 'one', 'status': 'SUCCESS', 'markdown': '# 更新', 'audioMeta': {'title': 'one'}})
        self.assertEqual(library.list_entries()['entries']['one']['learning_status'], 'done')
        path = notes._note_dir('two') / '_meta/manifest.json'
        manifest = json.loads(path.read_text(encoding='utf-8'))
        manifest['deletion_pending'] = True
        path.write_text(json.dumps(manifest), encoding='utf-8')
        before = library.STATE_PATH.read_bytes()
        with self.assertRaises(FileNotFoundError):
            library.update_entries(['one', 'two'], {'favorite': True})
        self.assertEqual(before, library.STATE_PATH.read_bytes())

    def test_http_contract_and_strict_fields(self):
        response = self.client.post('/api/note_library/update', json={'task_ids': ['one'], 'changes': {'favorite': True}}).json()
        self.assertEqual(response['code'], 0)
        self.assertTrue(response['data']['entries']['one']['favorite'])
        self.assertEqual(self.client.get('/api/note_library').json()['data'], response['data'])
        self.assertEqual(self.client.post('/api/note_library/update', json={'task_ids': ['one'], 'changes': {}, 'extra': 1}).status_code, 422)


if __name__ == '__main__':
    unittest.main()
