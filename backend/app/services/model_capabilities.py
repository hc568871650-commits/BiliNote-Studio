"""Explicit, bounded capability probes; only user-started jobs call models."""
import copy
import hashlib
import json
import os
import re
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
DETECTOR_VERSION = 1
EFFORTS = ('none', 'low', 'medium', 'high', 'xhigh', 'max')
CHECKS = ('basic', 'stream', 'tools', 'web_native')


def _provider(provider_id):
    from app.services.provider import ProviderService
    provider = ProviderService.get_provider_by_id(provider_id)
    if not provider or not provider.get('enabled', True):
        raise ValueError('供应商不存在或已禁用')
    return provider


def _identity(provider_id, model_name, protocol):
    if protocol not in ('openai-chat', 'openai-responses', 'anthropic'):
        raise ValueError('不支持的协议')
    if not isinstance(model_name, str) or not model_name.strip() or len(model_name) > 200:
        raise ValueError('请选择有效模型')
    if re.search(r'whisper|transcribe|transcription|^scribe', model_name, re.I):
        raise ValueError('转写模型不适用聊天能力测试')
    provider = _provider(provider_id)
    identity = json.dumps([provider_id, model_name, protocol], ensure_ascii=False)
    # Fingerprint remains server-side; changing credentials invalidates old evidence.
    fingerprint = hashlib.sha256(json.dumps([provider.get('base_url', '').rstrip('/'), provider.get('api_key', ''), DETECTOR_VERSION]).encode()).hexdigest()
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
    from app.services.ai_runtime import reasoning_choices
    values = reasoning_choices(model_name, protocol)[1:]
    if protocol == 'anthropic':
        return list(EFFORTS)
    return values or list(EFFORTS)


def get_capabilities(provider_id, model_name, protocol='openai-chat'):
    key, fingerprint = _identity(provider_id, model_name, protocol)
    with LOCK:
        saved = _read().get(key)
    stale = bool(saved and saved.get('fingerprint') != fingerprint)
    features = copy.deepcopy(saved.get('features', {})) if saved and not stale else {}
    from app.services.web_search import available
    return {'provider_id': provider_id, 'model_name': model_name, 'protocol': protocol,
            'candidates': candidates(model_name, protocol), 'features': features, 'stale': stale,
            'available_efforts': ['auto'] + [e for e in EFFORTS if features.get('reasoning:' + e, {}).get('status') == 'passed'],
            'external_search_available': available()}


def available_efforts(provider_id, model_name, protocol):
    if not STATE_PATH.exists():
        return ['auto']
    return get_capabilities(provider_id, model_name, protocol)['available_efforts']


def _public(job):
    return copy.deepcopy({k: v for k, v in job.items() if k not in ('fingerprint', 'key', 'client')})


def get_job(identifier):
    with LOCK:
        if identifier not in JOBS:
            raise ValueError('测试任务不存在，服务重启后请查看已保存的能力记录')
        return _public(JOBS[identifier])


def cancel_job(identifier):
    with LOCK:
        if identifier not in JOBS:
            raise ValueError('测试任务不存在')
        job = JOBS[identifier]
        if job['status'] not in ('completed', 'failed', 'cancelled'):
            job['status'] = 'cancelled'
        client = job.get('client')
    if client:
        from app.services.ai_client import close_client
        close_client(client)
    return get_job(identifier)


def start_test(provider_id, model_name, protocol, checks):
    key, fingerprint = _identity(provider_id, model_name, protocol)
    checks = list(dict.fromkeys(checks))
    allowed = {*CHECKS, *['reasoning:' + e for e in candidates(model_name, protocol)]}
    if not checks or len(checks) > 10 or any(c not in allowed for c in checks):
        raise ValueError('请选择有效的测试项目')
    if 'web_native' in checks and protocol != 'openai-responses':
        raise ValueError('原生联网检测当前适用于 Responses；其他协议可使用外部检索')
    if not _provider(provider_id).get('api_key'):
        raise ValueError('请先保存供应商密钥')
    with LOCK:
        for job in JOBS.values():
            if job['key'] == key and job['status'] in ('queued', 'running'):
                return _public(job)
        if sum(j['status'] in ('queued', 'running') for j in JOBS.values()) >= 20:
            raise ValueError('检测队列已满，请等待当前任务完成')
        completed = [j for j in JOBS if JOBS[j]['status'] in ('completed', 'failed', 'cancelled')]
        for old in completed[:-80]:
            JOBS.pop(old, None)
        identifier = uuid.uuid4().hex
        job = {'id': identifier, 'provider_id': provider_id, 'model_name': model_name, 'protocol': protocol,
               'checks': checks, 'status': 'queued', 'completed': 0, 'total': len(checks), 'results': {},
               'fingerprint': fingerprint, 'key': key}
        JOBS[identifier] = job
        EXECUTOR.submit(_run, identifier)
        return _public(job)


