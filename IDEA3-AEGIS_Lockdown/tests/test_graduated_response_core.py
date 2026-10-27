"""IDEA3 graduated response wired into the Core: alert ingress v2, supervisor actions, Telegram text, sink and detector.

Hermetic, like test_core_alert_ingress: a real supervisor over a temporary audit database, fakes for paho, the root
containment helper and Telegram. Nothing opens a broker, a device, a network socket or the real containment socket.
The default (flag off) behaviour is pinned by test_core_alert_ingress and must stay unchanged.
"""

from __future__ import annotations

import json
import os

import pytest
from test_core_recovery import IP, OTHER_IP, FakeContainment, make_env
from test_local_restore import SECRET

from aegis_soc import alert_sink, comms, config, graduated_detector, graduated_ingress, graduated_response
from aegis_soc import database as db
from aegis_soc import local_restore as lr
from aegis_soc.graduated_detector import GraduatedDetector
from aegis_soc.production_detector import ProductionDetector


@pytest.fixture(scope="module")
def credential():
    return lr.RestoreCredential.parse(lr.hash_secret(SECRET, n=lr.SCRYPT_MIN_N))


class Recorder:
    def __init__(self):
        self.commands = []
        self.alerts = []


def build(tmp_path, monkeypatch, credential, *, profile="production", enabled=True, lab_ingress=False,
          containment=None):
    monkeypatch.setattr(config, "GRADUATED_RESPONSE", "YES" if enabled else "")
    monkeypatch.setattr(config, "LAB_ALERT_INGRESS", "YES" if lab_ingress else "")
    instance = make_env(tmp_path, monkeypatch, credential, profile=profile)
    sup = instance.core.supervisor
    sup.containment = containment or FakeContainment()
    rec = Recorder()

    class Result:
        ok = True
        sent = True
        reason_code = None

    def issue_command(action, description, **kwargs):
        rec.commands.append((action, description, kwargs))
        return Result()

    monkeypatch.setattr(sup, "issue_command", issue_command)
    monkeypatch.setattr(comms, "send_severity_alert", lambda **fields: rec.alerts.append(fields))
    instance.rec = rec
    instance.ingress = graduated_ingress.GraduatedAlertIngress(sup.on_production_alert, clock=lambda: instance.core.now[0])
    return instance


@pytest.fixture
def env(tmp_path, monkeypatch, credential):
    instance = build(tmp_path, monkeypatch, credential)
    yield instance
    instance.core.close()


def send(env, body):
    return env.ingress.handle(body, lr.Peer(uid=os.geteuid(), pid=4242), allowed_uid=os.geteuid())


def v2(kind, ip=IP):
    return {"v": 2, "attacker_ip": ip, "kind": kind}


def tick(env, seconds=1.0):
    env.core.now[0] += seconds


# --------------------------------------------------------------------------- default stays inert


def test_the_graduated_response_is_inert_by_default(tmp_path, monkeypatch, credential):
    instance = build(tmp_path, monkeypatch, credential, enabled=False)
    try:
        assert instance.core.supervisor.graduated is None
        assert send(instance, v2("ssh_brute_force"))["code"] == "BOUND"
        assert send(instance, v2("ssh_login_after_failures"))["code"] == "EXISTING"
        assert instance.core.supervisor.containment.calls == []
        assert instance.rec.commands == [] and instance.rec.alerts == []
    finally:
        instance.core.close()


# --------------------------------------------------------------------------- levels and actions


def test_one_rule_is_medium_and_only_blocks_in_software(env):
    assert send(env, v2("port_scan"))["code"] == "BOUND"
    assert env.core.supervisor.containment.calls == [("block", IP)]
    assert env.rec.commands == []
    assert [a["level"] for a in env.rec.alerts] == ["MEDIUM"]
    assert env.rec.alerts[0]["outcome"] == "BLOCKED"
    assert "GRADUATED_MEDIUM" in {row[3] for row in db.fetch_all_logs()}


