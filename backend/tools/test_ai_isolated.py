"""Run pure service + in-process HTTP tests, no server/bootstrap/provider database.

Optional --dependencies PATH points to an isolated FastAPI/httpx installation.
This harness substitutes only costly vector/AI boundaries; metadata services are real.
"""
import argparse
import logging
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--dependencies')
    args = parser.parse_args()
    backend = Path(__file__).resolve().parents[1]
    if args.dependencies:
        sys.path.insert(0, str(Path(args.dependencies).resolve()))
    sys.path.insert(0, str(backend))
    app = types.ModuleType('app')
    app.__path__ = [str(backend / 'app')]
    sys.modules['app'] = app
    vector = types.ModuleType('app.services.vector_store')

    class NoVectorNetwork:
        def query(self, *args, **kwargs):
            raise AssertionError('A test attempted a real vector query')

    vector.VectorStoreManager = NoVectorNetwork
    sys.modules[vector.__name__] = vector
    with tempfile.TemporaryDirectory(prefix='bilinote-ai-tests-') as directory:
        previous = Path.cwd()
        os.chdir(directory)
        try:
            suite = unittest.defaultTestLoader.loadTestsFromNames([
                'tests.test_ai_updates', 'tests.test_reading_protocols', 'tests.test_note_folders', 'tests.test_note_library'])
            result = unittest.TextTestRunner(verbosity=2).run(suite)
        finally:
            logging.shutdown()
            os.chdir(previous)
    return 0 if result.wasSuccessful() else 1


if __name__ == '__main__':
    raise SystemExit(main())
