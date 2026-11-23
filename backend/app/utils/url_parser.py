import hashlib
import ipaddress
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
# 仅对 X (Twitter) 链接剥离，避免误伤 YouTube ?t=123s 时间戳参数
_X_TRACKING_PARAM_EXACT = {"s", "t", "ref_src", "ref_url", "src"}
_X_HOSTS = {
    "x.com",
    "twitter.com",
    "mobile.twitter.com",
    "fxtwitter.com",
    "vxtwitter.com",
    "fixupx.com",
    "t.co",
}
_X_MIRROR_HOSTS = {
    "twitter.com",
    "mobile.twitter.com",
    "fxtwitter.com",
    "vxtwitter.com",
    "fixupx.com",
}


def _is_x_host(host: str) -> bool:
    clean = (host or "").lower()
    if clean.startswith("www."):
        clean = clean[4:]
    return (
        clean in _X_HOSTS
        or clean.endswith(".x.com")
        or clean.endswith(".twitter.com")
        or clean.endswith(".fxtwitter.com")
        or clean.endswith(".vxtwitter.com")
        or clean.endswith(".fixupx.com")
    )


def _strip_tracking_params(url: str) -> str:
    parsed = urlparse(url)
    if not parsed.scheme or not parsed.netloc or not parsed.query:
        return url
    is_x = _is_x_host(parsed.hostname or "")
    filtered = [
        (k, v)
        for k, v in parse_qsl(parsed.query, keep_blank_values=False)
        if k.lower() not in _TRACKING_PARAM_EXACT
        and not k.lower().startswith("utm_")
        and not (is_x and k.lower() in _X_TRACKING_PARAM_EXACT)
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


def _is_public_web_host(host: str) -> bool:
    clean = (host or "").lower().rstrip(".")
    if not clean or "." not in clean:
        return False
    if clean in ("localhost",) or clean.endswith((".localhost", ".local", ".internal", ".test", ".invalid")):
        return False
    try:
        addr = ipaddress.ip_address(clean)
    except ValueError:
        if all(part.isdigit() for part in clean.split(".")) or clean.startswith("0x"):
            return False
        return True
    return bool(
        addr.is_global
        and not addr.is_multicast
        and not addr.is_unspecified
        and not addr.is_reserved
        and not addr.is_loopback
        and not addr.is_link_local
    )


def detect_video_platform(raw_url: str) -> Optional[str]:
    """根据链接或分享口令自动识别内容平台（含视频、X、小宇宙播客与公开网页文章）。"""
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
    if _is_x_host(host):
        return "x"
    if host in ("xiaoyuzhoufm.com", "m.xiaoyuzhoufm.com") or host.endswith(".xiaoyuzhoufm.com"):
        return "xiaoyuzhou"
    if host in ("kuaishou.com", "v.kuaishou.com", "gifshow.com") or host.endswith(".kuaishou.com") or host.endswith(".gifshow.com"):
        return "kuaishou"
    if host in ("douyin.com", "v.douyin.com", "iesdouyin.com") or host.endswith(".douyin.com"):
        return "douyin"
    if parsed.scheme in ("http", "https") and _is_public_web_host(host):
        return "web"
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

    elif platform == "x":
        parsed = urlparse(url)
        host = (parsed.hostname or "").lower()
        if host == "t.co":
            resolved = resolve_x_short_url(url)
            if resolved:
                url = resolved
        match = re.search(
            r"/(?:status|statuses|article|articles|broadcasts|spaces)/([0-9A-Za-z_-]+)",
            url,
            re.IGNORECASE,
        )
        return match.group(1) if match else None

    elif platform == "xiaoyuzhou":
        match = re.search(r"/episode/([0-9A-Za-z_-]+)", url, re.IGNORECASE)
        return match.group(1) if match else None

    elif platform == "web":
        parsed = urlparse(url)
        if parsed.scheme in ("http", "https") and parsed.hostname:
            return hashlib.sha256(url.encode("utf-8")).hexdigest()[:16]
        return None

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

    clean_host = host[4:] if host.startswith("www.") else host
    if _is_x_host(clean_host) and clean_host != "t.co":
        path = re.sub(r"/statuses/", "/status/", parsed.path, flags=re.IGNORECASE).rstrip("/")
        if re.search(r"/(?:status|article|articles|broadcasts|spaces)/[0-9A-Za-z_-]+", path, re.IGNORECASE):
            return urlunparse(parsed._replace(scheme="https", netloc="x.com", path=path, fragment=""))

    if clean_host in ("xiaoyuzhoufm.com", "m.xiaoyuzhoufm.com") or clean_host.endswith(".xiaoyuzhoufm.com"):
        ep = re.search(r"/episode/([0-9A-Za-z_-]+)", parsed.path, re.IGNORECASE)
        if ep:
            return f"https://www.xiaoyuzhoufm.com/episode/{ep.group(1)}"

    return cleaned


def resolve_x_short_url(short_url: str, proxy_url: Optional[str] = None) -> Optional[str]:
    """解析 t.co 短链以获取真实目标链接（自动复用全局代理）。"""
    proxies = None
    if proxy_url is None:
        try:
            from app.services.proxy_config_manager import ProxyConfigManager
            proxy_url = ProxyConfigManager().get_proxy_url()
        except Exception:
            proxy_url = None
    if proxy_url:
        proxies = {"http": proxy_url, "https": proxy_url}
    try:
        response = requests.head(short_url, allow_redirects=True, timeout=10, proxies=proxies)
        if response.url and response.url != short_url:
            return _strip_tracking_params(response.url)
        response = requests.get(short_url, allow_redirects=True, timeout=10, proxies=proxies, stream=True)
        resolved = response.url
        response.close()
        return _strip_tracking_params(resolved) if resolved else None
    except requests.RequestException:
        return None


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
