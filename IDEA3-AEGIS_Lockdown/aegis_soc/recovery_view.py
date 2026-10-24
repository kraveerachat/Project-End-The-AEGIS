"""Bounded, read-only projection of the Core's RESTORE readiness for the control Desktop (``recovery-status.json``).

Display data only: no secret, no reason text, no command and nothing the Core reads back. It is written by the supervisor's health
loop next to ``status.json`` and read by the Desktop's Recovery page, which has no authority of its own. The values are the Core's own
in-memory state (the last relay command record, the RESTORE gate's lockout), so the page shows what the gate will actually decide.
"""

from __future__ import annotations

import time

from .controller import CUT_UPLINK, RESTORE_UPLINK

VIEW_NAME = "recovery-status.json"
VIEW_VERSION = 1

# Why the uplink is in LOCKDOWN (a code, never translated):
NOT_LOCKDOWN = "NOT_LOCKDOWN"                      # NORMAL or not reported
COMMANDED_CUT = "COMMANDED_CUT"                    # the Core sent a CUT and the device ACKed it
CUT_NOT_ACKED = "CUT_NOT_ACKED"                    # the Core sent a CUT; no ACK recorded
UNCOMMANDED_AFTER_RESTORE = "UNCOMMANDED_AFTER_RESTORE"  # last command was a RESTORE: dead-man's switch, power loss, frozen Core
NO_COMMAND_RECORD = "NO_COMMAND_RECORD"            # no command since this Core started (lockdown the Core did not command)


def uplink_why(uplink: str, physical: dict | None) -> str:
    if uplink != "LOCKDOWN":
        return NOT_LOCKDOWN
    if not physical:
        return NO_COMMAND_RECORD
    if physical.get("action") == CUT_UPLINK:
        return COMMANDED_CUT if physical.get("acknowledged_at") is not None else CUT_NOT_ACKED
    if physical.get("action") == RESTORE_UPLINK:
        return UNCOMMANDED_AFTER_RESTORE
    return NO_COMMAND_RECORD


def build(supervisor, gate=None, *, wall=time.time) -> dict:
    """The projection for the supervisor's current state. ``gate`` is the LocalRestoreGate (None when RESTORE is not served)."""
    from . import local_restore as lr   # late import: local_restore imports this package's controller

    status = supervisor.status
    physical = supervisor.awaiting_physical_confirmation
    now = supervisor.monotonic()
    remaining = lr._restore_wait_remaining(physical, now)
    last = None
    if physical:
        last = {
            "action": str(physical.get("action"))[:16],
            "acked": physical.get("acknowledged_at") is not None,
            "confirmed": physical.get("physical_confirmed_at") is not None,
            "timed_out": physical.get("physical_timeout_at") is not None,
        }
    return {
        "v": VIEW_VERSION,
        "updated_at": wall(),
        "uplink": status.uplink,
        "device": status.device,
        "uplink_why": uplink_why(status.uplink, physical),
        "last_command": last,
        "restore_pending": remaining is not None,
        "restore_pending_remaining_sec": None if remaining is None else round(remaining, 1),
        "restore_command_pending": supervisor.pending_command is not None,
        "lockout_remaining_sec": 0.0 if gate is None else round(gate.lockout_remaining(), 1),
        "restore_served": gate is not None,
    }
