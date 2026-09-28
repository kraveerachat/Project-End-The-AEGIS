"""Shared L7 fixture support: fixture host root, owner input, a stateful fake systemd (systemctl / systemd-analyze / ss) and capture helpers.

Nothing here touches the real host. The fake models exactly the facts the L7 handlers depend on (each was observed live in the L6b
attempts or is documented in the L7 design): a failed unit keeps not-found/failed metadata after its file is removed and reloaded until
`reset-failed` names it; a bare reset-failed clears EVERY failed unit; the Core "starts" only if the service account could read what the
real service reads; StateDirectory/LogsDirectory/RuntimeDirectory are created by systemd at start and only the runtime directory is
removed at stop.
"""

from __future__ import annotations

import grp
import json
import os
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEPLOY = ROOT / "deploy" / "pr11-phase4"
L7_STAGE = DEPLOY / "stages" / "L7"
APPLY, VERIFY, ROLLBACK = (L7_STAGE / n for n in ("apply.sh", "verify.sh", "rollback.sh"))
CAPTURE = DEPLOY / "p4-l0-capture.sh"
COMPARE = DEPLOY / "p4-compare.sh"

AP = "10.77.30.1"
DEVICE_ID = "aegis-relay-01"
REL_ID = "rel-20260927"
REL_LOGICAL = f"/opt/aegis-idea3/releases/{REL_ID}"
UNIT = "aegis-idea3-core.service"
BROKER_UNIT = "aegis-idea3-mosquitto.service"
LEGACY_UNIT = "mosquitto.service"
OTHER_FAILED = "aegis-idea3-dnsmasq.service"

C2D = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
D2C = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210"
MQTT_PASS = "CANARY-mqtt-core-password-91f3c2"
ADMIN_PIN = "CANARY-849201-pin"
RESTORE_SECRET = "CANARY-restore-secret-0123456789"
SECRETS = (C2D, D2C, MQTT_PASS, ADMIN_PIN, RESTORE_SECRET)

CRED_FILES = ("k_c2d", "k_d2c", "mqtt-core.pass", "admin.pin", "restore.credential")
INPUT_ENTRIES = sorted(CRED_FILES)
CREDS = "etc/aegis-idea3/credentials"
CORE_ENV = "etc/aegis-idea3/core.env"
PKI_CA = "etc/aegis-idea3/pki/mqtt-ca.crt"
UNIT_REL = "etc/systemd/system/aegis-idea3-core.service"
CURRENT = "opt/aegis-idea3/current"
RUNTIME_DIRS = ("var/lib/aegis-idea3", "var/log/aegis-idea3", "run/aegis-idea3")

# logical path -> (mode, owner:group)  — the exact L7 ownership/mode model
OWNERSHIP_MODEL = {
    "/etc/aegis-idea3/credentials": ("750", "root:aegis-idea3"),
    "/etc/aegis-idea3/credentials/k_c2d": ("600", "root:root"),
    "/etc/aegis-idea3/credentials/k_d2c": ("600", "root:root"),
    "/etc/aegis-idea3/credentials/mqtt-core.pass": ("600", "root:root"),
    "/etc/aegis-idea3/credentials/admin.pin": ("600", "root:root"),
    "/etc/aegis-idea3/credentials/restore.credential": ("600", "aegis-idea3:aegis-idea3"),
    "/etc/aegis-idea3/core.env": ("640", "root:aegis-idea3"),
    "/etc/aegis-idea3/pki/mqtt-ca.crt": ("644", "root:root"),
    "/etc/systemd/system/aegis-idea3-core.service": ("644", "root:root"),
}


def fixture_service_group() -> str:
    """A group of the test user that is not its primary group when possible, so a missing chgrp is detectable."""
    primary = os.getgid()
    for gid in os.getgroups():
        if gid != primary:
            return grp.getgrgid(gid).gr_name
    return grp.getgrgid(primary).gr_name


