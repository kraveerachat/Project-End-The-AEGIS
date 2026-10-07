"""Shared fixtures for the L9 live-successor suites (synthetic Core sources; nothing here touches a host, broker or device)."""

from __future__ import annotations

import importlib.util
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEPLOY = ROOT / "deploy" / "pr11-phase4"
L9_STAGE = DEPLOY / "stages" / "L9"
RUNNER = DEPLOY / "owner-run" / "run-l9-owner.sh"
RUN_LIB = DEPLOY / "p4-l9-run-lib.sh"
LOGS_REL = "Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs"


def load(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, DEPLOY / filename)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


gates = load("p4_l9_gates", "p4-l9-gates.py")
observe = load("p4_l9_live_observe", "p4-l9-live-observe.py")
freeze = load("p4_l9_freeze", "p4-l9-freeze.py")
closeout = load("p4_l9_closeout", "p4-l9-closeout.py")

DEVICE = "esp32-01"
RUN = "l9-20261008-120000"
MAIN = "a" * 40
RUNNER_SHA = "c" * 64
L8_MAIN = "b" * 40
WORK = "/srv/aegis/evidence/l9-work"
EVIDENCE = "/srv/aegis/evidence/l9-evidence"
START = 1_000_000.0


def combined(res: subprocess.CompletedProcess) -> str:
    return (res.stdout or "") + (res.stderr or "")


def code_only(path: Path) -> str:
    """Source with comments and docstrings removed (python via ast; shell via comment-line removal)."""
    import ast
    text = path.read_text()
    if path.suffix == ".py":
        tree = ast.parse(text)
        for node in ast.walk(tree):
            if isinstance(node, (ast.Module, ast.FunctionDef, ast.ClassDef)) and node.body and isinstance(node.body[0], ast.Expr) \
                    and isinstance(getattr(node.body[0], "value", None), ast.Constant) and isinstance(node.body[0].value.value, str):
                node.body = node.body[1:] or [ast.Pass()]
        return ast.unparse(tree)
    return "\n".join(line for line in text.splitlines() if not line.strip().startswith("#"))


def systemd(pid="100", inv="a" * 32, nrestarts="0", active="active", sub="running", result="success"):
    return {"ActiveState": active, "SubState": sub, "MainPID": pid, "NRestarts": nrestarts, "InvocationID": inv, "Result": result}


class World:
    """Fake Core sources (the observer's Sources interface). Rows are time-aware: a row stamped after ``now`` does not exist yet."""

    def __init__(self, start=START, device=DEVICE):
        self.start = start
        self.now = start
        self.device = device
        self.core = systemd("100", "a" * 32)
        self.detector = systemd("200", "b" * 32)
        self.doc = {"pid": 100, "updated_at": start - 10.0, "state": "NORMAL", "time_trust": "SYNCED", "broker": "CONNECTED", "device": "ONLINE", "uplink": "NORMAL"}
        self.m = {"protocol_seen_rowid": 10, "command_rows": 0, "last_allocated_seq": 0, "audit_id": 50, "open_incidents": 0, "open_episodes": 0}
        self.rows: list[tuple[int, float, str]] = []      # (rowid, received_at, device)
        self.audit: list[tuple[int, str, str, float | None]] = []
        self.kinds: dict[int, str] = {}

    # Sources interface -----------------------------------------------------------------------------------------
    def systemd(self, unit):
        return dict(self.core if unit == observe.CORE_UNIT else self.detector)

    def status(self, core_pid):
        return dict(self.doc)

    def metrics(self, device_id):
        visible = [r for r in self.rows if r[1] <= self.now and r[2] == device_id and self.kinds.get(r[0], "STATUS") == "STATUS"]
        return {**self.m, "protocol_seen_rowid": max([self.base_rowid(), *[r[0] for r in visible]]), "audit_id": max([self.base_audit(), *[a[0] for a in self.audit]])}

    def status_rows(self, device_id, after, until):
        return [(i, t) for i, t, dev in self.rows if i > after and t <= self.now and dev == device_id and self.kinds.get(i, "STATUS") == "STATUS"
                and (until is None or i <= until)]

    def audit_rows(self, after, until):
        return [r for r in self.audit if r[0] > after and (until is None or r[0] <= until) and (r[3] is None or r[3] <= self.now + 6)]

    # helpers ---------------------------------------------------------------------------------------------------
    def base_rowid(self):
        return 10

    def base_audit(self):
        return 50

    def add_status(self, t, reason="PERIODIC", state="NORMAL", device=None, kind="STATUS", audit=True, audit_ts=None, audit_event="DEVICE_STATUS"):
        rowid = max([self.base_rowid(), *[r[0] for r in self.rows]]) + 1
        self.rows.append((rowid, t, device or self.device))
        self.kinds[rowid] = kind
        if audit:
            self.add_audit(audit_event, f"{state} ({reason})", t + 1.0 if audit_ts is None else audit_ts)
        return rowid

    def add_audit(self, event, details, ts):
        aid = max([self.base_audit(), *[a[0] for a in self.audit]]) + 1
        self.audit.append((aid, event, details, ts))
        return aid

    def periodic(self, first, count, gap=30.0, **kw):
        for i in range(count):
            self.add_status(first + gap * i, **kw)


