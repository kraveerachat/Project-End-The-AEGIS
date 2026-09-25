#!/usr/bin/env python3
"""Deterministic L7 release builder and verifier (repository tooling only).

Authority: IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-09-21-idea3-pr11-phase4-l7-operational-design.md (OD-L7-05)
Regression tests: IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l7_release_builder.py

Produces, in a USER-OWNED staging directory, the release layout the L7 release guard expects at
/opt/aegis-idea3/releases/<release-id>/ :

    venv/bin/python                  (copied interpreter, dependencies installed from a LOCAL wheelhouse)
    aegis_soc/...                    (exactly the runtime closure of `python -m aegis_soc.supervisor`, computed from source)
    requirements.txt
    RELEASE-MANIFEST.json            (exact allowlisted fields, no username/host/environment/secret paths)
    RELEASE-SHA256SUMS               (every payload file except itself, sorted)

Deliberate boundaries:

* It never writes /opt (or any system location), never uses sudo, never chowns, never touches systemd, NetworkManager, rfkill,
  iw or nftables, and never installs into a global or user site. Installation into /opt (root ownership, atomic `current`
  symlink switch) is a separate owner-run future step; `verify --expect-owner root` is its post-install check.
* Dependencies come only from `--wheelhouse` (`pip --no-index --isolated --only-binary=:all:`); there is no Internet path.
* Venv creation, pip and the import smoke test are bounded by timeouts and run with a scrubbed environment.
* The release holds NO symlinks at all (the venv `lib64` link is removed, the interpreter is a copy), no `.git`, no
  `__pycache__`, no credential-like files, and nothing group/world writable.
* Runtime closure and third-party imports are derived by AST from the source. A local import that cannot be resolved, or a
  third-party import that has no matching pin in requirements.txt, fails the build (no silently invented dependencies).
  Dynamic imports (importlib) are not traced; the only one in the closure (platform_lock) loads stdlib modules.

`--allow-dirty` exists for local experiments and records `source_tree_dirty: true`; a normal build refuses a dirty tree.
"""

from __future__ import annotations

import argparse
import ast
import hashlib
import json
import os
import platform
import re
import shutil
import stat
import subprocess
import sys
from pathlib import Path

TOOL_VERSION = "1"
SCHEMA_VERSION = 1
PACKAGE = "aegis_soc"
PROJECT_DIR = "IDEA3-AEGIS_Lockdown"
ENTRYPOINT = "supervisor"

RELEASE_ID_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", re.ASCII)
SHA1_RE = re.compile(r"[0-9a-f]{40}", re.ASCII)
SHA256_RE = re.compile(r"[0-9a-f]{64}", re.ASCII)
PYVER_RE = re.compile(r"\d+\.\d+\.\d+[A-Za-z0-9.+-]*", re.ASCII)
TOOLVER_RE = re.compile(r"\d+(\.\d+)*", re.ASCII)
MANIFEST_FIELDS = (
    "schema_version", "release_id", "source_git_sha", "source_tree_dirty", "python_version",
    "requirements_sha256", "file_count", "created_by_tool_version",
)
MANIFEST_NAME = "RELEASE-MANIFEST.json"
SUMS_NAME = "RELEASE-SHA256SUMS"
TOP_LEVEL = {"venv", PACKAGE, "requirements.txt", MANIFEST_NAME, SUMS_NAME}

# import name -> requirements.txt distribution name. Anything else third-party is refused.
DIST_FOR_IMPORT = {"paho": "paho-mqtt"}

VENV_TIMEOUT_SEC = 120
PIP_TIMEOUT_SEC = 300
SMOKE_TIMEOUT_SEC = 60

FORBIDDEN_STAGING_PREFIXES = (
    "/opt", "/etc", "/usr", "/boot", "/bin", "/sbin", "/lib", "/lib64", "/sys", "/proc", "/dev", "/root",
    "/var/lib", "/var/log", "/var/run", "/run",
)
FORBIDDEN_DIR_NAMES = {".git", "__pycache__", "credentials"}
FORBIDDEN_FILE_RE = re.compile(
    r"(^\.env($|\.)|\.(key|pass|psk|credential|pfx|p12)$|^id_(rsa|dsa|ecdsa|ed25519)|^k_(c2d|d2c)$|^admin\.pin$|^mqtt-core\.pass$)"
)
PRIVATE_KEY_RE = re.compile(rb"-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----")
CONTENT_SCAN_LIMIT = 2_000_000
_VENV_ACTIVATION = ("activate", "activate.csh", "activate.fish", "Activate.ps1")


