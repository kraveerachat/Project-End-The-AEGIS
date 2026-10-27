"""Read-only Core records behind the control Desktop's Recovery, Incidents and Audit pages: bounded, fail-closed, no reason text."""

from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
import time

import pytest

from tools import live_purple_core_records as rec

NOW = 1_800_000_000.0


def view_document(**changes):
    document = {
        "v": 1, "updated_at": NOW, "uplink": "LOCKDOWN", "device": "ONLINE", "uplink_why": "UNCOMMANDED_AFTER_RESTORE",
        "last_command": {"action": "RESTORE_UPLINK", "acked": True, "confirmed": True, "timed_out": False},
        "restore_pending": False, "restore_pending_remaining_sec": None, "restore_command_pending": False,
        "lockout_remaining_sec": 0.0, "restore_served": True,
    }
    document.update(changes)
    return document


def write(path, document):
    path.write_text(json.dumps(document), encoding="utf-8")
    return path


# ---- read_json: every way a source can be unavailable has its own reason ----

def test_read_json_reasons(tmp_path):
    assert rec.read_json(None) == (None, "NOT_CONFIGURED")
    assert rec.read_json(tmp_path / "absent.json") == (None, "NOT_FOUND")
    assert rec.read_json(tmp_path) == (None, "NOT_A_REGULAR_FILE")
    link = tmp_path / "link.json"
    link.symlink_to(write(tmp_path / "real.json", {"a": 1}))
    assert rec.read_json(link) == (None, "NOT_A_REGULAR_FILE")
    (tmp_path / "big.json").write_text(" " * (rec.MAX_JSON_BYTES + 1), encoding="utf-8")
    assert rec.read_json(tmp_path / "big.json") == (None, "TOO_LARGE")
    (tmp_path / "bad.json").write_text("{not json", encoding="utf-8")
    assert rec.read_json(tmp_path / "bad.json") == (None, "MALFORMED")
    (tmp_path / "list.json").write_text("[1]", encoding="utf-8")
    assert rec.read_json(tmp_path / "list.json") == (None, "MALFORMED")
    denied = write(tmp_path / "denied.json", {"a": 1})
    denied.chmod(0)
    try:
        assert rec.read_json(denied) == (None, "PERMISSION_DENIED")
    finally:
        denied.chmod(0o600)
    assert rec.read_json(tmp_path / "real.json") == ({"a": 1}, "")


def test_file_reason_names_the_open_failure_or_malformed(tmp_path):
    assert rec.file_reason(tmp_path / "absent.json") == "NOT_FOUND"
    assert rec.file_reason(write(tmp_path / "ok.json", {"v": 2})) == "MALFORMED"


# ---- recovery-status.json ----

def test_a_valid_recovery_view_is_read_and_normalised(tmp_path):
    view, reason = rec.read_recovery_view(write(tmp_path / "r.json", view_document()), now=NOW + 5)
    assert reason == "" and view["uplink_why"] == "UNCOMMANDED_AFTER_RESTORE" and view["restore_served"] is True
    assert view["last_command"] == {"action": "RESTORE_UPLINK", "acked": True, "confirmed": True, "timed_out": False}
    assert set(view) == {"uplink", "device", "uplink_why", "last_command", "restore_pending", "restore_command_pending",
                         "restore_served", "restore_pending_remaining_sec", "lockout_remaining_sec"}


def test_a_stale_or_future_recovery_view_is_not_shown_as_fact(tmp_path):
    path = write(tmp_path / "r.json", view_document())
    assert rec.read_recovery_view(path, now=NOW + 60)[1] == ""          # exactly the limit: fresh
    assert rec.read_recovery_view(path, now=NOW + 60.1) == (None, "STALE")
    assert rec.read_recovery_view(path, now=NOW - 61) == (None, "STALE")


