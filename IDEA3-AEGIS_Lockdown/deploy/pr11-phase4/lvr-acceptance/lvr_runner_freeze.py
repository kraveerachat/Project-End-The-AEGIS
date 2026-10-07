#!/usr/bin/env python3
"""LVR frozen-runner freeze / verify tool (repository tooling; authorises nothing live, creates no authorization or K3, runs nothing on Production).

The frozen LVR owner runner must not be its own trust root: a hand-edited runner could alter its own gates or ownership constants and still receive a fresh self-hash in an Authorization. This tool
makes the frozen runner MECHANICALLY DERIVED from the reviewed template:

    FROZEN RUNNER = EXACT REVIEWED TEMPLATE  +  ONLY the approved pin substitutions

* The template authority is the Git object ``EXPECTED_MAIN:IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/owner-run/run-lvr-owner.sh`` read with replacement objects DISABLED; no working-tree byte is ever template authority.
* ``freeze`` takes a JSON object of pins. The key set must be EXACTLY the allowlist below (unknown, missing and duplicate keys are refused), every value must match a strict per-pin grammar (no newline, quote, ``$``, backtick, space or ``;``), and a value replaces ONLY the captured pin site of its own line. There is no generic search/replace interface; code cannot be injected through a pin value.
* The output is created exclusively (an existing destination is refused), never modifies the template, is mode 0555, and with ``--root-owned`` (root only) is chowned root:root and proven to sit under a trusted, root-owned, non-group/world-writable ancestor chain.
* PRODUCTION TRUST ROOT IS LITERALLY ``/``.
* ``verify`` re-proves, at any later time, that the file equals the template with only the approved pin sites changed, that its EXPECTED_MAIN pin is the reviewed main, and (production default) that it is root owned and not writable. It prints the owner-facing results and the runner SHA-256 that the Authorization must name.
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

TEMPLATE_REL = "IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/owner-run/run-lvr-owner.sh"

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
}

PIN_SPECS: dict[str, tuple[re.Pattern[str], str, str]] = {
    "EXPECTED_MAIN": (re.compile(r"^EXPECTED_MAIN=(.*)$", re.M), "PIN_MAIN_SHA", "main"),
    "OPERATOR_USER": (re.compile(r"^OPERATOR_USER=(.*)$", re.M), "PIN_OPERATOR_USER", "user"),
    "OPERATOR_UID": (re.compile(r"^OPERATOR_UID=(.*)$", re.M), "PIN_OPERATOR_UID", "uid"),
    "RECOVERY_EXECUTION_MAIN": (re.compile(r"^RECOVERY_EXECUTION_MAIN=(.*)$", re.M), "PIN_RECOVERY_EXECUTION_MAIN", "main"),
    "CONTROL_SNAPSHOT_DIR": (re.compile(r"^CONTROL_SNAPSHOT_DIR=(.*)$", re.M), "PIN_CONTROL_SNAPSHOT_DIR", "path"),
    "CONTROL_MANIFEST_SHA256": (re.compile(r"^CONTROL_MANIFEST_SHA256=(.*)$", re.M), "PIN_CONTROL_MANIFEST_SHA256", "sha256"),
    "AUDIT_DB": (re.compile(r"^AUDIT_DB=(.*)$", re.M), "PIN_AUDIT_DB_PATH", "path"),
    "STATUS_PATH": (re.compile(r"^STATUS_PATH=(.*)$", re.M), "PIN_STATUS_PATH", "path"),
    "RECOVERY_MARKER": (re.compile(r"^RECOVERY_MARKER=(.*)$", re.M), "PIN_RECOVERY_MARKER_PATH", "path"),
    "EVIDENCE_ROOT": (re.compile(r"^EVIDENCE_ROOT=(.*)$", re.M), "PIN_EVIDENCE_ROOT", "path"),
    "REPO": (re.compile(r"^REPO=(.*)$", re.M), "PIN_PINNED_WORKTREE", "path"),
    "PY": (re.compile(r"^PY=(.*)$", re.M), "PIN_PYTHON_BIN", "path"),
}

PRODUCTION_OWNER_UID = 0
PRODUCTION_TRUST_ROOT = "/"
TEST_SEAM_ENABLED = "LVR_TEST_ONLY_RUNNER_TRUST_ENABLED"
TEST_SEAM_ROOT = "LVR_TEST_ONLY_RUNNER_TRUST_ROOT"


def _initial_user_namespace() -> bool:
    try:
        parts = Path("/proc/self/uid_map").read_text().split()
    except OSError:
        return True
    return parts[:3] == ["0", "0", "4294967295"]


def trust_root() -> str:
    enabled, root = os.environ.get(TEST_SEAM_ENABLED), os.environ.get(TEST_SEAM_ROOT)
    if enabled is None and root is None:
        return PRODUCTION_TRUST_ROOT
    if enabled != "YES" or not root:
        raise FreezeError("TEST_TRUST_SEAM_INCOMPLETE")
    if _initial_user_namespace():
        raise FreezeError("TEST_TRUST_SEAM_REFUSED_IN_THE_REAL_ROOT_NAMESPACE")
    if not root.startswith("/") or ".." in root.split("/") or not Path(root).is_dir() or Path(os.path.realpath(root)) != Path(os.path.abspath(root)):
        raise FreezeError("TEST_TRUST_SEAM_ROOT_INVALID")
    return root


def check_trusted_path(directory: Path, owner_uid: int, stop_at: str) -> None:
    p = directory.resolve()
    stop = Path(stop_at).resolve()
    while True:
        st = p.lstat()
        if stat.S_ISLNK(st.st_mode) or not stat.S_ISDIR(st.st_mode):
            raise FreezeError("NOT_CANONICAL_DIRECTORY")
        if st.st_uid != owner_uid:
            raise FreezeError("ANCESTOR_NOT_OWNED_BY_TRUSTED_UID")
        if st.st_mode & 0o022:
            raise FreezeError("ANCESTOR_GROUP_OR_WORLD_WRITABLE")
        if p == stop:
            break
        if p == Path("/"):
            raise FreezeError("STOP_AT_NOT_AN_ANCESTOR")
        p = p.parent


def _git_env() -> dict[str, str]:
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    env["GIT_NO_REPLACE_OBJECTS"] = "1"
    env["GIT_CONFIG_NOSYSTEM"] = "1"
    return env


def _git(repo: Path, *args: str) -> str:
    done = subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True, env=_git_env(), check=False)
    if done.returncode != 0:
        raise FreezeError("GIT_READ_FAILED")
    return done.stdout


def read_template(repo: Path, main: str) -> str:
    if not VALIDATORS["main"](main):
        raise FreezeError("MAIN_MALFORMED")
    if _git(Path(repo), "rev-parse", "--verify", f"{main}^{{commit}}").strip() != main:
        raise FreezeError("MAIN_NOT_A_COMMIT_OBJECT")
    return _git(Path(repo), "show", f"{main}:{TEMPLATE_REL}")


def load_pins(text: str) -> dict[str, str]:
    def no_duplicates(pairs):
        keys = [k for k, _ in pairs]
        if len(keys) != len(set(keys)):
            raise FreezeError("DUPLICATE_PIN")
        return dict(pairs)

    try:
        pins = json.loads(text, object_pairs_hook=no_duplicates)
    except json.JSONDecodeError:
        raise FreezeError("PINS_NOT_JSON") from None
    if not isinstance(pins, dict) or not all(isinstance(v, str) for v in pins.values()):
        raise FreezeError("PINS_NOT_A_STRING_OBJECT")
    unknown = sorted(set(pins) - set(PIN_SPECS))
    if unknown:
        raise FreezeError(f"UNKNOWN_PIN:{unknown[0]}")
    missing = sorted(set(PIN_SPECS) - set(pins))
    if missing:
        raise FreezeError(f"MISSING_PIN:{missing[0]}")
    for name, value in pins.items():
        if "PIN_" in value or not VALIDATORS[PIN_SPECS[name][2]](value):
            raise FreezeError(f"PIN_VALUE_REJECTED:{name}")
    return pins


def _sites(text: str, name: str) -> list[re.Match[str]]:
    return list(PIN_SPECS[name][0].finditer(text))


def render(template: str, pins: dict[str, str]) -> str:
    edits = []
    for name, (_, placeholder, _) in PIN_SPECS.items():
        matches = _sites(template, name)
        if len(matches) != 1 or matches[0].group(1) != placeholder:
            raise FreezeError(f"TEMPLATE_PIN_SITE_INVALID:{name}")
        edits.append((matches[0].span(1), pins[name]))
    out = template
    for (start, end), value in sorted(edits, reverse=True):
        out = out[:start] + value + out[end:]
    return out


def extract(frozen: str) -> dict[str, str]:
    values = {}
    for name in PIN_SPECS:
        matches = _sites(frozen, name)
        if len(matches) != 1:
            raise FreezeError(f"FROZEN_PIN_SITE_NOT_UNIQUE:{name}")
        values[name] = matches[0].group(1)
    return values


def check_equivalence(template: str, frozen: str) -> dict[str, str]:
    values = extract(frozen)
    for name, value in values.items():
        if "PIN_" in value or not VALIDATORS[PIN_SPECS[name][2]](value):
            raise FreezeError(f"FROZEN_PIN_VALUE_REJECTED:{name}")
    edits = sorted(((_sites(frozen, name)[0].span(1), PIN_SPECS[name][1]) for name in PIN_SPECS), reverse=True)
    restored = frozen
    for (start, end), placeholder in edits:
        restored = restored[:start] + placeholder + restored[end:]
    if restored != template:
        raise FreezeError("NON_PIN_BYTES_DIFFER_FROM_THE_REVIEWED_TEMPLATE")
    return values


def sha256_of(path: Path) -> str:
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def verify(repo: Path, main: str, runner: Path, *, owner_uid: int | None = PRODUCTION_OWNER_UID) -> dict[str, str]:
    runner = Path(runner)
    template = read_template(repo, main)
    results = {"RUNNER_TEMPLATE_AUTHORITY": "PASS"}
    frozen = runner.read_text(encoding="utf-8")
    values = check_equivalence(template, frozen)
    if values["EXPECTED_MAIN"] != main:
        raise FreezeError("FROZEN_EXPECTED_MAIN_IS_NOT_THE_REVIEWED_MAIN")
    results["RUNNER_ONLY_APPROVED_PINS_CHANGED"] = "PASS"
    if owner_uid is not None:
        try:
            check_trusted_path(runner.parent, owner_uid, trust_root())
        except FreezeError as exc:
            raise FreezeError(f"RUNNER_NOT_ROOT_OWNED:{exc}") from None
        st = runner.lstat()
        if stat.S_ISLNK(st.st_mode) or not stat.S_ISREG(st.st_mode) or Path(os.path.realpath(runner)) != Path(os.path.abspath(runner)):
            raise FreezeError("RUNNER_NOT_A_CANONICAL_REGULAR_FILE")
        if st.st_uid != owner_uid:
            raise FreezeError("RUNNER_NOT_ROOT_OWNED:file")
        results["RUNNER_ROOT_OWNED"] = "PASS"
        if st.st_mode & 0o222:
            raise FreezeError("RUNNER_WRITABLE")
        results["RUNNER_NONWRITABLE"] = "PASS"
    results["RUNNER_SHA256"] = sha256_of(runner)
    return results


def freeze(repo: Path, main: str, pins: dict[str, str], destination: Path, *, root_owned: bool = False, owner_uid: int | None = None) -> dict[str, str]:
    repo = Path(repo)
    dst = Path(destination)
    if dst.exists() or dst.is_symlink():
        raise FreezeError("DESTINATION_ALREADY_EXISTS")
    template = read_template(repo, main)
    rendered = render(template, pins)
    parent = dst.parent
    if not parent.is_dir():
        raise FreezeError("DESTINATION_PARENT_NOT_DIRECTORY")
    dst.write_text(rendered, encoding="utf-8")
    dst.chmod(0o555)
    effective_uid = owner_uid if owner_uid is not None else (PRODUCTION_OWNER_UID if root_owned else None)
    return verify(repo, main, dst, owner_uid=effective_uid)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subs = parser.add_subparsers(dest="subcommand", required=True)

    fr = subs.add_parser("freeze")
    fr.add_argument("--repo", type=Path, required=True)
    fr.add_argument("--main", required=True)
    fr.add_argument("--pins", type=Path, required=True)
    fr.add_argument("--out", type=Path, required=True)
    fr.add_argument("--root-owned", action="store_true")

    vr = subs.add_parser("verify")
    vr.add_argument("--repo", type=Path, required=True)
    vr.add_argument("--main", required=True)
    vr.add_argument("--runner", type=Path, required=True)
    vr.add_argument("--skip-ownership", action="store_true")

    args = parser.parse_args()
    try:
        if args.subcommand == "freeze":
            pins = load_pins(args.pins.read_text(encoding="utf-8"))
            res = freeze(args.repo, args.main, pins, args.out, root_owned=args.root_owned)
        elif args.subcommand == "verify":
            res = verify(args.repo, args.main, args.runner, owner_uid=None if args.skip_ownership else PRODUCTION_OWNER_UID)
        else:
            raise FreezeError("UNKNOWN_SUBCOMMAND")
        for k, v in res.items():
            print(f"{k}={v}")
        return 0
    except FreezeError as exc:
        print(f"LVR_RUNNER_FREEZE=FAIL reason={exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
