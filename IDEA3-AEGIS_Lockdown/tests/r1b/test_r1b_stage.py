"""R1B successor governed detector acceptance — repository-only hermetic tests.

R1B is a NEW stage after immutable R1A CLOSED_FAIL. These tests never touch
Production, never generate traffic, and never use the real governance directory.
"""

from __future__ import annotations

import json
import os
import shutil
import sqlite3
import subprocess
import time
from pathlib import Path

import pytest

from aegis_soc import r1_acceptance as r1
from aegis_soc import r1b_acceptance as r1b

ROOT = Path(__file__).resolve().parents[2]
P4 = ROOT / "deploy/pr11-phase4"
LIB = P4 / "p4-r1b-run-lib.sh"
P4_LIB = P4 / "p4-lib.sh"
RUNNER = P4 / "owner-run/run-r1b-owner.sh"
STG = P4 / "stages/R1B"
CLOCK = P4 / "p4-l5-clock.py"
SNAPSHOT = P4 / "r1b-acceptance/r1b_verifier_snapshot.py"
FREEZE = P4 / "r1b-acceptance/r1b_runner_freeze.py"

IP = "203.0.113.50"
OLD_IP = "198.51.100.9"
UID = 987
PID = "4321"
T0 = 1_800_000_000.0


def bash(script: str, *, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["bash", "-c", script],
        env={**os.environ, **(env or {})},
        text=True,
        capture_output=True,
        check=False,
    )


def stamp(epoch: float) -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(epoch))


def unit(pid: str, restarts: str = "0") -> dict[str, str]:
    return {
        "LoadState": "loaded",
        "ActiveState": "active",
        "SubState": "running",
        "MainPID": pid,
        "NRestarts": restarts,
        "Result": "success",
        "UnitFileState": "enabled",
        "Restart": "no",
    }


def make_db(path: Path, *, opens: int = 1) -> None:
    conn = sqlite3.connect(path)
    conn.executescript(
        """CREATE TABLE audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT, level TEXT, event_type TEXT,
           details TEXT, incident_id INTEGER, hash TEXT);
           CREATE TABLE incidents (id INTEGER PRIMARY KEY AUTOINCREMENT, opened_at TEXT, closed_at TEXT, state TEXT,
           attacker_ip TEXT, summary TEXT);"""
    )
    for i in range(opens):
        conn.execute(
            "INSERT INTO incidents (opened_at, state, attacker_ip) VALUES (?, 'OPEN', ?)",
            (stamp(T0 - 100 - i), OLD_IP if i == 0 else f"198.51.100.{10 + i}"),
        )
    conn.commit()
    conn.close()


def add_new_incident(path: Path, *, at: float = T0 + 8) -> int:
    conn = sqlite3.connect(path)
    cur = conn.execute(
        "INSERT INTO incidents (opened_at, state, attacker_ip) VALUES (?, 'OPEN', ?)",
        (stamp(at), IP),
    )
    iid = int(cur.lastrowid)
    conn.execute(
        "INSERT INTO audit_logs (timestamp, level, event_type, details, incident_id) "
        "VALUES (?, 'INFO', 'ALERT_ACCEPTED', ?, ?)",
        (stamp(at), f"uid={UID} pid={PID} attacker_ip={IP} action=CREATED", iid),
    )
    conn.execute(
        "INSERT INTO audit_logs (timestamp, level, event_type, details, incident_id) "
        "VALUES (?, 'WARN', 'INCIDENT_BOUND', ?, ?)",
        (stamp(at), f"attacker_ip={IP} source=detector_alert action=CREATED", iid),
    )
    conn.commit()
    conn.close()
    return iid


def net_event(at: float, port: str) -> dict:
    return {
        "kind": "net",
        "ip": IP,
        "dpt": port,
        "pid": "",
        "unit": "",
        "transport": "kernel",
        "exe": "",
        "at": at,
    }


def detector_line(at: float = T0 + 9) -> dict:
    return {
        "message": f"[F1-DETECTOR] alert result=SENT_BOUND detail=- ip={IP}",
        "pid": PID,
        "unit": r1.DETECTOR_UNIT,
        "at": at,
    }


