"""AEGIS IDEA3 PR11 Phase 4 — p4-l0-capture.sh must be host-state READ-ONLY on a chronyd-active / systemd-timesyncd-inactive host.

Root cause of the consumed 2026-10-03 PRE-L8p NTP reactivation: `timedatectl show-timesync` talks to systemd-timesyncd and ACTIVATES it when it is stopped, and
chronyd.service has `Conflicts=systemd-timesyncd.service`, so the POST capture silently stopped the chronyd that VERIFY had just proven. The capture now queries the
timesyncd-specific properties ONLY while systemd-timesyncd is already active/running and otherwise records one stable sentinel, issuing no timesync command.

The fake `timedatectl show-timesync` below is STATEFUL: like the real one it activates timesyncd and (through the chronyd conflict) deactivates chronyd, by rewriting the
unit fixtures the fake systemctl reads. The old capture therefore fails these tests; the repaired one cannot trigger the side effect. Hermetic: no real host command runs.
"""

from __future__ import annotations

import re
import subprocess
from pathlib import Path

import pytest
from test_pr11_phase4_harness import (
    CAPTURE,
    Capture,
    capture,
    codes,
    compare,
    findings,
    fx,
    healthy_fixtures,
    unit,
)

DEPLOY = CAPTURE.parent
SENTINEL = "TIMESYNCD_INACTIVE_NOT_QUERIED"
TS_KEYS = ("time.timesyncd.ServerName", "time.timesyncd.SystemNTPServers", "time.timesyncd.FallbackNTPServers")
NTP_ALLOW = DEPLOY / "reactivation" / "pre-l8p-ntp-runtime-reactivation" / "allow-keys.txt"
EMPTY_LISTENERS = DEPLOY / "stages" / "L8p" / "allow-listeners.txt"

# fixtures for the two timesync queries (only consulted when timesyncd is already running)
TS_FIXTURES = {
    fx("timedatectl", "show-timesync", "-p", "ServerName", "-p", "SystemNTPServers"): "ServerName=2.arch.pool.ntp.org\nSystemNTPServers=\n",
    fx("timedatectl", "show-timesync", "-p", "FallbackNTPServers"): "FallbackNTPServers=0.arch.pool.ntp.org 1.arch.pool.ntp.org\n",
}

STATEFUL_TIMEDATECTL = r"""#!/usr/bin/env bash
# Stateful stand-in for timedatectl: show-timesync ACTIVATES timesyncd and, via Conflicts=, stops chronyd (the live 2026-10-03 behaviour).
if [ "$1" = show-timesync ]; then
  printf '%s\n' "timedatectl $*" >> "$P4_SIDE_LOG"
  if ! grep -q '^ActiveState=active' "$P4_FIX/units/systemd-timesyncd.service" 2>/dev/null; then
    printf 'ACTIVATED systemd-timesyncd; chronyd stopped by Conflicts=\n' >> "$P4_SIDE_LOG"
    sed -i 's/^ActiveState=.*/ActiveState=inactive/; s/^SubState=.*/SubState=dead/' "$P4_FIX/units/chronyd.service"
    sed -i 's/^ActiveState=.*/ActiveState=active/; s/^SubState=.*/SubState=running/' "$P4_FIX/units/systemd-timesyncd.service"
  fi
fi
exec "$P4_REAL_BIN/timedatectl" "$@"
"""


def ntp_runtime(*, timesyncd_active: bool, with_ts_fixtures: bool = True) -> dict[str, str]:
    fix = healthy_fixtures()
    if with_ts_fixtures:
        fix.update(TS_FIXTURES)
    if timesyncd_active:
        fix["units/systemd-timesyncd.service"] = unit(active="active", sub="running", pid=5555)
        fix["units/chronyd.service"] = unit(active="inactive", sub="dead", pid=0)
    else:
        fix["units/systemd-timesyncd.service"] = unit(active="inactive", sub="dead", pid=0)
        fix["units/chronyd.service"] = unit(active="active", sub="running", pid=7777)
    return fix


