"""Project-local, opt-in test credential and request budget. Never imports production config."""
import ctypes
from ctypes import wintypes
from datetime import datetime, timezone, timedelta
import json
import os
from pathlib import Path

WORKSPACE = Path(__file__).resolve().parents[2]
SECRET = WORKSPACE / '.BiliNote-dev/secrets/gcli-test.json'
AUTHORIZED_URL = 'https://gcli.ggchan.dev/v1'


def credential():
    saved = json.loads(SECRET.read_text(encoding='utf-8-sig'))
    if saved.get('base_url') != AUTHORIZED_URL:
        raise ValueError('Test endpoint differs from the explicitly authorized site')
    class Blob(ctypes.Structure):
        _fields_ = [('size', wintypes.DWORD), ('data', ctypes.POINTER(ctypes.c_ubyte))]
    raw = bytes.fromhex(saved['api_key_dpapi'])
    buf = ctypes.create_string_buffer(raw)
    incoming = Blob(len(raw), ctypes.cast(buf, ctypes.POINTER(ctypes.c_ubyte)))
    outgoing = Blob()
    crypt = ctypes.WinDLL('crypt32', use_last_error=True)
    crypt.CryptUnprotectData.argtypes = [ctypes.POINTER(Blob), ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(Blob)]
    crypt.CryptUnprotectData.restype = wintypes.BOOL
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.LocalFree.argtypes = [ctypes.c_void_p]
    if not crypt.CryptUnprotectData(ctypes.byref(incoming), None, None, None, None, 0, ctypes.byref(outgoing)):
        raise RuntimeError('Current Windows account cannot decrypt test credential')
    try:
        key = ctypes.string_at(outgoing.data, outgoing.size).decode('utf-16-le')
    finally:
        ctypes.memset(outgoing.data, 0, outgoing.size)
        kernel.LocalFree(outgoing.data)
    return key, saved


class TestBudget:
    """No retries; reserve each request before dispatch, including failed calls."""
    def __init__(self, maximum=8):
        if not 1 <= maximum <= 8:
            raise ValueError('Per-run test limit must be 1..8')
        self.maximum, self.calls = maximum, 0

    def reserve(self):
        if self.calls >= self.maximum:
            raise RuntimeError('PROJECT_TEST_CALL_BUDGET_EXHAUSTED')
        ledger = SECRET.parent / 'gcli-test-usage.json'
        lock = SECRET.parent / 'gcli-test-usage.lock'
        # Concurrent test runs must not silently race or wait indefinitely.
        fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        try:
            day = datetime.now(timezone(timedelta(hours=8))).date().isoformat()
            state = json.loads(ledger.read_text(encoding='utf-8')) if ledger.exists() else {}
            count = state.get('calls', 0) if state.get('date') == day else 0
            if not isinstance(count, int) or count >= 1000:
                raise RuntimeError('LOCAL_DAILY_TEST_LIMIT_EXHAUSTED')
            temporary = ledger.with_suffix('.tmp')
            temporary.write_text(json.dumps({'date': day, 'calls': count + 1,
                'scope': 'requests from this project test harness only; not provider quota'}), encoding='utf-8')
            temporary.replace(ledger)
            self.calls += 1
        finally:
            os.close(fd)
            lock.unlink()
