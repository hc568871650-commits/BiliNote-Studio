"""Transparent local secret protection using Windows DPAPI with seamless legacy plaintext fallback."""
from __future__ import annotations

import base64
import ctypes
from ctypes import wintypes
import sys

DPAPI_PREFIX = "dpapi:v1:"
_CRYPTPROTECT_UI_FORBIDDEN = 0x1


class _DATA_BLOB(ctypes.Structure):
    _fields_ = [
        ("cbData", wintypes.DWORD),
        ("pbData", ctypes.POINTER(ctypes.c_byte)),
    ]


def is_encrypted_secret(value: str | None) -> bool:
    return isinstance(value, str) and value.startswith(DPAPI_PREFIX)


def _dpapi_protect(raw: bytes) -> bytes:
    crypt32 = ctypes.windll.crypt32
    kernel32 = ctypes.windll.kernel32
    buf = ctypes.create_string_buffer(raw, len(raw))
    in_blob = _DATA_BLOB(len(raw), ctypes.cast(buf, ctypes.POINTER(ctypes.c_byte)))
    out_blob = _DATA_BLOB()
    if not crypt32.CryptProtectData(
        ctypes.byref(in_blob),
        None,
        None,
        None,
        None,
        _CRYPTPROTECT_UI_FORBIDDEN,
        ctypes.byref(out_blob),
    ):
        raise OSError(f"DPAPI CryptProtectData failed: {ctypes.GetLastError()}")
    try:
        return ctypes.string_at(out_blob.pbData, out_blob.cbData)
    finally:
        kernel32.LocalFree(out_blob.pbData)


def _dpapi_unprotect(cipher: bytes) -> bytes:
    crypt32 = ctypes.windll.crypt32
    kernel32 = ctypes.windll.kernel32
    buf = ctypes.create_string_buffer(cipher, len(cipher))
    in_blob = _DATA_BLOB(len(cipher), ctypes.cast(buf, ctypes.POINTER(ctypes.c_byte)))
    out_blob = _DATA_BLOB()
    if not crypt32.CryptUnprotectData(
        ctypes.byref(in_blob),
        None,
        None,
        None,
        None,
        _CRYPTPROTECT_UI_FORBIDDEN,
        ctypes.byref(out_blob),
    ):
        raise OSError(f"DPAPI CryptUnprotectData failed: {ctypes.GetLastError()}")
    try:
        return ctypes.string_at(out_blob.pbData, out_blob.cbData)
    finally:
        kernel32.LocalFree(out_blob.pbData)


def encrypt_secret(plaintext: str | None) -> str:
    """Encrypt a secret using current-user Windows DPAPI; empty or already-encrypted strings pass through."""
    if not plaintext:
        return ""
    text = str(plaintext)
    if is_encrypted_secret(text):
        return text
    if sys.platform != "win32":
        return text
    protected = _dpapi_protect(text.encode("utf-8"))
    return DPAPI_PREFIX + base64.b64encode(protected).decode("ascii")


def decrypt_secret(stored: str | None) -> str:
    """Decrypt a DPAPI-protected secret; legacy plaintext values are returned seamlessly as-is."""
    if not stored:
        return ""
    text = str(stored)
    if not is_encrypted_secret(text):
        return text
    if sys.platform != "win32":
        return ""
    payload = base64.b64decode(text[len(DPAPI_PREFIX):].encode("ascii"))
    return _dpapi_unprotect(payload).decode("utf-8")
