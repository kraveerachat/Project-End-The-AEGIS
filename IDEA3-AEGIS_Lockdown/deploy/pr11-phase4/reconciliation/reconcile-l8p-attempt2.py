#!/usr/bin/env python3
"""AEGIS IDEA3 PR11 Phase 4 - ONE-OFF, ATTEMPT-2-SPECIFIC L8p reconciliation (HOST ONLY, no device).

This is NOT a generic mechanism. It exists for exactly one historical attempt: the already-CONSUMED L8p successor attempt #2
(run id ``l8p-20261004-041840``). That attempt provisioned the ESP32 (first write STARTED, flash / NVS readback / firmware readback / signed BOOT
verification all PASS, failure boundary NONE, verify PASS, PRE->POST and PRE->RB compares PASS, S10 PASS) and then failed ONLY at the owner runner's final
secret scan, because the canonical flow's own TEMPORARY secret-bearing work artifacts ``l8p-work/nvs.csv`` and ``l8p-work/nvs.bin`` sit inside the evidence tree
the scan covers with no exclusions. The merged L8p design (spec section 8) defines them as temporary work artifacts, NOT formal evidence.

Owner decision (recorded in the L8p spec, section 9): a reviewed, attempt-2-specific, read-only / host-only reconciliation is approved. It does NOT authorize another
device attempt, requires NO physical recovery first, and the historical runner log, Authorization, K3 and consumed marker are never modified.

What it does, in order, and stops at the first failed gate (``L8P_ATTEMPT2_RECONCILIATION=FAIL``, no authoritative result fields, no retry):

  1. PRE-CLEANUP FORENSIC GATES: authority (frozen runner SHA-256, consumed marker, Authorization/K3 present and identical to the evidence copies); the one canonical
     12-field l8p JSON evidence bundle and its expected values; the historical ``owner-run.log`` shape (every required fact present, the original full-success line
     ABSENT); the PRE/POST/RB capture bundles' SHA256SUMS; the first-write marker; and the secret-value classification of the ENTIRE evidence tree with the same >= 8-byte
     semantics as ``l8p_secret_scan`` - exactly two hit files, nvs.csv (wifi.psk, mqtt.pass, k_c2d, k_d2c) and nvs.bin (wifi.psk, mqtt.pass). Only path, size and secret CLASS
     names are ever printed, never a value.
  2. PRESERVATION MANIFEST of every other regular file (path, mode, size, SHA-256) and every directory, held in memory.
  3. HOST-ONLY CLEANUP: remove EXACTLY ``<EVID>/l8p-work/nvs.csv`` and ``<EVID>/l8p-work/nvs.bin`` (canonical EVID root, WORK path exactly ``<EVID>/l8p-work``, no symlink
     component, regular non-symlink files, two fixed names, no wildcard, no recursion, no caller-supplied filename).
  4. POST-CLEANUP PROOFS: the rebuilt manifest is identical (nothing else changed), the unchanged full-tree secret scan reports ZERO hits, the capture checksums and the JSON
     verify again, and the first-write marker and the consumed marker are still present.

Only after every gate may it print the narrowly defined reconciliation result. Those result lines are NEW owner-approved reconciliation results; they do NOT claim that the
historical frozen runner printed its success line (it did not). This tool creates no repository receipt. It has no device capability: standard library only, no esptool, no
serial, no MQTT, no subprocess, no network, no sudo, no service or NetworkManager access.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import stat
import sys
from dataclasses import dataclass
from pathlib import Path

CLEANUP_ARTIFACTS = ("nvs.csv", "nvs.bin")          # the ONLY two files this tool may ever remove, by fixed name
SECRET_INPUTS = ("wifi.psk", "mqtt.pass", "k_c2d", "k_d2c")
JSON_FIELDS = {
    "schema_version", "run_id", "device_mac", "chip_identity", "flash_size", "firmware_sha256", "nvs_schema_version",
    "nvs_readback_match", "firmware_readback_match", "flash_result", "boot_verification_result", "failure_boundary",
}
MAX_SCAN_BYTES = 50_000_000                           # same cut-off as l8p_secret_scan


@dataclass(frozen=True)
class Binding:
    """The hard binding to historical attempt #2. The command line can NOT change it; only the test suite constructs another one."""
    run_id: str = "l8p-20261004-041840"
    evidence_dir_name: str = "2026-10-04-l8p-20261004-041840"
    freeze_dir_name: str = "2026-10-04-l8p-successor2"
    runner_sha256: str = "f4804bb62d804ddcc6f469a2be22a49c580b7cc015f288d92401ebd6b405dfe8"
    firmware_sha256: str = "bacc694c0b208e1d6857526d233c397e704795944099f951a91db82173ed4f9a"
    runner_name: str = "run-l8p-owner.FROZEN.sh"
    expected_hits: tuple = (
        ("l8p-work/nvs.csv", ("wifi.psk", "mqtt.pass", "k_c2d", "k_d2c")),
        ("l8p-work/nvs.bin", ("wifi.psk", "mqtt.pass")),
    )


