"""Dynamic IPv4 containment: validation, nft argv, idempotency, and socket boundary."""

from __future__ import annotations

import ipaddress
import json
import os
import re
import socket
import subprocess
import threading
from pathlib import Path

import pytest

from aegis_soc import ip_containment as ipc


ROOT = Path(__file__).resolve().parents[1]
NFT_TEMPLATE = ROOT / "deploy/network/aegis-idea3-nftables.conf.example"
SOCKET_UNIT = ROOT / "deploy/network/aegis-idea3-containment.socket.example"
SERVICE_UNIT = ROOT / "deploy/network/aegis-idea3-containment.service.example"
CORE_UNIT = ROOT / "deploy/aegis-idea3-core.service.example"

PROTECTED = ipc.parse_protected_cidrs("192.0.2.0/28,198.51.100.7/32")


class FakeNft:
    """Records exact argv and models the kernel set for the runner contract."""

    def __init__(self, elements=(), *, fail_on=None):
        self.elements = set(elements)
        self.calls: list[tuple[list[str], dict]] = []
        self.fail_on = fail_on

    def __call__(self, argv, **kwargs):
        self.calls.append((list(argv), kwargs))
        verb = argv[1] if argv[1] != "-j" else argv[2]
        if self.fail_on == verb:
            return subprocess.CompletedProcess(argv, 1, "", "Error: simulated")
        if verb == "list":
            body = {"nftables": [{"metainfo": {}}, {"set": {
                "family": "inet", "table": "aegis_idea3", "name": "blocked_ipv4",
                "type": "ipv4_addr", "elem": sorted(self.elements),
            }}]}
            return subprocess.CompletedProcess(argv, 0, json.dumps(body), "")
        ip = argv[argv.index("{") + 1]
        if verb == "add":
            self.elements.add(ip)
        elif verb == "delete":
            if ip not in self.elements:
                return subprocess.CompletedProcess(argv, 1, "", "Error: No such file or directory")
            self.elements.discard(ip)
        return subprocess.CompletedProcess(argv, 0, "", "")

    def mutations(self):
        return [argv for argv, _ in self.calls if argv[1] in {"add", "delete"}]


def _service(nft=None, protected=PROTECTED):
    nft = nft if nft is not None else FakeNft()
    return ipc.ContainmentService(ipc.NftBlockSet(runner=nft), protected), nft


# A. IPv4 validation -----------------------------------------------------------

@pytest.mark.parametrize("value", ["203.0.113.10", "10.20.30.40", "192.168.1.50", "172.16.5.5"])
def test_accepts_routable_and_private_ipv4(value):
    assert ipc.validate_block_target(value, PROTECTED) == ipaddress.IPv4Address(value)


@pytest.mark.parametrize(
    ("value", "code"),
    [
        ("not-an-ip", "INVALID_IP"),
        ("203.0.113.10 ", "INVALID_IP"),
        ("203.0.113.010", "INVALID_IP"),
        ("203.0.113.0/24", "INVALID_IP"),
        ("", "INVALID_IP"),
        (None, "INVALID_IP"),
        (1234, "INVALID_IP"),
        ("2001:db8::1", "IPV6_UNSUPPORTED"),
        ("0.0.0.0", "UNSPECIFIED_ADDRESS"),
        ("0.1.2.3", "UNSPECIFIED_ADDRESS"),
        ("127.0.0.1", "LOOPBACK_ADDRESS"),
        ("127.8.8.8", "LOOPBACK_ADDRESS"),
        ("224.0.0.1", "MULTICAST_ADDRESS"),
        ("169.254.1.1", "LINK_LOCAL_ADDRESS"),
        ("255.255.255.255", "RESERVED_ADDRESS"),
        ("240.0.0.1", "RESERVED_ADDRESS"),
    ],
)
def test_rejects_unsafe_targets(value, code):
    with pytest.raises(ipc.ContainmentRejected) as error:
        ipc.validate_block_target(value, PROTECTED)
    assert error.value.reason_code == code


# B. Protected address / CIDR --------------------------------------------------

@pytest.mark.parametrize("value", ["192.0.2.1", "192.0.2.15", "198.51.100.7"])
def test_rejects_protected_addresses(value):
    with pytest.raises(ipc.ContainmentRejected) as error:
        ipc.validate_block_target(value, PROTECTED)
    assert error.value.reason_code == "PROTECTED_ADDRESS"


def test_protected_block_request_never_touches_nft():
    service, nft = _service()
    response = service.handle({"op": "block", "ip": "192.0.2.3"})
    assert response["ok"] is False and response["reason_code"] == "PROTECTED_ADDRESS"
    assert nft.calls == []


