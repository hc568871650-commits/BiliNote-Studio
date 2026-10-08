import importlib
import json
import os
import tempfile
import threading
import types
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from app.services import organizer_sessions as sessions, organizer, note_storage as notes
from app.services import note_folders as folders, note_library as library
from app.routers import organizer as routes


class OrganizerSessionsTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        for module, name, value in ((notes, 'ROOT', root / 'notes'), (folders, 'STATE_PATH', root / 'folders.json'),
                                    (library, 'STATE_PATH', root / 'library.json'),
                                    (organizer, 'JOURNAL_ROOT', root / 'plans'),
                                    (sessions, 'SESSION_ROOT', root / 'sessions')):
            context = patch.object(module, name, value)
            context.start()
            self.addCleanup(context.stop)
        for task_id, title in (('a', '办公教程A'), ('b', '收藏办公B'), ('c', '其他建模C')):
            notes.save_task({'id': task_id, 'status': 'SUCCESS', 'audioMeta': {'title': title},
                             'markdown': 'SECRET_BODY', 'transcript': {'full_text': 'SECRET_TRANSCRIPT'},
                             'formData': {'api_key': 'SECRET_KEY', 'file_path': 'SECRET_PATH'}})
        folders.create_folder('办公效率', 'office')
        folders.move_notes(['a', 'b'], 'office')
        library.update_entries(['b'], {'favorite': True, 'remark': 'SECRET_REMARK'})
        self.calls = []
        self.answer_calls = []
        self.delay_start = threading.Event()
        self.delay_end = threading.Event()
        self.delay = False
        self.fail_model = False
        self.client_patch = patch.object(organizer, 'get_client', side_effect=self.client)
        self.client_patch.start()
        self.addCleanup(self.client_patch.stop)
        self.session = sessions.create({'kind': 'all', 'folder_id': None, 'task_ids': []})
        app = FastAPI()
        app.include_router(routes.router, prefix='/api')
        self.http = TestClient(app)

    def client(self, provider, model):
        def create(**kwargs):
            payload = json.loads(kwargs['messages'][-1]['content'])
            if payload.get('reply_only'):
                self.answer_calls.append(kwargs)
                if self.fail_model:
                    raise RuntimeError('fake model unavailable')
                return types.SimpleNamespace(choices=[types.SimpleNamespace(message=types.SimpleNamespace(
                    content='这是模型对使用问题的具体回答。'))])
            self.calls.append(kwargs)
            if self.delay:
                self.delay_start.set()
                if not self.delay_end.wait(timeout=10):
                    raise RuntimeError('test timeout')
            if self.fail_model:
                raise RuntimeError('fake model unavailable')
            payload = json.loads(kwargs['messages'][-1]['content'])
            ids = [n['id'] for n in payload['notes']]
            kind = 'restore' if '恢复归档当前明确范围' in payload['instruction'] else 'archive'
            operations = [{'type': kind, 'task_ids': ids}]
            if '唯一允许的移动目标：' in payload['instruction']:
                destination = json.loads(payload['instruction'].split('唯一允许的移动目标：')[-1])
                operations = [{'type': 'move_notes', 'task_ids': ids, 'folder_id': destination['folder_id']}]
            return types.SimpleNamespace(choices=[types.SimpleNamespace(message=types.SimpleNamespace(content=json.dumps(
                {'explanation': '安全范围计划', 'operations': operations, 'query_note_ids': []})))])
        return types.SimpleNamespace(client=types.SimpleNamespace(chat=types.SimpleNamespace(
            completions=types.SimpleNamespace(create=create))))

    def message(self, text, **extra):
        data = {'instruction': text, 'provider_id': 'fake', 'model_name': 'fake',
                'scope': {'kind': 'all', 'folder_id': None, 'task_ids': []},
                'request_id': uuid.uuid4().hex, 'expected_revision': self.session['revision'], **extra}
        self.session = sessions.message(self.session['session_id'], data)
        return self.session

    def action(self, kind, **extra):
        data = {'expected_revision': self.session['revision'], 'request_id': uuid.uuid4().hex,
                'plan_id': (self.session.get('plan') or {}).get('plan_id'), **extra}
        self.session = sessions.action(self.session['session_id'], kind, data)
        return self.session

    def seed_history(self, count):
        with sessions.LOCK, sessions._db() as db:
            session = sessions._load(db, self.session['session_id'])
            for i in range(count):
                sessions._history(session, 'user' if i % 2 == 0 else 'assistant', f'历史{i} ' + '参考资料' * 100)
            sessions._save(db, session)
        self.session = sessions.get(self.session['session_id'])

    @staticmethod
    def fake_compaction(client, model, history, summary='', keep_recent=4):
        consumed = max(0, len(history) - keep_recent)
        return {'summary': '只读历史摘要', 'consumed_messages': consumed,
                'compacted': bool(consumed), 'context': {'input_tokens': 2000, 'estimated': True,
                'limit': 272000, 'compacted': bool(consumed), 'compacted_messages': consumed}}

    def compact_data(self):
        return {'expected_revision': self.session['revision'], 'request_id': uuid.uuid4().hex,
                'provider_id': 'fake', 'model_name': 'fake'}

    def test_manual_compaction_preserves_plan_revision_checkpoint_and_history(self):
        self.message('归档办公效率')
        self.seed_history(8)
        before = self.session
        with patch.object(sessions, 'compact_history', side_effect=self.fake_compaction):
            self.session = sessions.compact(before['session_id'], self.compact_data())
        for key in ('revision', 'plan', 'status', 'history', 'scope', 'target_summary', 'pending_plan_id'):
            self.assertEqual(self.session[key], before[key], key)
        self.assertEqual(len(sessions._active_history(self.session)), 4)
        self.assertEqual(self.action('approve')['result']['status'], 'executed')

    def test_compaction_noop_does_not_claim_lower_context_usage(self):
        self.message('归档办公效率')
        before = self.session
        with patch.object(sessions, 'compact_history', side_effect=self.fake_compaction):
            after = sessions.compact(before['session_id'], self.compact_data())
        self.assertEqual(after['context'], before['context'])
        self.assertEqual(after['memory'], before['memory'])
        self.assertEqual(after['plan'], before['plan'])

    def test_compaction_failure_keeps_old_memory_and_history_and_retries(self):
        self.seed_history(10)
        with patch.object(sessions, 'compact_history', side_effect=self.fake_compaction):
            self.session = sessions.compact(self.session['session_id'], self.compact_data())
        self.seed_history(6)
        before = self.session
        data = self.compact_data()
        with patch.object(sessions, 'compact_history', side_effect=ValueError('fake failure')):
            with self.assertRaisesRegex(ValueError, 'fake failure'):
                sessions.compact(before['session_id'], data)
        after = sessions.get(before['session_id'])
        self.assertEqual(after['memory'], before['memory'])
        self.assertEqual(after['history'], before['history'])
        with patch.object(sessions, 'compact_history', side_effect=self.fake_compaction):
            self.assertGreater(sessions.compact(before['session_id'], data)['memory']['compacted_messages'], before['memory']['compacted_messages'])

    def test_auto_compaction_preserves_full_history_and_sends_summary_recent_turns(self):
        self.seed_history(160)
        before = self.session['history']
        with patch.object(sessions, 'compact_history', side_effect=self.fake_compaction) as compact:
            self.message('解释这个错误')
        compact.assert_called_once()
        self.assertEqual(self.session['history'][:160], before)
        payload = json.loads(self.answer_calls[-1]['messages'][-1]['content'])
        self.assertEqual(len(payload['history']), 4)
        self.assertEqual(payload['untrusted_history_summary'], '只读历史摘要')

    def test_manual_command_and_concurrent_cancellation_fence(self):
        self.seed_history(8)
        started, release = threading.Event(), threading.Event()
        def delayed(*args, **kwargs):
            started.set()
            self.assertTrue(release.wait(5))
            return self.fake_compaction(*args, **kwargs)
        before = self.session
        with patch.object(sessions, 'compact_history', side_effect=delayed):
            with ThreadPoolExecutor(max_workers=1) as pool:
                future = pool.submit(sessions.message, before['session_id'], {
                    **self.compact_data(), 'instruction': '/compact'})
                self.assertTrue(started.wait(5))
                with self.assertRaisesRegex(ValueError, '当前任务'):
                    sessions.compact(before['session_id'], self.compact_data())
                self.action('cancel')
                release.set()
                with self.assertRaisesRegex(ValueError, '晚到'):
                    future.result(5)
        final = sessions.get(before['session_id'])
        self.assertEqual(final['memory'], before['memory'])
        self.assertEqual(final['history'][:8], before['history'])
        self.assertFalse(any(item['content'] == '/compact' for item in final['history']))

    def test_stop_compaction_preserves_pending_approval_and_discards_late_summary(self):
        self.message('归档办公效率')
        self.seed_history(8)
        before = self.session
        started, release = threading.Event(), threading.Event()
        def delayed(*args, **kwargs):
            started.set()
            self.assertTrue(release.wait(5))
            return self.fake_compaction(*args, **kwargs)
        with patch.object(sessions, 'compact_history', side_effect=delayed):
            with ThreadPoolExecutor(max_workers=1) as pool:
                future = pool.submit(sessions.compact, before['session_id'], self.compact_data())
                self.assertTrue(started.wait(5))
                self.session = sessions.cancel_compaction(before['session_id'], {
                    'request_id': uuid.uuid4().hex, 'expected_revision': before['revision']})
                for key in ('revision', 'status', 'history', 'plan', 'memory', 'scope', 'pending_plan_id'):
                    self.assertEqual(self.session[key], before[key], key)
                self.assertNotIn(before['session_id'], sessions.ACTIVE)
                self.assertEqual(self.action('approve')['result']['status'], 'executed')
                release.set()
                with self.assertRaisesRegex(ValueError, '晚到'):
                    future.result(5)
        final = sessions.get(before['session_id'])
        self.assertEqual(final['memory'], before['memory'])
        self.assertEqual(final['status'], 'completed')
        self.assertEqual(final['result']['status'], 'executed')

    def test_user_sequence_scope_favorite_and_undo(self):
        self.assertEqual(self.message('帮我删除办公效率下面的笔记')['status'], 'refused')
        self.assertEqual(self.session['scope']['folder_id'], 'office')
        self.assertEqual(self.calls, [])
        self.assertEqual(len(self.answer_calls), 1)
        self.assertEqual(self.message('那帮我归档')['plan']['operations'][0]['task_ids'], ['a', 'b'])
        old = self.session['plan']['plan_id']
        revision = self.session['revision']
        self.assertEqual(self.message('排除已收藏的')['plan']['operations'][0]['task_ids'], ['a'])
        with self.assertRaisesRegex(ValueError, '版本'):
            sessions.action(self.session['session_id'], 'approve', {'expected_revision': revision,
                'request_id': uuid.uuid4().hex, 'plan_id': old})
        with self.assertRaisesRegex(ValueError, '匹配'):
            self.action('approve', plan_id=old)
        with self.assertRaisesRegex(ValueError, '绕过'):
            organizer.execute(self.session['plan']['plan_id'])
        self.assertEqual(self.action('approve')['result']['status'], 'executed')
        self.assertTrue(notes.get_task('a')['archived_at'])
        self.assertFalse(notes.get_task('b').get('archived_at'))
        self.assertFalse(notes.get_task('c').get('archived_at'))
        self.assertEqual(self.action('undo')['result']['status'], 'undone')
        self.assertFalse(notes.get_task('a').get('archived_at'))

    def test_ambiguous_first_turn_and_empty_set_no_fallback(self):
        self.assertEqual(self.message('那归档')['status'], 'clarification')
        self.assertEqual(self.calls, [])
        library.update_entries(['a'], {'favorite': True})
        self.assertEqual(self.message('归档办公效率，排除已收藏的')['status'], 'completed')
        self.assertEqual(self.session['scope']['target_count'], 0)
        self.assertIsNone(self.session['plan'])
        self.assertEqual(self.calls, [])

    def test_conversation_failure_is_visible_without_template_or_write(self):
        self.fail_model = True
        result = self.message('Gemini无法使用，报错401')
        self.assertEqual(result['status'], 'failed')
        self.assertEqual(result['error'], '模型调用失败，请检查模型连接和协议')
        self.assertNotIn('fake model unavailable', result['error'])
        self.assertIsNone(result['plan'])
        self.assertEqual(len(self.answer_calls), 1)
        self.assertEqual(self.calls, [])
        self.fail_model = False
        result = self.message('解释这个错误')
        self.assertEqual(result['status'], 'completed')
        self.assertEqual(result['history'][-1]['content'], '这是模型对使用问题的具体回答。')

    def test_runtime_identity_changes_without_deleting_history(self):
        before = sessions.list_sessions()
        with patch.object(sessions, 'RUNTIME_ID', 'new-process'):
            after = sessions.list_sessions()
        self.assertNotEqual(before['runtime_id'], after['runtime_id'])
        self.assertEqual(before['sessions'], after['sessions'])

    def test_query_never_inherits_archive_and_reads_only_query_scope(self):
        self.message('归档办公效率')
        result = self.message('找出尚未归档的笔记', scope={'kind': 'selected', 'task_ids': ['c']})
        self.assertEqual(result['status'], 'completed')
        self.assertIsNone(result['plan'])
        payload = json.loads(self.answer_calls[-1]['messages'][-1]['content'])
        self.assertEqual([n['id'] for n in payload['notes']], ['c'])
        for forbidden in ('SECRET_BODY', 'SECRET_TRANSCRIPT', 'SECRET_KEY', 'SECRET_PATH', 'SECRET_REMARK'):
            self.assertNotIn(forbidden, str(payload))

    def test_model_payload_has_metadata_no_body_or_remark(self):
        self.message('归档办公效率')
        payload = str(self.calls)
        for forbidden in ('SECRET_BODY', 'SECRET_TRANSCRIPT', 'SECRET_KEY', 'SECRET_PATH', 'SECRET_REMARK'):
            self.assertNotIn(forbidden, payload)
        self.assertIn('favorite', payload)
        self.assertIn('target', str(self.session))

    def test_duplicate_approval_and_request_identity(self):
        self.message('归档办公效率')
        data = {'expected_revision': self.session['revision'], 'request_id': 'same-id', 'plan_id': self.session['plan']['plan_id']}
        first = sessions.action(self.session['session_id'], 'approve', data)
        second = sessions.action(self.session['session_id'], 'approve', data)
        self.assertEqual(first['revision'], second['revision'])
        self.assertEqual(first['result'], second['result'])
        with self.assertRaisesRegex(ValueError, 'request_id'):
            sessions.action(self.session['session_id'], 'undo', data)

    def test_cancel_blocks_late_model_and_restart(self):
        self.delay = True
        with ThreadPoolExecutor(max_workers=1) as worker:
            future = worker.submit(self.message, '归档办公效率')
            self.assertTrue(self.delay_start.wait(5))
            live = sessions.get(self.session['session_id'])
            self.assertEqual(live['status'], 'planning')
            stopped = sessions.action(live['session_id'], 'cancel', {
                'expected_revision': live['revision'], 'request_id': 'stop', 'plan_id': None})
            self.delay_end.set()
            result = future.result(timeout=10)
        self.assertEqual(result['status'], 'cancelled')
        self.assertIsNone(result['plan'])
        records = [json.loads(p.read_text(encoding='utf-8')) for p in organizer.JOURNAL_ROOT.glob('*.json')]
        self.assertEqual(records[0]['status'], 'superseded')
        loaded = sessions.get(stopped['session_id'])
        self.assertEqual(loaded['status'], 'cancelled')

    def test_checkpoint_restored_with_new_graph_instance(self):
        self.message('归档办公效率')
        self.assertEqual(self.session['status'], 'awaiting_approval')
        with sessions._graph() as graph:
            checkpoint = graph.get_state({'configurable': {'thread_id': self.session['session_id'] + ':' + str(self.session['revision'])}})
        self.assertEqual(checkpoint.next, ('approval',))
        self.session = sessions.get(self.session['session_id'])
        self.assertEqual(self.action('approve')['result']['status'], 'executed')
        self.assertEqual(len(self.calls), 1)

    def test_failure_retry_and_interrupted_recovery(self):
        self.fail_model = True
        self.assertEqual(self.message('归档办公效率')['status'], 'failed')
        self.fail_model = False
        self.assertEqual(self.message('那帮我归档')['status'], 'awaiting_approval')
        self.action('cancel')
        with sessions.LOCK, sessions._db() as db:
            record = sessions._load(db, self.session['session_id'])
            record['status'] = 'planning'
            sessions._save(db, record)
        self.assertEqual(sessions.get(self.session['session_id'])['status'], 'interrupted')
        self.assertEqual(self.action('recover')['status'], 'failed')
        self.assertIsNone(self.session['plan'])

    def test_execute_failure_rollback_then_regenerate(self):
        self.message('归档办公效率')
        with patch.object(organizer, '_apply', side_effect=RuntimeError('synthetic disk failure')):
            self.assertEqual(self.action('approve')['status'], 'failed')
        self.assertFalse(notes.get_task('a').get('archived_at'))
        self.assertEqual(self.message('那帮我归档')['status'], 'awaiting_approval')
        self.assertEqual(self.action('approve')['result']['status'], 'executed')

    def test_http_conflict_and_create_get_list(self):
        self.message('归档办公效率')
        response = self.http.post('/api/organizer/sessions/' + self.session['session_id'] + '/approve', json={
            'expected_revision': 0, 'request_id': 'bad', 'plan_id': self.session['plan']['plan_id']}).json()
        self.assertEqual(response['code'], 409)
        self.assertEqual(self.http.get('/api/organizer/sessions').json()['data']['sessions'][0]['session_id'], self.session['session_id'])

    def test_unknown_new_target_and_negated_archive(self):
        self.message('归档办公效率')
        self.assertEqual(self.message('归档不存在的文件夹')['status'], 'clarification')
        self.assertEqual(self.message('那归档')['status'], 'clarification')
        self.assertIsNone(self.session['plan'])
        self.assertEqual(len(self.calls), 1)
        for text in ('不要归档，先解释一下', '先别归档', '如何归档办公效率'):
            self.assertEqual(self.message(text)['status'], 'completed')
            self.assertIsNone(self.session['plan'])
        self.assertEqual(len(self.calls), 1)

    def test_query_upper_bound_and_explicit_include_favorites(self):
        self.message('归档办公效率，排除已收藏的')
        self.assertEqual(self.session['query_scope']['kind'], 'all')
        self.assertEqual(self.session['scope']['kind'], 'folder')
        self.assertEqual(self.message('包含已收藏的')['plan']['operations'][0]['task_ids'], ['a', 'b'])
        folders.create_folder('学习资料', 'study')
        folders.move_notes(['c'], 'study')
        self.assertEqual(self.message('改整理学习资料，归档')['plan']['operations'][0]['task_ids'], ['c'])

    def test_new_empty_logical_folder_does_not_authorize_all_notes(self):
        def folder_client(provider, model):
            def create(**kwargs):
                self.calls.append(kwargs)
                payload = json.loads(kwargs['messages'][-1]['content'])
                self.assertEqual(payload['notes'], [])
                proposal = {'explanation': '创建空逻辑文件夹', 'operations': [
                    {'type': 'create_folder', 'ref': 'newfolder', 'name': '学习资料'}], 'query_note_ids': []}
                return types.SimpleNamespace(choices=[types.SimpleNamespace(message=types.SimpleNamespace(
                    content=json.dumps(proposal)))])
            return types.SimpleNamespace(client=types.SimpleNamespace(chat=types.SimpleNamespace(
                completions=types.SimpleNamespace(create=create))))
        with patch.object(organizer, 'get_client', side_effect=folder_client):
            self.assertEqual(self.message('新建文件夹叫学习资料')['status'], 'awaiting_approval')
        self.assertFalse(self.session['scope']['authorized'])
        self.assertEqual(self.session['scope']['target_count'], 0)
        self.assertEqual(self.action('approve')['result']['status'], 'executed')
        self.assertTrue(any(f['name'] == '学习资料' for f in folders.list_folders()['folders']))
        self.action('undo')
        self.assertFalse(any(f['name'] == '学习资料' for f in folders.list_folders()['folders']))

    def test_parallel_duplicate_confirmation_is_serial_and_idempotent(self):
        self.message('归档办公效率')
        data = {'expected_revision': self.session['revision'], 'request_id': 'parallel', 'plan_id': self.session['plan']['plan_id']}
        with ThreadPoolExecutor(max_workers=2) as worker:
            futures = [worker.submit(sessions.action, self.session['session_id'], 'approve', data) for _ in range(2)]
            results = [f.result(timeout=10) for f in futures]
        self.assertEqual(sessions.get(self.session['session_id'])['result']['status'], 'executed')
        self.assertEqual(len(self.calls), 1)
        self.assertTrue(all(r['revision'] in (self.session['revision'], self.session['revision'] + 1) for r in results))

    def test_explicit_selected_target_replaces_old_target(self):
        self.message('归档办公效率')
        result = self.message('归档选中笔记', scope={'kind': 'selected', 'folder_id': None, 'task_ids': ['c']})
        self.assertEqual(result['status'], 'awaiting_approval')
        self.assertEqual(result['plan']['operations'][0]['task_ids'], ['c'])
        self.assertIsNone(result['scope'].get('folder_name'))
        self.assertEqual(result['query_scope']['kind'], 'selected')

    def test_move_source_destination_aliases_and_undo(self):
        folders.create_folder('学习', 'study')
        folders.move_notes(['a', 'b'], 'study')
        for verb in ('移到', '放到', '挪到', '移动到'):
            result = self.message(f'帮我把学习里面的两篇笔记{verb}默认')
            self.assertEqual(result['status'], 'awaiting_approval')
            self.assertEqual(result['scope']['folder_id'], 'study')
            self.assertEqual(result['plan']['operations'], [
                {'type': 'move_notes', 'task_ids': ['a', 'b'], 'folder_id': 'default'}])
        self.assertEqual(self.action('approve')['result']['status'], 'executed')
        self.assertEqual(folders._read()['assignments'].get('a', 'default'), 'default')
        self.assertEqual(folders._read()['assignments'].get('c', 'default'), 'default')
        self.action('undo')
        self.assertEqual(folders._read()['assignments']['a'], 'study')

    def test_move_ambiguity_count_and_upper_bound_fail_closed(self):
        folders.create_folder('学习', 'study')
        folders.move_notes(['a', 'b'], 'study')
        for text in ('把学习和办公效率的笔记移到默认', '把学习里面的一篇笔记移到默认',
                     '把学习里面的两篇笔记移到不存在', '把不存在文件夹里面的笔记移到默认'):
            result = self.message(text)
            self.assertEqual(result['status'], 'clarification', text)
            self.assertIsNone(result['plan'])
        self.assertEqual(self.calls, [])
        self.assertEqual(self.answer_calls, [])
        result = self.message('把学习里面的两篇笔记移到默认',
                              scope={'kind': 'selected', 'task_ids': ['a']})
        self.assertEqual(result['status'], 'clarification')
        self.assertEqual(self.calls, [])
        result = self.message('把选中笔记放到默认', scope={'kind': 'selected', 'task_ids': ['a']})
        self.assertEqual(result['plan']['operations'][0]['task_ids'], ['a'])

    def test_multiple_sources_do_not_reuse_old_authorization(self):
        folders.create_folder('学习', 'study')
        self.message('归档办公效率')
        self.assertEqual(self.message('把学习和办公效率的笔记移到默认')['status'], 'clarification')
        self.assertFalse(self.session['scope']['authorized'])
        self.assertEqual(self.message('那移到默认')['status'], 'clarification')
        self.assertEqual(len(self.calls), 1)

    def test_text_confirmation_preserves_bound_plan_and_checkpoint(self):
        self.message('归档办公效率')
        old_plan, revision = self.session['plan']['plan_id'], self.session['revision']
        calls = len(self.calls)
        for text in ('确认', '确认执行', '可以执行', '好的，确认'):
            result = self.message(text)
            self.assertEqual(result['status'], 'awaiting_approval')
            self.assertEqual(result['plan']['plan_id'], old_plan)
            self.assertEqual(result['revision'], revision)
            self.assertIn('按钮', result['history'][-1]['content'])
        self.assertEqual(len(self.calls), calls)
        self.assertEqual(self.answer_calls, [])
        self.assertEqual(self.action('approve')['result']['status'], 'executed')

    def test_confirmation_without_plan_never_calls_model_or_promises(self):
        result = self.message('确认执行')
        self.assertIsNone(result['plan'])
        self.assertEqual(result['revision'], 0)
        self.assertIn('没有待审批', result['history'][-1]['content'])
        self.assertEqual(self.calls, [])
        self.assertEqual(self.answer_calls, [])

    def test_reasoning_and_context_settings_reach_both_model_paths(self):
        result = self.message('归档办公效率', model_name='gpt-5.4', reasoning_effort='high', context_limit=272000)
        self.assertEqual(result['status'], 'awaiting_approval')
        self.assertEqual(self.calls[-1]['reasoning_effort'], 'high')
        self.assertNotIn('temperature', self.calls[-1])
        self.assertEqual(result['context']['limit'], 272000)
        self.assertTrue(result['context']['estimated'])
        result = self.message('解释这个错误', model_name='gpt-5.4', reasoning_effort='low', context_limit=272000)
        self.assertEqual(self.answer_calls[-1]['reasoning_effort'], 'low')
        self.assertEqual(result['context']['limit'], 272000)
        self.assertGreater(result['context']['input_tokens'], 0)

    def test_unsupported_reasoning_is_visible_without_model_request(self):
        result = self.message('归档办公效率', reasoning_effort='high')
        self.assertEqual(result['status'], 'failed')
        self.assertIn('思考档位', result['error'])
        self.assertEqual(self.calls, [])

    def test_readonly_provider_cannot_invent_confirmation_authority(self):
        with self.assertRaisesRegex(ValueError, '没有可执行计划'):
            organizer._readonly_reply('请回复“确认”，确认后我将移动这两篇笔记。')
        self.assertEqual(organizer._readonly_reply('生成计划后，点击计划上的“确认执行”按钮。'),
                         '生成计划后，点击计划上的“确认执行”按钮。')

    def test_model_cannot_redirect_move_destination(self):
        original = organizer.plan
        def redirect(*args, **kwargs):
            plan = original(*args, **kwargs)
            plan['operations'][0]['folder_id'] = 'office'
            return plan
        with patch.object(organizer, 'plan', side_effect=redirect):
            result = self.message('把办公效率里面的两篇笔记移到默认')
        self.assertEqual(result['status'], 'failed')
        self.assertIsNone(result['plan'])
        self.assertIn('移动目标', result['error'])
        self.assertEqual(folders._read()['assignments']['a'], 'office')
        records = [json.loads(path.read_text(encoding='utf-8')) for path in organizer.JOURNAL_ROOT.glob('*.json')]
        self.assertEqual(records[0]['status'], 'superseded')

    def test_explicit_tags_and_rename_cannot_acquire_archive_authority(self):
        for text in ('给办公效率里的笔记加上UV标签', '把办公效率文件夹重命名为工作'):
            with self.subTest(text=text):
                result = self.message(text)
                self.assertEqual(result['status'], 'failed')
                self.assertIsNone(result['plan'])
                self.assertIn('操作意图', result['error'])
                self.assertFalse(notes.get_task('a').get('archived_at'))

    def test_explicit_tags_and_rename_allow_matching_operations(self):
        cases = [
            ('给办公效率里的笔记加上UV标签', {'type': 'set_tags', 'task_ids': ['a', 'b'], 'tags': ['UV']}),
            ('给办公效率中的全部笔记设置标签 UV，不要归档',
             {'type': 'set_tags', 'task_ids': ['a', 'b'], 'tags': ['UV']}),
            ('把办公效率文件夹重命名为工作', {'type': 'rename_folder', 'folder_id': 'office', 'name': '工作'})]
        for text, operation in cases:
            with self.subTest(text=text):
                proposal = {'explanation': '仅执行指定操作', 'operations': [operation], 'query_note_ids': []}
                response = types.SimpleNamespace(choices=[types.SimpleNamespace(message=types.SimpleNamespace(
                    content=json.dumps(proposal)))])
                with patch.object(organizer, 'complete', return_value=(response, {})):
                    result = self.message(text)
                self.assertEqual(result['status'], 'awaiting_approval')
                self.assertEqual(result['plan']['operations'][0]['type'], operation['type'])
        self.assertEqual(folders._folder(folders._read(), 'office')['name'], '办公效率')

    def test_general_organization_allows_bounded_classification_operations(self):
        proposal = {'explanation': '按标题分类', 'operations': [
            {'type': 'create_folder', 'ref': 'newfolder', 'name': '工作'},
            {'type': 'move_notes', 'task_ids': ['a', 'b'], 'folder_id': 'newfolder'},
            {'type': 'set_tags', 'task_ids': ['a', 'b'], 'tags': ['办公']}], 'query_note_ids': []}
        response = types.SimpleNamespace(choices=[types.SimpleNamespace(message=types.SimpleNamespace(
            content=json.dumps(proposal)))])
        with patch.object(organizer, 'complete', return_value=(response, {})):
            result = self.message('整理办公效率')
        self.assertEqual(result['status'], 'awaiting_approval')
        self.assertEqual([op['type'] for op in result['plan']['operations']],
                         ['create_folder', 'move_notes', 'set_tags'])
        self.assertEqual(folders._read()['assignments']['a'], 'office')

    def test_rename_requires_named_folder_and_binds_object(self):
        result = self.message('重命名选中笔记')
        self.assertEqual(result['status'], 'clarification')
        self.assertEqual(self.calls, [])
        folders.create_folder('其他资料', 'other')
        proposal = {'explanation': '重命名', 'operations': [
            {'type': 'rename_folder', 'folder_id': 'other', 'name': '工作'}], 'query_note_ids': []}
        response = types.SimpleNamespace(choices=[types.SimpleNamespace(message=types.SimpleNamespace(
            content=json.dumps(proposal)))])
        with patch.object(organizer, 'complete', return_value=(response, {})):
            result = self.message('把办公效率文件夹重命名为工作')
        self.assertEqual(result['status'], 'failed')
        self.assertIn('重命名对象', result['error'])
        self.assertIsNone(result['plan'])
        self.assertEqual(folders._folder(folders._read(), 'other')['name'], '其他资料')

    def test_general_organization_cannot_propose_archive(self):
        result = self.message('整理办公效率')
        self.assertEqual(result['status'], 'failed')
        self.assertIn('操作意图', result['error'])
        self.assertIsNone(result['plan'])

    def test_negated_move_aliases_never_propose(self):
        for verb in ('挪入', '放入', '搬到'):
            with self.subTest(verb=verb):
                result = self.message('不要把办公效率全部笔记' + verb + '默认')
                self.assertEqual(result['status'], 'completed')
                self.assertIsNone(result['plan'])
                self.assertEqual(self.calls, [])

    def test_all_move_requires_complete_plan_coverage(self):
        original = organizer.plan
        def incomplete(*args, **kwargs):
            plan = original(*args, **kwargs)
            plan['operations'][0]['task_ids'] = ['a']
            return plan
        with patch.object(organizer, 'plan', side_effect=incomplete):
            result = self.message('把办公效率全部笔记移到默认')
        self.assertEqual(result['status'], 'failed')
        self.assertIsNone(result['plan'])
        self.assertIn('全部笔记', result['error'])
        self.assertEqual(folders._read()['assignments']['b'], 'office')

    def test_explicit_count_and_all_actions_require_complete_coverage(self):
        original = organizer.plan
        def incomplete(*args, **kwargs):
            plan = original(*args, **kwargs)
            plan['operations'][0]['task_ids'] = ['a']
            return plan
        for text in ('把办公效率里的两篇笔记移到默认', '归档办公效率全部笔记',
                     '恢复办公效率全部笔记'):
            with self.subTest(text=text), patch.object(organizer, 'plan', side_effect=incomplete):
                result = self.message(text)
                self.assertEqual(result['status'], 'failed')
                self.assertIsNone(result['plan'])
                self.assertIn('全部笔记或篇数', result['error'])
                self.assertFalse(notes.get_task('a').get('archived_at'))
                self.assertEqual(folders._read()['assignments']['b'], 'office')

    def test_all_tags_requires_complete_plan_coverage(self):
        proposal = {'explanation': '设置UV标签', 'operations': [
            {'type': 'set_tags', 'task_ids': ['a'], 'tags': ['UV']}], 'query_note_ids': []}
        response = types.SimpleNamespace(choices=[types.SimpleNamespace(message=types.SimpleNamespace(
            content=json.dumps(proposal)))])
        with patch.object(organizer, 'complete', return_value=(response, {})):
            result = self.message('给办公效率里的所有笔记设置UV标签')
        self.assertEqual(result['status'], 'failed')
        self.assertIsNone(result['plan'])
        self.assertIn('全部笔记或篇数', result['error'])

    def test_external_tracing_env_is_disabled_only_inside_graph(self):
        from langsmith.run_helpers import get_tracing_context
        seen = []
        original_client = self.client
        def inspect_client(provider, model):
            seen.append(get_tracing_context()['enabled'])
            return original_client(provider, model)
        with patch.dict(os.environ, {'LANGSMITH_TRACING': 'true', 'LANGCHAIN_TRACING_V2': 'true'}), \
                patch.object(organizer, 'get_client', side_effect=inspect_client):
            self.message('归档办公效率')
            self.assertEqual(seen, [False])
            self.assertEqual(os.environ['LANGSMITH_TRACING'], 'true')
            self.assertEqual(self.session['status'], 'awaiting_approval')

    def test_old_completion_cannot_remove_new_active_token(self):
        old_started, old_end, new_started, new_end = [threading.Event() for _ in range(4)]
        count_lock = threading.Lock()
        count = [0]
        original_client = self.client
        def staggered_client(provider, model):
            client = original_client(provider, model)
            original = client.client.chat.completions.create
            def create(**kwargs):
                with count_lock:
                    count[0] += 1
                    number = count[0]
                start, end = (old_started, old_end) if number == 1 else (new_started, new_end)
                start.set()
                if not end.wait(10):
                    raise RuntimeError('test timeout')
                return original(**kwargs)
            client.client.chat.completions.create = create
            return client
        sid = self.session['session_id']
        def submit_message(text, revision):
            return sessions.message(sid, {'instruction': text, 'provider_id': 'fake', 'model_name': 'fake',
                'scope': {'kind': 'all', 'folder_id': None, 'task_ids': []},
                'expected_revision': revision, 'request_id': uuid.uuid4().hex})
        with patch.object(organizer, 'get_client', side_effect=staggered_client), ThreadPoolExecutor(max_workers=2) as worker:
            old = worker.submit(submit_message, '归档办公效率', 0)
            self.assertTrue(old_started.wait(5))
            cancelled = sessions.action(sid, 'cancel', {'expected_revision': 1, 'request_id': 'stop', 'plan_id': None})
            new = worker.submit(submit_message, '那帮我归档', cancelled['revision'])
            self.assertTrue(new_started.wait(5))
            old_end.set()
            old.result(timeout=10)
            current = sessions.get(sid)
            self.assertEqual(current['status'], 'planning')
            with self.assertRaisesRegex(ValueError, '仍在运行'):
                sessions.action(sid, 'recover', {'expected_revision': current['revision'], 'request_id': 'recover', 'plan_id': None})
            new_end.set()
            self.assertEqual(new.result(timeout=10)['status'], 'awaiting_approval')


if __name__ == '__main__':
    unittest.main()
