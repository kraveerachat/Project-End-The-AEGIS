"""F1: the Core-local AF_UNIX production alert ingress (what makes Recovery R1 reachable in production).

Hermetic: a real supervisor over a temporary audit database and a real AF_UNIX server in a temporary directory; paho,
the containment helper and every probe are fakes. Nothing here opens a broker, a device, the root containment socket
or a network listener. The ingress accepts exactly one thing, an IPv4 attacker candidate from one configured uid, and
its only effect is ``recovery.bind_incident``.
"""

from __future__ import annotations

import inspect
import json
import os
import re
import shutil
import socket
import stat
import tempfile
import time
from pathlib import Path

import pytest
from test_core_recovery import IP, OTHER_IP, incident_count, make_env
from test_local_restore import SECRET

from aegis_soc import config, mqtt_client, recovery_core, supervisor
from aegis_soc import database as db
from aegis_soc import local_restore as lr


@pytest.fixture(scope="module")
def credential():
    return lr.RestoreCredential.parse(lr.hash_secret(SECRET, n=lr.SCRYPT_MIN_N))


@pytest.fixture
def env(tmp_path, monkeypatch, credential):
    instance = make_env(tmp_path, monkeypatch, credential)
    instance.now = [1000.0]
    instance.ingress = recovery_core.AlertIngress(
        instance.core.supervisor.on_production_alert, clock=lambda: instance.now[0],
    )
    yield instance
    instance.core.close()


@pytest.fixture
def served(env):
    directory = Path(tempfile.mkdtemp(prefix="aegis-al-"))
    servers = []

    def start(allowed_uid=None, deadline=None):
        server = recovery_core.AlertServer(
            directory / "alert.sock", env.ingress, allowed_uid=os.geteuid() if allowed_uid is None else allowed_uid,
        )
        if deadline is not None:
            server.request_deadline = deadline
        server.start()
        servers.append(server)
        return server

    env.directory = directory
    env.start = start
    yield env
    for server in servers:
        server.close()
    shutil.rmtree(directory, ignore_errors=True)


def exchange(path, payload=b"", *, wait=0.0):
    """Returns (reply or None, seconds). Sends ``payload`` (possibly nothing) and reads one reply line."""
    started = time.monotonic()
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.settimeout(5)
        connection.connect(str(path))
        if payload:
            connection.sendall(payload)
        if wait:
            time.sleep(wait)
        line = connection.makefile("rb").readline()
    return (json.loads(line) if line else None), time.monotonic() - started


def alert(ip=IP, **extra):
    return json.dumps({"v": 1, "attacker_ip": ip, **extra}).encode() + b"\n"


def peer(env):
    return lr.Peer(uid=os.geteuid(), pid=4242)


def handle(env, body):
    return env.ingress.handle(body, peer(env), allowed_uid=os.geteuid())


# --------------------------------------------------------------------------- the valid path


def test_a_valid_alert_binds_the_incident_and_writes_incident_bound(env):
    response = handle(env, {"v": 1, "attacker_ip": IP})
    assert (response["ok"], response["code"]) == (True, "BOUND")
    incident = db.get_open_incident()
    assert incident["attacker_ip"] == IP
    rows = db.fetch_incident_events(incident["id"], ("INCIDENT_BOUND",), 5)
    assert len(rows) == 1 and f"attacker_ip={IP}" in rows[0]["details"]


def test_an_accepted_alert_durably_records_the_kernel_attested_peer(env):
    """R1 provenance: ALERT_ACCEPTED carries the SO_PEERCRED uid/pid, the address and the action, bound to the incident."""
    handle(env, {"v": 1, "attacker_ip": IP})
    incident = db.get_open_incident()
    rows = db.fetch_incident_events(incident["id"], ("ALERT_ACCEPTED",), 5)
    assert [r["details"] for r in rows] == [f"uid={os.geteuid()} pid=4242 attacker_ip={IP} action=CREATED"]
    handle(env, {"v": 1, "attacker_ip": IP})
    assert db.fetch_incident_events(incident["id"], ("ALERT_ACCEPTED",), 5)[0]["details"].endswith("action=EXISTING")


def test_a_refused_alert_writes_no_accepted_row(env):
    handle(env, {"v": 1, "attacker_ip": "127.0.0.1"})
    assert "ALERT_ACCEPTED" not in {row[3] for row in db.fetch_all_logs()}


