"""Bounded, best-effort task traces. Never persist exception bodies or content."""
import io
import json
import math
import os
import re
import sys
import tempfile
import threading
import time
import traceback
import uuid
import zipfile
from datetime import datetime, timezone
from pathlib import Path

from app.services import note_storage

MAX_RUNS = 3
MAX_EVENTS = 300
MAX_BYTES = 20 * 1024 * 1024
MAX_FILE_BYTES = 512 * 1024
_LOCK = threading.RLock()
_ACTIVE = {}
_STAGES = {'PENDING', 'PARSING', 'DOWNLOADING', 'TRANSCRIBING', 'SUMMARIZING',
           'FORMATTING', 'SAVING', 'SUCCESS', 'FAILED'}
_EVENTS = {'run_started', 'stage', 'failure', 'model_attempt_started', 'model_attempt_completed',
           'model_completed', 'content_saved', 'index_saved', 'replace_retry', 'replace_failed',
           'save_retry', 'save_retry_started', 'save_retry_completed', 'storage_failure',
           'status_write_failed', 'run_finished'}
_ENUMS = {'phase': {'summarize', 'merge', 'download', 'transcribe', 'save', 'status', 'index', 'content'},
          'status': {'running', 'failed', 'succeeded', 'truncated', 'invalid_response', 'SUCCESS', 'FAILED'},
          'reason': {'initial', 'retry', 'temperature_fallback'},
          'target': {'content', 'index', 'status', 'manifest', 'metadata', 'markdown', 'transcript'}}
_NUMBERS = {'attempt', 'index', 'retry_index', 'elapsed_ms', 'duration_ms', 'delay_ms',
            'errno', 'winerror', 'http_status', 'request_bytes', 'text_chars', 'image_count'}
_FRAME_FILES = {'note.py', 'note_storage.py', 'note_diagnostics.py', 'generation_usage.py',
                'universal_gpt.py', 'base.py', 'provider.py', 'gpt_factory.py',
                'video_task_dao.py', 'sqlite3_db.py', 'dynamic_frames.py', 'video_reader.py'}
_MESSAGES = {'permission': '文件访问被系统拒绝；具体占用原因需系统采集确认。',
             'timeout': '操作超时。', 'upstream_http': '上游服务返回错误。',
             'filesystem': '文件操作失败。', 'generation': '生成流程失败。'}


def _version():
    try:
        root = Path(getattr(sys, '_MEIPASS', Path(__file__).resolve().parents[2]))
        path = root / 'build-info.json'
        if path.stat().st_size <= 2048:
            value = json.loads(path.read_text(encoding='utf-8')).get('version')
            if _identifier(value, 80):
                return value
    except (OSError, ValueError, TypeError, AttributeError):
        pass
    return 'unknown'


def _now():
    return datetime.now(timezone.utc).isoformat(timespec='milliseconds')


def _identifier(value, limit=128):
    return value if isinstance(value, str) and not value.lower().startswith(('sk-', 'bearer', 'apikey', 'api_key', 'cookie', 'authorization')) and re.fullmatch(r'[A-Za-z0-9_.:-]{1,%d}' % limit, value) else None


def response_request_id(value):
    """Only named SDK metadata/header fields, never request bodies or exception text."""
    def field(obj, name):
        return obj.get(name) if isinstance(obj, dict) else getattr(obj, name, None)
    try:
        for name in ('request_id', '_request_id'):
            result = _identifier(field(value, name))
            if result:
                return result
        response = field(value, 'response')
        headers = field(response, 'headers') or field(value, 'headers')
        if headers is not None:
            for name in ('x-request-id', 'request-id', 'x-goog-request-id', 'x-amzn-requestid'):
                result = _identifier(headers.get(name))
                if result:
                    return result
    except Exception:
        pass
    return None


def _directory(task_id):
    note_storage.valid_id(task_id)
    root = note_storage.ROOT.resolve()
    directory = root / '_diagnostics' / task_id
    for item in (root / '_diagnostics', directory):
        if not _plain_path(item, item.parent):
            raise ValueError('Linked diagnostics directory is unsupported')
    return directory


def _plain_path(path, parent):
    # resolve comparison also detects Windows junctions on Python 3.11.
    junction = getattr(path, 'is_junction', None)
    return (not path.is_symlink() and not (junction and junction())
            and path.resolve() == parent.resolve() / path.name)


def _trace_files():
    root = note_storage.ROOT.resolve()
    base = root / '_diagnostics'
    if not _plain_path(base, root) or not base.is_dir():
        return []
    files = []
    for folder in base.iterdir():
        try:
            note_storage.valid_id(folder.name)
            if not folder.is_dir() or not _plain_path(folder, base):
                continue
            directory = _directory(folder.name)
            for path in directory.glob('*.json'):
                if re.fullmatch(r'[a-f0-9]{32}\.json', path.name) and path.is_file() and _plain_path(path, directory):
                    files.append(path)
        except (OSError, ValueError):
            continue
    return files


