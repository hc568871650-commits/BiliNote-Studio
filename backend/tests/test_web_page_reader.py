import gzip
import io
import socket
import time
import threading
import json
import unittest
from email.message import Message
from unittest.mock import patch, MagicMock

from app.services import web_page


class Response:
    def __init__(self, data=b'<main>Official current version</main>', status=200, **headers):
        self.status = status
        self.headers = Message()
        self.headers['Content-Type'] = 'text/html; charset=utf-8'
        for key, value in headers.items():
            self.headers[key.replace('_', '-')] = value
        self.data = io.BytesIO(data)

    def getheader(self, name, default=None):
        return self.headers.get(name, default)

    def read1(self, count):
        return self.data.read(count)

    def close(self):
        self.data.close()


class PageReaderTests(unittest.TestCase):
    def setUp(self):
        self.dns = patch.object(socket, 'getaddrinfo', return_value=[(2, 1, 6, '', ('93.184.216.34', 443))])
        self.dns.start()
        self.addCleanup(self.dns.stop)
        self.connection = MagicMock()
        self.connection.getresponse.return_value = Response()
        self.factory = patch.object(web_page, 'PinnedHTTPSConnection', return_value=self.connection)
        self.create = self.factory.start()
        self.addCleanup(self.factory.stop)

    def test_public_dns_pinned_and_headers_no_credentials(self):
        result = web_page.read_page('https://example.com/docs')
        self.assertEqual(result['text'], 'Official current version')
        self.assertEqual(self.create.call_args.args[:2], ('example.com', '93.184.216.34'))
        self.assertNotIn('Authorization', self.connection.request.call_args.kwargs['headers'])
        self.assertFalse(result['retrieved_at_is_publication_date'])
        self.connection.close.assert_called_once()

    def test_all_dns_answers_must_be_public(self):
        with patch.object(socket, 'getaddrinfo', return_value=[(2,1,6,'',('93.184.216.34',443)),(2,1,6,'',('127.0.0.1',443))]):
            with self.assertRaisesRegex(ValueError, '私有'):
                web_page.read_page('https://example.com/')
        self.create.assert_not_called()

    def test_multicast_and_reserved_dns_rejected(self):
        from app.services.web_search import public_page_url
        for address in ('224.0.0.1', 'ff00::1', '0.0.0.0', '169.254.1.1', '127.0.0.1'):
            with self.subTest(address=address), patch.object(socket, 'getaddrinfo', return_value=[(2,1,6,'',(address,443))]):
                with self.assertRaises(ValueError):
                    web_page.read_page('https://example.com/')
                literal = '[' + address + ']' if ':' in address else address
                with self.assertRaises(ValueError):
                    public_page_url('https://' + literal + '/')
        self.create.assert_not_called()

    def test_redirect_revalidates_and_blocks_downgrade(self):
        for location in ['http://other.example.com/', 'https://127.0.0.1/', 'https://user:pass@example.com/']:
            self.connection.getresponse.return_value = Response(status=302, Location=location)
            with self.subTest(location=location), self.assertRaises(ValueError):
                web_page.read_page('https://example.com/')

    def test_same_host_http_canonical_redirect_upgraded_without_http_request(self):
        self.connection.getresponse.side_effect = [Response(status=301, Location='http://example.com/docs/'), Response()]
        result = web_page.read_page('https://example.com/docs')
        self.assertEqual(result['final_url'], 'https://example.com/docs/')
        self.assertEqual(self.create.call_count, 2)
        self.assertEqual(self.connection.request.call_args.args[:2], ('GET', '/docs/'))

    def test_http_redirect_credentials_ports_and_loop_rejected(self):
        for location in ['http://user:pass@example.com/', 'http://example.com:8080/', 'http://other.example.com/']:
            self.connection.getresponse.return_value = Response(status=301, Location=location)
            with self.subTest(location=location), self.assertRaises(ValueError):
                web_page.read_page('https://example.com/')
        self.connection.getresponse.side_effect = lambda: Response(status=301, Location='http://example.com/')
        self.create.reset_mock()
        with self.assertRaisesRegex(ValueError, '重定向次数'):
            web_page.read_page('https://example.com/')
        self.assertEqual(self.create.call_count, 3)

    def test_gzip_and_script_filter_and_main_priority(self):
        data = b'<nav>menu</nav><p>outside</p><main><h1>version</h1><script>malicious()</script><p>3.15</p></main>'
        self.connection.getresponse.return_value = Response(gzip.compress(data), Content_Encoding='gzip')
        result = web_page.read_page('https://example.com/')
        self.assertEqual(result['text'], 'version\n3.15')

    def test_gzip_bomb_binary_and_cancel(self):
        self.connection.getresponse.return_value = Response(gzip.compress(b'x' * (web_page.LIMIT + 10)), Content_Encoding='gzip')
        with self.assertRaisesRegex(ValueError, '解压'):
            web_page.read_page('https://example.com/')
        response = Response()
        response.headers.replace_header('Content-Type', 'application/pdf')
        self.connection.getresponse.return_value = response
        with self.assertRaisesRegex(ValueError, 'HTML'):
            web_page.read_page('https://example.com/')
        with self.assertRaisesRegex(ValueError, '取消'):
            web_page.read_page('https://example.com/', cancellation=lambda: True)

    def test_tls_uses_original_host_with_pinned_ip(self):
        self.factory.stop()
        raw = MagicMock()
        with patch.object(socket, 'create_connection', return_value=raw) as connect, patch.object(web_page.ssl, 'create_default_context') as context:
            connection = web_page.PinnedHTTPSConnection('example.com', '93.184.216.34', 10)
            connection.connect()
            connect.assert_called_once_with(('93.184.216.34', 443), 10)
            context.return_value.wrap_socket.assert_called_once_with(raw, server_hostname='example.com', do_handshake_on_connect=False)
            context.return_value.wrap_socket.return_value.do_handshake.assert_called_once()

    def test_cancel_interrupts_headers_when_connection_socket_detached(self):
        cancellation = {'cancelled': False}
        closed = threading.Event()
        self.connection.sock = None
        self.connection.active_socket.shutdown.side_effect = lambda _: closed.set()
        def headers():
            cancellation['cancelled'] = True
            self.assertTrue(closed.wait(1), 'deadline guard failed to close active socket')
            raise OSError('closed')
        self.connection.getresponse.side_effect = headers
        with self.assertRaisesRegex(ValueError, '取消'):
            web_page.read_page('https://example.com/', cancellation=cancellation)

    def test_ipv4_preferred_after_validating_all_answers(self):
        with patch.object(socket, 'getaddrinfo', return_value=[(10,1,6,'',('2606:4700::1111',443,0,0)), (2,1,6,'',('93.184.216.34',443))]):
            web_page.read_page('https://example.com/')
        self.assertEqual(self.create.call_args.args[1], '93.184.216.34')

    def test_fake_ip_only_doh_fallback(self):
        fake = [(2,1,6,'',('198.18.0.70',443))]
        with patch.object(socket, 'getaddrinfo', return_value=fake), patch.object(web_page, '_doh_addresses', return_value=['93.184.216.34']) as doh:
            web_page.read_page('https://example.com/')
            self.assertEqual(doh.call_args.args[0], 'example.com')
        for addresses in [['127.0.0.1'], ['198.18.0.70', '10.0.0.1'], ['198.18.0.70', '93.184.216.34']]:
            with patch.object(socket, 'getaddrinfo', return_value=[(2,1,6,'',(a,443)) for a in addresses]), patch.object(web_page, '_doh_addresses') as doh:
                with self.assertRaises(ValueError):
                    web_page.read_page('https://example.com/')
                doh.assert_not_called()

    def test_doh_limits_status_redirect_and_public_addresses(self):
        connection = MagicMock()
        valid = {'Status': 0, 'Answer': [{'type': 1, 'data': '93.184.216.34'}]}
        for data, status, success in [(json.dumps(valid).encode(),200,True),
                (json.dumps({'Status': 2, 'Answer': []}).encode(),200,False),
                (json.dumps({'Status': 0, 'Answer': [{'type': 1, 'data': '127.0.0.1'}]}).encode(),200,False),
                (json.dumps({'Status': 0, 'Answer': [{'type': 1, 'data': '224.0.0.1'}]}).encode(),200,False),
                (b'x'*65537,200,False), (b'',302,False)]:
            connection.getresponse.return_value = Response(data, status=status)
            with self.subTest(status=status, success=success), patch.object(web_page.http.client, 'HTTPSConnection', return_value=connection) as factory:
                if success:
                    self.assertEqual(web_page._doh_addresses('example.com', lambda: None, time.monotonic()+2), ['93.184.216.34'])
                    self.assertLessEqual(factory.call_args.kwargs['timeout'], 2)
                    self.assertEqual(factory.call_args.args, ('dns.google',))
                    self.assertNotIn('Authorization', connection.request.call_args.kwargs['headers'])
                else:
                    with self.assertRaises(ValueError):
                        web_page._doh_addresses('example.com', lambda: None, time.monotonic()+2)

    def test_cancel_while_doh_waiting(self):
        cancelled = threading.Event()
        def check():
            if cancelled.is_set():
                raise ValueError('取消')
        def doh(*args):
            cancelled.set()
            time.sleep(.2)
            return ['93.184.216.34']
        with patch.object(socket, 'getaddrinfo', return_value=[(2,1,6,'',('198.18.0.70',443))]), patch.object(web_page, '_doh_addresses', side_effect=doh):
            with self.assertRaisesRegex(ValueError, '取消'):
                web_page.resolve_public('example.com', check, time.monotonic()+1)
