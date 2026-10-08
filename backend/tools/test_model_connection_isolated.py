"""Run model checks in temporary storage with bootstrap and network disabled."""
import argparse
import logging
import os
import socket
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch


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
    with tempfile.TemporaryDirectory(prefix='bilinote-model-tests-') as directory:
        previous = Path.cwd()
        os.chdir(directory)
        try:
            with patch.object(socket.socket, 'connect', side_effect=AssertionError('Real network prohibited')), patch.object(
                socket, 'create_connection', side_effect=AssertionError('Real network prohibited')
            ):
                suite = unittest.defaultTestLoader.loadTestsFromName('tests.test_model_connection_isolated')
                result = unittest.TextTestRunner(verbosity=2).run(suite)
        finally:
            logging.shutdown()
            os.chdir(previous)
    return 0 if result.wasSuccessful() else 1


if __name__ == '__main__':
    raise SystemExit(main())
