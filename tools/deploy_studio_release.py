"""Deploy an existing Studio installation, keeping both executable aliases in sync."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sys
import uuid

# A private helper module keeps the legacy CLI's two-file contract unchanged.
_spec = importlib.util.spec_from_file_location('studio_deployment_helpers', Path(__file__).with_name('deploy_local_release.py'))
d = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(d)
d.EXECUTABLES = ('app.exe', 'BiliNoteBackend.exe', 'BiliNoteStudio.exe', 'BiliNoteStudioBackend.exe')
LAUNCHERS = {'legacy': Path('E:/AI-Tools/_Launchers/Start-BiliNote.cmd'),
             'studio': Path('E:/AI-Tools/_Launchers/Start-BiliNote-Studio.cmd')}


def launcher_hashes():
    return {name: d.digest(path) for name, path in LAUNCHERS.items()}


def require_aliases(program):
    d.require(program['app.exe'] == program['BiliNoteStudio.exe'], 'Desktop aliases differ')
    d.require(program['BiliNoteBackend.exe'] == program['BiliNoteStudioBackend.exe'], 'Backend aliases differ')


def same_volume(first, second):
    d.guard_path(first)
    d.guard_path(second)
    d.require(first.resolve().drive.lower() == second.resolve().drive.lower(), 'Runtime moves require the same volume')


def load_backup(release):
    backup, manifest = d.load_backup(release)
    d.require(manifest.get('studio_release') is True, 'Not a Studio-aware release backup')
    d.require(manifest.get('launchers') == {name: str(path) for name, path in LAUNCHERS.items()}, 'Launcher target mismatch')
    d.require(set(manifest['launcher_hashes']) == set(LAUNCHERS), 'Unexpected launcher manifest fields')
    for name, expected in manifest['launcher_hashes'].items():
        d.require(d.digest(backup / 'launchers' / (name + '.cmd')) == expected, 'Launcher backup hash mismatch')
    require_aliases(manifest['program'])
    return backup, manifest


def verify_launchers(manifest):
    d.require(launcher_hashes() == manifest['launcher_hashes'], 'Launchers changed; refuse this operation')


def backup_command(release):
    d.ensure_stopped()
    same_volume(d.INSTALL, release)
    require_aliases(d.program_hashes(d.INSTALL))
    before_launchers = launcher_hashes()
    d.backup_command(release)
    backup = release / 'backup'
    manifest = json.loads((backup / 'manifest.json').read_text(encoding='utf-8'))
    manifest.update(studio_release=True, launchers={name: str(path) for name, path in LAUNCHERS.items()}, launcher_hashes=before_launchers)
    (backup / 'launchers').mkdir()
    for name, path in LAUNCHERS.items():
        shutil.copy2(path, backup / 'launchers' / (name + '.cmd'))
        d.require(d.digest(backup / 'launchers' / (name + '.cmd')) == before_launchers[name], 'Launcher backup mismatch')
    verify_launchers(manifest)
    d.save_json(backup / 'manifest.json', manifest)
    # Compatibility evidence for the shared post-start verification routine.
    shutil.copy2(LAUNCHERS['legacy'], release / 'Start-BiliNote.before.cmd')
    for name in ('deploy_studio_release.py', 'verify_installed_release.py'):
        source = Path(__file__).parent / name
        destination = release / name
        if source.resolve() != destination.resolve():
            shutil.copy2(source, destination)
        d.require(d.digest(source) == d.digest(destination), 'Release-local helper mismatch')
    quote = lambda value: "'" + str(value).replace("'", "''") + "'"
    command = '& ' + quote(sys.executable) + ' ' + quote(release / 'deploy_studio_release.py') + ' --release ' + quote(release) + ' rollback'
    (release / 'Rollback.ps1').write_text("$ErrorActionPreference = 'Stop'\n" + command + '\nif ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }\n', encoding='utf-8-sig')
    (release / 'ROLLBACK.txt').write_text('Exit BiliNote Studio before running:\n' + command + '\n', encoding='utf-8')
    return {'ok': True, 'studio_release': True, 'program_files': len(manifest['program']), 'protected_files': len(manifest['protected'])}


def stage_program(release):
    backend, expected = d.stage_program(release)
    expected['BiliNoteStudio.exe'] = expected['app.exe']
    expected['BiliNoteStudioBackend.exe'] = expected['BiliNoteBackend.exe']
    sources = {'app.exe': release / 'app.exe', 'BiliNoteStudio.exe': release / 'app.exe',
               'BiliNoteBackend.exe': backend / 'BiliNoteBackend.exe',
               'BiliNoteStudioBackend.exe': backend / 'BiliNoteBackend.exe'}
    require_aliases(expected)
    return backend, sources, expected


def prepare_install_stage(release, backup, manifest):
    backend, sources, expected = stage_program(release)
    stage = release / 'studio-install-stage'
    d.guard_path(stage)
    d.require(not stage.exists(), 'Studio install stage exists; inspect before another attempt')
    stage.mkdir()
    shutil.copytree(backend / '_internal', stage / '_internal')
    if '_internal/.env' in manifest['protected']:
        shutil.copy2(backup / 'backend-runtime.env', stage / '_internal/.env')
    elif (stage / '_internal/.env').exists():
        (stage / '_internal/.env').rename(stage / 'unused-release-env')
    for name, source in sources.items():
        shutil.copy2(source, stage / name)
    d.require(d.program_hashes(stage) == expected, 'Prepared Studio stage hash mismatch')
    if '_internal/.env' in manifest['protected']:
        d.require(d.digest(stage / '_internal/.env') == manifest['protected']['_internal/.env'], 'Runtime configuration stage mismatch')
    return stage, expected


def restore_program(release, backup, manifest, automatic=False):
    d.ensure_stopped()
    same_volume(d.INSTALL, backup)
    same_volume(d.INSTALL, release)
    if not automatic:
        verify_launchers(manifest)
    d.require((backup / '_internal').is_dir(), 'Old runtime backup is missing')
    d.require(d.program_hashes(backup) == manifest['program'], 'Old program backup hash mismatch')
    if not automatic:
        installed = json.loads((release / 'install-verification.json').read_text(encoding='utf-8'))
        d.require(installed.get('ok') is True and installed.get('studio_release') is True, 'This release was not installed successfully')
        _, _, expected = stage_program(release)
        d.require(installed['program'] == expected, 'Install receipt differs from the release program')
        d.require(d.program_hashes(d.INSTALL) == installed['program'], 'Program changed after release; refuse to overwrite a newer installation')
    protected_before = manifest['protected'] if automatic else d.hashes(d.protected_files(), d.INSTALL)
    retained = release / ('failed-program' if automatic else 'replaced-program') / uuid.uuid4().hex
    retained.mkdir(parents=True)
    # Keep the backup intact; fully prepare restoration before touching current files.
    stage = retained / 'restore-stage'
    stage.mkdir()
    shutil.copytree(backup / '_internal', stage / '_internal')
    env_target = stage / '_internal/.env'
    if '_internal/.env' in protected_before:
        env_source = backup / 'backend-runtime.env' if automatic else d.INSTALL / '_internal/.env'
        d.require(env_source.is_file(), 'Preserved current runtime configuration is missing')
        shutil.copy2(env_source, env_target)
    elif env_target.exists():
        env_target.rename(retained / 'unused-backup-env')
    for name in d.EXECUTABLES:
        shutil.copy2(backup / name, stage / name)
    d.require(d.program_hashes(stage) == manifest['program'], 'Restoration stage hash mismatch')
    if (d.INSTALL / '_internal').exists():
        (d.INSTALL / '_internal').rename(retained / '_internal')
    (stage / '_internal').rename(d.INSTALL / '_internal')
    for name in d.EXECUTABLES:
        if (d.INSTALL / name).exists():
            (d.INSTALL / name).rename(retained / name)
        (stage / name).rename(d.INSTALL / name)
    d.require(d.program_hashes(d.INSTALL) == manifest['program'], 'Restored Studio program hash mismatch')
    d.require(d.hashes(d.protected_files(), d.INSTALL) == protected_before, 'Data changed during Studio rollback')
    if not automatic:
        verify_launchers(manifest)
    result = {'ok': True, 'studio_release': True, 'automatic': automatic, 'retained_program': str(retained), 'protected_files_unchanged': True}
    d.save_json(release / 'rollback-verification.json', result)
    return result


def install_command(release):
    d.ensure_stopped()
    same_volume(d.INSTALL, release)
    backup, manifest = load_backup(release)
    d.require(not (backup / '_internal').exists(), 'Old runtime backup exists; refuse a repeated install')
    d.require(d.program_hashes(d.INSTALL) == manifest['program'], 'Installed program differs from backup baseline')
    d.verify_protected(manifest)
    verify_launchers(manifest)
    stage, expected = prepare_install_stage(release, backup, manifest)
    # Nothing installed has changed yet; recheck the baseline after the long copy.
    d.require(d.program_hashes(d.INSTALL) == manifest['program'], 'Program changed while staging')
    d.verify_protected(manifest)
    verify_launchers(manifest)
    d.ensure_stopped()
    (d.INSTALL / '_internal').rename(backup / '_internal')
    try:
        (stage / '_internal').rename(d.INSTALL / '_internal')
        for name in d.EXECUTABLES:
            os.replace(stage / name, d.INSTALL / name)
        d.require(d.program_hashes(d.INSTALL) == expected, 'Installed Studio program hash mismatch')
        d.verify_protected(manifest)
        verify_launchers(manifest)
        result = {'ok': True, 'studio_release': True, 'program': expected, 'protected_files_verified': len(manifest['protected']),
                  'sqlite_integrity': d.integrity(d.protected_files()), 'backup': str(backup)}
        d.save_json(release / 'install-verification.json', result)
        return result
    except Exception:
        d.save_json(release / 'install-verification.json', {'ok': False, 'studio_release': True, 'automatic_restore_attempted': True})
        restore_program(release, backup, manifest, automatic=True)
        raise


def verify_command(release, running=False):
    if not running:
        d.ensure_stopped()
    _, manifest = load_backup(release)
    _, _, expected = stage_program(release)
    d.require(d.program_hashes(d.INSTALL) == expected, 'Installed Studio program hash mismatch')
    require_aliases(expected)
    d.verify_protected(manifest)
    verify_launchers(manifest)
    result = {'ok': True, 'studio_release': True, 'program': expected, 'protected_files_verified': len(manifest['protected']),
              'sqlite_integrity': d.integrity(d.protected_files()), 'launchers_unchanged': True}
    d.save_json(release / 'verify-verification.json', result)
    return result


def verify_running_command(release):
    # In-process reuse retains four-file hashing and does not bypass a deployment CLI guard.
    import verify_installed_release as running_verifier
    verify_command(release, running=True)
    _, manifest = load_backup(release)
    def strict_launcher_state(_release):
        try:
            verify_launchers(manifest)
            return {'launcher_unchanged': True, 'launcher_verified': True, 'studio_launchers_verified': True}
        except RuntimeError:
            return {'launcher_unchanged': False, 'launcher_verified': False, 'studio_launchers_verified': False}
    previous = (running_verifier.deployment, running_verifier.verify_launcher_state, sys.argv)
    try:
        running_verifier.deployment = d
        running_verifier.verify_launcher_state = strict_launcher_state
        sys.argv = ['verify_installed_release', '--release', str(release)]
        code = running_verifier.main()
        d.require(code == 0, 'Studio startup verification failed')
        return {'ok': True, 'studio_release': True, 'post_start_verified': True}
    finally:
        running_verifier.deployment, running_verifier.verify_launcher_state, sys.argv = previous


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--release', required=True)
    parser.add_argument('action', choices=('backup', 'install', 'verify', 'verify-running', 'rollback'))
    args = parser.parse_args()
    try:
        release = d.validate_release(args.release)
        actions = {'backup': backup_command, 'install': install_command, 'verify': verify_command,
                   'verify-running': verify_running_command,
                   'rollback': lambda value: restore_program(value, *load_backup(value))}
        result = actions[args.action](release)
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except Exception as error:
        print(json.dumps({'ok': False, 'action': args.action, 'error_type': type(error).__name__,
                          'reason': str(error) if type(error) is RuntimeError else 'Operation failed; inspect local paths/permissions.'}))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
