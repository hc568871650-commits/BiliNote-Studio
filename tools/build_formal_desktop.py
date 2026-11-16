"""Build the existing installed edition into a fresh release directory, not install it."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument('--release', required=True)
parser.add_argument('--version', required=True)
parser.add_argument('phase', choices=['frontend', 'desktop'])
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
frontend = root / 'BillNote_frontend'
release = Path(args.release).resolve()
if release.parent != Path('E:/AI-Tools/BiliNote-build').resolve() or not release.is_dir():
    raise ValueError('Expected an existing direct-child release directory')
toolchains = Path('E:/AI-Tools/BiliNote-build/toolchains')
target = Path('E:/AI-Tools/BiliNote-build/ui-workspace-20261001/cargo-target')
env = dict(os.environ)
env.update(VITE_APP_VERSION=args.version, VITE_BILINOTE_EDITION='full', VITE_API_BASE_URL='http://127.0.0.1:8483/api',
           CARGO_HOME=str(toolchains / 'cargo'), RUSTUP_HOME=str(toolchains / 'rustup'), CARGO_TARGET_DIR=str(target))
env['PATH'] = str(toolchains / 'cargo/bin') + os.pathsep + env.get('PATH', '')
node = shutil.which('node')
if not node:
    raise RuntimeError('Node is required')
if args.phase == 'frontend':
    with (release / 'frontend-build.log').open('wb') as log:
        subprocess.run([node, 'node_modules/vite/bin/vite.js', 'build', '--mode', 'tauri', '--outDir', str(release / 'frontend')],
                       cwd=frontend, env=env, stdout=log, stderr=subprocess.STDOUT, check=True)
    bundles = '\n'.join(p.read_text(encoding='utf-8') for p in (release / 'frontend/assets').glob('*.js'))
    assert 'http://127.0.0.1:8483/api' in bundles and args.version in bundles
    assert '/__ui_preview_api' not in bundles and 'preview-request-502' not in bundles
    assert 'Anthropic' in bundles and 'groq-transcription-key' in bundles
    print('Formal frontend identity and preview-exclusion checks passed')
else:
    sidecar = release / 'sidecar'
    sidecar.mkdir(exist_ok=True)
    shutil.copy2(release / 'backend-dist/BiliNoteBackend/BiliNoteBackend.exe', sidecar / 'BiliNoteBackend-x86_64-pc-windows-msvc.exe')
    relative = lambda path: os.path.relpath(path, frontend / 'src-tauri').replace('\\', '/')
    config = {'mainBinaryName': 'app', 'version': args.version, 'identifier': 'com.jefferyhuang.bilinote',
              'build': {'beforeBuildCommand': '', 'frontendDist': relative(release / 'frontend')},
              'bundle': {'active': False, 'externalBin': [relative(sidecar / 'BiliNoteBackend')], 'resources': []}}
    config_path = release / 'tauri-formal.json'
    config_path.write_text(json.dumps(config, indent=2), encoding='utf-8')
    command = release / 'build-desktop.cmd'
    command.write_text('@echo off\ncall "' + str(toolchains / 'VS2022/VC/Auxiliary/Build/vcvars64.bat') + '"\n'
                       'if errorlevel 1 exit /b %errorlevel%\n"' + node + '" "node_modules\\@tauri-apps\\cli\\tauri.js" build --no-bundle --config "'
                       + str(config_path) + '"\nexit /b %errorlevel%\n', encoding='utf-8')
    with (release / 'desktop-build.log').open('wb') as log:
        subprocess.run(['cmd.exe', '/d', '/c', str(command)], cwd=frontend, env=env, stdout=log, stderr=subprocess.STDOUT, check=True)
    shutil.copy2(target / 'release/app.exe', release / 'app.exe')
    # Legacy deployment and launchers still consume app.exe; expose the Studio
    # filename for delivery without silently migrating an existing installation.
    shutil.copy2(release / 'app.exe', release / 'BiliNoteStudio.exe')
    print('Formal desktop built; no installation changes made')
