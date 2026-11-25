"""系统存储治理、低码率回看缓存策略、整库 .zip 备份恢复与轻量检查更新。"""
from __future__ import annotations

import io
import json
import os
import re
import shutil
import sqlite3
import tempfile
import threading
import time
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app.utils.logger import get_logger

logger = get_logger(__name__)

APP_VERSION = os.getenv("APP_VERSION", "0.4.1")
GITHUB_RELEASES_API = "https://api.github.com/repos/hc568871650-commits/BiliNote-Studio/releases/latest"
POLICY_LOCK = threading.RLock()

TEMP_MEDIA_SUFFIXES = frozenset({
    ".mp4", ".mkv", ".mov", ".webm", ".avi", ".m4v", ".flv", ".ts",
    ".mp3", ".m4a", ".wav", ".aac", ".ogg", ".flac", ".opus",
    ".part", ".ytdl", ".temp",
})

SECRET_CONFIG_NAMES = frozenset({
    "cookies.json",
    "secrets.json",
    "secret_store.json",
    "credentials.json",
})

DEFAULT_PLAYBACK_CACHE_POLICY: dict[str, Any] = {
    "enabled": False,
    "retention_days": 7,
    "max_size_mb": 1024,
}


def _data_dir() -> Path:
    return Path(os.getenv("DATA_DIR", "data"))


def _note_results_dir() -> Path:
    from app.services import note_storage

    return Path(note_storage.ROOT)


def _screenshots_dir() -> Path:
    return Path(os.getenv("STATIC_DIR", "static")) / "screenshots"


def _vector_db_dir() -> Path:
    return Path(os.getenv("VECTOR_DB_DIR", "vector_db"))


def _config_dir() -> Path:
    return Path(os.getenv("CONFIG_DIR", "config"))


def _db_file() -> Path:
    env_url = os.getenv("DATABASE_URL", "")
    if env_url.startswith("sqlite:///"):
        raw = env_url[len("sqlite:///"):]
        if raw:
            return Path(raw)
    return Path("bili_note.db")


def _backups_dir() -> Path:
    return Path(os.getenv("BACKUP_DIR", "backups"))


def _policy_path() -> Path:
    return _config_dir() / "playback_cache.json"


def _atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".sys-", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False, indent=2)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def get_playback_cache_policy() -> dict[str, Any]:
    with POLICY_LOCK:
        path = _policy_path()
        result = dict(DEFAULT_PLAYBACK_CACHE_POLICY)
        if path.is_file() and not path.is_symlink():
            try:
                raw = json.loads(path.read_text(encoding="utf-8"))
                if isinstance(raw, dict):
                    result["enabled"] = bool(raw.get("enabled", False))
                    days = int(raw.get("retention_days", 7))
                    result["retention_days"] = days if days in (0, 7, 30, 90) else 7
                    mb = int(raw.get("max_size_mb", 1024))
                    result["max_size_mb"] = max(128, min(20480, mb))
            except (OSError, ValueError, TypeError):
                pass
        return result


