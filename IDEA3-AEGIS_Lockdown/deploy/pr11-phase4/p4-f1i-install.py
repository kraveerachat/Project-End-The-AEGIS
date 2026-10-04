#!/usr/bin/env python3
"""F1i governed post-L7 install of ONE already-built, reviewed immutable release: apply / verify / owned rollback (repository tooling; authorizes nothing live).

Stage order: L7 -> L7u -> L8p -> F1i (repaired immutable-release install) -> F1r (current-release activation) -> F1 -> Recovery R1-R8 -> LVR -> L8 -> L9.

Why F1i and not L6c: the historical L6c verifier is intentionally PRE-L7 (it requires /etc/aegis-idea3/credentials and core.env ABSENT and the Core unit not-found), which is false by
design on the current post-L7 Production host. L6c stays historically correct for a pre-L7 install and is NOT changed. F1i is explicitly POST-L7-aware: those surfaces are PRESERVED
pre-existing state, never required absent.

F1i owns exactly ONE persistent mutation: create /opt/aegis-idea3/releases/<release id> by calling the reviewed ``p4-l7-install-release.py`` exactly once (its release-copy predicates are
reused, not duplicated). It never creates /opt/aegis-idea3 or its releases parent, never touches ``current``, an old release, credentials, core.env, a unit, the Core, the detector, the
broker, Recovery, IDEA1/IDEA2 or an ESP32, and its privileged backend can only ``systemctl show`` the Core/detector units plus that one fixed installer argv.

Secrets: credentials and core.env are secret-metadata-only. Their CONTENT is compared in memory inside the single apply process and discarded; only metadata (type, mode, uid, gid, size,
mtime, ctime, inode - the same non-secret metadata the L0 capture already records) and a fixed boolean are ever journaled or printed. No content, no digest of content.

Ownership: a journal in the attempt's private work directory records the exact prestate BEFORE any mutation. Rollback acts only on that journal, removes ONLY the release this attempt
created and only after re-proving it is still exactly what was installed; unknown or foreign state fails closed. Output is fixed reason codes and non-secret identifiers only.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
import stat
import subprocess
import sys
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


F1R = _load("p4_f1r_switch", "p4-f1r-switch.py")  # reviewed primitives: Refusal, F1rHost/F1rBackend (read-only), release guard, detector absence, Core snapshot
Refusal = F1R.Refusal
refuse = F1R.refuse
CommandResult = F1R.CommandResult

OPT_DIR = "/opt/aegis-idea3"
RELEASES_DIR = f"{OPT_DIR}/releases"
CURRENT = f"{OPT_DIR}/current"
CORE_UNIT = F1R.CORE_UNIT
DETECTOR_UNIT = F1R.DETECTOR_UNIT
DETECTOR_REL = F1R.DETECTOR_REL
MANIFEST_REL = F1R.MANIFEST_REL
INSTALLER = HERE / "p4-l7-install-release.py"
MATERIAL_DIR = "/etc/aegis-idea3/credentials"
MATERIAL_FILE = "/etc/aegis-idea3/core.env"
JOURNAL_NAME = "f1i-journal.json"
INSTALL_TIMEOUT_SEC = 300.0
REASON_RE = re.compile(r"reason=(\S+)")
SAFE_REASON_RE = re.compile(r"[A-Za-z0-9_:.-]{1,80}")  # only a short fixed-looking token is ever persisted from the installer's output
#: Journal phases and what they MEAN for rollback (ownership is a strict state boundary; a valid-looking release is never proof of ownership):
#:   preflight / installing / installer_failed -> NEVER deletion authority (installing = INSTALL OUTCOME UNKNOWN; installer_failed = the installer reported failure)
#:   installed / applied                       -> owned ONLY together with a journaled release_tree_digest (written in the SAME durable write as phase=installed)
UNOWNED_PHASES = ("installing", "installer_failed")
OWNED_PHASES = ("installed", "applied")
TEMP_PREFIX = ".install-tmp-"


def release_path(rid: str) -> str:
    return f"{RELEASES_DIR}/{rid}"


# ── the only privileged surface ──────────────────────────────────────────────────────────────────────────────────────────────


class F1iBackend(F1R.F1rBackend):
    """Read-only ``systemctl show`` of the Core/detector units (inherited allow-list) plus ONE fixed process: the reviewed installer, at most once. There is no restart, start, stop,
    reload, enable or arbitrary command."""

    def __init__(self) -> None:
        super().__init__()
        self.installs = 0

    def run_installer(self, rid: str, source_dir: str, logical: str, evidence: str) -> CommandResult:
        if self.installs >= 1:
            refuse("INSTALLER_ALREADY_INVOKED")  # exactly one invocation, ever, per process; nothing retries
        if logical != release_path(F1R.release_id(rid)) or not os.path.isabs(source_dir) or not os.path.isabs(evidence):
            refuse("INSTALLER_ARGUMENTS_INVALID")
        self.installs += 1
        return self._run_installer([sys.executable, str(INSTALLER), "install", "--release-id", rid, "--source", source_dir, "--logical-path", logical, "--evidence", evidence])

    def _run_installer(self, argv: list[str]) -> CommandResult:
        try:
            done = subprocess.run(argv, capture_output=True, text=True, timeout=INSTALL_TIMEOUT_SEC, check=False)
        except subprocess.TimeoutExpired:
            return CommandResult(124, "L7_RELEASE_INSTALL=FAIL reason=TIMEOUT\n")
        return CommandResult(done.returncode, (done.stdout or "") + (done.stderr or ""))


class F1iHost(F1R.F1rHost):
    """Read helpers for the post-L7 preservation proofs plus the single owned removal. ``current`` can never be created, replaced or removed through this class."""

    def __init__(self, releases_dir: str = RELEASES_DIR) -> None:
        self.releases_dir = releases_dir

    # `current` is never touched: the inherited switch primitives are disabled here (defense in depth; the tool never calls them).
    def symlink(self, target: str, path: str) -> None:
        refuse("OPERATION_NOT_ALLOWED")

    def replace(self, src: str, dst: str) -> None:
        refuse("OPERATION_NOT_ALLOWED")

    def unlink(self, path: str) -> None:
        refuse("OPERATION_NOT_ALLOWED")

    def fsync_dir(self, path: str) -> None:
        refuse("OPERATION_NOT_ALLOWED")

    def is_real_dir(self, path: str) -> bool:
        info = self._lstat(path)
        return info is not None and stat.S_ISDIR(info.st_mode)

    def lstat_info(self, path: str) -> dict | None:
        info = self._lstat(path)
        if info is None:
            return None
        kind = "dir" if stat.S_ISDIR(info.st_mode) else "file" if stat.S_ISREG(info.st_mode) else "symlink" if stat.S_ISLNK(info.st_mode) else "other"
        return {"type": kind, "mode": stat.S_IMODE(info.st_mode), "uid": info.st_uid, "gid": info.st_gid, "size": info.st_size, "mtime_ns": info.st_mtime_ns,
                "ctime_ns": info.st_ctime_ns, "ino": info.st_ino}

    def listdir(self, path: str) -> list[str]:
        try:
            return sorted(os.listdir(path))
        except PermissionError:
            refuse("HOST_READ_DENIED")
            raise  # unreachable
        except (FileNotFoundError, NotADirectoryError):
            return []

    def temp_residue(self, releases_dir: str, rid: str) -> list[str]:
        return [name for name in self.listdir(releases_dir) if name.startswith(f"{TEMP_PREFIX}{rid}-")]

    def release_guard_as(self, logical: str, host_path: str, owner: str) -> tuple[str, str]:
        """The existing, reviewed release guard, in-process. Returns (release_id, source_git_sha)."""
        self._lstat(host_path)  # a denied read must surface as HOST_READ_DENIED, not as "missing release"
        guard = F1R._load_guard()
        try:
            return guard.check(logical, Path(host_path), owner)
        except guard.Refusal as exc:
            refuse(f"RELEASE_GUARD:{exc}")
            raise  # unreachable

    def tree_digest(self, path: str) -> str:
        """The reviewed tree-state digest (the same one the L0 capture records in the release catalog): paths, types, modes, owners and file bytes. Non-secret."""
        module = _load("p4_l6c_tree_digest", "p4-l6c-tree-digest.py")
        try:
            return module.tree_state_digest(Path(path))
        except PermissionError:
            refuse("HOST_READ_DENIED")
            raise  # unreachable
        except (OSError, SystemExit, ValueError):
            refuse("TREE_DIGEST_FAILED")
            raise  # unreachable

    def remove_release_tree(self, path: str) -> None:
        """Remove ONLY an exact release directory directly under the releases directory. The whole tree is scanned FIRST: a symlink or special file anywhere inside refuses before a
        single byte is deleted. Never follows a symlink, never removes the releases directory, /opt/aegis-idea3, `current` or anything else."""
        if not isinstance(path, str) or not os.path.isabs(path) or os.path.dirname(path) != self.releases_dir or not F1R.RELEASE_ID_RE.fullmatch(os.path.basename(path)):
            refuse("RELEASE_REMOVE_PATH_NOT_OWNED")
        info = self._lstat(path)
        if info is None or not stat.S_ISDIR(info.st_mode):
            refuse("RELEASE_PATH_NOT_A_DIRECTORY")
        entries: list[tuple[str, bool]] = []

        def scan(node: str) -> None:
            meta = os.lstat(node)
            if stat.S_ISDIR(meta.st_mode):
                for name in sorted(os.listdir(node)):
                    scan(os.path.join(node, name))
                entries.append((node, True))
            elif stat.S_ISREG(meta.st_mode):
                entries.append((node, False))
            else:
                refuse("RELEASE_TREE_UNSAFE")  # symlink / special file

        try:
            scan(path)
            for node, is_dir in entries:
                os.rmdir(node) if is_dir else os.unlink(node)
        except PermissionError:
            refuse("HOST_READ_DENIED")


# ── module-level wrappers (the call sites are patched by the tests) ────────────────────────────────────────────────────────────


def core_snapshot(host, backend) -> dict[str, str]:
    return F1R.core_snapshot(host, backend)


def detector_absent(host, backend) -> None:
    F1R.detector_absent(host, backend)


def check_parents(host) -> None:
    for path in (OPT_DIR, RELEASES_DIR):
        if not host.is_real_dir(path):
            refuse("PARENT_DIRECTORY_MISSING")  # F1i never creates /opt/aegis-idea3 or its releases directory; post-L7 Production already has both


def check_current_expected(host, current_id: str) -> str:
    """`current` is an existing symlink whose target STRING is exactly the frozen expected release path (never "resolves to")."""
    if not host.lexists(CURRENT):
        refuse("CURRENT_MISSING")
    if not host.is_symlink(CURRENT):
        refuse("CURRENT_NOT_A_SYMLINK")
    target = host.readlink(CURRENT)
    if target != release_path(current_id):
        refuse("CURRENT_NOT_EXPECTED_TARGET")
    return target


def check_current_release(host, current_id: str) -> None:
    path = release_path(current_id)
    try:
        rid, _ = host.release_guard(path, path)
    except Refusal as exc:
        refuse(f"CURRENT_RELEASE_INVALID:{exc}")
    if rid != current_id:
        refuse("CURRENT_RELEASE_INVALID:RELEASE_ID_MISMATCH")


def check_target_absent(host, rid: str) -> None:
    if host.lexists(release_path(rid)):
        refuse("TARGET_RELEASE_ALREADY_EXISTS")
    if host.temp_residue(RELEASES_DIR, rid):
        refuse("INSTALL_TEMP_RESIDUE")


def check_release_facts(host, release_dir: str, guard_result: tuple[str, str], rid: str, source_sha: str, detector_sha: str) -> None:
    """The guard-reported id, the manifest id, the source SHA (both), a clean source tree and the EXACT production_detector.py bytes (digest) of ``release_dir``."""
    guard_id, guard_sha = guard_result
    if guard_id != rid:
        refuse("RELEASE_ID_MISMATCH")
    try:
        data = json.loads(host.read_bytes(f"{release_dir}/{MANIFEST_REL}"))
    except (OSError, ValueError, KeyError):
        refuse("RELEASE_MANIFEST_UNREADABLE")
    if not isinstance(data, dict):
        refuse("RELEASE_MANIFEST_UNREADABLE")
    if data.get("release_id") != rid:
        refuse("RELEASE_ID_MISMATCH")
    if guard_sha != source_sha or data.get("source_git_sha") != source_sha:
        refuse("RELEASE_SOURCE_SHA_MISMATCH")
    if data.get("source_tree_dirty") is not False:
        refuse("RELEASE_SOURCE_TREE_DIRTY")
    detector = f"{release_dir}/{DETECTOR_REL}"
    if not host.is_regular(detector):
        refuse("DETECTOR_FILE_INVALID")
    if host.sha256_file(detector) != detector_sha:
        refuse("DETECTOR_SHA256_MISMATCH")


def check_source_release(host, source_dir: str, rid: str, source_sha: str, detector_sha: str) -> None:
    """The builder output passes the existing release guard (--expect-owner any, as the user-owned staging requires) with the exact id, source SHA and detector bytes."""
    try:
        result = host.release_guard_as(release_path(rid), source_dir, "any")
    except Refusal as exc:
        refuse(f"SOURCE_RELEASE_INVALID:{exc}")
    check_release_facts(host, source_dir, result, rid, source_sha, detector_sha)


def check_installed_release(host, rid: str, source_sha: str, detector_sha: str) -> None:
    path = release_path(rid)
    if not host.is_real_dir(path):
        refuse("RELEASE_PATH_NOT_A_DIRECTORY")
    result = host.release_guard(path, path)  # root-owned, as installed
    check_release_facts(host, path, result, rid, source_sha, detector_sha)


# ── the post-L7 material: PRESERVED, metadata only ─────────────────────────────────────────────────────────────────────────────


def material_metadata(host) -> dict[str, dict]:
    """Non-secret metadata of core.env and every entry under the credentials directory. Both must exist (this is a post-L7 stage). Never reads content."""
    snapshot: dict[str, dict] = {}
    info = host.lstat_info(MATERIAL_FILE)
    if info is None or info["type"] != "file":
        refuse("MATERIAL_MISSING")
    snapshot[MATERIAL_FILE] = info
    root = host.lstat_info(MATERIAL_DIR)
    if root is None or root["type"] != "dir":
        refuse("MATERIAL_MISSING")

    def walk(path: str, meta: dict) -> None:
        snapshot[path] = meta
        if meta["type"] == "dir":
            for name in host.listdir(path):
                child = f"{path}/{name}"
                child_meta = host.lstat_info(child)
                if child_meta is None:
                    refuse("MATERIAL_METADATA_DRIFT")
                walk(child, child_meta)

    walk(MATERIAL_DIR, root)
    return snapshot


def material_content(host) -> dict[str, bytes]:
    """Secret content, held in THIS process's memory only (compared and discarded inside apply); never journaled, hashed, printed or written."""
    out: dict[str, bytes] = {}
    for path, meta in material_metadata(host).items():
        if meta["type"] == "file":
            out[path] = host.read_bytes(path)
    return out


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
    if not isinstance(data, dict) or data.get("stage") != "F1i":
        refuse("JOURNAL_UNEXPECTED")
    return data


