"""Atomic per-note learning state (quiz attempts, pinned annotations, checklist) and library review bank."""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app.services import note_storage

SCHEMA_VERSION = 1


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _default_state() -> dict[str, Any]:
    return {
        "schema_version": SCHEMA_VERSION,
        "quiz_attempts": {},
        "pinned_annotations": {},
        "pit_statuses": {},
        "checklist_states": {},
        "updated_at": None,
    }


def _state_path(task_id: str) -> Path:
    note_storage.valid_id(task_id)
    folder = note_storage._note_dir(task_id)
    if not folder.exists():
        raise FileNotFoundError("笔记不存在")
    note_storage._owned(folder)
    path = folder / "_meta" / "learning_state.json"
    note_storage._inside(path, note_storage.ROOT)
    return path


def _read_state_file(path: Path) -> dict[str, Any]:
    base = _default_state()
    if not path.is_file() or path.is_symlink():
        return base
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return base
    if not isinstance(raw, dict):
        return base
    if isinstance(raw.get("quiz_attempts"), dict):
        base["quiz_attempts"] = dict(raw["quiz_attempts"])
    if isinstance(raw.get("pinned_annotations"), dict):
        base["pinned_annotations"] = dict(raw["pinned_annotations"])
    if isinstance(raw.get("pit_statuses"), dict):
        base["pit_statuses"] = dict(raw["pit_statuses"])
    if isinstance(raw.get("checklist_states"), dict):
        base["checklist_states"] = {str(k): bool(v) for k, v in raw["checklist_states"].items()}
    base["updated_at"] = raw.get("updated_at")
    return base


def get_learning_state(task_id: str) -> dict[str, Any]:
    with note_storage.LOCK:
        path = _state_path(task_id)
        return _read_state_file(path)


