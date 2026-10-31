"""Set the process data root before test collection imports application modules."""
import atexit
import os
import logging
from pathlib import Path
import tempfile

_original_cwd = Path.cwd()
_runtime = tempfile.TemporaryDirectory(prefix='bilinote-pytest-', ignore_cleanup_errors=True)
os.environ.update(BILINOTE_DATA_ROOT=_runtime.name, BILINOTE_LOCAL_WHISPER='0',
                  DATABASE_URL=f'sqlite:///{Path(_runtime.name).as_posix()}/bili_note.db',
                  NOTE_OUTPUT_DIR=str(Path(_runtime.name) / 'notes'),
                  OUT_DIR=str(Path(_runtime.name) / 'static/screenshots'),
                  TRANSCRIBER_TYPE='bcut', PYTHONDONTWRITEBYTECODE='1')
os.chdir(_runtime.name)


def _cleanup():
    logging.shutdown()
    os.chdir(_original_cwd)
    _runtime.cleanup()


atexit.register(_cleanup)
