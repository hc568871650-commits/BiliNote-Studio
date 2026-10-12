"""Explicit, bounded A/B runs from one frozen source; never publish or alter notes."""
import base64
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import math
import os
from pathlib import Path
import threading
import uuid
from datetime import datetime, timezone

from app.models.generation_comparison import ComparisonRequest
from app.models.generation_options import GenerationOptions
from app.models.gpt_model import GPTSource
from app.services import note_storage as notes

LOCK = threading.RLock()
EXECUTOR = ThreadPoolExecutor(max_workers=1, thread_name_prefix='generation-comparison')
ACTIVE = set()
CANCELLED = set()


def now():
    return datetime.now(timezone.utc).isoformat()


def root():
    return Path(os.getenv('GENERATION_COMPARISON_DIR', str(notes.ROOT.parent / 'data/generation_comparisons')))


def folder(run_id):
    if len(run_id) != 32 or any(ch not in '0123456789abcdef' for ch in run_id):
        raise ValueError('无效的对比记录ID')
    return notes._inside(root() / run_id, root())


def read(run_id):
    path = folder(run_id) / 'run.json'
    if not path.is_file():
        raise ValueError('对比记录不存在')
    return json.loads(path.read_text(encoding='utf-8'))


def save(run):
    if run['id'] in CANCELLED:
        run['cancel_requested'] = True
    notes._atomic_json(folder(run['id']) / 'run.json', run)


def list_runs(task_id):
    notes.valid_id(task_id)
    if not root().exists():
        return []
    result = []
    for path in root().glob('*/run.json'):
        try:
            run = get_run(path.parent.name)
            if run['task_id'] == task_id:
                # Lists carry metadata only; full result bodies are loaded on selection.
                for variant in run['variants']:
                    variant.pop('markdown', None)
                result.append(run)
        except (ValueError, OSError):
            continue
    return sorted(result, key=lambda run: run['created_at'], reverse=True)[:100]


def get_run(run_id):
    with LOCK:
        run = read(run_id)
        if run['status'] in ('queued', 'running') and run_id not in ACTIVE:
            run.update(status='interrupted', finished_at=now(), error='服务已重启；未自动重跑，请查看已保存用量。')
            save(run)
        for index, variant in enumerate(run['variants']):
            usage_path = folder(run_id) / f'variant-{index}'
            reports = list(usage_path.glob('*.json')) if usage_path.exists() else []
            if reports:
                try:
                    variant['report'] = json.loads(reports[0].read_text(encoding='utf-8'))
                except (ValueError, OSError):
                    pass
        return run


