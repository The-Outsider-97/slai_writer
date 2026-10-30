"""Account flows over HTTP: sign-up with the 25-character e-mail code, authenticator enrolment, 2FA log-in, recovery codes, trusted
devices, password reset and secure recovery. The mail transport is a recording double; everything else is the real service."""
import base64

from applications.slai_writer import totp
from applications.slai_writer.accounts import CODE_LENGTH

from .api_helpers import ApiCase, Browser

PW = "correct horse battery"


class Accounts(ApiCase):
    n = 0

    def identity(self):
        type(self).n += 1
        return f"user{self.n}", f"user{self.n}@example.org"

    def signup(self, web=None):
        web = web or self.web
        name, email = self.identity()
        started = web.ok("POST", "/api/account/signup", {"username": name, "email": email, "password": PW})
        self.assertEqual(started["codeLength"], CODE_LENGTH)
        self.assertEqual(len(self.mail.last_code()), CODE_LENGTH)
        done = web.ok("POST", "/api/account/signup/verify", {"email": email, "code": self.mail.last_code()})
        return name, email, done

    def fresh_code(self, secret, account_id):
        self.app.store.db.execute("UPDATE accounts SET totp_last=0 WHERE id=?", (account_id,))
        return totp.code_at(secret, totp.counter_for(__import__("time").time()))

    def enrol(self, web=None):
        web = web or self.web
        begin = web.ok("POST", "/api/account/2fa/begin", {"password": PW})
        secret = base64.b32decode(begin["setupKey"] + "=" * (-len(begin["setupKey"]) % 8))
        me = web.ok("GET", "/api/account")["account"]
        code = self.fresh_code(secret, me["id"])
        done = web.ok("POST", "/api/account/2fa/confirm", {"code": code})
        return secret, done["recoveryCodes"], begin

    def test_signup_requires_verification_then_leads_to_enrolment(self):
        name, email, done = self.signup()
        self.assertEqual(done["next"], "enroll")
        self.assertEqual(done["account"]["username"], name)
        self.assertEqual(self.web.ok("GET", "/api/account")["account"]["username"], name)
        self.assertNotIn("pw_hash", str(done))
        boot = self.web.ok("GET", "/api/bootstrap")
        self.assertEqual(boot["account"]["username"], name)

    def test_session_cookie_is_httponly_strict_and_not_a_persistent_cookie_by_default(self):
        name, email = self.identity()
        self.web.ok("POST", "/api/account/signup", {"username": name, "email": email, "password": PW})
        import json
        import http.client
        conn = http.client.HTTPConnection("127.0.0.1", self.server.port)
        conn.request("POST", "/api/account/signup/verify", body=json.dumps({"email": email, "code": self.mail.last_code()}),
                     headers={"Cookie": f"{self.server.identity.cookie}=unit-test-token", self.server.identity.marker: "1", "Content-Type": "application/json"})
        res = conn.getresponse()
        res.read()
        conn.close()
        cookies = [v for k, v in res.getheaders() if k.lower() == "set-cookie"]
        self.assertEqual(len(cookies), 1)
        self.assertIn("HttpOnly", cookies[0])
        self.assertIn("SameSite=Strict", cookies[0])
        self.assertNotIn("Max-Age", cookies[0])

    def test_wrong_code_and_weak_input_are_rejected_and_create_nothing(self):
        name, email = self.identity()
        status, _ = self.web.api("POST", "/api/account/signup", {"username": name, "email": email, "password": "short"})
        self.assertEqual(status, 400)
        self.web.ok("POST", "/api/account/signup", {"username": name, "email": email, "password": PW})
        status, body = self.web.api("POST", "/api/account/signup/verify", {"email": email, "code": "z" * 25})
        self.assertEqual(status, 400)
        self.assertIsNone(self.web.ok("GET", "/api/account")["account"])
        status, body = self.web.api("POST", "/api/account/login", {"identifier": name, "password": PW})
        self.assertEqual(status, 401)                           # unverified sign-ups cannot log in

    def test_enrolment_confirms_with_a_real_code_and_gives_one_time_recovery_codes(self):
        self.signup()
        status, _ = self.web.api("POST", "/api/account/2fa/begin", {"password": "not my password"})
        self.assertEqual(status, 401)
        secret, codes, begin = self.enrol()
        self.assertTrue(begin["setupKey"])
        self.assertIn("otpauth://", begin["uri"])
        self.assertEqual(len(codes), 10)
        me = self.web.ok("GET", "/api/account")["account"]
        self.assertTrue(me["twoFactor"])
        self.assertEqual(me["recoveryCodesLeft"], 10)

    def test_enrolment_rejects_a_wrong_code(self):
        self.signup()
        self.web.ok("POST", "/api/account/2fa/begin", {"password": PW})
        status, _ = self.web.api("POST", "/api/account/2fa/confirm", {"code": "000000"})
        self.assertIn(status, (401,))
        self.assertFalse(self.web.ok("GET", "/api/account")["account"]["twoFactor"])

    def test_login_with_two_factor_trusted_device_and_replay(self):
        name, email, _ = self.signup()
        secret, codes, _ = self.enrol()
        me = self.web.ok("GET", "/api/account")["account"]
        # a second browser: new device -> password alone is not enough
        other = Browser(self.server)
        first = other.ok("POST", "/api/account/login", {"identifier": name, "password": PW})
        self.assertEqual(first["needs"], "totp")
        self.assertIsNone(other.ok("GET", "/api/account")["account"])
        status, _ = other.api("POST", "/api/account/login/code", {"challenge": first["challenge"], "code": "123456"})
        self.assertEqual(status, 401)
        code = self.fresh_code(secret, me["id"])
        done = other.ok("POST", "/api/account/login/code", {"challenge": first["challenge"], "code": code, "trustDevice": True})
        self.assertEqual(done["account"]["username"], name)
        self.assertIn("slai_writer_device", other.jar)
        # the same code cannot be used again (replay)
        again = Browser(self.server).ok("POST", "/api/account/login", {"identifier": name, "password": PW})
        status, _ = Browser(self.server).api("POST", "/api/account/login/code", {"challenge": again["challenge"], "code": code})
        self.assertEqual(status, 401)
        # a trusted device skips the code on its next password log-in
        other.ok("POST", "/api/account/logout", {})
        self.assertIsNone(other.ok("GET", "/api/account")["account"])
        skip = other.ok("POST", "/api/account/login", {"identifier": name, "password": PW})
        self.assertEqual(skip["next"], "home")

    def test_recovery_code_logs_in_once_only(self):
        name, email, _ = self.signup()
        secret, codes, _ = self.enrol()
        other = Browser(self.server)
        challenge = other.ok("POST", "/api/account/login", {"identifier": name, "password": PW})["challenge"]
        other.ok("POST", "/api/account/login/recovery-code", {"challenge": challenge, "code": codes[0]})
        self.assertEqual(other.ok("GET", "/api/account")["account"]["recoveryCodesLeft"], 9)
        third = Browser(self.server)
        challenge = third.ok("POST", "/api/account/login", {"identifier": name, "password": PW})["challenge"]
        status, _ = third.api("POST", "/api/account/login/recovery-code", {"challenge": challenge, "code": codes[0]})
        self.assertEqual(status, 401)

    def test_password_reset_needs_the_second_factor_too(self):
        name, email, _ = self.signup()
        secret, codes, _ = self.enrol()
        me = self.web.ok("GET", "/api/account")["account"]
        anon = Browser(self.server)
        ask = anon.ok("POST", "/api/account/reset", {"email": email})
        self.assertIn("If that address", ask["message"])
        reset_code = self.mail.last_code()
        status, body = anon.api("POST", "/api/account/reset/complete", {"email": email, "code": reset_code, "password": "a brand new passphrase"})
        self.assertEqual((status, body["error"]["details"].get("needsFactor")), (401, True))
        anon.ok("POST", "/api/account/reset/complete", {"email": email, "code": reset_code, "password": "a brand new passphrase", "factor": codes[1]})
        status, _ = Browser(self.server).api("POST", "/api/account/login", {"identifier": name, "password": PW})
        self.assertEqual(status, 401)
        self.assertIn("challenge", Browser(self.server).ok("POST", "/api/account/login", {"identifier": name, "password": "a brand new passphrase"}))
        # the old session was signed out by the reset
        self.assertIsNone(self.web.ok("GET", "/api/account")["account"])

    def test_reset_for_unknown_address_looks_identical(self):
        known = Browser(self.server)
        name, email, _ = self.signup(known)
        unknown = Browser(self.server).ok("POST", "/api/account/reset", {"email": "nobody@example.org"})
        real = Browser(self.server).ok("POST", "/api/account/reset", {"email": email})
        self.assertEqual(set(unknown), set(real))
        self.assertEqual(unknown["message"], real["message"])

    def test_lost_authenticator_goes_through_a_waiting_period(self):
        name, email, _ = self.signup()
        self.enrol()
        anon = Browser(self.server)
        anon.ok("POST", "/api/account/mfa-recovery", {"email": email, "password": PW})
        out = anon.ok("POST", "/api/account/mfa-recovery/confirm", {"email": email, "code": self.mail.last_code()})
        self.assertEqual(out["hours"], 24)
        self.assertIsNone(self.web.ok("GET", "/api/account")["account"])        # signed out everywhere
        back = Browser(self.server).ok("POST", "/api/account/login", {"identifier": name, "password": PW})
        self.assertEqual(back["needs"], "totp")                                  # 2FA stays on until the delay has passed
        self.app.store.db.execute("UPDATE accounts SET mfa_reset_at='2000-01-01T00:00:00+00:00' WHERE email=?", (email,))
        after = Browser(self.server).ok("POST", "/api/account/login", {"identifier": name, "password": PW})
        self.assertEqual(after["next"], "home")

    def test_sessions_can_be_listed_and_revoked(self):
        name, email, _ = self.signup()
        other = Browser(self.server)
        other.ok("POST", "/api/account/login", {"identifier": name, "password": PW})
        listing = self.web.ok("GET", "/api/account/sessions")
        self.assertEqual(len(listing["sessions"]), 2)
        self.assertEqual(len([s for s in listing["sessions"] if s["current"]]), 1)
        theirs = next(s for s in listing["sessions"] if not s["current"])
        self.web.ok("DELETE", f"/api/account/sessions/{theirs['id']}")
        self.assertIsNone(other.ok("GET", "/api/account")["account"])
        self.assertEqual(self.web.ok("GET", "/api/account")["account"]["username"], name)
        status, _ = Browser(self.server).api("GET", "/api/account/sessions")
        self.assertEqual(status, 401)

    def test_changing_the_password_needs_the_old_one_and_the_factor(self):
        name, email, _ = self.signup()
        secret, _, _ = self.enrol()
        me = self.web.ok("GET", "/api/account")["account"]
        status, _ = self.web.api("POST", "/api/account/password", {"current": "wrong wrong wrong", "new": "another long passphrase", "code": self.fresh_code(secret, me["id"])})
        self.assertEqual(status, 401)
        status, _ = self.web.api("POST", "/api/account/password", {"current": PW, "new": "another long passphrase"})
        self.assertEqual(status, 401)
        self.web.ok("POST", "/api/account/password", {"current": PW, "new": "another long passphrase", "code": self.fresh_code(secret, me["id"])})
        self.assertEqual(self.web.ok("GET", "/api/account")["account"]["username"], name)      # this session survives

    def test_plan_cannot_be_bought_without_a_payment_provider(self):
        name, email, _ = self.signup()
        status, body = self.web.api("POST", "/api/plans/checkout", {"plan": "creator"})
        self.assertGreaterEqual(status, 400)
        self.assertIn("payment provider", body["error"]["message"])
        self.assertEqual(self.web.ok("GET", "/api/account")["account"]["plan"], "guest")
        plans = self.web.ok("GET", "/api/plans")
        workspace = next(p for p in plans["plans"] if p["id"] == "workspace")
        self.assertEqual(workspace["monthly"], 30)
        self.assertFalse(plans["billing"]["configured"])
        status, _ = self.web.api("PUT", "/api/account", {"plan": "workspace"})
        self.assertIn(status, (404, 405))
        status, _ = self.web.api("POST", "/api/plans/checkout", {"plan": "nope"})
        self.assertEqual(status, 400)

    def test_unauthenticated_security_endpoints_are_refused(self):
        anon = Browser(self.server)
        for path in ("/api/account/2fa/begin", "/api/account/2fa/confirm", "/api/account/recovery-codes", "/api/account/password"):
            status, body = anon.api("POST", path, {"password": PW, "code": "123456", "current": PW, "new": "x" * 12})
            self.assertEqual(status, 401, path)
        status, _ = anon.api("POST", "/api/account/logout", {})
        self.assertEqual(status, 200)


class Gatekeeping(ApiCase):
    def test_the_shared_server_rules_still_apply_to_writer_routes(self):
        status, _ = self.web.api("GET", "/api/bootstrap", cookies=False)
        self.assertEqual(status, 401)
        status, _ = self.web.api("POST", "/api/docs/new", {"name": "x"}, marker=False)
        self.assertEqual(status, 401)
        status, _ = self.web.api("POST", "/api/docs/new", {"name": "x"}, headers={"Origin": "http://evil.example"})
        self.assertEqual(status, 401)
        response, _ = self.web.request("GET", "/api/bootstrap")
        self.assertIn("default-src 'none'", response.getheader("Content-Security-Policy"))
        self.assertIn("script-src 'self'", response.getheader("Content-Security-Policy"))
