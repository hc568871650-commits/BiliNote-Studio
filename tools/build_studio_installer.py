"""Build one clean per-user Windows Studio installer, retaining portable tooling."""
from __future__ import annotations
import argparse
import ast
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import shutil
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_editions as editions

ROOT = editions.ROOT
FRONTEND = editions.FRONTEND
VERSION = editions.VERSION


def dependency_inventory(args, work):
    records = []
    for distribution in importlib.metadata.distributions(path=[str(args.dependencies), *sys.path]):
        metadata = distribution.metadata
        name = metadata.get("Name", "unknown")
        if any(item["name"].lower() == name.lower() for item in records):
            continue
        records.append({"name": name, "version": distribution.version,
                        "license": metadata.get("License-Expression") or metadata.get("License", ""),
                        "classifiers": [x for x in metadata.get_all("Classifier", []) if x.startswith("License")],
                        "location": str(distribution.locate_file(""))})
    (work / "build-environment-dependencies.json").write_text(json.dumps(records, indent=2, ensure_ascii=False), encoding="utf-8")


def bundled_notices(args, work):
    collected = set()
    def visit(value):
        if isinstance(value, (list, tuple)):
            for item in value:
                visit(item)
        elif isinstance(value, str) and ("site-packages" in value or "agent-deps" in value):
            collected.add(os.path.normcase(os.path.abspath(value)))
    visit(ast.literal_eval((work / "backend-work/BiliNoteBackend/Analysis-00.toc").read_text(encoding="utf-8")))
    backend_digest = hashlib.file_digest((work / "backend-dist/BiliNoteBackend/BiliNoteBackend.exe").open("rb"), "sha256").hexdigest()[:12]
    notices = work / "python-notices" / backend_digest
    notices.mkdir(parents=True, exist_ok=True)
    inventory = []
    seen = set()
    for distribution in importlib.metadata.distributions(path=[str(args.dependencies), *sys.path]):
        name = distribution.metadata.get("Name", "unknown")
        if name.lower() in seen or name.lower().replace('_', '-') in ("pymupdf", "markdown-pdf"):
            continue
        seen.add(name.lower())
        files = list(distribution.files or [])
        bundled = any(os.path.normcase(os.path.abspath(distribution.locate_file(file))) in collected for file in files)
        if not bundled and name.lower() != "pyinstaller":
            continue
        destination = notices / (name + "-" + distribution.version)
        destination.mkdir(exist_ok=True)
        license_paths = []
        for file in files:
            if any(token in str(file).lower() for token in ("license", "licence", "copying", "copyright", "notice")):
                source = Path(distribution.locate_file(file))
                if source.is_file() and source.suffix.lower() not in (".pyc", ".py", ".pyd", ".dll"):
                    # Flatten wheel metadata paths: NSIS still has a traditional
                    # Windows path limit and repeated dist-info names exceed it.
                    target = destination / source.name
                    if target.exists() and target.read_bytes() != source.read_bytes():
                        target = destination / (hashlib.sha256(str(file).encode()).hexdigest()[:12] + "-" + source.name)
                    target.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(source, target)
                    license_paths.append(target.relative_to(notices).as_posix())
        metadata = distribution.metadata
        inventory.append({"name": name, "version": distribution.version,
                          "license": metadata.get("License-Expression") or metadata.get("License", ""),
                          "classifiers": [x for x in metadata.get_all("Classifier", []) if x.startswith("License")],
                          "license_files": license_paths,
                          "role": "runtime" if bundled else "freezer-bootloader-exception"})
    (notices / "bundled-dependencies.json").write_text(json.dumps(inventory, ensure_ascii=False, indent=2), encoding="utf-8")
    for source in (Path(sys.executable).parent / "LICENSE.txt", Path(sys.executable).parent / "LICENSE"):
        if source.exists():
            shutil.copy2(source, notices / "Python-LICENSE.txt")
            break
    return notices


