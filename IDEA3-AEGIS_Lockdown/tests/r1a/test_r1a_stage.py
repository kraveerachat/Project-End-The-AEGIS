"""Hermetic R1A stage tests: registration, inert owner runner, predecessor gates, one-attempt state machine, real-event boundary and evidence-preserving rollback.

No network, no Production database, no systemctl mutation, no journal write. R1A is registered as a MUTATING governed stage; the repository still carries
R1A_LIVE_EXECUTED=NO and never promotes F1_REAL_DETECTOR_ACCEPTANCE or R1_VERIFIED."""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
P4 = ROOT / "deploy/pr11-phase4"
STG = P4 / "stages/R1A"
LIB = P4 / "p4-r1a-run-lib.sh"
P4_LIB = P4 / "p4-lib.sh"
RUNNER = P4 / "owner-run/run-r1a-owner.sh"
LOGS = "Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs"
R1A_FILES = [STG / "apply.sh", STG / "verify.sh", STG / "rollback.sh", LIB, RUNNER]

F1_RECEIPT = f"{LOGS}/2026-10-04_233030_music_idea3-f1-attempt2-live-closeout.md"
FOUNDATION = f"{LOGS}/2026-10-05_005444_music_idea3-r1-real-detector-acceptance.md"
F1U_RECEIPT = f"{LOGS}/2026-10-05_041108_music_idea3-f1u-live-closeout.md"
R1I_RECEIPT = f"{LOGS}/2026-10-05_063546_music_idea3-r1i-live-closeout.md"
RELEASE = "912b18005bb2fc80bb4e8d1fe8aa88803ac27314"


def bash(script: str, *, env: dict[str, str] | None = None, cwd: Path | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["bash", "-c", script], env={**os.environ, **(env or {})}, text=True, capture_output=True, cwd=cwd, check=False)


def code_lines(path: Path) -> list[str]:
    """Executable lines only (comments and blank lines dropped) for the static forbidden-action audit."""
    return [line for line in path.read_text().splitlines() if line.strip() and not line.lstrip().startswith("#")]


# --------------------------------------------------------------------------- registration


def stages() -> list[str]:
    text = P4_LIB.read_text()
    return next(line for line in text.splitlines() if line.startswith("readonly P4_STAGES=")).split('"')[1].split()


def test_r1a_is_registered_exactly_once_between_r1i_and_l8() -> None:
    order = stages()
    assert order.count("R1A") == 1
    assert order.index("F1u") < order.index("R1I") < order.index("R1A") < order.index("L8") < order.index("L9")
    assert order[order.index("R1I") + 1] == "R1A"


def test_r1a_is_a_mutating_stage_with_no_gap_and_no_authorization_extra() -> None:
    out = bash(f'. "{P4_LIB}"; p4_stage_known R1A && p4_stage_mutates R1A && echo MUTATES; p4_stage_gaps R1A; echo "extra=[$(p4_stage_auth_extra R1A)]"').stdout.split("\n")
    assert out[0] == "MUTATES" and out[1] == "none" and out[2] == "extra=[]"


def test_r1a_handler_surface_is_complete_and_registered() -> None:
    for name in ("apply.sh", "verify.sh", "rollback.sh", "allow-keys.txt", "allow-listeners.txt"):
        assert (STG / name).is_file()
    assert bash(f'. "{P4_LIB}"; p4_stage_handler_status R1A').stdout.strip() == "REGISTERED"


def test_documented_operational_order_names_r1a_and_recovery_stays_after_it() -> None:
    assert "F1u -> R1I -> R1A -> Recovery R2-R8" in P4_LIB.read_text()
    readme = (P4 / "README.md").read_text()
    assert "R1I -> R1A -> Recovery R2-R8" in readme


# --------------------------------------------------------------------------- owner runner (inert template)


