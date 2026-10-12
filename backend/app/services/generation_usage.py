"""Safe run audit: counters and supplier metadata, never request/response bodies.

Every HTTP attempt is persisted before dispatch and after completion. Missing token
counts remain unknown; provider totals include reasoning, so it is not added again.
"""
import json
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

from app.models.generation_options import GenerationOptions
from app.services import note_storage


TOKEN_FIELDS = ('input_tokens', 'output_tokens', 'reasoning_tokens', 'cached_input_tokens',
                'cache_miss_tokens', 'total_tokens')


def _field(value, name):
    return value.get(name) if isinstance(value, dict) else getattr(value, name, None)


def _count(value):
    return value if type(value) is int and value >= 0 else None


def extract_usage(response):
    usage = _field(response, 'usage')
    def first(*values):
        return next((value for value in map(_count, values) if value is not None), None)
    result = {
        'input_tokens': first(_field(usage, 'prompt_tokens'), _field(usage, 'input_tokens')),
        'output_tokens': first(_field(usage, 'completion_tokens'), _field(usage, 'output_tokens')),
        'reasoning_tokens': first(_field(_field(usage, 'completion_tokens_details'), 'reasoning_tokens'),
                                 _field(_field(usage, 'output_tokens_details'), 'reasoning_tokens')),
        'cached_input_tokens': first(_field(usage, 'prompt_cache_hit_tokens'),
                                    _field(_field(usage, 'prompt_tokens_details'), 'cached_tokens'),
                                    _field(_field(usage, 'input_tokens_details'), 'cached_tokens')),
        'cache_miss_tokens': _count(_field(usage, 'prompt_cache_miss_tokens')),
        'total_tokens': _count(_field(usage, 'total_tokens')),
    }
    flags = []
    inp, out, total = (result[key] for key in ('input_tokens', 'output_tokens', 'total_tokens'))
    cached, miss, reasoning = (result[key] for key in ('cached_input_tokens', 'cache_miss_tokens', 'reasoning_tokens'))
    if None not in (inp, out, total) and inp + out != total:
        flags.append('input_output_total_mismatch')
    if inp is not None and cached is not None and cached > inp:
        flags.append('cached_exceeds_input')
    if out is not None and reasoning is not None and reasoning > out:
        flags.append('reasoning_exceeds_output')
    if None not in (inp, cached, miss) and cached + miss != inp:
        flags.append('cache_hit_miss_input_mismatch')
    result['discrepancies'] = flags
    result['cache_status'] = 'not_reported' if cached is None else ('hit' if cached else 'miss')
    return result


def _now():
    return datetime.now(timezone.utc).isoformat()


def _usage_dir(task_id):
    # Resolve for each write: storage may rename the note folder when its title arrives.
    folder = note_storage._note_dir(task_id)
    return folder / '_meta' / 'generation_usage' if folder else note_storage.ROOT / '_generation_usage' / task_id


def list_generation_runs(task_id):
    note_storage.valid_id(task_id)
    directory = _usage_dir(task_id)
    if not directory.exists():
        return []
    note_storage._inside(directory, note_storage.ROOT)
    if directory.is_symlink():
        raise ValueError('Linked generation audit directory is not supported')
    runs = []
    for path in directory.glob('*.json'):
        if path.is_symlink():
            continue
        try:
            value = json.loads(path.read_text(encoding='utf-8'))
            if isinstance(value, dict) and value.get('schema_version') == 1 and value.get('task_id') == task_id:
                runs.append(value)
        except (OSError, ValueError):
            continue
    return sorted(runs, key=lambda run: run.get('started_at', ''), reverse=True)


