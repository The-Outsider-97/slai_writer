import io
import tempfile
import types
import unittest
from pathlib import Path

from applications.slai_writer import templates
from applications.slai_writer.protect import MasterKey
from applications.slai_writer.session import DocumentSession, sldc
from applications.slai_writer.store import WriterStore

SIGNATURE_SETTINGS = {"max_distinct": 2, "max_samples": 20}


class Workbench(unittest.TestCase):
    """A temporary data folder with a store, a master key and a document folder."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.store = WriterStore(self.root / "data")
        self.addCleanup(self.store.db.close)
        self.key = MasterKey(self.root / "data" / "master.key")
        self.app = types.SimpleNamespace(store=self.store, key=self.key, settings=types.SimpleNamespace(signatures=SIGNATURE_SETTINGS))
        (self.root / "docs").mkdir()

    def new_session(self, template="blank", title="Test document", name="test", profile="guest", text=None):
        package = templates.build(sldc(), template, title=title)
        session = DocumentSession(self.store, package, path=self.root / "docs" / f"{name}.sldc", profile=profile)
        if text is not None:
            first = session.doc["blocks"][-1]["id"]
            session.apply({"op": "text", "block": first, "start": 0, "end": len(session.doc["blocks"][-1]["text"]), "insert": text}, None)
        return session


def png(width=200, height=80, ink=True) -> bytes:
    from PIL import Image, ImageDraw
    image = Image.new("RGBA", (width, height), (255, 255, 255, 0))
    if ink:
        draw = ImageDraw.Draw(image)
        draw.line([(10, 60), (60, 20), (110, 60), (180, 15)], fill=(10, 10, 80, 255), width=4)
    out = io.BytesIO()
    image.save(out, "PNG")
    return out.getvalue()
