"""Normalize provider search evidence without interpreting prose URLs as citations."""
import hashlib
from urllib.parse import urlsplit


def sources(entries):
    result, seen = [], set()
    for item in entries:
        if not isinstance(item, dict):
            continue
        url = item.get('url')
        if not isinstance(url, str) or len(url) > 4096:
            continue
        try:
            parsed = urlsplit(url)
            parsed.port
        except ValueError:
            continue
        if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password or url in seen:
            continue
        seen.add(url)
        result.append({'source_type': 'web', 'source_id': 'web-' + hashlib.sha256(url.encode()).hexdigest()[:16],
                       'url': url, 'title': str(item.get('title') or parsed.hostname)[:300],
                       'text': str(item.get('cited_text') or '')[:1200]})
        if len(result) >= 30:
            break
    return result


def chat_sources(annotations):
    return sources(item.get('url_citation') or item for item in annotations
                   if isinstance(item, dict) and item.get('type') == 'url_citation')


def attach_chat_search(response):
    choices = getattr(response, 'choices', None) or []
    annotations = []
    if choices:
        for item in getattr(choices[0].message, 'annotations', None) or []:
            annotations.append(item.model_dump() if hasattr(item, 'model_dump') else item)
    response.web_sources = chat_sources(annotations)
    response.web_search_used = bool(response.web_sources)


def anthropic_search(blocks):
    calls = {b['id'] for b in blocks if b.get('type') == 'server_tool_use' and b.get('name') == 'web_search'
             and isinstance(b.get('id'), str) and b['id']}
    entries, used = [], False
    for block in blocks:
        if block.get('type') == 'web_search_tool_result' and block.get('tool_use_id') in calls:
            content = block.get('content')
            if isinstance(content, dict) and content.get('type') == 'web_search_tool_result_error':
                from app.utils.ai_errors import ProtocolResponseError
                raise ProtocolResponseError({'type': 'web_search_error', 'code': content.get('error_code'),
                                             'message': '服务商原生搜索失败：' + str(content.get('error_code') or 'unknown')})
            if isinstance(content, list):
                used = True
                entries.extend(item for item in content if isinstance(item, dict) and item.get('type') == 'web_search_result')
        elif block.get('type') == 'text':
            entries.extend(item for item in block.get('citations') or []
                           if isinstance(item, dict) and item.get('type') == 'web_search_result_location')
    return used, sources(entries)
