"""Logical folders: only this metadata file is written; tutorial files never move."""
import copy
import json
import os
import tempfile
import threading
import unicodedata
import uuid
from pathlib import Path

from app.services import note_storage

STATE_PATH = Path("data") / "note_folders.json"
LOCK = threading.RLock()
DEFAULT_ID = "default"
DEFAULT_FOLDER = {"id": DEFAULT_ID, "name": "默认文件夹"}


class InvalidFolderState(RuntimeError):
    pass


def _name(value):
    if not isinstance(value, str):
        raise ValueError("请输入文件夹名称")
    value = unicodedata.normalize("NFKC", value).strip()
    if not value or len(value) > 60 or any(unicodedata.category(c).startswith("C") for c in value):
        raise ValueError("文件夹名称须为 1 至 60 个字符，不能包含控制字符")
    return value


def _initial():
    return {"schema_version": 1, "folders": [
        {"id": "distill", "name": "蒸馏视频"},
        {"id": "learn", "name": "学习视频"},
    ], "assignments": {}}


def _read():
    if not STATE_PATH.exists():
        return _initial()
    try:
        state = json.loads(STATE_PATH.read_text(encoding="utf-8"))
        if not isinstance(state, dict) or state.get("schema_version") != 1:
            raise ValueError("schema")
        folders, assignments = state["folders"], state["assignments"]
        if not isinstance(folders, list) or not isinstance(assignments, dict):
            raise ValueError("structure")
        ids, names = {DEFAULT_ID}, {DEFAULT_FOLDER["name"].casefold(), "全部笔记"}
        for folder in folders:
            folder_id = note_storage.valid_id(folder["id"])
            name = _name(folder["name"])
            if name != folder["name"] or folder_id in ids or name.casefold() in names:
                raise ValueError("duplicate")
            ids.add(folder_id)
            names.add(name.casefold())
        for task_id, folder_id in assignments.items():
            note_storage.valid_id(task_id)
            if not isinstance(folder_id, str) or folder_id not in ids:
                raise ValueError("assignment")
        return state
    except (ValueError, TypeError, KeyError, OSError) as exc:
        raise InvalidFolderState("文件夹记录读取失败，原记录已保留；请检查 data/note_folders.json") from exc


def _write(state):
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".folders-", suffix=".tmp", dir=STATE_PATH.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as out:
            json.dump(state, out, ensure_ascii=False, indent=2)
            out.flush()
            os.fsync(out.fileno())
        os.replace(temporary, STATE_PATH)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def _public(state):
    return {"folders": [dict(DEFAULT_FOLDER), *copy.deepcopy(state["folders"])],
            "assignments": dict(state["assignments"])}


def _folder(state, folder_id):
    for folder in state["folders"]:
        if folder["id"] == folder_id:
            return folder
    raise FileNotFoundError("文件夹不存在，请刷新后重试")


def _unique_name(state, name, except_id=None):
    name = _name(name)
    if name.casefold() in {DEFAULT_FOLDER["name"].casefold(), "全部笔记"} or any(
        f["id"] != except_id and f["name"].casefold() == name.casefold() for f in state["folders"]
    ):
        raise ValueError("已存在同名文件夹，请换一个名称")
    return name


def list_folders():
    with LOCK:
        return _public(_read())


def create_folder(name, folder_id=None):
    with LOCK:
        state = _read()
        name = _unique_name(state, name)
        folder_id = note_storage.valid_id(folder_id) if folder_id is not None else uuid.uuid4().hex
        if folder_id == DEFAULT_ID or any(f['id'] == folder_id for f in state['folders']):
            raise ValueError('文件夹 ID 已存在')
        state["folders"].append({"id": folder_id, "name": name})
        _write(state)
        return _public(state)


def rename_folder(folder_id, name):
    if folder_id == DEFAULT_ID:
        raise ValueError("默认文件夹不能重命名")
    with LOCK:
        state = _read()
        folder = _folder(state, folder_id)
        folder["name"] = _unique_name(state, name, except_id=folder_id)
        _write(state)
        return _public(state)


def delete_folder(folder_id):
    if folder_id == DEFAULT_ID:
        raise ValueError("默认文件夹不能删除")
    with LOCK:
        state = _read()
        _folder(state, folder_id)
        state["folders"] = [f for f in state["folders"] if f["id"] != folder_id]
        # Missing assignments mean default. One atomic replacement dissolves the folder.
        state["assignments"] = {task: folder for task, folder in state["assignments"].items()
                                if folder != folder_id}
        _write(state)
        return _public(state)


def move_notes(task_ids, folder_id):
    if not isinstance(task_ids, list) or not 1 <= len(task_ids) <= 500:
        raise ValueError("每次请选择 1 至 500 篇教程")
    with LOCK, note_storage.LOCK:
        state = _read()
        if folder_id != DEFAULT_ID:
            _folder(state, folder_id)
        for task_id in task_ids:
            try:
                note_storage.valid_id(task_id)
            except ValueError as exc:
                raise ValueError("教程 ID 无效") from exc
            manifest = note_storage._manifest(task_id)
            if not manifest or manifest.get("deletion_pending"):
                raise FileNotFoundError("部分教程不存在或正在删除，请刷新后重试")
        # Validate the whole batch before writing; no partial moves on failure.
        for task_id in task_ids:
            if folder_id == DEFAULT_ID:
                state["assignments"].pop(task_id, None)
            else:
                state["assignments"][task_id] = folder_id
        _write(state)
        return _public(state)
