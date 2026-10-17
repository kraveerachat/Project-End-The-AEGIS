#!/usr/bin/env python3
"""Deterministic builder and verifier for the IDEA3 status sidecar package (repository tooling only).

Why a separate package: the governed Core release (``deploy/pr11-phase4/p4-l7-build-release.py``) is exactly the ``aegis_soc``
runtime closure of four entrypoints, and the release guard, the installer and the F1u/R1Du/RRu upgrade engines pin that file set.
The status publisher and pusher live in ``tools/`` and are not part of it, so they can never run from an installed Core
release. This tool packages them WITHOUT touching the Core release contract:

    aegis_soc/__init__.py  observer.py  dispatch_client.py  status_projection.py
    tools/status_projection_publisher.py  status_push_client.py
    SIDECAR-MANIFEST.json            (exact allowlisted fields)
    SIDECAR-SHA256SUMS               (every payload file except itself, sorted)

Deliberate boundaries:

* The file set is an explicit allowlist (SIDECAR_FILES). Anything else, missing or extra, fails verification. There is no
  closure expansion: an import outside the allowlist or the standard library fails the build.
* Standard library only: no venv, no wheelhouse, no pip, no third-party code, no Core module (no MQTT, controller, restore or
  CUT code can be present). The sidecar runs with the host ``python3 -E -s -B`` from its own root directory.
* No symlinks, no ``.git``, no ``__pycache__``, no credential-like files, nothing group/world writable, no special modes.
* The manifest and checksum file names differ from the Core release's, so neither verifier can accept the other layout.
* It never writes ``/opt`` or any system location, never uses sudo/chown, never touches systemd, and installs nothing.
  Installing a built sidecar is a separate owner-run step.
* Python: pure Python, no architecture dependence. The manifest records the interpreter it was built and smoke-tested with
  (``python_version``) and the declared floor (``python_requires_min``); the installer checks the target interpreter with
  ``check_runtime_compatible`` and refuses an older one, a non-CPython/non-POSIX one, and (unless the owner accepts it) another minor.
* Sources must come from a clean git tree (``--allow-dirty`` records ``source_tree_dirty: true``).
"""

from __future__ import annotations

import argparse
import ast
import importlib.util
import json
import os
import platform
import re
import shutil
import stat
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
_CORE_BUILDER = HERE.parent / "pr11-phase4" / "p4-l7-build-release.py"


def _load_core_builder():
    spec = importlib.util.spec_from_file_location("p4_l7_build_release_shared", _CORE_BUILDER)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


_core = _load_core_builder()
ReleaseError = _core.ReleaseError

TOOL_VERSION = "1"
SCHEMA_VERSION = 1
KIND = "aegis-idea3-status-sidecar"
PROJECT_DIR = _core.PROJECT_DIR
MANIFEST_NAME = "SIDECAR-MANIFEST.json"
SUMS_NAME = "SIDECAR-SHA256SUMS"
MANIFEST_FIELDS = (
    "schema_version", "kind", "release_id", "source_git_sha", "source_tree_dirty", "python_version", "python_requires_min",
    "file_count", "created_by_tool_version",
)
# Declared interpreter floor: the Core itself needs 3.11 (StrEnum), and the shipped syntax is valid from 3.8. Only `python_version`
# (the builder's interpreter) was actually executed; the manifest never claims more than that. A runtime of another minor version is
# refused unless the owner explicitly accepts it at install time.
PYTHON_MIN = (3, 11)
PYTHON_MIN_TEXT = ".".join(map(str, PYTHON_MIN))
_RUNTIME_PROBE = "import os,platform,sys;print(sys.version_info[0],sys.version_info[1],sys.version_info[2],platform.python_implementation(),os.name)"
# The ONLY source files that enter the sidecar, relative to IDEA3-AEGIS_Lockdown/.
SIDECAR_FILES = (
    "aegis_soc/__init__.py",
    "aegis_soc/dispatch_client.py",
    "aegis_soc/observer.py",
    "aegis_soc/status_projection.py",
    "tools/status_projection_publisher.py",
    "tools/status_push_client.py",
)
TOP_LEVEL = {"aegis_soc", "tools", MANIFEST_NAME, SUMS_NAME}
# Core modules that must never be reachable from, or present in, the sidecar.
CORE_MODULES_FORBIDDEN = (
    "aegis_soc.runtime", "aegis_soc.controller", "aegis_soc.mqtt_client", "aegis_soc.local_restore", "aegis_soc.local_cut",
    "aegis_soc.cut_client", "aegis_soc.supervisor", "aegis_soc.database", "paho",
)
FORBIDDEN_STDLIB = frozenset({"subprocess", "ctypes", "pickle", "marshal", "importlib", "pty", "multiprocessing", "sqlite3"})
SMOKE_TIMEOUT_SEC = 60
_SIDECAR_MODULES = {"aegis_soc": {"dispatch_client", "observer", "status_projection"}, "tools": {"status_projection_publisher", "status_push_client"}}


