"""R1Bv observer: hermetic tests (temp SQLite, plain-dict journal/services, temp marker files whose owner/trust seams are the test user; nothing live is touched). The positive fixture is a TEST CONSTRUCT that
proves the validator's logic, never a Production claim. The existing r1_acceptance verifier is reused unchanged; these tests prove the R1Bv layers around it: canonical-marker time authority, corroboration,
the strict (no grace) historical bound, the pinned expected source, the preserved baseline and the no-mutation fingerprint."""

from __future__ import annotations

import ast
import copy
import json
import os
import sqlite3
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import test_r1_acceptance as acc  # noqa: E402  (shared hermetic builders)

from aegis_soc import r1_acceptance as r1  # noqa: E402
from aegis_soc import r1bv_validation as v  # noqa: E402

UID = os.getuid()
L = acc.T0 + 1.358577404  # the canonical marker's modification time in the fixture
D = L + 600.0
SRC = acc.IP


class World:
    pass


def stamp_marker(path: Path, epoch: float) -> None:
    import calendar
    import time

    sec = int(epoch)
    path.write_text("consumed_at=" + time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(sec)) + "\n")
    os.utime(path, ns=(int(epoch * 1e9), int(epoch * 1e9)))
    assert calendar.timegm(time.gmtime(sec)) == sec


def build(tmp_path: Path, *, marker_epoch: float = L, incident_at: float = acc.T0 + 8, journal_at: float = acc.T0 + 9) -> World:
    world = World()
    world.tmp = tmp_path
    gov = tmp_path / "gov"
    gov.mkdir(mode=0o700, exist_ok=True)
    os.chmod(tmp_path, 0o700)
    world.marker = gov / "R1B-GLOBAL-ATTEMPT-CONSUMED"
    stamp_marker(world.marker, marker_epoch)
    os.chmod(world.marker, 0o600)
    world.local = tmp_path / "R1B-ATTEMPT-CONSUMED"
    world.local.write_text(f"consumed_at=2026-10-06T04:02:29Z\nconsumed_epoch={marker_epoch + 0.032}\n")
    world.log = tmp_path / "owner-run.log"
    world.log.write_text(f"R1B_APPLY=COMPLETE\nR1B_EVENT_WINDOW_OPEN=YES R1B_WINDOW_START_EPOCH={marker_epoch + 0.032}\nWAITING_FOR_GENUINE_EXTERNAL_EVENT=YES\n")
    world.db = str(tmp_path / "audit.db")
    acc.make_db(world.db)
    world.services = {"core": acc.unit("1111"), "detector": acc.unit(acc.PID)}
    world.baseline = r1.capture_baseline(audit_db=world.db, release_id="rel-1", detector_sha256="a" * 64, detector_uid=acc.UID, now=min(acc.T0, marker_epoch - 1.0), services=world.services)
    acc.add_incident(world.db, at=incident_at)
    world.journal = {"detector": [acc.journal_line(at=journal_at)], "source": acc.ssh_burst()}
    return world


@pytest.fixture
def w(tmp_path: Path) -> World:
    return build(tmp_path)


def bound(w: World, **kw):
    args = dict(local_marker=str(w.local), runner_log=str(w.log), owner_uid=UID, trust_root=str(w.tmp))
    args.update(kw)
    return v.derive_bound(str(kw.pop("marker", w.marker)) if "marker" in kw else str(w.marker), **{k: x for k, x in args.items() if k != "marker"})


def validate(w: World, *, journal=None, baseline=None, ip=SRC, services=None, b=None):
    b = b or bound(w)
    return v.validate(baseline=baseline or w.baseline, bound=b, audit_db=w.db, expected_source_ip=ip, services=lambda: services or copy.deepcopy(w.services),
                      journal=lambda since: copy.deepcopy(journal or w.journal))


def code(call) -> str:
    with pytest.raises(v.ValidationError) as caught:
        call()
    return caught.value.code


