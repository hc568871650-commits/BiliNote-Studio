"""Run actual LangGraph/SQLite session tests against temporary synthetic metadata."""
import argparse
import logging
import os
import sys
import tempfile
import unittest
from pathlib import Path

from serve_organizer_fixture import bootstrap


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--dependencies', default=str(Path(__file__).resolve().parents[2] / '.BiliNote-dev' / 'agent-compatible-deps'))
    args = parser.parse_args()
    bootstrap(args.dependencies)
    with tempfile.TemporaryDirectory(prefix='bilinote-session-tests-') as temporary:
        previous = Path.cwd()
        os.chdir(temporary)
        try:
            suite = unittest.defaultTestLoader.loadTestsFromNames([
                'tests.test_organizer_sessions', 'tests.test_organizer_retention'])
            result = unittest.TextTestRunner(verbosity=2).run(suite)
        finally:
            logging.shutdown()
            os.chdir(previous)
    return 0 if result.wasSuccessful() else 1


if __name__ == '__main__':
    raise SystemExit(main())