def test_committed_runner_refuses_while_unpinned_and_touches_nothing(tmp_path: Path) -> None:
    result = bash(f'bash "{RUNNER}" "{tmp_path}"')
    assert result.returncode == 2 and "runner is not pinned" in result.stdout
    assert list(tmp_path.iterdir()) == []
    for pin in ("EXPECTED_MAIN", "OPERATOR_USER", "OPERATOR_UID", "RELEASE_ID", "PRODUCTION_DETECTOR_SHA256", "DETECTOR_UNIT_SHA256", "RECOVERY_CORE_SHA256",
                "R1_ACCEPTANCE_SHA256", "R1I_TOOL_SHA256", "AUDIT_DB", "DETECTOR_UID", "EXPECTED_SOURCE_IP", "OBSERVE_SECONDS"):
        assert f"{pin}=PIN_" in RUNNER.read_text()


def pinned_copy(tmp_path: Path, **override: str) -> Path:
    pins = {
        "EXPECTED_MAIN": "a" * 40, "OPERATOR_USER": "owner", "OPERATOR_UID": "1000", "RELEASE_ID": RELEASE, "PRODUCTION_DETECTOR_SHA256": "b" * 64,
        "DETECTOR_UNIT_SHA256": "c" * 64, "RECOVERY_CORE_SHA256": "d" * 64, "R1_ACCEPTANCE_SHA256": "e" * 64, "R1I_TOOL_SHA256": "f" * 64,
        "AUDIT_DB": "/var/lib/x/audit.db", "DETECTOR_UID": "948", "EXPECTED_SOURCE_IP": "203.0.113.9", "OBSERVE_SECONDS": "600", **override,
    }
    text = RUNNER.read_text()
    for key, value in pins.items():
        text = re.sub(rf"^{key}=PIN_\w+$", f"{key}={value}", text, flags=re.M)
    text = text.replace("PIN_PYTHON_BIN", "/usr/bin/python3").replace("/home/PIN_OPERATOR_HOME/PIN_PINNED_WORKTREE_NOT_A_REAL_PATH", str(ROOT.parent))
    text = text.replace("/PIN_EVIDENCE_ROOT/", f"{tmp_path}/evidence/")
    path = tmp_path / "frozen.sh"
    path.write_text(text)
    return path


def test_pinned_runner_refuses_malformed_pins_root_overrides_and_missing_auth(tmp_path: Path) -> None:
    bad = {"EXPECTED_MAIN": "abc", "R1_ACCEPTANCE_SHA256": "zz", "EXPECTED_SOURCE_IP": "not-an-ip", "OBSERVE_SECONDS": "0", "AUDIT_DB": "relative/db", "OPERATOR_UID": "0"}
    for key, value in bad.items():
        result = bash(f'bash "{pinned_copy(tmp_path / key if False else tmp_path, **{key: value})}" "{tmp_path}"')
        assert result.returncode == 2, key
    frozen = pinned_copy(tmp_path)
    for var in ("AEGIS_P4_FS_ROOT", "P4_FS_ROOT", "AEGIS_P4_HANDLER_DIR", "AEGIS_R1A_STEP", "AEGIS_R1A_LIVE_AUTHORIZED", "AEGIS_R1I_LIVE_AUTHORIZED"):
        result = bash(f'bash "{frozen}" "{tmp_path}"', env={var: "x"})
        assert result.returncode == 2 and "environment override" in result.stdout, var
    assert bash(f'bash "{frozen}"').returncode == 2  # no AUTH_DIR
    assert not (tmp_path / "evidence").exists()


def test_wrong_operator_is_refused_before_sudo_or_any_file_is_created(tmp_path: Path) -> None:
    frozen = pinned_copy(tmp_path, OPERATOR_USER="someone-else", OPERATOR_UID="4242")
    result = bash(f'bash "{frozen}" "{tmp_path}"')
    assert result.returncode == 1 and "operator identity" in (result.stdout + result.stderr)
    assert not (tmp_path / "evidence").exists() and not any(tmp_path.glob("*/R1A-ATTEMPT-CONSUMED"))


