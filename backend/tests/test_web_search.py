"""External search contracts through MockTransport only, never live HTTP."""
import tempfile
import json
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
        from app.services.search_tool import SearchToolSession
        client = types.SimpleNamespace(api_key='known-model-secret')
        with patch.object(web_search.httpx, 'Client') as network:
            result = SearchToolSession(True, 'external', client).execute({'query': 'explain known-model-secret'})
        self.assertIn('error', result)
        network.assert_not_called()

    def test_legacy_settings_without_provider_remain_searxng(self):
        self.path.write_text(json.dumps({'enabled': True, 'base_url': 'https://legacy.invalid',
                                        'api_key': 'legacy-secret'}), encoding='utf-8')
        self.assertEqual(web_search.settings()['provider'], 'searxng')
        self.assertTrue(web_search.available())
        web_search.save_settings(True, 'https://legacy.invalid', '********')
        self.assertEqual(web_search._settings()['api_key'], 'legacy-secret')

    def test_tavily_fixed_endpoint_and_basic_post_wire(self):
        saved = web_search.save_settings(True, 'https://api.tavily.com/search/', 'tavily-test-secret', 'tavily')
        self.assertEqual(saved['base_url'], 'https://api.tavily.com')
        self.assertEqual(saved['api_key'], '********')
        entries = [{'url': 'https://docs.example.com/', 'title': '官方文档', 'content': '<b>结果</b>'}]
        entries += entries + [{'url': f'https://example.com/{i}', 'content': '摘要'} for i in range(9)]
        with self.transport(lambda request: httpx.Response(200, json={'results': entries, 'answer': '忽略'})):
            sources = web_search.search_web(' official docs ')
        self.assertEqual(len(sources), 6)
        self.assertEqual(sources[0]['text'], '结果')
        self.assertEqual(len(self.requests), 1)
        request = self.requests[0]
        self.assertEqual(request.method, 'POST')
        self.assertEqual(str(request.url), 'https://api.tavily.com/search')
        self.assertEqual(request.headers['Authorization'], 'Bearer tavily-test-secret')
        self.assertEqual(json.loads(request.content), {'query': 'official docs', 'search_depth': 'basic',
            'auto_parameters': False, 'max_results': 6, 'topic': 'general', 'include_answer': False,
            'include_raw_content': False, 'include_images': False})
        self.assertEqual(request.extensions['timeout']['read'], 25.0)

    def test_switch_provider_never_reuses_masked_secret(self):
        self.configured()
        with self.assertRaisesRegex(ValueError, 'Tavily API Key'):
            web_search.save_settings(True, '', '********', 'tavily')
        self.assertEqual(web_search.settings()['provider'], 'searxng')
        web_search.save_settings(False, '', '********', 'tavily')
        self.assertEqual(web_search._settings()['api_key'], '')
        web_search.save_settings(True, '', 'tavily-test-secret', 'tavily')
        web_search.save_settings(True, 'https://search.unit.invalid', '********', 'searxng')
        with self.transport(lambda request: httpx.Response(200, json={'results': [
                {'url': 'https://example.com/', 'content': '摘要'}]})):
            web_search.search_web('docs')
        self.assertEqual(self.requests[0].headers['Authorization'], 'Bearer synthetic-search-secret')

    def test_tavily_requires_key_and_never_sends_to_arbitrary_endpoint(self):
        for key in ('', '********', '   '):
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, 'Tavily API Key'):
                web_search.save_settings(True, '', key, 'tavily')
        for endpoint in ('https://other.invalid', 'http://api.tavily.com',
                         'https://api.tavily.com?key=x', 'https://api.tavily.com.evil.invalid'):
            with self.subTest(endpoint=endpoint), self.assertRaisesRegex(ValueError, '官方地址'):
                web_search.save_settings(True, endpoint, 'tavily-test-secret', 'tavily')
        self.assertFalse(self.path.exists())
        # Defense in depth for hand-edited persisted configuration.
        self.path.write_text(json.dumps({'provider': 'tavily', 'enabled': True,
            'base_url': 'https://other.invalid', 'api_key': 'tavily-test-secret'}), encoding='utf-8')
        self.assertFalse(web_search.available())
        with patch.object(web_search.httpx, 'Client') as network, self.assertRaisesRegex(ValueError, '官方地址'):
            web_search.search_web('docs')
        network.assert_not_called()

    def test_tavily_failures_do_not_retry_or_claim_results(self):
        web_search.save_settings(True, '', 'tavily-test-secret', 'tavily')
        for status, message in ((401, 'Key 无效'), (429, '频繁'), (432, '套餐额度'), (433, '按量付费额度')):
            self.requests.clear()
            with self.subTest(status=status), self.transport(lambda request: httpx.Response(status,
                    headers={'x-request-id': 'tavily-test-request'}, json={'detail': 'tavily-test-secret'})), \
                    self.assertRaises(SafeAIError) as raised:
                web_search.search_web('docs')
            self.assertEqual(len(self.requests), 1)
            self.assertEqual(raised.exception.details['http_status'], status)
            self.assertEqual(raised.exception.details['request_id'], 'tavily-test-request')
            self.assertIn(message, str(raised.exception))
            self.assertNotIn('tavily-test-secret', repr(raised.exception.details))
        self.requests.clear()
        with self.transport(lambda request: httpx.Response(200, json={'results': []})), \
                self.assertRaisesRegex(SafeAIError, '没有返回可引用'):
            web_search.search_web('docs')
        self.assertEqual(len(self.requests), 1)

    def test_tavily_oversized_response_and_redirect_are_not_followed(self):
        web_search.save_settings(True, '', 'tavily-test-secret', 'tavily')
        for response in (httpx.Response(200, content=b'x' * (2 * 1024 * 1024 + 1)),
                         httpx.Response(302, headers={'Location': 'https://other.invalid'})):
            self.requests.clear()
            with self.transport(lambda request: response), self.assertRaises(SafeAIError):
                web_search.search_web('docs')
            self.assertEqual(len(self.requests), 1)

    def test_native_default_does_not_call_tavily_or_fallback_after_model_failure(self):
        web_search.save_settings(True, '', 'tavily-test-secret', 'tavily')
        create = Mock(side_effect=RuntimeError('synthetic model failure'))
        client = types.SimpleNamespace(protocol='openai-chat',
            chat=types.SimpleNamespace(completions=types.SimpleNamespace(create=create)))
        with patch.object(web_search, 'search_web') as external, self.assertRaises(SafeAIError):
            ai_runtime.complete(client, 'unit-model', [{'role': 'user', 'content': 'docs'}], web_search=True)
        external.assert_not_called()
        self.assertEqual(create.call_args.kwargs['web_search_options'], {})
        self.assertEqual(create.call_count, 1)


if __name__ == '__main__':
    unittest.main()
