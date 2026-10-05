#!/usr/bin/env python3
"""R1A verifier-authority tooling (repository tooling; authorises nothing live, touches no Production).

Root executes the R1 acceptance verifier during a LIVE R1A attempt, so it must never run from mutable application bytes. This tool computes the COMPLETE local import closure of
``aegis_soc.r1_acceptance`` (every ``aegis_soc`` module whose code can affect R1 acceptance semantics, found by walking the AST of each module for import statements at any depth), writes a
manifest of SHA-256 digests, and builds an immutable (read-only) snapshot of exactly that closure OUTSIDE the mutable worktree. The frozen runner pins the manifest digest and executes
BASELINE and FINAL only from that snapshot, re-proving it immediately before each use.

Subcommands: ``closure SRC_APP``; ``manifest SRC_APP``; ``snapshot SRC_APP DEST`` (DEST must not exist); ``check SNAPSHOT MANIFEST``.

The same model protects the LIVE CONTROL PLANE (the shell libraries, stage handlers, stage gate, capture and compare scripts and helpers that the frozen runner sources and that root executes):
``control-snapshot SRC_P4 DEST`` copies the WHOLE ``deploy/pr11-phase4`` tree (a deliberate superset: no static analysis gap can leave a sourced or executed file out) into a NEW read-only directory with a
manifest named ``R1A-CONTROL-SHA256SUMS``; ``control-check SNAPSHOT MANIFEST_SHA256`` re-proves it. The frozen runner re-proves it inline before it sources anything and before every root execution.
"""

from __future__ import annotations

import argparse
import ast
import hashlib
import os
import stat
import sys
from pathlib import Path

ENTRY = "r1_acceptance"
PACKAGE = "aegis_soc"
MANIFEST_NAME = "R1A-VERIFIER-SHA256SUMS"
CONTROL_MANIFEST_NAME = "R1A-CONTROL-SHA256SUMS"


class SnapshotError(ValueError):
    pass


def _module_file(app: Path, name: str) -> Path | None:
    base = app / PACKAGE
    path = base / f"{name}.py"
    if path.is_file():
        return path
    pkg = base / name / "__init__.py"
    return pkg if pkg.is_file() else None


def _imports(path: Path) -> set[str]:
    """Local ``aegis_soc`` module names imported anywhere in ``path`` (relative, ``from aegis_soc import x``, ``import aegis_soc.x``)."""
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    found: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            if node.level == 1 and node.module:  # ``from .x import y``
                found.add(node.module.split(".")[0])
            elif node.level == 1:  # ``from . import x, y``
                found.update(alias.name.split(".")[0] for alias in node.names)
            elif node.level == 0 and node.module == PACKAGE:  # ``from aegis_soc import x``
                found.update(alias.name.split(".")[0] for alias in node.names)
            elif node.level == 0 and node.module and node.module.startswith(PACKAGE + "."):
                found.add(node.module.split(".")[1])
        elif isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name.startswith(PACKAGE + "."):
                    found.add(alias.name.split(".")[1])
    return found


def closure(app: Path) -> list[str]:
    """Sorted relative paths (``aegis_soc/x.py``) of the entry module, its transitive local imports and the package ``__init__``."""
    app = Path(app)
    if _module_file(app, ENTRY) is None:
        raise SnapshotError("ENTRY_MODULE_MISSING")
    todo, seen = [ENTRY], set()
    while todo:
        name = todo.pop()
        if name in seen:
            continue
        seen.add(name)
        path = _module_file(app, name)
        if path is None:
            continue  # an attribute imported from the package (not a module): the package __init__ is always included
        todo.extend(sorted(_imports(path) - seen))
    files = {f"{PACKAGE}/__init__.py"}
    for name in seen:
        path = _module_file(app, name)
        if path is not None:
            files.add(str(path.relative_to(app)))
    if not (app / PACKAGE / "__init__.py").is_file():
        raise SnapshotError("PACKAGE_INIT_MISSING")
    return sorted(files)


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def manifest_text(app: Path) -> str:
    return "".join(f"{digest(Path(app) / rel)}  {rel}\n" for rel in closure(Path(app)))


