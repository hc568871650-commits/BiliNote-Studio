"""静态配图图文链路回归测试：覆盖生产者→分块器→模型消息→预算/413/截断→断点续传→落盘与模型对比。"""

from __future__ import annotations

import base64
import copy
import json
import os
from pathlib import Path
import struct
import tempfile
import types
import unittest
from unittest.mock import patch
import zlib

from app.gpt.request_chunker import RequestChunker
from app.gpt.universal_gpt import UniversalGPT
from app.models.gpt_model import GPTSource
from app.models.notes_model import AudioDownloadResult, NoteResult
from app.models.transcriber_model import TranscriptResult, TranscriptSegment
from app.services import generation_comparisons, note_storage
from app.services.note import NoteGenerator


def _make_png_bytes(r: int, g: int, b: int, width: int = 8, height: int = 8) -> bytes:
    """生成最小合法 RGB PNG 字节，不同颜色产生不同编码内容，零外部依赖。"""
    def _chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    row = b"\x00" + bytes([r, g, b]) * width
    raw = row * height
    return (
        b"\x89PNG\r\n\x1a\n"
        + _chunk(b"IHDR", ihdr)
        + _chunk(b"IDAT", zlib.compress(raw))
        + _chunk(b"IEND", b"")
    )


def _fake_response(content: str, finish_reason: str = "stop"):
    return types.SimpleNamespace(
        choices=[
            types.SimpleNamespace(
                finish_reason=finish_reason,
                message=types.SimpleNamespace(content=content, refusal=None),
            )
        ],
        usage=types.SimpleNamespace(prompt_tokens=120, completion_tokens=60, total_tokens=180),
    )


def _extract_images_and_text(messages: list[dict]) -> tuple[str, list[str]]:
    texts: list[str] = []
    images: list[str] = []
    for msg in messages:
        content = msg.get("content")
        if isinstance(content, str):
            texts.append(content)
        elif isinstance(content, list):
            for part in content:
                if not isinstance(part, dict):
                    continue
                if part.get("type") == "text":
                    texts.append(str(part.get("text") or ""))
                elif part.get("type") == "image_url":
                    images.append(str((part.get("image_url") or {}).get("url") or ""))
    return "\n".join(texts), images


def _bare_generator() -> NoteGenerator:
    gen = NoteGenerator.__new__(NoteGenerator)
    gen.video_path = None
    gen.video_img_urls = []
    gen.video_image_ranges = []
    gen.run_dir = None
    gen.frame_evidence = []
    gen.video_duration = 0
    return gen


def _make_stub_gpt(checkpoint_dir: Path, handler) -> tuple[UniversalGPT, list[list[dict]]]:
    calls: list[list[dict]] = []

    def create(**kwargs):
        msgs = copy.deepcopy(kwargs["messages"])
        calls.append(msgs)
        res = handler(len(calls), msgs)
        if isinstance(res, Exception):
            raise res
        return res

    client = types.SimpleNamespace(
        chat=types.SimpleNamespace(
            completions=types.SimpleNamespace(create=create)
        )
    )
    checkpoint_dir.mkdir(parents=True, exist_ok=True)
    gpt = UniversalGPT(client, model="mock-vision-model")
    gpt.checkpoint_dir = checkpoint_dir
    gpt._max_retry_attempts = 2
    gpt._retry_base_backoff = 0
    return gpt, calls


class StaticImagePipelineRegressionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="bilinote-static-img-reg-")
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve()

    def _create_static_images(self, directory: Path, count: int) -> list[dict]:
        directory.mkdir(parents=True, exist_ok=True)
        items = []
        for idx in range(1, count + 1):
            filename = f"x_static_{idx}.png"
            path = directory / filename
            path.write_bytes(_make_png_bytes((idx * 37) % 256, (idx * 73) % 256, (idx * 109) % 256))
            items.append({
                "local_path": str(path),
                "web_url": f"/static/screenshots/{filename}",
                "caption": f"原帖配图 {idx}",
            })
        return items

    def test_143_zero_timestamp_segments_and_6_static_images_messages_and_pass2_no_duplicate_images(self):
        img_dir = self.base / "static_imgs"
        local_images = self._create_static_images(img_dir, 6)

        gen = _bare_generator()
        gen._prepare_local_image_evidence(local_images)
        self.assertEqual(len(gen.video_img_urls), 6)
        self.assertIsNone(gen.video_image_ranges)

        # 构造 143 段零时间戳正文，总长 10,761 字（复现故障报告规模）
        segments = [
            TranscriptSegment(start=0.0, end=0.0, text=f"第{i:03d}段：" + ("核心机制分析与工程实践。" * 6)[:69])
            for i in range(1, 143)
        ]
        current_len = sum(len(s.text) for s in segments)
        segments.append(TranscriptSegment(start=0.0, end=0.0, text="末" * (10761 - current_len)))
        self.assertEqual(len(segments), 143)
        self.assertEqual(sum(len(s.text) for s in segments), 10761)

        source = GPTSource(
            segment=segments,
            title="X 长文多图实测",
            tags="",
            screenshot=True,
            link=False,
            style="knowledge",
            _format=["screenshot"],
            video_img_urls=list(gen.video_img_urls),
            video_image_ranges=gen.video_image_ranges,
            checkpoint_key="task-143-6",
            frame_evidence=[],
            structured=True,
        )

        def handler(call_idx, messages):
            text, imgs = _extract_images_and_text(messages)
            if imgs:
                return _fake_response(json.dumps({
                    "cards": [{
                        "topic": f"核心主题 {call_idx}",
                        "start": "00:00",
                        "end": "00:00",
                        "claims": [f"来自第 {call_idx} 批的提炼要点（含 {len(imgs)} 张图）"],
                    }]
                }, ensure_ascii=False))
            return _fake_response(json.dumps({
                "schema_version": 1,
                "note_style": "knowledge",
                "title": "X 长文多图实测",
                "sections": [{
                    "id": "sec-1",
                    "title": "核心结论",
                    "level": 2,
                    "time_ranges": [],
                    "core_takeaways": ["总结核心结论"],
                    "blocks": [
                        {"type": "paragraph", "spans": [{"text": "基于 143 段与 6 张原帖配图提炼。", "emphasis": "plain"}]},
                        {"type": "screenshot", "timestamp": 0, "label": "00:00", "caption": "架构总览", "image_url": ""},
                    ],
                    "annotations": [],
                    "quiz": None,
                }],
            }, ensure_ascii=False))

        gpt, calls = _make_stub_gpt(self.base / "checkpoints", handler)
        result_raw = gpt.summarize(source)
        parsed = json.loads(result_raw)
        self.assertEqual(parsed["title"], "X 长文多图实测")

        # 应有首轮分块提炼（>=2 轮）+ 最终合拢（最后 1 轮）
        self.assertGreaterEqual(len(calls), 3)
        pass1_calls = calls[:-1]
        pass2_call = calls[-1]

        pass1_images: list[str] = []
        for idx, msgs in enumerate(pass1_calls):
            txt, imgs = _extract_images_and_text(msgs)
            pass1_images.extend(imgs)
            # 静态图不应附带虚构的视频时间范围说明或截图候选定位资料
            self.assertNotIn("以下范围的 start/end 单位为秒", txt)
            self.assertNotIn("截图候选定位资料", txt)

        # 6 张静态图恰好在首轮提炼全部送入且无重复
        self.assertEqual(len(pass1_images), 6)
        self.assertEqual(pass1_images, gen.video_img_urls)

        # 合拢阶段绝不重复送图
        pass2_text, pass2_images = _extract_images_and_text(pass2_call)
        self.assertEqual(pass2_images, [])
        self.assertNotIn("以下范围的 start/end 单位为秒", pass2_text)
        self.assertFalse(gpt._checkpoint_path("task-143-6").exists())

    def test_small_budget_overflow_oversized_image_413_and_length_truncation_behavior(self):
        # 1) 小预算下静态图溢出到后续纯图块
        img_a = "data:image/jpeg;base64," + ("A" * 600)
        img_b = "data:image/jpeg;base64," + ("B" * 600)
        segs = [TranscriptSegment(start=0.0, end=0.0, text="正文" * 200)]

        gpt_overflow, calls_overflow = _make_stub_gpt(
            self.base / "ckpt_overflow",
            lambda idx, _m: _fake_response(f"第{idx}片完整输出"),
        )
        # 仅算文本和图片大小，精准构造预算使正文块装不下图片，但单图块可装下
        def compact_estimator(messages):
            txt, imgs = _extract_images_and_text(messages)
            return len(txt) + sum(len(u) for u in imgs)

        gpt_overflow._estimate_messages_bytes = compact_estimator
        # 测量无图单块大小，设置预算介于 max(正文块, 单图块) 与 (正文块 + 单图) 之间
        text_only_msg = gpt_overflow.create_messages(segs, title="溢出测试", tags="", _format=[], style="tutorial", extras="", video_img_urls=[])
        text_only_size = compact_estimator(text_only_msg)
        img_only_msg = gpt_overflow.create_messages([], title="溢出测试", tags="", _format=[], style="tutorial", extras="", video_img_urls=[img_a])
        img_only_size = compact_estimator(img_only_msg)
        gpt_overflow.max_request_bytes = max(text_only_size, img_only_size) + 50
        gpt_overflow.max_chunk_text_chars = 8000

        src_overflow = GPTSource(
            segment=segs, title="溢出测试", tags="", _format=[], style="tutorial",
            video_img_urls=[img_a, img_b], video_image_ranges=None,
            checkpoint_key="overflow-key", structured=False,
        )
        gpt_overflow.summarize(src_overflow)
        # 首轮请求中应能观察到纯图块（前 3 次中至少有带图块与纯文本块，且两图均送达）
        sent_images = [img for msgs in calls_overflow for img in _extract_images_and_text(msgs)[1]]
        self.assertEqual(sent_images, [img_a, img_b])
        image_batches = [len(_extract_images_and_text(msgs)[1]) for msgs in calls_overflow]
        self.assertIn(0, image_batches)
        self.assertEqual(image_batches.count(1), 2)

        # 2) 单张静态图本身超预算 -> 在发模型请求前即报错
        gpt_too_big, calls_too_big = _make_stub_gpt(self.base / "ckpt_big", lambda *_: _fake_response("never"))
        gpt_too_big._estimate_messages_bytes = compact_estimator
        gpt_too_big.max_request_bytes = img_only_size - 10
        with self.assertRaisesRegex(ValueError, "单张图片超过请求预算.*未降级为无图"):
            gpt_too_big.summarize(GPTSource(
                segment=[TranscriptSegment(start=0.0, end=0.0, text="短")],
                title="超限", tags="", _format=[], style="tutorial",
                video_img_urls=[img_a], video_image_ranges=None, structured=False,
            ))
        self.assertEqual(calls_too_big, [])

        # 3) HTTP 413 停止，不重试也不自动二分
        err_413 = Exception("Error code: 413 - Payload Too Large")
        gpt_413, calls_413 = _make_stub_gpt(self.base / "ckpt_413", lambda *_: err_413)
        with self.assertRaisesRegex(ValueError, "HTTP 413"):
            gpt_413.summarize(GPTSource(
                segment=[TranscriptSegment(start=0.0, end=0.0, text="文本" * 30)],
                title="413测试", tags="", _format=[], style="tutorial",
                video_img_urls=[img_a], video_image_ranges=None, structured=False,
            ))
        self.assertEqual(len(calls_413), 1)

        # 4) 响应截断（finish_reason='length'）触发拆片重试，不保留半截正文
        replies = [_fake_response("截断半截", "length"), _fake_response("完整子片A"), _fake_response("完整子片B")]
        gpt_len, calls_len = _make_stub_gpt(
            self.base / "ckpt_len",
            lambda idx, _m: replies[idx - 1],
        )
        out_len = gpt_len.summarize(GPTSource(
            segment=[TranscriptSegment(start=0.0, end=0.0, text="甲乙丙丁戊己庚辛" * 4)],
            title="截断测试", tags="", _format=[], style="tutorial",
            video_img_urls=[img_a], video_image_ranges=None, structured=False,
        ))
        self.assertEqual(len(calls_len), 3)
        self.assertIn("完整子片A", out_len)
        self.assertIn("完整子片B", out_len)
        self.assertNotIn("截断半截", out_len)

    def test_checkpoint_resume_same_signature_and_invalidation_on_image_or_range_change(self):
        ckpt_dir = self.base / "ckpt_resume"
        img1 = "data:image/jpeg;base64," + base64.b64encode(b"image-one").decode("ascii")
        img2 = "data:image/jpeg;base64," + base64.b64encode(b"image-two").decode("ascii")
        img3 = "data:image/jpeg;base64," + base64.b64encode(b"image-three").decode("ascii")

        segs = [
            TranscriptSegment(start=0.0, end=0.0, text="A" * 60),
            TranscriptSegment(start=0.0, end=0.0, text="B" * 60),
        ]
        src = GPTSource(
            segment=segs, title="续传测试", tags="", _format=[], style="tutorial",
            video_img_urls=[img1, img2], video_image_ranges=None,
            checkpoint_key="resume-static", structured=False,
        )

        # 首次执行：分片 0 成功，分片 1 中断失败
        first_replies = [_fake_response("分片1已完成"), Exception("terminal failure")]
        gpt1, calls1 = _make_stub_gpt(ckpt_dir, lambda idx, _m: first_replies[idx - 1])
        gpt1.max_chunk_text_chars = 60
        with self.assertRaisesRegex(Exception, "terminal failure"):
            gpt1.summarize(src)
        self.assertEqual(len(calls1), 2)
        saved = json.loads(gpt1._checkpoint_path("resume-static").read_text(encoding="utf-8"))
        self.assertEqual(saved["partials"], ["分片1已完成"])

        # 相同签名续传：直接复用分片 0，仅执行分片 1 与合并
        resume_replies = [_fake_response("分片2已完成"), _fake_response("最终合并正文")]
        gpt2, calls2 = _make_stub_gpt(ckpt_dir, lambda idx, _m: resume_replies[idx - 1])
        gpt2.max_chunk_text_chars = 60
        merged = gpt2.summarize(src)
        self.assertEqual(merged, "最终合并正文")
        self.assertEqual(len(calls2), 2)
        first_resume_text, _ = _extract_images_and_text(calls2[0])
        self.assertNotIn("A" * 60, first_resume_text)
        self.assertIn("B" * 60, first_resume_text)
        self.assertFalse(gpt2._checkpoint_path("resume-static").exists())

        # 换图导致签名变化，旧断点失效不串用
        sig_orig = gpt2._build_source_signature(src)
        gpt2._save_checkpoint("resume-static", sig_orig, ["旧图分片"], "summarize")
        src_swapped = copy.deepcopy(src)
        src_swapped.video_img_urls = [img1, img3]
        sig_swapped = gpt2._build_source_signature(src_swapped)
        self.assertNotEqual(sig_orig, sig_swapped)
        self.assertIsNone(gpt2._load_checkpoint("resume-static", sig_swapped))

        # video_image_ranges 从 [] 变为 None 签名不同，旧断点失效
        src_empty_ranges = GPTSource(
            segment=segs, title="范围签名测试", tags="", _format=[], style="tutorial",
            video_img_urls=[], video_image_ranges=[], checkpoint_key="range-sig", structured=False,
        )
        src_none_ranges = GPTSource(
            segment=segs, title="范围签名测试", tags="", _format=[], style="tutorial",
            video_img_urls=[], video_image_ranges=None, checkpoint_key="range-sig", structured=False,
        )
        sig_list = gpt2._build_source_signature(src_empty_ranges)
        sig_none = gpt2._build_source_signature(src_none_ranges)
        self.assertNotEqual(sig_list, sig_none)
        gpt2._save_checkpoint("range-sig", sig_list, ["旧空数组断点"], "summarize")
        self.assertIsNone(gpt2._load_checkpoint("range-sig", sig_none))

    def test_persist_reload_6_static_assets_and_generation_comparisons_policy(self):
        notes_dir = self.base / "notes"
        out_dir = self.base / "static" / "screenshots"
        comp_dir = self.base / "comparisons"
        ckpt_dir = self.base / "ckpt_persist"

        local_images = self._create_static_images(out_dir, 6)
        gen = _bare_generator()
        gen._prepare_local_image_evidence(local_images)
        self.assertEqual(len(gen.video_img_urls), 6)
        self.assertIsNone(gen.video_image_ranges)

        structured_raw = json.dumps({
            "schema_version": 1,
            "note_style": "knowledge",
            "title": "静态多图落盘验收",
            "sections": [{
                "id": "sec-1",
                "title": "核心拆解",
                "level": 2,
                "time_ranges": [],
                "core_takeaways": ["六图落盘可重读"],
                "blocks": [
                    {"type": "paragraph", "spans": [{"text": "正文结论。", "emphasis": "plain"}]},
                    {"type": "screenshot", "timestamp": 0, "label": "00:00", "caption": "模型图注1", "image_url": ""},
                    {"type": "screenshot", "timestamp": 0, "label": "00:00", "caption": "模型图注2", "image_url": ""},
                ],
                "annotations": [],
                "quiz": None,
            }],
        }, ensure_ascii=False)

        audio_meta = AudioDownloadResult(
            file_path="",
            title="静态多图落盘验收",
            duration=0.0,
            cover_url="",
            platform="x",
            video_id="1999999999999999999",
            raw_info={"media_kind": "text_post", "local_images": local_images},
            video_path=None,
        )
        transcript = TranscriptResult(
            language="zh",
            full_text="图文正文段落一。图文正文段落二。",
            segments=[
                TranscriptSegment(start=0.0, end=0.0, text="图文正文段落一。"),
                TranscriptSegment(start=0.0, end=0.0, text="图文正文段落二。"),
            ],
        )

        # 走真实后处理插入 6 张静态图
        processed_md = gen._post_process_markdown(
            markdown=structured_raw,
            video_path=None,
            formats=["screenshot"],
            audio_meta=audio_meta,
            platform="x",
        )
        # 按 NoteGenerator.generate 落盘规则将 None 归一化为空数组
        evidence = dict(
            schema_version=1,
            frame_mode="dynamic",
            duration=0,
            video_image_ranges=list(gen.video_image_ranges or []),
            frames=[],
            screenshots=[],
        )
        note_result = NoteResult(
            markdown=processed_md,
            transcript=transcript,
            audio_meta=audio_meta,
            evidence=evidence,
        )

        old_root = note_storage.ROOT
        note_storage.ROOT = notes_dir
        generation_comparisons.ACTIVE.clear()
        generation_comparisons.CANCELLED.clear()
        env_patch = patch.dict(os.environ, {
            "OUT_DIR": str(out_dir),
            "GENERATION_COMPARISON_DIR": str(comp_dir),
            "NOTE_OUTPUT_DIR": str(ckpt_dir),
        })
        env_patch.start()
        try:
            task_id = "static-6-assets"
            note_storage.save_task({
                "id": task_id,
                "status": "RUNNING",
                "formData": {"style": "knowledge", "format": ["screenshot"], "platform": "x"},
            })
            note_storage.save_result(task_id, note_result)

            # 重新从磁盘读取
            reloaded = note_storage.get_task(task_id)
            self.assertIsNotNone(reloaded)
            self.assertEqual(reloaded["status"], "SUCCESS")
            version = reloaded["markdown"][0]
            self.assertEqual(version["evidence"]["video_image_ranges"], [])
            self.assertIsInstance(version["evidence"]["video_image_ranges"], list)

            shots = [
                block
                for sec in version["structured"]["sections"]
                for block in sec.get("blocks") or []
                if block.get("type") == "screenshot"
            ]
            self.assertEqual(len(shots), 6)
            for shot in shots:
                self.assertTrue(shot["image_url"].startswith("../images/"))
                asset_path = note_storage.asset(task_id, "versions/" + shot["image_url"])
                self.assertTrue(asset_path.is_file())
                self.assertGreater(asset_path.stat().st_size, 0)

            # 模型对比：开启带图对比必须明确拒绝报错（无时间戳视频帧）
            base_req = {
                "task_id": task_id,
                "version_id": version["ver_id"],
                "request_id": "cmp-with-images",
                "use_images": True,
                "variants": [
                    {"provider_id": "mock", "model_name": "model-a", "options": {"max_requests": 2}},
                    {"provider_id": "mock", "model_name": "model-b", "options": {"max_requests": 2}},
                ],
            }
            with self.assertRaisesRegex(ValueError, "没有可复用的证据图片"):
                generation_comparisons.create_run(base_req, submit=False)

            # 关闭带图选项时纯文本对比成功且不修改原笔记
            text_req = dict(base_req, request_id="cmp-text-only", use_images=False)
            run = generation_comparisons.create_run(text_req, submit=False)
            compare_calls: list[dict] = []

            def fake_client(_provider, model):
                def create(**kwargs):
                    compare_calls.append(copy.deepcopy(kwargs))
                    return _fake_response(json.dumps({
                        "schema_version": 1,
                        "note_style": "knowledge",
                        "title": "纯文本对比结果",
                        "sections": [{
                            "id": "sec-1",
                            "title": "对比结论",
                            "level": 2,
                            "time_ranges": [],
                            "core_takeaways": [],
                            "blocks": [{"type": "paragraph", "spans": [{"text": f"模型 {model} 输出", "emphasis": "plain"}]}],
                            "annotations": [],
                            "quiz": None,
                        }],
                    }, ensure_ascii=False))
                return UniversalGPT(
                    types.SimpleNamespace(chat=types.SimpleNamespace(completions=types.SimpleNamespace(create=create))),
                    model,
                )

            with patch("app.services.ai_client.get_client", side_effect=fake_client):
                generation_comparisons.execute_run(run["id"])

            done = generation_comparisons.get_run(run["id"])
            self.assertEqual(done["status"], "completed")
            self.assertEqual(len(compare_calls), 2)
            self.assertEqual(done["source"]["image_policy"], "text_only")
            self.assertEqual(done["source"]["image_count"], 0)
        finally:
            generation_comparisons.ACTIVE.clear()
            generation_comparisons.CANCELLED.clear()
            note_storage.ROOT = old_root
            env_patch.stop()


if __name__ == "__main__":
    unittest.main()
