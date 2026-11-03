"""Remote alerts wired into the Core: scoring per source, the operator-confirmed CUT, refusal of anything forged, and proof that
the Core-local path and the lab relay are untouched.

Hermetic like test_graduated_response_core: a real supervisor over a temporary audit database, fakes for paho, the containment
helper, Telegram and the command path. Messages are fed through the subscriber's real ``handle_message`` (verifier and all);
nothing opens a broker or a socket.
"""

# ruff: noqa: F811  (pytest fixtures imported from sibling test modules)
from __future__ import annotations

import base64
import json
import os
import time

import pytest
from remote_alert_support import issue, make_ca, write
from test_core_recovery import IP, OTHER_IP, make_env  # noqa: F401
from test_graduated_response_core import _test_core_grant_dispatch, build, credential, send, tick, v2  # noqa: F401

from aegis_soc import database as db
from aegis_soc import remote_alert as ra
from aegis_soc import remote_alert_subscriber as ras
from aegis_soc import remote_response as rr

SOURCE = "beelink"
ATTACKER = "203.0.113.50"


class Remote:
    pass


@pytest.fixture
def pki(tmp_path):
    ca = make_ca()
    out = Remote()
    out.ca = write(ca, tmp_path / "pki", "ca")
    out.agent = issue(ca, ra.identity_for(SOURCE))
    out.core = write(issue(ca, "aegis-core"), tmp_path / "pki", "core")
    out.evil = issue(ca, ra.identity_for("evil"))
    out.stranger = issue(make_ca("other CA"), ra.identity_for(SOURCE))
    out.dir = tmp_path / "pki"
    return out


def remote_env(monkeypatch, pki, *, relay="DRYRUN", sources=SOURCE, enabled="YES"):
    values = {
        "AEGIS_REMOTE_ALERTS": enabled, "AEGIS_REMOTE_ALERT_BROKER_HOST": "127.0.0.1", "AEGIS_REMOTE_ALERT_BROKER_PORT": "18883",
        "AEGIS_REMOTE_ALERT_CA_FILE": str(pki.ca.cert_path), "AEGIS_REMOTE_ALERT_CORE_CERT": str(pki.core.cert_path),
        "AEGIS_REMOTE_ALERT_CORE_KEY": str(pki.core.key_path), "AEGIS_REMOTE_ALERT_CLIENT_CA_FILE": str(pki.ca.cert_path),
        "AEGIS_REMOTE_ALERT_SOURCES": sources, "AEGIS_REMOTE_RELAY_BEELINK": relay,
    }
    for key, value in values.items():
        monkeypatch.setenv(key, value)


def started(tmp_path, monkeypatch, credential, pki, *, profile="lab", relay="DRYRUN", **kwargs):
    """A lab Core with the remote ingress started (the paho connection itself is stubbed out; messages go through handle_message)."""
    remote_env(monkeypatch, pki, relay=relay)
    monkeypatch.setattr(ras.RemoteAlertSubscriber, "start", lambda self: None)
    instance = build(tmp_path, monkeypatch, credential, profile=profile, lab_ingress=profile == "lab", **kwargs)
    sup = instance.core.supervisor
    sup.protocol_time_trusted = lambda: True
    sup.start_remote_alerts()
    assert sup.remote_subscriber is not None, "the remote ingress did not start"
    instance.sup = sup
    instance.sub = sup.remote_subscriber
    return instance


def alert(pki, *, kind=ra.KIND_SSH_BRUTE_FORCE, ip=ATTACKER, identity=None):
    who = identity or pki.agent
    return ra.build_envelope(source=SOURCE, kind=kind, attacker_ip=ip, detail="seen in the local sshd journal",
                             cert_der=who.der, private_key=who.key, now=time.time())


def deliver(env, raw, topic=None):
    return env.sub.handle_message(topic or ra.topic_for(SOURCE), raw)


def rows(event_type):
    return [row for row in db.fetch_all_logs() if row[3] == event_type]


@pytest.fixture
def env(tmp_path, monkeypatch, credential, pki):
    instance = started(tmp_path, monkeypatch, credential, pki)
    instance.pki = pki
    yield instance
    instance.core.close()


# ------------------------------------------------------------------------------------- a valid signed alert is scored