def test_a_valid_alert_never_contains_cuts_restores_or_publishes(env):
    handle(env, {"v": 1, "attacker_ip": IP})
    assert env.containment.calls == []
    assert env.core.client.published == []
    assert env.core.supervisor.pending_command is None
    assert env.core.store.command("0" * 32) is None
    events = {row[3] for row in db.fetch_all_logs()}
    assert "INCIDENT_BOUND" in events
    assert not events & {"CUT_REQUESTED", "RESTORE_REQUESTED", "RECOVERY_R3_REQUESTED", "COMMAND_SENT"}


def test_the_production_alert_never_takes_the_containment_capable_legacy_path(env, monkeypatch):
    def forbidden(*_args, **_kwargs):
        raise AssertionError("the legacy containment-capable _on_attacker path was used")

    monkeypatch.setattr(env.core.supervisor, "_on_attacker", forbidden)
    response = handle(env, {"v": 1, "attacker_ip": IP})
    assert response["code"] == "BOUND"


def test_the_handler_source_cannot_reach_containment_cut_restore_or_the_legacy_topic():
    for target in (recovery_core.AlertIngress, supervisor.AegisSupervisor.on_production_alert, supervisor.AegisSupervisor.start_alert_ingress):
        source = inspect.getsource(target)
        for forbidden in ("_on_attacker(", "attacker_callback", "TOPIC_ATTACKER_IP", "containment", "issue_command", "CUT_UPLINK", "RESTORE_UPLINK"):
            assert forbidden not in source, f"{target.__qualname__} references {forbidden}"


# --------------------------------------------------------------------------- duplicates


def test_the_same_ip_is_existing_and_a_different_ip_is_ignored_while_the_incident_is_open(env):
    assert handle(env, {"v": 1, "attacker_ip": IP})["code"] == "BOUND"
    again = handle(env, {"v": 1, "attacker_ip": IP})
    assert (again["ok"], again["code"]) == (True, "EXISTING")
    other = handle(env, {"v": 1, "attacker_ip": OTHER_IP})
    assert (other["ok"], other["code"]) == (False, "IGNORED_DIFFERENT_IP")
    assert incident_count() == 1 and db.get_open_incident()["attacker_ip"] == IP


# --------------------------------------------------------------------------- strict payload


@pytest.mark.parametrize(
    "body",
    [
        None, [], "203.0.113.9", 7,
        {}, {"v": 1}, {"attacker_ip": IP}, {"v": 2, "attacker_ip": IP}, {"v": True, "attacker_ip": IP},
        {"v": "1", "attacker_ip": IP}, {"v": 1.0, "attacker_ip": IP},
        {"v": 1, "attacker_ip": IP, "action": "CUT_UPLINK"},
        {"v": 1, "attacker_ip": IP, "op": "RESTORE"},
        {"v": 1, "attacker_ip": IP, "path": "/etc/passwd"},
        {"v": 1, "attacker_ip": IP, "command": "id"},
        {"v": 1, "attacker_ip": IP, "secret": "x"},
        {"v": 1, "attacker_ip": None}, {"v": 1, "attacker_ip": 3405803785}, {"v": 1, "attacker_ip": ["1.2.3.4"]},
        {"v": 1, "attacker_ip": ""}, {"v": 1, "attacker_ip": " 203.0.113.9"}, {"v": 1, "attacker_ip": "203.0.113.9\n"},
        {"v": 1, "attacker_ip": "203.0.113.9/32"}, {"v": 1, "attacker_ip": "attacker.example"},
        {"v": 1, "attacker_ip": "2001:db8::1"}, {"v": 1, "attacker_ip": "::ffff:203.0.113.9"},
    ],
)
def test_malformed_or_extra_key_payloads_are_refused_and_create_nothing(env, body):
    response = handle(env, body)
    assert response["ok"] is False and response["code"] in {"MALFORMED_REQUEST", "BAD_ADDRESS"}
    assert db.get_open_incident() is None and env.containment.calls == []


@pytest.mark.parametrize("address", ["127.0.0.1", "127.8.8.8", "224.0.0.1", "239.255.255.250", "169.254.1.1", "0.0.0.0", "0.1.2.3"])
def test_non_attacker_addresses_are_refused(env, address):
    response = handle(env, {"v": 1, "attacker_ip": address})
    assert (response["ok"], response["code"]) == (False, "BAD_ADDRESS")
    assert db.get_open_incident() is None


