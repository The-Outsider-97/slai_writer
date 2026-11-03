
"""Compatibility entry for the SLAI Writer application runtime.

The repository contains both ``app.py`` (the existing runtime) and this
``app/`` package (reserved for application subcomponents). Python resolves
``from applications.slai_writer import app`` to the package first. Load the
existing runtime under a distinct, stable name, preserving its public API
without copying its implementation or preventing future ``app.*`` modules.
"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

_RUNTIME = "applications.slai_writer._app_runtime"
if _RUNTIME not in sys.modules:
    _file = Path(__file__).resolve().parent.parent / "app.py"
    _spec = importlib.util.spec_from_file_location(_RUNTIME, _file)
    if _spec is None or _spec.loader is None:
        raise ImportError(f"Cannot load SLAI Writer runtime from {_file}")
    _module = importlib.util.module_from_spec(_spec)
    sys.modules[_RUNTIME] = _module
    try:
        _spec.loader.exec_module(_module)
    except BaseException:
        del sys.modules[_RUNTIME]
        raise
_module = sys.modules[_RUNTIME]
for _name in dir(_module):
    if not _name.startswith("_"):
        globals()[_name] = getattr(_module, _name)
