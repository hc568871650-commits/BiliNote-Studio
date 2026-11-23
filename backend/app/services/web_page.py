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


class PinnedHTTPConnection(http.client.HTTPConnection):
    def __init__(self, host, address, timeout):
        super().__init__(host, port=80, timeout=timeout)
        self.address = address
        self.active_socket = None

    def connect(self):
        raw = socket.create_connection((self.address, 80), self.timeout)
        self.active_socket = raw
        self.sock = raw


_ARTICLE_BROWSER_UA = (
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
    'AppleWebKit/537.36 (KHTML, like Gecko) '
    'Chrome/137.0.0.0 Safari/537.36'
)


def _extract_markdown_title(text: str, fallback: str) -> str:
    for line in (text or '').splitlines()[:30]:
        stripped = line.strip()
        if stripped.startswith('#'):
            heading = stripped.lstrip('#').strip()
            if heading:
                return heading[:160]
    return fallback


def _fallback_title_from_url(url: str) -> str:
    parts = urlsplit(url)
    slug = (parts.path or '').rstrip('/').rsplit('/', 1)[-1]
    if slug and slug not in ('index.html', 'index.htm'):
        return slug[:120]
    return parts.hostname or '网页文章'


def extract_article_from_html(html_text: str, final_url: str) -> dict:
    """从 HTML 提取结构化文章标题、作者、封面与正文（保留标题层级、代码块与列表）。"""
    import re as _re

    fallback_title = _fallback_title_from_url(final_url)
    host = (urlsplit(final_url).hostname or '').lower()
    if host.startswith('www.'):
        host = host[4:]

    try:
        from bs4 import BeautifulSoup, NavigableString, Tag
    except ImportError:
        parser = PageText()
        parser.feed(html_text)
        body = '\n'.join(parser.main_parts or parser.parts).strip()
        return {
            'title': fallback_title,
            'author': host,
            'cover_url': '',
            'description': '',
            'text': body,
        }

    try:
        soup = BeautifulSoup(html_text, 'lxml')
    except Exception:
        soup = BeautifulSoup(html_text, 'html.parser')

    def _meta(*keys: str) -> str:
        for key in keys:
            tag = soup.find('meta', attrs={'property': key}) or soup.find('meta', attrs={'name': key})
            if tag and tag.get('content'):
                val = str(tag.get('content')).strip()
                if val:
                    return val
        return ''

    title = _meta('og:title', 'twitter:title')
    if not title and soup.title:
        title = soup.title.get_text(' ', strip=True)
    if not title:
        h1 = soup.find('h1')
        if h1:
            title = h1.get_text(' ', strip=True)
    title = _re.sub(r'[\s\u00b6¶#🔗]+$', '', _re.sub(r'\s+', ' ', title or '').strip()).strip()[:200] or fallback_title

    author = _meta('author', 'article:author', 'twitter:creator')
    if not author:
        wx_author = soup.select_one('#js_name, .rich_media_meta_nickname, [rel="author"]')
        if wx_author:
            author = wx_author.get_text(' ', strip=True)
    if not author:
        author = _meta('og:site_name') or host
    author = _re.sub(r'\s+', ' ', author or '').strip()[:100]

    cover_raw = _meta('og:image', 'twitter:image')
    cover_url = urljoin(final_url, cover_raw) if cover_raw else ''
    description = _meta('og:description', 'description')

    # 清理非正文噪声节点
    for noisy in soup.select(
        'script, style, noscript, svg, iframe, template, nav, header, footer, aside, form, button, '
        '[aria-hidden="true"], .sidebar, .nav, .navbar, .footer, .comment, .comments, #comments'
    ):
        noisy.decompose()

    # 优先选择主内容容器（兼容微信公众号、GitHub README、主流技术博客与文档站）
    container = None
    selectors = (
        '#js_content',
        'article .markdown-body',
        '.markdown-body',
        'article',
        'main',
        '[role="main"]',
        '#content',
        '#main-content',
        '.article-content',
        '.post-content',
        '.entry-content',
        '.prose',
    )
    for selector in selectors:
        candidates = soup.select(selector)
        if not candidates:
            continue
        best = max(candidates, key=lambda node: len(node.get_text(' ', strip=True)))
        if len(best.get_text(' ', strip=True)) >= 120:
            container = best
            break
    if container is None:
        container = soup.body or soup

    blocks: list[str] = []

    def _emit_node(node) -> None:
        if isinstance(node, NavigableString):
            return
        if not isinstance(node, Tag):
            return
        name = (node.name or '').lower()
        if name in ('h1', 'h2', 'h3', 'h4', 'h5', 'h6'):
            text = _re.sub(r'\s+', ' ', node.get_text(' ', strip=True)).strip()
            if text:
                level = min(6, max(1, int(name[1])))
                blocks.append(f"{'#' * level} {text}")
            return
        if name == 'pre':
            code = node.get_text('\n', strip=False).strip('\n')
            if code.strip():
                lang = ''
                code_tag = node.find('code')
                if code_tag and code_tag.get('class'):
                    for cls in code_tag.get('class'):
                        m = _re.search(r'(?:language|lang)-([a-zA-Z0-9_+#.-]+)', str(cls))
                        if m:
                            lang = m.group(1)
                            break
                blocks.append(f"```{lang}\n{code}\n```")
            return
        if name == 'blockquote':
            text = _re.sub(r'\s+', ' ', node.get_text(' ', strip=True)).strip()
            if text:
                blocks.append(f"> {text}")
            return
        if name in ('ul', 'ol'):
            items = []
            for idx, li in enumerate(node.find_all('li', recursive=False), start=1):
                item_text = _re.sub(r'\s+', ' ', li.get_text(' ', strip=True)).strip()
                if item_text:
                    prefix = f"{idx}. " if name == 'ol' else "- "
                    items.append(prefix + item_text)
            if items:
                blocks.append('\n'.join(items))
            return
        if name == 'table':
            rows = []
            for tr in node.find_all('tr'):
                cells = [_re.sub(r'\s+', ' ', td.get_text(' ', strip=True)) for td in tr.find_all(['th', 'td'])]
                if any(cells):
                    rows.append(' | '.join(cells))
            if rows:
                blocks.append('\n'.join(rows))
            return
        if name == 'p':
            text = _re.sub(r'\s+', ' ', node.get_text(' ', strip=True)).strip()
            if text:
                blocks.append(text)
            return

        # 若节点包含块级子元素则递归，否则收集纯文本
        has_block_child = any(
            isinstance(child, Tag)
            and (child.name or '').lower()
            in ('h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'pre', 'blockquote', 'ul', 'ol', 'table', 'div', 'section', 'article')
            for child in node.children
        )
        if has_block_child:
            for child in node.children:
                _emit_node(child)
        else:
            text = _re.sub(r'\s+', ' ', node.get_text(' ', strip=True)).strip()
            if text:
                blocks.append(text)

    _emit_node(container)
    # 去重连续重复行并拼接
    deduped: list[str] = []
    for block in blocks:
        if not deduped or deduped[-1] != block:
            deduped.append(block)
    body_text = '\n\n'.join(deduped).strip()
    if len(body_text) < 40:
        body_text = _re.sub(r'\n{3,}', '\n\n', container.get_text('\n', strip=True)).strip()

    return {
        'title': title,
        'author': author,
        'cover_url': cover_url,
        'description': description,
        'text': body_text,
    }


def _decode_payload(payload: bytes, header_charset: str | None) -> str:
    import re as _re

    if header_charset:
        try:
            return payload.decode(header_charset, errors='replace')
        except LookupError:
            pass
    head = payload[:4096].decode('ascii', errors='ignore')
    m = _re.search(r'charset=["\']?\s*([a-zA-Z0-9._-]+)', head, _re.IGNORECASE)
    if m:
        try:
            return payload.decode(m.group(1), errors='replace')
        except LookupError:
            pass
    return payload.decode('utf-8', errors='replace')


def read_article_page(url, *, use_proxy=True, proxy_url=None, secrets=(), cancellation=None):
    """读取公开网页技术文章，严格执行 SSRF/公网校验并按需透传全局代理。"""
    from app.services.web_search import public_page_url

    deadline = time.monotonic() + 30
    original = url

    def check():
        cancelled = cancellation() if callable(cancellation) else cancellation and cancellation.get('cancelled')
        if cancelled:
            raise ValueError('请求已取消，未继续读取网页')
        if time.monotonic() >= deadline:
            raise ValueError('网页读取超时，请检查网络或代理设置')

    resolved_proxy = proxy_url
    if use_proxy and resolved_proxy is None:
        try:
            from app.services.proxy_config_manager import ProxyConfigManager
            resolved_proxy = ProxyConfigManager().get_proxy_url()
        except Exception:
            resolved_proxy = None

    headers = {
        'Accept': 'text/html,application/xhtml+xml,text/markdown,text/plain;q=0.9,*/*;q=0.5',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Accept-Encoding': 'gzip',
        'User-Agent': _ARTICLE_BROWSER_UA,
        'Cache-Control': 'no-cache',
    }
    allowed_types = ('text/html', 'application/xhtml+xml', 'text/plain', 'text/markdown', 'text/x-markdown')

    try:
        raw_bytes: bytes | None = None
        content_type = ''
        header_charset = None

        if resolved_proxy:
            import httpx

            with httpx.Client(proxy=resolved_proxy, follow_redirects=False, trust_env=False, timeout=15) as client:
                for redirect in range(4):
                    check()
                    url = public_page_url(url, secrets)
                    with client.stream('GET', url, headers={k: v for k, v in headers.items() if k != 'Accept-Encoding'}) as resp:
                        check()
                        if resp.status_code in (301, 302, 303, 307, 308):
                            location = resp.headers.get('location')
                            if not location or redirect == 3:
                                raise ValueError('网页重定向次数过多或地址缺失')
                            url = urljoin(url, location)
                            continue
                        if resp.status_code != 200:
                            raise ValueError(f'网页返回 HTTP {resp.status_code}，未获得正文')
                        content_type = (resp.headers.get('content-type') or '').lower()
                        if not any(content_type.startswith(t) for t in allowed_types):
                            raise ValueError('仅支持 HTML、Markdown 或纯文本网页文章')
                        header_charset = resp.charset_encoding
                        buf = bytearray()
                        for chunk in resp.iter_bytes(16384):
                            check()
                            buf.extend(chunk)
                            if len(buf) > LIMIT:
                                raise ValueError('网页正文超过大小限制（2MB）')
                        raw_bytes = bytes(buf)
                        break
        else:
            for redirect in range(4):
                check()
                url = public_page_url(url, secrets)
                parts = urlsplit(url)
                if parts.scheme not in ('http', 'https') or parts.port not in (None, 80, 443):
                    raise ValueError('网页读取仅允许公开 HTTP/HTTPS 地址')
                addresses = resolve_public(parts.hostname, check, deadline)
                check()
                addresses.sort(key=lambda address: ipaddress.ip_address(address).version)
                timeout_val = min(12, max(.01, deadline - time.monotonic()))
                connection = (
                    PinnedHTTPSConnection(parts.hostname, addresses[0], timeout_val)
                    if parts.scheme == 'https'
                    else PinnedHTTPConnection(parts.hostname, addresses[0], timeout_val)
                )
                stopped = threading.Event()

                def expire(conn=connection):
                    sock = conn.active_socket
                    if sock is not None:
                        try:
                            sock.shutdown(socket.SHUT_RDWR)
                        except OSError:
                            pass
                        sock.close()

                def guard(stop_evt=stopped, stop_fn=expire):
                    while not stop_evt.wait(.05):
                        try:
                            check()
                        except ValueError:
                            stop_fn()
                            return

                watchdog = threading.Thread(target=guard, daemon=True)
                watchdog.start()
                response = None
                try:
                    path = parts.path or '/'
                    if parts.query:
                        path += '?' + parts.query
                    connection.request('GET', path, headers=headers)
                    response = connection.getresponse()
                    check()
                    if response.status in (301, 302, 303, 307, 308):
                        location = response.getheader('Location')
                        if not location or redirect == 3:
                            raise ValueError('网页重定向次数过多或地址缺失')
                        url = urljoin(url, location)
                        continue
                    if response.status != 200:
                        raise ValueError(f'网页返回 HTTP {response.status}，未获得正文')
                    content_type = (response.getheader('Content-Type') or '').lower()
                    if not any(content_type.startswith(t) for t in allowed_types):
                        raise ValueError('仅支持 HTML、Markdown 或纯文本网页文章')
                    encoding = (response.getheader('Content-Encoding') or '').lower()
                    if encoding not in ('', 'identity', 'gzip'):
                        raise ValueError('不支持该网页压缩格式')
                    decoder = zlib.decompressobj(16 + zlib.MAX_WBITS) if encoding == 'gzip' else None
                    payload = bytearray()
                    received = 0
                    while True:
                        check()
                        if connection.sock:
                            connection.sock.settimeout(min(12, max(.01, deadline - time.monotonic())))
                        chunk = response.read1(16384)
                        check()
                        if not chunk:
                            break
                        received += len(chunk)
                        if received > LIMIT:
                            raise ValueError('网页响应超过大小限制（2MB）')
                        payload.extend(decoder.decompress(chunk, LIMIT + 1 - len(payload)) if decoder else chunk)
                        if len(payload) > LIMIT or (decoder and decoder.unconsumed_tail):
                            raise ValueError('网页解压后超过大小限制（2MB）')
                    if decoder and (not decoder.eof or decoder.unused_data):
                        raise ValueError('网页压缩正文不完整')
                    header_charset = response.headers.get_content_charset()
                    raw_bytes = bytes(payload)
                    break
                finally:
                    stopped.set()
                    watchdog.join(timeout=.1)
                    if response is not None:
                        response.close()
                    connection.close()

        if raw_bytes is None:
            raise ValueError('未能读取到网页正文内容')

        decoded = _decode_payload(raw_bytes, header_charset)
        is_plain = content_type.startswith(('text/plain', 'text/markdown', 'text/x-markdown'))
        if is_plain:
            text = decoded.strip()
            fallback_title = _fallback_title_from_url(url)
            host = (urlsplit(url).hostname or '').lower()
            meta = {
                'title': _extract_markdown_title(text, fallback_title),
                'author': host[4:] if host.startswith('www.') else host,
                'cover_url': '',
                'description': '',
                'text': text,
            }
        else:
            meta = extract_article_from_html(decoded, url)
            text = meta['text']

        if not text.strip():
            raise ValueError('网页未提取到有效正文，可能是需要登录或纯前端动态渲染页面')

        for secret in secrets:
            if secret:
                text = text.replace(secret, '[redacted]')

        return {
            'url': original,
            'final_url': url,
            'title': meta['title'],
            'author': meta['author'],
            'cover_url': meta['cover_url'],
            'description': meta['description'],
            'text': text[:TEXT_LIMIT],
            'content_type': content_type,
            'truncated': len(text) > TEXT_LIMIT,
            'total_length': len(text),
            'retained_length': min(len(text), TEXT_LIMIT),
            'retrieved_at': datetime.now(timezone.utc).isoformat(),
        }
    except ValueError:
        raise
    except Exception as exc:
        check()
        raise ValueError(f'网页文章读取失败：{exc}') from None