def test_an_oversized_request_is_refused_without_creating_an_incident(served):
    server = served.start()
    reply, _ = exchange(server.path, alert(IP, pad="x" * 400))
    assert reply is not None and (reply["ok"], reply["code"]) == (False, "MALFORMED_REQUEST")
    assert len(alert(IP)) < recovery_core.ALERT_MAX_BYTES <= 256
    assert db.get_open_incident() is None


def test_a_non_json_request_is_refused(served):
    server = served.start()
    reply, _ = exchange(server.path, b"not json\n")
    assert reply is not None and (reply["ok"], reply["code"]) == (False, "MALFORMED_REQUEST")


def test_a_valid_alert_over_the_socket_creates_incident_bound(served):
    server = served.start()
    reply, _ = exchange(server.path, alert(IP))
    assert (reply["ok"], reply["code"]) == (True, "BOUND")
    assert db.get_open_incident()["attacker_ip"] == IP


# --------------------------------------------------------------------------- peer authentication before any read


def test_a_wrong_uid_is_refused_before_any_request_byte_is_read(served):
    server = served.start(allowed_uid=os.geteuid() + 1, deadline=5.0)
    reply, elapsed = exchange(server.path, wait=1.5)  # sends ZERO bytes
    assert reply is not None and (reply["ok"], reply["code"]) == (False, "PEER_REFUSED")
    assert elapsed < 4.0, "an unauthorized peer must be answered without waiting for request bytes"
    assert db.get_open_incident() is None


def test_a_wrong_uid_cannot_bind_even_with_a_valid_payload(served):
    server = served.start(allowed_uid=os.geteuid() + 1)
    reply, _ = exchange(server.path, alert(IP))
    assert reply["code"] == "PEER_REFUSED" and db.get_open_incident() is None


def test_peer_credentials_are_read_before_any_request_byte():
    source = inspect.getsource(recovery_core.RecoveryServer)
    handle_source = source[source.index("def _read_and_handle"):]
    assert handle_source.index("_peer_from(connection)") < handle_source.index("connection.recv")
    assert issubclass(recovery_core.AlertServer, recovery_core.RecoveryServer)
    assert "_read_and_handle" not in inspect.getsource(recovery_core.AlertServer).replace("def _read_and_handle", "")


# --------------------------------------------------------------------------- bounded read and rate


def test_a_slow_client_is_bounded_by_the_read_deadline(served):
    server = served.start(deadline=0.4)
    started = time.monotonic()
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.settimeout(5)
        connection.connect(str(server.path))
        connection.sendall(b'{"v":1,')  # never completes the line
        reply = json.loads(connection.makefile("rb").readline())
    assert time.monotonic() - started < 2.5
    assert (reply["ok"], reply["code"]) == (False, "MALFORMED_REQUEST")
    assert db.get_open_incident() is None


def test_the_default_deadline_is_short_and_bounded():
    assert 0 < recovery_core.ALERT_REQUEST_DEADLINE_SEC <= 2.0


def test_the_rate_limit_refuses_a_flood_and_recovers_with_time(env, monkeypatch):
    calls = []
    original = env.core.supervisor.on_production_alert

    def counting(ip):
        calls.append(ip)
        return original(ip)

    env.ingress = recovery_core.AlertIngress(counting, clock=lambda: env.now[0])
    burst = recovery_core.ALERT_RATE_BURST
    results = [handle(env, {"v": 1, "attacker_ip": IP})["code"] for _ in range(burst)]
    assert results == ["BOUND"] + ["EXISTING"] * (burst - 1)
    limited = handle(env, {"v": 1, "attacker_ip": IP})
    assert (limited["ok"], limited["code"]) == (False, "RATE_LIMITED")
    assert len(calls) == burst, "a rate-limited request must not reach the supervisor"
    env.now[0] += 60.0
    assert handle(env, {"v": 1, "attacker_ip": IP})["code"] == "EXISTING"


def test_a_malformed_flood_also_consumes_the_budget_and_is_bounded_in_the_audit_log(env):
    for _ in range(recovery_core.ALERT_RATE_BURST + 20):
        handle(env, {"v": 1, "attacker_ip": "127.0.0.1"})
    refusals = [row for row in db.fetch_all_logs() if row[3] in {"ALERT_REFUSED", "ALERT_RATE_LIMITED"}]
    assert len(refusals) <= recovery_core.ALERT_RATE_BURST + 2


