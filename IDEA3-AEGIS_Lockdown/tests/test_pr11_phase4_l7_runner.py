# shellcheck shell=bash disable=SC1091
"""AEGIS IDEA3 PR11 Phase 4 — L7 owner-runner gate library, TLS-hostname probe and runner contract tests.

Nothing here runs the runner against a host: the library gates are exercised with PATH stubs, fixture git repositories, fixture
release/input directories and a throwaway loopback Mosquitto, and the runner template is checked statically plus by proving it
refuses to run unpinned (main SHA and release id). The runner follows the L6b governance model: unpinned template, frozen outside
the repository, one attempt per authorization, no automatic retry.
"""

from __future__ import annotations

import os
import re
import socket
import stat
import subprocess
import sys
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))
import l7_support as s  # noqa: E402
from test_mqtt_tls_server_name import NAME, make_profile_pki  # noqa: E402
from test_pr11_phase4_l7_release_guard_helper import build_release  # noqa: E402

ROOT = s.ROOT
DEPLOY = s.DEPLOY
LIB = DEPLOY / "p4-l7-run-lib.sh"
RUNNER = DEPLOY / "owner-run" / "run-l7-owner.sh"
PROBE = DEPLOY / "p4-l7-broker-probe.py"
LOGS = "Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs"
UNIT = "aegis-idea3-core.service"
BROKER_UNIT = "aegis-idea3-mosquitto.service"


def lib(script: str, *, env: dict[str, str] | None = None, path_prefix: Path | None = None,
        unset: tuple[str, ...] = (), cwd: Path | None = None) -> subprocess.CompletedProcess[str]:
    e = os.environ.copy()
    e["SUDO"] = ""
    if path_prefix:
        e["PATH"] = f"{path_prefix}:{e['PATH']}"
    if env:
        e.update(env)
    for k in unset:
        e.pop(k, None)
    return subprocess.run(["bash", "-c", f"source '{LIB}'; {script}"], text=True, capture_output=True, env=e, cwd=cwd, check=False)


def stub(bin_dir: Path, name: str, body: str) -> None:
    bin_dir.mkdir(parents=True, exist_ok=True)
    f = bin_dir / name
    f.write_text("#!/usr/bin/env bash\n" + body + "\n")
    f.chmod(0o755)


# ── 1. static runner contract ────────────────────────────────────────────────────────────────────────────────────────────


def test_l7_runner_files_exist_and_are_syntactically_valid() -> None:
    assert LIB.is_file() and RUNNER.is_file() and PROBE.is_file()
    assert stat.S_IMODE(RUNNER.stat().st_mode) & 0o111
    for f in (LIB, RUNNER):
        assert subprocess.run(["bash", "-n", str(f)]).returncode == 0, f


def test_l7_runner_template_is_unpinned_and_refuses_to_run(tmp_path: Path) -> None:
    text = RUNNER.read_text()
    assert "EXPECTED_MAIN=PIN_MAIN_SHA" in text and "RELEASE_ID=PIN_RELEASE_ID" in text
    res = subprocess.run(["bash", str(RUNNER), str(tmp_path)], text=True, capture_output=True)
    assert res.returncode == 2 and "not pinned" in res.stdout


@pytest.mark.parametrize("main,rel", [("not-a-sha", "rel-20260927"), ("a" * 40, "PIN_RELEASE_ID"), ("a" * 40, "../evil"), ("a" * 40, "has space"),
                                      ("a" * 40, "")])
def test_l7_runner_refuses_a_malformed_or_missing_pin(tmp_path: Path, main: str, rel: str) -> None:
    pinned = tmp_path / "run.sh"
    pinned.write_text(RUNNER.read_text().replace("PIN_MAIN_SHA", main).replace("RELEASE_ID=PIN_RELEASE_ID", f'RELEASE_ID="{rel}"'))
    res = subprocess.run(["bash", str(pinned), str(tmp_path)], text=True, capture_output=True)
    assert res.returncode == 2 and "STOP" in res.stdout


def test_l7_runner_never_runs_as_root_and_requires_sudo_before_mutation() -> None:
    text = RUNNER.read_text()
    assert 'id -u)" != 0' in text
    assert text.index("sudo -v") < text.index("l7_consume_attempt") < text.index("PRE capture")


def test_l7_runner_gates_all_precede_the_one_attempt_marker() -> None:
    """Every read-only gate runs BEFORE the authorization is consumed (a failing pre-gate must not burn it)."""
    text = RUNNER.read_text()
    consume = text.index("l7_consume_attempt")
    for gate in ("l7_receipt_gate", "l7_release_gate", "l7_core_prestate_gate", "l7_broker_runtime_gate", "l7_input_gate", "l7_disk_gate",
                 "l7_idea2_s10_gate", "l7_d6_gate", "l7_tls_probe", "l6b_ap_runtime_gate", "l6b_nft_text_gate", "l6b_trustedclock_gate",
                 "p4-stage-gate.sh"):
        assert gate in text, gate
        assert text.index(gate) < consume, gate
    assert text.index('[ "$GATE_FAILED" = 0 ] || die') < consume


def test_l7_runner_pre_capture_precedes_any_change_and_each_handler_is_invoked_once() -> None:
    text = RUNNER.read_text()
    for h in ("apply", "verify", "rollback"):
        assert len(re.findall(rf"handler {h}\.sh", text)) == 1, h
    assert text.index("capture PRE") < text.index("handler apply.sh") < text.index("handler verify.sh")
    assert text.index("handler verify.sh") < text.index("capture POST")
    assert text.index("capture POST") < text.index('compare "$EVID/pre-root" "$EVID/post-root"')


def test_l7_runner_success_is_persistent_never_rolls_back_and_never_starts_l8() -> None:
    text = RUNNER.read_text()
    tail = text[text.index("trap - ERR INT TERM\necho \"L7_LIVE_EXECUTED"):]
    assert "rollback" not in tail.lower().replace("rollback_flow", "")
    assert "PERSISTENT" in tail and "L8_STARTED=NO" in tail
    for m in re.finditer(r"rollback_flow ", text):
        line = text[text.rfind("\n", 0, m.start()) + 1: text.find("\n", m.start())]
        assert "||" in line or "rollback_flow()" in line or "fail_after_mutation" in line, line


