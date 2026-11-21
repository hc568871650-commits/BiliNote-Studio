"""统一模型网关（LLMGateway）。

收敛多协议客户端获取、瞬态重试、协作式取消检查、用量归集与结构化 JSON 容错解析；
所有重型协议客户端均按需懒加载，不影响后端冷启动。
"""

from __future__ import annotations

from dataclasses import dataclass, field
import json
import re
import time
from typing import Any, Callable

from app.jobs.models import CancellationToken, JobCancelledError
from app.utils.logger import get_logger

logger = get_logger(__name__)

_THINK_TAG_RE = re.compile(r"<think>.*?</think>", re.IGNORECASE | re.DOTALL)
_CODE_FENCE_RE = re.compile(r"```(?:json)?\s*(.*?)\s*```", re.IGNORECASE | re.DOTALL)


@dataclass
class LLMResponse:
    text: str
    usage: dict[str, Any] = field(default_factory=dict)
    model: str = ""
    protocol: str = "openai-chat"
    parsed: dict[str, Any] | None = None
    attempts: int = 1


def extract_json_object(raw_text: str) -> dict[str, Any]:
    """从模型输出中容错提取 JSON 对象（剥离思考标签、Markdown 代码围栏与前后杂文）。"""
    cleaned = _THINK_TAG_RE.sub("", str(raw_text or "")).strip()
    if not cleaned:
        raise ValueError("模型返回为空，无法解析 JSON")

    candidates: list[str] = [cleaned]
    for match in _CODE_FENCE_RE.finditer(cleaned):
        inner = match.group(1).strip()
        if inner:
            candidates.insert(0, inner)

    first_brace = cleaned.find("{")
    last_brace = cleaned.rfind("}")
    if first_brace != -1 and last_brace > first_brace:
        candidates.append(cleaned[first_brace : last_brace + 1])

    last_err: Exception | None = None
    for candidate in candidates:
        try:
            obj = json.loads(candidate)
            if isinstance(obj, dict):
                return obj
        except Exception as exc:
            last_err = exc
    raise ValueError(f"无法从模型返回中解析合法 JSON 对象: {last_err}")


def _is_retryable_error(exc: Exception) -> bool:
    if isinstance(exc, (JobCancelledError, ValueError, TypeError, KeyError)):
        return False
    if getattr(exc, "cancelled", False):
        return False
    if isinstance(exc, (TimeoutError, ConnectionError, OSError)):
        return True
    status_code = getattr(exc, "status_code", None)
    if isinstance(status_code, int) and status_code in (408, 429, 500, 502, 503, 504):
        return True
    msg = str(exc).lower()
    return any(tok in msg for tok in ("timeout", "timed out", "temporarily", "rate limit", "502", "503", "504"))


def _default_invoker(
    *,
    provider_id: str,
    model_name: str,
    messages: list[dict[str, Any]],
    protocol: str | None = None,
    temperature: float | None = None,
    reasoning_effort: str = "auto",
    max_tokens: int | None = None,
    response_format: dict[str, Any] | None = None,
) -> LLMResponse:
    from app.services.ai_client import close_client, get_client
    from app.services.ai_runtime import complete as runtime_complete

    bundle = get_client(provider_id, model_name, protocol=protocol)
    try:
        kwargs: dict[str, Any] = {}
        if temperature is not None:
            kwargs["temperature"] = temperature
        if max_tokens is not None:
            kwargs["max_tokens"] = max_tokens
        if response_format is not None:
            kwargs["response_format"] = response_format
        raw = runtime_complete(
            bundle.client,
            bundle.model,
            messages,
            protocol=protocol or "openai-chat",
            effort=reasoning_effort,
            **kwargs,
        )
        content = ""
        usage: dict[str, Any] = {}
        if isinstance(raw, dict):
            content = str(raw.get("content") or raw.get("text") or "")
            if isinstance(raw.get("usage"), dict):
                usage = dict(raw["usage"])
        elif hasattr(raw, "choices") and raw.choices:
            content = str(getattr(raw.choices[0].message, "content", "") or "")
            raw_usage = getattr(raw, "usage", None)
            if raw_usage is not None:
                usage = {
                    "prompt_tokens": getattr(raw_usage, "prompt_tokens", None),
                    "completion_tokens": getattr(raw_usage, "completion_tokens", None),
                    "total_tokens": getattr(raw_usage, "total_tokens", None),
                }
        else:
            content = str(raw or "")
        return LLMResponse(
            text=content,
            usage=usage,
            model=model_name,
            protocol=protocol or "openai-chat",
        )
    finally:
        close_client(bundle.client)


class LLMGateway:
    def __init__(
        self,
        *,
        invoker: Callable[..., LLMResponse] | None = None,
        retry_backoff_seconds: float = 0.8,
    ) -> None:
        self._invoker = invoker or _default_invoker
        self._retry_backoff_seconds = max(0.0, float(retry_backoff_seconds))

    def complete(
        self,
        *,
        provider_id: str,
        model_name: str,
        messages: list[dict[str, Any]],
        protocol: str | None = None,
        temperature: float | None = None,
        reasoning_effort: str = "auto",
        max_tokens: int | None = None,
        response_format: dict[str, Any] | None = None,
        max_retries: int = 1,
        cancel_token: CancellationToken | None = None,
    ) -> LLMResponse:
        total_attempts = max(1, int(max_retries) + 1)
        last_exc: Exception | None = None
        for attempt in range(1, total_attempts + 1):
            if cancel_token is not None:
                cancel_token.raise_if_cancelled()
            try:
                res = self._invoker(
                    provider_id=provider_id,
                    model_name=model_name,
                    messages=messages,
                    protocol=protocol,
                    temperature=temperature,
                    reasoning_effort=reasoning_effort,
                    max_tokens=max_tokens,
                    response_format=response_format,
                )
                res.attempts = attempt
                return res
            except Exception as exc:
                last_exc = exc
                if attempt >= total_attempts or not _is_retryable_error(exc):
                    raise
                logger.warning("模型请求瞬态失败，准备第 %s/%s 次重试: %s", attempt + 1, total_attempts, exc)
                if self._retry_backoff_seconds > 0:
                    time.sleep(self._retry_backoff_seconds * attempt)
        assert last_exc is not None
        raise last_exc

    def complete_structured(
        self,
        *,
        provider_id: str,
        model_name: str,
        messages: list[dict[str, Any]],
        protocol: str | None = None,
        temperature: float | None = None,
        reasoning_effort: str = "auto",
        max_tokens: int | None = None,
        max_retries: int = 1,
        cancel_token: CancellationToken | None = None,
    ) -> LLMResponse:
        res = self.complete(
            provider_id=provider_id,
            model_name=model_name,
            messages=messages,
            protocol=protocol,
            temperature=temperature,
            reasoning_effort=reasoning_effort,
            max_tokens=max_tokens,
            response_format={"type": "json_object"},
            max_retries=max_retries,
            cancel_token=cancel_token,
        )
        res.parsed = extract_json_object(res.text)
        return res


_gateway_instance: LLMGateway | None = None


def get_llm_gateway() -> LLMGateway:
    global _gateway_instance
    if _gateway_instance is None:
        _gateway_instance = LLMGateway()
    return _gateway_instance
