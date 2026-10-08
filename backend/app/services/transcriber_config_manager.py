import json
import os
from pathlib import Path
from typing import Optional, Dict, Any


class TranscriberConfigManager:
    """管理转写器配置，存储在 JSON 文件中，支持前端动态修改。"""

    def __init__(self, filepath: str = "config/transcriber.json"):
        self.path = Path(filepath)
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def _read(self) -> Dict[str, Any]:
        if not self.path.exists():
            return {}
        try:
            with self.path.open("r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return {}

    def _write(self, data: Dict[str, Any]):
        temporary = self.path.with_suffix(self.path.suffix + ".tmp")
        with temporary.open("w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        temporary.replace(self.path)

    def get_config(self) -> Dict[str, Any]:
        """获取当前转写器配置，fallback 到环境变量默认值。

        whisper 默认 size 从 'medium' (~1.5GB) 改为 'tiny' (~75MB)：
        新装用户没主动设置时不应该被首次下载卡住。想要更高精度可在「音频转写配置」
        页主动切换。
        """
        data = self._read()
        return {
            "mlx_whisper_model_size": data.get("mlx_whisper_model_size") or data.get("whisper_model_size") or os.getenv("WHISPER_MODEL_SIZE", "tiny"),
            "groq_model": data.get("groq_model") or os.getenv("GROQ_TRANSCRIBER_MODEL") or "whisper-large-v3-turbo",
            "transcriber_type": data.get(
                "transcriber_type",
                os.getenv("TRANSCRIBER_TYPE", "fast-whisper"),
            ),
            "whisper_model_size": data.get(
                "whisper_model_size",
                os.getenv("WHISPER_MODEL_SIZE", "tiny"),
            ),
        }

    def update_config(
        self,
        transcriber_type: str,
        whisper_model_size: Optional[str] = None,
        groq_model: Optional[str] = None,
        mlx_whisper_model_size: Optional[str] = None,
    ) -> Dict[str, Any]:
        """更新转写器配置并持久化。"""
        from app.edition import require_local_transcriber
        require_local_transcriber(transcriber_type)
        data = self._read()
        if transcriber_type not in {"fast-whisper", "mlx-whisper", "groq", "bcut", "kuaishou"}:
            raise ValueError("未知的转写引擎")
        # Freeze the legacy shared value before either engine changes it.
        data.setdefault("mlx_whisper_model_size", self.get_config()["mlx_whisper_model_size"])
        data["transcriber_type"] = transcriber_type
        if whisper_model_size is not None:
            if transcriber_type == "mlx-whisper":
                data["mlx_whisper_model_size"] = whisper_model_size
            else:
                data["whisper_model_size"] = whisper_model_size
        if mlx_whisper_model_size is not None:
            data["mlx_whisper_model_size"] = mlx_whisper_model_size
        if groq_model is not None:
            if not groq_model.strip() or len(groq_model.strip()) > 200:
                raise ValueError("请填写有效的 Groq 转写模型名称")
            data["groq_model"] = groq_model.strip()
        self._write(data)
        return self.get_config()

    def get_transcriber_type(self) -> str:
        return self.get_config()["transcriber_type"]

    def get_whisper_model_size(self) -> str:
        cfg = self.get_config()
        return cfg["mlx_whisper_model_size" if cfg["transcriber_type"] == "mlx-whisper" else "whisper_model_size"]

    def is_model_ready(self) -> Dict[str, Any]:
        """当前转写器是否就绪可用。

        返回 {ready, transcriber_type, model_size, downloading, reason}：
          - 在线引擎 (groq/bcut/kuaishou)：永远 ready（不需要本地模型）
          - fast-whisper：检查 whisper-{size}/model.bin 落盘
          - mlx-whisper：检查 {repo_id}/config.json 落盘
        给 /generate_note 入口做「开始视频前先确认模型下载好」的门禁用。
        """
        cfg = self.get_config()
        ttype = cfg["transcriber_type"]
        size = self.get_whisper_model_size()
        result = {
            "ready": True,
            "transcriber_type": ttype,
            "model_size": size,
            "downloading": False,
            "reason": "",
        }
        if ttype not in ("fast-whisper", "mlx-whisper"):
            return result  # 在线引擎无需本地模型

        # 延迟 import 避免与 routers.config 的循环依赖；只取纯函数，不触发路由副作用
        try:
            from app.routers.config import (
                _check_whisper_model_exists,
                _check_mlx_whisper_model_exists,
                _downloading,
            )
        except Exception as e:
            # 拿不到检查函数时保守放行，不要把用户卡死
            result["reason"] = f"无法检查模型状态: {e}"
            return result

        if ttype == "fast-whisper":
            downloaded = _check_whisper_model_exists(size, "whisper")
            downloading = _downloading.get(size) == "downloading"
        else:  # mlx-whisper
            downloaded = _check_mlx_whisper_model_exists(size)
            downloading = _downloading.get(f"mlx-{size}") == "downloading"

        result["downloading"] = downloading
        if downloaded:
            return result
        result["ready"] = False
        result["reason"] = (
            f"转写模型 {ttype} / {size} 尚未下载就绪"
            + ("，正在下载中，请稍候" if downloading else "，请先在「设置 → 音频转写配置」页下载")
        )
        return result
