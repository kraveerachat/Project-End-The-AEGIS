"""F1 deployment package: the production alert sink and production detector (aegis_soc/alert_sink.py, aegis_soc/production_detector.py).

Hermetic: real AF_UNIX sockets in a temporary directory served by tiny fake servers (or by the real ``AlertServer`` over a fake supervisor
callback); no broker, no journal, no Core, no network. The sink sends exactly the merged F1 payload and nothing else, once.
"""

from __future__ import annotations

import ast
import json
import os
import re
import shutil
import socket
import tempfile
import threading
import time
from pathlib import Path

import pytest

import detector as legacy_detector
from aegis_soc import alert_sink, production_detector, recovery_core

ROOT = Path(__file__).resolve().parents[1]
UID = os.geteuid()
IP = "203.0.113.7"


def code_only(relative: str) -> str:
    """Module source with comments and docstrings removed (``ast.unparse``), so the static contracts judge code, not prose."""
    tree = ast.parse((ROOT / relative).read_text())
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.FunctionDef, ast.ClassDef, ast.AsyncFunctionDef)) and ast.get_docstring(node, clean=False):
            node.body = node.body[1:] or [ast.Pass()]
    return ast.unparse(tree)


@pytest.fixture
def sockdir():
    directory = Path(tempfile.mkdtemp(prefix="aegis-f1s-"))
    yield directory
    shutil.rmtree(directory, ignore_errors=True)


GID = os.getgid()


@pytest.fixture
def alertdir(sockdir):
    """The dedicated surface as the Core's tmpfiles rule provisions it: setgid 2750, owned by the test account and its group."""
    os.chmod(sockdir, 0o2750)
    return sockdir


class FakeServer:
    """One-connection-at-a-time AF_UNIX server recording raw request bytes; ``reply`` None means close without answering."""

    def __init__(self, path: Path, reply: bytes | None = b'{"v":1,"ok":true,"code":"BOUND","detail":"x","data":{}}\n', *, stall: float = 0.0):
        self.path, self.reply, self.stall = path, reply, stall
        self.received: list[bytes] = []
        self.connections = 0
        self._listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self._listener.bind(str(path))
        self._listener.listen(8)
        self._listener.settimeout(0.2)
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._serve, daemon=True)
        self._thread.start()

    def _serve(self) -> None:
        while not self._stop.is_set():
            try:
                connection, _ = self._listener.accept()
            except TimeoutError:
                continue
            except OSError:
                return
            with connection:
                self.connections += 1
                connection.settimeout(2)
                data = bytearray()
                try:
                    while b"\n" not in data:
                        chunk = connection.recv(1024)
                        if not chunk:
                            break
                        data.extend(chunk)
                except OSError:
                    pass
                self.received.append(bytes(data))
                if self.stall:
                    time.sleep(self.stall)
                if self.reply is not None:
                    try:
                        connection.sendall(self.reply)
                    except OSError:
                        pass

    def close(self) -> None:
        self._stop.set()
        self._listener.close()
        self._thread.join()


@pytest.fixture
def serve(sockdir):
    servers = []

    def start(reply=FakeServer.__init__.__defaults__[0], **kw):
        server = FakeServer(sockdir / "alert.sock", reply, **kw)
        servers.append(server)
        return server

    yield start
    for server in servers:
        server.close()


def send(sockdir, address=IP, **kw):
    return alert_sink.send_alert(address, path=str(sockdir / "alert.sock"), expected_core_uid=kw.pop("expected_core_uid", UID), **kw)


# --------------------------------------------------------------------------- payload and happy path


def test_valid_ipv4_sends_the_exact_f1_payload_once(sockdir, serve):
    server = serve()
    result = send(sockdir)
    assert result == alert_sink.AlertResult(True, "SENT_BOUND", "")
    assert server.received == [b'{"v":1,"attacker_ip":"203.0.113.7"}\n']
    assert server.connections == 1


def test_existing_incident_reply_is_a_success_code(sockdir, serve):
    serve(b'{"v":1,"ok":true,"code":"EXISTING","detail":"x","data":{}}\n')
    assert send(sockdir).code == "SENT_EXISTING"


def test_payload_is_accepted_by_the_real_core_alert_parser(sockdir):
    payload = alert_sink.build_payload(IP)
    assert recovery_core.parse_alert(json.loads(payload.decode())) == IP
    assert payload.endswith(b"\n") and payload.count(b"\n") == 1 and len(payload) <= recovery_core.ALERT_MAX_BYTES


