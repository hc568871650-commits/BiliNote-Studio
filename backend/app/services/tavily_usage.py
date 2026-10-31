"""Read-only official usage lookup, bounded and cached independently of search routing."""
import copy
import hashlib
import json
import math
import threading
import time
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime

import httpx

from app.services import web_search

TTL = 300
MIN_INTERVAL = 65
MAX_BYTES = 64 * 1024
_entries = {}
_lock = threading.Lock()


def _saved_key():
    value = web_search._store()['profiles']['tavily']['api_key']
    return value.strip() if isinstance(value, str) else ''


def _empty(configured=False, error=None):
    return dict(configured=configured, checked_at=None, cached=False, stale=False,
                retry_after_seconds=0, error=error, account=None, key=None)


def _number(value):
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        try:
            if math.isfinite(value) and value >= 0:
                return value
        except OverflowError:
            pass
    return None


def _remaining(used, limit):
    return max(0, limit - used) if used is not None and limit is not None else None


def _normalize(payload):
    if not isinstance(payload, dict) or not any(isinstance(payload.get(k), dict) for k in ('account', 'key')):
        raise ValueError('invalid usage response')
    account = payload.get('account')
    key = payload.get('key')
    result = {'account': None, 'key': None}
    if isinstance(account, dict):
        used, limit = _number(account.get('plan_usage')), _number(account.get('plan_limit'))
        plan = account.get('current_plan')
        result['account'] = dict(plan=plan[:100] if isinstance(plan, str) else None,
                                 used=used, limit=limit, remaining=_remaining(used, limit),
                                 paygo_used=_number(account.get('paygo_usage')),
                                 paygo_limit=_number(account.get('paygo_limit')))
    if isinstance(key, dict):
        used, limit = _number(key.get('usage')), _number(key.get('limit'))
        result['key'] = dict(used=used, limit=limit, remaining=_remaining(used, limit))
    return result


def _retry_seconds(header):
    try:
        delay = float(header)
        if not math.isfinite(delay):
            raise ValueError()
    except (ValueError, TypeError, OverflowError):
        try:
            delay = (parsedate_to_datetime(header) - datetime.now(timezone.utc)).total_seconds()
        except (ValueError, TypeError, OverflowError):
            delay = TTL
    return max(MIN_INTERVAL, math.ceil(delay))


class UsageError(Exception):
    def __init__(self, message, retry=TTL):
        super().__init__(message)
        self.retry = retry


def _fetch(key):
    with httpx.Client(timeout=12, follow_redirects=False) as client:
        with client.stream('GET', 'https://api.tavily.com/usage',
                           headers={'Authorization': 'Bearer ' + key}) as response:
            if response.status_code == 429:
                raise UsageError('额度查询过于频繁，请稍后刷新', _retry_seconds(response.headers.get('Retry-After')))
            if response.status_code in (401, 403):
                raise UsageError('Tavily 密钥无效或无权查询，请检查已保存的 API Key')
            if response.status_code != 200:
                raise UsageError('Tavily 额度服务暂不可用，请稍后刷新')
            body = bytearray()
            for chunk in response.iter_bytes(chunk_size=8192):
                if len(body) + len(chunk) > MAX_BYTES:
                    raise UsageError('Tavily 额度响应过大，请稍后刷新')
                body.extend(chunk)
    try:
        payload = json.loads(body)
        if isinstance(payload, dict) and isinstance(payload.get('account'), dict):
            plan = payload['account'].get('current_plan')
            if isinstance(plan, str) and key in plan:
                payload['account']['current_plan'] = None
        result = _normalize(payload)
    except (ValueError, TypeError, RecursionError):
        raise UsageError('Tavily 额度响应格式异常，请稍后刷新') from None
    return result


def get_usage(refresh=False):
    try:
        key = _saved_key()
    except Exception:
        return _empty(error='无法读取 Tavily 配置，请检查搜索设置')
    if not key:
        return _empty()
    identity = hashlib.sha256(key.encode()).hexdigest()
    with _lock:
        entry = _entries.setdefault(identity, {'lock': threading.Lock(), 'value': None,
                                              'next_attempt': 0, 'expires': 0, 'error': None})
    # The per-key lock coalesces concurrent requests; the settings lock is never held over HTTP.
    with entry['lock']:
        now = time.monotonic()
        cached = True
        if now >= entry['next_attempt'] and (refresh or now >= entry['expires']):
            cached = False
            try:
                value = _fetch(key)
                entry.update(value={**value, 'checked_at': datetime.now(timezone.utc).isoformat()},
                             error=None, expires=time.monotonic() + TTL,
                             next_attempt=time.monotonic() + MIN_INTERVAL)
            except Exception as exc:
                message = str(exc) if isinstance(exc, UsageError) else '无法连接 Tavily 额度服务，请稍后刷新'
                entry.update(error=message, next_attempt=time.monotonic() + (exc.retry if isinstance(exc, UsageError) else TTL))
        try:
            current_key = _saved_key()
        except Exception:
            return _empty(error='无法读取 Tavily 配置，请检查搜索设置')
        if current_key != key:
            return _empty(bool(current_key), 'Tavily 配置已更新，请重新查询额度' if current_key else None)
        result = _empty(True)
        if entry['value']:
            result.update(copy.deepcopy(entry['value']))
        result.update(cached=cached, stale=bool(entry['value'] and (entry['error'] or time.monotonic() >= entry['expires'])),
                      error=entry['error'], retry_after_seconds=max(0, math.ceil(entry['next_attempt'] - time.monotonic())))
        return result
