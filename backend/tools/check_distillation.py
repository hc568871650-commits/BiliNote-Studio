"""Offline regression groups run in separate processes to isolate legacy import stubs."""
import os
from pathlib import Path
import subprocess
import sys

workspace = Path(__file__).resolve().parents[2]
env = dict(os.environ)
public_video = workspace / '.BiliNote-dev/distillation-public-sample/arraydemo.mp4'
if public_video.is_file():
    env['BILINOTE_PUBLIC_TEST_VIDEO'] = str(public_video)
    env['BILINOTE_PUBLIC_TEST_ANALYSIS'] = str(public_video.parent / 'analysis')
groups = [
    ['backend.tests.test_note_refinement', 'backend.tests.test_distillation_contract',
     'backend.tests.test_note_pipeline_isolated', 'backend.tests.test_dynamic_frames_isolated',
     'backend.tests.test_request_chunker'],
    ['backend.tests.test_universal_gpt_content_format', 'backend.tests.test_universal_gpt_checkpoint',
     'backend.tests.test_universal_gpt_incomplete'],
]
for group in groups:
    result = subprocess.run([sys.executable, '-m', 'unittest', *group], cwd=workspace, env=env)
    if result.returncode:
        raise SystemExit(result.returncode)
print('Distillation regression groups passed; no model/network calls.')
