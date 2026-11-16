"""Stage the verified preview.31 source plus this chat's reader/chat changes."""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]
PRIOR = Path('E:/cc work/BiliNote-Studio-最新项目-20261030')
OLD_RELEASE = Path('E:/AI-Tools/BiliNote-build/backend-ui-20261031-preview31')
RELEASE = Path('E:/AI-Tools/BiliNote-build/reader-chat-performance-20261102-preview32')
SOURCE = RELEASE / 'source-v2'
digest = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
manifest = json.loads((OLD_RELEASE / 'source-hashes.json').read_text(encoding='utf-8'))
frontend_files = {name: value for name, value in manifest.items() if name.startswith('BillNote_frontend/')}
assert all((PRIOR / name).is_file() and digest(PRIOR / name) == value for name, value in frontend_files.items()), 'Installed baseline source drifted'
if SOURCE.exists():
    assert all((SOURCE / name).is_file() and digest(SOURCE / name) == value for name, value in frontend_files.items()), 'Refuse to overwrite an edited staged source'
RELEASE.mkdir(exist_ok=True)
for name in frontend_files:
    target = SOURCE / name
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(PRIOR / name, target)

changes = {
    'src/pages/HomePage/components/ReaderPane.tsx': 'reader-performance',
    'src/pages/HomePage/components/MarkdownViewer.tsx': 'reader-performance',
    'src/utils/readingPosition.ts': 'reader-performance',
    'src/pages/HomePage/components/ChatPanel.tsx': 'interaction-performance',
    'src/store/readingAssistantStore.ts': 'interaction-performance',
    'src/utils/taskStorage.ts': 'interaction-performance',
}
report = {'base_release': '0.1.0-preview.31', 'target_release': '0.1.0-preview.32', 'base_files_verified': len(frontend_files), 'merges': {}, 'added': []}
for relative, snapshot in changes.items():
    target = SOURCE / 'BillNote_frontend' / relative
    base = ROOT / 'BillNote_frontend/.cache' / snapshot / 'baseline-source' / target.name
    current = ROOT / 'BillNote_frontend' / relative
    merged = subprocess.run(['git', 'merge-file', '-p', str(target), str(base), str(current)], capture_output=True)
    assert 0 <= merged.returncode < 128, merged.stderr.decode(errors='replace')
    target.write_bytes(merged.stdout)
    report['merges'][relative] = {'conflicts': merged.returncode, 'sha256': digest(target)}
for relative in ('src/utils/recordStorage.ts', 'src/utils/recordStorageDriver.ts', 'src/utils/readingSessionStorage.ts', 'src/pages/HomePage/components/ReadingMessageItem.tsx'):
    target = SOURCE / 'BillNote_frontend' / relative
    assert not target.exists(), 'Unexpected existing new file'
    shutil.copy2(ROOT / 'BillNote_frontend' / relative, target)
    report['added'].append(relative)
for directory in ('tests', 'scripts'):
    shutil.copytree(ROOT / 'BillNote_frontend' / directory, SOURCE / 'BillNote_frontend' / directory)
for filename in ('eslint.config.js', 'tsconfig.json', 'tsconfig.app.json', 'tsconfig.node.json', '.env.tauri'):
    target = SOURCE / 'BillNote_frontend' / filename
    if not target.exists(): shutil.copy2(PRIOR / 'BillNote_frontend' / filename, target)
(SOURCE / 'tools').mkdir()
shutil.copy2(ROOT / 'tools/build_formal_desktop.py', SOURCE / 'tools/build_formal_desktop.py')
backend = RELEASE / 'backend-dist/BiliNoteBackend'
backend.mkdir(parents=True)
shutil.copy2(Path('E:/AI-Tools/BiliNote/BiliNoteBackend.exe'), backend / 'BiliNoteBackend.exe')
(RELEASE / 'source-merge.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(report, ensure_ascii=False, indent=2))
