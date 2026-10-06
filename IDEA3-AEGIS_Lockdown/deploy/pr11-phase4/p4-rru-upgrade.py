#!/usr/bin/env python3
"""RRu governed Recovery-PREPARATION release deployment: install ONE new immutable release that also carries ``aegis_soc/cli.py`` and switch ``current`` OLD -> NEW (repository tooling; authorizes nothing live).

Stage order: ... -> R1Du -> R1D (immutable FAIL) -> R1Dv -> R1B (immutable FAIL) -> R1Bv (PASS) -> RRu -> Recovery R2-R8 -> LVR -> L8 -> L9.

Why RRu exists: the merged Recovery D4 executes ``<release>/venv/bin/python -B -s -m aegis_soc.cli restore ...`` and its release-closure gate requires ``aegis_soc/cli.py`` to be a manifested entry of the CURRENT
immutable release. The release that Production runs (built before ``cli`` was a release entrypoint) cannot satisfy that, and an immutable release is never edited. RRu is therefore a NEW governed maintenance
stage (not a retry or replay of F1i, F1r, F1u or R1Du, which are consumed forever): it installs the successor release built by the corrected deterministic builder and switches ``current`` to it, once.

What RRu does NOT do (by construction, enforced by the backend allow-list and the tests): it never restarts, stops, starts or reloads ANY unit (the backend is the read-only F1i allow-list; the Core and the detector
keep their exact process identity), never edits core.env, credentials, units, drop-ins, tmpfiles, firewall, network, broker, IDEA1/IDEA2, never touches an incident, the audit/protocol databases, R1I, the R1B/R1Bv
evidence or the Recovery marker, never runs ISOLATE/RESTORE/CLOSE, injects no alert and never touches the ESP32. It proves ONLY ``RECOVERY_RUNTIME_RELEASE_READY``.

Why no restart is needed (and how that is PROVEN, not assumed): the running Core executes from the OLD release. The NEW release must be Core-equivalent to it: same manifest facts (schema, python version,
requirements digest), the file set of OLD plus EXACTLY ``aegis_soc/cli.py`` (nothing else added or removed), every shared payload digest identical (venv, interpreter, every ``aegis_soc`` module incl. the detector and
the Core runtime, requirements) and only the manifest identity fields differing. No other module imports ``cli``. Anything else fails closed before anything is installed.

Post-R1D terminal surface: RRu runs only after the committed one-shot R1D disposition. That successful disposition closes and unlinks
``historical-disposition.sock``, while the unchanged running Core still carries ``AEGIS_R1D_DISPOSITION_ENABLED=YES`` from R1Du. RRu therefore requires the historical-disposition socket to remain ABSENT,
requires the persisted arming value to remain YES, and continues to require the Recovery and alert sockets plus the alert-uid contract to be served by that exact Core process. RRu never recreates, reconnects to or
repairs the terminal R1D authority.

Rollback is journal-driven and bounded to what this stage owns: ``current`` back to OLD and removal of ONLY the release this attempt installed (ownership = a journaled tree digest, re-proved). It never restarts
anything, so the Core and detector are verified to be EXACTLY as at preflight on every path (the rollback class is always EXACT_PROCESS).
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path

HERE = Path(__file__).resolve().parent


def _load(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"{filename}_MISSING")
    module = importlib.util.module_from_spec(spec)
    sys.modules.setdefault(name, module)
    spec.loader.exec_module(module)
    return module


R1DU = _load("p4_r1du_upgrade", "p4-r1du-upgrade.py")  # reviewed read-only state proofs (Core, detector, Recovery/alert surfaces), the host class and the shared constants
F1I = R1DU.F1I
F1R = R1DU.F1R
Refusal = R1DU.Refusal
refuse = R1DU.refuse
CommandResult = R1DU.CommandResult

OPT_DIR = R1DU.OPT_DIR
RELEASES_DIR = R1DU.RELEASES_DIR
CURRENT = R1DU.CURRENT
TMP_LINK = f"{OPT_DIR}/.current.rru-tmp"
CLI_REL = "aegis_soc/cli.py"
JOURNAL_NAME = "rru-journal.json"
SHA256_RE = R1DU.SHA256_RE
MANIFEST_NAME, SUMS_NAME = R1DU.MANIFEST_NAME, R1DU.SUMS_NAME
MANIFEST_IDENTITY_FIELDS = R1DU.MANIFEST_IDENTITY_FIELDS

UNOWNED_PHASES = ("installing", "installer_failed")  # no durable proof a release was installed: NEVER deletion authority
SWITCH_PHASES = ("switching", "switched", "applied")  # `current` may point at NEW
OWNED_PHASES = ("installed", *SWITCH_PHASES)  # the release is ours (journaled tree digest)
KNOWN_PHASES = ("preflight", *UNOWNED_PHASES, *OWNED_PHASES, "rolled_back")


def release_path(rid: str) -> str:
    return f"{RELEASES_DIR}/{rid}"


@dataclass(frozen=True)
class Pins(R1DU.Pins):
    cli_sha: str = ""


def validate_pins(pins: Pins) -> None:
    R1DU.validate_pins(pins)
    if not SHA256_RE.fullmatch(pins.cli_sha):
        refuse("RESTORE_CLI_SHA256_PIN_INVALID")


def pins_from_journal(journal: dict, source_dir: str = "/unused") -> Pins:
    return Pins(journal["old_release_id"], journal["new_release_id"], source_dir, journal["source_sha"], journal["detector_sha"], journal["core_sha"], journal["unit_sha"], journal["cli_sha"])


# ── the only privileged surface ──────────────────────────────────────────────────────────────────────────────────────────────


class RRuBackend(F1I.F1iBackend):
    """Inherited UNCHANGED: read-only ``systemctl show`` of the Core/detector units and the ONE reviewed-installer process. No restart, start, stop, reload, kill, enable or job-mode option exists in the
    allow-list, so RRu cannot restart the Core or touch the detector by construction (unlike R1Du/F1u there is NO ``RESTART_ARGS``)."""

    def sleep(self, seconds: float) -> None:  # kept for interface parity with the reused state proofs; RRu never waits for a restart
        return None


class RRuHost(R1DU.R1DuHost):
    """R1DuHost (pointer switch + read-only process/socket/identity proofs). core.env arm/unarm helpers exist on the parent but are NEVER called here."""


# ── release proofs ───────────────────────────────────────────────────────────────────────────────────────────────────────────


def check_cli(host, release_dir: str, cli_sha: str) -> None:
    """``aegis_soc/cli.py`` exists, is exactly the pinned reviewed bytes and is a manifested entry of the release's own RELEASE-SHA256SUMS (the exact line the Recovery release-closure gate greps for)."""
    path = f"{release_dir}/{CLI_REL}"
    if not host.is_regular(path):
        refuse("RESTORE_CLI_FILE_INVALID")
    if host.sha256_file(path) != cli_sha:
        refuse("RESTORE_CLI_SHA256_MISMATCH")
    if R1DU._release_sums(host, release_dir).get(CLI_REL) != cli_sha:
        refuse("RESTORE_CLI_NOT_A_MANIFESTED_ENTRY")


