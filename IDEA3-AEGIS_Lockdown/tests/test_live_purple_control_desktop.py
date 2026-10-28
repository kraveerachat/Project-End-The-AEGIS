"""Purple Desktop with Core-authenticated CUT and RESTORE plus the read-only severity panel (no MQTT, no controller)."""

from __future__ import annotations

import json
import os
import re
import sqlite3
import sys
import time
import tkinter as tk
from types import SimpleNamespace

import pytest

from tools import live_purple_control_desktop as desktop
from tools import live_purple_observer as live

rc = desktop.restore_client


class FakeCutFlow:
    def __init__(self):
        cc = desktop.cut_desktop.client  # the path-loaded client: no aegis_soc import before the isolated GUI loads
        self.view = cc.View("IDLE", "No manual CUT in progress.", cc.INFO, True)
        self.busy = False
        self.submitted = []

    def submit(self, reason, secret):
        self.submitted.append((reason, secret))
        return self.view

    def poll(self):
        return self.view


class FakeRestoreFlow:
    def __init__(self):
        self.view = rc.View("IDLE", "No RESTORE in progress.", rc.INFO, True)
        self.busy = False
        self.submitted = []
        self.polls = 0

    def submit(self, reason, secret, confirmation):
        self.submitted.append((reason, secret, confirmation))
        self.view = rc.View("PUBLISHED", "RESTORE published by the Core.", rc.INFO, False, "cd" * 16)
        self.busy = True
        return self.view

    def poll(self):
        self.polls += 1
        self.view = rc.View("DEVICE_REPORTED_NORMAL", "Device reported NORMAL. Reconnection NOT proven.", rc.OK, True)
        self.busy = False
        return self.view


class FakePrompts:
    def __init__(self, reason="lab acceptance restore after CUT", confirmation=rc.CONFIRMATION, secret="restore-secret"):
        self.answers = {"reason": reason, "confirmation": confirmation, "secret": secret}
        self.asked = []
        self.notices = []

    def ask_restore_reason(self):
        self.asked.append("reason")
        return self.answers["reason"]

    def ask_restore_confirmation(self):
        self.asked.append("confirmation")
        return self.answers["confirmation"]

    def ask_restore_secret(self):
        self.asked.append("secret")
        return self.answers["secret"]

    def notify(self, title, text):
        self.notices.append((title, text))


def _widgets(widget, cls):
    found = []
    for child in widget.winfo_children():
        if child.winfo_class() == cls:
            found.append(child)
        found.extend(_widgets(child, cls))
    return found


def _clean_modules():
    for name in list(sys.modules):
        if name == "aegis_soc" or name.startswith("aegis_soc."):
            del sys.modules[name]
    sys.path[:] = [entry for entry in sys.path if entry != str(live.PYTHONUI_ROOT)]


def write_core_status(path, age_seconds, **changes):
    """A valid Core status document whose ``updated_at`` is ``age_seconds`` old (the real clock: the Desktop reads time.time())."""
    document = {
        "state": "RUNNING", "profile": "lab", "dry_run": False, "auto_contain": False, "broker": "CONNECTED", "device": "ONLINE",
        "uplink": "NORMAL", "armed": "ARMED", "dispatch": "DISABLED", "time_trust": "SYNCED",
        "updated_at": time.time() - age_seconds, "components": {"detector": "RUNNING"},
    }
    document.update(changes)
    path.write_text(json.dumps(document), encoding="utf-8")


@pytest.fixture
def app_factory(tmp_path, monkeypatch):
    made = []
    saved_modules = {name: module for name, module in sys.modules.items()
                     if name == "aegis_soc" or name.startswith("aegis_soc.")}
    saved_path = list(sys.path)

    def build(restore_flow, prompts, graduated=None, language="en", status_age=None, recovery=None, audit_db=None):
        monkeypatch.setenv("AEGIS_UI_LANGUAGE", language)  # read when the purple i18n module is imported; never persisted
        try:
            root = tk.Tk()
        except tk.TclError as error:
            pytest.skip(f"Tk display unavailable: {error}")
        root.withdraw()
        _clean_modules()
        made.append(root)
        graduated_path = tmp_path / "graduated-status.json"
        if graduated is not None:
            graduated_path.write_text(json.dumps(graduated), encoding="utf-8")
        status_path = tmp_path / "missing-status.json"
        if status_age is not None:
            status_path = tmp_path / "status.json"
            write_core_status(status_path, status_age)
        app, _fakes = desktop.create_control_app(
            root, cut_flow=FakeCutFlow(), restore_flow=restore_flow, prompts=prompts,
            run_async=lambda function, *args: function(*args), status_path=status_path,
            graduated_path=graduated_path, recovery_path=recovery, audit_path=audit_db,
        )
        app.session.login("test-admin")
        app._on_authenticated()
        app._show_page("lockdown")
        root.update()
        return app, root

    yield build
    for root in made:
        try:
            for after_id in root.tk.splitlist(root.tk.call("after", "info")):
                root.after_cancel(after_id)
            root.destroy()
        except tk.TclError:
            pass
    _clean_modules()
    sys.modules.update(saved_modules)
    sys.path[:] = saved_path


def _restore_button(root):
    return next((b for b in _widgets(root, "Button") if b.cget("text") == desktop.RESTORE_BUTTON_TEXT), None)


def _texts(root):
    return [w.cget("text") for w in _widgets(root, "Label")]


def test_restore_is_wired_and_enabled_when_configured(app_factory):
    _app, root = app_factory(FakeRestoreFlow(), FakePrompts())
    button = _restore_button(root)
    assert button is not None and str(button.cget("state")) == "normal"
    assert not any(b.cget("text") == desktop.RESTORE_DISABLED_TEXT for b in _widgets(root, "Button"))


def test_restore_stays_disabled_without_a_restore_channel(app_factory):
    _app, root = app_factory(None, FakePrompts())
    assert _restore_button(root) is None
    assert any(b.cget("text") == desktop.RESTORE_DISABLED_TEXT for b in _widgets(root, "Button"))


def test_a_restore_carries_reason_confirmation_and_secret_to_the_core_flow_and_reports_evidence(app_factory):
    flow, prompts = FakeRestoreFlow(), FakePrompts()
    app, root = app_factory(flow, prompts)
    app._on_restore_pressed()
    assert prompts.asked == ["reason", "confirmation", "secret"]
    assert flow.submitted == [("lab acceptance restore after CUT", "restore-secret", rc.CONFIRMATION)]
    for _ in range(30):
        root.update()
        if flow.polls:
            break
        root.after(100)
    app._restore_poll_worker()
    root.update()
    assert prompts.notices and prompts.notices[-1][0] == "RESTORE"
    assert "DEVICE_REPORTED_NORMAL" in prompts.notices[-1][1]


@pytest.mark.parametrize("answers, note", [
    ({"confirmation": "restore uplink"}, "Confirmation did not match"),
    ({"secret": ""}, "secret is required"),
])
def test_a_wrong_confirmation_or_missing_secret_sends_nothing(app_factory, answers, note):
    flow, prompts = FakeRestoreFlow(), FakePrompts(**answers)
    app, _root = app_factory(flow, prompts)
    app._on_restore_pressed()
    assert flow.submitted == []
    assert note in prompts.notices[-1][1]


def test_a_cancelled_reason_sends_nothing_and_says_nothing(app_factory):
    flow, prompts = FakeRestoreFlow(), FakePrompts(reason=None)
    app, _root = app_factory(flow, prompts)
    app._on_restore_pressed()
    assert flow.submitted == [] and prompts.notices == []


def test_the_severity_panel_shows_the_core_projection(app_factory):
    graduated = {
        "v": 1, "highest_level": "CRITICAL", "cut_recommended_for": "203.0.113.7", "auto_cut_latched": True,
        "decisions": [
            {"at": 1, "attacker_ip": "203.0.113.7", "kind": "port_scan", "level": "MEDIUM", "action": "SOFTWARE_BLOCK",
             "outcome": "BLOCKED", "score": 30, "reasons": ["port_scan+30"], "mitre": ["T1046"]},
            {"at": 2, "attacker_ip": "203.0.113.7", "kind": "ssh_login_after_failures", "level": "CRITICAL",
             "action": "AUTO_CUT", "outcome": "CUT_SENT", "score": 140, "reasons": [], "mitre": ["T1078", "T1110"]},
        ],
    }
    _app, root = app_factory(FakeRestoreFlow(), FakePrompts(), graduated)
    texts = " | ".join(_texts(root))
    assert desktop.SEVERITY_TITLE in texts
    assert "CRITICAL" in texts and "203.0.113.7" in texts
    assert "AUTO_CUT → CUT_SENT" in texts and "T1046" in texts
    assert "EXECUTED this episode" in texts


