"""Shared hermetic helpers for the Recovery R2-R8 stage tests.

Nothing here runs Recovery, touches Production, a socket, nft, MQTT, a service or an ESP32. The privilege prefix is empty (the test user owns the fixtures), the canonical governance directory is a TEST-ONLY
seam under a temporary directory, and every privileged-looking program is a PATH stub that only records its call."""

from __future__ import annotations

import hashlib
import os
import re
import shutil
import sqlite3
import subprocess
import sys
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
P4 = ROOT / "deploy/pr11-phase4"
STG = P4 / "stages/Recovery"
LIB = P4 / "p4-recovery-run-lib.sh"
P4_LIB = P4 / "p4-lib.sh"
RUNNER = P4 / "owner-run/run-recovery-owner.sh"
SNAPSHOT_TOOL = P4 / "recovery-acceptance/recovery_verifier_snapshot.py"
FREEZE_TOOL = P4 / "recovery-acceptance/recovery_runner_freeze.py"
LOGS = "Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs"
RELEASE = "912b18005bb2fc80bb4e8d1fe8aa88803ac27314"
RECOVERY_FILES = [STG / "apply.sh", STG / "verify.sh", STG / "rollback.sh", LIB, RUNNER]
IP = "203.0.113.9"


def bash(script: str, *, env: dict[str, str] | None = None, cwd: Path | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["bash", "-c", script], env={**os.environ, **(env or {})}, text=True, capture_output=True, cwd=cwd, check=False)


def code_lines(path: Path) -> list[str]:
    """Executable lines only (comments and blank lines dropped) for the static forbidden-action audit."""
    return [line for line in path.read_text().splitlines() if line.strip() and not line.lstrip().startswith("#")]


def userns_usable() -> bool:
    return bool(shutil.which("unshare")) and subprocess.run(["unshare", "-r", "true"], capture_output=True).returncode == 0


def userns_bash(script: str) -> subprocess.CompletedProcess[str]:
    """bash as (user-namespace) root: the invoking user's files appear as uid 0, so the PRODUCTION owner uid 0 is exercised for real."""
    return subprocess.run(["unshare", "-r", "bash", "-c", script], env=os.environ, text=True, capture_output=True)


def load_tool(path: Path, name: str):
    spec = spec_from_file_location(name, path)
    tool = module_from_spec(spec)
    sys.modules[name] = tool
    spec.loader.exec_module(tool)
    return tool


def stages() -> list[str]:
    text = P4_LIB.read_text()
    return next(line for line in text.splitlines() if line.startswith("readonly P4_STAGES=")).split('"')[1].split()


def seam(tmp_path: Path, name: str = "canon") -> str:
    """Shell prefix pointing the TEST-ONLY canonical-governance seam (and its trust-root stop) at a temporary directory; the real /var/lib path is never touched by tests."""
    return (f'export RECOVERY_TEST_ONLY_CANONICAL_DIR_ENABLED=YES RECOVERY_TEST_ONLY_CANONICAL_DIR="{tmp_path / name}" RECOVERY_TEST_ONLY_TRUST_ROOT="{tmp_path}"\n'
            f'chmod 700 "{tmp_path}"\n')


def runner_function(name: str) -> str:
    text = RUNNER.read_text()
    start = text.index(f"{name}() {{")
    return text[start:text.index("\n}\n", start) + 3]


# --------------------------------------------------------------------------- git / snapshot worlds


def git(repo: Path, *args: str) -> None:
    subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True)


