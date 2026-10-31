"""Opt-in external search, independent of model-native web tools."""
import json
import hashlib
import os
import re
import threading
import ipaddress
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit, unquote

import httpx

SETTINGS_PATH = Path('data') / 'web_search.json'
LOCK = threading.RLock()
TAVILY_BASE_URL = 'https://api.tavily.com'


def _store():
    with LOCK:
        value = json.loads(SETTINGS_PATH.read_text(encoding='utf-8')) if SETTINGS_PATH.exists() else {}
        profiles = {name: {'base_url': '', 'api_key': ''} for name in ('searxng', 'tavily')}
        profiles['tavily']['base_url'] = TAVILY_BASE_URL
        provider = value.get('provider', 'searxng')
        if value.get('schema_version') == 2:
            for name in profiles:
                profile = value.get('profiles', {}).get(name, {})
                profiles[name] = {key: profile.get(key, profiles[name][key]) for key in ('base_url', 'api_key')}
        elif provider in profiles:
            profiles[provider] = {key: value.get(key, '') for key in ('base_url', 'api_key')}
        return {'schema_version': 2, 'enabled': value.get('enabled', False),
                'provider': provider, 'profiles': profiles}


def _settings():
    value = _store()
    return {'enabled': value['enabled'], 'provider': value['provider'],
            **value['profiles'].get(value['provider'], {'base_url': '', 'api_key': ''})}


def settings():
    value = _store()
    profiles = {name: {**profile, 'api_key': '********' if profile['api_key'] else ''}
                for name, profile in value['profiles'].items()}
    return {'enabled': value['enabled'], 'provider': value['provider'],
            **profiles.get(value['provider'], {'base_url': '', 'api_key': ''}), 'profiles': profiles}


def available():
    value = _settings()
    return bool(value['enabled'] and value['base_url'] and
                (value['provider'] == 'searxng' or
                 (value['provider'] == 'tavily' and value['api_key'] and value['base_url'] == TAVILY_BASE_URL)))


def page_read_available():
    return available()


def public_page_url(url, secrets=()):
    if not isinstance(url, str) or len(url) > 4000 or any(c.isspace() for c in url) or '\\' in url:
        raise ValueError('网页地址必须为公开 HTTP(S) 地址')
    sanitize_search_query(unquote(url), secrets)
    parsed = urlsplit(url)
    host = (parsed.hostname or '').lower().rstrip('.')
    if (parsed.scheme not in ('http', 'https') or not host or parsed.username or parsed.password
            or parsed.port not in (None, 80, 443) or '.' not in host
            or host.endswith(('.localhost', '.local', '.internal', '.test', '.invalid'))):
        raise ValueError('只允许读取公开网页，不接受本地地址或凭据')
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        if all(part.isdigit() for part in host.split('.')) or host.startswith('0x'):
            raise ValueError('不接受非常规 IP 地址') from None
    else:
        if (not address.is_global or address.is_multicast or address.is_unspecified
                or address.is_reserved or address.is_loopback or address.is_link_local):
            raise ValueError('不接受私有或保留 IP 地址')
    return urlunsplit((parsed.scheme.lower(), parsed.netloc.lower(), parsed.path or '/', parsed.query, ''))


def read_web_page(url, cancellation=None):
    from app.services.web_page import read_page
    store = _store()
    secrets = tuple(profile['api_key'] for profile in store['profiles'].values())
    return read_page(url, secrets=secrets, cancellation=cancellation)



def _profile(provider, base_url, api_key, previous):
    if provider not in ('searxng', 'tavily'):
        raise ValueError('不支持的外部检索服务')
    base_url = base_url.strip().rstrip('/')
    if provider == 'tavily':
        if base_url not in ('', TAVILY_BASE_URL, TAVILY_BASE_URL + '/search'):
            raise ValueError('Tavily 只能使用官方地址 https://api.tavily.com')
        base_url = TAVILY_BASE_URL
    if base_url:
        parts = urlsplit(base_url)
        if parts.scheme not in ('http', 'https') or not parts.hostname or parts.username or parts.password or parts.query or parts.fragment:
            raise ValueError('检索服务地址必须是 HTTP(S) 地址，不能包含密钥、查询参数或片段')
        parts.port
    if api_key == '********':
        api_key = previous['api_key']
    elif '*' in api_key:
        raise ValueError('请填写完整检索密钥，或保留原掩码')
    return {'base_url': base_url, 'api_key': api_key.strip()}


def _validate_active(value):
    provider = value['provider']
    if provider not in ('searxng', 'tavily'):
        raise ValueError('不支持的外部检索服务')
    profile = value['profiles'][provider]
    if value['enabled']:
        _profile(provider, profile['base_url'], profile['api_key'], profile)
        if provider == 'tavily' and (profile['base_url'] != TAVILY_BASE_URL or not profile['api_key']):
            raise ValueError('请先填写 Tavily API Key，再启用外部检索')
        if not profile['base_url']:
            raise ValueError('请先填写支持 JSON 搜索的 SearXNG 地址')


