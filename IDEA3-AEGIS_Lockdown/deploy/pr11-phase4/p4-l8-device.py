#!/usr/bin/env python3

"""Repository-safe IDEA3 PR11 Phase 4 L8 device provisioning helper.

Authority: IDEA3-AEGIS_Lockdown/docs/superpowers/specs/
  2026-09-21-idea3-pr11-phase4-l8-operational-design.md (OD-L8-01..OD-L8-09)
Regression tests: IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l8_handler.py

Capability boundary, deliberately narrow:

* Two device backends exist. ``fixture`` is a file-backed mock with no serial
  code path. ``hardware`` is implemented in the repository
  (HARDWARE_BACKEND_IMPLEMENTED_REPOSITORY) as a thin adapter over the
  PlatformIO-pinned esptool (``tool-esptoolpy``, the tool
  ``platform = espressif32@7.0.1`` resolves). It is NOT authorized to run:
  LIVE_L8=NOT_AUTHORIZED. Merely importing this module or constructing a
  backend touches nothing; only an explicit live authorization plus a
  maintenance window lets a command reach a device.
* Every external command goes through one narrow, injectable executor and
  through a strict argv allowlist (``validate_esptool_argv``). The only
  subcommands are ``flash_id``, ``write_flash`` and ``read_flash``, bound to
  the port named in the validated OV-12 binding and to the two partition
  regions derived from the reviewed table. Erase, memory writes, eFuse, a
  PlatformIO upload target, relay CUT/RESTORE and MQTT are unreachable.
* Boot verification is a signed BOOT STATUS observed passively by
  ``p4-l8-boot-verify.py`` (subscribe-only MQTT, TLS 8883, the staged Core
  broker credential, the real Protocol v1 verifier over ephemeral state).
  PASS means AUTHENTICATED_FIRMWARE_REPORTED_LOCKDOWN, not electrical relay
  proof. The hardware path refuses before any device access unless that
  verifier is configured (``BOOT_VERIFICATION_NOT_CONFIGURED``).
* No Production key material is ever generated here. Protocol keys arrive as
  owner-supplied files and are validated by the merged provisioner
  (``p4-nvs-provision.py``), which also refuses known demo/test keys.
* The NVS offset is derived from the reviewed build's partition table. There
  is no default, and in particular no fallback to the stock ESP-IDF offset.
* Hardware evidence is a stage-local private JSON bundle restricted to an
  exact field allowlist, created write-once at mode 0600. No secret, and no
  raw NVS content, may enter it.
* INTERIM_RECOVERY_PROCEDURE=NOT_APPROVED (OD-14): recovery is D4 only, so
  nothing here implements an alternative recovery path.
"""

from __future__ import annotations

import argparse
import hashlib
import hmac
import importlib.util
import json
import os
import re
import stat
import subprocess
import sys
from pathlib import Path
from typing import Callable, NamedTuple, Protocol, Sequence

HERE = Path(__file__).resolve().parent

EVIDENCE_SCHEMA_VERSION = 1

# OD-L8-09: the exact and only fields a hardware evidence bundle may carry.
EVIDENCE_FIELDS = (
    "schema_version",
    "run_id",
    "device_mac",
    "chip_identity",
    "flash_size",
    "firmware_sha256",
    "nvs_schema_version",
    "nvs_readback_match",
    "firmware_readback_match",
    "flash_result",
    "boot_verification_result",
    "failure_boundary",
)

# The hardware backend binds to the toolchain the repository already pins:
# firmware/platformio.ini sets platform = espressif32@7.0.1 and
# upload_speed = 115200, and that platform resolves tool-esptoolpy ~2.41100.0
# (esptool 4.11.x, underscore subcommands). No pyserial, no second flasher.
PINNED_ESPTOOL_PACKAGE = ("tool-esptoolpy", "2.41100.0")
HARDWARE_CHIP = "esp32"
HARDWARE_BAUD = 115200

# The only esptool subcommands the hardware backend may ever issue.
ESPTOOL_ALLOWED_SUBCOMMANDS = ("flash_id", "write_flash", "read_flash")
ESPTOOL_AFTER_MODES = ("no_reset", "hard_reset")
# Number of fixed global-option tokens between the launcher and the subcommand:
# --chip C --port P --baud B --before M --after A
ESPTOOL_GLOBAL_TOKENS = 10

TOOL_TIMEOUT_IDENTITY_S = 90
TOOL_TIMEOUT_WRITE_S = 300
TOOL_TIMEOUT_READ_S = 180

BOOT_RESULTS = ("PASS", "FAIL", "NOT_PROVEN")
BOOT_FIXTURE_MARKER = "NOT_APPLICABLE_FIXTURE_BACKEND"
RUN_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
FLASH_SIZE_RE = re.compile(r"^([0-9]+)MB$")

MAC_RE = re.compile(r"^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$")
SERIAL_PORT_RE = re.compile(r"^/dev/tty(?:USB|ACM)[0-9]+$")
IDENTITY_KEYS = ("expected_mac", "serial_port")

D4_MAGIC = "AEGIS_P4_D4_ATTESTATION_V1"
D4_KEYS = ("d4_live", "reference")

# OD-L8-04: verbs that make a build command something other than compile-only.
# This is a denylist of strings to refuse; nothing below invokes any of them.
FORBIDDEN_BUILD_VERBS = (
    "upload",  # denylist
    "erase_flash",  # denylist
    "erase-flash",  # denylist
    "erase_region",  # denylist
    "write_flash",  # denylist
    "write_mem",  # denylist
    "espefuse",  # denylist
    "burn_efuse",  # denylist
)

# OD-L8-04: tokens that mark a trust anchor as un-provisioned. Every entry
# carries a separator that is NOT in the base64 alphabet, so scanning the
# certificate body for them cannot reject a valid anchor whose base64 happens
# to spell an English word. Separator-free placeholders are caught instead by
# the base64 alphabet check and the body length floor below.
CA_PLACEHOLDER_TOKENS = (
    "REPLACE_WITH",
    "REPLACE-WITH",
    "CHANGE_ME",
    "CHANGE-ME",
    "TO_DO",
    "FIX_ME",
    "PLACE_HOLDER",
)

# A real X.509 CA certificate body is far longer than this; no placeholder word
# comes close. The floor is what stops a separator-free placeholder such as
# "PLACEHOLDER", which is itself valid base64.
CA_BODY_MIN_LENGTH = 64

# RFC 5737 TEST-NET-1. It is the bootstrap default in secrets.h.example and
# must never be promoted into a Production provisioning claim (§8).
DOCUMENTATION_NTP_PREFIX = "192.0.2."



