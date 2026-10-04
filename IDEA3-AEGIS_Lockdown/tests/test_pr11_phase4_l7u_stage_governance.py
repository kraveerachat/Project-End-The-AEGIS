"""AEGIS IDEA3 PR11 Phase 4 — L7u stage governance: registration/order, stage gate, one-shot marker, receipt gate, owner-runner contract,
handler contract, and the observability (capture/compare) contract.

Repository-only. Nothing here runs a runner or handler against a host.
"""

from __future__ import annotations

import os
import re
import stat
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))
import l7u_support as s
from test_pr11_phase4_g15_host_artifacts import make_bundle
from test_pr11_phase4_harness import auth_record, gate, gate_fail, k3_record, k3v2_record, today

ROOT = s.ROOT
DEPLOY = s.DEPLOY
LIB = DEPLOY / "p4-l7u-run-lib.sh"
RUNNER = DEPLOY / "owner-run" / "run-l7u-owner.sh"
STAGE = DEPLOY / "stages" / "L7u"
P4_LIB = DEPLOY / "p4-lib.sh"
CAPTURE, COMPARE = DEPLOY / "p4-l0-capture.sh", DEPLOY / "p4-compare.sh"
LOGS = "Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs"
HANDLER_FILES = {"apply.sh", "verify.sh", "rollback.sh", "allow-keys.txt", "allow-listeners.txt"}


def active(path: Path) -> list[str]:
    return [l for l in path.read_text().splitlines() if l.strip() and not l.lstrip().startswith("#")]


def code_only(path: Path) -> str:
    return "\n".join(l for l in path.read_text().splitlines() if not l.lstrip().startswith("#"))


