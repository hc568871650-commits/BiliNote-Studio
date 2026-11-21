"""测试统一运行时配置与路径容器（无 import 副作用、支持测试隔离）。"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]


def test_import_runtime_has_no_directory_side_effects(tmp_path: Path):
    """导入 app.core.runtime 不应在当前工作目录自动创建任何运行目录。"""
    env = os.environ.copy()
    env.pop("BILINOTE_DATA_ROOT", None)
    env["PYTHONPATH"] = str(BACKEND_DIR) + os.pathsep + env.get("PYTHONPATH", "")

    code = (
        f"import sys; sys.path.insert(0, {str(BACKEND_DIR)!r})\n"
        "import app.core.runtime as rt\n"
        "assert hasattr(rt, 'RuntimeConfig')\n"
        "assert hasattr(rt, 'get_runtime')\n"
        "assert hasattr(rt, 'set_runtime')\n"
    )
    proc = subprocess.run(
        [sys.executable, "-c", code],
        cwd=str(tmp_path),
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert proc.returncode == 0, f"导入失败: {proc.stderr}"
    for dirname in ("static", "uploads", "note_results", "data"):
        assert not (tmp_path / dirname).exists(), f"导入阶段意外创建了目录: {dirname}"


def test_runtime_config_from_env_and_ensure_dirs(tmp_path: Path):
    """RuntimeConfig.from_env(base_dir=tmp_path) 可将全部路径隔离在 tmp_path 内并显式创建。"""
    from app.core.runtime import RuntimeConfig, get_runtime, reset_runtime, set_runtime

    cfg = RuntimeConfig.from_env(base_dir=tmp_path, env={})
    assert cfg.base_dir == tmp_path.resolve()
    assert cfg.static_dir == tmp_path.resolve() / "static"
    assert cfg.screenshot_dir == tmp_path.resolve() / "static" / "screenshots"
    assert cfg.uploads_dir == tmp_path.resolve() / "uploads"
    assert cfg.note_output_dir == tmp_path.resolve() / "note_results"
    assert cfg.data_dir == tmp_path.resolve() / "data"
    assert cfg.static_url_path == "/static"
    assert cfg.backend_host == "127.0.0.1"
    assert cfg.backend_port == 8483

    # 调用 ensure_dirs 前不会自动创建目录
    assert not cfg.static_dir.exists()
    assert not cfg.uploads_dir.exists()
    assert not cfg.note_output_dir.exists()
    assert not cfg.data_dir.exists()

    cfg.ensure_dirs()
    assert cfg.static_dir.is_dir()
    assert cfg.screenshot_dir.is_dir()
    assert cfg.uploads_dir.is_dir()
    assert cfg.note_output_dir.is_dir()
    assert cfg.data_dir.is_dir()

    # 测试全局容器注入与重置
    try:
        set_runtime(cfg)
        assert get_runtime() is cfg
    finally:
        reset_runtime()


def test_runtime_config_respects_explicit_env_overrides(tmp_path: Path):
    """显式环境变量应覆盖默认路径与端口。"""
    from app.core.runtime import RuntimeConfig

    custom_notes = tmp_path / "custom_notes"
    custom_shots = tmp_path / "custom_shots"
    custom_uploads = tmp_path / "custom_uploads"
    env = {
        "NOTE_OUTPUT_DIR": str(custom_notes),
        "OUT_DIR": str(custom_shots),
        "UPLOAD_DIR": str(custom_uploads),
        "STATIC": "/assets",
        "BACKEND_HOST": "0.0.0.0",
        "BACKEND_PORT": "19483",
        "DATABASE_URL": f"sqlite:///{(tmp_path / 'isolated.db').as_posix()}",
    }
    cfg = RuntimeConfig.from_env(base_dir=tmp_path, env=env)
    assert cfg.note_output_dir == custom_notes.resolve()
    assert cfg.screenshot_dir == custom_shots.resolve()
    assert cfg.uploads_dir == custom_uploads.resolve()
    assert cfg.static_url_path == "/assets"
    assert cfg.backend_host == "0.0.0.0"
    assert cfg.backend_port == 19483
    assert cfg.database_url == env["DATABASE_URL"]
