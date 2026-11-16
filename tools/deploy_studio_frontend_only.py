"""Replace both Studio desktop aliases while retaining the frozen backend/runtime."""
import argparse
import json
import os
from pathlib import Path
import shutil
import sys
import uuid

import deploy_studio_release as studio

d = studio.d
DESKTOP = ('app.exe', 'BiliNoteStudio.exe')


def replace_verified(source, destination):
    temporary = destination.with_name(destination.name + '.' + uuid.uuid4().hex + '.frontend-staged')
    d.guard_path(temporary)
    d.require(not temporary.exists(), 'Staging file exists; inspect before retrying')
    try:
        shutil.copy2(source, temporary)
        d.require(d.digest(temporary) == d.digest(source), 'Staging hash mismatch')
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)


def load_backup(release):
    backup, manifest = studio.load_backup(release)
    d.require(manifest.get('frontend_only') is True, 'Not a frontend-only Studio backup')
    return backup, manifest


def expected_program(release, manifest):
    return {**manifest['program'], **{name: d.digest(release / 'app.exe') for name in DESKTOP}}


def backup_command(release):
    result = studio.backup_command(release)
    manifest_path = release / 'backup/manifest.json'
    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    manifest.update(frontend_only=True, internal_backup='Not replaced; backend and runtime hash manifest retained')
    d.save_json(manifest_path, manifest)
    shutil.copy2(Path(__file__), release / Path(__file__).name)
    quote = lambda value: "'" + str(value).replace("'", "''") + "'"
    command = '& ' + quote(sys.executable) + ' ' + quote(release / Path(__file__).name) + ' --release ' + quote(release) + ' rollback'
    (release / 'Rollback.ps1').write_text("$ErrorActionPreference = 'Stop'\n" + command + '\nif ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }\n', encoding='utf-8-sig')
    (release / 'ROLLBACK.txt').write_text('Exit BiliNote Studio, then run:\n' + command + '\n', encoding='utf-8')
    return {**result, 'frontend_only': True}


def install_command(release):
    d.ensure_stopped()
    backup, manifest = load_backup(release)
    studio.verify_launchers(manifest)
    d.verify_protected(manifest)
    d.require(d.program_hashes(d.INSTALL) == manifest['program'], 'Program changed since backup')
    expected = expected_program(release, manifest)
    try:
        for name in DESKTOP:
            replace_verified(release / 'app.exe', d.INSTALL / name)
        d.require(d.program_hashes(d.INSTALL) == expected, 'Installed program hash mismatch')
        d.verify_protected(manifest)
        studio.verify_launchers(manifest)
    except Exception:
        for name in DESKTOP:
            if d.digest(d.INSTALL / name) != manifest['program'][name]:
                replace_verified(backup / name, d.INSTALL / name)
        d.require(d.program_hashes(d.INSTALL) == manifest['program'], 'Automatic desktop restore failed')
        raise
    report = {'ok': True, 'studio_release': True, 'frontend_only': True,
              'program': expected, 'protected_files': len(manifest['protected'])}
    d.save_json(release / 'install-verification.json', report)
    return {key: value for key, value in report.items() if key != 'program'}


def rollback_command(release):
    d.ensure_stopped()
    backup, manifest = load_backup(release)
    studio.verify_launchers(manifest)
    receipt = json.loads((release / 'install-verification.json').read_text(encoding='utf-8'))
    expected = expected_program(release, manifest)
    d.require(receipt.get('ok') and receipt.get('frontend_only') and receipt['program'] == expected, 'Invalid install receipt')
    d.require(d.program_hashes(d.INSTALL) == expected, 'Program changed after release; refuse to overwrite a newer installation')
    protected = d.hashes(d.protected_files(), d.INSTALL)
    try:
        for name in DESKTOP:
            replace_verified(backup / name, d.INSTALL / name)
        d.require(d.program_hashes(d.INSTALL) == manifest['program'], 'Restored program mismatch')
    except Exception:
        for name in DESKTOP:
            replace_verified(release / 'app.exe', d.INSTALL / name)
        raise
    d.require(d.hashes(d.protected_files(), d.INSTALL) == protected, 'Data changed during rollback')
    studio.verify_launchers(manifest)
    report = {'ok': True, 'frontend_only': True, 'protected_files_unchanged': True}
    d.save_json(release / 'rollback-verification.json', report)
    return report


def verify_command(release):
    _, manifest = load_backup(release)
    d.require(d.program_hashes(d.INSTALL) == expected_program(release, manifest), 'Program hash mismatch')
    d.verify_protected(manifest)
    studio.verify_launchers(manifest)
    return {'ok': True, 'frontend_only': True, 'protected_files': len(manifest['protected'])}


def verify_running_command(release):
    # Reuse the read-only API checks with this frontend-only expected-program map.
    previous = studio.verify_command
    try:
        studio.verify_command = lambda value, running=False: verify_command(value)
        return studio.verify_running_command(release)
    finally:
        studio.verify_command = previous


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--release', required=True)
    parser.add_argument('action', choices=['backup', 'install', 'verify', 'verify-running', 'rollback'])
    args = parser.parse_args()
    release = d.validate_release(args.release)
    actions = {'backup': backup_command, 'install': install_command, 'verify': verify_command,
               'verify-running': verify_running_command, 'rollback': rollback_command}
    print(json.dumps(actions[args.action](release), ensure_ascii=False))


if __name__ == '__main__':
    main()
