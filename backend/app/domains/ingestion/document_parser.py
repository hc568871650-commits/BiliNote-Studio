"""本地文档（PDF / Markdown / TXT）免转写解析器。

许可合规说明：
- PDF 解析优先使用 BSD-3-Clause 纯 Python 库 pypdf（严格禁止引入 AGPL 的 PyMuPDF / fitz）；
- 当运行环境暂未安装 pypdf 时，提供零依赖纯 Python 轻量回退解析（覆盖标准未加密 FlateDecode/明文 PDF），
  无法抽取时给出明确中文安装指引。
"""

from __future__ import annotations

import re
import zlib
from pathlib import Path
from typing import Any

from app.downloaders.web_downloader import split_text_to_segments
from app.models.transcriber_model import TranscriptResult, TranscriptSegment

DOCUMENT_SUFFIXES = frozenset({".pdf", ".md", ".markdown", ".txt"})
DOCUMENT_TEXT_LIMIT = 120_000


def is_document_path(path_or_url: str | Path | None) -> bool:
    """判断路径或 URL 是否指向受支持的本地文档（.pdf / .md / .markdown / .txt）。"""
    if path_or_url is None:
        return False
    raw = str(path_or_url).strip()
    if not raw:
        return False
    cleaned = raw.split("?", 1)[0].split("#", 1)[0]
    return Path(cleaned).suffix.lower() in DOCUMENT_SUFFIXES


