"""Retention against real temporary session/checkpoint SQLite and plan journals."""
import copy
import json
import sqlite3
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing

from tests import test_organizer_sessions as session_tests
from app.services import organizer_sessions as sessions, organizer, note_storage as notes
from langgraph.types import Command


SCOPE = {'kind': 'all', 'folder_id': None, 'task_ids': []}


class OrganizerRetentionTest(unittest.TestCase):
    setUp = session_tests.OrganizerSessionsTest.setUp
    client = session_tests.OrganizerSessionsTest.client
    message = session_tests.OrganizerSessionsTest.message
    action = session_tests.OrganizerSessionsTest.action

    def test_default_ten_limit_requires_consent_and_get_does_not_refresh(self):
        first = self.session
        for _ in range(9):
            sessions.create(SCOPE)
        self.assertEqual(sessions.retention()['limit'], 10)
        before = sessions.list_sessions()
        self.assertEqual(sessions.get(first['session_id'])['updated_at'], first['updated_at'])
        preview = sessions.retention_preview('create')
        self.assertEqual(preview['evictions'][0]['session_id'], first['session_id'])
        self.assertEqual(before, sessions.list_sessions())
        with self.assertRaises(sessions.RetentionConflict) as context:
            sessions.create(SCOPE)
        self.assertEqual(context.exception.data['kind'], 'retention_required')
        self.assertEqual(before, sessions.list_sessions())
        new = sessions.create(SCOPE, confirmation_token=preview['confirmation_token'], request_id='new')
        self.assertEqual(len(sessions.list_sessions()['sessions']), 10)
        with self.assertRaises(FileNotFoundError):
            sessions.get(first['session_id'])
        again = sessions.create(SCOPE, confirmation_token=preview['confirmation_token'], request_id='new')
        self.assertEqual(new['session_id'], again['session_id'])
        self.assertEqual(sessions.retention()['count'], 10)

    def test_lower_limit_preview_is_pure_and_setting_persists(self):
        oldest = self.session['session_id']
        middle = sessions.create(SCOPE)['session_id']
        newest = sessions.create(SCOPE)['session_id']
        preview = sessions.retention_preview('set_limit', 1)
        self.assertEqual([e['session_id'] for e in preview['evictions']], [oldest, middle])
        self.assertEqual(sessions.retention()['limit'], 10)
        with self.assertRaises(sessions.RetentionConflict):
            sessions.set_retention(1)
        self.assertEqual(sessions.retention()['count'], 3)
        result = sessions.set_retention(1, preview['confirmation_token'], 'lower')
        self.assertEqual(result['limit'], 1)
        self.assertEqual(sessions.list_sessions()['sessions'][0]['session_id'], newest)
        self.assertEqual(sessions.set_retention(1, preview['confirmation_token'], 'lower'), result)
        with closing(sqlite3.connect(sessions.SESSION_ROOT / 'sessions.sqlite')) as db:
            self.assertEqual(db.execute('SELECT retention_limit FROM session_settings').fetchone()[0], 1)

    def test_stale_contents_and_limit_reject_old_consent(self):
        sessions.set_retention(1)
        preview = sessions.retention_preview('create')
        self.message('先解释一下办公效率')
        with self.assertRaises(sessions.RetentionConflict) as context:
            sessions.create(SCOPE, confirmation_token=preview['confirmation_token'])
        self.assertEqual(context.exception.data['kind'], 'retention_stale')
        self.assertEqual(sessions.retention()['count'], 1)
        fresh = sessions.retention_preview('create')
        sessions.set_retention(2)
        with self.assertRaises(sessions.RetentionConflict) as context:
            sessions.create(SCOPE, confirmation_token=fresh['confirmation_token'])
        self.assertEqual(context.exception.data['kind'], 'retention_stale')
        self.assertEqual(sessions.retention()['count'], 1)
        sessions.set_retention(1)
        with self.assertRaises(sessions.RetentionConflict) as context:
            sessions.create(SCOPE, confirmation_token=fresh['confirmation_token'])
        self.assertEqual(context.exception.data['kind'], 'retention_stale')

    def test_parallel_confirmed_creation_is_idempotent_and_old_receipt_cannot_resurrect(self):
        sessions.set_retention(1)
        token = sessions.retention_preview('create')['confirmation_token']
        with ThreadPoolExecutor(max_workers=2) as worker:
            results = [future.result(timeout=10) for future in [worker.submit(
                sessions.create, SCOPE, None, None, token, 'parallel-create') for _ in range(2)]]
        self.assertEqual(results[0]['session_id'], results[1]['session_id'])
        self.assertEqual(sessions.retention()['count'], 1)
        sessions.create(SCOPE, confirmation_token=sessions.retention_preview('create')['confirmation_token'])
        with self.assertRaises(FileNotFoundError):
            sessions.create(SCOPE, confirmation_token=token, request_id='parallel-create')
        self.assertEqual(sessions.retention()['count'], 1)

    def test_pending_approval_eviction_physically_removes_graph_and_fences_owner(self):
        sessions.set_retention(1)
        self.message('归档办公效率')
        sid, plan = self.session['session_id'], self.session['plan']
        owner = {'session_id': sid, 'revision': self.session['revision']}
        path = organizer.JOURNAL_ROOT / (plan['plan_id'] + '.json')
        journal_before = path.read_bytes()
        with sessions._graph() as graph:
            self.assertEqual(graph.get_state({'configurable': {'thread_id': sid + ':1'}}).next, ('approval',))
        preview = sessions.retention_preview('create')
        self.assertTrue(preview['evictions'][0]['has_pending_plan'])
        self.assertIn('待审批计划将作废', preview['warning'])
        sessions.create(SCOPE, confirmation_token=preview['confirmation_token'])
        self.assertEqual(path.read_bytes(), journal_before)
        self.assertFalse(notes.get_task('a').get('archived_at'))
        with self.assertRaisesRegex(ValueError, '覆盖'):
            organizer.execute(plan['plan_id'], owner=owner)
        with closing(sqlite3.connect(sessions.SESSION_ROOT / 'checkpoints.sqlite')) as db:
            for table in ('checkpoints', 'writes'):
                self.assertEqual(db.execute('SELECT COUNT(*) FROM ' + table + ' WHERE substr(thread_id,1,33)=?',
                                            (sid + ':',)).fetchone()[0], 0)
        with sessions._graph() as graph:
            self.assertEqual(graph.get_state({'configurable': {'thread_id': sid + ':1'}}).next, ())

    def test_executed_notes_and_audit_remain_but_session_undo_is_gone(self):
        sessions.set_retention(1)
        self.message('归档办公效率')
        owner = {'session_id': self.session['session_id'], 'revision': self.session['revision']}
        self.action('approve')
        plan_id = self.session['plan']['plan_id']
        before = notes.get_task('a')
        journal = (organizer.JOURNAL_ROOT / (plan_id + '.json')).read_bytes()
        preview = sessions.retention_preview('create')
        self.assertTrue(preview['evictions'][0]['loses_undo'])
        sessions.create(SCOPE, confirmation_token=preview['confirmation_token'])
        self.assertEqual(notes.get_task('a'), before)
        self.assertEqual((organizer.JOURNAL_ROOT / (plan_id + '.json')).read_bytes(), journal)
        with self.assertRaisesRegex(ValueError, '覆盖'):
            organizer.undo(plan_id, owner=owner)

    def test_crash_residual_checkpoint_cannot_revive_evicted_approval(self):
        sessions.set_retention(1)
        self.message('归档办公效率')
        old = self.session
        path = sessions.SESSION_ROOT / 'checkpoints.sqlite'
        with closing(sqlite3.connect(path)) as db:
            residual = {table: db.execute('SELECT * FROM ' + table).fetchall()
                        for table in ('checkpoints', 'writes')}
        sessions.create(SCOPE, confirmation_token=sessions.retention_preview('create')['confirmation_token'])
        # Simulate sessions.sqlite committed but checkpoint deletion was lost in
        # a WAL/cross-database power failure. Restore only graph rows, never notes.
        with closing(sqlite3.connect(path)) as db:
            for table, rows in residual.items():
                if rows:
                    db.executemany('INSERT OR REPLACE INTO ' + table + ' VALUES (' +
                                   ','.join('?' for _ in rows[0]) + ')', rows)
            db.commit()
        with sessions._graph() as graph:
            config = {'configurable': {'thread_id': old['session_id'] + ':' + str(old['revision'])}}
            self.assertEqual(graph.get_state(config).next, ('approval',))
            with self.assertRaises(FileNotFoundError):
                graph.invoke(Command(resume={'approved': True, 'plan_id': old['plan']['plan_id'],
                                             'revision': old['revision']}), config)
        self.assertTrue(sessions.owner_retired(old['session_id']))
        self.assertFalse(notes.get_task('a').get('archived_at'))

    def test_running_interrupted_and_recovery_journals_are_protected(self):
        sessions.set_retention(1)
        for status in ('planning', 'executing', 'undoing', 'interrupted'):
            with sessions.LOCK, sessions._db() as db:
                record = sessions._load(db, self.session['session_id'])
                record['status'] = status
                sessions._save(db, record)
            preview = sessions.retention_preview('create')
            self.assertTrue(preview['blocked'])
            self.assertIsNone(preview['confirmation_token'])
            with self.assertRaises(sessions.RetentionConflict) as context:
                sessions.create(SCOPE)
            self.assertEqual(context.exception.data['kind'], 'retention_blocked')
        with sessions.LOCK, sessions._db() as db:
            record = sessions._load(db, self.session['session_id'])
            record['status'] = 'idle'
            sessions._save(db, record)
        self.message('归档办公效率')
        with sessions.LOCK, sessions._db() as db:
            record = sessions._load(db, self.session['session_id'])
            record['status'] = 'failed'
            sessions._save(db, record)
        for status in ('executing', 'undoing', 'rollback_failed'):
            journal = organizer._read(self.session['plan']['plan_id'])
            journal['status'] = status
            organizer._save(journal)
            self.assertTrue(sessions.retention_preview('create')['blocked'])

    def test_not_enough_candidates_blocks_whole_lowering(self):
        sessions.create(SCOPE)
        third = sessions.create(SCOPE)
        with sessions.LOCK, sessions._db() as db:
            for sid in (self.session['session_id'], third['session_id']):
                record = sessions._load(db, sid)
                record['status'] = 'planning'
                sessions._save(db, record)
        preview = sessions.retention_preview('set_limit', 1)
        self.assertTrue(preview['blocked'])
        self.assertEqual(len(preview['evictions']), 1)
        with self.assertRaises(sessions.RetentionConflict):
            sessions.set_retention(1)
        self.assertEqual(sessions.retention()['count'], 3)
        self.assertEqual(sessions.retention()['limit'], 10)

    def test_existing_over_limit_migrates_without_silent_cleanup_or_hidden_sessions(self):
        with sessions.LOCK, sessions._db() as db:
            original = sessions._load(db, self.session['session_id'])
            for _ in range(100):
                record = copy.deepcopy(original)
                record['session_id'] = uuid.uuid4().hex
                sessions._save(db, record)
        listed = sessions.list_sessions()
        self.assertEqual(len(listed['sessions']), 101)
        self.assertTrue(listed['retention']['over_limit'])
        self.assertEqual(sessions.retention()['count'], 101)
        self.assertEqual(sessions.retention_preview('create')['required_count'], 92)

    def test_http_contract_validation_and_idempotent_legacy_create(self):
        url = '/api/organizer'
        first = self.http.post(url + '/sessions', json={'scope': SCOPE, 'request_id': 'legacy'}).json()
        second = self.http.post(url + '/sessions', json={'scope': SCOPE, 'request_id': 'legacy'}).json()
        self.assertEqual(first['data']['session_id'], second['data']['session_id'])
        self.assertEqual(first['code'], 0)
        self.assertEqual(self.http.get(url + '/retention').json()['data']['count'], 2)
        response = self.http.patch(url + '/retention', json={'limit': 1}).json()
        self.assertEqual(response['code'], 409)
        self.assertEqual(response['data']['kind'], 'retention_required')
        token = response['data']['confirmation_token']
        self.assertEqual(self.http.patch(url + '/retention', json={'limit': 1, 'confirmation_token': token}).json()['code'], 0)
        for invalid in (0, 101, True, 1.5):
            self.assertEqual(self.http.patch(url + '/retention', json={'limit': invalid}).status_code, 422)
        preview = self.http.post(url + '/retention/preview', json={'operation': 'create'}).json()['data']
        result = self.http.post(url + '/sessions', json={'scope': SCOPE,
                               'confirmation_token': preview['confirmation_token']}).json()
        self.assertEqual(result['code'], 0)
        self.assertEqual(self.http.get(url + '/retention').json()['data']['count'], 1)
        self.assertEqual(self.http.get(url + '/sessions/' + first['data']['session_id']).json()['code'], 404)


if __name__ == '__main__':
    unittest.main()
