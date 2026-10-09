"""dnsmasq boot-order repair: the real ExecStart must wait (bounded, fail-closed) for the exact approved AP state.

Observed after the 2026-10-02 22:01 operator reboot: ``aegis-idea3-ap`` autoconnected and ``wlp0s20f3`` reached AP mode with
10.77.30.1/28 about three seconds AFTER ``aegis-idea3-dnsmasq.service`` had already burned five starts in one second
(``unknown interface``) and hit ``start-limit-hit``. The unit was ordered only after ``NetworkManager.service``.

Repository-only: nothing here starts a service, touches a host interface or reads the live host. The readiness gate is the
unit's own first ``ExecStartPre``; the tests execute that exact command line against fake ``ip``/``iw`` shims.
"""

from __future__ import annotations

import shlex
import stat
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_pr11_phase4_ap_network as apnet  # noqa: E402
import test_pr11_phase4_l4_handler as l4  # noqa: E402

LOCKDOWN = Path(__file__).resolve().parents[1]
TEMPLATE = LOCKDOWN / "deploy" / "network" / "aegis-idea3-dnsmasq.service.example"

# The approved fixture values used by both the renderer tests and the L4 handler fixtures.
IFACE, ADDR, PREFIX, CHANNEL = "wlan-test0", "192.0.2.1", "28", "6"
LIVE_IFACE, LIVE_ADDR = "wlp0s20f3", "10.77.30.1"


def rendered_unit(tmp_path: Path, **overrides: str) -> str:
    result, out = apnet.render(tmp_path, interface=overrides.pop("interface", IFACE), **overrides)
    assert result.returncode == 0, result.stderr
    return (out / "aegis-idea3-dnsmasq.service").read_text(encoding="utf-8")


def unit_lines(text: str) -> list[str]:
    return [line for line in text.splitlines() if line and not line.startswith("#")]


def gate_line(text: str) -> str:
    gates = [line for line in unit_lines(text) if line.startswith("ExecStartPre=") and "/usr/bin/timeout" in line]
    assert len(gates) == 1, "the unit must carry exactly one bounded AP-readiness ExecStartPre"
    return gates[0]


def gate_argv(line: str) -> list[str]:
    return shlex.split(line.split("=", 1)[1])


def l4_installed_unit(tmp_path: Path) -> str:
    fs_root = tmp_path / "fs"
    work = tmp_path / "work"  # the handler requires a work dir that does not exist yet
    tmp_path.mkdir(parents=True, exist_ok=True)
    l4.setup_l3_fs(fs_root)
    result = l4.run_handler(l4.HANDLER / "apply.sh", fs_root=fs_root, work_dir=work)
    assert result.returncode == 0, result.stderr
    return (fs_root / "etc" / "systemd" / "system" / "aegis-idea3-dnsmasq.service").read_text(encoding="utf-8")


# ---------------------------------------------------------------- fake host for executing the gate

READY_IP = "3: {dev}    inet {addr}/{prefix} brd 192.0.2.15 scope global noprefixroute {dev}\\       valid_lft forever preferred_lft forever\n"
READY_IW = "Interface {dev}\n\tifindex 3\n\twdev 0x1\n\tssid AEGIS-IDEA3\n\ttype {mode}\n\tchannel {channel} (2437 MHz), width: 20 MHz, center1: 2437 MHz\n"


