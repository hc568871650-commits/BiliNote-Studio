"""Capability service regressions with isolated storage and zero provider calls."""
import tempfile
import base64
import hashlib
import io
import json
import httpx
from openai import OpenAI
import types
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from app.services import ai_client, ai_runtime, model_capabilities as capabilities, web_search
from app.utils.ai_errors import ProtocolResponseError


def response(text='OK', calls=None):
    return types.SimpleNamespace(choices=[types.SimpleNamespace(message=types.SimpleNamespace(
        content=text, tool_calls=calls), finish_reason='stop')],
        usage=types.SimpleNamespace(prompt_tokens=12), raw_usage={'input_tokens': 12, 'output_tokens': 2})


class ModelCapabilityTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='model-capability-test-')
        self.addCleanup(temporary.cleanup)
        self.path = Path(temporary.name) / 'capabilities.json'
        self.provider = {'api_key': 'synthetic-model-secret', 'base_url': 'https://unit.invalid/v1', 'enabled': True}
        self.executor = Mock()
        self.client = types.SimpleNamespace(protocol='openai-chat', api_key=self.provider['api_key'], close=Mock(),
            chat=types.SimpleNamespace(completions=types.SimpleNamespace(create=Mock(return_value=response()))))
        patches = [patch.object(capabilities, 'STATE_PATH', self.path), patch.object(capabilities, 'JOBS', {}),
                   patch.object(capabilities, 'EXECUTOR', self.executor),
                   patch.object(capabilities, '_provider', side_effect=lambda _: self.provider),
                   patch.object(ai_client, 'get_client', return_value=types.SimpleNamespace(client=self.client)),
                   patch.object(web_search, 'available', return_value=False)]
        for context in patches:
            context.start()
            self.addCleanup(context.stop)

    def job(self, checks=('basic',), model='unit-model', protocol='openai-chat', run=True):
        job = capabilities.start_test('unit-provider', model, protocol, list(checks))
        if run:
            capabilities._run(job['id'])
        return capabilities.get_job(job['id'])

    def test_read_only_get_never_schedules_inference_or_writes(self):
        for _ in range(3):
            info = capabilities.get_capabilities('unit-provider', 'unit-model')
            self.assertEqual(info['features'], {})
            self.assertEqual(info['available_efforts'], ['auto', *capabilities.EFFORTS])
        self.client.chat.completions.create.assert_not_called()
        self.executor.submit.assert_not_called()
        self.assertFalse(self.path.exists())

    def test_fingerprint_changes_invalidate_without_exposing_keys(self):
        self.job(('reasoning:low',))
        original = self.provider.copy()
        self.assertIn('low', capabilities.available_efforts('unit-provider', 'unit-model', 'openai-chat'))
        for field, value in (('api_key', 'replacement-secret'), ('base_url', 'https://changed.invalid/v1')):
            self.provider.clear()
            self.provider.update(original)
            self.provider[field] = value
            info = capabilities.get_capabilities('unit-provider', 'unit-model')
            self.assertTrue(info['stale'])
            self.assertEqual(info['features'], {})
            self.assertEqual(info['available_efforts'], ['auto', *capabilities.EFFORTS])
        self.assertNotIn(original['api_key'], self.path.read_text(encoding='utf-8'))
        self.assertNotIn('replacement-secret', repr(info))

    def test_failed_inconclusive_and_stale_evidence_do_not_gate_explicit_requests(self):
        tools = [{'type': 'function', 'function': {'name': 'capability_echo', 'parameters': {'type': 'object'}}}]
        self.client.bilinote_provider_id = 'unit-provider'
        for protocol in ('openai-chat', 'openai-responses', 'anthropic'):
            self.client.protocol = protocol
            key, fingerprint = capabilities._identity('unit-provider', 'unit-model', protocol)
            for status in (None, 'failed', 'inconclusive', 'stale'):
                with self.subTest(protocol=protocol, status=status):
                    saved = {} if status is None else {key: {
                        'fingerprint': 'old-fingerprint' if status == 'stale' else fingerprint,
                        'features': {'reasoning:max': {'status': 'passed' if status == 'stale' else status}},
                        'history': [{'id': 'old-job', 'fingerprint': fingerprint, 'status': 'completed'}]}}
                    capabilities._write(saved)
                    before = self.path.read_bytes()
                    info = capabilities.get_capabilities('unit-provider', 'unit-model', protocol)
                    self.assertEqual(info['available_efforts'], ['auto', *capabilities.EFFORTS])
                    self.assertEqual(info['candidates'], list(capabilities.EFFORTS))
                    self.assertEqual(info['stale'], status == 'stale')
                    if status in ('failed', 'inconclusive'):
                        self.assertEqual(info['features']['reasoning:max']['status'], status)
                    self.client.chat.completions.create.reset_mock()
                    ai_runtime.complete(self.client, 'unit-model', [{'role': 'user', 'content': 'x'}],
                                        reasoning_effort='max', tools=tools)
                    kwargs = self.client.chat.completions.create.call_args.kwargs
                    self.assertEqual(kwargs['reasoning_effort'], 'max')
                    self.assertEqual(kwargs['tools'], tools)
                    self.assertTrue(ai_runtime.allows_chat_tools('gpt-6-sol', 'max', protocol))
                    self.assertEqual(self.path.read_bytes(), before)
        self.executor.submit.assert_not_called()

    def test_requests_never_read_capability_storage_and_reject_invalid_efforts(self):
        with patch.object(capabilities, '_read', side_effect=AssertionError('request read capability records')):
            for protocol in ('openai-chat', 'openai-responses', 'anthropic'):
                for effort in capabilities.EFFORTS:
                    self.assertEqual(ai_runtime.request_options('unknown-model', effort, protocol=protocol,
                                                               provider_id='unit-provider'), {'reasoning_effort': effort})
            for protocol in ('openai-chat', 'openai-responses', 'anthropic', 'gemini'):
                for probe in (False, True):
                    with self.assertRaisesRegex(ValueError, '思考档位'):
                        ai_runtime.request_options('unknown-model', 'invented', protocol=protocol, probe=probe)

    def test_gemini_choices_respect_adapter_boundaries_without_probe_unlock(self):
        for model, expected in (('gemini-3.8-flash', ['auto', 'low', 'medium', 'high']),
                                ('gemini-3-pro', ['auto', 'low', 'high']),
                                ('gemini-3-pro-image', ['auto', 'high']),
                                ('gemini-2.5-flash', ['auto'])):
            with self.subTest(model=model):
                info = capabilities.get_capabilities('unit-provider', model, 'gemini')
                self.assertEqual(info['available_efforts'], expected)
                self.assertEqual(info['candidates'], expected[1:])
                self.assertTrue(ai_runtime.allows_chat_tools(model, 'auto', 'gemini'))
                for effort in expected:
                    ai_runtime.request_options(model, effort, protocol='gemini')
                with self.assertRaisesRegex(ValueError, '思考档位'):
                    ai_runtime.request_options(model, 'max', protocol='gemini')
        self.client.chat.completions.create.assert_not_called()

    def test_protocol_and_model_records_do_not_grant_other_identities(self):
        self.job(('reasoning:low',))
        for model, protocol in (('other-model', 'openai-chat'), ('unit-model', 'openai-responses'), ('unit-model', 'anthropic')):
            self.assertEqual(capabilities.get_capabilities('unit-provider', model, protocol)['features'], {})
        self.job(('basic',), model='other-model', protocol='openai-responses')
        self.assertIn('basic', capabilities.get_capabilities('unit-provider', 'other-model', 'openai-responses')['features'])
        self.assertNotIn('basic', capabilities.get_capabilities('unit-provider', 'unit-model')['features'])

    def test_global_auth_failure_stops_subsequent_paid_probes(self):
        self.client.chat.completions.create.side_effect = ProtocolResponseError(
            {'code': 'unauthorized', 'message': 'unauthorized'}, status_code=401, request_id='synthetic-request')
        job = self.job(('basic', 'tools', 'reasoning:low'))
        self.assertEqual(job['status'], 'failed')
        self.assertEqual(job['completed'], 1)
        self.assertEqual(job['skipped'], ['tools', 'reasoning:low'])
        self.assertEqual(job['outcome'], 'failed')
        self.assertEqual(self.client.chat.completions.create.call_count, 1)
        details = job['results']['basic']['error_details']
        self.assertEqual(details['http_status'], 401)
        self.assertEqual(details['request_id'], 'synthetic-request')
        self.client.close.assert_called()

    def test_unsupported_http_failure_and_empty_reply_are_distinct(self):
        scenarios = [
            (ProtocolResponseError({'code': 'unsupported_parameter', 'message': 'unknown parameter reasoning_effort'}, status_code=400), None, 'unsupported'),
            (ProtocolResponseError({'code': 'temporary_failure', 'message': 'unsupported temporarily'}, status_code=503), None, 'failed'),
            (None, response(''), 'inconclusive')]
        for index, (failure, reply, status) in enumerate(scenarios):
            with self.subTest(status=status):
                self.client.chat.completions.create.side_effect = failure
                self.client.chat.completions.create.return_value = reply
                job = self.job(('reasoning:low',), model=f'model-{index}')
                self.assertEqual(job['results']['reasoning:low']['status'], status)
                if reply is not None:
                    self.assertIn('没有正文', job['results']['reasoning:low']['evidence'])

    def test_duplicate_pending_jobs_are_one_queue_submission(self):
        first = self.job(('basic',), run=False)
        second = self.job(('basic', 'tools'), run=False)
        third = self.job(('basic',), run=False)
        self.assertNotEqual(first['id'], second['id'])
        self.assertEqual(first['id'], third['id'])
        self.assertEqual(self.executor.submit.call_count, 2)
        self.client.chat.completions.create.assert_not_called()
        self.assertNotIn('fingerprint', first)
        self.assertNotIn('key', first)

    def test_cancel_during_response_discards_result_and_preserves_prior_evidence(self):
        self.job(('basic',))
        before = self.path.read_bytes()
        job = self.job(('reasoning:low', 'tools'), run=False)
        def cancelled_response(**kwargs):
            capabilities.cancel_job(job['id'])
            return response()
        self.client.chat.completions.create.side_effect = cancelled_response
        capabilities._run(job['id'])
        final = capabilities.get_job(job['id'])
        self.assertEqual(final['status'], 'cancelled')
        self.assertEqual(final['skipped'], ['reasoning:low', 'tools'])
        self.assertEqual(final['completed'], 0)
        self.assertEqual(json.loads(self.path.read_bytes()).values().__iter__().__next__()['features'],
                         json.loads(before).values().__iter__().__next__()['features'])
        self.assertNotIn('client', final)

    def test_queued_cancel_never_creates_transport_and_records_cancel_history(self):
        job = self.job(run=False)
        capabilities.cancel_job(job['id'])
        capabilities._run(job['id'])
        self.client.chat.completions.create.assert_not_called()
        self.assertEqual(capabilities.get_capabilities('unit-provider', 'unit-model')['history'][0]['outcome'], 'cancelled')

    def test_configuration_change_during_response_cannot_save_old_evidence(self):
        job = self.job(('basic', 'tools'), run=False)
        def stale_response(**kwargs):
            self.provider['api_key'] = 'rotated-secret'
            return response()
        self.client.chat.completions.create.side_effect = stale_response
        capabilities._run(job['id'])
        final = capabilities.get_job(job['id'])
        self.assertEqual(final['status'], 'failed')
        self.assertIn('配置已改变', final['error'])
        self.assertEqual(final['skipped'], ['basic', 'tools'])
        self.assertEqual(final['outcome'], 'invalidated')
        self.assertTrue(capabilities.get_capabilities('unit-provider', 'unit-model')['history'][0]['stale'])
        self.assertEqual(self.client.chat.completions.create.call_count, 1)

    def test_stream_and_tools_require_actual_events_not_plain_text_claims(self):
        def stream(events):
            yield from events
            return response(), {}
        with patch.object(ai_runtime, 'complete', return_value=stream([])):
            self.assertEqual(capabilities._probe(self.client, 'unit-model', 'openai-chat', 'stream')[0], 'inconclusive')
        with patch.object(ai_runtime, 'complete', return_value=stream([{'type': 'delta', 'text': 'OK'}])):
            self.assertEqual(capabilities._probe(self.client, 'unit-model', 'openai-chat', 'stream')[0], 'passed')
        with patch.object(ai_runtime, 'complete', return_value=(response('I called capability_echo'), {})):
            self.assertEqual(capabilities._probe(self.client, 'unit-model', 'openai-chat', 'tools')[0], 'inconclusive')
        call = types.SimpleNamespace(function=types.SimpleNamespace(name='capability_echo', arguments='{"value":"ok"}'))
        with patch.object(ai_runtime, 'complete', return_value=(response('', [call]), {})):
            self.assertEqual(capabilities._probe(self.client, 'unit-model', 'openai-chat', 'tools')[0], 'passed')

    def test_non_global_failure_continues_selected_stream_with_partial_outcome(self):
        def probe(client, model, protocol, check, stream=False):
            if check == 'basic':
                raise ProtocolResponseError({'message': 'bad response format'}, status_code=500)
            return 'passed', 'visible streamed body', response()
        with patch.object(capabilities, '_probe', side_effect=probe) as mocked:
            job = self.job(('basic', 'stream'))
        self.assertEqual(mocked.call_count, 2)
        self.assertEqual(job['completed'], 2)
        self.assertEqual(job['status'], 'completed')
        self.assertEqual(job['outcome'], 'partial')
        self.assertEqual(job['counts']['failed'], 1)

    def test_history_is_bounded_safe_and_usage_keeps_nested_numbers(self):
        reply = response('Do not persist this synthetic body')
        reply.raw_usage.update(prompt_tokens_details={'cached_tokens': 8, 'secret': 'do-not-store'},
                               completion_tokens_details={'reasoning_tokens': 1}, arbitrary_number=45)
        reply._request_id = 'request-42'
        self.client.chat.completions.create.return_value = reply
        for _ in range(7):
            job = self.job()
        history = capabilities.get_capabilities('unit-provider', 'unit-model')['history']
        self.assertEqual(len(history), 5)
        feature = job['results']['basic']
        self.assertEqual(feature['request_id'], 'request-42')
        self.assertEqual(feature['job_id'], job['id'])
        self.assertEqual(feature['usage']['prompt_tokens_details'], {'cached_tokens': 8})
        persisted = self.path.read_text(encoding='utf-8')
        for forbidden in (self.provider['api_key'], self.provider['base_url'], 'Do not persist', 'do-not-store', 'arbitrary_number', 'Reply with'):
            self.assertNotIn(forbidden, persisted)
        self.assertNotIn('fingerprint', repr(history))

    def test_pending_dedup_respects_stream_and_configuration_and_active_is_safe(self):
        first = capabilities.start_test('unit-provider', 'unit-model', 'openai-chat', ['tools'])
        other = capabilities.start_test('unit-provider', 'unit-model', 'openai-chat', ['tools'], probe_stream=True)
        self.provider['api_key'] = 'new-key'
        rotated = capabilities.start_test('unit-provider', 'unit-model', 'openai-chat', ['tools'])
        self.assertEqual(len({first['id'], other['id'], rotated['id']}), 3)
        self.assertEqual(len(capabilities.active_jobs()), 3)
        self.assertNotIn('fingerprint', repr(capabilities.active_jobs()))
        self.assertNotIn('new-key', repr(capabilities.active_jobs()))

    def test_wire_sse_instead_of_json_does_not_skip_explicit_stream(self):
        requests = []
        def handler(request):
            requests.append(json.loads(request.content))
            chunks = [{'choices': [{'index': 0, 'delta': {'content': 'OK'}}]},
                      {'choices': [{'index': 0, 'delta': {}, 'finish_reason': 'stop'}]},
                      {'choices': [], 'usage': {'prompt_tokens': 17, 'completion_tokens': 1,
                                              'prompt_tokens_details': {'cached_tokens': 4}}}]
            body = ''.join('data: ' + json.dumps(c) + '\n\n' for c in chunks) + 'data: [DONE]\n\n'
            return httpx.Response(200, headers={'content-type': 'text/event-stream', 'x-request-id': 'wire-request'}, text=body)
        def factory(*args, **kwargs):
            client = OpenAI(api_key=self.provider['api_key'], base_url=self.provider['base_url'], max_retries=0,
                            http_client=httpx.Client(transport=httpx.MockTransport(handler)))
            return types.SimpleNamespace(client=client)
        with patch.object(ai_client, 'get_client', side_effect=factory):
            job = self.job(('basic', 'stream'))
        self.assertEqual(len(requests), 2)
        self.assertFalse(requests[0].get('stream', False))
        self.assertTrue(requests[1]['stream'])
        self.assertEqual(job['results']['stream']['status'], 'passed')
        self.assertEqual(job['outcome'], 'partial')
        self.assertEqual(job['completed'], 2)
        self.assertEqual(job['results']['stream']['usage']['prompt_tokens'], 17)
        self.assertEqual(job['results']['stream']['request_id'], 'wire-request')
        self.assertEqual(job['results']['basic']['error_details']['kind'], 'protocol_response')

    def test_tools_and_reasoning_honor_explicit_probe_stream(self):
        def streamed():
            yield {'type': 'delta', 'text': '703'}
            return response('703'), {}
        with patch.object(ai_runtime, 'complete', side_effect=lambda *args, **kwargs: streamed()) as complete:
            job = capabilities.start_test('unit-provider', 'unit-model', 'openai-chat', ['reasoning:low'], probe_stream=True)
            capabilities._run(job['id'])
        self.assertTrue(complete.call_args.kwargs['stream'])
        self.assertTrue(capabilities.get_job(job['id'])['results']['reasoning:low']['stream'])

    def test_wire_auth_rate_limit_and_connection_stop_without_retry(self):
        for index, code in enumerate((401, 403, 429, None)):
            calls = []
            def handler(request):
                calls.append(request)
                if code is None:
                    raise httpx.ConnectError('unreachable', request=request)
                return httpx.Response(code, headers={'x-request-id': 'blocked-request'},
                                      json={'error': {'message': 'blocked'}})
            def factory(*args, **kwargs):
                return types.SimpleNamespace(client=OpenAI(api_key=self.provider['api_key'], base_url=self.provider['base_url'],
                    max_retries=0, http_client=httpx.Client(transport=httpx.MockTransport(handler))))
            with self.subTest(code=code), patch.object(ai_client, 'get_client', side_effect=factory):
                job = self.job(('basic', 'stream', 'tools'), model='blocked-' + str(index))
            self.assertEqual(len(calls), 1)
            self.assertEqual(job['skipped'], ['stream', 'tools'])
            self.assertEqual(job['outcome'], 'failed')
            if code is not None:
                self.assertEqual(job['results']['basic']['request_id'], 'blocked-request')

    def test_usage_only_and_malformed_tool_results_keep_metadata_without_passing(self):
        empty = response('')
        empty._request_id = 'usage-only-request'
        empty.raw_usage = {'prompt_tokens': 17, 'completion_tokens': 0}
        malformed = response('', [types.SimpleNamespace(function=types.SimpleNamespace(
            name='capability_echo', arguments='invalid-json'))])
        malformed._request_id = 'malformed-tool-request'
        self.client.chat.completions.create.side_effect = [empty, malformed]
        job = self.job(('basic', 'tools'))
        self.assertEqual(job['outcome'], 'inconclusive')
        self.assertEqual(job['results']['basic']['status'], 'inconclusive')
        self.assertEqual(job['results']['basic']['usage']['completion_tokens'], 0)
        self.assertEqual(job['results']['basic']['request_id'], 'usage-only-request')
        self.assertEqual(job['results']['tools']['status'], 'inconclusive')
        self.assertEqual(job['results']['tools']['request_id'], 'malformed-tool-request')

    def test_usage_whitelist_preserves_gemini_and_bounds_depth_and_numbers(self):
        data = {'promptTokenCount': 12, 'candidatesTokenCount': 2, 'totalTokenCount': 14,
                'thoughtsTokenCount': 1, 'cachedContentTokenCount': 4,
                'prompt_tokens': -1, 'output_tokens': float('inf'), 'total_tokens': float('nan'),
                'audio_tokens': True, 'arbitrary_number': 3,
                'input_tokens_details': {'cached_tokens': 3, 'output_tokens_details': {
                    'reasoning_tokens': 1, 'input_tokens_details': {'cached_tokens': 9}}}}
        kept = capabilities._usage(data)
        for field in ('promptTokenCount', 'candidatesTokenCount', 'totalTokenCount',
                      'thoughtsTokenCount', 'cachedContentTokenCount'):
            self.assertEqual(kept[field], data[field])
        for field in ('prompt_tokens', 'output_tokens', 'total_tokens', 'audio_tokens', 'arbitrary_number'):
            self.assertNotIn(field, kept)
        nested = kept['input_tokens_details']['output_tokens_details']
        self.assertEqual(nested['reasoning_tokens'], 1)
        self.assertEqual(nested['input_tokens_details'], {})

    def test_pruning_keeps_cancelled_job_with_owned_transport_visible(self):
        running = capabilities.start_test('unit-provider', 'closing-model', 'openai-chat', ['basic'])
        retained = capabilities.JOBS[running['id']]
        retained.update(status='cancelled', client=self.client)
        for index in range(85):
            completed = capabilities.start_test('unit-provider', 'finished-' + str(index), 'openai-chat', ['basic'])
            capabilities.JOBS[completed['id']]['status'] = 'completed'
        self.assertIn(running['id'], capabilities.JOBS)
        active = capabilities.active_jobs()
        self.assertEqual([j['id'] for j in active], [running['id']])
        self.assertNotIn('client', active[0])
        self.assertNotIn('fingerprint', active[0])

    def test_native_search_probe_requires_completed_tool_and_actual_source(self):
        for used, sources, status in ((False, [], 'inconclusive'), (True, [], 'inconclusive'),
                                     (False, [{'url': 'https://docs.python.org/3/'}], 'inconclusive'),
                                     (True, [{'url': 'https://docs.python.org/3/'}], 'passed')):
            reply = response('Python documentation is available at https://docs.python.org/3/')
            reply.web_search_used, reply.web_sources = used, sources
            def streamed_reply():
                yield {'type': 'delta', 'text': 'Python'}
                return reply, {}
            with patch.object(ai_runtime, 'complete', return_value=streamed_reply()) as complete:
                self.assertEqual(capabilities._probe(self.client, 'unit-model', 'openai-responses', 'web_native')[0], status)
            self.assertTrue(complete.call_args.kwargs['require_web'])
            self.assertTrue(complete.call_args.kwargs['web_search'])

    def test_vision_sample_is_small_random_pixels_without_answer_metadata(self):
        from PIL import Image
        with patch.object(capabilities.secrets, 'randbelow', side_effect=[0, 7, 2, 9, 4, 1]):
            sample = capabilities._vision_sample()
        self.assertEqual(sample['expected'], '072941')
        raw = base64.b64decode(sample['data_url'].split(',', 1)[1])
        self.assertLess(len(raw), 16000)
        self.assertEqual(hashlib.sha256(raw).hexdigest(), sample['image_sha256'])
        image = Image.open(io.BytesIO(raw))
        self.assertEqual(image.size, (320, 96))
        self.assertEqual(image.info, {})
        self.assertGreater(len(image.getcolors()), 1)
        self.assertNotIn(sample['expected'].encode(), raw)
        with patch.object(capabilities.secrets, 'randbelow', side_effect=[1, 7, 2, 9, 4, 1]):
            self.assertNotEqual(capabilities._vision_sample()['image_sha256'], sample['image_sha256'])

    def test_vision_wire_single_stream_request_and_validation_metadata(self):
        sample = capabilities._vision_sample()
        wire = []
        def handler(request):
            payload = json.loads(request.content)
            wire.append(payload)
            content = payload['messages'][0]['content']
            self.assertEqual([part['type'] for part in content], ['text', 'image_url'])
            self.assertNotIn(sample['expected'], content[0]['text'])
            self.assertEqual(content[1]['image_url']['url'], sample['data_url'])
            chunks = [{'choices': [{'index': 0, 'delta': {'content': sample['expected']}}]},
                      {'choices': [{'index': 0, 'delta': {}, 'finish_reason': 'stop'}]},
                      {'choices': [], 'usage': {'prompt_tokens': 211, 'completion_tokens': 3}}]
            body = ''.join('data: ' + json.dumps(c) + '\n\n' for c in chunks) + 'data: [DONE]\n\n'
            return httpx.Response(200, headers={'content-type': 'text/event-stream', 'x-request-id': 'vision-wire'}, text=body)
        def factory(*args, **kwargs):
            return types.SimpleNamespace(client=OpenAI(api_key=self.provider['api_key'], base_url=self.provider['base_url'],
                max_retries=0, http_client=httpx.Client(transport=httpx.MockTransport(handler))))
        with patch.object(capabilities, '_vision_sample', return_value=sample), patch.object(ai_client, 'get_client', side_effect=factory):
            job = self.job(('vision',), model='gpt-6.1-sol')
        feature = job['results']['vision']
        self.assertEqual(len(wire), 1)
        self.assertTrue(wire[0]['stream'])
        self.assertEqual(wire[0]['max_completion_tokens'], 1024)
        self.assertNotIn('tools', wire[0])
        self.assertNotIn('web_search_options', wire[0])
        self.assertEqual(feature['status'], 'passed')
        self.assertEqual(feature['validation'], {'expected': sample['expected'], 'observed': sample['expected'], 'matched': True})
        self.assertEqual(feature['image_sha256'], sample['image_sha256'])
        self.assertEqual(feature['upstream_protocol'], 'openai-chat')
        self.assertEqual(feature['request_id'], 'vision-wire')
        self.assertEqual(feature['request_attempts'], 1)
        self.assertEqual(feature['usage'], {'prompt_tokens': 211, 'completion_tokens': 3, 'output_token_limit': 1024})
        self.assertNotIn('data:image', self.path.read_text(encoding='utf-8'))
        self.assertEqual(capabilities.get_capabilities('unit-provider', 'gpt-6.1-sol')['features']['vision'], feature)

    def test_vision_sample_works_without_system_fonts_or_freetype(self):
        from PIL import Image, ImageFont
        with patch.object(ImageFont, 'truetype', side_effect=ImportError('FreeType not bundled')):
            sample = capabilities._vision_sample()
        raw = base64.b64decode(sample['data_url'].split(',', 1)[1])
        image = Image.open(io.BytesIO(raw))
        self.assertEqual(image.size, (320, 96))
        self.assertGreater(len(image.getcolors()), 1)
        self.assertEqual(image.info, {})

    def test_vision_wrong_or_ambiguous_answers_are_inconclusive_not_unsupported(self):
        sample = capabilities._vision_sample()
        for text, expected in ((sample['expected'], 'passed'), ('The digits are ' + sample['expected'], 'passed'),
                               ('OK', 'inconclusive'), ('', 'inconclusive'),
                               (sample['expected'] + ' or 23', 'inconclusive')):
            with self.subTest(text=text):
                def stream():
                    yield {'type': 'delta', 'text': text}
                    return response(text), {}
                with patch.object(ai_runtime, 'complete', return_value=stream()):
                    status, _, reply = capabilities._probe(self.client, 'unknown-unit-model', 'openai-chat', 'vision', vision_sample=sample)
                self.assertEqual(status, expected)
                self.assertEqual(reply.probe_vision_validation['matched'], expected == 'passed')

    def test_vision_unsupported_requires_specific_model_image_rejection(self):
        scenarios = [
            (400, 'This model does not support image inputs.', 'unsupported'),
            (422, 'Image input is not supported by this model.', 'unsupported'),
            (400, 'Image inputs are not supported.', 'unsupported'),
            (400, 'invalid_request_error: This model does not support images.', 'unsupported'),
            (400, 'This endpoint only supports text.', 'unsupported'),
            (400, '当前模型不支持图片输入', 'unsupported'),
            (400, 'Unknown parameter image_url', 'failed'),
            (400, 'This model does not support image/jpeg format', 'failed'),
            (400, 'Invalid image, unsupported format', 'failed'),
            (400, 'Unknown parameter reasoning_effort', 'failed'),
            (404, 'This model does not support image inputs.', 'failed'),
            (500, 'This model does not support image inputs.', 'failed'),
            (529, 'Overloaded: image inputs not supported temporarily', 'failed'),
            (400, 'This model does not support images temporarily', 'failed'),
            (200, 'overloaded_error: upstream overloaded', 'failed'),
        ]
        for index, (code, message, status) in enumerate(scenarios):
            with self.subTest(code=code, message=message), patch.object(ai_runtime, 'complete', side_effect=ProtocolResponseError(
                    {'message': message}, status_code=code, request_id='failure-id')):
                job = self.job(('vision',), model='vision-failure-' + str(index))
            feature = job['results']['vision']
            self.assertEqual(feature['status'], status)
            self.assertEqual(feature['upstream_protocol'], 'openai-chat')
            self.assertEqual(feature['request_id'], 'failure-id')
            self.assertEqual(len(feature['image_sha256']), 64)

    def test_vision_http200_sse_overload_never_grants_or_denies_support(self):
        wire = []
        def handler(request):
            wire.append(request)
            body = 'data: ' + json.dumps({'error': {'message': 'upstream overloaded', 'type': 'overloaded_error'}}) + '\n\n'
            return httpx.Response(200, headers={'content-type': 'text/event-stream'}, text=body)
        def factory(*args, **kwargs):
            return types.SimpleNamespace(client=OpenAI(api_key=self.provider['api_key'], base_url=self.provider['base_url'],
                max_retries=0, http_client=httpx.Client(transport=httpx.MockTransport(handler))))
        with patch.object(ai_client, 'get_client', side_effect=factory):
            feature = self.job(('vision',))['results']['vision']
        self.assertEqual(len(wire), 1)
        self.assertEqual(feature['status'], 'failed')
        self.assertEqual(feature['error_details']['upstream_code'], 'overloaded_error')
        self.assertNotIn('usage', feature)

    def test_vision_invalid_request_type_keeps_explicit_image_rejection(self):
        with patch.object(ai_runtime, 'complete', side_effect=ProtocolResponseError(
                {'type': 'invalid_request_error', 'message': 'This model does not support images.'}, status_code=400)):
            feature = self.job(('vision',))['results']['vision']
        self.assertEqual(feature['error_details']['upstream_code'], 'invalid_request_error')
        self.assertEqual(feature['error_details']['detail'], 'This model does not support images.')
        self.assertEqual(feature['status'], 'unsupported')

    def test_vision_delta_without_sse_completion_is_never_passed(self):
        sample = capabilities._vision_sample()
        wire = []
        def handler(request):
            wire.append(request)
            body = 'data: ' + json.dumps({'choices': [{'index': 0, 'delta': {'content': sample['expected']}}]}) + '\n\n'
            return httpx.Response(200, headers={'content-type': 'text/event-stream'}, text=body)
        def factory(*args, **kwargs):
            return types.SimpleNamespace(client=OpenAI(api_key=self.provider['api_key'], base_url=self.provider['base_url'],
                max_retries=0, http_client=httpx.Client(transport=httpx.MockTransport(handler))))
        with patch.object(capabilities, '_vision_sample', return_value=sample), patch.object(ai_client, 'get_client', side_effect=factory):
            feature = self.job(('vision',))['results']['vision']
        self.assertEqual(len(wire), 1)
        self.assertEqual(feature['status'], 'inconclusive')
        self.assertIn('未收到完成标记', feature['evidence'])
        self.assertNotIn('validation', feature)

    def test_vision_identity_invalidates_on_provider_configuration_and_detector(self):
        sample = capabilities._vision_sample()
        def stream(*args, **kwargs):
            yield {'type': 'delta', 'text': sample['expected']}
            return response(sample['expected']), {}
        with patch.object(capabilities, '_vision_sample', return_value=sample), patch.object(ai_runtime, 'complete', side_effect=stream):
            self.job(('vision',))
        for field, changed in (('base_url', 'https://other.invalid/v1'), ('api_key', 'new-secret'), ('type', 'new-type')):
            original = self.provider.copy()
            self.provider[field] = changed
            info = capabilities.get_capabilities('unit-provider', 'unit-model')
            self.assertTrue(info['stale'])
            self.assertEqual(info['features'], {})
            self.provider.clear()
            self.provider.update(original)
        with patch.object(capabilities, 'DETECTOR_VERSION', 999):
            self.assertEqual(capabilities.get_capabilities('unit-provider', 'unit-model')['features'], {})
        for provider, model, protocol in (('other-provider', 'unit-model', 'openai-chat'),
                                          ('unit-provider', 'other-model', 'openai-chat'),
                                          ('unit-provider', 'unit-model', 'anthropic')):
            self.assertEqual(capabilities.get_capabilities(provider, model, protocol)['features'], {})

    def test_vision_changed_config_during_stream_preserves_no_outdated_result(self):
        sample = capabilities._vision_sample()
        def stream(*args, **kwargs):
            self.provider['base_url'] = 'https://rotated.invalid'
            yield {'type': 'delta', 'text': sample['expected']}
            return response(sample['expected']), {}
        with patch.object(capabilities, '_vision_sample', return_value=sample), patch.object(ai_runtime, 'complete', side_effect=stream):
            job = self.job(('vision',))
        self.assertEqual(job['outcome'], 'invalidated')
        self.assertEqual(job['completed'], 0)
        self.assertEqual(capabilities.get_capabilities('unit-provider', 'unit-model')['features'], {})


if __name__ == '__main__':
    unittest.main()
