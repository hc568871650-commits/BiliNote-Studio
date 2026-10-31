"""Durable, task-owned notes. Legacy flat files are read only until imported."""

import json
import hashlib
import os
import re
import shutil
import tempfile
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import unquote, urlparse

ROOT = Path(os.getenv("NOTE_OUTPUT_DIR", "note_results"))
TASK_ID = re.compile(r"^[a-zA-Z0-9_-]{1,100}$")
IMAGE_LINK = re.compile(r"(!\[[^\]]*\]\()([^\s)]+)(\))")
LOCK = threading.RLock()


def _diagnostic(task_id, event, **fields):
    try:
        from app.services.note_diagnostics import record_event
        record_event(task_id, event, **fields)
    except Exception:
        pass


def _replace_note_file(source, target):
    target = Path(target)
    task_id = next((part.name.rsplit('__', 1)[-1] for part in target.parents
                    if '__' in part.name and TASK_ID.fullmatch(part.name.rsplit('__', 1)[-1])), None)
    role = {'manifest.json': 'manifest', 'result.json': 'metadata', 'transcript.json': 'transcript',
            'status.json': 'status'}.get(target.name, 'markdown' if target.suffix == '.md' else 'metadata')
    delays = (0.04, 0.12, 0.3, 0.6)
    for attempt in range(len(delays) + 1):
        try:
            os.replace(source, target)
            return
        except OSError as error:
            retryable = isinstance(error, PermissionError) or getattr(error, 'winerror', None) in (5, 32, 33)
            existed = parent_exists = None
            try:
                existed = target.exists()
            except OSError:
                pass
            try:
                parent_exists = target.parent.exists()
            except OSError:
                pass
            try:
                read_only = existed and not bool(target.stat().st_mode & 0o200)
            except OSError:
                read_only = None
            fields = dict(target=role, attempt=attempt + 1, errno=error.errno,
                          winerror=getattr(error, 'winerror', None), existed=existed,
                          parent_exists=parent_exists, read_only=read_only)
            if not retryable or attempt == len(delays):
                if task_id:
                    outcome = {'content_saved': False} if role == 'markdown' else {'index_saved': False}
                    _diagnostic(task_id, 'replace_failed', **fields, **outcome)
                raise
            if task_id:
                _diagnostic(task_id, 'replace_retry', delay_ms=int(delays[attempt] * 1000), **fields)
            time.sleep(delays[attempt])


def valid_id(task_id):
    if not isinstance(task_id, str) or not TASK_ID.fullmatch(task_id):
        raise ValueError("Invalid task ID")
    return task_id


def _atomic_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=".note-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as out:
            json.dump(data, out, ensure_ascii=False, indent=2)
            out.flush()
            os.fsync(out.fileno())
        _replace_note_file(name, path)
    finally:
        if os.path.exists(name):
            try:
                os.unlink(name)
            except OSError:
                pass


def _atomic_text(path, content):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=".note-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as out:
            out.write(content)
            out.flush()
            os.fsync(out.fileno())
        _replace_note_file(name, path)
    finally:
        if os.path.exists(name):
            try:
                os.unlink(name)
            except OSError:
                pass


def _owned(folder):
    _inside(folder, ROOT)
    for part in (folder / "images", folder / "versions", folder / "_meta"):
        if part.is_symlink() or (part.exists() and not part.resolve().is_relative_to(folder.resolve())):
            raise ValueError("Linked note contents require manual inspection")


def _safe_title(title):
    title = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", title or "教程").strip(" .")[:75]
    return title if title and title.upper() not in {"CON", "PRN", "AUX", "NUL", "COM1", "LPT1"} else "教程"


def _inside(path, root):
    root = root.resolve()
    path = path.resolve()
    if not path.is_relative_to(root):
        raise ValueError("Path escapes note storage")
    return path


