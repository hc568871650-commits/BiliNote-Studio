"""统一运行时配置与路径容器。

收敛 DATA_DIR、NOTE_OUTPUT_DIR、UPLOAD_DIR、SCREENSHOT_DIR、DATABASE_URL 等路径读取，
消除模块 import 阶段的目录创建副作用，并支持测试通过 set_runtime() 一键隔离。
"""

from __future__ import annotations

import os
import sys
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping


def _resolve_path(base_dir: Path, raw_value: str | None, default_rel: Path) -> Path:
    if not raw_value:
        return (base_dir / default_rel).resolve()
    candidate = Path(raw_value).expanduser()
    if not candidate.is_absolute():
        candidate = base_dir / candidate
    return candidate.resolve()


def _resolve_base_dir(base_dir: Path | str | None, env: Mapping[str, str]) -> Path:
    if base_dir is not None:
        return Path(base_dir).expanduser().resolve()
    data_root = env.get("BILINOTE_DATA_ROOT")
    if data_root:
        return Path(data_root).expanduser().resolve()
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path.cwd().resolve()


@dataclass(frozen=True)
class RuntimeConfig:
    base_dir: Path
    static_dir: Path
    screenshot_dir: Path
    uploads_dir: Path
    note_output_dir: Path
    data_dir: Path
    static_url_path: str = "/static"
    backend_host: str = "127.0.0.1"
    backend_port: int = 8483
    database_url: str = ""

    @classmethod
    def from_env(
        cls,
        base_dir: Path | str | None = None,
        env: Mapping[str, str] | None = None,
    ) -> "RuntimeConfig":
        source = os.environ if env is None else env
        resolved_base = _resolve_base_dir(base_dir, source)

        static_dir = _resolve_path(resolved_base, source.get("STATIC_DIR"), Path("static"))
        out_dir_raw = source.get("OUT_DIR")
        if out_dir_raw:
            screenshot_dir = _resolve_path(resolved_base, out_dir_raw, Path("static/screenshots"))
        else:
            screenshot_dir = (static_dir / "screenshots").resolve()

        uploads_dir = _resolve_path(resolved_base, source.get("UPLOAD_DIR"), Path("uploads"))
        note_output_dir = _resolve_path(resolved_base, source.get("NOTE_OUTPUT_DIR"), Path("note_results"))
        data_dir = _resolve_path(resolved_base, source.get("DATA_DIR"), Path("data"))

        static_url_path = (source.get("STATIC") or "/static").strip() or "/static"
        if not static_url_path.startswith("/"):
            static_url_path = f"/{static_url_path}"

        backend_host = (source.get("BACKEND_HOST") or "127.0.0.1").strip() or "127.0.0.1"
        raw_port = (source.get("BACKEND_PORT") or "8483").strip()
        try:
            backend_port = int(raw_port)
        except ValueError:
            backend_port = 8483

        database_url = (
            source.get("DATABASE_URL")
            or f"sqlite:///{(resolved_base / 'bili_note.db').as_posix()}"
        )

        return cls(
            base_dir=resolved_base,
            static_dir=static_dir,
            screenshot_dir=screenshot_dir,
            uploads_dir=uploads_dir,
            note_output_dir=note_output_dir,
            data_dir=data_dir,
            static_url_path=static_url_path,
            backend_host=backend_host,
            backend_port=backend_port,
            database_url=database_url,
        )

    def ensure_dirs(self) -> None:
        """显式创建所有必需的运行时目录，不在 import 阶段自动触发。"""
        for path in (
            self.static_dir,
            self.screenshot_dir,
            self.uploads_dir,
            self.note_output_dir,
            self.data_dir,
        ):
            path.mkdir(parents=True, exist_ok=True)


_runtime_lock = threading.Lock()
_runtime_instance: RuntimeConfig | None = None


def get_runtime() -> RuntimeConfig:
    global _runtime_instance
    if _runtime_instance is None:
        with _runtime_lock:
            if _runtime_instance is None:
                _runtime_instance = RuntimeConfig.from_env()
    return _runtime_instance


def set_runtime(cfg: RuntimeConfig) -> RuntimeConfig:
    global _runtime_instance
    with _runtime_lock:
        _runtime_instance = cfg
        return _runtime_instance


def reset_runtime() -> None:
    global _runtime_instance
    with _runtime_lock:
        _runtime_instance = None
