"""测试后端冷启动导入约束：create_app 不应同步拉起重型三方依赖。"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]

HEAVY_MODULES = (
    "yt_dlp",
    "chromadb",
    "langgraph",
    "langchain_core",
    "faster_whisper",
    "ctranslate2",
    "cv2",
    "openai",
    "PIL",
)


def _probe_create_app_import(tmp_path: Path) -> dict:
    env = os.environ.copy()
    env["BILINOTE_DATA_ROOT"] = str(tmp_path)
    env["BILINOTE_LOCAL_WHISPER"] = "0"
    env["DATABASE_URL"] = f"sqlite:///{(tmp_path / 'cold_start.db').as_posix()}"
    env["NOTE_OUTPUT_DIR"] = str(tmp_path / "note_results")
    env["OUT_DIR"] = str(tmp_path / "static" / "screenshots")

    script = f"""
import json, sys, time
sys.path.insert(0, {str(BACKEND_DIR)!r})
t0 = time.perf_counter()
from app import create_app
app = create_app(lifespan=None)
elapsed = time.perf_counter() - t0
heavy = [m for m in {list(HEAVY_MODULES)!r} if m in sys.modules]
routes = len(app.routes)
print(json.dumps({{"elapsed": round(elapsed, 4), "heavy": heavy, "routes": routes}}))
"""
    proc = subprocess.run(
        [sys.executable, "-c", script],
        cwd=str(tmp_path),
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert proc.returncode == 0, f"子进程执行失败:\nSTDOUT:\n{proc.stdout}\nSTDERR:\n{proc.stderr}"
    last_line = [line for line in proc.stdout.splitlines() if line.strip()][-1]
    return json.loads(last_line)


def test_create_app_does_not_eagerly_import_heavy_modules(tmp_path: Path):
    result = _probe_create_app_import(tmp_path)
    print(f"\n[cold-start] create_app 耗时={result['elapsed']}s, routes={result['routes']}, heavy={result['heavy']}")
    assert result["routes"] > 20
    assert result["heavy"] == [], f"冷启动误加载了重型依赖: {result['heavy']}"


def test_lazy_import_helper_missing_dependency_message():
    from app.core.lazy import lazy_import

    try:
        lazy_import("nonexistent_heavy_pkg_xyz_030", feature_hint="本地离线转写")
    except RuntimeError as exc:
        msg = str(exc)
        assert "本地离线转写" in msg
        assert "nonexistent_heavy_pkg_xyz_030" in msg
    else:
        raise AssertionError("缺失可选依赖时应抛出包含中文提示的 RuntimeError")