# ── preflight (read-only) ────────────────────────────────────────────────────────────────────────────────────────────────────


def _valid_source_dir(source_dir: str) -> str:
    if not isinstance(source_dir, str) or not os.path.isabs(source_dir) or ".." in source_dir.split("/") or source_dir.startswith(OPT_DIR):
        refuse("SOURCE_DIR_INVALID")
    return source_dir


def preflight(host, backend, current_id: str, rid: str, source_dir: str, source_sha: str, detector_sha: str) -> dict:
    """Every pre-mutation gate. Returns the non-secret facts the journal records. Mutates nothing."""
    F1R.release_id(current_id)
    F1R.release_id(rid)
    if current_id == rid:
        refuse("RELEASE_IDS_NOT_DISTINCT")
    F1R.source_sha_pin(source_sha)
    F1R.detector_sha_pin(detector_sha)
    _valid_source_dir(source_dir)
    check_parents(host)
    current_target = check_current_expected(host, current_id)
    check_current_release(host, current_id)
    check_target_absent(host, rid)
    check_source_release(host, source_dir, rid, source_sha, detector_sha)
    detector_absent(host, backend)
    core = core_snapshot(host, backend)
    return {"current_target": current_target, "core_main_pid": core["core_main_pid"], "core_n_restarts": core["core_n_restarts"], "material": material_metadata(host)}


