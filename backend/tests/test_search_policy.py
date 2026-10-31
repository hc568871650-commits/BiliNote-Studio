"""Verify search guidance reaches both chat entry points without live requests."""
import unittest
from datetime import datetime, timezone, timedelta
from unittest.mock import patch

from app.services import organizer, web_search
from app.services.search_tool import search_prompt
from tests import test_automatic_search as fixtures


class SearchPolicyTests(unittest.TestCase):
    setUp = fixtures.AutomaticSearchTests.setUp
    client = fixtures.AutomaticSearchTests.client
    reading = fixtures.AutomaticSearchTests.reading

    def assert_policy(self, prompt):
        for requirement in ('工具选型', '产品推荐', '软件/API版本', '用户明确禁止联网',
                            '纯改写', '翻译', '真实来源链接'):
            self.assertIn(requirement, prompt)
        self.assertIn(datetime.now(timezone(timedelta(hours=8))).date().isoformat(), prompt)

    def test_native_and_external_share_decision_boundaries(self):
        for mode in ('native', 'external'):
            with self.subTest(mode=mode):
                self.assert_policy(search_prompt(True, mode))
        self.assertEqual(search_prompt(False, 'external'), '')
        with patch.object(web_search, 'available', return_value=False):
            prompt = search_prompt(True, 'external')
        self.assertIn('尚不可用', prompt)
        self.assertNotIn('本轮可用 search_web', prompt)

    def test_reading_request_receives_policy_without_forcing_search(self):
        gpt = self.client('openai-chat', stream=True, calls=False)
        with patch.object(web_search, 'search_web') as search:
            self.reading(gpt, stream=True)
        self.assert_policy(self.wire[0]['messages'][0]['content'])
        search.assert_not_called()

    def test_library_request_receives_policy_without_forcing_search(self):
        gpt = self.client('openai-chat', stream=True, calls=False)
        with patch.object(organizer, 'get_client', return_value=gpt), \
                patch.object(organizer, '_run_library_tool', return_value={'results': []}), \
                patch.object(web_search, 'search_web') as search:
            organizer.answer('总结已给材料', 'test', 'synthetic', [], {}, {},
                             web_search_mode='external')
        self.assert_policy(self.wire[0]['messages'][0]['content'])
        search.assert_not_called()
