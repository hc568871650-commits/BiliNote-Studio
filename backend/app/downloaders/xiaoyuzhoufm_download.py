"""小宇宙播客（xiaoyuzhoufm.com）单集元数据与音频下载器。

特性：
- 零顶层网络请求与副作用，保持后端冷启动轻量；
- 优先解析页面 __NEXT_DATA__ 中的单集信息，回退至 og:* meta / JSON-LD；
- 同步提取播客名称、封面、时长与 Shownotes 简介（作为 post_context 背景上下文）；
- 归类 media_kind="audio"，直接衔接本地音频条回看与语音转写，不触发视频下载或截帧。
"""

from __future__ import annotations

import html
import json
import os
import re
from pathlib import Path
from typing import Any, Optional, Union
from urllib.parse import urlparse

from app.core.runtime import get_runtime
from app.downloaders.base import Downloader
from app.enmus.note_enums import DownloadQuality
from app.models.audio_model import AudioDownloadResult
from app.services.proxy_config_manager import ProxyConfigManager
from app.utils.logger import get_logger

logger = get_logger(__name__)

_EPISODE_ID_RE = re.compile(r"/episode/([0-9A-Za-z_-]+)", re.IGNORECASE)
_PODCAST_HOME_RE = re.compile(r"/podcast/([0-9A-Za-z_-]+)", re.IGNORECASE)
_NEXT_DATA_RE = re.compile(
    r'<script[^>]+id=["\']__NEXT_DATA__["\'][^>]*>(.*?)</script>',
    re.IGNORECASE | re.DOTALL,
)
_LD_JSON_RE = re.compile(
    r'<script[^>]+type=["\']application/ld\+json["\'][^>]*>(.*?)</script>',
    re.IGNORECASE | re.DOTALL,
)
_META_TAG_RE = re.compile(r"<meta\b[^>]*>", re.IGNORECASE)
_META_ATTR_RE = re.compile(r'([a-zA-Z_:.-]+)\s*=\s*(?:"([^"]*)"|\'([^\']*)\')')
_TAG_BREAK_RE = re.compile(r"</?(?:p|div|br|li|h[1-6]|tr|section|article)\b[^>]*>", re.IGNORECASE)
_TAG_STRIP_RE = re.compile(r"<[^>]+>")

_BROWSER_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/137.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
}

_AUDIO_EXTENSIONS = {".m4a", ".mp3", ".aac", ".ogg", ".opus", ".wav", ".flac"}


def extract_xiaoyuzhou_episode_id(url: str) -> Optional[str]:
    match = _EPISODE_ID_RE.search(str(url or ""))
    return match.group(1) if match else None


def _clean_html_text(raw: Any) -> str:
    text = str(raw or "").strip()
    if not text:
        return ""
    text = _TAG_BREAK_RE.sub("\n", text)
    text = _TAG_STRIP_RE.sub("", text)
    text = html.unescape(text)
    lines = [re.sub(r"[ \t]+", " ", line).strip() for line in text.splitlines()]
    cleaned = "\n".join(line for line in lines if line)
    return re.sub(r"\n{3,}", "\n\n", cleaned).strip()


def _extract_meta_map(page_html: str) -> dict[str, str]:
    meta: dict[str, str] = {}
    for tag in _META_TAG_RE.findall(page_html):
        attrs = {k.lower(): (v1 or v2) for k, v1, v2 in _META_ATTR_RE.findall(tag)}
        key = (attrs.get("property") or attrs.get("name") or "").strip().lower()
        content = html.unescape((attrs.get("content") or "").strip())
        if key and content and key not in meta:
            meta[key] = content
    return meta