def lib(script: str, *, path_prefix: Path | None = None, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    e = os.environ.copy()
    e["SUDO"] = ""
    if path_prefix:
        e["PATH"] = f"{path_prefix}:{e['PATH']}"
    e.update(env or {})
    return subprocess.run(["bash", "-c", f"source '{LIB}'; {script}"], text=True, capture_output=True, env=e, check=False)


# ── 1. stage registration and ordering ───────────────────────────────────────────────────────────────────────────────────


def test_l7u_is_registered_between_l7_and_l8() -> None:
    line = next(l for l in P4_LIB.read_text().splitlines() if l.strip().startswith("readonly P4_STAGES="))
    stages = line.split('"')[1].split()
    # L8p (device provisioning only, before Recovery) sits between L7u and L8; L7u still directly follows L7.
    assert stages.index("L7") + 1 == stages.index("L7u") and stages.index("L7u") + 1 == stages.index("L8p") < stages.index("L8")
    assert stages[stages.index("L6c"):stages.index("L9") + 1] == ["L6c", "L7", "L7u", "L8p", "F1r", "F1", "L8", "L9"]


def test_l7u_is_a_mutating_stage_with_no_extra_authorization_field() -> None:
    res = subprocess.run(["bash", "-c", f". '{P4_LIB}' && p4_stage_known L7u && p4_stage_mutates L7u && echo MUT; echo \"EXTRA=[$(p4_stage_auth_extra L7u)]\"; p4_stage_gaps L7u"],
                         text=True, capture_output=True, check=False)
    assert res.returncode == 0 and "MUT" in res.stdout and "EXTRA=[]" in res.stdout
    assert "G-11" not in res.stdout and "G-12" not in res.stdout  # no key/credential provisioning is part of L7u


def test_l8_still_owns_the_recovery_authorization_and_l7_is_unchanged() -> None:
    res = subprocess.run(["bash", "-c", f". '{P4_LIB}'; p4_stage_auth_extra L8; p4_stage_auth_extra L7; p4_stage_auth_extra L7u"], text=True, capture_output=True, check=False)
    assert res.stdout.split() == ["recovery_authorization", "d6_notice"]


def test_l7u_handler_directory_is_registered_with_exactly_the_reviewed_files() -> None:
    assert {p.name for p in STAGE.iterdir() if p.is_file()} == HANDLER_FILES | {"allow-keys-rollback.txt"}
    res = subprocess.run(["bash", "-c", f". '{P4_LIB}'; p4_stage_handler_status L7u"], text=True, capture_output=True, check=False)
    assert res.stdout.strip() == "REGISTERED"


# ── 2. stage authorization separation ───────────────────────────────────────────────────────────────────────────────────


def test_a_same_day_l7u_authorization_and_k3_pass_the_stage_gate(tmp_path: Path) -> None:
    res = gate(tmp_path, "--stage", "L7u", "--mode", "live", auth=auth_record("L7u"), k3=k3_record("L7u"))
    assert res.returncode == 0, res.stdout
    for line in ("AUTHORIZATION_RECORD=VALID", "K3_CONFIRMATION=VALID", "ROLLBACK_HANDLER=REGISTERED", "LIVE_STAGE_AUTHORIZED=NO"):
        assert line in res.stdout.splitlines(), line
    assert "STAGE_MUTATES_PRODUCTION=YES" in res.stdout


def test_l7u_accepts_the_m16_owner_self_attestation_k3_for_its_own_stage(tmp_path: Path) -> None:
    res = gate(tmp_path, "--stage", "L7u", "--mode", "simulate", auth=auth_record("L7u"), k3=k3v2_record("L7u"))
    assert res.returncode == 0 and "K3_CONFIRMATION=VALID" in res.stdout


@pytest.mark.parametrize("old", ["L6c", "L7", "L8", "L6b"])
def test_an_authorization_or_k3_for_another_stage_cannot_authorize_l7u(tmp_path: Path, old: str) -> None:
    gate_fail(gate(tmp_path, "--stage", "L7u", "--mode", "simulate", auth=auth_record(old), k3=k3_record("L7u")), "AUTHORIZATION_STAGE_MISMATCH")
    (tmp_path / "k").mkdir()
    gate_fail(gate(tmp_path / "k", "--stage", "L7u", "--mode", "simulate", auth=auth_record("L7u"), k3=k3_record(old)), "K3_STAGE_MISMATCH")


def test_an_old_dated_authorization_or_k3_cannot_authorize_l7u(tmp_path: Path) -> None:
    gate_fail(gate(tmp_path, "--stage", "L7u", "--mode", "simulate", auth=auth_record("L7u", date=today(-1)), k3=k3_record("L7u")), "AUTHORIZATION_STALE")
    (tmp_path / "k").mkdir()
    gate_fail(gate(tmp_path / "k", "--stage", "L7u", "--mode", "simulate", auth=auth_record("L7u"), k3=k3_record("L7u", date=today(-1))), "K3_STALE")


def test_l7u_requires_k3_and_authorization(tmp_path: Path) -> None:
    gate_fail(gate(tmp_path, "--stage", "L7u", "--mode", "simulate", auth=auth_record("L7u")), "K3_MISSING")
    (tmp_path / "a").mkdir()
    gate_fail(gate(tmp_path / "a", "--stage", "L7u", "--mode", "simulate", k3=k3_record("L7u")), "AUTHORIZATION_MISSING")


@pytest.mark.parametrize("extra", ["recovery_authorization=https://example.invalid/r", "d6_notice=pub", "integration_review=kla"])
def test_l7u_authorization_carries_no_recovery_d6_or_integration_field(tmp_path: Path, extra: str) -> None:
    """recovery_authorization is an L8-specific gate; L7u success never authorizes L8 and needs no Pub/D6 or integration notice."""
    gate_fail(gate(tmp_path, "--stage", "L7u", "--mode", "simulate", auth=auth_record("L7u") + extra + "\n", k3=k3_record("L7u")), "AUTHORIZATION_MALFORMED")


def test_l8_gate_is_unchanged_and_still_needs_its_recovery_authorization(tmp_path: Path) -> None:
    gate_fail(gate(tmp_path, "--stage", "L8", "--mode", "simulate",
                   auth=auth_record("L8").replace("recovery_authorization=https://example.invalid/aegis-p4-test-recovery\n", ""),
                   k3=k3_record("L8")), "AUTHORIZATION_MALFORMED")


# ── 3. one-shot marker + receipt gate (bound to the pinned commit) ───────────────────────────────────────────────────────


def test_l7u_one_attempt_marker_is_atomic_final_and_distinct(tmp_path: Path) -> None:
    auth = tmp_path / "auth"
    auth.mkdir()
    for other in ("L6B-ATTEMPT-CONSUMED", "L7-ATTEMPT-CONSUMED", "L6C-ATTEMPT-CONSUMED"):
        (auth / other).write_text("x")
    assert lib(f"l7u_consume_attempt '{auth}'").returncode == 0 and (auth / "L7u-ATTEMPT-CONSUMED").is_file()
    second = lib(f"l7u_consume_attempt '{auth}'")
    assert second.returncode == 1 and "L7U_ATTEMPT_ALREADY_CONSUMED" in second.stderr


def test_l7u_marker_rejects_symlinked_or_missing_auth_dir(tmp_path: Path) -> None:
    real = tmp_path / "real"
    real.mkdir()
    link = tmp_path / "link"
    link.symlink_to(real)
    assert lib(f"l7u_consume_attempt '{link}'").returncode == 1 and lib(f"l7u_consume_attempt '{tmp_path / 'nope'}'").returncode == 1


def test_an_l7_attempt_marker_never_satisfies_l7u(tmp_path: Path) -> None:
    auth = tmp_path / "auth"
    auth.mkdir()
    (auth / "L7-ATTEMPT-CONSUMED").write_text("x")
    assert lib(f"l7u_attempt_unconsumed '{auth}'").returncode == 0
    (auth / "L7u-ATTEMPT-CONSUMED").write_text("x")
    assert lib(f"l7u_attempt_unconsumed '{auth}'").returncode == 1


def git(repo: Path, *args: str) -> None:
    env = dict(os.environ, GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@t", GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@t")
    subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True, env=env)


def make_repo(tmp_path: Path, *, l7: str | None = "`L7_LIVE_ACCEPTANCE = PROVEN`", l7u: str | None = None, l7_uncommitted: bool = False, skip: str = "") -> Path:
    repo = tmp_path / "repo"
    logs = repo / LOGS
    logs.mkdir(parents=True)
    git(repo, "init", "-q")
    for n in (2, 3, 4, 5):
        if f"L{n}" != skip:
            (logs / f"2026-09-2{n}_000000_music_idea3-pr11-l{n}-live-acceptance.md").write_text(f"`L{n}_LIVE_ACCEPTANCE = PROVEN`\n")
    (logs / "2026-09-27_002532_music_idea3-pr11-l6a-live-acceptance.md").write_text("L6A_LIVE_ACCEPTANCE=PROVEN\nL6A_COMPLETE=YES\nL6B_STARTED=NO\n")
    (logs / "2026-09-27_120422_music_idea3-pr11-l6b-attempt2-live-acceptance.md").write_text("> `L6B_LIVE_ACCEPTANCE = PROVEN`\n")
    if l7 is not None and not l7_uncommitted:
        (logs / "2026-09-30_174430_music_idea3-l7-live-acceptance-closeout.md").write_text(l7 + "\n")
    if l7u is not None:
        (logs / "2026-10-02_000000_music_idea3-l7u-live.md").write_text(l7u + "\n")
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "fixture")
    if l7 is not None and l7_uncommitted:
        (logs / "2026-09-30_174430_music_idea3-l7-live-acceptance-closeout.md").write_text(l7 + "\n")
    return repo