def check_source_release(host, pins: Pins) -> None:
    R1DU.check_source_release(host, pins)
    check_cli(host, pins.source_dir, pins.cli_sha)


def check_installed_release(host, pins: Pins) -> None:
    R1DU.check_installed_release(host, pins)
    check_cli(host, release_path(pins.new_id), pins.cli_sha)


def successor_equivalence(host, old_path: str, new_path: str) -> list[str]:
    """MACHINE proof that ``new_path`` equals ``old_path`` plus exactly ``aegis_soc/cli.py`` (see the module docstring). ``new_path`` may be the user-owned builder output (pre-install) or the installed release:
    both pass the existing guard for their owner before this runs; here only the manifests and RELEASE-SHA256SUMS are compared. Returns the entries NEW adds (always ``[cli.py]``)."""
    try:
        old_manifest = json.loads(host.read_bytes(f"{old_path}/{MANIFEST_NAME}"))
        new_manifest = json.loads(host.read_bytes(f"{new_path}/{MANIFEST_NAME}"))
    except (OSError, ValueError):
        refuse("SUCCESSOR_NOT_EQUIVALENT:MANIFEST_UNREADABLE")
    if not isinstance(old_manifest, dict) or not isinstance(new_manifest, dict):
        refuse("SUCCESSOR_NOT_EQUIVALENT:MANIFEST_UNREADABLE")
    for field in sorted(set(old_manifest) | set(new_manifest)):
        if field in MANIFEST_IDENTITY_FIELDS:
            continue
        if field == "file_count":
            if new_manifest.get(field) != old_manifest.get(field, -1) + 1:
                refuse("SUCCESSOR_NOT_EQUIVALENT:MANIFEST_file_count")
        elif old_manifest.get(field) != new_manifest.get(field):
            refuse(f"SUCCESSOR_NOT_EQUIVALENT:MANIFEST_{field}")
    # the manifest itself is a listed payload entry whose bytes legitimately differ (identity fields, file_count): it was compared field by field above, so it is the ONE entry excluded from the digest comparison
    old_sums = {k: v for k, v in R1DU._release_sums(host, old_path).items() if k != MANIFEST_NAME}
    new_sums = {k: v for k, v in R1DU._release_sums(host, new_path).items() if k != MANIFEST_NAME}
    added = sorted(set(new_sums) - set(old_sums))
    if added != [CLI_REL] or set(old_sums) - set(new_sums):
        refuse("SUCCESSOR_NOT_EQUIVALENT:FILE_SET")  # exactly OLD + cli.py: nothing else added, nothing removed
    for rel in sorted(old_sums):
        if old_sums[rel] != new_sums[rel]:
            refuse(f"SUCCESSOR_NOT_EQUIVALENT:FILE_DIFFERS:{rel}")  # venv, interpreter, every module (Core runtime, detector, requirements) byte-identical
    for rel in sorted(new_sums):
        if rel.startswith("aegis_soc/") and rel.endswith(".py") and rel != CLI_REL and re.search(rb"(?m)^\s*(from\s+(\.|aegis_soc)\s*import\s+[^\n]*\bcli\b|from\s+(\.|aegis_soc\.)cli\b|import\s+aegis_soc\.cli\b)", host.read_bytes(f"{new_path}/{rel}")):
            refuse("SUCCESSOR_NOT_EQUIVALENT:CLI_IMPORTED_BY_ANOTHER_MODULE")
    return added


