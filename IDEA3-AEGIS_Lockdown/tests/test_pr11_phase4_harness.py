"""PR11 Phase 4 T1 / G-15 — capture, compare, and stage-gate harness tests.

T1 is the repository framework for the Phase 4 per-stage preservation harness
(execution document §6 G-15, §9, §10, §11, §12):

- ``p4-l0-capture.sh``: a read-only L0 capture into normalized, checksummed
  records;
- ``p4-compare.sh``: a deterministic before/after preservation and drift
  comparison;
- ``p4-stage-gate.sh``: a fail-closed authorization and K3 record gate;
- ``p4-lib.sh``: shared helpers, the read-only command guard, and the rollback
  handler contract.

Everything here runs in a pytest temporary directory against fake host
commands on PATH and a fixture filesystem root. Nothing uses sudo, reads a
Production file, touches the host network or a host service, or constitutes
Phase 4 runtime evidence. Every address and name is a documentation/test value.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import os
import re
import secrets
import shutil
import subprocess
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest

LOCKDOWN = Path(__file__).resolve().parents[1]
DEPLOY = LOCKDOWN / "deploy" / "pr11-phase4"
LIB = DEPLOY / "p4-lib.sh"
CAPTURE = DEPLOY / "p4-l0-capture.sh"
COMPARE = DEPLOY / "p4-compare.sh"
GATE = DEPLOY / "p4-stage-gate.sh"
SCRIPTS = (LIB, CAPTURE, COMPARE, GATE)

# Real userland tools the scripts may use. Everything that reads host state is faked.
TOOLS = (
    "bash", "date", "grep", "head", "tail", "awk", "cut", "tr", "cat", "sed", "sort", "uniq",
    "sha256sum", "dirname", "find", "stat", "mkdir", "wc", "timeout", "id", "env",
)
FAKE_TOOLS = ("ip", "sysctl", "rfkill", "iw", "nmcli", "nft", "timedatectl", "ss", "df", "hostnamectl", "uname",
              "twingate")

JOURNAL_SINCE = "2026-09-17 00:00:00 UTC"
WINDOW_TZ = ZoneInfo("Asia/Bangkok")

pytestmark = pytest.mark.skipif(
    any(shutil.which(tool) is None for tool in TOOLS),
    reason="a POSIX userland with bash is required",
)

# ── fake command layer ───────────────────────────────────────────────────────

# Every fake logs its argv and whether it ran under the p4_ro read-only guard.
GENERIC_FAKE = r"""tool=${0##*/}
printf '%s guard=%s\n' "$tool $*" "${AEGIS_P4_RO:-0}" >> "$P4_CALL_LOG"
slug=$(printf '%s' "$*" | tr -c 'A-Za-z0-9.,=-' '_')
f="$P4_FIX/$tool/${slug:-_}"
if [ ! -f "$f" ]; then echo "fake $tool: no fixture" >&2; exit 1; fi
cat "$f"
if [ -f "$f.stderr" ]; then cat "$f.stderr" >&2; fi
if [ -f "$f.rc" ]; then exit "$(cat "$f.rc")"; fi
exit 0
"""

SYSTEMCTL_FAKE = r"""printf '%s guard=%s\n' "systemctl $*" "${AEGIS_P4_RO:-0}" >> "$P4_CALL_LOG"
[ "$1" = show ] || { echo "fake systemctl: unsupported" >&2; exit 1; }
unit="${*: -1}"
if [ -f "$P4_FIX/units/$unit" ]; then cat "$P4_FIX/units/$unit"; exit 0; fi
printf 'LoadState=not-found\nActiveState=inactive\nSubState=dead\nUnitFileState=\nMainPID=0\nNRestarts=0\nResult=success\nExecMainStartTimestamp=\n'
"""

JOURNALCTL_FAKE = r"""printf '%s guard=%s\n' "journalctl $*" "${AEGIS_P4_RO:-0}" >> "$P4_CALL_LOG"
unit=""
while [ $# -gt 0 ]; do [ "$1" = -u ] && unit=$2; shift; done
if [ -f "$P4_FIX/journal/$unit" ]; then cat "$P4_FIX/journal/$unit"; fi
exit 0
"""


def slug(*args: str) -> str:
    return re.sub(r"[^A-Za-z0-9.,=-]", "_", " ".join(args)) or "_"


def fx(tool: str, *args: str) -> str:
    return f"{tool}/{slug(*args)}"


def unit(active: str = "active", sub: str = "running", pid: int = 0, restarts: int = 0,
         started: str = "Thu 2026-09-17 01:00:00 +07") -> str:
    return (f"LoadState=loaded\nActiveState={active}\nSubState={sub}\nUnitFileState=enabled\n"
            f"MainPID={pid}\nNRestarts={restarts}\nResult=success\nExecMainStartTimestamp={started}\n")


ENGINE = "aegis-detection-engine.service"
TUNNEL = "aegis-detection-tunnel.service"

LISTENERS_HEALTHY = (
    "udp   UNCONN 0      0          127.0.0.54:53        0.0.0.0:*\n"
    "tcp   LISTEN 0      100           0.0.0.0:1883      0.0.0.0:*\n"
    "tcp   LISTEN 0      100              [::]:1883         [::]:*\n"
    "tcp   LISTEN 0      128         127.0.0.1:18002     0.0.0.0:*\n"
    "tcp   LISTEN 0      128           0.0.0.0:8077      0.0.0.0:*\n"
    "tcp   LISTEN 0      128           0.0.0.0:22        0.0.0.0:*\n"
)


def healthy_fixtures() -> dict[str, str]:
    return {
        fx("ip", "-br", "addr", "show"): (
            "lo               UNKNOWN        127.0.0.1/8 ::1/128\n"
            "eth-test0        UP             192.0.2.10/24\n"
            "wlan-test0       DOWN\n"
        ),
        fx("ip", "-br", "link", "show"): (
            "lo               UNKNOWN        00:00:00:00:00:00 <LOOPBACK,UP,LOWER_UP>\n"
            "eth-test0        UP             02:00:00:00:00:01 <BROADCAST,MULTICAST,UP,LOWER_UP>\n"
            "wlan-test0       DOWN           02:00:00:00:00:02 <BROADCAST,MULTICAST>\n"
        ),
        fx("ip", "-4", "route", "show"): (
            "default via 192.0.2.1 dev eth-test0 proto static metric 100\n"
            "192.0.2.0/24 dev eth-test0 proto kernel scope link src 192.0.2.10\n"
        ),
        fx("ip", "-6", "route", "show"): "::1 dev lo proto kernel metric 256 pref medium\n",
        fx("ip", "-4", "rule", "show"): "0:\tfrom all lookup local\n32766:\tfrom all lookup main\n",
        fx("ip", "-6", "rule", "show"): "0:\tfrom all lookup local\n32766:\tfrom all lookup main\n",
        fx("sysctl", "-n", "net.ipv4.ip_forward"): "0\n",
        fx("sysctl", "-n", "net.ipv4.conf.all.forwarding"): "0\n",
        fx("sysctl", "-n", "net.ipv6.conf.all.forwarding"): "0\n",
        fx("sysctl", "-n", "net.ipv6.conf.default.forwarding"): "0\n",
        fx("rfkill", "--noheadings", "--output", "ID,TYPE,SOFT,HARD"): " 1 wlan blocked unblocked\n",
        fx("iw", "reg", "get"): "global\ncountry 00: DFS-UNSET\n\nphy#0 (self-managed)\ncountry TH: DFS-FCC\n",
        fx("iw", "dev"): "phy#0\n\tInterface wlan-test0\n\t\tifindex 3\n\t\ttype managed\n",
        fx("iw", "phy"): "Wiphy phy0\n\tSupported interface modes:\n\t\t * managed\n\t\t * AP\n",
        fx("nmcli", "-t", "-f", "STATE,CONNECTIVITY,WIFI-HW,WIFI", "general", "status"):
            "connected:full:enabled:disabled\n",
        fx("nmcli", "-t", "-f", "NAME,TYPE,DEVICE", "connection", "show", "--active"):
            "wired-test:802-3-ethernet:eth-test0\n",
        fx("nmcli", "-t", "-f", "DEVICE,TYPE,STATE", "device", "status"):
            "eth-test0:ethernet:connected\nwlan-test0:wifi:unavailable\n",
        fx("nft", "list", "tables"): "table inet filter_test\n",
        fx("nft", "--stateless", "list", "ruleset"):
            "table inet filter_test {\n\tchain input {\n\t\ttype filter hook input priority filter; policy accept;\n\t}\n}\n",
        fx("nft", "--stateless", "list", "table", "inet", "filter_test"):
            "table inet filter_test {\n\tchain input {\n\t\ttype filter hook input priority filter; policy accept;\n\t}\n}\n",
        fx("timedatectl", "show", "-p", "NTP", "-p", "NTPSynchronized", "-p", "CanNTP", "-p", "Timezone"):
            "NTP=yes\nNTPSynchronized=yes\nCanNTP=yes\nTimezone=Asia/Bangkok\n",
        fx("timedatectl", "show-timesync", "-p", "ServerName", "-p", "SystemNTPServers"):
            "ServerName=time.example.invalid\nSystemNTPServers=\n",
        fx("ss", "-H", "-ltnu"): LISTENERS_HEALTHY,
        fx("ss", "-H", "-tn", "state", "established"): "0 0 127.0.0.1:1883 127.0.0.1:40000\n",
        fx("df", "-P", "-k", "/"): "Filesystem 1024-blocks Used Available Capacity Mounted on\n"
                                  "/dev/test0 61000000 30500000 30500000 50% /\n",
        fx("df", "-P", "-k", "/var"): "Filesystem 1024-blocks Used Available Capacity Mounted on\n"
                                     "/dev/test0 61000000 30500000 30500000 50% /\n",
        fx("df", "-P", "-k", "/opt"): "Filesystem 1024-blocks Used Available Capacity Mounted on\n"
                                     "/dev/test0 61000000 30500000 30500000 50% /\n",
        fx("hostnamectl", "--static"): "core-test\n",
        fx("uname", "-r"): "7.0.0-test\n",
        fx("twingate", "status"): "online\n",
        f"units/{ENGINE}": unit(pid=1111),
        f"units/{TUNNEL}": unit(pid=2222),
        "units/mosquitto.service": unit(pid=3333),
        "units/NetworkManager.service": unit(pid=4444),
        "units/systemd-timesyncd.service": unit(pid=5555),
        "units/twingate.service": unit(pid=6666),
        f"journal/{ENGINE}": "heartbeat sent ok\n",
    }


def live_like_unhealthy(fix: dict[str, str]) -> dict[str, str]:
    """The owner-run 2026-09-17 IDEA2 shape: tunnel flapping, :18002 absent, heartbeat refused."""
    fix[f"units/{TUNNEL}"] = unit(active="active", sub="running", pid=9001, restarts=1451)
    fix[fx("ss", "-H", "-ltnu")] = LISTENERS_HEALTHY.replace(
        "tcp   LISTEN 0      128         127.0.0.1:18002     0.0.0.0:*\n", "")
    fix[f"journal/{TUNNEL}"] = "ssh: connect to host 192.0.2.99 port 22: Connection timed out\n" * 3
    fix[f"journal/{ENGINE}"] = "heartbeat failed: Connection refused\n"
    return fix


def canary() -> str:
    return "P4CANARY" + secrets.token_hex(16)


def fs_fixture(secret: str) -> dict[str, str]:
    return {
        "etc/mosquitto/mosquitto.conf": (
            "per_listener_settings false\nallow_anonymous false\n"
            "password_file /etc/mosquitto/passwd\nlistener 1883\ninclude_dir /etc/mosquitto/conf.d\n"
        ),
        "etc/mosquitto/passwd": f"aegis:$7$101${secret}$abcdef\n{secret}-malformed-line-without-colon\n",
        "etc/mosquitto/conf.d/bridge.conf": f"# test bridge\nremote_password {secret}\n",
        "etc/mosquitto/certs/server.key": f"-----BEGIN PRIVATE KEY-----\n{secret}\n-----END PRIVATE KEY-----\n",
        "etc/aegis-idea3/core.env": f"AEGIS_MQTT_PASS={secret}\nAEGIS_ADMIN_PIN={secret}\n",
        "etc/aegis-idea3/protocol/k_c2d": f"{secret}\n",
        "etc/NetworkManager/system-connections/ap-test.nmconnection": f"[wifi-security]\npsk={secret}\n",
        "etc/nftables.conf": "table inet filter_test {}\n",
        "etc/systemd/timesyncd.conf": "[Time]\n",
        "proc/sys/kernel/random/boot_id": "00000000-0000-4000-8000-000000000001\n",
        "sys/class/net/wlan-test0/phy80211/rfkill1/index": "1\n",
        "sys/class/net/wlan-test0/phy80211/rfkill1/soft": "1\n",
        "sys/class/net/wlan-test0/phy80211/rfkill1/hard": "0\n",
        "sys/class/net/wlan-test0/phy80211/rfkill1/type": "wlan\n",
    }


SECRET_FILES = (
    "etc/mosquitto/certs/server.key",
    "etc/aegis-idea3/core.env",
    "etc/aegis-idea3/protocol/k_c2d",
    "etc/NetworkManager/system-connections/ap-test.nmconnection",
)


class Capture:
    def __init__(self, root: Path, result: subprocess.CompletedProcess, evid: Path, calls: Path, bindir: Path,
                 fsroot: Path) -> None:
        self.root, self.result, self.evid, self.calls, self.bindir, self.fsroot = (
            root, result, evid, calls, bindir, fsroot)

    def records(self) -> dict[str, str]:
        out: dict[str, str] = {}
        for tsv in sorted(self.evid.glob("*.tsv")):
            for line in tsv.read_text().splitlines():
                key, _, value = line.partition("\t")
                out[key] = value
        return out


def make_bin(root: Path, drop: tuple[str, ...] = ()) -> Path:
    bindir = root / "bin"
    bindir.mkdir(parents=True)
    bash = shutil.which("bash")
    for tool in TOOLS:
        (bindir / tool).symlink_to(shutil.which(tool))
    fakes = {tool: GENERIC_FAKE for tool in FAKE_TOOLS}
    fakes["systemctl"] = SYSTEMCTL_FAKE
    fakes["journalctl"] = JOURNALCTL_FAKE
    for name, body in fakes.items():
        if name in drop:
            continue
        stub = bindir / name
        stub.write_text(f"#!{bash}\n{body}")
        stub.chmod(0o755)
    return bindir


FIXED_MTIME = 1789430400  # file metadata is recorded, so fixture trees share one mtime


def write_tree(base: Path, files: dict[str, str]) -> None:
    for rel, content in files.items():
        path = base / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)
        os.utime(path, (FIXED_MTIME, FIXED_MTIME))


def capture(tmp_path: Path, name: str, fixtures: dict[str, str] | None = None, secret: str = "P4CANARYdefault",
            drop: tuple[str, ...] = (), fs: dict[str, str] | None = None, **env: str) -> Capture:
    root = tmp_path / name
    root.mkdir(parents=True)
    fix = root / "fix"
    write_tree(fix, healthy_fixtures() if fixtures is None else fixtures)
    fsroot = root / "fsroot"
    write_tree(fsroot, fs_fixture(secret) if fs is None else fs)
    bindir = make_bin(root, drop)
    calls = root / "calls.log"
    calls.touch()
    evid = root / "evidence"
    base = {
        "PATH": str(bindir), "HOME": str(root), "LC_ALL": "C", "P4_FIX": str(fix), "P4_CALL_LOG": str(calls),
        "EVID_DIR": str(evid), "CAPTURE_LABEL": name.replace("_", "-"), "JOURNAL_SINCE": JOURNAL_SINCE,
        "AEGIS_P4_FS_ROOT": str(fsroot), "AEGIS_MQTT_PASS": secret,
    }
    base.update(env)
    result = subprocess.run(["bash", str(CAPTURE)], capture_output=True, text=True, env=base,
                            stdin=subprocess.DEVNULL, timeout=120, check=False)
    return Capture(root, result, evid, calls, bindir, fsroot)


def compare(before: Capture, after: Capture, **env: str) -> subprocess.CompletedProcess:
    base = {"PATH": str(before.bindir), "HOME": str(before.root), "LC_ALL": "C", "DISK_THRESHOLD_PCT": "90"}
    base.update(env)
    return subprocess.run(["bash", str(COMPARE), str(before.evid), str(after.evid)], capture_output=True,
                          text=True, env=base, stdin=subprocess.DEVNULL, timeout=60, check=False)


def findings(result: subprocess.CompletedProcess) -> list[tuple[str, str, str]]:
    """(class, code, key) for every FINDING line."""
    rows = []
    for line in result.stdout.splitlines():
        if line.startswith("FINDING\t"):
            parts = line.split("\t")
            rows.append((parts[1], parts[2], parts[3]))
    return rows


def codes(result: subprocess.CompletedProcess, klass: str | None = None) -> set[str]:
    return {code for k, code, _ in findings(result) if klass is None or k == klass}


# ── A. capture happy path ────────────────────────────────────────────────────

def test_capture_happy_path_writes_normalized_checksummed_records(tmp_path: Path) -> None:
    cap = capture(tmp_path, "before")
    assert cap.result.returncode == 0, cap.result.stdout + cap.result.stderr
    assert "L0_CAPTURE=COMPLETE" in cap.result.stdout
    for name in ("meta", "capabilities", "network", "wifi", "firewall", "time", "mqtt", "idea2", "services",
                 "listeners", "host"):
        assert (cap.evid / f"{name}.tsv").is_file(), name
    assert (cap.evid / "SHA256SUMS").is_file()
    check = subprocess.run(["sha256sum", "-c", "--quiet", "SHA256SUMS"], cwd=cap.evid, capture_output=True, text=True,
                           check=False)
    assert check.returncode == 0, check.stdout + check.stderr

    rec = cap.records()
    assert rec["meta.schema"] == "1"
    assert rec["meta.evidence_class"] == "TEST_FIXTURE"
    assert rec["meta.journal_since"] == JOURNAL_SINCE
    assert rec["net.addr.eth-test0"] == "192.0.2.10/24"
    assert rec["net.link.eth-test0"] == "UP"
    assert rec["net.route4.default"] == "default via 192.0.2.1 dev eth-test0 proto static metric 100"
    assert rec["net.route6.default"] == "none"
    for key in ("sysctl.net.ipv4.ip_forward", "sysctl.net.ipv6.conf.all.forwarding",
                "sysctl.net.ipv6.conf.default.forwarding", "sysctl.net.ipv4.conf.all.forwarding"):
        assert rec[key] == "0", key
    assert rec["wifi.rfkill.iface.wlan-test0.soft"] == "blocked"
    assert rec["wifi.rfkill.iface.wlan-test0.hard"] == "unblocked"
    assert rec["wifi.rfkill.iface.wlan-test0.id"] == "1"
    assert rec["wifi.reg.global"] == "00"
    assert rec["wifi.iface.wlan-test0.type"] == "managed"
    assert rec["wifi.phy.ap_mode"] == "supported"
    assert rec["nm.general"] == "connected:full:enabled:disabled"
    assert rec["nm.active.device.eth-test0"] == "wired-test:802-3-ethernet"
    assert rec["nm.active.device.wlan-test0"] == "none"
    assert rec["nm.device.eth-test0.type"] == "ethernet"
    assert rec["nm.device.eth-test0.state"] == "connected"
    assert rec["nm.device.wlan-test0.type"] == "wifi"
    assert rec["nm.device.wlan-test0.state"] == "unavailable"
    assert rec["fw.nft.tables"] == "table inet filter_test"
    assert re.fullmatch(r"[0-9a-f]{64}", rec["fw.nft.table.inet.filter_test.sha256"])
    assert re.fullmatch(r"[0-9a-f]{64}", rec["fw.nft.ruleset.sha256"])
    assert re.fullmatch(r"[0-9a-f]{64}", rec["fw.nftables_conf./etc/nftables.conf.sha256"])
    assert rec["time.NTPSynchronized"] == "yes"
    assert rec["svc.systemd-timesyncd.service.ActiveState"] == "active"
    assert rec["svc.chronyd.service.LoadState"] == "not-found"
    assert rec["listen.tcp.0.0.0.0:1883"] == "present"
    assert rec["mqtt.established.1883.count"] == "1"
    assert rec["mqtt.established.8883.count"] == "0"
    assert rec["mqtt.passwd./etc/mosquitto/passwd.users"] == "aegis"
    assert re.fullmatch(r"[0-9a-f]{64}", rec["mqtt.file./etc/mosquitto/mosquitto.conf.sha256"])
    assert rec["mqtt.file./etc/mosquitto/certs/server.key.class"] == "secret-metadata-only"
    assert "listener 1883" in rec["mqtt.conf.directives"]
    # IDEA2 is recorded separately; never collapsed into one health boolean.
    assert rec["idea2.engine.MainPID"] == "1111"
    assert rec["idea2.tunnel.NRestarts"] == "0"
    assert rec["idea2.listen.8077"] == "present"
    assert rec["idea2.listen.18002"] == "present"
    assert rec["idea2.heartbeat.probe"] == "NOT_PROBED_READ_ONLY"
    assert rec["idea2.verdict.process_active"] == "YES"
    assert rec["idea2.verdict.tunnel_healthy"] == "NO_FAILURE_OBSERVED"
    assert rec["idea2.verdict.runtime_healthy"] == "NOT_PROVEN"
    assert "idea2.healthy" not in rec
    assert rec["disk.root.use_pct"] == "50"
    assert rec["host.identity"] == "core-test"
    assert rec["host.boot_id"] == "00000000-0000-4000-8000-000000000001"
    assert rec["host.twingate.status"] == "online"
    assert rec["host.path./etc/aegis-idea3"] == "present"
    assert rec["host.path./opt/aegis-idea3/current"] == "absent"
    assert rec["cap.chronyc"] == "missing"
    # Every record line is key<TAB>value with a unique, sorted key per file.
    for tsv in cap.evid.glob("*.tsv"):
        lines = tsv.read_text().splitlines()
        keys = [line.split("\t", 1)[0] for line in lines]
        assert all(line.count("\t") == 1 for line in lines), tsv
        assert keys == sorted(keys, key=lambda k: k.encode()) and len(keys) == len(set(keys)), tsv


def test_capture_live_like_idea2_is_never_reported_healthy(tmp_path: Path) -> None:
    cap = capture(tmp_path, "live", fixtures=live_like_unhealthy(healthy_fixtures()))
    assert cap.result.returncode == 0, cap.result.stdout + cap.result.stderr
    rec = cap.records()
    assert rec["idea2.verdict.process_active"] == "YES"
    assert rec["idea2.verdict.tunnel_healthy"] == "NO"
    assert rec["idea2.verdict.runtime_healthy"] == "NO"
    assert rec["idea2.listen.18002"] == "absent"
    assert rec["idea2.listen.8077"] == "present"
    assert rec["idea2.tunnel.NRestarts"] == "1451"
    assert rec["idea2.tunnel.journal.timeout"] == "3"
    assert rec["idea2.engine.journal.heartbeat_failed"] == "1"
    assert not any(v == "YES" for k, v in rec.items() if k.endswith("healthy"))


def test_capture_refuses_to_overwrite_existing_evidence(tmp_path: Path) -> None:
    (tmp_path / "again").mkdir()
    evid = tmp_path / "again" / "evidence"
    evid.mkdir()
    (evid / "keep.txt").write_text("previous evidence\n")
    root = tmp_path / "again"
    bindir = make_bin(root)
    result = subprocess.run(["bash", str(CAPTURE)], capture_output=True, text=True, env={
        "PATH": str(bindir), "HOME": str(root), "LC_ALL": "C", "EVID_DIR": str(evid), "CAPTURE_LABEL": "again",
        "JOURNAL_SINCE": JOURNAL_SINCE, "P4_CALL_LOG": str(root / "calls.log"), "P4_FIX": str(root)},
        stdin=subprocess.DEVNULL, timeout=60, check=False)
    assert result.returncode != 0
    assert "STOP" in result.stdout
    assert (evid / "keep.txt").read_text() == "previous evidence\n"


@pytest.mark.parametrize(("variable", "value"), [
    ("CAPTURE_LABEL", ""), ("CAPTURE_LABEL", "Bad Label"), ("JOURNAL_SINCE", ""),
    ("JOURNAL_SINCE", "yesterday"), ("EVID_DIR", ""),
])
def test_capture_requires_valid_inputs(tmp_path: Path, variable: str, value: str) -> None:
    cap = capture(tmp_path, "inputs", **{variable: value})
    assert cap.result.returncode != 0
    assert "STOP" in cap.result.stdout
    assert cap.calls.read_text() == ""


# ── B. missing command / partial capability ──────────────────────────────────

def test_capture_missing_command_is_partial_and_explicit(tmp_path: Path) -> None:
    cap = capture(tmp_path, "partial", drop=("nft", "twingate"))
    assert cap.result.returncode == 3, cap.result.stdout + cap.result.stderr
    assert "L0_CAPTURE=PARTIAL" in cap.result.stdout
    rec = cap.records()
    assert rec["cap.nft"] == "missing"
    assert rec["fw.nft.tables"] == "UNAVAILABLE"
    assert rec["fw.nft.ruleset.sha256"] == "UNAVAILABLE"
    assert rec["cap.twingate"] == "missing"
    assert rec["host.twingate.status"] == "UNAVAILABLE"
    assert rec["meta.capture_status"] == "PARTIAL"
    assert "net.addr.eth-test0" in rec  # other sections still captured


def test_capture_failed_read_is_unavailable_not_empty(tmp_path: Path) -> None:
    fix = healthy_fixtures()
    fix[fx("nft", "list", "tables") + ".rc"] = "1"
    fix[fx("nft", "list", "tables") + ".stderr"] = "Operation not permitted\n"
    cap = capture(tmp_path, "denied", fixtures=fix)
    assert cap.result.returncode == 3
    rec = cap.records()
    assert rec["cap.nft"] == "available"
    assert rec["fw.nft.tables"] == "UNAVAILABLE"


def test_compare_fails_closed_on_partial_evidence(tmp_path: Path) -> None:
    before = capture(tmp_path, "before")
    after = capture(tmp_path, "after", drop=("nft",))
    result = compare(before, after)
    assert result.returncode == 1
    assert "INCOMPARABLE" in {k for k, _, _ in findings(result)}
    assert "COMPARE_RESULT=FAIL" in result.stdout


# ── C. secret canaries ───────────────────────────────────────────────────────

def test_secret_canaries_never_reach_bundle_stdout_stderr_or_logs(tmp_path: Path) -> None:
    secret = canary()
    fix = live_like_unhealthy(healthy_fixtures())
    fix[f"journal/{TUNNEL}"] += f"debug token={secret}\n"
    fix[f"journal/{ENGINE}"] += f"AEGIS_HMAC_SECRET={secret}\n"
    before = capture(tmp_path, "before", fixtures=fix, secret=secret)
    after = capture(tmp_path, "after", fixtures=dict(fix), secret=secret)
    report = compare(before, after, REPORT_FILE=str(tmp_path / "report.txt"))

    streams = [before.result.stdout, before.result.stderr, after.result.stdout, after.result.stderr,
               report.stdout, report.stderr, (tmp_path / "report.txt").read_text()]
    for text in streams:
        assert secret not in text
    bundle_files = [p for c in (before, after) for p in c.evid.rglob("*") if p.is_file()]
    assert any(p.name == "capture.log" for p in bundle_files)
    secret_hashes = {hashlib.sha256((before.fsroot / rel).read_bytes()).hexdigest() for rel in SECRET_FILES}
    for path in bundle_files:
        data = path.read_text(errors="replace")
        assert secret not in data, path
        for digest in secret_hashes:
            assert digest not in data, f"secret file digest leaked into {path}"
    rec = before.records()
    assert rec["host.aegis_idea3.file./etc/aegis-idea3/core.env.class"] == "secret-metadata-only"
    assert "host.aegis_idea3.file./etc/aegis-idea3/core.env.sha256" not in rec
    assert rec["nm.profile./etc/NetworkManager/system-connections/ap-test.nmconnection.class"] == \
        "secret-metadata-only"
    # No fake command was asked to reveal secrets.
    for call in before.calls.read_text().splitlines():
        assert "--show-secrets" not in call and not re.search(r"\bnmcli\b.*\s-s(\s|$)", call), call


# ── D. mutation denylist (static negative controls) ──────────────────────────

MUTATION_PATTERNS: dict[str, str] = {
    "nft-mutation": r"\bnft\s+(-\S+\s+)*(add|delete|destroy|flush|insert|replace|create|reset|rename|-f|--file)\b",
    "flush-ruleset": r"flush\s+ruleset",
    "ip-mutation": r"\bip\s+(-\S+\s+)*(addr|address|a|route|r|link|l|rule|ru|neigh|n)\s+"
                   r"(add|del|delete|change|replace|flush|set|append|prepend)\b",
    "sysctl-write": r"\bsysctl\s+(\S+\s+)*(-w|--write|-p|--load|--system)\b",
    "rfkill-change": r"\brfkill\s+(block|unblock|toggle)\b",
    "iw-change": r"\biw\s+(\S+\s+)*(set|del|connect|disconnect|interface\s+add|ap\s+start|reg\s+set)\b",
    "nmcli-change": r"\bnmcli\b.*\b(up|down|modify|add|delete|reload|connect|disconnect|radio|clone|import|edit)\b",
    "nmcli-secrets": r"\bnmcli\b.*(--show-secrets|\s-s(\s|$))",
    "systemctl-change": r"\bsystemctl\s+(-\S+\s+)*(start|stop|restart|reload|enable|disable|mask|unmask|kill|"
                        r"isolate|daemon-reload|try-restart|reload-or-restart|edit|set-property|reboot|poweroff|"
                        r"halt|revert|preset|link)\b",
    "package-manager": r"\b(pacman|yay|paru|apt|apt-get|dnf|pip)\s",
    "mosquitto-write": r"\b(mosquitto_passwd|mosquitto_pub|mosquitto_sub)\b|\bmosquitto\s+-c\b",
    "key-generation": r"\b(openssl|ssh-keygen|certbot|certtool|step)\s",
    "firmware-flash": r"\b(esptool(\.py)?|pio|platformio|arduino-cli)\b",
    "power-state": r"(^|[;&|(]\s*|\s)(reboot|shutdown|poweroff|halt)(\s|;|$)",
    "cut-restore": r"\b(CUT_UPLINK|RESTORE_UPLINK|aegisctl)\b",
    "time-change": r"\b(timedatectl\s+set-\S+|chronyc\s+(makestep|settime|burst|online|offline|add|delete))\b",
    "hostname-change": r"\bhostnamectl\s+set-",
    "other-firewall": r"\b(iptables|ip6tables|ufw|firewall-cmd)\b",
    "network-daemons": r"\b(hostapd|dnsmasq|chronyd|wpa_cli)\s",
    "twingate-change": r"\btwingate\s+(start|stop|setup|config|auth|desktop-start|desktop-stop)\b",
    "file-mutation": r"(^|[;&|(]\s*|\s)(rm|mv|cp|ln|dd|truncate|chmod|chown|chattr|install|shred)\s",
    "in-place-edit": r"\bsed\s+(-\S+\s+)*-i",
    "find-mutation": r"\s-(delete|exec|execdir|ok|fprint)\b",
    "absolute-redirect": r">>?\s*/(?!dev/null)",
    "remote-or-privilege": r"\b(sudo|doas|ssh|scp|curl|wget|docker|kill|pkill|killall|modprobe|mount|umount)\s",
    "awk-shell-out": r"\bsystem\s*\(|\|\s*getline",
}

MUTATION_SAMPLES = {
    "nft-mutation": "nft add table inet aegis_idea3",
    "flush-ruleset": "nft flush ruleset",
    "ip-mutation": "ip addr add 192.0.2.5/24 dev wlan0",
    "sysctl-write": "sysctl -w net.ipv4.ip_forward=1",
    "rfkill-change": "rfkill unblock wifi",
    "iw-change": "iw dev wlan0 set type __ap",
    "nmcli-change": "nmcli connection up test-ap",
    "nmcli-secrets": "nmcli --show-secrets connection show test",
    "systemctl-change": "systemctl restart mosquitto.service",
    "package-manager": "pacman -S chrony",
    "mosquitto-write": "mosquitto_passwd -b /etc/mosquitto/passwd u p",
    "key-generation": "openssl genpkey -algorithm ed25519",
    "firmware-flash": "pio run -t upload",
    "power-state": "sleep 1; reboot",
    "cut-restore": "aegisctl restore",
    "time-change": "timedatectl set-ntp false",
    "hostname-change": "hostnamectl set-hostname x",
    "other-firewall": "iptables -F",
    "network-daemons": "dnsmasq --conf-file=x",
    "twingate-change": "twingate stop",
    "file-mutation": "rm -f /etc/nftables.conf",
    "in-place-edit": "sed -i s/a/b/ file",
    "find-mutation": "find /etc -name x -delete",
    "absolute-redirect": "echo x > /etc/sysctl.d/99.conf",
    "remote-or-privilege": "sudo nft list ruleset",
    "awk-shell-out": "awk '{ system(\"id\") }'",
}

READ_ONLY_SAMPLES = (
    "p4_ro nft --stateless list ruleset",
    "p4_ro nft list tables",
    "p4_ro ip -4 route show",
    "p4_ro systemctl show -p ActiveState -p MainPID mosquitto.service",
    "p4_ro sysctl -n net.ipv4.ip_forward",
    "p4_ro rfkill --noheadings --output ID,TYPE,SOFT,HARD",
    "p4_ro nmcli -t -f NAME,TYPE,DEVICE connection show --active",
    "p4_ro journalctl -u x.service --since \"$since\" --no-pager -o cat",
    "p4_ro timedatectl show -p NTP",
    'printf "%s\\n" "$x" > "$EVID_DIR/x.tsv"',
    "cmd 2>/dev/null",
)


def code_lines(path: Path) -> list[str]:
    lines = []
    for raw in path.read_text().splitlines():
        stripped = raw.strip()
        if not stripped or stripped.startswith("#"):
            continue
        lines.append(re.sub(r"\s#\s.*$", "", raw))
    return lines


def scan(text: str) -> list[str]:
    return [name for name, pattern in MUTATION_PATTERNS.items() if re.search(pattern, text)]


@pytest.mark.parametrize("name", sorted(MUTATION_PATTERNS))
def test_denylist_scanner_is_not_vacuous(name: str) -> None:
    assert name in scan(MUTATION_SAMPLES[name])


@pytest.mark.parametrize("sample", READ_ONLY_SAMPLES)
def test_denylist_allows_inspection_commands(sample: str) -> None:
    assert scan(sample) == []


@pytest.mark.parametrize("script", SCRIPTS, ids=lambda p: p.name)
def test_t1_scripts_contain_no_production_mutation(script: Path) -> None:
    hits = [(line, scan(line)) for line in code_lines(script) if scan(line)]
    assert hits == []


@pytest.mark.parametrize("path", (*SCRIPTS, DEPLOY / "README.md"), ids=lambda p: p.name)
def test_flush_ruleset_never_appears_in_t1(path: Path) -> None:
    assert not re.search(r"flush\s+ruleset", path.read_text(), re.IGNORECASE)


def test_only_reviewed_stage_handlers_are_registered() -> None:
    stages = DEPLOY / "stages"
    assert stages.is_dir()
    assert {p.name for p in stages.iterdir() if p.is_dir()} == {"L1", "L2", "L3", "L4", "L5", "L6a", "L6b", "L7", "L8", "L9"}
    core_handler_files = {
        "apply.sh",
        "verify.sh",
        "rollback.sh",
        "allow-keys.txt",
        "allow-listeners.txt",
    }
    # L2 additionally owns a repository-side functional verifier for the
    # dynamic IPv4 containment behavioral contract. It is additive to, not
    # part of, the apply/verify/rollback/allow-* stage-gate contract that
    # p4-lib.sh's P4_HANDLER_FILES checks by exact name.
    expected_by_stage = {
        "L2": core_handler_files | {"verify-containment-functional.sh"},
    }
    for name in ("L1", "L2", "L3", "L4", "L5", "L6a", "L6b", "L7", "L8", "L9"):
        expected = expected_by_stage.get(name, core_handler_files)
        assert {p.name for p in (stages / name).iterdir() if p.is_file()} == expected


def ro(snippet: str, bindir: Path, calls: Path) -> subprocess.CompletedProcess:
    return subprocess.run(["bash", "-c", f'set -uo pipefail; . "{LIB}"; {snippet}'], capture_output=True,
                          text=True, env={"PATH": str(bindir), "LC_ALL": "C", "P4_CALL_LOG": str(calls),
                                          "P4_FIX": str(calls.parent)}, timeout=30, check=False)


@pytest.mark.parametrize("argv", [
    "nft add table inet aegis_idea3",
    "nft -f /tmp/x.nft",
    "ip addr add 192.0.2.5/24 dev wlan-test0",
    "ip route del default",
    "sysctl -w net.ipv4.ip_forward=1",
    "rfkill unblock wifi",
    "nmcli connection up test-ap",
    "nmcli --show-secrets connection show test",
    "systemctl restart mosquitto.service",
    "systemctl show -p ActiveState mosquitto.service --now",
    "journalctl --rotate",
    "timedatectl set-ntp false",
    "iw reg set TH",
    "twingate stop",
    "find /etc -delete",
    "uname -a; id",
])
def test_read_only_guard_refuses_mutation_without_invoking_the_command(tmp_path: Path, argv: str) -> None:
    bindir = make_bin(tmp_path)
    calls = tmp_path / "calls.log"
    calls.touch()
    words = " ".join(f"'{w}'" for w in argv.split(" "))
    result = ro(f"p4_ro {words}", bindir, calls)
    assert result.returncode == 126, result.stdout + result.stderr
    assert "REFUSED" in result.stdout + result.stderr
    assert calls.read_text() == ""


# ── E. determinism ───────────────────────────────────────────────────────────

def test_capture_and_compare_are_deterministic(tmp_path: Path) -> None:
    one = capture(tmp_path, "one")
    two = capture(tmp_path, "two", CAPTURE_LABEL="one")
    for tsv in sorted(one.evid.glob("*.tsv")):
        if tsv.name == "meta.tsv":
            continue
        assert tsv.read_text().replace(str(one.fsroot), "") == \
            (two.evid / tsv.name).read_text().replace(str(two.fsroot), ""), tsv.name
    meta_one = {k: v for k, v in one.records().items() if k.startswith("meta.")}
    meta_two = {k: v for k, v in two.records().items() if k.startswith("meta.")}
    varying = {"meta.captured_at", "meta.fs_root"}
    assert {k: v for k, v in meta_one.items() if k not in varying} == \
        {k: v for k, v in meta_two.items() if k not in varying}
    first, second = compare(one, two), compare(one, two)
    assert first.stdout == second.stdout
    assert first.returncode == 0, first.stdout + first.stderr
    assert "COMPARE_RESULT=PASS" in first.stdout
    assert "PRESERVATION_S10=PASS" in first.stdout


def test_compare_refuses_tampered_evidence(tmp_path: Path) -> None:
    before, after = capture(tmp_path, "before"), capture(tmp_path, "after")
    tsv = after.evid / "firewall.tsv"
    tsv.write_text(tsv.read_text().replace("table inet filter_test", "table inet other"))
    result = compare(before, after)
    assert result.returncode == 2
    assert "STOP" in result.stdout
    assert "COMPARE_RESULT=PASS" not in result.stdout


@pytest.mark.parametrize("threshold", ["", "0", "100", "abc"])
def test_compare_requires_an_explicit_disk_threshold(tmp_path: Path, threshold: str) -> None:
    before, after = capture(tmp_path, "before"), capture(tmp_path, "after")
    result = compare(before, after, DISK_THRESHOLD_PCT=threshold)
    assert result.returncode == 2
    assert "STOP" in result.stdout


# ── F–K. drift detection ─────────────────────────────────────────────────────

def drift(tmp_path: Path, mutate, base=healthy_fixtures, **env: str) -> subprocess.CompletedProcess:
    before = capture(tmp_path, "before", fixtures=base())
    changed = base()
    mutate(changed)
    after = capture(tmp_path, "after", fixtures=changed)
    assert before.result.returncode == 0 and after.result.returncode == 0, after.result.stdout
    return compare(before, after, **env)


def assert_fail(result: subprocess.CompletedProcess, code: str, klass: str = "NEW_OR_WORSENED_DRIFT") -> None:
    assert result.returncode == 1, result.stdout + result.stderr
    assert code in codes(result, klass), result.stdout
    assert "COMPARE_RESULT=FAIL" in result.stdout


def test_nftables_new_table_fails(tmp_path: Path) -> None:
    def mutate(f):
        f[fx("nft", "list", "tables")] = "table inet filter_test\ntable inet aegis_idea3\n"
        f[fx("nft", "--stateless", "list", "table", "inet", "aegis_idea3")] = "table inet aegis_idea3 {\n}\n"
        f[fx("nft", "--stateless", "list", "ruleset")] += "table inet aegis_idea3 {\n}\n"
    result = drift(tmp_path, mutate)
    assert_fail(result, "NFT_TABLE_SET_DRIFT")
    assert "NFT_RULESET_DRIFT" in codes(result)


def test_nftables_rule_change_inside_existing_table_fails(tmp_path: Path) -> None:
    def mutate(f):
        body = "table inet filter_test {\n\tchain input {\n\t\ttype filter hook input priority filter; policy drop;\n\t}\n}\n"
        f[fx("nft", "--stateless", "list", "table", "inet", "filter_test")] = body
        f[fx("nft", "--stateless", "list", "ruleset")] = body
    result = drift(tmp_path, mutate)
    assert_fail(result, "NFT_TABLE_DRIFT")


@pytest.mark.parametrize("key", ["net.ipv4.ip_forward", "net.ipv6.conf.all.forwarding"])
def test_forwarding_enabled_fails(tmp_path: Path, key: str) -> None:
    result = drift(tmp_path, lambda f: f.__setitem__(fx("sysctl", "-n", key), "1\n"))
    assert_fail(result, "FORWARDING_ENABLED")


def test_default_route_drift_fails(tmp_path: Path) -> None:
    def mutate(f):
        f[fx("ip", "-4", "route", "show")] = (
            "default via 198.51.100.1 dev wlan-test0 proto dhcp metric 600\n"
            "192.0.2.0/24 dev eth-test0 proto kernel scope link src 192.0.2.10\n")
    assert_fail(drift(tmp_path, mutate), "DEFAULT_ROUTE_DRIFT")


def test_interface_address_drift_fails(tmp_path: Path) -> None:
    def mutate(f):
        f[fx("ip", "-br", "addr", "show")] = f[fx("ip", "-br", "addr", "show")].replace(
            "wlan-test0       DOWN\n", "wlan-test0       UP             198.51.100.10/24\n")
    assert_fail(drift(tmp_path, mutate), "INTERFACE_ADDRESS_DRIFT")


def test_mqtt_1883_listener_removal_fails(tmp_path: Path) -> None:
    def mutate(f):
        f[fx("ss", "-H", "-ltnu")] = "".join(
            line + "\n" for line in LISTENERS_HEALTHY.splitlines() if ":1883 " not in line)
    assert_fail(drift(tmp_path, mutate), "MQTT_1883_LISTENER_REMOVED")


def test_unexpected_idea3_listener_fails_and_allowlist_cannot_be_wildcard(tmp_path: Path) -> None:
    def mutate(f):
        f[fx("ss", "-H", "-ltnu")] += "tcp   LISTEN 0      100           0.0.0.0:8883      0.0.0.0:*\n"
    assert_fail(drift(tmp_path / "unlisted", mutate), "IDEA3_LISTENER_OUT_OF_SCOPE")
    allow = tmp_path / "allow-listeners.txt"
    allow.write_text("listen.tcp.0.0.0.0:8883\n")
    result = drift(tmp_path / "wildcard", mutate, ALLOW_LISTENERS_FILE=str(allow))
    assert result.returncode == 2, result.stdout
    assert "STOP" in result.stdout


def test_approved_scoped_listener_is_not_drift(tmp_path: Path) -> None:
    def mutate(f):
        f[fx("ss", "-H", "-ltnu")] += "tcp   LISTEN 0      100          127.0.0.1:8883      0.0.0.0:*\n"
    allow = tmp_path / "allow-listeners.txt"
    allow.write_text("listen.tcp.127.0.0.1:8883\n")
    result = drift(tmp_path, mutate, ALLOW_LISTENERS_FILE=str(allow))
    assert result.returncode == 0, result.stdout
    assert "IDEA3_LISTENER_APPROVED" in codes(result, "APPROVED_CHANGE")


def test_protected_keys_cannot_be_approved(tmp_path: Path) -> None:
    before, after = capture(tmp_path, "before"), capture(tmp_path, "after")
    allow = tmp_path / "allow-keys.txt"
    for key in ("sysctl.net.ipv4.ip_forward", "idea2.tunnel.NRestarts", "net.route4.default", "host.boot_id",
                "net.dns./etc/resolv.conf.sha256", "net.dns.nameservers", "nm.general",
                "wifi.reg.global", "wifi.rfkill.iface.wlp0s20f3.hard", "wifi.rfkill.iface.wlp0s20f3.id"):
        allow.write_text(key + "\n")
        result = compare(before, after, ALLOW_KEYS_FILE=str(allow))
        assert result.returncode == 2, key
        assert "STOP" in result.stdout


def test_idea2_engine_restart_fails(tmp_path: Path) -> None:
    result = drift(tmp_path, lambda f: f.__setitem__(f"units/{ENGINE}", unit(pid=7777, restarts=1)))
    assert_fail(result, "IDEA2_ENGINE_DRIFT")
    keys = {key for _, code, key in findings(result) if code == "IDEA2_ENGINE_DRIFT"}
    assert {"idea2.engine.MainPID", "idea2.engine.NRestarts"} <= keys


def test_idea2_tunnel_restart_on_healthy_baseline_is_new_drift(tmp_path: Path) -> None:
    result = drift(tmp_path, lambda f: f.__setitem__(f"units/{TUNNEL}", unit(pid=2223, restarts=1)))
    assert_fail(result, "IDEA2_TUNNEL_RESTART_DRIFT")


def historical_restarts(f: dict[str, str], pid: int = 123, restarts: int = 15) -> dict[str, str]:
    f[f"units/{TUNNEL}"] = unit(pid=pid, restarts=restarts)
    return f


def test_s10_case_a_historical_restart_count_healthy_baseline_passes(tmp_path: Path) -> None:
    before = capture(tmp_path, "before", fixtures=historical_restarts(healthy_fixtures()))
    after = capture(tmp_path, "after", fixtures=historical_restarts(healthy_fixtures()))
    assert before.records()["idea2.tunnel.NRestarts"] == "15"  # history stays visible, never normalized to 0
    assert before.records()["idea2.verdict.tunnel_healthy"] == "NO_FAILURE_OBSERVED"
    result = compare(before, after)
    assert result.returncode == 0, result.stdout
    assert "PRESERVATION_S10=PASS" in result.stdout
    assert codes(result, "BASELINE_UNHEALTHY_BUT_UNCHANGED") == set()
    assert after.records()["idea2.tunnel.NRestarts"] == "15"
    assert "IDEA2_NARROWED_CRITERION=WINDOW_DELTA_CANDIDATE_PENDING_OWNER_ACCEPTANCE" in result.stdout


def test_s10_case_b_restart_during_window_fails(tmp_path: Path) -> None:
    result = drift(tmp_path, lambda f: historical_restarts(f, pid=123, restarts=16),
                   base=lambda: historical_restarts(healthy_fixtures()))
    assert_fail(result, "IDEA2_TUNNEL_RESTART_DRIFT")


def test_s10_case_c_mainpid_change_same_counter_fails(tmp_path: Path) -> None:
    result = drift(tmp_path, lambda f: historical_restarts(f, pid=124, restarts=15),
                   base=lambda: historical_restarts(healthy_fixtures()))
    assert_fail(result, "IDEA2_TUNNEL_RESTART_DRIFT")


def test_s10_case_d_18002_disappears_with_historical_restarts_fails(tmp_path: Path) -> None:
    without = "".join(line + "\n" for line in LISTENERS_HEALTHY.splitlines() if ":18002 " not in line)
    result = drift(tmp_path, lambda f: historical_restarts(f).__setitem__(fx("ss", "-H", "-ltnu"), without),
                   base=lambda: historical_restarts(healthy_fixtures()))
    assert_fail(result, "IDEA2_18002_STATE_CHANGED")


def test_s10_case_e_new_tunnel_failure_class_with_historical_restarts_fails(tmp_path: Path) -> None:
    def mutate(f):
        historical_restarts(f)
        f[f"journal/{TUNNEL}"] = "Host key verification failed.\n"
    result = drift(tmp_path, mutate, base=lambda: historical_restarts(healthy_fixtures()))
    assert_fail(result, "IDEA2_TUNNEL_NEW_FAILURE_CLASS")


@pytest.mark.parametrize("shape", ["18002_absent", "tunnel_inactive"])
def test_s10_case_f_currently_unhealthy_baseline_fails(tmp_path: Path, shape: str) -> None:
    def base():
        f = historical_restarts(healthy_fixtures())
        if shape == "18002_absent":
            f[fx("ss", "-H", "-ltnu")] = "".join(
                line + "\n" for line in LISTENERS_HEALTHY.splitlines() if ":18002 " not in line)
        else:
            f[f"units/{TUNNEL}"] = unit(active="inactive", sub="dead", pid=0, restarts=15)
        return f
    before = capture(tmp_path, "before", fixtures=base())
    after = capture(tmp_path, "after", fixtures=base())
    assert before.records()["idea2.verdict.tunnel_healthy"] == "NO"
    result = compare(before, after)
    assert result.returncode == 1
    assert "IDEA2_TUNNEL_BASELINE_UNHEALTHY" in codes(result, "BASELINE_UNHEALTHY_BUT_UNCHANGED")
    assert "PRESERVATION_S10=FAIL" in result.stdout


def test_unhealthy_baseline_unchanged_is_distinguished_but_still_blocks_s10(tmp_path: Path) -> None:
    def base():
        return live_like_unhealthy(healthy_fixtures())

    def mutate(f):  # the tunnel keeps flapping in the same failure class
        f[f"units/{TUNNEL}"] = unit(pid=9050, restarts=1460)
        f[f"journal/{TUNNEL}"] = "ssh: connect to host 192.0.2.99 port 22: Connection timed out\n" * 9
    result = drift(tmp_path, mutate, base=base)
    assert result.returncode == 1
    unchanged = codes(result, "BASELINE_UNHEALTHY_BUT_UNCHANGED")
    assert {"IDEA2_TUNNEL_BASELINE_UNHEALTHY", "IDEA2_TUNNEL_RESTART_DRIFT", "IDEA2_TUNNEL_FAILURE_COUNT"} <= unchanged
    assert not any(code.startswith("IDEA2_TUNNEL") for code in codes(result, "NEW_OR_WORSENED_DRIFT"))
    assert "PRESERVATION_S10=FAIL" in result.stdout
    assert "IDEA2_NARROWED_CRITERION=WINDOW_DELTA_CANDIDATE_PENDING_OWNER_ACCEPTANCE" in result.stdout
    assert "COMPARE_RESULT=FAIL" in result.stdout


def test_unhealthy_baseline_identical_capture_still_fails_s10(tmp_path: Path) -> None:
    before = capture(tmp_path, "before", fixtures=live_like_unhealthy(healthy_fixtures()))
    after = capture(tmp_path, "after", fixtures=live_like_unhealthy(healthy_fixtures()))
    result = compare(before, after)
    assert result.returncode == 1
    assert codes(result, "NEW_OR_WORSENED_DRIFT") == set()
    assert "IDEA2_TUNNEL_BASELINE_UNHEALTHY" in codes(result, "BASELINE_UNHEALTHY_BUT_UNCHANGED")
    assert "PRESERVATION_S10=FAIL" in result.stdout


def test_idea2_tunnel_new_failure_class_is_worsened(tmp_path: Path) -> None:
    def base():
        return live_like_unhealthy(healthy_fixtures())

    def mutate(f):
        f[f"journal/{TUNNEL}"] += "Host key verification failed.\n"
    assert_fail(drift(tmp_path, mutate, base=base), "IDEA2_TUNNEL_NEW_FAILURE_CLASS")


def test_idea2_8077_disappearance_fails(tmp_path: Path) -> None:
    def mutate(f):
        f[fx("ss", "-H", "-ltnu")] = "".join(
            line + "\n" for line in LISTENERS_HEALTHY.splitlines() if ":8077 " not in line)
    assert_fail(drift(tmp_path, mutate), "IDEA2_8077_LISTENER_REMOVED")


@pytest.mark.parametrize("direction", ["removed", "appeared"])
def test_idea2_18002_state_change_fails(tmp_path: Path, direction: str) -> None:
    without = "".join(line + "\n" for line in LISTENERS_HEALTHY.splitlines() if ":18002 " not in line)
    if direction == "removed":
        result = drift(tmp_path, lambda f: f.__setitem__(fx("ss", "-H", "-ltnu"), without))
        assert_fail(result, "IDEA2_18002_STATE_CHANGED")
    else:
        def base():
            f = healthy_fixtures()
            f[fx("ss", "-H", "-ltnu")] = without
            return f
        result = drift(tmp_path, lambda f: f.__setitem__(fx("ss", "-H", "-ltnu"), LISTENERS_HEALTHY), base=base)
        assert result.returncode == 1
        assert "IDEA2_18002_STATE_CHANGED" in codes(result)


def test_service_state_change_fails(tmp_path: Path) -> None:
    result = drift(tmp_path, lambda f: f.__setitem__("units/mosquitto.service", unit(active="failed", sub="failed",
                                                                                         pid=0)))
    assert_fail(result, "SERVICE_STATE_DRIFT")


def test_time_sync_loss_fails(tmp_path: Path) -> None:
    def mutate(f):
        key = fx("timedatectl", "show", "-p", "NTP", "-p", "NTPSynchronized", "-p", "CanNTP", "-p", "Timezone")
        f[key] = f[key].replace("NTPSynchronized=yes", "NTPSynchronized=no")
    assert_fail(drift(tmp_path, mutate), "TIME_SYNC_LOST")


def test_disk_threshold_state_worsening_fails(tmp_path: Path) -> None:
    def mutate(f):
        f[fx("df", "-P", "-k", "/")] = ("Filesystem 1024-blocks Used Available Capacity Mounted on\n"
                                         "/dev/test0 61000000 57950000 3050000 95% /\n")
    assert_fail(drift(tmp_path, mutate), "DISK_THRESHOLD_WORSENED")


def test_host_reboot_or_identity_change_fails(tmp_path: Path) -> None:
    before = capture(tmp_path, "before")
    fs = fs_fixture("P4CANARYdefault")
    fs["proc/sys/kernel/random/boot_id"] = "00000000-0000-4000-8000-000000000002\n"
    after = capture(tmp_path, "after", fs=fs)
    result = compare(before, after)
    assert_fail(result, "HOST_BOOT_CHANGED")


def test_mosquitto_config_drift_fails(tmp_path: Path) -> None:
    before = capture(tmp_path, "before")
    fs = fs_fixture("P4CANARYdefault")
    fs["etc/mosquitto/mosquitto.conf"] += "listener 8883 0.0.0.0\n"
    after = capture(tmp_path, "after", fs=fs)
    result = compare(before, after)
    assert_fail(result, "MQTT_CONFIG_DRIFT")


def test_dns_configuration_drift_fails(tmp_path: Path) -> None:
    fs_before = fs_fixture("P4CANARYdefault")
    fs_before["etc/resolv.conf"] = "nameserver 127.0.0.53\n"
    before = capture(tmp_path, "before", fs=fs_before)
    fs_after = fs_fixture("P4CANARYdefault")
    fs_after["etc/resolv.conf"] = "nameserver 1.1.1.1\n"
    after = capture(tmp_path, "after", fs=fs_after)
    result = compare(before, after)
    assert_fail(result, "DNS_CONFIGURATION_DRIFT")


# ── L–N. stage gate ──────────────────────────────────────────────────────────

def today(offset: int = 0) -> str:
    return (dt.datetime.now(WINDOW_TZ).date() + dt.timedelta(days=offset)).isoformat()


EXTRA_AUTH = {"L1": "d6_notice=pub\n", "L2": "integration_review=kla\n", "L7": "d6_notice=pub\n",
              "L8": "recovery_authorization=https://example.invalid/aegis-p4-test-recovery\n"}


def auth_record(stage: str, date: str | None = None, **overrides: str) -> str:
    fields = {
        "stage": stage, "date": date or today(), "authorizer": "music",
        "scope": "test-only placeholder authorization record",
        "reference": "https://example.invalid/aegis-p4-test-authorization",
    }
    fields.update(overrides)
    body = "".join(f"{k}={v}\n" for k, v in fields.items() if v is not None)
    return "AEGIS_P4_AUTHORIZATION_V1\n" + body + EXTRA_AUTH.get(stage, "")


def k3_record(stage: str, date: str | None = None, **overrides: str) -> str:
    fields = {
        "stage": stage, "date": date or today(), "confirmed_by": "kraveerachat", "idea1_window_overlap": "NONE",
        "reference": "https://example.invalid/aegis-p4-test-k3",
    }
    fields.update(overrides)
    return "AEGIS_P4_K3_CONFIRMATION_V1\n" + "".join(f"{k}={v}\n" for k, v in fields.items() if v is not None)


def gate(tmp_path: Path, *args: str, auth: str | None = None, k3: str | None = None, extra_env: dict[str, str] | None = None) -> subprocess.CompletedProcess:
    root = tmp_path / "gate"
    root.mkdir(exist_ok=True)
    bindir = root / "bin"
    if not bindir.exists():
        bindir = make_bin(root)
    calls = root / "calls.log"
    calls.touch()
    argv = list(args)
    if auth is not None:
        (root / "auth.txt").write_text(auth)
        argv += ["--authorization", str(root / "auth.txt")]
    if k3 is not None:
        (root / "k3.txt").write_text(k3)
        argv += ["--k3", str(root / "k3.txt")]
    env = {"PATH": str(bindir), "HOME": str(root), "LC_ALL": "C", "P4_CALL_LOG": str(calls),
           "P4_FIX": str(root)}
    if extra_env:
        env.update(extra_env)
    result = subprocess.run(["bash", str(GATE), *argv], capture_output=True, text=True,
                            env=env, stdin=subprocess.DEVNULL, timeout=30,
                            check=False)
    assert calls.read_text() == "", "the stage gate must not call any host command"
    return result


def gate_fail(result: subprocess.CompletedProcess, code: str) -> None:
    assert result.returncode == 1, result.stdout + result.stderr
    assert f"GATE_FAIL {code}" in result.stdout, result.stdout
    assert "STAGE_GATE=FAIL" in result.stdout
    assert "LIVE_STAGE_AUTHORIZED=YES" not in result.stdout


def test_gate_missing_stage_fails(tmp_path: Path) -> None:
    gate_fail(gate(tmp_path, "--mode", "simulate", auth=auth_record("L2"), k3=k3_record("L2")), "STAGE_MISSING")


@pytest.mark.parametrize("stage", ["L10", "l2", "L6", "CUT", "RESTORE", "L2;id", ""])
def test_gate_unknown_stage_fails(tmp_path: Path, stage: str) -> None:
    gate_fail(gate(tmp_path, "--stage", stage, "--mode", "simulate", auth=auth_record("L2"), k3=k3_record("L2")),
              "STAGE_UNKNOWN" if stage else "STAGE_MISSING")


@pytest.mark.parametrize("mode", ["", "dry-run", "LIVE"])
def test_gate_requires_explicit_mode(tmp_path: Path, mode: str) -> None:
    gate_fail(gate(tmp_path, "--stage", "L2", "--mode", mode, auth=auth_record("L2"), k3=k3_record("L2")),
              "MODE_INVALID")


def test_gate_missing_authorization_fails(tmp_path: Path) -> None:
    gate_fail(gate(tmp_path, "--stage", "L2", "--mode", "simulate", k3=k3_record("L2")), "AUTHORIZATION_MISSING")
    gate_fail(gate(tmp_path, "--stage", "L0", "--mode", "simulate"), "AUTHORIZATION_MISSING")


@pytest.mark.parametrize("offset", [-1, 1, -30])
def test_gate_stale_or_future_authorization_fails(tmp_path: Path, offset: int) -> None:
    gate_fail(gate(tmp_path, "--stage", "L2", "--mode", "simulate", auth=auth_record("L2", date=today(offset)),
                   k3=k3_record("L2")), "AUTHORIZATION_STALE")


def test_gate_authorization_for_another_stage_fails(tmp_path: Path) -> None:
    gate_fail(gate(tmp_path, "--stage", "L3", "--mode", "simulate", auth=auth_record("L2"), k3=k3_record("L3")),
              "AUTHORIZATION_STAGE_MISMATCH")


@pytest.mark.parametrize("record", [
    "",
    "stage=L2\n",
    auth_record("L2").replace("AEGIS_P4_AUTHORIZATION_V1", "AEGIS_P4_AUTHORIZATION_V0"),
    auth_record("L2", date="2026-9-17"),
    auth_record("L2", date="17/09/2026"),
    auth_record("L2", authorizer="someone-else"),
    auth_record("L2", reference=""),
    auth_record("L2", reference="<REPLACE-ME>"),
    auth_record("L2", scope=""),
    auth_record("L2") + "stage=L2\n",
    auth_record("L2") + "psk=not-allowed\n",
    auth_record("L2") + "-----BEGIN PRIVATE KEY-----\n",
    auth_record("L2").replace("\n", "\r\n"),
    auth_record("L2").replace("integration_review=kla\n", ""),
    auth_record("L2", scope="line one\x1bline two"),
    "AEGIS_P4_AUTHORIZATION_V1\n" + "scope=" + "x" * 5000 + "\n",
])
def test_gate_malformed_authorization_fails(tmp_path: Path, record: str) -> None:
    gate_fail(gate(tmp_path, "--stage", "L2", "--mode", "simulate", auth=record, k3=k3_record("L2")),
              "AUTHORIZATION_MALFORMED")


@pytest.mark.parametrize("stage", ["L1", "L2", "L3", "L4", "L5", "L6a", "L6b", "L7", "L8", "L9"])
def test_gate_mutating_stage_without_k3_fails(tmp_path: Path, stage: str) -> None:
    gate_fail(gate(tmp_path, "--stage", stage, "--mode", "simulate", auth=auth_record(stage)), "K3_MISSING")


@pytest.mark.parametrize(("k3", "code"), [
    (lambda: k3_record("L2", date=today(-1)), "K3_STALE"),
    (lambda: k3_record("L2", idea1_window_overlap="ACTIVE"), "K3_OVERLAP_NOT_NONE"),
    (lambda: k3_record("L2", idea1_window_overlap="UNKNOWN"), "K3_OVERLAP_NOT_NONE"),
    (lambda: k3_record("L3"), "K3_STAGE_MISMATCH"),
    (lambda: k3_record("L2", confirmed_by="music"), "K3_MALFORMED"),
    (lambda: k3_record("L2").replace("AEGIS_P4_K3_CONFIRMATION_V1", "K3"), "K3_MALFORMED"),
    (lambda: k3_record("L2", reference=None), "K3_MALFORMED"),
])
def test_gate_invalid_k3_fails(tmp_path: Path, k3, code: str) -> None:
    gate_fail(gate(tmp_path, "--stage", "L2", "--mode", "simulate", auth=auth_record("L2"), k3=k3()), code)


def test_gate_simulation_with_valid_records_never_authorizes_live(tmp_path: Path) -> None:
    result = gate(tmp_path, "--stage", "L2", "--mode", "simulate", auth=auth_record("L2"), k3=k3_record("L2"))
    assert result.returncode == 0, result.stdout + result.stderr
    out = result.stdout
    assert "STAGE_GATE=PASS_SIMULATION" in out
    assert "AUTHORIZATION_RECORD=VALID" in out
    assert "K3_CONFIRMATION=VALID" in out
    assert "STAGE_MUTATES_PRODUCTION=YES" in out
    assert "REQUIRED_REPOSITORY_GAPS=G-06,G-15" in out
    assert "ROLLBACK_HANDLER=REGISTERED" in out
    assert "S10_IDEA2_CAVEAT=OPEN" in out
    assert "LIVE_STAGE_AUTHORIZED=NO" in out
    assert "PRODUCTION_MUTATION_PERFORMED=NO" in out


def test_gate_live_mode_for_mutating_stage_fails_without_registered_handler(tmp_path: Path) -> None:
    # All mutating P4 stages (L1..L9) have reviewed handlers registered.
    # Synthetic test fixture isolates a stages directory where a real mutating stage (L1)
    # has no handler directory, proving fail-closed ROLLBACK_HANDLER_NOT_REGISTERED.
    synthetic_stages = tmp_path / "synthetic_stages_empty"
    synthetic_stages.mkdir(parents=True, exist_ok=True)
    result = gate(
        tmp_path,
        "--stage",
        "L1",
        "--mode",
        "live",
        auth=auth_record("L1"),
        k3=k3_record("L1"),
        extra_env={"AEGIS_P4_HANDLER_DIR": str(synthetic_stages)},
    )
    assert "STAGE_MUTATES_PRODUCTION=YES" in result.stdout
    assert "ROLLBACK_HANDLER=NOT_REGISTERED" in result.stdout
    gate_fail(result, "ROLLBACK_HANDLER_NOT_REGISTERED")
    assert "AUTHORIZATION_RECORD=VALID" in result.stdout


def test_gate_live_mode_fails_if_handler_file_is_missing(tmp_path: Path) -> None:
    # Proves that if even one of the five required handler files is missing, handler status is NOT_REGISTERED.
    synthetic_stages = tmp_path / "synthetic_stages_partial"
    stage_dir = synthetic_stages / "L1"
    stage_dir.mkdir(parents=True, exist_ok=True)
    for f in ("apply.sh", "verify.sh", "allow-keys.txt", "allow-listeners.txt"):
        (stage_dir / f).touch()
    result = gate(
        tmp_path,
        "--stage",
        "L1",
        "--mode",
        "live",
        auth=auth_record("L1"),
        k3=k3_record("L1"),
        extra_env={"AEGIS_P4_HANDLER_DIR": str(synthetic_stages)},
    )
    assert "ROLLBACK_HANDLER=NOT_REGISTERED" in result.stdout
    gate_fail(result, "ROLLBACK_HANDLER_NOT_REGISTERED")


@pytest.mark.parametrize("mode", ["simulate", "live"])
def test_gate_read_only_l0_needs_authorization_but_not_k3(tmp_path: Path, mode: str) -> None:
    result = gate(tmp_path, "--stage", "L0", "--mode", mode, auth=auth_record("L0"))
    assert result.returncode == 0, result.stdout + result.stderr
    assert "STAGE_MUTATES_PRODUCTION=NO" in result.stdout
    assert "K3_CONFIRMATION=NOT_REQUIRED" in result.stdout
    assert "READ_ONLY_CAPTURE_ALLOWED=YES" in result.stdout
    assert "LIVE_STAGE_AUTHORIZED=NO" in result.stdout
    assert "PRODUCTION_MUTATION_PERFORMED=NO" in result.stdout


def test_gate_l0_with_stale_authorization_still_fails(tmp_path: Path) -> None:
    gate_fail(gate(tmp_path, "--stage", "L0", "--mode", "live", auth=auth_record("L0", date=today(-1))),
              "AUTHORIZATION_STALE")


# ── O. no mutation calls recorded by the fake command layer ──────────────────

READ_ONLY_CALLS = (
    r"ip -br (addr|link) show",
    r"ip -[46] (route|rule) show",
    r"sysctl -n net\.ipv[46]\.[a-z0-9_.]+",
    r"rfkill --noheadings --output ID,TYPE,SOFT,HARD",
    r"iw (reg get|dev|phy)",
    r"nmcli -t -f [A-Z,-]+ (general status|connection show --active|device status)",
    r"nft (list tables|--stateless list ruleset|--stateless list table [a-z0-9]+ [A-Za-z0-9_-]+)",
    r"timedatectl (show|show-timesync)( -p [A-Za-z]+)+",
    r"ss -H (-ltnu|-tn state established)",
    r"systemctl show( -p [A-Za-z]+)+ [A-Za-z0-9@._-]+\.(service|socket)",
    r"journalctl -u [A-Za-z0-9@._-]+\.service --since [0-9]{4}-[0-9]{2}-[0-9]{2} [0-9:]{8} UTC --no-pager -o cat",
    r"df -P -k /[a-z]*",
    r"hostnamectl --static",
    r"uname -r",
    r"twingate status",
)


def test_capture_calls_only_read_only_commands_through_the_guard(tmp_path: Path) -> None:
    cap = capture(tmp_path, "calls", fixtures=live_like_unhealthy(healthy_fixtures()))
    assert cap.result.returncode == 0, cap.result.stdout + cap.result.stderr
    calls = cap.calls.read_text().splitlines()
    assert len(calls) > 30
    for call in calls:
        argv, _, guard = call.rpartition(" guard=")
        assert guard == "1", f"host command bypassed p4_ro: {call}"
        assert any(re.fullmatch(p, argv) for p in READ_ONLY_CALLS), f"unexpected host command: {argv}"
        assert scan(argv) == [], argv
    compare(cap, cap)
    assert cap.calls.read_text().splitlines() == calls, "compare must not call host commands"


# ── P. Phase 4 L0 harness portability and fail-closed repair regressions ──────

def find_utf8_locale() -> str:
    res = subprocess.run(["locale", "-a"], capture_output=True, text=True, check=False)
    locales = set(res.stdout.splitlines())
    for cand in ("en_US.UTF-8", "en_US.utf8", "C.UTF-8", "C.utf8"):
        if cand in locales or cand.lower() in {l.lower() for l in locales}:
            return cand
    return "C.UTF-8"


def test_gate_l0_authorization_passes_under_utf8_locale(tmp_path: Path) -> None:
    loc = find_utf8_locale()
    auth = auth_record("L0", scope="read-only baseline preflight capture",
                       reference="PR11-L0-PREFLIGHT-2026-09-21")
    result = gate(tmp_path, "--stage", "L0", "--mode", "simulate",
                  auth=auth, extra_env={"LC_ALL": loc, "LANG": loc})
    assert result.returncode == 0, f"Failed under locale {loc}: {result.stdout}\n{result.stderr}"
    assert "AUTHORIZATION_RECORD=VALID" in result.stdout
    assert "READ_ONLY_CAPTURE_ALLOWED=YES" in result.stdout
    assert "STAGE_GATE=PASS_READ_ONLY" in result.stdout
    assert "GATE_FAIL" not in result.stdout


def test_capture_nm_profile_with_spaces_captured_safely(tmp_path: Path) -> None:
    secret = canary()
    fs = fs_fixture(secret)
    fs["etc/NetworkManager/system-connections/Wired connection 1.nmconnection"] = f"[wifi-security]\npsk={secret}\n"
    cap = capture(tmp_path, "spaces", fs=fs, secret=secret)
    assert cap.result.returncode == 0, cap.result.stdout + cap.result.stderr
    assert "L0_CAPTURE=COMPLETE" in cap.result.stdout
    assert "REFUSED non-read-only command: stat" not in cap.result.stderr
    log = (cap.evid / "capture.log").read_text()
    assert "REFUSED non-read-only command: stat" not in log
    rec = cap.records()
    meta_key = "nm.profile./etc/NetworkManager/system-connections/Wired_connection_1.nmconnection.meta"
    assert meta_key in rec, f"Expected {meta_key} in records: {list(rec.keys())}"
    assert rec[meta_key] != "UNREADABLE", f"{meta_key} is UNREADABLE"
    assert rec[meta_key].startswith("mode=")


def test_read_only_guard_refuses_extra_argv_boundary_violation(tmp_path: Path) -> None:
    bindir = make_bin(tmp_path)
    calls = tmp_path / "calls.log"
    calls.touch()
    extra_argv_cases = [
        ["stat", "-c", "%a:%u:%g:%s:%Y", "--", "/valid/path", "/extra/arg"],
        ["stat", "-c", "%a:%u:%g:%s:%Y", "--", "/path with space", "extra"],
        ["sha256sum", "--", "/valid/path", "/extra/arg"],
        ["sha256sum", "--", "/path with space", "extra"],
        ["readlink", "--", "/valid/path", "/extra/arg"],
        ["readlink", "-f", "--", "/valid/path", "/extra/arg"],
        ["find", "/valid/path", "-xdev", "-type", "f", "-delete"],
        ["find", "/valid/path", "/extra/path", "-xdev", "-type", "f"],
    ]
    for argv in extra_argv_cases:
        words = " ".join(f"'{w}'" for w in argv)
        result = ro(f"p4_ro {words}", bindir, calls)
        assert result.returncode == 126, f"Expected 126 for {argv}, got {result.returncode}"
        assert "REFUSED non-read-only command:" in (result.stdout + result.stderr)


def test_read_only_guard_refuses_control_characters_in_paths(tmp_path: Path) -> None:
    bindir = make_bin(tmp_path)
    calls = tmp_path / "calls.log"
    calls.touch()
    bad_paths = [
        "/path/with\nnewline",
        "/path/with\rCR",
        "/path/with\ttab",
        "/path/with\x1bescape",
        "/path/with\x07bell",
    ]
    for bp in bad_paths:
        for cmd in [
            ["stat", "-c", "%a:%u:%g:%s:%Y", "--", bp],
            ["sha256sum", "--", bp],
            ["readlink", "--", bp],
            ["find", bp, "-xdev", "-type", "f"],
        ]:
            words = " ".join(f"'{w}'" for w in cmd)
            result = ro(f"p4_ro {words}", bindir, calls)
            assert result.returncode == 126, f"Expected 126 for {cmd}, got {result.returncode}"
            assert "REFUSED non-read-only command:" in (result.stdout + result.stderr)


def test_capture_required_metadata_read_failure_results_in_partial_and_exit_3(tmp_path: Path) -> None:
    # Simulate an unreadable metadata failure on a required capture surface by intercepting stat
    root = tmp_path / "meta_fail"
    root.mkdir(parents=True)
    fix = root / "fix"
    write_tree(fix, healthy_fixtures())
    fsroot = root / "fsroot"
    write_tree(fsroot, fs_fixture("canary_meta_fail"))
    bindir = make_bin(root)
    # Create a wrapper stat that fails specifically when called on the NM connection profile
    real_stat = shutil.which("stat")
    wrapper = bindir / "stat"
    wrapper.unlink()
    wrapper.write_text(f"""#!/usr/bin/env bash
for arg in "$@"; do
  if [[ "$arg" == *"ap-test.nmconnection"* ]]; then
    echo "simulated stat I/O failure" >&2
    exit 1
  fi
done
exec {real_stat} "$@"
""")
    wrapper.chmod(0o755)

    calls = root / "calls.log"
    calls.touch()
    evid = root / "evidence"
    base = {
        "PATH": str(bindir), "HOME": str(root), "LC_ALL": "C", "P4_FIX": str(fix), "P4_CALL_LOG": str(calls),
        "EVID_DIR": str(evid), "CAPTURE_LABEL": "meta-fail", "JOURNAL_SINCE": JOURNAL_SINCE,
        "AEGIS_P4_FS_ROOT": str(fsroot),
    }
    result = subprocess.run(["bash", str(CAPTURE)], capture_output=True, text=True, env=base,
                            stdin=subprocess.DEVNULL, timeout=120, check=False)
    assert result.returncode == 3, f"Expected exit code 3, got {result.returncode}\n{result.stdout}\n{result.stderr}"
    assert "L0_CAPTURE=PARTIAL" in result.stdout
    rec: dict[str, str] = {}
    for tsv in evid.glob("*.tsv"):
        for line in tsv.read_text().splitlines():
            k, _, v = line.partition("\t")
            rec[k] = v
    assert rec.get("meta.capture_status") == "PARTIAL"
    assert rec.get("nm.profile./etc/NetworkManager/system-connections/ap-test.nmconnection.meta") == "UNREADABLE"


def test_secret_hygiene_nm_profile_with_spaces_never_emitted(tmp_path: Path) -> None:
    secret = canary()
    fs = fs_fixture(secret)
    fs["etc/NetworkManager/system-connections/Wired connection 1.nmconnection"] = f"[wifi-security]\npsk={secret}\n"
    cap = capture(tmp_path, "spaces_secret", fs=fs, secret=secret)
    rec = cap.records()
    profile_class = rec.get("nm.profile./etc/NetworkManager/system-connections/Wired_connection_1.nmconnection.class")
    assert profile_class == "secret-metadata-only"
    assert "nm.profile./etc/NetworkManager/system-connections/Wired_connection_1.nmconnection.sha256" not in rec

    streams = [cap.result.stdout, cap.result.stderr]
    for p in cap.evid.rglob("*"):
        if p.is_file():
            streams.append(p.read_text(errors="replace"))
    for s in streams:
        assert secret not in s, "Secret leaked into capture output or bundle files"