def snapshot(app: Path, dest: Path) -> str:
    """Copy exactly the closure into a NEW directory, write the manifest, make everything read-only. Returns the manifest SHA-256."""
    app, dest = Path(app), Path(dest)
    if dest.exists() or dest.is_symlink():
        raise SnapshotError("DEST_EXISTS")
    rels = closure(app)
    dest.mkdir(parents=True, mode=0o755)
    for rel in rels:
        target = dest / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes((app / rel).read_bytes())
        target.chmod(0o444)
    text = manifest_text(dest)
    manifest = dest / MANIFEST_NAME
    manifest.write_text(text, encoding="utf-8")
    manifest.chmod(0o444)
    for directory in sorted({p.parent for p in (dest / rel for rel in rels)} | {dest}, key=lambda p: -len(p.parts)):
        directory.chmod(0o555)
    return hashlib.sha256(text.encode()).hexdigest()


def check(snap: Path, expected_manifest_sha256: str) -> None:
    """Fail closed unless the snapshot is EXACTLY the pinned manifest: manifest digest, every file's digest, no extra file, no symlink."""
    snap = Path(snap)
    manifest = snap / MANIFEST_NAME
    if snap.is_symlink() or not snap.is_dir() or manifest.is_symlink() or not manifest.is_file():
        raise SnapshotError("SNAPSHOT_INVALID")
    if hashlib.sha256(manifest.read_bytes()).hexdigest() != expected_manifest_sha256:
        raise SnapshotError("MANIFEST_DIGEST_MISMATCH")
    listed: dict[str, str] = {}
    for line in manifest.read_text(encoding="utf-8").splitlines():
        sha, sep, rel = line.partition("  ")
        if not sep or len(sha) != 64 or rel.startswith("/") or ".." in rel.split("/"):
            raise SnapshotError("MANIFEST_MALFORMED")
        listed[rel] = sha
    present = set()
    for root, dirs, files in os.walk(snap):
        for name in dirs + files:
            full = Path(root) / name
            if full.is_symlink():
                raise SnapshotError("SYMLINK_IN_SNAPSHOT")
        for name in files:
            present.add(str((Path(root) / name).relative_to(snap)))
    if present != set(listed) | {MANIFEST_NAME}:
        raise SnapshotError("SNAPSHOT_FILE_SET_MISMATCH")
    for rel, sha in listed.items():
        if digest(snap / rel) != sha:
            raise SnapshotError(f"FILE_DIGEST_MISMATCH:{rel}")
        if (snap / rel).stat().st_mode & (stat.S_IWUSR | stat.S_IWGRP | stat.S_IWOTH):
            raise SnapshotError(f"FILE_WRITABLE:{rel}")


def control_files(src: Path) -> list[str]:
    """Every file of the control-plane tree (sorted relative paths). Symlinks are refused; ``__pycache__``/``*.pyc`` build artefacts are not part of the reviewed source."""
    src = Path(src)
    if not src.is_dir() or src.is_symlink():
        raise SnapshotError("CONTROL_SOURCE_INVALID")
    found = []
    for root, dirs, files in os.walk(src):
        dirs[:] = sorted(d for d in dirs if d != "__pycache__")
        for name in sorted(dirs + files):
            if (Path(root) / name).is_symlink():
                raise SnapshotError("CONTROL_SYMLINK_IN_SOURCE")
        for name in files:
            if name.endswith(".pyc"):
                continue
            found.append(str((Path(root) / name).relative_to(src)))
    if not found:
        raise SnapshotError("CONTROL_SOURCE_EMPTY")
    return sorted(found)


