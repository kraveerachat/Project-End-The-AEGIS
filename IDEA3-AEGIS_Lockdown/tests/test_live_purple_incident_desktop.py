"""The purple Desktop's live incident page: shows only what the Core attests, adds no controls, issues nothing."""

from __future__ import annotations

import ast
import inspect
import sys
import time
import tkinter as tk
from pathlib import Path

import pytest

from aegis_soc import incident_view as iv
from tools import live_purple_incident_desktop as desktop
from tools import live_purple_observer as live

NOW = time.time()


def gate(name, status, age=5.0, summary="s"):
    return {"gate": name, "status": status, "summary": summary, "detail": "", "checked_at": NOW - age}


def snapshot(*, incident="default", gates=None, now=NOW):
    gates = gates if gates is not None else [gate(name, "PENDING") for name, _ in iv.GATES]
    return iv.parse_status({
        "v": 1, "ok": True, "code": "STATUS", "detail": "x",
        "data": {"incident": {"id": 2, "state": "OPEN", "opened_at": "2026-10-06 11:07:17", "attacker_ip": "192.0.2.10"}
                 if incident == "default" else incident, "gates": gates},
    }, now=now)


class Source:
    def __init__(self, shot):
        self.shot = shot
        self.calls = 0

    def __call__(self):
        self.calls += 1
        return self.shot


def _walk(widget):
    for child in widget.winfo_children():
        yield child
        yield from _walk(child)


def texts(app):
    return [w.cget("text") for w in _walk(app.root) if isinstance(w, (tk.Label, tk.Button)) and w.cget("text")]


def _clean_modules():
    for name in list(sys.modules):
        if name == "aegis_soc" or name.startswith("aegis_soc."):
            del sys.modules[name]
    sys.path[:] = [entry for entry in sys.path if entry != str(live.PYTHONUI_ROOT)]


@pytest.fixture
def app_factory(tmp_path):
    made = []
    saved_modules = {n: m for n, m in sys.modules.items() if n == "aegis_soc" or n.startswith("aegis_soc.")}
    saved_path = list(sys.path)

    def build(source):
        try:
            root = tk.Tk()
        except tk.TclError as error:
            pytest.skip(f"Tk display unavailable: {error}")
        root.withdraw()
        _clean_modules()
        made.append(root)
        app, fakes = desktop.create_incident_app(
            root, source=source, run_async=lambda function, *args: function(*args), status_path=tmp_path / "missing-status.json",
        )
        app.session.login("test-admin")
        app._on_authenticated()
        root.update()
        app._show_page("incidents")
        root.update()
        return app, fakes, root

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


def test_the_live_incident_id_source_ip_and_all_gates_are_shown_with_their_authority(app_factory):
    gates = [gate("R1_INCIDENT_CONTEXT", "VERIFIED", summary="Bound to incident #2"),
             gate("R2_SAFE_ACCESS", "VERIFIED", age=iv.STALE_AFTER_SEC + 100)] + [
        gate(name, "PENDING") for name, _ in iv.GATES[2:]]
    app, fakes, _root = app_factory(Source(snapshot(gates=gates)))
    shown = "\n".join(texts(app))
    assert "Incident ID" in shown and "192.0.2.10" in shown and "OPEN" in shown and "2026-10-06 11:07:17" in shown
    assert "Core-attested Recovery STATUS (read-only)" in shown
    for _name, label in iv.GATES:
        assert label in shown
    assert "VERIFIED · checked" in shown and "STALE · checked" in shown and "PENDING" in shown
    assert "Bound to incident #2" in shown
    assert "Not physical evidence" in shown


def test_core_broker_esp32_and_uplink_stay_unknown(app_factory):
    app, _f, _r = app_factory(Source(snapshot()))
    shown = texts(app)
    for label in iv.NOT_PROVIDED:
        assert label in shown
    assert sum(1 for t in shown if t.startswith("UNKNOWN — not provided by this source")) == len(iv.NOT_PROVIDED)


