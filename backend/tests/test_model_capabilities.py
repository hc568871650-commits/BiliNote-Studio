"""Capability service regressions with isolated storage and zero provider calls."""
import tempfile
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
            self.assertEqual(info['available_efforts'], ['auto'])
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
            self.assertEqual(info['available_efforts'], ['auto'])
        self.assertNotIn(original['api_key'], self.path.read_text(encoding='utf-8'))
        self.assertNotIn('replacement-secret', repr(info))

    def test_protocol_and_model_records_do_not_grant_other_identities(self):
        self.job(('reasoning:low',))
        for model, protocol in (('other-model', 'openai-chat'), ('unit-model', 'openai-responses'), ('unit-model', 'anthropic')):
            self.assertEqual(capabilities.get_capabilities('unit-provider', model, protocol)['features'], {})
        self.job(('basic',), model='other-model', protocol='openai-responses')
        self.assertIn('basic', capabilities.get_capabilities('unit-provider', 'other-model', 'openai-responses')['features'])
        self.assertNotIn('basic', capabilities.get_capabilities('unit-provider', 'unit-model')['features'])

    def test_basic_failure_stops_subsequent_paid_probes(self):
        self.client.chat.completions.create.side_effect = ProtocolResponseError(
            {'code': 'upstream_unavailable', 'message': 'upstream unavailable'}, status_code=503, request_id='synthetic-request')
        job = self.job(('basic', 'tools', 'reasoning:low'))
        self.assertEqual(job['status'], 'failed')
        self.assertEqual(job['completed'], 1)
        self.assertEqual(set(job['results']), {'basic'})
        self.assertEqual(self.client.chat.completions.create.call_count, 1)
        details = job['results']['basic']['error_details']
        self.assertEqual(details['http_status'], 503)
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
        self.assertEqual(first['id'], second['id'])
        self.executor.submit.assert_called_once()
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
        self.assertEqual(final['results'], {})
        self.assertEqual(final['completed'], 0)
        self.assertEqual(self.path.read_bytes(), before)
        self.assertNotIn('client', final)

    def test_queued_cancel_never_creates_transport_or_state(self):
        job = self.job(run=False)
        capabilities.cancel_job(job['id'])
        capabilities._run(job['id'])
        self.client.chat.completions.create.assert_not_called()
        self.assertFalse(self.path.exists())

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
        self.assertEqual(final['results'], {})
        self.assertFalse(self.path.exists())
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

    def test_native_search_probe_requires_completed_tool_and_actual_source(self):
        for used, sources, status in ((False, [], 'inconclusive'), (True, [], 'inconclusive'),
                                     (False, [{'url': 'https://docs.python.org/3/'}], 'inconclusive'),
                                     (True, [{'url': 'https://docs.python.org/3/'}], 'passed')):
            reply = response('Python documentation is available at https://docs.python.org/3/')
            reply.web_search_used, reply.web_sources = used, sources
            with patch.object(ai_runtime, 'complete', return_value=(reply, {})) as complete:
                self.assertEqual(capabilities._probe(self.client, 'unit-model', 'openai-responses', 'web_native')[0], status)
            self.assertTrue(complete.call_args.kwargs['require_web'])
            self.assertTrue(complete.call_args.kwargs['web_search'])


if __name__ == '__main__':
    unittest.main()
