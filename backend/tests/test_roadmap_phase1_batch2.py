"""Offline isolated tests for 0.2.0 Phase 1 Batch 2 (1.4 API unlock, multi-protocol, DPAPI & purpose preferences)."""
from __future__ import annotations

import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

BACKEND = Path(__file__).resolve().parents[1]
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))
if 'app' not in sys.modules:
    app_pkg = types.ModuleType('app')
    app_pkg.__path__ = [str(BACKEND / 'app')]
    sys.modules['app'] = app_pkg

from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import sessionmaker

from app.db import engine as db_engine, init_db as init_db_mod
from app.db.models.models import Model
from app.db.models.providers import Provider
from app.gpt.gpt_factory import GPTFactory
from app.models.model_config import ModelConfig
from app.services import note_storage, purpose_preferences
from app.services.model import ModelService
from app.services.provider import ProviderService
from app.utils import secret_store


class Phase1Batch2Tests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        db_file = self.base / 'isolated_phase1_4.db'
        self.engine = create_engine(f'sqlite:///{db_file.as_posix()}', connect_args={'check_same_thread': False})
        self.SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=self.engine)

        def fake_get_db():
            db = self.SessionLocal()
            try:
                yield db
            finally:
                db.close()

        for target in (
            patch.object(db_engine, 'get_engine', return_value=self.engine),
            patch.object(db_engine, 'get_db', side_effect=fake_get_db),
            patch.object(init_db_mod, 'get_engine', return_value=self.engine),
            patch('app.db.provider_dao.get_db', side_effect=fake_get_db),
            patch('app.db.model_dao.get_db', side_effect=fake_get_db),
            patch.object(note_storage, 'ROOT', self.base / 'notes'),
            patch.dict(os.environ, {'PURPOSE_PREFERENCES_FILE': str(self.base / 'data' / 'purpose_preferences.json')}),
        ):
            target.start()
            self.addCleanup(target.stop)

    def tearDown(self):
        self.engine.dispose()

    def test_dpapi_secret_roundtrip_and_legacy_db_migration(self):
        plain = 'sk-test-secret-1234567890abcdef'
        enc = secret_store.encrypt_secret(plain)
        if sys.platform == 'win32':
            self.assertTrue(secret_store.is_encrypted_secret(enc))
            self.assertNotIn(plain, enc)
            # Encrypting an already encrypted value is idempotent.
            self.assertEqual(secret_store.encrypt_secret(enc), enc)
        self.assertEqual(secret_store.decrypt_secret(enc), plain)
        # Legacy plaintext passes through transparently.
        self.assertEqual(secret_store.decrypt_secret('sk-legacy-plain-9999'), 'sk-legacy-plain-9999')

        # Simulate legacy providers table without `protocol` column and with plaintext api_key.
        with self.engine.begin() as conn:
            conn.execute(text('''
                CREATE TABLE providers (
                    id VARCHAR PRIMARY KEY,
                    name VARCHAR NOT NULL,
                    logo VARCHAR NOT NULL,
                    type VARCHAR NOT NULL,
                    api_key VARCHAR NOT NULL,
                    base_url VARCHAR NOT NULL,
                    enabled INTEGER DEFAULT 1,
                    created_at DATETIME
                )
            '''))
            conn.execute(text('''
                CREATE TABLE models (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    provider_id VARCHAR NOT NULL,
                    model_name VARCHAR NOT NULL,
                    created_at DATETIME
                )
            '''))
            conn.execute(text(
                "INSERT INTO providers (id, name, logo, type, api_key, base_url, enabled) "
                "VALUES ('anthropic-old', 'Anthropic', 'anthropic', 'built-in', :k, 'https://api.anthropic.com', 1)"
            ), {'k': plain})

        init_db_mod.init_db()
        cols = {c['name'] for c in inspect(self.engine).get_columns('providers')}
        self.assertIn('protocol', cols)

        with self.engine.begin() as conn:
            stored_key = conn.execute(text("SELECT api_key FROM providers WHERE id = 'anthropic-old'")).scalar()
        if sys.platform == 'win32':
            self.assertTrue(secret_store.is_encrypted_secret(stored_key))
            self.assertNotEqual(stored_key, plain)

        # Safe list API MUST mask api_key (fixes plaintext exposure vulnerability).
        safe_all = ProviderService.get_all_providers_safe()
        self.assertEqual(len(safe_all), 1)
        self.assertNotIn(plain, safe_all[0]['api_key'])
        self.assertIn('*', safe_all[0]['api_key'])
        self.assertTrue(safe_all[0]['api_key_configured'])

        # Internal lookup decrypts transparently.
        internal = ProviderService.get_provider_by_id('anthropic-old')
        self.assertEqual(internal['api_key'], plain)

    def test_provider_protocol_crud_model_edit_batch_and_delete(self):
        init_db_mod.init_db()
        pid = ProviderService.add_provider(
            name='My Claude Relay',
            api_key='sk-ant-demo-key-987654',
            base_url='https://relay.example.invalid/anthropic',
            logo='custom',
            type_='custom',
            enabled=1,
            protocol='anthropic',
        )
        p_safe = ProviderService.get_provider_by_id_safe(pid)
        self.assertEqual(p_safe['protocol'], 'anthropic')
        self.assertIn('*', p_safe['api_key'])

        # Updating with masked api_key must NOT clobber real secret.
        ProviderService.update_provider(pid, {'api_key': p_safe['api_key'], 'protocol': 'gemini'})
        p_after = ProviderService.get_provider_by_id(pid)
        self.assertEqual(p_after['api_key'], 'sk-ant-demo-key-987654')
        self.assertEqual(p_after['protocol'], 'gemini')

        # Batch add + edit model_name & display_name + duplicate rejection + batch delete.
        batch_res = ModelService.add_models_batch(pid, [
            {'model_name': 'gemini-2.5-flash', 'display_name': 'Gemini Flash'},
            {'model_name': 'gemini-2.5-pro', 'display_name': 'Gemini Pro'},
            {'model_name': 'gemini-2.5-flash', 'display_name': 'Dup'},
        ])
        self.assertEqual(len(batch_res['inserted']), 2)
        self.assertEqual(batch_res['skipped'], ['gemini-2.5-flash'])

        first_id = batch_res['inserted'][0]['id']
        edited = ModelService.update_model_full(
            first_id, model_name='gemini-2.5-flash-latest', display_name='Flash Latest', update_display_name=True
        )
        self.assertEqual(edited['model_name'], 'gemini-2.5-flash-latest')
        self.assertEqual(edited['display_name'], 'Flash Latest')

        with self.assertRaises(ValueError):
            ModelService.update_model_full(first_id, model_name='gemini-2.5-pro')

        deleted_count = ModelService.delete_models_batch([first_id])
        self.assertEqual(deleted_count, 1)

        # Deleting custom provider cascades remaining models.
        self.assertTrue(ProviderService.delete_provider(pid))
        self.assertIsNone(ProviderService.get_provider_by_id(pid))
        self.assertEqual(ModelService.get_enabled_models_by_provider(pid), [])

    def test_multi_protocol_gpt_factory_list_models_and_connect_test(self):
        init_db_mod.init_db()
        # Anthropic protocol via GPTFactory
        ant_cfg = ModelConfig(
            name='Claude', provider='custom', api_key='sk-ant-12345678',
            base_url='https://api.anthropic.com', model_name='claude-sonnet-4-5', protocol='anthropic',
        )
        ant_gpt = GPTFactory.from_config(ant_cfg, backend_id='ant-1')
        self.assertEqual(ant_gpt.client.protocol, 'anthropic')

        # Mock Anthropic list_models
        class _FakeResp:
            status_code = 200
            headers = {'content-type': 'application/json'}
            def __init__(self, payload):
                self._payload = payload
            def raise_for_status(self): pass
            def json(self): return self._payload

        with patch.object(ant_gpt.client.client, 'get', return_value=_FakeResp({'data': [{'id': 'claude-sonnet-4-5', 'display_name': 'Claude Sonnet'}]})):
            listed = ant_gpt.list_models()
            self.assertEqual(listed.data[0]['id'], 'claude-sonnet-4-5')
        ant_gpt.client.close()

        # Gemini protocol via GPTFactory + list_models
        gem_cfg = ModelConfig(
            name='Gemini', provider='custom', api_key='AIza-test-12345678',
            base_url='https://generativelanguage.googleapis.com', model_name='gemini-2.5-pro', protocol='gemini',
        )
        gem_gpt = GPTFactory.from_config(gem_cfg, backend_id='gem-1')
        self.assertEqual(gem_gpt.client.protocol, 'gemini')
        with patch.object(gem_gpt.client.client, 'get', return_value=_FakeResp({'models': [{'name': 'models/gemini-2.5-pro', 'displayName': 'Gemini 2.5 Pro'}]})):
            listed = gem_gpt.list_models()
            self.assertEqual(listed.data[0]['id'], 'gemini-2.5-pro')
        gem_gpt.client.close()

        # Multi-protocol connect_test dispatches to Anthropic client
        pid = ProviderService.add_provider(
            name='Anthropic Test', api_key='sk-ant-connect-1234', base_url='https://api.anthropic.com',
            logo='anthropic', type_='custom', enabled=1, protocol='anthropic',
        )
        ModelService.add_new_model(pid, 'claude-sonnet-4-5')
        fake_wrapper = types.SimpleNamespace(
            client=types.SimpleNamespace(
                chat=types.SimpleNamespace(completions=types.SimpleNamespace(
                    create=lambda **kw: types.SimpleNamespace(choices=[types.SimpleNamespace(message=types.SimpleNamespace(content='OK'))])
                )),
                close=lambda: None,
            )
        )
        with patch('app.services.ai_client.get_client', return_value=fake_wrapper) as mock_get:
            self.assertTrue(ModelService.connect_test(pid))
            mock_get.assert_called_once_with(pid, 'claude-sonnet-4-5', protocol='anthropic')

    def test_purpose_preferences_persistence(self):
        self.assertEqual(purpose_preferences.get_purpose_preferences(), {'generation': None, 'reading': None, 'organizer': None})
        saved = purpose_preferences.update_purpose_preferences({
            'generation': {'provider_id': 'p1', 'model_name': 'claude-sonnet-4-5', 'protocol': 'anthropic'},
            'reading': {'provider_id': 'p2', 'model_name': 'gemini-2.5-pro', 'protocol': 'gemini'},
        })
        self.assertEqual(saved['generation']['protocol'], 'anthropic')
        self.assertEqual(saved['reading']['model_name'], 'gemini-2.5-pro')
        self.assertIsNone(saved['organizer'])
        # Reload from disk confirms atomic persistence.
        reloaded = purpose_preferences.get_purpose_preferences()
        self.assertEqual(reloaded, saved)


if __name__ == '__main__':
    unittest.main()
