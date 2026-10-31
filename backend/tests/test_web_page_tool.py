import json
from unittest.mock import patch
from types import SimpleNamespace

import httpx

from tests.test_automatic_search import AutomaticSearchTests, SOURCE
from app.services import web_search, organizer
from app.services.search_tool import SearchToolSession, external_tools, search_prompt
from datetime import datetime, timezone, timedelta


class WebPageTests(AutomaticSearchTests):
    def setUp(self):
        super().setUp()
        web_search.save_settings(True, web_search.TAVILY_BASE_URL, 'tvly-synthetic-test', 'tavily')

    def session(self):
        session = SearchToolSession(True, 'external', SimpleNamespace(api_key='model-secret'))
        with patch.object(web_search, 'search_web', return_value=[SOURCE.copy()]):
            session.execute({'query': 'Python docs'})
        return session

    def test_invalid_unknown_and_credentials_never_sent(self):
        session = self.session()
        for url in ['http://localhost/', 'http://127.0.0.1/', 'http://10.0.0.1/', 'http://[::1]/',
                    'https://a:b@example.com/', 'https://example.com/?api_key=secret',
                    'https://example.com/model-secret', 'https://example.com/unknown']:
            with self.subTest(url=url), patch.object(web_search, 'read_web_page') as fetch:
                self.assertIn('error', session.read_page({'url': url}))
                fetch.assert_not_called()

    def test_read_budget_independent_and_cancellation(self):
        session = self.session()
        for i in range(3):
            session.sources.append({**SOURCE, 'url': f'https://example.com/{i}'})
        page = {'text': 'body', 'truncated': False, 'retrieved_at': 'today'}
        with patch.object(web_search, 'read_web_page', return_value=page) as fetch:
            for i in range(3):
                result = session.read_page({'url': f'https://example.com/{i}'})
            self.assertEqual(fetch.call_count, 2)
            self.assertIn('error', result)
        self.assertEqual(session.attempts, 1)
        session = self.session()
        cancel = {'cancelled': False}
        session.cancellation = cancel
        def late(_, **kwargs):
            cancel['cancelled'] = True
            return page
        with patch.object(web_search, 'read_web_page', side_effect=late):
            with self.assertRaisesRegex(ValueError, '取消'):
                session.read_page({'url': SOURCE['url']})
        self.assertFalse(session.page_cache)
        self.assertNotIn('evidence_type', session.sources[0])

    def test_page_tool_offered_for_searxng(self):
        web_search.save_settings(True, 'https://search.invalid', '', 'searxng')
        self.assertEqual([t['function']['name'] for t in external_tools()], ['search_web', 'read_web_page'])

    def test_prompt_has_current_shanghai_date_and_no_freshness_guarantee(self):
        prompt = search_prompt(True, 'external')
        self.assertIn(datetime.now(timezone(timedelta(hours=8))).date().isoformat(), prompt)
        self.assertIn('已读取不等于已核实最新', prompt)

    def test_failed_page_cached_without_success_evidence(self):
        session = self.session()
        with patch.object(web_search, 'read_web_page', side_effect=ValueError('HTTP 403')) as fetch:
            first = session.read_page({'url': SOURCE['url']})
            self.assertEqual(first, session.read_page({'url': SOURCE['url'] + '#fragment'}))
            fetch.assert_called_once()
        self.assertIn('error', first)
        self.assertNotIn('evidence_type', session.sources[0])

    def test_trailing_slash_matches_but_uses_original_source(self):
        session = self.session()
        session.sources = [{**SOURCE, 'url': 'https://example.com/downloads'}]
        page = {'text': 'Current', 'truncated': False, 'retrieved_at': 'today'}
        with patch.object(web_search, 'read_web_page', return_value=page) as fetch:
            result = session.read_page({'url': 'https://example.com/downloads/'})
            self.assertNotIn('error', result)
            fetch.assert_called_once_with('https://example.com/downloads', cancellation=None)
            for url in ['https://example.com/downloads//', 'https://example.com/downloads/?key=value', 'https://other.example.com/downloads/']:
                self.assertIn('error', session.read_page({'url': url}))
            self.assertEqual(fetch.call_count, 1)

    def test_organizer_search_read_answer(self):
        gpt = self.client('openai-chat', stream=True, read_page=True)
        page = {'url': SOURCE['url'], 'text': 'Current page', 'truncated': False, 'retrieved_at': 'today'}
        sources, context, events = [], {}, []
        with patch.object(organizer, 'get_client', return_value=gpt), patch.object(organizer, '_run_library_tool', return_value={'results': []}), patch.object(web_search, 'search_web', return_value=[SOURCE.copy()]), patch.object(web_search, 'read_web_page', return_value=page):
            result = organizer.answer('Question', 'test', 'synthetic', [], {}, {}, web_search_mode='external', sources_sink=sources, context_sink=context, event_sink=events.append)
        self.assertEqual(result, 'Answer')
        self.assertEqual(len(sources), 1)
        self.assertEqual(sources[0]['evidence_type'], 'page')
        self.assertTrue(any(e.get('phase') == 'reading_web' for e in events))

    def test_search_read_answer_all_protocols(self):
        page = {'url': SOURCE['url'], 'text': 'Current official page', 'truncated': False,
                'retrieved_at': '2026-10-15', 'evidence_type': 'page'}
        for protocol, stream in [('openai-chat', False), ('openai-chat', True), ('openai-responses', False), ('anthropic', False), ('gemini', False)]:
            with self.subTest(protocol=protocol, stream=stream):
                gpt = self.client(protocol, stream, read_page=True)
                with patch.object(web_search, 'search_web', return_value=[SOURCE.copy()]), patch.object(web_search, 'read_web_page', return_value=page) as fetch:
                    result = self.reading(gpt, protocol, stream)
                fetch.assert_called_once_with(SOURCE['url'], cancellation=None)
                self.assertEqual(len(self.wire), 3)
                self.assertIn('Current official page', json.dumps(self.wire[-1]))
                self.assertEqual(len([s for s in result['sources'] if s.get('url') == SOURCE['url']]), 1)
                self.assertTrue(result['context']['web_search_used'])
