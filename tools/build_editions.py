"""Build clean Windows portable editions without accessing installed BiliNote data.

Each step preserves logs and refuses to overwrite a completed package.
Invoke with the existing build Python 3.11 (PyInstaller installed).
"""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import zipfile

ROOT = Path(__file__).resolve().parents[1]
FRONTEND = ROOT / "BillNote_frontend"
VERSION = "0.1.0-preview.8"
PORTS = {"quick": 38483, "full": 38484}


def run(command, cwd, log, env=None):
    with log.open("w", encoding="utf-8") as stream:
        subprocess.run(command, cwd=cwd, env=env, stdout=stream, stderr=subprocess.STDOUT, check=True)


def backend(args, work):
    sys.path.insert(0, str(args.dependencies))
    # Catch a Python 3.12 test overlay accidentally supplied to a 3.11 freezer.
    import pydantic_core._pydantic_core
    import orjson
    import fastapi
    if args.edition == "full":
        import langgraph.checkpoint.sqlite
    from PyInstaller.__main__ import run as freeze
    entry = work / "portable_entry.py"
    bootstrap = "installed_runtime" if getattr(args, "installer", False) else "portable_runtime"
    entry.write_text(f"from {bootstrap} import configure\nconfigure({args.edition!r})\n"
                     "import main\nimport uvicorn\nimport os\n"
                     "if __name__ == '__main__':\n"
                     "    uvicorn.run(main.app, host='127.0.0.1', port=int(os.environ['BACKEND_PORT']))\n", encoding="utf-8")
    packages = ["chromadb"]
    distributions = []
    hidden = ["uvicorn", "fastapi", "starlette"]
    excludes = ["markdown_pdf", "fitz", "pymupdf"] if getattr(args, "installer", False) else []
    if getattr(args, "installer", False):
        excludes += ["app.transcriber.whisper", "app.transcriber.mlx_whisper_transcriber", "faster_whisper", "ctranslate2", "torch", "av"]
        excludes += ["gmssl", "app.downloaders.douyin_downloader", "app.downloaders.douyin_helper"]
    if args.edition == "full":
        packages += ["langgraph", "langchain_core", "langsmith", "sqlite_vec"]
        distributions = ["langgraph", "langgraph-checkpoint", "langgraph-checkpoint-sqlite", "langgraph-prebuilt",
                         "langgraph-sdk", "langchain-core", "langchain-protocol", "langsmith", "aiosqlite", "ormsgpack", "uuid-utils"]
        hidden += ["app.services.organizer_sessions"]
    else:
        excludes = ["app.transcriber.whisper", "app.transcriber.mlx_whisper_transcriber", "faster_whisper", "ctranslate2", "torch",
                    "app.routers.organizer", "app.services.organizer", "app.services.organizer_sessions",
                    "langgraph", "langchain_core", "langsmith", "sqlite_vec"]
    spec = work / "BiliNoteBackend.spec"
    spec.write_text(f'''
from PyInstaller.utils.hooks import collect_all, copy_metadata
datas = [({str(ROOT / 'backend/app/db/builtin_providers.json')!r}, '.'), ({str(ROOT / 'backend/app/db/builtin_providers.json')!r}, 'app/db')]
binaries = []
hiddenimports = {hidden!r}
for package in {packages!r}:
    d, b, h = collect_all(package)
    datas += d; binaries += b; hiddenimports += h
for distribution in {distributions!r}:
    datas += copy_metadata(distribution)
a = Analysis([{str(entry)!r}], pathex=[{str(args.dependencies)!r}, {str(ROOT / 'backend')!r}], binaries=binaries, datas=datas, hiddenimports=hiddenimports, excludes={excludes!r}, noarchive=False, optimize=0)
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name='BiliNoteBackend', debug=False, strip=False, upx=False, console=True)
coll = COLLECT(exe, a.binaries, a.datas, strip=False, upx=False, name='BiliNoteBackend')
''', encoding="utf-8")
    freeze(["--noconfirm", "--distpath", str(work / "backend-dist"), "--workpath", str(work / "backend-work"), str(spec)])