def test_a_version_1_alert_is_scored_as_generic_medium(env):
    assert send(env, {"v": 1, "attacker_ip": IP})["code"] == "BOUND"
    assert env.rec.alerts[0]["level"] == "MEDIUM" and env.rec.alerts[0]["reasons"] == ("generic+30",)


def test_two_vectors_recommend_a_cut_but_never_issue_one(env):
    send(env, v2("port_scan"))
    tick(env)
    send(env, v2("ssh_brute_force"))
    assert [a["level"] for a in env.rec.alerts] == ["MEDIUM", "HIGH"]
    assert env.rec.alerts[-1]["action"] == "RECOMMEND_CUT" and env.rec.alerts[-1]["outcome"] == "RECOMMENDED"
    assert env.rec.commands == []


def test_repeated_alerts_inside_the_post_block_grace_never_cut(env):
    """Log lines already in flight when the block landed are not bypass evidence (engine rule pinned end to end)."""
    send(env, v2("port_scan"))
    for _ in range(3):
        tick(env, graduated_response.POST_BLOCK_GRACE_SEC / 4)
        send(env, v2("port_scan"))
    assert env.rec.commands == []


def test_login_after_brute_force_cuts_once_through_the_normal_command_path(env):
    send(env, v2("ssh_brute_force"))
    tick(env, 2)
    send(env, v2("ssh_login_after_failures"))
    assert len(env.rec.commands) == 1
    action, description, kwargs = env.rec.commands[0]
    assert action == "CUT_UPLINK" and kwargs == {"critical": True, "origin": "graduated-response"}
    assert f"attacker={IP}" in description and "CRITICAL" in description
    assert env.rec.alerts[-1]["level"] == "CRITICAL" and env.rec.alerts[-1]["outcome"] == "CUT_SENT"
    tick(env, 2)
    send(env, v2("ssh_login_after_failures", OTHER_IP))
    assert len(env.rec.commands) == 1  # latched for this lockdown episode


def test_a_failed_software_block_escalates_to_an_automatic_cut(tmp_path, monkeypatch, credential):
    instance = build(tmp_path, monkeypatch, credential, containment=FakeContainment(block_ok=False))
    try:
        send(instance, v2("syn_flood"))  # MEDIUM 50 -> block fails -> +60 corroborated -> CRITICAL
        levels = [a["level"] for a in instance.rec.alerts]
        assert levels[0] == "MEDIUM" and instance.rec.alerts[0]["outcome"] == "BLOCK_FAILED"
        assert levels[-1] == "CRITICAL"
        assert [c[0] for c in instance.rec.commands] == ["CUT_UPLINK"]
    finally:
        instance.core.close()


def test_an_unavailable_helper_counts_as_a_failed_block(tmp_path, monkeypatch, credential):
    instance = build(tmp_path, monkeypatch, credential, containment=FakeContainment(unavailable=True))
    try:
        send(instance, v2("syn_flood"))
        assert [c[0] for c in instance.rec.commands] == ["CUT_UPLINK"]
    finally:
        instance.core.close()


def test_evidence_after_a_confirmed_block_is_a_bypass_and_cuts(env):
    send(env, v2("syn_flood"))
    tick(env, graduated_response.POST_BLOCK_GRACE_SEC + 1)
    send(env, v2("syn_flood"))
    assert [c[0] for c in env.rec.commands] == ["CUT_UPLINK"]


def test_a_disarmed_core_never_cuts(env):
    env.core.supervisor.status.armed = "DISARMED"
    send(env, v2("ssh_brute_force"))
    tick(env)
    send(env, v2("ssh_login_after_failures"))
    assert env.rec.commands == []
    assert env.rec.alerts[-1]["level"] == "CRITICAL" and env.rec.alerts[-1]["outcome"] == "CUT_DISARMED"