# ── state invariants ─────────────────────────────────────────────────────────────────────────────────────────────────────────


def core_unchanged(host, backend, journal: dict) -> dict:
    """The SAME Core process (MainPID, NRestarts, start timestamp, cwd = the release it started from) and the SAME detector (every recorded field), healthy. RRu never restarts anything: any drift fails closed."""
    now = R1DU.core_state(host, backend)
    pre = journal["core"]
    if not R1DU.core_healthy(now) or any(now[k] != pre[k] for k in ("MainPID", "NRestarts", "ExecMainStartTimestamp", "cwd")):
        refuse("CORE_RESTARTED_OR_REPLACED")
    R1DU.detector_unchanged(host, backend, journal["detector"])
    return now


def post_r1d_surfaces(host, core_pid: int) -> None:
    """Validate the terminal post-R1D runtime without weakening R1Du's historical pre-disposition contract.

    Recovery and alert transports remain live and Core-owned. The one-shot historical-disposition socket, however, must be gone after the
    committed disposition; the unchanged Core process still carries the R1Du arming environment value that established the original authority.
    """
    R1DU.check_surfaces(host, core_pid, armed=False)  # validates Recovery/alert + alert uid and requires the R1D socket to be absent
    if host.proc_environ_value(core_pid, R1DU.ARM_KEY) != "YES":
        refuse("CORE_RUNNING_WITHOUT_R1D_ARMING")


