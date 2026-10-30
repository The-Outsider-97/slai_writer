"""RFC 6238 time-based one-time passwords (HMAC-SHA1, 6 digits, 30 s) built on the standard library, plus the ``otpauth://`` URI that
authenticator apps read from a QR code."""
from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
import struct
import time
from urllib.parse import quote

STEP = 30
DIGITS = 6


def new_secret() -> bytes:
    return secrets.token_bytes(20)


def b32(secret: bytes) -> str:
    return base64.b32encode(secret).decode("ascii").rstrip("=")


def code_at(secret: bytes, counter: int) -> str:
    digest = hmac.new(secret, struct.pack(">Q", counter), hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    value = (struct.unpack(">I", digest[offset:offset + 4])[0] & 0x7FFFFFFF) % (10 ** DIGITS)
    return f"{value:0{DIGITS}d}"


def counter_for(now: float) -> int:
    return int(now // STEP)


def verify(secret: bytes, code: str, now: float, last_used: int = 0, window: int = 1) -> int | None:
    """The counter that ``code`` matches within ±``window`` steps and that has not been used before, else ``None``."""
    code = "".join(ch for ch in code if ch.isdigit())
    if len(code) != DIGITS:
        return None
    current = counter_for(now)
    match: int | None = None
    for counter in range(current - window, current + window + 1):
        if hmac.compare_digest(code_at(secret, counter), code) and match is None:
            match = counter                                  # keep looping: constant work regardless of where the match is
    if match is None or match <= last_used:
        return None                                          # a code can be used once; an older counter is a replay
    return match


def otpauth_uri(secret: bytes, account: str, issuer: str = "SLAI Writer") -> str:
    return (f"otpauth://totp/{quote(issuer)}:{quote(account)}?secret={b32(secret)}&issuer={quote(issuer)}"
            f"&algorithm=SHA1&digits={DIGITS}&period={STEP}")


def now() -> float:
    return time.time()
