"""ICu one-shot Core upgrade primitives. Host access is supplied by the frozen runner.

The module deliberately keeps the installed-unit restart consequence closed
until a separately reviewed source change binds acceptable evidence. It does
not offer an environment-variable or command-line override for that blocker.
"""

from __future__ import annotations

import json
import importlib.util
import os
import re
import secrets
import argparse
import hashlib
import subprocess
from pathlib import Path
from typing import Any

EXPECTED_MAIN = "4ebade39a3ae2bf2c4fd75f0ebba0edb46248e17"
OLD_RELEASE_ID = "954ce1c191885e9e90198a6f54a3d990bcf144fc"
NEW_RELEASE_ID = "idea3-core-728c2d9b-20261010"
NEW_RELEASE_SOURCE_MAIN = "728c2d9b56d2d8b0b5933202ca20f45e6687602b"
OLD_SUMS_SHA256 = "9b2faeb4f44225bcf38ba6df5b5403e014998c7310e7c04a77c30c03f2d177df"
OLD_MANIFEST_SHA256 = "732d6af5afb0451e51655078abd8c6dc04a72ed258fb04e79c806210f2002a18"
NEW_SUMS_SHA256 = "0fbe8c208b49242c4ede3a097f019879dad2e0e1ab2dd7ec1a468bc289fc5749"
NEW_MANIFEST_SHA256 = "b6dfa93168f43d7471de3d5092baefda9f0b1027cf5dba3d6b1e3f99eb5a16cf"
SYSTEMD_RESTART_EFFECT_PROVEN = False
PRESERVED_KEYS = {
    "idea1", "idea2", "mqtt_broker", "mqtt_service_2", "twingate", "tunnel",
    "firewall", "nftables", "network", "relay", "esp32", "incidents",
    "database", "ctu_ctv_markers", "recovery_markers",
}
SHA256_RE = re.compile(r"[0-9a-f]{64}\Z")
JOURNAL_STATE_FIELDS = {
    "preflight", "release_install_started_by_attempt", "release_owned_by_attempt",
    "current_switch_started_by_attempt", "current_owned_by_attempt",
    "current_restored_by_attempt", "forward_restart_invocations",
    "rollback_restart_invocations",
}
JOURNAL_TRANSITIONS = {
    "attempt_marker_pending": {"attempt_consumed"},
    "attempt_consumed": {"installing", "forward_failed"},
    "installing": {"installed", "forward_failed"},
    "installed": {"switching_current", "forward_failed"},
    "switching_current": {"current_switched", "forward_failed"},
    "current_switched": {"core_restart_started", "forward_failed"},
    "core_restart_started": {"core_restarted", "forward_failed"},
    "core_restarted": {"complete", "forward_failed"},
    "forward_failed": {"rollback_switching_current", "rollback_no_pointer_change"},
    "rollback_switching_current": {"rollback_current_restored"},
    "rollback_current_restored": {"rollback_core_restart_started", "rolled_back"},
    "rollback_core_restart_started": {"rollback_core_restarted"},
    "rollback_core_restarted": {"rolled_back"},
    "rollback_no_pointer_change": {"rolled_back"},
}


class ICuRefused(RuntimeError):
    """A stable fail-closed reason without host-sensitive details."""