def test_a_valid_signed_alert_is_accepted_and_scored_as_medium_with_its_source(env):
    assert deliver(env, alert(env.pki)) is True
    medium = rows("GRADUATED_MEDIUM")
    assert len(medium) == 1 and "source=beelink" in medium[0][4] and f"attacker_ip={ATTACKER}" in medium[0][4]
    assert env.sup.remote_response.level_of(SOURCE, ATTACKER) == "MEDIUM"
    assert rows("ALERT_REFUSED") == []


def test_a_remote_decision_never_blocks_on_this_host_or_sends_any_command(env):
    deliver(env, alert(env.pki))
    assert env.sup.containment.calls == []      # the attacked host is remote: a local firewall rule would be a false claim
    assert env.rec.commands == []
    item = json.loads(env.sup.graduated_status_path().read_text())["decisions"][-1]
    assert item["source"] == SOURCE and item["outcome"] == "REMOTE_HOST" and item["level"] == "MEDIUM"


def test_medium_then_critical_flows_and_waits_for_the_operator(env):
    assert deliver(env, alert(env.pki, kind=ra.KIND_SSH_BRUTE_FORCE))
    tick(env)
    assert deliver(env, alert(env.pki, kind=ra.KIND_SSH_LOGIN_AFTER_FAILURES))
    levels = [row[3] for row in reversed(db.fetch_all_logs()) if row[3].startswith("GRADUATED_")]   # the log lists newest first
    assert levels == ["GRADUATED_MEDIUM", "GRADUATED_CRITICAL"]
    pending = env.sup.remote_response.pending(SOURCE)
    assert pending is not None and pending.address == ATTACKER and pending.score >= 100
    assert env.rec.commands == []                                   # no automatic CUT of any relay
    assert env.sup.remote_response._targets[SOURCE].would_cut == []   # not even the (dry-run) Beelink target
    assert len(rows("REMOTE_CUT_AWAITING")) == 1
    assert json.loads(env.sup.graduated_status_path().read_text())["decisions"][-1]["outcome"] == "AWAITING_OPERATOR"


def test_the_notification_for_a_remote_critical_asks_the_operator_instead_of_claiming_a_cut(env):
    from aegis_soc import comms
    deliver(env, alert(env.pki, kind=ra.KIND_SSH_BRUTE_FORCE))
    deliver(env, alert(env.pki, kind=ra.KIND_SSH_LOGIN_AFTER_FAILURES))
    medium, critical = env.rec.alerts
    assert medium["action"] == "NONE" and medium["outcome"] == ""         # no block was made on this host
    assert critical["action"] == "RECOMMEND_CUT" and critical["outcome"] == "RECOMMENDED"
    assert "source:beelink" in critical["reasons"]
    text = comms.format_severity_alert(language="en", **critical).lower()
    assert "automatic" not in text and "cut sent" not in text


def test_the_operator_confirmed_cut_reaches_only_the_sources_relay_target(env):
    deliver(env, alert(env.pki, kind=ra.KIND_SSH_BRUTE_FORCE))
    deliver(env, alert(env.pki, kind=ra.KIND_SSH_LOGIN_AFTER_FAILURES))
    response = env.sup.remote_response
    assert response.confirm_cut(SOURCE, "203.0.113.99", operator="op").code == "NO_PENDING_CUT"   # wrong address
    assert response._targets[SOURCE].would_cut == []
    request_id = response.pending(SOURCE).request_id
    assert response.confirm_cut(SOURCE, ATTACKER, operator="op").code == "REQUEST_ID_REQUIRED"   # the confirmation is bound to one request
    result = response.confirm_cut(SOURCE, ATTACKER, operator="op", request_id=request_id)
    assert result == rr.RelayResult(True, "WOULD_CUT")
    assert len(response._targets[SOURCE].would_cut) == 1 and "operator=op" in response._targets[SOURCE].would_cut[0]
    assert env.rec.commands == []                                   # the lab relay was never involved
    assert len(rows("REMOTE_CUT_CONFIRMED")) == 1
    assert response.confirm_cut(SOURCE, ATTACKER, operator="op", request_id=request_id).code == "NO_PENDING_CUT"   # one confirmation, one CUT


