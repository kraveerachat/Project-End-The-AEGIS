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
LOCAL_REQUEST_ORIGIN = "core-local-console"
CONFIRMATION = "RESTORE UPLINK"
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

_REQUEST_KEYS = frozenset({"v", "op", "origin", "secret", "confirmation", "reason"})
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


def restore_request(secret: str, confirmation: str, reason: str) -> dict[str, Any]:
    return {
        "v": 1,
        "op": RESTORE_UPLINK,
        "origin": LOCAL_REQUEST_ORIGIN,
        "secret": secret,
        "confirmation": confirmation,
        "reason": reason,
    }


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


def _response(ok: bool, code: str, detail: str, *, msg_id=None, seq=None, evidence=None):
    return {
        "v": 1,
        "ok": ok,
        "code": code,
        "detail": detail,
        "msg_id": msg_id,
        "seq": seq,
        "evidence": evidence or _evidence(),
    }


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
    ) -> None:
        self.supervisor = supervisor
        self.credential = credential
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
        context = self.supervisor.protocol
        row = context.store.command(msg_id) if context is not None else None
        if row is None or row["action"] != RESTORE_UPLINK:
            return self._refuse("UNKNOWN_COMMAND", "no local RESTORE command has that identifier", peer)
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
            physical = self.supervisor.awaiting_physical_confirmation
            observed = physical.get("observed_state") if physical and physical.get("nonce") == msg_id else None
            executed = {
                "NORMAL": "DEVICE_REPORTED_NORMAL",
                "LOCKDOWN": "DEVICE_REPORTED_LOCKDOWN",
            }.get(observed, "DEVICE_STATUS_CORRELATED")
        else:
            executed = "NOT_APPLICABLE" if published == "NOT_PUBLISHED" else "NOT_OBSERVED"
        ladder = _evidence(
            requested="ACCEPTED",
            published=published,
            ack=ack,
            executed=executed,
        )
        return _response(True, "EVIDENCE", "protocol evidence only; not physical evidence", msg_id=msg_id,
                         seq=row["seq"], evidence=ladder)

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
        with self.supervisor.command_guard():
            if self.supervisor.pending_command is not None:
                return self._refuse("COMMAND_PENDING", "another relay command is awaiting ACK", peer)
            if self.supervisor.status.uplink != "LOCKDOWN":
                return self._refuse("UPLINK_NOT_LOCKDOWN", "Core has not observed LOCKDOWN", peer)
            physical = self.supervisor.awaiting_physical_confirmation
            if physical and physical.get("action") == RESTORE_UPLINK and physical.get("acknowledged_at") is not None:
                return self._refuse("RESTORE_ALREADY_PENDING", "RESTORE is awaiting device status evidence", peer)

            reason = body["reason"].strip()
            audit_detail = f"reason={reason} uid={peer.uid} pid={peer.pid} origin={LOCAL_REQUEST_ORIGIN}"
            try:
                self.audit_strict("RESTORE_REQUESTED", audit_detail, db.CRITICAL)
            except Exception:
                return self._refuse("AUDIT_UNAVAILABLE", "durable RESTORE audit is unavailable", peer)

            result = self.supervisor.issue_command(
                RESTORE_UPLINK,
                f"authenticated local restore: {reason}; uid={peer.uid}; pid={peer.pid}",
                critical=True,
                origin=CONTROLLER_ORIGIN,
                authorize_restore=True,
            )
        if result.sent:
            ladder = _evidence(requested="ACCEPTED", published="PUBLISHED", ack="PENDING", executed="NOT_OBSERVED")
            return _response(True, "PUBLISHED", result.detail, msg_id=result.nonce, seq=result.seq, evidence=ladder)
        if result.dry_run:
            ladder = _evidence(requested="ACCEPTED", published="DRY_RUN")
            return _response(False, "DRY_RUN", result.detail, evidence=ladder)
        code = result.reason_code or "NOT_PUBLISHED"
        ladder = _evidence(requested="ACCEPTED", published="NOT_PUBLISHED")
        return _response(False, code, result.detail, evidence=ladder)


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
