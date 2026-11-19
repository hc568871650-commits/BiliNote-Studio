from pydantic import AnyUrl, BaseModel, field_validator, model_validator
import re
from typing import Optional
from urllib.parse import urlparse

from app.utils.url_parser import detect_video_platform, normalize_video_url

SUPPORTED_PLATFORMS = {
    "bilibili": r"^https?://(?:(?:www|m)\.)?bilibili\.com/video/[a-zA-Z0-9]+",
    "youtube": r"^https?://(?:(?:www|m|music)\.)?(?:youtube\.com/(?:watch\?(?:[^#]*&)?v=|shorts/|live/|embed/)|youtu\.be/)[\w\-]{6,}",
    "kuaishou": r"^https?://(?:(?:www|v|m)\.)?(?:kuaishou\.com|gifshow\.com)/",
}


def is_supported_video_url(url: str) -> bool:
    cleaned = normalize_video_url(str(url or ""))
    parsed = urlparse(cleaned)
    host = (parsed.hostname or "").lower()

    # 检查是否为 Bilibili 的短链接
    if host == "b23.tv" and parsed.path.strip("/"):
        return True

    for pattern in SUPPORTED_PLATFORMS.values():
        if re.match(pattern, cleaned, re.IGNORECASE):
            return True
    return False


class VideoRequest(BaseModel):
    url: AnyUrl
    platform: Optional[str] = None

    @model_validator(mode="before")
    @classmethod
    def normalize_url(cls, data):
        if isinstance(data, dict) and data.get("url"):
            cleaned = normalize_video_url(str(data["url"]))
            data["url"] = cleaned
            detected = detect_video_platform(cleaned)
            if detected:
                data["platform"] = detected
        return data

    @field_validator("url")
    def validate_video_url(cls, v):
        if not is_supported_video_url(str(v)):
            raise ValueError("暂不支持该视频平台或链接格式无效")
        return v