def test_receipt_gate_passes_with_l2_to_l6b_and_l7_accepted(tmp_path: Path) -> None:
    res = lib(f"l7u_receipt_gate '{make_repo(tmp_path)}'")
    assert res.returncode == 0, res.stderr


def test_receipt_gate_requires_the_l7_acceptance_receipt(tmp_path: Path) -> None:
    res = lib(f"l7u_receipt_gate '{make_repo(tmp_path, l7=None)}'")
    assert res.returncode == 1 and "L7U_L7_ACCEPTANCE_RECEIPT_MISSING" in res.stderr


def test_receipt_gate_ignores_an_uncommitted_working_tree_l7_receipt(tmp_path: Path) -> None:
    res = lib(f"l7u_receipt_gate '{make_repo(tmp_path, l7_uncommitted=True)}'")
    assert res.returncode == 1 and "L7U_L7_ACCEPTANCE_RECEIPT_MISSING" in res.stderr


@pytest.mark.parametrize("skip", ["L2", "L3", "L4", "L5"])
def test_receipt_gate_still_requires_each_predecessor_acceptance(tmp_path: Path, skip: str) -> None:
    res = lib(f"l7u_receipt_gate '{make_repo(tmp_path, skip=skip)}'")
    assert res.returncode == 1 and f"L{skip[1]}" in res.stderr


def test_receipt_gate_refuses_when_l7u_is_already_accepted(tmp_path: Path) -> None:
    res = lib(f"l7u_receipt_gate '{make_repo(tmp_path, l7u='`L7U_LIVE_ACCEPTANCE = PROVEN`')}'")
    assert res.returncode == 1 and "L7U_ALREADY_ACCEPTED" in res.stderr


def test_receipt_gate_is_not_fooled_by_a_not_proven_l7u_marker(tmp_path: Path) -> None:
    res = lib(f"l7u_receipt_gate '{make_repo(tmp_path, l7u='`L7U_LIVE_ACCEPTANCE = NOT_PROVEN`')}'")
    assert res.returncode == 0, res.stderr


def test_receipt_gate_against_the_real_repository_history() -> None:
    repo = ROOT.parent
    if subprocess.run(["git", "-C", str(repo), "grep", "-qE", "L7_LIVE_ACCEPTANCE ?= ?`? ?PROVEN", "HEAD", "--", LOGS], capture_output=True, check=False).returncode != 0:
        pytest.skip("L7 acceptance receipt not present at HEAD of this checkout")
    res = lib(f"l7u_receipt_gate '{repo}'")
    if subprocess.run(["git", "-C", str(repo), "grep", "-qE", "L7U_LIVE_ACCEPTANCE ?= ?`? ?PROVEN", "HEAD", "--", LOGS], capture_output=True, check=False).returncode == 0:
        assert res.returncode == 1 and "L7U_ALREADY_ACCEPTED" in res.stderr
    else:
        assert res.returncode == 0, res.stderr


def stub(bin_dir: Path, name: str, body: str) -> None:
    bin_dir.mkdir(parents=True, exist_ok=True)
    f = bin_dir / name
    f.write_text("#!/usr/bin/env bash\n" + body + "\n")
    f.chmod(0o755)


def core_show(**over: str) -> str:
    vals = {"LoadState": "loaded", "ActiveState": "active", "SubState": "running", "UnitFileState": "enabled", "Result": "success", "NRestarts": "0", "MainPID": "777"}
    vals.update(over)
    return "\n".join(f"{k}={v}" for k, v in vals.items())


def test_core_running_gate_accepts_only_the_exact_running_baseline_and_mutates_nothing(tmp_path: Path) -> None:
    bin_dir = tmp_path / "bin"
    stub(bin_dir, "systemctl", f'[ "$1" = show ] || {{ echo "MUTATION $*" >> "{tmp_path}/mut"; exit 9; }}\ncat <<EOF\n{core_show()}\nEOF')
    assert lib("l7u_core_running_gate aegis-idea3-core.service", path_prefix=bin_dir).returncode == 0
    assert not (tmp_path / "mut").exists()


@pytest.mark.parametrize("over", [{"ActiveState": "failed"}, {"SubState": "dead"}, {"UnitFileState": "disabled"}, {"Result": "exit-code"},
                                  {"NRestarts": "3"}, {"MainPID": "0"}, {"LoadState": "not-found"}])
def test_core_running_gate_rejects_each_deviation(tmp_path: Path, over: dict[str, str]) -> None:
    bin_dir = tmp_path / "bin"
    stub(bin_dir, "systemctl", f"cat <<EOF\n{core_show(**over)}\nEOF")
    res = lib("l7u_core_running_gate aegis-idea3-core.service", path_prefix=bin_dir)
    assert res.returncode == 1 and "L7U_CORE_NOT_RUNNING_BASELINE" in res.stderr


# ── 4. owner runner contract ────────────────────────────────────────────────────────────────────────────────────────────


