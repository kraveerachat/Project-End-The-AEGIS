"""Core-local, authenticated and durably audited RESTORE authority.

The boundary is an AF_UNIX socket owned by the Core process account.  A request
is published exactly once only after peer, credential, confirmation, reason,
origin, runtime-state, and durable-audit gates all succeed.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import socket
import sqlite3
import stat
import struct
import threading
import time
import unicodedata
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from . import database as db
from .controller import RESTORE_UPLINK

CHANNEL_NAME = "local-restore.sock"
CONTROLLER_ORIGIN = "aegisctl-local"

# Production RESTORE policy basis. The D4 gate hands the supervisor exactly one approved basis, and only after the Recovery
# preconditions (one open incident, R1, live R3 for the same address, fresh R2) passed on one incident snapshot.
RESTORE_BASIS_R3_VERIFIED = "R3_VERIFIED"
PRODUCTION_RESTORE_BASES = frozenset({RESTORE_BASIS_R3_VERIFIED})
# OD-R5-BG-01: break-glass is an EMERGENCY OPERATIONAL RECOVERY path only. It is a second, distinct basis that only the
# break-glass branch of the D4 gate can mint, and only after a durable per-lockdown-episode claim exists. It never counts
# as R4, R5, R8, LVR or final Recovery acceptance.
BREAK_GLASS_RESULT = "OPERATIONAL_RECOVERY_ONLY"


@dataclass(frozen=True)
class BreakGlassBasis:
    """The break-glass RESTORE basis. The supervisor accepts it only for a real, spent, not-yet-dispatched claim."""

    claim_id: int
    episode_id: int

LOCAL_REQUEST_ORIGIN = "core-local-console"
CONFIRMATION = "RESTORE UPLINK"
BREAK_GLASS_CONFIRMATION = "BREAK GLASS RESTORE UPLINK"
REASON_MIN_CHARS = 12
REASON_MAX_CHARS = 240
REASON_MAX_BYTES = 960
MAX_MESSAGE_BYTES = 16_384
MAX_AUTH_FAILURES = 3
AUTH_LOCKOUT_SEC = 30.0
SCRYPT_MIN_N = 2**14
SCRYPT_MAX_N = 2**18
SCRYPT_R = 8
SCRYPT_P = 1
SECRET_MIN_CHARS = 16

_REQUEST_KEYS = frozenset(
    {"v", "op", "origin", "secret", "confirmation", "reason", "break_glass", "break_glass_confirmation"}
)
_EVIDENCE_KEYS = frozenset({"v", "op", "msg_id"})
_DANGEROUS_BIDI = frozenset({"RLO", "LRO", "RLE", "LRE", "PDF", "RLI", "LRI", "FSI", "PDI"})


class LocalRestoreError(RuntimeError):
    """The local RESTORE boundary cannot be used safely."""


class CredentialError(LocalRestoreError):
    """The configured operator credential is malformed or unsafe."""


class ChannelUnavailable(LocalRestoreError):
    """No Core-local RESTORE channel accepted the request."""


class OutcomeUnknown(LocalRestoreError):
    """The request may have arrived, but its response was lost."""


@dataclass(frozen=True)
class Peer:
    uid: int
    pid: int


@dataclass(frozen=True)
class RestoreCredential:
    n: int
    r: int
    p: int
    salt: bytes
    digest: bytes

    @classmethod
    def parse(cls, text: str) -> RestoreCredential:
        try:
            algorithm, n_text, r_text, p_text, salt_hex, digest_hex = text.strip().split("$")
            n, r, p = int(n_text), int(r_text), int(p_text)
            salt, digest = bytes.fromhex(salt_hex), bytes.fromhex(digest_hex)
        except (AttributeError, TypeError, ValueError) as error:
            raise CredentialError("invalid RESTORE credential format") from error
        if (
            algorithm != "scrypt"
            or not (SCRYPT_MIN_N <= n <= SCRYPT_MAX_N)
            or n & (n - 1)
            or r != SCRYPT_R
            or p != SCRYPT_P
            or len(salt) < 16
            or len(digest) != 32
        ):
            raise CredentialError("unsafe RESTORE credential parameters")
        return cls(n, r, p, salt, digest)

    @classmethod
    def load(cls, path: Path | str) -> RestoreCredential:
        target = Path(path)
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
        try:
            descriptor = os.open(target, flags)
        except OSError as error:
            raise CredentialError("RESTORE credential cannot be opened safely") from error
        try:
            metadata = os.fstat(descriptor)
            if not stat.S_ISREG(metadata.st_mode) or stat.S_IMODE(metadata.st_mode) != 0o600:
                raise CredentialError("RESTORE credential must be a regular mode-0600 file")
            if hasattr(os, "geteuid") and metadata.st_uid != os.geteuid():
                raise CredentialError("RESTORE credential must be owned by the Core account")
            with os.fdopen(descriptor, "r", encoding="ascii", closefd=False) as stream:
                text = stream.read(4097)
            if len(text) > 4096:
                raise CredentialError("RESTORE credential file is too large")
            return cls.parse(text)
        except (OSError, UnicodeError) as error:
            raise CredentialError("RESTORE credential cannot be read safely") from error
        finally:
            os.close(descriptor)

    def verify(self, secret: str) -> bool:
        if not isinstance(secret, str) or not secret:
            return False
        try:
            candidate = hashlib.scrypt(
                secret.encode("utf-8"), salt=self.salt, n=self.n, r=self.r, p=self.p, dklen=len(self.digest)
            )
        except (UnicodeError, ValueError):
            return False
        return hmac.compare_digest(candidate, self.digest)


def hash_secret(secret: str, *, n: int = SCRYPT_MIN_N) -> str:
    if not isinstance(secret, str) or len(secret) < SECRET_MIN_CHARS:
        raise ValueError(f"RESTORE secret must contain at least {SECRET_MIN_CHARS} characters")
    if not (SCRYPT_MIN_N <= n <= SCRYPT_MAX_N) or n & (n - 1):
        raise ValueError("unsafe scrypt work factor")
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(secret.encode("utf-8"), salt=salt, n=n, r=SCRYPT_R, p=SCRYPT_P, dklen=32)
    return f"scrypt${n}${SCRYPT_R}${SCRYPT_P}${salt.hex()}${digest.hex()}"


def write_credential(path: Path | str, secret: str) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        data = (hash_secret(secret) + "\n").encode("ascii")
        offset = 0
        while offset < len(data):
            written = os.write(descriptor, data[offset:])
            if written <= 0:
                raise OSError("credential write made no progress")
            offset += written
        os.fsync(descriptor)
    except BaseException:
        try:
            target.unlink()
        except OSError:
            pass
        raise
    finally:
        os.close(descriptor)
    directory_flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
    directory = os.open(target.parent, directory_flags)
    try:
        os.fsync(directory)
    except BaseException:
        try:
            target.unlink()
        except OSError:
            pass
        raise
    finally:
        os.close(directory)


def local_restore_supported(platform: str | None = None) -> bool:
    selected = os.name if platform is None else platform
    return selected == "posix" and hasattr(socket, "AF_UNIX") and hasattr(socket, "SO_PEERCRED")


def reason_problem(reason: Any) -> str | None:
    if not isinstance(reason, str) or not reason.strip():
        return "REASON_REQUIRED"
    normalized = reason.strip()
    if not (REASON_MIN_CHARS <= len(normalized) <= REASON_MAX_CHARS):
        return "REASON_INVALID"
    if not normalized.isprintable():
        return "REASON_INVALID"
    if any(
        unicodedata.category(char) in {"Cf", "Cs"} or unicodedata.bidirectional(char) in _DANGEROUS_BIDI
        for char in normalized
    ):
        return "REASON_INVALID"
    try:
        encoded = normalized.encode("utf-8")
    except UnicodeError:
        return "REASON_INVALID"
    if len(encoded) > REASON_MAX_BYTES:
        return "REASON_INVALID"
    return None


def restore_request(
    secret: str, confirmation: str, reason: str, *, break_glass_confirmation: str | None = None
) -> dict[str, Any]:
    body = {
        "v": 1,
        "op": RESTORE_UPLINK,
        "origin": LOCAL_REQUEST_ORIGIN,
        "secret": secret,
        "confirmation": confirmation,
        "reason": reason,
    }
    if break_glass_confirmation is not None:
        body["break_glass"] = True
        body["break_glass_confirmation"] = break_glass_confirmation
    return body


def evidence_request(msg_id: str) -> dict[str, Any]:
    return {"v": 1, "op": "RESTORE_EVIDENCE", "msg_id": msg_id}


def _evidence(*, requested="REFUSED", published="NOT_PUBLISHED", ack="NOT_APPLICABLE", executed="NOT_APPLICABLE"):
    return {
        "requested": requested,
        "published": published,
        "ack": ack,
        "executed": executed,
        "relay_confirmation": "NOT_AVAILABLE",
        "physical_evidence": "NOT_PROVEN",
    }


def _response(ok: bool, code: str, detail: str, *, msg_id=None, seq=None, evidence=None, break_glass=False):
    response = {
        "v": 1,
        "ok": ok,
        "code": code,
        "detail": detail,
        "msg_id": msg_id,
        "seq": seq,
        "evidence": evidence or _evidence(),
    }
    if break_glass:
        response["break_glass"] = BREAK_GLASS_RESULT
    return response


def restore_evidence_ladder(supervisor, msg_id: str, *, action: str = RESTORE_UPLINK):
    """The protocol-evidence ladder for one local RESTORE command, or None when no such command exists.

    Shared by the D4 evidence operation and the Core Recovery observer so both report exactly the same
    reviewed semantics. ``executed == DEVICE_REPORTED_NORMAL`` needs the supervisor's in-memory physical
    correlation for this exact command; after a Core restart it degrades to ``DEVICE_STATUS_CORRELATED``.
    """
    context = supervisor.protocol
    row = context.store.command(msg_id) if context is not None else None
    if row is None or row["action"] != action:
        return None
    state = row["state"]
    if state == "NOT_PUBLISHED":
        published = "NOT_PUBLISHED"
    elif row["published_at"] is not None or state in {"PUBLISHED", "ACK_CONSUMED"}:
        published = "PUBLISHED"
    else:
        published = "OUTCOME_UNKNOWN"
    if row["ack_result"]:
        ack = row["ack_result"]
    elif published == "PUBLISHED" and state != "CLOSED":
        ack = "PENDING"
    elif published == "OUTCOME_UNKNOWN" or state == "CLOSED":
        ack = "OUTCOME_UNKNOWN"
    else:
        ack = "NOT_APPLICABLE"
    if row["status_correlated"]:
        physical = supervisor.awaiting_physical_confirmation
        observed = physical.get("observed_state") if physical and physical.get("nonce") == msg_id else None
        executed = {
            "NORMAL": "DEVICE_REPORTED_NORMAL",
            "LOCKDOWN": "DEVICE_REPORTED_LOCKDOWN",
        }.get(observed, "DEVICE_STATUS_CORRELATED")
    else:
        executed = "NOT_APPLICABLE" if published == "NOT_PUBLISHED" else "NOT_OBSERVED"
    ladder = _evidence(requested="ACCEPTED", published=published, ack=ack, executed=executed)
    return row["seq"], ladder


def _incident_key(incident: dict | None):
    return (incident.get("id"), incident.get("attacker_ip"), incident.get("state")) if incident else None


class LocalRestoreGate:
    def __init__(
        self,
        supervisor,
        credential: RestoreCredential,
        *,
        allowed_uid: int,
        audit: Callable[..., None] | None = None,
        audit_strict: Callable[..., None] | None = None,
        monotonic: Callable[[], float] = time.monotonic,
        incident_lookup: Callable[[], dict | None] | None = None,
        attempt_lookup: Callable[[Any], bool] | None = None,
        precondition_lookup: Callable[[dict | None], str | None] | None = None,
        break_glass_lookup: Callable[[dict | None], tuple[str | None, str, str]] | None = None,
        episode_lookup: Callable[[], int | None] | None = None,
    ) -> None:
        self.supervisor = supervisor
        self.credential = credential
        # Core Recovery binding: when an incident is open, a RESTORE attempt is bound to it and a durable
        # RESTORE_REQUESTED row for that incident permanently consumes the attempt.
        self.incident_lookup = incident_lookup
        self.attempt_lookup = attempt_lookup
        # The production supervisor wires the Recovery policy here. Called with ONE incident snapshot after credential +
        # confirmation + reason + origin, a spent-attempt check and before the command guard (it may probe the network);
        # returns None when the preconditions hold, otherwise a short reason. A refusal never consumes the one-shot.
        # Unwired (None) only in lab/test gates, where the production chokepoint in the supervisor does not apply.
        self.precondition_lookup = precondition_lookup
        # OD-R5-BG-01 break-glass wiring (production supervisor only). ``break_glass_lookup`` evaluates the approved cases on one
        # incident snapshot (and the fresh R2 probe); ``episode_lookup`` returns the open durable lockdown episode ONLY while
        # the current Core process holds a fresh authenticated LOCKDOWN observation for it (None otherwise, e.g. after a restart).
        self.break_glass_lookup = break_glass_lookup
        self.episode_lookup = episode_lookup
        self.claim_recorder = db.claim_break_glass
        self.claim_lookup = db.break_glass_claim_for_episode
        self.allowed_uid = int(allowed_uid)
        self.audit = audit or db.log_event
        self.audit_strict = audit_strict or db.log_event_strict
        self.monotonic = monotonic
        self._auth_failures: dict[int, tuple[int, float]] = {}
        self._operation_lock = threading.RLock()
        self._enabled = True

    def disable(self) -> None:
        """Block new gate operations and wait for an in-flight operation."""
        with self._operation_lock:
            self._enabled = False

    def _refuse(self, code: str, detail: str, peer: Peer):
        safe = f"code={code} uid={peer.uid} pid={peer.pid} detail={detail}"
        self.audit("RESTORE_REFUSED", safe, db.WARN)
        return _response(False, code, detail)

    def _peer_ok(self, peer: Peer):
        if peer.uid != self.allowed_uid:
            return self._refuse("PEER_REFUSED", "request is not from the Core account", peer)
        return None

    def _evidence_for(self, body: Any, peer: Peer):
        if not isinstance(body, dict) or set(body) != _EVIDENCE_KEYS or body.get("v") != 1:
            return self._refuse("MALFORMED_REQUEST", "invalid evidence request", peer)
        msg_id = body.get("msg_id")
        if not isinstance(msg_id, str) or len(msg_id) != 32:
            return self._refuse("MALFORMED_REQUEST", "invalid command identifier", peer)
        try:
            int(msg_id, 16)
        except ValueError:
            return self._refuse("MALFORMED_REQUEST", "invalid command identifier", peer)
        found = restore_evidence_ladder(self.supervisor, msg_id)
        if found is None:
            return self._refuse("UNKNOWN_COMMAND", "no local RESTORE command has that identifier", peer)
        seq, ladder = found
        return _response(True, "EVIDENCE", "protocol evidence only; not physical evidence", msg_id=msg_id,
                         seq=seq, evidence=ladder)

    def handle(self, body: Any, peer: Peer):
        with self._operation_lock:
            if not self._enabled:
                return self._refuse("CHANNEL_CLOSING", "the local RESTORE channel is closing", peer)
            return self._handle(body, peer)

    def _handle(self, body: Any, peer: Peer):
        refused = self._peer_ok(peer)
        if refused:
            return refused
        if isinstance(body, dict) and body.get("op") == "RESTORE_EVIDENCE":
            return self._evidence_for(body, peer)
        if (
            not isinstance(body, dict)
            or not set(body).issubset(_REQUEST_KEYS)
            or body.get("v") != 1
            or body.get("op") != RESTORE_UPLINK
            or any(key not in _REQUEST_KEYS for key in body)
        ):
            return self._refuse("MALFORMED_REQUEST", "invalid RESTORE request", peer)
        if "break_glass" in body and not isinstance(body["break_glass"], bool):
            return self._refuse("MALFORMED_REQUEST", "invalid RESTORE request", peer)

        failures, locked_until = self._auth_failures.get(peer.uid, (0, 0.0))
        now = self.monotonic()
        if now < locked_until:
            return self._refuse("AUTH_LOCKED_OUT", "authentication is temporarily locked", peer)
        if locked_until and now >= locked_until:
            failures = 0
            self._auth_failures.pop(peer.uid, None)

        secret = body.get("secret")
        if not isinstance(secret, str) or not secret:
            return self._refuse("AUTH_REQUIRED", "operator authentication is required", peer)
        if not self.credential.verify(secret):
            failures += 1
            lock = now + AUTH_LOCKOUT_SEC if failures >= MAX_AUTH_FAILURES else 0.0
            self._auth_failures[peer.uid] = (failures, lock)
            if lock:
                self.audit("RESTORE_AUTH_LOCKOUT", f"uid={peer.uid} pid={peer.pid}", db.WARN)
            return self._refuse("AUTH_FAILED", "operator authentication failed", peer)
        self._auth_failures.pop(peer.uid, None)

        confirmation = body.get("confirmation")
        if not isinstance(confirmation, str) or not confirmation:
            return self._refuse("CONFIRMATION_REQUIRED", "typed confirmation is required", peer)
        if confirmation != CONFIRMATION:
            return self._refuse("CONFIRMATION_MISMATCH", "typed confirmation did not match", peer)
        problem = reason_problem(body.get("reason"))
        if problem:
            return self._refuse(problem, "a bounded, printable operator reason is required", peer)
        if body.get("origin") != LOCAL_REQUEST_ORIGIN:
            return self._refuse("ORIGIN_REFUSED", "request origin is not the approved local console", peer)
        if body.get("break_glass") is True:
            return self._handle_break_glass(body, peer)
        if "break_glass_confirmation" in body:
            return self._refuse("BREAK_GLASS_FLAG_REQUIRED", "a break-glass confirmation needs break_glass=true", peer)
        # ONE incident snapshot: evaluated here, compared again under the guard, and the only incident the audit row binds.
        snapshot = None
        if self.incident_lookup is not None:
            try:
                snapshot = self.incident_lookup()
            except Exception:
                return self._refuse("AUDIT_UNAVAILABLE", "the incident record is unavailable", peer)
        incident_id = snapshot["id"] if snapshot else None
        if incident_id is not None and self.attempt_lookup is not None:
            try:
                spent = self.attempt_lookup(incident_id)
            except Exception:
                return self._refuse("AUDIT_UNAVAILABLE", "the incident attempt record is unavailable", peer)
            if spent:
                return self._refuse(
                    "RESTORE_ATTEMPT_CONSUMED",
                    "a RESTORE attempt for this incident already exists; it is never repeated automatically",
                    peer,
                )
        basis = None
        if self.precondition_lookup is not None:
            try:
                unmet = self.precondition_lookup(snapshot)
            except Exception:
                unmet = "precondition check failed"
            if unmet:
                return self._refuse("RECOVERY_PRECONDITION_UNMET", str(unmet)[:120], peer)
            if incident_id is None:
                # Defense in depth: even a policy that wrongly passes can never publish a production RESTORE whose durable
                # RESTORE_REQUESTED row would carry a NULL incident_id (the one-shot index does not cover NULL).
                return self._refuse("RECOVERY_PRECONDITION_UNMET", "a production RESTORE needs a Core-bound incident", peer)
            basis = RESTORE_BASIS_R3_VERIFIED
        elif getattr(getattr(self.supervisor, "settings", None), "profile", None) == "production":
            # A production gate without the Recovery policy would be refused by the supervisor chokepoint only AFTER the
            # durable one-shot row was written; refuse here so a miswired gate can never spend an attempt.
            return self._refuse("RECOVERY_PRECONDITION_UNMET", "the production RESTORE policy is not wired", peer)
        with self.supervisor.command_guard():
            if self.supervisor.pending_command is not None:
                return self._refuse("COMMAND_PENDING", "another relay command is awaiting ACK", peer)
            if self.supervisor.status.uplink != "LOCKDOWN":
                return self._refuse("UPLINK_NOT_LOCKDOWN", "Core has not observed LOCKDOWN", peer)
            physical = self.supervisor.awaiting_physical_confirmation
            if physical and physical.get("action") == RESTORE_UPLINK and physical.get("acknowledged_at") is not None:
                return self._refuse("RESTORE_ALREADY_PENDING", "RESTORE is awaiting device status evidence", peer)

            reason = body["reason"].strip()
            if self.incident_lookup is not None:
                try:
                    current = self.incident_lookup()
                    if _incident_key(current) != _incident_key(snapshot):
                        return self._refuse(
                            "INCIDENT_CHANGED", "the open incident changed while RESTORE was being checked; nothing was sent", peer,
                        )
                    if incident_id is not None and self.attempt_lookup is not None and self.attempt_lookup(incident_id):
                        return self._refuse(
                            "RESTORE_ATTEMPT_CONSUMED",
                            "a RESTORE attempt for this incident already exists; it is never repeated automatically",
                            peer,
                        )
                except Exception:
                    return self._refuse("AUDIT_UNAVAILABLE", "the incident attempt record is unavailable", peer)
            audit_detail = f"reason={reason} uid={peer.uid} pid={peer.pid} origin={LOCAL_REQUEST_ORIGIN}"
            if incident_id is not None:
                audit_detail += f" incident_id={incident_id}"
            try:
                if incident_id is not None:
                    self.audit_strict("RESTORE_REQUESTED", audit_detail, db.CRITICAL, incident_id)
                else:
                    self.audit_strict("RESTORE_REQUESTED", audit_detail, db.CRITICAL)
            except sqlite3.IntegrityError:
                # The database-level one-shot (one RESTORE_REQUESTED per incident) fired: another attempt won the race.
                return self._refuse(
                    "RESTORE_ATTEMPT_CONSUMED",
                    "a RESTORE attempt for this incident already exists; it is never repeated automatically",
                    peer,
                )
            except Exception:
                return self._refuse("AUDIT_UNAVAILABLE", "durable RESTORE audit is unavailable", peer)

            result = self.supervisor.issue_command(
                RESTORE_UPLINK,
                f"authenticated local restore: {reason}; uid={peer.uid}; pid={peer.pid}",
                critical=True,
                origin=CONTROLLER_ORIGIN,
                authorize_restore=True,
                restore_basis=basis,
            )
        if result.sent:
            if incident_id is not None:
                try:  # best effort: links the command to the incident for the Recovery observer; absence fails R5 closed
                    self.audit("RESTORE_PUBLISHED", f"msg_id={result.nonce} seq={result.seq}", db.CRITICAL, incident_id)
                except Exception:
                    pass
            ladder = _evidence(requested="ACCEPTED", published="PUBLISHED", ack="PENDING", executed="NOT_OBSERVED")
            return _response(True, "PUBLISHED", result.detail, msg_id=result.nonce, seq=result.seq, evidence=ladder)
        if result.dry_run:
            ladder = _evidence(requested="ACCEPTED", published="DRY_RUN")
            return _response(False, "DRY_RUN", result.detail, evidence=ladder)
        code = result.reason_code or "NOT_PUBLISHED"
        ladder = _evidence(requested="ACCEPTED", published="NOT_PUBLISHED")
        return _response(False, code, result.detail, evidence=ladder)


    def _handle_break_glass(self, body: dict, peer: Peer):
        """OD-R5-BG-01. Runs only after peer, D4 credential, RESTORE UPLINK, reason and origin were verified.

        Order before any publication: second confirmation, authenticated current-process LOCKDOWN episode, normal path
        unavailable plus approved case plus fresh R2, then the durable one-per-episode claim. Only then may the command
        proceed. A refusal before the claim leaves every durable and command-store record untouched.
        """
        if self.break_glass_lookup is None or self.episode_lookup is None or self.incident_lookup is None:
            return self._refuse("BREAK_GLASS_UNAVAILABLE", "break-glass is not available on this Core", peer)
        second = body.get("break_glass_confirmation")
        if not isinstance(second, str) or not second:
            return self._refuse("BREAK_GLASS_CONFIRMATION_REQUIRED", "the second typed confirmation is required", peer)
        if second != BREAK_GLASS_CONFIRMATION:
            return self._refuse("BREAK_GLASS_CONFIRMATION_MISMATCH", "the second typed confirmation did not match", peer)
        try:
            snapshot = self.incident_lookup()
            episode_id = self.episode_lookup()
        except Exception:
            return self._refuse("AUDIT_UNAVAILABLE", "the incident or lockdown record is unavailable", peer)
        if episode_id is None:
            return self._refuse(
                "BREAK_GLASS_LOCKDOWN_UNPROVEN",
                "no authenticated LOCKDOWN was observed by this Core process for an open lockdown episode",
                peer,
            )
        try:
            spent = self.claim_lookup(episode_id) is not None
        except Exception:
            return self._refuse("AUDIT_UNAVAILABLE", "the break-glass claim record is unavailable", peer)
        if spent:
            return self._refuse("BREAK_GLASS_EPISODE_SPENT", "this lockdown episode already has its one break-glass claim", peer)
        try:
            code, unmet_detail, case = self.break_glass_lookup(snapshot)
        except Exception:
            code, unmet_detail, case = "BREAK_GLASS_PRECONDITION_UNMET", "break-glass eligibility check failed", ""
        if code:
            return self._refuse(code, str(unmet_detail)[:120], peer)
        incident_id = snapshot["id"] if snapshot else None
        with self.supervisor.command_guard():
            if self.supervisor.pending_command is not None:
                return self._refuse("COMMAND_PENDING", "another relay command is awaiting ACK", peer)
            if self.supervisor.status.uplink != "LOCKDOWN":
                return self._refuse("UPLINK_NOT_LOCKDOWN", "Core has not observed LOCKDOWN", peer)
            physical = self.supervisor.awaiting_physical_confirmation
            if physical and physical.get("action") == RESTORE_UPLINK and physical.get("acknowledged_at") is not None:
                return self._refuse("RESTORE_ALREADY_PENDING", "RESTORE is awaiting device status evidence", peer)
            try:
                if _incident_key(self.incident_lookup()) != _incident_key(snapshot) or self.episode_lookup() != episode_id:
                    return self._refuse(
                        "INCIDENT_CHANGED", "the incident or lockdown episode changed while break-glass was being checked; nothing was sent", peer,
                    )
            except Exception:
                return self._refuse("AUDIT_UNAVAILABLE", "the incident or lockdown record is unavailable", peer)
            reason = body["reason"].strip()
            detail = f"reason={reason} uid={peer.uid} pid={peer.pid} origin={LOCAL_REQUEST_ORIGIN} outcome={BREAK_GLASS_RESULT}"
            try:
                claim_id = self.claim_recorder(episode_id, case, incident_id, reason, detail)
            except sqlite3.IntegrityError:
                return self._refuse("BREAK_GLASS_EPISODE_SPENT", "this lockdown episode already has its one break-glass claim", peer)
            except Exception:
                return self._refuse("AUDIT_UNAVAILABLE", "the durable break-glass claim could not be recorded; nothing was sent", peer)
            result = self.supervisor.issue_command(
                RESTORE_UPLINK,
                f"break-glass local restore: {reason}; uid={peer.uid}; pid={peer.pid}",
                critical=True,
                origin=CONTROLLER_ORIGIN,
                authorize_restore=True,
                restore_basis=BreakGlassBasis(claim_id, episode_id),
            )
        if result.sent:
            try:  # best effort and incident-free: never linked as R5 publication evidence
                self.audit(
                    "RESTORE_BREAK_GLASS_PUBLISHED", f"claim_id={claim_id} episode_id={episode_id} msg_id={result.nonce} seq={result.seq}", db.CRITICAL,
                )
            except Exception:
                pass
            ladder = _evidence(requested="ACCEPTED", published="PUBLISHED", ack="PENDING", executed="NOT_OBSERVED")
            return _response(True, "PUBLISHED", result.detail, msg_id=result.nonce, seq=result.seq, evidence=ladder, break_glass=True)
        if result.dry_run:
            return _response(False, "DRY_RUN", result.detail, evidence=_evidence(requested="ACCEPTED", published="DRY_RUN"), break_glass=True)
        ladder = _evidence(requested="ACCEPTED", published="NOT_PUBLISHED")
        return _response(False, result.reason_code or "NOT_PUBLISHED", result.detail, evidence=ladder, break_glass=True)


def _peer_from(connection: socket.socket) -> Peer:
    raw = connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i"))
    pid, uid, _gid = struct.unpack("3i", raw)
    return Peer(uid=uid, pid=pid)


class LocalRestoreServer:
    family = socket.AF_UNIX

    def __init__(self, path: Path | str, gate: LocalRestoreGate) -> None:
        self.path = Path(path)
        self.gate = gate
        self._listener: socket.socket | None = None
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._connections: set[socket.socket] = set()
        self._connections_lock = threading.Lock()

    def _prepare_path(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        parent = self.path.parent.lstat()
        if (
            not stat.S_ISDIR(parent.st_mode)
            or parent.st_uid != os.geteuid()
            or stat.S_IMODE(parent.st_mode) & 0o022
        ):
            raise LocalRestoreError(
                "local RESTORE runtime directory must be Core-owned and not group/world writable"
            )
        try:
            metadata = self.path.lstat()
        except FileNotFoundError:
            return
        if not stat.S_ISSOCK(metadata.st_mode):
            raise LocalRestoreError("refusing to replace a non-socket local RESTORE path")
        probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            probe.settimeout(0.1)
            probe.connect(str(self.path))
        except OSError:
            self.path.unlink()
        else:
            raise LocalRestoreError("a local RESTORE server is already listening")
        finally:
            probe.close()

    def start(self) -> None:
        if self._listener is not None:
            return
        self._prepare_path()
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            listener.bind(str(self.path))
            os.chmod(self.path, 0o600)
            listener.listen(8)
            listener.settimeout(0.2)
        except BaseException:
            listener.close()
            raise
        self._listener = listener
        self._stop.clear()
        self._thread = threading.Thread(target=self._serve, name="aegis-local-restore", daemon=True)
        self._thread.start()

    def _serve(self) -> None:
        assert self._listener is not None
        while not self._stop.is_set():
            try:
                connection, _ = self._listener.accept()
            except TimeoutError:
                continue
            except OSError:
                break
            with self._connections_lock:
                self._connections.add(connection)
            try:
                with connection:
                    connection.settimeout(5)
                    try:
                        response = self._read_and_handle(connection)
                    except Exception:
                        response = _response(
                            False,
                            "OUTCOME_UNKNOWN",
                            "local RESTORE result was lost; do not retry automatically",
                            evidence=_evidence(
                                requested="ACCEPTED",
                                published="OUTCOME_UNKNOWN",
                                ack="OUTCOME_UNKNOWN",
                                executed="OUTCOME_UNKNOWN",
                            ),
                        )
                    try:
                        connection.sendall(json.dumps(response, ensure_ascii=False).encode("utf-8") + b"\n")
                    except OSError:
                        pass
            finally:
                with self._connections_lock:
                    self._connections.discard(connection)

    def _read_and_handle(self, connection: socket.socket):
        data = bytearray()
        try:
            while len(data) <= MAX_MESSAGE_BYTES:
                chunk = connection.recv(min(4096, MAX_MESSAGE_BYTES + 1 - len(data)))
                if not chunk:
                    break
                data.extend(chunk)
                if b"\n" in chunk:
                    break
            if len(data) > MAX_MESSAGE_BYTES:
                raise ValueError("message too large")
            line = bytes(data).split(b"\n", 1)[0]
            body = json.loads(line.decode("utf-8"))
            peer = _peer_from(connection)
        except (OSError, UnicodeError, ValueError, json.JSONDecodeError):
            peer = Peer(uid=-1, pid=-1)
            try:
                peer = _peer_from(connection)
            except OSError:
                pass
            return self.gate._refuse("MALFORMED_REQUEST", "invalid local channel message", peer)
        return self.gate.handle(body, peer)

    def close(self) -> None:
        self.gate.disable()
        self._stop.set()
        listener, self._listener = self._listener, None
        if listener is not None:
            listener.close()
        with self._connections_lock:
            connections = tuple(self._connections)
        for connection in connections:
            try:
                connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        if self._thread is not None:
            self._thread.join()
            self._thread = None
        try:
            if stat.S_ISSOCK(self.path.lstat().st_mode):
                self.path.unlink()
        except FileNotFoundError:
            pass


def send_request(path: Path | str, body: dict[str, Any], *, timeout: float | None = None):
    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    client.settimeout(5 if timeout is None else timeout)
    connected = False
    try:
        client.connect(str(path))
        connected = True
        server = _peer_from(client)
        if server.uid != os.geteuid():
            raise ChannelUnavailable("local RESTORE server is not owned by the Core account")
        client.sendall(json.dumps(body, ensure_ascii=False).encode("utf-8") + b"\n")
        reply = client.makefile("rb").readline(MAX_MESSAGE_BYTES + 1)
        if not reply or len(reply) > MAX_MESSAGE_BYTES:
            raise OutcomeUnknown("the Core accepted the connection but returned no bounded result")
        try:
            response = json.loads(reply.decode("utf-8"))
        except (UnicodeError, json.JSONDecodeError) as error:
            raise OutcomeUnknown("the Core returned an invalid result") from error
        if not isinstance(response, dict):
            raise OutcomeUnknown("the Core returned an invalid result")
        return response
    except OutcomeUnknown:
        raise
    except OSError as error:
        if connected:
            raise OutcomeUnknown("the local result was lost; do not retry automatically") from error
        raise ChannelUnavailable("the Core-local RESTORE channel is unavailable") from error
    finally:
        client.close()
