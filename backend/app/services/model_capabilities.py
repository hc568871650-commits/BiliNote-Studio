"""Explicit, bounded capability probes; only user-started jobs call models."""
import copy
import base64
import hashlib
import io
import json
import math
import os
import re
import secrets
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

STATE_PATH = Path('data') / 'model_capabilities.json'
LOCK = threading.RLock()
EXECUTOR = ThreadPoolExecutor(max_workers=1, thread_name_prefix='model-probe')
JOBS = {}
DETECTOR_VERSION = 3
EFFORTS = ('none', 'low', 'medium', 'high', 'xhigh', 'max')
CHECKS = ('basic', 'stream', 'tools', 'web_native', 'vision')
TERMINAL = ('completed', 'failed', 'cancelled')
USAGE_KEYS = {'input_tokens', 'output_tokens', 'total_tokens', 'prompt_tokens', 'completion_tokens',
              'cached_tokens', 'reasoning_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens',
              'input_tokens_details', 'output_tokens_details', 'prompt_tokens_details', 'completion_tokens_details',
              'audio_tokens', 'accepted_prediction_tokens', 'rejected_prediction_tokens',
              'promptTokenCount', 'candidatesTokenCount', 'totalTokenCount', 'thoughtsTokenCount',
              'cachedContentTokenCount'}


def _usage(value, depth=0):
    if not isinstance(value, dict) or depth >= 3:
        return {}
    return {k: _usage(v, depth + 1) if isinstance(v, dict) else v for k, v in value.items()
            if k in USAGE_KEYS and (isinstance(v, dict) or type(v) is int and v >= 0
                                   or type(v) is float and math.isfinite(v) and v >= 0)}


def _summary(job):
    counts = {s: sum(f.get('status') == s for f in job['results'].values())
              for s in ('passed', 'failed', 'unsupported', 'inconclusive', 'skipped')}
    job['counts'] = counts
    if job.get('invalidated'):
        job['outcome'] = 'invalidated'
    elif job['status'] == 'cancelled':
        job['outcome'] = 'cancelled'
    elif job['status'] not in TERMINAL:
        job['outcome'] = 'pending'
    elif counts['passed'] == job['total']:
        job['outcome'] = 'passed'
    elif counts['passed']:
        job['outcome'] = 'partial'
    elif counts['failed'] or counts['unsupported']:
        job['outcome'] = 'failed'
    else:
        job['outcome'] = 'inconclusive'


def _skip(job, reason):
    for check in job['checks']:
        if check not in job['results']:
            job['results'][check] = {'status': 'skipped', 'evidence': reason,
                                    'job_id': job['id'], 'check': check, 'request_id': None}
    job['skipped'] = [c for c, f in job['results'].items() if f['status'] == 'skipped']


def _persist(job):
    state = _read()
    record = state.get(job['key'], {})
    history = record.get('history', [])[-5:]
    history = [h for h in history if h.get('id') != job['id']]
    history.append(dict(_public(job), fingerprint=job['fingerprint']))
    record['history'] = history[-5:]
    state[job['key']] = record
    _write(state)


def _provider(provider_id):
    from app.services.provider import ProviderService
    provider = ProviderService.get_provider_by_id(provider_id)
    if not provider or not provider.get('enabled', True):
        raise ValueError('供应商不存在或已禁用')
    return provider


def _identity(provider_id, model_name, protocol):
    if protocol not in ('openai-chat', 'openai-responses', 'anthropic', 'gemini'):
        raise ValueError('不支持的协议')
    if not isinstance(model_name, str) or not model_name.strip() or len(model_name) > 200:
        raise ValueError('请选择有效模型')
    if re.search(r'whisper|transcribe|transcription|^scribe', model_name, re.I):
        raise ValueError('转写模型不适用聊天能力测试')
    provider = _provider(provider_id)
    identity = json.dumps([provider_id, model_name, protocol], ensure_ascii=False)
    # Fingerprint remains server-side; changing credentials invalidates old evidence.
    fingerprint = hashlib.sha256(json.dumps([provider.get('base_url', '').rstrip('/'), provider.get('api_key', ''),
                                           provider.get('type'), DETECTOR_VERSION]).encode()).hexdigest()
    return hashlib.sha256(identity.encode()).hexdigest(), fingerprint


