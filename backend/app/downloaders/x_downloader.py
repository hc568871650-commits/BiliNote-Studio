"""X (原 Twitter) 双通道内容提取器。

支持形态：
1. 视频推文 / Broadcast / Spaces：走 yt-dlp（透传全局代理 + 可选临时 Netscape Cookie），
   同时融合推文正文与引用推文作为 post_context 背景上下文。
2. 纯图文推文 / X Article 长文：无音视频流时自动降级提取正文、引用推文与长文块，
   直接产出 TranscriptResult 跳过下载与转写；配图经全局代理本地化至静态目录，
   供视觉理解与结构化插图复用（全程零 FFmpeg 依赖）。
"""

from __future__ import annotations

import base64
from contextlib import contextmanager
import io
import json
import logging
import math
import mimetypes
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import threading
import time
from typing import Any, Iterator, List, Optional, Union
from urllib.parse import urlparse

import requests

from app.downloaders.base import Downloader, DownloadQuality, YDL_RETRY_OPTS
from app.models.notes_model import AudioDownloadResult
from app.models.transcriber_model import TranscriptResult, TranscriptSegment
from app.services.cookie_manager import CookieConfigManager
from app.services.proxy_config_manager import ProxyConfigManager
from app.utils.path_helper import get_data_dir
from app.utils.url_parser import extract_video_id, normalize_video_url, resolve_x_short_url

logger = logging.getLogger(__name__)

_REQUEST_TIMEOUT = 15
_MAX_IMAGE_COUNT = 6
_MAX_IMAGE_BYTES = 10 * 1024 * 1024
_MAX_CONCAT_CLIPS = 4
_MAX_CONCAT_TOTAL_SECONDS = 600.0
_MAX_QUOTE_VIDEO_SECONDS = 180.0
_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)
_PAYLOAD_CACHE_TTL = 180.0


class XPlatformError(RuntimeError):
    """面向用户展示清晰排查指引的 X 平台错误。"""


def classify_x_error(exc: Exception) -> str:
    """将底层网络/yt-dlp/HTTP 异常归类为可操作的中文下一步提示。"""
    raw = str(exc or "").strip()
    low = raw.lower()

    if isinstance(exc, XPlatformError):
        return raw

    network_tokens = (
        "timed out",
        "timeout",
        "connection reset",
        "connection aborted",
        "connection refused",
        "failed to establish a new connection",
        "proxyerror",
        "max retries exceeded",
        "remote disconnected",
        "eof occurred in violation of protocol",
        "ssl",
        "unable to download webpage",
        "name or service not known",
        "getaddrinfo failed",
    )
    if any(tok in low for tok in network_tokens):
        return (
            "连接 X (Twitter) 失败或超时，请检查「设置 → 视频下载 → 全局代理」"
            "是否已开启且代理可用后重试。"
        )

    auth_tokens = (
        "nsfw",
        "age-restricted",
        "age restricted",
        "login required",
        "sign in",
        "log in",
        "protected",
        "authorization",
        "unauthorized",
        "forbidden",
        "http error 401",
        "http error 403",
        "status 401",
        "status 403",
        "cookies",
        "not authorized",
        "private",
    )
    if any(tok in low for tok in auth_tokens):
        return (
            "该 X 内容需要登录、属于受保护账号或存在年龄限制，"
            "请在「设置 → 视频下载 → 平台凭据 → X (Twitter)」配置 Cookie 后重试。"
        )

    not_found_tokens = (
        "http error 404",
        "status 404",
        "not found",
        "does not exist",
        "no status found",
        "tweet unavailable",
        "has been deleted",
        "suspended",
        "unavailable",
    )
    if any(tok in low for tok in not_found_tokens):
        return "该 X 链接对应的推文不存在、已被删除或账号不可访问，请核对链接是否有效。"

    if "no video could be found" in low or "no formats" in low:
        return (
            "未能读取该 X 推文内容（推文可能不存在、已删除，或受登录/隐私限制），"
            "请核对链接有效性，或在「设置 → 视频下载 → 平台凭据 → X (Twitter)」配置 Cookie 后重试。"
        )

    return f"获取 X (Twitter) 内容失败：{raw}"


def cookie_header_to_netscape(cookie_header: str) -> str:
    """将浏览器 Cookie 请求头（auth_token=...; ct0=...）转换为标准 Netscape cookies.txt。

    如果输入本身已经是 Netscape Cookie 文件格式，则原样保留。
    """
    raw = str(cookie_header or "").strip()
    if not raw:
        return ""
    if raw.startswith("# Netscape HTTP Cookie File") or raw.startswith("# HTTP Cookie File"):
        return raw if raw.endswith("\n") else raw + "\n"

    # 允许用户误粘贴开头的 "Cookie:" 前缀
    if raw.lower().startswith("cookie:"):
        raw = raw.split(":", 1)[1].strip()

    pairs: list[tuple[str, str]] = []
    seen: set[str] = set()
    for part in raw.split(";"):
        chunk = part.strip()
        if not chunk or "=" not in chunk:
            continue
        name, value = chunk.split("=", 1)
        name = name.strip()
        value = value.strip()
        if not name or not value or name in seen:
            continue
        if any(ch in name for ch in ("\r", "\n", "\t")):
            continue
        value = value.replace("\r", "").replace("\n", "")
        seen.add(name)
        pairs.append((name, value))

    if not pairs:
        return ""

    expiry = str(int(time.time()) + 365 * 24 * 3600)
    lines = ["# Netscape HTTP Cookie File", "# Generated at runtime by BiliNote Studio"]
    for domain in (".x.com", ".twitter.com"):
        for name, value in pairs:
            lines.append(f"{domain}\tTRUE\t/\tTRUE\t{expiry}\t{name}\t{value}")
    return "\n".join(lines) + "\n"


@contextmanager
def _temp_cookie_file(cookie_header: Optional[str]) -> Iterator[Optional[str]]:
    """运行时生成临时 Netscape cookiefile，退出即安全清理。"""
    content = cookie_header_to_netscape(cookie_header or "")
    if not content:
        yield None
        return

    fd, tmp_path = tempfile.mkstemp(prefix="bilinote_x_ck_", suffix=".txt")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(content)
        yield tmp_path
    finally:
        try:
            if os.path.exists(tmp_path):
                os.unlink(tmp_path)
        except OSError:
            pass


def _syndication_token(tweet_id: str) -> str:
    try:
        val = (int(tweet_id) / 1e15) * math.pi
        digits = "0123456789abcdefghijklmnopqrstuvwxyz"
        int_part = int(val)
        frac = val - int_part
        out = []
        if int_part == 0:
            out.append("0")
        else:
            n = int_part
            while n > 0:
                out.append(digits[n % 36])
                n //= 36
            out.reverse()
        frac_chars = []
        for _ in range(8):
            frac *= 36
            d = int(frac)
            frac_chars.append(digits[d])
            frac -= d
        token = ("".join(out) + "".join(frac_chars)).replace("0", "")
        return token or "1"
    except Exception:
        return "1"


def _extract_screen_name_and_kind(url: str) -> tuple[str, str, Optional[str]]:
    """从规范化后的 X URL 提取 (screen_name_or_i, path_kind, item_id)。"""
    parsed = urlparse(url)
    path = parsed.path or ""
    if re.search(r"/i/broadcasts/([\w-]+)", path, re.IGNORECASE):
        m = re.search(r"/i/broadcasts/([\w-]+)", path, re.IGNORECASE)
        return "i", "broadcast", m.group(1) if m else None
    if re.search(r"/i/spaces/([\w-]+)", path, re.IGNORECASE):
        m = re.search(r"/i/spaces/([\w-]+)", path, re.IGNORECASE)
        return "i", "space", m.group(1) if m else None

    m = re.search(r"^/([^/]+)/(status|statuses|article|articles)/(\d+)", path, re.IGNORECASE)
    if m:
        screen_name = m.group(1)
        raw_kind = m.group(2).lower()
        kind = "article" if raw_kind.startswith("article") else "status"
        return screen_name, kind, m.group(3)

    m_web = re.search(r"^/i/(?:web/)?(status|statuses|article|articles)/(\d+)", path, re.IGNORECASE)
    if m_web:
        raw_kind = m_web.group(1).lower()
        kind = "article" if raw_kind.startswith("article") else "status"
        return "i", kind, m_web.group(2)

    return "i", "status", extract_video_id(url, "x")


