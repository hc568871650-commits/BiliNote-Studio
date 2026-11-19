"""Offline isolated tests for 0.2.0 Phase 1 Batch 3 (1.5 structured search/RAG & 1.6 Range media + learning state)."""
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

from app.services import learning_state, library_search, media_stream, note_storage
from app.services import vector_store


def _sample_structured_doc():
    return {
        'schema_version': 1,
        'note_style': 'knowledge',
        'title': '连接池与索引实战',
        'platform': 'local',
        'video_id': 'local-demo',
        'sections': [
            {
                'id': 'sec-pool',
                'title': '数据库连接池参数调优',
                'level': 2,
                'time_ranges': [
                    {'start': 728, 'end': 870, 'label': '12:08'},
                    {'start': 2055, 'end': 2120, 'label': '34:15'},
                ],
                'core_takeaways': [
                    {'spans': [{'text': '连接数绝不是越大越好', 'emphasis': 'hl', 'annotation_id': 'why-ctx'}]}
                ],
                'blocks': [
                    {'type': 'paragraph', 'spans': [{'text': '建议核数两倍封顶原则，maxLifetime 必须短于服务端超时。', 'emphasis': 'plain', 'annotation_id': 'pit-timeout'}]}
                ],
                'annotations': [
                    {'id': 'why-ctx', 'kind': 'why', 'short_hint': '上下文切换暴增', 'full_detail': '线程远超核数会浪费大量 CPU 在切换上。', 'timestamp': 744, 'timestamp_label': '原片 12:24'},
                    {'id': 'pit-timeout', 'kind': 'pit', 'short_hint': '静默断连抛异常', 'full_detail': '云网关超时掐断连接后客户端借出即报 Connection reset。', 'timestamp': 2055, 'timestamp_label': '原片 34:15'},
                ],
                'quiz': {
                    'short_prompt': '8 核慢查询拉大连接池到 100 管用吗？',
                    'full_question': '8 核数据库突发慢查询卡顿，直接把连接池拉到 100 能缓解吗？',
                    'options': [
                        {'key': 'A', 'text': '能缓解排队'},
                        {'key': 'B', 'text': '不能，只会加剧上下文切换与锁争抢'},
                        {'key': 'C', 'text': '改超时即可'},
                    ],
                    'correct_key': 'B',
                    'explanation': '瓶颈在慢 SQL，扩池只会恶化争抢。',
                },
            }
        ],
    }