def test_a_second_critical_in_the_same_episode_does_not_ask_again_until_released(env):
    deliver(env, alert(env.pki, kind=ra.KIND_SSH_BRUTE_FORCE))
    deliver(env, alert(env.pki, kind=ra.KIND_SSH_LOGIN_AFTER_FAILURES))
    response = env.sup.remote_response
    response.confirm_cut(SOURCE, ATTACKER, operator="op", request_id=response.pending(SOURCE).request_id)
    deliver(env, alert(env.pki, kind=ra.KIND_SSH_LOGIN_AFTER_FAILURES, ip="203.0.113.51"))
    assert response.pending(SOURCE) is None and response.latched(SOURCE)
    response.release_episode(SOURCE, operator="op")
    assert not response.latched(SOURCE)


# ------------------------------------------------------------------------------------- forged / unauthenticated alerts


def forged_cases(pki):
    good = json.loads(alert(pki))
    tampered = dict(good, payload=dict(good["payload"], attacker_ip="203.0.113.77"))
    no_cert = {key: value for key, value in good.items() if key != "cert"}
    unsigned = dict(good, sig="")
    return {
        "garbage": b"this is not an alert",
        "empty": b"",
        "no_certificate": json.dumps(no_cert).encode(),
        "unsigned": json.dumps(unsigned).encode(),
        "tampered_payload": json.dumps(tampered).encode(),
        "certificate_from_another_ca": alert(pki, identity=pki.stranger),
        "valid_cert_of_another_identity": alert(pki, identity=pki.evil),
        "v1_alert_shape": json.dumps({"v": 1, "attacker_ip": ATTACKER}).encode(),
    }


def test_forged_or_unauthenticated_alerts_are_refused_audited_and_never_scored(env):
    for name, raw in forged_cases(env.pki).items():
        assert deliver(env, raw) is False, name
    assert len(rows("ALERT_REFUSED")) == len(forged_cases(env.pki))
    assert all("remote source=beelink code=" in row[4] for row in rows("ALERT_REFUSED"))
    assert [row for row in db.fetch_all_logs() if row[3].startswith("GRADUATED_")] == []
    assert env.sup.remote_response.level_of(SOURCE, ATTACKER) == "LOW"
    assert env.sup.remote_response.pending(SOURCE) is None and env.rec.commands == []
    assert env.sup.containment.calls == [] and env.rec.alerts == []


def test_the_refusal_audit_carries_stable_codes_and_no_sender_text(env):
    deliver(env, alert(env.pki, identity=env.pki.stranger))
    deliver(env, b"\x00DROP TABLE audit_logs;--")
    codes = sorted(row[4].split("code=")[1].split()[0] for row in rows("ALERT_REFUSED"))
    assert codes == ["CERT_UNTRUSTED", "MALFORMED"]
    assert all("DROP" not in row[4] for row in db.fetch_all_logs())


def test_a_forged_critical_cannot_create_a_pending_cut_or_a_cut(env):
    deliver(env, alert(env.pki, identity=env.pki.evil, kind=ra.KIND_SSH_BRUTE_FORCE))
    deliver(env, alert(env.pki, identity=env.pki.evil, kind=ra.KIND_SSH_LOGIN_AFTER_FAILURES))
    assert env.sup.remote_response.pending(SOURCE) is None
    assert env.sup.remote_response.confirm_cut(SOURCE, ATTACKER, operator="op").code == "NO_PENDING_CUT"
    assert env.sup.remote_response._targets[SOURCE].would_cut == [] and env.rec.commands == []


def test_a_message_on_a_topic_of_a_source_that_is_not_allowed_is_refused(env):
    assert deliver(env, alert(env.pki), topic=ra.topic_for("stranger")) is False
    assert rows("ALERT_REFUSED")[0][4].endswith("code=SOURCE_NOT_ALLOWED") and "source=stranger" in rows("ALERT_REFUSED")[0][4]


def test_a_retained_message_is_never_scored(env):
    assert env.sub.handle_message(ra.topic_for(SOURCE), alert(env.pki), retained=True) is False
    assert rows("ALERT_REFUSED")[0][4].endswith("code=RETAINED") and rows("GRADUATED_MEDIUM") == []


