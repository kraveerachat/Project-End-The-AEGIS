"""Regression contract for the Core TrustedClock sandbox repair (CTu).

These tests are repository-only.  They inspect the reviewed unit and governed
successor package; they never invoke systemctl, Production, Recovery, or an
ESP32.
"""

from pathlib import Path
import hashlib
import importlib.util
import json
import re
import sqlite3
import subprocess
import tempfile


ROOT = Path(__file__).parents[1]
APP = ROOT / "deploy"
UNIT = APP / "aegis-idea3-core.service.example"
P4 = APP / "pr11-phase4"
CTU = P4 / "stages" / "CTu"
RUNNER = P4 / "owner-run" / "run-ctu-owner.sh"
VERIFY = CTU / "verify.sh"
RUNTIME_VERIFY = P4 / "p4-ctu-runtime-verify.py"
DROPIN_VERIFY = P4 / "ctu-acceptance" / "ctu_dropin_contract.py"


def _load_dropin_verifier():
    spec = importlib.util.spec_from_file_location("ctu_dropin_contract", DROPIN_VERIFY)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _dropin_fixture(tmp_path: Path) -> tuple[Path, Path, list[str]]:
    root = tmp_path / "root"
    dropin_dir = root / "etc/systemd/system/aegis-idea3-core.service.d"
    dropin_dir.mkdir(parents=True)
    names = ["10-recovery.conf", "20-f1-alert.conf"]
    for name, source in zip(
        names,
        (APP / "aegis-idea3-core-recovery.dropin.example", APP / "aegis-idea3-core-alert.dropin.example"),
    ):
        target = dropin_dir / name
        target.write_bytes(source.read_bytes())
        target.chmod(0o644)
    return root, dropin_dir, [str(dropin_dir / name) for name in names]


def test_ctu_dropin_contract_accepts_exact_two_and_reordered_systemd_paths(tmp_path: Path) -> None:
    verifier = _load_dropin_verifier()
    root, _dropin_dir, paths = _dropin_fixture(tmp_path)
    result = verifier.validate_dropins(ROOT, "3e26a61e32cc1073265f68659c6bbd5805d5401b", root, list(reversed(paths)), owner_uid=__import__("os").geteuid(), owner_gid=__import__("os").getegid())
    assert result == {"10-recovery.conf", "20-f1-alert.conf"}


def test_ctu_dropin_contract_refuses_wrong_owner_expectation(tmp_path: Path) -> None:
    verifier = _load_dropin_verifier()
    root, _dropin_dir, paths = _dropin_fixture(tmp_path)
    with __import__("pytest").raises(verifier.DropInContractError, match="OWNER_MISMATCH"):
        verifier.validate_dropins(ROOT, "3e26a61e32cc1073265f68659c6bbd5805d5401b", root, paths, owner_uid=__import__("os").geteuid() + 1, owner_gid=__import__("os").getegid())


@__import__("pytest").mark.parametrize(
    "case",
    ("missing-recovery", "missing-alert", "foreign", "changed-recovery", "changed-alert", "symlink", "wrong-mode"),
)
def test_ctu_dropin_contract_refuses_invalid_preconsume_topology(tmp_path: Path, case: str) -> None:
    verifier = _load_dropin_verifier()
    root, dropin_dir, paths = _dropin_fixture(tmp_path)
    if case == "missing-recovery":
        paths[0] = str(dropin_dir / "missing-recovery.conf")
    elif case == "missing-alert":
        paths[1] = str(dropin_dir / "missing-alert.conf")
    elif case == "foreign":
        (dropin_dir / "30-foreign.conf").write_text("[Service]\nProtectSystem=false\n")
        paths.append(str(dropin_dir / "30-foreign.conf"))
    elif case == "changed-recovery":
        (dropin_dir / "10-recovery.conf").write_text("changed\n")
    elif case == "changed-alert":
        (dropin_dir / "20-f1-alert.conf").write_text("changed\n")
    elif case == "symlink":
        target = dropin_dir / "10-recovery.conf"
        target.unlink()
        target.symlink_to(APP / "aegis-idea3-core-recovery.dropin.example")
    elif case == "wrong-mode":
        (dropin_dir / "20-f1-alert.conf").chmod(0o600)
    with __import__("pytest").raises(verifier.DropInContractError):
        verifier.validate_dropins(ROOT, "3e26a61e32cc1073265f68659c6bbd5805d5401b", root, paths, owner_uid=__import__("os").geteuid(), owner_gid=__import__("os").getegid())


def test_ctu_dropin_contract_binds_expected_bytes_to_exact_main_git_object(tmp_path: Path) -> None:
    verifier = _load_dropin_verifier()
    root, dropin_dir, paths = _dropin_fixture(tmp_path)
    (dropin_dir / "10-recovery.conf").write_bytes(b"mutable working tree authority\n")
    with __import__("pytest").raises(verifier.DropInContractError, match="DIGEST_MISMATCH"):
        verifier.validate_dropins(ROOT, "3e26a61e32cc1073265f68659c6bbd5805d5401b", root, paths, owner_uid=__import__("os").geteuid(), owner_gid=__import__("os").getegid())


def test_core_unit_allows_only_the_read_only_trusted_clock_probe() -> None:
    text = UNIT.read_text()
    assert "ProtectClock=false" in text
    assert "ProtectClock=true" not in text
    assert "SystemCallFilter=~@clock" not in text
    assert "adjtimex" not in text.lower() or "read-only" in text.lower()


