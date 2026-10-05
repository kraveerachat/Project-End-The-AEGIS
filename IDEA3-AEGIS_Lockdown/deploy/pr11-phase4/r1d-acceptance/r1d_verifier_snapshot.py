#!/usr/bin/env python3
"""R1D verifier-authority tooling (repository tooling; authorises nothing live, touches no Production).

Root executes the R1 acceptance verifier during a LIVE R1D attempt, so it must never run from mutable application bytes. This tool computes the COMPLETE local import closure of
``aegis_soc.r1_acceptance`` (every ``aegis_soc`` module whose code can affect R1 acceptance semantics, found by walking the AST of each module for import statements at any depth), writes a
manifest of SHA-256 digests, and builds an immutable (read-only) snapshot of exactly that closure OUTSIDE the mutable worktree. The frozen runner pins the manifest digest and executes
BASELINE and FINAL only from that snapshot, re-proving it immediately before each use.

Subcommands: ``closure SRC_APP``; ``manifest SRC_APP``; ``snapshot SRC_APP DEST`` (DEST must not exist); ``check SNAPSHOT MANIFEST``.

The same model protects the LIVE CONTROL PLANE (the shell libraries, stage handlers, stage gate, capture and compare scripts and helpers that the frozen runner sources and that root executes):
``control-snapshot SRC_P4 DEST`` copies the WHOLE ``deploy/pr11-phase4`` tree (a deliberate superset: no static analysis gap can leave a sourced or executed file out) into a NEW read-only directory with a
manifest named ``R1D-CONTROL-SHA256SUMS``; ``control-check SNAPSHOT MANIFEST_SHA256`` re-proves it. The frozen runner re-proves it inline before it sources anything and before every root execution.
"""

from __future__ import annotations

import argparse
import ast
import hashlib
import os
import stat
import sys
from pathlib import Path

ENTRY = "historical_disposition"
PACKAGE = "aegis_soc"
MANIFEST_NAME = "R1D-VERIFIER-SHA256SUMS"
CONTROL_MANIFEST_NAME = "R1D-CONTROL-SHA256SUMS"


class SnapshotError(ValueError):
    pass


# --- PRODUCTION OWNERSHIP INVARIANT -----------------------------------------------------------------------------------------------------------------
# A read-only mode alone does not protect a snapshot from the uid that owns it (that uid can chmod it writable and replace bytes between a gate and a privileged execution). The live invariant is:
#   * the snapshot root and EVERY file and directory inside it are owned by uid 0 (root);
#   * nothing inside is group/world writable;
#   * EVERY ancestor of the snapshot path, up to and including the designated trusted parent (``/`` in production), is a real directory (no symlink) owned by uid 0 and not group/world writable;
#   * the path is canonical (no symlink component).
# ``owner_uid``/``trust_root`` are parameters only so hermetic tests can exercise the same code under a user namespace; every production entry point uses the defaults (0 and ``/``).
PRODUCTION_OWNER_UID = 0
PRODUCTION_TRUST_ROOT = "/"
# The production trust root is LITERALLY ``/`` and no CLI option can narrow it. The only alternative is an explicit TEST seam (both variables together), honoured ONLY inside a user namespace: the real (initial)
# root namespace refuses it, a half-set seam is refused everywhere, and the root must be a canonical absolute directory. The frozen runner and the library refuse/forward these names unchanged.
TEST_SEAM_ENABLED = "R1D_TEST_ONLY_SNAPSHOT_TRUST_ENABLED"
TEST_SEAM_ROOT = "R1D_TEST_ONLY_SNAPSHOT_TRUST_ROOT"


def _initial_user_namespace() -> bool:
    """True in the real (initial) user namespace, i.e. on the production host. Inside a user namespace the uid map is not the identity map."""
    try:
        parts = Path("/proc/self/uid_map").read_text().split()
    except OSError:
        return True  # unknown: treat as the real namespace (the seam stays refused)
    return parts[:3] == ["0", "0", "4294967295"]


