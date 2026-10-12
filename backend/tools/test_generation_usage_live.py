"""Explicit real API acceptance with synthetic input and max 8 total requests."""
import argparse
import json
import os
from pathlib import Path
import sys
import types
from unittest.mock import patch

from project_test_api import WORKSPACE, credential, TestBudget
from serve_organizer_fixture import bootstrap


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', required=True)
    parser.add_argument('--max-calls', type=int, default=4)
    args = parser.parse_args()
    output = Path(args.output).resolve()
    if not output.is_relative_to(WORKSPACE / '.BiliNote-dev') or output.exists():
        raise ValueError('Use a new isolated .BiliNote-dev child directory')
    budget = TestBudget(args.max_calls)
    key, config = credential()
    bootstrap(WORKSPACE / '.BiliNote-dev/agent-compatible-deps')
    output.mkdir(parents=True)
    os.environ.update(NOTE_OUTPUT_DIR=str(output / 'notes'), GENERATION_COMPARISON_DIR=str(output / 'comparisons'))
    from openai import OpenAI
    import httpx
    from app.services import note_storage as notes, generation_comparisons as comparisons
    from app.gpt.universal_gpt import UniversalGPT
    from app.models.gpt_model import GPTSource
    from app.models.generation_options import GenerationOptions
    from app.services.generation_usage import GenerationUsageRecorder
    notes.ROOT = output / 'notes'
    sdk = OpenAI(api_key=key, base_url=config['base_url'], max_retries=0, timeout=60,
                 http_client=httpx.Client(follow_redirects=False, timeout=60))
    class Client:
        def __init__(self): self.chat = types.SimpleNamespace(completions=types.SimpleNamespace(create=self.create))
        def with_options(self, **kwargs): return self
        def close(self): pass
        def create(self, **kwargs):
            budget.reserve()
            return sdk.chat.completions.create(**kwargs)
    def factory(provider, model):
        if provider != 'project-gcli-test' or model != config['model']:
            raise ValueError('Unexpected test provider/model')
        return UniversalGPT(Client(), model)
    segments = [{'start': 0, 'end': 8, 'text': '这是一个合成操作教程。新建图层，命名为底色，只开启颜色通道。'},
                {'start': 8, 'end': 16, 'text': '把测试参数半径设置为42，单位是毫米。保存前检查数值。'},
                {'start': 16, 'end': 24, 'text': '按Ctrl加S保存。这个示例没有图片，不要描述任何画面。'}]
    notes.save_task({'id': 'usage-fixture', 'status': 'SUCCESS', 'audioMeta': {'title': '合成操作教程', 'duration': 24},
        'transcript': {'segments': segments}, 'formData': {'format': ['link'], 'style': 'tutorial'},
        'markdown': [{'ver_id': 'usage-v1', 'content': '## 原始示例\n半径42毫米，保存前核对。', 'style': 'tutorial'}]})
    report = {'real_provider': True, 'synthetic_source': True, 'max_calls': args.max_calls,
              'model': config['model'], 'production_modified': False}
    recorder = GenerationUsageRecorder('usage-fixture', {'max_requests': 1, 'max_output_tokens': 2048},
        model=config['model'], provider_id='project-gcli-test', request_id='normal-live-1')
    try:
        gpt = factory('project-gcli-test', config['model']).configure_generation(recorder.options, recorder)
        answer = gpt.summarize(GPTSource(segment=segments, title='合成操作教程', tags='', style='tutorial', _format=['link']))
        notes.save_task({'id': 'usage-fixture', 'status': 'SUCCESS', 'markdown': [{'ver_id': 'usage-generated-v1',
            'content': answer, 'style': 'tutorial', 'model_name': config['model']}]})
        recorder.finish('completed'); recorder.bind_version('usage-generated-v1')
        report['normal'] = {'usage': recorder.report(), 'answer': answer, 'has_42': '42' in answer}
        request = {'task_id': 'usage-fixture', 'version_id': 'usage-generated-v1', 'request_id': 'comparison-live-1',
            'variants': [{'provider_id': 'project-gcli-test', 'model_name': config['model'],
                          'options': {'max_requests': 1, 'max_output_tokens': 2048, 'temperature': t}} for t in (0, .7)]}
        run = comparisons.create_run(request, submit=False)
        with patch('app.services.ai_client.get_client', side_effect=factory):
            comparisons.execute_run(run['id'])
        report['comparison'] = comparisons.get_run(run['id'])
    except Exception as exc:
        recorder.finish('failed', error=exc)
        report['error_type'] = type(exc).__name__
    finally:
        sdk.close()
        report['actual_calls'] = budget.calls
        (output / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps({'report': str(output / 'report.json'), 'actual_calls': budget.calls,
            'normal': report.get('normal', {}).get('has_42'), 'comparison': report.get('comparison', {}).get('status'),
            'error_type': report.get('error_type')}, ensure_ascii=False))


if __name__ == '__main__': main()