def test_core_unit_retains_no_clock_mutation_authority() -> None:
    lines = {line.split("=", 1)[0]: line.split("=", 1)[1] for line in UNIT.read_text().splitlines() if "=" in line}
    assert lines["User"] == "aegis-idea3"
    assert lines["NoNewPrivileges"] == "true"
    assert lines["CapabilityBoundingSet"] == ""
    assert lines["AmbientCapabilities"] == ""
    assert "CAP_SYS_TIME" not in UNIT.read_text()


def test_core_unit_preserves_existing_hardening() -> None:
    text = UNIT.read_text()
    for setting in (
        "PrivateTmp=true", "PrivateDevices=true", "ProtectSystem=strict", "ProtectHome=true",
        "ProtectKernelTunables=true", "ProtectKernelModules=true", "ProtectKernelLogs=true",
        "ProtectControlGroups=true", "ProtectHostname=true", "ProtectProc=invisible",
        "ProcSubset=pid", "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6",
        "RestrictNamespaces=true", "RestrictRealtime=true", "RestrictSUIDSGID=true",
        "LockPersonality=true", "SystemCallArchitectures=native",
    ):
        assert setting in text


def test_ctu_dropin_contract_accepts_valid_effective_unit_properties() -> None:
    verifier = _load_dropin_verifier()
    verifier.validate_effective_unit(
        supplementary_groups="aegis-idea3-recovery aegis-idea3-alert",
        read_write_paths="/var/lib/aegis-idea3 /run/aegis-idea3 /var/log/aegis-idea3 /run/aegis-idea3-recovery /run/aegis-idea3-alert",
        protect_clock="false",
        user="aegis-idea3",
        no_new_privileges="yes",
        capability_bounding_set="",
        ambient_capabilities="",
    )


def test_ctu_dropin_contract_accepts_reordered_effective_unit_properties() -> None:
    verifier = _load_dropin_verifier()
    verifier.validate_effective_unit(
        supplementary_groups="aegis-idea3-alert aegis-idea3-recovery extra-group",
        read_write_paths="/run/aegis-idea3-alert /run/aegis-idea3-recovery /var/log/aegis-idea3 /var/lib/aegis-idea3 /run/aegis-idea3",
        protect_clock="no",
        user="aegis-idea3",
        no_new_privileges="true",
        capability_bounding_set="",
        ambient_capabilities="",
    )


@__import__("pytest").mark.parametrize(
    "prop_kwargs,err_match",
    (
        ({"supplementary_groups": "aegis-idea3-recovery"}, "SUPPLEMENTARY_GROUPS_MISSING"),
        ({"supplementary_groups": "aegis-idea3-alert"}, "SUPPLEMENTARY_GROUPS_MISSING"),
        ({"read_write_paths": "/var/lib/aegis-idea3 /run/aegis-idea3"}, "READWRITEPATHS_MISSING"),
        ({"read_write_paths": "/var/lib/aegis-idea3 /run/aegis-idea3 /var/log/aegis-idea3 /run/aegis-idea3-recovery"}, "READWRITEPATHS_MISSING"),
        ({"protect_clock": "true"}, "PROTECTCLOCK_INVALID"),
        ({"protect_clock": "yes"}, "PROTECTCLOCK_INVALID"),
        ({"user": "root"}, "USER_INVALID"),
        ({"no_new_privileges": "no"}, "NNP_INVALID"),
        ({"capability_bounding_set": "CAP_SYS_TIME"}, "CAPABILITY_BOUND_INVALID"),
        ({"ambient_capabilities": "CAP_SYS_ADMIN"}, "AMBIENT_CAPABILITY_INVALID"),
    ),
)
def test_ctu_dropin_contract_refuses_invalid_effective_unit_properties(prop_kwargs: dict, err_match: str) -> None:
    verifier = _load_dropin_verifier()
    valid = {
        "supplementary_groups": "aegis-idea3-recovery aegis-idea3-alert",
        "read_write_paths": "/var/lib/aegis-idea3 /run/aegis-idea3 /var/log/aegis-idea3 /run/aegis-idea3-recovery /run/aegis-idea3-alert",
        "protect_clock": "false",
        "user": "aegis-idea3",
        "no_new_privileges": "yes",
        "capability_bounding_set": "",
        "ambient_capabilities": "",
    }
    valid.update(prop_kwargs)
    with __import__("pytest").raises(verifier.DropInContractError, match=err_match):
        verifier.validate_effective_unit(**valid)


def test_ctu_dropin_preservation_across_install_reload_restart() -> None:
    runner = RUNNER.read_text()
    pos_install = runner.index("phase=unit-installed")
    pos_validate_install = runner.index("CORE_DROPIN_CONTRACT_INVALID_AFTER_INSTALL")
    pos_reload = runner.index("systemctl daemon-reload")
    pos_validate_reload = runner.index("CORE_DROPIN_CONTRACT_INVALID_AFTER_RELOAD")
    pos_restart = runner.index("systemctl restart aegis-idea3-core.service")
    pos_validate_restart = runner.index("CORE_DROPIN_CONTRACT_INVALID_AFTER_RESTART")
    assert pos_install < pos_validate_install < pos_reload < pos_validate_reload < pos_restart < pos_validate_restart


