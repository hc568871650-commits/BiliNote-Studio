import copy
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.models.ai_requests import AskRequest
from app.models.organizer_requests import PlanRequest
from app.routers.model_capabilities import router
from app.services import model_context
from app.services.ai_runtime import complete
from app.services.context_compaction import compact_history


def response(text='回答'):
    return SimpleNamespace(choices=[SimpleNamespace(finish_reason='stop', message=SimpleNamespace(content=text, tool_calls=[]))])


class ModelContextTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.path = Path(temporary.name) / 'data' / 'model_context.json'
        patched = patch.object(model_context, 'SETTINGS_PATH', self.path)
        patched.start()
        self.addCleanup(patched.stop)

    def test_unknown_is_conservative_read_only_and_not_guessed_from_model_name(self):
        for name in ('unknown', 'gpt-6-astra', 'gemini-3.8-flash'):
            value = model_context.settings('relay', name)
            self.assertEqual(value['effective_window'], 65536)
            self.assertEqual(value['input_limit'], 61440)
            self.assertEqual(value['compact_threshold'], 49152)
            self.assertIn('65,536', value['source_label'])
            self.assertEqual(value['source'], 'unknown')
            self.assertFalse(value['verified'])
        self.assertFalse(self.path.exists())

    def test_saved_model_provider_profiles_are_independent_and_persisted(self):
        model_context.save_settings('one', 'shared', model_window=128000, user_limit=64000, output_reserve=8192)
        original = model_context.settings('one', 'shared')
        self.assertEqual(original['input_limit'], 55808)
        model_context.save_settings('two', 'shared', model_window=1000000)
        model_context.save_settings('one', 'different', model_window=16000)
        self.assertEqual(model_context.settings('one', 'shared'), original)
        self.assertEqual(model_context.settings('two', 'shared')['input_limit'], 267904)
        self.assertEqual(model_context.settings('one', 'different')['input_limit'], 11904)
        self.assertEqual(len(json.loads(self.path.read_text(encoding='utf-8'))['profiles']), 3)
        self.assertEqual(original['source'], 'manual')
        self.assertFalse(original['verified'])

    def test_request_limit_cannot_raise_saved_limit_or_model_capacity(self):
        model_context.save_settings('one', 'model', model_window=128000, user_limit=64000)
        self.assertEqual(model_context.resolve('one', 'model', 272000)['input_limit'], 59904)
        self.assertEqual(model_context.resolve('one', 'model', 32000)['input_limit'], 27904)
        self.assertEqual(model_context.resolve('other', 'model', 16000)['input_limit'], 11904)

    def test_preset_profiles_derive_budget_and_persist_per_provider_model(self):
        profiles = (
            ('one', 'shared', 65536, 4096, 61440, 49152),
            ('two', 'shared', 131072, 8192, 122880, 98304),
            ('one', 'other', 262144, 8192, 253952, 203161),
        )
        for provider, model, window, reserve, limit, threshold in profiles:
            value = model_context.save_settings(provider, model, model_window=window,
                                                user_limit=window, output_reserve=reserve)
            self.assertEqual(value['input_limit'], limit)
            self.assertEqual(value['compact_threshold'], threshold)
            self.assertEqual(value['source'], 'manual')
            self.assertFalse(value['verified'])
        persisted = json.loads(self.path.read_text(encoding='utf-8'))['profiles']
        self.assertEqual(len(persisted), 3)
        for provider, model, window, reserve, limit, threshold in profiles:
            value = model_context.settings(provider, model)
            self.assertEqual(value['model_window'], window)
            self.assertEqual(value['user_limit'], window)
            self.assertEqual(value['output_reserve'], reserve)
            self.assertEqual(value['input_limit'], limit)
            self.assertEqual(value['compact_threshold'], threshold)
        self.assertEqual(model_context.settings('other', 'shared')['source'], 'unknown')

    def test_invalid_changes_are_atomic(self):
        model_context.save_settings('one', 'model')
        original = self.path.read_bytes()
        for changes in ({'model_window': 4096}, {'model_window': True}, {'user_limit': 272001},
                        {'output_reserve': 62000}, {'output_reserve': 100}, {'user_limit': 8192, 'output_reserve': 8192}):
            with self.assertRaises(ValueError):
                model_context.save_settings('one', 'model', **changes)
            self.assertEqual(self.path.read_bytes(), original)
        with self.assertRaises(ValueError):
            model_context.resolve('one', 'model', True)

    def test_clearing_capacity_restores_unknown_without_clearing_other_settings(self):
        model_context.save_settings('one', 'model', model_window=128000, user_limit=64000, output_reserve=2048)
        value = model_context.save_settings('one', 'model', model_window=None, user_limit=64000, output_reserve=2048)
        self.assertEqual(value['input_limit'], 61952)
        self.assertEqual(value['source'], 'unknown')
        self.assertEqual(value['user_limit'], 64000)

    def test_invalid_existing_store_is_not_overwritten(self):
        self.path.parent.mkdir(parents=True)
        self.path.write_text('{"schema_version": 99, "profiles": {}}', encoding='utf-8')
        original = self.path.read_bytes()
        with self.assertRaises(ValueError):
            model_context.save_settings('one', 'model')
        self.assertEqual(self.path.read_bytes(), original)

    def test_routes_validate_and_keep_other_model(self):
        app = FastAPI()
        app.include_router(router, prefix='/api')
        http = TestClient(app)
        url = '/api/model_context/settings?provider_id=one&model_name=model'
        self.assertEqual(http.get(url).json()['data']['input_limit'], 61440)
        self.assertFalse(self.path.exists())
        self.assertEqual(http.put(url, json={'model_window': 128000}).json()['data']['input_limit'], 123904)
        self.assertEqual(http.put(url, json={'model_window': True}).status_code, 422)
        self.assertNotEqual(http.put(url, json={'model_window': 8192, 'output_reserve': 8192}).json()['code'], 0)
        self.assertEqual(http.get(url).json()['data']['input_limit'], 123904)
        self.assertEqual(http.get(url.replace('model_name=model', 'model_name=other')).json()['data']['input_limit'], 61440)

    def test_legacy_and_lower_user_request_limits_are_accepted_but_not_unbounded(self):
        base = dict(task_id='one', question='q', provider_id='p', model_name='m')
        self.assertEqual(AskRequest(**base).context_limit, 272000)
        self.assertEqual(AskRequest(**base, context_limit=64000).context_limit, 64000)
        self.assertEqual(PlanRequest(instruction='q', provider_id='p', model_name='m', context_limit=16000).context_limit, 16000)
        for value in (4096, 272001, True, '64000'):
            with self.assertRaises(ValidationError):
                AskRequest(**base, context_limit=value)

    def test_complete_enforces_resolved_input_budget_and_output_reserve(self):
        client = Mock()
        client.protocol = 'openai-chat'
        client.chat.completions.create.return_value = response()
        _, context = complete(client, 'unknown', [{'role': 'user', 'content': 'q'}], context_limit=28672, max_output_tokens=4096)
        self.assertEqual(context['limit'], 28672)
        self.assertEqual(client.chat.completions.create.call_args.kwargs['max_tokens'], 4096)
        count = client.chat.completions.create.call_count
        with self.assertRaisesRegex(ValueError, '预算'):
            complete(client, 'unknown', [{'role': 'user', 'content': 'x' * 29000}], context_limit=28672)
        for limit in (0, True, 272001):
            with self.assertRaises(ValueError):
                complete(client, 'unknown', [], context_limit=limit)
        self.assertEqual(client.chat.completions.create.call_count, count)

    def test_dynamic_compaction_preserves_history_and_uses_same_input_budget(self):
        client = Mock()
        client.protocol = 'openai-chat'
        client.chat.completions.create.return_value = response('用户目标、限制和未完成事项。')
        history = [{'role': 'user' if i % 2 == 0 else 'assistant', 'content': f'{i}: ' + 'x' * 2800} for i in range(12)]
        original = copy.deepcopy(history)
        value = compact_history(client, 'unknown', history, context_limit=16000, threshold=12800, output_reserve=1024)
        self.assertTrue(value['compacted'])
        self.assertEqual(value['context']['limit'], 16000)
        self.assertLess(value['consumed_messages'], 8)
        self.assertEqual(client.chat.completions.create.call_args.kwargs['max_tokens'], 1024)
        self.assertEqual(history, original)

    def test_oversize_single_message_is_preserved_without_request(self):
        client = Mock()
        history = [{'role': 'user', 'content': 'x' * 30000}, {'role': 'assistant', 'content': 'a'}]
        original = copy.deepcopy(history)
        with self.assertRaisesRegex(ValueError, '原记录已保留'):
            compact_history(client, 'unknown', history, keep_recent=0, context_limit=16000)
        self.assertEqual(history, original)
        client.chat.completions.create.assert_not_called()