def trust_root() -> str:
    """The designated trusted parent for every production entry point: ``/`` unless the guarded TEST seam is set (user namespace only)."""
    enabled, root = os.environ.get(TEST_SEAM_ENABLED), os.environ.get(TEST_SEAM_ROOT)
    if enabled is None and root is None:
        return PRODUCTION_TRUST_ROOT
    if enabled != "YES" or not root:
        raise SnapshotError("TEST_TRUST_SEAM_INCOMPLETE")
    if _initial_user_namespace():
        raise SnapshotError("TEST_TRUST_SEAM_REFUSED_IN_THE_REAL_ROOT_NAMESPACE")
    if not root.startswith("/") or ".." in root.split("/") or not Path(root).is_dir() or Path(os.path.realpath(root)) != Path(os.path.abspath(root)):
        raise SnapshotError("TEST_TRUST_SEAM_ROOT_INVALID")
    return root


def check_trusted_path(path: Path, owner_uid: int = PRODUCTION_OWNER_UID, trust_root: str = PRODUCTION_TRUST_ROOT) -> None:
    """The snapshot path is canonical and every ancestor up to the trusted parent is a real directory owned by ``owner_uid`` and not group/world writable."""
    p = Path(os.path.abspath(path))
    if Path(os.path.realpath(p)) != p:
        raise SnapshotError("SNAPSHOT_PATH_NOT_CANONICAL")
    trust = Path(trust_root)
    if trust != p and trust not in p.parents:
        raise SnapshotError("TRUST_ROOT_NOT_AN_ANCESTOR")
    for directory in [p, *p.parents]:
        st = directory.lstat()
        if not stat.S_ISDIR(st.st_mode) or stat.S_ISLNK(st.st_mode):
            raise SnapshotError(f"SNAPSHOT_ANCESTOR_NOT_A_DIRECTORY:{directory}")
        if st.st_uid != owner_uid:
            raise SnapshotError(f"SNAPSHOT_ANCESTOR_NOT_TRUSTED_OWNER:{directory}")
        if st.st_mode & (stat.S_IWGRP | stat.S_IWOTH):
            raise SnapshotError(f"SNAPSHOT_ANCESTOR_WRITABLE:{directory}")
        if directory == trust:
            return
    raise SnapshotError("TRUST_ROOT_NOT_REACHED")


def check_tree_owner(root: Path, owner_uid: int = PRODUCTION_OWNER_UID) -> None:
    """Every entry of the snapshot (and the root itself) is owned by ``owner_uid`` and none is group/world writable; no symlink."""
    root = Path(root)
    entries = [root]
    for current, dirs, files in os.walk(root):
        entries.extend(Path(current) / name for name in dirs + files)
    for entry in entries:
        st = entry.lstat()
        if stat.S_ISLNK(st.st_mode):
            raise SnapshotError("SYMLINK_IN_SNAPSHOT")
        if not (stat.S_ISREG(st.st_mode) or stat.S_ISDIR(st.st_mode)):
            raise SnapshotError(f"SPECIAL_FILE_IN_TREE:{entry.relative_to(root) if entry != root else '.'}")
        if st.st_uid != owner_uid:
            raise SnapshotError(f"SNAPSHOT_ENTRY_NOT_TRUSTED_OWNER:{entry.relative_to(root) if entry != root else '.'}")
        if st.st_mode & (stat.S_IWGRP | stat.S_IWOTH):
            raise SnapshotError(f"SNAPSHOT_ENTRY_GROUP_OR_WORLD_WRITABLE:{entry.relative_to(root) if entry != root else '.'}")


def read_regular(path: Path) -> bytes:
    """Defence in depth for every privileged source read: never follow a symlink, never block on a FIFO, and read ONLY a regular file (checked on the opened fd)."""
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except OSError:
        raise SnapshotError("SOURCE_READ_REFUSED") from None
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise SnapshotError("SOURCE_NOT_A_REGULAR_FILE")
        chunks = []
        while True:
            chunk = os.read(fd, 1 << 20)
            if not chunk:
                return b"".join(chunks)
            chunks.append(chunk)
    finally:
        os.close(fd)