def test_ctu_pre_refusal_leaves_global_marker_absent() -> None:
    runner = RUNNER.read_text()
    pos_dropin_pre = runner.index("PRE_DROPIN_CONTRACT")
    pos_consume = runner.index("ctu_consume_attempt")
    assert pos_dropin_pre < pos_consume
    post_fail_block = runner[runner.index("post_fail() {"):runner.index("IN_POST_FAIL=1") + 300]
    assert "local consumed=NO" in post_fail_block
    assert "ctu_marker_path" in post_fail_block
    assert 'rollback_flow "$reason"' in post_fail_block


def test_ctu_dropin_gate_is_exact_main_bound_and_preconsume() -> None:
    runner = RUNNER.read_text()
    verify = VERIFY.read_text()
    assert "ctu_dropin_contract.py" in runner
    assert "ctu_dropin_contract.py" in verify
    assert "CORE_DROPIN_PRESENT" not in runner
    assert runner.index("PRE_DROPIN_CONTRACT") < runner.index("ctu_consume_attempt")
    assert "AEGIS_CTU_EXPECTED_MAIN" in verify
    assert "DropInPaths" in verify
    assert "ctu_validate_dropins_root" in runner
    assert "SupplementaryGroups" in verify
    assert "ReadWritePaths" in verify
    assert "--verify-effective" in verify


def test_ctu_rollback_never_targets_predecessor_dropin_directory() -> None:
    runner = RUNNER.read_text()
    rollback = runner[runner.index("ctu_rollback_governed()"):runner.index("IN_POST_FAIL=0")]
    assert "aegis-idea3-core.service.d" not in rollback
    assert "10-recovery.conf" not in rollback
    assert "20-f1-alert.conf" not in rollback


def test_ctu_is_registered_and_has_all_handlers() -> None:
    lib = (P4 / "p4-lib.sh").read_text()
    assert " RRu CTu Recovery " in lib
    assert "    CTu) echo none ;;" in lib
    for name in ("apply.sh", "verify.sh", "rollback.sh", "allow-keys.txt", "allow-listeners.txt"):
        assert (CTU / name).is_file(), name


def test_ctu_handlers_are_shell_valid_and_scope_limited() -> None:
    for name in ("apply.sh", "verify.sh", "rollback.sh"):
        assert subprocess.run(["bash", "-n", str(CTU / name)], capture_output=True).returncode == 0
    apply = (CTU / "apply.sh").read_text()
    rollback = (CTU / "rollback.sh").read_text()
    for text in (apply, rollback):
        assert "mosquitto" not in text
        assert "esp32" not in text.lower()
        assert "CUT" not in text and "RESTORE" not in text
        assert not re.search(r"systemctl +(restart|start|stop|reload).*detector", text)
    runner = RUNNER.read_text()
    assert "DIRECT_HANDLER_INVOCATION_REFUSED" in apply
    assert "DIRECT_HANDLER_INVOCATION_REFUSED" in rollback
    assert runner.count("systemctl restart aegis-idea3-core.service") == 2
    assert "systemctl daemon-reload" in runner


def test_ctu_allow_catalog_is_narrow_and_detector_transition_is_dependency_only() -> None:
    keys = {line.strip() for line in (CTU / "allow-keys.txt").read_text().splitlines() if line.strip() and not line.startswith("#")}
    assert keys == {
        "svc.aegis-idea3-core.service.MainPID",
        "svc.aegis-idea3-core.service.ExecMainStartTimestamp",
        "svc.aegis-idea3-detector.service.MainPID",
        "svc.aegis-idea3-detector.service.ExecMainStartTimestamp",
        "host.unit_file./etc/systemd/system/aegis-idea3-core.service.class",
        "host.unit_file./etc/systemd/system/aegis-idea3-core.service.meta",
        "host.unit_file./etc/systemd/system/aegis-idea3-core.service.sha256",
    }
    text = (CTU / "apply.sh").read_text()
    assert "systemctl restart aegis-idea3-detector.service" not in text
    assert "Requires=" in (APP / "aegis-idea3-detector.service.example").read_text()


def test_ctu_runner_is_unpinned_and_consumes_its_own_marker_before_apply() -> None:
    text = RUNNER.read_text()
    lib = (P4 / "p4-ctu-run-lib.sh").read_text()
    assert "EXPECTED_MAIN=PIN_MAIN_SHA" in text
    assert "CTU-GLOBAL-ATTEMPT-CONSUMED" in lib
    assert "apply.sh" in text
    assert "ATTEMPT_MARKER=\"$AUTH_DIR/CTU-GLOBAL-ATTEMPT-CONSUMED\"" not in text
    assert "CTU_CANONICAL_DIR=/var/lib/aegis-idea3-governance" in lib
    assert "ctu_consume_attempt" in text
    assert text.index("ctu_consume_attempt") < text.index("declare -f ctu_validate_dropins_root ctu_apply_fail")
    assert "--stage RRu" not in text and "--stage Recovery" not in text
    assert not re.search(r"systemctl +(restart|start|stop|reload).*detector", text)
    assert "SUDO" in text and "SUDO" in lib
    assert "PIN_MERGED_MAIN_WORKTREE" in text
    assert "PIN_EVIDENCE_ROOT" in text
    assert "ctu_prepare_bundle" in text and "CTU-BUNDLE-SHA256SUMS" in lib
    assert "trap 'exit_handler' EXIT" in text
    assert "GIT_" in text and "environment override SUDO" in text