class FakeHost:
    """Shim directory standing in for /usr/bin; per-device state files drive the fake ip and iw."""

    def __init__(self, root: Path):
        self.dir = root / "shim"
        self.state = root / "state"
        self.dir.mkdir(parents=True)
        self.state.mkdir(parents=True)
        (self.dir / "grep").symlink_to("/usr/bin/grep")
        (self.dir / "sh").symlink_to("/usr/bin/sh")
        self._script("sleep", "exec /usr/bin/sleep 0.05\n")
        self._script(
            "ip",
            'dev=""; while [ $# -gt 0 ]; do [ "$1" = dev ] && dev="$2"; shift; done\n'
            f'[ -f "{self.state}/ip-$dev" ] || {{ echo "Device does not exist." >&2; exit 1; }}\n'
            f'/usr/bin/cat "{self.state}/ip-$dev"\n',
        )
        self._script(
            "iw",
            'dev="$2"\n'
            f'[ -f "{self.state}/iw-$dev" ] || {{ echo "command failed: No such device (-19)" >&2; exit 1; }}\n'
            f'/usr/bin/cat "{self.state}/iw-$dev"\n',
        )

    def _script(self, name: str, body: str) -> None:
        path = self.dir / name
        path.write_text("#!/bin/sh\n" + body, encoding="utf-8")
        path.chmod(path.stat().st_mode | stat.S_IXUSR)

    def set_ap(self, dev: str = IFACE, addr: str = ADDR, prefix: str = PREFIX, mode: str = "AP", channel: str = CHANNEL) -> None:
        (self.state / f"ip-{dev}").write_text(READY_IP.format(dev=dev, addr=addr, prefix=prefix), encoding="utf-8")
        (self.state / f"iw-{dev}").write_text(READY_IW.format(dev=dev, mode=mode, channel=channel), encoding="utf-8")

    def set_unaddressed(self, dev: str = IFACE) -> None:
        """The boot-race state: the interface exists (renamed) but has no IPv4 address and is not yet an AP."""
        (self.state / f"ip-{dev}").write_text("", encoding="utf-8")
        (self.state / f"iw-{dev}").write_text(f"Interface {dev}\n\tifindex 3\n\ttype managed\n", encoding="utf-8")

    def run_gate(self, gate: str, *, wait_seconds: int = 2) -> subprocess.CompletedProcess[str]:
        argv = gate_argv(gate)
        assert argv[:4] == ["/usr/bin/timeout", "30", "/usr/bin/sh", "-c"], argv[:4]
        script = argv[4].replace("/usr/bin/", f"{self.dir}/")
        return subprocess.run(
            ["/usr/bin/timeout", str(wait_seconds), f"{self.dir}/sh", "-c", script],
            env={"PATH": "/nonexistent"}, text=True, capture_output=True, check=False, timeout=20,
        )


@pytest.fixture()
def host(tmp_path: Path) -> FakeHost:
    return FakeHost(tmp_path)


@pytest.fixture()
def gate(tmp_path: Path) -> str:
    return gate_line(rendered_unit(tmp_path / "unit"))


# ---------------------------------------------------------------- structure

def test_unit_orders_a_bounded_ap_gate_before_the_real_dnsmasq(tmp_path: Path) -> None:
    lines = unit_lines(rendered_unit(tmp_path))
    pre = [i for i, line in enumerate(lines) if line.startswith("ExecStartPre=")]
    start = next(i for i, line in enumerate(lines) if line.startswith("ExecStart="))
    gate_index = next(i for i in pre if "/usr/bin/timeout" in lines[i])
    test_index = next(i for i in pre if "dnsmasq --test" in lines[i])
    assert gate_index < test_index < start, "the AP gate must run before the config test and the real ExecStart"
    assert lines[start] == "ExecStart=/usr/bin/dnsmasq --keep-in-foreground --conf-file=/etc/aegis-idea3/dnsmasq-ap.conf --pid-file="
    assert lines[test_index] == "ExecStartPre=/usr/bin/dnsmasq --test --conf-file=/etc/aegis-idea3/dnsmasq-ap.conf"


def test_gate_names_exactly_the_approved_interface_address_prefix_mode_and_channel(tmp_path: Path) -> None:
    line = gate_line(rendered_unit(tmp_path))
    script = gate_argv(line)[4]
    assert f"dev {IFACE}" in script
    assert f"inet {ADDR}/{PREFIX} " in script  # trailing space: 192.0.2.1/28 must not match 192.0.2.11/28 or /280
    assert "type AP" in script
    assert f"channel {CHANNEL} " in script
    assert "<AEGIS_" not in line, "no unresolved placeholder may survive rendering"
    assert "grep -Fq" in script, "patterns are fixed strings, not regexes"