def _persist(data):
    directory = _directory(data['task_id'])
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / (data['trace_id'] + '.json')
    if not _plain_path(path, directory):
        raise ValueError('Linked diagnostics file is unsupported')
    fd, temporary = tempfile.mkstemp(prefix='.diagnostic-', dir=directory)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            json.dump(data, stream, ensure_ascii=False)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    runs = sorted((p for p in directory.glob('*.json') if re.fullmatch(r'[a-f0-9]{32}\.json', p.name)
                   and p.is_file() and _plain_path(p, directory)), key=lambda p: p.stat().st_mtime, reverse=True)
    for old in runs[MAX_RUNS:]:
        if not old.is_symlink():
            old.unlink()
    # Only our UUID-named trace files are eligible for quota rotation.
    files = _trace_files()
    total = sum(p.stat().st_size for p in files)
    for old in sorted(files, key=lambda p: p.stat().st_mtime):
        if total <= MAX_BYTES:
            break
        size = old.stat().st_size
        old.unlink()
        total -= size


def _append(data, event, fields):
    clean = {}
    for key, value in fields.items():
        if key in _NUMBERS and type(value) in (int, float) and math.isfinite(value) and 0 <= value <= 10**12:
            clean[key] = value
        elif key in _ENUMS and isinstance(value, str) and value in _ENUMS[key]:
            clean[key] = value
        elif key == 'request_id' and _identifier(value):
            clean[key] = value
        elif key == 'error_type' and _identifier(value, 80):
            clean[key] = value
        elif key == 'origin_trace_id' and isinstance(value, str) and re.fullmatch(r'[a-f0-9]{32}', value):
            clean[key] = value
            data['origin_trace_id'] = value
        elif key in ('existed', 'read_only', 'parent_exists') and type(value) is bool:
            clean[key] = value
        elif key in ('model_completed', 'content_saved', 'index_saved') and type(value) is bool:
            data['outcomes'][key] = value
    data['event_count'] += 1
    row = dict(event=event, at=_now(), elapsed_ms=round((time.monotonic()-data['_started']) * 1000, 2),
               pid=os.getpid(), thread_id=threading.get_ident())
    row.update(clean)
    data['events'].append(row)
    data['events'] = data['events'][-MAX_EVENTS:]
    data['events_dropped'] = max(0, data['event_count'] - MAX_EVENTS)
    if event in data['outcomes']:
        data['outcomes'][event] = True


def start_run(task_id, request_id=None):
    trace_id = uuid.uuid4().hex
    try:
        with _LOCK:
            _directory(task_id)
            data = dict(schema_version=1, trace_id=trace_id, task_id=task_id, historical=False,
                        app_version=_version(), runtime=dict(python='.'.join(map(str, sys.version_info[:3])),
                        platform=sys.platform if sys.platform in ('win32', 'linux', 'darwin') else 'other'),
                        started_at=_now(), stages=[], error=None, outcomes=dict(model_completed=None,
                        content_saved=None, index_saved=None), events=[], event_count=0, events_dropped=0,
                        _started=time.monotonic())
            _ACTIVE[task_id] = data
            while len(_ACTIVE) > 128:
                _ACTIVE.pop(next(iter(_ACTIVE)))
            _append(data, 'run_started', {'request_id': request_id})
            _persist(data)
    except Exception:
        pass
    return trace_id


def record_event(task_id, event, **fields):
    try:
        with _LOCK:
            if event not in _EVENTS or task_id not in _ACTIVE:
                return
            data = _ACTIVE[task_id]
            if fields.get('trace_id') is not None and fields['trace_id'] != data['trace_id']:
                return
            _append(data, event, fields)
            _persist(data)
    except Exception:
        pass


def current_trace_id(task_id):
    with _LOCK:
        return _ACTIVE.get(task_id, {}).get('trace_id')


def record_stage(task_id, status):
    try:
        status = getattr(status, 'value', status)
        with _LOCK:
            if status not in _STAGES or task_id not in _ACTIVE:
                return
            data = _ACTIVE[task_id]
            stages = data['stages']
            if stages and stages[-1]['name'] == status:
                return
            if status == 'SAVING':
                for key in ('content_saved', 'index_saved'):
                    if data['outcomes'][key] is None:
                        data['outcomes'][key] = False
            now = _now()
            if stages and stages[-1]['finished_at'] is None:
                previous = stages[-1]
                previous['finished_at'] = now
                previous['duration_ms'] = round((time.monotonic()-previous.pop('_started')) * 1000, 2)
                previous['status'] = 'failed' if status == 'FAILED' else 'succeeded'
            terminal = status in ('SUCCESS', 'FAILED')
            stages.append(dict(name=status, status=('failed' if status == 'FAILED' else 'succeeded') if terminal else 'running',
                               started_at=now, finished_at=now if terminal else None, duration_ms=0 if terminal else None,
                               _started=time.monotonic()))
            # Stage transitions are bounded alongside events.
            data['stages'] = stages[-MAX_EVENTS:]
            _append(data, 'stage', {})
            _persist(data)
            if terminal:
                _ACTIVE.pop(task_id, None)
    except Exception:
        pass