def test_runner_never_creates_the_marker_itself_and_drives_the_library_state_machine() -> None:
    text = RUNNER.read_text()
    assert "\n".join(code_lines(RUNNER)).count("r1a_run_attempt") == 1 and "r1a_consume_attempt" not in "\n".join(code_lines(RUNNER))
    assert not re.search(r">\s*\"?\$AUTH_DIR/R1A-ATTEMPT-CONSUMED", "\n".join(code_lines(RUNNER)))  # the runner may only READ the marker
    for hook in ("pregates", "baseline", "regate", "observe", "final", "verify", "preserve_evidence"):
        assert f"r1a_hook_{hook}()" in text


def test_runner_binds_fresh_same_day_stage_records_main_runner_and_source_ip() -> None:
    text = RUNNER.read_text()
    for needle in ("authorization-R1A.txt", "k3-R1A.txt", "date=$TODAY", "stage=R1A", "$EXPECTED_MAIN", "$RUNNER_SHA256", "$EXPECTED_SOURCE_IP", "p4-stage-gate.sh\" --stage R1A --mode live"):
        assert needle in text
    assert "authorization-R1I" not in text and "authorization-F1u" not in text


def test_all_preattempt_gates_precede_the_baseline_and_nothing_pre_attempt_consumes() -> None:
    text = RUNNER.read_text()
    gates = text[text.index("pregates() {"):text.index("CORE_PRE=\"\"")]
    for needle in ("rev-parse HEAD", "r1a_digest_gate", "authorization-R1A.txt", "p4-stage-gate.sh", "r1a_receipt_gate", "r1a_attempt_unconsumed", "l7_disk_gate",
                   "r1a_r1i_present_gate", "l7u_core_running_gate", "f1u_detector_running_gate", "production_detector.py", "DETECTOR_UNIT_SHA256", "r1a_current_release_gate",
                   "r1a_journal_access_gate"):
        assert needle in gates, needle
    assert "R1A-ATTEMPT-CONSUMED" not in gates and "r1a_consume_attempt" not in gates


# --------------------------------------------------------------------------- predecessor receipt gates


def git(repo: Path, *args: str) -> None:
    subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True)


def receipt_repo(tmp_path: Path, **change: str | None) -> Path:
    repo = tmp_path / "repo"
    files = {
        F1_RECEIPT: "- `F1_LIVE_RESULT=PASS`\n- `F1_PRODUCTION_DEPLOYED=YES`\n- `F1_DETECTOR_STARTED=YES`\n",
        FOUNDATION: "- `R1_EVIDENCE_VERIFIER_IMPLEMENTED=YES`\n- `F1_REAL_DETECTOR_ACCEPTANCE=NOT_PROVEN`\n- `R1_VERIFIED=NOT_CLAIMED`\n",
        F1U_RECEIPT: f"release `{RELEASE}` was installed and activated.\nF1u proves deployment only.\n",
        R1I_RECEIPT: "\n".join(f"- `{x}`" for x in (
            "R1I_LIVE=CLOSED_PASS", "R1I_LIVE_EXECUTED=YES", "R1I_PRODUCTION_DEPLOYED=YES", "R1I_ATTEMPT_CONSUMED=YES", "R1I_RERUN_ALLOWED=NO",
            "PRODUCTION_NFT_NORMALIZATION=PASS_OBSERVED_LIVE", "F1_REAL_DETECTOR_ACCEPTANCE=NOT_PROVEN", "R1_VERIFIED=NOT_CLAIMED")) + "\n",
    }
    for key, value in change.items():
        if value is None:
            files.pop(key, None)
        else:
            files[key] = value
    repo.mkdir()
    git(repo, "init", "-q")
    git(repo, "config", "user.email", "t@example.invalid")
    git(repo, "config", "user.name", "t")
    for rel, text in files.items():
        target = repo / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text)
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "x", "--allow-empty")
    return repo


def gate(repo: Path) -> subprocess.CompletedProcess[str]:
    return bash(f'. "{LIB}"; r1a_receipt_gate "{repo}" {RELEASE}')


def test_receipt_gate_passes_only_with_the_full_canonical_predecessor_state(tmp_path: Path) -> None:
    result = gate(receipt_repo(tmp_path))
    assert result.returncode == 0, result.stderr


