"""Account routes: sign-up with e-mail verification, log-in, two-factor, recovery, password reset, sessions and devices, plans.

All decisions are made by :class:`~.accounts.AccountService`; these handlers only translate requests and set cookies. Passwords and
codes are read from the request body, never from the URL, and are never logged or echoed back.
"""
from __future__ import annotations

from typing import Any

from ..tools.server import Request, Response, ok
from .accounts import DEVICE_COOKIE, SESSION_COOKIE
from .routing import (clear_cookie, cookie_value, device_label, flag, need_account, router, set_cookie, text)


def _signed_in(app: Any, req: Request, outcome: dict[str, Any], *, extra: dict[str, Any] | None = None) -> Response:
    """Answer a successful log-in: public account data, plus the session (and, if trusted, device) cookies."""
    account = app.accounts.public(outcome["account"])
    data: dict[str, Any] = {"account": account, "plan": app.plan_of(outcome["account"]), "notice": outcome.get("notice"), **(extra or {})}
    response = ok(data)
    session = outcome["session"]
    response.cookies.append(set_cookie(SESSION_COOKIE, session["token"], session["maxAge"] if session["remember"] else None))
    device = outcome.get("device")
    if device:
        response.cookies.append(set_cookie(DEVICE_COOKIE, device["token"], device["maxAge"]))
    return response


@router.route("GET", "/api/account")
def account_me(app, req: Request):
    profile, account = app.profile_of(req)
    return {"account": app.accounts.public(account) if account else None, "profile": profile, "plan": app.plan_of(account),
            "email": app.mailer.status(), "qr": app.accounts.qr_available()}


@router.route("POST", "/api/account/signup")
def signup(app, req: Request):
    body = req.json()
    return app.accounts.start_signup(text(body, "username", max_len=64), text(body, "email", max_len=320), text(body, "password", max_len=300))


@router.route("POST", "/api/account/signup/resend")
def signup_resend(app, req: Request):
    return app.accounts.resend_signup(text(req.json(), "email", max_len=320))


@router.route("POST", "/api/account/signup/verify")
def signup_verify(app, req: Request):
    body = req.json()
    account = app.accounts.verify_signup(text(body, "email", max_len=320), text(body, "code", max_len=100))
    outcome = app.accounts.open_session(account, False, device_label(req))
    return _signed_in(app, req, outcome, extra={"next": "enroll"})


@router.route("POST", "/api/account/signup/cancel")
def signup_cancel(app, req: Request):
    app.accounts.cancel_signup(text(req.json(), "email", max_len=320))
    return {"cancelled": True}


@router.route("POST", "/api/account/login")
def login(app, req: Request):
    body = req.json()
    outcome = app.accounts.login(text(body, "identifier", max_len=320), text(body, "password", max_len=300), flag(body, "remember"),
                                 cookie_value(req, DEVICE_COOKIE), device_label(req))
    if outcome.get("needs"):
        return outcome
    return _signed_in(app, req, outcome, extra={"next": "home"})


@router.route("POST", "/api/account/login/code")
def login_code(app, req: Request):
    body = req.json()
    outcome = app.accounts.verify_second_factor(text(body, "challenge", max_len=100), text(body, "code", max_len=20),
                                                flag(body, "trustDevice"), device_label(req))
    return _signed_in(app, req, outcome, extra={"next": "home"})


@router.route("POST", "/api/account/login/recovery-code")
def login_recovery(app, req: Request):
    body = req.json()
    outcome = app.accounts.verify_recovery_code(text(body, "challenge", max_len=100), text(body, "code", max_len=40), device_label(req))
    return _signed_in(app, req, outcome, extra={"next": "home"})


@router.route("POST", "/api/account/logout")
def logout(app, req: Request):
    app.accounts.logout(req.headers.get("cookie", ""))
    response = ok({"signedOut": True})
    response.cookies.append(clear_cookie(SESSION_COOKIE))
    return response


# ------------------------------------------------------------------------------------------------- two-factor
@router.route("POST", "/api/account/2fa/begin")
def tfa_begin(app, req: Request):
    return app.accounts.totp_begin(need_account(app, req), text(req.json(), "password", max_len=300))