BINDING = Binding()


class Refusal(Exception):
    """A gate failed. The message is a stable reason line and never contains a secret value."""


# ───────────────────────────── generic helpers ─────────────────────────────

def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def require(condition: bool, reason: str) -> None:
    if not condition:
        raise Refusal(reason)


def regular_private_file(path: Path, label: str) -> None:
    require(path.is_file() and not path.is_symlink(), f"{label}: not a regular non-symlink file")
    require(stat.S_IMODE(path.lstat().st_mode) == 0o600, f"{label}: mode is not 0600")


def canonical_dir(raw: str, label: str) -> Path:
    path = Path(raw)
    require(raw != "" and raw.startswith("/"), f"{label}: must be an absolute path")
    require(all(part not in ("", ".", "..") for part in raw.split("/")[1:]), f"{label}: must not contain empty, . or .. components")
    require(path.is_dir() and not path.is_symlink(), f"{label}: must be a real directory, not a symlink")
    require(os.path.realpath(path) == str(path), f"{label}: must be its own canonical path (no symlinked component)")
    return path


# ───────────────────────────── gate A: authority ─────────────────────────────

CONSUMED_MARKER = "L8p-ATTEMPT-CONSUMED"
CONSUMED_MARKER_SHAPE = re.compile(r"consumed_at=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\n")   # the shape l8p_consume_attempt writes


def gate_consumed_marker(freeze: Path) -> None:
    """The consumed marker, in its real location and real shape: <freeze>/auth/L8p-ATTEMPT-CONSUMED, a regular non-symlink 0600 file holding
    exactly `consumed_at=<UTC timestamp>`. It is REQUIRED (never created, repaired or replaced by this tool); there is no fallback for its absence."""
    marker = freeze / "auth" / CONSUMED_MARKER
    require(marker.is_file() and not marker.is_symlink(), f"auth/{CONSUMED_MARKER} missing or not a regular file")
    require(stat.S_IMODE(marker.lstat().st_mode) == 0o600, f"auth/{CONSUMED_MARKER} mode is not 0600")
    require(CONSUMED_MARKER_SHAPE.fullmatch(marker.read_text(encoding="utf-8", errors="replace")) is not None, f"auth/{CONSUMED_MARKER} is not in the l8p_consume_attempt shape")


def gate_authority(binding: Binding, freeze: Path, evid: Path) -> None:
    require(freeze.name == binding.freeze_dir_name, "freeze dir is not the attempt-2 freeze directory")
    runner = freeze / binding.runner_name
    require(runner.is_file() and not runner.is_symlink(), "frozen runner missing")
    require(sha256_file(runner) == binding.runner_sha256, "frozen runner SHA-256 mismatch")
    auth = freeze / "auth"
    require(auth.is_dir() and not auth.is_symlink(), "auth dir missing")
    gate_consumed_marker(freeze)
    for name in ("authorization-L8p.txt", "k3-L8p.txt"):
        require((auth / name).is_file() and not (auth / name).is_symlink(), f"auth/{name} missing")
    for name in ("authorization-L8p.txt", "k3-L8p.txt"):
        copy = evid / name
        require(copy.is_file() and not copy.is_symlink(), f"evidence copy of {name} missing")
        require(copy.read_bytes() == (auth / name).read_bytes(), f"evidence copy of {name} differs from the consumed Authorization/K3")
    frozen = evid / "frozen-inputs.txt"
    require(frozen.is_file(), "frozen-inputs.txt missing")
    lines = frozen.read_text(encoding="utf-8").splitlines()
    require(f"RUNNER_SHA256={binding.runner_sha256}" in lines, "frozen-inputs.txt does not carry the attempt-2 runner digest")
    require(f"FIRMWARE_SHA256={binding.firmware_sha256}" in lines, "frozen-inputs.txt does not carry the pinned firmware digest")


# ───────────────────────────── gate B: JSON evidence ─────────────────────────────

