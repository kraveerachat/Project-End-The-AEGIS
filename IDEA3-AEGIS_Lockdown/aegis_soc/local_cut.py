"""Core-local manual CUT request channel for the Python Desktop operator.

Authority model (no new trust is invented here):
  * The Core (``aegis-idea3``, ``RuntimeDirectoryMode=0700``) cannot be reached by a Desktop account through its own runtime
    directory, and the Desktop never runs as the Core or as root. The channel therefore lives on a DEDICATED, pre-provisioned
    socket path, exactly like Recovery: the directory is Core-owned and not group/world writable, the socket is
    ``aegis-idea3:<socket gid> 0660`` (filesystem reachability only), and the first gate is the SO_PEERCRED uid check against ONE
    configured operator uid, made immediately after ``accept`` and BEFORE any request byte is read. The client in turn refuses a
    server that is not the Core account.
  * The operator uid alone is NOT authority. Every CUT needs a human-supplied secret that the CORE verifies against its own
    protected CUT credential (scrypt, constant-time compare, bounded attempts then lockout). The credential is a separate
    policy domain from D4 RESTORE: a distinct file, a domain-separated hash input, and a refusal to start if it equals the
    RESTORE credential. A GUI login, a GUI PIN, the typed confirmation and the origin string are NOT authentication.
    Residual threat: code already running as the operator uid can still lock the operator out (bounded) or try guesses at the
    lockout rate, and can capture a secret typed into a compromised session. Use a long secret and a dedicated operator account.
  * The channel is INERT unless ``AEGIS_LOCAL_CUT_ENABLED`` is exactly ``YES`` AND an absolute socket path, an operator uid and
    the CUT credential file are configured. Provisioning the directory/group/credential is a separate reviewed deployment
    contract that is NOT part of this change.
  * It carries CUT only. It can never authorize RESTORE; RESTORE keeps the D4 gate.
  * An accepted request is dispatched ONLY through ``Supervisor.issue_command``. The pending/containment checks, the strict
    durable pre-dispatch audit (``pre_publish``) and the publish all happen inside the supervisor's single command lock, so a
    refused request writes no pre-dispatch row and a dispatched CUT always has one. This module never publishes anything itself.

NOT DONE (I4, documentation only; nothing here activates the legacy GUI path). The minimum Desktop adapter work still needed before
Live CUT may be enabled, none of which is implemented or tested yet:
  * No second MQTT client: the supervisor-managed GUI (``server_admin.py`` -> ``aegis_soc.gui.main``) still builds its own
    ``MQTTManager`` and ``AegisCommandController``. A Desktop launcher must use ``LocalCutController`` and no MQTT at all.
  * A fresh, Core-verified secret prompt per CUT passed through ``secret_provider`` (the GUI PIN/CONFIRM dialogs are intent
    evidence only, never authentication).
  * Honest result/error reporting: ``gui.send_command`` currently shows "MQTT not connected" for every non-sent result; it must
    distinguish AUTH_REQUIRED/AUTH_FAILED/AUTH_LOCKED_OUT, AUDIT_UNAVAILABLE, COMMAND_PENDING, CUT_QUEUED (ok but not yet sent,
    no id), CHANNEL_UNAVAILABLE and OUTCOME_UNKNOWN (never retried automatically).
  * ``CUT_EVIDENCE`` polling, because ``on_ack``/``on_status`` are MQTT-callback driven and never fire without MQTT.
  * ACK/STATUS lifecycle states PENDING / ACCEPTED / REJECTED / DEVICE_REPORTED_LOCKDOWN and OUTCOME_UNKNOWN, with physical
    evidence always shown as NOT_PROVEN.
  * RESTORE stays disabled in the Desktop; it keeps the D4 gate.
"""

from __future__ import annotations

import json
import os
import socket
import stat
import threading
import time
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any

from . import database as db
from . import local_restore as lr
from . import recovery_client
from .controller import CUT_UPLINK, RESTORE_UPLINK, CommandResult

