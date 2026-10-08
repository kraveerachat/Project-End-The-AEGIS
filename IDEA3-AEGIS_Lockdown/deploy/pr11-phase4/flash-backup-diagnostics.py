#!/usr/bin/env python3
"""Validate an offline ESP32 flash-backup evidence bundle.

This tool is deliberately non-invasive: it reads a JSON evidence record and a
local binary backup only. It never opens a serial device and never invokes
esptool. A PASS means the supplied artefacts support the narrow H0 backup
claims; it does not mean the image was restored or is safe to flash.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path


EXPECTED_FLASH_SIZE = 4_194_304
EXPECTED_BAUD = 115_200
EXPECTED_READ_MODE = "rom/no-stub"
BOOTLOADER_OFFSET = 0x1000
PARTITION_TABLE_OFFSET = 0x8000
REQUIRED_FIELDS = (
    "flash_size_bytes",
    "read_mode",
    "baud",
    "sha256",
    "sha256_verification",
    "bootloader_header",
    "partition_header",
    "firmware_writing",
    "flash_erasing",
    "backup_restoration_tested",
    "historical_attempts",
)


class DiagnosticError(ValueError):
    """Evidence is incomplete, contradictory, or does not match the backup."""


def _require(evidence: dict, key: str):
    if key not in evidence:
        raise DiagnosticError(f"missing evidence field: {key}")
    return evidence[key]


def _historical_failure_is_present(evidence: dict) -> bool:
    attempts = _require(evidence, "historical_attempts")
    if not isinstance(attempts, list):
        raise DiagnosticError("historical_attempts must be a list")
    return any(
        isinstance(attempt, dict)
        and attempt.get("baud") == 460800
        and attempt.get("result") == "FAIL"
        for attempt in attempts
    )


def validate_backup(evidence: dict, backup_path: Path) -> dict:
    """Validate evidence and bytes, returning a conservative summary."""
    if not isinstance(evidence, dict):
        raise DiagnosticError("evidence must be a JSON object")
    for key in REQUIRED_FIELDS:
        _require(evidence, key)

    if evidence["flash_size_bytes"] != EXPECTED_FLASH_SIZE:
        raise DiagnosticError(f"flash size must be {EXPECTED_FLASH_SIZE} bytes")
    if evidence["read_mode"] != EXPECTED_READ_MODE:
        raise DiagnosticError("read mode must be ROM/no-stub")
    if evidence["baud"] != EXPECTED_BAUD:
        raise DiagnosticError("backup must use 115200 baud")
    expected_values = {
        "sha256_verification": "PASS",
        "bootloader_header": "EXPECTED",
        "partition_header": "EXPECTED",
    }
    for key, label in (
        ("sha256_verification", "sha256 verification"),
        ("bootloader_header", "bootloader header"),
        ("partition_header", "partition header"),
    ):
        if evidence[key] != expected_values[key]:
            raise DiagnosticError(f"{label} is not verified")
    for key, label in (
        ("firmware_writing", "writing"),
        ("flash_erasing", "erasing"),
        ("backup_restoration_tested", "restoration"),
    ):
        if evidence[key] != "NO":
            raise DiagnosticError(f"{label} must be recorded as NO")

    try:
        data = backup_path.read_bytes()
    except OSError as exc:
        raise DiagnosticError(f"backup is missing or unreadable: {backup_path}") from exc
    if len(data) != EXPECTED_FLASH_SIZE:
        raise DiagnosticError(f"backup byte count must be {EXPECTED_FLASH_SIZE}")
    digest = hashlib.sha256(data).hexdigest()
    if evidence["sha256"] != digest:
        raise DiagnosticError("sha256 does not match backup bytes")
    if data[BOOTLOADER_OFFSET] != 0xE9:
        raise DiagnosticError("bootloader header magic at 0x1000 is not 0xE9")
    if data[PARTITION_TABLE_OFFSET:PARTITION_TABLE_OFFSET + 2] != b"\xaa\x50":
        raise DiagnosticError("partition header magic is not 0x50AA")
    if not _historical_failure_is_present(evidence):
        raise DiagnosticError("historical 460800-baud failure is not preserved")

    return {
        "verdict": "PASS",
        "flash_size_bytes": len(data),
        "sha256": digest,
        "offline_validation_scope": "OWNER_SUPPLIED_ARTIFACTS_ONLY",
        "owner_declared_evidence": {
            "firmware_writing": evidence["firmware_writing"],
            "flash_erasing": evidence["flash_erasing"],
            "backup_restoration_tested": evidence["backup_restoration_tested"],
        },
        "hardware_behavior_observed": "NOT_OBSERVED",
        "historical_460800_failure_preserved": True,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", type=Path, required=True)
    parser.add_argument("--backup", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        evidence = json.loads(args.evidence.read_text(encoding="utf-8"))
        result = validate_backup(evidence, args.backup)
    except (DiagnosticError, OSError, json.JSONDecodeError) as exc:
        print(json.dumps({"verdict": "FAIL", "reason": str(exc)}))
        return 1
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
