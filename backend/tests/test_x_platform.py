"""X (原 Twitter) 平台全形态支持与默认输出语言约束单元测试。"""

from __future__ import annotations

import base64
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from app.downloaders.x_downloader import (
    XDownloader,
    XPlatformError,
    build_text_post_transcript,
    build_x_post_context,
    classify_x_error,
    cookie_header_to_netscape,
    encode_local_image_data_url,
    fetch_x_post_payload,
    localize_x_images,
)
from app.gpt import prompt as prompt_mod
from app.gpt.prompt_builder import (
    generate_base_prompt,
    generate_knowledge_pass1_prompt,
    generate_structured_prompt,
)
from app.gpt.universal_gpt import UniversalGPT
from app.models.gpt_model import GPTSource
from app.models.notes_model import AudioDownloadResult
from app.models.transcriber_model import TranscriptResult, TranscriptSegment
from app.services.constant import SUPPORT_PLATFORM_MAP
from app.services.note import NoteGenerator
from app.utils.note_helper import replace_content_markers
from app.utils.url_parser import (
    detect_video_platform,
    extract_url_from_share_text,
    extract_video_id,
    normalize_video_url,
)
from app.validators.video_url_validator import VideoRequest, is_supported_video_url


# ---------------- URL 解析、清洗、校验与 YouTube t= 保护 ----------------


@pytest.mark.parametrize(
    "raw,expected_url,expected_id",
    [
        (
            "https://x.com/karpathy/status/1894099637218545984?s=20&t=abc123&ref_src=twsrc",
            "https://x.com/karpathy/status/1894099637218545984",
            "1894099637218545984",
        ),
        (
            "https://twitter.com/OpenAI/status/1758192957386342435/?s=46&t=xyz&ref_url=https%3A%2F%2Fa.b",
            "https://x.com/OpenAI/status/1758192957386342435",
            "1758192957386342435",
        ),
        (
            "https://mobile.twitter.com/elonmusk/statuses/1234567890123456789?s=20",
            "https://x.com/elonmusk/status/1234567890123456789",
            "1234567890123456789",
        ),
        (
            "https://fxtwitter.com/karpathy/status/1894099637218545984?t=123",
            "https://x.com/karpathy/status/1894099637218545984",
            "1894099637218545984",
        ),
        (
            "https://vxtwitter.com/karpathy/status/1894099637218545984",
            "https://x.com/karpathy/status/1894099637218545984",
            "1894099637218545984",
        ),
        (
            "https://fixupx.com/karpathy/article/1894099637218545999?s=20",
            "https://x.com/karpathy/article/1894099637218545999",
            "1894099637218545999",
        ),
        (
            "https://x.com/i/broadcasts/1OyKAVyYqvWGb?s=20",
            "https://x.com/i/broadcasts/1OyKAVyYqvWGb",
            "1OyKAVyYqvWGb",
        ),
        (
            "https://x.com/i/spaces/1vOxwMqAabBGB?s=20&t=test",
            "https://x.com/i/spaces/1vOxwMqAabBGB",
            "1vOxwMqAabBGB",
        ),
    ],
)
def test_x_url_detection_normalization_and_validation(raw, expected_url, expected_id):
    assert detect_video_platform(raw) == "x"
    assert normalize_video_url(raw) == expected_url
    assert extract_video_id(raw, "x") == expected_id
    assert is_supported_video_url(raw) is True


def test_x_tco_short_url_supported_and_share_text_extracts():
    raw = "看看这条很棒的帖子 https://t.co/AbCdEf1234 推荐！"
    cleaned = extract_url_from_share_text(raw)
    assert cleaned == "https://t.co/AbCdEf1234"
    assert detect_video_platform(raw) == "x"
    assert is_supported_video_url(cleaned) is True


def test_youtube_t_param_is_preserved():
    yt = "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=125s&si=trackme"
    cleaned = normalize_video_url(yt)
    assert "t=125s" in cleaned
    assert "si=" not in cleaned
    assert detect_video_platform(yt) == "youtube"