def record_failure(task_id, exc):
    try:
        with _LOCK:
            if task_id not in _ACTIVE:
                return
            data = _ACTIVE[task_id]
            if data['error'] is not None:
                return
            status = getattr(exc, 'status_code', None)
            category = ('permission' if isinstance(exc, PermissionError) else 'timeout' if isinstance(exc, TimeoutError)
                        or 'timeout' in type(exc).__name__.lower() else 'upstream_http' if type(status) is int
                        else 'filesystem' if isinstance(exc, OSError) else 'generation')
            frames = [dict(file=Path(frame.filename).name if Path(frame.filename).name in _FRAME_FILES else '<external>',
                           function=_identifier(frame.name, 80) or '<unknown>',
                           line=frame.lineno) for frame in traceback.extract_tb(exc.__traceback__)[-20:]]
            data['error'] = dict(category=category, type=_identifier(type(exc).__name__, 80) or 'Exception',
                                 message=_MESSAGES[category], errno=None, winerror=None, http_status=None,
                                 request_id=response_request_id(exc), frames=frames)
            for key in ('errno', 'winerror'):
                value = getattr(exc, key, None)
                if type(value) is int and 0 <= value <= 65535:
                    data['error'][key] = value
            if type(status) is int and 100 <= status <= 599:
                data['error']['http_status'] = status
            _append(data, 'failure', {'error_type': data['error']['type']})
            _persist(data)
    except Exception:
        pass


def _safe_number(value):
    return value if type(value) in (int, float) and math.isfinite(value) and 0 <= value <= 10**12 else None


def _safe_time(value):
    return value if isinstance(value, str) and re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?\+00:00', value) else None


def _safe_summary(data, task_id):
    """Disk files are untrusted. Rebuild the public schema rather than forwarding JSON."""
    if not isinstance(data, dict) or data.get('schema_version') != 1 or data.get('task_id') != task_id:
        raise ValueError('Invalid trace schema')
    trace_id = data.get('trace_id')
    if not isinstance(trace_id, str) or not re.fullmatch(r'[a-f0-9]{32}', trace_id):
        raise ValueError('Invalid trace ID')
    runtime = data.get('runtime') if isinstance(data.get('runtime'), dict) else {}
    result = dict(schema_version=1, task_id=task_id, trace_id=trace_id, historical=False,
                  app_version=_identifier(data.get('app_version'), 80) or 'unknown',
                  runtime=dict(python=runtime.get('python') if isinstance(runtime.get('python'), str)
                  and re.fullmatch(r'\d{1,2}\.\d{1,2}\.\d{1,2}', runtime['python']) else 'unknown',
                  platform=runtime.get('platform') if runtime.get('platform') in ('win32', 'linux', 'darwin') else 'other'),
                  started_at=_safe_time(data.get('started_at')), stages=[], error=None, outcomes={}, events=[],
                  event_count=_safe_number(data.get('event_count')),
                  events_dropped=_safe_number(data.get('events_dropped')))
    origin = data.get('origin_trace_id')
    if isinstance(origin, str) and re.fullmatch(r'[a-f0-9]{32}', origin):
        result['origin_trace_id'] = origin
    outcomes = data.get('outcomes') if isinstance(data.get('outcomes'), dict) else {}
    result['outcomes'] = {key: outcomes.get(key) if type(outcomes.get(key)) is bool else None
                          for key in ('model_completed', 'content_saved', 'index_saved')}
    for stage in (data.get('stages') if isinstance(data.get('stages'), list) else [])[-MAX_EVENTS:]:
        if isinstance(stage, dict) and stage.get('name') in _STAGES:
            result['stages'].append(dict(name=stage['name'],
                status=stage.get('status') if stage.get('status') in ('running', 'failed', 'succeeded') else 'running',
                started_at=_safe_time(stage.get('started_at')), finished_at=_safe_time(stage.get('finished_at')),
                duration_ms=_safe_number(stage.get('duration_ms'))))
    for event in (data.get('events') if isinstance(data.get('events'), list) else [])[-MAX_EVENTS:]:
        if not isinstance(event, dict) or event.get('event') not in _EVENTS:
            continue
        clean = dict(event=event['event'], at=_safe_time(event.get('at')),
                     elapsed_ms=_safe_number(event.get('elapsed_ms')), pid=_safe_number(event.get('pid')),
                     thread_id=_safe_number(event.get('thread_id')))
        for key, value in event.items():
            if key in _NUMBERS and _safe_number(value) is not None:
                clean[key] = value
            elif key in _ENUMS and isinstance(value, str) and value in _ENUMS[key]:
                clean[key] = value
            elif key in ('request_id', 'error_type') and _identifier(value, 128 if key == 'request_id' else 80):
                clean[key] = value
            elif key in ('existed', 'read_only', 'parent_exists') and type(value) is bool:
                clean[key] = value
            elif key == 'origin_trace_id' and isinstance(value, str) and re.fullmatch(r'[a-f0-9]{32}', value):
                clean[key] = value
        result['events'].append(clean)
    error = data.get('error')
    if isinstance(error, dict):
        category = error.get('category') if error.get('category') in _MESSAGES else 'generation'
        result['error'] = dict(category=category, type=_identifier(error.get('type'), 80) or 'Exception',
                             message=_MESSAGES[category], errno=_safe_number(error.get('errno')),
                             winerror=_safe_number(error.get('winerror')), http_status=None,
                             request_id=_identifier(error.get('request_id')), frames=[])
        http_status = error.get('http_status')
        if type(http_status) is int and 100 <= http_status <= 599:
            result['error']['http_status'] = http_status
        for frame in (error.get('frames') if isinstance(error.get('frames'), list) else [])[-20:]:
            if isinstance(frame, dict):
                result['error']['frames'].append(dict(file=frame.get('file') if frame.get('file') in _FRAME_FILES else '<external>',
                    function=_identifier(frame.get('function'), 80) or '<unknown>', line=_safe_number(frame.get('line'))))
    return result


