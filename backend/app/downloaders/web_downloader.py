"""通用网页技术文章下载器（博客 / 公众号 / Substack / GitHub README 等）。

复用了 app.services.web_page.read_article_page 的 SSRF / 公网 IP 校验与全局代理能力，
归类为 media_kind="text_post"，免音视频下载与语音转写，直出结构化笔记。
"""

from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any, Optional, Union
from urllib.parse import urlsplit

from app.downloaders.base import Downloader
from app.enmus.note_enums import DownloadQuality
from app.models.audio_model import AudioDownloadResult
from app.models.transcriber_model import TranscriptResult, TranscriptSegment
from app.services.web_page import read_article_page
from app.utils.logger import get_logger

logger = get_logger(__name__)


def split_text_to_segments(text: str, max_chars: int = 1200) -> list[TranscriptSegment]:
    """按自然段落将文章正文切分为合理长度的文本分段，保留标题与代码块完整性。"""
    cleaned = str(text or "").strip()
    if not cleaned:
        return []
    paragraphs = [p.strip() for p in cleaned.split("\n\n") if p.strip()]
    segments: list[TranscriptSegment] = []
    bucket: list[str] = []
    bucket_len = 0

    for para in paragraphs:
        if bucket and bucket_len + len(para) + 2 > max_chars:
            segments.append(TranscriptSegment(start=0.0, end=0.0, text="\n\n".join(bucket)))
            bucket = []
            bucket_len = 0
        if len(para) > max_chars * 2:
            if bucket:
                segments.append(TranscriptSegment(start=0.0, end=0.0, text="\n\n".join(bucket)))
                bucket = []
                bucket_len = 0
            for start in range(0, len(para), max_chars):
                chunk = para[start : start + max_chars].strip()
                if chunk:
                    segments.append(TranscriptSegment(start=0.0, end=0.0, text=chunk))
            continue
        bucket.append(para)
        bucket_len += len(para) + 2

    if bucket:
        segments.append(TranscriptSegment(start=0.0, end=0.0, text="\n\n".join(bucket)))

    return segments or [TranscriptSegment(start=0.0, end=0.0, text=cleaned)]


def _article_id(final_url: str) -> str:
    return hashlib.sha256(str(final_url or "").encode("utf-8")).hexdigest()[:16]


def _build_article_post_context(article: dict[str, Any]) -> str:
    lines: list[str] = []
    title = str(article.get("title") or "").strip()
    author = str(article.get("author") or "").strip()
    final_url = str(article.get("final_url") or article.get("url") or "").strip()
    desc = str(article.get("description") or "").strip()
    if title:
        lines.append(f"文章标题：{title}")
    if author:
        lines.append(f"作者 / 来源：{author}")
    if final_url:
        lines.append(f"原文链接：{final_url}")
    if desc and desc not in title:
        lines.append(f"文章摘要：{desc[:600]}")
    return "\n".join(lines).strip()


class WebArticleDownloader(Downloader):
    """通用公开网页文章处理器（media_kind="text_post"，免下载免转写）。"""

    def __init__(self):
        super().__init__()
        self._cache: dict[str, dict[str, Any]] = {}

    def is_text_post(self, video_url: str) -> bool:
        return True

    def _get_article(self, url: str) -> dict[str, Any]:
        key = str(url or "").strip()
        if key not in self._cache:
            article = read_article_page(key, use_proxy=True)
            # 控制内存缓存体积
            if len(self._cache) >= 32:
                self._cache.pop(next(iter(self._cache)))
            self._cache[key] = article
        return self._cache[key]

    def download_subtitles(
        self,
        video_url: str,
        output_dir: Union[str, None] = None,
        langs: Optional[list[str]] = None,
    ) -> Optional[TranscriptResult]:
        article = self._get_article(video_url)
        text = str(article.get("text") or "").strip()
        if not text:
            return None
        header = _build_article_post_context(article)
        full_text = f"{header}\n\n{text}".strip() if header else text
        segments = split_text_to_segments(text)
        return TranscriptResult(
            language="zh",
            full_text=full_text,
            segments=segments,
        )

    def download_video(self, video_url: str, output_dir: Union[str, None] = None) -> Optional[str]:
        return None

    def download(
        self,
        video_url: str,
        output_dir: Union[str, None] = None,
        quality: DownloadQuality = "fast",
        need_video: Optional[bool] = False,
        skip_download: bool = False,
    ) -> AudioDownloadResult:
        article = self._get_article(video_url)
        final_url = str(article.get("final_url") or video_url)
        vid = _article_id(final_url)
        host = (urlsplit(final_url).hostname or "").lower()
        if host.startswith("www."):
            host = host[4:]
        author = str(article.get("author") or host or "网页文章").strip()
        title = str(article.get("title") or host or "网页文章").strip()
        post_context = _build_article_post_context(article)

        logger.info("网页文章解析完成: chars=%d, url=%s", len(article.get("text") or ""), final_url)
        return AudioDownloadResult(
            file_path="",
            title=title,
            duration=0.0,
            cover_url="",
            platform="web",
            video_id=vid,
            raw_info={
                "media_kind": "text_post",
                "source_kind": "web_article",
                "uploader": author,
                "webpage_url": final_url,
                "post_context": post_context,
                "text_length": int(article.get("retained_length") or len(article.get("text") or "")),
                "truncated": bool(article.get("truncated")),
            },
            video_path=None,
        )