def test_l7_runner_rollback_flow_is_bounded_and_never_retries() -> None:
    text = RUNNER.read_text()
    assert 'compare "$EVID/pre-root" "$EVID/rb-root" "$EVID/compare-pre-rb.txt" &&' in text
    assert 'compare-pre-rb.txt" allow' not in text and 'compare-pre-post.txt" allow' in text
    assert "NOT retrying" in text and "S-11 HOLD" in text
    assert not re.search(r"\b(while|until)\b", "\n".join(l for l in text.splitlines() if not l.lstrip().startswith("#")))  # no retry loop
    assert not re.search(r"retry|attempt2|attempt_2", "\n".join(l for l in text.splitlines() if not l.lstrip().startswith("#") and "NOT retrying" not in l and "do NOT retry" not in l), re.I)
    assert text.count("l7_consume_attempt") == 1


def test_l7_runner_has_no_predecessor_repair_secret_creation_l8_or_actuation() -> None:
    text = "\n".join(l for l in RUNNER.read_text().splitlines() if not l.lstrip().startswith("#"))
    for pat in (
        r"nmcli\s+(connection|con|device)\s+(up|down|modify|delete)", r"\bnft\s+(add|delete|flush|-f)", r"sysctl\s+-w",
        r"systemctl\s+(restart|stop|start|reload|enable|disable|mask|reset-failed)\b", r"\bpkill\b", r"\bkillall\b", r"\brm\s+-\w*r", r"\bchronyc\b",
        r"\btwingate\s+(stop|start|restart)", r"\breboot\b", r"/dev/tty", r"esptool", r"platformio", r"mosquitto_pub", r"mosquitto_sub",
        r"openssl\s+(rand|genrsa|ecparam|req)", r"/dev/urandom", r"\bsecrets\.token", r"token_hex", r"\bpwgen\b", r"stages/L8", r"stages/L9",
        r"\bCUT_UPLINK\b", r"\bRESTORE_UPLINK\b", r"IDEA[12]-", r"systemctl\s+\w+\s+aegis-detection",
    ):
        assert not re.search(pat, text), pat
    assert "PREDECESSOR_RUNTIME_REACTIVATION_REQUIRED" in RUNNER.read_text() + LIB.read_text()


def test_l7_runner_freezes_the_owner_decisions_and_uses_the_l7_authorization_records() -> None:
    text = RUNNER.read_text()
    assert "AP_IF=wlp0s20f3" in text and "AP_ADDR=10.77.30.1" in text and "AEGIS_L7_LIVE_AUTHORIZED=YES" in text
    assert "--stage L7 --mode live" in text and "authorization-L7.txt" in text and "k3-L7.txt" in text and "stage=L7" in text
    assert "l7_d6_gate" in text and "L7-ATTEMPT-CONSUMED" in LIB.read_text()
    assert "AEGIS_L7_RELEASE_DIR=" in text and "$RELEASE_ID" in text and "AEGIS_L7_INPUT_DIR" in text
    assert "L7_LIVE_ACCEPTANCE=PROVEN" in text  # printed only on the success path


def test_l7_runner_disk_and_gate_thresholds_are_the_design_values() -> None:
    text = RUNNER.read_text()
    assert re.search(r"l7_disk_gate 80 / /var /opt", text)


def test_l7_runner_never_deletes_the_owner_input_or_creates_secrets() -> None:
    text = RUNNER.read_text()
    assert "NOT deleted" in text
    assert "rm -" not in "\n".join(l for l in text.splitlines() if not l.lstrip().startswith("#"))


# ── 2. one attempt per authorization ─────────────────────────────────────────────────────────────────────────────────────


def test_l7_one_attempt_marker_is_atomic_and_final(tmp_path: Path) -> None:
    auth = tmp_path / "auth"
    auth.mkdir()
    assert lib(f"l7_consume_attempt '{auth}'").returncode == 0 and (auth / "L7-ATTEMPT-CONSUMED").is_file()
    second = lib(f"l7_consume_attempt '{auth}'")
    assert second.returncode == 1 and "L7_ATTEMPT_ALREADY_CONSUMED" in second.stderr


def test_l7_one_attempt_marker_rejects_symlinked_or_missing_auth_dir(tmp_path: Path) -> None:
    real = tmp_path / "real"
    real.mkdir()
    link = tmp_path / "link"
    link.symlink_to(real)
    assert lib(f"l7_consume_attempt '{link}'").returncode == 1 and lib(f"l7_consume_attempt '{tmp_path / 'nope'}'").returncode == 1


def test_l7_marker_is_distinct_from_the_l6b_marker(tmp_path: Path) -> None:
    auth = tmp_path / "auth"
    auth.mkdir()
    (auth / "L6B-ATTEMPT-CONSUMED").write_text("x")
    assert lib(f"l7_consume_attempt '{auth}'").returncode == 0  # an L6b marker never blocks/permits L7, and vice versa


# ── 3. predecessor receipt gate (bound to the pinned commit) ─────────────────────────────────────────────────────────────

L6A_RECEIPT = "2026-09-27_002532_music_idea3-pr11-l6a-live-acceptance.md"
L6A_TEXT = "# r\n\n```text\nL6A_LIVE_ACCEPTANCE=PROVEN\nL6A_COMPLETE=YES\nL6B_STARTED=NO\n```\n"
L6B_TEXT = "# r\n\n> `L6B_LIVE_ACCEPTANCE = PROVEN`\n"


def git(repo: Path, *args: str) -> None:
    env = dict(os.environ, GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@t", GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@t")
    subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True, env=env)