@pytest.mark.parametrize("changes", [
    {"v": 2}, {"uplink_why": "SOMETHING"}, {"updated_at": "x"}, {"updated_at": True}, {"restore_pending": "yes"},
    {"restore_served": 1}, {"lockout_remaining_sec": -1}, {"lockout_remaining_sec": float("nan")},
    {"lockout_remaining_sec": 10**9}, {"restore_pending_remaining_sec": -3}, {"restore_pending_remaining_sec": "7"},
    {"last_command": {"action": "REBOOT", "acked": True, "confirmed": True, "timed_out": False}},
    {"last_command": {"action": "CUT_UPLINK", "acked": 1, "confirmed": True, "timed_out": False}},
    {"last_command": "RESTORE_UPLINK"},
])
def test_a_malformed_recovery_view_is_refused(tmp_path, changes):
    assert rec.read_recovery_view(write(tmp_path / "r.json", view_document(**changes)), now=NOW) == (None, "MALFORMED")


def test_unknown_uplink_and_device_values_collapse_to_unknown(tmp_path):
    view, _ = rec.read_recovery_view(write(tmp_path / "r.json", view_document(uplink="WEIRD", device="x", extra="ignored")), now=NOW)
    assert (view["uplink"], view["device"]) == ("UNKNOWN", "UNKNOWN") and "extra" not in view


# ---- audit records ----

def make_audit(path, rows):
    connection = sqlite3.connect(path)
    connection.execute("CREATE TABLE audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT, level TEXT, event_type TEXT,"
                       " details TEXT, incident_id INTEGER, hash TEXT)")
    for stamp, kind, details in rows:
        connection.execute("INSERT INTO audit_logs (timestamp, level, event_type, details) VALUES (?,?,?,?)", (stamp, "INFO", kind, details))
    connection.commit()
    connection.close()
    return path


MSG = "ab" * 16
SECRET_REASON = "swordfish-reason-text"
ROWS = [
    ("2026-10-24 19:00:01", "STATUS_AUTHENTICATED", "device_id=x state=NORMAL"),                      # not a CUT/RESTORE kind
    ("2026-10-24 19:01:06", "RESTORE_REQUESTED", f"reason={SECRET_REASON} uid=1000 pid=11375 origin=core-local-console"),
    ("2026-10-24 19:01:06", "COMMAND_SENT", f"RESTORE_UPLINK - authenticated local restore: {SECRET_REASON}; uid=1000; pid=1 (origin=aegisctl-local) seq=16"),
    ("2026-10-24 19:01:06", "ACK_RECEIVED", "OK - seq 16"),
    ("2026-10-24 09:16:31", "RESTORE_REFUSED", "code=RESTORE_ALREADY_PENDING uid=1000 pid=2 detail=RESTORE is awaiting device status evidence"),
    ("2026-10-24 09:30:58", "CUT_PRE_DISPATCH", f"uid=1000 pid=3 msg_id={MSG} seq=12 reason={SECRET_REASON}"),
    ("2026-10-24 09:31:00", "RESTORE_AUTH_LOCKOUT", "uid=1000 pid=4"),
]


def test_audit_rows_carry_only_machine_fields_and_never_the_reason(tmp_path):
    rows, reason = rec.read_audit(make_audit(tmp_path / "audit.sqlite3", ROWS))
    assert reason == "" and [row["kind"] for row in rows] == [
        "RESTORE_AUTH_LOCKOUT", "CUT_PRE_DISPATCH", "RESTORE_REFUSED", "ACK_RECEIVED", "COMMAND_SENT", "RESTORE_REQUESTED"]   # newest first
    by_kind = {row["kind"]: row for row in rows}
    assert by_kind["RESTORE_REFUSED"]["code"] == "RESTORE_ALREADY_PENDING"
    assert by_kind["CUT_PRE_DISPATCH"]["ref"] == MSG
    assert (by_kind["COMMAND_SENT"]["code"], by_kind["COMMAND_SENT"]["ref"]) == ("RESTORE_UPLINK", "seq 16")
    assert (by_kind["ACK_RECEIVED"]["code"], by_kind["ACK_RECEIVED"]["ref"]) == ("OK", "seq 16")
    assert by_kind["RESTORE_REQUESTED"]["at"] == "2026-10-24 19:01:06"
    text = json.dumps(rows) + "".join(rec.audit_line(row) for row in rows)
    assert SECRET_REASON not in text and "uid=" not in text and "pid" not in text