def _probe(client, model, protocol, check):
    from app.services.ai_runtime import complete, visible_answer
    messages = [{'role': 'user', 'content': 'Reply with the single word OK.'}]
    options = {'probe': True, 'max_output_tokens': 1024}
    if check.startswith('reasoning:'):
        options['reasoning_effort'] = check.split(':', 1)[1]
        messages = [{'role': 'user', 'content': 'Calculate 37 * 19. Reply with the number only.'}]
        options['max_output_tokens'] = 2048
    elif check == 'tools':
        messages = [{'role': 'user', 'content': 'Call capability_echo with value "ok". Do not answer in text.'}]
        options['tools'] = [{'type': 'function', 'function': {'name': 'capability_echo', 'description': 'Return the given value.',
                            'parameters': {'type': 'object', 'properties': {'value': {'type': 'string'}}, 'required': ['value'], 'additionalProperties': False}}}]
    elif check == 'web_native':
        messages = [{'role': 'user', 'content': 'Use web search to find the official Python documentation website. Reply with its title and a citation.'}]
        options.update(web_search=True, require_web=True)
    elif check == 'stream':
        options['stream'] = True
    if protocol == 'anthropic' and check.startswith('reasoning:'):
        from app.services.protocol_clients import anthropic_options
        options['max_output_tokens'] = anthropic_options(model, messages, {'reasoning_effort': options['reasoning_effort'], 'max_tokens': 2048})['max_tokens']
    result = complete(client, model, messages, **options)
    delta_seen = False
    if check == 'stream':
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
    if check == 'tools':
        calls = getattr(response.choices[0].message, 'tool_calls', None) or []
        if not any(c.function.name == 'capability_echo' and json.loads(c.function.arguments) == {'value': 'ok'} for c in calls):
            return 'inconclusive', '请求被接受，但没有返回预期的结构化工具调用', response
        return 'passed', '收到结构化工具调用，未执行任何真实操作', response
    visible_answer(response)
    if check == 'web_native':
        if not getattr(response, 'web_search_used', False) or not getattr(response, 'web_sources', []):
            return 'inconclusive', '没有完整的搜索工具事件和可核查来源', response
        return 'passed', '搜索工具已完成并返回结构化来源', response
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
            feature = {'checked_at': datetime.now(timezone.utc).isoformat()}
            try:
                client = get_client(job['provider_id'], job['model_name'], protocol=job['protocol']).client
                with LOCK:
                    if job['status'] == 'cancelled':
                        return
                    job['client'] = client
                status, evidence, response = _probe(client, job['model_name'], job['protocol'], check)
                feature.update(status=status, evidence=evidence)
                raw_usage = getattr(response, 'raw_usage', None)
                if not isinstance(raw_usage, dict):
                    usage = getattr(response, 'usage', None)
                    raw_usage = usage.model_dump() if callable(getattr(usage, 'model_dump', None)) else {}
                feature['usage'] = {k: v for k, v in raw_usage.items() if isinstance(v, (int, float)) and not isinstance(v, bool)}
                feature['usage']['output_token_limit'] = getattr(response, 'probe_output_token_limit', 1024)
            except Exception as exc:
                details = error_details(exc, job['protocol'], getattr(client, 'api_key', None))
                explicit = details['http_status'] in (400, 404, 422) and bool(re.search(r'unsupported|not.support|unknown.parameter|unrecognized|不支持', details['detail'], re.I))
                feature.update(status='unsupported' if explicit else 'inconclusive' if details['kind'] == 'validation' else 'failed',
                               evidence=details['detail'], error_details=details)
            finally:
                if client:
                    close_client(client)
                with LOCK:
                    job.pop('client', None)
            feature['elapsed_ms'] = round((time.monotonic() - started) * 1000)
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
                state[job['key']] = {'fingerprint': job['fingerprint'], 'features': features}
                _write(state)
            # A failed basic request should not fan out into more paid failures.
            if check == 'basic' and feature['status'] != 'passed':
                with LOCK:
                    job.update(status='failed', error='基础请求未通过，已停止后续检测，避免重复失败调用')
                break
        with LOCK:
            if job['status'] == 'running':
                job['status'] = 'completed'
    except Exception as exc:
        with LOCK:
            if job['status'] != 'cancelled':
                job.update(status='failed', error=error_details(exc, job['protocol'])['detail'])
