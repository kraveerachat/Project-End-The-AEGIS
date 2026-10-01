"""Core-owned, evidence-driven incident Recovery (R1-R8) and its local AF_UNIX interface.

The Core is the sole production authority; an unprivileged observer talks to it over one AF_UNIX socket and receives
only safe evidence. This module never gives the desktop a way to:

* name an IP (R3 isolates exactly the attacker IP the Core itself bound to the open incident),
* publish a command or open the protocol store as a producer (RESTORE stays the Core-local D4 gate, observed here
  through the same reviewed evidence ladder),
* verify a PIN, reach the root containment helper, or read a credential,
* fabricate a PASS (R2/R6/R7 are probed by the Core, R3/R4/R5 come from durable audit rows and protocol evidence, and
  R8 re-checks all of it before the Core itself closes the incident).

R4 is the D4 operator credential: a durable ``RESTORE_REQUESTED`` row bound to the incident exists only after the D4
gate verified the scrypt secret and the exact typed confirmation. That same row is the one-shot R5 record; it is never
cleared and survives UI restarts and Core restarts.

IMPLEMENTED != DEPLOYED. The channel is off unless a production Core is configured with an operator uid.
"""

from __future__ import annotations

import json
import os
import re
import socket
import ssl
import stat
import struct
import threading
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from pathlib import Path
from typing import Any

from . import config
from . import database as db
from . import local_restore as lr
from . import recovery_protocol as rp
from .dispatch_worker import PAUSED_CREDENTIAL, UNAVAILABLE
from .ip_containment import (
    ContainmentClient,
    ContainmentRejected,
    ContainmentUnavailable,
    parse_ipv4,
    validate_block_target,
)

_PUBLISHED_RE = re.compile(r"^msg_id=([0-9a-f]{32})\b")
_R3_RE = re.compile(r"^result=(VERIFIED|FAILED) ip=(\S+)")


class RecoveryChannelError(RuntimeError):
    pass


def _tcp_probe(target: str, timeout: float = 2.0) -> tuple[bool, str]:
    """Bounded, read-only reachability probe for host:port. The detail never carries more than a class name."""
    host, _, port_text = target.rpartition(":")
    if not host or not port_text.isdigit():
        return False, f"invalid probe target {target!r}"
    try:
        with socket.create_connection((host, int(port_text)), timeout=timeout):
            return True, f"tcp {target} reachable"
    except OSError as error:
        return False, f"tcp {target} failed: {type(error).__name__}"


def _http_readiness_probe(url: str, timeout: float = 2.0) -> tuple[bool, str]:
    """Bounded GET against the configured HTTPS readiness URL; only https is accepted."""
    if not url.lower().startswith("https://"):
        return False, "readiness url must be https"
    try:
        ca_file = os.getenv("AEGIS_CORE_DISPATCH_CA_FILE", "").strip()
        context = ssl.create_default_context(cafile=ca_file) if ca_file else ssl.create_default_context()
        with urllib.request.urlopen(url, timeout=timeout, context=context) as reply:
            reply.read(1024)
            return 200 <= reply.status < 300, f"web readiness http {reply.status}"
    except (urllib.error.URLError, OSError, ValueError, ssl.SSLError) as error:
        return False, f"web readiness failed: {type(error).__name__}"


