#!/usr/bin/env python3
"""R1A frozen-runner freeze / verify tool (repository tooling; authorises nothing live, creates no authorization or K3, runs nothing on Production).

The frozen R1A owner runner must not be its own trust root: a hand-edited runner could alter its own gates or ownership constants and still receive a fresh self-hash in an Authorization. This tool
makes the frozen runner MECHANICALLY DERIVED from the reviewed template:

    FROZEN RUNNER = EXACT REVIEWED TEMPLATE  +  ONLY the approved pin substitutions

* The template authority is the Git object ``EXPECTED_MAIN:IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/owner-run/run-r1a-owner.sh`` read with replacement objects DISABLED; no working-tree byte is ever template
  authority.
* ``freeze`` takes a JSON object of pins. The key set must be EXACTLY the allowlist below (unknown, missing and duplicate keys are refused), every value must match a strict per-pin grammar (no newline, quote,
  ``$``, backtick, space or ``;``), and a value replaces ONLY the captured pin site of its own line. There is no generic search/replace interface; code cannot be injected through a pin value.
* The output is created exclusively (an existing destination is refused), never modifies the template, is mode 0555, and with ``--root-owned`` (root only) is chowned root:root and proven to sit under a trusted,
  root-owned, non-group/world-writable ancestor chain.
* ``verify`` re-proves, at any later time, that the file equals the template with only the approved pin sites changed, that its EXPECTED_MAIN pin is the reviewed main, and (production default) that it is root
  owned and not writable. It prints the four owner-facing results and the runner SHA-256 that the Authorization must name (that Authorization binding is unchanged and still required).
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
import r1a_verifier_snapshot as snapshot_tool  # noqa: E402  (the shared ownership invariant lives there)

TEMPLATE_REL = "IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/owner-run/run-r1a-owner.sh"

_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_PATH = re.compile(r"^/[A-Za-z0-9._/-]{0,200}$")


class FreezeError(ValueError):
    pass


def _path_ok(value: str) -> bool:
    return bool(_PATH.match(value)) and ".." not in value.split("/") and "//" not in value and (value == "/" or not value.endswith("/"))


def _ipv4_external(value: str) -> bool:
    import ipaddress

    if not re.fullmatch(r"(\d{1,3})(\.\d{1,3}){3}", value):
        return False
    try:
        ip = ipaddress.IPv4Address(value)
    except ValueError:
        return False
    return not (ip.is_unspecified or ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_reserved or value == "255.255.255.255")


VALIDATORS = {
    "main": lambda v: bool(re.fullmatch(r"[0-9a-f]{40}", v)),
    "user": lambda v: bool(re.fullmatch(r"[a-z_][a-z0-9_-]{0,31}", v)),
    "uid": lambda v: bool(re.fullmatch(r"[1-9][0-9]{0,9}", v)),
    "release": lambda v: bool(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", v)) and ".." not in v,
    "sha256": lambda v: bool(_SHA256.match(v)),
    "path": _path_ok,
    "ipv4": _ipv4_external,
    "seconds": lambda v: bool(re.fullmatch(r"[1-9][0-9]{0,5}", v)),
}

# name -> (site pattern with ONE capture group = the value, the exact placeholder the reviewed template carries, grammar)
PIN_SPECS: dict[str, tuple[re.Pattern[str], str, str]] = {
    "EXPECTED_MAIN": (re.compile(r"^EXPECTED_MAIN=(.*)$", re.M), "PIN_MAIN_SHA", "main"),
    "OPERATOR_USER": (re.compile(r"^OPERATOR_USER=(.*)$", re.M), "PIN_OPERATOR_USER", "user"),
    "OPERATOR_UID": (re.compile(r"^OPERATOR_UID=(.*)$", re.M), "PIN_OPERATOR_UID", "uid"),
    "RELEASE_ID": (re.compile(r"^RELEASE_ID=(.*)$", re.M), "PIN_RELEASE_ID", "release"),
    "PRODUCTION_DETECTOR_SHA256": (re.compile(r"^PRODUCTION_DETECTOR_SHA256=(.*)$", re.M), "PIN_PRODUCTION_DETECTOR_SHA256", "sha256"),
    "DETECTOR_UNIT_SHA256": (re.compile(r"^DETECTOR_UNIT_SHA256=(.*)$", re.M), "PIN_DETECTOR_UNIT_SHA256", "sha256"),
    "RECOVERY_CORE_SHA256": (re.compile(r"^RECOVERY_CORE_SHA256=(.*)$", re.M), "PIN_RECOVERY_CORE_SHA256", "sha256"),
    "CONTROL_SNAPSHOT_DIR": (re.compile(r"^CONTROL_SNAPSHOT_DIR=(.*)$", re.M), "PIN_CONTROL_SNAPSHOT_DIR", "path"),
    "CONTROL_MANIFEST_SHA256": (re.compile(r"^CONTROL_MANIFEST_SHA256=(.*)$", re.M), "PIN_CONTROL_MANIFEST_SHA256", "sha256"),
    "VERIFIER_SNAPSHOT_DIR": (re.compile(r"^VERIFIER_SNAPSHOT_DIR=(.*)$", re.M), "PIN_VERIFIER_SNAPSHOT_DIR", "path"),
    "VERIFIER_MANIFEST_SHA256": (re.compile(r"^VERIFIER_MANIFEST_SHA256=(.*)$", re.M), "PIN_VERIFIER_MANIFEST_SHA256", "sha256"),
    "R1I_TOOL_SHA256": (re.compile(r"^R1I_TOOL_SHA256=(.*)$", re.M), "PIN_R1I_TOOL_SHA256", "sha256"),
    "AUDIT_DB": (re.compile(r"^AUDIT_DB=(.*)$", re.M), "PIN_AUDIT_DB_PATH", "path"),
    "DETECTOR_UID": (re.compile(r"^DETECTOR_UID=(.*)$", re.M), "PIN_DETECTOR_UID", "uid"),
    "EXPECTED_SOURCE_IP": (re.compile(r"^EXPECTED_SOURCE_IP=(.*)$", re.M), "PIN_EXPECTED_SOURCE_IP", "ipv4"),
    "OBSERVE_SECONDS": (re.compile(r"^OBSERVE_SECONDS=(.*)$", re.M), "PIN_OBSERVE_SECONDS", "seconds"),
    "REPO": (re.compile(r"^REPO=(\S+)   # ", re.M), "/home/PIN_OPERATOR_HOME/PIN_PINNED_WORKTREE_NOT_A_REAL_PATH", "path"),
    "PY": (re.compile(r"^PY=(.*)$", re.M), "PIN_PYTHON_BIN", "path"),
    "EVIDENCE_ROOT": (re.compile(r"^EVID=(/[^\n$]*?)/\$TODAY-r1a-\$STAMP$", re.M), "/PIN_EVIDENCE_ROOT", "path"),
}


def _git_env() -> dict[str, str]:
    """A clean Git environment: nothing from the caller can redirect the repository or re-enable replacement objects."""
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
    """The reviewed template, as the bytes of the exact EXPECTED_MAIN Git object (replacement objects disabled). Never a working-tree file."""
    if not VALIDATORS["main"](main):
        raise FreezeError("MAIN_MALFORMED")
    if _git(Path(repo), "rev-parse", "--verify", f"{main}^{{commit}}").strip() != main:
        raise FreezeError("MAIN_NOT_A_COMMIT_OBJECT")
    return _git(Path(repo), "show", f"{main}:{TEMPLATE_REL}")


def load_pins(text: str) -> dict[str, str]:
    """Strict pin input: ONE JSON object, string values, no duplicate key, the key set EXACTLY the allowlist."""
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
    """The template with ONLY the captured pin site of each allowlisted pin replaced. The template must be genuinely unfrozen (every site carries its exact placeholder, exactly once)."""
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
    """The pin values carried by a frozen runner (each site must match exactly once)."""
    values = {}
    for name in PIN_SPECS:
        matches = _sites(frozen, name)
        if len(matches) != 1:
            raise FreezeError(f"FROZEN_PIN_SITE_NOT_UNIQUE:{name}")
        values[name] = matches[0].group(1)
    return values


def check_equivalence(template: str, frozen: str) -> dict[str, str]:
    """FROZEN == TEMPLATE + ONLY the approved pin substitutions: restoring each placeholder in the frozen text must reproduce the reviewed template byte for byte."""
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


def verify(repo: Path, main: str, runner: Path, *, owner_uid: int | None = snapshot_tool.PRODUCTION_OWNER_UID, trust_root: str = snapshot_tool.PRODUCTION_TRUST_ROOT) -> dict[str, str]:
    """The four owner-facing results plus the runner SHA-256. ``owner_uid=None`` skips ONLY the ownership/non-writable proof (hermetic tests of the byte logic); the CLI never does."""
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
            snapshot_tool.check_trusted_path(runner.parent, owner_uid, trust_root)
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
    results["RUNNER_SHA256"] = sha256_of(runner)
    return results


def freeze(repo: Path, main: str, pins: dict[str, str], out: Path, *, root_owned: bool = False, trust_root: str = snapshot_tool.PRODUCTION_TRUST_ROOT) -> dict[str, str]:
    """Create a NEW frozen runner (never overwrites, never touches the template), then prove it exactly as ``verify`` does."""
    template = read_template(repo, main)
    if pins.get("EXPECTED_MAIN") != main:
        raise FreezeError("EXPECTED_MAIN_PIN_IS_NOT_THE_REVIEWED_MAIN")
    frozen = render(template, pins)
    out = Path(out)
    if root_owned and os.geteuid() != 0:
        raise FreezeError("ROOT_REQUIRED_FOR_ROOT_OWNED_RUNNER")
    try:
        with open(out, "x", encoding="utf-8") as handle:  # exclusive: an existing destination is refused
            handle.write(frozen)
    except FileExistsError:
        raise FreezeError("DESTINATION_EXISTS") from None
    out.chmod(0o555)
    if root_owned:
        os.chown(out, 0, 0, follow_symlinks=False)
    return verify(repo, main, out, owner_uid=0 if root_owned else None, trust_root=trust_root)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    fr = sub.add_parser("freeze")
    fr.add_argument("--repo", type=Path, required=True)
    fr.add_argument("--main", required=True)
    fr.add_argument("--pins", type=Path, required=True)
    fr.add_argument("--out", type=Path, required=True)
    fr.add_argument("--root-owned", action="store_true", help="FREEZE: chown root:root (root only) and prove the production invariant")
    vf = sub.add_parser("verify")
    vf.add_argument("--repo", type=Path, required=True)
    vf.add_argument("--main", required=True)
    vf.add_argument("--runner", type=Path, required=True)
    for p in (fr, vf):
        p.add_argument("--trust-root", default=snapshot_tool.PRODUCTION_TRUST_ROOT, help="the designated trusted parent (default /)")
    args = parser.parse_args(argv)
    try:
        if args.command == "freeze":
            pins = load_pins(args.pins.read_text(encoding="utf-8"))
            results = freeze(args.repo, args.main, pins, args.out, root_owned=args.root_owned, trust_root=args.trust_root)
            if not args.root_owned:
                print("NOTE: not root-owned; RUNNER_ROOT_OWNED and RUNNER_NONWRITABLE are NOT proven (rerun with --root-owned as root before any Authorization)")
        else:
            results = verify(args.repo, args.main, args.runner, trust_root=args.trust_root)
    except (FreezeError, OSError, UnicodeDecodeError) as exc:
        print(f"R1A_RUNNER_FREEZE=FAIL reason={exc}", file=sys.stderr)
        return 1
    for key, value in results.items():
        print(f"{key}={value}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
