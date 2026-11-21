"""支持平台到下载器实例的懒加载映射。

避免在导入路由或服务时提前加载 yt_dlp 与各平台 Cookie/请求头初始化逻辑，
仅在首次请求对应平台下载器时按需实例化并缓存。
"""

from __future__ import annotations

from collections.abc import Mapping
import importlib
import threading
from typing import Any


_PLATFORM_FACTORIES: dict[str, tuple[str, str]] = {
    "youtube": ("app.downloaders.youtube_downloader", "YoutubeDownloader"),
    "bilibili": ("app.downloaders.bilibili_downloader", "BilibiliDownloader"),
    "kuaishou": ("app.downloaders.kuaishou_downloader", "KuaiShouDownloader"),
    "local": ("app.downloaders.local_downloader", "LocalDownloader"),
}


class _LazyPlatformMap(Mapping[str, Any]):
    def __init__(self, factories: dict[str, tuple[str, str]]):
        self._factories = dict(factories)
        self._instances: dict[str, Any] = {}
        self._lock = threading.RLock()

    def _load(self, key: str) -> Any:
        if key in self._instances:
            return self._instances[key]
        with self._lock:
            if key in self._instances:
                return self._instances[key]
            module_name, cls_name = self._factories[key]
            module = importlib.import_module(module_name)
            instance = getattr(module, cls_name)()
            self._instances[key] = instance
            return instance

    def __getitem__(self, key: str) -> Any:
        if key not in self._factories:
            raise KeyError(key)
        return self._load(key)

    def get(self, key: str, default: Any = None) -> Any:
        if key not in self._factories:
            return default
        return self._load(key)

    def __contains__(self, key: object) -> bool:
        return key in self._factories

    def __iter__(self):
        return iter(self._factories)

    def __len__(self) -> int:
        return len(self._factories)


SUPPORT_PLATFORM_MAP = _LazyPlatformMap(_PLATFORM_FACTORIES)
