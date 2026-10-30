"""Custom pointer pictures (page 15 of the specification: "the user can import their own and assign them").

A cursor is a small PNG re-encoded here (so only pixels survive: no metadata, no scripts, no oddly-formed files) and saved in the data
folder. Which cursor is used for the default pointer, drag and drop, drawing and typing is an ordinary preference (``cursor_*``) that
names a built-in CSS cursor or ``custom:<id>``.
"""
from __future__ import annotations

import io
import json
import re
import secrets
from pathlib import Path
from typing import Any

from ..tools.errors import BadRequest, DependencyMissing, LimitExceeded, NotFound
from ..tools.storage import atomic_write
from ..tools.validation import utc_now

MAX_BYTES = 256 * 1024
MAX_SIDE = 128                  # browsers ignore cursor images larger than 128 x 128
MAX_CURSORS = 24
_ID = re.compile(r"[A-Za-z0-9_-]{6,64}")


class Cursors:
    def __init__(self, folder: Path) -> None:
        self.folder = Path(folder)

    def _meta(self, cid: str) -> Path:
        return self.folder / f"{cid}.json"

    def _check(self, cid: str) -> str:
        if not _ID.fullmatch(cid or ""):
            raise NotFound("That cursor does not exist.")
        return cid

    def listing(self) -> list[dict[str, Any]]:
        if not self.folder.is_dir():
            return []
        out = []
        for meta in sorted(self.folder.glob("*.json")):
            try:
                row = json.loads(meta.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            if (self.folder / f"{meta.stem}.png").is_file() and _ID.fullmatch(meta.stem):
                out.append({"id": meta.stem, "label": row.get("label", "Cursor"), "width": row.get("width"), "height": row.get("height"),
                            "hotspot": row.get("hotspot", [0, 0]), "created": row.get("created"), "value": f"custom:{meta.stem}"})
        return out

    def add(self, data: bytes, label: str, hotspot: tuple[int, int] = (0, 0)) -> dict[str, Any]:
        if len(data) > MAX_BYTES:
            raise LimitExceeded(f"A cursor picture is at most {MAX_BYTES // 1024} KiB.")
        if len(self.listing()) >= MAX_CURSORS:
            raise LimitExceeded(f"You can keep up to {MAX_CURSORS} custom cursors. Delete one to add another.")
        try:
            from PIL import Image
        except Exception as exc:  # noqa: BLE001
            raise DependencyMissing("Pillow is required to prepare cursor pictures (pip install pillow).") from exc
        try:
            with Image.open(io.BytesIO(data)) as image:
                if image.format not in ("PNG", "GIF", "WEBP"):
                    raise BadRequest("Use a PNG picture for a cursor.")
                image.load()
                rgba = image.convert("RGBA")
        except BadRequest:
            raise
        except Exception:  # noqa: BLE001
            raise BadRequest("That file is not a readable picture.") from None
        if rgba.width > MAX_SIDE or rgba.height > MAX_SIDE:
            rgba.thumbnail((MAX_SIDE, MAX_SIDE))
        hx = max(0, min(int(hotspot[0]), rgba.width - 1))
        hy = max(0, min(int(hotspot[1]), rgba.height - 1))
        out = io.BytesIO()
        rgba.save(out, "PNG", optimize=True)
        cid = secrets.token_urlsafe(9)
        self.folder.mkdir(parents=True, exist_ok=True)
        atomic_write(self.folder / f"{cid}.png", out.getvalue())
        meta = {"label": (label or "Cursor").strip()[:40] or "Cursor", "width": rgba.width, "height": rgba.height, "hotspot": [hx, hy],
                "created": utc_now()}
        atomic_write(self._meta(cid), json.dumps(meta).encode("utf-8"))
        return {"id": cid, "value": f"custom:{cid}", **meta}

    def png(self, cid: str) -> bytes:
        path = self.folder / f"{self._check(cid)}.png"
        try:
            return path.read_bytes()
        except OSError:
            raise NotFound("That cursor does not exist.") from None

    def delete(self, cid: str) -> None:
        self._check(cid)
        found = False
        for suffix in (".png", ".json"):
            try:
                (self.folder / f"{cid}{suffix}").unlink()
                found = True
            except OSError:
                pass
        if not found:
            raise NotFound("That cursor does not exist.")