def test_an_unavailable_source_shows_not_available_and_no_historical_values(app_factory):
    app, _f, _r = app_factory(Source(iv.unavailable("Core Recovery channel unavailable: the Core account cannot be resolved")))
    shown = "\n".join(texts(app))
    assert "NOT_AVAILABLE" in shown and "Core Recovery channel unavailable" in shown
    assert "192.0.2.10" not in shown and "Incident ID" not in shown


def test_no_open_incident_is_stated_plainly(app_factory):
    app, _f, _r = app_factory(Source(snapshot(incident=None)))
    assert "NO OPEN INCIDENT REPORTED BY THE CORE" in "\n".join(texts(app))


def test_a_later_failure_replaces_earlier_good_data(app_factory):
    source = Source(snapshot())
    app, _f, root = app_factory(source)
    assert "192.0.2.10" in "\n".join(texts(app))
    source.shot = iv.unavailable("Core Recovery channel unavailable: the result was lost")
    app._start_poll()
    root.update()
    shown = "\n".join(texts(app))
    assert "192.0.2.10" not in shown and "NOT_AVAILABLE" in shown


def test_polling_is_repeated_until_the_window_closes_and_only_reads(app_factory):
    source = Source(snapshot())
    app, fakes, root = app_factory(source)
    first = source.calls
    app._start_poll()
    root.update()
    assert source.calls == first + 1
    app._closed = True
    app._start_poll()
    assert source.calls == first + 1
    assert fakes.mqtt.publish_calls == 0 and fakes.controller.issue_calls == 0


def test_no_control_is_added_or_enabled_and_cut_restore_stay_disabled(app_factory):
    app, fakes, root = app_factory(Source(snapshot()))
    app._show_page("lockdown")
    root.update()
    buttons = [w for w in _walk(app.root) if isinstance(w, tk.Button)]
    cut_restore = [b for b in buttons if "NETWORK" in b.cget("text")]
    assert cut_restore and all(b.cget("state") == "disabled" and "DISABLED" in b.cget("text") for b in cut_restore)
    app._show_page("incidents")
    root.update()
    labels = [b.cget("text") for b in _walk(app.root) if isinstance(b, tk.Button) and b.cget("state") == "normal"]
    for forbidden in ("Isolate", "Close", "Restore", "RESTORE", "CUT", "Probe", "Block"):
        assert not any(forbidden.lower() in label.lower() for label in labels), (forbidden, labels)
    assert fakes.controller.issue_calls == 0


def test_the_default_source_uses_the_existing_transport_without_importing_the_operational_package():
    client = desktop.load_recovery_transport()
    assert client.__name__ == "aegis_incident_recovery.recovery_client"
    assert client.rp.__name__ == "aegis_incident_recovery.recovery_protocol"
    assert client.request.__code__.co_filename.endswith("aegis_soc/recovery_client.py")
    assert callable(desktop.default_source())


def test_the_default_source_fails_closed_when_the_core_socket_is_unavailable(monkeypatch, tmp_path):
    monkeypatch.setenv("AEGIS_RECOVERY_SOCKET", str(tmp_path / "absent.sock"))
    shot = desktop.default_source()()
    assert not shot.available and shot.incident is None


def test_the_launcher_source_has_no_path_to_any_command_or_operational_runtime():
    source = inspect.getsource(desktop)
    for forbidden in ("MQTTManager(", "AegisCommandController(", "AegisSupervisor(", "TelegramListener(", "subprocess.", "serial.",
                      "sqlite3", ".issue(", "local_restore", "local_cut", "cut_client", "paho", "sudo", "ISOLATE", "RESTORE_STATUS",
                      "OP_CLOSE", "OP_PROBE", "CUT_UPLINK", "RESTORE_UPLINK"):
        assert forbidden not in ast.unparse(_strip(ast.parse(source))), forbidden
    assert "CUT NETWORK — DISABLED" in inspect.getsource(live)  # the accepted read-only observer is unchanged


def _strip(tree):
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.FunctionDef, ast.ClassDef)) and node.body and isinstance(node.body[0], ast.Expr) \
                and isinstance(getattr(node.body[0], "value", None), ast.Constant) and isinstance(node.body[0].value.value, str):
            node.body = node.body[1:] or [ast.Pass()]
    return tree