def _write(value):
    _validate_active(value)
    # Keep the active flat configuration readable by earlier backend releases.
    value.update(value['profiles'][value['provider']])
    SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
    temporary = SETTINGS_PATH.with_suffix('.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False), encoding='utf-8')
    os.replace(temporary, SETTINGS_PATH)


def save_settings(enabled, base_url, api_key='********', provider='searxng'):
    with LOCK:
        value = _store()
        value['profiles'][provider] = _profile(provider, base_url, api_key, value['profiles'].get(provider, {}))
        value.update(enabled=bool(enabled), provider=provider)
        _write(value)
    return settings()


def save_profile(provider, base_url, api_key='********'):
    with LOCK:
        value = _store()
        value['profiles'][provider] = _profile(provider, base_url, api_key, value['profiles'].get(provider, {}))
        _write(value)
    return settings()


def save_selection(**changes):
    if not changes or any(key not in ('enabled', 'provider') or val is None for key, val in changes.items()):
        raise ValueError('请提供外部检索开关或服务')
    with LOCK:
        value = _store()
        value.update(changes)
        _write(value)
    return settings()


def sanitize_search_query(query, secrets=()):
    if not isinstance(query, str) or not query.strip() or len(query) > 4000:
        raise ValueError('检索问题必须为 1–4000 字，不发送整段上下文')
    if any(isinstance(secret, str) and secret and secret in query for secret in secrets) or re.search(r'(?i)\bsk-[\w-]{8,}|\bBearer\s+\S+|(?:api[_ -]?key|authorization|cookie|access[_ -]?token)\s*[:=]', query):
        raise ValueError('检索问题可能包含密钥或凭据，请移除后再联网')
    return query.strip()


def search_web(query):
    store = _store()
    value = {'enabled': store['enabled'], 'provider': store['provider'],
             **store['profiles'].get(store['provider'], {'base_url': '', 'api_key': ''})}
    if not value['enabled'] or not value['base_url']:
        raise ValueError('尚未配置外部检索服务，请在 AI 用途与模型中设置，或使用已支持的原生联网')
    if value['provider'] not in ('searxng', 'tavily'):
        raise ValueError('不支持的外部检索服务')
    tavily = value['provider'] == 'tavily'
    if tavily and value['base_url'] != TAVILY_BASE_URL:
        raise ValueError('Tavily 只能使用官方地址 https://api.tavily.com')
    if tavily and not value['api_key']:
        raise ValueError('请先填写 Tavily API Key，再启用外部检索')
    query = sanitize_search_query(query, tuple(profile['api_key'] for profile in store['profiles'].values()))
    endpoint = value['base_url'] if value['base_url'].endswith('/search') else value['base_url'] + '/search'
    headers = {'Accept': 'application/json'}
    if value['api_key']:
        headers['Authorization'] = 'Bearer ' + value['api_key']
    request_options = {'json': {'query': query, 'search_depth': 'basic', 'auto_parameters': False,
                               'max_results': 6, 'topic': 'general', 'include_answer': False,
                               'include_raw_content': False, 'include_images': False}} if tavily else {
                                   'params': {'q': query, 'format': 'json'}}
    try:
        with httpx.Client(timeout=25.0, follow_redirects=False) as client:
            with client.stream('POST' if tavily else 'GET', endpoint, headers=headers, **request_options) as response:
                payload = bytearray()
                for chunk in response.iter_bytes():
                    payload.extend(chunk)
                    if len(payload) > 2 * 1024 * 1024:
                        raise ValueError('检索服务响应过大')
                # Bound error bodies too, while retaining status and request ID.
                if response.is_error:
                    bounded_response = httpx.Response(response.status_code, headers=response.headers,
                                                      content=bytes(payload), request=response.request)
                    bounded_response.raise_for_status()
                response.raise_for_status()
        data = json.loads(payload)
        if not isinstance(data, dict) or not isinstance(data.get('results'), list):
            raise ValueError('检索服务没有返回 ' + ('Tavily' if tavily else 'SearXNG') + ' JSON results')
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
        details = error_details(exc, 'external-search', value['api_key'])
        if tavily:
            messages = {401: 'Tavily API Key 无效，请检查检索密钥',
                        429: 'Tavily 请求过于频繁，请稍后手动重试',
                        432: 'Tavily 套餐额度已用完，请检查额度或等待重置',
                        433: 'Tavily 按量付费额度已用完，请检查账户额度'}
            if details['http_status'] in messages:
                details['detail'] = messages[details['http_status']]
        raise SafeAIError(details) from None
