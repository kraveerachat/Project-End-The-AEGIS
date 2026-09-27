#!/usr/bin/env python3
"""L7 immutable release guard (read-only). Authority: docs/superpowers/specs/2026-09-21-idea3-pr11-phase4-l7-operational-design.md (OD-L7-05).

Proves that an installed Core release exists and carries provenance BEFORE anything is staged or started:

* the logical path is exactly /opt/aegis-idea3/releases/<release-id>; the directory is real (not a symlink);
* no symlink, FIFO, socket or device anywhere inside; nothing group- or other-writable; every entry owned by root when
  ``--expect-owner root`` (the containment helper runs the same tree as root, so the service account must not own it);
* exact top-level layout (venv, aegis_soc, requirements.txt, RELEASE-MANIFEST.json, RELEASE-SHA256SUMS), executable
  ``venv/bin/python`` and ``aegis_soc/supervisor.py``;
* provenance: RELEASE-SHA256SUMS is a sorted ``<sha256>  <path>`` list that matches every payload file exactly (no missing, extra or
  modified file), and RELEASE-MANIFEST.json has exactly the allowlisted fields, the directory's release id, a 40-hex source sha, a
  clean source tree and a matching file count. The layout is the deterministic release builder's (PR #208).

It only reads. It never prints file contents. Output is one stable line: ``L7_RELEASE_GUARD=PASS release_id=.. source_git_sha=..`` or
``L7_RELEASE_GUARD=FAIL reason=<CODE>`` (exit 1).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import stat
import sys
from pathlib import Path

LOGICAL_RE = re.compile(r"/opt/aegis-idea3/releases/([A-Za-z0-9][A-Za-z0-9._-]{0,127})", re.ASCII)
MANIFEST, SUMS = "RELEASE-MANIFEST.json", "RELEASE-SHA256SUMS"
TOP_LEVEL = {"venv", "aegis_soc", "requirements.txt", MANIFEST, SUMS}
FIELDS = ("schema_version", "release_id", "source_git_sha", "source_tree_dirty", "python_version",
          "requirements_sha256", "file_count", "created_by_tool_version")
SHA1_RE = re.compile(r"[0-9a-f]{40}", re.ASCII)


class Refusal(Exception):
    pass


def refuse(code: str) -> None:
    raise Refusal(code)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def check(logical: str, host: Path, expect_owner: str) -> tuple[str, str]:
    match = LOGICAL_RE.fullmatch(logical)
    if not match:
        refuse("LOGICAL_PATH_INVALID")
    release_id = match.group(1)
    if host.is_symlink():
        refuse("RELEASE_IS_SYMLINK")
    if not host.is_dir():
        refuse("RELEASE_MISSING")

    payload: list[str] = []
    for path in [host, *sorted(host.rglob("*"))]:
        info = path.lstat()
        if stat.S_ISLNK(info.st_mode):
            refuse("SYMLINK_IN_RELEASE")
        if not (stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode)):
            refuse("SPECIAL_FILE_IN_RELEASE")
        if info.st_mode & 0o022:
            refuse("WRITABLE_BY_GROUP_OR_OTHER")
        if expect_owner == "root" and info.st_uid != 0:
            refuse("OWNER_INVALID")
        if stat.S_ISREG(info.st_mode) and path.name != SUMS:
            payload.append(path.relative_to(host).as_posix())

    python = host / "venv" / "bin" / "python"
    if not python.is_file() or not os.access(python, os.X_OK):
        refuse("VENV_PYTHON_MISSING_OR_NOT_EXECUTABLE")
    if not (host / "aegis_soc" / "supervisor.py").is_file():
        refuse("SUPERVISOR_MISSING")
    for required in ("requirements.txt", MANIFEST, SUMS):
        if not (host / required).is_file():
            refuse("REQUIRED_FILE_MISSING")
    if {entry.name for entry in host.iterdir()} != TOP_LEVEL:
        refuse("TOP_LEVEL_ENTRIES_INVALID")

    listed: dict[str, str] = {}
    previous = ""
    for line in (host / SUMS).read_text(encoding="utf-8").splitlines():
        parsed = re.fullmatch(r"([0-9a-f]{64})  (\S.*)", line)
        if not parsed:
            refuse("CHECKSUM_LINE_MALFORMED")
        digest, rel = parsed.groups()
        if rel.startswith("/") or ".." in rel.split("/") or rel == SUMS:
            refuse("CHECKSUM_PATH_INVALID")
        if rel in listed:
            refuse("CHECKSUM_DUPLICATE")
        if rel < previous:
            refuse("CHECKSUM_FILE_NOT_SORTED")
        listed[rel] = digest
        previous = rel
    if set(payload) - set(listed):
        refuse("CHECKSUM_ENTRY_MISSING")
    if set(listed) - set(payload):
        refuse("CHECKSUM_ENTRY_EXTRA")
    for rel in payload:
        if sha256_file(host / rel) != listed[rel]:
            refuse("CHECKSUM_MISMATCH")

    try:
        manifest = json.loads((host / MANIFEST).read_text(encoding="utf-8"))
    except (ValueError, UnicodeDecodeError):
        refuse("MANIFEST_MALFORMED")
    if not isinstance(manifest, dict) or set(manifest) != set(FIELDS):
        refuse("MANIFEST_FIELDS_INVALID")
    if manifest["schema_version"] != 1 or isinstance(manifest["schema_version"], bool):
        refuse("MANIFEST_SCHEMA_VERSION_UNSUPPORTED")
    if manifest["release_id"] != release_id:
        refuse("MANIFEST_RELEASE_ID_MISMATCH")
    sha = manifest["source_git_sha"]
    if not isinstance(sha, str) or not SHA1_RE.fullmatch(sha):
        refuse("MANIFEST_SOURCE_SHA_MALFORMED")
    if manifest["source_tree_dirty"] is not False:
        refuse("MANIFEST_SOURCE_TREE_DIRTY")
    count = manifest["file_count"]
    if isinstance(count, bool) or not isinstance(count, int) or count != len([p for p in payload if p != MANIFEST]):
        refuse("MANIFEST_FILE_COUNT_MISMATCH")
    return release_id, sha


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    chk = sub.add_parser("check")
    chk.add_argument("--logical-path", required=True)
    chk.add_argument("--host-path", required=True)
    chk.add_argument("--expect-owner", choices=("root", "any"), default="root")
    args = parser.parse_args()
    try:
        release_id, sha = check(args.logical_path, Path(args.host_path), args.expect_owner)
    except Refusal as exc:
        print(f"L7_RELEASE_GUARD=FAIL reason={exc}")
        return 1
    print(f"L7_RELEASE_GUARD=PASS release_id={release_id} source_git_sha={sha}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