class ReleaseError(Exception):
    """Any refusal. The message is a stable, secret-free reason."""


def file_kind(mode: int) -> str:
    if stat.S_ISREG(mode):
        return "file"
    if stat.S_ISDIR(mode):
        return "dir"
    if stat.S_ISLNK(mode):
        return "symlink"
    if stat.S_ISFIFO(mode):
        return "fifo"
    if stat.S_ISSOCK(mode):
        return "socket"
    if stat.S_ISCHR(mode) or stat.S_ISBLK(mode):
        return "device"
    return "unknown"


def validate_release_id(release_id: object) -> str:
    if not isinstance(release_id, str) or not RELEASE_ID_RE.fullmatch(release_id) or ".." in release_id:
        raise ReleaseError("RELEASE_ID_INVALID")
    return release_id


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


# ---------------------------------------------------------------- runtime closure (AST)
def _requirement_names(text: str) -> set[str]:
    names = set()
    for line in text.splitlines():
        line = line.split("#", 1)[0].strip()
        if not line or line.startswith("-"):
            continue
        m = re.match(r"[A-Za-z0-9][A-Za-z0-9._-]*", line)
        if m:
            names.add(re.sub(r"[-_.]+", "-", m.group(0)).lower())
    return names


def runtime_closure(project_root: Path, entry: str = ENTRYPOINT) -> tuple[list[str], set[str]]:
    """Return (sorted aegis_soc module names reachable from `entry`, excluding __init__; set of third-party import roots)."""
    pkg = project_root / PACKAGE
    modules = {p.stem for p in pkg.glob("*.py")}
    if entry not in modules:
        raise ReleaseError("ENTRYPOINT_MISSING")
    init_names: set[str] = set()
    init = pkg / "__init__.py"
    if init.is_file():
        for node in ast.parse(init.read_text(encoding="utf-8")).body:
            if isinstance(node, ast.Assign):
                init_names.update(t.id for t in node.targets if isinstance(t, ast.Name))
    stdlib = set(sys.stdlib_module_names)
    seen: set[str] = set()
    third: set[str] = set()
    todo = [entry]
    while todo:
        name = todo.pop()
        if name in seen:
            continue
        seen.add(name)
        tree = ast.parse((pkg / f"{name}.py").read_text(encoding="utf-8"), filename=f"{name}.py")

        def local(mod: str) -> None:
            if mod not in modules:
                raise ReleaseError(f"UNRESOLVED_LOCAL_IMPORT:{mod}")
            todo.append(mod)

        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom):
                if node.level == 1:
                    if node.module:
                        local(node.module.split(".")[0])
                    else:
                        for alias in node.names:
                            if alias.name in modules:
                                todo.append(alias.name)
                            elif alias.name not in init_names:
                                raise ReleaseError(f"UNRESOLVED_LOCAL_IMPORT:{alias.name}")
                elif node.level > 1:
                    raise ReleaseError("RELATIVE_IMPORT_ABOVE_PACKAGE")
                elif node.module:
                    root = node.module.split(".")[0]
                    if root == PACKAGE:
                        parts = node.module.split(".")
                        if len(parts) > 1:
                            local(parts[1])
                        else:
                            for alias in node.names:
                                if alias.name in modules:
                                    todo.append(alias.name)
                                elif alias.name not in init_names:
                                    raise ReleaseError(f"UNRESOLVED_LOCAL_IMPORT:{alias.name}")
                    elif root not in stdlib:
                        third.add(root)
            elif isinstance(node, ast.Import):
                for alias in node.names:
                    parts = alias.name.split(".")
                    if parts[0] == PACKAGE:
                        if len(parts) > 1:
                            local(parts[1])
                    elif parts[0] not in stdlib:
                        third.add(parts[0])
    return sorted(seen - {"__init__"}), third


def _audit_third_party(third: set[str], requirements_text: str) -> None:
    pinned = _requirement_names(requirements_text)
    for root in sorted(third):
        dist = DIST_FOR_IMPORT.get(root)
        if dist is None:
            raise ReleaseError(f"UNMAPPED_THIRD_PARTY_IMPORT:{root}")
        if re.sub(r"[-_.]+", "-", dist).lower() not in pinned:
            raise ReleaseError(f"THIRD_PARTY_IMPORT_NOT_PINNED:{root}")


