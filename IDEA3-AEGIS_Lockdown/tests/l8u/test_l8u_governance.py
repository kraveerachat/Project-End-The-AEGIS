"""L8u governance: one-attempt marker and closeout semantics, Authorization/K3 binding, cross-stage replay, environment refusals, predecessor gate through the library, host gates. Hermetic: the privilege
prefix is empty, the canonical governance directory is a temporary directory behind the explicit test seam, and systemctl is a PATH stub."""

from __future__ import annotations

import os
import stat
import subprocess
from pathlib import Path

import pytest

import l8u_support as s

BOUNDARY = "L8U_PRE_PROTOCOL_SEEN_ID=7\nL8U_PRE_AUDIT_ID=11\nL8U_PRE_COMMAND_ROWID=3"


def lib(tmp: Path, script: str, *, extra_env: dict[str, str] | None = None, seam: bool = True) -> subprocess.CompletedProcess[str]:
    gov = tmp / "gov"
    env = {"PATH": os.environ["PATH"], "HOME": str(tmp)}
    if seam:
        env.update({"L8U_TEST_ONLY_CANONICAL_DIR_ENABLED": "YES", "L8U_TEST_ONLY_CANONICAL_DIR": str(gov), "L8U_TEST_ONLY_TRUST_ROOT": str(tmp), "L8U_TEST_ONLY_BOUNDARY": BOUNDARY})
    env.update(extra_env or {})
    prelude = f'set -uo pipefail; control_gate() {{ return 0; }}; SUDO=""; CTRL="{s.P4}"; PY=python3; . "{s.LIB}"; '
    return subprocess.run(["bash", "-c", prelude + script], env=env, text=True, capture_output=True)


def gov(tmp: Path) -> Path:
    path = tmp / "gov"
    path.mkdir(mode=0o700, exist_ok=True)
    return path


# ---- one-attempt marker + closeouts -----------------------------------------------------------------------------------------------------------


def test_the_marker_is_consumed_exactly_once_and_carries_the_boundary(tmp_path: Path) -> None:
    run = lib(tmp_path, 'l8u_marker_unconsumed && l8u_consume_attempt /tmp/w esp32-01 && echo CONSUMED=$L8U_MARKER_CREATED; l8u_marker_unconsumed; echo again=$?; l8u_consume_attempt /tmp/w esp32-01; echo second=$?')
    assert "CONSUMED=1" in run.stdout and "again=1" in run.stdout and "second=1" in run.stdout and "L8U_ATTEMPT_ALREADY_CONSUMED" in run.stderr
    marker = (tmp_path / "gov/L8U-GLOBAL-ATTEMPT-CONSUMED").read_text()
    for line in ("L8U_ATTEMPT_CONSUMED=YES", "L8U_RERUN_ALLOWED=NO", "L8U_DEVICE_ID=esp32-01", "work=/tmp/w", "L8U_PRE_PROTOCOL_SEEN_ID=7", "L8U_PRE_AUDIT_ID=11", "L8U_PRE_COMMAND_ROWID=3"):
        assert line in marker.splitlines()
    assert re_epoch(marker)


def re_epoch(text: str) -> bool:
    import re
    return bool(re.search(r"^L8U_CONSUMED_AT_EPOCH=\d+\.\d+$", text, re.M))


@pytest.mark.parametrize("existing", ["L8U-GLOBAL-ATTEMPT-CONSUMED", "L8U-GLOBAL-CLOSEOUT-PASS", "L8U-GLOBAL-CLOSEOUT-FAIL"])
def test_any_existing_l8u_record_means_the_attempt_is_consumed_forever(tmp_path: Path, existing: str) -> None:
    (gov(tmp_path) / existing).write_text("x\n")
    run = lib(tmp_path, "l8u_marker_unconsumed; echo rc=$?")
    assert "rc=1" in run.stdout and f"L8U_ATTEMPT_ALREADY_CONSUMED:{existing}" in run.stderr


