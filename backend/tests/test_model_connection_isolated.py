"""Network-free checks of model probes and persisted transcription configuration."""
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx
from openai import OpenAI

from app.gpt.provider.OpenAI_compatible_provider import OpenAICompatibleProvider
from app.services.transcriber_config_manager import TranscriberConfigManager
from app.utils.model_errors import model_error

KEY = 'sk-test-private-credential-do-not-log'
URL = 'https://model.invalid/v1'


class ModelConnectionTests(unittest.TestCase):
    def probe(self, reply=None, status=200, timeout=False):
        calls = []
        clients = []

        def handler(request):
            calls.append(json.loads(request.content))
            if timeout:
                raise httpx.ReadTimeout('timeout with ' + KEY, request=request)
            if status != 200:
                return httpx.Response(status, json={'error': {'message': 'bad key ' + KEY}})
            return httpx.Response(200, json={
                'id': 'isolated-test', 'object': 'chat.completion', 'created': 0,
                'model': 'explicit-test-model', 'choices': [] if reply is None else [
                    {'index': 0, 'message': {'role': 'assistant', 'content': reply}, 'finish_reason': 'stop'},
                ],
            })

        def factory(api_key, base_url, **kwargs):
            self.assertEqual(api_key, KEY)
            self.assertEqual(base_url, URL)
            self.assertEqual(kwargs['timeout'], 60.0)
            # Real SDK with its default retry budget, but an in-memory HTTP transport.
            client = OpenAI(api_key=api_key, base_url=base_url,
                            http_client=httpx.Client(transport=httpx.MockTransport(handler)))
            clients.append(client)
            return client

        with patch('app.gpt.provider.OpenAI_compatible_provider.build_openai_client', factory), patch(
            'app.gpt.provider.OpenAI_compatible_provider.logging.warning'
        ) as warnings:
            try:
                result = OpenAICompatibleProvider.test_connection(KEY, URL, 'explicit-test-model')
            except ValueError as error:
                result = error
            for call in warnings.call_args_list:
                self.assertNotIn(KEY, str(call), 'warning logs must not disclose API keys')
        self.assertEqual(len(calls), 1, 'connectivity probes must not retry automatically')
        self.assertEqual(calls[0]['model'], 'explicit-test-model')
        self.assertEqual(calls[0]['max_tokens'], 256)
        self.assertTrue(clients[0].is_closed(), 'probe client must close on success and failure')
        return result

    def test_visible_reply_succeeds(self):
        self.assertIs(self.probe(reply='OK'), True)

    def test_empty_choices_fail(self):
        result = self.probe()
        self.assertIsInstance(result, ValueError)
        self.assertIn('未返回可见文本', str(result))

    def test_blank_reply_fails(self):
        result = self.probe(reply='   ')
        self.assertIsInstance(result, ValueError)
        self.assertIn('未返回可见文本', str(result))

    def test_401_is_understandable_and_redacted(self):
        result = self.probe(status=401)
        self.assertIsInstance(result, ValueError)
        self.assertIn('HTTP 401', str(result))
        self.assertIn('API Key 无效或已过期', str(result))
        self.assertNotIn(KEY, str(result))

    def test_timeout_does_not_retry_or_leak_key(self):
        result = self.probe(timeout=True)
        self.assertIsInstance(result, ValueError)
        self.assertIn('响应超时', str(result))
        self.assertIn('未自动切换模型', str(result))
        self.assertNotIn(KEY, str(result))

    def test_error_formatter_hides_credentials_and_bounds_detail(self):
        error = model_error(ValueError('supplied ' + KEY + ' Bearer another-secret sk-other-token'), KEY)
        for secret in [KEY, 'another-secret', 'sk-other-token']:
            self.assertNotIn(secret, error)
        self.assertLessEqual(len(model_error(ValueError('x' * 2000))), 800)


class TranscriberConfigurationTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='bilinote-model-config-')
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / 'transcriber.json'
        self.manager = TranscriberConfigManager(str(self.path))

    def test_groq_model_persists_and_survives_partial_update(self):
        with patch.dict(os.environ, {'GROQ_TRANSCRIBER_MODEL': 'env-model'}):
            config = self.manager.update_config('groq', groq_model='  custom-audio-model  ')
            self.assertEqual(config['groq_model'], 'custom-audio-model')
            self.assertEqual(json.loads(self.path.read_text(encoding='utf-8'))['groq_model'], 'custom-audio-model')
            reloaded = TranscriberConfigManager(str(self.path))
            self.assertEqual(reloaded.get_config()['groq_model'], 'custom-audio-model')
            self.assertEqual(reloaded.update_config('groq', whisper_model_size='tiny')['groq_model'], 'custom-audio-model')

    def test_environment_fallback_and_builtin_default(self):
        with patch.dict(os.environ, {'GROQ_TRANSCRIBER_MODEL': 'env-audio-model'}):
            self.assertEqual(self.manager.get_config()['groq_model'], 'env-audio-model')
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(self.manager.get_config()['groq_model'], 'whisper-large-v3-turbo')

    def test_invalid_model_does_not_overwrite_existing_configuration(self):
        self.manager.update_config('groq', groq_model='saved-model')
        before = self.path.read_bytes()
        for invalid in ['', '   ', 'x' * 201]:
            with self.assertRaises(ValueError):
                self.manager.update_config('groq', groq_model=invalid)
            self.assertEqual(self.path.read_bytes(), before)


if __name__ == '__main__':
    unittest.main()