def test_the_severity_panel_says_not_available_without_a_projection(app_factory):
    _app, root = app_factory(FakeRestoreFlow(), FakePrompts())
    assert any("NOT_AVAILABLE — no Core projection" in t for t in _texts(root))


GRADUATED_SAMPLE = {
    "v": 1, "highest_level": "CRITICAL", "cut_recommended_for": "203.0.113.7", "auto_cut_latched": True,
    "decisions": [
        {"at": 2, "attacker_ip": "203.0.113.7", "kind": "ssh_login_after_failures", "level": "CRITICAL",
         "action": "AUTO_CUT", "outcome": "CUT_SENT", "score": 140, "reasons": [], "mitre": ["T1078", "T1110"]},
    ],
}


@pytest.mark.parametrize("language,title,label,prose", [
    ("th", "ระดับความรุนแรงของภัยคุกคาม", "ระดับสูงสุด", "ตัดสินใจด้วยปุ่ม CUT"),
    ("zh", "威胁严重程度", "最高级别", "请使用 CUT 按钮决定"),
])
def test_the_severity_panel_follows_the_selected_language_and_keeps_the_codes(app_factory, language, title, label, prose):
    _app, root = app_factory(FakeRestoreFlow(), FakePrompts(), GRADUATED_SAMPLE, language=language)
    texts = " | ".join(_texts(root))
    assert title in texts and label in texts and prose in texts
    assert "THREAT SEVERITY" not in texts and "Highest level" not in texts and "decide with the CUT button" not in texts
    # codes stay as the Core sent them
    assert "CRITICAL" in texts and "203.0.113.7" in texts and "AUTO_CUT → CUT_SENT" in texts and "T1078" in texts and "T1110" in texts
    assert "EXECUTED" in texts


@pytest.mark.parametrize("language,phrase", [("th", "ไม่มีข้อมูลสรุปจาก Core"), ("zh", "Core 未提供数据")])
def test_the_not_available_panel_is_translated_but_keeps_its_code(app_factory, language, phrase):
    _app, root = app_factory(FakeRestoreFlow(), FakePrompts(), language=language)
    assert any("NOT_AVAILABLE" in t and phrase in t for t in _texts(root))


def test_a_language_change_rebuilds_the_severity_panel_in_the_new_language(app_factory):
    app, root = app_factory(FakeRestoreFlow(), FakePrompts(), GRADUATED_SAMPLE, language="en")
    assert "Highest level" in " | ".join(_texts(root))
    i18n = sys.modules["aegis_soc.i18n"]
    for code, label in (("th", "ระดับสูงสุด"), ("zh", "最高级别"), ("en", "Highest level")):
        i18n._state["language"] = code  # what the selector sets; the persisted preference file is not written by the test
        app._rebuild_ui()
        app._show_page("lockdown")
        root.update()
        texts = " | ".join(_texts(root))
        assert label in texts and "CRITICAL" in texts, code


# --------------------------------------------------------------------------- pure helpers (no display)


def test_read_graduated_refuses_symlinks_oversize_and_bad_schema(tmp_path):
    good = tmp_path / "g.json"
    good.write_text(json.dumps({"v": 1, "decisions": [{"level": "HIGH", "attacker_ip": "203.0.113.9"}]}))
    assert desktop.read_graduated(good)["decisions"][0]["level"] == "HIGH"
    link = tmp_path / "link.json"
    os.symlink(good, link)
    assert desktop.read_graduated(link) is None
    big = tmp_path / "big.json"
    big.write_text(" " * (desktop.GRADUATED_MAX_BYTES + 1))
    assert desktop.read_graduated(big) is None
    bad = tmp_path / "bad.json"
    bad.write_text(json.dumps({"v": 2, "decisions": []}))
    assert desktop.read_graduated(bad) is None
    assert desktop.read_graduated(tmp_path / "missing.json") is None
    odd = tmp_path / "odd.json"
    odd.write_text(json.dumps({"v": 1, "decisions": [{"level": "PANIC"}, "x", {"level": "LOW", "score": "9"}]}))
    assert [d["level"] for d in desktop.read_graduated(odd)["decisions"]] == ["LOW"]


def test_restore_needs_both_explicit_settings():
    assert desktop.restore_configuration({}) is None
    assert desktop.restore_configuration({desktop.RESTORE_ENABLE_ENV: "YES", desktop.RESTORE_SOCKET_ENV: "rel.sock"}) is None
    assert desktop.restore_configuration({desktop.RESTORE_ENABLE_ENV: "yes", desktop.RESTORE_SOCKET_ENV: "/run/x.sock"}) is None
    assert desktop.restore_configuration({desktop.RESTORE_ENABLE_ENV: "YES", desktop.RESTORE_SOCKET_ENV: "/run/x.sock"}) == "/run/x.sock"


def test_the_desktop_module_imports_no_aegis_soc_package():
    import ast
    import inspect

    tree = ast.parse(inspect.getsource(desktop))
    top = tree.body  # module-level imports only: the isolated purple GUI is imported later, by design
    modules = {node.module for node in top if isinstance(node, ast.ImportFrom)}
    modules |= {alias.name for node in top if isinstance(node, ast.Import) for alias in node.names}
    assert not any(str(name).startswith("aegis_soc") for name in modules)


# --------------------------------------------------------------------------- STALE evidence when the Core stops updating (needs a display)
# Lab test A1 froze the Core (SIGSTOP): status.json stops being rewritten while the clock keeps running. The Desktop calls the evidence STALE
# once it is more than live.DESKTOP_MAX_AGE_SECONDS (60 s, the dead-man window) old, and polls every live.EVIDENCE_POLL_MS (2000 ms).

GRADUATED_FOR_STALE = {
    "v": 1, "updated_at": 1, "highest_level": "HIGH", "cut_recommended_for": "203.0.113.7", "auto_cut_latched": False,
    "decisions": [{"at": 1, "attacker_ip": "203.0.113.7", "kind": "ssh_brute_force", "level": "HIGH", "action": "RECOMMEND_CUT",
                   "outcome": "RECOMMENDED", "score": 70, "reasons": [], "mitre": ["T1110"]}],
}


def _poll(app, root):
    app._poll_evidence()
    root.update()


def test_the_overview_marks_evidence_freshness_stale_when_status_json_stops_updating(app_factory):
    app, root = app_factory(FakeRestoreFlow(), FakePrompts(), status_age=5)
    app._show_page("overview")
    root.update()
    assert app.latest.valid and app.latest.freshness == "FRESH"
    assert "FRESH" in _texts(root) and "STALE" not in _texts(root)

    write_core_status(app._status_path, 65)  # the Core froze: the same file, now older than the threshold
    _poll(app, root)
    assert not app.latest.valid and app.latest.freshness == "STALE"
    assert "STALE" in _texts(root) and "FRESH" not in _texts(root)

    write_core_status(app._status_path, 1)  # the Core resumed
    _poll(app, root)
    assert app.latest.valid and "FRESH" in _texts(root) and "STALE" not in _texts(root)


def test_the_stale_threshold_is_the_60_second_deadman_window_and_the_poll_is_2_seconds():
    from aegis_soc import config
    assert live.DESKTOP_MAX_AGE_SECONDS == 60.0 == float(config.DEADMAN_TIMEOUT_SEC)
    assert live.EVIDENCE_POLL_MS == 2000
    assert desktop.create_control_app.__kwdefaults__["max_age_seconds"] == live.DESKTOP_MAX_AGE_SECONDS
    assert live.create_live_app.__kwdefaults__["max_age_seconds"] == live.DESKTOP_MAX_AGE_SECONDS


def test_the_sidecar_freshness_default_is_not_changed_by_the_desktop_threshold():
    assert live.reader.DEFAULT_MAX_AGE_SECONDS == 120.0   # status sidecar and push client keep their own rule


