"""Official DeepSeek hosted search routing and wire evidence, with no live calls."""
import copy
import json
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import httpx

from app.services import ai_client
from app.services.ai_runtime import complete, visible_answer
from app.services.model_capabilities import _probe
from app.services.protocol_clients import AnthropicClient


def native_blocks(*, function=False):
    blocks = [
        {'type': 'server_tool_use', 'id': 'srv-search', 'name': 'web_search',
         'input': {'query': 'Python official documentation'}},
        {'type': 'web_search_tool_result', 'tool_use_id': 'srv-search', 'content': [
            {'type': 'web_search_result', 'url': 'https://docs.python.org/3/',
             'title': 'Python documentation', 'encrypted_content': 'opaque-provider-artifact'},
            {'type': 'web_search_result', 'url': 'javascript:alert(1)', 'title': 'Invalid'}]},
        {'type': 'text', 'text': 'Python documentation', 'citations': [
            {'type': 'web_search_result_location', 'url': 'https://docs.python.org/3/',
             'title': 'Python documentation', 'cited_text': 'Official Python documentation'}]},
    ]
    if function:
        blocks.insert(0, {'type': 'thinking', 'thinking': 'opaque reasoning', 'signature': 'opaque-signature'})
        blocks.append({'type': 'tool_use', 'id': 'echo-call', 'name': 'echo', 'input': {'value': 'ok'}})
    return blocks


def message_response(blocks=None, *, stop='end_turn'):
    return {'id': 'msg-synthetic', 'type': 'message', 'role': 'assistant', 'model': 'deepseek-flash',
            'content': native_blocks() if blocks is None else blocks, 'stop_reason': stop,
            'usage': {'input_tokens': 40, 'cache_read_input_tokens': 8, 'output_tokens': 12,
                      'server_tool_use': {'web_search_requests': 1}}}


def stream_events():
    citation = native_blocks()[2]['citations'][0]
    return [
        {'type': 'message_start', 'message': {'usage': {'input_tokens': 40, 'cache_read_input_tokens': 8}}},
        {'type': 'content_block_start', 'index': 0, 'content_block': {
            'type': 'server_tool_use', 'id': 'srv-search', 'name': 'web_search', 'input': {}}},
        {'type': 'content_block_delta', 'index': 0, 'delta': {
            'type': 'input_json_delta', 'partial_json': '{"query":"Python official documentation"}'}},
        {'type': 'content_block_stop', 'index': 0},
        {'type': 'content_block_start', 'index': 1, 'content_block': native_blocks()[1]},
        {'type': 'content_block_stop', 'index': 1},
        {'type': 'content_block_start', 'index': 2, 'content_block': {'type': 'text', 'text': '', 'citations': []}},
        {'type': 'content_block_delta', 'index': 2, 'delta': {'type': 'text_delta', 'text': 'Python '}},
        {'type': 'content_block_delta', 'index': 2, 'delta': {'type': 'text_delta', 'text': 'documentation'}},
        {'type': 'content_block_delta', 'index': 2, 'delta': {'type': 'citations_delta', 'citation': citation}},
        {'type': 'content_block_stop', 'index': 2},
        {'type': 'message_delta', 'delta': {'stop_reason': 'end_turn'}, 'usage': {
            'output_tokens': 12, 'server_tool_use': {'web_search_requests': 1}}},
        {'type': 'message_stop'},
    ]


class TrackedBody(httpx.SyncByteStream):
    def __init__(self, events):
        self.events, self.closed = events, False

    def __iter__(self):
        for event in self.events:
            yield ('data: ' + json.dumps(event) + '\n\n').encode('utf-8')

    def close(self):
        self.closed = True


def collect(iterator):
    events = []
    while True:
        try:
            events.append(next(iterator))
        except StopIteration as done:
            return events, done.value


