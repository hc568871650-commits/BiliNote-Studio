"""Inspect native storage or roll back preview.32 without losing post-upgrade records."""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import time
import urllib.request

sys.path.insert(0, str(Path(__file__).resolve().parent))
import deploy_studio_frontend_only as deployment


def run(release, action):
    d = deployment.d
    d.ensure_stopped()
    release = d.validate_release(release)
    d.require((release / 'app.exe').is_file(), 'Release helper is missing')
    if action == 'rollback':
        _, manifest = deployment.load_backup(release)
        deployment.studio.verify_launchers(manifest)
        d.require(d.program_hashes(d.INSTALL) == deployment.expected_program(release, manifest), 'A newer program is installed; refusing rollback')
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    evidence = release / (action + '-' + stamp)
    evidence.mkdir()
    if action == 'inspect-copy':
        profile = evidence / 'WebView2'
        shutil.copytree(release / 'ui-storage/WebView2', profile)
    else:
        profile = d.INSTALL / 'WebView2'
        d.guard_path(profile)
        if action == 'rollback':
            paths = d.files(profile)
            before = d.hashes(paths, profile)
            shutil.copytree(profile, evidence / 'WebView2-backup')
            d.require(d.hashes(d.files(evidence / 'WebView2-backup'), evidence / 'WebView2-backup') == before, 'Current storage backup mismatch')
            d.save_json(evidence / 'storage-backup.json', {'files': before})
    with socket.socket() as reservation:
        reservation.bind(('127.0.0.1', 19532))
    env = dict(os.environ)
    for key, folder in [('APPDATA', 'AppData'), ('LOCALAPPDATA', 'LocalAppData'), ('TEMP', 'Temp'), ('TMP', 'Temp')]:
        directory = evidence / folder
        directory.mkdir(exist_ok=True)
        env[key] = str(directory)
    env.update(WEBVIEW2_USER_DATA_FOLDER=str(profile), BACKEND_PORT='19632',
               WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=19532 --remote-debugging-address=127.0.0.1')
    with (evidence / 'maintenance.log').open('wb') as log:
        process = subprocess.Popen([str(release / 'app.exe'), '--storage-maintenance'], cwd=release, env=env,
                                   stdout=log, stderr=subprocess.STDOUT)
        d.save_json(evidence / 'process.json', {'pid': process.pid, 'executable': str(release / 'app.exe'), 'profile': str(profile), 'backend_started': False})
        try:
            deadline = time.monotonic() + 25
            while True:
                d.require(process.poll() is None, 'Maintenance host exited before inspection')
                try:
                    with urllib.request.urlopen('http://127.0.0.1:19532/json/version', timeout=1) as response:
                        json.load(response)
                    break
                except (OSError, ValueError):
                    if time.monotonic() >= deadline: raise RuntimeError('Maintenance browser did not become ready')
                    time.sleep(.25)
            result = subprocess.run([shutil.which('node'), str(release / 'desktop_storage_compatibility_cli.mjs'),
                'downgrade' if action == 'rollback' else 'inspect', '19532', str(evidence / 'logical')],
                capture_output=True, text=True, encoding='utf-8', timeout=60)
            (evidence / 'compatibility.log').write_text(result.stdout + result.stderr, encoding='utf-8')
            d.require(result.returncode == 0, 'Storage verification failed; executable rollback was not attempted')
        finally:
            # Only this owned, backend-free maintenance host is ended after its transaction settles.
            if process.poll() is None:
                process.terminate()
            process.wait(timeout=10)
    if action == 'rollback':
        deployment.rollback_command(release)
    summary = json.loads((evidence / 'logical/verification.json').read_text(encoding='utf-8'))
    summary.update(evidence=str(evidence), executable_rollback=action == 'rollback')
    d.save_json(release / ('latest-' + action + '.json'), summary)
    print(json.dumps(summary, ensure_ascii=False))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--release', required=True)
    parser.add_argument('action', choices=['inspect-copy', 'inspect-installed', 'rollback'])
    args = parser.parse_args()
    run(args.release, args.action)