@pytest.mark.parametrize("page,shown", [("lockdown", ["NORMAL"]), ("devices", ["NORMAL", "ONLINE", "CONNECTED"])])
def test_a_page_that_is_open_when_the_core_stops_updating_does_not_keep_showing_the_last_state(app_factory, page, shown):
    app, root = app_factory(FakeRestoreFlow(), FakePrompts(), status_age=5)
    app._show_page(page)
    root.update()
    assert all(value in _texts(root) for value in shown) and "STALE" not in _texts(root)

    write_core_status(app._status_path, 125)
    _poll(app, root)
    texts = _texts(root)
    assert not [value for value in shown if value in texts], "the last reported state must not stay on screen as if it were current"
    assert "UNKNOWN" in texts


def test_an_open_page_is_rebuilt_only_when_the_evidence_it_shows_changes(app_factory, monkeypatch):
    app, root = app_factory(FakeRestoreFlow(), FakePrompts(), status_age=5)
    app._show_page("lockdown")
    root.update()
    shown = []
    original = app._show_page
    monkeypatch.setattr(app, "_show_page", lambda key: (shown.append(key), original(key))[1])
    for age in (4, 3, 2):  # a live Core rewrites status.json with a newer timestamp: nothing visible changes
        write_core_status(app._status_path, age)
        _poll(app, root)
    assert shown == []
    write_core_status(app._status_path, 3, uplink="LOCKDOWN")
    _poll(app, root)
    assert shown == ["lockdown"]


def test_the_severity_panel_marks_graduated_status_stale_when_status_json_stops_updating(app_factory):
    app, root = app_factory(FakeRestoreFlow(), FakePrompts(), GRADUATED_FOR_STALE, status_age=5)
    assert "STALE" not in " | ".join(_texts(root))
    assert "HIGH" in " | ".join(_texts(root)) and "203.0.113.7" in " | ".join(_texts(root))

    write_core_status(app._status_path, 125)
    _poll(app, root)
    app._tick_severity()
    root.update()
    texts = " | ".join(_texts(root))
    assert "Core evidence" in texts and "STALE — the Core is not updating" in texts
    assert "HIGH" in texts and "203.0.113.7" in texts, "the last known decisions stay visible, clearly marked"

    write_core_status(app._status_path, 1)
    _poll(app, root)
    app._tick_severity()
    root.update()
    assert "STALE" not in " | ".join(_texts(root))


@pytest.mark.parametrize("language,phrase", [("th", "Core ไม่ได้อัปเดต"), ("zh", "Core 未更新")])
def test_the_stale_marker_follows_the_language_and_keeps_the_code(app_factory, language, phrase):
    _app, root = app_factory(FakeRestoreFlow(), FakePrompts(), GRADUATED_FOR_STALE, language=language, status_age=125)
    texts = " | ".join(_texts(root))
    assert phrase in texts and "STALE" in texts


def test_a_missing_status_file_is_also_flagged_on_the_severity_panel(app_factory):
    _app, root = app_factory(FakeRestoreFlow(), FakePrompts(), GRADUATED_FOR_STALE)  # no status.json at all
    assert "MISSING — the Core is not updating" in " | ".join(_texts(root))


# --------------------------------------------------------------------------- severity panel strings (no display)

THAI = re.compile(r"[\u0E00-\u0E7F]")
HAN = re.compile(r"[\u4E00-\u9FFF]")
PLACEHOLDER = re.compile(r"\{(\w+)\}")
DATA = {"highest_level": "CRITICAL", "cut_recommended_for": "203.0.113.7", "auto_cut_latched": True, "decisions": []}


def _translator(language):
    def translate(key, **kwargs):
        text = desktop.SEVERITY_STRINGS[key][language]
        return text.format(**kwargs) if kwargs else text

    return translate


def test_every_severity_string_exists_in_th_en_and_zh_with_the_same_placeholders():
    assert desktop.SEVERITY_STRINGS
    for key, entry in desktop.SEVERITY_STRINGS.items():
        assert set(entry) == {"en", "th", "zh"}, key
        assert all(isinstance(text, str) and text.strip() for text in entry.values()), key
        assert len({tuple(sorted(PLACEHOLDER.findall(text))) for text in entry.values()}) == 1, key


def test_the_thai_and_chinese_strings_are_really_translated():
    for key, entry in desktop.SEVERITY_STRINGS.items():
        assert THAI.search(entry["th"]) and not THAI.search(entry["en"]) and not THAI.search(entry["zh"]), key
        assert HAN.search(entry["zh"]) and not HAN.search(entry["en"]) and not HAN.search(entry["th"]), key


def test_the_english_strings_keep_their_original_wording():
    strings = desktop.SEVERITY_STRINGS
    assert strings["severity.title"]["en"] == desktop.SEVERITY_TITLE
    assert strings["severity.unavailable"]["en"] == "NOT_AVAILABLE — no Core projection"
    assert strings["severity.auto_cut_value"]["en"].startswith("EXECUTED this episode")
    assert strings["severity.highest"]["en"] == "Highest level" and strings["severity.cut_recommended"]["en"] == "CUT recommended"


def test_registration_adds_the_keys_and_never_replaces_an_existing_one():
    fake = SimpleNamespace(STRINGS={"severity.title": {"en": "kept", "th": "kept", "zh": "kept"}})
    desktop.register_severity_strings(fake)
    assert fake.STRINGS["severity.title"] == {"en": "kept", "th": "kept", "zh": "kept"}
    assert set(desktop.SEVERITY_STRINGS) <= set(fake.STRINGS)
    fake.STRINGS["severity.highest"]["en"] = "changed"
    assert desktop.SEVERITY_STRINGS["severity.highest"]["en"] == "Highest level", "the registered entry is a copy"


@pytest.mark.parametrize("language", ["en", "th", "zh"])
def test_severity_facts_translate_the_prose_and_keep_every_code(language):
    rows = desktop.severity_facts(DATA, _translator(language))
    assert [row[2] for row in rows] == ["CRITICAL", "HIGH", "CRITICAL"], "colour levels do not depend on the language"
    assert rows[0][1] == "CRITICAL", "the level code is copied, not translated"
    assert "203.0.113.7" in rows[1][1] and "CUT" in rows[1][0] and "CUT" in rows[1][1]
    assert "EXECUTED" in rows[2][1] and "RESTORE" in rows[2][1] and "CUT" in rows[2][0]
    if language != "en":
        english = desktop.severity_facts(DATA, _translator("en"))
        assert all(row[0] != base[0] for row, base in zip(rows, english))


@pytest.mark.parametrize("language", ["en", "th", "zh"])
def test_severity_facts_without_a_projection_keep_the_not_available_code(language):
    (label, value, level), = desktop.severity_facts(None, _translator(language))
    assert "NOT_AVAILABLE" in value and level is None and label


def test_optional_rows_only_appear_when_the_core_projection_has_them():
    quiet = {"highest_level": "LOW", "cut_recommended_for": None, "auto_cut_latched": False, "decisions": []}
    assert [row[2] for row in desktop.severity_facts(quiet, _translator("th"))] == ["LOW"]


def test_decision_lines_are_codes_only_and_do_not_depend_on_the_language():
    item = {"at": None, "attacker_ip": "203.0.113.7", "kind": "port_scan", "level": "MEDIUM", "action": "SOFTWARE_BLOCK",
            "outcome": "BLOCKED", "score": 30, "reasons": [], "mitre": ["T1046"]}
    line = desktop.describe_decision(item)
    assert all(code in line for code in ("MEDIUM", "203.0.113.7", "port_scan", "SOFTWARE_BLOCK", "BLOCKED", "T1046"))
    assert not THAI.search(line) and not HAN.search(line)


# --------------------------------------------------------------------------- STALE thresholds (no display)


def _status_file(tmp_path, updated_at):
    path = tmp_path / "status.json"
    document = {
        "state": "RUNNING", "profile": "lab", "dry_run": False, "auto_contain": False, "broker": "CONNECTED", "device": "ONLINE",
        "uplink": "NORMAL", "armed": "ARMED", "dispatch": "DISABLED", "time_trust": "SYNCED", "updated_at": updated_at,
        "components": {"detector": "RUNNING"},
    }
    path.write_text(json.dumps(document), encoding="utf-8")
    return path


