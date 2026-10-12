"""Bounded keyword retrieval over durable notes, without migration or writes.

Returned text is untrusted reference material, never an application instruction.
Only application IDs enter this service; filesystem locations never leave it.
"""
import hashlib
import json
import math
import re
import threading
import unicodedata
from collections import OrderedDict

from app.services import note_folders, note_library, note_storage

TEXT_BUDGET = 12000
CHUNK_SIZE = 2400
CACHE_MAX_BYTES = 8 * 1024 * 1024
CACHE_MAX_NOTES = 256
_CACHE = OrderedDict()
_CACHE_BYTES = 0
_LOCK = threading.RLock()


def _normalize(value):
    return unicodedata.normalize('NFKC', value).casefold()


def _query_terms(query):
    """Lightweight mixed-language terms; no tokenizer or network dependency."""
    normalized = _normalize(query)
    for phrase in ('请帮我', '帮我', '查找', '查一下', '搜索', '全库', '所有笔记', '笔记中',
                   '相关内容', '相关', '关于', '如何', '怎么', '有哪些', '是什么'):
        normalized = normalized.replace(phrase, ' ')
    terms = re.findall(r'[a-z0-9_]+|[\u3400-\u9fff]+', normalized)
    return list(dict.fromkeys(terms))


def _json(path):
    note_storage._inside(path, note_storage.ROOT)
    if path.is_symlink():
        raise ValueError('Linked content')
    return json.loads(path.read_text(encoding='utf-8'))


def _sections(text):
    """Split headings and large sections; IDs remain stable for a given version."""
    parts, title, lines = [], '正文', []
    fenced = False
    for line in text.splitlines(keepends=True):
        if line.lstrip().startswith(('```', '~~~')):
            fenced = not fenced
        heading = None if fenced else re.match(r'^#{1,6}\s+(.+?)\s*#*\s*$', line)
        if heading:
            if lines:
                parts.append((title, ''.join(lines)))
            title, lines = heading.group(1), [line]
        else:
            lines.append(line)
    if lines:
        parts.append((title, ''.join(lines)))
    return [{'section_id': f's{i + 1}-c{j // CHUNK_SIZE + 1}',
             'section_title': title[:300], 'text': body[j:j + CHUNK_SIZE]}
            for i, (title, body) in enumerate(parts)
            for j in range(0, len(body), CHUNK_SIZE)]


def _cached_sections(note_id, versions):
    global _CACHE_BYTES
    fingerprint = hashlib.sha256(json.dumps(versions, ensure_ascii=False,
                                            sort_keys=True).encode('utf-8')).hexdigest()
    key = (str(note_storage.ROOT.resolve()), note_id)
    with _LOCK:
        found = _CACHE.get(key)
        if found and found[0] == fingerprint:
            _CACHE.move_to_end(key)
            return found[1]
        if found:
            _CACHE_BYTES -= _CACHE.pop(key)[2]
        sections = {v: _sections(content) for v, content in versions.items()}
        size = len(json.dumps(sections, ensure_ascii=False).encode('utf-8'))
        if size <= CACHE_MAX_BYTES:
            _CACHE[key] = (fingerprint, sections, size)
            _CACHE_BYTES += size
            while _CACHE_BYTES > CACHE_MAX_BYTES or len(_CACHE) > CACHE_MAX_NOTES:
                _CACHE_BYTES -= _CACHE.popitem(last=False)[1][2]
        return sections


def _load(folder, note_id, metadata_only=False):
    note_storage._owned(folder)
    manifest = _json(folder / '_meta' / 'manifest.json')
    if manifest.get('deletion_pending'):
        return None
    task = manifest['task']
    if task.get('id') != note_id:
        raise ValueError('Mismatched note ID')
    if metadata_only:
        markdown = task.get('markdown')
        current = (note_storage.valid_id(markdown[0]['ver_id']) if isinstance(markdown, list) and markdown else 'legacy')
        return {'id': note_id, 'title': str((task.get('audioMeta') or {}).get('title') or note_id)[:300],
                'archived': bool(task.get('archived_at')), 'versions': {}, 'transcript': {}, 'version_id': current}
    versions = {}
    markdown = task.get('markdown') or ''
    if isinstance(markdown, str):
        versions['legacy'] = markdown
    elif isinstance(markdown, list):
        for version in markdown:
            version_id = note_storage.valid_id(version['ver_id'])
            path = folder / 'versions' / (version_id + '.md')
            note_storage._inside(path, note_storage.ROOT)
            if path.is_symlink():
                raise ValueError('Linked version')
            content = path.read_text(encoding='utf-8') if path.is_file() else version.get('content', '')
            if not isinstance(content, str):
                raise ValueError('Invalid content')
            versions[version_id] = content
    else:
        raise ValueError('Invalid versions')
    transcript = task.get('transcript') or {}
    if not isinstance(transcript, dict):
        raise ValueError('Invalid transcript')
    return {'id': note_id, 'title': str((task.get('audioMeta') or {}).get('title') or note_id)[:300],
            'archived': bool(task.get('archived_at')), 'versions': _cached_sections(note_id, versions),
            'transcript': transcript}


