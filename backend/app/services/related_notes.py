"""基于标签、章节词项与可选向量索引的库内相关笔记轻量推荐。"""
from __future__ import annotations

import json
import math
import os
import re
from collections import Counter
from pathlib import Path
from typing import Any

from app.services import note_library, note_storage

MIN_RELATED_SCORE = 0.16
_TOKEN_RE = re.compile(r"[a-z0-9][a-z0-9_+#.-]{1,31}|[\u4e00-\u9fff]+", re.IGNORECASE)
_STOPWORDS = frozenset({
    "的", "了", "和", "与", "在", "是", "为", "对", "中", "上", "下", "及", "或", "等", "这", "那",
    "一个", "如何", "什么", "为什么", "笔记", "教程", "总结", "介绍", "使用", "原理", "实战", "详解",
    "the", "and", "for", "with", "from", "that", "this", "into", "your", "how", "what", "why", "guide", "note",
})


def _tokenize(text: str) -> Counter[str]:
    counts: Counter[str] = Counter()
    for match in _TOKEN_RE.finditer((text or "").lower()):
        tok = match.group(0)
        if not tok or tok in _STOPWORDS:
            continue
        if "\u4e00" <= tok[0] <= "\u9fff":
            if len(tok) == 1:
                continue
            if len(tok) <= 4:
                counts[tok] += 1
            for idx in range(len(tok) - 1):
                gram = tok[idx:idx + 2]
                if gram not in _STOPWORDS:
                    counts[gram] += 1
        elif len(tok) >= 2:
            counts[tok] += 1
    return counts


def _cosine(a: Counter[str], b: Counter[str]) -> float:
    if not a or not b:
        return 0.0
    common = set(a.keys()) & set(b.keys())
    if not common:
        return 0.0
    dot = sum(a[k] * b[k] for k in common)
    norm_a = math.sqrt(sum(v * v for v in a.values()))
    norm_b = math.sqrt(sum(v * v for v in b.values()))
    if norm_a <= 0 or norm_b <= 0:
        return 0.0
    return dot / (norm_a * norm_b)


def _extract_note_profile(folder: Path, task: dict[str, Any], tags: list[str]) -> dict[str, Any]:
    audio_meta = task.get("audioMeta") if isinstance(task.get("audioMeta"), dict) else {}
    raw_info = audio_meta.get("raw_info") if isinstance(audio_meta.get("raw_info"), dict) else {}
    title = str(audio_meta.get("title") or task.get("id") or "").strip()[:300]
    platform = str(audio_meta.get("platform") or (task.get("formData") or {}).get("platform") or "").strip()

    section_titles: list[str] = []
    takeaway_texts: list[str] = []
    versions = task.get("markdown")
    latest = versions[0] if isinstance(versions, list) and versions and isinstance(versions[0], dict) else None
    structured = latest.get("structured") if isinstance(latest, dict) and isinstance(latest.get("structured"), dict) else None
    if structured is None and isinstance(latest, dict) and latest.get("ver_id"):
        jpath = folder / "versions" / f"{latest['ver_id']}.json"
        if jpath.is_file() and not jpath.is_symlink():
            try:
                parsed = json.loads(jpath.read_text(encoding="utf-8"))
                if isinstance(parsed, dict) and isinstance(parsed.get("sections"), list):
                    structured = parsed
            except (OSError, ValueError):
                structured = None

    if structured and isinstance(structured.get("sections"), list):
        for sec in structured["sections"][:18]:
            if not isinstance(sec, dict):
                continue
            st = str(sec.get("title") or "").strip()
            if st:
                section_titles.append(st)
            for tk in (sec.get("core_takeaways") or [])[:3]:
                if isinstance(tk, dict) and isinstance(tk.get("spans"), list):
                    txt = "".join(str(s.get("text") or "") for s in tk["spans"] if isinstance(s, dict)).strip()
                    if txt:
                        takeaway_texts.append(txt[:160])
    elif isinstance(latest, dict) and isinstance(latest.get("content"), str):
        for line in latest["content"].splitlines():
            if line.startswith("## ") or line.startswith("### "):
                section_titles.append(line.lstrip("# ").strip()[:120])
            if len(section_titles) >= 16:
                break

    raw_tags = raw_info.get("tags") if isinstance(raw_info.get("tags"), list) else []
    merged_tags = [str(t).strip() for t in [*tags, *raw_tags[:8]] if str(t).strip()]
    normalized_tags = list(dict.fromkeys(merged_tags))

    # 标题加权 2 次，章节标题与核心结论共同构成离线语义指纹
    weighted_text = " ".join([
        title,
        title,
        " ".join(normalized_tags),
        " ".join(section_titles),
        " ".join(takeaway_texts[:10]),
    ])
    return {
        "task_id": str(task.get("id") or ""),
        "title": title,
        "platform": platform,
        "tags": normalized_tags,
        "tag_set": {t.casefold() for t in normalized_tags},
        "tokens": _tokenize(weighted_text),
        "query_text": f"{title} {' '.join(section_titles[:6])}".strip()[:500],
        "created_at": str(task.get("createdAt") or ""),
    }