def make_repo(tmp_path: Path, *, skip: str = "", l6b: str | None = L6B_TEXT, l7: str | None = None, l6b_uncommitted: bool = False) -> Path:
    repo = tmp_path / "repo"
    logs = repo / LOGS
    logs.mkdir(parents=True)
    git(repo, "init", "-q")
    for n in (2, 3, 4, 5):
        if f"L{n}" != skip:
            (logs / f"2026-09-2{n}_000000_music_idea3-pr11-l{n}-live-acceptance.md").write_text(f"`L{n}_LIVE_ACCEPTANCE = PROVEN`\n")
    (logs / L6A_RECEIPT).write_text(L6A_TEXT)
    if l6b is not None and not l6b_uncommitted:
        (logs / "2026-09-27_120422_music_idea3-pr11-l6b-attempt2-live-acceptance.md").write_text(l6b)
    if l7 is not None:
        (logs / "2026-09-28_000000_music_idea3-pr11-l7-live.md").write_text(l7)
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "fixture")
    if l6b is not None and l6b_uncommitted:
        (logs / "2026-09-27_120422_music_idea3-pr11-l6b-attempt2-live-acceptance.md").write_text(l6b)
    return repo


def test_l7_receipt_gate_passes_with_l2_to_l6b_accepted(tmp_path: Path) -> None:
    res = lib(f"l7_receipt_gate '{make_repo(tmp_path)}'")
    assert res.returncode == 0, res.stderr


@pytest.mark.parametrize("skip", ["L2", "L3", "L4", "L5"])
def test_l7_receipt_gate_requires_each_l2_to_l5_acceptance(tmp_path: Path, skip: str) -> None:
    res = lib(f"l7_receipt_gate '{make_repo(tmp_path, skip=skip)}'")
    assert res.returncode == 1 and f"L{skip[1]}" in res.stderr


def test_l7_receipt_gate_requires_the_l6b_live_acceptance_receipt(tmp_path: Path) -> None:
    res = lib(f"l7_receipt_gate '{make_repo(tmp_path, l6b=None)}'")
    assert res.returncode == 1 and "L7_L6B_ACCEPTANCE_RECEIPT_MISSING" in res.stderr
    res = lib(f"l7_receipt_gate '{make_repo(tmp_path / 'b', l6b='# r\n`L6B_LIVE_ACCEPTANCE = NOT PROVEN`\n')}'")
    assert res.returncode == 1 and "L7_L6B_ACCEPTANCE_RECEIPT_MISSING" in res.stderr


def test_l7_receipt_gate_ignores_an_unmerged_working_tree_only_l6b_receipt(tmp_path: Path) -> None:
    res = lib(f"l7_receipt_gate '{make_repo(tmp_path, l6b_uncommitted=True)}'")
    assert res.returncode == 1 and "L7_L6B_ACCEPTANCE_RECEIPT_MISSING" in res.stderr


def test_l7_receipt_gate_refuses_when_l7_is_already_accepted(tmp_path: Path) -> None:
    res = lib(f"l7_receipt_gate '{make_repo(tmp_path, l7='`L7_LIVE_ACCEPTANCE = PROVEN`')}'")
    assert res.returncode == 1 and "L7_ALREADY_ACCEPTED" in res.stderr


def test_l7_receipt_gate_passes_against_the_real_repository_history() -> None:
    """The gate must accept the actual merged L2..L6b receipts on this branch's base (proves marker/regex compatibility)."""
    repo = ROOT.parent
    if subprocess.run(["git", "-C", str(repo), "grep", "-q", "L6B_LIVE_ACCEPTANCE", "HEAD", "--", LOGS], capture_output=True).returncode != 0:
        pytest.skip("L6b acceptance receipt not present at HEAD of this checkout")
    res = lib(f"l7_receipt_gate '{repo}'")
    assert res.returncode == 0, res.stderr


# ── 4. immutable release gate ────────────────────────────────────────────────────────────────────────────────────────────


def release_env(tmp_path: Path, *, sha_on_main: bool = True, current: str | None = None, build: bool = True):
    repo = make_repo(tmp_path)
    head = subprocess.run(["git", "-C", str(repo), "rev-parse", "HEAD"], text=True, capture_output=True, check=True).stdout.strip()
    root = tmp_path / "fs"
    (root / "opt/aegis-idea3/releases").mkdir(parents=True)
    if build:
        build_release(root / "opt/aegis-idea3/releases", release_id="rel-20260927", sha=head if sha_on_main else "b" * 40)
    if current is not None:
        (root / "opt/aegis-idea3/current").symlink_to(current)
    return repo, root, head


def release_gate(repo: Path, root: Path, head: str, rel_id: str = "rel-20260927", *, sudo: str | None = None, path_prefix: Path | None = None):
    env = {"SUDO": sudo} if sudo is not None else None
    return lib(f"l7_release_gate '{repo}' /opt/aegis-idea3/releases/{rel_id} '{head}' '{sys.executable}' '{DEPLOY}' any '{root}'",
               env=env, path_prefix=path_prefix)


def test_l7_release_gate_accepts_a_guarded_release_built_from_the_pinned_main(tmp_path: Path) -> None:
    repo, root, head = release_env(tmp_path)
    res = release_gate(repo, root, head)
    assert res.returncode == 0, res.stderr
    assert "L7_RELEASE=rel-20260927" in res.stdout and head in res.stdout


def test_l7_release_gate_reports_the_missing_release_as_a_prerequisite_not_a_repairable_gap(tmp_path: Path) -> None:
    """The real host has no /opt/aegis-idea3 at all. The runner must say so instead of creating or pointing at anything."""
    repo, root, head = release_env(tmp_path, build=False)
    res = release_gate(repo, root, head)
    assert res.returncode == 1 and "L7_RELEASE_NOT_INSTALLED_PREREQUISITE" in res.stderr
    import shutil

    shutil.rmtree(root / "opt")
    assert "L7_RELEASE_NOT_INSTALLED_PREREQUISITE" in release_gate(repo, root, head).stderr


def test_l7_release_gate_rejects_a_release_not_built_from_the_pinned_main(tmp_path: Path) -> None:
    repo, root, head = release_env(tmp_path, sha_on_main=False)
    res = release_gate(repo, root, head)
    assert res.returncode == 1 and "L7_RELEASE_SOURCE_NOT_ON_MAIN" in res.stderr