CUT_ORIGIN = "core-local-cut"
CONFIRMATION = "CUT UPLINK"
ENABLED_VALUE = "YES"
EVIDENCE_OP = "CUT_EVIDENCE"
SOCKET_GROUP_MODE = 0o660
# Domain separation: the credential file stores scrypt(DOMAIN + secret), so a D4 RESTORE credential can never verify here.
CREDENTIAL_DOMAIN = "aegis-idea3-local-cut-credential-v1\x00"
SECRET_MAX_CHARS = 256
READ_DEADLINE_SEC = 3.0
MAX_HANDLERS = 4
REFUSAL_AUDIT_INTERVAL_SEC = 10.0
_REQUEST_KEYS = frozenset({"v", "op", "origin", "confirmation", "reason", "secret"})
_EVIDENCE_KEYS = frozenset({"v", "op", "msg_id"})


def enabled(value: str | None) -> bool:
    return value == ENABLED_VALUE


def domain_secret(secret: str) -> str:
    return CREDENTIAL_DOMAIN + secret


def hash_cut_secret(secret: str, *, n: int = lr.SCRYPT_MIN_N) -> str:
    if not isinstance(secret, str) or len(secret) < lr.SECRET_MIN_CHARS:
        raise ValueError(f"CUT secret must contain at least {lr.SECRET_MIN_CHARS} characters")
    return lr.hash_secret(domain_secret(secret), n=n)


def write_cut_credential(path: Path | str, secret: str) -> None:
    """Provision the CUT credential file (mode 0600, exclusive create). Owner-run; never called by the Core."""
    if not isinstance(secret, str) or len(secret) < lr.SECRET_MIN_CHARS:
        raise ValueError(f"CUT secret must contain at least {lr.SECRET_MIN_CHARS} characters")
    lr.write_credential(path, domain_secret(secret))


def credentials_are_distinct(cut: lr.RestoreCredential, restore: lr.RestoreCredential | None) -> bool:
    return restore is None or (cut.salt, cut.digest) != (restore.salt, restore.digest)


def cut_request(reason: str, secret: str, confirmation: str = CONFIRMATION) -> dict[str, Any]:
    return {
        "v": 1, "op": CUT_UPLINK, "origin": CUT_ORIGIN, "confirmation": confirmation, "reason": reason, "secret": secret,
    }


def evidence_request(msg_id: str) -> dict[str, Any]:
    return {"v": 1, "op": EVIDENCE_OP, "msg_id": msg_id}


def _evidence(requested="REFUSED", published="NOT_PUBLISHED", ack="NOT_APPLICABLE"):
    ladder = lr._evidence(requested=requested, published=published, ack=ack)
    ladder["executed"] = "NOT_OBSERVED" if published == "PUBLISHED" else "NOT_APPLICABLE"
    return ladder


