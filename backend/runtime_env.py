"""Keep dotenv discovery within standalone package roots."""
import os
from pathlib import Path
import sys
from dotenv import load_dotenv as _load_dotenv


def configure_data_root():
    root = os.getenv('BILINOTE_DATA_ROOT')
    if not root or getattr(sys, 'frozen', False):
        return
    root = Path(root).expanduser().resolve()
    root.mkdir(parents=True, exist_ok=True)
    os.environ['BILINOTE_DATA_ROOT'] = str(root)
    os.environ.setdefault('DATABASE_URL', f'sqlite:///{root.as_posix()}/bili_note.db')
    os.environ.setdefault('NOTE_OUTPUT_DIR', str(root / 'note_results'))
    os.environ.setdefault('OUT_DIR', str(root / 'static' / 'screenshots'))
    # Legacy services still resolve config/, data/, uploads/ and Temp/ by cwd.
    # Apply the explicit root before any of them are imported.
    os.chdir(root)


def load_dotenv(*args, **kwargs):
    if os.getenv('BILINOTE_DATA_ROOT') and not getattr(sys, 'frozen', False):
        return _load_dotenv(Path(os.environ['BILINOTE_DATA_ROOT']) / '.env', override=False)
    if getattr(sys, "frozen", False) and os.getenv("BILINOTE_INSTALLER") == "1":
        return _load_dotenv(Path(os.environ["BILINOTE_DATA_ROOT"]) / ".env", override=False)
    if getattr(sys, "frozen", False) and os.getenv("BILINOTE_PORTABLE") == "1":
        # Never search the parent directory of an extracted package.
        return _load_dotenv(Path(sys.executable).resolve().parent / ".env", override=False)
    return _load_dotenv(*args, **kwargs)


configure_data_root()
