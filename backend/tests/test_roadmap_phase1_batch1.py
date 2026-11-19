"""Offline tests for 0.2.0 Phase 1 Batch 1 (1.1 share URL parsing, 1.2 prompt/JSON resilience, 1.3 upgrade & comparison)."""
from __future__ import annotations

import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

BACKEND = Path(__file__).resolve().parents[1]
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))
if 'app' not in sys.modules:
    app_pkg = types.ModuleType('app')
    app_pkg.__path__ = [str(BACKEND / 'app')]
    sys.modules['app'] = app_pkg

from app.gpt import prompt_builder
from app.gpt.universal_gpt import UniversalGPT
from app.models import structured_note as sn
from app.models.gpt_model import GPTSource
from app.models.transcriber_model import TranscriptSegment
from app.services import note_storage, note_upgrade
from app.utils import url_parser
from app.validators.video_url_validator import VideoRequest, is_supported_video_url


class _MockCompletions:
    def __init__(self, responder):
        self._responder = responder

    def create(self, **kwargs):
        text = self._responder(kwargs)
        return types.SimpleNamespace(
            choices=[types.SimpleNamespace(finish_reason='stop', message=types.SimpleNamespace(content=text, refusal=None))],
            usage=None,
        )


class _MockClient:
    def __init__(self, responder):
        self.chat = types.SimpleNamespace(completions=_MockCompletions(responder))
        self.models = types.SimpleNamespace(list=lambda: [])

    def close(self):
        pass


