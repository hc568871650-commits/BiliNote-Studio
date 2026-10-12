"""Offline run accounting and real note admission/storage integration.

Run with a Python environment containing pydantic v2; every client here is a stub.
"""
import importlib.util
import ast
import json
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

from .test_universal_gpt_content_format import _load_universal_gpt_class
from . import test_note_admission_isolated as admission
from . import test_note_pipeline_isolated as pipeline

ROOT = Path(__file__).resolve().parents[1]


def load(relative, name):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


Options = load('app/models/generation_options.py', 'offline_generation_options')


def response(reason='stop', usage=None, text='SAFE_BODY'):
    return types.SimpleNamespace(choices=[types.SimpleNamespace(finish_reason=reason,
        message=types.SimpleNamespace(content=text, refusal=None))], usage=usage)


class HTTPError(Exception):
    def __init__(self, status, message='PRIVATE_ERROR_BODY'):
        self.status_code = status
        super().__init__(message)


class GenerationObservabilityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.GPT = _load_universal_gpt_class()
        with patch.dict(os.environ, {'NOTE_OUTPUT_DIR': str(self.root / 'notes')}):
            self.storage = load('app/services/note_storage.py', 'offline_usage_storage')
        services = types.ModuleType('app.services')
        services.note_storage = self.storage
        self.modules = patch.dict(sys.modules, {'app.models.generation_options': Options,
            'app.services': services, 'app.services.note_storage': self.storage})
        self.modules.start()
        self.addCleanup(self.modules.stop)
        self.usage = load('app/services/generation_usage.py', 'offline_generation_usage')
        self.usage_module = patch.dict(sys.modules, {'app.services.generation_usage': self.usage})
        self.usage_module.start()
        self.addCleanup(self.usage_module.stop)
        self.storage.create_draft('task', {'video_url': 'local.mp4', 'platform': 'local'})

    def recorder(self, **options):
        return self.usage.GenerationUsageRecorder('task', options, request_id='request-1', model='offline', provider_id='test')

    def client(self, answers):
        calls = []
        sdk_options = []
        def create(**kwargs):
            calls.append(kwargs)
            value = answers(len(calls), kwargs) if callable(answers) else answers[len(calls) - 1]
            if isinstance(value, Exception):
                raise value
            return value
        client = types.SimpleNamespace(chat=types.SimpleNamespace(completions=types.SimpleNamespace(create=create)))
        def with_options(**kwargs):
            sdk_options.append(kwargs)
            return client
        client.with_options = with_options
        return client, calls, sdk_options

    def gpt(self, recorder, answers, model='offline'):
        client, calls, sdk_options = self.client(answers)
        with patch.dict(os.environ, {'NOTE_OUTPUT_DIR': str(self.root / 'checkpoints')}):
            gpt = self.GPT(client, model)
        gpt.configure_generation(recorder.options, recorder)
        gpt._retry_base_backoff = 0
        return gpt, calls, sdk_options

    def test_options_boundaries_and_no_unvalidated_secret_fields(self):
        self.assertEqual(Options.GenerationOptions().retry_attempts, 1)
        for field, value in [('reasoning_effort', 'xhigh'), ('temperature', float('nan')),
                             ('temperature', -1), ('chunk_seconds', 59), ('chunk_text_chars', 999),
                             ('max_output_tokens', 255), ('max_requests', 201), ('retry_attempts', 4),
                             ('api_key', 'SECRET')]:
            with self.subTest(field=field), self.assertRaises(ValueError):
                Options.GenerationOptions.model_validate({field: value})
        for value in [-1, float('inf')]:
            with self.assertRaises(ValueError):
                Options.GenerationPrice(input_per_million=value)
        for price in ({}, {'mode': 'tokens', 'input_per_million': 1}, {'mode': 'per_call'}):
            with self.assertRaises(ValueError):
                Options.GenerationPrice.model_validate(price)
        self.assertEqual(Options.GenerationPrice(input_per_million=0, output_per_million=0).output_per_million, 0)

    def test_provider_usage_discrepancies_and_reasoning_not_double_counted(self):
        metrics = self.usage.extract_usage(response(usage={'prompt_tokens': 100, 'completion_tokens': 20,
            'total_tokens': 120, 'completion_tokens_details': {'reasoning_tokens': 8},
            'prompt_tokens_details': {'cached_tokens': 40}}))
        self.assertEqual(metrics['reasoning_tokens'], 8)
        self.assertEqual(metrics['total_tokens'], 120)
        self.assertEqual(metrics['discrepancies'], [])
        bad = self.usage.extract_usage({'usage': {'input_tokens': 10, 'output_tokens': 5, 'total_tokens': 20,
            'prompt_cache_hit_tokens': 11, 'prompt_cache_miss_tokens': 2,
            'output_tokens_details': {'reasoning_tokens': 6}}})
        self.assertEqual(len(bad['discrepancies']), 4)
        empty = self.usage.extract_usage({'usage': {'prompt_tokens': True, 'completion_tokens': 'secret'}})
        self.assertIsNone(empty['input_tokens'])
        self.assertIsNone(empty['output_tokens'])
        zero = self.usage.extract_usage({'usage': {'prompt_cache_hit_tokens': 0}})
        self.assertEqual(zero['cached_input_tokens'], 0)
        self.assertEqual(zero['cache_status'], 'miss')

    def test_midrun_persistence_missing_usage_and_private_content_exclusion(self):
        recorder = self.recorder()
        index = recorder.start_attempt(node='chunk-0/root', logical_request_id='logical-1')
        saved = self.usage.list_generation_runs('task')[0]
        self.assertEqual(saved['status'], 'running')
        self.assertEqual(saved['attempts'][0]['status'], 'running')
        self.assertIsNone(saved['summary']['input_tokens'])
        recorder.complete_attempt(index, error=HTTPError(503))
        recorder.finish('failed', HTTPError(503))
        raw = json.dumps(self.usage.list_generation_runs('task'))
        self.assertNotIn('PRIVATE_ERROR_BODY', raw)
        saved = self.usage.list_generation_runs('task')[0]
        self.assertEqual(saved['attempts'][0]['http_status'], 503)
        self.assertEqual(saved['summary']['attempt_count'], 1)
        self.assertIsNone(saved['summary']['cached_input_tokens'])
        self.assertEqual(self.usage.list_generation_runs('historical'), [])

    def test_retry_temperature_fallback_accounted_with_sdk_retries_disabled(self):
        recorder = self.recorder(retry_attempts=2, max_requests=3, reasoning_effort='high', max_output_tokens=1024)
        gpt, calls, sdk_options = self.gpt(recorder, [HTTPError(400, 'temperature does not support .7'),
            HTTPError(503), response(usage={'prompt_tokens': 100, 'completion_tokens': 20, 'total_tokens': 120})])
        gpt._chat_completion_create([{'role': 'user', 'content': 'SECRET_PROMPT'}])
        recorder.finish('succeeded')
        report = self.usage.list_generation_runs('task')[0]
        self.assertEqual(len(calls), 3)
        self.assertEqual(sdk_options, [{'max_retries': 0, 'timeout': 120.0}])
        self.assertNotIn('temperature', calls[1])
        self.assertEqual(calls[2]['max_tokens'], 1024)
        self.assertEqual(calls[2]['reasoning_effort'], 'high')
        self.assertEqual(report['counts']['temperature_fallbacks'], 1)
        self.assertEqual(report['counts']['retries'], 1)
        self.assertEqual(report['summary']['request_count'], 1)
        self.assertEqual(report['summary']['attempt_count'], 3)
        self.assertEqual(report['requests'][0]['attempt_count'], 3)
        self.assertIsNone(report['summary']['input_tokens'])
        self.assertEqual(report['reported_totals']['input_tokens'], 100)
        self.assertNotIn('SECRET_PROMPT', json.dumps(report))

    def test_total_http_budget_stops_retry_and_temperature_fallback(self):
        recorder = self.recorder(retry_attempts=3, max_requests=2)
        gpt, calls, _ = self.gpt(recorder, [HTTPError(400, 'temperature does not support .7'), HTTPError(503)])
        with self.assertRaisesRegex(ValueError, '总 HTTP 请求上限'):
            gpt._chat_completion_create([{'role': 'user', 'content': 'private'}])
        recorder.finish('failed')
        self.assertEqual(len(calls), 2)
        self.assertEqual(recorder.report()['summary']['attempt_count'], 2)
        self.assertIn('request_budget_exhausted', [e['event'] for e in recorder.report()['events']])

    def test_cancel_and_explicit_unsupported_effort_do_not_retry(self):
        recorder = self.recorder(retry_attempts=3, reasoning_effort='max')
        gpt, calls, _ = self.gpt(recorder, [HTTPError(400, 'reasoning_effort unsupported_value SECRET')])
        with self.assertRaises(HTTPError):
            gpt._chat_completion_create([{'content': 'private'}])
        self.assertEqual(len(calls), 1)
        gpt.generation_cancel_check = lambda: (_ for _ in ()).throw(ValueError('cancelled'))
        with self.assertRaisesRegex(ValueError, 'cancelled'):
            gpt._chat_completion_create([{'content': 'private'}])
        self.assertEqual(len(calls), 1)

    def test_reasoning_output_parameter_and_nullable_temperature(self):
        recorder = self.recorder(reasoning_effort='auto', temperature=None, max_output_tokens=4096)
        gpt, calls, _ = self.gpt(recorder, [response()], model='openai/gpt-5.4')
        gpt._chat_completion_create([{'content': 'private'}])
        self.assertEqual(calls[0]['max_completion_tokens'], 4096)
        self.assertNotIn('reasoning_effort', calls[0])
        self.assertNotIn('temperature', calls[0])

    def test_real_sdk_mock_transport_has_no_hidden_http_retries(self):
        try:
            from openai import OpenAI
            import httpx
        except ImportError:
            self.skipTest('OpenAI/httpx required for SDK transport verification')
        seen = []
        def handler(request):
            seen.append(request)
            return httpx.Response(503, json={'error': {'message': 'PRIVATE_SUPPLIER_BODY', 'type': 'server_error'}})
        http = httpx.Client(transport=httpx.MockTransport(handler))
        client = OpenAI(api_key='OFFLINE_SECRET_KEY', base_url='https://offline.invalid/v1',
                        http_client=http, max_retries=2)
        self.addCleanup(client.close)
        recorder = self.recorder(retry_attempts=1, max_requests=3)
        with patch.dict(os.environ, {'NOTE_OUTPUT_DIR': str(self.root / 'checkpoints')}):
            gpt = self.GPT(client, 'offline').configure_generation(recorder.options, recorder)
        with self.assertRaises(Exception):
            gpt._chat_completion_create([{'content': 'PRIVATE_PROMPT', 'role': 'user'}])
        recorder.finish('failed')
        self.assertEqual(len(seen), 1)
        self.assertEqual(gpt.client.max_retries, 0)
        self.assertEqual(gpt.client.timeout, 120.0)
        self.assertEqual(recorder.report()['summary']['attempt_count'], 1)
        saved = json.dumps(self.usage.list_generation_runs('task'))
        for secret in ('OFFLINE_SECRET_KEY', 'PRIVATE_PROMPT', 'PRIVATE_SUPPLIER_BODY'):
            self.assertNotIn(secret, saved)

    def test_truncation_split_phase_nodes_and_merge_count(self):
        recorder = self.recorder()
        gpt, calls, _ = self.gpt(recorder, [response('length', text='PRIVATE_PARTIAL'), response(text='complete A'), response(text='complete B')])
        gpt.summarize.__globals__['RequestChunker'] = load('app/gpt/request_chunker.py', 'offline_observed_chunker').RequestChunker
        gpt.create_messages.__globals__['generate_base_prompt'] = lambda **kw: kw.get('segment_text', '')
        source = types.SimpleNamespace(screenshot=False, link=False,
            segment=[types.SimpleNamespace(start=0, end=20, text='abcdefghijklmnop')],
            video_img_urls=[], video_image_ranges=[], checkpoint_key='task', title='fixture',
            tags=[], _format=[], style='tutorial', extras='', frame_evidence=[])
        result = gpt.summarize(source)
        self.assertNotIn('PRIVATE_PARTIAL', result)
        self.assertEqual(len(calls), 3)
        report = recorder.report()
        self.assertEqual(report['counts']['truncations'], 1)
        self.assertEqual([a['node'] for a in report['attempts']], ['chunk-0/root', 'chunk-0/root/0', 'chunk-0/root/1'])
        gpt.client, _, _ = self.client([response('length', text='PRIVATE_MERGE')])
        merged = gpt._merge_partials(['safe A', 'safe B'], None, None)
        self.assertIn('safe B', merged)
        self.assertNotIn('PRIVATE_MERGE', merged)
        self.assertEqual(recorder.report()['counts']['merge_attempts'], 1)
        self.assertNotIn('PRIVATE_PARTIAL', json.dumps(recorder.report()))

    def test_checkpoint_identity_ignores_only_billing_and_retry_ceilings(self):
        recorder = self.recorder()
        gpt, _, _ = self.gpt(recorder, [])
        source = types.SimpleNamespace(segment=[types.SimpleNamespace(start=0, end=1, text='fixture')],
            video_img_urls=[], video_image_ranges=None, title='fixture', tags=[], _format=[],
            style='tutorial', extras='', frame_evidence=[])
        initial = gpt._build_source_signature(source)
        changed = Options.GenerationOptions(max_requests=128, retry_attempts=3,
            price={'mode': 'per_call', 'per_call': 0.2, 'currency': 'CNY'})
        gpt.configure_generation(changed)
        self.assertEqual(initial, gpt._build_source_signature(source))
        for values in ({'temperature': 1}, {'reasoning_effort': 'high'}, {'max_output_tokens': 4096},
                       {'chunk_seconds': 120}, {'chunk_text_chars': 2000}):
            gpt.configure_generation(values)
            with self.subTest(values=values):
                self.assertNotEqual(initial, gpt._build_source_signature(source))
        gpt.configure_generation({})
        original_model = gpt.model
        gpt.model = 'different-model'
        self.assertNotEqual(initial, gpt._build_source_signature(source))
        gpt.model = original_model
        prompt_contract = gpt._build_source_signature.__globals__['prompt_contract']
        with patch.object(prompt_contract, 'PROMPT_VERSION', 'different-prompt-version', create=True):
            self.assertNotEqual(initial, gpt._build_source_signature(source))

    def test_raising_request_budget_resumes_without_rebilling_completed_chunk(self):
        first = self.recorder(max_requests=1, chunk_seconds=60)
        gpt, calls, _ = self.gpt(first, [response(text='complete-A')])
        gpt.summarize.__globals__['RequestChunker'] = load('app/gpt/request_chunker.py', 'offline_resume_chunker').RequestChunker
        gpt.create_messages.__globals__['generate_base_prompt'] = lambda **kwargs: kwargs.get('segment_text', '')
        source = types.SimpleNamespace(screenshot=False, link=False,
            segment=[types.SimpleNamespace(start=0, end=30, text='subtitle-A'),
                     types.SimpleNamespace(start=90, end=120, text='subtitle-B')],
            video_img_urls=[], video_image_ranges=None, checkpoint_key='task', title='fixture',
            tags=[], _format=[], style='tutorial', extras='', frame_evidence=[])
        initial_signature = gpt._build_source_signature(source)
        with self.assertRaisesRegex(ValueError, '总 HTTP 请求上限'):
            gpt.summarize(source)
        self.assertEqual(len(calls), 1)
        self.assertEqual(gpt._load_checkpoint('task', initial_signature)['partials'], ['complete-A'])
        second = self.recorder(max_requests=3, retry_attempts=2, chunk_seconds=60,
            price={'mode': 'tokens', 'input_per_million': 1, 'output_per_million': 2})
        resumed, resumed_calls, _ = self.gpt(second, [response(text='complete-B'), response(text='complete-merged')])
        resumed.summarize.__globals__['RequestChunker'] = gpt.summarize.__globals__['RequestChunker']
        self.assertEqual(initial_signature, resumed._build_source_signature(source))
        self.assertEqual(resumed.summarize(source), 'complete-merged')
        self.assertEqual(len(resumed_calls), 2)  # Only unfinished B and one merger.
        self.assertIn('subtitle-B', json.dumps(resumed_calls[0]['messages']))
        self.assertNotIn('subtitle-A', json.dumps(resumed_calls[0]['messages']))
        self.assertEqual(second.report()['counts']['summarize_attempts'], 1)

    def test_token_cost_unknown_discount_and_discrepancy_rules(self):
        options = dict(price={'mode': 'tokens', 'input_per_million': 2, 'output_per_million': 10,
                              'cached_input_per_million': .2})
        recorder = self.recorder(**options)
        usage = {'prompt_tokens': 100, 'completion_tokens': 20, 'total_tokens': 120,
                 'prompt_cache_hit_tokens': 40, 'completion_tokens_details': {'reasoning_tokens': 8}}
        index = recorder.start_attempt()
        recorder.complete_attempt(index, response=response(usage=usage))
        self.assertAlmostEqual(recorder.report()['summary']['cost_estimate']['amount'], .000328)
        recorder = self.recorder(**options)
        index = recorder.start_attempt()
        recorder.complete_attempt(index, response=response(usage={'prompt_tokens': 100, 'completion_tokens': 20}))
        self.assertIsNone(recorder.report()['summary']['cost_estimate']['amount'])
        recorder = self.recorder(price={'mode': 'per_call', 'currency': 'CNY', 'per_call': .1})
        for _ in range(2):
            index = recorder.start_attempt()
            recorder.complete_attempt(index, error=HTTPError(503))
        self.assertEqual(recorder.report()['summary']['cost_estimate']['amount'], .2)
        self.assertFalse(recorder.report()['summary']['cost_estimate']['provider_invoice_verified'])

    def test_separate_comparison_directory_and_multiple_runs_preserve_notes(self):
        original = self.storage.get_task('task')
        normal = self.recorder()
        normal.finish('failed')
        other = self.usage.GenerationUsageRecorder('task', directory=self.root / 'comparison' / 'usage')
        other.finish('succeeded')
        self.assertEqual(len(self.usage.list_generation_runs('task')), 1)
        self.assertTrue((self.root / 'comparison' / 'usage' / f"{other.data['run_id']}.json").exists())
        self.recorder().finish('failed')
        self.assertEqual(len(self.usage.list_generation_runs('task')), 2)
        self.assertEqual(original, self.storage.get_task('task'))

    def admission_fixture(self):
        fixture = admission.AdmissionTests(methodName='test_background_success_only_initializes_generator_once')
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        fixture.ns['note_storage'] = self.storage
        return fixture

    def test_normal_router_run_persists_report_and_binds_saved_version(self):
        fixture = self.admission_fixture()
        owner = self
        seen = []
        class Generator:
            @staticmethod
            def _update_status(*args, **kwargs):
                pass
            def generate(self, **kwargs):
                seen.append(kwargs)
                gpt, _, _ = owner.gpt(self.generation_recorder, [response(usage={
                    'prompt_tokens': 40, 'completion_tokens': 5, 'total_tokens': 45})])
                text = gpt._validated_response(gpt._chat_completion_create([{'content': 'private'}]))
                return admission.Note(markdown=text, transcript={'segments': [], 'full_text': 'fixture'},
                            audio_meta={'title': 'fixture', 'platform': 'local'})
        fixture.ns['NoteGenerator'] = Generator
        fixture.ns['run_note_task']('task', 'local.mp4', 'local', 'medium', model_name='test',
            provider_id='test', generation_options={'max_requests': 1}, request_id='generation-1')
        report = self.usage.list_generation_runs('task')[0]
        self.assertEqual(report['status'], 'succeeded')
        self.assertEqual(report['request_id'], 'generation-1')
        self.assertEqual(report['summary']['attempt_count'], 1)
        self.assertEqual(report['version_id'], self.storage.get_task('task')['markdown'][0]['ver_id'])
        self.assertEqual(seen[0]['generation_options'], {'max_requests': 1})
        fixture.ns['NoteGenerator'] = types.SimpleNamespace(_update_status=lambda *a, **k: None)
        fixture.ns['run_note_task']('task', 'local.mp4', 'local', 'medium', model_name='test',
            provider_id='test', generation_options={}, request_id='generation-2')
        reports = self.usage.list_generation_runs('task')
        self.assertEqual(reports[0]['status'], 'failed')
        self.assertEqual(reports[0]['summary']['attempt_count'], 0)
        self.assertIsNone(reports[0]['summary']['input_tokens'])
        self.assertEqual(len(self.storage.get_task('task')['markdown']), 1)

    def test_actual_note_pipeline_configures_and_records_summary(self):
        fixture = pipeline.PipelineRegressionTests(methodName='test_valid_cache_skips_subtitle_and_transcriber_calls')
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        recorder = self.recorder(reasoning_effort='low', max_requests=2, max_output_tokens=1024)
        gpt, calls, _ = self.gpt(recorder, [response(usage={'prompt_tokens': 100,
            'completion_tokens': 40, 'total_tokens': 140}, text='COMPLETE_PIPELINE_NOTE')])
        gpt.summarize.__globals__['RequestChunker'] = load('app/gpt/request_chunker.py', 'offline_pipeline_chunker').RequestChunker
        fixture.generator.generation_recorder = recorder
        fixture.generator._get_gpt.return_value = gpt
        fixture.generator._summarize_text = pipeline.PIPELINE['NoteGenerator']._summarize_text.__get__(fixture.generator)
        fixture.write_transcript(fixture.transcript)
        with patch.dict(pipeline.PIPELINE, {'GPTSource': lambda **kwargs: types.SimpleNamespace(**kwargs)}):
            result = fixture.generate(generation_options=recorder.options, request_id='pipeline-1')
        self.assertIsNotNone(result)
        self.assertEqual(result.markdown, 'COMPLETE_PIPELINE_NOTE')
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]['reasoning_effort'], 'low')
        self.assertEqual(recorder.report()['summary']['input_tokens'], 100)
        self.assertEqual(recorder.report()['summary']['total_tokens'], 140)

    def test_admission_options_fingerprint_and_historical_runs_api(self):
        fixture = self.admission_fixture()
        data = admission.Request(task_id='task', generation_options={'max_requests': 2},
                       prefetched_transcript={'segments': [{'start': 0, 'end': 1, 'text': 'fixture'}]})
        self.assertEqual(fixture.ns['generate_note'](data, fixture.background)['code'], 0)
        data.generation_options = {'max_requests': 3}
        self.assertEqual(fixture.ns['generate_note'](data, fixture.background)['code'], 409)
        admission.methods(ROOT / 'app/routers/note.py', {'generation_runs'}, fixture.ns)
        self.assertEqual(fixture.ns['generation_runs']('task')['data'], [])

    def test_actual_video_request_model_supplies_validated_generation_defaults(self):
        from pydantic import BaseModel, Field, field_validator, model_validator
        from typing import Optional, Literal
        from urllib.parse import urlparse
        source = ast.parse((ROOT / 'app/routers/note.py').read_text(encoding='utf-8-sig'))
        declaration = next(node for node in source.body if isinstance(node, ast.ClassDef) and node.name == 'VideoRequest')
        namespace = dict(BaseModel=BaseModel, Field=Field, field_validator=field_validator,
                         model_validator=model_validator, Optional=Optional, Literal=Literal,
                         DownloadQuality=str, GenerationOptions=Options.GenerationOptions,
                         urlparse=urlparse, normalize_video_url=lambda url: url, is_supported_video_url=lambda url: True)
        exec(compile(ast.fix_missing_locations(ast.Module(body=[declaration], type_ignores=[])), 'request_model', 'exec'), namespace)
        model = namespace['VideoRequest']
        payload = dict(video_url='local.mp4', platform='local', quality='medium', model_name='offline', provider_id='test')
        request = model(**payload)
        self.assertEqual(request.generation_options.max_requests, 64)
        self.assertEqual(request.generation_options.retry_attempts, 1)
        self.assertIn('generation_options', request.model_dump(mode='json'))
        for options in ({'max_requests': 0}, {'temperature': 3}, {'reasoning_effort': 'secret'}):
            with self.assertRaises(ValueError):
                model(**payload, generation_options=options)


if __name__ == '__main__':
    unittest.main()
