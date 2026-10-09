#!/usr/bin/env python3
"""One-shot, fail-closed R1I successor runner.

The command line is production-only and uses fixed trusted paths. Hermetic
tests call ``run`` with an injected executor; no fixture mode can reach it.
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
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

SUCCESSOR_ID = "R1I-SUCCESSOR-20261009"
TABLE = "aegis_idea3_r1i"
ATTEMPT_MARKER = "R1I-SUCCESSOR-GLOBAL-ATTEMPT-CONSUMED"
AUTH_KEYS = {"successor_id", "attempt_id", "trusted_main_sha", "runner_sha256", "contract_sha256", "authorized"}
CONTRACT = Path(__file__).with_name("r1i-successor.nft")
CONTRACT_SHA256 = "7cb088c698d1a5fc8df62f13ec94c83ab37e974a7644588c7fd15bb9449f7888"
TRUSTED_MAIN_SHA = "a401cdb71bb9f5df244a093dd612daf457c26a94"
TRUSTED_MAIN_AUTHORITY_SHA256 = "a6a7f3f25fb82efc0c5c29376cdad727b3d7248c3d5cfd9c5801536486422536"
TRUSTED_MAIN_AUTHORITY_RECORD = f"authority=GITHUB_MAIN_VERIFIED\nmain_sha={TRUSTED_MAIN_SHA}\n".encode()
LIVE_REPO_ROOT = Path("/opt/aegis-idea3/r1i-successor-source")
LIVE_CANONICAL_DIR = Path("/var/lib/aegis-idea3/r1i-successor")
LIVE_AUTHORIZATION = LIVE_CANONICAL_DIR / "authorization.txt"
LIVE_STATE_DIR = LIVE_CANONICAL_DIR / "state"
LIVE_MAIN_AUTHORITY = LIVE_CANONICAL_DIR / "trusted-main-authority"
LIVE_RUNNER = LIVE_REPO_ROOT / "IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/r1i-successor/r1i_successor.py"
TRUSTED_GIT = Path("/usr/bin/git")
TRUSTED_NFT = Path("/usr/bin/nft")
OWNED_STATE = (
    "table inet aegis_idea3_r1i {\n"
    "\tchain input {\n"
    "\t\ttype filter hook input priority filter - 10; policy accept;\n"
    "\t\tmeta nfproto ipv4 ct state new tcp flags & (syn | ack) == syn limit rate 50/second burst 60 packets log prefix \"AEGIS_NEWCONN \" level info\n"
    "\t}\n}\n"
)

class RunnerError(RuntimeError):
    pass

@dataclass(frozen=True)
class Context:
    repo_root: Path
    canonical_dir: Path
    authorization: Path
    state_dir: Path
    runner: Path
    contract: Path
    git: Path
    nft: Path
    main_authority: Path
    test_mode: bool = False

Executor = Callable[[list[str]], tuple[int, str]]

def canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"))

def _path_chain(path: Path) -> list[Path]:
    absolute = path.absolute()
    return [Path("/")] + list(absolute.parents)[::-1] + [absolute]

def trusted_path(path: Path, *, directory: bool = False, test_mode: bool = False) -> None:
    try:
        for part in _path_chain(path):
            st = part.lstat()
            if stat.S_ISLNK(st.st_mode) or (not test_mode and stat.S_ISDIR(st.st_mode) and st.st_mode & (stat.S_IWGRP | stat.S_IWOTH)):
                raise RunnerError("R1I_TRUSTED_PATH_INVALID")
            if not test_mode and st.st_uid != 0:
                raise RunnerError("R1I_TRUSTED_PATH_INVALID")
        st = path.lstat()
    except OSError as exc:
        raise RunnerError("R1I_TRUSTED_PATH_INVALID") from exc
    if directory:
        if not stat.S_ISDIR(st.st_mode):
            raise RunnerError("R1I_TRUSTED_PATH_INVALID")
    elif not stat.S_ISREG(st.st_mode) or st.st_nlink != 1 or st.st_mode & (stat.S_IWGRP | stat.S_IWOTH):
        raise RunnerError("R1I_TRUSTED_PATH_INVALID")

def read_trusted_bytes(path: Path, reason: str, *, test_mode: bool = False) -> bytes:
    try:
        trusted_path(path, test_mode=test_mode)
    except RunnerError as exc:
        raise RunnerError(reason) from exc
    try:
        before = path.lstat()
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        try:
            opened = os.fstat(fd)
            if (before.st_dev, before.st_ino, before.st_nlink) != (opened.st_dev, opened.st_ino, opened.st_nlink):
                raise RunnerError(reason)
            data = os.read(fd, before.st_size + 1)
            after = os.fstat(fd)
            if (opened.st_dev, opened.st_ino, opened.st_size) != (after.st_dev, after.st_ino, after.st_size):
                raise RunnerError(reason)
            return data
        finally:
            os.close(fd)
    except (OSError, RunnerError) as exc:
        raise RunnerError(reason) from exc

def digest_bytes(path: Path, *, test_mode: bool = False) -> str:
    return hashlib.sha256(read_trusted_bytes(path, "R1I_STATE_UNREADABLE", test_mode=test_mode)).hexdigest()

def read_json(path: Path, *, test_mode: bool = False) -> Any:
    try:
        return json.loads(read_trusted_bytes(path, "R1I_STATE_UNREADABLE", test_mode=test_mode).decode())
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RunnerError("R1I_STATE_UNREADABLE") from exc

def atomic_write(path: Path, data: bytes, *, mode: int = 0o600, test_mode: bool = False) -> None:
    trusted_path(path.parent, directory=True, test_mode=test_mode)
    temporary = path.with_name(f".{path.name}.tmp-{os.getpid()}")
    try:
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), mode)
        try:
            os.write(fd, data)
            os.fsync(fd)
        finally:
            os.close(fd)
        os.replace(temporary, path)
        directory_fd = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    except OSError as exc:
        try:
            temporary.unlink()
        except OSError:
            pass
        raise RunnerError("R1I_DURABLE_STATE_FAILED") from exc

def parse_authorization(path: Path, context: Context) -> dict[str, str]:
    try:
        lines = read_trusted_bytes(path, "R1I_AUTHORIZATION_INVALID", test_mode=context.test_mode).decode().splitlines()
    except UnicodeDecodeError as exc:
        raise RunnerError("R1I_AUTHORIZATION_INVALID") from exc
    values: dict[str, str] = {}
    for line in lines:
        if not line or line.count("=") != 1:
            raise RunnerError("R1I_AUTHORIZATION_INVALID")
        key, value = line.split("=", 1)
        if key in values or key not in AUTH_KEYS or not value:
            raise RunnerError("R1I_AUTHORIZATION_INVALID")
        values[key] = value
    if set(values) != AUTH_KEYS or values["successor_id"] != SUCCESSOR_ID or values["authorized"] != "YES":
        raise RunnerError("R1I_AUTHORIZATION_INVALID")
    if not re.fullmatch(r"R1I-SUCCESSOR-ATTEMPT-[A-Z0-9-]+", values["attempt_id"]):
        raise RunnerError("R1I_AUTHORIZATION_INVALID")
    if not re.fullmatch(r"[0-9a-f]{40}", values["trusted_main_sha"]):
        raise RunnerError("R1I_AUTHORIZATION_INVALID")
    if not re.fullmatch(r"[0-9a-f]{64}", values["runner_sha256"]):
        raise RunnerError("R1I_AUTHORIZATION_INVALID")
    if values["contract_sha256"] != CONTRACT_SHA256 or values["runner_sha256"] != digest_bytes(context.runner, test_mode=context.test_mode):
        raise RunnerError("R1I_RUNNER_AUTHORITY_MISMATCH")
    if digest_bytes(context.contract, test_mode=context.test_mode) != CONTRACT_SHA256:
        raise RunnerError("R1I_CONTRACT_UNREADABLE")
    return values

def current_head(context: Context) -> str:
    trusted_path(context.repo_root, directory=True, test_mode=context.test_mode)
    trusted_path(context.git, test_mode=context.test_mode)
    try:
        result = subprocess.run([str(context.git), "-C", str(context.repo_root), "rev-parse", "HEAD"], text=True, capture_output=True, check=False)
    except OSError as exc:
        raise RunnerError("R1I_MAIN_AUTHORITY_UNVERIFIED") from exc
    if result.returncode or not re.fullmatch(r"[0-9a-f]{40}", result.stdout.strip()):
        raise RunnerError("R1I_MAIN_AUTHORITY_UNVERIFIED")
    return result.stdout.strip()

def load_and_check_authority(context: Context) -> dict[str, str]:
    values = parse_authorization(context.authorization, context)
    authority = read_trusted_bytes(context.main_authority, "R1I_MAIN_AUTHORITY_UNVERIFIED", test_mode=context.test_mode)
    if authority != TRUSTED_MAIN_AUTHORITY_RECORD or hashlib.sha256(authority).hexdigest() != TRUSTED_MAIN_AUTHORITY_SHA256:
        raise RunnerError("R1I_MAIN_AUTHORITY_UNVERIFIED")
    if values["trusted_main_sha"] != TRUSTED_MAIN_SHA:
        raise RunnerError("R1I_MAIN_AUTHORITY_MISMATCH")
    if current_head(context) != values["trusted_main_sha"]:
        raise RunnerError("R1I_MAIN_AUTHORITY_MISMATCH")
    return values

def run_nft(args: list[str], context: Context, executor: Executor | None = None) -> str:
    if executor is not None:
        code, output = executor(args)
        if code:
            raise RunnerError("R1I_NFT_COMMAND_FAILED")
        return output
    trusted_path(context.nft)
    result = subprocess.run([str(context.nft), *args], text=True, capture_output=True, check=False)
    if result.returncode:
        raise RunnerError("R1I_NFT_COMMAND_FAILED")
    return result.stdout

def snapshot_ruleset(context: Context, executor: Executor | None = None) -> Any:
    try:
        return json.loads(run_nft(["-j", "list", "ruleset"], context, executor))
    except json.JSONDecodeError as exc:
        raise RunnerError("R1I_RULESET_UNREADABLE") from exc

def _owned_object(item: Any) -> bool:
    if not isinstance(item, dict):
        return False
    for obj in item.values():
        if isinstance(obj, dict) and obj.get("family") == "inet" and (("table" in item and obj.get("name") == TABLE) or obj.get("table") == TABLE):
            return True
    return False

def _normalize(value: Any) -> Any:
    if isinstance(value, dict):
        result = {key: _normalize(item) for key, item in value.items() if key != "metainfo"}
        if isinstance(result.get("counter"), dict):
            result["counter"].pop("packets", None)
            result["counter"].pop("bytes", None)
        return result
    if isinstance(value, list):
        return sorted((_normalize(item) for item in value), key=canonical_json)
    return value

def without_owned_table(snapshot: Any) -> Any:
    if not isinstance(snapshot, dict) or not isinstance(snapshot.get("nftables"), list):
        raise RunnerError("R1I_RULESET_UNREADABLE")
    return {"nftables": [_normalize(item) for item in snapshot["nftables"] if not _owned_object(item)]}

def has_r1i_material(snapshot: Any) -> bool:
    def has_newconn_log(value: Any) -> bool:
        if isinstance(value, dict):
            log = value.get("log")
            if isinstance(log, dict) and re.fullmatch(r"AEGIS_NEWCONN(?:\s.*)?", str(log.get("prefix", ""))):
                return True
            return any(has_newconn_log(item) for item in value.values())
        if isinstance(value, list):
            return any(has_newconn_log(item) for item in value)
        return False

    return any(_owned_object(item) or has_newconn_log(item) for item in snapshot.get("nftables", [])) if isinstance(snapshot, dict) else False

def ensure_no_marker(context: Context) -> None:
    marker = context.canonical_dir / ATTEMPT_MARKER
    if marker.exists() or marker.is_symlink():
        raise RunnerError("R1I_ATTEMPT_ALREADY_CONSUMED")

def consume_marker(context: Context, attempt_id: str) -> None:
    marker = context.canonical_dir / ATTEMPT_MARKER
    try:
        fd = os.open(marker, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
        try:
            os.write(fd, f"successor_id={SUCCESSOR_ID}\nattempt_id={attempt_id}\n".encode())
            os.fsync(fd)
        finally:
            os.close(fd)
        directory_fd = os.open(context.canonical_dir, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    except OSError as exc:
        raise RunnerError("R1I_ATTEMPT_ALREADY_CONSUMED") from exc

def write_snapshot(path: Path, snapshot: Any, *, test_mode: bool) -> None:
    atomic_write(path, (json.dumps(snapshot, sort_keys=True, indent=2) + "\n").encode(), test_mode=test_mode)

def validate_binding(context: Context, auth: dict[str, str]) -> None:
    trusted_path(context.canonical_dir, directory=True, test_mode=context.test_mode)
    trusted_path(context.state_dir, directory=True, test_mode=context.test_mode)
    marker_values: dict[str, str] = {}
    try:
        lines = read_trusted_bytes(context.canonical_dir / ATTEMPT_MARKER, "R1I_ATTEMPT_MARKER_INVALID", test_mode=context.test_mode).decode().splitlines()
    except UnicodeDecodeError as exc:
        raise RunnerError("R1I_ATTEMPT_MARKER_INVALID") from exc
    for line in lines:
        if line.count("=") != 1:
            raise RunnerError("R1I_ATTEMPT_MARKER_INVALID")
        key, value = line.split("=", 1)
        marker_values[key] = value
    if marker_values != {"successor_id": SUCCESSOR_ID, "attempt_id": auth["attempt_id"]}:
        raise RunnerError("R1I_ATTEMPT_MARKER_INVALID")
    binding = read_json(context.state_dir / "binding.json", test_mode=context.test_mode)
    if binding != {"successor_id": SUCCESSOR_ID, "attempt_id": auth["attempt_id"]}:
        raise RunnerError("R1I_STATE_BINDING_INVALID")
    pre = read_json(context.state_dir / "pre-ruleset.json", test_mode=context.test_mode)
    digest = read_trusted_bytes(context.state_dir / "pre-ruleset.sha256", "R1I_STATE_INTEGRITY_INVALID", test_mode=context.test_mode).decode().strip()
    if digest != hashlib.sha256(canonical_json(pre).encode()).hexdigest():
        raise RunnerError("R1I_STATE_INTEGRITY_INVALID")

def verify_state(context: Context, executor: Executor | None = None) -> None:
    auth = load_and_check_authority(context)
    validate_binding(context, auth)
    pre = read_json(context.state_dir / "pre-ruleset.json", test_mode=context.test_mode)
    post = snapshot_ruleset(context, executor)
    if canonical_json(without_owned_table(post)) != canonical_json(without_owned_table(pre)):
        raise RunnerError("R1I_POST_STATE_DRIFT")
    if not has_r1i_material(post):
        raise RunnerError("R1I_POST_RULE_MISSING")
    if run_nft(["--stateless", "list", "table", "inet", TABLE], context, executor) != OWNED_STATE:
        raise RunnerError("R1I_OWNED_STATE_NOT_EXACT")
    write_snapshot(context.state_dir / "post-ruleset.json", post, test_mode=context.test_mode)
    atomic_write(context.state_dir / "post-owned-state", OWNED_STATE.encode(), test_mode=context.test_mode)

def _mutate(context: Context, args: list[str], executor: Executor | None) -> int:
    if executor is not None:
        return executor(args)[0]
    trusted_path(context.nft)
    return subprocess.run([str(context.nft), *args], text=True, capture_output=True, check=False).returncode

def rollback_state(context: Context, executor: Executor | None = None) -> None:
    auth = load_and_check_authority(context)
    validate_binding(context, auth)
    pre = read_json(context.state_dir / "pre-ruleset.json", test_mode=context.test_mode)
    current = snapshot_ruleset(context, executor)
    if canonical_json(without_owned_table(current)) != canonical_json(without_owned_table(pre)):
        raise RunnerError("R1I_ROLLBACK_UNSAFE")
    if run_nft(["--stateless", "list", "table", "inet", TABLE], context, executor) != OWNED_STATE:
        raise RunnerError("R1I_ROLLBACK_UNSAFE")
    if _mutate(context, ["delete", "table", "inet", TABLE], executor):
        raise RunnerError("R1I_ROLLBACK_FAILED")
    if canonical_json(snapshot_ruleset(context, executor)) != canonical_json(pre):
        raise RunnerError("R1I_ROLLBACK_POST_STATE_MISMATCH")

def apply(context: Context, executor: Executor | None = None) -> None:
    auth = load_and_check_authority(context)
    ensure_no_marker(context)
    if context.state_dir.exists():
        raise RunnerError("R1I_STATE_ALREADY_EXISTS")
    baseline = snapshot_ruleset(context, executor)
    if has_r1i_material(baseline):
        raise RunnerError("R1I_EXISTING_OR_FOREIGN_RULE")
    immediate = snapshot_ruleset(context, executor)
    if canonical_json(without_owned_table(baseline)) != canonical_json(without_owned_table(immediate)):
        raise RunnerError("R1I_PRE_MUTATION_DRIFT")
    trusted_path(context.canonical_dir, directory=True, test_mode=context.test_mode)
    context.state_dir.mkdir(mode=0o700)
    write_snapshot(context.state_dir / "pre-ruleset.json", immediate, test_mode=context.test_mode)
    atomic_write(context.state_dir / "pre-ruleset.sha256", (hashlib.sha256(canonical_json(immediate).encode()).hexdigest() + "\n").encode(), test_mode=context.test_mode)
    atomic_write(context.state_dir / "binding.json", json.dumps({"successor_id": SUCCESSOR_ID, "attempt_id": auth["attempt_id"]}, sort_keys=True).encode(), test_mode=context.test_mode)
    consume_marker(context, auth["attempt_id"])
    load_and_check_authority(context)
    if _mutate(context, ["-f", str(context.contract)], executor):
        try:
            current = snapshot_ruleset(context, executor)
        except RunnerError as exc:
            raise RunnerError("R1I_INSTALL_FAILED_AMBIGUOUS") from exc
        if canonical_json(without_owned_table(current)) != canonical_json(without_owned_table(immediate)) or has_r1i_material(current):
            raise RunnerError("R1I_INSTALL_FAILED_AMBIGUOUS")
        raise RunnerError("R1I_INSTALL_FAILED_NO_MUTATION_PROVEN")
    try:
        verify_state(context, executor)
    except RunnerError as exc:
        try:
            rollback_state(context, executor)
        except RunnerError as rollback_exc:
            raise RunnerError(f"R1I_POST_VERIFY_FAILED:{exc}:R1I_ROLLBACK_UNSAFE") from rollback_exc
        raise RunnerError(f"R1I_POST_VERIFY_FAILED:{exc}:R1I_ROLLBACK_PASS") from exc
    print("R1I_SUCCESSOR_APPLY=PASS")
    print("R1I_SUCCESSOR_ATTEMPT_CONSUMED=YES")
    print("PRODUCTION_MUTATION_PERFORMED=YES")

def live_context() -> Context:
    if os.geteuid() != 0 or os.environ.get("AEGIS_R1I_SUCCESSOR_LIVE_AUTHORIZED") != "YES":
        raise RunnerError("R1I_LIVE_AUTHORIZATION_REQUIRED")
    return Context(LIVE_REPO_ROOT, LIVE_CANONICAL_DIR, LIVE_AUTHORIZATION, LIVE_STATE_DIR, LIVE_RUNNER, LIVE_RUNNER.with_name("r1i-successor.nft"), TRUSTED_GIT, TRUSTED_NFT, LIVE_MAIN_AUTHORITY)

def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("apply", "verify", "rollback"))
    args = parser.parse_args(argv)
    try:
        context = live_context()
        if args.command == "apply":
            apply(context)
        elif args.command == "verify":
            verify_state(context)
            print("R1I_SUCCESSOR_VERIFY=PASS")
        else:
            rollback_state(context)
            print("R1I_SUCCESSOR_ROLLBACK=PASS")
    except (OSError, RunnerError) as exc:
        print(str(exc), file=sys.stderr)
        return 1
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
