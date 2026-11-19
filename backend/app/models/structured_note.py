"""Structured note Schema v1 normalization, extraction, and Markdown serialization."""
from __future__ import annotations

import json
import math
import re
from typing import Any
from urllib.parse import quote, urlencode

SCHEMA_VERSION = 1
VALID_STYLES = ("knowledge", "tutorial")
VALID_EMPHASIS = ("plain", "hl", "ul", "wave", "code")
VALID_ANNOTATION_KINDS = ("why", "case", "pit")
VALID_TABLE_KINDS = ("comparison", "params", "troubleshooting")

ANNOTATION_LABELS = {
    "why": "底层原理",
    "case": "原片案例",
    "pit": "高频避坑",
}

_CONTENT_MARKER_RE = re.compile(
    r"\s*\*?Content-(?:\[(\d+:\d{2}(?::\d{2})?)\]|(\d+:\d{2}(?::\d{2})?))\*?"
)
_ORIGIN_LINK_RE = re.compile(r"\s*\[原片\s*@\s*\d+:\d{2}(?::\d{2})?\]\([^)]+\)")
_TIMECODE_RE = re.compile(r"\b(\d{1,3}:\d{2}(?::\d{2})?)\b")
_HEADING_PREFIX_RE = re.compile(r"^#{1,6}\s*")
_WRAP_HEADER_KEYWORDS = (
    "作用", "后果", "原因", "处理", "动作", "解决", "场景", "适用",
    "局限", "限制", "缺点", "特点", "说明", "描述", "细节", "注意事项", "建议",
)
_NUMERIC_UNIT_RE = re.compile(
    r"^\s*(?:约|至少|不超过|小于|大于|比.{1,6}短|比.{1,6}长|CPU核数|[<>≤≥~±]?\s*\d+(?:\.\d+)?)\s*"
    r"(?:ms|s|秒|分钟|小时|h|min|%|px|pt|mm|cm|m|GB|MB|KB|B|核|倍|次|个|条|行|×.*)?\s*$",
    re.IGNORECASE,
)


def format_timecode(seconds: int | float | None) -> str:
    if seconds is None or not isinstance(seconds, (int, float)) or not math.isfinite(seconds):
        return "00:00"
    total = max(0, int(round(seconds)))
    hours, rem = divmod(total, 3600)
    minutes, secs = divmod(rem, 60)
    if hours:
        return f"{hours:02d}:{minutes:02d}:{secs:02d}"
    return f"{minutes:02d}:{secs:02d}"


