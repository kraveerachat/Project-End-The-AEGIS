"""PR10 S2 Core-owned dispatch orchestration (design §5.2).

The worker pulls accepted CUT_UPLINK actions, but delegates the only command
side effect to ``AegisSupervisor.issue_command``. Its ledger writes precede
every remote claim or publish, and no failure path retries an action.
"""

from __future__ import annotations

import os
import time
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import TYPE_CHECKING

from . import config
from .dispatch_client import (
    DispatchClient,
    DispatchUnavailable,
    build_client_ssl_context,
    credential_files_available,
    urllib_transport,
)
from .dispatch_ledger import DispatchLedger

if TYPE_CHECKING:
    from .supervisor import AegisSupervisor

DISABLED = "DISABLED"
ACTIVE = "ACTIVE"
UNAVAILABLE = "UNAVAILABLE"
PAUSED_CREDENTIAL = "PAUSED_CREDENTIAL"


class DispatchWorker:
    """Join the dispatch client and ledger to the supervisor command owner."""

    def __init__(
        self,
        supervisor: AegisSupervisor,
        ledger: DispatchLedger,
        client,
        *,
        enabled: bool = True,
        credential_available: Callable[[], bool] = lambda: True,
        wall_clock: Callable[[], float] = time.time,
        poll_sec: float = 5.0,
        ack_timeout_sec: float = config.ACK_TIMEOUT_SEC,
        status_timeout_sec: float = config.PHYSICAL_CONFIRM_TIMEOUT_SEC,
    ) -> None:
        if poll_sec <= 0:
            raise ValueError("dispatch poll interval must be greater than zero")
        self.supervisor = supervisor
        self.ledger = ledger
        self.client = client
        self.enabled = enabled
        self._credential_available = credential_available
        self._clock = wall_clock
        self._poll_sec = poll_sec
        self._ack_timeout_sec = ack_timeout_sec
        self._status_timeout_sec = status_timeout_sec
        self._started = False
        self._next_poll_at = float("-inf")
        self.status = DISABLED if not enabled else ACTIVE

    def start(self) -> list[str]:
        """Recover unresolved pre-restart state exactly once, without publish."""
        if self._started or not self.enabled:
            return []
        self._started = True
        return self.ledger.recover_after_restart()

    def close(self) -> None:
        self.ledger.close()

    def _credentials_ready(self) -> bool:
        if not self._credential_available():
            self.status = PAUSED_CREDENTIAL
            return False
        self.status = ACTIVE
        return True

    def _handle_unavailable(self, error: DispatchUnavailable) -> None:
        self.status = PAUSED_CREDENTIAL if error.reason == "CREDENTIAL" else UNAVAILABLE

    def _deliver_outbox(self) -> bool:
        for row in self.ledger.pending_outbox():
            entry = {
                "sequence": row["sequence"],
                "stage": row["stage"],
                "observedAt": row["observed_at"],
                "detail": row["detail"],
            }
            try:
                result = self.client.report(row["action_id"], entry)
            except DispatchUnavailable as error:
                self._handle_unavailable(error)
                return False
            if result.status == "REJECTED":
                self.ledger.mark_outbox_rejected(row["id"])
            else:
                self.ledger.mark_outbox_delivered(row["id"])
        return True

    def tick(self) -> None:
        """Advance evidence and at most one new CUT_UPLINK action."""
        if not self.enabled:
            self.status = DISABLED
            return
        if not self._started:
            self.start()
        credentials_ready = self._credentials_ready()
        outbox_delivered = self._deliver_outbox() if credentials_ready else False
        # Timeouts are local safety decisions. They must advance even when the
        # remote evidence route or its credentials are unavailable.
        self.ledger.mark_stale_outcomes(
            ack_timeout_sec=self._ack_timeout_sec,
            status_timeout_sec=self._status_timeout_sec,
        )
        if not credentials_ready or not outbox_delivered:
            return
        if self.supervisor.status.armed != "ARMED":
            return
        if self.supervisor.pending_command is not None or self.ledger.in_flight():
            return

        now = self._clock()
        if now < self._next_poll_at:
            return
        self._next_poll_at = now + self._poll_sec
        try:
            actions = self.client.list_pending()
        except DispatchUnavailable as error:
            self._handle_unavailable(error)
            return

        action = next(
            (
                candidate
                for candidate in actions
                if candidate.action == "CUT_UPLINK" and candidate.expires_at > self._clock()
            ),
            None,
        )
        if action is None:
            return
        if not self.ledger.begin_claim(action.action_id, action.action, action.expires_at):
            return

        try:
            claim = self.client.claim(action.action_id)
        except DispatchUnavailable as error:
            self.ledger.mark_outcome_unknown(action.action_id, "CLAIM_UNCERTAIN")
            self._handle_unavailable(error)
            return
        if claim.status != "CLAIMED":
            self.ledger.mark_claim_rejected(action.action_id)
            return
        self.ledger.mark_claimed(action.action_id)

        deadline = action.expires_at
        if claim.expires_at is not None:
            deadline = min(deadline, claim.expires_at)
        if self._clock() >= deadline:
            self.ledger.mark_expired_at_core(action.action_id)
            return

        result = self.supervisor.issue_command(
            "CUT_UPLINK",
            f"server dispatch action {action.action_id}",
            critical=True,
            origin="server-dispatch",
        )
        if result.sent and result.nonce:
            self.ledger.mark_published(action.action_id, result.nonce)
        elif result.dry_run:
            self.ledger.mark_dry_run(action.action_id, result.nonce)
        else:
            self.ledger.mark_failed(action.action_id, "MQTT_UNAVAILABLE")

    def on_ack(self, ack: str, nonce: str) -> None:
        self.ledger.record_ack(nonce, ack)

    def on_status(self, state: str, nonce: str) -> None:
        self.ledger.record_status(nonce, state)