def surfaces_and_material(host, journal: dict, pid: int) -> None:
    post_r1d_surfaces(host, pid)
    if not R1DU.material_matches(F1I.material_metadata(host), journal["material"]):
        refuse("MATERIAL_METADATA_DRIFT")  # core.env and the credentials are byte-metadata IDENTICAL: RRu owns no edit of them


# ── journal ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────


def write_journal(work: Path, data: dict) -> None:
    """Atomic, fsynced, written BEFORE each mutation so rollback never has to guess what was done."""
    tmp = work / (JOURNAL_NAME + ".tmp")
    blob = json.dumps(data, sort_keys=True).encode()
    descriptor = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "wb") as handle:
        handle.write(blob)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp, work / JOURNAL_NAME)


def read_journal(work: Path) -> dict | None:
    path = work / JOURNAL_NAME
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        refuse("JOURNAL_UNREADABLE")
    if not isinstance(data, dict) or data.get("stage") != "RRu":
        refuse("JOURNAL_UNEXPECTED")
    return data


# ── preflight (read-only) ────────────────────────────────────────────────────────────────────────────────────────────────────


def preflight(host, backend, pins: Pins) -> dict:
    """Every pre-mutation gate. Returns the non-secret facts the journal records. Mutates nothing, restarts nothing and creates no alert."""
    validate_pins(pins)
    F1I.check_parents(host)
    old_target = F1I.check_current_expected(host, pins.old_id)
    R1DU.check_old_release(host, pins)
    F1I.check_target_absent(host, pins.new_id)
    if host.lexists(TMP_LINK):
        refuse("SWITCH_TEMP_EXISTS")
    check_source_release(host, pins)
    old_path = release_path(pins.old_id)
    core = R1DU.core_state(host, backend)
    if not R1DU.core_healthy(core):
        refuse("CORE_PRESTATE_NOT_HEALTHY")
    if core["cwd"] != old_path:
        refuse("CORE_NOT_RUNNING_FROM_CURRENT_OLD_RELEASE")  # RRu never restarts the Core, so the running release must BE the one `current` points at
    successor_equivalence(host, old_path, pins.source_dir)  # the release about to be installed is OLD + cli.py and nothing else: the running Core stays correct without a restart
    detector = R1DU.detector_state(host, backend)
    R1DU.check_detector_pre(detector, pins)
    post_r1d_surfaces(host, int(core["MainPID"]))
    return {"old_target": old_target, "new_target": release_path(pins.new_id), "core": core, "detector": detector, "material": F1I.material_metadata(host),
            "old_release_tree_digest": host.tree_digest(old_path)}


# ── apply ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────


def _atomic_point(host, target: str) -> None:
    """symlink to ``target`` at the temp name, rename it over ``current``, fsync the directory. ``current`` is never absent."""
    host.symlink(target, TMP_LINK)
    host.replace(TMP_LINK, CURRENT)
    host.fsync_dir(OPT_DIR)


def _current_is(host, target: str) -> bool:
    return host.is_symlink(CURRENT) and host.readlink(CURRENT) == target and host.realpath(CURRENT) == target