def control_snapshot(src: Path, dest: Path) -> str:
    """Copy the whole control tree into a NEW directory (preserving the executable bit), write the manifest, make everything read-only. Returns the manifest SHA-256."""
    src, dest = Path(src), Path(dest)
    if dest.exists() or dest.is_symlink():
        raise SnapshotError("DEST_EXISTS")
    rels = control_files(src)
    dest.mkdir(parents=True, mode=0o755)
    lines = []
    for rel in rels:
        target = dest / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        data = (src / rel).read_bytes()
        target.write_bytes(data)
        target.chmod(0o555 if os.access(src / rel, os.X_OK) else 0o444)
        lines.append(f"{hashlib.sha256(data).hexdigest()}  {rel}\n")
    text = "".join(lines)
    manifest = dest / CONTROL_MANIFEST_NAME
    manifest.write_text(text, encoding="utf-8")
    manifest.chmod(0o444)
    for directory in sorted({p for rel in rels for p in [(dest / rel).parent, *(dest / rel).parent.parents] if dest in (p, *p.parents)}, key=lambda p: -len(p.parts)):
        directory.chmod(0o555)
    return hashlib.sha256(text.encode()).hexdigest()


def control_check(snap: Path, expected_manifest_sha256: str) -> None:
    """Fail closed unless the control snapshot is EXACTLY the pinned manifest: digest, every file, exact file set, no symlink, nothing writable."""
    snap = Path(snap)
    manifest = snap / CONTROL_MANIFEST_NAME
    if snap.is_symlink() or not snap.is_dir() or manifest.is_symlink() or not manifest.is_file():
        raise SnapshotError("CONTROL_SNAPSHOT_INVALID")
    if hashlib.sha256(manifest.read_bytes()).hexdigest() != expected_manifest_sha256:
        raise SnapshotError("CONTROL_MANIFEST_DIGEST_MISMATCH")
    listed: dict[str, str] = {}
    for line in manifest.read_text(encoding="utf-8").splitlines():
        sha, sep, rel = line.partition("  ")
        if not sep or len(sha) != 64 or rel.startswith("/") or ".." in rel.split("/"):
            raise SnapshotError("CONTROL_MANIFEST_MALFORMED")
        listed[rel] = sha
    present = set()
    for root, dirs, files in os.walk(snap):
        for name in dirs + files:
            full = Path(root) / name
            if full.is_symlink():
                raise SnapshotError("CONTROL_SYMLINK_IN_SNAPSHOT")
            if full.stat().st_mode & (stat.S_IWUSR | stat.S_IWGRP | stat.S_IWOTH):
                raise SnapshotError(f"CONTROL_SOURCE_WRITABLE:{full.relative_to(snap)}")
        present.update(str((Path(root) / name).relative_to(snap)) for name in files)
    if present != set(listed) | {CONTROL_MANIFEST_NAME}:
        raise SnapshotError("CONTROL_FILE_SET_MISMATCH")
    for rel, sha in listed.items():
        if digest(snap / rel) != sha:
            raise SnapshotError(f"CONTROL_FILE_DIGEST_MISMATCH:{rel}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("closure", "manifest"):
        sub.add_parser(name).add_argument("app", type=Path)
    snap = sub.add_parser("snapshot")
    snap.add_argument("app", type=Path)
    snap.add_argument("dest", type=Path)
    csnap = sub.add_parser("control-snapshot")
    csnap.add_argument("src", type=Path)
    csnap.add_argument("dest", type=Path)
    cchk = sub.add_parser("control-check")
    cchk.add_argument("snapshot", type=Path)
    cchk.add_argument("manifest_sha256")
    chk = sub.add_parser("check")
    chk.add_argument("snapshot", type=Path)
    chk.add_argument("manifest_sha256")
    args = parser.parse_args(argv)
    try:
        if args.command == "closure":
            print("\n".join(closure(args.app)))
        elif args.command == "manifest":
            sys.stdout.write(manifest_text(args.app))
        elif args.command == "control-snapshot":
            print(f"R1A_CONTROL_MANIFEST_SHA256={control_snapshot(args.src, args.dest)}")
        elif args.command == "control-check":
            control_check(args.snapshot, args.manifest_sha256)
            print("R1A_CONTROL_SNAPSHOT=PASS")
        elif args.command == "snapshot":
            print(f"R1A_VERIFIER_MANIFEST_SHA256={snapshot(args.app, args.dest)}")
        else:
            check(args.snapshot, args.manifest_sha256)
            print("R1A_VERIFIER_SNAPSHOT=PASS")
    except (SnapshotError, OSError, SyntaxError) as exc:
        print(f"R1A_VERIFIER_SNAPSHOT=FAIL reason={exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
