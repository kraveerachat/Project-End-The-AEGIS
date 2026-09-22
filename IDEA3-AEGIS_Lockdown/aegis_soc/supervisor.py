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
import threading
import time
from collections import deque
from contextlib import contextmanager
from dataclasses import dataclass, field
from logging.handlers import RotatingFileHandler
from pathlib import Path

from . import config
from . import database as db
from . import local_restore as lr
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
        self._command_lock = threading.RLock()
        self._containment_count_lock = threading.Lock()
        self._containment_count = 0
        self._containment_pending = threading.Event()
        self._deferred_cut = None
        self.monotonic = monotonic
        self.started_at = monotonic()
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

    def issue_command(
        self,
        action: str,
        description: str,
        *,
        critical: bool = False,
        origin: str = "unknown",
        authorize_restore: bool = False,
        not_after: float | None = None,
    ):
        """Issue a physical command and let Core own pending-ACK state."""
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

    def _on_status(self, state, rssi, heap, command_nonce="") -> None:
        with self._command_lock:
            self._handle_status(state, rssi, heap, command_nonce)

    def _handle_status(self, state, rssi, heap, command_nonce="") -> None:
        self.status.device = "ONLINE"
        if state in {"NORMAL", "LOCKDOWN"}:
            self.status.uplink = state

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

    def _software_contain(self, ip: str) -> None:
        if self.settings.dry_run:
            self.log_event("INFO", "software_containment_noop", attacker_ip=ip, reason_code="DRY_RUN")
            return
        try:
            response = self.containment.block(ip)
        except ContainmentUnavailable:
            self.log_event("ERROR", "software_containment_failed", attacker_ip=ip, reason_code="HELPER_UNAVAILABLE")
            return
        reason_code = str(response.get("reason_code", "UNKNOWN"))[:64]
        confirmed = (
            response.get("ok") is True
            and response.get("operation") == "block"
            and response.get("ip") == ip
        )
        if not confirmed:
            self.log_event("ERROR", "software_containment_failed", attacker_ip=ip, reason_code=reason_code)
        elif response.get("changed") is True:
            self.log_event("CRITICAL", "software_containment_success", attacker_ip=ip, reason_code=reason_code)
        else:
            self.log_event("INFO", "software_containment_noop", attacker_ip=ip, reason_code=reason_code)

    def bind_callbacks(self) -> None:
        self.mqtt.connection_callback = self._on_connection
        self.mqtt.status_callback = self._on_status
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
        )
        server = lr.LocalRestoreServer(self.settings.runtime_dir / lr.CHANNEL_NAME, gate)
        server.start()
        self.local_restore = server

    def stop_local_restore(self) -> None:
        server, self.local_restore = self.local_restore, None
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
                if (now - self.last_heartbeat_at >= config.HEARTBEAT_INTERVAL_SEC
                        and self.controller.send_heartbeat()):
                    self.last_heartbeat_at = now
                self.status.components = self.children.poll(now)
                self._tick_dispatch()
                state = self.evaluate_state(now)
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
