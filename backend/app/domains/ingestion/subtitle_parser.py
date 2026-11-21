"""本地字幕文件（.srt / .vtt）解析器。

职责：
1. 自动探测 UTF-8-BOM / UTF-8 / GB18030(GBK) 常见字幕编码；
2. 归一化 HH:MM:SS,mmm / HH:MM:SS.mmm / MM:SS.mmm 时间戳为秒级浮点；
3. 清理 HTML/WebVTT/ASS 内联样式标签并合并多行文本；
4. 非法时间戳或空字幕给出清晰中文错误，不静默丢弃数据。
"""

from __future__ import annotations

from pathlib import Path
import re
from typing import Iterable

from app.models.transcriber_model import TranscriptResult, TranscriptSegment

SUBTITLE_SUFFIXES = frozenset({".srt", ".vtt"})

_TS_ARROW_RE = re.compile(r"^\s*([^\s]+)\s*-->\s*([^\s]+)(?:\s+.*)?$")
_TS_FULL_RE = re.compile(r"^(?:(\d{1,3}):)?(\d{1,2}):(\d{1,2})([.,](\d{1,3}))?$")
_TAG_RE = re.compile(r"<[^>]+>|\{\\[^}]+\}")
_WS_RE = re.compile(r"\s+")


def is_subtitle_path(path: str | Path | None) -> bool:
    if not path:
        return False
    text = str(path).strip().split("?", 1)[0].split("#", 1)[0]
    return Path(text.replace("\\", "/")).suffix.lower() in SUBTITLE_SUFFIXES


def decode_subtitle_bytes(raw: bytes) -> str:
    if not raw:
        raise ValueError("字幕文件为空，请重新选择有效字幕文件")
    for encoding in ("utf-8-sig", "utf-8", "gb18030", "cp1252"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    raise ValueError("无法识别字幕文件编码，请另存为 UTF-8 或 GBK 后重试")


def parse_subtitle_timestamp(raw: str, *, line_no: int | None = None) -> float:
    token = (raw or "").strip()
    match = _TS_FULL_RE.match(token)
    if not match:
        prefix = f"第 {line_no} 行" if line_no is not None else ""
        raise ValueError(f"{prefix}时间戳格式无效：{token!r}")
    hours_raw, mins_raw, secs_raw, _frac_full, millis_raw = match.groups()
    hours = int(hours_raw) if hours_raw is not None else 0
    mins = int(mins_raw)
    secs = int(secs_raw)
    if mins >= 60 or secs >= 60:
        prefix = f"第 {line_no} 行" if line_no is not None else ""
        raise ValueError(f"{prefix}时间戳分钟或秒超出范围：{token!r}")
    millis = 0
    if millis_raw:
        millis = int(millis_raw.ljust(3, "0")[:3])
    return round(hours * 3600 + mins * 60 + secs + millis / 1000.0, 3)


def _clean_cue_lines(lines: Iterable[str]) -> str:
    cleaned_parts: list[str] = []
    for raw_line in lines:
        stripped = _TAG_RE.sub("", raw_line)
        stripped = _WS_RE.sub(" ", stripped).strip()
        if stripped:
            cleaned_parts.append(stripped)
    return " ".join(cleaned_parts).strip()


def parse_subtitle_text(
    text: str,
    *,
    ext: str = ".srt",
    language: str = "zh",
) -> TranscriptResult:
    normalized = text.lstrip("\ufeff").replace("\r\n", "\n").replace("\r", "\n")
    lines = normalized.split("\n")
    segments: list[TranscriptSegment] = []

    idx = 0
    total = len(lines)
    is_vtt = ext.lower() == ".vtt" or (total > 0 and lines[0].strip().upper().startswith("WEBVTT"))

    # 跳过 WebVTT 文件头元信息（Kind/Language 等）直到首个空行
    if is_vtt:
        while idx < total and lines[idx].strip() != "":
            idx += 1

    while idx < total:
        # 跳过空行
        while idx < total and lines[idx].strip() == "":
            idx += 1
        if idx >= total:
            break

        block_start = idx
        block: list[tuple[int, str]] = []
        while idx < total and lines[idx].strip() != "":
            block.append((idx + 1, lines[idx]))
            idx += 1

        if not block:
            continue

        first_text = block[0][1].strip()
        # 忽略 WebVTT 的 NOTE / STYLE / REGION 块
        if is_vtt and (
            first_text.startswith("NOTE")
            or first_text.startswith("STYLE")
            or first_text.startswith("REGION")
        ):
            continue

        # 定位包含 --> 的时间戳行（允许首行是数字序号或 cue identifier）
        ts_idx: int | None = None
        for bi, (_ln, content) in enumerate(block[:2]):
            if "-->" in content:
                ts_idx = bi
                break

        if ts_idx is None:
            # 若整块只有纯序号或非 cue 注释则跳过；否则如果是疑似坏时间戳则报错
            joined_head = block[0][1].strip()
            if joined_head.isdigit() and len(block) == 1:
                continue
            if len(block) >= 2 and re.search(r"\d+:\S+\s+-->", block[1][1]):
                ts_idx = 1
            else:
                continue

        ts_line_no, ts_line = block[ts_idx]
        match = _TS_ARROW_RE.match(ts_line)
        if not match:
            raise ValueError(f"第 {ts_line_no} 行时间戳格式无效：{ts_line.strip()!r}")

        start = parse_subtitle_timestamp(match.group(1), line_no=ts_line_no)
        end = parse_subtitle_timestamp(match.group(2), line_no=ts_line_no)
        if end < start:
            raise ValueError(
                f"第 {ts_line_no} 行时间戳起止倒置（{match.group(1)} > {match.group(2)}）"
            )

        cue_text = _clean_cue_lines(content for _ln, content in block[ts_idx + 1 :])
        if not cue_text:
            continue
        segments.append(TranscriptSegment(start=start, end=end, text=cue_text))

    if not segments:
        raise ValueError("字幕文件中未解析到任何有效时间轴内容，请检查文件格式")

    segments.sort(key=lambda seg: seg.start)
    full_text = "\n".join(seg.text for seg in segments)
    return TranscriptResult(
        language=language,
        full_text=full_text,
        segments=segments,
        raw={"source": "local_subtitle", "format": ext.lstrip(".").lower(), "cue_count": len(segments)},
    )


def parse_subtitle_file(path: str | Path, *, language: str = "zh") -> TranscriptResult:
    file_path = Path(path)
    if not file_path.is_file():
        raise FileNotFoundError(f"字幕文件不存在：{file_path}")
    ext = file_path.suffix.lower()
    if ext not in SUBTITLE_SUFFIXES:
        raise ValueError(f"暂不支持该字幕格式（{ext or '未知'}），仅支持 .srt 与 .vtt")
    text = decode_subtitle_bytes(file_path.read_bytes())
    return parse_subtitle_text(text, ext=ext, language=language)