def test_end_to_end_against_the_real_alert_server_and_ingress(sockdir):
    seen = []
    ingress = recovery_core.AlertIngress(lambda ip: seen.append(ip) or {"action": "CREATED", "audited": True})
    server = recovery_core.AlertServer(sockdir / "alert.sock", ingress, allowed_uid=UID)
    server.start()
    try:
        result = send(sockdir)
    finally:
        server.close()
    assert result.ok and result.code == "SENT_BOUND" and seen == [IP]


def test_real_ingress_refuses_a_wrong_uid_sender_and_the_sink_reports_it(sockdir):
    seen = []
    ingress = recovery_core.AlertIngress(lambda ip: seen.append(ip) or {"action": "CREATED", "audited": True})
    server = recovery_core.AlertServer(sockdir / "alert.sock", ingress, allowed_uid=UID + 1)  # the configured source is someone else
    server.start()
    try:
        result = send(sockdir)
    finally:
        server.close()
    assert result == alert_sink.AlertResult(False, "CORE_REJECTED", "PEER_REFUSED") and seen == []


# --------------------------------------------------------------------------- address validation (the existing ingress contract)


@pytest.mark.parametrize("bad", ["0.0.0.0", "0.1.2.3", "127.0.0.1", "224.0.0.1", "169.254.1.1", "240.0.0.1", "255.255.255.255",
                                 "::1", "2001:db8::1", "999.1.1.1", "1.2.3", "a.b.c.d", "", " 203.0.113.7", "203.0.113.7\n", 5, None,
                                 "203.0.113.7/32", "../alert.sock"])
def test_invalid_or_reserved_addresses_are_refused_without_connecting(sockdir, serve, bad):
    server = serve()
    result = send(sockdir, bad)
    assert result == alert_sink.AlertResult(False, "INVALID_ADDRESS", "")
    assert server.connections == 0 and server.received == []


def test_sink_and_core_ingress_agree_on_every_address_class():
    for candidate in ("203.0.113.7", "10.77.30.5", "192.168.1.9", "0.0.0.0", "127.0.0.1", "224.0.0.9", "169.254.0.1", "240.1.1.1"):
        try:
            alert_sink.build_payload(candidate)
            sink_ok = True
        except ValueError:
            sink_ok = False
        try:
            recovery_core.parse_alert({"v": 1, "attacker_ip": candidate})
            core_ok = True
        except recovery_core.AlertRequestError:
            core_ok = False
        assert sink_ok == core_ok, candidate


# --------------------------------------------------------------------------- AF_UNIX only, path never from detection input


def test_the_production_socket_path_is_the_one_dedicated_f1_surface():
    """OD-F1-DEPLOY-01: ONE canonical dedicated path. The Core name constant is shared; the directory is NOT the general runtime directory.
    (The Core-side hook that serves this path is Phase B: CORE_ALERT_SOCKET_HOOK_IMPLEMENTED=NO.)"""
    assert alert_sink.ALERT_SOCKET_PATH == f"/run/aegis-idea3-alert/{recovery_core.ALERT_CHANNEL_NAME}"
    assert alert_sink.ALERT_RUNTIME_DIR == "/run/aegis-idea3-alert" and alert_sink.ALERT_SOCKET_PATH != "/run/aegis-idea3/alert.sock"
    assert (alert_sink.ALERT_GROUP, alert_sink.DETECTOR_ACCOUNT) == ("aegis-idea3-alert", "aegis-idea3-detector")
    assert (alert_sink.SOCKET_MODE, alert_sink.RUNTIME_DIR_MODE) == (0o620, 0o2750)


def test_the_detector_never_passes_a_path_to_the_sink():
    tree = ast.parse((ROOT / "aegis_soc" / "production_detector.py").read_text())
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and getattr(node.func, "attr", "") == "send_alert":
            assert not node.keywords and len(node.args) == 1  # only the address
    assert production_detector.ProductionDetector()._send is alert_sink.send_alert  # production default: constant path, address only