def test_a_dangling_symlink_marker_counts_as_consumed(tmp_path: Path) -> None:
    (gov(tmp_path) / "L8U-GLOBAL-ATTEMPT-CONSUMED").symlink_to(tmp_path / "nowhere")
    assert "rc=1" in lib(tmp_path, "l8u_marker_unconsumed; echo rc=$?").stdout


@pytest.mark.parametrize("setup", ["symlink", "group_writable", "world_writable"])
def test_an_untrusted_canonical_directory_is_refused(tmp_path: Path, setup: str) -> None:
    real = tmp_path / "real"
    real.mkdir(mode=0o700)
    if setup == "symlink":
        (tmp_path / "gov").symlink_to(real)
    else:
        g = gov(tmp_path)
        g.chmod(0o770 if setup == "group_writable" else 0o707)
    run = lib(tmp_path, "l8u_marker_unconsumed; echo rc=$?; l8u_consume_attempt /tmp/w esp32-01; echo c=$?")
    assert "rc=1" in run.stdout and "c=1" in run.stdout and "L8U_CANONICAL_DIR_NOT_TRUSTED" in run.stderr
    assert not (real / "L8U-GLOBAL-ATTEMPT-CONSUMED").exists()


def test_consume_refuses_a_malformed_work_dir_or_device(tmp_path: Path) -> None:
    run = lib(tmp_path, 'l8u_consume_attempt rel/w esp32-01; echo a=$?; l8u_consume_attempt /tmp/w "bad id"; echo b=$?; l8u_consume_attempt /tmp/../w esp32-01; echo c=$?')
    assert run.stdout.split() == ["a=1", "b=1", "c=1"] and not (tmp_path / "gov/L8U-GLOBAL-ATTEMPT-CONSUMED").exists()


def test_the_test_seam_is_inert_unless_explicitly_enabled(tmp_path: Path) -> None:
    run = lib(tmp_path, "l8u_canonical_dir", extra_env={"L8U_TEST_ONLY_CANONICAL_DIR_ENABLED": "NO", "L8U_TEST_ONLY_CANONICAL_DIR": str(tmp_path / "evil")})
    assert run.stdout == "/var/lib/aegis-idea3-governance"


def test_closeouts_are_exclusive_durable_and_never_contradictory(tmp_path: Path) -> None:
    gov(tmp_path)
    run = lib(tmp_path, 'l8u_write_closeout L8U-GLOBAL-CLOSEOUT-PASS "$(l8u_pass_content ' + "a" * 40 + " " + "b" * 64 + ' /e)"; echo p1=$?; '
                        'l8u_write_closeout L8U-GLOBAL-CLOSEOUT-PASS "x"; echo p2=$?; l8u_write_closeout evil "x"; echo bad=$?')
    assert run.stdout.split() == ["p1=0", "p2=1", "bad=1"]
    text = (tmp_path / "gov/L8U-GLOBAL-CLOSEOUT-PASS").read_text()
    for line in ("L8U_LIVE=CLOSED_PASS", "L8U_RESULT=PASS", "L8U_CLAIM=LOGICAL_ACCEPTANCE_ONLY", "L8P_EXECUTED=NO", "ESP32_REFLASH_PERFORMED=NO", "NTP_RERUN=NO", "ELECTRICAL_RELAY_PROOF=NO", "L9_PROVEN=NO", f"L8U_EXPECTED_MAIN={'a' * 40}"):
        assert line in text.splitlines(), line
    assert not list((tmp_path / "gov").glob("*.tmp.*"))  # the temp name never survives
    # a FAIL closeout blocks a PASS closeout
    other = tmp_path / "b"
    other.mkdir()
    gov(other)
    run = lib(other, 'l8u_write_closeout L8U-GLOBAL-CLOSEOUT-FAIL "$(l8u_fail_content ' + "a" * 40 + ' VERIFY /e)"; echo f=$?; l8u_write_closeout L8U-GLOBAL-CLOSEOUT-PASS "x"; echo p=$?')
    assert run.stdout.split() == ["f=0", "p=1"] and "L8U_FAIL_CLOSEOUT_EXISTS" in run.stderr
    fail = (other / "gov/L8U-GLOBAL-CLOSEOUT-FAIL").read_text()
    assert "L8U_RESULT=FAIL_IMMUTABLE" in fail and "L8U_RERUN_ALLOWED=NO" in fail and "L8_ACCEPTANCE=NO" in fail and "L8U_FAILURE_REASON=VERIFY" in fail


