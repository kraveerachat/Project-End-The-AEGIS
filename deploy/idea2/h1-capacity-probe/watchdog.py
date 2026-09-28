#!/usr/bin/env python3
"""Fail-closed resource watchdog for the isolated H1 capacity probe.

This module does not authorize or start the probe. Live modes inspect only the
fixed probe project and stop that exact project if a measurement fails or an
owner-provided boundary is crossed.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
from typing import Any


PROJECT_NAME = "aegis-h1-capacity-probe"
POSTGRES_VOLUME = "aegis-h1-capacity-probe_postgres_data"
EXPECTED_SERVICES = ("gateway", "monitor", "postgres")
COMPOSE_FILE = Path(__file__).resolve().parents[1] / "h1-capacity-probe.compose.yml"
SIZE_PATTERN = re.compile(r"^([0-9]+(?:\.[0-9]+)?)\s*([KMGT]?i?B)?$", re.IGNORECASE)


class ProbeBlocked(RuntimeError):
    """The probe must stop because a required measurement or limit failed."""


def _positive_integer(value: Any, field: str) -> int:
    if isinstance(value, bool):
        raise ProbeBlocked(f"{field} must be a positive integer")
    try:
        parsed = int(value)
    except (TypeError, ValueError) as exc:
        raise ProbeBlocked(f"{field} must be a positive integer") from exc
    if parsed <= 0:
        raise ProbeBlocked(f"{field} must be a positive integer")
    return parsed


def limits_from_mapping(values: dict[str, Any]) -> dict[str, Any]:
    service_values = values.get("service_memory_ceiling_bytes")
    if not isinstance(service_values, dict):
        raise ProbeBlocked("service_memory_ceiling_bytes must contain all probe services")
    return {
        "disk_safety_reserve_bytes": _positive_integer(values.get("disk_safety_reserve_bytes"), "disk_safety_reserve_bytes"),
        "inode_safety_reserve_count": _positive_integer(values.get("inode_safety_reserve_count"), "inode_safety_reserve_count"),
        "host_ram_reserve_bytes": _positive_integer(values.get("host_ram_reserve_bytes"), "host_ram_reserve_bytes"),
        "evidence_log_cap_bytes": _positive_integer(values.get("evidence_log_cap_bytes"), "evidence_log_cap_bytes"),
        "postgres_growth_budget_bytes": _positive_integer(values.get("postgres_growth_budget_bytes"), "postgres_growth_budget_bytes"),
        "service_memory_ceiling_bytes": {
            service: _positive_integer(service_values.get(service), f"service_memory_ceiling_bytes.{service}")
            for service in EXPECTED_SERVICES
        },
    }


def limits_from_environment() -> dict[str, Any]:
    return limits_from_mapping(
        {
            "disk_safety_reserve_bytes": os.environ.get("DISK_SAFETY_RESERVE_BYTES"),
            "inode_safety_reserve_count": os.environ.get("INODE_SAFETY_RESERVE_COUNT"),
            "host_ram_reserve_bytes": os.environ.get("HOST_RAM_RESERVE_BYTES"),
            "evidence_log_cap_bytes": os.environ.get("EVIDENCE_LOG_CAP_BYTES"),
            "postgres_growth_budget_bytes": os.environ.get("POSTGRES_GROWTH_BUDGET_BYTES"),
            "service_memory_ceiling_bytes": {
                "gateway": os.environ.get("GATEWAY_MEMORY_CEILING_BYTES"),
                "monitor": os.environ.get("MONITOR_MEMORY_CEILING_BYTES"),
                "postgres": os.environ.get("POSTGRES_MEMORY_CEILING_BYTES"),
            },
        }
    )


def evaluate_snapshot(snapshot: dict[str, Any], limits: dict[str, Any]) -> list[str]:
    """Return every blocking condition. Missing or malformed data blocks."""

    violations: list[str] = []

    def measured(field: str) -> int | None:
        try:
            value = int(snapshot[field])
        except (KeyError, TypeError, ValueError):
            violations.append(f"MEASUREMENT_MISSING:{field}")
            return None
        if value < 0:
            violations.append(f"MEASUREMENT_INVALID:{field}")
            return None
        return value

    comparisons = (
        ("host_available_bytes", "disk_safety_reserve_bytes", "DISK_RESERVE_CROSSED", "minimum"),
        ("host_available_inodes", "inode_safety_reserve_count", "INODE_RESERVE_CROSSED", "minimum"),
        ("host_mem_available_bytes", "host_ram_reserve_bytes", "RAM_RESERVE_CROSSED", "minimum"),
        ("evidence_log_bytes", "evidence_log_cap_bytes", "EVIDENCE_LOG_CAP_EXCEEDED", "maximum"),
        ("postgres_growth_bytes", "postgres_growth_budget_bytes", "POSTGRES_GROWTH_BUDGET_EXCEEDED", "maximum"),
    )
    for metric_field, limit_field, code, mode in comparisons:
        metric = measured(metric_field)
        limit_value = int(limits[limit_field])
        if metric is None:
            continue
        if mode == "minimum" and metric <= limit_value:
            violations.append(code)
        if mode == "maximum" and metric > limit_value:
            violations.append(code)

    service_rss = snapshot.get("service_rss_bytes")
    if not isinstance(service_rss, dict):
        violations.append("MEASUREMENT_MISSING:service_rss_bytes")
    else:
        for service in EXPECTED_SERVICES:
            try:
                rss = int(service_rss[service])
            except (KeyError, TypeError, ValueError):
                violations.append(f"MEASUREMENT_MISSING:service_rss_bytes.{service}")
                continue
            if rss < 0:
                violations.append(f"MEASUREMENT_INVALID:service_rss_bytes.{service}")
            elif rss > int(limits["service_memory_ceiling_bytes"][service]):
                violations.append(f"SERVICE_MEMORY_CEILING_EXCEEDED:{service}")

    return violations


def _run(command: list[str]) -> str:
    result = subprocess.run(command, check=False, capture_output=True, text=True, timeout=30)
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "no diagnostic").strip().splitlines()[-1]
        raise ProbeBlocked(f"measurement command failed: {command[0]} ({detail})")
    return result.stdout.strip()


def _directory_bytes(root: Path) -> int:
    if not root.exists() or not root.is_dir():
        raise ProbeBlocked(f"measurement directory is missing: {root}")
    total = 0
    for current_root, directories, files in os.walk(root, followlinks=False):
        current = Path(current_root)
        for name in directories:
            if (current / name).is_symlink():
                raise ProbeBlocked("measurement directory contains a symbolic link")
        for name in files:
            candidate = current / name
            if candidate.is_symlink():
                raise ProbeBlocked("measurement directory contains a symbolic link")
            total += candidate.stat().st_size
    return total


def _parse_memory_size(value: str) -> int:
    token = value.split("/", 1)[0].strip()
    match = SIZE_PATTERN.fullmatch(token)
    if not match:
        raise ProbeBlocked(f"unrecognized Docker memory value: {token}")
    number = float(match.group(1))
    unit = (match.group(2) or "B").upper()
    powers = {
        "B": 1,
        "KB": 1000,
        "MB": 1000**2,
        "GB": 1000**3,
        "TB": 1000**4,
        "KIB": 1024,
        "MIB": 1024**2,
        "GIB": 1024**3,
        "TIB": 1024**4,
    }
    return int(number * powers[unit])


def _host_metrics() -> tuple[int, int, int]:
    stats = os.statvfs("/")
    available_bytes = stats.f_bavail * stats.f_frsize
    available_inodes = stats.f_favail
    meminfo = Path("/proc/meminfo")
    if not meminfo.exists():
        raise ProbeBlocked("/proc/meminfo is unavailable")
    match = re.search(r"^MemAvailable:\s+(\d+)\s+kB$", meminfo.read_text(encoding="utf-8"), re.MULTILINE)
    if not match:
        raise ProbeBlocked("MemAvailable is unavailable")
    return available_bytes, available_inodes, int(match.group(1)) * 1024


def capture_preflight_snapshot(evidence_dir: Path) -> dict[str, Any]:
    """Measure host-only boundaries before probe services exist."""

    available_bytes, available_inodes, available_ram = _host_metrics()
    return {
        "host_available_bytes": available_bytes,
        "host_available_inodes": available_inodes,
        "host_mem_available_bytes": available_ram,
        "evidence_log_bytes": _directory_bytes(evidence_dir),
        "postgres_growth_bytes": 0,
        "service_rss_bytes": {service: 0 for service in EXPECTED_SERVICES},
    }


def _probe_containers() -> dict[str, str]:
    output = _run(
        [
            "docker",
            "ps",
            "--filter",
            f"label=com.docker.compose.project={PROJECT_NAME}",
            "--format",
            '{{.ID}}|{{.Label "com.docker.compose.service"}}',
        ]
    )
    containers: dict[str, str] = {}
    for line in output.splitlines():
        if not line:
            continue
        container_id, separator, service = line.partition("|")
        if separator and service in EXPECTED_SERVICES:
            containers[service] = container_id
    missing = sorted(set(EXPECTED_SERVICES) - containers.keys())
    if missing:
        raise ProbeBlocked(f"probe service measurements are missing: {','.join(missing)}")
    return containers


def _postgres_volume_bytes() -> int:
    mountpoint = _run(["docker", "volume", "inspect", "--format", "{{.Mountpoint}}", POSTGRES_VOLUME])
    if not mountpoint:
        raise ProbeBlocked("probe PostgreSQL volume mountpoint is unavailable")
    return _directory_bytes(Path(mountpoint))


def capture_snapshot(evidence_dir: Path, postgres_initial_volume_bytes: int) -> dict[str, Any]:
    available_bytes, available_inodes, available_ram = _host_metrics()
    containers = _probe_containers()
    rss: dict[str, int] = {}
    writable: dict[str, int] = {}
    log_bytes = 0
    for service, container_id in containers.items():
        rss[service] = _parse_memory_size(
            _run(["docker", "stats", "--no-stream", "--format", "{{.MemUsage}}", container_id])
        )
        size_rw = _run(["docker", "inspect", "--size", "--format", "{{.SizeRw}}", container_id])
        writable[service] = int(size_rw)
        log_path = _run(["docker", "inspect", "--format", "{{.LogPath}}", container_id])
        if log_path:
            candidate = Path(log_path)
            if candidate.exists() and candidate.is_file():
                log_bytes += candidate.stat().st_size

    volume_bytes = _postgres_volume_bytes()
    return {
        "host_available_bytes": available_bytes,
        "host_available_inodes": available_inodes,
        "host_mem_available_bytes": available_ram,
        "evidence_log_bytes": _directory_bytes(evidence_dir) + log_bytes,
        "postgres_growth_bytes": max(0, volume_bytes - postgres_initial_volume_bytes),
        "postgres_volume_bytes": volume_bytes,
        "service_rss_bytes": rss,
        "service_writable_layer_bytes": writable,
        "aggregate_lab_rss_bytes": sum(rss.values()),
    }


def stop_probe() -> None:
    subprocess.run(
        [
            "docker",
            "compose",
            "--project-name",
            PROJECT_NAME,
            "--file",
            str(COMPOSE_FILE),
            "stop",
            "--timeout",
            "10",
        ],
        check=False,
        capture_output=True,
        text=True,
        timeout=45,
    )


def _load_json(path: str) -> dict[str, Any]:
    value = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ProbeBlocked(f"JSON object required: {path}")
    return value


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--evaluate", action="store_true")
    parser.add_argument("--check-once", action="store_true")
    parser.add_argument("--loop", action="store_true")
    parser.add_argument("--limits-json")
    parser.add_argument("--snapshot-json")
    parser.add_argument("--evidence-dir")
    parser.add_argument("--postgres-initial-volume-bytes")
    parser.add_argument("--interval-seconds", type=float, default=2.0)
    args = parser.parse_args()

    try:
        if args.evaluate:
            if not args.limits_json or not args.snapshot_json:
                raise ProbeBlocked("--evaluate requires --limits-json and --snapshot-json")
            limits = limits_from_mapping(_load_json(args.limits_json))
            violations = evaluate_snapshot(_load_json(args.snapshot_json), limits)
            if violations:
                print(f"BLOCKED:{','.join(violations)}")
                return 2
            print("PASS")
            return 0

        if not (args.check_once or args.loop):
            raise ProbeBlocked("choose --evaluate, --check-once, or --loop")
        if not args.evidence_dir or args.postgres_initial_volume_bytes is None:
            raise ProbeBlocked("live watchdog requires evidence and PostgreSQL baseline inputs")

        limits = limits_from_environment()
        evidence_dir = Path(args.evidence_dir).resolve()
        postgres_initial = _positive_integer(
            args.postgres_initial_volume_bytes,
            "postgres_initial_volume_bytes",
        )
        while True:
            snapshot = capture_snapshot(evidence_dir, postgres_initial)
            violations = evaluate_snapshot(snapshot, limits)
            if violations:
                stop_probe()
                print(f"BLOCKED:{','.join(violations)}")
                return 2
            print(json.dumps(snapshot, sort_keys=True))
            if args.check_once:
                return 0
            time.sleep(max(args.interval_seconds, 0.5))
    except Exception as exc:  # Fail closed on any missing or stale measurement.
        if not args.evaluate:
            stop_probe()
        print(f"BLOCKED:{exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