def test_l7_release_gate_rejects_a_tampered_release(tmp_path: Path) -> None:
    repo, root, head = release_env(tmp_path)
    (root / "opt/aegis-idea3/releases/rel-20260927/aegis_soc/supervisor.py").write_text("print('tampered')\n")
    res = release_gate(repo, root, head)
    assert res.returncode == 1 and "L7_RELEASE_GUARD_FAILED:CHECKSUM_MISMATCH" in res.stderr


def test_l7_release_gate_current_pointer_must_be_absent_or_the_frozen_release(tmp_path: Path) -> None:
    repo, root, head = release_env(tmp_path, current="/opt/aegis-idea3/releases/rel-20260927")
    assert release_gate(repo, root, head).returncode == 0
    repo, root, head = release_env(tmp_path / "b", current="/opt/aegis-idea3/releases/other")
    res = release_gate(repo, root, head)
    assert res.returncode == 1 and "L7_CURRENT_POINTER_MISMATCH" in res.stderr


def test_l7_release_gate_is_read_only(tmp_path: Path) -> None:
    repo, root, head = release_env(tmp_path)
    before = {p.relative_to(root).as_posix(): p.stat().st_mtime_ns for p in root.rglob("*")}
    release_gate(repo, root, head)
    assert before == {p.relative_to(root).as_posix(): p.stat().st_mtime_ns for p in root.rglob("*")}


def test_l7_release_gate_can_see_a_root_owned_0700_parent_through_sudo(tmp_path: Path) -> None:
    """The real host's /opt/aegis-idea3 is root:root mode 0700: an unprivileged owner-run process cannot even
    traverse into it to stat the release directory, so an unprivileged existence/type check would wrongly report
    L7_RELEASE_NOT_INSTALLED_PREREQUISITE for a release that genuinely exists. The existence/type check must cross
    the SAME $SUDO privilege boundary as the release-guard invocation right after it -- never a bare unprivileged
    `test`. This models the real permission boundary (a self-revoked-access directory this test process owns but
    cannot itself traverse without going through the same escalation path production uses), rather than merely
    patching around the symptom."""
    repo, root, head = release_env(tmp_path)
    locked = root / "opt/aegis-idea3"
    before_mode = locked.stat().st_mode
    os.chmod(locked, 0)
    try:
        # Un-escalated: even though the release genuinely exists, it is unreachable -- this must be classified as
        # the ordinary missing-release prerequisite, never a different/confusing error, and must stay fail-closed.
        blocked = release_gate(repo, root, head)
        assert blocked.returncode == 1 and "L7_RELEASE_NOT_INSTALLED_PREREQUISITE" in blocked.stderr, blocked.stderr

        # A stub "sudo" that emulates real sudo's DAC bypass (temporarily restoring access for the wrapped command
        # only, exactly as real root privilege would) must let the SAME release be found -- proving the existence
        # check itself is issued through $SUDO, not before it.
        bin_dir = tmp_path / "sudo-bin"
        stub(bin_dir, "sudo", f'chmod 0755 "{locked}"\n"$@"; rc=$?\nchmod 0000 "{locked}"\nexit $rc')
        res = release_gate(repo, root, head, sudo=str(bin_dir / "sudo"), path_prefix=bin_dir)
        assert res.returncode == 0, res.stderr
        assert "L7_RELEASE=rel-20260927" in res.stdout
    finally:
        os.chmod(locked, before_mode)


# ── 5. core prestate gate: exact clean state, not only not-found ─────────────────────────────────────────────────────────

CLEAN_SHOW = {"LoadState": "not-found", "ActiveState": "inactive", "SubState": "dead", "Result": "success", "MainPID": "0", "NRestarts": "0"}
RESIDUAL_SHOW = {**CLEAN_SHOW, "ActiveState": "failed", "SubState": "failed", "Result": "exit-code"}


def prestate(tmp_path: Path, show: dict[str, str], *, unit_file=False, core_env=False, creds=False, run_dir=False, l6b_ca=True, pki_dir=True,
             pki_ca: bytes | None = None, uid_gid=("952", "950"), group="aegis-idea3:x:950:", passwd="aegis-idea3:x:952:950::/x:/nologin"):
    root = tmp_path / "fs"
    for d in ("etc/systemd/system", "etc/aegis-idea3/mqtt", "run"):
        (root / d).mkdir(parents=True, exist_ok=True)
    if pki_dir:
        (root / "etc/aegis-idea3/pki").mkdir(parents=True, exist_ok=True)
    if l6b_ca:
        (root / "etc/aegis-idea3/mqtt/ca.crt").write_text("CA-BYTES\n")
    if pki_ca is not None:
        (root / "etc/aegis-idea3/pki/mqtt-ca.crt").write_bytes(pki_ca)
    if unit_file:
        (root / "etc/systemd/system" / UNIT).write_text("[Unit]\n")
    if core_env:
        (root / "etc/aegis-idea3/core.env").write_text("x\n")
    if creds:
        (root / "etc/aegis-idea3/credentials").mkdir()
    if run_dir:
        (root / "run/aegis-idea3").mkdir()
    b = tmp_path / "psbin"
    calls = tmp_path / "calls.log"
    body = "\n".join(f'  echo "{k}={v}"' for k, v in show.items())
    stub(b, "systemctl", f'echo "$*" >> "{calls}"\nif [ "$1" = show ]; then\n{body}\nelse exit 99; fi')
    stub(b, "getent", f'case "$1" in group) [ -n "{group}" ] && echo "{group}" || exit 2 ;; passwd) [ -n "{passwd}" ] && echo "{passwd}" || exit 2 ;; esac')
    stub(b, "id", f'[ "$1" = -g ] && echo "{uid_gid[1]}" || echo "{uid_gid[0]}"')
    res = lib(f"l7_core_prestate_gate {UNIT} '{root}'", path_prefix=b)
    return res, calls


def test_l7_core_prestate_gate_accepts_the_exact_clean_state(tmp_path: Path) -> None:
    res, _ = prestate(tmp_path, CLEAN_SHOW)
    assert res.returncode == 0, res.stderr


