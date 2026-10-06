"""Regression contract for the Core TrustedClock sandbox repair (CTu).

These tests are repository-only.  They inspect the reviewed unit and governed
successor package; they never invoke systemctl, Production, Recovery, or an
ESP32.
"""

from pathlib import Path
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
        assert "aegis-idea3-detector.service" not in text
        assert "mosquitto" not in text
        assert "esp32" not in text.lower()
        assert "CUT" not in text and "RESTORE" not in text
    assert apply.count("systemctl restart aegis-idea3-core.service") == 1
    assert rollback.count("systemctl restart aegis-idea3-core.service") == 1
    assert "systemctl daemon-reload" in apply


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
    assert text.index("ctu_consume_attempt") < text.index('bash \"$P4/stages/CTu/apply.sh\"')
    assert "--stage RRu" not in text and "--stage Recovery" not in text
    assert not re.search(r"systemctl +(restart|start|stop|reload).*detector", text)


def test_ctu_verify_uses_real_runtime_and_has_no_caller_success_pins() -> None:
    runner = RUNNER.read_text()
    verify = VERIFY.read_text()
    for forbidden in (
        "PIN_AUTHENTICATED_STATUS", "PIN_TRUSTED_CLOCK", "PIN_TIME_TRUST",
        "PIN_DEVICE", "PIN_UPLINK", "PIN_BROKER", "AEGIS_CTU_AUTHENTICATED_STATUS",
        "AEGIS_CTU_TRUSTED_CLOCK", "AEGIS_CTU_TIME_TRUST", "AEGIS_CTU_DEVICE=",
        "AEGIS_CTU_UPLINK=", "AEGIS_CTU_BROKER=",
    ):
        assert forbidden not in runner
        assert forbidden not in verify
    assert "p4-ctu-runtime-verify.py" in verify
    assert "status.json" in RUNTIME_VERIFY.read_text()
    assert "lockdown_episodes" in RUNTIME_VERIFY.read_text()


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
        }
        command = f'. "{script}"; ctu_consume_attempt "$1"'
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


def _load_runtime_verifier():
    spec = importlib.util.spec_from_file_location("ctu_runtime_verify", RUNTIME_VERIFY)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def _runtime_fixture(tmp: Path, *, status: dict, episode: bool = True):
    status_path = tmp / "status.json"
    status_path.write_text(json.dumps(status))
    db_path = tmp / "audit.sqlite3"
    con = sqlite3.connect(db_path)
    con.executescript("""
        CREATE TABLE lockdown_episodes (
            id INTEGER PRIMARY KEY, device_id TEXT, open_msg_id TEXT,
            closed_at TEXT
        );
    """)
    if episode:
        con.execute(
            "INSERT INTO lockdown_episodes(device_id, open_msg_id, closed_at) VALUES (?, ?, NULL)",
            ("esp32-01", "msg-123"),
        )
    con.commit()
    con.close()
    return status_path, db_path


def test_runtime_verifier_requires_fresh_core_status_and_authenticated_episode() -> None:
    verifier = _load_runtime_verifier()
    with tempfile.TemporaryDirectory() as raw:
        tmp = Path(raw)
        status = {
            "pid": 2743, "updated_at": 20.0, "state": "LOCKDOWN",
            "time_trust": "SYNCED", "broker": "CONNECTED",
            "device": "ONLINE", "uplink": "LOCKDOWN",
        }
        status_path, db_path = _runtime_fixture(tmp, status=status)
        assert verifier.verify_files(status_path, db_path, 2743, 10.0, "esp32-01") is None
        forged = dict(status, device="ONLINE", uplink="LOCKDOWN")
        status_path.write_text(json.dumps(forged))
        db_path.unlink()
        status_path, db_path = _runtime_fixture(tmp, status=forged, episode=False)
        try:
            verifier.verify_files(status_path, db_path, 2743, 10.0, "esp32-01")
        except verifier.RuntimeProofError:
            pass
        else:
            raise AssertionError("status values without authenticated episode must fail")


def test_runtime_verifier_rejects_forged_success_values_and_stale_status() -> None:
    verifier = _load_runtime_verifier()
    with tempfile.TemporaryDirectory() as raw:
        tmp = Path(raw)
        status = {
            "pid": 2743, "updated_at": 9.0, "state": "LOCKDOWN",
            "time_trust": "SYNCED", "broker": "CONNECTED",
            "device": "ONLINE", "uplink": "LOCKDOWN",
        }
        status_path, db_path = _runtime_fixture(tmp, status=status)
        for pid, pre_time in ((9999, 1.0), (2743, 9.0)):
            try:
                verifier.verify_files(status_path, db_path, pid, pre_time, "esp32-01")
            except verifier.RuntimeProofError:
                continue
            raise AssertionError("forged or stale runtime success must fail")
