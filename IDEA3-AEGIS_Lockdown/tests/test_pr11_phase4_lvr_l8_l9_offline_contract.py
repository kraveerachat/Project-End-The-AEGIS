"""AEGIS IDEA3 PR11 Phase 4 — LVR / L8 / L9 offline cross-stage contract.

Repository-only. Nothing here contacts a broker, opens a serial device, restarts
a service or issues a COMMAND. It pins the *boundary* between the Recovery
predecessor and the three downstream stages so that none of them can be
represented as executed or authorized from source alone:

* ``LVR`` is an owner-runbook ceremony, not a registered stage: the stage gate
  must refuse it as an unknown stage (fail closed), never accept it.
* The registry order is ``... CTv ICu Recovery L8 L9``; ICu is distinct from CTu/CTv and does not clear Recovery's failed predecessor gate.
* L8 alone carries ``recovery_authorization``; without it the record is
  malformed. No other downstream stage may carry it.
* For L8 and L9 the gate can never print ``LIVE_STAGE_AUTHORIZED=YES`` and never
  reports a Production mutation, in either mode.
* The Recovery stage keeps claiming LVR / L8 / L9 as NOT proven.
"""

from __future__ import annotations

import datetime as dt
import re
import subprocess
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest

ROOT = Path(__file__).resolve().parents[1]
DEPLOY = ROOT / "deploy" / "pr11-phase4"
P4_LIB = DEPLOY / "p4-lib.sh"
GATE = DEPLOY / "p4-stage-gate.sh"
RECOVERY_STAGE_PY = next((DEPLOY / "recovery-acceptance").glob("*.py"), None)

REF = "https://example.invalid/aegis-p4-offline-contract"


def _stages() -> list[str]:
    line = next(l for l in P4_LIB.read_text().splitlines() if l.startswith("readonly P4_STAGES="))
    return line.split('"')[1].split()


def _today() -> str:
    return dt.datetime.now(ZoneInfo("Asia/Bangkok")).strftime("%Y-%m-%d")


def _gate(
    tmp_path: Path,
    stage: str,
    mode: str,
    extra: str = "",
    gate: Path = GATE,
) -> subprocess.CompletedProcess[str]:
    auth = tmp_path / f"auth-{stage}-{mode}.txt"
    k3 = tmp_path / f"k3-{stage}-{mode}.txt"
    auth.write_text(
        f"AEGIS_P4_AUTHORIZATION_V1\nstage={stage}\ndate={_today()}\nauthorizer=music\n"
        f"scope=offline contract probe\nreference={REF}\n{extra}")
    k3.write_text(
        f"AEGIS_P4_K3_CONFIRMATION_V1\nstage={stage}\ndate={_today()}\nconfirmed_by=kraveerachat\n"
        f"idea1_window_overlap=NONE\nreference={REF}\n")
    auth.chmod(0o600)
    k3.chmod(0o600)
    return subprocess.run(
        ["bash", str(gate), "--stage", stage, "--mode", mode, "--authorization", str(auth), "--k3", str(k3)],
        capture_output=True, text=True, timeout=30, check=False)


def _never_authorizes_live(output: str) -> bool:
    return "LIVE_STAGE_AUTHORIZED=NO" in output and "LIVE_STAGE_AUTHORIZED=YES" not in output


def test_registry_order_places_icu_before_recovery_then_l8_then_l9() -> None:
    order = _stages()
    assert order[-3:] == ["Recovery", "L8", "L9"]
    assert order.index("CTv") + 1 == order.index("ICu")
    assert order.index("ICu") + 1 == order.index("Recovery")
    assert order.count("L8") == order.count("L9") == order.count("Recovery") == 1


def test_lvr_is_not_a_registered_stage() -> None:
    assert "LVR" not in _stages(), "LVR is an owner-runbook ceremony; registering it would imply an implementation"


@pytest.mark.parametrize("mode", ["simulate", "live"])
def test_gate_refuses_lvr_as_an_unknown_stage(tmp_path: Path, mode: str) -> None:
    res = _gate(tmp_path, "LVR", mode)
    assert res.returncode != 0
    assert "GATE_FAIL STAGE_UNKNOWN" in res.stdout + res.stderr
    assert "LIVE_STAGE_AUTHORIZED=NO" in res.stdout
    assert "LIVE_STAGE_AUTHORIZED=YES" not in res.stdout


def test_l8_record_without_recovery_authorization_is_malformed(tmp_path: Path) -> None:
    res = _gate(tmp_path, "L8", "live")
    assert res.returncode != 0
    assert "AUTHORIZATION_MALFORMED" in res.stdout + res.stderr
    assert "AUTHORIZATION_RECORD=INVALID" in res.stdout


# FINDING (not fixed here): p4-stage-gate.sh accepts a recovery_authorization field on an L9 record although its own
# comment declares the field L8-only. The gate is byte-pinned by the shared contract tests (tests/test_pr11_phase4_l34_v8_scope_contract.py,
# tests/test_pr11_phase4_dnsmasq_unit_repair_reboot_and_scope.py) and a frozen predecessor gate, so this offline task does
# not edit it. This xfail covers only that malformed-record acceptance gap. The separate non-xfail tests below protect
# the independent fail-closed output invariant against future regressions.
_L9_GATE_GAP = pytest.mark.xfail(
    strict=True, reason="frozen p4-stage-gate.sh accepts recovery_authorization on L9; needs an owner-approved gate successor")


