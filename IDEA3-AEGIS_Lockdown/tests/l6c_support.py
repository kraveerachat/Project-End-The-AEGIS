"""Shared L6c fixture support: fixture host root and a stateful fake systemctl/ss for read-only snapshot comparisons.
L6c never mutates systemd or listeners — the fake here only ever answers `show`/`is-active`/`is-enabled`; any other verb
dies, so a test would fail loudly if a handler ever attempted a real mutation.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEPLOY = ROOT / "deploy" / "pr11-phase4"
L6C_STAGE = DEPLOY / "stages" / "L6c"
APPLY, VERIFY, ROLLBACK = (L6C_STAGE / n for n in ("apply.sh", "verify.sh", "rollback.sh"))
INSTALLER = DEPLOY / "p4-l7-install-release.py"
GUARD = DEPLOY / "p4-l7-release-guard.py"
CAPTURE = DEPLOY / "p4-l0-capture.sh"
COMPARE = DEPLOY / "p4-compare.sh"

LEGACY_UNIT = "mosquitto.service"
BROKER_UNIT = "aegis-idea3-mosquitto.service"
CORE_UNIT = "aegis-idea3-core.service"
IDEA2_ENGINE = "aegis-detection-engine.service"
IDEA2_TUNNEL = "aegis-detection-tunnel.service"
REL_ID = "rel-l6c-1"
LOGICAL = f"/opt/aegis-idea3/releases/{REL_ID}"

sys.path.insert(0, str(ROOT / "tests"))
from test_pr11_phase4_l7_release_guard_helper import build_release  # noqa: E402

FAKE = r'''#!__PY__
import json, os, sys
STATE = os.environ["FAKE_SYSTEMD_STATE"]
st = json.load(open(STATE))
argv = sys.argv[1:]
st.setdefault("calls", []).append({"argv": argv})
json.dump(st, open(STATE, "w"))
CLEAN = dict(load="not-found", active="inactive", sub="dead", result="success", enabled=False, pid="0", nrestarts="0")
def get(u):
    return st["units"].get(u, dict(CLEAN))
def props(u):
    return {"LoadState": u["load"], "ActiveState": u["active"], "SubState": u["sub"], "Result": u["result"],
            "UnitFileState": ("enabled" if u["enabled"] else "disabled") if u["load"] == "loaded" else "",
            "MainPID": u["pid"], "NRestarts": u["nrestarts"], "ExecMainStartTimestamp": ""}
if not argv:
    sys.exit(2)
cmd, rest = argv[0], argv[1:]
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
    sys.exit(0)
if cmd == "is-active":
    sys.exit(0 if get(rest[-1])["active"] == "active" else 3)
if cmd == "is-enabled":
    sys.exit(0 if get(rest[-1])["enabled"] else 1)
sys.stderr.write("fake: L6c must never issue a systemctl mutation: " + cmd + "\n")
sys.exit(99)
'''

FAKE_SS = r'''#!__PY__
import os, sys
for line in os.environ.get("FAKE_SS_LISTEN", "0.0.0.0:1883\n127.0.0.1:8883\n10.77.30.1:8883\n").splitlines():
    print("LISTEN 0 100 %s 0.0.0.0:*" % line)
'''


@dataclass
class Fx:
    tmp: Path
    root: Path
    work: Path
    source: Path
    bin: Path
    state: Path

    @property
    def release(self) -> Path:
        return self.root / LOGICAL.lstrip("/")

    @property
    def current(self) -> Path:
        return self.root / "opt/aegis-idea3/current"

    def env(self, **extra: str) -> dict[str, str]:
        env = {k: v for k, v in os.environ.items() if not k.startswith(("FAKE_", "AEGIS_L6C"))}
        env.update(
            AEGIS_P4_FS_ROOT=str(self.root), AEGIS_L6C_WORK_DIR=str(self.work), AEGIS_L6C_SOURCE_DIR=str(self.source),
            AEGIS_L6C_RELEASE_ID=REL_ID, AEGIS_PYTHON_BIN=sys.executable,
            AEGIS_L6C_FIXTURE_SYSTEMCTL=str(self.bin / "systemctl"), AEGIS_L6C_FIXTURE_SS=str(self.bin / "ss"),
            FAKE_SYSTEMD_STATE=str(self.state),
            AEGIS_L6C_FIXTURE_DEST_OWNER_ANY="YES",  # most tests are not about ownership; ownership itself is tested separately
        )
        env.update(extra)
        return env

    def run(self, script: Path, *, keep_work: bool = False, **extra: str) -> subprocess.CompletedProcess[str]:
        if script == APPLY and not keep_work and self.work.exists() and not self.work.is_symlink():
            shutil.rmtree(self.work)
        return subprocess.run(["bash", str(script)], text=True, capture_output=True, check=False, env=self.env(**extra))

    def data(self) -> dict:
        return json.loads(self.state.read_text())

    def calls(self) -> list[dict]:
        return self.data().get("calls", [])

    def unit_state(self, name: str) -> dict:
        return self.data()["units"].get(name, {"load": "not-found", "active": "inactive", "sub": "dead", "result": "success"})

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


def build(tmp_path: Path, *, release_id: str = REL_ID) -> Fx:
    root = tmp_path / "fs"
    (root / "etc/aegis-idea3").mkdir(parents=True)
    (root / "etc/mosquitto").mkdir(parents=True)
    (root / "etc/mosquitto/mosquitto.conf").write_text("listener 1883\n")
    (root / "etc/mosquitto/passwd").write_text("aegis:$7$101$legacy\n")
    for parent in ("var/lib", "var/log", "run", "proc", "opt"):
        (root / parent).mkdir(parents=True, exist_ok=True)
    source = build_release(tmp_path / "staging", release_id=release_id)
    bin_dir = tmp_path / "fakebin"
    bin_dir.mkdir()
    for name, body in (("systemctl", FAKE), ("ss", FAKE_SS)):
        exe = bin_dir / name
        exe.write_text(body.replace("__PY__", sys.executable))
        exe.chmod(0o755)
    state = tmp_path / "systemd-state.json"
    live = dict(load="loaded", active="active", sub="running", result="success", enabled=True, pid="1111", nrestarts="0")
    idea2 = dict(load="loaded", active="active", sub="running", result="success", enabled=True, pid="2222", nrestarts="0")
    state.write_text(json.dumps({"calls": [], "units": {
        LEGACY_UNIT: live, BROKER_UNIT: dict(live, pid="3333"), IDEA2_ENGINE: idea2, IDEA2_TUNNEL: dict(idea2, pid="4444"),
    }}))
    return Fx(tmp_path, root, tmp_path / "work", source, bin_dir, state)