FAKE = r'''#!__PY__
import grp, json, os, sqlite3, sys
STATE, ROOT, GROUP = os.environ["FAKE_SYSTEMD_STATE"], os.environ["FAKE_ROOT"], os.environ["AEGIS_L7_FIXTURE_SERVICE_GROUP"]
UNIT = "aegis-idea3-core.service"
NAME = os.path.basename(sys.argv[0])
st = json.load(open(STATE))
argv = sys.argv[1:]
unit_file = os.path.exists(ROOT + "/etc/systemd/system/" + UNIT)
st["calls"].append({"tool": NAME, "argv": argv, "unit_file": unit_file})
def save():
    json.dump(st, open(STATE, "w"), indent=1)
def die(msg, rc):
    save(); sys.stderr.write(msg + "\n"); sys.exit(rc)
CLEAN = dict(load="not-found", active="inactive", sub="dead", result="success", enabled=False, pid=0, nrestarts=0)
def get(u):
    return st["units"].get(u, dict(CLEAN))
def grp_of(path):
    return grp.getgrgid(os.stat(path).st_gid).gr_name
def readable(path):
    s = os.stat(ROOT + path); m = s.st_mode
    return bool(m & 0o004) or (bool(m & 0o040) and grp_of(ROOT + path) == GROUP)
def traversable(path):
    s = os.stat(ROOT + path); m = s.st_mode
    return bool(m & 0o001) or (bool(m & 0o010) and grp_of(ROOT + path) == GROUP)
def mkdir(path):
    os.makedirs(ROOT + path, exist_ok=True)
    os.chmod(ROOT + path, 0o700)
def start():
    u = st["units"][UNIT]
    fail = os.environ.get("FAKE_CORE_FAIL", "")
    err = None
    if fail == "preflight":
        err = "preflight: production requires a readable MQTT CA file"
    link = ROOT + "/opt/aegis-idea3/current"
    if err is None and not (os.path.islink(link) and os.path.isdir(ROOT + os.readlink(link))):
        err = "WorkingDirectory=/opt/aegis-idea3/current: No such file or directory"
    # the service reads these directly as the service account: CA, core.env (EnvironmentFile is read by systemd), restore credential
    for path in ("/etc/aegis-idea3/pki/mqtt-ca.crt", "/etc/aegis-idea3/credentials/restore.credential"):
        if err is None and not os.path.isfile(ROOT + path):
            err = "missing " + path
    if err is None and not (traversable("/etc/aegis-idea3/pki") if os.path.isdir(ROOT + "/etc/aegis-idea3/pki") else False):
        err = "pki directory not traversable by the service account"
    if err is None and not readable("/etc/aegis-idea3/pki/mqtt-ca.crt"):
        err = "production requires a readable MQTT CA file"
    if err is None and not traversable("/etc/aegis-idea3/credentials"):
        err = "D4 Core-local RESTORE credential is unsafe: CredentialError"
    if err is None:
        # RestoreCredential.load: regular file, EXACT mode 0600, owned by the Core account (the fixture owner stands in for it)
        m = os.stat(ROOT + "/etc/aegis-idea3/credentials/restore.credential").st_mode
        if (m & 0o7777) != 0o600:
            err = "D4 Core-local RESTORE credential is unsafe: CredentialError"
    u["load"] = "loaded"
    if err:
        u.update(active="failed", sub="failed", result="exit-code", pid=0)
        st["journal"].append(err)
        return
    for d in ("/var/lib/aegis-idea3/data", "/var/log/aegis-idea3", "/run/aegis-idea3"):
        mkdir(d)
    pid = 4243
    u.update(active="active", sub="running", result="success", pid=pid)
    audit = sqlite3.connect(ROOT + "/var/lib/aegis-idea3/data/core-audit.sqlite3")
    audit.execute("CREATE TABLE IF NOT EXISTS audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT, level TEXT, event_type TEXT, details TEXT, incident_id INTEGER, hash TEXT)")
    audit.execute("INSERT INTO audit_logs (timestamp, level, event_type, details) VALUES ('t', 'INFO', 'CORE_START', 'runtime started')")
    audit.commit(); audit.close()
    proto = sqlite3.connect(ROOT + "/var/lib/aegis-idea3/data/core-protocol.sqlite3")
    proto.execute("CREATE TABLE IF NOT EXISTS protocol_commands (msg_id TEXT PRIMARY KEY, device_id TEXT, seq INTEGER, action TEXT, state TEXT)")
    if os.environ.get("FAKE_CORE_ACTUATE") == "1":
        proto.execute("INSERT INTO protocol_commands VALUES ('m1', 'dev', 1, 'CUT_UPLINK', 'PUBLISHED')")
    proto.commit(); proto.close()
    status = {"state": os.environ.get("FAKE_CORE_STATE", "WAIT_DEVICE"), "broker": os.environ.get("FAKE_CORE_BROKER", "CONNECTED"),
              "device": "UNKNOWN", "uplink": "UNKNOWN", "armed": "MONITOR_ONLY", "profile": "production", "dry_run": False, "auto_contain": False, "pid": pid}
    json.dump(status, open(ROOT + "/run/aegis-idea3/status.json", "w"))
    os.makedirs(ROOT + "/proc/%d" % pid, exist_ok=True)
    env = "PATH=/usr/bin\0CREDENTIALS_DIRECTORY=/run/credentials/aegis-idea3-core.service\0"
    if os.environ.get("FAKE_CORE_LEAK_ENV") == "1":
        env += "AEGIS_MQTT_PASS=leaked\0"
    open(ROOT + "/proc/%d/environ" % pid, "w").write(env)
def props(u):
    return {"LoadState": u["load"], "ActiveState": u["active"], "SubState": u["sub"], "Result": u["result"],
            "UnitFileState": ("enabled" if u["enabled"] else "disabled") if u["load"] == "loaded" else "",
            "MainPID": str(u["pid"]), "NRestarts": str(u["nrestarts"]), "ExecMainStartTimestamp": "",
            "LoadCredential": " ".join("%s:/etc/aegis-idea3/credentials/%s" % (n, n) for n in ("k_c2d", "k_d2c", "mqtt-core.pass", "admin.pin")) if u["load"] == "loaded" else "",
            "User": "aegis-idea3"}
if not argv:
    die("no command", 2)
cmd, rest = argv[0], argv[1:]
if NAME == "systemd-analyze":
    if os.environ.get("FAKE_ANALYZE_FAIL") == "1":
        die("unit verification failed", 1)
    save(); sys.exit(0)
if cmd == "show":
    want, value, names, i = [], False, [], 0
    while i < len(rest):
        if rest[i] == "-p": want.append(rest[i + 1]); i += 2
        elif rest[i] == "--value": value = True; i += 1
        else: names.append(rest[i]); i += 1
    for idx, name in enumerate(names):
        p = props(get(name))
        if idx: print()
        for k in (want or list(p)):
            print(p[k] if value else "%s=%s" % (k, p[k]))
    save(); sys.exit(0)
if cmd == "is-active":
    save(); sys.exit(0 if get(rest[-1])["active"] == "active" else 3)
if cmd == "is-enabled":
    save(); sys.exit(0 if get(rest[-1])["enabled"] else 1)
if cmd == "daemon-reload":
    for name, u in list(st["units"].items()):
        if name == UNIT:
            if not unit_file:
                if u["active"] == "failed": u["load"] = "not-found"
                else: del st["units"][name]
            elif u["load"] == "not-found": u["load"] = "loaded"
    save(); sys.exit(0)
if cmd == "stop":
    u = st["units"].get(rest[-1])
    if u and u["active"] == "active":
        u.update(active="inactive", sub="dead", result="success", pid=0)
        if rest[-1] == UNIT:  # RuntimeDirectory= is removed by systemd when the service stops
            import shutil
            shutil.rmtree(ROOT + "/run/aegis-idea3", ignore_errors=True)
            shutil.rmtree(ROOT + "/proc/4243", ignore_errors=True)
    save(); sys.exit(0)
if cmd == "disable":
    u = st["units"].get(rest[-1])
    if u: u["enabled"] = False
    save(); sys.exit(0)
if cmd in ("enable", "start"):
    name = rest[-1]
    if name != UNIT: die("fake: refusing to %s %s" % (cmd, name), 2)
    if not unit_file: die("Unit file does not exist", 1)
    u = st["units"].setdefault(UNIT, dict(CLEAN))
    if cmd == "enable": u["enabled"] = True
    if cmd == "start" or "--now" in rest: start()
    save(); sys.exit(0)
if cmd == "reset-failed":
    if os.environ.get("FAKE_SYSTEMD_NOOP_RESET_FAILED") == "1":
        save(); sys.exit(0)
    names = [a for a in rest if not a.startswith("-")]
    if not names:
        names = [n for n, u in st["units"].items() if u["active"] == "failed"]
    for name in names:
        u = st["units"].get(name)
        if u is None: die("Unit %s not loaded." % name, 1)
        if u["active"] == "failed":
            u.update(active="inactive", sub="dead", result="success", pid=0)
        if u["load"] == "not-found": del st["units"][name]
    save(); sys.exit(0)
die("fake: unsupported command " + cmd, 2)
'''

