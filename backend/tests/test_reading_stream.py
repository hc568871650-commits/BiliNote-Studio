"""Synthetic wire streaming only: no provider database, server, or paid calls."""
import json
import asyncio
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import httpx
from openai import OpenAI
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.services.ai_runtime import complete, visible_answer
from app.utils.ai_errors import error_details
from app.services.protocol_clients import ResponsesClient, AnthropicClient
from app.services import chat_service
from app.routers import chat as router
from tests.test_reading_protocols import responses_body, text_output, TOOLS


def sse(events):
    return ''.join('data: ' + json.dumps(e, ensure_ascii=False) + '\n\n' for e in events).encode()


def drain(iterator):
    events = []
    while True:
        try:
            events.append(next(iterator))
        except StopIteration as end:
            return events, end.value


class ReadingStreamTest(unittest.TestCase):
    def sdk(self, events, *, responses=False):
        self.wire = []
        def handler(request):
            self.wire.append(json.loads(request.content))
            return httpx.Response(200, headers={'content-type': 'text/event-stream'}, content=sse(events))
        client = OpenAI(api_key='synthetic-secret', base_url='https://synthetic.invalid/v1', max_retries=0,
                        http_client=httpx.Client(transport=httpx.MockTransport(handler)))
        self.addCleanup(client.close)
        return ResponsesClient(client) if responses else client

    def test_chat_text_fragments_usage_and_tool_arguments(self):
        events = [
            {'choices': [{'index': 0, 'delta': {'content': '分', 'tool_calls': [
                {'index': 0, 'id': 'c1', 'function': {'name': 'get_note_content', 'arguments': '{'}}]}}]},
            {'choices': [{'index': 0, 'delta': {'content': '段', 'tool_calls': [
                {'index': 0, 'function': {'arguments': '}'}}]}, 'finish_reason': 'tool_calls'}]},
            {'choices': [], 'usage': {'prompt_tokens': 12, 'completion_tokens': 2, 'total_tokens': 14}}]
        client = self.sdk(events)
        stream = complete(client, 'synthetic', [{'role': 'user', 'content': '问题'}], tools=TOOLS, stream=True)
        first = next(stream)
        self.assertEqual(first, {'type': 'delta', 'text': '分'})
        rest, (response, usage) = drain(stream)
        self.assertEqual(rest[0]['text'], '段')
        self.assertEqual(response.choices[0].message.tool_calls[0].function.arguments, '{}')
        self.assertEqual(usage['input_tokens'], 12)
        self.assertTrue(self.wire[0]['stream'])
        self.assertEqual(len(self.wire), 1)

    def test_responses_stream_native_reasoning_and_completion(self):
        native = [{'type': 'reasoning', 'id': 'rs', 'summary': [], 'encrypted_content': 'cipher'}, *text_output('答案')]
        client = self.sdk([{'type': 'response.output_text.delta', 'delta': '答'},
                           {'type': 'response.output_text.delta', 'delta': '案'},
                           {'type': 'response.completed', 'response': responses_body(native)}], responses=True)
        events, (response, usage) = drain(complete(client, 'gpt-6-sol', [{'role': 'user', 'content': '问题'}],
                            stream=True, reasoning_effort='high', tools=TOOLS, final=True))
        self.assertEqual([e['text'] for e in events], ['答', '案'])
        self.assertEqual(visible_answer(response), '答案')
        self.assertEqual(response.choices[0].message.native, native)
        self.assertEqual(usage['input_tokens'], 456)
        self.assertEqual(self.wire[0]['reasoning'], {'effort': 'high'})
        self.assertEqual(self.wire[0]['tool_choice'], 'none')

    def test_anthropic_multiline_sse_text_usage_tool_native(self):
        events = [{'type': 'message_start', 'message': {'usage': {'input_tokens': 11, 'cache_read_input_tokens': 2}}},
            {'type': 'content_block_start', 'index': 0, 'content_block': {'type': 'text', 'text': ''}},
            {'type': 'content_block_delta', 'index': 0, 'delta': {'type': 'text_delta', 'text': '答案'}},
            {'type': 'content_block_start', 'index': 1, 'content_block': {'type': 'tool_use', 'id': 'c', 'name': 'get_note_content', 'input': {}}},
            {'type': 'content_block_delta', 'index': 1, 'delta': {'type': 'input_json_delta', 'partial_json': '{}'}},
            {'type': 'message_delta', 'delta': {'stop_reason': 'tool_use'}}, {'type': 'message_stop'}]
        wire = []
        def handler(request):
            wire.append(json.loads(request.content))
            return httpx.Response(200, headers={'content-type': 'text/event-stream'}, content=sse(events))
        client = AnthropicClient('synthetic-secret', 'https://synthetic.invalid',
                                 http_client=httpx.Client(transport=httpx.MockTransport(handler)))
        self.addCleanup(client.close)
        deltas, (response, usage) = drain(complete(client, 'claude-synthetic', [{'role': 'user', 'content': '问题'}], stream=True, tools=TOOLS))
        self.assertEqual(deltas[0]['text'], '答案')
        self.assertEqual(usage['input_tokens'], 13)
        self.assertEqual(response.choices[0].message.native[1]['input'], {})
        self.assertTrue(wire[0]['stream'])

    def test_premature_close_and_upstream_error_never_retry(self):
        for events in ([{'choices': [{'delta': {'content': 'partial'}}]}],
                       [{'error': {'message': 'synthetic-secret rejected', 'type': 'invalid_request_error'}}]):
            client = self.sdk(events)
            with self.assertRaises(Exception) as caught:
                drain(complete(client, 'synthetic', [{'role': 'user', 'content': '问题'}], stream=True))
            self.assertNotIn('synthetic-secret', str(caught.exception))
            self.assertEqual(len(self.wire), 1)

    def test_close_releases_upstream_without_second_request(self):
        client = self.sdk([{'choices': [{'delta': {'content': 'first'}}]},
                           {'choices': [{'delta': {'content': 'second'}, 'finish_reason': 'stop'}]}])
        stream = complete(client, 'synthetic', [{'role': 'user', 'content': 'q'}], stream=True)
        self.assertEqual(next(stream)['text'], 'first')
        stream.close()
        self.assertEqual(len(self.wire), 1)

    def test_route_service_tools_attachments_and_done_contract(self):
        wires = []
        def handler(request):
            wires.append(json.loads(request.content))
            events = ([{'choices': [{'delta': {'tool_calls': [{'index': 0, 'id': 'c',
                'function': {'name': 'get_note_content', 'arguments': '{}'}}]}, 'finish_reason': 'tool_calls'}]}]
                if len(wires) == 1 else [{'choices': [{'delta': {'content': '答'}}]},
                                       {'choices': [{'delta': {'content': '案'}, 'finish_reason': 'stop'}]}])
            return httpx.Response(200, headers={'content-type': 'text/event-stream'}, content=sse(events))
        client = OpenAI(api_key='synthetic-secret', base_url='https://synthetic.invalid/v1', max_retries=0,
                        http_client=httpx.Client(transport=httpx.MockTransport(handler)))
        app = FastAPI()
        app.include_router(router.router)
        with patch.object(chat_service, 'get_client', return_value=SimpleNamespace(model='synthetic', client=client)), \
             patch.object(chat_service, 'execute_tool', return_value='笔记原文') as tool:
            response = TestClient(app).post('/chat/ask/stream', json={'task_id': 'one', 'question': '问题',
                'provider_id': 'p', 'model_name': 'synthetic', 'context_mode': 'selection',
                'attachments': [{'type': 'quote', 'name': '引用', 'text': '引文'}]})
        events = [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith('data: ')]
        self.assertEqual(events[0]['type'], 'start')
        self.assertEqual([e['text'] for e in events if e['type'] == 'delta'], ['答', '案'])
        self.assertEqual(events[-1]['result']['answer'], '答案')
        self.assertEqual(events[-1]['result']['sources'], [])
        self.assertIn('context', events[-1]['result'])
        self.assertIn('引文', wires[0]['messages'][-1]['content'])
        self.assertEqual(wires[1]['messages'][-1]['content'], '笔记原文')
        tool.assert_called_once_with('one', 'get_note_content', {})
        self.assertTrue(client.is_closed())

    def test_route_error_contract(self):
        app = FastAPI()
        app.include_router(router.router)
        with patch.object(chat_service, 'get_client', side_effect=ValueError('供应商不可用')):
            response = TestClient(app).post('/chat/ask/stream', json={'task_id': 'one', 'question': '问题',
                'provider_id': 'p', 'model_name': 'synthetic', 'context_mode': 'selection'})
        event = json.loads(response.text.removeprefix('data: ').strip())
        self.assertEqual(event['type'], 'error')
        self.assertIn('error_details', event['data'])

    def test_route_cancel_before_model_call_closes_client(self):
        client = self.sdk([])
        from app.models.ai_requests import AskRequest
        request = AskRequest(task_id='one', question='问题', provider_id='p', model_name='synthetic', context_mode='selection')
        async def cancel():
            response = router.ask_question_stream(request)
            self.assertIn('"type": "start"', await anext(response.body_iterator))
            await response.body_iterator.aclose()
        with patch.object(chat_service, 'get_client', return_value=SimpleNamespace(model='synthetic', client=client)):
            asyncio.run(cancel())
        self.assertTrue(client.is_closed())
        self.assertEqual(self.wire, [])

    def test_unsupported_stream_sdk_is_explicit_and_does_not_fallback(self):
        calls = []
        def create(**kwargs):
            calls.append(kwargs)
            raise TypeError('stream unsupported')
        client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)), api_key='secret')
        with self.assertRaises(Exception) as caught:
            drain(complete(client, 'synthetic', [{'role': 'user', 'content': 'q'}], stream=True))
        self.assertIn('SDK', str(caught.exception))
        self.assertEqual(len(calls), 1)

    def test_route_cancel_mid_delta_closes_active_transport(self):
        closed, wires = [], []
        class Body(httpx.SyncByteStream):
            def __iter__(self):
                yield sse([{'choices': [{'delta': {'content': '部分'}}]}])
                raise AssertionError('Cancellation must not consume another upstream chunk')
            def close(self):
                closed.append(True)
        def handler(request):
            wires.append(request)
            return httpx.Response(200, headers={'content-type': 'text/event-stream'}, stream=Body())
        client = OpenAI(api_key='synthetic-secret', base_url='https://synthetic.invalid/v1', max_retries=0,
                        http_client=httpx.Client(transport=httpx.MockTransport(handler)))
        from app.models.ai_requests import AskRequest
        request = AskRequest(task_id='one', question='问题', provider_id='p', model_name='synthetic', context_mode='selection')
        async def cancel():
            response = router.ask_question_stream(request)
            for _ in range(4):
                event = json.loads((await anext(response.body_iterator)).removeprefix('data: ').strip())
            self.assertEqual(event, {'type': 'delta', 'text': '部分'})
            await response.body_iterator.aclose()
        with patch.object(chat_service, 'get_client', return_value=SimpleNamespace(model='synthetic', client=client)):
            asyncio.run(cancel())
        self.assertTrue(closed)
        self.assertEqual(len(wires), 1)
        self.assertTrue(client.is_closed())

    def test_stream_compaction_preserves_current_question_and_result(self):
        client = self.sdk([{'choices': [{'delta': {'content': '答案'}, 'finish_reason': 'stop'}]}])
        compaction = {'compacted': True, 'consumed_messages': 2, 'summary': '历史摘要'}
        with patch.object(chat_service, 'get_client', return_value=SimpleNamespace(model='synthetic', client=client)), \
             patch.object(chat_service, 'estimate_context', return_value=280000), \
             patch.object(chat_service, 'compact_history', return_value=compaction):
            events = list(chat_service.chat_stream(task_id='one', question='当前问题', provider_id='p', model_name='synthetic',
                context_mode='selection', history=[{'role': 'user' if i % 2 == 0 else 'assistant', 'content': str(i)} for i in range(6)]))
        self.assertIn({'type': 'status', 'phase': 'compacting'}, events)
        self.assertEqual(self.wire[0]['messages'][-1]['content'], '当前问题')
        self.assertIn('历史摘要', str(self.wire[0]['messages']))
        self.assertEqual(events[-1]['result']['compaction'], compaction)
        self.assertTrue(events[-1]['result']['context']['compacted'])

    def test_anthropic_stream_http_error_retains_safe_details_no_retry(self):
        requests = []
        def handler(request):
            requests.append(request)
            return httpx.Response(429, headers={'request-id': 'r-stream'}, json={
                'error': {'type': 'rate_limit_error', 'message': 'synthetic-secret rate limited'}})
        client = AnthropicClient('synthetic-secret', 'https://synthetic.invalid',
                                 http_client=httpx.Client(transport=httpx.MockTransport(handler)))
        self.addCleanup(client.close)
        with self.assertRaises(Exception) as caught:
            drain(complete(client, 'claude-synthetic', [{'role': 'user', 'content': 'q'}], stream=True))
        detail = error_details(caught.exception)
        self.assertEqual(detail['http_status'], 429)
        self.assertEqual(detail['request_id'], 'r-stream')
        self.assertEqual(detail['upstream_code'], 'rate_limit_error')
        self.assertNotIn('synthetic-secret', detail['detail'])
        self.assertEqual(len(requests), 1)


if __name__ == '__main__':
    unittest.main()