@router.route("POST", "/api/account/2fa/confirm")
def tfa_confirm(app, req: Request):
    return app.accounts.totp_confirm(need_account(app, req), text(req.json(), "code", max_len=20))


@router.route("POST", "/api/account/2fa/disable")
def tfa_disable(app, req: Request):
    body = req.json()
    app.accounts.totp_disable(need_account(app, req), text(body, "password", max_len=300), text(body, "code", max_len=40))
    return {"disabled": True}


@router.route("POST", "/api/account/recovery-codes")
def recovery_codes(app, req: Request):
    body = req.json()
    return app.accounts.recovery_regenerate(need_account(app, req), text(body, "password", max_len=300), text(body, "code", max_len=20))


# ----------------------------------------------------------------------------------------- password and recovery
@router.route("POST", "/api/account/password")
def change_password(app, req: Request):
    body = req.json()
    account = need_account(app, req)
    app.accounts.change_password(account, text(body, "current", max_len=300), text(body, "new", max_len=300),
                                 text(body, "code", required=False, max_len=40) or None, app.accounts.session_key(req.headers.get("cookie", "")))
    return {"changed": True, "message": "Your password was changed and your other sessions were signed out."}


@router.route("POST", "/api/account/reset")
def reset_request(app, req: Request):
    return app.accounts.reset_request(text(req.json(), "email", max_len=320))


@router.route("POST", "/api/account/reset/complete")
def reset_complete(app, req: Request):
    body = req.json()
    return app.accounts.reset_complete(text(body, "email", max_len=320), text(body, "code", max_len=100), text(body, "password", max_len=300),
                                       text(body, "factor", required=False, max_len=40) or None)


@router.route("POST", "/api/account/mfa-recovery")
def mfa_recovery_start(app, req: Request):
    body = req.json()
    return app.accounts.mfa_recovery_start(text(body, "email", max_len=320), text(body, "password", max_len=300))


@router.route("POST", "/api/account/mfa-recovery/confirm")
def mfa_recovery_confirm(app, req: Request):
    body = req.json()
    return app.accounts.mfa_recovery_confirm(text(body, "email", max_len=320), text(body, "code", max_len=100))


@router.route("POST", "/api/account/mfa-recovery/cancel")
def mfa_recovery_cancel(app, req: Request):
    app.accounts.mfa_recovery_cancel(need_account(app, req))
    return {"cancelled": True}


# -------------------------------------------------------------------------------------- sessions and devices
@router.route("GET", "/api/account/sessions")
def sessions(app, req: Request):
    return {"sessions": app.accounts.sessions(need_account(app, req), req.headers.get("cookie", "")),
            "devices": app.accounts.devices(need_account(app, req))}


@router.route("DELETE", "/api/account/sessions/{id}")
def revoke_session(app, req: Request):
    app.accounts.revoke_session(need_account(app, req), req.params["id"])
    return {"revoked": True}


@router.route("DELETE", "/api/account/devices/{id}")
def revoke_device(app, req: Request):
    app.accounts.revoke_device(need_account(app, req), req.params["id"])
    return {"revoked": True}


# ------------------------------------------------------------------------------------------------------- plans
@router.route("GET", "/api/plans")
def plans(app, req: Request):
    _, account = app.profile_of(req)
    current = app.plan_of(account)
    return {**app.plans.catalogue(current), "current": current, "billing": app.billing.status()}


@router.route("POST", "/api/plans/checkout")
def plan_checkout(app, req: Request):
    """Starting a paid plan needs a payment provider. Writer ships none, so this always says so and changes nothing."""
    body = req.json()
    plan = text(body, "plan", max_len=20)
    if plan not in app.plans.plans:
        from ..tools.errors import BadRequest
        raise BadRequest("There is no such plan.")
    if app.plans.get(plan)["monthly"] == 0:
        return {"plan": plan, "message": "The Guest plan needs no purchase."}
    app.billing.checkout(plan)
    return {}
