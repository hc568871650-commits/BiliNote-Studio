"""Opt-in fixture server: real metadata services/LangGraph, zero paid providers.

Only synthetic data inside workspace .BiliNote-dev may be used. No application
bootstrap, dotenv loading, vector database, provider store, or production import.
"""
import argparse
import json
import os
import sys
import types
from pathlib import Path


def bootstrap(dependencies=None):
    backend = Path(__file__).resolve().parents[1]
    if dependencies:
        sys.path.insert(0, str(Path(dependencies).resolve()))
    sys.path.insert(0, str(backend))
    if 'app' not in sys.modules:
        package = types.ModuleType('app')
        package.__path__ = [str(backend / 'app')]
        sys.modules['app'] = package
    os.environ['LANGSMITH_TRACING'] = 'false'
    os.environ['LANGCHAIN_TRACING_V2'] = 'false'


def fake_client(provider_id, model_name):
    allowed = {'fixture', 'preview-1', 'preview-2', 'preview-3'}
    if provider_id not in allowed:
        raise ValueError('fixture仅支持明确的示例供应商，禁止调用真实服务商')

    def completion(**kwargs):
        if '上下文压缩器' in kwargs['messages'][0]['content']:
            return types.SimpleNamespace(choices=[types.SimpleNamespace(message=types.SimpleNamespace(
                content='【合成模型的压缩摘要】用户希望整理示例笔记。所有操作以服务端范围和待确认计划为准，压缩没有执行任何修改。'))])
        payload = json.loads(kwargs['messages'][-1]['content'])
        instruction = payload['instruction']
        ids = [n['id'] for n in payload['notes'] if n['status'] in ('SUCCESS', 'FAILED')]
        kind = 'restore' if '恢复归档' in instruction else 'archive' if '归档当前明确范围' in instruction else None
        operations = [{'type': kind, 'task_ids': ids}] if kind and ids else []
        if '\n唯一允许的移动目标：' in instruction:
            destination = json.loads(instruction.split('\n唯一允许的移动目标：')[-1])
            operations = [{'type': 'move_notes', 'task_ids': ids, 'folder_id': destination['folder_id']}] if ids else []
        if not kind and ('标签' in instruction or '分类' in instruction):
            operations = [{'type': 'set_tags', 'task_ids': ids, 'tags': ['示例分类']}] if ids else []
        proposal = {'explanation': '示例模型根据服务端明确范围生成元数据计划（不读取正文）。',
                    'operations': operations, 'query_note_ids': ids if not operations else []}
        if payload.get('reply_only'):
            return types.SimpleNamespace(choices=[types.SimpleNamespace(message=types.SimpleNamespace(
                content='这是独立流程验证的模拟回答。请明确来源与目标文件夹，生成计划后可通过计划按钮执行。'))])
        return types.SimpleNamespace(choices=[types.SimpleNamespace(message=types.SimpleNamespace(
            content=json.dumps(proposal, ensure_ascii=False)))])
    return types.SimpleNamespace(client=types.SimpleNamespace(chat=types.SimpleNamespace(
        completions=types.SimpleNamespace(create=completion))))


def configure(root, seed=True):
    from app.services import organizer, organizer_sessions, note_storage as notes
    from app.services import note_folders as folders, note_library as library
    root = Path(root).resolve()
    workspace = Path(__file__).resolve().parents[2]
    allowed = (workspace / '.BiliNote-dev').resolve()
    if not root.is_relative_to(allowed) or root == allowed:
        raise ValueError('fixture runtime必须在当前工作区.BiliNote-dev子目录内')
    root.mkdir(parents=True, exist_ok=True)
    marker = root / 'fixture-identity.json'
    if not marker.exists() and any(root.iterdir()):
        raise ValueError('fixture目录非空且无隔离身份标识，拒绝读取')
    if marker.exists() and json.loads(marker.read_text(encoding='utf-8')).get('app_id') != 'bilinote-organizer-fixture':
        raise ValueError('fixture目录身份不匹配')
    notes._atomic_json(marker, {'app_id': 'bilinote-organizer-fixture', 'synthetic_data': True})
    notes.ROOT = root / 'notes'
    folders.STATE_PATH = root / 'data' / 'note_folders.json'
    library.STATE_PATH = root / 'data' / 'note_library.json'
    organizer.JOURNAL_ROOT = root / 'data' / 'organizer_plans'
    organizer_sessions.SESSION_ROOT = root / 'data' / 'organizer_sessions'
    organizer.get_client = fake_client
    if seed and not folders.STATE_PATH.exists():
        for task_id, title in (('office-a', '办公效率：表格快捷键'), ('office-star', '办公效率：收藏的排版教程'),
                               ('program-a', '编程入门：条件与循环')):
            notes.save_task({'id': task_id, 'status': 'SUCCESS', 'progress': 100,
                             'audioMeta': {'title': title, 'duration': 600, 'platform': 'bilibili',
                                           'cover': '', 'author': '示例作者'},
                             'markdown': '# 合成示例笔记\n这不是任何用户真实教程内容。',
                             'transcript': {'full_text': 'SYNTHETIC_BODY_NOT_FOR_MODEL'},
                             'formData': {'platform': 'bilibili'}})
        folders.create_folder('办公效率', 'office')
        folders.create_folder('编程学习', 'programming')
        folders.move_notes(['office-a', 'office-star'], 'office')
        folders.move_notes(['program-a'], 'programming')
        library.update_entries(['office-star'], {'favorite': True})
    return root


def build_app(root):
    from fastapi import FastAPI
    from fastapi.middleware.cors import CORSMiddleware
    from app.routers import organizer, note_folders, note_library
    from app.services import note_storage as notes
    from app.utils.response import ResponseWrapper as R
    configure(root)
    app = FastAPI(title='BiliNote Organizer isolated fixture')
    app.add_middleware(CORSMiddleware, allow_origins=['http://127.0.0.1:19483'],
                       allow_methods=['GET', 'POST', 'PATCH', 'DELETE'], allow_headers=['Content-Type'])
    for router in (organizer.router, note_folders.router, note_library.router):
        app.include_router(router, prefix='/api')

    @app.get('/health')
    def health():
        return {'app_id': 'bilinote-organizer-fixture', 'simulated_model': True, 'engine': 'langgraph'}

    @app.get('/api/notes')
    def list_notes():
        return R.success(notes.list_tasks())

    @app.post('/api/notes/import')
    def import_noop():
        return R.success(notes.list_tasks(), msg='fixture 不导入用户文件')

    @app.get('/api/notes/{task_id}')
    def get_note(task_id: str):
        task = notes.get_task(task_id)
        return R.success(task) if task else R.error('示例笔记不存在', code=404)

    return app


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--dependencies', default=str(Path(__file__).resolve().parents[2] / '.BiliNote-dev' / 'agent-compatible-deps'))
    parser.add_argument('--root', default=str(Path(__file__).resolve().parents[2] / '.BiliNote-dev' / 'agent-preview'))
    parser.add_argument('--port', type=int, default=19485)
    args = parser.parse_args()
    bootstrap(args.dependencies)
    import uvicorn
    uvicorn.run(build_app(args.root), host='127.0.0.1', port=args.port)


if __name__ == '__main__':
    main()