def test_status_json_that_stops_updating_turns_stale_after_60_seconds(tmp_path):
    written_at = 1_700_000_000.0
    path = _status_file(tmp_path, written_at)  # the Core froze right after this write: the file never changes again

    def read(seconds):
        return live.reader.read_observer_status(path, now=written_at + seconds, max_age_seconds=live.DESKTOP_MAX_AGE_SECONDS)

    assert read(5).valid and read(5).freshness == "FRESH"
    assert read(59.9).freshness == "FRESH"
    assert read(60.0).freshness == "FRESH", "the limit is 'older than 60 s'"
    stale = read(60.1)
    assert not stale.valid and stale.freshness == "STALE"
    values = live.evidence_values(stale)
    assert values["freshness"] == "STALE"
    assert all(values[key] == "UNKNOWN" for key in ("runtime", "broker", "device", "uplink", "armed", "dispatch", "trusted_time"))


def test_a_status_timestamp_from_the_future_is_not_fresh(tmp_path):
    path = _status_file(tmp_path, 1_700_000_100.0)
    evidence = live.reader.read_observer_status(path, now=1_700_000_000.0)
    assert not evidence.valid and evidence.freshness != "FRESH"


# ---- Recovery page (P3): a read-only readiness checklist; no RESTORE control, no new authority ----

def write_recovery_view(path, **changes):
    document = {
        "v": 1, "updated_at": time.time(), "uplink": "LOCKDOWN", "device": "ONLINE", "uplink_why": "UNCOMMANDED_AFTER_RESTORE",
        "last_command": {"action": "RESTORE_UPLINK", "acked": True, "confirmed": True, "timed_out": False},
        "restore_pending": False, "restore_pending_remaining_sec": None, "restore_command_pending": False,
        "lockout_remaining_sec": 0.0, "restore_served": True,
    }
    document.update(changes)
    path.write_text(json.dumps(document), encoding="utf-8")
    return path


def open_recovery(app_factory, tmp_path, language="en", with_view=True, **view_changes):
    recovery = tmp_path / "recovery-status.json"
    if with_view:
        write_recovery_view(recovery, **view_changes)
    app, root = app_factory(FakeRestoreFlow(), FakePrompts(), language=language, status_age=5, recovery=recovery)
    write_core_status(app._status_path, 5, uplink="LOCKDOWN")
    _poll(app, root)
    app._show_page("recovery")
    root.update()
    return app, root, recovery


def test_the_recovery_page_is_a_live_readiness_checklist(app_factory, tmp_path):
    _app, root, _ = open_recovery(app_factory, tmp_path)
    texts = _texts(root)
    joined = "\n".join(texts)
    for stale_text in ("BLOCKED", "RESTORE NETWORK", "observer mode", "no live authorization", "NOT_CONSUMED"):
        assert stale_text not in joined
    assert any(text.startswith("READY") for text in texts)
    assert any(text.startswith("UNCOMMANDED_AFTER_RESTORE — ") for text in texts)
    assert "LOCKDOWN" in texts and "ONLINE" in texts and "SYNCED" in texts and "CONNECTED" in texts
    assert "no" in texts and "none" in texts


def test_the_recovery_page_has_no_restore_control_only_navigation(app_factory, tmp_path):
    app, root, _ = open_recovery(app_factory, tmp_path)
    buttons = [b.cget("text") for b in _widgets(root, "Button")]
    assert desktop.RESTORE_BUTTON_TEXT not in buttons and desktop.RESTORE_DISABLED_TEXT not in buttons
    assert not [b for b in buttons if "RESTORE" in b.upper() and b != "Go to the Lockdown page"]
    go = next(b for b in _widgets(root, "Button") if b.cget("text") == "Go to the Lockdown page")
    errors = []
    root.report_callback_exception = lambda *exc: errors.append(exc[1])
    assert str(go.cget("state")) == "normal"
    go.invoke()
    assert not errors, errors
    root.update()
    assert app.active_page == "lockdown" and _restore_button(root) is not None   # the one RESTORE control lives here
    assert app._restore_button is not None


def test_the_recovery_page_updates_while_open_and_stops_when_left(app_factory, tmp_path):
    app, root, recovery = open_recovery(app_factory, tmp_path)
    assert any(text.startswith("READY") for text in _texts(root))
    write_recovery_view(recovery, restore_pending=True, restore_pending_remaining_sec=6.0, lockout_remaining_sec=20.0)
    app._tick_live_page()
    root.update()
    texts = _texts(root)
    assert any(text.startswith("NOT READY") and "RESTORE_PENDING" in text and "AUTH_LOCKED_OUT" in text for text in texts)
    assert any(text.startswith("yes — awaiting device status evidence") and "6 s" in text for text in texts)
    assert any("locked after repeated wrong secrets — 20 s remaining" in text for text in texts)
    app._show_page("devices")
    root.update()
    assert app._page_tick is None and app._page_after is None


def test_the_recovery_page_preserves_scroll_position_across_a_live_refresh_tick(app_factory, tmp_path):
    """Regression: _render_recovery() destroys and rebuilds every Section's children on each
    SEVERITY_POLL_MS tick; the enclosing ScrollFrame's canvas used to reset to the top on every
    tick because its scrollregion collapses while the old children are gone and nothing restored
    the view afterward. The snapshot comparison added since (task 3, no-flicker) means a tick with
    no real data change now skips the rebuild entirely -- harmless for scroll, but it would no
    longer exercise the restore path this test is actually about, so the view is changed here too,
    forcing a real rebuild, exactly like test_..._updates_while_open_and_stops_when_left already does."""
    app, root, recovery = open_recovery(app_factory, tmp_path)
    # The bug (and this fix) is specifically about the <Configure>-driven scrollregion recompute that a
    # real, mapped window processes on its own idle cycle; a withdrawn window never gets that from the X
    # server, so this one test needs a real, small, on-screen window instead of the suite's usual withdraw().
    root.deiconify()
    root.geometry("1024x300")
    root.update()
    canvases = _widgets(root, "Canvas")
    assert canvases, "expected the Recovery page's ScrollFrame canvas"
    canvas = canvases[0]
    bbox = canvas.bbox("all")
    assert bbox is not None and bbox[3] > canvas.winfo_height(), "test setup needs real scrollable overflow"
    canvas.yview_moveto(0.5)
    root.update()
    before = canvas.yview()[0]
    assert before > 0.05, "test setup did not actually scroll down"
    write_recovery_view(recovery, restore_pending=True, restore_pending_remaining_sec=6.0, lockout_remaining_sec=20.0)
    app._tick_live_page()
    root.update()
    assert any(text.startswith("NOT READY") for text in _texts(root)), "test setup did not actually change the data"
    after = canvas.yview()[0]
    assert abs(after - before) < 0.02, f"scroll position jumped from {before} to {after} on a refresh tick"
    root.withdraw()


def test_the_lockdown_severity_panel_preserves_scroll_position_across_a_live_refresh_tick(app_factory, tmp_path):
    """Same mechanism and fix as the Recovery page above, applied to the Lockdown page's severity panel
    (_render_severity), which is driven by its own, separate SEVERITY_POLL_MS timer. The graduated-status.json
    file is rewritten before the tick (same path app_factory itself writes the initial projection to) so the
    snapshot comparison added since (task 3) sees a real change and actually rebuilds, rather than skipping --
    this test is about the restore-on-rebuild path, not the (also correct, but different) skip path."""
    app, root = app_factory(FakeRestoreFlow(), FakePrompts(), DECISIONS, status_age=5)
    root.deiconify()
    root.geometry("1024x300")
    root.update()
    canvases = _widgets(root, "Canvas")
    assert canvases, "expected the Lockdown page's ScrollFrame canvas"
    canvas = canvases[0]
    bbox = canvas.bbox("all")
    assert bbox is not None and bbox[3] > canvas.winfo_height(), "test setup needs real scrollable overflow"
    canvas.yview_moveto(0.5)
    root.update()
    before = canvas.yview()[0]
    assert before > 0.05, "test setup did not actually scroll down"
    changed = dict(DECISIONS, highest_level="CRITICAL")
    (tmp_path / "graduated-status.json").write_text(json.dumps(changed), encoding="utf-8")
    app._tick_severity()
    root.update()
    assert "CRITICAL" in _texts(root), "test setup did not actually change the data"
    after = canvas.yview()[0]
    assert abs(after - before) < 0.02, f"scroll position jumped from {before} to {after} on a refresh tick"
    root.withdraw()