def check_source_authority(src: Path, trust: str) -> None:
    """PRODUCTION SOURCE AUTHORITY, proven BEFORE any closure parsing, os.walk, open or read of the source: the source path is canonical; the source root and EVERY ancestor to the trust root are real
    directories owned by uid 0 and not group/world writable; then (lstat only: nothing is opened or read) every entry is owned by uid 0, not group/world writable, and neither a symlink nor a special file
    (FIFO, device, socket). Only a root-owned, operator-immutable source (the exact-main authority checkout) can pass."""
    src = Path(src)
    if not src.is_absolute() or os.path.abspath(str(src)) != str(src):
        raise SnapshotError("SOURCE_NOT_ABSOLUTE_AND_CANONICAL")
    try:
        check_trusted_path(src, PRODUCTION_OWNER_UID, trust)
        check_tree_owner(src, PRODUCTION_OWNER_UID)
    except SnapshotError as exc:
        raise SnapshotError(f"SOURCE_NOT_TRUSTED:{exc}") from None


def check_tool_authority(trust: str, tool_dir: Path | None = None) -> None:
    """DEFENCE IN DEPTH for every privileged root-owned freeze/build: the directory holding the RUNNING tool code is canonical, root-owned, has root-owned non-writable ancestors to the trust root and no symlink
    component, and its entries (the tool and every sibling module it imports) are root-owned, non-writable and neither symlinks nor special files. This does NOT by itself solve bootstrap trust: the workflow must
    already execute the tool FROM the root-owned exact-main authority (README section 17, phase A/B)."""
    here = Path(os.path.abspath(__file__)).parent if tool_dir is None else Path(tool_dir)
    if Path(os.path.realpath(here)) != here:
        raise SnapshotError("TOOL_AUTHORITY_PATH_NOT_CANONICAL")
    try:
        check_trusted_path(here, PRODUCTION_OWNER_UID, trust)
        check_tree_owner(here, PRODUCTION_OWNER_UID)
    except SnapshotError as exc:
        raise SnapshotError(f"TOOL_AUTHORITY_NOT_TRUSTED:{exc}") from None


def _prove_privileged_inputs(source: Path, trust: str) -> None:
    if os.geteuid() != 0:
        raise SnapshotError("ROOT_REQUIRED_FOR_ROOT_OWNED_SNAPSHOT")
    check_tool_authority(trust)
    check_source_authority(source, trust)


def _begin_destination(dest: Path, root_owned: bool, trust: str) -> None:
    """Create the NEW top-level destination. A ROOT-OWNED production freeze proves the path BEFORE root creates anything: DEST absolute and canonical, absent (not even a dangling symlink), its parent ALREADY
    existing (never auto-created, never a symlink), canonical, and the parent and EVERY ancestor to the trusted root real directories owned by uid 0 and not group/world writable. DEST is then created
    relative to the verified parent directory fd (inode re-checked), so a substituted parent path is never followed. Non-root-owned (hermetic) builds keep the plain exclusive mkdir."""
    if not root_owned:
        if dest.exists() or dest.is_symlink():
            raise SnapshotError("DEST_EXISTS")
        dest.mkdir(parents=True, mode=0o755)
        return
    if os.geteuid() != 0:
        raise SnapshotError("ROOT_REQUIRED_FOR_ROOT_OWNED_SNAPSHOT")
    if not dest.is_absolute() or os.path.abspath(str(dest)) != str(dest):
        raise SnapshotError("DEST_NOT_ABSOLUTE_AND_CANONICAL")
    if os.path.lexists(dest):
        raise SnapshotError("DEST_EXISTS")
    parent = dest.parent
    if not parent.is_dir() or parent.is_symlink():
        raise SnapshotError("DEST_PARENT_MISSING_OR_SYMLINK")  # the authority parent must already exist; it is never created here
    try:
        check_trusted_path(parent, PRODUCTION_OWNER_UID, trust)
    except SnapshotError as exc:
        raise SnapshotError(f"DEST_PARENT_NOT_TRUSTED:{exc}") from None
    fd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        st, now = os.fstat(fd), parent.lstat()
        if (st.st_dev, st.st_ino) != (now.st_dev, now.st_ino) or st.st_uid != PRODUCTION_OWNER_UID or st.st_mode & 0o022:
            raise SnapshotError("DEST_PARENT_CHANGED_DURING_PROOF")
        try:
            os.mkdir(dest.name, 0o755, dir_fd=fd)  # exclusive, relative to the verified parent
        except FileExistsError:
            raise SnapshotError("DEST_EXISTS") from None
    finally:
        os.close(fd)


