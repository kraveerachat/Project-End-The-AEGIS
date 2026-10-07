"""Shared hermetic helpers for the L8u (governed read-only L8 live acceptance) tests.

Nothing here runs L8u, touches Production, a serial port, MQTT, a service or an ESP32. The privilege prefix is empty (the test user owns the fixtures); the canonical governance directory is a
temporary directory behind the explicit test seam; Git repositories are throwaway repositories under tmp_path."""

from __future__ import annotations

import os
import subprocess
from importlib.util import module_from_spec, spec_from_file_location
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
P4 = ROOT / "deploy/pr11-phase4"
STG = P4 / "stages/L8u"
LIB = P4 / "p4-l8u-run-lib.sh"
RUNNER = P4 / "owner-run/run-l8u-owner.sh"
OBSERVE = P4 / "p4-l8u-observe.py"
PRED = P4 / "l8u-acceptance/l8u_predecessors.py"
FREEZE = P4 / "l8u-acceptance/l8u_runner_freeze.py"
SNAP = P4 / "l8u-acceptance/l8u_control_snapshot.py"
STAGE_GATE = P4 / "p4-stage-gate.sh"
LOGS = "Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs"
TEMPLATE_REL = "IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/owner-run/run-l8u-owner.sh"
L8P_REL = f"{LOGS}/2026-10-04_075127_music_idea3-l8p-attempt2-reconciliation-closeout.md"
LVR_REL = f"{LOGS}/2026-10-20_120000_music_idea3-lvr-live-closeout.md"
SHA = {c: c * 64 for c in "abcdef"}
MAC = "aa:bb:cc:dd:ee:01"

L8P_RECEIPT = "L8P_LIVE_EXECUTED=YES\nL8P_PROVISIONING=PASS\nLVR_PROVEN=NO\nL8_ACCEPTANCE=NO\n"


def lvr_receipt(execution_main: str, **override: str | None) -> str:
    fields = {
        "LVR_LIVE": "CLOSED_PASS", "LVR_LIVE_EXECUTED": "YES", "LVR_RESULT": "PASS", "LVR_PROVEN": "YES", "LVR_ATTEMPT_CONSUMED": "YES", "LVR_RERUN_ALLOWED": "NO",
        "RECOVERY_R2_R8_EXECUTED": "YES", "RECOVERY_RESULT": "PASS", "L8_ACCEPTANCE": "NO", "L9_PROVEN": "NO", "LVR_EXECUTION_MAIN": execution_main,
    }
    for key, value in override.items():
        if value is None:
            fields.pop(key, None)
        else:
            fields[key] = value
    return "".join(f"{k}={v}\n" for k, v in fields.items())


def bash(script: str, *, env: dict[str, str] | None = None, cwd: Path | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["bash", "-c", script], env={**os.environ, **(env or {})}, text=True, capture_output=True, cwd=cwd, check=False)


def git(repo: Path, *args: str) -> str:
    return subprocess.run(["git", "-C", str(repo), *args], text=True, capture_output=True, check=True).stdout.strip()


def commit(repo: Path, files: dict[str, str], message: str) -> str:
    for rel, text in files.items():
        path = repo / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", message)
    return git(repo, "rev-parse", "HEAD")


def new_repo(tmp: Path) -> Path:
    repo = tmp / "repo"
    repo.mkdir(parents=True)
    git(repo, "init", "-q")
    git(repo, "config", "user.email", "t@e.invalid")
    git(repo, "config", "user.name", "t")
    return repo


def world(tmp: Path, *, lvr: dict[str, str | None] | None = None, extra: dict[str, str] | None = None, with_l8p: bool = True) -> tuple[Path, str, str]:
    """A repository whose history is: [exec] L8p closeout + template  ->  [main] LVR closeout added (a DESCENDANT of the execution main). Returns (repo, exec_main, main)."""
    repo = new_repo(tmp)
    base = {TEMPLATE_REL: RUNNER.read_text()}
    if with_l8p:
        base[L8P_REL] = L8P_RECEIPT
    execution = commit(repo, base, "execution main")
    files = {LVR_REL: lvr_receipt(execution, **(lvr or {}))}
    files.update(extra or {})
    main = commit(repo, files, "LVR closeout")
    return repo, execution, main


def load(path: Path, name: str):
    spec = spec_from_file_location(name, path)
    module = module_from_spec(spec)
    sys.path.insert(0, str(path.parent))
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def code_lines(path: Path) -> list[str]:
    """Executable lines only for the static forbidden-action audit: shell comments are dropped; for Python the docstrings are removed through the AST (prose may say "never esptool")."""
    if path.suffix == ".py":
        import ast

        tree = ast.parse(path.read_text())
        for node in ast.walk(tree):
            if isinstance(node, (ast.Module, ast.FunctionDef, ast.ClassDef)) and node.body and isinstance(node.body[0], ast.Expr) and isinstance(getattr(node.body[0], "value", None), ast.Constant) and isinstance(node.body[0].value.value, str):
                node.body = node.body[1:] or [ast.Pass()]
        return [line for line in ast.unparse(tree).splitlines() if line.strip()]
    return [line for line in path.read_text().splitlines() if line.strip() and not line.lstrip().startswith("#")]
