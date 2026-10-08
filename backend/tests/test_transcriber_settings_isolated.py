"""Temporary SQLite + JSON checks; no real credentials, services or uploads."""
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from app.db.models.providers import Provider
from app.services.transcriber_config_manager import TranscriberConfigManager
from app.services import transcriber_settings as settings


class TranscriberSettingsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.engine = create_engine('sqlite:///:memory:')
        self.addCleanup(self.engine.dispose)
        Provider.__table__.create(self.engine)
        self.sessions = sessionmaker(bind=self.engine)
        self.patch = patch.object(settings, '_session', self.sessions)
        self.patch.start()
        self.addCleanup(self.patch.stop)
        self.manager = TranscriberConfigManager(str(Path(self.temp.name) / 'transcriber.json'))
        with self.sessions.begin() as db:
            db.add(Provider(id='groq', name='Groq', logo='groq', type='built-in',
                            api_key='private-test-key', base_url='https://audio.invalid/v1', enabled=1))

    def connection(self, **changes):
        return {**settings.groq_connection(), **changes}

    def stored_key(self):
        with self.sessions() as db:
            return db.get(Provider, 'groq').api_key

    def test_mask_roundtrip_and_engine_switches_preserve_connection(self):
        self.assertEqual(self.connection()['api_key'], '********')
        settings.save_transcriber_settings(self.manager, transcriber_type='groq',
            groq_model='custom-audio', connection=self.connection())
        for engine in ['bcut', 'kuaishou', 'fast-whisper', 'mlx-whisper', 'groq']:
            settings.save_transcriber_settings(self.manager, transcriber_type=engine)
        self.assertEqual(self.stored_key(), 'private-test-key')
        reloaded = TranscriberConfigManager(str(self.manager.path))
        self.assertEqual(reloaded.get_config()['groq_model'], 'custom-audio')
        self.assertNotIn('private-test-key', self.manager.path.read_text())

    def test_key_change_clear_and_connection_change(self):
        settings.save_transcriber_settings(self.manager, transcriber_type='groq',
            connection=self.connection(api_key='replacement', base_url='https://other.invalid/v1', enabled=False))
        self.assertEqual(self.stored_key(), 'replacement')
        self.assertEqual(self.connection()['base_url'], 'https://other.invalid/v1')
        self.assertFalse(self.connection()['enabled'])
        settings.save_transcriber_settings(self.manager, transcriber_type='groq',
            connection=self.connection(api_key=''))
        self.assertEqual(self.stored_key(), '')
        self.assertEqual(self.connection()['api_key'], '')

    def test_local_models_independent_and_legacy_value_preserved(self):
        self.manager._write({'transcriber_type': 'mlx-whisper', 'whisper_model_size': 'medium'})
        self.manager.update_config('fast-whisper', whisper_model_size='tiny')
        self.assertEqual(self.manager.get_whisper_model_size(), 'tiny')
        self.manager.update_config('mlx-whisper')
        self.assertEqual(self.manager.get_whisper_model_size(), 'medium')
        self.manager.update_config('mlx-whisper', mlx_whisper_model_size='large-v3')
        self.manager.update_config('bcut')
        self.manager.update_config('fast-whisper')
        self.assertEqual(self.manager.get_whisper_model_size(), 'tiny')
        self.manager.update_config('mlx-whisper')
        self.assertEqual(self.manager.get_whisper_model_size(), 'large-v3')

    def test_invalid_settings_do_not_change_key_or_file(self):
        self.manager.update_config('bcut')
        original = self.manager.path.read_bytes()
        for connection, extra in [
            (self.connection(base_url='https://'), {}),
            (self.connection(base_url='https://secret@audio.invalid'), {}),
            (self.connection(api_key='wrong***mask'), {}),
            (self.connection(api_key='new-secret'), {'groq_model': ''}),
        ]:
            with self.assertRaises(ValueError):
                settings.save_transcriber_settings(self.manager, transcriber_type='groq', connection=connection, **extra)
            self.assertEqual(self.stored_key(), 'private-test-key')
            self.assertEqual(self.manager.path.read_bytes(), original)
        with self.assertRaises(ValueError):
            settings.save_transcriber_settings(self.manager, transcriber_type='bcut', connection=self.connection())

    def test_database_failure_restores_previous_json(self):
        self.manager.update_config('bcut')
        original = self.manager.path.read_bytes()
        with patch('sqlalchemy.orm.Session.commit', side_effect=RuntimeError('simulated disk failure')):
            with self.assertRaises(RuntimeError):
                settings.save_transcriber_settings(self.manager, transcriber_type='groq',
                    groq_model='changed', connection=self.connection(api_key='changed'))
        self.assertEqual(self.manager.path.read_bytes(), original)
        self.assertEqual(self.stored_key(), 'private-test-key')

    def test_missing_legacy_provider_can_be_configured(self):
        with self.sessions.begin() as db:
            db.delete(db.get(Provider, 'groq'))
        self.assertEqual(self.connection()['api_key'], '')
        settings.save_transcriber_settings(self.manager, transcriber_type='groq',
            connection=self.connection(api_key='first-key'))
        self.assertEqual(self.stored_key(), 'first-key')