def _install_root_owned(dest: Path, trust_root: str) -> None:
    """Freeze step: make the freshly built snapshot root:root and prove the full production invariant. Requires root; never relaxes anything."""
    if os.geteuid() != 0:
        raise SnapshotError("ROOT_REQUIRED_FOR_ROOT_OWNED_SNAPSHOT")
    entries = [Path(dest)]
    for current, dirs, files in os.walk(dest):
        entries.extend(Path(current) / name for name in dirs + files)
    for entry in entries:
        os.chown(entry, 0, 0, follow_symlinks=False)
    check_tree_owner(dest, 0)
    check_trusted_path(dest, 0, trust_root)


def _module_file(app: Path, name: str) -> Path | None:
    base = app / PACKAGE
    path = base / f"{name}.py"
    if path.is_file():
        return path
    pkg = base / name / "__init__.py"
    return pkg if pkg.is_file() else None


def _imports(path: Path) -> set[str]:
    """Local ``aegis_soc`` module names imported anywhere in ``path`` (relative, ``from aegis_soc import x``, ``import aegis_soc.x``)."""
    tree = ast.parse(read_regular(path).decode("utf-8"), filename=str(path))
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
    return hashlib.sha256(read_regular(path)).hexdigest()


def manifest_text(app: Path) -> str:
    return "".join(f"{digest(Path(app) / rel)}  {rel}\n" for rel in closure(Path(app)))


def snapshot(app: Path, dest: Path, *, root_owned: bool = False, trust_root: str = PRODUCTION_TRUST_ROOT) -> str:
    """Copy exactly the closure into a NEW directory, write the manifest, make everything read-only. Returns the manifest SHA-256."""
    app, dest = Path(app), Path(dest)
    if root_owned:
        _prove_privileged_inputs(app, trust_root)  # tool authority + SOURCE authority, BEFORE closure() parses or reads anything
    rels = closure(app)
    _begin_destination(dest, root_owned, trust_root)
    for rel in rels:
        target = dest / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(read_regular(app / rel))
        target.chmod(0o444)
    text = manifest_text(dest)
    manifest = dest / MANIFEST_NAME
    manifest.write_text(text, encoding="utf-8")
    manifest.chmod(0o444)
    for directory in sorted({p.parent for p in (dest / rel for rel in rels)} | {dest}, key=lambda p: -len(p.parts)):
        directory.chmod(0o555)
    if root_owned:
        _install_root_owned(dest, trust_root)
        check(dest, hashlib.sha256(text.encode()).hexdigest(), owner_uid=PRODUCTION_OWNER_UID, trust_root=trust_root)  # the full proof again, after creation
    return hashlib.sha256(text.encode()).hexdigest()


def check(snap: Path, expected_manifest_sha256: str, *, owner_uid: int | None = PRODUCTION_OWNER_UID, trust_root: str = PRODUCTION_TRUST_ROOT) -> None:
    """Fail closed unless the snapshot is EXACTLY the pinned manifest: manifest digest, every file's digest, no extra file, no symlink, AND (production default) the root-ownership invariant.
    ``owner_uid=None`` skips ONLY the ownership invariant (hermetic tests of the digest logic); every production caller uses the default."""
    snap = Path(snap)
    if owner_uid is not None:
        check_trusted_path(snap, owner_uid, trust_root)
        check_tree_owner(snap, owner_uid)
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


