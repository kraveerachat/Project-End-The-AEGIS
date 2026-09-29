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
import selectors
import signal
import subprocess
import sys
import time
from typing import Any, NamedTuple

import cleanup_probe
import docker_exec
import watchdog


PROJECT_NAME = "aegis-h1-capacity-probe"
BUILDER_NAME = "aegis-h1-capacity-builder"
COMPOSE_FILE = Path(__file__).resolve().parents[1] / "h1-capacity-probe.compose.yml"
REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
DIGEST_REFERENCE = re.compile(r"^[^\s@]+@sha256:[0-9a-f]{64}$")
SOURCE_SHA = re.compile(r"^[0-9a-f]{40}$")
PROBE_TAG = re.compile(r"^aegis-h1-capacity-probe-(?:monitor|gateway):[a-z0-9][a-z0-9._-]*$")
STARTUP_LOG_SERVICES = ("gateway", "monitor")
STARTUP_LOG_TAIL_LINES = 200
STARTUP_LOG_BYTE_CAP = 32 * 1024
STARTUP_LOG_CAPTURE_TIMEOUT_SECONDS = 10
STARTUP_LOG_READ_CHUNK_BYTES = 4 * 1024

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
    "PROBE_WORKLOAD_REQUEST_COUNT",
    "PROBE_WORKLOAD_POSTGRES_ROWS",
    "PROBE_WORKLOAD_POSTGRES_PAYLOAD_BYTES",
)


class ValidationError(RuntimeError):
    pass


class _BoundedCommandResult(NamedTuple):
    returncode: int
    stdout: bytes
    truncated: bool


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
    try:
        docker_exec.execution_mode()
    except docker_exec.DockerExecutionError as exc:
        errors.append(str(exc))
    for name in ("MONITOR_BASE_IMAGE", "POSTGRES_IMAGE", "GATEWAY_BASE_IMAGE"):
        value = os.environ.get(name, "")
        if not DIGEST_REFERENCE.fullmatch(value):
            errors.append(f"{name} must be an immutable digest-form @sha256 reference")

    source_sha = os.environ.get("MONITOR_SOURCE_SHA", "")
    source_tree = ""
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
        tree_result = subprocess.run(
            ["git", "rev-parse", "HEAD^{tree}"],
            cwd=REPOSITORY_ROOT,
            check=False,
            capture_output=True,
            text=True,
            timeout=10,
        )
        if tree_result.returncode != 0 or not SOURCE_SHA.fullmatch(tree_result.stdout.strip()):
            errors.append("committed source tree identity is unavailable")
        else:
            source_tree = tree_result.stdout.strip()
        if require_files:
            status_result = subprocess.run(
                ["git", "status", "--porcelain=v1", "--untracked-files=all"],
                cwd=REPOSITORY_ROOT,
                check=False,
                capture_output=True,
                text=True,
                timeout=10,
            )
            if status_result.returncode != 0 or status_result.stdout.strip():
                errors.append("active probe requires a clean committed build context")

    for name in ("MONITOR_CANDIDATE_IMAGE", "GATEWAY_CANDIDATE_IMAGE"):
        value = os.environ.get(name, "")
        if not PROBE_TAG.fullmatch(value):
            errors.append(f"{name} must use the isolated probe-only tag namespace")
        elif source_sha and not value.endswith(f":{source_sha[:12]}"):
            errors.append(f"{name} must be bound to the first 12 characters of MONITOR_SOURCE_SHA")

    numeric = {name: _positive_integer(name, errors) for name in POSITIVE_INTEGER_INPUTS}
    rows = numeric.get("PROBE_WORKLOAD_POSTGRES_ROWS")
    payload = numeric.get("PROBE_WORKLOAD_POSTGRES_PAYLOAD_BYTES")
    maximum_new = numeric.get("CHARACTERIZATION_MAX_NEW_BYTES")
    if rows and payload and maximum_new and rows * payload > maximum_new:
        errors.append("bounded PostgreSQL workload exceeds CHARACTERIZATION_MAX_NEW_BYTES")
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
    return {
        "numeric": numeric,
        "evidence_dir": evidence_dir,
        "source_sha": source_sha,
        "source_tree": source_tree,
    }