def test_l7_core_prestate_gate_rejects_stale_not_found_failed_failed_exit_code(tmp_path: Path) -> None:
    res, _ = prestate(tmp_path, RESIDUAL_SHOW)
    assert res.returncode == 1 and "L7_RESIDUAL_FAILED_STATE_CLEANUP_REQUIRED=YES" in res.stderr


@pytest.mark.parametrize("prop,value", [("ActiveState", "failed"), ("SubState", "failed"), ("Result", "exit-code"), ("ActiveState", "active"),
                                         ("MainPID", "9"), ("NRestarts", "2")])
def test_l7_core_prestate_gate_rejects_any_single_residual_property(tmp_path: Path, prop: str, value: str) -> None:
    res, _ = prestate(tmp_path, {**CLEAN_SHOW, prop: value})
    assert res.returncode == 1 and f"L7_RESIDUAL_FAILED_STATE_CLEANUP_REQUIRED=YES:{prop}={value}" in res.stderr


@pytest.mark.parametrize("kwargs,reason", [
    ({"unit_file": True}, "L7_UNIT_FILE_ALREADY_EXISTS"), ({"core_env": True}, "L7_CORE_ENV_ALREADY_EXISTS"),
    ({"creds": True}, "L7_CREDENTIALS_DIR_ALREADY_EXISTS"), ({"run_dir": True}, "L7_RUNTIME_DIR_ALREADY_EXISTS"),
    ({"l6b_ca": False}, "L7_L6B_CA_MISSING"), ({"pki_dir": False}, "L7_PKI_DIR_MISSING"), ({"pki_ca": b"DIFFERENT\n"}, "L7_PKI_CA_CONFLICT"),
    ({"group": ""}, "L7_CORE_IDENTITY_INVALID"), ({"passwd": ""}, "L7_CORE_IDENTITY_INVALID"), ({"uid_gid": ("952", "951")}, "L7_CORE_IDENTITY_INVALID"),
])
def test_l7_core_prestate_gate_rejects_residual_files_dirs_and_bad_identity(tmp_path: Path, kwargs: dict, reason: str) -> None:
    res, _ = prestate(tmp_path, CLEAN_SHOW, **kwargs)
    assert res.returncode == 1 and reason in res.stderr


def test_l7_core_prestate_gate_accepts_an_identical_existing_pki_ca(tmp_path: Path) -> None:
    res, _ = prestate(tmp_path, CLEAN_SHOW, pki_ca=b"CA-BYTES\n")
    assert res.returncode == 0, res.stderr


@pytest.mark.parametrize("show", [CLEAN_SHOW, RESIDUAL_SHOW])
def test_l7_core_prestate_gate_issues_no_systemctl_mutation(tmp_path: Path, show: dict[str, str]) -> None:
    _, calls = prestate(tmp_path, show)
    assert {l.split()[0] for l in calls.read_text().splitlines()} == {"show"}


# ── 6. persistent broker runtime gate ────────────────────────────────────────────────────────────────────────────────────

BROKER_OK = {"ActiveState": "active", "SubState": "running", "UnitFileState": "enabled", "Result": "success", "MainPID": "20169",
             "NRestarts": "646", "InvocationID": "3665a93ec42d4a52a3d7a48ad64295f0"}


def broker_gate(tmp_path: Path, show: dict[str, str] | list[dict[str, str]], listeners: str | list[str], *, extra_env: dict[str, str] | None = None):
    """Run the gate with PATH stubs. A list of shows/listeners is consumed one entry per gate sample (the last one repeats)."""
    tmp_path.mkdir(parents=True, exist_ok=True)
    b = tmp_path / "bbin"
    shows = show if isinstance(show, list) else [show]
    lsts = listeners if isinstance(listeners, list) else [listeners]
    for i, sh in enumerate(shows):
        (tmp_path / f"show.{i}").write_text("".join(f"{k}={v}\n" for k, v in sh.items()))
    for i, ls in enumerate(lsts):
        (tmp_path / f"ss.{i}").write_text(ls)
    ctr = tmp_path / "ctr"
    stub(b, "systemctl", f'if [ "$1" = show ]; then\n  n=$(cat "{tmp_path}/sctr" 2>/dev/null || echo 0); echo $((n+1)) > "{tmp_path}/sctr"\n'
                         f'  i=$((n<{len(shows) - 1} ? n : {len(shows) - 1})); cat "{tmp_path}/show.$i"\nfi')
    stub(b, "ss", f'n=$(cat "{tmp_path}/ctr" 2>/dev/null || echo 0); echo $((n+1)) > "{tmp_path}/ctr"\n'
                  f'i=$((n<{len(lsts) - 1} ? n : {len(lsts) - 1})); cat "{tmp_path}/ss.$i"')
    stub(b, "sleep", "exit 0")  # test-only: skip the real 2 s pauses
    return lib(f"l7_broker_runtime_gate {BROKER_UNIT} 10.77.30.1", path_prefix=b, env=extra_env)


GOOD_LISTEN = "LISTEN 0 100 127.0.0.1:8883 0.0.0.0:*\nLISTEN 0 100 10.77.30.1:8883 0.0.0.0:*\n"


def test_l7_broker_gate_accepts_the_persistent_l6b_broker(tmp_path: Path) -> None:
    assert broker_gate(tmp_path, BROKER_OK, GOOD_LISTEN).returncode == 0


def test_l7_broker_gate_accepts_stable_zero_restarts(tmp_path: Path) -> None:
    assert broker_gate(tmp_path, {**BROKER_OK, "NRestarts": "0"}, GOOD_LISTEN).returncode == 0