def update_playback_cache_policy(payload: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("回看缓存配置必须是对象")
    with POLICY_LOCK:
        current = get_playback_cache_policy()
        if "enabled" in payload:
            current["enabled"] = bool(payload["enabled"])
        if "retention_days" in payload:
            days = int(payload["retention_days"])
            if days not in (0, 7, 30, 90):
                raise ValueError("保留天数须为 0 / 7 / 30 / 90")
            current["retention_days"] = days
        if "max_size_mb" in payload:
            mb = int(payload["max_size_mb"])
            if not 128 <= mb <= 20480:
                raise ValueError("缓存上限须在 128 MB 到 20480 MB 之间")
            current["max_size_mb"] = mb
        _atomic_write_json(_policy_path(), current)
        return current


def _iter_temp_media_files(root: Path) -> list[Path]:
    """仅枚举临时下载音视频文件及拼接分界 .clips.json，严格排除 uploads 用户文档、普通 json 元数据与数据库。"""
    if not root.exists():
        return []
    found: list[Path] = []
    for item in root.rglob("*"):
        if item.is_symlink() or not item.is_file():
            continue
        rel_parts = [p.lower() for p in item.relative_to(root).parts]
        if "uploads" in rel_parts:
            continue
        if item.suffix.lower() in TEMP_MEDIA_SUFFIXES or item.name.lower().endswith(".clips.json"):
            found.append(item)
    return found


def enforce_playback_cache_policy() -> dict[str, int]:
    """按保留天数与最大容量上限滚动清理临时音视频缓存。"""
    policy = get_playback_cache_policy()
    files = _iter_temp_media_files(_data_dir())
    if not files:
        return {"deleted_files": 0, "freed_bytes": 0}

    now_ts = time.time()
    retention_days = int(policy.get("retention_days") or 0)
    max_bytes = int(policy.get("max_size_mb") or 1024) * 1024 * 1024

    entries: list[tuple[float, int, Path]] = []
    for path in files:
        try:
            st = path.stat()
            entries.append((st.st_mtime, st.st_size, path))
        except OSError:
            continue

    deleted_files = 0
    freed_bytes = 0
    remaining: list[tuple[float, int, Path]] = []

    if retention_days > 0:
        cutoff = now_ts - retention_days * 86400
        for mtime, size, path in entries:
            if mtime < cutoff:
                try:
                    path.unlink(missing_ok=True)
                    deleted_files += 1
                    freed_bytes += size
                except OSError:
                    remaining.append((mtime, size, path))
            else:
                remaining.append((mtime, size, path))
    else:
        remaining = entries

    total_size = sum(size for _, size, _ in remaining)
    if total_size > max_bytes:
        # 最旧文件优先淘汰
        remaining.sort(key=lambda row: row[0])
        for _, size, path in remaining:
            if total_size <= max_bytes:
                break
            try:
                path.unlink(missing_ok=True)
                deleted_files += 1
                freed_bytes += size
                total_size -= size
            except OSError:
                continue

    return {"deleted_files": deleted_files, "freed_bytes": freed_bytes}


def _dir_stats(path: Path) -> tuple[int, int]:
    if not path.exists():
        return 0, 0
    total_bytes = 0
    file_count = 0
    for item in path.rglob("*"):
        if item.is_symlink() or not item.is_file():
            continue
        try:
            total_bytes += item.stat().st_size
            file_count += 1
        except OSError:
            continue
    return total_bytes, file_count


def get_storage_summary() -> dict[str, Any]:
    data_root = _data_dir()
    temp_files = _iter_temp_media_files(data_root)
    temp_bytes = 0
    for f in temp_files:
        try:
            temp_bytes += f.stat().st_size
        except OSError:
            continue

    notes_bytes, notes_files = _dir_stats(_note_results_dir())
    shot_bytes, shot_files = _dir_stats(_screenshots_dir())
    vec_bytes, vec_files = _dir_stats(_vector_db_dir())

    db_path = _db_file()
    db_bytes = 0
    db_files = 0
    for suffix in ("", "-wal", "-shm"):
        cand = Path(f"{db_path}{suffix}")
        if cand.is_file() and not cand.is_symlink():
            try:
                db_bytes += cand.stat().st_size
                db_files += 1
            except OSError:
                continue

    categories = [
        {"id": "temp_media", "label": "临时音视频缓存", "bytes": temp_bytes, "files": len(temp_files), "clearable": True},
        {"id": "note_results", "label": "笔记正文与学习记录", "bytes": notes_bytes, "files": notes_files, "clearable": False},
        {"id": "screenshots", "label": "截图与本地化配图", "bytes": shot_bytes, "files": shot_files, "clearable": False},
        {"id": "vector_db", "label": "语义检索索引", "bytes": vec_bytes, "files": vec_files, "clearable": False},
        {"id": "database", "label": "本地数据库", "bytes": db_bytes, "files": db_files, "clearable": False},
    ]
    return {
        "total_bytes": sum(c["bytes"] for c in categories),
        "categories": categories,
        "playback_cache": get_playback_cache_policy(),
    }


def clear_temp_media_cache() -> dict[str, Any]:
    """清理 data 目录下的临时音视频缓存，严格保留笔记正文、截图、学习状态、json 配置与数据库。"""
    files = _iter_temp_media_files(_data_dir())
    deleted_files = 0
    freed_bytes = 0
    for path in files:
        try:
            size = path.stat().st_size
            path.unlink(missing_ok=True)
            deleted_files += 1
            freed_bytes += size
        except OSError:
            continue
    return {
        "deleted_files": deleted_files,
        "freed_bytes": freed_bytes,
        "storage": get_storage_summary(),
    }


def _snapshot_sqlite(src_db: Path, dst_db: Path, *, strip_secrets: bool) -> None:
    src_conn = sqlite3.connect(str(src_db))
    try:
        dst_conn = sqlite3.connect(str(dst_db))
        try:
            src_conn.backup(dst_conn)
            if strip_secrets:
                try:
                    cols = [row[1] for row in dst_conn.execute("PRAGMA table_info(providers)").fetchall()]
                    if "api_key" in cols:
                        dst_conn.execute("UPDATE providers SET api_key = ''")
                        dst_conn.commit()
                except sqlite3.Error:
                    pass
        finally:
            dst_conn.close()
    finally:
        src_conn.close()


def _is_secret_config(rel_name: str) -> bool:
    lower = rel_name.lower()
    if lower in SECRET_CONFIG_NAMES:
        return True
    return "cookie" in lower or "secret" in lower or "credential" in lower


def _add_dir_to_zip(zf: zipfile.ZipFile, src_dir: Path, arc_prefix: str, *, skip_secret_config: bool = False) -> int:
    if not src_dir.exists():
        return 0
    added = 0
    for item in sorted(src_dir.rglob("*")):
        if item.is_symlink() or not item.is_file():
            continue
        rel = item.relative_to(src_dir).as_posix()
        if skip_secret_config and _is_secret_config(item.name):
            continue
        zf.write(item, f"{arc_prefix}/{rel}")
        added += 1
    return added


def create_library_backup_zip(*, include_secrets: bool = False, dest_path: Path | None = None) -> Path:
    """导出一致性整库 .zip 备份，默认排除明文 API Key 与 Cookie 凭据。"""
    if dest_path is None:
        fd, raw_path = tempfile.mkstemp(prefix="bilinote-backup-", suffix=".zip")
        os.close(fd)
        zip_path = Path(raw_path)
    else:
        dest_path.parent.mkdir(parents=True, exist_ok=True)
        zip_path = dest_path

    counts: dict[str, int] = {}
    with tempfile.TemporaryDirectory(prefix="bilinote-db-snap-") as snap_dir:
        with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
            db_path = _db_file()
            if db_path.is_file() and not db_path.is_symlink():
                snap_db = Path(snap_dir) / "bili_note.db"
                _snapshot_sqlite(db_path, snap_db, strip_secrets=(not include_secrets))
                zf.write(snap_db, "bili_note.db")
                counts["database"] = 1

            counts["note_results"] = _add_dir_to_zip(zf, _note_results_dir(), "note_results")
            counts["screenshots"] = _add_dir_to_zip(zf, _screenshots_dir(), "static/screenshots")
            counts["config"] = _add_dir_to_zip(zf, _config_dir(), "config", skip_secret_config=(not include_secrets))

            meta_added = 0
            for meta_name in ("note_folders.json", "note_library.json"):
                meta_file = _data_dir() / meta_name
                if meta_file.is_file() and not meta_file.is_symlink():
                    zf.write(meta_file, f"data/{meta_name}")
                    meta_added += 1
            counts["metadata"] = meta_added

            manifest = {
                "schema_version": 1,
                "app": "BiliNote Studio",
                "app_version": APP_VERSION,
                "created_at": datetime.now(timezone.utc).isoformat(),
                "include_secrets": bool(include_secrets),
                "counts": counts,
            }
            zf.writestr("backup_manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))
    return zip_path


def _validate_zip_member(info: zipfile.ZipInfo) -> str:
    name = info.filename.replace("\\", "/")
    if not name or name.startswith("/") or re.match(r"^[a-zA-Z]:", name):
        raise ValueError(f"备份包包含非法路径：{name}")
    parts = [p for p in name.split("/") if p]
    if ".." in parts:
        raise ValueError(f"备份包包含越界路径：{name}")
    # 检查 Unix 符号链接标记
    if (info.external_attr >> 16) & 0o170000 == 0o120000:
        raise ValueError(f"备份包不允许包含符号链接：{name}")
    return name


def restore_library_backup_zip(zip_bytes: bytes) -> dict[str, Any]:
    """校验结构、强制自动预备份后再安全恢复整库 .zip 备份。"""
    if not zip_bytes:
        raise ValueError("备份文件为空")
    if len(zip_bytes) > 512 * 1024 * 1024:
        raise ValueError("备份文件超过 512 MB 上限")

    try:
        zf = zipfile.ZipFile(io.BytesIO(zip_bytes), "r")
    except zipfile.BadZipFile as exc:
        raise ValueError("无效的 .zip 备份文件") from exc

    with zf:
        names: list[str] = []
        for info in zf.infolist():
            names.append(_validate_zip_member(info))
        if "backup_manifest.json" not in names:
            raise ValueError("缺少 backup_manifest.json，不是有效的 BiliNote Studio 备份包")
        try:
            manifest = json.loads(zf.read("backup_manifest.json").decode("utf-8"))
        except (ValueError, UnicodeDecodeError) as exc:
            raise ValueError("backup_manifest.json 格式损坏") from exc
        if not isinstance(manifest, dict) or manifest.get("schema_version") != 1:
            raise ValueError("不支持的备份包版本")

        has_payload = any(
            n == "bili_note.db" or n.startswith("note_results/") or n.startswith("data/") or n.startswith("config/")
            for n in names
        )
        if not has_payload:
            raise ValueError("备份包中没有可恢复的数据内容")

        # 恢复前强制自动预备份当前库
        stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
        pre_backup = _backups_dir() / f"pre-restore-{stamp}.zip"
        create_library_backup_zip(include_secrets=True, dest_path=pre_backup)

        restored_files = 0
        with tempfile.TemporaryDirectory(prefix="bilinote-restore-") as tmp_dir:
            tmp_root = Path(tmp_dir)
            for info in zf.infolist():
                if info.is_dir():
                    continue
                safe_name = _validate_zip_member(info)
                if safe_name == "backup_manifest.json":
                    continue
                dest = (tmp_root / safe_name).resolve()
                if not dest.is_relative_to(tmp_root.resolve()):
                    raise ValueError(f"非法解压目标：{safe_name}")
                dest.parent.mkdir(parents=True, exist_ok=True)
                with zf.open(info, "r") as src, open(dest, "wb") as out:
                    shutil.copyfileobj(src, out)

            # 1. 恢复 note_results / screenshots / data 元数据 / config
            mapping = [
                (tmp_root / "note_results", _note_results_dir(), False),
                (tmp_root / "static" / "screenshots", _screenshots_dir(), False),
                (tmp_root / "config", _config_dir(), not bool(manifest.get("include_secrets"))),
            ]
            for src_dir, target_dir, protect_secrets in mapping:
                if not src_dir.exists():
                    continue
                target_dir.mkdir(parents=True, exist_ok=True)
                for src_file in src_dir.rglob("*"):
                    if not src_file.is_file():
                        continue
                    if protect_secrets and _is_secret_config(src_file.name):
                        continue
                    rel = src_file.relative_to(src_dir)
                    dst_file = target_dir / rel
                    dst_file.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(src_file, dst_file)
                    restored_files += 1

            for meta_name in ("note_folders.json", "note_library.json"):
                src_meta = tmp_root / "data" / meta_name
                if src_meta.is_file():
                    dst_meta = _data_dir() / meta_name
                    dst_meta.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(src_meta, dst_meta)
                    restored_files += 1

            # 2. 恢复 SQLite 数据库（如备份不含凭据，尽量保留本地已有同 id 服务商的 api_key）
            src_db = tmp_root / "bili_note.db"
            if src_db.is_file():
                target_db = _db_file()
                preserved_keys: dict[str, str] = {}
                if not manifest.get("include_secrets") and target_db.is_file():
                    try:
                        conn = sqlite3.connect(str(target_db))
                        try:
                            for row in conn.execute("SELECT id, api_key FROM providers"):
                                if row[0] and row[1]:
                                    preserved_keys[str(row[0])] = str(row[1])
                        finally:
                            conn.close()
                    except sqlite3.Error:
                        preserved_keys = {}

                target_db.parent.mkdir(parents=True, exist_ok=True)
                _snapshot_sqlite(src_db, target_db, strip_secrets=False)
                if preserved_keys:
                    try:
                        conn = sqlite3.connect(str(target_db))
                        try:
                            for pid, key_val in preserved_keys.items():
                                conn.execute(
                                    "UPDATE providers SET api_key = ? WHERE id = ? AND (api_key IS NULL OR api_key = '')",
                                    (key_val, pid),
                                )
                            conn.commit()
                        finally:
                            conn.close()
                    except sqlite3.Error:
                        pass
                restored_files += 1

        return {
            "restored_files": restored_files,
            "pre_backup_path": str(pre_backup),
            "backup_created_at": manifest.get("created_at"),
            "include_secrets": bool(manifest.get("include_secrets")),
        }


def _parse_semver(version_text: str) -> tuple[int, int, int, str]:
    clean = (version_text or "").strip().lstrip("vV")
    main, _, pre = clean.partition("-")
    parts = main.split(".")
    nums: list[int] = []
    for p in parts[:3]:
        m = re.match(r"^(\d+)", p.strip())
        nums.append(int(m.group(1)) if m else 0)
    while len(nums) < 3:
        nums.append(0)
    return (nums[0], nums[1], nums[2], pre)


def is_newer_version(latest: str, current: str) -> bool:
    l_maj, l_min, l_pat, l_pre = _parse_semver(latest)
    c_maj, c_min, c_pat, c_pre = _parse_semver(current)
    if (l_maj, l_min, l_pat) != (c_maj, c_min, c_pat):
        return (l_maj, l_min, l_pat) > (c_maj, c_min, c_pat)
    # 正式版高于同号预发布版
    if not l_pre and c_pre:
        return True
    if l_pre and not c_pre:
        return False
    return l_pre > c_pre


def check_latest_release(*, current_version: str | None = None, timeout: float = 8.0) -> dict[str, Any]:
    """按需只读请求 GitHub Releases latest 接口对比版本，绝不静默下载覆盖。"""
    import httpx
    from app.services.proxy_config_manager import ProxyConfigManager

    curr = (current_version or APP_VERSION).strip() or "0.4.1"
    proxy = ProxyConfigManager().get_proxy_url()
    client_kwargs: dict[str, Any] = {
        "timeout": timeout,
        "follow_redirects": True,
        "headers": {
            "Accept": "application/vnd.github+json",
            "User-Agent": f"BiliNote-Studio/{curr}",
        },
    }
    if proxy:
        client_kwargs["proxy"] = proxy

    try:
        with httpx.Client(**client_kwargs) as client:
            resp = client.get(GITHUB_RELEASES_API)
            if resp.status_code == 404:
                return {
                    "checked": True,
                    "has_update": False,
                    "current_version": curr,
                    "latest_version": curr,
                    "release_url": "https://github.com/hc568871650-commits/BiliNote-Studio/releases",
                    "summary": "暂未检测到公开发布版本。",
                    "published_at": None,
                }
            resp.raise_for_status()
            data = resp.json()
    except Exception as exc:
        raise RuntimeError(f"检查更新失败：{type(exc).__name__}，请检查网络或代理设置后重试") from exc

    latest = str(data.get("tag_name") or data.get("name") or "").strip().lstrip("vV")
    release_url = str(data.get("html_url") or "https://github.com/hc568871650-commits/BiliNote-Studio/releases")
    body = str(data.get("body") or "").strip()
    summary = body[:600] + ("…" if len(body) > 600 else "")
    return {
        "checked": True,
        "has_update": bool(latest) and is_newer_version(latest, curr),
        "current_version": curr,
        "latest_version": latest or curr,
        "release_url": release_url,
        "summary": summary,
        "published_at": data.get("published_at"),
    }