class LocalCutGate:
    def __init__(
        self,
        supervisor,
        *,
        allowed_uid: int,
        credential: lr.RestoreCredential,
        audit: Callable[..., None] | None = None,
        audit_strict: Callable[..., None] | None = None,
        monotonic: Callable[[], float] = time.monotonic,
    ) -> None:
        self.supervisor = supervisor
        self.allowed_uid = int(allowed_uid)
        self.credential = credential
        self.audit = audit or db.log_event
        self.audit_strict = audit_strict or db.log_event_strict
        self.monotonic = monotonic
        self._auth_failures: dict[int, tuple[int, float]] = {}
        self._refusal_audit: dict[tuple[str, int], tuple[float, int]] = {}
        self._audit_lock = threading.Lock()
        self._operation_lock = threading.RLock()
        self._enabled = True

    def disable(self) -> None:
        with self._operation_lock:
            self._enabled = False

    def _audit_refusal(self, code: str, detail: str, peer: lr.Peer) -> None:
        """Best-effort and rate-limited per (code, uid): a refusal flood cannot grow the audit chain without bound."""
        now = self.monotonic()
        with self._audit_lock:
            last, suppressed = self._refusal_audit.get((code, peer.uid), (None, 0))
            if last is not None and now - last < REFUSAL_AUDIT_INTERVAL_SEC:
                self._refusal_audit[(code, peer.uid)] = (last, suppressed + 1)
                return
            self._refusal_audit[(code, peer.uid)] = (now, 0)
        try:
            self.audit(
                "CUT_REFUSED",
                f"code={code} uid={peer.uid} pid={peer.pid} suppressed_since_last={suppressed} detail={detail}",
                db.WARN,
            )
        except Exception:
            pass  # a refusal never depends on the audit store

    def _refuse(self, code: str, detail: str, peer: lr.Peer):
        self._audit_refusal(code, detail, peer)
        return lr._response(False, code, detail, evidence=_evidence())

    def note_unauthorized_peer(self, peer: lr.Peer) -> None:
        """Called by the server for a connection rejected at accept time (no bytes were read)."""
        self._audit_refusal("PEER_REFUSED", "connection from a uid that is not the configured operator account", peer)

    def handle(self, body: Any, peer: lr.Peer):
        with self._operation_lock:
            if not self._enabled:
                return self._refuse("CHANNEL_CLOSING", "the local CUT channel is closing", peer)
            return self._handle(body, peer)

    def _evidence_for(self, body: Any, peer: lr.Peer):
        msg_id = body.get("msg_id") if isinstance(body, dict) else None
        if (
            not isinstance(body, dict) or set(body) != _EVIDENCE_KEYS or body.get("v") != 1
            or not isinstance(msg_id, str) or len(msg_id) != 32
        ):
            return self._refuse("MALFORMED_REQUEST", "invalid evidence request", peer)
        try:
            int(msg_id, 16)
        except ValueError:
            return self._refuse("MALFORMED_REQUEST", "invalid command identifier", peer)
        found = lr.restore_evidence_ladder(self.supervisor, msg_id, action=CUT_UPLINK)
        if found is None:
            return self._refuse("UNKNOWN_COMMAND", "no local CUT command has that identifier", peer)
        seq, ladder = found
        return lr._response(True, "EVIDENCE", "protocol evidence only; not physical evidence",
                            msg_id=msg_id, seq=seq, evidence=ladder)

    def _authenticate(self, body: dict, peer: lr.Peer):
        """Core-side verification of the per-request secret. Returns a refusal response, or None when authenticated."""
        failures, locked_until = self._auth_failures.get(peer.uid, (0, 0.0))
        now = self.monotonic()
        if now < locked_until:
            return self._refuse("AUTH_LOCKED_OUT", "authentication is temporarily locked", peer)
        if locked_until and now >= locked_until:
            failures = 0
            self._auth_failures.pop(peer.uid, None)
        secret = body.get("secret")
        if not isinstance(secret, str) or not secret or len(secret) > SECRET_MAX_CHARS:
            return self._refuse("AUTH_REQUIRED", "per-request operator authentication is required", peer)
        if not self.credential.verify(domain_secret(secret)):
            failures += 1
            lock = now + lr.AUTH_LOCKOUT_SEC if failures >= lr.MAX_AUTH_FAILURES else 0.0
            self._auth_failures[peer.uid] = (failures, lock)
            if lock:
                try:
                    self.audit("CUT_AUTH_LOCKOUT", f"uid={peer.uid} pid={peer.pid}", db.WARN)
                except Exception:
                    pass
            return self._refuse("AUTH_FAILED", "operator authentication failed", peer)
        self._auth_failures.pop(peer.uid, None)
        return None

    def _handle(self, body: Any, peer: lr.Peer):
        if peer.uid != self.allowed_uid:
            return self._refuse("PEER_REFUSED", "request is not from the configured operator account", peer)
        if isinstance(body, dict) and body.get("op") == EVIDENCE_OP:
            return self._evidence_for(body, peer)
        if (
            not isinstance(body, dict)
            or set(body) != _REQUEST_KEYS
            or body.get("v") != 1
            or body.get("op") != CUT_UPLINK
        ):
            return self._refuse("MALFORMED_REQUEST", "invalid CUT request", peer)
        if body.get("origin") != CUT_ORIGIN:
            return self._refuse("ORIGIN_REFUSED", "origin is not the local CUT console", peer)
        # Typed confirmation is human-intent evidence only; it is checked, never trusted as authentication.
        if body.get("confirmation") != CONFIRMATION:
            return self._refuse("CONFIRMATION_REQUIRED", "exact CUT confirmation required", peer)
        problem = lr.reason_problem(body.get("reason"))
        if problem:
            return self._refuse(problem, "a bounded printable reason is required", peer)
        refused = self._authenticate(body, peer)
        if refused is not None:
            return refused
        reason = body["reason"].strip()

        def pre_publish(info: dict) -> None:
            # Runs inside the supervisor's command lock, after the pending checks and immediately before the publish.
            # A failure here raises, so nothing is published. Never contains the secret.
            self.audit_strict(
                "CUT_PRE_DISPATCH",
                f"uid={peer.uid} pid={peer.pid} msg_id={info.get('msg_id')} seq={info.get('seq')} reason={reason}",
                db.CRITICAL,
            )

        result = self.supervisor.issue_command(
            CUT_UPLINK, f"local console: {reason}", critical=True, origin=CUT_ORIGIN, pre_publish=pre_publish,
        )
        if result.sent:
            return lr._response(
                True, "CUT_PUBLISHED", "CUT_UPLINK published; ACK and physical state are not yet proven",
                msg_id=result.nonce, seq=result.seq,
                evidence=_evidence(requested="ACCEPTED", published="PUBLISHED", ack="PENDING"),
            )
        if result.reason_code == "CUT_QUEUED":
            return lr._response(True, "CUT_QUEUED", result.detail, evidence=_evidence(requested="ACCEPTED"))
        if result.dry_run and result.ok:
            return lr._response(True, "CUT_DRY_RUN", result.detail, evidence=_evidence(requested="ACCEPTED"))
        return lr._response(False, result.reason_code or "CUT_NOT_SENT", result.detail, evidence=_evidence())


