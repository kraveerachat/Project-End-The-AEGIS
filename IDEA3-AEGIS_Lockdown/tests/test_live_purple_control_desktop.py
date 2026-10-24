"""Purple Desktop with Core-authenticated CUT and RESTORE plus the read-only severity panel (no MQTT, no controller)."""

from __future__ import annotations

import json
import os
import re
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

    def build(restore_flow, prompts, graduated=None, language="en", status_age=None):
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
            graduated_path=graduated_path,
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
# once it is more than observer.DEFAULT_MAX_AGE_SECONDS (120 s) old, and polls every live.EVIDENCE_POLL_MS (2000 ms).

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

    write_core_status(app._status_path, 125)  # the Core froze: the same file, now older than the threshold
    _poll(app, root)
    assert not app.latest.valid and app.latest.freshness == "STALE"
    assert "STALE" in _texts(root) and "FRESH" not in _texts(root)

    write_core_status(app._status_path, 1)  # the Core resumed
    _poll(app, root)
    assert app.latest.valid and "FRESH" in _texts(root) and "STALE" not in _texts(root)


def test_the_stale_threshold_is_120_seconds_and_the_poll_is_2_seconds():
    assert live.reader.DEFAULT_MAX_AGE_SECONDS == 120.0
    assert live.EVIDENCE_POLL_MS == 2000
    assert desktop.create_control_app.__kwdefaults__["max_age_seconds"] == live.reader.DEFAULT_MAX_AGE_SECONDS


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
    app._render_severity()
    root.update()
    texts = " | ".join(_texts(root))
    assert "Core evidence" in texts and "STALE — the Core is not updating" in texts
    assert "HIGH" in texts and "203.0.113.7" in texts, "the last known decisions stay visible, clearly marked"

    write_core_status(app._status_path, 1)
    _poll(app, root)
    app._render_severity()
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


def test_status_json_that_stops_updating_turns_stale_after_120_seconds(tmp_path):
    written_at = 1_700_000_000.0
    path = _status_file(tmp_path, written_at)  # the Core froze right after this write: the file never changes again

    def read(seconds):
        return live.reader.read_observer_status(path, now=written_at + seconds)

    assert read(5).valid and read(5).freshness == "FRESH"
    assert read(119.9).freshness == "FRESH"
    assert read(120.0).freshness == "FRESH", "the limit is 'older than 120 s'"
    stale = read(120.1)
    assert not stale.valid and stale.freshness == "STALE"
    values = live.evidence_values(stale)
    assert values["freshness"] == "STALE"
    assert all(values[key] == "UNKNOWN" for key in ("runtime", "broker", "device", "uplink", "armed", "dispatch", "trusted_time"))


def test_a_status_timestamp_from_the_future_is_not_fresh(tmp_path):
    path = _status_file(tmp_path, 1_700_000_100.0)
    evidence = live.reader.read_observer_status(path, now=1_700_000_000.0)
    assert not evidence.valid and evidence.freshness != "FRESH"