# --------------------------------------------------------------------------- failure and profile gates


def test_an_audit_failure_is_reported_as_an_error_never_as_success(env, monkeypatch):
    def broken(*_args, **_kwargs):
        raise RuntimeError("audit down")

    monkeypatch.setattr(db, "log_event_strict", broken)
    response = handle(env, {"v": 1, "attacker_ip": IP})
    assert (response["ok"], response["code"]) == (False, "AUDIT_UNAVAILABLE")


def test_a_non_production_core_refuses_every_alert(tmp_path, monkeypatch, credential):
    instance = make_env(tmp_path, monkeypatch, credential, profile="development")
    try:
        ingress = recovery_core.AlertIngress(instance.core.supervisor.on_production_alert)
        response = ingress.handle({"v": 1, "attacker_ip": IP}, lr.Peer(uid=os.geteuid(), pid=1), allowed_uid=os.geteuid())
        assert (response["ok"], response["code"]) == (False, "NOT_PRODUCTION")
        assert db.get_open_incident() is None
    finally:
        instance.core.close()


# --------------------------------------------------------------------------- supervisor wiring


def test_the_channel_stays_disabled_when_the_uid_is_unset(env, monkeypatch):
    monkeypatch.setattr(config, "ALERT_SOURCE_UID", None)
    env.core.supervisor.start_alert_ingress()
    assert env.core.supervisor.alert_server is None
    assert not (env.core.runtime_dir / "alert.sock").exists()


def test_the_channel_stays_disabled_outside_the_production_profile(tmp_path, monkeypatch, credential):
    instance = make_env(tmp_path, monkeypatch, credential, profile="development")
    try:
        monkeypatch.setattr(config, "ALERT_SOURCE_UID", os.geteuid())
        instance.core.supervisor.start_alert_ingress()
        assert instance.core.supervisor.alert_server is None
    finally:
        instance.core.close()


@pytest.fixture
def dedicated(env, monkeypatch):
    """A fixture stand-in for /run/aegis-idea3-alert: Core(=test)-owned, own group, mode 2750; the group name resolves to our gid."""
    import grp
    import types

    directory = Path(tempfile.mkdtemp(prefix="aegis-al-ded-"))
    os.chown(directory, -1, os.getegid())
    os.chmod(directory, recovery_core.ALERT_RUNTIME_DIR_MODE)  # after chown: chown may clear setgid
    monkeypatch.setattr(config, "ALERT_SOCKET_PATH", str(directory / "alert.sock"))
    monkeypatch.setattr(grp, "getgrnam", lambda name: types.SimpleNamespace(gr_gid=os.getegid()) if name == "aegis-idea3-alert" else (_ for _ in ()).throw(KeyError(name)))
    monkeypatch.setattr(config, "ALERT_SOURCE_UID", os.geteuid() + 1)  # a dedicated non-root, non-Core uid
    env.directory = directory
    yield env
    shutil.rmtree(directory, ignore_errors=True)


def test_the_production_constants_are_the_dedicated_f1_transport_and_never_the_general_runtime():
    from aegis_soc import alert_sink

    assert config.ALERT_RUNTIME_DIR == alert_sink.ALERT_RUNTIME_DIR == "/run/aegis-idea3-alert"
    assert config.ALERT_SOCKET_PATH == alert_sink.ALERT_SOCKET_PATH == "/run/aegis-idea3-alert/alert.sock"
    assert config.ALERT_GROUP == alert_sink.ALERT_GROUP == "aegis-idea3-alert"
    assert recovery_core.ALERT_RUNTIME_DIR_MODE == alert_sink.RUNTIME_DIR_MODE == 0o2750
    assert recovery_core.ALERT_SOCKET_MODE == alert_sink.SOCKET_MODE == 0o620
    assert not (recovery_core.ALERT_RUNTIME_DIR_MODE | recovery_core.ALERT_SOCKET_MODE) & 0o007  # no world permission
    source = inspect.getsource(supervisor.AegisSupervisor.start_alert_ingress)
    assert "runtime_dir" not in source and "ALERT_CHANNEL_NAME" not in source  # the old /run/aegis-idea3/alert.sock is not used