def stateful_capture(tmp_path: Path, name: str, fixtures: dict[str, str]) -> tuple[Capture, Path]:
    side_log = tmp_path / f"{name}-side-effects.log"
    side_log.touch()
    mybin = tmp_path / f"{name}-statefulbin"
    mybin.mkdir()
    stub = mybin / "timedatectl"
    stub.write_text(STATEFUL_TIMEDATECTL)
    stub.chmod(0o755)
    real_bin = tmp_path / name / "bin"  # make_bin() creates it at exactly this path
    cap = capture(tmp_path, name, fixtures=fixtures, PATH=f"{mybin}:{real_bin}", P4_SIDE_LOG=str(side_log), P4_REAL_BIN=str(real_bin))
    return cap, side_log


def calls_of(cap: Capture) -> list[str]:
    return cap.calls.read_text().splitlines()


def timesync_calls(cap: Capture) -> list[str]:
    return [c for c in calls_of(cap) if c.startswith("timedatectl show-timesync")]


def state(cap: Capture, key: str) -> str:
    return cap.records()[key]


# ── A. chronyd active / timesyncd inactive: the capture is read-only ───────────────────────────────────────────────────────────────────────────────

def test_capture_with_chronyd_active_and_timesyncd_inactive_issues_no_timesync_query(tmp_path: Path) -> None:
    cap, side_log = stateful_capture(tmp_path, "post", ntp_runtime(timesyncd_active=False))
    assert cap.result.returncode == 0, cap.result.stdout + cap.result.stderr
    assert timesync_calls(cap) == [], "no activating timesync query may be issued while timesyncd is inactive"
    assert side_log.read_text() == "", "the stateful fake recorded no activation"
    assert not any("show-timesync" in c for c in calls_of(cap))


def test_capture_does_not_alter_the_intended_daemon_state(tmp_path: Path) -> None:
    fix = ntp_runtime(timesyncd_active=False)
    cap, side_log = stateful_capture(tmp_path, "post", fix)
    rec = cap.records()
    assert rec["svc.chronyd.service.ActiveState"] == "active" and rec["svc.chronyd.service.SubState"] == "running"
    assert rec["svc.systemd-timesyncd.service.ActiveState"] == "inactive" and rec["svc.systemd-timesyncd.service.SubState"] == "dead"
    assert side_log.read_text() == ""
    # the unit fixtures on disk (what the fake systemctl reports) are byte-identical after the capture
    fixroot = cap.root / "fix" / "units"
    assert "ActiveState=active" in (fixroot / "chronyd.service").read_text()
    assert "ActiveState=inactive" in (fixroot / "systemd-timesyncd.service").read_text()


def test_inactive_timesyncd_records_one_explicit_stable_sentinel_for_every_timesyncd_key(tmp_path: Path) -> None:
    cap, _ = stateful_capture(tmp_path, "post", ntp_runtime(timesyncd_active=False))
    rec = cap.records()
    for key in TS_KEYS:
        assert rec[key] == SENTINEL, key
    # the configured server set stays comparable through the file records and the unchanged TrustedClock/NTP evidence
    assert "time.NTP" in rec and "time.trustedclock.state" in rec and "time.NTPSynchronized" in rec


def test_the_old_behaviour_is_the_bug_a_stateful_show_timesync_would_stop_chronyd(tmp_path: Path) -> None:
    """Control: prove the fake models the live side effect, so the passing tests above are meaningful."""
    fix = ntp_runtime(timesyncd_active=False)
    cap, side_log = stateful_capture(tmp_path, "control", fix)
    assert side_log.read_text() == ""
    probe = subprocess.run(["bash", "-c", f'P4_FIX="{cap.root / "fix"}" P4_SIDE_LOG="{side_log}" P4_REAL_BIN="{cap.bindir}" '
                                          f'P4_CALL_LOG="{cap.calls}" "{tmp_path / "control-statefulbin" / "timedatectl"}" show-timesync -p ServerName -p SystemNTPServers'],
                           capture_output=True, text=True, check=False)
    assert "ACTIVATED systemd-timesyncd" in side_log.read_text(), probe.stderr
    assert "ActiveState=inactive" in (cap.root / "fix" / "units" / "chronyd.service").read_text()