def _fsync_dir(directory: Path) -> None:
    fd = os.open(directory, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def consume_attempt_marker(path: Path) -> None:
    """Exclusively create the permanent stage marker and sync file + directory."""
    path = Path(path)
    if path.is_symlink() or not path.parent.is_dir():
        raise ICuRefused("ICU_ATTEMPT_MARKER_PATH_INVALID")
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(path, flags, 0o600)
    except FileExistsError as exc:
        raise ICuRefused("ICU_ATTEMPT_ALREADY_CONSUMED") from exc
    try:
        os.write(fd, b"stage=ICu\nattempt=1\n")
        os.fsync(fd)
    finally:
        os.close(fd)
    _fsync_dir(path.parent)


def _base_journal(phase: str) -> dict[str, Any]:
    return {
        "schema": "aegis-icu-journal-v1",
        "stage": "ICu",
        "expected_main": EXPECTED_MAIN,
        "old_release_id": OLD_RELEASE_ID,
        "old_sums_sha256": OLD_SUMS_SHA256,
        "old_manifest_sha256": OLD_MANIFEST_SHA256,
        "new_release_id": NEW_RELEASE_ID,
        "new_source_main": NEW_RELEASE_SOURCE_MAIN,
        "new_sums_sha256": NEW_SUMS_SHA256,
        "new_manifest_sha256": NEW_MANIFEST_SHA256,
        "phase": phase,
        "release_install_started_by_attempt": False,
        "release_owned_by_attempt": False,
        "current_switch_started_by_attempt": False,
        "current_owned_by_attempt": False,
        "current_restored_by_attempt": False,
        "forward_restart_invocations": 0,
        "rollback_restart_invocations": 0,
    }


def _validate_state_update(previous: dict[str, Any], update: dict[str, Any]) -> None:
    if set(update) - JOURNAL_STATE_FIELDS:
        raise ICuRefused("ICU_JOURNAL_FIELD_REFUSED")
    for key, value in update.items():
        if key in {"release_install_started_by_attempt", "release_owned_by_attempt",
                   "current_switch_started_by_attempt", "current_owned_by_attempt",
                   "current_restored_by_attempt"}:
            if not isinstance(value, bool):
                raise ICuRefused("ICU_JOURNAL_BOOLEAN_INVALID")
            if previous.get(key) is True and value is False:
                raise ICuRefused("ICU_JOURNAL_OWNERSHIP_REVERSAL")
        elif key.endswith("_invocations"):
            if isinstance(value, bool) or value not in {0, 1}:
                raise ICuRefused("ICU_JOURNAL_COUNTER_INVALID")
            if value < previous.get(key, 0):
                raise ICuRefused("ICU_JOURNAL_COUNTER_REVERSAL")
        elif key == "preflight":
            if not isinstance(value, dict):
                raise ICuRefused("ICU_JOURNAL_PREFLIGHT_INVALID")
            if "preflight" in previous and previous["preflight"] != value:
                raise ICuRefused("ICU_JOURNAL_PREFLIGHT_REWRITE_REFUSED")
    merged = dict(previous)
    merged.update(update)
    if merged["release_owned_by_attempt"] and not merged["release_install_started_by_attempt"]:
        raise ICuRefused("ICU_JOURNAL_RELEASE_WITHOUT_INSTALL_INTENT")
    if merged["current_switch_started_by_attempt"] and not merged["release_owned_by_attempt"]:
        raise ICuRefused("ICU_JOURNAL_SWITCH_WITHOUT_RELEASE_OWNERSHIP")
    if merged["current_owned_by_attempt"] and not merged["release_owned_by_attempt"]:
        raise ICuRefused("ICU_JOURNAL_CURRENT_WITHOUT_RELEASE_OWNERSHIP")
    if merged["current_owned_by_attempt"] and not merged["current_switch_started_by_attempt"]:
        raise ICuRefused("ICU_JOURNAL_CURRENT_WITHOUT_SWITCH_INTENT")
    if merged["current_restored_by_attempt"] and not merged["current_owned_by_attempt"]:
        raise ICuRefused("ICU_JOURNAL_RESTORE_WITHOUT_CURRENT_OWNERSHIP")
    if merged["forward_restart_invocations"] and not merged["current_owned_by_attempt"]:
        raise ICuRefused("ICU_JOURNAL_RESTART_WITHOUT_CURRENT_OWNERSHIP")
    if merged["rollback_restart_invocations"] and not merged["forward_restart_invocations"]:
        raise ICuRefused("ICU_JOURNAL_ROLLBACK_RESTART_WITHOUT_FORWARD_RESTART")


def _validate_update_phase(previous: dict[str, Any], phase: str, update: dict[str, Any]) -> None:
    _validate_state_update(previous, update)
    phase_for_true = {
        "release_install_started_by_attempt": "installing",
        "release_owned_by_attempt": "installed",
        "current_switch_started_by_attempt": "switching_current",
        "current_owned_by_attempt": "current_switched",
        "current_restored_by_attempt": "rollback_current_restored",
    }
    for key, expected_phase in phase_for_true.items():
        if update.get(key) is True and previous.get(key) is not True and phase != expected_phase:
            # Reconciliation after an interrupted symlink replacement proves the attempt's ownership.
            if not (key == "current_owned_by_attempt" and phase == "rollback_current_restored"):
                raise ICuRefused("ICU_JOURNAL_OWNERSHIP_PHASE_MISMATCH")
    if (update.get("forward_restart_invocations") == 1
            and previous.get("forward_restart_invocations") != 1
            and phase != "core_restart_started"):
        raise ICuRefused("ICU_JOURNAL_RESTART_PHASE_MISMATCH")
    if (update.get("rollback_restart_invocations") == 1
            and previous.get("rollback_restart_invocations") != 1
            and phase != "rollback_core_restart_started"):
        raise ICuRefused("ICU_JOURNAL_ROLLBACK_RESTART_PHASE_MISMATCH")


def write_ahead_journal(path: Path, phase: str, state: dict[str, Any] | None = None) -> dict[str, Any]:
    """Atomically replace the root-private journal and fsync its file and parent."""
    path = Path(path)
    if not re.fullmatch(r"[a-z_]+", phase):
        raise ICuRefused("ICU_JOURNAL_PHASE_INVALID")
    path = Path(path)
    if path.is_symlink():
        raise ICuRefused("ICU_JOURNAL_SYMLINK_REFUSED")
    if path.exists():
        data = read_journal(path)
        if phase not in JOURNAL_TRANSITIONS.get(data["phase"], set()):
            raise ICuRefused("ICU_JOURNAL_TRANSITION_REFUSED")
        if phase == "forward_failed":
            data["failed_from_phase"] = data["phase"]
        update = state or {}
        _validate_update_phase(data, phase, update)
        data.update(update)
        data["phase"] = phase
    else:
        if phase != "attempt_marker_pending":
            raise ICuRefused("ICU_JOURNAL_INITIAL_PHASE_INVALID")
        data = _base_journal(phase)
        update = state or {}
        _validate_update_phase(data, phase, update)
        data.update(update)
    if (data.get("expected_main") != EXPECTED_MAIN
            or data.get("old_release_id") != OLD_RELEASE_ID
            or data.get("new_release_id") != NEW_RELEASE_ID):
        raise ICuRefused("ICU_JOURNAL_PIN_MISMATCH")
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    temp = path.with_name(f".{path.name}.{secrets.token_hex(8)}.tmp")
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(temp, flags, 0o600)
    try:
        body = (json.dumps(data, sort_keys=True, separators=(",", ":")) + "\n").encode("ascii")
        with os.fdopen(fd, "wb", closefd=False) as stream:
            stream.write(body)
            stream.flush()
            os.fsync(fd)
    finally:
        os.close(fd)
    os.replace(temp, path)
    os.chmod(path, 0o600, follow_symlinks=False)
    _fsync_dir(path.parent)
    return data


def read_journal(path: Path) -> dict[str, Any]:
    path = Path(path)
    if path.is_symlink() or not path.is_file():
        raise ICuRefused("ICU_JOURNAL_MISSING_OR_UNSAFE")
    try:
        data = json.loads(path.read_text(encoding="ascii"))
    except (OSError, UnicodeError, ValueError) as exc:
        raise ICuRefused("ICU_JOURNAL_UNREADABLE") from exc
    pins = _base_journal("ignored")
    required_keys = set(pins)
    allowed_keys = required_keys | JOURNAL_STATE_FIELDS | {"failed_from_phase"}
    if (not isinstance(data, dict) or not required_keys <= set(data) or set(data) - allowed_keys
            or any(data.get(key) != value for key, value in pins.items()
                   if key not in JOURNAL_STATE_FIELDS and key != "phase")):
        raise ICuRefused("ICU_JOURNAL_PIN_MISMATCH")
    _validate_state_update(pins, {key: data[key] for key in JOURNAL_STATE_FIELDS if key in data})
    if data.get("phase") not in JOURNAL_TRANSITIONS and data.get("phase") not in {
        "attempt_marker_pending", "attempt_consumed", "complete", "rolled_back",
        "forward_failed", "rollback_current_restored", "rollback_core_restart_started",
        "rollback_core_restarted", "rollback_no_pointer_change",
    }:
        raise ICuRefused("ICU_JOURNAL_PHASE_INVALID")
    if "failed_from_phase" in data and data["failed_from_phase"] not in JOURNAL_TRANSITIONS:
        raise ICuRefused("ICU_JOURNAL_FAILURE_PHASE_INVALID")
    if data["phase"] in {"current_switched", "core_restart_started", "core_restarted", "complete"}:
        if not data["current_owned_by_attempt"] or not data["release_owned_by_attempt"]:
            raise ICuRefused("ICU_JOURNAL_PHASE_OWNERSHIP_CONTRADICTION")
    if data["phase"] in {"core_restart_started", "core_restarted", "complete"}:
        if data["forward_restart_invocations"] != 1:
            raise ICuRefused("ICU_JOURNAL_PHASE_RESTART_CONTRADICTION")
    if data["phase"] == "rollback_core_restart_started" and data["rollback_restart_invocations"] != 1:
        raise ICuRefused("ICU_JOURNAL_PHASE_ROLLBACK_RESTART_CONTRADICTION")
    if data["phase"] == "rolled_back" and data["current_owned_by_attempt"] and not data["current_restored_by_attempt"]:
        raise ICuRefused("ICU_JOURNAL_PHASE_ROLLBACK_CONTRADICTION")
    if data["phase"] == "forward_failed" and data.get("failed_from_phase") in {
        "current_switched", "core_restart_started", "core_restarted", "complete",
    } and not data["current_owned_by_attempt"]:
        raise ICuRefused("ICU_JOURNAL_FAILURE_OWNERSHIP_CONTRADICTION")
    return data


def validate_exact_authority(auth: dict[str, str], k3: dict[str, str], *, runner_sha256: str,
                             runner_template_sha256: str,
                             operator_user: str, operator_uid: str, unit_snapshot_sha256: str,
                             today: str) -> None:
    """Require independently recorded, exact-pin-matching ICu Authorization + K3."""
    required = {
        "stage": "ICu", "expected_main": EXPECTED_MAIN, "frozen_runner_sha256": runner_sha256,
        "runner_template_sha256": runner_template_sha256,
        "operator_user": operator_user, "operator_uid": operator_uid,
        "unit_snapshot_sha256": unit_snapshot_sha256, "old_release_id": OLD_RELEASE_ID,
        "new_release_id": NEW_RELEASE_ID, "new_release_source_main": NEW_RELEASE_SOURCE_MAIN,
        "new_sums_sha256": NEW_SUMS_SHA256, "new_manifest_sha256": NEW_MANIFEST_SHA256,
    }
    if not all(SHA256_RE.fullmatch(value) for value in (runner_sha256, runner_template_sha256, unit_snapshot_sha256)):
        raise ICuRefused("ICU_AUTHORITY_DIGEST_INVALID")
    if set(auth) != (set(required) | {"date", "authorizer", "scope", "reference"}):
        raise ICuRefused("ICU_AUTHORIZATION_FIELDS_INVALID")
    if set(k3) != (set(required) | {"date", "confirmed_by", "idea1_window_overlap", "reference"}):
        raise ICuRefused("ICU_K3_FIELDS_INVALID")
    if any(auth.get(key) != value or k3.get(key) != value for key, value in required.items()):
        raise ICuRefused("ICU_AUTHORITY_PIN_MISMATCH")
    if auth.get("authorizer") != "music" or k3.get("confirmed_by") != "kraveerachat":
        raise ICuRefused("ICU_AUTHORITY_ROLE_MISMATCH")
    if auth.get("date") != k3.get("date") or auth.get("date") != today:
        raise ICuRefused("ICU_AUTHORITY_DATE_MISMATCH")
    if k3.get("idea1_window_overlap") != "NONE":
        raise ICuRefused("ICU_K3_OVERLAP_INVALID")


def validate_preflight(facts: dict[str, Any]) -> None:
    """Validate executor-relevant state returned by its read-only host probe."""
    expected = {
        "current_release_id": OLD_RELEASE_ID,
        "core_active_state": "active",
        "detector_state": "loaded/inactive/dead/disabled/pid0/process0",
        "ctu_ctv_history": "FAIL_IMMUTABLE_CONSUMED",
        "recovery_authorized": "NO",
    }
    if any(facts.get(key) != value for key, value in expected.items()):
        raise ICuRefused("ICU_PREFLIGHT_STATE_MISMATCH")
    before = facts.get("preserved_services")
    if not isinstance(before, dict) or set(before) != PRESERVED_KEYS:
        raise ICuRefused("ICU_PRESERVATION_SNAPSHOT_INVALID")
    if facts.get("restart_effect") != "NOT_PROVEN" or not SYSTEMD_RESTART_EFFECT_PROVEN:
        raise ICuRefused("ACTUAL_INSTALLED_UNIT_RESTART_EFFECT_NOT_PROVEN")


def check_release(path: Path, release_id: str, source_main: str | None,
                  sums_sha256: str, manifest_sha256: str) -> None:
    """Run the existing release guard and bind its exact pinned metadata files."""
    here = Path(__file__).resolve().parent
    spec = importlib.util.spec_from_file_location("p4_icu_l7_release_guard", here / "p4-l7-release-guard.py")
    if spec is None or spec.loader is None:
        raise ICuRefused("ICU_RELEASE_GUARD_UNAVAILABLE")
    guard = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(guard)
    logical = f"/opt/aegis-idea3/releases/{release_id}"
    try:
        guarded_id, guarded_source = guard.check(logical, Path(path), "root")
    except (guard.Refusal, OSError, ValueError) as exc:
        raise ICuRefused("ICU_RELEASE_GUARD_FAILED") from exc
    if guarded_id != release_id or (source_main is not None and guarded_source != source_main):
        raise ICuRefused("ICU_RELEASE_PROVENANCE_MISMATCH")
    sums = Path(path) / "RELEASE-SHA256SUMS"
    manifest = Path(path) / "RELEASE-MANIFEST.json"
    if hashlib.sha256(sums.read_bytes()).hexdigest() != sums_sha256:
        raise ICuRefused("ICU_RELEASE_SUMS_PIN_MISMATCH")
    if hashlib.sha256(manifest.read_bytes()).hexdigest() != manifest_sha256:
        raise ICuRefused("ICU_RELEASE_MANIFEST_PIN_MISMATCH")


def unit_snapshot_sha256() -> str:
    """Hash installed Core/Detector unit files and all their active drop-ins."""
    env = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL": "C"}
    files: dict[str, str] = {}
    for unit in ("aegis-idea3-core.service", "aegis-idea3-detector.service"):
        for prop in ("FragmentPath", "DropInPaths"):
            done = subprocess.run(["systemctl", "show", "-p", prop, "--value", unit],
                                  capture_output=True, text=True, env=env, timeout=10, check=False)
            if done.returncode != 0:
                raise ICuRefused("ICU_UNIT_SNAPSHOT_UNAVAILABLE")
            values = [line.strip() for line in done.stdout.splitlines() if line.strip()]
            if prop == "FragmentPath" and len(values) != 1:
                raise ICuRefused("ICU_UNIT_FRAGMENT_INVALID")
            if prop == "DropInPaths":
                values = done.stdout.split()
            for filename in values:
                path = Path(filename)
                if not path.is_absolute() or path.is_symlink() or not path.is_file():
                    raise ICuRefused("ICU_UNIT_FILE_UNSAFE")
                files[f"{unit}:{path}"] = hashlib.sha256(path.read_bytes()).hexdigest()
    body = "".join(f"{key}={files[key]}\n" for key in sorted(files)).encode("ascii")
    return hashlib.sha256(body).hexdigest()


def execute(backend: Any, marker: Path, journal_path: Path | None = None) -> dict[str, Any]:
    """Preflight, consume once, then run journaled bounded operations if unblocked."""
    facts = backend.preflight()  # read-only; backend must bind both exact release guards and unit digests
    validate_preflight(facts)
    # This intentionally remains unreachable while the actual installed-unit consequence is NOT_PROVEN.
    journal = Path(journal_path) if journal_path else Path(marker).with_name("icu-journal.json")
    marker = Path(marker)
    if marker.exists() or marker.is_symlink():
        raise ICuRefused("ICU_ATTEMPT_ALREADY_CONSUMED")
    initial = {
        "preflight": facts,
        "release_install_started_by_attempt": False,
        "release_owned_by_attempt": False,
        "current_switch_started_by_attempt": False,
        "current_owned_by_attempt": False,
        "current_restored_by_attempt": False,
        "forward_restart_invocations": 0,
        "rollback_restart_invocations": 0,
    }
    write_ahead_journal(journal, "attempt_marker_pending", initial)
    consume_attempt_marker(Path(marker))
    state = write_ahead_journal(journal, "attempt_consumed")
    try:
        state = write_ahead_journal(journal, "installing", {"release_install_started_by_attempt": True})
        backend.install_existing_release(NEW_RELEASE_ID, NEW_SUMS_SHA256, NEW_MANIFEST_SHA256)
        state = write_ahead_journal(journal, "installed", {"release_owned_by_attempt": True})
        state = write_ahead_journal(journal, "switching_current", {"current_switch_started_by_attempt": True})
        backend.switch_current(OLD_RELEASE_ID, NEW_RELEASE_ID)
        state = write_ahead_journal(journal, "current_switched", {"current_owned_by_attempt": True})
        state = write_ahead_journal(journal, "core_restart_started", {"forward_restart_invocations": 1})
        backend.restart_core_once(NEW_RELEASE_ID)
        state = write_ahead_journal(journal, "core_restarted")
        result = backend.verify_new_core_and_preservation(facts["preserved_services"])
        if not result.get("detector_unchanged") or result.get("preserved_services") != facts["preserved_services"]:
            raise ICuRefused("ICU_POST_STATE_OR_PRESERVATION_MISMATCH")
        state = write_ahead_journal(journal, "complete")
        return state
    except Exception:
        state = write_ahead_journal(journal, "forward_failed")
        rollback(backend, state, journal)
        raise


def rollback(backend: Any, journal: dict[str, Any], journal_path: Path | None = None) -> None:
    """Restore only this attempt's exact OLD target; never issue Detector commands."""
    pins = _base_journal("ignored")
    if any(journal.get(key) != value for key, value in pins.items()
           if key not in JOURNAL_STATE_FIELDS and key != "phase"):
        raise ICuRefused("ICU_ROLLBACK_JOURNAL_NOT_OWNED")
    if journal.get("rollback_restart_invocations") != 0:
        raise ICuRefused("ICU_ROLLBACK_RESTART_ALREADY_USED")
    if journal.get("phase") != "forward_failed":
        raise ICuRefused("ICU_ROLLBACK_PHASE_REFUSED")
    if journal.get("forward_restart_invocations", 0) and not journal.get("current_owned_by_attempt"):
        raise ICuRefused("ICU_ROLLBACK_RESTART_WITHOUT_CURRENT_OWNERSHIP")
    if not backend.validate_rollback_preflight(OLD_RELEASE_ID):
        raise ICuRefused("ICU_EXACT_OLD_RELEASE_ROLLBACK_PREFLIGHT_FAILED")
    path = Path(journal_path) if journal_path else None

    def record(phase: str, **changes: Any) -> None:
        journal.update(changes)
        if path is not None:
            updated = write_ahead_journal(
                path, phase, {key: journal[key] for key in JOURNAL_STATE_FIELDS if key in journal}
            )
            journal.clear()
            journal.update(updated)
        else:
            journal["phase"] = phase

    current_owned = journal.get("current_owned_by_attempt") is True
    switch_started = journal.get("current_switch_started_by_attempt") is True
    current_release = backend.current_release_id()
    if current_release == NEW_RELEASE_ID and (current_owned or switch_started):
        if not journal.get("release_owned_by_attempt"):
            raise ICuRefused("ICU_ROLLBACK_CURRENT_NOT_OWNED")
        record("rollback_switching_current")
        backend.switch_current(NEW_RELEASE_ID, OLD_RELEASE_ID)
        changes = {"current_restored_by_attempt": True}
        if not current_owned:
            changes["current_owned_by_attempt"] = True
        record("rollback_current_restored", **changes)
    else:
        if current_release != OLD_RELEASE_ID or (current_owned and not journal.get("current_restored_by_attempt")):
            raise ICuRefused("ICU_ROLLBACK_CURRENT_NOT_OLD")
        record("rollback_no_pointer_change")
    if journal.get("forward_restart_invocations", 0) > 0:
        record("rollback_core_restart_started", rollback_restart_invocations=1)
        backend.restart_core_once(OLD_RELEASE_ID)
        record("rollback_core_restarted")
    if not backend.verify_rollback_and_preservation(OLD_RELEASE_ID):
        raise ICuRefused("ICU_ROLLBACK_VERIFICATION_FAILED")
    record("rolled_back")


def _main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    marker = commands.add_parser("consume-marker")
    marker.add_argument("--path", required=True, type=Path)
    journal = commands.add_parser("journal")
    journal.add_argument("--path", required=True, type=Path)
    journal.add_argument("--phase", required=True)
    journal.add_argument("--set", action="append", default=[])
    journal_assert = commands.add_parser("assert-journal")
    journal_assert.add_argument("--path", required=True, type=Path)
    journal_assert.add_argument("--phase", required=True)
    check = commands.add_parser("check-release")
    check.add_argument("--path", required=True, type=Path)
    check.add_argument("--release-id", required=True)
    check.add_argument("--source-main")
    check.add_argument("--sums-sha256", required=True)
    check.add_argument("--manifest-sha256", required=True)
    commands.add_parser("unit-snapshot")
    args = parser.parse_args()
    try:
        if args.command == "consume-marker":
            consume_attempt_marker(args.path)
        elif args.command == "journal":
            allowed = JOURNAL_STATE_FIELDS - {"preflight"}
            state: dict[str, Any] = {}
            for item in args.set:
                key, sep, value = item.partition("=")
                if not sep or key not in allowed:
                    raise ICuRefused("ICU_JOURNAL_FIELD_REFUSED")
                if key.endswith("_invocations"):
                    if value not in {"0", "1"}:
                        raise ICuRefused("ICU_JOURNAL_COUNTER_INVALID")
                    state[key] = int(value)
                elif key.endswith("_by_attempt") and value in {"true", "false"}:
                    state[key] = value == "true"
                else:
                    raise ICuRefused("ICU_JOURNAL_BOOLEAN_INVALID")
            write_ahead_journal(args.path, args.phase, state)
        elif args.command == "assert-journal":
            data = read_journal(args.path)
            if data.get("phase") != args.phase:
                raise ICuRefused("ICU_JOURNAL_PHASE_REFUSED")
        elif args.command == "check-release":
            check_release(args.path, args.release_id, args.source_main, args.sums_sha256, args.manifest_sha256)
        elif args.command == "unit-snapshot":
            print(f"ICU_UNIT_SNAPSHOT_SHA256={unit_snapshot_sha256()}")
            return 0
        print("ICU_TOOL=PASS")
        return 0
    except ICuRefused as exc:
        print(f"ICU_TOOL=FAIL reason={exc}")
        return 1


if __name__ == "__main__":
    raise SystemExit(_main())
