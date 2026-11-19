"""Offline tests for structured note Schema v1, dual storage, two-pass knowledge consolidation, and multi-window refinement."""
from __future__ import annotations

import errno
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

BACKEND = Path(__file__).resolve().parents[1]
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))
if 'app' not in sys.modules:
    app_pkg = types.ModuleType('app')
    app_pkg.__path__ = [str(BACKEND / 'app')]
    sys.modules['app'] = app_pkg

from app.models import structured_note as sn
from app.models.gpt_model import GPTSource
from app.models.transcriber_model import TranscriptSegment
from app.gpt.universal_gpt import UniversalGPT
from app.services import note_storage, note_refinement


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


class StructuredNoteSchemaTests(unittest.TestCase):
    def test_normalization_caps_tables_cleans_inline_timestamps_and_reconciles_annotations(self):
        raw = {
            'schema_version': 1,
            'note_style': 'knowledge',
            'title': '连接池调优',
            'platform': 'bilibili',
            'video_id': 'BV1demo123',
            'sections': [
                {
                    'title': '## 数据库连接池参数调优 *Content-[12:08]',
                    'time_ranges': [{'start': '34:15'}, {'start': '12:08', 'end': '14:30'}],
                    'core_takeaways': [
                        {'spans': [{'text': '连接数绝不是越大越好 *Content-[12:15]', 'emphasis': 'hl', 'annotation_id': 'why-1'}]}
                    ],
                    'blocks': [
                        {
                            'type': 'paragraph',
                            'spans': [{'text': '推荐遵守[原片 @ 14:05](https://example.invalid)核数两倍封顶原则。', 'emphasis': 'ul'}]
                        },
                        {
                            'type': 'table',
                            'table_kind': 'params',
                            'columns': ['核心参数', '推荐值', '作用与改错后果', '优先级', '多余第5列'],
                            'rows': [
                                [
                                    [{'text': 'maximumPoolSize', 'emphasis': 'code'}],
                                    [{'text': 'CPU核数 × 2 + 1', 'emphasis': 'code'}],
                                    [{'text': '控制并发连接上限，过高会引发严重上下文切换与锁争抢'}],
                                    [{'text': 'P0'}],
                                    [{'text': '应被截断'}],
                                ]
                            ],
                        },
                        {
                            'type': 'flow_chain',
                            'steps': [[{'text': '开启慢日志'}], [{'text': '查执行计划'}], [{'text': '补齐联合索引'}]],
                        },
                    ],
                    'annotations': [
                        {'id': 'why-1', 'kind': 'why', 'short_hint': '上下文切换耗时', 'full_detail': '超过核数后线程频繁切换。', 'timestamp': '12:24'},
                        {'id': 'pit-1', 'kind': 'pit', 'short_hint': '服务端超时掐断', 'full_detail': 'maxLifetime 必须短于服务端超时。', 'timestamp': '34:15'},
                    ],
                    'quiz': {
                        'short_prompt': '8核慢查询拉大连接池到100管用吗？',
                        'full_question': '线上 8 核数据库突发慢查询卡顿，直接把连接池拉到 100 能缓解吗？',
                        'options': [
                            {'key': 'A', 'text': '能缓解，减少外层排队'},
                            {'key': 'B', 'text': '不能，只会加剧上下文切换与锁争抢'},
                            {'key': 'C', 'text': '把超时改回30秒即可'},
                        ],
                        'correct_key': 'B',
                        'explanation': '瓶颈在慢 SQL 与锁等待，扩池只会恶化争抢。',
                    },
                }
            ],
        }
        doc = sn.normalize_structured_note(raw)
        sec = doc['sections'][0]
        self.assertEqual(sec['title'], '数据库连接池参数调优')
        self.assertEqual([r['label'] for r in sec['time_ranges']], ['12:08', '34:15'])
        self.assertNotIn('Content-', sec['core_takeaways'][0]['spans'][0]['text'])
        self.assertNotIn('原片 @', sec['blocks'][0]['spans'][0]['text'])

        table = sec['blocks'][1]
        self.assertEqual(len(table['columns']), 4)
        self.assertEqual(len(table['rows'][0]), 4)
        self.assertEqual(table['column_modes'], ['nowrap', 'nowrap', 'wrap', 'nowrap'])

        # Unreferenced pit-1 must still be attached onto a span cleanly.
        attached_ids = {
            s.get('annotation_id')
            for blk in sec['blocks'] if blk['type'] == 'paragraph'
            for s in blk['spans'] if s.get('annotation_id')
        } | {
            s.get('annotation_id')
            for tk in sec['core_takeaways']
            for s in tk['spans'] if s.get('annotation_id')
        }
        self.assertIn('why-1', attached_ids)
        self.assertIn('pit-1', attached_ids)

        md = sn.serialize_structured_note_to_markdown(doc)
        self.assertIn('## 数据库连接池参数调优 [原片 @ 12:08]', md)
        self.assertIn('[原片 @ 34:15]', md)
        self.assertIn('| 核心参数 | 推荐值 | 作用与改错后果 | 优先级 |', md)
        self.assertIn('开启慢日志 → 查执行计划 → 补齐联合索引', md)
        self.assertIn('> **[底层原理 · 原片 12:24]**', md)
        self.assertIn('> **[自测]**', md)

    def test_checklist_normalization_annotation_reconcile_and_gfm_export(self):
        raw = {
            'schema_version': 1,
            'note_style': 'tutorial',
            'title': '环境配置教程',
            'sections': [
                {
                    'id': 'sec-env',
                    'title': '前置环境准备',
                    'time_ranges': [{'start': '00:15', 'end': '01:20'}],
                    'blocks': [
                        {
                            'type': 'env_checklist',
                            'title': '环境准备自查 *Content-[00:15]',
                            'items': [
                                {'id': 'c1', 'spans': [{'text': '安装 ', 'emphasis': 'plain'}, {'text': 'Node.js 22', 'emphasis': 'code', 'annotation_id': 'pit-node'}], 'checked': False},
                                {'id': 'c1', 'text': '安装 FFmpeg 并加入 PATH *Content-[00:40]', 'checked': True},
                                '准备测试视频素材',
                            ],
                        }
                    ],
                    'annotations': [
                        {'id': 'pit-node', 'kind': 'pit', 'short_hint': '旧版本会报错', 'full_detail': 'Node 18 缺少原生 fetch 特性会导致构建失败。', 'timestamp': '00:25'},
                    ],
                }
            ],
        }
        doc = sn.normalize_structured_note(raw)
        sec = doc['sections'][0]
        checklist = sec['blocks'][0]
        self.assertEqual(checklist['type'], 'checklist')
        self.assertEqual(checklist['title'], '环境准备自查')
        self.assertEqual(len(checklist['items']), 3)
        self.assertEqual(checklist['items'][0]['id'], 'c1')
        self.assertNotEqual(checklist['items'][1]['id'], 'c1')
        self.assertFalse(checklist['items'][0]['checked'])
        self.assertTrue(checklist['items'][1]['checked'])
        self.assertNotIn('Content-', checklist['items'][1]['spans'][0]['text'])
        self.assertEqual(checklist['items'][0]['spans'][1]['annotation_id'], 'pit-node')
        # Referenced on checklist item, so no extra fallback paragraph should be created.
        self.assertEqual(len(sec['blocks']), 1)

        md = sn.serialize_structured_note_to_markdown(doc)
        self.assertIn('**环境准备自查**', md)
        self.assertIn('- [ ] 安装 `Node.js 22`', md)
        self.assertIn('- [x] 安装 FFmpeg 并加入 PATH', md)
        self.assertIn('- [ ] 准备测试视频素材', md)
        self.assertIn('> **[高频避坑 · 原片 00:25]** Node 18 缺少原生 fetch 特性会导致构建失败。', md)

    def test_structured_prompt_differentiates_tutorial_and_knowledge_checklist_rules(self):
        from app.gpt import prompt_builder
        tutorial_prompt = prompt_builder.generate_structured_prompt('安装教程', '00:10 - 安装 Node 22', '', ['link'], 'tutorial')
        knowledge_prompt = prompt_builder.generate_structured_prompt('架构原理', '00:10 - 讲解锁机制', '', ['link'], 'knowledge')
        self.assertIn('checklist', tutorial_prompt)
        self.assertIn('归纳自查项', tutorial_prompt)
        self.assertIn('不要生成 checklist 块', knowledge_prompt)


class StructuredStorageAndRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.patch = patch.object(note_storage, 'ROOT', self.root / 'notes')
        self.patch.start()
        self.addCleanup(self.patch.stop)
        self.sleep = patch.object(note_storage.time, 'sleep')
        self.sleep.start()
        self.addCleanup(self.sleep.stop)

    def test_dual_storage_and_manifest_recovery_for_structured_note(self):
        task_id = 'structured-save-01'
        note_storage.create_draft(task_id, {'video_url': 'https://www.bilibili.com/video/BV1test', 'platform': 'bilibili', 'style': 'knowledge', 'request_id': 'req-1'})
        note_storage.write_status(task_id, 'SAVING')
        staging = self.root / 'staging'
        (staging / 'images').mkdir(parents=True)
        (staging / 'images' / 'shot.png').write_bytes(b'\x89PNG\r\n\x1a\nfake')

        payload = {
            'schema_version': 1,
            'note_style': 'knowledge',
            'title': '连接池调优',
            'sections': [
                {
                    'id': 'sec-1',
                    'title': '核心原理',
                    'time_ranges': [{'start': 10, 'end': 45}],
                    'core_takeaways': [{'spans': [{'text': '核数两倍封顶', 'emphasis': 'hl'}]}],
                    'blocks': [
                        {'type': 'paragraph', 'spans': [{'text': '主干结论。', 'emphasis': 'plain'}]},
                        {'type': 'screenshot', 'timestamp': 22, 'caption': '压测图表', 'image_url': 'images/shot.png'},
                    ],
                }
            ],
        }

        real_replace = note_storage.os.replace
        def fail_manifest_replace(src, dst):
            if Path(dst).name == 'manifest.json':
                raise PermissionError(errno.EACCES, 'locked')
            return real_replace(src, dst)

        with patch.object(note_storage.os, 'replace', side_effect=fail_manifest_replace):
            with self.assertRaises(PermissionError):
                note_storage.save_task(
                    {'id': task_id, 'status': 'SUCCESS', 'markdown': json.dumps(payload, ensure_ascii=False), 'audioMeta': {'title': '连接池调优', 'platform': 'bilibili', 'video_id': 'BV1test'}},
                    staging=staging,
                    recoverable=True,
                )
        note_storage.write_status(task_id, 'FAILED', 'save denied')
        self.assertTrue(note_storage.save_recovery_summary(task_id)['available'])

        recovered = note_storage.retry_saved_result(task_id)
        self.assertEqual(recovered['status'], 'SUCCESS')
        ver = recovered['markdown'][0]
        self.assertIsInstance(ver.get('structured'), dict)
        self.assertEqual(ver['structured']['sections'][0]['blocks'][1]['image_url'][:10], '../images/')
        folder = note_storage._note_dir(task_id)
        self.assertTrue((folder / 'versions' / f"{ver['ver_id']}.json").is_file())
        self.assertTrue((folder / 'versions' / f"{ver['ver_id']}.md").is_file())