def apply(pins: Pins, work: Path, host, backend) -> dict[str, str]:
    """preflight -> journal -> re-prove -> installer ONCE -> equivalence -> journal -> switch ONCE -> journal -> Core/detector unchanged proofs -> journal. No restart, no retry."""
    if read_journal(work) is not None:
        refuse("ATTEMPT_JOURNAL_ALREADY_EXISTS")  # one attempt per work directory
    facts = preflight(host, backend, pins)
    journal = {"stage": "RRu", "phase": "preflight", "old_release_id": pins.old_id, "new_release_id": pins.new_id, "source_sha": pins.source_sha, "detector_sha": pins.detector_sha,
               "core_sha": pins.core_sha, "unit_sha": pins.unit_sha, "cli_sha": pins.cli_sha, **facts}
    write_journal(work, journal)  # the exact prestate is on disk before anything changes
    target = facts["new_target"]
    try:
        before_content = F1I.material_content(host)  # secret CONTENT stays in this process's memory only
        F1I.check_target_absent(host, pins.new_id)
        F1I.check_current_expected(host, pins.old_id)
        core_unchanged(host, backend, journal)
        journal["phase"] = "installing"
        write_journal(work, journal)  # BEFORE the installer: from here a release may exist and is ours
        result = backend.run_installer(pins.new_id, pins.source_dir, target, str(work / "install-evidence.tsv"))
        if result.rc != 0:
            match = F1I.REASON_RE.search(result.out or "")
            reason = match.group(1) if match and F1I.SAFE_REASON_RE.fullmatch(match.group(1)) else "UNKNOWN"
            journal.update(phase="installer_failed", installer_rc=int(result.rc), installer_reason=reason)
            write_journal(work, journal)  # a failure is evidence, never ownership
            refuse(f"INSTALL_FAILED:{reason}")
        check_installed_release(host, pins)
        successor_equivalence(host, release_path(pins.old_id), target)  # re-proved on the INSTALLED (root-owned) tree
        journal.update(phase="installed", release_tree_digest=host.tree_digest(target))
        write_journal(work, journal)
        F1I.check_current_expected(host, pins.old_id)
        core_unchanged(host, backend, journal)
        if host.lexists(TMP_LINK):
            refuse("SWITCH_TEMP_EXISTS")  # never adopt a name this attempt did not create
        journal["phase"] = "switching"
        write_journal(work, journal)  # BEFORE the switch
        _atomic_point(host, target)
        journal["phase"] = "switched"
        write_journal(work, journal)
        if not _current_is(host, target):
            refuse("CURRENT_NOT_NEW_TARGET_AFTER_SWITCH")
        core = core_unchanged(host, backend, journal)
        surfaces_and_material(host, journal, int(core["MainPID"]))
        if F1I.material_content(host) != before_content:
            refuse("MATERIAL_CONTENT_DRIFT")  # a fixed reason: no value, path or digest is ever printed
        del before_content
        journal["phase"] = "applied"
        write_journal(work, journal)
    except OSError as exc:
        refuse(f"IO:{type(exc).__name__}")
    return {"RRU_APPLY": "COMPLETE", "NEW_RELEASE_ID": pins.new_id, "CURRENT_TARGET": target, "OLD_TARGET": facts["old_target"], "RRU_CORE_RESTART_INVOCATIONS": "0",
            "RRU_EXPLICIT_DETECTOR_COMMANDS": "0"}


# ── verify (read-only) ───────────────────────────────────────────────────────────────────────────────────────────────────────


def verify(pins: Pins, work: Path, host, backend) -> dict[str, str]:
    journal = read_journal(work)
    if journal is None or journal.get("phase") != "applied":
        refuse("ATTEMPT_NOT_APPLIED")
    if pins_from_journal(journal, pins.source_dir) != pins:
        refuse("ATTEMPT_PINS_MISMATCH")
    new_target = journal["new_target"]
    if not _current_is(host, new_target):
        refuse("CURRENT_NOT_NEW_TARGET")
    if host.lexists(TMP_LINK):
        refuse("SWITCH_TEMP_EXISTS")
    check_installed_release(host, pins)
    if host.tree_digest(new_target) != journal["release_tree_digest"]:
        refuse("RELEASE_TREE_CHANGED")
    R1DU.check_old_release(host, pins)  # the OLD release still exists, unaltered and is still the Core's running release
    if host.tree_digest(release_path(pins.old_id)) != journal["old_release_tree_digest"]:
        refuse("OLD_RELEASE_TREE_CHANGED")
    successor_equivalence(host, release_path(pins.old_id), new_target)
    core = core_unchanged(host, backend, journal)
    surfaces_and_material(host, journal, int(core["MainPID"]))
    return {"RRU_VERIFY": "PASS", "CURRENT_TARGET": new_target, "NEW_RELEASE_GUARD": "PASS", "NEW_RELEASE_SOURCE_SHA": pins.source_sha, "RESTORE_CLI_SHA256": pins.cli_sha,
            "RESTORE_CLI_MANIFESTED": "YES", "NEW_RELEASE_IS_OLD_PLUS_CLI_ONLY": "YES", "CORE_RESTARTED": "NO", "CORE_PROCESS_UNCHANGED": "YES", "DETECTOR_PROCESS_UNCHANGED": "YES",
            "DETECTOR_UNIT_AND_SOURCE_UNCHANGED": "YES", "ALERT_SOCKET_SERVED_BY_CORE": "YES", "RECOVERY_SOCKET_SERVED_BY_CORE": "YES", "L7_MATERIAL_PRESERVED": "YES",
            "RECOVERY_RUNTIME_RELEASE_READY": "YES", "RRU_INCIDENT_MUTATED": "NO", "RRU_RECOVERY_EXECUTED": "NO"}


