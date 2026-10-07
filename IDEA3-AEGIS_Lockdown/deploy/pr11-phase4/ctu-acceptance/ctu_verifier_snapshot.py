#!/usr/bin/env python3
"""CTU verifier-authority and control snapshot tooling (repository tooling; touches no Production).

Root executes the CTu runner and handlers during a LIVE CTu run, so it must never run from mutable
operator worktree bytes. This tool builds and verifies an immutable root-owned control snapshot of the
trust closure outside the mutable worktree.

Subcommands:
  control-snapshot SRC_P4 DEST [--root-owned]
  control-check SNAPSHOT MANIFEST_SHA256
  trust-closure SNAPSHOT
"""

from __future__ import annotations

import argparse
import hashlib
import os
import stat
import sys
from pathlib import Path

CONTROL_MANIFEST_NAME = "CTU-CONTROL-SHA256SUMS"

TRUST_CLOSURE_FILES = (
    "owner-run/run-ctu-owner.sh",
    "p4-ctu-run-lib.sh",
    "p4-ctu-runtime-verify.py",
    "p4-stage-gate.sh",
    "p4-lib.sh",
    "p4-l0-capture.sh",
    "p4-compare.sh",
    "p4-l7u-run-lib.sh",
    "p4-l7-run-lib.sh",
    "p4-l6b-run-lib.sh",
    "p4-iw-phy-regnorm.awk",
    "stages/CTu/apply.sh",
    "stages/CTu/verify.sh",
    "stages/CTu/rollback.sh",
    "stages/CTu/allow-keys.txt",
    "stages/CTu/allow-keys-rollback.txt",
    "stages/CTu/allow-listeners.txt",
)


class SnapshotError(ValueError):
    pass


PRODUCTION_OWNER_UID = 0
PRODUCTION_TRUST_ROOT = "/"
TEST_SEAM_ENABLED = "CTU_TEST_ONLY_SNAPSHOT_TRUST_ENABLED"
TEST_SEAM_ROOT = "CTU_TEST_ONLY_SNAPSHOT_TRUST_ROOT"


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
        return PRODUCTION_TRUST_ROOT
    if enabled != "YES" or not custom:
        raise SnapshotError("TEST_TRUST_SEAM_HALF_SET")
    if _initial_user_namespace():
        raise SnapshotError("TEST_TRUST_SEAM_REFUSED_IN_THE_REAL_ROOT_NAMESPACE")
    p = Path(custom)
    if not p.is_absolute() or os.path.normpath(custom) != custom:
        raise SnapshotError("TEST_TRUST_ROOT_NOT_ABSOLUTE_OR_CANONICAL")
    if not p.is_dir() or p.is_symlink():
        raise SnapshotError("TEST_TRUST_ROOT_NOT_A_REAL_DIRECTORY")
    return custom


def check_trusted_path(path: Path, owner_uid: int, trust_root_dir: str) -> None:
    p = Path(path).resolve()
    target_root = Path(trust_root_dir).resolve()
    current = p
    while True:
        if current.is_symlink():
            raise SnapshotError(f"SYMLINK_IN_PATH:{current}")
        try:
            st = current.lstat()
        except OSError as exc:
            raise SnapshotError(f"STAT_FAILED:{current}:{exc}") from None
        if st.st_uid != owner_uid:
            raise SnapshotError(f"WRONG_OWNER:{current}:got_{st.st_uid}_expected_{owner_uid}")
        if st.st_mode & 0o022:
            raise SnapshotError(f"WRITABLE_ANCESTOR:{current}")
        if current == target_root:
            break
        if current == current.parent:
            if target_root != Path("/"):
                raise SnapshotError(f"TRUST_ROOT_NOT_REACHED:{target_root}")
            break
        current = current.parent


def check_tree_owner(path: Path, owner_uid: int) -> None:
    for root, dirs, files in os.walk(path):
        for name in dirs + files:
            p = Path(root) / name
            if p.is_symlink():
                raise SnapshotError(f"SYMLINK_IN_TREE:{p}")
            st = p.lstat()
            if st.st_uid != owner_uid:
                raise SnapshotError(f"WRONG_OWNER:{p}:got_{st.st_uid}")
            if st.st_mode & 0o022:
                raise SnapshotError(f"WRITABLE_ENTRY:{p}")


