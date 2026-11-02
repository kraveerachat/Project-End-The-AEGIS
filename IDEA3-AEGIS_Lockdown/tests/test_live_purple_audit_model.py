"""The read-only audit model behind the Alerts panel and the Overview page."""

from __future__ import annotations

import ast
import sqlite3
from datetime import datetime
from pathlib import Path

import pytest

from tools import live_purple_audit_model as model

ROOT = Path(__file__).resolve().parents[1]
NOW = datetime(2026, 11, 1, 21, 30, 0, tzinfo=model.BANGKOK)
REMOTE_MEDIUM = ("source=beelink attacker_ip=192.168.10.10 kind=ssh_brute_force severity=MEDIUM score=40 action=SOFTWARE_BLOCK "
                 "corroborated=False reasons=ssh_brute_force+40 cert_sha256=abcd")
REMOTE_CRITICAL = ("source=beelink attacker_ip=192.168.10.10 kind=ssh_login_after_failures severity=CRITICAL score=140 action=AUTO_CUT "
                   "corroborated=True reasons=ssh_brute_force+40,ssh_login_after_failures+100 cert_sha256=abcd")
AWAITING = "source=beelink attacker_ip=192.168.10.10 target=DRYRUN"
LOCAL_CRITICAL = ("attacker_ip=10.90.90.4 kind=containment_failed severity=CRITICAL previous_severity=MEDIUM score=100 action=AUTO_CUT "
                  "corroborated=True reasons=ssh_brute_force+40,containment_failed+60 mitre=T1110")


def en(key, **_kwargs):
    return model.STRINGS[key]["en"]


def th(key, **_kwargs):
    return model.STRINGS[key]["th"]


def make_db(path, rows=(), *, incidents=()):
    connection = sqlite3.connect(path)
    connection.execute("CREATE TABLE audit_logs (id INTEGER PRIMARY KEY, timestamp TEXT, level TEXT, event_type TEXT, details TEXT, "
                       "incident_id INTEGER, hash TEXT)")
    connection.execute("CREATE TABLE incidents (id INTEGER PRIMARY KEY, opened_at TEXT, state TEXT, attacker_ip TEXT)")
    for stamp, level, kind, details in rows:
        connection.execute("INSERT INTO audit_logs (timestamp, level, event_type, details) VALUES (?, ?, ?, ?)",
                           (stamp, level, kind, details))
    for state in incidents:
        connection.execute("INSERT INTO incidents (opened_at, state) VALUES ('2026-11-01 10:00:00', ?)", (state,))
    connection.commit()
    connection.close()
    return path


def module_literals(relative):
    """Top-level literal assignments, read without importing: importing the real package would load its configuration."""
    tree = ast.parse((ROOT / relative).read_text(encoding="utf-8"))
    found = {}
    for node in tree.body:
        if isinstance(node, ast.Assign) and isinstance(node.targets[0], ast.Name):
            try:
                found[node.targets[0].id] = ast.literal_eval(node.value)
            except ValueError:
                pass
    return found


def test_the_mirrored_telegram_tables_and_strings_match_the_core():
    comms = module_literals("aegis_soc/comms.py")
    assert model.SEVERITY_ICON == comms["_SEVERITY_ICON"]
    assert model.ACTION_KEY == comms["_ACTION_KEY"]
    assert comms["_OUTCOME_KEY"][model.OUTCOME_RECOMMENDED] == "tg.outcome.recommended"
    core_strings = module_literals("aegis_soc/i18n.py")["STRINGS"]
    mirrored = {key: entry for key, entry in model.STRINGS.items() if key.startswith("tg.")}
    assert len(mirrored) >= 12
    for key, entry in mirrored.items():
        assert entry == core_strings[key], key


def test_the_mirrored_mitre_map_matches_the_core():
    source = (ROOT / "aegis_soc/graduated_response.py").read_text(encoding="utf-8")
    assert '    SSH_BRUTE_FORCE: "T1110",' in source and '    SSH_LOGIN_AFTER_FAILURES: "T1078",' in source
    assert '    PORT_SCAN: "T1046",' in source and '    SYN_FLOOD: "T1498",' in source and '    DISTRIBUTED_ATTACK: "T1498",' in source