def test_wait_is_bounded_and_the_start_limit_is_a_real_bound_not_disabled_or_raised(tmp_path: Path) -> None:
    text = rendered_unit(tmp_path)
    kv = dict(line.split("=", 1) for line in unit_lines(text) if "=" in line and not line.startswith("Exec"))
    wait = int(gate_argv(gate_line(text))[1])
    assert 1 <= wait <= 60
    assert int(kv["TimeoutStartSec"]) > wait, "the unit start timeout must outlive one bounded wait"
    burst, interval, restart = int(kv["StartLimitBurst"]), int(kv["StartLimitIntervalSec"]), int(kv["RestartSec"])
    assert burst == 5, "StartLimitBurst is not raised"
    assert interval > 0, "start limits are not disabled"
    assert burst * (wait + restart) < interval, "the limit must actually trip after the bounded attempts (no endless retry)"
    assert kv["Restart"] == "on-failure"


def test_unit_has_no_blind_retry_or_online_target_substitute(tmp_path: Path) -> None:
    text = rendered_unit(tmp_path)
    assert "network-online.target" not in text
    assert "StartLimitIntervalSec=0" not in text and "StartLimitBurst=0" not in text


def test_the_renderer_and_the_l4_handler_emit_the_identical_unit(tmp_path: Path) -> None:
    assert l4_installed_unit(tmp_path / "l4") == rendered_unit(tmp_path / "renderer")


def test_unit_example_is_a_template_with_unresolved_owner_values() -> None:
    text = TEMPLATE.read_text(encoding="utf-8")
    for token in ("<AEGIS_AP_INTERFACE>", "<AEGIS_AP_ADDRESS>", "<AEGIS_AP_PREFIXLEN>", "<AEGIS_AP_CHANNEL>"):
        assert token in text
    assert LIVE_IFACE not in text and LIVE_ADDR not in text


def test_live_owner_values_render_the_exact_boot_observed_state(tmp_path: Path) -> None:
    text = rendered_unit(
        tmp_path, interface=LIVE_IFACE, ap_address=LIVE_ADDR, ap_subnet="10.77.30.0/28",
        dhcp_start="10.77.30.2", dhcp_end="10.77.30.14", broker_hostname="mqtt.aegis.home.arpa",
    )
    script = gate_argv(gate_line(text))[4]
    assert f"dev {LIVE_IFACE}" in script and f"inet {LIVE_ADDR}/28 " in script


# ---------------------------------------------------------------- behaviour: A-D

def test_A_nm_running_but_ap_interface_not_ready_never_releases_dnsmasq(host: FakeHost, gate: str) -> None:
    host.set_unaddressed()
    assert host.run_gate(gate, wait_seconds=1).returncode != 0, "dnsmasq must not be released while the AP address is absent"


def test_A2_interface_absent_entirely_never_releases_dnsmasq(host: FakeHost, gate: str) -> None:
    assert host.run_gate(gate, wait_seconds=1).returncode != 0


def test_B_exact_ap_becoming_ready_inside_the_window_releases_dnsmasq(host: FakeHost, gate: str) -> None:
    host.set_unaddressed()
    threading.Timer(0.6, host.set_ap).start()
    started = time.monotonic()
    result = host.run_gate(gate, wait_seconds=8)
    assert result.returncode == 0, result.stderr
    assert 0.4 < time.monotonic() - started < 6, "released only after the AP became ready, well inside the bound"


def test_B2_already_ready_releases_immediately(host: FakeHost, gate: str) -> None:
    host.set_ap()
    started = time.monotonic()
    assert host.run_gate(gate).returncode == 0
    assert time.monotonic() - started < 2


def test_C_ap_never_ready_is_a_bounded_fail_closed_result(host: FakeHost, gate: str) -> None:
    host.set_unaddressed()
    started = time.monotonic()
    result = host.run_gate(gate, wait_seconds=1)
    assert result.returncode == 124, "the bounded wait must end by timeout (fail closed), not hang or pass"
    assert time.monotonic() - started < 5