def _run(command: list[str], *, timeout: int = 120, output_file: Path | None = None) -> str:
    if output_file is None:
        result = subprocess.run(
            command,
            check=False,
            capture_output=True,
            text=True,
            timeout=timeout,
            env=docker_exec.subprocess_environment(),
        )
        if result.returncode != 0:
            detail = (result.stderr or result.stdout or "no diagnostic").strip().splitlines()[-1]
            raise RuntimeError(f"command failed: {command[0]} ({detail})")
        return result.stdout.strip()
    with output_file.open("a", encoding="utf-8") as stream:
        result = subprocess.run(
            command,
            check=False,
            stdout=stream,
            stderr=subprocess.STDOUT,
            text=True,
            timeout=timeout,
            env=docker_exec.subprocess_environment(),
        )
    if result.returncode != 0:
        raise RuntimeError(f"command failed: {command[0]} (see redacted probe log)")
    return ""


def _redact_startup_log(value: str) -> str:
    redacted = value
    for name in ("PROBE_POSTGRES_PASSWORD", "PROBE_SESSION_SECRET"):
        secret = os.environ.get(name, "")
        if secret:
            redacted = redacted.replace(secret, "[REDACTED]")
    redacted = re.sub(
        r"(?i)(postgres(?:ql)?://[^:\s/@]+:)[^@\s/]+(@)",
        r"\1[REDACTED]\2",
        redacted,
    )
    private_key_begin = r"-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----"
    private_key_end = r"-----END(?: [A-Z0-9]+)* PRIVATE KEY-----"
    redacted = re.sub(
        private_key_begin + r".*?" + private_key_end,
        "[REDACTED PRIVATE KEY]",
        redacted,
        flags=re.DOTALL | re.IGNORECASE,
    )
    redacted = re.sub(
        private_key_begin + r".*\Z",
        "[REDACTED PRIVATE KEY]",
        redacted,
        flags=re.DOTALL | re.IGNORECASE,
    )
    redacted = re.sub(
        r"\A.*?" + private_key_end,
        "[REDACTED PRIVATE KEY]",
        redacted,
        flags=re.DOTALL | re.IGNORECASE,
    )
    return re.sub(
        r"(?im)\b(password|passwd|session_secret|secret|token|api_key)\b\s*[:=]\s*\S+",
        r"\1=[REDACTED]",
        redacted,
    )


def _bounded_log_tail(value: str) -> tuple[str, bool]:
    encoded = value.encode("utf-8")
    if len(encoded) <= STARTUP_LOG_BYTE_CAP:
        return value, False
    return encoded[-STARTUP_LOG_BYTE_CAP:].decode("utf-8", errors="ignore"), True


def _bounded_bytes_tail(chunks: Any, byte_cap: int) -> tuple[bytes, bool]:
    tail = bytearray()
    truncated = False
    for chunk in chunks:
        if not isinstance(chunk, (bytes, bytearray)):
            raise TypeError("bounded output chunks must be bytes")
        tail.extend(chunk)
        if len(tail) > byte_cap:
            del tail[:-byte_cap]
            truncated = True
    return bytes(tail), truncated


def _terminate_bounded_process(process: subprocess.Popen[bytes]) -> None:
    if process.poll() is not None:
        return
    try:
        if os.name == "posix":
            os.killpg(process.pid, signal.SIGKILL)
        else:
            process.kill()
    except ProcessLookupError:
        pass
    try:
        process.wait(timeout=1)
    except subprocess.TimeoutExpired:
        process.kill()


def _run_bounded_command_output(
    command: list[str],
    *,
    timeout: float,
    byte_cap: int,
) -> _BoundedCommandResult:
    process = subprocess.Popen(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        env=docker_exec.subprocess_environment(),
        process_group=0 if os.name == "posix" else None,
    )
    if process.stdout is None:
        _terminate_bounded_process(process)
        raise RuntimeError("bounded command output pipe unavailable")

    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    deadline = time.monotonic() + timeout
    tail = b""
    truncated = False
    try:
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise subprocess.TimeoutExpired(command, timeout)
            events = selector.select(timeout=min(0.25, remaining))
            if not events:
                continue
            chunk = os.read(process.stdout.fileno(), STARTUP_LOG_READ_CHUNK_BYTES)
            if not chunk:
                break
            tail, chunk_truncated = _bounded_bytes_tail((tail, chunk), byte_cap)
            truncated = truncated or chunk_truncated
        returncode = process.wait(timeout=max(0.1, deadline - time.monotonic()))
        return _BoundedCommandResult(returncode, tail, truncated)
    except BaseException:
        _terminate_bounded_process(process)
        raise
    finally:
        selector.close()
        process.stdout.close()