def test_the_recovery_marker_gate_is_read_only(tmp_path: Path) -> None:
    g = gov(tmp_path)
    assert "rc=1" in lib(tmp_path, "l8u_recovery_marker_gate; echo rc=$?").stdout
    (g / "RECOVERY-GLOBAL-ATTEMPT-CONSUMED").write_text("x\n")
    assert "rc=0" in lib(tmp_path, "l8u_recovery_marker_gate; echo rc=$?").stdout
    (g / "RECOVERY-GLOBAL-ATTEMPT-CONSUMED").unlink()
    (g / "RECOVERY-GLOBAL-ATTEMPT-CONSUMED").symlink_to(g / "x")
    assert "rc=1" in lib(tmp_path, "l8u_recovery_marker_gate; echo rc=$?").stdout
    assert sorted(p.name for p in g.iterdir()) == ["RECOVERY-GLOBAL-ATTEMPT-CONSUMED"]  # nothing was created


# ---- Authorization / K3 -----------------------------------------------------------------------------------------------------------------------

MAIN, RUNNER, FW, LVR = "a" * 40, "b" * 64, "c" * 64, "d" * 64
TODAY = "2026-10-20"


def records(tmp: Path, *, auth_extra: str = "", k3_extra: str = "", stage: str = "L8u", date: str = TODAY, names: dict[str, str] | None = None, k3_names: str | None = None) -> Path:
    """The Authorization names every frozen binding. scope (<=200 chars) carries main + runner; reference (<=199 chars) carries the device MAC, firmware digest and LVR closeout digest."""
    d = tmp / "auth"
    d.mkdir(exist_ok=True, mode=0o700)
    n = {"main": MAIN, "runner": RUNNER, "mac": s.MAC, "fw": FW, "lvr": LVR, **(names or {})}
    (d / "authorization-L8u.txt").write_text(f"AEGIS_P4_AUTHORIZATION_V1\nstage={stage}\ndate={date}\nauthorizer=music\nscope=L8u logical acceptance main {n['main']} runner {n['runner']}\n"
                                              f"reference=https://example.test/l8u/{n['mac']}/{n['fw']}/{n['lvr']}\n{auth_extra}")
    k3n = k3_names if k3_names is not None else MAIN
    (d / "k3-L8u.txt").write_text(f"AEGIS_P4_K3_CONFIRMATION_V2\nstage={stage}\ndate={date}\nconfirmed_by=music\nconfirmation_mode=IDEA3_OWNER_SELF_ATTESTATION\nidea1_window_overlap=NONE_KNOWN\nreference=https://example.test/k3/{k3n}\n{k3_extra}")
    return d


def gate(tmp: Path, d: Path) -> subprocess.CompletedProcess[str]:
    return lib(tmp, f'l8u_records_gate "{d}" {TODAY} {MAIN} {RUNNER} {s.MAC} {FW} {LVR}; echo rc=$?')


def test_valid_records_bound_to_main_runner_device_firmware_and_lvr_closeout_pass(tmp_path: Path) -> None:
    assert "rc=0" in gate(tmp_path, records(tmp_path)).stdout


