#!/usr/bin/env python3
"""Bounded, separately authorized H1 capacity characterization harness.

Validation is repository-safe. ``--run`` is an active, non-Production action
that remains owner-gated and has not been executed by this source checkpoint.
Tag-only identity is never accepted. Unresolved identity must remain
REQUIRES_SEPARATE_READONLY_REGISTRY_LOOKUP.
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

import cleanup_probe
import watchdog


PROJECT_NAME = "aegis-h1-capacity-probe"
BUILDER_NAME = "aegis-h1-capacity-builder"
COMPOSE_FILE = Path(__file__).resolve().parents[1] / "h1-capacity-probe.compose.yml"
REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
DIGEST_REFERENCE = re.compile(r"^[^\s@]+@sha256:[0-9a-f]{64}$")
SOURCE_SHA = re.compile(r"^[0-9a-f]{40}$")
PROBE_TAG = re.compile(r"^aegis-h1-capacity-probe-(?:monitor|gateway):[a-z0-9][a-z0-9._-]*$")

POSITIVE_INTEGER_INPUTS = (
    "POSTGRES_GROWTH_BUDGET_BYTES",
    "HOST_RAM_RESERVE_BYTES",
    "DISK_SAFETY_RESERVE_BYTES",
    "EVIDENCE_LOG_CAP_BYTES",
    "INODE_SAFETY_RESERVE_COUNT",
    "CHARACTERIZATION_MAX_NEW_BYTES",
    "GATEWAY_MEMORY_CEILING_BYTES",
    "MONITOR_MEMORY_CEILING_BYTES",
    "POSTGRES_MEMORY_CEILING_BYTES",
    "PROBE_SAMPLE_SECONDS",
)


class ValidationError(RuntimeError):
    pass


def _positive_integer(name: str, errors: list[str]) -> int | None:
    value = os.environ.get(name)
    try:
        parsed = int(value or "")
    except ValueError:
        errors.append(f"{name} must be an explicit positive integer")
        return None
    if parsed <= 0:
        errors.append(f"{name} must be an explicit positive integer")
        return None
    return parsed


def _safe_evidence_dir(value: str | None, errors: list[str]) -> Path | None:
    if not value:
        errors.append("PROBE_EVIDENCE_DIR is required")
        return None
    path = Path(value).resolve()
    if not path.name.startswith("aegis-h1-capacity-probe-") or path.parent == path or len(path.parts) < 3:
        errors.append("PROBE_EVIDENCE_DIR must be a bounded probe-specific directory")
        return None
    return path


def validate_environment(*, require_files: bool) -> dict[str, Any]:
    errors: list[str] = []
    for name in ("MONITOR_BASE_IMAGE", "POSTGRES_IMAGE", "GATEWAY_BASE_IMAGE"):
        value = os.environ.get(name, "")
        if not DIGEST_REFERENCE.fullmatch(value):
            errors.append(f"{name} must be an immutable digest-form @sha256 reference")

    source_sha = os.environ.get("MONITOR_SOURCE_SHA", "")
    if not SOURCE_SHA.fullmatch(source_sha):
        errors.append("MONITOR_SOURCE_SHA must be the exact 40-character source checkpoint")
    else:
        result = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=REPOSITORY_ROOT,
            check=False,
            capture_output=True,
            text=True,
            timeout=10,
        )
        if result.returncode != 0 or result.stdout.strip() != source_sha:
            errors.append("MONITOR_SOURCE_SHA does not match the checked-out source checkpoint")

    for name in ("MONITOR_CANDIDATE_IMAGE", "GATEWAY_CANDIDATE_IMAGE"):
        value = os.environ.get(name, "")
        if not PROBE_TAG.fullmatch(value):
            errors.append(f"{name} must use the isolated probe-only tag namespace")
        elif source_sha and not value.endswith(f":{source_sha[:12]}"):
            errors.append(f"{name} must be bound to the first 12 characters of MONITOR_SOURCE_SHA")

    numeric = {name: _positive_integer(name, errors) for name in POSITIVE_INTEGER_INPUTS}
    evidence_dir = _safe_evidence_dir(os.environ.get("PROBE_EVIDENCE_DIR"), errors)

    if os.environ.get("PROBE_EXECUTION_SCOPE") != "DISPOSABLE_H1_CAPACITY_PROBE_ONLY":
        errors.append("PROBE_EXECUTION_SCOPE must explicitly select the disposable probe")
    if not re.fullmatch(r"[A-Za-z0-9_-]{24,}", os.environ.get("PROBE_POSTGRES_PASSWORD", "")):
        errors.append("PROBE_POSTGRES_PASSWORD must be a disposable URL-safe value of at least 24 characters")
    if not re.fullmatch(r"[A-Za-z0-9_-]{32,}", os.environ.get("PROBE_SESSION_SECRET", "")):
        errors.append("PROBE_SESSION_SECRET must be a disposable Compose-safe value of at least 32 characters")

    log_size = os.environ.get("PROBE_SERVICE_LOG_MAX_SIZE", "")
    if not re.fullmatch(r"[1-9][0-9]*[kKmMgG]", log_size):
        errors.append("PROBE_SERVICE_LOG_MAX_SIZE must be an explicit bounded Docker size")

    for name in ("PROBE_TLS_CERT_FILE", "PROBE_TLS_KEY_FILE"):
        value = os.environ.get(name, "")
        if not value:
            errors.append(f"{name} is required")
        elif require_files and not Path(value).is_file():
            errors.append(f"{name} does not identify a regular file")

    forbidden_values = ("aegis-h1-lab", "192.168.10.10", "18077", "18078", "18443")
    for name in (
        "PROBE_EVIDENCE_DIR",
        "MONITOR_CANDIDATE_IMAGE",
        "GATEWAY_CANDIDATE_IMAGE",
        "PROBE_TLS_CERT_FILE",
        "PROBE_TLS_KEY_FILE",
    ):
        value = os.environ.get(name, "").lower()
        if any(forbidden.lower() in value for forbidden in forbidden_values):
            errors.append(f"{name} contains a forbidden live-lab or Machine A value")

    if errors:
        raise ValidationError("; ".join(errors))
    return {"numeric": numeric, "evidence_dir": evidence_dir, "source_sha": source_sha}


def _run(command: list[str], *, timeout: int = 120, output_file: Path | None = None) -> str:
    if output_file is None:
        result = subprocess.run(command, check=False, capture_output=True, text=True, timeout=timeout)
        if result.returncode != 0:
            detail = (result.stderr or result.stdout or "no diagnostic").strip().splitlines()[-1]
            raise RuntimeError(f"command failed: {command[0]} ({detail})")
        return result.stdout.strip()
    with output_file.open("a", encoding="utf-8") as stream:
        result = subprocess.run(command, check=False, stdout=stream, stderr=subprocess.STDOUT, text=True, timeout=timeout)
    if result.returncode != 0:
        raise RuntimeError(f"command failed: {command[0]} (see redacted probe log)")
    return ""


def _run_guarded(command: list[str], *, output_file: Path, evidence_dir: Path, limits: dict[str, Any], timeout: int) -> None:
    started = time.monotonic()
    with output_file.open("a", encoding="utf-8") as stream:
        process = subprocess.Popen(command, stdout=stream, stderr=subprocess.STDOUT, text=True)
        while process.poll() is None:
            if time.monotonic() - started > timeout:
                process.terminate()
                watchdog.stop_probe()
                raise RuntimeError(f"guarded command timed out: {command[0]}")
            try:
                _guard_host(evidence_dir, limits)
            except Exception:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                raise
            time.sleep(2)
        if process.returncode != 0:
            raise RuntimeError(f"command failed: {command[0]} (see redacted probe log)")


def _compose_command(*arguments: str) -> list[str]:
    return [
        "docker",
        "compose",
        "--project-name",
        PROJECT_NAME,
        "--file",
        str(COMPOSE_FILE),
        *arguments,
    ]


def _image_id(reference: str) -> str | None:
    result = subprocess.run(
        ["docker", "image", "inspect", "--format", "{{.Id}}", reference],
        check=False,
        capture_output=True,
        text=True,
        timeout=30,
    )
    return result.stdout.strip() if result.returncode == 0 else None


def _image_size(reference: str) -> int:
    return int(_run(["docker", "image", "inspect", "--format", "{{.Size}}", reference]))


def _assert_no_probe_collision() -> None:
    containers = _run(
        [
            "docker",
            "ps",
            "--all",
            "--filter",
            f"label=com.docker.compose.project={PROJECT_NAME}",
            "--format",
            "{{.ID}}",
        ]
    )
    if containers:
        raise ValidationError("probe project resources already exist")
    if subprocess.run(
        ["docker", "volume", "inspect", cleanup_probe.POSTGRES_VOLUME],
        check=False,
        capture_output=True,
        text=True,
        timeout=30,
    ).returncode == 0:
        raise ValidationError("probe PostgreSQL volume already exists")
    if subprocess.run(
        ["docker", "buildx", "inspect", BUILDER_NAME],
        check=False,
        capture_output=True,
        text=True,
        timeout=30,
    ).returncode == 0:
        raise ValidationError("probe Buildx builder already exists")


def _record_introduced_images(before: dict[str, str | None], evidence_dir: Path) -> Path:
    entries: list[dict[str, Any]] = []
    for name in ("MONITOR_CANDIDATE_IMAGE", "GATEWAY_CANDIDATE_IMAGE"):
        reference = os.environ[name]
        after = _image_id(reference)
        if after is None:
            raise RuntimeError(f"candidate image is missing after build: {name}")
        entries.append(
            {
                "reference": reference,
                "image_id": after,
                "introduced_by_probe": before[name] is None,
            }
        )
    path = evidence_dir / "introduced-images.json"
    path.write_text(json.dumps(entries, indent=2, sort_keys=True), encoding="utf-8")
    return path


def _guard_host(evidence_dir: Path, limits: dict[str, Any]) -> dict[str, Any]:
    snapshot = watchdog.capture_preflight_snapshot(evidence_dir)
    violations = watchdog.evaluate_snapshot(snapshot, limits)
    maximum_new = int(os.environ["CHARACTERIZATION_MAX_NEW_BYTES"])
    if snapshot["host_available_bytes"] <= maximum_new + limits["disk_safety_reserve_bytes"]:
        violations.append("CHARACTERIZATION_DISK_ENVELOPE_UNAVAILABLE")
    if violations:
        watchdog.stop_probe()
        raise RuntimeError(f"capacity boundary blocked: {','.join(violations)}")
    return snapshot


def run_probe(configuration: dict[str, Any]) -> None:
    if os.environ.get("AEGIS_CAPACITY_PROBE_AUTHORIZED") != "YES":
        raise ValidationError("active probe requires AEGIS_CAPACITY_PROBE_AUTHORIZED=YES")

    evidence_dir: Path = configuration["evidence_dir"]
    if evidence_dir.exists() and any(evidence_dir.iterdir()):
        raise ValidationError("probe evidence directory must be new or empty")
    evidence_dir.mkdir(parents=True, exist_ok=True)
    (evidence_dir / cleanup_probe.EVIDENCE_MARKER).write_text(f"{PROJECT_NAME}\n", encoding="utf-8")
    log_path = evidence_dir / "probe.log"
    limits = watchdog.limits_from_environment()
    _assert_no_probe_collision()
    before_images = {
        name: _image_id(os.environ[name])
        for name in ("MONITOR_CANDIDATE_IMAGE", "GATEWAY_CANDIDATE_IMAGE")
    }
    image_manifest: Path | None = None
    baseline = _guard_host(evidence_dir, limits)
    (evidence_dir / "host-baseline.json").write_text(
        json.dumps(baseline, indent=2, sort_keys=True),
        encoding="utf-8",
    )

    try:
        _run(["docker", "buildx", "create", "--name", BUILDER_NAME, "--driver", "docker-container", "--use"])
        _guard_host(evidence_dir, limits)
        _run_guarded(
            _compose_command("build"),
            output_file=log_path,
            evidence_dir=evidence_dir,
            limits=limits,
            timeout=3600,
        )
        post_build = _guard_host(evidence_dir, limits)
        image_manifest = _record_introduced_images(before_images, evidence_dir)
        artifact_measurements = {
            "monitor_image_bytes": _image_size(os.environ["MONITOR_CANDIDATE_IMAGE"]),
            "gateway_image_bytes": _image_size(os.environ["GATEWAY_CANDIDATE_IMAGE"]),
            "build_transient_available_bytes_delta": max(
                0,
                baseline["host_available_bytes"] - post_build["host_available_bytes"],
            ),
            "build_transient_inode_delta": max(
                0,
                baseline["host_available_inodes"] - post_build["host_available_inodes"],
            ),
        }
        (evidence_dir / "artifact-measurements.json").write_text(
            json.dumps(artifact_measurements, indent=2, sort_keys=True),
            encoding="utf-8",
        )
        _run_guarded(
            _compose_command("up", "--detach"),
            output_file=log_path,
            evidence_dir=evidence_dir,
            limits=limits,
            timeout=600,
        )

        deadline = time.monotonic() + 120
        initial_volume = None
        ready_snapshot = None
        while time.monotonic() < deadline:
            try:
                initial_volume = watchdog._postgres_volume_bytes()
                snapshot = watchdog.capture_snapshot(evidence_dir, initial_volume)
                if not watchdog.evaluate_snapshot(snapshot, limits):
                    ready_snapshot = snapshot
                    break
            except Exception:
                pass
            time.sleep(2)
        if initial_volume is None or ready_snapshot is None:
            raise RuntimeError("probe services did not become measurable")

        artifact_measurements["postgres_image_bytes"] = _image_size(os.environ["POSTGRES_IMAGE"])
        (evidence_dir / "artifact-measurements.json").write_text(
            json.dumps(artifact_measurements, indent=2, sort_keys=True),
            encoding="utf-8",
        )
        peak_snapshot = ready_snapshot
        sample_seconds = int(os.environ["PROBE_SAMPLE_SECONDS"])
        sample_deadline = time.monotonic() + sample_seconds
        while time.monotonic() < sample_deadline:
            snapshot = watchdog.capture_snapshot(evidence_dir, initial_volume)
            violations = watchdog.evaluate_snapshot(snapshot, limits)
            if violations:
                watchdog.stop_probe()
                raise RuntimeError(f"capacity boundary blocked: {','.join(violations)}")
            peak_snapshot["aggregate_lab_rss_bytes"] = max(
                peak_snapshot["aggregate_lab_rss_bytes"],
                snapshot["aggregate_lab_rss_bytes"],
            )
            for service, rss in snapshot["service_rss_bytes"].items():
                peak_snapshot["service_rss_bytes"][service] = max(
                    peak_snapshot["service_rss_bytes"][service],
                    rss,
                )
            for service, size in snapshot["service_writable_layer_bytes"].items():
                peak_snapshot["service_writable_layer_bytes"][service] = max(
                    peak_snapshot["service_writable_layer_bytes"][service],
                    size,
                )
            time.sleep(2)

        (evidence_dir / "capacity-measurements.json").write_text(
            json.dumps(peak_snapshot, indent=2, sort_keys=True),
            encoding="utf-8",
        )
    finally:
        cleanup_probe.cleanup(
            execute=True,
            evidence_dir=evidence_dir,
            delete_evidence=False,
            image_manifest=image_manifest,
        )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--validate-only", action="store_true")
    parser.add_argument("--run", action="store_true")
    args = parser.parse_args()
    if args.validate_only == args.run:
        parser.error("choose exactly one of --validate-only or --run")
    try:
        configuration = validate_environment(require_files=args.run)
        if args.validate_only:
            print("probe validation passed; no Docker action was performed")
            return 0
        run_probe(configuration)
    except Exception as exc:
        print(f"probe blocked: {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