def test_l7_broker_gate_old_nrestarts_zero_policy_would_reject_646(tmp_path: Path) -> None:
    """RED reference: the pre-fix predicate (NRestarts must equal 0) rejects the healthy V5-recovered broker; the new gate accepts it."""
    old = subprocess.run(["git", "show", "21b52d5ecd5ca41a0a3c3429d93405b38dbe81b8:IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-l7-run-lib.sh"],
                         text=True, capture_output=True, cwd=ROOT, check=False)
    assert old.returncode == 0
    old_lib = tmp_path / "old-lib.sh"
    old_lib.write_text(old.stdout)
    res_new = broker_gate(tmp_path, BROKER_OK, GOOD_LISTEN)
    e = os.environ.copy()
    e.update({"SUDO": "", "PATH": f"{tmp_path / 'bbin'}:{e['PATH']}"})
    res_old = subprocess.run(["bash", "-c", f"source '{old_lib}'; l7_broker_runtime_gate {BROKER_UNIT} 10.77.30.1"], text=True, capture_output=True, env=e, check=False)
    assert res_old.returncode == 1 and "NRestarts=646" in res_old.stderr
    assert res_new.returncode == 0


@pytest.mark.parametrize("prop,value", [("ActiveState", "failed"), ("SubState", "dead"), ("UnitFileState", "disabled"), ("Result", "exit-code"),
                                         ("MainPID", "0"), ("MainPID", "12x"), ("MainPID", ""), ("NRestarts", "many"), ("NRestarts", ""),
                                         ("InvocationID", "")])
def test_l7_broker_gate_rejects_an_unhealthy_broker(tmp_path: Path, prop: str, value: str) -> None:
    res = broker_gate(tmp_path, {**BROKER_OK, prop: value}, GOOD_LISTEN)
    assert res.returncode == 1 and "L7_BROKER_NOT_HEALTHY" in res.stderr


@pytest.mark.parametrize("listeners", ["LISTEN 0 100 127.0.0.1:8883 0.0.0.0:*\n", "LISTEN 0 100 10.77.30.1:8883 0.0.0.0:*\n",
                                       GOOD_LISTEN + "LISTEN 0 100 0.0.0.0:8883 0.0.0.0:*\n",
                                       GOOD_LISTEN + "LISTEN 0 100 192.168.1.144:8883 0.0.0.0:*\n", ""])
def test_l7_broker_gate_requires_exactly_loopback_plus_ap_8883(tmp_path: Path, listeners: str) -> None:
    res = broker_gate(tmp_path, BROKER_OK, listeners)
    assert res.returncode == 1 and "L7_BROKER_LISTENERS_INVALID" in res.stderr


@pytest.mark.parametrize("change", [{"NRestarts": "647"}, {"MainPID": "20170"}, {"InvocationID": "ffffffffffffffffffffffffffffffff"}])
def test_l7_broker_gate_rejects_identity_change_between_samples(tmp_path: Path, change: dict[str, str]) -> None:
    res = broker_gate(tmp_path, [BROKER_OK, {**BROKER_OK, **change}], GOOD_LISTEN)
    assert res.returncode == 1 and "L7_BROKER_UNSTABLE" in res.stderr


@pytest.mark.parametrize("bad", [{"ActiveState": "activating", "SubState": "auto-restart", "MainPID": "0"}, {"ActiveState": "failed", "SubState": "failed", "Result": "exit-code"}])
def test_l7_broker_gate_rejects_running_to_restart_or_failed_transition(tmp_path: Path, bad: dict[str, str]) -> None:
    res = broker_gate(tmp_path, [BROKER_OK, {**BROKER_OK, **bad}], GOOD_LISTEN)
    assert res.returncode == 1 and "L7_BROKER_NOT_HEALTHY" in res.stderr


@pytest.mark.parametrize("later", ["LISTEN 0 100 127.0.0.1:8883 0.0.0.0:*\n", GOOD_LISTEN + "LISTEN 0 100 0.0.0.0:8883 0.0.0.0:*\n"])
def test_l7_broker_gate_rejects_listener_change_after_first_sample(tmp_path: Path, later: str) -> None:
    res = broker_gate(tmp_path, BROKER_OK, [GOOD_LISTEN, later])
    assert res.returncode == 1 and "L7_BROKER_LISTENERS_INVALID" in res.stderr


def test_l7_broker_gate_takes_multiple_samples_and_cannot_be_weakened_by_environment(tmp_path: Path) -> None:
    res = broker_gate(tmp_path, BROKER_OK, GOOD_LISTEN,
                      extra_env={"L7_BROKER_STABILITY_SAMPLES": "1", "L7_BROKER_STABILITY_INTERVAL_S": "0"})
    assert res.returncode == 0
    assert int((tmp_path / "sctr").read_text()) == 3
    # a change only visible on the last sample still fails even with the weakening variables exported
    res = broker_gate(tmp_path / "w", [BROKER_OK, BROKER_OK, {**BROKER_OK, "NRestarts": "647"}], GOOD_LISTEN,
                      extra_env={"L7_BROKER_STABILITY_SAMPLES": "1"})
    assert res.returncode == 1 and "L7_BROKER_UNSTABLE" in res.stderr


def test_l7_broker_gate_is_read_only_and_never_repairs(tmp_path: Path) -> None:
    body = LIB.read_text()
    start = body.index("_l7_broker_sample()")
    end = body.index("# l7_disk_gate")
    section = body[start:end]
    assert not re.search(r"\b(start|stop|restart|reload|reset-failed|enable|disable|mask|kill|daemon-reload)\b", re.sub(r"#.*", "", section))
    broker_gate(tmp_path, BROKER_OK, GOOD_LISTEN)
    assert "sctr" in {p.name for p in tmp_path.iterdir()}


def test_l6c_and_l7_runners_keep_broker_pre_post_snapshot_comparison() -> None:
    """The window protection is unchanged: BROKER_PRE is snapshotted and s10_unchanged still compares broker PID/NRestarts PRE→POST."""
    for runner in ("run-l7-owner.sh", "run-l6c-owner.sh"):
        text = (DEPLOY / "owner-run" / runner).read_text()
        assert "BROKER_PRE=$(snap $BROKER_UNIT)" in text, runner
        assert 's10_unchanged() {' in text and '[ "$(snap $BROKER_UNIT)" = "$BROKER_PRE" ]' in text, runner
    base = subprocess.run(["git", "diff", "--stat", "21b52d5ecd5ca41a0a3c3429d93405b38dbe81b8", "--", "IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/owner-run",
                           "IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-compare.sh"], text=True, capture_output=True, cwd=ROOT, check=False)
    assert base.stdout.strip() == ""