class L8Error(ValueError):
    """Any fail-closed condition in the L8 provisioning path."""


# ---------------------------------------------------------------------------
# owner-supplied input handling
# ---------------------------------------------------------------------------

def read_private_text(path: Path) -> str:
    """Read an owner-only regular file, refusing symlinks and loose modes."""
    path = Path(path)
    try:
        metadata = path.lstat()
    except OSError as exc:
        raise L8Error(f"input file missing or unreadable: {path.name}") from exc

    if not stat.S_ISREG(metadata.st_mode):
        raise L8Error(f"input must be a regular file: {path.name}")
    if metadata.st_mode & 0o077:
        raise L8Error(
            f"input file {path.name} has a group/other permission bit; "
            "owner-only mode is required"
        )
    return path.read_text(encoding="utf-8")


def parse_key_values(text: str, allowed: tuple[str, ...], label: str) -> dict[str, str]:
    """Strict key=value parse: known keys only, no duplicates, all required."""
    parsed: dict[str, str] = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            raise L8Error(f"{label}: malformed line")
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip()
        if key not in allowed:
            raise L8Error(f"{label}: unknown key {key!r}")
        if key in parsed:
            raise L8Error(f"{label}: duplicate key {key!r}")
        if not value:
            raise L8Error(f"{label}: empty value for {key!r}")
        parsed[key] = value

    for key in allowed:
        if key not in parsed:
            raise L8Error(f"{label}: missing required key {key!r}")
    return parsed


def parse_identity_binding(path: Path) -> dict[str, str]:
    """OD-L8-01: parse and validate the owner-supplied OV-12 binding."""
    binding = parse_key_values(
        read_private_text(path), IDENTITY_KEYS, "device.identity"
    )

    if MAC_RE.fullmatch(binding["expected_mac"]) is None:
        raise L8Error(
            "device.identity: expected_mac must be six lowercase hex octets "
            "separated by colons"
        )
    if SERIAL_PORT_RE.fullmatch(binding["serial_port"]) is None:
        raise L8Error(
            "device.identity: serial_port must be /dev/ttyUSBn or /dev/ttyACMn"
        )
    return binding


def parse_d4_attestation(path: Path) -> dict[str, str]:
    """OD-L8-08: D4 live recovery must be attested before the write path."""
    text = read_private_text(path)
    lines = text.splitlines()
    if not lines or lines[0].strip() != D4_MAGIC:
        raise L8Error(f"d4.attestation: first line must be {D4_MAGIC}")

    record = parse_key_values("\n".join(lines[1:]), D4_KEYS, "d4.attestation")
    if record["d4_live"] != "YES":
        raise L8Error(
            "d4.attestation: d4_live must be YES; L8 recovery is D4 only and "
            "INTERIM_RECOVERY_PROCEDURE=NOT_APPROVED"
        )
    return record


# ---------------------------------------------------------------------------
# partition table / NVS offset (OD-L8-03)
# ---------------------------------------------------------------------------

def _parse_partition_table(table_path: Path) -> list[list[str]]:
    table_path = Path(table_path)
    try:
        text = table_path.read_text(encoding="utf-8")
    except OSError as exc:
        raise L8Error(
            f"partition table missing or unreadable: {table_path}"
        ) from exc

    rows = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        parts = [field.strip() for field in line.split(",")]
        if len(parts) >= 5:
            rows.append(parts)
    return rows


def derive_partition_geometry(table_path: Path, selector) -> tuple[int, int]:
    """Derive one partition's (offset, size) from the reviewed build's table.

    There is deliberately no default and no fallback anywhere in this path: an
    absent, unparseable, or non-matching table is a fail-closed condition,
    because writing at a guessed offset would corrupt an unrelated flash
    region. This applies to every partition L8 touches, not only nvs.
    """
    label, match = selector
    for parts in _parse_partition_table(table_path):
        if not match(parts):
            continue
        offset, size = parts[3], parts[4]
        if not offset or not size:
            raise L8Error(
                f"partition table: the {label} entry has a blank offset or size; "
                "both must be explicit in the reviewed build"
            )
        try:
            return int(offset, 0), int(size, 0)
        except ValueError as exc:
            raise L8Error(
                f"partition table: unparseable {label} offset/size "
                f"({offset!r}, {size!r})"
            ) from exc

    raise L8Error(
        f"partition table: no {label} entry found; its offset cannot be derived"
    )


NVS_SELECTOR = (
    "nvs",
    lambda parts: parts[0] == "nvs" or (parts[1] == "data" and parts[2] == "nvs"),
)
APP_SELECTOR = (
    "application",
    lambda parts: parts[1] == "app" and parts[2] in ("ota_0", "factory"),
)


def derive_nvs_offset(table_path: Path) -> int:
    """Derive the NVS offset from the reviewed build's partition table."""
    return derive_partition_geometry(table_path, NVS_SELECTOR)[0]


# ---------------------------------------------------------------------------
# firmware build identity and trust anchor (OD-L8-04)
# ---------------------------------------------------------------------------

def validate_build_command(command: str) -> None:
    """Refuse any build command that is not compile-only."""
    if not command.strip():
        raise L8Error("firmware build command is required")
    lowered = command.lower()
    for verb in FORBIDDEN_BUILD_VERBS:
        if verb in lowered:
            raise L8Error(
                f"firmware build command contains the forbidden verb {verb!r}; "
                "L8 consumes a compile-only build"
            )


def firmware_sha256(image_path: Path) -> str:
    """SHA-256 of the exact firmware image L8 consumes."""
    image_path = Path(image_path)
    try:
        data = image_path.read_bytes()
    except OSError as exc:
        raise L8Error(f"firmware image missing or unreadable: {image_path}") from exc
    if not data:
        raise L8Error("firmware image is empty")
    return hashlib.sha256(data).hexdigest()


