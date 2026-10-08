"""Initialize only standalone distribution builds, before importing the app."""
import os
from pathlib import Path
import sys


PORTS = {"quick": 38483, "full": 38484}


def configure(edition: str) -> Path:
    if edition not in PORTS or not getattr(sys, "frozen", False):
        raise RuntimeError("Portable bootstrap requires a frozen quick/full build")
    root = Path(sys.executable).resolve().parent
    os.chdir(root)
    for key, directory in {
        "APPDATA": "AppData", "LOCALAPPDATA": "LocalAppData", "TEMP": "Temp",
        "TMP": "Temp", "HF_HOME": "Cache/huggingface", "XDG_CACHE_HOME": "Cache",
        "NOTE_OUTPUT_DIR": "note_results", "OUT_DIR": "static/screenshots",
        "VECTOR_DB_DIR": "vector_db", "DATA_DIR": "data",
    }.items():
        target = root / directory
        target.mkdir(parents=True, exist_ok=True)
        os.environ[key] = str(target)
    os.environ.update(
        BILINOTE_EDITION=edition, BILINOTE_PORTABLE="1", BACKEND_HOST="127.0.0.1", BACKEND_PORT=str(PORTS[edition]),
        API_BASE_URL="http://127.0.0.1", DATABASE_URL="sqlite:///" + (root / "bili_note.db").as_posix(),
        FFMPEG_BIN_PATH=str(root / "bin"),
        TRANSCRIBER_TYPE="bcut" if edition == "quick" else "fast-whisper", WHISPER_MODEL_SIZE="tiny",
        LANGSMITH_TRACING="false", LANGCHAIN_TRACING_V2="false", ANONYMIZED_TELEMETRY="false",
        STATIC="/static", IMAGE_BASE_URL="/static/screenshots",
    )
    os.environ["PATH"] = str(root / "bin") + os.pathsep + os.environ.get("PATH", "")
    return root
