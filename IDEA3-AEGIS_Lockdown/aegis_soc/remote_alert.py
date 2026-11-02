"""IDEA3 remote alerts: the signed envelope a protected host (Beelink) sends to the Core, and the Core-side verifier.

The transport is MQTT over mutual TLS, but the broker is only a courier: an MQTT subscriber cannot see who published a
message. So each alert carries its own proof. The sender attaches its client certificate and signs the exact payload with
that certificate's private key; the Core verifies, with no help from the broker, that

* the certificate was issued by the configured client CA, is inside its validity window, is a client-auth leaf, and
  carries the identity configured for the claimed source (``aegis-alert-<source>``; optionally a pinned SHA-256);
* the signature over the payload verifies under that certificate's key (the algorithm comes from the certificate, never from
  the message);
* the topic, the claimed source and the allowlist agree, the kind is one of the observation kinds, the address passes the
  Core's own address rules, the alert is fresh against the Core clock and its signature has not been seen before.

Anything else is a ``Refusal`` carrying a stable code. A refusal is final: it never reaches scoring.

Envelope (JSON, at most 8 KiB)::

    {"v": 1,
     "payload": {"at": <unix seconds>, "kind": "ssh_brute_force" | "ssh_login_after_failures",
                 "attacker_ip": "<IPv4>", "detail": "<short ascii>", "source": "<source id>", "nonce": "<32 hex>"},
     "cert": "<base64 DER leaf certificate>",
     "sig": "<base64 signature over the canonical payload>"}

There is deliberately no "all clear" or "resolved" kind: a remote host can only add evidence, never lower a level or release a
latched state. The module holds no secret and performs no I/O besides reading key/certificate files in the signing helper;
``cryptography`` is imported lazily so a host without it fails closed with ``CRYPTO_UNAVAILABLE``.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import math
import re
import secrets
import threading
import time
from collections import OrderedDict
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass

from . import ip_containment

TOPIC_PREFIX = "aegis/alert/"
ENVELOPE_VERSION = 1
MAX_ENVELOPE_BYTES = 8192
MAX_SKEW_SEC = 120.0       # an alert further than this from the Core clock is stale (or from the future)
REPLAY_WINDOW_SEC = 600.0  # a signature is remembered for longer than the freshness window
REPLAY_MAX_ENTRIES = 4096
MAX_DETAIL_CHARS = 200
IDENTITY_PREFIX = "aegis-alert-"

#: What a protected host may report: the same observations the local graduated detector reports for SSH.
KIND_SSH_BRUTE_FORCE = "ssh_brute_force"
KIND_SSH_LOGIN_AFTER_FAILURES = "ssh_login_after_failures"
REMOTE_KINDS = frozenset({KIND_SSH_BRUTE_FORCE, KIND_SSH_LOGIN_AFTER_FAILURES})

PAYLOAD_KEYS = frozenset({"at", "kind", "attacker_ip", "detail", "source", "nonce"})
ENVELOPE_KEYS = frozenset({"v", "payload", "cert", "sig"})

_SOURCE_RE = re.compile(r"[a-z][a-z0-9_-]{0,31}", re.ASCII)
_NONCE_RE = re.compile(r"[0-9a-f]{32}", re.ASCII)
_DETAIL_RE = re.compile(rf"[ -~]{{0,{MAX_DETAIL_CHARS}}}", re.ASCII)

# Stable refusal codes (audit rows and tests use these; none carries sender-controlled text).
CRYPTO_UNAVAILABLE = "CRYPTO_UNAVAILABLE"
CLOCK_UNTRUSTED = "CLOCK_UNTRUSTED"
OVERSIZE = "OVERSIZE"
MALFORMED = "MALFORMED"
TOPIC_INVALID = "TOPIC_INVALID"
TOPIC_SOURCE_MISMATCH = "TOPIC_SOURCE_MISMATCH"
SOURCE_NOT_ALLOWED = "SOURCE_NOT_ALLOWED"
CERT_MISSING = "CERT_MISSING"
CERT_INVALID = "CERT_INVALID"
CERT_UNTRUSTED = "CERT_UNTRUSTED"
CERT_EXPIRED = "CERT_EXPIRED"
CERT_NOT_YET_VALID = "CERT_NOT_YET_VALID"
CERT_NOT_CLIENT_AUTH = "CERT_NOT_CLIENT_AUTH"
CERT_IS_CA = "CERT_IS_CA"
CERT_IDENTITY_MISMATCH = "CERT_IDENTITY_MISMATCH"
CERT_NOT_PINNED = "CERT_NOT_PINNED"
KEY_UNSUPPORTED = "KEY_UNSUPPORTED"
SIGNATURE_MISSING = "SIGNATURE_MISSING"
BAD_SIGNATURE = "BAD_SIGNATURE"
BAD_KIND = "BAD_KIND"
BAD_ADDRESS = "BAD_ADDRESS"
BAD_DETAIL = "BAD_DETAIL"
STALE = "STALE"
FROM_THE_FUTURE = "FROM_THE_FUTURE"
REPLAY = "REPLAY"
RATE_LIMITED = "RATE_LIMITED"
RETAINED = "RETAINED"


class Refusal(Exception):
    """A remote alert that must not be scored. ``code`` is one of the stable constants above."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class RemoteAlert:
    source: str
    kind: str
    attacker_ip: str
    detail: str
    at: float
    cert_sha256: str  # the verified sender certificate, for the audit row