def validate_trust_anchor(header_path: Path) -> None:
    """Refuse a firmware trust anchor that is missing or still a placeholder."""
    header_path = Path(header_path)
    try:
        text = header_path.read_text(encoding="utf-8")
    except OSError as exc:
        raise L8Error(
            f"MQTT CA trust anchor header missing or unreadable: {header_path}"
        ) from exc

    if "BEGIN CERTIFICATE" not in text or "END CERTIFICATE" not in text:
        raise L8Error(
            "MQTT CA trust anchor does not contain a PEM certificate"
        )

    body = text.split("BEGIN CERTIFICATE-----", 1)[1]
    body = body.split("-----END CERTIFICATE", 1)[0]
    # The anchor is stored as a C string literal, so strip the literal syntax
    # (escaped newlines, quotes, backslash continuations) before inspecting it.
    body = body.replace("\\n", "").replace('"', "").replace("\\", "")
    body = "".join(body.split())

    for token in CA_PLACEHOLDER_TOKENS:
        if token in body.upper():
            raise L8Error(
                f"MQTT CA trust anchor still contains the placeholder {token!r}"
            )

    # A real certificate body is strictly base64. Checking the alphabet catches
    # every placeholder without false-rejecting a valid anchor whose base64
    # happens to spell a denylisted word.
    if not body or re.fullmatch(r"[A-Za-z0-9+/=]+", body) is None:
        raise L8Error(
            "MQTT CA trust anchor body is not valid base64; it is still a "
            "placeholder rather than a certificate"
        )

    if len(body) < CA_BODY_MIN_LENGTH:
        raise L8Error(
            f"MQTT CA trust anchor body is only {len(body)} characters; it is "
            "too short to be a certificate and is still a placeholder"
        )


def validate_ntp(value: str) -> str:
    """Refuse promoting a documentation-range fixture value into provisioning."""
    value = value.strip()
    if not value:
        raise L8Error("ntp value is required")
    if value.startswith(DOCUMENTATION_NTP_PREFIX):
        raise L8Error(
            f"ntp value {value} is in the 192.0.2.0/24 documentation range and "
            "must not be provisioned"
        )
    return value


# ---------------------------------------------------------------------------
# readback and evidence (OD-L8-07, OD-L8-09)
# ---------------------------------------------------------------------------

def compare_nvs_readback(expected: bytes, actual: bytes) -> bool:
    """Compare the NVS image privately and yield only a boolean.

    The comparison happens in memory over digests. Neither operand, nor any
    per-byte difference between them, is returned, printed, or recorded.
    """
    return hmac.compare_digest(
        hashlib.sha256(expected).digest(), hashlib.sha256(actual).digest()
    )


def write_evidence(path: Path, fields: dict[str, object]) -> Path:
    """Write the stage-local hardware evidence bundle, write-once at 0600."""
    supplied = set(fields)
    allowed = set(EVIDENCE_FIELDS)
    extra = sorted(supplied - allowed)
    missing = sorted(allowed - supplied)
    if extra:
        raise L8Error(f"evidence bundle carries fields outside the allowlist: {extra}")
    if missing:
        raise L8Error(f"evidence bundle is missing required fields: {missing}")

    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)

    body = json.dumps({key: fields[key] for key in EVIDENCE_FIELDS}, indent=2, sort_keys=True)

    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        fd = os.open(path, flags, 0o600)
    except FileExistsError as exc:
        raise L8Error(
            f"evidence bundle already exists and is write-once: {path}"
        ) from exc

    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(body + "\n")
    except Exception:
        try:
            path.unlink()
        except FileNotFoundError:
            pass
        raise
    return path


# ---------------------------------------------------------------------------
# device backends (OD-L8-05, OD-L8-06)
# ---------------------------------------------------------------------------

