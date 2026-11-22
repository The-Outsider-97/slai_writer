"""Background housekeeping must be observable: a failing recovery write or autosave is recorded, logged and surfaced, never swallowed, while the
other documents and the loop itself keep working."""
from __future__ import annotations

import logging
import time
import unittest

from applications.tools.errors import Conflict

from .api_helpers import ApiCase


class FakeSession:
    def __init__(self, doc_id, *, recovery=None, save=None, path="x.sldc") -> None:
        self.doc_id, self.path, self.readonly_reason = doc_id, path, None
        self.dirty, self.last_edit, self.recovery_dirty = True, 0.0, True
        self.autosave, self.saved_at, self.notices = True, None, []
        self._recovery, self._save = recovery, save
        self.recovered = self.saves = 0

    def write_recovery(self):
        if self._recovery:
            raise self._recovery
        self.recovered += 1
        self.recovery_dirty = False

    def save(self):
        if self._save:
            raise self._save
        self.saves += 1


class Housekeeping(ApiCase):
    def setUp(self) -> None:
        super().setUp()
        self._all = self.app.sessions.all
        self.sessions: list[FakeSession] = []
        self.app.sessions.all = lambda: list(self.sessions)
        self.app.health.__init__()

    def tearDown(self) -> None:
        self.app.sessions.all = self._all

    def test_a_failing_recovery_write_is_recorded_and_does_not_stop_other_documents(self):
        bad, good = FakeSession("bad", recovery=OSError("disk full")), FakeSession("good")
        self.sessions[:] = [bad, good]
        with self.assertLogs("slai.writer.housekeeping", level=logging.WARNING) as logs:
            self.app.tick(now=time.time() + 1000)
        self.assertEqual(good.recovered, 1)                      # the healthy document was still served
        self.assertEqual(self.app.health.consecutive("recovery", "bad"), 1)
        self.assertIn("disk full", logs.output[0])
        snap = self.app.capabilities()["housekeeping"]
        self.assertEqual(snap["status"], "warning")
        self.assertEqual(snap["failing"][0]["subject"], "bad")

    def test_repeated_failures_become_a_visible_notice_and_recovery_clears_it(self):
        bad = FakeSession("bad", recovery=OSError("read-only folder"))
        self.sessions[:] = [bad]
        with self.assertLogs("slai.writer.housekeeping", level=logging.WARNING):
            for _ in range(3):
                self.app.tick(now=time.time() + 1000)
        self.assertEqual(self.app.capabilities()["housekeeping"]["status"], "degraded")
        notice = [n for n in self.app.notices() if "Crash-recovery" in n["text"]]
        self.assertEqual((len(notice), notice[0]["kind"]), (1, "error"))
        self.assertIn("read-only folder", notice[0]["text"])
        bad._recovery = None
        self.app.tick(now=time.time() + 1000)
        self.assertEqual(self.app.capabilities()["housekeeping"]["status"], "ok")
        self.assertFalse([n for n in self.app.notices() if "Crash-recovery" in n["text"]])

    def test_autosave_backs_off_then_pauses_with_a_notice(self):
        session = FakeSession("doc", save=PermissionError("locked by another program"))
        session.recovery_dirty = False
        self.sessions[:] = [session]
        now = time.time() + 5000
        with self.assertLogs("slai.writer.housekeeping", level=logging.WARNING):
            self.app.tick(now=now)
            self.app.tick(now=now + 1)                           # inside the back-off: not retried
            self.assertEqual(self.app.health.consecutive("autosave", "doc"), 1)
            self.app.tick(now=now + 20)
            self.app.tick(now=now + 400)
        self.assertEqual(self.app.health.consecutive("autosave", "doc"), 3)
        self.assertFalse(session.autosave)                       # paused, not silently retried forever
        self.assertTrue(any(n.startswith("Autosave paused after 3") and "locked by another program" in n for n in session.notices))

    def test_a_conflict_still_pauses_autosave_without_counting_as_a_fault(self):
        session = FakeSession("doc", save=Conflict("The file was changed by another program."))
        session.recovery_dirty = False
        self.sessions[:] = [session]
        self.app.tick(now=time.time() + 5000)
        self.assertFalse(session.autosave)
        self.assertEqual(self.app.health.consecutive("autosave", "doc"), 0)

    def test_the_loop_survives_a_failing_tick_and_records_it(self):
        def boom():
            raise RuntimeError("preferences unreadable")
        original = self.app.preferences
        self.app.preferences = boom
        self.app.stop.clear()
        self.app.thread = None
        try:
            with self.assertLogs("slai.writer.housekeeping", level=logging.WARNING):
                self.app.start_housekeeping()
                deadline = time.time() + 5
                while time.time() < deadline and not self.app.health.consecutive("tick"):
                    time.sleep(0.05)
        finally:
            self.app.stop.set()
            self.app.thread.join(5)
            self.app.preferences = original
            self.app.thread = None
            self.app.stop.clear()
        self.assertGreaterEqual(self.app.health.consecutive("tick"), 1)


if __name__ == "__main__":
    unittest.main()
