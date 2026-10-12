"""AI upgrade regression: temp data and mocked providers only."""
import logging
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from serve_organizer_fixture import bootstrap

workspace = Path(__file__).resolve().parents[2]
bootstrap(workspace / '.BiliNote-dev' / 'agent-compatible-deps')
vector = types.ModuleType('app.services.vector_store')
class NoNetworkVector:
    def query(self, *args, **kwargs):
        raise AssertionError('Regression tests cannot query real vectors')
vector.VectorStoreManager = NoNetworkVector
sys.modules[vector.__name__] = vector
with tempfile.TemporaryDirectory(prefix='bilinote-ai-upgrade-tests-') as temporary:
    previous = Path.cwd()
    os.chdir(temporary)
    try:
        suite = unittest.defaultTestLoader.loadTestsFromNames([
            'tests.test_ai_updates', 'tests.test_reading_protocols', 'tests.test_reading_stream',
            'tests.test_model_capabilities', 'tests.test_web_search', 'tests.test_library_search',
            'tests.test_web_protocols',
            'tests.test_organizer_sessions', 'tests.test_organizer_retention',
        ])
        result = unittest.TextTestRunner(verbosity=2).run(suite)
    finally:
        logging.shutdown()
        os.chdir(previous)
raise SystemExit(0 if result.wasSuccessful() else 1)
