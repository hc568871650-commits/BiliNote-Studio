# app/routers/note.py
import json
import hashlib
import os
import uuid
import shutil
import threading
from pathlib import Path
from typing import Optional, Literal
from urllib.parse import urlparse

from fastapi import APIRouter, HTTPException, BackgroundTasks, UploadFile, File
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field, validator, field_validator, model_validator
from app.models.generation_options import GenerationOptions
from dataclasses import asdict

from app.db.video_task_dao import get_task_by_video
from app.enmus.exception import NoteErrorEnum
from app.enmus.note_enums import DownloadQuality
from app.exceptions.note import NoteError
from app.services.note import NoteGenerator, logger, _read_transcript_cache
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
_active_requests = {}
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
    # Preserve this attempt ID across transport retries; renew for explicit regeneration.
    request_id: Optional[str] = None
    format: Optional[list] = []
    style: str = None
    extras: Optional[str]=None
    video_understanding: Optional[bool] = False
    video_interval: Optional[int] = 0
    grid_size: Optional[list] = []
    frame_mode: Literal['dynamic', 'fixed'] = 'dynamic'
    generation_options: GenerationOptions = Field(default_factory=GenerationOptions)
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
                  video_interval=0, grid_size=[], frame_mode='dynamic', generation_options=None, request_id=None
                  ):

    run_dir = Path("Temp") / "note_jobs" / task_id / uuid.uuid4().hex
    recorder = None
    def _execute_note_task():
        NoteGenerator._update_status(task_id, TaskStatus.PARSING, message="初始化处理器与解析来源")
        generator = NoteGenerator()
        generator.run_dir = run_dir
        generator.generation_recorder = recorder
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
            frame_mode=frame_mode,
            generation_options=generation_options,
            request_id=request_id,
        )

    try:
        if generation_options is not None:
            from app.services.generation_usage import GenerationUsageRecorder
            recorder = GenerationUsageRecorder(task_id, generation_options, request_id=request_id,
                                                model=model_name, provider_id=provider_id)
        if not model_name or not provider_id:
            raise ValueError("请选择模型和提供者")
        logger.info(f"任务进入执行队列 (task_id={task_id})")
        note = task_serial_executor.run(_execute_note_task)
        if not note or not note.markdown:
            if recorder and recorder.data['status'] == 'running':
                recorder.finish('failed')
            logger.warning(f"任务 {task_id} 执行失败，保留诊断文件")
            note_storage.set_status(task_id, "FAILED")
            return
        saved = note_storage.save_result(task_id, note, staging=run_dir)
        if recorder:
            versions = saved.get('markdown') or []
            if versions and isinstance(versions[0], dict):
                recorder.bind_version(versions[0].get('ver_id'))
            recorder.finish('succeeded')
        NoteGenerator._update_status(task_id, TaskStatus.SUCCESS)
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
        if recorder:
            recorder.finish('failed', e)
        logger.exception("笔记结果保存失败 (task_id=%s)", task_id)
        note_storage.set_status(task_id, "FAILED")
        NoteGenerator._update_status(task_id, TaskStatus.FAILED, message=str(e))
    finally:
        with _active_lock:
            _active_tasks.discard(task_id)
            _active_requests.pop(task_id, None)


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