@pytest.mark.parametrize(
    "spec",
    ["", "   ", "192.0.2.0/33", "192.0.2.1/24", "not-a-cidr", "2001:db8::/32", "192.0.2.0/28,,", "0.0.0.0/0"],
)
def test_malformed_protection_configuration_fails_closed(spec):
    with pytest.raises(ipc.ProtectionConfigError):
        ipc.parse_protected_cidrs(spec)


def test_helper_refuses_to_start_without_protection_configuration(monkeypatch):
    monkeypatch.delenv(ipc.PROTECTED_ENV, raising=False)
    with pytest.raises(ipc.ProtectionConfigError):
        ipc.protected_from_environment()


# C. Exact nft argv, no shell --------------------------------------------------

def test_block_uses_exact_argv_without_shell():
    service, nft = _service()
    service.handle({"op": "block", "ip": "203.0.113.10"})
    assert nft.mutations() == [[
        "/usr/bin/nft", "add", "element", "inet", "aegis_idea3", "blocked_ipv4", "{", "203.0.113.10", "}",
    ]]
    for argv, kwargs in nft.calls:
        assert kwargs.get("shell", False) is False
        assert isinstance(argv, list)
        assert kwargs.get("timeout")


def test_unblock_uses_exact_argv_and_reads_set_with_json():
    service, nft = _service(FakeNft({"203.0.113.10"}))
    service.handle({"op": "unblock", "ip": "203.0.113.10"})
    assert nft.calls[0][0] == ["/usr/bin/nft", "-j", "list", "set", "inet", "aegis_idea3", "blocked_ipv4"]
    assert nft.mutations() == [[
        "/usr/bin/nft", "delete", "element", "inet", "aegis_idea3", "blocked_ipv4", "{", "203.0.113.10", "}",
    ]]


def test_module_never_uses_shell_true_or_destructive_nft_verbs():
    source = (ROOT / "aegis_soc/ip_containment.py").read_text(encoding="utf-8")
    assert "shell=True" not in source
    for forbidden in ('"flush"', "flush ruleset", '"table", "delete"', "delete table", "os.system"):
        assert forbidden not in source


# D–G. Idempotent block / unblock ----------------------------------------------

def test_block_then_repeat_block_is_idempotent():
    service, nft = _service()
    first = service.handle({"op": "block", "ip": "203.0.113.10"})
    second = service.handle({"op": "block", "ip": "203.0.113.10"})
    assert first == {"ok": True, "changed": True, "operation": "block", "ip": "203.0.113.10", "reason_code": "BLOCKED"}
    assert second == {
        "ok": True, "changed": False, "operation": "block", "ip": "203.0.113.10", "reason_code": "ALREADY_BLOCKED",
    }
    assert len(nft.mutations()) == 1
    assert nft.elements == {"203.0.113.10"}


def test_unblock_then_repeat_unblock_is_idempotent():
    service, nft = _service(FakeNft({"203.0.113.10"}))
    first = service.handle({"op": "unblock", "ip": "203.0.113.10"})
    second = service.handle({"op": "unblock", "ip": "203.0.113.10"})
    assert first["ok"] is True and first["changed"] is True and first["reason_code"] == "UNBLOCKED"
    assert second["ok"] is True and second["changed"] is False and second["reason_code"] == "NOT_BLOCKED"
    assert len(nft.mutations()) == 1
    assert nft.elements == set()


def test_unblock_of_protected_address_is_allowed_for_recovery():
    """Protection prevents new blocks; it must never prevent removing a stale block."""
    service, nft = _service(FakeNft({"192.0.2.3"}))
    response = service.handle({"op": "unblock", "ip": "192.0.2.3"})
    assert response["ok"] is True and response["changed"] is True
    assert nft.elements == set()


def test_contains_and_list_are_read_only():
    service, nft = _service(FakeNft({"203.0.113.10", "203.0.113.11"}))
    contains = service.handle({"op": "contains", "ip": "203.0.113.10"})
    listing = service.handle({"op": "list"})
    assert contains["ok"] is True and contains["present"] is True and contains["changed"] is False
    assert listing["ok"] is True and listing["blocked"] == ["203.0.113.10", "203.0.113.11"]
    assert nft.mutations() == []


# H. nft failure never claims success -----------------------------------------