class _ConfiguredDispatchClient:
    """Reload the mTLS context per request so renewed credentials can resume."""

    def __init__(self, base_url: str, *, ca_file: object, cert_file: object, key_file: object):
        # Validate the URL without loading credentials or contacting a route.
        DispatchClient(base_url, lambda *_args: (500, b""))
        self._base_url = base_url
        self._ca_file = ca_file
        self._cert_file = cert_file
        self._key_file = key_file

    def _client(self) -> DispatchClient:
        context = build_client_ssl_context(
            ca_file=self._ca_file,
            cert_file=self._cert_file,
            key_file=self._key_file,
        )
        return DispatchClient(self._base_url, urllib_transport(context))

    def list_pending(self):
        return self._client().list_pending()

    def claim(self, action_id):
        return self._client().claim(action_id)

    def report(self, action_id, entry):
        return self._client().report(action_id, entry)


def _enabled(value: object) -> bool:
    normalized = str(value).strip().lower()
    if normalized in {"", "0", "false", "no", "off"}:
        return False
    if normalized in {"1", "true", "yes", "on"}:
        return True
    raise ValueError("AEGIS_CORE_DISPATCH_ENABLED must be a boolean")


def build_dispatch_worker_from_environment(
    supervisor: AegisSupervisor,
    *,
    env: Mapping[str, str] | None = None,
    wall_clock: Callable[[], float] = time.time,
) -> DispatchWorker | None:
    """Construct the optional worker; disabled is the safe default."""
    values = os.environ if env is None else env
    if not _enabled(values.get("AEGIS_CORE_DISPATCH_ENABLED", "0")):
        return None

    db_path = Path(values.get("AEGIS_CORE_DISPATCH_DB_PATH", ""))
    if not db_path.is_absolute():
        raise ValueError("AEGIS_CORE_DISPATCH_DB_PATH must be an absolute path when dispatch is enabled")
    poll_sec = float(values.get("AEGIS_CORE_DISPATCH_POLL_SEC", "5"))
    if poll_sec <= 0:
        raise ValueError("AEGIS_CORE_DISPATCH_POLL_SEC must be greater than zero")

    base_url = values.get("AEGIS_CORE_DISPATCH_BASE_URL", "")
    ca_file = values.get("AEGIS_CORE_DISPATCH_CA_FILE")
    cert_file = values.get("AEGIS_CORE_DISPATCH_CLIENT_CERT")
    key_file = values.get("AEGIS_CORE_DISPATCH_CLIENT_KEY")
    client = _ConfiguredDispatchClient(
        base_url,
        ca_file=ca_file,
        cert_file=cert_file,
        key_file=key_file,
    )
    credentials = lambda: credential_files_available(
        ca_file=ca_file,
        cert_file=cert_file,
        key_file=key_file,
    )
    return DispatchWorker(
        supervisor,
        DispatchLedger(db_path, wall_clock=wall_clock),
        client,
        credential_available=credentials,
        wall_clock=wall_clock,
        poll_sec=poll_sec,
    )
