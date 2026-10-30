"""E-mail transport for verification and recovery codes.

Writer sends mail only through an SMTP server the person configures (``configs/config.yaml`` -> ``mail``; the password comes from the
``SLAI_WRITER_SMTP_PASSWORD`` environment variable). With no server configured the transport is *unavailable*, and everything that
needs e-mail (sign-up, password reset, secure recovery) says so instead of pretending a message was sent. No code is ever shown on
screen or written to a log as a stand-in for e-mail.
"""
from __future__ import annotations

import os
import smtplib
import ssl
from email.message import EmailMessage
from typing import Any, Protocol

from ..tools.errors import DependencyMissing


class Mailer(Protocol):
    def status(self) -> dict[str, Any]: ...
    def send(self, to: str, subject: str, body: str) -> None: ...


class UnavailableMailer:
    reason = ("E-mail delivery is not configured on this computer, so verification codes cannot be sent. "
              "Set mail.host and mail.sender in configs/config.yaml (see docs/OPERATIONS.md).")

    def status(self) -> dict[str, Any]:
        return {"configured": False, "reason": self.reason}

    def send(self, to: str, subject: str, body: str) -> None:
        raise DependencyMissing(self.reason, hint="You can continue as a guest: documents work fully offline without an account.")


class SmtpMailer:
    def __init__(self, host: str, port: int, username: str, sender: str, starttls: bool) -> None:
        self.host, self.port, self.username, self.sender, self.starttls = host, port, username, sender, starttls

    def status(self) -> dict[str, Any]:
        return {"configured": True, "host": self.host, "port": self.port, "reason": None}

    def send(self, to: str, subject: str, body: str) -> None:
        message = EmailMessage()
        message["From"], message["To"], message["Subject"] = self.sender, to, subject
        message.set_content(body)
        password = os.environ.get("SLAI_WRITER_SMTP_PASSWORD", "")
        try:
            with smtplib.SMTP(self.host, self.port, timeout=20) as smtp:
                if self.starttls:
                    smtp.starttls(context=ssl.create_default_context())
                if self.username:
                    smtp.login(self.username, password)
                smtp.send_message(message)
        except (OSError, smtplib.SMTPException) as exc:
            raise DependencyMissing(f"The verification e-mail could not be sent ({type(exc).__name__}).",
                                    hint="Check the mail settings and your network, then try again. Nothing was created.") from exc


def make_mailer(settings: dict[str, Any]) -> Mailer:
    if settings.get("host") and settings.get("sender"):
        return SmtpMailer(settings["host"], settings["port"], settings.get("username", ""), settings["sender"], settings.get("starttls", True))
    return UnavailableMailer()
