#!/usr/bin/env python3

"""Repository-safe IDEA3 PR11 Phase 4 L8 device provisioning helper.

Authority: IDEA3-AEGIS_Lockdown/docs/superpowers/specs/
  2026-09-21-idea3-pr11-phase4-l8-operational-design.md (OD-L8-01..OD-L8-09)
Regression tests: IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l8_handler.py

Capability boundary, deliberately narrow:

* The only implemented device backend is ``fixture``. Selecting ``hardware``
  fails closed, because this repository contains no Production write tool and
  no Production readback verifier.
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
    "flash_result",
    "boot_verification_result",
    "failure_boundary",
)

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


def load_backend(name: str, descriptor_path: Path | None, flash_dir: Path):
    """Select a device backend. Only the fixture backend is implemented."""
    if name == "fixture":
        if descriptor_path is None:
            raise L8Error("fixture backend requires a fixture device descriptor")
        return FixtureDevice(descriptor_path, flash_dir)
    if name == "hardware":
        raise L8Error(
            "HARDWARE_BACKEND_NOT_IMPLEMENTED_IN_REPOSITORY: this repository "
            "contains no Production write tool and no Production readback "
            "verifier; LIVE_L8=NOT_AUTHORIZED"
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

def provision(args: argparse.Namespace) -> int:
    input_dir = Path(args.input_dir)
    work_dir = Path(args.work_dir)
    evidence_dir = Path(args.evidence_dir)

    if not input_dir.is_dir() or input_dir.is_symlink():
        raise L8Error("input directory must exist and must not be a symlink")

    work_dir.mkdir(parents=True, exist_ok=True)
    work_dir.chmod(0o700)
    evidence_dir.mkdir(parents=True, exist_ok=True)
    evidence_dir.chmod(0o700)

    marker = work_dir / "first-write.marker"

    # 1. OV-12 identity binding, before anything else exists.
    binding = parse_identity_binding(input_dir / "device.identity")

    # 2. D4-only recovery prerequisite.
    parse_d4_attestation(input_dir / "d4.attestation")

    # 3. Backend selection and observed identity.
    device = load_backend(args.backend, args.fixture_device, work_dir / "fixture-flash")
    observed = device.identity()
    if observed["mac"] != binding["expected_mac"]:
        raise L8Error(
            "observed device mac does not match the OV-12 expected_mac; "
            "aborting before any device write"
        )

    # 4. Geometry derived from the reviewed build's partition table.
    nvs_offset, nvs_size = derive_partition_geometry(
        Path(args.partition_table), NVS_SELECTOR
    )
    app_offset, _app_size = derive_partition_geometry(
        Path(args.partition_table), APP_SELECTOR
    )

    # 5. Firmware build identity and trust anchor.
    validate_build_command(args.build_command)
    validate_trust_anchor(Path(args.secrets_header))
    image_digest = firmware_sha256(Path(args.firmware_image))

    # 6. Provisioning material. The provisioner refuses demo/test keys.
    ntp = validate_ntp(args.ntp)
    provisioner = load_nvs_provisioner()
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

    # 7. First device write. Everything above is a hard gate; past this point a
    #    failure is FAIL_SECURE_CUT and recovery is D4 only.
    marker.write_text(
        f"backend={device.name}\nnvs_offset={nvs_offset:#x}\n", encoding="utf-8"
    )
    marker.chmod(0o600)

    failure_boundary = "NONE"
    flash_result = "FAIL"
    readback_match = "FAIL"
    boot_result = "NOT_APPLICABLE_FIXTURE_BACKEND"

    try:
        device.write_region("nvs", nvs_offset, nvs_image)
        device.write_region(
            "firmware", app_offset, Path(args.firmware_image).read_bytes()
        )
        flash_result = "PASS"
    except Exception:
        # FAIL_SECURE_HOLD_AND_EVIDENCE (OD-L8-07): a failure at or after the
        # first write must still produce evidence, so it is recorded below
        # rather than raised past the bundle.
        failure_boundary = "DEVICE_WRITE"

    # 8. Private readback: only the boolean outcome leaves this scope. Past the first-write marker EVERY failure
    #    here (readback error, wrong length, comparison error) is FAIL_SECURE_HOLD_AND_EVIDENCE: it is recorded as a
    #    stable failure_boundary and never raised past the evidence bundle. Nothing is retried or recovered.
    if flash_result == "PASS":
        actual = None
        try:
            actual = device.read_region("nvs", nvs_offset)
        except Exception:  # the exception text is never recorded: it could carry device or path detail
            pass
        if not isinstance(actual, (bytes, bytearray)):
            flash_result, failure_boundary = "FAIL", "NVS_READBACK_ERROR"
        elif len(actual) != len(nvs_image):
            flash_result, failure_boundary = "FAIL", "NVS_READBACK_LENGTH"
        else:
            try:
                if compare_nvs_readback(nvs_image, bytes(actual)):
                    readback_match = "PASS"
                else:
                    failure_boundary = "NVS_READBACK"
            except Exception:
                flash_result, failure_boundary = "FAIL", "POST_WRITE_VERIFICATION"

    if failure_boundary != "NONE":
        print("L8_POST_FIRST_WRITE=FAIL_SECURE_HOLD_AND_EVIDENCE")

    try:
        write_evidence(
            evidence_dir / f"l8-{args.run_id}.json",
            {
                "schema_version": EVIDENCE_SCHEMA_VERSION,
                "run_id": args.run_id,
                "device_mac": observed["mac"],
                "chip_identity": observed["chip_identity"],
                "flash_size": observed["flash_size"],
                "firmware_sha256": image_digest,
                "nvs_schema_version": provisioner.NVS_SCHEMA_VERSION,
                "nvs_readback_match": readback_match,
                "flash_result": flash_result,
                "boot_verification_result": boot_result,
                "failure_boundary": failure_boundary,
            },
        )
    except L8Error:
        raise
    except Exception as exc:  # e.g. OSError: report a stable code, never the raw text
        raise L8Error("evidence bundle could not be written") from None

    print(f"L8_NVS_OFFSET={nvs_offset:#x}")
    print(f"L8_FLASH_RESULT={flash_result}")
    print(f"L8_NVS_READBACK_MATCH={readback_match}")
    print(f"L8_BOOT_VERIFICATION={boot_result}")
    print(f"L8_FAILURE_BOUNDARY={failure_boundary}")

    return 0 if readback_match == "PASS" and flash_result == "PASS" else 1


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