class TwoPassKnowledgeAndMultiWindowRefinementTests(unittest.TestCase):
    def test_knowledge_two_pass_merges_across_segments_without_source_segment_headings(self):
        calls = []

        def responder(kwargs):
            prompt_text = kwargs['messages'][0]['content']
            calls.append(prompt_text)
            if 'Pass 1' in prompt_text:
                if '前段' in prompt_text:
                    return json.dumps({
                        'cards': [{'topic': '连接池上限', 'start': '00:10', 'end': '00:30', 'claims': ['初讲连接数不能过大']}]
                    }, ensure_ascii=False)
                return json.dumps({
                    'cards': [{'topic': '连接池上限', 'start': '05:10', 'end': '05:40', 'claims': ['后半程补坑 maxLifetime 要短于服务端']}]
                }, ensure_ascii=False)
            if 'Pass 2' in prompt_text:
                return json.dumps({
                    'schema_version': 1,
                    'note_style': 'knowledge',
                    'title': '连接池',
                    'sections': [{
                        'id': 'sec-1',
                        'title': '连接池上限与存活时间控制',
                        'time_ranges': [{'start': '00:10', 'end': '00:30'}, {'start': '05:10', 'end': '05:40'}],
                        'core_takeaways': [{'spans': [{'text': '连接数遵循核数两倍原则', 'emphasis': 'hl'}]}],
                        'blocks': [{'type': 'paragraph', 'spans': [{'text': '结合补坑结论，maxLifetime 必须短于服务端超时。', 'emphasis': 'plain'}]}],
                    }],
                }, ensure_ascii=False)
            raise AssertionError('Unexpected prompt stage')

        gpt = UniversalGPT(_MockClient(responder), model='mock-gpt')
        gpt.max_chunk_text_chars = 18
        source = GPTSource(
            title='连接池',
            tags='后端',
            style='knowledge',
            structured=True,
            segment=[
                TranscriptSegment(start=10, end=30, text='前段讲解连接池大小设定。'),
                TranscriptSegment(start=310, end=340, text='后段补充连接存活时间踩坑。'),
            ],
        )
        output = gpt.summarize(source)
        doc = json.loads(output)
        self.assertEqual(doc['note_style'], 'knowledge')
        self.assertEqual(len(doc['sections']), 1)
        self.assertEqual([r['start'] for r in doc['sections'][0]['time_ranges']], [10, 310])
        self.assertNotIn('来源分段', output)
        self.assertEqual(len(calls), 3)  # 2 Pass-1 chunks + 1 Pass-2 consolidation

    def test_multi_window_refinement_extracts_discrete_transcript_segments(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'notes'
            with patch.object(note_storage, 'ROOT', root):
                structured = {
                    'schema_version': 1,
                    'note_style': 'knowledge',
                    'title': '合拢章节测试',
                    'sections': [
                        {
                            'id': 'sec-1',
                            'title': '连接池调优',
                            'time_ranges': [{'start': 10, 'end': 30}, {'start': 200, 'end': 225}],
                            'core_takeaways': [{'spans': [{'text': '核数两倍封顶', 'emphasis': 'hl'}]}],
                            'blocks': [{'type': 'paragraph', 'spans': [{'text': '跨段合拢正文。', 'emphasis': 'plain'}]}],
                        }
                    ],
                }
                saved = note_storage.save_task({
                    'id': 'refine-multi',
                    'status': 'SUCCESS',
                    'audioMeta': {'title': '合拢章节测试', 'duration': 300, 'platform': 'local', 'video_id': 'local-1'},
                    'formData': {'platform': 'local', 'style': 'knowledge'},
                    'transcript': {'segments': [
                        {'start': 10, 'end': 25, 'text': '第一段核心原理。'},
                        {'start': 80, 'end': 120, 'text': '中间无关闲聊。'},
                        {'start': 205, 'end': 220, 'text': '后半程关键避坑。'},
                    ]},
                    'markdown': [{'ver_id': 'v1', 'content': json.dumps(structured, ensure_ascii=False), 'style': 'knowledge', 'model_name': 'm'}],
                })
                ctx = note_refinement.source_context('refine-multi', 'v1', ['跨段合拢正文。'])
                self.assertEqual(ctx['time_ranges'], [{'start': 10.0, 'end': 30.0}, {'start': 200.0, 'end': 225.0}])

                fake_resp = types.SimpleNamespace(choices=[types.SimpleNamespace(finish_reason='stop', message=types.SimpleNamespace(content='修订后跨段正文。'))])
                with patch.object(note_refinement, 'get_client', return_value=types.SimpleNamespace(client=object())), \
                     patch.object(note_refinement, 'complete', return_value=(fake_resp, {'usage': {}})), \
                     patch.object(note_refinement, 'close_client'):
                    draft = note_refinement.preview('refine-multi', {
                        'version_id': 'v1',
                        'texts': ['跨段合拢正文。'],
                        'start_time': 10,
                        'end_time': 30,
                        'time_ranges': ctx['time_ranges'],
                        'provider_id': 'p1',
                        'model_name': 'm1',
                        'protocol': 'openai-chat',
                        'instruction': '合并补坑细节',
                        'use_video': False,
                    })
                transcript_texts = [seg['text'] for seg in draft['evidence']['transcript']]
                self.assertEqual(transcript_texts, ['第一段核心原理。', '后半程关键避坑。'])
                self.assertEqual(len(draft['time_ranges']), 2)
                self.assertEqual(ctx['matched_section_ids'], ['sec-1'])

    def test_structured_section_refinement_preserves_unselected_sections_and_applies_dual_storage(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'notes'
            with patch.object(note_storage, 'ROOT', root):
                structured = {
                    'schema_version': 1,
                    'note_style': 'tutorial',
                    'title': '桌面部署教程',
                    'sections': [
                        {
                            'id': 'sec-1',
                            'title': '环境准备',
                            'time_ranges': [{'start': 10, 'end': 40}],
                            'core_takeaways': [{'spans': [{'text': '先装好运行依赖', 'emphasis': 'hl'}]}],
                            'blocks': [{'type': 'paragraph', 'spans': [{'text': '需要 Python 与 FFmpeg。', 'emphasis': 'plain'}]}],
                        },
                        {
                            'id': 'sec-2',
                            'title': '启动验证',
                            'time_ranges': [{'start': 45, 'end': 90}],
                            'core_takeaways': [{'spans': [{'text': '端口冲突时换独立端口', 'emphasis': 'wave', 'annotation_id': 'pit-port'}]}],
                            'blocks': [{'type': 'paragraph', 'spans': [{'text': '启动后访问健康接口确认状态。', 'emphasis': 'plain'}]}],
                            'annotations': [
                                {'id': 'pit-port', 'kind': 'pit', 'short_hint': '避开 8483', 'full_detail': '8483 已被正式版占用。', 'timestamp': '01:05'}
                            ],
                            'quiz': {
                                'short_prompt': '开发预览能否复用 8483 端口？',
                                'full_question': '本地开发预览时直接连接 8483 端口会有什么风险？',
                                'options': [
                                    {'key': 'A', 'text': '无影响'},
                                    {'key': 'B', 'text': '会污染正式版服务与数据'},
                                    {'key': 'C', 'text': '仅影响前端样式'},
                                ],
                                'correct_key': 'B',
                                'explanation': '8483 为正式版默认端口，开发测试须独立隔离。',
                            },
                        },
                        {
                            'id': 'sec-3',
                            'title': '常见问题',
                            'time_ranges': [{'start': 95, 'end': 120}],
                            'blocks': [{'type': 'paragraph', 'spans': [{'text': '查看日志定位报错。', 'emphasis': 'plain'}]}],
                        },
                    ],
                }
                note_storage.save_task({
                    'id': 'refine-structured-01',
                    'status': 'SUCCESS',
                    'audioMeta': {'title': '桌面部署教程', 'duration': 150, 'platform': 'local', 'video_id': 'local-deploy'},
                    'formData': {'platform': 'local', 'style': 'tutorial'},
                    'transcript': {'segments': [
                        {'start': 10, 'end': 25, 'text': '先准备 Python 3.11 虚拟环境。'},
                        {'start': 25, 'end': 40, 'text': '再确认系统已安装 FFmpeg 并配置 PATH。'},
                        {'start': 45, 'end': 90, 'text': '启动独立端口服务并检查健康状态。'},
                    ]},
                    'markdown': [{'ver_id': 'v1', 'content': json.dumps(structured, ensure_ascii=False), 'style': 'tutorial', 'model_name': 'm'}],
                })

                # Non-contiguous section_ids must be rejected.
                with self.assertRaises(ValueError):
                    note_refinement.source_context('refine-structured-01', 'v1', [], section_ids=['sec-1', 'sec-3'])

                ctx = note_refinement.source_context('refine-structured-01', 'v1', [], section_ids=['sec-1'])
                self.assertTrue(ctx['structured_mode'])
                self.assertEqual(ctx['section_ids'], ['sec-1'])
                self.assertEqual(ctx['section_titles'], ['环境准备'])
                self.assertEqual(ctx['time_ranges'], [{'start': 10.0, 'end': 40.0}])

                captured_messages = []
                refined_payload = {
                    'sections': [
                        {
                            'id': 'sec-1',
                            'title': '环境准备',
                            'time_ranges': [{'start': '00:10', 'end': '00:40'}],
                            'core_takeaways': [{'spans': [{'text': '先完成 Python 3.11 与 FFmpeg 前置自查', 'emphasis': 'hl'}]}],
                            'blocks': [
                                {
                                    'type': 'checklist',
                                    'title': '环境准备自查',
                                    'items': [
                                        {'id': 'c1', 'spans': [{'text': '已创建 ', 'emphasis': 'plain'}, {'text': 'Python 3.11', 'emphasis': 'code'}, {'text': ' 虚拟环境', 'emphasis': 'plain'}], 'checked': False},
                                        {'id': 'c2', 'spans': [{'text': '系统已安装 ', 'emphasis': 'plain'}, {'text': 'FFmpeg', 'emphasis': 'code'}, {'text': ' 并加入 PATH', 'emphasis': 'plain'}], 'checked': False},
                                    ],
                                }
                            ],
                        }
                    ]
                }

                def fake_complete(client, model, messages, **kwargs):
                    captured_messages.append(messages)
                    resp = types.SimpleNamespace(choices=[types.SimpleNamespace(
                        finish_reason='stop',
                        message=types.SimpleNamespace(content=json.dumps(refined_payload, ensure_ascii=False)),
                    )])
                    return resp, {'usage': {'total_tokens': 128}}

                with patch.object(note_refinement, 'get_client', return_value=types.SimpleNamespace(client=object())), \
                     patch.object(note_refinement, 'complete', side_effect=fake_complete), \
                     patch.object(note_refinement, 'close_client'):
                    draft = note_refinement.preview('refine-structured-01', {
                        'version_id': 'v1',
                        'texts': [],
                        'section_ids': ['sec-1'],
                        'start_time': 10,
                        'end_time': 40,
                        'provider_id': 'p1',
                        'model_name': 'm-refine',
                        'protocol': 'openai-chat',
                        'instruction': '把前置依赖整理成 checklist 环境自查清单',
                        'use_video': False,
                    })

                self.assertTrue(draft['structured_mode'])
                self.assertIn('- [ ] 已创建 `Python 3.11` 虚拟环境', draft['after'])
                sent_user = json.loads(captured_messages[0][1]['content'])
                self.assertEqual(sent_user['instruction'], '把前置依赖整理成 checklist 环境自查清单')

                updated = note_refinement.apply('refine-structured-01', draft['draft_id'])
                self.assertEqual(len(updated['markdown']), 2)
                new_ver = updated['markdown'][0]
                self.assertIsInstance(new_ver.get('structured'), dict)
                new_secs = new_ver['structured']['sections']
                self.assertEqual([s['id'] for s in new_secs], ['sec-1', 'sec-2', 'sec-3'])
                self.assertEqual(new_secs[0]['blocks'][0]['type'], 'checklist')
                # Unselected section 2 must retain its annotations and quiz intact.
                self.assertEqual(new_secs[1]['annotations'][0]['id'], 'pit-port')
                self.assertEqual(new_secs[1]['quiz']['correct_key'], 'B')
                self.assertIn('- [ ] 已创建 `Python 3.11` 虚拟环境', new_ver['content'])
                self.assertEqual(new_ver['refinement']['structured_mode'], True)
                self.assertEqual(new_ver['refinement']['section_ids'], ['sec-1'])
                folder = note_storage._note_dir('refine-structured-01')
                self.assertTrue((folder / 'versions' / f"{new_ver['ver_id']}.json").is_file())
                self.assertTrue((folder / 'versions' / f"{new_ver['ver_id']}.md").is_file())

                # Idempotent apply returns the exact same task without adding a third version.
                again = note_refinement.apply('refine-structured-01', draft['draft_id'])
                self.assertEqual(len(again['markdown']), 2)

    def test_structured_section_refinement_guardrails_reject_unverified_time_and_images(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'notes'
            with patch.object(note_storage, 'ROOT', root):
                structured = {
                    'schema_version': 1,
                    'note_style': 'tutorial',
                    'title': '护栏测试',
                    'sections': [
                        {
                            'id': 'sec-1',
                            'title': '步骤一',
                            'time_ranges': [{'start': 10, 'end': 30}],
                            'blocks': [{'type': 'paragraph', 'spans': [{'text': '原始步骤。', 'emphasis': 'plain'}]}],
                        }
                    ],
                }
                note_storage.save_task({
                    'id': 'refine-guard-01',
                    'status': 'SUCCESS',
                    'audioMeta': {'title': '护栏测试', 'duration': 120, 'platform': 'local', 'video_id': 'local-g'},
                    'formData': {'platform': 'local', 'style': 'tutorial'},
                    'transcript': {'segments': [{'start': 10, 'end': 30, 'text': '执行命令。'}]},
                    'markdown': [{'ver_id': 'v1', 'content': json.dumps(structured, ensure_ascii=False), 'style': 'tutorial', 'model_name': 'm'}],
                })

                bad_payloads = [
                    # Out-of-range annotation timestamp
                    {'sections': [{'id': 'sec-1', 'title': '步骤一', 'time_ranges': [{'start': '00:10', 'end': '00:30'}],
                                   'blocks': [{'type': 'paragraph', 'spans': [{'text': '修订。', 'annotation_id': 'a1'}]}],
                                   'annotations': [{'id': 'a1', 'kind': 'why', 'short_hint': '原因', 'full_detail': '超界时间。', 'timestamp': '01:50'}]}]},
                    # Unverified screenshot without images_provided
                    {'sections': [{'id': 'sec-1', 'title': '步骤一', 'time_ranges': [{'start': '00:10', 'end': '00:30'}],
                                   'blocks': [{'type': 'screenshot', 'timestamp': '00:20', 'caption': '假图'}]}]},
                    # Unverified external image URL
                    {'sections': [{'id': 'sec-1', 'title': '步骤一', 'time_ranges': [{'start': '00:10', 'end': '00:30'}],
                                   'blocks': [{'type': 'screenshot', 'timestamp': '00:20', 'image_url': 'https://evil.invalid/a.png'}]}]},
                ]
                for payload in bad_payloads:
                    resp = types.SimpleNamespace(choices=[types.SimpleNamespace(
                        finish_reason='stop',
                        message=types.SimpleNamespace(content=json.dumps(payload, ensure_ascii=False)),
                    )])
                    with patch.object(note_refinement, 'get_client', return_value=types.SimpleNamespace(client=object())), \
                         patch.object(note_refinement, 'complete', return_value=(resp, {})), \
                         patch.object(note_refinement, 'close_client'):
                        with self.assertRaises(ValueError):
                            note_refinement.preview('refine-guard-01', {
                                'version_id': 'v1',
                                'texts': [],
                                'section_ids': ['sec-1'],
                                'start_time': 10,
                                'end_time': 30,
                                'provider_id': 'p1',
                                'model_name': 'm1',
                                'protocol': 'openai-chat',
                                'instruction': '',
                                'use_video': False,
                            })

                # Valid screenshot with real extracted candidate frame migrates into ../images/ on apply.
                video_mod = types.ModuleType('app.utils.video_reader')
                class FakeReader:
                    def __init__(self, path, **options):
                        self.options = options
                        self.evidence = []
                    def run(self):
                        fdir = Path(self.options['frame_dir'])
                        fdir.mkdir(parents=True, exist_ok=True)
                        frame = fdir / 'frame_00_20_000.jpg'
                        frame.write_bytes(b'\xff\xd8\xff\xe0fakejpeg')
                        self.evidence = [{'time': 20.0, 'reason': 'subtitle_operation', 'path': str(frame)}]
                        return ['data:image/jpeg;base64,ZmFrZQ==']
                video_mod.VideoReader = FakeReader
                fake_video = Path(tmp) / 'demo.mp4'
                fake_video.write_bytes(b'video')
                good_shot = {'sections': [{
                    'id': 'sec-1',
                    'title': '步骤一',
                    'time_ranges': [{'start': '00:10', 'end': '00:30'}],
                    'blocks': [
                        {'type': 'paragraph', 'spans': [{'text': '界面参数确认。'}]},
                        {'type': 'screenshot', 'timestamp': '00:21', 'caption': '参数界面'},
                    ],
                }]}
                resp = types.SimpleNamespace(choices=[types.SimpleNamespace(
                    finish_reason='stop',
                    message=types.SimpleNamespace(content=json.dumps(good_shot, ensure_ascii=False)),
                )])
                with patch.dict(sys.modules, {'app.utils.video_reader': video_mod}), \
                     patch.object(note_refinement, 'local_video', return_value=fake_video), \
                     patch.object(note_refinement, 'get_client', return_value=types.SimpleNamespace(client=object())), \
                     patch.object(note_refinement, 'complete', return_value=(resp, {})), \
                     patch.object(note_refinement, 'close_client'):
                    draft = note_refinement.preview('refine-guard-01', {
                        'version_id': 'v1',
                        'texts': [],
                        'section_ids': ['sec-1'],
                        'start_time': 10,
                        'end_time': 30,
                        'provider_id': 'p1',
                        'model_name': 'm1',
                        'protocol': 'openai-chat',
                        'instruction': '补充关键操作截图',
                        'use_video': True,
                    })
                self.assertEqual(draft['after_sections'][0]['blocks'][1]['image_url'], 'images/frame_00_20_000.jpg')
                applied = note_refinement.apply('refine-guard-01', draft['draft_id'])
                shot_url = applied['markdown'][0]['structured']['sections'][0]['blocks'][1]['image_url']
                self.assertTrue(shot_url.startswith('../images/'))
                self.assertIn(f'({shot_url})', applied['markdown'][0]['content'])


if __name__ == '__main__':
    unittest.main()