def test_a_configured_production_core_serves_the_dedicated_0620_group_socket(dedicated):
    env = dedicated
    env.core.supervisor.start_alert_ingress()
    try:
        server = env.core.supervisor.alert_server
        assert server is not None and server.path == env.directory / "alert.sock"
        assert server.path != env.core.runtime_dir / "alert.sock"
        meta = server.path.lstat()
        assert stat.S_ISSOCK(meta.st_mode) and stat.S_IMODE(meta.st_mode) == 0o620
        assert meta.st_uid == os.geteuid() and meta.st_gid == os.getegid()
        directory = env.directory.lstat()
        assert stat.S_IMODE(directory.st_mode) == 0o2750 and directory.st_uid == os.geteuid() and directory.st_gid == os.getegid()
        assert not (env.core.runtime_dir / "alert.sock").exists()
    finally:
        env.core.supervisor.stop_alert_ingress()
    assert env.core.supervisor.alert_server is None and not (env.directory / "alert.sock").exists()


def test_a_wrong_uid_is_refused_before_any_byte_is_read_even_with_alert_group_reachability(dedicated):
    env = dedicated  # our gid owns the 0620 socket and directory, i.e. we are a transport-group member whose uid is not the source uid
    env.core.supervisor.start_alert_ingress()
    try:
        server = env.core.supervisor.alert_server
        assert server is not None and server.allowed_uid == os.geteuid() + 1 != os.geteuid()
        reply, _ = exchange(server.path, alert(IP))
        assert (reply["ok"], reply["code"]) == (False, "PEER_REFUSED")
        assert incident_count() == 0
    finally:
        env.core.supervisor.stop_alert_ingress()


def test_the_exact_detector_uid_is_accepted_on_the_dedicated_socket(dedicated, tmp_path):
    env = dedicated
    server = recovery_core.AlertServer(env.directory / "alert.sock", env.ingress, allowed_uid=os.geteuid(), socket_gid=os.getegid())
    server.start()
    try:
        assert stat.S_IMODE(server.path.lstat().st_mode) == 0o620
        reply, _ = exchange(server.path, alert(IP))
        assert (reply["ok"], reply["code"]) == (True, "BOUND")
    finally:
        server.close()


@pytest.mark.parametrize("which", ["root", "core"])
def test_a_root_or_core_alert_source_uid_keeps_the_ingress_disabled(dedicated, monkeypatch, which):
    monkeypatch.setattr(config, "ALERT_SOURCE_UID", 0 if which == "root" else os.geteuid())
    env = dedicated
    env.core.supervisor.start_alert_ingress()
    assert env.core.supervisor.alert_server is None and not (env.directory / "alert.sock").exists()


def test_an_unresolved_alert_group_keeps_the_ingress_disabled(dedicated, monkeypatch):
    monkeypatch.setattr(config, "ALERT_GROUP", "aegis-idea3-no-such-group")
    dedicated.core.supervisor.start_alert_ingress()
    assert dedicated.core.supervisor.alert_server is None


@pytest.mark.parametrize("mutate", ["mode_755", "mode_2770", "mode_2751", "wrong_group", "missing"])
def test_the_dedicated_directory_must_be_exactly_core_owned_2750_of_the_alert_group_and_is_never_created(dedicated, mutate):
    env = dedicated
    gid = os.getegid()
    if mutate == "mode_755":
        os.chmod(env.directory, 0o755)
    elif mutate == "mode_2770":
        os.chmod(env.directory, 0o2770)
    elif mutate == "mode_2751":
        os.chmod(env.directory, 0o2751)
    elif mutate == "wrong_group":
        gid = os.getegid() + 1  # the directory belongs to our gid, so a different expected gid must refuse
    else:
        shutil.rmtree(env.directory)
    server = recovery_core.AlertServer(env.directory / "alert.sock", env.ingress, allowed_uid=os.geteuid() + 1, socket_gid=gid)
    with pytest.raises(recovery_core.RecoveryChannelError):
        server.start()
    assert mutate != "missing" or not env.directory.exists()  # no mkdir
    assert mutate == "missing" or not (env.directory / "alert.sock").exists()