def test_text_inside_a_reason_cannot_fake_a_field():
    spoof = "code=FAKE_OK seq=99 msg_id=" + "cd" * 16 + " seq=7"
    assert rec.parse_audit_details("COMMAND_SENT", f"CUT_UPLINK - local cut: {spoof}; uid=1; pid=2 (origin=x) seq=5") == ("CUT_UPLINK", "seq 5")
    assert rec.parse_audit_details("CUT_PRE_DISPATCH", f"uid=1 pid=2 msg_id={MSG} seq=3 reason={spoof}") == ("", MSG)
    assert rec.parse_audit_details("RESTORE_REFUSED", "uid=1 pid=2 code=FAKE detail=x") == ("", "")
    assert rec.parse_audit_details("RESTORE_REFUSED", "code=lowercase uid=1") == ("", "")
    assert rec.parse_audit_details("RESTORE_REQUESTED", f"reason={spoof} uid=1") == ("", "")
    assert rec.parse_audit_details("ACK_RECEIVED", "OK - seq 4; code=FAKE") == ("", "")
    assert rec.parse_audit_details("COMMAND_SENT", None) == ("", "")
    assert rec.parse_audit_details("COMMAND_SENT", "x" * 100_000) == ("", "")


def test_audit_reader_is_read_only_bounded_and_fixed_in_its_query(tmp_path):
    path = make_audit(tmp_path / "audit.sqlite3", ROWS * 20)
    before = hashlib.sha256(path.read_bytes()).hexdigest()
    rows, _ = rec.read_audit(path, limit=1000)
    assert len(rows) == 50                                                   # the hard bound
    assert len(rec.read_audit(path, rec.ATTEMPT_KINDS, 5)[0]) == 5
    assert {row["kind"] for row in rec.read_audit(path, rec.ATTEMPT_KINDS, 50)[0]} <= set(rec.ATTEMPT_KINDS)
    assert {row["kind"] for row in rec.read_audit(path, ("STATUS_AUTHENTICATED", "SYSTEM"), 50)[0]} == set()   # kinds are an allowlist
    assert hashlib.sha256(path.read_bytes()).hexdigest() == before and not list(tmp_path.glob("*-wal")) and not list(tmp_path.glob("*-journal"))


def test_audit_reader_reasons(tmp_path):
    assert rec.read_audit(None) == (None, "NOT_CONFIGURED")
    assert rec.read_audit(tmp_path / "absent.sqlite3") == (None, "NOT_FOUND")
    assert rec.read_audit(tmp_path) == (None, "NOT_A_REGULAR_FILE")
    denied = make_audit(tmp_path / "denied.sqlite3", ROWS)
    denied.chmod(0)
    try:
        assert rec.read_audit(denied) == (None, "PERMISSION_DENIED")
    finally:
        denied.chmod(0o600)
    (tmp_path / "garbage.sqlite3").write_bytes(b"this is not a database" * 50)
    assert rec.read_audit(tmp_path / "garbage.sqlite3") == (None, "UNREADABLE")
    other = sqlite3.connect(tmp_path / "other.sqlite3")
    other.execute("CREATE TABLE something_else (a)")
    other.commit()
    other.close()
    assert rec.read_audit(tmp_path / "other.sqlite3") == (None, "UNREADABLE")
    assert rec.read_audit(make_audit(tmp_path / "empty.sqlite3", [])) == ([], "")


def test_a_bad_timestamp_is_dropped_not_shown(tmp_path):
    rows, _ = rec.read_audit(make_audit(tmp_path / "a.sqlite3", [("not a time <script>", "RESTORE_AUTH_LOCKOUT", "uid=1")]))
    assert rows[0]["at"] == "" and "script" not in rec.audit_line(rows[0])


# ---- facts ----

EVIDENCE = {"uplink": "LOCKDOWN", "device": "ONLINE", "broker": "CONNECTED", "trusted_time": "SYNCED"}


def t(key, **kwargs):
    from tools.live_purple_control_desktop import SEVERITY_STRINGS

    entry = rec.RECORD_STRINGS.get(key) or SEVERITY_STRINGS[key]
    return entry["en"].format(**kwargs)


def make_view(tmp_path, **changes):
    value, reason = rec.read_recovery_view(write(tmp_path / "v.json", view_document(**changes)), now=NOW)
    assert reason == "", reason
    return value


