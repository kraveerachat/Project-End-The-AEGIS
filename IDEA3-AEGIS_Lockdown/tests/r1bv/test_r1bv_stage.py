"""Shared HELPER module for the R1Bv tests (fixtures adapted from the R1D helpers: snapshot/control-world builders, user-namespace runners, the runner-template path). The R1Bv contract tests live in test_r1bv_contract.py.
Hermetic: no network, no Production database, no systemctl mutation, no journal write."""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
P4 = ROOT / "deploy/pr11-phase4"
STG = P4 / "stages/R1Bv"
LIB = P4 / "p4-r1bv-run-lib.sh"
P4_LIB = P4 / "p4-lib.sh"
RUNNER = P4 / "owner-run/run-r1bv-owner.sh"
LOGS = "Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs"
R1BV_FILES = [STG / "apply.sh", STG / "verify.sh", STG / "rollback.sh", LIB, RUNNER]

F1_RECEIPT = f"{LOGS}/2026-10-04_233030_music_idea3-f1-attempt2-live-closeout.md"
FOUNDATION = f"{LOGS}/2026-10-05_005444_music_idea3-r1-real-detector-acceptance.md"
F1U_RECEIPT = f"{LOGS}/2026-10-05_041108_music_idea3-f1u-live-closeout.md"
R1A_FAIL_RECEIPT = f"{LOGS}/2026-10-05_232827_music_idea3-r1a-live-failure-closeout.md"
R1DU_RECEIPT = f"{LOGS}/2026-10-06_120000_music_idea3-r1du-live-closeout.md"
R1I_RECEIPT = f"{LOGS}/2026-10-05_063546_music_idea3-r1i-live-closeout.md"
RELEASE = "912b18005bb2fc80bb4e8d1fe8aa88803ac27314"


def bash(script: str, *, env: dict[str, str] | None = None, cwd: Path | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["bash", "-c", script], env={**os.environ, **(env or {})}, text=True, capture_output=True, cwd=cwd, check=False)


def code_lines(path: Path) -> list[str]:
    """Executable lines only (comments and blank lines dropped) for the static forbidden-action audit."""
    return [line for line in path.read_text().splitlines() if line.strip() and not line.lstrip().startswith("#")]


# --------------------------------------------------------------------------- registration


def stages() -> list[str]:
    text = P4_LIB.read_text()
    return next(line for line in text.splitlines() if line.startswith("readonly P4_STAGES=")).split('"')[1].split()


# --------------------------------------------------------------------------- owner runner (inert template)


SNAPSHOT_TOOL_PATH = P4 / "r1bv-acceptance/r1bv_verifier_snapshot.py"


def make_control_snapshot(tmp_path: Path, src: Path | None = None) -> tuple[Path, str]:
    """A real read-only CONTROL snapshot (manifested copy of deploy/pr11-phase4) built by the pinned tool, plus its manifest digest."""
    from importlib.util import module_from_spec, spec_from_file_location

    spec = spec_from_file_location("r1bv_snapshot_tool_ctl", SNAPSHOT_TOOL_PATH)
    tool = module_from_spec(spec)
    sys.modules["r1bv_snapshot_tool_ctl"] = tool
    spec.loader.exec_module(tool)
    dest = tmp_path / "control-snapshot"
    return dest, tool.control_snapshot(src or P4, dest)