@dataclass(frozen=True)
class SourcePolicy:
    """What the Core expects of one source. ``identity`` is the certificate common name; ``pinned_sha256`` (optional)
    additionally restricts the source to specific leaf certificates (lowercase hex SHA-256 of the DER)."""

    identity: str
    pinned_sha256: frozenset[str] = frozenset()


def valid_source(value: object) -> bool:
    return isinstance(value, str) and _SOURCE_RE.fullmatch(value) is not None


def identity_for(source: str) -> str:
    return IDENTITY_PREFIX + source


def topic_for(source: str) -> str:
    if not valid_source(source):
        raise ValueError("invalid source id")
    return TOPIC_PREFIX + source


def source_from_topic(topic: object) -> str:
    if not isinstance(topic, str) or not topic.startswith(TOPIC_PREFIX):
        raise Refusal(TOPIC_INVALID)
    source = topic[len(TOPIC_PREFIX):]
    if not valid_source(source):
        raise Refusal(TOPIC_INVALID)
    return source


def canonical(payload: Mapping[str, object]) -> bytes:
    """The exact bytes that are signed and verified: sorted keys, no whitespace, ASCII only."""
    return json.dumps(dict(payload), sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False).encode("ascii")


def _crypto():
    try:
        from cryptography import x509
        from cryptography.exceptions import InvalidSignature
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import ec, ed25519, padding, rsa
        from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID
    except ImportError:
        return None
    return {
        "x509": x509, "InvalidSignature": InvalidSignature, "hashes": hashes, "serialization": serialization, "ec": ec,
        "ed25519": ed25519, "padding": padding, "rsa": rsa, "EKU": ExtendedKeyUsageOID, "NameOID": NameOID,
    }


# ------------------------------------------------------------------------------------------------ signing (sender side)


def _sign(private_key, data: bytes) -> bytes:
    c = _crypto()
    if c is None:
        raise Refusal(CRYPTO_UNAVAILABLE)
    if isinstance(private_key, c["ed25519"].Ed25519PrivateKey):
        return private_key.sign(data)
    if isinstance(private_key, c["ec"].EllipticCurvePrivateKey) and private_key.curve.name in ("secp256r1", "secp384r1"):
        return private_key.sign(data, c["ec"].ECDSA(c["hashes"].SHA256()))
    if isinstance(private_key, c["rsa"].RSAPrivateKey) and private_key.key_size >= 2048:
        return private_key.sign(
            data, c["padding"].PSS(mgf=c["padding"].MGF1(c["hashes"].SHA256()), salt_length=32), c["hashes"].SHA256(),
        )
    raise Refusal(KEY_UNSUPPORTED)


