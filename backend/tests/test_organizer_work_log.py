"""Work progress stays recoverable without becoming the final answer or context."""
import json
import threading
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
from unittest.mock import patch

from app.services import organizer, organizer_sessions as sessions
from tests import test_organizer_sessions as fixtures


class OrganizerWorkLogTests(unittest.TestCase):
    setUp = fixtures.OrganizerSessionsTest.setUp
    client = fixtures.OrganizerSessionsTest.client
    message = fixtures.OrganizerSessionsTest.message

    def response(self, content, tool=False):
        calls = [SimpleNamespace(id='local-read', function=SimpleNamespace(
            name='search_library', arguments='{"query":"教程"}'))] if tool else None
        return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(
            content=content, tool_calls=calls))]), {'input_tokens': 100}

    def test_completed_answer_and_followup_context_exclude_work_log(self):
        calls = []

        def complete(client, model, messages, **kwargs):
            calls.append(messages.copy())
            progress = len(calls) == 1
            text = '先查阅相关笔记。' if progress else '最终答案。'
            kwargs['event_sink']({'type': 'delta', 'text': text})
            return self.response(text, tool=progress)

        with patch.object(organizer, '_complete_stream', side_effect=complete):
            result = self.message('请解释这个软件怎么使用', web_search=False)
            self.assertEqual(result['history'][-1]['content'], '最终答案。')
            self.assertEqual(result['history'][-1]['work_log'], ['先查阅相关笔记。'])
            self.assertEqual(sessions.get(result['session_id'])['history'][-1]['work_log'], ['先查阅相关笔记。'])
            self.message('再解释一下', web_search=False)
        history = json.loads(calls[-1][1]['content'])['history']
        self.assertTrue(any(item['content'] == '最终答案。' for item in history))
        self.assertNotIn('先查阅相关笔记', json.dumps(history, ensure_ascii=False))
        self.assertNotIn('work_log', json.dumps(sessions._active_history(result)))
        self.assertEqual(result['streaming_reply'], '')
        self.assertEqual(result['streaming_work_log'], [])
        self.assertEqual(result['streaming_phase'], '')

    def test_empty_tool_round_still_emits_boundary(self):
        events, progress = [], []
        responses = iter([self.response('先查阅。', tool=True), self.response('', tool=True), self.response('结论。')])
        with patch.object(organizer, '_complete_stream', side_effect=lambda *a, **k: next(responses)):
            answer = organizer.answer('如何使用', 'fake', 'fake', [], '', '', web_search=False,
                event_sink=events.append, work_log_sink=progress)
        self.assertEqual(answer, '结论。')
        self.assertEqual(progress, ['先查阅。'])
        self.assertEqual([event['text'] for event in events if event['type'] == 'work_log'], ['先查阅。', ''])

    def test_failure_keeps_completed_progress_and_unflushed_partial(self):
        calls = 0

        def complete(client, model, messages, **kwargs):
            nonlocal calls
            calls += 1
            emit = kwargs['event_sink']
            if calls == 1:
                emit({'type': 'delta', 'text': '查阅笔记。'})
                return self.response('查阅笔记。', tool=True)
            emit({'type': 'delta', 'text': '未完成的'})
            emit({'type': 'delta', 'text': '后半段'})
            raise RuntimeError('synthetic upstream failure')

        with patch.object(organizer, '_complete_stream', side_effect=complete), \
             patch.object(sessions.time, 'monotonic', return_value=10):
            result = self.message('请解释这个软件怎么使用', web_search=False)
        self.assertEqual(result['status'], 'failed')
        self.assertEqual(result['history'][-1]['work_log'], ['查阅笔记。', '未完成的后半段'])
        self.assertNotIn('未完成的后半段', result['history'][-1]['content'])
        self.assertEqual(result['streaming_work_log'], [])
        self.assertEqual(result['streaming_reply'], '')
        self.assertEqual(result['streaming_phase'], '')

    def test_live_progress_and_cancel_preserve_work_without_late_answer(self):
        waiting, release = threading.Event(), threading.Event()
        calls = 0

        def complete(client, model, messages, **kwargs):
            nonlocal calls
            calls += 1
            emit = kwargs['event_sink']
            if calls == 1:
                emit({'type': 'delta', 'text': '先查阅笔记。'})
                return self.response('先查阅笔记。', tool=True)
            emit({'type': 'delta', 'text': '继续核对'})
            emit({'type': 'delta', 'text': '细节'})
            waiting.set()
            if not release.wait(5):
                raise RuntimeError('test timeout')
            return self.response('晚到结论。')

        sid = self.session['session_id']
        with patch.object(organizer, '_complete_stream', side_effect=complete), \
             patch.object(sessions.time, 'monotonic', return_value=10), \
             ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(self.message, '请解释这个软件怎么使用', web_search=False)
            try:
                self.assertTrue(waiting.wait(5))
                live = sessions.get(sid)
                self.assertEqual(live['streaming_work_log'], ['先查阅笔记。'])
                self.assertEqual(live['streaming_phase'], 'generating')
                self.assertEqual(live['streaming_reply'], '继续核对')
                result = sessions.action(sid, 'cancel', {'expected_revision': live['revision'],
                                                        'request_id': uuid.uuid4().hex})
                self.assertEqual(result['history'][-1]['work_log'], ['先查阅笔记。', '继续核对细节'])
            finally:
                release.set()
            finished = future.result(5)
        self.assertEqual(finished['status'], 'cancelled')
        self.assertNotIn('晚到结论', json.dumps(finished, ensure_ascii=False))
        self.assertEqual(finished['streaming_reply'], '')
        self.assertEqual(finished['streaming_work_log'], [])
        self.assertEqual(finished['streaming_phase'], '')

    def test_tool_round_clears_stream_before_next_model_request(self):
        calls = 0

        def complete(client, model, messages, **kwargs):
            nonlocal calls
            calls += 1
            if calls == 1:
                kwargs['event_sink']({'type': 'delta', 'text': '先查阅。'})
                return self.response('先查阅。', tool=True)
            live = sessions.get(self.session['session_id'])
            self.assertEqual(live['streaming_reply'], '')
            self.assertEqual(live['streaming_work_log'], ['先查阅。'])
            return self.response('结论。')

        with patch.object(organizer, '_complete_stream', side_effect=complete):
            result = self.message('请解释这个软件怎么使用', web_search=False)
        self.assertEqual(result['status'], 'completed')

