#!/usr/bin/env python3
"""PF-02 isolated dnsmasq proof for IDEA3 PR11 Phase 4 T5."""

from __future__ import annotations

import os
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import time
from pathlib import Path


LOCKDOWN = Path(__file__).resolve().parents[1]
RENDERER = LOCKDOWN / "deploy" / "pr11-phase4" / "p4-ap-network.py"

AP_IFACE = "ap-test0"
AP_PEER = "ap-peer0"
UPLINK_IFACE = "uplink-test0"
UPLINK_PEER = "uplink-peer0"

AP_ADDRESS = "192.0.2.1"
AP_SUBNET = "192.0.2.0/28"
DHCP_START = "192.0.2.2"
DHCP_END = "192.0.2.10"

UPLINK_ADDRESS = "198.51.100.1"
BROKER_HOSTNAME = "mqtt.aegis.invalid"

SO_BINDTODEVICE = getattr(socket, "SO_BINDTODEVICE", 25)


def run_checked(argv: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        argv,
        text=True,
        capture_output=True,
        check=True,
    )


def bind_to_device(sock: socket.socket, interface: str) -> None:
    sock.setsockopt(
        socket.SOL_SOCKET,
        SO_BINDTODEVICE,
        interface.encode("ascii") + b"\0",
    )


def internet_checksum(data: bytes) -> int:
    if len(data) % 2:
        data += b"\0"

    total = 0
    for index in range(0, len(data), 2):
        total += (data[index] << 8) | data[index + 1]
        total = (total & 0xFFFF) + (total >> 16)

    return (~total) & 0xFFFF


def interface_mac(interface: str) -> bytes:
    sock = socket.socket(
        socket.AF_PACKET,
        socket.SOCK_RAW,
        socket.htons(0x0800),
    )

    try:
        sock.bind((interface, 0))
        address = sock.getsockname()[4]

        if not isinstance(address, bytes) or len(address) != 6:
            raise RuntimeError(
                f"unexpected MAC address for {interface}: {address!r}"
            )

        return address
    finally:
        sock.close()

def dhcp_discover_packet(mac: bytes) -> bytes:
    xid = 0xAE610002

    bootp = struct.pack(
        "!BBBBIHH4s4s4s4s16s64s128s",
        1,
        1,
        6,
        0,
        xid,
        0,
        0x8000,
        b"\0" * 4,
        b"\0" * 4,
        b"\0" * 4,
        b"\0" * 4,
        mac + b"\0" * 10,
        b"\0" * 64,
        b"\0" * 128,
    )

    options = (
        b"\x63\x82\x53\x63"
        b"\x35\x01\x01"
        b"\x3d\x07\x01" + mac +
        b"\x37\x04\x01\x03\x06\x33"
        b"\xff"
    )

    packet = bootp + options
    return packet.ljust(300, b"\0")


def dhcp_discover_frame(interface: str) -> bytes:
    mac = interface_mac(interface)
    payload = dhcp_discover_packet(mac)

    udp_length = 8 + len(payload)
    udp_header = struct.pack(
        "!HHHH",
        68,
        67,
        udp_length,
        0,
    )

    total_length = 20 + udp_length

    source_ip = socket.inet_aton("0.0.0.0")
    destination_ip = socket.inet_aton("255.255.255.255")

    ip_header = struct.pack(
        "!BBHHHBBH4s4s",
        0x45,
        0,
        total_length,
        0,
        0,
        64,
        socket.IPPROTO_UDP,
        0,
        source_ip,
        destination_ip,
    )

    checksum = internet_checksum(ip_header)

    ip_header = struct.pack(
        "!BBHHHBBH4s4s",
        0x45,
        0,
        total_length,
        0,
        0,
        64,
        socket.IPPROTO_UDP,
        checksum,
        source_ip,
        destination_ip,
    )

    ethernet_header = (
        b"\xff" * 6
        + mac
        + struct.pack("!H", 0x0800)
    )

    return ethernet_header + ip_header + udp_header + payload


