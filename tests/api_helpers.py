"""A real Writer server on a random loopback port, and a tiny browser-like client (cookie jar, marker header) to drive it."""
from __future__ import annotations

import dataclasses
import http.client
import json
import re
import tempfile
import threading
import unittest
from http.cookies import SimpleCookie
from pathlib import Path

from applications.tools import slai
from applications.slai_writer import app as writer_app
from applications.slai_writer.accounts import CODE_LENGTH

TOKEN = "unit-test-token"


class Outbox:
    """Stands in for the SMTP transport: it records the messages a real mail server would receive."""

    def __init__(self) -> None:
        self.sent: list[tuple[str, str, str]] = []

    def status(self):
        return {"configured": True, "reason": None}

    def send(self, to, subject, body):
        self.sent.append((to, subject, body))

    def last_code(self) -> str:
        return re.search(r"^(\S{%d})$" % CODE_LENGTH, self.sent[-1][2], re.M).group(1)


class Browser:
    def __init__(self, server) -> None:
        self.port = server.port
        self.identity = server.identity
        self.jar: dict[str, str] = {self.identity.cookie: TOKEN}

    def request(self, method, path, body=None, *, raw=None, headers=None, marker=True, cookies=True):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=30)
        send = dict(headers or {})
        if cookies:
            send["Cookie"] = "; ".join(f"{k}={v}" for k, v in self.jar.items())
        if marker and method in ("POST", "PUT", "PATCH", "DELETE"):
            send[self.identity.marker] = "1"
        payload = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
        if raw is None and payload is not None:
            send["Content-Type"] = "application/json"
        conn.request(method, path, body=payload, headers=send)
        response = conn.getresponse()
        data = response.read()
        for header, value in response.getheaders():
            if header.lower() == "set-cookie":
                jar = SimpleCookie()
                jar.load(value)
                for name, morsel in jar.items():
                    if morsel.value == "" or morsel["max-age"] == "0":
                        self.jar.pop(name, None)
                    else:
                        self.jar[name] = morsel.value
        conn.close()
        return response, data

    def api(self, method, path, body=None, **kw):
        response, data = self.request(method, path, body, **kw)
        try:
            return response.status, json.loads(data)
        except ValueError:
            return response.status, data

    def ok(self, method, path, body=None, **kw):
        status, payload = self.api(method, path, body, **kw)
        assert status < 300 and payload["ok"], (method, path, status, payload)
        return payload["data"]


class ApiCase(unittest.TestCase):
    """Boots one server per test class; each test gets a fresh browser and a fresh document folder."""

    mail: Outbox
    server = None
    app = None

    @classmethod
    def setUpClass(cls) -> None:
        cls.tmp = tempfile.TemporaryDirectory()
        cls.root = Path(cls.tmp.name)
        root = slai.find_slai_root()
        slai.activate(root)
        settings = writer_app.load_settings(None, str(cls.root / "data"), 8770)
        settings = dataclasses.replace(settings, port=0, library_root=str(cls.root / "library"))
        cls.mail = Outbox()
        client = cls.root / "client"
        client.mkdir()
        (client / "index.html").write_text("<!doctype html><title>t</title>", encoding="utf-8")
        cls.server, cls.app = writer_app.build_server(settings, TOKEN, root=root, client_dir=client, mailer=cls.mail)
        cls.thread = threading.Thread(target=cls.server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()
        cls.app.close()
        cls.tmp.cleanup()

    def setUp(self) -> None:
        self.web = Browser(self.server)
        self.docs = self.root / f"docs-{self._testMethodName}"
        self.docs.mkdir(exist_ok=True)

    def new_doc(self, name="Draft", template="blank", **extra):
        return self.web.ok("POST", "/api/docs/new", {"name": name, "template": template, "directory": str(self.docs), **extra})
