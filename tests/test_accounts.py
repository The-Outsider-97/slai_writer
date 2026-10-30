import re
import tempfile
import unittest
from pathlib import Path

from applications.tools.errors import BadRequest, DependencyMissing, Forbidden, Unauthorized
from applications.slai_writer import totp
from applications.slai_writer.accounts import AccountService, CODE_LENGTH, SESSION_COOKIE, DEVICE_COOKIE
from applications.slai_writer.mailer import UnavailableMailer
from applications.slai_writer.protect import MasterKey
from applications.slai_writer.store import WriterStore

SETTINGS = {"session_hours": 12, "remember_days": 30, "device_trust_days": 30, "email_code_minutes": 5, "resend_seconds": 30,
            "max_attempts": 5, "lockout_minutes": 15, "recovery_delay_hours": 24, "min_password_chars": 10}


class Outbox:
    """A test double for the SMTP transport: it records messages, as a real mail server would receive them."""
    def __init__(self): self.sent = []
    def status(self): return {"configured": True, "reason": None}
    def send(self, to, subject, body): self.sent.append((to, subject, body))
    def last_code(self):
        return re.search(r"^(\S{%d})$" % CODE_LENGTH, self.sent[-1][2], re.M).group(1)


class Clock:
    def __init__(self): self.t = 1_800_000_000.0
    def __call__(self): return self.t


class AccountTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.store = WriterStore(Path(self.tmp.name))
        self.addCleanup(self.store.db.close)
        self.mail, self.clock = Outbox(), Clock()
        self.acc = AccountService(self.store.db, MasterKey(Path(self.tmp.name) / "k"), self.mail, SETTINGS, self.clock)

    def signup(self, name="anna", email="anna@example.org", pw="correct horse battery"):
        self.acc.start_signup(name, email, pw)
        return self.acc.verify_signup(email, self.mail.last_code())

    def enrol(self, account, pw="correct horse battery"):
        begin = self.acc.totp_begin(account, pw)
        secret = totp.base64.b32decode(begin["setupKey"]) if hasattr(totp, "base64") else None
        import base64
        secret = base64.b32decode(begin["setupKey"])
        out = self.acc.totp_confirm(self.acc._account(account["id"]), totp.code_at(secret, totp.counter_for(self.clock())))
        return secret, out["recoveryCodes"]

    # --- sign-up
    def test_unavailable_mail_blocks_signup(self):
        acc = AccountService(self.store.db, self.acc.key, UnavailableMailer(), SETTINGS, self.clock)
        with self.assertRaises(DependencyMissing):
            acc.start_signup("bob", "bob@example.org", "correct horse battery")
        self.assertEqual(self.store.db.scalar("SELECT COUNT(*) FROM accounts"), 0)

    def test_code_is_25_chars_and_creates_account(self):
        out = self.acc.start_signup("anna", "anna@example.org", "correct horse battery")
        self.assertEqual(out["codeLength"], 25)
        self.assertEqual(len(self.mail.last_code()), 25)
        self.assertEqual(self.store.db.scalar("SELECT COUNT(*) FROM accounts"), 0)       # nothing exists before verification
        account = self.acc.verify_signup("anna@example.org", self.mail.last_code())
        self.assertEqual(account["username"], "anna")
        self.assertNotEqual(account["pw_hash"], b"correct horse battery")

    def test_wrong_and_expired_codes(self):
        self.acc.start_signup("anna", "anna@example.org", "correct horse battery")
        with self.assertRaises(BadRequest):
            self.acc.verify_signup("anna@example.org", "x" * 25)
        code = self.mail.last_code()
        self.clock.t += 5 * 60 + 1
        with self.assertRaises(BadRequest):
            self.acc.verify_signup("anna@example.org", code)

    def test_attempt_lockout(self):
        self.acc.start_signup("anna", "anna@example.org", "correct horse battery")
        for _ in range(5):
            with self.assertRaises((BadRequest, Forbidden)):
                self.acc.verify_signup("anna@example.org", "y" * 25)
        with self.assertRaises(Forbidden):
            self.acc.verify_signup("anna@example.org", self.mail.last_code())

    def test_resend_throttle(self):
        self.acc.start_signup("anna", "anna@example.org", "correct horse battery")
        with self.assertRaises(Forbidden):
            self.acc.start_signup("anna", "anna@example.org", "correct horse battery")
        self.clock.t += 31
        self.acc.start_signup("anna", "anna@example.org", "correct horse battery")
        self.assertEqual(len(self.mail.sent), 2)

    def test_resend_replaces_the_earlier_code_and_is_throttled(self):
        self.acc.start_signup("rita", "rita@example.org", "correct horse battery")
        first = self.mail.last_code()
        with self.assertRaises(Forbidden):
            self.acc.resend_signup("rita@example.org")              # too soon
        self.clock.t += 31
        out = self.acc.resend_signup("rita@example.org")
        self.assertEqual(out["codeLength"], CODE_LENGTH)
        second = self.mail.last_code()
        self.assertNotEqual(first, second)
        with self.assertRaises(BadRequest):
            self.acc.verify_signup("rita@example.org", first)       # the earlier code no longer works
        self.assertEqual(self.acc.verify_signup("rita@example.org", second)["username"], "rita")

    def test_resend_without_a_pending_signup_says_start_again(self):
        with self.assertRaises(BadRequest):
            self.acc.resend_signup("nobody@example.org")

    def test_weak_input_rejected(self):
        for args in (("a", "a@example.org", "correct horse battery"), ("anna", "not-an-email", "correct horse battery"),
                     ("anna", "a@example.org", "short"), ("anna", "a@example.org", "password1"), ("anna", "a@example.org", "xxxxxxxxxxxx")):
            with self.assertRaises(BadRequest):
                self.acc.start_signup(*args)

    def test_existing_address_not_revealed(self):
        self.signup()
        out = self.acc.start_signup("other", "anna@example.org", "correct horse battery")
        self.assertIn("email", out)
        self.assertIn("already has one", self.mail.sent[-1][2])

    # --- login
    def test_login_without_2fa_and_failures(self):
        self.signup()
        got = self.acc.login("anna", "correct horse battery", False, None)
        self.assertIn("session", got)
        with self.assertRaises(Unauthorized):
            self.acc.login("anna", "wrong password!!", False, None)
        with self.assertRaises(Unauthorized):
            self.acc.login("nobody", "wrong password!!", False, None)
        account = self.acc.account_for(f"{SESSION_COOKIE}={got['session']['token']}")
        self.assertEqual(account["username"], "anna")
        self.acc.logout(f"{SESSION_COOKIE}={got['session']['token']}")
        self.assertIsNone(self.acc.account_for(f"{SESSION_COOKIE}={got['session']['token']}"))

    def test_login_lockout(self):
        self.signup()
        for _ in range(5):
            with self.assertRaises(Unauthorized):
                self.acc.login("anna", "wrong password!!", False, None)
        with self.assertRaises(Forbidden):
            self.acc.login("anna", "correct horse battery", False, None)
        self.clock.t += 16 * 60
        self.assertIn("session", self.acc.login("anna", "correct horse battery", False, None))

    def test_session_expiry(self):
        self.signup()
        got = self.acc.login("anna", "correct horse battery", False, None)
        cookie = f"{SESSION_COOKIE}={got['session']['token']}"
        self.clock.t += 13 * 3600
        self.assertIsNone(self.acc.account_for(cookie))

    # --- two-factor
    def test_enrol_and_login_with_totp(self):
        account = self.signup()
        self.assertTrue(self.acc.qr_available()["available"])
        begin = self.acc.totp_begin(account, "correct horse battery")
        self.assertTrue(begin["qr"].startswith("data:image/png;base64,"))
        with self.assertRaises(Unauthorized):
            self.acc.totp_begin(account, "wrong password!!")
        secret, codes = self.enrol(account)
        self.assertEqual(len(codes), 10)
        step = self.acc.login("anna", "correct horse battery", False, None)
        self.assertEqual(step["needs"], "totp")
        with self.assertRaises(Unauthorized):
            self.acc.verify_second_factor(step["challenge"], "000000", False)
        self.clock.t += 30
        code = totp.code_at(secret, totp.counter_for(self.clock()))
        done = self.acc.verify_second_factor(step["challenge"], code, True, "Laptop")
        self.assertIn("session", done)
        self.assertIn("device", done)
        # the same code cannot be used twice (replay)
        step2 = self.acc.login("anna", "correct horse battery", False, None)
        with self.assertRaises(Unauthorized):
            self.acc.verify_second_factor(step2["challenge"], code, False)

    def test_trusted_device_skips_code(self):
        account = self.signup()
        secret, _ = self.enrol(account)
        step = self.acc.login("anna", "correct horse battery", False, None)
        self.clock.t += 30
        done = self.acc.verify_second_factor(step["challenge"], totp.code_at(secret, totp.counter_for(self.clock())), True)
        token = done["device"]["token"]
        self.assertIn("session", self.acc.login("anna", "correct horse battery", False, token))
        self.clock.t += 31 * 86400
        self.assertEqual(self.acc.login("anna", "correct horse battery", False, token)["needs"], "totp")

    def test_recovery_code_single_use(self):
        account = self.signup()
        _, codes = self.enrol(account)
        step = self.acc.login("anna", "correct horse battery", False, None)
        self.assertIn("session", self.acc.verify_recovery_code(step["challenge"], codes[0].lower()))
        step = self.acc.login("anna", "correct horse battery", False, None)
        with self.assertRaises(Unauthorized):
            self.acc.verify_recovery_code(step["challenge"], codes[0])
        self.assertEqual(self.acc.public(self.acc._account(account["id"]))["recoveryCodesLeft"], 9)

    def test_challenge_attempts_not_reset(self):
        account = self.signup()
        self.enrol(account)
        step = self.acc.login("anna", "correct horse battery", False, None)
        for _ in range(5):
            with self.assertRaises(Unauthorized):
                self.acc.verify_second_factor(step["challenge"], "123456", False)
        with self.assertRaises(Forbidden):
            self.acc.verify_second_factor(step["challenge"], "123456", False)

    def test_secret_not_stored_in_clear(self):
        account = self.signup()
        secret, _ = self.enrol(account)
        raw = self.acc._account(account["id"])["totp_secret"]
        self.assertNotIn(secret, raw)

    # --- reset and recovery
    def test_password_reset_requires_second_factor(self):
        account = self.signup()
        secret, _ = self.enrol(account)
        out = self.acc.reset_request("anna@example.org")
        self.assertIn("If that address", out["message"])
        code = self.mail.last_code()
        with self.assertRaises(Unauthorized) as ctx:
            self.acc.reset_complete("anna@example.org", code, "brand new passphrase", None)
        self.assertTrue(ctx.exception.details.get("needsFactor"))
        self.clock.t += 30
        self.acc.reset_complete("anna@example.org", code, "brand new passphrase", totp.code_at(secret, totp.counter_for(self.clock())))
        step = self.acc.login("anna", "brand new passphrase", False, None)
        self.assertEqual(step["needs"], "totp")

    def test_reset_unknown_address_same_answer(self):
        a = self.acc.reset_request("nobody@example.org")
        self.signup()
        b = self.acc.reset_request("anna@example.org")
        self.assertEqual(a["message"], b["message"])
        self.assertEqual(len(self.mail.sent), 2)                                          # only the real address got mail (+ sign-up)

    def test_mfa_recovery_waits_then_removes(self):
        account = self.signup()
        self.enrol(account)
        self.acc.mfa_recovery_start("anna@example.org", "correct horse battery")
        self.acc.mfa_recovery_confirm("anna@example.org", self.mail.last_code())
        step = self.acc.login("anna", "correct horse battery", False, None)
        self.assertEqual(step["needs"], "totp")                                           # still protected during the delay
        from datetime import datetime, timedelta, timezone
        self.store.db.execute("UPDATE accounts SET mfa_reset_at=?", ((datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat(),))
        done = self.acc.login("anna", "correct horse battery", False, None)
        self.assertIn("session", done)
        self.assertEqual(self.acc.public(self.acc._account(account["id"]))["twoFactor"], False)

    def test_change_password_revokes_other_sessions(self):
        account = self.signup()
        a = self.acc.login("anna", "correct horse battery", False, None)
        self.acc.change_password(account, "correct horse battery", "another long passphrase", None, None)
        self.assertIsNone(self.acc.account_for(f"{SESSION_COOKIE}={a['session']['token']}"))

    def test_plan_defaults_to_guest_without_billing(self):
        account = self.signup()
        self.assertEqual(self.acc.effective_plan(account), "guest")
        self.acc.set_plan(account["id"], "creator", "stripe", "2999-01-01T00:00:00+00:00")
        self.assertEqual(self.acc.effective_plan(self.acc._account(account["id"])), "creator")
        self.acc.set_plan(account["id"], "creator", "stripe", "2000-01-01T00:00:00+00:00")
        self.assertEqual(self.acc.effective_plan(self.acc._account(account["id"])), "guest")


if __name__ == "__main__":
    unittest.main()
