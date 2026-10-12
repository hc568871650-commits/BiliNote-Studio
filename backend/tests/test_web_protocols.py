import json
import unittest
from unittest.mock import Mock, patch
from types import SimpleNamespace
import httpx
from openai import OpenAI
from app.services.ai_runtime import complete, visible_answer
from app.services.protocol_clients import ResponsesClient, responses_options, anthropic_options, _web_sources


def result():
    return {'id': 'resp_test', 'object': 'response', 'created_at': 1, 'status': 'completed', 'model': 'gpt-6.1-sol',
            'output': [{'type': 'web_search_call', 'id': 'web_test', 'status': 'completed', 'action': {'type': 'search', 'sources': [
                {'url': 'https://docs.python.org/3/', 'title': 'Python'}, {'url': 'javascript:alert(1)', 'title': 'invalid'}]}},
                {'type': 'message', 'id': 'msg_test', 'status': 'completed', 'role': 'assistant', 'content': [
                    {'type': 'output_text', 'text': 'Python documentation', 'annotations': [{'type': 'url_citation', 'url': 'https://docs.python.org/3/', 'title': 'Python', 'start_index': 0, 'end_index': 6}]}]}],
            'parallel_tool_calls': False, 'tool_choice': 'auto', 'tools': [], 'usage': {'input_tokens': 10, 'output_tokens': 20, 'total_tokens': 30}}


class WebProtocolTest(unittest.TestCase):
    def client(self, handler):
        client = ResponsesClient(OpenAI(api_key='synthetic-only', base_url='https://fixture.invalid/v1', max_retries=0,
                                 http_client=httpx.Client(transport=httpx.MockTransport(handler))))
        self.addCleanup(client.close)
        return client

    def test_mixed_function_and_hosted_tools(self):
        tools = [{'type': 'function', 'function': {'name': 'read', 'parameters': {'type': 'object', 'properties': {}}}}, {'type': 'web_search'}]
        data = responses_options('model', [], {'tools': tools, 'reasoning_effort': 'max'})
        self.assertEqual(data['tools'][0]['name'], 'read')
        self.assertEqual(data['tools'][1], {'type': 'web_search'})
        self.assertIn('web_search_call.action.sources', data['include'])
        self.assertEqual(data['reasoning'], {'effort': 'max'})

    def test_source_ids_stay_unique_across_search_rounds(self):
        def sources(url):
            return _web_sources([{'type': 'web_search_call', 'action': {'sources': [{'url': url}]}}])
        first = sources('https://example.org/one')[0]['source_id']
        self.assertNotEqual(first, sources('https://example.org/two')[0]['source_id'])
        self.assertEqual(first, sources('https://example.org/one')[0]['source_id'])

    def test_nonstream_tool_evidence_and_safe_sources(self):
        seen = []
        def handler(request):
            seen.append(json.loads(request.content))
            return httpx.Response(200, json=result())
        response, _ = complete(self.client(handler), 'gpt-6.1-sol', [{'role': 'user', 'content': 'Find Python docs'}], web_search=True, require_web=True)
        self.assertEqual(visible_answer(response), 'Python documentation')
        self.assertTrue(response.web_search_used)
        self.assertEqual(len(response.web_sources), 1)
        self.assertEqual(response.web_sources[0]['url'], 'https://docs.python.org/3/')
        self.assertEqual(seen[0]['tool_choice'], {'type': 'web_search'})

    def test_stream_search_status_and_sources_match_nonstream(self):
        wire = []
        def handler(request):
            wire.append(json.loads(request.content))
            events = [{'type': 'response.web_search_call.searching'}, {'type': 'response.output_text.delta', 'delta': 'Python documentation'}, {'type': 'response.completed', 'response': result()}]
            return httpx.Response(200, headers={'content-type': 'text/event-stream'}, content=''.join('data: '+json.dumps(e)+'\n\n' for e in events))
        stream = complete(self.client(handler), 'gpt-6.1-sol', [{'role': 'user', 'content': 'Find docs'}], stream=True, web_search=True)
        events = []
        while True:
            try:
                events.append(next(stream))
            except StopIteration as done:
                response, usage = done.value
                break
        self.assertIn({'type': 'status', 'phase': 'searching'}, events)
        self.assertTrue(response.web_search_used)
        self.assertEqual(len(response.web_sources), 1)
        self.assertEqual(usage['input_tokens'], 10)
        self.assertEqual(wire[0]['tools'], [{'type': 'web_search'}])

    def test_stream_failure_preserves_request_id(self):
        def handler(request):
            event = {'type': 'response.failed', 'response': {'error': {'code': 'service_unavailable', 'message': 'Service temporarily unavailable'}}}
            return httpx.Response(200, headers={'content-type': 'text/event-stream', 'x-request-id': 'synthetic-request-id'}, content='data: '+json.dumps(event)+'\n\n')
        from app.utils.ai_errors import SafeAIError
        stream = complete(self.client(handler), 'gpt-6.1-sol', [], stream=True)
        with self.assertRaises(SafeAIError) as raised:
            list(stream)
        self.assertEqual(raised.exception.details['request_id'], 'synthetic-request-id')
        self.assertEqual(raised.exception.details['upstream_code'], 'service_unavailable')

    def test_off_does_not_add_search_tool_and_chat_cannot_fake_native(self):
        self.assertNotIn('tools', responses_options('model', [], {}))
        class ChatClient:
            protocol = 'openai-chat'
        with self.assertRaisesRegex(ValueError, '未接入原生联网'):
            complete(ChatClient(), 'model', [], web_search=True)

    def test_anthropic_legacy_and_adaptive_have_distinct_wire_parameters(self):
        legacy = anthropic_options('claude-sonnet-4-5', [], {'reasoning_effort': 'high', 'max_tokens': 6000})
        self.assertEqual(legacy['thinking'], {'type': 'enabled', 'budget_tokens': 4096})
        self.assertEqual(legacy['max_tokens'], 6000)
        modern = anthropic_options('claude-opus-5-5', [], {'reasoning_effort': 'max', 'max_tokens': 2048})
        self.assertEqual(modern['thinking'], {'type': 'adaptive'})
        self.assertEqual(modern['output_config'], {'effort': 'max'})
        self.assertNotIn('reasoning_effort', modern)
        self.assertEqual(modern['max_tokens'], 2048)

    def test_cancel_during_external_search_does_not_start_model(self):
        for callback in (False, True):
            state = {'cancelled': False}
            client = SimpleNamespace(protocol='openai-chat', api_key='test-secret', chat=SimpleNamespace(completions=SimpleNamespace(create=Mock())))
            def search(query):
                state['cancelled'] = True
                return [{'source_type': 'web', 'url': 'https://example.org', 'text': 'synthetic'}]
            with patch('app.services.web_search.search_web', side_effect=search):
                with self.assertRaisesRegex(ValueError, '已取消'):
                    complete(client, 'model', [], web_search=True, web_search_mode='external', search_query='public question',
                             cancellation=(lambda: state['cancelled']) if callback else state)
            client.chat.completions.create.assert_not_called()