@pytest.mark.parametrize("verb", ["add", "list"])
def test_block_failure_is_reported(verb):
    service, _nft = _service(FakeNft(fail_on=verb))
    response = service.handle({"op": "block", "ip": "203.0.113.10"})
    assert response["ok"] is False and response["changed"] is False
    assert response["reason_code"] == "NFT_FAILED"


def test_unblock_failure_is_reported():
    service, _nft = _service(FakeNft({"203.0.113.10"}, fail_on="delete"))
    response = service.handle({"op": "unblock", "ip": "203.0.113.10"})
    assert response["ok"] is False and response["reason_code"] == "NFT_FAILED"


def test_nft_timeout_or_missing_binary_is_reported():
    def raising(argv, **kwargs):
        raise subprocess.TimeoutExpired(argv, 1)

    service = ipc.ContainmentService(ipc.NftBlockSet(runner=raising), PROTECTED)
    assert service.handle({"op": "block", "ip": "203.0.113.10"})["reason_code"] == "NFT_FAILED"

    def missing(argv, **kwargs):
        raise FileNotFoundError(argv[0])

    service = ipc.ContainmentService(ipc.NftBlockSet(runner=missing), PROTECTED)
    assert service.handle({"op": "block", "ip": "203.0.113.10"})["ok"] is False


def test_unparseable_set_listing_is_a_failure():
    def garbage(argv, **kwargs):
        return subprocess.CompletedProcess(argv, 0, "{not json", "")

    service = ipc.ContainmentService(ipc.NftBlockSet(runner=garbage), PROTECTED)
    assert service.handle({"op": "block", "ip": "203.0.113.10"})["reason_code"] == "NFT_FAILED"


# I–K. Request validation -----------------------------------------------------

@pytest.mark.parametrize(
    "raw",
    [b"not json\n", b"[1,2]\n", b'"block"\n', b"{}\n", b'{"op": 1}\n', b'{"op":"block"}\n',
     b'{"op":"block","ip":"203.0.113.10","extra":1}\n', b"\xff\xfe\n"],
)
def test_malformed_requests_are_rejected(raw):
    service, nft = _service()
    response = service.handle_raw(raw)
    assert response["ok"] is False
    assert response["reason_code"] in {"MALFORMED_REQUEST", "INVALID_IP"}
    assert nft.calls == []


def test_unknown_operation_is_rejected():
    service, nft = _service()
    response = service.handle_raw(b'{"op":"flush","ip":"203.0.113.10"}\n')
    assert response["ok"] is False and response["reason_code"] == "UNKNOWN_OPERATION"
    assert nft.calls == []


def test_oversized_request_is_rejected():
    service, nft = _service()
    raw = b'{"op":"block","ip":"' + b"1" * (ipc.MAX_REQUEST_BYTES + 10) + b'"}\n'
    response = service.handle_raw(raw)
    assert response["ok"] is False and response["reason_code"] == "REQUEST_TOO_LARGE"
    assert nft.calls == []


# Socket boundary --------------------------------------------------------------

def _serve_once(tmp_path, service, *, allowed_uids=None):
    path = tmp_path / "containment.sock"
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    listener.bind(str(path))
    listener.listen(4)
    server = ipc.ContainmentServer(
        listener, service, allowed_uids=allowed_uids if allowed_uids is not None else {os.geteuid()},
    )
    thread = threading.Thread(target=server.serve_one, daemon=True)
    thread.start()
    return path, listener, thread


def test_socket_roundtrip_block(tmp_path):
    service, nft = _service()
    path, listener, thread = _serve_once(tmp_path, service)
    client = ipc.ContainmentClient(path, timeout=2, expected_server_uid=os.geteuid())
    response = client.block("203.0.113.10")
    thread.join(2)
    listener.close()
    assert response["ok"] is True and response["changed"] is True
    assert nft.elements == {"203.0.113.10"}


def test_socket_refuses_unauthorized_peer(tmp_path):
    service, nft = _service()
    path, listener, thread = _serve_once(tmp_path, service, allowed_uids={os.geteuid() + 12345})
    client = ipc.ContainmentClient(path, timeout=2, expected_server_uid=os.geteuid())
    response = client.block("203.0.113.10")
    thread.join(2)
    listener.close()
    assert response["ok"] is False and response["reason_code"] == "PEER_NOT_AUTHORIZED"
    assert nft.calls == []


def test_client_refuses_server_not_owned_by_expected_uid(tmp_path):
    service, nft = _service()
    path, listener, thread = _serve_once(tmp_path, service)
    client = ipc.ContainmentClient(path, timeout=2, expected_server_uid=os.geteuid() + 12345)
    with pytest.raises(ipc.ContainmentUnavailable):
        client.block("203.0.113.10")
    listener.close()
    thread.join(2)
    assert nft.calls == []


