"""Groq transcription with bounded, resumable audio uploads."""

from abc import ABC
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile

from ffmpeg_helper import find_ffmpeg_binary
from app.decorators.timeit import timeit
from app.models.transcriber_model import TranscriptResult, TranscriptSegment
from app.services.provider import ProviderService
from app.services.transcriber_config_manager import TranscriberConfigManager
from app.transcriber.base import Transcriber
from app.utils.logger import get_logger
from app.utils.openai_client import build_openai_client


logger = get_logger(__name__)
MAX_UPLOAD_BYTES = 20_000_000
TARGET_CHUNK_BYTES = 18_000_000
OVERLAP_SECONDS = 1.0
CACHE_VERSION = 1


def _binary(name):
    return find_ffmpeg_binary(name)


def _run(command):
    completed = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if completed.returncode:
        raise RuntimeError(f"音频处理失败: {completed.stderr[-1500:]}")
    return completed.stdout


def _probe(path):
    output = _run([
        _binary("ffprobe"), "-v", "error", "-select_streams", "a:0",
        "-show_entries", "format=duration:stream=codec_name", "-of", "json", str(path),
    ])
    info = json.loads(output)
    streams = info.get("streams") or []
    duration = float(info.get("format", {}).get("duration") or 0)
    if not streams or duration <= 0:
        raise ValueError("音频文件没有可转写的音轨或有效时长")
    return duration, streams[0]["codec_name"]