def _import_audit(root: Path) -> None:
    """Every import in the shipped files is stdlib or inside the allowlist; no dynamic-import or process-spawning module."""
    stdlib = set(sys.stdlib_module_names)
    for rel in SIDECAR_FILES:
        tree = ast.parse((root / rel).read_text(encoding="utf-8"), filename=rel)
        for node in ast.walk(tree):
            names: list[tuple[str, str | None]] = []
            if isinstance(node, ast.Import):
                names = [(a.name, None) for a in node.names]
            elif isinstance(node, ast.ImportFrom):
                if node.level:
                    raise ReleaseError(f"SIDECAR_RELATIVE_IMPORT:{rel}")
                names = [(node.module or "", a.name) for a in node.names]
            for module, member in names:
                top = module.split(".")[0]
                if top in FORBIDDEN_STDLIB:
                    raise ReleaseError(f"SIDECAR_FORBIDDEN_STDLIB_IMPORT:{top}:{rel}")
                if top in stdlib:
                    continue
                if top in _SIDECAR_MODULES:
                    parts = module.split(".")
                    leaf = parts[1] if len(parts) > 1 else member
                    if leaf not in _SIDECAR_MODULES[top]:
                        raise ReleaseError(f"SIDECAR_IMPORT_OUTSIDE_ALLOWLIST:{module}.{member or ''}:{rel}")
                    continue
                raise ReleaseError(f"SIDECAR_IMPORT_OUTSIDE_ALLOWLIST:{top}:{rel}")


def _payload_files(root: Path) -> list[str]:
    return sorted(p.relative_to(root).as_posix() for p in root.rglob("*")
                  if not p.is_symlink() and p.is_file() and p.name != SUMS_NAME)


def probe_runtime(python: str | os.PathLike, *, runner=subprocess.run) -> tuple[int, int, int]:
    """Run ``python -I`` (scrubbed environment, bounded) and return its version, or raise ReleaseError.

    Only CPython on a POSIX host is accepted: the publisher relies on ``O_NOFOLLOW``/``O_DIRECTORY`` directory-fd semantics.
    """
    try:
        result = runner([str(python), "-I", "-c", _RUNTIME_PROBE], stdin=subprocess.DEVNULL, capture_output=True, text=True,
                        timeout=20, check=False, env={"PATH": "/usr/bin:/bin", "LC_ALL": "C"})
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise ReleaseError("PYTHON_RUNTIME_UNUSABLE") from exc
    parts = (result.stdout or "").split()
    if result.returncode != 0 or len(parts) != 5 or not all(p.isdigit() for p in parts[:3]):
        raise ReleaseError("PYTHON_RUNTIME_UNUSABLE")
    if parts[3] != "CPython" or parts[4] != "posix":
        raise ReleaseError("PYTHON_RUNTIME_UNSUPPORTED_PLATFORM")
    return int(parts[0]), int(parts[1]), int(parts[2])


def check_runtime_compatible(release_dir, python: str | os.PathLike, *, accept_untested: bool = False, runner=subprocess.run) -> tuple[int, int, int]:
    """Refuse an interpreter below the declared floor, and a different minor than the one the package was tested with unless accepted."""
    manifest = json.loads((Path(release_dir) / MANIFEST_NAME).read_text(encoding="utf-8"))
    version = probe_runtime(python, runner=runner)
    if version[:2] < PYTHON_MIN:
        raise ReleaseError(f"PYTHON_RUNTIME_TOO_OLD:{version[0]}.{version[1]}<{PYTHON_MIN_TEXT}")
    tested = tuple(int(x) for x in manifest["python_version"].split(".")[:2])
    if version[:2] != tested and not accept_untested:
        raise ReleaseError(f"PYTHON_RUNTIME_UNTESTED_MINOR:{version[0]}.{version[1]}!={tested[0]}.{tested[1]}")
    return version