@pytest.mark.parametrize("missing", [F1_RECEIPT, FOUNDATION, F1U_RECEIPT, R1I_RECEIPT])
def test_a_missing_predecessor_receipt_fails(tmp_path: Path, missing: str) -> None:
    assert gate(receipt_repo(tmp_path, **{missing: None})).returncode == 1


def test_r1i_closeout_must_carry_the_exact_success_state(tmp_path: Path) -> None:
    for drop in ("R1I_LIVE=CLOSED_PASS", "R1I_ATTEMPT_CONSUMED=YES", "R1I_RERUN_ALLOWED=NO", "PRODUCTION_NFT_NORMALIZATION=PASS_OBSERVED_LIVE"):
        text = "\n".join(f"- `{x}`" for x in (
            "R1I_LIVE=CLOSED_PASS", "R1I_LIVE_EXECUTED=YES", "R1I_PRODUCTION_DEPLOYED=YES", "R1I_ATTEMPT_CONSUMED=YES", "R1I_RERUN_ALLOWED=NO",
            "PRODUCTION_NFT_NORMALIZATION=PASS_OBSERVED_LIVE", "F1_REAL_DETECTOR_ACCEPTANCE=NOT_PROVEN", "R1_VERIFIED=NOT_CLAIMED") if x != drop) + "\n"
        shutil.rmtree(tmp_path / "repo", ignore_errors=True)
        assert gate(receipt_repo(tmp_path, **{R1I_RECEIPT: text})).returncode == 1, drop


@pytest.mark.parametrize("claim", ["R1I_LIVE=FAIL", "R1I_RERUN_ALLOWED=YES", "F1_REAL_DETECTOR_ACCEPTANCE=PROVEN", "R1_VERIFIED=YES", "RECOVERY_R1_R8_PROVEN=YES",
                                   "R1A_LIVE_EXECUTED=YES", "R1A_LIVE=CLOSED_PASS", "R1A_ATTEMPT_CONSUMED=YES"])
def test_contradictory_duplicate_or_already_recorded_state_fails(tmp_path: Path, claim: str) -> None:
    extra = f"{LOGS}/2026-10-06_000000_music_idea3-contradiction.md"
    assert gate(receipt_repo(tmp_path, **{extra: f"- `{claim}`\n"})).returncode == 1


def test_a_second_r1i_success_receipt_is_ambiguous(tmp_path: Path) -> None:
    extra = f"{LOGS}/2026-10-06_000000_music_idea3-r1i-duplicate.md"
    assert gate(receipt_repo(tmp_path, **{extra: "- `R1I_LIVE=CLOSED_PASS`\n"})).returncode == 1


def test_f1u_closeout_must_carry_the_pinned_release(tmp_path: Path) -> None:
    assert bash(f'. "{LIB}"; r1a_receipt_gate "{receipt_repo(tmp_path)}" {"1" * 40}').returncode == 1


# --------------------------------------------------------------------------- one-attempt state machine


HOOKS = """
LOGF="$1"
mark() { echo "$1" >> "$LOGF"; }
r1a_hook_pregates() { mark pregates; [ "${FAIL_AT:-}" != pregates ]; }
r1a_hook_baseline() { mark baseline; [ "${FAIL_AT:-}" != baseline ]; }
r1a_hook_regate() { mark regate; [ "${FAIL_AT:-}" != regate ]; }
r1a_hook_observe() { mark "observe:$1:marker=$([ -e "$AUTH/R1A-ATTEMPT-CONSUMED" ] && echo yes || echo no)"; [ "${FAIL_AT:-}" != observe ]; }
r1a_hook_final() { mark final; [ "${FAIL_AT:-}" != final ]; }
r1a_hook_verify() { mark verify; [ "${FAIL_AT:-}" != verify ]; }
r1a_hook_preserve_evidence() { mark "preserve:$1"; }
"""


