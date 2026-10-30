"""Cryptographic signing and verification (SLDC's own scheme) and, separately, visual signature graphics.

Two things are deliberately kept apart, as Document A requires:

* a **cryptographic signature** is made by ``sldc.sign_package`` with an Ed25519 key that is stored passphrase-wrapped on this computer.
  It binds that key to the exact bytes of one frozen revision. Verification (``sldc.verify_package``) reports trust only for keys the
  person chose to trust; a key embedded in a file proves nothing about who holds it, and the signing time is the signer's own claim.
* a **visual signature** is only a picture (drawn, uploaded or chosen) that can be placed in a document. It is never evidence of
  identity or integrity, it is stored sealed in the local database, and placing one never touches the cryptographic layer.

Nothing here implements a signature scheme: signing and verification are SLDC's.
"""
from __future__ import annotations

import base64
import hashlib
import io
import re
import threading
import time
from typing import Any

from ..tools.errors import BadRequest, Forbidden, LimitExceeded, NotFound, Unauthorized
from ..tools.validation import new_id, utc_now
from .protect import unwrap_with_passphrase, wrap_with_passphrase
from .session import DocumentSession, load_bytes, sldc

MIN_PASSPHRASE = 10
MAX_MARK_BYTES = 2 * 1024 * 1024
MAX_MARK_PIXELS = 4_000_000
THUMB = 280
PURPOSES = ("approval", "authorship", "review", "witness")
_DATA_URL = re.compile(r"^data:image/(png|jpeg);base64,([A-Za-z0-9+/=\s]+)$")
VISUAL_NOTE = "A picture of a signature. It does not prove who made it or that the document is unchanged."
CRYPTO_NOTE = "Signed with a cryptographic key. It proves the signed revision is unchanged since signing; it proves who holds the key only if you trust that key."