# ----------------------------------------------------------------------------- PASS and the bound model
def test_the_existing_chain_inside_the_derived_bound_passes_and_promotes_nothing(w: World) -> None:
    b = bound(w)
    assert b["lower"] == pytest.approx(L, abs=1e-6) and b["deadline"] == pytest.approx(L + 600.0, abs=1e-6) and b["observe_seconds"] == 600
    assert b["derivation"] == "CANONICAL_MARKER_MTIME_PLUS_PINNED_SECONDS_NO_GRACE"
    out = validate(w, b=b)
    assert out["attacker_ip"] == SRC and out["incident_id"] == 2 and set(out["checks"].values()) == {"PASS", "YES"}
    assert out["checks"]["R1BV_WINDOW_RECORD_ABSENT"] == "YES"
    assert v.CLAIMS["R1B_RESULT"] == "FAIL_IMMUTABLE" and v.CLAIMS["R1_VERIFIED"] == "NOT_CLAIMED" and v.CLAIMS["F1_REAL_DETECTOR_ACCEPTANCE"] == "NOT_PROVEN"


def test_the_deadline_is_exactly_the_pinned_600_seconds_with_no_grace(w: World) -> None:
    b = bound(w)
    assert b["deadline"] - b["lower"] == 600.0
    wide = dict(b, deadline=b["deadline"] + 1.0)
    assert code(lambda: validate(w, b=wide)) == "BOUND_WIDENED_OR_MALFORMED"
    assert code(lambda: bound(w, observe_seconds=601)) == "OBSERVE_SECONDS_NOT_THE_PINNED_VALUE"


# ----------------------------------------------------------------------------- canonical marker authority
def test_a_missing_canonical_marker_fails(w: World) -> None:
    w.marker.unlink()
    assert code(lambda: bound(w)) == "CANONICAL_MARKER_MISSING_OR_UNTRUSTED"


def test_a_wrong_owner_wrong_mode_symlink_or_hardlink_canonical_marker_fails(w: World) -> None:
    assert code(lambda: bound(w, owner_uid=UID + 1)) in ("CANONICAL_MARKER_ANCESTRY_NOT_TRUSTED", "CANONICAL_MARKER_MISSING_OR_UNTRUSTED")
    os.chmod(w.marker, 0o666)
    assert code(lambda: bound(w)) == "CANONICAL_MARKER_MISSING_OR_UNTRUSTED"
    os.chmod(w.marker, 0o600)
    link = w.marker.parent / "linked"
    os.link(w.marker, link)
    assert code(lambda: bound(w)) == "CANONICAL_MARKER_MISSING_OR_UNTRUSTED"  # a second hard link is not the sole canonical record
    link.unlink()
    target = w.marker.parent / "real"
    w.marker.rename(target)
    os.symlink(target, w.marker)
    assert code(lambda: bound(w)) == "CANONICAL_MARKER_MISSING_OR_UNTRUSTED"


def test_a_writable_or_untrusted_ancestor_fails(w: World) -> None:
    os.chmod(w.marker.parent, 0o770)
    assert code(lambda: bound(w)) == "CANONICAL_MARKER_ANCESTRY_NOT_TRUSTED"
    os.chmod(w.marker.parent, 0o700)
    assert code(lambda: bound(w, trust_root="/nonexistent-root")) == "CANONICAL_MARKER_ANCESTRY_NOT_TRUSTED"


def test_a_relative_or_noncanonical_marker_path_fails(w: World) -> None:
    assert code(lambda: v.derive_bound("relative/marker", local_marker=str(w.local), runner_log=str(w.log), owner_uid=UID, trust_root=str(w.tmp))) == "CANONICAL_MARKER_PATH_INVALID"
    assert code(lambda: v.derive_bound(str(w.marker.parent) + "/../gov/R1B-GLOBAL-ATTEMPT-CONSUMED", local_marker=str(w.local), runner_log=str(w.log), owner_uid=UID, trust_root=str(w.tmp))) == "CANONICAL_MARKER_PATH_INVALID"


@pytest.mark.parametrize("content", [b"", b"consumed_at=garbage\n", b"consumed_at=2026-10-06T04:02:29Z", b"consumed_at=2026-10-06T04:02:29Z\nextra=1\n"])
def test_malformed_canonical_marker_content_fails(w: World, content: bytes) -> None:
    w.marker.write_bytes(content)
    os.utime(w.marker, ns=(int(L * 1e9), int(L * 1e9)))
    assert code(lambda: bound(w)) == "CANONICAL_MARKER_CONTENT_MALFORMED"