def _parse_iso_or_numeric_duration(value: Any) -> float:
    if isinstance(value, (int, float)) and value > 0:
        return float(value)
    text = str(value or "").strip()
    if not text:
        return 0.0
    if text.isdigit():
        return float(text)
    iso = re.fullmatch(r"PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?", text, re.IGNORECASE)
    if iso:
        h = float(iso.group(1) or 0)
        m = float(iso.group(2) or 0)
        s = float(iso.group(3) or 0)
        return h * 3600 + m * 60 + s
    return 0.0


def parse_xiaoyuzhou_episode_html(page_html: str, source_url: str) -> dict[str, Any]:
    """从单集页面 HTML 解析小宇宙播客元数据与音频直链。"""
    episode_id = extract_xiaoyuzhou_episode_id(source_url) or ""
    canonical_url = (
        f"https://www.xiaoyuzhoufm.com/episode/{episode_id}" if episode_id else source_url
    )
    title = ""
    audio_url = ""
    cover_url = ""
    duration = 0.0
    podcast_title = ""
    author = ""
    shownotes = ""

    # 1. 优先解析 Next.js __NEXT_DATA__
    next_match = _NEXT_DATA_RE.search(page_html or "")
    if next_match:
        try:
            next_data = json.loads(next_match.group(1))
            episode = (
                (next_data.get("props") or {})
                .get("pageProps", {})
                .get("episode")
            )
            if isinstance(episode, dict):
                title = str(episode.get("title") or "").strip()
                enclosure = episode.get("enclosure") or {}
                media = episode.get("media") or {}
                media_source = media.get("source") if isinstance(media, dict) else {}
                audio_url = str(
                    (enclosure.get("url") if isinstance(enclosure, dict) else "")
                    or (media_source.get("url") if isinstance(media_source, dict) else "")
                    or episode.get("mediaKey")
                    or ""
                ).strip()
                if audio_url and not audio_url.startswith(("http://", "https://")):
                    audio_url = ""
                duration = _parse_iso_or_numeric_duration(episode.get("duration"))
                image = episode.get("image") if isinstance(episode.get("image"), dict) else {}
                podcast = episode.get("podcast") if isinstance(episode.get("podcast"), dict) else {}
                pod_image = podcast.get("image") if isinstance(podcast.get("image"), dict) else {}
                cover_url = str(
                    image.get("largePicUrl")
                    or image.get("picUrl")
                    or image.get("middlePicUrl")
                    or pod_image.get("largePicUrl")
                    or pod_image.get("picUrl")
                    or ""
                ).strip()
                podcast_title = str(podcast.get("title") or "").strip()
                author = str(podcast.get("author") or "").strip()
                shownotes = _clean_html_text(
                    episode.get("shownotes") or episode.get("description") or ""
                )
        except (ValueError, TypeError, AttributeError):
            pass

    # 2. JSON-LD 补充回退
    if not audio_url or not title:
        for ld_raw in _LD_JSON_RE.findall(page_html or ""):
            try:
                ld = json.loads(ld_raw)
            except ValueError:
                continue
            items = ld if isinstance(ld, list) else [ld]
            for item in items:
                if not isinstance(item, dict):
                    continue
                if not title and item.get("name"):
                    title = str(item.get("name")).strip()
                if not duration and item.get("timeRequired"):
                    duration = _parse_iso_or_numeric_duration(item.get("timeRequired"))
                if not audio_url:
                    assoc = item.get("associatedMedia") or item.get("audio") or {}
                    if isinstance(assoc, dict):
                        audio_url = str(assoc.get("contentUrl") or assoc.get("url") or "").strip()
                if not cover_url and item.get("image"):
                    img = item.get("image")
                    cover_url = str(img.get("url") if isinstance(img, dict) else img).strip()
                if not shownotes and item.get("description"):
                    shownotes = _clean_html_text(item.get("description"))
                if not podcast_title and isinstance(item.get("partOfSeries"), dict):
                    podcast_title = str(item["partOfSeries"].get("name") or "").strip()

    # 3. OpenGraph meta 最终回退
    meta = _extract_meta_map(page_html or "")
    if not title:
        raw_title = meta.get("og:title") or meta.get("twitter:title") or ""
        title = re.sub(r"\s*[-|–—]\s*小宇宙.*$", "", raw_title).strip()
    if not audio_url:
        audio_url = meta.get("og:audio") or meta.get("og:audio:secure_url") or ""
    if not cover_url:
        cover_url = meta.get("og:image") or meta.get("twitter:image") or ""
    if not shownotes:
        shownotes = _clean_html_text(meta.get("og:description") or meta.get("description") or "")

    uploader = podcast_title or author or "小宇宙播客"
    return {
        "episode_id": episode_id,
        "webpage_url": canonical_url,
        "title": title or (f"小宇宙单集 {episode_id}" if episode_id else "小宇宙播客"),
        "audio_url": audio_url,
        "cover_url": cover_url,
        "duration": duration,
        "podcast_title": podcast_title,
        "author": author,
        "uploader": uploader,
        "shownotes": shownotes,
    }


