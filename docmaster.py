"""The link to Documaster, SLAI's document converter. Writer reuses its readers and writers (DOCX, ODT, RTF, HTML, Markdown, PDF, text)
instead of carrying its own; nothing of Documaster is copied. Documaster's package is named ``slai``, so it is loaded under the alias
``documaster_slai`` (the same convention SLAI Reader uses) and its files are never modified. When it is missing, ``available`` is False
and every feature that needs it says so.
"""
from __future__ import annotations

import importlib
import importlib.util
import sys
import threading
from pathlib import Path
from types import ModuleType
from typing import Any

from ..tools.errors import DependencyMissing

ALIAS = "documaster_slai"


class DocumasterLink:
    def __init__(self, slai_root: Path | None, data_dir: Path) -> None:
        self.slai_root = slai_root
        self.data_dir = data_dir
        self.available = False
        self.reason: str | None = None
        self.version: str | None = None
        self.services: Any = None
        self._lock = threading.Lock()
        self._loaded = False

    def locate(self) -> Path | None:
        if self.slai_root is None:
            return None
        pkg = self.slai_root / "applications" / "Documaster" / "slai"
        return pkg if (pkg / "__init__.py").is_file() else None

    def load(self) -> "DocumasterLink":
        with self._lock:
            if self._loaded:
                return self
            self._loaded = True
            pkg = self.locate()
            if pkg is None:
                self.reason = "Documaster was not found under applications/Documaster of the SLAI checkout."
                return self
            try:
                if ALIAS not in sys.modules:
                    spec = importlib.util.spec_from_file_location(ALIAS, pkg / "__init__.py", submodule_search_locations=[str(pkg)])
                    assert spec and spec.loader
                    module = importlib.util.module_from_spec(spec)
                    sys.modules[ALIAS] = module
                    spec.loader.exec_module(module)
                self.version = getattr(sys.modules[ALIAS], "__version__", None)
                bridge = importlib.import_module(f"{ALIAS}.bridge")
                bridge.activate(self.slai_root)
                config = importlib.import_module(f"{ALIAS}.config")
                services = importlib.import_module(f"{ALIAS}.services")
                settings = config.Settings(agents="none", data_dir=self.data_dir / "documaster", agent_read_default=False)
                settings.slai_root = self.slai_root
                settings.data_dir.mkdir(parents=True, exist_ok=True)
                self.services = services.Services.create(settings)
                self.available = True
            except Exception as exc:  # noqa: BLE001
                sys.modules.pop(ALIAS, None)
                for name in [n for n in sys.modules if n.startswith(ALIAS + ".")]:
                    sys.modules.pop(name, None)
                self.reason = f"Documaster could not be loaded: {type(exc).__name__}: {str(exc)[:240]}"
            return self

    def module(self, dotted: str) -> ModuleType:
        if not self.available:
            raise DependencyMissing(self.reason or "Documaster is not available",
                                    hint="Import and export of Word, OpenDocument, RTF, HTML, PDF and Markdown files need Documaster.")
        return importlib.import_module(f"{ALIAS}.{dotted}")

    def status(self) -> dict[str, Any]:
        return {"available": self.available, "reason": self.reason, "version": self.version}

    def close(self) -> None:
        if self.services is not None:
            try:
                self.services.agents.close()
            except Exception:  # noqa: BLE001
                pass