def test_a_dry_run_core_neither_blocks_nor_cuts(tmp_path, monkeypatch, credential):
    from dataclasses import replace

    instance = build(tmp_path, monkeypatch, credential)
    try:
        sup = instance.core.supervisor
        sup.settings = replace(sup.settings, dry_run=True)
        send(instance, v2("ssh_brute_force"))
        tick(instance)
        send(instance, v2("ssh_login_after_failures"))
        assert sup.containment.calls == [] and instance.rec.commands == []
        assert instance.rec.alerts[-1]["outcome"] == "DRY_RUN"
    finally:
        instance.core.close()


def test_a_device_normal_status_ends_the_episode(env):
    send(env, v2("ssh_brute_force"))
    tick(env)
    send(env, v2("ssh_login_after_failures"))
    assert env.core.supervisor.graduated.auto_cut_latched
    env.core.supervisor._handle_status("NORMAL", -40, 100000)
    assert not env.core.supervisor.graduated.auto_cut_latched


def test_a_refused_address_is_never_scored(env):
    response = send(env, v2("port_scan", "127.0.0.1"))
    assert response["ok"] is False
    assert env.core.supervisor.containment.calls == [] and env.rec.alerts == []


# --------------------------------------------------------------------------- ingress contract


@pytest.mark.parametrize("kind", ["containment_failed", "post_containment_activity", "distributed_attack", "generic",
                                  "CUT_UPLINK", "", 7, None])
def test_core_only_unknown_or_non_string_kinds_are_refused(env, kind):
    response = send(env, {"v": 2, "attacker_ip": IP, "kind": kind})
    assert (response["ok"], response["code"]) == (False, "MALFORMED_REQUEST")
    assert env.core.supervisor.containment.calls == []


@pytest.mark.parametrize("body", [
    {"v": 1, "attacker_ip": IP, "kind": "port_scan"},
    {"v": 2, "attacker_ip": IP},
    {"v": 2, "attacker_ip": IP, "kind": "port_scan", "action": "cut"},
    {"v": 3, "attacker_ip": IP, "kind": "port_scan"},
])
def test_version_and_key_sets_are_strict(env, body):
    assert send(env, body)["code"] == "MALFORMED_REQUEST"


def test_lab_profile_needs_both_flags_to_score(tmp_path, monkeypatch, credential):
    (tmp_path / "off").mkdir()
    (tmp_path / "on").mkdir()
    off = build(tmp_path / "off", monkeypatch, credential, profile="lab", enabled=True, lab_ingress=False)
    try:
        assert send(off, v2("port_scan"))["code"] == "NOT_PRODUCTION"
        assert off.rec.alerts == [] and off.core.supervisor.containment.calls == []
    finally:
        off.core.close()
    on = build(tmp_path / "on", monkeypatch, credential, profile="lab", enabled=True, lab_ingress=True)
    try:
        response = send(on, v2("port_scan"))
        assert (response["ok"], response["code"]) == (True, "OBSERVED")
        assert on.core.supervisor.containment.calls == [("block", IP)]
        assert db.get_open_incident() is None  # the lab path never binds a production incident
    finally:
        on.core.close()


def test_the_lab_ingress_flag_alone_does_nothing_without_the_graduated_response(monkeypatch):
    monkeypatch.setattr(config, "GRADUATED_RESPONSE", "")
    monkeypatch.setattr(config, "LAB_ALERT_INGRESS", "YES")
    assert config.lab_alert_ingress_enabled() is False


# --------------------------------------------------------------------------- Telegram text


@pytest.mark.parametrize("language, expected", [
    ("th", "ความรุนแรงระดับวิกฤต"), ("en", "Critical severity"), ("zh", "危急严重性"), ("xx", "Critical severity"),
])
def test_severity_alert_is_localized(language, expected):
    text = comms.format_severity_alert(
        level="CRITICAL", action="AUTO_CUT", outcome="CUT_SENT", address=IP, score=140,
        reasons=("ssh_brute_force+40", "ssh_login_after_failures+100"), mitre=("T1078", "T1110"), language=language,
    )
    assert expected in text and IP in text and "140" in text
    assert "T1078, T1110" in text