@pytest.mark.parametrize(
    "case",
    [
        {"dev": "wlan-other"},  # right address on the wrong interface
        {"addr": "192.0.2.5"},  # wrong IPv4
        {"addr": "192.0.2.11"},  # address that merely starts with the approved one
        {"prefix": "24"},  # wrong prefix
        {"prefix": "280"},  # prefix that merely starts with the approved one
        {"mode": "managed"},  # addressed but not in AP mode
        {"channel": "11"},  # AP on a different channel
    ],
    ids=["wrong-interface", "wrong-ipv4", "ipv4-prefix-match", "wrong-prefix", "prefix-prefix-match", "not-ap", "wrong-channel"],
)
def test_D_wrong_state_is_refused(host: FakeHost, gate: str, case: dict[str, str]) -> None:
    host.set_ap(**case)
    result = host.run_gate(gate, wait_seconds=1)
    assert result.returncode == 124, f"{case} must be refused (timeout), got rc={result.returncode}"


# ---------------------------------------------------------------- E / F: nothing else changes

def test_E_dnsmasq_config_dhcp_dns_and_bind_policy_are_unchanged(tmp_path: Path) -> None:
    def effective(text: str) -> list[str]:
        return [line for line in text.splitlines() if line and not line.startswith("#")]

    # The config the L4 handler installs (what the live host runs): bind policy, DHCP pool and Core-local DNS are untouched.
    fs_root = tmp_path / "fs"
    l4.setup_l3_fs(fs_root)
    work = tmp_path / "work"
    result = l4.run_handler(l4.HANDLER / "apply.sh", fs_root=fs_root, work_dir=work)
    assert result.returncode == 0, result.stderr
    installed = (fs_root / "etc" / "aegis-idea3" / "dnsmasq-ap.conf").read_text(encoding="utf-8")
    assert effective(installed) == [
        f"interface={IFACE}",
        "bind-interfaces",
        "except-interface=lo",
        "dhcp-range=192.0.2.2,192.0.2.10,255.255.255.240",
        "dhcp-option=option:router",
        "dhcp-option=option:dns-server,192.0.2.1",
        "no-resolv",
        "no-hosts",
        "address=/mqtt.aegis.invalid/192.0.2.1",
    ]

    # The renderer's own config template is a separate pre-existing artifact and is not touched by this repair.
    result, out = apnet.render(tmp_path / "r")
    assert result.returncode == 0, result.stderr
    rendered = effective((out / "aegis-idea3-dnsmasq.conf").read_text(encoding="utf-8"))
    assert rendered[:2] == [f"interface={IFACE}", "bind-interfaces"]
    assert "dhcp-range=192.0.2.2,192.0.2.10,255.255.255.240" in rendered and "address=/mqtt.aegis.invalid/192.0.2.1" in rendered

    unit = rendered_unit(tmp_path / "u")
    assert "After=NetworkManager.service" in unit and "Requires=NetworkManager.service" in unit
    assert "WantedBy=multi-user.target" in unit and "Type=simple" in unit
    assert "User=" not in unit and "Group=" not in unit


@pytest.mark.parametrize(
    "forbidden",
    [
        "nmcli", "systemctl", "dispatcher", "ip link", "ip addr add", "ip addr del", "ip route", "rfkill", "sysctl",
        "forwarding", "nft", "mosquitto", "twingate", "aegis-idea3-core", "aegis-detection", "esp32", "recovery",
        "serial", "kill", "reset-failed",
    ],
)
def test_F_the_gate_is_read_only_and_controls_nothing_else(tmp_path: Path, forbidden: str) -> None:
    text = rendered_unit(tmp_path)
    assert forbidden not in gate_line(text)
    # The only unit text allowed to name a service is the existing NetworkManager ordering and the description.
    rest = "\n".join(line for line in unit_lines(text) if not line.startswith(("After=", "Requires=", "Description=")))
    assert forbidden not in rest


def test_the_gate_executes_only_read_only_binaries(tmp_path: Path) -> None:
    script = gate_argv(gate_line(rendered_unit(tmp_path)))[4]
    used = {token for token in shlex.split(script) if token.startswith("/usr/bin/")}
    assert used <= {"/usr/bin/ip", "/usr/bin/iw", "/usr/bin/grep", "/usr/bin/sleep"}
    assert "ip -4 -o addr show dev " in script and "iw dev " in script and " info" in script
