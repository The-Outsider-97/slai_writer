"""Public compatibility entry for Writer's single HTTP router.

Route implementations live in :mod:`.api.routes` and are registered once.
"""
from __future__ import annotations

from .api.routes import accounts, core, documents, tools  # noqa: F401 - route registration
from .api.routing import router

__all__ = ["router"]