def build_sidecar(source_root, staging_root, release_id, *, allow_dirty=False, runner=subprocess.run) -> Path:
    if sys.version_info[:2] < PYTHON_MIN:
        raise ReleaseError("BUILDER_PYTHON_TOO_OLD")
    source = Path(source_root)
    _core.validate_release_id(release_id)
    staging = _core._check_staging(Path(staging_root), source, release_id)
    if Path(_core._git(source, "rev-parse", "--show-toplevel")).resolve() != source.resolve():
        raise ReleaseError("SOURCE_ROOT_MUST_BE_THE_GIT_ROOT")
    sha = _core._git(source, "rev-parse", "HEAD")
    if not _core.SHA1_RE.fullmatch(sha):
        raise ReleaseError("SOURCE_SHA_MALFORMED")
    dirty = bool(_core._git(source, "status", "--porcelain", "--untracked-files=all"))
    if dirty and not allow_dirty:
        raise ReleaseError("SOURCE_TREE_DIRTY")
    project = source / PROJECT_DIR
    for rel in SIDECAR_FILES:
        path = project / rel
        if path.is_symlink() or not path.is_file() or Path(os.path.realpath(path)) != Path(os.path.realpath(project)) / rel:
            raise ReleaseError(f"SOURCE_FILE_MISSING_OR_SYMLINK:{rel}")
    _import_audit(project)

    staging.mkdir(parents=True, exist_ok=True)
    tmp = staging / f".build-{release_id}-{os.getpid()}"
    tmp.mkdir(mode=0o700)
    try:
        for rel in SIDECAR_FILES:
            (tmp / rel).parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(project / rel, tmp / rel)
        smoke(tmp, runner=runner)
        for path in sorted(tmp.rglob("__pycache__"), reverse=True):
            shutil.rmtree(path)
        for path in [tmp, *sorted(tmp.rglob("*"))]:
            os.chmod(path, 0o755 if path.is_dir() else 0o644)
        payload = _payload_files(tmp)
        manifest = {
            "schema_version": SCHEMA_VERSION, "kind": KIND, "release_id": release_id, "source_git_sha": sha,
            "source_tree_dirty": bool(dirty), "python_version": platform.python_version(), "python_requires_min": PYTHON_MIN_TEXT, "file_count": len(payload),
            "created_by_tool_version": TOOL_VERSION,
        }
        (tmp / MANIFEST_NAME).write_text(json.dumps({k: manifest[k] for k in MANIFEST_FIELDS}, indent=2) + "\n", encoding="utf-8")
        os.chmod(tmp / MANIFEST_NAME, 0o644)
        lines = [f"{_core._sha256_file(tmp / rel)}  {rel}" for rel in _payload_files(tmp)]
        (tmp / SUMS_NAME).write_text("\n".join(lines) + "\n", encoding="utf-8")
        os.chmod(tmp / SUMS_NAME, 0o644)
        verify_sidecar(tmp, expect_owner="self", release_id=release_id)
        final = staging / release_id
        if final.is_symlink() or final.exists():
            raise ReleaseError("DESTINATION_EXISTS")
        os.rename(tmp, final)
        return final
    except BaseException:
        shutil.rmtree(tmp, ignore_errors=True)
        raise


def smoke(root: Path, *, runner=subprocess.run) -> None:
    """Import the shipped modules with the production flags and prove no Core module or third-party package got loaded."""
    code = (
        "import sys\n"
        "import aegis_soc.dispatch_client, aegis_soc.observer, aegis_soc.status_projection\n"
        "import tools.status_projection_publisher, tools.status_push_client\n"
        f"bad = [m for m in {CORE_MODULES_FORBIDDEN!r} if m in sys.modules]\n"
        "assert not bad, bad\n"
        "where = lambda m: getattr(m, '__file__', None) or next(iter(m.__path__))\n"
        "assert all(where(sys.modules[m]).startswith(sys.argv[1]) for m in sys.modules if m.split('.')[0] in ('aegis_soc', 'tools'))\n"
    )
    env = {"PATH": "/usr/bin:/bin", "LC_ALL": "C", "PYTHONDONTWRITEBYTECODE": "1"}
    result = runner([sys.executable, "-E", "-s", "-B", "-c", code, str(root)], stdin=subprocess.DEVNULL, capture_output=True,
                    text=True, timeout=SMOKE_TIMEOUT_SEC, check=False, env=env, cwd=root)
    if result.returncode != 0:
        tail = (result.stderr or result.stdout or "").strip().splitlines()[-2:]
        raise ReleaseError(f"SIDECAR_SMOKE_FAILED:{' | '.join(tail)[:300]}")


