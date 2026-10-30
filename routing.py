"""What every Writer route module shares: the router, who is asking, and strict readers for request values."""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from ..tools.errors import BadRequest, Forbidden, Unauthorized
from ..tools.server import Request, Router
from .session import DocumentSession

router = Router()

_SID = re.compile(r"[A-Za-z0-9_-]{8,40}")
MAX_PATH = 1024


def session_of(app: Any, req: Request) -> DocumentSession:
    return app.sessions.get(req.params["sid"])


def who(app: Any, req: Request) -> tuple[str, dict[str, Any] | None, str]:
    """``(profile id, account or None, plan)`` for this request."""
    profile, account = app.profile_of(req)
    return profile, account, app.plan_of(account)


def need_account(app: Any, req: Request) -> dict[str, Any]:
    account = app.accounts.account_for(req.headers.get("cookie", ""))
    if account is None:
        raise Unauthorized("Sign in to do this.", details={"needsLogin": True})
    return account


def text(body: dict[str, Any], key: str, *, required: bool = True, max_len: int = 10_000, default: str = "") -> str:
    value = body.get(key, default)
    if value is None:
        value = default
    if not isinstance(value, str):
        raise BadRequest(f"'{key}' must be text")
    if required and not value.strip():
        raise BadRequest(f"'{key}' is required")
    if len(value) > max_len:
        raise BadRequest(f"'{key}' is too long")
    return value


def flag(body: dict[str, Any], key: str, default: bool = False) -> bool:
    value = body.get(key, default)
    if not isinstance(value, bool):
        raise BadRequest(f"'{key}' must be true or false")
    return value


def whole(body: dict[str, Any], key: str, *, low: int, high: int, default: int | None = None, required: bool = False) -> int | None:
    value = body.get(key, default)
    if value is None:
        if required:
            raise BadRequest(f"'{key}' is required")
        return None
    if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
        raise BadRequest(f"'{key}' must be a whole number from {low} to {high}")
    return value


def base_version(body: dict[str, Any]) -> int | None:
    value = body.get("base")
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise BadRequest("'base' must be the document version you last saw")
    return value


def clean_path(raw: Any, *, what: str = "path") -> Path:
    """A user-chosen file-system path. Absolute after ``~`` expansion; no NUL bytes; bounded. (The person is allowed to choose any place
    they could reach themselves: this is a local application, not a server. Names inside a chosen folder are validated separately.)"""
    if not isinstance(raw, str) or not raw.strip():
        raise BadRequest(f"Choose a {what}.")
    if len(raw) > MAX_PATH or "\x00" in raw:
        raise BadRequest(f"That {what} is not valid.")
    path = Path(raw.strip()).expanduser()
    if not path.is_absolute():
        raise BadRequest(f"The {what} must be a full path (for example starting with / or C:\\).")
    return path


def device_label(req: Request) -> str:
    agent = req.headers.get("user-agent", "")
    browser = next((n for n in ("Edg", "Firefox", "Chrome", "Safari") if n in agent), "Browser")
    system = next((n for n in ("Windows", "Mac OS", "Linux", "Android", "iPhone") if n in agent), "")
    return f"{'Edge' if browser == 'Edg' else browser}{' on ' + system.replace('Mac OS', 'macOS') if system else ''}"


def cookie_value(req: Request, name: str) -> str | None:
    for part in req.headers.get("cookie", "").split(";"):
        key, _, value = part.strip().partition("=")
        if key == name:
            return value
    return None


def set_cookie(name: str, value: str, max_age: int | None) -> str:
    age = f"; Max-Age={int(max_age)}" if max_age else ""
    return f"{name}={value}; Path=/; HttpOnly; SameSite=Strict{age}"


def clear_cookie(name: str) -> str:
    return f"{name}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0"


def require_signed_in_owner(session: DocumentSession) -> None:
    if session.role() != "owner":
        raise Forbidden("Only the document's owner can do this.")