def _read_run(path, task_id):
    if not _plain_path(path, _directory(task_id)) or not path.is_file() or path.stat().st_size > MAX_FILE_BYTES:
        raise ValueError('Invalid trace file')
    return _safe_summary(json.loads(path.read_text(encoding='utf-8')), task_id)


def get_summary(task_id):
    directory = _directory(task_id)
    try:
        with _LOCK:
            paths = sorted(directory.glob('*.json'), key=lambda p: p.stat().st_mtime, reverse=True)
            for path in paths:
                if path.is_symlink() or not re.fullmatch(r'[a-f0-9]{32}\.json', path.name):
                    continue
                try:
                    return _read_run(path, task_id)
                except (OSError, ValueError, KeyError, TypeError):
                    continue
    except OSError:
        pass
    return dict(schema_version=1, app_version='unknown', reporting_app_version=_version(), trace_id=None, task_id=task_id, historical=True, stages=[], error=None, events=[],
                outcomes=dict(model_completed=None, content_saved=None, index_saved=None),
                message='此任务没有结构化诊断记录，无法复原过往阶段或文件占用。')


def export_bundle(task_id, summary_extra=None):
    summary = get_summary(task_id)
    # The router supplies only its dedicated safe storage summary, never note data.
    if summary_extra is not None:
        summary['storage'] = summary_extra
    output = io.BytesIO()
    with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as archive:
        archive.writestr('README.txt', 'BiliNote task diagnostics\nNo note text, subtitles, prompts, API secrets or raw exception bodies are collected.\nHistorical errors cannot be reconstructed. Events/runs rotate; events_dropped records truncation.\n')
        archive.writestr('summary.json', json.dumps(summary, ensure_ascii=False, indent=2))
        archive.writestr('events.json', json.dumps(summary['events'], ensure_ascii=False, indent=2))
        directory = _directory(task_id)
        paths = sorted((p for p in directory.glob('*.json') if not p.is_symlink()
                        and re.fullmatch(r'[a-f0-9]{32}\.json', p.name)),
                       key=lambda p: p.stat().st_mtime, reverse=True)[:MAX_RUNS]
        for path in paths:
            try:
                run = _read_run(path, task_id)
                archive.writestr('runs/' + path.name, json.dumps(run, ensure_ascii=False, indent=2))
            except (OSError, ValueError, TypeError):
                continue
        archive.writestr('system-capture-guide.txt', 'Windows 文件占用采集（可选，手动操作）\n使用 Microsoft Sysinternals Process Monitor，筛选 BiliNote 后端进程及失败文件，观察 CreateFile / SetRenameInformationFile 的 Result、时间与进程。\nHandle 可只读查询文件句柄；不要关闭句柄或结束进程。工具可能要求管理员权限，由用户自行决定。\n未发现持有者不能排除瞬时占用、权限、杀毒或同步程序干扰。分享采集前隐藏完整路径、用户名和敏感数据。\n官方说明：https://learn.microsoft.com/sysinternals/downloads/procmon\nhttps://learn.microsoft.com/sysinternals/downloads/handle\n')
    return output.getvalue()
