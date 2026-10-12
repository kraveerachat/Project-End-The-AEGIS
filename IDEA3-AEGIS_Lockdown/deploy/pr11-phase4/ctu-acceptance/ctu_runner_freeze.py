#!/usr/bin/env python3
"""CTU frozen-runner freeze / verify tool (repository tooling; touches no Production).

Mechanically derives the frozen CTu owner runner from the reviewed template:
    FROZEN RUNNER = EXACT REVIEWED TEMPLATE + ONLY approved pin substitutions

Template authority is the Git object:
    EXPECTED_MAIN:IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/owner-run/run-ctu-owner.sh
read with replacement objects DISABLED.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import stat
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import ctu_verifier_snapshot as snapshot_tool

TEMPLATE_REL = "IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/owner-run/run-ctu-owner.sh"

_SHA256 = re.compile(r"[0-9a-f]{64}")
_PATH = re.compile(r"/[A-Za-z0-9._/-]{0,200}")


class FreezeError(ValueError):
    pass


def _path_ok(value: str) -> bool:
    return bool(_PATH.fullmatch(value)) and ".." not in value.split("/") and "//" not in value and (value == "/" or not value.endswith("/"))


VALIDATORS = {
    "main": lambda v: bool(re.fullmatch(r"[0-9a-f]{40}", v)),
    "user": lambda v: bool(re.fullmatch(r"[a-z_][a-z0-9_-]{0,31}", v)),
    "uid": lambda v: bool(re.fullmatch(r"[1-9][0-9]{0,9}", v)),
    "sha256": lambda v: bool(_SHA256.fullmatch(v)),
    "path": _path_ok,
    "device": lambda v: bool(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}", v)),
}

PIN_SPECS: dict[str, tuple[re.Pattern[str], str, str]] = {
    "EXPECTED_MAIN": (re.compile(r"^EXPECTED_MAIN=(.*)$", re.M), "PIN_MAIN_SHA", "main"),
    "OPERATOR_USER": (re.compile(r"^OPERATOR_USER=(.*)$", re.M), "PIN_OPERATOR_USER", "user"),
    "OPERATOR_UID": (re.compile(r"^OPERATOR_UID=(.*)$", re.M), "PIN_OPERATOR_UID", "uid"),
    "UNIT_SHA256": (re.compile(r"^UNIT_SHA256=(.*)$", re.M), "PIN_CORE_UNIT_SHA256", "sha256"),
    "MERGED_MAIN_WORKTREE": (re.compile(r"^MERGED_MAIN_WORKTREE=(.*)$", re.M), "PIN_MERGED_MAIN_WORKTREE", "path"),
    "EVIDENCE_ROOT": (re.compile(r"^EVIDENCE_ROOT=(.*)$", re.M), "PIN_EVIDENCE_ROOT", "path"),
    "DEVICE_ID": (re.compile(r"^DEVICE_ID=(.*)$", re.M), "PIN_DEVICE_ID", "device"),
}

TEST_SEAM_ENABLED = "CTU_TEST_ONLY_RUNNER_TRUST_ENABLED"
TEST_SEAM_ROOT = "CTU_TEST_ONLY_RUNNER_TRUST_ROOT"


def _initial_user_namespace() -> bool:
    try:
        parts = Path("/proc/self/uid_map").read_text().split()
    except OSError:
        return True
    return parts[:3] == ["0", "0", "4294967295"]


def trust_root() -> str:
    enabled = os.environ.get(TEST_SEAM_ENABLED)
    custom = os.environ.get(TEST_SEAM_ROOT)
    if not enabled and not custom:
        return "/"
    if enabled != "YES" or not custom:
        raise FreezeError("TEST_TRUST_SEAM_HALF_SET")
    if _initial_user_namespace():
        raise FreezeError("TEST_TRUST_SEAM_REFUSED_IN_THE_REAL_ROOT_NAMESPACE")
    p = Path(custom)
    if not p.is_absolute() or os.path.normpath(custom) != custom:
        raise FreezeError("TEST_TRUST_ROOT_NOT_ABSOLUTE_OR_CANONICAL")
    if not p.is_dir() or p.is_symlink():
        raise FreezeError("TEST_TRUST_ROOT_NOT_A_REAL_DIRECTORY")
    return custom


def load_pins(text: str) -> dict[str, str]:
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise FreezeError(f"PINS_JSON_MALFORMED:{exc}") from None
    if not isinstance(data, dict):
        raise FreezeError("PINS_NOT_A_JSON_OBJECT")
    expected_keys = set(PIN_SPECS)
    got_keys = set(data)
    if got_keys != expected_keys:
        missing = sorted(expected_keys - got_keys)
        unknown = sorted(got_keys - expected_keys)
        details = []
        if missing:
            details.append(f"missing={','.join(missing)}")
        if unknown:
            details.append(f"unknown={','.join(unknown)}")
        raise FreezeError(f"PINS_KEY_SET_MISMATCH:{' '.join(details)}")
    for key, (pattern, placeholder, grammar) in PIN_SPECS.items():
        val = data[key]
        if not isinstance(val, str):
            raise FreezeError(f"PIN_NOT_A_STRING:{key}")
        if not VALIDATORS[grammar](val):
            raise FreezeError(f"PIN_GRAMMAR_INVALID:{key}")
    return {k: str(v) for k, v in data.items()}


def read_template(repo: Path, main: str) -> str:
    if not re.fullmatch(r"[0-9a-f]{40}", main):
        raise FreezeError("MAIN_SHA_INVALID")
    env = {**os.environ, "GIT_NO_REPLACE_OBJECTS": "1"}
    try:
        proc = subprocess.run(
            ["git", "-C", str(repo), "cat-file", "-p", f"{main}:{TEMPLATE_REL}"],
            capture_output=True,
            check=False,
            env=env,
        )
    except OSError as exc:
        raise FreezeError(f"GIT_READ_FAILED:{exc}") from None
    if proc.returncode != 0:
        raise FreezeError(f"TEMPLATE_OBJECT_NOT_FOUND_AT_MAIN:{proc.stderr.decode().strip()}")
    return proc.stdout.decode("utf-8")


def render(template: str, pins: dict[str, str]) -> str:
    content = template
    for key, (pattern, placeholder, grammar) in PIN_SPECS.items():
        val = pins[key]
        match = pattern.search(content)
        if not match:
            raise FreezeError(f"PIN_SITE_NOT_FOUND:{key}")
        if match.group(1) != placeholder:
            raise FreezeError(f"PIN_SITE_NOT_PLACEHOLDER:{key}")
        content = content[:match.start(1)] + val + content[match.end(1):]
    return content


def verify(repo: Path, main: str, runner: Path, *, owner_uid: int | None = None) -> dict[str, str]:
    runner = Path(runner)
    if not runner.is_file() or runner.is_symlink():
        raise FreezeError("RUNNER_FILE_MISSING_OR_SYMLINK")
    data = runner.read_text(encoding="utf-8")
    template = read_template(repo, main)
    extracted = {}
    for key, (pattern, placeholder, grammar) in PIN_SPECS.items():
        match = pattern.search(data)
        if not match:
            raise FreezeError(f"RUNNER_PIN_MISSING:{key}")
        val = match.group(1)
        if not VALIDATORS[grammar](val):
            raise FreezeError(f"RUNNER_PIN_INVALID:{key}")
        extracted[key] = val
    if extracted.get("EXPECTED_MAIN") != main:
        raise FreezeError("RUNNER_MAIN_MISMATCH")
    expected_content = render(template, extracted)
    if data != expected_content:
        raise FreezeError("RUNNER_TEMPLATE_MISMATCH")
    st = runner.stat()
    if st.st_mode & 0o222:
        raise FreezeError("RUNNER_WRITABLE")
    if (st.st_mode & 0o777) != 0o555:
        raise FreezeError("RUNNER_PERMISSIONS_NOT_0555")
    root_owned = "SKIP"
    if owner_uid is not None:
        troot = trust_root()
        snapshot_tool.check_trusted_path(runner, owner_uid, troot)
        if st.st_uid != owner_uid:
            raise FreezeError(f"RUNNER_OWNER_MISMATCH:got_{st.st_uid}_expected_{owner_uid}")
        root_owned = "PASS"
    runner_sha = hashlib.sha256(data.encode("utf-8")).hexdigest()
    return {
        "CTU_RUNNER_TEMPLATE_EQUAL": "PASS",
        "CTU_RUNNER_PINS_VALID": "PASS",
        "CTU_RUNNER_ROOT_OWNED": root_owned,
        "CTU_RUNNER_NONWRITABLE": "PASS",
        "CTU_RUNNER_SHA256": runner_sha,
        "CTU_FREEZE_IMPLEMENTATION_EXISTS": "YES",
        "CTU_FREEZE_VERIFIER_EXISTS": "YES",
        "CTU_TRUST_CLOSURE": "PASS",
    }


def freeze(repo: Path, main: str, pins: dict[str, str], out: Path, *, root_owned: bool = False) -> dict[str, str]:
    out = Path(out)
    if out.exists() or out.is_symlink():
        raise FreezeError("DESTINATION_EXISTS")
    if root_owned:
        if os.geteuid() != 0:
            raise FreezeError("ROOT_REQUIRED_FOR_ROOT_OWNED_RUNNER")
        troot = trust_root()
        snapshot_tool.check_trusted_path(out.parent, 0, troot)
    template = read_template(repo, main)
    if pins.get("EXPECTED_MAIN") != main:
        raise FreezeError("EXPECTED_MAIN_PIN_IS_NOT_THE_REVIEWED_MAIN")
    frozen = render(template, pins)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(frozen, encoding="utf-8")
    out.chmod(0o555)
    if root_owned:
        os.chown(out, 0, 0)
        return verify(repo, main, out, owner_uid=0)
    return verify(repo, main, out, owner_uid=None)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    fr = sub.add_parser("freeze")
    fr.add_argument("--repo", type=Path, required=True)
    fr.add_argument("--main", required=True)
    fr.add_argument("--pins", type=Path, required=True)
    fr.add_argument("--out", type=Path, required=True)
    fr.add_argument("--root-owned", action="store_true")
    vf = sub.add_parser("verify")
    vf.add_argument("--repo", type=Path, required=True)
    vf.add_argument("--main", required=True)
    vf.add_argument("--runner", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        if args.command == "freeze":
            pins = load_pins(args.pins.read_text(encoding="utf-8"))
            results = freeze(args.repo, args.main, pins, args.out, root_owned=args.root_owned)
        else:
            results = verify(args.repo, args.main, args.runner)
    except (FreezeError, OSError) as exc:
        print(f"CTU_RUNNER_FREEZE=FAIL reason={exc}", file=sys.stderr)
        return 1
    for k, v in results.items():
        print(f"{k}={v}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
