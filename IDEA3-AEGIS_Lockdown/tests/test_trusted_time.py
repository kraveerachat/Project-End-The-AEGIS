"""Core trusted-time model (design §5.1, R7)."""

from __future__ import annotations

import ctypes
import sys

import pytest

from aegis_soc import trusted_time as tt
from aegis_soc.protocol_v1 import TIME_FLOOR

WALL = TIME_FLOOR + 10_000


class Clock:
    def __init__(self, value):
        self.value = value

    def __call__(self):
        return self.value


def _clock(probe, *, wall=WALL, mono=None):
    monotonic = mono or Clock(1_000.0)
    return tt.TrustedClock(probe, wall=Clock(wall) if not callable(wall) else wall, monotonic=monotonic), monotonic


def synced(maxerror_us=10_000):
    return tt.ClockSync(synced=True, maxerror_us=maxerror_us)


def test_synced_kernel_clock_above_floor_is_trusted():
    clock, _ = _clock(lambda: synced())
    assert clock.state() == tt.TimeTrust.SYNCED
    assert clock.is_trusted() is True
    assert clock.trusted_now() == WALL


@pytest.mark.parametrize(
    ("probe", "wall", "expected"),
    [
        (lambda: tt.ClockSync(synced=False, maxerror_us=10_000), WALL, tt.TimeTrust.UNTRUSTED),
        (lambda: synced(maxerror_us=1_000_001), WALL, tt.TimeTrust.UNTRUSTED),
        (lambda: synced(maxerror_us=-1), WALL, tt.TimeTrust.UNTRUSTED),
        (lambda: synced(), TIME_FLOOR - 1, tt.TimeTrust.UNTRUSTED),
        (lambda: None, WALL, tt.TimeTrust.UNKNOWN),
    ],
)
def test_untrusted_and_unknown_states_never_yield_protocol_time(probe, wall, expected):
    clock, _ = _clock(probe, wall=wall)
    assert clock.state() == expected
    assert clock.is_trusted() is False
    assert clock.trusted_now() is None


def test_a_raising_probe_is_unknown_not_trusted():
    def probe():
        raise OSError("adjtimex unavailable")

    clock, _ = _clock(probe)
    assert clock.state() == tt.TimeTrust.UNKNOWN
    assert clock.trusted_now() is None


def test_holdover_lasts_exactly_300_seconds_after_the_last_sync():
    samples = iter([synced(), None, tt.ClockSync(synced=False, maxerror_us=0), None])
    mono = Clock(1_000.0)
    clock = tt.TrustedClock(lambda: next(samples), wall=Clock(WALL), monotonic=mono)
    assert clock.state() == tt.TimeTrust.SYNCED
    mono.value = 1_150.0
    assert clock.state() == tt.TimeTrust.HOLDOVER
    mono.value = 1_300.0
    assert clock.state() == tt.TimeTrust.HOLDOVER
    mono.value = 1_300.5
    assert clock.state() == tt.TimeTrust.UNTRUSTED


def test_holdover_still_requires_the_wall_clock_floor():
    samples = iter([synced(), None])
    wall = Clock(WALL)
    clock = tt.TrustedClock(lambda: next(samples), wall=wall, monotonic=Clock(1_000.0))
    assert clock.state() == tt.TimeTrust.SYNCED
    wall.value = TIME_FLOOR - 5
    assert clock.state() == tt.TimeTrust.UNTRUSTED


def test_trusted_states_are_exactly_synced_and_holdover():
    assert tt.TRUSTED_STATES == frozenset({tt.TimeTrust.SYNCED, tt.TimeTrust.HOLDOVER})
    assert {state.value for state in tt.TimeTrust} == {"SYNCED", "HOLDOVER", "UNTRUSTED", "UNKNOWN"}


def test_timex_buffer_is_never_smaller_than_the_kernel_structure():
    # glibc x86_64/aarch64 struct timex is 208 bytes; the guard keeps us above it.
    assert ctypes.sizeof(tt._Timex) >= 208 + 64


class FakeLibc:
    def __init__(self, *, state=0, status=0, maxerror=5_000):
        self.state = state
        self.status = status
        self.maxerror = maxerror
        self.modes_seen = []

    def adjtimex(self, pointer):
        buffer = pointer._obj
        self.modes_seen.append(buffer.modes)
        buffer.status = self.status
        buffer.maxerror = self.maxerror
        return self.state


def test_adjtimex_probe_only_reads_and_maps_the_kernel_flags():
    healthy = FakeLibc()
    assert tt.adjtimex_probe(libc=healthy, platform="linux") == tt.ClockSync(synced=True, maxerror_us=5_000)
    assert healthy.modes_seen == [0]
    assert tt.adjtimex_probe(libc=FakeLibc(status=tt.STA_UNSYNC), platform="linux").synced is False
    assert tt.adjtimex_probe(libc=FakeLibc(state=tt.TIME_ERROR), platform="linux").synced is False
    assert tt.adjtimex_probe(libc=FakeLibc(state=-1), platform="linux") is None
    assert tt.adjtimex_probe(libc=healthy, platform="win32") is None


@pytest.mark.skipif(sys.platform != "linux", reason="adjtimex exists only on Linux")
def test_real_adjtimex_probe_returns_a_read_only_sample():
    sample = tt.adjtimex_probe()
    assert sample is None or isinstance(sample, tt.ClockSync)
