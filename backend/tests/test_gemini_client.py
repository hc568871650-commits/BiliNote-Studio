"""Native Gemini synthetic transport tests; no credentials or external requests."""
import json
import unittest

import httpx

from app.services.gemini_client import GeminiClient, gemini_base_url, gemini_options, gemini_response, gemini_stream
from app.utils.ai_errors import ProtocolResponseError


def answer(parts=None, finish='STOP', metadata=None):
    candidate = {'index': 0, 'content': {'parts': parts or [{'text': '答案'}]}}
    if finish:
        candidate['finishReason'] = finish
    if metadata:
        candidate['groundingMetadata'] = metadata
    return {'candidates': [candidate], 'usageMetadata': {'promptTokenCount': 12, 'candidatesTokenCount': 4}}


def drain(iterator):
    events = []
    while True:
        try:
            events.append(next(iterator))
        except StopIteration as end:
            return events, end.value


class GeminiClientTest(unittest.TestCase):
    def client(self, handler):
        client = GeminiClient('synthetic-secret', 'https://synthetic.invalid/proxy/v1',
                              http_client=httpx.Client(transport=httpx.MockTransport(handler)))
        self.addCleanup(client.close)
        return client

    def test_url_preserves_prefix_and_host(self):
        for suffix in ('', '/v1', '/v1beta', '/v1beta/models/old:generateContent', '/v1beta/models/old:streamGenerateContent'):
            self.assertEqual(gemini_base_url('https://synthetic.invalid/proxy' + suffix),
                             'https://synthetic.invalid/proxy/v1beta')
        for url in ('https://user:pass@host', 'https://host/?key=secret', 'ftp://host', 'https://host/#x'):
            with self.assertRaises(ValueError):
                gemini_base_url(url)

    def test_wire_and_signed_function_roundtrip(self):
        wire = []
        first = [{'text': 'hidden', 'thought': True},
                 {'functionCall': {'name': 'read_note', 'args': {'id': 'x'}}, 'thoughtSignature': 'signature'}]
        def handler(request):
            self.assertEqual(str(request.url), 'https://synthetic.invalid/proxy/v1beta/models/gemini-3.8-flash:generateContent')
            self.assertEqual(request.headers['x-goog-api-key'], 'synthetic-secret')
            wire.append(json.loads(request.content))
            return httpx.Response(200, json=answer(first if len(wire) == 1 else None), headers={'x-request-id': 'r1'})
        client = self.client(handler)
        messages = [{'role': 'system', 'content': 'rules'}, {'role': 'user', 'content': [
            {'type': 'text', 'text': 'question'}, {'type': 'image_url', 'image_url': {'url': 'data:image/png;base64,cGlj'}}]}]
        tools = [{'type': 'function', 'function': {'name': 'read_note', 'parameters': {'type': 'object', 'additionalProperties': False}}},
                 {'type': 'web_search'}]
        response = client.create(model='gemini-3.8-flash', messages=messages, tools=tools, reasoning_effort='medium', max_tokens=500)
        self.assertEqual(response.choices[0].message.content, '')
        self.assertEqual(response.raw_usage['promptTokenCount'], 12)
        self.assertEqual(response.request_id, 'r1')
        self.assertEqual(wire[0]['generationConfig'], {'thinkingConfig': {'thinkingLevel': 'medium'}, 'maxOutputTokens': 500})
        self.assertEqual(wire[0]['tools'][0], {'googleSearch': {}})
        self.assertEqual(wire[0]['contents'][0]['parts'][1]['inlineData']['mimeType'], 'image/png')
        call = response.choices[0].message.tool_calls[0]
        messages.extend([response.choices[0].message, {'role': 'tool', 'tool_call_id': call.id, 'content': '{"text":"note"}'}])
        client.create(model='gemini-3.8-flash', messages=messages)
        self.assertEqual(wire[1]['contents'][1]['parts'], first)
        self.assertEqual(wire[1]['contents'][2]['parts'][0]['functionResponse'], {'name': 'read_note', 'response': {'result': {'text': 'note'}}})

    def test_explicit_unsupported_options_are_not_ignored(self):
        for model, effort in [('gemini-2.5-flash', 'low'), ('gemini-3-pro-preview', 'medium'), ('gemini-3.8-flash', 'none')]:
            with self.assertRaises(ValueError):
                gemini_options(model, [], {'reasoning_effort': effort})
        for options in ({'unexpected': 1}, {'tool_choice': {'type': 'web_search'}}):
            with self.assertRaises(ValueError):
                gemini_options('gemini-3.8-flash', [], options)
        with self.assertRaises(ValueError):
            gemini_options('gemini-3.8-flash', [{'role': 'user', 'content': [{'type': 'image_url', 'image_url': {'url': 'https://remote/image.png'}}]}], {})

    def test_search_evidence_and_safe_sources(self):
        metadata = {'webSearchQueries': ['latest'], 'groundingChunks': [
            {'web': {'uri': 'https://source.invalid/page', 'title': 'source'}},
            {'web': {'uri': 'javascript:alert(1)'}}, {'web': {'uri': 'https://user:pass@host/x'}}],
            'groundingSupports': [{'groundingChunkIndices': [0]}], 'searchEntryPoint': {'renderedContent': 'suggestions'}}
        response = gemini_response(answer(metadata=metadata))
        self.assertTrue(response.web_search_used)
        self.assertEqual(len(response.web_sources), 1)
        self.assertEqual(response.search_entry_point['renderedContent'], 'suggestions')
        self.assertEqual(response.web_sources[0]['search_suggestions_html'], 'suggestions')
        self.assertEqual(response.web_sources[0]['search_provider'], 'google')
        metadata['searchEntryPoint']['renderedContent'] = '大' * 17000
        self.assertNotIn('search_suggestions_html', gemini_response(answer(metadata=metadata)).web_sources[0])
        metadata['webSearchQueries'] = []
        self.assertFalse(gemini_response(answer(metadata=metadata)).web_search_used)
        self.assertFalse(gemini_response(answer([{'text': 'https://source.invalid/page'}])).web_search_used)
        with self.assertRaises(ValueError):
            gemini_response(answer(finish=None))
        with self.assertRaises(ProtocolResponseError):
            gemini_response({'error': {'code': 503, 'message': 'unavailable'}})
        with self.assertRaises(ValueError):
            gemini_response(answer(finish='MALFORMED_FUNCTION_CALL'))
        self.assertEqual(gemini_response(answer(finish='MAX_TOKENS')).choices[0].finish_reason, 'length')
        self.assertEqual(gemini_response(answer(finish='SAFETY')).choices[0].finish_reason, 'content_filter')

    def test_stream_function_signature_replay_and_http_error(self):
        signed = {'functionCall': {'name': 'read', 'args': {'id': 1}}, 'thoughtSignature': 'signature'}
        def handler(request):
            return httpx.Response(200, content='data: ' + json.dumps(answer([signed])) + '\n\n')
        _, response = drain(gemini_stream(self.client(handler), 'gemini-3.8-flash', [], {}))
        call = response.choices[0].message.tool_calls[0]
        payload = gemini_options('gemini-3.8-flash', [response.choices[0].message,
            {'role': 'tool', 'tool_call_id': call.id, 'content': 'text'}], {})
        self.assertEqual(payload['contents'][0]['parts'], [signed])
        self.assertEqual(payload['contents'][1]['parts'][0]['functionResponse']['name'], 'read')
        failing = self.client(lambda request: httpx.Response(503, json={'error': {'message': 'unavailable'}}))
        with self.assertRaises(httpx.HTTPStatusError):
            failing.create(model='gemini-3.8-flash', messages=[])
        with self.assertRaises(httpx.HTTPStatusError):
            drain(gemini_stream(failing, 'gemini-3.8-flash', [], {}))

    def test_stream_text_metadata_signature_and_finish(self):
        chunks = [answer([{'text': 'hidden', 'thought': True}, {'text': 'first', 'thoughtSignature': 'sig'}], finish=None),
                  answer([{'text': 'second'}], metadata={'webSearchQueries': ['query'],
                         'groundingChunks': [{'web': {'uri': 'https://source.invalid'}}]})]
        def handler(request):
            self.assertEqual(request.url.path, '/proxy/v1beta/models/gemini-3.8-flash:streamGenerateContent')
            self.assertEqual(request.url.query, b'alt=sse')
            return httpx.Response(200, content=''.join('data: ' + json.dumps(c) + '\n\n' for c in chunks),
                                  headers={'content-type': 'text/event-stream'})
        events, response = drain(gemini_stream(self.client(handler), 'gemini-3.8-flash', [], {}))
        self.assertEqual(events, [{'type': 'delta', 'text': 'first'}, {'type': 'delta', 'text': 'second'}])
        self.assertEqual(response.choices[0].message.content, 'firstsecond')
        self.assertEqual(response.choices[0].message.native[1]['thoughtSignature'], 'sig')
        self.assertTrue(response.web_search_used)
        self.assertEqual(response.usage.prompt_tokens, 12)

    def test_truncated_stream_and_cancel(self):
        def handler(request):
            return httpx.Response(200, content='data: ' + json.dumps(answer(finish=None)) + '\n\n')
        client = self.client(handler)
        with self.assertRaises(ValueError):
            drain(gemini_stream(client, 'gemini-3.8-flash', [], {}))
        with self.assertRaises(ValueError):
            drain(gemini_stream(client, 'gemini-3.8-flash', [], {}, {'cancelled': True}))


if __name__ == '__main__':
    unittest.main()