class CoreRecoveryService:
    def __init__(
        self,
        supervisor,
        *,
        tcp_probe: Callable[[str], tuple[bool, str]] | None = None,
        web_probe: Callable[[str], tuple[bool, str]] | None = None,
        containment=None,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self.supervisor = supervisor
        self._tcp_probe = tcp_probe or _tcp_probe
        self._web_probe = web_probe or _http_readiness_probe
        self._containment = containment
        self._clock = clock
        # ``_lock`` serialises operator operations (which may sit in sequential network probes). ``_bind_lock`` guards
        # only the incident row: the alert path takes it and never ``_lock``, so containment never waits on PROBE.
        # Order when both are needed: ``_lock`` then ``_bind_lock`` (the alert path holds only the latter).
        self._lock = threading.RLock()
        self._bind_lock = threading.RLock()
        self._probe_records: dict[str, dict[str, Any]] = {}
        self._probe_incident: int | None = None

    # ------------------------------------------------------------------ helpers

    @property
    def containment(self):
        return self._containment or getattr(self.supervisor, "containment", None) or ContainmentClient()

    def _is_production(self) -> bool:
        return self.supervisor.settings.profile == "production"

    def _record(self, gate: str, status: str, summary: str, detail: str = "") -> dict[str, Any]:
        return rp.gate_record(gate, status, summary, detail=detail, checked_at=self._clock())

    def _log(self, level: str, event: str, **detail) -> None:
        try:
            self.supervisor.log_event(level, event, **detail)
        except Exception:
            pass

    # ------------------------------------------------------------------ R1: Core-owned incident binding

    def bind_incident(self, ip: Any) -> dict[str, Any]:
        """Bind or create the single open incident from a validated production attacker alert.

        Called by the Core's own alert path only; no request operation can reach it. It never contains, cuts, or
        touches the device: it records what the Core observed.
        """
        if not self._is_production():
            return {"action": "SKIPPED", "reason": "NOT_PRODUCTION"}
        try:
            address = parse_ipv4(ip)
        except ContainmentRejected as error:
            return {"action": "REFUSED", "reason": error.reason_code}
        if address.is_unspecified or address.is_loopback or address.is_multicast or address.is_link_local:
            return {"action": "REFUSED", "reason": "NOT_AN_ATTACKER_ADDRESS"}
        safe_ip = str(address)
        with self._bind_lock:
            existing = db.get_open_incident()
            if existing is not None:
                bound = existing.get("attacker_ip")
                if bound == safe_ip:
                    return {"action": "EXISTING", "incident_id": existing["id"]}
                if bound:
                    # One open incident, one bound target. A different address never rebinds R3's target.
                    db.log_event(
                        "INCIDENT_ALERT_IGNORED",
                        f"alert_ip={safe_ip} bound_ip={bound} reason=INCIDENT_ALREADY_BOUND",
                        db.WARN, existing["id"],
                    )
                    return {"action": "IGNORED_DIFFERENT_IP", "incident_id": existing["id"]}
                db.set_incident_ip(existing["id"], safe_ip)
                incident_id, action = existing["id"], "IP_SET"
            else:
                incident_id, action = db.create_incident(safe_ip), "CREATED"
            try:
                db.log_event_strict(
                    "INCIDENT_BOUND", f"attacker_ip={safe_ip} source=detector_alert action={action}", db.WARN, incident_id,
                )
            except Exception:
                self._log("ERROR", "incident_bind_audit_failed", incident_id=incident_id)
                return {"action": action, "incident_id": incident_id, "audited": False}
            return {"action": action, "incident_id": incident_id, "audited": True}

    def _incident_gate(self, incident: dict | None) -> dict[str, Any]:
        if not incident:
            return self._record(rp.R1, rp.FAILED, "No recoverable incident is bound by the Core")
        try:
            parse_ipv4(incident.get("attacker_ip"))
        except ContainmentRejected:
            return self._record(rp.R1, rp.FAILED, f"Incident #{incident['id']} has no valid attacker_ip")
        return self._record(
            rp.R1, rp.VERIFIED, f"Bound to incident #{incident['id']}",
            f"state={incident['state']} attacker_ip={incident['attacker_ip']}",
        )

    # ------------------------------------------------------------------ R3: incident-bound isolation

    def isolate(self) -> dict[str, Any]:
        """Isolate exactly the bound attacker IP. There is no IP parameter by design."""
        incident = db.get_open_incident()
        if not incident:
            return rp.response(False, "NO_INCIDENT", "no recoverable incident is bound by the Core")
        try:
            address = str(parse_ipv4(incident.get("attacker_ip")))
        except ContainmentRejected:
            return rp.response(False, "BOUND_IP_INVALID", "the bound incident has no valid attacker_ip")
        if self.supervisor.settings.dry_run:
            return rp.response(False, "DRY_RUN", "dry-run cannot verify isolation")
        incident_id = incident["id"]
        try:
            db.log_event_strict("RECOVERY_R3_REQUESTED", f"ip={address}", db.WARN, incident_id)
        except Exception:
            return rp.response(False, "AUDIT_UNAVAILABLE", "durable audit is unavailable; nothing was applied")

        result, reason = "FAILED", "UNKNOWN"
        try:
            applied = self.containment.block(address)
            confirmed = (
                applied.get("ok") is True and applied.get("operation") == "block" and applied.get("ip") == address
            )
            if not confirmed:
                reason = str(applied.get("reason_code", "APPLY_NOT_CONFIRMED"))[:64]
            else:
                read_back = self.containment.contains(address)
                if read_back.get("ok") is True and read_back.get("present") is True:
                    result, reason = "VERIFIED", "READ_BACK_CONFIRMED"
                else:
                    reason = "READ_BACK_NOT_CONFIRMED"
        except ContainmentUnavailable:
            reason = "HELPER_UNAVAILABLE"
        try:
            db.log_event_strict(
                "RECOVERY_R3_RESULT", f"result={result} ip={address} reason={reason}",
                db.CRITICAL if result == "VERIFIED" else db.WARN, incident_id,
            )
        except Exception:
            return rp.response(False, "AUDIT_UNAVAILABLE", "isolation result could not be recorded; treat as not verified")
        return rp.response(result == "VERIFIED", f"R3_{result}", reason, self._status_data())

    def _isolation_gate(self, incident: dict | None) -> dict[str, Any]:
        if not incident:
            return self._record(rp.R3, rp.PENDING, "Waiting for R1")
        rows = db.fetch_incident_events(incident["id"], ("RECOVERY_R3_RESULT",), 1)
        if not rows:
            return self._record(rp.R3, rp.PENDING, "Isolation has not been requested for this incident")
        match = _R3_RE.match(rows[0]["details"])
        if not match:
            return self._record(rp.R3, rp.FAILED, "The latest isolation record is unreadable")
        result, ip = match.groups()
        if ip != incident.get("attacker_ip"):
            return self._record(rp.R3, rp.FAILED, "The recorded isolation does not match the bound attacker_ip")
        if result != "VERIFIED":
            return self._record(rp.R3, rp.FAILED, "The latest isolation attempt was not verified")
        return self._record(rp.R3, rp.VERIFIED, f"{ip} isolated (block plus independent read-back)")

    def _isolation_live_gate(self, incident: dict | None) -> dict[str, Any]:
        """R3 for closure: the durable record must be VERIFIED and the read-only contains() must still agree."""
        durable = self._isolation_gate(incident)
        if durable["status"] != rp.VERIFIED:
            return durable
        try:
            live = self.containment.contains(incident["attacker_ip"])
        except ContainmentUnavailable:
            return self._record(rp.R3, rp.FAILED, "The containment read-back is unavailable")
        if live.get("ok") is True and live.get("present") is True:
            return durable
        return self._record(rp.R3, rp.FAILED, "The attacker IP is no longer in the containment set")

    # ------------------------------------------------------------------ R4 / R5: observe D4, never issue

    def _authorization_gate(self, incident: dict | None) -> dict[str, Any]:
        if not incident:
            return self._record(rp.R4, rp.PENDING, "Waiting for R1")
        if db.restore_attempt_exists(incident["id"]):
            return self._record(rp.R4, rp.VERIFIED, "Authorized through the Core-local D4 operator credential")
        return self._record(rp.R4, rp.PENDING, "Awaiting the owner's D4 restore (aegisctl restore, terminal only)")

    def _restore_gate(self, incident: dict | None) -> tuple[dict[str, Any], dict[str, Any] | None]:
        if not incident:
            return self._record(rp.R5, rp.PENDING, "Waiting for R1"), None
        if not db.restore_attempt_exists(incident["id"]):
            return self._record(rp.R5, rp.PENDING, "No D4 RESTORE attempt exists for this incident"), None
        rows = db.fetch_incident_events(incident["id"], ("RESTORE_PUBLISHED",), 1)
        match = _PUBLISHED_RE.match(rows[0]["details"]) if rows else None
        if not match:
            return self._record(
                rp.R5, rp.FAILED, "The attempt is spent but no publication evidence is linked; owner review required",
            ), None
        found = lr.restore_evidence_ladder(self.supervisor, match.group(1))
        if found is None:
            return self._record(rp.R5, rp.FAILED, "The linked RESTORE command is not in the protocol store"), None
        ladder = found[1]
        ack, executed = ladder["ack"], ladder["executed"]
        if str(ack).startswith("REJECTED"):
            return self._record(rp.R5, rp.FAILED, "The device rejected RESTORE"), ladder
        if executed == "DEVICE_REPORTED_LOCKDOWN":
            return self._record(rp.R5, rp.FAILED, "The device reported LOCKDOWN after RESTORE"), ladder
        if ack == "ACCEPTED" and executed == "DEVICE_REPORTED_NORMAL":
            return self._record(rp.R5, rp.VERIFIED, "Correlated ACK accepted and correlated STATUS=NORMAL"), ladder
        if executed == "DEVICE_STATUS_CORRELATED" or ack == "OUTCOME_UNKNOWN":
            return self._record(
                rp.R5, rp.FAILED, "The stronger physical correlation is not available (Core restart?); not verified",
            ), ladder
        return self._record(rp.R5, rp.CHECKING, "Waiting for correlated ACK and correlated STATUS=NORMAL"), ladder

    def restore_status(self) -> dict[str, Any]:
        incident = db.get_open_incident()
        r4 = self._authorization_gate(incident)
        r5, ladder = self._restore_gate(incident)
        data = {"gates": [r4, r5], "restore": ladder, "restore_channel": "aegisctl restore (Core-local D4, terminal only)"}
        return rp.response(True, "RESTORE_STATUS", "evidence from the Core; not physical evidence", data)

    # ------------------------------------------------------------------ R5 ordering (pure; not wired to production yet)

    def restore_precondition_unmet(self, incident: dict | None) -> str | None:
        """Why a RESTORE must not be recorded yet, or None. R1 VERIFIED, durable R3 VERIFIED, then one fresh R2 probe.

        Pure of authority: it neither issues nor records anything. It is NOT wired into the production D4 gate until
        the owner approves a break-glass path (otherwise it could lock the owner out); see the design note.
        """
        r1 = self._incident_gate(incident)
        if r1["status"] != rp.VERIFIED:
            return "R1 is not verified: no Core-bound incident"
        if self._isolation_gate(incident)["status"] != rp.VERIFIED:
            return "R3 is not verified: isolate the attacker first"
        if self._run_r2(r1)["status"] != rp.VERIFIED:
            return "R2 is not verified: management access probe failed"
        return None

    def r3_precedes_restore(self, incident_id: Any) -> bool:
        """True only when a VERIFIED R3 result row was recorded before the RESTORE_REQUESTED row (audit id order)."""
        restore = db.fetch_incident_events(incident_id, ("RESTORE_REQUESTED",), 1)
        if not restore:
            return False
        for row in db.fetch_incident_events(incident_id, ("RECOVERY_R3_RESULT",), 200):
            match = _R3_RE.match(row["details"])
            if match and match.group(1) == "VERIFIED" and row["id"] < restore[0]["id"]:
                return True
        return False

    # ------------------------------------------------------------------ R2 / R6 / R7: Core-run probes

    def _run_r2(self, r1: dict[str, Any]) -> dict[str, Any]:
        if r1["status"] != rp.VERIFIED:
            return self._record(rp.R2, rp.PENDING, "Waiting for R1")
        target = config.RECOVERY_MANAGEMENT_PROBE_TARGET
        if not target:
            return self._record(rp.R2, rp.NOT_CONFIGURED, "No management probe target is configured")
        ok, detail = self._tcp_probe(target)
        return self._record(rp.R2, rp.VERIFIED if ok else rp.FAILED, "Management access probe", detail)

    def _run_r6(self, r5: dict[str, Any]) -> dict[str, Any]:
        if r5["status"] != rp.VERIFIED:
            return self._record(rp.R6, rp.PENDING, "Waiting for R5")
        targets = [item.strip() for item in config.RECOVERY_NETWORK_PROBE_TARGETS.split(",") if item.strip()]
        if not targets:
            return self._record(rp.R6, rp.NOT_CONFIGURED, "No network probe targets are configured")
        results = {target: self._tcp_probe(target) for target in targets}
        failed = [target for target, (ok, _) in results.items() if not ok]
        detail = "; ".join(f"{target}={text}" for target, (_, text) in results.items())
        if failed:
            return self._record(rp.R6, rp.FAILED, f"Network probe(s) failed: {', '.join(failed)}", detail)
        return self._record(rp.R6, rp.VERIFIED, f"{len(targets)} network probe(s) passed", detail)

    def _run_r7(self, r6: dict[str, Any]) -> dict[str, Any]:
        if r6["status"] != rp.VERIFIED:
            return self._record(rp.R7, rp.PENDING, "Waiting for R6")
        supervisor = self.supervisor
        checks: dict[str, bool | None] = {
            "core_db": bool(db.ping()),
            "mqtt": bool(getattr(supervisor.mqtt, "is_connected", False)),
            "device": bool(supervisor.mqtt.device_online()),
            "uplink_normal": supervisor.status.uplink == "NORMAL",
            "dispatch": supervisor.status.dispatch not in {PAUSED_CREDENTIAL, UNAVAILABLE},
        }
        web_url = config.RECOVERY_WEB_READINESS_URL
        checks["web"] = self._web_probe(web_url)[0] if web_url else None
        detail = " ".join(f"{name}={'OK' if value else ('NOT_CONFIGURED' if value is None else 'FAIL')}" for name, value in checks.items())
        if any(value is False for value in checks.values()):
            return self._record(rp.R7, rp.FAILED, "A mandatory Core service is not ready", detail)
        if any(value is None for value in checks.values()):
            return self._record(rp.R7, rp.NOT_CONFIGURED, "A mandatory readiness target is not configured", detail)
        return self._record(rp.R7, rp.VERIFIED, "The running Core reports every mandatory service ready", detail)

    def probe(self) -> dict[str, Any]:
        with self._lock:
            incident = db.get_open_incident()
            self._store_probes(incident)
        return rp.response(True, "PROBED", "Core probes completed", self._status_data())

    def _store_probes(self, incident: dict | None) -> None:
        r1 = self._incident_gate(incident)
        r5, _ = self._restore_gate(incident)
        r2 = self._run_r2(r1)
        r6 = self._run_r6(r5)
        r7 = self._run_r7(r6)
        self._probe_records = {rp.R2: r2, rp.R6: r6, rp.R7: r7}
        self._probe_incident = incident["id"] if incident else None

    # ------------------------------------------------------------------ status

    def _cached_probe(self, gate: str, incident: dict | None, waiting: str) -> dict[str, Any]:
        record = self._probe_records.get(gate)
        if record is None or not incident or self._probe_incident != incident["id"]:
            return self._record(gate, rp.PENDING, waiting)
        return record

    def _status_data(self) -> dict[str, Any]:
        incident = db.get_open_incident()
        r1 = self._incident_gate(incident)
        r5, ladder = self._restore_gate(incident)
        gates = [
            r1,
            self._cached_probe(rp.R2, incident, "Run PROBE after R1"),
            self._isolation_gate(incident),
            self._authorization_gate(incident),
            r5,
            self._cached_probe(rp.R6, incident, "Run PROBE after R5 is verified"),
            self._cached_probe(rp.R7, incident, "Run PROBE after R6 is verified"),
            self._record(rp.R8, rp.PENDING, "Closure is performed by the Core once R1-R7 are verified"),
        ]
        return {
            "incident": (
                {key: incident[key] for key in ("id", "state", "opened_at", "attacker_ip")} if incident else None
            ),
            "gates": gates,
            "restore": ladder,
        }

    def status(self) -> dict[str, Any]:
        return rp.response(True, "STATUS", "Core-attested recovery state", self._status_data())

    # ------------------------------------------------------------------ R8: Core closure

    def close(self, summary: str) -> dict[str, Any]:
        with self._lock:
            incident = db.get_open_incident()
            if not incident:
                return rp.response(False, "NO_INCIDENT", "no recoverable incident is bound by the Core")
            r1 = self._incident_gate(incident)
            r5, _ = self._restore_gate(incident)
            r2 = self._run_r2(r1)
            r6 = self._run_r6(r5)
            r7 = self._run_r7(r6)
            gates = {
                rp.R1: r1,
                rp.R2: r2,
                rp.R3: self._isolation_live_gate(incident),
                rp.R4: self._authorization_gate(incident),
                rp.R5: r5,
                rp.R6: r6,
                rp.R7: r7,
            }
            incomplete = [gate for gate in rp.CLOSURE_REQUIRED if gates[gate]["status"] != rp.VERIFIED]
            if incomplete:
                return rp.response(
                    False, "CLOSURE_REFUSED", "incomplete gate(s): " + ", ".join(incomplete),
                    {"gates": [gates[g] for g in rp.CLOSURE_REQUIRED]},
                )
            incident_id = incident["id"]
            with self._bind_lock:  # brief: the alert path may bind while probes ran; re-check the same incident and target
                current = db.get_open_incident()
                if current is None or current["id"] != incident_id or current.get("attacker_ip") != incident.get("attacker_ip"):
                    return rp.response(False, "CLOSURE_REFUSED", "the incident changed while it was being verified; retry")
                try:
                    db.log_event_strict("RECOVERY_R8_CLOSE", f"summary={summary}", db.INFO, incident_id)
                except Exception:
                    return rp.response(False, "AUDIT_UNAVAILABLE", "durable audit is unavailable; the incident was not closed")
                db.close_incident(incident_id, summary)
            db.log_event("INCIDENT_CLOSED", summary, db.INFO, incident_id)
            self._probe_records = {}
            self._probe_incident = None
            return rp.response(True, "CLOSED", f"incident #{incident_id} closed by the Core with a complete evidence chain")

    # ------------------------------------------------------------------ dispatch

    def handle(self, body: Any, peer: lr.Peer, *, allowed_uid: int) -> dict[str, Any]:
        with self._lock:
            if peer.uid != allowed_uid:
                return self._refuse("PEER_REFUSED", "request is not from the configured operator account", peer)
            try:
                op, params = rp.validate_request(body)
            except rp.RequestError as error:
                return self._refuse(error.code, "invalid Recovery request", peer)
            if not self._is_production():
                return self._refuse("NOT_PRODUCTION", "Recovery is available on a production Core only", peer)
            if op == rp.OP_STATUS:
                return self.status()
            if op == rp.OP_ISOLATE:
                return self.isolate()
            if op == rp.OP_PROBE:
                return self.probe()
            if op == rp.OP_RESTORE_STATUS:
                return self.restore_status()
            return self.close(params["summary"])

    def _refuse(self, code: str, detail: str, peer: lr.Peer) -> dict[str, Any]:
        try:
            db.log_event("RECOVERY_REFUSED", f"code={code} uid={peer.uid} pid={peer.pid}", db.WARN)
        except Exception:
            pass
        return rp.response(False, code, detail)


def _peer_from(connection: socket.socket) -> lr.Peer:
    raw = connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i"))
    pid, uid, _gid = struct.unpack("3i", raw)
    return lr.Peer(uid=uid, pid=pid)


REQUEST_DEADLINE_SEC = 5.0  # one monotonic budget for reading a whole request (not per recv)


class RecoveryServer:
    """Core-owned AF_UNIX server: local only, peer-credential checked, bounded, allowlisted, no network listener."""

    family = socket.AF_UNIX
    max_message_bytes = rp.MAX_MESSAGE_BYTES
    thread_name = "aegis-core-recovery"

    def __init__(
        self, path: Path | str, service: CoreRecoveryService, *, allowed_uid: int, socket_gid: int | None = None,
    ) -> None:
        self.path = Path(path)
        self.service = service
        self.allowed_uid = int(allowed_uid)
        self.socket_gid = socket_gid
        self.request_deadline = REQUEST_DEADLINE_SEC
        self._listener: socket.socket | None = None
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()

    def _prepare_path(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
        parent = self.path.parent.lstat()
        if (
            not stat.S_ISDIR(parent.st_mode)
            or parent.st_uid != os.geteuid()
            or stat.S_IMODE(parent.st_mode) & 0o022
        ):
            raise RecoveryChannelError("the Recovery runtime directory must be Core-owned and not group/world writable")
        try:
            metadata = self.path.lstat()
        except FileNotFoundError:
            return
        if not stat.S_ISSOCK(metadata.st_mode):
            raise RecoveryChannelError("refusing to replace a non-socket Recovery path")
        probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            probe.settimeout(0.1)
            probe.connect(str(self.path))
        except OSError:
            self.path.unlink()
        else:
            raise RecoveryChannelError("a Recovery server is already listening")
        finally:
            probe.close()

    def start(self) -> None:
        if self._listener is not None:
            return
        if not lr.local_restore_supported():
            raise RecoveryChannelError("Recovery requires a POSIX AF_UNIX platform")
        self._prepare_path()
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            listener.bind(str(self.path))
            if self.socket_gid is not None:
                os.chown(self.path, -1, self.socket_gid)
                os.chmod(self.path, 0o660)
            else:
                os.chmod(self.path, 0o600)
            listener.listen(4)
            listener.settimeout(0.2)
        except BaseException:
            listener.close()
            raise
        self._listener = listener
        self._stop.clear()
        self._thread = threading.Thread(target=self._serve, name=self.thread_name, daemon=True)
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
            with connection:
                connection.settimeout(self.request_deadline)  # bounds the reply write as well
                try:
                    response = self._read_and_handle(connection)
                except Exception:
                    response = rp.response(False, "OUTCOME_UNKNOWN", "the Recovery result was lost; do not assume success")
                try:
                    connection.settimeout(self.request_deadline)  # the read loop shrinks it; the reply gets a fresh bound
                    connection.sendall(json.dumps(response, ensure_ascii=False).encode("utf-8") + b"\n")
                except OSError:
                    pass

    def _read_and_handle(self, connection: socket.socket) -> dict[str, Any]:
        peer = lr.Peer(uid=-1, pid=-1)
        try:
            peer = _peer_from(connection)
        except OSError:
            return self.service.handle(None, peer, allowed_uid=self.allowed_uid)
        if peer.uid != self.allowed_uid:
            # Refuse before reading a single request byte: an unauthorized peer can neither trickle nor pipeline.
            return self.service.handle(None, peer, allowed_uid=self.allowed_uid)
        deadline = time.monotonic() + self.request_deadline
        try:
            data = bytearray()
            while len(data) <= self.max_message_bytes:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError("request deadline exceeded")
                connection.settimeout(remaining)
                chunk = connection.recv(min(1024, self.max_message_bytes + 1 - len(data)))
                if not chunk:
                    break
                data.extend(chunk)
                if b"\n" in chunk:
                    break
            if len(data) > self.max_message_bytes:
                raise ValueError("message too large")
            body = json.loads(bytes(data).split(b"\n", 1)[0].decode("utf-8"))
        except (OSError, UnicodeError, ValueError):
            return self.service.handle(None, peer, allowed_uid=self.allowed_uid)
        return self.service.handle(body, peer, allowed_uid=self.allowed_uid)

    def close(self) -> None:
        self._stop.set()
        listener, self._listener = self._listener, None
        if listener is not None:
            listener.close()
        if self._thread is not None:
            self._thread.join()
            self._thread = None
        try:
            if stat.S_ISSOCK(self.path.lstat().st_mode):
                self.path.unlink()
        except FileNotFoundError:
            pass


# --------------------------------------------------------------------------- F1: production alert ingress

ALERT_CHANNEL_NAME = "alert.sock"
ALERT_MAX_BYTES = 256  # {"v":1,"attacker_ip":"255.255.255.255"} is about 40 bytes
ALERT_REQUEST_DEADLINE_SEC = 2.0
ALERT_RATE_BURST = 5
ALERT_RATE_PER_MIN = 10.0
_ALERT_AUDIT_WINDOW_SEC = 60.0
_ALERT_KEYS = frozenset({"v", "attacker_ip"})


class AlertRequestError(ValueError):
    """An alert the ingress refuses before doing anything; ``code`` is a stable, secret-free reason."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def parse_alert(body: Any) -> str:
    """Strict contract: exactly ``{"v": 1, "attacker_ip": "<IPv4>"}``. Returns the validated address text."""
    if not isinstance(body, dict) or set(body) != _ALERT_KEYS:
        raise AlertRequestError("MALFORMED_REQUEST")
    version = body["v"]
    if type(version) is not int or version != 1:
        raise AlertRequestError("MALFORMED_REQUEST")
    try:
        # The same address rules the root helper applies to a block target (unspecified, this-network, loopback,
        # multicast, link-local, reserved). Protected-network membership is the helper's call at isolation time.
        return str(validate_block_target(body["attacker_ip"], ()))
    except ContainmentRejected:
        raise AlertRequestError("BAD_ADDRESS") from None


class AlertIngress:
    """Core-local production alert ingress: one configured uid may submit one IPv4 attacker candidate.

    The only effect of an accepted alert is the ``on_alert`` callback (the supervisor's R1 binding). The request
    carries no action, path, command or secret, so a sender can neither choose a target nor ask for anything beyond
    recording what it observed. A bounded token bucket caps the rate; refusal audit rows are capped as well.
    """

    def __init__(self, on_alert: Callable[[str], dict[str, Any]], *, clock: Callable[[], float] = time.monotonic) -> None:
        self._on_alert = on_alert
        self._clock = clock
        self._lock = threading.Lock()
        self._tokens = float(ALERT_RATE_BURST)
        self._stamp = clock()
        self._audit_stamp: dict[str, float] = {}

    def _take_token(self) -> bool:
        with self._lock:
            now = self._clock()
            elapsed = max(0.0, now - self._stamp)
            self._stamp = now
            self._tokens = min(float(ALERT_RATE_BURST), self._tokens + elapsed * ALERT_RATE_PER_MIN / 60.0)
            if self._tokens < 1.0:
                return False
            self._tokens -= 1.0
            return True

    def _audit_limited(self, event_type: str, detail: str) -> None:
        """At most one row per event type per window for the cheap-to-trigger refusals."""
        with self._lock:
            now = self._clock()
            last = self._audit_stamp.get(event_type)
            if last is not None and now - last < _ALERT_AUDIT_WINDOW_SEC:
                return
            self._audit_stamp[event_type] = now
        try:
            db.log_event(event_type, detail, db.WARN)
        except Exception:
            pass

    def handle(self, body: Any, peer: lr.Peer, *, allowed_uid: int) -> dict[str, Any]:
        if peer.uid != allowed_uid:
            self._audit_limited("ALERT_PEER_REFUSED", f"uid={peer.uid} pid={peer.pid}")
            return rp.response(False, "PEER_REFUSED", "request is not from the configured alert source")
        if not self._take_token():
            self._audit_limited("ALERT_RATE_LIMITED", "alert rate limit reached; further alerts are dropped")
            return rp.response(False, "RATE_LIMITED", "alert rate limit reached")
        try:
            address = parse_alert(body)
        except AlertRequestError as error:
            try:
                db.log_event("ALERT_REFUSED", f"code={error.code} uid={peer.uid} pid={peer.pid}", db.WARN)
            except Exception:
                pass
            return rp.response(False, error.code, "invalid alert request")
        try:
            result = self._on_alert(address)
        except Exception:
            return rp.response(False, "ALERT_FAILED", "the alert could not be recorded; nothing was done")
        action = result.get("action")
        if action == "SKIPPED":
            return rp.response(False, "NOT_PRODUCTION", "alerts are accepted on a production Core only")
        if action == "REFUSED":
            return rp.response(False, "BAD_ADDRESS", "the address is not an attacker candidate")
        if action == "IGNORED_DIFFERENT_IP":
            return rp.response(False, "IGNORED_DIFFERENT_IP", "an incident is already bound to a different address")
        if result.get("audited") is False:
            return rp.response(False, "AUDIT_UNAVAILABLE", "the incident was bound but its audit row could not be written")
        if action == "EXISTING":
            return rp.response(True, "EXISTING", "the incident is already bound to this address")
        return rp.response(True, "BOUND", "the incident was bound to this address")


class AlertServer(RecoveryServer):
    """The ingress socket: same peer-first, bounded AF_UNIX server as Recovery, with a 256-byte request and a 2 s deadline.

    No socket group is ever configured, so the file is Core-owned 0600; the SO_PEERCRED uid check is the authority.
    """

    max_message_bytes = ALERT_MAX_BYTES
    thread_name = "aegis-core-alert"

    def __init__(self, path: Path | str, ingress: AlertIngress, *, allowed_uid: int) -> None:
        super().__init__(path, ingress, allowed_uid=allowed_uid, socket_gid=None)  # type: ignore[arg-type]
        self.request_deadline = ALERT_REQUEST_DEADLINE_SEC


__all__ = [
    "ALERT_CHANNEL_NAME", "AlertIngress", "AlertRequestError", "AlertServer", "CoreRecoveryService", "RecoveryChannelError",
    "RecoveryServer", "parse_alert",
]
