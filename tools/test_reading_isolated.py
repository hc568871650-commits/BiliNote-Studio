"""Run reading synthetic tests in a temporary runtime, without app bootstrap."""
import argparse
import logging
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--dependencies', required=True)
    parser.add_argument('tests', nargs='*', default=['tests.test_reading_stream', 'tests.test_reading_protocols', 'tests.test_ai_updates'])
    args = parser.parse_args()
    workspace = Path(__file__).resolve().parents[1]
    sys.path[:0] = [str(workspace / 'backend'), str(Path(args.dependencies).resolve())]
    with tempfile.TemporaryDirectory(prefix='bilinote-reading-tests-') as directory:
        os.chdir(directory)
        os.environ.update(NOTE_OUTPUT_DIR=str(Path(directory) / 'notes'), VECTOR_DB_DIR=str(Path(directory) / 'vectors'),
            DATABASE_URL='sqlite:///' + (Path(directory) / 'test.sqlite').as_posix(), BACKEND_PORT='19491',
            BILINOTE_DATA_DIR=directory, LANGSMITH_TRACING='false', LANGCHAIN_TRACING_V2='false')
        import dotenv
        dotenv.load_dotenv = lambda *a, **k: False
        app = types.ModuleType('app')
        app.__path__ = [str(workspace / 'backend' / 'app')]
        sys.modules['app'] = app
        # Vector retrieval is independently tested elsewhere. These synthetic tests
        # must never instantiate embeddings, download models, or open a real store.
        chroma = types.ModuleType('chromadb')
        config = types.ModuleType('chromadb.config')
        config.Settings = lambda **kwargs: kwargs
        def unavailable(*args, **kwargs):
            raise RuntimeError('Vector retrieval disabled in isolated reading tests')
        chroma.PersistentClient = unavailable
        sys.modules.update({'chromadb': chroma, 'chromadb.config': config})
        suite = unittest.defaultTestLoader.loadTestsFromNames(args.tests)
        result = unittest.TextTestRunner(verbosity=2).run(suite)
        logging.shutdown()
        os.chdir(workspace)
        return 0 if result.wasSuccessful() else 1


if __name__ == '__main__':
    raise SystemExit(main())
