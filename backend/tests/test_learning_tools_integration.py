import copy
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from app.models.ai_requests import AskRequest
from app.services import chat_service, model_context, organizer, web_search
from tests.test_automatic_search import AutomaticSearchTests, SOURCE
from tests.test_organizer_sessions import OrganizerSessionsTest


class LearningToolsIntegrationTests(unittest.TestCase):
    client = AutomaticSearchTests.client

    def setUp(self):
        AutomaticSearchTests.setUp(self)
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        setting = patch.object(model_context, 'SETTINGS_PATH', Path(directory.name) / 'context.json')
        setting.start()
        self.addCleanup(setting.stop)

    def request(self, **changes):
        return AskRequest(**dict(task_id='one', question='Public question', provider_id='test',
                                model_name='synthetic', context_mode='selection', web_search_mode='external', **changes))

    def test_real_sdk_stream_and_nonstream_keep_tool_receipts_and_effective_budget(self):
        model_context.save_settings('test', 'synthetic', model_window=64000, user_limit=32000, output_reserve=2048)
        for stream in (False, True):
            gpt = self.client('openai-chat', stream=stream, read_page=True)
            page = {'text': 'Current public page', 'truncated': False, 'retrieved_at': '2026-10-15T00:00:00Z'}
            with patch.object(web_search, 'search_web', return_value=[SOURCE.copy()]), patch.object(web_search, 'read_web_page', return_value=page):
                events = list(chat_service._chat_with_client(gpt, self.request(), stream=stream))
            result = events[-1]['result']
            self.assertEqual([item['tool'] for item in result['tool_events']], ['search_web', 'read_web_page'])
            self.assertEqual([item['status'] for item in result['tool_events']], ['succeeded', 'succeeded'])
            receipts = [event['event'] for event in events if event['type'] == 'tool_event']
            self.assertEqual(receipts, result['tool_events'])
            self.assertEqual(result['context']['limit'], 29952)
            self.assertEqual(result['context']['model_context']['output_reserve'], 2048)
            self.assertEqual(self.wire[0]['max_tokens'], 2048)
            self.assertEqual(result['sources'][0]['evidence_type'], 'page')

    def test_provider_error_after_search_keeps_completed_receipt(self):
        gpt = self.client('openai-chat')
        original = chat_service.complete
        calls = []
        def provider(*args, **kwargs):
            calls.append(1)
            if len(calls) > 1:
                raise ValueError('synthetic provider failure')
            return original(*args, **kwargs)
        with patch.object(web_search, 'search_web', return_value=[SOURCE.copy()]), patch.object(chat_service, 'complete', side_effect=provider):
            with self.assertRaisesRegex(ValueError, 'provider failure') as caught:
                list(chat_service._chat_with_client(gpt, self.request()))
        self.assertEqual(caught.exception.tool_events[0]['status'], 'succeeded')
        self.assertEqual(caught.exception.tool_events[0]['tool'], 'search_web')

    def test_unknown_window_does_not_send_oversized_single_history_to_model(self):
        gpt = self.client('openai-chat', calls=False)
        history = [{'role': 'user', 'content': 'x' * 80000}]
        before = copy.deepcopy(history)
        with self.assertRaisesRegex(ValueError, '上下文'):
            list(chat_service._chat_with_client(gpt, self.request(history=history)))
        self.assertEqual(self.wire, [])
        self.assertEqual(history, before)

    def test_organizer_tool_receipts_are_durable_and_stream_visible(self):
        case = OrganizerSessionsTest('test_runtime_identity_changes_without_deleting_history')
        case.setUp()
        self.addCleanup(case.doCleanups)
        record = {'id': 'trace-one', 'tool': 'search_web', 'status': 'succeeded', 'query': 'public term', 'service': 'tavily'}
        seen = []
        def answer(*args, **kwargs):
            kwargs['tool_events_sink'].append(record.copy())
            kwargs['event_sink']({'type': 'tool_event', 'event': record.copy()})
            response = case.http.get('/api/organizer/sessions/' + case.session['session_id']).json()['data']
            seen.extend(response['streaming_tool_events'])
            return 'Public answer'
        with patch.object(organizer, 'answer', side_effect=answer):
            result = case.message('查询UV')
        self.assertEqual(result['status'], 'completed')
        self.assertEqual(result['history'][-1]['tool_events'], [record])
        self.assertEqual(seen, [record])
        reloaded = case.http.get('/api/organizer/sessions/' + case.session['session_id']).json()['data']
        self.assertEqual(reloaded['history'][-1]['tool_events'], [record])
        self.assertEqual(reloaded['streaming_tool_events'], [])

    def test_organizer_failure_keeps_web_receipt(self):
        case = OrganizerSessionsTest('test_runtime_identity_changes_without_deleting_history')
        case.setUp()
        self.addCleanup(case.doCleanups)
        record = {'id': 'trace-failed', 'tool': 'read_web_page', 'status': 'failed', 'error': 'HTTP 403'}
        def answer(*args, **kwargs):
            kwargs['tool_events_sink'].append(record.copy())
            raise ValueError('synthetic provider failure')
        with patch.object(organizer, 'answer', side_effect=answer):
            result = case.message('查询UV')
        self.assertEqual(result['status'], 'failed')
        self.assertEqual(result['history'][-1]['tool_events'], [record])
