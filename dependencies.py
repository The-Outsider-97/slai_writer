"""Optional Python packages, checked in one place.

Writer starts without any of them and says exactly what is missing when a feature needs one (503 ``dependency_missing``). The check is an
explicit lookup of the package, not an ``import`` wrapped in ``except``: a package that is not installed gives the clear message, and a
package that is installed but broken fails loudly with its own error instead of being reported as missing.
"""
from __future__ import annotations

import sys
from importlib import import_module
from importlib.util import find_spec
from types import ModuleType

from ..tools.errors import DependencyMissing


def installed(module: str) -> bool:
    """Whether the (possibly dotted) module can be found, without importing the module itself."""
    parts = module.split(".")
    for end in range(1, len(parts) + 1):
        name = ".".join(parts[:end])
        if name in sys.modules:                                      # already imported: certainly there (and find_spec rejects some loaded modules)
            continue
        if find_spec(name) is None:                                  # parents are checked first: find_spec on a child would import a missing parent
            return False
    return True


def require(module: str, *, needed_for: str, package: str | None = None) -> ModuleType:
    """The module, or :class:`DependencyMissing` naming the package to install and what it is needed for."""
    if not installed(module):
        name = package or module.split(".")[0]
        raise DependencyMissing(f"{needed_for} needs the '{name}' package (pip install {name}).",
                                hint="See docs/OPERATIONS.md for the optional dependency.")
    return import_module(module)