def _optional_vector_scores(query_text: str, candidate_ids: list[str]) -> dict[str, float]:
    """仅在已存在 ChromaDB 向量目录时尝试轻量语义加权；不可用或失败时静默降级。"""
    if not query_text or not candidate_ids:
        return {}
    vector_dir = os.getenv("VECTOR_DB_DIR", "vector_db")
    if not os.path.isdir(vector_dir):
        return {}
    try:
        from app.services.vector_store import get_vector_store

        store = get_vector_store()
        client = getattr(store, "_client", None)
        if client is None:
            return {}
        existing = set()
        for col in client.list_collections():
            name = getattr(col, "name", None) or (col if isinstance(col, str) else "")
            if name:
                existing.add(name)
        scores: dict[str, float] = {}
        for cid in candidate_ids[:24]:
            if cid not in existing:
                continue
            try:
                hits = store.query(cid, query_text, top_k=1)
                if hits:
                    dist = hits[0].get("distance")
                    if isinstance(dist, (int, float)):
                        sim = max(0.0, min(1.0, 1.0 - float(dist)))
                        if sim > 0.25:
                            scores[cid] = sim
            except Exception:
                continue
        return scores
    except Exception:
        return {}


def find_related_notes(task_id: str, *, limit: int = 3) -> list[dict[str, Any]]:
    """返回与当前笔记真正相关的 0~limit 篇库内笔记；低相似度静默过滤。"""
    note_storage.valid_id(task_id)
    if type(limit) is not int or not 1 <= limit <= 10:
        raise ValueError("limit 须为 1 到 10 的整数")

    root = note_storage.ROOT
    if not root.exists():
        return []

    try:
        library_entries = note_library.list_entries().get("entries") or {}
    except Exception:
        library_entries = {}

    target_profile: dict[str, Any] | None = None
    candidates: list[dict[str, Any]] = []

    for folder in sorted(root.iterdir(), key=lambda p: p.name):
        if not folder.is_dir() or folder.is_symlink() or "__" not in folder.name:
            continue
        cid = folder.name.rsplit("__", 1)[-1]
        if not note_storage.TASK_ID.fullmatch(cid):
            continue
        if (root / "_tombstones" / f"{cid}.json").exists():
            continue
        manifest_path = folder / "_meta" / "manifest.json"
        if not manifest_path.is_file() or manifest_path.is_symlink():
            continue
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            if manifest.get("deletion_pending"):
                continue
            task = manifest.get("task") or {}
            if task.get("id") != cid:
                continue
            if cid != task_id and task.get("archived_at"):
                continue
            tags = list((library_entries.get(cid) or {}).get("tags") or [])
            profile = _extract_note_profile(folder, task, tags)
        except (OSError, ValueError, TypeError):
            continue

        if cid == task_id:
            target_profile = profile
        else:
            candidates.append(profile)

    if target_profile is None:
        raise FileNotFoundError("笔记不存在")
    if not candidates:
        return []

    lexical_ranked: list[tuple[float, dict[str, Any], list[str]]] = []
    for cand in candidates:
        lex_sim = _cosine(target_profile["tokens"], cand["tokens"])
        shared_lower = target_profile["tag_set"] & cand["tag_set"]
        shared_tags = [t for t in cand["tags"] if t.casefold() in shared_lower][:4]
        tag_union = len(target_profile["tag_set"] | cand["tag_set"])
        tag_sim = (len(shared_lower) / tag_union) if tag_union else 0.0
        base_score = lex_sim * 0.72 + tag_sim * 0.48
        lexical_ranked.append((base_score, cand, shared_tags))

    # 仅对词项/标签初筛靠前的候选尝试可选向量加权，避免全库扫描开销
    lexical_ranked.sort(key=lambda row: row[0], reverse=True)
    top_ids = [row[1]["task_id"] for row in lexical_ranked[:12]]
    vec_scores = _optional_vector_scores(target_profile["query_text"], top_ids)

    scored: list[dict[str, Any]] = []
    for base_score, cand, shared_tags in lexical_ranked:
        v_sim = vec_scores.get(cand["task_id"], 0.0)
        final_score = max(base_score, base_score * 0.65 + v_sim * 0.45) if v_sim > 0 else base_score
        if final_score < MIN_RELATED_SCORE:
            continue
        if shared_tags:
            reason = f"共同标签：{' · '.join(shared_tags[:2])}"
        elif v_sim >= 0.45:
            reason = "主题语义高度相关"
        else:
            reason = "知识点与章节内容相关"
        scored.append({
            "task_id": cand["task_id"],
            "title": cand["title"],
            "platform": cand["platform"],
            "score": round(min(1.0, final_score), 3),
            "shared_tags": shared_tags,
            "reason": reason,
        })

    scored.sort(key=lambda item: item["score"], reverse=True)
    return scored[:limit]