def build_xiaoyuzhou_post_context(payload: dict[str, Any]) -> str:
    """将播客节目名、标题与 Shownotes 组装为背景上下文，帮助模型准确定位专有名词与章节。"""
    lines: list[str] = []
    podcast = str(payload.get("podcast_title") or "").strip()
    title = str(payload.get("title") or "").strip()
    shownotes = str(payload.get("shownotes") or "").strip()
    if podcast:
        lines.append(f"播客节目：{podcast}")
    if title:
        lines.append(f"单集标题：{title}")
    if shownotes:
        lines.append("单集 Shownotes / 简介：\n" + shownotes[:4000])
    return "\n\n".join(lines).strip()


def fetch_xiaoyuzhou_episode(url: str, proxy_url: Optional[str] = None) -> dict[str, Any]:
    """抓取并解析小宇宙播客单集页面。"""
    import requests

    episode_id = extract_xiaoyuzhou_episode_id(url)
    if not episode_id:
        if _PODCAST_HOME_RE.search(str(url or "")):
            raise ValueError("当前是小宇宙播客节目主页链接，请打开具体单集并复制含 /episode/ 的单集链接")
        raise ValueError("无法识别小宇宙单集编号，请确认链接格式为 https://www.xiaoyuzhoufm.com/episode/...")

    canonical = f"https://www.xiaoyuzhoufm.com/episode/{episode_id}"
    if proxy_url is None:
        proxy_url = ProxyConfigManager().get_proxy_url()
    proxies = {"http": proxy_url, "https": proxy_url} if proxy_url else None

    try:
        resp = requests.get(
            canonical,
            headers=_BROWSER_HEADERS,
            timeout=20,
            proxies=proxies,
        )
    except requests.RequestException as exc:
        raise RuntimeError(f"无法连接小宇宙页面，请检查网络或代理设置：{exc}") from exc

    if resp.status_code == 404:
        raise ValueError("该小宇宙单集不存在或已下架，请检查链接")
    if resp.status_code >= 400:
        raise RuntimeError(f"读取小宇宙单集失败（HTTP {resp.status_code}），请稍后重试")

    parsed = parse_xiaoyuzhou_episode_html(resp.text, canonical)
    if not parsed.get("audio_url"):
        raise ValueError("未能在页面中找到该小宇宙单集的公开音频地址，可能为付费或私密内容")
    return parsed


def _guess_audio_suffix(audio_url: str, content_type: str = "") -> str:
    path_suffix = Path(urlparse(audio_url).path).suffix.lower()
    if path_suffix in _AUDIO_EXTENSIONS:
        return path_suffix
    ctype = (content_type or "").split(";")[0].strip().lower()
    mapping = {
        "audio/mp4": ".m4a",
        "audio/x-m4a": ".m4a",
        "audio/mpeg": ".mp3",
        "audio/aac": ".aac",
        "audio/ogg": ".ogg",
        "audio/wav": ".wav",
        "audio/flac": ".flac",
    }
    return mapping.get(ctype, ".m4a")