def _note_dir(task_id, create=False, title=""):
    valid_id(task_id)
    ROOT.mkdir(parents=True, exist_ok=True)
    dirs = [p for p in ROOT.iterdir() if p.is_dir() and not p.is_symlink() and p.name.endswith("__" + task_id)]
    if len(dirs) > 1:
        raise ValueError("Duplicate note directories")
    if dirs:
        folder = _inside(dirs[0], ROOT)
        _owned(folder)
        return folder
    if create:
        path = ROOT / f"{_safe_title(title)}__{task_id}"
        path.mkdir(parents=True, exist_ok=False)
        _owned(path)
        return path
    return None


def _manifest(task_id):
    folder = _note_dir(task_id)
    path = (folder / "_meta" / "manifest.json") if folder else ROOT / "_pending_deletions" / f"{task_id}.json"
    if not path.is_file():
        path = ROOT / "_pending_deletions" / f"{task_id}.json"
    return json.loads(path.read_text(encoding="utf-8")) if path.is_file() else None


def _public(task):
    task = dict(task)
    task_id = task["id"]
    # Older manifests did not retain errors. Read the task-owned status snapshot
    # as well so detail/list reloads do not erase a failure already shown by polling.
    snapshot = status_path(task_id)
    if snapshot.is_file():
        try:
            state = json.loads(snapshot.read_text(encoding="utf-8"))
            task["status"] = state.get("status") or task.get("status")
            task["statusMessage"] = state.get("message") or ""
            task['cancelled'] = bool(state.get('cancelled'))
            task["last_active_status"] = state.get("last_active_status") or task.get("last_active_status")
            task["status_updated_at"] = state.get("status_updated_at") or datetime.fromtimestamp(snapshot.stat().st_mtime, timezone.utc).isoformat()
            task["started_at"] = state.get("started_at") or task.get("started_at")
            task["finished_at"] = (state.get("finished_at") or task["status_updated_at"]) if task["status"] in ("SUCCESS", "FAILED") else None
        except (OSError, ValueError):
            pass
    if not (task.get("audioMeta") or {}).get("title"):
        try:
            cached = json.loads(cache_path(task_id, "audio").read_text(encoding="utf-8"))
            if cached.get("title"):
                task["audioMeta"] = dict(task.get("audioMeta") or {}, title=cached["title"])
        except (OSError, ValueError):
            pass
    task["resource_base"] = f"/api/notes/{task_id}/assets/"
    if isinstance(task.get("markdown"), list):
        task["markdown"] = [dict(ver, resource_base=f"/api/notes/{task_id}/assets/versions/")
                            for ver in task["markdown"]]
    return task


def get_task(task_id):
    with LOCK:
        manifest = _manifest(task_id)
        return _public(manifest["task"]) if manifest else None


def list_tasks():
    with LOCK:
        ROOT.mkdir(parents=True, exist_ok=True)
        tasks = []
        for path in ROOT.iterdir():
            if path.is_dir() and not path.is_symlink() and "__" in path.name:
                task_id = path.name.rsplit("__", 1)[-1]
                if TASK_ID.fullmatch(task_id):
                    task = get_task(task_id)
                    if task:
                        tasks.append(task)
        pending_dir = ROOT / "_pending_deletions"
        if pending_dir.exists():
            known = {task["id"] for task in tasks}
            for path in pending_dir.glob("*.json"):
                if TASK_ID.fullmatch(path.stem) and path.stem not in known:
                    task = get_task(path.stem)
                    if task:
                        tasks.append(task)
        return sorted(tasks, key=lambda t: t.get("createdAt") or "", reverse=True)


def _image_source(url, staging):
    parsed = urlparse(unquote(url))
    if parsed.scheme not in ("", "http", "https"):
        return None
    if parsed.scheme and parsed.hostname not in ("localhost", "127.0.0.1"):
        return None
    path = parsed.path.replace("\\", "/")
    if path.startswith("/static/screenshots/"):
        name = Path(path).name
        if name == path.rsplit("/", 1)[-1]:
            return _inside(Path(os.getenv("OUT_DIR", "./static/screenshots")) / name,
                           Path(os.getenv("OUT_DIR", "./static/screenshots")))
    if staging and path.startswith("images/") and len(Path(path).parts) == 2:
        return _inside(Path(staging) / path, Path(staging) / "images")
    return None


