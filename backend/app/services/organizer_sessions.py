"""Durable metadata-only sessions driven by a real LangGraph approval interrupt.

SQLite transactions fence requests, while provider calls run outside the session
lock so cancellation can invalidate a late response. Each revision has its own
graph thread; old checkpoints can never become the active approval again.
"""
import copy
import hashlib
import hmac
import json
import re
import sqlite3
import threading
import time
import uuid
from contextlib import closing, contextmanager
from pathlib import Path
from typing import TypedDict

from langgraph.checkpoint.sqlite import SqliteSaver
from langgraph.graph import StateGraph, START, END
from langgraph.types import Command, interrupt
from langsmith import tracing_context

from app.services import organizer as service
from app.services.ai_runtime import estimate_context
from app.services.context_compaction import compact_history, CONTEXT_LIMIT, AUTO_COMPACT_THRESHOLD
from app.utils.model_errors import model_error

SESSION_ROOT = Path('data') / 'organizer_sessions'
LOCK = threading.RLock()
ACTIVE = {}
COMPACTING = {}
RUNTIME_ID = uuid.uuid4().hex
RETENTION_DEFAULT = 10
RETENTION_MIN = 1
RETENTION_MAX = 100
PROTECTED_STATUSES = ('planning', 'executing', 'undoing', 'interrupted', 'rollback_failed')


class RetentionConflict(ValueError):
    def __init__(self, kind, preview):
        self.data = {'kind': kind, **preview}
        super().__init__(preview['warning'] if kind != 'retention_stale' else
                         '会话或保留设置已变化，请重新查看覆盖名单并确认')


def _start_active(session_id):
    token = uuid.uuid4().hex
    ACTIVE[session_id] = token
    return token


def _finish_active(session_id, token):
    if ACTIVE.get(session_id) == token:
        ACTIVE.pop(session_id, None)


class GraphState(TypedDict, total=False):
    session_id: str
    revision: int
    instruction: str
    provider_id: str
    model_name: str
    scope: dict
    action: str
    route: str
    text: str
    plan: dict
    result: dict
    read_notes: list
    reasoning_effort: str
    context_limit: int
    context: dict


@contextmanager
def _db():
    SESSION_ROOT.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(SESSION_ROOT / 'sessions.sqlite', timeout=30)
    try:
        connection.execute('PRAGMA journal_mode=WAL')
        connection.execute('BEGIN IMMEDIATE')
        connection.execute('CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, body TEXT NOT NULL)')
        connection.execute('CREATE TABLE IF NOT EXISTS session_settings (id INTEGER PRIMARY KEY CHECK(id=1), retention_limit INTEGER NOT NULL, token_secret TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0)')
        if 'revision' not in {row[1] for row in connection.execute('PRAGMA table_info(session_settings)')}:
            connection.execute('ALTER TABLE session_settings ADD COLUMN revision INTEGER NOT NULL DEFAULT 0')
        connection.execute('INSERT OR IGNORE INTO session_settings(id,retention_limit,token_secret) VALUES (1, ?, ?)',
                           (RETENTION_DEFAULT, uuid.uuid4().hex))
        connection.execute('CREATE TABLE IF NOT EXISTS retired_sessions (id TEXT PRIMARY KEY, retired_at REAL NOT NULL)')
        connection.execute('CREATE TABLE IF NOT EXISTS retention_requests (id TEXT PRIMARY KEY, signature TEXT NOT NULL, body TEXT NOT NULL)')
        yield connection
        connection.commit()
    except BaseException:
        connection.rollback()
        raise
    finally:
        connection.close()


def _load(db, session_id):
    if not isinstance(session_id, str) or not re.fullmatch('[a-f0-9]{32}', session_id):
        raise ValueError('会话 ID 无效')
    row = db.execute('SELECT body FROM sessions WHERE id=?', (session_id,)).fetchone()
    if not row:
        raise FileNotFoundError('会话不存在')
    return json.loads(row[0])


def _save(db, session):
    session['updated_at'] = time.time()
    db.execute('INSERT OR REPLACE INTO sessions(id,body) VALUES (?,?)',
               (session['session_id'], json.dumps(session, ensure_ascii=False)))


def _event(session, kind, text):
    events = session['events']
    events.append({'sequence': events[-1]['sequence'] + 1 if events else 1,
                   'type': kind, 'message': text, 'created_at': time.time()})
    session['events'] = events[-200:]


def _history(session, role, text, phase='message'):
    session['history'].append({'id': uuid.uuid4().hex, 'role': role,
                              'content': text, 'phase': phase, 'created_at': time.time()})


def _public(session):
    result = {k: copy.deepcopy(v) for k, v in session.items()
              if k not in ('requests', 'graph_thread', 'action', 'owner', 'last_message')}
    result['messages'] = [{**m, 'text': m['content']} for m in result['history']]
    result.setdefault('memory', {'summary': '', 'through_id': None, 'compacted_messages': 0})
    result['pending_plan_id'] = ((result.get('plan') or {}).get('plan_id')
                                 if result['status'] == 'awaiting_approval' else None)
    if result['status'] in ('planning', 'executing', 'undoing') and session['session_id'] not in ACTIVE:
        result['status'] = 'interrupted'
        result['error'] = '上次任务已中断，请显式恢复；不会自动执行或重试模型'
    return result


def _settings(db):
    return db.execute('SELECT retention_limit,token_secret,revision FROM session_settings WHERE id=1').fetchone()


def _session_rows(db):
    return [(sid, body, json.loads(body)) for sid, body in db.execute('SELECT id,body FROM sessions ORDER BY id')]