# ── apply ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────


def apply(current_id: str, rid: str, source_dir: str, source_sha: str, detector_sha: str, work: Path, host, backend) -> dict[str, str]:
    """preflight -> journal -> re-prove target/current/Core -> journal -> installer ONCE -> verify the install -> journal -> in-process preservation proofs -> journal. No retry."""
    if read_journal(work) is not None:
        refuse("ATTEMPT_JOURNAL_ALREADY_EXISTS")  # one attempt per work directory
    facts = preflight(host, backend, current_id, rid, source_dir, source_sha, detector_sha)
    journal = {"stage": "F1i", "phase": "preflight", "current_release_id": current_id, "release_id": rid, "source_sha": source_sha, "detector_sha": detector_sha, **facts,
               "material_content_preserved": False}
    write_journal(work, journal)  # the exact prestate is on disk before anything changes
    target = release_path(rid)
    try:
        # secret CONTENT stays in this process's memory only: compared after the installer, then discarded; only a fixed boolean is ever persisted
        before_content = material_content(host)
        check_target_absent(host, rid)  # re-proved immediately before the installer call
        check_current_expected(host, current_id)
        again = core_snapshot(host, backend)
        if again["core_main_pid"] != facts["core_main_pid"] or again["core_n_restarts"] != facts["core_n_restarts"]:
            refuse("CORE_RESTARTED_OR_REPLACED")
        detector_absent(host, backend)
        journal["phase"] = "installing"
        write_journal(work, journal)  # BEFORE the installer: from here a release may exist and is ours
        result = backend.run_installer(rid, source_dir, target, str(work / "install-evidence.tsv"))
        if result.rc != 0:
            match = REASON_RE.search(result.out or "")
            reason = match.group(1) if match and SAFE_REASON_RE.fullmatch(match.group(1)) else "UNKNOWN"
            # persist the installer's verdict BEFORE raising: a failure (even RELEASE_ALREADY_INSTALLED) is evidence, never ownership; no arbitrary output is recorded
            journal.update(phase="installer_failed", installer_rc=int(result.rc), installer_reason=reason)
            write_journal(work, journal)
            refuse(f"INSTALL_FAILED:{reason}")
        check_installed_release(host, rid, source_sha, detector_sha)
        journal.update(phase="installed", release_tree_digest=host.tree_digest(target))
        write_journal(work, journal)
        check_current_expected(host, current_id)  # `current` is byte-for-byte the same pointer
        after = core_snapshot(host, backend)
        if after["core_main_pid"] != facts["core_main_pid"] or after["core_n_restarts"] != facts["core_n_restarts"]:
            refuse("CORE_RESTARTED_OR_REPLACED")
        detector_absent(host, backend)
        if material_metadata(host) != facts["material"]:
            refuse("MATERIAL_METADATA_DRIFT")
        if material_content(host) != before_content:
            refuse("MATERIAL_CONTENT_DRIFT")  # a fixed reason: no value, path or digest is ever printed
        del before_content
        journal.update(phase="applied", material_content_preserved=True)
        write_journal(work, journal)
    except OSError as exc:
        refuse(f"IO:{type(exc).__name__}")
    return {"F1I_APPLY": "COMPLETE", "RELEASE_ID": rid, "TARGET": target, "F1I_CURRENT_TOUCHED": "NO", "F1I_CORE_RESTARTED": "NO"}