class LocalCutServer(lr.LocalRestoreServer):
    """AF_UNIX server on a dedicated, pre-provisioned directory.

    The peer uid is checked right after ``accept``; a connection from any other uid is closed without reading a byte, so it
    cannot occupy the channel. Authorized connections are read under a total deadline and a size bound, handled in a bounded
    number of worker threads, and only a newline-terminated request is ever acted on (a disconnect mid-request does nothing).
    """

    def __init__(self, path: Path | str, gate: LocalCutGate, *, socket_gid: int | None = None) -> None:
        super().__init__(path, gate)
        if not self.path.is_absolute():
            raise lr.LocalRestoreError("the local CUT socket path must be absolute")
        self.socket_gid = socket_gid
        self._handlers: set[threading.Thread] = set()
        self._handlers_lock = threading.Lock()

    def _prepare_path(self) -> None:
        # Never create the directory: an absent directory is a deployment error, not something to improvise at runtime.
        if not self.path.parent.is_dir():
            raise lr.LocalRestoreError("the local CUT socket directory must be pre-provisioned")
        super()._prepare_path()

    def start(self) -> None:
        super().start()
        try:
            if self.socket_gid is not None:
                os.chown(self.path, -1, self.socket_gid)
                os.chmod(self.path, SOCKET_GROUP_MODE)
        except BaseException:
            self.close()
            raise

    def _serve(self) -> None:
        assert self._listener is not None
        while not self._stop.is_set():
            try:
                connection, _ = self._listener.accept()
            except TimeoutError:
                continue
            except OSError:
                break
            try:
                peer = lr._peer_from(connection)
            except OSError:
                connection.close()
                continue
            if peer.uid != self.gate.allowed_uid:
                self.gate.note_unauthorized_peer(peer)
                connection.close()  # no byte is read from an unauthorized peer
                continue
            with self._handlers_lock:
                if len(self._handlers) >= MAX_HANDLERS:
                    connection.close()
                    continue
                worker = threading.Thread(
                    target=self._handle_connection, args=(connection, peer), name="aegis-local-cut-conn", daemon=True,
                )
                self._handlers.add(worker)
            with self._connections_lock:
                self._connections.add(connection)
            worker.start()

    def _read_request(self, connection: socket.socket) -> Any:
        """One newline-terminated JSON object within the size and total-time bounds, else ValueError."""
        deadline = time.monotonic() + READ_DEADLINE_SEC
        data = bytearray()
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise ValueError("read deadline exceeded")
            connection.settimeout(remaining)
            chunk = connection.recv(min(4096, lr.MAX_MESSAGE_BYTES + 1 - len(data)))
            if not chunk:
                raise ValueError("connection closed before a complete request")
            data.extend(chunk)
            if b"\n" in chunk:
                break
            if len(data) > lr.MAX_MESSAGE_BYTES:
                raise ValueError("message too large")
        line = bytes(data).split(b"\n", 1)[0]
        if len(line) > lr.MAX_MESSAGE_BYTES:
            raise ValueError("message too large")
        return json.loads(line.decode("utf-8"))

    def _handle_connection(self, connection: socket.socket, peer: lr.Peer) -> None:
        try:
            with connection:
                try:
                    body = self._read_request(connection)
                except (OSError, ValueError, UnicodeError):
                    response = self.gate._refuse("MALFORMED_REQUEST", "invalid or incomplete local channel message", peer)
                else:
                    try:
                        response = self.gate.handle(body, peer)
                    except Exception:
                        response = lr._response(
                            False, "OUTCOME_UNKNOWN", "local CUT result was lost; do not retry automatically",
                            evidence={**_evidence(requested="ACCEPTED", published="OUTCOME_UNKNOWN", ack="OUTCOME_UNKNOWN"),
                                      "executed": "OUTCOME_UNKNOWN"},
                        )
                try:
                    connection.settimeout(2)
                    connection.sendall(json.dumps(response, ensure_ascii=False).encode("utf-8") + b"\n")
                except OSError:
                    pass  # the client went away; the command (if any) was already decided and is never replayed
        finally:
            with self._connections_lock:
                self._connections.discard(connection)
            with self._handlers_lock:
                self._handlers.discard(threading.current_thread())

    def close(self) -> None:
        super().close()
        with self._handlers_lock:
            workers = tuple(self._handlers)
        for worker in workers:
            worker.join(timeout=READ_DEADLINE_SEC + 3)


