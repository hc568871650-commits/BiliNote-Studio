"""Local media isolation checks: no application startup, network or real media."""

from dataclasses import dataclass
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch


def load_downloader():
    modules = {name: types.ModuleType(name) for name in (
        'app', 'app.downloaders', 'app.downloaders.base', 'app.enmus',
        'app.enmus.note_enums', 'app.models', 'app.models.audio_model',
        'app.utils', 'app.utils.video_helper', 'ffmpeg_helper',
    )}

    @dataclass
    class Result:
        file_path: str
        title: str
        duration: float
        cover_url: str
        platform: str
        video_id: str
        raw_info: dict
        video_path: str

    modules['app.downloaders.base'].Downloader = object
    modules['app.enmus.note_enums'].DownloadQuality = str
    modules['app.models.audio_model'].AudioDownloadResult = Result
    modules['app.utils.video_helper'].save_cover_to_static = lambda path: '/static/cover/' + Path(path).name
    modules['ffmpeg_helper'].find_ffmpeg_binary = lambda name: name
    source = Path(__file__).resolve().parents[1] / 'app/downloaders/local_downloader.py'
    spec = importlib.util.spec_from_file_location('isolated_local_downloader', source)
    module = importlib.util.module_from_spec(spec)
    with patch.dict(sys.modules, modules):
        spec.loader.exec_module(module)
    return module


LOCAL = load_downloader()


class LocalDownloadTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / 'original' / '炸弹贴图.mp4'
        self.source.parent.mkdir()
        self.source.write_bytes(b'original media must stay unchanged')
        self.commands = []

    def run_media(self, command, **kwargs):
        self.commands.append(command)
        if command[0] == 'ffprobe':
            return subprocess.CompletedProcess(command, 0, json.dumps({'format': {'duration': '6256.4'}}), '')
        Path(command[-1]).write_bytes(b'generated mock artifact')
        return subprocess.CompletedProcess(command, 0, '', '')

    def test_explicit_output_preserves_source_and_returns_metadata(self):
        original = self.source.read_bytes()
        output = self.root / 'isolated' / 'media'
        with patch.object(LOCAL.subprocess, 'run', side_effect=self.run_media):
            result = LOCAL.LocalDownloader().download(str(self.source), str(output), need_video=True)
        self.assertEqual(result.duration, 6256.4)
        self.assertEqual(result.video_path, str(self.source.resolve()))
        self.assertEqual(Path(result.file_path).parent, output.resolve())
        self.assertEqual(Path(result.raw_info['cover_path']).parent, output.resolve())
        self.assertTrue(result.cover_url.startswith('/static/cover/'))
        self.assertEqual(self.source.read_bytes(), original)
        self.assertEqual(list(self.source.parent.iterdir()), [self.source])
        self.assertEqual(len(self.commands), 3)

    def test_default_output_and_direct_helpers_use_note_output_root(self):
        output = self.root / 'owned_notes'
        with patch.dict(os.environ, {'NOTE_OUTPUT_DIR': str(output)}), patch.object(LOCAL.subprocess, 'run', side_effect=self.run_media):
            downloader = LOCAL.LocalDownloader()
            result = downloader.download(str(self.source))
            direct_audio = downloader.convert_to_mp3(str(self.source))
            direct_cover = downloader.extract_cover(str(self.source))
        for path in (result.file_path, result.raw_info['cover_path'], direct_audio, direct_cover):
            self.assertTrue(Path(path).resolve().is_relative_to(output.resolve() / 'local_media'))
        self.assertEqual(list(self.source.parent.iterdir()), [self.source])

    def test_ffmpeg_failure_retains_stderr_tail(self):
        failure = subprocess.CalledProcessError(1, ['ffmpeg'], stderr=('x' * 3000 + '\n没有可解码的音频流').encode())
        with patch.object(LOCAL.subprocess, 'run', side_effect=failure):
            with self.assertRaisesRegex(RuntimeError, '没有可解码的音频流') as error:
                LOCAL.LocalDownloader().convert_to_mp3(str(self.source), str(self.root / 'output/audio.mp3'))
        self.assertLess(len(str(error.exception)), 1900)

    def test_missing_and_invalid_duration_are_explicit_errors(self):
        with self.assertRaises(FileNotFoundError):
            LOCAL.LocalDownloader().download(str(self.root / 'missing.mp4'))
        for duration in ('0', 'N/A', 'nan', '-1'):
            probe = subprocess.CompletedProcess(['ffprobe'], 0, json.dumps({'format': {'duration': duration}}), '')
            with patch.object(LOCAL.subprocess, 'run', return_value=probe):
                with self.assertRaisesRegex(RuntimeError, '无法读取有效媒体时长'):
                    LOCAL.LocalDownloader()._duration(self.source)

    def test_refuses_source_overwrite(self):
        with self.assertRaisesRegex(ValueError, '不能覆盖原媒体文件'):
            LOCAL.LocalDownloader().convert_to_mp3(str(self.source), str(self.source))


if __name__ == '__main__':
    unittest.main()
