import os
import shutil
import subprocess
import sys
from runtime_env import load_dotenv

from app.utils.logger import get_logger
logger = get_logger(__name__)


def _load_dotenv_from_multiple_paths():
    """尝试多个位置加载 .env，适配源码运行和 PyInstaller 打包场景。

    PyInstaller 打包后当前工作目录是 EXE 所在目录，而源码运行时 .env
    通常在项目根目录或 backend/ 同级。遍历常见候选路径确保能命中。
    """
    candidates = []
    # 1. 当前工作目录（EXE 所在目录）
    candidates.append(os.path.join(os.getcwd(), '.env'))
    # 2. 本脚本所在目录（backend/）
    script_dir = os.path.dirname(os.path.abspath(__file__))
    candidates.append(os.path.join(script_dir, '.env'))
    # 3. 项目根目录（backend/../.env）
    candidates.append(os.path.join(script_dir, '..', '.env'))
    # 4. PyInstaller 打包后的 _internal/ 子目录
    if getattr(sys, 'frozen', False):
        exe_dir = os.path.dirname(sys.executable)
        candidates.append(os.path.join(exe_dir, '_internal', '.env'))

    for path in candidates:
        normalized = os.path.normpath(path)
        if os.path.isfile(normalized):
            load_dotenv(normalized)
            return
    # 都没找到，fallback 到默认行为（从 CWD 找）
    load_dotenv()


_load_dotenv_from_multiple_paths()

# Several existing downloaders still invoke "ffmpeg" by name. Set PATH once
# for those callers when the desktop installation supplies a dedicated binary.
_configured_bin = os.getenv("FFMPEG_BIN_PATH")
if _configured_bin and os.path.isfile(os.path.join(_configured_bin, "ffmpeg.exe")):
    _path_entries = os.environ.get("PATH", "").split(os.pathsep)
    if os.path.normcase(os.path.normpath(_configured_bin)) not in {
        os.path.normcase(os.path.normpath(entry)) for entry in _path_entries if entry
    }:
        os.environ["PATH"] = _configured_bin + os.pathsep + os.environ.get("PATH", "")


def find_ffmpeg_binary(name: str) -> str:
    """Resolve both ffmpeg and ffprobe from one configured installation."""
    directory = os.getenv("FFMPEG_BIN_PATH")
    executable = name + (".exe" if os.name == "nt" else "")
    if directory:
        candidate = os.path.join(directory, executable)
        if os.path.isfile(candidate):
            return candidate
    found = shutil.which(name)
    if found:
        return found
    raise FileNotFoundError(f"{name} 未找到，请检查 FFMPEG_BIN_PATH 和 PATH")


def check_ffmpeg_exists() -> bool:
    """
    检查 ffmpeg 是否可用。优先使用 FFMPEG_BIN_PATH 环境变量指定的路径。
    """
    try:
        ffmpeg = find_ffmpeg_binary("ffmpeg")
        ffprobe = find_ffmpeg_binary("ffprobe")
        subprocess.run([ffmpeg, "-version"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
        subprocess.run([ffprobe, "-version"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
        return True
    except (FileNotFoundError, OSError, subprocess.CalledProcessError):
        return False


def ensure_ffmpeg_or_raise():
    """
    校验 ffmpeg 是否可用，否则抛出异常并提示安装方式。
    """
    if not check_ffmpeg_exists():
        logger.error("未检测到 ffmpeg，请先安装后再使用本功能。")
        raise EnvironmentError(
            " 未检测到 ffmpeg，请先安装后再使用本功能。\n"
            "👉 下载地址：https://ffmpeg.org/download.html\n"
            "🪟 Windows 推荐：https://www.gyan.dev/ffmpeg/builds/\n"
            "💡 如果你已安装，请将其路径写入 `.env` 文件，例如：\n"
            "FFMPEG_BIN_PATH=/your/custom/ffmpeg/bin"
        )
