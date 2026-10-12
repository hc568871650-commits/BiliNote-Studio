"""Two bounded live requests: synthetic library answer and native search evidence."""
import argparse
import json
import logging
import os
import sqlite3
import tempfile
import time
import types
from pathlib import Path
from unittest.mock import patch
from urllib.parse import urlsplit
from serve_organizer_fixture import bootstrap


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--database', required=True)
    parser.add_argument('--provider-id', required=True)
    parser.add_argument('--model', required=True)
    parser.add_argument('--report', required=True)
    parser.add_argument('--case', choices=['all', 'library_answer', 'native_web_search'], default='all')
    parser.add_argument('--timeout', type=float, default=45.0)
    args = parser.parse_args()
    if not 1 <= args.timeout <= 120:
        raise ValueError('Live timeout must be between 1 and 120 seconds')
    workspace = Path(__file__).resolve().parents[2]
    output = Path(args.report).resolve()
    if not output.is_relative_to(workspace / '.BiliNote-dev') or output.exists():
        raise ValueError('Use a new report inside .BiliNote-dev')
    bootstrap(workspace / '.BiliNote-dev' / 'agent-compatible-deps')
    with sqlite3.connect(Path(args.database).resolve().as_uri()+'?mode=ro', uri=True) as db:
        db.execute('PRAGMA query_only=ON')
        row = db.execute('SELECT api_key,base_url,enabled FROM providers WHERE id=?', (args.provider_id,)).fetchone()
    if not row or not row[2] or not row[0]:
        raise ValueError('Selected provider unavailable')
    key, endpoint = row[:2]
    parsed = urlsplit(endpoint)
    if parsed.scheme != 'https' or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError('Expected a saved HTTPS endpoint without inline credentials')
    import httpx
    from openai import OpenAI
    from app.services.protocol_clients import ResponsesClient
    from app.services.ai_runtime import complete, visible_answer
    from app.utils.ai_errors import error_details
    logging.getLogger('httpx').setLevel(logging.CRITICAL)
    logging.getLogger('openai').setLevel(logging.CRITICAL)
    report = {'provider_id': args.provider_id, 'model': args.model, 'protocol': 'openai-responses',
              'max_calls': 2 if args.case == 'all' else 1, 'timeout_seconds': args.timeout, 'max_output_tokens': 2048, 'retries': 0, 'synthetic_library_only': True,
              'production_modified': False, 'requests': [], 'cases': []}
    current_case = ''
    def make_client(provider_id, model_name, protocol='openai-responses'):
        if provider_id != args.provider_id or model_name != args.model or protocol != 'openai-responses':
            raise ValueError('Unexpected model/provider/protocol')
        sdk = OpenAI(api_key=key, base_url=endpoint, max_retries=0, timeout=args.timeout,
                     http_client=httpx.Client(timeout=args.timeout, trust_env=False, follow_redirects=False))
        original = sdk.responses.create
        def bounded(**kwargs):
            if len(report['requests']) >= report['max_calls'] or any(r['case'] == current_case for r in report['requests']):
                raise ValueError('Live request budget reached; no retry made')
            kwargs['max_output_tokens'] = 2048
            entry = {'case': current_case, 'max_output_tokens': 2048}
            report['requests'].append(entry)
            response = original(**kwargs)
            entry['request_id'] = getattr(response, '_request_id', None)
            if response.usage:
                entry['usage'] = response.usage.model_dump(exclude_none=True)
            return response
        sdk.responses.create = bounded
        adapted = ResponsesClient(sdk)
        adapted.bilinote_provider_id = args.provider_id
        return types.SimpleNamespace(model=model_name, client=adapted)
    previous = Path.cwd()
    with tempfile.TemporaryDirectory(prefix='bilinote-live-feature-') as temporary:
        os.chdir(temporary)
        try:
            from app.services import organizer, model_capabilities, note_storage as notes
            notes.save_task({'id': 'probe-note', 'status': 'SUCCESS', 'audioMeta': {'title': '合成暗号（业务验收）', 'platform': 'local'},
                             'markdown': '# 合成暗号\n\n暗号是蓝色积木。这是隔离验收数据。', 'formData': {}})
            with patch.object(organizer, 'get_client', make_client), patch.object(model_capabilities, '_provider', return_value={'api_key': key, 'base_url': endpoint, 'enabled': True}):
                for name in (('library_answer', 'native_web_search') if args.case == 'all' else (args.case,)):
                    current_case = name
                    started = time.monotonic()
                    case = {'case': name}
                    client = None
                    try:
                        if name == 'library_answer':
                            sources = []
                            context = {}
                            answer = organizer.answer('合成暗号笔记中的暗号是什么？', args.provider_id, args.model, [], '只读回答', {},
                                                       reasoning_effort='low', protocol='openai-responses', sources_sink=sources, context_sink=context)
                            case.update(passed='蓝色积木' in answer and any(s.get('note_id') == 'probe-note' for s in sources),
                                        answer_contains_fixture_fact='蓝色积木' in answer, source_count=len(sources), context=context)
                        else:
                            client = make_client(args.provider_id, args.model).client
                            response, context = complete(client, args.model, [{'role': 'user', 'content': 'Use web search to find the official Python documentation site. Reply with its title and one citation.'}],
                                reasoning_effort='low', max_output_tokens=2048, web_search=True, require_web=True)
                            visible_answer(response)
                            case.update(passed=bool(response.web_search_used and response.web_sources),
                                        search_tool_completed=response.web_search_used,
                                        source_urls=[s['url'] for s in response.web_sources], context=context)
                    except Exception as exc:
                        case.update(passed=False, error_details=error_details(exc, 'openai-responses', key))
                    finally:
                        if client:
                            client.close()
                    case['elapsed_ms'] = round((time.monotonic()-started)*1000)
                    report['cases'].append(case)
                    output.parent.mkdir(parents=True, exist_ok=True)
                    output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
                    print(json.dumps(case, ensure_ascii=False), flush=True)
        finally:
            logging.shutdown()
            os.chdir(previous)


if __name__ == '__main__':
    main()