class XiaoyuzhouDownloader(Downloader):
    """小宇宙播客单集下载器（纯音频来源）。"""

    def __init__(self):
        super().__init__()
        self._cache: dict[str, dict[str, Any]] = {}

    def _get_episode(self, url: str) -> dict[str, Any]:
        key = str(url or "").strip()
        if key not in self._cache:
            self._cache[key] = fetch_xiaoyuzhou_episode(key)
        return self._cache[key]

    def download_video(self, video_url: str, output_dir: Union[str, None] = None) -> Optional[str]:
        # 播客单集为纯音频，跳过视频流下载与截帧
        return None

    def download(
        self,
        video_url: str,
        output_dir: Union[str, None] = None,
        quality: DownloadQuality = "fast",
        need_video: Optional[bool] = False,
        skip_download: bool = False,
    ) -> AudioDownloadResult:
        import requests

        episode = self._get_episode(video_url)
        episode_id = episode["episode_id"]
        audio_url = episode["audio_url"]
        post_context = build_xiaoyuzhou_post_context(episode)

        raw_info = {
            "media_kind": "audio",
            "uploader": episode["uploader"],
            "podcast_title": episode["podcast_title"],
            "webpage_url": episode["webpage_url"],
            "audio_url": audio_url,
            "shownotes": episode["shownotes"],
            "post_context": post_context,
        }

        if skip_download:
            return AudioDownloadResult(
                file_path="",
                title=episode["title"],
                duration=float(episode.get("duration") or 0.0),
                cover_url=episode.get("cover_url") or "",
                platform="xiaoyuzhou",
                video_id=episode_id,
                raw_info=raw_info,
                video_path=None,
            )

        out_root = Path(output_dir).resolve() if output_dir else get_runtime().data_dir.resolve()
        out_root.mkdir(parents=True, exist_ok=True)

        proxy_url = ProxyConfigManager().get_proxy_url()
        proxies = {"http": proxy_url, "https": proxy_url} if proxy_url else None
        headers = {
            "User-Agent": _BROWSER_HEADERS["User-Agent"],
            "Referer": "https://www.xiaoyuzhoufm.com/",
        }

        try:
            with requests.get(
                audio_url,
                headers=headers,
                stream=True,
                timeout=(15, 120),
                proxies=proxies,
            ) as resp:
                if resp.status_code >= 400:
                    raise RuntimeError(f"下载小宇宙音频失败（HTTP {resp.status_code}）")
                suffix = _guess_audio_suffix(audio_url, resp.headers.get("Content-Type", ""))
                target = out_root / f"xyz_{episode_id}{suffix}"
                tmp = out_root / f"xyz_{episode_id}{suffix}.part"
                total = 0
                try:
                    with tmp.open("wb") as fh:
                        for chunk in resp.iter_content(chunk_size=128 * 1024):
                            if not chunk:
                                continue
                            fh.write(chunk)
                            total += len(chunk)
                    if total <= 0:
                        raise RuntimeError("下载的小宇宙音频文件为空")
                    os.replace(tmp, target)
                finally:
                    if tmp.exists():
                        try:
                            tmp.unlink()
                        except OSError:
                            pass
        except requests.RequestException as exc:
            raise RuntimeError(f"下载小宇宙音频连接失败：{exc}") from exc

        logger.info("小宇宙单集音频下载完成: %s (%d bytes)", target, target.stat().st_size)
        return AudioDownloadResult(
            file_path=str(target),
            title=episode["title"],
            duration=float(episode.get("duration") or 0.0),
            cover_url=episode.get("cover_url") or "",
            platform="xiaoyuzhou",
            video_id=episode_id,
            raw_info=raw_info,
            video_path=None,
        )


# 兼容旧符号名称
Xiaoyuzhoufm_download = XiaoyuzhouDownloader
