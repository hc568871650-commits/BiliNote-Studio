"""Real SSE adapters and tool loops, backed only by local HTTP fixtures."""
import json
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
from unittest.mock import patch

import httpx
from openai import OpenAI

from app.models.ai_requests import AskRequest
from app.services import chat_service, organizer, web_search
from tests import test_automatic_search as fixtures
from tests import test_organizer_sessions as session_fixtures


class VisibleToolRoundsTests(unittest.TestCase):
    setUp = fixtures.AutomaticSearchTests.setUp

    def client(self, texts, stream=True, fail_last=False):
        self.wire = []

        def handle(request):
            self.wire.append(json.loads(request.content))
            index = len(self.wire) - 1
            if fail_last and index == len(texts) - 1:
                return httpx.Response(502, json={'error': {'message': 'synthetic failure'}})
            message = {'role': 'assistant', 'content': texts[index]}
            if index < len(texts) - 1:
                message['tool_calls'] = [{'id': f'call-{index}', 'type': 'function', 'function': {
                    'name': 'search_web', 'arguments': json.dumps({'query': f'public query {min(index, 1)}'})}}]
            reason = 'tool_calls' if message.get('tool_calls') else 'stop'
            if stream:
                if message.get('tool_calls'):
                    message['tool_calls'][0]['index'] = 0
                events = [{'choices': [{'index': 0, 'delta': message, 'finish_reason': None}]},
                          {'choices': [{'index': 0, 'delta': {}, 'finish_reason': reason}]}]
                return httpx.Response(200, headers={'content-type': 'text/event-stream'},
                    content=''.join('data: ' + json.dumps(event) + '\n\n' for event in events) + 'data: [DONE]\n\n')
            return httpx.Response(200, json={'id': 'fixture', 'object': 'chat.completion', 'created': 0,
                'model': 'synthetic', 'choices': [{'index': 0, 'message': message, 'finish_reason': reason}]})

        sdk = OpenAI(api_key='synthetic-only', base_url='https://model.invalid/v1', max_retries=0,
                     http_client=httpx.Client(transport=httpx.MockTransport(handle)))
        self.addCleanup(sdk.close)
        return SimpleNamespace(model='synthetic', client=sdk)

    def reading(self, gpt, stream=True):
        request = AskRequest(task_id='one', question='查一下公开资料', provider_id='test', model_name='synthetic',
                             context_mode='selection', web_search_mode='external')
        return chat_service._chat_with_client(gpt, request, stream=stream)

    def test_reading_stream_and_saved_answer_keep_all_visible_rounds(self):
        for texts in (['我现在开始查资料。', '再核对一次。', '结论。'],
                      ['我现在开始查资料。', '', '结论。'], ['', '', '结论。'], ['直接回答。']):
            with self.subTest(texts=texts):
                with patch.object(web_search, 'search_web', return_value=[fixtures.SOURCE]):
                    events = list(self.reading(self.client(texts)))
                self.assertEqual(''.join(event.get('text', '') for event in events if event['type'] == 'delta'), ''.join(texts))
                self.assertEqual(events[-1]['result']['answer'], texts[-1])
                self.assertEqual(events[-1]['result']['work_log'], [text for text in texts[:-1] if text])
                self.assertEqual([event['text'] for event in events if event['type'] == 'work_log'], texts[:-1])
                self.assertFalse(any(event.get('reset_text') for event in events))

    def test_nonstream_has_same_complete_transcript(self):
        texts = ['先核对。', '结论。']
        with patch.object(web_search, 'search_web', return_value=[fixtures.SOURCE]):
            events = list(self.reading(self.client(texts, stream=False), stream=False))
        self.assertEqual(events[-1]['result']['answer'], texts[-1])
        self.assertEqual(events[-1]['result']['work_log'], texts[:-1])

    def test_forced_final_after_cached_tool_preserves_commentary(self):
        texts = ['先查。', '再查。', '重复查询。', '已有证据的结论。']
        with patch.object(web_search, 'search_web', return_value=[fixtures.SOURCE]) as search:
            events = list(self.reading(self.client(texts)))
        self.assertEqual(search.call_count, 2)
        self.assertEqual(self.wire[-1]['tool_choice'], 'none')
        self.assertEqual(events[-1]['result']['answer'], texts[-1])
        self.assertEqual(events[-1]['result']['work_log'], texts[:-1])
        self.assertEqual(''.join(e.get('text', '') for e in events if e['type'] == 'delta'), ''.join(texts))

    def test_organizer_keeps_stream_and_final_with_empty_middle_round(self):
        events = []
        texts = ['我先查一下。', '', '已核对，结论。']
        with patch.object(organizer, 'get_client', return_value=self.client(texts)), \
             patch.object(organizer, '_run_library_tool', return_value={'results': []}), \
             patch.object(web_search, 'search_web', return_value=[fixtures.SOURCE]):
            answer = organizer.answer('查公开资料', 'test', 'synthetic', [], {}, {},
                                      web_search_mode='external', event_sink=events.append)
        self.assertEqual(answer, '已核对，结论。')
        self.assertEqual([e['text'] for e in events if e['type'] == 'work_log'], texts[:-1])
        self.assertFalse(any(e['type'] == 'reset' for e in events))

    def test_later_failure_never_erases_visible_text_or_reports_done(self):
        for entry in ('reading', 'organizer'):
            with self.subTest(entry=entry):
                events = []
                gpt = self.client(['我先查一下。', '不会返回'], fail_last=True)
                with patch.object(web_search, 'search_web', return_value=[fixtures.SOURCE]):
                    with self.assertRaises(Exception):
                        if entry == 'reading':
                            for event in self.reading(gpt):
                                events.append(event)
                        else:
                            with patch.object(organizer, 'get_client', return_value=gpt), \
                                 patch.object(organizer, '_run_library_tool', return_value={'results': []}):
                                organizer.answer('查资料', 'test', 'synthetic', [], {}, {},
                                                 web_search_mode='external', event_sink=events.append)
                self.assertEqual(''.join(e.get('text', '') for e in events if e['type'] == 'delta'), '我先查一下。')
                self.assertFalse(any(e.get('reset_text') or e['type'] in ('reset', 'done') for e in events))

    def test_empty_final_is_still_an_error_despite_commentary(self):
        with patch.object(web_search, 'search_web', return_value=[fixtures.SOURCE]):
            with self.assertRaisesRegex(ValueError, '未返回有效回答'):
                list(self.reading(self.client(['我先查一下。', ''])))


