"""Narrow privileged boundary for dynamic IPv4 software containment.

The root-owned helper (``python -m aegis_soc.ip_containment``) is started by a
systemd socket unit and owns only the elements of ``inet aegis_idea3``'s
``blocked_ipv4`` set. The unprivileged Core and ``aegisctl`` reach it through
``ContainmentClient`` over a Unix socket; neither ever runs ``nft`` itself.

IPv4 only. IPv6 containment is future work and is rejected explicitly.
This module imports only the standard library so the helper stays small.
"""

from __future__ import annotations

import ipaddress
import json
import os
import socket
import struct
import subprocess
import sys
import threading
from pathlib import Path
from typing import Any, Callable

NFT_BINARY = "/usr/bin/nft"
NFT_FAMILY = "inet"
NFT_TABLE = "aegis_idea3"
NFT_SET = "blocked_ipv4"
NFT_TIMEOUT_SEC = 5.0

DEFAULT_SOCKET_PATH = "/run/aegis-idea3-containment/containment.sock"
SOCKET_ENV = "AEGIS_CONTAINMENT_SOCKET"
PROTECTED_ENV = "AEGIS_CONTAINMENT_PROTECTED_CIDRS"
CLIENT_USER_ENV = "AEGIS_CONTAINMENT_CLIENT_USER"
DEFAULT_CLIENT_USER = "aegis-idea3"

MAX_REQUEST_BYTES = 256
MAX_RESPONSE_BYTES = 256 * 1024
CONNECTION_TIMEOUT_SEC = 2.0

MUTATING_OPS = frozenset({"block", "unblock"})
READ_OPS = frozenset({"contains", "list"})
OPERATIONS = MUTATING_OPS | READ_OPS

_THIS_NETWORK = ipaddress.IPv4Network("0.0.0.0/8")


class ContainmentRejected(ValueError):
    def __init__(self, reason_code: str):
        super().__init__(reason_code)
        self.reason_code = reason_code


class ProtectionConfigError(ValueError):
    """Protected-address configuration is missing or malformed; fail closed."""


class NftError(RuntimeError):
    """nft did not confirm the requested read or mutation."""


class ContainmentUnavailable(RuntimeError):
    """The helper could not be reached or returned no bounded, valid answer."""


# ---- validation --------------------------------------------------------------

def parse_ipv4(value: Any) -> ipaddress.IPv4Address:
    if not isinstance(value, str) or not value or value != value.strip():
        raise ContainmentRejected("INVALID_IP")
    try:
        address = ipaddress.ip_address(value)
    except ValueError:
        raise ContainmentRejected("INVALID_IP") from None
    if address.version != 4:
        raise ContainmentRejected("IPV6_UNSUPPORTED")
    return address


def validate_block_target(value: Any, protected: tuple[ipaddress.IPv4Network, ...]) -> ipaddress.IPv4Address:
    address = parse_ipv4(value)
    if address.is_unspecified or address in _THIS_NETWORK:
        raise ContainmentRejected("UNSPECIFIED_ADDRESS")
    if address.is_loopback:
        raise ContainmentRejected("LOOPBACK_ADDRESS")
    if address.is_multicast:
        raise ContainmentRejected("MULTICAST_ADDRESS")
    if address.is_link_local:
        raise ContainmentRejected("LINK_LOCAL_ADDRESS")
    # 240.0.0.0/4 includes the limited broadcast address.
    if address.is_reserved:
        raise ContainmentRejected("RESERVED_ADDRESS")
    # RFC1918 is intentionally allowed: the authorized test client may use it.
    if any(address in network for network in protected):
        raise ContainmentRejected("PROTECTED_ADDRESS")
    return address