def test_the_recovery_page_does_not_rebuild_on_an_unchanged_refresh_tick(app_factory, tmp_path):
    """The periodic rebuild-every-tick is what caused the flicker; widget identity staying the same across a
    no-change tick is the proxy for "nothing was destroyed/recreated, so nothing visibly flickered"."""
    app, root, _ = open_recovery(app_factory, tmp_path)
    before = [id(w) for w in _widgets(root, "Label")]
    app._tick_live_page()
    root.update()
    after = [id(w) for w in _widgets(root, "Label")]
    assert before == after, "an unchanged tick rebuilt widgets and would flicker"


def test_the_recovery_page_rebuilds_promptly_when_the_data_actually_changes(app_factory, tmp_path):
    app, root, recovery = open_recovery(app_factory, tmp_path)
    before = [id(w) for w in _widgets(root, "Label")]
    write_recovery_view(recovery, restore_pending=True, restore_pending_remaining_sec=6.0)
    app._tick_live_page()
    root.update()
    after = [id(w) for w in _widgets(root, "Label")]
    assert before != after
    assert any(text.startswith("NOT READY") for text in _texts(root))


def test_the_incidents_page_does_not_rebuild_on_an_unchanged_refresh_tick(app_factory):
    app, root = app_factory(FakeRestoreFlow(), FakePrompts(), DECISIONS, status_age=5)
    app._show_page("incidents")
    root.update()
    before = [id(w) for w in _widgets(root, "Label")]
    app._tick_live_page()
    root.update()
    after = [id(w) for w in _widgets(root, "Label")]
    assert before == after, "an unchanged tick rebuilt widgets and would flicker"


def test_the_audit_page_does_not_rebuild_on_an_unchanged_refresh_tick(app_factory, tmp_path):
    from test_live_purple_core_records import ROWS, make_audit

    audit = make_audit(tmp_path / "audit.sqlite3", ROWS)
    app, root = app_factory(FakeRestoreFlow(), FakePrompts(), status_age=5, audit_db=audit)
    app._show_page("audit")
    root.update()
    before = [id(w) for w in _widgets(root, "Label")]
    app._tick_live_page()
    root.update()
    after = [id(w) for w in _widgets(root, "Label")]
    assert before == after, "an unchanged tick rebuilt widgets and would flicker"


def test_the_lockdown_severity_panel_does_not_rebuild_on_an_unchanged_refresh_tick(app_factory):
    app, root = app_factory(FakeRestoreFlow(), FakePrompts(), DECISIONS, status_age=5)
    before = [id(w) for w in _widgets(root, "Label")]
    app._tick_severity()
    root.update()
    after = [id(w) for w in _widgets(root, "Label")]
    assert before == after, "an unchanged tick rebuilt widgets and would flicker"


def test_the_lockdown_severity_panel_rebuilds_promptly_when_the_data_actually_changes(app_factory, tmp_path):
    app, root = app_factory(FakeRestoreFlow(), FakePrompts(), DECISIONS, status_age=5)
    before = [id(w) for w in _widgets(root, "Label")]
    changed = dict(DECISIONS, highest_level="CRITICAL")
    (tmp_path / "graduated-status.json").write_text(json.dumps(changed), encoding="utf-8")
    app._tick_severity()
    root.update()
    after = [id(w) for w in _widgets(root, "Label")]
    assert before != after
    assert "CRITICAL" in _texts(root)


@pytest.mark.parametrize("language,marker", [("th", "พร้อม"), ("zh", "可执行")])
def test_the_recovery_page_follows_the_language_and_keeps_codes(app_factory, tmp_path, language, marker):
    _app, root, _ = open_recovery(app_factory, tmp_path, language=language, restore_pending=True, restore_pending_remaining_sec=3.0)
    joined = "\n".join(_texts(root))
    assert marker in joined
    for code in ("LOCKDOWN", "UNCOMMANDED_AFTER_RESTORE", "RESTORE_PENDING", "NOT READY"):
        assert code in joined
    assert "Ready for a RESTORE" not in joined and "RESTORE is performed" not in joined


def test_the_recovery_page_without_a_view_says_not_available_and_why(app_factory, tmp_path):
    _app, root, recovery = open_recovery(app_factory, tmp_path, with_view=False)
    joined = "\n".join(_texts(root))
    assert "NOT_AVAILABLE — NOT_FOUND" in joined and "VIEW_UNAVAILABLE" in joined
    assert not any(text.startswith("READY") for text in _texts(root))
    write_recovery_view(recovery, updated_at=time.time() - 200)
    _app._tick_live_page()
    root.update()
    assert "NOT_AVAILABLE — STALE" in "\n".join(_texts(root))


def test_recent_restore_attempts_come_from_the_core_audit_records(app_factory, tmp_path):
    from test_live_purple_core_records import ROWS, SECRET_REASON, make_audit

    recovery = write_recovery_view(tmp_path / "recovery-status.json")
    audit = make_audit(tmp_path / "audit.sqlite3", ROWS)
    app, root = app_factory(FakeRestoreFlow(), FakePrompts(), status_age=5, recovery=recovery, audit_db=audit)
    app._show_page("recovery")
    root.update()
    joined = "\n".join(_texts(root))
    assert "RESTORE_REFUSED" in joined and "RESTORE_ALREADY_PENDING" in joined and "RESTORE_AUTH_LOCKOUT" in joined
    assert "ACK_RECEIVED" not in joined and SECRET_REASON not in joined


def test_the_page_cannot_issue_a_restore_even_when_every_control_is_pressed(app_factory, tmp_path):
    flow, prompts = FakeRestoreFlow(), FakePrompts()
    recovery = write_recovery_view(tmp_path / "recovery-status.json")
    app, root = app_factory(flow, prompts, status_age=5, recovery=recovery)
    app._show_page("recovery")
    root.update()
    for button in [b for b in _widgets(root, "Button") if b.cget("text") != "Go to the Lockdown page"]:
        button.invoke()          # every other control is disabled by the preview base; a press does nothing
    app.on_restore_clicked()     # the base callback is neutral
    root.update()
    assert flow.submitted == [] and prompts.asked == [] and flow.polls == 0


LOCKDOWN_DECISIONS = {
    "v": 1, "updated_at": 1.0, "auto_cut_latched": True, "highest_level": "CRITICAL", "cut_recommended_for": None,
    "decisions": [
        {"at": 1_800_000_000.0, "attacker_ip": "203.0.113.9", "kind": "ssh_login_after_failures", "level": "CRITICAL",
         "action": "AUTO_CUT", "outcome": "CUT_SENT", "score": 140,
         "reasons": ["ssh_brute_force+40", "ssh_login_after_failures+100"], "mitre": ["T1110"]},
    ],
}


def test_the_recovery_page_shows_the_most_recent_decision_as_the_lockdown_cause(app_factory, tmp_path):
    recovery = write_recovery_view(tmp_path / "recovery-status.json")
    app, root = app_factory(FakeRestoreFlow(), FakePrompts(), status_age=5, recovery=recovery, graduated=LOCKDOWN_DECISIONS)
    write_core_status(app._status_path, 5, uplink="LOCKDOWN")
    _poll(app, root)
    app._show_page("recovery")
    root.update()
    joined = "\n".join(_texts(root))
    assert "203.0.113.9 — CRITICAL" in joined
    assert "ssh_brute_force+40, ssh_login_after_failures+100" in joined
    assert "T1110" in joined
    assert "AUTO_CUT → CUT_SENT" in joined
    assert "ago" in joined


def test_the_recovery_page_shows_no_active_lockdown_when_the_uplink_is_normal(app_factory, tmp_path):
    recovery = write_recovery_view(tmp_path / "recovery-status.json", uplink="NORMAL", uplink_why="NOT_LOCKDOWN")
    app, root = app_factory(FakeRestoreFlow(), FakePrompts(), status_age=5, recovery=recovery, graduated=LOCKDOWN_DECISIONS)
    app._show_page("recovery")
    root.update()
    assert "no active lockdown" in "\n".join(_texts(root))