def test_marker_content_that_disagrees_with_its_mtime_fails(w: World) -> None:
    w.marker.write_text("consumed_at=2001-01-01T00:00:00Z\n")
    os.utime(w.marker, ns=(int(L * 1e9), int(L * 1e9)))
    assert code(lambda: bound(w)) == "CANONICAL_MARKER_CONTENT_DISAGREES_WITH_MTIME"


# ----------------------------------------------------------------------------- local evidence is corroboration only
def test_the_operator_writable_local_marker_cannot_override_the_canonical_authority(w: World) -> None:
    w.local.write_text(f"consumed_at=x\nconsumed_epoch={L - 5000.0}\n")  # an operator forges an early start to widen the window
    assert code(lambda: bound(w)) == "TIMING_DISAGREES_WITH_CANONICAL_MARKER:local_marker_epoch"
    w.local.write_text(f"consumed_at=x\nconsumed_epoch={L + 5000.0}\n")
    assert code(lambda: bound(w)) == "TIMING_DISAGREES_WITH_CANONICAL_MARKER:local_marker_epoch"


def test_the_derived_bound_never_follows_the_local_or_runner_records(w: World) -> None:
    w.local.write_text(f"consumed_at=x\nconsumed_epoch={L + 1.5}\n")  # within tolerance: accepted as corroboration, but the bound is unchanged
    w.log.write_text(f"R1B_WINDOW_START_EPOCH={L - 1.5}\n")
    b = bound(w)
    assert b["lower"] == pytest.approx(L, abs=1e-6) and b["deadline"] == pytest.approx(L + 600.0, abs=1e-6)


@pytest.mark.parametrize("what", ["local_missing", "local_malformed", "log_missing", "log_ambiguous", "log_disagrees"])
def test_missing_malformed_or_disagreeing_corroboration_fails_closed(w: World, what: str) -> None:
    if what == "local_missing":
        w.local.unlink()
    elif what == "local_malformed":
        w.local.write_text("nonsense\n")
    elif what == "log_missing":
        w.log.unlink()
    elif what == "log_ambiguous":
        w.log.write_text(f"R1B_WINDOW_START_EPOCH={L}\nR1B_WINDOW_START_EPOCH={L}\n")
    else:
        w.log.write_text(f"R1B_WINDOW_START_EPOCH={L + 60.0}\n")
    assert code(lambda: bound(w)).split(":")[0] in ("LOCAL_MARKER_MISSING_OR_MALFORMED", "RUNNER_LOG_MISSING_OR_MALFORMED", "RUNNER_LOG_WINDOW_START_MISSING_OR_AMBIGUOUS", "TIMING_DISAGREES_WITH_CANONICAL_MARKER")


def test_the_local_marker_and_log_paths_are_required(w: World) -> None:
    assert code(lambda: v.derive_bound(str(w.marker), local_marker=None, runner_log=str(w.log), owner_uid=UID, trust_root=str(w.tmp))) == "LOCAL_MARKER_PATH_REQUIRED"
    assert code(lambda: v.derive_bound(str(w.marker), local_marker=str(w.local), runner_log=None, owner_uid=UID, trust_root=str(w.tmp))) == "RUNNER_LOG_PATH_REQUIRED"


# ----------------------------------------------------------------------------- the historical bound is strict
def test_an_event_before_the_marker_fails(tmp_path: Path) -> None:
    w = build(tmp_path, marker_epoch=acc.T0 + 30.0)  # the whole chain (T0+4..T0+9) precedes the marker
    assert code(lambda: validate(w)).startswith("R1_VERIFIER_REFUSED")


def test_an_event_after_the_derived_deadline_fails(tmp_path: Path) -> None:
    w = build(tmp_path, marker_epoch=acc.T0 - 700.0)  # deadline = T0 - 100: the whole chain is post-bound
    assert code(lambda: validate(w)).startswith("R1_VERIFIER_REFUSED")