@pytest.mark.parametrize("kwargs,reason", [
    ({"stage": "Recovery"}, "L8U_RECORD_NOT_STAGE_L8U"), ({"stage": "CTu"}, "L8U_RECORD_NOT_STAGE_L8U"), ({"stage": "L8"}, "L8U_RECORD_NOT_STAGE_L8U"), ({"date": "2026-10-19"}, "L8U_RECORD_NOT_TODAY"),
    ({"auth_extra": "recovery_authorization=https://example.test/l8\n"}, "L8U_AUTHORIZATION_KEY_SET_INVALID"), ({"auth_extra": "d6_notice=pub\n"}, "L8U_AUTHORIZATION_KEY_SET_INVALID"),
    ({"auth_extra": "physical_recovery_attestation=https://example.test/x\n"}, "L8U_AUTHORIZATION_KEY_SET_INVALID"), ({"k3_extra": "extra=1\n"}, "L8U_K3_KEY_SET_INVALID"),
    ({"names": {"main": "e" * 40}}, "L8U_AUTHORIZATION_DOES_NOT_NAME"),
    ({"names": {"runner": "e" * 64}}, "L8U_AUTHORIZATION_DOES_NOT_NAME"),
    ({"names": {"mac": "aa:bb:cc:dd:ee:99"}}, "L8U_AUTHORIZATION_DOES_NOT_NAME"),
    ({"names": {"fw": "e" * 64}}, "L8U_AUTHORIZATION_DOES_NOT_NAME"),
    ({"names": {"lvr": "e" * 64}}, "L8U_AUTHORIZATION_DOES_NOT_NAME"),
    ({"k3_names": "e" * 40}, "L8U_K3_DOES_NOT_NAME_THE_PINNED_MAIN"),
])
def test_wrong_records_are_refused(tmp_path: Path, kwargs: dict, reason: str) -> None:
    run = gate(tmp_path, records(tmp_path, **kwargs))
    assert "rc=1" in run.stdout and reason in run.stderr


def test_missing_or_symlinked_records_are_refused(tmp_path: Path) -> None:
    d = records(tmp_path)
    (d / "k3-L8u.txt").unlink()
    assert "L8U_RECORD_MISSING:k3-L8u.txt" in gate(tmp_path, d).stderr
    real = tmp_path / "real-k3"
    real.write_text("x")
    (d / "k3-L8u.txt").symlink_to(real)
    assert "rc=1" in gate(tmp_path, d).stdout


# ---- the real shared stage gate: stage registration, no-extra-fields, cross-stage replay -----------------------------------------------------------


def stage_gate(stage: str, d: Path, *, auth: str = "authorization-L8u.txt", k3: str = "k3-L8u.txt", mode: str = "live") -> str:
    # the stage gate compares the record date with TODAY in Asia/Bangkok: rewrite the fixture dates to today for these runs
    today = subprocess.run(["date", "+%F"], env={**os.environ, "TZ": "Asia/Bangkok"}, text=True, capture_output=True).stdout.strip()
    for name in (auth, k3):
        path = d / name
        path.write_text(path.read_text().replace(f"date={TODAY}", f"date={today}"))
    done = subprocess.run(["bash", str(s.STAGE_GATE), "--stage", stage, "--mode", mode, "--authorization", str(d / auth), "--k3", str(d / k3)], text=True, capture_output=True, env={**os.environ, "TZ": "Asia/Bangkok"})
    return done.stdout


def test_the_stage_gate_accepts_valid_l8u_records_and_a_registered_rollback_handler(tmp_path: Path) -> None:
    out = stage_gate("L8u", records(tmp_path))
    assert "AUTHORIZATION_RECORD=VALID" in out and "K3_CONFIRMATION=VALID" in out and "ROLLBACK_HANDLER=REGISTERED" in out and "STAGE_MUTATES_PRODUCTION=YES" in out and "GATE_FAIL" not in out


@pytest.mark.parametrize("extra", ["recovery_authorization=https://example.test/l8\n", "d6_notice=pub\n", "integration_review=kla\n"])
def test_l8u_never_carries_the_extra_fields_of_other_stages(tmp_path: Path, extra: str) -> None:
    out = stage_gate("L8u", records(tmp_path, auth_extra=extra))
    assert "GATE_FAIL AUTHORIZATION_MALFORMED" in out and "AUTHORIZATION_RECORD=INVALID" in out


