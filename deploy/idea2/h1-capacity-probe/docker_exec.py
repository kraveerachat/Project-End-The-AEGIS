#!/usr/bin/env python3
"""Explicit least-privilege Docker execution for the H1 capacity probe."""

from __future__ import annotations

import json
import os
from pathlib import Path
import stat
import subprocess


MODE_ENV = "AEGIS_CAPACITY_PROBE_DOCKER_MODE"
COMPOSE_ENV_FILE_ENV = "AEGIS_CAPACITY_PROBE_COMPOSE_ENV_FILE"
DIRECT_MODE = "direct"
SUDO_MODE = "sudo-noninteractive"
ALLOWED_MODES = (DIRECT_MODE, SUDO_MODE)

# These are exactly the variables interpolated by h1-capacity-probe.compose.yml.
# They are carried in one owner-only file so neither direct Docker nor sudo needs
# probe secrets in its process environment.
COMPOSE_ENV_NAMES = (
    "POSTGRES_GROWTH_BUDGET_BYTES",
    "HOST_RAM_RESERVE_BYTES",
    "DISK_SAFETY_RESERVE_BYTES",
    "EVIDENCE_LOG_CAP_BYTES",
    "INODE_SAFETY_RESERVE_COUNT",
    "PROBE_SERVICE_LOG_MAX_SIZE",
    "POSTGRES_IMAGE",
    "PROBE_POSTGRES_PASSWORD",
    "POSTGRES_MEMORY_CEILING_BYTES",
    "MONITOR_BASE_IMAGE",
    "MONITOR_CANDIDATE_IMAGE",
    "PROBE_SESSION_SECRET",
    "MONITOR_MEMORY_CEILING_BYTES",
    "GATEWAY_BASE_IMAGE",
    "GATEWAY_CANDIDATE_IMAGE",
    "PROBE_TLS_CERT_FILE",
    "PROBE_TLS_KEY_FILE",
    "GATEWAY_MEMORY_CEILING_BYTES",
)


class DockerExecutionError(RuntimeError):
    """The reviewed Docker execution boundary is unavailable or invalid."""


def execution_mode() -> str:
    value = os.environ.get(MODE_ENV, "")
    if value not in ALLOWED_MODES:
        allowed = "|".join(ALLOWED_MODES)
        raise DockerExecutionError(f"{MODE_ENV} must be explicitly set to {allowed}")
    return value


def _docker_prefix() -> list[str]:
    if execution_mode() == DIRECT_MODE:
        return ["docker"]
    return ["sudo", "-n", "env", "-u", "DOCKER_HOST", "docker"]


def docker_command(*arguments: str, compose: bool = False) -> list[str]:
    command = _docker_prefix()
    if compose:
        compose_env_file = os.environ.get(COMPOSE_ENV_FILE_ENV, "")
        if not compose_env_file:
            raise DockerExecutionError(
                f"{COMPOSE_ENV_FILE_ENV} is required for every Docker Compose command"
            )
        command.extend(["compose", "--env-file", compose_env_file])
    command.extend(arguments)
    return command


def subprocess_environment() -> dict[str, str]:
    """Return a child environment that cannot leak Compose inputs."""

    child = dict(os.environ)
    for name in COMPOSE_ENV_NAMES:
        child.pop(name, None)
    return child


def ensure_unprivileged_python() -> None:
    get_euid = getattr(os, "geteuid", None)
    if get_euid is not None and get_euid() == 0:
        raise DockerExecutionError("the capacity-probe Python process must not run as root")


def ensure_docker_authorized() -> None:
    command = docker_command("version", "--format", "{{.Server.Version}}")
    result = subprocess.run(
        command,
        check=False,
        capture_output=True,
        text=True,
        timeout=30,
        env=subprocess_environment(),
    )
    if result.returncode == 0 and result.stdout.strip():
        return
    if execution_mode() == SUDO_MODE:
        raise DockerExecutionError(
            "non-interactive Docker authorization is unavailable; run sudo -v in the human terminal and retry"
        )
    raise DockerExecutionError("direct Docker authorization is unavailable")


def compose_environment_path(evidence_dir: Path) -> Path:
    resolved = evidence_dir.resolve()
    if not resolved.name.startswith("aegis-h1-capacity-probe-") or resolved.parent == resolved:
        raise DockerExecutionError("refusing an unbounded Compose environment path")
    return resolved.parent / f".{resolved.name}.compose.env"


def select_compose_environment_path(evidence_dir: Path) -> Path:
    path = compose_environment_path(evidence_dir)
    os.environ[COMPOSE_ENV_FILE_ENV] = str(path)
    return path


def _validated_existing_compose_environment(path: Path) -> None:
    details = path.lstat()
    if path.is_symlink() or not stat.S_ISREG(details.st_mode):
        raise DockerExecutionError("the Compose environment path is not a regular file")
    if os.name == "posix" and details.st_mode & 0o077:
        raise DockerExecutionError("the Compose environment file must be mode 0600")
    get_euid = getattr(os, "geteuid", None)
    if os.name == "posix" and get_euid is not None and details.st_uid != get_euid():
        raise DockerExecutionError("the Compose environment file is not owned by the probe operator")


def require_compose_environment(evidence_dir: Path) -> Path:
    path = select_compose_environment_path(evidence_dir)
    _validated_existing_compose_environment(path)
    return path


def prepare_compose_environment(evidence_dir: Path) -> Path:
    path = select_compose_environment_path(evidence_dir)
    values: list[str] = []
    for name in COMPOSE_ENV_NAMES:
        value = os.environ.get(name)
        if value is None or value == "":
            raise DockerExecutionError(f"{name} is required before creating the Compose environment file")
        if any(character in value for character in ("\x00", "\r", "\n", "$")):
            raise DockerExecutionError(f"{name} contains a value unsafe for the Compose environment file")
        values.append(f"{name}={json.dumps(value)}\n")
    expected_content = "".join(values)

    if path.exists() or path.is_symlink():
        _validated_existing_compose_environment(path)
        if path.read_text(encoding="utf-8") != expected_content:
            raise DockerExecutionError("the existing Compose environment file does not match reviewed inputs")
        return path

    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    descriptor = os.open(path, flags, 0o600)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as stream:
            stream.write(expected_content)
    except Exception:
        path.unlink(missing_ok=True)
        raise
    os.chmod(path, 0o600)
    _validated_existing_compose_environment(path)
    return path


def remove_compose_environment(path: Path | None) -> None:
    try:
        if path is not None and (path.exists() or path.is_symlink()):
            _validated_existing_compose_environment(path)
            path.unlink()
    finally:
        os.environ.pop(COMPOSE_ENV_FILE_ENV, None)
