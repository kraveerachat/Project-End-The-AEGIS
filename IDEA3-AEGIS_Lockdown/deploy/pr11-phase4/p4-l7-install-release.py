#!/usr/bin/env python3
"""L7 release installer (repository-only tooling). Authority: docs/operations/production-runtime.md (Core filesystem
contract), docs/superpowers/specs/2026-09-21-idea3-pr11-phase4-l7-operational-design.md §6 item 5 and its 2026-09-27
amendments (§7), `p4-l7-build-release.py` (PR #208, merged), `p4-l7-release-guard.py` (this branch).

Copies a COMPLETED, ALREADY-VERIFIED builder output directory (`p4-l7-build-release.py build`) into the immutable
destination `/opt/aegis-idea3/releases/<release-id>/`. It is the missing link between the builder (produces a release in a
user-owned staging directory) and the release guard (proves an already-installed release's contract) — nothing else in the
repository copies a built release into place.

Boundaries, all deliberate:

* Ownership contract (2026-09-27 correctness fix): the builder (PR #208) always builds into a USER-OWNED staging
  directory, and the installed immutable release must be ROOT-OWNED. These are validated SEPARATELY: the source is
  always checked at `--expect-owner any` (hard-coded, never a CLI choice — the caller is never asked to chown the
  builder output first), while the staged copy and the final installed release default to `--expect-owner root`. That
  default is never weakened by a general CLI switch. The one exception is `--fixture-dest-owner-any`, a narrowly named
  test-only override that takes effect ONLY together with `--host-root` (a fixture filesystem root) — using it without
  `--host-root` is refused outright, so it can never silently weaken a live install.
* Source: a builder output directory only. Never builds anything, never generates or reads a Production secret (no
  credential filename is referenced anywhere in this file). Re-validated with the REAL, CURRENT
  `p4-l7-release-guard.py` (imported directly from this same directory — never a copied predicate)
  BEFORE any filesystem mutation, and again against the staged copy immediately BEFORE the final atomic placement.
* Destination: exactly `/opt/aegis-idea3/releases/<release-id>/`. Refuses to overwrite an existing release (no
  `--force`, no update mode). Never recurses into `/opt/aegis-idea3` itself. Refuses a symlinked destination or a
  symlinked destination ancestor. Installs through a sibling temporary staging directory
  (`releases/.install-tmp-<release-id>-<random>`, mode 0700) and a single `os.rename` into the final path — atomic on the
  same filesystem, which staging and destination always are here (both under `/opt/aegis-idea3/releases`).
* `current`: this tool NEVER creates, removes, reads as a switch target, or otherwise references
  `/opt/aegis-idea3/current`. `stages/L7/apply.sh` is the sole owner of that symlink (creates it only if absent, refuses to
  move it) so the two workflows can never race or double-own the same mutation.
* Failure: fails closed, no automatic retry (this process makes exactly one attempt and exits). If failure occurs before
  the final rename, only the temporary staging directory is removed. An already-placed immutable release is never removed
  or altered by any later, unrelated installer failure.
* Evidence: an optional `--evidence` file receives exactly `release_id`, `source_git_sha` and the logical destination —
  never a host username, an absolute source/staging path, secret content, or a digest of anything the guard already
  treats as non-secret (the guard's own SHA-256 sums file is the payload provenance; this tool duplicates none of it).

No systemd action, no service start/stop, no ESP32/L8 action: this is a plain, guarded file copy.
"""

from __future__ import annotations

import argparse
import importlib.util
import os
import re
import shutil
import stat
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
RELEASE_ID_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", re.ASCII)
LOGICAL_PREFIX = "/opt/aegis-idea3/releases/"


class Refusal(Exception):
    pass


def refuse(code: str) -> None:
    raise Refusal(code)