def probe_dhcp_path(
    send_interface: str,
    capture_interface: str,
    timeout: float = 0.8,
) -> tuple[bool, bool]:
    capture = socket.socket(
        socket.AF_PACKET,
        socket.SOCK_RAW,
        socket.htons(0x0003),
    )

    sender = socket.socket(
        socket.AF_PACKET,
        socket.SOCK_RAW,
        socket.htons(0x0800),
    )

    discover_seen = False
    reply_seen = False

    try:
        capture.bind((capture_interface, 0))
        sender.bind((send_interface, 0))

        deadline = time.monotonic() + timeout

        sender.send(
            dhcp_discover_frame(send_interface)
        )

        while True:
            remaining = deadline - time.monotonic()

            if remaining <= 0:
                break

            capture.settimeout(remaining)

            try:
                frame, _ = capture.recvfrom(65535)
            except socket.timeout:
                break

            if len(frame) < 14 + 20 + 8:
                continue

            if struct.unpack("!H", frame[12:14])[0] != 0x0800:
                continue

            ip_start = 14
            version_ihl = frame[ip_start]

            if version_ihl >> 4 != 4:
                continue

            ihl = (version_ihl & 0x0F) * 4

            if ihl < 20:
                continue

            if len(frame) < ip_start + ihl + 8:
                continue

            if frame[ip_start + 9] != socket.IPPROTO_UDP:
                continue

            udp_start = ip_start + ihl
            src_port, dst_port, _, _ = struct.unpack(
                "!HHHH",
                frame[udp_start:udp_start + 8],
            )

            if src_port == 68 and dst_port == 67:
                discover_seen = True

            if src_port == 67 and dst_port == 68:
                reply_seen = True

            if discover_seen and reply_seen:
                break

        print(
            "PF02_DHCP_PATH="
            f"{send_interface}->{capture_interface}:"
            f"DISCOVER={'YES' if discover_seen else 'NO'},"
            f"REPLY={'YES' if reply_seen else 'NO'}"
        )

        return discover_seen, reply_seen

    finally:
        sender.close()
        capture.close()

def dns_query_packet(name: str) -> bytes:
    txid = 0xAE62

    labels = name.split(".")
    qname = b"".join(
        bytes([len(label)]) + label.encode("ascii")
        for label in labels
    ) + b"\0"

    header = struct.pack(
        "!HHHHHH",
        txid,
        0x0100,
        1,
        0,
        0,
        0,
    )

    question = qname + struct.pack("!HH", 1, 1)
    return header + question


def dns_answer_on(
    interface: str,
    destination: str,
    timeout: float = 1.0,
) -> bool:
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)

    try:
        bind_to_device(sock, interface)
        sock.settimeout(timeout)

        query = dns_query_packet(BROKER_HOSTNAME)

        try:
            sock.sendto(query, (destination, 53))
            response, _ = sock.recvfrom(4096)
        except (
            socket.timeout,
            ConnectionRefusedError,
            OSError,
        ):
            return False

        if len(response) < 12:
            return False

        txid, _, _, answer_count, _, _ = struct.unpack(
            "!HHHHHH",
            response[:12],
        )

        if txid != 0xAE62 or answer_count < 1:
            return False

        return socket.inet_aton(AP_ADDRESS) in response
    finally:
        sock.close()


def wait_for_ap_dns(timeout: float = 3.0) -> bool:
    deadline = time.monotonic() + timeout

    while time.monotonic() < deadline:
        if dns_answer_on(AP_IFACE, AP_ADDRESS, timeout=0.2):
            return True
        time.sleep(0.05)

    return False