def test_no_post_deadline_grace_the_verifier_skew_cannot_admit_a_late_detector_alert(tmp_path: Path) -> None:
    """The existing verifier tolerates 2 s of skew. The alert (T0+9) is 0.5 s AFTER the derived deadline; the unfiltered verifier would accept it, R1Bv must not (negative control)."""
    w = build(tmp_path, marker_epoch=acc.T0 + 8.5 - 600.0)
    b = bound(w)
    assert b["deadline"] == pytest.approx(acc.T0 + 8.5, abs=1e-6)
    skewed = r1.verify(dict(w.baseline, started_at=b["lower"]), r1.capture_final(now=b["deadline"], services=copy.deepcopy(w.services), journal=w.journal), w.db)
    assert skewed["result"] == "PASS"  # the existing skew WOULD admit it
    assert code(lambda: validate(w, b=b)).startswith("R1_VERIFIER_REFUSED")  # R1Bv's strict pre-filter does not


def test_an_audit_row_before_the_marker_second_fails_even_inside_the_verifier_skew(tmp_path: Path) -> None:
    w = build(tmp_path, marker_epoch=acc.T0 + 9.5, incident_at=acc.T0 + 8, journal_at=acc.T0 + 9.6)  # rows stored at T0+8, marker at T0+9.5 (floor T0+9)
    b = bound(w)
    assert r1.verify(dict(w.baseline, started_at=b["lower"]), r1.capture_final(now=b["deadline"], services=copy.deepcopy(w.services), journal=w.journal), w.db)["result"] == "PASS"
    assert code(lambda: validate(w, b=b)) == "AUDIT_ROW_OUTSIDE_THE_HISTORICAL_BOUND"


def test_a_source_event_before_the_marker_fails_even_inside_the_verifier_skew(tmp_path: Path) -> None:
    w = build(tmp_path, marker_epoch=acc.T0 + 9.5, incident_at=acc.T0 + 9, journal_at=acc.T0 + 9.6)  # rows at T0+9 are inside; the source burst completes at T0+8 (< marker)
    b = bound(w)
    assert code(lambda: validate(w, b=b)) == "SOURCE_EVENT_OUTSIDE_THE_HISTORICAL_BOUND"


def test_a_detector_line_outside_the_bound_is_not_admitted_by_skew(w: World) -> None:
    j = {"detector": [acc.journal_line(at=D + 1.0)], "source": acc.ssh_burst()}
    assert code(lambda: validate(w, journal=j)).startswith("R1_VERIFIER_REFUSED")


def test_a_source_mismatch_fails(w: World) -> None:
    assert code(lambda: validate(w, ip="203.0.113.77")) == "INCIDENT_SOURCE_IS_NOT_THE_PINNED_EXPECTED_SOURCE"


@pytest.mark.parametrize("ip", ["127.0.0.1", "0.0.0.0", "not-an-ip", "", "10.0.0.1/24"])
def test_a_non_external_or_malformed_expected_source_pin_is_refused(w: World, ip: str) -> None:
    assert code(lambda: validate(w, ip=ip)) == "EXPECTED_SOURCE_NOT_AN_EXTERNALLY_CAPABLE_IPV4"


def test_wrong_detector_provenance_fails(w: World) -> None:
    j = {"detector": [acc.journal_line(pid="999")], "source": acc.ssh_burst()}
    assert code(lambda: validate(w, journal=j)).startswith("R1_VERIFIER_REFUSED")
    assert code(lambda: validate(w, services={"core": acc.unit("1111"), "detector": acc.unit("999")})).startswith("R1_VERIFIER_REFUSED")


def test_forged_journal_text_without_a_trusted_source_fails(w: World) -> None:
    j = {"detector": [acc.journal_line()], "source": []}
    assert code(lambda: validate(w, journal=j)).startswith("R1_VERIFIER_REFUSED")
    forged = {"detector": [acc.journal_line()], "source": [acc.ssh_event(acc.T0 + 4 + i, transport="stdout") for i in range(5)]}
    assert code(lambda: validate(w, journal=forged)).startswith("R1_VERIFIER_REFUSED")


def test_existing_incident_semantics_instead_of_created_fails(w: World) -> None:
    conn = sqlite3.connect(w.db)
    conn.execute("UPDATE audit_logs SET details = REPLACE(details, 'action=CREATED', 'action=EXISTING') WHERE event_type = 'ALERT_ACCEPTED'")
    conn.commit()
    conn.close()
    assert code(lambda: validate(w)).startswith("R1_VERIFIER_REFUSED")


def test_a_second_or_unrelated_new_incident_fails(w: World) -> None:
    acc.add_incident(w.db, ip="198.51.100.77", at=acc.T0 + 20)
    assert code(lambda: validate(w)).startswith("R1_VERIFIER_REFUSED")