def verify_sidecar(release_dir, *, expect_owner: str = "self", release_id: str | None = None) -> dict:
    """Read-only, deterministic validation. Raises ReleaseError on the first refusal; returns a stable summary."""
    if expect_owner not in {"self", "root", "any"}:
        raise ReleaseError("EXPECT_OWNER_INVALID")
    root = Path(release_dir)
    if root.is_symlink() or not root.is_dir():
        raise ReleaseError("RELEASE_DIR_MISSING_OR_SYMLINK")
    rid = release_id if release_id is not None else root.name
    _core.validate_release_id(rid)

    entries: list[tuple[str, Path, os.stat_result]] = []
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        dirnames.sort()
        for name in sorted([*dirnames, *filenames]):
            path = Path(dirpath) / name
            entries.append((path.relative_to(root).as_posix(), path, os.lstat(path)))
    for rel, path, st in [(".", root, os.lstat(root)), *entries]:
        kind = _core.file_kind(st.st_mode)
        if kind in {"symlink", "fifo", "socket", "device", "unknown"}:
            raise ReleaseError(f"{kind.upper()}_IN_PAYLOAD:{rel}")
        if st.st_mode & (stat.S_IWGRP | stat.S_IWOTH):
            raise ReleaseError(f"GROUP_OR_WORLD_WRITABLE:{rel}")
        if st.st_mode & (stat.S_ISUID | stat.S_ISGID | stat.S_ISVTX):
            raise ReleaseError(f"SPECIAL_MODE_BITS:{rel}")
        if not _core._owner_ok(st.st_uid, expect_owner):
            raise ReleaseError(f"OWNER_MISMATCH:{rel}")
        parts = rel.split("/")
        if set(parts) & _core.FORBIDDEN_DIR_NAMES:
            raise ReleaseError(f"FORBIDDEN_DIRECTORY:{rel}")
        if kind == "file":
            if _core.FORBIDDEN_FILE_RE.search(parts[-1]):
                raise ReleaseError(f"CREDENTIAL_LIKE_FILE:{rel}")
            if st.st_size <= _core.CONTENT_SCAN_LIMIT and _core.PRIVATE_KEY_RE.search(path.read_bytes()):
                raise ReleaseError(f"PRIVATE_KEY_MATERIAL:{rel}")
    top = {rel.split("/")[0] for rel, _, _ in entries}
    if top - TOP_LEVEL:
        raise ReleaseError(f"UNEXPECTED_TOP_LEVEL:{min(top - TOP_LEVEL)}")
    for required in (MANIFEST_NAME, SUMS_NAME):
        if not (root / required).is_file():
            raise ReleaseError(f"REQUIRED_FILE_MISSING:{required}")

    payload = _payload_files(root)
    expected = sorted([*SIDECAR_FILES, MANIFEST_NAME])
    if payload != expected:
        missing = sorted(set(expected) - set(payload))
        extra = sorted(set(payload) - set(expected))
        raise ReleaseError(f"PAYLOAD_NOT_THE_ALLOWLIST:{'missing=' + missing[0] if missing else 'extra=' + extra[0]}")

    listed: dict[str, str] = {}
    previous = ""
    for line in (root / SUMS_NAME).read_text(encoding="utf-8").splitlines():
        m = re.fullmatch(r"([0-9a-f]{64})  (\S.*)", line)
        if not m:
            raise ReleaseError("CHECKSUM_LINE_MALFORMED")
        digest, rel = m.groups()
        if rel.startswith("/") or ".." in rel.split("/") or rel == SUMS_NAME:
            raise ReleaseError("CHECKSUM_PATH_INVALID")
        if rel in listed:
            raise ReleaseError(f"CHECKSUM_DUPLICATE:{rel}")
        if rel < previous:
            raise ReleaseError("CHECKSUM_FILE_NOT_SORTED")
        listed[rel] = digest
        previous = rel
    if set(listed) != set(payload):
        raise ReleaseError(f"CHECKSUM_ENTRY_{'MISSING' if set(payload) - set(listed) else 'EXTRA'}")
    for rel in payload:
        if _core._sha256_file(root / rel) != listed[rel]:
            raise ReleaseError(f"CHECKSUM_MISMATCH:{rel}")

    try:
        manifest = json.loads((root / MANIFEST_NAME).read_text(encoding="utf-8"))
    except (ValueError, UnicodeDecodeError) as exc:
        raise ReleaseError("MANIFEST_MALFORMED") from exc
    if not isinstance(manifest, dict) or set(manifest) != set(MANIFEST_FIELDS):
        raise ReleaseError("MANIFEST_FIELDS_INVALID")
    if manifest["schema_version"] != SCHEMA_VERSION or isinstance(manifest["schema_version"], bool):
        raise ReleaseError("MANIFEST_SCHEMA_VERSION_UNSUPPORTED")
    if manifest["kind"] != KIND:
        raise ReleaseError("MANIFEST_KIND_INVALID")
    if manifest["release_id"] != rid:
        raise ReleaseError("MANIFEST_RELEASE_ID_MISMATCH")
    if not isinstance(manifest["source_git_sha"], str) or not _core.SHA1_RE.fullmatch(manifest["source_git_sha"]):
        raise ReleaseError("MANIFEST_SOURCE_SHA_MALFORMED")
    if not isinstance(manifest["source_tree_dirty"], bool):
        raise ReleaseError("MANIFEST_DIRTY_FLAG_INVALID")
    if not isinstance(manifest["python_version"], str) or not _core.PYVER_RE.fullmatch(manifest["python_version"]):
        raise ReleaseError("MANIFEST_PYTHON_VERSION_INVALID")
    if manifest["python_requires_min"] != PYTHON_MIN_TEXT:
        raise ReleaseError("MANIFEST_PYTHON_REQUIRES_INVALID")
    if tuple(int(x) for x in manifest["python_version"].split(".")[:2]) < PYTHON_MIN:
        raise ReleaseError("MANIFEST_PYTHON_VERSION_BELOW_FLOOR")
    count = manifest["file_count"]
    if not isinstance(count, int) or isinstance(count, bool) or count != len([p for p in payload if p != MANIFEST_NAME]):
        raise ReleaseError("MANIFEST_FILE_COUNT_MISMATCH")
    if not isinstance(manifest["created_by_tool_version"], str) or not _core.TOOLVER_RE.fullmatch(manifest["created_by_tool_version"]):
        raise ReleaseError("MANIFEST_TOOL_VERSION_INVALID")
    _import_audit(root)
    return {"release_id": rid, "source_git_sha": manifest["source_git_sha"], "file_count": count,
            "source_tree_dirty": manifest["source_tree_dirty"], "python_version": manifest["python_version"]}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Build / verify the IDEA3 status sidecar package (repository tooling; no host mutation).")
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build")
    b.add_argument("--source-root", required=True)
    b.add_argument("--staging-root", required=True)
    b.add_argument("--release-id", required=True)
    b.add_argument("--allow-dirty", action="store_true")
    v = sub.add_parser("verify")
    v.add_argument("release_dir")
    v.add_argument("--expect-owner", choices=("self", "root", "any"), default="self")
    args = ap.parse_args(argv)
    label = "STATUS_SIDECAR_BUILD" if args.cmd == "build" else "STATUS_SIDECAR_VERIFY"
    try:
        if args.cmd == "build":
            final = build_sidecar(args.source_root, args.staging_root, args.release_id, allow_dirty=args.allow_dirty)
            info = verify_sidecar(final, expect_owner="self")
        else:
            info = verify_sidecar(args.release_dir, expect_owner=args.expect_owner)
    except ReleaseError as exc:
        print(f"{label}=FAIL reason={exc}", file=sys.stderr)
        print("PRODUCTION_MUTATION_PERFORMED=NO")
        return 1
    print(f"{label}=PASS")
    print(f"RELEASE_ID={info['release_id']}")
    print(f"SOURCE_GIT_SHA={info['source_git_sha']}")
    print(f"SOURCE_TREE_DIRTY={'YES' if info['source_tree_dirty'] else 'NO'}")
    print(f"FILE_COUNT={info['file_count']}")
    print("PRODUCTION_MUTATION_PERFORMED=NO")
    return 0


if __name__ == "__main__":
    sys.exit(main())