def _capture_service_startup_diagnostics(
    evidence_dir: Path,
    readiness_evidence: dict[str, Any],
) -> Path:
    containers = readiness_evidence.get("containers")
    if not isinstance(containers, list):
        containers = []
    evidence: dict[str, Any] = {
        "tail_lines": STARTUP_LOG_TAIL_LINES,
        "per_service_byte_cap": STARTUP_LOG_BYTE_CAP,
        "total_timeout_seconds": STARTUP_LOG_CAPTURE_TIMEOUT_SECONDS,
        "services": {},
    }
    deadline = time.monotonic() + STARTUP_LOG_CAPTURE_TIMEOUT_SECONDS
    for service in STARTUP_LOG_SERVICES:
        matches = [
            container
            for container in containers
            if isinstance(container, dict) and container.get("service") == service
        ]
        if len(matches) != 1:
            evidence["services"][service] = {
                "status": "unavailable",
                "reason": "container-identity-not-unique",
                "log": "",
                "truncated": False,
            }
            continue
        container = matches[0]
        container_id = str(container.get("container_id") or "")
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            evidence["services"][service] = {
                "container_id": container_id,
                "name": str(container.get("name") or ""),
                "status": "unavailable",
                "reason": "diagnostic-deadline-exhausted",
                "log": "",
                "truncated": False,
            }
            continue
        try:
            result = _run_bounded_command_output(
                docker_exec.docker_command(
                    "logs",
                    "--tail",
                    str(STARTUP_LOG_TAIL_LINES),
                    container_id,
                ),
                timeout=remaining,
                byte_cap=STARTUP_LOG_BYTE_CAP,
            )
            bounded_output, raw_truncated = _bounded_bytes_tail(
                (bytes(result.stdout or b""),),
                STARTUP_LOG_BYTE_CAP,
            )
            output = bounded_output.decode("utf-8", errors="ignore")
            safe_output, redaction_truncated = _bounded_log_tail(
                _redact_startup_log(output)
            )
            evidence["services"][service] = {
                "container_id": container_id,
                "name": str(container.get("name") or ""),
                "status": "captured" if result.returncode == 0 else "unavailable",
                "reason": None if result.returncode == 0 else "docker-logs-failed",
                "log": safe_output,
                "truncated": (
                    bool(result.truncated) or raw_truncated or redaction_truncated
                ),
            }
        except subprocess.TimeoutExpired:
            evidence["services"][service] = {
                "container_id": container_id,
                "name": str(container.get("name") or ""),
                "status": "unavailable",
                "reason": "docker-logs-timeout",
                "log": "",
                "truncated": False,
            }
    path = evidence_dir / "service-startup-logs.json"
    path.write_text(json.dumps(evidence, indent=2, sort_keys=True), encoding="utf-8")
    return path


def _run_guarded(
    command: list[str],
    *,
    output_file: Path,
    evidence_dir: Path,
    limits: dict[str, Any],
    baseline: dict[str, Any],
    timeout: int,
) -> None:
    started = time.monotonic()
    with output_file.open("a", encoding="utf-8") as stream:
        process = subprocess.Popen(
            command,
            stdout=stream,
            stderr=subprocess.STDOUT,
            text=True,
            env=docker_exec.subprocess_environment(),
        )
        while process.poll() is None:
            if time.monotonic() - started > timeout:
                process.terminate()
                watchdog.stop_probe()
                raise RuntimeError(f"guarded command timed out: {command[0]}")
            try:
                _guard_host(evidence_dir, limits, baseline=baseline)
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