class SigningService:
    def __init__(self, app: Any) -> None:
        self.app = app
        self.store = app.store
        self._tries: dict[str, list[float]] = {}
        self._lock = threading.Lock()

    def available(self) -> dict[str, Any]:
        try:
            from cryptography.hazmat.primitives.asymmetric import ed25519  # noqa: F401
            return {"available": True, "reason": None}
        except Exception as exc:  # noqa: BLE001
            return {"available": False, "reason": f"Signing needs the 'cryptography' package ({type(exc).__name__}). Install it with pip install cryptography."}

    def _need(self) -> None:
        status = self.available()
        if not status["available"]:
            from ..tools.errors import DependencyMissing
            raise DependencyMissing(status["reason"])

    def _throttle(self, profile: str) -> None:
        now = time.time()
        with self._lock:
            tries = [t for t in self._tries.get(profile, []) if now - t < 900]
            self._tries[profile] = tries
            if len(tries) >= 5:
                raise Forbidden("Too many wrong passphrases. Try again in a few minutes.", details={"retryAfter": int(900 - (now - tries[0]))})

    def _wrong(self, profile: str) -> None:
        with self._lock:
            self._tries.setdefault(profile, []).append(time.time())

    # ------------------------------------------------------------------------------------------------- the signing key
    def key_info(self, profile: str) -> dict[str, Any]:
        row = self.store.key_for(profile)
        if row is None:
            return {"exists": False}
        return {"exists": True, "keyId": row["key_id"], "label": row["label"], "created": row["created"], "algorithm": "ed25519"}

    def create_key(self, profile: str, label: str, passphrase: str) -> dict[str, Any]:
        self._need()
        if self.store.key_for(profile):
            raise BadRequest("You already have a signing key. Delete it first if you want a new one; documents signed with the old key stay valid.")
        if not isinstance(passphrase, str) or len(passphrase) < MIN_PASSPHRASE:
            raise BadRequest(f"Use a signing passphrase of at least {MIN_PASSPHRASE} characters.",
                             hint="It protects your private key on this computer. It cannot be recovered: keep it safe.")
        label = (label or "My signing key").strip()[:60] or "My signing key"
        signer = sldc().Ed25519Signer.generate()
        seed = signer._key.private_bytes(*self._raw())            # noqa: SLF001 - the seed is wrapped immediately and never kept
        wrapped = wrap_with_passphrase(seed, passphrase, "sign:" + signer.key_id)
        self.store.put_key(profile, signer.key_id, signer.public_key, wrapped, label)
        return self.key_info(profile)

    @staticmethod
    def _raw() -> tuple[Any, Any, Any]:
        from cryptography.hazmat.primitives import serialization
        return serialization.Encoding.Raw, serialization.PrivateFormat.Raw, serialization.NoEncryption()

    def delete_key(self, profile: str, passphrase: str) -> None:
        self._unlock(profile, passphrase)                         # deleting a key needs the passphrase too
        self.store.db.execute("DELETE FROM sign_keys WHERE profile=?", (profile,))

    def _unlock(self, profile: str, passphrase: str) -> Any:
        self._need()
        row = self.store.key_for(profile)
        if row is None:
            raise NotFound("You have no signing key yet. Create one first.")
        self._throttle(profile)
        try:
            seed = unwrap_with_passphrase(row["wrapped"], passphrase or "", "sign:" + row["key_id"])
        except Exception:  # noqa: BLE001 - any failure to open means a wrong passphrase or a damaged key
            self._wrong(profile)
            raise Unauthorized("That signing passphrase is not correct.") from None
        signer = sldc().Ed25519Signer.from_seed(seed)
        if signer.key_id != row["key_id"]:
            raise Unauthorized("The stored signing key does not match its record. It was not used.")
        return signer

    # ---------------------------------------------------------------------------------------------- sign a revision
    def preview(self, session: DocumentSession) -> dict[str, Any]:
        """The 'Preview frozen revision' table: exactly what a signature would bind."""
        with session.lock:
            settled = session._settled(session.pkg.copy())                                      # noqa: SLF001
            data = session.to_bytes(settled)
            items = [("Document", session.title), ("Revision", f"{session.revision_no}"), ("Revision fingerprint", sldc().revision_id(settled)),
                     ("Words", str(session.stats.words)), ("Pictures and files", str(len(settled.assets))),
                     ("Review comments", f"{len(settled.comments)} (not covered by the signature)"),
                     ("Existing signatures", str(len(settled.signatures))), ("File size when saved", f"{len(data):,} bytes")]
            return {"items": [{"label": a, "value": b} for a, b in items], "revisionNumber": session.revision_no,
                    "revisionId": sldc().revision_id(settled), "unsaved": session.dirty, "alreadySigned": bool(session.pkg.signatures),
                    "note": CRYPTO_NOTE,
                    "key": self.key_info(session.profile), "purposes": list(PURPOSES)}

    def sign(self, session: DocumentSession, profile: str, passphrase: str, purpose: str, statement: str | None, expected_revision: str | None) -> dict[str, Any]:
        if purpose not in PURPOSES:
            raise BadRequest(f"Choose a purpose: {', '.join(PURPOSES)}.")
        statement = (statement or "").strip()[:500] or None
        with session.lock:
            if expected_revision and expected_revision != sldc().revision_id(session._settled(session.pkg.copy())):          # noqa: SLF001
                from ..tools.errors import Conflict
                raise Conflict("The document changed after you previewed it. Preview the revision again before signing.", details={"kind": "stale_revision"})
            signer = self._unlock(profile, passphrase)
            out = session.apply_signature(signer, purpose=purpose, statement=statement)
            saved: dict[str, Any] | None = None
            save_error = None
            if session.path is not None and not session.readonly_reason:
                try:
                    saved = session.save()
                except Exception as exc:  # noqa: BLE001
                    save_error = getattr(exc, "message", None) or str(exc)
            return {"signed": True, "signature": out["signature"], "revision": session.revision_info(), "saved": saved is not None,
                    "saveError": save_error, "snapshot": out["snapshot"], "note": CRYPTO_NOTE,
                    "verification": self.verify_package(session.pkg)}

    # --------------------------------------------------------------------------------------------------- verification
    def verify_package(self, package: Any) -> list[dict[str, Any]]:
        if not package.signatures:
            return []
        self._need()
        trusted, revoked = self.store.trusted()
        results = sldc().verify_package(package, trusted_keys=set(trusted), revoked_keys=revoked)
        out = []
        for result, record in zip(results, package.signatures):
            payload = record["payload"]
            known = trusted.get(result["key_id"])
            out.append({
                **result, "signerLabel": known["label"] if known else None,
                "signerFingerprint": result["key_id"], "coveredBytes": sum(c["size"] for c in payload["covered"]),
                "coveredParts": len(payload["covered"]), "signedAtClaimed": result["signed_at_claimed"],
                "timestampNote": "The time is the signer's own claim. No timestamp authority was consulted.",
                "headline": self._headline(result["state"]),
            })
        return out

    @staticmethod
    def _headline(state: str) -> str:
        return {"valid_trusted": "Valid, from a key you trust", "valid_unknown_signer": "Valid, but the signer is not known to you",
                "valid_revoked": "Valid, but this key was revoked", "modified": "The document changed after this signature",
                "invalid": "This signature does not verify", "indeterminate": "This signature uses a method Writer cannot check"}.get(state, state)

    def verify(self, session: DocumentSession) -> dict[str, Any]:
        """Page 8 evidence: the current draft plus every signed snapshot of this document."""
        with session.lock:
            current = self.verify_package(session.pkg)
            snapshots = []
            for row in self.store.snapshots(session.doc_id):
                if not row["signed"]:
                    continue
                try:
                    pkg = load_bytes(self.store.snapshot_bytes(row["id"]), session.password)
                except Exception:  # noqa: BLE001 - a damaged snapshot is reported, not hidden
                    snapshots.append({"snapshot": row["id"], "revisionNumber": row["revision_no"], "created": row["created"], "readable": False, "results": []})
                    continue
                snapshots.append({"snapshot": row["id"], "revisionNumber": row["revision_no"], "created": row["created"], "readable": True,
                                  "label": row["label"], "bytes": row["bytes"], "results": self.verify_package(pkg), "revisionId": row["revision_id"]})
            status = "unsigned"
            if current:
                status = "signed" if all(r["state"].startswith("valid") for r in current) else "problem"
            elif snapshots:
                status = "modified_draft"
            return {"status": status, "revision": session.revision_info(), "current": current, "signedSnapshots": snapshots,
                    "trusted": self.trusted_list(), "visualNote": VISUAL_NOTE, "cryptoNote": CRYPTO_NOTE,
                    "checkedAt": utc_now(), "online": False,
                    "network": "Verification is done on this computer. Nothing was checked online, so a revoked key you have not been told about is not detected."}

    def compare(self, session: DocumentSession, snapshot_id: str) -> dict[str, Any]:
        """A block-level comparison of a snapshot with the current draft."""
        row = self.store.snapshot(snapshot_id)
        if row["doc_id"] != session.doc_id:
            raise BadRequest("That version belongs to a different document.")
        old = load_bytes(self.store.snapshot_bytes(snapshot_id), session.password)
        text = sldc().block_text
        a = {b["id"]: b for b in old.document["blocks"]}
        b = {x["id"]: x for x in session.pkg.document["blocks"]}
        changed = [{"block": i, "before": text(a[i]), "after": text(b[i])} for i in a if i in b and (text(a[i]) != text(b[i]) or a[i]["type"] != b[i]["type"])]
        removed = [{"block": i, "before": text(a[i])} for i in a if i not in b]
        added = [{"block": i, "after": text(b[i])} for i in b if i not in a]
        return {"snapshot": snapshot_id, "revisionNumber": row["revision_no"], "changed": changed[:500], "removed": removed[:500], "added": added[:500],
                "counts": {"changed": len(changed), "removed": len(removed), "added": len(added)},
                "identical": not (changed or removed or added)}

    # ----------------------------------------------------------------------------------------------------------- trust
    def trusted_list(self) -> list[dict[str, Any]]:
        rows = self.store.db.rows("SELECT key_id, label, added, revoked FROM trusted_keys ORDER BY added DESC")
        return [{"keyId": r["key_id"], "label": r["label"], "added": r["added"], "revoked": bool(r["revoked"])} for r in rows]

    def trust_from_document(self, session: DocumentSession, signature_id: str, label: str) -> dict[str, Any]:
        """Trust the key behind a signature. This is the person's own decision; the file cannot make it for them."""
        packages = [session.pkg] + [load_bytes(self.store.snapshot_bytes(r["id"]), session.password) for r in self.store.snapshots(session.doc_id) if r["signed"]]
        for pkg in packages:
            for record in pkg.signatures:
                if record["id"] == signature_id:
                    key = base64.urlsafe_b64decode(record["public_key"] + "=" * (-len(record["public_key"]) % 4))
                    self.store.trust_key(record["key_id"], (label or "Trusted signer").strip(), key)
                    return {"trusted": record["key_id"]}
        raise NotFound("That signature is not in this document.")

    def revoke(self, key_id: str) -> None:
        if not re.fullmatch(r"[0-9a-f]{64}", key_id or ""):
            raise BadRequest("That is not a key fingerprint.")
        self.store.revoke_key(key_id)

    # ------------------------------------------------------------------------------------------------ visual signatures
    def _clean_image(self, data: bytes) -> tuple[bytes, int, int]:
        """Decode, bound and re-encode as a metadata-free PNG with a transparent background where the source had one."""
        if len(data) > MAX_MARK_BYTES:
            raise LimitExceeded(f"A signature picture is at most {MAX_MARK_BYTES // 1024 // 1024} MiB.")
        try:
            from PIL import Image
        except Exception as exc:  # noqa: BLE001
            from ..tools.errors import DependencyMissing
            raise DependencyMissing("Pillow is required to prepare signature pictures (pip install pillow).") from exc
        Image.MAX_IMAGE_PIXELS = MAX_MARK_PIXELS * 4
        try:
            with Image.open(io.BytesIO(data)) as image:
                if image.format not in ("PNG", "JPEG"):
                    raise BadRequest("Use a PNG or JPEG picture of your signature.")
                if image.width * image.height > MAX_MARK_PIXELS:
                    raise LimitExceeded("That picture is too large. Use one under about 4 megapixels.")
                image.load()
                rgba = image.convert("RGBA")
        except (BadRequest, LimitExceeded):
            raise
        except Exception:  # noqa: BLE001
            raise BadRequest("That file is not a readable picture.") from None
        rgba.thumbnail((1600, 800))
        out = io.BytesIO()
        rgba.save(out, "PNG", optimize=True)
        return out.getvalue(), rgba.width, rgba.height

    def decode_upload(self, payload: str | bytes) -> bytes:
        if isinstance(payload, bytes):
            return payload
        match = _DATA_URL.match(payload.strip() if isinstance(payload, str) else "")
        if not match:
            raise BadRequest("Send the picture as a PNG or JPEG.")
        try:
            return base64.b64decode(match.group(2), validate=False)
        except Exception:  # noqa: BLE001
            raise BadRequest("The picture could not be decoded.") from None

    def add_mark(self, profile: str, image: str | bytes, *, kind: str, label: str, group: int | None) -> dict[str, Any]:
        if kind not in ("draw", "upload"):
            raise BadRequest("A signature graphic is drawn or uploaded.")
        cfg = self.app.settings.signatures
        png, width, height = self._clean_image(self.decode_upload(image))
        if self._blank(png):
            raise BadRequest("That picture looks empty. Draw or upload your signature.")
        rows = self.store.db.rows("SELECT grp FROM sig_marks WHERE profile=?", (profile,))
        if len(rows) >= cfg["max_samples"]:
            raise LimitExceeded(f"You can keep up to {cfg['max_samples']} signature pictures. Delete one to add another.")
        groups = {r["grp"] for r in rows}
        grp = int(group) if group else (min(groups) if groups else 1)
        if grp not in groups and len(groups) >= cfg["max_distinct"]:
            raise LimitExceeded(f"You can keep {cfg['max_distinct']} different signatures. Add this one to an existing signature, or delete one first.")
        mark_id = new_id()
        digest = hashlib.sha256(png).hexdigest()
        sealed = self.app.key.seal(png, "sigmark:" + mark_id)
        self.store.db.execute("INSERT INTO sig_marks VALUES(?,?,?,?,?,?,?,?,?,?)",
                              (mark_id, profile, (label or "Signature").strip()[:60] or "Signature", grp, kind, width, height, utc_now(), sealed, digest))
        return self.mark_public(self.store.db.row("SELECT * FROM sig_marks WHERE id=?", (mark_id,)))

    @staticmethod
    def _blank(png: bytes) -> bool:
        from PIL import Image
        with Image.open(io.BytesIO(png)) as image:
            alpha = image.getchannel("A").tobytes()
            rgb = image.convert("RGB").tobytes()
        ink = 0
        for i, a in enumerate(alpha):
            if a > 40 and rgb[3 * i] + rgb[3 * i + 1] + rgb[3 * i + 2] < 700:
                ink += 1
                if ink > 30:
                    return False
        return True

    def mark_public(self, row: dict[str, Any], thumb: bool = True) -> dict[str, Any]:
        out = {"id": row["id"], "label": row["label"], "group": row["grp"], "kind": row["kind"], "width": row["width"], "height": row["height"],
               "created": row["created"], "visualOnly": True, "note": VISUAL_NOTE}
        if thumb:
            out["image"] = "data:image/png;base64," + base64.b64encode(self._thumb(self.mark_png(row))).decode("ascii")
        return out

    @staticmethod
    def _thumb(png: bytes) -> bytes:
        from PIL import Image
        with Image.open(io.BytesIO(png)) as image:
            image.thumbnail((THUMB, THUMB // 2))
            out = io.BytesIO()
            image.save(out, "PNG")
            return out.getvalue()

    def mark_png(self, row: dict[str, Any]) -> bytes:
        return self.app.key.unseal(row["blob"], "sigmark:" + row["id"])

    def marks(self, profile: str) -> dict[str, Any]:
        rows = self.store.db.rows("SELECT * FROM sig_marks WHERE profile=? ORDER BY grp, created", (profile,))
        cfg = self.app.settings.signatures
        return {"marks": [self.mark_public(r) for r in rows], "limits": {"distinct": cfg["max_distinct"], "samples": cfg["max_samples"]},
                "note": VISUAL_NOTE + " No signature picture is needed to sign in."}

    def delete_mark(self, profile: str, mark_id: str) -> None:
        if not self.store.db.execute("DELETE FROM sig_marks WHERE id=? AND profile=?", (mark_id, profile)).rowcount:
            raise NotFound("That signature picture no longer exists.")

    def adopt_profile(self, from_profile: str, to_profile: str) -> int:
        """Pictures saved as a guest can move to an account when the person signs in (only on request)."""
        return self.store.db.execute("UPDATE sig_marks SET profile=? WHERE profile=?", (to_profile, from_profile)).rowcount

    def place(self, session: DocumentSession, profile: str, mark_id: str, after_block: str | None, width_mm: float = 45.0) -> dict[str, Any]:
        """Put a signature picture into the document as a clearly-labelled figure. It remains a picture, however it is placed."""
        row = self.store.db.row("SELECT * FROM sig_marks WHERE id=? AND profile=?", (mark_id, profile))
        if row is None:
            raise NotFound("That signature picture no longer exists.")
        asset = session.add_image(self.mark_png(row))
        figure = {"asset": asset.id, "alt": "Visual signature (picture only; not a cryptographic signature)", "width_mm": max(10.0, min(float(width_mm), 120.0))}
        block_id = None
        result = session.apply({"op": "block_insert", "after": after_block, "block": {"type": "figure", "text": "", "figure": figure}}, None)
        block_id = (result.get("result") or {}).get("block") or (result.get("created") or [None])[0]
        marks = list((session.doc.get("extensions", {}).get("slai.writer", {}) or {}).get("signature_marks", []))
        if block_id:
            marks.append({"block": block_id, "placed": utc_now(), "visual": True})
            session.apply({"op": "ext_set", "values": {"signature_marks": marks[-200:]}}, None)
        return {"placed": True, "block": block_id, "note": VISUAL_NOTE, "state": session.state()}