def _read():
    if not STATE_PATH.exists():
        return {}
    data = json.loads(STATE_PATH.read_text(encoding='utf-8'))
    if not isinstance(data, dict):
        raise ValueError('能力记录损坏，请保留文件后检查')
    return data


def _write(data):
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    temporary = STATE_PATH.with_suffix('.tmp')
    temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
    os.replace(temporary, STATE_PATH)


def candidates(model_name, protocol):
    from app.services.ai_runtime import request_effort_choices
    return request_effort_choices(model_name, protocol)[1:]


def get_capabilities(provider_id, model_name, protocol='openai-chat'):
    key, fingerprint = _identity(provider_id, model_name, protocol)
    with LOCK:
        saved = _read().get(key)
    stale = bool(saved and saved.get('fingerprint') != fingerprint)
    features = copy.deepcopy(saved.get('features', {})) if saved and not stale else {}
    history = []
    for entry in (saved or {}).get('history', [])[-5:]:
        item = copy.deepcopy(entry)
        item['stale'] = item.pop('fingerprint', None) != fingerprint
        history.append(item)
    from app.services.web_search import available
    return {'provider_id': provider_id, 'model_name': model_name, 'protocol': protocol,
            'candidates': candidates(model_name, protocol), 'features': features, 'stale': stale, 'history': history,
            'available_efforts': ['auto', *candidates(model_name, protocol)],
            'external_search_available': available()}


def available_efforts(provider_id, model_name, protocol):
    return ['auto', *candidates(model_name, protocol)]


def _public(job):
    _summary(job)
    return copy.deepcopy({k: v for k, v in job.items() if k not in ('fingerprint', 'key', 'client')})


def active_jobs():
    with LOCK:
        return [_public(j) for j in JOBS.values() if j['status'] in ('queued', 'running') or j.get('client')]


def get_job(identifier):
    with LOCK:
        if identifier not in JOBS:
            raise ValueError('测试任务不存在，服务重启后请查看已保存的能力记录')
        job = JOBS[identifier]
        result = _public(job)
        try:
            result['stale'] = _identity(job['provider_id'], job['model_name'], job['protocol'])[1] != job['fingerprint']
        except ValueError:
            result['stale'] = True
        return result


def cancel_job(identifier):
    with LOCK:
        if identifier not in JOBS:
            raise ValueError('测试任务不存在')
        job = JOBS[identifier]
        if job['status'] not in TERMINAL:
            job['status'] = 'cancelled'
            _skip(job, '检测已取消，未执行此项目')
            job['finished_at'] = datetime.now(timezone.utc).isoformat()
            _persist(job)
        client = job.get('client')
    if client:
        from app.services.ai_client import close_client
        close_client(client)
    return get_job(identifier)


def start_test(provider_id, model_name, protocol, checks, probe_stream=False):
    key, fingerprint = _identity(provider_id, model_name, protocol)
    checks = list(dict.fromkeys(checks))
    allowed = {*CHECKS, *['reasoning:' + e for e in candidates(model_name, protocol)]}
    if not checks or len(checks) > len(CHECKS) + len(EFFORTS) or any(c not in allowed for c in checks):
        raise ValueError('请选择有效的测试项目')
    if not _provider(provider_id).get('api_key'):
        raise ValueError('请先保存供应商密钥')
    with LOCK:
        for job in JOBS.values():
            if (job['key'] == key and job['fingerprint'] == fingerprint and job['checks'] == checks
                    and job.get('probe_stream', False) == probe_stream and job['status'] in ('queued', 'running')):
                return _public(job)
        if sum(j['status'] in ('queued', 'running') for j in JOBS.values()) >= 20:
            raise ValueError('检测队列已满，请等待当前任务完成')
        completed = [j for j in JOBS if JOBS[j]['status'] in TERMINAL and not JOBS[j].get('client')]
        for old in completed[:-80]:
            JOBS.pop(old, None)
        identifier = uuid.uuid4().hex
        job = {'id': identifier, 'provider_id': provider_id, 'model_name': model_name, 'protocol': protocol,
               'checks': checks, 'status': 'queued', 'completed': 0, 'total': len(checks), 'results': {},
               'probe_stream': probe_stream, 'skipped': [], 'created_at': datetime.now(timezone.utc).isoformat(),
               'detector_version': DETECTOR_VERSION,
               'fingerprint': fingerprint, 'key': key}
        JOBS[identifier] = job
        EXECUTOR.submit(_run, identifier)
        return _public(job)