def _copy_images(markdown, folder, version_id, staging=None, version=False):
    def replace(match):
        url = match.group(2)
        source = _image_source(url, staging)
        if source is None:
            return match.group(0)
        if not source.is_file():
            if staging and source.is_relative_to((Path(staging) / "images").resolve()):
                raise FileNotFoundError(f"Missing generated image: {source}")
            return match.group(0)
        suffix = source.suffix.lower()
        if suffix not in (".jpg", ".jpeg", ".png", ".webp", ".gif"):
            raise ValueError("Unsupported note image")
        name = f"{version_id}_{uuid.uuid5(uuid.NAMESPACE_URL, str(source)).hex[:16]}{suffix}"
        target = folder / "images" / name
        target.parent.mkdir(parents=True, exist_ok=True)
        if not target.exists():
            shutil.copy2(source, target)
        relative = ("../images/" if version else "images/") + name
        return match.group(1) + relative + match.group(3)
    return IMAGE_LINK.sub(replace, markdown)


def _version_id(value):
    candidate = str(value or uuid.uuid4())
    return candidate if TASK_ID.fullmatch(candidate) else uuid.uuid4().hex


def _publish_evidence(evidence, folder, version_id, staging):
    """Preserve frame evidence before generation staging is removed."""
    result = json.loads(json.dumps(evidence))
    for group in ('frames', 'screenshots'):
        for item in result.get(group) or []:
            relative = item.pop('path', None)
            if not relative or not staging:
                continue
            source = _inside(Path(staging) / relative, Path(staging))
            if not source.is_file() or source.suffix.lower() not in ('.jpg', '.png', '.webp'):
                raise FileNotFoundError('Missing generated evidence frame')
            name = f'{version_id}_evidence_{uuid.uuid5(uuid.NAMESPACE_URL, relative).hex[:16]}{source.suffix.lower()}'
            destination = folder / 'images' / name
            destination.parent.mkdir(exist_ok=True)
            if not destination.exists():
                shutil.copy2(source, destination)
            item['path'] = '../images/' + name
    return result


