"""End to end on a DISPOSABLE lab broker: agent (subprocess, fixture journal) -> real mutual-TLS MQTT -> Core ingress -> graduated
scoring -> operator-confirmed CUT of a dry-run relay target.

The broker is a private mosquitto on 127.0.0.1 with throwaway certificates in a temporary directory: it never touches the running
lab broker, the real relay, the real Beelink or any production host. Skipped when mosquitto or cryptography is unavailable.
"""

# ruff: noqa: F811  (pytest fixtures imported from sibling test modules)
from __future__ import annotations

import json
import shutil
import socket
import ssl
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest
from remote_alert_support import issue, make_ca, write
from test_graduated_response_core import build, credential, send, v2  # noqa: F401
from test_remote_response_core import ATTACKER, SOURCE, remote_env, rows

from aegis_soc import database as db
from aegis_soc import remote_alert as ra
from aegis_soc import remote_response as rr

paho = pytest.importorskip("paho.mqtt.client")
import paho.mqtt.client as mqtt

MOSQUITTO = shutil.which("mosquitto")
pytestmark = pytest.mark.skipif(MOSQUITTO is None, reason="mosquitto is not installed")

ROOT = Path(__file__).resolve().parents[1]
AGENT = ROOT / "tools" / "aegis_beelink_agent.py"
ACL = """user aegis-core
topic read aegis/alert/beelink

user aegis-alert-beelink
topic write aegis/alert/beelink
"""


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class Lab:
    pass


@pytest.fixture(scope="module")
def pki(tmp_path_factory):
    base = tmp_path_factory.mktemp("remote-alert-pki")
    ca = make_ca()
    lab = Lab()
    lab.dir = base
    lab.ca = write(ca, base, "ca")
    lab.broker = write(issue(ca, "localhost", client_auth=False, server_auth=True, san_dns=("localhost",)), base, "broker")
    lab.core = write(issue(ca, "aegis-core"), base, "core")
    lab.agent = write(issue(ca, ra.identity_for(SOURCE)), base, "agent")
    lab.evil = write(issue(ca, ra.identity_for("evil")), base, "evil")
    return lab


def start_broker(tmp_path, pki, *, acl: bool):
    port = free_port()
    conf = tmp_path / "mosquitto.conf"
    lines = [
        f"listener {port} 127.0.0.1", "protocol mqtt", f"cafile {pki.ca.cert_path}", f"certfile {pki.broker.cert_path}",
        f"keyfile {pki.broker.key_path}", "tls_version tlsv1.2", "require_certificate true", "use_identity_as_username true",
        "allow_anonymous false", "persistence false", "max_packet_size 8192", f"log_dest file {tmp_path / 'broker.log'}",
    ]
    if acl:
        (tmp_path / "acl").write_text(ACL)
        (tmp_path / "acl").chmod(0o600)   # mosquitto insists on an owner-only ACL file
        lines.append(f"acl_file {tmp_path / 'acl'}")
    conf.write_text("\n".join(lines) + "\n")
    process = subprocess.Popen([MOSQUITTO, "-c", str(conf)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    deadline = time.time() + 10
    while time.time() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.5):
                break
        except OSError:
            time.sleep(0.1)
    else:
        process.kill()
        pytest.skip("the disposable broker did not start")
    return process, port


@pytest.fixture
def strict_broker(tmp_path, pki):
    process, port = start_broker(tmp_path, pki, acl=True)
    yield port
    process.terminate()
    process.wait(timeout=5)


@pytest.fixture
def open_broker(tmp_path, pki):
    """Authenticated clients may do anything: stands in for a misconfigured broker, to prove the Core does not rely on it."""
    process, port = start_broker(tmp_path, pki, acl=False)
    yield port
    process.terminate()
    process.wait(timeout=5)


def core_env(tmp_path, monkeypatch, credential, pki, port, relay="DRYRUN"):
    remote_env(monkeypatch, pki, relay=relay)
    monkeypatch.setenv("AEGIS_REMOTE_ALERT_BROKER_PORT", str(port))
    monkeypatch.setenv("AEGIS_REMOTE_ALERT_BROKER_HOST", "127.0.0.1")
    instance = build(tmp_path, monkeypatch, credential, profile="lab", lab_ingress=True)
    sup = instance.core.supervisor
    sup.protocol_time_trusted = lambda: True
    sup.start_remote_alerts()
    assert sup.remote_subscriber is not None
    assert sup.remote_subscriber.connected.wait(10), "the Core ingress did not connect to the broker"
    instance.sup = sup
    return instance


def agent_env(pki, port):
    return {
        "AEGIS_BEELINK_BROKER_HOST": "127.0.0.1", "AEGIS_BEELINK_BROKER_PORT": str(port), "AEGIS_BEELINK_CA_FILE": str(pki.ca.cert_path),
        "AEGIS_BEELINK_CLIENT_CERT": str(pki.agent.cert_path), "AEGIS_BEELINK_CLIENT_KEY": str(pki.agent.key_path),
        "AEGIS_BEELINK_SOURCE": SOURCE, "PATH": "/usr/bin:/bin",
    }


def journal(tmp_path, lines):
    path = tmp_path / "fixture-journal.jsonl"
    path.write_text("\n".join(lines) + "\n")
    return path


def jrec(message, **fields):
    base = {"MESSAGE": message, "_COMM": "sshd-session", "_UID": "0", "_TRANSPORT": "syslog"}
    base.update(fields)
    return json.dumps(base)


def run_agent(tmp_path, pki, port, lines):
    return subprocess.run([sys.executable, str(AGENT), "--fixture", str(journal(tmp_path, lines))], env=agent_env(pki, port),
                          capture_output=True, text=True, timeout=60, cwd=str(ROOT), check=False)


def wait_for(predicate, seconds=10.0):
    deadline = time.time() + seconds
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(0.1)
    return False


def levels():
    return [row[3] for row in reversed(db.fetch_all_logs()) if row[3].startswith("GRADUATED_")]


def raw_client(identity, pki, port, name):
    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=name, protocol=mqtt.MQTTv311)
    context = ssl.create_default_context(cafile=str(pki.ca.cert_path))
    if identity is not None:
        context.load_cert_chain(str(identity.cert_path), str(identity.key_path))
    client.tls_set_context(context)
    state = {"connected": threading.Event()}
    client.on_connect = lambda c, u, f, rc, p=None: state["connected"].set() if not rc.is_failure else None
    client.connect_async("127.0.0.1", port)
    client.loop_start()
    return client, state