def _fingerprint(path):
    digest = hashlib.sha256()
    with open(path, "rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _split_audio(path, workdir, duration, codec):
    """Regenerate every chunk if the measured output exceeds the upload budget."""
    source_size = os.path.getsize(path)
    chunk_seconds = max(2.0, duration * TARGET_CHUNK_BYTES / source_size)
    stream_copy = codec == "mp3" and Path(path).suffix.lower() == ".mp3"
    suffix = ".mp3" if stream_copy else ".flac"
    ffmpeg = _binary("ffmpeg")

    for attempt in range(10):
        chunks = []
        start = 0.0
        index = 0
        while start < duration - 0.01:
            end = min(duration, start + chunk_seconds)
            output = Path(workdir) / f"chunk_{index:04d}{suffix}"
            command = [ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", str(path),
                       "-ss", f"{start:.3f}", "-t", f"{end - start:.3f}", "-map", "0:a:0", "-vn"]
            command += ["-c:a", "copy"] if stream_copy else ["-c:a", "flac"]
            _run(command + [str(output)])
            if not output.is_file() or output.stat().st_size == 0:
                raise RuntimeError(f"第 {index + 1} 段音频为空")
            actual_duration, _ = _probe(output)
            if actual_duration < (end - start) - 0.5:
                raise RuntimeError(f"第 {index + 1} 段音频长度不足，无法保证完整转写")
            chunks.append((output, start, end))
            if end >= duration:
                break
            start = max(start + 0.1, end - OVERLAP_SECONDS)
            index += 1
        largest = max(chunk[0].stat().st_size for chunk in chunks)
        if largest <= MAX_UPLOAD_BYTES:
            return chunks
        for output, _, _ in chunks:
            output.unlink()
        logger.info("分段仍超过 20 MB，缩短分段时长后重试 (attempt=%s, largest=%s)", attempt + 1, largest)
        chunk_seconds *= 0.75
        if chunk_seconds <= OVERLAP_SECONDS + 0.2:
            break
    raise RuntimeError("无法将音频切成每段小于 20 MB 的可解码文件")


def _merge(chunks, responses):
    segments = []
    for index, ((_, start, end), response) in enumerate(zip(chunks, responses)):
        overlap_end = chunks[index - 1][2] if index else 0
        for segment in response.get("segments") or []:
            local_start = max(0.0, float(segment["start"]))
            local_end = max(local_start, float(segment["end"]))
            text = segment["text"].strip()
            if not text:
                continue
            absolute_start = round(start + local_start, 3)
            absolute_end = round(min(end, start + local_end), 3)
            if absolute_start > absolute_end:
                continue
            # Only remove a matching transcription in the shared audio interval.
            duplicate = index and absolute_start < overlap_end and any(
                prior.text == text and prior.start < overlap_end and prior.end > start
                and abs((prior.start + prior.end) / 2 - (absolute_start + absolute_end) / 2) <= 0.75
                for prior in segments
            )
            if not duplicate:
                segments.append(TranscriptSegment(start=absolute_start, end=absolute_end, text=text))
    segments.sort(key=lambda segment: (segment.start, segment.end))
    language = next((response.get("language") for response in responses if response.get("language")), None)
    return TranscriptResult(
        language=language,
        full_text=" ".join(segment.text for segment in segments),
        segments=segments,
        raw={"chunks": [{"start": start, "end": end, "response": response}
                        for (_, start, end), response in zip(chunks, responses)]},
    )


class GroqTranscriber(Transcriber, ABC):
    @timeit
    def transcript(self, file_path: str) -> TranscriptResult:
        provider = ProviderService.get_provider_by_id("groq")
        if not provider:
            raise ValueError("Groq 未配置，请在设置 → 音频转写中配置连接")
        if not provider.get("enabled", True):
            raise ValueError("Groq 连接已停用，请在设置 → 音频转写中启用")
        model = TranscriberConfigManager().get_config()["groq_model"]
        client = build_openai_client(
            api_key=provider.get("api_key"), base_url=provider.get("base_url"),
            key_label="Groq 转写引擎的 API Key",
        )
        source = Path(file_path)
        workdir = None
        if source.stat().st_size <= MAX_UPLOAD_BYTES:
            chunks = [(source, 0.0, None)]
        else:
            workdir = tempfile.TemporaryDirectory(prefix="bilinote-groq-")
            try:
                duration, codec = _probe(source)
                chunks = _split_audio(source, workdir.name, duration, codec)
            except BaseException:
                workdir.cleanup()
                raise

        try:
            if workdir:
                identity = f"{CACHE_VERSION}:{_fingerprint(source)}:{model}:{provider.get('base_url')}"
                cache_dir = Path(os.getenv("NOTE_OUTPUT_DIR", "note_results")) / "groq_chunks" / hashlib.sha256(identity.encode()).hexdigest()
                cache_dir.mkdir(parents=True, exist_ok=True)
            responses = []
            for index, (path, _start, _end) in enumerate(chunks):
                size = path.stat().st_size
                if not size or size > MAX_UPLOAD_BYTES:
                    raise ValueError(f"第 {index + 1} 段音频大小不符合上传限制: {size} bytes")
                cache_file = cache_dir / f"{index:04d}-{_fingerprint(path)}.json" if workdir else None
                if cache_file and cache_file.is_file():
                    try:
                        response = json.loads(cache_file.read_text(encoding="utf-8"))
                    except (OSError, ValueError):
                        logger.warning("第 %s 段的缓存无效，重新请求转写", index + 1)
                        response = None
                else:
                    response = None
                if response is None:
                    logger.info("Groq 转写第 %s/%s 段 (bytes=%s)", index + 1, len(chunks), size)
                    try:
                        with path.open("rb") as stream:
                            result = client.audio.transcriptions.create(
                                file=(path.name, stream), model=model, response_format="verbose_json",
                            )
                    except Exception as exc:
                        logger.exception("Groq 转写失败 (chunk=%s/%s, bytes=%s)", index + 1, len(chunks), size)
                        raise RuntimeError(f"Groq 转写第 {index + 1}/{len(chunks)} 段失败: {exc}") from exc
                    response = result.to_dict()
                    if cache_file:
                        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", suffix=".tmp",
                                                         dir=cache_dir, delete=False) as temporary:
                            json.dump(response, temporary, ensure_ascii=False)
                        os.replace(temporary.name, cache_file)
                responses.append(response)
            if workdir:
                return _merge(chunks, responses)
            response = responses[0]
            segments = [TranscriptSegment(start=segment["start"], end=segment["end"], text=segment["text"].strip())
                        for segment in response.get("segments") or []]
            return TranscriptResult(language=response.get("language"),
                                    full_text=" ".join(segment.text for segment in segments),
                                    segments=segments, raw=response)
        finally:
            if workdir:
                workdir.cleanup()
