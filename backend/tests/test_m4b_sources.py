"""Milestone 4B 单元测试：小宇宙播客、通用网页技术文章、本地 PDF/MD/TXT 直出。"""

from __future__ import annotations

import json
import sys
import zlib
from pathlib import Path
from types import SimpleNamespace

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))


def _build_minimal_pdf(text: str) -> bytes:
    """构造一个标准的、包含 FlateDecode 压缩文本流的最小 PDF（纯字节，无三方依赖）。"""
    stream_plain = f"BT /F1 12 Tf 72 720 Td ({text}) Tj ET".encode("latin-1")
    compressed = zlib.compress(stream_plain)

    objects = [
        b"1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n",
        b"2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n",
        b"3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj\n",
        (
            f"4 0 obj << /Length {len(compressed)} /Filter /FlateDecode >>\nstream\n".encode("ascii")
            + compressed
            + b"\nendstream\nendobj\n"
        ),
        b"5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n",
    ]

    buf = bytearray(b"%PDF-1.4\n")
    offsets = [0]
    for obj in objects:
        offsets.append(len(buf))
        buf.extend(obj)
    xref_pos = len(buf)
    buf.extend(f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode("ascii"))
    for off in offsets[1:]:
        buf.extend(f"{off:010d} 00000 n \n".encode("ascii"))
    buf.extend(
        f"trailer << /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref_pos}\n%%EOF\n".encode("ascii")
    )
    return bytes(buf)


# ---------------- 1. URL 识别与校验 ----------------


def test_xiaoyuzhou_and_web_url_detection_and_validation():
    from app.utils.url_parser import detect_video_platform, extract_video_id, normalize_video_url
    from app.validators.video_url_validator import is_supported_video_url

    xyz_raw = "听这期播客 https://m.xiaoyuzhoufm.com/episode/67a1b2c3d4e5f6a7b8c9d0e1?utm_source=share 很赞"
    assert detect_video_platform(xyz_raw) == "xiaoyuzhou"
    assert normalize_video_url(xyz_raw) == "https://www.xiaoyuzhoufm.com/episode/67a1b2c3d4e5f6a7b8c9d0e1"
    assert extract_video_id(xyz_raw, "xiaoyuzhou") == "67a1b2c3d4e5f6a7b8c9d0e1"
    assert is_supported_video_url(xyz_raw) is True
    # 播客主页不是单集，应拒绝
    assert is_supported_video_url("https://www.xiaoyuzhoufm.com/podcast/62382c1103bea1ebfffa1c00") is False

    # 通用网页技术文章
    blog_url = "https://simonwillison.net/2025/Mar/11/using-llms-for-code/?utm_source=hn"
    assert detect_video_platform(blog_url) == "web"
    assert normalize_video_url(blog_url) == "https://simonwillison.net/2025/Mar/11/using-llms-for-code/"
    assert len(extract_video_id(blog_url, "web") or "") == 16
    assert is_supported_video_url(blog_url) is True
    assert is_supported_video_url("https://mp.weixin.qq.com/s/abcdef123456") is True
    assert is_supported_video_url("https://github.com/fastapi/fastapi") is True

    # 安全边界：私有地址、回环地址、无 BV 的 B 站页面必须保持拒绝
    assert detect_video_platform("http://127.0.0.1:8080/secret") is None
    assert is_supported_video_url("http://127.0.0.1:8080/secret") is False
    assert is_supported_video_url("http://192.168.1.10/internal") is False
    assert is_supported_video_url("http://localhost:3000/test") is False
    assert is_supported_video_url("https://www.bilibili.com/anime/timeline") is False


def test_constant_registers_xiaoyuzhou_and_web_lazily():
    from app.services.constant import SUPPORT_PLATFORM_MAP

    assert "xiaoyuzhou" in SUPPORT_PLATFORM_MAP
    assert "web" in SUPPORT_PLATFORM_MAP