class FixtureDevice:
    """A mock ESP32 whose entire flash lives under the stage work directory.

    It has no serial code path whatsoever: identity comes from a JSON
    descriptor and every region read or write is an ordinary file under
    ``flash_dir``.
    """

    name = "fixture"

    def __init__(self, descriptor_path: Path, flash_dir: Path) -> None:
        descriptor_path = Path(descriptor_path)
        if str(descriptor_path).startswith("/dev/"):
            raise L8Error(
                "fixture device descriptor must not be a /dev/ device node"
            )
        try:
            descriptor = json.loads(descriptor_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise L8Error(
                f"fixture device descriptor missing or malformed: {descriptor_path}"
            ) from exc

        for key in ("mac", "chip_identity", "flash_size"):
            if key not in descriptor:
                raise L8Error(f"fixture device descriptor missing {key!r}")

        if MAC_RE.fullmatch(str(descriptor["mac"])) is None:
            raise L8Error("fixture device descriptor has a malformed mac")

        self.descriptor = descriptor
        self.flash_dir = Path(flash_dir)
        self.flash_dir.mkdir(parents=True, exist_ok=True)
        self.flash_dir.chmod(0o700)

    def identity(self) -> dict[str, str]:
        return {
            "mac": str(self.descriptor["mac"]),
            "chip_identity": str(self.descriptor["chip_identity"]),
            "flash_size": str(self.descriptor["flash_size"]),
        }

    boot_verification_supported = True

    def bind_regions(self, regions: dict[str, tuple[int, int]]) -> None:
        """The fixture writes plain files, so region binding is informational."""

    def reset_into_new_image(self) -> None:
        """Fixture: there is no device to reset."""

    def verify_boot(self) -> str:
        return BOOT_FIXTURE_MARKER

    def write_region(self, region: str, offset: int, payload: bytes) -> None:
        target = self.flash_dir / f"{region}-{offset:#x}.img"
        target.write_bytes(payload)
        target.chmod(0o600)

    def read_region(self, region: str, offset: int) -> bytes:
        target = self.flash_dir / f"{region}-{offset:#x}.img"
        try:
            return target.read_bytes()
        except OSError as exc:
            raise L8Error(f"fixture readback failed for region {region}") from exc


# ---------------------------------------------------------------------------
# hardware backend (OD-L8-05, OD-L8-06, OD-L8-07)
#
# Nothing in this section touches a device at import time or when an object is
# constructed. A command can only reach a device through
# SubprocessExecutor.run, which is only built by load_backend after the live
# authorization gate, and which itself refuses any argv that is not one of the
# three allowed esptool shapes bound to the OV-12 port.
# ---------------------------------------------------------------------------

class ExecResult(NamedTuple):
    """Outcome of one external command. Output is parsed in memory, never logged."""

    returncode: int
    stdout: str
    stderr: str


class CommandExecutor(Protocol):
    """The one seam through which hardware commands run. Tests inject a fake."""

    def run(self, argv: Sequence[str], timeout: float | None = None) -> ExecResult:
        ...


# Tokens no hardware command may ever contain, wherever they appear.
ESPTOOL_FORBIDDEN_TOKENS = (  # denylist
    "erase_flash",  # denylist
    "erase-flash",  # denylist
    "erase_region",  # denylist
    "erase-region",  # denylist
    "write_mem",  # denylist
    "write-mem",  # denylist
    "read_mem",  # denylist
    "load_ram",  # denylist
    "espefuse",  # denylist
    "espefuse.py",  # denylist
    "burn_efuse",  # denylist
    "burn-efuse",  # denylist
    "--erase-all",  # denylist
    "--erase_all",  # denylist
    "upload",  # denylist
    "platformio",  # denylist
    "pio",  # denylist
)


def resolve_pinned_esptool(script: str | None) -> Path:
    """Accept only the esptool that ships in the pinned PlatformIO package."""
    if not script:
        raise L8Error("hardware backend requires the pinned esptool script path")
    path = Path(script)
    if not path.is_absolute() or path.name != "esptool.py":
        raise L8Error("esptool must be an absolute path to the pinned esptool.py")
    if not path.is_file():
        raise L8Error(f"pinned esptool not found: {path}")
    manifest = path.parent / "package.json"
    try:
        package = json.loads(manifest.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise L8Error(
            "esptool is not inside a PlatformIO tool package (package.json unreadable)"
        ) from exc
    observed = (package.get("name"), package.get("version"))
    if observed != PINNED_ESPTOOL_PACKAGE:
        raise L8Error(
            f"esptool package {observed} is not the pinned {PINNED_ESPTOOL_PACKAGE}"
        )
    return path


def _is_scratch_path(path: str, scratch_dir: Path) -> bool:
    candidate = Path(path)
    return (
        candidate.parent == Path(scratch_dir)
        and candidate.name.startswith("hw-")
        and candidate.name.endswith(".bin")
    )


def _parse_address(token: str) -> int:
    if re.fullmatch(r"0x[0-9a-fA-F]+", token) is None:
        raise L8Error("hardware command address must be an explicit hex literal")
    return int(token, 16)


def validate_esptool_argv(
    argv: Sequence[str],
    prefix: Sequence[str],
    permitted_writes: dict[int, int],
    permitted_reads: dict[int, int],
    scratch_dir: Path,
) -> str:
    """Structural allowlist for every command the hardware backend may issue.

    ``prefix`` already carries the launcher, chip, the bound serial port, the
    baud rate and the reset mode, so a different port cannot match. Anything
    that is not exactly flash_id, or write_flash/read_flash on a bound region
    with a private scratch file, is refused. Returns the subcommand.
    """
    argv = [str(a) for a in argv]
    prefix = [str(a) for a in prefix]
    if argv[: len(prefix)] != prefix:
        raise L8Error("hardware command does not match the bound tool/port prefix")
    tail = argv[len(prefix):]
    if len(tail) < 3 or tail[0] != "--after" or tail[1] not in ESPTOOL_AFTER_MODES:
        raise L8Error("hardware command has no valid reset mode")
    sub, rest = tail[2], tail[3:]
    for token in argv:
        if token in ESPTOOL_FORBIDDEN_TOKENS:
            raise L8Error(f"hardware command contains a forbidden token: {token}")
    if sub not in ESPTOOL_ALLOWED_SUBCOMMANDS:
        raise L8Error(f"hardware subcommand is not allowed: {sub}")

    if sub == "flash_id":
        if rest:
            raise L8Error("flash_id takes no arguments")
    elif sub == "write_flash":
        if len(rest) != 2:
            raise L8Error("write_flash must be exactly <address> <file>")
        address = _parse_address(rest[0])
        if address not in permitted_writes:
            raise L8Error("write_flash address is not a bound partition offset")
        if not _is_scratch_path(rest[1], scratch_dir):
            raise L8Error("write_flash source must be a private scratch file")
    else:  # read_flash
        if len(rest) != 3:
            raise L8Error("read_flash must be exactly <address> <size> <file>")
        address = _parse_address(rest[0])
        if permitted_reads.get(address) != _parse_address(rest[1]):
            raise L8Error("read_flash must cover exactly a region that was written")
        if not _is_scratch_path(rest[2], scratch_dir):
            raise L8Error("read_flash destination must be a private scratch file")
    return sub


class SubprocessExecutor:
    """The only place a hardware command becomes a real process.

    Built only after the live gate. It refuses anything that is not the pinned
    launcher followed by an allowed subcommand, so even a caller that bypassed
    HardwareDevice could not run erase, memory or eFuse operations.
    """

    def __init__(self, launcher: Sequence[str]) -> None:
        self._launcher = [str(a) for a in launcher]

    def run(self, argv: Sequence[str], timeout: float | None = None) -> ExecResult:
        argv = [str(a) for a in argv]
        n = len(self._launcher)
        sub_index = n + ESPTOOL_GLOBAL_TOKENS
        if argv[:n] != self._launcher or len(argv) <= sub_index:
            raise L8Error("executor refused a command outside the pinned tool")
        if argv[sub_index] not in ESPTOOL_ALLOWED_SUBCOMMANDS:
            raise L8Error("executor refused a subcommand outside the allowlist")
        if any(token in ESPTOOL_FORBIDDEN_TOKENS for token in argv):
            raise L8Error("executor refused a forbidden token")
        env = {
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "LC_ALL": "C",
            "PYTHONDONTWRITEBYTECODE": "1",
        }
        try:
            done = subprocess.run(
                argv,
                capture_output=True,
                text=True,
                errors="replace",
                stdin=subprocess.DEVNULL,
                timeout=timeout,
                check=False,
                env=env,
            )
        except subprocess.TimeoutExpired as exc:
            raise L8Error("hardware tool timed out") from exc
        return ExecResult(done.returncode, done.stdout or "", done.stderr or "")


def parse_esptool_identity(text: str, expected_port: str) -> dict[str, str]:
    """Strictly parse ``esptool flash_id`` output into MAC, chip and flash size.

    Missing, malformed, repeated, or contradictory lines all fail closed.
    """
    lines = [line.rstrip("\r") for line in text.splitlines()]

    def unique(prefix: str, pattern: str, label: str) -> re.Match:
        hits = [line for line in lines if line.startswith(prefix)]
        if len(hits) != 1:
            raise L8Error(f"identity output: expected exactly one {label} line")
        match = re.fullmatch(pattern, hits[0])
        if match is None:
            raise L8Error(f"identity output: malformed {label} line")
        return match

    for line in lines:
        if line.startswith("Serial port ") and line != f"Serial port {expected_port}":
            raise L8Error("identity output names a serial port other than the bound one")

    chip = unique(
        "Chip is ",
        r"Chip is (ESP32(?:-[A-Z0-9]+)*) \(revision v[0-9]+\.[0-9]+\)",
        "chip",
    ).group(1)
    if re.match(r"ESP32-(?:S2|S3|C[0-9]+|H[0-9]+|P4)\b", chip):
        raise L8Error("identity output: chip is not a classic ESP32")
    mac = unique(
        "MAC: ", r"MAC: ((?:[0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2})", "MAC"
    ).group(1).lower()
    flash = unique(
        "Detected flash size: ", r"Detected flash size: ([0-9]+MB)", "flash size"
    ).group(1)
    return {"mac": mac, "chip_identity": chip, "flash_size": flash}


def flash_size_bytes(flash_size: str) -> int:
    match = FLASH_SIZE_RE.fullmatch(flash_size)
    if match is None:
        raise L8Error(f"flash size {flash_size!r} is not of the form <n>MB")
    return int(match.group(1)) * 1024 * 1024


class HardwareDevice:
    """Real ESP32 backend: a subprocess adapter over the pinned esptool.

    The serial port comes only from the validated OV-12 binding; there is no
    device discovery and no substitution. Construction performs no I/O.
    """

    name = "hardware"

    def __init__(
        self,
        *,
        serial_port: str,
        work_dir: Path,
        executor: CommandExecutor,
        esptool_script: str,
        live_authorized: bool,
        python: str | None = None,
        boot_verifier: Callable[[], str] | None = None,
    ) -> None:
        if live_authorized is not True:
            raise L8Error(
                "HARDWARE_BACKEND_LIVE_L8_NOT_AUTHORIZED: refusing to build a "
                "hardware backend without explicit live authorization"
            )
        if SERIAL_PORT_RE.fullmatch(str(serial_port)) is None:
            raise L8Error("hardware backend serial port must be /dev/ttyUSBn or /dev/ttyACMn")
        self._port = serial_port
        self._work_dir = Path(work_dir)
        self._runner = executor
        self._boot_verifier = boot_verifier
        self._regions: dict[str, tuple[int, int]] = {}
        self._written: dict[tuple[str, int], int] = {}
        self._read_back: set[tuple[str, int]] = set()
        self._reset_done = False
        self.launcher = [python or sys.executable, str(esptool_script)]
        self.argv_prefix = self.launcher + [
            "--chip", HARDWARE_CHIP,
            "--port", serial_port,
            "--baud", str(HARDWARE_BAUD),
            "--before", "default_reset",
        ]

    @property
    def boot_verification_supported(self) -> bool:
        return self._boot_verifier is not None

    # -- command plumbing ---------------------------------------------------

    def build_argv(self, subcommand: str, *args: str, after: str) -> list[str]:
        return self.argv_prefix + ["--after", after, subcommand, *args]

    def _permitted_writes(self) -> dict[int, int]:
        return {offset: size for offset, size in self._regions.values()}

    def _permitted_reads(self) -> dict[int, int]:
        return {offset: size for (_r, offset), size in self._written.items()}

    def _invoke(self, argv: list[str], timeout: float) -> ExecResult:
        if self._reset_done:
            raise L8Error("the device was already reset into the new image; no further device access")
        validate_esptool_argv(
            argv,
            self.argv_prefix,
            self._permitted_writes(),
            self._permitted_reads(),
            self._work_dir,
        )
        try:
            return self._runner.run(argv, timeout=timeout)
        except L8Error:
            raise
        except Exception as exc:
            # Only the exception type is kept: tool output can echo flash content.
            raise L8Error(f"hardware tool invocation failed ({type(exc).__name__})") from None

    def _scratch(self, region: str, offset: int) -> Path:
        path = self._work_dir / f"hw-{region}-{offset:#x}.bin"
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        try:
            os.close(os.open(path, flags, 0o600))
        except FileExistsError as exc:
            raise L8Error(f"scratch file already exists: {path.name}") from exc
        return path

    # -- backend surface ----------------------------------------------------

    def identity(self) -> dict[str, str]:
        """Observe MAC, chip and flash size. Opens the port; may reset the device."""
        result = self._invoke(
            self.build_argv("flash_id", after="no_reset"), TOOL_TIMEOUT_IDENTITY_S
        )
        if result.returncode != 0:
            raise L8Error(f"identity command failed with status {result.returncode}")
        return parse_esptool_identity(result.stdout, self._port)

    def bind_regions(self, regions: dict[str, tuple[int, int]]) -> None:
        if self._regions:
            raise L8Error("hardware regions are already bound")
        if set(regions) != {"nvs", "firmware"}:
            raise L8Error("hardware regions must be exactly nvs and firmware")
        for offset, size in regions.values():
            if not isinstance(offset, int) or not isinstance(size, int) or size <= 0:
                raise L8Error("hardware region geometry must be explicit integers")
        self._regions = dict(regions)

    def write_region(self, region: str, offset: int, payload: bytes) -> None:
        bound = self._regions.get(region)
        if bound is None or bound[0] != offset:
            raise L8Error(f"write to {region} at {offset:#x} is not a bound region")
        if not payload or len(payload) > bound[1]:
            raise L8Error(f"payload for {region} does not fit its partition")
        scratch = self._scratch(region, offset)
        try:
            scratch.write_bytes(payload)
            result = self._invoke(
                self.build_argv("write_flash", hex(offset), str(scratch), after="no_reset"),
                TOOL_TIMEOUT_WRITE_S,
            )
        finally:
            scratch.unlink(missing_ok=True)
        if result.returncode != 0:
            raise L8Error(
                f"hardware write of {region} failed with status {result.returncode}"
            )
        self._written[(region, offset)] = len(payload)

    def read_region(self, region: str, offset: int) -> bytes:
        """Read back exactly the bytes that were written. NEVER resets the device (``--after no_reset``).

        The one reset is ``reset_into_new_image()``, issued only after every region was read back and compared.
        """
        size = self._written.get((region, offset))
        if size is None:
            raise L8Error(f"{region} at {offset:#x} was not written; nothing to read back")
        scratch = self._scratch(region, offset)
        try:
            result = self._invoke(
                self.build_argv(
                    "read_flash", hex(offset), hex(size), str(scratch), after="no_reset"
                ),
                TOOL_TIMEOUT_READ_S,
            )
            if result.returncode != 0:
                raise L8Error(
                    f"hardware readback of {region} failed with status {result.returncode}"
                )
            data = scratch.read_bytes()
        finally:
            scratch.unlink(missing_ok=True)
        if len(data) != size:
            raise L8Error(f"hardware readback of {region} returned a wrong length")
        self._read_back.add((region, offset))
        return data

    def reset_into_new_image(self) -> None:
        """The single terminal reset: boot the freshly flashed image, exactly once, after every readback.

        It reuses the read-only ``flash_id`` verb with ``--after hard_reset`` (no new tool verb). It is refused unless both bound
        regions were written AND read back, and refused a second time; afterwards the device is not accessed again.
        """
        if self._reset_done:
            raise L8Error("the device was already reset into the new image")
        for region, (offset, _size) in self._regions.items():
            if (region, offset) not in self._written:
                raise L8Error(f"refusing to reset: {region} was not written")
            if (region, offset) not in self._read_back:
                raise L8Error(f"refusing to reset: {region} was not read back")
        result = self._invoke(self.build_argv("flash_id", after="hard_reset"), TOOL_TIMEOUT_IDENTITY_S)
        self._reset_done = True
        if result.returncode != 0:
            raise L8Error(f"terminal reset failed with status {result.returncode}")

    def verify_boot(self) -> str:
        """Delegate to the injected verifier; anything unproven is NOT_PROVEN.

        The verifier must only observe the fail-secure post-flash boot state.
        It must never issue CUT or RESTORE. The repository's verifier is the
        subscribe-only signed BOOT STATUS check in p4-l8-boot-verify.py.
        """
        if self._boot_verifier is None or not self._reset_done:
            return "NOT_PROVEN"
        try:
            verdict = self._boot_verifier()
        except Exception:
            return "NOT_PROVEN"
        return verdict if isinstance(verdict, str) and verdict in BOOT_RESULTS else "NOT_PROVEN"


def load_backend(
    name: str,
    descriptor_path: Path | None,
    flash_dir: Path,
    *,
    binding: dict[str, str] | None = None,
    live_authorized: bool = False,
    executor: CommandExecutor | None = None,
    esptool_script: str | None = None,
    work_dir: Path | None = None,
    boot_verifier: Callable[[], str] | None = None,
):
    """Select a device backend. Hardware needs BOTH selection and live authorization."""
    if name == "fixture":
        if descriptor_path is None:
            raise L8Error("fixture backend requires a fixture device descriptor")
        return FixtureDevice(descriptor_path, flash_dir)
    if name == "hardware":
        # The gate comes first, before any tool resolution or object creation.
        if live_authorized is not True:
            raise L8Error(HARDWARE_NOT_AUTHORIZED_MESSAGE)
        if binding is None or work_dir is None:
            raise L8Error("hardware backend requires the OV-12 binding and a work directory")
        launcher_script = str(esptool_script or "")
        if executor is None:
            script = resolve_pinned_esptool(esptool_script)
            launcher_script = str(script)
            executor = SubprocessExecutor([sys.executable, launcher_script])
        elif not launcher_script:
            raise L8Error("hardware backend requires the pinned esptool script path")
        return HardwareDevice(
            serial_port=binding["serial_port"],
            work_dir=Path(work_dir),
            executor=executor,
            esptool_script=launcher_script,
            live_authorized=True,
            boot_verifier=boot_verifier,
        )
    raise L8Error(f"unknown device backend {name!r}")


# ---------------------------------------------------------------------------
# NVS material (OD-L8-03)
# ---------------------------------------------------------------------------

def load_nvs_provisioner():
    """Import the merged render-only provisioner so key handling stays shared."""
    target = HERE / "p4-nvs-provision.py"
    spec = importlib.util.spec_from_file_location("p4_nvs_provision", str(target))
    if spec is None or spec.loader is None:
        raise L8Error(f"cannot load the NVS provisioner: {target}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def render_nvs_material(
    provisioner,
    *,
    input_dir: Path,
    csv_path: Path,
    wifi_ssid: str,
    ntp: str,
) -> None:
    """Render the provisioning CSV through the merged, reviewed code path."""
    profile = provisioner.validate_profile(wifi_ssid, ntp)

    wifi_psk = provisioner.read_secret_file(input_dir / "wifi.psk")
    mqtt_password = provisioner.read_secret_file(input_dir / "mqtt.pass")
    k_c2d_hex = provisioner.read_secret_file(input_dir / "k_c2d")
    k_d2c_hex = provisioner.read_secret_file(input_dir / "k_d2c")

    k_c2d, k_d2c = provisioner.validate_protocol_keys(k_c2d_hex, k_d2c_hex)

    rows = dict(profile)
    rows["wifi_psk"] = wifi_psk
    rows["mqtt_pass"] = mqtt_password
    rows["k_c2d"] = k_c2d
    rows["k_d2c"] = k_d2c

    provisioner.render_nvs_csv(rows, csv_path)


def generate_nvs_partition(
    generator: str, csv_path: Path, out_path: Path, size: int
) -> None:
    """Invoke the owner-supplied external NVS partition generator."""
    generator_path = Path(generator)
    if not generator_path.is_file() or not os.access(generator_path, os.X_OK):
        raise L8Error(
            f"nvs partition generator is not an executable file: {generator}"
        )
    if out_path.exists():
        raise L8Error(f"nvs partition artifact already exists: {out_path}")

    result = subprocess.run(
        [str(generator_path), str(csv_path), str(out_path), hex(size)],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0 or not out_path.exists():
        # The generator handles secret-bearing input, so its output is not echoed.
        raise L8Error(
            f"nvs partition generator failed with status {result.returncode}"
        )
    out_path.chmod(0o600)


# ---------------------------------------------------------------------------
# provision orchestration (OD-L8-06)
# ---------------------------------------------------------------------------

HARDWARE_NOT_AUTHORIZED_MESSAGE = (
    "HARDWARE_BACKEND_LIVE_L8_NOT_AUTHORIZED: the hardware backend is "
    "implemented in the repository, but live access requires explicit "
    "authorization; LIVE_L8=NOT_AUTHORIZED"
)
BOOT_VERIFICATION_NOT_CONFIGURED_MESSAGE = (
    "BOOT_VERIFICATION_NOT_CONFIGURED: the hardware backend requires the signed "
    "BOOT STATUS verifier inputs (broker address, TLS name, pinned CA, staged "
    "Core broker credential); refusing before any device access"
)


def load_boot_verify():
    """Import the subscribe-only signed-BOOT-STATUS verifier."""
    target = HERE / "p4-l8-boot-verify.py"
    spec = importlib.util.spec_from_file_location("p4_l8_boot_verify", str(target))
    if spec is None or spec.loader is None:
        raise L8Error(f"cannot load the boot verifier: {target}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def build_boot_verifier(
    args: argparse.Namespace,
    *,
    input_dir: Path,
    device_id: str,
    expected_seq_hi: int,
    client_factory=None,
    clock=None,
):
    """Build the live verifier from the CLI inputs; opens no connection."""
    inputs = (
        getattr(args, "broker_address", None),
        getattr(args, "broker_tls_name", None),
        getattr(args, "broker_ca_file", None),
        getattr(args, "broker_credential_file", None),
    )
    if not all(inputs):
        raise L8Error(BOOT_VERIFICATION_NOT_CONFIGURED_MESSAGE)
    module = load_boot_verify()
    try:
        return module.build_live_boot_verifier(
            input_dir=input_dir,
            device_id=device_id,
            expected_seq_hi=expected_seq_hi,
            broker_address=inputs[0],
            tls_name=inputs[1],
            ca_file=inputs[2],
            credential_file=Path(inputs[3]),
            run_id=args.run_id,
            client_factory=client_factory,
            clock=clock,
        )
    except module.BootVerifyError as exc:
        raise L8Error(f"BOOT_VERIFICATION_NOT_CONFIGURED: {exc}") from None


def provision(
    args: argparse.Namespace,
    *,
    executor: CommandExecutor | None = None,
    boot_verifier: Callable[[], str] | None = None,
    boot_client_factory: Callable[[str], object] | None = None,
    boot_clock=None,
) -> int:
    """Run the ordered L8 procedure. ``executor``, ``boot_verifier``,
    ``boot_client_factory`` and ``boot_clock`` are injection seams for tests;
    the CLI supplies none of them and builds the live verifier from its args."""
    input_dir = Path(args.input_dir)
    work_dir = Path(args.work_dir)
    evidence_dir = Path(args.evidence_dir)

    if not input_dir.is_dir() or input_dir.is_symlink():
        raise L8Error("input directory must exist and must not be a symlink")
    if RUN_ID_RE.fullmatch(str(args.run_id)) is None:
        raise L8Error("run id must be 1-64 characters of [A-Za-z0-9._-]")

    work_dir.mkdir(parents=True, exist_ok=True)
    work_dir.chmod(0o700)
    evidence_dir.mkdir(parents=True, exist_ok=True)
    evidence_dir.chmod(0o700)

    # 1. OV-12 identity binding, before anything else exists.
    binding = parse_identity_binding(input_dir / "device.identity")

    # 2. D4-only recovery prerequisite.
    parse_d4_attestation(input_dir / "d4.attestation")

    # 3. Live-authorization gate, before anything is read or built for hardware.
    live_authorized = getattr(args, "live_authorized", "NO") == "YES"
    if args.backend == "hardware" and not live_authorized:
        raise L8Error(HARDWARE_NOT_AUTHORIZED_MESSAGE)

    # 3a. Device-free profile: the expected device id and initial seq_hi.
    ntp = validate_ntp(args.ntp)
    provisioner = load_nvs_provisioner()
    profile = provisioner.validate_profile(args.wifi_ssid, ntp)

    # 3b. Boot verifier (hardware only). Building it reads private inputs and
    #     opens nothing; it is armed after identity and before the first write.
    boot_obj = boot_verifier
    if args.backend == "hardware" and boot_obj is None:
        boot_obj = build_boot_verifier(
            args,
            input_dir=input_dir,
            device_id=str(profile["device_id"]),
            expected_seq_hi=int(provisioner.SEQ_HI_INITIAL),
            client_factory=boot_client_factory,
            clock=boot_clock,
        )

    # 3c. Backend selection. Building the hardware backend performs no I/O;
    #     observing identity below is the first device access.
    device = load_backend(
        args.backend,
        args.fixture_device,
        work_dir / "fixture-flash",
        binding=binding,
        live_authorized=live_authorized,
        executor=executor,
        esptool_script=getattr(args, "esptool", None),
        work_dir=work_dir,
        boot_verifier=boot_obj,
    )
    if not device.boot_verification_supported:
        raise L8Error(BOOT_VERIFICATION_NOT_CONFIGURED_MESSAGE)

    try:
        return _provision_with_device(
            args, device, boot_obj, binding, provisioner, input_dir, work_dir, evidence_dir
        )
    finally:
        close = getattr(boot_obj, "close", None)
        if callable(close):
            close()


def _provision_with_device(
    args, device, boot_obj, binding, provisioner, input_dir, work_dir, evidence_dir
) -> int:
    marker = work_dir / "first-write.marker"
    evidence_path = evidence_dir / f"l8-{args.run_id}.json"

    # 4. Everything that needs no device: geometry from the reviewed table, the
    #    compile-only build identity, the trust anchor and the network profile.
    nvs_offset, nvs_size = derive_partition_geometry(
        Path(args.partition_table), NVS_SELECTOR
    )
    app_offset, app_size = derive_partition_geometry(
        Path(args.partition_table), APP_SELECTOR
    )
    validate_build_command(args.build_command)
    validate_trust_anchor(Path(args.secrets_header))
    image_digest = firmware_sha256(Path(args.firmware_image))
    firmware_image = Path(args.firmware_image).read_bytes()
    if len(firmware_image) > app_size:
        raise L8Error("firmware image does not fit the application partition")
    ntp = validate_ntp(args.ntp)  # already validated in step 3a; kept as a hard gate
    if evidence_path.exists():
        raise L8Error(
            f"evidence bundle already exists and is write-once: {evidence_path}"
        )

    # 5. Observed identity. For the hardware backend this is the first device
    #    access (NON_WRITING_BUT_DEVICE_RESETTING); it precedes every write.
    observed = device.identity()
    if observed["mac"] != binding["expected_mac"]:
        raise L8Error(
            "observed device mac does not match the OV-12 expected_mac; "
            "aborting before any device write"
        )
    flash_bytes = flash_size_bytes(observed["flash_size"])
    if max(nvs_offset + nvs_size, app_offset + app_size) > flash_bytes:
        raise L8Error(
            "reviewed partition geometry exceeds the observed flash size; "
            "aborting before any device write"
        )

    # 5b. Arm the boot verifier: subscribe and fix T0. This is after identity
    #     (the device sits in the bootloader from here, so no old firmware can
    #     speak) and before the first write. Failure aborts with no device write.
    arm = getattr(boot_obj, "arm", None)
    if callable(arm):
        try:
            arm()
        except L8Error:
            raise
        except Exception as exc:
            detail = str(exc) if type(exc).__name__ == "BootVerifyError" else type(exc).__name__
            raise L8Error(f"BOOT_VERIFICATION_ARM_FAILED: {detail}; aborting before any write") from None

    # 6. Provisioning material. The provisioner refuses demo/test keys.
    csv_path = work_dir / "nvs.csv"
    render_nvs_material(
        provisioner,
        input_dir=input_dir,
        csv_path=csv_path,
        wifi_ssid=args.wifi_ssid,
        ntp=ntp,
    )

    nvs_image_path = work_dir / "nvs.bin"
    generate_nvs_partition(args.nvs_generator, csv_path, nvs_image_path, nvs_size)
    nvs_image = nvs_image_path.read_bytes()
    if len(nvs_image) != nvs_size:
        raise L8Error("nvs partition image does not match the partition size")
    device.bind_regions(
        {"nvs": (nvs_offset, nvs_size), "firmware": (app_offset, app_size)}
    )

    # 7. First device write. Everything above is a hard gate; past this point a
    #    failure is FAIL_SECURE_CUT and recovery is D4 only.
    marker.write_text(
        f"backend={device.name}\nnvs_offset={nvs_offset:#x}\n", encoding="utf-8"
    )
    marker.chmod(0o600)

    failure_boundary = "NONE"
    flash_result = "FAIL"
    readback_match = "FAIL"
    firmware_match = "FAIL"  # anything not proven equal is FAIL, never a pass
    boot_result = BOOT_FIXTURE_MARKER if device.name == "fixture" else "NOT_PROVEN"

    try:
        device.write_region("nvs", nvs_offset, nvs_image)
        device.write_region("firmware", app_offset, firmware_image)
        flash_result = "PASS"
    except Exception:
        # FAIL_SECURE_HOLD_AND_EVIDENCE (OD-L8-07): a failure at or after the
        # first write must still produce evidence, so it is recorded below
        # rather than raised past the bundle. No retry, no reflash, no restore.
        failure_boundary = "DEVICE_WRITE"

    # 8. Private readbacks, entirely in memory; only booleans leave this scope. Order: NVS (no reset) -> compare -> firmware (no
    #    reset) -> compare. A mismatch or tool failure stops everything: no further read, no reset, no retry, no reflash, no restore.
    if flash_result == "PASS":
        try:
            readback_match = "PASS" if compare_nvs_readback(
                nvs_image, device.read_region("nvs", nvs_offset)
            ) else "FAIL"
        except Exception:
            readback_match = "FAIL"
        if readback_match != "PASS":
            failure_boundary = "NVS_READBACK"
        else:
            try:
                firmware_match = "PASS" if compare_nvs_readback(  # same digest comparison, bytes never recorded
                    firmware_image, device.read_region("firmware", app_offset)
                ) else "FAIL"
            except Exception:
                firmware_match = "FAIL"
            if firmware_match != "PASS":
                failure_boundary = "FIRMWARE_READBACK"

    # 9. The ONE terminal reset (only after both readbacks compared equal), then boot verification (OD-L8-07). It never issues
    #    CUT or RESTORE; the reset only boots the image that was just proven to be on the device.
    if readback_match == "PASS" and firmware_match == "PASS":
        try:
            device.reset_into_new_image()
            boot_result = device.verify_boot()
        except Exception:
            boot_result = "NOT_PROVEN"
        if boot_result not in ("PASS", BOOT_FIXTURE_MARKER):
            failure_boundary = "BOOT_VERIFICATION"

    write_evidence(
        evidence_path,
        {
            "schema_version": EVIDENCE_SCHEMA_VERSION,
            "run_id": args.run_id,
            "device_mac": observed["mac"],
            "chip_identity": observed["chip_identity"],
            "flash_size": observed["flash_size"],
            "firmware_sha256": image_digest,
            "nvs_schema_version": provisioner.NVS_SCHEMA_VERSION,
            "nvs_readback_match": readback_match,
            "firmware_readback_match": firmware_match,
            "flash_result": flash_result,
            "boot_verification_result": boot_result,
            "failure_boundary": failure_boundary,
        },
    )

    print(f"L8_NVS_OFFSET={nvs_offset:#x}")
    print(f"L8_FLASH_RESULT={flash_result}")
    print(f"L8_NVS_READBACK_MATCH={readback_match}")
    print(f"L8_FIRMWARE_READBACK_MATCH={firmware_match}")
    print(f"L8_BOOT_VERIFICATION={boot_result}")
    print(f"L8_FAILURE_BOUNDARY={failure_boundary}")
    detail = getattr(boot_obj, "detail", None)
    if device.name == "hardware" and isinstance(detail, str) and re.fullmatch(r"[A-Z_]+", detail):
        print(f"L8_BOOT_VERIFICATION_DETAIL={detail}")

    accepted = (
        readback_match == "PASS"
        and firmware_match == "PASS"
        and flash_result == "PASS"
        and boot_result in ("PASS", BOOT_FIXTURE_MARKER)
    )
    return 0 if accepted else 1


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Repository-safe IDEA3 L8 device provisioning helper."
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    run = subparsers.add_parser("provision")
    run.add_argument("--input-dir", required=True)
    run.add_argument("--work-dir", required=True)
    run.add_argument("--evidence-dir", required=True)
    run.add_argument("--backend", required=True)
    run.add_argument("--fixture-device", default=None)
    run.add_argument("--partition-table", required=True)
    run.add_argument("--secrets-header", required=True)
    run.add_argument("--firmware-image", required=True)
    run.add_argument("--build-command", required=True)
    run.add_argument("--nvs-generator", required=True)
    run.add_argument("--wifi-ssid", required=True)
    run.add_argument("--ntp", required=True)
    run.add_argument("--run-id", required=True)
    # Hardware only. The serial port is deliberately NOT an argument: it comes
    # exclusively from the validated device.identity binding.
    run.add_argument("--esptool", default=None)
    run.add_argument("--live-authorized", default="NO")
    # Boot verification inputs (hardware only): the signed BOOT STATUS verifier.
    run.add_argument("--broker-address", default=None)
    run.add_argument("--broker-tls-name", default=None)
    run.add_argument("--broker-ca-file", default=None)
    run.add_argument("--broker-credential-file", default=None)

    offset = subparsers.add_parser("nvs-offset")
    offset.add_argument("--partition-table", required=True)

    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    try:
        if args.command == "provision":
            return provision(args)
        if args.command == "nvs-offset":
            print(f"NVS_OFFSET={derive_nvs_offset(Path(args.partition_table)):#x}")
            return 0
    except L8Error as exc:
        sys.stderr.write(f"L8_DEVICE=FAIL reason={exc}\n")
        return 1

    raise L8Error("unsupported command")


if __name__ == "__main__":
    raise SystemExit(main())