def _retention_info(db):
    limit, _, revision = _settings(db)
    count = db.execute('SELECT COUNT(*) FROM sessions').fetchone()[0]
    return {'limit': limit, 'min_limit': RETENTION_MIN, 'max_limit': RETENTION_MAX,
            'count': count, 'over_limit': count > limit, 'revision': revision}


def retention():
    with LOCK, _db() as db:
        return _retention_info(db)


def _validate_limit(limit):
    if type(limit) is not int or not RETENTION_MIN <= limit <= RETENTION_MAX:
        raise ValueError('保留数量须为 1 到 100 的整数')


def _journal_states(rows):
    states = {}
    for sid, _, session in rows:
        plan = session.get('plan')
        if not plan:
            continue
        try:
            record = service._read(plan['plan_id'])
            states[sid] = {'status': record['status'], 'fingerprint': service._fingerprint(record)}
        except (OSError, ValueError, KeyError):
            # Unknown journal state cannot prove that recovery is unnecessary.
            states[sid] = {'status': 'unreadable'}
    return states


def _retention_preview(db, operation, limit=None):
    if operation not in ('create', 'set_limit'):
        raise ValueError('未知保留设置操作')
    current_limit, secret, settings_revision = _settings(db)
    if operation == 'create':
        if limit is not None and limit != current_limit:
            raise ValueError('新建会话必须使用当前保留数量')
        limit = current_limit
    _validate_limit(limit)
    rows = _session_rows(db)
    journals = _journal_states(rows)
    required = max(0, len(rows) + (operation == 'create') - limit)
    eligible = sorted((s for _, _, s in rows if s['status'] not in PROTECTED_STATUSES
                       and s['session_id'] not in ACTIVE and journals.get(s['session_id'], {}).get('status')
                       not in ('executing', 'undoing', 'rollback_failed', 'unreadable')),
                      key=lambda s: (s.get('updated_at', 0), s['session_id']))
    candidates = eligible[:required]
    blocked = len(candidates) < required
    snapshot = {'operation': operation, 'limit': limit, 'current_limit': current_limit,
                'settings_revision': settings_revision,
                'sessions': [(sid, body) for sid, body, _ in rows], 'active': sorted(ACTIVE), 'journals': journals}
    token = hmac.new(secret.encode(), json.dumps(snapshot, sort_keys=True).encode(), hashlib.sha256).hexdigest()
    warning = ('存在正在运行或需要恢复的会话，无法完成覆盖；请先停止或恢复任务，再重新预检。' if blocked else
               '将覆盖以下旧会话及其聊天记录。待审批计划将作废；该会话的撤销入口将消失。笔记和已执行的整理结果不变，操作审计仍保留。' if required else '')
    return {'operation': operation, 'limit': limit, 'current_limit': current_limit, 'count': len(rows),
            'required_count': required, 'evictions': [{'session_id': s['session_id'],
                'title': next((m['content'][:80] for m in s.get('history', []) if m['role'] == 'user'), '新会话'),
                'status': s['status'], 'updated_at': s.get('updated_at', 0),
                'created_at': s.get('created_at', s.get('updated_at', 0)),
                'message_count': len(s.get('history', [])), 'revision': s['revision'],
                'has_pending_plan': s['status'] == 'awaiting_approval',
                'loses_undo': (s.get('result') or {}).get('status') == 'executed'} for s in candidates],
            'protected_count': len(rows) - len(eligible), 'blocked': blocked,
            'confirmation_token': token if required and not blocked else None, 'warning': warning}


def retention_preview(operation, limit=None):
    with LOCK, _db() as db:
        return _retention_preview(db, operation, limit)


def _require_confirmation(preview, confirmation_token):
    if preview['blocked']:
        raise RetentionConflict('retention_blocked', preview)
    if confirmation_token is not None and not hmac.compare_digest(
            confirmation_token, preview['confirmation_token'] or ''):
        raise RetentionConflict('retention_stale', preview)
    if preview['required_count'] and confirmation_token is None:
        raise RetentionConflict('retention_required', preview)


def _receipt(db, key, signature):
    if not key:
        return None
    row = db.execute('SELECT signature,body FROM retention_requests WHERE id=?', (key,)).fetchone()
    if row:
        if row[0] != signature:
            raise ValueError('request_id 已被其他请求使用')
        return json.loads(row[1])
    return None


def _save_receipt(db, key, signature, result):
    if key:
        db.execute('INSERT INTO retention_requests VALUES (?,?,?)',
                   (key, signature, json.dumps(result, ensure_ascii=False)))


def owner_retired(session_id):
    # A read-only tombstone check avoids a service/session lock inversion. Missing
    # databases are legacy journals; no ordinary session execution can create them.
    path = SESSION_ROOT / 'sessions.sqlite'
    if not path.exists():
        return False
    with closing(sqlite3.connect(path, timeout=30)) as db:
        exists = db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='retired_sessions'").fetchone()
        return bool(exists and db.execute('SELECT 1 FROM retired_sessions WHERE id=?', (session_id,)).fetchone())


