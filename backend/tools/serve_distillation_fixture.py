"""Real note/refinement API, workspace-owned synthetic notes, no provider/network calls."""
import argparse
import logging
import json
import shutil
import sys
import types
from pathlib import Path
from serve_organizer_fixture import bootstrap

IDENTITY = 'bilinote-distillation-fixture'
WORKSPACE = Path(__file__).resolve().parents[2]
PROVIDERS = {'fixture', 'preview-1', 'preview-2', 'preview-3'}
BODY = '''# 合成菜单与参数教程

## 打开菜单 *Content-[00:00]

这是隔离验收合成资料，不是真实教程。打开左侧菜单，查看可用选项。

## 调整参数 *Content-[00:04]

原笔记只记录了调整厚度，没有写出具体数值。这里可以选择这一段，重新核对原始字幕与参数画面。

## 最终结果 *Content-[00:09]

检查参数修改后的结果。原片未说明单位、软件版本或快捷键。
'''


def build_app(root):
    # VideoReader's production locator imports dotenv on import; fixture supplies only
    # a read-only PATH locator. Actual ffmpeg decoding and dynamic selection stay real.
    locator = types.ModuleType('ffmpeg_helper')
    def find_binary(name):
        value = shutil.which(name)
        if not value:
            raise FileNotFoundError(f'{name}不在PATH中')
        return value
    locator.find_ffmpeg_binary = find_binary
    sys.modules['ffmpeg_helper'] = locator
    logger = types.ModuleType('app.utils.logger')
    logger.get_logger = logging.getLogger
    sys.modules['app.utils.logger'] = logger
    from fastapi import FastAPI, HTTPException
    from fastapi.middleware.cors import CORSMiddleware
    from fastapi.responses import FileResponse
    from app.services import note_storage as notes, note_folders as folders, note_library as library
    root = Path(root).resolve()
    allowed = (WORKSPACE / '.BiliNote-dev').resolve()
    if root == allowed or not root.is_relative_to(allowed):
        raise ValueError('fixture只能使用工作区.BiliNote-dev子目录')
    root.mkdir(parents=True, exist_ok=True)
    marker = root / 'fixture-identity.json'
    if marker.exists():
        if json.loads(marker.read_text(encoding='utf-8')).get('app_id') != IDENTITY:
            raise ValueError('fixture目录身份不匹配')
    elif any(root.iterdir()):
        raise ValueError('fixture目录非空且无隔离身份标识')
    notes._atomic_json(marker, {'app_id': IDENTITY, 'synthetic_data': True})
    notes.ROOT = root / 'notes'
    folders.STATE_PATH = root / 'data/note_folders.json'
    library.STATE_PATH = root / 'data/note_library.json'
    video = WORKSPACE / '.BiliNote-dev/dynamic-frame-synthetic-20261011/synthetic-menu-parameter.mp4'
    segments = [
        {'start': 0, 'end': 4, 'text': '打开左侧菜单，查看可用选项。'},
        {'start': 4, 'end': 9, 'text': '修改右上角参数，最终数值以画面为准；这里没有口述具体数值。'},
        {'start': 9, 'end': 12, 'text': '检查参数修改结果。原片未说明单位、软件版本或快捷键。'},
    ]
    for index in range(1, 4):
        task_id = f'distillation-{index}'
        if not notes.get_task(task_id):
            notes.save_task({'id': task_id, 'status': 'SUCCESS', 'progress': 100,
                'audioMeta': {'title': f'合成菜单与参数教程 {index}', 'duration': 12, 'platform': 'local',
                    'video_path': str(video), 'video_id': 'synthetic', 'cover': '', 'author': '隔离示例'},
                'markdown': [{'ver_id': f'fixture-v{index}', 'content': BODY, 'model_name': '通用示例模型',
                    'provider_id': f'preview-{index}', 'protocol': 'openai-chat', 'style': 'tutorial', 'created_at': '2026-10-11T00:00:00Z'}],
                'transcript': {'full_text': '\n'.join(s['text'] for s in segments), 'segments': segments},
                'formData': {'platform': 'local', 'video_url': str(video), 'provider_id': f'preview-{index}',
                    'model_name': '通用示例模型', 'style': 'tutorial', 'format': ['link', 'screenshot'], 'quality': 'medium'}})
    from app.services import note_refinement as refinement
    def mock_client(provider_id, model_name, protocol='openai-chat'):
        if provider_id not in PROVIDERS or not model_name.strip():
            raise ValueError('隔离验收只允许fixture/preview-1~3示例供应商')
        return types.SimpleNamespace(client=types.SimpleNamespace(close=lambda: None))
    def mock_complete(client, model, messages, **kwargs):
        wire = messages[-1]['content']
        payload = json.loads(wire[0]['text'] if isinstance(wire, list) else wire)
        start, stop = payload['range']
        heading = next((line for line in payload['selected_note'].splitlines() if line.startswith('#')), '### 核对参数')
        answer = heading + '\n\n【模拟回答】修改右上角参数。' + ('所给示例画面显示 **42**，单位原片未说明。' if payload['images_provided'] else '字幕没有给出最终数值，待核对画面。') + '\n'
        if payload['images_provided'] and start <= 7 <= stop:
            answer += '\n*Screenshot-[00:07]\n'
        response = types.SimpleNamespace(choices=[types.SimpleNamespace(finish_reason='stop',
            message=types.SimpleNamespace(content=answer))])
        return response, {'simulated_model': True, 'model': model, 'images_provided': payload['images_provided']}
    refinement.get_client = mock_client
    refinement.complete = mock_complete
    from app.routers import note_refinement, note_folders, note_library
    from app.utils.response import ResponseWrapper as R
    app = FastAPI(title=IDENTITY)
    app.add_middleware(CORSMiddleware, allow_origins=['http://127.0.0.1:25483'],
        allow_methods=['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], allow_headers=['Content-Type'])
    for router in (note_refinement.router, note_folders.router, note_library.router):
        app.include_router(router, prefix='/api')
    @app.get('/health')
    def health():
        return {'app_id': IDENTITY, 'simulated_model': True, 'synthetic_data': True}
    @app.get('/api/notes')
    def list_notes():
        return R.success(notes.list_tasks())
    @app.post('/api/notes/import')
    def no_import():
        return R.success(notes.list_tasks(), msg='fixture不导入用户文件')
    @app.get('/api/notes/{task_id}/assets/{relative:path}')
    def asset(task_id: str, relative: str):
        try:
            return FileResponse(notes.asset(task_id, relative))
        except (ValueError, FileNotFoundError):
            raise HTTPException(404, '合成资源不存在') from None
    @app.get('/api/notes/{task_id}')
    def get_note(task_id: str):
        task = notes.get_task(task_id)
        return R.success(task) if task else R.error('示例笔记不存在', code=404)
    return app


def smoke(app):
    from fastapi.testclient import TestClient
    from app.services import note_storage as notes
    client = TestClient(app)
    assert client.get('/health').json()['app_id'] == IDENTITY
    task = client.get('/api/notes').json()['data'][0]
    version = task['markdown'][-1]
    selected = '原笔记只记录了调整厚度，没有写出具体数值。这里可以选择这一段，重新核对原始字幕与参数画面。'
    prefix = f'/api/notes/{task["id"]}/refine'
    selection = {'version_id': version['ver_id'], 'texts': [selected]}
    context = client.post(prefix + '/context', json=selection).json()
    assert context['code'] == 0 and context['data']['video_available']
    request = {**selection, 'start_time': 4, 'end_time': 9,
        'provider_id': 'fixture', 'model_name': '通用示例模型', 'use_video': True}
    preview = client.post(prefix + '/preview', json=request).json()
    if preview['code'] == 500:
        from app.services import note_refinement
        note_refinement.preview(task['id'], request)
    assert preview['code'] == 0, preview
    draft = preview['data']
    assert '【模拟回答】' in draft['after'] and 'images/' in draft['after']
    assert client.get(draft['evidence']['frames'][0]['image_url']).status_code == 200
    applied = client.post(prefix + '/apply', json={'draft_id': draft['draft_id']}).json()
    assert applied['code'] == 0, applied
    newest = applied['data']['markdown'][0]
    assert newest['ver_id'] != version['ver_id']
    preserved = next(item for item in applied['data']['markdown'] if item['ver_id'] == version['ver_id'])
    assert version['content'] == preserved['content']
    import re
    image = re.search(r'!\[[^\]]*\]\(([^)]+)\)', newest['content'])[1]
    assert client.get(newest['resource_base'] + image).status_code == 200
    denied = client.post(prefix + '/preview', json={**selection, 'start_time': 4, 'end_time': 9,
        'provider_id': 'real-provider', 'model_name': 'x'}).json()
    assert denied['code'] != 0
    print(json.dumps({'identity': IDENTITY, 'context': True, 'preview': True, 'apply': True,
        'frames_and_copied_image': True, 'provider_guard': True, 'root': str(notes.ROOT)}, ensure_ascii=False))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=25485)
    parser.add_argument('--dependencies', default=str(WORKSPACE / '.BiliNote-dev/agent-compatible-deps'))
    parser.add_argument('--root', default=str(WORKSPACE / '.BiliNote-dev/distillation-fixture'))
    parser.add_argument('--smoke', action='store_true')
    args = parser.parse_args()
    bootstrap(args.dependencies)
    sys.path.insert(0, str(WORKSPACE / '.BiliNote-dev/distillation-deps'))
    app = build_app(args.root)
    if args.smoke:
        smoke(app)
    else:
        import uvicorn
        uvicorn.run(app, host='127.0.0.1', port=args.port)
