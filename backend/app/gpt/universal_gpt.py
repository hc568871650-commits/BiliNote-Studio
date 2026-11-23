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
        from app.gpt import prompt_builder as builder_mod
        prompt_mode = kwargs.get('prompt_mode')
        output_language = kwargs.get('output_language')
        post_context = kwargs.get('post_context')
        if prompt_mode == 'structured' and callable(getattr(builder_mod, 'generate_structured_prompt', None)):
            content_text = builder_mod.generate_structured_prompt(
                title=kwargs.get('title'),
                segment_text=self._build_segment_text(segments),
                tags=kwargs.get('tags'),
                _format=kwargs.get('_format'),
                style=kwargs.get('style'),
                extras=kwargs.get('extras'),
                output_language=output_language,
                post_context=post_context,
            )
        elif prompt_mode == 'knowledge_pass1' and callable(getattr(builder_mod, 'generate_knowledge_pass1_prompt', None)):
            content_text = builder_mod.generate_knowledge_pass1_prompt(
                title=kwargs.get('title'),
                segment_text=self._build_segment_text(segments),
                tags=kwargs.get('tags'),
                _format=kwargs.get('_format'),
                extras=kwargs.get('extras'),
                output_language=output_language,
                post_context=post_context,
            )
        else:
            content_text = generate_base_prompt(
                title=kwargs.get('title'),
                segment_text=self._build_segment_text(segments),
                tags=kwargs.get('tags'),
                _format=kwargs.get('_format'),
                style=kwargs.get('style'),
                extras=kwargs.get('extras'),
                output_language=output_language,
                post_context=post_context,
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
            "structured_contract": "structured-v1" if getattr(source, 'structured', False) else "markdown-legacy",
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
            "output_language": getattr(source, 'output_language', 'zh-CN') or 'zh-CN',
            "post_context": getattr(source, 'post_context', None) or '',
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
        return '\n\n---\n\n'.join(f'## 来源分段 {index}\n\n{text}' for index, text in enumerate(partials, 1))

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
                         save_progress=None, node='root', budget=None, prompt_mode=None,
                         assemble_fn=None) -> str:
        progress = progress if progress is not None else {}
        budget = budget if budget is not None else {'remaining': 15}
        cached = progress.get(node, {})
        if isinstance(cached, dict) and isinstance(cached.get('text'), str) and cached['text'].strip():
            self._audit_event('checkpoint_reused', phase='summarize', node=f'chunk-{getattr(self, "_chunk_index", 0)}/{node}', depth=depth)
            return cached['text']
        kwargs = dict(title=source.title, tags=source.tags, _format=source._format,
            style=source.style, extras=source.extras,
            output_language=getattr(source, 'output_language', None),
            post_context=getattr(source, 'post_context', None),
            frame_evidence=getattr(source, 'frame_evidence', None))
        if prompt_mode:
            kwargs['prompt_mode'] = prompt_mode
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
            sub_results = [self._summarize_chunk(part, source, message_builder, depth + 1,
                progress=progress, save_progress=save_progress, node=f'{node}/{index}',
                budget=budget, prompt_mode=prompt_mode, assemble_fn=assemble_fn)
                for index, part in enumerate(subchunks)]
            text = assemble_fn(sub_results) if callable(assemble_fn) else self._assemble_partials(sub_results)
            progress[node] = {'text': text}
            if save_progress:
                save_progress()
            return text

    @staticmethod
    def _structured_module():
        from app.models import structured_note
        return structured_note

    def _repair_json_once(self, raw_text: str, schema_hint: str) -> str:
        if getattr(self, '_http_attempt_count', 0) >= getattr(self, '_max_http_attempts', 64):
            return raw_text
        prompt = (
            f"将下面内容无损整理为单个合法 JSON 对象（{schema_hint}），不要增删事实，不要输出任何额外说明或代码块围栏：\n\n"
            + raw_text[:18000]
        )
        try:
            self._generation_context = dict(phase='summarize', node='json_repair', depth=0)
            resp = self._chat_completion_create([{"role": "user", "content": prompt}])
            return self._validated_response(resp, '格式整理')
        except Exception:
            return raw_text

    def _parse_or_fallback_structured(self, raw_text: str, source: GPTSource, note_style: str) -> dict:
        sn = self._structured_module()
        cleaned = sn.strip_reasoning_and_fences(raw_text) if hasattr(sn, 'strip_reasoning_and_fences') else raw_text.strip()
        doc = sn.extract_structured_note_json(
            cleaned, fallback_title=source.title or "视频笔记", default_style=note_style
        )
        # 仅当输出形态疑似残缺 JSON 时发起单轮无损修复，避免对纯 Markdown 浪费额外请求。
        looks_like_json = "{" in cleaned or '"sections"' in cleaned
        if doc is None and looks_like_json:
            repaired = self._repair_json_once(cleaned, "包含 title 与 sections 数组")
            doc = sn.extract_structured_note_json(
                repaired, fallback_title=source.title or "视频笔记", default_style=note_style
            )
        if doc is not None:
            return doc
        # Deterministic structured fallback so valid prose is never discarded.
        fallback_text = cleaned or raw_text.strip()
        paragraphs = [p.strip() for p in re.split(r"\n{2,}", fallback_text) if p.strip()]
        blocks = [{"type": "paragraph", "spans": [{"text": p, "emphasis": "plain", "annotation_id": None}]} for p in paragraphs]
        return sn.normalize_structured_note(
            {
                "schema_version": 1,
                "note_style": note_style,
                "title": source.title or "视频笔记",
                "sections": [{
                    "id": "sec-1",
                    "title": source.title or "核心笔记",
                    "level": 2,
                    "time_ranges": [{"start": int(getattr(source.segment[0], "start", 0))} ] if source.segment else [],
                    "core_takeaways": [],
                    "blocks": blocks or [{"type": "paragraph", "spans": [{"text": fallback_text, "emphasis": "plain"}]}],
                    "annotations": [],
                    "quiz": None,
                }],
            },
            fallback_title=source.title or "视频笔记",
            default_style=note_style,
        )

    def _parse_knowledge_cards(self, raw_text: str, segments: List[TranscriptSegment], title: str) -> list[dict]:
        sn = self._structured_module()
        cleaned = sn.strip_reasoning_and_fences(raw_text) if hasattr(sn, 'strip_reasoning_and_fences') else raw_text.strip()
        obj = sn.extract_json_object(cleaned)
        if not (isinstance(obj, dict) and isinstance(obj.get("cards"), list)):
            repaired = self._repair_json_once(cleaned, '格式为 {"cards": [...]}')
            obj = sn.extract_json_object(repaired)
        if isinstance(obj, dict) and isinstance(obj.get("cards"), list) and obj["cards"]:
            return [c for c in obj["cards"] if isinstance(c, dict)]
        start_s = self._format_time(segments[0].start) if segments else "00:00"
        end_s = self._format_time(segments[-1].end) if segments else start_s
        return [{
            "topic": title or "核心要点",
            "start": start_s,
            "end": end_s,
            "claims": [cleaned or raw_text.strip()],
        }]

    @staticmethod
    def _assemble_structured_sections(docs: list[dict], source: GPTSource, note_style: str) -> dict:
        sn = UniversalGPT._structured_module()
        combined_sections = []
        for doc in docs:
            for sec in doc.get("sections") or []:
                combined_sections.append(sec)
        for idx, sec in enumerate(combined_sections, 1):
            sec["id"] = f"sec-{idx}"
        return sn.normalize_structured_note(
            {
                "schema_version": 1,
                "note_style": note_style,
                "title": source.title or (docs[0].get("title") if docs else "视频笔记"),
                "sections": combined_sections,
            },
            fallback_title=source.title or "视频笔记",
            default_style=note_style,
        )

    def _consolidate_knowledge_cards(self, partials: list[str], chunks, source: GPTSource,
                                     checkpoint_key: str | None, source_signature: str | None) -> str:
        sn = self._structured_module()
        cards: list[dict] = []
        for idx, raw in enumerate(partials):
            segs = chunks[idx].segments if idx < len(chunks) else source.segment
            cards.extend(self._parse_knowledge_cards(raw, segs, source.title))

        lang_rule = prompt_contract.get_output_language_rule(getattr(source, 'output_language', None)) if callable(getattr(prompt_contract, 'get_output_language_rule', None)) else ''
        batch_prompt = getattr(prompt_contract, 'KNOWLEDGE_CARD_BATCH_MERGE_INSTRUCTIONS', MERGE_PROMPT)
        pass2_prompt = getattr(prompt_contract, 'KNOWLEDGE_CONSOLIDATE_PASS2_INSTRUCTIONS', MERGE_PROMPT)
        if lang_rule:
            batch_prompt = batch_prompt + "\n" + lang_rule
            pass2_prompt = pass2_prompt + "\n" + lang_rule
        max_chars = getattr(self, 'max_merge_text_chars', 24000)

        def build_pass2_messages(card_items: list[dict]) -> list:
            payload = {
                "title": source.title or "",
                "tags": source.tags or "",
                "extras": source.extras or "",
                "output_language": getattr(source, 'output_language', 'zh-CN') or 'zh-CN',
                "screenshot_enabled": "screenshot" in (source._format or []),
                "cards": card_items,
            }
            return [{"role": "user", "content": pass2_prompt + "\n\n" + json.dumps(payload, ensure_ascii=False)}]

        # Compress overflowing cards by topic without dropping timestamps before Pass 2 consolidation.
        serialized = json.dumps(cards, ensure_ascii=False)
        if len(serialized) > max_chars and len(cards) > 1:
            card_texts = [json.dumps([c], ensure_ascii=False) for c in cards]
            chunker = RequestChunker(lambda *_a, **_k: [], self.max_request_bytes, self._estimate_messages_bytes)
            def batch_msg(items, *_a, **_k):
                return [{"role": "user", "content": batch_prompt + "\n\n" + "\n".join(items)}]
            try:
                groups = chunker.group_texts_by_budget(card_texts, batch_msg, max_text_chars=max_chars)
            except ValueError:
                groups = [card_texts]
            if len(groups) < len(card_texts):
                merged_cards: list[dict] = []
                for g_idx, group in enumerate(groups):
                    if len(group) == 1:
                        merged_cards.extend(json.loads(group[0]))
                        continue
                    try:
                        self._generation_context = dict(phase='merge', node=f'cards-group-{g_idx}', depth=0)
                        resp = self._chat_completion_create(batch_msg(group))
                        text = self._validated_response(resp, '素材整理')
                        merged_cards.extend(self._parse_knowledge_cards(text, source.segment, source.title))
                    except IncompleteOutputError:
                        for raw_card in group:
                            merged_cards.extend(json.loads(raw_card))
                cards = merged_cards

        messages = build_pass2_messages(cards)
        try:
            self._generation_context = dict(phase='merge', node='knowledge-pass2', depth=0)
            resp = self._chat_completion_create(messages)
            raw_doc = self._validated_response(resp, '主题合拢')
            doc = self._parse_or_fallback_structured(raw_doc, source, "knowledge")
            return json.dumps(doc, ensure_ascii=False)
        except IncompleteOutputError:
            # Split cards deterministically by topic groups so long videos still consolidate without "来源分段 N".
            by_topic: dict[str, list[dict]] = {}
            for card in cards:
                key = str(card.get("topic") or "核心知识").strip()[:16] or "核心知识"
                by_topic.setdefault(key, []).append(card)
            buckets: list[list[dict]] = []
            current: list[dict] = []
            for topic_cards in by_topic.values():
                if current and len(json.dumps(current + topic_cards, ensure_ascii=False)) > max_chars // 2:
                    buckets.append(current)
                    current = list(topic_cards)
                else:
                    current.extend(topic_cards)
            if current:
                buckets.append(current)
            if len(buckets) == 1 and len(cards) > 1:
                mid = len(cards) // 2
                buckets = [cards[:mid], cards[mid:]]
            docs: list[dict] = []
            for b_idx, bucket in enumerate(buckets):
                self._generation_context = dict(phase='merge', node=f'knowledge-pass2-bucket-{b_idx}', depth=0)
                resp = self._chat_completion_create(build_pass2_messages(bucket))
                raw_doc = self._validated_response(resp, '主题分簇合拢')
                docs.append(self._parse_or_fallback_structured(raw_doc, source, "knowledge"))
            combined = self._assemble_structured_sections(docs, source, "knowledge")
            return json.dumps(combined, ensure_ascii=False)

    def _merge_structured_tutorial(self, partials: list[str], source: GPTSource,
                                   checkpoint_key: str | None, source_signature: str | None) -> str:
        docs = [self._parse_or_fallback_structured(p, source, "tutorial") for p in partials]
        if len(docs) == 1:
            return json.dumps(docs[0], ensure_ascii=False)
        merge_inst = getattr(prompt_contract, 'TUTORIAL_STRUCTURED_MERGE_INSTRUCTIONS', MERGE_PROMPT)
        lang_rule = prompt_contract.get_output_language_rule(getattr(source, 'output_language', None)) if callable(getattr(prompt_contract, 'get_output_language_rule', None)) else ''
        if lang_rule:
            merge_inst = merge_inst + "\n" + lang_rule

        def build_messages(texts, *_args, **_kwargs):
            return [{"role": "user", "content": merge_inst + "\n\n" + "\n\n---\n\n".join(texts)}]

        merge_chunker = RequestChunker(lambda *_a, **_k: [], self.max_request_bytes, self._estimate_messages_bytes)
        current_texts = [json.dumps(doc, ensure_ascii=False) for doc in docs]
        rounds = 0
        while len(current_texts) > 1:
            if rounds >= 4 or sum(map(len, current_texts)) > getattr(self, 'max_merge_text_chars', 24000):
                combined = self._assemble_structured_sections(
                    [self._parse_or_fallback_structured(t, source, "tutorial") for t in current_texts],
                    source,
                    "tutorial",
                )
                return json.dumps(combined, ensure_ascii=False)
            try:
                groups = merge_chunker.group_texts_by_budget(
                    current_texts, build_messages, max_text_chars=getattr(self, 'max_merge_text_chars', 24000)
                )
            except ValueError:
                break
            if len(groups) >= len(current_texts):
                break
            rounds += 1
            next_texts: list[str] = []
            for group_idx, group in enumerate(groups):
                if len(group) == 1:
                    next_texts.append(group[0])
                    continue
                try:
                    self._generation_context = dict(phase='merge', node=f'tutorial-round-{rounds}/group-{group_idx}', depth=0)
                    resp = self._chat_completion_create(build_messages(group))
                    merged_raw = self._validated_response(resp, '教程合并')
                    merged_doc = self._parse_or_fallback_structured(merged_raw, source, "tutorial")
                    next_texts.append(json.dumps(merged_doc, ensure_ascii=False))
                except IncompleteOutputError:
                    self._audit_event('merge_truncation_assembled', **self._generation_context)
                    rem_texts = next_texts + [t for rem in groups[group_idx:] for t in rem]
                    combined = self._assemble_structured_sections(
                        [self._parse_or_fallback_structured(t, source, "tutorial") for t in rem_texts],
                        source,
                        "tutorial",
                    )
                    return json.dumps(combined, ensure_ascii=False)
                except Exception:
                    if checkpoint_key and source_signature:
                        rem = [t for rem in groups[group_idx:] for t in rem]
                        self._save_checkpoint(checkpoint_key, source_signature, next_texts + rem, "merge")
                    raise
                if checkpoint_key and source_signature:
                    rem = [t for rem in groups[group_idx + 1:] for t in rem]
                    self._save_checkpoint(checkpoint_key, source_signature, next_texts + rem, "merge")
            current_texts = next_texts

        final_docs = [self._parse_or_fallback_structured(t, source, "tutorial") for t in current_texts]
        if len(final_docs) == 1:
            return json.dumps(final_docs[0], ensure_ascii=False)
        return json.dumps(self._assemble_structured_sections(final_docs, source, "tutorial"), ensure_ascii=False)

    def _summarize_structured(self, source: GPTSource) -> str:
        from app.gpt import prompt_builder as builder_mod
        note_style = (
            builder_mod.normalize_note_style(source.style)
            if callable(getattr(builder_mod, 'normalize_note_style', None))
            else ('knowledge' if source.style == 'knowledge' else 'tutorial')
        )
        checkpoint_key = source.checkpoint_key
        source_signature = self._build_source_signature(source) if checkpoint_key else None

        def base_builder(segments, image_urls, **kwargs):
            return self.create_messages(segments, video_img_urls=image_urls, **kwargs)

        chunker = RequestChunker(
            base_builder, self.max_request_bytes, self._estimate_messages_bytes,
            getattr(self, 'max_chunk_text_chars', 8000), getattr(self, 'max_chunk_seconds', 600)
        )
        chunks = chunker.chunk(
            source.segment,
            source.video_img_urls or [],
            video_image_ranges=getattr(source, 'video_image_ranges', None),
            title=source.title,
            tags=source.tags,
            _format=source._format,
            style=note_style,
            extras=source.extras,
            output_language=getattr(source, 'output_language', None),
            post_context=getattr(source, 'post_context', None),
            frame_evidence=getattr(source, 'frame_evidence', None),
            prompt_mode='structured',
        )

        is_knowledge_multi = (note_style == 'knowledge' and len(chunks) > 1)
        prompt_mode = 'knowledge_pass1' if is_knowledge_multi else 'structured'

        def assemble_subcards(sub_results: list[str]) -> str:
            if not is_knowledge_multi:
                combined = self._assemble_structured_sections(
                    [self._parse_or_fallback_structured(r, source, note_style) for r in sub_results],
                    source,
                    note_style,
                )
                return json.dumps(combined, ensure_ascii=False)
            cards: list[dict] = []
            for r in sub_results:
                cards.extend(self._parse_knowledge_cards(r, source.segment, source.title))
            return json.dumps({"cards": cards}, ensure_ascii=False)

        partials = []
        chunk_progress = {}
        phase = 'summarize'
        if checkpoint_key and source_signature:
            checkpoint = self._load_checkpoint(checkpoint_key, source_signature)
            if checkpoint and isinstance(checkpoint.get("partials"), list):
                if checkpoint.get('phase') in ('summarize', 'merge') and all(isinstance(t, str) and t.strip() for t in checkpoint['partials']):
                    partials = checkpoint["partials"]
                    phase = checkpoint['phase']
                    if isinstance(checkpoint.get('chunk_progress'), dict):
                        chunk_progress = checkpoint['chunk_progress']

        if phase == 'merge' and partials:
            if is_knowledge_multi:
                result = self._consolidate_knowledge_cards(partials, chunks, source, checkpoint_key, source_signature)
            else:
                result = self._merge_structured_tutorial(partials, source, checkpoint_key, source_signature)
            self._clear_checkpoint(checkpoint_key)
            return result

        if len(partials) > len(chunks):
            partials = []
            chunk_progress = {}

        for chunk_index, chunk in enumerate(chunks[len(partials):], len(partials)):
            self._chunk_index = chunk_index
            def save_progress():
                if checkpoint_key and source_signature:
                    self._save_checkpoint(checkpoint_key, source_signature, partials, 'summarize', chunk_progress)
            try:
                text = self._summarize_chunk(
                    chunk, source, base_builder, progress=chunk_progress,
                    save_progress=save_progress, prompt_mode=prompt_mode,
                    assemble_fn=assemble_subcards,
                )
            except Exception:
                if checkpoint_key and source_signature:
                    self._save_checkpoint(checkpoint_key, source_signature, partials, "summarize", chunk_progress)
                raise
            partials.append(text)
            chunk_progress = {}
            if checkpoint_key and source_signature:
                self._save_checkpoint(checkpoint_key, source_signature, partials, "summarize")

        if len(partials) == 1:
            doc = self._parse_or_fallback_structured(partials[0], source, note_style)
            if checkpoint_key:
                self._clear_checkpoint(checkpoint_key)
            return json.dumps(doc, ensure_ascii=False)

        if is_knowledge_multi:
            result = self._consolidate_knowledge_cards(partials, chunks, source, checkpoint_key, source_signature)
        else:
            result = self._merge_structured_tutorial(partials, source, checkpoint_key, source_signature)
        if checkpoint_key:
            self._clear_checkpoint(checkpoint_key)
        return result

    def summarize(self, source: GPTSource) -> str:
        self.screenshot = source.screenshot
        self.link = source.link
        source.segment = self.ensure_segments_type(source.segment)
        if not source.segment and not source.video_img_urls:
            raise ValueError('没有可总结的转写内容，请先完成音频转写')
        if getattr(source, 'structured', False):
            return self._summarize_structured(source)
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
            output_language=getattr(source, 'output_language', None),
            post_context=getattr(source, 'post_context', None),
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