def test_runner_files_exist_are_executable_and_syntactically_valid() -> None:
    assert LIB.is_file() and RUNNER.is_file()
    assert stat.S_IMODE(RUNNER.stat().st_mode) & 0o111
    for f in (LIB, RUNNER, *(STAGE / n for n in ("apply.sh", "verify.sh", "rollback.sh"))):
        assert subprocess.run(["bash", "-n", str(f)], check=False).returncode == 0, f


def test_runner_template_is_unpinned_and_refuses_to_run(tmp_path: Path) -> None:
    text = RUNNER.read_text()
    for pin in ("EXPECTED_MAIN=PIN_MAIN_SHA", "OLD_RELEASE_ID=PIN_OLD_RELEASE_ID", "NEW_RELEASE_ID=PIN_NEW_RELEASE_ID"):
        assert pin in text, pin
    res = subprocess.run(["bash", str(RUNNER), str(tmp_path)], text=True, capture_output=True, check=False)
    assert res.returncode == 2 and "not pinned" in res.stdout


@pytest.mark.parametrize("main,old,new", [("not-a-sha", s.OLD_ID, s.NEW_ID), (s.MAIN, "../evil", s.NEW_ID), (s.MAIN, s.OLD_ID, "has space"),
                                          (s.MAIN, s.OLD_ID, s.OLD_ID), (s.MAIN, "PIN_OLD_RELEASE_ID", s.NEW_ID)])
def test_runner_refuses_malformed_or_inconsistent_pins(tmp_path: Path, main: str, old: str, new: str) -> None:
    pinned = tmp_path / "run.sh"
    pinned.write_text(RUNNER.read_text().replace("PIN_MAIN_SHA", main).replace("OLD_RELEASE_ID=PIN_OLD_RELEASE_ID", f'OLD_RELEASE_ID="{old}"')
                      .replace("NEW_RELEASE_ID=PIN_NEW_RELEASE_ID", f'NEW_RELEASE_ID="{new}"'))
    res = subprocess.run(["bash", str(pinned), str(tmp_path)], text=True, capture_output=True, check=False)
    assert res.returncode == 2 and "STOP" in res.stdout


def test_runner_never_runs_as_root_and_needs_sudo_before_any_mutation() -> None:
    text = RUNNER.read_text()
    assert 'id -u)" != 0' in text and text.index("sudo -v") < text.index("l7u_consume_attempt")


def test_every_read_only_gate_and_the_pre_capture_precede_the_one_attempt_marker() -> None:
    """Requirement: PRE evidence exists BEFORE the attempt is consumed; a failing gate or PRE capture must not burn the authorization."""
    text = RUNNER.read_text()
    consume = text.index("l7u_consume_attempt")
    for gate_name in ("p4-stage-gate.sh", "l7u_receipt_gate", "l7u_attempt_unconsumed", "l7u_core_running_gate", "l7u_identity_gate",
                      "l7_disk_gate", "l7_idea2_s10_gate", "preflight", "capture PRE"):
        assert gate_name in text, gate_name
        assert text.index(gate_name) < consume, gate_name
    assert text.index('[ "$GATE_FAILED" = 0 ] || die') < text.index("capture PRE") < consume
    assert text.count("l7u_consume_attempt") == 1


def test_mutation_happens_only_after_the_marker_and_each_handler_runs_once() -> None:
    text = RUNNER.read_text()
    for h in ("apply", "verify", "rollback"):
        assert len(re.findall(rf"handler {h}\.sh", text)) == 1, h
    assert text.index("l7u_consume_attempt") < text.index("handler apply.sh") < text.index("handler verify.sh") < text.index("capture POST")
    assert text.index("capture POST") < text.index('compare "$EVID/pre-root" "$EVID/post-root"')


def test_release_is_built_by_the_existing_builder_before_pre_capture_and_never_duplicated() -> None:
    text = RUNNER.read_text()
    assert "p4-l7-build-release.py" in text and text.index("p4-l7-build-release.py") < text.index("capture PRE")
    assert "p4-l7-install-release.py" not in text  # the engine's apply installs it exactly once, through the real installer


def test_success_is_persistent_and_claims_nothing_beyond_l7u() -> None:
    text = RUNNER.read_text()
    tail = text[text.index("trap - ERR INT TERM\necho \"L7U_LIVE_EXECUTED"):]
    assert "rollback" not in tail.lower().replace("rollback_flow", "")
    for marker in ("L7U_LIVE_ACCEPTANCE=PROVEN (this run only)", "RECOVERY_R1_R8_PROVEN=NO", "LVR_PROVEN=NO", "L8_AUTHORIZED=NO", "L8_STARTED=NO",
                   "ESP32_TOUCHED=NO", "PERSISTENT"):
        assert marker in tail, marker


def test_rollback_flow_is_bounded_never_retries_and_compares_with_zero_allowances_except_restart_volatile_keys() -> None:
    text = RUNNER.read_text()
    assert "NOT retrying" in text and "S-11 HOLD" in text
    assert not re.search(r"\b(while|until)\b", code_only(RUNNER))
    assert not re.search(r"retry|attempt2|attempt_2", "\n".join(l for l in code_only(RUNNER).splitlines() if "NOT retrying" not in l and "do NOT retry" not in l), re.IGNORECASE)
    assert "allow-keys-rollback.txt" in text and text.count("allow-keys-rollback.txt") == 1
    assert 'compare "$EVID/pre-root" "$EVID/rb-root" "$EVID/compare-pre-rb.txt" rb' in text
    assert 'compare "$EVID/pre-root" "$EVID/post-root" "$EVID/compare-pre-post.txt" post' in text
    assert "ALLOW_L6C_RELEASE_FILE" in text and "stage L7u" in text


