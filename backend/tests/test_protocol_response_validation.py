"""Real SDK with synthetic wire responses, never provider credentials/network."""
import json
import unittest
import httpx
from openai import OpenAI
from app.services.ai_runtime import complete
from app.services.protocol_clients import AnthropicClient, ResponsesClient
from app.services.gemini_client import GeminiClient
from app.utils.ai_errors import error_details
from app.gpt.provider.OpenAI_compatible_provider import OpenAICompatibleProvider
from unittest.mock import patch


def drain(iterator):
    while True:
        try: next(iterator)
        except StopIteration as stopped: return stopped.value


class ProtocolResponseValidationTests(unittest.TestCase):
    def sdk(self, handler, protocol='openai-chat'):
        http = httpx.Client(transport=httpx.MockTransport(handler))
        if protocol == 'anthropic': client = AnthropicClient('synthetic-private', 'https://synthetic.invalid', http_client=http)
        elif protocol == 'gemini': client = GeminiClient('synthetic-private', 'https://synthetic.invalid', http_client=http)
        else:
            sdk = OpenAI(api_key='synthetic-private', base_url='https://synthetic.invalid/v1', max_retries=0, http_client=http)
            client = ResponsesClient(sdk) if protocol == 'openai-responses' else sdk
        self.addCleanup(client.close)
        return client

    def test_nonstream_sse_has_explicit_format_error_for_all_protocols(self):
        for protocol in ('openai-chat', 'openai-responses', 'anthropic', 'gemini'):
            with self.subTest(protocol=protocol):
                wires=[]
                def handler(request):
                    wires.append(request)
                    return httpx.Response(200, headers={'content-type':'text/event-stream','x-request-id':'fixture-id'}, text='data: PRIVATE_BODY_SENTINEL\n\n')
                client=self.sdk(handler,protocol)
                with self.assertRaises(Exception) as caught:
                    complete(client,'synthetic-model',[{'role':'user','content':'fixture'}])
                details=error_details(caught.exception,protocol,'synthetic-private')
                self.assertEqual(details['kind'],'protocol_response')
                self.assertEqual(details['actual_format'],'sse')
                self.assertNotIn('PRIVATE_BODY_SENTINEL',str(details))
                self.assertEqual(len(wires),1)

    def test_stream_json_rejected_with_http_and_request_id_for_all_protocols(self):
        for protocol in ('openai-chat','openai-responses','anthropic','gemini'):
            with self.subTest(protocol=protocol):
                client=self.sdk(lambda r:httpx.Response(200,headers={'x-request-id':'fixture-json-id'},json={'private':'PRIVATE_BODY_SENTINEL'}),protocol)
                with self.assertRaises(Exception) as caught:drain(complete(client,'synthetic-model',[],stream=True))
                details=error_details(caught.exception,protocol,'synthetic-private')
                self.assertEqual(details['expected_format'],'sse')
                self.assertEqual(details['actual_format'],'json')
                self.assertEqual(details['http_status'],200)
                self.assertEqual(details['request_id'],'fixture-json-id')
                self.assertNotIn('PRIVATE_BODY_SENTINEL',str(details))

    def test_invalid_sse_json_does_not_echo_frame_for_all_protocols(self):
        for protocol in ('openai-chat','openai-responses','anthropic','gemini'):
            with self.subTest(protocol=protocol):
                client=self.sdk(lambda r:httpx.Response(200,headers={'content-type':'text/event-stream','x-request-id':'fixture-invalid'},text='data: PRIVATE_BODY_SENTINEL\n\n'),protocol)
                with self.assertRaises(Exception) as caught:drain(complete(client,'synthetic-model',[],stream=True))
                details=error_details(caught.exception,protocol,'synthetic-private')
                self.assertEqual(details['kind'],'protocol_response')
                self.assertEqual(details['request_id'],'fixture-invalid')
                self.assertNotIn('PRIVATE_BODY_SENTINEL',str(details))

    def test_chat_usage_and_request_id_survive_stream(self):
        usage={'prompt_tokens':17,'completion_tokens':2,'total_tokens':19,'prompt_tokens_details':{'cached_tokens':12},'completion_tokens_details':{'reasoning_tokens':1}}
        events=[{'choices':[{'index':0,'delta':{'content':'OK'},'finish_reason':'stop'}]},{'choices':[],'usage':usage}]
        client=self.sdk(lambda r:httpx.Response(200,headers={'content-type':'text/event-stream','x-request-id':'fixture-chat'},text=''.join('data: '+json.dumps(e)+'\n\n' for e in events)))
        response,_=drain(complete(client,'synthetic-model',[],stream=True))
        self.assertEqual(response.raw_usage,usage)
        self.assertEqual(response.request_id,'fixture-chat')

    def test_anthropic_final_usage_merges_with_initial_cache_usage(self):
        events=[{'type':'message_start','message':{'usage':{'input_tokens':11,'cache_read_input_tokens':7}}},
                {'type':'content_block_start','index':0,'content_block':{'type':'text','text':''}},
                {'type':'content_block_delta','index':0,'delta':{'type':'text_delta','text':'OK'}},
                {'type':'message_delta','delta':{'stop_reason':'end_turn'},'usage':{'output_tokens':2}}, {'type':'message_stop'}]
        client=self.sdk(lambda r:httpx.Response(200,headers={'content-type':'text/event-stream','request-id':'fixture-messages'},text=''.join('data: '+json.dumps(e)+'\n\n' for e in events)),'anthropic')
        response,_=drain(complete(client,'synthetic-model',[],stream=True))
        self.assertEqual(response.raw_usage,{'input_tokens':11,'cache_read_input_tokens':7,'output_tokens':2})
        self.assertEqual(response.usage.prompt_tokens,18)
        self.assertEqual(response.request_id,'fixture-messages')

    def test_generation_connection_probe_rejects_sse_with_safe_details(self):
        client=self.sdk(lambda r:httpx.Response(200,headers={'content-type':'text/event-stream'},text='data: PRIVATE_BODY_SENTINEL\n\n'))
        with patch('app.gpt.provider.OpenAI_compatible_provider.build_openai_client',return_value=client):
            with self.assertRaises(ValueError) as caught:OpenAICompatibleProvider.test_connection('synthetic-private','https://synthetic.invalid','fixture')
        self.assertEqual(caught.exception.details['actual_format'],'sse')
        self.assertNotIn('PRIVATE_BODY_SENTINEL',str(caught.exception))


if __name__=='__main__':unittest.main()
