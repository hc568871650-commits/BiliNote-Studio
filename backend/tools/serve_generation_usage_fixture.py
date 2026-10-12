"""Real audit/comparison services, synthetic sources and mock inference; never production."""
import argparse
import json
import os
from pathlib import Path
import sys
import time
import types
from serve_organizer_fixture import bootstrap

WORKSPACE = Path(__file__).resolve().parents[2]
IDENTITY = 'bilinote-generation-usage-fixture'


def build_app(root):
    root = Path(root).resolve()
    if not root.is_relative_to(WORKSPACE / '.BiliNote-dev'):
        raise ValueError('Only isolated project runtime is allowed')
    root.mkdir(parents=True, exist_ok=True)
    os.environ.update(NOTE_OUTPUT_DIR=str(root / 'notes'), GENERATION_COMPARISON_DIR=str(root / 'comparisons'))
    from fastapi import FastAPI
    from fastapi.middleware.cors import CORSMiddleware
    from app.services import note_storage as notes, ai_client
    from app.services.generation_usage import GenerationUsageRecorder, list_generation_runs
    from app.gpt.universal_gpt import UniversalGPT
    from app.models.gpt_model import GPTSource
    from app.routers import generation_comparisons
    from app.utils.response import ResponseWrapper as R
    notes.ROOT = root / 'notes'
    body = '## 来源与操作 *Content-[00:00]\n\n这是合成测试教程，用于验证用量统计与独立对比，不来自正式笔记。\n\n## 参数检查 *Content-[00:08]\n\n将半径设置为42毫米，检查后保存。'
    segments = [{'start': 0, 'end': 8, 'text': '新建底色图层，只开启颜色通道。'}, {'start': 8, 'end': 20, 'text': '设置半径42毫米，确认数值后Ctrl加S保存。'}]
    if not notes.get_task('usage-fixture'):
        notes.save_task({'id': 'usage-fixture', 'status': 'SUCCESS', 'audioMeta': {'title': '用量统计与对比 · 合成教程', 'duration': 20, 'platform': 'local'},
            'transcript': {'segments': segments, 'full_text': ' '.join(s['text'] for s in segments)},
            'formData': {'format': ['link'], 'style': 'tutorial', 'provider_id': 'preview-1', 'model_name': '通用示例模型', 'video_url': '', 'platform': 'local', 'quality': 'medium'},
            'markdown': [{'ver_id': 'usage-v1', 'content': body, 'style': 'tutorial', 'model_name': '通用示例模型', 'created_at': '2026-10-11T00:00:00Z'}]})
    def factory(provider, model, protocol='openai-chat'):
        if provider not in ('preview-1', 'preview-2', 'preview-3'):
            raise ValueError('Fixture rejects real providers')
        def create(**kwargs):
            time.sleep(.5)
            return types.SimpleNamespace(choices=[types.SimpleNamespace(finish_reason='stop', message=types.SimpleNamespace(content=body + '\n\n本方案为模拟结果。'))],
                usage=types.SimpleNamespace(prompt_tokens=578, completion_tokens=148, total_tokens=939,
                    prompt_tokens_details=types.SimpleNamespace(cached_tokens=64)))
        return UniversalGPT(types.SimpleNamespace(chat=types.SimpleNamespace(completions=types.SimpleNamespace(create=create))), model)
    ai_client.get_client = factory
    for index, title in enumerate(('另一篇笔记 · 操作目标检查', '历史笔记 · 暂无用量记录'), 1):
        task_id = f'usage-demo-{index}'
        if not notes.get_task(task_id):
            notes.save_task({'id': task_id, 'status': 'SUCCESS', 'audioMeta': {'title': title, 'duration': 20, 'platform': 'local'},
                'transcript': {'segments': segments},
                'formData': {'format': ['link'], 'style': 'tutorial', 'provider_id': 'preview-1', 'model_name': '通用示例模型', 'video_url': '/uploads/synthetic.mp4', 'platform': 'local', 'quality': 'medium'},
                'markdown': [{'ver_id': f'demo-{index}-new', 'content': f'# {title}\n\n这是目标笔记{index}的最新正文，不能与正在阅读的笔记混淆。', 'style': 'tutorial', 'model_name': '通用示例模型', 'created_at': '2026-10-12T00:00:00Z'},
                             {'ver_id': f'demo-{index}-old', 'content': f'# {title}\n\n这是目标笔记{index}的历史正文。', 'style': 'tutorial', 'created_at': '2026-10-11T00:00:00Z'}]})
    if not list_generation_runs('usage-fixture'):
        recorder = GenerationUsageRecorder('usage-fixture', {'max_requests': 2}, model='通用示例模型', provider_id='preview-1')
        gpt = factory('preview-1', '通用示例模型').configure_generation(recorder.options, recorder)
        gpt.summarize(GPTSource(segment=segments, title='合成教程', tags='', _format=['link']))
        recorder.finish('completed'); recorder.bind_version('usage-v1')
    app = FastAPI(title=IDENTITY)
    app.add_middleware(CORSMiddleware, allow_origins=['http://127.0.0.1:29483'], allow_methods=['GET', 'POST'], allow_headers=['Content-Type'])
    app.include_router(generation_comparisons.router, prefix='/api')
    @app.get('/health')
    def health(): return {'app_id': IDENTITY, 'synthetic_data': True, 'simulated_model': True}
    @app.get('/api/notes')
    def listing(): return R.success(notes.list_tasks())
    @app.post('/api/notes/import')
    def no_import(): return R.success(notes.list_tasks())
    @app.get('/api/notes/{task_id}')
    def note(task_id: str): return R.success(notes.get_task(task_id))
    @app.get('/api/notes/{task_id}/generation-runs')
    def usage(task_id: str): return R.success(list_generation_runs(task_id))
    return app


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', default=str(WORKSPACE / '.BiliNote-dev/generation-usage-fixture'))
    parser.add_argument('--port', type=int, default=29485)
    args = parser.parse_args()
    bootstrap(WORKSPACE / '.BiliNote-dev/agent-compatible-deps')
    app = build_app(args.root)
    import uvicorn
    uvicorn.run(app, host='127.0.0.1', port=args.port)
