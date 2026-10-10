"""Freeze the reviewed ICu runner template for an exact-main host checkout.

Freezing writes only the requested runner output file. It does not create
Authorization/K3 records, consume an attempt, contact a broker, or call systemd
mutation commands. The generated runner retains the fixed restart-proof block.
"""

from __future__ import annotations

import argparse
import hashlib
import os
import re
import subprocess
from pathlib import Path

EXPECTED_MAIN = "4ebade39a3ae2bf2c4fd75f0ebba0edb46248e17"
USER_RE = re.compile(r"[a-z_][a-z0-9_-]{0,31}\Z")
SHA_RE = re.compile(r"[0-9a-f]{64}\Z")
PIN_VALUES = {
    "PIN_MAIN_SHA": "expected_main",
    "PIN_OPERATOR_USER": "operator_user",
    "PIN_OPERATOR_UID": "operator_uid",
    "PIN_TEMPLATE_SHA256": "runner_template_sha256",
    "PIN_UNIT_SNAPSHOT_SHA256": "unit_snapshot_sha256",
    "PIN_EXECUTION_REPO_PATH": "repo_path",
}


def render_runner(template: str, *, expected_main: str, operator_user: str, operator_uid: str,
                  unit_snapshot_sha256: str, repo_path: str) -> tuple[str, str, str]:
    """Return frozen bytes plus template and frozen SHA-256 values."""
    if expected_main != EXPECTED_MAIN:
        raise ValueError("ICU_FREEZE_MAIN_MISMATCH")
    if not USER_RE.fullmatch(operator_user) or not re.fullmatch(r"[1-9][0-9]{0,9}", operator_uid):
        raise ValueError("ICU_FREEZE_OPERATOR_INVALID")
    if not SHA_RE.fullmatch(unit_snapshot_sha256):
        raise ValueError("ICU_FREEZE_UNIT_SNAPSHOT_INVALID")
    if not os.path.isabs(repo_path) or any(ch in repo_path for ch in "\n\r\0"):
        raise ValueError("ICU_FREEZE_REPO_PATH_INVALID")
    values = {
        "PIN_MAIN_SHA": expected_main,
        "PIN_OPERATOR_USER": operator_user,
        "PIN_OPERATOR_UID": operator_uid,
        "PIN_TEMPLATE_SHA256": hashlib.sha256(template.encode("utf-8")).hexdigest(),
        "PIN_UNIT_SNAPSHOT_SHA256": unit_snapshot_sha256,
        "PIN_EXECUTION_REPO_PATH": repo_path,
    }
    rendered = template
    for placeholder, value in values.items():
        if rendered.count(placeholder) != 1:
            raise ValueError(f"ICU_FREEZE_TEMPLATE_PIN_COUNT:{placeholder}")
        rendered = rendered.replace(placeholder, value)
    if any(token in rendered for token in PIN_VALUES) or "SYSTEMD_RESTART_EFFECT_PROVEN=YES" in rendered:
        raise ValueError("ICU_FREEZE_TEMPLATE_UNSAFE")
    return rendered, values["PIN_TEMPLATE_SHA256"], hashlib.sha256(rendered.encode("utf-8")).hexdigest()


def _git(repo: Path, *args: str) -> str:
    result = subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True,
                            env={"PATH": "/usr/bin:/bin", "LC_ALL": "C"}, timeout=15, check=False)
    if result.returncode:
        raise ValueError("ICU_FREEZE_GIT_STATE_UNAVAILABLE")
    return result.stdout.strip()


def freeze(repo: Path, output: Path, operator_user: str, operator_uid: str) -> tuple[str, str]:
    repo = Path(repo).resolve(strict=True)
    output = Path(output).absolute()
    if output == repo or repo in output.parents:
        raise ValueError("ICU_FREEZE_OUTPUT_MUST_BE_OUTSIDE_REPO")
    if _git(repo, "rev-parse", "HEAD") != EXPECTED_MAIN or _git(repo, "rev-parse", "origin/main") != EXPECTED_MAIN:
        raise ValueError("ICU_FREEZE_MAIN_MISMATCH")
    if _git(repo, "status", "--porcelain"):
        raise ValueError("ICU_FREEZE_REPO_DIRTY")
    template_path = repo / "IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/owner-run/run-icu-owner.sh"
    template = template_path.read_text(encoding="utf-8")
    # Import the sibling executor without importing or invoking any host action.
    import importlib.util
    tool_path = repo / "IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-icu-upgrade.py"
    spec = importlib.util.spec_from_file_location("p4_icu_upgrade_freeze", tool_path)
    if spec is None or spec.loader is None:
        raise ValueError("ICU_FREEZE_EXECUTOR_MISSING")
    executor = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(executor)
    unit_digest = executor.unit_snapshot_sha256()
    rendered, template_digest, runner_digest = render_runner(
        template, expected_main=EXPECTED_MAIN, operator_user=operator_user, operator_uid=operator_uid,
        unit_snapshot_sha256=unit_digest, repo_path=str(repo),
    )
    output.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(output, flags, 0o500)
    try:
        os.write(fd, rendered.encode("utf-8"))
        os.fsync(fd)
    finally:
        os.close(fd)
    directory_fd = os.open(output.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)
    return template_digest, runner_digest


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--operator-user", required=True)
    parser.add_argument("--operator-uid", required=True)
    args = parser.parse_args()
    try:
        template_sha, runner_sha = freeze(args.repo, args.output, args.operator_user, args.operator_uid)
    except (OSError, ValueError, subprocess.SubprocessError) as exc:
        print(f"ICU_FREEZE=FAIL reason={exc}")
        return 1
    print(f"ICU_FREEZE=PASS TEMPLATE_SHA256={template_sha} FROZEN_RUNNER_SHA256={runner_sha}")
    print("ICU_RESTART_EFFECT=NOT_PROVEN ICU_ATTEMPT_CONSUMED=NO LIVE_AUTHORIZED=NO")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
