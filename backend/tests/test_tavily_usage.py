"""Usage lookup uses synthetic credentials and MockTransport only."""
import json
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient
from app.services import tavily_usage as usage, web_search
from app.routers.model_capabilities import router

HTTP_CLIENT = httpx.Client
PAYLOAD = {'account': {'current_plan': 'Fixture', 'plan_usage': 7, 'plan_limit': 40,
                       'paygo_usage': 0, 'paygo_limit': None}, 'key': {'usage': 2, 'limit': None}}


class TavilyUsageTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.path = Path(temporary.name) / 'search.json'
        self.patch = patch.object(web_search, 'SETTINGS_PATH', self.path)
        self.patch.start()
        self.addCleanup(self.patch.stop)
        usage._entries.clear()
        self.now = 1000
        timer = patch.object(usage.time, 'monotonic', lambda: self.now)
        timer.start()
        self.addCleanup(timer.stop)
        self.configure()

    def configure(self, key='fixture-key'):
        web_search.save_profile('tavily', '', key)

    def network(self, handler):
        return patch.object(usage.httpx, 'Client', lambda **kwargs: HTTP_CLIENT(
            transport=httpx.MockTransport(handler), **kwargs))

    def success(self, request):
        self.assertEqual(str(request.url), 'https://api.tavily.com/usage')
        self.assertEqual(request.method, 'GET')
        self.assertEqual(request.headers['Authorization'], 'Bearer fixture-key')
        return httpx.Response(200, json=PAYLOAD)

    def test_disabled_and_other_provider_are_independent_and_config_unchanged(self):
        before = self.path.read_bytes()
        with self.network(self.success):
            result = usage.get_usage()
        self.assertFalse(web_search.settings()['enabled'])
        self.assertEqual(web_search.settings()['provider'], 'searxng')
        self.assertEqual(result['account']['remaining'], 33)
        self.assertIsNone(result['key']['limit'])
        self.assertIsNone(result['key']['remaining'])
        self.assertNotIn('fixture-key', json.dumps(result))
        self.assertEqual(before, self.path.read_bytes())

    def test_missing_key_has_no_network_and_no_fake_balance(self):
        self.configure('')
        with patch.object(usage, '_fetch') as fetch:
            result = usage.get_usage(True)
        fetch.assert_not_called()
        self.assertFalse(result['configured'])
        self.assertIsNone(result['account'])

    def test_cache_ttl_and_manual_minimum_interval(self):
        with patch.object(usage, '_fetch', return_value=usage._normalize(PAYLOAD)) as fetch:
            self.assertFalse(usage.get_usage()['cached'])
            self.now += 64
            self.assertTrue(usage.get_usage(True)['cached'])
            self.now += 1
            self.assertFalse(usage.get_usage(True)['cached'])
            self.now += 299
            self.assertTrue(usage.get_usage()['cached'])
            self.now += 1
            self.assertFalse(usage.get_usage()['cached'])
            self.assertEqual(fetch.call_count, 3)

    def test_concurrent_forced_refresh_is_single_flight(self):
        entered, release = threading.Event(), threading.Event()
        def fetch(key):
            entered.set()
            self.assertTrue(release.wait(3))
            return usage._normalize(PAYLOAD)
        with patch.object(usage, '_fetch', side_effect=fetch) as call:
            with ThreadPoolExecutor(4) as pool:
                futures = [pool.submit(usage.get_usage, True) for _ in range(4)]
                self.assertTrue(entered.wait(3))
                release.set()
                results = [future.result(3) for future in futures]
        self.assertEqual(call.call_count, 1)
        self.assertEqual(sum(not result['cached'] for result in results), 1)

    def test_changed_key_during_request_never_returns_old_account(self):
        def fetch(key):
            self.configure('new-fixture-key')
            return usage._normalize(PAYLOAD)
        with patch.object(usage, '_fetch', side_effect=fetch):
            result = usage.get_usage()
        self.assertTrue(result['configured'])
        self.assertIsNone(result['account'])
        with patch.object(usage, '_fetch', side_effect=httpx.ConnectError('new-fixture-key')):
            result = usage.get_usage()
        self.assertIsNone(result['account'])
        self.assertNotIn('new-fixture-key', json.dumps(result))

    def test_failure_retains_previous_value_but_throttles_background(self):
        with self.network(self.success):
            usage.get_usage()
        self.now += 301
        with patch.object(usage, '_fetch', side_effect=RuntimeError('fixture-key raw error')) as fetch:
            result = usage.get_usage()
            self.assertTrue(result['stale'])
            self.assertEqual(result['account']['remaining'], 33)
            self.assertEqual(result['retry_after_seconds'], 300)
            self.now += 200
            self.assertTrue(usage.get_usage(True)['cached'])
            self.assertEqual(fetch.call_count, 1)
        self.assertNotIn('fixture-key', json.dumps(result))

    def test_429_obeys_retry_after_and_does_not_parse_error_body(self):
        for delay, expected in [('400', 400), ('2', 65), ('garbage', 300)]:
            usage._entries.clear()
            with self.network(lambda request: httpx.Response(429, headers={'Retry-After': delay},
                                                            text='fixture-key')):
                result = usage.get_usage()
            self.assertEqual(result['retry_after_seconds'], expected)
            self.assertIsNone(result['account'])
            self.assertNotIn('fixture-key', json.dumps(result))

    def test_malformed_numbers_remain_unknown(self):
        for number in [None, True, '20', -1, float('nan'), float('inf'), 10 ** 400]:
            with self.subTest(number=str(number)[:10]):
                result = usage._normalize({'key': {'usage': number, 'limit': number}, 'account': {}})
                self.assertEqual(result['key'], {'used': None, 'limit': None, 'remaining': None})
                self.assertIsNone(result['account']['remaining'])
        self.assertEqual(usage._normalize({'key': {'usage': 50, 'limit': 40}})['key']['remaining'], 0)

    def test_errors_oversize_redirect_and_invalid_json_are_safe(self):
        responses = [httpx.Response(401, text='fixture-key'), httpx.Response(503, text='fixture-key'),
                     httpx.Response(302, headers={'Location': 'https://other.invalid/fixture-key'}),
                     httpx.Response(200, content=b'x' * (usage.MAX_BYTES + 1)),
                     httpx.Response(200, text='not json fixture-key'), httpx.Response(200, json=[])]
        for response in responses:
            usage._entries.clear()
            requests = []
            def handler(request):
                requests.append(request)
                return response
            with self.network(handler):
                result = usage.get_usage()
            self.assertEqual(len(requests), 1)
            self.assertIsNone(result['account'])
            self.assertTrue(result['error'])
            self.assertNotIn('fixture-key', json.dumps(result))

    def test_endpoint_returns_wrapped_contract_and_boolean_validation(self):
        app = FastAPI()
        app.include_router(router)
        client = TestClient(app)
        with patch.object(usage, '_fetch', return_value=usage._normalize(PAYLOAD)):
            response = client.get('/web_search/tavily/usage?refresh=true')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['data']['account']['remaining'], 33)
        self.assertEqual(client.get('/web_search/tavily/usage?refresh=invalid').status_code, 422)


if __name__ == '__main__':
    unittest.main()