def digest(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(65536):
            h.update(chunk)
    return h.hexdigest()


def control_files(src: Path) -> list[str]:
    src = Path(src)
    found = []
    for rel in TRUST_CLOSURE_FILES:
        target = src / rel
        if not target.is_file() or target.is_symlink():
            raise SnapshotError(f"TRUST_CLOSURE_FILE_MISSING:{rel}")
        found.append(rel)
    return sorted(found)


def control_snapshot(src: Path, dest: Path, *, root_owned: bool = False, trust_root_dir: str = PRODUCTION_TRUST_ROOT) -> str:
    src, dest = Path(src), Path(dest)
    if dest.exists() or dest.is_symlink():
        raise SnapshotError("DEST_EXISTS")
    rels = control_files(src)
    dest.mkdir(parents=True, exist_ok=False)
    lines = []
    for rel in rels:
        target = dest / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        data = (src / rel).read_bytes()
        target.write_bytes(data)
        target.chmod(0o555 if os.access(src / rel, os.X_OK) or rel.endswith((".sh", ".py")) else 0o444)
        lines.append(f"{hashlib.sha256(data).hexdigest()}  {rel}\n")
    text = "".join(lines)
    manifest = dest / CONTROL_MANIFEST_NAME
    manifest.write_text(text, encoding="utf-8")
    manifest.chmod(0o444)
    if root_owned:
        if os.geteuid() != 0:
            raise SnapshotError("ROOT_REQUIRED_FOR_ROOT_OWNED_SNAPSHOT")
        for root, dirs, files in os.walk(dest):
            for name in dirs + files:
                os.chown(Path(root) / name, 0, 0, follow_symlinks=False)
        os.chown(dest, 0, 0, follow_symlinks=False)
        check_tree_owner(dest, 0)
        check_trusted_path(dest, 0, trust_root_dir)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def control_check(snap: Path, expected_manifest_sha256: str, *, owner_uid: int | None = PRODUCTION_OWNER_UID, trust_root_dir: str = PRODUCTION_TRUST_ROOT) -> None:
    snap = Path(snap)
    if owner_uid is not None:
        check_trusted_path(snap, owner_uid, trust_root_dir)
        check_tree_owner(snap, owner_uid)
    manifest = snap / CONTROL_MANIFEST_NAME
    if snap.is_symlink() or not snap.is_dir() or manifest.is_symlink() or not manifest.is_file():
        raise SnapshotError("CONTROL_SNAPSHOT_INVALID")
    if hashlib.sha256(manifest.read_bytes()).hexdigest() != expected_manifest_sha256:
        raise SnapshotError("CONTROL_MANIFEST_DIGEST_MISMATCH")
    listed = {}
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


def check_trust_closure(snap: Path, *, check_permissions: bool = False) -> None:
    snap = Path(snap)
    for rel in TRUST_CLOSURE_FILES:
        target = snap / rel
        if not target.is_file() or target.is_symlink():
            raise SnapshotError(f"TRUST_CLOSURE_MISSING:{rel}")
        if check_permissions and (target.stat().st_mode & (stat.S_IWUSR | stat.S_IWGRP | stat.S_IWOTH)):
            raise SnapshotError(f"TRUST_CLOSURE_FILE_WRITABLE:{rel}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    csnap = sub.add_parser("control-snapshot")
    csnap.add_argument("src", type=Path)
    csnap.add_argument("dest", type=Path)
    csnap.add_argument("--root-owned", action="store_true")
    cchk = sub.add_parser("control-check")
    cchk.add_argument("snapshot", type=Path)
    cchk.add_argument("manifest_sha256")
    tc = sub.add_parser("trust-closure")
    tc.add_argument("snapshot", type=Path)
    tc.add_argument("--check-permissions", action="store_true")
    args = parser.parse_args(argv)
    try:
        trust = trust_root()
        if args.command == "control-snapshot":
            manifest_sha = control_snapshot(args.src, args.dest, root_owned=args.root_owned, trust_root_dir=trust)
            print(f"CTU_CONTROL_MANIFEST_SHA256={manifest_sha}")
            print("CTU_TRUST_CLOSURE=PASS")
        elif args.command == "control-check":
            control_check(args.snapshot, args.manifest_sha256, trust_root_dir=trust)
            check_trust_closure(args.snapshot, check_permissions=True)
            print("CTU_CONTROL_SNAPSHOT=PASS")
            print("CTU_TRUST_CLOSURE=PASS")
        elif args.command == "trust-closure":
            check_trust_closure(args.snapshot, check_permissions=args.check_permissions)
            print("CTU_TRUST_CLOSURE=PASS")
    except (SnapshotError, OSError) as exc:
        print(f"CTU_VERIFIER_SNAPSHOT=FAIL reason={exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
