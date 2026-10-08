"""Learning metadata, separate from immutable tutorial content and folder membership."""
import copy
import json
import threading
import unicodedata
from pathlib import Path

from app.services import note_storage

STATE_PATH = Path('data') / 'note_library.json'
LOCK = threading.RLock()
DEFAULT = {'favorite': False, 'pinned': False, 'learning_status': 'unread', 'tags': [], 'remark': ''}


class InvalidLibraryState(RuntimeError):
    pass


def _changes(value):
    if not isinstance(value, dict) or not value or set(value) - set(DEFAULT):
        raise ValueError('请提供有效的学习信息字段')
    result = copy.deepcopy(value)
    for key in ('favorite', 'pinned'):
        if key in result and type(result[key]) is not bool:
            raise ValueError('收藏和置顶必须是布尔值')
    if 'learning_status' in result and result['learning_status'] not in ('unread', 'learning', 'done'):
        raise ValueError('学习状态无效')
    if 'remark' in result:
        if not isinstance(result['remark'], str) or len(result['remark']) > 2000:
            raise ValueError('备注最多 2000 字')
        result['remark'] = result['remark'].strip()
    if 'tags' in result:
        tags = result['tags']
        if not isinstance(tags, list) or len(tags) > 10:
            raise ValueError('最多设置 10 个标签')
        normalized, seen = [], set()
        for tag in tags:
            if not isinstance(tag, str):
                raise ValueError('标签必须是文本')
            tag = unicodedata.normalize('NFKC', tag).strip()
            if not tag or len(tag) > 24 or any(unicodedata.category(c).startswith('C') for c in tag):
                raise ValueError('每个标签须为 1 至 24 字，不能含控制字符')
            if tag.casefold() not in seen:
                normalized.append(tag)
                seen.add(tag.casefold())
        result['tags'] = normalized
    return result


def _read():
    if not STATE_PATH.exists():
        return {'schema_version': 1, 'entries': {}}
    try:
        state = json.loads(STATE_PATH.read_text(encoding='utf-8'))
        if not isinstance(state, dict) or state.get('schema_version') != 1 or not isinstance(state.get('entries'), dict):
            raise ValueError('schema')
        for task_id, entry in state['entries'].items():
            note_storage.valid_id(task_id)
            if not isinstance(entry, dict) or set(entry) != set(DEFAULT) or _changes(entry) != entry:
                raise ValueError('entry')
        return state
    except (OSError, ValueError, TypeError) as exc:
        raise InvalidLibraryState('学习记录读取失败，原文件已保留；请检查 data/note_library.json') from exc


def list_entries():
    with LOCK:
        return {'entries': copy.deepcopy(_read()['entries'])}


def update_entries(task_ids, changes):
    if not isinstance(task_ids, list) or not 1 <= len(task_ids) <= 500:
        raise ValueError('每次请选择 1 至 500 篇笔记')
    changes = _changes(changes)
    with LOCK, note_storage.LOCK:
        state = _read()
        for task_id in task_ids:
            note_storage.valid_id(task_id)
            manifest = note_storage._manifest(task_id)
            if not manifest or manifest.get('deletion_pending'):
                raise FileNotFoundError('部分笔记不存在或正在删除，请刷新后重试')
        for task_id in task_ids:
            entry = copy.deepcopy(state['entries'].get(task_id, DEFAULT))
            entry.update(copy.deepcopy(changes))
            state['entries'][task_id] = entry
        note_storage._atomic_json(STATE_PATH, state)
        return {'entries': copy.deepcopy(state['entries'])}