def test_video_request_detects_x_platform():
    req = VideoRequest(url="https://twitter.com/karpathy/status/1894099637218545984?s=20&t=abc")
    assert req.platform == "x"
    assert str(req.url) == "https://x.com/karpathy/status/1894099637218545984"


def test_replace_content_markers_for_x():
    md = "## 核心观点 *Content-[01:25]"
    replaced = replace_content_markers(md, video_id="1894099637218545984", platform="x")
    assert "[原片 @ 01:25](https://x.com/i/status/1894099637218545984)" in replaced


def test_support_platform_map_registers_x_lazily():
    assert "x" in SUPPORT_PLATFORM_MAP


def test_media_io_cover_domains_allows_twimg():
    from app.services.media_io import COVER_DOMAINS

    assert "twimg.com" in COVER_DOMAINS


# ---------------- Cookie 转换与错误分类 ----------------


def test_cookie_header_to_netscape_covers_both_domains():
    netscape = cookie_header_to_netscape("Cookie: auth_token=tok123; ct0=csrf456; guest_id=v1")
    assert netscape.startswith("# Netscape HTTP Cookie File")
    assert ".x.com\tTRUE\t/\tTRUE\t" in netscape
    assert ".twitter.com\tTRUE\t/\tTRUE\t" in netscape
    assert "auth_token\ttok123" in netscape
    assert "ct0\tcsrf456" in netscape


def test_classify_x_error_distinguishes_proxy_auth_and_404():
    proxy_msg = classify_x_error(RuntimeError("HTTPSConnectionPool: Read timed out."))
    assert "全局代理" in proxy_msg

    auth_msg = classify_x_error(RuntimeError("ERROR: NSFW tweet requires login required"))
    assert "平台凭据" in auth_msg and "Cookie" in auth_msg

    not_found_msg = classify_x_error(RuntimeError("HTTP Error 404: Tweet not found"))
    assert "不存在" in not_found_msg or "已删除" in not_found_msg

    no_video_msg = classify_x_error(RuntimeError("ERROR: [twitter] 1: No video could be found in this tweet"))
    assert "推文可能不存在" in no_video_msg and "Cookie" in no_video_msg


# ---------------- 纯图文 / X 长文提取与配图本地化 ----------------


def test_fetch_fxtwitter_text_and_article_payload_and_localize_images(tmp_path, monkeypatch):
    fake_json = {
        "code": 200,
        "tweet": {
            "id": "1894099637218545984",
            "url": "https://twitter.com/karpathy/status/1894099637218545984",
            "text": "Deep dive into LLM tokenization.\n\nSecond paragraph.",
            "author": {"name": "Andrej Karpathy", "screen_name": "karpathy"},
            "quote": {
                "text": "Tokenization is often the root of weird LLM behavior.",
                "author": {"screen_name": "someone"},
            },
            "article": {
                "title": "Tokenization Guide",
                "content": {"blocks": [{"text": "BPE merges frequent byte pairs."}]},
            },
            "media": {
                "photos": [{"url": "https://pbs.twimg.com/media/sample1.jpg"}],
                "videos": [],
            },
        },
    }

    fake_resp = MagicMock()
    fake_resp.status_code = 200
    fake_resp.json.return_value = fake_json

    with patch("app.downloaders.x_downloader.requests.get", return_value=fake_resp):
        payload = fetch_x_post_payload(
            "https://x.com/karpathy/status/1894099637218545984?s=20",
            proxy_url="http://127.0.0.1:7890",
        )

    assert payload["tweet_id"] == "1894099637218545984"
    assert payload["has_video"] is False
    assert payload["article_title"] == "Tokenization Guide"
    assert "BPE merges frequent byte pairs." in payload["article_text"]
    assert "@someone" in payload["quoted_tweet"]
    assert payload["images"] == ["https://pbs.twimg.com/media/sample1.jpg"]

    transcript = build_text_post_transcript(payload)
    assert transcript is not None
    assert len(transcript.segments) >= 4
    assert "BPE merges frequent byte pairs." in transcript.full_text

    # 配图本地化与 Data URL 编码（零 FFmpeg）
    tiny_png = base64.b64decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2mQAAAAASUVORK5CYII="
    )
    img_resp = MagicMock()
    img_resp.status_code = 200
    img_resp.headers = {"Content-Type": "image/png"}
    img_resp.iter_content.return_value = [tiny_png]

    monkeypatch.setenv("IMAGE_BASE_URL", "/static/screenshots")
    with patch("app.downloaders.x_downloader.requests.get", return_value=img_resp):
        localized = localize_x_images(
            payload["images"],
            payload["tweet_id"],
            output_dir=tmp_path,
            proxy_url="http://127.0.0.1:7890",
        )

    assert len(localized) == 1
    assert localized[0]["web_url"] == "/static/screenshots/x_1894099637218545984_1.png"
    assert Path(localized[0]["local_path"]).is_file()

    data_url = encode_local_image_data_url(localized[0]["local_path"])
    assert data_url is not None and data_url.startswith("data:image/")