def _merge_peak_snapshot(peak: dict[str, Any], snapshot: dict[str, Any]) -> dict[str, Any]:
    for field in (
        "aggregate_lab_memory_usage_bytes",
        "evidence_log_bytes",
        "postgres_growth_bytes",
        "postgres_volume_bytes",
        "probe_new_bytes",
    ):
        peak[field] = max(int(peak[field]), int(snapshot[field]))
    for field in (
        "host_available_bytes",
        "host_available_inodes",
        "host_mem_available_bytes",
    ):
        peak[field] = min(int(peak[field]), int(snapshot[field]))
    for field in ("service_memory_usage_bytes", "service_writable_layer_bytes"):
        for service, value in snapshot[field].items():
            peak[field][service] = max(int(peak[field][service]), int(value))
    return peak


def _run_workload_guarded(
    command: list[str],
    *,
    output_file: Path,
    evidence_dir: Path,
    limits: dict[str, Any],
    baseline: dict[str, Any],
    postgres_initial_volume_bytes: int,
    peak_snapshot: dict[str, Any],
    timeout: int,
) -> dict[str, Any]:
    started = time.monotonic()
    with output_file.open("a", encoding="utf-8") as stream:
        process = subprocess.Popen(
            command,
            stdout=stream,
            stderr=subprocess.STDOUT,
            text=True,
            env=docker_exec.subprocess_environment(),
        )
        while True:
            if time.monotonic() - started > timeout:
                process.terminate()
                watchdog.stop_probe()
                raise RuntimeError(f"guarded workload timed out: {command[0]}")
            try:
                snapshot = watchdog.capture_snapshot(
                    evidence_dir,
                    postgres_initial_volume_bytes,
                    baseline["host_available_bytes"],
                )
                violations = watchdog.evaluate_snapshot(snapshot, limits)
                if violations:
                    raise RuntimeError(f"capacity boundary blocked: {','.join(violations)}")
                _merge_peak_snapshot(peak_snapshot, snapshot)
            except Exception:
                process.terminate()
                watchdog.stop_probe()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                raise
            if process.poll() is not None:
                break
            time.sleep(0.5)
        if process.returncode != 0:
            raise RuntimeError(f"workload command failed: {command[0]} (see redacted probe log)")
    return peak_snapshot


def _compose_command(*arguments: str) -> list[str]:
    return docker_exec.docker_command(
        "--project-name",
        PROJECT_NAME,
        "--file",
        str(COMPOSE_FILE),
        *arguments,
        compose=True,
    )


def _image_id(reference: str) -> str | None:
    result = subprocess.run(
        docker_exec.docker_command("image", "inspect", "--format", "{{.Id}}", reference),
        check=False,
        capture_output=True,
        text=True,
        timeout=30,
        env=docker_exec.subprocess_environment(),
    )
    return result.stdout.strip() if result.returncode == 0 else None


def _image_size(reference: str) -> int:
    return int(
        _run(docker_exec.docker_command("image", "inspect", "--format", "{{.Size}}", reference))
    )


def _assert_no_probe_collision() -> None:
    containers = _run(
        docker_exec.docker_command(
            "ps",
            "--all",
            "--filter",
            f"label=com.docker.compose.project={PROJECT_NAME}",
            "--format",
            "{{.ID}}",
        )
    )
    if containers:
        raise ValidationError("probe project resources already exist")
    if subprocess.run(
        docker_exec.docker_command("volume", "inspect", cleanup_probe.POSTGRES_VOLUME),
        check=False,
        capture_output=True,
        text=True,
        timeout=30,
        env=docker_exec.subprocess_environment(),
    ).returncode == 0:
        raise ValidationError("probe PostgreSQL volume already exists")
    if subprocess.run(
        docker_exec.docker_command("buildx", "inspect", BUILDER_NAME),
        check=False,
        capture_output=True,
        text=True,
        timeout=30,
        env=docker_exec.subprocess_environment(),
    ).returncode == 0:
        raise ValidationError("probe Buildx builder already exists")
    for name in ("MONITOR_CANDIDATE_IMAGE", "GATEWAY_CANDIDATE_IMAGE"):
        if _image_id(os.environ[name]) is not None:
            raise ValidationError(f"probe candidate image already exists: {name}")


