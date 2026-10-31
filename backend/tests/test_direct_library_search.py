"""Direct search uses synthetic files only; no application bootstrap or model client."""
import hashlib
import inspect
import json
import os
import stat
import subprocess
import types
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.routers.library_search import router, search as search_route
from app.services import library_search as search, note_folders, note_storage


class DirectLibrarySearchTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='direct-search-')
        self.addCleanup(self.temp.cleanup)
        self.root = (Path(self.temp.name) / 'notes').resolve()
        self.root.mkdir()
        self.folder_path = Path(self.temp.name) / 'folders.json'
        self.folder_path.write_text(json.dumps({'schema_version': 1,
            'folders': [{'id': 'learn', 'name': '学习视频'}, {'id': 'other', 'name': '其他'}],
            'assignments': {}}), encoding='utf-8')
        for module, name, value in ((note_storage, 'ROOT', self.root),
                                    (note_folders, 'STATE_PATH', self.folder_path)):
            context = patch.object(module, name, value)
            context.start()
            self.addCleanup(context.stop)
        with search._LOCK:
            search._DIRECT_CACHE.clear()
            search._DIRECT_CACHE_BYTES = 0

    def note(self, note_id, body, title='教程', archived=False, previous=None, folder_id=None):
        folder = self.root / ('教程__' + note_id)
        (folder / '_meta').mkdir(parents=True)
        (folder / 'versions').mkdir()
        (folder / 'versions' / 'v1.md').write_text(body, encoding='utf-8')
        versions = [{'ver_id': 'v1'}]
        if previous is not None:
            (folder / 'versions' / 'v0.md').write_text(previous, encoding='utf-8')
            versions.append({'ver_id': 'v0'})
        task = {'id': note_id, 'status': 'SUCCESS', 'markdown': versions,
                'audioMeta': {'title': title, 'platform': 'bilibili', 'video_id': 'BV_SYNTHETIC'},
                'formData': {'video_url': 'https://www.bilibili.com/video/BV_SYNTHETIC',
                             'api_key': 'NEVER_RETURN', 'file_path': 'C:/NEVER_RETURN'},
                'archived_at': '2026-10-23' if archived else None}
        (folder / '_meta' / 'manifest.json').write_text(json.dumps({'task': task}), encoding='utf-8')
        if folder_id:
            state = json.loads(self.folder_path.read_text(encoding='utf-8'))
            state['assignments'][note_id] = folder_id
            self.folder_path.write_text(json.dumps(state), encoding='utf-8')
        return folder

    def snapshot(self):
        return {str(p): hashlib.sha256(p.read_bytes()).hexdigest()
                for p in Path(self.temp.name).rglob('*') if p.is_file()}

    def test_literal_chinese_terms_are_not_removed(self):
        self.note('actual', '如何查找关于搜索的相关内容')
        self.note('unrelated', '普通正文')
        for query in ('查找', '相关', '如何', '关于', '搜索', '相关内容'):
            with self.subTest(query=query):
                result = search.search_notes(query)
                self.assertEqual([r['note_id'] for r in result['results']], ['actual'])
                self.assertIn(query, result['results'][0]['excerpt'])
        self.assertEqual(search.search_notes('查找 不存在')['total'], 0)

    def test_english_unicode_and_utf16_offsets_are_original(self):
        body = '# Intro\n😀 Straße ＵＶ unwrap precision cafe\u0301'
        self.note('a', body)
        for query, actual in (('UV', 'ＵＶ'), ('STRASSE', 'Straße'), ('UNWRAP', 'unwrap'),
                              ('café', 'cafe\u0301')):
            with self.subTest(query=query):
                result = search.search_notes(query)['results'][0]
                self.assertEqual(result['match_text'], actual)
                self.assertEqual(body[result['match_start']:result['match_end']], actual)
                utf16 = body.encode('utf-16-le')
                self.assertEqual(utf16[result['match_start_utf16'] * 2:result['match_end_utf16'] * 2]
                                 .decode('utf-16-le'), actual)

    def test_full_tail_and_chunk_boundary_and_no_history_read(self):
        body = '# 教程\n' + '填' * (search.CHUNK_SIZE - 7) + '跨边界关键词' + '普通' * 30000 + '\n# 最后\n末尾独有'
        self.note('a', body, previous='仅历史版本关键词')
        original = Path.read_text
        def guarded(path, *args, **kwargs):
            if path.name == 'v0.md':
                raise AssertionError('Opened an old version')
            return original(path, *args, **kwargs)
        with patch.object(Path, 'read_text', guarded):
            for query in ('跨边界关键词', '末尾独有'):
                result = search.search_notes(query)['results'][0]
                self.assertEqual(body[result['match_start']:result['match_end']], query)
                self.assertIn(query, result['excerpt'])
            self.assertEqual(search.search_notes('仅历史版本关键词')['total'], 0)
        self.assertEqual(search.search_notes('末尾独有')['results'][0]['section_title'], '最后')

    def test_folder_filter_precedes_metadata_and_body_read(self):
        self.note('yes', '查找目标', folder_id='learn')
        excluded = self.note('no', '查找目标', folder_id='other')
        original = Path.read_text
        def guarded(path, *args, **kwargs):
            if excluded in path.parents:
                raise AssertionError('Opened excluded note')
            return original(path, *args, **kwargs)
        with patch.object(Path, 'read_text', guarded):
            result = search.search_notes('查找目标', scope='folder', folder_id='learn')
        self.assertEqual([r['note_id'] for r in result['results']], ['yes'])
        self.assertEqual(result['results'][0]['folder_name'], '学习视频')

    def test_archive_source_title_and_read_only(self):
        self.note('a', '# UV\n正文命中', archived=True, folder_id='learn')
        self.note('b', '正文没有此词', title='标题独有')
        before = self.snapshot()
        result = search.search_notes('正文命中')['results'][0]
        self.assertTrue(result['archived'])
        self.assertEqual(result['source']['video_id'], 'BV_SYNTHETIC')
        self.assertEqual(result['source']['platform'], 'bilibili')
        self.assertNotIn('NEVER_RETURN', json.dumps(result))
        title = search.search_notes('标题独有')['results'][0]
        self.assertEqual(title['match_kind'], 'title')
        self.assertEqual(title['match_text'], '标题独有')
        self.assertEqual(before, self.snapshot())

    def test_current_update_manual_change_and_delete_invalidate(self):
        folder = self.note('a', '旧内容')
        self.assertEqual(search.search_notes('旧内容')['total'], 1)
        (folder / 'versions' / 'v1.md').write_text('新正文内容', encoding='utf-8')
        self.assertEqual(search.search_notes('旧内容')['total'], 0)
        self.assertEqual(search.search_notes('新正文内容')['total'], 1)
        manifest = folder / '_meta' / 'manifest.json'
        value = json.loads(manifest.read_text(encoding='utf-8'))
        (folder / 'versions' / 'v2.md').write_text('当前版本', encoding='utf-8')
        value['task']['markdown'].insert(0, {'ver_id': 'v2'})
        manifest.write_text(json.dumps(value), encoding='utf-8')
        self.assertEqual(search.search_notes('新正文内容')['total'], 0)
        self.assertEqual(search.search_notes('当前版本')['results'][0]['version_id'], 'v2')
        (self.root / '_tombstones').mkdir()
        (self.root / '_tombstones' / 'a.json').write_text('{}', encoding='utf-8')
        self.assertEqual(search.search_notes('当前版本')['total'], 0)
        self.assertFalse(search._DIRECT_CACHE)

    def test_corrupt_pending_duplicate_and_missing_are_skipped(self):
        self.note('good', '命中')
        corrupt = self.note('bad', '命中')
        self.assertEqual(search.search_notes('命中')['total'], 2)
        (corrupt / '_meta' / 'manifest.json').write_text('{', encoding='utf-8')
        pending = self.note('pending', '命中') / '_meta' / 'manifest.json'
        value = json.loads(pending.read_text(encoding='utf-8'))
        value['deletion_pending'] = True
        pending.write_text(json.dumps(value), encoding='utf-8')
        self.note('dup', '命中')
        (self.root / '重复__dup').mkdir()
        self.note('missing', '命中').joinpath('versions/v1.md').unlink()
        result = search.search_notes('命中')
        self.assertEqual([r['note_id'] for r in result['results']], ['good'])
        self.assertEqual(result['warning_count'], 3)

    def test_paging_is_stable_bounded_and_one_result_per_note(self):
        for index in range(37):
            self.note(f'n{index:03}', '重复关键词 ' * 300)
        pages, offset = [], 0
        while True:
            page = search.search_notes('重复关键词', offset=offset, limit=11)
            pages.extend(page['results'])
            self.assertLessEqual(page['returned'], 11)
            self.assertEqual(page['total'], 37)
            self.assertTrue(all(len(r['excerpt']) <= search.EXCERPT_SIZE for r in page['results']))
            if not page['has_more']:
                break
            offset = page['next_offset']
        self.assertEqual([r['note_id'] for r in pages], [f'n{i:03}' for i in range(37)])
        self.assertEqual(search.search_notes('重复关键词', offset=999)['returned'], 0)

    def test_http_contract_validation_and_worker_route(self):
        self.note('a', '查找')
        app = FastAPI()
        app.include_router(router, prefix='/api')
        with TestClient(app) as http:
            response = http.get('/api/library/search', params={'query': '查找'}).json()
            self.assertEqual(response['code'], 0)
            self.assertEqual(response['data']['total'], 1)
            for params in ({'query': ''}, {'query': 'x', 'limit': 31},
                           {'query': 'x', 'offset': -1}, {'query': 'x', 'scope': 'selected'}):
                self.assertEqual(http.get('/api/library/search', params=params).status_code, 422)
            for params in ({'query': 'x', 'scope': 'folder'},
                           {'query': 'x', 'folder_id': 'learn'},
                           {'query': 'x', 'scope': 'folder', 'folder_id': '../escape'}):
                self.assertEqual(http.get('/api/library/search', params=params).json()['code'], 400)
            self.assertEqual(http.get('/api/library/search', params={
                'query': 'x', 'scope': 'folder', 'folder_id': 'missing'}).json()['code'], 404)
        self.assertFalse(inspect.iscoroutinefunction(search_route))

    def test_legacy_and_long_query_excerpt_preserves_whole_match(self):
        folder = self.note('legacy', 'ignored')
        path = folder / '_meta' / 'manifest.json'
        value = json.loads(path.read_text(encoding='utf-8'))
        keyword = '长' * 499
        value['task']['markdown'] = '前文' + keyword + '后文'
        path.write_text(json.dumps(value), encoding='utf-8')
        result = search.search_notes(keyword)['results'][0]
        self.assertEqual(result['version_id'], 'legacy')
        self.assertIn(keyword, result['excerpt'])

    def test_link_replacements_never_read_outside_even_after_cache_warm(self):
        outside = (Path(self.temp.name) / 'outside').resolve()
        outside.mkdir()
        (outside / 'manifest.json').write_text('{"task":{"id":"meta","markdown":"外部秘密"}}', encoding='utf-8')
        (outside / 'v1.md').write_text('外部秘密', encoding='utf-8')
        metadata = self.note('meta', '缓存预热')
        version = self.note('version', '缓存预热')
        file_note = self.note('file', '缓存预热')
        manifest_note = self.note('manifest', '缓存预热')
        self.assertEqual(search.search_notes('缓存预热')['total'], 4)
        links = []
        def link(path, target, directory=False, junction=False):
            if junction and os.name == 'nt':
                result = subprocess.run(['cmd', '/d', '/c', 'mklink', '/J', str(path), str(target)],
                                        capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
            else:
                os.symlink(target, path, target_is_directory=directory)
            links.append((path, directory))
        try:
            (metadata / '_meta').rename(metadata / '_meta_saved')
            link(metadata / '_meta', outside, directory=True, junction=True)
            (version / 'versions').rename(version / 'versions_saved')
            link(version / 'versions', outside, directory=True, junction=True)
            link(self.root / '替换__outside', outside, directory=True, junction=True)
            original, original_lstat = Path.read_text, Path.lstat
            symbolic_files = {file_note / 'versions' / 'v1.md', manifest_note / '_meta' / 'manifest.json'}
            def symbolic_stat(path, *args, **kwargs):
                if path in symbolic_files:
                    return types.SimpleNamespace(st_mode=stat.S_IFLNK, st_file_attributes=0)
                return original_lstat(path, *args, **kwargs)
            def guarded(path, *args, **kwargs):
                if path in symbolic_files or path.resolve().is_relative_to(outside):
                    raise AssertionError('Read through a link into outside data')
                return original(path, *args, **kwargs)
            with patch.object(Path, 'lstat', symbolic_stat), patch.object(Path, 'read_text', guarded):
                result = search.search_notes('外部秘密')
            self.assertEqual(result['total'], 0)
            self.assertGreaterEqual(result['warning_count'], 4)
        finally:
            for path, directory in reversed(links):
                if directory and os.name == 'nt':
                    os.rmdir(path)
                else:
                    path.unlink()


class DirectSearchBenchmark(DirectLibrarySearchTests):
    """Explicit opt-in benchmark; executed separately from the regression suite."""
    def benchmark(self):
        count, chars = 1200, 24000
        body = '# 合成教程\n' + '常规填充正文' * (chars // 6)
        for index in range(count):
            self.note(f'n{index:04}', body + ('\n# 最后\n大样本稀有末尾' if index == count - 1 else ''),
                      previous='历史版本不得读取' * 100)
        timings = []
        for label in ('cold_application_cache', 'repeat_1', 'repeat_2'):
            started = time.perf_counter()
            result = search.search_notes('大样本稀有末尾')
            timings.append({'run': label, 'elapsed_ms': round((time.perf_counter() - started) * 1000, 2)})
            self.assertEqual([r['note_id'] for r in result['results']], ['n1199'])
        return {'notes': count, 'current_body_chars_each': chars, 'historical_versions_each': 1,
                'cache_max_bytes': search.DIRECT_CACHE_MAX_BYTES, 'timings': timings,
                'model_calls': 0, 'network_calls': 0, 'filesystem_cache_flushed': False}


if __name__ == '__main__':
    unittest.main()
