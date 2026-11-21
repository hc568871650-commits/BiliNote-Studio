"""重型可选依赖的统一懒加载辅助工具。

目标：
1. 避免在 FastAPI 应用冷启动（create_app / 路由注册）阶段同步导入 yt_dlp、chromadb、
   langgraph、faster_whisper、openai、PIL、cv2 等重型三方库；
2. 当用户环境缺失某个可选依赖（如快速版或未安装本地 Whisper）时，返回清晰中文提示，
   而不是抛出晦涩的 500 ImportError。
"""

from __future__ import annotations

import importlib
from types import ModuleType
from typing import Any


def lazy_import(module_name: str, feature_hint: str = "") -> ModuleType:
    """按需导入模块；缺失时抛出包含中文引导的 RuntimeError。"""
    try:
        return importlib.import_module(module_name)
    except ImportError as exc:
        scope = f"「{feature_hint}」" if feature_hint else "当前功能"
        raise RuntimeError(
            f"{scope}需要可选依赖 `{module_name}`，但当前运行环境未安装。"
            f"请安装对应依赖后重试，或切换为不依赖该组件的模式。"
        ) from exc


def lazy_attr(module_name: str, attr_name: str, feature_hint: str = "") -> Any:
    """按需导入模块并返回其指定属性。"""
    module = lazy_import(module_name, feature_hint=feature_hint)
    try:
        return getattr(module, attr_name)
    except AttributeError as exc:
        scope = f"「{feature_hint}」" if feature_hint else "当前功能"
        raise RuntimeError(
            f"{scope}依赖的 `{module_name}.{attr_name}` 在当前版本中不可用，请检查依赖版本。"
        ) from exc
