#!/usr/bin/env python3
"""L6c release-catalog tree-state digest (read-only). Authority:
docs/superpowers/specs/2026-09-27-idea3-pr11-phase4-l6c-release-install-governance.md.

Computes ONE deterministic digest over the ACTUAL current filesystem state of a single release directory
(/opt/aegis-idea3/releases/<id>) — never over its own provenance files' claims about itself. This is what lets
p4-l0-capture.sh detect drift that RELEASE-SHA256SUMS alone is blind to: a payload file modified without touching the
sums file, a chmod/chown of any entry, a directory-mode change, an added or removed entry, or a symlink/special file
planted inside the tree.

The digest input, for every entry in deterministic relative-path order (the release root itself included, as "."),
is: relative path, entry type, uid, gid, permission bits, and — for a regular file only — SHA256 of its actual bytes.
A symlink is NEVER followed: its target string is hashed instead (so a retargeted symlink is detected without ever
opening what it points to). Regular files are opened with O_NOFOLLOW; the opened inode and metadata must match the
preceding lstat and remain stable through the read. A special file (fifo, socket, device) contributes no content, only
its own metadata, since reading one could block or has no meaningful "payload" bytes.

Fails closed: any entry this process cannot lstat/read (permission denied, vanished mid-scan, unreadable file bytes)
makes the whole digest UNAVAILABLE rather than silently omitting that entry from the hash. The whole tree is rescanned
after hashing and any observed identity/metadata change makes the result UNAVAILABLE. This is not an atomic filesystem
snapshot: a sufficiently privileged ABA mutation that changes and restores an entry entirely between checks cannot be
excluded without filesystem snapshot support. The live contract therefore also requires these root-owned immutable
release trees to be quiescent while captured. Never prints an individual path or value — stdout is exactly one line,
either the 64-hex digest or ``UNREADABLE``.
"""

from __future__ import annotations

import hashlib
import os
import stat
import sys
from pathlib import Path


class Unreadable(Exception):
    pass


def _entry_type(mode: int) -> str:
    if stat.S_ISDIR(mode):
        return "d"
    if stat.S_ISREG(mode):
        return "f"
    if stat.S_ISLNK(mode):
        return "l"
    return "o"  # fifo, socket, device, or anything else — metadata only, never opened


def _stat_signature(info: os.stat_result) -> tuple[int, int, int, int, int, int, int, int]:
    return (
        info.st_dev,
        info.st_ino,
        info.st_mode,
        info.st_uid,
        info.st_gid,
        info.st_size,
        info.st_mtime_ns,
        info.st_ctime_ns,
    )


def _sha256_file(path: Path, expected: os.stat_result) -> str:
    digest = hashlib.sha256()
    if not hasattr(os, "O_NOFOLLOW"):
        raise Unreadable("O_NOFOLLOW_UNAVAILABLE")
    fd = -1
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        opened = os.fstat(fd)
        if _stat_signature(opened) != _stat_signature(expected):
            raise Unreadable("ENTRY_CHANGED_BEFORE_READ")
        while True:
            chunk = os.read(fd, 1 << 20)
            if not chunk:
                break
            digest.update(chunk)
        if _stat_signature(os.fstat(fd)) != _stat_signature(opened):
            raise Unreadable("ENTRY_CHANGED_DURING_READ")
    except OSError as exc:
        raise Unreadable(str(exc)) from exc
    finally:
        if fd >= 0:
            os.close(fd)
    return digest.hexdigest()


def _scan(root: Path) -> list[tuple[str, os.stat_result]]:
    """Every entry under root (root itself included), lstat'd — never stat'd, so a symlink is never followed to
    decide whether to recurse into it."""
    out: list[tuple[str, os.stat_result]] = []

    def walk(path: Path, rel: str) -> None:
        try:
            info = path.lstat()
        except OSError as exc:
            raise Unreadable(str(exc)) from exc
        out.append((rel, info))
        if stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode):
            try:
                children = sorted(os.listdir(path))
            except OSError as exc:
                raise Unreadable(str(exc)) from exc
            for name in children:
                child_rel = name if rel == "." else f"{rel}/{name}"
                walk(path / name, child_rel)

    walk(root, ".")
    return out


def _update_entry_metadata(digest: "hashlib._Hash", rel: str, info: os.stat_result, etype: str) -> None:
    digest.update(rel.encode("utf-8", "surrogateescape"))
    digest.update(b"\0")
    digest.update(etype.encode("ascii"))
    digest.update(b"\0")
    digest.update(str(info.st_uid).encode("ascii"))
    digest.update(b"\0")
    digest.update(str(info.st_gid).encode("ascii"))
    digest.update(b"\0")
    digest.update(format(stat.S_IMODE(info.st_mode), "04o").encode("ascii"))
    digest.update(b"\0")


def tree_state_digest(root: Path) -> str:
    if not root.is_dir() or root.is_symlink():
        raise Unreadable("NOT_A_DIRECTORY")
    entries = _scan(root)
    entries.sort(key=lambda e: e[0])
    digest = hashlib.sha256()
    for rel, info in entries:
        etype = _entry_type(info.st_mode)
        _update_entry_metadata(digest, rel, info, etype)
        if etype == "f":
            digest.update(_sha256_file(root / rel if rel != "." else root, info).encode("ascii"))
        elif etype == "l":
            try:
                target = os.readlink(root / rel if rel != "." else root)
            except OSError as exc:
                raise Unreadable(str(exc)) from exc
            digest.update(target.encode("utf-8", "surrogateescape"))
        digest.update(b"\n")
    if [(rel, _stat_signature(info)) for rel, info in _scan(root)] != [
        (rel, _stat_signature(info)) for rel, info in entries
    ]:
        raise Unreadable("TREE_CHANGED_DURING_SCAN")
    return digest.hexdigest()


def main() -> int:
    if len(sys.argv) != 2:
        print("UNREADABLE")
        return 1
    try:
        print(tree_state_digest(Path(sys.argv[1])))
        return 0
    except Unreadable:
        print("UNREADABLE")
        return 1


if __name__ == "__main__":
    sys.exit(main())
