"""Task 13: 本地 .srt / .vtt 字幕解析与免下载免转写直出管线测试。"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.domains.pipeline.runner import PipelineContext, PipelineRunner


def test_parse_srt_multiline_html_tags_and_utf8_bom(tmp_path):
    from app.domains.ingestion.subtitle_parser import parse_subtitle_file

    srt_content = (
        "\ufeff1\n"
        "00:00:01,250 --> 00:00:04,500\n"
        "<i>大家好</i>，今天拆解\n"
        "<b>数据库连接池</b>的上限公式。\n\n"
        "2\n"
        "00:01:02,000 --> 00:01:05,750\n"
        "{\\an8}核心公式是 CPU 核数乘以 2 加 1。\n"
    )
    path = tmp_path / "lesson1.srt"
    path.write_bytes(srt_content.encode("utf-8"))

    result = parse_subtitle_file(path)
    assert len(result.segments) == 2
    assert result.segments[0].start == pytest.approx(1.25)
    assert result.segments[0].end == pytest.approx(4.5)
    assert result.segments[0].text == "大家好，今天拆解 数据库连接池的上限公式。"
    assert result.segments[1].start == pytest.approx(62.0)
    assert result.segments[1].end == pytest.approx(65.75)
    assert result.segments[1].text == "核心公式是 CPU 核数乘以 2 加 1。"
    assert "数据库连接池" in result.full_text


def test_parse_vtt_with_header_notes_and_mmss_timestamps(tmp_path):
    from app.domains.ingestion.subtitle_parser import parse_subtitle_file

    vtt_content = (
        "WEBVTT\n"
        "Kind: captions\n"
        "Language: zh\n\n"
        "NOTE 这是注释块，应被忽略\n\n"
        "00:03.500 --> 00:08.000 align:start position:0%\n"
        "<c.color>第一段</c> <00:05.000>内容说明\n\n"
        "01:10.200 --> 01:15.000\n"
        "第二段关键结论\n"
    )
    path = tmp_path / "demo.vtt"
    path.write_text(vtt_content, encoding="utf-8")

    result = parse_subtitle_file(path)
    assert len(result.segments) == 2
    assert result.segments[0].start == pytest.approx(3.5)
    assert result.segments[0].end == pytest.approx(8.0)
    assert result.segments[0].text == "第一段 内容说明"
    assert result.segments[1].start == pytest.approx(70.2)
    assert result.segments[1].text == "第二段关键结论"


def test_parse_gbk_encoded_srt(tmp_path):
    from app.domains.ingestion.subtitle_parser import parse_subtitle_file

    srt_content = (
        "1\n"
        "00:00:00,000 --> 00:00:03,000\n"
        "这是 GBK 编码的中文字幕测试\n"
    )
    path = tmp_path / "gbk_sub.srt"
    path.write_bytes(srt_content.encode("gbk"))

    result = parse_subtitle_file(path)
    assert len(result.segments) == 1
    assert result.segments[0].text == "这是 GBK 编码的中文字幕测试"


def test_parse_invalid_timestamp_raises_clear_error(tmp_path):
    from app.domains.ingestion.subtitle_parser import parse_subtitle_file

    bad = tmp_path / "bad.srt"
    bad.write_text("1\n00:00:10,000 --> 00:00:05,000\n倒置时间\n", encoding="utf-8")
    with pytest.raises(ValueError, match="时间戳"):
        parse_subtitle_file(bad)

    malformed = tmp_path / "malformed.srt"
    malformed.write_text("1\n99:xx:00,000 --> 00:01:00,000\n非法格式\n", encoding="utf-8")
    with pytest.raises(ValueError, match="时间戳"):
        parse_subtitle_file(malformed)


def test_pipeline_runner_skips_acquire_and_transcribe_for_subtitle_file(tmp_path):
    srt_path = tmp_path / "course.srt"
    srt_path.write_text(
        "1\n00:00:01,000 --> 00:00:05,000\n零下载零转写直接蒸馏测试。\n",
        encoding="utf-8",
    )

    called = {"acquire": 0, "transcribe": 0, "synthesize": 0, "persist": 0}

    def _acquire(_ctx):
        called["acquire"] += 1
        raise AssertionError("字幕直出不应调用 acquire_media")

    def _transcribe(_ctx):
        called["transcribe"] += 1
        raise AssertionError("字幕直出不应调用 transcribe")

    def _synthesize(ctx):
        called["synthesize"] += 1
        assert ctx.transcript is not None
        assert len(ctx.transcript.segments) == 1
        return f"# 笔记\n{ctx.transcript.full_text}"

    def _persist(ctx):
        called["persist"] += 1
        return {"saved": True, "note": ctx.note}

    runner = PipelineRunner(
        acquire_media=_acquire,
        transcribe=_transcribe,
        synthesize_note=_synthesize,
        persist_note=_persist,
    )
    ctx = PipelineContext(task_id="sub-task-1", platform="local", subtitle_path=str(srt_path))
    out = runner.run(ctx)

    assert out["saved"] is True
    assert "零下载零转写直接蒸馏测试" in out["note"]
    assert called == {"acquire": 0, "transcribe": 0, "synthesize": 1, "persist": 1}