def _extract_article_text(article_obj: Any) -> tuple[str, str, list[str]]:
    """从 fxtwitter 的 tweet.article 结构中抽取标题、正文段落和插图 URL。"""
    if not isinstance(article_obj, dict):
        return "", "", []

    title = str(article_obj.get("title") or "").strip()
    paragraphs: list[str] = []
    images: list[str] = []

    cover = article_obj.get("cover_media")
    if isinstance(cover, dict):
        cover_info = cover.get("media_info") if isinstance(cover.get("media_info"), dict) else cover
        cover_url = cover_info.get("original_img_url") or cover_info.get("url")
        if isinstance(cover_url, str) and cover_url.startswith("http"):
            images.append(cover_url)

    content = article_obj.get("content")
    blocks = content.get("blocks") if isinstance(content, dict) else article_obj.get("blocks")
    if isinstance(blocks, list):
        for block in blocks:
            if not isinstance(block, dict):
                continue
            text = str(block.get("text") or "").strip()
            if text:
                paragraphs.append(text)
    elif isinstance(article_obj.get("preview_text"), str) and article_obj["preview_text"].strip():
        paragraphs.append(article_obj["preview_text"].strip())

    media_entities = article_obj.get("media_entities")
    if isinstance(media_entities, list):
        for entity in media_entities:
            if not isinstance(entity, dict):
                continue
            info = entity.get("media_info") if isinstance(entity.get("media_info"), dict) else entity
            img_url = info.get("original_img_url") or info.get("url")
            if isinstance(img_url, str) and img_url.startswith("http") and img_url not in images:
                images.append(img_url)

    return title, "\n\n".join(paragraphs).strip(), images


def _parse_fxtwitter_tweet(tweet: dict, fallback_url: str, fallback_id: str) -> dict[str, Any]:
    author_obj = tweet.get("author") if isinstance(tweet.get("author"), dict) else {}
    author_name = str(author_obj.get("name") or "").strip()
    author_handle = str(author_obj.get("screen_name") or "").strip()
    author_label = f"{author_name} (@{author_handle})" if author_name and author_handle else (author_name or (f"@{author_handle}" if author_handle else "X 用户"))

    text = str(tweet.get("text") or "").strip()
    article_title, article_text, article_images = _extract_article_text(tweet.get("article"))

    quote_obj = tweet.get("quote") if isinstance(tweet.get("quote"), dict) else None
    quoted_tweet = ""
    quote_author_handle = ""
    quote_has_video = False
    quote_video_duration = 0
    quote_cover_url = ""
    if quote_obj:
        q_author = quote_obj.get("author") if isinstance(quote_obj.get("author"), dict) else {}
        quote_author_handle = str(q_author.get("screen_name") or "").strip()
        q_handle = quote_author_handle or str(q_author.get("name") or "").strip()
        q_text = str(quote_obj.get("text") or "").strip()
        if q_text:
            quoted_tweet = f"@{q_handle}: {q_text}" if q_handle else q_text
        q_media = quote_obj.get("media") if isinstance(quote_obj.get("media"), dict) else {}
        q_videos = q_media.get("videos") if isinstance(q_media.get("videos"), list) else []
        q_all = q_media.get("all") if isinstance(q_media.get("all"), list) else []
        quote_has_video = bool(q_videos) or any(
            isinstance(item, dict) and str(item.get("type") or "").lower() in ("video", "gif", "animated_gif")
            for item in q_all
        )
        if q_videos and isinstance(q_videos[0], dict):
            quote_cover_url = str(q_videos[0].get("thumbnail_url") or "").strip()
            try:
                quote_video_duration = int(round(float(q_videos[0].get("duration") or 0)))
            except (TypeError, ValueError):
                quote_video_duration = 0

    media = tweet.get("media") if isinstance(tweet.get("media"), dict) else {}
    videos = media.get("videos") if isinstance(media.get("videos"), list) else []
    photos = media.get("photos") if isinstance(media.get("photos"), list) else []
    all_media = media.get("all") if isinstance(media.get("all"), list) else []

    main_video_items = [
        item for item in all_media
        if isinstance(item, dict) and str(item.get("type") or "").lower() in ("video", "gif", "animated_gif")
    ]
    main_video_count = max(len(videos), len(main_video_items))
    main_has_video = main_video_count > 0
    has_video = main_has_video or quote_has_video
    is_self_quote = bool(
        author_handle
        and quote_author_handle
        and author_handle.lower() == quote_author_handle.lower()
    )

    images: list[str] = []
    for photo in photos:
        if isinstance(photo, dict):
            url = photo.get("url")
            if isinstance(url, str) and url.startswith("http") and url not in images:
                images.append(url)
    for url in article_images:
        if url not in images:
            images.append(url)

    cover_url = ""
    if videos and isinstance(videos[0], dict):
        cover_url = str(videos[0].get("thumbnail_url") or "").strip()
    if not cover_url and quote_cover_url:
        cover_url = quote_cover_url
    if not cover_url and images:
        cover_url = images[0]
    if not cover_url and isinstance(author_obj.get("avatar_url"), str):
        cover_url = author_obj["avatar_url"]

    tweet_id = str(tweet.get("id") or fallback_id or "").strip()
    canonical_url = str(tweet.get("url") or fallback_url).strip()
    if canonical_url:
        canonical_url = normalize_video_url(canonical_url)

    base_title = article_title or (text.splitlines()[0].strip() if text else "")
    if len(base_title) > 68:
        base_title = base_title[:67].rstrip() + "…"
    title = base_title or f"X 推文 {tweet_id}"
    if author_handle and not title.startswith(f"@{author_handle}") and not article_title:
        title = f"@{author_handle}: {title}"

    duration = 0
    if videos and isinstance(videos[0], dict):
        try:
            duration = int(round(float(videos[0].get("duration") or 0)))
        except (TypeError, ValueError):
            duration = 0
    elif quote_video_duration:
        duration = quote_video_duration

    return {
        "tweet_id": tweet_id,
        "author": author_label,
        "author_handle": author_handle,
        "title": title,
        "text": text,
        "quoted_tweet": quoted_tweet,
        "quote_author_handle": quote_author_handle,
        "is_self_quote": is_self_quote,
        "main_has_video": main_has_video,
        "main_video_count": main_video_count,
        "quote_has_video": quote_has_video,
        "quote_video_duration": quote_video_duration,
        "article_title": article_title,
        "article_text": article_text,
        "media_type": "video" if has_video else "text_image",
        "has_video": has_video,
        "has_audio": False,
        "duration": duration,
        "images": images,
        "cover_url": cover_url,
        "canonical_url": canonical_url or fallback_url,
        "created_at": str(tweet.get("created_at") or "").strip(),
    }


