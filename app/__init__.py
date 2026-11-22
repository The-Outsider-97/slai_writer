"""Writer's application layer.

``app.runtime`` holds the application object, settings and start-up; ``app.commands``, ``app.queries`` and ``app.services`` hold the use cases the
HTTP layer calls. The runtime's public names stay importable from here (``from applications.slai_writer.app import WriterApp``), but they are
loaded on first use: the HTTP layer imports ``app.commands`` while the runtime is itself importing the HTTP layer, so loading the runtime when
this package is first imported would make the two wait for each other.
"""
from __future__ import annotations

from importlib import import_module
from typing import Any

__all__ = ["runtime", "commands", "queries", "services"]


def __getattr__(name: str) -> Any:
    if name.startswith("__"):
        raise AttributeError(name)
    runtime = import_module(".runtime", __name__)
    if hasattr(runtime, name):
        return getattr(runtime, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


def __dir__() -> list[str]:
    runtime = import_module(".runtime", __name__)
    return sorted({*globals(), *(n for n in dir(runtime) if not n.startswith("_"))})
