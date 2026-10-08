# app/routers/note.py
import json
import os
import uuid
import shutil
import threading
from pathlib import Path
from typing import Optional
from urllib.parse import urlparse

from fastapi import APIRouter, HTTPException, BackgroundTasks, UploadFile, File
from fastapi.responses import FileResponse
from pydantic import BaseModel, validator, field_validator, model_validator
from dataclasses import asdict

from app.db.video_task_dao import get_task_by_video
from app.enmus.exception import NoteErrorEnum
from app.enmus.note_enums import DownloadQuality
from app.exceptions.note import NoteError
from app.services.note import NoteGenerator, logger
from app.services import note_storage
from app.services.task_serial_executor import task_serial_executor
from app.utils.response import ResponseWrapper as R
from app.utils.url_parser import extract_video_id, normalize_video_url
from app.validators.video_url_validator import is_supported_video_url
from fastapi import APIRouter, Request, HTTPException
from fastapi.responses import StreamingResponse
import httpx
from app.enmus.task_status_enums import TaskStatus

# from app.services.downloader import download_raw_audio
# from app.services.whisperer import transcribe_audio

router = APIRouter()
_active_tasks = set()
_active_lock = threading.RLock()


class RecordRequest(BaseModel):
    video_id: str
    platform: str


class VideoRequest(BaseModel):
    video_url: str
    platform: str
    quality: DownloadQuality
    screenshot: Optional[bool] = False
    link: Optional[bool] = False
    model_name: str
    provider_id: str
    task_id: Optional[str] = None
    format: Optional[list] = []
    style: str = None
    extras: Optional[str]=None
    video_understanding: Optional[bool] = False
    video_interval: Optional[int] = 0
    grid_size: Optional[list] = []
    # 客户端（如浏览器插件）已经在用户浏览器里抓到字幕，直接传给后端复用，
    # 跳过 download_subtitles 和音频转写。形如：
    #   {"language": "zh", "full_text": "...", "segments": [{"start","end","text"}, ...]}
    prefetched_transcript: Optional[dict] = None

    @model_validator(mode="before")
    @classmethod
    def normalize_url(cls, data):
        # 稍后再看/收藏夹/带追踪参数的 B 站链接先规范化成标准 /video/BVxxx 形式，
        # 后续校验和 yt-dlp 下载拿到的都是干净链接
        if isinstance(data, dict) and data.get("platform") == "bilibili" and data.get("video_url"):
            data["video_url"] = normalize_video_url(str(data["video_url"]))
        return data

    @field_validator("video_url")
    def validate_supported_url(cls, v):
        url = str(v)
        parsed = urlparse(url)
        if parsed.scheme in ("http", "https"):
            # 是网络链接，继续用原有平台校验
            if not is_supported_video_url(url):
                raise NoteError(code=NoteErrorEnum.PLATFORM_NOT_SUPPORTED.code,
                                message=NoteErrorEnum.PLATFORM_NOT_SUPPORTED.message)

        return v


NOTE_OUTPUT_DIR = os.getenv("NOTE_OUTPUT_DIR", "note_results")
UPLOAD_DIR = "uploads"


def save_note_to_file(task_id: str, note):
    return note_storage.save_result(task_id, note)


