import asyncio
import io
from pathlib import Path
from unittest.mock import patch

import httpx
import pytest
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.testclient import TestClient

from app.services import media_io


def test_upload_paths_and_concurrent_names_are_isolated(tmp_path):
    async def run():
        return await asyncio.gather(*(media_io.save_upload(UploadFile(filename=name, file=io.BytesIO(body)), str(tmp_path))
                                     for name, body in [('../../outside.mp4', b'one'), ('same.mp4', b'two'), ('same.mp4', b'three')]))
    results = asyncio.run(run())
    paths = [tmp_path / Path(result['url']).name for result in results]
    assert len(set(paths)) == 3
    assert [path.read_bytes() for path in paths] == [b'one', b'two', b'three']
    assert not (tmp_path.parent / 'outside.mp4').exists()


@pytest.mark.parametrize('filename', ['bad.html', 'bad.exe', 'bad.mp4.exe', 'no-extension'])
def test_upload_rejects_non_media(tmp_path, filename):
    with pytest.raises(HTTPException) as error:
        asyncio.run(media_io.save_upload(UploadFile(filename=filename, file=io.BytesIO(b'bad')), str(tmp_path)))
    assert error.value.status_code == 415
    assert not list(tmp_path.iterdir())


def test_upload_limit_cleans_partial_and_preserves_collision(tmp_path, monkeypatch):
    monkeypatch.setenv('BILINOTE_UPLOAD_MAX_BYTES', '3')
    with pytest.raises(HTTPException) as error:
        asyncio.run(media_io.save_upload(UploadFile(filename='a.mp4', file=io.BytesIO(b'toolarge')), str(tmp_path)))
    assert error.value.status_code == 413
    assert not list(tmp_path.iterdir())
    monkeypatch.setenv('BILINOTE_UPLOAD_MAX_BYTES', '100')
    collision = tmp_path / 'same.mp4'
    collision.write_bytes(b'existing')
    with patch.object(media_io.uuid, 'uuid4', return_value=type('ID', (), {'hex': 'same'})()):
        with pytest.raises(FileExistsError):
            asyncio.run(media_io.save_upload(UploadFile(filename='a.mp4', file=io.BytesIO(b'new')), str(tmp_path)))
    assert collision.read_bytes() == b'existing'


@pytest.mark.parametrize('url', ['http://127.0.0.1:8483/a', 'http://169.254.169.254/a', 'file:///etc/passwd',
                                     'https://i.ytimg.com.evil.invalid/a', 'https://user:pass@i.ytimg.com/a',
                                     'https://i.ytimg.com:9000/a'])
def test_proxy_rejects_unsafe_urls_before_network(url):
    with patch.object(media_io, 'resolve_public') as resolve:
        with pytest.raises(HTTPException) as error:
            asyncio.run(media_io.fetch_cover(url))
        assert error.value.status_code == 400
        resolve.assert_not_called()


def proxy_response(response, limit=media_io.IMAGE_LIMIT):
    original = httpx.AsyncClient
    requests = []
    def handle(request):
        requests.append(request)
        return response
    def client(**kwargs):
        assert kwargs['trust_env'] is False and kwargs['follow_redirects'] is False
        return original(transport=httpx.MockTransport(handle), **kwargs)
    with patch.object(media_io, 'resolve_public', return_value=['8.8.8.8']), \
         patch.object(media_io.httpx, 'AsyncClient', side_effect=client), patch.object(media_io, 'IMAGE_LIMIT', limit):
        result = asyncio.run(media_io.fetch_cover('https://i.ytimg.com/cover.jpg'))
    return result, requests


def test_proxy_pins_dns_and_keeps_tls_hostname():
    result, requests = proxy_response(httpx.Response(200, content=b'image', headers={'content-type': 'image/jpeg'}))
    assert result == (b'image', 'image/jpeg')
    assert len(requests) == 1
    assert requests[0].url.host == '8.8.8.8'
    assert requests[0].headers['host'] == 'i.ytimg.com'
    assert requests[0].extensions['sni_hostname'] == 'i.ytimg.com'


@pytest.mark.parametrize('response,limit,status', [
    (httpx.Response(302, headers={'location': 'http://127.0.0.1/'}), 100, 502),
    (httpx.Response(200, content=b'html', headers={'content-type': 'text/html'}), 100, 415),
    (httpx.Response(200, content=b'large', headers={'content-type': 'image/jpeg'}), 3, 413),
])
def test_proxy_blocks_redirect_non_image_and_size(response, limit, status):
    with pytest.raises(HTTPException) as error:
        proxy_response(response, limit)
    assert error.value.status_code == status


def test_proxy_rejects_private_dns_and_hides_error():
    with patch.object(media_io, 'resolve_public', side_effect=ValueError('SECRET private address')):
        with pytest.raises(HTTPException) as error:
            asyncio.run(media_io.fetch_cover('https://i.ytimg.com/a'))
    assert 'SECRET' not in error.value.detail


def test_raw_upload_body_is_bounded_before_file_parsing(tmp_path, monkeypatch):
    monkeypatch.setenv('BILINOTE_UPLOAD_MAX_BYTES', '3')
    app = FastAPI()
    app.add_middleware(media_io.UploadBodyLimit)
    @app.post('/api/upload')
    async def upload(file: UploadFile = File(...)):
        return await media_io.save_upload(file, str(tmp_path))
    client = TestClient(app)
    response = client.post('/api/upload', files={'file': ('large.mp4', b'x' * 70000, 'video/mp4')})
    assert response.status_code == 413
    assert not list(tmp_path.iterdir())


def test_chunked_upload_body_limit_closes_multipart(tmp_path, monkeypatch):
    monkeypatch.setenv('BILINOTE_UPLOAD_MAX_BYTES', '3')
    app = FastAPI()
    app.add_middleware(media_io.UploadBodyLimit)
    @app.post('/api/upload')
    async def upload(file: UploadFile = File(...)):
        return await media_io.save_upload(file, str(tmp_path))
    async def run():
        async def chunks():
            yield b'--limit\r\nContent-Disposition: form-data; name="file"; filename="a.mp4"\r\n\r\n'
            yield b'x' * 70000
            yield b'\r\n--limit--\r\n'
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url='http://test') as client:
            return await client.post('/api/upload', content=chunks(), headers={'content-type': 'multipart/form-data; boundary=limit'})
    assert asyncio.run(run()).status_code == 413
    assert not list(tmp_path.iterdir())


def test_private_dns_is_rejected_by_shared_resolver():
    from app.services import web_page
    import socket
    import time
    for address in ('127.0.0.1', '169.254.169.254', '10.0.0.1', '::1'):
        with patch.object(web_page.socket, 'getaddrinfo', return_value=[(socket.AF_INET, socket.SOCK_STREAM, 6, '', (address, 443))]):
            with pytest.raises(ValueError):
                web_page.resolve_public('i.ytimg.com', lambda: None, time.monotonic() + 1)


def test_disconnected_upload_cleans_its_partial_file(tmp_path):
    class InterruptedUpload:
        filename = 'sample.mp4'
        size = None
        reads = 0
        async def read(self, size):
            self.reads += 1
            if self.reads == 1:
                return b'partial'
            raise asyncio.CancelledError()
    with pytest.raises(asyncio.CancelledError):
        asyncio.run(media_io.save_upload(InterruptedUpload(), str(tmp_path)))
    assert not list(tmp_path.iterdir())
