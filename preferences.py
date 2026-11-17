"""Writer's preference schema and defaults, and the cursor vocabulary they validate against.

Kept apart from the application object so that the HTTP layer can read the vocabulary without importing the runtime that serves it.
"""
from __future__ import annotations

from typing import Any

from ..tools.storage import Pref

CURSOR_KINDS = ("default", "drag", "draw", "text")
BUILTIN_CURSORS = ("auto", "default", "pointer", "crosshair", "grab", "move", "text", "cell", "copy", "alias")
CURSOR_PATTERN = r"(?:auto|default|pointer|crosshair|grab|move|text|cell|copy|alias|custom:[A-Za-z0-9_-]{6,64})"

PREF_SCHEMA = {
    "theme": Pref(str, allowed=("system", "light", "dark", "contrast")),
    "scale": Pref(float, low=0.85, high=1.4),
    "motion": Pref(str, allowed=("system", "reduce")),
    "autosave": Pref(bool),
    "autosave_seconds": Pref(int, low=10, high=3600),
    "language": Pref(str, max_len=12, pattern=r"[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?"),
    "page_size": Pref(str, allowed=("A4", "A5", "A3", "B5", "Letter", "Legal")),
    "orientation": Pref(str, allowed=("portrait", "landscape")),
    "units": Pref(str, allowed=("mm", "in")),
    "zoom": Pref(int, low=10, high=400),
    "zoom_mode": Pref(str, allowed=("custom", "height", "width", "entire")),
    "view_pages": Pref(int, low=1, high=4),
    "book_view": Pref(str, allowed=("facing", "single")),
    "show_rulers": Pref(bool),
    "show_guides": Pref(bool),
    "spell": Pref(bool),
    "grammar": Pref(bool),
    "style": Pref(bool),
    "ai_enabled": Pref(bool),
    "ai_cloud": Pref(bool),
    "ai_notes": Pref(bool),
    "ai_budget": Pref(int, low=0, high=100_000),
    "side_panel": Pref(bool),
    "cursor_default": Pref(str, max_len=80, pattern=CURSOR_PATTERN),
    "cursor_drag": Pref(str, max_len=80, pattern=CURSOR_PATTERN),
    "cursor_draw": Pref(str, max_len=80, pattern=CURSOR_PATTERN),
    "cursor_text": Pref(str, max_len=80, pattern=CURSOR_PATTERN),
    "last_folder": Pref(str, max_len=1024, pattern=r"[^\x00-\x1f]*"),
    "wizard_done": Pref(bool),
    "lookup_online": Pref(bool),
}
PREF_DEFAULTS: dict[str, Any] = {
    "theme": "system", "scale": 1.0, "motion": "system", "autosave": True, "autosave_seconds": 60, "language": "en", "page_size": "A4",
    "orientation": "portrait", "units": "mm", "zoom": 100, "zoom_mode": "height", "view_pages": 1, "book_view": "facing", "show_rulers": True, "show_guides": True, "spell": True,
    "grammar": True, "style": False, "ai_enabled": False, "ai_cloud": False, "ai_notes": False, "ai_budget": 0, "side_panel": False,
    "cursor_default": "default", "cursor_drag": "grab", "cursor_draw": "crosshair", "cursor_text": "text", "last_folder": "", "wizard_done": False, "lookup_online": False,
}
