"""Two opt-in, bounded protocol calls using one existing provider read-only.

No configuration changes, original notes, automatic retries or model substitution.
Only sanitized diagnostic metadata is persisted inside the development workspace.
"""
import argparse
import json
import logging
import sqlite3
import tempfile
import time
from pathlib import Path
from urllib.parse import urlsplit
from serve_organizer_fixture import bootstrap


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--database', required=True)
    parser.add_argument('--provider-id', required=True)
    parser.add_argument('--model', required=True)
    parser.add_argument('--report', required=True)
    args = parser.parse_args()
    workspace = Path(__file__).resolve().parents[2]
    report_path = Path(args.report).resolve()
    if not report_path.is_relative_to(workspace / '.BiliNote-dev') or report_path.exists():
        raise ValueError('Use a new report file inside .BiliNote-dev')
    bootstrap(workspace / '.BiliNote-dev' / 'agent-compatible-deps')
    with sqlite3.connect(Path(args.database).resolve().as_uri() + '?mode=ro', uri=True) as connection:
        connection.execute('PRAGMA query_only=ON')
        row = connection.execute('SELECT api_key, base_url, enabled FROM providers WHERE id=?', (args.provider_id,)).fetchone()
    if not row or not row[2] or not row[0]:
        raise ValueError('Selected provider is unavailable')
    key, endpoint = row[:2]
    parsed = urlsplit(endpoint)
    if parsed.scheme != 'https' or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError('Expected an existing HTTPS API endpoint without inline credentials')
    from openai import OpenAI
    import httpx
    from app.services.ai_runtime import complete, visible_answer
    from app.services.protocol_clients import ResponsesClient
    from app.utils.ai_errors import error_details
    logging.getLogger('httpx').setLevel(logging.CRITICAL)
    logging.getLogger('openai').setLevel(logging.CRITICAL)
    report = {'provider_id': args.provider_id, 'model': args.model, 'endpoint_host': parsed.hostname,
              'max_calls': 2, 'max_output_tokens_per_call': 1024, 'retries': 0,
              'synthetic_input_only': True, 'production_modified': False, 'network': 'direct, no environment proxy', 'cases': []}
    report_path.parent.mkdir(parents=True, exist_ok=True)
    for protocol in ('openai-chat', 'openai-responses'):
        sdk = OpenAI(api_key=key, base_url=endpoint, max_retries=0, timeout=45.0,
                     http_client=httpx.Client(timeout=45.0, trust_env=False, follow_redirects=False))
        client = ResponsesClient(sdk) if protocol == 'openai-responses' else sdk
        case = {'protocol': protocol, 'reasoning_effort': 'low'}
        started = time.monotonic()
        try:
            response, usage = complete(client, args.model, [{'role': 'user', 'content': 'Reply with the single word OK.'}],
                                       reasoning_effort='low', max_output_tokens=1024)
            text = visible_answer(response)
            case.update(passed=True, text_chars=len(text), expected_reply='OK' in text,
                        request_id=getattr(response, 'request_id', None) or getattr(response, '_request_id', None), context=usage)
        except Exception as exc:
            case.update(passed=False, error_details=error_details(exc, protocol, key))
        finally:
            client.close()
        case['elapsed_ms'] = round((time.monotonic() - started) * 1000)
        report['cases'].append(case)
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps(case, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