def _vision_sample():
    from PIL import Image, ImageDraw, ImageFont
    expected = ''.join(str(secrets.randbelow(10)) for _ in range(6))
    image = Image.new('RGB', (320, 96), 'white')
    draw = ImageDraw.Draw(image)
    try:
        font = ImageFont.load_default(size=48)
        bounds = draw.textbbox((0, 0), expected, font=font)
        draw.text(((320 - bounds[2]) // 2, (96 - bounds[3]) // 2), expected, font=font, fill='black')
    except (ImportError, OSError):
        # Frozen builds may omit FreeType. Pillow also embeds a bitmap font.
        font = ImageFont.load_default_imagefont()
        bounds = font.getbbox(expected)
        glyphs = Image.new('RGB', (bounds[2] - bounds[0], bounds[3] - bounds[1]), 'white')
        ImageDraw.Draw(glyphs).text((-bounds[0], -bounds[1]), expected, font=font, fill='black')
        glyphs = glyphs.resize((glyphs.width * 4, glyphs.height * 4), Image.Resampling.NEAREST)
        image.paste(glyphs, ((320 - glyphs.width) // 2, (96 - glyphs.height) // 2))
    output = io.BytesIO()
    image.save(output, format='PNG')
    raw = output.getvalue()
    return {'expected': expected, 'image_sha256': hashlib.sha256(raw).hexdigest(),
            'data_url': 'data:image/png;base64,' + base64.b64encode(raw).decode('ascii')}


def _vision_unsupported(details):
    # A rejected field, damaged file, unavailable route or server error does not
    # prove that the selected model cannot see images.
    if details.get('http_status') not in (400, 422):
        return False
    text = details.get('detail', '')
    if re.search(r'temporar|overload|unavailable|capacity|rate.limit|quota|decode|base64|image/\w+|image (?:format|size|url)|mime|dimensions|resolution|too large|(?:invalid|malformed) image|暂时|超载|文件|格式|尺寸|超限', text, re.I):
        return False
    patterns = (
        r'(?:this |the |selected )?model[^.;\n]{0,100}(?:does not|doesn.t|cannot|can.t|not|unsupported)[^.;\n]{0,50}(?:support|accept|process)[^.;\n]{0,50}(?:images?|vision|multimodal)',
        r'(?:image inputs?|images?|vision|multimodal)[^.;\n]{0,60}(?:not supported|unsupported|not allowed)[^.;\n]{0,60}(?:model|endpoint)',
        r'(?:image inputs?|images?|vision|multimodal)(?:\s+(?:is|are))?\s+(?:not supported|unsupported)(?:[.;\n]|$)',
        r'(?:model|endpoint)[^.;\n]{0,60}(?:only supports?|only accepts?|supports? only)[^.;\n]{0,30}text',
        r'(?:模型|接口)[^。；\n]{0,50}(?:不支持|无法处理)[^。；\n]{0,30}(?:图片|图像|视觉|多模态)',
        r'(?:模型|接口)[^。；\n]{0,50}(?:仅支持|只支持)[^。；\n]{0,30}(?:文字|文本)',
        r'(?:图片|图像|视觉|多模态)[^。；\n]{0,30}(?:不被|不受|不支持)[^。；\n]{0,30}(?:模型|接口)',
    )
    return any(re.search(pattern, text, re.I) for pattern in patterns)


def _probe(client, model, protocol, check, stream=False, vision_sample=None):
    from app.services.ai_runtime import complete, visible_answer
    messages = [{'role': 'user', 'content': 'Reply with the single word OK.'}]
    options = {'probe': True, 'max_output_tokens': 1024}
    if check == 'tools' or check.startswith('reasoning:'):
        options['stream'] = stream
    if check == 'vision':
        vision_sample = vision_sample or _vision_sample()
        messages = [{'role': 'user', 'content': [
            {'type': 'text', 'text': 'Read the digits in this image. Reply with only the digits, preserving their order.'},
            {'type': 'image_url', 'image_url': {'url': vision_sample['data_url']}},
        ]}]
        options['stream'] = True
    elif check.startswith('reasoning:'):
        options['reasoning_effort'] = check.split(':', 1)[1]
        messages = [{'role': 'user', 'content': 'Calculate 37 * 19. Reply with the number only.'}]
        options['max_output_tokens'] = 2048
    elif check == 'tools':
        messages = [{'role': 'user', 'content': 'Call capability_echo with value "ok". Do not answer in text.'}]
        options['tools'] = [{'type': 'function', 'function': {'name': 'capability_echo', 'description': 'Return the given value.',
                            'parameters': {'type': 'object', 'properties': {'value': {'type': 'string'}}, 'required': ['value'], 'additionalProperties': False}}}]
    elif check == 'web_native':
        messages = [{'role': 'user', 'content': 'Use web search to find the official Python documentation website. Reply with its title and a citation.'}]
        options.update(web_search=True, require_web=True, stream=True, max_output_tokens=8192)
        if getattr(client, 'bilinote_native_search_route', None) == 'deepseek-anthropic':
            options['reasoning_effort'] = 'none'
    elif check == 'stream':
        options['stream'] = True
    if protocol == 'anthropic' and check.startswith('reasoning:'):
        from app.services.protocol_clients import anthropic_options
        options['max_output_tokens'] = anthropic_options(model, messages, {'reasoning_effort': options['reasoning_effort'], 'max_tokens': 2048})['max_tokens']
    result = complete(client, model, messages, **options)
    delta_seen = False
    if options.get('stream'):
        while True:
            try:
                event = next(result)
                delta_seen = delta_seen or event.get('type') == 'delta' and bool(event.get('text'))
            except StopIteration as stopped:
                response, _ = stopped.value
                break
    else:
        response, _ = result
    response.probe_output_token_limit = options['max_output_tokens']
    if check == 'vision':
        from app.utils.ai_errors import _safe
        observed = getattr(response.choices[0].message, 'content', '')
        observed = observed.strip() if isinstance(observed, str) else ''
        # Extra prose is harmless; accepting any of several guesses is not.
        matches = re.findall(r'(?<!\d)\d+(?!\d)', observed)
        response.probe_vision_validation = {
            'expected': vision_sample['expected'], 'observed': _safe(observed, getattr(client, 'api_key', None), 120),
            'matched': matches == [vision_sample['expected']],
        }
    if check == 'tools':
        calls = getattr(response.choices[0].message, 'tool_calls', None) or []
        try:
            matched = any(c.function.name == 'capability_echo' and json.loads(c.function.arguments) == {'value': 'ok'} for c in calls)
        except (ValueError, TypeError, AttributeError):
            matched = False
        if not matched:
            return 'inconclusive', '请求被接受，但没有返回预期的结构化工具调用', response
        return 'passed', '收到结构化工具调用，未执行任何真实操作', response
    try:
        visible_answer(response)
    except ValueError as exc:
        from app.utils.ai_errors import error_details
        return 'inconclusive', error_details(exc, protocol, getattr(client, 'api_key', None))['detail'], response
    if check == 'web_native':
        if not getattr(response, 'web_search_used', False) or not getattr(response, 'web_sources', []):
            return 'inconclusive', '未返回可验证的搜索记录或来源', response
        return 'passed', '搜索工具已完成并返回结构化来源', response
    if check == 'vision':
        if not response.probe_vision_validation['matched']:
            return 'inconclusive', '已接受图片，但未正确识别样例；尚不能确认看图能力', response
        return 'passed', '真实图片中的随机数字识别正确；已验证当前配置的看图能力', response
    if check == 'stream' and not delta_seen:
        return 'inconclusive', '收到完整回复，但没有正文流式事件', response
    if check.startswith('reasoning:'):
        return 'passed', '参数已接受并得到正文；不以该结果证明供应商实际思考强度', response
    return 'passed', '收到可显示的正文' + ('和流式事件' if delta_seen else ''), response


def _run(identifier):
    from app.services.ai_client import get_client, close_client
    from app.utils.ai_errors import error_details
    with LOCK:
        job = JOBS[identifier]
        if job['status'] == 'cancelled':
            return
        job['status'] = 'running'
    try:
        for check in job['checks']:
            with LOCK:
                if job['status'] == 'cancelled':
                    return
            if _identity(job['provider_id'], job['model_name'], job['protocol'])[1] != job['fingerprint']:
                raise ValueError('供应商配置已改变，检测停止，请按新配置重新测试')
            started = time.monotonic()
            client = None
            feature = {'checked_at': datetime.now(timezone.utc).isoformat(), 'job_id': identifier, 'check': check,
                       'stream': check in ('stream', 'web_native', 'vision') or (check == 'tools' or check.startswith('reasoning:')) and job['probe_stream'],
                       'request_id': None}
            try:
                vision_sample = _vision_sample() if check == 'vision' else None
                if vision_sample:
                    feature.update(image_sha256=vision_sample['image_sha256'], sample_kind='pixel-digits-v1', request_attempts=0)
                client = get_client(job['provider_id'], job['model_name'], protocol=job['protocol'],
                                    native_search=check == 'web_native').client
                with LOCK:
                    if job['status'] == 'cancelled':
                        return
                    job['client'] = client
                wire_protocol = getattr(client, 'protocol', job['protocol'])
                if isinstance(wire_protocol, str):
                    feature['upstream_protocol'] = wire_protocol
                if vision_sample:
                    feature['request_attempts'] = 1
                    status, evidence, response = _probe(client, job['model_name'], job['protocol'], check,
                                                        job['probe_stream'], vision_sample=vision_sample)
                else:
                    status, evidence, response = _probe(client, job['model_name'], job['protocol'], check, job['probe_stream'])
                feature.update(status=status, evidence=evidence)
                if vision_sample:
                    feature['validation'] = getattr(response, 'probe_vision_validation', {})
                raw_usage = getattr(response, 'raw_usage', None)
                if not isinstance(raw_usage, dict):
                    usage = getattr(response, 'usage', None)
                    raw_usage = usage.model_dump() if callable(getattr(usage, 'model_dump', None)) else {}
                feature['usage'] = _usage(raw_usage)
                feature['usage']['output_token_limit'] = getattr(response, 'probe_output_token_limit', 1024)
                from app.utils.ai_errors import _safe
                feature['request_id'] = _safe(getattr(response, '_request_id', None) or getattr(response, 'request_id', None), getattr(client, 'api_key', None), 160) or None
            except Exception as exc:
                details = error_details(exc, job['protocol'], getattr(client, 'api_key', None))
                explicit = (_vision_unsupported(details) if check == 'vision' else
                            details['http_status'] in (400, 404, 422) and bool(re.search(r'unsupported|not.support|unknown.parameter|unrecognized|不支持', details['detail'], re.I)))
                feature.update(status='unsupported' if explicit else 'inconclusive' if details['kind'] == 'validation' else 'failed',
                               evidence=details['detail'], error_details=details, request_id=details.get('request_id'))
            finally:
                feature['elapsed_ms'] = round((time.monotonic() - started) * 1000)
                if client:
                    close_client(client)
                with LOCK:
                    job.pop('client', None)
            with LOCK:
                if job['status'] == 'cancelled':
                    return
                # A response from old credentials cannot grant capability to new ones.
                if _identity(job['provider_id'], job['model_name'], job['protocol'])[1] != job['fingerprint']:
                    raise ValueError('供应商配置已改变，未保存过期检测结果')
                job['results'][check] = feature
                job['completed'] += 1
                state = _read()
                record = state.get(job['key'], {})
                features = record.get('features', {}) if record.get('fingerprint') == job['fingerprint'] else {}
                features[check] = feature
                record.update(fingerprint=job['fingerprint'], features=features)
                state[job['key']] = record
                _write(state)
            details = feature.get('error_details', {})
            if details.get('http_status') in (401, 403, 429) or details.get('kind') == 'connection':
                with LOCK:
                    job.update(status='failed', error='认证、限流或连接不可达，已停止后续检测')
                    _skip(job, job['error'])
                break
        with LOCK:
            if job['status'] == 'running':
                job['status'] = 'completed'
    except Exception as exc:
        with LOCK:
            if job['status'] != 'cancelled':
                job.update(status='failed', error=error_details(exc, job['protocol'])['detail'])
                job['invalidated'] = '配置已改变' in job['error'] or '不存在或已禁用' in job['error']
                _skip(job, job['error'])
    finally:
        with LOCK:
            job['finished_at'] = datetime.now(timezone.utc).isoformat()
            _persist(job)