def _load_guard():
    spec = importlib.util.spec_from_file_location("p4_l7_release_guard", HERE / "p4-l7-release-guard.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def host_path(root: str, logical: str) -> Path:
    return Path(f"{root.rstrip('/')}{logical}") if root else Path(logical)


# The exact reviewed mode for a parent directory this tool itself creates (root-owned in live mode, since it runs as
# root there). Never writable by group or other, matching the release payload's own contract.
PARENT_DIR_MODE = 0o755


def _ensure_parent_dirs(releases_dir: Path, host_root: str) -> None:
    """Create ONLY the ancestor directories (of releases_dir, inclusive) that do not yet exist, each with the exact
    PARENT_DIR_MODE — never chmod'ing or chown'ing an ancestor that already exists. Every existing ancestor is validated
    (a real directory, never a symlink, never group/other-writable) before any directory is created. Its uid/gid/mode are
    preserved; its mtime may legitimately advance when this install adds a child beneath it. This is the
    L6C_MUTATION_BOUNDARY contract: a parent directory is stage-owned only when this attempt itself had to create it."""
    stop_at = Path(host_root) if host_root else Path(releases_dir.anchor)
    chain: list[Path] = []
    node = releases_dir
    while True:
        chain.append(node)
        if node == stop_at:
            break
        if node.parent == node:
            refuse("DESTINATION_PARENT_OUTSIDE_HOST_ROOT")
        node = node.parent

    missing: list[Path] = []
    for node in reversed(chain):
        if node.is_symlink():
            refuse("DESTINATION_PARENT_IS_SYMLINK")
        if not node.exists():
            missing.append(node)
            continue
        info = node.lstat()
        if not stat.S_ISDIR(info.st_mode):
            refuse("PARENT_DIR_NOT_A_DIRECTORY")
        if stat.S_IMODE(info.st_mode) & 0o022:
            refuse("PARENT_DIR_WRITABLE_BY_GROUP_OR_OTHER")

    for d in missing:
        d.mkdir(mode=PARENT_DIR_MODE)
        os.chmod(d, PARENT_DIR_MODE)  # mkdir's mode is ANDed with the caller's umask; normalize explicitly so a
        # restrictive inherited umask (e.g. stages/L6c/apply.sh's `umask 077`) can never narrow a newly-created
        # parent below the reviewed mode. Never applied to an already-existing ancestor (see loop above).


def _copy_tree(src: Path, dst: Path) -> None:
    """Copy src into dst (dst does not yet exist), rejecting anything that is not a plain file or directory and
    stripping group/other write bits. The source was already proven free of symlinks/specials by the guard; this is a
    second, independent check against a TOCTOU change between the guard call and the copy."""
    dst.mkdir(mode=0o755)
    os.chmod(dst, 0o755)  # same umask-narrowing hazard as _ensure_parent_dirs: normalize every directory this
    # installer itself creates (the release root and every subdirectory copied from the source), independent of
    # the inherited process umask.
    for entry in sorted(src.iterdir()):
        info = entry.lstat()
        if stat.S_ISLNK(info.st_mode) or not (stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode)):
            refuse("SOURCE_CHANGED_DURING_COPY")
        target = dst / entry.name
        if stat.S_ISDIR(info.st_mode):
            _copy_tree(entry, target)
        else:
            shutil.copyfile(entry, target, follow_symlinks=False)
            mode = 0o755 if info.st_mode & stat.S_IXUSR else 0o644
            os.chmod(target, mode)


SOURCE_GUARD_OWNER = "any"  # the builder output is always user-owned; never derived from a CLI flag
DEFAULT_INSTALLED_GUARD_OWNER = "root"  # the immutable release contract; never weakened by a general CLI switch


def install(*, release_id: str, source: Path, logical: str, host_root: str, fixture_dest_owner_any: bool,
            evidence: Path | None) -> tuple[str, str]:
    if not RELEASE_ID_RE.fullmatch(release_id):
        refuse("RELEASE_ID_INVALID")
    if logical != LOGICAL_PREFIX + release_id:
        refuse("LOGICAL_PATH_RELEASE_ID_MISMATCH")
    if fixture_dest_owner_any and not host_root:
        refuse("FIXTURE_OWNER_OVERRIDE_REQUIRES_HOST_ROOT")
    dest_owner = "any" if fixture_dest_owner_any else DEFAULT_INSTALLED_GUARD_OWNER

    guard = _load_guard()
    try:
        guard.check(logical, source, SOURCE_GUARD_OWNER)
    except guard.Refusal as exc:
        refuse(f"RELEASE_GUARD_FAILED:{exc}")

    dest = host_path(host_root, logical)
    releases_dir = dest.parent
    if dest.is_symlink():
        refuse("DESTINATION_IS_SYMLINK")
    if dest.exists():
        refuse("RELEASE_ALREADY_INSTALLED")
    _ensure_parent_dirs(releases_dir, host_root)

    stage = Path(tempfile.mkdtemp(prefix=f".install-tmp-{release_id}-", dir=releases_dir))
    stage.rmdir()  # mkdtemp creates it 0700; _copy_tree creates the real one so its own mode is explicit and consistent
    try:
        _copy_tree(source, stage)
        try:
            guard.check(logical, stage, dest_owner)
        except guard.Refusal as exc:
            refuse(f"POST_COPY_GUARD_FAILED:{exc}")
        if dest.exists() or dest.is_symlink():
            refuse("RELEASE_ALREADY_INSTALLED")
        os.rename(stage, dest)
    except Exception:
        if stage.exists():
            shutil.rmtree(stage, ignore_errors=True)
        raise

    manifest_sha = guard.check(logical, dest, dest_owner)
    release, sha = manifest_sha
    if evidence is not None:
        with open(evidence, "a", encoding="utf-8") as handle:
            handle.write(f"release_id\t{release}\n")
            handle.write(f"source_git_sha\t{sha}\n")
            handle.write(f"logical_path\t{logical}\n")
    return release, sha


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    inst = sub.add_parser("install")
    inst.add_argument("--release-id", required=True)
    inst.add_argument("--source", required=True)
    inst.add_argument("--logical-path", required=True)
    inst.add_argument("--host-root", default="")
    inst.add_argument("--fixture-dest-owner-any", action="store_true",
                       help="FIXTURE-ONLY: accept a non-root-owned staged/installed release. Has no effect and is refused "
                            "outright unless --host-root is also given; never usable against the real filesystem.")
    inst.add_argument("--evidence")
    args = parser.parse_args()
    try:
        release_id, sha = install(release_id=args.release_id, source=Path(args.source), logical=args.logical_path,
                                   host_root=args.host_root, fixture_dest_owner_any=args.fixture_dest_owner_any,
                                   evidence=Path(args.evidence) if args.evidence else None)
    except Refusal as exc:
        print(f"L7_RELEASE_INSTALL=FAIL reason={exc}")
        return 1
    print(f"L7_RELEASE_INSTALL=PASS release_id={release_id} source_git_sha={sha}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