class Phase1Batch3Tests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.patch = patch.object(note_storage, 'ROOT', self.root / 'notes')
        self.patch.start()
        self.addCleanup(self.patch.stop)
        library_search._CACHE.clear()
        library_search._DIRECT_CACHE.clear()

    def _create_structured_task(self, task_id='note-struct-01', video_path=''):
        doc = _sample_structured_doc()
        return note_storage.save_task({
            'id': task_id,
            'status': 'SUCCESS',
            'audioMeta': {'title': '连接池与索引实战', 'duration': 2400, 'platform': 'local', 'video_id': 'local-demo', 'video_path': video_path},
            'formData': {'platform': 'local', 'style': 'knowledge', 'video_url': video_path},
            'transcript': {'segments': [{'start': 728, 'end': 750, 'text': '连接池调优原理讲解。'}]},
            'markdown': [{'ver_id': 'v1', 'content': json.dumps(doc, ensure_ascii=False), 'style': 'knowledge', 'model_name': 'm'}],
        })

    def test_1_5_structured_library_search_direct_search_and_rag_chunks(self):
        self._create_structured_task('note-struct-01')

        # 1. Assistant library search reads structured .json with real section_id, discrete time_ranges and categories.
        lib_res = library_search.search_library('Connection reset')
        self.assertEqual(lib_res['total'], 1)
        hit = lib_res['results'][0]
        self.assertEqual(hit['section_id'], 'sec-pool')
        self.assertEqual(len(hit['time_ranges']), 2)
        self.assertIn('annotation:pit', hit['content_categories'])
        self.assertIn('core_takeaways', hit['content_categories'])
        self.assertIn('quiz', hit['content_categories'])

        # 2. Direct desktop search enriches locator with real section_id, time_ranges and content_category.
        direct_res = library_search.search_notes('Connection reset')
        self.assertEqual(direct_res['total'], 1)
        d_hit = direct_res['results'][0]
        self.assertEqual(d_hit['section_id'], 'sec-pool')
        self.assertEqual(d_hit['content_category'], 'annotation:pit')
        self.assertEqual(d_hit['locator']['section_id'], 'sec-pool')
        self.assertEqual(len(d_hit['locator']['time_ranges']), 2)

        # 3. VectorStore structured chunker emits distinct categorized chunks with scalar Chroma-safe metadata.
        chunks = vector_store._chunk_structured_note(_sample_structured_doc())
        categories = {c['metadata']['content_category'] for c in chunks}
        self.assertTrue({'core_takeaways', 'body', 'annotation:why', 'annotation:pit', 'quiz'}.issubset(categories))
        for c in chunks:
            self.assertEqual(c['metadata']['section_id'], 'sec-pool')
            self.assertEqual(c['metadata']['source_type'], 'markdown')
            for val in c['metadata'].values():
                self.assertIsInstance(val, (str, int, float, bool))

    def test_1_6_media_range_streaming_and_sandbox_guards(self):
        video_file = self.root / 'sample_video.mp4'
        video_bytes = b'0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'
        video_file.write_bytes(video_bytes)
        self._create_structured_task('note-media-01', video_path=str(video_file))

        resolved = media_stream.resolve_note_media_path('note-media-01')
        self.assertEqual(resolved, video_file.resolve())
        self.assertEqual(media_stream.guess_media_type(resolved), 'video/mp4')

        # Valid RFC 7233 ranges
        self.assertEqual(media_stream.parse_http_range('bytes=0-9', len(video_bytes)), (0, 9))
        self.assertEqual(media_stream.parse_http_range('bytes=10-', len(video_bytes)), (10, len(video_bytes) - 1))
        self.assertEqual(media_stream.parse_http_range('bytes=-6', len(video_bytes)), (len(video_bytes) - 6, len(video_bytes) - 1))
        self.assertEqual(b''.join(media_stream.iter_file_range(resolved, 10, 15)), b'ABCDEF')

        # Unsatisfiable / malformed ranges raise ValueError (mapped to HTTP 416)
        for bad in ('bytes=999-1000', 'bytes=10-5', 'bytes=0-1,2-3', 'items=0-5', 'bytes=-'):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                media_stream.parse_http_range(bad, len(video_bytes))

        # Non-media extension or traversal path must be rejected
        secret_txt = self.root / 'secret.txt'
        secret_txt.write_text('top-secret', encoding='utf-8')
        self._create_structured_task('note-media-bad', video_path=str(secret_txt))
        with self.assertRaises(FileNotFoundError):
            media_stream.resolve_note_media_path('note-media-bad')

        self._create_structured_task('note-media-trav', video_path=str(self.root / '..' / 'sample_video.mp4'))
        with self.assertRaises(FileNotFoundError):
            media_stream.resolve_note_media_path('note-media-trav')

    def test_1_6_learning_state_atomic_persistence_and_review_bank_aggregation(self):
        self._create_structured_task('note-learn-01')

        # Initial empty state
        initial = learning_state.get_learning_state('note-learn-01')
        self.assertEqual(initial['quiz_attempts'], {})
        self.assertEqual(initial['pinned_annotations'], {})

        # Save wrong quiz attempt, pinned annotation, and checklist state
        updated = learning_state.update_learning_state('note-learn-01', {
            'quiz_attempts': {
                'sec-pool': {'selected_key': 'A', 'correct_key': 'B', 'short_prompt': '8核慢查询'},
            },
            'pinned_annotations': {
                'sec-pool:why-ctx': {'section_id': 'sec-pool', 'annotation_id': 'why-ctx', 'kind': 'why', 'pinned': True, 'note': '重点复盘'},
            },
            'checklist_states': {'sec-pool:c1': True},
        })
        self.assertFalse(updated['quiz_attempts']['sec-pool']['is_correct'])
        self.assertEqual(updated['quiz_attempts']['sec-pool']['attempt_count'], 1)
        self.assertTrue(updated['checklist_states']['sec-pool:c1'])

        # Library-wide review bank aggregates wrong quiz + pinned annotation + pit annotation
        bank = learning_state.query_review_bank(kind='all')
        self.assertEqual(bank['counts']['wrong_quizzes'], 1)
        self.assertEqual(bank['wrong_quizzes'][0]['selected_key'], 'A')
        self.assertEqual(bank['wrong_quizzes'][0]['correct_key'], 'B')
        self.assertEqual(bank['counts']['pit_annotations'], 2)  # pinned why-ctx + pit-timeout
        # Pinned entry is prioritized first
        self.assertTrue(bank['pit_annotations'][0]['pinned'])
        self.assertEqual(bank['pit_annotations'][0]['annotation_id'], 'why-ctx')
        self.assertEqual(bank['pit_annotations'][1]['annotation_id'], 'pit-timeout')

        # Re-answering correctly removes it from wrong_quizzes while incrementing attempt_count
        corrected = learning_state.update_learning_state('note-learn-01', {
            'quiz_attempts': {'sec-pool': {'selected_key': 'B', 'correct_key': 'B'}},
        })
        self.assertTrue(corrected['quiz_attempts']['sec-pool']['is_correct'])
        self.assertEqual(corrected['quiz_attempts']['sec-pool']['attempt_count'], 2)
        bank_after = learning_state.query_review_bank(kind='wrong_quiz')
        self.assertEqual(bank_after['counts']['wrong_quizzes'], 0)


if __name__ == '__main__':
    unittest.main()