def build_envelope(*, source: str, kind: str, attacker_ip: str, detail: str, cert_der: bytes, private_key,
                   now: float | None = None, nonce: str | None = None) -> bytes:
    """One signed envelope as the exact bytes to publish. Raises ``Refusal``/``ValueError`` for anything the Core would refuse."""
    if not valid_source(source):
        raise ValueError("invalid source id")
    if kind not in REMOTE_KINDS:
        raise Refusal(BAD_KIND)
    try:
        address = str(ip_containment.validate_block_target(attacker_ip, ()))
    except ip_containment.ContainmentRejected:
        raise Refusal(BAD_ADDRESS) from None
    if not isinstance(detail, str) or _DETAIL_RE.fullmatch(detail) is None:
        raise Refusal(BAD_DETAIL)
    payload = {
        "at": round(time.time() if now is None else float(now), 3), "kind": kind, "attacker_ip": address, "detail": detail,
        "source": source, "nonce": secrets.token_hex(16) if nonce is None else nonce,
    }
    signature = _sign(private_key, canonical(payload))
    envelope = {
        "v": ENVELOPE_VERSION, "payload": payload, "cert": base64.b64encode(cert_der).decode("ascii"),
        "sig": base64.b64encode(signature).decode("ascii"),
    }
    raw = json.dumps(envelope, sort_keys=True, separators=(",", ":")).encode("ascii")
    if len(raw) > MAX_ENVELOPE_BYTES:
        raise Refusal(OVERSIZE)
    return raw


def load_identity(cert_path: str, key_path: str):
    """``(cert_der, private_key)`` from PEM files. The key never leaves this process."""
    c = _crypto()
    if c is None:
        raise Refusal(CRYPTO_UNAVAILABLE)
    with open(cert_path, "rb") as handle:
        certificate = c["x509"].load_pem_x509_certificate(handle.read())
    with open(key_path, "rb") as handle:
        key = c["serialization"].load_pem_private_key(handle.read(), password=None)
    return certificate.public_bytes(c["serialization"].Encoding.DER), key


# ----------------------------------------------------------------------------------------------- verification (Core side)


