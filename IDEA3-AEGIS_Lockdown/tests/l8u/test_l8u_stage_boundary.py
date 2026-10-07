"""L8u claim boundary: it is OBSERVATION ONLY. No L8p/provisioning/flash/reset/serial/MQTT-publish/NTP/service-control path exists in any L8u file, the handlers do nothing but observe, the runner's order is
gates -> PRE -> marker -> observation -> POST -> compare -> scan -> verify -> closeout, and the claim never exceeds LOGICAL_ACCEPTANCE_ONLY."""

from __future__ import annotations

import os
import re
import subprocess
from pathlib import Path

import pytest

import l8u_support as s

L8U_FILES = [s.STG / "apply.sh", s.STG / "verify.sh", s.STG / "rollback.sh", s.LIB, s.RUNNER, s.OBSERVE, s.PRED, s.FREEZE, s.SNAP]

# lowercase code tokens that can only exist in a device/provisioning/service-control/network-mutation path
FORBIDDEN = (
    "esptool", "p4-l8-device", "p4-l8p-device", "p4-l8p-run-lib", "run-l8p-owner", "p4-nvs-provision", "p4-ntp", "p4-l5-clock", "mosquitto_pub", "mosquitto_sub", "paho", "pyserial", "serial.", "/dev/tty", "/dev/serial",
    "systemctl restart", "systemctl start", "systemctl stop", "systemctl reload", "systemctl enable", "systemctl disable", "systemctl mask", "daemon-reload", "systemctl kill", "chronyc", "timedatectl set",
    "nmcli", "rfkill", "nft add", "nft delete", "nft flush", "iptables", "ip link set", "ip addr add", "write_region", "reset_into_new_image", "--live-authorized", "AEGIS_L8_BACKEND=hardware",
)


@pytest.mark.parametrize("path", L8U_FILES, ids=lambda p: p.name)
def test_no_l8u_file_can_flash_reset_provision_publish_or_control_a_service(path: Path) -> None:
    code = "\n".join(s.code_lines(path))
    for token in FORBIDDEN:
        assert token not in code, f"{path.name} contains {token!r}"


def test_the_observer_has_no_write_or_network_primitive() -> None:
    code = "\n".join(s.code_lines(s.OBSERVE))
    assert "import socket" not in code and "subprocess" not in code and "os.system" not in code and "open(" not in code.replace("sqlite3.connect", "")
    assert code.count("mode=ro") >= 1 and "INSERT" not in code and "UPDATE" not in code and "DELETE" not in code and "CREATE" not in code
    assert "write_text" not in code and "write_bytes" not in code


def test_the_historical_stage_handlers_are_not_wired_into_l8u() -> None:
    text = "\n".join(s.code_lines(s.RUNNER) + s.code_lines(s.LIB))
    assert "stages/L8/" not in text and "stages/L8p/" not in text and "STG=$CTRL/stages/L8u" in text
    assert "l8p_" not in text  # no L8p library function is called (L8p is read-only history via the predecessor module)
    assert text.count("L8P_EXECUTED=NO") >= 1


def test_the_handlers_are_observation_only() -> None:
    apply = (s.STG / "apply.sh").read_text()
    assert "L8U_APPLY=OBSERVE_ONLY" in apply and "ESP32_TOUCHED=NO" in apply and "SERIAL_ACCESSED=NO" in apply and "MQTT_PUBLISHED=NO" in apply
    rollback = subprocess.run(["bash", str(s.STG / "rollback.sh")], capture_output=True, text=True)
    assert rollback.returncode == 0 and "L8U_ROLLBACK=NOT_REQUIRED reason=NO_MUTATION" in rollback.stdout and "ESP32_TOUCHED=NO" in rollback.stdout
    assert (s.STG / "allow-keys.txt").read_text() == "" and (s.STG / "allow-listeners.txt").read_text() == ""  # ZERO Core-host drift allowed
    for script in ("apply.sh", "verify.sh"):
        if os.geteuid() != 0:
            run = subprocess.run(["bash", str(s.STG / script)], capture_output=True, text=True, env={"PATH": os.environ["PATH"]})
            assert run.returncode == 1 and ("required" in run.stderr or "ROOT_REQUIRED" in run.stderr)


def test_verify_requires_the_same_core_process_the_pinned_unit_and_the_historical_evidence() -> None:
    verify = (s.STG / "verify.sh").read_text()
    for needle in ("CORE_RESTARTED_DURING_L8U", "CORE_UNIT_NOT_THE_PINNED_UNIT", "L8P_HISTORICAL_EVIDENCE_INVALID", "--check-l8p-evidence", "/usr/bin/python3 -I", "OBSERVATION_FAILED", "L8U_CLAIM=LOGICAL_ACCEPTANCE_ONLY",
                   "ELECTRICAL_RELAY_PROOF=NO", "PHYSICAL_PROOF=NO", "CORE_UNEXPECTED_RESTART_COUNT"):
        assert needle in verify, needle
    assert "AEGIS_L8U_CORE_PRE_PID" in verify and verify.count("systemctl show -p MainPID") >= 2


