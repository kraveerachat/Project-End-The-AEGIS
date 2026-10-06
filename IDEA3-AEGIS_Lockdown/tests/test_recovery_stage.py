import json
import os
import stat
from pathlib import Path

import pytest

from aegis_soc import recovery_stage as stage
from aegis_soc import recovery_protocol as rp


def test_attempt_marker_is_exclusive_and_never_retried(tmp_path):
    marker = tmp_path / "attempt"
    first = stage.consume_attempt(str(marker))
    assert first["consumed"] is True
    with pytest.raises(stage.StageError, match="ALREADY_CONSUMED"):
        stage.consume_attempt(str(marker))
    assert marker.read_text().find("retry") >= 0


def test_stage_is_core_only_and_normal_restore_is_exit_code_only():
    text = Path(__file__).parents[1].joinpath("aegis_soc/recovery_stage.py").read_text()
    assert "OP_ISOLATE" in text and "attacker_ip" in text
    assert "subprocess" not in text and "sqlite3.connect" in text
    runner = Path(__file__).parents[1].joinpath("deploy/pr11-phase4/owner-run/run-recovery-owner.sh").read_text()
    assert "RESTORE UPLINK" in runner
    assert "--break-glass" not in runner
    assert "RECOVERY_SECRET" in runner


def test_recovery_is_registered_once_and_requires_k3():
    lib = Path(__file__).parents[1].joinpath("deploy/pr11-phase4/p4-lib.sh").read_text()
    stages = lib.split('readonly P4_STAGES="', 1)[1].split('"', 1)[0].split()
    assert stages.count("Recovery") == 1
    assert stages[stages.index("R1Bv") + 1 : stages.index("L8") + 1] == ["Recovery", "L8"]
    gate = Path(__file__).parents[1].joinpath("deploy/pr11-phase4/p4-stage-gate.sh").read_text()
    assert "p4_stage_mutates" in gate and "K3_MISSING" in gate


def test_core_derives_isolation_target_and_protocol_has_no_ip_parameter():
    assert "ip" not in rp._PARAMS[rp.OP_ISOLATE]
    core = Path(__file__).parents[1].joinpath("aegis_soc/recovery_core.py").read_text()
    assert "def isolate(self)" in core and "parse_ipv4(incident.get" in core


def test_claim_boundary_does_not_promote_prior_failures_or_later_stages():
    source = Path(__file__).parents[1].joinpath("aegis_soc/recovery_stage.py").read_text()
    assert '"R1B_RESULT": "FAIL_IMMUTABLE"' in source
    assert '"R1BV_RESULT": "PASS"' in source
    assert '"LVR_PROVEN": "NO"' in source and '"L8_ACCEPTANCE": "NO"' in source and '"L9_PROVEN": "NO"' in source