class VisibleSessionPersistenceTests(unittest.TestCase):
    setUp = session_fixtures.OrganizerSessionsTest.setUp
    client = session_fixtures.OrganizerSessionsTest.client
    message = session_fixtures.OrganizerSessionsTest.message

    def test_second_round_keeps_live_text_and_completed_session_history(self):
        sessions = session_fixtures.sessions
        waiting, release = threading.Event(), threading.Event()
        requests = []

        def handle(request):
            requests.append(request)
            if len(requests) == 1:
                delta = {'content': '我现在开始查阅笔记。', 'tool_calls': [{'index': 0, 'id': 'c1',
                    'type': 'function', 'function': {'name': 'search_library', 'arguments': '{"query":"软件"}'}}]}
                reason = 'tool_calls'
            else:
                waiting.set()
                if not release.wait(5):
                    raise RuntimeError('test second round timeout')
                delta, reason = {'content': '这是查阅后的回答。'}, 'stop'
            events = [{'choices': [{'index': 0, 'delta': delta}]},
                      {'choices': [{'index': 0, 'delta': {}, 'finish_reason': reason}]}]
            return httpx.Response(200, headers={'content-type': 'text/event-stream'},
                content=''.join('data: ' + json.dumps(event) + '\n\n' for event in events) + 'data: [DONE]\n\n')

        sdk = OpenAI(api_key='synthetic-only', base_url='https://model.invalid/v1', max_retries=0,
                     http_client=httpx.Client(transport=httpx.MockTransport(handle)))
        self.addCleanup(sdk.close)
        sid = self.session['session_id']
        with patch.object(organizer, 'get_client', return_value=SimpleNamespace(model='synthetic', client=sdk)), \
             ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(self.message, '请解释这个软件怎么使用', web_search=False)
            try:
                self.assertTrue(waiting.wait(5))
                live = sessions.get(sid)
                self.assertEqual(live['status'], 'planning')
                self.assertEqual(live['streaming_reply'], '')
                self.assertEqual(live['streaming_work_log'], ['我现在开始查阅笔记。'])
            finally:
                release.set()
            result = future.result(5)
        self.assertEqual(result['status'], 'completed')
        self.assertEqual(sessions.get(sid)['history'][-1]['content'], '这是查阅后的回答。')
        self.assertEqual(sessions.get(sid)['history'][-1]['work_log'], ['我现在开始查阅笔记。'])
        self.assertEqual(len(requests), 2)