def update_learning_state(task_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("学习状态载荷必须是对象")
    with note_storage.LOCK:
        path = _state_path(task_id)
        state = _read_state_file(path)
        now = _now_iso()

        # 1. Merge quiz attempts
        quiz_updates = payload.get("quiz_attempts")
        if isinstance(quiz_updates, dict):
            for raw_sec_id, entry in quiz_updates.items():
                sec_id = str(raw_sec_id or "").strip()
                if not sec_id:
                    continue
                if entry is None:
                    state["quiz_attempts"].pop(sec_id, None)
                    continue
                if not isinstance(entry, dict):
                    continue
                selected = str(entry.get("selected_key") or entry.get("picked_key") or "").strip().upper()[:2]
                correct = str(entry.get("correct_key") or "").strip().upper()[:2]
                if not selected:
                    state["quiz_attempts"].pop(sec_id, None)
                    continue
                prev = state["quiz_attempts"].get(sec_id) or {}
                prev_count = int(prev.get("attempt_count") or 0)
                is_correct = bool(entry["is_correct"]) if "is_correct" in entry else (bool(correct) and selected == correct)
                ever_wrong = bool(prev.get("ever_wrong")) or (not is_correct)
                mastered = bool(entry["mastered"]) if "mastered" in entry else (False if not is_correct else bool(prev.get("mastered", False)))
                state["quiz_attempts"][sec_id] = {
                    "section_id": sec_id,
                    "selected_key": selected,
                    "correct_key": correct,
                    "is_correct": is_correct,
                    "ever_wrong": ever_wrong,
                    "mastered": mastered,
                    "attempt_count": prev_count + 1,
                    "review_count": int(prev.get("review_count") or 0),
                    "last_reviewed_at": prev.get("last_reviewed_at"),
                    "short_prompt": str(entry.get("short_prompt") or entry.get("question") or prev.get("short_prompt") or "")[:200],
                    "updated_at": now,
                }

        # 2. Merge pinned / highlighted annotations
        anno_updates = payload.get("pinned_annotations")
        if isinstance(anno_updates, dict):
            for raw_key, entry in anno_updates.items():
                key = str(raw_key or "").strip()
                if not key:
                    continue
                if entry is None or (isinstance(entry, dict) and entry.get("pinned") is False):
                    state["pinned_annotations"].pop(key, None)
                    continue
                if isinstance(entry, bool):
                    if not entry:
                        state["pinned_annotations"].pop(key, None)
                    else:
                        sec_id, _, anno_id = key.partition(":")
                        state["pinned_annotations"][key] = {
                            "section_id": sec_id,
                            "annotation_id": anno_id or key,
                            "kind": "why",
                            "pinned": True,
                            "updated_at": now,
                        }
                elif isinstance(entry, dict):
                    sec_id = str(entry.get("section_id") or key.partition(":")[0]).strip()
                    anno_id = str(entry.get("annotation_id") or key.partition(":")[2] or key).strip()
                    state["pinned_annotations"][key] = {
                        "section_id": sec_id,
                        "annotation_id": anno_id,
                        "kind": str(entry.get("kind") or "why").strip() or "why",
                        "pinned": True,
                        "note": str(entry.get("note") or "")[:500],
                        "updated_at": now,
                    }

        # 3. Merge checklist states
        checklist_updates = payload.get("checklist_states")
        if isinstance(checklist_updates, dict):
            for item_key, checked in checklist_updates.items():
                k = str(item_key or "").strip()
                if not k:
                    continue
                if checked is None:
                    state["checklist_states"].pop(k, None)
                else:
                    state["checklist_states"][k] = bool(checked)

        state["updated_at"] = now
        path.parent.mkdir(parents=True, exist_ok=True)
        note_storage._atomic_json(path, state)
        return state


def _load_latest_structured(folder: Path, task: dict[str, Any]) -> tuple[str | None, dict[str, Any] | None]:
    versions = task.get("markdown")
    if not isinstance(versions, list) or not versions:
        return None, None
    latest = versions[0]
    if not isinstance(latest, dict):
        return None, None
    ver_id = latest.get("ver_id")
    if isinstance(latest.get("structured"), dict) and isinstance(latest["structured"].get("sections"), list):
        return ver_id, latest["structured"]
    if ver_id:
        json_path = folder / "versions" / f"{ver_id}.json"
        if json_path.is_file() and not json_path.is_symlink():
            try:
                parsed = json.loads(json_path.read_text(encoding="utf-8"))
                if isinstance(parsed, dict) and isinstance(parsed.get("sections"), list):
                    return ver_id, parsed
            except (OSError, ValueError):
                pass
    return ver_id, None


def _load_note_manifest_and_structured(task_id: str) -> tuple[Path, dict[str, Any] | None]:
    folder = note_storage._note_dir(task_id)
    manifest_path = folder / "_meta" / "manifest.json"
    if not manifest_path.is_file() or manifest_path.is_symlink():
        return folder, None
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        task = manifest.get("task") or {}
        _, structured = _load_latest_structured(folder, task)
        return folder, structured
    except (OSError, ValueError, TypeError):
        return folder, None


def record_quiz_practice(
    task_id: str,
    section_id: str,
    *,
    selected_key: str | None = None,
    mastered: bool | None = None,
) -> dict[str, Any]:
    """在复习库中原位重练错题或切换掌握状态。"""
    sec_id = str(section_id or "").strip()
    if not sec_id:
        raise ValueError("section_id 不能为空")
    with note_storage.LOCK:
        path = _state_path(task_id)
        state = _read_state_file(path)
        _, structured = _load_note_manifest_and_structured(task_id)
        quiz_meta: dict[str, Any] = {}
        if structured:
            for sec in structured.get("sections") or []:
                if isinstance(sec, dict) and str(sec.get("id") or "") == sec_id:
                    if isinstance(sec.get("quiz"), dict):
                        quiz_meta = sec["quiz"]
                    break

        prev = state["quiz_attempts"].get(sec_id) or {}
        now = _now_iso()
        correct_key = str(quiz_meta.get("correct_key") or prev.get("correct_key") or "").strip().upper()[:2]
        picked = str(selected_key).strip().upper()[:2] if selected_key is not None and str(selected_key).strip() else str(prev.get("selected_key") or "").strip().upper()[:2]
        is_correct = bool(correct_key) and picked == correct_key if selected_key is not None else bool(prev.get("is_correct", False))
        ever_wrong = bool(prev.get("ever_wrong")) or (prev.get("is_correct") is False) or (not is_correct)
        if mastered is not None:
            next_mastered = bool(mastered)
        elif selected_key is not None and not is_correct:
            next_mastered = False
        else:
            next_mastered = bool(prev.get("mastered", False))

        updated_entry = {
            "section_id": sec_id,
            "selected_key": picked,
            "correct_key": correct_key,
            "is_correct": is_correct,
            "ever_wrong": ever_wrong,
            "mastered": next_mastered,
            "attempt_count": int(prev.get("attempt_count") or 0) + (1 if selected_key is not None else 0),
            "review_count": int(prev.get("review_count") or 0) + 1,
            "last_reviewed_at": now,
            "short_prompt": str(quiz_meta.get("short_prompt") or prev.get("short_prompt") or "")[:200],
            "updated_at": now,
        }
        state["quiz_attempts"][sec_id] = updated_entry
        state["updated_at"] = now
        path.parent.mkdir(parents=True, exist_ok=True)
        note_storage._atomic_json(path, state)

        return {
            "task_id": task_id,
            "section_id": sec_id,
            "quiz_id": sec_id,
            "selected_key": picked,
            "correct_key": correct_key,
            "is_correct": is_correct,
            "mastered": next_mastered,
            "review_count": updated_entry["review_count"],
            "last_reviewed_at": now,
            "explanation": str(quiz_meta.get("explanation") or ""),
        }


def set_pit_mastered(
    task_id: str,
    section_id: str,
    annotation_id: str,
    *,
    mastered: bool,
) -> dict[str, Any]:
    """切换高频避坑条目的掌握状态。"""
    sec_id = str(section_id or "").strip()
    anno_id = str(annotation_id or "").strip()
    if not sec_id or not anno_id:
        raise ValueError("section_id 和 annotation_id 不能为空")
    key = f"{sec_id}:{anno_id}"
    with note_storage.LOCK:
        path = _state_path(task_id)
        state = _read_state_file(path)
        prev = (state.get("pit_statuses") or {}).get(key) or {}
        now = _now_iso()
        entry = {
            "section_id": sec_id,
            "annotation_id": anno_id,
            "mastered": bool(mastered),
            "review_count": int(prev.get("review_count") or 0) + 1,
            "last_reviewed_at": now,
            "updated_at": now,
        }
        state.setdefault("pit_statuses", {})[key] = entry
        state["updated_at"] = now
        path.parent.mkdir(parents=True, exist_ok=True)
        note_storage._atomic_json(path, state)
        return {
            "task_id": task_id,
            "section_id": sec_id,
            "annotation_id": anno_id,
            "annotation_key": key,
            **entry,
        }


def query_review_bank(
    *,
    kind: str = "all",
    status: str = "pending",
    limit: int = 100,
    include_archived: bool = False,
) -> dict[str, Any]:
    """Aggregate wrong quiz attempts and pinned/pit annotations across the entire library."""
    if kind not in ("all", "wrong_quiz", "pit", "pinned"):
        raise ValueError("kind 须为 all / wrong_quiz / pit / pinned")
    if status not in ("pending", "mastered", "all"):
        raise ValueError("status 须为 pending / mastered / all")
    if type(limit) is not int or not 1 <= limit <= 500:
        raise ValueError("limit 须为 1 到 500 的整数")

    wrong_quizzes: list[dict[str, Any]] = []
    pit_annotations: list[dict[str, Any]] = []
    pending_total = 0
    mastered_total = 0
    root = note_storage.ROOT
    if not root.exists():
        return {
            "wrong_quizzes": [],
            "pit_annotations": [],
            "counts": {
                "wrong_quizzes": 0,
                "pit_annotations": 0,
                "pending_total": 0,
                "mastered_total": 0,
            },
        }

    for folder in sorted(root.iterdir(), key=lambda p: p.name):
        if not folder.is_dir() or folder.is_symlink() or "__" not in folder.name:
            continue
        task_id = folder.name.rsplit("__", 1)[-1]
        if not note_storage.TASK_ID.fullmatch(task_id):
            continue
        if (root / "_tombstones" / f"{task_id}.json").exists():
            continue
        manifest_path = folder / "_meta" / "manifest.json"
        if not manifest_path.is_file() or manifest_path.is_symlink():
            continue
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            if manifest.get("deletion_pending"):
                continue
            task = manifest.get("task") or {}
            if task.get("id") != task_id:
                continue
            if not include_archived and task.get("archived_at"):
                continue
            note_title = str((task.get("audioMeta") or {}).get("title") or task_id)[:300]
            version_id, structured = _load_latest_structured(folder, task)
            state = _read_state_file(folder / "_meta" / "learning_state.json")
        except (OSError, ValueError, TypeError):
            continue

        sections_by_id: dict[str, dict[str, Any]] = {}
        if structured:
            for sec in structured.get("sections") or []:
                if isinstance(sec, dict) and sec.get("id"):
                    sections_by_id[str(sec["id"])] = sec

        # Collect wrong quizzes
        if kind in ("all", "wrong_quiz"):
            for sec_id, attempt in (state.get("quiz_attempts") or {}).items():
                if not isinstance(attempt, dict):
                    continue
                ever_wrong = bool(attempt.get("ever_wrong")) or attempt.get("is_correct") is False
                if not ever_wrong:
                    continue
                is_mastered = bool(attempt.get("mastered", False))
                if is_mastered:
                    mastered_total += 1
                else:
                    pending_total += 1
                if status == "pending" and is_mastered:
                    continue
                if status == "mastered" and not is_mastered:
                    continue
                sec = sections_by_id.get(sec_id) or {}
                quiz = sec.get("quiz") if isinstance(sec.get("quiz"), dict) else {}
                wrong_quizzes.append({
                    "task_id": task_id,
                    "version_id": version_id,
                    "note_title": note_title,
                    "section_id": sec_id,
                    "quiz_id": sec_id,
                    "section_title": str(sec.get("title") or sec_id),
                    "time_ranges": sec.get("time_ranges") or [],
                    "short_prompt": str(quiz.get("short_prompt") or attempt.get("short_prompt") or ""),
                    "full_question": str(quiz.get("full_question") or ""),
                    "options": quiz.get("options") or [],
                    "selected_key": attempt.get("selected_key"),
                    "correct_key": quiz.get("correct_key") or attempt.get("correct_key"),
                    "explanation": str(quiz.get("explanation") or ""),
                    "attempt_count": int(attempt.get("attempt_count") or 1),
                    "mastered": is_mastered,
                    "review_count": int(attempt.get("review_count") or 0),
                    "last_reviewed_at": attempt.get("last_reviewed_at"),
                    "updated_at": attempt.get("updated_at") or state.get("updated_at") or "",
                })

        # Collect pit annotations & pinned annotations
        if kind in ("all", "pit", "pinned"):
            pinned_map = state.get("pinned_annotations") or {}
            pit_status_map = state.get("pit_statuses") or {}
            if structured:
                for sec in structured.get("sections") or []:
                    if not isinstance(sec, dict):
                        continue
                    sec_id = str(sec.get("id") or "")
                    sec_title = str(sec.get("title") or sec_id)
                    for anno in sec.get("annotations") or []:
                        if not isinstance(anno, dict) or not anno.get("id"):
                            continue
                        anno_id = str(anno["id"])
                        key = f"{sec_id}:{anno_id}"
                        pinned_entry = pinned_map.get(key)
                        pit_status = pit_status_map.get(key) or {}
                        is_pinned = bool(pinned_entry)
                        is_pit = str(anno.get("kind") or "") == "pit"
                        if kind == "pinned" and not is_pinned:
                            continue
                        if kind == "pit" and not is_pit:
                            continue
                        if kind == "all" and not (is_pinned or is_pit):
                            continue
                        is_mastered = bool(pit_status.get("mastered", False))
                        if is_mastered:
                            mastered_total += 1
                        else:
                            pending_total += 1
                        if status == "pending" and is_mastered:
                            continue
                        if status == "mastered" and not is_mastered:
                            continue
                        pit_annotations.append({
                            "task_id": task_id,
                            "version_id": version_id,
                            "note_title": note_title,
                            "section_id": sec_id,
                            "section_title": sec_title,
                            "annotation_id": anno_id,
                            "annotation_key": key,
                            "kind": str(anno.get("kind") or "why"),
                            "short_hint": str(anno.get("short_hint") or ""),
                            "full_detail": str(anno.get("full_detail") or ""),
                            "timestamp": anno.get("timestamp"),
                            "timestamp_label": str(anno.get("timestamp_label") or ""),
                            "pinned": is_pinned,
                            "mastered": is_mastered,
                            "review_count": int(pit_status.get("review_count") or 0),
                            "last_reviewed_at": pit_status.get("last_reviewed_at"),
                            "note": str((pinned_entry or {}).get("note") or ""),
                            "updated_at": pit_status.get("updated_at") or (pinned_entry or {}).get("updated_at") or task.get("createdAt") or "",
                        })

    wrong_quizzes.sort(key=lambda item: str(item.get("updated_at") or ""), reverse=True)
    pit_annotations.sort(key=lambda item: (bool(item.get("pinned")), str(item.get("updated_at") or "")), reverse=True)
    return {
        "wrong_quizzes": wrong_quizzes[:limit],
        "pit_annotations": pit_annotations[:limit],
        "counts": {
            "wrong_quizzes": len(wrong_quizzes),
            "pit_annotations": len(pit_annotations),
            "pending_total": pending_total,
            "mastered_total": mastered_total,
        },
    }