# ── B. timesyncd already active: the required evidence is retained ─────────────────────────────────────────────────────────────────────────────

def test_normal_timesyncd_active_capture_retains_the_required_timesync_evidence(tmp_path: Path) -> None:
    cap, side_log = stateful_capture(tmp_path, "pre", ntp_runtime(timesyncd_active=True))
    assert cap.result.returncode == 0, cap.result.stdout + cap.result.stderr
    rec = cap.records()
    assert rec["time.timesyncd.ServerName"] == "2.arch.pool.ntp.org"
    assert rec["time.timesyncd.SystemNTPServers"] == ""
    assert rec["time.timesyncd.FallbackNTPServers"] == "0.arch.pool.ntp.org 1.arch.pool.ntp.org"
    assert len(timesync_calls(cap)) == 2, "both timesync queries run (they activate nothing: the daemon is already running)"
    assert side_log.read_text().count("ACTIVATED") == 0
    assert SENTINEL not in cap.evid.joinpath("time.tsv").read_text()
    assert (cap.evid / "raw" / "timesync.txt").is_file() and (cap.evid / "raw" / "timesync-fallback.txt").is_file()


def test_timesyncd_active_but_the_query_failing_keeps_the_unavailable_semantics(tmp_path: Path) -> None:
    fix = ntp_runtime(timesyncd_active=True, with_ts_fixtures=False)
    del fix[fx("timedatectl", "show-timesync", "-p", "ServerName", "-p", "SystemNTPServers")]  # the healthy base carries it; make the query fail
    cap = capture(tmp_path, "pre", fixtures=fix)
    rec = cap.records()
    assert rec["time.timesyncd.ServerName"] == "UNAVAILABLE" and rec["time.timesyncd.FallbackNTPServers"] == "UNAVAILABLE"


@pytest.mark.parametrize("active,sub", [("activating", "start"), ("deactivating", "stop-sigterm"), ("failed", "failed"), ("inactive", "dead"), ("active", "exited")])
def test_only_active_running_timesyncd_is_ever_queried(tmp_path: Path, active: str, sub: str) -> None:
    fix = ntp_runtime(timesyncd_active=False)
    fix["units/systemd-timesyncd.service"] = unit(active=active, sub=sub, pid=0)
    cap = capture(tmp_path, "post", fixtures=fix)
    assert timesync_calls(cap) == [] and cap.records()["time.timesyncd.ServerName"] == SENTINEL


def test_an_unreadable_timesyncd_state_never_triggers_a_query(tmp_path: Path) -> None:
    fix = ntp_runtime(timesyncd_active=False)
    del fix["units/systemd-timesyncd.service"]  # the fake systemctl then reports a not-found/inactive unit
    cap = capture(tmp_path, "post", fixtures=fix)
    assert timesync_calls(cap) == [] and cap.records()["time.timesyncd.ServerName"] == SENTINEL


def test_the_state_probe_itself_is_a_guarded_read_only_systemctl_show(tmp_path: Path) -> None:
    cap = capture(tmp_path, "post", fixtures=ntp_runtime(timesyncd_active=False))
    probes = [c for c in calls_of(cap) if c.startswith("systemctl show -p ActiveState -p SubState systemd-timesyncd.service")]
    assert probes and all(c.endswith("guard=1") for c in probes), "the probe runs under the p4_ro read-only guard"


# ── C. comparisons stay deterministic / comparable ─────────────────────────────────────────────────────────────────────────────────────────────

def test_two_captures_of_the_same_chronyd_runtime_are_byte_identical_in_time_evidence(tmp_path: Path) -> None:
    a, _ = stateful_capture(tmp_path, "one", ntp_runtime(timesyncd_active=False))
    b, _ = stateful_capture(tmp_path, "two", ntp_runtime(timesyncd_active=False))
    assert (a.evid / "time.tsv").read_text() == (b.evid / "time.tsv").read_text()
    assert (a.evid / "services.tsv").read_text() == (b.evid / "services.tsv").read_text()