def test_ready_when_every_check_is_met(tmp_path):
    assert rec.readiness_blockers(EVIDENCE, make_view(tmp_path), "FRESH") == []
    rows = dict((label, value) for label, value, _ in rec.recovery_facts(EVIDENCE, make_view(tmp_path), "", None, [], "", "FRESH", t))
    assert rows["Ready for a RESTORE"].startswith("READY")


def test_each_blocker_is_named_by_its_code(tmp_path):
    bad = {"uplink": "NORMAL", "device": "OFFLINE", "broker": "DISCONNECTED", "trusted_time": "UNTRUSTED"}
    blockers = rec.readiness_blockers(
        bad, make_view(tmp_path, restore_pending=True, restore_pending_remaining_sec=5.0, restore_command_pending=True,
                       lockout_remaining_sec=12.0, restore_served=False), "STALE")
    assert blockers == ["EVIDENCE_NOT_FRESH", "UPLINK_NOT_LOCKDOWN", "DEVICE_NOT_ONLINE", "BROKER_NOT_CONNECTED",
                        "TIME_NOT_TRUSTED", "RESTORE_NOT_SERVED", "COMMAND_AWAITING_ACK", "RESTORE_PENDING", "AUTH_LOCKED_OUT"]
    assert set(blockers) <= set(rec.BLOCKERS)
    assert rec.readiness_blockers(EVIDENCE, None, "FRESH") == ["VIEW_UNAVAILABLE"]


def test_recovery_facts_show_pending_seconds_and_lockout(tmp_path):
    rows = dict((label, value) for label, value, _ in rec.recovery_facts(
        EVIDENCE, make_view(tmp_path, restore_pending=True, restore_pending_remaining_sec=4.2, lockout_remaining_sec=9.1),
        "", None, [], "", "FRESH", t))
    assert "5 s" in rows["A RESTORE is pending"] and "10 s" in rows["RESTORE lockout"]
    assert rows["Why the uplink is in LOCKDOWN"].startswith("UNCOMMANDED_AFTER_RESTORE — ")


def test_an_unavailable_view_says_so_with_the_reason_and_claims_nothing(tmp_path):
    rows = rec.recovery_facts(EVIDENCE, None, "STALE", None, None, "PERMISSION_DENIED", "FRESH", t)
    values = {label: value for label, value, _ in rows}
    for label in ("Why the uplink is in LOCKDOWN", "A RESTORE is pending", "RESTORE lockout"):
        assert values[label] == "NOT_AVAILABLE — STALE"
    assert values["Last RESTORE attempts"] == "NOT_AVAILABLE — PERMISSION_DENIED"
    assert "NOT READY" in values["Ready for a RESTORE"] and "VIEW_UNAVAILABLE" in values["Ready for a RESTORE"]


def test_stale_evidence_is_the_first_row():
    rows = rec.recovery_facts(EVIDENCE, None, "STALE", None, [], "", "STALE", t)
    assert rows[0][0] == "Core evidence" and rows[0][1].startswith("STALE — ")


def test_graduated_row_and_header_facts():
    graduated = {"highest_level": "HIGH", "cut_recommended_for": "203.0.113.9", "auto_cut_latched": True, "decisions": [{}]}
    assert ("Graduated response", "HIGH — automatic CUT latched", "HIGH") in rec.recovery_facts(EVIDENCE, None, "", graduated, [], "", "FRESH", t)
    facts = rec.incident_facts(graduated, "", t)
    assert [label for label, _v, _l in facts] == ["Highest level", "Decisions recorded", "CUT recommended", "Automatic CUT"]
    assert "NOT_AVAILABLE — NOT_FOUND" in rec.incident_facts(None, "NOT_FOUND", t)[0][1]
    assert "NOT_AVAILABLE — PERMISSION_DENIED" in rec.audit_facts(None, "PERMISSION_DENIED", t)[0][1]
    assert rec.audit_facts([], "", t)[0][1].startswith("0 newest")


# ---- lockdown cause / blocked IPs / runbook ----