def test_runner_uses_l7u_records_only_and_no_recovery_authorization() -> None:
    text = RUNNER.read_text()
    assert "--stage L7u --mode live" in text and "authorization-L7u.txt" in text and "k3-L7u.txt" in text and "stage=L7u" in text
    assert "recovery_authorization" not in code_only(RUNNER) and "d6_notice" not in code_only(RUNNER)
    for old in ("authorization-L7.txt", "k3-L7.txt", "authorization-L6c", "k3-L6c", "L7-ATTEMPT-CONSUMED"):
        assert old not in code_only(RUNNER), old


def test_runner_freezes_the_owner_identity_design() -> None:
    text = RUNNER.read_text()
    assert "OPERATOR_USER=kittipat" in text and "OPERATOR_UID=1000" in text
    assert "AEGIS_L7U_LIVE_AUTHORIZED=YES" in text
    assert "aegis-idea3-recovery" in text + LIB.read_text() + (DEPLOY / "p4-l7u-upgrade.py").read_text()


def test_runner_has_no_forbidden_operation() -> None:
    text = code_only(RUNNER) + "\n" + code_only(STAGE / "apply.sh") + "\n" + code_only(STAGE / "verify.sh") + "\n" + code_only(STAGE / "rollback.sh")
    for pat in (r"nmcli\s+(connection|con|device)\s+(up|down|modify|delete)", r"\bnft\s+(add|delete|flush|-f)", r"sysctl\s+-w", r"\bpkill\b", r"\bkillall\b",
                r"\brm\s+-\w*r", r"\bchronyc\b", r"\btwingate\s+(stop|start|restart)", r"\breboot\b", r"/dev/tty", r"esptool", r"platformio", r"pyserial",
                r"mosquitto_pub", r"mosquitto_sub", r"openssl\s+(rand|genrsa|ecparam|req)", r"/dev/urandom", r"stages/L8", r"stages/L9", r"stages/L7/",
                r"\bCUT_UPLINK\b", r"\bRESTORE_UPLINK\b", r"IDEA[12]-", r"systemctl\s+\w+\s+aegis-detection", r"systemctl\s+(restart|stop|start|enable|disable|mask)\b",
                r"recovery_authorization", r"udevadm", r"--device", r"/dev/ttyUSB", r"/dev/ttyACM"):
        assert not re.search(pat, text), pat


def test_runner_performs_no_systemctl_mutation_itself_only_the_handlers_do() -> None:
    assert not re.search(r"systemctl\s+(daemon-reload|restart|stop|start|reload|enable|disable|mask|reset-failed)", code_only(RUNNER))


# ── 5. handler contract ─────────────────────────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("name,verb", [("apply.sh", "apply"), ("verify.sh", "verify"), ("rollback.sh", "rollback")])
def test_handlers_delegate_to_the_engine_and_refuse_without_the_live_flag_and_root(tmp_path: Path, name: str, verb: str) -> None:
    text = (STAGE / name).read_text()
    assert f'p4-l7u-upgrade.py" {verb}' in text or f"p4-l7u-upgrade.py {verb}" in text
    res = subprocess.run(["bash", str(STAGE / name)], text=True, capture_output=True, env={"PATH": os.environ["PATH"], "HOME": str(tmp_path)}, check=False)
    assert res.returncode != 0 and "LIVE_AUTHORIZATION_FLAG_REQUIRED" in res.stdout + res.stderr


def test_allow_keys_name_only_the_exact_approved_upgrade_delta() -> None:
    keys = active(STAGE / "allow-keys.txt")
    assert len(keys) == len(set(keys))
    assert all(re.fullmatch(r"[-A-Za-z0-9@._:/]+", k) and "*" not in k for k in keys)
    required = {
        "host.symlink./opt/aegis-idea3/current.target",
        "host.aegis_idea3.recovery.group.aegis-idea3-recovery",
        "host.aegis_idea3.recovery.runtime_dir", "host.aegis_idea3.recovery.socket",
        "host.aegis_idea3.recovery.core.supplementary_groups", "host.aegis_idea3.recovery.core.process_groups",
        "host.path./run/aegis-idea3-recovery", "host.path./etc/tmpfiles.d/aegis-idea3-recovery.conf",
        "host.path./etc/systemd/system/aegis-idea3-core.service.d",
        "host.aegis_idea3.file./etc/aegis-idea3/core.env.meta",
        "svc.aegis-idea3-core.service.MainPID", "svc.aegis-idea3-core.service.ExecMainStartTimestamp",
    }
    assert required <= set(keys), sorted(required - set(keys))
    # nothing that would hide drift in any other surface
    for k in keys:
        assert not k.startswith(("sysctl.", "idea2.", "listen.", "net.", "fw.", "time.", "mqtt.", "wifi.", "nm.")), k
        assert "credentials" not in k and "/run/aegis-idea3." not in k and not k.endswith("/run/aegis-idea3")
        assert k != "host.aegis_idea3.release_catalog"  # the catalog is approved only by the relational ALLOW_L6C_RELEASE_FILE rule


def test_l7u_adds_no_listener_allowance() -> None:
    assert active(STAGE / "allow-listeners.txt") == []