def pinned_copy(tmp_path: Path, repo: Path | None = None, real_constants: bool = False, **override: str) -> Path:
    pins = {
        "EXPECTED_MAIN": "a" * 40, "OPERATOR_USER": "owner", "OPERATOR_UID": "1000", "RELEASE_ID": RELEASE, "PRODUCTION_DETECTOR_SHA256": "b" * 64,
        "DETECTOR_UNIT_SHA256": "c" * 64, "RECOVERY_CORE_SHA256": "d" * 64, "VERIFIER_MANIFEST_SHA256": "e" * 64, "VERIFIER_SNAPSHOT_DIR": "/opt/x/verifier", "CONTROL_MANIFEST_SHA256": "9" * 64, "CONTROL_SNAPSHOT_DIR": "/opt/x/control",
        "R1I_TOOL_SHA256": "f" * 64,
        "AUDIT_DB": "/var/lib/x/audit.db", "DETECTOR_UID": "948", "EXPECTED_SOURCE_IP": "203.0.113.50", "R1B_EVIDENCE_DIR": "/srv/evidence/r1b-run", "R1B_AUTH_DIR": "/srv/auth/r1b", **override,
    }
    text = RUNNER.read_text()
    for key, value in pins.items():
        text = re.sub(rf"^{key}=PIN_\w+$", f"{key}={value}", text, flags=re.M)
    text = text.replace("PIN_PYTHON_BIN", "/usr/bin/python3").replace("/home/PIN_OPERATOR_HOME/PIN_PINNED_WORKTREE_NOT_A_REAL_PATH", str(repo or ROOT.parent))
    text = text.replace("/PIN_EVIDENCE_ROOT/", f"{tmp_path}/evidence/")
    if not real_constants:  # a TEST COPY substitutes its own ownership constants (the committed template pins uid 0 and `/`; asserted separately)
        text = re.sub(r"^SNAPSHOT_OWNER_UID=0$", f"SNAPSHOT_OWNER_UID={os.getuid()}", text, flags=re.M)
        text = re.sub(r"^SNAPSHOT_TRUST_ROOT=/$", f"SNAPSHOT_TRUST_ROOT={tmp_path}", text, flags=re.M)
    path = tmp_path / "frozen.sh"
    path.write_text(text)
    return path


# --------------------------------------------------------------------------- predecessor receipt gates


def git(repo: Path, *args: str) -> None:
    subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True)


def receipt_repo(tmp_path: Path, **change: str | None) -> Path:
    repo = tmp_path / "repo"
    files = {
        F1_RECEIPT: "- `F1_LIVE_RESULT=PASS`\n- `F1_PRODUCTION_DEPLOYED=YES`\n- `F1_DETECTOR_STARTED=YES`\n",
        FOUNDATION: "- `R1_EVIDENCE_VERIFIER_IMPLEMENTED=YES`\n- `F1_REAL_DETECTOR_ACCEPTANCE=NOT_PROVEN`\n- `R1_VERIFIED=NOT_CLAIMED`\n",
        F1U_RECEIPT: f"release `{RELEASE}` was installed and activated.\nF1u proves deployment only.\n",
        R1I_RECEIPT: "\n".join(f"- `{x}`" for x in (
            "R1I_LIVE=CLOSED_PASS", "R1I_LIVE_EXECUTED=YES", "R1I_PRODUCTION_DEPLOYED=YES", "R1I_ATTEMPT_CONSUMED=YES", "R1I_RERUN_ALLOWED=NO",
            "PRODUCTION_NFT_NORMALIZATION=PASS_OBSERVED_LIVE", "F1_REAL_DETECTOR_ACCEPTANCE=NOT_PROVEN", "R1_VERIFIED=NOT_CLAIMED")) + "\n",
    }
    files[R1DU_RECEIPT] = "\n".join(f"- `{x}`" for x in (
        "R1DU_LIVE=CLOSED_PASS", "R1DU_LIVE_EXECUTED=YES", "R1DU_PRODUCTION_DEPLOYED=YES", "R1DU_ATTEMPT_CONSUMED=YES", "R1DU_RERUN_ALLOWED=NO", f"R1DU_RELEASE_ID={RELEASE}",
        "R1DU_R1D_EXECUTED=NO", "R1DU_INCIDENT_MUTATED=NO", "F1_REAL_DETECTOR_ACCEPTANCE=NOT_PROVEN", "R1_VERIFIED=NOT_CLAIMED", "RECOVERY_R2_R8_EXECUTED=NO")) + "\n"
    files[R1A_FAIL_RECEIPT] = "\n".join(f"- `{x}`" for x in (
        "R1A_LIVE_EXECUTED=YES", "R1A_ATTEMPT_CONSUMED=YES", "R1A_RERUN_ALLOWED=NO", "R1A_RESULT=FAIL", "R1A_STAGE_VERIFY=NOT_REACHED",
        "F1_REAL_DETECTOR_ACCEPTANCE=NOT_PROVEN", "R1_VERIFIED=NOT_CLAIMED", "RECOVERY_R2_R8_EXECUTED=NO")) + "\n"
    for key, value in change.items():
        if value is None:
            files.pop(key, None)
        else:
            files[key] = value
    repo.mkdir()
    git(repo, "init", "-q")
    git(repo, "config", "user.email", "t@example.invalid")
    git(repo, "config", "user.name", "t")
    for rel, text in files.items():
        target = repo / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text)
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "x", "--allow-empty")
    return repo


