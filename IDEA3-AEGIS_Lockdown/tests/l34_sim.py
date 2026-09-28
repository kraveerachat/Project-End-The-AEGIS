"""Deterministic host simulator for the L3/L4 reactivation tests.

Installs stub executables (rfkill, nmcli, iw, ip, nft, sysctl, systemctl, ss, dnsmasq) whose behaviour is a small state machine kept in
<sim>/state.json, and logs every invocation to <sim>/calls.log. No real host tool, radio, NetworkManager or service is ever touched.
Only the commands the reactivation handlers use are implemented; anything else exits 99 and is recorded, so an unexpected mutating command
fails the test loudly.
"""

from __future__ import annotations

import json
import os
import stat
import sys
from pathlib import Path

COMMANDS = ("rfkill", "nmcli", "iw", "ip", "nft", "sysctl", "systemctl", "ss", "dnsmasq")

NFT_GOOD = """table inet aegis_idea3 {
\tchain input {
\t\ttype filter hook input priority filter; policy accept;
\t\tiifname "wlp0s20f3" udp dport 67 accept
\t\tiifname "wlp0s20f3" udp dport 53 ip saddr 10.77.30.0/28 accept
\t\tiifname "wlp0s20f3" tcp dport 53 ip saddr 10.77.30.0/28 accept
\t\tiifname "wlp0s20f3" udp dport 123 ip saddr 10.77.30.0/28 accept
\t\tiifname "wlp0s20f3" tcp dport 8883 ip saddr 10.77.30.0/28 accept
\t\tiifname "wlp0s20f3" tcp dport 1883 drop
\t\tiifname "wlp0s20f3" drop
\t}
\tchain forward {
\t\ttype filter hook forward priority filter; policy accept;
\t\tiifname "wlp0s20f3" drop
\t}
}
"""

DEFAULT_STATE = {
    "rfkill_soft": 1,
    "rfkill_hard": 0,
    "ap_active": 0,
    "radio_flag_follows_rfkill": True,
    "nm_software_radio": True,          # NM software WirelessEnabled flag (persisted by NetworkManager); live post-reboot condition is False
    "dev_autoconnect": "yes",
    "autoconnect_profile_in_range": False,  # a known autoconnect Wi-Fi profile would grab the device as soon as it becomes available
    "other_wifi_active": False,             # a non-approved Wi-Fi connection is active on the target
    "extra_wifi_device": False,             # a second NetworkManager Wi-Fi device exists
    "extra_rfkill_wlan": False,             # a second wlan rfkill row exists
    "radio_on_works": True,
    "nm_init_side_effects": False,   # V3: NM Wi-Fi init creates the p2p pseudo-device, starts wpa_supplicant, and the phy goes 00 -> TH on AP up
    "p2p_present": False,
    "p2p_state_override": "",
    "extra_nm_device": False,
    "p2p_type_override": "",          # same-name pseudo-device reported with another type
    "p2p_name_override": "",          # differently named p2p device instead of p2p-dev-wlp0s20f3
    "extra_p2p_device": False,        # a second wifi-p2p device besides the correct one
    "wpa_state_override": "",         # failed | activating | deactivating | exited
    "wpa_pid_override": -1,           # >= 0 forces MainPID
    "wpa_active": False,
    "wpa_pid": 1545238,
    "wpa_unit_file_state": "disabled",
    "wpa_nrestarts": 0,
    "device_set_works": True,
    "dnsmasq": "failed",
    "dnsmasq_start_works": True,
    "nm_ready_after_unblock": True,
    "nm_activation_works": True,
    "phy_country": "00",
    "channel6_flags": "",
    "active_channel": 6,
    "active_ssid": "AEGIS-IDEA3",
    "ap_default_route": False,
    "extra_default_route": False,
    "alt_default": True,
    "nft": NFT_GOOD,
    "nft_tables": "table inet aegis_idea3\n",
    "nft_ruleset_extra": "",
    "sysctl_override": {},
    "effective": ["ap", "AEGIS-IDEA3", "bg", "6", "manual", "10.77.30.1/28", "yes"],
    "identities": {
        "mosquitto.service": [883, 0],
        "twingate.service": [1201, 2],
        "aegis-detection-engine.service": [900, 0],
        "aegis-detection-tunnel.service": [901, 2],
        "aegis-idea3-mosquitto.service": [0, 0],
    },
    "bt_rfkill_soft": 1,
    "bad_iface_in_ap_info": False,
    "ap_addr_override": "",
    "wired_ifname_state": "connected",
    "device_state_override": "",
    "ap_profile_autoconnect": "no",   # the persisted aegis-idea3-ap profile's own connection.autoconnect value; V4 never writes it
    "broker_mode": "identity",        # V4/V3 default: aegis-idea3-mosquitto.service driven by identities[] like any other static unit
    "broker_crashloop_recovers_after_ap": True,   # V5 only (broker_mode="crashloop_until_ap"): recovers once ap_active is true
    "broker_pid": 5100,
    "broker_nrestarts_pre": 182,      # V5 crashloop PRE: NRestarts already high (many auto-restart attempts since boot)
}

