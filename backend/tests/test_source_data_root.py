import json
import os
from pathlib import Path
import subprocess
import sys


def test_source_data_root_is_applied_before_imports(tmp_path):
    backend = Path(__file__).resolve().parents[1]
    env = dict(os.environ, BILINOTE_DATA_ROOT=str(tmp_path / 'isolated'))
    for name in ('DATABASE_URL', 'NOTE_OUTPUT_DIR', 'OUT_DIR'):
        env.pop(name, None)
    code = "import sys,json,os;sys.dont_write_bytecode=True;sys.path.insert(0,sys.argv[1]);import runtime_env;from app.utils.path_helper import get_data_dir,get_app_dir,get_model_dir;print(json.dumps([os.getcwd(),os.getenv('DATABASE_URL'),os.getenv('NOTE_OUTPUT_DIR'),get_data_dir(),get_app_dir(),get_model_dir()]))"
    result = subprocess.run([sys.executable, '-c', code, str(backend)], env=env,
                            capture_output=True, text=True, check=True)
    paths = json.loads(result.stdout)
    root = (tmp_path / 'isolated').resolve()
    assert Path(paths[0]) == root
    assert paths[1] == 'sqlite:///' + (root / 'bili_note.db').as_posix()
    assert all(Path(value).resolve().is_relative_to(root) for value in paths[2:])