def test_note_helper_replaces_xiaoyuzhou_content_marker():
    from app.utils.note_helper import replace_content_markers

    out = replace_content_markers("关键结论 Content-03:15", "67a1b2c3d4e5f6a7b8c9d0e1", platform="xiaoyuzhou")
    assert "https://www.xiaoyuzhoufm.com/episode/67a1b2c3d4e5f6a7b8c9d0e1" in out


# ---------------- 2. 小宇宙播客解析与下载 ----------------


def test_parse_xiaoyuzhou_next_data_and_og_fallback():
    from app.downloaders.xiaoyuzhoufm_download import (
        build_xiaoyuzhou_post_context,
        parse_xiaoyuzhou_episode_html,
    )

    next_payload = {
        "props": {
            "pageProps": {
                "episode": {
                    "title": "Vol.42 系统架构演进复盘",
                    "duration": 1845,
                    "enclosure": {"url": "https://media.xyzcdn.net/audio/ep42.m4a"},
                    "image": {"largePicUrl": "https://image.xyzcdn.net/cover42.jpg"},
                    "podcast": {"title": "架构漫谈", "author": "主持人A"},
                    "shownotes": "<p>00:00 开场介绍</p><p>12:30 <b>核心取舍</b>与压测数据</p>",
                }
            }
        }
    }
    html_doc = f'<html><body><script id="__NEXT_DATA__" type="application/json">{json.dumps(next_payload, ensure_ascii=False)}</script></body></html>'
    parsed = parse_xiaoyuzhou_episode_html(html_doc, "https://www.xiaoyuzhoufm.com/episode/ep42")
    assert parsed["title"] == "Vol.42 系统架构演进复盘"
    assert parsed["audio_url"] == "https://media.xyzcdn.net/audio/ep42.m4a"
    assert parsed["duration"] == pytest.approx(1845.0)
    assert parsed["cover_url"] == "https://image.xyzcdn.net/cover42.jpg"
    assert parsed["uploader"] == "架构漫谈"
    assert "核心取舍与压测数据" in parsed["shownotes"]

    ctx = build_xiaoyuzhou_post_context(parsed)
    assert "播客节目：架构漫谈" in ctx
    assert "单集 Shownotes" in ctx

    # OG meta 回退
    og_html = """
    <html><head>
      <meta property="og:title" content="单集标题B - 小宇宙" />
      <meta property="og:audio" content="https://media.xyzcdn.net/fallback.mp3" />
      <meta property="og:image" content="https://image.xyzcdn.net/fallback.jpg" />
      <meta property="og:description" content="这是一段简介" />
    </head></html>
    """
    fallback = parse_xiaoyuzhou_episode_html(og_html, "https://www.xiaoyuzhoufm.com/episode/ep99")
    assert fallback["title"] == "单集标题B"
    assert fallback["audio_url"] == "https://media.xyzcdn.net/fallback.mp3"
    assert fallback["cover_url"] == "https://image.xyzcdn.net/fallback.jpg"


def test_xiaoyuzhou_downloader_skip_download_and_audio_download(tmp_path, monkeypatch):
    from app.downloaders import xiaoyuzhoufm_download as xyz_mod

    fake_episode = {
        "episode_id": "ep100",
        "webpage_url": "https://www.xiaoyuzhoufm.com/episode/ep100",
        "title": "测试播客单集",
        "audio_url": "https://media.xyzcdn.net/ep100.m4a",
        "cover_url": "https://image.xyzcdn.net/ep100.jpg",
        "duration": 620.0,
        "podcast_title": "测试频道",
        "author": "主播",
        "uploader": "测试频道",
        "shownotes": "第 1 部分：核心概念",
    }
    monkeypatch.setattr(xyz_mod, "fetch_xiaoyuzhou_episode", lambda url: fake_episode)

    dl = xyz_mod.XiaoyuzhouDownloader()
    assert dl.download_video("https://www.xiaoyuzhoufm.com/episode/ep100") is None

    meta_only = dl.download("https://www.xiaoyuzhoufm.com/episode/ep100", skip_download=True)
    assert meta_only.platform == "xiaoyuzhou"
    assert meta_only.file_path == ""
    assert meta_only.raw_info["media_kind"] == "audio"
    assert "测试频道" in meta_only.raw_info["post_context"]

    # 模拟流式音频下载
    class _FakeResp:
        status_code = 200
        headers = {"Content-Type": "audio/mp4"}

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def iter_content(self, chunk_size=65536):
            yield b"FAKE_M4A_AUDIO_BYTES_123456"

    import requests

    monkeypatch.setattr(requests, "get", lambda *a, **kw: _FakeResp())
    full = dl.download("https://www.xiaoyuzhoufm.com/episode/ep100", output_dir=str(tmp_path))
    assert Path(full.file_path).is_file()
    assert Path(full.file_path).suffix == ".m4a"
    assert full.video_path is None
    assert full.raw_info["media_kind"] == "audio"