def namespace_main(config: Path, lease_file: Path) -> int:
    try:
        run_checked(["/usr/bin/ip", "link", "set", "lo", "up"])

        run_checked([
            "/usr/bin/ip",
            "link",
            "add",
            AP_IFACE,
            "type",
            "veth",
            "peer",
            "name",
            AP_PEER,
        ])
        run_checked([
            "/usr/bin/ip",
            "addr",
            "add",
            f"{AP_ADDRESS}/28",
            "dev",
            AP_IFACE,
        ])
        run_checked([
            "/usr/bin/ip",
            "link",
            "set",
            AP_IFACE,
            "up",
        ])
        run_checked([
            "/usr/bin/ip",
            "link",
            "set",
            AP_PEER,
            "up",
        ])

        run_checked([
            "/usr/bin/ip",
            "link",
            "add",
            UPLINK_IFACE,
            "type",
            "veth",
            "peer",
            "name",
            UPLINK_PEER,
        ])
        run_checked([
            "/usr/bin/ip",
            "addr",
            "add",
            f"{UPLINK_ADDRESS}/28",
            "dev",
            UPLINK_IFACE,
        ])
        run_checked([
            "/usr/bin/ip",
            "link",
            "set",
            UPLINK_IFACE,
            "up",
        ])
        run_checked([
            "/usr/bin/ip",
            "link",
            "set",
            UPLINK_PEER,
            "up",
        ])
    except subprocess.CalledProcessError as exc:
        print("PF02_SETUP=FAIL")
        print(exc.stderr, file=sys.stderr)
        return 1

    links = run_checked([
        "/usr/bin/ip",
        "-o",
        "link",
        "show",
    ]).stdout

    for forbidden in ("wlp0s20f3", "enp62s0"):
        if forbidden in links:
            print("PF02_REAL_INTERFACE_USE=YES")
            return 1

    print("PF02_REAL_INTERFACE_USE=NO")

    syntax = subprocess.run(
        [
            "/usr/bin/dnsmasq",
            "--test",
            f"--conf-file={config}",
            f"--dhcp-leasefile={lease_file}",
        ],
        text=True,
        capture_output=True,
        check=False,
    )

    if syntax.returncode != 0:
        print("PF02_DNSMASQ_CONFIG=FAIL")
        print(syntax.stderr, file=sys.stderr)
        return 1

    print("PF02_DNSMASQ_CONFIG=PASS")

    proc = subprocess.Popen(
        [
            "/usr/bin/dnsmasq",
            "--no-daemon",
            "--log-dhcp",
            f"--conf-file={config}",
            f"--dhcp-leasefile={lease_file}",
            "--pid-file=",
        ],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )

    try:
        if not wait_for_ap_dns():
            stdout, stderr = proc.communicate(timeout=1)
            print("PF02_DNS_AP=FAIL")
            print(stdout, file=sys.stderr)
            print(stderr, file=sys.stderr)
            return 1

        print("PF02_DNS_AP=PASS")

        if dns_answer_on(
            UPLINK_IFACE,
            UPLINK_ADDRESS,
            timeout=0.5,
        ):
            print("PF02_DNS_UPLINK=UNEXPECTED_REPLY")
            return 1

        print("PF02_DNS_UPLINK=NO_REPLY")

        ap_discover_seen, _ = probe_dhcp_path(
            AP_PEER,
            AP_IFACE,
        )

        uplink_discover_seen, uplink_reply_seen = probe_dhcp_path(
            UPLINK_PEER,
            UPLINK_IFACE,
        )

        proc.terminate()
        try:
            stdout, stderr = proc.communicate(timeout=2)
        except subprocess.TimeoutExpired:
            proc.kill()
            stdout, stderr = proc.communicate(timeout=2)

        ap_log_discover = f"DHCPDISCOVER({AP_IFACE})" in stderr
        ap_log_offer = f"DHCPOFFER({AP_IFACE})" in stderr
        uplink_log_offer = f"DHCPOFFER({UPLINK_IFACE})" in stderr

        if not (
            ap_discover_seen
            and ap_log_discover
            and ap_log_offer
        ):
            print("PF02_DHCP_AP=FAIL")

            print("PF02_DNSMASQ_STDOUT_BEGIN")
            print(stdout, end="")
            print("PF02_DNSMASQ_STDOUT_END")

            print("PF02_DNSMASQ_STDERR_BEGIN")
            print(stderr, end="")
            print("PF02_DNSMASQ_STDERR_END")

            return 1

        print("PF02_DHCP_AP=PASS")

        if (
            not uplink_discover_seen
            or uplink_reply_seen
            or uplink_log_offer
        ):
            print("PF02_DHCP_UPLINK=UNEXPECTED_REPLY")

            print("PF02_DNSMASQ_STDERR_BEGIN")
            print(stderr, end="")
            print("PF02_DNSMASQ_STDERR_END")

            return 1

        print("PF02_DHCP_UPLINK=NO_REPLY")
        return 0

    finally:
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=2)