@pytest.mark.parametrize("stage", [pytest.param("L9", marks=_L9_GATE_GAP), "Recovery", "CTv", "L8p"])
def test_recovery_authorization_is_l8_only(tmp_path: Path, stage: str) -> None:
    res = _gate(tmp_path, stage, "live", extra=f"recovery_authorization={REF}\n")
    assert res.returncode != 0
    assert "AUTHORIZATION_MALFORMED" in res.stdout + res.stderr


UNEXPECTED_RECOVERY_AUTH_STAGES = [
    "L9", "Recovery", "CTv", "CTu", "L7u", "L8p", "F1i", "F1r", "F1", "F1u",
    "R1A", "R1Du", "R1D", "R1Dv", "R1Bv", "R1B", "RRu",
]


@pytest.mark.parametrize("stage", UNEXPECTED_RECOVERY_AUTH_STAGES)
def test_unexpected_recovery_authorization_never_authorizes_live(
        tmp_path: Path, stage: str) -> None:
    res = _gate(tmp_path, stage, "live", extra=f"recovery_authorization={REF}\n")
    assert _never_authorizes_live(res.stdout)


def test_authorization_output_guard_rejects_disposable_yes_mutation(tmp_path: Path) -> None:
    """The safety assertion must fail if a disposable gate fixture emits YES."""
    mutated_gate = tmp_path / "p4-stage-gate-mutated.sh"
    source = GATE.read_text()
    mutated = source.replace(
        "printf 'LIVE_STAGE_AUTHORIZED=NO\\n'",
        "printf 'LIVE_STAGE_AUTHORIZED=YES\\n'",
        1,
    )
    assert mutated != source
    mutated_gate.write_text(mutated)
    mutated_gate.chmod(GATE.stat().st_mode & 0o777)

    res = _gate(
        tmp_path,
        "L9",
        "live",
        extra=f"recovery_authorization={REF}\n",
        gate=mutated_gate,
    )
    assert "LIVE_STAGE_AUTHORIZED=YES" in res.stdout
    assert not _never_authorizes_live(res.stdout)


@pytest.mark.parametrize("stage,extra", [("L8", f"recovery_authorization={REF}\n"), ("L9", "")])
@pytest.mark.parametrize("mode", ["simulate", "live"])
def test_gate_never_authorizes_l8_or_l9_live_or_reports_a_production_mutation(
        tmp_path: Path, stage: str, extra: str, mode: str) -> None:
    res = _gate(tmp_path, stage, mode, extra=extra)
    out = res.stdout
    assert "ROLLBACK_HANDLER=REGISTERED" in out
    assert _never_authorizes_live(out)
    assert "PRODUCTION_MUTATION_PERFORMED=NO" in out
    assert re.search(r"^REPOSITORY_GAP_MERGE_STATE=NOT_VERIFIED_BY_GATE$", out, re.MULTILINE), "the gate must not claim merge state"


def test_stale_authorization_for_l9_is_refused(tmp_path: Path) -> None:
    auth = tmp_path / "auth.txt"
    k3 = tmp_path / "k3.txt"
    auth.write_text(
        f"AEGIS_P4_AUTHORIZATION_V1\nstage=L9\ndate=2020-01-01\nauthorizer=music\nscope=stale\nreference={REF}\n")
    k3.write_text(
        f"AEGIS_P4_K3_CONFIRMATION_V1\nstage=L9\ndate=2020-01-01\nconfirmed_by=kraveerachat\n"
        f"idea1_window_overlap=NONE\nreference={REF}\n")
    auth.chmod(0o600)
    k3.chmod(0o600)
    res = subprocess.run(["bash", str(GATE), "--stage", "L9", "--mode", "live", "--authorization", str(auth),
                          "--k3", str(k3)], capture_output=True, text=True, timeout=30, check=False)
    assert res.returncode != 0
    assert _never_authorizes_live(res.stdout)


def test_a_cross_stage_authorization_cannot_be_replayed_for_l9(tmp_path: Path) -> None:
    """An L8-stage record (even with recovery_authorization) must not satisfy the L9 gate."""
    l8 = _gate(tmp_path, "L8", "live", extra=f"recovery_authorization={REF}\n")
    assert "AUTHORIZATION_RECORD=VALID" in l8.stdout
    res = subprocess.run(
        ["bash", str(GATE), "--stage", "L9", "--mode", "live",
         "--authorization", str(tmp_path / "auth-L8-live.txt"), "--k3", str(tmp_path / "k3-L8-live.txt")],
        capture_output=True, text=True, timeout=30, check=False)
    assert res.returncode != 0
    assert "AUTHORIZATION_RECORD=VALID" not in res.stdout
    assert _never_authorizes_live(res.stdout)


@pytest.mark.skipif(RECOVERY_STAGE_PY is None, reason="no recovery acceptance module")
def test_recovery_acceptance_never_claims_lvr_l8_or_l9() -> None:
    text = "\n".join(p.read_text() for p in (DEPLOY / "recovery-acceptance").glob("*.py"))
    assert re.search(r'"LVR_PROVEN":\s*"NO"', text) or "LVR_PROVEN" not in text
    assert not re.search(r'"(L8_ACCEPTANCE|L9_PROVEN|LVR_PROVEN)":\s*"(YES|PASS)"', text)
