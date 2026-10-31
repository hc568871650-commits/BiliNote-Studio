"""Per-provider/model input budgets; configured capacity is not a live capability test."""
import hashlib
import json
import os
from pathlib import Path
import threading

SETTINGS_PATH = Path('data') / 'model_context.json'
LOCK = threading.RLock()
DEFAULT_USER_LIMIT = 272000
UNKNOWN_MODEL_WINDOW = 65536
DEFAULT_OUTPUT_RESERVE = 4096
MIN_INPUT_LIMIT = 4096
MAX_MODEL_WINDOW = 4000000


def _identity(provider_id, model_name):
    if (not isinstance(provider_id, str) or not provider_id.strip() or len(provider_id) > 100
            or not isinstance(model_name, str) or not model_name.strip() or len(model_name) > 200):
        raise ValueError('请选择服务商和模型')
    return hashlib.sha256(json.dumps([provider_id, model_name], ensure_ascii=False).encode('utf-8')).hexdigest()


def _integer(value, name, minimum, maximum):
    if not isinstance(value, int) or isinstance(value, bool) or not minimum <= value <= maximum:
        raise ValueError(f'{name}须为 {minimum:,} 至 {maximum:,} 之间的整数')
    return value


def _profile(model_window=None, user_limit=DEFAULT_USER_LIMIT, output_reserve=DEFAULT_OUTPUT_RESERVE):
    if model_window is not None:
        _integer(model_window, '模型窗口', 8192, MAX_MODEL_WINDOW)
    _integer(user_limit, '用户预算', 8192, DEFAULT_USER_LIMIT)
    _integer(output_reserve, '输出预留', 512, 65536)
    if min(user_limit, model_window or UNKNOWN_MODEL_WINDOW) - output_reserve < MIN_INPUT_LIMIT:
        raise ValueError('扣除输出预留后，输入预算至少需要 4,096 tokens')
    return {'model_window': model_window, 'user_limit': user_limit, 'output_reserve': output_reserve}


def _store():
    if not SETTINGS_PATH.exists():
        return {'schema_version': 1, 'profiles': {}}
    value = json.loads(SETTINGS_PATH.read_text(encoding='utf-8'))
    if not isinstance(value, dict) or value.get('schema_version') != 1 or not isinstance(value.get('profiles'), dict):
        raise ValueError('上下文配置格式无效，原文件已保留')
    return value


def resolve(provider_id, model_name, user_limit=None):
    """Return the effective input budget without writing or guessing relay limits."""
    key = _identity(provider_id, model_name)
    with LOCK:
        saved = _store()['profiles'].get(key, {})
        profile = _profile(**{name: saved.get(name, default) for name, default in (
            ('model_window', None), ('user_limit', DEFAULT_USER_LIMIT), ('output_reserve', DEFAULT_OUTPUT_RESERVE))})
    requested = profile['user_limit'] if user_limit is None else _integer(user_limit, '本次预算', 8192, DEFAULT_USER_LIMIT)
    input_limit = min(profile['user_limit'], requested, profile['model_window'] or UNKNOWN_MODEL_WINDOW) - profile['output_reserve']
    if input_limit < MIN_INPUT_LIMIT:
        raise ValueError('本次预算扣除输出预留后不足 4,096 tokens，请调整上下文设置')
    manual = profile['model_window'] is not None
    return {'provider_id': provider_id, 'model_name': model_name, **profile,
            'source': 'manual' if manual else 'unknown',
            'source_label': '手动声明（未核实）' if manual else '容量未知（按 65,536 处理）',
            'verified': False, 'effective_window': profile['model_window'] or UNKNOWN_MODEL_WINDOW,
            'input_limit': input_limit, 'compact_threshold': int(input_limit * .8)}


def settings(provider_id, model_name):
    return resolve(provider_id, model_name)


def save_settings(provider_id, model_name, model_window=None, user_limit=DEFAULT_USER_LIMIT,
                  output_reserve=DEFAULT_OUTPUT_RESERVE):
    key = _identity(provider_id, model_name)
    profile = _profile(model_window, user_limit, output_reserve)
    with LOCK:
        value = _store()
        value['profiles'][key] = {'provider_id': provider_id, 'model_name': model_name, **profile}
        SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
        temporary = SETTINGS_PATH.with_suffix('.tmp')
        temporary.write_text(json.dumps(value, ensure_ascii=False), encoding='utf-8')
        os.replace(temporary, SETTINGS_PATH)
        return settings(provider_id, model_name)