def backend(args, work):
    args.edition = "full"
    args.installer = True
    editions.backend(args, work)
    files = list((work / "backend-dist").rglob("*"))
    forbidden = [str(path) for path in files if any(name in path.name.lower() for name in ("mupdf", "markdown_pdf", "fitz", "av.libs", "x264", "x265", "ctranslate", "faster_whisper", "gmssl", "douyin"))]
    if forbidden:
        raise RuntimeError("Excluded PDF dependencies remain: " + repr(forbidden))
    private_files = [str(path) for path in files if path.is_file() and (
        path.name.lower() in (".env", "bili_note.db", "cookies.json", "transcriber.json", "sessions.sqlite", "checkpoints.sqlite")
        or path.suffix.lower() in (".db", ".sqlite", ".sqlite3"))]
    if private_files:
        raise RuntimeError("Unexpected private/runtime files in frozen backend: " + repr(private_files))
    bundled_notices(args, work)


def desktop(args, work):
    source_paths = set()
    for source_root, suffixes in ((ROOT / "backend", {".py"}), (FRONTEND / "src", None), (FRONTEND / "src-tauri/src", None)):
        for source in source_root.rglob("*"):
            if not source.is_file() or (suffixes is not None and source.suffix not in suffixes):
                continue
            relative = source.relative_to(ROOT).as_posix()
            if relative.startswith(("backend/tests/", "backend/tools/", "backend/app/downloaders/douyin_helper/")) or relative == "backend/app/downloaders/douyin_downloader.py":
                continue
            source_paths.add(source)
    for relative in ("BillNote_frontend/vite.config.ts", "BillNote_frontend/package.json", "BillNote_frontend/pnpm-lock.yaml",
                     "BillNote_frontend/src-tauri/Cargo.toml", "BillNote_frontend/src-tauri/Cargo.lock",
                     "BillNote_frontend/src-tauri/build.rs", "BillNote_frontend/src-tauri/tauri.conf.json"):
        source = ROOT / relative
        if source.exists():
            source_paths.add(source)
    source_hashes = {source.relative_to(ROOT).as_posix(): hashlib.file_digest(source.open("rb"), "sha256").hexdigest()
                     for source in sorted(source_paths)}
    (work / "runtime-source-sha256.json").write_text(json.dumps(source_hashes, ensure_ascii=False, indent=2), encoding="utf-8")
    env = dict(os.environ)
    env.update(VITE_BILINOTE_EDITION="full", VITE_APP_VERSION=VERSION,
               VITE_BILINOTE_LOCAL_WHISPER="0",
               VITE_BILINOTE_DISTRIBUTION="installer",
               VITE_API_BASE_URL="http://127.0.0.1:38484/api",
               CARGO_HOME=str(args.toolchains / "cargo"), RUSTUP_HOME=str(args.toolchains / "rustup"),
               CARGO_TARGET_DIR=str(args.cargo_target))
    env["PATH"] = str(args.toolchains / "cargo/bin") + os.pathsep + str(args.node.parent) + os.pathsep + env.get("PATH", "")
    editions.run([str(args.node), "node_modules/vite/bin/vite.js", "build", "--mode", "tauri", "--outDir", str(work / "frontend")], FRONTEND, work / "frontend-build.log", env)
    sidecar = work / "sidecar"
    sidecar.mkdir(exist_ok=True)
    backend_root = work / "backend-dist/BiliNoteBackend"
    shutil.copy2(backend_root / "BiliNoteBackend.exe", sidecar / "BiliNoteBackend-x86_64-pc-windows-msvc.exe")
    backend_digest = hashlib.file_digest((backend_root / "BiliNoteBackend.exe").open("rb"), "sha256").hexdigest()[:12]
    payload = work / "resources" / backend_digest
    payload.mkdir(parents=True, exist_ok=True)
    shutil.copy2(ROOT / "LICENSE", payload / "LICENSE.txt")
    shutil.copytree(bundled_notices(args, work), payload / "licenses/Python", dirs_exist_ok=True)
    # A release owner must supply reviewed dependency notices, never private configuration.
    if args.notices:
        # Python notices above describe this exact frozen dependency inventory.
        # A previous release's Python inventory must not overwrite that evidence.
        shutil.copytree(args.notices, payload / "licenses", dirs_exist_ok=True,
                        ignore=lambda directory, names: ["Python"] if Path(directory) == args.notices else [])
    for notice_name in ("THIRD_PARTY_NOTICES.frontend.txt", "THIRD_PARTY_NOTICES.rust.txt"):
        notice = ROOT / "docs/studio" / notice_name
        if notice.exists():
            (payload / "licenses").mkdir(exist_ok=True)
            shutil.copy2(notice, payload / "licenses" / notice.name)
    guide = ROOT / "docs/studio/USER_GUIDE.md"
    if guide.exists():
        shutil.copy2(guide, payload / "USER_GUIDE.md")
    extra_licenses = work / "extra-licenses"
    if extra_licenses.exists():
        shutil.copytree(extra_licenses, payload / "licenses/Extra", dirs_exist_ok=True, ignore=shutil.ignore_patterns("*REFERENCE-ONLY*"))
        source_manifest = payload / "licenses/Extra/SOURCES.json"
        if source_manifest.exists():
            sources = json.loads(source_manifest.read_text(encoding="utf-8-sig"))
            for entry in sources.get("entries", []):
                if entry.get("name") == "gmssl":
                    entry.update(status="excluded_not_bundled", bundled=False)
                    entry.pop("file", None)
            sources["unresolved_packages"] = [name for name in sources.get("unresolved_packages", []) if not name.startswith("gmssl")]
            source_manifest.write_text(json.dumps(sources, ensure_ascii=False, indent=2), encoding="utf-8")
    # An array replaces the base config's legacy resource map instead of merging
    # its missing bin/BiliNoteBackend tree. NSIS hooks install the freezer tree
    # at the sidecar's required _internal location without staging in source.
    hooks = work / "installer-hooks.nsh"
    install_lines = ['!macro NSIS_HOOK_POSTINSTALL', '  SetOutPath "$INSTDIR\\_internal"',
                     '  File /r "' + str(backend_root / "_internal" / "*") + '"',
                     '  SetOutPath "$INSTDIR"', '  File /r "' + str(payload / "*") + '"']
    if args.ffmpeg:
        install_lines.append('  SetOutPath "$INSTDIR\\bin"')
        for name in ("ffmpeg.exe", "ffprobe.exe"):
            install_lines.append('  File "' + str(args.ffmpeg / "bin" / name) + '"')
    installed_kib = (sum(path.stat().st_size for path in backend_root.rglob('*') if path.is_file()) +
                     sum(path.stat().st_size for path in payload.rglob('*') if path.is_file()) + 32 * 1024 * 1024) // 1024
    install_lines += ['  WriteRegDWORD SHCTX "${UNINSTKEY}" "EstimatedSize" ' + str(installed_kib),
                      '!macroend', '!macro NSIS_HOOK_PREUNINSTALL',
                      '  RMDir /r "$INSTDIR\\_internal"', '  RMDir /r "$INSTDIR\\licenses"',
                      '  Delete "$INSTDIR\\LICENSE.txt"', '  Delete "$INSTDIR\\USER_GUIDE.md"', '!macroend']
    hooks.write_text('\n'.join(install_lines) + '\n', encoding="utf-8")
    config = {
        "productName": "BiliNote Studio", "mainBinaryName": "BiliNoteStudio", "version": VERSION,
        "identifier": "com.bilinote.studio",
        "build": {"beforeBuildCommand": "", "frontendDist": os.path.relpath(work / "frontend", FRONTEND / "src-tauri").replace("\\", "/")},
        "app": {"windows": [{"title": "BiliNote Studio", "width": 1400, "height": 900, "minWidth": 1000, "minHeight": 650, "devtools": False}]},
        "bundle": {"active": True, "targets": ["nsis"], "resources": [],
                   "externalBin": [os.path.relpath(sidecar / "BiliNoteBackend", FRONTEND / "src-tauri").replace("\\", "/")],
                   "licenseFile": os.path.relpath(ROOT / "LICENSE", FRONTEND / "src-tauri").replace("\\", "/"),
                   "windows": {"webviewInstallMode": {"type": "downloadBootstrapper", "silent": True},
                               "nsis": {"installMode": "currentUser", "languages": ["SimpChinese", "English"], "displayLanguageSelector": False,
                                        "installerHooks": str(hooks)}}},
    }
    config_path = work / "tauri-installer.json"
    config_path.write_text(json.dumps(config, ensure_ascii=False, indent=2), encoding="utf-8")
    command = work / "build-desktop.cmd"
    command.write_text('@echo off\r\ncall "' + str(args.toolchains / "VS2022/VC/Auxiliary/Build/vcvars64.bat") + '"\r\n'
                       'if errorlevel 1 exit /b %errorlevel%\r\n"' + str(args.node) + '" "node_modules\\@tauri-apps\\cli\\tauri.js" build --bundles nsis --config "'
                       + str(config_path) + '"\r\nexit /b %errorlevel%\r\n', encoding="utf-8")
    editions.run(["cmd.exe", "/d", "/c", str(command)], FRONTEND, work / "desktop-build.log", env)
    installers = list((args.cargo_target / "release/bundle/nsis").glob("*.exe"))
    if len(installers) != 1:
        raise RuntimeError("Expected exactly one Windows installer")
    destination = work / f"BiliNote-Studio-{VERSION}-windows-x64-setup.exe"
    if destination.exists():
        raise RuntimeError("Completed installer already exists; use a new output directory")
    shutil.copy2(installers[0], destination)
    digest = hashlib.file_digest(destination.open("rb"), "sha256").hexdigest()
    destination.with_suffix(".exe.sha256").write_text(f"{digest}  {destination.name}\n", encoding="ascii")
    manifest = {"installer": str(destination), "bytes": destination.stat().st_size, "sha256": digest,
                "version": VERSION, "identifier": "com.bilinote.studio", "port": 38484,
                "data_directory": "%LOCALAPPDATA%/BiliNoteStudio", "ffmpeg": str(args.ffmpeg) if args.ffmpeg else None,
                "ffmpeg_distribution": "external-user-install" if not args.ffmpeg else "bundled",
                "local_whisper": False, "organizer": True,
                "private_configuration_included": False,
                "dependencies": str(args.dependencies), "python": sys.executable, "node": str(args.node)}
    (work / "build-result.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps(manifest))


def main():
    parser = argparse.ArgumentParser(__doc__)
    parser.add_argument("step", choices=["inventory", "backend", "desktop"])
    parser.add_argument("--output", type=Path, default=ROOT / ".BiliNote-dev/studio-installer-20261008")
    parser.add_argument("--dependencies", type=Path, required=True)
    parser.add_argument("--toolchains", type=Path, required=True)
    parser.add_argument("--cargo-target", type=Path, default=ROOT / ".BiliNote-dev/studio-installer-cargo-target")
    parser.add_argument("--node", type=Path, required=True)
    parser.add_argument("--ffmpeg", type=Path)
    parser.add_argument("--notices", type=Path)
    args = parser.parse_args()
    args.output = args.output.resolve()
    args.cargo_target = args.cargo_target.resolve()
    for path in (args.output, args.cargo_target):
        if not path.is_relative_to(ROOT / ".BiliNote-dev"):
            raise RuntimeError("Build outputs must stay in .BiliNote-dev")
    args.output.mkdir(parents=True, exist_ok=True)
    if args.step == "inventory":
        dependency_inventory(args, args.output)
    else:
        globals()[args.step](args, args.output)


if __name__ == "__main__":
    main()
