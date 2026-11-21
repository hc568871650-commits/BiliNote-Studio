"""测试统一模型网关（llm/）、规范枚举（enums/）与核心业务域拆分（domains/）。"""

from __future__ import annotations

from pathlib import Path
from fastapi.testclient import TestClient


def test_enums_and_legacy_enmus_are_identical():
    from app.enums.exception import NoteErrorEnum, ProviderErrorEnum
    from app.enums.note_enums import DownloadQuality
    from app.enums.task_status_enums import TaskStatus

    from app.enmus.exception import (
        NoteErrorEnum as LegacyNoteErrorEnum,
        ProviderErrorEnum as LegacyProviderErrorEnum,
    )
    from app.enmus.note_enums import DownloadQuality as LegacyDownloadQuality
    from app.enmus.task_status_enums import TaskStatus as LegacyTaskStatus

    assert TaskStatus is LegacyTaskStatus
    assert DownloadQuality is LegacyDownloadQuality
    assert NoteErrorEnum is LegacyNoteErrorEnum
    assert ProviderErrorEnum is LegacyProviderErrorEnum
    assert TaskStatus.description(TaskStatus.SUMMARIZING) == "总结中"


def test_llm_gateway_retry_cancel_and_structured_json_recovery():
    from app.jobs.models import CancellationToken, JobCancelledError
    from app.llm.gateway import LLMGateway, LLMResponse

    attempts = {"n": 0}

    def flaky_invoker(**kwargs):
        attempts["n"] += 1
        if attempts["n"] == 1:
            raise TimeoutError("瞬态超时")
        return LLMResponse(
            text="<think>推理过程</think>\n```json\n{\"title\": \"测试笔记\", \"sections\": []}\n```",
            usage={"prompt_tokens": 120, "completion_tokens": 60, "total_tokens": 180},
            model="test-model",
            protocol="openai-chat",
        )

    gw = LLMGateway(invoker=flaky_invoker, retry_backoff_seconds=0.0)
    res = gw.complete_structured(
        provider_id="p1",
        model_name="test-model",
        messages=[{"role": "user", "content": "hi"}],
        max_retries=2,
    )
    assert attempts["n"] == 2
    assert res.parsed["title"] == "测试笔记"
    assert res.usage["total_tokens"] == 180

    # 取消令牌应立即阻断调用，不触发模型请求
    token = CancellationToken()
    token.cancel("用户取消")
    called = {"count": 0}

    def never_called(**kwargs):
        called["count"] += 1
        return LLMResponse(text="{}", usage={}, model="m", protocol="openai-chat")

    gw_cancel = LLMGateway(invoker=never_called, retry_backoff_seconds=0.0)
    try:
        gw_cancel.complete(
            provider_id="p1",
            model_name="m",
            messages=[{"role": "user", "content": "hi"}],
            cancel_token=token,
        )
    except JobCancelledError:
        pass
    else:
        raise AssertionError("已取消的令牌应抛出 JobCancelledError")
    assert called["count"] == 0


def test_pipeline_runner_stages_skip_and_cancel():
    from app.domains.pipeline.runner import PipelineContext, PipelineRunner
    from app.jobs.models import CancellationToken, JobCancelledError, JobStatus

    stages_seen: list[str] = []
    progress_events: list[tuple[JobStatus, int]] = []

    runner = PipelineRunner(
        acquire_media=lambda ctx: stages_seen.append("acquire") or {"audio": "a.mp3"},
        transcribe=lambda ctx: stages_seen.append("transcribe") or {"segments": [{"start": 0, "end": 5, "text": "hello"}]},
        synthesize_note=lambda ctx: stages_seen.append("synthesize") or {"markdown": "# OK"},
        persist_note=lambda ctx: stages_seen.append("persist") or {"saved": True, "markdown": ctx.note["markdown"]},
    )

    # 正常四阶段完整执行
    ctx = PipelineContext(task_id="p-full")
    out = runner.run(
        ctx,
        on_progress=lambda status, progress, msg: progress_events.append((status, progress)),
    )
    assert stages_seen == ["acquire", "transcribe", "synthesize", "persist"]
    assert out["saved"] is True
    assert any(st == JobStatus.SUMMARIZING for st, _ in progress_events)

    # 预置字幕时跳过下载与转写
    stages_seen.clear()
    ctx_sub = PipelineContext(
        task_id="p-sub",
        prefetched_transcript={"segments": [{"start": 0, "end": 3, "text": "字幕直出"}]},
    )
    runner.run(ctx_sub)
    assert stages_seen == ["synthesize", "persist"]

    # 中途取消应阻断后续阶段
    stages_seen.clear()
    token = CancellationToken()

    def cancel_on_transcribe(c):
        stages_seen.append("transcribe")
        token.cancel("中途取消")
        return {"segments": []}

    runner_cancel = PipelineRunner(
        acquire_media=lambda c: stages_seen.append("acquire") or {},
        transcribe=cancel_on_transcribe,
        synthesize_note=lambda c: stages_seen.append("synthesize") or {},
        persist_note=lambda c: stages_seen.append("persist") or {},
    )
    try:
        runner_cancel.run(PipelineContext(task_id="p-cancel"), cancel_token=token)
    except JobCancelledError:
        pass
    else:
        raise AssertionError("中途取消应抛出 JobCancelledError")
    assert stages_seen == ["acquire", "transcribe"]


def test_learning_and_media_domain_routes_compatibility(tmp_path: Path):
    from app import create_app
    from app.services import note_storage

    orig_root = note_storage.ROOT
    note_storage.ROOT = tmp_path / "notes"
    note_storage.ROOT.mkdir(parents=True, exist_ok=True)
    media_file = tmp_path / "notes" / "demo.mp3"
    media_file.write_bytes(b"ID3" + b"\x00" * 64)

    try:
        task_id = "domain-compat-01"
        note_storage.save_task({
            "id": task_id,
            "status": "SUCCESS",
            "audioMeta": {"title": "兼容校验笔记", "file_path": str(media_file)},
            "markdown": [{"ver_id": "v1", "content": "# 标题\n正文", "style": "detailed", "model_name": "m"}],
        })

        app = create_app(lifespan=None)
        client = TestClient(app)

        # 新旧学习状态路由均可读写且数据一致
        put_new = client.put(
            f"/api/learning/notes/{task_id}/state",
            json={"checklist_states": {"sec-1:0": True}},
        )
        assert put_new.status_code == 200
        assert put_new.json()["data"]["checklist_states"]["sec-1:0"] is True

        get_old = client.get(f"/api/notes/{task_id}/learning-state")
        assert get_old.status_code == 200
        assert get_old.json()["data"]["checklist_states"]["sec-1:0"] is True

        # 复习库路由可用
        rb = client.get("/api/learning/review-bank")
        assert rb.status_code == 200
        assert rb.json()["code"] == 0

        # 新旧媒体流路由与元信息探测均一致
        info = client.get(f"/api/media/{task_id}/info")
        assert info.status_code == 200
        assert info.json()["data"]["available"] is True
        assert info.json()["data"]["size"] == 67

        r_new = client.get(f"/api/media/{task_id}", headers={"Range": "bytes=0-2"})
        r_old = client.get(f"/api/notes/{task_id}/media", headers={"Range": "bytes=0-2"})
        assert r_new.status_code == 206
        assert r_old.status_code == 206
        assert r_new.content == b"ID3"
        assert r_old.content == b"ID3"
    finally:
        note_storage.ROOT = orig_root
