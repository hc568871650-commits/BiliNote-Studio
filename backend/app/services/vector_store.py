import json
import os
import re
from typing import Optional

import chromadb
from chromadb.config import Settings

from app.utils.logger import get_logger

logger = get_logger(__name__)

NOTE_OUTPUT_DIR = os.getenv("NOTE_OUTPUT_DIR", "note_results")
VECTOR_DB_DIR = os.getenv("VECTOR_DB_DIR", "vector_db")


def _spans_plain(spans) -> str:
    if not isinstance(spans, list):
        return ""
    return "".join(str(s.get("text") or "") for s in spans if isinstance(s, dict)).strip()


def _chunk_structured_note(structured: dict) -> list[dict]:
    """按结构化章节与内容分类拆分语义块，保留真实 section_id、多段 time_ranges 与内容类别。"""
    if not isinstance(structured, dict) or not isinstance(structured.get("sections"), list):
        return []
    chunks: list[dict] = []
    for idx, sec in enumerate(structured["sections"], 1):
        if not isinstance(sec, dict):
            continue
        sec_id = str(sec.get("id") or f"sec-{idx}")
        title = str(sec.get("title") or f"章节 {idx}").strip()
        raw_ranges = [
            {"start": int(r.get("start", 0)), "end": int(r.get("end", r.get("start", 0))), "label": str(r.get("label") or "")}
            for r in (sec.get("time_ranges") or [])
            if isinstance(r, dict)
        ]
        base_meta = {
            "source_type": "markdown",
            "section_id": sec_id,
            "section_title": title,
            "time_ranges_json": json.dumps(raw_ranges, ensure_ascii=False),
            "start_time": raw_ranges[0]["start"] if raw_ranges else 0,
            "end_time": raw_ranges[-1]["end"] if raw_ranges else 0,
        }

        takeaway_lines = [_spans_plain(tk.get("spans")) for tk in (sec.get("core_takeaways") or []) if isinstance(tk, dict)]
        takeaway_lines = [line for line in takeaway_lines if line]
        if takeaway_lines:
            chunks.append({
                "text": f"## {title}（核心结论）\n" + "\n".join(takeaway_lines),
                "metadata": {**base_meta, "content_category": "core_takeaways"},
            })

        body_parts: list[str] = []
        for blk in sec.get("blocks") or []:
            if not isinstance(blk, dict):
                continue
            btype = blk.get("type")
            if btype == "paragraph":
                txt = _spans_plain(blk.get("spans"))
                if txt:
                    body_parts.append(txt)
            elif btype == "flow_chain":
                steps = [_spans_plain(step) for step in (blk.get("steps") or [])]
                steps = [s for s in steps if s]
                if steps:
                    body_parts.append(" → ".join(steps))
            elif btype == "list":
                items = [_spans_plain(item) for item in (blk.get("items") or [])]
                items = [s for s in items if s]
                if items:
                    body_parts.append("\n".join(items))
            elif btype == "checklist":
                items = [_spans_plain(item.get("spans")) for item in (blk.get("items") or []) if isinstance(item, dict)]
                items = [s for s in items if s]
                if items:
                    c_title = str(blk.get("title") or "环境准备自查").strip()
                    chunks.append({
                        "text": f"## {title}（{c_title}）\n" + "\n".join(f"- [ ] {it}" for it in items),
                        "metadata": {**base_meta, "content_category": "checklist"},
                    })
            elif btype == "table":
                cols = [str(c) for c in (blk.get("columns") or [])]
                rows = [
                    " | ".join(_spans_plain(cell) for cell in row)
                    for row in (blk.get("rows") or [])
                    if isinstance(row, list)
                ]
                if cols or rows:
                    body_parts.append("\n".join(([" | ".join(cols)] if cols else []) + rows))
            elif btype == "code_block" and blk.get("code"):
                body_parts.append(str(blk["code"]))

        if body_parts:
            chunks.append({
                "text": f"## {title}\n" + "\n\n".join(body_parts),
                "metadata": {**base_meta, "content_category": "body"},
            })

        for anno in sec.get("annotations") or []:
            if not isinstance(anno, dict):
                continue
            kind = str(anno.get("kind") or "why")
            hint = str(anno.get("short_hint") or "").strip()
            detail = str(anno.get("full_detail") or "").strip()
            if detail or hint:
                ts = anno.get("timestamp")
                anno_meta = {
                    **base_meta,
                    "content_category": f"annotation:{kind}",
                    "annotation_id": str(anno.get("id") or ""),
                    "annotation_kind": kind,
                }
                if isinstance(ts, (int, float)):
                    anno_meta["start_time"] = int(ts)
                    anno_meta["end_time"] = int(ts)
                chunks.append({
                    "text": f"## {title}（批注·{kind}）\n{hint}\n{detail}".strip(),
                    "metadata": anno_meta,
                })

        quiz = sec.get("quiz")
        if isinstance(quiz, dict) and quiz.get("full_question"):
            opts = [
                f"{o.get('key', '')}. {o.get('text', '')}"
                for o in (quiz.get("options") or [])
                if isinstance(o, dict)
            ]
            quiz_text = "\n".join([
                f"## {title}（实战自测）",
                str(quiz.get("full_question") or ""),
                *opts,
                f"参考答案：{quiz.get('correct_key', '')} — {quiz.get('explanation', '')}",
            ])
            chunks.append({
                "text": quiz_text,
                "metadata": {**base_meta, "content_category": "quiz"},
            })

    return chunks


