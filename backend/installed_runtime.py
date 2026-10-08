"""Initialize the single installed Studio distribution before any app import."""
import os
from pathlib import Path
import sys


def configure(_edition="full") -> Path:
    if not getattr(sys, "frozen", False):
        raise RuntimeError("Installed Studio bootstrap requires a frozen build")
    program = Path(sys.executable).resolve().parent
    configured = os.getenv("BILINOTE_DATA_ROOT") if os.getenv("BILINOTE_INSTALLER") == "1" else os.getenv("BILINOTE_STUDIO_DATA_ROOT")
    if configured:
        root = Path(configured)
        if not root.is_absolute():
            raise RuntimeError("Studio data root must be absolute")
        root = root.resolve()
    else:
        local = os.getenv("LOCALAPPDATA")
        if not local:
            raise RuntimeError("LocalAppData is unavailable")
        root = Path(local).resolve() / "BiliNoteStudio"
    for key, directory in {
        "APPDATA": "AppData", "LOCALAPPDATA": "LocalAppData", "TEMP": "Temp", "TMP": "Temp",
        "HF_HOME": "Cache/huggingface", "XDG_CACHE_HOME": "Cache", "NOTE_OUTPUT_DIR": "note_results",
        "OUT_DIR": "static/screenshots", "VECTOR_DB_DIR": "vector_db", "DATA_DIR": "data",
        "WEBVIEW2_USER_DATA_FOLDER": "WebView2",
    }.items():
        target = root / directory
        target.mkdir(parents=True, exist_ok=True)
        os.environ[key] = str(target)
    os.chdir(root)
    os.environ.update(
        BILINOTE_INSTALLER="1", BILINOTE_PORTABLE="0", BILINOTE_DATA_ROOT=str(root),
        BILINOTE_EDITION="full", BILINOTE_LOCAL_WHISPER="0", BACKEND_HOST="127.0.0.1", BACKEND_PORT="38484",
        DATABASE_URL="sqlite:///" + (root / "bili_note.db").as_posix(),
        API_BASE_URL="http://127.0.0.1", FFMPEG_BIN_PATH=str(root / "bin"),
        TRANSCRIBER_TYPE="bcut", WHISPER_MODEL_SIZE="tiny",
        LANGSMITH_TRACING="false", LANGCHAIN_TRACING_V2="false", ANONYMIZED_TELEMETRY="false",
        STATIC="/static", IMAGE_BASE_URL="/static/screenshots",
    )
    os.environ["PATH"] = str(root / "bin") + os.pathsep + os.environ.get("PATH", "")
    return root