def _parse_syndication_tweet(data: dict, fallback_url: str, fallback_id: str) -> dict[str, Any]:
    user = data.get("user") if isinstance(data.get("user"), dict) else {}
    author_name = str(user.get("name") or "").strip()
    author_handle = str(user.get("screen_name") or "").strip()
    author_label = f"{author_name} (@{author_handle})" if author_name and author_handle else (author_name or (f"@{author_handle}" if author_handle else "X 用户"))

    text = str(data.get("text") or "").strip()
    note_tweet = data.get("note_tweet")
    if isinstance(note_tweet, dict):
        nt_text = str(note_tweet.get("text") or "").strip()
        if len(nt_text) > len(text):
            text = nt_text

    quoted_tweet = ""
    quote_author_handle = ""
    quote_has_video = False
    q = data.get("quoted_tweet") if isinstance(data.get("quoted_tweet"), dict) else None
    if q:
        q_user = q.get("user") if isinstance(q.get("user"), dict) else {}
        quote_author_handle = str(q_user.get("screen_name") or "").strip()
        q_text = str(q.get("text") or "").strip()
        if q_text:
            quoted_tweet = f"@{quote_author_handle}: {q_text}" if quote_author_handle else q_text
        if q.get("video"):
            quote_has_video = True
        else:
            for q_media in q.get("mediaDetails") or []:
                if isinstance(q_media, dict) and str(q_media.get("type") or "").lower() in ("video", "animated_gif"):
                    quote_has_video = True
                    break

    main_video_count = 0
    if data.get("video"):
        main_video_count = 1
    images: list[str] = []
    for photo in data.get("photos") or []:
        if isinstance(photo, dict) and isinstance(photo.get("url"), str):
            images.append(photo["url"])
    media_video_count = 0
    for media in data.get("mediaDetails") or []:
        if not isinstance(media, dict):
            continue
        mtype = str(media.get("type") or "").lower()
        if mtype in ("video", "animated_gif"):
            media_video_count += 1
        elif mtype == "photo":
            murl = media.get("media_url_https") or media.get("media_url")
            if isinstance(murl, str) and murl not in images:
                images.append(murl)
    main_video_count = max(main_video_count, media_video_count)
    main_has_video = main_video_count > 0
    has_video = main_has_video or quote_has_video
    is_self_quote = bool(
        author_handle
        and quote_author_handle
        and author_handle.lower() == quote_author_handle.lower()
    )

    cover_url = ""
    video_obj = data.get("video") if isinstance(data.get("video"), dict) else {}
    if isinstance(video_obj.get("poster"), str):
        cover_url = video_obj["poster"]
    elif images:
        cover_url = images[0]

    tweet_id = str(data.get("id_str") or fallback_id or "").strip()
    first_line = text.splitlines()[0].strip() if text else ""
    if len(first_line) > 68:
        first_line = first_line[:67].rstrip() + "…"
    title = first_line or f"X 推文 {tweet_id}"
    if author_handle and not title.startswith(f"@{author_handle}"):
        title = f"@{author_handle}: {title}"

    return {
        "tweet_id": tweet_id,
        "author": author_label,
        "author_handle": author_handle,
        "title": title,
        "text": text,
        "quoted_tweet": quoted_tweet,
        "quote_author_handle": quote_author_handle,
        "is_self_quote": is_self_quote,
        "main_has_video": main_has_video,
        "main_video_count": main_video_count,
        "quote_has_video": quote_has_video,
        "quote_video_duration": 0,
        "article_title": "",
        "article_text": "",
        "media_type": "video" if has_video else "text_image",
        "has_video": has_video,
        "has_audio": False,
        "duration": 0,
        "images": images,
        "cover_url": cover_url,
        "canonical_url": normalize_video_url(fallback_url),
        "created_at": str(data.get("created_at") or "").strip(),
    }


def fetch_x_post_payload(
    video_url: str,
    *,
    proxy_url: Optional[str] = None,
    cookie_header: Optional[str] = None,
) -> dict[str, Any]:
    """抓取 X 推文/长文的轻量结构化元数据（走全局代理 + 严格超时）。"""
    cleaned = normalize_video_url(video_url)
    parsed = urlparse(cleaned)
    if (parsed.hostname or "").lower() == "t.co":
        resolved = resolve_x_short_url(cleaned, proxy_url=proxy_url)
        if resolved:
            cleaned = normalize_video_url(resolved)

    screen_name, path_kind, item_id = _extract_screen_name_and_kind(cleaned)
    if not item_id:
        raise XPlatformError("无法从该 X 链接中识别推文或直播 ID，请检查链接是否完整。")

    if path_kind in ("broadcast", "space"):
        return {
            "tweet_id": item_id,
            "author": "X Live",
            "author_handle": "",
            "title": f"X {'Spaces' if path_kind == 'space' else 'Broadcast'} {item_id}",
            "text": "",
            "quoted_tweet": "",
            "article_title": "",
            "article_text": "",
            "media_type": "audio" if path_kind == "space" else "video",
            "has_video": path_kind == "broadcast",
            "has_audio": path_kind == "space",
            "duration": 0,
            "images": [],
            "cover_url": "",
            "canonical_url": cleaned,
            "created_at": "",
        }

    proxies = {"http": proxy_url, "https": proxy_url} if proxy_url else None
    headers = {"User-Agent": _USER_AGENT, "Accept": "application/json"}

    last_error: Optional[Exception] = None

    # 通道 1：fxtwitter 公开 API（支持正文、引用推文、X Article 长文与媒体清单）
    fx_url = f"https://api.fxtwitter.com/{screen_name}/status/{item_id}"
    try:
        resp = requests.get(fx_url, headers=headers, proxies=proxies, timeout=_REQUEST_TIMEOUT)
        if resp.status_code == 200:
            body = resp.json()
            tweet = body.get("tweet") if isinstance(body, dict) else None
            if isinstance(tweet, dict):
                return _parse_fxtwitter_tweet(tweet, cleaned, item_id)
        elif resp.status_code == 404:
            last_error = RuntimeError("HTTP error 404: tweet not found")
        elif resp.status_code in (401, 403):
            last_error = RuntimeError(f"HTTP error {resp.status_code}: protected or login required")
        else:
            last_error = RuntimeError(f"fxtwitter status {resp.status_code}")
    except Exception as exc:
        last_error = exc
        logger.debug("fxtwitter 元数据请求失败，尝试回退 syndication: %s", type(exc).__name__)

    # 通道 2：X Syndication API 回退
    syn_url = (
        f"https://cdn.syndication.twimg.com/tweet-result"
        f"?id={item_id}&lang=zh-cn&token={_syndication_token(item_id)}"
    )
    try:
        syn_headers = dict(headers)
        if cookie_header:
            syn_headers["Cookie"] = cookie_header.strip()
        resp = requests.get(syn_url, headers=syn_headers, proxies=proxies, timeout=_REQUEST_TIMEOUT)
        if resp.status_code == 200:
            body = resp.json()
            if isinstance(body, dict) and (body.get("text") or body.get("mediaDetails") or body.get("video")):
                return _parse_syndication_tweet(body, cleaned, item_id)
            if isinstance(body, dict) and body.get("__typename") == "TweetTombstone":
                raise XPlatformError(
                    "该 X 推文不可访问（可能已删除、受保护或需要登录），"
                    "如为登录可见内容请在「设置 → 视频下载 → 平台凭据 → X (Twitter)」配置 Cookie 后重试。"
                )
        elif resp.status_code == 404:
            last_error = RuntimeError("HTTP error 404: tweet not found")
        elif resp.status_code in (401, 403):
            last_error = RuntimeError(f"HTTP error {resp.status_code}: login required")
    except XPlatformError:
        raise
    except Exception as exc:
        last_error = exc
        logger.debug("X syndication 元数据请求失败: %s", type(exc).__name__)

    if last_error is not None:
        raise XPlatformError(classify_x_error(last_error)) from last_error

    raise XPlatformError("未能读取该 X 推文内容，请检查链接有效性或代理/Cookie 配置。")


def _guess_image_ext(url: str, content_type: str) -> str:
    ctype = (content_type or "").split(";", 1)[0].strip().lower()
    mapping = {
        "image/jpeg": "jpg",
        "image/jpg": "jpg",
        "image/png": "png",
        "image/webp": "webp",
        "image/gif": "gif",
    }
    if ctype in mapping:
        return mapping[ctype]
    suffix = Path(urlparse(url).path).suffix.lstrip(".").lower()
    if suffix in ("jpg", "jpeg", "png", "webp", "gif"):
        return "jpg" if suffix == "jpeg" else suffix
    return "jpg"