def test_the_recovery_page_shows_active_software_blocks_from_the_containment_helper(app_factory, tmp_path, monkeypatch):
    monkeypatch.setattr(desktop.live, "containment_status",
                        lambda: (desktop.live.CONTAINMENT_HEALTHY, ["203.0.113.5", "203.0.113.6"]))
    recovery = write_recovery_view(tmp_path / "recovery-status.json")
    app, root = app_factory(FakeRestoreFlow(), FakePrompts(), status_age=5, recovery=recovery)
    app._show_page("recovery")
    root.update()
    texts = _texts(root)
    joined = "\n".join(texts)
    assert "Active software blocks" in joined and "2" in texts
    assert "203.0.113.5" in joined and "203.0.113.6" in joined


def test_the_recovery_page_reports_an_unreachable_containment_helper_instead_of_crashing(app_factory, tmp_path, monkeypatch):
    monkeypatch.setattr(desktop.live, "containment_status", lambda: ("UNAVAILABLE — ContainmentUnavailable", []))
    recovery = write_recovery_view(tmp_path / "recovery-status.json")
    app, root = app_factory(FakeRestoreFlow(), FakePrompts(), status_age=5, recovery=recovery)
    errors = []
    root.report_callback_exception = lambda *exc: errors.append(exc[1])
    app._show_page("recovery")
    root.update()
    assert not errors, errors
    assert "UNAVAILABLE" in "\n".join(_texts(root))


def test_the_recovery_page_shows_the_runbook_with_the_pin2_step_visually_prominent(app_factory, tmp_path):
    recovery = write_recovery_view(tmp_path / "recovery-status.json")
    app, root = app_factory(FakeRestoreFlow(), FakePrompts(), status_age=5, recovery=recovery)
    app._show_page("recovery")
    root.update()
    labels = _widgets(root, "Label")
    pin2 = next(w for w in labels if "PIN 2" in str(w.cget("text")))
    ordinary = next(w for w in labels if str(w.cget("text")).startswith("1. Verify the threat is over"))
    assert str(pin2.cget("fg")) != str(ordinary.cget("fg"))
    joined = "\n".join(_texts(root))
    assert "8. Close the incident" in joined


def test_the_control_desktops_diagnostics_page_also_shows_containment_health(app_factory, monkeypatch):
    monkeypatch.delenv(desktop.live.containment.SOCKET_ENV, raising=False)
    _app, root = app_factory(FakeRestoreFlow(), FakePrompts())
    _app._show_page("diagnostics")
    root.update()
    joined = "\n".join(_texts(root))
    assert "NOT_CONFIGURED" in joined


def test_the_diagnostics_page_reads_the_same_audit_source_as_recovery_and_audit(app_factory, tmp_path):
    from test_live_purple_core_records import ROWS, SECRET_REASON, make_audit

    audit = make_audit(tmp_path / "audit.sqlite3", ROWS)
    app, root = app_factory(FakeRestoreFlow(), FakePrompts(), audit_db=audit)
    app._show_page("diagnostics")
    root.update()
    joined = "\n".join(_texts(root))
    assert "NOT_AVAILABLE" not in joined
    assert "newest records shown" in joined and SECRET_REASON not in joined


def test_the_diagnostics_page_reports_the_real_reason_without_an_audit_db(app_factory):
    app, root = app_factory(FakeRestoreFlow(), FakePrompts())
    app._show_page("diagnostics")
    root.update()
    joined = "\n".join(_texts(root))
    assert "NOT_AVAILABLE — NOT_CONFIGURED" in joined


# ---- Incidents and Audit pages (P4): read-only data from existing Core sources, NOT_AVAILABLE with the reason otherwise ----

DECISIONS = {
    "v": 1, "updated_at": 1.0, "auto_cut_latched": False, "highest_level": "HIGH", "cut_recommended_for": "203.0.113.9",
    "decisions": [
        {"at": 1_800_000_000.0, "attacker_ip": "203.0.113.9", "kind": "PORT_SCAN", "level": "MEDIUM", "action": "BLOCK_IP",
         "outcome": "BLOCKED", "score": 40, "reasons": ["scan"], "mitre": ["T1046"]},
        {"at": 1_800_000_060.0, "attacker_ip": "203.0.113.9", "kind": "MULTI_VECTOR", "level": "HIGH", "action": "RECOMMEND_CUT",
         "outcome": "", "score": 70, "reasons": [], "mitre": ["T1046", "T1110"]},
    ],
}


def test_incidents_page_shows_the_cores_graduated_decisions(app_factory):
    app, root = app_factory(FakeRestoreFlow(), FakePrompts(), DECISIONS, status_age=5)
    app._show_page("incidents")
    root.update()
    joined = "\n".join(_texts(root))
    assert "observer mode" not in joined and "Operational actions" not in joined
    assert "HIGH" in joined and "PORT_SCAN" in joined and "MULTI_VECTOR" in joined and "T1046" in joined
    assert "203.0.113.9 — decide with the CUT button" in joined


def test_incidents_page_without_a_source_shows_a_plain_empty_state_not_the_raw_reason(app_factory):
    app, root = app_factory(FakeRestoreFlow(), FakePrompts(), None, status_age=5)
    app._show_page("incidents")
    root.update()
    joined = "\n".join(_texts(root))
    assert "Incident data source not found" in joined and "cannot be determined" in joined
    assert "No events found" not in joined and "the system is watching" not in joined
    assert "Data source status: NOT_FOUND" in joined
    assert "NOT_AVAILABLE" not in joined and "graduated-status.json" not in joined


def test_incidents_page_always_shows_the_intro_and_level_legend(app_factory):
    app, root = app_factory(FakeRestoreFlow(), FakePrompts(), None, status_age=5)
    app._show_page("incidents")
    root.update()
    joined = "\n".join(_texts(root))
    assert "graduated response decisions" in joined
    assert "RESPONSE LEVELS" in joined
    for level, phrase in (("LOW", "Log / audit only"), ("MEDIUM", "Software IP block"),
                          ("HIGH", "Recommends a physical CUT"), ("CRITICAL", "Automatic CUT")):
        assert level in joined and phrase in joined


def test_incidents_page_renders_a_card_per_decision_with_friendly_labels(app_factory):
    app, root = app_factory(FakeRestoreFlow(), FakePrompts(), DECISIONS, status_age=5)
    app._show_page("incidents")
    root.update()
    joined = "\n".join(_texts(root))
    assert "Attacker IP" in joined and "Attack type" in joined and "Corroborated" in joined
    assert "203.0.113.9" in joined and "HIGH" in joined and "MEDIUM" in joined
    assert "recommend physical CUT" in joined  # RECOMMEND_CUT mapped to a friendly label
    assert "PORT_SCAN" in joined and "MULTI_VECTOR" in joined  # unmapped test kinds still shown, raw, never hidden


@pytest.mark.parametrize("language,marker", [("th", "การตัดสินใจ"), ("zh", "决策")])
def test_incidents_page_follows_the_language(app_factory, language, marker):
    app, root = app_factory(FakeRestoreFlow(), FakePrompts(), DECISIONS, language=language, status_age=5)
    app._show_page("incidents")
    root.update()
    joined = "\n".join(_texts(root))
    assert marker in joined and "HIGH" in joined and "PORT_SCAN" in joined and "CORE GRADUATED-RESPONSE" not in joined


def test_audit_page_lists_cut_and_restore_records_without_reasons(app_factory, tmp_path):
    from test_live_purple_core_records import ROWS, SECRET_REASON, make_audit

    audit = make_audit(tmp_path / "audit.sqlite3", ROWS)
    app, root = app_factory(FakeRestoreFlow(), FakePrompts(), status_age=5, audit_db=audit)
    app._show_page("audit")
    root.update()
    joined = "\n".join(_texts(root))
    assert "observer mode" not in joined and "Operational actions" not in joined
    for expected in ("RESTORE_REQUESTED", "COMMAND_SENT", "RESTORE_UPLINK", "ACK_RECEIVED", "RESTORE_ALREADY_PENDING",
                     "CUT_PRE_DISPATCH", "ab" * 16, "RESTORE_AUTH_LOCKOUT", "19:01:06"):  # the feed shows HH:MM:SS, not the full date
        assert expected in joined, expected
    assert "STATUS_AUTHENTICATED" not in joined and SECRET_REASON not in joined