def test_sink_source_has_only_af_unix_and_no_network_mqtt_shell_or_process_primitive():
    source = code_only("aegis_soc/alert_sink.py")
    tree = ast.parse(source)
    imported = {a.name.split(".")[0] for n in ast.walk(tree) if isinstance(n, ast.Import) for a in n.names}
    imported |= {(n.module or "").split(".")[0] for n in ast.walk(tree) if isinstance(n, ast.ImportFrom) and n.level == 0}
    assert not imported & {"paho", "ssl", "subprocess", "http", "urllib", "requests", "asyncio", "os_system"}
    assert "AF_INET" not in source and "AF_INET6" not in source and "SOCK_DGRAM" not in source
    assert "shell=True" not in source and "os.system" not in source and "Popen" not in source
    assert source.count("AF_UNIX") >= 2
    assert not re.search(r"publish|attacker_ip\"?\s*topic|aegis/attacker_ip|1883|8883", source)
    for forbidden in ("restore", "cut", "contain", "isolate"):
        assert not re.search(rf"\bdef \w*{forbidden}", source, re.IGNORECASE)


# --------------------------------------------------------------------------- failure modes: stable codes, one attempt


def test_a_missing_socket_is_socket_missing(sockdir):
    assert send(sockdir) == alert_sink.AlertResult(False, "SOCKET_MISSING", "")


def test_a_stale_socket_file_with_no_listener_is_refused(sockdir):
    stale = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    stale.bind(str(sockdir / "alert.sock"))
    stale.close()  # the inode stays, nothing listens
    assert send(sockdir).code == "SOCKET_REFUSED"


def test_a_regular_file_at_the_path_is_refused_not_written(sockdir):
    (sockdir / "alert.sock").write_text("x")
    assert send(sockdir).code in {"SOCKET_REFUSED", "OUTCOME_UNKNOWN"}
    assert (sockdir / "alert.sock").read_text() == "x"


def test_an_impostor_listener_not_owned_by_the_core_account_receives_nothing(sockdir, serve):
    server = serve()
    result = send(sockdir, expected_core_uid=UID + 1)
    assert result == alert_sink.AlertResult(False, "PEER_NOT_CORE", "")
    assert server.received in ([], [b""])  # the peer check precedes the write


def test_a_server_that_never_answers_times_out_within_the_bound(sockdir, serve):
    serve(None, stall=3.0)
    started = time.monotonic()
    result = send(sockdir, timeout=0.4)
    assert time.monotonic() - started < 1.5
    assert not result.ok and result.code == "OUTCOME_UNKNOWN" and result.detail == "timeout"  # written, answer lost: never assume success


def test_a_connection_closed_without_a_reply_is_reply_invalid(sockdir, serve):
    serve(None)
    assert send(sockdir).code == "REPLY_INVALID"


@pytest.mark.parametrize("reply", [b"not json\n", b"[]\n", b'{"v":2,"ok":true,"code":"BOUND"}\n', b'{"v":1,"ok":"yes","code":"BOUND"}\n',
                                   b'{"v":1,"ok":true,"code":"SOMETHING"}\n', b"x" * 5000 + b"\n", b'{"v":1,"ok":true,"code":"BOUND"}'])
def test_malformed_core_replies_are_never_success(sockdir, serve, reply):
    serve(reply)
    assert not send(sockdir).ok


def test_core_refusals_map_to_a_stable_code_with_the_cores_own_reason(sockdir, serve):
    serve(b'{"v":1,"ok":false,"code":"RATE_LIMITED","detail":"secret-looking free text","data":{}}\n')
    result = send(sockdir)
    assert result == alert_sink.AlertResult(False, "CORE_REJECTED", "RATE_LIMITED") and "secret" not in repr(result)
    # an unknown Core code never leaks through verbatim
    assert alert_sink._interpret(b'{"v":1,"ok":false,"code":"<script>","detail":"","data":{}}\n').detail == "UNRECOGNISED"


def test_one_call_is_one_attempt_no_retry(sockdir, serve):
    server = serve(None)
    send(sockdir)
    time.sleep(0.2)
    assert server.connections == 1
    source = code_only("aegis_soc/alert_sink.py")
    assert not re.search(r"\bfor attempt|while True|retry|backoff", source.split("def check_socket")[0], re.IGNORECASE)


def test_the_result_never_contains_the_payload_or_the_socket_path(sockdir):
    result = send(sockdir)
    assert str(sockdir) not in repr(result) and IP not in repr(result)


# --------------------------------------------------------------------------- start-time socket check (ExecStartPre)


