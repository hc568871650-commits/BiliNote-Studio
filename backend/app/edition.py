"""Capabilities for the separately distributed desktop editions."""
import os


def edition() -> str:
    return os.environ.get("BILINOTE_EDITION", "full")


def is_quick() -> bool:
    return edition() == "quick"


def has_local_whisper() -> bool:
    return not is_quick() and os.environ.get("BILINOTE_LOCAL_WHISPER", "1") != "0"


def require_local_transcriber(transcriber_type: str) -> None:
    if not has_local_whisper() and not is_quick() and transcriber_type not in ("bcut", "kuaishou", "groq"):
        raise ValueError("此 Studio 安装版本仅支持在线转写，暂不包含本地 Whisper。")
    if is_quick() and transcriber_type not in ("bcut", "kuaishou", "groq"):
        raise ValueError("快捷版支持在线转写；如需本地 Whisper，请使用完整版。")
