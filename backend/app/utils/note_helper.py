import re
from urllib.parse import quote, urlencode


def prepend_source_link(markdown: str | None, source_url: str) -> str | None:
    """
    在笔记开头添加来源链接；若首个非空行已包含来源链接，则更新该行并避免重复。
    """
    if markdown is None:
        return None

    source = (source_url or "").strip()
    if not source:
        return markdown

    header = f"> 来源链接：{source}"
    lines = markdown.splitlines()
    first_non_empty_idx = None
    for idx, line in enumerate(lines):
        if line.strip():
            first_non_empty_idx = idx
            break

    if first_non_empty_idx is not None:
        first_line = lines[first_non_empty_idx].strip()
        if first_line.startswith("> 来源链接：") or first_line.startswith("来源链接："):
            lines[first_non_empty_idx] = header
            return "\n".join(lines)

    if markdown.strip():
        return f"{header}\n\n{markdown}"
    return header


def replace_content_markers(markdown: str, video_id: str, platform: str = 'bilibili') -> str:
    """
    将 Content 标记中的累计分钟 MM:SS 或 HH:MM:SS 替换为原片时间链接。
    """
    # MM:SS 支持累计分钟；HH:MM:SS 保留小时，且不匹配非法时间的一部分。
    pattern = r"(?<![\w-])\*?Content-(?:\[(\d+:\d{2}(?::\d{2})?)\]|(\d+:\d{2}(?::\d{2})?))(?![\w:]|\.\d)\*?"

    def replacer(match):
        timestamp = match.group(1) or match.group(2)
        parts = [int(part) for part in timestamp.split(':')]
        if parts[-1] >= 60 or (len(parts) == 3 and parts[-2] >= 60):
            return match.group(0)
        total_seconds = parts[0] * 60 + parts[1] if len(parts) == 2 else parts[0] * 3600 + parts[1] * 60 + parts[2]

        if platform == 'bilibili':
            part = re.fullmatch(r"(.+)_p([1-9]\d*)", video_id)
            base_id = part.group(1) if part else video_id
            query = {'p': part.group(2), 't': total_seconds} if part else {'t': total_seconds}
            url = f"https://www.bilibili.com/video/{quote(base_id, safe='')}?{urlencode(query)}"
        elif platform == 'youtube':
            url = f"https://www.youtube.com/watch?{urlencode({'v': video_id, 't': str(total_seconds) + 's'})}"
        elif platform == 'douyin':
            url = f"https://www.douyin.com/video/{quote(video_id, safe='')}"
        else:
            return f"({timestamp})"

        return f"[原片 @ {timestamp}]({url})"

    return re.sub(pattern, replacer, markdown)