def test_check_socket_missing_is_bounded_and_does_not_wait_forever(alertdir):
    sleeps = []
    clock = iter(range(1000)).__next__
    verdict = alert_sink.check_socket(str(alertdir / "alert.sock"), expected_core_uid=UID, expected_gid=GID, wait_sec=3,
                                      sleep=lambda s: sleeps.append(s), clock=lambda: float(clock()))
    assert verdict == "ALERT_SOCKET_MISSING" and 1 <= len(sleeps) <= 8


def test_check_socket_wait_is_capped():
    sleeps = []
    ticks = [0.0]

    def clock():
        ticks[0] += 1.0
        return ticks[0]

    alert_sink.check_socket("/nonexistent/aegis/alert.sock", expected_core_uid=UID, wait_sec=10**6, sleep=sleeps.append, clock=clock)
    assert len(sleeps) <= alert_sink.CHECK_WAIT_MAX_SEC + 2


def test_check_socket_requires_core_owner_group_mode_0620_and_a_live_listener(alertdir):
    path = alertdir / "alert.sock"
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    listener.bind(str(path))
    for wrong in (0o660, 0o600, 0o622, 0o666):  # group-readable, the legacy 0600, world-writable
        os.chmod(path, wrong)
        assert alert_sink.check_socket(str(path), expected_core_uid=UID, expected_gid=GID) == "ALERT_SOCKET_WRONG_MODE", oct(wrong)
    os.chmod(path, 0o620)
    assert alert_sink.check_socket(str(path), expected_core_uid=UID, expected_gid=GID) == "ALERT_SOCKET_NOT_LISTENING"  # bound, not listening
    listener.listen(1)
    assert alert_sink.check_socket(str(path), expected_core_uid=UID, expected_gid=GID) == "ALERT_SOCKET_OK"
    assert alert_sink.check_socket(str(path), expected_core_uid=UID + 1, expected_gid=GID) in ("ALERT_SOCKET_WRONG_OWNER", "ALERT_RUNTIME_DIR_UNEXPECTED")
    assert alert_sink.check_socket(str(path), expected_core_uid=UID, expected_gid=GID + 1) in ("ALERT_SOCKET_WRONG_OWNER", "ALERT_RUNTIME_DIR_UNEXPECTED")
    listener.close()


@pytest.mark.parametrize("mode", [0o700, 0o750, 0o2770, 0o2755, 0o2751, 0o3750])
def test_check_socket_refuses_a_runtime_directory_other_than_the_exact_2750(sockdir, mode):
    path = sockdir / "alert.sock"
    server = FakeServer(path)
    os.chmod(path, 0o620)
    os.chmod(sockdir, mode)
    try:
        assert alert_sink.check_socket(str(path), expected_core_uid=UID, expected_gid=GID) == "ALERT_RUNTIME_DIR_UNEXPECTED"
    finally:
        server.close()


def test_check_socket_resolves_the_group_by_the_dedicated_name_and_fails_closed_when_absent(alertdir, monkeypatch):
    import grp

    def missing(name):
        assert name == "aegis-idea3-alert"
        raise KeyError(name)

    monkeypatch.setattr(grp, "getgrnam", missing)
    assert alert_sink.check_socket(str(alertdir / "alert.sock"), expected_core_uid=UID) == "ALERT_SOCKET_GROUP_UNRESOLVED"


def test_check_socket_refuses_a_non_socket(alertdir):
    (alertdir / "alert.sock").write_text("x")
    os.chmod(alertdir / "alert.sock", 0o620)
    assert alert_sink.check_socket(str(alertdir / "alert.sock"), expected_core_uid=UID, expected_gid=GID) == "ALERT_SOCKET_NOT_A_SOCKET"


def test_check_socket_never_writes_an_alert(alertdir):
    path = alertdir / "alert.sock"
    server = FakeServer(path)
    os.chmod(path, 0o620)
    try:
        assert alert_sink.check_socket(str(path), expected_core_uid=UID, expected_gid=GID) == "ALERT_SOCKET_OK"
        time.sleep(0.2)
        assert all(chunk == b"" for chunk in server.received)
    finally:
        server.close()


@pytest.mark.parametrize("argv", [[], ["send"], ["check-socket", "--wait-sec"], ["check-socket", "--wait-sec", "x"], ["check-socket", "--x", "1"]])
def test_cli_rejects_bad_usage(argv):
    assert alert_sink.main(argv) == 2