def desktop(args, work):
    env = dict(os.environ)
    env.update(VITE_BILINOTE_EDITION=args.edition, VITE_APP_VERSION=VERSION, VITE_API_BASE_URL=f"http://127.0.0.1:{PORTS[args.edition]}/api",
               CARGO_HOME=str(args.toolchains / "cargo"), RUSTUP_HOME=str(args.toolchains / "rustup"),
               CARGO_TARGET_DIR=str(args.cargo_target))
    env["PATH"] = str(args.toolchains / "cargo/bin") + os.pathsep + env.get("PATH", "")
    node = shutil.which("node")
    if not node:
        raise RuntimeError("Node.js is required on the build machine only")
    run([node, "node_modules/vite/bin/vite.js", "build", "--mode", "tauri", "--outDir", str(work / "frontend")], FRONTEND, work / "frontend-build.log", env)
    sidecar = work / "sidecar"
    sidecar.mkdir(exist_ok=True)
    shutil.copy2(work / "backend-dist/BiliNoteBackend/BiliNoteBackend.exe", sidecar / "BiliNoteBackend-x86_64-pc-windows-msvc.exe")
    name = "BiliNote Studio 快捷版" if args.edition == "quick" else "BiliNote Studio 完整版"
    config = {
        "productName": name, "version": VERSION, "identifier": f"com.bilinote.studio.{args.edition}",
        # A Windows drive-letter absolute path can be parsed as a URL by Tauri.
        "build": {"beforeBuildCommand": "", "frontendDist": os.path.relpath(work / "frontend", FRONTEND / "src-tauri").replace('\\', '/')},
        "app": {"windows": [{"title": name, "width": 1400, "height": 900, "minWidth": 1000, "minHeight": 650, "devtools": False}]},
        "bundle": {"active": False, "externalBin": [os.path.relpath(sidecar / "BiliNoteBackend", FRONTEND / "src-tauri").replace('\\', '/')], "resources": []},
    }
    config_path = work / "tauri-edition.json"
    config_path.write_text(json.dumps(config, ensure_ascii=False, indent=2), encoding="utf-8")
    command = work / "build-desktop.cmd"
    # No data mutations in cmd: only establish the compiler environment, then invoke Tauri.
    command.write_text('@echo off\r\ncall "' + str(args.toolchains / "VS2022/VC/Auxiliary/Build/vcvars64.bat") + '"\r\n'
                       'if errorlevel 1 exit /b %errorlevel%\r\n"' + node + '" "node_modules\\@tauri-apps\\cli\\tauri.js" build --no-bundle --config "'
                       + str(config_path) + '"\r\nexit /b %errorlevel%\r\n', encoding="utf-8")
    run(["cmd.exe", "/d", "/c", str(command)], FRONTEND, work / "desktop-build.log", env)
    shutil.copy2(args.cargo_target / "release/BiliNoteStudio.exe", work / "BiliNoteStudio.exe")


def package(args, work):
    name = f"BiliNote-Studio-{args.edition.title()}-{VERSION}-windows-x64"
    destination = args.output / "packages" / name
    if destination.exists():
        raise ValueError("Package directory already exists; use a fresh output to preserve prior artifacts")
    shutil.copytree(work / "backend-dist/BiliNoteBackend", destination)
    shutil.copy2(work / "BiliNoteStudio.exe", destination / "BiliNoteStudio.exe")
    (destination / "bin").mkdir()
    for binary in ("ffmpeg.exe", "ffprobe.exe"):
        shutil.copy2(args.ffmpeg / "bin" / binary, destination / "bin" / binary)
    shutil.copy2(ROOT / "LICENSE", destination / "LICENSE.txt")
    shutil.copytree(args.ffmpeg / "doc", destination / "licenses/ffmpeg-doc")
    shutil.copy2(args.ffmpeg / "LICENSE", destination / "licenses/FFmpeg-LICENSE.txt")
    shutil.copy2(args.ffmpeg / "README.txt", destination / "licenses/FFmpeg-README.txt")
    shutil.copy2(ROOT / "docs/studio/USER_GUIDE.md", destination / "使用说明.md")
    (destination / "Start-BiliNote-Studio.cmd").write_text('@echo off\r\ncd /d "%~dp0"\r\nstart "" "%~dp0BiliNoteStudio.exe"\r\n', encoding="ascii")
    manifest = {"version": VERSION, "edition": args.edition, "port": PORTS[args.edition],
                "identifier": f"com.bilinote.studio.{args.edition}", "private_configuration_included": False,
                "local_whisper": args.edition == "full", "organizer": args.edition == "full", "files": {}}
    forbidden = {".env", "bili_note.db", "cookies.json", "transcriber.json", "checkpoints.sqlite", "sessions.sqlite"}
    for path in sorted(destination.rglob("*")):
        if not path.is_file():
            continue
        if path.name.lower() in forbidden or path.suffix.lower() in (".db", ".sqlite", ".sqlite3"):
            raise ValueError(f"Unexpected private/runtime file in package: {path.relative_to(destination)}")
        manifest["files"][path.relative_to(destination).as_posix()] = {"bytes": path.stat().st_size, "sha256": hashlib.file_digest(path.open("rb"), "sha256").hexdigest()}
    (destination / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    archive = args.output / "packages" / (name + ".zip")
    with zipfile.ZipFile(archive, "x", zipfile.ZIP_DEFLATED, compresslevel=6, allowZip64=True) as output:
        for path in sorted(destination.rglob("*")):
            if path.is_file():
                output.write(path, name + "/" + path.relative_to(destination).as_posix())
    digest = hashlib.file_digest(archive.open("rb"), "sha256").hexdigest()
    archive.with_suffix(".zip.sha256").write_text(f"{digest}  {archive.name}\n", encoding="ascii")
    print(json.dumps({"archive": str(archive), "bytes": archive.stat().st_size, "sha256": digest}))


def main():
    parser = argparse.ArgumentParser(__doc__)
    parser.add_argument("step", choices=["backend", "desktop", "package"])
    parser.add_argument("--edition", choices=PORTS, required=True)
    parser.add_argument("--output", type=Path, default=ROOT / f".BiliNote-dev/studio-{VERSION}")
    parser.add_argument("--dependencies", type=Path, required=True)
    parser.add_argument("--toolchains", type=Path, required=True)
    parser.add_argument("--cargo-target", type=Path, default=ROOT / ".BiliNote-dev/studio-cargo-target")
    parser.add_argument("--ffmpeg", type=Path, required=True)
    args = parser.parse_args()
    args.output = args.output.resolve()
    if not args.output.is_relative_to(ROOT / ".BiliNote-dev"):
        raise ValueError("Output must remain inside workspace .BiliNote-dev")
    work = args.output / args.edition
    work.mkdir(parents=True, exist_ok=True)
    globals()[args.step](args, work)


if __name__ == "__main__":
    main()
