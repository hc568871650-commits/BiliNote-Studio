"""Read-only legacy inventory and non-destructive, isolated copy rehearsal.

The frontend export is JSON produced by the application from IndexedDB's
``task-storage`` value. This tool deliberately never opens WebView2 LevelDB.
"""

import argparse
import json
import re
import shutil
from collections import defaultdict
from pathlib import Path
from urllib.parse import unquote, urlsplit


IMAGE = re.compile(r"!\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)]+))", re.I)
KNOWN_SUFFIXES = ("_transcript.json", "_audio.json", "_markdown.status.json", ".status.json", "_markdown.md")


def image_paths(markdown):
    if not isinstance(markdown, str):
        return []
    return [unquote((a or b).strip()) for a, b in IMAGE.findall(markdown)]


def local_image(ref, root):
    parsed = urlsplit(ref)
    if parsed.scheme or parsed.netloc:
        return None
    path = parsed.path.replace("\\", "/")
    if not path.startswith("/static/"):
        return None
    candidate = root.joinpath(*path.lstrip("/").split("/"))
    resolved = candidate.resolve()
    static_root = (root / "static").resolve()
    if not resolved.is_relative_to(static_root):
        return None
    return resolved


def frontend_tasks(path):
    if path is None:
        return None
    data = json.loads(path.read_text(encoding="utf-8-sig"))
    # Zustand serializes {state:{tasks:[...]},version:...}; a plain list is
    # also accepted to make app-side exports straightforward.
    if isinstance(data, dict):
        data = data.get("state", data).get("tasks")
    if not isinstance(data, list) or any(not isinstance(t, dict) for t in data):
        raise ValueError("frontend export must contain a tasks array")
    return data


def inventory(root, export=None):
    root = root.resolve()
    note_dir = root / "note_results"
    if not note_dir.is_dir():
        raise ValueError(f"missing note_results: {note_dir}")
    tasks = frontend_tasks(export)
    frontend = defaultdict(list)
    for task in tasks or []:
        if isinstance(task.get("id"), str) and task["id"]:
            frontend[task["id"]].append(task)
    backend = {}
    unrecognized = []
    all_files = [file for file in sorted(note_dir.iterdir()) if file.is_file()]
    for file in all_files:
        if not file.is_file():
            continue
        if file.suffix == ".json" and not any(file.name.endswith(s) for s in KNOWN_SUFFIXES):
            try:
                result = json.loads(file.read_text(encoding="utf-8-sig"))
                if not isinstance(result, dict) or "markdown" not in result:
                    raise ValueError("not a legacy result")
                backend[file.stem] = result
            except (ValueError, UnicodeError):
                unrecognized.append(file.name)
        elif not any(file.name.endswith(s) for s in KNOWN_SUFFIXES):
            unrecognized.append(file.name)
    image_owners = defaultdict(set)
    entries = []
    for task_id in sorted(set(backend) | set(frontend)):
        result = backend.get(task_id, {})
        records = frontend.get(task_id, [])
        markdowns = []
        if isinstance(result.get("markdown"), str):
            markdowns.append(result["markdown"])
        versions = []
        for record in records:
            value = record.get("markdown")
            if isinstance(value, list):
                for version in value:
                    if isinstance(version, dict):
                        versions.append(version)
                        markdowns.append(version.get("content", ""))
            elif isinstance(value, str):
                markdowns.append(value)
        refs = sorted(set(ref for md in markdowns for ref in image_paths(md)))
        images = []
        missing = []
        external_or_unknown = []
        for ref in refs:
            path = local_image(ref, root)
            if path is None:
                external_or_unknown.append(ref)
            elif path.is_file():
                relative = path.relative_to(root).as_posix()
                images.append(relative)
                image_owners[relative].add(task_id)
            else:
                missing.append(ref)
        files = [f for f in all_files if f.name == task_id + ".json" or any(f.name == task_id + suffix for suffix in KNOWN_SUFFIXES)]
        entries.append({"task_id": task_id, "backend_result": task_id in backend,
                        "frontend_records": len(records), "frontend_versions": len(versions),
                        "files": sorted(f.name for f in files), "images": images,
                        "missing_images": missing, "other_image_refs": external_or_unknown,
                        "backend_only_candidate": task_id in backend and not records and tasks is not None})
    referenced = set(image_owners)
    recognized_files = {name for entry in entries for name in entry["files"]}
    unattached_files = sorted(f.name for f in all_files if f.name not in recognized_files)
    screenshots = root / "static" / "screenshots"
    orphan_images = sorted(p.relative_to(root).as_posix() for p in screenshots.rglob("*") if p.is_file() and p.relative_to(root).as_posix() not in referenced) if screenshots.is_dir() else []
    required = {root / "note_results" / name for entry in entries for name in entry["files"]}
    required |= {root / image for image in referenced}
    ancillary = {}
    for name in ("bili_note.db", "vector_db", "output_frames", "grid_output"):
        source = root / name
        if source.is_file():
            ancillary[name] = {"files": 1, "bytes": source.stat().st_size}
        elif source.is_dir():
            files = [p for p in source.rglob("*") if p.is_file()]
            ancillary[name] = {"files": len(files), "bytes": sum(p.stat().st_size for p in files)}
    return {"root": str(root), "frontend_export_supplied": tasks is not None,
            "frontend_history_unverified": tasks is None,
            "entries": entries, "shared_images": {p: sorted(ids) for p, ids in image_owners.items() if len(ids) > 1},
            "unrecognized_note_files": unrecognized, "unattached_note_files": unattached_files,
            "unreferenced_screenshots": orphan_images,
            "minimum_copy_bytes": sum(p.stat().st_size for p in required if p.is_file()),
            "other_data_inventory": ancillary,
            "backup_note": "Minimum copy bytes excludes orphan files, database, vector data, WebView2 user data, config and working space. Check all of these before a real migration.",
            "note": "Backend-only candidates must not be automatically restored to the visible list. An export does not prove absent frontend data was deleted."}