def _resolve_screenshots_dir(output_dir: Optional[Union[str, Path]] = None) -> Path:
    if output_dir is not None:
        target = Path(output_dir)
    else:
        env_dir = os.getenv("OUT_DIR")
        if env_dir:
            target = Path(env_dir)
        else:
            try:
                from app.core.runtime import get_runtime
                target = get_runtime().screenshot_dir
            except Exception:
                target = Path("./static/screenshots")
    target.mkdir(parents=True, exist_ok=True)
    return target


def localize_x_images(
    image_urls: list[str],
    tweet_id: str,
    *,
    output_dir: Optional[Union[str, Path]] = None,
    proxy_url: Optional[str] = None,
    max_images: int = _MAX_IMAGE_COUNT,
) -> list[dict[str, Any]]:
    """经全局代理将推文配图落盘至静态截图目录，永久防止外链失效。"""
    if not image_urls or not tweet_id:
        return []

    safe_id = re.sub(r"[^0-9A-Za-z_-]+", "_", str(tweet_id))[:48] or "tweet"
    target_dir = _resolve_screenshots_dir(output_dir)
    image_base_url = os.getenv("IMAGE_BASE_URL", "/static/screenshots").rstrip("/")
    proxies = {"http": proxy_url, "https": proxy_url} if proxy_url else None
    headers = {"User-Agent": _USER_AGENT}

    localized: list[dict[str, Any]] = []
    for idx, img_url in enumerate(image_urls[:max_images], 1):
        if not isinstance(img_url, str) or not img_url.startswith(("http://", "https://")):
            continue
        try:
            resp = requests.get(img_url, headers=headers, proxies=proxies, timeout=_REQUEST_TIMEOUT, stream=True)
            if resp.status_code != 200:
                resp.close()
                continue
            ctype = resp.headers.get("Content-Type", "")
            if ctype and not ctype.lower().startswith("image/"):
                resp.close()
                continue
            chunks: list[bytes] = []
            total = 0
            too_large = False
            for chunk in resp.iter_content(chunk_size=65536):
                if not chunk:
                    continue
                total += len(chunk)
                if total > _MAX_IMAGE_BYTES:
                    too_large = True
                    break
                chunks.append(chunk)
            resp.close()
            if too_large or total == 0:
                continue

            ext = _guess_image_ext(img_url, ctype)
            filename = f"x_{safe_id}_{idx}.{ext}"
            local_path = target_dir / filename
            local_path.write_bytes(b"".join(chunks))
            localized.append({
                "index": idx,
                "filename": filename,
                "local_path": str(local_path),
                "web_url": f"{image_base_url}/{filename}",
                "caption": f"推文配图 {idx}",
            })
        except Exception as exc:
            logger.warning("X 配图本地化失败 (idx=%d): %s", idx, type(exc).__name__)
            continue
    return localized


def encode_local_image_data_url(image_path: Union[str, Path], *, max_side: int = 1600) -> Optional[str]:
    """将本地图片编码为 Data URL（优先 Pillow 轻量缩放，零 FFmpeg 依赖）。"""
    path = Path(image_path)
    if not path.is_file() or path.stat().st_size == 0:
        return None
    try:
        from PIL import Image

        with Image.open(path) as img:
            if img.mode not in ("RGB", "L"):
                img = img.convert("RGB")
            w, h = img.size
            if max(w, h) > max_side:
                ratio = max_side / float(max(w, h))
                img = img.resize((max(1, int(w * ratio)), max(1, int(h * ratio))))
            buf = io.BytesIO()
            img.save(buf, format="JPEG", quality=82, optimize=True)
            encoded = base64.b64encode(buf.getvalue()).decode("ascii")
            return f"data:image/jpeg;base64,{encoded}"
    except Exception:
        try:
            mime, _ = mimetypes.guess_type(str(path))
            mime = mime if mime and mime.startswith("image/") else "image/jpeg"
            encoded = base64.b64encode(path.read_bytes()).decode("ascii")
            return f"data:{mime};base64,{encoded}"
        except Exception:
            return None


def build_x_post_context(payload: dict[str, Any]) -> str:
    """组装推文正文 + 引用推文背景上下文，供视频总结或纯图文补充参考。"""
    parts: list[str] = []
    author = str(payload.get("author") or "").strip()
    if author:
        parts.append(f"作者：{author}")
    text = str(payload.get("text") or "").strip()
    if text:
        parts.append(f"推文正文：\n{text}")
    article_title = str(payload.get("article_title") or "").strip()
    article_text = str(payload.get("article_text") or "").strip()
    if article_title:
        parts.append(f"X 长文标题：{article_title}")
    if article_text:
        parts.append(f"X 长文正文：\n{article_text}")
    quoted = str(payload.get("quoted_tweet") or "").strip()
    if quoted:
        parts.append(f"引用推文：\n{quoted}")
    return "\n\n".join(parts).strip()


def build_text_post_transcript(
    payload: dict[str, Any],
    local_images: Optional[list[dict[str, Any]]] = None,
) -> Optional[TranscriptResult]:
    """将纯图文推文 / X 长文按自然段组装为 TranscriptResult（跳过下载与语音转写）。"""
    raw_blocks: list[str] = []
    author = str(payload.get("author") or "").strip()
    article_title = str(payload.get("article_title") or "").strip()
    article_text = str(payload.get("article_text") or "").strip()
    text = str(payload.get("text") or "").strip()
    quoted = str(payload.get("quoted_tweet") or "").strip()

    if author:
        raw_blocks.append(f"作者：{author}")
    if article_title:
        raw_blocks.append(f"长文标题：{article_title}")
    if text:
        for para in re.split(r"\n{2,}", text):
            cleaned = para.strip()
            if cleaned:
                raw_blocks.append(cleaned)
    if article_text:
        for para in re.split(r"\n{2,}", article_text):
            cleaned = para.strip()
            if cleaned and cleaned not in raw_blocks:
                raw_blocks.append(cleaned)
    if quoted:
        raw_blocks.append(f"引用推文：{quoted}")

    if local_images:
        raw_blocks.append(f"（本推文附带 {len(local_images)} 张原帖配图）")

    if not raw_blocks:
        return None

    segments = [
        TranscriptSegment(start=0.0, end=0.0, text=block)
        for block in raw_blocks
    ]
    full_text = "\n\n".join(raw_blocks)
    # 粗略检测语言标签用于元信息展示
    has_cjk = bool(re.search(r"[\u4e00-\u9fff]", full_text))
    return TranscriptResult(
        language="zh" if has_cjk else "en",
        full_text=full_text,
        segments=segments,
    )


def _safe_media_id(raw_id: str) -> str:
    return re.sub(r"[^0-9A-Za-z_-]+", "_", str(raw_id or "")).strip("_")[:64] or "x_media"


def _format_mmss(seconds: float) -> str:
    sec = max(0, int(round(float(seconds or 0.0))))
    mins, rem = divmod(sec, 60)
    hours, mins = divmod(mins, 60)
    if hours:
        return f"{hours:02d}:{mins:02d}:{rem:02d}"
    return f"{mins:02d}:{rem:02d}"


def _unwrap_ydl_entries(info: Any) -> list[dict[str, Any]]:
    """将 yt-dlp 返回结果解包为实际媒体条目列表（兼容 _type='playlist' 多视频推文）。"""
    if not isinstance(info, dict):
        return []
    raw_entries = info.get("entries")
    if isinstance(raw_entries, list) and raw_entries:
        entries = [entry for entry in raw_entries if isinstance(entry, dict)]
        if entries:
            return entries
    return [info]