def test_pre_to_post_compare_on_a_chronyd_runtime_has_no_timesyncd_drift_even_with_empty_allow_files(tmp_path: Path) -> None:
    """The L8p shape: PRE and POST are both chronyd-active, so the allow files are EMPTY and the sentinel must compare equal."""
    a, _ = stateful_capture(tmp_path, "pre", ntp_runtime(timesyncd_active=False))
    b, _ = stateful_capture(tmp_path, "post", ntp_runtime(timesyncd_active=False))
    res = compare(a, b)
    assert res.returncode == 0, res.stdout
    assert "FINDINGS_NEW_OR_WORSENED_DRIFT=0" in res.stdout and "COMPARE_RESULT=PASS" in res.stdout
    assert not [f for f in findings(res) if f[2].startswith("time.")]


def test_ntp_reactivation_pre_to_post_compare_accepts_exactly_the_approved_sentinel_substitution(tmp_path: Path) -> None:
    """PRE: timesyncd active (real server evidence). POST: chronyd active, timesyncd inactive (sentinel). The package allow list must cover the three timesyncd keys."""
    pre, _ = stateful_capture(tmp_path, "pre", ntp_runtime(timesyncd_active=True))
    post, _ = stateful_capture(tmp_path, "post", ntp_runtime(timesyncd_active=False))
    res = compare(pre, post, ALLOW_KEYS_FILE=str(NTP_ALLOW), ALLOW_LISTENERS_FILE=str(EMPTY_LISTENERS))
    changed = {f[2] for f in findings(res) if f[2].startswith("time.timesyncd.")}
    assert changed == set(TS_KEYS), res.stdout
    assert all(f[0] == "APPROVED_CHANGE" for f in findings(res) if f[2] in TS_KEYS), res.stdout
    assert not [f for f in findings(res) if f[2].startswith("time.") and f[2] not in TS_KEYS and f[0] != "INFO"], res.stdout


def test_without_the_allow_keys_the_sentinel_cannot_hide_a_timesyncd_state_change(tmp_path: Path) -> None:
    pre, _ = stateful_capture(tmp_path, "pre", ntp_runtime(timesyncd_active=True))
    post, _ = stateful_capture(tmp_path, "post", ntp_runtime(timesyncd_active=False))
    res = compare(pre, post)
    assert res.returncode == 1 and "TIME_STATE_DRIFT" in codes(res, "NEW_OR_WORSENED_DRIFT"), res.stdout


def test_the_allow_list_stays_exact_and_keeps_timesyncd_and_chrony_configuration_protected() -> None:
    keys = [l.strip() for l in NTP_ALLOW.read_text().splitlines() if l.strip() and not l.startswith("#")]
    assert set(TS_KEYS) <= set(keys)
    assert not any("*" in k for k in keys), "exact keys only"
    assert not any(re.search(r"UnitFileState|time\.file\.", k) for k in keys), "UnitFileState and every config FILE key stay protected"


# ── D. static guards on the capture source ─────────────────────────────────────────────────────────────────────────────────────────────────────

def test_every_timesync_command_in_the_capture_is_behind_the_active_running_guard() -> None:
    code = "\n".join(l for l in CAPTURE.read_text().splitlines() if not l.lstrip().startswith("#"))
    guard = code.index('if [ "$timesyncd_running_now" = 1 ]; then')
    else_branch = code.index("\nelse\n", guard)
    assert [m.start() for m in re.finditer(r"show-timesync", code)] and all(guard < m.start() < else_branch for m in re.finditer(r"show-timesync", code))
    assert "ActiveState" in code[:guard] and "SubState" in code[:guard]
    # exactly three timedatectl invocations: the plain `show` (talks to timedated, never to timesyncd) and the two guarded show-timesync queries
    assert re.findall(r"run_ro \d \S+ timedatectl (\S+)", code) == ["show", "show-timesync", "show-timesync"]
    assert not re.search(r"timedatectl\s+(set-|timesync-status)", code)