def test_a_remote_critical_is_worded_as_telegram_words_it_never_as_an_automatic_cut():
    alerts = model.build_alerts([(11, "2026-11-01 21:27:18", model.AWAITING_KIND, AWAITING),
                                 (10, "2026-11-01 21:27:18", "GRADUATED_CRITICAL", REMOTE_CRITICAL)])
    assert len(alerts) == 1
    alert = alerts[0]
    assert (alert.level, alert.icon, alert.address, alert.score) == ("CRITICAL", "🔴", "192.168.10.10", "140")
    assert alert.evidence == ("ssh_brute_force+40", "ssh_login_after_failures+100", "source:beelink")
    assert alert.mitre == ("T1078", "T1110")
    assert alert.action == "RECOMMEND_CUT" and alert.outcome == "RECOMMENDED"
    assert alert.audit_record == "REMOTE_CUT_AWAITING target=DRYRUN"
    heading, lines = model.alert_lines(alert, th)
    assert heading == "🔴 ความรุนแรงระดับวิกฤต · CRITICAL"
    text = "\n".join(lines)
    assert "ผู้โจมตี: 192.168.10.10" in text and "คะแนนความเสี่ยง: 140" in text and "หลักฐาน: " in text
    assert "MITRE ATT&CK: T1078, T1110" in text and "รอผู้ดูแลตัดสินใจ" in text and "อัตโนมัติ" not in text


def test_a_remote_software_block_row_shows_no_response_because_the_core_blocked_nothing():
    alert = model.alert_view(1, "2026-11-01 20:10:23", "GRADUATED_MEDIUM", REMOTE_MEDIUM)
    assert alert.icon == "🟡" and alert.action == "" and alert.outcome == ""
    assert not any("Firewall" in line for line in model.alert_lines(alert, en)[1])


def test_a_local_auto_cut_says_its_result_is_not_recorded_instead_of_claiming_one():
    alert = model.alert_view(1, "2026-10-26 19:54:51", "GRADUATED_CRITICAL", LOCAL_CRITICAL)
    assert alert.action == "AUTO_CUT" and alert.mitre == ("T1110",)
    _heading, lines = model.alert_lines(alert, en)
    assert "Result: Not recorded in the audit log" in lines


def test_an_awaiting_row_attaches_only_to_its_own_source_and_address():
    other = REMOTE_CRITICAL.replace("192.168.10.10", "192.168.10.99")
    alerts = model.build_alerts([(3, "t", model.AWAITING_KIND, AWAITING), (2, "t", "GRADUATED_CRITICAL", other)])
    assert alerts[0].outcome == "" and alerts[0].audit_record == ""


@pytest.mark.parametrize("details", [None, "", "garbage", "attacker_ip=999x score=abc action=lower reasons=$(id)", 12])
def test_malformed_details_never_raise_and_show_no_invented_values(details):
    alert = model.alert_view(1, "not-a-time", "GRADUATED_LOW", details)
    assert alert.address == "" and alert.score == "" and alert.action == "" and alert.at == ""
    heading, lines = model.alert_lines(alert, en)
    assert heading == "⚪ Low severity · LOW" and "Attacker: —" in lines


def test_operator_free_text_never_reaches_the_activity_table():
    row = model.activity_row("2026-11-01 21:01:07", "CRITICAL", "COMMAND_SENT",
                             "RESTORE_UPLINK - authenticated local restore: secret words source=EVIL (origin=aegisctl)", today="2026-11-01")
    assert row.time == "21:01:07" and row.source == "AEGISCTL" and row.severity == "CRITICAL"
    assert "secret words" not in row.event and "EVIL" not in row.event + row.source


def test_an_older_activity_row_shows_its_date():
    row = model.activity_row("2026-10-26 19:54:51", "WARN", "GRADUATED_MEDIUM", REMOTE_MEDIUM, today="2026-11-01")
    assert row.time == "10-26 19:54" and row.source == "BEELINK"
    assert row.event == "GRADUATED_MEDIUM 192.168.10.10 score=40"