def attempt(tmp_path: Path, fail_at: str = "", seconds: str = "30") -> tuple[subprocess.CompletedProcess[str], list[str]]:
    auth = tmp_path / "auth"
    auth.mkdir(exist_ok=True)
    log = tmp_path / "hooks.log"
    script = f'AUTH="{auth}"\n. "{LIB}"\nSUDO=""\n{HOOKS}\nr1a_run_attempt "$AUTH" {seconds}\n'
    result = subprocess.run(["bash", "-c", script, "x", str(log)], env={**os.environ, "FAIL_AT": fail_at}, text=True, capture_output=True)
    return result, (log.read_text().split() if log.exists() else [])


def test_success_orders_gates_before_the_marker_and_the_marker_before_observation(tmp_path: Path) -> None:
    result, calls = attempt(tmp_path)
    assert result.returncode == 0, result.stderr
    assert calls == ["pregates", "baseline", "regate", "observe:30:marker=yes", "final", "verify"]
    out = result.stdout
    assert out.index("R1A_ATTEMPT_CONSUMED=YES") < out.index("R1A_EVENT_WINDOW_OPEN=YES") < out.index("WAITING_FOR_GENUINE_EXTERNAL_EVENT=YES") < out.index("R1A_RESULT=PASS")
    assert "R1A_PROMOTION=NOT_AUTOMATIC" in out and (tmp_path / "auth/R1A-ATTEMPT-CONSUMED").is_file()


@pytest.mark.parametrize("stage", ["pregates", "baseline", "regate"])
def test_pre_attempt_failures_do_not_consume_the_marker_or_open_a_window(tmp_path: Path, stage: str) -> None:
    result, calls = attempt(tmp_path, fail_at=stage)
    assert result.returncode == 1 and "R1A_ATTEMPT_CONSUMED=NO" in result.stdout
    assert not (tmp_path / "auth/R1A-ATTEMPT-CONSUMED").exists()
    assert "R1A_EVENT_WINDOW_OPEN=YES" not in result.stdout and not any(c.startswith(("observe", "final", "verify")) for c in calls)


@pytest.mark.parametrize("stage", ["observe", "final", "verify"])
def test_any_post_marker_failure_is_consumed_preserved_and_never_retried(tmp_path: Path, stage: str) -> None:
    result, calls = attempt(tmp_path, fail_at=stage)
    assert result.returncode == 1
    assert "R1A_RESULT=FAIL" in result.stdout and "R1A_ATTEMPT_CONSUMED=YES" in result.stdout and "R1A_RERUN_ALLOWED=NO" in result.stdout
    assert calls.count("final") <= 1 and calls.count("verify") <= 1 and sum(c.startswith("observe") for c in calls) == 1  # no retry loop around any hook
    assert calls[-1] == f"preserve:{stage}"
    assert (tmp_path / "auth/R1A-ATTEMPT-CONSUMED").is_file()


def test_a_second_attempt_on_a_consumed_marker_is_refused_before_any_hook(tmp_path: Path) -> None:
    attempt(tmp_path, fail_at="observe")  # e.g. timeout / no event: still consumed
    (tmp_path / "hooks.log").unlink()
    result, calls = attempt(tmp_path)
    assert result.returncode == 1 and "R1A_ATTEMPT_ALREADY_CONSUMED" in result.stderr
    assert calls == [] or calls == ["pregates"]


def test_marker_creation_is_exclusive_and_never_removed_by_any_code(tmp_path: Path) -> None:
    (tmp_path / "auth").mkdir()
    marker = tmp_path / "auth/R1A-ATTEMPT-CONSUMED"
    marker.write_text("owner-kept\n")
    result = bash(f'. "{LIB}"; r1a_consume_attempt "{tmp_path / "auth"}"')
    assert result.returncode == 1 and marker.read_text() == "owner-kept\n"
    for path in R1A_FILES:
        assert not re.search(r"\brm\b|unlink|truncate", "\n".join(code_lines(path))), path


def test_observation_seconds_must_be_a_bounded_positive_integer(tmp_path: Path) -> None:
    for bad in ("0", "-1", "abc", "9999999", "1;ls"):
        result, calls = attempt(tmp_path, seconds=f"'{bad}'")
        assert result.returncode == 1 and calls == [], bad


# --------------------------------------------------------------------------- real-event boundary and self-audit