@pytest.mark.parametrize("stage", ["Recovery", "CTu", "RRu", "L8", "L8p", "L9", "R1Bv", "F1u"])
def test_l8u_records_cannot_be_replayed_as_another_stage(tmp_path: Path, stage: str) -> None:
    out = stage_gate(stage, records(tmp_path))
    assert "AUTHORIZATION_RECORD=VALID" not in out and ("STAGE_MISMATCH" in out or "MALFORMED" in out)


@pytest.mark.parametrize("stage", ["Recovery", "CTu", "RRu", "L8", "L8p", "L9"])
def test_other_stage_records_cannot_be_replayed_as_l8u(tmp_path: Path, stage: str) -> None:
    d = tmp_path / "other"
    d.mkdir()
    for name, magic in (("authorization-L8u.txt", "AEGIS_P4_AUTHORIZATION_V1"), ("k3-L8u.txt", "AEGIS_P4_K3_CONFIRMATION_V2")):
        body = f"{magic}\nstage={stage}\ndate={TODAY}\n"
        body += "authorizer=music\nscope=x\nreference=https://example.test/r\n" if "authorization" in name else "confirmed_by=music\nconfirmation_mode=IDEA3_OWNER_SELF_ATTESTATION\nidea1_window_overlap=NONE_KNOWN\nreference=https://example.test/k\n"
        (d / name).write_text(body)
    out = stage_gate("L8u", d)
    assert "AUTHORIZATION_STAGE_MISMATCH" in out and "K3_STAGE_MISMATCH" in out and "AUTHORIZATION_RECORD=VALID" not in out


def test_l8u_is_a_registered_stage_between_recovery_and_the_historical_l8() -> None:
    text = (s.P4 / "p4-lib.sh").read_text()
    assert 'readonly P4_STAGES="' in text and " Recovery L8u L8 L9\"" in text
    assert "    L8u) echo none ;;" in text
    run = s.bash(f'. "{s.P4 / "p4-lib.sh"}"; p4_stage_known L8u && echo known; p4_stage_gaps L8u; p4_stage_auth_extra L8u')
    assert run.stdout.split() == ["known", "none"]


# ---- environment gate -------------------------------------------------------------------------------------------------------------------------


@pytest.mark.parametrize("var", ["PYTHONPATH", "LD_PRELOAD", "BASH_ENV", "AEGIS_L8_BACKEND", "AEGIS_L8_LIVE_AUTHORIZED", "AEGIS_L8_ESPTOOL", "AEGIS_L8P_LIVE_AUTHORIZED", "AEGIS_L8U_WORK_DIR", "AEGIS_P4_FS_ROOT",
                                "L8U_TEST_ONLY_CANONICAL_DIR_ENABLED", "L8U_TEST_ONLY_BOUNDARY", "GIT_DIR", "GIT_CONFIG_COUNT", "SHELLOPTS"])
def test_the_environment_gate_refuses_overrides_and_device_backends(tmp_path: Path, var: str) -> None:
    run = lib(tmp_path, "l8u_env_gate; echo rc=$?", seam=False, extra_env={var: "x"})
    assert "rc=1" in run.stdout and "L8U_ENVIRONMENT_OVERRIDE" in run.stderr


def test_a_clean_environment_passes_the_environment_gate(tmp_path: Path) -> None:
    assert "rc=0" in lib(tmp_path, "l8u_env_gate; echo rc=$?", seam=False).stdout


# ---- predecessor gate through the library ------------------------------------------------------------------------------------------------------


