"""External search to model integration; all HTTP uses an in-process transport."""
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx
from openai import OpenAI
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.services import ai_runtime, web_search
from app.routers.model_capabilities import router
from app.utils.ai_errors import SafeAIError

HTTP_CLIENT = httpx.Client


class TavilyIntegrationTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        setting_patch = patch.object(web_search, 'SETTINGS_PATH', Path(directory.name) / 'web_search.json')
        setting_patch.start()
        self.addCleanup(setting_patch.stop)
        self.requests = []

    def client(self, status=200):
        def handle(request):
            body = json.loads(request.content)
            self.requests.append((request.url.host, body))
            if request.url.host == 'api.tavily.com':
                self.assertEqual(request.headers['Authorization'], 'Bearer tvly-synthetic')
                return httpx.Response(status, json={'results': [
                    {'url': 'https://docs.python.org/3/', 'title': 'Python docs', 'content': 'Public documentation snippet'}]})
            self.assertEqual(request.url.host, 'model.invalid')
            if body.get('stream'):
                events = [
                    {'choices': [{'index': 0, 'delta': {'content': 'Synthetic answer'}, 'finish_reason': None}]},
                    {'choices': [{'index': 0, 'delta': {}, 'finish_reason': 'stop'}]}]
                return httpx.Response(200, headers={'content-type': 'text/event-stream'},
                    content=''.join('data: ' + json.dumps(event) + '\n\n' for event in events) + 'data: [DONE]\n\n')
            return httpx.Response(200, json={'id': 'synthetic', 'object': 'chat.completion', 'created': 0,
                'model': 'synthetic', 'choices': [{'index': 0, 'finish_reason': 'stop',
                'message': {'role': 'assistant', 'content': 'Synthetic answer'}}]})
        transport = httpx.MockTransport(handle)
        sdk = OpenAI(api_key='synthetic-model', base_url='https://model.invalid/v1', max_retries=0,
                     http_client=HTTP_CLIENT(transport=transport))
        self.addCleanup(sdk.close)
        return sdk, patch.object(web_search.httpx, 'Client', side_effect=lambda **kw: HTTP_CLIENT(transport=transport, **kw))

    def configure(self):
        web_search.save_settings(True, '', 'tvly-synthetic', 'tavily')
        web_search.save_profile('searxng', 'https://inactive.invalid', 'inactive-synthetic')

    def test_settings_route_roundtrip_masks_key_and_rejects_unknown_provider(self):
        app = FastAPI()
        app.include_router(router)
        with TestClient(app) as client:
            response = client.put('/web_search/settings', json={'provider': 'tavily', 'enabled': True,
                'base_url': '', 'api_key': 'tvly-synthetic'})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()['code'], 0)
            self.assertEqual(client.get('/web_search/settings').json()['data'], {
                'provider': 'tavily', 'enabled': True, 'base_url': 'https://api.tavily.com', 'api_key': '********',
                'profiles': {'searxng': {'base_url': '', 'api_key': ''},
                             'tavily': {'base_url': 'https://api.tavily.com', 'api_key': '********'}}})
            self.assertEqual(client.put('/web_search/settings', json={'provider': 'unknown'}).status_code, 422)

    def test_external_search_is_available_but_not_run_without_model_tool_call(self):
        self.configure()
        for stream in (False, True):
            with self.subTest(stream=stream):
                self.requests.clear()
                sdk, search_transport = self.client()
                with search_transport:
                    response = ai_runtime.complete(sdk, 'synthetic', [{'role': 'user', 'content': 'Public question'}],
                        web_search=True, web_search_mode='external', search_query='Python docs', stream=stream)
                    if stream:
                        while True:
                            try:
                                next(response)
                            except StopIteration as end:
                                response, _ = end.value
                                break
                    else:
                        response, _ = response
                self.assertEqual([host for host, _ in self.requests], ['model.invalid'])
                self.assertNotIn('web_search_options', self.requests[0][1])
                self.assertIn('search_web', [tool['function']['name'] for tool in self.requests[0][1]['tools']])
                self.assertEqual(self.requests[0][1]['messages'], [{'role': 'user', 'content': 'Public question'}])
                self.assertFalse(getattr(response, 'web_search_used', False))

    def test_native_without_evidence_never_uses_configured_tavily(self):
        self.configure()
        sdk, search_transport = self.client()
        with search_transport:
            response, _ = ai_runtime.complete(sdk, 'synthetic', [{'role': 'user', 'content': 'Public question'}], web_search=True)
        self.assertEqual([host for host, _ in self.requests], ['model.invalid'])
        self.assertEqual(self.requests[0][1]['web_search_options'], {})
        self.assertFalse(response.web_search_used)

    def test_exhausted_credits_return_tool_error_without_retry(self):
        from app.services.search_tool import SearchToolSession
        self.configure()
        sdk, search_transport = self.client(status=432)
        session = SearchToolSession(True, 'external', sdk)
        with search_transport:
            result = session.execute({'query': 'Python docs'})
            self.assertIn('套餐额度', result['error'])
            self.assertIn('error', session.execute({'query': 'Other query'}))
        self.assertEqual([host for host, _ in self.requests], ['api.tavily.com'])
        self.assertFalse(session.used)