def test_a_replayed_valid_alert_is_not_scored_twice(env):
    raw = alert(env.pki)
    assert deliver(env, raw) is True
    assert deliver(env, raw) is False
    assert len(rows("GRADUATED_MEDIUM")) == 1 and rows("ALERT_REFUSED")[0][4].endswith("code=REPLAY")


def test_a_flood_of_forged_alerts_cannot_flood_the_audit_table(env):
    for _ in range(200):
        deliver(env, b"forged")
    assert len(rows("ALERT_REFUSED")) <= 31          # audit burst limit; the global message limiter drops the rest earlier


# ------------------------------------------------------------------------------------- a spoofed all-clear changes nothing


def test_a_spoofed_all_clear_cannot_clear_a_real_latched_state(env):
    deliver(env, alert(env.pki, kind=ra.KIND_SSH_BRUTE_FORCE))
    deliver(env, alert(env.pki, kind=ra.KIND_SSH_LOGIN_AFTER_FAILURES))
    response = env.sup.remote_response
    assert response.latched(SOURCE) and response.pending(SOURCE) is not None
    good = json.loads(alert(env.pki))
    attempts = []
    for kind in ("all_clear", "resolved", "clear"):
        for signer in ("agent", "evil", "none"):
            payload = dict(good["payload"], kind=kind, nonce=os.urandom(16).hex())
            if signer == "none":
                attempts.append(json.dumps(dict(good, payload=payload)).encode())
                continue
            identity = env.pki.agent if signer == "agent" else env.pki.evil
            signature = ra._sign(identity.key, ra.canonical(payload))
            attempts.append(json.dumps({"v": 1, "payload": payload, "cert": base64.b64encode(identity.der).decode(),
                                        "sig": base64.b64encode(signature).decode()}).encode())
    attempts.append(json.dumps({"v": 1, "state": "NORMAL", "attacker_ip": ATTACKER}).encode())
    assert not any(deliver(env, raw) for raw in attempts)
    assert response.latched(SOURCE) and response.pending(SOURCE) is not None
    assert response.level_of(SOURCE, ATTACKER) == "CRITICAL"
    assert response.confirm_cut(SOURCE, ATTACKER, operator="op", request_id=response.pending(SOURCE).request_id).ok   # the real pending CUT is still there to confirm


def test_no_message_can_release_an_episode_only_an_explicit_operator_call(env):
    deliver(env, alert(env.pki, kind=ra.KIND_SSH_BRUTE_FORCE))
    deliver(env, alert(env.pki, kind=ra.KIND_SSH_LOGIN_AFTER_FAILURES))
    for _ in range(5):
        deliver(env, alert(env.pki, kind=ra.KIND_SSH_BRUTE_FORCE, ip="203.0.113.60"))
    assert env.sup.remote_response.latched(SOURCE)
    env.sup.remote_response.release_episode(SOURCE, operator="op")
    assert not env.sup.remote_response.latched(SOURCE)


# ------------------------------------------------------------------------------------- the local path and the lab relay stay separate


def test_the_core_local_alert_path_uses_the_same_confirmation_gate_as_remote_alerts(env):
    shared_gate = env.sup.remote_response
    assert send(env, v2("ssh_brute_force", IP))["code"] == "OBSERVED"   # the lab Core scores without binding an incident
    assert env.sup.containment.calls == [("block", IP)]                  # local evidence still blocks locally
    tick(env)
    send(env, v2("ssh_login_after_failures", IP))
    assert env.sup.remote_response is shared_gate
    assert shared_gate.pending(rr.LOCAL_SOURCE).address == IP
    assert env.rec.commands == []


def test_remote_evidence_and_local_evidence_are_scored_independently(env):
    deliver(env, alert(env.pki, kind=ra.KIND_SSH_BRUTE_FORCE, ip=IP))
    deliver(env, alert(env.pki, kind=ra.KIND_SSH_LOGIN_AFTER_FAILURES, ip=IP))
    assert env.sup.remote_response.latched(SOURCE)
    assert env.sup.graduated.auto_cut_latched is False                    # a remote CRITICAL never latches the local engine
    assert env.sup.graduated.level_of(IP) == "LOW"
    send(env, v2("ssh_brute_force", IP))
    assert env.sup.graduated.level_of(IP) == "MEDIUM"                    # and local scoring did not inherit remote evidence
    assert json.loads(env.sup.graduated_status_path().read_text())["cut_recommended_for"] is None