def test_x_downloader_text_post_skips_ytdlp_and_returns_text_post_meta(tmp_path):
    downloader = XDownloader()
    fake_payload = {
        "tweet_id": "1900000000000000001",
        "author": "Alice (@alice)",
        "author_handle": "alice",
        "title": "@alice: Short technical post",
        "text": "Always bound retries and set timeouts.",
        "quoted_tweet": "",
        "article_title": "",
        "article_text": "",
        "media_type": "text_image",
        "has_video": False,
        "has_audio": False,
        "duration": 0,
        "images": [],
        "cover_url": "",
        "canonical_url": "https://x.com/alice/status/1900000000000000001",
    }

    with patch.object(downloader, "_get_payload", return_value=fake_payload):
        sub = downloader.download_subtitles("https://x.com/alice/status/1900000000000000001")
        assert sub is not None
        assert "Always bound retries" in sub.full_text

        assert downloader.download_video("https://x.com/alice/status/1900000000000000001") == ""

        meta = downloader.download(
            "https://x.com/alice/status/1900000000000000001",
            output_dir=str(tmp_path),
            skip_download=True,
        )
        assert meta.platform == "x"
        assert meta.file_path == ""
        assert meta.raw_info["media_kind"] == "text_post"
        assert "Always bound retries" in meta.raw_info["post_context"]


def test_note_generator_inserts_local_post_images_without_ffmpeg():
    doc = {
        "schema_version": 1,
        "note_style": "knowledge",
        "title": "X 图文笔记",
        "sections": [
            {
                "id": "sec-1",
                "title": "核心要点",
                "level": 2,
                "time_ranges": [],
                "core_takeaways": [],
                "blocks": [
                    {"type": "paragraph", "spans": [{"text": "测试正文", "emphasis": "plain"}]},
                    {"type": "screenshot", "timestamp": 0, "label": "00:00", "caption": "架构图", "image_url": ""},
                ],
                "annotations": [],
                "quiz": None,
            }
        ],
    }
    local_images = [
        {"web_url": "/static/screenshots/x_123_1.png", "caption": "推文配图 1"},
        {"web_url": "/static/screenshots/x_123_2.png", "caption": "推文配图 2"},
    ]
    out = NoteGenerator._insert_local_post_images(doc, local_images)
    blocks = out["sections"][0]["blocks"]
    shots = [b for b in blocks if b["type"] == "screenshot"]
    assert len(shots) == 2
    assert shots[0]["image_url"] == "/static/screenshots/x_123_1.png"
    assert shots[0]["caption"] == "架构图"
    assert shots[1]["image_url"] == "/static/screenshots/x_123_2.png"


