"""Core-local manual CUT request channel for the Python Desktop operator.

Authority model (no new trust is invented here):
  * The Core (``aegis-idea3``, ``RuntimeDirectoryMode=0700``) cannot be reached by a Desktop account through its own runtime
    directory, and the Desktop never runs as the Core or as root. The channel therefore lives on a DEDICATED, pre-provisioned
    socket path, exactly like Recovery: the directory is Core-owned and not group/world writable, the socket is
    ``aegis-idea3:<socket gid> 0660`` (filesystem reachability only), and authorization is the SO_PEERCRED uid check against ONE
    configured operator uid. The client in turn refuses a server that is not the Core account.
  * The channel is INERT unless ``AEGIS_LOCAL_CUT_ENABLED`` is exactly ``YES`` AND an absolute socket path AND an operator uid
    are configured. Provisioning that directory/group is a separate reviewed deployment contract that is NOT part of this change.
  * It carries CUT only. It can never authorize RESTORE; RESTORE keeps the D4 gate.
  * Every accepted request needs a durable (strict) audit row BEFORE dispatch, then goes through ``Supervisor.issue_command``,
    the single command boundary that owns pending-ACK state and Protocol v1 signing. This module never publishes anything itself.
"""

from __future__ import annotations

import json
import os
import socket
import stat
import threading
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
_REQUEST_KEYS = frozenset({"v", "op", "origin", "confirmation", "reason"})
_EVIDENCE_KEYS = frozenset({"v", "op", "msg_id"})


def enabled(value: str | None) -> bool:
    return value == ENABLED_VALUE


def cut_request(reason: str, confirmation: str = CONFIRMATION) -> dict[str, Any]:
    return {"v": 1, "op": CUT_UPLINK, "origin": CUT_ORIGIN, "confirmation": confirmation, "reason": reason}


def evidence_request(msg_id: str) -> dict[str, Any]:
    return {"v": 1, "op": EVIDENCE_OP, "msg_id": msg_id}


def _evidence(requested="REFUSED", published="NOT_PUBLISHED", ack="NOT_APPLICABLE"):
    ladder = lr._evidence(requested=requested, published=published, ack=ack)
    ladder["executed"] = "NOT_PROVEN" if published == "PUBLISHED" else "NOT_APPLICABLE"
    return ladder


class LocalCutGate:
    def __init__(
        self,
        supervisor,
        *,
        allowed_uid: int,
        audit: Callable[..., None] | None = None,
        audit_strict: Callable[..., None] | None = None,
    ) -> None:
        self.supervisor = supervisor
        self.allowed_uid = int(allowed_uid)
        self.audit = audit or db.log_event
        self.audit_strict = audit_strict or db.log_event_strict
        self._operation_lock = threading.RLock()
        self._enabled = True

    def disable(self) -> None:
        with self._operation_lock:
            self._enabled = False

    def _refuse(self, code: str, detail: str, peer: lr.Peer):
        try:
            self.audit("CUT_REFUSED", f"code={code} uid={peer.uid} pid={peer.pid} detail={detail}", db.WARN)
        except Exception:
            pass  # a refusal never depends on the audit store
        return lr._response(False, code, detail, evidence=_evidence())

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
        if body.get("confirmation") != CONFIRMATION:
            return self._refuse("CONFIRMATION_REQUIRED", "exact CUT confirmation required", peer)
        problem = lr.reason_problem(body.get("reason"))
        if problem:
            return self._refuse(problem, "a bounded printable reason is required", peer)
        reason = body["reason"].strip()

        # Strict pre-dispatch audit: no durable row, no command. Refused explicitly, never silently dropped.
        try:
            self.audit_strict("CUT_REQUESTED", f"uid={peer.uid} pid={peer.pid} reason={reason}", db.CRITICAL)
        except Exception:
            return self._refuse("AUDIT_UNAVAILABLE", "durable audit unavailable; CUT not dispatched", peer)

        result = self.supervisor.issue_command(
            CUT_UPLINK, f"local console: {reason}", critical=True, origin=CUT_ORIGIN,
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
    """AF_UNIX server on a dedicated, pre-provisioned directory; socket group 0660 when a gid is configured."""

    def __init__(self, path: Path | str, gate: LocalCutGate, *, socket_gid: int | None = None) -> None:
        super().__init__(path, gate)
        if not self.path.is_absolute():
            raise lr.LocalRestoreError("the local CUT socket path must be absolute")
        self.socket_gid = socket_gid

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
    """Drop-in ``command_controller`` for the Desktop: CUT goes to the Core socket; RESTORE and heartbeat never leave."""

    dry_run = False
    legacy = False

    def __init__(self, socket_path: Path | str, *, core_uid: int | None = None, send=send_cut_request) -> None:
        self.socket_path = Path(socket_path)
        self._core_uid = core_uid
        self._send = send

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
        try:
            response = self._send(self.socket_path, cut_request(description), expected_uid=self._expected_uid())
        except lr.OutcomeUnknown as error:
            return CommandResult(action, False, False, False, None, str(error), reason_code="OUTCOME_UNKNOWN")
        except lr.LocalRestoreError as error:
            return CommandResult(action, False, False, False, None, str(error), reason_code="CHANNEL_UNAVAILABLE")
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


def controller_from_environment(environ: Mapping[str, str] | None = None) -> LocalCutController | None:
    """The Desktop's CUT controller, or None (CUT disabled) unless explicitly enabled and fully configured."""
    env = os.environ if environ is None else environ
    path = env.get("AEGIS_LOCAL_CUT_SOCKET", "").strip()
    if not enabled(env.get("AEGIS_LOCAL_CUT_ENABLED")) or not os.path.isabs(path):
        return None
    return LocalCutController(path)


def socket_is_group_reachable_only(path: Path | str) -> bool:
    """Diagnostic: the socket is not world accessible."""
    return not (stat.S_IMODE(Path(path).lstat().st_mode) & 0o007)
