"""L5 live-failure remediation (2026-09-25 failed attempt l5-20260925-174630). Tests first.

A. apply readiness must use the same kernel-based TrustedClock predicate as verify (Leap status Normal alone is not enough).
B. rollback must restore the exact original /etc/chrony.conf mtime.
C. time.timesyncd.ServerName is informational only under CONSTRAINED_INFORMATIONAL_DYNAMIC_STATE.
"""
from __future__ import annotations

import importlib.util
import os
import subprocess
from pathlib import Path

import pytest

import test_pr11_phase4_l5_handler as h

DEPLOY = h.DEPLOY
HANDLER = h.HANDLER
CLOCK = DEPLOY / "p4-l5-clock.py"

FALLBACK = "0.arch.pool.ntp.org 1.arch.pool.ntp.org 2.arch.pool.ntp.org 3.arch.pool.ntp.org"


def load_clock():
    assert CLOCK.is_file(), "p4-l5-clock.py (shared apply/verify readiness predicate) is missing"
    spec = importlib.util.spec_from_file_location("p4_l5_clock", CLOCK)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# ── A. readiness predicate ───────────────────────────────────────────────────

def test_a_evaluate_distinguishes_failure_reasons() -> None:
    c = load_clock()
    S = c.ClockSync
    assert c.evaluate(lambda: None)[0] == "PROBE_UNAVAILABLE"
    assert c.evaluate(lambda: S(synced=False, maxerror_us=16_000_000))[0] == "KERNEL_UNSYNCED"
    assert c.evaluate(lambda: S(synced=True, maxerror_us=1_000_001))[0] == "MAXERROR_EXCEEDED"
    assert c.evaluate(lambda: S(synced=True, maxerror_us=1_000_000))[0] == "OK"
    assert c.evaluate(lambda: S(synced=True, maxerror_us=10), wall=lambda: 1.0)[0] == "TRUSTEDCLOCK_NOT_SYNCED"


def test_a1_leap_normal_alone_is_not_ready() -> None:
    c = load_clock()
    ok, reason, _ = c.wait_ready(
        leap=lambda: "Normal",
        probe=lambda: c.ClockSync(synced=False, maxerror_us=16_000_000),
        timeout=0.05, interval=0.01,
    )
    assert ok is False and reason == "KERNEL_UNSYNCED"


def test_a2_waits_until_kernel_predicate_passes() -> None:
    c = load_clock()
    seq = iter([None, c.ClockSync(False, 16_000_000), c.ClockSync(False, 16_000_000), c.ClockSync(True, 400_000)])
    last = {"v": c.ClockSync(True, 400_000)}

    def probe():
        last["v"] = next(seq, last["v"])
        return last["v"]

    ok, reason, log = c.wait_ready(leap=lambda: "Normal", probe=probe, timeout=2.0, interval=0.001)
    assert ok is True and reason == "OK"
    assert len(log) >= 4  # the transition is recorded


def test_a3_fails_closed_after_bounded_window() -> None:
    c = load_clock()
    ok, reason, _ = c.wait_ready(
        leap=lambda: "Normal", probe=lambda: c.ClockSync(True, 5_000_000), timeout=0.05, interval=0.01)
    assert ok is False and reason == "MAXERROR_EXCEEDED"


def test_a4_requires_leap_normal_and_kernel_predicate() -> None:
    c = load_clock()
    ok, reason, _ = c.wait_ready(
        leap=lambda: "Not synchronised", probe=lambda: c.ClockSync(True, 10), timeout=0.05, interval=0.01)
    assert ok is False and reason == "CHRONY_LEAP_NOT_NORMAL"


def test_a4_apply_and_verify_use_the_shared_predicate() -> None:
    for name in ("apply.sh", "verify.sh"):
        text = h.code_text(HANDLER / name)
        assert "p4-l5-clock.py" in text, f"{name} must use the shared readiness predicate"
        assert "adjtimex_probe" not in text, f"{name} must not carry its own inline TrustedClock predicate"


def test_a5_probe_cli_reports_reason() -> None:
    for spec, reason in (("none", "PROBE_UNAVAILABLE"), ("unsynced:16000000", "KERNEL_UNSYNCED"),
                         ("synced:2000000", "MAXERROR_EXCEEDED"), ("synced:1000", "OK")):
        r = subprocess.run(["python3", str(CLOCK), "probe", "--fixture-probe", spec],
                           text=True, capture_output=True, check=False)
        assert f"reason={reason}" in r.stdout, (spec, r.stdout, r.stderr)
        assert (r.returncode == 0) == (reason == "OK")