def test_the_runner_order_is_gates_then_pre_then_marker_then_observation_then_closeout() -> None:
    text = s.RUNNER.read_text()
    boot = ['control_gate || die', 'control_git_gate || die', 'source "$LIB"', "l8u_env_gate ||", "l7u_identity_gate", "sudo -v ||", "l8u_start_sudo_keepalive"]
    attempt = text[text.index("l8u_run_attempt() {"):]
    flow = ["l8u_pregates ||", 'capture "$EVID/pre-root"', "PRE_CONSUME_REGATE", "l8u_consume_attempt", "l8u_handler apply.sh", 'capture "$EVID/post-root"', "compare ", 'l7u_secret_scan "$EVID"',
            "l8u_handler verify.sh", "terminal-result", 'l8u_write_closeout "$L8U_CLOSEOUT_PASS_NAME"']
    for scope, needles in ((text[text.index("# The library is sourced ONLY after A"):], boot), (attempt, flow)):
        positions = [scope.index(n) for n in needles]
        assert positions == sorted(positions), needles
    assert text.index("control_gate || die") < text.index('source "$LIB"')  # nothing is sourced before the control snapshot is proven
    assert text.index("l8u_run_attempt\necho") > text.index('source "$LIB"')


def test_the_runner_never_runs_code_from_the_mutable_worktree() -> None:
    text = "\n".join(s.code_lines(s.RUNNER))
    assert '"$REPO/' not in text.replace('"$REPO/.git"', "") and "$P4/" not in text and 'bash "$STG/$1"' in text
    assert re.search(r'git -C "\$REPO" (rev-parse|status|fetch)', text)  # the worktree is used only to READ git state
    assert "sudo -n" in text and "SUDO='sudo -n'" in text


def test_a_failure_after_the_marker_is_immutable_has_no_retry_and_no_rollback_action() -> None:
    text = s.RUNNER.read_text()
    body = text[text.index("terminal_fail() {"):text.index("on_signal()")]
    for needle in ("L8U_RESULT=FAIL_IMMUTABLE", "L8U_ROLLBACK=NOT_REQUIRED", "ESP32_TOUCHED=NO", "L8U_CLOSEOUT_FAIL_NAME", "trap - ERR INT TERM HUP", "[ \"$TERMINAL\" = 0 ] || exit 1"):
        assert needle in body or needle in text, needle
    assert "l8u_handler rollback.sh" not in "\n".join(s.code_lines(s.RUNNER))  # nothing is rolled back: nothing was mutated
    for signal in ("INT", "TERM", "HUP"):
        assert f"trap 'on_signal {signal}' {signal}" in text
    assert "trap 'on_exit' EXIT" in text and "trap l8u_stop_sudo_keepalive EXIT" in text  # the keepalive is stopped on EVERY exit path, a pre-attempt refusal included


def test_the_pass_closeout_and_claim_never_exceed_logical_acceptance() -> None:
    lib = s.LIB.read_text()
    for needle in ("L8U_CLAIM=LOGICAL_ACCEPTANCE_ONLY", "ELECTRICAL_RELAY_PROOF=NO", "L9_PROVEN=NO", "L8P_EXECUTED=NO", "ESP32_REFLASH_PERFORMED=NO", "NTP_RERUN=NO"):
        assert needle in lib, needle
    runner = s.RUNNER.read_text()
    assert "ELECTRICAL_RELAY_PROOF=NO" in runner and "L9_PROVEN=NO" in runner
    assert "L8U_LIVE=PASS L8U_CLAIM=LOGICAL_ACCEPTANCE_ONLY" in runner


def test_the_template_refuses_when_unpinned_and_has_no_hidden_pin_site() -> None:
    text = s.RUNNER.read_text()
    pins = re.findall(r"^([A-Z0-9_]+)=(PIN_[A-Z0-9_]+)\s*$", text, re.M)
    assert len(pins) >= 14 and all(name and value.startswith("PIN_") for name, value in pins)
    run = subprocess.run(["bash", str(s.RUNNER), "/tmp"], capture_output=True, text=True, env={"PATH": os.environ["PATH"]})
    assert run.returncode == 2 and "runner is not pinned (EXPECTED_MAIN)" in run.stderr


def test_every_template_pin_has_exactly_one_freeze_site() -> None:
    freeze = s.load(s.FREEZE, "l8u_runner_freeze")
    text = s.RUNNER.read_text()
    for name, (pattern, placeholder, grammar) in freeze.PIN_SPECS.items():
        matches = list(pattern.finditer(text))
        assert len(matches) == 1 and matches[0].group(1) == placeholder and grammar in freeze.VALIDATORS, name
    # every PIN_ placeholder in the template belongs to a freeze site (no pin that the freeze tool would leave unpinned)
    placeholders = set(re.findall(r"PIN_[A-Z0-9_]+", "\n".join(s.code_lines(s.RUNNER))))
    sites = {m for _, p, _ in freeze.PIN_SPECS.values() for m in re.findall(r"PIN_[A-Z0-9_]+", p)}
    leftovers = {p for p in placeholders if p not in sites and p not in {"PIN_"}}
    assert leftovers == set(), leftovers