def _catalog(metadata_only=False):
    warnings, notes, seen = [], [], set()
    root = note_storage.ROOT
    folders = note_folders.list_folders()
    entries = note_library.list_entries()['entries']
    if root.exists():
        for folder in sorted(root.iterdir(), key=lambda p: p.name):
            if not folder.is_dir() or folder.is_symlink() or '__' not in folder.name:
                continue
            note_id = folder.name.rsplit('__', 1)[-1]
            if not note_storage.TASK_ID.fullmatch(note_id):
                continue
            if (root / '_tombstones' / (note_id + '.json')).exists():
                continue
            try:
                if note_id in seen:
                    notes = [n for n in notes if n['id'] != note_id]
                    raise ValueError('Duplicate note')
                seen.add(note_id)
                note = _load(folder, note_id, metadata_only=metadata_only)
                if note:
                    note.update(folder_id=folders['assignments'].get(note_id, note_folders.DEFAULT_ID),
                                tags=entries.get(note_id, {}).get('tags', []))
                    notes.append(note)
            except (OSError, ValueError, TypeError, KeyError, AttributeError):
                warnings.append({'note_id': note_id, 'code': 'unreadable_note',
                                 'message': '此篇笔记不可读取，已跳过；原文件未修改'})
    # Drop deleted entries promptly, even when no subsequent new cache entry is created.
    global _CACHE_BYTES
    with _LOCK:
        prefix = str(root.resolve())
        live_ids = {n['id'] for n in notes}
        for key in list(_CACHE):
            if key[0] == prefix and key[1] not in live_ids:
                _CACHE_BYTES -= _CACHE.pop(key)[2]
    return sorted(notes, key=lambda n: n['id']), folders, warnings


def _paging(offset, limit, maximum):
    if type(offset) is not int or offset < 0 or type(limit) is not int or not 1 <= limit <= maximum:
        raise ValueError(f'offset须为非负整数，limit须为1至{maximum}')


def _source(note, version_id, section):
    sid = section['section_id']
    return {'type': 'note', 'id': f'note:{note["id"]}:{version_id}:{sid}',
            'source_id': f'note:{note["id"]}:{version_id}:{sid}',
            'note_id': note['id'], 'version_id': version_id,
            'title': note['title'], 'archived': note['archived'], 'folder_id': note['folder_id'], **section}


def _page(results, offset, limit, warnings):
    selected, used = [], 0
    for result in results[offset:offset + limit]:
        if used + len(result['text']) > TEXT_BUDGET:
            break
        selected.append(result)
        used += len(result['text'])
    next_offset = offset + len(selected)
    more = next_offset < len(results)
    return {'results': selected, 'total': len(results), 'returned': len(selected), 'offset': offset,
            'has_more': more, 'next_offset': next_offset if more else None,
            'warnings': warnings[:50], 'warning_count': len(warnings), 'text_budget': TEXT_BUDGET}