# ── rollback ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────


def rollback(work: Path, host, backend) -> dict[str, str]:
    """Undo ONLY what this attempt journalled: `current` back to OLD, then removal of ONLY the release this attempt installed. Nothing is ever restarted, so the Core and detector are proved EXACTLY as at preflight
    (class EXACT_PROCESS). A foreign pointer, release, temp link or process refuses before anything changes and is left exactly as found."""
    journal = read_journal(work)
    if journal is None or journal.get("phase") == "preflight":
        return {"RRU_ROLLBACK": "NOTHING_OWNED"}
    phase = journal.get("phase")
    if phase == "rolled_back":
        return {"RRU_ROLLBACK": "ALREADY_ROLLED_BACK"}
    if phase not in KNOWN_PHASES:
        refuse("JOURNAL_PHASE_UNKNOWN")  # fail closed on any state this tool did not write
    pins = pins_from_journal(journal)
    old_target, new_target = journal["old_target"], journal["new_target"]
    new_path = release_path(pins.new_id)
    if host.temp_residue(RELEASES_DIR, pins.new_id):
        refuse("INSTALL_TEMP_RESIDUE")
    if not host.is_symlink(CURRENT):
        refuse("CURRENT_NOT_A_SYMLINK")
    now = host.readlink(CURRENT)
    if now != old_target and not (phase in SWITCH_PHASES and now == new_target):
        refuse("CURRENT_NOT_OWNED_BY_THIS_ATTEMPT")  # another actor changed `current`: left exactly as found
    if host.lexists(TMP_LINK):
        if not (phase == "switching" and now == old_target and host.is_symlink(TMP_LINK) and host.readlink(TMP_LINK) == new_target):
            refuse("SWITCH_TEMP_NOT_OWNED_BY_THIS_ATTEMPT")
        host.unlink(TMP_LINK)
    try:
        if now == new_target:
            journal["rollback_step"] = "repointing"
            write_journal(work, journal)
            _atomic_point(host, old_target)
    except OSError as exc:
        refuse(f"IO:{type(exc).__name__}")
    if not _current_is(host, old_target):
        refuse("CURRENT_NOT_OLD_TARGET_AFTER_ROLLBACK")
    core_unchanged(host, backend, journal)  # nothing in RRu ever restarts the Core or the detector: any drift is foreign and escalates
    target_present = host.lexists(new_path)
    if phase in UNOWNED_PHASES:
        if target_present:
            refuse("INSTALL_OUTCOME_UNKNOWN" if phase == "installing" else "FOREIGN_OR_UNPROVEN_TARGET")  # never delete what this attempt cannot prove it installed
    elif phase in OWNED_PHASES and target_present:
        digest = journal.get("release_tree_digest")
        if not isinstance(digest, str) or not digest:
            refuse("JOURNAL_OWNERSHIP_UNPROVEN")
        if not host.is_real_dir(new_path):
            refuse("RELEASE_PATH_NOT_A_DIRECTORY")
        try:
            check_installed_release(host, pins)
        except Refusal as exc:
            refuse(f"RELEASE_DRIFTED_REFUSING_ROLLBACK:{exc}")
        if host.tree_digest(new_path) != digest:
            refuse("RELEASE_DRIFTED_REFUSING_ROLLBACK:TREE_DIGEST_MISMATCH")
        try:
            host.remove_release_tree(new_path)
        except OSError as exc:
            refuse(f"IO:{type(exc).__name__}")
        if host.lexists(new_path):
            refuse("RELEASE_RESIDUE")
    journal["phase"] = "rolled_back"
    write_journal(work, journal)
    F1I.check_parents(host)
    if not _current_is(host, old_target):
        refuse("CURRENT_NOT_OLD_TARGET_AFTER_ROLLBACK")
    R1DU.check_old_release(host, pins)
    if host.tree_digest(release_path(pins.old_id)) != journal["old_release_tree_digest"]:
        refuse("OLD_RELEASE_TREE_CHANGED")
    core = core_unchanged(host, backend, journal)
    surfaces_and_material(host, journal, int(core["MainPID"]))
    return {"RRU_ROLLBACK": "PASS", "RRU_ROLLBACK_CLASS": "EXACT_PROCESS", "RRU_ROLLBACK_EXACT_PRE_RESTORATION": "YES", "CURRENT_TARGET": old_target,
            "NEW_RELEASE_ABSENT": "YES" if not host.lexists(new_path) else "NO", "CORE_RESTARTED_FOR_ROLLBACK": "NO", "CORE_PROCESS_UNCHANGED": "YES", "DETECTOR_PROCESS_UNCHANGED": "YES"}