def test_severity_alert_text_cannot_break_telegram_markdown():
    text = comms.format_severity_alert(
        level="HIGH", action="RECOMMEND_CUT", outcome="RECOMMENDED", address="1.2.3.4`*_[evil](x)", score=90,
        reasons=("a`b*c",), mitre=(), language="th",
    )
    for line in text.splitlines():
        if line.startswith(("ผู้โจมตี", "หลักฐาน")):
            inside = line.split("`")[1]
            assert not set(inside) & set("`*[]()")


def test_severity_alert_is_silent_without_telegram_configuration(monkeypatch):
    sent = []
    monkeypatch.setattr(config, "TELEGRAM_BOT_TOKEN", "")
    monkeypatch.setattr(comms, "_dispatch_telegram", sent.append)
    comms.send_severity_alert(level="MEDIUM", action="SOFTWARE_BLOCK", outcome="BLOCKED", address=IP, score=30,
                              reasons=("port_scan+30",), mitre=("T1046",))
    assert sent == []


# --------------------------------------------------------------------------- sink and detector


def test_the_sink_builds_version_1_and_version_2_lines():
    assert json.loads(alert_sink.build_payload(IP)) == {"v": 1, "attacker_ip": IP}
    assert json.loads(alert_sink.build_payload(IP, "syn_flood")) == {"v": 2, "attacker_ip": IP, "kind": "syn_flood"}
    with pytest.raises(ValueError):
        alert_sink.build_payload(IP, "containment_failed")
    assert graduated_ingress.parse_alert_with_kind(json.loads(alert_sink.build_payload(IP, "port_scan"))) == (IP, "port_scan")


def test_the_sink_reports_an_observed_lab_reply_as_sent():
    reply = json.dumps({"v": 1, "ok": True, "code": "OBSERVED"}).encode() + b"\n"
    assert alert_sink._interpret(reply) == alert_sink.AlertResult(True, alert_sink.SENT_OBSERVED)


def _record(message, **fields):
    return json.dumps({"MESSAGE": message, **fields})


def _sshd(message):
    return _record(message, _TRANSPORT="syslog", _COMM="sshd", _UID="0")


def _sshd_session(message, *, uid="0", transport="syslog"):
    return _record(message, _TRANSPORT=transport, _COMM="sshd-session", _UID=uid)


def _kernel(message):
    return _record(message, _TRANSPORT="kernel")


def recording_detector(cls=GraduatedDetector):
    sent = []
    detector = cls(lambda *args: sent.append(args) or alert_sink.AlertResult(True, "SENT_BOUND"), clock=lambda: 0.0)
    return detector, sent


def test_the_reviewed_detector_still_sends_version_1_only():
    detector, sent = recording_detector(ProductionDetector)
    for _ in range(5):
        detector.process(f"Failed password for root from {IP} port 22 ssh2")
    detector.process(f"Accepted password for root from {IP} port 22 ssh2")
    assert sent == [(IP,)]


def test_the_graduated_detector_labels_each_rule_and_reports_login_after_brute_force():
    detector, sent = recording_detector()
    for _ in range(5):
        detector.process_trusted(_sshd(f"Failed password for root from {IP} port 22 ssh2"))
    detector.process_trusted(_sshd(f"Accepted password for root from {IP} port 22 ssh2"))
    for port in range(12):
        detector.process_trusted(_kernel(f"AEGIS_NEWCONN SRC={IP} DPT={port}"))
    assert sent[:2] == [(IP, "ssh_brute_force"), (IP, "ssh_login_after_failures")]
    assert (IP, "port_scan") in sent  # a second vector from the same address is still reported