def freeze_source(request):
    task = notes.get_task(request.task_id)
    if not task or task.get('archived_at') or task.get('status') != 'SUCCESS':
        raise ValueError('请选择已完成且未归档的笔记进行对比')
    versions = task.get('markdown')
    version = next((v for v in versions if v.get('ver_id') == request.version_id), None) if isinstance(versions, list) else None
    if not version:
        raise ValueError('来源版本不存在，请刷新后重试')
    if versions[0].get('ver_id') != request.version_id:
        raise ValueError('旧版本未保存独立字幕快照，请切换到最新版本再对比，避免混用来源')
    transcript = task.get('transcript') or {}
    if not transcript.get('segments'):
        cache = notes.cache_path(request.task_id, 'transcript')
        if cache.is_file():
            transcript = json.loads(cache.read_text(encoding='utf-8'))
    segments = []
    for item in transcript.get('segments') or []:
        start, end = float(item['start']), float(item['end'])
        if not all(math.isfinite(v) for v in (start, end)) or not 0 <= start <= end:
            raise ValueError('字幕时间无效，无法冻结来源')
        if end < (request.start_time or 0) or request.end_time is not None and start >= request.end_time:
            continue
        segments.append({'start': start, 'end': end, 'text': str(item['text'])})
    if not segments or sum(len(s['text']) for s in segments) > 200000:
        raise ValueError('来源字幕为空或超过20万字符，请缩小测试时间范围')
    options = task.get('formData') or {}
    evidence = version.get('evidence') or {}
    images, ranges, frames = [], [], []
    encoded_size = 0
    if request.use_images:
        for frame in evidence.get('frames') or []:
            stamp = frame.get('time')
            if not isinstance(stamp, (int, float)) or not math.isfinite(stamp):
                continue
            if stamp < (request.start_time or 0) or request.end_time is not None and stamp >= request.end_time:
                continue
            relative = frame.get('path')
            if not relative:
                continue
            # Only version-owned persisted evidence, never arbitrary client paths or URLs.
            path = notes.asset(request.task_id, 'versions/' + relative)
            if path.suffix.lower() not in ('.jpg', '.jpeg', '.png', '.webp'):
                raise ValueError('来源图片格式不支持')
            size = path.stat().st_size
            if size > 6 * 1024 * 1024:
                raise ValueError('单张来源图片超过6MiB，请缩小对比范围')
            encoded_size += ((size + 2) // 3) * 4 + 32
            if len(images) >= 120 or encoded_size > 64 * 1024 * 1024:
                raise ValueError('来源图片过多，请缩小测试时间范围')
            raw = path.read_bytes()
            mime = 'jpeg' if path.suffix.lower() in ('.jpg', '.jpeg') else path.suffix[1:]
            images.append(f'data:image/{mime};base64,' + base64.b64encode(raw).decode('ascii'))
            ranges.append({'start': stamp, 'end': stamp})
            frames.append({k: frame[k] for k in ('time', 'reason', 'reasons') if k in frame})
        if not images:
            raise ValueError('该版本没有可复用的证据图片；可明确关闭图片对比，或选择其他版本')
        if len(images) > 120 or sum(map(len, images)) > 64 * 1024 * 1024:
            raise ValueError('来源图片过多，请缩小测试时间范围')
    from app.gpt.prompt import PROMPT_VERSION
    snapshot = {'segments': segments, 'title': (task.get('audioMeta') or {}).get('title') or '',
                'tags': '', 'style': version.get('style') or options.get('style') or 'tutorial',
                'extras': options.get('extras') or '', 'format': options.get('format') or ['link'],
                'images': images, 'ranges': ranges if images else None, 'frames': frames,
                'prompt_version': PROMPT_VERSION}
    fingerprint = hashlib.sha256(json.dumps(snapshot, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    summary = {'fingerprint': fingerprint, 'segments': len(segments), 'image_count': len(images),
               'duration_seconds': max(s['end'] for s in segments) - min(s['start'] for s in segments),
               'prompt_version': PROMPT_VERSION, 'text_chars': sum(len(s['text']) for s in segments),
               'image_policy': 'frozen_evidence_frames' if images else 'text_only',
               'note': '两个方案共用冻结来源；不是复刻历史生成的网格图片请求。'}
    return snapshot, summary


def create_run(request, submit=True):
    if not isinstance(request, ComparisonRequest):
        request = ComparisonRequest.model_validate(request)
    payload = request.model_dump(mode='json')
    signature = hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()
    with LOCK:
        # Idempotency must cover ALL persisted requests, not the paginated UI list.
        for path in root().glob('*/run.json'):
            existing = read(path.parent.name)
            if existing['task_id'] != request.task_id:
                continue
            if existing['request_id'] == request.request_id:
                if existing['signature'] != signature:
                    raise ValueError('该请求ID已用于其他方案，请新建测试')
                return existing
        if ACTIVE:
            raise ValueError('已有对比测试正在进行，请等待完成或取消后再提交')
        with notes.LOCK:
            snapshot, summary = freeze_source(request)
        run_id = uuid.uuid4().hex
        run = {'id': run_id, 'task_id': request.task_id, 'version_id': request.version_id,
               'request_id': request.request_id, 'signature': signature, 'status': 'queued',
               'created_at': now(), 'source': summary,
               'variants': [dict(v, status='queued') for v in payload['variants']]}
        folder(run_id).mkdir(parents=True, exist_ok=False)
        notes._atomic_json(folder(run_id) / 'source.json', snapshot)
        save(run)
        ACTIVE.add(run_id)
        if submit:
            try:
                EXECUTOR.submit(execute_run, run_id)
            except Exception:
                ACTIVE.discard(run_id)
                run.update(status='failed', finished_at=now(), error='无法启动测试执行器，未提交模型请求。')
                save(run)
                raise
        return run


def cancel_run(run_id):
    with LOCK:
        run = read(run_id)
        if run['status'] in ('queued', 'running'):
            CANCELLED.add(run_id)
            run['cancel_requested'] = True
            save(run)
        return run


def execute_run(run_id):
    run = None
    def check_cancel():
        if run_id in CANCELLED:
            raise ValueError('对比已取消，不再提交新的模型请求')
    try:
        from app.services.ai_client import get_client, close_client
        from app.services.generation_usage import GenerationUsageRecorder
        from app.models.transcriber_model import TranscriptSegment
        snapshot = json.loads((folder(run_id) / 'source.json').read_text(encoding='utf-8'))
        with LOCK:
            run = read(run_id)
            run['status'] = 'running'
            save(run)
        for index, variant in enumerate(run['variants']):
            if run_id in CANCELLED:
                variant['status'] = 'cancelled'
                continue
            options = GenerationOptions.model_validate(variant['options'])
            recorder = GenerationUsageRecorder(run['task_id'], options, request_id=run['request_id'],
                kind='comparison', model=variant['model_name'], provider_id=variant['provider_id'],
                directory=folder(run_id) / f'variant-{index}')
            gpt = None
            try:
                variant['status'] = 'running'
                with LOCK: save(run)
                gpt = get_client(variant['provider_id'], variant['model_name'])
                gpt.configure_generation(options, recorder)
                gpt.generation_cancel_check = check_cancel
                source = GPTSource(segment=[TranscriptSegment(**s) for s in snapshot['segments']],
                    title=snapshot['title'], tags=snapshot['tags'], style=snapshot['style'],
                    extras=snapshot['extras'], _format=snapshot['format'],
                    video_img_urls=snapshot['images'], video_image_ranges=snapshot['ranges'],
                    frame_evidence=snapshot['frames'], checkpoint_key=None)
                variant['markdown'] = gpt.summarize(source)
                variant['status'] = 'completed'
                notes._atomic_text(folder(run_id) / f'variant-{index}.md', variant['markdown'])
                recorder.finish('completed')
            except Exception as exc:
                variant['status'] = 'cancelled' if run_id in CANCELLED else 'failed'
                # Provider exceptions may contain credentials or request bodies.
                variant['error'] = '测试未完成；请查看用量记录中的安全错误类别。'
                recorder.finish(variant['status'], error=exc)
            finally:
                if gpt: close_client(gpt.client)
                variant['report'] = recorder.report()
                with LOCK: save(run)
        states = [v['status'] for v in run['variants']]
        run['status'] = 'cancelled' if run_id in CANCELLED else 'completed' if all(s == 'completed' for s in states) else 'partial' if 'completed' in states else 'failed'
        run['finished_at'] = now()
        with LOCK: save(run)
    except Exception:
        with LOCK:
            run = run if run is not None else read(run_id)
            run.update(status='failed', finished_at=now(), error='测试执行中断；未修改原笔记。')
            save(run)
    finally:
        with LOCK:
            ACTIVE.discard(run_id)
            CANCELLED.discard(run_id)