def _chunk_markdown(markdown: str) -> list[dict]:
    """按 H2/H3 标题拆分 markdown 为语义块。"""
    sections = re.split(r'(?=^#{2,3}\s)', markdown, flags=re.MULTILINE)
    chunks = []
    for section in sections:
        section = section.strip()
        if not section or len(section) < 30:
            continue
        heading_match = re.match(r'^(#{2,3})\s+(.+)', section)
        title = heading_match.group(2).strip() if heading_match else "intro"
        chunks.append({
            "text": section,
            "metadata": {"source_type": "markdown", "section_title": title},
        })
    return chunks


def _chunk_transcript(segments: list[dict], window_size: int = 15, overlap: int = 3) -> list[dict]:
    """将转录 segments 按滑动窗口分组。"""
    if not segments:
        return []
    chunks = []
    step = max(window_size - overlap, 1)
    for i in range(0, len(segments), step):
        window = segments[i:i + window_size]
        if not window:
            break
        text = "\n".join(
            f"[{seg.get('start', 0):.0f}s] {seg.get('text', '')}" for seg in window
        )
        chunks.append({
            "text": text,
            "metadata": {
                "source_type": "transcript",
                "start_time": window[0].get("start", 0),
                "end_time": window[-1].get("end", 0),
            },
        })
    return chunks


def _build_meta_chunk(audio_meta: dict) -> list[dict]:
    """将视频元信息（标题、作者、描述、标签等）构建为可检索的 chunk。"""
    if not audio_meta:
        return []

    raw = audio_meta.get("raw_info", {}) or {}
    parts = []

    title = audio_meta.get("title") or raw.get("title", "")
    if title:
        parts.append(f"视频标题：{title}")

    uploader = raw.get("uploader", "")
    if uploader:
        parts.append(f"视频作者/UP主：{uploader}")

    desc = raw.get("description", "")
    if desc:
        parts.append(f"视频简介：{desc[:500]}")

    tags = raw.get("tags", [])
    if tags and isinstance(tags, list):
        parts.append(f"标签：{', '.join(str(t) for t in tags[:20])}")

    duration = audio_meta.get("duration", 0)
    if duration:
        m, s = divmod(int(duration), 60)
        parts.append(f"视频时长：{m}分{s}秒")

    platform = audio_meta.get("platform", "")
    if platform:
        parts.append(f"平台：{platform}")

    url = raw.get("webpage_url", "")
    if url:
        parts.append(f"链接：{url}")

    if not parts:
        return []

    return [{
        "text": "\n".join(parts),
        "metadata": {"source_type": "meta"},
    }]


