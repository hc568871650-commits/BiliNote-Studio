"""Focused Groq chunk tests runnable without the desktop application's dependencies."""

from abc import ABC
import importlib.util
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]


def load_groq():
    from dataclasses import dataclass

    @dataclass
    class Segment:
        start: float
        end: float
        text: str

    @dataclass
    class Result:
        language: str
        full_text: str
        segments: list
        raw: dict

    modules = {}
    for name in (
        "app", "app.decorators", "app.decorators.timeit", "app.models",
        "app.models.transcriber_model", "app.services", "app.services.provider",
        "app.transcriber", "app.transcriber.base", "app.utils", "app.utils.logger",
        "app.utils.openai_client", "ffmpeg_helper",
    ):
        modules[name] = types.ModuleType(name)
    modules["app.decorators.timeit"].timeit = lambda method: method
    modules["app.models.transcriber_model"].TranscriptResult = Result
    modules["app.models.transcriber_model"].TranscriptSegment = Segment
    modules["app.services.provider"].ProviderService = type("Provider", (), {"get_provider_by_id": staticmethod(lambda _: {})})
    modules["app.transcriber.base"].Transcriber = type("Transcriber", (ABC,), {})
    modules["app.utils.logger"].get_logger = lambda _: types.SimpleNamespace(info=lambda *a: None, exception=lambda *a: None)
    modules["app.utils.openai_client"].build_openai_client = lambda **_: None
    modules["ffmpeg_helper"].find_ffmpeg_binary = shutil.which
    config_spec = importlib.util.spec_from_file_location('isolated_transcriber_config', ROOT / 'app/services/transcriber_config_manager.py')
    config_module = importlib.util.module_from_spec(config_spec)
    config_spec.loader.exec_module(config_module)
    modules['app.services.transcriber_config_manager'] = types.ModuleType('app.services.transcriber_config_manager')
    modules['app.services.transcriber_config_manager'].TranscriberConfigManager = lambda: config_module.TranscriberConfigManager(
        str(Path(os.environ.get('NOTE_OUTPUT_DIR', tempfile.gettempdir())) / 'test-transcriber.json'))
    with patch.dict(sys.modules, modules):
        spec = importlib.util.spec_from_file_location("groq_under_test", ROOT / "app" / "transcriber" / "groq.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
    return module


class GroqChunkTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.groq = load_groq()
        cls.ffmpeg = cls.groq._binary("ffmpeg")

    def make_audio(self, path):
        subprocess.run([self.ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
                        "-f", "lavfi", "-i", "sine=frequency=440:duration=6",
                        "-c:a", "libmp3lame", "-b:a", "128k", str(path)], check=True)

    def test_splits_into_decodable_chunks_below_actual_byte_limit(self):
        with tempfile.TemporaryDirectory() as directory:
            audio = Path(directory) / "中文.mp3"
            self.make_audio(audio)
            duration, codec = self.groq._probe(audio)
            with patch.object(self.groq, "MAX_UPLOAD_BYTES", 55_000), patch.object(self.groq, "TARGET_CHUNK_BYTES", 42_000):
                chunks = self.groq._split_audio(audio, directory, duration, codec)
            self.assertGreater(len(chunks), 1)
            self.assertEqual(chunks[0][1], 0)
            self.assertAlmostEqual(chunks[-1][2], duration)
            for index, (path, start, end) in enumerate(chunks):
                self.assertLessEqual(path.stat().st_size, 55_000)
                actual, _ = self.groq._probe(path)
                self.assertGreaterEqual(actual, end - start - 0.5)
                if index:
                    self.assertLessEqual(start, chunks[index - 1][2])

    def test_merge_preserves_timeline_and_repeated_nonoverlap_speech(self):
        chunks = [(None, 0, 3), (None, 2, 5)]
        responses = [
            {"language": "zh", "segments": [{"start": 0.2, "end": 0.5, "text": "重复"},
                                             {"start": 2.1, "end": 2.3, "text": "边界"}]},
            {"language": "zh", "segments": [{"start": 0.1, "end": 0.3, "text": "边界"},
                                             {"start": 1.1, "end": 1.3, "text": "重复"}]},
        ]
        merged = self.groq._merge(chunks, responses)
        self.assertEqual(merged.full_text, "重复 边界 重复")
        self.assertEqual([segment.start for segment in merged.segments], [0.2, 2.1, 3.1])

    def test_retry_uses_cached_successful_chunk(self):
        with tempfile.TemporaryDirectory() as directory:
            audio = Path(directory) / "中文.mp3"
            self.make_audio(audio)
            requests = []
            fail_second_once = [True]

            def create(*, file, **_kwargs):
                filename, stream = file
                self.assertTrue(stream.read(1))
                requests.append(filename)
                if len(requests) == 2 and fail_second_once[0]:
                    fail_second_once[0] = False
                    raise ConnectionError("temporary network failure")
                return types.SimpleNamespace(to_dict=lambda: {"language": "zh", "segments": [
                    {"start": 0.1, "end": 0.3, "text": filename},
                ]})

            client = types.SimpleNamespace(audio=types.SimpleNamespace(
                transcriptions=types.SimpleNamespace(create=create)))
            with patch.object(self.groq, "MAX_UPLOAD_BYTES", 55_000), \
                 patch.object(self.groq, "TARGET_CHUNK_BYTES", 42_000), \
                 patch.object(self.groq.ProviderService, "get_provider_by_id", return_value={
                     "api_key": "test-key", "base_url": "https://example.invalid"}), \
                 patch.object(self.groq, "build_openai_client", return_value=client), \
                 patch.dict(os.environ, {"NOTE_OUTPUT_DIR": directory, "GROQ_TRANSCRIBER_MODEL": "test-model"}):
                with self.assertRaisesRegex(RuntimeError, "第 2/"):
                    self.groq.GroqTranscriber().transcript(str(audio))
                transcript = self.groq.GroqTranscriber().transcript(str(audio))
            self.assertEqual(requests.count("chunk_0000.mp3"), 1)
            self.assertTrue(transcript.full_text)

    @unittest.skipUnless(os.environ.get("BILINOTE_GROQ_TEST_AUDIO") and Path(os.environ["BILINOTE_GROQ_TEST_AUDIO"]).is_file(), "optional audio sample unavailable")
    def test_existing_33mb_sample_is_split_without_reencoding(self):
        audio = Path(os.environ["BILINOTE_GROQ_TEST_AUDIO"])
        duration, codec = self.groq._probe(audio)
        with tempfile.TemporaryDirectory() as directory:
            chunks = self.groq._split_audio(audio, directory, duration, codec)
            self.assertGreater(len(chunks), 1)
            self.assertTrue(all(path.suffix == ".mp3" and path.stat().st_size <= 20_000_000
                                for path, _, _ in chunks))
            self.assertAlmostEqual(chunks[-1][2], duration)


if __name__ == "__main__":
    unittest.main()
