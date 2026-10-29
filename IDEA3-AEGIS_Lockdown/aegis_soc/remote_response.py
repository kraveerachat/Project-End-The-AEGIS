"""IDEA3 remote alerts: scoring and the operator-confirmed CUT for a protected host that is NOT this one.

A verified ``RemoteAlert`` (see ``remote_alert``) is evidence about *another* machine. This module feeds it to the existing
``graduated_response.GraduatedResponse`` policy, one independent engine per source, so a remote source has its own tracks, its
own distributed-attack count and its own auto-CUT latch, and nothing a remote host sends can touch the local engine or the
local relay. Differences from the Core-local path, all deliberate:

* No software block: the attacked address belongs to a connection to the *remote* host, so a firewall rule on this Core host
  would be a false claim of containment. The decision is recorded with outcome ``REMOTE_HOST``.
* No automatic CUT, ever. A CRITICAL decision (score and corroboration, exactly as in the policy) only creates a *pending* CUT
  for that source. A CUT is sent to that source's relay target only by ``confirm_cut``, which an operator-authenticated Core
  path must call; nothing on the network can.
* A source's relay target is configured per source and defaults to ``NONE`` (refuses). ``DRYRUN`` records "would cut" for lab
  verification. ``LAB_RELAY`` maps the source onto the lab Core's single relay and is accepted for the lab profile only, so
  the lab relay is never reached by a remote source by accident.
* A remote host can only add evidence. There is no kind that lowers a level or releases a latched episode; ``release_episode``
  is an explicit operator call, never reachable from a message.
"""

from __future__ import annotations

import threading
from collections.abc import Callable, Mapping
from contextlib import nullcontext
from dataclasses import dataclass
from typing import NamedTuple

from . import graduated_response as gr
from . import remote_alert as ra

RELAY_NONE = "NONE"
RELAY_DRYRUN = "DRYRUN"
RELAY_LAB = "LAB_RELAY"
RELAY_MODES = (RELAY_NONE, RELAY_DRYRUN, RELAY_LAB)
LOCAL_SOURCE = "__local__"

OUTCOME_REMOTE_HOST = "REMOTE_HOST"
OUTCOME_RECOMMENDED = "RECOMMENDED"
OUTCOME_AWAITING_OPERATOR = "AWAITING_OPERATOR"


class RelayResult(NamedTuple):
    ok: bool
    code: str


class UnconfiguredRelayTarget:
    """The default: there is no relay for this source, so a confirmed CUT is refused rather than sent somewhere else."""

    name = RELAY_NONE

    def cut(self, description: str) -> RelayResult:
        return RelayResult(False, "NO_RELAY_TARGET")


class DryRunRelayTarget:
    """Lab verification only: records that a CUT *would* have been sent. Actuates nothing."""

    name = RELAY_DRYRUN

    def __init__(self) -> None:
        self.would_cut: list[str] = []

    def cut(self, description: str) -> RelayResult:
        self.would_cut.append(description)
        return RelayResult(True, "WOULD_CUT")


class CoreRelayTarget:
    """The Core's own relay, reached only after the shared confirmation gate accepts a pending CUT."""

    name = RELAY_LAB

    def __init__(self, issue_command: Callable, source: str, *, origin: str | None = None,
                 target_name: str | None = None, command_guard: Callable | None = None) -> None:
        self._issue = issue_command
        self._source = source
        self._origin = origin or f"remote-alert:{source}"
        self.name = target_name or RELAY_LAB
        self._command_guard = command_guard

    def confirmation_guard(self):
        """Acquire the Core command lock before the confirmation gate lock; dry-run targets need no outer lock."""
        return self._command_guard() if self._command_guard is not None else nullcontext()

    def cut(self, description: str) -> RelayResult:
        result = self._issue(
            "CUT_UPLINK", description[:240], critical=True, origin=self._origin, allow_defer=False,
        )
        sent = bool(getattr(result, "ok", False) and getattr(result, "sent", False))
        return RelayResult(sent, "CUT_SENT" if sent else str(getattr(result, "reason_code", "") or "CUT_REFUSED")[:64])


@dataclass(frozen=True)
class PendingCut:
    source: str
    address: str
    score: int
    reasons: tuple[str, ...]