# ---------------------------------------------------------------- build
def _run(runner, argv, *, timeout, env, cwd=None):
    try:
        result = runner([str(a) for a in argv], stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=timeout,
                        check=False, env=env, cwd=cwd)
    except subprocess.TimeoutExpired as exc:
        raise ReleaseError(f"SUBPROCESS_TIMEOUT:{Path(str(argv[0])).name}") from exc
    if result.returncode != 0:
        tail = (result.stderr or result.stdout or "").strip().splitlines()[-3:]
        raise ReleaseError(f"SUBPROCESS_FAILED:rc={result.returncode}:{' | '.join(tail)[:300]}")
    return result


def _check_staging(staging: Path, source: Path, release_id: str) -> Path:
    absolute = Path(os.path.abspath(staging))
    for prefix in FORBIDDEN_STAGING_PREFIXES:
        if absolute == Path(prefix) or Path(prefix) in absolute.parents:
            raise ReleaseError("STAGING_IN_SYSTEM_LOCATION")
    if staging.is_symlink():
        raise ReleaseError("STAGING_ROOT_IS_SYMLINK")
    ancestor = absolute
    while not ancestor.exists() and ancestor != ancestor.parent:
        ancestor = ancestor.parent
    real = Path(os.path.realpath(ancestor)) / absolute.relative_to(ancestor)
    real_source = Path(os.path.realpath(source))
    if real == real_source or real_source in real.parents or real in real_source.parents:
        raise ReleaseError("STAGING_ALIASES_SOURCE")
    dest = absolute / release_id
    if dest.is_symlink() or dest.exists():
        raise ReleaseError("DESTINATION_EXISTS")
    return absolute


def _git(source: Path, *args: str) -> str:
    env = {"PATH": "/usr/bin:/bin", "LC_ALL": "C", "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_NOSYSTEM": "1"}
    r = subprocess.run(["git", "-C", str(source), *args], capture_output=True, text=True, timeout=60, check=False, env=env,
                       stdin=subprocess.DEVNULL)
    if r.returncode != 0:
        raise ReleaseError("SOURCE_NOT_A_GIT_REPOSITORY")
    return r.stdout.strip()


def _scan_source_package(pkg: Path) -> None:
    for dirpath, dirnames, filenames in os.walk(pkg, followlinks=False):
        dirnames[:] = [d for d in dirnames if d != "__pycache__"]
        for name in [*dirnames, *filenames]:
            kind = file_kind(os.lstat(Path(dirpath) / name).st_mode)
            if kind not in {"file", "dir"}:
                raise ReleaseError(f"SOURCE_{kind.upper()}_REFUSED")


def _finalize_tree(root: Path) -> None:
    """Deterministic permissions, no activation scripts, no symlinks, no pycache, no `command =` line."""
    for path in sorted(root.rglob("__pycache__"), reverse=True):
        shutil.rmtree(path)
    venv = root / "venv"
    for name in _VENV_ACTIVATION:
        (venv / "bin" / name).unlink(missing_ok=True)
    cfg = venv / "pyvenv.cfg"
    cfg.write_text("".join(ln for ln in cfg.read_text().splitlines(keepends=True) if not re.match(r"\s*command\s*=", ln)))
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            path.unlink()          # venv `lib64 -> lib`; nothing in a release may be a symlink
    for path in [root, *sorted(root.rglob("*"))]:
        st = os.lstat(path)
        if stat.S_ISDIR(st.st_mode):
            os.chmod(path, 0o755)
        elif stat.S_ISREG(st.st_mode):
            os.chmod(path, 0o755 if st.st_mode & stat.S_IXUSR else 0o644)


def _payload_files(root: Path) -> list[str]:
    return sorted(p.relative_to(root).as_posix() for p in root.rglob("*")
                  if not p.is_symlink() and p.is_file() and p.name != SUMS_NAME)


