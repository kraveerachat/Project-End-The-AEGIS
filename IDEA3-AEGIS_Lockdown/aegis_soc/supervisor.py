"""Headless AEGIS runtime supervisor with fail-safe state reporting."""

from __future__ import annotations

import argparse
import ipaddress
import json
import logging
import os
import signal
import subprocess
import sys
import tempfile
import threading
import time
from collections import deque
from contextlib import contextmanager
from dataclasses import dataclass, field
from logging.handlers import RotatingFileHandler
from pathlib import Path

from . import config, local_cut
from . import database as db
from . import graduated_ingress as gi
from . import graduated_response as gr
from . import historical_disposition as hd
from . import local_restore as lr
from . import recovery_core as rc
from . import recovery_protocol as rp
from . import recovery_view
from .controller import AegisCommandController, CommandResult
from .dispatch_worker import (
    ACTIVE,
    DISABLED,
    PAUSED_CREDENTIAL,
    UNAVAILABLE,
    build_dispatch_worker_from_environment,
)
from .ip_containment import ContainmentClient, ContainmentUnavailable
from .mqtt_client import MQTTManager
from .platform_lock import AlreadyRunningError, ExclusiveFileLock
from .protocol_runtime import build_protocol_context_from_environment
from .runtime import RuntimeSettings, RuntimeState, RuntimeStatus
from .trusted_time import TRUSTED_STATES, TrustedClock


class InstanceLock:
    def __init__(self, settings: RuntimeSettings):
        self.settings = settings
        self._lock = ExclusiveFileLock(
            settings.lock_path,
            f"pid={os.getpid()}",
        )

    def acquire(self) -> None:
        self.settings.runtime_dir.mkdir(parents=True, exist_ok=True)
        try:
            self._lock.acquire()
            self.settings.pid_path.write_text(f"{os.getpid()}\n", encoding="utf-8")
        except Exception:
            self._lock.release()
            raise

    def release(self) -> None:
        self._lock.release()
        try:
            self.settings.pid_path.unlink()
        except FileNotFoundError:
            pass


@dataclass
class ManagedProcess:
    name: str
    argv: list[str]
    env: dict[str, str]
    process: subprocess.Popen | None = None
    restart_times: deque[float] = field(default_factory=deque)
    next_restart_at: float = 0.0
    failed: bool = False