def _seq_env(tmp: Path, lines: list[str]):
    fs_root, work = tmp / "fs", tmp / "work"
    render = tmp / "render"
    h.setup_t6_render(render)
    h.setup_l4_fs(fs_root)
    (fs_root / "run" / "aegis-idea3-fixture" / "clock_sequence").write_text("\n".join(lines) + "\n", encoding="utf-8")
    env = {"AEGIS_L5_READINESS_TIMEOUT_SEC": "1", "AEGIS_L5_READINESS_INTERVAL_SEC": "0.01"}
    return fs_root, work, render, env


def test_a_apply_fails_closed_when_leap_normal_but_kernel_unsynced(tmp_path: Path) -> None:
    fs_root, work, render, env = _seq_env(tmp_path, ["leap=Normal probe=unsynced maxerror=16000000"])
    r = h.run_handler(HANDLER / "apply.sh", fs_root=fs_root, work_dir=work, render_dir=render, extra_env=env)
    assert r.returncode != 0
    assert "L5_APPLY=PASS" not in r.stdout
    assert "TRUSTEDCLOCK_READINESS_TIMEOUT" in r.stderr and "KERNEL_UNSYNCED" in r.stderr


def test_a_apply_waits_for_kernel_sync_then_passes_and_logs_transition(tmp_path: Path) -> None:
    fs_root, work, render, env = _seq_env(tmp_path, [
        "leap=Normal probe=unsynced maxerror=16000000",
        "leap=Normal probe=unsynced maxerror=16000000",
        "leap=Normal probe=synced maxerror=400000",
    ])
    r = h.run_handler(HANDLER / "apply.sh", fs_root=fs_root, work_dir=work, render_dir=render, extra_env=env)
    assert r.returncode == 0, r.stdout + r.stderr
    assert "L5_APPLY=PASS" in r.stdout
    log = (work / "readiness.log").read_text(encoding="utf-8").splitlines()
    assert len(log) >= 3 and "reason=KERNEL_UNSYNCED" in log[0] and "reason=OK" in log[-1]
    assert all(line.startswith("ts=") for line in log)


def test_a_apply_fails_on_maxerror_exceeded(tmp_path: Path) -> None:
    fs_root, work, render, env = _seq_env(tmp_path, ["leap=Normal probe=synced maxerror=2000000"])
    r = h.run_handler(HANDLER / "apply.sh", fs_root=fs_root, work_dir=work, render_dir=render, extra_env=env)
    assert r.returncode != 0 and "MAXERROR_EXCEEDED" in r.stderr


# ── B. exact rollback mtime ──────────────────────────────────────────────────

ORIG_MTIME = 1777584149  # 2026-05-01 04:22:29 +07, the live value


def test_b_rollback_restores_exact_mtime(tmp_path: Path) -> None:
    fs_root, work, render = tmp_path / "fs", tmp_path / "work", tmp_path / "render"
    h.setup_t6_render(render)
    h.setup_l4_fs(fs_root, existing_chrony_conf="# stock\npool 2.example.invalid iburst\n", existing_chrony_conf_mode=0o644)
    conf = fs_root / "etc" / "chrony.conf"
    os.utime(conf, (ORIG_MTIME, ORIG_MTIME))
    assert h.run_handler(HANDLER / "apply.sh", fs_root=fs_root, work_dir=work, render_dir=render).returncode == 0
    assert int(conf.stat().st_mtime) != ORIG_MTIME
    r = h.run_handler(HANDLER / "rollback.sh", fs_root=fs_root, work_dir=work)
    assert r.returncode == 0, r.stdout + r.stderr
    st = conf.stat()
    assert int(st.st_mtime) == ORIG_MTIME and (st.st_mode & 0o777) == 0o644


def test_b_rollback_fails_when_snapshot_mtime_is_unusable(tmp_path: Path) -> None:
    fs_root, work, render = tmp_path / "fs", tmp_path / "work", tmp_path / "render"
    h.setup_t6_render(render)
    h.setup_l4_fs(fs_root, existing_chrony_conf="# stock\n", existing_chrony_conf_mode=0o644)
    assert h.run_handler(HANDLER / "apply.sh", fs_root=fs_root, work_dir=work, render_dir=render).returncode == 0
    meta = work / "chrony.conf.meta.orig"
    mode, uid, gid, size, _ = meta.read_text().strip().split(":")
    meta.write_text(f"{mode}:{uid}:{gid}:{size}:notanumber\n")
    r = h.run_handler(HANDLER / "rollback.sh", fs_root=fs_root, work_dir=work)
    assert r.returncode != 0 and "ROLLBACK_RESTORE" in r.stderr
    assert "L5_ROLLBACK=PASS" not in r.stdout


def test_b_rollback_source_verifies_mtime_and_size() -> None:
    text = h.code_text(HANDLER / "rollback.sh")
    assert "%Y" in text and "orig_mtime" in text and "orig_size" in text


# ── C. constrained informational timesyncd ServerName ────────────────────────

ROLLBACK_ALLOW = "\n".join([
    "svc.systemd-timesyncd.service.MainPID",
    "svc.systemd-timesyncd.service.ExecMainStartTimestamp",
    "svc.chronyd.service.ExecMainStartTimestamp",
]) + "\n"


