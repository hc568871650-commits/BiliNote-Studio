from app.gpt.base import GPT
from app.gpt.prompt_builder import generate_base_prompt
from app.models.gpt_model import GPTSource
import os
import hashlib
import json
import time
import re
from datetime import datetime, timezone
from pathlib import Path

from app.gpt.prompt import MERGE_PROMPT
from app.gpt import prompt as prompt_contract
from app.gpt.utils import fix_markdown
from app.gpt.request_chunker import RequestChunker
from app.models.transcriber_model import TranscriptSegment
from datetime import timedelta
from typing import List


class IncompleteOutputError(ValueError):
    """A length-limited response is never a usable partial note."""


class UniversalGPT(GPT):
    def __init__(self, client, model: str, temperature: float = 0.7, backend_identity: str = ""):
        self.client = client
        self.model = model
        self.temperature = temperature
        self.backend_identity = backend_identity
        self.screenshot = False
        self.link = False
        self.max_request_bytes = int(os.getenv("OPENAI_MAX_REQUEST_BYTES", str(45 * 1024 * 1024)))
        # Local workload policies, not claims about any supplier's hard limits.
        self.max_chunk_seconds = max(1, int(os.getenv("OPENAI_NOTE_CHUNK_SECONDS", "600")))
        self.max_chunk_text_chars = max(1, int(os.getenv("OPENAI_NOTE_CHUNK_TEXT_CHARS", "8000")))
        self.max_merge_text_chars = max(1, int(os.getenv("OPENAI_NOTE_MERGE_TEXT_CHARS", "24000")))
        self.max_length_split_depth = min(3, max(0, int(os.getenv("OPENAI_NOTE_LENGTH_SPLIT_DEPTH", "2"))))
        self.checkpoint_dir = Path(os.getenv("NOTE_OUTPUT_DIR", "note_results"))
        self.checkpoint_dir.mkdir(parents=True, exist_ok=True)
        # 初始化时缓存重试配置，避免每次请求重复读取环境变量
        self._max_retry_attempts = max(1, int(os.getenv("OPENAI_RETRY_ATTEMPTS", "3")))
        self._retry_base_backoff = float(os.getenv("OPENAI_RETRY_BACKOFF_SECONDS", "1.5"))
        self._http_attempt_count = 0
        self._logical_request_count = 0
        self._max_http_attempts = 64
        self._generation_recorder = None
        self._generation_options = None

    def configure_generation(self, options=None, recorder=None):
        # Imported lazily to preserve offline legacy clients that only build prompts.
        from app.models.generation_options import GenerationOptions
        options = options if isinstance(options, GenerationOptions) else GenerationOptions.model_validate(options or {})
        self._generation_options = options
        self._generation_recorder = recorder
        self.temperature = options.temperature
        self.max_chunk_seconds = options.chunk_seconds
        self.max_chunk_text_chars = options.chunk_text_chars
        self._max_retry_attempts = options.retry_attempts
        self._max_http_attempts = options.max_requests
        self._http_attempt_count = self._logical_request_count = 0
        # One explicit retry layer owns billing/attempt accounting.
        if callable(getattr(self.client, 'with_options', None)):
            self.client = self.client.with_options(max_retries=0, timeout=120.0)
        elif hasattr(self.client, 'max_retries'):
            self.client.max_retries = 0
            if hasattr(self.client, 'timeout'):
                self.client.timeout = 120.0
        if recorder:
            recorder.set_effective(dict(temperature=options.temperature,
                reasoning_effort=None if options.reasoning_effort == 'auto' else options.reasoning_effort,
                max_output_tokens=options.max_output_tokens, output_token_parameter=self._output_token_parameter(), chunk_seconds=options.chunk_seconds,
                chunk_text_chars=options.chunk_text_chars, max_requests=options.max_requests,
                retry_attempts=options.retry_attempts, sdk_max_retries=0, sdk_timeout_seconds=120.0))
        return self

    def _audit_event(self, event, **context):
        recorder = getattr(self, '_generation_recorder', None)
        if recorder:
            recorder.event(event, **context)

    def _output_token_parameter(self):
        return 'max_completion_tokens' if re.match(r'(?:gpt-[56]|o[134])(?:[.-]|$)',
            self.model.lower().split('/')[-1]) else 'max_tokens'

    def _format_time(self, seconds: float) -> str:
        total_seconds = max(0, int(seconds))
        hours, remainder = divmod(total_seconds, 3600)
        minutes, seconds = divmod(remainder, 60)
        if hours:
            return f"{hours:02d}:{minutes:02d}:{seconds:02d}"
        return f"{minutes:02d}:{seconds:02d}"

    def _build_segment_text(self, segments: List[TranscriptSegment]) -> str:
        return "\n".join(
            f"{self._format_time(seg.start)} - {seg.text.strip()}"
            for seg in segments
        )

    def ensure_segments_type(self, segments) -> List[TranscriptSegment]:
        return [TranscriptSegment(**seg) if isinstance(seg, dict) else seg for seg in segments]

    def create_messages(self, segments: List[TranscriptSegment], **kwargs):

        content_text = generate_base_prompt(
            title=kwargs.get('title'),
            segment_text=self._build_segment_text(segments),
            tags=kwargs.get('tags'),
            _format=kwargs.get('_format'),
            style=kwargs.get('style'),
            extras=kwargs.get('extras'),
        )

        video_img_urls = kwargs.get('video_img_urls', [])
        # Local paths, hashes and detector internals are not model evidence.
        evidence = [{key: frame[key] for key in ('time', 'reason', 'reasons') if key in frame}
                    for frame in (kwargs.get('frame_evidence') or []) if isinstance(frame, dict)]
        image_ranges = kwargs.get('video_image_ranges')
        if image_ranges is not None:
            spans = image_ranges if video_img_urls else [
                {'start': float(segment.start), 'end': float(segment.end)} for segment in segments]
            evidence = [frame for frame in evidence if isinstance(frame.get('time'), (int, float)) and
                any(span['start'] <= frame['time'] <= span['end'] for span in spans)]
            if video_img_urls:
                content_text += '\n以下范围的 start/end 单位为秒，仅用于匹配字幕；图片是离散取样，不代表观看了区间内的连续视频，不能据此声称看到其他时段：\n' + json.dumps(image_ranges, ensure_ascii=False)
        if evidence:
            evidence = [dict(frame, timecode=self._format_time(frame['time'])) if isinstance(frame.get('time'), (int, float)) else frame for frame in evidence]
            content_text += '\n截图候选定位资料（time 单位为秒，小数部分是秒的小数；引用使用 timecode，不把小数点改成冒号。时间和理由本身不是视觉证据）：\n' + json.dumps(evidence, ensure_ascii=False)
        content_text += ('\n本次已提供图片，仅描述确实能辨认的画面。' if video_img_urls
                         else '\n本次未提供图片，不得描述所见画面或声称已核验界面。')

        content: list[dict] | str
        if video_img_urls:
            # 有截图时走 OpenAI 多模态 content 数组（text + image_url）
            content = [{"type": "text", "text": content_text}]
            for url in video_img_urls:
                content.append({
                    "type": "image_url",
                    "image_url": {
                        "url": url,
                        "detail": "auto"
                    }
                })
        else:
            # 纯文本场景退回 string content：DeepSeek deepseek-chat 等非多模态模型
            # 不识别 [{"type":"text",...}] 数组形态，会返回 invalid_request_error
            # （issue #282）。OpenAI 规范本身也允许 content 为 string。
            content = content_text

        messages = [{
            "role": "user",
            "content": content
        }]

        return messages

    def list_models(self):
        return self.client.models.list()

    def _estimate_messages_bytes(self, messages: list) -> int:
        import json
        return len(json.dumps(messages, ensure_ascii=False).encode("utf-8"))

    def _build_merge_messages(self, partials: list) -> list:
        merge_text = MERGE_PROMPT + "\n\n" + "\n\n---\n\n".join(partials)
        # 合并阶段没有图片，直接用 string content 兼容非多模态模型（issue #282）
        return [{
            "role": "user",
            "content": merge_text
        }]

    def _checkpoint_path(self, checkpoint_key: str) -> Path:
        safe_key = "".join(ch if ch.isalnum() or ch in ("-", "_") else "_" for ch in checkpoint_key)
        return self.checkpoint_dir / f"{safe_key}.gpt.checkpoint.json"

    def _build_source_signature(self, source: GPTSource) -> str:
        payload = {
            "prompt_version": getattr(prompt_contract, 'PROMPT_VERSION', 'distillation-2'),
            "response_contract": "complete-body-1",
            "frame_time_contract": "seconds-with-timecode-1",
            "frame_evidence": getattr(source, 'frame_evidence', None) or [],
            "video_image_ranges": getattr(source, 'video_image_ranges', None),
            "model": self.model,
            # Billing and retry ceilings govern continuation, not source identity.
            # Raising them must resume completed chunks rather than bill them again.
            "generation_options": (self._generation_options.model_dump(mode='json', exclude={'price', 'max_requests', 'retry_attempts'})
                if getattr(self, '_generation_options', None) else None),
            "backend_identity": getattr(self, 'backend_identity', ''),
            "temperature": self.temperature,
            "max_request_bytes": self.max_request_bytes,
            "chunk_contract": "time-text-bounded-2",
            "length_split_call_budget": 15,
            "max_chunk_seconds": getattr(self, 'max_chunk_seconds', 600),
            "max_chunk_text_chars": getattr(self, 'max_chunk_text_chars', 8000),
            "max_merge_text_chars": getattr(self, 'max_merge_text_chars', 24000),
            "max_length_split_depth": getattr(self, 'max_length_split_depth', 2),
            "title": source.title,
            "tags": source.tags,
            "format": source._format,
            "style": source.style,
            "extras": source.extras,
            "video_img_urls": source.video_img_urls or [],
            "segments": [
                {
                    "start": getattr(seg, "start", None),
                    "end": getattr(seg, "end", None),
                    "text": getattr(seg, "text", "")
                }
                for seg in source.segment
            ],
        }
        raw = json.dumps(payload, ensure_ascii=False, sort_keys=True)
        return hashlib.sha256(raw.encode("utf-8")).hexdigest()

    def _load_checkpoint(self, checkpoint_key: str, source_signature: str) -> dict | None:
        path = self._checkpoint_path(checkpoint_key)
        if not path.exists():
            return None
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            if data.get("source_signature") != source_signature:
                path.unlink(missing_ok=True)
                return None
            return data
        except Exception:
            path.unlink(missing_ok=True)
            return None

    def _save_checkpoint(self, checkpoint_key: str, source_signature: str, partials: list, phase: str,
                         chunk_progress: dict | None = None) -> None:
        path = self._checkpoint_path(checkpoint_key)
        data = {
            "version": 1,
            "source_signature": source_signature,
            "phase": phase,
            "partials": partials,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }
        if chunk_progress is not None:
            data['chunk_progress'] = chunk_progress
        tmp_path = path.with_suffix(".tmp")
        tmp_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp_path.replace(path)

    def _clear_checkpoint(self, checkpoint_key: str) -> None:
        self._checkpoint_path(checkpoint_key).unlink(missing_ok=True)

    @staticmethod
    def _is_insufficient_quota_error(exc: Exception) -> bool:
        raw = str(exc)
        return (
            "insufficient_user_quota" in raw
            or "预扣费额度失败" in raw
            or "insufficient quota" in raw.lower()
        )

    @staticmethod
    def _is_request_too_large_error(exc: Exception) -> bool:
        status = getattr(exc, 'status_code', None) or getattr(exc, 'status', None)
        if str(status) == '413':
            return True
        raw = str(exc).lower()
        return bool(re.search(r'(?:error code|status(?:_code)?|http)[\s\"\x27:=_-]*413\b', raw)
                    or '413 request entity' in raw or 'payload too large' in raw
                    or 'request entity too large' in raw)

    @staticmethod
    def _is_retryable_error(exc: Exception) -> bool:
        # A gateway may label both 413 and 5xx as bad_response_status_code.
        # Request size rejection always takes precedence over that generic label.
        if UniversalGPT._is_request_too_large_error(exc):
            return False
        raw = str(exc).lower()
        retryable_tokens = (
            "error code: 524",
            "timed out",
            "timeout",
            "rate limit",
            "error code: 429",
            "error code: 500",
            "error code: 502",
            "error code: 503",
            "error code: 504",
            "apiconnectionerror",
            "connection error",
            "service unavailable",
        )
        if any(token in raw for token in retryable_tokens):
            return True

        status = getattr(exc, "status_code", None) or getattr(exc, "status", None)
        return status in {408, 409, 429, 500, 502, 503, 504, 524}

    @staticmethod
    def _is_temperature_unsupported_error(exc: Exception) -> bool:
        """OpenAI o1/o3/gpt-5 系列等新模型不接受自定义 temperature，
        只允许默认值 1，传 0.7 会报 `'temperature' does not support 0.7 ...`。"""
        raw = str(exc).lower()
        return "temperature" in raw and (
            "does not support" in raw
            or "unsupported_value" in raw
            or "only the default" in raw
        )

    def _create_once(self, messages, *, reason='initial', omit_temperature=False):
        cancel_check = getattr(self, 'generation_cancel_check', None)
        if callable(cancel_check):
            cancel_check()
        if getattr(self, '_http_attempt_count', 0) >= getattr(self, '_max_http_attempts', 64):
            self._audit_event('request_budget_exhausted', **getattr(self, '_generation_context', {}))
            raise ValueError('已达到本次生成的总 HTTP 请求上限；已完成分片保留，未继续调用模型。')
        options = getattr(self, '_generation_options', None)
        parameters = dict(model=self.model, messages=messages)
        if not omit_temperature and self.temperature is not None:
            parameters['temperature'] = self.temperature
        if options and options.reasoning_effort != 'auto':
            parameters['reasoning_effort'] = options.reasoning_effort
        if options and options.max_output_tokens is not None:
            parameters[self._output_token_parameter()] = options.max_output_tokens
        recorder = getattr(self, '_generation_recorder', None)
        settings = {key: parameters.get(key) for key in ('temperature', 'reasoning_effort', 'max_completion_tokens', 'max_tokens')}
        audit_id = None
        if recorder:
            content = [message.get('content') for message in messages]
            audit_id = recorder.start_attempt(**getattr(self, '_generation_context', {}),
                retry_index=getattr(self, '_retry_index', 0), reason=reason, settings=settings,
                logical_request_id=str(getattr(self, '_logical_request_count', 0)),
                request_bytes=self._estimate_messages_bytes(messages),
                text_chars=sum(len(value) if isinstance(value, str) else sum(len(part.get('text', ''))
                    for part in (value or []) if isinstance(part, dict) and part.get('type') == 'text') for value in content),
                image_count=sum(1 for value in content if isinstance(value, list) for part in value
                    if isinstance(part, dict) and part.get('type') == 'image_url'))
        self._http_attempt_count = getattr(self, '_http_attempt_count', 0) + 1
        try:
            response = self.client.chat.completions.create(**parameters)
        except Exception as exc:
            if recorder:
                recorder.complete_attempt(audit_id, error=exc)
            raise
        if recorder:
            recorder.complete_attempt(audit_id, response=response)
        return response

    def _do_create(self, messages: list):
        """Temperature compatibility fallback also spends the total HTTP budget."""
        try:
            return self._create_once(messages, reason='retry' if getattr(self, '_retry_index', 0) else 'initial')
        except Exception as exc:
            if self.temperature is not None and not self._is_request_too_large_error(exc) and self._is_temperature_unsupported_error(exc):
                self._audit_event('temperature_omitted', **getattr(self, '_generation_context', {}))
                return self._create_once(messages, reason='temperature_fallback', omit_temperature=True)
            raise

    def _chat_completion_create(self, messages: list):
        self._logical_request_count = getattr(self, '_logical_request_count', 0) + 1
        last_exc = None
        for attempt in range(self._max_retry_attempts):
            self._retry_index = attempt
            try:
                response = self._do_create(messages)
                # Only numeric billing metadata; never log prompts, URLs or credentials.
                print('[universal_gpt] usage=' + json.dumps(self._usage_metrics(response)))
                return response
            except Exception as exc:
                last_exc = exc
                if self._is_request_too_large_error(exc):
                    images = sum(1 for message in messages for part in
                        (message.get('content') if isinstance(message.get('content'), list) else [])
                        if isinstance(part, dict) and part.get('type') == 'image_url')
                    chars = sum(len(message.get('content', '')) if isinstance(message.get('content'), str) else
                        sum(len(part.get('text', '')) for part in message.get('content', [])
                            if isinstance(part, dict) and part.get('type') == 'text') for message in messages)
                    raise ValueError('模型请求被上游拒绝（HTTP 413，请求体过大）；未重复提交相同请求。'
                        f'安全规模诊断：messages_json_bytes={self._estimate_messages_bytes(messages)}，'
                        f'text_chars={chars}，image_count={images}，local_budget_bytes={self.max_request_bytes}。'
                        '该估算不包含协议封装，不能代表上游硬限制；请降低本地分片字符/时长或网格图片大小后手动重试。') from exc
                if attempt == self._max_retry_attempts - 1 or not self._is_retryable_error(exc):
                    raise
                sleep_seconds = self._retry_base_backoff * (2 ** attempt)
                time.sleep(sleep_seconds)

        if last_exc is not None:
            raise last_exc
        raise RuntimeError("chat completion failed without exception")

    @staticmethod
    def _usage_metrics(response) -> dict:
        def field(value, name):
            return value.get(name) if isinstance(value, dict) else getattr(value, name, None)

        def count(value):
            return value if type(value) is int and value >= 0 else None

        usage = field(response, 'usage')
        hit = count(field(usage, 'prompt_cache_hit_tokens'))
        if hit is None:
            hit = count(field(field(usage, 'prompt_tokens_details'), 'cached_tokens'))
        return {
            'prompt_tokens': count(field(usage, 'prompt_tokens')),
            'completion_tokens': count(field(usage, 'completion_tokens')),
            'cache_hit_tokens': hit,
            'cache_miss_tokens': count(field(usage, 'prompt_cache_miss_tokens')),
            # Missing usage is unknown, not evidence of a cache miss.
            'cache_status': 'not_reported' if hit is None else ('hit' if hit else 'miss'),
        }

    @staticmethod
    def _validated_response(response, phase='生成') -> str:
        choices = getattr(response, 'choices', None)
        if not isinstance(choices, (list, tuple)) or not choices:
            raise ValueError(f'笔记{phase}失败：模型未返回候选正文（choices为空），未保存为完成结果。')
        choice = choices[0]
        reason = getattr(choice, 'finish_reason', None)
        if reason == 'length':
            raise IncompleteOutputError(f'笔记{phase}未完成：模型输出因长度限制被截断（finish_reason=length），未保存半截正文；请提高输出预算或缩小来源范围后手动重试。')
        if reason == 'content_filter':
            raise ValueError(f'笔记{phase}未完成：模型输出被内容过滤（finish_reason=content_filter），未保存为完成结果。')
        if reason != 'stop':
            raise ValueError(f'笔记{phase}未完成：模型没有正常结束正文（finish_reason={reason or "缺失"}），未保存为完成结果。')
        message = getattr(choice, 'message', None)
        if getattr(message, 'refusal', None):
            raise ValueError(f'笔记{phase}未完成：模型拒绝生成正文，未保存为完成结果。')
        content = getattr(message, 'content', None)
        if not isinstance(content, str) or not content.strip():
            raise ValueError(f'笔记{phase}失败：模型返回空正文或非文本正文，未保存为完成结果。')
        return content.strip()

    @staticmethod
    def _assemble_partials(partials: list) -> str:
        if len(partials) == 1:
            return partials[0]
        return ('> 以下保留各来源分段的完整正文，未进行跨段模型合并。\n\n' +
                '\n\n---\n\n'.join(f'## 来源分段 {index}\n\n{text}' for index, text in enumerate(partials, 1)))

    def _merge_partials(self, partials: list, checkpoint_key: str | None, source_signature: str | None) -> str:
        def build_messages(texts, *_args, **_kwargs):
            return self._build_merge_messages(texts)

        merge_chunker = RequestChunker(
            lambda *_args, **_kwargs: [],
            self.max_request_bytes,
            self._estimate_messages_bytes
        )

        current_partials = list(partials)
        rounds = 0
        while len(current_partials) > 1:
            # Large complete notes are already useful. Do not force them through
            # an unbounded synthesis request that may truncate their content.
            if rounds >= 4 or sum(map(len, current_partials)) > getattr(self, 'max_merge_text_chars', 24000):
                return self._assemble_partials(current_partials)
            try:
                groups = merge_chunker.group_texts_by_budget(current_partials, build_messages,
                    max_text_chars=getattr(self, 'max_merge_text_chars', 24000))
            except ValueError:
                return self._assemble_partials(current_partials)
            if len(groups) >= len(current_partials):
                return self._assemble_partials(current_partials)
            rounds += 1
            new_partials = []
            for group_idx, group in enumerate(groups):
                if len(group) == 1:
                    new_partials.append(group[0])
                    continue
                messages = build_messages(group)
                try:
                    self._generation_context = dict(phase='merge', node=f'round-{rounds}/group-{group_idx}', depth=0)
                    response = self._chat_completion_create(messages)
                    text = self._validated_response(response, '合并')
                except IncompleteOutputError:
                    self._audit_event('merge_truncation_assembled', **self._generation_context)
                    # Keep only previously completed bodies, never the truncated
                    # response. The explicit chapter marker explains the result.
                    return self._assemble_partials(new_partials + [text for remaining in groups[group_idx:] for text in remaining])
                except Exception:
                    if checkpoint_key and source_signature:
                        remaining = [text for remaining_group in groups[group_idx:] for text in remaining_group]
                        self._save_checkpoint(checkpoint_key, source_signature, new_partials + remaining, "merge")
                    raise

                new_partials.append(text)

                if checkpoint_key and source_signature:
                    remaining_partials = []
                    for remaining_group in groups[group_idx + 1:]:
                        remaining_partials.extend(remaining_group)
                    resumable_partials = new_partials + remaining_partials
                    self._save_checkpoint(checkpoint_key, source_signature, resumable_partials, "merge")

            current_partials = new_partials

        return current_partials[0]

    def _summarize_chunk(self, chunk, source, message_builder, depth=0, *, progress=None,
                         save_progress=None, node='root', budget=None) -> str:
        progress = progress if progress is not None else {}
        budget = budget if budget is not None else {'remaining': 15}
        cached = progress.get(node, {})
        if isinstance(cached, dict) and isinstance(cached.get('text'), str) and cached['text'].strip():
            self._audit_event('checkpoint_reused', phase='summarize', node=f'chunk-{getattr(self, "_chunk_index", 0)}/{node}', depth=depth)
            return cached['text']
        kwargs = dict(title=source.title, tags=source.tags, _format=source._format,
            style=source.style, extras=source.extras, frame_evidence=getattr(source, 'frame_evidence', None))
        messages = message_builder(chunk.segments, chunk.image_urls,
            video_image_ranges=getattr(chunk, 'video_image_ranges', None), **kwargs)
        try:
            if isinstance(cached, dict) and cached.get('split') is True:
                raise IncompleteOutputError('已保存此前长度截断的细分计划，继续剩余子片。')
            if budget['remaining'] <= 0:
                raise ValueError('来源分片已达到15个生成请求的有界细分上限，保留已完成正文；请减少来源范围后手动重试。')
            budget['remaining'] -= 1
            self._generation_context = dict(phase='summarize', node=f'chunk-{getattr(self, "_chunk_index", 0)}/{node}', depth=depth)
            text = self._validated_response(self._chat_completion_create(messages))
            progress[node] = {'text': text}
            if save_progress:
                save_progress()
            return text
        except IncompleteOutputError as exc:
            self._audit_event('truncation_split', phase='summarize', node=f'chunk-{getattr(self, "_chunk_index", 0)}/{node}', depth=depth)
            if depth >= getattr(self, 'max_length_split_depth', 2):
                raise IncompleteOutputError(f'{exc} 已达到有界细分上限，未保存被截断正文。') from exc
            total_chars = sum(len(segment.text) for segment in chunk.segments)
            if total_chars > 1:
                smaller = RequestChunker(message_builder, self.max_request_bytes, self._estimate_messages_bytes,
                    max(1, min(getattr(self, 'max_chunk_text_chars', 8000) // (2 ** (depth + 1)), total_chars // 2)),
                    max(1, getattr(self, 'max_chunk_seconds', 600) // (2 ** (depth + 1))))
                subchunks = smaller.chunk(chunk.segments, chunk.image_urls,
                    video_image_ranges=getattr(chunk, 'video_image_ranges', None), **kwargs)
            elif not chunk.segments and len(chunk.image_urls) > 1:
                midpoint = len(chunk.image_urls) // 2
                ranges = getattr(chunk, 'video_image_ranges', None)
                subchunks = [type(chunk)(segments=[], image_urls=chunk.image_urls[a:b],
                    video_image_ranges=ranges[a:b] if ranges is not None else None)
                    for a, b in ((0, midpoint), (midpoint, len(chunk.image_urls)))]
            else:
                raise
            if len(subchunks) < 2:
                raise
            progress[node] = {'split': True}
            if save_progress:
                save_progress()
            text = self._assemble_partials([self._summarize_chunk(part, source, message_builder, depth + 1,
                progress=progress, save_progress=save_progress, node=f'{node}/{index}', budget=budget)
                for index, part in enumerate(subchunks)])
            progress[node] = {'text': text}
            if save_progress:
                save_progress()
            return text

    def summarize(self, source: GPTSource) -> str:
        self.screenshot = source.screenshot
        self.link = source.link
        source.segment = self.ensure_segments_type(source.segment)
        if not source.segment and not source.video_img_urls:
            raise ValueError('没有可总结的转写内容，请先完成音频转写')
        checkpoint_key = source.checkpoint_key
        source_signature = self._build_source_signature(source) if checkpoint_key else None

        def message_builder(segments, image_urls, **kwargs):
            return self.create_messages(segments, video_img_urls=image_urls, **kwargs)

        chunker = RequestChunker(message_builder, self.max_request_bytes, self._estimate_messages_bytes,
            getattr(self, 'max_chunk_text_chars', 8000), getattr(self, 'max_chunk_seconds', 600))

        chunks = chunker.chunk(
            source.segment,
            source.video_img_urls or [],
            video_image_ranges=getattr(source, 'video_image_ranges', None),
            title=source.title,
            tags=source.tags,
            _format=source._format,
            style=source.style,
            extras=source.extras,
            frame_evidence=getattr(source, 'frame_evidence', None),
        )

        partials = []
        chunk_progress = {}
        phase = 'summarize'
        if checkpoint_key and source_signature:
            checkpoint = self._load_checkpoint(checkpoint_key, source_signature)
            if checkpoint and isinstance(checkpoint.get("partials"), list):
                if checkpoint.get('phase') in ('summarize', 'merge') and all(isinstance(text, str) and text.strip() for text in checkpoint['partials']):
                    partials = checkpoint["partials"]
                    phase = checkpoint['phase']
                    if isinstance(checkpoint.get('chunk_progress'), dict):
                        chunk_progress = checkpoint['chunk_progress']

        # Merge checkpoints contain all complete inputs still needing merging.
        # Their length is unrelated to the number of original source chunks.
        if phase == 'merge' and partials:
            merged = self._merge_partials(partials, checkpoint_key, source_signature)
            self._clear_checkpoint(checkpoint_key)
            return merged

        if len(partials) > len(chunks):
            partials = []
            chunk_progress = {}

        for chunk_index, chunk in enumerate(chunks[len(partials):], len(partials)):
            self._chunk_index = chunk_index
            def save_progress():
                if checkpoint_key and source_signature:
                    self._save_checkpoint(checkpoint_key, source_signature, partials, 'summarize', chunk_progress)
            try:
                text = self._summarize_chunk(chunk, source, message_builder,
                    progress=chunk_progress, save_progress=save_progress)
            except Exception:
                if checkpoint_key and source_signature:
                    self._save_checkpoint(checkpoint_key, source_signature, partials, "summarize", chunk_progress)
                raise

            partials.append(text)
            chunk_progress = {}
            if checkpoint_key and source_signature:
                self._save_checkpoint(checkpoint_key, source_signature, partials, "summarize")

        if len(partials) == 1:
            if checkpoint_key:
                self._clear_checkpoint(checkpoint_key)
            return partials[0]
        merged = self._merge_partials(partials, checkpoint_key, source_signature)
        if checkpoint_key:
            self._clear_checkpoint(checkpoint_key)
        return merged