@pytest.mark.parametrize("record", [_sshd("message"), _sshd_session("message")])
def test_root_owned_sshd_and_sshd_session_records_are_trusted(record):
    assert graduated_detector.trusted_record(record) == (graduated_detector.SOURCE_SSHD, "message")


def test_non_root_sshd_session_records_are_rejected():
    assert graduated_detector.trusted_record(_sshd_session("message", uid="1000")) is None


def test_forged_logger_records_are_rejected():
    forged = f"Failed password for root from {IP} port 22 ssh2"
    assert graduated_detector.trusted_record(
        _record(forged, _TRANSPORT="syslog", _COMM="logger", _UID="1000")
    ) is None


@pytest.mark.parametrize("transport", ["audit", "driver"])
def test_sshd_session_records_from_untrusted_transports_are_rejected(transport):
    assert graduated_detector.trusted_record(_sshd_session("message", transport=transport)) is None


def test_kernel_records_remain_trusted():
    message = f"AEGIS_NEWCONN SRC={IP} DPT=443"
    assert graduated_detector.trusted_record(_kernel(message)) == (graduated_detector.SOURCE_KERNEL, message)


def test_five_root_sshd_session_failures_inside_thirty_seconds_are_required_for_an_alert():
    detector, sent = recording_detector()
    failure = _sshd_session(f"Failed password for root from {IP} port 22 ssh2")
    for _ in range(4):
        detector.process_trusted(failure)
    assert sent == []
    detector.process_trusted(failure)
    assert sent == [(IP, "ssh_brute_force")]


def test_ssh_failure_windows_are_isolated_by_source_address():
    detector, sent = recording_detector()
    for _ in range(4):
        detector.process_trusted(_sshd_session(f"Failed password for root from {IP} port 22 ssh2"))
        detector.process_trusted(_sshd_session(f"Failed password for root from {OTHER_IP} port 22 ssh2"))
    assert sent == []
    detector.process_trusted(_sshd_session(f"Failed password for root from {OTHER_IP} port 22 ssh2"))
    assert sent == [(OTHER_IP, "ssh_brute_force")]


def test_a_login_without_prior_failures_or_with_a_forged_user_name_is_not_reported():
    detector, sent = recording_detector()
    detector.process_trusted(_sshd(f"Accepted password for root from {IP} port 22 ssh2"))
    for _ in range(5):
        detector.process_trusted(_sshd(f"Failed password for root from {OTHER_IP} port 22 ssh2"))
    # The user name carries the brute-forced address, but sshd's own tail names the real source.
    detector.process_trusted(_sshd(f"Accepted password for x-from-{OTHER_IP} from {IP} port 22 ssh2"))
    assert sent == [(OTHER_IP, "ssh_brute_force")]


def test_the_graduated_detector_trusts_only_kernel_and_root_sshd_records():
    detector, sent = recording_detector()
    forged = f"Failed password for root from {IP} port 22 ssh2"
    for _ in range(10):  # a local user's logger(1) lines, and plain text
        detector.process_trusted(_record(forged, _TRANSPORT="syslog", _COMM="logger", _UID="1000"))
        detector.process_trusted(_record(forged, _TRANSPORT="syslog", _COMM="sshd", _UID="1000"))
        detector.process_trusted(_record(f"AEGIS_NEWCONN SRC={IP} DPT=1", _TRANSPORT="syslog", _COMM="logger", _UID="1000"))
        detector.process(forged)
    assert sent == []
    for port in range(20):  # sshd text never reaches the netfilter rules
        detector.process_trusted(_sshd(f"AEGIS_NEWCONN SRC={OTHER_IP} DPT={port}"))
    assert sent == []
    assert graduated_detector.trusted_record("not json") is None
    assert graduated_detector.trusted_record(json.dumps({"MESSAGE": [1, 2], "_TRANSPORT": "kernel"})) is None