DECISION = {
    "at": NOW, "attacker_ip": "203.0.113.9", "kind": "ssh_login_after_failures", "level": "CRITICAL",
    "action": "AUTO_CUT", "outcome": "CUT_SENT", "score": 140,
    "reasons": ["ssh_brute_force+40", "ssh_login_after_failures+100"], "mitre": ["T1110"],
}
GRADUATED_LOCKDOWN = {"highest_level": "CRITICAL", "cut_recommended_for": None, "auto_cut_latched": True,
                      "decisions": [DECISION]}


def test_lockdown_cause_shows_no_active_lockdown_when_uplink_is_normal():
    rows = rec.lockdown_cause_facts({"uplink": "NORMAL"}, GRADUATED_LOCKDOWN, t)
    assert rows == [("Most recent decision (likely cause)", "no active lockdown", "LOW")]


def test_lockdown_cause_reads_the_most_recent_decision_when_locked_down():
    rows = dict((label, value) for label, value, _ in rec.lockdown_cause_facts(EVIDENCE, GRADUATED_LOCKDOWN, t))
    assert rows["Most recent decision (likely cause)"] == "203.0.113.9 — CRITICAL"
    assert rows["Reason tokens"] == "ssh_brute_force+40, ssh_login_after_failures+100"
    assert rows["MITRE ATT&CK"] == "T1110"
    assert rows["Action → outcome"] == "AUTO_CUT → CUT_SENT"
    assert rows["Time since lockdown"].endswith("ago")


def test_lockdown_cause_is_unknown_without_a_decision_timestamp():
    decision = dict(DECISION, at=None)
    graduated = dict(GRADUATED_LOCKDOWN, decisions=[decision])
    rows = dict((label, value) for label, value, _ in rec.lockdown_cause_facts(EVIDENCE, graduated, t))
    assert rows["Time since lockdown"] == "UNKNOWN — the causing decision has no timestamp"


def test_lockdown_cause_says_unavailable_without_a_graduated_projection():
    rows = rec.lockdown_cause_facts(EVIDENCE, None, t)
    assert rows == [("Most recent decision (likely cause)", "NOT_AVAILABLE — no Core projection", None)]


def test_elapsed_since_scales_from_seconds_to_hours():
    now = 10_000.0
    assert rec._elapsed_since(now - 30, now=now) == "30 s"
    assert rec._elapsed_since(now - 300, now=now) == "5 m"
    assert rec._elapsed_since(now - 7200, now=now) == "2 h"


def test_blocked_ip_facts_counts_and_says_none():
    assert rec.blocked_ip_facts([], t) == [("Active software blocks", "none", "LOW")]
    assert rec.blocked_ip_facts(["203.0.113.5", "203.0.113.6"], t) == [("Active software blocks", "2", "HIGH")]


def test_runbook_steps_are_eight_ordered_keys_and_the_pin2_step_is_present():
    assert len(rec.RUNBOOK_STEPS) == 8
    assert rec.RUNBOOK_STEPS[5] == "recovery.runbook.6"
    pin2 = rec.RECORD_STRINGS["recovery.runbook.6"]["en"]
    assert "PIN 2" in pin2 and "CABLE TESTER" in pin2 and "PHYSICALLY" in pin2


# ---- strings ----

def test_every_record_string_exists_in_three_languages_with_the_same_placeholders():
    for key, entry in rec.RECORD_STRINGS.items():
        assert set(entry) == {"en", "th", "zh"}, key
        placeholders = {lang: sorted(re.findall(r"\{(\w+)\}", entry[lang])) for lang in entry}
        assert placeholders["en"] == placeholders["th"] == placeholders["zh"], key
    thai, han = re.compile("[฀-๿]"), re.compile("[一-鿿]")
    for key in ("recovery.ready_yes", "recovery.hint", "recovery.pending_yes", "audit.view.count", "incidents.view.none"):
        assert thai.search(rec.RECORD_STRINGS[key]["th"]) and han.search(rec.RECORD_STRINGS[key]["zh"]), key
    for code in rec.UPLINK_WHY:
        assert f"recovery.why.{code}" in rec.RECORD_STRINGS


def test_registration_never_replaces_an_existing_key():
    table = {"recovery.ready": {"en": "mine"}}
    rec.register_record_strings(type("I", (), {"STRINGS": table}))
    assert table["recovery.ready"] == {"en": "mine"} and "recovery.hint" in table
