"""Opt-in paid smoke test; synthetic prompts, temporary data, credentials from env only."""
import json
import logging
import os
import sys
import tempfile
import types
from pathlib import Path
from unittest.mock import patch

from serve_organizer_fixture import bootstrap


def main():
    workspace = Path(__file__).resolve().parents[2]
    bootstrap(str(workspace / '.BiliNote-dev' / 'agent-compatible-deps'))
    key = os.environ['BILINOTE_TEST_API_KEY']
    url = os.environ['BILINOTE_TEST_API_URL']
    model = os.environ['BILINOTE_TEST_MODEL']
    provider_module = types.ModuleType('app.services.provider')
    provider = dict(api_key=key, base_url=url, type='custom', name='Isolated smoke provider', enabled=True)
    provider_module.ProviderService = types.SimpleNamespace(get_provider_by_id=lambda _: provider)
    sys.modules[provider_module.__name__] = provider_module
    original = Path.cwd()
    with tempfile.TemporaryDirectory(prefix='bilinote-model-smoke-') as root:
        os.chdir(root)
        try:
            from app.gpt.provider.OpenAI_compatible_provider import OpenAICompatibleProvider
            from app.services import organizer_sessions as sessions
            from app.services.proxy_config_manager import ProxyConfigManager
            # No user config, databases, logs, notes, proxy credentials or .env imported.
            with patch.object(ProxyConfigManager, 'get_proxy_url', return_value=None):
                if '--extended' in sys.argv:
                    from app.services import note_storage as notes, organizer
                    from app.services.ai_client import get_client
                    from app.models.gpt_model import GPTSource
                    from app.models.transcriber_model import TranscriptSegment
                    vector = types.ModuleType('app.services.vector_store')
                    vector.VectorStoreManager = type('SyntheticVector', (), {'query': lambda *a, **k: []})
                    sys.modules[vector.__name__] = vector
                    from app.services.chat_service import chat
                    notes.save_task({'id': 'smoke-note', 'status': 'SUCCESS', 'audioMeta': {'title': '合成测试：蓝色积木'},
                        'markdown': '# 合成测试\n暗号是蓝色积木。', 'transcript': {'full_text': '暗号是蓝色积木。',
                        'segments': [{'start': 0, 'end': 2, 'text': '暗号是蓝色积木。'}]}, 'formData': {}})
                    answer = chat('smoke-note', '请调用get_note_content查询当前笔记，告诉我暗号是什么。', [], 'smoke', model, context_mode='selection')
                    plan = organizer.plan('归档这篇笔记', {'kind': 'selected', 'task_ids': ['smoke-note']}, 'smoke', model)
                    gpt = get_client('smoke', model)
                    gpt._max_retry_attempts = 1
                    summary = gpt.summarize(GPTSource(segment=[TranscriptSegment(start=0, end=2, text='暗号是蓝色积木。')],
                        title='合成测试', tags='', extras='用一句话总结即可。'))
                    print(json.dumps({'model': model, 'reading': answer, 'plan_status': plan['status'],
                        'operations': plan['operations'], 'summary': summary, 'executed': False}, ensure_ascii=False))
                    return 0 if '蓝色积木' in answer['answer'] and plan['operations'] and summary else 1
                connected = OpenAICompatibleProvider.test_connection(key, url, model)
                session = sessions.create({'kind': 'all'})
                result = sessions.message(session['session_id'], dict(instruction='BiliNote模型连接出现401错误时应该如何排查？请用两句话回答。',
                    provider_id='smoke', model_name=model, scope={'kind': 'all'}, expected_revision=0, request_id='smoke'))
                print(json.dumps({'connection': connected, 'model': model, 'status': result['status'],
                                  'has_plan': bool(result['plan']), 'answer': result['history'][-1]['content']}, ensure_ascii=False))
                return 0 if connected and result['status'] == 'completed' and not result['plan'] else 1
        finally:
            logging.shutdown()
            os.chdir(original)


if __name__ == '__main__':
    raise SystemExit(main())