def _evict(db, preview):
    if not preview['evictions']:
        return
    checkpoint_path = SESSION_ROOT / 'checkpoints.sqlite'
    if checkpoint_path.exists():
        db.execute('ATTACH DATABASE ? AS retention_graph', (str(checkpoint_path.resolve()),))
        tables = [row[0] for row in db.execute("SELECT name FROM retention_graph.sqlite_master WHERE type='table'")]
        thread_tables = [name for name in tables if 'thread_id' in
                         {row[1] for row in db.execute('PRAGMA retention_graph.table_info("' + name.replace('"', '""') + '")')}]
    else:
        thread_tables = []
    for item in preview['evictions']:
        sid = item['session_id']
        db.execute('INSERT OR REPLACE INTO retired_sessions VALUES (?,?)', (sid, time.time()))
        db.execute('DELETE FROM sessions WHERE id=?', (sid,))
        for table in thread_tables:
            db.execute('DELETE FROM retention_graph."' + table.replace('"', '""') +
                       '" WHERE thread_id=? OR substr(thread_id,1,33)=?', (sid, sid + ':'))
    # SQLite coordinates both live databases in this transaction. WAL crash
    # recovery may commit only one attached DB; durable tombstones also fence any
    # residual graph state/owner plan, preventing it from ever executing again.


def set_retention(limit, confirmation_token=None, request_id=None):
    _validate_limit(limit)
    signature = _signature('set_limit', {'limit': limit, 'confirmation_token': confirmation_token})
    key = request_id or ('token:' + confirmation_token if confirmation_token else None)
    with LOCK, _db() as db:
        prior = _receipt(db, key, signature)
        if prior is not None:
            return prior
        preview = _retention_preview(db, 'set_limit', limit)
        _require_confirmation(preview, confirmation_token)
        _evict(db, preview)
        db.execute('UPDATE session_settings SET retention_limit=?,revision=revision+1 WHERE id=1', (limit,))
        result = _retention_info(db)
        _save_receipt(db, key, signature, result)
        return result


def create(scope, provider_id=None, model_name=None, confirmation_token=None, request_id=None):
    # A UI selection is an upper bound until a message explicitly places work in scope.
    session = {'session_id': uuid.uuid4().hex, 'revision': 0, 'status': 'idle', 'created_at': time.time(),
               'scope': {**scope, 'authorized': False, 'exclude_favorites': False, 'target_count': 0},
               'query_scope': copy.deepcopy(scope),
               'target_summary': {'count': 0, 'note_ids': [], 'folder_name': None,
                                  'authorized': False, 'exclude_favorites': False},
               'history': [], 'memory': {'summary': '', 'through_id': None, 'compacted_messages': 0},
               'events': [], 'plan': None, 'result': None, 'error': None,
               'requests': {}, 'action': '', 'provider_id': provider_id, 'model_name': model_name}
    with LOCK, _db() as db:
        signature = _signature('create', {'scope': scope, 'provider_id': provider_id,
                                         'model_name': model_name, 'confirmation_token': confirmation_token})
        key = request_id or ('token:' + confirmation_token if confirmation_token else None)
        prior = _receipt(db, key, signature)
        if prior is not None:
            # A retry cannot resurrect a later-evicted session from its receipt.
            return _public(_load(db, prior['session_id']))
        preview = _retention_preview(db, 'create')
        _require_confirmation(preview, confirmation_token)
        _evict(db, preview)
        _save(db, session)
        _save_receipt(db, key, signature, {'session_id': session['session_id']})
    return _public(session)


def get(session_id):
    with LOCK, _db() as db:
        return _public(_load(db, session_id))


def list_sessions():
    with LOCK, _db() as db:
        sessions = [json.loads(row[0]) for row in db.execute(
            "SELECT body FROM sessions ORDER BY json_extract(body,'$.updated_at') DESC")]
        info = _retention_info(db)
    return {'sessions': [_public(s) for s in sessions], 'retention': info, 'runtime_id': RUNTIME_ID}


def _signature(kind, data):
    return hashlib.sha256(json.dumps({'kind': kind, 'data': data}, sort_keys=True).encode()).hexdigest()


def _request(session, kind, data):
    signature = _signature(kind, data)
    prior = session['requests'].get(data['request_id'])
    if prior:
        if prior['signature'] != signature:
            raise ValueError('request_id 已被其他请求使用')
        return True
    if session['revision'] != data['expected_revision']:
        raise ValueError('会话版本已变化，请刷新后确认当前计划')
    session['requests'][data['request_id']] = {'signature': signature}
    return False


def _live(state):
    with LOCK, _db() as db:
        session = _load(db, state['session_id'])
        if session['revision'] != state['revision'] or session['status'] == 'cancelled':
            raise ValueError('此任务已被停止或新消息替代，晚到结果已丢弃')
        return session


def _active_history(session):
    history = session['history']
    through = session.get('memory', {}).get('through_id')
    if through:
        index = next((i for i, item in enumerate(history) if item['id'] == through), None)
        if index is None:
            raise ValueError('上下文摘要边界无效，请检查会话记录')
        history = history[index + 1:]
    return [copy.deepcopy(item) for item in history if item['role'] in ('user', 'assistant')]