# ---------------- 默认简体中文输出语言约束 ----------------


def test_prompts_enforce_default_simplified_chinese_and_allow_source_mode():
    zh_structured = generate_structured_prompt("English Title", "00:00 - Hello world", [], style="knowledge")
    assert "简体中文" in zh_structured
    assert "保留原文" in zh_structured

    src_structured = generate_structured_prompt(
        "English Title", "00:00 - Hello world", [], style="knowledge", output_language="source"
    )
    assert "跟随原始素材的主要语言" in src_structured

    pass1 = generate_knowledge_pass1_prompt("English Title", "00:00 - Hello", [])
    assert "简体中文" in pass1

    base = generate_base_prompt("English Title", "00:00 - Hello", [], post_context="原帖补充说明")
    assert "简体中文" in base
    assert "原帖补充说明" in base

    assert "简体中文" in prompt_mod.KNOWLEDGE_CONSOLIDATE_PASS2_INSTRUCTIONS
    assert "简体中文" in prompt_mod.KNOWLEDGE_CARD_BATCH_MERGE_INSTRUCTIONS
    assert "简体中文" in prompt_mod.TUTORIAL_STRUCTURED_MERGE_INSTRUCTIONS


def test_universal_gpt_signature_changes_with_output_language_and_post_context():
    gpt = UniversalGPT(client=MagicMock(), model="gpt-4o-mini")
    segs = [TranscriptSegment(start=0.0, end=5.0, text="Hello world")]
    s_zh = GPTSource(segment=segs, title="T", tags=[], structured=True, output_language="zh-CN")
    s_src = GPTSource(segment=segs, title="T", tags=[], structured=True, output_language="source")
    s_ctx = GPTSource(segment=segs, title="T", tags=[], structured=True, output_language="zh-CN", post_context="Extra tweet text")

    assert gpt._build_source_signature(s_zh) != gpt._build_source_signature(s_src)
    assert gpt._build_source_signature(s_zh) != gpt._build_source_signature(s_ctx)


# ---------------- 多视频 / 引用视频推文解包与无缝拼接 ----------------


def test_fxtwitter_detects_self_quote_video_and_quote_only_video():
    self_quote_resp = MagicMock()
    self_quote_resp.status_code = 200
    self_quote_resp.json.return_value = {
        "code": 200,
        "tweet": {
            "id": "2124337321550164041",
            "url": "https://x.com/qihang_zeng6688/status/2124337321550164041",
            "text": "主推文观点",
            "author": {"name": "启航", "screen_name": "qihang_zeng6688"},
            "media": {"videos": [{"duration": 84, "thumbnail_url": "https://pbs.twimg.com/v1.jpg"}]},
            "quote": {
                "text": "引用前一篇",
                "author": {"screen_name": "qihang_zeng6688"},
                "media": {"videos": [{"duration": 26, "thumbnail_url": "https://pbs.twimg.com/v2.jpg"}]},
            },
        },
    }
    with patch("app.downloaders.x_downloader.requests.get", return_value=self_quote_resp):
        payload = fetch_x_post_payload("https://x.com/qihang_zeng6688/status/2124337321550164041")
    assert payload["has_video"] is True
    assert payload["main_has_video"] is True
    assert payload["quote_has_video"] is True
    assert payload["is_self_quote"] is True
    assert payload["quote_video_duration"] == 26

    # 主推文纯点评文字 + 引用推文带视频：自动识别为有视频
    quote_only_resp = MagicMock()
    quote_only_resp.status_code = 200
    quote_only_resp.json.return_value = {
        "code": 200,
        "tweet": {
            "id": "2200000000000000001",
            "url": "https://x.com/alice/status/2200000000000000001",
            "text": "强烈推荐看这段访谈！",
            "author": {"name": "Alice", "screen_name": "alice"},
            "media": {"videos": [], "photos": []},
            "quote": {
                "text": "原访谈视频",
                "author": {"screen_name": "bob"},
                "media": {"videos": [{"duration": 65, "thumbnail_url": "https://pbs.twimg.com/q.jpg"}]},
            },
        },
    }
    with patch("app.downloaders.x_downloader.requests.get", return_value=quote_only_resp):
        q_payload = fetch_x_post_payload("https://x.com/alice/status/2200000000000000001")
    assert q_payload["has_video"] is True
    assert q_payload["main_has_video"] is False
    assert q_payload["quote_has_video"] is True
    assert q_payload["duration"] == 65