# ── verify (read-only) ───────────────────────────────────────────────────────────────────────────────────────────────────────


def verify(current_id: str, rid: str, source_sha: str, detector_sha: str, work: Path, host, backend) -> dict[str, str]:
    """Post-L7 preservation proofs. It does NOT use the pre-L7 absence predicates: credentials, core.env and the Core unit are expected to exist, unchanged."""
    journal = read_journal(work)
    if journal is None or journal.get("phase") != "applied" or journal.get("material_content_preserved") is not True:
        refuse("ATTEMPT_NOT_APPLIED")
    if journal.get("current_release_id") != current_id or journal.get("release_id") != rid:
        refuse("ATTEMPT_PINS_MISMATCH")
    F1R.source_sha_pin(source_sha)
    F1R.detector_sha_pin(detector_sha)
    if not host.is_symlink(CURRENT) or host.readlink(CURRENT) != journal["current_target"]:
        refuse("CURRENT_CHANGED")
    check_installed_release(host, rid, source_sha, detector_sha)
    if host.tree_digest(release_path(rid)) != journal["release_tree_digest"]:
        refuse("RELEASE_TREE_CHANGED")
    core = core_snapshot(host, backend)
    if core["core_main_pid"] != journal["core_main_pid"] or core["core_n_restarts"] != journal["core_n_restarts"]:
        refuse("CORE_RESTARTED_OR_REPLACED")
    if material_metadata(host) != journal["material"]:
        refuse("MATERIAL_METADATA_DRIFT")
    detector_absent(host, backend)
    return {"F1I_VERIFY": "PASS", "RELEASE_ID": rid, "NEW_RELEASE_GUARD": "PASS", "NEW_RELEASE_SOURCE_SHA": source_sha, "PRODUCTION_DETECTOR_SHA256": detector_sha,
            "RELEASE_TREE_UNCHANGED": "YES", "CURRENT_TARGET": journal["current_target"], "CURRENT_UNCHANGED": "YES", "CORE_MAIN_PID_UNCHANGED": "YES",
            "CORE_N_RESTARTS_UNCHANGED": "YES", "L7_MATERIAL_PRESERVED": "YES", "DETECTOR_PRESENT": "NO"}