FORBIDDEN = [
    r"\bnmap\b", r"\bnc\b", r"\bnetcat\b", r"\bncat\b", r"\bcurl\b", r"\bwget\b", r"\bssh\b", r"\bsocat\b", r"\bscapy\b", r"\blogger\b", r"\bhping3?\b", r"\bping\b",
    r"/dev/(tcp|udp)", r"alert\.sock", r"\bsendto\b", r"\bsystemctl\s+(start|stop|restart|reload|kill|enable|disable|mask|daemon-reload|reset-failed)\b",
    r"\bnft\s+(add|delete|flush|insert|replace|create|-f|destroy)\b", r"\bINSERT\b", r"\bUPDATE\b", r"\bDELETE\b", r"\bsqlite3?\b", r"\bpython3?\s+-c\b.*\bsocket\b",
]


@pytest.mark.parametrize("path", R1A_FILES, ids=lambda p: p.name)
def test_no_traffic_alert_journal_injection_nft_or_lifecycle_mutation_path_exists(path: Path) -> None:
    for line in code_lines(path):
        for pattern in FORBIDDEN:
            assert not re.search(pattern, line, re.I if pattern in (r"\bINSERT\b", r"\bUPDATE\b", r"\bDELETE\b") else 0), (path.name, pattern, line)


def test_only_read_only_nft_systemctl_and_journalctl_forms_are_used() -> None:
    text = "\n".join("\n".join(code_lines(p)) for p in R1A_FILES)
    for match in re.finditer(r"\bnft\b[^\n|]*", text):
        assert re.search(r"\blist\b", match.group(0)) or "nft_" in match.group(0) or "--stateless" in match.group(0), match.group(0)
    for match in re.finditer(r"\bsystemctl\s+\w+", text):
        assert match.group(0).split()[1] == "show", match.group(0)
    for match in re.finditer(r"\bjournalctl\b[^\n]*", text):
        assert "-o json" in match.group(0) and "--no-pager" in match.group(0)


def test_the_runner_and_handlers_never_write_the_audit_store_core_socket_or_journal() -> None:
    text = "\n".join("\n".join(code_lines(p)) for p in R1A_FILES)
    assert "mode=rw" not in text and "send_alert" not in text and "alert.sock" not in text
    assert "aegis_soc.r1_acceptance" in text  # the read-only observer/verifier is the only Python entry point
    assert "aegis_soc.production_detector" not in text and "aegis_soc.recovery_core" not in text and "aegis_soc.alert_sink" not in text


def test_the_stage_never_touches_r1i_blocked_ipv4_or_the_current_pointer_except_to_read_it() -> None:
    text = "\n".join("\n".join(code_lines(p)) for p in R1A_FILES)
    assert "blocked_ipv4" not in text
    assert not re.search(r"\bln\s+-|\bmv\s", text)
    assert "delete table" not in text and "r1i-input-instrumentation/rollback.sh" not in text and "r1i-input-instrumentation/apply.sh" not in text
    assert text.count("readlink") >= 1  # the pointer is only READ


# --------------------------------------------------------------------------- handlers: evidence-preserving rollback, guarded apply, verify


def test_rollback_is_evidence_preserving_bounded_and_acts_on_nothing() -> None:
    result = bash(f'bash "{STG / "rollback.sh"}"')
    assert result.returncode == 0
    assert "R1A_ROLLBACK=EVIDENCE_PRESERVED" in result.stdout and "R1A_GENUINE_EVIDENCE_RETAINED=YES" in result.stdout and "R1A_RERUN_ALLOWED=NO" in result.stdout
    assert "R1A_REVERSIBLE_PRODUCTION_MUTATION_OWNED=NO" in result.stdout
    assert bash(f'bash "{STG / "rollback.sh"}" --anything').returncode == 1
    body = "\n".join(code_lines(STG / "rollback.sh"))
    for forbidden in ("nft", "systemctl", "sqlite", "sudo", "readlink", "ln ", "mv ", "rm ", "journalctl", "python"):
        assert forbidden not in body, forbidden