def parse_protected_cidrs(spec: str) -> tuple[ipaddress.IPv4Network, ...]:
    if not isinstance(spec, str) or not spec.strip():
        raise ProtectionConfigError("protected CIDR list is empty")
    networks = []
    for item in spec.split(","):
        item = item.strip()
        if not item:
            raise ProtectionConfigError("protected CIDR list has an empty entry")
        try:
            network = ipaddress.ip_network(item, strict=True)
        except ValueError:
            raise ProtectionConfigError("protected CIDR entry is malformed") from None
        if network.version != 4:
            raise ProtectionConfigError("protected CIDR entries are IPv4 only")
        if network.prefixlen == 0:
            raise ProtectionConfigError("protecting 0.0.0.0/0 would disable containment")
        networks.append(network)
    return tuple(networks)


def protected_from_environment(environ=None) -> tuple[ipaddress.IPv4Network, ...]:
    environ = os.environ if environ is None else environ
    return parse_protected_cidrs(environ.get(PROTECTED_ENV, ""))


# ---- nft backend -------------------------------------------------------------

class NftBlockSet:
    """Exact-argv access to one reviewed set. Never touches the table itself."""

    def __init__(self, runner: Callable[..., subprocess.CompletedProcess] = subprocess.run):
        self._runner = runner

    def _run(self, argv: list[str]) -> str:
        try:
            result = self._runner(argv, capture_output=True, text=True, timeout=NFT_TIMEOUT_SEC, check=False)
        except (OSError, subprocess.SubprocessError) as error:
            raise NftError(type(error).__name__) from None
        if result.returncode != 0:
            raise NftError(f"nft exited {result.returncode}")
        return result.stdout or ""

    def _element_argv(self, verb: str, address: ipaddress.IPv4Address) -> list[str]:
        return [NFT_BINARY, verb, "element", NFT_FAMILY, NFT_TABLE, NFT_SET, "{", str(address), "}"]

    def members(self) -> set[str]:
        output = self._run([NFT_BINARY, "-j", "list", "set", NFT_FAMILY, NFT_TABLE, NFT_SET])
        try:
            document = json.loads(output)
            entries = document["nftables"]
        except (ValueError, KeyError, TypeError):
            raise NftError("unparseable set listing") from None
        found = None
        for entry in entries:
            if isinstance(entry, dict) and isinstance(entry.get("set"), dict):
                candidate = entry["set"]
                if candidate.get("table") == NFT_TABLE and candidate.get("name") == NFT_SET:
                    found = candidate
        if found is None:
            raise NftError("reviewed set missing from listing")
        members = set()
        for element in found.get("elem", []):
            # Plain sets list bare strings; elements with metadata nest {"elem": {"val": ...}}.
            value = element.get("elem", element) if isinstance(element, dict) else element
            if isinstance(value, dict):
                value = value.get("val")
            if not isinstance(value, str):
                raise NftError("unexpected set element shape")
            members.add(value)
        return members

    def add(self, address: ipaddress.IPv4Address) -> None:
        self._run(self._element_argv("add", address))

    def delete(self, address: ipaddress.IPv4Address) -> None:
        self._run(self._element_argv("delete", address))


# ---- request handling --------------------------------------------------------

def _response(ok: bool, operation: str | None, ip: str | None, reason_code: str,
              *, changed: bool = False, **extra) -> dict[str, Any]:
    return {"ok": ok, "changed": changed, "operation": operation, "ip": ip, "reason_code": reason_code, **extra}