def _bundles(tmp: Path, *, after_over: dict[str, str] | None = None, drop_after: tuple[str, ...] = (),
             drop_before: tuple[str, ...] = ()):
    pre = {
        "svc.systemd-timesyncd.service.ActiveState": "active",
        "svc.systemd-timesyncd.service.SubState": "running",
        "svc.systemd-timesyncd.service.MainPID": "400",
        "time.timesyncd.ServerName": "2.arch.pool.ntp.org",
        "time.timesyncd.FallbackNTPServers": FALLBACK,
        "time.trustedclock.state": "SYNCED",
        "time.file./etc/chrony.conf.sha256": "a" * 64,
    }
    post = dict(pre)
    post["time.timesyncd.ServerName"] = "0.arch.pool.ntp.org"
    post["svc.systemd-timesyncd.service.MainPID"] = "916662"
    post.update(after_over or {})
    for k in drop_after:
        post.pop(k, None)
    for k in drop_before:
        pre.pop(k, None)
    h.make_bundle(tmp / "pre", "PRE", pre)
    h.make_bundle(tmp / "rb", "RB", post)
    allow = tmp / "allow.txt"
    allow.write_text(ROLLBACK_ALLOW)
    return h.run_compare(tmp / "pre", tmp / "rb", allow_keys_file=allow)


def _finding(res, key: str) -> str:
    for line in res.stdout.splitlines():
        parts = line.split("\t")
        if parts[0] == "FINDING" and len(parts) > 3 and parts[3] == key:
            return parts[1]
    return "ABSENT"


def test_c_valid_configured_fallback_reselection_is_informational(tmp_path: Path) -> None:
    res = _bundles(tmp_path)
    assert res.returncode == 0, res.stdout
    assert _finding(res, "time.timesyncd.ServerName") == "INFO"
    assert "COMPARE_RESULT=PASS" in res.stdout


def test_c_unconfigured_servername_fails(tmp_path: Path) -> None:
    res = _bundles(tmp_path, after_over={"time.timesyncd.ServerName": "evil.example.invalid"})
    assert res.returncode != 0 and _finding(res, "time.timesyncd.ServerName") == "NEW_OR_WORSENED_DRIFT"


def test_c_servername_change_with_unhealthy_timesyncd_fails(tmp_path: Path) -> None:
    res = _bundles(tmp_path, after_over={"svc.systemd-timesyncd.service.SubState": "dead"})
    assert res.returncode != 0 and _finding(res, "time.timesyncd.ServerName") == "NEW_OR_WORSENED_DRIFT"


def test_c_servername_change_with_trustedclock_not_synced_fails(tmp_path: Path) -> None:
    res = _bundles(tmp_path, after_over={"time.trustedclock.state": "UNTRUSTED"})
    assert res.returncode != 0 and _finding(res, "time.timesyncd.ServerName") == "NEW_OR_WORSENED_DRIFT"


def test_c_changed_fallback_set_fails(tmp_path: Path) -> None:
    res = _bundles(tmp_path, after_over={"time.timesyncd.FallbackNTPServers": FALLBACK + " 4.arch.pool.ntp.org"})
    assert res.returncode != 0 and _finding(res, "time.timesyncd.ServerName") == "NEW_OR_WORSENED_DRIFT"


def test_c_missing_fallback_evidence_fails_closed(tmp_path: Path) -> None:
    res = _bundles(tmp_path, drop_after=("time.timesyncd.FallbackNTPServers",),
                   drop_before=("time.timesyncd.FallbackNTPServers",))
    assert res.returncode != 0 and _finding(res, "time.timesyncd.ServerName") == "NEW_OR_WORSENED_DRIFT"


def test_c_unrelated_drift_still_fails_even_with_valid_reselection(tmp_path: Path) -> None:
    res = _bundles(tmp_path, after_over={"time.file./etc/chrony.conf.sha256": "b" * 64})
    assert _finding(res, "time.timesyncd.ServerName") == "INFO"
    assert res.returncode != 0 and _finding(res, "time.file./etc/chrony.conf.sha256") == "NEW_OR_WORSENED_DRIFT"


def test_c_servername_is_not_a_rollback_allowance() -> None:
    # The repository stage allow-keys keep ServerName for the POST comparison only; nothing new is approved here.
    keys = [l.strip() for l in (HANDLER / "allow-keys.txt").read_text().splitlines() if l.strip() and not l.startswith("#")]
    assert keys.count("time.timesyncd.ServerName") == 1


def test_c_capture_records_fallback_set_and_trustedclock_state() -> None:
    text = (DEPLOY / "p4-l0-capture.sh").read_text(encoding="utf-8")
    assert "FallbackNTPServers" in text and "time.trustedclock.state" in text
