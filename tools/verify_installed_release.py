"""Read-only post-start evidence: program hashes, protected data and local APIs."""
import argparse
from collections import Counter
from contextlib import closing
import re
import json
from pathlib import Path
import shutil
import sqlite3
import tempfile
import urllib.request

import deploy_local_release as deployment

LAUNCHER = Path('E:/AI-Tools/_Launchers/Start-BiliNote.cmd')


def _copy_sqlite_snapshot(source, destination):
    """Copy the main DB and WAL without opening or changing source sidecars."""
    source = Path(source)
    destination = Path(destination)
    wal = Path(str(source) + '-wal')
    for _ in range(3):
        paths = (source, wal)
        before = tuple((path.exists(), path.stat().st_size if path.exists() else None,
                        path.stat().st_mtime_ns if path.exists() else None) for path in paths)
        for path, target in zip(paths, (destination, Path(str(destination) + '-wal'))):
            if path.exists():
                shutil.copyfile(path, target)
            else:
                target.unlink(missing_ok=True)
        after = tuple((path.exists(), path.stat().st_size if path.exists() else None,
                       path.stat().st_mtime_ns if path.exists() else None) for path in paths)
        if before == after:
            return destination
    raise RuntimeError('SQLite changed while copying isolated verification snapshot')


def _readonly_connection(path):
    return sqlite3.connect(f'{Path(path).resolve().as_uri()}?mode=ro', uri=True)


def verify_model_display_name_migration(backup_db, current_db):
    """Allow only the specific nullable models.display_name schema migration."""
    report = {
        'checked': True,
        'table_sets_match': False,
        'old_columns_preserved': False,
        'model_table_definition_limited': False,
        'schema_objects_preserved': False,
        'old_rows_preserved': False,
        'added_column_is_nullable': False,
        'added_column_rows_null': False,
        'table_count': 0,
        'row_counts': {},
        'eligible': False,
    }
    with tempfile.TemporaryDirectory(prefix='bilinote-model-migration-check-') as temporary:
        root = Path(temporary)
        before_copy = _copy_sqlite_snapshot(backup_db, root / 'before.db')
        after_copy = _copy_sqlite_snapshot(current_db, root / 'after.db')
        with closing(_readonly_connection(before_copy)) as before, closing(_readonly_connection(after_copy)) as after:
            before.execute('BEGIN')
            after.execute('BEGIN')
            before_tables = dict(before.execute("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"))
            after_tables = dict(after.execute("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"))
            table_names = sorted(before_tables)
            report['table_count'] = len(table_names)
            report['table_sets_match'] = set(before_tables) == set(after_tables) and 'models' in before_tables

            def objects(connection):
                return dict(connection.execute("SELECT type || ':' || name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND type != 'table'"))

            before_objects, after_objects = objects(before), objects(after)
            report['schema_objects_preserved'] = before_objects == after_objects

            counts_before = {}
            counts_after = {}
            columns_ok = report['table_sets_match']
            model_sql_ok = report['table_sets_match']
            rows_ok = report['table_sets_match']
            for table in table_names:
                quoted = '"' + table.replace('"', '""') + '"'
                before_info = list(before.execute(f'PRAGMA table_info({quoted})'))
                after_info = list(after.execute(f'PRAGMA table_info({quoted})'))
                before_defs = [(r[0], r[1], r[2], r[3], r[4], r[5]) for r in before_info]
                after_defs = [(r[0], r[1], r[2], r[3], r[4], r[5]) for r in after_info]
                if table == 'models':
                    expected_new = (len(before_info), 'display_name', 'VARCHAR', 0, None, 0)
                    columns_ok = columns_ok and after_defs[:-1] == before_defs and after_defs[-1:] == [expected_new]
                    sql = after_tables.get(table) or ''
                    match = re.search(r',\s*display_name\s+VARCHAR(?=\s*,|\s*\))', sql, re.IGNORECASE)
                    if match:
                        before_sql = re.sub(r'\s+', ' ', before_tables[table]).strip()
                        after_without_new = re.sub(r'\s+', ' ', sql[:match.start()] + sql[match.end():]).strip()
                        model_sql_ok = model_sql_ok and after_without_new == before_sql
                    else:
                        model_sql_ok = False
                else:
                    columns_ok = columns_ok and after_defs == before_defs

                old_columns = [row[1] for row in before_info]
                select_before = ', '.join('"' + name.replace('"', '""') + '"' for name in old_columns)
                rows_before = Counter(tuple(row) for row in before.execute(f'SELECT {select_before} FROM {quoted}'))
                rows_after = Counter(tuple(row) for row in after.execute(f'SELECT {select_before} FROM {quoted}'))
                counts_before[table] = sum(rows_before.values())
                counts_after[table] = sum(rows_after.values())
                rows_ok = rows_ok and rows_before == rows_after

            report['old_columns_preserved'] = columns_ok
            report['model_table_definition_limited'] = model_sql_ok
            report['old_rows_preserved'] = rows_ok
            report['row_counts'] = {table: {'before': counts_before[table], 'after': counts_after[table]}
                                    for table in table_names}

            if report['table_sets_match']:
                models_info = list(after.execute('PRAGMA table_info("models")'))
                new_column = models_info[-1]
                report['added_column_is_nullable'] = new_column[1] == 'display_name' and new_column[2].upper() == 'VARCHAR' and new_column[3] == 0 and new_column[4] is None and new_column[5] == 0
                quoted = '"models"'
                report['added_column_rows_null'] = after.execute(
                    f'SELECT COUNT(*) FROM {quoted} WHERE "display_name" IS NOT NULL').fetchone()[0] == 0

    report['eligible'] = all(report[key] for key in (
        'table_sets_match', 'old_columns_preserved', 'model_table_definition_limited', 'schema_objects_preserved', 'old_rows_preserved',
        'added_column_is_nullable', 'added_column_rows_null'))
    return report