class VectorStoreManager:
    """基于 ChromaDB 的笔记向量存储管理器。"""

    def __init__(self):
        os.makedirs(VECTOR_DB_DIR, exist_ok=True)
        self._client = chromadb.PersistentClient(
            path=VECTOR_DB_DIR,
            settings=Settings(anonymized_telemetry=False),
        )

    def _collection_name(self, task_id: str) -> str:
        """ChromaDB collection 名称：直接使用 task_id（UUID 格式合法）。"""
        return task_id

    def index_task(self, task_id: str) -> None:
        """读取笔记结果并建立向量索引。"""
        from app.services.note_storage import result_path as note_result_path
        result_path = note_result_path(task_id)
        if not os.path.exists(result_path):
            logger.warning(f"笔记文件不存在，跳过索引: {result_path}")
            return

        with open(result_path, "r", encoding="utf-8") as f:
            note_data = json.load(f)

        markdown = note_data.get("markdown", "")
        transcript = note_data.get("transcript", {})
        segments = transcript.get("segments", [])

        audio_meta = note_data.get("audio_meta", {})

        meta_chunks = _build_meta_chunk(audio_meta)
        structured_doc = None
        try:
            from app.services import note_storage
            task = note_storage.get_task(task_id)
            versions = task.get("markdown") if isinstance(task, dict) else None
            if isinstance(versions, list) and versions and isinstance(versions[0], dict):
                latest = versions[0]
                if isinstance(latest.get("structured"), dict):
                    structured_doc = latest["structured"]
                elif latest.get("ver_id"):
                    jpath = note_storage._note_dir(task_id) / "versions" / f"{latest['ver_id']}.json"
                    if jpath.is_file() and not jpath.is_symlink():
                        structured_doc = json.loads(jpath.read_text(encoding="utf-8"))
        except Exception:
            structured_doc = None
        md_chunks = _chunk_structured_note(structured_doc) if structured_doc else _chunk_markdown(markdown)
        if not md_chunks and markdown:
            md_chunks = _chunk_markdown(markdown)
        tr_chunks = _chunk_transcript(segments)
        all_chunks = meta_chunks + md_chunks + tr_chunks

        if not all_chunks:
            logger.warning(f"笔记内容为空，跳过索引: {task_id}")
            return

        col_name = self._collection_name(task_id)

        # 删除旧 collection（幂等）
        try:
            self._client.delete_collection(col_name)
        except Exception:
            pass

        collection = self._client.create_collection(
            name=col_name,
            metadata={"hnsw:space": "cosine"},
        )

        documents = [c["text"] for c in all_chunks]
        metadatas = [c["metadata"] for c in all_chunks]
        ids = [f"{task_id}_{i}" for i in range(len(all_chunks))]

        collection.add(documents=documents, metadatas=metadatas, ids=ids)
        logger.info(f"向量索引完成: task_id={task_id}, chunks={len(all_chunks)}")

    def _parse_results(self, results: dict) -> list[dict]:
        """将 ChromaDB query 结果转换为 chunk 列表。"""
        chunks = []
        if not results or not results.get("documents") or not results["documents"][0]:
            return chunks
        for i in range(len(results["documents"][0])):
            chunks.append({
                "text": results["documents"][0][i],
                "metadata": results["metadatas"][0][i] if results["metadatas"] else {},
                "distance": results["distances"][0][i] if results["distances"] else None,
            })
        return chunks

    def query(self, task_id: str, query_text: str, n_results: int = 6) -> list[dict]:
        """
        按固定配额从各来源检索：meta 1 条、markdown 2 条、transcript 3 条，
        确保三种来源都被召回。
        """
        col_name = self._collection_name(task_id)
        try:
            collection = self._client.get_collection(col_name)
        except Exception:
            logger.warning(f"Collection 不存在: {col_name}")
            return []

        all_chunks = []

        # 每种来源的配额
        quotas = {"meta": 1, "markdown": 2, "transcript": 3}

        for source_type, quota in quotas.items():
            try:
                results = collection.query(
                    query_texts=[query_text],
                    n_results=quota,
                    where={"source_type": source_type},
                )
                all_chunks.extend(self._parse_results(results))
            except Exception:
                pass

        return all_chunks

    def delete_index(self, task_id: str) -> None:
        """删除指定任务的向量索引。"""
        col_name = self._collection_name(task_id)
        try:
            self._client.delete_collection(col_name)
            logger.info(f"已删除向量索引: {task_id}")
        except Exception as exc:
            # A missing collection is idempotent; a storage failure must remain visible.
            try:
                self._client.get_collection(col_name)
            except Exception as lookup_exc:
                if "does not exist" in str(lookup_exc).lower() or "not found" in str(lookup_exc).lower():
                    return
                raise lookup_exc from exc
            raise

    def is_indexed(self, task_id: str) -> bool:
        """检查指定任务是否已建立完整索引（含 meta 信息）。"""
        col_name = self._collection_name(task_id)
        try:
            col = self._client.get_collection(col_name)
            if col.count() == 0:
                return False
            # 检查是否包含 meta chunk，旧索引可能缺失
            meta = col.get(where={"source_type": "meta"}, limit=1)
            return len(meta["ids"]) > 0
        except Exception:
            return False