def _read_text_with_encoding_fallback(path: Path) -> str:
    raw = path.read_bytes()
    if not raw:
        raise ValueError("文档文件为空，无法生成笔记")
    for encoding in ("utf-8-sig", "utf-8", "gb18030", "utf-16"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace")


def _extract_title_from_markdown(text: str, fallback: str) -> str:
    for line in text.splitlines()[:30]:
        stripped = line.strip()
        if stripped.startswith("#"):
            heading = stripped.lstrip("#").strip()
            if heading:
                return heading[:160]
    return fallback


def _unescape_pdf_literal(raw: bytes) -> str:
    out = bytearray()
    i = 0
    n = len(raw)
    while i < n:
        ch = raw[i]
        if ch == 92 and i + 1 < n:  # backslash
            nxt = raw[i + 1]
            mapping = {
                ord("n"): 10,
                ord("r"): 13,
                ord("t"): 9,
                ord("b"): 8,
                ord("f"): 12,
                ord("("): 40,
                ord(")"): 41,
                ord("\\"): 92,
            }
            if nxt in mapping:
                out.append(mapping[nxt])
                i += 2
                continue
            if 48 <= nxt <= 55:  # octal
                j = i + 1
                digits = bytearray()
                while j < n and len(digits) < 3 and 48 <= raw[j] <= 55:
                    digits.append(raw[j])
                    j += 1
                out.append(int(digits.decode("ascii"), 8) & 0xFF)
                i = j
                continue
            out.append(nxt)
            i += 2
            continue
        out.append(ch)
        i += 1
    if out.startswith(b"\xfe\xff"):
        return out[2:].decode("utf-16-be", errors="ignore")
    if out.startswith(b"\xff\xfe"):
        return out[2:].decode("utf-16-le", errors="ignore")
    try:
        return out.decode("utf-8")
    except UnicodeDecodeError:
        return out.decode("latin-1", errors="ignore")


def _extract_pdf_text_minimal_fallback(pdf_bytes: bytes) -> list[str]:
    """零外部依赖极简 PDF 文本流抽取器（仅作未安装 pypdf 时的基础文本 PDF 兜底）。"""
    if b"/Encrypt" in pdf_bytes:
        raise ValueError("该 PDF 已加密，请先解除密码保护后再导入")

    streams: list[bytes] = []
    for match in re.finditer(rb"stream\r?\n(.*?)\r?\nendstream", pdf_bytes, re.DOTALL):
        chunk = match.group(1)
        try:
            decompressed = zlib.decompress(chunk)
            streams.append(decompressed)
        except zlib.error:
            streams.append(chunk)

    extracted_pages: list[str] = []
    for stream in streams:
        if b"BT" not in stream or b"ET" not in stream:
            continue
        pieces: list[str] = []
        for bt_block in re.findall(rb"BT\b(.*?)\bET", stream, re.DOTALL):
            for lit in re.findall(rb"\((?:\\.|[^\\()])*\)", bt_block):
                text = _unescape_pdf_literal(lit[1:-1]).strip()
                if text:
                    pieces.append(text)
            for hex_match in re.findall(rb"<([0-9A-Fa-f\s]{4,})>", bt_block):
                hex_clean = re.sub(rb"\s+", b"", hex_match)
                if len(hex_clean) % 2 == 0:
                    try:
                        decoded = bytes.fromhex(hex_clean.decode("ascii"))
                        if decoded.startswith(b"\xfe\xff"):
                            txt = decoded[2:].decode("utf-16-be", errors="ignore").strip()
                        else:
                            txt = decoded.decode("utf-8", errors="ignore").strip()
                        if txt and sum(c.isprintable() for c in txt) / max(len(txt), 1) > 0.7:
                            pieces.append(txt)
                    except ValueError:
                        pass
        joined = " ".join(pieces).strip()
        if joined:
            extracted_pages.append(joined)
    return extracted_pages


def _extract_pdf_pages(path: Path) -> tuple[list[str], str]:
    """返回 (每页文本列表, 解析引擎标识)。"""
    try:
        from pypdf import PdfReader
    except ImportError:
        pages = _extract_pdf_text_minimal_fallback(path.read_bytes())
        if not pages:
            raise ValueError(
                "当前运行环境未安装 pypdf，且该 PDF 无法通过基础文本模式解析；请安装 BSD 许可依赖 pypdf>=5.0.0 后重试"
            )
        return pages, "fallback-minimal"

    try:
        reader = PdfReader(str(path))
    except Exception as exc:
        raise ValueError(f"无法打开 PDF 文件，可能已损坏：{exc}") from exc

    if reader.is_encrypted:
        try:
            decrypted = reader.decrypt("")
        except Exception:
            decrypted = 0
        if not decrypted:
            raise ValueError("该 PDF 已加密，请先解除密码保护后再导入")

    pages: list[str] = []
    for page in reader.pages:
        try:
            text = (page.extract_text() or "").strip()
        except Exception:
            text = ""
        pages.append(text)

    if not any(pages):
        raise ValueError("该 PDF 未检测到可提取文本，可能是纯扫描图片版 PDF，暂不支持 OCR 直出")
    return pages, "pypdf"


def parse_document_file(
    source: str | Path,
    *,
    original_name: str = "",
) -> tuple[TranscriptResult, dict[str, Any]]:
    """解析本地 PDF / Markdown / TXT 文件，返回 (TranscriptResult, 文档元数据)。"""
    path = Path(source)
    if not path.is_file():
        raise FileNotFoundError(f"本地文档不存在: {path}")

    suffix = path.suffix.lower()
    if suffix not in DOCUMENT_SUFFIXES:
        raise ValueError(f"不支持的文档格式: {suffix or '未知'}（仅支持 .pdf / .md / .txt）")

    fallback_title = Path(original_name).stem if original_name else path.stem

    if suffix == ".pdf":
        pages, engine = _extract_pdf_pages(path)
        page_count = len(pages)
        segments: list[TranscriptSegment] = []
        full_parts: list[str] = []
        total_chars = 0
        truncated = False

        for idx, page_text in enumerate(pages, start=1):
            cleaned = re.sub(r"\n{3,}", "\n\n", page_text).strip()
            if not cleaned:
                continue
            labeled = f"[第 {idx} 页]\n{cleaned}"
            if total_chars + len(labeled) > DOCUMENT_TEXT_LIMIT:
                remaining = DOCUMENT_TEXT_LIMIT - total_chars
                if remaining > 80:
                    partial = labeled[:remaining].strip()
                    full_parts.append(partial)
                    segments.extend(split_text_to_segments(partial, max_chars=1400))
                truncated = True
                break
            full_parts.append(labeled)
            segments.extend(split_text_to_segments(labeled, max_chars=1400))
            total_chars += len(labeled) + 2

        if not segments:
            raise ValueError("该 PDF 未提取到有效正文内容")

        full_text = "\n\n".join(full_parts)
        meta = {
            "title": fallback_title,
            "document_type": "pdf",
            "page_count": page_count,
            "parser_engine": engine,
            "text_length": len(full_text),
            "truncated": truncated,
            "post_context": f"本地 PDF 文档：{fallback_title}（共 {page_count} 页）",
        }
        return TranscriptResult(language="zh", full_text=full_text, segments=segments), meta

    # Markdown / TXT
    raw_text = _read_text_with_encoding_fallback(path)
    normalized = raw_text.replace("\r\n", "\n").replace("\r", "\n").strip()
    if not normalized:
        raise ValueError("文档内容为空，无法生成笔记")

    truncated = len(normalized) > DOCUMENT_TEXT_LIMIT
    retained = normalized[:DOCUMENT_TEXT_LIMIT]
    title = _extract_title_from_markdown(retained, fallback_title) if suffix in (".md", ".markdown") else fallback_title
    segments = split_text_to_segments(retained, max_chars=1200)
    doc_type = "markdown" if suffix in (".md", ".markdown") else "txt"
    meta = {
        "title": title,
        "document_type": doc_type,
        "page_count": None,
        "parser_engine": "text",
        "text_length": len(retained),
        "truncated": truncated,
        "post_context": f"本地 {doc_type.upper()} 文档：{title}",
    }
    return TranscriptResult(language="zh", full_text=retained, segments=segments), meta