def services() -> dict[str, dict[str, str]]:
    return {"core": unit("1111"), "detector": unit(PID)}


def baseline(path: Path) -> dict:
    return r1.capture_baseline(
        audit_db=str(path),
        release_id="rel-r1b",
        detector_sha256="a" * 64,
        detector_uid=UID,
        now=T0,
        services=services(),
        allowed_open_incidents=1,
    )


def test_r1b_is_registered_exactly_once_after_immutable_r1a() -> None:
    text = P4_LIB.read_text(encoding="utf-8")
    expected = 'readonly P4_STAGES="L0 L1 L2 L3 L4 L5 L6a L6b L6c L7 L7u L8p F1i F1r F1 F1u R1I R1A R1B L8 L9"'
    assert expected in text
    result = bash(f'. "{P4_LIB}"; p4_stage_handler_status R1B')
    assert result.returncode == 0 and result.stdout.strip() == "REGISTERED"
    for name in ("apply.sh", "verify.sh", "rollback.sh", "allow-keys.txt", "allow-listeners.txt"):
        assert (STG / name).is_file()
    assert text.count(" R1A R1B L8 ") == 1


def test_r1b_has_distinct_marker_names_and_only_preserves_r1a_state() -> None:
    text = LIB.read_text(encoding="utf-8")
    assert 'R1B_GLOBAL_MARKER_NAME="R1B-GLOBAL-ATTEMPT-CONSUMED"' in text
    assert 'R1B_WINDOW_RECORD_NAME="R1B-ATTEMPT-WINDOW"' in text
    assert "R1A-GLOBAL-ATTEMPT-CONSUMED" in text and "R1A-ATTEMPT-WINDOW" in text
    assert "r1b_r1a_preserved_gate()" in text
    code = "\n".join(
        line for line in text.splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    )
    for dangerous in (
        'rm "$dir/R1A-', "unlink", "truncate", "chattr -i", 'mv "$dir/R1A-',
    ):
        assert dangerous not in code


def test_preconsume_hook_is_fixed_before_marker_consumption(tmp_path: Path) -> None:
    auth = tmp_path / "auth"
    canon = tmp_path / "canon"
    auth.mkdir()
    canon.mkdir()
    log = tmp_path / "hooks"
    script = f'''
R1B_TEST_ONLY_CANONICAL_DIR_ENABLED=YES
R1B_TEST_ONLY_CANONICAL_DIR="{canon}"
PY="$(command -v python3)"
. "{LIB}"
SUDO=""
r1b_hook_pregates() {{ echo pregates >> "{log}"; }}
r1b_hook_baseline() {{ echo baseline >> "{log}"; }}
r1b_hook_preconsume() {{ echo preconsume >> "{log}"; return 1; }}
r1b_hook_regate() {{ echo regate >> "{log}"; }}
r1b_hook_observe() {{ echo observe >> "{log}"; }}
r1b_hook_final() {{ echo final >> "{log}"; }}
r1b_hook_verify() {{ echo verify >> "{log}"; }}
r1b_hook_preserve_evidence() {{ true; }}
r1b_run_attempt "{auth}" 1
'''
    done = bash(script)
    assert done.returncode != 0
    assert "R1B_PRE_ATTEMPT_FAILURE=preconsume R1B_ATTEMPT_CONSUMED=NO" in done.stdout
    assert log.read_text().splitlines() == ["pregates", "baseline", "preconsume"]
    assert not (canon / "R1B-GLOBAL-ATTEMPT-CONSUMED").exists()
    assert not (canon / "R1B-ATTEMPT-WINDOW").exists()


def test_clock_continuity_uses_monotonic_time_and_fails_a_wall_step() -> None:
    good = bash(f'PY="$(command -v python3)"; . "{LIB}"; r1b_clock_continuity_gate 100.0 50.0 280.0 230.0')
    assert good.returncode == 0 and "R1B_CLOCK_CONTINUITY=PASS" in good.stdout
    bad = bash(f'PY="$(command -v python3)"; . "{LIB}"; r1b_clock_continuity_gate 100.0 50.0 281.0 230.0')
    assert bad.returncode != 0 and "R1B_CLOCK_CONTINUITY=FAIL" in bad.stderr


