"""Local accounts: sign-up with an e-mailed 25-character code, passwords, authenticator (TOTP) two-factor, single-use recovery codes,
trusted devices, sessions, password reset and secure recovery of a lost authenticator.

Everything here is real and enforced on the server: passwords are scrypt hashes, codes are stored only as keyed hashes, verification
codes expire and are throttled, a TOTP code can be used once, and an e-mail check alone never bypasses two-factor. Accounts live in
this installation's database; hosted sync/identity is a separate service this application does not ship (see docs/ARCHITECTURE.md).
When no e-mail transport is configured, sign-up and reset refuse with an explanation rather than skipping verification.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import io
import re
import secrets
import string
import time
from typing import Any, Callable

from ..tools.database import Database
from ..tools.errors import BadRequest, DependencyMissing, Forbidden, NotFound, Unauthorized
from ..tools.validation import new_id, utc_now
from . import totp
from .protect import MasterKey, check_password, hash_password

CODE_LENGTH = 25
CODE_ALPHABET = string.ascii_letters + string.digits + "-_.;[]{}$#!@"
SESSION_COOKIE = "slai_writer_session"
DEVICE_COOKIE = "slai_writer_device"
_USERNAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{2,31}$")
_EMAIL = re.compile(r"^[^@\s<>\"',;:\\]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?\.[A-Za-z]{2,24}$")
_COMMON = {"password", "password1", "123456789", "1234567890", "qwertyuiop", "letmein123", "iloveyou12", "administrator"}
_DUMMY = hash_password("not-a-real-password")
RECOVERY_CODES = 10


def _digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def generate_code() -> str:
    return "".join(secrets.choice(CODE_ALPHABET) for _ in range(CODE_LENGTH))


def mask_email(email: str) -> str:
    name, _, domain = email.partition("@")
    return (name[:1] + "***@" + domain) if name else email


class AccountService:
    def __init__(self, db: Database, key: MasterKey, mailer: Any, settings: dict[str, Any], clock: Callable[[], float] = time.time) -> None:
        self.db, self.key, self.mailer, self.s, self.clock = db, key, mailer, settings, clock

    # --------------------------------------------------------------------------------------------------- utilities
    def _mac(self, value: str, label: str) -> str:
        return self.key.mac(value.encode("utf-8"), label)

    def audit(self, account_id: str | None, event: str) -> None:
        self.db.execute("INSERT INTO audit VALUES(?,?,?)", (utc_now(), account_id, event))

    def _require_mail(self) -> None:
        status = self.mailer.status()
        if not status.get("configured"):
            raise DependencyMissing(status.get("reason") or "E-mail is not configured.",
                                    hint="You can continue as a guest: documents work fully offline without an account.")

    def _notify(self, email: str, subject: str, body: str) -> None:
        """Best-effort security notice; a failure to send it never blocks the action it reports."""
        try:
            self.mailer.send(email, subject, body)
        except Exception:  # noqa: BLE001
            pass

    def qr_available(self) -> dict[str, Any]:
        try:
            from reportlab.graphics.barcode import qrencoder  # noqa: F401
            return {"available": True, "reason": None}
        except Exception as exc:  # noqa: BLE001
            return {"available": False, "reason": f"The QR encoder (reportlab) could not be loaded: {type(exc).__name__}. Use the setup key instead."}

    def qr_png(self, text: str, scale: int = 6, border: int = 3) -> str | None:
        """A data URL of the QR code for ``text`` (drawn by reportlab's encoder), or ``None`` when it is unavailable."""
        try:
            from PIL import Image
            from reportlab.graphics.barcode import qrencoder
            qr = qrencoder.QRCode(None, qrencoder.QRErrorCorrectLevel.M)
            qr.addData(text)
            qr.make()
            n = qr.getModuleCount()
            size = (n + 2 * border) * scale
            image = Image.new("1", (size, size), 1)
            pixels = image.load()
            for r in range(n):
                for c in range(n):
                    if qr.isDark(r, c):
                        for dy in range(scale):
                            for dx in range(scale):
                                pixels[(c + border) * scale + dx, (r + border) * scale + dy] = 0
            buffer = io.BytesIO()
            image.save(buffer, "PNG")
            return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")
        except Exception:  # noqa: BLE001
            return None

    # --------------------------------------------------------------------------------------------------- throttling
    def _locked(self, key: str) -> float:
        row = self.db.row("SELECT locked_until FROM throttle WHERE key=?", (key,))
        return max(0.0, (row["locked_until"] - self.clock())) if row else 0.0

    def _check_throttle(self, key: str) -> None:
        wait = self._locked(key)
        if wait > 0:
            minutes = max(1, int(wait // 60) + 1)
            raise Forbidden(f"Too many attempts. Try again in about {minutes} minute{'s' if minutes != 1 else ''}.", details={"retryAfter": int(wait)})

    def _fail(self, key: str) -> int:
        now = self.clock()
        window = self.s["lockout_minutes"] * 60
        row = self.db.row("SELECT * FROM throttle WHERE key=?", (key,))
        if row is None or now - row["window_start"] > window:
            count, start = 1, now
        else:
            count, start = row["count"] + 1, row["window_start"]
        locked = now + window if count >= self.s["max_attempts"] else 0
        self.db.execute("INSERT OR REPLACE INTO throttle VALUES(?,?,?,?)", (key, count, start, locked))
        return count

    def _recent_failures(self, key: str) -> int:
        row = self.db.row("SELECT * FROM throttle WHERE key=?", (key,))
        if row is None or self.clock() - row["window_start"] > self.s["lockout_minutes"] * 60:
            return 0
        return row["count"]

    def _clear(self, key: str) -> None:
        self.db.execute("DELETE FROM throttle WHERE key=?", (key,))

    # --------------------------------------------------------------------------------------------------- validation
    def _check_username(self, username: str) -> str:
        username = (username or "").strip()
        if not _USERNAME.fullmatch(username):
            raise BadRequest("A username has 3 to 32 letters, digits, dots, dashes or underscores and starts with a letter or digit.")
        return username

    def _check_email(self, email: str) -> str:
        email = (email or "").strip()
        if len(email) > 254 or not _EMAIL.fullmatch(email):
            raise BadRequest("Enter a valid e-mail address.")
        return email

    def _check_password(self, password: str, username: str = "") -> None:
        minimum = self.s["min_password_chars"]
        if not isinstance(password, str) or len(password) < minimum:
            raise BadRequest(f"Use a password of at least {minimum} characters.", hint="A few unrelated words make a strong, easy password.")
        if len(password) > 256:
            raise BadRequest("That password is too long (at most 256 characters).")
        if password.lower() in _COMMON or len(set(password)) < 4 or (username and username.lower() in password.lower()):
            raise BadRequest("That password is too easy to guess. Choose another one.")

    # ------------------------------------------------------------------------------------------------------ sign-up
    def start_signup(self, username: str, email: str, password: str) -> dict[str, Any]:
        username, email = self._check_username(username), self._check_email(email)
        self._check_password(password, username)
        self._require_mail()
        self._check_throttle("signup:" + email.lower())
        if self.db.row("SELECT 1 FROM accounts WHERE username=?", (username,)):
            raise BadRequest("That username is not available. Choose another one.")
        pending = self.db.row("SELECT * FROM pending_signups WHERE email=?", (email,))
        if pending and self.clock() - pending["last_sent"] < self.s["resend_seconds"]:
            raise Forbidden("A code was just sent. Wait a moment before asking for another.",
                            details={"retryAfter": int(self.s["resend_seconds"] - (self.clock() - pending["last_sent"]))})
        exists = self.db.row("SELECT id FROM accounts WHERE email=?", (email,))
        code = generate_code()
        digest, salt = hash_password(password)
        now = self.clock()
        if exists:                                           # do not reveal that the address has an account: same response, different mail
            self._send_or_fail(email, "SLAI Writer: someone used your address to sign up",
                               "Someone asked to create a SLAI Writer account with this address, but it already has one. If that was you, "
                               "log in instead (or use 'Forgot password?'). If it was not you, ignore this message.")
        else:
            self.db.execute("INSERT OR REPLACE INTO pending_signups VALUES(?,?,?,?,?,?,?,?,?)",
                            (email, username, digest, salt, self._mac(code, "signup:" + email.lower()), now + self.s["email_code_minutes"] * 60,
                             0, now, (pending["sent"] + 1) if pending else 1))
            self._send_or_fail(email, "Your SLAI Writer verification code",
                               f"Your SLAI Writer verification code is:\n\n{code}\n\nIt is {CODE_LENGTH} characters long, works once and "
                               f"expires in {self.s['email_code_minutes']} minutes. If you did not ask for it, ignore this message.")
            self.audit(None, "signup_code_sent")
        return {"email": mask_email(email), "expiresIn": self.s["email_code_minutes"] * 60, "resendIn": self.s["resend_seconds"],
                "codeLength": CODE_LENGTH}

    def resend_signup(self, email: str) -> dict[str, Any]:
        """A fresh code for a sign-up that is waiting for its e-mail check. The earlier code stops working; resending is throttled."""
        email = (email or "").strip()
        self._require_mail()
        self._check_throttle("signup:" + email.lower())
        pending = self.db.row("SELECT * FROM pending_signups WHERE email=?", (email,))
        if pending is None:
            raise BadRequest("There is no sign-up waiting for this address. Start again with Signup.", details={"restart": True})
        wait = self.s["resend_seconds"] - (self.clock() - pending["last_sent"])
        if wait > 0:
            raise Forbidden("A code was just sent. Wait a moment before asking for another.", details={"retryAfter": int(wait)})
        code = generate_code()
        now = self.clock()
        self.db.execute("UPDATE pending_signups SET code_mac=?, expires=?, attempts=0, last_sent=?, sent=sent+1 WHERE email=?",
                        (self._mac(code, "signup:" + email.lower()), now + self.s["email_code_minutes"] * 60, now, email))
        self._send_or_fail(email, "Your SLAI Writer verification code",
                           f"Your SLAI Writer verification code is:\n\n{code}\n\nIt is {CODE_LENGTH} characters long, works once and "
                           f"expires in {self.s['email_code_minutes']} minutes. Earlier codes no longer work. If you did not ask for it, ignore this message.")
        self.audit(None, "signup_code_resent")
        return {"email": mask_email(email), "expiresIn": self.s["email_code_minutes"] * 60, "resendIn": self.s["resend_seconds"], "codeLength": CODE_LENGTH}

    def _send_or_fail(self, email: str, subject: str, body: str) -> None:
        self.mailer.send(email, subject, body)

    def verify_signup(self, email: str, code: str) -> dict[str, Any]:
        email = (email or "").strip()
        key = "signup:" + email.lower()
        self._check_throttle(key)
        pending = self.db.row("SELECT * FROM pending_signups WHERE email=?", (email,))
        code = (code or "").strip()
        if pending is None or self.clock() > pending["expires"]:
            if pending is not None:
                self.db.execute("DELETE FROM pending_signups WHERE email=?", (email,))
            self._fail(key)
            raise BadRequest("That code is invalid or has expired. Check the code, or ask for a new one.", details={"expired": True})
        if len(code) != CODE_LENGTH or not hmac.compare_digest(self._mac(code, key), pending["code_mac"]):
            self._fail(key)
            attempts = pending["attempts"] + 1
            self.db.execute("UPDATE pending_signups SET attempts=? WHERE email=?", (attempts, email))
            if attempts >= self.s["max_attempts"]:
                self.db.execute("DELETE FROM pending_signups WHERE email=?", (email,))
            raise BadRequest("That code is invalid or has expired. Check the code, or ask for a new one.")
        if self.db.row("SELECT 1 FROM accounts WHERE username=? OR email=?", (pending["username"], email)):
            self.db.execute("DELETE FROM pending_signups WHERE email=?", (email,))
            raise BadRequest("This account could not be created. Start again with another username.")
        aid = new_id()
        stamp = utc_now()
        with self.db.transaction():
            self.db.execute("INSERT INTO accounts(id, username, email, pw_hash, pw_salt, created, verified_at, password_changed) VALUES(?,?,?,?,?,?,?,?)",
                            (aid, pending["username"], email, pending["pw_hash"], pending["pw_salt"], stamp, stamp, stamp))
            self.db.execute("DELETE FROM pending_signups WHERE email=?", (email,))
        self._clear(key)
        self.audit(aid, "account_created")
        return self._account(aid)

    def cancel_signup(self, email: str) -> None:
        self.db.execute("DELETE FROM pending_signups WHERE email=?", ((email or "").strip(),))

    # ------------------------------------------------------------------------------------------------ account access
    def _account(self, account_id: str) -> dict[str, Any]:
        row = self.db.row("SELECT * FROM accounts WHERE id=?", (account_id,))
        if row is None:
            raise NotFound("That account no longer exists.")
        return row

    def public(self, account: dict[str, Any]) -> dict[str, Any]:
        left = self.db.scalar("SELECT COUNT(*) FROM recovery_codes WHERE account_id=? AND used_at IS NULL", (account["id"],)) or 0
        return {"id": account["id"], "username": account["username"], "email": account["email"], "plan": self.effective_plan(account),
                "twoFactor": bool(account["totp_enabled"]), "recoveryCodesLeft": left, "created": account["created"],
                "mfaResetAt": account["mfa_reset_at"], "planSource": account["plan_source"]}

    def effective_plan(self, account: dict[str, Any]) -> str:
        if account["plan_source"] == "none":
            return "guest"
        until = account.get("plan_until")
        if until and until < utc_now():
            return "guest"
        return account["plan"]

    def set_plan(self, account_id: str, plan: str, source: str, until: str | None = None) -> None:
        """Called by a billing integration (never by the interface) when a payment provider confirms a subscription."""
        if source == "none":
            raise BadRequest("A plan needs a billing source.")
        self.db.execute("UPDATE accounts SET plan=?, plan_source=?, plan_until=? WHERE id=?", (plan, source, until, account_id))
        self.audit(account_id, f"plan:{plan}:{source}")

    # ----------------------------------------------------------------------------------------------------- sessions
    def _new_session(self, account_id: str, remember: bool, device_id: str | None, label: str = "") -> dict[str, Any]:
        token = secrets.token_urlsafe(32)
        now = self.clock()
        life = self.s["remember_days"] * 86400 if remember else self.s["session_hours"] * 3600
        self.db.execute("INSERT INTO sessions VALUES(?,?,?,?,?,?,?,?)",
                        (_digest(token), account_id, now, now, now + life, device_id, int(remember), label[:80]))
        return {"token": token, "maxAge": int(life), "cookie": SESSION_COOKIE, "remember": bool(remember)}

    @staticmethod
    def _cookie(header: str, name: str) -> str | None:
        for part in (header or "").split(";"):
            key, _, value = part.strip().partition("=")
            if key == name:
                return value
        return None

    def account_for(self, cookie_header: str) -> dict[str, Any] | None:
        token = self._cookie(cookie_header, SESSION_COOKIE)
        if not token or len(token) > 100:
            return None
        row = self.db.row("SELECT * FROM sessions WHERE id=?", (_digest(token),))
        if row is None:
            return None
        if row["expires"] < self.clock():
            self.db.execute("DELETE FROM sessions WHERE id=?", (row["id"],))
            return None
        self.db.execute("UPDATE sessions SET last_seen=? WHERE id=?", (self.clock(), row["id"]))
        return self.db.row("SELECT * FROM accounts WHERE id=?", (row["account_id"],))

    def session_key(self, cookie_header: str) -> str | None:
        """The stored identifier of the session a request belongs to (what ``change_password(keep_session=...)`` expects)."""
        token = self._cookie(cookie_header, SESSION_COOKIE)
        return _digest(token) if token else None

    def logout(self, cookie_header: str) -> None:
        token = self._cookie(cookie_header, SESSION_COOKIE)
        if token:
            self.db.execute("DELETE FROM sessions WHERE id=?", (_digest(token),))

    def sessions(self, account: dict[str, Any], cookie_header: str) -> list[dict[str, Any]]:
        mine = _digest(self._cookie(cookie_header, SESSION_COOKIE) or "")
        rows = self.db.rows("SELECT id, created, last_seen, expires, remember, label FROM sessions WHERE account_id=? ORDER BY last_seen DESC", (account["id"],))
        return [{"id": r["id"][:16], "created": r["created"], "lastSeen": r["last_seen"], "expires": r["expires"], "remember": bool(r["remember"]),
                 "label": r["label"], "current": r["id"] == mine} for r in rows]

    def revoke_session(self, account: dict[str, Any], short_id: str) -> None:
        self.db.execute("DELETE FROM sessions WHERE account_id=? AND substr(id,1,16)=?", (account["id"], short_id))

    def revoke_all(self, account_id: str, keep: str | None = None) -> None:
        self.db.execute("DELETE FROM sessions WHERE account_id=? AND id<>?", (account_id, keep or ""))

    # ------------------------------------------------------------------------------------------------------ devices
    def _trusted(self, account_id: str, device_token: str | None) -> bool:
        if not device_token:
            return False
        row = self.db.row("SELECT * FROM devices WHERE id=? AND account_id=?", (_digest(device_token), account_id))
        if row is None or row["expires"] < self.clock():
            return False
        self.db.execute("UPDATE devices SET last_used=? WHERE id=?", (self.clock(), row["id"]))
        return True

    def _trust(self, account_id: str, label: str) -> dict[str, Any]:
        token = secrets.token_urlsafe(32)
        now = self.clock()
        life = self.s["device_trust_days"] * 86400
        self.db.execute("INSERT INTO devices VALUES(?,?,?,?,?,?)", (_digest(token), account_id, label[:80] or "This device", now, now + life, now))
        return {"token": token, "maxAge": int(life), "cookie": DEVICE_COOKIE}

    def devices(self, account: dict[str, Any]) -> list[dict[str, Any]]:
        return [{"id": r["id"][:16], "label": r["label"], "created": r["created"], "expires": r["expires"], "lastUsed": r["last_used"]}
                for r in self.db.rows("SELECT * FROM devices WHERE account_id=? ORDER BY last_used DESC", (account["id"],))]

    def revoke_device(self, account: dict[str, Any], short_id: str) -> None:
        self.db.execute("DELETE FROM devices WHERE account_id=? AND substr(id,1,16)=?", (account["id"], short_id))

    # -------------------------------------------------------------------------------------------------------- login
    def _find(self, identifier: str) -> dict[str, Any] | None:
        identifier = (identifier or "").strip()
        return self.db.row("SELECT * FROM accounts WHERE username=? OR email=?", (identifier, identifier))

    def _apply_mfa_reset(self, account: dict[str, Any]) -> dict[str, Any]:
        if account["mfa_reset_at"] and account["mfa_reset_at"] <= utc_now():
            with self.db.transaction():
                self.db.execute("UPDATE accounts SET totp_enabled=0, totp_secret=NULL, totp_pending=NULL, totp_last=0, mfa_reset_at=NULL WHERE id=?",
                                (account["id"],))
                self.db.execute("DELETE FROM recovery_codes WHERE account_id=?", (account["id"],))
                self.db.execute("DELETE FROM devices WHERE account_id=?", (account["id"],))
            self.audit(account["id"], "mfa_reset_applied")
            self._notify(account["email"], "SLAI Writer: two-factor authentication was removed",
                         "The waiting period for your authenticator recovery has ended, so two-factor authentication was switched off. "
                         "Log in and set it up again. If this was not you, change your password now.")
            return self._account(account["id"])
        return account

    def login(self, identifier: str, password: str, remember: bool, device_token: str | None, device_label: str = "") -> dict[str, Any]:
        key = "login:" + (identifier or "").strip().lower()[:100]
        self._check_throttle(key)
        account = self._find(identifier)
        if account is None:
            check_password(password or "", *_DUMMY)                  # same work either way, so timing does not tell which names exist
            self._fail(key)
            raise Unauthorized("The username or password is incorrect.")
        if not check_password(password or "", account["pw_hash"], account["pw_salt"]):
            self._fail(key)
            self.audit(account["id"], "login_failed")
            raise Unauthorized("The username or password is incorrect.")
        account = self._apply_mfa_reset(account)
        suspicious = self._recent_failures(key) >= 3
        if account["totp_enabled"] and (suspicious or not self._trusted(account["id"], device_token)):
            cid = secrets.token_urlsafe(24)
            self.db.execute("INSERT INTO challenges VALUES(?,?,?,?,?,?,?,?)",
                            (cid, account["id"], "totp", self.clock() + 600, 0, None, int(remember), device_label[:80]))
            return {"needs": "totp", "challenge": cid, "expiresIn": 600, "reason": "suspicious activity" if suspicious else "new device"}
        self._clear(key)
        return self._finish_login(account, remember, device_token, trust=False, label=device_label)

    def open_session(self, account: dict[str, Any], remember: bool = False, label: str = "") -> dict[str, Any]:
        """A signed-in session for an account that has just proven itself some other way (e-mail verification at sign-up)."""
        return {"account": account, "session": self._new_session(account["id"], remember, None, label or "Browser")}

    def _finish_login(self, account: dict[str, Any], remember: bool, device_token: str | None, *, trust: bool, label: str) -> dict[str, Any]:
        out: dict[str, Any] = {"account": account, "session": self._new_session(account["id"], remember, None, label or "Browser")}
        if trust:
            out["device"] = self._trust(account["id"], label or "Browser")
        if account["mfa_reset_at"]:
            out["notice"] = f"A recovery of your authenticator is pending until {account['mfa_reset_at'][:16].replace('T', ' ')} UTC. " \
                            "Cancel it in Account security if it was not you."
        self.audit(account["id"], "login")
        return out

    def _challenge(self, cid: str) -> dict[str, Any]:
        row = self.db.row("SELECT * FROM challenges WHERE id=?", (cid,))
        if row is None or row["expires"] < self.clock():
            if row is not None:
                self.db.execute("DELETE FROM challenges WHERE id=?", (cid,))
            raise Unauthorized("This sign-in expired. Enter your password again.", details={"restart": True})
        if row["attempts"] >= self.s["max_attempts"]:
            self.db.execute("DELETE FROM challenges WHERE id=?", (cid,))
            raise Forbidden("Too many wrong codes. Enter your password again later.", details={"restart": True})
        return row

    def verify_second_factor(self, cid: str, code: str, remember_device: bool, device_label: str = "") -> dict[str, Any]:
        row = self._challenge(cid)
        account = self._account(row["account_id"])
        secret = self.key.unseal(account["totp_secret"], "totp:" + account["id"]) if account["totp_secret"] else None
        counter = totp.verify(secret, code, self.clock(), account["totp_last"]) if secret else None
        if counter is None:
            self.db.execute("UPDATE challenges SET attempts=attempts+1 WHERE id=?", (cid,))   # the count survives retries: it is never reset
            raise Unauthorized("That code is not valid. Use the current code from your authenticator app.")
        self.db.execute("UPDATE accounts SET totp_last=? WHERE id=?", (counter, account["id"]))
        self.db.execute("DELETE FROM challenges WHERE id=?", (cid,))
        self._clear("login:" + account["username"].lower())
        return self._finish_login(account, bool(row["remember"]), None, trust=remember_device, label=device_label or row["device_label"])

    def verify_recovery_code(self, cid: str, code: str, device_label: str = "") -> dict[str, Any]:
        row = self._challenge(cid)
        account = self._account(row["account_id"])
        digest = self._mac(self._normal_recovery(code), "recovery:" + account["id"])
        used = self.db.execute("UPDATE recovery_codes SET used_at=? WHERE account_id=? AND code_mac=? AND used_at IS NULL",
                               (self.clock(), account["id"], digest)).rowcount
        if not used:
            self.db.execute("UPDATE challenges SET attempts=attempts+1 WHERE id=?", (cid,))
            raise Unauthorized("That recovery code is not valid or was already used.")
        self.db.execute("DELETE FROM challenges WHERE id=?", (cid,))
        self.audit(account["id"], "recovery_code_used")
        self._notify(account["email"], "SLAI Writer: a recovery code was used",
                     "A single-use recovery code was used to sign in to your account. If this was not you, change your password now.")
        return self._finish_login(account, bool(row["remember"]), None, trust=False, label=device_label or row["device_label"])

    @staticmethod
    def _normal_recovery(code: str) -> str:
        return re.sub(r"[^A-Za-z0-9]", "", code or "").upper()

    # ------------------------------------------------------------------------------------------ two-factor enrolment
    def _reauth(self, account: dict[str, Any], password: str) -> None:
        key = "reauth:" + account["id"]
        self._check_throttle(key)
        if not check_password(password or "", account["pw_hash"], account["pw_salt"]):
            self._fail(key)
            raise Unauthorized("Your password is not correct.", hint="Setting up or changing security needs your password again.")
        self._clear(key)

    def totp_begin(self, account: dict[str, Any], password: str) -> dict[str, Any]:
        self._reauth(account, password)
        if account["totp_enabled"]:
            raise BadRequest("Two-factor authentication is already on. Turn it off first to enrol a different authenticator.")
        secret = totp.new_secret()
        self.db.execute("UPDATE accounts SET totp_pending=? WHERE id=?", (self.key.seal(secret, "totp-pending:" + account["id"]), account["id"]))
        uri = totp.otpauth_uri(secret, account["username"])
        return {"setupKey": totp.b32(secret), "uri": uri, "qr": self.qr_png(uri), "qrAvailable": self.qr_available()["available"]}

    def totp_confirm(self, account: dict[str, Any], code: str) -> dict[str, Any]:
        key = "totp-confirm:" + account["id"]
        self._check_throttle(key)
        if not account["totp_pending"]:
            raise BadRequest("Start the setup first.")
        secret = self.key.unseal(account["totp_pending"], "totp-pending:" + account["id"])
        counter = totp.verify(secret, code, self.clock(), 0)
        if counter is None:
            self._fail(key)
            raise Unauthorized("That code is not valid. Use the current code from your authenticator app.")
        codes = self._new_recovery_codes(account["id"])
        self.db.execute("UPDATE accounts SET totp_secret=?, totp_enabled=1, totp_pending=NULL, totp_last=? WHERE id=?",
                        (self.key.seal(secret, "totp:" + account["id"]), counter, account["id"]))
        self._clear(key)
        self.audit(account["id"], "totp_enabled")
        self._notify(account["email"], "SLAI Writer: two-factor authentication is on",
                     "Two-factor authentication was switched on for your account. If this was not you, change your password now.")
        return {"enabled": True, "recoveryCodes": codes}

    def _new_recovery_codes(self, account_id: str) -> list[str]:
        codes = ["-".join(("".join(secrets.choice("ABCDEFGHJKLMNPQRSTUVWXYZ23456789") for _ in range(5)) for _ in range(2))) for _ in range(RECOVERY_CODES)]
        with self.db.transaction():
            self.db.execute("DELETE FROM recovery_codes WHERE account_id=?", (account_id,))
            for code in codes:
                self.db.execute("INSERT INTO recovery_codes VALUES(?,?,NULL)", (account_id, self._mac(self._normal_recovery(code), "recovery:" + account_id)))
        return codes

    def _check_factor(self, account: dict[str, Any], code: str) -> None:
        secret = self.key.unseal(account["totp_secret"], "totp:" + account["id"])
        counter = totp.verify(secret, code, self.clock(), account["totp_last"])
        if counter is None:
            raise Unauthorized("That authenticator code is not valid.")
        self.db.execute("UPDATE accounts SET totp_last=? WHERE id=?", (counter, account["id"]))

    def recovery_regenerate(self, account: dict[str, Any], password: str, code: str) -> dict[str, Any]:
        self._reauth(account, password)
        if not account["totp_enabled"]:
            raise BadRequest("Turn on two-factor authentication first; recovery codes belong to it.")
        self._check_factor(account, code)
        self.audit(account["id"], "recovery_codes_regenerated")
        return {"recoveryCodes": self._new_recovery_codes(account["id"])}

    def totp_disable(self, account: dict[str, Any], password: str, code: str) -> None:
        self._reauth(account, password)
        if not account["totp_enabled"]:
            return
        self._check_factor(account, code)
        with self.db.transaction():
            self.db.execute("UPDATE accounts SET totp_enabled=0, totp_secret=NULL, totp_pending=NULL, totp_last=0 WHERE id=?", (account["id"],))
            self.db.execute("DELETE FROM recovery_codes WHERE account_id=?", (account["id"],))
            self.db.execute("DELETE FROM devices WHERE account_id=?", (account["id"],))
        self.audit(account["id"], "totp_disabled")

    def change_password(self, account: dict[str, Any], current: str, new: str, code: str | None, keep_session: str | None) -> None:
        self._reauth(account, current)
        self._check_password(new, account["username"])
        if account["totp_enabled"]:
            self._check_factor(account, code or "")
        digest, salt = hash_password(new)
        self.db.execute("UPDATE accounts SET pw_hash=?, pw_salt=?, password_changed=? WHERE id=?", (digest, salt, utc_now(), account["id"]))
        self.revoke_all(account["id"], keep=keep_session)
        self.audit(account["id"], "password_changed")
        self._notify(account["email"], "SLAI Writer: your password was changed", "Your password was changed. If this was not you, reset it now.")

    # ---------------------------------------------------------------------------------------- password reset / recovery
    def reset_request(self, email: str) -> dict[str, Any]:
        """Always answers the same way, whether or not the address has an account."""
        email = (email or "").strip()
        self._require_mail()
        self._check_throttle("reset:" + email.lower())
        account = self.db.row("SELECT * FROM accounts WHERE email=?", (email,))
        if account:
            code = generate_code()
            self.db.execute("DELETE FROM challenges WHERE account_id=? AND kind='reset'", (account["id"],))
            self.db.execute("INSERT INTO challenges VALUES(?,?,?,?,?,?,?,?)",
                            (secrets.token_urlsafe(16), account["id"], "reset", self.clock() + self.s["email_code_minutes"] * 60, 0,
                             self._mac(code, "reset:" + account["id"]), 0, ""))
            self._send_or_fail(email, "Your SLAI Writer password reset code",
                               f"Use this code to reset your password:\n\n{code}\n\nIt works once and expires in {self.s['email_code_minutes']} minutes. "
                               "If you did not ask for it, ignore this message; your password has not changed.")
        return {"message": "If that address has an account, a reset code was sent to it.", "expiresIn": self.s["email_code_minutes"] * 60}

    def reset_complete(self, email: str, code: str, new_password: str, factor: str | None) -> dict[str, Any]:
        email = (email or "").strip()
        key = "reset-complete:" + email.lower()
        self._check_throttle(key)
        account = self.db.row("SELECT * FROM accounts WHERE email=?", (email,))
        challenge = self.db.row("SELECT * FROM challenges WHERE account_id=? AND kind='reset'", (account["id"],)) if account else None
        ok = bool(account and challenge and challenge["expires"] >= self.clock() and (code or "").strip() and
                  hmac.compare_digest(self._mac((code or "").strip(), "reset:" + account["id"]), challenge["code_mac"] or ""))
        if not ok:
            self._fail(key)
            raise BadRequest("That code is invalid or has expired. Ask for a new one.")
        self._check_password(new_password, account["username"])
        if account["totp_enabled"]:                                    # an e-mail check alone must not bypass two-factor
            if not factor:
                raise Unauthorized("This account uses two-factor authentication. Enter an authenticator code or a recovery code as well.",
                                   details={"needsFactor": True})
            try:
                self._check_factor(account, factor)
            except Unauthorized:
                digest = self._mac(self._normal_recovery(factor), "recovery:" + account["id"])
                if not self.db.execute("UPDATE recovery_codes SET used_at=? WHERE account_id=? AND code_mac=? AND used_at IS NULL",
                                       (self.clock(), account["id"], digest)).rowcount:
                    self._fail(key)
                    raise Unauthorized("That authenticator or recovery code is not valid.")
        digest, salt = hash_password(new_password)
        with self.db.transaction():
            self.db.execute("UPDATE accounts SET pw_hash=?, pw_salt=?, password_changed=? WHERE id=?", (digest, salt, utc_now(), account["id"]))
            self.db.execute("DELETE FROM challenges WHERE account_id=? AND kind='reset'", (account["id"],))
            self.db.execute("DELETE FROM sessions WHERE account_id=?", (account["id"],))
            self.db.execute("DELETE FROM devices WHERE account_id=?", (account["id"],))
        self._clear(key)
        self.audit(account["id"], "password_reset")
        self._notify(email, "SLAI Writer: your password was reset", "Your password was reset and all sessions were signed out. If this was not you, contact support.")
        return {"reset": True}

    def mfa_recovery_start(self, email: str, password: str) -> dict[str, Any]:
        """Lost authenticator: prove the password and the e-mail, then wait out a delay (with a notification) before 2FA is removed."""
        self._require_mail()
        key = "mfa-recovery:" + (email or "").strip().lower()
        self._check_throttle(key)
        account = self.db.row("SELECT * FROM accounts WHERE email=?", ((email or "").strip(),))
        if account is None or not account["totp_enabled"] or not check_password(password or "", account["pw_hash"], account["pw_salt"]):
            if account is None:
                check_password(password or "", *_DUMMY)
            self._fail(key)
            return {"message": "If those details match an account with two-factor authentication, a confirmation code was sent."}
        code = generate_code()
        self.db.execute("DELETE FROM challenges WHERE account_id=? AND kind='mfa-recovery'", (account["id"],))
        self.db.execute("INSERT INTO challenges VALUES(?,?,?,?,?,?,?,?)",
                        (secrets.token_urlsafe(16), account["id"], "mfa-recovery", self.clock() + self.s["email_code_minutes"] * 60, 0,
                         self._mac(code, "mfa-recovery:" + account["id"]), 0, ""))
        self._send_or_fail(account["email"], "SLAI Writer: confirm authenticator recovery",
                           f"Someone asked to remove two-factor authentication from your account after a waiting period of "
                           f"{self.s['recovery_delay_hours']} hours. To confirm it was you, use this code:\n\n{code}\n\nIf it was not you, ignore this message and change your password.")
        return {"message": "If those details match an account with two-factor authentication, a confirmation code was sent."}

    def mfa_recovery_confirm(self, email: str, code: str) -> dict[str, Any]:
        key = "mfa-recovery-confirm:" + (email or "").strip().lower()
        self._check_throttle(key)
        account = self.db.row("SELECT * FROM accounts WHERE email=?", ((email or "").strip(),))
        challenge = self.db.row("SELECT * FROM challenges WHERE account_id=? AND kind='mfa-recovery'", (account["id"],)) if account else None
        if not (account and challenge and challenge["expires"] >= self.clock() and
                hmac.compare_digest(self._mac((code or "").strip(), "mfa-recovery:" + account["id"]), challenge["code_mac"] or "")):
            self._fail(key)
            raise BadRequest("That code is invalid or has expired.")
        hours = self.s["recovery_delay_hours"]
        from datetime import datetime, timedelta, timezone
        effective = (datetime.now(timezone.utc) + timedelta(hours=hours)).replace(microsecond=0).isoformat()
        with self.db.transaction():
            self.db.execute("UPDATE accounts SET mfa_reset_at=? WHERE id=?", (effective, account["id"]))
            self.db.execute("DELETE FROM challenges WHERE account_id=? AND kind='mfa-recovery'", (account["id"],))
            self.db.execute("DELETE FROM sessions WHERE account_id=?", (account["id"],))
            self.db.execute("DELETE FROM devices WHERE account_id=?", (account["id"],))
        self.audit(account["id"], "mfa_recovery_started")
        self._notify(account["email"], "SLAI Writer: authenticator recovery started",
                     f"Two-factor authentication will be removed from your account at {effective} UTC and all sessions were signed out. "
                     "If this was not you, log in with your authenticator before then and cancel it, then change your password.")
        return {"effectiveAt": effective, "hours": hours}

    def mfa_recovery_cancel(self, account: dict[str, Any]) -> None:
        self.db.execute("UPDATE accounts SET mfa_reset_at=NULL WHERE id=?", (account["id"],))
        self.audit(account["id"], "mfa_recovery_cancelled")

    # ------------------------------------------------------------------------------------------------------ upkeep
    def cleanup(self) -> None:
        now = self.clock()
        for sql in ("DELETE FROM sessions WHERE expires<?", "DELETE FROM devices WHERE expires<?", "DELETE FROM challenges WHERE expires<?",
                    "DELETE FROM pending_signups WHERE expires<?"):
            self.db.execute(sql, (now,))
        self.db.execute("DELETE FROM throttle WHERE locked_until<? AND window_start<?", (now, now - 86400))
