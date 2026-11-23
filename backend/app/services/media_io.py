"""Bound uploads and fetch platform covers without trusting client paths or DNS twice."""
import asyncio
import os
import json
import time
import uuid
from pathlib import Path

import httpx
from fastapi import HTTPException, UploadFile
from starlette.formparsers import MultiPartException
from starlette.responses import JSONResponse

from app.services.web_page import resolve_public

MEDIA_SUFFIXES = {'.mp4', '.mkv', '.mov', '.avi', '.webm', '.m4v', '.flv', '.ts',
                  '.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.opus', '.wma'}
SUBTITLE_SUFFIXES = {'.srt', '.vtt'}
DOCUMENT_SUFFIXES = {'.pdf', '.md', '.markdown', '.txt'}
UPLOAD_ALLOWED_SUFFIXES = MEDIA_SUFFIXES | SUBTITLE_SUFFIXES | DOCUMENT_SUFFIXES
COVER_DOMAINS = ('hdslb.com', 'bilibili.com', 'ytimg.com', 'twimg.com', 'xyzcdn.net', 'xiaoyuzhoufm.com',
                 'kwimgs.com', 'kwaicdn.com', 'douyinpic.com', 'byteimg.com', 'pstatp.com')
IMAGE_LIMIT = 8 * 1024 * 1024


class UploadBodyLimit:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope['type'] != 'http' or scope['path'] != '/api/upload':
            return await self.app(scope, receive, send)
        limit = int(os.getenv('BILINOTE_UPLOAD_MAX_BYTES', str(4 * 1024 ** 3))) + 65536
        length = dict(scope.get('headers', [])).get(b'content-length', b'0')
        if length.isdigit() and int(length) > limit:
            return await JSONResponse({'detail': '文件超过上传大小限制，请缩短素材后重试'}, 413)(scope, receive, send)
        total = 0
        exceeded = False
        async def bounded_receive():
            nonlocal total, exceeded
            message = await receive()
            total += len(message.get('body', b''))
            if total > limit:
                exceeded = True
                # Starlette closes multipart temporary files on this exception.
                raise MultiPartException('文件超过上传大小限制，请缩短素材后重试')
            return message
        async def bounded_send(message):
            if exceeded and message['type'] == 'http.response.start':
                message = dict(message, status=413)
            await send(message)
        await self.app(scope, bounded_receive, bounded_send)


async def save_upload(file: UploadFile, directory: str):
    suffix = Path((file.filename or '').replace('\\', '/')).suffix.lower()
    if suffix not in UPLOAD_ALLOWED_SUFFIXES:
        raise HTTPException(415, '请选择支持的音视频、字幕（.srt / .vtt）或文档文件（.pdf / .md / .txt）')
    limit = int(os.getenv('BILINOTE_UPLOAD_MAX_BYTES', str(4 * 1024 ** 3)))
    if limit <= 0:
        raise HTTPException(503, '上传大小限制配置无效，请检查后台设置')
    if file.size is not None and file.size > limit:
        raise HTTPException(413, '文件超过上传大小限制，请缩短素材后重试')
    root = Path(directory).resolve()
    root.mkdir(parents=True, exist_ok=True)
    target = root / (uuid.uuid4().hex + suffix)
    complete = created = False
    try:
        # Exclusive creation prevents accidental overwrite even if names collide.
        with target.open('xb') as stream:
            created = True
            total = 0
            while chunk := await file.read(1024 * 1024):
                total += len(chunk)
                if total > limit:
                    raise HTTPException(413, '文件超过上传大小限制，请缩短素材后重试')
                stream.write(chunk)
            if not total:
                raise HTTPException(400, '文件为空，请重新选择素材')
        original = (file.filename or '').replace('\\', '/').rsplit('/', 1)[-1]
        names = root / '_names'
        names.mkdir(exist_ok=True)
        (names / (target.name + '.json')).write_text(json.dumps({'filename': original}, ensure_ascii=False), encoding='utf-8')
        complete = True
        return {'url': f'/uploads/{target.name}',
                'filename': original,
                'is_subtitle': suffix in SUBTITLE_SUFFIXES,
                'is_document': suffix in DOCUMENT_SUFFIXES}
    finally:
        if created and not complete and target.is_file():
            target.unlink()


async def fetch_cover(url: str):
    try:
        parsed = httpx.URL(url)
        host = parsed.host.lower().rstrip('.')
        if (parsed.scheme not in ('http', 'https') or parsed.userinfo or
                parsed.port not in (None, 80, 443) or
                not any(host == domain or host.endswith('.' + domain) for domain in COVER_DOMAINS)):
            raise HTTPException(400, '仅支持视频平台的公开封面地址')
        deadline = time.monotonic() + 15
        def check():
            if time.monotonic() >= deadline:
                raise ValueError('图片请求超时')
        addresses = await asyncio.to_thread(resolve_public, host, check, deadline)
        # Keep Host/SNI bound to the original domain, while the connection uses
        # only the validated address. A second DNS lookup cannot rebind it.
        pinned = parsed.copy_with(host=addresses[0], fragment=None)
        headers = {'Host': host, 'User-Agent': 'BiliNote-Studio/1.0', 'Accept-Encoding': 'identity'}
        if host.endswith(('bilibili.com', 'hdslb.com')):
            headers['Referer'] = 'https://www.bilibili.com/'
        proxy_url = None
        if host.endswith(('twimg.com', 'ytimg.com')):
            try:
                from app.services.proxy_config_manager import ProxyConfigManager
                proxy_url = ProxyConfigManager().get_proxy_url()
            except Exception:
                proxy_url = None
        async with asyncio.timeout(max(.01, deadline - time.monotonic())):
            client_kwargs = dict(timeout=10, follow_redirects=False, trust_env=False)
            target_url = pinned
            stream_kwargs = {'headers': headers, 'extensions': {'sni_hostname': host}}
            if proxy_url:
                # 配置了显式代理时由代理出口解析目标公网域名，保持白名单校验在前
                client_kwargs['proxy'] = proxy_url
                target_url = parsed.copy_with(fragment=None)
                stream_kwargs = {'headers': {k: v for k, v in headers.items() if k != 'Host'}}
            async with httpx.AsyncClient(**client_kwargs) as client:
                async with client.stream('GET', target_url, **stream_kwargs) as response:
                    if response.status_code != 200:
                        raise HTTPException(502, '封面获取失败，请稍后重试')
                    content_type = response.headers.get('content-type', '').split(';')[0].lower()
                    if content_type not in ('image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'):
                        raise HTTPException(415, '该地址未返回支持的图片格式')
                    if response.headers.get('content-encoding', 'identity').lower() not in ('', 'identity'):
                        raise HTTPException(415, '封面返回了不支持的压缩格式')
                    if int(response.headers.get('content-length', '0')) > IMAGE_LIMIT:
                        raise HTTPException(413, '封面图片过大')
                    data = bytearray()
                    async for chunk in response.aiter_bytes(64 * 1024):
                        check()
                        data.extend(chunk)
                        if len(data) > IMAGE_LIMIT:
                            raise HTTPException(413, '封面图片过大')
                    if not data:
                        raise HTTPException(502, '封面内容为空')
                    return bytes(data), content_type
    except HTTPException:
        raise
    except (ValueError, OSError, httpx.HTTPError):
        raise HTTPException(502, '封面暂时无法读取，请稍后重试') from None
