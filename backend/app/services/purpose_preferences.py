"""Backend persistence for default AI purpose selections (generation / reading / organizer)."""
from __future__ import annotations

import json
import os
import threading
from pathlib import Path
from typing import Any

from app.services import note_storage

VALID_PURPOSES = ("generation", "reading", "organizer", "translation")
VALID_PROTOCOLS = ("openai-chat", "openai-responses", "anthropic", "gemini")
_LOCK = threading.RLock()


def _preferences_path() -> Path:
    explicit = os.getenv("PURPOSE_PREFERENCES_FILE")
    if explicit:
        return Path(explicit)
    return note_storage.ROOT.parent / "data" / "purpose_preferences.json"


def _empty_defaults() -> dict[str, dict[str, str] | None]:
    return {purpose: None for purpose in VALID_PURPOSES}


def _normalize_selection(raw: Any) -> dict[str, str] | None:
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise ValueError("用途模型配置格式无效")
    provider_id = str(raw.get("provider_id") or "").strip()
    model_name = str(raw.get("model_name") or "").strip()
    if not provider_id or not model_name:
        return None
    entry = {"provider_id": provider_id, "model_name": model_name}
    protocol = raw.get("protocol")
    if isinstance(protocol, str) and protocol.strip():
        proto = protocol.strip()
        if proto not in VALID_PROTOCOLS:
            raise ValueError(f"不支持的协议类型: {proto}")
        entry["protocol"] = proto
    return entry


def get_purpose_preferences() -> dict[str, dict[str, str] | None]:
    with _LOCK:
        path = _preferences_path()
        result = _empty_defaults()
        if not path.is_file():
            return result
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return result
        if isinstance(raw, dict):
            for purpose in VALID_PURPOSES:
                if purpose in raw:
                    try:
                        result[purpose] = _normalize_selection(raw[purpose])
                    except ValueError:
                        result[purpose] = None
        return result


def update_purpose_preferences(changes: dict[str, Any]) -> dict[str, dict[str, str] | None]:
    if not isinstance(changes, dict):
        raise ValueError("用途偏好必须是对象")
    with _LOCK:
        current = get_purpose_preferences()
        for key, value in changes.items():
            if key not in VALID_PURPOSES:
                continue
            current[key] = _normalize_selection(value)
        path = _preferences_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        note_storage._atomic_json(path, current)
        return current
