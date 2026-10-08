"""Portable runtime isolation without importing the app or starting services."""
import importlib.util
import io
import os
from pathlib import Path
import sys
import tempfile
import unittest
from contextlib import ExitStack
from unittest.mock import patch


BACKEND = Path(__file__).resolve().parents[1]


def load_source(name, path):
    # Loading app.edition directly avoids app.__init__ and its database/routes.
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


bootstrap = load_source("portable_bootstrap_test", BACKEND / "portable_runtime.py")
runtime_env = load_source("portable_env_test", BACKEND / "runtime_env.py")
capabilities = load_source("portable_capabilities_test", BACKEND / "app/edition.py")


class PortableEditionTests(unittest.TestCase):
    def setUp(self):
        self.previous_cwd = Path.cwd()
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.addCleanup(os.chdir, self.previous_cwd)
        self.root = Path(self.stack.enter_context(tempfile.TemporaryDirectory(
            prefix="bilinote-portable-test-"))).resolve()
        self.package = self.root / "package"
        self.external = self.root / "external-cwd"
        self.package.mkdir()
        self.external.mkdir()
        self.stack.enter_context(patch.dict(os.environ, {}, clear=True))
        self.stack.enter_context(patch.object(sys, "frozen", True, create=True))
        self.stack.enter_context(patch.object(sys, "executable", str(self.package / "BiliNoteBackend.exe")))
        os.chdir(self.external)

    def test_bootstrap_overrides_inherited_paths_and_external_cwd(self):
        paths = {
            "APPDATA": "AppData", "LOCALAPPDATA": "LocalAppData",
            "TEMP": "Temp", "TMP": "Temp", "HF_HOME": "Cache/huggingface",
            "XDG_CACHE_HOME": "Cache", "NOTE_OUTPUT_DIR": "note_results",
            "OUT_DIR": "static/screenshots", "VECTOR_DB_DIR": "vector_db",
            "DATA_DIR": "data", "FFMPEG_BIN_PATH": "bin",
        }
        for key in paths:
            os.environ[key] = str(self.external / "private" / key)
        os.environ.update(DATABASE_URL="sqlite:///external-personal.db", BACKEND_PORT="8483")
        self.assertEqual(bootstrap.configure("quick"), self.package)
        self.assertEqual(Path.cwd(), self.package)
        for key, relative in paths.items():
            with self.subTest(key=key):
                target = Path(os.environ[key]).resolve()
                self.assertEqual(target, self.package / relative)
                self.assertTrue(target.is_relative_to(self.package))
                if key != "FFMPEG_BIN_PATH":
                    self.assertTrue(target.is_dir())
        self.assertEqual(os.environ["DATABASE_URL"], "sqlite:///" + (self.package / "bili_note.db").as_posix())
        self.assertEqual(os.environ["BACKEND_PORT"], "38483")
        self.assertEqual(os.environ["BACKEND_HOST"], "127.0.0.1")
        self.assertEqual(os.environ["TRANSCRIBER_TYPE"], "bcut")
        self.assertFalse((self.external / "private").exists())
        self.assertFalse((self.package / "bili_note.db").exists())

    def test_full_has_separate_port_and_local_default(self):
        bootstrap.configure("full")
        self.assertEqual(os.environ["BACKEND_PORT"], "38484")
        self.assertEqual(os.environ["BILINOTE_EDITION"], "full")
        self.assertEqual(os.environ["BILINOTE_PORTABLE"], "1")
        self.assertEqual(os.environ["TRANSCRIBER_TYPE"], "fast-whisper")
        self.assertEqual(os.environ["WHISPER_MODEL_SIZE"], "tiny")
        self.assertEqual(os.environ["LANGSMITH_TRACING"], "false")
        self.assertEqual(os.environ["LANGCHAIN_TRACING_V2"], "false")
        self.assertEqual(os.environ["ANONYMIZED_TELEMETRY"], "false")

    def test_unfrozen_and_invalid_editions_fail_before_mutation(self):
        for edition, frozen in [("quick", False), ("unknown", True)]:
            with self.subTest(edition=edition, frozen=frozen), patch.object(sys, "frozen", frozen):
                before = dict(os.environ)
                with self.assertRaises(RuntimeError):
                    bootstrap.configure(edition)
                self.assertEqual(dict(os.environ), before)
                self.assertEqual(Path.cwd(), self.external)
                self.assertEqual(list(self.package.iterdir()), [])

    def test_parent_and_external_cwd_dotenv_are_not_discovered(self):
        (self.root / ".env").write_text("PORTABLE_PARENT_SENTINEL=parent\n", encoding="utf-8")
        (self.external / ".env").write_text("PORTABLE_CWD_SENTINEL=external\n", encoding="utf-8")
        bootstrap.configure("quick")
        os.chdir(self.external)
        runtime_env.load_dotenv()
        self.assertNotIn("PORTABLE_PARENT_SENTINEL", os.environ)
        self.assertNotIn("PORTABLE_CWD_SENTINEL", os.environ)

    def test_package_dotenv_loads_without_overriding_forced_paths(self):
        (self.package / ".env").write_text(
            "PORTABLE_PACKAGE_SENTINEL=package\nBACKEND_PORT=8483\n"
            "DATABASE_URL=sqlite:///outside.db\nVECTOR_DB_DIR=outside-vector\n"
            "NOTE_OUTPUT_DIR=outside-notes\nDATA_DIR=outside-data\nBILINOTE_EDITION=full\n",
            encoding="utf-8")
        bootstrap.configure("quick")
        forced = {key: os.environ[key] for key in (
            "BACKEND_PORT", "DATABASE_URL", "VECTOR_DB_DIR", "NOTE_OUTPUT_DIR", "DATA_DIR", "BILINOTE_EDITION")}
        os.chdir(self.external)
        self.assertTrue(runtime_env.load_dotenv(override=True))
        self.assertEqual(os.environ["PORTABLE_PACKAGE_SENTINEL"], "package")
        for key, value in forced.items():
            self.assertEqual(os.environ[key], value)

    def test_portable_explicit_external_file_and_stream_are_ignored(self):
        external_env = self.external / ".env"
        external_env.write_text("PORTABLE_EXTERNAL_SENTINEL=outside\n", encoding="utf-8")
        (self.package / ".env").write_text("PORTABLE_PACKAGE_SENTINEL=package\n", encoding="utf-8")
        bootstrap.configure("quick")
        runtime_env.load_dotenv(external_env, override=True)
        runtime_env.load_dotenv(stream=io.StringIO("PORTABLE_STREAM_SENTINEL=outside\n"))
        self.assertEqual(os.environ["PORTABLE_PACKAGE_SENTINEL"], "package")
        self.assertNotIn("PORTABLE_EXTERNAL_SENTINEL", os.environ)
        self.assertNotIn("PORTABLE_STREAM_SENTINEL", os.environ)

    def test_nonportable_dotenv_keeps_explicit_source_behavior(self):
        with patch.object(sys, "frozen", False):
            runtime_env.load_dotenv(stream=io.StringIO("PORTABLE_SOURCE_SENTINEL=source\n"))
        self.assertEqual(os.environ["PORTABLE_SOURCE_SENTINEL"], "source")

    def test_quick_rejects_local_and_unknown_transcribers_full_allows_local(self):
        os.environ["BILINOTE_EDITION"] = "quick"
        self.assertTrue(capabilities.is_quick())
        for engine in ("bcut", "kuaishou", "groq"):
            capabilities.require_local_transcriber(engine)
        for engine in ("fast-whisper", "mlx-whisper", "unknown", ""):
            with self.subTest(engine=engine), self.assertRaises(ValueError):
                capabilities.require_local_transcriber(engine)
        os.environ["BILINOTE_EDITION"] = "full"
        self.assertFalse(capabilities.is_quick())
        for engine in ("fast-whisper", "mlx-whisper"):
            capabilities.require_local_transcriber(engine)


if __name__ == "__main__":
    unittest.main()
