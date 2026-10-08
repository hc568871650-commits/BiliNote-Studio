"""Run settings tests without app bootstrap, network or production paths."""
import argparse
import logging
import os
from pathlib import Path
import socket
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

parser = argparse.ArgumentParser()
parser.add_argument('--dependencies', required=True)
args = parser.parse_args()
backend = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(Path(args.dependencies).resolve()), str(backend)]
app = types.ModuleType('app')
app.__path__ = [str(backend / 'app')]
sys.modules['app'] = app
with tempfile.TemporaryDirectory(prefix='bilinote-transcriber-settings-') as directory:
    previous = Path.cwd()
    os.chdir(directory)
    try:
        with patch.dict(os.environ, {'DATABASE_URL': 'sqlite:///:memory:', 'PYTHON_DOTENV_DISABLED': '1', 'BILINOTE_EDITION': 'full'}), \
             patch.object(socket.socket, 'connect', side_effect=AssertionError('Network forbidden')):
            result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromNames([
                'tests.test_transcriber_settings_isolated', 'tests.test_model_connection_isolated']))
    finally:
        logging.shutdown()
        os.chdir(previous)
raise SystemExit(0 if result.wasSuccessful() else 1)