def protected_changes_ok(changed, allow_migration=False, migration_report=None):
    if not changed:
        return True
    return bool(allow_migration and changed == ['bili_note.db']
                and migration_report and migration_report.get('eligible'))


def verify_launcher_state(release):
    launcher_unchanged = deployment.digest(LAUNCHER) == deployment.digest(release / 'Start-BiliNote.before.cmd')
    if (release / 'studio-names/manifest.json').exists():
        import migrate_local_studio_names as studio
        try:
            result = studio.verify_local_studio_names(release)
            return {'launcher_unchanged': launcher_unchanged, 'launcher_verified': True, **result}
        except (RuntimeError, OSError, KeyError, ValueError):
            return {'launcher_unchanged': launcher_unchanged, 'launcher_verified': False, 'studio_names_verified': False}
    return {'launcher_unchanged': launcher_unchanged, 'launcher_verified': launcher_unchanged}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--release', required=True)
    parser.add_argument('--allow-model-display-name-migration', action='store_true')
    args = parser.parse_args()
    release = deployment.validate_release(args.release)
    manifest = json.loads((release / 'backup/manifest.json').read_text(encoding='utf-8'))
    expected = json.loads((release / 'install-verification.json').read_text(encoding='utf-8'))['program']
    program_ok = deployment.program_hashes(deployment.INSTALL) == expected
    actual = deployment.hashes(deployment.protected_files(), deployment.INSTALL)
    changed = [name for name in sorted(set(actual) | set(manifest['protected']))
               if actual.get(name) != manifest['protected'].get(name)]
    migration_report = None
    if args.allow_model_display_name_migration and changed == ['bili_note.db']:
        try:
            migration_report = verify_model_display_name_migration(
                release / 'backup/bili_note.db', deployment.INSTALL / 'bili_note.db')
        except Exception:
            migration_report = {
                'checked': True, 'table_sets_match': False, 'old_columns_preserved': False,
                'model_table_definition_limited': False,
                'schema_objects_preserved': False, 'old_rows_preserved': False,
                'added_column_is_nullable': False, 'added_column_rows_null': False,
                'table_count': 0, 'row_counts': {}, 'eligible': False,
            }
    def get(path):
        with urllib.request.urlopen('http://127.0.0.1:8483/api/' + path, timeout=10) as response:
            value = json.load(response)
        assert value['code'] == 0, path
        return value['data']
    health = get('sys_health')
    notes = get('notes')
    sessions = get('organizer/sessions')
    config = get('transcriber_config')
    before_states = Counter()
    before_ids = set()
    for path in (release / 'backup/note_results').glob('*/_meta/manifest.json'):
        task = json.loads(path.read_text(encoding='utf-8'))['task']
        before_ids.add(task['id'])
        before_states[task['status']] += 1
    report = {'program_hashes_match':program_ok, 'protected_files':len(actual),
              'changed_protected_files':changed, 'health':health,
              'notes_count':len(notes), 'note_states':dict(Counter(n['status'] for n in notes)),
              'note_ids_unchanged':before_ids == {n['id'] for n in notes},
              'note_states_unchanged':before_states == Counter(n['status'] for n in notes),
              'session_count':len(sessions['sessions']), 'runtime_id_present':bool(sessions.get('runtime_id')),
              'transcriber_type':config['transcriber_type'], 'groq_model_config_present':bool(config.get('groq_model')),
              **verify_launcher_state(release)}
    if args.allow_model_display_name_migration:
        report['model_display_name_migration'] = migration_report or {
            'checked': False, 'table_sets_match': False, 'old_columns_preserved': False,
            'model_table_definition_limited': False,
            'schema_objects_preserved': False, 'old_rows_preserved': False,
            'added_column_is_nullable': False, 'added_column_rows_null': False,
            'table_count': 0, 'row_counts': {}, 'eligible': False,
        }
    protected_ok = protected_changes_ok(changed, args.allow_model_display_name_migration, migration_report)
    report['success'] = all([program_ok, protected_ok, report['note_ids_unchanged'], report['note_states_unchanged'],
        report['runtime_id_present'], report['launcher_verified'], all(health[k] == 'ok' for k in ('backend','ffmpeg','db'))])
    deployment.save_json(release / 'post-start-verification.json', report)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report['success'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