def test_audit_page_updates_while_open(app_factory, tmp_path):
    from test_live_purple_core_records import ROWS, make_audit
    import sqlite3

    audit = make_audit(tmp_path / "audit.sqlite3", ROWS[:2])
    app, root = app_factory(FakeRestoreFlow(), FakePrompts(), status_age=5, audit_db=audit)
    app._show_page("audit")
    root.update()
    assert "RESTORE_AUTH_LOCKOUT" not in "\n".join(_texts(root))
    connection = sqlite3.connect(audit)
    connection.execute("INSERT INTO audit_logs (timestamp, level, event_type, details) VALUES ('2026-10-24 19:30:00','WARN','RESTORE_AUTH_LOCKOUT','uid=1 pid=2')")
    connection.commit()
    connection.close()
    app._tick_live_page()
    root.update()
    assert "RESTORE_AUTH_LOCKOUT" in "\n".join(_texts(root))


@pytest.mark.parametrize("make,reason", [(None, "NOT_CONFIGURED"), ("absent", "NOT_FOUND"), ("denied", "PERMISSION_DENIED"), ("garbage", "UNREADABLE")])
def test_audit_page_says_why_the_source_is_not_reachable(app_factory, tmp_path, make, reason):
    from test_live_purple_core_records import ROWS, make_audit

    path = None
    if make == "absent":
        path = tmp_path / "absent.sqlite3"
    elif make == "denied":
        path = make_audit(tmp_path / "denied.sqlite3", ROWS)
        path.chmod(0)
    elif make == "garbage":
        path = tmp_path / "garbage.sqlite3"
        path.write_bytes(b"not a database" * 50)
    try:
        app, root = app_factory(FakeRestoreFlow(), FakePrompts(), status_age=5, audit_db=path)
        app._show_page("audit")
        root.update()
        joined = "\n".join(_texts(root))
        assert f"NOT_AVAILABLE — {reason}" in joined and "RESTORE_REQUESTED" not in joined
    finally:
        if make == "denied":
            path.chmod(0o600)


@pytest.mark.parametrize("language,marker", [("th", "การตรวจสอบของ Core"), ("zh", "Core 审计")])
def test_audit_page_follows_the_language(app_factory, tmp_path, language, marker):
    from test_live_purple_core_records import ROWS, make_audit

    audit = make_audit(tmp_path / "audit.sqlite3", ROWS)
    app, root = app_factory(FakeRestoreFlow(), FakePrompts(), language=language, status_age=5, audit_db=audit)
    app._show_page("audit")
    root.update()
    joined = "\n".join(_texts(root))
    assert marker in joined and "RESTORE_REQUESTED" in joined and "CORE AUDIT" not in joined


def test_with_an_incident_source_the_incident_register_is_kept(app_factory):
    # the control app wires incident_source=None in main(); a supplied source keeps the incident Desktop's own page
    import inspect

    assert "incident_source is not None" in inspect.getsource(desktop._control_gui_class)


# ---- P5: dialogs, captions and button texts in th/en/zh, translated at display only ----

@pytest.mark.parametrize("language,script", [("th", "[฀-๿]"), ("zh", "[一-鿿]")])
def test_control_buttons_and_captions_follow_the_language(app_factory, language, script):
    import re

    _app, root = app_factory(FakeRestoreFlow(), FakePrompts(), language=language)
    buttons = [b.cget("text") for b in _widgets(root, "Button")]
    assert desktop.RESTORE_BUTTON_TEXT not in buttons and desktop.cut_desktop.CUT_BUTTON_TEXT not in buttons
    assert any(re.search(script, text) and "RESTORE" in text for text in buttons)
    assert any(re.search(script, text) and "CUT" in text for text in buttons)
    texts = _texts(root)
    assert "OPERATOR CONTROLS — CORE-AUTHENTICATED" not in texts and "CUT and RESTORE — each verified by the Core" not in texts
    assert any(re.search(script, text) and "CUT" in text and "RESTORE" in text for text in texts)


def test_english_control_texts_are_unchanged(app_factory):
    _app, root = app_factory(FakeRestoreFlow(), FakePrompts(), language="en")
    assert desktop.RESTORE_BUTTON_TEXT in [b.cget("text") for b in _widgets(root, "Button")]
    assert desktop.cut_desktop.CUT_BUTTON_TEXT in [b.cget("text") for b in _widgets(root, "Button")]
    assert "OPERATOR CONTROLS — CORE-AUTHENTICATED" in _texts(root)


@pytest.mark.parametrize("language", ["th", "zh"])
def test_a_translated_restore_button_still_runs_the_same_flow(app_factory, language):
    flow, prompts = FakeRestoreFlow(), FakePrompts()
    app, root = app_factory(flow, prompts, language=language)
    button = next(b for b in _widgets(root, "Button") if "RESTORE" in b.cget("text") and str(b.cget("state")) == "normal")
    button.invoke()
    root.update()
    assert flow.submitted == [("lab acceptance restore after CUT", "restore-secret", rc.CONFIRMATION)]   # internal identifiers untouched
    assert app._restore_status is not None


def test_the_status_line_is_translated_but_keeps_the_state_code(app_factory):
    flow = FakeRestoreFlow()
    flow.view = rc.View("REFUSED_PENDING", "A previous RESTORE awaits device evidence. Nothing new was sent.", rc.WARN, True)
    app, root = app_factory(flow, FakePrompts(), language="th")
    line = next(text for text in _texts(root) if text.startswith("REFUSED_PENDING"))
    assert "A previous RESTORE" not in line and "REFUSED_PENDING: " in line and "RESTORE" in line
    flow.view = rc.View("IDLE", "No RESTORE in progress.", rc.INFO, True)
    app._refresh_restore_button()
    root.update()
    assert any(text.startswith("IDLE: ") and "No RESTORE" not in text for text in _texts(root))


def test_the_cut_status_line_is_translated_too(app_factory):
    app, root = app_factory(FakeRestoreFlow(), FakePrompts(), language="zh")
    assert any(text.startswith("IDLE: ") and "手动 CUT" in text for text in _texts(root))
    assert not any("No manual CUT in progress." in text for text in _texts(root))


def test_switching_the_language_relabels_the_controls_and_back(app_factory, tmp_path, monkeypatch):
    import re

    monkeypatch.setenv("AEGIS_DB_PATH", str(tmp_path / "audit.db"))   # set_language persists next to the DB path: keep it in tmp
    app, root = app_factory(FakeRestoreFlow(), FakePrompts(), language="en")
    app._set_language("th")
    root.update()
    app._show_page("lockdown")
    root.update()
    assert any(re.search("[฀-๿]", b.cget("text")) for b in _widgets(root, "Button") if "RESTORE" in b.cget("text"))
    app._set_language("en")
    root.update()
    app._show_page("lockdown")
    root.update()
    assert desktop.RESTORE_BUTTON_TEXT in [b.cget("text") for b in _widgets(root, "Button")]


@pytest.mark.parametrize(("language", "page", "marker"), [
    ("th", "overview", "หลักฐานสดจาก Core — อ่านอย่างเดียว"),
    ("zh", "devices", "连接与心跳证据"),
    ("th", "lockdown", "สถานะล็อกดาวน์ปัจจุบัน"),
    ("zh", "settings", "界面语言"),
])
def test_refined_operational_pages_use_the_selected_language(app_factory, language, page, marker):
    app, root = app_factory(FakeRestoreFlow(), FakePrompts(), language=language, status_age=0)

    app._show_page(page)
    root.update()

    assert marker in _texts(root)


def test_audit_console_has_structured_headers_and_keeps_machine_fields(app_factory, tmp_path):
    audit_db = tmp_path / "audit.sqlite3"
    connection = sqlite3.connect(audit_db)
    connection.execute(
        "CREATE TABLE audit_logs (id INTEGER PRIMARY KEY, timestamp TEXT, event_type TEXT, details TEXT)"
    )
    connection.execute(
        "INSERT INTO audit_logs VALUES (1, '2026-10-24 19:01:06', 'ACK_RECEIVED', 'OK - seq 16')"
    )
    connection.commit()
    connection.close()
    app, root = app_factory(FakeRestoreFlow(), FakePrompts(), audit_db=audit_db)

    app._show_page("audit")
    root.update()
    texts = _texts(root)

    assert "TIME" in texts
    assert "EVENT" in texts
    assert "DETAILS" in texts
    assert "ACK_RECEIVED" in texts
    assert "OK · seq 16" in texts


