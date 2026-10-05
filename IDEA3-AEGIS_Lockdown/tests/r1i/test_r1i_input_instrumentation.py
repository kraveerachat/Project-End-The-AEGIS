from __future__ import annotations

import os
import shutil
import subprocess
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
PACKAGE = ROOT / "deploy/pr11-phase4/r1i-input-instrumentation"
TOOL = PACKAGE / "r1i_input_instrumentation.py"
APPLY = PACKAGE / "apply.sh"
VERIFY = PACKAGE / "verify.sh"
ROLLBACK = PACKAGE / "rollback.sh"
P4_LIB = ROOT / "deploy/pr11-phase4/p4-lib.sh"
FIXTURE = Path(__file__).parent / "fixtures/l2_hook_priority_facts.nft.fixture"
REAL_NFT = shutil.which("nft")


def load_tool():
    spec = spec_from_file_location("r1i_tool", TOOL)
    assert spec and spec.loader
    tool = module_from_spec(spec)
    spec.loader.exec_module(tool)
    return tool


def run(path: Path, *, env: dict[str, str], args: list[str] | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run([str(path), *(args or [])], env=env, text=True, capture_output=True, check=False)


def base_env(tmp_path: Path) -> dict[str, str]:
    work = tmp_path / "work"
    work.mkdir()
    return {**os.environ, "AEGIS_R1I_WORK_DIR": str(work), "AEGIS_P4_FS_ROOT": str(tmp_path / "fs")}


# --------------------------------------------------------------------------- source / validators


def test_design_is_input_only_ipv4_exact_prefix_and_no_verdict(tmp_path: Path) -> None:
    rendered = tmp_path / "r1i.nft"
    assert subprocess.run(["python3", str(TOOL), "render", str(rendered)], capture_output=True).returncode == 0
    text = rendered.read_text()
    assert text.startswith("create table inet aegis_idea3_r1i\n")
    assert text.count("hook input priority -10;") == 1
    assert "forward" not in text
    assert text.count("meta nfproto ipv4 ct state new tcp flags & (syn | ack) == syn") == 1
    assert text.count('log prefix "AEGIS_NEWCONN "') == 1
    assert text.count("limit rate 50/second burst 60 packets") == 1
    assert "SRC=" not in text and "DPT=" not in text
    for word in ("drop", "reject", "flush", "delete", "blocked_ipv4"):
        assert word not in text
    assert (PACKAGE / "r1i.nft.example").read_text() == text
    assert subprocess.run(["python3", str(TOOL), "validate", str(rendered)], capture_output=True).returncode == 0


GOOD_STATE = """table inet aegis_idea3_r1i {
\tchain input {
\t\ttype filter hook input priority filter - 10; policy accept;
\t\tmeta nfproto ipv4 ct state new tcp flags & (syn | ack) == syn limit rate 50/second burst 60 packets log prefix "AEGIS_NEWCONN " level info
\t}
}
"""


def state_result(tmp_path: Path, text: str) -> subprocess.CompletedProcess[str]:
    path = tmp_path / "state.txt"
    path.write_text(text)
    return subprocess.run(["python3", str(TOOL), "validate-state", str(path)], text=True, capture_output=True)


def test_validate_state_accepts_the_exact_owned_state_in_both_priority_spellings(tmp_path: Path) -> None:
    assert state_result(tmp_path, GOOD_STATE).returncode == 0
    assert state_result(tmp_path, GOOD_STATE.replace("filter - 10", "-10")).returncode == 0


@pytest.mark.parametrize(
    "mutate",
    [
        lambda s: s.replace("log prefix", "counter log prefix"),
        lambda s: s.replace("limit rate", "meta mark set 0x1 limit rate"),
        lambda s: s.replace("\t}\n}", "\t\tlog prefix \"X \"\n\t}\n}"),
        lambda s: s.replace("\t}\n}", "\t}\n\tchain forward {\n\t\ttype filter hook forward priority filter - 10; policy accept;\n\t}\n}"),
        lambda s: s.replace("\t}\n}", "\t\tip saddr 1.2.3.4 drop\n\t}\n}"),
        lambda s: s.replace("meta nfproto ipv4 ", ""),
        lambda s: s.replace("priority filter - 10", "priority filter"),
        lambda s: s.replace("policy accept", "policy drop"),
        lambda s: s.replace("burst 60", "burst 6000"),
        lambda s: s.replace("table inet aegis_idea3_r1i", "table inet other"),
        lambda s: "",
        lambda s: s + "table inet aegis_idea3 {\n}\n",  # trailing foreign content after a valid table
        lambda s: s + "counter\n",
    ],
)
def test_validate_state_rejects_every_foreign_or_modified_statement(tmp_path: Path, mutate) -> None:
    assert state_result(tmp_path, mutate(GOOD_STATE)).returncode == 1


def test_malformed_source_is_refused(tmp_path: Path) -> None:
    for body in ("table inet aegis_idea3_r1i {}\n", "flush ruleset\n", (PACKAGE / "r1i.nft.example").read_text() + "flush ruleset\n"):
        bad = tmp_path / "bad.nft"
        bad.write_text(body)
        assert subprocess.run(["python3", str(TOOL), "validate", str(bad)], capture_output=True).returncode == 1


def test_sanitized_fixture_proves_ordering_facts_without_machine_local_evidence() -> None:
    tool = load_tool()
    facts = tool.validate_live_dump(FIXTURE.read_text())
    assert tool.PRIORITY < facts["input_priority"] and tool.PRIORITY not in tool.STANDARD_PRIORITY_BOUNDARIES
    result = subprocess.run(["python3", str(TOOL), "validate-live", str(FIXTURE)], text=True, capture_output=True)
    assert result.returncode == 0 and "proposed_priority" in result.stdout


def test_rate_limit_has_mathematical_headroom_for_both_detector_windows() -> None:
    tool = load_tool()
    assert tool.BURST >= 3 * tool.SYN_THRESHOLD
    assert tool.RATE_PER_SECOND * tool.SYN_WINDOW_SECONDS >= 5 * tool.SYN_THRESHOLD
    assert tool.RATE_PER_SECOND * tool.PORTSCAN_WINDOW_SECONDS >= 5 * tool.PORTSCAN_THRESHOLD


def test_kernel_payload_matches_the_merged_detector_parser() -> None:
    from aegis_soc import production_detector

    line = "AEGIS_NEWCONN IN=eth0 SRC=203.0.113.7 DST=192.0.2.10 PROTO=TCP DPT=443"
    assert production_detector._SRC_RE.search(line).group(1) == "203.0.113.7"
    assert production_detector._DPT_RE.search(line).group(1) == "443"


# --------------------------------------------------------------------------- registry


def test_registered_stage_order_and_handler_surface_place_r1a_after_r1i() -> None:
    registry = P4_LIB.read_text()
    expected = 'readonly P4_STAGES="L0 L1 L2 L3 L4 L5 L6a L6b L6c L7 L7u L8p F1i F1r F1 F1u R1I R1A R1Du R1D R1B L8 L9"'
    assert expected in registry
    assert registry.count(" R1I R1A R1Du R1D R1B L8 ") == 1  # R1A, the historical-disposition stages R1Du/R1D and the successor R1B are separate, later stages (owner-approved registration; its own tests live in tests/r1a)
    result = subprocess.run(
        ["bash", "-c", f'. "{P4_LIB}"; p4_stage_known R1I; p4_stage_mutates R1I; p4_stage_handler_status R1I'],
        text=True, capture_output=True, check=False,
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "REGISTERED"
    assert not any("r1a" in path.name.lower() for path in (ROOT / "deploy/pr11-phase4/r1i-input-instrumentation").rglob("*"))  # R1I never carries R1A material


def test_handlers_are_logging_only_and_cannot_touch_core_detector_alert_or_shared_firewall() -> None:
    sources = "\n".join(path.read_text() for path in (APPLY, VERIFY, ROLLBACK))
    for forbidden in ("flush ruleset", "systemctl", "alert", "incident", "blocked_ipv4", "aegis_idea3 "):
        assert forbidden not in sources.lower(), forbidden
    assert sources.count("nft delete table inet aegis_idea3_r1i") == 2  # rollback + proven-owned recovery
    assert "nft delete table inet aegis_idea3 " not in sources


# --------------------------------------------------------------------------- fixture lifecycle


def test_fixture_apply_verify_rollback_is_exact_and_one_shot(tmp_path: Path) -> None:
    env = base_env(tmp_path)
    applied = Path(env["AEGIS_P4_FS_ROOT"]) / "etc/aegis-idea3-r1i.nft"
    first = run(APPLY, env=env)
    assert first.returncode == 0, first.stderr
    assert applied.is_file()
    assert "R1I_TABLE=inet aegis_idea3_r1i\n" in first.stdout
    assert "PRODUCTION_MUTATION_PERFORMED=NO\n" in first.stdout and "FIXTURE_ONLY=YES\n" in first.stdout
    assert "FIXTURE_ONLY/" not in first.stdout
    verified = run(VERIFY, env=env)
    assert verified.returncode == 0, verified.stderr
    second = run(APPLY, env=env)
    assert second.returncode == 1 and "ONE_SHOT_ALREADY_CONSUMED" in second.stderr
    assert not (Path(env["AEGIS_R1I_WORK_DIR"]) / "OUTCOME").exists()  # refused re-run never rewrites the record
    rolled = run(ROLLBACK, env=env)
    assert rolled.returncode == 0, rolled.stderr
    assert not applied.exists()


def test_output_never_asserts_unobserved_facts_as_evidence(tmp_path: Path) -> None:
    env = base_env(tmp_path)
    assert run(APPLY, env=env).returncode == 0
    out = run(VERIFY, env=env).stdout + run(ROLLBACK, env=env).stdout
    for stale in ("TRANSPORT=kernel", "SYSTEMD_UNIT=", "VERDICT_CHANGE=", "CONTAINMENT_OWNERSHIP_TOUCHED="):
        for line in out.splitlines():
            if stale in line:
                assert line.startswith(("EXPECTED_", "DESIGN_")), line
    assert "VERIFIED_HOOKS=input" in out


def test_foreign_state_drift_refuses_verify_and_rollback(tmp_path: Path) -> None:
    env = base_env(tmp_path)
    assert run(APPLY, env=env).returncode == 0
    current = Path(env["AEGIS_P4_FS_ROOT"]) / "etc/aegis-idea3-r1i.nft"
    current.write_text(current.read_text() + "# foreign drift\n")
    assert "FOREIGN_STATE_DRIFT" in run(VERIFY, env=env).stderr
    assert "FOREIGN_STATE_DRIFT" in run(ROLLBACK, env=env).stderr
    assert current.exists()


def test_fixture_refuses_a_foreign_existing_target_without_touching_it(tmp_path: Path) -> None:
    env = base_env(tmp_path)
    target = Path(env["AEGIS_P4_FS_ROOT"]) / "etc/aegis-idea3-r1i.nft"
    target.parent.mkdir(parents=True)
    target.write_text("foreign\n")
    result = run(APPLY, env=env)
    assert result.returncode == 1 and "FOREIGN_FILE_ALREADY_EXISTS" in result.stderr
    assert target.read_text() == "foreign\n" and not (Path(env["AEGIS_R1I_WORK_DIR"]) / "OWNERSHIP").exists()


def test_fixture_post_apply_capture_failure_rolls_back_only_proven_owned_state(tmp_path: Path) -> None:
    env = base_env(tmp_path)
    work = Path(env["AEGIS_R1I_WORK_DIR"])
    (work / "POST_STATE").mkdir()  # makes the post-state record fail after the install succeeded
    result = run(APPLY, env=env)
    assert result.returncode == 1
    assert "POST_STATE_RECORD_FAILED" in result.stderr and "ROLLED_BACK_EXACT_OWNED_STATE" in result.stderr
    assert not (Path(env["AEGIS_P4_FS_ROOT"]) / "etc/aegis-idea3-r1i.nft").exists()
    assert (work / "OWNERSHIP").exists() and "ROLLED_BACK_EXACT_OWNED_STATE" in (work / "OUTCOME").read_text()
    again = run(APPLY, env=env)
    assert again.returncode == 1 and "ONE_SHOT_ALREADY_CONSUMED" in again.stderr  # attempt stays consumed


# --------------------------------------------------------------------------- real nft in a private network namespace
# These run the real handlers against the real nft binary inside `unshare -rn` (a throwaway user +
# network namespace). They never touch the host ruleset and are local evidence only: they do NOT
# prove how the Production host's nft normalises state (that stays a LIVE-preflight proof).


def netns_usable() -> bool:
    if not REAL_NFT or not shutil.which("unshare"):
        return False
    probe = subprocess.run(["unshare", "-rn", "sh", "-c", f"{REAL_NFT} list tables"], capture_output=True)
    return probe.returncode == 0


needs_netns = pytest.mark.skipif(not netns_usable(), reason="private user/network namespace with nft unavailable")

SHIM = """#!/bin/sh
echo "$@" >> "$R1I_SHIM_DIR/calls.log"
case "$R1I_SHIM" in
  hide_tables) [ "$1 $2" = "list tables" ] && exit 0 ;;
  capture_fails) [ "$1" = "--stateless" ] && exit 1 ;;
  capture_fails_once)
    if [ "$1" = "--stateless" ] && [ ! -e "$R1I_SHIM_DIR/once" ]; then : > "$R1I_SHIM_DIR/once"; exit 1; fi ;;
  capture_extra_statement)
    if [ "$1" = "--stateless" ]; then "$REAL_NFT" "$@" | sed 's/^\\t}$/\\t\\tcounter\\n\\t}/'; exit 0; fi ;;
  capture_once_delete_fails)
    [ "$1" = "delete" ] && exit 1
    if [ "$1" = "--stateless" ] && [ ! -e "$R1I_SHIM_DIR/once" ]; then : > "$R1I_SHIM_DIR/once"; exit 1; fi ;;
esac
exec "$REAL_NFT" "$@"
"""


def netns(tmp_path: Path, script: str, shim: str = "") -> subprocess.CompletedProcess[str]:
    env = base_env(tmp_path)
    shim_dir = tmp_path / "shim"
    shim_dir.mkdir()
    (shim_dir / "nft").write_text(SHIM)
    (shim_dir / "nft").chmod(0o755)
    env.update(
        AEGIS_P4_FS_ROOT="", AEGIS_R1I_LIVE_AUTHORIZED="YES", PATH=f"{shim_dir}:{os.environ['PATH']}",
        R1I_SHIM=shim, R1I_SHIM_DIR=str(shim_dir), REAL_NFT=str(REAL_NFT), A=str(APPLY), V=str(VERIFY), R=str(ROLLBACK),
    )
    env.pop("AEGIS_P4_FS_ROOT")
    return subprocess.run(["unshare", "-rn", "bash", "-c", script], env=env, text=True, capture_output=True, check=False)


def calls(tmp_path: Path) -> str:
    log = tmp_path / "shim/calls.log"
    return log.read_text() if log.exists() else ""


@needs_netns
def test_real_nft_apply_verify_rollback_removes_only_the_owned_table(tmp_path: Path) -> None:
    script = (
        "nft add table inet aegis_idea3; nft add table inet other_owner\n"
        '"$A" && "$V" && nft list tables && "$R"; echo "rc=$?"; nft list tables'
    )
    result = netns(tmp_path, script)
    assert "R1I_APPLY=PASS" in result.stdout and "R1I_VERIFY=PASS" in result.stdout and "R1I_ROLLBACK=PASS" in result.stdout, result.stderr
    final_tables = result.stdout.split("rc=0")[1]
    assert "table inet aegis_idea3\n" in final_tables and "table inet other_owner" in final_tables
    assert "aegis_idea3_r1i" not in final_tables
    log = calls(tmp_path)
    assert "flush" not in log and "delete table inet aegis_idea3_r1i" in log
    assert "delete table inet aegis_idea3\n" not in log and "delete table inet other_owner" not in log


@needs_netns
def test_existing_table_is_refused_atomically_and_never_merged_or_deleted(tmp_path: Path) -> None:
    # `hide_tables` defeats the advisory pre-check, so only the atomic `create table` can refuse.
    script = (
        "nft add table inet aegis_idea3_r1i; nft add chain inet aegis_idea3_r1i foreign '{ type filter hook output priority 0; }'\n"
        'nft list ruleset > "$AEGIS_R1I_WORK_DIR/../before.txt"; "$A"; echo "rc=$?"; nft list ruleset > "$AEGIS_R1I_WORK_DIR/../after.txt"'
    )
    result = netns(tmp_path, script, shim="hide_tables")
    assert "NFT_ATOMIC_CREATE_REFUSED" in result.stderr and "rc=1" in result.stdout
    assert (tmp_path / "before.txt").read_text() == (tmp_path / "after.txt").read_text()
    assert "chain foreign" in (tmp_path / "after.txt").read_text()
    assert "delete" not in calls(tmp_path) and "flush" not in calls(tmp_path)
    assert not (tmp_path / "work/POST_STATE").exists()


@needs_netns
def test_advisory_precheck_refuses_a_visible_foreign_table(tmp_path: Path) -> None:
    result = netns(tmp_path, 'nft add table inet aegis_idea3_r1i; "$A"; echo "rc=$?"')
    assert "FOREIGN_TABLE_ALREADY_EXISTS" in result.stderr and "rc=1" in result.stdout
    assert not (tmp_path / "work/OWNERSHIP").exists()


@needs_netns
def test_post_apply_capture_failure_recovers_when_ownership_is_provable(tmp_path: Path) -> None:
    result = netns(tmp_path, '"$A"; echo "rc=$?"; nft list tables', shim="capture_fails_once")
    assert "POST_STATE_CAPTURE_FAILED" in result.stderr and "ROLLED_BACK_EXACT_OWNED_STATE" in result.stderr
    assert "aegis_idea3_r1i" not in result.stdout.split("rc=1")[1]
    assert calls(tmp_path).count("delete table inet aegis_idea3_r1i") == 1


@needs_netns
@pytest.mark.parametrize("mode", ["capture_fails", "capture_extra_statement", "capture_once_delete_fails"])
def test_unprovable_or_undeletable_state_stops_with_manual_cleanup_and_never_deletes_broadly(tmp_path: Path, mode: str) -> None:
    result = netns(tmp_path, '"$A"; echo "rc=$?"; nft list tables', shim=mode)
    assert "rc=1" in result.stdout and "MANUAL_CLEANUP_REQUIRED" in result.stderr
    log = calls(tmp_path)
    assert "flush" not in log
    deletes = [line.strip() for line in log.splitlines() if line.startswith("delete")]
    # Only the proven-owned delete may ever be attempted (and only when ownership was provable).
    assert deletes == ([] if mode != "capture_once_delete_fails" else ["delete table inet aegis_idea3_r1i"])
    assert "aegis_idea3_r1i" in result.stdout.split("rc=1")[1]  # left in place for manual cleanup
    assert "MANUAL_CLEANUP_REQUIRED" in (tmp_path / "work/OUTCOME").read_text()
    env = {**os.environ, "AEGIS_R1I_WORK_DIR": str(tmp_path / "work"), "AEGIS_R1I_LIVE_AUTHORIZED": "YES"}
    env.pop("AEGIS_P4_FS_ROOT", None)
    again = subprocess.run(["unshare", "-rn", "bash", "-c", f'"{APPLY}"'], env=env, text=True, capture_output=True, check=False)
    assert "ONE_SHOT_ALREADY_CONSUMED" in again.stderr  # the attempt stays consumed; no retry