def test_apply_refuses_without_authorization_root_or_a_valid_step(tmp_path: Path) -> None:
    assert "LIVE_AUTHORIZATION_REQUIRED" in bash(f'bash "{STG / "apply.sh"}"').stderr
    out = bash(f'bash "{STG / "apply.sh"}"', env={"AEGIS_R1A_LIVE_AUTHORIZED": "YES"})
    assert out.returncode == 1 and "ROOT_REQUIRED" in out.stderr  # the test user is never root


def userns_usable() -> bool:
    return bool(shutil.which("unshare")) and subprocess.run(["unshare", "-r", "true"], capture_output=True).returncode == 0


@pytest.mark.skipif(not userns_usable(), reason="user namespace unavailable")
def test_the_final_verifier_step_runs_exactly_once_per_work_dir(tmp_path: Path) -> None:
    app = tmp_path / "app/aegis_soc"
    app.mkdir(parents=True)
    (app / "r1_acceptance.py").write_text("")
    work = tmp_path / "work"
    work.mkdir()
    (work / "r1-baseline.json").write_text("{}")
    (tmp_path / "audit.db").write_text("")
    calls = tmp_path / "calls.txt"
    fake = tmp_path / "fakepy"
    fake.write_text(f'#!/bin/sh\necho "$@" >> "{calls}"\nexit 2\n')
    fake.chmod(0o755)
    env = {"AEGIS_R1A_LIVE_AUTHORIZED": "YES", "AEGIS_R1A_WORK_DIR": str(work), "AEGIS_R1A_STEP": "FINAL", "AEGIS_R1A_APP_DIR": str(tmp_path / "app"),
           "AEGIS_R1A_AUDIT_DB": str(tmp_path / "audit.db"), "AEGIS_PYTHON_BIN": str(fake)}
    first = subprocess.run(["unshare", "-r", "bash", str(STG / "apply.sh")], env={**os.environ, **env}, text=True, capture_output=True)
    assert first.returncode == 0 and "R1A_VERIFIER_EXIT=2" in first.stdout and "R1A_EVENT_GENERATED_BY_HANDLER=NO" in first.stdout  # a failed verifier is still a consumed observation
    second = subprocess.run(["unshare", "-r", "bash", str(STG / "apply.sh")], env={**os.environ, **env}, text=True, capture_output=True)
    assert second.returncode == 1 and "STEP_ALREADY_RAN_FINAL" in second.stderr
    assert calls.read_text().count("r1_acceptance final") == 1
    assert (work / "R1A-FINAL-RAN").is_file()


def write_result(work: Path, **patch) -> None:
    import json

    doc = {"schema": "aegis.idea3.r1-acceptance/1", "result": "PASS", "reason": "OK",
           "checks": {"R1_EVIDENCE_VERIFIED": "YES", "REAL_DETECTOR_CHAIN_VERIFIED": "YES"},
           "claims": {"F1_REAL_DETECTOR_ACCEPTANCE": "NOT_PROVEN", "R1_VERIFIED": "NOT_CLAIMED", "RECOVERY_R1_R8_PROVEN": "NO"}}
    doc.update(patch)
    (work / "r1-result.json").write_text(json.dumps(doc))
    (work / "R1A-FINAL-RAN").write_text("x")


def test_verify_accepts_only_a_narrow_pass_and_never_promotes(tmp_path: Path) -> None:
    write_result(tmp_path)
    ok = bash(f'bash "{STG / "verify.sh"}"', env={"AEGIS_R1A_WORK_DIR": str(tmp_path), "AEGIS_PYTHON_BIN": sys.executable})
    assert ok.returncode == 0 and "R1A_VERIFY=PASS" in ok.stdout
    assert "F1_REAL_DETECTOR_ACCEPTANCE=NOT_PROVEN" in ok.stdout and "R1_VERIFIED=NOT_CLAIMED" in ok.stdout and "R1A_PROMOTION=NOT_AUTOMATIC" in ok.stdout
    for patch in ({"result": "FAIL"}, {"claims": {"F1_REAL_DETECTOR_ACCEPTANCE": "PROVEN", "R1_VERIFIED": "NOT_CLAIMED", "RECOVERY_R1_R8_PROVEN": "NO"}},
                  {"claims": {"F1_REAL_DETECTOR_ACCEPTANCE": "NOT_PROVEN", "R1_VERIFIED": "YES", "RECOVERY_R1_R8_PROVEN": "NO"}}):
        write_result(tmp_path, **patch)
        bad = bash(f'bash "{STG / "verify.sh"}"', env={"AEGIS_R1A_WORK_DIR": str(tmp_path), "AEGIS_PYTHON_BIN": sys.executable})
        assert bad.returncode == 1, patch