# ---------------- 3. 通用网页文章提取与下载器 ----------------


def test_extract_article_from_html_wechat_and_github():
    from app.services.web_page import extract_article_from_html

    wechat_html = """
    <html>
      <head>
        <meta property="og:title" content="深入理解连接池调优" />
        <meta name="author" content="技术号" />
      </head>
      <body>
        <nav>首页 关于</nav>
        <div id="js_content">
          <h2>一、核心公式</h2>
          <p>连接数上限推荐遵循 CPU 核数乘以 2 加 1 的基线，再结合数据库 RT 压测微调。</p>
          <pre><code class="language-sql">SHOW max_connections;</code></pre>
          <ul><li>避免空闲连接泄漏</li><li>配置合理的超时阈值</li></ul>
        </div>
        <footer>版权声明</footer>
      </body>
    </html>
    """
    res = extract_article_from_html(wechat_html, "https://mp.weixin.qq.com/s/test123")
    assert res["title"] == "深入理解连接池调优"
    assert res["author"] == "技术号"
    assert "## 一、核心公式" in res["text"]
    assert "```sql" in res["text"]
    assert "SHOW max_connections;" in res["text"]
    assert "版权声明" not in res["text"]

    pilcrow_html = "<html><body><h1>Features ¶</h1><article><p>FastAPI features overview and async design patterns for production services.</p></article></body></html>"
    res2 = extract_article_from_html(pilcrow_html, "https://fastapi.tiangolo.com/features/")
    assert res2["title"] == "Features"


def test_web_article_downloader_skips_transcribe_and_caches(monkeypatch):
    from app.downloaders import web_downloader as web_mod

    calls = {"count": 0}

    def _fake_read(url, use_proxy=True):
        calls["count"] += 1
        return {
            "url": url,
            "final_url": url,
            "title": "AsyncIO 实战指南",
            "author": "example.dev",
            "cover_url": "",
            "description": "讲解事件循环与背压控制",
            "text": "## 事件循环\n\n任务调度由单线程事件循环驱动。\n\n## 背压控制\n\n使用 Bounded Queue 防止内存暴涨。",
            "retained_length": 48,
            "truncated": False,
        }

    monkeypatch.setattr(web_mod, "read_article_page", _fake_read)
    dl = web_mod.WebArticleDownloader()
    url = "https://example.dev/posts/asyncio-guide"
    assert dl.is_text_post(url) is True
    assert dl.download_video(url) is None

    transcript = dl.download_subtitles(url)
    assert transcript is not None
    assert len(transcript.segments) >= 1
    assert "事件循环" in transcript.full_text

    meta = dl.download(url, skip_download=True)
    assert calls["count"] == 1  # 两次调用复用内存缓存，不重复抓网
    assert meta.platform == "web"
    assert meta.title == "AsyncIO 实战指南"
    assert meta.raw_info["media_kind"] == "text_post"
    assert meta.raw_info["source_kind"] == "web_article"


# ---------------- 4. 本地 PDF / Markdown / TXT 直出 ----------------