def verify_json_bundle(binding: Binding, evid: Path) -> None:
    directory = evid / "l8p-evidence"
    require(directory.is_dir() and not directory.is_symlink(), "l8p-evidence directory missing")
    entries = sorted(p.name for p in directory.iterdir())
    expected_name = f"l8p-{binding.run_id}.json"
    require(entries == [expected_name], "l8p-evidence must contain exactly the one attempt-2 JSON bundle")
    bundle_path = directory / expected_name
    regular_private_file(bundle_path, "JSON evidence")
    try:
        bundle = json.loads(bundle_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raise Refusal("JSON evidence is not valid JSON") from None
    require(isinstance(bundle, dict) and set(bundle) == JSON_FIELDS, "JSON evidence is not the canonical 12-field schema")
    expectations = {
        "run_id": binding.run_id, "firmware_sha256": binding.firmware_sha256, "flash_result": "PASS", "nvs_readback_match": "PASS",
        "firmware_readback_match": "PASS", "boot_verification_result": "PASS", "failure_boundary": "NONE",
    }
    for key, want in expectations.items():
        require(bundle[key] == want, f"JSON evidence field {key} is not the expected value")


# ───────────────────────────── gate C: historical owner-run.log ─────────────────────────────

REQUIRED_WHOLE_LINES = (
    "L8P_FLASH_RESULT=PASS", "L8P_NVS_READBACK_MATCH=PASS", "L8P_FIRMWARE_READBACK_MATCH=PASS", "L8P_BOOT_VERIFICATION=PASS",
    "L8P_BOOT_VERIFICATION_DETAIL=PASS_BOOT_LOCKDOWN", "L8P_FAILURE_BOUNDARY=NONE", "L8P_APPLY=COMPLETE", "L8P_VERIFY=PASS",
    "CAPTURE_PRE=COMPLETE SHA256=PASS", "CAPTURE_POST=COMPLETE SHA256=PASS", "CAPTURE_RB=COMPLETE SHA256=PASS",
    "L8P_FIRST_HARDWARE_WRITE=STARTED", "L8P_DEVICE_ACTION_TAKEN=NONE", "L8P_ROLLBACK=FAIL_SECURE_HOLD_AND_EVIDENCE",
)


def gate_owner_run_log(binding: Binding, evid: Path) -> None:
    log = evid / "owner-run.log"
    require(log.is_file() and not log.is_symlink(), "owner-run.log missing")
    text = log.read_text(encoding="utf-8", errors="replace")
    lines = text.splitlines()
    for wanted in REQUIRED_WHOLE_LINES:
        require(wanted in lines, f"owner-run.log lacks the required line {wanted}")
    require(lines.count("PRESERVATION_S10=PASS") >= 2 and lines.count("COMPARE_RESULT=PASS") >= 2, "owner-run.log lacks both PASS compare/S10 results (PRE->POST and PRE->RB)")
    require("COMPARE_RESULT=FAIL" not in lines and "PRESERVATION_S10=FAIL" not in lines, "owner-run.log records a failed compare or S10")
    require(any(re.fullmatch(r"L8P_SECRET_VALUE_SCAN_FILES=\d+ L8P_SECRET_VALUE_SCAN_HITS=2", line) for line in lines), "owner-run.log does not record the original 2-hit secret scan")
    require(any("L8P_PROVISIONING=NOT_PROVEN" in line for line in lines), "owner-run.log lacks the historical L8P_PROVISIONING=NOT_PROVEN statement")
    require(f"{binding.run_id}" in text or binding.evidence_dir_name in text, "owner-run.log does not belong to attempt 2")
    # The original runner must NOT have emitted its full-success result.
    require(not any(line.lstrip().startswith("L8P_LIVE_EXECUTED=YES") for line in lines), "owner-run.log unexpectedly carries the runner's full-success line")
    require(not any("L8P_PROVISIONING=PASS" in line for line in lines), "owner-run.log unexpectedly carries L8P_PROVISIONING=PASS")


# ───────────────────────────── gate D: capture bundles ─────────────────────────────

def verify_capture_bundles(evid: Path) -> None:
    for name in ("pre-root", "post-root", "rb-root"):
        bundle = evid / name
        require(bundle.is_dir() and not bundle.is_symlink(), f"{name} missing")
        sums = bundle / "SHA256SUMS"
        require(sums.is_file() and not sums.is_symlink(), f"{name}/SHA256SUMS missing")
        entries = 0
        for raw in sums.read_text(encoding="utf-8").splitlines():
            if not raw.strip():
                continue
            match = re.fullmatch(r"([0-9a-f]{64})  (.+)", raw)
            require(match is not None, f"{name}/SHA256SUMS is malformed")
            rel = match.group(2)
            target = bundle / rel
            require(".." not in Path(rel).parts and target.is_file() and not target.is_symlink(), f"{name}: listed file missing: {rel}")
            require(sha256_file(target) == match.group(1), f"{name}: checksum failure for {rel}")
            entries += 1
        require(entries > 0, f"{name}/SHA256SUMS lists nothing")


# ───────────────────────────── gate E/F: marker, manifest, secret scan ─────────────────────────────

def gate_markers(evid: Path, freeze: Path) -> None:
    marker = evid / "l8p-work" / "first-write.marker"
    regular_private_file(marker, "first-write marker")
    gate_consumed_marker(freeze)


def read_needles(input_dir: Path) -> list[tuple[str, bytes]]:
    needles = []
    for name in SECRET_INPUTS:
        path = input_dir / name
        require(path.is_file() and not path.is_symlink(), f"owner input {name} missing")
        value = path.read_bytes().strip()
        if len(value) >= 8:                              # the same semantics as l8p_secret_scan
            needles.append((name, value))
    require(len(needles) == len(SECRET_INPUTS), "an owner secret input is shorter than 8 bytes")
    return needles


def scan_tree(evid: Path, needles: list[tuple[str, bytes]]) -> dict[str, tuple[int, tuple[str, ...]]]:
    """Per hit file: (size, secret class names). NEVER values. Whole tree, no exclusions."""
    hits: dict[str, tuple[int, tuple[str, ...]]] = {}
    for f in sorted(evid.rglob("*")):
        if not f.is_file() or f.stat().st_size >= MAX_SCAN_BYTES:
            continue
        data = f.read_bytes()
        classes = tuple(name for name, value in needles if value in data)
        if classes:
            hits[str(f.relative_to(evid))] = (f.stat().st_size, classes)
    return hits


def assert_no_symlinks(evid: Path) -> None:
    for entry in evid.rglob("*"):
        require(not entry.is_symlink(), "the evidence tree contains a symlink")


def manifest(evid: Path) -> dict[str, tuple]:
    """Every directory and every regular file EXCEPT the two cleanup artifacts: (kind, mode, size, sha256). Non-secret by construction."""
    excluded = {f"l8p-work/{name}" for name in CLEANUP_ARTIFACTS}
    result: dict[str, tuple] = {}
    for entry in sorted(evid.rglob("*")):
        rel = str(entry.relative_to(evid))
        if rel in excluded:
            continue
        mode = stat.S_IMODE(entry.lstat().st_mode)
        if entry.is_dir():
            result[rel] = ("dir", mode)
        else:
            result[rel] = ("file", mode, entry.stat().st_size, sha256_file(entry))
    return result


# ───────────────────────────── phase 5: host-only cleanup ─────────────────────────────

class CleanupFailure(Refusal):
    """A failure while REMOVING (or right before removing) the two staging files. ``removed`` lists what was already unlinked: the mutation state is never hidden."""

    def __init__(self, reason: str, removed: list) -> None:
        super().__init__(reason)
        self.removed = list(removed)


def cleanup_exact_two(evid: Path) -> None:
    work = evid / "l8p-work"
    require(work.is_dir() and not work.is_symlink() and os.path.realpath(work) == str(work), "l8p-work must be a real canonical directory directly under the evidence root")
    for name in CLEANUP_ARTIFACTS:
        path = work / name
        require(path.is_file() and not path.is_symlink(), f"{name} is not a regular non-symlink file")
    # Minimise ambiguous partial cleanup: refuse BEFORE the first removal if the directory is not writable.
    if not os.access(work, os.W_OK | os.X_OK):
        raise CleanupFailure("l8p-work is not writable; nothing was removed", [])
    removed: list[str] = []
    for name in CLEANUP_ARTIFACTS:
        try:
            os.unlink(work / name)                       # exact fixed names only; no wildcard, no recursion, no caller-supplied filename
        except OSError as exc:
            raise CleanupFailure(f"removal of {name} failed ({type(exc).__name__})", removed) from None
        removed.append(name)
    for name in CLEANUP_ARTIFACTS:
        if os.path.lexists(work / name):
            raise CleanupFailure(f"{name} is still present after removal", removed)


# ───────────────────────────── orchestration ─────────────────────────────

def reconcile(evidence_root: str, freeze_dir: str, input_dir: str, binding: Binding = BINDING, out=print) -> int:
    phase = "PRE_CLEANUP"                                # nothing has been changed while the phase is PRE_CLEANUP
    try:
        evid = canonical_dir(evidence_root, "evidence root")
        freeze = canonical_dir(freeze_dir, "freeze dir")
        inputs = canonical_dir(input_dir, "input dir")
        require(evid.name == binding.evidence_dir_name, "evidence root is not the attempt-2 evidence directory")
        gate_authority(binding, freeze, evid)
        out("ATTEMPT2_CONSUMED_MARKER_PRESENT=YES")
        out("ATTEMPT2_CONSUMPTION_PROOF=CONSUMED_MARKER")
        assert_no_symlinks(evid)
        verify_json_bundle(binding, evid)
        gate_owner_run_log(binding, evid)
        verify_capture_bundles(evid)
        gate_markers(evid, freeze)
        needles = read_needles(inputs)
        hits = scan_tree(evid, needles)
        expected = {path: classes for path, classes in binding.expected_hits}
        for path, (size, classes) in sorted(hits.items()):
            out(f"L8P_RECONCILIATION_SECRET_HIT path={path} size={size} classes={','.join(classes)}")
        require(set(hits) == set(expected), "the secret-hit files are not exactly the two expected work artifacts")
        for path, classes in expected.items():
            require(hits[path][1] == classes, f"the secret classes in {path} are not the expected ones")
        before = manifest(evid)
        out(f"L8P_RECONCILIATION_PRESERVATION_MANIFEST_ENTRIES={len(before)}")
        out("L8P_RECONCILIATION_PRE_CLEANUP_GATES=PASS")

        phase = "CLEANUP"                                # from here a failure may have changed the tree and is reported as such
        cleanup_exact_two(evid)
        phase = "POST_CLEANUP"
        out("NVS_CSV_PRESENT=NO")
        out("NVS_BIN_PRESENT=NO")
        marker_present = (evid / "l8p-work" / "first-write.marker").is_file()
        json_present = (evid / "l8p-evidence" / f"l8p-{binding.run_id}.json").is_file()
        out(f"FIRST_WRITE_MARKER_PRESENT={'YES' if marker_present else 'NO'}")
        out(f"JSON_EVIDENCE_PRESENT={'YES' if json_present else 'NO'}")
        require(marker_present and json_present, "the first-write marker or the JSON evidence is missing after cleanup")

        require(manifest(evid) == before, "the preserved evidence changed during cleanup")
        out("OTHER_EVIDENCE_CHANGED=NO")
        after_hits = scan_tree(evid, needles)
        out(f"SECRET_VALUE_SCAN_HITS={len(after_hits)}")
        require(not after_hits, "the full-tree secret scan still reports hits after cleanup")
        verify_capture_bundles(evid)
        verify_json_bundle(binding, evid)
        gate_markers(evid, freeze)
    except (Refusal, OSError) as exc:
        # NO authoritative result field is ever printed on a failure. The phase says whether the tree may have been changed.
        if isinstance(exc, OSError):                     # an unexpected filesystem error: a controlled, non-secret failure, never a traceback
            exc = Refusal(f"filesystem error ({type(exc).__name__})")
        if isinstance(exc, CleanupFailure):
            out(f"L8P_RECONCILIATION_MUTATION_STATE={'PARTIAL_REMOVED=' + ','.join(exc.removed) if exc.removed else 'NONE_REMOVED'}")
        if phase != "PRE_CLEANUP":
            out("L8P_RECONCILIATION_MUTATION_PERFORMED=" + ("PARTIAL_OR_COMPLETE" if phase == "POST_CLEANUP" or getattr(exc, "removed", None) else "NO"))
        out(f"L8P_ATTEMPT2_RECONCILIATION=FAIL phase={phase} reason={exc}")
        return 1
    out("L8P_ATTEMPT2_RECONCILIATION=PASS")
    out("L8P_RECONCILIATION_DEVICE_ACTION=NONE")
    out("L8P_RECONCILIATION_SECRET_WORK_REMOVED=YES")
    out("L8P_RECONCILIATION_SECRET_SCAN=PASS")
    out("L8P_RECONCILIATION_EVIDENCE_PRESERVED=YES")
    out("L8P_LIVE_EXECUTED=YES")
    out("L8P_PROVISIONING=PASS")
    out("ORIGINAL_RUNNER_FULL_SUCCESS_LINE=NO")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="One-off attempt-2 L8p host-only reconciliation (no device).", allow_abbrev=False)
    parser.add_argument("--evidence-root", required=True)
    parser.add_argument("--freeze-dir", required=True)
    parser.add_argument("--input-dir", required=True)
    args = parser.parse_args(argv)
    return reconcile(args.evidence_root, args.freeze_dir, args.input_dir, BINDING)


if __name__ == "__main__":
    sys.exit(main())
