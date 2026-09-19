"""DPAPI CurrentUser-protected Ed25519 identity storage."""

from __future__ import annotations

import base64
from dataclasses import dataclass
from hashlib import sha256
import json
import os
from pathlib import Path
import stat
import uuid

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey


class KeyStoreError(RuntimeError):
    pass


@dataclass(frozen=True)
class PublicIdentity:
    node_id: str
    key_version: int
    public_key_pem: str
    fingerprint_sha256: str


class IdentitySigner:
    __slots__ = ("_private_key", "public_identity")

    def __init__(self, private_key, public_identity):
        self._private_key = private_key
        self.public_identity = public_identity

    def sign(self, payload: bytes) -> bytes:
        if not isinstance(payload, bytes):
            raise TypeError("signing payload must be bytes")
        return self._private_key.sign(payload)

    def __repr__(self):
        return f"IdentitySigner(node_id={self.public_identity.node_id!r}, key_version={self.public_identity.key_version})"


class DpapiCurrentUserProtector:
    def __init__(self, *, win32crypt_module=None):
        if win32crypt_module is None:
            try:
                import win32crypt as win32crypt_module
            except ImportError as exc:
                raise KeyStoreError("pywin32 DPAPI support is unavailable") from exc
        self._win32crypt = win32crypt_module

    def protect(self, plaintext: bytes, entropy: bytes) -> bytes:
        try:
            return bytes(self._win32crypt.CryptProtectData(
                bytes(plaintext), "AEGIS Identity Agent", bytes(entropy), None, None, 0
            ))
        except Exception as exc:
            raise KeyStoreError("DPAPI CurrentUser protection failed") from exc

    def unprotect(self, blob: bytes, entropy: bytes) -> bytes:
        try:
            _description, plaintext = self._win32crypt.CryptUnprotectData(
                bytes(blob), bytes(entropy), None, None, 0
            )
            return bytes(plaintext)
        except Exception as exc:
            raise KeyStoreError("protected identity cannot be decrypted") from exc


def _is_reparse(path: Path) -> bool:
    try:
        details = path.lstat()
    except FileNotFoundError:
        return False
    attributes = getattr(details, "st_file_attributes", 0)
    return stat.S_ISLNK(details.st_mode) or bool(attributes & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400))


def validate_windows_service_acl(path: Path) -> bool:
    """Require a protected DACL granting FullControl only to service SID and SYSTEM."""
    try:
        import ntsecuritycon
        import win32security

        descriptor = win32security.GetNamedSecurityInfo(
            str(path),
            win32security.SE_FILE_OBJECT,
            win32security.OWNER_SECURITY_INFORMATION | win32security.DACL_SECURITY_INFORMATION,
        )
        control, _revision = descriptor.GetSecurityDescriptorControl()
        if not control & win32security.SE_DACL_PROTECTED:
            return False
        allowed = [
            win32security.LookupAccountName(None, r"NT SERVICE\AEGISIdentityAgent")[0],
            win32security.LookupAccountName(None, r"NT AUTHORITY\SYSTEM")[0],
        ]
        owner = descriptor.GetSecurityDescriptorOwner()
        if not win32security.EqualSid(owner, allowed[0]):
            return False
        dacl = descriptor.GetSecurityDescriptorDacl()
        if dacl is None or dacl.GetAceCount() != 2:
            return False
        seen = [False, False]
        for index in range(dacl.GetAceCount()):
            header, mask, sid = dacl.GetAce(index)
            if header[0] != win32security.ACCESS_ALLOWED_ACE_TYPE:
                return False
            if header[1] & win32security.INHERITED_ACE:
                return False
            if mask & ntsecuritycon.FILE_ALL_ACCESS != ntsecuritycon.FILE_ALL_ACCESS:
                return False
            matches = [win32security.EqualSid(sid, expected) for expected in allowed]
            if matches.count(True) != 1:
                return False
            seen[matches.index(True)] = True
        return all(seen)
    except Exception:
        return False


def harden_windows_service_acl(path: Path) -> None:
    try:
        import ntsecuritycon
        import win32security

        service_sid = win32security.LookupAccountName(None, r"NT SERVICE\AEGISIdentityAgent")[0]
        system_sid = win32security.LookupAccountName(None, r"NT AUTHORITY\SYSTEM")[0]
        dacl = win32security.ACL()
        dacl.AddAccessAllowedAceEx(win32security.ACL_REVISION_DS, 0, ntsecuritycon.FILE_ALL_ACCESS, service_sid)
        dacl.AddAccessAllowedAceEx(win32security.ACL_REVISION_DS, 0, ntsecuritycon.FILE_ALL_ACCESS, system_sid)
        win32security.SetNamedSecurityInfo(
            str(path),
            win32security.SE_FILE_OBJECT,
            win32security.OWNER_SECURITY_INFORMATION
            | win32security.DACL_SECURITY_INFORMATION
            | win32security.PROTECTED_DACL_SECURITY_INFORMATION,
            service_sid,
            None,
            dacl,
            None,
        )
    except Exception as exc:
        raise KeyStoreError("protected identity ACL hardening failed") from exc