def build_release(source_root, staging_root, release_id, wheelhouse, *, allow_dirty=False, runner=subprocess.run) -> Path:
    source = Path(source_root)
    validate_release_id(release_id)
    staging = _check_staging(Path(staging_root), source, release_id)
    wheelhouse = Path(wheelhouse)
    if not wheelhouse.is_dir() or wheelhouse.is_symlink() or not list(wheelhouse.glob("*.whl")):
        raise ReleaseError("WHEELHOUSE_MISSING_OR_EMPTY")

    if Path(_git(source, "rev-parse", "--show-toplevel")).resolve() != source.resolve():
        raise ReleaseError("SOURCE_ROOT_MUST_BE_THE_GIT_ROOT")
    sha = _git(source, "rev-parse", "HEAD")
    if not SHA1_RE.fullmatch(sha):
        raise ReleaseError("SOURCE_SHA_MALFORMED")
    dirty = bool(_git(source, "status", "--porcelain", "--untracked-files=all"))
    if dirty and not allow_dirty:
        raise ReleaseError("SOURCE_TREE_DIRTY")
    project = source / PROJECT_DIR
    pkg = project / PACKAGE
    req_src = project / "requirements.txt"
    if pkg.is_symlink() or not pkg.is_dir() or req_src.is_symlink() or not req_src.is_file():
        raise ReleaseError("SOURCE_LAYOUT_INVALID")
    _scan_source_package(pkg)
    modules, third = runtime_closure(project)
    requirements_text = req_src.read_text(encoding="utf-8")
    _audit_third_party(third, requirements_text)

    staging.mkdir(parents=True, exist_ok=True)
    tmp = staging / f".build-{release_id}-{os.getpid()}"
    tmp.mkdir(mode=0o700)          # exclusive: a leftover of another run is never reused
    try:
        home = tmp.parent / f".home-{release_id}-{os.getpid()}"
        home.mkdir(mode=0o700)
        try:
            _build_into(tmp, home, pkg, modules, third, req_src, wheelhouse, release_id, sha, dirty, runner)
        finally:
            shutil.rmtree(home, ignore_errors=True)
        verify_release(tmp, expect_owner="self", release_id=release_id)
        final = staging / release_id
        if final.is_symlink() or final.exists():
            raise ReleaseError("DESTINATION_EXISTS")
        os.chmod(tmp, 0o755)
        os.rename(tmp, final)
        return final
    except BaseException:
        shutil.rmtree(tmp, ignore_errors=True)
        raise


def _build_into(tmp, home, pkg, modules, third, req_src, wheelhouse, release_id, sha, dirty, runner):
    env = {"PATH": "/usr/bin:/bin", "LC_ALL": "C", "HOME": str(home), "PIP_NO_INPUT": "1",
           "PIP_DISABLE_PIP_VERSION_CHECK": "1", "PYTHONDONTWRITEBYTECODE": "1"}
    dest_pkg = tmp / PACKAGE
    dest_pkg.mkdir()
    for name in ["__init__", *modules]:
        shutil.copyfile(pkg / f"{name}.py", dest_pkg / f"{name}.py")
    shutil.copyfile(req_src, tmp / "requirements.txt")

    venv = tmp / "venv"
    _run(runner, [sys.executable, "-m", "venv", "--copies", "--without-pip", "--without-scm-ignore-files", venv],
         timeout=VENV_TIMEOUT_SEC, env=env)
    py = venv / "bin" / "python"
    if not py.is_file() or py.is_symlink() or not os.access(py, os.X_OK):
        raise ReleaseError("VENV_PYTHON_MISSING")
    # Offline, isolated, wheels only (no sdist build step); pip runs from the builder's interpreter against the new venv.
    _run(runner, [sys.executable, "-m", "pip", "--python", py, "install", "--isolated", "--no-index",
                  "--find-links", wheelhouse, "--only-binary=:all:", "--no-compile", "--no-cache-dir",
                  "--disable-pip-version-check", "-r", tmp / "requirements.txt"],
         timeout=PIP_TIMEOUT_SEC, env=env)
    for root in sorted(third):
        _run(runner, [py, "-I", "-B", "-c", f"import {root}"], timeout=SMOKE_TIMEOUT_SEC, env=env)

    _finalize_tree(tmp)
    manifest = {
        "schema_version": SCHEMA_VERSION,
        "release_id": release_id,
        "source_git_sha": sha,
        "source_tree_dirty": bool(dirty),
        "python_version": platform.python_version(),
        "requirements_sha256": _sha256_file(tmp / "requirements.txt"),
        "file_count": 0,
        "created_by_tool_version": TOOL_VERSION,
    }
    payload = [p for p in _payload_files(tmp) if p != MANIFEST_NAME]
    manifest["file_count"] = len(payload)
    (tmp / MANIFEST_NAME).write_text(json.dumps({k: manifest[k] for k in MANIFEST_FIELDS}, indent=2) + "\n", encoding="utf-8")
    os.chmod(tmp / MANIFEST_NAME, 0o644)
    lines = [f"{_sha256_file(tmp / rel)}  {rel}" for rel in _payload_files(tmp)]
    (tmp / SUMS_NAME).write_text("\n".join(lines) + "\n", encoding="utf-8")
    os.chmod(tmp / SUMS_NAME, 0o644)