class GenerationUsageRecorder:
    def __init__(self, task_id, options=None, request_id=None, kind='normal', model=None,
                 provider_id=None, run_id=None, directory=None):
        self.options = options if isinstance(options, GenerationOptions) else GenerationOptions.model_validate(options or {})
        self.lock = threading.RLock()
        self.started = time.monotonic()
        self.attempt_started = {}
        self.directory = Path(directory) if directory is not None else None
        run_id = note_storage.valid_id(run_id or uuid.uuid4().hex)
        self.data = dict(schema_version=1, run_id=run_id, task_id=note_storage.valid_id(task_id),
                         request_id=request_id, kind=kind, model=model, provider_id=provider_id,
                         started_at=_now(), finished_at=None, elapsed_ms=0, status='running',
                         settings_requested=self.options.model_dump(mode='json'), settings_effective={},
                         attempts=[], events=[], error=None)
        self.persist()

    def set_effective(self, settings):
        with self.lock:
            self.data['settings_effective'] = dict(settings)
            self.persist()

    def event(self, event, *, phase=None, node=None, depth=None):
        with self.lock:
            self.data['events'].append(dict(event=event, phase=phase, node=node, depth=depth, at=_now()))
            self.persist()

    def start_attempt(self, *, phase='summarize', node=None, depth=0, retry_index=0,
                      reason='initial', settings=None, request_bytes=None, text_chars=None, image_count=None,
                      logical_request_id=None):
        with self.lock:
            index = len(self.data['attempts']) + 1
            self.data['settings_effective'].update(settings or {})
            attempt = dict(index=index, phase=phase, node=node, depth=depth, retry_index=retry_index,
                           logical_request_id=logical_request_id or str(index),
                           reason=reason, settings_effective=dict(settings or {}), started_at=_now(),
                           finished_at=None, elapsed_ms=None, status='running', http_status=None,
                           finish_reason=None, error_type=None, request_bytes=request_bytes,
                           text_chars=text_chars, image_count=image_count, usage=extract_usage(None))
            self.data['attempts'].append(attempt)
            self.attempt_started[index] = time.monotonic()
            self.persist()
            return index

    def complete_attempt(self, index, *, response=None, error=None):
        with self.lock:
            attempt = self.data['attempts'][index - 1]
            choices = _field(response, 'choices') or []
            reason = _field(choices[0], 'finish_reason') if isinstance(choices, (list, tuple)) and choices else None
            message = _field(choices[0], 'message') if isinstance(choices, (list, tuple)) and choices else None
            content = _field(message, 'content')
            valid_body = isinstance(content, str) and bool(content.strip()) and not _field(message, 'refusal')
            reason = reason if reason in ('stop', 'length', 'content_filter', 'tool_calls', 'function_call') else None
            raw_status = _field(error, 'status_code') or _field(error, 'status')
            status_code = raw_status if type(raw_status) is int and 100 <= raw_status <= 599 else None
            attempt.update(finished_at=_now(), elapsed_ms=round((time.monotonic() - self.attempt_started.pop(index)) * 1000, 2),
                           status='failed' if error else ('truncated' if reason == 'length' else
                               ('succeeded' if reason == 'stop' and valid_body else 'invalid_response')),
                           http_status=status_code if error else 200, finish_reason=reason,
                           error_type=type(error).__name__ if error else None, usage=extract_usage(response))
            self.persist()

    def finish(self, status, error=None):
        with self.lock:
            self.data.update(status=status, finished_at=_now(), elapsed_ms=round((time.monotonic() - self.started) * 1000, 2),
                             error={'type': type(error).__name__} if error else None)
            self.persist()
            return self.report()

    def bind_version(self, version_id):
        with self.lock:
            self.data['version_id'] = version_id
            self.persist()

    def report(self):
        with self.lock:
            result = json.loads(json.dumps(self.data))
            attempts = result['attempts']
            totals, reported, missing = {}, {}, {}
            for field in TOKEN_FIELDS:
                values = [attempt['usage'][field] for attempt in attempts]
                known = [value for value in values if value is not None]
                totals[field] = sum(known) if values and len(known) == len(values) else None
                reported[field] = sum(known) if known else None
                missing[field] = len(values) - len(known)
            counts = dict(http_attempts=len(attempts), succeeded=sum(a['status'] == 'succeeded' for a in attempts),
                          failed=sum(a['status'] == 'failed' for a in attempts),
                          retries=sum(a['reason'] == 'retry' for a in attempts),
                          temperature_fallbacks=sum(a['reason'] == 'temperature_fallback' for a in attempts),
                          truncations=sum(a['finish_reason'] == 'length' for a in attempts),
                          merge_attempts=sum(a['phase'] == 'merge' for a in attempts),
                          summarize_attempts=sum(a['phase'] == 'summarize' for a in attempts))
            result.update(elapsed_ms=round((time.monotonic() - self.started) * 1000, 2)
                          if result['status'] == 'running' else self.data['elapsed_ms'],
                          counts=counts, totals=totals, reported_totals=reported, missing_usage_counts=missing,
                          usage_discrepancies=sorted({flag for a in attempts for flag in a['usage']['discrepancies']}),
                          estimated_cost=self._cost(attempts, totals), cost_is_estimate=True)
            requests = []
            for logical_id in dict.fromkeys(a['logical_request_id'] for a in attempts):
                group = [a for a in attempts if a['logical_request_id'] == logical_id]
                last = group[-1]
                row = dict(id=logical_id, phase=last['phase'], node=last['node'], status=last['status'],
                           finish_reason=last['finish_reason'], attempt_count=len(group),
                           duration_seconds=round((datetime.fromisoformat(last['finished_at'] or _now()) -
                               datetime.fromisoformat(group[0]['started_at'])).total_seconds(), 3),
                           error=last['error_type'], settings_effective=last['settings_effective'])
                for field in TOKEN_FIELDS:
                    values = [a['usage'][field] for a in group]
                    row['thinking_tokens' if field == 'reasoning_tokens' else field] = (
                        sum(values) if all(value is not None for value in values) else None)
                requests.append(row)
            result.update(id=result['run_id'], model_name=result['model'], created_at=result['started_at'],
                          options=result['settings_requested'], requests=requests,
                          summary=dict(request_count=len(requests), attempt_count=len(attempts),
                                       successful_requests=sum(r['status'] == 'succeeded' for r in requests),
                                       duration_seconds=round(result['elapsed_ms'] / 1000, 3),
                                       input_tokens=totals['input_tokens'], output_tokens=totals['output_tokens'],
                                       thinking_tokens=totals['reasoning_tokens'], cached_input_tokens=totals['cached_input_tokens'],
                                       total_tokens=totals['total_tokens'], cost_estimate=result['estimated_cost']),
                          warnings=result['usage_discrepancies'] + (['partial_usage_metadata']
                              if attempts and any(missing.values()) else []) + sorted({event['event']
                                  for event in result['events'] if event['event'] in
                                  ('temperature_omitted', 'merge_truncation_assembled', 'request_budget_exhausted')}))
            return result

    def _cost(self, attempts, totals):
        price = self.options.price
        if price is None:
            return None
        amount = None
        if price.mode == 'per_call' and price.per_call is not None:
            amount = len(attempts) * price.per_call
        elif price.mode == 'tokens' and attempts and not any(a['usage']['discrepancies'] for a in attempts):
            inp, out, cached = (totals[field] for field in ('input_tokens', 'output_tokens', 'cached_input_tokens'))
            if inp is not None and out is not None and (price.cached_input_per_million is None or cached is not None):
                cached = cached or 0
                amount = ((inp - cached) * price.input_per_million + out * price.output_per_million +
                          cached * (price.cached_input_per_million if price.cached_input_per_million is not None
                                    else price.input_per_million)) / 1_000_000
        return dict(amount=round(amount, 8) if amount is not None else None, currency=price.currency,
                    mode=price.mode, basis='all_http_attempts' if price.mode == 'per_call' else 'reported_tokens',
                    complete=amount is not None, provider_invoice_verified=False)

    def persist(self):
        if self.data['status'] == 'running':
            self.data['elapsed_ms'] = round((time.monotonic() - self.started) * 1000, 2)
        directory = self.directory if self.directory is not None else _usage_dir(self.data['task_id'])
        if self.directory is None:
            note_storage._inside(directory, note_storage.ROOT)
        if directory.is_symlink():
            raise ValueError('Linked generation audit directory is not supported')
        note_storage._atomic_json(directory / f"{self.data['run_id']}.json", self.report())