def test_rollback_allow_keys_are_only_the_restart_volatile_core_properties() -> None:
    assert active(STAGE / "allow-keys-rollback.txt") == ["svc.aegis-idea3-core.service.MainPID", "svc.aegis-idea3-core.service.ExecMainStartTimestamp"]


# ── 6. observability: real capture + real compare on the fixture host ────────────────────────────────────────────────────


FAKE_SYSTEMCTL = """#!/usr/bin/env bash
# fixture systemctl: `show` only, every property reports a not-found/inactive unit. The development workstation may really run the Core, so a
# fixture capture must never depend on the real systemd state.
[ "$1" = show ] || exit 1
shift
while [ $# -gt 0 ]; do
  case "$1" in
    -p) p=$2; shift 2
      case "$p" in
        MainPID | NRestarts) echo "$p=0" ;; LoadState) echo "$p=not-found" ;; ActiveState) echo "$p=inactive" ;;
        SubState) echo "$p=dead" ;; Result) echo "$p=success" ;; *) echo "$p=" ;;
      esac ;;
    *) shift ;;
  esac
done
"""


def real_capture(fx: s.Fx, label: str) -> dict[str, str]:
    """Run the REAL capture script on the fixture root. Fixture-only adjustments: a stub systemctl (see above) and the dropped
    `host.path./opt/aegis-idea3/current` key — inside a fixture root the absolute `current` symlink target resolves against the REAL
    filesystem, so that one presence flag reflects the workstation, not the fixture."""
    evid = fx.tmp / f"evid-{label}"
    stub_dir = fx.tmp / "fakebin"
    stub_dir.mkdir(exist_ok=True)
    (stub_dir / "systemctl").write_text(FAKE_SYSTEMCTL)
    (stub_dir / "systemctl").chmod(0o755)
    env = dict(os.environ, AEGIS_P4_FS_ROOT=str(fx.root), EVID_DIR=str(evid), CAPTURE_LABEL=label, JOURNAL_SINCE="2026-10-01 00:00:00 UTC",
               PATH=f"{stub_dir}:{os.environ['PATH']}")
    res = subprocess.run(["bash", str(CAPTURE)], text=True, capture_output=True, env=env, check=False)
    assert res.returncode in (0, 3), res.stdout + res.stderr
    records: dict[str, str] = {}
    for line in (evid / "host.tsv").read_text().splitlines():
        key, _, value = line.partition("\t")
        if value and value not in ("UNAVAILABLE",) and key != "host.path./opt/aegis-idea3/current" \
                and not key.startswith(("host.identity", "host.kernel", "host.boot_id", "host.twingate")):
            records[key] = value
    return records


def bundle(fx: s.Fx, label: str, records: dict[str, str]) -> Path:
    return make_bundle(fx.tmp / f"bundle-{label}", label, records)


def run_compare(before: Path, after: Path, *, post: bool = False, rb: bool = False, release_id: str | None = None, tmp: Path | None = None) -> subprocess.CompletedProcess[str]:
    env = dict(os.environ, DISK_THRESHOLD_PCT="90")
    if post:
        env["ALLOW_KEYS_FILE"] = str(STAGE / "allow-keys.txt")
        env["ALLOW_LISTENERS_FILE"] = str(STAGE / "allow-listeners.txt")
        f = tmp / "release-allow.txt"
        f.write_text(f"stage L7u\nrelease_id {release_id}\n")
        env["ALLOW_L6C_RELEASE_FILE"] = str(f)
    if rb:
        env["ALLOW_KEYS_FILE"] = str(STAGE / "allow-keys-rollback.txt")
    return subprocess.run(["bash", str(COMPARE), str(before), str(after)], text=True, capture_output=True, env=env, check=False)


def test_capture_exposes_every_l7u_owned_surface_with_non_secret_keys(tmp_path: Path) -> None:
    fx = s.build(tmp_path)
    pre = real_capture(fx, "pre")
    assert pre["host.aegis_idea3.recovery.group.aegis-idea3-recovery"] == "absent"
    assert pre["host.aegis_idea3.recovery.runtime_dir"] == "absent" and pre["host.aegis_idea3.recovery.socket"] == "absent"
    for path in ("/run/aegis-idea3-recovery", "/etc/tmpfiles.d/aegis-idea3-recovery.conf", "/etc/systemd/system/aegis-idea3-core.service.d"):
        assert pre[f"host.path.{path}"] == "absent", path
    fx.engine.apply(fx.cfg, fx.host, fx.system)
    post = real_capture(fx, "post")
    assert post["host.aegis_idea3.recovery.group.aegis-idea3-recovery"] == f"present gid={s.NEW_GROUP_GID} members={s.OPERATOR}"
    assert post["host.symlink./opt/aegis-idea3/current.target"] == s.NEW_LOGICAL
    assert re.fullmatch(r"mode=750 uid=\d+ gid=\d+", post["host.aegis_idea3.recovery.runtime_dir"])
    assert post["host.aegis_idea3.recovery.socket"].startswith("type=socket mode=600 ") or post["host.aegis_idea3.recovery.socket"].startswith("type=socket mode=660 ")
    assert any(k.startswith("host.unit_file./etc/systemd/system/aegis-idea3-core.service.d/10-recovery.conf.sha256") for k in post)
    assert any(k.startswith("host.unit_file./etc/tmpfiles.d/aegis-idea3-recovery.conf.sha256") for k in post)
    assert s.NEW_ID in post["host.aegis_idea3.release_catalog"] and s.OLD_ID in post["host.aegis_idea3.release_catalog"]
    blob = "\n".join(f"{k}={v}" for k, v in {**pre, **post}.items())
    for canary in (s.ENV_SECRET_CANARY, s.PROBE_CANARY):
        assert canary not in blob  # core.env content is never captured (metadata only)
    assert not re.search(r"password|passwd|gshadow|PRIVATE KEY|scrypt\$", blob, re.IGNORECASE)