WRAPPER = "#!/usr/bin/env bash\nexec {python} {sim} {name} \"$@\"\n"


def install(stub_dir: Path, sim_dir: Path, **overrides) -> None:
    stub_dir.mkdir(parents=True, exist_ok=True)
    sim_dir.mkdir(parents=True, exist_ok=True)
    state = json.loads(json.dumps(DEFAULT_STATE))
    state.update(overrides)
    (sim_dir / "state.json").write_text(json.dumps(state))
    (sim_dir / "calls.log").write_text("")
    for name in COMMANDS:
        f = stub_dir / name
        f.write_text(WRAPPER.format(python=sys.executable, sim=str(Path(__file__).resolve()), name=name))
        f.chmod(f.stat().st_mode | stat.S_IXUSR)


def load(sim_dir: Path) -> dict:
    return json.loads((sim_dir / "state.json").read_text())


def save(sim_dir: Path, state: dict) -> None:
    """Atomic write: readers (other stubs running concurrently in a shell pipeline) always see a complete file."""
    tmp = sim_dir / f".state.{os.getpid()}.tmp"
    tmp.write_text(json.dumps(state))
    os.replace(tmp, sim_dir / "state.json")


def calls(sim_dir: Path) -> list[str]:
    return [l for l in (sim_dir / "calls.log").read_text().splitlines() if l]


# ── dispatcher ──────────────────────────────────────────────────────────────────────────────────────────────────────────


def _sim_dir() -> Path:
    return Path(os.environ["AEGIS_L34_SIM_DIR"])


def _wifi_radio(s: dict) -> str:
    # NetworkManager reports `enabled` only when the persisted software flag is on AND rfkill is not soft-blocking the radio
    return "enabled" if (s["nm_software_radio"] and not s["rfkill_soft"]) else "disabled"


def _device_state(s: dict) -> str:
    if s["device_state_override"]:
        return s["device_state_override"]
    if _wifi_radio(s) == "disabled":
        return "unavailable"
    if not s["nm_ready_after_unblock"]:
        return "unavailable"
    if s["ap_active"]:
        return "connected"
    if s["other_wifi_active"]:
        return "connected"
    return "disconnected"


def _p2p_rows(s: dict) -> list[tuple[str, str, str]]:
    """The complete p2p-related NetworkManager inventory: (name, type, state)."""
    rows: list[tuple[str, str, str]] = []
    if s["p2p_present"]:
        rows.append((s["p2p_name_override"] or "p2p-dev-wlp0s20f3", s["p2p_type_override"] or "wifi-p2p", _p2p_state(s)))
    if s["extra_p2p_device"]:
        rows.append(("p2p-dev-wlan1", "wifi-p2p", "unavailable"))
    return rows


