#!/usr/bin/env python3
"""R1I successor runner.

This is repository tooling for one future, separately authorized execution.  It
never starts IDEA3 services or sends alerts.  The live path is deliberately
guarded by both a fresh authorization file and an explicit runtime flag; tests
use only the fixture seam and a mocked ``nft`` executable.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys
from pathlib import Path
from typing import Any


SUCCESSOR_ID = "R1I-SUCCESSOR-20261009"
TABLE = "aegis_idea3_r1i"
TABLE_REF = "inet aegis_idea3_r1i"
ATTEMPT_MARKER = "R1I-SUCCESSOR-GLOBAL-ATTEMPT-CONSUMED"
AUTH_KEYS = {"successor_id", "attempt_id", "trusted_main_sha", "runner_sha256", "contract_sha256", "authorized"}
CONTRACT_SHA256 = "7cb088c698d1a5fc8df62f13ec94c83ab37e974a7644588c7fd15bb9449f7888"
CONTRACT = Path(__file__).with_name("r1i-successor.nft")
LIVE_CANONICAL_DIR = Path("/var/lib/aegis-idea3/r1i-successor")
OWNED_STATE = (
    "table inet aegis_idea3_r1i {\n"
    "\tchain input {\n"
    "\t\ttype filter hook input priority filter - 10; policy accept;\n"
    "\t\tmeta nfproto ipv4 ct state new tcp flags & (syn | ack) == syn limit rate 50/second burst 60 packets log prefix \"AEGIS_NEWCONN \" level info\n"
    "\t}\n"
    "}\n"
)


class RunnerError(RuntimeError):
    pass


def digest_bytes(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise RunnerError(f"R1I_STATE_UNREADABLE:{path.name}") from exc


def secure_regular_file(path: Path, reason: str) -> None:
    try:
        st = path.lstat()
    except OSError as exc:
        raise RunnerError(reason) from exc
    if not stat.S_ISREG(st.st_mode) or stat.S_ISLNK(st.st_mode):
        raise RunnerError(reason)
    if st.st_mode & (stat.S_IWGRP | stat.S_IWOTH):
        raise RunnerError(reason)


def parse_authorization(path: Path) -> dict[str, str]:
    secure_regular_file(path, "R1I_AUTHORIZATION_INVALID")
    values: dict[str, str] = {}
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError as exc:
        raise RunnerError("R1I_AUTHORIZATION_INVALID") from exc
    for line in lines:
        if not line or line.count("=") != 1:
            raise RunnerError("R1I_AUTHORIZATION_INVALID")
        key, value = line.split("=", 1)
        if key in values or key not in AUTH_KEYS or not value:
            raise RunnerError("R1I_AUTHORIZATION_INVALID")
        values[key] = value
    if set(values) != AUTH_KEYS:
        raise RunnerError("R1I_AUTHORIZATION_INVALID")
    if values["successor_id"] != SUCCESSOR_ID or values["authorized"] != "YES":
        raise RunnerError("R1I_AUTHORIZATION_INVALID")
    if not re.fullmatch(r"R1I-SUCCESSOR-ATTEMPT-[A-Z0-9-]+", values["attempt_id"]):
        raise RunnerError("R1I_AUTHORIZATION_INVALID")
    if not re.fullmatch(r"[0-9a-f]{40}", values["trusted_main_sha"]):
        raise RunnerError("R1I_AUTHORIZATION_INVALID")
    if not re.fullmatch(r"[0-9a-f]{64}", values["runner_sha256"]):
        raise RunnerError("R1I_AUTHORIZATION_INVALID")
    if values["contract_sha256"] != CONTRACT_SHA256:
        raise RunnerError("R1I_CONTRACT_AUTHORITY_MISMATCH")
    if values["runner_sha256"] != digest_bytes(Path(__file__)):
        raise RunnerError("R1I_RUNNER_AUTHORITY_MISMATCH")
    return values


def current_head(repo_root: Path) -> str:
    try:
        result = subprocess.run(
            ["git", "-C", str(repo_root), "rev-parse", "HEAD"],
            text=True,
            capture_output=True,
            check=False,
        )
    except OSError as exc:
        raise RunnerError("R1I_MAIN_AUTHORITY_UNVERIFIED") from exc
    if result.returncode or not re.fullmatch(r"[0-9a-f]{40}", result.stdout.strip()):
        raise RunnerError("R1I_MAIN_AUTHORITY_UNVERIFIED")
    return result.stdout.strip()


def load_and_check_authority(repo_root: Path, authorization: Path) -> dict[str, str]:
    values = parse_authorization(authorization)
    if current_head(repo_root) != values["trusted_main_sha"]:
        raise RunnerError("R1I_MAIN_AUTHORITY_MISMATCH")
    if digest_bytes(CONTRACT) != CONTRACT_SHA256:
        raise RunnerError("R1I_CONTRACT_UNREADABLE")
    return values


def run_nft(args: list[str]) -> str:
    nft = shutil.which("nft")
    if not nft:
        raise RunnerError("R1I_NFT_UNAVAILABLE")
    result = subprocess.run([nft, *args], text=True, capture_output=True, check=False)
    if result.returncode:
        raise RunnerError("R1I_NFT_COMMAND_FAILED")
    return result.stdout


def snapshot_ruleset() -> Any:
    text = run_nft(["-j", "list", "ruleset"])
    try:
        return json.loads(text)
    except ValueError as exc:
        raise RunnerError("R1I_RULESET_UNREADABLE") from exc


def has_r1i_material(snapshot: Any) -> bool:
    text = json.dumps(snapshot, sort_keys=True)
    return TABLE in text or "AEGIS_NEWCONN" in text or "r1i" in text.lower()


def without_owned_table(snapshot: Any) -> Any:
    if not isinstance(snapshot, dict) or not isinstance(snapshot.get("nftables"), list):
        raise RunnerError("R1I_RULESET_UNREADABLE")
    result = dict(snapshot)
    result["nftables"] = [
        item
        for item in snapshot["nftables"]
        if not (
            isinstance(item, dict)
            and isinstance(item.get("table"), dict)
            and item["table"].get("family") == "inet"
            and item["table"].get("name") == TABLE
        )
    ]
    return result


def validate_owned_state(text: str) -> None:
    if text != OWNED_STATE:
        raise RunnerError("R1I_OWNED_STATE_NOT_EXACT")


def ensure_no_marker(canonical_dir: Path) -> None:
    marker = canonical_dir / ATTEMPT_MARKER
    if marker.exists() or marker.is_symlink():
        raise RunnerError("R1I_ATTEMPT_ALREADY_CONSUMED")


def consume_marker(canonical_dir: Path, attempt_id: str) -> None:
    marker = canonical_dir / ATTEMPT_MARKER
    try:
        with marker.open("x", encoding="utf-8") as handle:
            handle.write(f"successor_id={SUCCESSOR_ID}\nattempt_id={attempt_id}\n")
    except (FileExistsError, OSError) as exc:
        raise RunnerError("R1I_ATTEMPT_ALREADY_CONSUMED") from exc


def write_snapshot(path: Path, snapshot: Any) -> None:
    path.write_text(json.dumps(snapshot, sort_keys=True, indent=2) + "\n", encoding="utf-8")


def paths(args: argparse.Namespace) -> tuple[Path, Path, Path, Path]:
    canonical = args.canonical_dir
    authorization = args.authorization
    state = args.state_dir
    repo = args.repo_root
    if args.fixture:
        if os.environ.get("AEGIS_R1I_SUCCESSOR_FIXTURE") != "YES":
            raise RunnerError("R1I_FIXTURE_AUTHORIZATION_REQUIRED")
    else:
        if os.geteuid() != 0 or os.environ.get("AEGIS_R1I_SUCCESSOR_LIVE_AUTHORIZED") != "YES":
            raise RunnerError("R1I_LIVE_AUTHORIZATION_REQUIRED")
        if canonical != LIVE_CANONICAL_DIR:
            raise RunnerError("R1I_CANONICAL_DIR_INVALID")
    if canonical.is_symlink() or not canonical.is_dir():
        raise RunnerError("R1I_CANONICAL_DIR_INVALID")
    return repo, canonical, authorization, state


def apply(args: argparse.Namespace) -> None:
    repo, canonical, authorization, state = paths(args)
    auth = load_and_check_authority(repo, authorization)
    ensure_no_marker(canonical)
    if state.exists():
        raise RunnerError("R1I_STATE_ALREADY_EXISTS")

    baseline = snapshot_ruleset()
    if has_r1i_material(baseline):
        raise RunnerError("R1I_EXISTING_OR_FOREIGN_RULE")
    immediate = snapshot_ruleset()
    if canonical_json(baseline) != canonical_json(immediate):
        raise RunnerError("R1I_PRE_MUTATION_DRIFT")

    state.mkdir(mode=0o700)
    write_snapshot(state / "pre-ruleset.json", immediate)
    (state / "pre-ruleset.sha256").write_text(
        hashlib.sha256(canonical_json(immediate).encode()).hexdigest() + "\n", encoding="utf-8"
    )
    consume_marker(canonical, auth["attempt_id"])
    result = subprocess.run([shutil.which("nft") or "nft", "-f", str(CONTRACT)], text=True, capture_output=True, check=False)
    if result.returncode:
        raise RunnerError("R1I_INSTALL_FAILED")
    try:
        verify_state(state)
    except RunnerError as exc:
        try:
            rollback_state(state)
        except RunnerError:
            raise RunnerError(f"R1I_POST_VERIFY_FAILED:{exc}:R1I_ROLLBACK_UNSAFE") from exc
        raise RunnerError(f"R1I_POST_VERIFY_FAILED:{exc}:R1I_ROLLBACK_PASS") from exc
    print("R1I_SUCCESSOR_APPLY=PASS")
    print("R1I_SUCCESSOR_ATTEMPT_CONSUMED=YES")
    print("PRODUCTION_MUTATION_PERFORMED=NO" if args.fixture else "PRODUCTION_MUTATION_PERFORMED=YES")


def verify_state(state: Path) -> None:
    pre = read_json(state / "pre-ruleset.json")
    post = snapshot_ruleset()
    if canonical_json(without_owned_table(post)) != canonical_json(without_owned_table(pre)):
        raise RunnerError("R1I_POST_STATE_DRIFT")
    if not has_r1i_material(post):
        raise RunnerError("R1I_POST_RULE_MISSING")
    owned = run_nft(["--stateless", "list", "table", "inet", TABLE])
    validate_owned_state(owned)
    write_snapshot(state / "post-ruleset.json", post)
    (state / "post-owned-state").write_text(owned, encoding="utf-8")


def rollback_state(state: Path) -> None:
    pre = read_json(state / "pre-ruleset.json")
    current = snapshot_ruleset()
    if canonical_json(without_owned_table(current)) != canonical_json(without_owned_table(pre)):
        raise RunnerError("R1I_ROLLBACK_UNSAFE")
    try:
        owned = run_nft(["--stateless", "list", "table", "inet", TABLE])
        validate_owned_state(owned)
    except RunnerError as exc:
        raise RunnerError("R1I_ROLLBACK_UNSAFE") from exc
    result = subprocess.run([shutil.which("nft") or "nft", "delete", "table", "inet", TABLE], text=True, capture_output=True, check=False)
    if result.returncode:
        raise RunnerError("R1I_ROLLBACK_FAILED")
    restored = snapshot_ruleset()
    if canonical_json(restored) != canonical_json(pre):
        raise RunnerError("R1I_ROLLBACK_POST_STATE_MISMATCH")


def command(args: argparse.Namespace) -> None:
    paths(args)
    if args.command == "apply":
        apply(args)
    elif args.command == "verify":
        verify_state(args.state_dir)
        print("R1I_SUCCESSOR_VERIFY=PASS")
    else:
        rollback_state(args.state_dir)
        print("R1I_SUCCESSOR_ROLLBACK=PASS")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("apply", "verify", "rollback"))
    parser.add_argument("--repo-root", type=Path, required=True)
    parser.add_argument("--canonical-dir", type=Path, required=True)
    parser.add_argument("--authorization", type=Path, required=True)
    parser.add_argument("--state-dir", type=Path, required=True)
    parser.add_argument("--fixture", action="store_true", help="test-only: permits a mocked nft without root")
    args = parser.parse_args(argv)
    try:
        command(args)
    except (OSError, RunnerError) as exc:
        print(str(exc), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