def test_x_downloader_playlist_multi_video_concat_and_audio_reuse(tmp_path):
    downloader = XDownloader()
    tweet_id = "2124337321550164041"
    part1 = tmp_path / f"x_{tweet_id}_vpart_00001_2124327471894110208.mp4"
    part2 = tmp_path / f"x_{tweet_id}_vpart_00002_2123899543716511744.mp4"
    part1.write_bytes(b"mp4-part-1")
    part2.write_bytes(b"mp4-part-2")

    fake_payload = {
        "tweet_id": tweet_id,
        "author": "启航 (@qihang_zeng6688)",
        "author_handle": "qihang_zeng6688",
        "title": "@qihang_zeng6688: 双视频测试",
        "text": "主推文正文",
        "quoted_tweet": "@qihang_zeng6688: 引用推文正文",
        "quote_author_handle": "qihang_zeng6688",
        "is_self_quote": True,
        "main_has_video": True,
        "main_video_count": 1,
        "quote_has_video": True,
        "quote_video_duration": 26,
        "article_title": "",
        "article_text": "",
        "media_type": "video",
        "has_video": True,
        "has_audio": False,
        "duration": 84,
        "images": [],
        "cover_url": "",
        "canonical_url": f"https://x.com/qihang_zeng6688/status/{tweet_id}",
    }

    fake_playlist_info = {
        "_type": "playlist",
        "id": tweet_id,
        "entries": [
            {
                "id": "2124327471894110208",
                "ext": "mp4",
                "duration": 83.6,
                "requested_downloads": [{"filepath": str(part1)}],
            },
            {
                "id": "2123899543716511744",
                "ext": "mp4",
                "duration": 25.8,
                "requested_downloads": [{"filepath": str(part2)}],
            },
        ],
    }

    class FakeYDL:
        def __init__(self, opts):
            self.opts = opts

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def extract_info(self, url, download=True):
            return fake_playlist_info

    def fake_concat(clip_items, target_path):
        Path(target_path).write_bytes(b"merged-mp4-data")
        return True, [
            {"index": 1, "label": "主推文视频", "start": 0.0, "end": 83.6, "duration": 83.6},
            {"index": 2, "label": "引用推文视频", "start": 83.6, "end": 109.4, "duration": 25.8},
        ]

    def fake_extract_audio(video_path, target_audio_path):
        Path(target_audio_path).write_bytes(b"extracted-m4a")
        return target_audio_path

    with patch.object(downloader, "_get_payload", return_value=fake_payload), \
         patch("yt_dlp.YoutubeDL", FakeYDL), \
         patch("app.downloaders.x_downloader._concat_video_clips", side_effect=fake_concat), \
         patch("app.downloaders.x_downloader._extract_audio_from_video", side_effect=fake_extract_audio), \
         patch("app.downloaders.x_downloader._probe_media_info", return_value={"duration": 109.4, "width": 1280, "height": 720, "has_video": True, "has_audio": True}):
        merged_video = downloader.download_video(fake_payload["canonical_url"], output_dir=str(tmp_path))
        assert Path(merged_video).name == f"x_{tweet_id}.mp4"
        assert Path(merged_video).is_file()
        # 临时分片已清理
        assert not part1.exists() and not part2.exists()

        # 紧接着 download() 复用已拼接 MP4 零网络抽音轨并带入片段时间分界
        audio_res = downloader.download(fake_payload["canonical_url"], output_dir=str(tmp_path), need_video=True)
        assert Path(audio_res.file_path).name == f"x_{tweet_id}_audio.m4a"
        assert audio_res.duration == 109
        assert audio_res.video_path == merged_video
        assert "00:00-01:24 主推文视频" in audio_res.raw_info["post_context"]
        assert "01:24-01:49 引用推文视频" in audio_res.raw_info["post_context"]
        assert len(audio_res.raw_info["concat_segments"]) == 2


