"""Read local media without creating artifacts beside the original file."""

import hashlib
import json
import math
import os
from pathlib import Path
import subprocess
from typing import Optional

from app.downloaders.base import Downloader
from app.enmus.note_enums import DownloadQuality
from app.models.audio_model import AudioDownloadResult
from app.utils.video_helper import save_cover_to_static
from ffmpeg_helper import find_ffmpeg_binary


class LocalDownloader(Downloader):
    @staticmethod
    def _source(video_url: str) -> Path:
        if video_url.startswith('/uploads'):
            video_url = os.path.join(os.getcwd(), video_url.lstrip('/'))
        source = Path(video_url).resolve()
        if not source.is_file():
            raise FileNotFoundError(f"本地文件不存在: {source}")
        return source

    @staticmethod
    def _output_directory(source: Path, output_dir: Optional[str] = None) -> Path:
        if output_dir is not None:
            directory = Path(output_dir).resolve()
        else:
            stat = source.stat()
            identity = f"{source}:{stat.st_size}:{stat.st_mtime_ns}"
            key = hashlib.sha256(identity.encode('utf-8')).hexdigest()[:20]
            directory = Path(os.getenv('NOTE_OUTPUT_DIR', 'note_results')).resolve() / 'local_media' / key
        directory.mkdir(parents=True, exist_ok=True)
        return directory

    @staticmethod
    def _run(command: list[str], operation: str, timeout: Optional[int] = None):
        try:
            return subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                  check=True, text=True, encoding='utf-8', errors='replace',
                                  timeout=timeout)
        except subprocess.CalledProcessError as exc:
            detail = exc.stderr or ''
            if isinstance(detail, bytes):
                detail = detail.decode('utf-8', errors='replace')
            raise RuntimeError(f"{operation}失败（退出码 {exc.returncode}）：{detail.strip()[-1800:] or '无错误详情'}") from exc
        except subprocess.TimeoutExpired as exc:
            raise RuntimeError(f"{operation}超时，请检查本地媒体文件是否可读取") from exc

    def _duration(self, source: Path) -> float:
        result = self._run([
            find_ffmpeg_binary('ffprobe'), '-v', 'error', '-show_entries',
            'format=duration:stream=duration', '-of', 'json', str(source),
        ], '读取媒体时长', timeout=60)
        try:
            info = json.loads(result.stdout)
            candidates = [info.get('format', {}).get('duration')]
            candidates.extend(stream.get('duration') for stream in info.get('streams', []))
            for candidate in candidates:
                try:
                    duration = float(candidate)
                except (TypeError, ValueError):
                    continue
                if math.isfinite(duration) and duration > 0:
                    return duration
        except (TypeError, ValueError, AttributeError) as exc:
            raise RuntimeError('ffprobe 返回了无效媒体信息，无法读取时长') from exc
        raise RuntimeError('无法读取有效媒体时长，请确认本地文件不是损坏或未完成下载的视频')

    def extract_cover(self, input_path: str, output_dir: Optional[str] = None) -> str:
        source = self._source(input_path)
        directory = self._output_directory(source, output_dir)
        output_path = directory / f'{source.stem}_cover.jpg'
        if output_path.resolve() == source:
            raise ValueError('封面输出路径不能覆盖原媒体文件')
        self._run([
            find_ffmpeg_binary('ffmpeg'), '-nostdin', '-hide_banner', '-loglevel', 'error',
            '-ss', '0', '-i', str(source), '-frames:v', '1', '-q:v', '2',
            '-y', str(output_path),
        ], '提取封面')
        if not output_path.is_file() or output_path.stat().st_size == 0:
            raise RuntimeError(f'封面图片未生成或为空: {output_path}')
        return str(output_path)

    def convert_to_mp3(self, input_path: str, output_path: Optional[str] = None) -> str:
        source = self._source(input_path)
        if output_path is None:
            output = self._output_directory(source) / f'{source.stem}.mp3'
        else:
            output = Path(output_path).resolve()
            output.parent.mkdir(parents=True, exist_ok=True)
        if output.resolve() == source:
            raise ValueError('音频输出路径不能覆盖原媒体文件')
        self._run([
            find_ffmpeg_binary('ffmpeg'), '-nostdin', '-hide_banner', '-loglevel', 'error',
            '-i', str(source), '-vn', '-acodec', 'libmp3lame', '-y', str(output),
        ], '提取 MP3 音频')
        if not output.is_file() or output.stat().st_size == 0:
            raise RuntimeError(f'MP3 音频未生成或为空: {output}')
        return str(output)

    def download_video(self, video_url: str, output_dir: Optional[str] = None) -> str:
        return str(self._source(video_url))

    def download(self, video_url: str, output_dir: Optional[str] = None,
                 quality: DownloadQuality = 'fast', need_video: Optional[bool] = False) -> AudioDownloadResult:
        source = self._source(video_url)
        directory = self._output_directory(source, output_dir)
        duration = self._duration(source)
        file_path = self.convert_to_mp3(str(source), str(directory / f'{source.stem}.mp3'))
        cover_path = self.extract_cover(str(source), str(directory))
        cover_url = save_cover_to_static(cover_path)
        return AudioDownloadResult(
            file_path=file_path, title=source.stem, duration=duration, cover_url=cover_url,
            platform='local', video_id=source.stem,
            raw_info={'path': file_path, 'source_path': str(source), 'cover_path': cover_path},
            video_path=str(source),
        )
