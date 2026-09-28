"""PR11 Phase 4 L7 — listener-snapshot ephemeral-UDP-port filtering (apply/verify/rollback).

Live failure B (2026-09-29): a real L7 rollback false-failed listener comparison because raw `ss -H -ltnu`
includes every UDP socket the kernel autobound to an ephemeral client port (resolvers, NTP/mDNS, ...), which
rotate continuously and are not services. Live evidence: pre->rollback changed only UDP ports 39702, 44747, 48690,
all inside this host's kernel ip_local_port_range (32768-60999).

p4-l0-capture.sh already solves this for the T1/G-15 harness by excluding UDP local ports inside the kernel's own
ephemeral range. This file proves the fix applied to deploy/pr11-phase4/stages/L7/{apply,verify,rollback}.sh via
the new shared deploy/pr11-phase4/stages/L7/l7-listener-lib.sh: TCP is never filtered, a fixed UDP port outside
the range is never filtered, and an unreadable/malformed range silently disables filtering (fail-safe) rather
than guessing.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))
from l7_support import APPLY, ROLLBACK, VERIFY, Fx, build


@pytest.fixture()
def fx(tmp_path: Path) -> Fx:
    return build(tmp_path)


def _set_ephemeral_range(fx: Fx, lo: str = "32768", hi: str = "60999") -> None:
    range_path = fx.root / "proc/sys/net/ipv4/ip_local_port_range"
    range_path.parent.mkdir(parents=True, exist_ok=True)
    range_path.write_text(f"{lo}\t{hi}\n")


def _corrupt_ephemeral_range(fx: Fx, content: str) -> None:
    range_path = fx.root / "proc/sys/net/ipv4/ip_local_port_range"
    range_path.parent.mkdir(parents=True, exist_ok=True)
    range_path.write_text(content)


def applied(fx: Fx, **extra: str):
    res = fx.run(APPLY, **extra)
    assert res.returncode == 0, res.stdout + res.stderr
    return res


def rolled(fx: Fx, **extra: str):
    return fx.run(ROLLBACK, **extra)


def verified(fx: Fx, **extra: str):
    return fx.run(VERIFY, **extra)


BASE_TCP = "127.0.0.1:8883\n10.77.30.1:8883\n0.0.0.0:1883\n"


def test_rollback_ignores_ephemeral_udp_port_churn_within_the_kernel_range(fx: Fx) -> None:
    """Direct reproduction of the live failure: the ONLY difference between apply's baseline and rollback's
    snapshot is a UDP port that rotated within the kernel's own ephemeral range. Must NOT be reported as drift."""
    _set_ephemeral_range(fx)
    applied(fx, FAKE_SS_LISTEN=BASE_TCP + "udp:0.0.0.0:39702\n")
    res = rolled(fx, FAKE_SS_LISTEN=BASE_TCP + "udp:0.0.0.0:44747\n")
    assert res.returncode == 0, res.stdout + res.stderr
    assert "L7_ROLLBACK=PASS" in res.stdout


def test_rollback_flags_a_fixed_udp_listener_removal(fx: Fx) -> None:
    """A UDP port OUTSIDE the kernel's ephemeral range is a real fixed service, not client-socket churn, and must
    never be filtered."""
    _set_ephemeral_range(fx)
    applied(fx, FAKE_SS_LISTEN=BASE_TCP + "udp:0.0.0.0:53\n")
    res = rolled(fx, FAKE_SS_LISTEN=BASE_TCP)  # the fixed udp:53 listener disappeared
    assert res.returncode == 1
    assert "LISTENER_CHANGED" in (res.stdout + res.stderr)


def test_rollback_flags_a_fixed_udp_listener_addition(fx: Fx) -> None:
    _set_ephemeral_range(fx)
    applied(fx, FAKE_SS_LISTEN=BASE_TCP)
    res = rolled(fx, FAKE_SS_LISTEN=BASE_TCP + "udp:0.0.0.0:53\n")  # a new fixed udp:53 listener appeared
    assert res.returncode == 1
    assert "LISTENER_CHANGED" in (res.stdout + res.stderr)


