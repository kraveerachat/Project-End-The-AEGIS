#!/usr/bin/env python3
"""AEGIS IDEA3 PR11 Phase 4 - CTu manual reconciliation tooling (HOST ONLY, inspection only).

This tool inspects the state of a CTu attempt after an interruption such as:
  - SIGKILL
  - host crash
  - power loss

It inspects host and governance state ONLY. It performs NO service mutation, commands no detector,
restarts no core, communicates with no device, and NEVER reruns CTu. The attempt remains permanently
consumed.

Usage:
  python3 reconcile-ctu.py [--governance-dir /var/lib/aegis-idea3-governance] [--evidence-dir <dir>] [--unit-file <path>]
"""

from __future__ import annotations

import argparse
import hashlib
import os
import re
import subprocess
import sys
from pathlib import Path

DEFAULT_GOVERNANCE_DIR = Path("/var/lib/aegis-idea3-governance")
DEFAULT_CORE_UNIT = Path("/etc/systemd/system/aegis-idea3-core.service")


class ReconciliationError(Exception):
    pass


def inspect_marker(gov_dir: Path) -> dict[str, str]:
    marker = gov_dir / "CTU-GLOBAL-ATTEMPT-CONSUMED"
    if not marker.exists():
        return {"marker_exists": "NO"}
    if marker.is_symlink():
        raise ReconciliationError("MARKER_IS_SYMLINK")
    data = {}
    for line in marker.read_text(encoding="utf-8").splitlines():
        if "=" in line:
            k, v = line.split("=", 1)
            data[k.strip()] = v.strip()
    data["marker_exists"] = "YES"
    return data


def inspect_closeouts(gov_dir: Path) -> dict[str, str]:
    pass_file = gov_dir / "CTU-GLOBAL-CLOSEOUT-PASS"
    fail_file = gov_dir / "CTU-GLOBAL-CLOSEOUT-FAIL"
    pass_exists = pass_file.exists() and not pass_file.is_symlink()
    fail_exists = fail_file.exists() and not fail_file.is_symlink()
    if pass_exists and fail_exists:
        state = "CONTRADICTORY_BOTH_PRESENT"
    elif pass_exists:
        state = "PASS_RECORDED"
    elif fail_exists:
        state = "FAIL_RECORDED"
    else:
        state = "NO_CLOSEOUT_UNTERMINATED"
    return {
        "pass_closeout_exists": "YES" if pass_exists else "NO",
        "fail_closeout_exists": "YES" if fail_exists else "NO",
        "closeout_state": state,
    }


def inspect_evidence(evid_dir: Path | None) -> dict[str, str]:
    if not evid_dir or not evid_dir.exists():
        return {"evidence_inspected": "NO"}
    res = {"evidence_inspected": "YES"}
    term = evid_dir / "terminal-result"
    if term.exists() and not term.is_symlink():
        res["terminal_result_file"] = "PRESENT"
        for line in term.read_text(encoding="utf-8").splitlines():
            if "=" in line:
                k, v = line.split("=", 1)
                res[f"term_{k.strip()}"] = v.strip()
    else:
        res["terminal_result_file"] = "ABSENT"
    res["pre_capture"] = "YES" if (evid_dir / "pre-root").is_dir() else "NO"
    res["post_capture"] = "YES" if (evid_dir / "post-root").is_dir() else "NO"
    res["rollback_capture"] = "YES" if (evid_dir / "rb-root").is_dir() else "NO"
    return res


def inspect_unit_file(unit_path: Path) -> dict[str, str]:
    if not unit_path.exists():
        return {"unit_file_exists": "NO"}
    if unit_path.is_symlink():
        return {"unit_file_exists": "SYMLINK_REJECTED"}
    content = unit_path.read_text(encoding="utf-8")
    sha = hashlib.sha256(unit_path.read_bytes()).hexdigest()
    protect_clock_match = bool(re.search(r"^\s*ProtectClock\s*=\s*(false|no)\s*$", content, re.M))
    user_match = bool(re.search(r"^\s*User\s*=\s*aegis-idea3\s*$", content, re.M))
    no_privs = bool(re.search(r"^\s*NoNewPrivileges\s*=\s*true\s*$", content, re.M))
    cap_bound = bool(re.search(r"^\s*CapabilityBoundingSet\s*=\s*$", content, re.M))
    ambient = bool(re.search(r"^\s*AmbientCapabilities\s*=\s*$", content, re.M))
    hardening = user_match and no_privs and cap_bound and ambient
    return {
        "unit_file_exists": "YES",
        "unit_sha256": sha,
        "protect_clock_repaired": "YES" if protect_clock_match else "NO",
        "security_hardening_valid": "YES" if hardening else "NO",
    }