def test_ctu_verify_uses_real_runtime_and_has_no_caller_success_pins() -> None:
    runner = RUNNER.read_text()
    verify = VERIFY.read_text()
    for forbidden in (
        "PIN_AUTHENTICATED_STATUS", "PIN_TRUSTED_CLOCK", "PIN_TIME_TRUST",
        "PIN_DEVICE=", "PIN_UPLINK", "PIN_BROKER", "AEGIS_CTU_AUTHENTICATED_STATUS",
        "AEGIS_CTU_TRUSTED_CLOCK", "AEGIS_CTU_TIME_TRUST", "AEGIS_CTU_DEVICE=",
        "AEGIS_CTU_UPLINK=", "AEGIS_CTU_BROKER=",
    ):
        assert forbidden not in runner
        assert forbidden not in verify
    assert "AEGIS_CTU_RUNTIME_VERIFY" in verify
    assert "status.json" in RUNTIME_VERIFY.read_text()
    assert "lockdown_episodes" in RUNTIME_VERIFY.read_text()
    assert "protocol_seen_d2c" in RUNTIME_VERIFY.read_text()
    assert "audit_logs" in RUNTIME_VERIFY.read_text()
    assert "open_msg_id" in RUNTIME_VERIFY.read_text()
    assert "pre_episode_id" in RUNTIME_VERIFY.read_text()
    assert "protocol_msg_id" in RUNTIME_VERIFY.read_text()


def test_ctu_operator_identity_and_fixed_marker_contract_is_fail_closed() -> None:
    text = RUNNER.read_text()
    lib = (P4 / "p4-ctu-run-lib.sh").read_text()
    assert 'id -un' in lib
    assert 'id -u' in lib
    assert 'actual_uid" != 0' in lib
    assert 'OPERATOR_USER' in text
    assert 'CTU_CANONICAL_DIR=/var/lib/aegis-idea3-governance' in lib
    assert 'CTU-GLOBAL-ATTEMPT-CONSUMED' in lib
    assert 'noclobber' in lib
    assert 'chattr +i' in lib
    assert 'rm -' not in lib
    assert 'AUTH_DIR/CTU' not in text
    assert "AEGIS_CTU_TEST_ONLY_CANONICAL_DIR_ENABLED" in text


def test_ctu_operator_identity_rejects_wrong_uid_and_username() -> None:
    lib = P4 / "p4-ctu-run-lib.sh"
    command = f'. "{lib}"; ctu_operator_identity_gate "$1" "$2"'
    good = subprocess.run(["bash", "-c", command, "gate", "kittipat", "1000"], capture_output=True)
    wrong_user = subprocess.run(["bash", "-c", command, "gate", "nobody", "1000"], capture_output=True)
    wrong_uid = subprocess.run(["bash", "-c", command, "gate", "kittipat", "1001"], capture_output=True)
    assert good.returncode == 0
    assert wrong_user.returncode != 0
    assert wrong_uid.returncode != 0


def test_ctu_marker_creation_is_exclusive_and_never_recreated() -> None:
    with tempfile.TemporaryDirectory() as raw:
        root = Path(raw)
        canonical = root / "governance"
        script = P4 / "p4-ctu-run-lib.sh"
        env = {
            **__import__("os").environ,
            "SUDO": "",
            "AEGIS_CTU_TEST_ONLY_CANONICAL_DIR_ENABLED": "YES",
            "AEGIS_CTU_TEST_ONLY_CANONICAL_DIR": str(canonical),
            "AEGIS_CTU_TEST_ONLY_TRUST_ROOT": str(root),
            "AEGIS_CTU_TEST_ONLY_BOUNDARY": "CTU_PRE_PROTOCOL_SEEN_ID=0\nCTU_PRE_AUDIT_ID=0\nCTU_PRE_EPISODE_ID=0\nCTU_PRE_OPEN_EPISODE_COUNT=0\nCTU_PRE_OPEN_EPISODE_ID=0",
        }
        command = f'. "{script}"; ctu_consume_attempt "$1" esp32-01 /tmp/ctu-runtime-verify.py'
        first = subprocess.Popen(["bash", "-c", command, "consume", str(root / "work-1")], env=env)
        second = subprocess.Popen(["bash", "-c", command, "consume", str(root / "work-2")], env=env)
        results = [first.wait(), second.wait()]
        assert sorted(results) == [0, 1]
        marker = canonical / "CTU-GLOBAL-ATTEMPT-CONSUMED"
        assert marker.is_file()
        assert "CTU_RERUN_ALLOWED=NO" in marker.read_text()


def test_ctu_post_consumption_failures_have_terminal_rollback_paths() -> None:
    text = RUNNER.read_text()
    assert "post_fail()" in text
    assert "rollback.sh" in text
    for marker in ("APPLY", "VERIFY", "POST_CAPTURE", "COMPARE", "S10", "SECRET_SCAN"):
        assert marker in text
    assert "CTU_RESULT=FAIL_IMMUTABLE" in text
    assert "CTU_RERUN_ALLOWED=NO" in text
    assert "CTU_PRE_RB_COMPARE=PASS" in text
    assert "ctu_consume_attempt" in text
    assert "rm -f \"$ATTEMPT_MARKER\"" not in text
    assert "then post_fail APPLY" in text
    assert "then post_fail POST_CAPTURE" in text
    assert "then post_fail COMPARE_S10" in text
    assert "then post_fail SECRET_SCAN" in text
    assert "then post_fail VERIFY" in text
    assert "trap" in text and "INT" in text and "TERM" in text and "HUP" in text
    assert 'source "$BUNDLE/p4-l7u-run-lib.sh"' in text
    assert text.index('source "$BUNDLE/p4-l7u-run-lib.sh"') < text.index("ctu_consume_attempt")
    assert "SECRET_SCAN" in text[text.index("rollback_flow"):text.index("post_fail()")]