def test_a_closed_new_incident_fails(w: World) -> None:
    conn = sqlite3.connect(w.db)
    conn.execute("UPDATE incidents SET state='CLOSED' WHERE id=2")
    conn.commit()
    conn.close()
    assert code(lambda: validate(w)).startswith("R1_VERIFIER_REFUSED")


def test_audit_provenance_mismatch_fails(w: World) -> None:
    conn = sqlite3.connect(w.db)
    conn.execute("UPDATE audit_logs SET details = REPLACE(details, 'uid=987', 'uid=1') WHERE event_type = 'ALERT_ACCEPTED'")
    conn.commit()
    conn.close()
    assert code(lambda: validate(w)).startswith("R1_VERIFIER_REFUSED")


def test_core_or_detector_identity_change_since_the_baseline_fails(w: World) -> None:
    assert code(lambda: validate(w, services={"core": acc.unit("2222"), "detector": acc.unit(acc.PID)})).startswith("R1_VERIFIER_REFUSED")
    assert code(lambda: validate(w, services={"core": acc.unit("1111"), "detector": acc.unit(acc.PID, "1")})).startswith("R1_VERIFIER_REFUSED")


# ----------------------------------------------------------------------------- the preserved baseline
def write_baseline(w: World, doc) -> str:
    d = w.tmp / "r1b-work"
    d.mkdir(mode=0o700, exist_ok=True)
    p = d / "r1-baseline.json"
    p.write_text(json.dumps(doc))
    os.chmod(p, 0o600)
    return str(p)


def test_the_preserved_baseline_loads_only_when_trusted_present_and_consistent(w: World) -> None:
    b = bound(w)
    path = write_baseline(w, w.baseline)
    assert v.load_baseline(path, b, owner_uid=UID)["audit_max_id"] == w.baseline["audit_max_id"]
    assert code(lambda: v.load_baseline(str(w.tmp / "r1b-work" / "absent.json"), b, owner_uid=UID)) == "PRESERVED_BASELINE_MISSING_OR_UNTRUSTED"
    assert code(lambda: v.load_baseline(path, b, owner_uid=UID + 1)) == "PRESERVED_BASELINE_MISSING_OR_UNTRUSTED"
    os.chmod(Path(path).parent, 0o770)
    assert code(lambda: v.load_baseline(path, b, owner_uid=UID)) == "PRESERVED_BASELINE_MISSING_OR_UNTRUSTED"


@pytest.mark.parametrize("mutate,expected", [
    (lambda d: d.update(schema="x"), "PRESERVED_BASELINE_MALFORMED"),
    (lambda d: d.pop("audit_max_id"), "PRESERVED_BASELINE_MALFORMED"),
    (lambda d: d.update(started_at="now"), "PRESERVED_BASELINE_MALFORMED"),
    (lambda d: d.update(open_incidents=1), "PRESERVED_BASELINE_HAD_OPEN_INCIDENT"),
    (lambda d: d.update(started_at=d["started_at"] + 100000), "PRESERVED_BASELINE_NOT_THE_PRE_CONSUME_BASELINE"),
    (lambda d: d.update(started_at=d["started_at"] - 100000), "PRESERVED_BASELINE_NOT_THE_PRE_CONSUME_BASELINE"),
])
def test_a_malformed_or_inconsistent_preserved_baseline_fails(w: World, mutate, expected: str) -> None:
    doc = copy.deepcopy(w.baseline)
    mutate(doc)
    path = write_baseline(w, doc)
    assert code(lambda: v.load_baseline(path, bound(w), owner_uid=UID)) == expected


def test_a_non_json_preserved_baseline_fails(w: World) -> None:
    d = w.tmp / "r1b-work"
    d.mkdir(mode=0o700)
    (d / "r1-baseline.json").write_text("{not json")
    os.chmod(d / "r1-baseline.json", 0o600)
    assert code(lambda: v.load_baseline(str(d / "r1-baseline.json"), bound(w), owner_uid=UID)) == "PRESERVED_BASELINE_MALFORMED"