class OfficialDeepSeekSearchTests(unittest.TestCase):
    def setUp(self):
        self.provider = {'api_key': 'synthetic-deepseek-key', 'base_url': 'https://api.deepseek.com',
                         'enabled': True, 'type': 'openai', 'name': 'Official fixture'}
        factory_module = types.ModuleType('app.gpt.gpt_factory')
        factory_module.GPTFactory = self.factory = Mock()
        provider_module = types.ModuleType('app.services.provider')
        provider_module.ProviderService = self.providers = Mock()
        self.providers.get_provider_by_id.side_effect = lambda _: self.provider
        for context in [patch.dict('sys.modules', {'app.gpt.gpt_factory': factory_module,
                                                  'app.services.provider': provider_module}),
                        patch('app.services.proxy_config_manager.ProxyConfigManager')]:
            context.start()
            self.addCleanup(context.stop)
        from app.services.proxy_config_manager import ProxyConfigManager
        ProxyConfigManager.return_value.get_proxy_url.return_value = None

    def routed(self, handler, model='deepseek-flash', protocol='openai-chat'):
        transport = httpx.Client(transport=httpx.MockTransport(handler))
        self.addCleanup(transport.close)
        constructor = lambda key, base, **kwargs: AnthropicClient(key, base, http_client=transport)
        with patch('app.services.protocol_clients.AnthropicClient', side_effect=constructor):
            wrapper = ai_client.get_client('official-provider', model, protocol, native_search=True)
        self.addCleanup(ai_client.close_client, wrapper.client)
        return wrapper, transport

    def test_exact_official_hosts_models_and_protocols_route_without_changing_settings(self):
        for base in ('https://api.deepseek.com', 'https://api.deepseek.com/', 'https://api.deepseek.com/v1',
                     'https://api.deepseek.com/v1/', 'https://API.DEEPSEEK.COM:443/v1'):
            for model in ('deepseek-flash', 'deepseek-v4-pro'):
                for protocol in ('openai-chat', 'openai-responses'):
                    with self.subTest(base=base, model=model, protocol=protocol):
                        self.provider['base_url'] = base
                        before = copy.deepcopy(self.provider)
                        wrapper, transport = self.routed(lambda _: self.fail('routing must not send a request'), model, protocol)
                        self.assertEqual(wrapper.model, model)
                        self.assertIsInstance(wrapper.client, AnthropicClient)
                        self.assertEqual(wrapper.client.protocol, 'anthropic')
                        self.assertEqual(wrapper.client.url, 'https://api.deepseek.com/anthropic/v1/messages')
                        self.assertEqual(wrapper.client.bilinote_provider_id, 'official-provider')
                        self.assertEqual(self.provider, before)
                        ai_client.close_client(wrapper.client)
                        self.assertTrue(transport.is_closed)
        self.factory.from_config.assert_not_called()

    def test_relay_lookalikes_and_noncanonical_urls_never_receive_official_override(self):
        for base in ('http://api.deepseek.com', 'https://api.deepseek.com.evil.invalid/v1',
                     'https://relay.invalid/api.deepseek.com/v1', 'https://api.deepseek.com:8443/v1',
                     'https://user:pass@api.deepseek.com/v1', 'https://api.deepseek.com/v1?key=x',
                     'https://api.deepseek.com/v1#fragment', 'https://api.deepseek.com/anthropic',
                     'https://api.deepseek.com/v1/chat/completions', 'https://api.deepseek.com/v1/../',
                     'https://api.deepseek.com./v1', 'https://api.deepseek.com:bad/v1'):
            with self.subTest(base=base):
                self.provider['base_url'] = base
                self.factory.reset_mock()
                with patch('app.services.protocol_clients.AnthropicClient') as adapted:
                    try:
                        ai_client.get_client('official-provider', 'deepseek-flash', native_search=True)
                    except ValueError:
                        pass
                    else:
                        self.factory.from_config.assert_called_once()
                        self.assertEqual(self.factory.from_config.call_args.args[0].base_url, base)
                    adapted.assert_not_called()

    def test_other_models_and_disabled_native_keep_the_original_chat_path(self):
        for model, native in (('deepseek-chat', True), ('deepseek-reasoner', True), ('deepseek-flash-relay', True),
                              ('vendor/deepseek-flash', True), ('deepseek-flash', False)):
            with self.subTest(model=model, native=native):
                self.factory.reset_mock()
                with patch('app.services.protocol_clients.AnthropicClient') as adapted:
                    ai_client.get_client('official-provider', model, native_search=native)
                    adapted.assert_not_called()
                config = self.factory.from_config.call_args.args[0]
                self.assertEqual(config.model_name, model)
                self.assertEqual(config.base_url, self.provider['base_url'])

    def test_native_disabled_responses_keeps_the_existing_protocol(self):
        sdk = types.SimpleNamespace(api_key='synthetic', responses=types.SimpleNamespace(create=Mock()), close=Mock())
        builder = Mock()
        builder.return_value.with_options.return_value = sdk
        with patch('app.utils.openai_client.build_openai_client', builder), \
                patch('app.services.protocol_clients.AnthropicClient') as adapted:
            wrapper = ai_client.get_client('official-provider', 'deepseek-flash', 'openai-responses', native_search=False)
        self.assertEqual(wrapper.client.protocol, 'openai-responses')
        self.assertEqual(wrapper.client.bilinote_provider_id, 'official-provider')
        builder.assert_called_once_with('synthetic-deepseek-key', 'https://api.deepseek.com', timeout=120.0)
        builder.return_value.with_options.assert_called_once_with(max_retries=0)
        adapted.assert_not_called()
        ai_client.close_client(wrapper.client)
        sdk.close.assert_called_once()

    def test_provider_validation_still_precedes_routing(self):
        for provider, expected in ((None, '未找到'), ({**self.provider, 'enabled': False}, '已禁用'),
                                   ({**self.provider, 'api_key': ''}, 'API Key')):
            with self.subTest(expected=expected):
                self.provider = provider
                with patch('app.services.protocol_clients.AnthropicClient') as adapted, self.assertRaisesRegex(ValueError, expected):
                    ai_client.get_client('official-provider', 'deepseek-flash', native_search=True)
                adapted.assert_not_called()

    def test_nonstream_official_wire_has_real_search_evidence_and_safe_sources(self):
        captured = []
        def handler(request):
            captured.append((str(request.url), dict(request.headers), json.loads(request.content)))
            return httpx.Response(200, headers={'request-id': 'request-nonstream'}, json=message_response())
        wrapper, transport = self.routed(handler)
        response, context = complete(wrapper.client, wrapper.model, [{'role': 'user', 'content': 'Find official docs'}],
                                     web_search=True, reasoning_effort='none', max_output_tokens=8192)
        self.assertEqual(visible_answer(response), 'Python documentation')
        self.assertTrue(response.web_search_used)
        self.assertEqual([source['url'] for source in response.web_sources], ['https://docs.python.org/3/'])
        self.assertEqual(response.request_id, 'request-nonstream')
        self.assertEqual(context['input_tokens'], 48)
        self.assertFalse(context['estimated'])
        url, headers, body = captured[0]
        self.assertEqual(url, 'https://api.deepseek.com/anthropic/v1/messages')
        self.assertEqual(headers['x-api-key'], 'synthetic-deepseek-key')
        self.assertEqual(body['model'], 'deepseek-flash')
        self.assertEqual(body['max_tokens'], 8192)
        self.assertEqual(body['thinking'], {'type': 'disabled'})
        self.assertEqual(body['tools'], [{'type': 'web_search_20250305', 'name': 'web_search', 'max_uses': 1}])
        self.assertNotIn('web_search_options', body)
        self.assertEqual(len(captured), 1)
        ai_client.close_client(wrapper.client)
        self.assertTrue(transport.is_closed)

    def test_stream_extracts_server_search_json_citations_deltas_and_closes_response(self):
        captured, bodies = [], []
        def handler(request):
            captured.append(json.loads(request.content))
            stream = TrackedBody(stream_events())
            bodies.append(stream)
            return httpx.Response(200, headers={'content-type': 'text/event-stream', 'request-id': 'request-stream'}, stream=stream)
        wrapper, _ = self.routed(handler)
        events, (response, context) = collect(complete(wrapper.client, wrapper.model,
            [{'role': 'user', 'content': 'Search docs'}], web_search=True, reasoning_effort='none', stream=True, max_output_tokens=8192))
        self.assertIn({'type': 'status', 'phase': 'searching'}, events)
        self.assertEqual(''.join(e['text'] for e in events if e['type'] == 'delta'), 'Python documentation')
        self.assertTrue(response.web_search_used)
        self.assertEqual(visible_answer(response), 'Python documentation')
        self.assertEqual(len(response.web_sources), 1)
        self.assertEqual(response.choices[0].message.native[0]['input'], {'query': 'Python official documentation'})
        self.assertEqual(response.choices[0].message.native[2]['citations'][0]['url'], 'https://docs.python.org/3/')
        self.assertEqual(response.request_id, 'request-stream')
        self.assertEqual(context['input_tokens'], 48)
        self.assertEqual(response.raw_usage['server_tool_use'], {'web_search_requests': 1})
        self.assertTrue(captured[0]['stream'])
        self.assertTrue(bodies[0].closed)

    def test_native_probe_uses_8192_and_disables_thinking_instead_of_1024(self):
        captured = []
        def handler(request):
            captured.append(json.loads(request.content))
            return httpx.Response(200, headers={'content-type': 'text/event-stream'}, stream=TrackedBody(stream_events()))
        wrapper, _ = self.routed(handler)
        status, _, response = _probe(wrapper.client, wrapper.model, 'openai-chat', 'web_native')
        self.assertEqual(status, 'passed')
        self.assertEqual(response.probe_output_token_limit, 8192)
        self.assertEqual(captured[0]['max_tokens'], 8192)
        self.assertEqual(captured[0]['thinking'], {'type': 'disabled'})
        self.assertTrue(response.web_search_used)

    def test_probe_does_not_force_thinking_off_on_other_providers(self):
        captured = []
        def handler(request):
            captured.append(json.loads(request.content))
            return httpx.Response(200, headers={'content-type': 'text/event-stream'}, stream=TrackedBody(stream_events()))
        transport = httpx.Client(transport=httpx.MockTransport(handler))
        client = AnthropicClient('synthetic-only', 'https://relay.invalid/v1', http_client=transport)
        self.addCleanup(client.close)
        status, _, response = _probe(client, 'deepseek-flash', 'anthropic', 'web_native')
        self.assertEqual(status, 'passed')
        self.assertEqual(response.probe_output_token_limit, 8192)
        self.assertNotIn('thinking', captured[0])

    def test_official_thinking_mapping_is_used_by_stream_and_nonstream(self):
        for stream in (False, True):
            for effort, expected in (('auto', None), ('none', None), ('low', 'low'), ('medium', 'high'),
                                     ('high', 'high'), ('xhigh', 'high'), ('max', 'max')):
                with self.subTest(stream=stream, effort=effort):
                    captured = []
                    def handler(request):
                        captured.append(json.loads(request.content))
                        if stream:
                            return httpx.Response(200, headers={'content-type': 'text/event-stream'},
                                                  stream=TrackedBody(stream_events()))
                        return httpx.Response(200, json=message_response())
                    wrapper, _ = self.routed(handler)
                    value = complete(wrapper.client, wrapper.model, [{'role': 'user', 'content': 'Search'}],
                                     web_search=True, reasoning_effort=effort, stream=stream)
                    if stream:
                        collect(value)
                    if effort == 'auto':
                        self.assertNotIn('thinking', captured[0])
                    else:
                        self.assertEqual(captured[0]['thinking'], {'type': 'disabled' if effort == 'none' else 'enabled'})
                    if expected is not None:
                        self.assertEqual(captured[0]['output_config'], {'effort': expected})

    def test_reading_entrypoints_only_request_bridge_for_native_search(self):
        from app.services import chat_service, model_context
        with tempfile.TemporaryDirectory() as temporary, \
                patch.object(model_context, 'SETTINGS_PATH', Path(temporary) / 'context.json'):
            for stream in (False, True):
                for enabled, mode, expected in ((True, 'native', True), (True, 'external', False), (False, 'native', False)):
                    with self.subTest(stream=stream, enabled=enabled, mode=mode):
                        captured = []
                        def handler(request):
                            captured.append(json.loads(request.content))
                            if stream:
                                return httpx.Response(200, headers={'content-type': 'text/event-stream'},
                                                      stream=TrackedBody(stream_events()))
                            return httpx.Response(200, json=message_response())
                        wrapper, _ = self.routed(handler)
                        arguments = {'task_id': 'synthetic-note', 'question': 'Find official documentation', 'history': [],
                                     'provider_id': 'official-provider', 'model_name': 'deepseek-flash',
                                     'context_mode': 'selection', 'protocol': 'openai-chat',
                                     'web_search': enabled, 'web_search_mode': mode}
                        with patch.object(chat_service, 'get_client', return_value=wrapper) as get_client, \
                                patch('app.services.web_search.available', return_value=False):
                            if stream:
                                events = list(chat_service.chat_stream(**arguments))
                                result = events[-1]['result']
                            else:
                                result = chat_service.chat(**arguments)
                        get_client.assert_called_once_with('official-provider', 'deepseek-flash', protocol='openai-chat', native_search=expected)
                        self.assertEqual(result['answer'], 'Python documentation')
                        self.assertEqual(result['context']['protocol'], 'openai-chat')
                        self.assertEqual(result['context']['upstream_protocol'], 'anthropic')
                        self.assertEqual(captured[0]['model'], 'deepseek-flash')

    def test_organizer_only_requests_bridge_for_native_search(self):
        from app.services import model_context, organizer
        with tempfile.TemporaryDirectory() as temporary, \
                patch.object(model_context, 'SETTINGS_PATH', Path(temporary) / 'context.json'):
            for enabled, mode, expected in ((True, 'native', True), (True, 'external', False), (False, 'native', False)):
                with self.subTest(enabled=enabled, mode=mode):
                    captured = []
                    def handler(request):
                        captured.append(json.loads(request.content))
                        return httpx.Response(200, headers={'content-type': 'text/event-stream'}, stream=TrackedBody(stream_events()))
                    wrapper, _ = self.routed(handler)
                    context, sources = {}, []
                    with patch.object(organizer, 'get_client', return_value=wrapper) as get_client, \
                            patch.object(organizer, '_run_library_tool', return_value={'results': []}), \
                            patch('app.services.web_search.available', return_value=False):
                        answer = organizer.answer('Find official documentation', 'official-provider', 'deepseek-flash', [], {}, {},
                            protocol='openai-chat', web_search=enabled, web_search_mode=mode, context_sink=context, sources_sink=sources)
                    get_client.assert_called_once_with('official-provider', 'deepseek-flash', protocol='openai-chat', native_search=expected)
                    self.assertEqual(answer, 'Python documentation')
                    self.assertEqual(context['upstream_protocol'], 'anthropic')
                    self.assertEqual(len(captured), 1)

    def test_probe_job_persists_requested_identity_and_reports_actual_protocol(self):
        from app.services import model_capabilities as capabilities
        captured = []
        def handler(request):
            captured.append(json.loads(request.content))
            return httpx.Response(200, headers={'content-type': 'text/event-stream', 'request-id': 'probe-request'},
                                  stream=TrackedBody(stream_events()))
        wrapper, transport = self.routed(handler)
        with tempfile.TemporaryDirectory() as temporary, \
                patch.object(capabilities, 'STATE_PATH', Path(temporary) / 'capabilities.json'), \
                patch.object(capabilities, 'JOBS', {}), patch.object(capabilities, 'EXECUTOR', Mock()), \
                patch.object(ai_client, 'get_client', return_value=wrapper) as get_client:
            job = capabilities.start_test('official-provider', 'deepseek-flash', 'openai-chat', ['web_native'])
            capabilities._run(job['id'])
            completed = capabilities.get_job(job['id'])
            saved = capabilities.get_capabilities('official-provider', 'deepseek-flash', 'openai-chat')
            self.assertEqual(completed['outcome'], 'passed')
            self.assertEqual(completed['protocol'], 'openai-chat')
            self.assertEqual(saved['features']['web_native']['status'], 'passed')
            self.assertEqual(saved['features']['web_native']['upstream_protocol'], 'anthropic')
            self.assertEqual(saved['features']['web_native']['usage']['output_token_limit'], 8192)
            self.assertEqual(saved['features']['web_native']['request_id'], 'probe-request')
            self.assertEqual(capabilities.get_capabilities('official-provider', 'deepseek-flash', 'anthropic')['features'], {})
        get_client.assert_called_once_with('official-provider', 'deepseek-flash', protocol='openai-chat', native_search=True)
        self.assertEqual(len(captured), 1)
        self.assertTrue(transport.is_closed)

    def test_early_generator_close_releases_the_sse_response(self):
        bodies = []
        def handler(request):
            stream = TrackedBody(stream_events())
            bodies.append(stream)
            return httpx.Response(200, headers={'content-type': 'text/event-stream'}, stream=stream)
        wrapper, _ = self.routed(handler)
        state = {'cancelled': False}
        iterator = complete(wrapper.client, wrapper.model, [{'role': 'user', 'content': 'Search'}],
                            web_search=True, stream=True, cancellation=state)
        self.assertEqual(next(iterator), {'type': 'status', 'phase': 'searching'})
        self.assertIn('stream_close', state)
        iterator.close()
        self.assertTrue(bodies[0].closed)
        self.assertNotIn('stream_close', state)

    def test_no_search_evidence_is_inferred_from_text_or_unpaired_results(self):
        cases = [
            [{'type': 'text', 'text': 'I searched https://docs.python.org/3/'}],
            [{'type': 'text', 'text': 'Python documentation', 'citations': native_blocks()[2]['citations']}],
            [native_blocks()[1], {'type': 'text', 'text': 'Python documentation'}],
        ]
        for blocks in cases:
            with self.subTest(blocks=blocks):
                wrapper, _ = self.routed(lambda _: httpx.Response(200, json=message_response(blocks)))
                response, _ = complete(wrapper.client, wrapper.model, [{'role': 'user', 'content': 'Search'}], web_search=True)
                self.assertFalse(response.web_search_used)

    def test_native_blocks_and_opaque_artifacts_survive_followup_function_round(self):
        captured = []
        native = native_blocks(function=True)
        def handler(request):
            captured.append(json.loads(request.content))
            body = message_response(native, stop='tool_use') if len(captured) == 1 else message_response([
                {'type': 'text', 'text': 'Done'}])
            return httpx.Response(200, json=body)
        wrapper, _ = self.routed(handler)
        messages = [{'role': 'system', 'content': 'Read-only assistant'}, {'role': 'user', 'content': 'Search and echo'}]
        tools = [{'type': 'function', 'function': {'name': 'echo', 'parameters': {'type': 'object'}}}]
        first, _ = complete(wrapper.client, wrapper.model, messages, web_search=True, tools=tools)
        self.assertTrue(first.web_search_used)
        self.assertEqual(len(first.choices[0].message.tool_calls), 1)
        second, _ = complete(wrapper.client, wrapper.model, [*messages, first.choices[0].message,
            {'role': 'tool', 'tool_call_id': 'echo-call', 'content': '{"value":"ok"}'}], tools=tools)
        self.assertEqual(visible_answer(second), 'Done')
        self.assertEqual(captured[1]['messages'][1], {'role': 'assistant', 'content': native})
        self.assertEqual(captured[1]['messages'][2]['content'], [
            {'type': 'tool_result', 'tool_use_id': 'echo-call', 'content': '{"value":"ok"}'}])
        self.assertEqual(captured[1]['messages'][1]['content'][0]['signature'], 'opaque-signature')
        self.assertEqual(captured[1]['messages'][1]['content'][2]['content'][0]['encrypted_content'], 'opaque-provider-artifact')


if __name__ == '__main__':
    unittest.main()