# ── rollback ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────


def _postconditions(host, backend, journal: dict) -> None:
    try:
        core = core_snapshot(host, backend)
    except Refusal:
        refuse("CORE_DRIFT_DURING_ROLLBACK")
    if core["core_main_pid"] != journal["core_main_pid"] or core["core_n_restarts"] != journal["core_n_restarts"]:
        refuse("CORE_DRIFT_DURING_ROLLBACK")
    detector_absent(host, backend)
    if material_metadata(host) != journal["material"]:
        refuse("MATERIAL_METADATA_DRIFT")


def rollback(work: Path, host, backend) -> dict[str, str]:
    """Remove ONLY the release this attempt created, after re-proving it is still exactly what was installed. Never removes /opt/aegis-idea3, the releases directory, an old release,
    `current`, credentials, core.env, a unit or Recovery state. Unknown or foreign state => refusal BEFORE any removal (owner decision)."""
    journal = read_journal(work)
    if journal is None or journal.get("phase") == "preflight":
        return {"F1I_ROLLBACK": "NOTHING_OWNED"}  # no mutation was journalled
    if journal.get("phase") == "rolled_back":
        return {"F1I_ROLLBACK": "ALREADY_ROLLED_BACK"}
    phase = journal.get("phase")
    if phase not in UNOWNED_PHASES and phase not in OWNED_PHASES:
        refuse("JOURNAL_PHASE_UNKNOWN")  # fail closed on any state this tool did not write
    rid, current_id = journal["release_id"], journal["current_release_id"]
    target = release_path(rid)
    if not host.is_symlink(CURRENT) or host.readlink(CURRENT) != journal["current_target"]:
        refuse("CURRENT_CHANGED_AFTER_INSTALL")  # another actor repointed `current`: nothing is removed
    if host.temp_residue(RELEASES_DIR, rid):
        refuse("INSTALL_TEMP_RESIDUE")
    if phase in UNOWNED_PHASES:
        # No durable proof that THIS attempt installed anything. A release at the target path may be foreign (another root actor won the race and the installer then refused),
        # however valid it looks: it is NEVER deleted. Leaving possible residue and escalating is deliberately preferred over deleting a release this attempt did not install.
        if host.lexists(target):
            refuse("INSTALL_OUTCOME_UNKNOWN" if phase == "installing" else "FOREIGN_OR_UNPROVEN_TARGET")
        journal["phase"] = "rolled_back"
        write_journal(work, journal)
        _postconditions(host, backend, journal)
        return {"F1I_ROLLBACK": "NOTHING_OWNED"}
    expected_digest = journal.get("release_tree_digest")
    if not isinstance(expected_digest, str) or not expected_digest:
        refuse("JOURNAL_OWNERSHIP_UNPROVEN")  # installed/applied establish ownership only together with the journaled tree digest
    if not host.lexists(target):
        journal["phase"] = "rolled_back"  # the release this attempt installed is already gone: nothing left to remove
        write_journal(work, journal)
        _postconditions(host, backend, journal)
        return {"F1I_ROLLBACK": "NOTHING_OWNED"}
    if not host.is_real_dir(target):
        refuse("RELEASE_PATH_NOT_A_DIRECTORY")
    try:
        check_installed_release(host, rid, journal["source_sha"], journal["detector_sha"])
    except Refusal as exc:
        refuse(f"RELEASE_DRIFTED_REFUSING_ROLLBACK:{exc}")
    if host.tree_digest(target) != expected_digest:
        refuse("RELEASE_DRIFTED_REFUSING_ROLLBACK:TREE_DIGEST_MISMATCH")
    try:
        host.remove_release_tree(target)
    except OSError as exc:
        refuse(f"IO:{type(exc).__name__}")
    journal["phase"] = "rolled_back"
    write_journal(work, journal)
    if host.lexists(target):
        refuse("RELEASE_RESIDUE")
    check_parents(host)
    check_current_expected(host, current_id)
    check_current_release(host, current_id)  # the OLD (current) release is intact
    _postconditions(host, backend, journal)  # removed first, then any drift is escalated
    return {"F1I_ROLLBACK": "PASS", "TARGET_RELEASE_ABSENT": "YES", "CURRENT_TARGET": journal["current_target"], "CORE_UNCHANGED": "YES", "DETECTOR_PRESENT": "NO",
            "L7_MATERIAL_PRESERVED": "YES"}