def test_frozen_control_clock_helper_is_self_contained(tmp_path: Path) -> None:
    isolated = tmp_path / "isolated"
    isolated.mkdir()
    helper = isolated / "p4-l5-clock.py"
    shutil.copy2(CLOCK, helper)
    py = shutil.which("python3")
    assert py
    good = subprocess.run(
        [py, "-I", "-B", str(helper), "probe", "--fixture-probe", "synced:100"],
        text=True, capture_output=True, check=False,
    )
    assert good.returncode == 0 and "state=SYNCED reason=OK" in good.stdout
    bad = subprocess.run(
        [py, "-I", "-B", str(helper), "probe", "--fixture-probe", "unsynced:100"],
        text=True, capture_output=True, check=False,
    )
    assert bad.returncode == 1 and "state=UNTRUSTED reason=KERNEL_UNSYNCED" in bad.stdout


def test_r1b_snapshot_closure_contains_adapter_and_underlying_verifier() -> None:
    py = shutil.which("python3")
    done = subprocess.run([py, str(SNAPSHOT), "closure", str(ROOT)], text=True, capture_output=True, check=False)
    assert done.returncode == 0, done.stderr
    files = set(done.stdout.splitlines())
    assert "aegis_soc/r1b_acceptance.py" in files
    assert "aegis_soc/r1_acceptance.py" in files
    assert "aegis_soc/production_detector.py" in files
    assert "aegis_soc/recovery_evidence.py" in files


def test_r1a_baseline_default_still_refuses_a_preexisting_open_incident(tmp_path: Path) -> None:
    db = tmp_path / "audit.db"
    make_db(db, opens=1)
    with pytest.raises(r1.AcceptanceError) as exc:
        r1.capture_baseline(
            audit_db=str(db), release_id="r", detector_sha256="c" * 64,
            detector_uid=UID, now=T0, services=services(),
        )
    assert exc.value.code == "PREEXISTING_OPEN_INCIDENT"


@pytest.mark.parametrize("opens", [0, 2])
def test_r1b_baseline_requires_exactly_one_preserved_open_incident(tmp_path: Path, opens: int) -> None:
    db = tmp_path / "audit.db"
    make_db(db, opens=opens)
    with pytest.raises(r1.AcceptanceError) as exc:
        r1.capture_baseline(
            audit_db=str(db), release_id="r", detector_sha256="c" * 64,
            detector_uid=UID, now=T0, services=services(), allowed_open_incidents=1,
        )
    assert exc.value.code == "PREEXISTING_OPEN_INCIDENT"


def test_r1b_preconsume_passes_only_when_audit_and_preserved_incident_are_unchanged(tmp_path: Path) -> None:
    db = tmp_path / "audit.db"
    make_db(db, opens=1)
    b = baseline(db)
    bpath = tmp_path / "baseline.json"
    bpath.write_text(json.dumps(b), encoding="utf-8")
    result = r1b.preconsume(baseline_path=str(bpath), audit_db=str(db))
    assert result["result"] == "PASS" and result["open_incidents"] == 1

    conn = sqlite3.connect(db)
    conn.execute(
        "INSERT INTO audit_logs (timestamp, level, event_type, details, incident_id) "
        "VALUES (?, 'INFO', 'NOISE', 'x', NULL)",
        (stamp(T0),),
    )
    conn.commit()
    conn.close()
    with pytest.raises(r1.AcceptanceError) as exc:
        r1b.preconsume(baseline_path=str(bpath), audit_db=str(db))
    assert exc.value.code == "PRECONSUME_AUDIT_DRIFT"