def send_cut_request(path: Path | str, body: dict[str, Any], *, expected_uid: int, timeout: float = 5.0):
    """One bounded request. The server must be the Core account; a lost reply is OUTCOME_UNKNOWN and never retried."""
    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    client.settimeout(timeout)
    connected = False
    try:
        client.connect(str(path))
        connected = True
        if lr._peer_from(client).uid != expected_uid:
            raise lr.ChannelUnavailable("the local CUT server is not the Core account")
        client.sendall(json.dumps(body, ensure_ascii=False).encode("utf-8") + b"\n")
        reply = client.makefile("rb").readline(lr.MAX_MESSAGE_BYTES + 1)
        if not reply or len(reply) > lr.MAX_MESSAGE_BYTES:
            raise lr.OutcomeUnknown("the Core accepted the connection but returned no bounded result")
        try:
            response = json.loads(reply.decode("utf-8"))
        except (UnicodeError, json.JSONDecodeError) as error:
            raise lr.OutcomeUnknown("the Core returned an invalid result") from error
        if not isinstance(response, dict):
            raise lr.OutcomeUnknown("the Core returned an invalid result")
        return response
    except (lr.OutcomeUnknown, lr.ChannelUnavailable):
        raise
    except OSError as error:
        if connected:
            raise lr.OutcomeUnknown("the local result was lost; do not retry automatically") from error
        raise lr.ChannelUnavailable("the Core-local CUT channel is unavailable") from error
    finally:
        client.close()