def test_parse_markdown_and_txt_documents(tmp_path):
    from app.domains.ingestion.document_parser import is_document_path, parse_document_file

    assert is_document_path("/uploads/abc.pdf") is True
    assert is_document_path("notes.MD") is True
    assert is_document_path("draft.txt") is True
    assert is_document_path("video.mp4") is False

    md_path = tmp_path / "design.md"
    md_path.write_bytes(
        "\ufeff# 分布式缓存架构\n\n缓存穿透可用布隆过滤器兜底。\n\n## 击穿防护\n\n热点 Key 使用互斥锁重建。".encode("utf-8")
    )
    transcript, meta = parse_document_file(md_path)
    assert meta["title"] == "分布式缓存架构"
    assert meta["document_type"] == "markdown"
    assert len(transcript.segments) >= 1
    assert "布隆过滤器" in transcript.full_text

    txt_path = tmp_path / "gbk_doc.txt"
    txt_path.write_bytes("这是 GB18030 编码的本地技术笔记正文。\n\n第二段包含核心结论。".encode("gb18030"))
    transcript2, meta2 = parse_document_file(txt_path, original_name="系统调优笔记.txt")
    assert meta2["title"] == "系统调优笔记"
    assert meta2["document_type"] == "txt"
    assert "核心结论" in transcript2.full_text


def test_parse_pdf_minimal_fallback_and_encrypted_rejection(tmp_path):
    from app.domains.ingestion.document_parser import parse_document_file

    pdf_path = tmp_path / "sample.pdf"
    pdf_path.write_bytes(_build_minimal_pdf("Hello BiliNote Studio PDF Pipeline 0.4.0"))

    transcript, meta = parse_document_file(pdf_path, original_name="ArchitectureGuide.pdf")
    assert meta["title"] == "ArchitectureGuide"
    assert meta["document_type"] == "pdf"
    assert meta["page_count"] == 1
    assert "Hello BiliNote Studio PDF Pipeline" in transcript.full_text

    # 加密 PDF 必须返回明确中文提示
    enc_pdf = tmp_path / "encrypted.pdf"
    enc_pdf.write_bytes(b"%PDF-1.4\n1 0 obj << /Encrypt 2 0 R >> endobj\n%%EOF\n")
    with pytest.raises(ValueError, match="加密"):
        parse_document_file(enc_pdf)


def test_local_downloader_handles_document_without_ffmpeg(tmp_path, monkeypatch):
    from app.downloaders.local_downloader import LocalDownloader
    from app.services.media_io import COVER_DOMAINS, UPLOAD_ALLOWED_SUFFIXES

    assert {".pdf", ".md", ".markdown", ".txt"}.issubset(UPLOAD_ALLOWED_SUFFIXES)
    assert "xyzcdn.net" in COVER_DOMAINS
    assert "xiaoyuzhoufm.com" in COVER_DOMAINS

    md_file = tmp_path / "study.md"
    md_file.write_text("# React 并发渲染笔记\n\n核心机制是可中断的 Fiber 调度。", encoding="utf-8")

    dl = LocalDownloader()
    # 确保不会调用 ffmpeg/ffprobe
    monkeypatch.setattr(dl, "_run", lambda *a, **kw: (_ for _ in ()).throw(AssertionError("本地文档不应调用 ffmpeg")))

    assert dl.is_text_post(str(md_file)) is True
    assert dl.download_video(str(md_file)) is None

    transcript = dl.download_subtitles(str(md_file))
    assert transcript is not None
    assert "Fiber 调度" in transcript.full_text

    audio_meta = dl.download(str(md_file), skip_download=True)
    assert audio_meta.platform == "local"
    assert audio_meta.title == "React 并发渲染笔记"
    assert audio_meta.video_path is None
    assert audio_meta.raw_info["media_kind"] == "text_post"
    assert audio_meta.raw_info["is_document"] is True


def test_no_agpl_pymupdf_dependency_in_document_parser():
    src = (BACKEND_DIR / "app" / "domains" / "ingestion" / "document_parser.py").read_text(encoding="utf-8")
    assert "import fitz" not in src
    assert "import pymupdf" not in src
