"""可插拔四阶段蒸馏管线（AcquireMedia -> Transcribe -> SynthesizeNote -> PersistNote）。

设计要点：
1. 与具体下载器/转写器/模型实现解耦，便于单元测试、纯字幕直出（跳过前两阶段）与后续批量队列编排；
2. 每个阶段前后自动检查 CancellationToken，并通过统一回调向 JobManager 报告进度。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable

from app.jobs.models import CancellationToken, JobStatus


ProgressCallback = Callable[[JobStatus, int, str], None]
StageFunc = Callable[["PipelineContext"], Any]


@dataclass
class PipelineContext:
    task_id: str
    source_url: str = ""
    platform: str = ""
    subtitle_path: str | None = None
    prefetched_transcript: Any = None
    media: Any = None
    transcript: Any = None
    note: Any = None
    persisted: Any = None
    extra: dict[str, Any] = field(default_factory=dict)


class PipelineRunner:
    def __init__(
        self,
        *,
        acquire_media: StageFunc,
        transcribe: StageFunc,
        synthesize_note: StageFunc,
        persist_note: StageFunc,
    ) -> None:
        self._acquire_media = acquire_media
        self._transcribe = transcribe
        self._synthesize_note = synthesize_note
        self._persist_note = persist_note

    def run(
        self,
        ctx: PipelineContext,
        *,
        cancel_token: CancellationToken | None = None,
        on_progress: ProgressCallback | None = None,
    ) -> Any:
        def _check() -> None:
            if cancel_token is not None:
                cancel_token.raise_if_cancelled()

        def _report(status: JobStatus, progress: int, message: str) -> None:
            if callable(on_progress):
                on_progress(status, progress, message)

        _check()
        if ctx.prefetched_transcript is None and ctx.subtitle_path:
            from app.domains.ingestion.subtitle_parser import parse_subtitle_file

            ctx.prefetched_transcript = parse_subtitle_file(ctx.subtitle_path)
        if ctx.prefetched_transcript is not None:
            ctx.transcript = ctx.prefetched_transcript
            _report(JobStatus.TRANSCRIBING, 48, "已识别字幕文本，跳过下载与转写")
        else:
            _report(JobStatus.DOWNLOADING, 22, "正在获取音视频素材")
            ctx.media = self._acquire_media(ctx)
            _check()

            _report(JobStatus.TRANSCRIBING, 48, "正在转写语音内容")
            ctx.transcript = self._transcribe(ctx)
            _check()

        _report(JobStatus.SUMMARIZING, 72, "正在整理结构化笔记")
        ctx.note = self._synthesize_note(ctx)
        _check()

        _report(JobStatus.SAVING, 92, "正在保存笔记与索引")
        ctx.persisted = self._persist_note(ctx)
        _check()

        return ctx.persisted