def test_x_downloader_playlist_over_limit_falls_back_to_primary_clip(tmp_path):
    downloader = XDownloader()
    tweet_id = "2124337321550999999"
    part1 = tmp_path / f"x_{tweet_id}_vpart_00001_111.mp4"
    part2 = tmp_path / f"x_{tweet_id}_vpart_00002_222.mp4"
    part1.write_bytes(b"primary-long-video")
    part2.write_bytes(b"secondary-long-video")

    fake_payload = {
        "tweet_id": tweet_id,
        "author": "A (@a)",
        "author_handle": "a",
        "title": "超长双视频降级测试",
        "text": "主推文",
        "quoted_tweet": "@b: 外部长视频",
        "quote_author_handle": "b",
        "is_self_quote": False,
        "main_has_video": True,
        "main_video_count": 1,
        "quote_has_video": True,
        "quote_video_duration": 0,
        "article_title": "",
        "article_text": "",
        "media_type": "video",
        "has_video": True,
        "has_audio": False,
        "duration": 500,
        "images": [],
        "cover_url": "",
        "canonical_url": f"https://x.com/a/status/{tweet_id}",
    }
    fake_info = {
        "_type": "playlist",
        "id": tweet_id,
        "entries": [
            {"id": "111", "ext": "mp4", "duration": 500, "requested_downloads": [{"filepath": str(part1)}]},
            {"id": "222", "ext": "mp4", "duration": 300, "requested_downloads": [{"filepath": str(part2)}]},
        ],
    }

    class FakeYDL:
        def __init__(self, opts):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def extract_info(self, url, download=True):
            return fake_info

    with patch.object(downloader, "_get_payload", return_value=fake_payload), \
         patch("yt_dlp.YoutubeDL", FakeYDL), \
         patch("app.downloaders.x_downloader._concat_video_clips") as concat_mock:
        video_fp = downloader.download_video(fake_payload["canonical_url"], output_dir=str(tmp_path))
        concat_mock.assert_not_called()
        assert Path(video_fp).name == f"x_{tweet_id}.mp4"
        assert Path(video_fp).read_bytes() == b"primary-long-video"
        assert not part2.exists()


# ---------------- 外语字幕自动检测与批量翻译 ----------------


def test_transcript_translator_detects_foreign_and_translates_batch():
    from app.services.transcript_translator import (
        maybe_auto_translate_transcript,
        needs_zh_translation,
        translate_segments_with_gpt,
    )

    en_segs = [
        TranscriptSegment(start=0.0, end=4.0, text="Shipping every feature you think of hurts user experience."),
        TranscriptSegment(start=4.0, end=8.5, text="Always ask the agent to explain back in its own words."),
    ]
    zh_segs = [
        TranscriptSegment(start=0.0, end=4.0, text="开发速度再快，也不能把想到的功能全上线。"),
    ]
    assert needs_zh_translation(en_segs, "en") is True
    assert needs_zh_translation(zh_segs, "zh") is False

    fake_gpt = MagicMock()
    fake_gpt.model = "gemini-4-argon"
    fake_choice = MagicMock()
    fake_choice.message.content = '{"0": "把想到的每个功能都上线会伤害用户体验。", "1": "总是让 Agent 用自己的话复述一遍。"}'
    fake_gpt.client.chat.completions.create.return_value = MagicMock(choices=[fake_choice])

    translated = translate_segments_with_gpt(en_segs, fake_gpt)
    assert translated[0]["translated_text"] == "把想到的每个功能都上线会伤害用户体验。"
    assert translated[1]["translated_text"] == "总是让 Agent 用自己的话复述一遍。"

    tr_obj = TranscriptResult(language="en", full_text="...", segments=en_segs)
    assert maybe_auto_translate_transcript(tr_obj, fake_gpt, output_language="zh-CN") is True
    assert tr_obj.segments[0].translated_text == "把想到的每个功能都上线会伤害用户体验。"
    # source 模式不强制翻译
    tr_src = TranscriptResult(language="en", full_text="...", segments=[TranscriptSegment(start=0, end=2, text="Hello world from podcast")])
    assert maybe_auto_translate_transcript(tr_src, fake_gpt, output_language="source") is False
    assert tr_src.segments[0].translated_text is None