def _p2p_state(s: dict) -> str:
    if s["p2p_state_override"]:
        return s["p2p_state_override"]
    return "unavailable" if _wifi_radio(s) == "disabled" else "disconnected"


def _wpa_props(s: dict) -> dict[str, str]:
    act = s["wpa_active"]
    props = {"LoadState": "loaded", "UnitFileState": s["wpa_unit_file_state"], "ActiveState": "active" if act else "inactive",
             "SubState": "running" if act else "dead", "Result": "success", "MainPID": str(s["wpa_pid"] if act else 0),
             "NRestarts": str(s["wpa_nrestarts"]), "ExecMainStartTimestamp": "Sun 2026-09-27 03:21:03 +07" if act else ""}
    forced = {"failed": ("failed", "failed"), "activating": ("activating", "start"), "deactivating": ("deactivating", "stop-sigterm"),
              "exited": ("active", "exited")}.get(s["wpa_state_override"])
    if forced:
        props["ActiveState"], props["SubState"] = forced
    if s["wpa_pid_override"] >= 0:
        props["MainPID"] = str(s["wpa_pid_override"])
    return props


def _dnsmasq_props(s: dict) -> dict[str, str]:
    st = s["dnsmasq"]
    base = {"LoadState": "loaded", "UnitFileState": "enabled"}
    if st == "failed":
        base.update(ActiveState="failed", SubState="failed", Result="start-limit-hit", MainPID="0", NRestarts="5",
                    ExecMainStartTimestamp="Sat 2026-09-26 23:46:54 +07")
    elif st == "active":
        base.update(ActiveState="active", SubState="running", Result="success", MainPID="4242", NRestarts="0",
                    ExecMainStartTimestamp="Sun 2026-09-27 01:10:00 +07")
    else:
        base.update(ActiveState="inactive", SubState="dead", Result="success", MainPID="0", NRestarts="0",
                    ExecMainStartTimestamp="Sun 2026-09-27 01:10:00 +07")
    return base


def _broker_crashloop_recovered(s: dict) -> bool:
    return bool(s["ap_active"]) and s["broker_crashloop_recovers_after_ap"]


def _broker_props(s: dict) -> dict[str, str]:
    """V5 only (broker_mode="crashloop_until_ap"): activating/auto-restart until ap_active, then active/running --
    never started/stopped/restarted by any stub command, purely a function of ap_active (systemd's own
    auto-restart, driven by the bind address becoming available)."""
    if _broker_crashloop_recovered(s):
        return {"LoadState": "loaded", "ActiveState": "active", "SubState": "running", "UnitFileState": "enabled",
                "Result": "success", "MainPID": str(s["broker_pid"]), "NRestarts": str(s["broker_nrestarts_pre"] + 1),
                "ExecMainStartTimestamp": "Sun 2026-09-28 17:24:40 +07"}
    return {"LoadState": "loaded", "ActiveState": "activating", "SubState": "auto-restart", "UnitFileState": "enabled",
            "Result": "exit-code", "MainPID": "0", "NRestarts": str(s["broker_nrestarts_pre"]), "ExecMainStartTimestamp": ""}


def _unit_props(s: dict, unit: str) -> dict[str, str]:
    if unit == "aegis-idea3-dnsmasq.service":
        return _dnsmasq_props(s)
    if unit == "wpa_supplicant.service":
        return _wpa_props(s)
    if unit == "aegis-idea3-mosquitto.service" and s["broker_mode"] == "crashloop_until_ap":
        return _broker_props(s)
    pid, nr = s["identities"].get(unit, [0, 0])
    active = "active" if pid else "inactive"
    return {"LoadState": "loaded" if pid else "not-found", "ActiveState": active, "SubState": "running" if pid else "dead",
            "UnitFileState": "enabled", "Result": "success", "MainPID": str(pid), "NRestarts": str(nr),
            "ExecMainStartTimestamp": "Sat 2026-09-26 23:46:50 +07"}