def parse_timecode_seconds(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        if math.isfinite(value) and value >= 0:
            return int(round(value))
        return None
    if not isinstance(value, str):
        return None
    match = _TIMECODE_RE.search(value.strip())
    if not match:
        return None
    parts = [int(part) for part in match.group(1).split(":")]
    if len(parts) == 2:
        minutes, secs = parts
        if secs >= 60:
            return None
        return minutes * 60 + secs
    if len(parts) == 3:
        hours, minutes, secs = parts
        if minutes >= 60 or secs >= 60:
            return None
        return hours * 3600 + minutes * 60 + secs
    return None


def _strip_inline_time_markers(text: str) -> str:
    cleaned = _ORIGIN_LINK_RE.sub("", text)
    cleaned = _CONTENT_MARKER_RE.sub("", cleaned)
    return cleaned


def _normalize_style(style: Any, fallback: str = "tutorial") -> str:
    if style in VALID_STYLES:
        return style
    legacy_knowledge = {"academic", "xiaohongshu", "life_journal", "business", "meeting_minutes"}
    if style in legacy_knowledge:
        return "knowledge"
    return fallback if fallback in VALID_STYLES else "tutorial"


def _normalize_emphasis(raw: Any) -> str:
    if not isinstance(raw, str):
        return "plain"
    low = raw.strip().lower()
    alias = {
        "plain": "plain",
        "text": "plain",
        "normal": "plain",
        "hl": "hl",
        "highlight": "hl",
        "bold": "hl",
        "strong": "hl",
        "ul": "ul",
        "underline": "ul",
        "wave": "wave",
        "wavy": "wave",
        "risk": "wave",
        "warning": "wave",
        "code": "code",
        "mono": "code",
        "inline_code": "code",
    }
    return alias.get(low, "plain")


def _normalize_spans(raw: Any, valid_anno_ids: set[str] | None = None) -> list[dict[str, Any]]:
    if isinstance(raw, str):
        items: list[Any] = [{"text": raw, "emphasis": "plain"}]
    elif isinstance(raw, dict):
        items = [raw]
    elif isinstance(raw, list):
        items = raw
    else:
        return []

    spans: list[dict[str, Any]] = []
    for item in items:
        if isinstance(item, str):
            text = _strip_inline_time_markers(item)
            if text:
                spans.append({"text": text, "emphasis": "plain", "annotation_id": None})
            continue
        if not isinstance(item, dict):
            continue
        raw_text = item.get("text")
        if raw_text is None:
            raw_text = item.get("content") or ""
        text = _strip_inline_time_markers(str(raw_text))
        if not text and not item.get("annotation_id"):
            continue
        emphasis = _normalize_emphasis(
            item.get("emphasis") or item.get("style") or ("code" if item.get("code") else "hl" if item.get("bold") else "plain")
        )
        anno_id = item.get("annotation_id") or item.get("anno_id")
        if not isinstance(anno_id, str) or not anno_id.strip():
            anno_id = None
        else:
            anno_id = anno_id.strip()
            if valid_anno_ids is not None and anno_id not in valid_anno_ids:
                anno_id = None
        spans.append({"text": text, "emphasis": emphasis, "annotation_id": anno_id})
    return spans


def _spans_plain_text(spans: list[dict[str, Any]]) -> str:
    return "".join(str(span.get("text") or "") for span in spans).strip()


def _normalize_time_ranges(raw_ranges: Any, annotations: list[dict[str, Any]] | None = None) -> list[dict[str, Any]]:
    normalized: list[dict[str, Any]] = []
    seen: set[tuple[int, int]] = set()
    items = raw_ranges if isinstance(raw_ranges, list) else ([raw_ranges] if raw_ranges else [])
    for item in items:
        start: int | None = None
        end: int | None = None
        if isinstance(item, dict):
            start = parse_timecode_seconds(item.get("start") if "start" in item else item.get("time"))
            end = parse_timecode_seconds(item.get("end"))
        elif isinstance(item, (list, tuple)) and item:
            start = parse_timecode_seconds(item[0])
            end = parse_timecode_seconds(item[1]) if len(item) > 1 else None
        else:
            start = parse_timecode_seconds(item)
        if start is None:
            continue
        if end is None or end < start:
            end = start
        key = (start, end)
        if key in seen:
            continue
        seen.add(key)
        normalized.append({"start": start, "end": end, "label": format_timecode(start)})

    if not normalized and annotations:
        for anno in annotations:
            ts = anno.get("timestamp")
            if isinstance(ts, int) and (ts, ts) not in seen:
                seen.add((ts, ts))
                normalized.append({"start": ts, "end": ts, "label": format_timecode(ts)})

    normalized.sort(key=lambda item: (item["start"], item["end"]))
    return normalized


def _normalize_annotations(raw: Any, section_index: int) -> list[dict[str, Any]]:
    if not isinstance(raw, list):
        return []
    kind_alias = {
        "why": "why",
        "reason": "why",
        "principle": "why",
        "底层原理": "why",
        "原理": "why",
        "case": "case",
        "example": "case",
        "metaphor": "case",
        "案例": "case",
        "原片案例": "case",
        "举例": "case",
        "pit": "pit",
        "pitfall": "pit",
        "warning": "pit",
        "tip": "pit",
        "避坑": "pit",
        "踩坑": "pit",
    }
    annotations: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    for idx, item in enumerate(raw, 1):
        if not isinstance(item, dict):
            continue
        full = str(item.get("full_detail") or item.get("detail") or item.get("content") or "").strip()
        hint = str(item.get("short_hint") or item.get("hint") or item.get("summary") or "").strip()
        if not full and not hint:
            continue
        if not full:
            full = hint
        if not hint:
            hint = full[:28] + ("…" if len(full) > 28 else "")
        raw_id = str(item.get("id") or f"s{section_index}-a{idx}").strip()
        anno_id = raw_id or f"s{section_index}-a{idx}"
        while anno_id in seen_ids:
            anno_id = f"{anno_id}_{idx}"
        seen_ids.add(anno_id)
        raw_kind = str(item.get("kind") or item.get("type") or "why").strip().lower()
        kind = kind_alias.get(raw_kind, "why")
        ts = parse_timecode_seconds(item.get("timestamp") if item.get("timestamp") is not None else item.get("time"))
        annotations.append({
            "id": anno_id,
            "kind": kind,
            "short_hint": hint,
            "full_detail": full,
            "timestamp": ts,
            "timestamp_label": f"原片 {format_timecode(ts)}" if ts is not None else "",
        })
    return annotations


def _infer_column_modes(columns: list[str], rows: list[list[list[dict[str, Any]]]]) -> list[str]:
    modes: list[str] = []
    for col_idx, header in enumerate(columns):
        if any(keyword in header for keyword in _WRAP_HEADER_KEYWORDS):
            modes.append("wrap")
            continue
        col_cells = [row[col_idx] for row in rows if col_idx < len(row)]
        texts = [_spans_plain_text(cell) for cell in col_cells if _spans_plain_text(cell)]
        if not texts:
            modes.append("nowrap" if col_idx == 0 and len(header) <= 16 else "wrap")
            continue
        avg_len = sum(len(t) for t in texts) / len(texts)
        max_len = max(len(t) for t in texts)
        all_code_or_unit = all(
            (all(span.get("emphasis") == "code" for span in cell if span.get("text"))
             or bool(_NUMERIC_UNIT_RE.match(_spans_plain_text(cell))))
            for cell in col_cells if _spans_plain_text(cell)
        )
        if all_code_or_unit or (col_idx == 0 and max_len <= 24) or avg_len <= 12:
            modes.append("nowrap")
        else:
            modes.append("wrap")
    return modes


def _normalize_table(raw: dict[str, Any], valid_anno_ids: set[str]) -> dict[str, Any] | None:
    raw_cols = raw.get("columns") or raw.get("headers") or []
    if not isinstance(raw_cols, list) or not raw_cols:
        return None
    # Hard guardrail: max 4 columns to keep side-by-side layout readable.
    columns = [str(col).strip() for col in raw_cols[:4] if str(col).strip()]
    if not columns:
        return None
    col_count = len(columns)

    raw_rows = raw.get("rows") or []
    if not isinstance(raw_rows, list) or not raw_rows:
        return None
    rows: list[list[list[dict[str, Any]]]] = []
    for raw_row in raw_rows:
        if not isinstance(raw_row, list):
            continue
        cells: list[list[dict[str, Any]]] = []
        for idx in range(col_count):
            cell_raw = raw_row[idx] if idx < len(raw_row) else ""
            spans = _normalize_spans(cell_raw, valid_anno_ids)
            if not spans:
                spans = [{"text": "—", "emphasis": "plain", "annotation_id": None}]
            cells.append(spans)
        rows.append(cells)
    if not rows:
        return None

    kind = raw.get("table_kind")
    if kind not in VALID_TABLE_KINDS:
        kind = "params"
    raw_modes = raw.get("column_modes")
    if isinstance(raw_modes, list) and len(raw_modes) >= col_count and all(m in ("nowrap", "wrap") for m in raw_modes[:col_count]):
        column_modes = list(raw_modes[:col_count])
    else:
        column_modes = _infer_column_modes(columns, rows)
    return {
        "type": "table",
        "table_kind": kind,
        "columns": columns,
        "column_modes": column_modes,
        "rows": rows,
    }


def _normalize_checklist(raw: dict[str, Any], valid_anno_ids: set[str]) -> dict[str, Any] | None:
    raw_items = raw.get("items") or raw.get("checks") or []
    if not isinstance(raw_items, list) or not raw_items:
        return None
    items: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    for idx, raw_item in enumerate(raw_items, 1):
        checked = False
        raw_id = ""
        if isinstance(raw_item, dict):
            spans = _normalize_spans(
                raw_item.get("spans") if raw_item.get("spans") is not None else (raw_item.get("text") or raw_item.get("label") or raw_item.get("content")),
                valid_anno_ids,
            )
            checked = bool(raw_item.get("checked"))
            raw_id = str(raw_item.get("id") or "").strip()
        else:
            spans = _normalize_spans(raw_item, valid_anno_ids)
        if not spans or not _spans_plain_text(spans):
            continue
        item_id = raw_id or f"c{idx}"
        while item_id in seen_ids:
            item_id = f"{item_id}_{idx}"
        seen_ids.add(item_id)
        items.append({"id": item_id, "spans": spans, "checked": checked})
    if not items:
        return None
    title = _strip_inline_time_markers(str(raw.get("title") or "").strip())
    return {
        "type": "checklist",
        "title": title,
        "items": items,
    }


def _normalize_block(raw: Any, valid_anno_ids: set[str]) -> dict[str, Any] | None:
    if isinstance(raw, str):
        spans = _normalize_spans(raw, valid_anno_ids)
        return {"type": "paragraph", "spans": spans} if spans else None
    if not isinstance(raw, dict):
        return None
    btype = str(raw.get("type") or "paragraph").strip().lower()
    if btype == "paragraph":
        spans = _normalize_spans(raw.get("spans") or raw.get("text") or raw.get("content"), valid_anno_ids)
        return {"type": "paragraph", "spans": spans} if spans else None
    if btype == "table":
        return _normalize_table(raw, valid_anno_ids)
    if btype in ("checklist", "task_list", "check_list", "env_checklist"):
        return _normalize_checklist(raw, valid_anno_ids)
    if btype in ("flow_chain", "chain", "flow"):
        raw_steps = raw.get("steps") or raw.get("items") or []
        steps = [s for s in (_normalize_spans(step, valid_anno_ids) for step in raw_steps) if s]
        if len(steps) >= 2:
            return {"type": "flow_chain", "steps": steps}
        if len(steps) == 1:
            return {"type": "paragraph", "spans": steps[0]}
        return None
    if btype in ("list", "ordered_list", "bullet_list"):
        raw_items = raw.get("items") or []
        items = [s for s in (_normalize_spans(item, valid_anno_ids) for item in raw_items) if s]
        if not items:
            return None
        ordered = bool(raw.get("ordered")) or btype == "ordered_list"
        return {"type": "list", "ordered": ordered, "items": items}
    if btype in ("code_block", "code"):
        code = str(raw.get("code") or raw.get("content") or "").strip("\n")
        if not code.strip():
            return None
        return {"type": "code_block", "language": str(raw.get("language") or raw.get("lang") or "").strip(), "code": code}
    if btype == "screenshot":
        ts = parse_timecode_seconds(raw.get("timestamp") if raw.get("timestamp") is not None else raw.get("time"))
        if ts is None:
            ts = parse_timecode_seconds(raw.get("marker"))
        if ts is None and not raw.get("image_url"):
            return None
        ts_val = ts if ts is not None else 0
        return {
            "type": "screenshot",
            "timestamp": ts_val,
            "label": str(raw.get("label") or format_timecode(ts_val)),
            "caption": str(raw.get("caption") or "").strip(),
            "image_url": str(raw.get("image_url") or "").strip(),
        }
    return None


def _normalize_quiz(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    full_q = str(raw.get("full_question") or raw.get("question") or "").strip()
    short_q = str(raw.get("short_prompt") or raw.get("short") or "").strip()
    explanation = str(raw.get("explanation") or raw.get("answer_explanation") or "").strip()
    raw_opts = raw.get("options") or []
    if not isinstance(raw_opts, list) or len(raw_opts) < 2 or not full_q or not explanation:
        return None
    options: list[dict[str, str]] = []
    keys = ("A", "B", "C", "D")
    for idx, opt in enumerate(raw_opts[:4]):
        if isinstance(opt, dict):
            key = str(opt.get("key") or keys[idx]).strip().upper()[:1] or keys[idx]
            text = _strip_inline_time_markers(str(opt.get("text") or opt.get("label") or "").strip())
        elif isinstance(opt, str):
            key = keys[idx]
            text = _strip_inline_time_markers(opt.strip())
        else:
            continue
        if text:
            options.append({"key": key, "text": text})
    if len(options) < 2:
        return None
    valid_keys = {opt["key"] for opt in options}
    correct_key = str(raw.get("correct_key") or raw.get("answer") or "").strip().upper()[:1]
    if correct_key not in valid_keys:
        return None
    if not short_q:
        short_q = full_q[:24] + ("…" if len(full_q) > 24 else "")
    elif len(short_q) > 30:
        short_q = short_q[:29] + "…"
    return {
        "short_prompt": short_q,
        "full_question": _strip_inline_time_markers(full_q),
        "options": options,
        "correct_key": correct_key,
        "explanation": _strip_inline_time_markers(explanation),
    }


def _reconcile_section_annotations(section: dict[str, Any]) -> None:
    annotations = section.get("annotations") or []
    if not annotations:
        return
    valid_ids = {anno["id"] for anno in annotations}
    referenced: set[str] = set()

    def scan_spans(spans: list[dict[str, Any]]) -> None:
        for span in spans:
            anno_id = span.get("annotation_id")
            if anno_id in valid_ids:
                referenced.add(anno_id)
            else:
                span["annotation_id"] = None

    for item in section.get("core_takeaways") or []:
        scan_spans(item.get("spans") or [])
    for block in section.get("blocks") or []:
        if block["type"] == "paragraph":
            scan_spans(block["spans"])
        elif block["type"] == "list":
            for item in block["items"]:
                scan_spans(item)
        elif block["type"] == "checklist":
            for item in block["items"]:
                scan_spans(item.get("spans") or [])
        elif block["type"] == "flow_chain":
            for step in block["steps"]:
                scan_spans(step)
        elif block["type"] == "table":
            for row in block["rows"]:
                for cell in row:
                    scan_spans(cell)

    unreferenced = [anno for anno in annotations if anno["id"] not in referenced]
    if not unreferenced:
        return

    # Attach dangling annotations to the last textual block rather than dropping valid evidence.
    target_spans: list[dict[str, Any]] | None = None
    for block in reversed(section.get("blocks") or []):
        if block["type"] == "paragraph" and block.get("spans"):
            target_spans = block["spans"]
            break
    if target_spans is None:
        takeaways = section.get("core_takeaways") or []
        if takeaways and takeaways[-1].get("spans"):
            target_spans = takeaways[-1]["spans"]
    if target_spans is None:
        fallback_spans: list[dict[str, Any]] = []
        section["blocks"].append({"type": "paragraph", "spans": fallback_spans})
        target_spans = fallback_spans

    for anno in unreferenced:
        if target_spans and not target_spans[-1].get("annotation_id"):
            target_spans[-1]["annotation_id"] = anno["id"]
        else:
            target_spans.append({"text": "", "emphasis": "plain", "annotation_id": anno["id"]})


def normalize_structured_note(
    raw: dict[str, Any],
    *,
    fallback_title: str = "",
    default_style: str = "tutorial",
    source_url: str = "",
    platform: str = "",
    video_id: str = "",
) -> dict[str, Any]:
    raw_sections = raw.get("sections") if isinstance(raw, dict) else None
    if not isinstance(raw_sections, list):
        raw_sections = []

    sections: list[dict[str, Any]] = []
    for idx, sec in enumerate(raw_sections, 1):
        if not isinstance(sec, dict):
            continue
        raw_title = _HEADING_PREFIX_RE.sub("", _strip_inline_time_markers(str(sec.get("title") or "").strip())).strip()
        title = raw_title or f"要点 {idx}"
        level = 3 if sec.get("level") == 3 else 2
        annotations = _normalize_annotations(sec.get("annotations"), idx)
        valid_anno_ids = {anno["id"] for anno in annotations}
        time_ranges = _normalize_time_ranges(sec.get("time_ranges") or sec.get("timestamps"), annotations)

        takeaways: list[dict[str, Any]] = []
        raw_takeaways = sec.get("core_takeaways") or []
        if isinstance(raw_takeaways, list):
            for tk in raw_takeaways[:2]:
                spans = _normalize_spans(tk.get("spans") if isinstance(tk, dict) else tk, valid_anno_ids)
                if spans:
                    takeaways.append({"spans": spans})

        blocks: list[dict[str, Any]] = []
        for raw_block in sec.get("blocks") or []:
            block = _normalize_block(raw_block, valid_anno_ids)
            if block is not None:
                blocks.append(block)

        if not takeaways and not blocks:
            continue

        sec_id = str(sec.get("id") or f"sec-{idx}").strip() or f"sec-{idx}"
        section_obj: dict[str, Any] = {
            "id": sec_id,
            "title": title,
            "level": level,
            "time_ranges": time_ranges,
            "core_takeaways": takeaways,
            "blocks": blocks,
            "annotations": annotations,
            "quiz": _normalize_quiz(sec.get("quiz")),
        }
        _reconcile_section_annotations(section_obj)
        sections.append(section_obj)

    title = str(raw.get("title") or fallback_title or "视频笔记").strip()
    return {
        "schema_version": SCHEMA_VERSION,
        "note_style": _normalize_style(raw.get("note_style") or raw.get("style"), default_style),
        "title": title,
        "source_url": str(raw.get("source_url") or source_url or "").strip(),
        "platform": str(raw.get("platform") or platform or "").strip(),
        "video_id": str(raw.get("video_id") or video_id or "").strip(),
        "sections": sections,
    }


_REASONING_BLOCK_RE = re.compile(
    r"<(?:think|thinking|thought|reasoning|analysis)\b[^>]*>[\s\S]*?</(?:think|thinking|thought|reasoning|analysis)>",
    re.IGNORECASE,
)
_DANGLING_REASONING_OPEN_RE = re.compile(
    r"^\s*<(?:think|thinking|thought|reasoning)\b[^>]*>[\s\S]*$",
    re.IGNORECASE,
)
_FENCED_BLOCK_RE = re.compile(r"```(?:json|jsonc|javascript|js)?\s*\n([\s\S]*?)\n?```", re.IGNORECASE)
_TRAILING_COMMA_RE = re.compile(r",\s*([}\]])")


def strip_reasoning_and_fences(text: str) -> str:
    """剥离思考模型残留推理标签与异常 Markdown 代码块围栏。"""
    if not isinstance(text, str):
        return ""
    cleaned = _REASONING_BLOCK_RE.sub("", text).strip()
    # 处理仅有闭合标签 </think> 前缀的思考残留
    closing = re.search(r"</(?:think|thinking|thought|reasoning)>", cleaned, re.IGNORECASE)
    if closing:
        cleaned = cleaned[closing.end():].strip()
    # 处理整段外层围栏
    fenced = re.match(r"^```(?:json|jsonc|markdown|md)?\s*\n([\s\S]*?)\n?```\s*$", cleaned, re.IGNORECASE)
    if fenced:
        return fenced.group(1).strip()
    return cleaned


def _strip_code_fence(text: str) -> str:
    return strip_reasoning_and_fences(text)


def _extract_balanced_json_slices(text: str) -> list[str]:
    slices: list[str] = []
    depth = 0
    in_string = False
    escaped = False
    start = -1
    for idx, ch in enumerate(text):
        if in_string:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                in_string = False
            continue
        if ch == '"':
            in_string = True
        elif ch == "{":
            if depth == 0:
                start = idx
            depth += 1
        elif ch == "}":
            if depth > 0:
                depth -= 1
                if depth == 0 and start >= 0:
                    slices.append(text[start:idx + 1])
                    start = -1
    return slices


def _loads_json_dict(candidate: str) -> dict[str, Any] | None:
    if not candidate:
        return None
    for attempt in (candidate, _TRAILING_COMMA_RE.sub(r"\1", candidate)):
        try:
            parsed = json.loads(attempt)
            if isinstance(parsed, dict):
                return parsed
        except ValueError:
            continue
    return None


def extract_json_object(text: str) -> dict[str, Any] | None:
    if not isinstance(text, str):
        return None
    candidate = strip_reasoning_and_fences(text)
    if not candidate:
        return None

    direct = _loads_json_dict(candidate)
    if direct is not None:
        return direct

    # 提取嵌套在说明文字后的 ```json ... ``` 围栏内容
    for match in _FENCED_BLOCK_RE.finditer(candidate):
        parsed = _loads_json_dict(match.group(1).strip())
        if parsed is not None:
            return parsed

    # 按平衡大括号优先扫描合法顶层对象（优先取包含 sections/cards 或最长的对象）
    balanced = _extract_balanced_json_slices(candidate)
    balanced.sort(key=lambda s: (('"sections"' in s or '"cards"' in s), len(s)), reverse=True)
    for fragment in balanced:
        parsed = _loads_json_dict(fragment)
        if parsed is not None:
            return parsed

    start = candidate.find("{")
    end = candidate.rfind("}")
    if start >= 0 and end > start:
        return _loads_json_dict(candidate[start:end + 1])
    return None


def extract_structured_note_json(
    text: str,
    *,
    fallback_title: str = "",
    default_style: str = "tutorial",
    source_url: str = "",
    platform: str = "",
    video_id: str = "",
) -> dict[str, Any] | None:
    obj = extract_json_object(text)
    if not isinstance(obj, dict) or not isinstance(obj.get("sections"), list):
        return None
    normalized = normalize_structured_note(
        obj,
        fallback_title=fallback_title,
        default_style=default_style,
        source_url=source_url,
        platform=platform,
        video_id=video_id,
    )
    return normalized if normalized["sections"] else None


def is_structured_note_text(text: Any) -> bool:
    return isinstance(text, str) and extract_structured_note_json(text) is not None


def _origin_time_markdown(seconds: int, label: str, video_id: str, platform: str) -> str:
    if platform == "bilibili" and video_id:
        part = re.fullmatch(r"(.+)_p([1-9]\d*)", video_id)
        base_id = part.group(1) if part else video_id
        query = {"p": part.group(2), "t": seconds} if part else {"t": seconds}
        return f"[原片 @ {label}](https://www.bilibili.com/video/{quote(base_id, safe='')}?{urlencode(query)})"
    if platform == "youtube" and video_id:
        return f"[原片 @ {label}](https://www.youtube.com/watch?{urlencode({'v': video_id, 't': f'{seconds}s'})})"
    return f"({label})"


def _serialize_spans_md(spans: list[dict[str, Any]]) -> str:
    parts: list[str] = []
    for span in spans:
        text = str(span.get("text") or "")
        if not text:
            continue
        emp = span.get("emphasis") or "plain"
        if emp == "code":
            parts.append(f"`{text.replace('`', '')}`")
        elif emp in ("hl", "ul", "wave"):
            parts.append(f"**{text}**")
        else:
            parts.append(text)
    return "".join(parts)


def _collect_span_annotations(spans: list[dict[str, Any]], anno_map: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    collected: list[dict[str, Any]] = []
    seen: set[str] = set()
    for span in spans:
        anno_id = span.get("annotation_id")
        if anno_id and anno_id in anno_map and anno_id not in seen:
            seen.add(anno_id)
            collected.append(anno_map[anno_id])
    return collected


def _annotation_blockquote(anno: dict[str, Any]) -> str:
    label = ANNOTATION_LABELS.get(anno.get("kind") or "why", "底层原理")
    ts = anno.get("timestamp_label")
    prefix = f"**[{label} · {ts}]**" if ts else f"**[{label}]**"
    return f"> {prefix} {anno.get('full_detail', '').strip()}"


def serialize_sections_to_markdown(
    sections: list[dict[str, Any]],
    *,
    platform: str = "",
    video_id: str = "",
) -> str:
    lines: list[str] = []
    for section in sections or []:
        hashes = "###" if section.get("level") == 3 else "##"
        ranges = section.get("time_ranges") or []
        anchors = [
            _origin_time_markdown(int(r.get("start") or 0), str(r.get("label") or format_timecode(r.get("start"))), video_id, platform)
            for r in ranges
        ]
        heading = f"{hashes} {section.get('title', '').strip()}"
        if anchors:
            heading += " " + " · ".join(anchors)
        lines.append(heading)
        lines.append("")

        anno_map = {a["id"]: a for a in section.get("annotations") or [] if isinstance(a, dict) and a.get("id")}
        emitted_annos: set[str] = set()

        for tk in section.get("core_takeaways") or []:
            spans = tk.get("spans") or []
            text = _serialize_spans_md(spans).strip()
            if text:
                lines.append(text)
                for anno in _collect_span_annotations(spans, anno_map):
                    if anno["id"] not in emitted_annos:
                        emitted_annos.add(anno["id"])
                        lines.append(_annotation_blockquote(anno))
                lines.append("")

        for block in section.get("blocks") or []:
            btype = block.get("type")
            if btype == "paragraph":
                spans = block.get("spans") or []
                text = _serialize_spans_md(spans).strip()
                if text:
                    lines.append(text)
                    for anno in _collect_span_annotations(spans, anno_map):
                        if anno["id"] not in emitted_annos:
                            emitted_annos.add(anno["id"])
                            lines.append(_annotation_blockquote(anno))
                    lines.append("")
            elif btype == "table":
                cols = block.get("columns") or []
                rows = block.get("rows") or []
                if cols and rows:
                    esc = lambda s: s.replace("|", "\\|").replace("\n", " ").strip()
                    lines.append("| " + " | ".join(esc(c) for c in cols) + " |")
                    lines.append("| " + " | ".join("---" for _ in cols) + " |")
                    for row in rows:
                        lines.append("| " + " | ".join(esc(_serialize_spans_md(cell)) for cell in row) + " |")
                    lines.append("")
            elif btype == "flow_chain":
                steps = [_serialize_spans_md(step).strip() for step in block.get("steps") or []]
                steps = [s for s in steps if s]
                if steps:
                    lines.append(" → ".join(steps))
                    lines.append("")
            elif btype == "list":
                ordered = bool(block.get("ordered"))
                for idx, item_spans in enumerate(block.get("items") or [], 1):
                    text = _serialize_spans_md(item_spans).strip()
                    if text:
                        prefix = f"{idx}." if ordered else "-"
                        lines.append(f"{prefix} {text}")
                lines.append("")
            elif btype == "checklist":
                title = str(block.get("title") or "").strip()
                check_lines: list[str] = []
                block_annos: list[dict[str, Any]] = []
                for item in block.get("items") or []:
                    if not isinstance(item, dict):
                        continue
                    spans = item.get("spans") or []
                    text = _serialize_spans_md(spans).strip()
                    if not text:
                        continue
                    mark = "x" if item.get("checked") else " "
                    check_lines.append(f"- [{mark}] {text}")
                    for anno in _collect_span_annotations(spans, anno_map):
                        if anno["id"] not in emitted_annos:
                            emitted_annos.add(anno["id"])
                            block_annos.append(anno)
                if check_lines:
                    if title:
                        lines.append(f"**{title}**")
                    lines.extend(check_lines)
                    for anno in block_annos:
                        lines.append(_annotation_blockquote(anno))
                    lines.append("")
            elif btype == "code_block":
                lang = str(block.get("language") or "").strip()
                code = str(block.get("code") or "")
                lines.append(f"```{lang}")
                lines.append(code)
                lines.append("```")
                lines.append("")
            elif btype == "screenshot":
                url = str(block.get("image_url") or "").strip()
                if url:
                    alt = str(block.get("caption") or f"视频截图 {block.get('label') or format_timecode(block.get('timestamp'))}").strip()
                    lines.append(f"![{alt}]({url})")
                    lines.append("")

        for anno in section.get("annotations") or []:
            if anno.get("id") and anno["id"] not in emitted_annos:
                emitted_annos.add(anno["id"])
                lines.append(_annotation_blockquote(anno))
                lines.append("")

        quiz = section.get("quiz")
        if isinstance(quiz, dict) and quiz.get("full_question"):
            lines.append(f"> **[自测]** {quiz['full_question']}")
            for opt in quiz.get("options") or []:
                lines.append(f"> - {opt['key']}. {opt['text']}")
            lines.append(f"> - **参考答案**：{quiz['correct_key']} — {quiz['explanation']}")
            lines.append("")

    return "\n".join(lines).strip() + ("\n" if lines else "")


def serialize_structured_note_to_markdown(doc: dict[str, Any], *, include_source_link: bool = True) -> str:
    prefix_lines: list[str] = []
    source_url = str(doc.get("source_url") or "").strip()
    if include_source_link and source_url:
        prefix_lines.append(f"> 来源链接：{source_url}")
        prefix_lines.append("")

    body = serialize_sections_to_markdown(
        doc.get("sections") or [],
        platform=str(doc.get("platform") or "").strip(),
        video_id=str(doc.get("video_id") or "").strip(),
    )
    if prefix_lines and body:
        return "\n".join(prefix_lines) + "\n" + body
    if prefix_lines:
        return "\n".join(prefix_lines).strip() + "\n"
    return body