# --------------------------------------------------------------------------- production detector: rules, bounds, no MQTT


class Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


def make_detector(results=None):
    sent: list[str] = []
    outcomes = list(results or [])

    def sender(ip):
        sent.append(ip)
        return outcomes.pop(0) if outcomes else alert_sink.AlertResult(True, "SENT_BOUND")

    clock = Clock()
    return production_detector.ProductionDetector(sender, clock=clock), sent, clock


def test_thresholds_match_the_legacy_detector_so_the_two_cannot_drift():
    for name in ("FAIL_THRESHOLD", "TIME_WINDOW", "SCAN_PORT_THRESHOLD", "SCAN_TIME_WINDOW", "SYN_FLOOD_THRESHOLD", "SYN_FLOOD_WINDOW"):
        assert getattr(production_detector, name) == getattr(legacy_detector, name), name


def test_ssh_bruteforce_sends_one_alert_at_threshold():
    det, sent, _ = make_detector()
    line = f"Failed password for invalid user admin from {IP} port 22 ssh2"
    for _ in range(production_detector.FAIL_THRESHOLD - 1):
        det.process(line)
    assert sent == []
    det.process(line)
    det.process(line)
    assert sent == [IP]  # reported once; the cooldown suppresses the repeat


def test_portscan_and_synflood_rules_alert():
    det, sent, _ = make_detector()
    for port in range(8000, 8000 + production_detector.SCAN_PORT_THRESHOLD):
        det.process(f"AEGIS_NEWCONN: SRC=203.0.113.9 DST=1.1.1.1 PROTO=TCP DPT={port}")
    assert sent == ["203.0.113.9"]
    det2, sent2, _ = make_detector()
    for _ in range(production_detector.SYN_FLOOD_THRESHOLD):
        det2.process("AEGIS_NEWCONN: SRC=203.0.113.10 DST=1.1.1.1 PROTO=TCP DPT=22")
    assert sent2 == ["203.0.113.10"]


def test_localhost_synflood_is_ignored_and_other_lines_are_ignored():
    det, sent, _ = make_detector()
    for _ in range(50):
        det.process("AEGIS_NEWCONN: SRC=127.0.0.1 DST=1.1.1.1 PROTO=TCP DPT=22")
        det.process("Accepted password for user from 10.0.0.5 port 22 ssh2")
    assert sent == []


def test_window_expiry_resets_ssh_counting():
    det, sent, clock = make_detector()
    line = f"Failed password for x from {IP} port 22 ssh2"
    for _ in range(production_detector.FAIL_THRESHOLD - 1):
        det.process(line)
    clock.t += production_detector.TIME_WINDOW + 1
    det.process(line)
    assert sent == []


def test_invalid_log_addresses_reach_the_sink_which_refuses_them_locally():
    results = []
    det = production_detector.ProductionDetector(lambda ip: results.append(alert_sink.send_alert(ip, path="/nonexistent/x")) or results[-1])
    for _ in range(production_detector.FAIL_THRESHOLD):
        det.process("Failed password for root from 999.1.1.1 port 22 ssh2")
    assert results and results[0].code == "INVALID_ADDRESS"
    assert det.consecutive_transport_failures == 0  # a bad address is not a transport failure


def test_a_failed_send_is_not_retried_during_the_cooldown():
    det, sent, clock = make_detector([alert_sink.AlertResult(False, "SOCKET_MISSING")])
    for _ in range(40):
        det.process(f"Failed password for x from {IP} port 22 ssh2")
    assert sent == [IP]
    clock.t += production_detector.REPORT_COOLDOWN_SEC + 1
    for _ in range(production_detector.FAIL_THRESHOLD):
        det.process(f"Failed password for x from {IP} port 22 ssh2")
    assert sent == [IP, IP]


def test_consecutive_transport_failures_stop_the_detector_instead_of_looping():
    fail = alert_sink.AlertResult(False, "SOCKET_MISSING")
    det, sent, _ = make_detector([fail] * 10)
    lines = [f"Failed password for x from 203.0.113.{n} port 22 ssh2" for n in range(1, 10) for _ in range(production_detector.FAIL_THRESHOLD)]
    code = production_detector.run(iter(lines), det)
    assert code == production_detector.EXIT_TRANSPORT_UNAVAILABLE and len(sent) == production_detector.MAX_CONSECUTIVE_TRANSPORT_FAILURES


