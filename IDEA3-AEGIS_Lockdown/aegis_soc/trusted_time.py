"""Core trusted-time model for Protocol v1 (PR11 Phase 4, design §5.1).

Protocol time exists only while the kernel reports a synchronized clock
(SYNCED) or for a bounded holdover after the last synchronized observation
(HOLDOVER). Anything else is UNTRUSTED or UNKNOWN, and the Core then publishes
no HEARTBEAT or COMMAND and accepts no device evidence (R7). The probe only
reads kernel state; it never adjusts the clock.
"""

from __future__ import annotations

import ctypes
import sys
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from enum import StrEnum

from .protocol_v1 import TIME_FLOOR

TIME_ERROR = 5  # adjtimex(2): clock not synchronized
STA_UNSYNC = 0x0040
HOLDOVER_SEC = 300.0
MAX_ERROR_US = 1_000_000


class TimeTrust(StrEnum):
    SYNCED = "SYNCED"
    HOLDOVER = "HOLDOVER"
    UNTRUSTED = "UNTRUSTED"
    UNKNOWN = "UNKNOWN"


TRUSTED_STATES = frozenset({TimeTrust.SYNCED, TimeTrust.HOLDOVER})


@dataclass(frozen=True)
class ClockSync:
    synced: bool
    maxerror_us: int


class _Timeval(ctypes.Structure):
    _fields_ = [("tv_sec", ctypes.c_long), ("tv_usec", ctypes.c_long)]


class _Timex(ctypes.Structure):
    # Linux ``struct timex`` followed by a guard so the kernel can never write
    # past this buffer on any ABI where the structure is slightly larger.
    _fields_ = [
        ("modes", ctypes.c_uint),
        ("offset", ctypes.c_long),
        ("freq", ctypes.c_long),
        ("maxerror", ctypes.c_long),
        ("esterror", ctypes.c_long),
        ("status", ctypes.c_int),
        ("constant", ctypes.c_long),
        ("precision", ctypes.c_long),
        ("tolerance", ctypes.c_long),
        ("time", _Timeval),
        ("tick", ctypes.c_long),
        ("ppsfreq", ctypes.c_long),
        ("jitter", ctypes.c_long),
        ("shift", ctypes.c_int),
        ("stabil", ctypes.c_long),
        ("jitcnt", ctypes.c_long),
        ("calcnt", ctypes.c_long),
        ("errcnt", ctypes.c_long),
        ("stbcnt", ctypes.c_long),
        ("tai", ctypes.c_int),
        ("_reserved", ctypes.c_int * 11),
        ("_guard", ctypes.c_char * 64),
    ]


def adjtimex_probe(*, libc=None, platform: str | None = None) -> ClockSync | None:
    """Read (modes = 0) the kernel NTP state; None when it cannot be read."""
    if (platform or sys.platform) != "linux":
        return None
    try:
        library = libc if libc is not None else ctypes.CDLL(None, use_errno=True)
        function = library.adjtimex
    except (OSError, AttributeError):
        return None
    buffer = _Timex()
    buffer.modes = 0
    state = function(ctypes.byref(buffer))
    if state < 0:
        return None
    synced = state != TIME_ERROR and not buffer.status & STA_UNSYNC
    return ClockSync(synced=bool(synced), maxerror_us=int(buffer.maxerror))


class TrustedClock:
    """Evaluate SYNCED / HOLDOVER / UNTRUSTED / UNKNOWN on every call."""

    def __init__(
        self,
        probe: Callable[[], ClockSync | None] = adjtimex_probe,
        *,
        wall: Callable[[], float] = time.time,
        monotonic: Callable[[], float] = time.monotonic,
        floor: int = TIME_FLOOR,
        max_error_us: int = MAX_ERROR_US,
        holdover_sec: float = HOLDOVER_SEC,
    ) -> None:
        self._probe = probe
        self._wall = wall
        self._monotonic = monotonic
        self._floor = floor
        self._max_error_us = max_error_us
        self._holdover_sec = holdover_sec
        self._last_synced_at: float | None = None
        self._lock = threading.Lock()

    def _evaluate(self) -> tuple[TimeTrust, float]:
        try:
            sample = self._probe()
        except Exception:
            sample = None
        now = self._monotonic()
        wall = self._wall()
        with self._lock:
            if (
                sample is not None
                and sample.synced
                and 0 <= sample.maxerror_us <= self._max_error_us
                and wall >= self._floor
            ):
                self._last_synced_at = now
                return TimeTrust.SYNCED, wall
            if (
                self._last_synced_at is not None
                and now - self._last_synced_at <= self._holdover_sec
                and wall >= self._floor
            ):
                return TimeTrust.HOLDOVER, wall
            if sample is None and self._last_synced_at is None:
                return TimeTrust.UNKNOWN, wall
            return TimeTrust.UNTRUSTED, wall

    def state(self) -> TimeTrust:
        return self._evaluate()[0]

    def is_trusted(self) -> bool:
        return self.state() in TRUSTED_STATES

    def trusted_now(self) -> int | None:
        """Whole Unix seconds for protocol use, or None when time is not trusted."""
        state, wall = self._evaluate()
        return int(wall) if state in TRUSTED_STATES else None