def test_translate_note_captions_persists_to_disk_and_respects_dedicated_purpose(tmp_path, monkeypatch):
    from app.services import note_storage, purpose_preferences
    from app.services.transcript_translator import translate_note_captions

    monkeypatch.setattr(note_storage, "ROOT", tmp_path / "note_results")
    monkeypatch.setenv("PURPOSE_PREFERENCES_FILE", str(tmp_path / "data" / "purpose_preferences.json"))

    task_id = "11111111-2222-3333-4444-555555555555"
    note_storage.save_task({
        "id": task_id,
        "status": "SUCCESS",
        "markdown": "# Test note",
        "audioMeta": {"title": "English Talk", "platform": "x", "video_id": "123"},
        "formData": {"provider_id": "main-prov", "model_name": "main-model"},
        "transcript": {
            "language": "English",
            "full_text": "Hello world from test video.",
            "segments": [
                {"start": 0.0, "end": 4.2, "text": "Hello world from test video."},
                {"start": 4.2, "end": 8.0, "text": "Always build with care and taste."},
            ],
        },
    })

    # 1. 配置专用翻译模型（例如免费/轻量模型）
    prefs = purpose_preferences.update_purpose_preferences({
        "translation": {"provider_id": "free-prov", "model_name": "gemini-flash-free"},
    })
    assert prefs["translation"] == {"provider_id": "free-prov", "model_name": "gemini-flash-free"}

    called_with = []
    fake_gpt = MagicMock()
    fake_gpt.model = "gemini-flash-free"
    fake_choice = MagicMock()
    fake_choice.message.content = '{"0": "来自测试视频的问候。", "1": "始终怀着用心和品味去打造产品。"}'
    fake_gpt.client.chat.completions.create.return_value = MagicMock(choices=[fake_choice])

    def fake_build(pid, mname):
        called_with.append((pid, mname))
        return fake_gpt, pid, mname

    with patch("app.services.transcript_translator._build_gpt_from_selection", side_effect=fake_build):
        res = translate_note_captions(task_id)

    assert res["translated"] is True
    assert res["cached"] is False
    assert res["model_name"] == "gemini-flash-free"
    assert called_with[0] == ("free-prov", "gemini-flash-free")

    # 2. 校验已原子持久化落盘，且二次调用直接命中缓存不再调模型
    reloaded = note_storage.get_task(task_id)
    assert reloaded["transcript"]["segments"][0]["translated_text"] == "来自测试视频的问候。"
    assert reloaded["transcript"]["segments"][1]["translated_text"] == "始终怀着用心和品味去打造产品。"

    cached_res = translate_note_captions(task_id)
    assert cached_res["cached"] is True
    assert fake_gpt.client.chat.completions.create.call_count == 1

    # 3. 清除专用翻译模型后（None）自动回退跟随主模型
    cleared = purpose_preferences.update_purpose_preferences({"translation": None})
    assert cleared["translation"] is None
    called_with.clear()
    with patch("app.services.transcript_translator._build_gpt_from_selection", side_effect=fake_build):
        res_primary = translate_note_captions(task_id, force=True)
    assert res_primary["model_name"] == "main-model"
    assert called_with[0] == ("main-prov", "main-model")