def test_the_snapshot_reads_alerts_activity_and_counts_newest_first(tmp_path):
    path = make_db(tmp_path / "audit.db", [
        ("2026-10-26 19:54:51", "CRITICAL", "GRADUATED_CRITICAL", LOCAL_CRITICAL),
        ("2026-11-01 20:10:23", "WARN", "GRADUATED_MEDIUM", REMOTE_MEDIUM),
        ("2026-11-01 21:00:00", "INFO", "DEVICE_STATUS", "PERIODIC"),
        ("2026-11-01 21:00:01", "INFO", "STATUS_AUTHENTICATED", "x"),
        ("2026-11-01 21:27:18", "CRITICAL", "GRADUATED_CRITICAL", REMOTE_CRITICAL),
        ("2026-11-01 21:27:18", "CRITICAL", model.AWAITING_KIND, AWAITING),
    ], incidents=("OPEN", "CONTAINED", "CLOSED"))
    shot = model.read_snapshot(path, now=NOW)
    assert shot.reason == ""
    assert [alert.at for alert in shot.alerts] == ["2026-11-01 21:27:18", "2026-11-01 20:10:23", "2026-10-26 19:54:51"]
    assert shot.alerts[0].outcome == "RECOMMENDED"
    assert shot.today == 2 and shot.last_24h == 2 and shot.highest_24h == "CRITICAL"
    assert shot.open_incidents == 2
    events = [row.event for row in shot.activity]
    assert events[0].startswith(model.AWAITING_KIND) and len(events) == 4
    assert not any("DEVICE_STATUS" in event or "STATUS_AUTHENTICATED" in event for event in events)


def test_today_uses_the_bangkok_date_not_the_last_24_hours(tmp_path):
    path = make_db(tmp_path / "audit.db", [("2026-10-31 23:59:59", "WARN", "GRADUATED_MEDIUM", REMOTE_MEDIUM)])
    shot = model.read_snapshot(path, now=NOW)
    assert shot.today == 0 and shot.last_24h == 1 and shot.highest_24h == "MEDIUM"


def test_the_limits_are_applied(tmp_path):
    path = make_db(tmp_path / "audit.db", [("2026-11-01 10:00:00", "WARN", "GRADUATED_MEDIUM", REMOTE_MEDIUM)] * 30)
    shot = model.read_snapshot(path, now=NOW)
    assert len(shot.alerts) == model.ALERT_LIMIT and len(shot.activity) == model.ACTIVITY_LIMIT and shot.today == 30


def test_an_empty_database_is_an_empty_state_not_a_failure(tmp_path):
    shot = model.read_snapshot(make_db(tmp_path / "audit.db"), now=NOW)
    assert shot.reason == "" and shot.alerts == () and shot.activity == ()
    assert shot.today == 0 and shot.open_incidents == 0 and shot.highest_24h == ""


def test_missing_and_unconfigured_databases_give_only_a_reason(tmp_path):
    for path in (None, tmp_path / "missing.db"):
        shot = model.read_snapshot(path, now=NOW)
        assert shot.reason and shot.today is None and shot.open_incidents is None and shot.alerts == ()


def test_a_file_that_is_not_a_database_gives_only_a_reason(tmp_path):
    path = tmp_path / "bad.db"
    path.write_bytes(b"this is not sqlite" * 100)
    shot = model.read_snapshot(path, now=NOW)
    assert shot.reason == model.records.UNREADABLE and shot.today is None


def test_a_locked_database_gives_a_reason_or_a_read_never_an_exception(tmp_path):
    path = make_db(tmp_path / "audit.db")
    holder = sqlite3.connect(path)
    holder.execute("BEGIN EXCLUSIVE")
    try:
        shot = model.read_snapshot(path, now=NOW)
    finally:
        holder.rollback()
        holder.close()
    assert shot.reason == model.records.UNREADABLE


def test_a_database_without_an_incidents_table_leaves_that_count_unavailable(tmp_path):
    path = tmp_path / "audit.db"
    connection = sqlite3.connect(path)
    connection.execute("CREATE TABLE audit_logs (id INTEGER PRIMARY KEY, timestamp TEXT, level TEXT, event_type TEXT, details TEXT)")
    connection.commit()
    connection.close()
    shot = model.read_snapshot(path, now=NOW)
    assert shot.reason == "" and shot.today == 0 and shot.open_incidents is None


def test_the_connection_cannot_write(tmp_path):
    path = make_db(tmp_path / "audit.db")
    connection, reason = model._connect(path)
    assert reason == ""
    with pytest.raises(sqlite3.OperationalError):
        connection.execute("INSERT INTO incidents (state) VALUES ('OPEN')")
    connection.close()


def test_the_panel_footer_says_notification_only():
    assert model.STRINGS["audit_alert.footer"]["th"] == "Telegram/หน้าต่างนี้ใช้แจ้งเตือนเท่านั้น สั่ง CUT และ RESTORE ได้ที่หน้าควบคุมเท่านั้น"


def test_every_string_has_three_languages():
    for key, entry in model.STRINGS.items():
        assert set(entry) == {"en", "th", "zh"}, key
