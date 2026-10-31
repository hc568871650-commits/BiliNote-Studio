"""Session-scoped page snapshots and bounded, private tool-event records."""
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from app.services import web_search, web_page
from app.services.search_tool import SearchToolSession, PAGE_TOOL
from tests.test_web_page_reader import Response


SOURCE = {'source_type': 'web', 'source_id': 'official', 'url': 'https://example.com/manual',
          'title': 'Official manual', 'text': 'Search snippet'}


class PagePagingTests(unittest.TestCase):
    def test_malformed_nested_arguments_are_not_persisted_as_trace_payloads(self):
        session = self.session()
        session.execute({'query': {'api_key': 'unknown-private-value'}})
        session.read_page({'url': {'Cookie': 'unknown-cookie-value'}})
        serialized = json.dumps(session.events, ensure_ascii=False)
        self.assertNotIn('unknown-private-value', serialized)
        self.assertNotIn('unknown-cookie-value', serialized)
        self.assertTrue(all(not isinstance(record.get('url'), dict) and not isinstance(record.get('query'), dict) for record in session.events))

    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        settings = patch.object(web_search, 'SETTINGS_PATH', Path(directory.name) / 'search.json')
        settings.start()
        self.addCleanup(settings.stop)
        web_search.save_settings(True, web_search.TAVILY_BASE_URL, 'account-private-secret', 'tavily')

    def session(self, **limits):
        session = SearchToolSession(True, 'external', SimpleNamespace(api_key='model-private-secret'), **limits)
        with patch.object(web_search, 'search_web', return_value=[SOURCE.copy()]):
            session.execute({'query': 'Official manual current version'})
        return session

    @staticmethod
    def page(text, **details):
        return {'url': SOURCE['url'], 'final_url': SOURCE['url'], 'text': text,
                'truncated': False, 'evidence_type': 'page',
                'retrieved_at': '2026-10-15T08:00:00+00:00', **details}

    @staticmethod
    def next_request(page, **changes):
        return {'url': page['url'], 'snapshot_id': page['snapshot_id'],
                'offset': page['next_offset'], **changes}

    def test_sequential_read_reaches_answer_after_old_twenty_thousand_limit(self):
        session = self.session()
        text = 'a' * 21500 + 'ANSWER_AFTER_20000' + 'z' * 4200
        pages = []
        with patch.object(web_search, 'read_web_page', return_value=self.page(text)) as fetch:
            result = session.read_page({'url': SOURCE['url']})
            while True:
                page = result['results'][0]
                pages.append(page)
                if page['next_offset'] is None:
                    break
                result = session.read_page(self.next_request(page))
            fetch.assert_called_once_with(SOURCE['url'], cancellation=None)
        self.assertEqual(''.join(page['text'] for page in pages), text)
        self.assertNotIn('ANSWER_AFTER_20000', pages[0]['text'])
        self.assertIn('ANSWER_AFTER_20000', pages[2]['text'])
        self.assertEqual([page['offset'] for page in pages], [0, 8000, 16000, 24000])
        self.assertEqual(len({page['snapshot_id'] for page in pages}), 1)
        self.assertFalse(pages[-1]['truncated'])
        self.assertFalse(pages[-1]['budget_exhausted'])
        self.assertEqual(len(session.sources), 1)
        self.assertTrue(session.sources[0]['read_complete'])
        self.assertEqual(session.sources[0]['read_characters'], len(text))
        self.assertEqual(session.events[-1]['service'], 'tavily')

    def test_wrong_cursor_cross_url_and_cross_session_never_fetch(self):
        session = self.session()
        other = {**SOURCE, 'url': 'https://example.com/other'}
        session.sources.append(other)
        with patch.object(web_search, 'read_web_page', return_value=self.page('x' * 24000)) as fetch:
            page = session.read_page({'url': SOURCE['url']})['results'][0]
            invalid = [self.next_request(page, offset=16000), self.next_request(page, offset=-1),
                       self.next_request(page, snapshot_id='forged'),
                       self.next_request(page, url=other['url']),
                       {'url': SOURCE['url'], 'offset': 8000},
                       {'url': SOURCE['url'], 'snapshot_id': page['snapshot_id'], 'offset': True}]
            for request in invalid:
                with self.subTest(request=request):
                    self.assertIn('error', session.read_page(request))
                    self.assertEqual(session.events[-1]['status'], 'blocked')
            another_session = self.session()
            self.assertIn('error', another_session.read_page(self.next_request(page)))
            self.assertEqual(fetch.call_count, 1)
            self.assertEqual(session.page_calls, 1)
            self.assertEqual(session.page_characters, 8000)

    def test_later_answer_fetches_a_new_snapshot_instead_of_global_cache(self):
        first, later = self.session(), self.session()
        with patch.object(web_search, 'read_web_page', side_effect=[self.page('old body'), self.page('new body')]) as fetch:
            old_page = first.read_page({'url': SOURCE['url']})['results'][0]
            new_page = later.read_page({'url': SOURCE['url']})['results'][0]
            self.assertEqual(fetch.call_count, 2)
        self.assertEqual(old_page['text'], 'old body')
        self.assertEqual(new_page['text'], 'new body')
        self.assertNotEqual(old_page['snapshot_id'], new_page['snapshot_id'])

    def test_repeated_segment_uses_cache_but_still_bounds_model_input(self):
        session = self.session(page_text_budget=16000)
        with patch.object(web_search, 'read_web_page', return_value=self.page('x' * 30000)) as fetch:
            first = session.read_page({'url': SOURCE['url']})['results'][0]
            repeated = session.read_page({'url': SOURCE['url'] + '#ignored'})['results'][0]
            self.assertEqual(first['text'], repeated['text'])
            self.assertEqual(first['snapshot_id'], repeated['snapshot_id'])
            self.assertTrue(repeated['budget_exhausted'])
            self.assertIsNone(repeated['next_offset'])
            self.assertEqual(session.events[-1]['status'], 'cached')
            self.assertIn('error', session.read_page(self.next_request(first)))
            fetch.assert_called_once()
        self.assertEqual(session.page_characters, 16000)

    def test_small_budget_returns_shorter_segment_and_no_continuation(self):
        session = self.session(page_text_budget=1024)
        with patch.object(web_search, 'read_web_page', return_value=self.page('x' * 30000)) as fetch:
            page = session.read_page({'url': SOURCE['url']})['results'][0]
            self.assertEqual(len(page['text']), 1024)
            self.assertTrue(page['budget_exhausted'])
            self.assertTrue(page['truncated'])
            self.assertIsNone(page['next_offset'])
            self.assertIn('error', session.read_page({'url': SOURCE['url']}))
            fetch.assert_called_once()
        self.assertFalse(session.sources[0]['read_complete'])

    def test_zero_budget_or_call_limit_never_fetch(self):
        for limits in ({'page_text_budget': 0}, {'page_call_limit': 0}):
            with self.subTest(limits=limits), patch.object(web_search, 'read_web_page') as fetch:
                session = self.session(**limits)
                self.assertIn('error', session.read_page({'url': SOURCE['url']}))
                fetch.assert_not_called()

    def test_call_limit_and_global_character_limit_cannot_be_raised(self):
        session = self.session(page_call_limit=2, page_chunk_size=6000)
        with patch.object(web_search, 'read_web_page', return_value=self.page('x' * 50000)):
            first = session.read_page({'url': SOURCE['url']})['results'][0]
            second = session.read_page(self.next_request(first))['results'][0]
            self.assertIsNone(second['next_offset'])
            self.assertTrue(second['budget_exhausted'])
        session = self.session(page_text_budget=900000, page_call_limit=100, page_chunk_size=90000)
        self.assertEqual((session.page_text_budget, session.page_call_limit, session.page_chunk_size), (40000, 6, 10000))
        with patch.object(web_search, 'read_web_page', return_value=self.page('x' * 100000)):
            result = session.read_page({'url': SOURCE['url']})
            while result['results'][0]['next_offset'] is not None:
                result = session.read_page(self.next_request(result['results'][0]))
        self.assertEqual(session.page_characters, 40000)
        self.assertTrue(result['results'][0]['budget_exhausted'])

    def test_two_url_limit_and_no_refetch_during_continuation(self):
        session = self.session()
        session.sources.extend({**SOURCE, 'url': f'https://example.com/manual-{i}'} for i in (2, 3))
        with patch.object(web_search, 'read_web_page', return_value=self.page('x' * 9000)) as fetch:
            first = session.read_page({'url': SOURCE['url']})['results'][0]
            session.read_page(self.next_request(first))
            session.read_page({'url': 'https://example.com/manual-2'})
            self.assertIn('error', session.read_page({'url': 'https://example.com/manual-3'}))
            self.assertEqual(fetch.call_count, 2)
        self.assertEqual(session.page_attempts, 2)

    def test_retention_truncation_is_not_reported_as_complete(self):
        session = self.session(page_chunk_size=10000)
        with patch.object(web_search, 'read_web_page', return_value=self.page('x' * 10000, truncated=True, total_length=140000)):
            page = session.read_page({'url': SOURCE['url']})['results'][0]
        self.assertEqual(page['total_length'], 140000)
        self.assertEqual(page['retained_length'], 10000)
        self.assertTrue(page['truncated'])
        self.assertIsNone(page['next_offset'])
        self.assertFalse(page['budget_exhausted'])
        self.assertFalse(session.sources[0]['read_complete'])

    def test_cancelled_fetch_never_caches_or_marks_read(self):
        session = self.session()
        cancellation = {'cancelled': False}
        session.cancellation = cancellation
        def cancelled_page(*args, **kwargs):
            cancellation['cancelled'] = True
            return self.page('SHOULD_NOT_BE_DELIVERED')
        with patch.object(web_search, 'read_web_page', side_effect=cancelled_page):
            with self.assertRaisesRegex(ValueError, '取消'):
                session.read_page({'url': SOURCE['url']})
        self.assertFalse(session.page_cache)
        self.assertFalse(session._snapshots)
        self.assertNotIn('evidence_type', session.sources[0])
        self.assertEqual([event['status'] for event in session.events], ['succeeded', 'blocked'])
        self.assertNotIn('SHOULD_NOT_BE_DELIVERED', json.dumps(session.events))

    def test_failed_fetch_cached_errors_and_trace_redact_keys_and_cookies(self):
        session = self.session()
        message = 'HTTP 403 model-private-secret account-private-secret Cookie=secret-cookie'
        with patch.object(web_search, 'read_web_page', side_effect=ValueError(message)) as fetch:
            result = session.read_page({'url': SOURCE['url']})
            session.read_page({'url': SOURCE['url']})
            fetch.assert_called_once()
        combined = json.dumps([result, session.events])
        for private in ('model-private-secret', 'account-private-secret', 'secret-cookie'):
            self.assertNotIn(private, combined)
        self.assertEqual([event['status'] for event in session.events], ['succeeded', 'failed', 'cached'])
        self.assertNotIn('evidence_type', session.sources[0])

    def test_trace_has_no_page_body_and_is_bounded(self):
        session = self.session()
        with patch.object(web_search, 'read_web_page', return_value=self.page('PRIVATE_PAGE_BODY')):
            session.read_page({'url': SOURCE['url']})
        for _ in range(50):
            session.execute({'query': 'Official manual current version'})
        self.assertEqual(len(session.events), 32)
        self.assertNotIn('PRIVATE_PAGE_BODY', json.dumps(session.events))
        self.assertNotIn('Search snippet', json.dumps(session.events))
        self.assertTrue(all('id' in e and 'occurred_at' in e and 'elapsed_ms' in e for e in session.events))

    def test_search_failure_cache_and_error_record_do_not_echo_request(self):
        session = self.session()
        message = 'HTTP 429 request body: {"messages": "PRIVATE_CONVERSATION", "api_key": "UNKNOWN_KEY"}'
        with patch.object(web_search, 'search_web', side_effect=ValueError(message)) as search:
            first = session.execute({'query': 'Another public search'})
            session.execute({'query': 'Another public search'})
            search.assert_called_once()
        combined = json.dumps([first, session.events])
        self.assertNotIn('PRIVATE_CONVERSATION', combined)
        self.assertNotIn('UNKNOWN_KEY', combined)
        self.assertEqual([e['status'] for e in session.events[-2:]], ['failed', 'cached'])

    def test_search_trace_query_is_short_and_cancelled_search_is_blocked(self):
        session = self.session()
        with patch.object(web_search, 'search_web', return_value=[SOURCE.copy()]):
            session.execute({'query': 'x' * 1000})
        self.assertEqual(len(session.events[-1]['query']), 240)
        session.cancellation = {'cancelled': True}
        with self.assertRaisesRegex(ValueError, '取消'):
            session.execute({'query': 'not sent'})
        self.assertEqual(session.events[-1]['status'], 'blocked')
        self.assertNotIn('query', session.events[-1])

    def test_credentials_rejected_without_echoing_query_or_url(self):
        session = self.session()
        with patch.object(web_search, 'search_web') as search, patch.object(web_search, 'read_web_page') as fetch:
            session.execute({'query': 'find account-private-secret'})
            session.read_page({'url': 'https://example.com/model-private-secret'})
            search.assert_not_called()
            fetch.assert_not_called()
        self.assertNotIn('private-secret', json.dumps(session.events))
        self.assertNotIn('query', session.events[-2])
        self.assertNotIn('url', session.events[-1])

    def test_page_tool_schema_supports_explicit_snapshot_continuation(self):
        parameters = PAGE_TOOL['function']['parameters']
        self.assertEqual(parameters['required'], ['url'])
        self.assertEqual(parameters['properties']['offset']['type'], 'integer')
        self.assertIn('snapshot_id', parameters['properties'])
        self.assertFalse(parameters['additionalProperties'])


class PageRetentionTests(unittest.TestCase):
    def test_reader_retains_one_hundred_thousand_not_only_twenty_thousand(self):
        connection = SimpleNamespace(sock=None, active_socket=None, request=lambda *a, **k: None,
                                     getresponse=lambda: Response(b'x' * 120000, Content_Type='text/plain'), close=lambda: None)
        with patch.object(web_page, 'resolve_public', return_value=['93.184.216.34']), patch.object(web_page, 'PinnedHTTPSConnection', return_value=connection):
            page = web_page.read_page('https://example.com/manual')
        self.assertEqual(len(page['text']), 100000)
        self.assertEqual(page['total_length'], 120000)
        self.assertEqual(page['retained_length'], 100000)
        self.assertTrue(page['truncated'])
