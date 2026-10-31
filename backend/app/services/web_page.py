"""Read public HTTPS pages with pinned, validated DNS and bounded resources."""
import http.client
import ipaddress
import socket
import ssl
import time
import zlib
import queue
import threading
import json
from datetime import datetime, timezone
from html.parser import HTMLParser
from urllib.parse import urlsplit, urljoin, urlunsplit, urlencode

LIMIT = 2 * 1024 * 1024
TEXT_LIMIT = 100000
FAKE_IP_NETWORK = ipaddress.ip_network('198.18.0.0/15')


def _public(address):
    address = ipaddress.ip_address(address)
    return (address.is_global and not address.is_multicast and not address.is_unspecified
            and not address.is_reserved and not address.is_loopback and not address.is_link_local)


def _doh_addresses(host, check, deadline):
    check()
    connection = http.client.HTTPSConnection('dns.google', timeout=min(10, max(.01, deadline - time.monotonic())), context=ssl.create_default_context())
    stopped = threading.Event()
    active = [None]
    def guard():
        while not stopped.wait(.05):
            try:
                check()
            except ValueError:
                sock = active[0] or connection.sock
                if sock is not None:
                    try:
                        sock.shutdown(socket.SHUT_RDWR)
                    except OSError:
                        pass
                    sock.close()
                return
    watchdog = threading.Thread(target=guard, daemon=True)
    watchdog.start()
    response = None
    try:
        connection.request('GET', '/resolve?' + urlencode({'name': host, 'type': 'A', 'edns_client_subnet': '0.0.0.0/0'}),
                           headers={'Accept': 'application/dns-json', 'Accept-Encoding': 'identity'})
        active[0] = connection.sock
        response = connection.getresponse()
        check()
        if response.status != 200:
            raise ValueError('公共 DNS 解析失败，未继续读取网页')
        if response.getheader('Content-Encoding', 'identity').lower() not in ('', 'identity'):
            raise ValueError('公共 DNS 返回了不支持的压缩响应')
        payload = bytearray()
        while True:
            check()
            chunk = response.read1(8192)
            check()
            if not chunk:
                break
            payload.extend(chunk)
            if len(payload) > 65536:
                raise ValueError('公共 DNS 响应过大')
        data = json.loads(payload)
        if not isinstance(data, dict) or data.get('Status') != 0 or not isinstance(data.get('Answer'), list):
            raise ValueError('公共 DNS 没有有效解析结果')
        addresses = [record.get('data') for record in data['Answer'] if isinstance(record, dict) and record.get('type') == 1]
        if not addresses or any(not isinstance(address, str) or ipaddress.ip_address(address).version != 4 or not _public(address) for address in addresses):
            raise ValueError('公共 DNS 没有公开 IPv4 结果，已拒绝读取')
        return addresses
    finally:
        stopped.set()
        watchdog.join(timeout=.1)
        if response is not None:
            response.close()
        connection.close()


def resolve_public(host, check, deadline):
    result = queue.Queue(maxsize=1)
    def resolve():
        try:
            answers = socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
            addresses = [item[4][0] for item in answers]
            # Only the known VPN synthetic range permits trusted DoH lookup;
            # private/mixed answers must never be converted into permission.
            if addresses and all(ipaddress.ip_address(address) in FAKE_IP_NETWORK for address in addresses):
                addresses = _doh_addresses(host, check, deadline)
            result.put(addresses)
        except (OSError, ValueError, http.client.HTTPException) as exc:
            result.put(exc)
    threading.Thread(target=resolve, daemon=True).start()
    while True:
        check()
        try:
            answer = result.get(timeout=min(.1, max(.01, deadline - time.monotonic())))
            break
        except queue.Empty:
            continue
    if isinstance(answer, Exception):
        raise answer
    addresses = answer
    if not addresses or not all(_public(address) for address in addresses):
        raise ValueError('网页域名指向私有或保留地址，已拒绝读取')
    return addresses


class PinnedHTTPSConnection(http.client.HTTPSConnection):
    def __init__(self, host, address, timeout):
        super().__init__(host, port=443, timeout=timeout, context=ssl.create_default_context())
        self.address = address
        self.active_socket = None

    def connect(self):
        raw = socket.create_connection((self.address, 443), self.timeout)
        self.active_socket = raw
        try:
            # Publish the SSL socket before handshake so the deadline guard can
            # interrupt handshakes and later Connection: close response bodies.
            self.sock = self._context.wrap_socket(raw, server_hostname=self.host, do_handshake_on_connect=False)
            self.active_socket = self.sock
            self.sock.do_handshake()
        except Exception:
            if self.sock is not None:
                self.sock.close()
            raw.close()
            raise