# --------------------------------------------------------------------------- evidence (existing fail-closed verifier is the authority)


def test_the_existing_verifier_trust_predicates_are_unchanged_and_strict() -> None:
    sys.path.insert(0, str(ROOT))
    from aegis_soc import r1_acceptance as acc

    kernel = {"kind": "net", "transport": "kernel", "unit": ""}
    assert acc.source_is_trusted(kernel)
    assert not acc.source_is_trusted({**kernel, "transport": "syslog"})
    assert not acc.source_is_trusted({**kernel, "transport": "journal"})
    assert not acc.source_is_trusted({**kernel, "unit": "logger.service"})
    assert acc.CLAIMS["F1_REAL_DETECTOR_ACCEPTANCE"] == "NOT_PROVEN" and acc.CLAIMS["R1_VERIFIED"] == "NOT_CLAIMED"


EVIDENCE_COVERAGE = {
    "forged/userspace AEGIS_NEWCONN rejected": "test_forged_kernel_text_from_a_unit_or_syslog_is_refused",
    "wrong detector PID rejected": "test_journal_line_from_other_pid",
    "direct Core socket provenance rejected": "test_direct_socket_injection_other_pid_is_rejected",
    "missing ALERT_ACCEPTED rejected": "test_missing_core_alert_acceptance_proof",
    "missing INCIDENT_BOUND rejected": "test_missing_incident_bound",
    "ambiguous incidents rejected": "test_multiple_candidate_incidents",
    "wrong attacker IP rejected": "test_accepted_ip_differs_from_incident",
    "service restart / state drift rejected": "test_service_continuity",
    "narrow PASS never promotes": "test_one_real_event_passes_with_a_narrow_result_and_never_promotes",
    "no input can promote a claim": "test_no_input_or_flag_can_promote_a_live_claim",
    "baseline refuses a pre-existing open incident": "test_preexisting_open_incident_is_refused_at_baseline",
}


def test_every_required_evidence_rejection_is_covered_by_the_existing_verifier_suite() -> None:
    text = (ROOT / "tests/test_r1_acceptance.py").read_text()
    for claim, name in EVIDENCE_COVERAGE.items():
        assert f"def {name}(" in text, claim


# --------------------------------------------------------------------------- claim boundary


def test_repository_documents_implemented_but_not_executed_and_never_promotes() -> None:
    receipts = list((ROOT.parent / LOGS).glob("*r1a-real-detector-acceptance-stage*.md"))
    assert len(receipts) == 1
    text = receipts[0].read_text()
    for line in ("R1A_STAGE_ID_OWNER_APPROVED=YES", "R1A_GOVERNANCE_CLASS=MUTATING", "R1A_ONE_ATTEMPT=YES", "R1A_NO_RETRY=YES", "R1A_GENUINE_EXTERNAL_EVENT_REQUIRED=YES",
                 "R1A_SYNTHETIC_ALERT_ALLOWED=NO", "R1A_REAL_EVIDENCE_ROLLBACK_ALLOWED=NO", "R1I_MUST_REMAIN_INSTALLED=YES", "R1A_REPOSITORY_IMPLEMENTED=YES", "R1A_LIVE_EXECUTED=NO",
                 "F1_REAL_DETECTOR_ACCEPTANCE=NOT_PROVEN", "R1_VERIFIED=NOT_CLAIMED", "RECOVERY_R1_R8_PROVEN=NO", "PRODUCTION_MUTATION_PERFORMED=NO"):
        assert line in text, line