# L. Client unavailability ------------------------------------------------------

def test_client_reports_missing_helper(tmp_path):
    client = ipc.ContainmentClient(tmp_path / "absent.sock", timeout=0.5, expected_server_uid=os.geteuid())
    with pytest.raises(ipc.ContainmentUnavailable):
        client.block("203.0.113.10")


def test_client_times_out_on_silent_helper(tmp_path):
    path = tmp_path / "silent.sock"
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    listener.bind(str(path))
    listener.listen(1)
    try:
        client = ipc.ContainmentClient(path, timeout=0.3, expected_server_uid=os.geteuid())
        with pytest.raises(ipc.ContainmentUnavailable):
            client.block("203.0.113.10")
    finally:
        listener.close()


def test_systemd_socket_activation_requires_matching_pid(monkeypatch):
    monkeypatch.setenv("LISTEN_PID", str(os.getpid() + 1))
    monkeypatch.setenv("LISTEN_FDS", "1")
    with pytest.raises(RuntimeError):
        ipc.systemd_listener()


# S. nftables template / systemd boundary ------------------------------------

def test_nft_template_declares_dynamic_ipv4_set_and_early_drops():
    text = NFT_TEMPLATE.read_text(encoding="utf-8")
    assert "set blocked_ipv4 {" in text
    set_body = text.split("set blocked_ipv4 {", 1)[1].split("}", 1)[0]
    assert "type ipv4_addr" in set_body
    for chain in ("input", "forward"):
        body = text.split(f"chain {chain} {{", 1)[1].split("\n    }", 1)[0]
        rules = [
            line.strip() for line in body.splitlines()
            if line.strip() and not line.strip().startswith("#") and not line.strip().startswith("type ")
        ]
        assert rules[0] == "ip saddr @blocked_ipv4 drop", chain
    assert "flush" not in text.lower()
    assert re.search(r"\bnat\b|masquerade|snat|dnat", text.lower()) is None


def test_containment_units_keep_core_unprivileged():
    core = CORE_UNIT.read_text(encoding="utf-8")
    assert "CapabilityBoundingSet=\n" in core
    assert "AmbientCapabilities=\n" in core
    assert "NoNewPrivileges=true" in core
    assert "CAP_NET_ADMIN" not in core

    sock = SOCKET_UNIT.read_text(encoding="utf-8")
    assert "ListenStream=/run/aegis-idea3-containment/containment.sock" in sock
    assert "SocketMode=0660" in sock
    assert "SocketGroup=aegis-idea3" in sock
    assert "Accept=no" in sock

    service = SERVICE_UNIT.read_text(encoding="utf-8")
    assert "CapabilityBoundingSet=CAP_NET_ADMIN\n" in service
    assert "NoNewPrivileges=true" in service
    assert "PrivateNetwork" not in service
    assert "EnvironmentFile=/etc/aegis-idea3/containment.env" in service
    assert "-m aegis_soc.ip_containment" in service
    assert "RestrictAddressFamilies=AF_UNIX AF_NETLINK" in service


# Hardening -------------------------------------------------------------------

def test_listing_without_reviewed_set_is_a_failure():
    def other_set(argv, **kwargs):
        body = {"nftables": [{"set": {"family": "inet", "table": "other", "name": "blocked_ipv4", "elem": []}}]}
        return subprocess.CompletedProcess(argv, 0, json.dumps(body), "")

    service = ipc.ContainmentService(ipc.NftBlockSet(runner=other_set), PROTECTED)
    response = service.handle({"op": "block", "ip": "203.0.113.10"})
    assert response["ok"] is False and response["reason_code"] == "NFT_FAILED"


def test_add_that_nft_accepts_but_does_not_apply_is_not_success():
    class SilentAdd(FakeNft):
        def __call__(self, argv, **kwargs):
            if argv[1] == "add":
                self.calls.append((list(argv), kwargs))
                return subprocess.CompletedProcess(argv, 0, "", "")
            return super().__call__(argv, **kwargs)

    service, _nft = _service(SilentAdd())
    response = service.handle({"op": "block", "ip": "203.0.113.10"})
    assert response["ok"] is False and response["reason_code"] == "NFT_FAILED"