def rehearse(root, target, report):
    """Copy referenced originals to a fresh isolated directory; no source mutation."""
    root = root.resolve()
    target = target.resolve()
    if target == root or target.is_relative_to(root) or root.is_relative_to(target):
        raise ValueError("rehearsal target must be separate from source")
    if target.exists() and any(target.iterdir()):
        raise ValueError("rehearsal target must be empty")
    target.mkdir(parents=True, exist_ok=True)
    copied = []
    for entry in report["entries"]:
        for name in entry["files"]:
            source = root / "note_results" / name
            if not source.resolve().is_relative_to((root / "note_results").resolve()):
                continue
            dest = target / "note_results" / name
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, dest)
            copied.append(dest)
    for image in sorted({p for e in report["entries"] for p in e["images"]}):
        source = root / image
        dest = target / image
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, dest)
        copied.append(dest)
    return {"copied_files": len(copied), "copied_bytes": sum(p.stat().st_size for p in copied),
            "target": str(target), "missing_images": sum(len(e["missing_images"]) for e in report["entries"]),
            "frontend_history_unverified": report["frontend_history_unverified"],
            "note": "Isolated source-copy rehearsal only; application-format migration and frontend version restoration still require integration verification."}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", required=True, type=Path, help="legacy application data root (read-only)")
    parser.add_argument("--frontend-export", type=Path, help="app-produced task-storage JSON export")
    parser.add_argument("--rehearsal-target", type=Path, help="fresh isolated copy destination")
    parser.add_argument("--report", type=Path, help="optional report JSON file; stdout by default")
    args = parser.parse_args()
    report = inventory(args.root, args.frontend_export)
    if args.rehearsal_target:
        report["rehearsal"] = rehearse(args.root, args.rehearsal_target, report)
    output = json.dumps(report, ensure_ascii=False, indent=2)
    if args.report:
        args.report.write_text(output + "\n", encoding="utf-8")
    else:
        print(output)


if __name__ == "__main__":
    main()