class ChildProcessSupervisor:
    _BACKOFF = (1.0, 2.0, 5.0, 10.0, 30.0)

    def __init__(self, settings: RuntimeSettings, logger, popen_factory=subprocess.Popen):
        self.settings = settings
        self.logger = logger
        self.popen_factory = popen_factory
        self.components: dict[str, ManagedProcess] = {}
        self._output_handle = None

    def configure(self) -> None:
        root = Path(__file__).resolve().parent.parent
        child_env = os.environ.copy()
        child_env["AEGIS_DRY_RUN"] = "1" if self.settings.dry_run else "0"
        # The supervisor alone owns automated containment; GUI remains an operator surface.
        child_env["AEGIS_AUTO_CONTAIN"] = "0"
        if self.settings.start_detector:
            self.components["detector"] = ManagedProcess(
                "detector", [sys.executable, str(root / "detector.py")], child_env.copy()
            )
        if self.settings.start_gui:
            self.components["gui"] = ManagedProcess(
                "gui", [sys.executable, str(root / "server_admin.py")], child_env.copy()
            )

    def _start(self, component: ManagedProcess) -> None:
        if self._output_handle is None:
            self.settings.log_dir.mkdir(parents=True, exist_ok=True)
            output_path = self.settings.log_dir / "aegis-components.log"
            self._output_handle = output_path.open("a", encoding="utf-8")
        component.process = self.popen_factory(
            component.argv,
            cwd=Path(__file__).resolve().parent.parent,
            env=component.env,
            stdin=subprocess.DEVNULL,
            stdout=self._output_handle,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        self.logger("INFO", "component_started", component=component.name, pid=component.process.pid)

    def start_all(self) -> None:
        self.configure()
        for component in self.components.values():
            self._start(component)

    def poll(self, now: float | None = None) -> dict[str, str]:
        now = time.monotonic() if now is None else now
        states: dict[str, str] = {}
        for component in self.components.values():
            if component.failed:
                states[component.name] = "FAILED"
                continue
            if component.process is not None and component.process.poll() is None:
                states[component.name] = "RUNNING"
                continue
            if component.process is not None:
                code = component.process.returncode
                component.process = None
                component.restart_times.append(now)
                while component.restart_times and now - component.restart_times[0] > self.settings.restart_window_sec:
                    component.restart_times.popleft()
                if len(component.restart_times) > self.settings.max_restarts:
                    component.failed = True
                    states[component.name] = "FAILED"
                    self.logger("ERROR", "component_crash_loop", component=component.name, returncode=code)
                    continue
                delay = self._BACKOFF[min(len(component.restart_times) - 1, len(self._BACKOFF) - 1)]
                component.next_restart_at = now + delay
                self.logger("WARNING", "component_exited", component=component.name,
                            returncode=code, restart_in=delay)
            if now >= component.next_restart_at:
                self._start(component)
                states[component.name] = "RUNNING"
            else:
                states[component.name] = "RESTARTING"
        return states

    def stop_all(self) -> None:
        for component in self.components.values():
            process = component.process
            if process is None or process.poll() is not None:
                continue
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.logger("ERROR", "component_stop_timeout", component=component.name)
        if self._output_handle is not None:
            self._output_handle.close()
            self._output_handle = None


_DEFAULT_DISPATCH_WORKER = object()
_DEFAULT_PROTOCOL = object()
_DEFAULT_RESTORE_CREDENTIAL = object()

# Status detail never claims physical or relay proof (evidence ladder, design §12).
STATE_DETAIL = {
    RuntimeState.RUNNING: "runtime healthy",
    RuntimeState.WAIT_BROKER: "waiting for MQTT broker",
    RuntimeState.WAIT_DEVICE: "broker connected; device state unknown",
    RuntimeState.DEGRADED: "broker, device, dispatch, or trusted time unavailable",
    RuntimeState.LOCKDOWN: "device reports LOCKDOWN output state",
}


GRADUATED_HISTORY = 10


class AegisSupervisor:
    def __init__(
        self,
        settings: RuntimeSettings,
        *,
        mqtt_manager=None,
        monotonic=time.monotonic,
        dispatch_worker=_DEFAULT_DISPATCH_WORKER,
        protocol=_DEFAULT_PROTOCOL,
        clock=None,
        restore_origins: frozenset[str] = frozenset(),
        restore_credential=_DEFAULT_RESTORE_CREDENTIAL,
        containment_client=None,
    ):
        self.settings = settings
        # Software containment runs through the root helper's socket; Core never runs nft.
        self.containment = containment_client if containment_client is not None else ContainmentClient()
        if settings.profile == "production" and restore_origins:
            raise ValueError("production RESTORE authority is available only through the D4 local gate")
        if restore_credential is _DEFAULT_RESTORE_CREDENTIAL:
            restore_credential = None
            if config.RESTORE_CREDENTIAL_FILE and lr.local_restore_supported():
                try:
                    restore_credential = lr.RestoreCredential.load(config.RESTORE_CREDENTIAL_FILE)
                except lr.CredentialError:
                    # RuntimeSettings.preflight() reports the controlled startup
                    # failure without turning a bad file into a restart traceback.
                    restore_credential = None
        if restore_credential is not None and restore_origins:
            raise ValueError("D4 RESTORE authority cannot be combined with caller-provided origins")
        d4_enabled = restore_credential is not None and lr.local_restore_supported()
        effective_restore_origins = frozenset({lr.CONTROLLER_ORIGIN}) if d4_enabled else restore_origins
        self.protocol = (
            build_protocol_context_from_environment() if protocol is _DEFAULT_PROTOCOL else protocol
        )
        self.clock = clock or (self.protocol.clock if self.protocol is not None else TrustedClock())
        self.mqtt = mqtt_manager or MQTTManager(protocol=self.protocol)
        # The headless Core never restores on its own. D4 exposes one internal
        # origin only after a private local gate has authenticated and audited.
        self.controller = AegisCommandController(
            self.mqtt,
            dry_run=settings.dry_run,
            protocol=self.protocol,
            restore_origins=effective_restore_origins,
        )
        self.restore_credential = restore_credential if d4_enabled else None
        self.local_restore = None
        self.local_cut = None
        self.recovery = rc.CoreRecoveryService(self)
        self.recovery_server = None
        self.alert_server = None
        self.historical_server = None
        self._command_lock = threading.RLock()
        self._fresh_lockdown: tuple[str, int] | None = None  # process-local; never restored from the database
        self._containment_count_lock = threading.Lock()
        self._containment_count = 0
        self._containment_pending = threading.Event()
        self._deferred_cut = None
        self.monotonic = monotonic
        # IDEA3 graduated response: None (inert) unless AEGIS_GRADUATED_RESPONSE=YES.
        self.graduated = gr.GraduatedResponse(clock=monotonic) if config.graduated_response_enabled() else None
        self._graduated_history: deque = deque(maxlen=GRADUATED_HISTORY)
        self._graduated_write_lock = threading.Lock()
        self.started_at = monotonic()
        self._recovery_view_failed = False
        self._device_seen = False   # becomes True with the first authenticated device status
        self.last_heartbeat_at = 0.0
        self.stop_requested = False
        self._stop_event = threading.Event()
        self.pending_command = None
        self.awaiting_physical_confirmation = None
        self.ack_timed_out = False
        self.status = RuntimeStatus(
            profile=settings.profile,
            dry_run=settings.dry_run,
            auto_contain=settings.auto_contain,
            armed="ARMED",
        )
        self.instance_lock = InstanceLock(settings)
        self.children = ChildProcessSupervisor(settings, self.log_event)
        self._event_logger = self._build_event_logger()
        self.dispatch_worker = (
            build_dispatch_worker_from_environment(self)
            if dispatch_worker is _DEFAULT_DISPATCH_WORKER
            else dispatch_worker
        )

    def _build_event_logger(self):
        logger = logging.getLogger(f"aegis_supervisor.{id(self)}")
        logger.setLevel(logging.INFO)
        path = self.settings.log_dir / "aegis-events.jsonl"
        path.parent.mkdir(parents=True, exist_ok=True)
        handler = RotatingFileHandler(path, maxBytes=1_000_000, backupCount=5, encoding="utf-8")
        handler.setFormatter(logging.Formatter("%(message)s"))
        logger.addHandler(handler)
        logger.propagate = False
        return logger

    def log_event(self, level: str, event: str, **detail) -> None:
        payload = {
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "component": "supervisor",
            "level": level,
            "event": event,
            "detail": detail,
        }
        getattr(self._event_logger, level.lower(), self._event_logger.info)(
            json.dumps(payload, ensure_ascii=False, sort_keys=True)
        )

    def transition(self, state: RuntimeState, detail: str) -> None:
        if self.status.state != state or self.status.detail != detail:
            self.status.state = state
            self.status.detail = detail
            self.log_event("INFO", "state_transition", state=state, reason=detail)
        self.status.write(self.settings.status_path)

    def _restore_basis_approved(self, basis) -> bool:
        if isinstance(basis, lr.BreakGlassBasis):
            # A forged basis cannot pass: it must name a real, spent claim of the fresh episode, consumed exactly once.
            if self.fresh_lockdown_episode() != basis.episode_id:
                return False
            try:
                return db.consume_break_glass_claim(basis.claim_id, basis.episode_id)
            except Exception:
                return False
        return isinstance(basis, str) and basis in lr.PRODUCTION_RESTORE_BASES

    def fresh_lockdown_episode(self) -> int | None:
        """The open durable lockdown episode id ONLY while THIS process holds a fresh authenticated LOCKDOWN for it.

        The proof is process-local and is never reconstructed from the database, so a Core restart clears it.
        """
        proof = self._fresh_lockdown
        context = self.protocol
        if proof is None or context is None or proof[0] != context.device_id:
            return None
        try:
            episode = db.get_open_lockdown_episode(proof[0])
        except Exception:
            return None
        return proof[1] if episode and episode["id"] == proof[1] else None

    def _on_authenticated_status(self, state, device_id, msg_id) -> None:
        """Authenticated Protocol-v1 STATUS only: update the durable episode model and the process-local freshness proof."""
        if state not in ("LOCKDOWN", "NORMAL"):
            return
        with self._command_lock:
            self._fresh_lockdown = None
            try:
                episode_id = db.record_authenticated_status(device_id, state, msg_id)
            except Exception as exc:
                self.log_event("ERROR", "lockdown_episode_record_failed", error=type(exc).__name__)
                return
            if state == "LOCKDOWN" and episode_id is not None:
                self._fresh_lockdown = (device_id, episode_id)

    def issue_command(
        self,
        action: str,
        description: str,
        *,
        critical: bool = False,
        origin: str = "unknown",
        authorize_restore: bool = False,
        not_after: float | None = None,
        restore_basis: str | None = None,
        pre_publish=None,
    ):
        """Issue a physical command and let Core own pending-ACK state.

        ``pre_publish`` runs inside ``_command_lock``, after the pending/containment checks passed and immediately before the
        publish, so a durable pre-dispatch record is part of the same atomic decision (a refused request writes nothing).
        """
        if (
            action == "RESTORE_UPLINK"
            and self.settings.profile == "production"
            and not self._restore_basis_approved(restore_basis)
        ):
            # Production chokepoint: no caller can publish RESTORE without exactly one approved basis, which only the D4 gate
            # supplies: NORMAL_R5_BASIS after the Recovery preconditions passed, or BREAK_GLASS_BASIS after the durable
            # one-per-lockdown-episode claim (OD-R5-BG-01). No basis: refuse.
            detail = "RESTORE_UPLINK rejected: production RESTORE requires the verified Recovery policy basis"
            db.log_event("COMMAND_REJECTED", f"{detail} (origin={origin})", db.WARN)
            return CommandResult(
                action, False, False, self.controller.dry_run, None, detail, reason_code="RESTORE_POLICY_REQUIRED",
            )
        containment = action == "CUT_UPLINK"
        if containment:
            with self._containment_count_lock:
                self._containment_count += 1
                self._containment_pending.set()
        try:
            with self._command_lock:
                if action == "RESTORE_UPLINK" and self._containment_pending.is_set():
                    detail = "RESTORE_UPLINK rejected: fail-secure containment is pending"
                    db.log_event("COMMAND_REJECTED", f"{detail} (origin={origin})", db.WARN)
                    return CommandResult(
                        action,
                        False,
                        False,
                        self.controller.dry_run,
                        None,
                        detail,
                        reason_code="CONTAINMENT_PENDING",
                    )
                if self.pending_command is not None:
                    if action == "CUT_UPLINK" and self.pending_command.get("action") == "RESTORE_UPLINK":
                        self._deferred_cut = self._deferred_cut or {
                            "description": description,
                            "critical": critical,
                            "origin": origin,
                            "not_after": not_after,
                            "pre_publish": pre_publish,
                        }
                        detail = "CUT_UPLINK queued behind the in-flight RESTORE_UPLINK"
                        db.log_event("COMMAND_QUEUED", f"{detail} (origin={origin})", db.CRITICAL)
                        return CommandResult(
                            action,
                            True,
                            False,
                            self.controller.dry_run,
                            None,
                            detail,
                            reason_code="CUT_QUEUED",
                        )
                    detail = f"{action} rejected: another relay command is awaiting ACK"
                    db.log_event("COMMAND_REJECTED", f"{detail} (origin={origin})", db.WARN)
                    return CommandResult(
                        action,
                        False,
                        False,
                        self.controller.dry_run,
                        None,
                        detail,
                        reason_code="COMMAND_PENDING",
                    )
                result = self.controller.issue(
                    action,
                    description,
                    critical=critical,
                    origin=origin,
                    authorize_restore=authorize_restore,
                    not_after=not_after,
                    **({} if pre_publish is None else {"pre_publish": pre_publish}),
                )
                if result.sent:
                    self.pending_command = {
                        "action": result.action,
                        "sent_at": self.monotonic(),
                        "nonce": result.nonce,
                    }
                    self.awaiting_physical_confirmation = {
                        "action": result.action,
                        "nonce": result.nonce,
                        "expected_state": (
                            "LOCKDOWN"
                            if result.action == "CUT_UPLINK"
                            else "NORMAL"
                        ),
                        "observed_state": None,
                        "acknowledged_at": None,
                        "physical_confirmed_at": None,
                        "physical_timeout_at": None,
                    }
                    self.ack_timed_out = False
                return result
        finally:
            if containment:
                with self._containment_count_lock:
                    self._containment_count -= 1
                    if self._containment_count == 0:
                        self._containment_pending.clear()

    def _drain_deferred_cut_locked(self) -> None:
        queued, self._deferred_cut = self._deferred_cut, None
        if queued is None:
            return
        result = self.issue_command("CUT_UPLINK", **queued)
        self.log_event(
            "CRITICAL" if result.sent else "ERROR",
            "deferred_containment",
            sent=result.sent,
            reason_code=result.reason_code,
            origin=queued["origin"],
        )

    @contextmanager
    def command_guard(self):
        """Serialize state checks and publication across every Core command source."""
        with self._command_lock:
            yield

    def _protocol_active(self) -> bool:
        return self.protocol is not None and not self.controller.legacy

    def protocol_time_trusted(self) -> bool:
        """Protocol v1 needs SYNCED or HOLDOVER Core time; legacy lab mode is not gated."""
        if self.controller.legacy:
            return True
        if self.protocol is None:
            return False
        return self.clock.state() in TRUSTED_STATES

    def _refresh_protocol_state(self) -> None:
        self.status.time_trust = str(self.clock.state())
        if self.protocol is None:
            return
        try:
            self.protocol.store.prune_seen()
        except Exception as exc:
            self.log_event("WARNING", "protocol_store_prune_failed", error=type(exc).__name__)

    def recover_protocol_state(self) -> list[str]:
        """After a restart every open command is closed; nothing is republished or restored."""
        if self.protocol is None:
            return []
        closed = self.protocol.store.close_open_commands_after_restart()
        if closed:
            self.log_event("WARNING", "protocol_commands_closed_after_restart", count=len(closed))
        return closed

    def set_armed(self, armed: bool, *, origin: str = "unknown") -> None:
        """Set the Core operational safety gate."""
        previous = self.status.armed
        current = "ARMED" if armed else "DISARMED"
        self.status.armed = current
        self.status.write(self.settings.status_path)
        if previous != current:
            self.log_event(
                "INFO",
                "operational_mode_changed",
                previous=previous,
                current=current,
                origin=origin,
            )

    def _on_connection(self, connected: bool) -> None:
        self.mqtt.is_connected = connected
        self.status.broker = "CONNECTED" if connected else "DISCONNECTED"
        # Persist immediately so status.json converges with the live broker
        # state instead of waiting for the next health-loop pass. RuntimeStatus.write
        # serializes snapshot+replace under a lock, so this MQTT-thread write cannot
        # be overtaken by an older supervisor-loop snapshot.
        try:
            self.status.write(self.settings.status_path)
        except OSError as exc:
            self.log_event("WARNING", "broker_status_persist_failed", error=type(exc).__name__)

    def _on_status(self, state, rssi, heap, command_nonce="") -> None:
        with self._command_lock:
            self._handle_status(state, rssi, heap, command_nonce)

    def _refresh_device_presence(self, now: float) -> None:
        """Report a lost device as OFFLINE with an UNKNOWN uplink instead of keeping the last reported values.

        ``device_online()`` (no authenticated device message for DEVICE_OFFLINE_SEC) is the only input. The next authenticated
        status restores both fields in ``_handle_status``. This only changes what is reported; it sends nothing to the device.
        """
        if self.settings.dry_run:
            return
        with self._command_lock:
            if self.mqtt.device_online():
                return
            if not self._device_seen and now - self.started_at <= self.settings.device_wait_sec:
                return   # still waiting for the first status after the Core started: UNKNOWN, not OFFLINE
            if self.status.device != "OFFLINE" or self.status.uplink != "UNKNOWN":
                self.log_event("WARNING", "device_offline", previous_device=self.status.device,
                               previous_uplink=self.status.uplink, timeout_sec=config.DEVICE_OFFLINE_SEC)
            self.status.device = "OFFLINE"
            self.status.uplink = "UNKNOWN"

    def _handle_status(self, state, rssi, heap, command_nonce="") -> None:
        if self.status.device == "OFFLINE":
            self.log_event("INFO", "device_online", reported_state=state)
        self._device_seen = True
        self.status.device = "ONLINE"
        if state in {"NORMAL", "LOCKDOWN"}:
            self.status.uplink = state
        if state == "NORMAL" and self.graduated is not None and self.graduated.auto_cut_latched:
            # Only an operator RESTORE brings the device back to NORMAL; that ends the lockdown episode.
            self.graduated.reset_episode()
            self.log_event("INFO", "graduated_episode_reset", reason="device_normal")

        physical = self.awaiting_physical_confirmation

        if (
            physical
            and state in ("NORMAL", "LOCKDOWN")
            and command_nonce
            and command_nonce == physical.get("nonce")
        ):
            physical["observed_state"] = state
            if state == physical["expected_state"]:
                physical["physical_confirmed_at"] = self.monotonic()
            if self.dispatch_worker is not None:
                self.dispatch_worker.on_status(state, command_nonce)

        elif physical and state in ("NORMAL", "LOCKDOWN"):
            self.log_event(
                "WARNING",
                "physical_status_ignored",
                reason=(
                    "missing_command_nonce"
                    if not command_nonce
                    else "command_nonce_mismatch"
                ),
                state=state,
                command_nonce=command_nonce,
                expected_nonce=physical.get("nonce"),
            )

        self.log_event(
            "INFO",
            "device_status",
            state=state,
            rssi=rssi,
            heap=heap,
            command_nonce=command_nonce,
        )

    def _on_ack(self, ack, detail, nonce) -> None:
        with self._command_lock:
            self._handle_ack(ack, detail, nonce)

    def _handle_ack(self, ack, detail, nonce) -> None:
        if not self.pending_command:
            self.log_event(
                "WARNING",
                "device_ack_ignored",
                reason="no_pending_command",
                ack=ack,
                detail=detail,
                nonce=nonce,
            )
            return

        expected_nonce = self.pending_command.get("nonce")
        if not nonce or nonce != expected_nonce:
            self.log_event(
                "WARNING",
                "device_ack_ignored",
                reason="missing_nonce" if not nonce else "nonce_mismatch",
                ack=ack,
                detail=detail,
                nonce=nonce,
                expected_nonce=expected_nonce,
            )
            return

        acknowledged_command = dict(self.pending_command)
        self.pending_command = None
        self.ack_timed_out = ack != "OK"

        if ack == "OK":
            physical = self.awaiting_physical_confirmation
            if (
                physical
                and physical.get("nonce") == acknowledged_command["nonce"]
            ):
                physical["acknowledged_at"] = self.monotonic()

        self.log_event(
            "INFO" if ack == "OK" else "WARNING",
            "device_ack",
            ack=ack,
            detail=detail,
            nonce=nonce,
        )
        if self.dispatch_worker is not None:
            self.dispatch_worker.on_ack(ack, nonce)
        self._drain_deferred_cut_locked()

    def _on_attacker(self, ip: str) -> None:
        try:
            safe_ip = str(ipaddress.ip_address(ip))
        except ValueError:
            self.log_event("WARNING", "invalid_attacker_ip", value=str(ip)[:64])
            return
        self.log_event("WARNING", "detector_alert", attacker_ip=safe_ip)
        try:  # Core-owned R1: record the incident from a validated alert; never contains or cuts by itself
            self.recovery.bind_incident(safe_ip)
        except Exception as error:
            self.log_event("ERROR", "incident_bind_failed", error=type(error).__name__)
        if not self.settings.auto_contain:
            return
        if self.status.armed != "ARMED":
            self.log_event(
                "WARNING",
                "auto_containment_blocked",
                reason="system_disarmed",
                attacker_ip=safe_ip,
            )
            return
        # A generic detector alert is HIGH, not CRITICAL: it earns a reversible
        # software block only. Physical CUT stays on the explicit CRITICAL path.
        self._software_contain(safe_ip)

    def _software_contain(self, ip: str) -> bool | None:
        """True: the helper confirmed the address is blocked. False: the block failed. None: dry run."""
        if self.settings.dry_run:
            self.log_event("INFO", "software_containment_noop", attacker_ip=ip, reason_code="DRY_RUN")
            return None
        try:
            response = self.containment.block(ip)
        except ContainmentUnavailable:
            self.log_event("ERROR", "software_containment_failed", attacker_ip=ip, reason_code="HELPER_UNAVAILABLE")
            return False
        reason_code = str(response.get("reason_code", "UNKNOWN"))[:64]
        confirmed = (
            response.get("ok") is True
            and response.get("operation") == "block"
            and response.get("ip") == ip
        )
        if not confirmed:
            self.log_event("ERROR", "software_containment_failed", attacker_ip=ip, reason_code=reason_code)
            return False
        if response.get("changed") is True:
            self.log_event("CRITICAL", "software_containment_success", attacker_ip=ip, reason_code=reason_code)
        else:
            self.log_event("INFO", "software_containment_noop", attacker_ip=ip, reason_code=reason_code)
        return True

    def bind_callbacks(self) -> None:
        self.mqtt.connection_callback = self._on_connection
        self.mqtt.status_callback = self._on_status
        self.mqtt.authenticated_status_callback = self._on_authenticated_status
        self.mqtt.ack_callback = self._on_ack
        self.mqtt.attacker_callback = self._on_attacker

    def start_local_restore(self) -> None:
        if self.local_restore is not None or self.restore_credential is None:
            return
        gate = lr.LocalRestoreGate(
            self,
            self.restore_credential,
            allowed_uid=os.geteuid(),
            audit=db.log_event,
            audit_strict=db.log_event_strict,
            monotonic=self.monotonic,
            incident_lookup=db.get_open_incident,
            attempt_lookup=db.restore_attempt_exists,
            # Production only: a non-production Core cannot satisfy the Recovery gates (they refuse NOT_PRODUCTION), so the
            # lab D4 gate keeps its original behaviour. In production the policy is mandatory (see issue_command).
            precondition_lookup=(
                self.recovery.restore_precondition_unmet if self.settings.profile == "production" else None
            ),
            # OD-R5-BG-01 break-glass: production only, with the same recovery service and the process-local fresh proof.
            break_glass_lookup=self.recovery.break_glass_unmet if self.settings.profile == "production" else None,
            episode_lookup=self.fresh_lockdown_episode if self.settings.profile == "production" else None,
        )
        server = lr.LocalRestoreServer(self.settings.runtime_dir / lr.CHANNEL_NAME, gate)
        server.start()
        self.local_restore = server

    def start_local_cut(self) -> None:
        """Optional manual-CUT channel. INERT unless explicitly enabled and fully configured; it never blocks or fails the Core."""
        if self.local_cut is not None or not local_cut.enabled(config.LOCAL_CUT_ENABLED) or not lr.local_restore_supported():
            return
        operator_uid = config.LOCAL_CUT_OPERATOR_UID
        if operator_uid is None or operator_uid == 0 or not config.LOCAL_CUT_SOCKET:
            self.log_event("ERROR", "local_cut_unconfigured", reason="OPERATOR_UID_OR_SOCKET_MISSING_OR_ROOT")
            return
        credential = self._load_local_cut_credential()
        if credential is None:
            return
        gate = local_cut.LocalCutGate(
            self, allowed_uid=operator_uid, credential=credential, audit=db.log_event, audit_strict=db.log_event_strict,
            monotonic=self.monotonic,
        )
        try:
            server = local_cut.LocalCutServer(config.LOCAL_CUT_SOCKET, gate, socket_gid=config.LOCAL_CUT_SOCKET_GID)
            server.start()
        except (lr.LocalRestoreError, OSError) as error:
            self.log_event("ERROR", "local_cut_failed", error=type(error).__name__)
            return
        self.local_cut = server

    def _load_local_cut_credential(self):
        """The Core-held CUT credential, or None (channel stays down). Fail closed; never the D4 RESTORE credential."""
        path = config.LOCAL_CUT_CREDENTIAL_FILE
        if not path:
            self.log_event("ERROR", "local_cut_unconfigured", reason="CUT_CREDENTIAL_MISSING")
            return None
        if config.RESTORE_CREDENTIAL_FILE and os.path.realpath(path) == os.path.realpath(config.RESTORE_CREDENTIAL_FILE):
            self.log_event("ERROR", "local_cut_unconfigured", reason="CUT_CREDENTIAL_IS_RESTORE_CREDENTIAL_FILE")
            return None
        try:
            credential = lr.RestoreCredential.load(path)
        except lr.CredentialError:
            self.log_event("ERROR", "local_cut_unconfigured", reason="CUT_CREDENTIAL_UNUSABLE")
            return None
        if not local_cut.credentials_are_distinct(credential, self.restore_credential):
            self.log_event("ERROR", "local_cut_unconfigured", reason="CUT_CREDENTIAL_EQUALS_RESTORE_CREDENTIAL")
            return None
        return credential

    def stop_local_cut(self) -> None:
        server, self.local_cut = self.local_cut, None
        if server is not None:
            server.close()

    def stop_local_restore(self) -> None:
        server, self.local_restore = self.local_restore, None
        if server is not None:
            server.close()

    def start_recovery(self) -> None:
        """Start the Core-owned Recovery AF_UNIX channel. Optional: it never blocks or fails the Core."""
        if self.recovery_server is not None:
            return
        operator_uid = config.RECOVERY_OPERATOR_UID
        if self.settings.profile != "production" or operator_uid is None or not lr.local_restore_supported():
            self.log_event("INFO", "recovery_channel_disabled", profile=self.settings.profile)
            return
        server = rc.RecoveryServer(
            config.RECOVERY_SOCKET or rp.DEFAULT_SOCKET_PATH,
            self.recovery,
            allowed_uid=operator_uid,
            socket_gid=config.RECOVERY_SOCKET_GID,
        )
        try:
            server.start()
        except (rc.RecoveryChannelError, OSError) as error:
            self.log_event("ERROR", "recovery_channel_failed", error=type(error).__name__)
            return
        self.recovery_server = server

    def stop_recovery(self) -> None:
        server, self.recovery_server = self.recovery_server, None
        if server is not None:
            server.close()

    def start_historical_disposition(self) -> None:
        """R1D: the dedicated, root-only, one-shot historical-incident disposition channel. INERT by default (exact flag, production,
        configured detector authority) and never started once a disposition exists. Optional: it never blocks or fails the Core."""
        if self.historical_server is not None:
            return
        if not hd.enabled(self.settings.profile, enabled_flag=config.R1D_DISPOSITION_ENABLED) or not lr.local_restore_supported():
            return
        if config.ALERT_SOURCE_UID is None:
            self.log_event("ERROR", "historical_disposition_failed", error="DETECTOR_AUTHORITY_UNCONFIGURED")
            return
        if hd.disposition_exists() or hd.attempt_exists() or hd.marker_present():
            self.log_event("INFO", "historical_disposition_closed", reason="ALREADY_DISPOSED_OR_ATTEMPTED")
            return
        server = hd.HistoricalDispositionServer(
            self.settings.runtime_dir / hd.CHANNEL_NAME,
            hd.HistoricalDispositionService(profile=self.settings.profile, detector_uid=config.ALERT_SOURCE_UID),
            allowed_uid=0,
        )
        try:
            server.start()
        except (hd.DispositionChannelError, OSError) as error:
            self.log_event("ERROR", "historical_disposition_failed", error=type(error).__name__)
            return
        self.historical_server = server

    def stop_historical_disposition(self) -> None:
        server, self.historical_server = self.historical_server, None
        if server is not None:
            server.close()

    def on_production_alert(self, ip: str, kind: str | None = None) -> dict:
        """R1: record the validated attacker candidate as the bound incident.

        With the graduated response disabled (the default) that is all it does: it never acts on the host. With
        ``AEGIS_GRADUATED_RESPONSE=YES`` the evidence is also handed to the graduated response, which alone decides any
        block, recommendation or CUT (see ``_graduated_observe``)."""
        result = self.recovery.bind_incident(ip)
        self.log_event("WARNING", "production_alert", attacker_ip=ip, action=str(result.get("action")))
        if self.graduated is None or result.get("action") == "REFUSED":
            return result
        lab_scoring = self.settings.profile == "lab" and config.lab_alert_ingress_enabled()
        if self.settings.profile != "production" and not lab_scoring:
            return result  # development, or a lab Core without the explicit lab flag: nothing is scored
        try:
            self._graduated_observe(ip, kind or gr.GENERIC)
        except Exception as error:  # the R1 binding already happened; a response failure must not misreport it
            self.log_event("ERROR", "graduated_response_failed", attacker_ip=ip, error=type(error).__name__)
        if result.get("action") == "SKIPPED" and lab_scoring:
            return {"action": "OBSERVED"}
        return result

    # -- IDEA3 graduated response (inert unless AEGIS_GRADUATED_RESPONSE=YES) -------------------------------------------
    def _graduated_observe(self, ip: str, kind: str) -> None:
        try:
            decision = self.graduated.observe(ip, kind)
        except ValueError:
            self.log_event("WARNING", "graduated_evidence_refused", attacker_ip=ip, kind=str(kind)[:32])
            return
        self._graduated_act(decision)

    def _graduated_act(self, decision: gr.Decision) -> None:
        detail = {
            "attacker_ip": decision.address, "kind": decision.kind, "severity": decision.level,
            "previous_severity": decision.previous_level, "score": decision.score, "action": decision.action,
            "corroborated": decision.corroborated, "reasons": ",".join(decision.reasons), "mitre": ",".join(decision.mitre),
        }
        self.log_event("WARNING" if decision.level in (gr.LOW, gr.MEDIUM) else "CRITICAL", "graduated_decision", **detail)
        try:
            db.log_event(
                "GRADUATED_" + decision.level,
                " ".join(f"{key}={value}" for key, value in detail.items()),
                db.CRITICAL if decision.level == gr.CRITICAL else db.WARN,
            )
        except Exception as error:
            self.log_event("ERROR", "graduated_audit_failed", error=type(error).__name__)
        if decision.action == gr.NONE:
            self._graduated_record(decision, None)
            return
        outcome = None
        follow_up = None
        if decision.action in (gr.SOFTWARE_BLOCK, gr.RECOMMEND_CUT, gr.AUTO_CUT):
            # Every escalation first makes sure the address is blocked in software (idempotent in the helper).
            contained = self._software_contain(decision.address)
            if contained is not None:
                follow_up = self.graduated.containment_result(decision.address, confirmed=contained)
            if decision.action == gr.SOFTWARE_BLOCK:
                outcome = {True: "BLOCKED", False: "BLOCK_FAILED", None: "DRY_RUN"}[contained]
        if decision.action == gr.RECOMMEND_CUT:
            outcome = "RECOMMENDED"
            self.log_event("CRITICAL", "graduated_cut_recommended", attacker_ip=decision.address, score=decision.score)
        elif decision.action == gr.AUTO_CUT:
            outcome = self._graduated_cut(decision)
        self._graduated_notify(decision, outcome)
        self._graduated_record(decision, outcome)
        if follow_up is not None and follow_up.escalated:
            self._graduated_act(follow_up)

    def _graduated_cut(self, decision: gr.Decision) -> str:
        """The only automatic physical action: one CUT_UPLINK per lockdown episode, through the normal Core command path."""
        if self.settings.dry_run:
            self.log_event("INFO", "graduated_cut_noop", attacker_ip=decision.address, reason_code="DRY_RUN")
            return "DRY_RUN"
        if self.status.armed != "ARMED":
            self.log_event("WARNING", "graduated_cut_blocked", attacker_ip=decision.address, reason="system_disarmed")
            return "CUT_DISARMED"
        description = (
            f"graduated response CRITICAL attacker={decision.address} score={decision.score} "
            f"reasons={','.join(decision.reasons)}"
        )[:240]
        result = self.issue_command("CUT_UPLINK", description, critical=True, origin="graduated-response")
        sent = bool(getattr(result, "ok", False) and getattr(result, "sent", False))
        self.log_event(
            "CRITICAL" if sent else "ERROR", "graduated_cut_issued" if sent else "graduated_cut_refused",
            attacker_ip=decision.address, reason_code=str(getattr(result, "reason_code", "") or "")[:64],
        )
        if sent:
            return "CUT_SENT"
        return "CUT_QUEUED" if getattr(result, "reason_code", None) == "CUT_QUEUED" else "CUT_REFUSED"

    def recovery_view_path(self) -> Path:
        return self.settings.runtime_dir / recovery_view.VIEW_NAME

    def write_recovery_view(self) -> None:
        """Write the bounded RESTORE-readiness projection for the Desktop. Best effort: it never affects the Core."""
        try:
            with self._command_lock:
                gate = self.local_restore.gate if self.local_restore is not None else None
                payload = recovery_view.build(self, gate)
            path = self.recovery_view_path()
            path.parent.mkdir(parents=True, exist_ok=True)
            fd, temporary = tempfile.mkstemp(prefix="recovery-", suffix=".tmp", dir=path.parent)
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as handle:
                    json.dump(payload, handle, ensure_ascii=False, sort_keys=True)
                    handle.write("\n")
                os.chmod(temporary, 0o640)
                os.replace(temporary, path)
            finally:
                if os.path.exists(temporary):
                    os.unlink(temporary)
        except OSError as error:
            if not self._recovery_view_failed:
                self._recovery_view_failed = True
                self.log_event("WARNING", "recovery_view_write_failed", error=type(error).__name__)

    def graduated_status_path(self) -> Path:
        configured = config.GRADUATED_STATUS_PATH
        return Path(configured) if configured else self.settings.runtime_dir / "graduated-status.json"

    def _graduated_record(self, decision: gr.Decision, outcome: str | None) -> None:
        """Bounded, read-only projection for the Desktop: the last decisions and whether a CUT is recommended or latched.

        Display data only (no secret, no command, nothing the Core reads back). Atomic replace, mode 0640; best effort."""
        self._graduated_history.append({
            "at": time.time(), "attacker_ip": decision.address, "kind": decision.kind, "level": decision.level,
            "action": decision.action, "outcome": outcome or "", "score": decision.score,
            "corroborated": decision.corroborated, "reasons": list(decision.reasons), "mitre": list(decision.mitre),
        })
        history = list(self._graduated_history)
        recommended = next((item for item in reversed(history) if item["action"] == gr.RECOMMEND_CUT), None)
        payload = {
            "v": 1,
            "updated_at": time.time(),
            "auto_cut_latched": self.graduated.auto_cut_latched if self.graduated is not None else False,
            "highest_level": max((item["level"] for item in history), key=gr.LEVEL_ORDER.index, default=gr.LOW),
            "cut_recommended_for": recommended["attacker_ip"] if recommended else None,
            "decisions": history,
        }
        path = self.graduated_status_path()
        with self._graduated_write_lock:
            try:
                path.parent.mkdir(parents=True, exist_ok=True)
                fd, temporary = tempfile.mkstemp(prefix="graduated-", suffix=".tmp", dir=path.parent)
                try:
                    with os.fdopen(fd, "w", encoding="utf-8") as handle:
                        json.dump(payload, handle, ensure_ascii=False, sort_keys=True)
                        handle.write("\n")
                    os.chmod(temporary, 0o640)
                    os.replace(temporary, path)
                finally:
                    if os.path.exists(temporary):
                        os.unlink(temporary)
            except OSError as error:
                self.log_event("WARNING", "graduated_status_write_failed", error=type(error).__name__)

    def _graduated_notify(self, decision: gr.Decision, outcome: str | None) -> None:
        from . import comms  # notification only; never on the command path and never awaited

        try:
            comms.send_severity_alert(
                level=decision.level, action=decision.action, outcome=outcome or "", address=decision.address,
                score=decision.score, reasons=decision.reasons, mitre=decision.mitre,
            )
        except Exception:
            self.log_event("WARNING", "graduated_notify_failed")

    def start_alert_ingress(self) -> None:
        """Start the Core-local alert ingress (the production R1 source). Optional: it never blocks or fails the Core."""
        if self.alert_server is not None:
            return
        source_uid = config.ALERT_SOURCE_UID
        profile_allowed = self.settings.profile == "production" or (
            self.settings.profile == "lab" and config.lab_alert_ingress_enabled()
        )
        if not profile_allowed or source_uid is None or not lr.local_restore_supported():
            self.log_event("INFO", "alert_ingress_disabled", profile=self.settings.profile)
            return
        if source_uid == 0 or source_uid == os.geteuid():
            # The detector is a dedicated non-root account that is not the Core: root and the Core uid never author alerts.
            self.log_event("ERROR", "alert_ingress_failed", error="SOURCE_UID_NOT_DEDICATED")
            return
        import grp  # POSIX only; reached only after lr.local_restore_supported()

        try:
            alert_gid = grp.getgrnam(config.ALERT_GROUP).gr_gid
        except KeyError:
            self.log_event("ERROR", "alert_ingress_failed", error="ALERT_GROUP_UNRESOLVED")
            return
        # The reviewed R1 ingress, or (graduated response enabled) its version-2 subclass; peer and rate checks are shared.
        ingress_class = rc.AlertIngress if self.graduated is None else gi.GraduatedAlertIngress
        server = rc.AlertServer(
            config.alert_socket_path(self.settings.profile),
            ingress_class(self.on_production_alert),
            allowed_uid=source_uid,
            socket_gid=alert_gid,
        )
        try:
            server.start()
        except (rc.RecoveryChannelError, OSError) as error:
            self.log_event("ERROR", "alert_ingress_failed", error=type(error).__name__)
            return
        self.alert_server = server

    def stop_alert_ingress(self) -> None:
        server, self.alert_server = self.alert_server, None
        if server is not None:
            server.close()

    def _tick_dispatch(self) -> None:
        if self.dispatch_worker is None:
            self.status.dispatch = DISABLED
            return
        self.dispatch_worker.tick()
        candidate = getattr(self.dispatch_worker, "status", "UNKNOWN")
        self.status.dispatch = (
            candidate
            if candidate in {ACTIVE, DISABLED, PAUSED_CREDENTIAL, UNAVAILABLE}
            else "UNKNOWN"
        )

    def evaluate_state(self, now: float | None = None) -> RuntimeState:
        now = self.monotonic() if now is None else now
        if self.stop_requested:
            return RuntimeState.SHUTDOWN
        with self._command_lock:
            if (self.pending_command
                    and now - self.pending_command["sent_at"] > config.ACK_TIMEOUT_SEC):
                action = self.pending_command["action"]
                self.pending_command = None
                self.ack_timed_out = True
                self.log_event("ERROR", "command_ack_timeout", action=action,
                               timeout_sec=config.ACK_TIMEOUT_SEC)
                self._drain_deferred_cut_locked()
        physical = self.awaiting_physical_confirmation
        if (
            physical
            and physical.get("acknowledged_at") is not None
            and physical.get("physical_confirmed_at") is None
            and physical.get("physical_timeout_at") is None
            and now - physical["acknowledged_at"]
            > config.PHYSICAL_CONFIRM_TIMEOUT_SEC
        ):
            physical["physical_timeout_at"] = now
            self.log_event(
                "ERROR",
                "physical_confirmation_timeout",
                action=physical["action"],
                nonce=physical["nonce"],
                expected_state=physical["expected_state"],
                observed_state=physical["observed_state"],
                timeout_sec=config.PHYSICAL_CONFIRM_TIMEOUT_SEC,
            )

        if self.status.uplink == "LOCKDOWN":
            return RuntimeState.LOCKDOWN
        if self.status.dispatch in {PAUSED_CREDENTIAL, UNAVAILABLE}:
            return RuntimeState.DEGRADED
        if any(state == "FAILED" for state in self.status.components.values()):
            return RuntimeState.DEGRADED
        if self.ack_timed_out:
            return RuntimeState.DEGRADED
        if (
            physical
            and physical.get("physical_timeout_at") is not None
            and physical.get("physical_confirmed_at") is None
        ):
            return RuntimeState.DEGRADED
        if self.settings.dry_run:
            return RuntimeState.RUNNING
        if self._protocol_active() and not self.protocol_time_trusted():
            return RuntimeState.DEGRADED
        if not self.mqtt.is_connected:
            return (RuntimeState.WAIT_BROKER if now - self.started_at <= self.settings.broker_wait_sec
                    else RuntimeState.DEGRADED)
        if not self.mqtt.device_online():
            return (RuntimeState.WAIT_DEVICE if now - self.started_at <= self.settings.device_wait_sec
                    else RuntimeState.DEGRADED)
        if self.status.uplink == "UNKNOWN":
            return (RuntimeState.WAIT_DEVICE if now - self.started_at <= self.settings.device_wait_sec
                    else RuntimeState.DEGRADED)
        return RuntimeState.RUNNING

    def _request_stop(self, signum=None, frame=None) -> None:
        self.stop_requested = True
        self._stop_event.set()

    def run(self) -> int:
        try:
            self.instance_lock.acquire()
        except AlreadyRunningError as exc:
            print(str(exc), file=sys.stderr)
            return 2

        try:
            signal.signal(signal.SIGINT, self._request_stop)
            signal.signal(signal.SIGTERM, self._request_stop)
            self.transition(RuntimeState.PREFLIGHT, "validating runtime configuration")
            errors, warnings = self.settings.preflight(protocol_configured=self.protocol)
            for warning in warnings:
                self.log_event("WARNING", "preflight_warning", message=warning)
            if errors:
                self.status.components = {"preflight": "FAILED"}
                self.transition(RuntimeState.FAILED, "; ".join(errors))
                return 2

            db.init_db()
            self.bind_callbacks()
            self.recover_protocol_state()
            self.start_local_restore()
            self.start_local_cut()
            self.start_recovery()
            self.start_alert_ingress()
            self.start_historical_disposition()
            if self.dispatch_worker is not None:
                self.dispatch_worker.start()
            if not self.settings.dry_run:
                self.mqtt.start()
            self.children.start_all()
            self.log_event("INFO", "supervisor_started", profile=self.settings.profile,
                           dry_run=self.settings.dry_run)

            while not self.stop_requested:
                now = self.monotonic()
                self._refresh_protocol_state()
                self._refresh_device_presence(now)
                if (now - self.last_heartbeat_at >= config.HEARTBEAT_INTERVAL_SEC
                        and self.controller.send_heartbeat()):
                    self.last_heartbeat_at = now
                self.status.components = self.children.poll(now)
                self._tick_dispatch()
                state = self.evaluate_state(now)
                self.write_recovery_view()
                detail = (
                    "safe dry-run active"
                    if state == RuntimeState.RUNNING and self.settings.dry_run
                    else STATE_DETAIL.get(state, "supervisor stopping")
                )
                self.transition(state, detail)
                self._stop_event.wait(self.settings.health_interval)
            return 0
        except Exception as exc:
            self.log_event("ERROR", "supervisor_failure", error=type(exc).__name__, message=str(exc))
            self.transition(RuntimeState.FAILED, f"supervisor failure: {type(exc).__name__}")
            return 1
        finally:
            self.stop_requested = True
            self.stop_historical_disposition()
            self.stop_alert_ingress()
            self.stop_recovery()
            self.stop_local_cut()
            self.stop_local_restore()
            self.children.stop_all()
            self.mqtt.stop()
            if self.dispatch_worker is not None:
                self.dispatch_worker.close()
            if self.protocol is not None:
                self.protocol.store.close()
            # Deliberately no RESTORE_UPLINK on any shutdown path.
            if self.status.state != RuntimeState.FAILED:
                self.transition(RuntimeState.SHUTDOWN, "supervisor stopped; uplink state unchanged")
            self.instance_lock.release()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="AEGIS autonomous supervisor")
    parser.add_argument("--profile", choices=("development", "lab", "production"), default="development")
    parser.add_argument("--dry-run", action="store_true", default=None)
    parser.add_argument("--live", action="store_false", dest="dry_run")
    parser.add_argument("--gui", action="store_true", default=None)
    parser.add_argument("--headless", action="store_false", dest="gui")
    parser.add_argument("--detector", action="store_true", default=None)
    parser.add_argument("--no-detector", action="store_false", dest="detector")
    parser.add_argument("--voice", action="store_true", default=None)
    parser.add_argument("--no-voice", action="store_false", dest="voice")
    return parser


def settings_from_args(args) -> RuntimeSettings:
    return RuntimeSettings.from_profile(
        args.profile,
        dry_run=args.dry_run,
        start_gui=args.gui,
        start_detector=args.detector,
        voice_enabled=args.voice,
    )


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    return AegisSupervisor(settings_from_args(args)).run()


if __name__ == "__main__":
    raise SystemExit(main())