class ContainmentService:
    def __init__(self, block_set: NftBlockSet, protected: tuple[ipaddress.IPv4Network, ...]):
        self.block_set = block_set
        self.protected = protected
        self._lock = threading.Lock()

    def handle_raw(self, raw: bytes) -> dict[str, Any]:
        if len(raw) > MAX_REQUEST_BYTES:
            return _response(False, None, None, "REQUEST_TOO_LARGE")
        try:
            request = json.loads(raw.decode("utf-8"))
        except (UnicodeError, ValueError):
            return _response(False, None, None, "MALFORMED_REQUEST")
        return self.handle(request)

    def handle(self, request: Any) -> dict[str, Any]:
        if not isinstance(request, dict) or not isinstance(request.get("op"), str):
            return _response(False, None, None, "MALFORMED_REQUEST")
        op = request["op"]
        if op not in OPERATIONS:
            return _response(False, None, None, "UNKNOWN_OPERATION")
        expected = {"op"} if op == "list" else {"op", "ip"}
        if set(request) != expected:
            return _response(False, op, None, "MALFORMED_REQUEST")
        with self._lock:
            if op == "list":
                return self._list()
            try:
                if op == "block":
                    address = validate_block_target(request["ip"], self.protected)
                else:
                    # Unblock and lookup only need a valid IPv4 address: an operator
                    # must always be able to remove a block, even a stale protected one.
                    address = parse_ipv4(request["ip"])
            except ContainmentRejected as error:
                return _response(False, op, None, error.reason_code)
            return getattr(self, f"_{op}")(address)

    def _block(self, address) -> dict[str, Any]:
        ip = str(address)
        try:
            if ip in self.block_set.members():
                return _response(True, "block", ip, "ALREADY_BLOCKED")
            self.block_set.add(address)
            if ip not in self.block_set.members():
                return _response(False, "block", ip, "NFT_FAILED")
        except NftError:
            return _response(False, "block", ip, "NFT_FAILED")
        return _response(True, "block", ip, "BLOCKED", changed=True)

    def _unblock(self, address) -> dict[str, Any]:
        ip = str(address)
        try:
            if ip not in self.block_set.members():
                return _response(True, "unblock", ip, "NOT_BLOCKED")
            self.block_set.delete(address)
            if ip in self.block_set.members():
                return _response(False, "unblock", ip, "NFT_FAILED")
        except NftError:
            return _response(False, "unblock", ip, "NFT_FAILED")
        return _response(True, "unblock", ip, "UNBLOCKED", changed=True)

    def _contains(self, address) -> dict[str, Any]:
        ip = str(address)
        try:
            present = ip in self.block_set.members()
        except NftError:
            return _response(False, "contains", ip, "NFT_FAILED")
        return _response(True, "contains", ip, "PRESENT" if present else "ABSENT", present=present)

    def _list(self) -> dict[str, Any]:
        try:
            members = self.block_set.members()
        except NftError:
            return _response(False, "list", None, "NFT_FAILED")
        ordered = sorted(members, key=lambda value: ipaddress.IPv4Address(value))
        return _response(True, "list", None, "LISTED", blocked=ordered)


# ---- socket server (root helper) ---------------------------------------------

def _peer_credentials(connection: socket.socket) -> tuple[int, int, int]:
    raw = connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i"))
    return struct.unpack("3i", raw)


def _read_line(connection: socket.socket, limit: int) -> bytes:
    buffer = b""
    while b"\n" not in buffer and len(buffer) <= limit:
        chunk = connection.recv(4096)
        if not chunk:
            break
        buffer += chunk
    return buffer.split(b"\n", 1)[0]


class ContainmentServer:
    def __init__(self, listener: socket.socket, service: ContainmentService, *,
                 allowed_uids: set[int], audit: Callable[[dict], None] | None = None):
        self.listener = listener
        self.service = service
        self.allowed_uids = frozenset(allowed_uids)
        self.audit = audit or (lambda record: None)

    def serve_one(self) -> None:
        connection, _ = self.listener.accept()
        with connection:
            connection.settimeout(CONNECTION_TIMEOUT_SEC)
            try:
                _pid, uid, _gid = _peer_credentials(connection)
                if uid not in self.allowed_uids:
                    response = _response(False, None, None, "PEER_NOT_AUTHORIZED")
                else:
                    raw = _read_line(connection, MAX_REQUEST_BYTES)
                    response = self.service.handle_raw(raw)
                self.audit({"peer_uid": uid, **{k: response[k] for k in
                            ("ok", "changed", "operation", "ip", "reason_code")}})
                connection.sendall(json.dumps(response, sort_keys=True).encode("utf-8") + b"\n")
            except OSError:
                return

    def serve_forever(self) -> None:
        while True:
            self.serve_one()