def test_fixture_pre_to_post_passes_with_exactly_the_approved_delta_and_fails_without_the_allowances(tmp_path: Path) -> None:
    fx = s.build(tmp_path)
    pre = bundle(fx, "pre", real_capture(fx, "pre"))
    fx.engine.apply(fx.cfg, fx.host, fx.system)
    post = bundle(fx, "post", real_capture(fx, "post"))
    bare = run_compare(pre, post)
    assert bare.returncode == 1 and "NEW_OR_WORSENED_DRIFT" in bare.stdout
    ok = run_compare(pre, post, post=True, release_id=s.NEW_ID, tmp=tmp_path)
    assert ok.returncode == 0, ok.stdout + ok.stderr
    assert "FINDINGS_NEW_OR_WORSENED_DRIFT=0" in ok.stdout and "L6C_RELEASE_INSTALLED" in ok.stdout


@pytest.mark.parametrize("surface", ["current", "core_env", "dropin", "tmpfiles", "group", "socket", "runtime_dir"])
def test_a_mutation_outside_the_approved_delta_is_not_laundered_by_the_allowances(tmp_path: Path, surface: str) -> None:
    fx = s.build(tmp_path)
    pre_records = real_capture(fx, "pre")
    pre = bundle(fx, "pre", pre_records)
    fx.engine.apply(fx.cfg, fx.host, fx.system)
    post_records = real_capture(fx, "post")
    if surface == "current":  # value-level: approved KEY, but the exact-value proof is the engine delta check
        post_records["host.symlink./opt/aegis-idea3/current.target"] = "/opt/aegis-idea3/releases/intruder"
        with pytest.raises(fx.engine.Refusal):
            fx.engine.delta(pre_records, post_records, fx.cfg, s.NEW_GROUP_GID, alert_gid=s.NEW_ALERT_GROUP_GID)
        return
    assert fx.engine.delta(pre_records, post_records, fx.cfg, s.NEW_GROUP_GID, alert_gid=s.NEW_ALERT_GROUP_GID)["L7U_DELTA"] == "PASS"
    if surface == "core_env":
        post_records["host.aegis_idea3.file./etc/aegis-idea3/credentials/x.meta"] = "mode=600 uid=0 gid=0 size=1 mtime=1"
    elif surface == "dropin":
        post_records["host.unit_file./etc/systemd/system/aegis-idea3-core.service.d/99-extra.conf.sha256"] = "0" * 64
    elif surface == "tmpfiles":
        post_records["host.unit_file./etc/tmpfiles.d/evil.conf.sha256"] = "0" * 64
    elif surface == "group":
        post_records["host.aegis_idea3.recovery.group.aegis-idea3-recovery"] = f"present gid={s.NEW_GROUP_GID} members={s.OPERATOR},mallory"
    elif surface == "socket":
        post_records["host.aegis_idea3.recovery.socket"] = "type=socket mode=666 uid=952 gid=1000"
    elif surface == "runtime_dir":
        post_records["host.aegis_idea3.recovery.runtime_dir"] = "mode=755 uid=952 gid=1000"
    if surface in ("group", "socket", "runtime_dir"):
        with pytest.raises(fx.engine.Refusal):
            fx.engine.delta(pre_records, post_records, fx.cfg, s.NEW_GROUP_GID, alert_gid=s.NEW_ALERT_GROUP_GID)
        return
    res = run_compare(pre, bundle(fx, "post", post_records), post=True, release_id=s.NEW_ID, tmp=tmp_path)
    assert res.returncode == 1 and "NEW_OR_WORSENED_DRIFT" in res.stdout


def test_fixture_pre_to_rollback_is_zero_drift_with_no_allowances(tmp_path: Path) -> None:
    fx = s.build(tmp_path, fail="unhealthy_after")
    pre = bundle(fx, "pre", real_capture(fx, "pre"))
    with pytest.raises(fx.engine.Refusal):
        fx.engine.apply(fx.cfg, fx.host, fx.system)
    fx.system.state.fail = ""
    fx.engine.rollback(fx.cfg, fx.host, fx.system)
    rb = bundle(fx, "rb", real_capture(fx, "rb"))
    res = run_compare(pre, rb)
    assert res.returncode == 0, res.stdout + res.stderr
    assert "FINDINGS_NEW_OR_WORSENED_DRIFT=0" in res.stdout and "FINDINGS_APPROVED_CHANGE=0" in res.stdout


def test_a_residual_after_rollback_is_caught_by_pre_to_rb(tmp_path: Path) -> None:
    fx = s.build(tmp_path, fail="unhealthy_after")
    pre = bundle(fx, "pre", real_capture(fx, "pre"))
    with pytest.raises(fx.engine.Refusal):
        fx.engine.apply(fx.cfg, fx.host, fx.system)
    fx.system.state.fail = ""
    fx.engine.rollback(fx.cfg, fx.host, fx.system)
    fx.p("/etc/tmpfiles.d").joinpath("aegis-idea3-recovery.conf").write_text(s.TMPFILES_TEMPLATE.read_text())  # residue
    res = run_compare(pre, bundle(fx, "rb", real_capture(fx, "rb")))
    assert res.returncode == 1