class RemoteResponse:
    def __init__(self, *, sources, clock: Callable[[], float], targets: Mapping[str, object],
                 audit: Callable[[str, str, str], None], log: Callable[..., None],
                 record: Callable[[str, gr.Decision, str | None], None],
                 notify: Callable[[str, gr.Decision, str | None], None]) -> None:
        self._clock = clock
        self._engines: dict[str, gr.GraduatedResponse] = {}
        self._targets: dict[str, object] = {}
        self._audit_prefixes: dict[str, str] = {}
        self._pending: dict[str, PendingCut] = {}
        self._audit, self._log, self._record, self._notify = audit, log, record, notify
        self._lock = threading.RLock()
        for source in sources:
            self.register_source(source, target=targets.get(source))

    def register_source(self, source: str, *, target: object | None = None, audit_prefix: str = "REMOTE") -> None:
        """Add one independently-scored source to this confirmation gate without replacing existing pending requests."""
        with self._lock:
            if source in self._engines:
                raise ValueError("source already registered")
            self._engines[source] = gr.GraduatedResponse(clock=self._clock)
            self._targets[source] = target or UnconfiguredRelayTarget()
            self._audit_prefixes[source] = audit_prefix

    def unregister_source(self, source: str) -> None:
        """Remove a source whose optional ingress failed to start; other sources and pending requests are untouched."""
        with self._lock:
            self._engines.pop(source, None)
            self._targets.pop(source, None)
            self._audit_prefixes.pop(source, None)
            self._pending.pop(source, None)

    def request_cut(self, source: str, address: str, score: int, reasons: tuple[str, ...]) -> PendingCut:
        """Create or replace the pending CUT for a registered source. This method never actuates a target."""
        with self._lock:
            if source not in self._targets:
                raise ValueError("unknown source")
            pending = PendingCut(source, address, score, reasons)
            self._pending[source] = pending
            return pending

    # -- evidence (called with a verified alert only) ---------------------------------------------------------------------
    def handle(self, alert: ra.RemoteAlert) -> gr.Decision:
        engine = self._engines.get(alert.source)
        if engine is None:
            raise ValueError("unknown remote source")
        with self._lock:
            decision = engine.observe(alert.attacker_ip, alert.kind)
            detail = (f"source={alert.source} attacker_ip={decision.address} kind={decision.kind} severity={decision.level} "
                      f"score={decision.score} action={decision.action} corroborated={decision.corroborated} "
                      f"reasons={','.join(decision.reasons)} cert_sha256={alert.cert_sha256[:16]}")
            self._audit("GRADUATED_" + decision.level, detail, "CRITICAL" if decision.level == gr.CRITICAL else "WARN")
            self._log("WARNING" if decision.level in (gr.LOW, gr.MEDIUM) else "CRITICAL", "remote_graduated_decision",
                      source=alert.source, attacker_ip=decision.address, severity=decision.level, action=decision.action)
            outcome = None
            if decision.action == gr.SOFTWARE_BLOCK:
                outcome = OUTCOME_REMOTE_HOST
            elif decision.action == gr.RECOMMEND_CUT:
                outcome = OUTCOME_RECOMMENDED
            elif decision.action == gr.AUTO_CUT:
                # The policy would cut automatically for a local source; for a remote one it only asks the operator.
                self.request_cut(alert.source, decision.address, decision.score, decision.reasons)
                outcome = OUTCOME_AWAITING_OPERATOR
                self._audit("REMOTE_CUT_AWAITING",
                            f"source={alert.source} attacker_ip={decision.address} target={self._targets[alert.source].name}", "CRITICAL")
            self._record(alert.source, decision, outcome)
            self._notify(alert.source, decision, outcome)
            return decision

    # -- operator-only ----------------------------------------------------------------------------------------------------
    def pending(self, source: str) -> PendingCut | None:
        with self._lock:
            return self._pending.get(source)

    def target_name(self, source: str) -> str:
        with self._lock:
            return self._targets[source].name

    def cancel_pending(self, source: str) -> None:
        """Invalidate a request when trusted state proves that its lockdown episode has ended."""
        with self._lock:
            self._pending.pop(source, None)

    def confirm_cut(self, source: str, address: str, *, operator: str) -> RelayResult:
        """Send the pending CUT for ``source`` to that source's relay target. Only an operator-authenticated Core path may call
        this; it requires a pending CRITICAL decision for exactly this address and never touches any other source's relay."""
        with self._lock:
            prefix = self._audit_prefixes.get(source, "REMOTE")
            if not isinstance(operator, str) or not operator.strip():
                self._audit(f"{prefix}_CUT_REFUSED", f"source={source} code=UNAUTHORIZED", "WARN")
                return RelayResult(False, "UNAUTHORIZED")
            target = self._targets.get(source)
            if target is None:
                self._audit(f"{prefix}_CUT_REFUSED", f"source={source} code=NO_PENDING_CUT operator={operator[:32]}", "WARN")
                return RelayResult(False, "NO_PENDING_CUT")

        guard = getattr(target, "confirmation_guard", nullcontext)
        with guard(), self._lock:
                pending = self._pending.get(source)
                if pending is None or pending.address != address or self._targets.get(source) is not target:
                    self._audit(f"{prefix}_CUT_REFUSED", f"source={source} code=NO_PENDING_CUT operator={operator[:32]}", "WARN")
                    return RelayResult(False, "NO_PENDING_CUT")
                description = (
                    f"remote alert CRITICAL source={source} attacker={pending.address} score={pending.score} "
                    f"operator={operator[:32]}"
                    if prefix == "REMOTE" else
                    f"graduated response CRITICAL attacker={pending.address} score={pending.score} "
                    f"reasons={','.join(pending.reasons)} operator={operator[:32]}"
                )
                result = target.cut(description)
                if result.ok:
                    del self._pending[source]
                    self._audit(f"{prefix}_CUT_CONFIRMED", f"source={source} attacker_ip={address} target={target.name} "
                                                            f"code={result.code} operator={operator[:32]}", "CRITICAL")
                else:
                    self._audit(f"{prefix}_CUT_FAILED", f"source={source} target={target.name} code={result.code} "
                                                         f"operator={operator[:32]}", "ERROR")
                return result

    def release_episode(self, source: str, *, operator: str) -> None:
        """After the operator has recovered: the next CRITICAL for this source may ask for a CUT again."""
        with self._lock:
            self._engines[source].reset_episode()
            self._pending.pop(source, None)
            self._audit("REMOTE_EPISODE_RELEASED", f"source={source} operator={operator[:32]}", "INFO")

    # -- introspection (tests, status) ------------------------------------------------------------------------------------
    def latched(self, source: str) -> bool:
        return self._engines[source].auto_cut_latched

    def level_of(self, source: str, address: str) -> str:
        return self._engines[source].level_of(address)
