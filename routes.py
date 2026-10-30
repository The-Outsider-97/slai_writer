"""Writer's HTTP routes. The handlers live in four modules; importing them registers every route on the one shared router."""
from __future__ import annotations

from . import routes_account, routes_core, routes_docs, routes_tools  # noqa: F401 - imported for their route registrations
from .routing import router

__all__ = ["router"]