def test_rollback_flags_a_tcp_listener_change_even_inside_the_ephemeral_range(fx: Fx) -> None:
    """TCP is NEVER filtered, even if its port number happens to fall inside the UDP ephemeral range."""
    _set_ephemeral_range(fx)
    applied(fx, FAKE_SS_LISTEN=BASE_TCP)
    res = rolled(fx, FAKE_SS_LISTEN=BASE_TCP + "tcp:0.0.0.0:45000\n")  # 45000 is inside 32768-60999
    assert res.returncode == 1
    assert "LISTENER_CHANGED" in (res.stdout + res.stderr)


def test_rollback_flags_a_tcp_listener_removal(fx: Fx) -> None:
    _set_ephemeral_range(fx)
    applied(fx, FAKE_SS_LISTEN=BASE_TCP)
    res = rolled(fx, FAKE_SS_LISTEN="127.0.0.1:8883\n0.0.0.0:1883\n")  # 10.77.30.1:8883 dropped
    assert res.returncode == 1
    assert "LISTENER_CHANGED" in (res.stdout + res.stderr)


@pytest.mark.parametrize("corrupt", [
    None,  # range file absent entirely
    "not-a-range\n",
    "500\t60999\n",  # lo below 1024
    "40000\t30000\n",  # lo > hi
    "40000\t70000\n",  # hi above 65535
])
def test_rollback_does_not_silently_suppress_udp_drift_when_the_range_is_unreadable_or_malformed(fx: Fx, corrupt) -> None:
    """Fail-safe contract: when the kernel range cannot be read AND validated, nothing is filtered -- an ephemeral
    UDP port change is then correctly treated as drift too, rather than being silently hidden by a guessed range."""
    if corrupt is not None:
        _corrupt_ephemeral_range(fx, corrupt)
    # else: leave /proc/sys/net/ipv4/ip_local_port_range entirely absent (the build() fixture default)
    applied(fx, FAKE_SS_LISTEN=BASE_TCP + "udp:0.0.0.0:39702\n")
    res = rolled(fx, FAKE_SS_LISTEN=BASE_TCP + "udp:0.0.0.0:44747\n")
    assert res.returncode == 1
    assert "LISTENER_CHANGED" in (res.stdout + res.stderr)


def test_rollback_still_proves_all_l7_owned_material_removed_with_the_new_snapshot(fx: Fx) -> None:
    """Regression guard: the listener-snapshot change must not weaken rollback's other proofs."""
    _set_ephemeral_range(fx)
    before = fx.tree()
    applied(fx, FAKE_SS_LISTEN=BASE_TCP + "udp:0.0.0.0:39702\n")
    res = rolled(fx, FAKE_SS_LISTEN=BASE_TCP + "udp:0.0.0.0:44747\n")
    assert res.returncode == 0, res.stdout + res.stderr
    assert "L7_ROLLBACK=PASS" in res.stdout and "L7_MATERIAL_RESIDUE=NO" in res.stdout
    assert fx.tree() == before


def test_verify_ignores_ephemeral_udp_port_churn_within_the_kernel_range(fx: Fx) -> None:
    _set_ephemeral_range(fx)
    applied(fx, FAKE_SS_LISTEN=BASE_TCP + "udp:0.0.0.0:39702\n")
    res = verified(fx, FAKE_SS_LISTEN=BASE_TCP + "udp:0.0.0.0:44747\n")
    assert res.returncode == 0, res.stdout + res.stderr
    assert "L7_NEW_LISTENERS=NONE" in res.stdout


def test_verify_flags_a_fixed_udp_listener_addition(fx: Fx) -> None:
    _set_ephemeral_range(fx)
    applied(fx, FAKE_SS_LISTEN=BASE_TCP)
    res = verified(fx, FAKE_SS_LISTEN=BASE_TCP + "udp:0.0.0.0:53\n")
    assert res.returncode == 1
    assert "NEW_LISTENER" in (res.stdout + res.stderr)