def systemd_listener(environ=None) -> socket.socket:
    environ = os.environ if environ is None else environ
    if environ.get("LISTEN_PID") != str(os.getpid()) or environ.get("LISTEN_FDS") != "1":
        raise RuntimeError("expected exactly one systemd-activated socket")
    listener = socket.socket(fileno=3)
    if listener.family != socket.AF_UNIX or listener.type != socket.SOCK_STREAM:
        raise RuntimeError("activated socket is not a Unix stream socket")
    return listener


def _allowed_uids(environ) -> set[int]:
    import pwd

    user = environ.get(CLIENT_USER_ENV, DEFAULT_CLIENT_USER)
    return {0, pwd.getpwnam(user).pw_uid}


def _journal(record: dict) -> None:
    print(json.dumps({"component": "ip_containment", **record}, sort_keys=True), flush=True)


def main(environ=None) -> int:
    environ = os.environ if environ is None else environ
    try:
        protected = protected_from_environment(environ)
    except ProtectionConfigError as error:
        print(f"IP_CONTAINMENT=REFUSED reason=PROTECTION_CONFIG_INVALID detail={error}", file=sys.stderr)
        return 2
    try:
        listener = systemd_listener(environ)
        allowed = _allowed_uids(environ)
    except (RuntimeError, KeyError, OSError) as error:
        print(f"IP_CONTAINMENT=REFUSED reason=STARTUP_INVALID detail={type(error).__name__}", file=sys.stderr)
        return 2
    service = ContainmentService(NftBlockSet(), protected)
    ContainmentServer(listener, service, allowed_uids=allowed, audit=_journal).serve_forever()
    return 0


# ---- client (Core and aegisctl) ----------------------------------------------

class ContainmentClient:
    def __init__(self, path: Path | str | None = None, *, timeout: float = 3.0,
                 expected_server_uid: int = 0):
        self.path = Path(path or os.environ.get(SOCKET_ENV) or DEFAULT_SOCKET_PATH)
        self.timeout = timeout
        self.expected_server_uid = expected_server_uid

    def request(self, body: dict[str, Any]) -> dict[str, Any]:
        client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        client.settimeout(self.timeout)
        try:
            client.connect(str(self.path))
            _pid, uid, _gid = _peer_credentials(client)
            if uid != self.expected_server_uid:
                raise ContainmentUnavailable("containment helper is not owned by the expected account")
            client.sendall(json.dumps(body).encode("utf-8") + b"\n")
            reply = client.makefile("rb").readline(MAX_RESPONSE_BYTES + 1)
        except OSError as error:
            raise ContainmentUnavailable(f"containment helper unavailable: {type(error).__name__}") from None
        finally:
            client.close()
        if not reply or len(reply) > MAX_RESPONSE_BYTES:
            raise ContainmentUnavailable("containment helper returned no bounded result")
        try:
            response = json.loads(reply.decode("utf-8"))
        except (UnicodeError, ValueError):
            raise ContainmentUnavailable("containment helper returned an invalid result") from None
        if not isinstance(response, dict) or not isinstance(response.get("ok"), bool):
            raise ContainmentUnavailable("containment helper returned an invalid result")
        return response

    def block(self, ip: str) -> dict[str, Any]:
        return self.request({"op": "block", "ip": ip})

    def unblock(self, ip: str) -> dict[str, Any]:
        return self.request({"op": "unblock", "ip": ip})

    def contains(self, ip: str) -> dict[str, Any]:
        return self.request({"op": "contains", "ip": ip})

    def list(self) -> dict[str, Any]:
        return self.request({"op": "list"})


if __name__ == "__main__":
    raise SystemExit(main())
