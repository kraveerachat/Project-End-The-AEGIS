#!/usr/bin/env python3
"""AEGIS IDEA3 PR11 Phase 4 — L1 package installation helper.

Authority:
  docs/superpowers/specs/2026-09-21-idea3-pr11-phase4-l1-operational-design.md
  Decisions: OD-L1-01 .. OD-L1-10.
  docs/superpowers/specs/2026-09-22-idea3-pr11-phase4-l1-live-backend-owner-decision.md
  Decisions: D1 (disk threshold=90), D2 (pacman/chrony contract), D3 (rollback contract).

Dual-layer backend:
  - fixture: isolated filesystem root (AEGIS_P4_FS_ROOT) only.
  - live: repository-implemented, fail-closed unless explicit live
    authorization environment variables are present (LIVE_AUTHORIZATION_MISSING
    otherwise). Live mode invokes the canonical Production pacman binary only
    via long-form flags (--sync/--remove/--print/--noconfirm) and never with
    -y/--refresh, -u/--sysupgrade, or recursive/cascade removal. Live mode is
    never executed by this repository's own test suite or CI.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import time
from pathlib import Path

APPROVED_PACKAGES = {"chrony"}
STAGE_OWNED_PACKAGE = "chrony"

HOST_SYSTEM_PREFIXES = ("/etc/", "/opt/", "/var/", "/run/", "/dev/", "/usr/", "/bin/", "/sbin/")

# D2/D3 live-backend contract. The Production pacman binary is a fixed
# constant, never sourced from the environment, so no environment variable
# can substitute an arbitrary executable for it.
PACMAN_BIN = "/usr/bin/pacman"

LIVE_AUTH_TOKEN_ENV = "AEGIS_L1_LIVE_AUTHORIZATION_TOKEN"
LIVE_AUTH_TOKEN_REQUIRED = "AEGIS_P4_LIVE_L1_EXPLICIT_OWNER_AUTHORIZED"
LIVE_K3_ENV = "AEGIS_L1_LIVE_K3_CONFIRMED"


def live_authorization_present() -> bool:
    """Independent, in-process fail-closed check. Does not replace or weaken
    p4-stage-gate.sh's K3/A-L1/D6 validation; this is an additional gate."""
    return (
        os.environ.get(LIVE_AUTH_TOKEN_ENV) == LIVE_AUTH_TOKEN_REQUIRED
        and os.environ.get(LIVE_K3_ENV) == "YES"
    )


def run_pacman(pacman_args: list[str]) -> subprocess.CompletedProcess:
    """Invoke the canonical Production pacman binary. Never overridable via
    environment. Callers must never pass -y/--refresh, -u/--sysupgrade, or
    recursive/cascade removal flags."""
    return subprocess.run(
        [PACMAN_BIN, *pacman_args], capture_output=True, text=True, check=False
    )


def pacman_preflight_transaction(target: str) -> set[str]:
    """Non-mutating preflight: print the exact package transaction pacman
    would perform for target, without refreshing sync databases or
    installing anything."""
    proc = run_pacman(
        ["--sync", "--print", "--print-format", "%n", "--noconfirm", target]
    )
    if proc.returncode != 0:
        die(f"PREFLIGHT_COMMAND_FAILED: exit {proc.returncode}: {proc.stderr.strip()}")
    names = {line.strip() for line in proc.stdout.splitlines() if line.strip()}
    if not names:
        die("PREFLIGHT_EMPTY_OR_UNPARSEABLE_TRANSACTION")
    return names


def live_install_package(target: str) -> None:
    names = pacman_preflight_transaction(target)
    if names != {target}:
        die(
            f"PREFLIGHT_TRANSACTION_REFUSED: expected exact set {{'{target}'}}, "
            f"got {sorted(names)}"
        )
    proc = run_pacman(["--sync", "--noconfirm", target])
    if proc.returncode != 0:
        die(f"INSTALL_COMMAND_FAILED: exit {proc.returncode}: {proc.stderr.strip()}")


