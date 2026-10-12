"""External search contracts through MockTransport only, never live HTTP."""
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import httpx
from app.services import ai_runtime, web_search
from app.utils.ai_errors import SafeAIError

HTTP_CLIENT = httpx.Client


class WebSearchTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='web-search-test-')
        self.addCleanup(temporary.cleanup)
        self.path = Path(temporary.name) / 'search.json'
        context = patch.object(web_search, 'SETTINGS_PATH', self.path)
        context.start()
        self.addCleanup(context.stop)
        self.requests = []

    def configured(self, key='synthetic-search-secret'):
        return web_search.save_settings(True, 'https://search.unit.invalid', key)

    def transport(self, handler):
        def recording(request):
            self.requests.append(request)
            return handler(request)
        def client(**kwargs):
            return HTTP_CLIENT(transport=httpx.MockTransport(recording), **kwargs)
        return patch.object(web_search.httpx, 'Client', side_effect=client)

    def test_settings_mask_roundtrip_preserves_and_can_clear_secret(self):
        self.assertFalse(web_search.available())
        self.assertFalse(self.path.exists())
        saved = self.configured()
        self.assertEqual(saved['api_key'], '********')
        self.assertNotIn('synthetic-search-secret', repr(saved))
        again = web_search.save_settings(True, saved['base_url'], saved['api_key'])
        self.assertEqual(again['api_key'], '********')
        self.assertEqual(web_search._settings()['api_key'], 'synthetic-search-secret')
        self.assertTrue(web_search.available())
        cleared = web_search.save_settings(False, saved['base_url'], '')
        self.assertEqual(cleared['api_key'], '')
        self.assertFalse(web_search.available())

    def test_disabled_search_does_not_create_http_transport(self):
        with patch.object(web_search.httpx, 'Client') as client:
            with self.assertRaisesRegex(ValueError, '尚未配置'):
                web_search.search_web('Python docs')
        client.assert_not_called()

    def test_safe_http_urls_only_deduplicated_and_bounded(self):
        self.configured()
        entries = [{'url': value, 'title': '非法'} for value in (
            'javascript:alert(1)', 'file:///C:/private', 'data:text/html,hello', 'https://user:password@example.com/secret')]
        entries += [{'url': 'https://docs.python.org/3/', 'title': 'Python docs', 'content': '<b>官方</b>文档'},
                    {'url': 'https://docs.python.org/3/', 'title': '重复'}]
        entries += [{'url': f'https://example.com/{i}', 'title': f'结果{i}', 'content': '摘要' * 2000} for i in range(9)]
        with self.transport(lambda request: httpx.Response(200, json={'results': entries})):
            sources = web_search.search_web('Python docs')
        self.assertEqual(len(sources), 6)
        self.assertEqual(sources[0]['url'], 'https://docs.python.org/3/')
        self.assertEqual(sources[0]['text'], '官方文档')
        self.assertTrue(all(len(s['text']) <= 1500 and s['source_type'] == 'web' for s in sources))
        self.assertTrue(all(s['url'].startswith('https://') for s in sources))
        request = self.requests[0]
        self.assertEqual(request.url.path, '/search')
        self.assertEqual(request.url.params['q'], 'Python docs')
        self.assertEqual(request.url.params['format'], 'json')
        self.assertEqual(request.headers['Authorization'], 'Bearer synthetic-search-secret')
        self.assertNotIn('synthetic-search-secret', str(request.url))

    def test_no_results_invalid_shape_and_oversized_payload_are_clear_errors(self):
        self.configured()
        scenarios = [httpx.Response(200, json={'results': []}), httpx.Response(200, json={'unrelated': []}),
                     httpx.Response(200, content=b'X' * (2 * 1024 * 1024 + 128))]
        for response in scenarios:
            with self.subTest(size=len(response.content)):
                with self.transport(lambda request: response), self.assertRaises(SafeAIError) as raised:
                    web_search.search_web('Python')
                self.assertEqual(raised.exception.details['protocol'], 'external-search')
                self.assertEqual(raised.exception.details['kind'], 'validation')
                self.assertNotIn('synthetic-search-secret', str(raised.exception))

    def test_http_error_preserves_status_and_request_id_without_search_key(self):
        self.configured()
        with self.transport(lambda request: httpx.Response(503, headers={'x-request-id': 'synthetic-search-request'},
                json={'error': {'code': 'temporarily_unavailable', 'message': 'service unavailable'}})), \
                self.assertRaises(SafeAIError) as raised:
            web_search.search_web('Python')
        details = raised.exception.details
        self.assertEqual(details['http_status'], 503)
        self.assertEqual(details['request_id'], 'synthetic-search-request')
        self.assertEqual(details['upstream_code'], 'temporarily_unavailable')
        self.assertNotIn('synthetic-search-secret', repr(details))

    def test_invalid_endpoint_rejected_before_settings_write(self):
        for endpoint in ('file:///tmp/search', 'https://user:password@example.com',
                         'https://example.com?api_key=secret', 'https://example.com#secret'):
            with self.subTest(endpoint=endpoint), self.assertRaises(ValueError):
                web_search.save_settings(True, endpoint, '')
        self.assertFalse(self.path.exists())

    def test_sanitizer_rejects_known_and_credential_shaped_queries(self):
        sanitize = getattr(web_search, 'sanitize_search_query', None)
        self.assertTrue(callable(sanitize), 'sanitize_search_query must enforce query privacy before any network request')
        self.assertEqual(sanitize('Python official docs'), 'Python official docs')
        for query, secrets in [('compare known-model-key', ('known-model-key',)),
                               ('test sk-example-secret-token', ()),
                               ('Authorization: Bearer private-token', ()),
                               ('api_key=private-token', ())]:
            with self.subTest(query=query), self.assertRaises((ValueError, SafeAIError)):
                sanitize(query, secrets=secrets)

    def test_search_service_secret_in_query_is_never_sent(self):
        self.configured()
        with patch.object(web_search.httpx, 'Client') as client:
            with self.assertRaises((ValueError, SafeAIError)):
                web_search.search_web('diagnose synthetic-search-secret')
        client.assert_not_called()

    def test_runtime_never_sends_known_model_key_to_external_search(self):
        self.configured()
        client = types.SimpleNamespace(protocol='openai-chat', api_key='known-model-secret',
            chat=types.SimpleNamespace(completions=types.SimpleNamespace(create=Mock())))
        with patch.object(web_search.httpx, 'Client') as network:
            with self.assertRaises((ValueError, SafeAIError)):
                ai_runtime.complete(client, 'unit-model', [{'role': 'user', 'content': 'reference'}],
                                    web_search=True, web_search_mode='external', search_query='explain known-model-secret')
        network.assert_not_called()
        client.chat.completions.create.assert_not_called()


if __name__ == '__main__':
    unittest.main()