class RemoteAlertVerifier:
    """Verifies one MQTT message at a time. Thread-safe; holds only public material (CA certificates, policies)."""

    def __init__(self, *, ca_pem_chunks: Iterable[bytes], sources: Mapping[str, SourcePolicy],
                 clock: Callable[[], float] = time.time, clock_trusted: Callable[[], bool] = lambda: True) -> None:
        self._clock = clock
        self._clock_trusted = clock_trusted
        self._sources = dict(sources)
        for name, policy in self._sources.items():
            if not valid_source(name) or not policy.identity:
                raise ValueError("invalid remote alert source policy")
        self._seen: OrderedDict[str, float] = OrderedDict()
        self._lock = threading.Lock()
        c = _crypto()
        self._cas: list = []
        if c is not None:
            for chunk in ca_pem_chunks:
                self._cas.extend(c["x509"].load_pem_x509_certificates(chunk))
            if not self._cas:
                raise ValueError("at least one client CA certificate is required")

    @property
    def sources(self) -> frozenset[str]:
        return frozenset(self._sources)

    # -- public ---------------------------------------------------------------------------------------------------------
    def verify(self, topic: object, raw: object) -> RemoteAlert:
        c = _crypto()
        if c is None:
            raise Refusal(CRYPTO_UNAVAILABLE)
        if not self._clock_trusted():
            raise Refusal(CLOCK_UNTRUSTED)  # freshness and certificate validity both need a trustworthy Core clock
        topic_source = source_from_topic(topic)
        if topic_source not in self._sources:
            raise Refusal(SOURCE_NOT_ALLOWED)
        envelope = self._parse(raw)
        payload = envelope["payload"]
        if payload["source"] != topic_source:
            raise Refusal(TOPIC_SOURCE_MISMATCH)
        policy = self._sources[topic_source]
        leaf = self._verify_certificate(c, envelope["cert"], policy)
        self._verify_signature(c, leaf, envelope["sig"], payload)
        kind, address, detail, at = self._verify_payload(payload)
        self._remember(envelope["sig"])
        return RemoteAlert(topic_source, kind, address, detail, at,
                           hashlib.sha256(leaf.public_bytes(c["serialization"].Encoding.DER)).hexdigest())

    # -- steps ----------------------------------------------------------------------------------------------------------
    @staticmethod
    def _parse(raw: object) -> dict:
        if not isinstance(raw, (bytes, bytearray)):
            raise Refusal(MALFORMED)
        if len(raw) > MAX_ENVELOPE_BYTES:
            raise Refusal(OVERSIZE)
        try:
            envelope = json.loads(bytes(raw).decode("ascii"))
        except (UnicodeError, ValueError):
            raise Refusal(MALFORMED) from None
        if not isinstance(envelope, dict) or set(envelope) != ENVELOPE_KEYS or envelope["v"] != ENVELOPE_VERSION:
            raise Refusal(MALFORMED)
        if type(envelope["v"]) is not int:
            raise Refusal(MALFORMED)
        if not isinstance(envelope["payload"], dict) or set(envelope["payload"]) != PAYLOAD_KEYS:
            raise Refusal(MALFORMED)
        if not isinstance(envelope["cert"], str) or not envelope["cert"]:
            raise Refusal(CERT_MISSING)
        if not isinstance(envelope["sig"], str) or not envelope["sig"]:
            raise Refusal(SIGNATURE_MISSING)
        return envelope

    def _verify_certificate(self, c, cert_b64: str, policy: SourcePolicy):
        try:
            der = base64.b64decode(cert_b64, validate=True)
            leaf = c["x509"].load_der_x509_certificate(der)
        except (binascii.Error, ValueError):
            raise Refusal(CERT_INVALID) from None
        if not any(self._issued_by(leaf, ca) for ca in self._cas):
            raise Refusal(CERT_UNTRUSTED)
        now = self._clock()
        if now < leaf.not_valid_before_utc.timestamp():
            raise Refusal(CERT_NOT_YET_VALID)
        if now > leaf.not_valid_after_utc.timestamp():
            raise Refusal(CERT_EXPIRED)
        try:
            basic = leaf.extensions.get_extension_for_class(c["x509"].BasicConstraints).value
            if basic.ca:
                raise Refusal(CERT_IS_CA)
        except c["x509"].ExtensionNotFound:
            pass
        try:
            usages = leaf.extensions.get_extension_for_class(c["x509"].ExtendedKeyUsage).value
        except c["x509"].ExtensionNotFound:
            raise Refusal(CERT_NOT_CLIENT_AUTH) from None
        if c["EKU"].CLIENT_AUTH not in usages:
            raise Refusal(CERT_NOT_CLIENT_AUTH)
        names = [attribute.value for attribute in leaf.subject.get_attributes_for_oid(c["NameOID"].COMMON_NAME)]
        if names != [policy.identity]:
            raise Refusal(CERT_IDENTITY_MISMATCH)
        if policy.pinned_sha256 and hashlib.sha256(der).hexdigest() not in policy.pinned_sha256:
            raise Refusal(CERT_NOT_PINNED)
        return leaf

    @staticmethod
    def _issued_by(leaf, ca) -> bool:
        try:
            leaf.verify_directly_issued_by(ca)
        except Exception:  # wrong issuer name, bad signature, unsupported algorithm: all "not issued by this CA"
            return False
        return True

    @staticmethod
    def _verify_signature(c, leaf, sig_b64: str, payload: dict) -> None:
        try:
            signature = base64.b64decode(sig_b64, validate=True)
        except (binascii.Error, ValueError):
            raise Refusal(SIGNATURE_MISSING) from None
        try:
            data = canonical(payload)
        except (TypeError, ValueError):
            raise Refusal(MALFORMED) from None
        key = leaf.public_key()
        try:
            if isinstance(key, c["ed25519"].Ed25519PublicKey):
                key.verify(signature, data)
            elif isinstance(key, c["ec"].EllipticCurvePublicKey) and key.curve.name in ("secp256r1", "secp384r1"):
                key.verify(signature, data, c["ec"].ECDSA(c["hashes"].SHA256()))
            elif isinstance(key, c["rsa"].RSAPublicKey) and key.key_size >= 2048:
                key.verify(
                    signature, data,
                    c["padding"].PSS(mgf=c["padding"].MGF1(c["hashes"].SHA256()), salt_length=32), c["hashes"].SHA256(),
                )
            else:
                raise Refusal(KEY_UNSUPPORTED)
        except c["InvalidSignature"]:
            raise Refusal(BAD_SIGNATURE) from None

    def _verify_payload(self, payload: dict) -> tuple[str, str, str, float]:
        kind = payload["kind"]
        if type(kind) is not str or kind not in REMOTE_KINDS:
            raise Refusal(BAD_KIND)  # includes any attempt at an "all clear": there is no such kind
        try:
            address = str(ip_containment.validate_block_target(payload["attacker_ip"], ()))
        except ip_containment.ContainmentRejected:
            raise Refusal(BAD_ADDRESS) from None
        detail = payload["detail"]
        if not isinstance(detail, str) or _DETAIL_RE.fullmatch(detail) is None:
            raise Refusal(BAD_DETAIL)
        if not isinstance(payload["nonce"], str) or _NONCE_RE.fullmatch(payload["nonce"]) is None:
            raise Refusal(MALFORMED)
        at = payload["at"]
        if isinstance(at, bool) or not isinstance(at, (int, float)) or not math.isfinite(at):
            raise Refusal(MALFORMED)
        skew = self._clock() - float(at)
        if skew > MAX_SKEW_SEC:
            raise Refusal(STALE)
        if skew < -MAX_SKEW_SEC:
            raise Refusal(FROM_THE_FUTURE)
        return kind, address, detail, float(at)

    def _remember(self, signature_b64: str) -> None:
        """Refuse a signature seen inside the replay window. Called only for an otherwise fully valid alert."""
        key = hashlib.sha256(signature_b64.encode("ascii")).hexdigest()
        now = self._clock()
        with self._lock:
            while self._seen:
                oldest_key, oldest_at = next(iter(self._seen.items()))
                if now - oldest_at > REPLAY_WINDOW_SEC or len(self._seen) >= REPLAY_MAX_ENTRIES:
                    self._seen.pop(oldest_key)
                else:
                    break
            if key in self._seen:
                raise Refusal(REPLAY)
            self._seen[key] = now


class TokenBucket:
    """Small thread-safe token bucket: ``capacity`` messages, refilled at ``per_second``."""

    def __init__(self, capacity: float, per_second: float, clock: Callable[[], float] = time.monotonic) -> None:
        self._capacity = float(capacity)
        self._rate = float(per_second)
        self._clock = clock
        self._tokens = float(capacity)
        self._last = clock()
        self._lock = threading.Lock()

    def take(self) -> bool:
        with self._lock:
            now = self._clock()
            self._tokens = min(self._capacity, self._tokens + (now - self._last) * self._rate)
            self._last = now
            if self._tokens >= 1.0:
                self._tokens -= 1.0
                return True
            return False
