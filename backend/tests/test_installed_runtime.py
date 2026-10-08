"""Installed-data isolation and upgrade preservation without loading the app."""
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
from tests.test_portable_editions import load_source, BACKEND

bootstrap = load_source("installed_bootstrap_test", BACKEND / "installed_runtime.py")
runtime_env = load_source("installed_dotenv_test", BACKEND / "runtime_env.py")
paths = load_source("installed_paths_test", BACKEND / "app/utils/path_helper.py")
capabilities = load_source("installed_capabilities_test", BACKEND / "app/edition.py")


class InstalledRuntimeTests(unittest.TestCase):
    def test_default_data_separate_from_program_and_dotenv_scoped(self):
        previous_cwd = Path.cwd()
        temporary = tempfile.TemporaryDirectory()
        try:
            with patch.dict(os.environ, {}, clear=True), patch.object(sys, "frozen", True, create=True):
                root = Path(temporary.name).resolve()
                program = root / "program"
                program.mkdir()
                local = root / "LocalAppData"
                os.environ["LOCALAPPDATA"] = str(local)
                (program / ".env").write_text("INSTALL_PRIVATE=outside\n")
                with patch.object(sys, "executable", str(program / "BiliNoteBackend.exe")):
                    data = bootstrap.configure()
                    self.assertEqual(data, local / "BiliNoteStudio")
                    self.assertEqual(Path.cwd(), data)
                    self.assertFalse(capabilities.is_quick())
                    self.assertFalse(capabilities.has_local_whisper())
                    for engine in ("bcut", "kuaishou", "groq"):
                        capabilities.require_local_transcriber(engine)
                    for engine in ("fast-whisper", "mlx-whisper", "unknown"):
                        with self.assertRaises(ValueError):
                            capabilities.require_local_transcriber(engine)
                    self.assertEqual(Path(paths.get_data_dir()), data / "data")
                    self.assertEqual(Path(paths.get_app_dir("frames")), data / "frames")
                    self.assertEqual(Path(os.environ["FFMPEG_BIN_PATH"]), data / "bin")
                    runtime_env.load_dotenv(program / ".env", override=True)
                    self.assertNotIn("INSTALL_PRIVATE", os.environ)
                    (data / ".env").write_text("INSTALL_PUBLIC=local\nBACKEND_PORT=8483\n")
                    runtime_env.load_dotenv(override=True)
                    self.assertEqual(os.environ["INSTALL_PUBLIC"], "local")
                    self.assertEqual(os.environ["BACKEND_PORT"], "38484")
                    sentinel = data / "config/settings.json"
                    sentinel.parent.mkdir(parents=True)
                    sentinel.write_text('{"preserved":true}')
                    bootstrap.configure()  # Rust->backend handoff and subsequent upgraded launch.
                    self.assertEqual(sentinel.read_text(), '{"preserved":true}')
                    self.assertEqual(list(program.iterdir()), [program / ".env"])
        finally:
            os.chdir(previous_cwd)
            temporary.cleanup()

    def test_invalid_override_and_unfrozen_fail_before_mutation(self):
        for frozen, path in ((False, "C:/example"), (True, "relative")):
            with patch.dict(os.environ, {"BILINOTE_STUDIO_DATA_ROOT": path}, clear=True), patch.object(sys, "frozen", frozen, create=True):
                before = dict(os.environ)
                with self.assertRaises(RuntimeError):
                    bootstrap.configure()
                self.assertEqual(before, dict(os.environ))


if __name__ == "__main__":
    unittest.main()