def test_ctu_proves_the_expected_implicit_detector_lifecycle() -> None:
    runner = RUNNER.read_text()
    verify = VERIFY.read_text()
    for field in ("InvocationID", "NRestarts", "ActiveState", "SubState", "ExecMainStartTimestampMonotonic"):
        assert field in runner or field in verify
    assert "AEGIS_CTU_PRE_DETECTOR_INVOCATION" in verify
    assert "AEGIS_CTU_PRE_DETECTOR_NRESTARTS" in verify
    assert "AEGIS_CTU_PRE_DETECTOR_PID" in verify
    assert "DETECTOR_START_AFTER_CORE" in RUNTIME_VERIFY.read_text()
    assert "systemctl restart aegis-idea3-detector.service" not in runner
    assert "systemctl restart aegis-idea3-detector.service" not in (CTU / "apply.sh").read_text()
    assert "systemctl restart aegis-idea3-detector.service" not in (CTU / "rollback.sh").read_text()


def test_ctu_runner_verify_invocation_nounset_semantics(tmp_path: Path) -> None:
    """Exercising verify-environment construction under Bash nounset (-u) semantics.

    Proves that all variables passed to stages/CTu/verify.sh in run-ctu-owner.sh
    are bound before execution in the runner's pre-capture state, and that
    Bash nounset aborts if any expansion is unbound (such as PRE_DETECTOR_PID).
    """
    runner_text = RUNNER.read_text()
    verify_lines = [line.strip() for line in runner_text.splitlines() if "stages/CTu/verify.sh" in line]
    assert len(verify_lines) == 1, f"expected exactly 1 verify invocation line, found {len(verify_lines)}"
    verify_cmd = verify_lines[0]

    out_file = tmp_path / "env_args.txt"

    def run_harness(var_assignments: dict[str, str]) -> subprocess.CompletedProcess[str]:
        vars_bash = "\n".join(f'{k}="{v}"' for k, v in var_assignments.items())
        script = f"""set -Eeuo pipefail
{vars_bash}

sudo() {{
    shift 2  # consume -n env
    printf '%s\\n' "$@" > "{out_file}"
}}

post_fail() {{
    printf "post_fail called: %s\\n" "$1" >&2
    exit 1
}}

{verify_cmd}
"""
        return subprocess.run(["bash", "-c", script], capture_output=True, text=True)

    base_vars = {
        "REPO": "/mock/repo",
        "EXPECTED_MAIN": "3e26a61e32cc1073265f68659c6bbd5805d5401b",
        "BUNDLE": "/mock/bundle",
        "UNIT_SNAPSHOT": "/mock/snapshot",
        "UNIT_SHA256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        "WORK": "/mock/work",
        "CORE_PRE_PID": "1001",
        "CORE_PRE_START": "2026-10-07 10:00:00 UTC",
        "CORE_PRE_NRESTARTS": "0",
        "STATUS_PRE_UPDATED_AT": "1728300000.0",
        "CORE_ENV_PRE_SHA": "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
        "DEVICE_ID": "aegis-relay-01",
        "DETECTOR_PRE_MODE": "ACTIVE",
        "DETECTOR_PRE_PID": "2002",
        "DETECTOR_PRE_START": "2026-10-07 10:00:01 UTC",
        "DETECTOR_PRE_INVOCATION": "0123456789abcdef0123456789abcdef",
        "DETECTOR_PRE_NRESTARTS": "0",
        "DETECTOR_PRE_MONOTONIC": "50000",
    }

    # 1. Successful execution with all runner-provided pre-capture variables bound
    res = run_harness(base_vars)
    assert res.returncode == 0, f"Runner verify invocation failed under nounset: {res.stderr}"
    assert "unbound variable" not in res.stderr

    recorded_args = dict(
        line.split("=", 1)
        for line in out_file.read_text().splitlines()
        if "=" in line
    )
    assert recorded_args["AEGIS_CTU_PRE_DETECTOR_PID"] == "2002"
    assert recorded_args["AEGIS_CTU_PRE_DETECTOR_START"] == "2026-10-07 10:00:01 UTC"
    assert recorded_args["AEGIS_CTU_PRE_DETECTOR_INVOCATION"] == "0123456789abcdef0123456789abcdef"
    assert recorded_args["AEGIS_CTU_PRE_DETECTOR_NRESTARTS"] == "0"
    assert recorded_args["AEGIS_CTU_PRE_DETECTOR_MONOTONIC"] == "50000"
    assert recorded_args["AEGIS_CTU_PRE_CORE_PID"] == "1001"
    assert recorded_args["AEGIS_CTU_DEVICE_ID"] == "aegis-relay-01"
    assert recorded_args["AEGIS_CTU_DETECTOR_PRE_MODE"] == "ACTIVE"

    # 2. Negative behavioral proof: prove that nounset semantics genuinely abort
    # if DETECTOR_PRE_PID (or any other required expansion) is omitted.
    missing_detector = dict(base_vars)
    del missing_detector["DETECTOR_PRE_PID"]
    res_neg = run_harness(missing_detector)
    assert res_neg.returncode != 0
    assert "DETECTOR_PRE_PID: unbound variable" in res_neg.stderr


