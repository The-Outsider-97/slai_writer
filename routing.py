"""Legacy import path for Writer's canonical API request and routing helpers."""
from __future__ import annotations

from .api.routing import (MAX_PATH, base_version, clean_path, clear_cookie, cookie_value,
                          device_label, flag, need_account, require_signed_in_owner,
                          router, session_of, set_cookie, text, who, whole)

__all__ = ["MAX_PATH", "base_version", "clean_path", "clear_cookie", "cookie_value",
           "device_label", "flag", "need_account", "require_signed_in_owner",
           "router", "session_of", "set_cookie", "text", "who", "whole"]