@router.get('/notes/{task_id}/generation-runs')
def generation_runs(task_id: str):
    from app.services.generation_usage import list_generation_runs
    try:
        return R.success(list_generation_runs(task_id))
    except ValueError as exc:
        return R.error(str(exc), code=400)


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
        task_id = data.task_id or str(uuid.uuid4())
        note_storage.valid_id(task_id)
        payload = data.model_dump(mode="json", exclude={"task_id", "request_id"})
        fingerprint = hashlib.sha256(json.dumps(payload, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()
        # Read-only admission checks also run before model readiness: a reconnect must
        # remain readable when settings change while a previously admitted job runs.
        with _active_lock:
            if task_id in _active_tasks:
                if _active_requests.get(task_id) == (data.request_id, fingerprint):
                    return R.success({"task_id": task_id, "reused": True})
                return R.error("此任务正在生成，不能更改本次请求", code=409)
            existing = note_storage.get_task(task_id)
            if existing and existing.get("archived_at"):
                return R.error("请先从归档区恢复笔记再重新生成", code=409)
            admission_path = note_storage.status_path(task_id).with_suffix(".admission.json")
            previous = json.loads(admission_path.read_text(encoding="utf-8")) if admission_path.exists() else {}
            if existing and existing.get("status") in ("SUCCESS", "FAILED"):
                if (not data.request_id and existing.get("status") == "SUCCESS") or (data.request_id and data.request_id == previous.get("request_id")):
                    if data.request_id and fingerprint != previous.get("fingerprint"):
                        return R.error("本次请求已完成；重新生成请使用新的请求 ID", code=409)
                    return R.success({"task_id": task_id, "status": existing["status"], "reused": True})
        # 就绪门禁：本地转写引擎（fast-whisper / mlx-whisper）必须等模型下载完才能跑视频，
        # 否则任务会卡在首次下载（慢 / OOM / 截断），用户只看到一个静默失败的任务。
        # 客户端已抓好字幕（prefetched_transcript）则不需要转写，跳过检查。
        cached_transcript_ready = False
        if existing:
            try:
                _read_transcript_cache(note_storage.cache_path(task_id, "transcript"))
                cached_transcript_ready = True
            except (OSError, ValueError, TypeError, KeyError, AttributeError):
                pass
        if not data.prefetched_transcript and not cached_transcript_ready:
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

        with _active_lock:
            if task_id in _active_tasks:
                if _active_requests.get(task_id) == (data.request_id, fingerprint):
                    return R.success({"task_id": task_id, "reused": True})
                return R.error("此任务正在生成，不能更改本次请求", code=409)
            # Another worker can finish during the readiness check.
            existing = note_storage.get_task(task_id)
            previous = json.loads(admission_path.read_text(encoding="utf-8")) if admission_path.exists() else {}
            if existing and existing.get("archived_at"):
                return R.error("请先从归档区恢复笔记再重新生成", code=409)
            if existing and existing.get("status") in ("SUCCESS", "FAILED") and ((not data.request_id and existing.get("status") == "SUCCESS") or (data.request_id and data.request_id == previous.get("request_id"))):
                if data.request_id and fingerprint != previous.get("fingerprint"):
                    return R.error("本次请求已完成；重新生成请使用新的请求 ID", code=409)
                return R.success({"task_id": task_id, "status": existing["status"], "reused": True})
            _active_tasks.add(task_id)
            _active_requests[task_id] = (data.request_id, fingerprint)

        try:
            form_data = data.model_dump(mode="json", exclude={"prefetched_transcript"})
            note_storage.create_draft(task_id, form_data)
            if existing:
                # Merge metadata only; keep every prior markdown version and asset.
                note_storage.save_task({"id": task_id, "status": "PENDING", "formData": form_data})
            NoteGenerator._update_status(task_id, TaskStatus.PENDING, message="任务已接收，等待执行")
            admission_path = note_storage.status_path(task_id).with_suffix(".admission.json")
            admission_path.parent.mkdir(parents=True, exist_ok=True)
            temp = admission_path.with_suffix(".tmp")
            temp.write_text(json.dumps({"request_id": data.request_id, "fingerprint": fingerprint}), encoding="utf-8")
            temp.replace(admission_path)
            if data.prefetched_transcript:
                _persist_prefetched_transcript(task_id, data.prefetched_transcript)
            background_tasks.add_task(run_note_task, task_id, data.video_url, data.platform, data.quality, data.link,
                                      data.screenshot, data.model_name, data.provider_id, data.format, data.style,
                                      data.extras, data.video_understanding, data.video_interval, data.grid_size, data.frame_mode,
                                      getattr(data, 'generation_options', None), data.request_id)
        except Exception:
            with _active_lock:
                _active_tasks.discard(task_id)
                _active_requests.pop(task_id, None)
            note_storage.set_status(task_id, "FAILED")
            NoteGenerator._update_status(task_id, TaskStatus.FAILED, message="任务入队失败，请重试")
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
    stored = note_storage.get_task(task_id)
    admission_path = status_path.with_suffix(".admission.json")
    admission = json.loads(admission_path.read_text(encoding="utf-8")) if admission_path.exists() else {}
    request_id = admission.get("request_id") if admission else (stored or {}).get("formData", {}).get("request_id")
    status_content = {}

    def status_response(payload):
        return R.success({"last_active_status": status_content.get("last_active_status") or (stored or {}).get("last_active_status"),
                          "started_at": status_content.get("started_at") or (stored or {}).get("started_at"),
                          "finished_at": status_content.get("finished_at") or (stored or {}).get("finished_at"),
                          "status_updated_at": status_content.get("status_updated_at") or (stored or {}).get("status_updated_at"),
                          "audio_meta": {"title": ((stored or {}).get("audioMeta") or {}).get("title", "")},
                          **payload, "request_id": request_id})

    # 优先读状态文件
    if os.path.exists(status_path):
        with open(status_path, "r", encoding="utf-8") as f:
            status_content = json.load(f)

        status = status_content.get("status") or "UNKNOWN"
        message = status_content.get("message", "")

        if status == TaskStatus.SUCCESS.value:
            stored = note_storage.get_task(task_id)
            if stored:
                return status_response({"status": status, "result": _poll_result(stored),
                                  "message": message, "task_id": task_id})
            # 成功状态的话，继续读取最终笔记内容
            if os.path.exists(result_path):
                with open(result_path, "r", encoding="utf-8") as rf:
                    result_content = json.load(rf)
                return status_response({
                    "status": status,
                    "result": result_content,
                    "message": message,
                    "task_id": task_id
                })
            else:
                # 理论上不会出现，保险处理
                return status_response({
                    "status": "UNKNOWN",
                    "message": "任务完成，但结果文件未找到",
                    "task_id": task_id
                })

        if status == TaskStatus.FAILED.value:
            return status_response({"status": status, "message": message or "任务失败", "task_id": task_id})

        # 处理中状态
        return status_response({
            "status": status,
            "message": message,
            "task_id": task_id
        })

    # 没有状态文件，但有结果
    stored = note_storage.get_task(task_id)
    if stored and stored.get("status") == "SUCCESS":
        return status_response({"status": TaskStatus.SUCCESS.value,
                          "result": _poll_result(stored), "task_id": task_id})
    if stored and stored.get("status") == "FAILED":
        return status_response({"status": "FAILED", "message": stored.get("statusMessage") or "任务失败", "task_id": task_id})
    if not stored and os.path.exists(result_path):
        with open(result_path, "r", encoding="utf-8") as f:
            result_content = json.load(f)
        return status_response({
            "status": TaskStatus.SUCCESS.value,
            "result": result_content,
            "task_id": task_id
        })

    # Missing status is not evidence that a job was accepted.
    if not stored:
        return R.error("任务不存在或尚未接收", code=404,
                       data={"status": "UNKNOWN", "task_id": task_id, "request_id": request_id})
    return status_response({
        "status": "UNKNOWN",
        "message": "任务记录存在，但执行状态暂不可用",
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