def head_of(repo: Path) -> str:
    return subprocess.run(["git", "-C", str(repo), "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()


def commit_all(repo: Path) -> str:
    for cmd in (["config", "user.email", "t@e.invalid"], ["config", "user.name", "t"], ["add", "-A"], ["commit", "-q", "-m", "x", "--allow-empty"]):
        git(repo, *cmd)
    return head_of(repo)


def make_control_snapshot(tmp_path: Path, src: Path | None = None) -> tuple[Path, str]:
    """A real read-only CONTROL snapshot (manifested copy of deploy/pr11-phase4) built by the pinned tool, plus its manifest digest."""
    tool = load_tool(SNAPSHOT_TOOL, "recovery_snapshot_tool_ctl")
    dest = tmp_path / "control-snapshot"
    return dest, tool.control_snapshot(src or P4, dest)


def control_world(tmp_path: Path) -> tuple[Path, Path, str, str]:
    repo = tmp_path / "repo"
    src = repo / "IDEA3-AEGIS_Lockdown/deploy/pr11-phase4"
    shutil.copytree(P4, src, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    subprocess.run(["git", "-C", str(repo), "init", "-q"], check=True)
    head = commit_all(repo)
    dest, sha = make_control_snapshot(tmp_path, src)
    return repo, dest, sha, head


def make_snapshot(tmp_path: Path) -> tuple[Path, str]:
    """A real read-only verifier snapshot of the repository's own aegis_soc closure, plus its manifest digest."""
    tool = load_tool(SNAPSHOT_TOOL, "recovery_snapshot_tool")
    dest = tmp_path / "verifier-snapshot"
    return dest, tool.snapshot(ROOT, dest)


def unlock(dest: Path) -> None:
    for path in [dest, *dest.rglob("*")]:
        if not path.is_symlink():
            path.chmod(path.stat().st_mode | 0o200)


def relock(dest: Path) -> None:
    for path in [dest, *dest.rglob("*")]:
        if not path.is_symlink():
            path.chmod(path.stat().st_mode & ~0o222)


PINS = {
    "EXPECTED_MAIN": "a" * 40, "OPERATOR_USER": "owner", "OPERATOR_UID": "1000", "RELEASE_ID": RELEASE, "PRODUCTION_DETECTOR_SHA256": "b" * 64, "DETECTOR_UNIT_SHA256": "c" * 64,
    "RECOVERY_CORE_SHA256": "d" * 64, "RESTORE_CLI_SHA256": "e" * 64, "VERIFIER_MANIFEST_SHA256": "f" * 64, "VERIFIER_SNAPSHOT_DIR": "/opt/x/verifier", "CONTROL_MANIFEST_SHA256": "9" * 64,
    "CONTROL_SNAPSHOT_DIR": "/opt/x/control", "R1I_TOOL_SHA256": "8" * 64, "PROTOCOL_DB": "/var/lib/x/protocol.db", "AUDIT_DB": "/var/lib/x/audit.db", "R1B_EVIDENCE_DIR": "/var/lib/x/r1b",
    "EXPECTED_SOURCE_IP": IP, "DETECTOR_UID": "948", "RUNTIME_DIR": "/run/x",
}


def pinned_copy(tmp_path: Path, repo: Path | None = None, real_constants: bool = False, **override: str) -> Path:
    """A TEST COPY of the runner template with pins substituted (and, unless ``real_constants``, its two LITERAL ownership constants; the committed template pins uid 0 and `/`, asserted separately)."""
    text = RUNNER.read_text()
    for key, value in {**PINS, **override}.items():
        text = re.sub(rf"^{key}=PIN_\w+$", f"{key}={value}", text, flags=re.M)
    text = text.replace("PIN_PYTHON_BIN", "/usr/bin/python3").replace("/home/PIN_OPERATOR_HOME/PIN_PINNED_WORKTREE_NOT_A_REAL_PATH", str(repo or ROOT.parent))
    text = text.replace("EVID_ROOT=/PIN_EVIDENCE_ROOT", f"EVID_ROOT={tmp_path}/evidence")
    if not real_constants:
        text = re.sub(r"^SNAPSHOT_OWNER_UID=0$", f"SNAPSHOT_OWNER_UID={os.getuid()}", text, flags=re.M)
        text = re.sub(r"^SNAPSHOT_TRUST_ROOT=/$", f"SNAPSHOT_TRUST_ROOT={tmp_path}", text, flags=re.M)
    path = tmp_path / "frozen.sh"
    path.write_text(text)
    return path


# --------------------------------------------------------------------------- root handler (apply.sh / verify.sh) fixtures


def write_baseline_app(tmp_path: Path, modules: tuple[str, ...] | None = None) -> tuple[Path, str]:
    """A tiny verifier snapshot (the module closure the handler requires, empty files) carrying a manifest the handler can verify; the interpreter is a recording stub."""
    app = tmp_path / "app"
    (app / "aegis_soc").mkdir(parents=True)
    names = modules or ("__init__", "recovery_stage", "recovery_evidence", "recovery_client", "recovery_protocol", "local_restore", "ip_containment", "r1_acceptance", "r1bv_validation", "historical_disposition")
    for name in names:
        (app / f"aegis_soc/{name}.py").write_text("")
    lines = "".join(f"{hashlib.sha256((app / f'aegis_soc/{n}.py').read_bytes()).hexdigest()}  aegis_soc/{n}.py\n" for n in sorted(names))
    (app / "RECOVERY-VERIFIER-SHA256SUMS").write_text(lines)
    manifest_sha = hashlib.sha256(lines.encode()).hexdigest()
    for path in app.rglob("*"):
        path.chmod(0o555 if path.is_dir() else 0o444)
    app.chmod(0o555)
    return app, manifest_sha


def apply_env(tmp_path: Path, app: Path, manifest_sha: str, step: str = "FINAL", fake_py: Path | None = None) -> dict[str, str]:
    work = tmp_path / "work"
    work.mkdir(mode=0o700, exist_ok=True)
    work.chmod(0o700)
    (tmp_path / "audit.db").write_text("")
    (tmp_path / "protocol.db").write_text("")
    (tmp_path / "r1b-baseline.json").write_text("{}")
    fake = fake_py or tmp_path / "fakepy"
    if not fake.exists():
        fake.write_text(f'#!/bin/sh\necho "$@" >> "{tmp_path / "calls.txt"}"\npwd >> "{tmp_path / "cwd.txt"}"\nexit 2\n')
        fake.chmod(0o755)
    return {"AEGIS_RCVSTAGE_LIVE_AUTHORIZED": "YES", "AEGIS_RCVSTAGE_WORK_DIR": str(work), "AEGIS_RCVSTAGE_STEP": step, "AEGIS_RCVSTAGE_APP_DIR": str(app),
            "AEGIS_RCVSTAGE_VERIFIER_MANIFEST_SHA256": manifest_sha, "AEGIS_RCVSTAGE_AUDIT_DB": str(tmp_path / "audit.db"), "AEGIS_RCVSTAGE_PROTOCOL_DB": str(tmp_path / "protocol.db"),
            "AEGIS_RCVSTAGE_ATTEMPT_MARKER": str(tmp_path / "canon/RECOVERY-GLOBAL-ATTEMPT-CONSUMED"), "AEGIS_RCVSTAGE_EXPECTED_SOURCE_IP": IP, "AEGIS_RCVSTAGE_DETECTOR_UID": "948",
            "AEGIS_RCVSTAGE_R1B_BASELINE": str(tmp_path / "r1b-baseline.json"), "AEGIS_PYTHON_BIN": str(fake)}


def handler_copy(env: dict[str, str], script: str = "apply.sh", owner_uid: int = 0, trust_root: Path | None = None, name: str | None = None) -> Path:
    """A TEST COPY of a handler with its two LITERAL ownership constants substituted (the committed handlers pin uid 0 and `/`; asserted separately)."""
    app = Path(env["AEGIS_RCVSTAGE_APP_DIR"])
    text = (STG / script).read_text()
    text = re.sub(r"^SNAPSHOT_OWNER_UID=0$", f"SNAPSHOT_OWNER_UID={owner_uid}", text, flags=re.M)
    text = re.sub(r"^SNAPSHOT_TRUST_ROOT=/$", f"SNAPSHOT_TRUST_ROOT={trust_root or app.parent}", text, flags=re.M)
    path = app.parent / (name or f"{script}.copy")
    path.write_text(text)
    return path


def run_handler(env: dict[str, str], script: Path | None = None) -> subprocess.CompletedProcess[str]:
    """Runs the handler as (user-namespace) root: files owned by the invoking user appear as uid 0, so the production owner uid 0 is exercised for real."""
    return subprocess.run(["unshare", "-r", "bash", str(script or handler_copy(env))], env={**os.environ, **env}, text=True, capture_output=True)


# --------------------------------------------------------------------------- Core evidence fixtures (hash-chained audit store + protocol store)


MSG = "ab" * 16
BASE_AUDIT_ID = 3  # rows <= this id are the pre-existing R1B evidence (ALERT_ACCEPTED, INCIDENT_BOUND, ...)


def chain(path: Path) -> None:
    """A VALID audit hash chain over the fixture rows with the repository's own hash function."""
    from aegis_soc import database as db

    conn = sqlite3.connect(path)
    previous = "GENESIS"
    for row_id, timestamp, level, event_type, details in conn.execute("SELECT id, timestamp, level, event_type, details FROM audit_logs ORDER BY id").fetchall():
        previous = db._compute_hash(timestamp, level, event_type, details, previous)
        conn.execute("UPDATE audit_logs SET hash = ? WHERE id = ?", (previous, row_id))
    conn.commit()
    conn.close()


class Evidence:
    """A configurable Core evidence fixture. Defaults are the COMPLETE, genuinely closed Recovery attempt; each ``drop``/``change`` yields one adverse case."""

    def __init__(self, tmp_path: Path, *, stamp: str = "2026-10-06 10:00:10"):
        self.dir = tmp_path
        self.stamp = stamp
        self.drop: set[str] = set()
        self.extra: list[tuple[str, str]] = []
        self.state = "CLOSED"
        self.command: dict | None = {"state": "ACK_CONSUMED", "published_at": 1.0, "ack_result": "ACCEPTED", "status_correlated": 1}
        self.r3 = f"result=VERIFIED ip={IP} reason=READ_BACK_CONFIRMED"
        self.corrupt_chain = False
        self.second_incident = False

    @property
    def audit(self) -> Path:
        return self.dir / "audit.sqlite3"

    @property
    def protocol(self) -> Path:
        return self.dir / "protocol.sqlite3"

    def build(self) -> None:
        from aegis_soc.protocol_store import ProtocolStore

        for stale in (self.audit, self.protocol):
            stale.unlink(missing_ok=True)
        conn = sqlite3.connect(self.audit)
        conn.executescript(
            "CREATE TABLE audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT, level TEXT DEFAULT 'INFO', event_type TEXT, details TEXT, incident_id INTEGER, hash TEXT);"
            "CREATE TABLE incidents (id INTEGER PRIMARY KEY AUTOINCREMENT, opened_at TEXT, closed_at TEXT, state TEXT DEFAULT 'OPEN', attacker_ip TEXT, summary TEXT);")
        closed = "2026-10-06 10:05:00" if self.state == "CLOSED" else None
        conn.execute("INSERT INTO incidents (opened_at, closed_at, state, attacker_ip) VALUES ('2026-10-06 09:00:00', ?, ?, ?)", (closed, self.state, IP))
        if self.second_incident:
            conn.execute("INSERT INTO incidents (opened_at, state, attacker_ip) VALUES ('2026-10-06 10:01:00', 'OPEN', '198.51.100.7')")
        rows = [("2026-10-06 09:00:01", "ALERT_ACCEPTED", f"uid=948 pid=1 attacker_ip={IP} action=CREATED"), ("2026-10-06 09:00:01", "INCIDENT_BOUND", f"attacker_ip={IP} source=detector_alert action=CREATED"),
                ("2026-10-06 09:00:02", "R1B_NOTE", "pre-existing")]
        assert len(rows) == BASE_AUDIT_ID
        events = [("RECOVERY_R3_REQUESTED", f"ip={IP}"), ("RECOVERY_R3_RESULT", self.r3), ("RESTORE_REQUESTED", "reason=owner"), ("RESTORE_PUBLISHED", f"msg_id={MSG} seq=1"),
                  ("RECOVERY_R8_CLOSE", "summary=done"), ("INCIDENT_CLOSED", "done")]
        for kind, details in events:
            if kind not in self.drop:
                rows.append((self.stamp, kind, details))
        rows += [(self.stamp, kind, details) for kind, details in self.extra]
        for stamp, kind, details in rows:
            conn.execute("INSERT INTO audit_logs (timestamp, event_type, details, incident_id) VALUES (?, ?, ?, 1)", (stamp, kind, details))
        conn.commit()
        conn.close()
        chain(self.audit)
        if self.corrupt_chain:
            conn = sqlite3.connect(self.audit)
            conn.execute("UPDATE audit_logs SET details = details || ' ' WHERE id = 3")
            conn.commit()
            conn.close()
        store = ProtocolStore(self.protocol)
        store.close()
        if self.command is not None:
            row = {"msg_id": MSG, "device_id": "esp32-01", "seq": 1, "action": "RESTORE_UPLINK", "issued_at": 1, "expires_at": 2, "reserved_at": 0.5, **self.command}
            conn = sqlite3.connect(self.protocol)
            conn.execute(f"INSERT INTO protocol_commands ({','.join(row)}) VALUES ({','.join('?' * len(row))})", tuple(row.values()))
            conn.commit()
            conn.close()


def baseline_doc(**patch) -> dict:
    doc = {"schema": "aegis.idea3.recovery-baseline/1", "incident_id": 1, "attacker_ip": IP, "audit_max_id": BASE_AUDIT_ID, "incident_max_id": 1, "checks": {}}
    doc.update(patch)
    return doc


def nft_text(*elements: str, extra_rule: str = "") -> str:
    """The `nft --stateless list table inet aegis_idea3` text with the given blocked_ipv4 elements."""
    elems = f"\t\telements = {{ {', '.join(elements)} }}\n" if elements else ""
    return ("table inet aegis_idea3 {\n\tset blocked_ipv4 {\n\t\ttype ipv4_addr\n" + elems + "\t}\n\tchain input {\n\t\ttype filter hook input priority filter; policy accept;\n"
            "\t\tip saddr @blocked_ipv4 drop\n" + extra_rule + "\t}\n}\n")


import pytest  # noqa: E402

needs_userns = pytest.mark.skipif(not userns_usable(), reason="user namespace unavailable")


def trust_seam(trust_root: Path) -> str:
    return f'export RECOVERY_TEST_ONLY_SNAPSHOT_TRUST_ENABLED=YES RECOVERY_TEST_ONLY_SNAPSHOT_TRUST_ROOT="{trust_root}"\n'


def authority_tools(tmp_path: Path) -> Path:
    """A COPY of the two freeze tools (one directory, siblings together) inside the trusted temp tree: privileged root-owned runs must execute tool bytes that sit under trusted, root-owned ancestors."""
    dest = tmp_path / "authority-tools"
    if not dest.exists():
        dest.mkdir()
        shutil.copy(SNAPSHOT_TOOL, dest / "recovery_verifier_snapshot.py")
        shutil.copy(FREEZE_TOOL, dest / "recovery_runner_freeze.py")
    return dest


def copy_verifier_src(tmp_path: Path) -> Path:
    """A trusted COPY of the verifier source (the `aegis_soc` package) for root-owned `snapshot` builds."""
    dest = tmp_path / "src-verifier"
    if not dest.exists():
        shutil.copytree(ROOT / "aegis_soc", dest / "aegis_soc", ignore=shutil.ignore_patterns("__pycache__"))
    return dest


def copy_control_src(tmp_path: Path) -> Path:
    """A trusted COPY of the control-plane tree for root-owned `control-snapshot` builds."""
    dest = tmp_path / "src-control"
    if not dest.exists():
        shutil.copytree(P4, dest, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    return dest
