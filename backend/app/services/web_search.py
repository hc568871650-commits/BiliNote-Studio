"""Opt-in search through a user-configured SearXNG JSON endpoint."""
import json
import hashlib
import os
import re
import threading
from pathlib import Path
from urllib.parse import urlsplit

import httpx

SETTINGS_PATH = Path('data') / 'web_search.json'
LOCK = threading.RLock()


def _settings():
    with LOCK:
        if not SETTINGS_PATH.exists():
            return {'enabled': False, 'base_url': '', 'api_key': ''}
        value = json.loads(SETTINGS_PATH.read_text(encoding='utf-8'))
        return {key: value.get(key, default) for key, default in [('enabled', False), ('base_url', ''), ('api_key', '')]}


def settings():
    value = _settings()
    return {**value, 'api_key': '********' if value['api_key'] else '', 'provider': 'searxng'}


def available():
    value = _settings()
    return bool(value['enabled'] and value['base_url'])


def save_settings(enabled, base_url, api_key='********'):
    base_url = base_url.strip().rstrip('/')
    if base_url:
        parts = urlsplit(base_url)
        if parts.scheme not in ('http', 'https') or not parts.hostname or parts.username or parts.password or parts.query or parts.fragment:
            raise ValueError('检索服务地址必须是 HTTP(S) 地址，不能包含密钥、查询参数或片段')
        parts.port
    if enabled and not base_url:
        raise ValueError('请先填写支持 JSON 搜索的 SearXNG 地址')
    with LOCK:
        previous = _settings()
        if api_key == '********':
            api_key = previous['api_key']
        elif '*' in api_key:
            raise ValueError('请填写完整检索密钥，或保留原掩码')
        SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
        temporary = SETTINGS_PATH.with_suffix('.tmp')
        temporary.write_text(json.dumps({'enabled': bool(enabled), 'base_url': base_url, 'api_key': api_key}, ensure_ascii=False), encoding='utf-8')
        os.replace(temporary, SETTINGS_PATH)
    return settings()


def sanitize_search_query(query, secrets=()):
    if not isinstance(query, str) or not query.strip() or len(query) > 4000:
        raise ValueError('检索问题必须为 1–4000 字，不发送整段上下文')
    if any(isinstance(secret, str) and secret and secret in query for secret in secrets) or re.search(r'(?i)\bsk-[\w-]{8,}|\bBearer\s+\S+|(?:api[_ -]?key|authorization|cookie|access[_ -]?token)\s*[:=]', query):
        raise ValueError('检索问题可能包含密钥或凭据，请移除后再联网')
    return query.strip()


def search_web(query):
    value = _settings()
    if not value['enabled'] or not value['base_url']:
        raise ValueError('尚未配置外部检索服务，请在 AI 用途与模型中设置，或使用已支持的原生联网')
    query = sanitize_search_query(query, (value['api_key'],))
    endpoint = value['base_url'] if value['base_url'].endswith('/search') else value['base_url'] + '/search'
    headers = {'Accept': 'application/json'}
    if value['api_key']:
        headers['Authorization'] = 'Bearer ' + value['api_key']
    try:
        with httpx.Client(timeout=25.0, follow_redirects=False) as client:
            with client.stream('GET', endpoint, params={'q': query.strip(), 'format': 'json'}, headers=headers) as response:
                response.raise_for_status()
                payload = bytearray()
                for chunk in response.iter_bytes():
                    payload.extend(chunk)
                    if len(payload) > 2 * 1024 * 1024:
                        raise ValueError('检索服务响应过大')
        data = json.loads(payload)
        if not isinstance(data, dict) or not isinstance(data.get('results'), list):
            raise ValueError('检索服务没有返回 SearXNG JSON results')
        sources, seen = [], set()
        for item in data['results']:
            if not isinstance(item, dict):
                continue
            url = item.get('url', '')
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
            sources.append({'source_type': 'web', 'source_id': 'web-' + hashlib.sha256(url.encode()).hexdigest()[:16], 'url': url,
                            'title': str(item.get('title') or parsed.hostname)[:300],
                            'text': re.sub('<[^>]*>', '', str(item.get('content') or ''))[:1500]})
            if len(sources) == 6:
                break
        if not sources:
            raise ValueError('外部检索没有返回可引用的结果，本次未假装联网成功')
        return sources
    except Exception as exc:
        from app.utils.ai_errors import SafeAIError, error_details
        raise SafeAIError(error_details(exc, 'external-search', value['api_key'])) from None