def test_detector_lifecycle_proof_rejects_unchanged_multiple_failed_and_unrelated_states() -> None:
    verifier = _load_runtime_verifier()
    pre = {"pid": "10", "start": "old", "invocation": "a" * 32, "nrestarts": "0", "monotonic": "100"}
    post = {"pid": "20", "start": "new", "invocation": "b" * 32, "nrestarts": "0", "monotonic": "101", "load": "loaded", "active": "active", "sub": "running", "unit_file": "disabled", "restart": "no"}
    verifier.verify_detector(pre, post, 90)
    cases = (
        {**post, "pid": "10"},
        {**post, "nrestarts": "1"},
        {**post, "active": "failed"},
        {**post, "monotonic": "200000100"},
    )
    for bad in cases:
        try:
            verifier.verify_detector(pre, bad, 90)
        except verifier.RuntimeProofError:
            pass
        else:
            raise AssertionError("invalid detector lifecycle must fail closed")


def _load_runtime_verifier():
    spec = importlib.util.spec_from_file_location("ctu_runtime_verify", RUNTIME_VERIFY)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def _runtime_fixture(tmp: Path, *, status: dict, episode: bool = True, episode_msg_id="msg-123", episode_id=None, protocol_rows=(), audit_rows=(), boundary=(0, 0), open_boundary=(0, 0)):
    status_path = tmp / "status.json"
    status_path.write_text(json.dumps(status))
    db_path = tmp / "audit.sqlite3"
    con = sqlite3.connect(db_path)
    con.executescript("""
        CREATE TABLE lockdown_episodes (
            id INTEGER PRIMARY KEY, device_id TEXT, opened_at TEXT, open_msg_id TEXT,
            closed_at TEXT
        );
        CREATE TABLE audit_logs (
            id INTEGER PRIMARY KEY, timestamp TEXT, event_type TEXT, details TEXT
        );
    """)
    if episode:
        if episode_id is None:
            con.execute(
                "INSERT INTO lockdown_episodes(device_id, opened_at, open_msg_id, closed_at) VALUES (?, ?, ?, NULL)",
                ("esp32-01", "2026-10-07 00:00:00", episode_msg_id),
            )
        else:
            con.execute(
                "INSERT INTO lockdown_episodes(id, device_id, opened_at, open_msg_id, closed_at) VALUES (?, ?, ?, ?, NULL)",
                (episode_id, "esp32-01", "2026-10-07 00:00:00", episode_msg_id),
            )
    con.executemany("INSERT INTO audit_logs(id, timestamp, event_type, details) VALUES (?, ?, ?, ?)", audit_rows)
    con.commit()
    con.close()
    protocol_path = tmp / "protocol.sqlite3"
    con = sqlite3.connect(protocol_path)
    con.execute("CREATE TABLE protocol_seen_d2c (device_id TEXT, msg_id TEXT, kind TEXT, received_at REAL)")
    con.executemany("INSERT INTO protocol_seen_d2c(rowid, device_id, msg_id, kind, received_at) VALUES (?, ?, ?, ?, ?)", protocol_rows)
    con.commit()
    con.close()
    marker_path = tmp / "marker"
    marker_path.write_text(
        "CTU_ATTEMPT_CONSUMED=YES\nCTU_RERUN_ALLOWED=NO\nCTU_DEVICE_ID=esp32-01\n"
        "CTU_CONSUMED_AT_EPOCH=10.0\n"
        f"CTU_PRE_PROTOCOL_SEEN_ID={boundary[0]}\nCTU_PRE_AUDIT_ID={boundary[1]}\nCTU_PRE_EPISODE_ID={boundary[1]}\n"
        f"CTU_PRE_OPEN_EPISODE_COUNT={open_boundary[0]}\nCTU_PRE_OPEN_EPISODE_ID={open_boundary[1]}\n"
    )
    return status_path, db_path, protocol_path, marker_path


def test_runtime_verifier_requires_fresh_core_status_and_authenticated_episode() -> None:
    verifier = _load_runtime_verifier()
    with tempfile.TemporaryDirectory() as raw:
        tmp = Path(raw)
        status = {
            "pid": 2743, "updated_at": 20.0, "state": "LOCKDOWN",
            "time_trust": "SYNCED", "broker": "CONNECTED",
            "device": "ONLINE", "uplink": "LOCKDOWN",
        }
        status_path, db_path, protocol_path, marker_path = _runtime_fixture(
            tmp, status=status, protocol_rows=[(1, "esp32-01", "old", "STATUS", 1.0)],
            audit_rows=[(1, "2026-10-07 00:00:01", "DEVICE_STATUS", "LOCKDOWN (old)")],
            boundary=(1, 1),
        )
        try:
            verifier.verify_files(status_path, db_path, protocol_path, marker_path, 2743, 10.0, "esp32-01", 10.0)
        except verifier.RuntimeProofError:
            pass
        else:
            raise AssertionError("historical open episode must not satisfy CTu")


