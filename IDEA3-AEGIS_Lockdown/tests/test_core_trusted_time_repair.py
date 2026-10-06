"""Regression contract for the Core TrustedClock sandbox repair (CTu).

These tests are repository-only.  They inspect the reviewed unit and governed
successor package; they never invoke systemctl, Production, Recovery, or an
ESP32.
"""

from pathlib import Path
import re
import subprocess


ROOT = Path(__file__).parents[1]
APP = ROOT / "deploy"
UNIT = APP / "aegis-idea3-core.service.example"
P4 = APP / "pr11-phase4"
CTU = P4 / "stages" / "CTu"
RUNNER = P4 / "owner-run" / "run-ctu-owner.sh"


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
    assert "EXPECTED_MAIN=PIN_MAIN_SHA" in text
    assert "CTU-GLOBAL-ATTEMPT-CONSUMED" in text
    assert "apply.sh" in text
    assert text.index("mkdir \"$ATTEMPT_MARKER\"") < text.index('bash \"$P4/stages/CTu/apply.sh\"')
    assert "--stage RRu" not in text and "--stage Recovery" not in text
    assert not re.search(r"systemctl +(restart|start|stop|reload).*detector", text)
