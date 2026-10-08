import base64
import copy
import hashlib
import json
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError
from app.models.ai_requests import AskRequest, Attachment
from app.routers import organizer as organizer_router, chat as chat_router
from app.services import organizer, note_storage as notes, note_folders as folders, note_library as library, chat_service
from app.services import ai_client
from app.services.chat_tools import execute_tool


def completion(content, tool_calls=None):
    return types.SimpleNamespace(choices=[types.SimpleNamespace(message=types.SimpleNamespace(content=content, tool_calls=tool_calls))])


class AIUpdatesTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        root = Path(temp.name)
        for obj, name, value in ((notes, 'ROOT', root / 'notes'), (folders, 'STATE_PATH', root / 'folders.json'),
                                 (library, 'STATE_PATH', root / 'library.json'), (organizer, 'JOURNAL_ROOT', root / 'plans')):
            context = patch.object(obj, name, value)
            context.start()
            self.addCleanup(context.stop)
        for task_id, title in (('one', 'UV 展开'), ('two', '烘焙教程')):
            notes.save_task({'id': task_id, 'status': 'SUCCESS', 'audioMeta': {'title': title},
                             'markdown': '# SECRET_FULL_NOTE', 'transcript': {'full_text': 'SECRET_TRANSCRIPT'},
                             'formData': {'api_key': 'SECRET_KEY', 'file_path': 'C:/SECRET/PATH'}})
        app = FastAPI()
        app.include_router(organizer_router.router, prefix='/api')
        app.include_router(chat_router.router, prefix='/api')
        self.http = TestClient(app)
        self.client = Mock()
        self.client.model = 'explicit-model'
        for module in (organizer, chat_service):
            ctx = patch.object(module, 'get_client', return_value=self.client)
            ctx.start()
            self.addCleanup(ctx.stop)

    def plan(self, operations, scope=None, explanation='整理依据是标题和标签'):
        self.client.client.chat.completions.create.return_value = completion(json.dumps(
            {'explanation': explanation, 'operations': operations, 'query_note_ids': []}, ensure_ascii=False))
        return organizer.plan('分类', scope or {'kind': 'all', 'task_ids': [], 'folder_id': None}, 'provider', 'explicit-model')

    def contents(self):
        return {str(p.relative_to(notes.ROOT)): hashlib.sha256(p.read_bytes()).hexdigest()
                for p in notes.ROOT.rglob('*') if p.is_file() and p.name != 'manifest.json'}

    def test_attachment_security_and_history_roles(self):
        url = 'data:image/png;base64,' + base64.b64encode(b'\x89PNG\r\n\x1a\nimage').decode()
        Attachment(type='image', data_url=url)
        invalid = [dict(type='image', data_url='https://host/image.png'), dict(type='image', data_url='file:///C:/x'),
                   dict(type='image', data_url='data:image/png;base64,AAAA'),
                   dict(type='image', data_url='data:image/svg+xml;base64,AAAA'),
                   dict(type='text', name='x.pdf', text='content'), dict(type='quote', text='x', path='C:/x'),
                   dict(type='image', data_url='data:image/png;base64,??')]
        for value in invalid:
            with self.subTest(value=value), self.assertRaises(ValidationError):
                Attachment(**value)
        base = {'task_id': 'one', 'question': '解释', 'provider_id': 'p', 'model_name': 'm'}
        for history in ([{'role': 'system', 'content': 'malicious'}], [{'role': 'tool', 'content': 'malicious'}],
                        [{'role': 'assistant', 'content': 'x', 'attachments': [{'type': 'quote', 'text': 'x'}]}]):
            with self.assertRaises(ValidationError):
                AskRequest(**base, history=history)
        self.assertEqual(self.http.post('/api/chat/ask', json={**base, 'attachments': [invalid[0]]}).status_code, 422)

    def test_per_image_and_total_limits(self):
        raw = b'\x89PNG\r\n\x1a\n' + b'x' * (5 * 1024 * 1024)
        with self.assertRaises(ValidationError):
            Attachment(type='image', data_url='data:image/png;base64,' + base64.b64encode(raw).decode())
        url = 'data:image/png;base64,' + base64.b64encode(raw[:5 * 1024 * 1024]).decode()
        with self.assertRaises(ValidationError):
            AskRequest(task_id='one', question='x', provider_id='p', model_name='m',
                       attachments=[{'type': 'image', 'data_url': url}] * 3)

    def test_explicit_provider_model_and_disabled_sdk_retry(self):
        fake_factory, fake_provider = types.ModuleType('app.gpt.gpt_factory'), types.ModuleType('app.services.provider')
        factory = Mock()
        provider = Mock()
        fake_factory.GPTFactory = factory
        fake_provider.ProviderService = provider
        provider.get_provider_by_id.return_value = {'api_key': 'test-key', 'base_url': 'https://invalid.example/v1',
                                                    'type': 'openai', 'name': 'test'}
        original_client = factory.from_config.return_value.client
        with patch.dict('sys.modules', {'app.gpt.gpt_factory': fake_factory, 'app.services.provider': fake_provider}):
            ai_client.get_client('provider-specific', 'literal-model')
            config = factory.from_config.call_args.args[0]
            self.assertEqual(config.model_name, 'literal-model')
            original_client.with_options.assert_called_once_with(max_retries=0, timeout=120.0)
            provider.get_provider_by_id.return_value = None
            with self.assertRaisesRegex(ValueError, '未找到'):
                ai_client.get_client('missing-provider', 'literal-model')
            self.assertEqual(factory.from_config.call_count, 1)

    def test_selection_chat_preserves_inline_history_and_explicit_model(self):
        self.client.client.chat.completions.create.return_value = completion('解释成功')
        result = chat_service.chat('one', '解释所选内容', [{'role': 'user', 'content': '此前提问',
            'attachments': [{'type': 'text', 'name': 'context.md', 'text': 'HISTORY_ATTACHMENT'}]}],
            'provider', 'explicit-model', [{'type': 'quote', 'name': 'H2', 'text': 'SELECTED_QUOTE'}], 'selection')
        self.assertEqual(result['answer'], '解释成功')
        call = self.client.client.chat.completions.create.call_args.kwargs
        self.assertEqual(call['model'], 'explicit-model')
        self.assertIn('HISTORY_ATTACHMENT', str(call['messages']))
        self.assertIn('SELECTED_QUOTE', str(call['messages']))
        self.assertIn('tools', call)

    def test_tool_call_and_note_rag_survive(self):
        tool = types.SimpleNamespace(id='tool-one', function=types.SimpleNamespace(name='get_note_content', arguments='{}'))
        self.client.client.chat.completions.create.side_effect = [completion(None, [tool]), completion('含正文回答')]
        with patch.object(chat_service, 'VectorStoreManager') as vector:
            vector.return_value.query.return_value = [{'text': 'RAG_FRAGMENT', 'metadata': {'source_type': 'markdown'}}]
            result = chat_service.chat('one', '问', [], 'provider', 'explicit-model')
        self.assertEqual(result['sources'][0]['source_type'], 'markdown')
        second = self.client.client.chat.completions.create.call_args.kwargs['messages']
        self.assertIn('SECRET_FULL_NOTE', second[-1]['content'])

    def test_unavailable_rag_and_malformed_tool_args_fail_safely(self):
        self.client.client.chat.completions.create.return_value = completion('通过工具可继续问答')
        with patch.object(chat_service, 'VectorStoreManager', side_effect=RuntimeError('index unavailable')):
            result = chat_service.chat('one', '问', [], 'provider', 'explicit-model')
        self.assertEqual(result['answer'], '通过工具可继续问答')
        for arguments in ([], None, {'start_time': 'bad'}, {'keyword': []}, {'path': 'C:/x'}):
            self.assertIn('error', json.loads(execute_tool('one', 'lookup_transcript', arguments)))
        self.assertIn('error', json.loads(execute_tool('one', 'get_note_content', {'task_id': 'two'})))

    def test_empty_responses_never_become_successful_blank_messages(self):
        for response in (completion(None), completion('  '), types.SimpleNamespace(choices=[])):
            self.client.client.chat.completions.create.return_value = response
            with self.assertRaisesRegex(ValueError, '未返回有效回答'):
                chat_service.chat('one', '问', [], 'provider', 'explicit-model', context_mode='selection')
        body = self.http.post('/api/chat/ask', json={'task_id': 'one', 'question': '问', 'provider_id': 'provider',
                             'model_name': 'explicit-model', 'context_mode': 'selection'}).json()
        self.assertNotEqual(body['code'], 0)

    def test_repeated_tools_finish_with_explicit_no_tools_and_nonempty_answer(self):
        tool = types.SimpleNamespace(id='tool-one', function=types.SimpleNamespace(name='get_note_content', arguments='{}'))
        self.client.client.chat.completions.create.side_effect = [completion(None, [tool]), completion(None, [tool]), completion('最终回答')]
        with patch.object(chat_service, 'execute_tool', return_value='参考资料') as execute:
            result = chat_service.chat('one', '问', [], 'provider', 'explicit-model', context_mode='selection')
        self.assertEqual(result['answer'], '最终回答')
        self.assertEqual(execute.call_count, 1)
        final = self.client.client.chat.completions.create.call_args.kwargs
        self.assertEqual(final['tool_choice'], 'none')
        self.assertEqual(final['messages'][-1]['role'], 'user')
        self.assertEqual(self.client.client.chat.completions.create.call_count, 3)

    def test_final_tool_only_response_reports_error(self):
        tool = types.SimpleNamespace(id='tool-one', function=types.SimpleNamespace(name='get_note_content', arguments='{}'))
        self.client.client.chat.completions.create.side_effect = [completion(None, [tool])] * 3
        with self.assertRaisesRegex(ValueError, '没有正文'):
            chat_service.chat('one', '问', [], 'provider', 'explicit-model', context_mode='selection')
        self.assertEqual(self.client.client.chat.completions.create.call_count, 3)

    def test_reasoning_budget_and_usage_are_effective(self):
        from app.services.ai_runtime import complete
        response = completion('答案')
        response.usage = types.SimpleNamespace(prompt_tokens=2345)
        self.client.model = 'gpt-5.4'
        self.client.client.chat.completions.create.return_value = response
        result = chat_service.chat('one', '问', [], 'provider', 'gpt-5.4', context_mode='selection', reasoning_effort='high', context_limit=272000)
        call = self.client.client.chat.completions.create.call_args.kwargs
        self.assertEqual(call['reasoning_effort'], 'high')
        self.assertNotIn('temperature', call)
        self.assertEqual(result['context'], {'input_tokens': 2345, 'estimated': False, 'limit': 272000, 'warning': False})
        count = self.client.client.chat.completions.create.call_count
        with self.assertRaisesRegex(ValueError, '上下文接近'):
            complete(self.client.client, 'gpt-5.4', [{'role': 'user', 'content': '大' * 100000}], context_limit=272000)
        with self.assertRaisesRegex(ValueError, '思考档位'):
            complete(self.client.client, 'unknown-model', [{'role': 'user', 'content': 'x'}], reasoning_effort='high')
        self.assertEqual(self.client.client.chat.completions.create.call_count, count)

    def test_gpt6_reasoning_uses_note_context_without_incompatible_tools(self):
        self.client.model = 'gpt-6-sol'
        self.client.client.chat.completions.create.return_value = completion('答案')
        with patch.object(chat_service, 'VectorStoreManager') as vector:
            vector.return_value.query.return_value = []
            chat_service.chat('one', '问', [], 'provider', 'gpt-6-sol', reasoning_effort='high')
        call = self.client.client.chat.completions.create.call_args.kwargs
        self.assertNotIn('tools', call)
        self.assertEqual(call['reasoning_effort'], 'high')
        self.assertIn('SECRET_FULL_NOTE', str(call['messages']))

    def test_compaction_preserves_original_recent_turns_and_prior_memory(self):
        from app.services.context_compaction import compact_history
        history = [{'role': 'user' if i % 2 == 0 else 'assistant', 'content': f'记录{i} ' + '资料' * 500} for i in range(10)]
        original = copy.deepcopy(history)
        self.client.client.chat.completions.create.return_value = completion('目标：整理UV。限制：不要归档。已确认事实：暗号蓝色积木。待办：检查最后四条问题。')
        result = compact_history(self.client.client, 'explicit-model', history, '旧约束：不要删除')
        self.assertTrue(result['compacted'])
        self.assertEqual(result['consumed_messages'], 6)
        self.assertEqual(history, original)
        call = self.client.client.chat.completions.create.call_args.kwargs
        self.assertIn('旧约束：不要删除', str(call['messages']))
        self.assertNotIn(history[-1]['content'], str(call['messages']))
        self.assertEqual(call['max_tokens'], 2048)
        self.assertLess(result['after_tokens'], result['before_tokens'])
        self.client.client.chat.completions.create.reset_mock()
        self.assertFalse(compact_history(self.client.client, 'explicit-model', history[-4:])['compacted'])
        self.client.client.chat.completions.create.assert_not_called()
        self.client.client.chat.completions.create.return_value = completion('')
        with self.assertRaises(ValueError):
            compact_history(self.client.client, 'explicit-model', history, '旧摘要')
        self.assertEqual(history, original)
        truncated = completion('尚未写完的摘要')
        truncated.choices[0].finish_reason = 'length'
        self.client.client.chat.completions.create.return_value = truncated
        with self.assertRaisesRegex(ValueError, '未完整生成'):
            compact_history(self.client.client, 'explicit-model', history, '旧摘要')
        self.assertEqual(history, original)

    def test_reading_auto_compacts_before_answer_without_losing_current_question(self):
        history = [{'role': 'user' if i % 2 == 0 else 'assistant', 'content': f'旧记录{i} ' + 'x' * 30000} for i in range(8)]
        self.client.client.chat.completions.create.side_effect = [completion('压缩摘要：必须保留UV目标，禁止归档。'), completion('回答当前问题')]
        result = chat_service.chat('one', 'CURRENT_QUESTION', history, 'provider', 'explicit-model', context_mode='selection')
        self.assertEqual(result['compaction']['consumed_messages'], 4)
        self.assertEqual(result['answer'], '回答当前问题')
        messages = self.client.client.chat.completions.create.call_args.kwargs['messages']
        self.assertEqual(messages[-1]['content'], 'CURRENT_QUESTION')
        self.assertIn(history[-1]['content'], str(messages))
        self.assertNotIn(history[0]['content'], str(messages))
        self.assertNotIn('压缩摘要', messages[0]['content'])

    def test_reading_compaction_endpoint_and_fixed_window(self):
        history = [{'role': 'user' if i % 2 == 0 else 'assistant', 'content': '重要内容' * 400} for i in range(8)]
        self.client.client.chat.completions.create.return_value = completion('保留重要内容与用户限制。')
        with patch.object(ai_client, 'get_client', return_value=self.client):
            response = self.http.post('/api/chat/compact', json={'task_id': 'one', 'provider_id': 'provider', 'model_name': 'explicit-model', 'history': history}).json()
        self.assertEqual(response['code'], 0)
        self.assertEqual(response['data']['consumed_messages'], 4)
        self.assertEqual(response['data']['context']['limit'], 272000)
        with self.assertRaises(ValidationError):
            AskRequest(task_id='one', question='x', provider_id='p', model_name='m', context_limit=64000)

    def test_metadata_only_model_and_plan_does_not_mutate_library(self):
        before = organizer._snapshot()
        result = self.plan([{'type': 'set_tags', 'task_ids': ['one'], 'tags': ['UV']}])
        self.assertEqual(before, organizer._snapshot())
        payload = str(self.client.client.chat.completions.create.call_args.kwargs['messages'])
        for secret in ('SECRET_FULL_NOTE', 'SECRET_TRANSCRIPT', 'SECRET_KEY', 'SECRET/PATH', 'remark', 'resource_base'):
            self.assertNotIn(secret, payload)
        journal = organizer._read(result['plan_id'])
        self.assertNotIn('SECRET_FULL_NOTE', json.dumps(journal))
        self.assertEqual(result['scope_count'], 2)
        self.assertTrue(result['metadata_only'])

    def test_full_execute_undo_idempotency_and_content_preservation(self):
        contents = self.contents()
        all_files = {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in notes.ROOT.rglob('*') if p.is_file()}
        before = organizer._snapshot()
        p = self.plan([{'type': 'create_folder', 'ref': 'new_uv', 'name': 'UV'},
                       {'type': 'move_notes', 'task_ids': ['one'], 'folder_id': 'new_uv'},
                       {'type': 'set_tags', 'task_ids': ['one'], 'tags': ['UV']},
                       {'type': 'archive', 'task_ids': ['two']}])
        result = organizer.execute(p['plan_id'])
        self.assertEqual(result['status'], 'executed')
        after = organizer._snapshot()
        self.assertEqual(organizer.execute(p['plan_id']), result)
        self.assertEqual(after, organizer._snapshot())
        self.assertTrue(notes.get_task('two')['archived_at'])
        self.assertEqual(organizer.undo(p['plan_id'])['status'], 'undone')
        self.assertEqual(before, organizer._snapshot())
        self.assertEqual(self.contents(), contents)
        self.assertEqual(all_files, {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in notes.ROOT.rglob('*') if p.is_file()})
        self.assertEqual(organizer.undo(p['plan_id'])['status'], 'undone')

    def test_stale_plan_does_not_write(self):
        p = self.plan([{'type': 'set_tags', 'task_ids': ['one'], 'tags': ['UV']}])
        library.update_entries(['two'], {'favorite': True})
        before = organizer._snapshot()
        with self.assertRaisesRegex(ValueError, '变化'):
            organizer.execute(p['plan_id'])
        self.assertEqual(before, organizer._snapshot())

    def test_undo_preserves_unrelated_fields_and_blocks_conflicts(self):
        p = self.plan([{'type': 'set_tags', 'task_ids': ['one'], 'tags': ['UV']}])
        organizer.execute(p['plan_id'])
        library.update_entries(['one'], {'favorite': True})
        organizer.undo(p['plan_id'])
        self.assertTrue(library.list_entries()['entries']['one']['favorite'])
        self.assertEqual(library.list_entries()['entries']['one']['tags'], [])
        p = self.plan([{'type': 'set_tags', 'task_ids': ['one'], 'tags': ['UV']}])
        organizer.execute(p['plan_id'])
        library.update_entries(['one'], {'tags': ['USER_EDIT']})
        before = organizer._snapshot()
        with self.assertRaisesRegex(ValueError, '再次修改'):
            organizer.undo(p['plan_id'])
        self.assertEqual(before, organizer._snapshot())

    def test_whitelist_scope_and_query(self):
        scope = {'kind': 'selected', 'task_ids': ['one'], 'folder_id': None}
        for operations in ([{'type': 'delete', 'task_ids': ['one']}],
                           [{'type': 'set_tags', 'task_ids': ['two'], 'tags': ['x']}],
                           [{'type': 'set_tags', 'task_ids': ['one'], 'tags': ['x'], 'path': 'evil'}],
                           [{'type': 'set_tags', 'task_ids': ['one'], 'tags': ['x']},
                            {'type': 'set_tags', 'task_ids': ['one'], 'tags': ['y']}]):
            with self.subTest(operations=operations), self.assertRaises(ValueError):
                self.plan(operations, scope)
        p = self.plan([], explanation='找到两篇教程')
        with self.assertRaisesRegex(ValueError, '查询'):
            organizer.execute(p['plan_id'])

    def test_execution_failure_rolls_back_and_cannot_reexecute(self):
        before = organizer._snapshot()
        p = self.plan([{'type': 'set_tags', 'task_ids': ['one'], 'tags': ['UV']}, {'type': 'archive', 'task_ids': ['two']}])
        with patch.object(notes, 'set_archived', side_effect=OSError('write failure')):
            with self.assertRaisesRegex(RuntimeError, '已恢复'):
                organizer.execute(p['plan_id'])
        self.assertEqual(before, organizer._snapshot())
        self.assertEqual(organizer._read(p['plan_id'])['status'], 'failed')
        with self.assertRaises(ValueError):
            organizer.execute(p['plan_id'])

    def test_interrupted_execution_recovers_only_own_metadata(self):
        p = self.plan([{'type': 'set_tags', 'task_ids': ['one'], 'tags': ['UV']}, {'type': 'archive', 'task_ids': ['two']}])
        record = organizer._read(p['plan_id'])
        record['status'] = 'executing'
        record['after'] = organizer._project(record['before'], record['operations'], '2026-10-01T00:00:00Z')
        organizer._save(record)
        library.update_entries(['one'], {'tags': ['UV'], 'favorite': True})
        self.assertEqual(organizer.recover(p['plan_id'])['status'], 'failed')
        self.assertEqual(library.list_entries()['entries']['one']['tags'], [])
        self.assertTrue(library.list_entries()['entries']['one']['favorite'])
        self.assertFalse(notes.get_task('two')['archived_at'])

    def test_interrupted_undo_completes_and_blocks_running_archive_restore(self):
        p = self.plan([{'type': 'set_tags', 'task_ids': ['one'], 'tags': ['UV']}])
        organizer.execute(p['plan_id'])
        record = organizer._read(p['plan_id'])
        current = organizer._snapshot()
        target = organizer._undo_state(record, current)
        record.update(status='undoing', undo_before=current, undo_target=target)
        organizer._save(record)
        organizer._restore(target)
        self.assertEqual(organizer.recover(p['plan_id'])['status'], 'undone')
        notes.set_archived('two', True)
        p = self.plan([{'type': 'restore', 'task_ids': ['two']}])
        organizer.execute(p['plan_id'])
        notes.set_status('two', 'PENDING')
        with self.assertRaisesRegex(ValueError, '正在生成'):
            organizer.undo(p['plan_id'])

    def test_restore_and_rename_folder_undo(self):
        notes.set_archived('two', True)
        archived = notes.get_task('two')['archived_at']
        p = self.plan([{'type': 'rename_folder', 'folder_id': 'distill', 'name': '课程'},
                       {'type': 'restore', 'task_ids': ['two']}])
        organizer.execute(p['plan_id'])
        self.assertFalse(notes.get_task('two')['archived_at'])
        self.assertEqual(folders._folder(folders._read(), 'distill')['name'], '课程')
        organizer.undo(p['plan_id'])
        self.assertEqual(notes.get_task('two')['archived_at'], archived)
        self.assertEqual(folders._folder(folders._read(), 'distill')['name'], '蒸馏视频')

    def test_undo_new_folder_with_later_assignment_is_blocked(self):
        p = self.plan([{'type': 'create_folder', 'ref': 'new', 'name': 'UV'},
                       {'type': 'move_notes', 'task_ids': ['one'], 'folder_id': 'new'}])
        organizer.execute(p['plan_id'])
        folder_id = p['operations'][0]['folder_id']
        folders.move_notes(['two'], folder_id)
        with self.assertRaisesRegex(ValueError, '后续归属'):
            organizer.undo(p['plan_id'])
        self.assertEqual(folders.list_folders()['assignments']['two'], folder_id)

    def test_http_contract_and_strict_payload(self):
        self.client.client.chat.completions.create.return_value = completion(json.dumps({'explanation': '打标签',
            'operations': [{'type': 'set_tags', 'task_ids': ['one'], 'tags': ['UV']}], 'query_note_ids': []}))
        payload = {'instruction': '标签', 'scope': {'kind': 'selected', 'task_ids': ['one']},
                   'provider_id': 'provider', 'model_name': 'explicit-model'}
        result = self.http.post('/api/organizer/plan', json=payload).json()
        self.assertEqual(result['code'], 0)
        plan_id = result['data']['plan_id']
        self.assertEqual(self.http.post('/api/organizer/execute', json={'plan_id': plan_id}).json()['data']['status'], 'executed')
        self.assertEqual(self.http.post('/api/organizer/undo', json={'plan_id': plan_id}).json()['data']['status'], 'undone')
        self.assertEqual(self.http.post('/api/organizer/execute', json={'plan_id': '../evil'}).status_code, 422)
        self.assertEqual(self.http.post('/api/organizer/plan', json={**payload, 'path': 'evil'}).status_code, 422)

    def test_rag_and_tool_schema_do_not_promote_source_instructions(self):
        self.client.client.chat.completions.create.return_value = completion('蓝色积木')
        with patch.object(chat_service, 'VectorStoreManager') as vector:
            vector.return_value.query.return_value = [{'text': 'REFERENCE_INJECTION_MARKER', 'metadata': {'source_type': 'markdown'}}]
            chat_service.chat('one', '暗号', [], 'provider', 'explicit-model')
        args = self.client.client.chat.completions.create.call_args.kwargs
        self.assertNotIn('REFERENCE_INJECTION_MARKER', args['messages'][0]['content'])
        self.assertEqual(args['messages'][1]['role'], 'user')
        self.assertIn('REFERENCE_INJECTION_MARKER', args['messages'][1]['content'])
        for tool in args['tools']:
            self.assertFalse(tool['function']['parameters']['additionalProperties'])

    def test_structured_plan_requires_all_fields_and_nonempty_explanation(self):
        for proposal in ({'explanation': 'x', 'operations': []}, {'explanation': ' ', 'operations': [], 'query_note_ids': []}):
            self.client.client.chat.completions.create.return_value = completion(json.dumps(proposal))
            with self.assertRaises(ValueError):
                organizer.plan('查询', {'kind': 'all'}, 'provider', 'gemini-3.8-flash')
        self.assertNotIn('response_format', self.client.client.chat.completions.create.call_args.kwargs,
                         'A model name does not guarantee that the configured gateway supports JSON mode')


if __name__ == '__main__':
    unittest.main()