def _record_introduced_images(
    before: dict[str, str | None],
    evidence_dir: Path,
    *,
    require_complete: bool,
) -> Path:
    entries: list[dict[str, Any]] = []
    for name in ("MONITOR_CANDIDATE_IMAGE", "GATEWAY_CANDIDATE_IMAGE"):
        reference = os.environ[name]
        after = _image_id(reference)
        if after is None and require_complete:
            raise RuntimeError(f"candidate image is missing after build: {name}")
        if after is None:
            continue
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


def _guard_host(
    evidence_dir: Path,
    limits: dict[str, Any],
    *,
    baseline: dict[str, Any] | None = None,
) -> dict[str, Any]:
    snapshot = watchdog.capture_preflight_snapshot(evidence_dir)
    if baseline is not None:
        snapshot["probe_new_bytes"] = max(
            0,
            int(baseline["host_available_bytes"]) - int(snapshot["host_available_bytes"]),
        )
    violations = watchdog.evaluate_snapshot(snapshot, limits)
    maximum_new = int(os.environ["CHARACTERIZATION_MAX_NEW_BYTES"])
    if snapshot["host_available_bytes"] <= maximum_new + limits["disk_safety_reserve_bytes"]:
        violations.append("CHARACTERIZATION_DISK_ENVELOPE_UNAVAILABLE")
    if violations:
        watchdog.stop_probe()
        raise RuntimeError(f"capacity boundary blocked: {','.join(violations)}")
    return snapshot


def _run_bounded_workload(
    configuration: dict[str, Any],
    *,
    output_file: Path,
    evidence_dir: Path,
    limits: dict[str, Any],
    baseline: dict[str, Any],
    postgres_initial_volume_bytes: int,
    peak_snapshot: dict[str, Any],
) -> dict[str, Any]:
    numeric = configuration["numeric"]
    rows = int(numeric["PROBE_WORKLOAD_POSTGRES_ROWS"])
    payload_bytes = int(numeric["PROBE_WORKLOAD_POSTGRES_PAYLOAD_BYTES"])
    request_count = int(numeric["PROBE_WORKLOAD_REQUEST_COUNT"])
    sql = (
        "CREATE SCHEMA IF NOT EXISTS capacity_probe; "
        "DROP TABLE IF EXISTS capacity_probe.synthetic_events; "
        "CREATE TABLE capacity_probe.synthetic_events (id bigint PRIMARY KEY, payload text NOT NULL); "
        f"INSERT INTO capacity_probe.synthetic_events "
        f"SELECT value, repeat('x', {payload_bytes}) FROM generate_series(1, {rows}) AS value; "
        "CHECKPOINT;"
    )
    peak_snapshot = _run_workload_guarded(
        _compose_command(
            "exec",
            "--no-TTY",
            "postgres",
            "psql",
            "--set",
            "ON_ERROR_STOP=1",
            "--username",
            "monitor_probe",
            "--dbname",
            "aegis_h1_capacity_probe",
            "--command",
            sql,
        ),
        output_file=output_file,
        evidence_dir=evidence_dir,
        limits=limits,
        baseline=baseline,
        postgres_initial_volume_bytes=postgres_initial_volume_bytes,
        peak_snapshot=peak_snapshot,
        timeout=600,
    )
    health_script = (
        "const count=Number(process.argv[1]);"
        "(async()=>{for(let i=0;i<count;i++){"
        "const response=await fetch('http://127.0.0.1:8002/healthz');"
        "if(!response.ok)throw new Error('health request failed');"
        "await response.arrayBuffer();}})().catch(error=>{console.error(error.message);process.exit(2)});"
    )
    return _run_workload_guarded(
        _compose_command(
            "exec",
            "--no-TTY",
            "monitor",
            "node",
            "--eval",
            health_script,
            str(request_count),
        ),
        output_file=output_file,
        evidence_dir=evidence_dir,
        limits=limits,
        baseline=baseline,
        postgres_initial_volume_bytes=postgres_initial_volume_bytes,
        peak_snapshot=peak_snapshot,
        timeout=600,
    )