@pytest.mark.parametrize(
    "request_body",
    [
        {"op": "block", "ip": "203.0.113.10"},
        {"op": "unblock", "ip": "203.0.113.10"},
        {"op": "contains", "ip": "203.0.113.10"},
        {"op": "list"},
    ],
)
def test_every_nft_call_targets_only_the_reviewed_set(request_body):
    service, nft = _service(FakeNft({"203.0.113.10"}))
    service.handle(request_body)
    assert nft.calls
    for argv, kwargs in nft.calls:
        assert argv[0] == "/usr/bin/nft"
        tail = argv[argv.index("inet"):argv.index("inet") + 3]
        assert tail == ["inet", "aegis_idea3", "blocked_ipv4"]
        assert "shell" not in kwargs


@pytest.mark.parametrize("key", ["table", "set", "family"])
def test_caller_cannot_select_table_or_set(key):
    service, nft = _service()
    response = service.handle({"op": "block", "ip": "203.0.113.10", key: "filter"})
    assert response["ok"] is False and response["reason_code"] == "MALFORMED_REQUEST"
    assert nft.calls == []


def test_concurrent_requests_are_serialized():
    import time

    active = []
    overlaps = []

    class SlowNft(FakeNft):
        def __call__(self, argv, **kwargs):
            active.append(1)
            if len(active) > 1:
                overlaps.append(list(argv))
            time.sleep(0.005)
            try:
                return super().__call__(argv, **kwargs)
            finally:
                active.pop()

    service, nft = _service(SlowNft())
    ips = [f"203.0.113.{n}" for n in range(10, 20)]
    threads = [threading.Thread(target=service.handle, args=({"op": op, "ip": ip},))
               for ip in ips for op in ("block", "unblock", "block")]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(5)
    assert overlaps == []
    assert nft.elements <= set(ips)


def _raw_exchange(tmp_path, payload: bytes, *, close_write=True):
    service, nft = _service()
    path, listener, thread = _serve_once(tmp_path, service)
    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    client.settimeout(3)
    client.connect(str(path))
    client.sendall(payload)
    if close_write:
        client.shutdown(socket.SHUT_WR)
    reply = client.makefile("rb").readline()
    client.close()
    thread.join(3)
    listener.close()
    return json.loads(reply), nft


@pytest.mark.parametrize(
    ("payload", "code"),
    [
        (b"not json\n", "MALFORMED_REQUEST"),
        (b'{"op":"drop-table"}\n', "UNKNOWN_OPERATION"),
        (b'{"op":"block","ip":"' + b"9" * 4096 + b'"}\n', "REQUEST_TOO_LARGE"),
        (b"x" * 10_000, "REQUEST_TOO_LARGE"),
        (b"", "MALFORMED_REQUEST"),
    ],
)
def test_socket_rejects_malformed_and_oversized_payloads(tmp_path, payload, code):
    response, nft = _raw_exchange(tmp_path, payload)
    assert response["ok"] is False and response["reason_code"] == code
    assert nft.calls == []


def test_server_survives_client_that_disconnects_early(tmp_path):
    service, _nft = _service()
    path, listener, thread = _serve_once(tmp_path, service)
    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    client.connect(str(path))
    client.close()
    thread.join(3)
    listener.close()
    assert not thread.is_alive()


def test_client_rejects_non_json_reply(tmp_path):
    path = tmp_path / "bogus.sock"
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    listener.bind(str(path))
    listener.listen(1)

    def reply_garbage():
        connection, _ = listener.accept()
        with connection:
            connection.recv(1024)
            connection.sendall(b"garbage\n")

    thread = threading.Thread(target=reply_garbage, daemon=True)
    thread.start()
    try:
        client = ipc.ContainmentClient(path, timeout=2, expected_server_uid=os.geteuid())
        with pytest.raises(ipc.ContainmentUnavailable):
            client.block("203.0.113.10")
    finally:
        thread.join(2)
        listener.close()


def test_only_the_containment_helper_unit_holds_cap_net_admin():
    holders = sorted(
        path.name for path in (ROOT / "deploy").rglob("*")
        if path.is_file()
        and (".service" in path.name or ".socket" in path.name)
        and "CAP_NET_ADMIN" in path.read_text(encoding="utf-8", errors="ignore")
    )
    assert holders == ["aegis-idea3-containment.service.example"]


def test_socket_unit_is_not_world_accessible():
    sock = SOCKET_UNIT.read_text(encoding="utf-8")
    mode = re.search(r"^SocketMode=0([0-7]{3})$", sock, re.MULTILINE)
    assert mode is not None and mode.group(1)[2] == "0"
    assert "SocketUser=root" in sock
    assert "ListenStream=0.0.0.0" not in sock and "ListenStream=[" not in sock
