"""Integration checks for canonical API registration and document application workflows."""
from __future__ import annotations

import importlib
import sys
from unittest.mock import patch

from applications.slai_writer import app as writer_app
from applications.slai_writer import routes, routing, routes_account, routes_core, routes_docs, routes_tools
from applications.slai_writer.api import routing as api_routing
from applications.slai_writer.api.routes import accounts, core, documents, tools
from applications.slai_writer.app.commands.documents import travel_history
from applications.slai_writer.app.queries.documents import history_stack
from applications.slai_writer.app.services.document_lifecycle import create_document

from .api_helpers import ApiCase


class ArchitectureCompatibility(ApiCase):
    def test_single_router_and_legacy_handler_identity(self):
        self.assertIs(routes.router, routing.router)
        self.assertIs(routing.router, api_routing.router)
        for legacy, canonical, handler in ((routes_account, accounts, "login"),
                                           (routes_core, core, "prefs_put"),
                                           (routes_docs, documents, "doc_new"),
                                           (routes_tools, tools, "document_fonts")):
            self.assertIs(getattr(legacy, handler), getattr(canonical, handler))
        self.assertEqual(len(routes.router.routes), len({(method, regex.pattern) for method, regex, _ in routes.router.routes}))
        self.assertGreater(len(routes.router.routes), 100)

    def test_app_package_re_exports_the_runtime_and_any_import_order_works(self):
        runtime = importlib.import_module("applications.slai_writer.app.runtime")
        for name in ("WriterApp", "build_server", "load_settings", "main", "PREF_SCHEMA", "PREF_DEFAULTS", "BUILTIN_CURSORS", "CURSOR_KINDS", "Settings"):
            self.assertIs(getattr(writer_app, name), getattr(runtime, name), name)
        self.assertIn("WriterApp", dir(writer_app))
        self.assertTrue((runtime.HERE / "dist").parent.joinpath("configs", "config.yaml").is_file())     # the Writer directory, not the app/ package
        with self.assertRaises(AttributeError):
            writer_app.no_such_name                                                                        # noqa: B018
        # The packages depend on each other without a circle, so each can be the first one imported (a fresh interpreter each time).
        import subprocess
        root = str(__import__("pathlib").Path(__file__).resolve().parents[3])
        for first in ("routes", "app", "app.runtime", "api.routes.core", "api.routes.documents", "ops", "tableops", "table_styles", "columns", "book", "shape_validation"):
            done = subprocess.run([sys.executable, "-c", f"import applications.slai_writer.{first}"], cwd=root, env={**__import__("os").environ, "PYTHONPATH": root},
                                  capture_output=True, text=True)
            self.assertEqual(done.returncode, 0, f"{first}: {done.stderr[-400:]}")

    def test_app_use_cases_are_reachable_through_real_http(self):
        state = self.new_doc("Layer smoke")
        self.assertTrue(state["path"].endswith("Layer smoke.sldc"))
        # A deferred import in the export adapter must still resolve after its relocation.
        self.assertIn("sldc", str(self.web.ok("GET", "/api/exchange/formats")).lower())
        self.assertEqual(self.web.ok("GET", f"/api/docs/{state['sid']}/history-stack"), {"undo": [], "redo": []})
        self.assertEqual(self.web.ok("GET", "/api/prefs")["last_folder"], str(self.docs))
        saved = self.web.ok("POST", f"/api/docs/{state['sid']}/save-as", {"name": "Layer copy", "directory": str(self.docs), "newCopy": True})
        self.assertTrue(saved["path"].endswith("Layer copy.sldc"))
        self.assertTrue((self.docs / "Layer copy.sldc").is_file())

    def test_creation_failure_cleans_up_session(self):
        before = {item["sid"] for item in self.app.sessions.listing()}
        with patch("applications.slai_writer.session.DocumentSession.save_as", side_effect=OSError("write failed")):
            with self.assertRaisesRegex(OSError, "write failed"):
                create_document(self.app, name="Will not save", template_id="blank", directory=self.docs,
                                suggested_name=False, page_size=None, orientation=None, language=None,
                                accessible_headings=True, profile="guest", account=None, plan="guest")
        self.assertEqual({item["sid"] for item in self.app.sessions.listing()}, before)

    def test_history_commands_reject_stale_multi_step_without_mutation(self):
        state = self.new_doc("History layers")
        sid = state["sid"]
        block_id = state["blocks"][0]["id"]
        current = state["version"]
        for word in ("first", "second"):
            change = self.web.ok("POST", f"/api/docs/{sid}/ops", {
                "op": {"op": "block_insert", "after": block_id, "block": {"type": "paragraph", "text": word}},
                "base": current,
            })
            current = change["version"]
        status, payload = self.web.api("POST", f"/api/docs/{sid}/undo", {"count": 2, "base": state["version"]})
        self.assertEqual(status, 409)
        self.assertEqual(payload["error"]["details"]["kind"], "stale_version")
        self.assertEqual(self.web.ok("GET", f"/api/docs/{sid}")["version"], current)
        undone = self.web.ok("POST", f"/api/docs/{sid}/undo", {"count": 2, "base": current})["state"]
        self.assertEqual(len(undone["blocks"]), len(state["blocks"]))
        status, _ = self.web.api("POST", f"/api/docs/{sid}/redo", {"count": 2, "base": current})
        self.assertEqual(status, 409)
        redone = self.web.ok("POST", f"/api/docs/{sid}/redo", {"count": 2, "base": undone["version"]})["state"]
        self.assertEqual(len(redone["blocks"]), len(state["blocks"]) + 2)
        self.assertIsInstance(history_stack(self.app.sessions.get(sid))["undo"], list)

    def test_new_layers_do_not_replace_the_session_undo_engine(self):
        state = self.new_doc("Boundaries")
        session = self.app.sessions.get(state["sid"])
        self.assertIs(travel_history.__globals__["DocumentSession"], type(session))
        self.assertEqual(history_stack(session), {"undo": [], "redo": []})