def test_the_library_predecessor_gate_requires_head_to_be_the_pinned_main_and_lvr_pass(tmp_path: Path) -> None:
    repo, execution, main = s.world(tmp_path / "w")
    import hashlib
    pin = hashlib.sha256((repo / s.LVR_REL).read_bytes()).hexdigest()
    ok = lib(tmp_path, f'l8u_predecessor_gate "{repo}" {main} {pin}; echo rc=$?')
    assert "rc=0" in ok.stdout, ok.stderr
    stale = lib(tmp_path, f'l8u_predecessor_gate "{repo}" {execution} {pin}; echo rc=$?')  # pinned main is not HEAD
    assert "rc=1" in stale.stdout and "L8U_HEAD_NOT_THE_PINNED_MAIN" in stale.stderr
    s.git(repo, "checkout", "-q", execution)
    old = lib(tmp_path, f'l8u_predecessor_gate "{repo}" {execution} {pin}; echo rc=$?')  # HEAD == pinned, but the pinned main has no LVR closeout
    assert "rc=1" in old.stdout and "L8U_PREDECESSOR_GATE_FAILED" in old.stderr


# ---- host gates (systemctl stub) ---------------------------------------------------------------------------------------------------------------


def stub_systemctl(tmp: Path, **props: str) -> Path:
    bindir = tmp / "bin"
    bindir.mkdir(exist_ok=True)
    cases = "\n".join(f'    {k}) echo "{v}" ;;' for k, v in props.items())
    (bindir / "systemctl").write_text(f'#!/bin/sh\nprop=""\nwhile [ $# -gt 0 ]; do case "$1" in -p) prop=$2; shift ;; esac; shift; done\ncase "$prop" in\n{cases}\n    *) echo "" ;;\nesac\n')
    (bindir / "systemctl").chmod(0o755)
    return bindir


def unit_gate(tmp: Path, unit: Path, pin: str, **props: str) -> subprocess.CompletedProcess[str]:
    bindir = stub_systemctl(tmp, **{"DropInPaths": "", "NeedDaemonReload": "no", "ProtectClock": "no", **props})
    return lib(tmp, f'L8U_CORE_UNIT_PATH="{unit}"; l8u_core_unit_gate {pin}; echo rc=$?', extra_env={"PATH": f"{bindir}:{os.environ['PATH']}"})


def test_the_core_unit_gate_requires_the_exact_pinned_regular_unit_with_the_effective_clock_setting(tmp_path: Path) -> None:
    import hashlib
    unit = tmp_path / "core.service"
    unit.write_text("[Service]\nProtectClock=false\n")
    pin = hashlib.sha256(unit.read_bytes()).hexdigest()
    assert "rc=0" in unit_gate(tmp_path, unit, pin).stdout
    assert "L8U_CORE_UNIT_NOT_THE_PINNED_UNIT" in unit_gate(tmp_path, unit, "f" * 64).stderr
    assert "L8U_CORE_UNIT_DROPIN_PRESENT" in unit_gate(tmp_path, unit, pin, DropInPaths="/etc/x.d/o.conf").stderr
    assert "L8U_CORE_UNIT_RELOAD_PENDING" in unit_gate(tmp_path, unit, pin, NeedDaemonReload="yes").stderr
    assert "L8U_CORE_PROTECTCLOCK_NOT_OFF" in unit_gate(tmp_path, unit, pin, ProtectClock="yes").stderr
    link = tmp_path / "link.service"
    link.symlink_to(unit)
    assert "L8U_CORE_UNIT_NOT_A_REGULAR_FILE" in unit_gate(tmp_path, link, pin).stderr


def test_the_service_gate_requires_active_running(tmp_path: Path) -> None:
    bindir = stub_systemctl(tmp_path, ActiveState="active", SubState="running")
    assert "rc=0" in lib(tmp_path, "l8u_service_gate a.service b.service; echo rc=$?", extra_env={"PATH": f"{bindir}:{os.environ['PATH']}"}).stdout
    bindir = stub_systemctl(tmp_path, ActiveState="failed", SubState="dead")
    run = lib(tmp_path, "l8u_service_gate a.service; echo rc=$?", extra_env={"PATH": f"{bindir}:{os.environ['PATH']}"})
    assert "rc=1" in run.stdout and "L8U_SERVICE_NOT_ACTIVE:a.service" in run.stderr
