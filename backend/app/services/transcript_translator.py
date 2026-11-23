"""外语视频转写字幕轻量翻译与本地永久缓存服务。

设计约束：
- 零冷启动开销：仅在触发翻译时按需导入 LLM 工厂与供应商服务；
- 优先复用笔记生成时的模型供应商，不可用时自动回退至首个已启用供应商；
- 按批（<= 45 句/批）请求 JSON 映射翻译，结果写回笔记本地 `_meta/transcript.json` 永久缓存。
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any, Optional, Sequence

logger = logging.getLogger(__name__)

_BATCH_SIZE = 35
_AUTO_TRANSLATE_MAX_SEGMENTS = 260
_TRANSLATE_MAX_TOKENS = 6144
_CJK_RE = re.compile(r"[\u4e00-\u9fff]")
_LATIN_OR_WORD_RE = re.compile(r"[A-Za-z\u00c0-\u024f\u0400-\u04ff\u3040-\u30ff\uac00-\ud7af]")


def _seg_text(seg: Any) -> str:
    if isinstance(seg, dict):
        return str(seg.get("text") or "").strip()
    return str(getattr(seg, "text", "") or "").strip()


def _seg_translated(seg: Any) -> str:
    if isinstance(seg, dict):
        return str(seg.get("translated_text") or "").strip()
    return str(getattr(seg, "translated_text", "") or "").strip()


def has_translated_segments(segments: Sequence[Any]) -> bool:
    return any(bool(_seg_translated(seg)) for seg in (segments or ()))


def count_untranslated_segments(segments: Sequence[Any]) -> int:
    return sum(1 for seg in (segments or ()) if _seg_text(seg) and not _seg_translated(seg))


def is_fully_translated(segments: Sequence[Any]) -> bool:
    non_empty = [seg for seg in (segments or ()) if _seg_text(seg)]
    if not non_empty:
        return False
    return all(bool(_seg_translated(seg)) for seg in non_empty)


def needs_zh_translation(segments: Sequence[Any], language: Optional[str] = None) -> bool:
    """判断转写字幕是否为需要翻译成简体中文的外语内容。"""
    if not segments:
        return False
    lang = str(language or "").strip().lower()
    if lang.startswith("zh"):
        return False

    joined = " ".join(_seg_text(s) for s in segments if _seg_text(s))
    compact = re.sub(r"\s+", "", joined)
    if len(compact) < 12:
        return False

    cjk_count = len(_CJK_RE.findall(compact))
    foreign_count = len(_LATIN_OR_WORD_RE.findall(compact))
    if foreign_count < 8:
        return False
    return (cjk_count / max(1, len(compact))) < 0.22


def _parse_translation_map(raw_text: str, expected_indices: list[int]) -> dict[int, str]:
    text = str(raw_text or "").strip()
    if not text:
        return {}
    # 去掉可能的 ```json ... ``` 围栏
    fenced = re.search(r"```(?:json)?\s*([\s\S]*?)```", text, re.IGNORECASE)
    if fenced:
        text = fenced.group(1).strip()

    parsed: Any = None
    for candidate in (text,):
        try:
            parsed = json.loads(candidate)
            break
        except ValueError:
            pass
    if parsed is None:
        obj_match = re.search(r"\{[\s\S]*\}", text)
        if obj_match:
            try:
                parsed = json.loads(obj_match.group(0))
            except ValueError:
                parsed = None
    if parsed is None:
        arr_match = re.search(r"\[[\s\S]*\]", text)
        if arr_match:
            try:
                parsed = json.loads(arr_match.group(0))
            except ValueError:
                parsed = None

    mapping: dict[int, str] = {}
    if isinstance(parsed, dict):
        for k, v in parsed.items():
            if not isinstance(v, str) or not v.strip():
                continue
            try:
                idx = int(str(k).strip())
            except ValueError:
                continue
            mapping[idx] = v.strip()
    elif isinstance(parsed, list):
        for pos, item in enumerate(parsed):
            if isinstance(item, str) and item.strip() and pos < len(expected_indices):
                mapping[expected_indices[pos]] = item.strip()
            elif isinstance(item, dict):
                val = str(item.get("zh") or item.get("text") or item.get("translation") or "").strip()
                if not val:
                    continue
                raw_idx = item.get("id", item.get("index"))
                try:
                    idx = int(raw_idx) if raw_idx is not None else expected_indices[pos]
                except (ValueError, IndexError):
                    continue
                mapping[idx] = val
    return mapping


def _call_translation_batch(gpt: Any, batch: list[tuple[int, str]], target_lang: str = "zh-CN") -> dict[int, str]:
    payload_obj = {str(idx): text for idx, text in batch}
    prompt = (
        "你是一位专业视频字幕翻译助手。请将下面 JSON 对象中每条字幕自然、准确、简洁地翻译为简体中文"
        "（专有名词、产品名、技术术语与代码标识符可保留英文或中英并用）。\n"
        "严格要求：\n"
        "1. 仅输出合法 JSON 对象，键名必须与输入完全一致；\n"
        "2. 不要增删条数、不要合并拆句、不要输出任何解释或 Markdown 围栏。\n\n"
        f"输入字幕：\n{json.dumps(payload_obj, ensure_ascii=False)}"
    )
    client = getattr(gpt, "client", None)
    model = getattr(gpt, "model", None)
    if client is None or not model:
        raise RuntimeError("当前模型实例不支持字幕翻译调用")

    try:
        response = client.chat.completions.create(
            model=model,
            messages=[{"role": "user", "content": prompt}],
            temperature=0.2,
            max_tokens=_TRANSLATE_MAX_TOKENS,
        )
    except TypeError:
        response = client.chat.completions.create(
            model=model,
            messages=[{"role": "user", "content": prompt}],
            temperature=0.2,
        )
    content = ""
    choices = getattr(response, "choices", None)
    if choices:
        msg = getattr(choices[0], "message", None)
        content = getattr(msg, "content", "") or ""
    elif isinstance(response, dict):
        content = str((((response.get("choices") or [{}])[0]).get("message") or {}).get("content") or "")
    return _parse_translation_map(content, [idx for idx, _ in batch])


def _translate_batch_with_retry(
    gpt: Any,
    batch: list[tuple[int, str]],
    *,
    target_lang: str = "zh-CN",
) -> dict[int, str]:
    translated_map = _call_translation_batch(gpt, batch, target_lang=target_lang)
    # 若整批被截断或 JSON 解析落空且批次偏大，二分拆批再尝试一次提升成功率
    if not translated_map and len(batch) > 10:
        mid = len(batch) // 2
        merged: dict[int, str] = {}
        merged.update(_call_translation_batch(gpt, batch[:mid], target_lang=target_lang))
        merged.update(_call_translation_batch(gpt, batch[mid:], target_lang=target_lang))
        return merged
    return translated_map


def translate_segments_with_gpt(
    segments: Sequence[Any],
    gpt: Any,
    *,
    target_lang: str = "zh-CN",
    force: bool = False,
) -> list[dict[str, Any]]:
    """对转写分段列表批量翻译并回填 translated_text，返回规范 dict 列表。"""
    normalized: list[dict[str, Any]] = []
    pending: list[tuple[int, str]] = []

    for idx, seg in enumerate(segments):
        if isinstance(seg, dict):
            item = dict(seg)
        else:
            item = {
                "start": float(getattr(seg, "start", 0.0) or 0.0),
                "end": float(getattr(seg, "end", 0.0) or 0.0),
                "text": str(getattr(seg, "text", "") or ""),
            }
            existing_tr = getattr(seg, "translated_text", None)
            if existing_tr:
                item["translated_text"] = existing_tr
        if force:
            item.pop("translated_text", None)
        normalized.append(item)

        src_text = str(item.get("text") or "").strip()
        if not src_text:
            continue
        if not force and str(item.get("translated_text") or "").strip():
            continue
        pending.append((idx, src_text))

    if not pending:
        return normalized

    for offset in range(0, len(pending), _BATCH_SIZE):
        batch = pending[offset : offset + _BATCH_SIZE]
        translated_map = _translate_batch_with_retry(gpt, batch, target_lang=target_lang)
        for idx, zh_text in translated_map.items():
            if 0 <= idx < len(normalized) and zh_text:
                normalized[idx]["translated_text"] = zh_text
    return normalized


def _build_gpt_from_selection(provider_id: Optional[str], model_name: Optional[str]) -> Optional[tuple[Any, str, str]]:
    if not provider_id or not model_name:
        return None
    from app.gpt.gpt_factory import GPTFactory
    from app.models.model_config import ModelConfig
    from app.services.provider import ProviderService

    provider = ProviderService.get_provider_by_id(provider_id)
    if not provider or not provider.get("api_key"):
        return None
    config = ModelConfig(
        api_key=provider["api_key"],
        base_url=provider["base_url"],
        model_name=model_name,
        provider=provider["type"],
        name=provider["name"],
        protocol=provider.get("protocol") or "openai-chat",
    )
    gpt = GPTFactory().from_config(config, backend_id=str(provider["id"]))
    return gpt, str(provider["id"]), str(model_name)


def _get_configured_translation_selection() -> Optional[dict[str, str]]:
    try:
        from app.services.purpose_preferences import get_purpose_preferences

        prefs = get_purpose_preferences()
        sel = prefs.get("translation")
        if isinstance(sel, dict) and sel.get("provider_id") and sel.get("model_name"):
            return sel
    except Exception:
        pass
    return None


def maybe_auto_translate_transcript(
    transcript: Any,
    gpt: Any,
    *,
    output_language: str = "zh-CN",
) -> bool:
    """在中文笔记生成期间静默顺带翻译短中视频外语字幕，失败绝不阻断笔记主流程。

    若用户配置了专用翻译模型（purpose_preferences.translation），优先使用专用模型；
    未单独配置时默认跟随本次笔记生成主模型（gpt）。
    """
    if str(output_language or "zh-CN").strip().lower() == "source":
        return False
    segments = getattr(transcript, "segments", None)
    if not segments or len(segments) > _AUTO_TRANSLATE_MAX_SEGMENTS:
        return False
    if is_fully_translated(segments):
        return False
    if not needs_zh_translation(segments, getattr(transcript, "language", None)):
        return False

    active_gpt = gpt
    dedicated = _get_configured_translation_selection()
    if dedicated:
        try:
            built = _build_gpt_from_selection(dedicated.get("provider_id"), dedicated.get("model_name"))
            if built is not None:
                active_gpt = built[0]
        except Exception as exc:
            logger.warning("加载专用翻译模型失败，自动回退为主模型：%s", exc)

    try:
        translated_dicts = translate_segments_with_gpt(segments, active_gpt, target_lang="zh-CN")
        changed = False
        for seg_obj, seg_dict in zip(segments, translated_dicts):
            tr = str(seg_dict.get("translated_text") or "").strip()
            if tr:
                setattr(seg_obj, "translated_text", tr)
                changed = True
        return changed
    except Exception as exc:
        logger.warning("外语字幕顺带翻译失败（已忽略，不影响笔记正文生成）：%s", exc)
        return False


def _build_gpt_for_note(
    task: dict[str, Any],
    *,
    provider_id: Optional[str] = None,
    model_name: Optional[str] = None,
) -> tuple[Any, str, str]:
    from app.gpt.gpt_factory import GPTFactory
    from app.models.model_config import ModelConfig
    from app.services.model import ModelService
    from app.services.provider import ProviderService
    from app.services.purpose_preferences import get_purpose_preferences

    # 1. 显式传入的指定模型
    if provider_id and model_name:
        explicit = _build_gpt_from_selection(provider_id, model_name)
        if explicit is not None:
            return explicit

    prefs = {}
    try:
        prefs = get_purpose_preferences() or {}
    except Exception:
        prefs = {}

    # 2. 用户单独配置的专用翻译模型（例如免费/轻量模型）
    dedicated = prefs.get("translation")
    if isinstance(dedicated, dict):
        built = _build_gpt_from_selection(dedicated.get("provider_id"), dedicated.get("model_name"))
        if built is not None:
            return built

    # 3. 默认跟随主模型：优先当前笔记生成模型，其次全局默认生成主模型
    form = task.get("formData") if isinstance(task.get("formData"), dict) else {}
    for candidate in (
        (form.get("provider_id"), form.get("model_name")),
        (
            (prefs.get("generation") or {}).get("provider_id") if isinstance(prefs.get("generation"), dict) else None,
            (prefs.get("generation") or {}).get("model_name") if isinstance(prefs.get("generation"), dict) else None,
        ),
    ):
        built = _build_gpt_from_selection(candidate[0], candidate[1])
        if built is not None:
            return built

    # 4. 兜底回退首个已启用且带密钥的供应商
    candidates = ProviderService.get_all_providers() or []
    provider = next((p for p in candidates if p.get("enabled") and p.get("api_key")), None)
    if not provider:
        raise RuntimeError("未找到可用的 AI 模型供应商，请先在「设置 → 模型」中配置后重试")

    models = ModelService.get_all_models() or []
    matched = next(
        (m for m in models if m.get("provider_id") == provider["id"] and m.get("model_name")),
        None,
    )
    if not matched:
        raise RuntimeError("未找到可用模型名称，请先在「设置 → 模型」中启用模型后重试")

    config = ModelConfig(
        api_key=provider["api_key"],
        base_url=provider["base_url"],
        model_name=matched["model_name"],
        provider=provider["type"],
        name=provider["name"],
        protocol=provider.get("protocol") or "openai-chat",
    )
    gpt = GPTFactory().from_config(config, backend_id=str(provider["id"]))
    return gpt, str(provider["id"]), str(matched["model_name"])


def translate_note_captions(
    task_id: str,
    *,
    target_lang: str = "zh-CN",
    force: bool = False,
    provider_id: Optional[str] = None,
    model_name: Optional[str] = None,
) -> dict[str, Any]:
    """按需翻译单篇笔记的转写字幕并永久写入本地缓存。"""
    from app.services import note_storage

    note_storage.valid_id(task_id)
    task = note_storage.get_task(task_id)
    if not task:
        raise FileNotFoundError("笔记不存在")

    transcript = task.get("transcript") if isinstance(task.get("transcript"), dict) else {}
    segments = transcript.get("segments") if isinstance(transcript.get("segments"), list) else []
    if not segments:
        raise ValueError("该笔记暂无可翻译的字幕段落")

    total_count = sum(1 for s in segments if _seg_text(s))
    if not force and is_fully_translated(segments):
        return {
            "task_id": task_id,
            "translated": True,
            "cached": True,
            "translated_count": total_count,
            "total_count": total_count,
            "missing_count": 0,
            "language": transcript.get("language") or "",
            "segments": segments,
        }

    gpt, used_provider_id, used_model = _build_gpt_for_note(
        task,
        provider_id=provider_id,
        model_name=model_name,
    )
    updated_segments = translate_segments_with_gpt(segments, gpt, target_lang=target_lang, force=force)
    translated_count = sum(1 for s in updated_segments if str(s.get("translated_text") or "").strip())
    if translated_count == 0:
        raise RuntimeError("模型未返回有效字幕译文，请稍后重试或切换可用模型")

    missing_count = count_untranslated_segments(updated_segments)
    updated_transcript = {
        **transcript,
        "segments": updated_segments,
    }
    note_storage.update_transcript(task_id, updated_transcript)
    return {
        "task_id": task_id,
        "translated": True,
        "cached": False,
        "translated_count": translated_count,
        "total_count": total_count,
        "missing_count": missing_count,
        "provider_id": used_provider_id,
        "model_name": used_model,
        "language": updated_transcript.get("language") or "",
        "segments": updated_segments,
    }