def head_of(repo: Path) -> str:
    return subprocess.run(["git", "-C", str(repo), "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()


def gate(repo: Path) -> subprocess.CompletedProcess[str]:
    return bash(f'. "{LIB}"; r1bv_receipt_gate "{repo}" {RELEASE} {head_of(repo)}')


# --------------------------------------------------------------------------- one-attempt state machine


def seam(tmp_path: Path, name: str = "canon") -> str:
    """Shell prefix that points the TEST-ONLY canonical-marker seam at a temporary directory (the real path is root-owned under /var/lib and never touched by tests)."""
    return f'export R1BV_TEST_ONLY_CANONICAL_DIR_ENABLED=YES R1BV_TEST_ONLY_CANONICAL_DIR="{tmp_path / name}"\n'


HOOKS = """
LOGF="$1"
mark() { echo "$1" >> "$LOGF"; }
r1bv_hook_pregates() { mark pregates; [ "${FAIL_AT:-}" != pregates ]; }
r1bv_hook_baseline() { mark baseline; [ "${FAIL_AT:-}" != baseline ]; }
r1bv_hook_regate() { mark regate; [ "${FAIL_AT:-}" != regate ]; }
r1bv_hook_dispose() { mark "dispose:marker=$([ -e "$AUTH/R1BV-ATTEMPT-CONSUMED" ] && echo yes || echo no)"; [ "${FAIL_AT:-}" != dispose ]; }
r1bv_hook_final() { mark final; [ "${FAIL_AT:-}" != final ]; }
r1bv_hook_verify() { mark verify; [ "${FAIL_AT:-}" != verify ]; }
r1bv_hook_preserve_evidence() { mark "preserve:$1"; }
"""


def attempt(tmp_path: Path, fail_at: str = "", auth_name: str = "auth", canon_name: str = "canon") -> tuple[subprocess.CompletedProcess[str], list[str]]:
    auth = tmp_path / auth_name
    auth.mkdir(exist_ok=True)
    (tmp_path / canon_name).mkdir(mode=0o700, exist_ok=True)  # R1A created the governance directory; R1BV never creates it
    log = tmp_path / "hooks.log"
    script = f'AUTH="{auth}"\n{seam(tmp_path, canon_name)}. "{LIB}"\nSUDO=""\n{HOOKS}\nr1bv_run_attempt "$AUTH"\n'
    result = subprocess.run(["bash", "-c", script, "x", str(log)], env={**os.environ, "FAIL_AT": fail_at}, text=True, capture_output=True)
    return result, (log.read_text().split() if log.exists() else [])


# --------------------------------------------------------------------------- real-event boundary and self-audit


FORBIDDEN = [
    r"\bnmap\b", r"\bnc\b", r"\bnetcat\b", r"\bncat\b", r"\bcurl\b", r"\bwget\b", r"\bssh\b", r"\bsocat\b", r"\bscapy\b", r"\blogger\b", r"\bhping3?\b", r"\bping\b",
    r"/dev/(tcp|udp)", r"alert\.sock", r"\bsendto\b", r"\bsystemctl\s+(start|stop|restart|reload|kill|enable|disable|mask|daemon-reload|reset-failed)\b",
    r"\bnft\s+(add|delete|flush|insert|replace|create|-f|destroy)\b", r"\bINSERT\b", r"\bUPDATE\b", r"\bDELETE\b", r"\bsqlite3?\b", r"\bpython3?\s+-c\b.*\bsocket\b",
]


# --------------------------------------------------------------------------- handlers: evidence-preserving rollback, guarded apply, verify


def userns_usable() -> bool:
    return bool(shutil.which("unshare")) and subprocess.run(["unshare", "-r", "true"], capture_output=True).returncode == 0


SNAPSHOT_TOOL = P4 / "r1bv-acceptance/r1bv_verifier_snapshot.py"


def load_snapshot_tool():
    from importlib.util import module_from_spec, spec_from_file_location

    spec = spec_from_file_location("r1bv_snapshot_tool", SNAPSHOT_TOOL)
    tool = module_from_spec(spec)
    sys.modules["r1bv_snapshot_tool"] = tool
    spec.loader.exec_module(tool)
    return tool


def make_snapshot(tmp_path: Path) -> tuple[Path, str]:
    """A real read-only verifier snapshot of the repository's own aegis_soc closure, plus its manifest digest."""
    tool = load_snapshot_tool()
    dest = tmp_path / "verifier-snapshot"
    return dest, tool.snapshot(ROOT, dest)


def write_baseline_app(tmp_path: Path) -> tuple[Path, str]:
    """A tiny snapshot whose only job is to carry a manifest the apply handler can verify (the interpreter is a recording stub)."""
    app = tmp_path / "app"
    (app / "aegis_soc").mkdir(parents=True)
    (app / "aegis_soc/__init__.py").write_text("")
    (app / "aegis_soc/historical_disposition.py").write_text("")
    import hashlib

    lines = "".join(f"{hashlib.sha256((app / rel).read_bytes()).hexdigest()}  {rel}\n" for rel in ("aegis_soc/__init__.py", "aegis_soc/historical_disposition.py"))
    (app / "R1BV-VERIFIER-SHA256SUMS").write_text(lines)
    manifest_sha = hashlib.sha256(lines.encode()).hexdigest()
    for path in app.rglob("*"):
        path.chmod(0o555 if path.is_dir() else 0o444)
    app.chmod(0o555)
    return app, manifest_sha


def apply_env(tmp_path: Path, app: Path, manifest_sha: str, step: str = "FINAL") -> dict[str, str]:
    work = tmp_path / "work"
    work.mkdir(exist_ok=True)
    (work / "r1bv-baseline.json").write_text("{}")
    (tmp_path / "audit.db").write_text("")
    fake = tmp_path / "fakepy"
    if not fake.exists():
        fake.write_text(f'#!/bin/sh\necho "$@" >> "{tmp_path / "calls.txt"}"\npwd >> "{tmp_path / "cwd.txt"}"\nexit 2\n')
        fake.chmod(0o755)
    return {"AEGIS_R1BV_LIVE_AUTHORIZED": "YES", "AEGIS_R1BV_WORK_DIR": str(work), "AEGIS_R1BV_STEP": step, "AEGIS_R1BV_APP_DIR": str(app),
            "AEGIS_R1BV_VERIFIER_MANIFEST_SHA256": manifest_sha, "AEGIS_R1BV_AUDIT_DB": str(tmp_path / "audit.db"), "AEGIS_PYTHON_BIN": str(fake),
            "AEGIS_R1BV_EXPECTED_SOURCE_IP": "203.0.113.50", "AEGIS_R1BV_DETECTOR_UID": "948"}


def apply_copy(env: dict[str, str], owner_uid: int = 0, trust_root: Path | None = None, name: str = "apply_copy.sh") -> Path:
    """A TEST COPY of apply.sh with its two LITERAL ownership constants substituted (the committed handler pins uid 0 and `/`; asserted separately)."""
    app = Path(env["AEGIS_R1BV_APP_DIR"])
    text = (STG / "apply.sh").read_text()
    text = re.sub(r"^SNAPSHOT_OWNER_UID=0$", f"SNAPSHOT_OWNER_UID={owner_uid}", text, flags=re.M)
    text = re.sub(r"^SNAPSHOT_TRUST_ROOT=/$", f"SNAPSHOT_TRUST_ROOT={trust_root or app.parent}", text, flags=re.M)
    path = app.parent / name
    path.write_text(text)
    return path


def run_apply(env: dict[str, str], script: Path | None = None) -> subprocess.CompletedProcess[str]:
    """Runs the handler as (user-namespace) root: files owned by the invoking user appear as uid 0, so the production owner uid 0 is exercised for real."""
    return subprocess.run(["unshare", "-r", "bash", str(script or apply_copy(env))], env={**os.environ, **env}, text=True, capture_output=True)


def result_doc(**patch) -> dict:
    doc = {"schema": "aegis.idea3.r1-acceptance/1", "result": "PASS", "reason": "OK", "attacker_ip": "203.0.113.9",
           "checks": {"R1_EVIDENCE_VERIFIED": "YES", "REAL_DETECTOR_CHAIN_VERIFIED": "YES"},
           "claims": {"F1_REAL_DETECTOR_ACCEPTANCE": "NOT_PROVEN", "R1_VERIFIED": "NOT_CLAIMED", "RECOVERY_R1_R8_PROVEN": "NO"},
           "evidence_times": {"incident_opened_at": 1060.0, "alert_accepted_at": 1060.0, "detector_alert_at": 1060.4, "source_completed_at": [1059.9]}}
    doc.update(patch)
    return doc


def verify(tmp_path: Path, doc: dict, *, ip: str = "203.0.113.9", start: str = "1000.5", end: str = "1600.5") -> subprocess.CompletedProcess[str]:
    import json

    (tmp_path / "r1-result.json").write_text(json.dumps(doc))
    (tmp_path / "R1BV-FINAL-RAN").write_text("x")
    return bash(f'bash "{STG / "verify.sh"}"', env={"AEGIS_R1BV_WORK_DIR": str(tmp_path), "AEGIS_PYTHON_BIN": sys.executable, "AEGIS_R1BV_EXPECTED_SOURCE_IP": ip,
                                                    "AEGIS_R1BV_WINDOW_START": start, "AEGIS_R1BV_WINDOW_END": end})


# --- IMPORTANT 1: the pinned expected source IP is ENFORCED ---------------------------------------------------------------------------------------


# --- IMPORTANT 2: the acceptance window is bound to the marker ------------------------------------------------------------------------------------


# --- IMPORTANT 3: the verifier authority is an immutable, fully manifested snapshot -----------------------------------------------------------------


def repo_with_aegis_soc(tmp_path: Path) -> Path:
    repo = tmp_path / "repo"
    shutil.copytree(ROOT / "aegis_soc", repo / "IDEA3-AEGIS_Lockdown/aegis_soc", ignore=shutil.ignore_patterns("__pycache__"))
    git(repo, "init", "-q") if False else subprocess.run(["git", "-C", str(repo), "init", "-q"], check=True)
    for cmd in (["config", "user.email", "t@e.invalid"], ["config", "user.name", "t"], ["add", "-A"], ["commit", "-q", "-m", "x"]):
        subprocess.run(["git", "-C", str(repo), *cmd], check=True, capture_output=True)
    return repo


def userns_bash(script: str) -> subprocess.CompletedProcess[str]:
    """bash as (user-namespace) root: the invoking user's files appear as uid 0, so the PRODUCTION owner uid 0 is exercised for real."""
    return subprocess.run(["unshare", "-r", "bash", "-c", script], env=os.environ, text=True, capture_output=True)


def authority_tools(tmp_path: Path) -> Path:
    """A COPY of the two freeze tools (one directory, siblings together) inside the trusted temp tree: privileged root-owned runs must execute tool bytes that sit under trusted, root-owned ancestors (the
    production workflow runs them from the root-owned exact-main authority; inside a user namespace the temp tree's files appear as uid 0)."""
    dest = tmp_path / "authority-tools"
    if not dest.exists():
        dest.mkdir()
        shutil.copy(SNAPSHOT_TOOL, dest / "r1bv_verifier_snapshot.py")
        shutil.copy(P4 / "r1bv-acceptance/r1bv_runner_freeze.py", dest / "r1bv_runner_freeze.py")
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


def trust_seam(trust_root: Path) -> str:
    return f'export R1BV_TEST_ONLY_SNAPSHOT_TRUST_ENABLED=YES R1BV_TEST_ONLY_SNAPSHOT_TRUST_ROOT="{trust_root}"\n'


def verifier_gate(repo: Path, snap: Path, sha: str, detector: str, main: str | None = None) -> subprocess.CompletedProcess[str]:
    return userns_bash(f'{trust_seam(snap.parent)}. "{LIB}"; r1bv_verifier_gate "{snap}" {sha} "{repo}" {detector} "{SNAPSHOT_TOOL}" {main or head_of(repo)}')


# --- IMPORTANT 4: ONE attempt TOTAL, independent of the AUTH_DIR -----------------------------------------------------------------------------------


# --- IMPORTANT 1 (round 2): the window starts only AFTER the canonical marker exists ----------------------------------------------------------------


# --- round 3: audit-row semantics (documented granularity, NO post-deadline grace) ----------------------------------------------------------------


def times(opened: float, accepted: float, alert: float = 1000.9, source: float = 1000.7) -> dict:
    return {"incident_opened_at": opened, "alert_accepted_at": accepted, "detector_alert_at": alert, "source_completed_at": [source]}


# --- round 3 IMPORTANT 2: the window record is mandatory ------------------------------------------------------------------------------------------


def run_with_hooks(tmp_path: Path, observe_body: str) -> subprocess.CompletedProcess[str]:
    (tmp_path / "auth").mkdir(exist_ok=True)
    script = f'''AUTH="{tmp_path / "auth"}"; CANON="{tmp_path / "canon"}"; LOG="{tmp_path / "calls.log"}"; {seam(tmp_path)}. "{LIB}"; SUDO=""
r1bv_hook_pregates() {{ true; }}; r1bv_hook_baseline() {{ true; }}; r1bv_hook_regate() {{ true; }}
r1bv_hook_observe() {{ {observe_body}; }}
r1bv_hook_final() {{ echo FINAL_CALLED >> "$LOG"; }}; r1bv_hook_verify() {{ echo VERIFY_CALLED >> "$LOG"; }}; r1bv_hook_preserve_evidence() {{ echo "PRESERVE:$1" >> "$LOG"; }}
r1bv_run_attempt "$AUTH" 30; echo "rc=$?"
chmod 755 "$CANON" 2>/dev/null; r1bv_run_attempt "$AUTH" 30; echo "rerun_rc=$?"'''
    return bash(script)


# --- round 3 IMPORTANT 1: the shell control plane is an immutable manifested snapshot --------------------------------------------------------------


def runner_function(name: str) -> str:
    text = RUNNER.read_text()
    start = text.index(f"{name}() {{")
    return text[start:text.index("\n}\n", start) + 3]


def control_world(tmp_path: Path) -> tuple[Path, Path, str, str]:
    repo = tmp_path / "repo"
    src = repo / "IDEA3-AEGIS_Lockdown/deploy/pr11-phase4"
    shutil.copytree(P4, src, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    subprocess.run(["git", "-C", str(repo), "init", "-q"], check=True)
    for cmd in (["config", "user.email", "t@e.invalid"], ["config", "user.name", "t"], ["add", "-A"], ["commit", "-q", "-m", "x"]):
        subprocess.run(["git", "-C", str(repo), *cmd], check=True, capture_output=True)
    head = subprocess.run(["git", "-C", str(repo), "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
    dest, sha = make_control_snapshot(tmp_path, src)
    return repo, dest, sha, head


def gates(repo: Path, dest: Path, sha: str, head: str) -> subprocess.CompletedProcess[str]:
    script = (f'CTRL="{dest}"; CONTROL_MANIFEST_SHA256={sha}; REPO="{repo}"; EXPECTED_MAIN={head}; GIT_P4_REL=IDEA3-AEGIS_Lockdown/deploy/pr11-phase4; SNAPSHOT_OWNER_UID={os.getuid()}; SNAPSHOT_TRUST_ROOT="{dest.parent}"\n'
              f'{runner_function("control_gate")}\n{runner_function("control_git_gate")}\ncontrol_gate; echo "control=$?"; control_git_gate; echo "git=$?"\n')
    return bash(script)


def unlock(dest: Path) -> None:
    for path in [dest, *dest.rglob("*")]:
        if not path.is_symlink():
            path.chmod(path.stat().st_mode | 0o200)


def relock(dest: Path) -> None:
    for path in [dest, *dest.rglob("*")]:
        if not path.is_symlink():
            path.chmod(path.stat().st_mode & ~0o222)


# --- round 4: BOTH control gates are proven inline BEFORE the first source -----------------------------------------------------------------------


def code_lines_of(text: str) -> list[str]:
    return [line for line in text.splitlines() if line.strip() and not line.lstrip().startswith("#")]


# --- round 5 I2: git replace refs cannot change the bytes R1BV authority reads ----------------------------------------------------------------------


def run_git(repo: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["git", "-C", str(repo), *args], text=True, capture_output=True, check=check)


def replaced_world(tmp_path: Path) -> dict:
    """A repo whose pinned commit GOOD has been silently replaced by EVIL (`git replace GOOD EVIL`): the SHA GOOD is unchanged but plain Git resolves EVIL's bytes."""
    repo = tmp_path / "repo"
    src = repo / "IDEA3-AEGIS_Lockdown/deploy/pr11-phase4"
    shutil.copytree(P4, src, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    shutil.copytree(ROOT / "aegis_soc", repo / "IDEA3-AEGIS_Lockdown/aegis_soc", ignore=shutil.ignore_patterns("__pycache__"))
    receipts = repo / LOGS
    receipts.mkdir(parents=True, exist_ok=True)
    for rel, text in ((F1_RECEIPT, "- `F1_LIVE_RESULT=PASS`\n- `F1_PRODUCTION_DEPLOYED=YES`\n- `F1_DETECTOR_STARTED=YES`\n"),
                      (FOUNDATION, "- `R1_EVIDENCE_VERIFIER_IMPLEMENTED=YES`\n- `F1_REAL_DETECTOR_ACCEPTANCE=NOT_PROVEN`\n- `R1_VERIFIED=NOT_CLAIMED`\n"),
                      (F1U_RECEIPT, f"release `{RELEASE}` was installed and activated.\nF1u proves deployment only.\n"),
                      (R1DU_RECEIPT, "\n".join(f"- `{x}`" for x in ("R1DU_LIVE=CLOSED_PASS", "R1DU_LIVE_EXECUTED=YES", "R1DU_PRODUCTION_DEPLOYED=YES", "R1DU_ATTEMPT_CONSUMED=YES", "R1DU_RERUN_ALLOWED=NO",
                                                                    f"R1DU_RELEASE_ID={RELEASE}", "R1DU_R1D_EXECUTED=NO", "R1DU_INCIDENT_MUTATED=NO", "F1_REAL_DETECTOR_ACCEPTANCE=NOT_PROVEN", "R1_VERIFIED=NOT_CLAIMED",
                                                                    "RECOVERY_R2_R8_EXECUTED=NO")) + "\n"),
                      (R1A_FAIL_RECEIPT, "\n".join(f"- `{x}`" for x in ("R1A_LIVE_EXECUTED=YES", "R1A_ATTEMPT_CONSUMED=YES", "R1A_RERUN_ALLOWED=NO", "R1A_RESULT=FAIL", "R1A_STAGE_VERIFY=NOT_REACHED",
                                                                       "F1_REAL_DETECTOR_ACCEPTANCE=NOT_PROVEN", "R1_VERIFIED=NOT_CLAIMED", "RECOVERY_R2_R8_EXECUTED=NO")) + "\n")):
        (repo / rel).write_text(text)
    run_git(repo, "init", "-q")
    run_git(repo, "config", "user.email", "t@e.invalid")
    run_git(repo, "config", "user.name", "t")
    run_git(repo, "add", "-A")
    run_git(repo, "commit", "-q", "-m", "GOOD: the reviewed tree (no R1I closeout receipt)")
    good = run_git(repo, "rev-parse", "HEAD").stdout.strip()
    sentinel = tmp_path / "SENTINEL_SOURCED"
    lib = src / "p4-r1bv-run-lib.sh"
    lib.write_text(f'echo tampered-library-was-sourced > "{sentinel}"\n' + lib.read_text())
    dependency = repo / "IDEA3-AEGIS_Lockdown/aegis_soc/database.py"
    dependency.write_text(dependency.read_text() + "\n# EVIL change to a verifier dependency\n")
    (repo / R1I_RECEIPT).write_text("\n".join(f"- `{x}`" for x in (
        "R1I_LIVE=CLOSED_PASS", "R1I_LIVE_EXECUTED=YES", "R1I_PRODUCTION_DEPLOYED=YES", "R1I_ATTEMPT_CONSUMED=YES", "R1I_RERUN_ALLOWED=NO",
        "PRODUCTION_NFT_NORMALIZATION=PASS_OBSERVED_LIVE", "F1_REAL_DETECTOR_ACCEPTANCE=NOT_PROVEN", "R1_VERIFIED=NOT_CLAIMED")) + "\n")
    (repo / R1A_FAIL_RECEIPT).write_text("\n".join(f"- `{x}`" for x in (
        "R1A_LIVE_EXECUTED=YES", "R1A_ATTEMPT_CONSUMED=YES", "R1A_RERUN_ALLOWED=NO", "R1A_RESULT=FAIL", "R1A_STAGE_VERIFY=NOT_REACHED",
        "F1_REAL_DETECTOR_ACCEPTANCE=NOT_PROVEN", "R1_VERIFIED=NOT_CLAIMED", "RECOVERY_R2_R8_EXECUTED=NO")) + "\n")
    run_git(repo, "add", "-A")
    run_git(repo, "commit", "-q", "-m", "EVIL: altered library and a forged R1I closeout")
    evil = run_git(repo, "rev-parse", "HEAD").stdout.strip()
    evil_src = tmp_path / "evil-src"
    shutil.copytree(src, evil_src)
    evil_vsnap = tmp_path / "evil-verifier-snapshot"  # a self-consistent verifier snapshot built from the EVIL tree
    evil_vsha = load_snapshot_tool().snapshot(repo / "IDEA3-AEGIS_Lockdown", evil_vsnap)
    run_git(repo, "checkout", "-q", good)  # HEAD back on GOOD ...
    run_git(repo, "replace", good, evil)  # ... and GOOD silently replaced by EVIL
    return {"repo": repo, "good": good, "evil": evil, "evil_src": evil_src, "sentinel": sentinel, "evil_vsnap": evil_vsnap, "evil_vsha": evil_vsha}


# --- round 5 I1: snapshots must be ROOT-OWNED with trusted ancestors (read-only mode alone does not stop the owning uid) -----------------------------


needs_userns = pytest.mark.skipif(not userns_usable(), reason="user namespace unavailable")


def runner_gate_script(dest: Path, sha: str, owner: str, trust: str) -> str:
    return (f'CTRL="{dest}"; CONTROL_MANIFEST_SHA256={sha}; SNAPSHOT_OWNER_UID={owner}; SNAPSHOT_TRUST_ROOT="{trust}"\n'
            f'{runner_function("control_gate")}\ncontrol_gate; echo "control=$?"\n')


# --------------------------------------------------------------------------- evidence (existing fail-closed verifier is the authority)


EVIDENCE_COVERAGE = {
    "forged/userspace AEGIS_NEWCONN rejected": "test_forged_kernel_text_from_a_unit_or_syslog_is_refused",
    "wrong detector PID rejected": "test_journal_line_from_other_pid",
    "direct Core socket provenance rejected": "test_direct_socket_injection_other_pid_is_rejected",
    "missing ALERT_ACCEPTED rejected": "test_missing_core_alert_acceptance_proof",
    "missing INCIDENT_BOUND rejected": "test_missing_incident_bound",
    "ambiguous incidents rejected": "test_multiple_candidate_incidents",
    "wrong attacker IP rejected": "test_accepted_ip_differs_from_incident",
    "service restart / state drift rejected": "test_service_continuity",
    "narrow PASS never promotes": "test_one_real_event_passes_with_a_narrow_result_and_never_promotes",
    "no input can promote a claim": "test_no_input_or_flag_can_promote_a_live_claim",
    "baseline refuses a pre-existing open incident": "test_preexisting_open_incident_is_refused_at_baseline",
}


# --------------------------------------------------------------------------- claim boundary
