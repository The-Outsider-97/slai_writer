"""Protection of small local secrets (TOTP seeds, signature graphics, signing keys) at rest.

This is *not* a document format and does not touch SLDC's own encryption: documents are encrypted only by ``src.utils.sldc``. Here a
random 256-bit master key (a file in the application's data folder, readable by its owner only) seals values with AES-256-GCM from
the ``cryptography`` package, and a passphrase is stretched with scrypt (``hashlib``) to seal the signing key. Nothing is invented:
both primitives are the standard ones, used the standard way, and every sealed value is bound to a label so it cannot be swapped.
"""
from __future__ import annotations

import hashlib
import hmac
import os
import secrets
from pathlib import Path

from ..tools.errors import DependencyMissing, Forbidden, StorageError
from ..tools.storage import atomic_write

SCRYPT_N, SCRYPT_R, SCRYPT_P = 2 ** 15, 8, 1
MAGIC = b"SWP1"


def _aesgcm():
    try:
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    except ImportError as exc:                                       # pragma: no cover - cryptography ships with SLAI
        raise DependencyMissing("The 'cryptography' package is needed to protect secrets on this computer (pip install cryptography).") from exc
    return AESGCM


class MasterKey:
    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        try:
            if self.path.is_file():
                key = self.path.read_bytes()
                if len(key) != 32:
                    raise StorageError("The protection key file is damaged. Restore it from a backup; nothing was changed.",
                                       reason="corrupt")
            else:
                key = secrets.token_bytes(32)
                atomic_write(self.path, key, exclusive=True)
                try:
                    os.chmod(self.path, 0o600)
                except OSError:
                    pass
        except FileExistsError:                                      # another start-up created it first
            key = self.path.read_bytes()
        self._key = key

    def seal(self, data: bytes, label: str) -> bytes:
        nonce = os.urandom(12)
        return MAGIC + nonce + _aesgcm()(self._key).encrypt(nonce, data, label.encode("utf-8"))

    def unseal(self, blob: bytes, label: str) -> bytes:
        if not blob.startswith(MAGIC) or len(blob) < 4 + 12 + 16:
            raise StorageError("A protected value is damaged.", reason="corrupt")
        nonce, body = blob[4:16], blob[16:]
        try:
            return _aesgcm()(self._key).decrypt(nonce, body, label.encode("utf-8"))
        except Exception as exc:                                     # noqa: BLE001 - InvalidTag and friends
            raise StorageError("A protected value could not be opened with this computer's key.", reason="corrupt") from exc

    def mac(self, data: bytes, label: str) -> str:
        return hmac.new(self._key, label.encode("utf-8") + b"\x00" + data, hashlib.sha256).hexdigest()


def wrap_with_passphrase(data: bytes, passphrase: str, label: str) -> bytes:
    salt = os.urandom(16)
    key = hashlib.scrypt(passphrase.encode("utf-8"), salt=salt, n=SCRYPT_N, r=SCRYPT_R, p=SCRYPT_P, dklen=32, maxmem=128 * 1024 * 1024)
    nonce = os.urandom(12)
    return MAGIC + salt + nonce + _aesgcm()(key).encrypt(nonce, data, label.encode("utf-8"))


def unwrap_with_passphrase(blob: bytes, passphrase: str, label: str) -> bytes:
    if not blob.startswith(MAGIC) or len(blob) < 4 + 16 + 12 + 16:
        raise StorageError("The protected key is damaged.", reason="corrupt")
    salt, nonce, body = blob[4:20], blob[20:32], blob[32:]
    key = hashlib.scrypt(passphrase.encode("utf-8"), salt=salt, n=SCRYPT_N, r=SCRYPT_R, p=SCRYPT_P, dklen=32, maxmem=128 * 1024 * 1024)
    try:
        return _aesgcm()(key).decrypt(nonce, body, label.encode("utf-8"))
    except Exception as exc:                                         # noqa: BLE001
        raise Forbidden("That passphrase does not open the key.") from exc


def hash_password(password: str) -> tuple[bytes, bytes]:
    salt = os.urandom(16)
    return hashlib.scrypt(password.encode("utf-8"), salt=salt, n=SCRYPT_N, r=SCRYPT_R, p=SCRYPT_P, dklen=32, maxmem=128 * 1024 * 1024), salt


def check_password(password: str, expected: bytes, salt: bytes) -> bool:
    got = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=SCRYPT_N, r=SCRYPT_R, p=SCRYPT_P, dklen=32, maxmem=128 * 1024 * 1024)
    return hmac.compare_digest(got, expected)