def test_recovery_and_local_restore_filesystem_policy_is_unchanged():
    assert recovery_core.RecoveryServer.socket_group_mode == 0o660 and recovery_core.RecoveryServer.socket_group_mode != recovery_core.ALERT_SOCKET_MODE
    assert recovery_core.RecoveryServer.max_message_bytes != recovery_core.AlertServer.max_message_bytes
    assert lr.CHANNEL_NAME == "local-restore.sock"
    text = inspect.getsource(supervisor.AegisSupervisor.start_alert_ingress)
    assert "RECOVERY_SOCKET" not in text and "lr.CHANNEL_NAME" not in text and "recovery_server" not in text


def test_a_channel_failure_never_stops_the_core(env, monkeypatch):
    monkeypatch.setattr(config, "ALERT_SOURCE_UID", os.geteuid() + 1)
    monkeypatch.setattr(recovery_core.AlertServer, "start", lambda self: (_ for _ in ()).throw(OSError("no")))
    env.core.supervisor.start_alert_ingress()
    assert env.core.supervisor.alert_server is None


def test_the_supervisor_starts_and_stops_the_ingress_with_the_core():
    run_source = inspect.getsource(supervisor.AegisSupervisor.run)
    assert "self.start_alert_ingress()" in run_source and "self.stop_alert_ingress()" in run_source
    source = inspect.getsource(supervisor.AegisSupervisor.start_alert_ingress)
    assert "config.ALERT_SOURCE_UID" in source and "is None" in source and 'profile != "production"' in source


# --------------------------------------------------------------------------- no network, no legacy topic


def test_the_ingress_is_unix_only_with_no_network_listener():
    text = Path(recovery_core.__file__).read_text()
    assert not re.search(r"AF_INET|AF_INET6|0\.0\.0\.0|\.listen\(\s*\)|bind\(\(", text)
    assert recovery_core.AlertServer.family == socket.AF_UNIX


def test_protocol_v1_production_still_does_not_subscribe_to_the_legacy_attacker_topic(env):
    manager = env.core.mqtt
    assert manager.legacy is False
    assert config.TOPIC_ATTACKER_IP not in [topic for topic, _qos in manager._subscriptions()]
    assert "TOPIC_ATTACKER_IP" in inspect.getsource(mqtt_client.MQTTManager._subscriptions)  # legacy lab branch only


def test_the_alert_source_uid_setting_is_optional_and_numeric():
    assert hasattr(config, "ALERT_SOURCE_UID")
    text = Path(config.__file__).read_text()
    assert 'ALERT_SOURCE_UID = _optional_int("AEGIS_ALERT_SOURCE_UID")' in text


# --------------------------------------------------------------------------- F1 alone cannot reach anything but R1


def test_the_alert_path_has_no_process_service_filesystem_or_network_primitives():
    targets = (
        recovery_core.parse_alert, recovery_core.AlertIngress, recovery_core.AlertServer,
        supervisor.AegisSupervisor.on_production_alert, supervisor.AegisSupervisor.start_alert_ingress,
        supervisor.AegisSupervisor.stop_alert_ingress,
    )
    forbidden = (
        "subprocess", "os.system", "os.exec", "os.kill", "systemctl", "Popen", "urllib", "http", "requests", "socket.AF_INET",
        "paho", "publish", "LocalRestore", "send_request", "RESTORE", "restore_request", "restore_status", "ContainmentClient", "block(", "unblock",
    )
    for target in targets:
        source = inspect.getsource(target)
        for word in forbidden:
            assert word not in source, f"{target.__qualname__} references {word}"


def test_an_accepted_alert_touches_neither_the_d4_gate_nor_the_command_path_nor_mqtt(env, monkeypatch):
    def forbidden(*_args, **_kwargs):
        raise AssertionError("the alert path reached a command or restore primitive")

    monkeypatch.setattr(env.core.supervisor, "issue_command", forbidden)
    monkeypatch.setattr(env.core.supervisor.controller, "issue", forbidden)
    monkeypatch.setattr(lr.LocalRestoreGate, "handle", forbidden)
    monkeypatch.setattr(env.core.mqtt, "publish_command", forbidden, raising=False)
    assert handle(env, {"v": 1, "attacker_ip": IP})["code"] == "BOUND"
    assert handle(env, {"v": 1, "attacker_ip": OTHER_IP})["code"] == "IGNORED_DIFFERENT_IP"
    assert env.core.client.published == [] and env.containment.calls == []