def _prepare_context(session, provider_id, model_name, force=False, extra_context=None, compaction_token=None):
    """Only memory changes; authorization, approval and full audit history never do."""
    active = _active_history(session)
    memory = copy.deepcopy(session.get('memory') or {'summary': '', 'through_id': None, 'compacted_messages': 0})
    context = None
    rounds = 0
    while rounds < 3 and (force or len(active) >= 160 or estimate_context([
            {'role': 'user', 'content': json.dumps({'summary': memory['summary'],
             'metadata': extra_context or {}}, ensure_ascii=False)}, *active]) >= AUTO_COMPACT_THRESHOLD):
        rounds += 1
        if compaction_token is not None:
            with LOCK:
                if COMPACTING.get(session['session_id']) != compaction_token:
                    raise ValueError('压缩已停止，晚到压缩结果已丢弃')
        outcome = compact_history(service.get_client(provider_id, model_name).client,
                                  model_name, active, summary=memory['summary'], keep_recent=4)
        if not outcome['compacted']:
            if context is None:
                context = copy.deepcopy(session.get('context'))
            break
        context = outcome['context']
        consumed = outcome['consumed_messages']
        if type(consumed) is not int or not 0 < consumed <= len(active) - 4:
            raise ValueError('上下文压缩返回的边界无效')
        memory.update(summary=outcome['summary'], through_id=active[consumed - 1]['id'],
                      compacted_messages=memory['compacted_messages'] + consumed)
        active = active[consumed:]
        force = False
    with LOCK, _db() as db:
        live = _load(db, session['session_id'])
        if compaction_token is not None and COMPACTING.get(session['session_id']) != compaction_token:
            raise ValueError('压缩已停止，晚到压缩结果已丢弃')
        if live['revision'] != session['revision'] or live.get('memory') != session.get('memory'):
            raise ValueError('会话已变化，晚到压缩结果已丢弃')
        live['memory'] = memory
        if context is not None:
            live['context'] = context
            _event(live, 'compacted' if memory != session.get('memory') else 'compact_skipped',
                   '上下文压缩完成，完整记录和审批计划已保留' if memory != session.get('memory') else '当前上下文无需压缩')
        _save(db, live)
    return live, active


def compact(session_id, data):
    with LOCK, _db() as db:
        session = _load(db, session_id)
        if _request(session, 'compact', data):
            return _public(session)
        if session_id in ACTIVE or session['status'] in ('planning', 'executing', 'undoing'):
            raise ValueError('当前任务未结束，请先停止或恢复')
        _save(db, session)
        token = _start_active(session_id)
        COMPACTING[session_id] = token
    try:
        live, _ = _prepare_context(session, data['provider_id'], data['model_name'], force=True,
                                   compaction_token=token)
        return _public(live)
    except Exception:
        # Failed compaction remains retryable and preserves every previous field.
        with LOCK, _db() as db:
            live = _load(db, session_id)
            if live['revision'] == session['revision']:
                live['requests'].pop(data['request_id'], None)
                _save(db, live)
        raise
    finally:
        with LOCK:
            _finish_active(session_id, token)
            if COMPACTING.get(session_id) == token:
                COMPACTING.pop(session_id, None)


def cancel_compaction(session_id, data):
    """Invalidate only the running summary request, preserving approval authority."""
    with LOCK, _db() as db:
        session = _load(db, session_id)
        if _request(session, 'cancel_compaction', data):
            return _public(session)
        token = COMPACTING.pop(session_id, None)
        if token is not None:
            _finish_active(session_id, token)
            _event(session, 'compact_cancelled', '上下文压缩已停止，完整记录与审批计划已保留')
        _save(db, session)
        return _public(session)


class Intent(TypedDict):
    operation: str
    mode: str
    explicit_target: bool


def _intent(text, previous_action):
    """Conservative typed intent boundary. Unresolved explicit targets never inherit.

    This deterministic guard does not claim to understand unrestricted language;
    the model proposes only after authorization and negation checks have passed.
    """
    blocked = bool(re.search(r'删除|清空|删掉|移除文件|修改正文|改写正文|修改配置|系统命令', text))
    # Source names/counts can separate negation from the verb; stop at clause
    # punctuation so "不要归档，改为移动" keeps its positive move instruction.
    negation = r'(?:(?:不要|不想|不用|不允许|不希望|无需|不必|禁止|别|勿)[^，,。；;！？!?\n]{0,80}|不)'
    negated_operations = {
        'archive': bool(re.search(negation + r'归档', text)),
        'restore': bool(re.search(negation + r'(?:恢复|取消归档)', text)),
        'move_notes': bool(re.search(negation + r'(?:移动|移到|移入|挪到|挪入|放到|放入|搬到)', text)),
        'create_folder': bool(re.search(negation + r'(?:创建|新建|新增)', text)),
        'rename_folder': bool(re.search(negation + r'重命名', text)),
        'set_tags': bool(re.search(negation + r'(?:设置标签|标签|加标签)', text)),
    }
    discussing = bool(re.search(r'不要执行|先不执行|先解释|解释一下|只.{0,4}(解释|查询)|能否|如何|怎么', text))
    discussing = discussing or not bool(re.search(r'归档|恢复|整理|移动|移到|移入|挪到|挪入|放到|放入|搬到|重命名|标签|分类|新建|创建|新增|排除|包含|包括|保留|删除|清空|删掉|改写|修改', text))
    discussing = discussing or bool(re.search(r'查询|查找|找出|哪些|列出|统计|为什么|报错|错误|怎么办', text))
    creating = bool(re.search(r'(新建|创建|新增).{0,5}文件夹', text))
    if creating:
        operation = 'create_folder'
    elif '重命名' in text:
        operation = 'rename_folder'
    elif '标签' in text:
        operation = 'set_tags'
    elif re.search(r'移动|移到|移入|挪到|挪入|放到|放入|搬到', text):
        operation = 'move_notes'
    elif '恢复' in text or '取消归档' in text:
        operation = 'restore'
    elif '归档' in text:
        operation = 'archive'
    elif re.search(r'(排除|包含|包括|保留).{0,8}收藏', text):
        operation = previous_action
    else:
        operation = ''
    # A restriction on a different operation must not cancel an explicit action:
    # "设置标签，不要归档" still authorizes tags and forbids archive proposals.
    discussing = discussing or (negated_operations.get(operation, False) if operation
                                else any(negated_operations.values()))
    explicit = bool(re.search(r'文件夹|[“「"].+?[”」"]|(?:归档|恢复|整理).{1,60}(?:下面|里的|中的)|(?:改为|改成|换成|改整理).{1,60}', text))
    return {'operation': operation, 'mode': 'refuse' if blocked else 'discuss' if discussing else 'apply',
            'explicit_target': explicit and not creating}


