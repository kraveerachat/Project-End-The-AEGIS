"""The Beelink detection agent: trusted local journal only, signed alerts only, no command surface. No broker, no real journal."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import pytest
from remote_alert_support import issue, make_ca, write

from aegis_soc import alert_sink
from aegis_soc import graduated_detector as gd
from aegis_soc import production_detector as pd
from aegis_soc import remote_alert as ra

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
import aegis_beelink_agent as agent

ATTACKER = "203.0.113.50"
SOURCE = "beelink"
ROOT = Path(__file__).resolve().parents[1]


def record(message, *, comm="sshd-session", uid="0", transport="syslog"):
    return json.dumps({"MESSAGE": message, "_COMM": comm, "_UID": uid, "_TRANSPORT": transport})


def failed(ip=ATTACKER, count=5):
    return [record(f"Failed password for root from {ip} port {4000 + n} ssh2") for n in range(count)]


def accepted(ip=ATTACKER):
    return record(f"Accepted password for root from {ip} port 4999 ssh2")


class FakeInfo:
    rc = 0

    def wait_for_publish(self, timeout=None):
        pass

    def is_published(self):
        return True


class FakeClient:
    def __init__(self, *, connect=True):
        self.published = []
        self._connect = connect
        self.on_connect = None
        self.on_disconnect = None

    def tls_set_context(self, context):
        self.context = context

    def reconnect_delay_set(self, **kwargs):
        pass

    def connect_async(self, host, port, keepalive=60):
        self.target = (host, port)

    def loop_start(self):
        if self._connect:
            self.on_connect(self, None, {}, 0)

    def loop_stop(self):
        pass

    def disconnect(self):
        pass

    def publish(self, topic, payload, qos=0, retain=False):
        self.published.append((topic, payload, qos, retain))
        return FakeInfo()


@pytest.fixture
def pki(tmp_path):
    ca = make_ca()
    out = type("P", (), {})()
    out.ca = write(ca, tmp_path / "pki", "ca")
    out.agent = write(issue(ca, ra.identity_for(SOURCE)), tmp_path / "pki", "agent")
    return out


def config_for(pki, **overrides):
    env = {"AEGIS_BEELINK_BROKER_HOST": "127.0.0.1", "AEGIS_BEELINK_BROKER_PORT": "8883",
           "AEGIS_BEELINK_CA_FILE": str(pki.ca.cert_path), "AEGIS_BEELINK_CLIENT_CERT": str(pki.agent.cert_path),
           "AEGIS_BEELINK_CLIENT_KEY": str(pki.agent.key_path), "AEGIS_BEELINK_SOURCE": SOURCE}
    env.update(overrides)
    return env


def make_publisher(pki, *, connect=True):
    config = agent.load_config(config_for(pki))
    client = FakeClient(connect=connect)
    publisher = agent.AlertPublisher(config, client_factory=lambda: client)
    wait, agent.CONNECT_WAIT_SEC = agent.CONNECT_WAIT_SEC, (5.0 if connect else 0.05)   # do not sit out the 10 s wait for a broker that is not there
    try:
        publisher.start()
    finally:
        agent.CONNECT_WAIT_SEC = wait
    return publisher, client


def verifier(pki):
    return ra.RemoteAlertVerifier(ca_pem_chunks=[pki.ca.pem], sources={SOURCE: ra.SourcePolicy(ra.identity_for(SOURCE))})


# --------------------------------------------------------------------------------------- reads the trusted local journal only


def test_the_journal_command_is_a_constant_for_root_owned_ssh_records_only():
    assert agent.JOURNAL_ARGV == ("journalctl", "-f", "-n", "0", "-o", "json", "_COMM=sshd", "_COMM=sshd-session", "_UID=0")
    assert "_TRANSPORT=kernel" not in agent.JOURNAL_ARGV      # no netfilter group on a protected host


def test_only_records_the_core_detector_trusts_and_that_come_from_sshd_are_processed():
    good = record("Failed password for root from 203.0.113.50 port 1 ssh2")
    stream = [
        good,
        record("Failed password for root from 203.0.113.51 port 1 ssh2", uid="1000"),                     # not root
        record("Failed password for root from 203.0.113.52 port 1 ssh2", comm="logger"),                  # look-alike line
        record("Failed password for root from 203.0.113.53 port 1 ssh2", comm="bash", transport="syslog"),
        record("IN=eth0 SRC=203.0.113.54 DPT=22 AEGIS_NEWCONN", comm="kernel", transport="kernel"),        # kernel: not used here
        "Failed password for root from 203.0.113.55 port 1 ssh2",                                          # plain text
        "{not json",
        record("x" * 20000),                                                                               # oversize
        json.dumps({"MESSAGE": [70, 97], "_COMM": "sshd", "_UID": "0", "_TRANSPORT": "syslog"}),          # byte-array message
    ]
    assert list(agent.trusted_ssh_records(stream)) == [good]


def test_look_alike_lines_from_a_local_user_never_produce_an_alert(pki):
    publisher, client = make_publisher(pki)
    detector = gd.GraduatedDetector(publisher)
    forged = [record(f"Failed password for root from {ATTACKER} port {n} ssh2", uid="1000", comm="logger") for n in range(10)]
    forged += [f"Failed password for root from {ATTACKER} port 1 ssh2"] * 10
    agent.run(forged, detector)
    assert client.published == []


# --------------------------------------------------------------------------------------- reports the same SSH events, signed


def test_brute_force_then_login_are_published_as_two_signed_alerts_the_core_accepts(pki):
    publisher, client = make_publisher(pki)
    status = agent.run(failed() + [accepted()], gd.GraduatedDetector(publisher))
    assert status == pd.EXIT_JOURNAL_SOURCE_UNAVAILABLE      # a finished stream is a failure for a live agent, as in the detector
    assert [topic for topic, *_ in client.published] == ["aegis/alert/beelink"] * 2
    assert all(qos == 1 and retain is False for _, _, qos, retain in client.published)
    v = verifier(pki)
    alerts = [v.verify(topic, raw) for topic, raw, *_ in client.published]
    assert [a.kind for a in alerts] == ["ssh_brute_force", "ssh_login_after_failures"]
    assert {a.attacker_ip for a in alerts} == {ATTACKER} and {a.source for a in alerts} == {SOURCE}


def test_the_payload_has_exactly_the_agreed_fields_and_no_attacker_controlled_text(pki):
    publisher, client = make_publisher(pki)
    hostile = [record(f"Failed password for invalid user '); DROP TABLE x;-- from {ATTACKER} port {n} ssh2") for n in range(5)]
    agent.run(hostile, gd.GraduatedDetector(publisher))
    payload = json.loads(client.published[0][1])["payload"]
    assert set(payload) == {"at", "kind", "attacker_ip", "detail", "source", "nonce"}
    assert payload["detail"] == agent.DETAIL["ssh_brute_force"] and "DROP" not in json.dumps(payload)


def test_an_event_kind_outside_the_two_ssh_observations_is_never_published(pki):
    publisher, client = make_publisher(pki)
    for kind in ("port_scan", "syn_flood", "generic", "all_clear", None):
        result = publisher(ATTACKER, kind)
        assert (result.ok, result.code) == (False, alert_sink.INVALID_ADDRESS)
    assert client.published == []


def test_an_invalid_address_is_never_published(pki):
    publisher, client = make_publisher(pki)
    assert publisher("127.0.0.1", "ssh_brute_force").ok is False and client.published == []


def test_the_detectors_own_cooldown_still_limits_one_alert_per_address_and_rule(pki):
    publisher, client = make_publisher(pki)
    agent.run(failed(count=30), gd.GraduatedDetector(publisher))
    assert len(client.published) == 1


# --------------------------------------------------------------------------------------- failure behaviour


def test_without_a_broker_connection_nothing_is_published_and_the_failure_is_a_transport_failure(pki):
    publisher, client = make_publisher(pki, connect=False)
    result = publisher(ATTACKER, "ssh_brute_force")
    assert (result.ok, result.code) == (False, alert_sink.SOCKET_REFUSED) and result.code in alert_sink.TRANSPORT_FAILURES
    assert client.published == []


def test_three_consecutive_transport_failures_stop_the_agent_with_the_transport_exit_status(pki):
    publisher, _client = make_publisher(pki, connect=False)
    stream = failed("203.0.113.50") + failed("203.0.113.51") + failed("203.0.113.52") + failed("203.0.113.53")
    assert agent.run(stream, gd.GraduatedDetector(publisher)) == pd.EXIT_TRANSPORT_UNAVAILABLE


def test_the_agent_ends_with_a_failure_status_when_the_journal_stream_ends(pki):
    publisher, _client = make_publisher(pki)
    assert agent.run([], gd.GraduatedDetector(publisher)) == pd.EXIT_JOURNAL_SOURCE_UNAVAILABLE


# --------------------------------------------------------------------------------------- configuration


@pytest.mark.parametrize("key, code", [
    ("AEGIS_BEELINK_BROKER_HOST", "BROKER_HOST_MISSING"), ("AEGIS_BEELINK_CA_FILE", "CA_FILE_UNREADABLE"),
    ("AEGIS_BEELINK_CLIENT_CERT", "CLIENT_CERT_UNREADABLE"), ("AEGIS_BEELINK_CLIENT_KEY", "CLIENT_KEY_UNREADABLE"),
])
def test_a_missing_setting_is_a_stable_config_error(pki, key, code):
    env = config_for(pki)
    del env[key]
    with pytest.raises(agent.ConfigError) as info:
        agent.load_config(env)
    assert info.value.code == code


def test_a_key_other_accounts_can_read_is_refused(pki):
    pki.agent.key_path.chmod(0o640)
    with pytest.raises(agent.ConfigError) as info:
        agent.load_config(config_for(pki))
    assert info.value.code == "CLIENT_KEY_PERMISSIONS"


@pytest.mark.parametrize("override", [{"AEGIS_BEELINK_SOURCE": "Bad Source"}, {"AEGIS_BEELINK_BROKER_PORT": "0"},
                                      {"AEGIS_BEELINK_BROKER_PORT": "x"}, {"AEGIS_BEELINK_CA_FILE": "relative/ca.crt"}])
def test_invalid_values_are_refused(pki, override):
    with pytest.raises(agent.ConfigError):
        agent.load_config(config_for(pki, **override))


def test_the_tls_context_verifies_the_broker_and_presents_the_client_certificate(pki):
    context = agent.build_ssl_context(agent.load_config(config_for(pki)))
    import ssl
    assert context.verify_mode == ssl.CERT_REQUIRED and context.check_hostname is True
    assert context.minimum_version == ssl.TLSVersion.TLSv1_2


def test_main_exits_with_the_config_status_and_does_nothing_on_a_bad_configuration(pki, capsys):
    code = agent.main([], environ=config_for(pki, AEGIS_BEELINK_CA_FILE="/nonexistent/ca.crt"))
    assert code == agent.EXIT_CONFIG and "CONFIG_INVALID" in capsys.readouterr().out


def test_the_agent_has_no_command_surface():
    source = (ROOT / "tools" / "aegis_beelink_agent.py").read_text()
    for forbidden in ("subscribe(", "on_message", "os.system", "shell=True", "sudo", "ufw", "iptables", "nft ", "RESTORE", "CUT_UPLINK"):
        assert forbidden not in source, forbidden


# --------------------------------------------------------------------------------------- deployment artifacts


def test_the_systemd_unit_is_unprivileged_hardened_and_not_installed_by_anything_here():
    unit = (ROOT / "deploy" / "beelink-agent" / "aegis-beelink-agent.service").read_text()
    for required in ("User=aegis-agent", "NoNewPrivileges=true", "CapabilityBoundingSet=", "ProtectSystem=strict",
                     "RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX", "EnvironmentFile=/etc/aegis-beelink-agent/agent.env",
                     "Restart=on-failure", "SupplementaryGroups=systemd-journal", "NOT INSTALLED OR ENABLED"):
        assert required in unit, required
    assert "User=root" not in unit and "sudo" not in unit
    exec_line = next(line for line in unit.splitlines() if line.startswith("ExecStart="))
    assert exec_line.split("=", 1)[1].startswith("/opt/")           # absolute, no shell
    assert not any("aegis-beelink-agent" in str(p) for p in (Path("/etc/systemd/system").glob("*") if os.path.isdir("/etc/systemd/system") else []))


def test_the_example_files_hold_no_secret_material():
    for path in (ROOT / "deploy" / "beelink-agent").iterdir():
        text = path.read_text()
        assert "BEGIN PRIVATE KEY" not in text and "BEGIN EC PRIVATE KEY" not in text
