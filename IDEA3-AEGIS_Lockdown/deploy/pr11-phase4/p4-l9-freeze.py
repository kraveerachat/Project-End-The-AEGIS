#!/usr/bin/env python3
"""L9 frozen-runner freeze / verify tool (repository tooling; authorises nothing, runs nothing on Production).

    FROZEN L9 RUNNER = EXACT REVIEWED TEMPLATE + ONLY the approved pin substitutions

* The template authority is the Git object ``EXPECTED_MAIN:IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/owner-run/run-l9-owner.sh``
  read with replacement objects disabled. No working-tree byte is authority.
* ``freeze`` takes ONE JSON object whose key set is exactly ``PIN_SPECS`` (unknown, missing and duplicate keys are refused). Every
  value must match a strict grammar, and a value replaces ONLY the captured pin site of its own line. There is no generic
  search/replace interface.
* The output is created exclusively, never touches the template, is mode 0555 and, with ``--root-owned`` (root only), is chowned
  root:root and proven to sit below a root-owned, non-group/world-writable chain to ``/`` (shared invariant:
  ``recovery_verifier_snapshot.check_trusted_path``; the only narrower root is its user-namespace-only test seam).
* A production-grade freeze and every production ``verify`` additionally require the canonical L8 PASS predecessor of
  ``p4-l9-gates.py`` at the exact pinned main, so a runner cannot be frozen for a main whose L8 evidence is absent, failed,
  stale, duplicated or not an ancestor.
* ``verify`` prints the runner SHA-256 that the L9 Authorization must name (``runner=<sha256>`` in its scope).
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import re
import stat
import subprocess
import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE / "recovery-acceptance"))
import recovery_verifier_snapshot as snapshot_tool  # noqa: E402

TEMPLATE_REL = "IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/owner-run/run-l9-owner.sh"
_PATH = re.compile(r"/[A-Za-z0-9._/-]{0,200}")


class FreezeError(ValueError):
    pass


def _path_ok(value: str) -> bool:
    return bool(_PATH.fullmatch(value)) and ".." not in value.split("/") and "//" not in value and (value == "/" or not value.endswith("/"))


VALIDATORS = {
    "main": lambda v: bool(re.fullmatch(r"[0-9a-f]{40}", v)),
    "user": lambda v: bool(re.fullmatch(r"[a-z_][a-z0-9_-]{0,31}", v)),
    "uid": lambda v: bool(re.fullmatch(r"[1-9][0-9]{0,9}", v)),
    "device": lambda v: bool(re.fullmatch(r"[a-z0-9][a-z0-9-]{1,30}[a-z0-9]", v)),
    "window": lambda v: bool(re.fullmatch(r"[0-9]{3}", v)) and 120 <= int(v) <= 900,
    "path": _path_ok,
}

PIN_SPECS: dict[str, tuple[re.Pattern[str], str, str]] = {
    "EXPECTED_MAIN": (re.compile(r"^EXPECTED_MAIN=(.*)$", re.M), "PIN_MAIN_SHA", "main"),
    "OPERATOR_USER": (re.compile(r"^OPERATOR_USER=(.*)$", re.M), "PIN_OPERATOR_USER", "user"),
    "OPERATOR_UID": (re.compile(r"^OPERATOR_UID=(.*)$", re.M), "PIN_OPERATOR_UID", "uid"),
    "DEVICE_ID": (re.compile(r"^DEVICE_ID=(.*)$", re.M), "PIN_DEVICE_ID", "device"),
    "WINDOW_SECONDS": (re.compile(r"^WINDOW_SECONDS=(.*)$", re.M), "PIN_WINDOW_SECONDS", "window"),
    "MERGED_MAIN_WORKTREE": (re.compile(r"^MERGED_MAIN_WORKTREE=(.*)$", re.M), "PIN_MERGED_MAIN_WORKTREE", "path"),
    "EVIDENCE_ROOT": (re.compile(r"^EVIDENCE_ROOT=(.*)$", re.M), "PIN_EVIDENCE_ROOT", "path"),
}


def _git(repo: Path, *args: str) -> str:
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    env.update({"GIT_NO_REPLACE_OBJECTS": "1", "GIT_CONFIG_NOSYSTEM": "1"})
    done = subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True, env=env, check=False)
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


def check_equivalence(template: str, frozen: str) -> dict[str, str]:
    values = {}
    for name in PIN_SPECS:
        matches = _sites(frozen, name)
        if len(matches) != 1:
            raise FreezeError(f"FROZEN_PIN_SITE_NOT_UNIQUE:{name}")
        values[name] = matches[0].group(1)
        if "PIN_" in values[name] or not VALIDATORS[PIN_SPECS[name][2]](values[name]):
            raise FreezeError(f"FROZEN_PIN_VALUE_REJECTED:{name}")
    edits = sorted(((_sites(frozen, n)[0].span(1), PIN_SPECS[n][1]) for n in PIN_SPECS), reverse=True)
    restored = frozen
    for (start, end), placeholder in edits:
        restored = restored[:start] + placeholder + restored[end:]
    if restored != template:
        raise FreezeError("NON_PIN_BYTES_DIFFER_FROM_THE_REVIEWED_TEMPLATE")
    return values


def _gates():
    spec = importlib.util.spec_from_file_location("p4_l9_gates", _HERE / "p4-l9-gates.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules.setdefault("p4_l9_gates", module)
    spec.loader.exec_module(module)
    return module


def _require_l8(repo: Path, main: str) -> dict[str, str]:
    gates = _gates()
    try:
        return gates.l8_predecessor_gate(Path(repo), main, require_head=False)
    except gates.GateError as exc:
        raise FreezeError(f"L8_PREDECESSOR_NOT_SATISFIED:{exc}") from None


def verify(repo: Path, main: str, runner: Path, *, owner_uid: int | None = snapshot_tool.PRODUCTION_OWNER_UID) -> dict[str, str]:
    """``owner_uid=None`` skips ONLY the ownership and L8-predecessor proofs (hermetic tests of the byte logic); the CLI never does."""
    runner = Path(runner)
    template = read_template(repo, main)
    values = check_equivalence(template, runner.read_text(encoding="utf-8"))
    if values["EXPECTED_MAIN"] != main:
        raise FreezeError("FROZEN_EXPECTED_MAIN_IS_NOT_THE_REVIEWED_MAIN")
    results = {"RUNNER_TEMPLATE_AUTHORITY": "PASS", "RUNNER_ONLY_APPROVED_PINS_CHANGED": "PASS"}
    if owner_uid is not None:
        try:
            snapshot_tool.check_trusted_path(runner.parent, owner_uid, snapshot_tool.trust_root())
        except snapshot_tool.SnapshotError as exc:
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
        prior = _require_l8(repo, main)
        results["L8_PREDECESSOR"] = "PASS"
        results["L8_EXECUTION_MAIN"] = prior["L8_EXECUTION_MAIN"]
    results["RUNNER_SHA256"] = hashlib.sha256(runner.read_bytes()).hexdigest()
    return results


def _prewrite_path_proof(out: Path) -> int:
    out = Path(os.path.abspath(out))
    if os.path.lexists(out):
        raise FreezeError("DESTINATION_EXISTS")
    parent = out.parent
    if not parent.is_dir() or parent.is_symlink():
        raise FreezeError("RUNNER_PARENT_MISSING_OR_SYMLINK")
    try:
        snapshot_tool.check_trusted_path(parent, snapshot_tool.PRODUCTION_OWNER_UID, snapshot_tool.trust_root())
    except snapshot_tool.SnapshotError as exc:
        raise FreezeError(f"RUNNER_PARENT_NOT_TRUSTED:{exc}") from None
    fd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    st, now = os.fstat(fd), parent.lstat()
    if (st.st_dev, st.st_ino) != (now.st_dev, now.st_ino) or st.st_uid != snapshot_tool.PRODUCTION_OWNER_UID or st.st_mode & 0o022:
        os.close(fd)
        raise FreezeError("RUNNER_PARENT_CHANGED_DURING_PROOF")
    return fd


def freeze(repo: Path, main: str, pins: dict[str, str], out: Path, *, root_owned: bool = False) -> dict[str, str]:
    out = Path(out)
    if root_owned:
        if os.geteuid() != 0:
            raise FreezeError("ROOT_REQUIRED_FOR_ROOT_OWNED_RUNNER")
        _require_l8(Path(repo), main)  # L9 cannot be frozen before the canonical L8 PASS exists
    template = read_template(repo, main)
    if pins.get("EXPECTED_MAIN") != main:
        raise FreezeError("EXPECTED_MAIN_PIN_IS_NOT_THE_REVIEWED_MAIN")
    frozen = render(template, pins)
    if root_owned:
        parent_fd = _prewrite_path_proof(out)
        try:
            fd = os.open(out.name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o555, dir_fd=parent_fd)
        except FileExistsError:
            raise FreezeError("DESTINATION_EXISTS") from None
        finally:
            os.close(parent_fd)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(frozen)
            handle.flush()
            os.fchmod(handle.fileno(), 0o555)
            os.fchown(handle.fileno(), 0, 0)
        return verify(repo, main, out, owner_uid=0)
    try:
        with open(out, "x", encoding="utf-8") as handle:
            handle.write(frozen)
    except FileExistsError:
        raise FreezeError("DESTINATION_EXISTS") from None
    out.chmod(0o555)
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
            results = freeze(args.repo, args.main, load_pins(args.pins.read_text(encoding="utf-8")), args.out, root_owned=args.root_owned)
            if not args.root_owned:
                print("NOTE: not root-owned; ownership and the L8 predecessor are NOT proven (rerun with --root-owned as root before any Authorization)")
        else:
            results = verify(args.repo, args.main, args.runner)
    except (FreezeError, OSError, UnicodeDecodeError) as exc:
        print(f"L9_RUNNER_FREEZE=FAIL reason={exc}", file=sys.stderr)
        return 1
    for key, value in results.items():
        print(f"{key}={value}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