def main(argv: list[str]) -> int:
    name, args = argv[1], argv[2:]
    sim = _sim_dir()
    s = load(sim)
    original = json.dumps(s, sort_keys=True)
    with (sim / "calls.log").open("a") as fh:
        fh.write(name + " " + " ".join(args) + "\n")
    out: list[str] = []
    rc = 0

    if name == "rfkill":
        rows = {0: ("bluetooth", s["bt_rfkill_soft"], 0), 1: ("wlan", s["rfkill_soft"], s["rfkill_hard"])}
        if s["extra_rfkill_wlan"]:
            rows[2] = ("wlan", 1, 0)
        fmt = lambda i: f"{i} {rows[i][0]:<9} {'blocked' if rows[i][1] else 'unblocked'} {'blocked' if rows[i][2] else 'unblocked'}"
        if args[:3] == ["--noheadings", "--output", "ID,TYPE,SOFT,HARD"] and args[3:4] == ["list"]:
            ids = [int(args[4])] if len(args) > 4 else sorted(rows)
            out = [fmt(i) for i in ids if i in rows]
        elif args[:1] == ["unblock"]:
            if args[1] == "all":
                s["rfkill_soft"] = s["bt_rfkill_soft"] = 0
            elif args[1] == "1":
                s["rfkill_soft"] = 0
            else:
                rc = 1
        elif args[:1] == ["block"]:
            if args[1] == "1":
                s["rfkill_soft"] = 1
            else:
                rc = 1
        else:
            rc = 99
    elif name == "nmcli":
        if args[:5] == ["-t", "-f", "DEVICE,STATE", "device", "status"]:
            out = [f"wlp0s20f3:{_device_state(s)}", f"enp62s0:{s['wired_ifname_state']}", "lo:unmanaged"]
            out += [f"{n}:{st}" for n, _ty, st in _p2p_rows(s)]
            if s["extra_nm_device"]:
                out.append("br0:connected")
        elif args == ["-t", "-f", "DEVICE,TYPE,STATE", "device", "status"]:
            out = [f"wlp0s20f3:wifi:{_device_state(s)}", f"enp62s0:ethernet:{s['wired_ifname_state']}", "lo:loopback:unmanaged"]
            out += [f"{n}:{ty}:{st}" for n, ty, st in _p2p_rows(s)]
            if s["extra_wifi_device"]:
                out.append("wlan1:wifi:unavailable")
            if s["extra_nm_device"]:
                out.append("br0:bridge:connected")
        elif args == ["radio", "wifi"]:
            out = [_wifi_radio(s)]
        elif args == ["radio", "wifi", "on"]:
            if s["radio_on_works"]:
                s["nm_software_radio"] = True
                if s["nm_init_side_effects"]:
                    s["p2p_present"] = True
                    s["wpa_active"] = True
                # an autoconnect profile in range grabs the device unless device autoconnect is off
                if s["autoconnect_profile_in_range"] and s["dev_autoconnect"] == "yes" and not s["rfkill_soft"]:
                    s["other_wifi_active"] = True
            else:
                rc = 1
        elif args == ["radio", "wifi", "off"]:
            s["nm_software_radio"] = False
            s["other_wifi_active"] = False
        elif args[:3] == ["device", "set", "wlp0s20f3"] and len(args) == 5 and args[3] == "autoconnect" and args[4] in ("yes", "no"):
            if s["device_set_works"]:
                s["dev_autoconnect"] = args[4]
            else:
                rc = 1
        elif args == ["-g", "GENERAL.AUTOCONNECT", "device", "show", "wlp0s20f3"]:
            out = [s["dev_autoconnect"]]
        elif args == ["-t", "-f", "DEVICE,TYPE", "device", "status"]:
            out = ["wlp0s20f3:wifi", "enp62s0:ethernet", "lo:loopback"] + (["wlan1:wifi"] if s["extra_wifi_device"] else [])
            out += [f"{n}:{ty}" for n, ty, _st in _p2p_rows(s)]
        elif args == ["-t", "-f", "TYPE,DEVICE", "connection", "show", "--active"]:
            out = ["802-3-ethernet:enp62s0", "tun:sdwan0"]
            if s["ap_active"]:
                out.append("802-11-wireless:wlp0s20f3")
            if s["other_wifi_active"]:
                out.append("802-11-wireless:wlp0s20f3")
        elif args[:2] == ["connection", "up"]:
            conn = args[2] if len(args) > 2 else ""
            ok = (len(args) == 5 and args[3] == "ifname" and args[4] == "wlp0s20f3" and conn == "aegis-idea3-ap"
                  and _device_state(s) == "disconnected" and s["nm_activation_works"])
            if ok:
                if s["nm_init_side_effects"]:
                    s["phy_country"] = "TH"
                s["ap_active"] = 1
                s["other_wifi_active"] = False
            else:
                rc = 4
        elif args[:2] == ["connection", "down"]:
            if args[2:] == ["aegis-idea3-ap"]:
                s["ap_active"] = 0
            else:
                rc = 1
        elif args[:2] == ["-g", "GENERAL.CONNECTION"] and args[2:4] == ["device", "show"]:
            out = ["aegis-idea3-ap"] if (args[4] == "wlp0s20f3" and s["ap_active"]) else [""]
        elif args == ["-g", "connection.autoconnect", "connection", "show", "aegis-idea3-ap"]:
            out = [s["ap_profile_autoconnect"]]
        elif args and args[0] == "-g" and args[-3:] == ["connection", "show", "aegis-idea3-ap"]:
            out = list(s["effective"])
        else:
            rc = 99
    elif name == "iw":
        if args[:3] == ["dev", "wlp0s20f3", "info"]:
            out = ["Interface wlp0s20f3", "\tifindex 3", "\twdev 0x1", "\taddr b0:dc:ef:88:3b:64"]
            if s["ap_active"]:
                out += [f"\tssid {s['active_ssid']}", "\ttype AP", "\twiphy 0",
                        f"\tchannel {s['active_channel']} (2437 MHz), width: 20 MHz, center1: 2437 MHz"]
            else:
                out += ["\ttype managed", "\twiphy 0"]
        elif args[:2] == ["reg", "get"]:
            out = ["global", "country 00: DFS-UNSET", "\t(2402 - 2472 @ 40), (6, 20), (N/A)", "",
                   "phy#0 (self-managed)", f"country {s['phy_country']}: DFS-UNSET"]
        elif args[:3] == ["phy", "phy0", "channels"]:
            out = ["Band 1:", "\t* 2412 MHz [1]", "\t  Maximum TX power: 20.0 dBm", "\t* 2437 MHz [6]", "\t  Maximum TX power: 20.0 dBm"]
            if s["channel6_flags"]:
                out.append(f"\t  {s['channel6_flags']}")
            out += ["\t* 2462 MHz [11]", "\t  Maximum TX power: 20.0 dBm"]
        else:
            rc = 99
    elif name == "ip":
        if args == ["-o", "link", "show", "dev", "wlp0s20f3"]:
            out = ["3: wlp0s20f3: <BROADCAST,MULTICAST> mtu 1500 state DOWN"]
        elif args == ["-4", "-o", "addr", "show", "dev", "wlp0s20f3"]:
            if s["ap_active"]:
                addr = s["ap_addr_override"] or "10.77.30.1/28"
                out = [f"3: wlp0s20f3    inet {addr} brd 10.77.30.15 scope global wlp0s20f3"]
        elif args[:3] == ["-6", "-o", "addr"]:
            out = []
        elif args == ["route", "show", "default"]:
            out = ["default via 192.168.1.1 dev enp62s0 proto dhcp src 192.168.1.144 metric 100"] if s["alt_default"] else []
            if s["extra_default_route"]:
                out.append("default via 10.77.30.2 dev wlp0s20f3 metric 5")
        elif args == ["route", "show", "default", "dev", "wlp0s20f3"]:
            if s["ap_default_route"] or (s["extra_default_route"] and s["ap_active"]):
                out = ["default via 10.77.30.2 dev wlp0s20f3 metric 5"]
        else:
            rc = 99
    elif name == "nft":
        if args == ["list", "table", "inet", "aegis_idea3"]:
            if s["nft"]:
                out = s["nft"].rstrip("\n").split("\n")
            else:
                rc = 1
        elif args == ["list", "tables"]:
            out = s["nft_tables"].rstrip("\n").split("\n")
        elif args == ["list", "ruleset"]:
            out = (s["nft"] + s["nft_ruleset_extra"]).rstrip("\n").split("\n")
        else:
            rc = 99
    elif name == "sysctl":
        if args[0] == "-n":
            out = [str(s["sysctl_override"].get(args[1], 0))]
        else:
            rc = 99
    elif name == "dnsmasq":
        if args and args[0] == "--test":
            out = ["dnsmasq: syntax check OK."]
        else:
            rc = 99
    elif name == "systemctl":
        if args and args[0] == "show":
            props = [args[i + 1] for i, a in enumerate(args) if a == "-p"]
            unit = args[-1]
            data = _unit_props(s, unit)
            if "--value" in args:
                out = [data.get(props[0], "")]
            else:
                out = [f"{p}={data.get(p, '')}" for p in props]
        elif args[:1] == ["is-active"]:
            unit = args[-1]
            rc = 0 if _unit_props(s, unit)["ActiveState"] == "active" else 3
        elif args[:1] == ["is-enabled"]:
            rc = 0
        elif args[:2] == ["reset-failed", "aegis-idea3-dnsmasq.service"]:
            if s["dnsmasq"] == "failed":
                s["dnsmasq"] = "inactive"
        elif args[:2] == ["start", "aegis-idea3-dnsmasq.service"]:
            if s["dnsmasq"] == "failed":
                rc = 1  # start-limit-hit still in force
            elif s["ap_active"] and s["dnsmasq_start_works"]:
                s["dnsmasq"] = "active"
            else:
                s["dnsmasq"] = "failed"
        elif args[:2] == ["stop", "aegis-idea3-dnsmasq.service"]:
            s["dnsmasq"] = "inactive"
        else:
            rc = 99
    elif name == "ss":
        tcp = ["LISTEN 0 100 0.0.0.0:1883 0.0.0.0:*", "LISTEN 0 100 [::]:1883 [::]:*", "LISTEN 0 4096 127.0.0.53%lo:53 0.0.0.0:*"]
        udp = ["UNCONN 0 0 127.0.0.53%lo:53 0.0.0.0:*", "UNCONN 0 0 0.0.0.0%enp62s0:68 0.0.0.0:*"]
        if s["dnsmasq"] == "active":
            tcp.append("LISTEN 0 32 10.77.30.1:53 0.0.0.0:*")
            udp += ["UNCONN 0 0 10.77.30.1:53 0.0.0.0:*", "UNCONN 0 0 0.0.0.0%wlp0s20f3:67 0.0.0.0:*"]
        broker_up = _broker_crashloop_recovered(s) if s["broker_mode"] == "crashloop_until_ap" \
            else bool(s["identities"].get("aegis-idea3-mosquitto.service", [0, 0])[0])
        if broker_up:
            tcp += ["LISTEN 0 100 127.0.0.1:8883 0.0.0.0:*", "LISTEN 0 100 10.77.30.1:8883 0.0.0.0:*"]
        if args == ["-H", "-lnt"]:
            out = tcp
        elif args == ["-H", "-lnu"]:
            out = udp
        elif args == ["-H", "-ltn", "sport = :8883"]:
            out = [l for l in tcp if l.endswith(":8883 0.0.0.0:*")]
        else:
            rc = 99
    else:
        rc = 99

    if json.dumps(s, sort_keys=True) != original:  # read-only commands never rewrite the state (concurrent stubs in a pipeline stay race-free)
        save(sim, s)
    if out:
        print("\n".join(out))
    return rc


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
