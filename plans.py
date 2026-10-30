"""Plan catalogue and entitlements, read from ``configs/plans.yaml``. Pure data and decisions: no payment code lives here."""
from __future__ import annotations

from pathlib import Path
from typing import Any

from ..tools.errors import DependencyMissing, Forbidden

ORDER = ("guest", "essential", "creator", "professional", "workspace")
EMBED_LEVELS = ("view", "declarative", "advanced", "team")

DEFAULTS: dict[str, Any] = {
    "currency": "EUR", "enforcement": "strict", "yearly_discount_percent": 10, "student_discount_percent": 30,
    "vat_note": "Displayed base prices exclude applicable VAT, which checkout must include.",
}


class Plans:
    def __init__(self, path: Path | None) -> None:
        self.note: str | None = None
        data: dict[str, Any] = {}
        if path is not None and path.is_file():
            try:
                from src.utils.configuration import bind_config
                data = bind_config(path).load()
            except ImportError as exc:
                self.note = f"SLAI's ConfigRepository is not available ({exc}); the plan file could not be read."
            except Exception as exc:  # noqa: BLE001
                raise ValueError(f"Invalid plan file {path.name}: {exc}") from exc
        else:
            self.note = "No plans.yaml found; paid plans are not defined."
        self.cfg = {**DEFAULTS, **{k: v for k, v in data.items() if k != "plans"}}
        self.plans: dict[str, dict[str, Any]] = {}
        for key in ORDER:
            plan = (data.get("plans") or {}).get(key)
            if plan is None:
                continue
            monthly = plan.get("monthly")
            if not isinstance(monthly, (int, float)) or monthly < 0:
                raise ValueError(f"Invalid plan file: {key}.monthly must be a number")
            if plan.get("embed_level") not in EMBED_LEVELS:
                raise ValueError(f"Invalid plan file: {key}.embed_level must be one of {', '.join(EMBED_LEVELS)}")
            self.plans[key] = dict(plan)
        if self.cfg["enforcement"] not in ("strict", "off"):
            raise ValueError("Invalid plan file: enforcement must be 'strict' or 'off'")

    @property
    def enforcing(self) -> bool:
        return self.cfg["enforcement"] == "strict"

    def get(self, key: str) -> dict[str, Any]:
        return self.plans.get(key) or self.plans.get("guest") or {"name": "Guest", "monthly": 0, "embed_level": "view"}

    def yearly(self, key: str) -> float:
        discount = self.cfg["yearly_discount_percent"]
        return round(self.get(key)["monthly"] * 12 * (100 - discount) / 100, 2)

    def catalogue(self, current: str) -> dict[str, Any]:
        rows = []
        for key in ORDER:
            plan = self.plans.get(key)
            if plan is None:
                continue
            rows.append({"id": key, "current": key == current, "yearly": self.yearly(key), **plan})
        return {"currency": self.cfg["currency"], "plans": rows, "vatNote": self.cfg["vat_note"], "enforcement": self.cfg["enforcement"],
                "yearlyDiscountPercent": self.cfg["yearly_discount_percent"], "studentDiscountPercent": self.cfg["student_discount_percent"]}

    def allows_template(self, current: str, min_plan: str) -> bool:
        return not self.enforcing or ORDER.index(current) >= ORDER.index(min_plan)

    def embed_level(self, current: str) -> str:
        return "team" if not self.enforcing else self.get(current).get("embed_level", "view")

    def require_embed(self, current: str, needed: str) -> None:
        if EMBED_LEVELS.index(self.embed_level(current)) < EMBED_LEVELS.index(needed):
            plan = next((k for k in ORDER if self.plans.get(k, {}).get("embed_level") == needed), "a higher plan")
            raise Forbidden("Your plan can view EMBED components but not create or change them.",
                            details={"requires": plan}, hint=f"This needs the {self.get(plan).get('name', plan)} plan.")


class NoBilling:
    """Placeholder for a payment provider. SLAI Writer has none, and says so; it never reports a purchase that did not happen."""

    configured = False
    reason = ("No payment provider is connected to SLAI Writer. Plans cannot be bought from this installation; see docs/OPERATIONS.md for "
              "how a billing service is connected.")

    def status(self) -> dict[str, Any]:
        return {"configured": False, "reason": self.reason}

    def checkout(self, *_: Any, **__: Any) -> None:
        raise DependencyMissing(self.reason, hint="Nothing was charged and your plan is unchanged.")
