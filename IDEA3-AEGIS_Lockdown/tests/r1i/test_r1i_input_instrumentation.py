from __future__ import annotations

import os
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
PACKAGE = ROOT / "deploy/pr11-phase4/r1i-input-instrumentation"
TOOL = PACKAGE / "r1i_input_instrumentation.py"
APPLY = PACKAGE / "apply.sh"
VERIFY = PACKAGE / "verify.sh"
ROLLBACK = PACKAGE / "rollback.sh"
P4_LIB = ROOT / "deploy/pr11-phase4/p4-lib.sh"
LIVE = Path("/home/kittipat/Workspace/idea3-p4-evidence/2026-10-05-shared-readonly-preflight/nft-live.txt")


def run(path: Path, *, env: dict[str, str], args: list[str] | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run([str(path), *(args or [])], env=env, text=True, capture_output=True, check=False)


def base_env(tmp_path: Path) -> dict[str, str]:
    work = tmp_path / "work"
    work.mkdir()
    return {**os.environ, "AEGIS_R1I_WORK_DIR": str(work), "AEGIS_P4_FS_ROOT": str(tmp_path / "fs")}


def test_design_uses_exact_prefix_kernel_payload_and_safe_ordering(tmp_path: Path) -> None:
    rendered = tmp_path / "r1i.nft"
    result = subprocess.run(["python3", str(TOOL), "render", str(rendered)], text=True, capture_output=True)
    assert result.returncode == 0
    text = rendered.read_text()
    assert text.count('log prefix "AEGIS_NEWCONN "') == 2
    assert text.count("priority -10") == 2
    assert text.count("ct state new tcp flags & (syn | ack) == syn") == 2
    assert text.count("limit rate 50/second burst 60 packets") == 2
    assert "tcp flags & syn == syn" not in text
    assert "SRC=" not in text and "DPT=" not in text
    assert "drop" not in text and "reject" not in text
    assert subprocess.run(["python3", str(TOOL), "validate", str(rendered)], check=False).returncode == 0


def test_live_evidence_proves_current_priority_and_reachability() -> None:
    if not LIVE.is_file():
        pytest.skip("supplied live evidence is unavailable in this checkout")
    result = subprocess.run(["python3", str(TOOL), "validate-live", str(LIVE)], text=True, capture_output=True)
    assert result.returncode == 0, result.stderr
    assert "proposed_priority" in result.stdout


def test_priority_is_strictly_before_live_filter_and_avoids_standard_boundaries() -> None:
    from importlib.util import module_from_spec, spec_from_file_location

    spec = spec_from_file_location("r1i_tool", TOOL)
    assert spec and spec.loader
    tool = module_from_spec(spec)
    spec.loader.exec_module(tool)
    assert tool.PRIORITY < 0
    assert tool.PRIORITY not in tool.STANDARD_PRIORITY_BOUNDARIES
    assert tool.PRIORITY < tool.validate_live_dump(LIVE.read_text())["input_priority"]


def test_rate_limit_has_mathematical_headroom_for_both_detector_windows() -> None:
    from importlib.util import module_from_spec, spec_from_file_location

    spec = spec_from_file_location("r1i_tool", TOOL)
    assert spec and spec.loader
    tool = module_from_spec(spec)
    spec.loader.exec_module(tool)
    assert tool.BURST >= 3 * tool.SYN_THRESHOLD
    assert tool.RATE_PER_SECOND * tool.SYN_WINDOW_SECONDS >= 5 * tool.SYN_THRESHOLD
    assert tool.RATE_PER_SECOND * tool.PORTSCAN_WINDOW_SECONDS >= 5 * tool.PORTSCAN_THRESHOLD


def test_kernel_payload_matches_the_merged_detector_parser() -> None:
    from aegis_soc import production_detector

    line = 'AEGIS_NEWCONN IN=eth0 SRC=203.0.113.7 DST=192.0.2.10 PROTO=TCP DPT=443'
    assert production_detector._SRC_RE.search(line).group(1) == "203.0.113.7"
    assert production_detector._DPT_RE.search(line).group(1) == "443"


def test_registered_stage_order_and_handler_surface_keep_r1a_unregistered() -> None:
    registry = P4_LIB.read_text()
    expected = 'readonly P4_STAGES="L0 L1 L2 L3 L4 L5 L6a L6b L6c L7 L7u L8p F1i F1r F1 F1u R1I L8 L9"'
    assert expected in registry
    assert "R1A" not in next(line for line in registry.splitlines() if line.startswith("readonly P4_STAGES="))
    result = subprocess.run(
        ["bash", "-c", f'. "{P4_LIB}"; p4_stage_known R1I; p4_stage_mutates R1I; p4_stage_handler_status R1I'],
        text=True, capture_output=True, check=False,
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "REGISTERED"


def test_fixture_apply_verify_rollback_is_exact_and_one_shot(tmp_path: Path) -> None:
    env = base_env(tmp_path)
    fs = Path(env["AEGIS_P4_FS_ROOT"])
    fs.mkdir()
    applied = fs / "etc/aegis-idea3-r1i.nft"
    applied.parent.mkdir(parents=True)
    first = run(APPLY, env=env)
    assert first.returncode == 0, first.stderr
    assert applied.is_file()
    assert run(VERIFY, env=env).returncode == 0
    second = run(APPLY, env=env)
    assert second.returncode == 1 and "ONE_SHOT_ALREADY_CONSUMED" in second.stderr
    rolled = run(ROLLBACK, env=env)
    assert rolled.returncode == 0, rolled.stderr
    assert not applied.exists()


def test_foreign_state_drift_refuses_verify_and_rollback(tmp_path: Path) -> None:
    env = base_env(tmp_path)
    fs = Path(env["AEGIS_P4_FS_ROOT"]); fs.mkdir()
    assert run(APPLY, env=env).returncode == 0
    current = fs / "etc/aegis-idea3-r1i.nft"
    current.write_text(current.read_text() + "# foreign drift\n")
    assert "FOREIGN_STATE_DRIFT" in run(VERIFY, env=env).stderr
    assert "FOREIGN_STATE_DRIFT" in run(ROLLBACK, env=env).stderr


def test_malformed_source_and_r1a_execution_are_refused(tmp_path: Path) -> None:
    bad = tmp_path / "bad.nft"
    bad.write_text("table inet aegis_idea3_r1i {}\n")
    result = subprocess.run(["python3", str(TOOL), "validate", str(bad)], text=True, capture_output=True)
    assert result.returncode == 1
    assert not any("r1a" in path.name.lower() for path in (ROOT / "deploy/pr11-phase4").rglob("*.sh"))
    assert not any(ROOT.rglob("run-r1a*.sh"))


def test_handlers_are_logging_only_and_cannot_touch_core_detector_alert_or_shared_firewall() -> None:
    sources = "\n".join(path.read_text() for path in (APPLY, VERIFY, ROLLBACK))
    for forbidden in ("nft flush ruleset", "systemctl", "alert", "incident", "blocked_ipv4", "aegis_idea3 "):
        assert forbidden not in sources.lower(), forbidden
    assert "nft delete table inet aegis_idea3_r1i" in sources
    assert "nft delete table inet aegis_idea3 " not in sources
