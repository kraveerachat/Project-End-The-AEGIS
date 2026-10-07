#!/usr/bin/env python3
"""Fail-closed CTu contract for the predecessor-owned Core drop-ins."""

from __future__ import annotations

import argparse
import hashlib
import os
import subprocess
from pathlib import Path


CORE_DROPIN_DIR = Path("/etc/systemd/system/aegis-idea3-core.service.d")
EXPECTED_DROPINS = {
    "10-recovery.conf": "IDEA3-AEGIS_Lockdown/deploy/aegis-idea3-core-recovery.dropin.example",
    "20-f1-alert.conf": "IDEA3-AEGIS_Lockdown/deploy/aegis-idea3-core-alert.dropin.example",
}

REQUIRED_SUPPLEMENTARY_GROUPS = {
    "aegis-idea3-recovery",
    "aegis-idea3-alert",
}

REQUIRED_READ_WRITE_PATHS = {
    "/var/lib/aegis-idea3",
    "/run/aegis-idea3",
    "/var/log/aegis-idea3",
    "/run/aegis-idea3-recovery",
    "/run/aegis-idea3-alert",
}


class DropInContractError(ValueError):
    pass


def validate_effective_unit(
    *,
    supplementary_groups: str | list[str] | set[str] = (),
    read_write_paths: str | list[str] | set[str] = (),
    protect_clock: str = "false",
    user: str = "aegis-idea3",
    no_new_privileges: str = "yes",
    capability_bounding_set: str = "",
    ambient_capabilities: str = "",
) -> None:
    """Validate effective Core unit properties after restart using semantic sets."""
    if isinstance(supplementary_groups, str):
        groups = set(supplementary_groups.split())
    else:
        groups = set(supplementary_groups)
    if not REQUIRED_SUPPLEMENTARY_GROUPS.issubset(groups):
        missing = sorted(REQUIRED_SUPPLEMENTARY_GROUPS - groups)
        raise DropInContractError(
            f"CORE_EFFECTIVE_SUPPLEMENTARY_GROUPS_MISSING:{' '.join(missing)}"
        )

    if isinstance(read_write_paths, str):
        paths = set(read_write_paths.split())
    else:
        paths = set(read_write_paths)
    if not REQUIRED_READ_WRITE_PATHS.issubset(paths):
        missing = sorted(REQUIRED_READ_WRITE_PATHS - paths)
        raise DropInContractError(
            f"CORE_EFFECTIVE_READWRITEPATHS_MISSING:{' '.join(missing)}"
        )

    if protect_clock not in ("false", "no"):
        raise DropInContractError(f"CORE_EFFECTIVE_PROTECTCLOCK_INVALID:{protect_clock}")
    if user != "aegis-idea3":
        raise DropInContractError(f"CORE_EFFECTIVE_USER_INVALID:{user}")
    if no_new_privileges not in ("yes", "true"):
        raise DropInContractError(f"CORE_EFFECTIVE_NNP_INVALID:{no_new_privileges}")
    if capability_bounding_set.strip():
        raise DropInContractError(
            f"CORE_EFFECTIVE_CAPABILITY_BOUND_INVALID:{capability_bounding_set}"
        )
    if ambient_capabilities.strip():
        raise DropInContractError(
            f"CORE_EFFECTIVE_AMBIENT_CAPABILITY_INVALID:{ambient_capabilities}"
        )


def _expected_bytes(repo: Path, main: str, rel: str) -> bytes:
    if len(main) != 40 or any(c not in "0123456789abcdef" for c in main):
        raise DropInContractError("EXACT_MAIN_INVALID")
    env = {**os.environ, "GIT_NO_REPLACE_OBJECTS": "1"}
    proc = subprocess.run(
        ["/usr/bin/git", "-C", str(repo), "cat-file", "-p", f"{main}:{rel}"],
        env=env,
        capture_output=True,
        check=False,
    )
    if proc.returncode != 0:
        raise DropInContractError(f"EXPECTED_TEMPLATE_UNAVAILABLE:{rel}")
    return proc.stdout


def _host_path(root: Path, absolute: Path) -> Path:
    if not absolute.is_absolute() or ".." in absolute.parts:
        raise DropInContractError("HOST_PATH_INVALID")
    return root / absolute.relative_to("/")