def outer_main() -> int:
    required = (
        "/usr/bin/unshare",
        "/usr/bin/ip",
        "/usr/bin/dnsmasq",
        "/usr/bin/python3",
    )

    if any(not Path(tool).is_file() for tool in required):
        print("PF02_RESULT=ENVIRONMENT_UNAVAILABLE")
        return 3

    preflight = subprocess.run(
        [
            "/usr/bin/unshare",
            "--user",
            "--map-root-user",
            "--net",
            "/usr/bin/true",
        ],
        text=True,
        capture_output=True,
        check=False,
    )

    if preflight.returncode != 0:
        print("PF02_RESULT=ENVIRONMENT_UNAVAILABLE")
        print(preflight.stderr, file=sys.stderr)
        return 3

    with tempfile.TemporaryDirectory(
        prefix="aegis-pf02-"
    ) as tmp:
        root = Path(tmp)
        rendered = root / "rendered"

        renderer = subprocess.run(
            [
                "/usr/bin/python3",
                str(RENDERER),
                "render",
                "--interface", AP_IFACE,
                "--ssid-label", "AEGIS_PF02_TEST",
                "--channel", "1",
                "--country", "TH",
                "--ap-address", AP_ADDRESS,
                "--ap-subnet", AP_SUBNET,
                "--dhcp-start", DHCP_START,
                "--dhcp-end", DHCP_END,
                "--broker-hostname", BROKER_HOSTNAME,
                "--output-dir", str(rendered),
            ],
            cwd=LOCKDOWN,
            text=True,
            capture_output=True,
            check=False,
        )

        if renderer.returncode != 0:
            print("PF02_RESULT=FAIL")
            print(renderer.stderr, file=sys.stderr)
            return 1

        config = rendered / "aegis-idea3-dnsmasq.conf"
        lease_file = root / "dnsmasq.leases"

        result = subprocess.run(
            [
                "/usr/bin/unshare",
                "--user",
                "--map-root-user",
                "--net",
                "/usr/bin/python3",
                str(Path(__file__).resolve()),
                "--inner",
                str(config),
                str(lease_file),
            ],
            cwd=LOCKDOWN,
            text=True,
            capture_output=True,
            check=False,
            timeout=20,
        )

        sys.stdout.write(result.stdout)
        sys.stderr.write(result.stderr)

        if result.returncode != 0:
            print("PF02_RESULT=FAIL")
            return 1

    if root.exists():
        print("PF02_CLEANUP=FAIL")
        print("PF02_RESULT=FAIL")
        return 1

    print("PF02_CLEANUP=PASS")
    print("PF02_RESULT=PASS")
    return 0


def main() -> int:
    if len(sys.argv) == 4 and sys.argv[1] == "--inner":
        return namespace_main(
            Path(sys.argv[2]),
            Path(sys.argv[3]),
        )

    if len(sys.argv) != 1:
        print("usage: p4_pf02_dnsmasq_netns.py", file=sys.stderr)
        return 2

    return outer_main()


if __name__ == "__main__":
    raise SystemExit(main())