def save_task(task, staging=None, import_legacy=False, recoverable=False):
    """Merge versions by ID. Import never overwrites a newer server-owned version."""
    task_id = valid_id(task["id"])
    with LOCK:
        if (ROOT / "_tombstones" / f"{task_id}.json").exists():
            raise ValueError("This note was permanently deleted")
        existing = _manifest(task_id)
        if existing and import_legacy:
            return _public(existing["task"])
        title = (task.get("audioMeta") or {}).get("title") or task_id
        folder = _note_dir(task_id, create=not bool(existing), title=title)
        if existing and title != task_id and folder.name in (f"{task_id}__{task_id}", f"正在解析视频标题__{task_id}"):
            target = ROOT / f"{_safe_title(title)}__{task_id}"
            if not target.exists():
                folder.rename(target)
                folder = target
        versions = []
        previous = existing["task"] if existing else None
        if previous and isinstance(previous.get("markdown"), list):
            versions = list(previous["markdown"])
        incoming = task.get("markdown") or ""
        if isinstance(incoming, str):
            form = task.get("formData") or (previous or {}).get("formData") or {}
            incoming = ([{"ver_id": uuid.uuid4().hex, "content": incoming,
                          "style": form.get("style") or "", "model_name": form.get("model_name") or "",
                          "created_at": datetime.now(timezone.utc).isoformat()}] if incoming else [])
        known = {v["ver_id"] for v in versions}
        pending_version_files = []
        for item in reversed(incoming):
            ver = dict(item)
            ver_id = _version_id(ver.get("ver_id"))
            if ver_id in known:
                continue
            content = _copy_images(ver.get("content") or "", folder, ver_id, staging, version=True)
            if isinstance(ver.get('evidence'), dict):
                ver['evidence'] = _publish_evidence(ver['evidence'], folder, ver_id, staging)
            ver.update(ver_id=ver_id, content=content)
            ver.pop("resource_base", None)
            versions.insert(0, ver)
            known.add(ver_id)
            version_path = folder / "versions" / f"{ver_id}.md"
            version_path.parent.mkdir(parents=True, exist_ok=True)
            pending_version_files.append((version_path, content))
        data = dict(previous or {}, **task)
        data.pop("resource_base", None)
        data.update(id=task_id, markdown=versions,
                    archived_at=(previous or {}).get("archived_at"),
                    createdAt=(previous or {}).get("createdAt") or task.get("createdAt") or datetime.now(timezone.utc).isoformat())
        manifest = {"schema_version": 1, "task": data, "updated_at": datetime.now(timezone.utc).isoformat()}
        if recoverable and versions:
            # Persist recovery data before publishing new versions. Never include this file in diagnostics.
            state = _read_json(status_path(task_id))
            publication = _publication_contents(data)
            _atomic_json(folder / '_meta' / 'save-recovery.json', {
                'schema_version': 1, 'task_id': task_id,
                'started_at': state.get('started_at'),
                'request_id': (data.get('formData') or {}).get('request_id'),
                'previous_fingerprint': _task_fingerprint(previous or {}),
                'publication_before': {name: _file_digest(_inside(folder / name, folder)) for name in publication},
                'publication_target': {name: _written_digest(text) for name, text in publication.items()},
                'manifest': manifest,
            })
        for version_path, content in pending_version_files:
            _atomic_text(version_path, content)
        if recoverable and versions:
            _diagnostic(task_id, 'content_saved', target='content')
        if versions:
            current = versions[0]["content"].replace("../images/", "images/")
            _atomic_text(folder / "笔记.md", current)
        meta = folder / "_meta"
        meta.mkdir(exist_ok=True)
        _atomic_json(meta / "result.json", {
            "markdown": versions[0]["content"] if versions else "",
            "transcript": data.get("transcript") or {},
            "audio_meta": data.get("audioMeta") or {},
        })
        # This file is also the generation cache. A metadata-only retry must not
        # overwrite valid transcribed segments with the original empty draft.
        if "transcript" in task or not (meta / "transcript.json").exists():
            _atomic_json(meta / "transcript.json", data.get("transcript") or {})
        _atomic_json(meta / "manifest.json", manifest)
        if recoverable:
            _diagnostic(task_id, 'index_saved', target='index')
        return _public(data)


def save_result(task_id, note, staging=None):
    from dataclasses import asdict
    result = asdict(note)
    markdown = result['markdown']
    if result.get('evidence'):
        task = get_task(task_id) or {}
        form = task.get('formData') or {}
        markdown = [{'ver_id': uuid.uuid4().hex, 'content': markdown, 'evidence': result['evidence'],
                     'style': form.get('style') or 'tutorial', 'model_name': form.get('model_name') or '',
                     'provider_id': form.get('provider_id'), 'created_at': datetime.now(timezone.utc).isoformat()}]
    return save_task({"id": task_id, "markdown": markdown,
                      "transcript": result["transcript"], "audioMeta": result["audio_meta"],
                      "status": "SUCCESS"}, staging=staging, recoverable=True)


def _read_json(path):
    try:
        if path.is_file() and path.stat().st_size <= 64 * 1024 * 1024:
            value = json.loads(path.read_text(encoding='utf-8'))
            return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        pass
    return {}


