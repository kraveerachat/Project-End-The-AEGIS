#!/usr/bin/env python3
"""Governed CTv frozen-runner freeze/check tooling.

The runner's self hash is deliberately computed from the final artifact at
runtime.  It is never a template substitution, so the provenance domains
cannot become circular.
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

TEMPLATE_REL = "IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/owner-run/run-ctv-owner.sh"
PIN_RE = re.compile(r"^([A-Z0-9_]+)=(PIN_[A-Z0-9_]+)$", re.M)

PIN_KEYS = {"EXPECTED_MAIN", "OPERATOR_USER", "OPERATOR_UID", "UNIT_SHA256", "MERGED_MAIN_WORKTREE", "EVIDENCE_ROOT", "DEVICE_ID"}

def _git_env() -> dict[str, str]:
    return {"PATH": "/usr/bin:/bin", "HOME": "/nonexistent", "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_SYSTEM": "/dev/null", "GIT_NO_REPLACE_OBJECTS": "1"}

def _git(repo: Path, *args: str) -> str:
    result = subprocess.run(["git", "-C", str(repo), *args], text=True, capture_output=True, env=_git_env())
    if result.returncode:
        raise ValueError("GIT_READ_FAILED")
    return result.stdout

def template_bytes(repo: Path, main: str) -> bytes:
    return _git(repo, "cat-file", "-p", f"{main}:{TEMPLATE_REL}").encode()

def read_template(repo: Path, main: str) -> str:
    if not re.fullmatch(r"[0-9a-f]{40}", main) or _git(repo, "rev-parse", "--verify", f"{main}^{{commit}}").strip() != main:
        raise ValueError("MAIN_NOT_A_COMMIT_OBJECT")
    return template_bytes(repo, main).decode()

def render(template: str, pins: dict[str, str]) -> str:
    if set(pins) != PIN_KEYS:
        raise ValueError("PIN_KEY_SET_INVALID")
    out = template
    for key, value in pins.items():
        out, count = re.subn(rf"^{re.escape(key)}=PIN_[A-Z0-9_]+$", f"{key}={value}", out, flags=re.M)
        if count != 1:
            raise ValueError(f"pin site invalid: {key}")
    if "PIN_" in out:
        raise ValueError("UNRESOLVED_PIN")
    return out

def verify_domains(runner: Path, template: Path, bundle_manifest: Path, control_manifest: Path) -> dict[str, str]:
    if runner.is_symlink() or not runner.is_file() or runner.stat().st_mode & 0o222:
        raise ValueError("CTV_FROZEN_RUNNER_UNTRUSTED")
    values = {
        "CTV_FROZEN_RUNNER_SHA256": hashlib.sha256(runner.read_bytes()).hexdigest(),
        "CTV_RUNNER_TEMPLATE_SHA256": hashlib.sha256(template.read_bytes()).hexdigest(),
        "CTV_BUNDLE_MANIFEST_SHA256": hashlib.sha256(bundle_manifest.read_bytes()).hexdigest(),
        "CTV_CONTROL_MANIFEST_SHA256": hashlib.sha256(control_manifest.read_bytes()).hexdigest(),
    }
    if values["CTV_FROZEN_RUNNER_SHA256"] == values["CTV_RUNNER_TEMPLATE_SHA256"]:
        raise ValueError("CTV_PROVENANCE_DOMAINS_COLLAPSED")
    return values

def verify_frozen_derivation(repo: Path, main: str, runner: Path, pins: dict[str, str]) -> dict[str, str]:
    """Prove the actual frozen artifact is the exact-main template plus pins."""
    if runner.is_symlink() or not runner.is_file() or runner.stat().st_mode & 0o222:
        raise ValueError("CTV_FROZEN_RUNNER_UNTRUSTED")
    template = template_bytes(repo, main).decode("utf-8")
    rendered = render(template, pins).encode("utf-8")
    if runner.read_bytes() != rendered:
        raise ValueError("CTV_RUNNER_TEMPLATE_DERIVATION_INVALID")
    return {
        "CTV_FROZEN_RUNNER_SHA256": hashlib.sha256(rendered).hexdigest(),
        "CTV_RUNNER_TEMPLATE_SHA256": hashlib.sha256(template.encode("utf-8")).hexdigest(),
    }

def _trusted_runner(path: Path, owner_uid: int | None = None) -> None:
    if not path.is_absolute() or path.is_symlink() or not path.is_file():
        raise ValueError("CTV_FROZEN_RUNNER_UNTRUSTED")
    mode = stat.S_IMODE(path.stat().st_mode)
    if mode & 0o222 or mode != 0o555:
        raise ValueError("CTV_FROZEN_RUNNER_MODE_INVALID")
    if owner_uid is not None and path.stat().st_uid != owner_uid:
        raise ValueError("CTV_FROZEN_RUNNER_OWNER_INVALID")
    if owner_uid is not None:
        parent = path.parent
        while True:
            if parent.is_symlink() or not parent.is_dir() or stat.S_IMODE(parent.stat().st_mode) & 0o022:
                raise ValueError("CTV_FROZEN_RUNNER_PARENT_UNTRUSTED")
            if parent.stat().st_uid != owner_uid:
                raise ValueError("CTV_FROZEN_RUNNER_PARENT_OWNER_INVALID")
            if parent == Path("/"):
                break
            parent = parent.parent

def _load_pins(value: str) -> dict[str, str]:
    pins = json.loads(Path(value).read_text() if Path(value).is_file() else value)
    if not isinstance(pins, dict) or set(pins) != PIN_KEYS or not all(isinstance(v, str) for v in pins.values()):
        raise ValueError("PIN_KEY_SET_INVALID")
    return pins

def _freeze(args: argparse.Namespace) -> int:
    repo, out = Path(args.repo), Path(args.out)
    if not out.is_absolute() or out.exists() or out.is_symlink():
        raise ValueError("FROZEN_RUNNER_DESTINATION_INVALID")
    if _git(repo, "rev-parse", "HEAD").strip() != args.main or _git(repo, "status", "--porcelain"):
        raise ValueError("SOURCE_NOT_CLEAN_EXACT_MAIN")
    pins = _load_pins(args.pins); pins["EXPECTED_MAIN"] = args.main
    rendered = render(read_template(repo, args.main), pins).encode()
    if not out.parent.is_absolute() or out.parent.is_symlink():
        raise ValueError("FROZEN_RUNNER_PARENT_INVALID")
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_name(f".{out.name}.tmp.{os.getpid()}")
    try:
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o555)
        with os.fdopen(fd, "wb") as handle:
            handle.write(rendered); handle.flush(); os.fsync(handle.fileno())
        os.chmod(tmp, 0o555)
        if args.root_owned:
            os.chown(tmp, 0, 0)
        if args.root_owned:
            os.chmod(out.parent, stat.S_IMODE(out.parent.stat().st_mode) & ~0o022)
            os.chown(out.parent, 0, 0)
        os.replace(tmp, out)
        dfd = os.open(out.parent, os.O_RDONLY); os.fsync(dfd); os.close(dfd)
    finally:
        if tmp.exists(): tmp.unlink()
    print(f"CTV_FROZEN_RUNNER_SHA256={hashlib.sha256(rendered).hexdigest()}")
    print(f"CTV_RUNNER_TEMPLATE_SHA256={hashlib.sha256(template_bytes(repo, args.main)).hexdigest()}")
    return 0

def _check(args: argparse.Namespace) -> int:
    runner = Path(args.runner); _trusted_runner(runner, 0 if args.root_owned else None)
    pins = _load_pins(args.pins); pins["EXPECTED_MAIN"] = args.main
    values = verify_frozen_derivation(Path(args.repo), args.main, runner, pins)
    print(f"CTV_FROZEN_RUNNER_SHA256={values['CTV_FROZEN_RUNNER_SHA256']}")
    print(f"CTV_RUNNER_TEMPLATE_SHA256={values['CTV_RUNNER_TEMPLATE_SHA256']}")
    return 0

def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="op", required=True)
    for name in ("freeze", "check"):
        p = sub.add_parser(name); p.add_argument("--repo", required=True); p.add_argument("--main", required=True); p.add_argument("--pins", required=True); p.add_argument("--root-owned", action="store_true")
        if name == "freeze": p.add_argument("--out", required=True)
        else: p.add_argument("--runner", required=True)
    args = parser.parse_args(argv)
    return _freeze(args) if args.op == "freeze" else _check(args)

if __name__ == "__main__":
    try: raise SystemExit(main())
    except (ValueError, OSError, json.JSONDecodeError) as exc:
        print(str(exc), file=sys.stderr); raise SystemExit(1)