# ── CLI ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)

    def pins(sp, work: bool, verify_only: bool = False) -> None:
        if work:
            sp.add_argument("--work-dir", required=True)
        sp.add_argument("--expected-current-release-id", required=True)
        sp.add_argument("--release-id", required=True)
        if not verify_only:
            sp.add_argument("--source-dir", required=True)
        sp.add_argument("--source-sha", required=True)
        sp.add_argument("--detector-sha256", required=True)

    pins(sub.add_parser("check"), work=False)  # read-only preflight; needs neither the live flag nor any write (run through sudo for root read authority)
    pins(sub.add_parser("apply"), work=True)
    pins(sub.add_parser("verify"), work=True, verify_only=True)
    sub.add_parser("rollback").add_argument("--work-dir", required=True)
    args = parser.parse_args(argv)
    label = "F1I_" + args.command.upper()
    try:
        host, backend = F1iHost(), F1iBackend()
        if args.command == "check":
            facts = preflight(host, backend, args.expected_current_release_id, args.release_id, args.source_dir, args.source_sha, args.detector_sha256)
            result = {"F1I_CHECK": "PASS", "CURRENT_TARGET": facts["current_target"], "TARGET_RELEASE_ABSENT": "YES", "SOURCE_RELEASE_GUARD": "PASS", "DETECTOR_PRESENT": "NO",
                      "CORE_RUNNING": "YES", "L7_MATERIAL_PRESENT": "YES"}
        else:
            if os.environ.get("AEGIS_F1I_LIVE_AUTHORIZED") != "YES":
                refuse("LIVE_AUTHORIZATION_FLAG_REQUIRED")
            if os.geteuid() != 0:
                refuse("ROOT_REQUIRED")
            work = F1R.require_work_dir(args.work_dir)
            if args.command == "rollback":
                result = rollback(work, host, backend)
            elif args.command == "apply":
                result = apply(args.expected_current_release_id, args.release_id, args.source_dir, args.source_sha, args.detector_sha256, work, host, backend)
            else:
                result = verify(args.expected_current_release_id, args.release_id, args.source_sha, args.detector_sha256, work, host, backend)
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