def test_runtime_verifier_accepts_only_post_restart_fresh_lockdown_evidence() -> None:
    verifier = _load_runtime_verifier()
    with tempfile.TemporaryDirectory() as raw:
        tmp = Path(raw)
        status = {"pid": 2743, "updated_at": 20.0, "state": "LOCKDOWN", "time_trust": "SYNCED", "broker": "CONNECTED", "device": "ONLINE", "uplink": "LOCKDOWN"}
        status_path, db_path, protocol_path, marker_path = _runtime_fixture(
            tmp, status=status, protocol_rows=[(1, "esp32-01", "old", "STATUS", 1.0), (2, "esp32-01", "new", "STATUS", 20.0)],
            audit_rows=[(1, "2026-10-07 00:00:01", "DEVICE_STATUS", "LOCKDOWN (old)"), (2, "2026-10-07 00:00:20", "DEVICE_STATUS", "LOCKDOWN (new)")],
            boundary=(1, 1), episode_msg_id="new", episode_id=2,
        )
        assert verifier.verify_files(status_path, db_path, protocol_path, marker_path, 2743, 10.0, "esp32-01", 10.0) is None


def test_runtime_verifier_rejects_fresh_status_with_historical_episode_or_unrelated_audit() -> None:
    verifier = _load_runtime_verifier()
    with tempfile.TemporaryDirectory() as raw:
        tmp = Path(raw)
        status = {"pid": 2743, "updated_at": 20.0, "state": "LOCKDOWN", "time_trust": "SYNCED", "broker": "CONNECTED", "device": "ONLINE", "uplink": "LOCKDOWN"}
        status_path, db_path, protocol_path, marker_path = _runtime_fixture(
            tmp, status=status, protocol_rows=[(2, "esp32-01", "new", "STATUS", 20.0)],
            audit_rows=[(2, "2026-10-07 00:00:20", "DEVICE_STATUS", "LOCKDOWN (unrelated)")], boundary=(1, 1), episode_msg_id="old",
        )
        for process_start in (10.0, 19.0):
            try:
                verifier.verify_files(status_path, db_path, protocol_path, marker_path, 2743, 10.0, "esp32-01", process_start)
            except verifier.RuntimeProofError:
                continue
            raise AssertionError("unrelated or historical lockdown evidence must fail")


def test_runtime_verifier_rejects_pre_restart_timing_sliver_and_accepts_correlated_event() -> None:
    verifier = _load_runtime_verifier()
    with tempfile.TemporaryDirectory() as raw:
        tmp = Path(raw)
        status = {"pid": 2743, "updated_at": 20.0, "state": "LOCKDOWN", "time_trust": "SYNCED", "broker": "CONNECTED", "device": "ONLINE", "uplink": "LOCKDOWN"}
        status_path, db_path, protocol_path, marker_path = _runtime_fixture(
            tmp, status=status, protocol_rows=[(2, "esp32-01", "new", "STATUS", 14.0)],
            audit_rows=[(2, "2026-10-07 00:00:14", "DEVICE_STATUS", "LOCKDOWN (new)")], boundary=(1, 1), episode_msg_id="new",
        )
        try:
            verifier.verify_files(status_path, db_path, protocol_path, marker_path, 2743, 10.0, "esp32-01", 15.0)
        except verifier.RuntimeProofError:
            pass
        else:
            raise AssertionError("pre-restart timing sliver must fail")


def test_ctu_uses_root_snapshot_and_recovery_requires_ctu_pass() -> None:
    runner = RUNNER.read_text()
    apply = (CTU / "apply.sh").read_text()
    recovery = (P4 / "owner-run" / "run-recovery-owner.sh").read_text()
    recovery_lib = (P4 / "p4-recovery-run-lib.sh").read_text()
    assert "AEGIS_CTU_UNIT_SNAPSHOT" in runner and "sha256sum" in runner
    assert "AEGIS_CTU_UNIT_SNAPSHOT" in runner and "AEGIS_CTU_UNIT_SHA256" in runner
    assert "CTU-GLOBAL-CLOSEOUT-PASS" in recovery_lib
    assert "recovery_ctu_successor_gate" in recovery