def test_translate_partial_cache_incremental_fill_and_max_tokens(tmp_path, monkeypatch):
    from app.services import note_storage
    from app.services.transcript_translator import translate_note_captions

    monkeypatch.setattr(note_storage, "ROOT", tmp_path / "note_results")
    monkeypatch.setenv("PURPOSE_PREFERENCES_FILE", str(tmp_path / "data" / "purpose_preferences.json"))

    task_id = "22222222-3333-4444-5555-666666666666"
    note_storage.save_task({
        "id": task_id,
        "status": "SUCCESS",
        "markdown": "# Partial",
        "audioMeta": {"title": "Partial Test", "platform": "x", "video_id": "456"},
        "formData": {"provider_id": "p1", "model_name": "m1"},
        "transcript": {
            "language": "English",
            "full_text": "Line one. Line two.",
            "segments": [
                {"start": 0.0, "end": 3.0, "text": "Line one.", "translated_text": "第一句。"},
                {"start": 3.0, "end": 6.0, "text": "Line two."},
            ],
        },
    })

    seen_kwargs = []
    fake_gpt = MagicMock()
    fake_gpt.model = "m1"

    def fake_create(**kwargs):
        seen_kwargs.append(kwargs)
        choice = MagicMock()
        # 仅当输入包含 index 1 时返回补译；force 重译时返回两句新译文
        prompt_text = kwargs["messages"][0]["content"]
        if '"0":' in prompt_text:
            choice.message.content = '{"0": "新第一句。", "1": "新第二句。"}'
        else:
            choice.message.content = '{"1": "补译第二句。"}'
        return MagicMock(choices=[choice])

    fake_gpt.client.chat.completions.create.side_effect = fake_create

    with patch("app.services.transcript_translator._build_gpt_from_selection", return_value=(fake_gpt, "p1", "m1")):
        # 半残缓存不应命中 cached=True，而是增量补译 index 1
        res_fill = translate_note_captions(task_id)
        assert res_fill["cached"] is False
        assert res_fill["missing_count"] == 0
        assert res_fill["segments"][0]["translated_text"] == "第一句。"
        assert res_fill["segments"][1]["translated_text"] == "补译第二句。"
        assert seen_kwargs[0].get("max_tokens", 0) >= 4096

        # 全部译完后再次调用才真正命中缓存
        res_cached = translate_note_captions(task_id)
        assert res_cached["cached"] is True
        assert len(seen_kwargs) == 1

        # force=True 强制重译全部句子
        res_force = translate_note_captions(task_id, force=True)
        assert res_force["cached"] is False
        assert res_force["segments"][0]["translated_text"] == "新第一句。"
        assert res_force["segments"][1]["translated_text"] == "新第二句。"


def test_temp_media_cleanup_includes_clips_json_sidecar(tmp_path, monkeypatch):
    from app.services import system_maintenance

    data_dir = tmp_path / "data"
    uploads_dir = data_dir / "uploads"
    uploads_dir.mkdir(parents=True)

    mp4 = data_dir / "x_999.mp4"
    sidecar = data_dir / "x_999.clips.json"
    keep_json = data_dir / "purpose_preferences.json"
    keep_upload = uploads_dir / "user.clips.json"

    mp4.write_bytes(b"video-bytes")
    sidecar.write_text('{"segments": []}', encoding="utf-8")
    keep_json.write_text("{}", encoding="utf-8")
    keep_upload.write_text("{}", encoding="utf-8")

    monkeypatch.setenv("DATA_DIR", str(data_dir))
    found = set(system_maintenance._iter_temp_media_files(data_dir))
    assert mp4 in found
    assert sidecar in found
    assert keep_json not in found
    assert keep_upload not in found
