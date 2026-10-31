import json
import unittest
from types import SimpleNamespace

import httpx
from openai import OpenAI

from app.models.ai_requests import AskRequest
from app.services.ai_runtime import complete
from app.services.native_search import anthropic_search, chat_sources
from app.services.protocol_clients import AnthropicClient, anthropic_options
from app.services.model_capabilities import _probe
from app.services.gemini_client import gemini_base_url
from app.utils.ai_errors import ProtocolResponseError


def drain(iterator):
    while True:
        try:
            next(iterator)
        except StopIteration as end:
            return end.value


class NativeSearchProtocolsTests(unittest.TestCase):
    def test_chat_wire_annotations_enable_search_without_changing_protocol(self):
        captured = []
        def handler(request):
            body = json.loads(request.content)
            captured.append(body)
            events = [
                {'choices': [{'index': 0, 'delta': {'content': 'Found', 'annotations': [
                    {'type': 'url_citation', 'url_citation': {'url': 'https://docs.python.org/', 'title': 'Python'}}]}, 'finish_reason': None}]},
                {'choices': [{'index': 0, 'delta': {}, 'finish_reason': 'stop'}]},
            ]
            return httpx.Response(200, headers={'Content-Type': 'text/event-stream'},
                                  content=''.join('data: '+json.dumps(e)+'\n\n' for e in events)+'data: [DONE]\n\n')
        client = OpenAI(api_key='fixture',base_url='https://fixture.invalid/v1',max_retries=0,
                        http_client=httpx.Client(transport=httpx.MockTransport(handler)))
        self.addCleanup(client.close)
        status, _, response = _probe(client, 'search-fixture', 'openai-chat', 'web_native')
        self.assertEqual(status, 'passed')
        self.assertTrue(response.web_search_used)
        self.assertEqual(captured[0]['web_search_options'], {})
        self.assertTrue(captured[0]['stream'])
        self.assertNotIn('tool_choice', captured[0])

    def test_anthropic_tool_evidence_errors_and_streamed_citations(self):
        blocks = [{'type': 'server_tool_use', 'id': 'srv1', 'name': 'web_search', 'input': {'query': 'Python'}},
                  {'type': 'web_search_tool_result', 'tool_use_id': 'srv1', 'content': []},
                  {'type': 'text', 'text': 'Found', 'citations': []}]
        citation = {'type': 'web_search_result_location', 'url': 'https://docs.python.org/', 'title': 'Python'}
        events = [{'type': 'message_start', 'message': {'usage': {'input_tokens': 9}}}]
        for index, block in enumerate(blocks):
            events.append({'type': 'content_block_start', 'index': index, 'content_block': block})
        events.extend([{'type': 'content_block_delta', 'index': 2, 'delta': {'type': 'citations_delta', 'citation': citation}},
                       {'type': 'message_delta', 'delta': {'stop_reason': 'end_turn'}}, {'type': 'message_stop'}])
        captured = []
        def handler(request):
            captured.append(json.loads(request.content))
            return httpx.Response(200, headers={'Content-Type': 'text/event-stream'},
                                  content=''.join('data: '+json.dumps(e)+'\n\n' for e in events))
        client = AnthropicClient('fixture','https://fixture.invalid/v1',
                                 http_client=httpx.Client(transport=httpx.MockTransport(handler)))
        self.addCleanup(client.close)
        result, _ = drain(complete(client,'claude-fixture',[{'role':'user','content':'Search'}],
                                   web_search=True,require_web=True,stream=True))
        self.assertTrue(result.web_search_used)
        self.assertEqual(len(result.web_sources), 1)
        self.assertEqual(captured[0]['tools'],[{'type':'web_search_20250305','name':'web_search','max_uses':1}])
        self.assertEqual(result.choices[0].message.tool_calls, [])
        self.assertIn('citations',result.choices[0].message.native[2])
        self.assertFalse(anthropic_search([blocks[1], {'type':'text','citations':[citation]}])[0])
        with self.assertRaises(ProtocolResponseError):
            anthropic_search([blocks[0], {'type':'web_search_tool_result','tool_use_id':'srv1',
                'content':{'type':'web_search_tool_result_error','error_code':'max_uses_exceeded'}}])

    def test_mixed_anthropic_tools_and_invalid_citations(self):
        options = anthropic_options('claude-fixture',[{'role':'user','content':'Hello'}],{'tools':[
            {'type':'web_search'}, {'type':'function','function':{'name':'echo','parameters':{'type':'object'}}}]})
        self.assertEqual(options['tools'][1]['name'],'echo')
        self.assertEqual(chat_sources([{'type':'text','text':'https://example.com'},
            {'type':'url_citation','url_citation':{'url':'javascript:alert(1)'}}]),[])
        self.assertFalse(anthropic_search([{'type':'server_tool_use','name':'web_search'},
            {'type':'web_search_tool_result','content':[]}])[0])

    def test_gemini_protocol_schema_and_official_compatibility_url(self):
        request=AskRequest(task_id='fixture',question='hi',provider_id='fixture',model_name='gemini-3.8-flash',protocol='gemini')
        self.assertEqual(request.protocol,'gemini')
        self.assertEqual(gemini_base_url('https://generativelanguage.googleapis.com/v1beta/openai/'),
                         'https://generativelanguage.googleapis.com/v1beta')