def _persist_prefetched_transcript(task_id: str, transcript: dict) -> None:
    note_storage.valid_id(task_id)
    """把客户端预取的字幕写到 NoteGenerator 期望的转写缓存文件里。

    NoteGenerator.generate 会优先读 <task_id>_transcript.json，命中即跳过 download_subtitles
    与音频转写流程。要求字段：language(可空)/full_text/segments[{start,end,text}]
    """
    segments = transcript.get("segments") or []
    cleaned_segments = []
    for s in segments:
        text = (s.get("text") or "").strip()
        if not text:
            continue
        cleaned_segments.append({
            "start": float(s.get("start", 0)),
            "end": float(s.get("end", 0)),
            "text": text,
        })
    if not cleaned_segments:
        raise ValueError("prefetched_transcript 没有可用的 segments")

    full_text = transcript.get("full_text") or " ".join(s["text"] for s in cleaned_segments)
    payload = {
        "language": transcript.get("language") or "zh",
        "full_text": full_text,
        "segments": cleaned_segments,
    }

    target = note_storage.cache_path(task_id, "transcript")
    target.parent.mkdir(parents=True, exist_ok=True)
    with open(target, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    logger.info(f"已写入客户端预取字幕缓存: {target} ({len(cleaned_segments)} 段)")


def run_note_task(task_id: str, video_url: str, platform: str, quality: DownloadQuality,
                  link: bool = False, screenshot: bool = False, model_name: str = None, provider_id: str = None,
                  _format: list = None, style: str = None, extras: str = None, video_understanding: bool = False,
                  video_interval=0, grid_size=[]
                  ):

    run_dir = Path("Temp") / "note_jobs" / task_id / uuid.uuid4().hex
    def _execute_note_task():
        generator = NoteGenerator()
        generator.run_dir = run_dir
        return generator.generate(
            video_url=video_url,
            platform=platform,
            quality=quality,
            task_id=task_id,
            model_name=model_name,
            provider_id=provider_id,
            link=link,
            _format=_format,
            style=style,
            extras=extras,
            screenshot=screenshot,
            video_understanding=video_understanding,
            video_interval=video_interval,
            grid_size=grid_size,
        )

    try:
        if not model_name or not provider_id:
            raise ValueError("请选择模型和提供者")
        logger.info(f"任务进入执行队列 (task_id={task_id})")
        note = task_serial_executor.run(_execute_note_task)
        if not note or not note.markdown:
            logger.warning(f"任务 {task_id} 执行失败，保留诊断文件")
            note_storage.set_status(task_id, "FAILED")
            return
        note_storage.save_result(task_id, note, staging=run_dir)
        NoteGenerator()._update_status(task_id, TaskStatus.SUCCESS)
        try:
            from app.services.vector_store import VectorStoreManager
            VectorStoreManager().index_task(task_id)
        except Exception as e:
            logger.warning(f"向量索引失败（不影响笔记）: {e}")
        if run_dir.exists():
            try:
                (run_dir / "cleanup_pending.json").write_text(json.dumps({"task_id": task_id}), encoding="utf-8")
                shutil.rmtree(run_dir)
            except OSError as e:
                logger.warning(f"临时截图清理待重试: {run_dir}: {e}")
    except Exception as e:
        logger.exception("笔记结果保存失败 (task_id=%s)", task_id)
        note_storage.set_status(task_id, "FAILED")
        NoteGenerator()._update_status(task_id, TaskStatus.FAILED, message=str(e))
    finally:
        with _active_lock:
            _active_tasks.discard(task_id)


@router.post('/delete_task')
def delete_task(data: RecordRequest):
    return R.error(msg="旧删除入口已停用；请按任务 ID 先归档，再从归档区彻底删除", code=410)


class ImportNotes(BaseModel):
    tasks: list[dict]


@router.get('/notes')
def list_notes():
    return R.success(note_storage.list_tasks())


@router.post('/notes/import')
def import_notes(data: ImportNotes):
    try:
        imported = []
        for task in data.tasks:
            note_storage.valid_id(task["id"])
            if (note_storage.ROOT / "_tombstones" / f"{task['id']}.json").exists():
                continue
            if task.get("status") not in ("SUCCESS", "FAILED") and not note_storage.get_task(task["id"]):
                with _active_lock:
                    if task["id"] not in _active_tasks:
                        task = dict(task, status="FAILED")
            imported.append(note_storage.save_task(task, import_legacy=True))
        return R.success(imported)
    except (ValueError, FileNotFoundError) as exc:
        return R.error(str(exc), code=400)


@router.get('/notes/{task_id}')
def read_note(task_id: str):
    try:
        task = note_storage.get_task(task_id)
        return R.success(task) if task else R.error("笔记不存在", code=404)
    except ValueError as exc:
        return R.error(str(exc), code=400)


@router.post('/notes/{task_id}/archive')
def archive_note(task_id: str):
    try:
        with _active_lock:
            if task_id in _active_tasks:
                return R.error("正在生成，暂不能归档", code=409)
            return R.success(note_storage.set_archived(task_id, True))
    except (ValueError, FileNotFoundError) as exc:
        return R.error(str(exc), code=409)


@router.post('/notes/{task_id}/restore')
def restore_note(task_id: str):
    try:
        return R.success(note_storage.set_archived(task_id, False))
    except (ValueError, FileNotFoundError) as exc:
        return R.error(str(exc), code=409)


@router.delete('/notes/{task_id}')
def permanently_delete_note(task_id: str):
    try:
        with _active_lock:
            if task_id in _active_tasks:
                return R.error("正在生成，暂不能删除", code=409)
            note_storage.delete_task(task_id)
        return R.success({"task_id": task_id})
    except (ValueError, FileNotFoundError) as exc:
        return R.error(str(exc), code=409)
    except Exception:
        logger.exception("彻底删除失败 task_id=%s", task_id)
        return R.error("删除未完成，请保留记录并重试", code=500)


@router.get('/notes/{task_id}/assets/{relative:path}')
def note_image(task_id: str, relative: str):
    try:
        return FileResponse(note_storage.asset(task_id, relative))
    except (ValueError, FileNotFoundError):
        raise HTTPException(status_code=404, detail="图片不存在")


@router.post("/upload")
async def upload(file: UploadFile = File(...)):
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    file_location = os.path.join(UPLOAD_DIR, file.filename)

    with open(file_location, "wb+") as f:
        f.write(await file.read())

    # 假设你静态目录挂载了 /uploads
    return R.success({"url": f"/uploads/{file.filename}"})


@router.post("/generate_note")
def generate_note(data: VideoRequest, background_tasks: BackgroundTasks):
    try:
        if not data.model_name or not data.provider_id:
            return R.error("请选择模型和提供者", code=400)
        # 就绪门禁：本地转写引擎（fast-whisper / mlx-whisper）必须等模型下载完才能跑视频，
        # 否则任务会卡在首次下载（慢 / OOM / 截断），用户只看到一个静默失败的任务。
        # 客户端已抓好字幕（prefetched_transcript）则不需要转写，跳过检查。
        if not data.prefetched_transcript:
            from app.services.transcriber_config_manager import TranscriberConfigManager
            readiness = TranscriberConfigManager().is_model_ready()
            if not readiness["ready"]:
                logger.warning(f"拒绝 generate_note：{readiness['reason']}")
                return R.error(
                    msg=readiness["reason"],
                    code=300102,
                    data={
                        "reason": "transcriber_model_not_ready",
                        "transcriber_type": readiness["transcriber_type"],
                        "model_size": readiness["model_size"],
                        "downloading": readiness["downloading"],
                    },
                )

        video_id = extract_video_id(data.video_url, data.platform)
        # if not video_id:
        #     raise HTTPException(status_code=400, detail="无法提取视频 ID")
        # existing = get_task_by_video(video_id, data.platform)
        # if existing:
        #     return R.error(
        #         msg='笔记已生成，请勿重复发起',
        #
        #     )
        if data.task_id:
            # 如果传了task_id，说明是重试！
            task_id = data.task_id
            note_storage.valid_id(task_id)
            existing = note_storage.get_task(task_id)
            if existing and existing.get("archived_at"):
                return R.error("请先从归档区恢复笔记再重新生成", code=409)
            logger.info(f"重试模式，复用已有 task_id={task_id}")
        else:
            # 正常新建任务
            task_id = str(uuid.uuid4())

        with _active_lock:
            if task_id in _active_tasks:
                return R.error("此任务正在生成，请等待结束", code=409)
            _active_tasks.add(task_id)

        try:
            note_storage.create_draft(task_id, data.model_dump(mode="json", exclude={"prefetched_transcript"}))
            NoteGenerator()._update_status(task_id, TaskStatus.PENDING)
            if data.prefetched_transcript:
                _persist_prefetched_transcript(task_id, data.prefetched_transcript)
            background_tasks.add_task(run_note_task, task_id, data.video_url, data.platform, data.quality, data.link,
                                      data.screenshot, data.model_name, data.provider_id, data.format, data.style,
                                      data.extras, data.video_understanding, data.video_interval, data.grid_size)
        except Exception:
            with _active_lock:
                _active_tasks.discard(task_id)
            raise
        return R.success({"task_id": task_id})
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/task_status/{task_id}")
def get_task_status(task_id: str):
    try:
        note_storage.valid_id(task_id)
    except ValueError:
        return R.error("任务 ID 不合法", code=400)
    status_path = note_storage.status_path(task_id)
    result_path = note_storage.result_path(task_id)

    # 优先读状态文件
    if os.path.exists(status_path):
        with open(status_path, "r", encoding="utf-8") as f:
            status_content = json.load(f)

        status = status_content.get("status")
        message = status_content.get("message", "")

        if status == TaskStatus.SUCCESS.value:
            stored = note_storage.get_task(task_id)
            if stored:
                return R.success({"status": status, "result": _poll_result(stored),
                                  "message": message, "task_id": task_id})
            # 成功状态的话，继续读取最终笔记内容
            if os.path.exists(result_path):
                with open(result_path, "r", encoding="utf-8") as rf:
                    result_content = json.load(rf)
                return R.success({
                    "status": status,
                    "result": result_content,
                    "message": message,
                    "task_id": task_id
                })
            else:
                # 理论上不会出现，保险处理
                return R.success({
                    "status": TaskStatus.PENDING.value,
                    "message": "任务完成，但结果文件未找到",
                    "task_id": task_id
                })

        if status == TaskStatus.FAILED.value:
            return R.error(message or "任务失败", code=500)

        # 处理中状态
        return R.success({
            "status": status,
            "message": message,
            "task_id": task_id
        })

    # 没有状态文件，但有结果
    stored = note_storage.get_task(task_id)
    if stored and stored.get("status") == "SUCCESS":
        return R.success({"status": TaskStatus.SUCCESS.value,
                          "result": _poll_result(stored), "task_id": task_id})
    if stored and stored.get("status") == "FAILED":
        return R.error("任务失败", code=500)
    if not stored and os.path.exists(result_path):
        with open(result_path, "r", encoding="utf-8") as f:
            result_content = json.load(f)
        return R.success({
            "status": TaskStatus.SUCCESS.value,
            "result": result_content,
            "task_id": task_id
        })

    # 什么都没有，默认PENDING
    return R.success({
        "status": TaskStatus.PENDING.value,
        "message": "任务排队中",
        "task_id": task_id
    })


def _poll_result(task):
    versions = task.get("markdown") or []
    latest = versions[0].get("content", "") if isinstance(versions, list) and versions else ""
    return {"markdown": latest.replace("../images/", "images/"),
            "transcript": task.get("transcript") or {},
            "audio_meta": task.get("audioMeta") or {},
            "resource_base": task.get("resource_base")}


@router.get("/image_proxy")
async def image_proxy(request: Request, url: str):
    headers = {
        "Referer": "https://www.bilibili.com/",
        "User-Agent": request.headers.get("User-Agent", ""),
    }

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(url, headers=headers)

            if resp.status_code != 200:
                raise HTTPException(status_code=resp.status_code, detail="图片获取失败")

            content_type = resp.headers.get("Content-Type", "image/jpeg")
            return StreamingResponse(
                resp.aiter_bytes(),
                media_type=content_type,
                headers={
                    "Cache-Control": "public, max-age=86400",  #  缓存一天
                    "Content-Type": content_type,
                }
            )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
