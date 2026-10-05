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
                "VERIFIER_SNAPSHOT_DIR", "VERIFIER_MANIFEST_SHA256", "R1I_TOOL_SHA256", "AUDIT_DB", "DETECTOR_UID", "EXPECTED_SOURCE_IP", "OBSERVE_SECONDS"):
        assert f"{pin}=PIN_" in RUNNER.read_text()


def pinned_copy(tmp_path: Path, **override: str) -> Path:
    pins = {
        "EXPECTED_MAIN": "a" * 40, "OPERATOR_USER": "owner", "OPERATOR_UID": "1000", "RELEASE_ID": RELEASE, "PRODUCTION_DETECTOR_SHA256": "b" * 64,
        "DETECTOR_UNIT_SHA256": "c" * 64, "RECOVERY_CORE_SHA256": "d" * 64, "VERIFIER_MANIFEST_SHA256": "e" * 64, "VERIFIER_SNAPSHOT_DIR": "/opt/x/verifier",
        "R1I_TOOL_SHA256": "f" * 64,
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
    bad = [("EXPECTED_MAIN", "abc"), ("VERIFIER_MANIFEST_SHA256", "zz"), ("OBSERVE_SECONDS", "0"), ("AUDIT_DB", "relative/db"), ("OPERATOR_UID", "0"),
           ("VERIFIER_SNAPSHOT_DIR", "relative/dir")]
    for key, value in bad:
        assert bash(f'bash "{pinned_copy(tmp_path, **{key: value})}" "{tmp_path}"').returncode == 2, key
    frozen = pinned_copy(tmp_path)
    for var in ("AEGIS_P4_FS_ROOT", "P4_FS_ROOT", "AEGIS_P4_HANDLER_DIR", "AEGIS_R1A_STEP", "AEGIS_R1A_LIVE_AUTHORIZED", "AEGIS_R1I_LIVE_AUTHORIZED",
                "AEGIS_R1A_EXPECTED_SOURCE_IP", "AEGIS_R1A_WINDOW_START", "AEGIS_R1A_WINDOW_END", "AEGIS_R1A_VERIFIER_MANIFEST_SHA256"):
        result = bash(f'bash "{frozen}" "{tmp_path}"', env={var: "x"})
        assert result.returncode == 2 and "environment override" in result.stdout, var
    assert bash(f'bash "{frozen}"').returncode == 2  # no AUTH_DIR
    assert not (tmp_path / "evidence").exists()


@pytest.mark.parametrize("ip", ["999.1.1.1", "01.2.3.4", "1.2.3", "1.2.3.4.5", "127.0.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "169.254.1.1", "1.2.3.256", "not-an-ip"])
def test_a_malformed_or_non_external_pinned_source_ip_refuses_before_anything_runs(tmp_path: Path, ip: str) -> None:
    result = bash(f'bash "{pinned_copy(tmp_path, EXPECTED_SOURCE_IP=ip)}" "{tmp_path}"')
    assert result.returncode == 2 and "EXPECTED_SOURCE_IP" in result.stdout
    assert not (tmp_path / "evidence").exists()


@pytest.mark.parametrize("ip,ok", [("203.0.113.9", True), ("8.8.8.8", True), ("10.1.2.3", True), ("0.1.2.3", False), ("999.9.9.9", False), ("01.1.1.1", False),
                                   ("127.1.1.1", False), ("239.1.1.1", False), ("169.254.9.9", False), ("1.1.1", False)])
def test_the_library_ipv4_validator_is_strict(ip: str, ok: bool) -> None:
    assert (bash(f'. "{LIB}"; r1a_ipv4_valid "{ip}"').returncode == 0) is ok


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
    pre = text[text.index("pregates() {"):text.index("ATTEMPT_STARTED=0")]
    for needle in ("rev-parse HEAD", "authorization-R1A.txt", "p4-stage-gate.sh", "r1a_receipt_gate", "r1a_attempt_unconsumed", "l7_disk_gate", "authority_gates", "r1a_journal_access_gate"):
        assert needle in pre, needle
    authority = text[text.index("authority_gates() {"):text.index("# ===== PRE-AUTH")]
    for needle in ("r1a_worktree_gate", "r1a_verifier_gate", "r1a_interpreter_gate", "r1a_r1i_present_gate", "l7u_core_running_gate", "f1u_detector_running_gate", "production_detector.py",
                   "DETECTOR_UNIT_SHA256", "RECOVERY_CORE_SHA256", "r1a_current_release_gate", "runtime_unchanged"):
        assert needle in authority, needle
    assert "R1A-ATTEMPT-CONSUMED" not in pre and "r1a_consume_attempt" not in pre


def test_the_full_authority_is_reproved_before_the_marker_and_again_immediately_before_final() -> None:
    text = RUNNER.read_text()
    regate = text[text.index("r1a_hook_regate() {"):text.index("r1a_hook_observe() {")]
    assert "authority_gates" in regate and "r1a_attempt_unconsumed" in regate
    final = text[text.index("r1a_hook_final() {"):text.index("r1a_hook_verify() {")]
    assert final.index("authority_gates") < final.index("capture POST") < final.index("handler FINAL")
    assert "R1A_AUTHORITY_DRIFT_BEFORE_FINAL" in final


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


def seam(tmp_path: Path, name: str = "canon") -> str:
    """Shell prefix that points the TEST-ONLY canonical-marker seam at a temporary directory (the real path is root-owned under /var/lib and never touched by tests)."""
    return f'export R1A_TEST_ONLY_CANONICAL_DIR_ENABLED=YES R1A_TEST_ONLY_CANONICAL_DIR="{tmp_path / name}"\n'


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


def attempt(tmp_path: Path, fail_at: str = "", seconds: str = "30", auth_name: str = "auth", canon_name: str = "canon") -> tuple[subprocess.CompletedProcess[str], list[str]]:
    auth = tmp_path / auth_name
    auth.mkdir(exist_ok=True)
    log = tmp_path / "hooks.log"
    script = f'AUTH="{auth}"\n{seam(tmp_path, canon_name)}. "{LIB}"\nSUDO=""\n{HOOKS}\nr1a_run_attempt "$AUTH" {seconds}\n'
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
    result = bash(f'{seam(tmp_path)}. "{LIB}"; SUDO=""; r1a_consume_attempt "{tmp_path / "auth"}"')
    assert result.returncode == 1 and marker.read_text() == "owner-kept\n"
    assert not (tmp_path / "canon/R1A-GLOBAL-ATTEMPT-CONSUMED").exists()  # a refused attempt creates nothing
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


SNAPSHOT_TOOL = P4 / "r1a-acceptance/r1a_verifier_snapshot.py"


def load_snapshot_tool():
    from importlib.util import module_from_spec, spec_from_file_location

    spec = spec_from_file_location("r1a_snapshot_tool", SNAPSHOT_TOOL)
    tool = module_from_spec(spec)
    sys.modules["r1a_snapshot_tool"] = tool
    spec.loader.exec_module(tool)
    return tool


def make_snapshot(tmp_path: Path) -> tuple[Path, str]:
    """A real read-only verifier snapshot of the repository's own aegis_soc closure, plus its manifest digest."""
    tool = load_snapshot_tool()
    dest = tmp_path / "verifier-snapshot"
    return dest, tool.snapshot(ROOT, dest)


def write_baseline_app(tmp_path: Path) -> tuple[Path, str]:
    """A tiny snapshot whose only job is to carry a manifest the apply handler can verify (the interpreter is a recording stub)."""
    app = tmp_path / "app"
    (app / "aegis_soc").mkdir(parents=True)
    (app / "aegis_soc/__init__.py").write_text("")
    (app / "aegis_soc/r1_acceptance.py").write_text("")
    import hashlib

    lines = "".join(f"{hashlib.sha256((app / rel).read_bytes()).hexdigest()}  {rel}\n" for rel in ("aegis_soc/__init__.py", "aegis_soc/r1_acceptance.py"))
    (app / "R1A-VERIFIER-SHA256SUMS").write_text(lines)
    manifest_sha = hashlib.sha256(lines.encode()).hexdigest()
    for path in app.rglob("*"):
        path.chmod(0o555 if path.is_dir() else 0o444)
    app.chmod(0o555)
    return app, manifest_sha


def apply_env(tmp_path: Path, app: Path, manifest_sha: str, step: str = "FINAL") -> dict[str, str]:
    work = tmp_path / "work"
    work.mkdir(exist_ok=True)
    (work / "r1-baseline.json").write_text("{}")
    (tmp_path / "audit.db").write_text("")
    fake = tmp_path / "fakepy"
    if not fake.exists():
        fake.write_text(f'#!/bin/sh\necho "$@" >> "{tmp_path / "calls.txt"}"\npwd >> "{tmp_path / "cwd.txt"}"\nexit 2\n')
        fake.chmod(0o755)
    return {"AEGIS_R1A_LIVE_AUTHORIZED": "YES", "AEGIS_R1A_WORK_DIR": str(work), "AEGIS_R1A_STEP": step, "AEGIS_R1A_APP_DIR": str(app),
            "AEGIS_R1A_VERIFIER_MANIFEST_SHA256": manifest_sha, "AEGIS_R1A_AUDIT_DB": str(tmp_path / "audit.db"), "AEGIS_PYTHON_BIN": str(fake)}


def run_apply(env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["unshare", "-r", "bash", str(STG / "apply.sh")], env={**os.environ, **env}, text=True, capture_output=True)


@pytest.mark.skipif(not userns_usable(), reason="user namespace unavailable")
def test_the_final_verifier_step_runs_exactly_once_per_work_dir_from_the_immutable_snapshot(tmp_path: Path) -> None:
    app, sha = write_baseline_app(tmp_path)
    env = apply_env(tmp_path, app, sha)
    first = run_apply(env)
    assert first.returncode == 0 and "R1A_VERIFIER_EXIT=2" in first.stdout and "R1A_EVENT_GENERATED_BY_HANDLER=NO" in first.stdout  # a failed verifier is still a consumed observation
    second = run_apply(env)
    assert second.returncode == 1 and "STEP_ALREADY_RAN_FINAL" in second.stderr
    assert (tmp_path / "calls.txt").read_text().count("aegis_soc.r1_acceptance final") == 1
    assert "-B" in (tmp_path / "calls.txt").read_text() and (tmp_path / "cwd.txt").read_text().strip() == str(tmp_path / "work")  # neutral cwd, no mutable import path
    assert (tmp_path / "work/R1A-FINAL-RAN").is_file()


@pytest.mark.skipif(not userns_usable(), reason="user namespace unavailable")
@pytest.mark.parametrize("tamper", ["file", "manifest", "extra", "symlink", "writable", "wrong_pin"])
def test_apply_refuses_root_execution_when_the_verifier_snapshot_drifted(tmp_path: Path, tamper: str) -> None:
    app, sha = write_baseline_app(tmp_path)
    env = apply_env(tmp_path, app, sha)
    app.chmod(0o755)
    (app / "aegis_soc").chmod(0o755)
    if tamper == "file":
        (app / "aegis_soc/r1_acceptance.py").chmod(0o644)
        (app / "aegis_soc/r1_acceptance.py").write_text("# drift\n")
        (app / "aegis_soc/r1_acceptance.py").chmod(0o444)  # read-only again: only the digest check can catch this
    elif tamper == "manifest":
        (app / "R1A-VERIFIER-SHA256SUMS").chmod(0o644)
        (app / "R1A-VERIFIER-SHA256SUMS").write_text("0" * 64 + "  aegis_soc/r1_acceptance.py\n")
        (app / "R1A-VERIFIER-SHA256SUMS").chmod(0o444)
    elif tamper == "extra":
        (app / "aegis_soc/evil.py").write_text("")
        (app / "aegis_soc/evil.py").chmod(0o444)
    elif tamper == "symlink":
        (app / "aegis_soc/link.py").symlink_to("r1_acceptance.py")
    elif tamper == "writable":
        (app / "aegis_soc/r1_acceptance.py").chmod(0o666)
    else:
        env["AEGIS_R1A_VERIFIER_MANIFEST_SHA256"] = "a" * 64
    if tamper != "writable":
        app.chmod(0o555)  # re-lock the directories so ONLY the intended check can catch the drift
        (app / "aegis_soc").chmod(0o555)
    result = run_apply(env)
    assert result.returncode == 1 and "R1A_APPLY=FAIL" in result.stderr, tamper
    assert not (tmp_path / "calls.txt").exists() and not (tmp_path / "work/R1A-FINAL-RAN").exists()  # the interpreter was never started


def result_doc(**patch) -> dict:
    doc = {"schema": "aegis.idea3.r1-acceptance/1", "result": "PASS", "reason": "OK", "attacker_ip": "203.0.113.9",
           "checks": {"R1_EVIDENCE_VERIFIED": "YES", "REAL_DETECTOR_CHAIN_VERIFIED": "YES"},
           "claims": {"F1_REAL_DETECTOR_ACCEPTANCE": "NOT_PROVEN", "R1_VERIFIED": "NOT_CLAIMED", "RECOVERY_R1_R8_PROVEN": "NO"},
           "evidence_times": {"incident_opened_at": 1060.0, "alert_accepted_at": 1060.0, "detector_alert_at": 1060.4, "source_completed_at": [1059.9]}}
    doc.update(patch)
    return doc


def verify(tmp_path: Path, doc: dict, *, ip: str = "203.0.113.9", start: str = "1000.5", end: str = "1600.5") -> subprocess.CompletedProcess[str]:
    import json

    (tmp_path / "r1-result.json").write_text(json.dumps(doc))
    (tmp_path / "R1A-FINAL-RAN").write_text("x")
    return bash(f'bash "{STG / "verify.sh"}"', env={"AEGIS_R1A_WORK_DIR": str(tmp_path), "AEGIS_PYTHON_BIN": sys.executable, "AEGIS_R1A_EXPECTED_SOURCE_IP": ip,
                                                    "AEGIS_R1A_WINDOW_START": start, "AEGIS_R1A_WINDOW_END": end})


def test_verify_accepts_only_a_narrow_pass_and_never_promotes(tmp_path: Path) -> None:
    ok = verify(tmp_path, result_doc())
    assert ok.returncode == 0 and "R1A_VERIFY=PASS" in ok.stdout and "R1A_SOURCE_IP_BOUND=YES" in ok.stdout and "R1A_MARKER_BOUNDED_WINDOW=YES" in ok.stdout
    assert "F1_REAL_DETECTOR_ACCEPTANCE=NOT_PROVEN" in ok.stdout and "R1_VERIFIED=NOT_CLAIMED" in ok.stdout and "R1A_PROMOTION=NOT_AUTOMATIC" in ok.stdout
    for patch in ({"result": "FAIL"}, {"claims": {"F1_REAL_DETECTOR_ACCEPTANCE": "PROVEN", "R1_VERIFIED": "NOT_CLAIMED", "RECOVERY_R1_R8_PROVEN": "NO"}},
                  {"claims": {"F1_REAL_DETECTOR_ACCEPTANCE": "NOT_PROVEN", "R1_VERIFIED": "YES", "RECOVERY_R1_R8_PROVEN": "NO"}}):
        assert verify(tmp_path, result_doc(**patch)).returncode == 1, patch


# --- IMPORTANT 1: the pinned expected source IP is ENFORCED ---------------------------------------------------------------------------------------


def test_the_expected_source_ip_passes_and_a_different_genuine_ip_fails(tmp_path: Path) -> None:
    assert verify(tmp_path, result_doc(attacker_ip="203.0.113.9"), ip="203.0.113.9").returncode == 0
    other = verify(tmp_path, result_doc(attacker_ip="198.51.100.7"), ip="203.0.113.9")
    assert other.returncode == 1 and "ATTACKER_IP_NOT_THE_EXPECTED_SOURCE" in other.stderr and "R1A_VERIFY=PASS" not in other.stdout


@pytest.mark.parametrize("bad", ["", "999.1.1.1", "01.2.3.4", "127.0.0.1", "224.0.0.1", "0.0.0.0", "not-an-ip"])
def test_a_malformed_or_non_external_expected_ip_never_passes_verification(tmp_path: Path, bad: str) -> None:
    result = verify(tmp_path, result_doc(attacker_ip=bad), ip=bad)
    assert result.returncode == 1 and "R1A_VERIFY=PASS" not in result.stdout


def test_an_ip_mismatch_after_the_marker_consumes_the_attempt_and_cannot_retry(tmp_path: Path) -> None:
    import json

    auth, work = tmp_path / "auth", tmp_path / "work"
    auth.mkdir()
    work.mkdir()
    (work / "r1-result.json").write_text(json.dumps(result_doc(attacker_ip="198.51.100.7")))
    (work / "R1A-FINAL-RAN").write_text("x")
    script = f'''AUTH="{auth}"; {seam(tmp_path)}. "{LIB}"; SUDO=""
r1a_hook_pregates() {{ true; }}; r1a_hook_baseline() {{ true; }}; r1a_hook_regate() {{ true; }}; r1a_hook_observe() {{ true; }}; r1a_hook_final() {{ true; }}
r1a_hook_verify() {{ AEGIS_R1A_WORK_DIR="{work}" AEGIS_PYTHON_BIN="{sys.executable}" AEGIS_R1A_EXPECTED_SOURCE_IP=203.0.113.9 AEGIS_R1A_WINDOW_START="$R1A_WINDOW_START" AEGIS_R1A_WINDOW_END="$R1A_WINDOW_END" bash "{STG / "verify.sh"}" >/dev/null; }}
r1a_hook_preserve_evidence() {{ true; }}
r1a_run_attempt "$AUTH" 30; echo "rc=$?"; r1a_run_attempt "$AUTH" 30; echo "rerun_rc=$?"'''
    result = bash(script)
    assert "R1A_RESULT=FAIL" in result.stdout and "R1A_ATTEMPT_CONSUMED=YES" in result.stdout and "rc=1" in result.stdout and "rerun_rc=1" in result.stdout
    assert "R1A_ATTEMPT_ALREADY_CONSUMED" in result.stderr and (tmp_path / "canon/R1A-GLOBAL-ATTEMPT-CONSUMED").is_file()


# --- IMPORTANT 2: the acceptance window is bound to the marker ------------------------------------------------------------------------------------


def test_an_event_immediately_before_the_marker_fails(tmp_path: Path) -> None:
    t = {"incident_opened_at": 1000.0, "alert_accepted_at": 1000.0, "detector_alert_at": 1000.3, "source_completed_at": [1000.2]}  # completes 0.3 s BEFORE the marker at 1000.5
    result = verify(tmp_path, result_doc(evidence_times=t), start="1000.5")
    assert result.returncode == 1 and "EVENT_BEFORE_THE_MARKER" in result.stderr


def test_an_event_exactly_inside_the_authorized_window_passes(tmp_path: Path) -> None:
    t = {"incident_opened_at": 1001.0, "alert_accepted_at": 1001.0, "detector_alert_at": 1000.9, "source_completed_at": [1000.5]}  # exactly at the marker instant
    assert verify(tmp_path, result_doc(evidence_times=t), start="1000.5", end="1600.5").returncode == 0
    edge = {"incident_opened_at": 1600.0, "alert_accepted_at": 1600.0, "detector_alert_at": 1600.5, "source_completed_at": [1600.4]}  # at the deadline
    assert verify(tmp_path, result_doc(evidence_times=edge), start="1000.5", end="1600.5").returncode == 0


def test_an_event_after_the_observation_deadline_fails(tmp_path: Path) -> None:
    t = {"incident_opened_at": 1602.0, "alert_accepted_at": 1602.0, "detector_alert_at": 1601.0, "source_completed_at": [1600.9]}  # completes 0.4 s AFTER the deadline
    result = verify(tmp_path, result_doc(evidence_times=t), start="1000.5", end="1600.5")
    assert result.returncode == 1 and "EVENT_AFTER_THE_OBSERVATION_DEADLINE" in result.stderr
    late_audit = {"incident_opened_at": 1610.0, "alert_accepted_at": 1610.0, "detector_alert_at": 1600.4, "source_completed_at": [1600.3]}
    assert verify(tmp_path, result_doc(evidence_times=late_audit), start="1000.5", end="1600.5").returncode == 1


def test_one_early_source_completion_among_several_fails_and_missing_or_malformed_times_fail(tmp_path: Path) -> None:
    assert verify(tmp_path, result_doc(evidence_times={**result_doc()["evidence_times"], "source_completed_at": [999.0, 1059.9]})).returncode == 1
    for bad in ({}, {"source_completed_at": []}, {**result_doc()["evidence_times"], "detector_alert_at": "x"}, {**result_doc()["evidence_times"], "incident_opened_at": True}):
        assert verify(tmp_path, result_doc(evidence_times=bad)).returncode == 1, bad
    assert verify(tmp_path, result_doc(), start="", end="").returncode == 1  # no window recorded => never a PASS
    assert verify(tmp_path, result_doc(), start="2000", end="1000").returncode == 1


def test_the_window_starts_at_the_marker_and_ends_when_the_wait_completes_before_final(tmp_path: Path) -> None:
    (tmp_path / "auth").mkdir()
    script = f'''AUTH="{tmp_path / "auth"}"; {seam(tmp_path)}. "{LIB}"; SUDO=""
r1a_hook_pregates() {{ true; }}; r1a_hook_baseline() {{ true; }}; r1a_hook_regate() {{ true; }}
r1a_hook_observe() {{ echo "OBS start=$R1A_WINDOW_START end=${{R1A_WINDOW_END:-unset}}"; sleep 0.2; }}
r1a_hook_final() {{ echo "FINAL start=$R1A_WINDOW_START end=$R1A_WINDOW_END"; }}
r1a_hook_verify() {{ true; }}; r1a_hook_preserve_evidence() {{ true; }}
r1a_run_attempt "$AUTH" 30'''
    out = bash(script).stdout
    obs = dict(kv.split("=") for kv in re.search(r"OBS (.*)", out).group(1).split())
    fin = dict(kv.split("=") for kv in re.search(r"FINAL (.*)", out).group(1).split())
    assert obs["end"] == "unset" and obs["start"] == fin["start"] and float(fin["end"]) >= float(fin["start"]) + 0.2
    assert f"consumed_epoch={fin['start']}" in (tmp_path / "auth/R1A-ATTEMPT-CONSUMED").read_text()
    record = (tmp_path / "canon/R1A-ATTEMPT-WINDOW").read_text()
    assert f"window_start={fin['start']}" in record and f"window_end={fin['end']}" in record


def test_the_r1_verifier_only_adds_informational_times_and_still_promotes_nothing() -> None:
    text = (ROOT / "aegis_soc/r1_acceptance.py").read_text()
    assert '"evidence_times"' in text and "Informational only: no acceptance predicate reads them" in text
    sys.path.insert(0, str(ROOT))
    from aegis_soc import r1_acceptance as acc

    assert acc.CLAIMS["F1_REAL_DETECTOR_ACCEPTANCE"] == "NOT_PROVEN" and acc.CLAIMS["R1_VERIFIED"] == "NOT_CLAIMED"


# --- IMPORTANT 3: the verifier authority is an immutable, fully manifested snapshot -----------------------------------------------------------------


def test_the_snapshot_closure_covers_every_module_that_affects_acceptance_semantics() -> None:
    tool = load_snapshot_tool()
    closure = set(tool.closure(ROOT))
    for name in ("r1_acceptance", "production_detector", "recovery_evidence", "ip_containment", "recovery_core", "recovery_protocol", "local_restore", "alert_sink", "__init__"):
        assert f"aegis_soc/{name}.py" in closure, name
    import ast

    for rel in closure:  # the closure is transitively closed: every local import of every member is itself a member
        for dep in tool._imports(ROOT / rel):
            if tool._module_file(ROOT, dep) is not None:
                assert str(tool._module_file(ROOT, dep).relative_to(ROOT)) in closure, (rel, dep)
        ast.parse((ROOT / rel).read_text())


def test_snapshot_build_is_new_dir_only_read_only_and_verifiable(tmp_path: Path) -> None:
    tool = load_snapshot_tool()
    dest, sha = make_snapshot(tmp_path)
    tool.check(dest, sha)
    assert all(not (p.stat().st_mode & 0o222) for p in dest.rglob("*"))
    with pytest.raises(tool.SnapshotError):
        tool.snapshot(ROOT, dest)  # never overwrites an existing snapshot
    with pytest.raises(tool.SnapshotError):
        tool.check(dest, "0" * 64)


@pytest.mark.parametrize("drift", ["file", "extra", "symlink", "writable"])
def test_dependency_or_verifier_drift_fails_the_snapshot_check(tmp_path: Path, drift: str) -> None:
    tool = load_snapshot_tool()
    dest, sha = make_snapshot(tmp_path)
    for path in [dest, *dest.rglob("*")]:
        if path.is_dir():
            path.chmod(0o755)
    target = dest / "aegis_soc/recovery_evidence.py"  # a dependency of the verifier, not the verifier itself
    if drift == "file":
        target.chmod(0o644)
        target.write_text(target.read_text() + "\n# drift\n")
    elif drift == "extra":
        (dest / "aegis_soc/shadow.py").write_text("")
        (dest / "aegis_soc/shadow.py").chmod(0o444)
    elif drift == "symlink":
        (dest / "aegis_soc/link.py").symlink_to("recovery_evidence.py")
    else:
        target.chmod(0o666)
    with pytest.raises(tool.SnapshotError):
        tool.check(dest, sha)


def repo_with_aegis_soc(tmp_path: Path) -> Path:
    repo = tmp_path / "repo"
    shutil.copytree(ROOT / "aegis_soc", repo / "IDEA3-AEGIS_Lockdown/aegis_soc", ignore=shutil.ignore_patterns("__pycache__"))
    git(repo, "init", "-q") if False else subprocess.run(["git", "-C", str(repo), "init", "-q"], check=True)
    for cmd in (["config", "user.email", "t@e.invalid"], ["config", "user.name", "t"], ["add", "-A"], ["commit", "-q", "-m", "x"]):
        subprocess.run(["git", "-C", str(repo), *cmd], check=True, capture_output=True)
    return repo


def verifier_gate(repo: Path, snap: Path, sha: str, detector: str) -> subprocess.CompletedProcess[str]:
    return bash(f'. "{LIB}"; r1a_verifier_gate "{snap}" {sha} "{repo}" {detector} "{SNAPSHOT_TOOL}"')


def test_the_verifier_gate_requires_the_snapshot_to_be_the_pinned_main_source_and_the_deployed_detector(tmp_path: Path) -> None:
    import hashlib

    tool = load_snapshot_tool()
    repo = repo_with_aegis_soc(tmp_path)
    snap = tmp_path / "snap"
    sha = tool.snapshot(repo / "IDEA3-AEGIS_Lockdown", snap)
    det = hashlib.sha256((snap / "aegis_soc/production_detector.py").read_bytes()).hexdigest()
    assert verifier_gate(repo, snap, sha, det).returncode == 0
    assert verifier_gate(repo, snap, sha, "0" * 64).returncode == 1  # the verifier would reconstruct rules from a detector that is not the deployed one
    assert verifier_gate(repo, snap, "0" * 64, det).returncode == 1  # wrong pinned manifest


def test_a_snapshot_that_differs_from_the_pinned_main_source_is_refused_even_if_self_consistent(tmp_path: Path) -> None:
    import hashlib

    tool = load_snapshot_tool()
    repo = repo_with_aegis_soc(tmp_path)
    mutated = tmp_path / "mutated-src"
    shutil.copytree(repo / "IDEA3-AEGIS_Lockdown", mutated)
    (mutated / "aegis_soc/recovery_evidence.py").write_text((mutated / "aegis_soc/recovery_evidence.py").read_text() + "\n# not the reviewed source\n")
    snap = tmp_path / "snap"
    sha = tool.snapshot(mutated, snap)  # internally consistent manifest, but not the pinned-main bytes
    det = hashlib.sha256((snap / "aegis_soc/production_detector.py").read_bytes()).hexdigest()
    result = verifier_gate(repo, snap, sha, det)
    assert result.returncode == 1 and "NOT_THE_PINNED_MAIN_SOURCE" in result.stderr


def test_the_worktree_gate_refuses_a_dirty_tree_or_an_altered_handler(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    handlers = repo / "IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/R1A"
    handlers.mkdir(parents=True)
    for name in ("apply.sh", "verify.sh", "rollback.sh"):
        shutil.copy(STG / name, handlers / name)
    subprocess.run(["git", "-C", str(repo), "init", "-q"], check=True)
    for cmd in (["config", "user.email", "t@e.invalid"], ["config", "user.name", "t"], ["add", "-A"], ["commit", "-q", "-m", "x"]):
        subprocess.run(["git", "-C", str(repo), *cmd], check=True, capture_output=True)
    head = subprocess.run(["git", "-C", str(repo), "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
    assert bash(f'. "{LIB}"; r1a_worktree_gate "{repo}" {head}').returncode == 0
    assert bash(f'. "{LIB}"; r1a_worktree_gate "{repo}" {"1" * 40}').returncode == 1
    (handlers / "apply.sh").write_text("#!/bin/sh\n# altered\n")
    assert bash(f'. "{LIB}"; r1a_worktree_gate "{repo}" {head}').returncode == 1


def test_the_interpreter_must_be_root_owned_and_not_writable() -> None:
    assert bash(f'. "{LIB}"; r1a_interpreter_gate /nonexistent/python').returncode == 1
    sys_python = shutil.which("python3")
    resolved = Path(sys_python).resolve()
    expected_ok = resolved.stat().st_uid == 0 and not (resolved.stat().st_mode & 0o022)
    assert (bash(f'. "{LIB}"; r1a_interpreter_gate "{sys_python}"').returncode == 0) is expected_ok


# --- IMPORTANT 4: ONE attempt TOTAL, independent of the AUTH_DIR -----------------------------------------------------------------------------------


def test_a_consumed_attempt_blocks_the_same_a_copied_a_new_auth_dir_and_fresh_authorization(tmp_path: Path) -> None:
    first, calls = attempt(tmp_path, fail_at="observe")  # attempt A: consumed (e.g. no event / timeout)
    assert first.returncode == 1 and (tmp_path / "canon/R1A-GLOBAL-ATTEMPT-CONSUMED").is_file()
    (tmp_path / "hooks.log").unlink()
    again_a, calls_a = attempt(tmp_path)  # same AUTH_DIR
    assert again_a.returncode == 1 and "R1A_ATTEMPT_ALREADY_CONSUMED" in again_a.stderr and calls_a == []
    shutil.copytree(tmp_path / "auth", tmp_path / "auth_copy")  # a COPIED AUTH_DIR (marker removed from the copy is the strongest bypass attempt)
    (tmp_path / "auth_copy/R1A-ATTEMPT-CONSUMED").unlink()
    copied, calls_c = attempt(tmp_path, auth_name="auth_copy")
    assert copied.returncode == 1 and "R1A_ATTEMPT_ALREADY_CONSUMED" in copied.stderr and calls_c == []
    fresh_dir = tmp_path / "auth_b"
    fresh_dir.mkdir()
    for name in ("authorization-R1A.txt", "k3-R1A.txt"):  # fresh same-day / later Authorization + K3 in a brand new AUTH_DIR
        (fresh_dir / name).write_text("AEGIS_P4_AUTHORIZATION_V1\nstage=R1A\n")
    fresh, calls_b = attempt(tmp_path, auth_name="auth_b")
    assert fresh.returncode == 1 and "R1A_ATTEMPT_ALREADY_CONSUMED" in fresh.stderr and calls_b == []
    assert not (fresh_dir / "R1A-ATTEMPT-CONSUMED").exists()  # refused before anything was created


def test_the_global_marker_is_never_removed_or_reset_by_any_code_path() -> None:
    for path in R1A_FILES:
        body = "\n".join(code_lines(path))
        assert not re.search(r"\b(rm|unlink|truncate|mv|shred)\b", body), path
        assert "chattr -i" not in body
    lib = "\n".join(code_lines(LIB))
    assert lib.count("set -o noclobber") >= 3  # global marker, authorization-local marker and window record are exclusive creates
    assert ">> " not in lib and "chattr +i" in lib


def test_the_canonical_marker_location_is_fixed_by_the_stage_contract_not_by_any_runner() -> None:
    lib = LIB.read_text()
    assert len(re.findall(r"^\s*R1A_CANONICAL_DIR=", lib, re.M)) == 1 and "readonly R1A_CANONICAL_DIR" in lib
    runner = "\n".join(code_lines(RUNNER))
    assert "PIN_GLOBAL" not in RUNNER.read_text() and not re.search(r"^\s*(R1A_CANONICAL_DIR|GLOBAL_MARKER_DIR)=", runner, re.M)
    for var in ("R1A_CANONICAL_DIR", "R1A_TEST_ONLY_CANONICAL_DIR", "R1A_TEST_ONLY_CANONICAL_DIR_ENABLED", "GLOBAL_MARKER_DIR"):
        assert var in runner  # the frozen runner refuses every override of the canonical location


def test_the_canonical_directory_must_be_a_private_real_directory(tmp_path: Path) -> None:
    (tmp_path / "auth").mkdir()
    open_dir = tmp_path / "open"
    open_dir.mkdir()
    open_dir.chmod(0o777)
    link = tmp_path / "link"
    link.symlink_to(tmp_path)
    for bad in (open_dir, link):
        result = bash(f'export R1A_TEST_ONLY_CANONICAL_DIR_ENABLED=YES R1A_TEST_ONLY_CANONICAL_DIR="{bad}"\n. "{LIB}"; SUDO=""; r1a_attempt_unconsumed "{tmp_path / "auth"}"')
        assert result.returncode == 1 and "R1A_CANONICAL_DIR_" in result.stderr, bad
    orphan = bash(f'export R1A_TEST_ONLY_CANONICAL_DIR_ENABLED=YES R1A_TEST_ONLY_CANONICAL_DIR="{tmp_path / "no/such/parent/canon"}"\n. "{LIB}"; SUDO=""; r1a_attempt_unconsumed "{tmp_path / "auth"}"')
    assert orphan.returncode == 1 and "R1A_CANONICAL_DIR_PARENT_INVALID" in orphan.stderr


def test_the_canonical_location_cannot_be_substituted_by_env_config_or_a_successor_runner(tmp_path: Path) -> None:
    """The bypass: marker consumed under location A, a (successor) runner/config tries location B."""
    consumed, _ = attempt(tmp_path, fail_at="observe", canon_name="canon_a")  # attempt A consumes the canonical marker (test seam = A)
    assert consumed.returncode == 1 and (tmp_path / "canon_a/R1A-GLOBAL-ATTEMPT-CONSUMED").is_file()
    (tmp_path / "auth_b").mkdir()
    for attack in (
        'GLOBAL_MARKER_DIR="{b}"',  # a successor runner pins another "global" directory
        'R1A_CANONICAL_DIR="{b}"',  # a caller tries to re-point the canonical constant (it is overridden and readonly)
        'GLOBAL_MARKER_DIR="{b}"; R1A_CANONICAL_DIR="{b}"; export GLOBAL_MARKER_DIR R1A_CANONICAL_DIR',
    ):
        script = (f'export R1A_TEST_ONLY_CANONICAL_DIR_ENABLED=YES R1A_TEST_ONLY_CANONICAL_DIR="{tmp_path / "canon_a"}"\n'
                  + attack.format(b=tmp_path / "canon_b") + f'\n. "{LIB}"\nSUDO=""\nr1a_attempt_unconsumed "{tmp_path / "auth_b"}"; echo "rc=$?"; echo "dir=$(r1a_canonical_dir)"\n')
        result = bash(script)
        assert "rc=1" in result.stdout and "R1A_ATTEMPT_ALREADY_CONSUMED" in result.stderr, attack
        assert f"dir={tmp_path / 'canon_a'}" in result.stdout, attack  # B was never adopted
    assert not (tmp_path / "canon_b").exists()
    # without the test seam the canonical location is the fixed stage-contract path, whatever the environment says
    assert bash(f'export R1A_CANONICAL_DIR=/tmp/evil GLOBAL_MARKER_DIR=/tmp/evil2\n. "{LIB}"; r1a_canonical_dir').stdout == "/var/lib/aegis-idea3-governance"
    assert bash(f'export R1A_TEST_ONLY_CANONICAL_DIR=/tmp/evil\n. "{LIB}"; r1a_canonical_dir').stdout == "/var/lib/aegis-idea3-governance"  # seam without its enabling flag is ignored


def test_the_frozen_runner_refuses_to_start_when_any_canonical_location_override_is_set(tmp_path: Path) -> None:
    frozen = pinned_copy(tmp_path)
    for var in ("R1A_CANONICAL_DIR", "R1A_TEST_ONLY_CANONICAL_DIR", "R1A_TEST_ONLY_CANONICAL_DIR_ENABLED", "GLOBAL_MARKER_DIR"):
        result = bash(f'bash "{frozen}" "{tmp_path}"', env={var: "x"})
        assert result.returncode == 2 and "environment override" in result.stdout, var


# --- IMPORTANT 1 (round 2): the window starts only AFTER the canonical marker exists ----------------------------------------------------------------


def test_marker_creation_precedes_window_start_sampling_which_precedes_window_open(tmp_path: Path) -> None:
    """Machine-proved from recorded OPERATIONS and TIMES, not printed text: a recording sudo wrapper and a recording date shim log every call in sequence."""
    shim = tmp_path / "shim"
    shim.mkdir()
    oplog = tmp_path / "ops.log"
    real_date = shutil.which("date")
    (shim / "date").write_text(f'#!/bin/sh\nprintf "DATE %s\\n" "$*" >> "{oplog}"\nexec {real_date} "$@"\n')
    (shim / "sudo").write_text(f'#!/bin/sh\ncase "$*" in *R1A-GLOBAL-ATTEMPT-CONSUMED*noclobber*|*noclobber*R1A-GLOBAL-ATTEMPT-CONSUMED*) printf "MARKER_CREATE\\n" >> "{oplog}";; esac\nexec "$@"\n')
    for name in ("date", "sudo"):
        (shim / name).chmod(0o755)
    (tmp_path / "auth").mkdir()
    script = f'''AUTH="{tmp_path / "auth"}"; {seam(tmp_path)}. "{LIB}"; SUDO="{shim / "sudo"}"
r1a_hook_pregates() {{ true; }}; r1a_hook_baseline() {{ true; }}; r1a_hook_regate() {{ true; }}
r1a_hook_observe() {{ printf "OBSERVE_ENTER\\n" >> "{oplog}"; /bin/date +%s.%N > "{tmp_path / "observe.time"}"; }}
r1a_hook_final() {{ true; }}; r1a_hook_verify() {{ true; }}; r1a_hook_preserve_evidence() {{ true; }}
r1a_run_attempt "$AUTH" 30'''
    result = subprocess.run(["bash", "-c", script], env={**os.environ, "PATH": f"{shim}:{os.environ['PATH']}"}, text=True, capture_output=True)
    assert result.returncode == 0, result.stderr
    ops = oplog.read_text().split("\n")
    marker_at = ops.index("MARKER_CREATE")
    epoch_samples = [i for i, line in enumerate(ops) if line == "DATE +%s.%N"]
    observe_at = ops.index("OBSERVE_ENTER")
    assert epoch_samples, "the window start must be sampled"
    assert marker_at < epoch_samples[0] < observe_at, ops  # marker creation < window_start sampling < observation (window open)
    assert not any(i < marker_at for i in epoch_samples), "no epoch may be sampled before the stage-global marker exists"
    # recorded TIMES agree: the marker file's mtime (stat) is not after the recorded window start, which is not after the observation hook's own clock reading
    marker = tmp_path / "canon/R1A-GLOBAL-ATTEMPT-CONSUMED"
    start = float(re.search(r"consumed_epoch=(\S+)", (tmp_path / "auth/R1A-ATTEMPT-CONSUMED").read_text()).group(1))
    mtime = float(subprocess.run(["stat", "-c", "%.9Y", str(marker)], capture_output=True, text=True).stdout)
    assert mtime <= start <= float((tmp_path / "observe.time").read_text())


def test_a_failed_local_marker_after_the_global_marker_leaves_the_attempt_consumed_without_retry(tmp_path: Path) -> None:
    auth = tmp_path / "auth"
    auth.mkdir()
    script = f'''AUTH="{auth}"; {seam(tmp_path)}. "{LIB}"; SUDO=""
r1a_hook_pregates() {{ true; }}; r1a_hook_baseline() {{ chmod 555 "$AUTH"; }}; r1a_hook_regate() {{ true; }}
r1a_hook_observe() {{ echo OBSERVE_RAN; }}; r1a_hook_final() {{ true; }}; r1a_hook_verify() {{ true; }}; r1a_hook_preserve_evidence() {{ true; }}
r1a_run_attempt "$AUTH" 30; echo "rc=$?"; chmod 755 "$AUTH"; r1a_run_attempt "$AUTH" 30; echo "rerun_rc=$?"'''
    result = bash(script)
    assert "rc=1" in result.stdout and "R1A_LOCAL_MARKER_NOT_WRITTEN" in result.stderr and "OBSERVE_RAN" not in result.stdout  # no window opened
    assert "R1A_EVENT_WINDOW_OPEN=YES" not in result.stdout
    assert (tmp_path / "canon/R1A-GLOBAL-ATTEMPT-CONSUMED").is_file()  # still consumed; never deleted or rewritten
    assert "rerun_rc=1" in result.stdout and "R1A_ATTEMPT_ALREADY_CONSUMED" in result.stderr  # no retry even though the local marker is absent


def test_consumption_order_in_the_library_is_marker_then_start_then_local_record() -> None:
    body = LIB.read_text()
    fn = body[body.index("r1a_consume_attempt() {"):body.index("# ---- predecessor receipt gates")]
    assert fn.index("set -o noclobber; printf \"consumed_at") < fn.index("R1A_WINDOW_START=$(date +%s.%N)") < fn.index("$dir/R1A-ATTEMPT-CONSUMED")
    assert "date +%s.%N" not in body[:body.index("r1a_consume_attempt() {")].replace("# ", "")  # no earlier sampling anywhere in the library


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