FAKE_SS = r'''#!__PY__
import json, os, sys
STATE = os.environ["FAKE_SYSTEMD_STATE"]
st = json.load(open(STATE))
u = st["units"].get("aegis-idea3-core.service", {})
args = " ".join(sys.argv[1:])
st["calls"].append({"tool": "ss", "argv": sys.argv[1:], "unit_file": False})
json.dump(st, open(STATE, "w"))
if "state established" in args:
    if u.get("active") == "active" and os.environ.get("FAKE_CORE_CONNECTED", "1") == "1":
        print('ESTAB 0 0 10.77.30.1:51234 10.77.30.1:8883 users:(("python",pid=%d,fd=5))' % u.get("pid", 0))
    sys.exit(0)
for line in os.environ.get("FAKE_SS_LISTEN", "127.0.0.1:8883\n10.77.30.1:8883\n0.0.0.0:1883\n").splitlines():
    print("tcp LISTEN 0 100 %s 0.0.0.0:*" % line)
'''


@dataclass
class Fx:
    tmp: Path
    root: Path
    work: Path
    inp: Path
    group: str
    bin: Path
    state: Path

    @property
    def creds(self) -> Path:
        return self.root / CREDS

    @property
    def core_env(self) -> Path:
        return self.root / CORE_ENV

    @property
    def unit(self) -> Path:
        return self.root / UNIT_REL

    @property
    def current(self) -> Path:
        return self.root / CURRENT

    @property
    def release(self) -> Path:
        return self.root / REL_LOGICAL.lstrip("/")

    @property
    def pki_ca(self) -> Path:
        return self.root / PKI_CA

    def env(self, **extra: str) -> dict[str, str]:
        env = {k: v for k, v in os.environ.items() if not k.startswith(("FAKE_", "AEGIS_L7", "SUDO_"))}
        env.update(
            AEGIS_P4_FS_ROOT=str(self.root), AEGIS_L7_WORK_DIR=str(self.work), AEGIS_L7_INPUT_DIR=str(self.inp),
            AEGIS_L7_RELEASE_DIR=REL_LOGICAL, AEGIS_AP_ADDRESS=AP, AEGIS_PYTHON_BIN=sys.executable,
            AEGIS_L7_FIXTURE_SYSTEMCTL=str(self.bin / "systemctl"), AEGIS_L7_FIXTURE_SYSTEMD_ANALYZE=str(self.bin / "systemd-analyze"),
            AEGIS_L7_FIXTURE_SS=str(self.bin / "ss"), AEGIS_L7_FIXTURE_SERVICE_GROUP=self.group, AEGIS_L7_STABLE_WAIT_SEC="0",
            FAKE_SYSTEMD_STATE=str(self.state), FAKE_ROOT=str(self.root),
        )
        env.update(extra)
        return env

    def run(self, script: Path, *, keep_work: bool = False, cwd: Path | None = None, **extra: str) -> subprocess.CompletedProcess[str]:
        """apply refuses an existing work dir (like L6b); repeated apply runs in one test start from a fresh one unless keep_work.
        `cwd` lets a test pin the handler's working directory (e.g. to prove nothing is written relative to it) without affecting
        every other test, which otherwise inherits pytest's own invocation directory."""
        if script == APPLY and not keep_work and self.work.exists() and not self.work.is_symlink():
            import shutil

            shutil.rmtree(self.work)
        return subprocess.run(["bash", str(script)], text=True, capture_output=True, check=False, env=self.env(**extra), cwd=cwd)

    def data(self) -> dict:
        return json.loads(self.state.read_text())

    def unit_state(self, name: str = UNIT) -> dict:
        return self.data()["units"].get(name, {"load": "not-found", "active": "inactive", "sub": "dead", "result": "success"})

    def calls(self, tool: str = "systemctl", verb: str | None = None) -> list[dict]:
        return [c for c in self.data()["calls"] if c["tool"] == tool and (verb is None or (c["argv"] and c["argv"][0] == verb))]

    def tree(self) -> dict[str, str]:
        out: dict[str, str] = {}
        for p in sorted(self.root.rglob("*")):
            if p.is_file() and not p.is_symlink():
                out[str(p.relative_to(self.root))] = p.read_bytes().hex()
            elif p.is_symlink():
                out[str(p.relative_to(self.root))] = "->" + os.readlink(p)
            elif p.is_dir():
                out[str(p.relative_to(self.root)) + "/"] = ""
        return out

    def systemctl(self, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run([str(self.bin / "systemctl"), *args], text=True, capture_output=True, env=self.env(), check=False)


def make_release(base: Path):
    sys.path.insert(0, str(ROOT / "tests"))
    from test_pr11_phase4_l7_release_guard_helper import build_release

    return build_release(base, release_id=REL_ID)


def make_input(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    (path / "k_c2d").write_text(C2D + "\n")
    (path / "k_d2c").write_text(D2C + "\n")
    (path / "mqtt-core.pass").write_text(MQTT_PASS + "\n")
    (path / "admin.pin").write_text(ADMIN_PIN + "\n")
    sys.path.insert(0, str(ROOT))
    from aegis_soc.local_restore import SCRYPT_MIN_N, hash_secret

    (path / "restore.credential").write_text(hash_secret(RESTORE_SECRET, n=SCRYPT_MIN_N) + "\n", encoding="ascii")
    for name in CRED_FILES:
        (path / name).chmod(0o600)
    path.chmod(0o700)
    return path


def build(tmp_path: Path) -> Fx:
    sys.path.insert(0, str(ROOT / "tests"))
    from test_mqtt_tls_server_name import make_profile_pki

    root = tmp_path / "fs"
    etc = root / "etc/aegis-idea3"
    (etc / "mqtt").mkdir(parents=True)
    (etc / "pki").mkdir()
    (etc / "pki").chmod(0o750)  # live: root:aegis-idea3 0750, pre-existing; the L7 handlers never create or chmod it
    os.chown(etc / "pki", -1, grp.getgrnam(fixture_service_group()).gr_gid)
    (etc / "aegis-idea3.nft").write_text("table inet aegis_idea3 {}\n")
    pki = tmp_path / "pki-scratch"
    make_profile_pki(pki)
    (etc / "mqtt/ca.crt").write_bytes((pki / "ca.crt").read_bytes())
    for name, mode in (("aegis-idea3-mosquitto.conf", 0o640), ("acl", 0o640), ("passwd", 0o640), ("broker.crt", 0o644), ("broker.key", 0o640)):
        (etc / "mqtt" / name).write_text(f"L6B-FIXTURE-{name}\n")
        (etc / "mqtt" / name).chmod(mode)
    (root / "etc/systemd/system").mkdir(parents=True)
    (root / "etc/systemd/system" / BROKER_UNIT).write_text("[Unit]\nDescription=broker fixture\n")
    (root / "etc/mosquitto").mkdir()
    (root / "etc/mosquitto/mosquitto.conf").write_text("listener 1883\n")
    (root / "etc/mosquitto/passwd").write_text("aegis:$7$101$legacy\n")
    for parent in ("var/lib", "var/log", "run", "proc"):  # a real host always has these; the fake creates only the aegis-idea3 dirs in them
        (root / parent).mkdir(parents=True)
    (root / "opt/aegis-idea3/releases").mkdir(parents=True)
    make_release(root / "opt/aegis-idea3/releases")
    inp = make_input(tmp_path / "input")
    bin_dir = tmp_path / "fakebin"
    bin_dir.mkdir()
    for name, body in (("systemctl", FAKE), ("systemd-analyze", FAKE), ("ss", FAKE_SS)):
        exe = bin_dir / name
        exe.write_text(body.replace("__PY__", sys.executable))
        exe.chmod(0o755)
    state = tmp_path / "systemd-state.json"
    live = dict(load="loaded", active="active", sub="running", result="success", enabled=True, pid=1111, nrestarts=0)
    broker = dict(load="loaded", active="active", sub="running", result="success", enabled=True, pid=2222, nrestarts=0)
    failed = dict(load="loaded", active="failed", sub="failed", result="exit-code", enabled=True, pid=0, nrestarts=0)
    state.write_text(json.dumps({"calls": [], "journal": [], "units": {LEGACY_UNIT: live, BROKER_UNIT: broker, OTHER_FAILED: failed}}))
    return Fx(tmp_path, root, tmp_path / "work", inp, fixture_service_group(), bin_dir, state)


def load_make_bundle():
    import importlib.util

    spec = importlib.util.spec_from_file_location("g15_host_artifacts_helpers", ROOT / "tests/test_pr11_phase4_g15_host_artifacts.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.make_bundle


def capture(fx: Fx, label: str) -> Path:
    """Run the REAL capture on the fixture root with the fake systemd on PATH, then rebuild a COMPLETE comparable bundle from its
    host.* and svc.* records (the fixture host has no nft/boot_id, so a raw fixture capture is correctly PARTIAL)."""
    evid = fx.tmp / f"evid-{label}"
    env = dict(os.environ, **fx.env())
    env.update(PATH=f"{fx.bin}:{os.environ['PATH']}", P4_FS_ROOT=str(fx.root), EVID_DIR=str(evid),
               JOURNAL_SINCE="2026-09-27 00:00:00 UTC", CAPTURE_LABEL=label)
    res = subprocess.run(["bash", str(CAPTURE)], text=True, capture_output=True, check=False, env=env)
    assert res.returncode in (0, 3), res.stdout + res.stderr
    records: dict[str, str] = {}
    for tsv, prefixes in (("host.tsv", ("host.",)), ("services.tsv", ("svc.",))):
        for line in (evid / tsv).read_text().splitlines():
            key, _, value = line.partition("\t")
            if value and value != "UNAVAILABLE" and key.startswith(prefixes) and not key.startswith("host.identity"):
                records[key] = value
    return load_make_bundle()(fx.tmp / f"bundle-{label}", label, records)


def compare(before: Path, after: Path, *, allow: bool) -> subprocess.CompletedProcess[str]:
    env = dict(os.environ, DISK_THRESHOLD_PCT="90", AEGIS_AP_ADDRESS=AP, AEGIS_AP_INTERFACE="wlp0s20f3")
    if allow:
        env.update(ALLOW_KEYS_FILE=str(L7_STAGE / "allow-keys.txt"), ALLOW_LISTENERS_FILE=str(L7_STAGE / "allow-listeners.txt"))
    return subprocess.run(["bash", str(COMPARE), str(before), str(after)], text=True, capture_output=True, check=False, env=env)