# ── 7. disk, IDEA2 §10, D6 ───────────────────────────────────────────────────────────────────────────────────────────────


def df_stub(tmp_path: Path, pct: dict[str, int]) -> Path:
    b = tmp_path / "dfbin"
    cases = "\n".join(f'  "{p}") echo "Filesystem 1K-blocks Used Available Use% Mounted"; echo "x 100 {v} {100 - v} {v}% {p}" ;;' for p, v in pct.items())
    stub(b, "df", f'case "$2" in\n{cases}\n  *) exit 1 ;;\nesac')
    return b


@pytest.mark.parametrize("pcts,ok,reason", [
    ({"/": 50, "/var": 50, "/opt": 50}, True, ""), ({"/": 80, "/var": 80, "/opt": 80}, True, ""),
    ({"/": 81, "/var": 10, "/opt": 10}, False, "L7_DISK_HEADROOM:/=81"), ({"/": 10, "/var": 95, "/opt": 10}, False, "L7_DISK_HEADROOM:/var=95"),
    ({"/": 10, "/var": 10, "/opt": 99}, False, "L7_DISK_HEADROOM:/opt=99"), ({"/": 10, "/var": 10}, False, "L7_DISK_UNREADABLE:/opt"),
])
def test_l7_disk_gate_requires_20_percent_free_on_root_var_and_opt(tmp_path: Path, pcts: dict, ok: bool, reason: str) -> None:
    res = lib("l7_disk_gate 80 / /var /opt", path_prefix=df_stub(tmp_path, pcts))
    assert (res.returncode == 0) is ok and reason in res.stderr


def unit_stub(tmp_path: Path, states: dict[str, tuple[str, str]]) -> Path:
    b = tmp_path / "ubin"
    cases = "\n".join(f'  "{u}") case "$3" in ActiveState) echo {a};; SubState) echo {sub};; esac ;;' for u, (a, sub) in states.items())
    stub(b, "systemctl", f'# systemctl show -p PROP --value UNIT\ncase "$5" in\n{cases}\nesac')
    return b


def test_l7_idea2_s10_gate_requires_engine_and_tunnel_active_running(tmp_path: Path) -> None:
    ok = unit_stub(tmp_path, {"eng.service": ("active", "running"), "tun.service": ("active", "running")})
    assert lib("l7_idea2_s10_gate eng.service tun.service", path_prefix=ok).returncode == 0
    bad = unit_stub(tmp_path / "b", {"eng.service": ("active", "running"), "tun.service": ("failed", "failed")})
    res = lib("l7_idea2_s10_gate eng.service tun.service", path_prefix=bad)
    assert res.returncode == 1 and "L7_IDEA2_S10_NOT_PRESERVABLE:tun.service" in res.stderr


def test_l7_d6_gate_requires_the_pub_notice_in_the_authorization(tmp_path: Path) -> None:
    good = tmp_path / "a.txt"
    good.write_text("AEGIS_P4_AUTHORIZATION_V1\nstage=L7\nd6_notice=pub\n")
    assert lib(f"l7_d6_gate '{good}'").returncode == 0
    for text in ("stage=L7\n", "stage=L7\nd6_notice=kla\n", "stage=L7\nd6_notice=pub extra\n", "stage=L7\n#d6_notice=pub\n"):
        bad = tmp_path / "b.txt"
        bad.write_text(text)
        res = lib(f"l7_d6_gate '{bad}'")
        assert res.returncode == 1 and "L7_D6_NOTICE_MISSING" in res.stderr
    assert lib(f"l7_d6_gate '{tmp_path / 'absent'}'").returncode == 1


# ── 8. owner input gate: contents validated, never printed ───────────────────────────────────────────────────────────────


def input_gate(inp: Path):
    return lib(f"l7_input_gate '{inp}' '{sys.executable}' '{ROOT}'")


def test_l7_input_gate_accepts_the_exact_private_input(tmp_path: Path) -> None:
    assert input_gate(s.make_input(tmp_path / "in")).returncode == 0


@pytest.mark.parametrize("mutate,reason", [
    (lambda i: i.chmod(0o755), "L7_INPUT_DIR_MODE_NOT_0700"),
    (lambda i: (i / "ca.key").write_text("x"), "L7_CA_PRIVATE_KEY_FORBIDDEN"),
    (lambda i: (i / "extra").write_text("x"), "L7_INPUT_ENTRIES_NOT_EXACT"),
    (lambda i: (i / "restore.credential").unlink(), "L7_INPUT_ENTRIES_NOT_EXACT"),
    (lambda i: (i / "k_c2d").chmod(0o644), "L7_INPUT_SECRET_MODE_INVALID:k_c2d"),
    (lambda i: (i / "admin.pin").chmod(0o660), "L7_INPUT_SECRET_MODE_INVALID:admin.pin"),
    (lambda i: (i / "k_d2c").write_text(s.C2D + "\n"), "L7_PROTOCOL_KEY_INVALID"),
    (lambda i: (i / "k_c2d").write_text("0" * 64 + "\n"), "L7_PROTOCOL_KEY_INVALID"),
    (lambda i: (i / "k_c2d").write_text(bytes(range(0x20)).hex() + "\n"), "L7_PROTOCOL_KEY_INVALID"),
    (lambda i: (i / "admin.pin").write_text("1234\n"), "L7_ADMIN_PIN_INVALID"),
    (lambda i: (i / "admin.pin").write_text("\n"), "L7_ADMIN_PIN_INVALID"),
    (lambda i: (i / "mqtt-core.pass").write_text("\n"), "L7_MQTT_PASSWORD_EMPTY"),
    (lambda i: (i / "restore.credential").write_text("nope\n"), "L7_RESTORE_CREDENTIAL_INVALID"),
])
def test_l7_input_gate_fails_closed(tmp_path: Path, mutate, reason: str) -> None:
    inp = s.make_input(tmp_path / "in")
    mutate(inp)
    res = input_gate(inp)
    assert res.returncode == 1 and reason in res.stderr, res.stderr