def test_a_remote_decision_never_sets_the_desktops_cut_recommendation(env):
    deliver(env, alert(env.pki, kind=ra.KIND_SSH_BRUTE_FORCE))
    deliver(env, alert(env.pki, kind=ra.KIND_SSH_LOGIN_AFTER_FAILURES))
    status = json.loads(env.sup.graduated_status_path().read_text())
    assert status["cut_recommended_for"] is None and status["auto_cut_latched"] is False
    assert status["highest_level"] == "CRITICAL"            # visible to the operator, but not wired to the lab relay's CUT button


def test_without_a_configured_relay_target_a_confirmed_cut_is_refused_not_sent_elsewhere(tmp_path, monkeypatch, credential, pki):
    instance = started(tmp_path, monkeypatch, credential, pki, relay="NONE")
    try:
        deliver(instance, alert(pki, kind=ra.KIND_SSH_BRUTE_FORCE))
        deliver(instance, alert(pki, kind=ra.KIND_SSH_LOGIN_AFTER_FAILURES))
        response = instance.sup.remote_response
        result = response.confirm_cut(SOURCE, ATTACKER, operator="op", request_id=response.pending(SOURCE).request_id)
        assert result == rr.RelayResult(False, "NO_RELAY_TARGET")
        assert instance.rec.commands == []                                # the lab relay is not a fallback
        assert instance.sup.remote_response.pending(SOURCE) is not None   # the request stays pending
        assert len(rows("REMOTE_CUT_FAILED")) == 1
    finally:
        instance.core.close()


def test_the_lab_relay_mapping_is_explicit_lab_only_and_only_after_confirmation(tmp_path, monkeypatch, credential, pki):
    instance = started(tmp_path, monkeypatch, credential, pki, relay="LAB_RELAY")
    try:
        deliver(instance, alert(pki, kind=ra.KIND_SSH_BRUTE_FORCE))
        deliver(instance, alert(pki, kind=ra.KIND_SSH_LOGIN_AFTER_FAILURES))
        assert instance.rec.commands == []
        response = instance.sup.remote_response
        request_id = response.pending(SOURCE).request_id
        assert response.confirm_cut(SOURCE, ATTACKER, operator="op", request_id=request_id).code == "CUT_AUTHORIZATION_REQUIRED"
        assert instance.rec.commands == []                                # no Core grant, no physical command
        assert response.confirm_cut(SOURCE, ATTACKER, operator="op", request_id=request_id,
                                    physical_cut=_test_core_grant_dispatch(instance.sup)).code == "CUT_SENT"
        action, _description, kwargs = instance.rec.commands[0]
        assert action == "CUT_UPLINK" and kwargs["origin"] == "remote-alert:beelink" and kwargs["critical"] is True
    finally:
        instance.core.close()


def test_the_lab_relay_mapping_is_refused_outside_the_lab_profile(monkeypatch, pki):
    remote_env(monkeypatch, pki, relay="LAB_RELAY")
    with pytest.raises(ras.SettingsError) as info:
        ras.load_settings(os.environ, profile="production")
    assert info.value.code == "LAB_RELAY_NOT_ALLOWED"
    assert ras.load_settings(os.environ, profile="lab").relays == {SOURCE: "LAB_RELAY"}


# ------------------------------------------------------------------------------------- fail-closed configuration


def test_the_ingress_is_inert_unless_explicitly_enabled(tmp_path, monkeypatch, credential, pki):
    remote_env(monkeypatch, pki, enabled="")
    instance = build(tmp_path, monkeypatch, credential, profile="lab", lab_ingress=True)
    try:
        instance.core.supervisor.start_remote_alerts()
        assert instance.core.supervisor.remote_subscriber is None and instance.core.supervisor.remote_response is None
    finally:
        instance.core.close()


@pytest.mark.parametrize("missing", ["AEGIS_REMOTE_ALERT_BROKER_HOST", "AEGIS_REMOTE_ALERT_CA_FILE", "AEGIS_REMOTE_ALERT_CORE_CERT",
                                     "AEGIS_REMOTE_ALERT_CORE_KEY", "AEGIS_REMOTE_ALERT_CLIENT_CA_FILE", "AEGIS_REMOTE_ALERT_SOURCES"])