class Phase1Batch1Tests(unittest.TestCase):
    def test_1_1_share_text_extraction_mobile_variants_and_platform_autocorrect(self):
        # 混合分享口令 + 移动版 B 站 + 追踪后缀
        bili_share = '【硬核拆解连接池】 https://m.bilibili.com/video/BV1xx411c7mD?p=2&share_source=copy_web&vd_source=xyz 快来一起看！'
        self.assertEqual(url_parser.normalize_video_url(bili_share), 'https://www.bilibili.com/video/BV1xx411c7mD?p=2')
        self.assertEqual(url_parser.detect_video_platform(bili_share), 'bilibili')

        # 裸 BV 号混合文本
        bare_bv = '推荐你看这个 BV1CPXpBYEui 讲得很透彻'
        self.assertEqual(url_parser.normalize_video_url(bare_bv), 'https://www.bilibili.com/video/BV1CPXpBYEui')
        req_bili = VideoRequest(url=bare_bv, platform='youtube')
        self.assertEqual(req_bili.platform, 'bilibili')
        self.assertEqual(str(req_bili.url), 'https://www.bilibili.com/video/BV1CPXpBYEui')

        # YouTube 移动版 / live / youtu.be 短链与追踪参数清理
        yt_live = 'Live stream: https://m.youtube.com/live/dQw4w9WgXcQ?si=track123&feature=share'
        self.assertEqual(url_parser.normalize_video_url(yt_live), 'https://m.youtube.com/live/dQw4w9WgXcQ')
        self.assertEqual(url_parser.extract_video_id(yt_live, 'youtube'), 'dQw4w9WgXcQ')
        self.assertTrue(is_supported_video_url(yt_live))
        req_yt = VideoRequest(url=yt_live, platform='bilibili')
        self.assertEqual(req_yt.platform, 'youtube')

        # 快手短链与 gifshow
        for ks_url in ('看这个 https://v.kuaishou.com/abc123 复制此消息', 'https://www.gifshow.com/fw/photo/xyz987'):
            self.assertTrue(is_supported_video_url(ks_url))
            req_ks = VideoRequest(url=ks_url)
            self.assertEqual(req_ks.platform, 'kuaishou')

        # b23.tv 短链保留短链且剥离追踪参数
        b23 = '【标题】https://b23.tv/abcXYZ?share_source=copy_web&utm_source=test'
        self.assertEqual(url_parser.normalize_video_url(b23), 'https://b23.tv/abcXYZ')
        self.assertTrue(is_supported_video_url(b23))

    def test_1_2_single_chunk_knowledge_prompt_and_reasoning_json_resilience(self):
        knowledge_prompt = prompt_builder.generate_structured_prompt('连接池调优', '00:10 - 内容', '', ['link'], 'knowledge')
        self.assertIn('打破视频时间流水账', knowledge_prompt)
        self.assertIn('time_ranges', knowledge_prompt)

        tutorial_prompt = prompt_builder.generate_structured_prompt('安装教程', '00:10 - 内容', '', ['link'], 'tutorial')
        self.assertIn('严格保持原片实操步骤的先后顺序', tutorial_prompt)

        # 带 <think> 标签 + 说明文字 + ```json 围栏 + 尾部多余逗号的思考模型输出
        messy_output = (
            '<think>先分析一下这段视频的结构，这里有 {干扰括号}...</think>\n'
            '好的，以下是结构化 JSON：\n'
            '```json\n'
            '{\n'
            '  "schema_version": 1,\n'
            '  "note_style": "knowledge",\n'
            '  "title": "容错测试",\n'
            '  "sections": [\n'
            '    {\n'
            '      "id": "sec-1",\n'
            '      "title": "核心结论",\n'
            '      "time_ranges": [{"start": "00:10", "end": "00:45"},],\n'
            '      "blocks": [{"type": "paragraph", "spans": [{"text": "有效正文。", "emphasis": "plain"},]}],\n'
            '    },\n'
            '  ],\n'
            '}\n'
            '```\n'
        )
        parsed = sn.extract_structured_note_json(messy_output)
        self.assertIsNotNone(parsed)
        self.assertEqual(parsed['title'], '容错测试')
        self.assertEqual(parsed['sections'][0]['blocks'][0]['spans'][0]['text'], '有效正文。')

        # 残缺 JSON 触发单轮修复，不保留 <think> 污染
        calls = []
        def repair_responder(kwargs):
            calls.append(kwargs)
            if len(calls) == 1:
                return '<think>内部推理</think>{"title": "坏掉的json", "sections": ['
            return json.dumps({
                'schema_version': 1, 'note_style': 'knowledge', 'title': '修复成功',
                'sections': [{'id': 'sec-1', 'title': '修复节', 'blocks': [{'type': 'paragraph', 'spans': [{'text': '无损恢复。'}]}]}],
            }, ensure_ascii=False)

        gpt = UniversalGPT(_MockClient(repair_responder), model='mock-think')
        source = GPTSource(
            title='容错测试', tags='', style='knowledge', structured=True,
            segment=[TranscriptSegment(start=10, end=45, text='核心原理讲解。')],
        )
        out = json.loads(gpt.summarize(source))
        self.assertEqual(out['title'], '修复成功')
        self.assertEqual(len(calls), 2)
        self.assertNotIn('<think>', calls[1]['messages'][0]['content'])

    def test_1_3_legacy_note_one_click_upgrade_preserves_old_versions(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'notes'
            with patch.object(note_storage, 'ROOT', root):
                note_storage.save_task({
                    'id': 'legacy-note-01',
                    'status': 'SUCCESS',
                    'audioMeta': {'title': '老版笔记', 'duration': 90, 'platform': 'bilibili', 'video_id': 'BV1legacy123'},
                    'formData': {'platform': 'bilibili', 'video_url': 'https://www.bilibili.com/video/BV1legacy123', 'style': 'knowledge'},
                    'transcript': {'segments': [
                        {'start': 5, 'end': 30, 'text': '第一段讲解连接池大小。'},
                        {'start': 40, 'end': 70, 'text': '第二段补充超时避坑。'},
                    ]},
                    'markdown': [{'ver_id': 'legacy-v1', 'content': '## 旧版纯文本\n\n原始正文。', 'style': 'knowledge', 'model_name': 'old-m'}],
                })

                upgraded_json = json.dumps({
                    'schema_version': 1,
                    'note_style': 'knowledge',
                    'title': '老版笔记',
                    'sections': [{
                        'id': 'sec-1',
                        'title': '连接池与超时控制',
                        'time_ranges': [{'start': '00:05', 'end': '00:30'}, {'start': '00:40', 'end': '01:10'}],
                        'core_takeaways': [{'spans': [{'text': '核数两倍封顶', 'emphasis': 'hl'}]}],
                        'blocks': [{'type': 'paragraph', 'spans': [{'text': '从缓存字幕直出结构化版本。'}]}],
                    }],
                }, ensure_ascii=False)

                fake_gpt = UniversalGPT(_MockClient(lambda _: upgraded_json), model='new-m')
                with patch.object(note_upgrade, 'get_client', return_value=fake_gpt), \
                     patch.object(note_upgrade, 'close_client'):
                    updated = note_upgrade.upgrade_note_to_structured(
                        'legacy-note-01',
                        provider_id='p-new',
                        model_name='new-m',
                        protocol='openai-chat',
                    )

                self.assertEqual(len(updated['markdown']), 2)
                newest, oldest = updated['markdown']
                self.assertEqual(oldest['ver_id'], 'legacy-v1')
                self.assertEqual(oldest['content'], '## 旧版纯文本\n\n原始正文。')
                self.assertIsInstance(newest.get('structured'), dict)
                self.assertEqual(newest['upgraded_from_version'], 'legacy-v1')
                self.assertEqual(newest['structured']['sections'][0]['title'], '连接池与超时控制')
                folder = note_storage._note_dir('legacy-note-01')
                self.assertTrue((folder / 'versions' / f"{newest['ver_id']}.json").is_file())
                self.assertTrue((folder / 'versions' / f"{newest['ver_id']}.md").is_file())


if __name__ == '__main__':
    unittest.main()