# ----------------------------------------------------------------------------- the window record and the no-mutation fingerprint
def test_the_window_record_must_stay_absent_and_is_never_created(w: World) -> None:
    assert v.window_record_absent(str(w.marker)) == "YES"
    assert not (w.marker.parent / v.WINDOW_RECORD_NAME).exists()  # validate/derive/fingerprint never created it
    validate(w)
    v.fingerprint(bound=bound(w), audit_db=w.db, services=lambda: copy.deepcopy(w.services))
    assert not (w.marker.parent / v.WINDOW_RECORD_NAME).exists()
    (w.marker.parent / v.WINDOW_RECORD_NAME).write_text("x")
    assert code(lambda: v.window_record_absent(str(w.marker))) == "R1B_WINDOW_RECORD_UNEXPECTEDLY_PRESENT"


def fp(w: World):
    return v.fingerprint(bound=bound(w), audit_db=w.db, services=lambda: copy.deepcopy(w.services))


def test_the_fingerprint_detects_any_mutation_between_the_two_validations(w: World) -> None:
    before = fp(w)
    v.compare_fingerprints(before, fp(w))
    conn = sqlite3.connect(w.db)
    conn.execute("INSERT INTO audit_logs (timestamp, level, event_type, details, incident_id) VALUES ('2030-01-01 00:00:00', 'INFO', 'X', 'x', NULL)")
    conn.commit()
    conn.close()
    assert code(lambda: v.compare_fingerprints(before, fp(w))) == "STATE_CHANGED_BETWEEN_VALIDATIONS:audit_max_id"
    before = fp(w)
    os.utime(w.marker, ns=(int((L + 1) * 1e9),) * 2)
    assert code(lambda: v.compare_fingerprints(before, v.fingerprint(bound=dict(bound(w), canonical_marker_mtime_ns=1), audit_db=w.db, services=lambda: copy.deepcopy(w.services)))) == "STATE_CHANGED_BETWEEN_VALIDATIONS:canonical_marker_mtime_ns"
    w.services["detector"] = acc.unit(acc.PID, "3")
    assert code(lambda: v.compare_fingerprints(before, fp(w))).startswith("STATE_CHANGED_BETWEEN_VALIDATIONS")


# ----------------------------------------------------------------------------- read-only by construction
def test_the_observer_has_no_socket_no_writer_no_marker_creation_and_no_network() -> None:
    src = Path(v.__file__).read_text()
    tree = ast.parse(src)
    imports = {n.names[0].name.split(".")[0] for n in ast.walk(tree) if isinstance(n, ast.Import)} | {n.module.split(".")[0] for n in ast.walk(tree) if isinstance(n, ast.ImportFrom) and n.module}
    assert not imports & {"socket", "subprocess", "shutil", "sqlite3", "http", "urllib", "requests", "ssl"}
    for forbidden in ("AF_UNIX", ".connect(", "INSERT", "UPDATE ", "DELETE", "DROP ", "CREATE TABLE", "unlink", "rename(", "chmod", "chown", "os.remove", "makedirs", "mkdir", "touch", "O_TRUNC", "R1B-GLOBAL-ATTEMPT-CONSUMED\", \"w", "alert.sock"):
        assert forbidden not in src, forbidden
    # the ONLY file the observer creates is its own exclusive 0600 result document (O_EXCL), never a marker or a window record
    assert src.count("O_CREAT") == 1 and "O_EXCL" in src
    assert "R1B-ATTEMPT-WINDOW" in src and "WINDOW_RECORD_NAME" in src and "def window_record_absent" in src
    assert "def create_window" not in src and "def write_window" not in src


def test_the_default_journal_read_is_bounded_by_the_deadline_and_is_the_fixed_readonly_argv(w: World, monkeypatch) -> None:
    seen = {}

    def fake_run(argv, **kwargs):
        seen["argv"] = list(argv)

        class Done:
            returncode = 0
            stdout = ""

        return Done()

    monkeypatch.setattr(r1.subprocess, "run", fake_run)
    b = bound(w)
    v._bounded_journal(b["deadline"])(b["lower"] - 20.0)
    argv = seen["argv"]
    assert argv[:2] == ["journalctl", "-o"] and "--no-pager" in argv and f"--until=@{int(b['deadline']) + 2}" in argv
    assert not any(x in argv for x in ("-f", "--follow", "--vacuum-time", "--rotate", "--flush", "--sync"))  # read-only, never a journal-maintenance verb