def _resolve_entry_filepath(
    entry: dict[str, Any],
    output_dir: str,
    *,
    fallback_ext: str = "mp4",
    part_prefix: Optional[str] = None,
) -> Optional[str]:
    """从 yt-dlp 条目中定位真实落盘路径（优先 requested_downloads，再查常见命名）。"""
    req_downloads = entry.get("requested_downloads") or []
    if isinstance(req_downloads, list):
        for item in req_downloads:
            if not isinstance(item, dict):
                continue
            for key in ("filepath", "filename"):
                fp = item.get(key)
                if isinstance(fp, str) and fp and os.path.isfile(fp) and os.path.getsize(fp) > 0:
                    return fp

    for key in ("filepath", "_filename"):
        fp = entry.get(key)
        if isinstance(fp, str) and fp and os.path.isfile(fp) and os.path.getsize(fp) > 0:
            return fp

    entry_id = str(entry.get("id") or "").strip()
    ext = str(entry.get("ext") or fallback_ext).lstrip(".")
    candidates: list[str] = []
    if entry_id:
        candidates.append(os.path.join(output_dir, f"x_{entry_id}.{ext}"))
        if fallback_ext and ext != fallback_ext:
            candidates.append(os.path.join(output_dir, f"x_{entry_id}.{fallback_ext}"))
        if part_prefix:
            for p in sorted(Path(output_dir).glob(f"{part_prefix}*{entry_id}*")):
                if p.is_file() and p.stat().st_size > 0 and p.suffix.lower() not in (".part", ".ytdl", ".json"):
                    candidates.append(str(p))

    for fp in candidates:
        if os.path.isfile(fp) and os.path.getsize(fp) > 0:
            return fp
    return None


def _should_allow_multi_clip(payload: Optional[dict[str, Any]]) -> bool:
    """结合推文元数据决定是否拉取多个视频片段以供短多视频无缝拼接。"""
    if not isinstance(payload, dict):
        return True
    main_count = int(payload.get("main_video_count") or 0)
    main_has_video = bool(payload.get("main_has_video"))
    quote_has_video = bool(payload.get("quote_has_video"))
    is_self_quote = bool(payload.get("is_self_quote"))
    quote_dur = float(payload.get("quote_video_duration") or 0)

    if main_count > 1:
        return True
    if main_has_video and quote_has_video:
        if is_self_quote:
            return True
        # 引用视频较短（或暂未知时长）时允许拉取并在落地后复核时长
        return quote_dur <= _MAX_QUOTE_VIDEO_SECONDS
    return False


def _probe_media_info(path: str) -> dict[str, Any]:
    """用 ffprobe 读取单段媒体的时长、分辨率与音视频流存在情况。"""
    default = {"duration": 0.0, "width": 0, "height": 0, "has_video": False, "has_audio": False}
    if not path or not os.path.isfile(path):
        return default
    try:
        from ffmpeg_helper import find_ffmpeg_binary

        ffprobe = find_ffmpeg_binary("ffprobe")
        creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        proc = subprocess.run(
            [
                ffprobe,
                "-v",
                "error",
                "-print_format",
                "json",
                "-show_format",
                "-show_streams",
                str(path),
            ],
            capture_output=True,
            text=True,
            timeout=20,
            creationflags=creationflags,
        )
        if proc.returncode != 0 or not proc.stdout:
            return default
        parsed = json.loads(proc.stdout)
        streams = parsed.get("streams") or []
        fmt = parsed.get("format") or {}
        dur = 0.0
        try:
            dur = float(fmt.get("duration") or 0.0)
        except (TypeError, ValueError):
            dur = 0.0
        width = 0
        height = 0
        has_video = False
        has_audio = False
        for stream in streams:
            if not isinstance(stream, dict):
                continue
            ctype = stream.get("codec_type")
            if ctype == "video" and not has_video:
                has_video = True
                try:
                    width = int(stream.get("width") or 0)
                    height = int(stream.get("height") or 0)
                except (TypeError, ValueError):
                    pass
                if dur <= 0:
                    try:
                        dur = float(stream.get("duration") or 0.0)
                    except (TypeError, ValueError):
                        pass
            elif ctype == "audio":
                has_audio = True
        return {
            "duration": max(0.0, dur),
            "width": width,
            "height": height,
            "has_video": has_video,
            "has_audio": has_audio,
        }
    except Exception:
        return default


def _build_clip_labels(clip_count: int, payload: Optional[dict[str, Any]]) -> list[str]:
    main_count = int((payload or {}).get("main_video_count") or 0)
    quote_has_video = bool((payload or {}).get("quote_has_video"))
    labels: list[str] = []
    for idx in range(clip_count):
        if main_count == 1 and quote_has_video:
            labels.append("主推文视频" if idx == 0 else (f"引用推文视频" if idx == 1 else f"附加视频 {idx + 1}"))
        elif main_count > 1 and quote_has_video and idx >= main_count:
            labels.append("引用推文视频" if idx == main_count else f"引用推文视频 {idx - main_count + 1}")
        else:
            labels.append(f"视频片段 {idx + 1}")
    return labels


def _select_clips_for_concat(
    resolved_clips: list[tuple[dict[str, Any], str]],
    payload: Optional[dict[str, Any]],
) -> list[tuple[dict[str, Any], str, float]]:
    """筛选参与无缝拼接的片段；超长或不符合条件时自动收敛为主视频首段。"""
    if not resolved_clips:
        return []
    bounded = resolved_clips[:_MAX_CONCAT_CLIPS]

    durations: list[float] = []
    for entry, path in bounded:
        dur = 0.0
        try:
            dur = float(entry.get("duration") or 0.0)
        except (TypeError, ValueError):
            dur = 0.0
        if dur <= 0:
            dur = _probe_media_info(path).get("duration", 0.0)
        durations.append(max(0.0, dur))

    if len(bounded) == 1:
        return [(bounded[0][0], bounded[0][1], durations[0])]

    total_dur = sum(durations)
    if total_dur <= 0 or total_dur > _MAX_CONCAT_TOTAL_SECONDS:
        logger.info("X 多视频总时长 %.1fs 超出自动拼接阈值，仅保留主视频首段", total_dur)
        return [(bounded[0][0], bounded[0][1], durations[0])]

    main_count = int((payload or {}).get("main_video_count") or 0)
    quote_has_video = bool((payload or {}).get("quote_has_video"))
    is_self_quote = bool((payload or {}).get("is_self_quote"))
    if main_count == 1 and quote_has_video and not is_self_quote:
        if any(d > _MAX_QUOTE_VIDEO_SECONDS for d in durations[1:]):
            logger.info("X 非同作者引用视频较长，仅保留主视频首段")
            return [(bounded[0][0], bounded[0][1], durations[0])]

    return [(entry, path, dur) for (entry, path), dur in zip(bounded, durations)]


