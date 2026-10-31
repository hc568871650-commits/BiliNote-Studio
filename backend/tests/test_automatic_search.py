"""Model-selected search, no external network or real model calls."""
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import httpx
from openai import OpenAI

from app.services import chat_service, organizer, web_search
from app.services.search_tool import SearchToolSession
from app.services.protocol_clients import ResponsesClient, AnthropicClient
from app.services.gemini_client import GeminiClient
from app.models.ai_requests import AskRequest
from tests.test_reading_protocols import responses_body, text_output
from tests.test_gemini_client import answer

SOURCE = {'source_type': 'web', 'source_id': 'web-test', 'url': 'https://docs.python.org/3/', 'title': 'Python', 'text': 'Public snippet'}


class AutomaticSearchTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        settings = patch.object(web_search, 'SETTINGS_PATH', Path(directory.name) / 'search.json')
        settings.start()
        self.addCleanup(settings.stop)
        web_search.save_settings(True, 'https://search.invalid', '')

    def client(self, protocol, stream=False, calls=True, read_page=False):
        self.wire = []
        def handle(request):
            data = json.loads(request.content)
            self.wire.append(data)
            first = calls and (len(self.wire) == 1 or (read_page and len(self.wire) == 2))
            name = "read_web_page" if read_page and len(self.wire) == 2 else "search_web"
            arguments = {"url": SOURCE["url"]} if name == "read_web_page" else {"query": "Python docs"}
            if protocol == 'openai-chat':
                message = {'role': 'assistant', 'content': '' if first else 'Answer'}
                if first:
                    message['tool_calls'] = [{'id': 'call_1', 'type': 'function', 'function': {'name': name, 'arguments': json.dumps(arguments)}}]
                if stream:
                    if first:
                        message['tool_calls'][0]['index'] = 0
                    events = [{'choices': [{'index': 0, 'delta': message, 'finish_reason': None}]},
                              {'choices': [{'index': 0, 'delta': {}, 'finish_reason': 'tool_calls' if first else 'stop'}]}]
                    return httpx.Response(200, headers={'content-type': 'text/event-stream'}, content=''.join('data: ' + json.dumps(e) + '\n\n' for e in events) + 'data: [DONE]\n\n')
                payload = {'id': 'chat', 'object': 'chat.completion', 'created': 0, 'model': 'synthetic', 'choices': [{'index': 0, 'message': message, 'finish_reason': 'tool_calls' if first else 'stop'}]}
            elif protocol == 'openai-responses':
                payload = responses_body([{'type': 'function_call', 'id': 'fc_1', 'call_id': 'call_1', 'name': name, 'arguments': json.dumps(arguments), 'status': 'completed'}] if first else text_output('Answer'))
            elif protocol == 'anthropic':
                payload = {'content': [{'type': 'tool_use', 'id': 'call_1', 'name': name, 'input': arguments}] if first else [{'type': 'text', 'text': 'Answer'}], 'usage': {'input_tokens': 5}, 'stop_reason': 'tool_use' if first else 'end_turn'}
            else:
                payload = answer([{'functionCall': {'name': name, 'args': arguments}, 'thoughtSignature': 'signed'}] if first else [{'text': 'Answer'}])
            return httpx.Response(200, json=payload)
        http = httpx.Client(transport=httpx.MockTransport(handle))
        if protocol in ('openai-chat', 'openai-responses'):
            client = OpenAI(api_key='model-synthetic', base_url='https://model.invalid/v1', max_retries=0, http_client=http)
            if protocol == 'openai-responses':
                client = ResponsesClient(client)
        elif protocol == 'anthropic':
            client = AnthropicClient('model-synthetic', 'https://model.invalid/v1', http_client=http)
        else:
            client = GeminiClient('model-synthetic', 'https://model.invalid/v1', http_client=http)
        self.addCleanup(client.close)
        return SimpleNamespace(client=client, model='synthetic')

    def reading(self, gpt, protocol='openai-chat', stream=False):
        request = AskRequest(task_id='one', question='Public question', provider_id='test', model_name='synthetic', context_mode='selection', protocol=protocol, web_search_mode='external')
        events = list(chat_service._chat_with_client(gpt, request, stream=stream))
        return events[-1]['result']

    def test_reading_real_tool_roundtrip_all_protocols_and_chat_stream(self):
        for protocol, stream in [('openai-chat', False), ('openai-chat', True), ('openai-responses', False), ('anthropic', False), ('gemini', False)]:
            with self.subTest(protocol=protocol, stream=stream):
                gpt = self.client(protocol, stream)
                with patch.object(web_search, 'search_web', return_value=[SOURCE]) as search:
                    result = self.reading(gpt, protocol, stream)
                search.assert_called_once_with('Python docs')
                self.assertTrue(result['context']['web_search_used'])
                self.assertIn(SOURCE, result['sources'])
                self.assertEqual(len(self.wire), 2)
                second = self.wire[1]
                if protocol == 'openai-chat':
                    self.assertEqual(second['messages'][-1]['role'], 'tool')
                    self.assertEqual(second['messages'][-1]['tool_call_id'], 'call_1')
                elif protocol == 'openai-responses':
                    self.assertEqual(second['input'][-1]['type'], 'function_call_output')
                elif protocol == 'anthropic':
                    self.assertEqual(second['messages'][-1]['content'][0]['type'], 'tool_result')
                else:
                    self.assertEqual(second['contents'][-1]['parts'][0]['functionResponse']['name'], 'search_web')
                    self.assertEqual(second['contents'][-2]['parts'][0]['thoughtSignature'], 'signed')
                self.assertIn('Public snippet', json.dumps(second))

    def test_plain_question_does_not_search_even_when_available(self):
        for stream in (False, True):
            gpt = self.client('openai-chat', stream, calls=False)
            with patch.object(web_search, 'search_web') as search:
                result = self.reading(gpt, stream=stream)
            search.assert_not_called()
            self.assertFalse(result['context']['web_search_used'])

    def test_unconfigured_external_does_not_block_plain_answer(self):
        web_search.save_selection(enabled=False)
        gpt = self.client('openai-chat', calls=False)
        result = self.reading(gpt)
        self.assertEqual(result['answer'], 'Answer')
        self.assertNotIn('search_web', [tool['function']['name'] for tool in self.wire[0]['tools']])

    def test_failed_search_returns_tool_error_and_no_success_evidence(self):
        gpt = self.client('openai-chat')
        with patch.object(web_search, 'search_web', side_effect=ValueError('没有搜索结果')) as search:
            result = self.reading(gpt)
        self.assertFalse(result['context']['web_search_used'])
        self.assertEqual(result['sources'], [])
        self.assertIn('error', json.loads(self.wire[1]['messages'][-1]['content']))
        search.assert_called_once()

    def test_session_cache_budget_privacy_disabled_and_cancel(self):
        client = SimpleNamespace(api_key='private-model-key')
        session = SearchToolSession(True, 'external', client)
        with patch.object(web_search, 'search_web', return_value=[SOURCE]) as search:
            self.assertIn('error', session.execute({'query': 'private-model-key'}))
            for query in ('first', 'first', 'second', 'third'):
                session.execute({'query': query})
            self.assertEqual(search.call_count, 2)
            self.assertIn('error', SearchToolSession(False, 'external', client).execute({'query': 'test'}))
            with self.assertRaisesRegex(ValueError, '取消'):
                SearchToolSession(True, 'external', client, {'cancelled': True}).execute({'query': 'test'})
            self.assertEqual(search.call_count, 2)

    def test_organizer_stream_tool_turn_collects_sources(self):
        gpt = self.client('openai-chat', stream=True)
        sources, context = [], {}
        with patch.object(organizer, 'get_client', return_value=gpt), patch.object(organizer, '_run_library_tool', return_value={'results': []}), patch.object(web_search, 'search_web', return_value=[SOURCE]) as search:
            result = organizer.answer('Question', 'test', 'synthetic', [], {}, {}, web_search_mode='external', sources_sink=sources, context_sink=context)
        self.assertEqual(result, 'Answer')
        search.assert_called_once_with('Python docs')
        self.assertIn(SOURCE, sources)
        self.assertTrue(context['web_search_used'])
        self.assertEqual(self.wire[1]['messages'][-1]['role'], 'tool')

    def test_cancellation_during_search_never_starts_next_model_request(self):
        for stream in (False, True):
            with self.subTest(stream=stream):
                gpt = self.client('openai-chat', stream=stream)
                cancellation = {'cancelled': False}
                def search(query):
                    cancellation['cancelled'] = True
                    return [SOURCE]
                request = AskRequest(task_id='one', question='Question', provider_id='test', model_name='synthetic', context_mode='selection', web_search_mode='external')
                with patch.object(web_search, 'search_web', side_effect=search):
                    with self.assertRaisesRegex(ValueError, '取消'):
                        list(chat_service._chat_with_client(gpt, request, stream=stream, cancellation=cancellation))
                self.assertEqual(len(self.wire), 1)