def _task_fingerprint(task):
    ignored = {'status', 'statusMessage', 'last_active_status', 'started_at', 'finished_at',
               'status_updated_at', 'archived_at', 'resource_base'}
    return hashlib.sha256(json.dumps({k: v for k, v in task.items() if k not in ignored},
                                    ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def _file_digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None


def _written_digest(text):
    return hashlib.sha256(text.replace('\n', os.linesep).encode('utf-8')).hexdigest()


def _publication_contents(task):
    content = task['markdown'][0]['content']
    return {'笔记.md': content.replace('../images/', 'images/'),
            '_meta/result.json': json.dumps({'markdown': content, 'transcript': task.get('transcript') or {},
                                             'audio_meta': task.get('audioMeta') or {}}, ensure_ascii=False, indent=2),
            '_meta/transcript.json': json.dumps(task.get('transcript') or {}, ensure_ascii=False, indent=2)}


def _verified_versions(folder, versions, allow_missing_ids=()):
    if not isinstance(versions, list) or not versions:
        return False
    for version in versions:
        if not isinstance(version, dict) or not TASK_ID.fullmatch(str(version.get('ver_id', ''))):
            return False
        content = version.get('content')
        path = _inside(folder / 'versions' / (version['ver_id'] + '.md'), folder)
        if not isinstance(content, str) or not content.strip():
            return False
        if not path.is_file():
            if version['ver_id'] in allow_missing_ids:
                continue
            return False
        if path.read_text(encoding='utf-8') != content:
            return False
    return True


def _recovery_candidate(task_id):
    manifest = _manifest(task_id)
    if not manifest:
        return None, '笔记不存在'
    task = manifest['task']
    public = _public(task)
    if public.get('archived_at'):
        return None, '请先恢复归档笔记'
    if public.get('status') != 'FAILED' or public.get('last_active_status') != 'SAVING':
        return None, '仅保存阶段失败的任务可重试保存'
    folder = _note_dir(task_id)
    journal = _read_json(folder / '_meta' / 'save-recovery.json')
    if journal:
        saved_manifest = journal.get('manifest')
        candidate = saved_manifest.get('task') if isinstance(saved_manifest, dict) else None
        if not isinstance(candidate, dict):
            return None, '保存记录损坏，请保留现场检查'
        if (journal.get('schema_version') != 1 or journal.get('task_id') != task_id or candidate.get('id') != task_id
                or journal.get('started_at') != public.get('started_at')
                or journal.get('request_id') != (task.get('formData') or {}).get('request_id')
                or _task_fingerprint(task) not in (journal.get('previous_fingerprint'), _task_fingerprint(candidate))):
            return None, '保存记录已变化，不能覆盖当前笔记'
        publication = _publication_contents(candidate)
        before, intended = journal.get('publication_before'), journal.get('publication_target')
        if not isinstance(before, dict) or not isinstance(intended, dict) or set(before) != set(publication) or set(intended) != set(publication):
            return None, '保存记录不完整，请保留现场检查'
        for name, text in publication.items():
            expected = _written_digest(text)
            if intended[name] != expected or _file_digest(_inside(folder / name, folder)) not in (before[name], expected):
                return None, '正文或保存文件已修改，不能覆盖现有内容'
        current_ids = {v.get('ver_id') for v in task.get('markdown', []) if isinstance(v, dict)} if isinstance(task.get('markdown'), list) else set()
        pending_ids = {v.get('ver_id') for v in candidate.get('markdown', []) if isinstance(v, dict)} - current_ids
        if not _verified_versions(folder, candidate.get('markdown'), allow_missing_ids=pending_ids):
            return None, '正文文件缺失或已更改，请保留现场检查'
        return candidate, '已有完整结果，可重试保存'
    # Legacy repair requires the current attempt's durable version and all published copies to agree.
    versions = task.get('markdown')
    if not _verified_versions(folder, versions):
        return None, '历史任务缺少完整保存记录'
    latest = versions[0]
    try:
        started = datetime.fromisoformat(public['started_at'])
        created = datetime.fromisoformat(latest['created_at'])
        finished = datetime.fromisoformat(public['finished_at'])
        if not started <= created <= finished:
            return None, '现有正文来自其他生成任务'
        result = _read_json(folder / '_meta' / 'result.json')
        if (result.get('markdown') != latest['content']
                or result.get('transcript') != (task.get('transcript') or {})
                or result.get('audio_meta') != (task.get('audioMeta') or {})
                or (folder / '笔记.md').read_text(encoding='utf-8') != latest['content'].replace('../images/', 'images/')):
            return None, '历史保存结果不一致，请保留现场检查'
    except (OSError, ValueError, KeyError, TypeError):
        return None, '历史任务缺少可核验的保存时间或结果'
    return task, '已核验本次正文与结果，可重试保存'


def save_recovery_summary(task_id):
    with LOCK:
        try:
            candidate, reason = _recovery_candidate(valid_id(task_id))
            return {'available': candidate is not None, 'reason': reason}
        except (OSError, ValueError, KeyError, TypeError):
            return {'available': False, 'reason': '保存现场暂时无法读取，请稍后重试'}


def complete_save_recovery(task_id):
    with LOCK:
        folder = _note_dir(task_id)
        if folder:
            try:
                (folder / '_meta' / 'save-recovery.json').unlink(missing_ok=True)
            except OSError:
                pass


def retry_saved_result(task_id):
    with LOCK:
        candidate, reason = _recovery_candidate(valid_id(task_id))
        if candidate is None:
            raise ValueError(reason)
        folder = _note_dir(task_id)
        versions = candidate['markdown']
        current = versions[0]['content']
        for version in versions:
            path = _inside(folder / 'versions' / (version['ver_id'] + '.md'), folder)
            if not path.is_file():
                _atomic_text(path, version['content'])
        _atomic_text(folder / '笔记.md', current.replace('../images/', 'images/'))
        _atomic_json(folder / '_meta' / 'result.json', {
            'markdown': current, 'transcript': candidate.get('transcript') or {}, 'audio_meta': candidate.get('audioMeta') or {},
        })
        _atomic_json(folder / '_meta' / 'transcript.json', candidate.get('transcript') or {})
        _diagnostic(task_id, 'content_saved', target='content')
        _atomic_json(folder / '_meta' / 'manifest.json', {
            'schema_version': 1, 'task': dict(candidate, status='SUCCESS'), 'updated_at': datetime.now(timezone.utc).isoformat(),
        })
        _diagnostic(task_id, 'index_saved', target='index')
        write_status(task_id, 'SUCCESS', '已有正文保存完成')
        complete_save_recovery(task_id)
        return get_task(task_id)


def set_status(task_id, status):
    with LOCK:
        manifest = _manifest(task_id)
        if not manifest:
            return
        manifest["task"]["status"] = status
        _atomic_json(_note_dir(task_id) / "_meta" / "manifest.json", manifest)


class GenerationCancelled(Exception):
    cancelled = True


def request_cancellation(task_id, request_id):
    _atomic_json(status_path(task_id).with_suffix('.cancel.json'), {'request_id': request_id})


def clear_cancellation(task_id):
    path = status_path(task_id).with_suffix('.cancel.json')
    if path.is_file():
        path.unlink()


def check_cancellation(task_id, request_id):
    path = status_path(task_id).with_suffix('.cancel.json')
    if path.is_file() and json.loads(path.read_text(encoding='utf-8')).get('request_id') == request_id:
        raise GenerationCancelled('已取消生成；已发出的请求结束后不再继续处理')


def write_status(task_id, status, message=None, *, cancelled=False):
    """Persist both polling and library snapshots; a new attempt resets progress."""
    active = {"PENDING", "PARSING", "DOWNLOADING", "TRANSCRIBING", "SUMMARIZING", "FORMATTING", "SAVING"}
    try:
        from app.services.note_diagnostics import record_stage
        if status in active:
            record_stage(task_id, status)
    except Exception:
        pass
    with LOCK:
        path = status_path(task_id)
        try:
            previous = json.loads(path.read_text(encoding="utf-8")) if path.is_file() else {}
        except (OSError, ValueError):
            previous = {}
        last = status if status in active else previous.get("last_active_status")
        if not last and previous.get("status") in active:
            last = previous["status"]
        now = datetime.now(timezone.utc).isoformat()
        state = {"status": status, "message": message or "", "status_updated_at": now,
                 "cancelled": cancelled,
                 "started_at": now if status == "PENDING" else previous.get("started_at"),
                 "finished_at": (previous.get("finished_at") or now) if status in ("SUCCESS", "FAILED") else None}
        if last:
            state["last_active_status"] = last
        _atomic_json(path, state)
        manifest = _manifest(task_id)
        if manifest:
            manifest["task"].update(status=status, statusMessage=message or "", last_active_status=last,
                                    cancelled=cancelled)
            manifest["task"].update({key: state[key] for key in ("started_at", "finished_at", "status_updated_at")})
            _atomic_json(_note_dir(task_id) / "_meta" / "manifest.json", manifest)
        if status not in active:
            try:
                from app.services.note_diagnostics import record_stage
                record_stage(task_id, status)
            except Exception:
                pass
        return state


def update_audio_metadata(task_id, audio_meta):
    """Publish the source title before transcription/model generation completes."""
    if not task_id:
        return
    with LOCK:
        manifest = _manifest(task_id)
        if manifest:
            manifest["task"]["audioMeta"] = dict(manifest["task"].get("audioMeta") or {}, **audio_meta)
            _atomic_json(_note_dir(task_id) / "_meta" / "manifest.json", manifest)


def set_archived(task_id, archived, archived_at=None):
    with LOCK:
        manifest = _manifest(task_id)
        if not manifest:
            raise FileNotFoundError("Note not imported")
        task = manifest["task"]
        if manifest.get("deletion_pending"):
            raise ValueError("Deletion pending; retry deletion")
        if task.get("status") not in ("SUCCESS", "FAILED"):
            raise ValueError("Running notes cannot be archived")
        task["archived_at"] = (archived_at or datetime.now(timezone.utc).isoformat()) if archived else None
        folder = _note_dir(task_id)
        _atomic_json(folder / "_meta" / "manifest.json", manifest)
        return _public(task)


def asset(task_id, relative):
    folder = _note_dir(task_id)
    if not folder or not _manifest(task_id):
        raise FileNotFoundError("Note not found")
    # Only images are public, even when the relative URL starts in versions/.
    candidate = (folder / relative).resolve()
    images = folder / "images"
    if images.is_symlink():
        raise ValueError("Linked image directory")
    images = images.resolve()
    if not candidate.is_relative_to(images) or candidate.suffix.lower() not in (".jpg", ".jpeg", ".png", ".webp", ".gif"):
        raise ValueError("Invalid image path")
    if not candidate.is_file():
        raise FileNotFoundError("Image not found")
    return candidate


def result_path(task_id):
    folder = _note_dir(task_id)
    if folder and _manifest(task_id):
        return folder / "_meta" / "result.json"
    return _inside(ROOT / f"{valid_id(task_id)}.json", ROOT)


def cache_path(task_id, kind):
    valid_id(task_id)
    if kind not in ("audio", "transcript", "markdown"):
        raise ValueError("Invalid cache type")
    suffix = ".md" if kind == "markdown" else ".json"
    legacy = ROOT / f"{task_id}_{kind}{suffix}"
    folder = _note_dir(task_id)
    current = folder / "_meta" / f"{kind}{suffix}" if folder else None
    return current if current and (current.exists() or not legacy.exists()) else legacy


def status_path(task_id):
    valid_id(task_id)
    folder = _note_dir(task_id)
    current = folder / "_meta" / "status.json" if folder else None
    legacy = ROOT / f"{task_id}.status.json"
    return current if current and (current.exists() or not legacy.exists()) else legacy


def create_draft(task_id, form_data):
    existing = get_task(task_id)
    if existing:
        if existing.get("archived_at"):
            raise ValueError("Archived notes must be restored before regeneration")
        set_status(task_id, "PENDING")
        return
    source = str(form_data.get("video_url") or "").replace("\\", "/")
    title = Path(unquote(source)).stem if form_data.get("platform") == "local" else "正在解析视频标题"
    save_task({"id": task_id, "status": "PENDING", "markdown": "",
               "audioMeta": {"title": title or "本地视频", "video_id": "", "platform": form_data.get("platform", "")},
               "transcript": {"full_text": "", "segments": []},
               "formData": form_data})


def delete_task(task_id):
    """Keep a retryable manifest on failure; never touch legacy/shared resources."""
    with LOCK:
        task = get_task(task_id)
        if not task:
            if (ROOT / "_tombstones" / f"{valid_id(task_id)}.json").exists():
                return True
            raise FileNotFoundError("Note not found")
        if not task.get("archived_at") or task.get("status") not in ("SUCCESS", "FAILED"):
            raise ValueError("Only archived, inactive notes can be deleted")
        folder = _note_dir(task_id)
        manifest = _manifest(task_id)
        manifest["deletion_pending"] = True
        journal = ROOT / "_pending_deletions" / f"{task_id}.json"
        _atomic_json(journal, manifest)
        if folder and (folder / "_meta").is_dir():
            _atomic_json(folder / "_meta" / "manifest.json", manifest)
        tombstone = ROOT / "_tombstones" / f"{task_id}.json"
        _atomic_json(tombstone, {"id": task_id, "deletion_pending": True})
        from app.services.vector_store import VectorStoreManager
        VectorStoreManager().delete_index(task_id)
        from app.db.video_task_dao import delete_task_by_id
        delete_task_by_id(task_id)
        # Descendant symlinks must never lead deletion outside the task directory.
        if folder:
            for path in folder.rglob("*"):
                if path.is_symlink():
                    raise ValueError("Linked content in note directory; manual inspection required")
            shutil.rmtree(folder)
        _atomic_json(tombstone, {"id": task_id, "deleted_at": datetime.now(timezone.utc).isoformat()})
        journal.unlink(missing_ok=True)
        return True


def cleanup_completed_runs(temp_root=None):
    """At startup, retry only runs of durable successful notes."""
    temp_root = Path(temp_root or Path("Temp") / "note_jobs")
    if not temp_root.exists():
        return []
    pending = []
    for task_dir in temp_root.iterdir():
        if task_dir.is_symlink() or not task_dir.is_dir() or not TASK_ID.fullmatch(task_dir.name):
            continue
        task = get_task(task_dir.name)
        status_file = status_path(task_dir.name)
        try:
            status = json.loads(status_file.read_text(encoding="utf-8")) if status_file.exists() else {}
        except (OSError, ValueError):
            status = {}
        if not task or task.get("status") != "SUCCESS" or status.get("status") != "SUCCESS":
            continue
        for run in task_dir.iterdir():
            if run.is_symlink() or not run.is_dir() or not TASK_ID.fullmatch(run.name):
                continue
            if any(path.is_symlink() for path in run.rglob("*")):
                pending.append(str(run))
                continue
            try:
                shutil.rmtree(run)
            except OSError:
                pending.append(str(run))
    return pending


def recover_interrupted_runs():
    """No job survives backend restart; keep its data but make retry possible."""
    recovered = []
    with LOCK:
        for task in list_tasks():
            if task.get("status") in ("SUCCESS", "FAILED"):
                continue
            task_id = task["id"]
            write_status(task_id, "FAILED", "上次生成中断，请检查后重试")
            recovered.append(task_id)
    return recovered
