#!/usr/bin/env python3

"""IDEA3 PR11 Phase 4 L8p — ESP32 device PROVISIONING ONLY: stage governance over the canonical L8 device flow (repository tooling).

Stage order: L7 -> L7u -> L8p -> Recovery R1-R8 -> LVR -> L8. L8p provisions the Protocol-v1 ESP32 so Recovery R4/R5 have a real device. It claims
NOTHING about Recovery R1-R8, LVR, L8 live acceptance, D4 or the electrical relay, and never sends CUT or RESTORE.

THIS MODULE IS THIN BY DESIGN. It contains NO device backend, NO subprocess executor, NO esptool argument validator, NO scratch-file handling, NO
NVS/firmware readback, NO terminal reset and NO boot verifier. All device work is the canonical flow in ``p4-l8-device.py`` (HardwareDevice,
SubprocessExecutor, validate_esptool_argv, NVS and firmware readback, the single terminal reset, the 12-field evidence bundle) and the signed
BOOT STATUS verifier in ``p4-l8-boot-verify.py``. L8p only supplies the stage profile the canonical flow explicitly accepts (OD-L8P-01):

* ``recovery_gate`` - the owner-attested PHYSICAL recovery attestation instead of D4 (for L8p only; L8 stays D4-only);
* ``pre_device_gate`` - the exact pins (firmware SHA-256, partition-table SHA-256, partition geometry, NVS namespace/schema), alignment and overlap;
* ``nvs_gate`` - the exact rendered NVS schema (the eleven approved fields, no address field);
* ``evidence_prefix`` - ``l8p`` (the evidence file is ``l8p-<run_id>.json``; the canonical 12-field schema is unchanged).

Regression tests: IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l8p_provisioning.py
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import hashlib
import importlib.util
import re
import sys
from pathlib import Path
from zoneinfo import ZoneInfo

HERE = Path(__file__).resolve().parent
STAGE_ID = "L8p"


def _load_canonical():
    target = HERE / "p4-l8-device.py"
    spec = importlib.util.spec_from_file_location("p4_l8_device_for_l8p", str(target))
    if spec is None or spec.loader is None:
        raise ValueError(f"cannot load the canonical L8 device flow: {target}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


L8 = _load_canonical()
L8Error = L8.L8Error

ATTESTATION_MAGIC = "AEGIS_P4_L8P_PHYSICAL_RECOVERY_ATTESTATION_V1"
# Exactly these keys, each with a constrained value: nothing free-form beyond one reference token, so no secret, credential, key,
# raw firmware or raw NVS byte can be carried (values are enums, hex digests, a MAC, a date and one reference).
CAPABILITY_KEYS = (  # the procedure must be able to ... : all YES
    "physical_serial_recovery", "rom_bootloader_recovery", "power_cycle_capable", "download_mode_entry", "owner_reviewed_serial_access",
    "reflash_pinned_artifacts", "interrupted_write_recovery",
)
INDEPENDENCE_KEYS = (  # the procedure must NOT depend on ... : all NO
    "depends_on_production", "depends_on_mqtt", "depends_on_network", "automatic_rollback", "legacy_firmware_fallback", "plaintext_1883",
    "remote_recovery",
)
ACK_KEYS = (  # explicit acknowledgements: all YES
    "ack_manual_out_of_band", "ack_not_d4", "ack_no_recovery_claim", "ack_no_lvr_claim", "ack_no_l8_acceptance_claim",
    "ack_no_electrical_relay_claim",
)
ATTESTATION_KEYS = (
    "stage", "expected_mac", "procedure_id", "procedure_class", "firmware_sha256", "partition_table_sha256", "approved_on",
    *CAPABILITY_KEYS, *INDEPENDENCE_KEYS, *ACK_KEYS,
)
PINS_KEYS = (
    "firmware_sha256", "partition_table_sha256", "nvs_offset", "nvs_size", "app_offset", "app_size", "nvs_namespace", "nvs_schema",
)
REFERENCE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/#?=&%+-]{2,199}$")
PLACEHOLDER_RE = re.compile(r"(REPLACE|TODO|TBD|CHANGEME|CHANGE-ME|FIXME|XXX)")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
DATE_RE = re.compile(r"^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$")
FORBIDDEN_NVS_NAMES = ("ip", "gw", "mask", "dns", "netmask", "gateway", "static", "addr", "address")
NVS_ALIGN = 0x1000     # flash sector
APP_ALIGN = 0x10000    # ESP32 application partition alignment


def _sha256_file(path: Path, label: str) -> str:
    try:
        return hashlib.sha256(Path(path).read_bytes()).hexdigest()
    except OSError as exc:
        raise L8Error(f"{label} missing or unreadable") from exc


# ---------------------------------------------------------------------------
# recovery gate (OD-L8P-01): the owner-attested physical recovery procedure
# ---------------------------------------------------------------------------

def parse_physical_recovery_attestation(path: Path) -> dict[str, str]:
    lines = L8.read_private_text(path).splitlines()
    if not lines or lines[0].strip() != ATTESTATION_MAGIC:
        raise L8Error(f"physical-recovery.attestation: first line must be {ATTESTATION_MAGIC}")
    record = L8.parse_key_values("\n".join(lines[1:]), ATTESTATION_KEYS, "physical-recovery.attestation")
    if record["stage"] != STAGE_ID:
        raise L8Error("physical-recovery.attestation: stage must be L8p")
    if L8.MAC_RE.fullmatch(record["expected_mac"]) is None:
        raise L8Error("physical-recovery.attestation: expected_mac is malformed")
    if REFERENCE_RE.fullmatch(record["procedure_id"]) is None or PLACEHOLDER_RE.search(record["procedure_id"].upper()):
        raise L8Error("physical-recovery.attestation: procedure_id is malformed or a placeholder")
    if record["procedure_class"] != "MANUAL_OUT_OF_BAND":
        raise L8Error("physical-recovery.attestation: procedure_class must be MANUAL_OUT_OF_BAND")
    for key in (*CAPABILITY_KEYS, *ACK_KEYS):
        if record[key] != "YES":
            raise L8Error(f"physical-recovery.attestation: {key} must be YES")
    for key in INDEPENDENCE_KEYS:
        if record[key] != "NO":
            raise L8Error(f"physical-recovery.attestation: {key} must be NO (the procedure must be manual and independent)")
    for key in ("firmware_sha256", "partition_table_sha256"):
        if SHA256_RE.fullmatch(record[key]) is None:
            raise L8Error(f"physical-recovery.attestation: {key} must be 64 lowercase hex characters")
    if DATE_RE.fullmatch(record["approved_on"]) is None:
        raise L8Error("physical-recovery.attestation: approved_on must be YYYY-MM-DD")
    today = dt.datetime.now(ZoneInfo("Asia/Bangkok")).date()
    try:
        approved = dt.date.fromisoformat(record["approved_on"])
    except ValueError as exc:
        raise L8Error("physical-recovery.attestation: approved_on is not a calendar date") from exc
    if approved > today:
        raise L8Error("physical-recovery.attestation: approved_on is in the future")
    return record


def recovery_gate(args: argparse.Namespace, input_dir: Path, binding: dict[str, str]) -> None:
    record = parse_physical_recovery_attestation(Path(input_dir) / "physical-recovery.attestation")
    if record["expected_mac"] != binding["expected_mac"]:
        raise L8Error("physical-recovery.attestation: expected_mac does not match the device.identity binding")
    if record["firmware_sha256"] != _sha256_file(Path(args.firmware_image), "firmware image"):
        raise L8Error("physical-recovery.attestation: firmware_sha256 does not match the firmware image")
    if record["partition_table_sha256"] != _sha256_file(Path(args.partition_table), "reviewed partition table"):
        raise L8Error("physical-recovery.attestation: partition_table_sha256 does not match the reviewed partition table")


# ---------------------------------------------------------------------------
# pins, geometry layout and exact NVS schema
# ---------------------------------------------------------------------------

def parse_pins(path: Path) -> dict[str, str]:
    pins = L8.parse_key_values(L8.read_private_text(path), PINS_KEYS, "provisioning.pins")
    for key in ("firmware_sha256", "partition_table_sha256"):
        if SHA256_RE.fullmatch(pins[key]) is None:
            raise L8Error(f"provisioning.pins: {key} must be 64 lowercase hex characters")
    for key in ("nvs_offset", "nvs_size", "app_offset", "app_size"):
        try:
            if int(pins[key], 0) <= 0:
                raise ValueError
        except ValueError as exc:
            raise L8Error(f"provisioning.pins: {key} must be a positive integer") from exc
    return pins


def validate_geometry_layout(*, nvs: tuple[int, int], app: tuple[int, int]) -> None:
    (nvs_off, nvs_size), (app_off, app_size) = nvs, app
    if nvs_off % NVS_ALIGN or nvs_size % NVS_ALIGN or nvs_size <= 0:
        raise L8Error("partition geometry: the NVS region is not flash-sector aligned")
    if app_off % APP_ALIGN or app_size <= 0:
        raise L8Error("partition geometry: the application region is not 64 KiB aligned")
    if nvs_off < app_off + app_size and app_off < nvs_off + nvs_size:
        raise L8Error("partition geometry: the NVS and application regions overlap")


def validate_nvs_csv(path: Path, provisioner, namespace: str, schema: int) -> None:
    """The rendered NVS image must be EXACTLY the pinned namespace/schema and the eleven approved fields; no address field of any kind."""
    with Path(path).open(newline="", encoding="utf-8") as handle:
        rows = list(csv.reader(handle))
    if not rows or rows[0] != ["key", "type", "encoding", "value"]:
        raise L8Error("nvs schema: unexpected CSV header")
    if len(rows) < 2 or rows[1][:2] != [namespace, "namespace"] or namespace != provisioner.NVS_NAMESPACE:
        raise L8Error("nvs schema: namespace is not the pinned aegis-p1 namespace")
    keys = [row[0] for row in rows[2:]]
    if any(k.lower() in FORBIDDEN_NVS_NAMES for k in keys):
        raise L8Error("nvs schema: an address/static-IP field is forbidden (DHCP only)")
    if keys != list(provisioner.NVS_KEYS):
        raise L8Error("nvs schema: the field set is not exactly the approved eleven fields")
    values = {row[0]: row[3] for row in rows[2:]}
    if values["schema"] != str(schema) or schema != provisioner.NVS_SCHEMA_VERSION:
        raise L8Error("nvs schema: the schema version is not the pinned version")


def build_profile():
    """The L8p stage profile for the canonical flow. The hooks share one private state dict (the parsed pins)."""
    state: dict[str, object] = {}

    def pre_device_gate(args: argparse.Namespace, input_dir: Path, binding: dict[str, str]) -> None:
        pins = parse_pins(Path(input_dir) / "provisioning.pins")
        if _sha256_file(Path(args.partition_table), "reviewed partition table") != pins["partition_table_sha256"]:
            raise L8Error("partition table digest does not match the pin")
        nvs = L8.derive_partition_geometry(Path(args.partition_table), L8.NVS_SELECTOR)
        app = L8.derive_partition_geometry(Path(args.partition_table), L8.APP_SELECTOR)
        pinned = tuple(int(pins[k], 0) for k in ("nvs_offset", "nvs_size", "app_offset", "app_size"))
        if (*nvs, *app) != pinned:
            raise L8Error("derived partition geometry does not equal the pinned geometry")
        validate_geometry_layout(nvs=nvs, app=app)
        if L8.firmware_sha256(Path(args.firmware_image)) != pins["firmware_sha256"]:
            raise L8Error("firmware image digest does not match the pinned firmware sha256")
        state["namespace"], state["schema"] = pins["nvs_namespace"], int(pins["nvs_schema"])

    def nvs_gate(csv_path: Path, provisioner) -> None:
        if "namespace" not in state:
            raise L8Error("the NVS gate ran before the pins were validated")
        validate_nvs_csv(csv_path, provisioner, str(state["namespace"]), int(state["schema"]))

    return L8.StageProfile(name=STAGE_ID, evidence_prefix="l8p", recovery_gate=recovery_gate, pre_device_gate=pre_device_gate,
                           nvs_gate=nvs_gate)


def provision(args: argparse.Namespace, **injection) -> int:
    """Run the canonical L8 flow with the L8p profile. ``injection`` is the canonical test seam (executor, boot_verifier, ...)."""
    return L8.provision(args, stage_profile=build_profile(), **injection)


def build_parser() -> argparse.ArgumentParser:
    return L8.build_parser()


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.command != "provision":
        sys.stderr.write("L8P_DEVICE=FAIL reason=only the provision command exists for L8p\n")
        return 1
    try:
        return provision(args)
    except L8Error as exc:
        sys.stderr.write(f"L8P_DEVICE=FAIL reason={exc}\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