def test_a_success_resets_the_transport_failure_count():
    det, _, _ = make_detector([alert_sink.AlertResult(False, "TIMEOUT"), alert_sink.AlertResult(True, "SENT_BOUND"), alert_sink.AlertResult(False, "TIMEOUT")])
    for n in (1, 2, 3):
        for _ in range(production_detector.FAIL_THRESHOLD):
            det.process(f"Failed password for x from 203.0.113.{n} port 22 ssh2")
    assert det.consecutive_transport_failures == 1 and not det.stopped


def test_local_send_rate_stays_below_the_core_ingress_limit():
    det, sent, _ = make_detector()
    for n in range(1, 40):
        for _ in range(production_detector.FAIL_THRESHOLD):
            det.process(f"Failed password for x from 203.0.113.{n} port 22 ssh2")
    assert len(sent) == production_detector.SEND_BURST <= recovery_core.ALERT_RATE_BURST
    assert production_detector.SEND_PER_MIN <= recovery_core.ALERT_RATE_PER_MIN


def test_tracking_tables_are_bounded(monkeypatch):
    monkeypatch.setattr(production_detector, "MAX_TRACKED_ADDRESSES", 8)
    det, _, _ = make_detector()
    for n in range(100):
        det.process(f"Failed password for x from 10.0.{n // 250}.{n % 250 + 1} port 22 ssh2")
    assert len(det._fails) <= 8


def test_oversized_lines_are_truncated_before_matching():
    det, sent, _ = make_detector()
    line = "x" * (production_detector.LINE_MAX_CHARS + 10) + f" Failed password from {IP}"
    for _ in range(10):
        det.process(line)
    assert sent == []


def test_the_journal_argv_is_a_constant_without_a_shell():
    assert production_detector.JOURNAL_ARGV == ("journalctl", "-f", "-n", "0", "-o", "cat")
    source = (ROOT / "aegis_soc" / "production_detector.py").read_text()
    tree = ast.parse(source)
    popen = [n for n in ast.walk(tree) if isinstance(n, ast.Call) and getattr(n.func, "attr", "") == "Popen"]
    assert len(popen) == 1 and not any(k.arg == "shell" for k in popen[0].keywords)
    assert not re.search(r"shell\s*=\s*True|os\.system|os\.popen|\beval\(|\bexec\(", source)


def test_production_detector_has_no_mqtt_no_network_and_no_containment_primitive():
    source = code_only("aegis_soc/production_detector.py")
    tree = ast.parse(source)
    imported = {a.name.split(".")[0] for n in ast.walk(tree) if isinstance(n, ast.Import) for a in n.names}
    imported |= {(n.module or "").split(".")[0] for n in ast.walk(tree) if isinstance(n, ast.ImportFrom) and n.level == 0}
    assert not imported & {"paho", "ssl", "socket", "requests", "http", "urllib", "os"}
    assert "publish(" not in source and "aegis/attacker_ip" not in source and "TOPIC_ATTACKER" not in source
    assert "1883" not in source and ".env" not in source and "AEGIS_MQTT" not in source and "load_dotenv" not in source
    assert not re.search(r"issue_command|containment|nft|\bCUT\b|\bRESTORE\b|local_restore|controller", source)


def test_the_legacy_lab_detector_is_unchanged_and_still_the_only_mqtt_publisher():
    text = (ROOT / "detector.py").read_text()
    assert "TOPIC_ATTACKER = \"aegis/attacker_ip\"" in text and "client.publish(TOPIC_ATTACKER, ip)" in text
    assert "alert_sink" not in text and "alert.sock" not in text


def test_neither_new_module_is_imported_by_the_core_or_the_legacy_detector():
    for path in ("aegis_soc/supervisor.py", "aegis_soc/recovery_core.py", "aegis_soc/runtime.py", "detector.py"):
        text = (ROOT / path).read_text()
        assert "alert_sink" not in text and "production_detector" not in text, path


def test_log_lines_carry_only_stable_tokens(capsys):
    det, _, _ = make_detector()
    for _ in range(production_detector.FAIL_THRESHOLD):
        det.process(f"Failed password for hunter2-user from {IP} port 22 ssh2")
    out = capsys.readouterr().out
    assert "[F1-DETECTOR] alert result=SENT_BOUND" in out and "hunter2" not in out