def marker_text(boundary: dict[str, str], *, device=DEVICE, consumed="YES", rerun="NO", run=RUN, main=MAIN, runner=RUNNER_SHA, work=WORK, evidence=EVIDENCE,
                consumed_at=None, drop=()) -> str:
    start = float(boundary["L9_PRE_TIME"])
    items = {"L9_ATTEMPT_CONSUMED": consumed, "L9_RERUN_ALLOWED": rerun, "L9_DEVICE_ID": device, "L9_RUN_ID": run, "L9_EXPECTED_MAIN": main,
             "L9_RUNNER_SHA256": runner, "L9_WORK_DIR": work, "L9_EVIDENCE_DIR": evidence,
             "L9_CONSUMED_AT_EPOCH": repr(start + 1.0 if consumed_at is None else consumed_at), **boundary}
    return "".join(f"{k}={v}\n" for k, v in items.items() if k not in drop)


def pre_boundary(w: World) -> dict[str, str]:
    return observe.boundary_from_snapshot(observe.snapshot(w, w.device, w.start))


class Clock:
    def __init__(self, now):
        self.now = now

    def __call__(self):
        return self.now

    def sleep(self, seconds):
        self.now += seconds


class Claim:
    def __init__(self):
        self.calls: list[tuple[str, float]] = []

    def __call__(self, run_id, now):
        self.calls.append((run_id, now))


def run_observe(w: World, boundary: dict[str, str], *, window=120, clock_start=None, marker=None, run=RUN, main=MAIN, runner=RUNNER_SHA, work=WORK, evidence=EVIDENCE,
                claim=None, device=None):
    clock = Clock(w.start + 1.0 if clock_start is None else clock_start)
    w.now = clock.now

    def tick(seconds):
        clock.sleep(seconds)
        w.now = clock.now

    return observe.observe(w, marker if marker is not None else marker_text(boundary), device or w.device, run, window, expected_main=main, runner_sha256=runner,
                           work_dir=work, evidence_dir=evidence, claim=claim or Claim(), clock=clock, sleep=tick)


def good_world(count=4, first_offset=30.0, gap=30.0):
    w = World()
    b = pre_boundary(w)
    w.periodic(w.start + first_offset, count, gap)
    w.doc["updated_at"] = w.start + 100.0
    return w, b


# ---------------------------------------------------------------------------------------------- git fixtures (synthetic history)

L8_FIELDS = (
    "L8_LIVE=CLOSED_PASS", "L8_LIVE_EXECUTED=YES", "L8_RESULT=PASS", "L8_ATTEMPT_CONSUMED=YES", "L8_RERUN_ALLOWED=NO",
    "L8_STAGE=L8", "L8_FAILURE_RESULT=NONE", "L8_EVIDENCE_CLASS=LIVE_HARDWARE", "L9_LIVE_EXECUTED=NO", "L9_ATTEMPT_CONSUMED=NO",
)


class Repo:
    def __init__(self, path: Path) -> None:
        self.path = path
        path.mkdir(parents=True)
        self.git("init", "-q", "-b", "main")
        self.git("config", "user.email", "t@example.invalid")
        self.git("config", "user.name", "t")
        self.git("config", "commit.gpgsign", "false")
        self.n = 0

    def git(self, *args: str) -> str:
        env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
        done = subprocess.run(["git", "-C", str(self.path), *args], capture_output=True, text=True, env=env, check=False)
        assert done.returncode == 0, done.stderr
        return done.stdout.strip()

    def write(self, rel: str, text: str, mode: int | None = None) -> None:
        target = self.path / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text)
        if mode is not None:
            target.chmod(mode)

    def commit(self, message: str = "c") -> str:
        self.n += 1
        self.git("add", "-A")
        self.git("commit", "-q", "--allow-empty", "-m", f"{message} {self.n}")
        return self.git("rev-parse", "HEAD")

    def receipt(self, name: str, fields, extra: str = "") -> str:
        rel = f"{LOGS_REL}/{name}"
        self.write(rel, "# receipt\n\n" + "".join(f"- `{f}`\n" for f in fields) + extra)
        return rel


def valid_l8(tmp_path: Path):
    repo = Repo(tmp_path / "repo")
    repo.receipt("2026-10-01_000000_music_idea3-old.md", ["L8_ACCEPTANCE=NO", "L9_PROVEN=NO"], "L8=NOT_RUN\n")
    repo.commit("base")
    execution = repo.commit("l8-execution-main")
    repo.receipt("2026-10-08_010000_music_idea3-l8-live-closeout.md", [*L8_FIELDS, f"L8_EXECUTION_MAIN={execution}"])
    main = repo.commit("l8-closeout")
    return repo, execution, main