def test_r1b_preconsume_refuses_preserved_incident_change(tmp_path: Path) -> None:
    db = tmp_path / "audit.db"
    make_db(db, opens=1)
    b = baseline(db)
    bpath = tmp_path / "baseline.json"
    bpath.write_text(json.dumps(b), encoding="utf-8")
    conn = sqlite3.connect(db)
    conn.execute("UPDATE incidents SET attacker_ip='198.51.100.77' WHERE id=1")
    conn.commit()
    conn.close()
    with pytest.raises(r1.AcceptanceError) as exc:
        r1b.preconsume(baseline_path=str(bpath), audit_db=str(db))
    assert exc.value.code == "PRESERVED_INCIDENT_CHANGED"


def test_r1b_can_verify_one_fresh_incident_while_preserving_the_r1a_incident(tmp_path: Path) -> None:
    db = tmp_path / "audit.db"
    make_db(db, opens=1)
    b = baseline(db)
    add_new_incident(db)
    source = [net_event(T0 + 4 + i * 0.5, str(40001 + i)) for i in range(10)]
    f = r1.capture_final(
        now=T0 + 60,
        services=services(),
        journal={"detector": [detector_line()], "source": source},
    )
    result = r1.verify(b, f, str(db))
    assert result["result"] == "PASS", result
    assert result["incident_id"] == 2 and result["attacker_ip"] == IP
    assert result["reconstructed_rules"] == ["port_scan"]
    conn = sqlite3.connect(db)
    old = conn.execute("SELECT state, attacker_ip FROM incidents WHERE id=1").fetchone()
    conn.close()
    assert old == ("OPEN", OLD_IP)


def test_r1b_final_refuses_any_change_to_preserved_r1a_incident(tmp_path: Path) -> None:
    db = tmp_path / "audit.db"
    make_db(db, opens=1)
    b = baseline(db)
    conn = sqlite3.connect(db)
    conn.execute("UPDATE incidents SET state='CLOSED', closed_at=? WHERE id=1", (stamp(T0 + 1),))
    conn.commit()
    conn.close()
    add_new_incident(db)
    source = [net_event(T0 + 4 + i * 0.5, str(40001 + i)) for i in range(10)]
    f = r1.capture_final(now=T0 + 60, services=services(), journal={"detector": [detector_line()], "source": source})
    assert r1.verify(b, f, str(db))["reason"] == "PRESERVED_INCIDENT_CHANGED"


def test_owner_runner_has_preconsume_stability_and_no_posthoc_listener_allowance() -> None:
    text = RUNNER.read_text(encoding="utf-8")
    pre = text.index("r1b_hook_preconsume()")
    regate = text.index("r1b_hook_regate()")
    assert pre < regate
    block = text[pre:regate]
    for needle in (
        "PRECONSUME_STABILITY_SECONDS", "clock_gate PRECONSUME_BEFORE_CAPTURE",
        'capture PRECONSUME "$PRECHECK"', 'compare "$PRE" "$PRECHECK"',
        "handler PRECONSUME", "r1b_r1a_preserved_gate", "clock_gate PRECONSUME_FINAL",
    ):
        assert needle in block
    assert (STG / "allow-listeners.txt").read_text(encoding="utf-8").strip().endswith("R1B creates no socket or network listener.")


def test_freeze_and_snapshot_tools_are_bound_to_r1b_authority() -> None:
    freeze = FREEZE.read_text(encoding="utf-8")
    snap = SNAPSHOT.read_text(encoding="utf-8")
    assert 'TEMPLATE_REL = "IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/owner-run/run-r1b-owner.sh"' in freeze
    assert 'ENTRY = "r1b_acceptance"' in snap
    assert 'MANIFEST_NAME = "R1B-VERIFIER-SHA256SUMS"' in snap
    assert 'CONTROL_MANIFEST_NAME = "R1B-CONTROL-SHA256SUMS"' in snap


def test_r1b_stage_gate_uses_no_unrelated_authorization_extras() -> None:
    text = (P4 / "p4-stage-gate.sh").read_text(encoding="utf-8")
    assert '[ "$STAGE" = R1B ]' in text
    assert "recovery_authorization is an L8-specific gate" in text
