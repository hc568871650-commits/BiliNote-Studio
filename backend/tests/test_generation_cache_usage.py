"""Offline provider metadata checks; no model requests or user data."""
import contextlib
import io
import json
import types
import unittest

from .test_universal_gpt_content_format import UniversalGPT


class GenerationCacheUsageTests(unittest.TestCase):
    def test_deepseek_and_compatible_usage(self):
        for usage in (
            {'prompt_tokens': 100, 'completion_tokens': 20, 'prompt_cache_hit_tokens': 64,
             'prompt_cache_miss_tokens': 36},
            types.SimpleNamespace(prompt_tokens=100, completion_tokens=20,
                                  prompt_tokens_details=types.SimpleNamespace(cached_tokens=64)),
        ):
            result = UniversalGPT._usage_metrics(types.SimpleNamespace(usage=usage))
            self.assertEqual(result['cache_hit_tokens'], 64)
            self.assertEqual(result['cache_status'], 'hit')
            self.assertEqual(result['prompt_tokens'], 100)

    def test_missing_invalid_and_explicit_zero_are_distinct(self):
        for usage in (None, {}, {'prompt_cache_hit_tokens': -1},
                      {'prompt_cache_hit_tokens': 'secret'}, {'prompt_cache_hit_tokens': True}):
            result = UniversalGPT._usage_metrics({'usage': usage})
            self.assertIsNone(result['cache_hit_tokens'])
            self.assertEqual(result['cache_status'], 'not_reported')
        result = UniversalGPT._usage_metrics({'usage': {'prompt_cache_hit_tokens': 0,
            'prompt_tokens_details': {'cached_tokens': 80}}})
        self.assertEqual(result['cache_status'], 'miss')
        self.assertEqual(result['cache_hit_tokens'], 0)

    def test_request_logs_only_numeric_usage_without_extra_calls(self):
        gpt = UniversalGPT.__new__(UniversalGPT)
        gpt._max_retry_attempts = 1
        reply = types.SimpleNamespace(usage={'prompt_tokens': 100, 'prompt_cache_hit_tokens': 0,
                                            'private': 'DO_NOT_LOG'})
        calls = []
        def create(messages):
            calls.append(messages)
            return reply
        gpt._do_create = create
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            self.assertIs(gpt._chat_completion_create([{'content': 'DO_NOT_LOG'}]), reply)
        self.assertEqual(len(calls), 1)
        self.assertNotIn('DO_NOT_LOG', output.getvalue())
        metrics = json.loads(output.getvalue().split('usage=', 1)[1])
        self.assertEqual(metrics['cache_status'], 'miss')


if __name__ == '__main__':
    unittest.main()
