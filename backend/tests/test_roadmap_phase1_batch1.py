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

    def test_1_4_pass2_and_repair_prompts_include_schema_and_variant_adapter_blocks_raw_json_fallback(self):
        from app.gpt import prompt as prompt_mod

        # 1. Pass 2 合并与教程合并 Prompt 必须自带完整 Schema v1 字段模板，避免模型编造非标准字段
        for inst in (
            prompt_mod.KNOWLEDGE_CONSOLIDATE_PASS2_INSTRUCTIONS,
            prompt_mod.TUTORIAL_STRUCTURED_MERGE_INSTRUCTIONS,
        ):
            for token in ('"schema_version": 1', '"sections"', '"core_takeaways"', '"blocks"', '"annotations"', '"quiz"'):
                self.assertIn(token, inst)

        # 2. 偏航 JSON（chapters / concept_block / comparison_table / param_table / 单串 flow_chain / 顶层文本答案 quiz）无损适配
        variant_raw = json.dumps({
            'note_style': 'knowledge',
            'title': '深度工作方法论',
            'chapters': [
                {
                    'title': '心智杠杆与演进',
                    'time_ranges': [{'start': '00:00', 'end': '00:00'}],
                    'summary': '以高杠杆心智创作替代纯工时堆砌。',
                    'sections': [
                        {
                            'kind': 'concept_block',
                            'title': '工作模式演进',
                            'body': '现代朝九晚五仅存在约一两百年，当前进入个体高杠杆创作阶段。',
                            'annotations': [
                                {'kind': 'why', 'text': '打破把工时等同于安全感的惯性思维。'},
                                {'kind': 'case', 'text': '引用《第三次浪潮》说明媒介演进。'},
                                {'kind': 'pit', 'text': '避免把高频忙碌等同于高价值产出。'},
                            ],
                        }
                    ],
                    'comparison_table': {
                        'headers': ['模式', '核心特征', '局限'],
                        'rows': [['雇员模式', '按工时换报酬', '反杠杆'], ['个体杠杆', '产品与内容复利', '前期需试错']],
                    },
                    'param_table': {
                        'headers': ['阶段', '投入时长', '效果'],
                        'rows': [['起步期', '每天1小时', '年累积365小时']],
                    },
                    'flow_chain': ['无许可杠杆 -> 24小时心智滋养 -> 内容获取流量 -> 产品转化'],
                }
            ],
            'quiz': [
                {
                    'question': '早晨仅有1小时且尚无产品时优先做什么？',
                    'options': ['先用1小时构建产品', '先花几周起头衔', '自研排期软件'],
                    'answer': '先用1小时构建产品',
                    'explanation': '无产品阶段优先聚焦核心产品构建，再转向流量放大。',
                }
            ],
        }, ensure_ascii=False)

        parsed = sn.extract_structured_note_json(variant_raw, fallback_title='默认标题', default_style='knowledge')
        self.assertIsNotNone(parsed)
        self.assertEqual(parsed['title'], '深度工作方法论')
        self.assertEqual(len(parsed['sections']), 1)
        sec = parsed['sections'][0]
        self.assertEqual(sec['title'], '心智杠杆与演进')
        self.assertEqual(len(sec['core_takeaways']), 1)
        block_types = [b['type'] for b in sec['blocks']]
        self.assertEqual(block_types, ['paragraph', 'table', 'table', 'flow_chain'])
        self.assertEqual(sec['blocks'][1]['table_kind'], 'comparison')
        self.assertEqual(sec['blocks'][2]['table_kind'], 'params')
        self.assertEqual(len(sec['blocks'][3]['steps']), 4)
        self.assertEqual(len(sec['annotations']), 3)
        self.assertEqual([a['kind'] for a in sec['annotations']], ['why', 'case', 'pit'])
        self.assertIsNotNone(sec['quiz'])
        self.assertEqual(sec['quiz']['correct_key'], 'A')

        # 3. 多分片 knowledge Pass 2 发出请求必须附带 Schema 模板与截图规则
        pass2_prompts = []
        def multi_chunk_responder(kwargs):
            content = kwargs['messages'][0]['content']
            if 'Pass 1' in content:
                return json.dumps({
                    'cards': [{'topic': '杠杆', 'start': '00:00', 'end': '00:10', 'claims': ['聚焦高杠杆工作']}]
                }, ensure_ascii=False)
            pass2_prompts.append(content)
            return variant_raw

        gpt_multi = UniversalGPT(_MockClient(multi_chunk_responder), model='mock-multi')
        gpt_multi.max_chunk_text_chars = 60
        src_multi = GPTSource(
            title='长文测试', tags='', style='knowledge', structured=True, _format=['link', 'screenshot'],
            segment=[
                TranscriptSegment(start=0, end=5, text='A' * 50),
                TranscriptSegment(start=5, end=10, text='B' * 50),
            ],
        )
        multi_out = json.loads(gpt_multi.summarize(src_multi))
        self.assertEqual(len(pass2_prompts), 1)
        self.assertIn('"schema_version": 1', pass2_prompts[0])
        self.assertIn('视觉配图规则', pass2_prompts[0])
        self.assertEqual(multi_out['sections'][0]['blocks'][1]['type'], 'table')

        # 4. 彻底损坏的裸 JSON 修复后仍无法解析时必须抛错，严禁当成普通段落落盘；修复提示须含完整 Schema 模板
        repair_prompts = []
        def broken_json_responder(kwargs):
            repair_prompts.append(kwargs['messages'][0]['content'])
            return '{"note_style": "knowledge", "chapters": [{"title": "未闭合'

        gpt_broken = UniversalGPT(_MockClient(broken_json_responder), model='mock-broken')
        src_broken = GPTSource(
            title='坏JSON测试', tags='', style='knowledge', structured=True,
            segment=[TranscriptSegment(start=0, end=5, text='测试正文')],
        )
        with self.assertRaises(ValueError) as ctx:
            gpt_broken.summarize(src_broken)
        self.assertIn('结构化 JSON', str(ctx.exception))
        self.assertEqual(len(repair_prompts), 2)
        self.assertIn('"schema_version": 1', repair_prompts[1])
        self.assertIn('"blocks"', repair_prompts[1])

        # 5. 非 JSON 的纯文本降级仍保持可用，不误伤含内联 JSON 示例且以 '[' 开头的合法 Markdown
        prose_with_brackets = '[核心导读] 本节介绍配置项用法。\n\n常见示例配置为 {"timeout": 3000}。'
        gpt_prose = UniversalGPT(_MockClient(lambda _: prose_with_brackets), model='mock-prose')
        prose_out = json.loads(gpt_prose.summarize(src_broken))
        self.assertEqual(len(prose_out['sections'][0]['blocks']), 2)

        # 6. 未闭合 ```json 围栏或带前导语的截断 JSON 均必须被红线拦截
        for bad_payload in (
            '```json\n{"schema_version": 1, "note_style": "knowledge", "chapters": [{"title": "未闭合',
            '好的，为您生成结构化笔记如下：\n{"schema_version": 1, "sections": [{"title": "未闭合',
            '{"title": "早期截断", "blocks": [',
        ):
            gpt_bad = UniversalGPT(_MockClient(lambda _, p=bad_payload: p), model='mock-bad')
            with self.assertRaises(ValueError):
                gpt_bad.summarize(src_broken)

        # 7. _normalize_quiz 防止首字母碰撞（如 "API ..." 误判为 A）与反义子串抢占（"限制连接数" 误中 "不限制连接数"）
        q_prefix = sn._normalize_quiz({
            'question': '如何降低请求往返？',
            'options': ['使用 Redis 缓存', '轮询重试', 'API 批量合并请求'],
            'answer': 'API 批量合并请求',
            'explanation': '批量合并减少网络往返次数。',
        })
        self.assertIsNotNone(q_prefix)
        self.assertEqual(q_prefix['correct_key'], 'C')

        q_neg = sn._normalize_quiz({
            'question': '高并发场景下连接池应如何配置？',
            'options': ['不限制连接数', '限制连接数', '随机连接数'],
            'answer': '限制连接数',
            'explanation': '需按核数上限限制连接数避免雪崩。',
        })
        self.assertIsNotNone(q_neg)
        self.assertEqual(q_neg['correct_key'], 'B')

        # 8. 嵌套子块重复局部批注 id 不串位 + 无 type 字典态 flow_chain 保留 + 同子块 body/blocks 共存 + 顶层多题顺序保留
        nested_collision = json.dumps({
            'note_style': 'knowledge',
            'title': '边界回归测试',
            'chapters': [
                {
                    'title': '第一章',
                    'sections': [
                        {
                            'kind': 'concept_block',
                            'title': '子块一',
                            'body': '子块一正文。',
                            'blocks': [{'type': 'code_block', 'language': 'bash', 'code': 'echo 1'}],
                            'annotations': [{'id': 'a1', 'kind': 'why', 'text': '子块一专属原理'}],
                        },
                        {
                            'kind': 'concept_block',
                            'title': '子块二',
                            'body': '子块二正文。',
                            'annotations': [{'id': 'a1', 'kind': 'pit', 'text': '子块二专属避坑'}],
                        },
                    ],
                    'flow_chain': {'steps': ['步骤A', '步骤B', '步骤C']},
                },
                {
                    'title': '第二章',
                    'body': '第二章正文。',
                },
            ],
            'quiz': [
                {'question': '题1？', 'options': ['对1', '错1'], 'answer': 'A', 'explanation': '解析1'},
                {'question': '题2？', 'options': ['错2', '对2'], 'answer': 'B', 'explanation': '解析2'},
            ],
        }, ensure_ascii=False)
        parsed_nested = sn.extract_structured_note_json(nested_collision)
        self.assertIsNotNone(parsed_nested)
        sec1, sec2 = parsed_nested['sections']
        self.assertEqual([b['type'] for b in sec1['blocks']], ['paragraph', 'code_block', 'paragraph', 'flow_chain'])
        p1_anno_id = next(sp['annotation_id'] for sp in sec1['blocks'][0]['spans'] if sp.get('annotation_id'))
        p2_anno_id = next(sp['annotation_id'] for sp in sec1['blocks'][2]['spans'] if sp.get('annotation_id'))
        self.assertNotEqual(p1_anno_id, p2_anno_id)
        anno_by_id = {a['id']: a['full_detail'] for a in sec1['annotations']}
        self.assertEqual(anno_by_id[p1_anno_id], '子块一专属原理')
        self.assertEqual(anno_by_id[p2_anno_id], '子块二专属避坑')
        self.assertEqual(sec1['quiz']['full_question'], '题1？')
        self.assertEqual(sec2['quiz']['full_question'], '题2？')


if __name__ == '__main__':
    unittest.main()