def test_recovery_gate_refuses_without_ctu_closeout_and_accepts_exact_bound(tmp_path: Path) -> None:
    canonical = tmp_path / "governance"
    canonical.mkdir()
    lib = P4 / "p4-recovery-run-lib.sh"
    command = f'. "{lib}"; recovery_ctu_successor_gate "$1"'
    env = {
        **__import__("os").environ,
        "SUDO": "",
        "RECOVERY_TEST_ONLY_CANONICAL_DIR_ENABLED": "YES",
        "RECOVERY_TEST_ONLY_CANONICAL_DIR": str(canonical),
        "RECOVERY_TEST_ONLY_TRUST_ROOT": str(tmp_path),
    }
    missing = subprocess.run(["bash", "-c", command, "gate", "a" * 40], env=env, capture_output=True)
    assert missing.returncode != 0
    closeout = canonical / "CTU-GLOBAL-CLOSEOUT-PASS"
    closeout.write_text(
        "CTU_LIVE=CLOSED_PASS\nCTU_LIVE_EXECUTED=YES\nCTU_RESULT=PASS\nCTU_ATTEMPT_CONSUMED=YES\nCTU_RERUN_ALLOWED=NO\n"
        f"CTU_EXPECTED_MAIN={'a' * 40}\nCTU_EXECUTION_MAIN={'a' * 40}\nCTU_RUNNER_SHA256={'c' * 64}\nCTU_STAGE=CTu\nCTU_RUNTIME_PROOF=PASS\nCTU_AUTHENTICATED_STATUS_PROOF=PASS\n"
        "CTU_DETECTOR_LIFECYCLE_PROOF=PASS\nCTU_DETECTOR_BASELINE_MODE=ACTIVE\nCTU_DEVICE_ID=aegis-relay-01\nCTU_EVIDENCE_MANIFEST_SHA256=" + "d" * 64 + "\n"
        "CTU_PRE_POST_PRESERVATION=PASS\nRECOVERY_LIVE_EXECUTED=NO\nRECOVERY_ATTEMPT_CONSUMED=NO\n"
        "CTU_FAILURE_RESULT=NONE\nCTU_UNIT_SHA256=" + "b" * 64 + "\nCTU_EVIDENCE_ROOT=/tmp/evidence\n"
    )
    host_sha = hashlib.sha256(closeout.read_bytes()).hexdigest()
    sidecar = canonical / "CTU-GLOBAL-CLOSEOUT-PASS.sha256"
    sidecar.write_text(f"{host_sha}  CTU-GLOBAL-CLOSEOUT-PASS\n")
    sidecar.chmod(0o600)
    receipt = tmp_path / "ctu-live-receipt.md"
    receipt.write_text(f"CTU_LIVE=CLOSED_PASS\nCTU_LIVE_EXECUTED=YES\nCTU_RESULT=PASS\nCTU_ATTEMPT_CONSUMED=YES\nCTU_EXPECTED_MAIN={'a' * 40}\nCTU_EXECUTION_MAIN={'a' * 40}\nCTU_RUNNER_SHA256={'c' * 64}\nCTU_UNIT_SHA256={'b' * 64}\nCTU_DEVICE_ID=aegis-relay-01\nCTU_DETECTOR_BASELINE_MODE=ACTIVE\nCTU_EVIDENCE_MANIFEST_SHA256={'d' * 64}\nCTU_HOST_CLOSEOUT_SHA256={host_sha}\nRECOVERY_LIVE_EXECUTED=NO\nRECOVERY_ATTEMPT_CONSUMED=NO\n")
    env["RECOVERY_TEST_ONLY_CTU_LIVE_RECEIPT"] = str(receipt)
    accepted = subprocess.run(["bash", "-c", command, "gate", "a" * 40], env=env, capture_output=True)
    assert accepted.returncode == 0, accepted.stderr.decode()
    (canonical / "CTU-GLOBAL-CLOSEOUT-FAIL").write_text("CTU_RESULT=FAIL_IMMUTABLE\n")
    duplicate = subprocess.run(["bash", "-c", command, "gate", "a" * 40], env=env, capture_output=True)
    assert duplicate.returncode != 0
    (canonical / "CTU-GLOBAL-CLOSEOUT-FAIL").unlink()
    stale = subprocess.run(["bash", "-c", command, "gate", "b" * 40], env=env, capture_output=True)
    assert stale.returncode != 0


def test_ctu_live_environment_rejects_sudo_override_and_snapshot_symlinks() -> None:
    runner = RUNNER.read_text()
    apply = (CTU / "apply.sh").read_text()
    assert "SUDO" in runner and "environment override SUDO" in runner
    assert "-L" in runner
    assert "mv -f" in runner


def test_moc_current_sequence_places_ctu_before_recovery_and_history_is_explicit() -> None:
    moc = (ROOT.parent / "Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-moc.md").read_text()
    assert "CTu" in moc and "CTu PASS" in moc
    assert moc.index("CTu") < moc.index("Recovery LIVE")
    assert "blocked until R1Bv passed" in moc


def test_runtime_verifier_rejects_wrong_device_and_normal_post_restart_evidence() -> None:
    verifier = _load_runtime_verifier()
    with tempfile.TemporaryDirectory() as raw:
        tmp = Path(raw)
        status = {"pid": 2743, "updated_at": 20.0, "state": "LOCKDOWN", "time_trust": "SYNCED", "broker": "CONNECTED", "device": "ONLINE", "uplink": "LOCKDOWN"}
        for index, (device, detail) in enumerate((("other-device", "LOCKDOWN (new)"), ("esp32-01", "NORMAL (new)"))):
            case = tmp / f"case-{index}"
            case.mkdir()
            status_path, db_path, protocol_path, marker_path = _runtime_fixture(
                case, status=status, protocol_rows=[(2, device, "new", "STATUS", 20.0)],
                audit_rows=[(2, "2026-10-07 00:00:20", "DEVICE_STATUS", detail)], boundary=(1, 1),
            )
            try:
                verifier.verify_files(status_path, db_path, protocol_path, marker_path, 2743, 10.0, "esp32-01", 10.0)
            except verifier.RuntimeProofError:
                pass
            else:
                raise AssertionError("wrong-device or NORMAL evidence must fail")


def test_runtime_verifier_rejects_forged_success_values_and_stale_status() -> None:
    verifier = _load_runtime_verifier()
    with tempfile.TemporaryDirectory() as raw:
        tmp = Path(raw)
        status = {
            "pid": 2743, "updated_at": 9.0, "state": "LOCKDOWN",
            "time_trust": "SYNCED", "broker": "CONNECTED",
            "device": "ONLINE", "uplink": "LOCKDOWN",
        }
        status_path, db_path, protocol_path, marker_path = _runtime_fixture(tmp, status=status)
        for pid, pre_time in ((9999, 1.0), (2743, 9.0)):
            try:
                verifier.verify_files(status_path, db_path, protocol_path, marker_path, pid, pre_time, "esp32-01", 10.0)
            except verifier.RuntimeProofError:
                continue
            raise AssertionError("forged or stale runtime success must fail")
