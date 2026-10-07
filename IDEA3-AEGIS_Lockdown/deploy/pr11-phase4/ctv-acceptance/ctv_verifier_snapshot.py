#!/usr/bin/env python3
"""Immutable CTv control-snapshot creator and verifier."""
import argparse
from pathlib import Path
import hashlib
import os
import stat
import subprocess
import re

def manifest_sha256(path: Path) -> str:
    if path.is_symlink() or not path.is_file():
        raise ValueError("CTV_CONTROL_MANIFEST_INVALID")
    return hashlib.sha256(path.read_bytes()).hexdigest()

def _git_env():
    return {"PATH":"/usr/bin:/bin", "HOME":"/nonexistent", "GIT_CONFIG_NOSYSTEM":"1", "GIT_CONFIG_GLOBAL":"/dev/null", "GIT_CONFIG_SYSTEM":"/dev/null", "GIT_NO_REPLACE_OBJECTS":"1"}

def _git(repo: Path, *args: str) -> bytes:
    result = subprocess.run(["git", "-C", str(repo), *args], capture_output=True, env=_git_env())
    if result.returncode: raise ValueError("GIT_READ_FAILED")
    return result.stdout

def control_snapshot(repo: Path, main: str, out: Path, files: list[str]) -> str:
    if out.exists() or out.is_symlink() or not out.is_absolute(): raise ValueError("CONTROL_DESTINATION_INVALID")
    out.mkdir(parents=True)
    if len(files) != len(set(files)):
        raise ValueError("CTV_CONTROL_FILE_SET_DUPLICATE")
    rows = []
    for rel in files:
        if rel.startswith("/") or ".." in rel.split("/"): raise ValueError("CONTROL_PATH_INVALID")
        if not re.fullmatch(r"[A-Za-z0-9._/-]+", rel) or rel.startswith("/") or rel.endswith("/"):
            raise ValueError("CONTROL_PATH_INVALID")
        data = _git(repo, "show", f"{main}:{rel}")
        dest = out / rel; dest.parent.mkdir(parents=True, exist_ok=True); dest.write_bytes(data); os.chmod(dest, 0o555)
        rows.append(f"{hashlib.sha256(data).hexdigest()}  {rel}\n")
    manifest = out / "CTV-CONTROL-SHA256SUMS"; manifest.write_text("".join(rows)); os.chmod(manifest, 0o444)
    for directory in sorted((path for path in out.rglob("*") if path.is_dir()), key=lambda path: len(path.parts), reverse=True):
        os.chmod(directory, 0o555)
    os.chmod(out, 0o555)
    return hashlib.sha256(manifest.read_bytes()).hexdigest()

def control_check(repo: Path, main: str, control: Path) -> str:
    manifest = control / "CTV-CONTROL-SHA256SUMS"
    if manifest.is_symlink() or not manifest.is_file() or stat.S_IMODE(manifest.stat().st_mode) & 0o222: raise ValueError("CTV_CONTROL_MANIFEST_INVALID")
    rows = manifest.read_text().splitlines()
    if not rows:
        raise ValueError("CTV_CONTROL_FILE_SET_EMPTY")
    seen = set()
    for line in rows:
        parts = line.split("  ", 1)
        if len(parts) != 2:
            raise ValueError("CTV_CONTROL_MANIFEST_FORMAT_INVALID")
        digest, rel = parts
        if not re.fullmatch(r"[0-9a-f]{64}", digest) or not re.fullmatch(r"[A-Za-z0-9._/-]+", rel) or rel.startswith("/") or ".." in rel.split("/") or rel.endswith("/") or rel in seen:
            raise ValueError("CONTROL_PATH_INVALID")
        seen.add(rel)
        path = control / rel
        if path.is_symlink() or not path.is_file() or stat.S_IMODE(path.stat().st_mode) & 0o222: raise ValueError("CTV_CONTROL_FILE_INVALID")
        if hashlib.sha256(path.read_bytes()).hexdigest() != digest: raise ValueError("CTV_CONTROL_DIGEST_INVALID")
        if hashlib.sha256(_git(repo, "show", f"{main}:{rel}")).hexdigest() != digest: raise ValueError("CTV_CONTROL_EXACT_MAIN_INVALID")
    actual = {p.relative_to(control).as_posix() for p in control.rglob("*") if p.is_file() and p.name != "CTV-CONTROL-SHA256SUMS"}
    if actual != seen:
        raise ValueError("CTV_CONTROL_FILE_SET_INVALID")
    for directory in [control, *[p for p in control.rglob("*") if p.is_dir()]]:
        if directory.is_symlink() or stat.S_IMODE(directory.stat().st_mode) & 0o222:
            raise ValueError("CTV_CONTROL_DIRECTORY_INVALID")
    return hashlib.sha256(manifest.read_bytes()).hexdigest()

def main(argv=None):
    parser = argparse.ArgumentParser(); sub = parser.add_subparsers(dest="op", required=True)
    p = sub.add_parser("control-snapshot"); p.add_argument("--repo", required=True); p.add_argument("--main", required=True); p.add_argument("--out", required=True); p.add_argument("files", nargs="+")
    p = sub.add_parser("control-check"); p.add_argument("--repo", required=True); p.add_argument("--main", required=True); p.add_argument("--control", required=True)
    args = parser.parse_args(argv)
    digest = control_snapshot(Path(args.repo), args.main, Path(args.out), args.files) if args.op == "control-snapshot" else control_check(Path(args.repo), args.main, Path(args.control))
    print(f"CTV_CONTROL_MANIFEST_SHA256={digest}")

if __name__ == "__main__":
    try: main()
    except (ValueError, OSError) as exc: raise SystemExit(str(exc))