# ------------------------------------------------------------------------------------- the lab flow


def test_agent_to_core_to_a_pending_cut_over_real_mutual_tls(tmp_path, monkeypatch, credential, pki, strict_broker):
    env = core_env(tmp_path, monkeypatch, credential, pki, strict_broker)
    try:
        fail = [jrec(f"Failed password for root from {ATTACKER} port {4000 + n} ssh2") for n in range(5)]
        ok = jrec(f"Accepted password for root from {ATTACKER} port 4999 ssh2")
        result = run_agent(tmp_path, pki, strict_broker, fail + [ok])
        assert result.returncode == 0, result.stdout + result.stderr
        assert wait_for(lambda: levels() == ["GRADUATED_MEDIUM", "GRADUATED_CRITICAL"]), levels()
        response = env.sup.remote_response
        assert response.pending(SOURCE) is not None and response.latched(SOURCE)
        assert env.rec.commands == []                       # the lab relay was NOT triggered
        assert env.sup.containment.calls == []              # and nothing was blocked on this host
        assert response._targets[SOURCE].would_cut == []    # operator confirmation intact: nothing is sent before it
        assert rows("ALERT_REFUSED") == []
        request_id = response.pending(SOURCE).request_id
        assert response.confirm_cut(SOURCE, ATTACKER, operator="lab-operator", request_id=request_id) == rr.RelayResult(True, "WOULD_CUT")
        assert len(response._targets[SOURCE].would_cut) == 1 and env.rec.commands == []
        status = json.loads(env.sup.graduated_status_path().read_text())
        assert [d["source"] for d in status["decisions"]] == [SOURCE, SOURCE] and status["cut_recommended_for"] is None
    finally:
        env.sup.stop_remote_alerts()
        env.core.close()


def test_the_local_detector_path_is_unchanged_while_the_remote_ingress_runs(tmp_path, monkeypatch, credential, pki, strict_broker):
    env = core_env(tmp_path, monkeypatch, credential, pki, strict_broker)
    try:
        run_agent(tmp_path, pki, strict_broker, [jrec(f"Failed password for root from {ATTACKER} port {n} ssh2") for n in range(5)])
        assert wait_for(lambda: "GRADUATED_MEDIUM" in levels())
        from test_core_recovery import IP
        assert send(env, v2("ssh_brute_force", IP))["code"] == "OBSERVED"
        assert env.sup.containment.calls == [("block", IP)]
        assert env.sup.graduated.level_of(IP) == "MEDIUM" and env.sup.graduated.level_of(ATTACKER) == "LOW"
    finally:
        env.sup.stop_remote_alerts()
        env.core.close()


def test_untrusted_local_lines_on_the_protected_host_produce_no_alert_end_to_end(tmp_path, monkeypatch, credential, pki, strict_broker):
    env = core_env(tmp_path, monkeypatch, credential, pki, strict_broker)
    try:
        forged = [jrec(f"Failed password for root from {ATTACKER} port {n} ssh2", _UID="1000", _COMM="logger") for n in range(10)]
        assert run_agent(tmp_path, pki, strict_broker, forged).returncode == 0
        time.sleep(1.5)
        assert levels() == [] and rows("ALERT_REFUSED") == []
    finally:
        env.sup.stop_remote_alerts()
        env.core.close()


# ------------------------------------------------------------------------------------- the broker refuses strangers (layer 1)