# ---------------------------------------------------------------- verify (read-only)
def _owner_ok(uid: int, expect: str) -> bool:
    if expect == "any":
        return True
    return uid == (0 if expect == "root" else os.getuid())


def verify_release(release_dir, *, expect_owner: str = "self", release_id: str | None = None) -> dict:
    """Read-only, deterministic validation. Raises ReleaseError on the first refusal; returns a stable summary."""
    if expect_owner not in {"self", "root", "any"}:
        raise ReleaseError("EXPECT_OWNER_INVALID")
    root = Path(release_dir)
    if root.is_symlink() or not root.is_dir():
        raise ReleaseError("RELEASE_DIR_MISSING_OR_SYMLINK")
    rid = release_id if release_id is not None else root.name
    validate_release_id(rid)

    entries: list[tuple[str, Path, os.stat_result]] = []
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        dirnames.sort()
        for name in sorted([*dirnames, *filenames]):
            path = Path(dirpath) / name
            entries.append((path.relative_to(root).as_posix(), path, os.lstat(path)))
    for rel, path, st in [(".", root, os.lstat(root)), *entries]:
        kind = file_kind(st.st_mode)
        if kind in {"symlink", "fifo", "socket", "device", "unknown"}:
            raise ReleaseError(f"{kind.upper()}_IN_PAYLOAD:{rel}")
        if st.st_mode & (stat.S_IWGRP | stat.S_IWOTH):
            raise ReleaseError(f"GROUP_OR_WORLD_WRITABLE:{rel}")
        if st.st_mode & (stat.S_ISUID | stat.S_ISGID | stat.S_ISVTX):
            raise ReleaseError(f"SPECIAL_MODE_BITS:{rel}")
        if not _owner_ok(st.st_uid, expect_owner):
            raise ReleaseError(f"OWNER_MISMATCH:{rel}")
        parts = rel.split("/")
        if kind == "dir" and (set(parts) & FORBIDDEN_DIR_NAMES):
            raise ReleaseError(f"FORBIDDEN_DIRECTORY:{rel}")
        if kind == "file":
            if set(parts[:-1]) & FORBIDDEN_DIR_NAMES:
                raise ReleaseError(f"FORBIDDEN_DIRECTORY:{rel}")
            if FORBIDDEN_FILE_RE.search(parts[-1]):
                raise ReleaseError(f"CREDENTIAL_LIKE_FILE:{rel}")
            if st.st_size <= CONTENT_SCAN_LIMIT and PRIVATE_KEY_RE.search(path.read_bytes()):
                raise ReleaseError(f"PRIVATE_KEY_MATERIAL:{rel}")
    top = {rel.split("/")[0] for rel, _, _ in entries}
    if top - TOP_LEVEL:
        raise ReleaseError(f"UNEXPECTED_TOP_LEVEL:{min(top - TOP_LEVEL)}")

    py = root / "venv" / "bin" / "python"
    if not py.is_file() or not os.access(py, os.X_OK):
        raise ReleaseError("VENV_PYTHON_MISSING_OR_NOT_EXECUTABLE")
    if not (root / PACKAGE / "supervisor.py").is_file():
        raise ReleaseError("SUPERVISOR_MISSING")
    for required in ("requirements.txt", MANIFEST_NAME, SUMS_NAME):
        if not (root / required).is_file():
            raise ReleaseError(f"REQUIRED_FILE_MISSING:{required}")

    payload = _payload_files(root)
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
    missing = sorted(set(payload) - set(listed))
    extra = sorted(set(listed) - set(payload))
    if missing:
        raise ReleaseError(f"CHECKSUM_ENTRY_MISSING:{missing[0]}")
    if extra:
        raise ReleaseError(f"CHECKSUM_ENTRY_EXTRA:{extra[0]}")
    for rel in payload:
        if _sha256_file(root / rel) != listed[rel]:
            raise ReleaseError(f"CHECKSUM_MISMATCH:{rel}")

    try:
        manifest = json.loads((root / MANIFEST_NAME).read_text(encoding="utf-8"))
    except (ValueError, UnicodeDecodeError) as exc:
        raise ReleaseError("MANIFEST_MALFORMED") from exc
    if not isinstance(manifest, dict) or set(manifest) != set(MANIFEST_FIELDS):
        raise ReleaseError("MANIFEST_FIELDS_INVALID")
    if manifest["schema_version"] != SCHEMA_VERSION or isinstance(manifest["schema_version"], bool):
        raise ReleaseError("MANIFEST_SCHEMA_VERSION_UNSUPPORTED")
    if manifest["release_id"] != rid:
        raise ReleaseError("MANIFEST_RELEASE_ID_MISMATCH")
    if not isinstance(manifest["source_git_sha"], str) or not SHA1_RE.fullmatch(manifest["source_git_sha"]):
        raise ReleaseError("MANIFEST_SOURCE_SHA_MALFORMED")
    if not isinstance(manifest["source_tree_dirty"], bool):
        raise ReleaseError("MANIFEST_DIRTY_FLAG_INVALID")
    if not isinstance(manifest["python_version"], str) or not PYVER_RE.fullmatch(manifest["python_version"]):
        raise ReleaseError("MANIFEST_PYTHON_VERSION_INVALID")
    if not isinstance(manifest["requirements_sha256"], str) or not SHA256_RE.fullmatch(manifest["requirements_sha256"]) \
            or manifest["requirements_sha256"] != _sha256_file(root / "requirements.txt"):
        raise ReleaseError("MANIFEST_REQUIREMENTS_HASH_MISMATCH")
    count = manifest["file_count"]
    if not isinstance(count, int) or isinstance(count, bool) or count != len([p for p in payload if p != MANIFEST_NAME]):
        raise ReleaseError("MANIFEST_FILE_COUNT_MISMATCH")
    if not isinstance(manifest["created_by_tool_version"], str) or not TOOLVER_RE.fullmatch(manifest["created_by_tool_version"]):
        raise ReleaseError("MANIFEST_TOOL_VERSION_INVALID")
    cfg = root / "venv" / "pyvenv.cfg"
    if cfg.is_file():
        m = re.search(r"^version\s*=\s*(\S+)", cfg.read_text(encoding="utf-8"), re.MULTILINE)
        if m and not manifest["python_version"].startswith(m.group(1)):
            raise ReleaseError("PYTHON_VERSION_MISMATCH")

    # The shipped package must be EXACTLY the runtime closure of its own entrypoint, and nothing but modules.
    pkg_files = sorted(p.name for p in (root / PACKAGE).iterdir())
    if any(not n.endswith(".py") for n in pkg_files):
        raise ReleaseError("NON_MODULE_FILE_IN_PACKAGE")
    modules, third = runtime_closure(root)
    if {n[:-3] for n in pkg_files} != {"__init__", *modules}:
        raise ReleaseError("PACKAGE_IS_NOT_THE_RUNTIME_CLOSURE")
    _audit_third_party(third, (root / "requirements.txt").read_text(encoding="utf-8"))
    return {"release_id": rid, "source_git_sha": manifest["source_git_sha"], "file_count": count,
            "source_tree_dirty": manifest["source_tree_dirty"], "python_version": manifest["python_version"]}


# ---------------------------------------------------------------- CLI
def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Build / verify an L7 release directory (repository tooling; no host mutation).")
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build")
    b.add_argument("--source-root", required=True)
    b.add_argument("--staging-root", required=True)
    b.add_argument("--release-id", required=True)
    b.add_argument("--wheelhouse", required=True)
    b.add_argument("--allow-dirty", action="store_true")
    v = sub.add_parser("verify")
    v.add_argument("release_dir")
    v.add_argument("--expect-owner", choices=("self", "root", "any"), default="self")
    args = ap.parse_args(argv)
    label = "L7_RELEASE_BUILD" if args.cmd == "build" else "L7_RELEASE_VERIFY"
    try:
        if args.cmd == "build":
            final = build_release(args.source_root, args.staging_root, args.release_id, args.wheelhouse,
                                  allow_dirty=args.allow_dirty)
            info = verify_release(final, expect_owner="self")
        else:
            info = verify_release(args.release_dir, expect_owner=args.expect_owner)
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