# ── CLI ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)

    def pin_args(sp, work: bool, source: bool) -> None:
        if work:
            sp.add_argument("--work-dir", required=True)
        sp.add_argument("--old-release-id", required=True)
        sp.add_argument("--new-release-id", required=True)
        sp.add_argument("--source-dir", required=source, default="/unused")
        sp.add_argument("--source-sha", required=True)
        sp.add_argument("--detector-sha256", required=True)
        sp.add_argument("--recovery-core-sha256", required=True)
        sp.add_argument("--detector-unit-sha256", required=True)
        sp.add_argument("--restore-cli-sha256", required=True)

    pin_args(sub.add_parser("check"), work=False, source=True)  # read-only preflight (run through sudo for root read authority); no live flag, no write, no alert
    pin_args(sub.add_parser("apply"), work=True, source=True)
    pin_args(sub.add_parser("verify"), work=True, source=False)
    sub.add_parser("rollback").add_argument("--work-dir", required=True)
    args = parser.parse_args(argv)
    label = "RRU_" + args.command.upper()
    try:
        host, backend = RRuHost(), RRuBackend()
        pins = None
        if args.command != "rollback":
            pins = Pins(args.old_release_id, args.new_release_id, args.source_dir, args.source_sha, args.detector_sha256, args.recovery_core_sha256, args.detector_unit_sha256,
                        args.restore_cli_sha256)
        if args.command == "check":
            facts = preflight(host, backend, pins)
            result = {"RRU_CHECK": "PASS", "CURRENT_TARGET": facts["old_target"], "NEW_RELEASE_ABSENT": "YES", "SOURCE_RELEASE_GUARD": "PASS", "SOURCE_IS_OLD_PLUS_CLI_ONLY": "YES",
                      "CORE_RUNNING_FROM_CURRENT": "YES", "DETECTOR_RUNNING_BASELINE": "YES", "ALERT_AND_RECOVERY_SURFACES": "SERVED_BY_CORE"}
        else:
            if os.environ.get("AEGIS_RRU_LIVE_AUTHORIZED") != "YES":
                refuse("LIVE_AUTHORIZATION_FLAG_REQUIRED")
            if os.geteuid() != 0:
                refuse("ROOT_REQUIRED")
            work = F1R.require_work_dir(args.work_dir)
            if args.command == "rollback":
                result = rollback(work, host, backend)
            elif args.command == "apply":
                result = apply(pins, work, host, backend)
            else:
                result = verify(pins, work, host, backend)
    except Refusal as exc:
        print(f"{label}=FAIL reason={exc}", file=sys.stderr)
        return 1
    except OSError as exc:
        print(f"{label}=FAIL reason=IO:{type(exc).__name__}", file=sys.stderr)
        return 1
    for key, value in result.items():
        print(f"{key}={value}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