def test_settings_language_callback_keeps_persistence_and_shows_localized_feedback(app_factory, tmp_path, monkeypatch):
    monkeypatch.setenv("AEGIS_DB_PATH", str(tmp_path / "audit.db"))
    app, root = app_factory(FakeRestoreFlow(), FakePrompts(), language="en")
    from aegis_soc import i18n

    app._show_page("settings")
    app._set_language("th")
    root.update()

    assert i18n.get_language() == "th"
    assert "อัปเดตภาษาเรียบร้อยแล้ว" in _texts(root)


def test_settings_theme_callback_keeps_theme_state_and_shows_feedback(app_factory):
    app, root = app_factory(FakeRestoreFlow(), FakePrompts(), language="zh")
    from aegis_soc import theme_state

    app._show_page("settings")
    target = "light" if theme_state.get_theme() == "dark" else "dark"
    app._set_theme(target)
    root.update()

    assert theme_state.get_theme() == target
    assert "外观已成功更新。" in _texts(root)


def _value_after(root, label):
    texts = _texts(root)
    after = texts[texts.index(label) + 1:]
    return next(text for text in after if len(text) > 1 or text.isalnum())   # skip the one-glyph status marker


@pytest.mark.parametrize("status, blocked, expected", [
    ("HEALTHY", [], "0"),
    ("HEALTHY", ["203.0.113.5", "203.0.113.6", "203.0.113.7"], "3"),
    ("UNAVAILABLE — ContainmentUnavailable", [], "UNKNOWN"),
    ("NOT_CONFIGURED", [], "UNKNOWN"),
])
def test_the_diagnostics_blocked_ip_count_is_never_a_fake_zero(app_factory, monkeypatch, status, blocked, expected):
    monkeypatch.setattr(desktop.live, "containment_status", lambda: (status, blocked))
    app, root = app_factory(FakeRestoreFlow(), FakePrompts(), status_age=5)
    app._show_page("diagnostics")
    root.update()
    assert _value_after(root, "Active software blocks") == expected
    if expected == "UNKNOWN":
        assert "This is not zero." in "\n".join(_texts(root))


@pytest.mark.parametrize("status, blocked, expected", [
    ("HEALTHY", [], "none"),
    ("HEALTHY", ["203.0.113.5"], "1"),
    ("UNAVAILABLE — ContainmentUnavailable", [], "UNKNOWN"),
    ("NOT_CONFIGURED", [], "UNKNOWN"),
])
def test_the_recovery_blocked_ip_count_is_never_a_fake_none(app_factory, tmp_path, monkeypatch, status, blocked, expected):
    monkeypatch.setattr(desktop.live, "containment_status", lambda: (status, blocked))
    recovery = write_recovery_view(tmp_path / "recovery-status.json")
    app, root = app_factory(FakeRestoreFlow(), FakePrompts(), status_age=5, recovery=recovery)
    app._show_page("recovery")
    root.update()
    assert _value_after(root, "Active software blocks") == expected


def test_incidents_page_with_a_verified_empty_source_says_none_found_without_claiming_safety(app_factory):
    empty = {"v": 1, "highest_level": "LOW", "cut_recommended_for": None, "auto_cut_latched": False, "decisions": []}
    app, root = app_factory(FakeRestoreFlow(), FakePrompts(), empty, status_age=5)
    app._show_page("incidents")
    root.update()
    joined = "\n".join(_texts(root))
    assert "No events found in the available data source" in joined
    assert "does not prove that no attack occurred" in joined
    assert "not found" not in joined and "unavailable" not in joined.lower().replace("not_available", "")


def test_recovery_status_tiles_separate_the_state_code_from_its_explanation_and_clarify_ready(app_factory, tmp_path):
    recovery = write_recovery_view(tmp_path / "recovery-status.json")
    app, root = app_factory(FakeRestoreFlow(), FakePrompts(), None, status_age=5, recovery=recovery)
    app._show_page("recovery")
    root.update()
    texts = _texts(root)
    assert "NOT_AVAILABLE" in texts                                   # the real state code, alone, in the big value
    assert not any(t.startswith("NOT_AVAILABLE — No graduated") for t in texts)
    assert "No graduated-response summary from Core" in texts          # its meaning, as a wrapping helper line
    ready_note = next(t for t in texts if t.startswith("Core-side RESTORE eligibility only"))
    assert "does not prove the cable or relay is reconnected" in ready_note and "pin 2" in ready_note


def test_a_long_section_title_wraps_inside_its_card_instead_of_being_clipped(app_factory, tmp_path):
    recovery = write_recovery_view(tmp_path / "recovery-status.json")
    app, root = app_factory(FakeRestoreFlow(), FakePrompts(), None, status_age=5, recovery=recovery)
    root.geometry("1440x900")
    app._show_page("recovery")
    root.update()
    title = next(w for w in _widgets(root, "Label") if str(w.cget("text")).startswith("ACTIVE SOFTWARE BLOCKS"))
    assert int(title.cget("wraplength")) > 0
    assert title.winfo_reqwidth() <= title.master.winfo_width()


_EMPTY_SOURCE = {"v": 1, "updated_at": 1.0, "auto_cut_latched": False, "highest_level": "LOW", "cut_recommended_for": None, "decisions": []}


def _overview_texts(app_factory, graduated):
    app, root = app_factory(FakeRestoreFlow(), FakePrompts(), graduated, status_age=5)
    app._show_page("overview")
    root.update()
    return "\n".join(_texts(root)), root


def test_overview_banner_never_says_no_incidents_without_a_readable_incident_source(app_factory):
    joined, _root = _overview_texts(app_factory, None)
    assert "Incident Status Unavailable" in joined and "cannot be determined" in joined
    assert "No Active Incidents" not in joined and "No open security incident" not in joined


def test_overview_banner_for_a_verified_empty_source_says_none_found_without_claiming_safety(app_factory):
    joined, _root = _overview_texts(app_factory, _EMPTY_SOURCE)
    assert "No Events Found" in joined and "does not prove that no attack occurred" in joined
    assert "No Active Incidents" not in joined


def test_overview_banner_reports_recorded_decisions(app_factory):
    joined, _root = _overview_texts(app_factory, DECISIONS)
    assert "Core Decisions Recorded" in joined and "Highest level: HIGH" in joined


def test_overview_not_available_cards_each_say_what_is_missing_instead_of_repeating_one_reason(app_factory):
    joined, _root = _overview_texts(app_factory, None)
    for note in ("Not provided by the Core status document", "No open-incident count here",
                 "No daily event count is provided to this Desktop"):
        assert note in joined
    assert joined.count("fresh and internally consistent") == 0


def test_devices_page_explains_missing_device_metrics_and_that_a_software_ack_is_not_physical_proof(app_factory):
    app, root = app_factory(FakeRestoreFlow(), FakePrompts(), None, status_age=5)
    app._show_page("devices")
    root.update()
    joined = "\n".join(_texts(root))
    assert "did not report this value to this Desktop" in joined and "does not mean the device is faulty" in joined
    assert "Reported is not the same as physically verified" in joined
    assert "software ACK" in joined and "not proof of physical cable continuity" in joined


def test_audit_page_notes_that_command_and_ack_tokens_are_not_physical_verification_and_keeps_its_tokens(app_factory, tmp_path):
    app, root = app_factory(FakeRestoreFlow(), FakePrompts(), None, status_age=5)
    app._show_page("audit")
    root.update()
    joined = "\n".join(_texts(root))
    assert "COMMAND_SENT and ACK_RECEIVED are command and acknowledgement evidence" in joined
    assert "not physical verification" in joined


def test_settings_preference_labels_are_left_aligned_like_every_other_row(app_factory):
    app, root = app_factory(FakeRestoreFlow(), FakePrompts(), None, status_age=5)
    app._show_page("settings")
    root.update()
    labels = {w.cget("text"): w for w in _widgets(root, "Label")}
    for text in ("Interface language", "Appearance"):
        assert str(labels[text].cget("anchor")) == "w"