def search_library(query, filters=None, limit=8, offset=0):
    _paging(offset, limit, 30)
    if not isinstance(query, str) or not query.strip() or len(query) > 500:
        raise ValueError('检索词须为1至500字')
    filters = {} if filters is None else filters
    if not isinstance(filters, dict) or set(filters) - {'folder_id', 'note_ids', 'archived'}:
        raise ValueError('检索过滤条件无效')
    if 'archived' in filters and type(filters['archived']) is not bool:
        raise ValueError('archived须为布尔值')
    ids = filters.get('note_ids')
    if ids is not None:
        if not isinstance(ids, list) or len(ids) > 1000:
            raise ValueError('note_ids须为最多1000个ID的列表')
        ids = {note_storage.valid_id(i) for i in ids}
    folder_id = filters.get('folder_id')
    if folder_id is not None:
        note_storage.valid_id(folder_id)
    browse = query.strip() == '*'
    notes, folders, warnings = _catalog(metadata_only=browse)
    if folder_id is not None and folder_id not in {f['id'] for f in folders['folders']}:
        raise FileNotFoundError('文件夹不存在')
    if ids is not None and not ids.issubset({n['id'] for n in notes}):
        raise FileNotFoundError('部分指定笔记不存在或不可读取')
    if browse:
        results = [_source(note, note['version_id'], {'section_id': 'metadata', 'section_title': '笔记信息',
                    'text': '', 'metadata_only': True, 'tags': note['tags']}) for note in notes
                   if (ids is None or note['id'] in ids) and (folder_id is None or note['folder_id'] == folder_id)
                   and ('archived' not in filters or note['archived'] == filters['archived'])]
        return {**_page(results, offset, limit, warnings), 'matching_note_count': len(results), 'metadata_only': True}
    terms = _query_terms(query)
    if not terms:
        return _page([], offset, limit, warnings)
    results = []
    for note in notes:
        if ids is not None and note['id'] not in ids or folder_id is not None and note['folder_id'] != folder_id:
            continue
        if 'archived' in filters and note['archived'] != filters['archived']:
            continue
        metadata = _normalize(note['title'] + ' ' + ' '.join(note['tags']))
        # Current version only for search; older versions remain explicitly readable.
        version_id = next(iter(note['versions']), 'legacy')
        chunks = note['versions'].get(version_id, []) or [{'section_id': 's0-c1', 'section_title': '元数据', 'text': ''}]
        for section in chunks:
            body = _normalize(section['text'])
            if all(term in metadata or term in body for term in terms):
                score = sum(3 * metadata.count(term) + body.count(term) for term in terms)
                results.append((score, _source(note, version_id, section)))
    results.sort(key=lambda item: (-item[0], item[1]['source_id']))
    return _page([r for _, r in results], offset, limit, warnings)


def _find_note(note_id):
    note_storage.valid_id(note_id)
    notes, _, warnings = _catalog()
    note = next((n for n in notes if n['id'] == note_id), None)
    if note is None:
        raise FileNotFoundError('笔记不存在或不可读取')
    return note, warnings


def read_note_sections(note_id, version_id=None, section_ids=None, offset=0, limit=4):
    _paging(offset, limit, 30)
    if version_id is not None:
        note_storage.valid_id(version_id)
    if section_ids is not None and (not isinstance(section_ids, list) or len(section_ids) > 100
                                   or any(not isinstance(s, str) for s in section_ids)):
        raise ValueError('章节ID须为最多100项的列表')
    note, warnings = _find_note(note_id)
    version_id = version_id or next(iter(note['versions']), 'legacy')
    if version_id not in note['versions']:
        raise FileNotFoundError('笔记版本不存在')
    sections = note['versions'][version_id]
    if section_ids is not None:
        if not set(section_ids).issubset({s['section_id'] for s in sections}):
            raise FileNotFoundError('笔记章节不存在')
        sections = [s for s in sections if s['section_id'] in section_ids]
    return _page([_source(note, version_id, s) for s in sections], offset, limit, warnings)


def lookup_note_transcript(note_id, keyword='', start_time=None, end_time=None, offset=0, limit=30):
    _paging(offset, limit, 100)
    if not isinstance(keyword, str) or len(keyword) > 500:
        raise ValueError('转录关键词无效')
    for value in (start_time, end_time):
        if value is not None and (type(value) not in (int, float) or not math.isfinite(value) or value < 0):
            raise ValueError('时间须为非负有限数字')
    if start_time is not None and end_time is not None and start_time > end_time:
        raise ValueError('时间范围无效')
    note, warnings = _find_note(note_id)
    version_id = next(iter(note['versions']), 'legacy')
    results = []
    segments = note['transcript'].get('segments') or []
    for i, segment in enumerate(segments):
        try:
            text, start, end = segment['text'], segment.get('start', 0), segment.get('end', 0)
            if not isinstance(text, str) or any(type(v) not in (int, float) or not math.isfinite(v) for v in (start, end)):
                raise ValueError('segment')
            if start_time is not None and end < start_time or end_time is not None and start > end_time:
                continue
            if keyword.strip() and _normalize(keyword.strip()) not in _normalize(text):
                continue
            for j in range(0, len(text), CHUNK_SIZE):
                results.append(_source(note, version_id, {'section_id': f't{i + 1}-c{j // CHUNK_SIZE + 1}',
                    'section_title': '视频转录', 'text': text[j:j + CHUNK_SIZE], 'start_time': start, 'end_time': end}))
        except (ValueError, TypeError, KeyError):
            warnings.append({'note_id': note_id, 'code': 'unreadable_segment', 'message': '一条转录片段不可读取，已跳过'})
    return _page(results, offset, limit, warnings)