def test_a_half_configured_ingress_does_not_start(tmp_path, monkeypatch, credential, pki, missing):
    remote_env(monkeypatch, pki)
    monkeypatch.delenv(missing)
    instance = build(tmp_path, monkeypatch, credential, profile="lab", lab_ingress=True)
    try:
        instance.core.supervisor.start_remote_alerts()
        assert instance.core.supervisor.remote_subscriber is None
    finally:
        instance.core.close()


def test_the_ingress_needs_the_graduated_response(tmp_path, monkeypatch, credential, pki):
    remote_env(monkeypatch, pki)
    instance = build(tmp_path, monkeypatch, credential, profile="lab", enabled=False)
    try:
        instance.core.supervisor.start_remote_alerts()
        assert instance.core.supervisor.remote_subscriber is None
    finally:
        instance.core.close()


def test_the_core_key_must_not_be_readable_by_others(monkeypatch, pki):
    remote_env(monkeypatch, pki)
    pki.core.key_path.chmod(0o644)
    with pytest.raises(ras.SettingsError) as info:
        ras.load_settings(os.environ, profile="lab")
    assert info.value.code == "CORE_KEY_PERMISSIONS"


def test_source_ids_and_pins_are_validated(monkeypatch, pki):
    for bad in ("", "Bad Source", "beelink,beelink", "a/b"):
        remote_env(monkeypatch, pki, sources=bad)
        with pytest.raises(ras.SettingsError) as info:
            ras.load_settings(os.environ, profile="lab")
        assert info.value.code == "SOURCES_INVALID"
    remote_env(monkeypatch, pki)
    monkeypatch.setenv("AEGIS_REMOTE_ALERT_PIN_BEELINK", "not-a-digest")
    with pytest.raises(ras.SettingsError) as info:
        ras.load_settings(os.environ, profile="lab")
    assert info.value.code == "PIN_INVALID"


def test_an_untrusted_core_clock_refuses_remote_alerts(tmp_path, monkeypatch, credential, pki):
    instance = started(tmp_path, monkeypatch, credential, pki)
    try:
        instance.sup.protocol_time_trusted = lambda: False
        assert deliver(instance, alert(pki)) is False
        assert rows("ALERT_REFUSED")[0][4].endswith("code=CLOCK_UNTRUSTED") and rows("GRADUATED_MEDIUM") == []
    finally:
        instance.core.close()


def test_the_supervisor_has_no_static_import_of_the_remote_components_or_cryptography():
    """The governed release builder derives the Core closure and its pinned third-party set from static imports. The remote
    ingress is an optional component loaded by name, so the governed closure and requirements stay exactly as reviewed."""
    import ast
    from pathlib import Path

    tree = ast.parse((Path(__file__).resolve().parents[1] / "aegis_soc" / "supervisor.py").read_text())
    imported = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            imported.add((node.module or "").split(".")[0])
            imported.update(alias.name for alias in node.names)
        elif isinstance(node, ast.Import):
            imported.update(alias.name.split(".")[0] for alias in node.names)
    assert imported.isdisjoint({"remote_alert", "remote_alert_subscriber", "remote_response", "cryptography"}), imported


def test_a_release_without_the_remote_components_has_no_remote_ingress_and_says_so(tmp_path, monkeypatch, credential, pki):
    from aegis_soc import supervisor as supervisor_module

    remote_env(monkeypatch, pki)
    monkeypatch.setattr(supervisor_module, "_load_remote_alert_components", lambda: None)
    instance = build(tmp_path, monkeypatch, credential, profile="lab", lab_ingress=True)
    try:
        events = []
        monkeypatch.setattr(instance.core.supervisor, "log_event", lambda level, event, **detail: events.append((event, detail)))
        instance.core.supervisor.start_remote_alerts()
        assert instance.core.supervisor.remote_subscriber is None and instance.core.supervisor.remote_response is None
        assert events == [("remote_alerts_failed", {"error": "REMOTE_ALERTS_COMPONENT_MISSING"})]
    finally:
        instance.core.close()
