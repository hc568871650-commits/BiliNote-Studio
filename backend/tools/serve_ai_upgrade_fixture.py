"""Actual API/LangGraph/capability jobs, synthetic data and MockTransport only."""
import argparse
import json
import sys
import types
from pathlib import Path
from serve_organizer_fixture import bootstrap, configure


def build_app(root):
    import httpx
    from openai import OpenAI
    from fastapi import FastAPI
    from fastapi.middleware.cors import CORSMiddleware
    from app.services import ai_client, model_capabilities, web_search, organizer, note_storage as notes
    from app.services.protocol_clients import ResponsesClient
    from app.utils.response import ResponseWrapper as R
    root = configure(root)
    model_capabilities.STATE_PATH = root / 'data' / 'model_capabilities.json'
    web_search.SETTINGS_PATH = root / 'data' / 'web_search.json'
    providers = {key: {'id': key, 'enabled': True, 'base_url': 'https://fixture.invalid/v1', 'api_key': 'synthetic-fixture-key'}
                 for key in ('fixture', 'preview-1', 'preview-2', 'preview-3')}
    def provider(identifier):
        if identifier not in providers:
            raise ValueError('隔离验收只接受示例供应商')
        return providers[identifier]
    model_capabilities._provider = provider
    def external_query(query):
        if not web_search.available():
            raise ValueError('尚未配置外部检索服务')
        web_search.sanitize_search_query(query)
        return [{'source_type': 'web', 'source_id': 'web-fixture', 'url': 'https://docs.python.org/3/', 'title': 'Python 文档（模拟来源）', 'text': '模拟网络检索结果，没有发送网络请求。'}]
    web_search.search_web = external_query
    def handler(request):
        data = json.loads(request.content)
        responses = request.url.path.endswith('/responses')
        wire = data.get('input', data.get('messages', []))
        tools = data.get('tools', [])
        echo = any((tool.get('name') or tool.get('function', {}).get('name')) == 'capability_echo' for tool in tools)
        web = any(tool.get('type') == 'web_search' for tool in tools)
        answer = '【模拟回答】已查阅合成资料，按下方来源核对内容。本环境不调用真实模型。'
        # Preserve the real plan parser/approval workflow with synthetic proposals.
        for item in reversed(wire):
            content = item.get('content')
            if isinstance(content, str):
                try:
                    payload = json.loads(content)
                except ValueError:
                    continue
                if isinstance(payload, dict) and 'instruction' in payload and 'notes' in payload and not payload.get('reply_only'):
                    ids = [n['id'] for n in payload['notes']]
                    answer = json.dumps({'explanation': '【合成计划】仅修改隔离示例数据', 'operations': [], 'query_note_ids': ids}, ensure_ascii=False)
                    break
        call = {'id': 'call_fixture', 'type': 'function', 'function': {'name': 'capability_echo', 'arguments': '{"value":"ok"}'}}
        if responses:
            output = [{'type': 'function_call', 'id': 'fc_fixture', 'call_id': 'call_fixture', 'name': 'capability_echo', 'arguments': '{"value":"ok"}', 'status': 'completed'}] if echo else [
                {'type': 'message', 'id': 'msg_fixture', 'role': 'assistant', 'status': 'completed', 'content': [{'type': 'output_text', 'text': answer, 'annotations': []}]}]
            if web:
                output.insert(0, {'type': 'web_search_call', 'id': 'web_fixture', 'status': 'completed', 'action': {'type': 'search', 'query': 'synthetic', 'sources': [{'url': 'https://docs.python.org/3/', 'title': 'Python 文档（模拟来源）'}]}})
            body = {'id': 'resp_fixture', 'object': 'response', 'created_at': 1, 'status': 'completed', 'model': data['model'], 'output': output,
                    'parallel_tool_calls': False, 'tools': tools, 'tool_choice': 'auto', 'usage': {'input_tokens': 100, 'output_tokens': 20, 'total_tokens': 120}}
            if data.get('stream'):
                events = ([{'type': 'response.web_search_call.searching'}] if web else []) + [{'type': 'response.output_text.delta', 'delta': answer}, {'type': 'response.completed', 'response': body}]
                return httpx.Response(200, headers={'content-type': 'text/event-stream'}, content=''.join('data: '+json.dumps(e,ensure_ascii=False)+'\n\n' for e in events))
            return httpx.Response(200, json=body)
        message = {'role': 'assistant', 'content': None if echo else answer, **({'tool_calls': [call]} if echo else {})}
        body = {'id': 'chat_fixture', 'object': 'chat.completion', 'created': 1, 'model': data['model'], 'choices': [{'index': 0, 'message': message, 'finish_reason': 'tool_calls' if echo else 'stop'}], 'usage': {'prompt_tokens': 100, 'completion_tokens': 20, 'total_tokens': 120}}
        if data.get('stream'):
            events = [{'id': 'chunk_fixture', 'object': 'chat.completion.chunk', 'created': 1, 'model': data['model'], 'choices': [{'index': 0, 'delta': {'content': answer}, 'finish_reason': None}]},
                      {'id': 'chunk_fixture', 'object': 'chat.completion.chunk', 'created': 1, 'model': data['model'], 'choices': [{'index': 0, 'delta': {}, 'finish_reason': 'stop'}], 'usage': body['usage']}]
            return httpx.Response(200, headers={'content-type': 'text/event-stream'}, content=''.join('data: '+json.dumps(e,ensure_ascii=False)+'\n\n' for e in events)+'data: [DONE]\n\n')
        return httpx.Response(200, json=body)
    def client(provider_id, model_name, protocol='openai-chat'):
        provider(provider_id)
        if protocol == 'anthropic':
            raise ValueError('此浏览器合成场景仅提供 Chat/Responses；Anthropic 由协议隔离测试覆盖')
        sdk = OpenAI(api_key='synthetic-fixture-key', base_url='https://fixture.invalid/v1', max_retries=0,
                     http_client=httpx.Client(transport=httpx.MockTransport(handler)))
        adapted = ResponsesClient(sdk) if protocol == 'openai-responses' else sdk
        adapted.bilinote_provider_id = provider_id
        return types.SimpleNamespace(model=model_name, client=adapted)
    ai_client.get_client = organizer.get_client = client
    original_probe = model_capabilities._probe
    def probe(*args):
        status, evidence, response = original_probe(*args)
        return status, '【合成验收，未调用真实模型】' + evidence, response
    model_capabilities._probe = probe
    # Import reading routes without loading a real vector model or database.
    vector = types.ModuleType('app.services.vector_store')
    vector.VectorStoreManager = lambda: types.SimpleNamespace(query=lambda *a, **k: [], is_indexed=lambda *a: False, index_task=lambda *a: None)
    sys.modules[vector.__name__] = vector
    from app.routers import organizer as org_router, model_capabilities as cap_router, note_folders, note_library, chat
    app = FastAPI(title='BiliNote AI upgrade fixture')
    app.add_middleware(CORSMiddleware, allow_origins=['http://127.0.0.1:23483'], allow_methods=['GET','POST','PUT','PATCH','DELETE'], allow_headers=['Content-Type'])
    for router in (org_router.router, cap_router.router, note_folders.router, note_library.router, chat.router):
        app.include_router(router, prefix='/api')
    @app.get('/health')
    def health():
        return {'app_id': 'bilinote-ai-upgrade-fixture', 'simulated_model': True}
    @app.get('/api/notes')
    def list_notes():
        return R.success(notes.list_tasks())
    @app.post('/api/notes/import')
    def no_import():
        return R.success(notes.list_tasks())
    @app.get('/api/notes/{task_id}')
    def get_note(task_id: str):
        task = notes.get_task(task_id)
        return R.success(task) if task else R.error('示例笔记不存在', code=404)
    return app


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=23485)
    args = parser.parse_args()
    workspace = Path(__file__).resolve().parents[2]
    bootstrap(workspace / '.BiliNote-dev' / 'agent-compatible-deps')
    import uvicorn
    uvicorn.run(build_app(workspace / '.BiliNote-dev' / 'ai-upgrade-fixture'), host='127.0.0.1', port=args.port)