def inspect_systemd_service(service: str) -> dict[str, str]:
    try:
        proc = subprocess.run(
            ["systemctl", "show", "-p", "ActiveState", "-p", "SubState", "-p", "Result", "-p", "MainPID", service],
            capture_output=True,
            text=True,
            check=False,
        )
        if proc.returncode != 0:
            return {"service_query": "FAILED"}
        data = {}
        for line in proc.stdout.splitlines():
            if "=" in line:
                k, v = line.split("=", 1)
                data[k.strip()] = v.strip()
        return data
    except OSError:
        return {"service_query": "SYSTEMCTL_UNAVAILABLE"}


def diagnose(marker_data: dict[str, str], closeout_data: dict[str, str], evid_data: dict[str, str], unit_data: dict[str, str]) -> str:
    if marker_data.get("marker_exists") != "YES":
        return "ATTEMPT_NEVER_CONSUMED"
    if closeout_data["closeout_state"] == "PASS_RECORDED":
        return "COMPLETED_PASS"
    if closeout_data["closeout_state"] == "FAIL_RECORDED":
        return "COMPLETED_FAIL_ROLLED_BACK"
    if closeout_data["closeout_state"] == "CONTRADICTORY_BOTH_PRESENT":
        return "CORRUPT_CONTRADICTORY_CLOSEOUTS"
    # Interrupted attempt: SIGKILL, host crash, power loss
    if evid_data.get("rollback_capture") == "YES":
        return "INTERRUPTED_DURING_ROLLBACK"
    if evid_data.get("post_capture") == "YES":
        return "INTERRUPTED_DURING_VERIFY_OR_CLOSEOUT"
    if evid_data.get("pre_capture") == "YES":
        return "INTERRUPTED_DURING_APPLY_OR_EXECUTION"
    return "INTERRUPTED_POST_CONSUME"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--governance-dir", type=Path, default=DEFAULT_GOVERNANCE_DIR)
    parser.add_argument("--evidence-dir", type=Path, default=None)
    parser.add_argument("--unit-file", type=Path, default=DEFAULT_CORE_UNIT)
    args = parser.parse_args(argv)
    gov_dir = Path(os.environ.get("AEGIS_CTU_TEST_ONLY_CANONICAL_DIR", args.governance_dir))
    unit_file = Path(os.environ.get("AEGIS_CORE_UNIT_FILE", args.unit_file))
    try:
        marker_data = inspect_marker(gov_dir)
        closeouts = inspect_closeouts(gov_dir)
        evid_data = inspect_evidence(args.evidence_dir)
        unit_data = inspect_unit_file(unit_file)
        core_svc = inspect_systemd_service("aegis-idea3-core.service")
        diag = diagnose(marker_data, closeouts, evid_data, unit_data)
        print("CTU_MANUAL_RECONCILIATION_READY=YES")
        if marker_data.get("marker_exists") == "YES":
            print("CTU_ATTEMPT_CONSUMED=YES")
            print("CTU_RERUN_ALLOWED=NO")
        else:
            print("CTU_ATTEMPT_CONSUMED=NO")
            print("CTU_RERUN_ALLOWED=YES")
        print(f"CTU_CLOSEOUT_STATE={closeouts['closeout_state']}")
        print(f"CTU_DIAGNOSIS={diag}")
        print(f"CTU_UNIT_PROTECT_CLOCK={unit_data.get('protect_clock_repaired', 'UNKNOWN')}")
        print(f"CTU_UNIT_HARDENING={unit_data.get('security_hardening_valid', 'UNKNOWN')}")
        if core_svc.get("ActiveState"):
            print(f"CTU_CORE_ACTIVE_STATE={core_svc.get('ActiveState')}")
        print("CTU_RECONCILIATION_RESULT=INSPECTED")
        return 0
    except (ReconciliationError, OSError) as exc:
        print(f"CTU_MANUAL_RECONCILIATION=FAIL reason={exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
