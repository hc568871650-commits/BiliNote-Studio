"""Profile persistence and routing, with no live network or installation data."""
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient
from app.routers.model_capabilities import router
from app.services import web_search

HTTP_CLIENT = httpx.Client


class SearchProfileTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.path = Path(directory.name) / 'web_search.json'
        setting_patch = patch.object(web_search, 'SETTINGS_PATH', self.path)
        setting_patch.start()
        self.addCleanup(setting_patch.stop)

    def configure(self):
        web_search.save_settings(True, 'https://searx.invalid', 'searx-secret')
        web_search.save_profile('tavily', '', 'tavily-secret')

    def test_legacy_read_preserves_bytes_mtime_and_never_calls_network(self):
        for provider, url in [('searxng', 'https://old.invalid'), ('tavily', web_search.TAVILY_BASE_URL)]:
            with self.subTest(provider=provider):
                original = json.dumps({'provider': provider, 'enabled': True,
                                       'base_url': url, 'api_key': 'legacy-secret'}).encode()
                self.path.write_bytes(original)
                mtime = self.path.stat().st_mtime_ns
                with patch.object(web_search.httpx, 'Client') as network:
                    value = web_search.settings()
                    self.assertTrue(web_search.available())
                    self.assertEqual(web_search._settings()['api_key'], 'legacy-secret')
                network.assert_not_called()
                self.assertEqual(value['provider'], provider)
                self.assertEqual(value['profiles'][provider]['api_key'], '********')
                self.assertEqual(self.path.read_bytes(), original)
                self.assertEqual(self.path.stat().st_mtime_ns, mtime)

    def test_profiles_and_masked_keys_survive_switch_and_toggle(self):
        self.configure()
        self.assertEqual(web_search.settings()['provider'], 'searxng')
        self.assertTrue(web_search.settings()['enabled'])
        for provider, key in [('tavily', 'tavily-secret'), ('searxng', 'searx-secret')]:
            web_search.save_selection(provider=provider)
            web_search.save_profile(provider, web_search._settings()['base_url'])
            self.assertEqual(web_search._settings()['api_key'], key)
        original_profiles = json.loads(self.path.read_text())['profiles']
        web_search.save_selection(enabled=False)
        web_search.save_selection(provider='tavily')
        self.assertFalse(web_search.available())
        web_search.save_selection(enabled=True)
        self.assertTrue(web_search.available())
        self.assertEqual(json.loads(self.path.read_text())['profiles'], original_profiles)
        self.assertNotIn('tavily-secret', repr(web_search.settings()))
        self.assertNotIn('searx-secret', repr(web_search.settings()))

    def test_invalid_switch_and_active_edits_are_atomic(self):
        web_search.save_settings(True, 'https://searx.invalid', 'searx-secret')
        original = self.path.read_bytes()
        for operation in [lambda: web_search.save_selection(provider='tavily'),
                          lambda: web_search.save_profile('searxng', '', ''),
                          lambda: web_search.save_selection(provider='unknown'),
                          lambda: web_search.save_profile('tavily', 'https://evil.invalid', 'secret')]:
            with self.assertRaises(ValueError):
                operation()
            self.assertEqual(self.path.read_bytes(), original)
        web_search.save_profile('tavily', '', 'tavily-secret')
        web_search.save_selection(provider='tavily')
        original = self.path.read_bytes()
        with self.assertRaises(ValueError):
            web_search.save_profile('tavily', '', '')
        self.assertEqual(self.path.read_bytes(), original)

    def test_inactive_secret_query_is_rejected_before_network(self):
        self.configure()
        with patch.object(web_search.httpx, 'Client') as network:
            with self.assertRaisesRegex(ValueError, '密钥或凭据'):
                web_search.search_web('diagnose tavily-secret')
        network.assert_not_called()

    def test_flat_mirror_tracks_active_only_for_rollback(self):
        self.configure()
        operations = [lambda: web_search.save_selection(provider='tavily'),
                      lambda: web_search.save_selection(enabled=False),
                      lambda: web_search.save_profile('tavily', '', 'changed-tavily'),
                      lambda: web_search.save_profile('searxng', 'https://other.invalid', 'changed-searx'),
                      lambda: web_search.save_selection(enabled=True),
                      lambda: web_search.save_selection(provider='searxng')]
        for operation in operations:
            operation()
            persisted = json.loads(self.path.read_text())
            active = persisted['profiles'][persisted['provider']]
            self.assertEqual(persisted['base_url'], active['base_url'])
            self.assertEqual(persisted['api_key'], active['api_key'])

    def test_unconfigured_tavily_reports_its_missing_key(self):
        self.assertEqual(web_search.settings()['profiles']['tavily']['base_url'], web_search.TAVILY_BASE_URL)
        with self.assertRaisesRegex(ValueError, 'Tavily API Key'):
            web_search.save_selection(provider='tavily', enabled=True)
        self.assertFalse(self.path.exists())

    def test_compatibility_save_updates_one_profile_and_global_only(self):
        self.configure()
        web_search.save_settings(False, '', '********', 'tavily')
        persisted = json.loads(self.path.read_text())
        self.assertEqual(persisted['schema_version'], 2)
        self.assertEqual(persisted['profiles']['searxng']['api_key'], 'searx-secret')
        self.assertEqual(persisted['profiles']['tavily']['api_key'], 'tavily-secret')
        self.assertFalse(persisted['enabled'])
        self.assertEqual(persisted['provider'], 'tavily')

    def test_api_profiles_do_not_select_or_enable_and_reads_are_masked(self):
        app = FastAPI()
        app.include_router(router)
        with TestClient(app) as client, patch.object(web_search.httpx, 'Client') as network:
            response = client.put('/web_search/profiles/tavily', json={'api_key': 'tavily-secret'})
            self.assertEqual(response.json()['code'], 0)
            value = client.get('/web_search/settings').json()['data']
            self.assertEqual(value['provider'], 'searxng')
            self.assertFalse(value['enabled'])
            self.assertEqual(value['api_key'], '')
            self.assertEqual(value['profiles']['tavily']['api_key'], '********')
            self.assertNotIn('tavily-secret', repr(response.json()))
            self.assertEqual(client.put('/web_search/selection', json={'provider': 'tavily', 'enabled': True}).json()['code'], 0)
            self.assertTrue(web_search.available())
            original = self.path.read_bytes()
            for body in [{}, {'enabled': None}, {'provider': None}, {'provider': 'unknown'}, {'unrelated': False}]:
                self.assertEqual(client.put('/web_search/selection', json=body).status_code, 422)
                self.assertEqual(self.path.read_bytes(), original)
            self.assertEqual(client.put('/web_search/profiles/unknown', json={}).status_code, 422)
        network.assert_not_called()

    def test_inactive_save_keeps_wire_on_active_service_and_switch_changes_wire(self):
        self.configure()
        requests = []
        def handle(request):
            requests.append(request)
            return httpx.Response(200, json={'results': [{'url': 'https://docs.invalid', 'content': 'public'}]})
        with patch.object(web_search.httpx, 'Client', side_effect=lambda **kw:
                          HTTP_CLIENT(transport=httpx.MockTransport(handle), **kw)):
            web_search.search_web('public docs')
            web_search.save_selection(provider='tavily')
            web_search.search_web('public docs')
            web_search.save_selection(enabled=False)
            with self.assertRaises(ValueError):
                web_search.search_web('public docs')
        self.assertEqual(len(requests), 2)
        self.assertEqual(requests[0].url.host, 'searx.invalid')
        self.assertEqual(requests[0].headers['Authorization'], 'Bearer searx-secret')
        self.assertEqual(requests[1].url.host, 'api.tavily.com')
        self.assertEqual(requests[1].headers['Authorization'], 'Bearer tavily-secret')
        self.assertEqual(json.loads(requests[1].content)['search_depth'], 'basic')