def test_l7_input_gate_rejects_symlinked_and_foreign_owner_inputs(tmp_path: Path) -> None:
    inp = s.make_input(tmp_path / "in")
    real = tmp_path / "real"
    real.write_text((inp / "admin.pin").read_text())
    real.chmod(0o600)
    (inp / "admin.pin").unlink()
    (inp / "admin.pin").symlink_to(real)
    assert "L7_INPUT_NOT_REGULAR:admin.pin" in input_gate(inp).stderr
    link = tmp_path / "link"
    link.symlink_to(inp)
    assert "L7_INPUT_DIR_INVALID" in input_gate(link).stderr


def test_l7_input_gate_never_prints_secret_contents(tmp_path: Path) -> None:
    inp = s.make_input(tmp_path / "in")
    (inp / "extra").write_text("x")
    (inp / "k_c2d").write_text(s.C2D[:-1] + "\n")
    res = input_gate(inp)
    for secret in s.SECRETS:
        assert secret not in res.stdout + res.stderr


# ── 9. evidence secret scan ──────────────────────────────────────────────────────────────────────────────────────────────


def scan(inp: Path, evid: Path):
    return lib(f"l7_secret_scan '{inp}' '{evid}' '{sys.executable}'")


@pytest.mark.parametrize("content,hit", [
    ("stage L7 PASS\nlisteners 127.0.0.1:8883\nstate WAIT_DEVICE\n", False),
    *[(f"debug value={secret}\n", True) for secret in (s.C2D, s.D2C, s.MQTT_PASS, s.ADMIN_PIN)],
    ("-----BEGIN EC PRIVATE KEY-----\nMHcCAQEE\n-----END EC PRIVATE KEY-----\n", True),
    ("hashed scrypt$16384$8$1$" + "ab" * 16 + "$" + "cd" * 32 + "\n", True),
])
def test_l7_secret_scan_detects_plaintext_secrets_keys_and_restore_hashes(tmp_path: Path, content: str, hit: bool) -> None:
    inp = s.make_input(tmp_path / "in")
    evid = tmp_path / "evid"
    (evid / "sub").mkdir(parents=True)
    (evid / "sub" / "log.txt").write_text(content)
    res = scan(inp, evid)
    assert (res.returncode == 1) is hit, res.stdout + res.stderr
    for secret in s.SECRETS:
        assert secret not in res.stdout + res.stderr


def test_l7_secret_scan_detects_the_restore_credential_hash_line(tmp_path: Path) -> None:
    inp = s.make_input(tmp_path / "in")
    evid = tmp_path / "evid"
    evid.mkdir()
    (evid / "x.txt").write_text("leak " + (inp / "restore.credential").read_text())
    assert scan(inp, evid).returncode == 1


def test_l7_secret_scan_scans_the_rollback_archive_too(tmp_path: Path) -> None:
    inp = s.make_input(tmp_path / "in")
    evid = tmp_path / "evid"
    (evid / "l7-work/rollback-archive/var-lib-aegis-idea3/data").mkdir(parents=True)
    (evid / "l7-work/rollback-archive/var-lib-aegis-idea3/data/core-audit.sqlite3").write_bytes(b"...pin=" + s.ADMIN_PIN.encode() + b"...")
    assert scan(inp, evid).returncode == 1


# ── 10. MQTT TLS hostname probe (no credentials, no MQTT packets) ────────────────────────────────────────────────────────


@pytest.fixture()
def tls_broker(tmp_path: Path):
    pki = tmp_path / "pki"
    make_profile_pki(pki)
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    conf = tmp_path / "b.conf"
    conf.write_text(f"allow_anonymous true\npersistence false\nlistener {port} 127.0.0.1\ncafile {pki/'ca.crt'}\ncertfile {pki/'broker.crt'}\n"
                    f"keyfile {pki/'broker.key'}\ntls_version tlsv1.2\n")
    proc = subprocess.Popen(["mosquitto", "-c", str(conf)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        try:
            socket.create_connection(("127.0.0.1", port), timeout=0.2).close()
            break
        except OSError:
            time.sleep(0.05)
    yield pki / "ca.crt", port
    proc.terminate()
    proc.wait(timeout=3)


def probe(ca: Path, port: int, name: str = NAME, address: str = "127.0.0.1") -> subprocess.CompletedProcess[str]:
    return subprocess.run([sys.executable, str(PROBE), "tls", "--repo-root", str(ROOT), "--ca-file", str(ca), "--address", address, "--port", str(port),
                           "--server-name", name], text=True, capture_output=True, check=False)


def test_l7_tls_probe_verifies_the_dns_name_while_connecting_to_the_ip(tls_broker) -> None:
    ca, port = tls_broker
    res = probe(ca, port)
    assert res.returncode == 0 and "L7_BROKER_TLS_PROBE=PASS" in res.stdout, res.stdout + res.stderr


def test_l7_tls_probe_fails_on_a_wrong_name_wrong_ca_and_no_listener(tls_broker, tmp_path: Path) -> None:
    ca, port = tls_broker
    assert probe(ca, port, name="wrong.example.test").returncode == 1
    other = tmp_path / "other"
    make_profile_pki(other)
    assert probe(other / "ca.crt", port).returncode == 1
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        free = sock.getsockname()[1]
    assert probe(ca, free).returncode == 1


@pytest.mark.parametrize("port", [1883, 0, 70000])
def test_l7_tls_probe_refuses_plaintext_and_invalid_ports(tls_broker, port: int) -> None:
    ca, _ = tls_broker
    assert probe(ca, port).returncode == 2


def test_l7_tls_probe_never_authenticates_or_speaks_mqtt() -> None:
    text = PROBE.read_text()
    for banned in ("paho", "username_pw_set", "CONNECT", "publish", "subscribe", "password", "mosquitto_pub"):
        assert banned not in text, banned
