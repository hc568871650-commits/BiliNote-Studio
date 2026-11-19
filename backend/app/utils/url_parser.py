import re
from typing import Optional
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse
import requests

_URL_IN_TEXT_RE = re.compile(r"https?://[^\s<>'\"`\]\[(){}\u3000-\u303f\uff00-\uffef]+", re.IGNORECASE)
_BARE_BV_RE = re.compile(r"(?<![0-9A-Za-z])(BV[0-9A-Za-z]{10,12})(?![0-9A-Za-z])")
_TRAILING_PUNCT = ".,;:!?。，；：！？、）)】】》」』\"'"
_TRACKING_PARAM_EXACT = {
    "spm_id_from",
    "vd_source",
    "from_spmid",
    "share_source",
    "share_medium",
    "share_plat",
    "share_session_id",
    "share_from",
    "share_tag",
    "bbid",
    "ts",
    "buvid",
    "is_story_h5",
    "mid",
    "p_type",
    "up_id",
    "si",
    "feature",
    "pp",
    "ab_channel",
    "fbclid",
    "gclid",
    "igsh",
    "unique_k",
}


def _strip_tracking_params(url: str) -> str:
    parsed = urlparse(url)
    if not parsed.scheme or not parsed.netloc or not parsed.query:
        return url
    filtered = [
        (k, v)
        for k, v in parse_qsl(parsed.query, keep_blank_values=False)
        if k.lower() not in _TRACKING_PARAM_EXACT and not k.lower().startswith("utm_")
    ]
    new_query = urlencode(filtered, doseq=True)
    return urlunparse(parsed._replace(query=new_query))


def extract_url_from_share_text(raw: str) -> str:
    """从分享口令/混合文本中提取首个有效 URL 或裸 BV 号，剥离多余文案与追踪后缀。"""
    if not isinstance(raw, str):
        return ""
    text = raw.strip()
    if not text:
        return ""

    match = _URL_IN_TEXT_RE.search(text)
    if match:
        candidate = match.group(0).rstrip(_TRAILING_PUNCT)
        return _strip_tracking_params(candidate)

    # 无 http 链接但包含裸 BV 号（避免误把本地文件路径当成网络口令）
    if not re.match(r"^[a-zA-Z]:[\\/]", text) and not text.startswith(("/", "\\", "./", "../")):
        bv_match = _BARE_BV_RE.search(text)
        if bv_match:
            return f"https://www.bilibili.com/video/{bv_match.group(1)}"

    return text


def detect_video_platform(raw_url: str) -> Optional[str]:
    """根据链接或分享口令自动识别视频平台。"""
    cleaned = extract_url_from_share_text(raw_url)
    if not cleaned:
        return None
    parsed = urlparse(cleaned)
    host = (parsed.hostname or "").lower()
    if host.startswith("www."):
        host = host[4:]

    if host in ("bilibili.com", "m.bilibili.com", "b23.tv") or host.endswith(".bilibili.com"):
        return "bilibili"
    if host in ("youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be") or host.endswith(".youtube.com"):
        return "youtube"
    if host in ("kuaishou.com", "v.kuaishou.com", "gifshow.com") or host.endswith(".kuaishou.com") or host.endswith(".gifshow.com"):
        return "kuaishou"
    if host in ("douyin.com", "v.douyin.com", "iesdouyin.com") or host.endswith(".douyin.com"):
        return "douyin"
    if _BARE_BV_RE.search(cleaned) and not parsed.scheme:
        return "bilibili"
    return None


def extract_video_id(url: str, platform: str) -> Optional[str]:
    """
    从视频链接中提取视频 ID

    :param url: 视频链接或分享口令
    :param platform: 平台名（bilibili / youtube / douyin / kuaishou）
    :return: 提取到的视频 ID 或 None
    """
    url = extract_url_from_share_text(url)
    if platform == "bilibili":
        # 如果是短链接，则解析真实链接
        if "b23.tv" in url:
            resolved_url = resolve_bilibili_short_url(url)
            if resolved_url:
                url = resolved_url

        # 匹配 BV号（如 BV1vc411b7Wa）
        match = re.search(r"BV([0-9A-Za-z]+)", url)
        return f"BV{match.group(1)}" if match else None

    elif platform == "youtube":
        # 匹配 v=xxxxx、youtu.be/xxxxx、shorts/xxxxx、live/xxxxx 或 embed/xxxxx，ID 长度通常为 11
        match = re.search(r"(?:[?&]v=|youtu\.be/|(?:shorts|live|embed)/)([0-9A-Za-z_-]{11})", url)
        return match.group(1) if match else None

    elif platform == "douyin":
        # 匹配 douyin.com/video/1234567890123456789
        match = re.search(r"/video/(\d+)", url)
        return match.group(1) if match else None

    elif platform == "kuaishou":
        match = re.search(r"(?:/short-video/|/fw/photo/|/f/|v\.kuaishou\.com/)([0-9A-Za-z_-]+)", url)
        return match.group(1) if match else None

    return None


def normalize_video_url(url: str) -> str:
    """
    提取并规范化视频链接（支持分享口令、裸 BV 号、移动版与短链）。

    - B 站含 BV 号链接（含 m.bilibili.com、稍后再看、收藏夹、带追踪参数）规范化为标准 /video/BVxxx(?p=N)。
    - b23.tv 短链保留短链主体并剥离多余追踪参数。
    - YouTube / 快手 / 其他网络链接提取首个有效 URL 并剥离无关追踪参数。
    """
    cleaned = extract_url_from_share_text(url)
    if not cleaned:
        return cleaned

    parsed = urlparse(cleaned)
    host = (parsed.hostname or "").lower()
    if host == "b23.tv":
        return cleaned

    if host in ("bilibili.com", "www.bilibili.com", "m.bilibili.com") or host.endswith(".bilibili.com"):
        match = re.search(r"BV([0-9A-Za-z]+)", cleaned)
        if not match:
            return cleaned
        normalized = f"https://www.bilibili.com/video/BV{match.group(1)}"
        p = extract_bilibili_p_number(cleaned)
        if p:
            normalized += f"?p={p}"
        return normalized

    return cleaned


def resolve_bilibili_short_url(short_url: str) -> Optional[str]:
    """
    解析哔哩哔哩短链接以获取真实视频链接

    :param short_url: Bilibili短链接（如"https://b23.tv/xxxxxx"）
    :return: 真实的视频链接或None
    """
    try:
        response = requests.head(short_url, allow_redirects=True)
        return response.url
    except requests.RequestException as e:
        print(f"Error resolving short URL: {e}")
        return None


def extract_bilibili_p_number(url: str) -> Optional[int]:
    """
    从 B 站分 P 视频 URL 中提取 p 参数（分 P 序号）。

    支持格式：
      - https://www.bilibili.com/video/BVxxx/?p=36
      - https://www.bilibili.com/video/BVxxx?p=5
      - https://b23.tv/xxxxx?p=10
      - https://www.bilibili.com/video/BVxxx/pN (尾缀形式)

    :param url: B 站视频链接
    :return: 分 P 序号（从 1 开始），非分 P 视频返回 None
    """
    if "b23.tv" in url:
        url = resolve_bilibili_short_url(url) or url

    # 匹配 ?p=NNN 或 &p=NNN
    match = re.search(r'[?&]p=(\d+)', url)
    if match:
        p = int(match.group(1))
        if p >= 1:
            return p

    # 匹配 /pN 尾缀形式（较少见）
    match = re.search(r'/p(\d+)(?:/?$|\?|&)', url)
    if match:
        p_val = int(match.group(1))
        if p_val >= 1:
            return p_val

    return None