class PageText(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack = []
        self.parts = []
        self.main_parts = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        parent = self.stack[-1] if self.stack else ('', False, False)
        hidden = parent[1] or tag in ('script', 'style', 'nav', 'header', 'footer', 'noscript', 'svg', 'form')
        main = parent[2] or tag in ('main', 'article') or attrs.get('role') == 'main' or attrs.get('id') in ('content', 'main-content')
        if tag not in ('br', 'hr', 'img', 'meta', 'link', 'input', 'source', 'area', 'base', 'wbr', 'embed', 'param', 'track', 'col'):
            self.stack.append((tag, hidden, main))

    def handle_endtag(self, tag):
        for i in range(len(self.stack) - 1, -1, -1):
            if self.stack[i][0] == tag:
                del self.stack[i:]
                break

    def handle_data(self, data):
        state = self.stack[-1] if self.stack else ('', False, False)
        if not state[1] and data.strip():
            self.parts.append(data.strip())
            if state[2]:
                self.main_parts.append(data.strip())


def read_page(url, secrets=(), cancellation=None):
    from app.services.web_search import public_page_url
    deadline = time.monotonic() + 25
    original = url

    def check():
        cancelled = cancellation() if callable(cancellation) else cancellation and cancellation.get('cancelled')
        if cancelled:
            raise ValueError('请求已取消，未继续读取网页')
        if time.monotonic() >= deadline:
            raise ValueError('网页读取超时')

    try:
        for redirect in range(3):
            check()
            url = public_page_url(url, secrets)
            parts = urlsplit(url)
            if parts.scheme != 'https' or parts.port not in (None, 443):
                raise ValueError('网页读取仅允许公开 HTTPS 地址')
            addresses = resolve_public(parts.hostname, check, deadline)
            check()
            addresses.sort(key=lambda address: ipaddress.ip_address(address).version)
            connection = PinnedHTTPSConnection(parts.hostname, addresses[0], min(10, deadline - time.monotonic()))
            def expire(connection=connection):
                sock = connection.active_socket
                if sock is not None:
                    try:
                        sock.shutdown(socket.SHUT_RDWR)
                    except OSError:
                        pass
                    sock.close()
            stopped = threading.Event()
            def guard(stopped=stopped, expire=expire):
                while not stopped.wait(.05):
                    try:
                        check()
                    except ValueError:
                        expire()
                        return
            watchdog = threading.Thread(target=guard, daemon=True)
            watchdog.start()
            response = None
            try:
                path = parts.path or '/'
                if parts.query:
                    path += '?' + parts.query
                connection.request('GET', path, headers={'Accept': 'text/html,text/plain', 'Accept-Encoding': 'gzip',
                                                         'User-Agent': 'BiliNote-PageReader/1.0', 'Cache-Control': 'no-cache'})
                response = connection.getresponse()
                check()
                if response.status in (301, 302, 303, 307, 308):
                    location = response.getheader('Location')
                    if not location or redirect == 2:
                        raise ValueError('网页重定向次数过多或地址缺失')
                    target = urljoin(url, location)
                    redirect_parts = urlsplit(target)
                    if redirect_parts.scheme == 'http':
                        if (redirect_parts.hostname != parts.hostname or redirect_parts.username or redirect_parts.password
                                or redirect_parts.port not in (None, 80)):
                            raise ValueError('网页重定向不允许降级到 HTTP')
                        # Some HTTPS sites emit HTTP canonical URLs. Never send
                        # an HTTP request: retain TLS and revalidate DNS next hop.
                        target = urlunsplit(('https', parts.hostname, redirect_parts.path, redirect_parts.query, redirect_parts.fragment))
                    url = target
                    continue
                if response.status != 200:
                    raise ValueError(f'网页返回 HTTP {response.status}，未获得正文')
                content_type = response.getheader('Content-Type', '').lower()
                if not any(content_type.startswith(t) for t in ('text/html', 'application/xhtml+xml', 'text/plain')):
                    raise ValueError('只支持 HTML 或纯文本网页')
                encoding = response.getheader('Content-Encoding', '').lower()
                if encoding not in ('', 'identity', 'gzip'):
                    raise ValueError('不支持该网页压缩格式')
                decoder = zlib.decompressobj(16 + zlib.MAX_WBITS) if encoding == 'gzip' else None
                payload = bytearray()
                received = 0
                while True:
                    check()
                    if connection.sock:
                        connection.sock.settimeout(min(10, max(.01, deadline - time.monotonic())))
                    chunk = response.read1(16384)
                    check()
                    if not chunk:
                        break
                    received += len(chunk)
                    if received > LIMIT:
                        raise ValueError('网页响应超过大小限制')
                    payload.extend(decoder.decompress(chunk, LIMIT + 1 - len(payload)) if decoder else chunk)
                    if len(payload) > LIMIT or (decoder and decoder.unconsumed_tail):
                        raise ValueError('网页解压后超过大小限制')
                if decoder and (not decoder.eof or decoder.unused_data):
                    raise ValueError('网页压缩正文不完整')
                charset = response.headers.get_content_charset() or 'utf-8'
                text = payload.decode(charset, errors='replace')
                if not content_type.startswith('text/plain'):
                    parser = PageText()
                    parser.feed(text)
                    text = '\n'.join(parser.main_parts or parser.parts)
                if not text.strip():
                    raise ValueError('网页没有可读取的正文')
                check()
                for secret in secrets:
                    if secret:
                        text = text.replace(secret, '[redacted]')
                return {'url': original, 'final_url': url, 'text': text[:TEXT_LIMIT], 'truncated': len(text) > TEXT_LIMIT,
                        'total_length': len(text), 'retained_length': min(len(text), TEXT_LIMIT),
                        'evidence_type': 'page', 'retrieved_at': datetime.now(timezone.utc).isoformat(),
                        'retrieved_at_is_publication_date': False, 'reference_data_only': True}
            finally:
                stopped.set()
                watchdog.join(timeout=.1)
                if response is not None:
                    response.close()
                connection.close()
    except (ValueError, OSError, http.client.HTTPException, LookupError, zlib.error) as exc:
        check()
        if isinstance(exc, ValueError):
            raise
        raise ValueError('网页读取失败，未确认当前正文；可依据已有来源说明不确定性') from None