def _run_probe_authorized(configuration: dict[str, Any], evidence_dir: Path) -> None:
    log_path = evidence_dir / "probe.log"
    limits = watchdog.limits_from_environment()
    _assert_no_probe_collision()
    before_images = {
        name: _image_id(os.environ[name])
        for name in ("MONITOR_CANDIDATE_IMAGE", "GATEWAY_CANDIDATE_IMAGE")
    }
    image_manifest: Path | None = None
    baseline = _guard_host(evidence_dir, limits)
    source_manifest = {
        "source_sha": configuration["source_sha"],
        "source_tree": configuration["source_tree"],
    }
    (evidence_dir / "source-manifest.json").write_text(
        json.dumps(source_manifest, indent=2, sort_keys=True),
        encoding="utf-8",
    )
    (evidence_dir / "host-baseline.json").write_text(
        json.dumps(baseline, indent=2, sort_keys=True),
        encoding="utf-8",
    )

    try:
        _run(
            docker_exec.docker_command(
                "buildx",
                "create",
                "--name",
                BUILDER_NAME,
                "--driver",
                "docker-container",
                "--use",
            )
        )
        _guard_host(evidence_dir, limits, baseline=baseline)
        _run_guarded(
            _compose_command("build"),
            output_file=log_path,
            evidence_dir=evidence_dir,
            limits=limits,
            baseline=baseline,
            timeout=3600,
        )
        image_manifest = _record_introduced_images(before_images, evidence_dir, require_complete=True)
        post_build = _guard_host(evidence_dir, limits, baseline=baseline)
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
            baseline=baseline,
            timeout=600,
        )

        deadline = time.monotonic() + 120
        initial_volume = None
        ready_snapshot = None
        last_readiness_error: watchdog.ProbeServicesUnavailable | None = None
        while time.monotonic() < deadline:
            try:
                _guard_host(evidence_dir, limits, baseline=baseline)
                snapshot = watchdog.capture_snapshot(
                    evidence_dir,
                    None,
                    baseline["host_available_bytes"],
                )
                initial_volume = int(snapshot["postgres_volume_bytes"])
                violations = watchdog.evaluate_snapshot(snapshot, limits)
                if violations:
                    watchdog.stop_probe()
                    raise RuntimeError(f"capacity boundary blocked: {','.join(violations)}")
                if not violations:
                    ready_snapshot = snapshot
                    break
            except watchdog.ProbeServicesUnavailable as exc:
                last_readiness_error = exc
                (evidence_dir / "service-readiness.json").write_text(
                    json.dumps(exc.evidence, indent=2, sort_keys=True),
                    encoding="utf-8",
                )
            except watchdog.ProbeBlocked:
                watchdog.stop_probe()
                raise
            except Exception:
                watchdog.stop_probe()
                raise
            time.sleep(2)
        if initial_volume is None or ready_snapshot is None:
            if last_readiness_error is not None:
                diagnostic_error: str | None = None
                try:
                    _capture_service_startup_diagnostics(
                        evidence_dir,
                        last_readiness_error.evidence,
                    )
                except Exception as exc:
                    diagnostic_error = type(exc).__name__
                with log_path.open("a", encoding="utf-8") as stream:
                    stream.write(f"probe readiness timeout: {last_readiness_error}\n")
                    if diagnostic_error is not None:
                        stream.write(
                            "probe startup diagnostic unavailable: "
                            f"{diagnostic_error}\n"
                        )
            watchdog.stop_probe()
            if last_readiness_error is not None:
                raise last_readiness_error
            raise RuntimeError("probe services did not become measurable without a readiness diagnostic")

        artifact_measurements["postgres_image_bytes"] = _image_size(os.environ["POSTGRES_IMAGE"])
        artifact_measurements["postgres_initial_volume_bytes"] = initial_volume
        (evidence_dir / "artifact-measurements.json").write_text(
            json.dumps(artifact_measurements, indent=2, sort_keys=True),
            encoding="utf-8",
        )
        peak_snapshot = _run_bounded_workload(
            configuration,
            output_file=log_path,
            evidence_dir=evidence_dir,
            limits=limits,
            baseline=baseline,
            postgres_initial_volume_bytes=initial_volume,
            peak_snapshot=ready_snapshot,
        )
        sample_seconds = int(os.environ["PROBE_SAMPLE_SECONDS"])
        sample_deadline = time.monotonic() + sample_seconds
        while time.monotonic() < sample_deadline:
            snapshot = watchdog.capture_snapshot(
                evidence_dir,
                initial_volume,
                baseline["host_available_bytes"],
            )
            violations = watchdog.evaluate_snapshot(snapshot, limits)
            if violations:
                watchdog.stop_probe()
                raise RuntimeError(f"capacity boundary blocked: {','.join(violations)}")
            peak_snapshot["aggregate_lab_memory_usage_bytes"] = max(
                peak_snapshot["aggregate_lab_memory_usage_bytes"],
                snapshot["aggregate_lab_memory_usage_bytes"],
            )
            peak_snapshot["probe_new_bytes"] = max(
                peak_snapshot["probe_new_bytes"],
                snapshot["probe_new_bytes"],
            )
            peak_snapshot["evidence_log_bytes"] = max(
                peak_snapshot["evidence_log_bytes"], snapshot["evidence_log_bytes"]
            )
            peak_snapshot["postgres_growth_bytes"] = max(
                peak_snapshot["postgres_growth_bytes"], snapshot["postgres_growth_bytes"]
            )
            peak_snapshot["postgres_volume_bytes"] = max(
                peak_snapshot["postgres_volume_bytes"], snapshot["postgres_volume_bytes"]
            )
            peak_snapshot["host_available_bytes"] = min(
                peak_snapshot["host_available_bytes"], snapshot["host_available_bytes"]
            )
            peak_snapshot["host_available_inodes"] = min(
                peak_snapshot["host_available_inodes"], snapshot["host_available_inodes"]
            )
            peak_snapshot["host_mem_available_bytes"] = min(
                peak_snapshot["host_mem_available_bytes"], snapshot["host_mem_available_bytes"]
            )
            for service, usage in snapshot["service_memory_usage_bytes"].items():
                peak_snapshot["service_memory_usage_bytes"][service] = max(
                    peak_snapshot["service_memory_usage_bytes"][service],
                    usage,
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
        final_snapshot = watchdog.capture_snapshot(
            evidence_dir,
            initial_volume,
            baseline["host_available_bytes"],
        )
        final_violations = watchdog.evaluate_snapshot(final_snapshot, limits)
        if final_violations:
            watchdog.stop_probe()
            raise RuntimeError(f"capacity boundary blocked: {','.join(final_violations)}")
    finally:
        manifest_error: Exception | None = None
        try:
            image_manifest = _record_introduced_images(
                before_images,
                evidence_dir,
                require_complete=False,
            )
        except Exception as exc:
            manifest_error = exc
        try:
            cleanup_probe.cleanup(
                execute=True,
                evidence_dir=evidence_dir,
                delete_evidence=False,
                image_manifest=image_manifest,
                fallback_image_references=(
                    os.environ["MONITOR_CANDIDATE_IMAGE"],
                    os.environ["GATEWAY_CANDIDATE_IMAGE"],
                ),
            )
        finally:
            if manifest_error is not None:
                raise manifest_error


def run_probe(configuration: dict[str, Any]) -> None:
    if os.environ.get("AEGIS_CAPACITY_PROBE_AUTHORIZED") != "YES":
        raise ValidationError("active probe requires AEGIS_CAPACITY_PROBE_AUTHORIZED=YES")

    docker_exec.ensure_unprivileged_python()
    docker_exec.ensure_docker_authorized()
    evidence_dir: Path = configuration["evidence_dir"]
    if evidence_dir.exists() and any(evidence_dir.iterdir()):
        raise ValidationError("probe evidence directory must be new or empty")
    evidence_dir.mkdir(parents=True, exist_ok=True)
    (evidence_dir / cleanup_probe.EVIDENCE_MARKER).write_text(f"{PROJECT_NAME}\n", encoding="utf-8")
    compose_environment = docker_exec.prepare_compose_environment(evidence_dir)
    try:
        _run_probe_authorized(configuration, evidence_dir)
    finally:
        docker_exec.remove_compose_environment(compose_environment)


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
