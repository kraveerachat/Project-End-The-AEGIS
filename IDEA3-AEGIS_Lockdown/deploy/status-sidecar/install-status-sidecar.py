#!/usr/bin/env python3
"""Owner-run installer for the IDEA3 status sidecar package (repository tooling; INERT unless an authorized owner invokes it).

Authority: doc/Content/13_STATUS_SIDECAR_PACKAGING.md. It installs a COMPLETED, already-verified output of
``build-status-sidecar.py`` into ``/opt/aegis-idea3-status/releases/<release-id>/`` and switches ``/opt/aegis-idea3-status/current``.

Commands: ``plan`` (read-only), ``install``, ``activate``, ``rollback``, ``status`` (read-only).

Boundaries, all deliberate and tested against disposable roots only:

* It touches ONLY ``<host-root>/opt/aegis-idea3-status``. It never references ``/opt/aegis-idea3`` (the Core release tree), Recovery files,
  ``/run``, ``/etc``, systemd, Docker, the network, MQTT or any device. It never enables, starts, stops, reloads or restarts a unit, and
  never restarts the Core. After a successful ``activate`` the owner restarts nothing automatically; any unit action is a separate,
  written owner decision.
* Live mode (no ``--host-root``) requires root and root-owned results. The ownership contract is never weakened by a general switch;
  ``--fixture-dest-owner-any`` is accepted ONLY together with ``--host-root`` (a fixture filesystem root).
* Source: a builder output directory only, re-verified with the REAL builder verifier (imported, never a copied predicate) before any
  mutation, on the staged copy before the final atomic rename, and on the installed result. Strict allowlist, SHA-256, manifest,
  import audit; no symlinks; nothing group/world writable.
* Never overwrites an existing release id, never deletes a release, never follows a symlink, never installs unverified content.
* The target interpreter is checked (CPython/POSIX, at or above the declared floor, same minor as tested unless
  ``--accept-untested-python``). Python is never installed or changed.
* ``current`` and ``previous`` are relative symlinks to ``releases/<id>``, switched atomically (temporary symlink + rename). ``rollback``
  re-verifies the target in full and only ever selects an already-installed, verified release. A rollback sends nothing to any device.
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


def _load_builder():
    spec = importlib.util.spec_from_file_location("build_status_sidecar_shared", HERE / "build-status-sidecar.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


_builder = _load_builder()
ReleaseError = _builder.ReleaseError

LOGICAL_ROOT = "/opt/aegis-idea3-status"
CORE_ROOT = "/opt/aegis-idea3"
DEFAULT_PYTHON = "/usr/bin/python3"
RELEASE_ID_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", re.ASCII)
PARENT_DIR_MODE = 0o755
STAGE_PREFIX = ".install-tmp-"
FIXTURE_MARKER = ".aegis-sidecar-fixture-root"
# A fixture root may never be, or sit inside, one of these locations.
SYSTEM_LOCATIONS = tuple(Path(p) for p in (
    "/opt", "/etc", "/usr", "/boot", "/bin", "/sbin", "/lib", "/lib64", "/sys", "/proc", "/dev", "/root", "/run",
    "/var/lib", "/var/log", "/var/run"))


class Refusal(Exception):
    pass


def refuse(code: str) -> None:
    raise Refusal(code)


def _host(host_root: str, logical: str) -> Path:
    return Path(f"{host_root.rstrip('/')}{logical}") if host_root else Path(logical)


def _within(path: Path, base: Path) -> bool:
    return path == base or base in path.parents


def validate_fixture_root(host_root: str) -> Path:
    """Return the checked fixture root or refuse. The result is a disposable directory that cannot alias the real destination."""
    raw = Path(host_root)
    if not raw.is_absolute():
        refuse("HOST_ROOT_MUST_BE_ABSOLUTE")
    if host_root != os.path.normpath(host_root) or any(part in ("..", ".") for part in raw.parts):
        refuse("HOST_ROOT_NOT_CANONICAL")
    if raw == Path("/"):
        refuse("HOST_ROOT_IS_FILESYSTEM_ROOT")
    if raw.is_symlink():
        refuse("HOST_ROOT_IS_SYMLINK")
    real = Path(os.path.realpath(raw))
    if real != raw:
        refuse("HOST_ROOT_ALIAS")
    for system in SYSTEM_LOCATIONS:
        if _within(real, system):
            refuse("HOST_ROOT_IN_SYSTEM_LOCATION")
    if not raw.is_dir():
        refuse("HOST_ROOT_NOT_A_DIRECTORY")
    for production in (Path(LOGICAL_ROOT), Path(CORE_ROOT)):
        resolved = Path(os.path.realpath(production))
        if _within(resolved, real) or _within(real, resolved):
            refuse("HOST_ROOT_ALIASES_PRODUCTION")
    marker = raw / FIXTURE_MARKER
    try:
        info = marker.lstat()
    except OSError:
        refuse("HOST_ROOT_NOT_APPROVED_FIXTURE")
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid():
        refuse("HOST_ROOT_NOT_APPROVED_FIXTURE")
    return real


class Layout:
    def __init__(self, host_root: str, fixture_owner_any: bool, fixture_allow_dirty: bool = False):
        if (fixture_owner_any or fixture_allow_dirty) and not host_root:
            refuse("FIXTURE_OVERRIDE_REQUIRES_HOST_ROOT")
        if not host_root and os.geteuid() != 0:
            refuse("LIVE_INSTALL_REQUIRES_ROOT")
        if host_root:
            validate_fixture_root(host_root)
        self.host_root = host_root
        self.root = _host(host_root, LOGICAL_ROOT)
        self.releases = self.root / "releases"
        self.core = _host(host_root, CORE_ROOT)
        self.owner = "any" if fixture_owner_any else "root"
        self.allow_dirty = bool(fixture_allow_dirty)
        if _within(self.root, self.core) or _within(self.core, self.root):
            refuse("SIDECAR_ROOT_ALIASES_CORE")
        if host_root:
            real_root = Path(os.path.realpath(self.root))
            if not _within(real_root, Path(os.path.realpath(host_root))) or real_root in (Path(LOGICAL_ROOT), Path(CORE_ROOT)):
                refuse("HOST_ROOT_ESCAPE")

    def release_path(self, release_id: str) -> Path:
        return self.releases / release_id

    def ensure_inside(self, path: Path) -> None:
        if not _within(Path(os.path.abspath(path)), self.root):
            refuse("PATH_OUTSIDE_SIDECAR_ROOT")


def _validate_id(release_id: str) -> str:
    if not isinstance(release_id, str) or not RELEASE_ID_RE.fullmatch(release_id) or ".." in release_id:
        refuse("RELEASE_ID_INVALID")
    return release_id


def _check_dir(path: Path, layout: Layout) -> None:
    info = path.lstat()
    if stat.S_ISLNK(info.st_mode):
        refuse("DESTINATION_PARENT_IS_SYMLINK")
    if not stat.S_ISDIR(info.st_mode):
        refuse("PARENT_DIR_NOT_A_DIRECTORY")
    if stat.S_IMODE(info.st_mode) & 0o022:
        refuse("PARENT_DIR_WRITABLE_BY_GROUP_OR_OTHER")
    if layout.owner == "root" and info.st_uid != 0:
        refuse("PARENT_DIR_NOT_ROOT_OWNED")


def _ensure_parents(layout: Layout) -> None:
    """Create only the sidecar root and releases directory when missing (0755); every existing ancestor is validated, never modified."""
    stop = Path(layout.host_root) if layout.host_root else Path("/")
    chain, node = [], layout.releases
    while True:
        chain.append(node)
        if node == stop or node.parent == node:
            break
        node = node.parent
    for node in reversed(chain):
        if node.is_symlink():
            refuse("DESTINATION_PARENT_IS_SYMLINK")
        if node.exists():
            _check_dir(node, layout)
        elif node in (layout.root, layout.releases):
            node.mkdir(mode=PARENT_DIR_MODE)
            os.chmod(node, PARENT_DIR_MODE)
        else:
            refuse("DESTINATION_ANCESTOR_MISSING")


def _copy_tree(src: Path, dst: Path) -> None:
    dst.mkdir(mode=0o755)
    os.chmod(dst, 0o755)
    for entry in sorted(src.iterdir()):
        info = entry.lstat()
        if stat.S_ISLNK(info.st_mode) or not (stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode)):
            refuse("SOURCE_CHANGED_DURING_COPY")
        target = dst / entry.name
        if stat.S_ISDIR(info.st_mode):
            _copy_tree(entry, target)
        else:
            shutil.copyfile(entry, target, follow_symlinks=False)
            os.chmod(target, 0o644)


def _verify(path: Path, owner: str, release_id: str | None = None) -> dict:
    try:
        return _builder.verify_sidecar(path, expect_owner=owner, release_id=release_id)
    except ReleaseError as exc:
        refuse(f"VERIFY_FAILED:{exc}")
    raise AssertionError  # pragma: no cover


def _verify_clean(layout: Layout, path: Path, owner: str, release_id: str | None = None) -> dict:
    """Verify, then refuse a package built from a dirty source tree unless a validated fixture explicitly allows it."""
    info = _verify(path, owner, release_id)
    if info["source_tree_dirty"] and not layout.allow_dirty:
        refuse("DIRTY_SOURCE_NOT_ALLOWED")
    return info


def _runtime(source: Path, python: str, accept_untested: bool) -> str:
    try:
        version = _builder.check_runtime_compatible(source, python, accept_untested=accept_untested)
    except ReleaseError as exc:
        refuse(f"PYTHON_RUNTIME_INCOMPATIBLE:{exc}")
    return ".".join(map(str, version))


def _read_link(link: Path) -> str | None:
    """Return the release id a ``current``/``previous`` link selects, or None when it is absent. Anything unexpected is a refusal."""
    if not link.is_symlink():
        if link.exists():
            refuse(f"{link.name.upper()}_NOT_A_SYMLINK")
        return None
    target = os.readlink(link)
    m = re.fullmatch(r"releases/([A-Za-z0-9][A-Za-z0-9._-]{0,127})", target)
    if not m or ".." in m.group(1):
        refuse(f"{link.name.upper()}_TARGET_UNEXPECTED")
    return m.group(1)


def _set_link(layout: Layout, name: str, release_id: str) -> None:
    link = layout.root / name
    layout.ensure_inside(link)
    temporary = layout.root / f".{name}-tmp-{os.getpid()}"
    if temporary.is_symlink() or temporary.exists():
        temporary.unlink()
    os.symlink(f"releases/{release_id}", temporary)
    try:
        os.replace(temporary, link)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise


def _leftovers(layout: Layout) -> list[str]:
    if not layout.releases.is_dir():
        return []
    return sorted(p.name for p in layout.releases.iterdir() if p.name.startswith(STAGE_PREFIX))


def plan(layout: Layout, release_id: str, source: Path, python: str, accept_untested: bool) -> dict:
    _validate_id(release_id)
    info = _verify_clean(layout, source, "any", release_id)
    version = _runtime(source, python, accept_untested)
    dest = layout.release_path(release_id)
    return {"release_id": release_id, "source_git_sha": info["source_git_sha"], "python_runtime": version,
            "destination_exists": dest.exists() or dest.is_symlink(), "leftover_staging": _leftovers(layout),
            "current": _read_link(layout.root / "current") if layout.root.exists() else None}


def install(layout: Layout, release_id: str, source: Path, python: str, accept_untested: bool) -> dict:
    _validate_id(release_id)
    _verify_clean(layout, source, "any", release_id)
    _runtime(source, python, accept_untested)
    dest = layout.release_path(release_id)
    if dest.is_symlink() or dest.exists():
        refuse("RELEASE_ALREADY_INSTALLED")
    _ensure_parents(layout)
    layout.ensure_inside(dest)
    stage = Path(tempfile.mkdtemp(prefix=f"{STAGE_PREFIX}{release_id}-", dir=layout.releases))
    stage.rmdir()
    try:
        _copy_tree(source, stage)
        _verify_clean(layout, stage, layout.owner, release_id)
        if dest.is_symlink() or dest.exists():
            refuse("RELEASE_ALREADY_INSTALLED")
        os.rename(stage, dest)
    except BaseException:
        shutil.rmtree(stage, ignore_errors=True)
        raise
    info = _verify_clean(layout, dest, layout.owner, release_id)
    return {"release_id": release_id, "source_git_sha": info["source_git_sha"]}


def activate(layout: Layout, release_id: str, python: str, accept_untested: bool) -> dict:
    _validate_id(release_id)
    dest = layout.release_path(release_id)
    if not dest.is_dir() or dest.is_symlink():
        refuse("RELEASE_NOT_INSTALLED")
    info = _verify_clean(layout, dest, layout.owner, release_id)
    _runtime(dest, python, accept_untested)
    current = _read_link(layout.root / "current")
    if current == release_id:
        refuse("ALREADY_CURRENT")
    if current is not None:
        _verify(layout.release_path(current), layout.owner, current)  # never record an unverifiable "previous"
        _set_link(layout, "previous", current)
    _set_link(layout, "current", release_id)
    return {"release_id": release_id, "previous": current, "source_git_sha": info["source_git_sha"]}


def rollback(layout: Layout, python: str, accept_untested: bool, to: str | None = None) -> dict:
    current = _read_link(layout.root / "current")
    if current is None:
        refuse("NO_CURRENT_RELEASE")
    target = _validate_id(to) if to else _read_link(layout.root / "previous")
    if target is None:
        refuse("NO_PREVIOUS_RELEASE")
    if target == current:
        refuse("ROLLBACK_TARGET_IS_CURRENT")
    dest = layout.release_path(target)
    if not dest.is_dir() or dest.is_symlink():
        refuse("ROLLBACK_TARGET_NOT_INSTALLED")
    _verify_clean(layout, dest, layout.owner, target)
    _runtime(dest, python, accept_untested)
    _set_link(layout, "previous", current)
    _set_link(layout, "current", target)
    return {"release_id": target, "previous": current}


def status(layout: Layout) -> dict:
    releases = sorted(p.name for p in layout.releases.iterdir() if not p.name.startswith(".")) if layout.releases.is_dir() else []
    return {"current": _read_link(layout.root / "current") if layout.root.exists() else None,
            "previous": _read_link(layout.root / "previous") if layout.root.exists() else None,
            "releases": releases, "leftover_staging": _leftovers(layout)}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--host-root", default="", help="FIXTURE ONLY: prefix for a disposable filesystem root")
    ap.add_argument("--fixture-dest-owner-any", action="store_true", help="FIXTURE ONLY: refused without --host-root")
    ap.add_argument("--fixture-allow-dirty", action="store_true", help="FIXTURE ONLY: accept a synthetic dirty-source package; refused in live mode")
    ap.add_argument("--python", default=DEFAULT_PYTHON)
    ap.add_argument("--accept-untested-python", action="store_true")
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("plan", "install"):
        s = sub.add_parser(name)
        s.add_argument("--release-id", required=True)
        s.add_argument("--source", required=True)
    s = sub.add_parser("activate")
    s.add_argument("--release-id", required=True)
    s = sub.add_parser("rollback")
    s.add_argument("--to")
    sub.add_parser("status")
    args = ap.parse_args(argv)
    try:
        layout = Layout(args.host_root, args.fixture_dest_owner_any, args.fixture_allow_dirty)
        if args.cmd == "plan":
            result = plan(layout, args.release_id, Path(args.source), args.python, args.accept_untested_python)
        elif args.cmd == "install":
            result = install(layout, args.release_id, Path(args.source), args.python, args.accept_untested_python)
        elif args.cmd == "activate":
            result = activate(layout, args.release_id, args.python, args.accept_untested_python)
        elif args.cmd == "rollback":
            result = rollback(layout, args.python, args.accept_untested_python, args.to)
        else:
            result = status(layout)
    except Refusal as exc:
        print(f"STATUS_SIDECAR_{args.cmd.upper()}=FAIL reason={exc}")
        return 1
    print(f"STATUS_SIDECAR_{args.cmd.upper()}=PASS")
    for key, value in result.items():
        print(f"{key.upper()}={value}")
    print("SYSTEMD_ACTION=NONE")
    print("CORE_TOUCHED=NO")
    return 0


if __name__ == "__main__":
    sys.exit(main())
