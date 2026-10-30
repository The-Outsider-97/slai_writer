"""The operating system's own file and folder dialogs, shown by a short-lived child process (tkinter).

A child process keeps the dialog's event loop away from the web server and means a missing or broken GUI toolkit costs nothing but
the dialog: callers fall back to the in-page chooser (:meth:`Library.browse`). Nothing is read from the chosen path here.
"""
from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
from pathlib import Path

from ..tools.errors import DependencyMissing

TIMEOUT_SECONDS = 600
KINDS = ("open", "folder", "save")

_SCRIPT = r"""
import json, sys
import tkinter
from tkinter import filedialog
kind, start, name, types = sys.argv[1], sys.argv[2], sys.argv[3], json.loads(sys.argv[4])
root = tkinter.Tk()
root.withdraw()
try:
    root.attributes("-topmost", True)
except Exception:
    pass
kw = {"initialdir": start or None}
filetypes = [tuple(t) for t in types] or [("All files", "*.*")]
if kind == "folder":
    path = filedialog.askdirectory(mustexist=True, **kw)
elif kind == "save":
    path = filedialog.asksaveasfilename(initialfile=name, filetypes=filetypes, defaultextension=filetypes[0][1].replace("*", ""), **kw)
else:
    path = filedialog.askopenfilename(filetypes=filetypes, **kw)
print(json.dumps({"path": path or None}))
"""


def available() -> bool:
    """Whether a native dialog can be shown here (tkinter importable). It does not prove a display exists; ``pick`` reports that."""
    return importlib.util.find_spec("tkinter") is not None


def pick(kind: str, *, start: str = "", name: str = "", types: list[tuple[str, str]] | None = None) -> Path | None:
    """Show a dialog and return the chosen path, or ``None`` if the person cancelled."""
    if kind not in KINDS:
        raise ValueError("kind must be open, folder or save")
    if not available():
        raise DependencyMissing("This computer's file dialog is not available to Writer.", hint="Use the chooser in the page instead.")
    start_dir = start if start and Path(start).is_dir() else ""
    try:
        done = subprocess.run([sys.executable, "-c", _SCRIPT, kind, start_dir, name, json.dumps(types or [])], capture_output=True, text=True,
                              timeout=TIMEOUT_SECONDS, check=False)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise DependencyMissing("The file dialog could not be shown.", hint="Use the chooser in the page instead.") from exc
    if done.returncode != 0:
        raise DependencyMissing("The file dialog could not be shown (no display, or the dialog toolkit failed).",
                                hint="Use the chooser in the page instead.")
    try:
        value = json.loads(done.stdout.strip().splitlines()[-1])["path"]
    except (ValueError, KeyError, IndexError):
        return None
    return Path(value) if value else None