class IdentityKeyStore:
    VERSION = 1

    def __init__(
        self,
        path,
        *,
        node_id: str,
        key_version: int,
        protector=None,
        acl_validator=None,
        acl_hardener=None,
        reparse_checker=None,
    ):
        self.path = Path(path)
        self.node_id = node_id
        self.key_version = key_version
        self._protector = protector or DpapiCurrentUserProtector()
        self._acl_validator = acl_validator or validate_windows_service_acl
        self._acl_hardener = acl_hardener or ((lambda _path: None) if acl_validator else harden_windows_service_acl)
        self._reparse_checker = reparse_checker or _is_reparse

    def _entropy(self) -> bytes:
        return f"AEGIS-IDENTITY-V1\0{self.node_id}\0{self.key_version}".encode("utf-8")

    def _validate_path(self, *, must_exist: bool) -> None:
        if self._reparse_checker(self.path.parent) or self._reparse_checker(self.path):
            raise KeyStoreError("identity path must not be a reparse point")
        if self.path.parent.exists() and not self._acl_validator(self.path.parent):
            raise KeyStoreError("identity directory ACL is not exact")
        if must_exist and not self.path.is_file():
            raise KeyStoreError("protected identity is missing")
        if must_exist and not self._acl_validator(self.path):
            raise KeyStoreError("protected identity ACL is not exact")

    def generate(self) -> PublicIdentity:
        self._validate_path(must_exist=False)
        if self.path.exists():
            raise KeyStoreError("protected identity already exists")
        self.path.parent.mkdir(parents=True, exist_ok=True)
        if not self._acl_validator(self.path.parent):
            raise KeyStoreError("identity directory ACL is not exact")
        private_key = Ed25519PrivateKey.generate()
        public = self._public_identity(private_key)
        private_der = bytearray(private_key.private_bytes(
            serialization.Encoding.DER,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        ))
        envelope = bytearray(json.dumps({
            "version": self.VERSION,
            "nodeId": self.node_id,
            "keyVersion": self.key_version,
            "privateKeyPkcs8": base64.b64encode(private_der).decode("ascii"),
            "publicKeyPem": public.public_key_pem,
            "fingerprintSha256": public.fingerprint_sha256,
        }, sort_keys=True, separators=(",", ":")).encode("utf-8"))
        try:
            protected = self._protector.protect(envelope, self._entropy())
        finally:
            for index in range(len(private_der)):
                private_der[index] = 0
            for index in range(len(envelope)):
                envelope[index] = 0
        temporary = self.path.with_name(f".{self.path.name}.{uuid.uuid4().hex}.tmp")
        try:
            with temporary.open("xb") as handle:
                handle.write(protected)
                handle.flush()
                os.fsync(handle.fileno())
            if self.path.exists():
                raise KeyStoreError("protected identity already exists")
            os.rename(temporary, self.path)
        finally:
            try:
                temporary.unlink()
            except FileNotFoundError:
                pass
        self._acl_hardener(self.path)
        if not self._acl_validator(self.path):
            try:
                self.path.unlink()
            except OSError:
                pass
            raise KeyStoreError("protected identity ACL is not exact")
        return public

    def generate_signer(self) -> IdentitySigner:
        if not self.path.exists():
            self.generate()
        return self.load()

    def load(self) -> IdentitySigner:
        self._validate_path(must_exist=True)
        plaintext = bytearray()
        private_der = bytearray()
        try:
            plaintext.extend(self._protector.unprotect(self.path.read_bytes(), self._entropy()))
            if len(plaintext) > 16 * 1024:
                raise KeyStoreError("protected identity envelope is oversized")
            envelope = json.loads(bytes(plaintext).decode("utf-8"))
            expected = {"version", "nodeId", "keyVersion", "privateKeyPkcs8", "publicKeyPem", "fingerprintSha256"}
            if not isinstance(envelope, dict) or set(envelope) != expected:
                raise KeyStoreError("protected identity envelope is invalid")
            if envelope["version"] != self.VERSION or envelope["nodeId"] != self.node_id or envelope["keyVersion"] != self.key_version:
                raise KeyStoreError("protected identity does not match configured identity")
            private_der.extend(base64.b64decode(envelope["privateKeyPkcs8"], validate=True))
            private_key = serialization.load_der_private_key(bytes(private_der), password=None)
            if not isinstance(private_key, Ed25519PrivateKey):
                raise KeyStoreError("protected identity is not Ed25519")
            public = self._public_identity(private_key)
            if public.public_key_pem != envelope["publicKeyPem"] or public.fingerprint_sha256 != envelope["fingerprintSha256"]:
                raise KeyStoreError("protected identity public binding is invalid")
            return IdentitySigner(private_key, public)
        except KeyStoreError:
            raise
        except Exception as exc:
            raise KeyStoreError("protected identity is corrupt or unavailable") from exc
        finally:
            for buffer in (plaintext, private_der):
                for index in range(len(buffer)):
                    buffer[index] = 0

    def _public_identity(self, private_key) -> PublicIdentity:
        pem = private_key.public_key().public_bytes(
            serialization.Encoding.PEM,
            serialization.PublicFormat.SubjectPublicKeyInfo,
        ).decode("ascii")
        der = private_key.public_key().public_bytes(
            serialization.Encoding.DER,
            serialization.PublicFormat.SubjectPublicKeyInfo,
        )
        return PublicIdentity(self.node_id, self.key_version, pem, sha256(der).hexdigest())