def _concat_video_clips(
    clip_items: list[tuple[str, float, str]],
    target_path: str,
) -> tuple[bool, list[dict[str, Any]]]:
    """用本地 FFmpeg 将多段短视频无缝拼接为单一 MP4（统一画幅与音频参数，不拉伸变形）。"""
    if len(clip_items) < 2:
        return False, []
    try:
        from ffmpeg_helper import find_ffmpeg_binary

        ffmpeg = find_ffmpeg_binary("ffmpeg")
    except Exception as exc:
        logger.warning("未找到 FFmpeg，跳过 X 多视频拼接，将降级为主视频：%s", exc)
        return False, []

    probes = [_probe_media_info(path) for path, _, _ in clip_items]
    # 画幅基准跟随主视频，且最大边限 1280 兼顾清晰度与转码速度
    base_w = probes[0].get("width") or 1280
    base_h = probes[0].get("height") or 720
    max_side = max(base_w, base_h)
    if max_side > 1280:
        scale_ratio = 1280.0 / float(max_side)
        base_w = int(base_w * scale_ratio)
        base_h = int(base_h * scale_ratio)
    target_w = max(320, (base_w // 2) * 2)
    target_h = max(240, (base_h // 2) * 2)

    cmd: list[str] = [ffmpeg, "-y"]
    for path, _, _ in clip_items:
        cmd.extend(["-i", str(path)])

    filter_parts: list[str] = []
    concat_inputs: list[str] = []
    segments_meta: list[dict[str, Any]] = []
    cursor = 0.0

    for idx, (path, dur_hint, label) in enumerate(clip_items):
        info = probes[idx]
        seg_dur = info.get("duration") or dur_hint or 1.0
        filter_parts.append(
            f"[{idx}:v]scale={target_w}:{target_h}:force_original_aspect_ratio=decrease,"
            f"pad={target_w}:{target_h}:(ow-iw)/2:(oh-ih)/2:black,"
            f"setsar=1,fps=30,format=yuv420p[v{idx}]"
        )
        if info.get("has_audio"):
            filter_parts.append(
                f"[{idx}:a]aresample=44100,aformat=channel_layouts=stereo[a{idx}]"
            )
        else:
            filter_parts.append(
                f"anullsrc=r=44100:cl=stereo:d={seg_dur:.3f}[a{idx}]"
            )
        concat_inputs.append(f"[v{idx}][a{idx}]")
        segments_meta.append({
            "index": idx + 1,
            "label": label,
            "start": round(cursor, 2),
            "end": round(cursor + seg_dur, 2),
            "duration": round(seg_dur, 2),
        })
        cursor += seg_dur

    filter_parts.append(f"{''.join(concat_inputs)}concat=n={len(clip_items)}:v=1:a=1[outv][outa]")
    tmp_output = f"{target_path}.concat_tmp.mp4"
    cmd.extend([
        "-filter_complex",
        ";".join(filter_parts),
        "-map",
        "[outv]",
        "-map",
        "[outa]",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "23",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-movflags",
        "+faststart",
        tmp_output,
    ])

    creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=180,
            creationflags=creationflags,
        )
        if proc.returncode == 0 and os.path.isfile(tmp_output) and os.path.getsize(tmp_output) > 0:
            os.replace(tmp_output, target_path)
            logger.info("X 多视频无缝拼接成功：%d 段共 %.1fs -> %s", len(clip_items), cursor, target_path)
            return True, segments_meta
        logger.warning("X 多视频 FFmpeg 拼接失败 (rc=%s)，将降级为主视频：%s", proc.returncode, (proc.stderr or "")[-300:])
    except Exception as exc:
        logger.warning("X 多视频 FFmpeg 拼接异常，将降级为主视频：%s", exc)
    finally:
        if os.path.exists(tmp_output):
            try:
                os.unlink(tmp_output)
            except OSError:
                pass
    return False, []


def _concat_audio_clips(
    clip_items: list[tuple[str, float, str]],
    target_path: str,
) -> tuple[bool, list[dict[str, Any]]]:
    """用本地 FFmpeg 拼接多段音频为单一 M4A（用于关闭视频下载时的多片段音频转写）。"""
    if len(clip_items) < 2:
        return False, []
    try:
        from ffmpeg_helper import find_ffmpeg_binary

        ffmpeg = find_ffmpeg_binary("ffmpeg")
    except Exception:
        return False, []

    cmd: list[str] = [ffmpeg, "-y"]
    filter_parts: list[str] = []
    concat_inputs: list[str] = []
    segments_meta: list[dict[str, Any]] = []
    cursor = 0.0

    for idx, (path, dur_hint, label) in enumerate(clip_items):
        cmd.extend(["-i", str(path)])
        info = _probe_media_info(path)
        seg_dur = info.get("duration") or dur_hint or 1.0
        filter_parts.append(f"[{idx}:a]aresample=44100,aformat=channel_layouts=stereo[a{idx}]")
        concat_inputs.append(f"[a{idx}]")
        segments_meta.append({
            "index": idx + 1,
            "label": label,
            "start": round(cursor, 2),
            "end": round(cursor + seg_dur, 2),
            "duration": round(seg_dur, 2),
        })
        cursor += seg_dur

    filter_parts.append(f"{''.join(concat_inputs)}concat=n={len(clip_items)}:v=0:a=1[outa]")
    tmp_output = f"{target_path}.concat_tmp.m4a"
    cmd.extend([
        "-filter_complex",
        ";".join(filter_parts),
        "-map",
        "[outa]",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        tmp_output,
    ])

    creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=90,
            creationflags=creationflags,
        )
        if proc.returncode == 0 and os.path.isfile(tmp_output) and os.path.getsize(tmp_output) > 0:
            os.replace(tmp_output, target_path)
            return True, segments_meta
    except Exception as exc:
        logger.warning("X 多音频 FFmpeg 拼接异常，将降级为首段音频：%s", exc)
    finally:
        if os.path.exists(tmp_output):
            try:
                os.unlink(tmp_output)
            except OSError:
                pass
    return False, []


def _extract_audio_from_video(video_path: str, target_audio_path: str) -> str:
    """从已落盘的主/拼接视频中零网络秒抽音轨，确保转写与视频播放时间轴完全一致。"""
    if os.path.isfile(target_audio_path) and os.path.getsize(target_audio_path) > 0:
        try:
            if os.path.getmtime(target_audio_path) >= os.path.getmtime(video_path):
                return target_audio_path
        except OSError:
            pass
    try:
        from ffmpeg_helper import find_ffmpeg_binary

        ffmpeg = find_ffmpeg_binary("ffmpeg")
    except Exception:
        return video_path

    tmp_audio = f"{target_audio_path}.tmp.m4a"
    creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    for codec_args in (["-c:a", "copy"], ["-c:a", "aac", "-b:a", "128k"]):
        try:
            proc = subprocess.run(
                [ffmpeg, "-y", "-i", str(video_path), "-vn", *codec_args, tmp_audio],
                capture_output=True,
                text=True,
                timeout=60,
                creationflags=creationflags,
            )
            if proc.returncode == 0 and os.path.isfile(tmp_audio) and os.path.getsize(tmp_audio) > 0:
                os.replace(tmp_audio, target_audio_path)
                return target_audio_path
        except Exception:
            pass
        finally:
            if os.path.exists(tmp_audio):
                try:
                    os.unlink(tmp_audio)
                except OSError:
                    pass
    return video_path


def _format_concat_segments_note(segments_meta: list[dict[str, Any]]) -> str:
    if not segments_meta or len(segments_meta) < 2:
        return ""
    parts = [
        f"{_format_mmss(seg.get('start', 0))}-{_format_mmss(seg.get('end', 0))} {seg.get('label') or f'片段 {idx}'}"
        for idx, seg in enumerate(segments_meta, 1)
    ]
    return "视频片段结构（已自动拼接为连续时间轴，请在整理知识时整合各段内容并准确对应时间点）：\n" + "；".join(parts)


def _save_clip_sidecar(output_dir: str, safe_id: str, segments_meta: list[dict[str, Any]]) -> None:
    sidecar = Path(output_dir) / f"x_{safe_id}.clips.json"
    try:
        if segments_meta and len(segments_meta) >= 2:
            sidecar.write_text(json.dumps({"segments": segments_meta}, ensure_ascii=False), encoding="utf-8")
        elif sidecar.exists():
            sidecar.unlink()
    except OSError:
        pass


def _load_clip_sidecar(output_dir: str, safe_id: str) -> list[dict[str, Any]]:
    sidecar = Path(output_dir) / f"x_{safe_id}.clips.json"
    if not sidecar.is_file():
        return []
    try:
        data = json.loads(sidecar.read_text(encoding="utf-8"))
        segs = data.get("segments") if isinstance(data, dict) else None
        return segs if isinstance(segs, list) else []
    except (OSError, ValueError):
        return []


def _cleanup_part_files(paths: list[str], *, keep_path: Optional[str] = None) -> None:
    keep_norm = os.path.normcase(os.path.abspath(keep_path)) if keep_path else ""
    for fp in paths:
        if not fp:
            continue
        try:
            if keep_norm and os.path.normcase(os.path.abspath(fp)) == keep_norm:
                continue
            if os.path.isfile(fp):
                os.unlink(fp)
        except OSError:
            pass


class XDownloader(Downloader):
    """X (原 Twitter) 下载与正文提取器。"""

    def __init__(self):
        super().__init__()
        self._payload_cache: dict[str, tuple[float, dict[str, Any]]] = {}
        self._cache_lock = threading.RLock()

    @staticmethod
    def _proxy_url() -> Optional[str]:
        return ProxyConfigManager().get_proxy_url()

    @staticmethod
    def _cookie_header() -> Optional[str]:
        return CookieConfigManager().get("x")

    def _get_payload(self, video_url: str, *, allow_error: bool = False) -> Optional[dict[str, Any]]:
        key = normalize_video_url(video_url)
        now = time.monotonic()
        with self._cache_lock:
            cached = self._payload_cache.get(key)
            if cached and (now - cached[0]) < _PAYLOAD_CACHE_TTL:
                return dict(cached[1])
            if len(self._payload_cache) > 32:
                self._payload_cache.clear()
        try:
            payload = fetch_x_post_payload(
                key,
                proxy_url=self._proxy_url(),
                cookie_header=self._cookie_header(),
            )
            with self._cache_lock:
                self._payload_cache[key] = (now, dict(payload))
            return payload
        except Exception as exc:
            if allow_error:
                logger.warning("X 元数据预取失败（将尝试 yt-dlp）: %s", exc)
                return None
            raise

    def is_text_post(self, video_url: str) -> bool:
        """判断当前 X 链接是否为无音视频流的纯图文推文 / X 长文。"""
        payload = self._get_payload(video_url, allow_error=True)
        if not payload:
            return False
        return not payload.get("has_video") and not payload.get("has_audio")

    def download_subtitles(
        self,
        video_url: str,
        output_dir: str = None,
        langs: List[str] = None,
    ) -> Optional[TranscriptResult]:
        """纯图文 / X Article 长文直接提取正文作为 TranscriptResult；含视频/音频返回 None。"""
        payload = self._get_payload(video_url, allow_error=True)
        if not payload:
            return None
        if payload.get("has_video") or payload.get("has_audio"):
            return None
        return build_text_post_transcript(payload)

    def _build_text_post_result(self, payload: dict[str, Any]) -> AudioDownloadResult:
        tweet_id = str(payload.get("tweet_id") or "")
        local_images = localize_x_images(
            payload.get("images") or [],
            tweet_id,
            proxy_url=self._proxy_url(),
        )
        cover_url = local_images[0]["web_url"] if local_images else str(payload.get("cover_url") or "")
        post_context = build_x_post_context(payload)
        return AudioDownloadResult(
            file_path="",
            title=str(payload.get("title") or f"X 推文 {tweet_id}"),
            duration=0,
            cover_url=cover_url,
            platform="x",
            video_id=tweet_id,
            raw_info={
                "media_kind": "text_post",
                "post_context": post_context,
                "local_images": local_images,
                "author": payload.get("author") or "",
                "canonical_url": payload.get("canonical_url") or "",
                "tags": [payload["author_handle"]] if payload.get("author_handle") else [],
            },
            video_path=None,
        )

    def download(
        self,
        video_url: str,
        output_dir: Union[str, None] = None,
        quality: DownloadQuality = "fast",
        need_video: Optional[bool] = False,
        skip_download: bool = False,
    ) -> AudioDownloadResult:
        if output_dir is None:
            output_dir = get_data_dir()
        if not output_dir:
            output_dir = self.cache_data or "data"
        os.makedirs(output_dir, exist_ok=True)

        proxy_url = self._proxy_url()
        cookie_header = self._cookie_header()
        payload = self._get_payload(video_url, allow_error=True)

        # 纯图文推文 / X 长文：跳过音视频下载，本地化配图并返回 text_post 元信息
        if payload and not payload.get("has_video") and not payload.get("has_audio"):
            return self._build_text_post_result(payload)

        canonical_url = (payload or {}).get("canonical_url") or normalize_video_url(video_url)
        tweet_id = str((payload or {}).get("tweet_id") or extract_video_id(canonical_url, "x") or "")
        safe_id = _safe_media_id(tweet_id)

        # 若 download_video() 已产出完整（含自动拼接）的本地 MP4，直接零网络抽音轨确保时间轴 100% 一致
        existing_video = os.path.join(output_dir, f"x_{safe_id}.mp4")
        if not skip_download and tweet_id and os.path.isfile(existing_video) and os.path.getsize(existing_video) > 0:
            target_audio = os.path.join(output_dir, f"x_{safe_id}_audio.m4a")
            audio_path = _extract_audio_from_video(existing_video, target_audio)
            clip_segments = _load_clip_sidecar(output_dir, safe_id)
            probed_dur = _probe_media_info(existing_video).get("duration", 0.0)
            duration = int(round(probed_dur)) if probed_dur > 0 else int((payload or {}).get("duration") or 0)
            title = (payload or {}).get("title") or f"X 视频 {tweet_id}"
            cover_url = (payload or {}).get("cover_url") or ""
            post_context = build_x_post_context(payload) if payload else ""
            concat_note = _format_concat_segments_note(clip_segments)
            if concat_note:
                post_context = f"{post_context}\n\n{concat_note}".strip()
            local_images = (
                localize_x_images(payload.get("images") or [], tweet_id, proxy_url=proxy_url)
                if payload and payload.get("images")
                else []
            )
            return AudioDownloadResult(
                file_path=audio_path,
                title=title,
                duration=duration,
                cover_url=cover_url,
                platform="x",
                video_id=tweet_id,
                raw_info={
                    "media_kind": "video",
                    "post_context": post_context,
                    "local_images": local_images,
                    "author": (payload or {}).get("author") or "",
                    "canonical_url": canonical_url,
                    "tags": [(payload or {}).get("author_handle")] if (payload or {}).get("author_handle") else [],
                    "concat_segments": clip_segments,
                },
                video_path=existing_video,
            )

        # 视频推文 / Broadcast / Spaces：走 yt-dlp 提取音轨与元信息（兼容多视频 playlist）
        import yt_dlp

        allow_multi = _should_allow_multi_clip(payload)
        part_prefix = f"x_{safe_id}_apart_"
        output_path = os.path.join(output_dir, f"{part_prefix}%(autonumber)s_%(id)s.%(ext)s")
        ydl_opts: dict[str, Any] = {
            **YDL_RETRY_OPTS,
            "format": "bestaudio[ext=m4a]/bestaudio/best",
            "outtmpl": output_path,
            "noplaylist": True,
            "playlist_items": f"1-{_MAX_CONCAT_CLIPS}" if allow_multi else "1",
            "quiet": False,
        }
        if skip_download:
            ydl_opts["skip_download"] = True
            ydl_opts["ignore_no_formats_error"] = True
        if proxy_url:
            ydl_opts["proxy"] = proxy_url
            logger.info("X yt-dlp 走全局代理")

        try:
            with _temp_cookie_file(cookie_header) as cookie_file:
                if cookie_file:
                    ydl_opts["cookiefile"] = cookie_file
                with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                    info = ydl.extract_info(canonical_url, download=not skip_download)
        except Exception as exc:
            # 若 yt-dlp 报告无视频流但元数据存在正文，平滑降级为 text_post
            err_low = str(exc).lower()
            if payload and (payload.get("text") or payload.get("article_text")) and (
                "no video could be found" in err_low or "no formats" in err_low
            ):
                logger.info("X 链接无可用音视频流，自动降级为纯图文/长文处理")
                return self._build_text_post_result(payload)
            raise XPlatformError(classify_x_error(exc)) from exc

        entries = _unwrap_ydl_entries(info)
        primary = entries[0] if entries else (info if isinstance(info, dict) else {})
        video_id = str(tweet_id or (info.get("id") if isinstance(info, dict) else "") or primary.get("id") or "")
        safe_id = _safe_media_id(video_id)
        ext = str(primary.get("ext") or (info.get("ext") if isinstance(info, dict) else "") or "m4a")
        audio_path = os.path.join(output_dir, f"x_{safe_id}_audio.{ext}")
        clip_segments: list[dict[str, Any]] = []
        duration = primary.get("duration") or (info.get("duration") if isinstance(info, dict) else None) or (payload or {}).get("duration") or 0

        if not skip_download:
            resolved_clips: list[tuple[dict[str, Any], str]] = []
            for entry in entries:
                fp = _resolve_entry_filepath(entry, output_dir, fallback_ext=ext, part_prefix=part_prefix)
                if fp:
                    resolved_clips.append((entry, fp))
            if not resolved_clips and isinstance(info, dict):
                fp = _resolve_entry_filepath(info, output_dir, fallback_ext=ext, part_prefix=part_prefix)
                if fp:
                    resolved_clips.append((primary, fp))

            all_part_paths = [fp for _, fp in resolved_clips]
            selected = _select_clips_for_concat(resolved_clips, payload)
            if len(selected) >= 2:
                labels = _build_clip_labels(len(selected), payload)
                concat_target = os.path.join(output_dir, f"x_{safe_id}_audio.m4a")
                ok, segs = _concat_audio_clips(
                    [(fp, dur, labels[i]) for i, (_, fp, dur) in enumerate(selected)],
                    concat_target,
                )
                if ok:
                    audio_path = concat_target
                    clip_segments = segs
                    duration = int(round(sum(s.get("duration", 0.0) for s in segs)))
                    _save_clip_sidecar(output_dir, safe_id, segs)
                    _cleanup_part_files(all_part_paths, keep_path=audio_path)
                else:
                    audio_path = selected[0][1]
                    _cleanup_part_files(all_part_paths, keep_path=audio_path)
            elif len(selected) == 1:
                src_fp = selected[0][1]
                src_ext = Path(src_fp).suffix.lstrip(".") or ext
                final_audio = os.path.join(output_dir, f"x_{safe_id}_audio.{src_ext}")
                try:
                    if os.path.normcase(os.path.abspath(src_fp)) != os.path.normcase(os.path.abspath(final_audio)):
                        shutil.move(src_fp, final_audio)
                    audio_path = final_audio
                except OSError:
                    audio_path = src_fp
                _cleanup_part_files(all_part_paths, keep_path=audio_path)

        title = (payload or {}).get("title") or (info.get("title") if isinstance(info, dict) else None) or primary.get("title") or f"X 视频 {video_id}"
        cover_url = primary.get("thumbnail") or (info.get("thumbnail") if isinstance(info, dict) else None) or (payload or {}).get("cover_url") or ""
        post_context = build_x_post_context(payload) if payload else str(primary.get("description") or (info.get("description") if isinstance(info, dict) else "") or "").strip()
        concat_note = _format_concat_segments_note(clip_segments)
        if concat_note:
            post_context = f"{post_context}\n\n{concat_note}".strip()
        local_images = (
            localize_x_images(payload.get("images") or [], video_id, proxy_url=proxy_url)
            if payload and payload.get("images")
            else []
        )

        media_kind = "audio" if (payload and payload.get("has_audio") and not payload.get("has_video")) else "video"
        return AudioDownloadResult(
            file_path=audio_path,
            title=title,
            duration=int(round(float(duration or 0))),
            cover_url=cover_url,
            platform="x",
            video_id=video_id,
            raw_info={
                "media_kind": media_kind,
                "post_context": post_context,
                "local_images": local_images,
                "author": (payload or {}).get("author") or primary.get("uploader") or (info.get("uploader") if isinstance(info, dict) else "") or "",
                "canonical_url": canonical_url,
                "tags": primary.get("tags") or (info.get("tags") if isinstance(info, dict) else None) or [],
                "concat_segments": clip_segments,
            },
            video_path=None,
        )

    def download_video(
        self,
        video_url: str,
        output_dir: Union[str, None] = None,
    ) -> str:
        """下载 X 视频到本地 MP4（短多视频自动无缝拼接；纯图文/纯音频返回空串，不报错）。"""
        payload = self._get_payload(video_url, allow_error=True)
        if payload and not payload.get("has_video"):
            return ""

        if output_dir is None:
            output_dir = get_data_dir()
        os.makedirs(output_dir, exist_ok=True)

        canonical_url = (payload or {}).get("canonical_url") or normalize_video_url(video_url)
        tweet_id = str((payload or {}).get("tweet_id") or extract_video_id(canonical_url, "x") or "x_video")
        safe_id = _safe_media_id(tweet_id)
        video_path = os.path.join(output_dir, f"x_{safe_id}.mp4")
        if os.path.exists(video_path) and os.path.getsize(video_path) > 0:
            return video_path

        import yt_dlp

        proxy_url = self._proxy_url()
        cookie_header = self._cookie_header()
        allow_multi = _should_allow_multi_clip(payload)
        part_prefix = f"x_{safe_id}_vpart_"
        ydl_opts: dict[str, Any] = {
            **YDL_RETRY_OPTS,
            "format": "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
            "outtmpl": os.path.join(output_dir, f"{part_prefix}%(autonumber)s_%(id)s.%(ext)s"),
            "noplaylist": True,
            "playlist_items": f"1-{_MAX_CONCAT_CLIPS}" if allow_multi else "1",
            "quiet": False,
            "merge_output_format": "mp4",
        }
        if proxy_url:
            ydl_opts["proxy"] = proxy_url

        try:
            with _temp_cookie_file(cookie_header) as cookie_file:
                if cookie_file:
                    ydl_opts["cookiefile"] = cookie_file
                with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                    info = ydl.extract_info(canonical_url, download=True)
        except Exception as exc:
            err_low = str(exc).lower()
            if "no video could be found" in err_low or "no formats" in err_low:
                return ""
            raise XPlatformError(classify_x_error(exc)) from exc

        entries = _unwrap_ydl_entries(info)
        resolved_clips: list[tuple[dict[str, Any], str]] = []
        for entry in entries:
            fp = _resolve_entry_filepath(entry, output_dir, fallback_ext="mp4", part_prefix=part_prefix)
            if fp:
                resolved_clips.append((entry, fp))
        if not resolved_clips and isinstance(info, dict):
            fp = _resolve_entry_filepath(info, output_dir, fallback_ext="mp4", part_prefix=part_prefix)
            if fp:
                resolved_clips.append((info, fp))

        if not resolved_clips:
            raise FileNotFoundError(f"视频文件未找到: {video_path}")

        all_part_paths = [fp for _, fp in resolved_clips]
        selected = _select_clips_for_concat(resolved_clips, payload)

        if len(selected) >= 2:
            labels = _build_clip_labels(len(selected), payload)
            ok, segs = _concat_video_clips(
                [(fp, dur, labels[i]) for i, (_, fp, dur) in enumerate(selected)],
                video_path,
            )
            if ok and os.path.isfile(video_path) and os.path.getsize(video_path) > 0:
                _save_clip_sidecar(output_dir, safe_id, segs)
                _cleanup_part_files(all_part_paths, keep_path=video_path)
                return video_path

        # 单片段或拼接降级：规范命名为主推文 MP4，便于二次复用与媒体流播放
        primary_fp = selected[0][1]
        _save_clip_sidecar(output_dir, safe_id, [])
        if Path(primary_fp).suffix.lower() == ".mp4":
            try:
                if os.path.normcase(os.path.abspath(primary_fp)) != os.path.normcase(os.path.abspath(video_path)):
                    shutil.move(primary_fp, video_path)
                _cleanup_part_files(all_part_paths, keep_path=video_path)
                return video_path
            except OSError:
                pass
        _cleanup_part_files(all_part_paths, keep_path=primary_fp)
        return primary_fp
