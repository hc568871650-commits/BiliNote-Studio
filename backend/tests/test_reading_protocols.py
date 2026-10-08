"""Wire-level synthetic transports; no API, provider DB, or server bootstrap."""
import json
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import httpx
from openai import OpenAI
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.models.ai_requests import AskRequest, CompactRequest
from app.services.protocol_clients import ResponsesClient, AnthropicClient, anthropic_messages_url
from app.services.ai_runtime import complete, visible_answer, estimate_context
from app.utils.ai_errors import SafeAIError, error_details
from app.routers import chat as chat_router
from app.services import chat_service, ai_client
from app.services.context_compaction import compact_history

TOOLS = [{'type': 'function', 'function': {'name': 'get_note_content', 'description': 'Read note',
                                        'parameters': {'type': 'object', 'properties': {}, 'additionalProperties': False}}}]


def responses_body(output, count=456, **extra):
    return {'id': 'resp_synthetic', 'object': 'response', 'created_at': 1, 'status': 'completed',
            'model': 'gpt-6-sol', 'output': output, 'parallel_tool_calls': True, 'tool_choice': 'auto',
            'tools': [], 'usage': {'input_tokens': count, 'output_tokens': 10, 'total_tokens': count + 10}, **extra}


def text_output(text):
    return [{'type': 'message', 'id': 'msg_synthetic', 'role': 'assistant', 'status': 'completed',
             'content': [{'type': 'output_text', 'text': text, 'annotations': []}]}]