def test_the_graduated_follower_argv_is_a_constant_kernel_or_sshd_match():
    from aegis_soc import production_detector as pd

    assert graduated_detector.TRUSTED_JOURNAL_ARGV == (
        "journalctl", "-f", "-n", "0", "-o", "json", "_TRANSPORT=kernel", "+",
        "_COMM=sshd", "_COMM=sshd-session", "_UID=0",
    )
    assert pd.JOURNAL_ARGV == ("journalctl", "-f", "-n", "0", "-o", "cat")  # the reviewed follower is unchanged


def test_the_graduated_detector_has_no_mqtt_network_or_command_primitive():
    import ast
    import inspect

    tree = ast.parse(inspect.getsource(graduated_detector))
    imported = {alias.name.split(".")[0] for node in ast.walk(tree) if isinstance(node, ast.Import) for alias in node.names}
    assert not imported & {"paho", "socket", "ssl", "urllib", "http", "os"}
    called = {node.func.attr if isinstance(node.func, ast.Attribute) else getattr(node.func, "id", "")
              for node in ast.walk(tree) if isinstance(node, ast.Call)}
    assert not called & {"issue_command", "publish", "block", "send_webhook_alert"}


def test_the_core_writes_a_bounded_read_only_projection_for_the_desktop(env):
    send(env, v2("ssh_brute_force"))
    tick(env)
    send(env, v2("ssh_login_after_failures"))
    path = env.core.supervisor.graduated_status_path()
    data = json.loads(path.read_text())
    assert data["v"] == 1 and data["highest_level"] == "CRITICAL" and data["auto_cut_latched"] is True
    assert [d["level"] for d in data["decisions"]] == ["MEDIUM", "CRITICAL"]
    assert data["decisions"][-1]["outcome"] == "CUT_SENT"
    assert oct(path.stat().st_mode & 0o777) == "0o640"
    text = path.read_text()
    assert SECRET not in text and "secret" not in text.lower()
    for _ in range(30):
        tick(env, 1000)
        send(env, v2("port_scan", f"198.51.100.{_ + 1}"))
    assert len(json.loads(path.read_text())["decisions"]) <= 10


def test_the_lab_alert_socket_is_honoured_only_on_a_lab_core_with_both_flags(monkeypatch):
    monkeypatch.setattr(config, "LAB_ALERT_SOCKET", "/run/aegis-live-alert/alert.sock")
    monkeypatch.setattr(config, "GRADUATED_RESPONSE", "YES")
    monkeypatch.setattr(config, "LAB_ALERT_INGRESS", "YES")
    assert config.alert_socket_path("lab") == "/run/aegis-live-alert/alert.sock"
    assert config.alert_socket_path("production") == config.ALERT_SOCKET_PATH
    assert config.alert_socket_path("development") == config.ALERT_SOCKET_PATH
    monkeypatch.setattr(config, "LAB_ALERT_INGRESS", "")
    assert config.alert_socket_path("lab") == config.ALERT_SOCKET_PATH
    monkeypatch.setattr(config, "LAB_ALERT_INGRESS", "YES")
    for bad in ("relative/alert.sock", "/run/aegis-live-alert/other.sock", config.ALERT_SOCKET_PATH):
        monkeypatch.setattr(config, "LAB_ALERT_SOCKET", bad)
        assert config.alert_socket_path("lab") == config.ALERT_SOCKET_PATH


def test_the_graduated_detector_socket_flag_is_strict():
    assert graduated_detector.socket_from_argv([]) == alert_sink.ALERT_SOCKET_PATH
    assert graduated_detector.socket_from_argv(["--socket", "/run/aegis-live-alert/alert.sock"]) == (
        "/run/aegis-live-alert/alert.sock")
    for bad in (["--socket"], ["--socket", "rel/alert.sock"], ["--socket", "/run/x/other.sock"],
                ["--socket", "/run/../etc/alert.sock"]):
        with pytest.raises(SystemExit):
            graduated_detector.socket_from_argv(bad)