def live_rollback_package(target: str) -> None:
    """D3: removes ONLY target. Never passes any recursive or cascade removal
    flag, so a dependency conflict causes pacman itself to refuse the
    removal and this function surfaces that as a failure rather than
    escalating to a broader removal."""
    proc = run_pacman(["--remove", "--noconfirm", target])
    if proc.returncode != 0:
        die(f"ROLLBACK_COMMAND_FAILED: exit {proc.returncode}: {proc.stderr.strip()}")


def live_verify_package(target: str) -> None:
    query = run_pacman(["--query", target])
    if query.returncode != 0:
        die(f"PACKAGE_NOT_INSTALLED: {target}")

    unit = f"{target}d.service" if target == "chrony" else f"{target}.service"
    active = subprocess.run(
        ["systemctl", "show", unit, "-p", "ActiveState", "--value"],
        capture_output=True,
        text=True,
        check=False,
    )
    if active.returncode == 0 and active.stdout.strip() == "active":
        die(f"SERVICE_MUTATION_REFUSED: {unit} is active")

    enabled = subprocess.run(
        ["systemctl", "show", unit, "-p", "UnitFileState", "--value"],
        capture_output=True,
        text=True,
        check=False,
    )
    if enabled.returncode == 0 and enabled.stdout.strip() == "enabled":
        die(f"SERVICE_MUTATION_REFUSED: {unit} is enabled")


def die(msg: str, code: int = 1) -> None:
    sys.stderr.write(f"ERROR: {msg}\n")
    sys.exit(code)


def validate_work_dir(work_dir_path: str) -> Path:
    p = Path(work_dir_path).resolve()
    if p.is_symlink():
        die("work_dir must not be a symlink")
    norm = str(p)
    for prefix in HOST_SYSTEM_PREFIXES:
        if norm.startswith(prefix) and not norm.startswith("/tmp/"):
            die(f"work_dir must not be a host system path: {norm}")
    p.mkdir(parents=True, exist_ok=True)
    return p


def cmd_check_headroom(args: argparse.Namespace) -> None:
    threshold_str = args.threshold or os.environ.get("DISK_THRESHOLD_PCT", "90")
    if not re.match(r"^[1-9][0-9]?$", threshold_str):
        die(f"DISK_THRESHOLD_PCT must be integer 1-99: {threshold_str}")
    threshold = int(threshold_str)

    simulated = args.simulated_pct or os.environ.get("AEGIS_L1_SIMULATED_DISK_PCT")
    if simulated:
        if not re.match(r"^[0-9]+$", simulated):
            die(f"invalid simulated disk pct: {simulated}")
        pct = int(simulated)
    else:
        # Read from df -P -k
        try:
            out = subprocess.check_output(["df", "-P", "-k", args.mount], text=True)
            lines = out.strip().splitlines()
            if len(lines) < 2:
                die(f"unexpected df output: {out}")
            parts = lines[1].split()
            use_str = parts[4].rstrip("%")
            pct = int(use_str)
        except Exception as e:
            die(f"failed to read disk headroom: {e}")

    if pct >= threshold:
        die(f"DISK_THRESHOLD_VIOLATION: disk usage {pct}% meets or exceeds threshold {threshold}%")
    print(f"DISK_HEADROOM_OK: usage {pct}% < threshold {threshold}%")