class LocalCutController:
    """Drop-in ``command_controller`` for the Desktop: CUT goes to the Core socket; RESTORE and heartbeat never leave.

    ``secret_provider`` is called once per CUT and must obtain the secret from the human at that moment (a fresh prompt).
    Nothing is cached: the secret lives only in the request body for the duration of one call. No provider, or an empty
    answer, refuses locally without contacting the Core.
    """

    dry_run = False
    legacy = False

    def __init__(
        self,
        socket_path: Path | str,
        *,
        core_uid: int | None = None,
        send=send_cut_request,
        secret_provider: Callable[[], str | None] | None = None,
    ) -> None:
        self.socket_path = Path(socket_path)
        self._core_uid = core_uid
        self._send = send
        self._secret_provider = secret_provider

    def _expected_uid(self) -> int:
        if self._core_uid is None:
            try:
                self._core_uid = recovery_client.core_uid()
            except recovery_client.RecoveryUnavailable as error:
                raise lr.ChannelUnavailable(str(error)) from None
        return self._core_uid

    def issue(self, action: str, description: str, *, critical: bool = False, origin: str = "gui",
              authorize_restore: bool = False, not_after: float | None = None) -> CommandResult:
        if action == RESTORE_UPLINK:
            return CommandResult(action, False, False, False, None,
                                 "RESTORE is not available from the Desktop; use the Core-local Recovery path",
                                 reason_code="RESTORE_NOT_AVAILABLE")
        if action != CUT_UPLINK:
            raise ValueError(f"Unsupported AEGIS command: {action}")
        secret = self._secret_provider() if self._secret_provider is not None else None
        if not isinstance(secret, str) or not secret:
            return CommandResult(action, False, False, False, None,
                                 "per-CUT operator authentication is required; nothing was sent", reason_code="AUTH_REQUIRED")
        try:
            response = self._send(
                self.socket_path, cut_request(description, secret), expected_uid=self._expected_uid(),
            )
        except lr.OutcomeUnknown as error:
            return CommandResult(action, False, False, False, None, str(error), reason_code="OUTCOME_UNKNOWN")
        except lr.LocalRestoreError as error:
            return CommandResult(action, False, False, False, None, str(error), reason_code="CHANNEL_UNAVAILABLE")
        finally:
            secret = None  # never kept past this call
        ok = bool(response.get("ok"))
        code = response.get("code")
        return CommandResult(
            action, ok, code == "CUT_PUBLISHED", code == "CUT_DRY_RUN", response.get("msg_id"),
            str(response.get("detail", "")), seq=response.get("seq"), reason_code=None if ok else code,
        )

    def evidence(self, msg_id: str):
        """Protocol evidence ladder for one CUT; never physical evidence."""
        return self._send(self.socket_path, evidence_request(msg_id), expected_uid=self._expected_uid())

    def send_heartbeat(self) -> bool:
        return False  # the Core owns heartbeats


def controller_from_environment(
    environ: Mapping[str, str] | None = None, *, secret_provider: Callable[[], str | None] | None = None,
) -> LocalCutController | None:
    """The Desktop's CUT controller, or None (CUT disabled) unless explicitly enabled and fully configured."""
    env = os.environ if environ is None else environ
    path = env.get("AEGIS_LOCAL_CUT_SOCKET", "").strip()
    if not enabled(env.get("AEGIS_LOCAL_CUT_ENABLED")) or not os.path.isabs(path):
        return None
    return LocalCutController(path, secret_provider=secret_provider)


def socket_is_group_reachable_only(path: Path | str) -> bool:
    """Diagnostic: the socket is not world accessible."""
    return not (stat.S_IMODE(Path(path).lstat().st_mode) & 0o007)
