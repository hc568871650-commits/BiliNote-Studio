"""Keep dotenv discovery within standalone package roots."""
import os
from pathlib import Path
import sys
from dotenv import load_dotenv as _load_dotenv


def load_dotenv(*args, **kwargs):
    if getattr(sys, "frozen", False) and os.getenv("BILINOTE_INSTALLER") == "1":
        return _load_dotenv(Path(os.environ["BILINOTE_DATA_ROOT"]) / ".env", override=False)
    if getattr(sys, "frozen", False) and os.getenv("BILINOTE_PORTABLE") == "1":
        # Never search the parent directory of an extracted package.
        return _load_dotenv(Path(sys.executable).resolve().parent / ".env", override=False)
    return _load_dotenv(*args, **kwargs)