def test_a_client_with_no_certificate_cannot_connect_to_the_broker(pki, strict_broker):
    client, state = raw_client(None, pki, strict_broker, "no-cert")
    try:
        assert not state["connected"].wait(3)
    finally:
        client.loop_stop()


def test_a_client_with_a_certificate_from_another_ca_cannot_connect_to_the_broker(tmp_path, pki, strict_broker):
    stranger = write(issue(make_ca("someone else"), ra.identity_for(SOURCE)), tmp_path, "stranger")
    client, state = raw_client(stranger, pki, strict_broker, "stranger")
    try:
        assert not state["connected"].wait(3)
    finally:
        client.loop_stop()


def test_a_valid_but_other_identity_cannot_publish_to_the_beelink_topic(tmp_path, monkeypatch, credential, pki, strict_broker):
    env = core_env(tmp_path, monkeypatch, credential, pki, strict_broker)
    client, state = raw_client(pki.evil, pki, strict_broker, "evil")
    try:
        assert state["connected"].wait(5)
        forged = ra.build_envelope(source=SOURCE, kind="ssh_brute_force", attacker_ip=ATTACKER, detail="x",
                                   cert_der=pki.evil.der, private_key=pki.evil.key)
        client.publish("aegis/alert/beelink", forged, qos=1).wait_for_publish(3)
        time.sleep(1.5)
        assert levels() == [] and rows("ALERT_REFUSED") == []    # the ACL dropped it before the Core ever saw it
    finally:
        client.loop_stop()
        env.sup.stop_remote_alerts()
        env.core.close()


# ------------------------------------------------------------------------------------- the Core does not rely on the broker (layer 2)


def test_even_through_a_permissive_broker_a_forged_alert_is_refused_by_the_core(tmp_path, monkeypatch, credential, pki, open_broker):
    env = core_env(tmp_path, monkeypatch, credential, pki, open_broker)
    evil, evil_state = raw_client(pki.evil, pki, open_broker, "evil")
    legit, legit_state = raw_client(pki.agent, pki, open_broker, "legit-connection")
    try:
        assert evil_state["connected"].wait(5) and legit_state["connected"].wait(5)
        forged = ra.build_envelope(source=SOURCE, kind="ssh_brute_force", attacker_ip=ATTACKER, detail="x",
                                   cert_der=pki.evil.der, private_key=pki.evil.key)
        evil.publish("aegis/alert/beelink", forged, qos=1).wait_for_publish(3)
        legit.publish("aegis/alert/beelink", b"unsigned text from a client that does hold a connection certificate", qos=1).wait_for_publish(3)
        assert wait_for(lambda: len(rows("ALERT_REFUSED")) == 2)
        codes = sorted(row[4].split("code=")[1].split()[0] for row in rows("ALERT_REFUSED"))
        assert codes == ["CERT_IDENTITY_MISMATCH", "MALFORMED"]
        assert levels() == [] and env.sup.remote_response.pending(SOURCE) is None
        assert env.rec.commands == [] and env.sup.containment.calls == []
    finally:
        evil.loop_stop()
        legit.loop_stop()
        env.sup.stop_remote_alerts()
        env.core.close()


def test_a_spoofed_all_clear_over_a_permissive_broker_cannot_clear_a_latched_state(tmp_path, monkeypatch, credential, pki, open_broker):
    env = core_env(tmp_path, monkeypatch, credential, pki, open_broker)
    legit, state = raw_client(pki.agent, pki, open_broker, "legit-connection")
    try:
        assert state["connected"].wait(5)
        for kind in ("ssh_brute_force", "ssh_login_after_failures"):
            legit.publish("aegis/alert/beelink", ra.build_envelope(source=SOURCE, kind=kind, attacker_ip=ATTACKER, detail="x",
                          cert_der=pki.agent.der, private_key=pki.agent.key), qos=1).wait_for_publish(3)
        assert wait_for(lambda: levels() == ["GRADUATED_MEDIUM", "GRADUATED_CRITICAL"])
        import base64
        payload = {"at": time.time(), "kind": "all_clear", "attacker_ip": ATTACKER, "detail": "x", "source": SOURCE, "nonce": "cd" * 16}
        spoof = json.dumps({"v": 1, "payload": payload, "cert": base64.b64encode(pki.agent.der).decode(),
                            "sig": base64.b64encode(ra._sign(pki.agent.key, ra.canonical(payload))).decode()}).encode()
        legit.publish("aegis/alert/beelink", spoof, qos=1).wait_for_publish(3)
        assert wait_for(lambda: len(rows("ALERT_REFUSED")) == 1)
        assert rows("ALERT_REFUSED")[0][4].endswith("code=BAD_KIND")
        assert env.sup.remote_response.latched(SOURCE) and env.sup.remote_response.pending(SOURCE) is not None
    finally:
        legit.loop_stop()
        env.sup.stop_remote_alerts()
        env.core.close()