def test_restart_volatile_core_properties_are_the_only_thing_the_rollback_compare_may_approve(tmp_path: Path) -> None:
    base = {"svc.aegis-idea3-core.service.MainPID": "100", "svc.aegis-idea3-core.service.ExecMainStartTimestamp": "t1",
            "svc.aegis-idea3-core.service.NRestarts": "0", "svc.aegis-idea3-core.service.ActiveState": "active"}
    before = make_bundle(tmp_path / "b", "b", base)
    restarted = make_bundle(tmp_path / "a", "a", {**base, "svc.aegis-idea3-core.service.MainPID": "200", "svc.aegis-idea3-core.service.ExecMainStartTimestamp": "t2"})
    assert run_compare(before, restarted, rb=True).returncode == 0
    assert run_compare(before, restarted).returncode == 1
    crashed = make_bundle(tmp_path / "c", "c", {**base, "svc.aegis-idea3-core.service.ActiveState": "failed"})
    assert run_compare(before, crashed, rb=True).returncode == 1


@pytest.mark.parametrize("line", ["stage L7u\nrelease_id rel-a\n"])
def test_the_release_allow_file_accepts_the_l7u_stage_token(tmp_path: Path, line: str) -> None:
    from test_pr11_phase4_l6c_capture_gap import RELEASE_CATALOG_KEY

    before = make_bundle(tmp_path / "b", "b", {RELEASE_CATALOG_KEY: "old:" + "1" * 64})
    after = make_bundle(tmp_path / "a", "a", {RELEASE_CATALOG_KEY: "old:" + "1" * 64 + ",rel-a:" + "2" * 64})
    f = tmp_path / "allow.txt"
    f.write_text(line)
    env = dict(os.environ, DISK_THRESHOLD_PCT="90", ALLOW_L6C_RELEASE_FILE=str(f))
    res = subprocess.run(["bash", str(COMPARE), str(before), str(after)], text=True, capture_output=True, env=env, check=False)
    assert res.returncode == 0, res.stdout + res.stderr
    assert "L6C_RELEASE_INSTALLED" in res.stdout


@pytest.mark.parametrize("line", ["stage L7u\nstage L6c\nrelease_id rel-a\n", "stage L7\nrelease_id rel-a\n", "stage L7u\nstage L7u\nrelease_id rel-a\n",
                                  "stage L7u\nrelease_id rel-a\nrelease_id rel-b\n", "stage L7U\nrelease_id rel-a\n"])
def test_the_release_allow_file_stays_strict_with_the_l7u_token(tmp_path: Path, line: str) -> None:
    before = make_bundle(tmp_path / "b", "b", {"host.aegis_idea3.release_catalog": "absent"})
    after = make_bundle(tmp_path / "a", "a", {"host.aegis_idea3.release_catalog": "rel-a:" + "1" * 64})
    f = tmp_path / "bad.txt"
    f.write_text(line)
    env = dict(os.environ, DISK_THRESHOLD_PCT="90", ALLOW_L6C_RELEASE_FILE=str(f))
    res = subprocess.run(["bash", str(COMPARE), str(before), str(after)], text=True, capture_output=True, env=env, check=False)
    assert res.returncode == 2 and "STOP" in res.stdout


# ── 7. evidence secret scan and operator identity gate ──────────────────────────────────────────────────────────────────


def test_secret_scan_passes_clean_evidence_and_reports_only_counts(tmp_path: Path) -> None:
    evid = tmp_path / "evid"
    evid.mkdir()
    (evid / "capture.log").write_text("host.aegis_idea3.recovery.group.aegis-idea3-recovery\tpresent gid=949 members=kittipat\n")
    res = lib(f"l7u_secret_scan '{evid}' '{sys.executable}'")
    assert res.returncode == 0 and "SECRET_SCAN_FILES=1 SECRET_SCAN_HITS=0" in res.stdout


@pytest.mark.parametrize("payload", ["-----BEGIN PRIVATE KEY-----\nabc\n", "AEGIS_MQTT_PASS=hunter2-canary\n", "AEGIS_ADMIN_PIN=\n",
                                     "scrypt$16384$8$1$" + "a" * 32 + "$" + "b" * 64 + "\n"])
def test_secret_scan_fails_on_any_secret_shape_and_never_prints_the_value(tmp_path: Path, payload: str) -> None:
    evid = tmp_path / "evid"
    (evid / "sub").mkdir(parents=True)
    (evid / "sub" / "leak.txt").write_text(payload)
    res = lib(f"l7u_secret_scan '{evid}' '{sys.executable}'")
    assert res.returncode == 1 and "SECRET_SCAN_HITS=1" in res.stdout
    assert "hunter2-canary" not in res.stdout + res.stderr and "PRIVATE KEY" not in res.stdout + res.stderr


def test_identity_gate_requires_the_exact_frozen_operator(tmp_path: Path) -> None:
    me_user, me_uid = subprocess.run(["id", "-un"], capture_output=True, text=True, check=False).stdout.strip(), os.getuid()
    assert lib(f"l7u_identity_gate '{me_user}' '{me_uid}'").returncode == 0
    for user, uid in ((me_user, me_uid + 1), ("nobody-such-user", me_uid), ("", me_uid), (me_user, "0"), (me_user, "abc")):
        res = lib(f"l7u_identity_gate '{user}' '{uid}'")
        assert res.returncode == 1 and "L7U_OPERATOR_IDENTITY" in res.stderr
