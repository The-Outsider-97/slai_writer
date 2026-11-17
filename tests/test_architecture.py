"""The shape of Writer's Python package, kept honest: no import circles, no empty placeholder modules, no import-and-catch for optional packages,
and one explicit way to ask whether an optional package is installed."""
from __future__ import annotations

import ast
import os
import unittest
from pathlib import Path

from applications.slai_writer import dependencies
from applications.tools.errors import DependencyMissing

ROOT = Path(__file__).resolve().parents[1]
PACKAGE = "applications.slai_writer"
SKIP = {"node_modules", "__pycache__", "dist", "docs", "tests", "tests_e2e", "tests_ts", "frontend", "scripts", "assets"}


def sources() -> dict[str, Path]:
    found: dict[str, Path] = {}
    for folder, dirs, files in os.walk(ROOT):
        dirs[:] = [d for d in dirs if d not in SKIP]
        for name in files:
            if name.endswith(".py"):
                path = Path(folder) / name
                relative = path.relative_to(ROOT).with_suffix("")
                parts = list(relative.parts)
                if parts[-1] == "__init__":
                    parts.pop()
                found[".".join([PACKAGE, *parts])] = path
    return found


def imports_at_module_level(module: str, path: Path, known: dict[str, Path]) -> set[str]:
    """The Writer modules this module imports when it is loaded (function bodies do not count: they run later)."""
    tree = ast.parse(path.read_text(encoding="utf-8"))
    base = module.split(".") if path.name == "__init__.py" else module.split(".")[:-1]
    out: set[str] = set()
    for node in tree.body:
        for inner in ast.walk(node) if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) else [node]:
            if isinstance(inner, ast.ImportFrom):
                prefix = base[: len(base) - (inner.level - 1)] if inner.level else []
                target = ".".join(prefix + ([inner.module] if inner.module else [])) if inner.level else (inner.module or "")
                for candidate in [target, *(f"{target}.{a.name}" for a in inner.names)]:
                    if candidate in known and candidate != module:
                        out.add(candidate)
    return out


class ArchitectureTests(unittest.TestCase):
    def test_no_module_waits_for_itself_to_be_imported(self):
        known = sources()
        graph = {m: imports_at_module_level(m, p, known) for m, p in known.items()}
        for start in graph:
            stack, seen = [(start, [start])], set()
            while stack:
                node, trail = stack.pop()
                for nxt in graph.get(node, ()):
                    if nxt == start:
                        self.fail("import circle: " + " -> ".join(x.removeprefix(PACKAGE + ".") for x in [*trail, nxt]))
                    if nxt not in seen:
                        seen.add(nxt)
                        stack.append((nxt, [*trail, nxt]))

    def test_no_empty_placeholder_modules_in_the_application_and_api_layers(self):
        for module, path in sources().items():
            if path.name == "__init__.py" or not module.startswith((f"{PACKAGE}.app.", f"{PACKAGE}.api.")):
                continue
            body = [n for n in ast.parse(path.read_text(encoding="utf-8")).body if not (isinstance(n, ast.Expr) and isinstance(getattr(n, "value", None), ast.Constant))]
            self.assertTrue(body, f"{module} defines nothing")
        for module, path in sources().items():
            if path.name == "__init__.py" and module.startswith((f"{PACKAGE}.app.", f"{PACKAGE}.api.")) and not path.read_text(encoding="utf-8").strip():
                siblings = [p for p in path.parent.glob("*.py") if p.name != "__init__.py"]
                self.assertTrue(siblings, f"{module} is an empty package with nothing in it")

    def test_optional_packages_are_asked_for_not_imported_and_caught(self):
        for module, path in sources().items():
            for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
                if isinstance(node, ast.ExceptHandler) and node.type is not None:
                    names = ast.unparse(node.type)
                    self.assertNotIn("ImportError", names, f"{module}:{node.lineno} catches ImportError; use dependencies.installed()/require()")
                    self.assertNotIn("ModuleNotFoundError", names, f"{module}:{node.lineno}")

    def test_dependencies_helper(self):
        self.assertTrue(dependencies.installed("json"))
        self.assertTrue(dependencies.installed("os.path"))
        self.assertTrue(dependencies.installed("json.decoder"))
        self.assertFalse(dependencies.installed("no_such_package_xyz"))
        self.assertFalse(dependencies.installed("no_such_package_xyz.sub.module"))
        self.assertFalse(dependencies.installed("json.no_such_child"))
        self.assertIs(dependencies.require("json", needed_for="Reading JSON"), __import__("json"))
        with self.assertRaises(DependencyMissing) as caught:
            dependencies.require("no_such_package_xyz.sub", needed_for="The widget", package="widget-pkg")
        self.assertIn("The widget needs the 'widget-pkg' package", caught.exception.message)
        self.assertIn("pip install widget-pkg", caught.exception.message)


if __name__ == "__main__":
    unittest.main()