def _confirmation(text):
    return bool(re.fullmatch(r'\s*(?:好的?[，, ]*)?(?:确认(?:执行)?|确定(?:执行)?|执行(?:吧)?|可以(?:执行)?|同意(?:执行)?|就这样(?:执行)?)[。！!\s]*', text))


def _folder_mentions(text, public_folders):
    """Prefer complete folder names and recognize the built-in default alias."""
    result = []
    remaining = text
    for folder in sorted(public_folders, key=lambda item: len(item['name']), reverse=True):
        if folder['name'] in remaining:
            result.append(folder)
            remaining = remaining.replace(folder['name'], '')
    if re.search(r'默认', remaining):
        default = next(folder for folder in public_folders if folder['id'] == service.folders.DEFAULT_ID)
        if default not in result:
            result.append(default)
    return result


def _scope_node(state):
    session = _live(state)
    instruction = state['instruction']
    intent = _intent(instruction, session.get('action', ''))
    with service.LOCK, service.folders.LOCK, service.library.LOCK, service.notes.LOCK:
        catalog = service._snapshot()
    upper = state['scope']
    previous = session['scope']
    chosen = copy.deepcopy(previous) if previous.get('authorized') else {
        'kind': 'all', 'folder_id': None, 'task_ids': [], 'authorized': False,
        'exclude_favorites': False}
    public_folders = service.folders._public(catalog['folders'])['folders']
    matching = _folder_mentions(instruction, public_folders)
    destination = None
    route, text = 'propose', ''
    if intent['operation'] == 'move_notes' and intent['mode'] == 'apply':
        # Destination is after the move verb; it is never a source authorization.
        move = re.search(r'(?:移动到?|移到|移入|挪到|挪入|放到|放入|搬到)', instruction)
        source_text, destination_text = instruction[:move.start()], instruction[move.end():]
        destinations = _folder_mentions(destination_text, public_folders)
        matching = _folder_mentions(source_text, public_folders)
        if len(destinations) != 1:
            route, text = 'clarification', '请明确唯一的目标文件夹（可写“默认”）；不会将目标文件夹当作待移动对象。'
        else:
            destination = destinations[0]
        if not matching and re.search(r'文件夹|里面|里的|中的|下面', source_text) and not re.search(r'当前文件夹|这个文件夹|该文件夹', source_text):
            route, text = 'clarification', '没有识别到指定的来源文件夹，请使用现有文件夹名称或选中笔记；不会沿用之前的来源。'
            chosen.update(kind='all', folder_id=None, folder_name=None, task_ids=[], authorized=False)
    if len(matching) > 1:
        route, text = 'clarification', '提到了多个文件夹，请明确要整理哪个文件夹。'
        chosen.update(kind='all', folder_id=None, folder_name=None, task_ids=[], authorized=False)
    elif matching:
        chosen.update(kind='folder', folder_id=matching[0]['id'], folder_name=matching[0]['name'],
                      task_ids=[], authorized=True)
    elif re.search(r'全部|所有|全库|整个资料库', instruction):
        chosen.update(kind='all', folder_id=None, folder_name=None, task_ids=[], authorized=True)
    elif not chosen.get('authorized') and upper['kind'] != 'all':
        chosen.update(upper, authorized=True)
    if upper['kind'] != 'all' and re.search(r'选中|勾选|这些笔记|当前文件夹', instruction):
        chosen.update(upper, authorized=True, folder_name=None)
    if intent['explicit_target'] and not matching and intent['operation'] != 'move_notes' and not re.search(
            r'全部|所有|全库|整个资料库|当前文件夹|这个文件夹|该文件夹|选中|这些', instruction):
        route, text = 'clarification', '没有识别到你明确指定的新目标，请使用现有文件夹名称或选中笔记；不会沿用之前的目标执行。'
        chosen.update(kind='all', folder_id=None, folder_name=None, task_ids=[], authorized=False)
    exclude = bool(re.search(r'(排除|不[要含]|不包括|跳过).{0,8}收藏', instruction))
    include = bool(re.search(r'(包含|包括|保留|也要).{0,8}收藏', instruction)) and not exclude
    chosen['exclude_favorites'] = False if include else bool(chosen.get('exclude_favorites') or exclude)
    all_notes = catalog['notes']
    def matches(note, scope):
        return (scope['kind'] == 'all' or
                scope['kind'] == 'folder' and note['folder_id'] == scope.get('folder_id') or
                scope['kind'] == 'selected' and note['id'] in scope.get('task_ids', []))
    targets = [n for n in all_notes if chosen.get('authorized') and matches(n, chosen) and matches(n, upper)
               and not (chosen['exclude_favorites'] and n['favorite'])]
    count_match = re.search(r'([一二两三四五六七八九十]|\d+)\s*(?:篇|个|条)\s*笔记', instruction)
    if count_match:
        counts = {'一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10}
        count_text = count_match[1]
        requested_count = counts.get(count_text, int(count_text) if count_text.isdigit() else 0)
        if requested_count != len(targets):
            route, text = 'clarification', f'当前范围有 {len(targets)} 篇笔记，与你指定的 {requested_count} 篇不一致。请选中具体笔记或明确范围；不会擅自扩大或任意挑选。'
    # Materialize the upper-bound intersection so a later UI expansion cannot widen it.
    if chosen.get('authorized') and upper['kind'] != 'all' and (
            upper['kind'] == 'selected' or chosen['kind'] != upper['kind'] or
            chosen.get('folder_id') != upper.get('folder_id')):
        chosen.update(kind='selected', folder_id=None, folder_name=None, task_ids=[n['id'] for n in targets])
    if chosen.get('kind') == 'folder':
        known = {f['id']: f['name'] for f in service.folders._public(catalog['folders'])['folders']}
        if chosen['folder_id'] not in known:
            route, text = 'clarification', '目标文件夹已不存在，请重新选择。'
        chosen['folder_name'] = known.get(chosen['folder_id'])
    action = intent['operation']
    if action == 'rename_folder' and intent['mode'] == 'apply':
        if len(matching) != 1:
            route, text = 'clarification', '请明确要重命名的现有文件夹名称；不会替你选择其他文件夹。'
        else:
            chosen['rename_folder_id'] = matching[0]['id']
    else:
        chosen.pop('rename_folder_id', None)
    if intent['mode'] == 'refuse':
        route, text = 'refused', '整理助手不支持删除或修改正文、文件及配置。已保留你明确的目标范围，可改为归档。'
    elif intent['mode'] == 'discuss':
        route, text = 'discussion', '当前没有安排归档或其他修改。整理助手仅依据标题、标签和收藏状态提议元数据操作；明确要求后仍需确认才能执行。'
        action = ''
    elif not chosen.get('authorized') and action != 'create_folder':
        if route != 'clarification':
            route, text = 'clarification', '请明确整理对象：指定文件夹、选中笔记，或明确说“全部笔记”。当前全库选项仅是允许上限。'
    elif re.search(r'(排除|包含|包括|保留).{0,8}收藏', instruction) and not action:
        route, text = 'clarification', '收藏筛选条件已保留，请明确接下来要查询、归档还是进行其他整理。'
    elif route == 'propose' and not targets and action != 'create_folder':
        route, text = 'empty', '当前目标范围经筛选后没有可整理的笔记；不会扩大到其他文件夹或全库。'
    if destination:
        chosen['destination_folder_id'] = destination['id']
        chosen['destination_folder_name'] = destination['name']
    else:
        chosen.pop('destination_folder_id', None)
        chosen.pop('destination_folder_name', None)
    chosen['target_count'] = len(targets)
    summary = {'count': len(targets), 'note_ids': [n['id'] for n in targets],
               'folder_name': chosen.get('folder_name'), 'exclude_favorites': chosen['exclude_favorites'],
               'authorized': chosen.get('authorized', False)}
    with LOCK, _db() as db:
        live = _load(db, state['session_id'])
        if live['revision'] != state['revision']:
            raise ValueError('任务已停止或替代')
        live.update(scope=chosen, target_summary=summary, action=action)
        _event(live, 'scope', '范围已确定：' + str(len(targets)) + ' 篇笔记')
        _save(db, live)
    read_notes = [{key: value for key, value in note.items() if key != 'archived_at'} |
                  {'archived': bool(note.get('archived_at'))} for note in all_notes if matches(note, upper)][:1000]
    return {'route': route, 'text': text, 'scope': {**chosen, 'resolved_ids': summary['note_ids']},
            'action': action, 'read_notes': read_notes}


def _propose_node(state):
    session, history = _prepare_context(_live(state), state['provider_id'], state['model_name'],
                                        extra_context={'instruction': state['instruction'],
                                                       'notes': state.get('read_notes', []), 'scope': state['scope']})
    instruction = state['instruction']
    if state['action'] in ('archive', 'restore'):
        instruction = ('归档' if state['action'] == 'archive' else '恢复归档') + '当前明确范围全部笔记。补充要求：' + instruction
    # Only bounded human instructions and explicit scope metadata enter model context.
    instruction += '\n服务端授权范围：' + json.dumps(session['target_summary'], ensure_ascii=False)
    if state['action'] == 'move_notes':
        instruction += '\n唯一允许的移动目标：' + json.dumps({'folder_id': state['scope']['destination_folder_id'],
                                                         'name': state['scope']['destination_folder_name']}, ensure_ascii=False)
    owner = {'session_id': state['session_id'], 'revision': state['revision']}
    plan = service.plan(instruction, {'kind': 'selected', 'task_ids': state['scope']['resolved_ids']},
                        state['provider_id'], state['model_name'], owner=owner,
                        allow_empty=state['action'] == 'create_folder',
                        reasoning_effort=state.get('reasoning_effort', 'auto'),
                        context_limit=CONTEXT_LIMIT, history=history,
                        memory_summary=session['memory']['summary'])
    try:
        _live(state)
    except ValueError:
        with service.LOCK:
            record = service._read(plan['plan_id'])
            record['status'] = 'superseded'
            service._save(record)
        raise
    error = None
    # General organization may combine classification operations, but cannot
    # acquire archive/restore or rename authority from note metadata or the model.
    allowed = {state['action']} if state['action'] else {'create_folder', 'move_notes', 'set_tags'}
    if any(op['type'] not in allowed for op in plan['operations']):
        error = '模型建议超出当前操作意图，请重新生成'
    elif state['action'] == 'move_notes' and any(op['folder_id'] != state['scope']['destination_folder_id']
                                               for op in plan['operations']):
        error = '模型建议的移动目标与指定文件夹不一致，没有执行修改'
    elif state['action'] == 'rename_folder' and any(op['folder_id'] != state['scope']['rename_folder_id']
                                                  for op in plan['operations']):
        error = '模型建议的重命名对象与指定文件夹不一致，没有执行修改'
    elif state['action'] in ('move_notes', 'set_tags', 'archive', 'restore') and re.search(
            r'全部|所有|全库|整个资料库|([一二两三四五六七八九十]|\d+)\s*(?:篇|个|条)\s*笔记',
            state['instruction']) and (
            {task_id for op in plan['operations'] for task_id in op.get('task_ids', [])}
            != set(state['scope']['resolved_ids'])):
        error = '模型未覆盖明确指定的全部笔记或篇数，没有执行修改；请重新生成完整计划'
    if error:
        with service.LOCK:
            record = service._read(plan['plan_id'])
            record['status'] = 'superseded'
            service._save(record)
        raise ValueError(error)
    context = plan.get('context') or {}
    context.update(compacted=bool(session['memory']['compacted_messages']),
                   compacted_messages=session['memory']['compacted_messages'])
    return {'plan': plan, 'text': plan['explanation'], 'context': context}


def _answer_node(state):
    session = _live(state)
    if state['route'] in ('clarification', 'empty'):
        return {'text': state['text'] + '\n尚未生成可执行计划，无需确认执行。'}
    session, history = _prepare_context(session, state['provider_id'], state['model_name'],
                                        extra_context={'instruction': state['instruction'],
                                                       'notes': state.get('read_notes', []), 'constraint': state['text']})
    context = {}
    text = service.answer(state['instruction'], state['provider_id'], state['model_name'],
                          history, state['text'], session['target_summary'], state.get('read_notes', []),
                          reasoning_effort=state.get('reasoning_effort', 'auto'),
                          context_limit=CONTEXT_LIMIT, context_sink=context,
                          memory_summary=session['memory']['summary'])
    _live(state)
    context.update(compacted=bool(session['memory']['compacted_messages']),
                   compacted_messages=session['memory']['compacted_messages'])
    return {'text': text, 'context': context}


def _approval_node(state):
    _live(state)
    answer = interrupt({'session_id': state['session_id'], 'revision': state['revision'],
                        'plan_id': state['plan']['plan_id'], 'operations': state['plan']['operations']})
    if answer != {'approved': True, 'plan_id': state['plan']['plan_id'], 'revision': state['revision']}:
        raise ValueError('审批与当前计划不匹配')
    return {}


def _execute_node(state):
    # The router holds LOCK throughout resume; cancellation/edits cannot interleave
    # with irreversible metadata commit. Journal execute is itself idempotent.
    _live(state)
    return {'result': service.execute(state['plan']['plan_id'], owner={
        'session_id': state['session_id'], 'revision': state['revision']})}


@contextmanager
def _graph():
    SESSION_ROOT.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(SESSION_ROOT / 'checkpoints.sqlite', check_same_thread=False)
    try:
        saver = SqliteSaver(connection)
        builder = StateGraph(GraphState)
        builder.add_node('resolve_scope', _scope_node)
        builder.add_node('propose', _propose_node)
        builder.add_node('answer', _answer_node)
        builder.add_node('approval', _approval_node)
        builder.add_node('execute', _execute_node)
        builder.add_edge(START, 'resolve_scope')
        builder.add_conditional_edges('resolve_scope', lambda state: state['route'],
                                      {'propose': 'propose', 'refused': 'answer', 'clarification': 'answer', 'empty': 'answer', 'discussion': 'answer'})
        builder.add_edge('answer', END)
        builder.add_conditional_edges('propose', lambda state: bool(state['plan']['operations']),
                                      {True: 'approval', False: END})
        builder.add_edge('approval', 'execute')
        builder.add_edge('execute', END)
        # Explicitly suppress optional LangSmith telemetry even when the user has
        # globally enabled tracing. Context variables also propagate to graph nodes.
        # Do not mutate the user's process/system environment.
        with tracing_context(enabled=False):
            yield builder.compile(checkpointer=saver)
    finally:
        connection.close()


def _config(session):
    return {'configurable': {'thread_id': session['graph_thread']}, 'callbacks': []}


def message(session_id, data):
    if data['instruction'].strip().lower() in ('/compact', '压缩上下文'):
        return compact(session_id, {key: data[key] for key in
                                   ('expected_revision', 'request_id', 'provider_id', 'model_name')})
    with LOCK, _db() as db:
        session = _load(db, session_id)
        if _request(session, 'message', data):
            return _public(session)
        if (session_id in COMPACTING and session['status'] != 'cancelled') or session['status'] in ('planning', 'executing', 'undoing'):
            raise ValueError('当前任务未结束，请先停止或恢复')
        if _confirmation(data['instruction']):
            _history(session, 'user', data['instruction'])
            text = ('当前计划仍待审批，请点击这份计划的“确认执行”按钮；此次文字回复没有执行或替换计划。'
                    if session['status'] == 'awaiting_approval' and session.get('plan') else
                    '当前没有待审批的可执行计划。请先说明操作和笔记范围；生成计划后再点击“确认执行”。')
            _history(session, 'assistant', text, 'confirmation_hint')
            _event(session, 'confirmation_hint', text)
            _save(db, session)
            return _public(session)
        if session.get('plan') and session['status'] == 'awaiting_approval':
            _history(session, 'assistant', '上一版计划已失效；需要重新确认新计划。', 'superseded')
        session['revision'] += 1
        revision = session['revision']
        session.update(status='planning', plan=None, error=None, result=None, context=None,
                       reasoning_effort=data.get('reasoning_effort', 'auto'), context_limit=CONTEXT_LIMIT,
                       query_scope=copy.deepcopy(data['scope']), provider_id=data['provider_id'], model_name=data['model_name'],
                       graph_thread=session_id + ':' + str(revision), last_message=copy.deepcopy(data))
        _history(session, 'user', data['instruction'])
        _event(session, 'planning', '正在解析目标范围')
        _save(db, session)
        token = _start_active(session_id)
    try:
        with _graph() as graph:
            output = graph.invoke({'session_id': session_id, 'revision': revision,
                                   'instruction': data['instruction'], 'scope': data['scope'],
                                   'provider_id': data['provider_id'], 'model_name': data['model_name'],
                                   'reasoning_effort': data.get('reasoning_effort', 'auto'),
                                   'context_limit': CONTEXT_LIMIT}, _config(session))
        with LOCK, _db() as db:
            session = _load(db, session_id)
            if session['revision'] != revision:
                return _public(session)
            status = ('awaiting_approval' if output.get('__interrupt__') else
                      output['route'] if output['route'] in ('refused', 'clarification') else 'completed')
            session.update(status=status, plan=output.get('plan'), error=None, context=output.get('context'))
            if session.get('plan'):
                session['owner'] = {'session_id': session_id, 'revision': revision}
            _history(session, 'assistant', output['text'], status)
            _event(session, status, output['text'])
            _save(db, session)
            return _public(session)
    except Exception as exc:
        detail = model_error(exc)
        with LOCK, _db() as db:
            session = _load(db, session_id)
            if session['revision'] == revision:
                session.update(status='failed', error=detail, plan=None)
                _history(session, 'assistant', '模型请求未完成：' + detail, 'failed')
                _event(session, 'failed', '任务失败，没有执行修改')
                _save(db, session)
            return _public(session)
    finally:
        with LOCK:
            _finish_active(session_id, token)


def action(session_id, kind, data):
    with LOCK:
        with _db() as db:
            session = _load(db, session_id)
            if _request(session, kind, data):
                return _public(session)
            if session_id in COMPACTING and kind != 'cancel':
                raise ValueError('当前任务未结束，请先停止或恢复')
            plan = session.get('plan')
            if kind in ('approve', 'undo') and (not plan or data.get('plan_id') != plan['plan_id']):
                raise ValueError('计划已失效或与当前会话不匹配')
            if kind == 'approve' and session['status'] != 'awaiting_approval':
                # Same plan can also be confirmed with a fresh request id without applying twice.
                if session['status'] == 'completed' and (session.get('result') or {}).get('status') == 'executed':
                    _save(db, session)
                    return _public(session)
                raise ValueError('当前会话没有待审批计划')
            if kind == 'undo' and (session['status'] != 'completed' or not session.get('result')):
                raise ValueError('当前没有可撤销的执行')
            if kind == 'cancel':
                if session['status'] in ('executing', 'undoing'):
                    raise ValueError('执行阶段已提交，请完成后使用撤销')
                session['revision'] += 1
                session.update(status='cancelled', plan=None, error=None)
                _history(session, 'assistant', '当前任务已停止，待执行计划已作废。', 'cancelled')
                _event(session, 'cancelled', '已停止；晚到结果不会恢复计划')
                _save(db, session)
                return _public(session)
            if kind == 'recover' and session['status'] not in ('planning', 'executing', 'undoing', 'failed'):
                raise ValueError('此会话不需要恢复')
            if kind == 'recover' and session_id in ACTIVE:
                raise ValueError('任务仍在运行，请先停止')
            session['status'] = 'executing' if kind == 'approve' else 'undoing' if kind == 'undo' else 'interrupted'
            _save(db, session)
            token = _start_active(session_id)
        # LangGraph runs nodes on its worker executor. Release the coordinator lock
        # during invoke; persisted executing/undoing status rejects competing writes.
        LOCK.release()
        try:
            if kind == 'approve':
                with _graph() as graph:
                    output = graph.invoke(Command(resume={'approved': True, 'plan_id': plan['plan_id'],
                                                          'revision': session['owner']['revision']}), _config(session))
                result = output['result']
            elif kind == 'undo':
                result = service.undo(plan['plan_id'], owner=session['owner'])
            elif kind == 'recover':
                result = service.recover(plan['plan_id'], owner=session['owner']) if plan else None
            else:
                raise ValueError('未知会话操作')
            with _db() as db:
                session = _load(db, session_id)
                session['revision'] += 1
                session.update(status='completed' if kind != 'recover' else 'failed', result=result, error=None)
                if result:
                    session['plan'] = result
                if kind == 'recover':
                    session['plan'] = None
                text = {'approve': '已按确认计划完成修改，可撤销。', 'undo': '已撤销本次修改。',
                        'recover': '中断任务已恢复为安全状态，请重新发送要求生成新计划；未自动重试模型。'}[kind]
                _history(session, 'assistant', text, kind)
                _event(session, kind, text)
                _save(db, session)
                return _public(session)
        except Exception as exc:
            with _db() as db:
                session = _load(db, session_id)
                session['revision'] += 1
                session.update(status='failed', error=str(exc))
                _event(session, 'failed', str(exc))
                _history(session, 'assistant', '操作失败：' + str(exc), 'failed')
                _save(db, session)
                return _public(session)
        finally:
            LOCK.acquire()
            _finish_active(session_id, token)