class ReadingProtocolsTest(unittest.TestCase):
    def responses_client(self, handler):
        http = httpx.Client(transport=httpx.MockTransport(handler))
        sdk = OpenAI(api_key='arbitrary-secret-key', base_url='https://synthetic.invalid/v1', http_client=http,
                     max_retries=0, timeout=120)
        client = ResponsesClient(sdk)
        self.addCleanup(client.close)
        return client

    def anthropic_client(self, handler, base='https://synthetic.invalid/v1'):
        http = httpx.Client(transport=httpx.MockTransport(handler))
        client = AnthropicClient('arbitrary-secret-key', base, http_client=http)
        self.addCleanup(client.close)
        return client

    def test_contract_default_and_invalid_protocol(self):
        args = dict(task_id='one', provider_id='p', model_name='m')
        self.assertEqual(AskRequest(**args, question='x').protocol, 'openai-chat')
        for protocol in ('openai-chat', 'openai-responses', 'anthropic'):
            self.assertEqual(CompactRequest(**args, protocol=protocol).protocol, protocol)
        with self.assertRaises(ValueError):
            AskRequest(**args, question='x', protocol='invented')

    def test_responses_sdk170_text_image_reasoning_tool_round_trip(self):
        wire = []
        first_output = [{'type': 'reasoning', 'id': 'rs_synthetic', 'summary': [], 'encrypted_content': 'encrypted'},
                        {'type': 'function_call', 'id': 'fc_synthetic', 'call_id': 'call_synthetic',
                         'name': 'get_note_content', 'arguments': '{}', 'status': 'completed'}]
        def handler(request):
            self.assertEqual(request.url.path, '/v1/responses')
            wire.append(json.loads(request.content))
            return httpx.Response(200, json=responses_body(first_output if len(wire) == 1 else text_output('答案')))
        client = self.responses_client(handler)
        messages = [{'role': 'system', 'content': '规则'}, {'role': 'assistant', 'content': '历史回答'},
                    {'role': 'user', 'content': [{'type': 'text', 'text': '问题'},
                       {'type': 'image_url', 'image_url': {'url': 'data:image/png;base64,cGlj'}}]}]
        response, usage = complete(client, 'gpt-6-sol', messages, tools=TOOLS, reasoning_effort='high')
        self.assertEqual(usage['input_tokens'], 456)
        messages.extend([response.choices[0].message, {'role': 'tool', 'tool_call_id': 'call_synthetic', 'content': '原文'}])
        response, _ = complete(client, 'gpt-6-sol', messages, tools=TOOLS, final=True, reasoning_effort='high')
        self.assertEqual(visible_answer(response), '答案')
        self.assertEqual(wire[0]['reasoning'], {'effort': 'high'})
        self.assertFalse(wire[0]['store'])
        self.assertEqual(wire[0]['input'][-1]['content'][1]['type'], 'input_image')
        self.assertIn(first_output[0], wire[1]['input'])
        self.assertEqual(wire[1]['input'][-1], {'type': 'function_call_output', 'call_id': 'call_synthetic', 'output': '原文'})
        self.assertEqual(wire[1]['tool_choice'], 'none')

    def test_anthropic_headers_image_tools_history_and_final_none(self):
        wire = []
        def handler(request):
            self.assertEqual(request.url.path, '/v1/messages')
            self.assertEqual(request.headers['x-api-key'], 'arbitrary-secret-key')
            self.assertEqual(request.headers['anthropic-version'], '2023-06-01')
            self.assertNotIn('authorization', request.headers)
            wire.append(json.loads(request.content))
            blocks = [{'type': 'tool_use', 'id': 'call_1', 'name': 'get_note_content', 'input': {}}] if len(wire) == 1 else [{'type': 'text', 'text': '答案'}]
            return httpx.Response(200, json={'content': blocks, 'usage': {'input_tokens': 789}, 'stop_reason': 'end_turn'})
        client = self.anthropic_client(handler)
        messages = [{'role': 'system', 'content': '规则'}, {'role': 'user', 'content': [
            {'type': 'text', 'text': '历史问题'}, {'type': 'image_url', 'image_url': {'url': 'data:image/png;base64,cGlj'}}]},
                    {'role': 'assistant', 'content': '历史回答'}, {'role': 'user', 'content': '新问题'}]
        response, usage = complete(client, 'claude-synthetic', messages, tools=TOOLS)
        messages.extend([response.choices[0].message, {'role': 'tool', 'tool_call_id': 'call_1', 'content': '原文'}])
        response, _ = complete(client, 'claude-synthetic', messages, tools=TOOLS, final=True)
        self.assertEqual(usage['input_tokens'], 789)
        self.assertEqual(visible_answer(response), '答案')
        self.assertEqual(wire[0]['system'], '规则')
        self.assertEqual(wire[0]['messages'][0]['content'][1]['source']['media_type'], 'image/png')
        self.assertEqual(wire[1]['messages'][-1]['content'][0]['tool_use_id'], 'call_1')
        self.assertEqual(wire[1]['tool_choice'], {'type': 'none'})
        self.assertNotIn('temperature', wire[0])
        self.assertNotIn('thinking', wire[0])

    def test_url_join_has_one_v1_and_rejects_credentials(self):
        for base in ('https://host', 'https://host/', 'https://host/v1', 'https://host/v1/', 'https://host/v1/messages'):
            self.assertEqual(anthropic_messages_url(base), 'https://host/v1/messages')
        self.assertEqual(anthropic_messages_url('https://host/proxy/v1'), 'https://host/proxy/v1/messages')
        with self.assertRaises(ValueError):
            anthropic_messages_url('https://user:secret@host/v1')

    def test_anthropic_unsupported_effort_rejected_without_request(self):
        calls = []
        client = self.anthropic_client(lambda request: calls.append(request))
        with self.assertRaisesRegex(ValueError, '思考档位'):
            complete(client, 'gpt-6-sol', [{'role': 'user', 'content': 'x'}], reasoning_effort='high')
        self.assertFalse(calls)
        history = [{'role': 'user' if i % 2 == 0 else 'assistant', 'content': 'x' * 30000} for i in range(8)]
        with patch.object(chat_service, 'get_client', return_value=SimpleNamespace(model='gpt-6-sol', client=client)):
            with self.assertRaisesRegex(ValueError, '思考档位'):
                chat_service.chat('one', 'x', history, 'p', 'gpt-6-sol', context_mode='selection',
                                  protocol='anthropic', reasoning_effort='high')
        self.assertFalse(calls)

    def test_compaction_anthropic_does_not_send_implicit_low(self):
        wire = []
        def handler(request):
            wire.append(json.loads(request.content))
            return httpx.Response(200, json={'content': [{'type': 'text', 'text': '连续性摘要：保留用户目标和限制。'}]})
        client = self.anthropic_client(handler)
        history = [{'role': 'user' if i % 2 == 0 else 'assistant', 'content': '重要资料' * 400} for i in range(8)]
        result = compact_history(client, 'gpt-6-sol', history)
        self.assertTrue(result['compacted'])
        self.assertNotIn('reasoning_effort', wire[0])
        self.assertEqual(wire[0]['max_tokens'], 2048)

    def test_responses_empty_and_incomplete_fail_visible_or_compaction(self):
        client = self.responses_client(lambda request: httpx.Response(200, json=responses_body([])))
        response, _ = complete(client, 'gpt-6-sol', [{'role': 'user', 'content': 'x'}])
        with self.assertRaisesRegex(ValueError, '有效回答'):
            visible_answer(response)
        client = self.responses_client(lambda request: httpx.Response(200, json=responses_body(text_output('未完成'), status='incomplete', incomplete_details={'reason': 'max_output_tokens'})))
        response, _ = complete(client, 'gpt-6-sol', [{'role': 'user', 'content': 'x'}])
        self.assertEqual(response.choices[0].finish_reason, 'length')

    def test_real_status_request_id_error_code_redaction_and_no_retries(self):
        for protocol in ('openai-responses', 'anthropic'):
            calls = []
            def handler(request):
                calls.append(request)
                return httpx.Response(429, headers={'x-request-id': 'req_123', 'request-id': 'req_123'},
                    json={'error': {'code': 'quota_limit', 'message': '额度不足 arbitrary-secret-key Bearer TOKEN api_key=SECRET https://private/endpoint request body: PRIVATE_PAYLOAD'}})
            client = self.responses_client(handler) if protocol == 'openai-responses' else self.anthropic_client(handler)
            with self.assertRaises(SafeAIError) as caught:
                complete(client, 'synthetic-model', [{'role': 'user', 'content': 'PAYLOAD_TEXT'}])
            details = error_details(caught.exception)
            self.assertEqual(details['http_status'], 429)
            self.assertEqual(details['request_id'], 'req_123')
            self.assertEqual(details['upstream_code'], 'quota_limit')
            self.assertEqual(details['protocol'], protocol)
            self.assertEqual(len(calls), 1)
            for secret in ('arbitrary-secret-key', 'TOKEN', 'SECRET', 'PRIVATE_PAYLOAD', 'PAYLOAD_TEXT', 'private/endpoint'):
                self.assertNotIn(secret, json.dumps(details))

    def test_timeout_has_no_http_status_and_untrusted_internal_detail_hidden(self):
        def handler(request):
            raise httpx.ReadTimeout('SECRET_BODY', request=request)
        client = self.anthropic_client(handler)
        with self.assertRaises(SafeAIError) as caught:
            complete(client, 'synthetic-model', [{'role': 'user', 'content': 'x'}])
        details = caught.exception.details
        self.assertIsNone(details['http_status'])
        self.assertEqual(details['kind'], 'timeout')
        self.assertNotIn('SECRET_BODY', details['detail'])
        self.assertNotIn('PRIVATE', error_details(RuntimeError('PRIVATE'))['detail'])

    def test_native_reasoning_counts_in_budget_and_anthropic_cached_input_usage(self):
        from app.services.protocol_clients import Message
        native = [{'type': 'reasoning', 'encrypted_content': 'x' * 4000}]
        self.assertGreater(estimate_context([Message('', [], native=native)]), 5000)
        client = self.anthropic_client(lambda request: httpx.Response(200, json={
            'content': [{'type': 'text', 'text': '答案'}],
            'usage': {'input_tokens': 10, 'cache_creation_input_tokens': 20, 'cache_read_input_tokens': 30}}))
        _, usage = complete(client, 'synthetic', [{'role': 'user', 'content': 'x'}])
        self.assertEqual(usage['input_tokens'], 60)

    def test_failed_json_response_has_actual_http_status_and_missing_sdk_is_clear(self):
        client = self.anthropic_client(lambda request: httpx.Response(200, headers={'request-id': 'req_error'},
            json={'type': 'error', 'error': {'type': 'synthetic_error', 'message': '上游错误'}}))
        with self.assertRaises(SafeAIError) as caught:
            complete(client, 'synthetic', [{'role': 'user', 'content': 'x'}])
        self.assertEqual(caught.exception.details['http_status'], 200)
        self.assertEqual(caught.exception.details['upstream_code'], 'synthetic_error')
        from unittest.mock import Mock
        sdk = SimpleNamespace(api_key='test-key', close=Mock())
        with self.assertRaisesRegex(ValueError, 'SDK 不支持 Responses'):
            ResponsesClient(sdk)
        sdk.close.assert_called_once()

    def test_routes_pass_protocol_and_return_same_safe_details_in_log(self):
        app = FastAPI()
        app.include_router(chat_router.router)
        http = TestClient(app)
        payload = dict(task_id='one', provider_id='p', model_name='m', protocol='anthropic')
        with patch.object(chat_router, 'chat_service', return_value={'answer': 'x'}) as service:
            self.assertEqual(http.post('/chat/ask', json={**payload, 'question': 'x'}).json()['code'], 0)
            self.assertEqual(service.call_args.kwargs['protocol'], 'anthropic')
        with patch.object(ai_client, 'get_client', side_effect=httpx.ReadTimeout('SECRET')), patch.object(chat_router.logger, 'warning') as log:
            body = http.post('/chat/compact', json=payload).json()
            details = body['data']['error_details']
            self.assertEqual(log.call_args.args[1], details)
            self.assertIsNone(details['http_status'])
            self.assertNotIn('SECRET', json.dumps(body))
        with patch.object(chat_router, 'chat_service', side_effect=ValueError('unsupported protocol')), patch.object(chat_router.logger, 'warning') as log:
            body = http.post('/chat/ask', json={**payload, 'question': 'x'}).json()
            self.assertEqual(log.call_args.args[1], body['data']['error_details'])

    def test_chat_and_compact_close_clients_on_success_and_failure(self):
        from unittest.mock import Mock
        for failure in (False, True):
            client = self.anthropic_client(lambda request: httpx.Response(200,
                json={'content': [] if failure else [{'type': 'text', 'text': '答案'}]}))
            original_close = client.close
            client.close = Mock(wraps=original_close)
            gpt = SimpleNamespace(model='claude-synthetic', client=client)
            with patch.object(chat_service, 'get_client', return_value=gpt):
                if failure:
                    with self.assertRaises(ValueError):
                        chat_service.chat('one', 'x', [], 'p', 'claude-synthetic', context_mode='selection', protocol='anthropic')
                else:
                    chat_service.chat('one', 'x', [], 'p', 'claude-synthetic', context_mode='selection', protocol='anthropic')
            client.close.assert_called_once()
            client.close.reset_mock()
            with patch.object(ai_client, 'get_client', return_value=gpt), patch('app.services.context_compaction.compact_history',
                    side_effect=ValueError('synthetic') if failure else None, return_value={'summary': ''}):
                chat_router.compact_question_history(CompactRequest(task_id='one', provider_id='p', model_name='m', protocol='anthropic'))
            client.close.assert_called_once()


if __name__ == '__main__':
    unittest.main()