def validate_dropins(
    repo: Path,
    main: str,
    root: Path = Path("/"),
    reported_paths: list[str] | tuple[str, ...] = (),
    *,
    owner_uid: int = 0,
    owner_gid: int = 0,
) -> set[str]:
    """Validate host files and systemd's DropInPaths as an exact semantic set."""

    root = Path(root)
    if not root.is_absolute() or root.is_symlink() or not root.is_dir():
        raise DropInContractError("HOST_ROOT_INVALID")
    expected_paths = {str(CORE_DROPIN_DIR / name) for name in EXPECTED_DROPINS}
    observed_paths = set()
    for path in reported_paths:
        if not path:
            continue
        candidate = Path(path)
        if root != Path("/"):
            try:
                candidate = Path("/") / candidate.relative_to(root)
            except ValueError:
                pass
        observed_paths.add(str(candidate))
    if observed_paths != expected_paths:
        raise DropInContractError("DROPIN_PATH_SET_MISMATCH")

    dropin_dir = _host_path(root, CORE_DROPIN_DIR)
    if dropin_dir.is_symlink() or not dropin_dir.is_dir():
        raise DropInContractError("DROPIN_DIRECTORY_INVALID")
    entries = {entry.name for entry in dropin_dir.iterdir()}
    if entries != set(EXPECTED_DROPINS):
        raise DropInContractError("DROPIN_DIRECTORY_SET_MISMATCH")

    for name, template_rel in EXPECTED_DROPINS.items():
        target = dropin_dir / name
        try:
            st = target.lstat()
        except OSError as exc:
            raise DropInContractError(f"DROPIN_MISSING:{name}") from exc
        if target.is_symlink() or not target.is_file():
            raise DropInContractError(f"DROPIN_NOT_REGULAR:{name}")
        if (st.st_uid, st.st_gid) != (owner_uid, owner_gid):
            raise DropInContractError(f"DROPIN_OWNER_MISMATCH:{name}")
        if (st.st_mode & 0o777) != 0o644:
            raise DropInContractError(f"DROPIN_MODE_MISMATCH:{name}")
        expected = _expected_bytes(repo, main, template_rel)
        actual = target.read_bytes()
        if actual != expected:
            raise DropInContractError(
                f"DROPIN_DIGEST_MISMATCH:{name}:expected={hashlib.sha256(expected).hexdigest()}"
            )
    return {Path(path).name for path in observed_paths}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path)
    parser.add_argument("--main")
    parser.add_argument("--root", type=Path, default=Path("/"))
    parser.add_argument("--drop-in-path", action="append", default=[])
    parser.add_argument("--owner-uid", type=int, default=0)
    parser.add_argument("--owner-gid", type=int, default=0)
    parser.add_argument("--verify-effective", action="store_true")
    parser.add_argument("--supplementary-groups", default="")
    parser.add_argument("--read-write-paths", default="")
    parser.add_argument("--protect-clock", default="false")
    parser.add_argument("--user", default="aegis-idea3")
    parser.add_argument("--no-new-privileges", default="yes")
    parser.add_argument("--capability-bounding-set", default="")
    parser.add_argument("--ambient-capabilities", default="")
    args = parser.parse_args(argv)

    if args.verify_effective:
        try:
            validate_effective_unit(
                supplementary_groups=args.supplementary_groups,
                read_write_paths=args.read_write_paths,
                protect_clock=args.protect_clock,
                user=args.user,
                no_new_privileges=args.no_new_privileges,
                capability_bounding_set=args.capability_bounding_set,
                ambient_capabilities=args.ambient_capabilities,
            )
        except (DropInContractError, OSError, ValueError) as exc:
            print(f"CTU_EFFECTIVE_PROPERTIES=FAIL reason={exc}", file=os.sys.stderr)
            return 1
        print("CTU_EFFECTIVE_PROPERTIES=PASS")
        return 0

    if not args.repo or not args.main:
        print("CTU_DROPIN_CONTRACT=FAIL reason=REPO_AND_MAIN_REQUIRED", file=os.sys.stderr)
        return 1

    try:
        names = validate_dropins(
            args.repo,
            args.main,
            args.root,
            args.drop_in_path,
            owner_uid=args.owner_uid,
            owner_gid=args.owner_gid,
        )
    except (DropInContractError, OSError, ValueError) as exc:
        print(f"CTU_DROPIN_CONTRACT=FAIL reason={exc}", file=os.sys.stderr)
        return 1
    print("CTU_DROPIN_CONTRACT=PASS")
    print(f"CTU_DROPIN_SET={' '.join(sorted(names))}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
