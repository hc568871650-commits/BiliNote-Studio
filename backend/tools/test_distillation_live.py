"""Opt-in real-model evaluation on synthetic video; DPAPI test key only, bounded calls."""
import argparse
import json
import os
from pathlib import Path
import sys
import time
import types
from unittest.mock import patch

from serve_organizer_fixture import bootstrap
from test_live_assistants import credential, safe_error


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', required=True)
    parser.add_argument('--model', default='gemini-3.8-flash')
    parser.add_argument('--tutorial-only', action='store_true')
    parser.add_argument('--max-output', type=int, choices=[2048, 4096], default=4096)
    parser.add_argument('--public-video', action='store_true')
    parser.add_argument('--mode', choices=['fixed', 'dynamic'], action='append')
    args = parser.parse_args()
    workspace = Path(__file__).resolve().parents[2]
    output = Path(args.output).resolve()
    if not output.is_relative_to(workspace / '.BiliNote-dev') or output.exists():
        raise ValueError('Use a new .BiliNote-dev output directory')
    output.mkdir(parents=True)
    bootstrap(workspace / '.BiliNote-dev/agent-compatible-deps')
    sys.path.insert(0, str(workspace / '.BiliNote-dev/distillation-deps'))
    # ffmpeg_helper imports this boundary; the fixture must never discover .env files.
    env_module = types.ModuleType('runtime_env')
    env_module.load_dotenv = lambda *a, **k: False
    sys.modules['runtime_env'] = env_module
    os.environ['NOTE_OUTPUT_DIR'] = str(output / 'notes')
    os.environ['BILINOTE_INSTALLER'] = '1'
    os.environ['BILINOTE_DATA_ROOT'] = str(output)
    os.environ['OPENAI_RETRY_ATTEMPTS'] = '1'
    os.chdir(output)
    from openai import OpenAI
    from app.gpt.universal_gpt import UniversalGPT
    from app.models.gpt_model import GPTSource
    from app.models.transcriber_model import TranscriptSegment
    from app.utils.video_reader import VideoReader
    from app.services import note_refinement as refine, note_storage as notes
    key, url = credential(Path(os.environ['LOCALAPPDATA']) / 'BiliNote-DevSecrets/littlecold-test.json')
    report = {'model': args.model, 'endpoint_host': 'api.littlecold.cn', 'synthetic_video': True,
              'real_provider': True, 'automatic_retries': 0, 'max_calls': 5, 'output_cap_per_call': 2048,
              'requests': [], 'cases': {}, 'production_modified': False}
    report['output_cap_per_call'] = args.max_output
    report['max_calls'] = 2 if args.tutorial_only else 5
    report_path = output / 'report.json'
    def save():
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    sdk = OpenAI(api_key=key, base_url=url, max_retries=0, timeout=120)
    current_case = ''
    def create(**kwargs):
        if len(report['requests']) >= report['max_calls']:
            raise RuntimeError('TEST_CALL_BUDGET_REACHED')
        kwargs['max_tokens'] = args.max_output
        entry = {'case': current_case, 'model': kwargs['model'], 'started': time.time()}
        report['requests'].append(entry)
        save()
        start = time.monotonic()
        try:
            result = sdk.chat.completions.create(**kwargs)
            entry['usage'] = result.usage.model_dump() if result.usage else None
            entry['request_id'] = getattr(result, '_request_id', None)
            entry['finish_reasons'] = [c.finish_reason for c in result.choices]
            return result
        except Exception as exc:
            entry.update(error_type=type(exc).__name__, error=safe_error(exc), http_status=getattr(exc, 'status_code', None))
            raise
        finally:
            entry['seconds'] = round(time.monotonic() - start, 3)
            save()
    client = types.SimpleNamespace(chat=types.SimpleNamespace(completions=types.SimpleNamespace(create=create)))
    source_video = workspace / '.BiliNote-dev/dynamic-frame-synthetic-20261011/synthetic-menu-parameter.mp4'
    segments = [TranscriptSegment(0, 4, '打开左侧菜单，查看可用选项。'),
                TranscriptSegment(4, 9, '修改右上角参数，最终数值以画面为准；这里没有口述具体数值。'),
                TranscriptSegment(9, 12, '检查修改结果。本示例未说明单位、软件版本或快捷键。')]
    gpt = UniversalGPT(client, args.model)
    try:
        if args.public_video:
            report.update(synthetic_video=False, public_source='https://download.blender.org/demo/movies/arraydemo.mp4.zip', max_calls=1)
            source_video = workspace / '.BiliNote-dev/distillation-public-sample/arraydemo.mp4'
            reader = VideoReader(str(source_video), frame_mode='dynamic', frame_budget=12, grid_size=(2, 2),
                frame_dir=str(output / 'public/frames'), grid_dir=str(output / 'public/grids'))
            images = reader.run()
            current_case = 'public_visual_only'
            result = gpt.summarize(GPTSource(segment=[], title='公开三维演示片段（无音轨）', tags=[], style='knowledge',
                _format=['link'], link=True, video_img_urls=images, video_image_ranges=reader.grouped_ranges,
                frame_evidence=[{k: f[k] for k in ('time', 'reason')} for f in reader.evidence],
                extras='本片没有音轨和字幕。仅记录画面能证实的形状与排列变化，不要根据渲染结果推断软件操作步骤、菜单、修改器或数值。200字内。'))
            report['cases'][current_case] = {'answer': result, 'frames': [f['time'] for f in reader.evidence]}
            save()
            print(json.dumps({'report': str(report_path), 'requests': len(report['requests']), 'cases': list(report['cases'])}))
            return
        for mode in (args.mode or ('fixed', 'dynamic')):
            reader = VideoReader(str(source_video), frame_mode=mode, frame_interval=6, grid_size=(2, 2),
                                 subtitle_segments=segments, frame_budget=12,
                                 frame_dir=str(output / mode / 'frames'), grid_dir=str(output / mode / 'grids'))
            images = reader.run()
            current_case = f'tutorial_{mode}'
            result = gpt.summarize(GPTSource(segment=segments, title='受控软件操作片段', tags=[], style='tutorial',
                _format=['link', 'screenshot'], screenshot=True, link=True, video_img_urls=images,
                video_image_ranges=reader.grouped_ranges,
                frame_evidence=[{k: f[k] for k in ('time', 'reason')} for f in reader.evidence],
                extras='重点说明最终参数值。看不清或未展示时明确待核对；不要猜数值、单位、软件或快捷键。'))
            report['cases'][current_case] = {'answer': result, 'frames': [f['time'] for f in reader.evidence],
                                            'contains_42': '42' in result, 'contains_ai_summary': 'AI 总结' in result}
            save()
        if args.tutorial_only:
            print(json.dumps({'report': str(report_path), 'requests': len(report['requests']), 'cases': list(report['cases'])}))
            return
        current_case = 'knowledge_text'
        result = gpt.summarize(GPTSource(segment=[TranscriptSegment(0, 15, '缓存保存已计算结果，适合重复读取。输入变化后旧缓存必须失效。缓存不等于永久存储。'),
            TranscriptSegment(15, 30, '例如同一页面重复查询可以复用缓存；数据库更新后要重新计算。这里没有提供命中率或加速倍数。')],
            title='缓存概念', tags=[], style='knowledge', _format=['link'], link=True))
        report['cases'][current_case] = {'answer': result, 'contains_ai_summary': 'AI 总结' in result}
        save()
        current_case = 'refinement_visual'
        notes.ROOT = output / 'notes'
        old = '# 受控笔记\n\n## 调整参数 (00:04)\n\n修改数值。\n\n## 检查 (00:09)\n\n查看结果。'
        notes.save_task({'id': 'controlled', 'markdown': [{'ver_id': 'v1', 'content': old, 'style': 'tutorial'}],
                        'audioMeta': {'title': '受控软件操作片段', 'duration': 12, 'platform': 'local', 'video_path': str(source_video)},
                        'transcript': {'segments': [vars(s) for s in segments]}, 'status': 'SUCCESS'})
        with patch.object(refine, 'get_client', lambda *a: types.SimpleNamespace(client=client)):
            draft = refine.preview('controlled', {'version_id': 'v1', 'texts': ['修改数值。'], 'start_time': 4, 'end_time': 9,
               'instruction': '补充画面中最终的数值、操作及对应截图；视频未提供的单位和快捷键不要猜测。',
               'provider_id': 'test-only', 'model_name': args.model, 'protocol': 'openai-chat', 'use_video': True})
        unchanged = notes.get_task('controlled')['markdown'][0]['content'] == old
        task = refine.apply('controlled', draft['draft_id'])
        report['cases'][current_case] = {'answer': draft['after'], 'preview_preserved_original': unchanged,
            'versions_after_apply': len(task['markdown']), 'old_preserved': task['markdown'][-1]['content'] == old,
            'contains_42': '42' in draft['after'], 'evidence_frame_count': len(draft['evidence']['frames'])}
        save()
    except Exception as exc:
        report['stopped'] = {'type': type(exc).__name__, 'error': safe_error(exc)}
        save()
    finally:
        sdk.close()
    print(json.dumps({'report': str(report_path), 'requests': len(report['requests']),
                      'cases': list(report['cases']), 'stopped': report.get('stopped')}, ensure_ascii=False))


if __name__ == '__main__':
    main()
