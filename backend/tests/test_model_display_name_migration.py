"""Isolated backward-compatibility and DAO tests for model display names."""

import importlib
from pathlib import Path
import sys
import types
import unittest

from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import sessionmaker
from unittest.mock import patch


BACKEND = Path(__file__).resolve().parents[1]
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

# Import the real DB modules without executing app/__init__.py and its runtime
# router/download dependencies.
if 'app' not in sys.modules:
    app_package = types.ModuleType('app')
    app_package.__path__ = [str(BACKEND / 'app')]
    sys.modules['app'] = app_package

init_db_module = importlib.import_module('app.db.init_db')
model_dao = importlib.import_module('app.db.model_dao')
Base = importlib.import_module('app.db.engine').Base


class ModelDisplayNameMigrationTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine('sqlite:///:memory:')
        self.SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=self.engine)
        self.get_db_patch = patch.object(model_dao, 'get_db', self.get_test_db)
        self.engine_patch = patch.object(init_db_module, 'get_engine', return_value=self.engine)
        self.get_db_patch.start()
        self.engine_patch.start()
        with self.engine.begin() as connection:
            connection.execute(text('''
                CREATE TABLE providers (
                    id VARCHAR PRIMARY KEY, name VARCHAR NOT NULL, logo VARCHAR NOT NULL,
                    type VARCHAR NOT NULL, api_key VARCHAR NOT NULL, base_url VARCHAR NOT NULL,
                    enabled INTEGER, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            '''))
            connection.execute(text('''
                CREATE TABLE models (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, provider_id INTEGER NOT NULL,
                    model_name VARCHAR NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            '''))
            connection.execute(text('''
                INSERT INTO providers (id, name, logo, type, api_key, base_url, enabled)
                VALUES ('legacy-provider', 'Legacy', 'custom', 'custom', 'unused', 'https://example.invalid/v1', 1)
            '''))
            connection.execute(text('''
                INSERT INTO models (provider_id, model_name)
                VALUES ('legacy-provider', 'legacy-api-model')
            '''))

    def tearDown(self):
        self.get_db_patch.stop()
        self.engine_patch.stop()
        self.engine.dispose()

    def get_test_db(self):
        db = self.SessionLocal()
        try:
            yield db
        finally:
            db.close()

    def test_startup_migrates_legacy_rows_idempotently_and_dao_preserves_call_identity(self):
        init_db_module.init_db()
        init_db_module.init_db()

        columns = {column['name']: column for column in inspect(self.engine).get_columns('models')}
        self.assertTrue(columns['display_name']['nullable'])
        legacy = model_dao.get_model_by_provider_and_name('legacy-provider', 'legacy-api-model')
        self.assertIsNotNone(legacy)
        self.assertEqual(legacy['provider_id'], 'legacy-provider')
        self.assertEqual(legacy['model_name'], 'legacy-api-model')
        self.assertIsNone(legacy['display_name'])
        with self.engine.connect() as connection:
            provider_id = connection.execute(text("SELECT id FROM providers WHERE id = 'legacy-provider'")).scalar_one()
        self.assertEqual(provider_id, 'legacy-provider')

        inserted = model_dao.insert_model('legacy-provider', 'literal-api-model', 'Friendly label')
        saved = model_dao.get_model_by_provider_and_name('legacy-provider', 'literal-api-model')
        self.assertEqual(inserted['model_name'], 'literal-api-model')
        self.assertEqual(saved['display_name'], 'Friendly label')

        listed = model_dao.get_models_by_provider('legacy-provider')
        self.assertIn({'id': inserted['id'], 'provider_id': 'legacy-provider',
                       'model_name': 'literal-api-model', 'display_name': 'Friendly label'}, listed)

        updated = model_dao.update_model_display_name(inserted['id'], 'Renamed')
        self.assertEqual(updated['display_name'], 'Renamed')
        self.assertEqual(updated['model_name'], 'literal-api-model')

        cleared = model_dao.update_model_display_name(inserted['id'], '   ')
        self.assertIsNone(cleared['display_name'])
        self.assertEqual(cleared['model_name'], 'literal-api-model')
        self.assertIsNone(model_dao.update_model_display_name(-1, 'missing'))


if __name__ == '__main__':
    unittest.main()
