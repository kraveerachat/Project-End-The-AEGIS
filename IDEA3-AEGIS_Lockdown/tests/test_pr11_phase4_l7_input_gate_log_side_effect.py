"""PR11 Phase 4 L7 — l7_input_gate's restore-credential probe must never write into the caller's CWD.

Same root cause already fixed in deploy/pr11-phase4/stages/L7/apply.sh and verify.sh (see
test_pr11_phase4_l7_d4_probe_log_side_effect.py): `aegis_soc.local_restore` imports `aegis_soc.database`, whose
module-level import creates a `RotatingFileHandler(config.LOG_PATH, ...)`. `config.LOG_PATH` falls back to the
relative `"aegis_soc.log"` when `AEGIS_LOG_PATH` is unset and no systemd runtime path exists. `l7_input_gate`
(deploy/pr11-phase4/p4-l7-run-lib.sh) runs the exact same `RestoreCredential.parse` probe, outside the production
systemd environment, during the READ-ONLY pre-gate phase of `run-l7-owner.sh` -- before any authorization is even
consumed. Left unfixed, this pre-gate can create a stray log in the caller's CWD, or false-fail closed
(`L7_RESTORE_CREDENTIAL_INVALID`) if that CWD happens to be unwritable, exactly like the two already-fixed probes.

`protocol_v1.py` (the other probe l7_input_gate runs, for k_c2d/k_d2c) is pure stdlib and does not import
aegis_soc.database, so it does not share this hazard and is untouched here.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))
import l7_support as s
from test_pr11_phase4_l7_runner import ROOT, lib


def input_gate(inp: Path, *, cwd: Path | None = None):
    return lib(f"l7_input_gate '{inp}' '{sys.executable}' '{ROOT}'", unset=("AEGIS_LOG_PATH",), cwd=cwd)


def test_l7_input_gate_never_creates_a_stray_log_in_a_writable_cwd(tmp_path: Path) -> None:
    """Behavioral proof: run the REAL l7_input_gate from a dedicated, monitored, writable CWD with AEGIS_LOG_PATH
    genuinely unset, using a synthetic fixture restore.credential (never a real owner secret). Before the fix this
    is RED: aegis_soc.log appears. The gate must still accept the valid fixture input."""
    inp = s.make_input(tmp_path / "in")
    cwd = tmp_path / "monitored-cwd"
    cwd.mkdir()

    res = input_gate(inp, cwd=cwd)

    assert res.returncode == 0, res.stdout + res.stderr
    assert not (cwd / "aegis_soc.log").exists(), "l7_input_gate's restore-credential probe wrote a stray log into the caller's CWD"
    assert list(cwd.iterdir()) == [], "l7_input_gate must leave the caller's CWD completely untouched"
    for secret in s.SECRETS:
        assert secret not in res.stdout + res.stderr


def test_l7_input_gate_does_not_false_fail_from_an_unwritable_cwd(tmp_path: Path) -> None:
    """Faithfully reproduces the masked-failure mode: a CWD the invoking identity cannot write into. Before the fix,
    l7_input_gate fails closed with L7_RESTORE_CREDENTIAL_INVALID here even though the fixture credential is
    perfectly valid (RotatingFileHandler's open() raises PermissionError, masked by the probe's own
    `>/dev/null 2>&1` redirect). After the fix, the probe never attempts to open anything relative to CWD."""
    inp = s.make_input(tmp_path / "in")
    cwd = tmp_path / "readonly-cwd"
    cwd.mkdir()
    cwd.chmod(0o500)  # r-x for the owner (this test process)
    try:
        res = input_gate(inp, cwd=cwd)
        assert res.returncode == 0, res.stdout + res.stderr
        assert "L7_RESTORE_CREDENTIAL_INVALID" not in (res.stdout + res.stderr)
    finally:
        cwd.chmod(0o700)  # restore so pytest's tmp_path cleanup can remove it


def test_l7_input_gate_still_rejects_a_genuinely_invalid_restore_credential(tmp_path: Path) -> None:
    """Regression guard: the AEGIS_LOG_PATH fix must not weaken the real check. A structurally invalid credential
    must still be rejected, from a normal (writable, AEGIS_LOG_PATH-unset) CWD."""
    inp = s.make_input(tmp_path / "in")
    (inp / "restore.credential").write_text("nope\n")
    cwd = tmp_path / "cwd2"
    cwd.mkdir()
    res = input_gate(inp, cwd=cwd)
    assert res.returncode == 1 and "L7_RESTORE_CREDENTIAL_INVALID" in res.stderr


@pytest.mark.parametrize("unset", [True, False])
def test_l7_input_gate_accepts_valid_input_regardless_of_ambient_aegis_log_path(tmp_path: Path, unset: bool) -> None:
    """Whether or not the caller's own environment happens to already carry AEGIS_LOG_PATH, the gate's explicit
    /dev/null override for its own probe must not conflict with it -- the gate must pass either way."""
    inp = s.make_input(tmp_path / "in")
    cwd = tmp_path / "cwd3"
    cwd.mkdir()
    res = input_gate(inp, cwd=cwd) if unset else lib(
        f"l7_input_gate '{inp}' '{sys.executable}' '{ROOT}'", cwd=cwd,
    )
    assert res.returncode == 0, res.stdout + res.stderr