def cmd_simulate_install(args: argparse.Namespace) -> None:
    backend = args.backend or os.environ.get("AEGIS_L1_BACKEND", "fixture")
    if backend == "live":
        if not live_authorization_present():
            die("LIVE_AUTHORIZATION_MISSING (LIVE_L1=NOT_AUTHORIZED)")
        packages = [p.strip() for p in args.packages.split(",") if p.strip()]
        if packages != [STAGE_OWNED_PACKAGE]:
            die(
                "UNAPPROVED_PACKAGE_REFUSED: live backend accepts only the exact "
                f"list [{STAGE_OWNED_PACKAGE!r}]"
            )
        work_dir = validate_work_dir(args.work_dir)
        live_install_package(STAGE_OWNED_PACKAGE)
        manifest = {
            "stage": "L1",
            "backend": "live",
            "installed_packages": packages,
            "timestamp": int(time.time()),
        }
        (work_dir / "l1-installed-packages.json").write_text(
            json.dumps(manifest, indent=2), encoding="utf-8"
        )
        print("L1_SIMULATE_INSTALL=COMPLETE")
        return
    if backend != "fixture":
        die(f"unknown backend: {backend}")

    work_dir = validate_work_dir(args.work_dir)
    fs_root = Path(args.fs_root).resolve()
    fs_root.mkdir(parents=True, exist_ok=True)

    # Check packages allowlist
    packages = [p.strip() for p in args.packages.split(",") if p.strip()]
    if not packages:
        die("no packages specified")
    for pkg in packages:
        if pkg not in APPROVED_PACKAGES:
            die(f"UNAPPROVED_PACKAGE_REFUSED: {pkg} not in approved package allowlist {sorted(APPROVED_PACKAGES)}")

    # Check for unrelated upgrade transactions
    diff = args.transaction_diff or os.environ.get("AEGIS_L1_TRANSACTION_DIFF", "")
    if diff:
        # If diff specifies upgrades to unrelated packages
        for entry in diff.split(","):
            pkg_name = entry.split(":")[0].strip()
            if pkg_name not in APPROVED_PACKAGES:
                die(f"UNRELATED_UPGRADE_REFUSED: upgrade of {pkg_name} is prohibited")

    # Injected service mutation negative controls
    if os.environ.get("AEGIS_L1_INJECT_SERVICE_ENABLE") == "YES":
        die("SERVICE_MUTATION_REFUSED: package installation attempted to enable service")
    if os.environ.get("AEGIS_L1_INJECT_SERVICE_ACTIVE") == "YES":
        die("SERVICE_MUTATION_REFUSED: package installation attempted to start service")

    # Perform mock installation in fs_root
    bin_dir = fs_root / "usr" / "bin"
    unit_dir = fs_root / "usr" / "lib" / "systemd" / "system"
    etc_chrony = fs_root / "etc"

    bin_dir.mkdir(parents=True, exist_ok=True)
    unit_dir.mkdir(parents=True, exist_ok=True)
    etc_chrony.mkdir(parents=True, exist_ok=True)

    chronyd_bin = bin_dir / "chronyd"
    chronyc_bin = bin_dir / "chronyc"
    unit_file = unit_dir / "chronyd.service"
    conf_file = etc_chrony / "chrony.conf"

    chronyd_bin.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    chronyd_bin.chmod(0o755)

    chronyc_bin.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    chronyc_bin.chmod(0o755)

    unit_file.write_text(
        "[Unit]\nDescription=NTP client/server\nAfter=network.target\n\n"
        "[Service]\nType=forking\nExecStart=/usr/bin/chronyd\nRestart=on-failure\n\n"
        "[Install]\nWantedBy=multi-user.target\n",
        encoding="utf-8",
    )
    unit_file.chmod(0o644)

    if not conf_file.exists():
        conf_file.write_text("# Default chrony configuration\n", encoding="utf-8")
        conf_file.chmod(0o644)

    # Record manifest in work_dir
    manifest = {
        "stage": "L1",
        "backend": backend,
        "installed_packages": packages,
        "files_created": [
            str(chronyd_bin.relative_to(fs_root)),
            str(chronyc_bin.relative_to(fs_root)),
            str(unit_file.relative_to(fs_root)),
            str(conf_file.relative_to(fs_root)),
        ],
        "timestamp": int(time.time()),
    }
    (work_dir / "l1-installed-packages.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    print("L1_SIMULATE_INSTALL=COMPLETE")


def cmd_verify(args: argparse.Namespace) -> None:
    backend = args.backend or "fixture"
    if backend == "live":
        if not live_authorization_present():
            die("LIVE_AUTHORIZATION_MISSING (LIVE_L1=NOT_AUTHORIZED)")
        live_verify_package(STAGE_OWNED_PACKAGE)
        print("L1_VERIFY=PASS")
        return
    if backend != "fixture":
        die(f"unknown backend: {backend}")

    fs_root = Path(args.fs_root).resolve()
    work_dir = validate_work_dir(args.work_dir)

    # 1. Package binaries & unit must be present
    chronyd_bin = fs_root / "usr" / "bin" / "chronyd"
    chronyc_bin = fs_root / "usr" / "bin" / "chronyc"
    unit_file = fs_root / "usr" / "lib" / "systemd" / "system" / "chronyd.service"

    if not chronyd_bin.is_file():
        die(f"chronyd missing in {fs_root}")
    if not chronyc_bin.is_file():
        die(f"chronyc missing in {fs_root}")
    if not unit_file.is_file():
        die(f"chronyd.service unit missing in {fs_root}")

    # 2. Service must NOT be enabled in /etc/systemd/system
    etc_wants = fs_root / "etc" / "systemd" / "system" / "multi-user.target.wants" / "chronyd.service"
    if etc_wants.exists():
        die("chronyd.service is enabled in /etc/systemd/system")

    # 3. Check for listener injections or unexpected listeners
    listener = args.inject_listener or os.environ.get("AEGIS_L1_INJECT_LISTENER")
    if listener:
        die(f"UNEXPECTED_LISTENER detected: {listener}")

    # 4. Confirm manifest exists and matches chrony
    manifest_path = work_dir / "l1-installed-packages.json"
    if not manifest_path.is_file():
        die("l1-installed-packages.json manifest missing")
    data = json.loads(manifest_path.read_text(encoding="utf-8"))
    if data.get("installed_packages") != [STAGE_OWNED_PACKAGE]:
        die(f"unexpected installed packages in manifest: {data.get('installed_packages')}")

    print("L1_VERIFY=PASS")


def cmd_rollback(args: argparse.Namespace) -> None:
    backend = args.backend or "fixture"
    if backend == "live":
        if not live_authorization_present():
            die("LIVE_AUTHORIZATION_MISSING (LIVE_L1=NOT_AUTHORIZED)")
        live_rollback_package(STAGE_OWNED_PACKAGE)
        if args.work_dir:
            work_dir = Path(args.work_dir).resolve()
            if work_dir.is_dir():
                manifest = work_dir / "l1-installed-packages.json"
                if manifest.exists():
                    manifest.unlink()
        print("L1_ROLLBACK=COMPLETE")
        return
    if backend != "fixture":
        die(f"unknown backend: {backend}")

    fs_root = Path(args.fs_root).resolve()
    work_dir = Path(args.work_dir).resolve() if args.work_dir else None

    # Read manifest if available
    files_to_remove = [
        fs_root / "usr" / "bin" / "chronyd",
        fs_root / "usr" / "bin" / "chronyc",
        fs_root / "usr" / "lib" / "systemd" / "system" / "chronyd.service",
        fs_root / "etc" / "chrony.conf",
    ]

    for p in files_to_remove:
        if p.exists() and not p.is_dir():
            p.unlink()

    if work_dir and work_dir.is_dir():
        manifest = work_dir / "l1-installed-packages.json"
        if manifest.exists():
            manifest.unlink()

    print("L1_ROLLBACK=COMPLETE")


def main() -> None:
    parser = argparse.ArgumentParser(description="AEGIS L1 package installation helper")
    subparsers = parser.add_subparsers(dest="command", required=True)

    p_head = subparsers.add_parser("check-headroom")
    p_head.add_argument("--threshold", help="Threshold pct")
    p_head.add_argument("--mount", default="/", help="Mount point")
    p_head.add_argument("--simulated-pct", help="Simulated disk pct")
    p_head.set_defaults(func=cmd_check_headroom)

    p_install = subparsers.add_parser("simulate-install")
    p_install.add_argument("--backend", default="fixture")
    p_install.add_argument("--work-dir", required=True)
    p_install.add_argument("--fs-root", required=True)
    p_install.add_argument("--packages", default="chrony")
    p_install.add_argument("--transaction-diff", default="")
    p_install.set_defaults(func=cmd_simulate_install)

    p_verify = subparsers.add_parser("verify")
    p_verify.add_argument("--backend", default="fixture")
    p_verify.add_argument("--work-dir", required=True)
    p_verify.add_argument("--fs-root", required=True)
    p_verify.add_argument("--inject-listener", default="")
    p_verify.set_defaults(func=cmd_verify)

    p_rb = subparsers.add_parser("rollback")
    p_rb.add_argument("--backend", default="fixture")
    p_rb.add_argument("--work-dir", default="")
    p_rb.add_argument("--fs-root", required=True)
    p_rb.set_defaults(func=cmd_rollback)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