def control_snapshot(src: Path, dest: Path, *, root_owned: bool = False, trust_root: str = PRODUCTION_TRUST_ROOT) -> str:
    """Copy the whole control tree into a NEW directory (preserving the executable bit), write the manifest, make everything read-only. Returns the manifest SHA-256."""
    src, dest = Path(src), Path(dest)
    if root_owned:
        _prove_privileged_inputs(src, trust_root)  # tool authority + SOURCE authority, BEFORE control_files() scans or reads anything
    rels = control_files(src)
    _begin_destination(dest, root_owned, trust_root)
    lines = []
    for rel in rels:
        target = dest / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        data = read_regular(src / rel)
        target.write_bytes(data)
        target.chmod(0o555 if os.access(src / rel, os.X_OK) else 0o444)
        lines.append(f"{hashlib.sha256(data).hexdigest()}  {rel}\n")
    text = "".join(lines)
    manifest = dest / CONTROL_MANIFEST_NAME
    manifest.write_text(text, encoding="utf-8")
    manifest.chmod(0o444)
    for directory in sorted({p for rel in rels for p in [(dest / rel).parent, *(dest / rel).parent.parents] if dest in (p, *p.parents)}, key=lambda p: -len(p.parts)):
        directory.chmod(0o555)
    if root_owned:
        _install_root_owned(dest, trust_root)
        control_check(dest, hashlib.sha256(text.encode()).hexdigest(), owner_uid=PRODUCTION_OWNER_UID, trust_root=trust_root)  # the full proof again, after creation
    return hashlib.sha256(text.encode()).hexdigest()


def control_check(snap: Path, expected_manifest_sha256: str, *, owner_uid: int | None = PRODUCTION_OWNER_UID, trust_root: str = PRODUCTION_TRUST_ROOT) -> None:
    """Fail closed unless the control snapshot is EXACTLY the pinned manifest: digest, every file, exact file set, no symlink, nothing writable, AND (production default) the root-ownership invariant."""
    snap = Path(snap)
    if owner_uid is not None:
        check_trusted_path(snap, owner_uid, trust_root)
        check_tree_owner(snap, owner_uid)
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
    snap.add_argument("dest")  # kept as the RAW text: pathlib would silently normalise `.` and `//`, hiding a non-canonical destination
    csnap = sub.add_parser("control-snapshot")
    csnap.add_argument("src", type=Path)
    csnap.add_argument("dest")  # raw text, see above
    cchk = sub.add_parser("control-check")
    cchk.add_argument("snapshot", type=Path)
    cchk.add_argument("manifest_sha256")
    chk = sub.add_parser("check")
    chk.add_argument("snapshot", type=Path)
    chk.add_argument("manifest_sha256")
    for builder in (snap, csnap):
        builder.add_argument("--root-owned", action="store_true", help="FREEZE: chown the snapshot root:root and prove the production ownership invariant (must run as root)")
    args = parser.parse_args(argv)
    try:
        trust = trust_root()  # production: the literal `/` (no CLI option); only the guarded user-namespace TEST seam can differ
        if args.command in ("snapshot", "control-snapshot") and args.root_owned and (not args.dest.startswith("/") or os.path.normpath(args.dest) != args.dest):
            raise SnapshotError("DEST_NOT_ABSOLUTE_AND_CANONICAL")  # judged on the raw text, BEFORE anything is created
        if args.command == "closure":
            print("\n".join(closure(args.app)))
        elif args.command == "manifest":
            sys.stdout.write(manifest_text(args.app))
        elif args.command == "control-snapshot":
            print(f"R1D_CONTROL_MANIFEST_SHA256={control_snapshot(args.src, Path(args.dest), root_owned=args.root_owned, trust_root=trust)}")
        elif args.command == "control-check":
            control_check(args.snapshot, args.manifest_sha256, trust_root=trust)
            print("R1D_CONTROL_SNAPSHOT=PASS")
        elif args.command == "snapshot":
            print(f"R1D_VERIFIER_MANIFEST_SHA256={snapshot(args.app, Path(args.dest), root_owned=args.root_owned, trust_root=trust)}")
        else:
            check(args.snapshot, args.manifest_sha256, trust_root=trust)
            print("R1D_VERIFIER_SNAPSHOT=PASS")
    except (SnapshotError, OSError, SyntaxError) as exc:
        print(f"R1D_VERIFIER_SNAPSHOT=FAIL reason={exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
