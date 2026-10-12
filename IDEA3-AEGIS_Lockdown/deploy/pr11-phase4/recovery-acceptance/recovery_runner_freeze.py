#!/usr/bin/env python3
"""RECOVERY frozen-runner freeze / verify tool (repository tooling; authorises nothing live, creates no authorization or K3, runs nothing on Production).

The frozen RECOVERY owner runner must not be its own trust root: a hand-edited runner could alter its own gates or ownership constants and still receive a fresh self-hash in an Authorization. This tool
makes the frozen runner MECHANICALLY DERIVED from the reviewed template:

    FROZEN RUNNER = EXACT REVIEWED TEMPLATE  +  ONLY the approved pin substitutions

* The template authority is the Git object ``EXPECTED_MAIN:IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/owner-run/run-recovery-owner.sh`` read with replacement objects DISABLED; no working-tree byte is ever template
  authority.
* ``freeze`` takes a JSON object of pins. The key set must be EXACTLY the allowlist below (unknown, missing and duplicate keys are refused), every value must match a strict per-pin grammar (no newline, quote,
  ``$``, backtick, space or ``;``), and a value replaces ONLY the captured pin site of its own line. There is no generic search/replace interface; code cannot be injected through a pin value.
* The output is created exclusively (an existing destination is refused), never modifies the template, is mode 0555, and with ``--root-owned`` (root only) is chowned root:root and proven to sit under a trusted,
  root-owned, non-group/world-writable ancestor chain.
* PRODUCTION TRUST ROOT IS LITERALLY ``/``. There is no ``--trust-root`` option. Root-owned freeze and every ``verify`` prove the destination's parent and EVERY ancestor up to ``/`` are real directories owned by
  uid 0 and not group/world writable. A narrower trust root exists ONLY as an explicit TEST seam (``RECOVERY_TEST_ONLY_RUNNER_TRUST_ENABLED=YES`` plus ``RECOVERY_TEST_ONLY_RUNNER_TRUST_ROOT``), and it is honoured ONLY
  inside a user namespace: a real production root (the initial user namespace) refuses it, and a half-set seam is refused everywhere.
* For ``--root-owned`` the path is proven BEFORE root creates anything: the destination must not exist (and not be a symlink), its parent must already exist and be canonical, and the parent and every ancestor
  must be trusted. Only then is the file created (exclusively, relative to the verified parent directory, never following a symlink); afterwards the full ``verify`` runs again. Nothing is ever cleaned up or removed.
* ``verify`` re-proves, at any later time, that the file equals the template with only the approved pin sites changed, that its EXPECTED_MAIN pin is the reviewed main, and (production default) that it is root
  owned and not writable. It prints the four owner-facing results and the runner SHA-256 that the Authorization must name (that Authorization binding is unchanged and still required).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import stat
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import recovery_verifier_snapshot as snapshot_tool  # noqa: E402  (the shared ownership invariant lives there)

# The imported sibling must be the file next to THIS file (never a decoy found elsewhere on sys.path); the privileged tool-authority check covers the whole directory holding both.
SIBLING_IN_SAME_DIRECTORY = Path(snapshot_tool.__file__).resolve().parent == Path(__file__).resolve().parent

TEMPLATE_REL = "IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/owner-run/run-recovery-owner.sh"

_SHA256 = re.compile(r"[0-9a-f]{64}")  # every validator below uses re.fullmatch: `$` would accept a trailing newline
_PATH = re.compile(r"/[A-Za-z0-9._/-]{0,200}")


class FreezeError(ValueError):
    pass


def _path_ok(value: str) -> bool:
    return bool(_PATH.fullmatch(value)) and ".." not in value.split("/") and "//" not in value and (value == "/" or not value.endswith("/"))

def _relative_path_ok(value: str) -> bool:
    return bool(re.fullmatch(r"[A-Za-z0-9._/-]{1,240}", value)) and not value.startswith("/") and ".." not in value.split("/") and "//" not in value


def _ipv4_external(value: str) -> bool:
    import ipaddress

    if not re.fullmatch(r"(\d{1,3})(\.\d{1,3}){3}", value):
        return False
    try:
        ip = ipaddress.IPv4Address(value)
    except ValueError:
        return False
    return not (ip.is_unspecified or ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_reserved or value == "255.255.255.255")


VALIDATORS = {
    "main": lambda v: bool(re.fullmatch(r"[0-9a-f]{40}", v)),
    "user": lambda v: bool(re.fullmatch(r"[a-z_][a-z0-9_-]{0,31}", v)),
    "uid": lambda v: bool(re.fullmatch(r"[1-9][0-9]{0,9}", v)),
    "release": lambda v: bool(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", v)) and ".." not in v,
    "sha256": lambda v: bool(_SHA256.fullmatch(v)),
    "path": _path_ok,
    "relative": _relative_path_ok,
    "ipv4": _ipv4_external,
    "seconds": lambda v: bool(re.fullmatch(r"[1-9][0-9]{0,5}", v)),
}

# name -> (site pattern with ONE capture group = the value, the exact placeholder the reviewed template carries, grammar)
PIN_SPECS: dict[str, tuple[re.Pattern[str], str, str]] = {
    "EXPECTED_MAIN": (re.compile(r"^EXPECTED_MAIN=(.*)$", re.M), "PIN_MAIN_SHA", "main"),
    "OPERATOR_USER": (re.compile(r"^OPERATOR_USER=(.*)$", re.M), "PIN_OPERATOR_USER", "user"),
    "OPERATOR_UID": (re.compile(r"^OPERATOR_UID=(.*)$", re.M), "PIN_OPERATOR_UID", "uid"),
    "RELEASE_ID": (re.compile(r"^RELEASE_ID=(.*)$", re.M), "PIN_RELEASE_ID", "release"),
    "PRODUCTION_DETECTOR_SHA256": (re.compile(r"^PRODUCTION_DETECTOR_SHA256=(.*)$", re.M), "PIN_PRODUCTION_DETECTOR_SHA256", "sha256"),
    "DETECTOR_UNIT_SHA256": (re.compile(r"^DETECTOR_UNIT_SHA256=(.*)$", re.M), "PIN_DETECTOR_UNIT_SHA256", "sha256"),
    "RECOVERY_CORE_SHA256": (re.compile(r"^RECOVERY_CORE_SHA256=(.*)$", re.M), "PIN_RECOVERY_CORE_SHA256", "sha256"),
    "RESTORE_CLI_SHA256": (re.compile(r"^RESTORE_CLI_SHA256=(.*)$", re.M), "PIN_RESTORE_CLI_SHA256", "sha256"),
    "RELEASE_SUMS_SHA256": (re.compile(r"^RELEASE_SUMS_SHA256=(.*)$", re.M), "PIN_RELEASE_SUMS_SHA256", "sha256"),
    "CONTROL_SNAPSHOT_DIR": (re.compile(r"^CONTROL_SNAPSHOT_DIR=(.*)$", re.M), "PIN_CONTROL_SNAPSHOT_DIR", "path"),
    "CONTROL_MANIFEST_SHA256": (re.compile(r"^CONTROL_MANIFEST_SHA256=(.*)$", re.M), "PIN_CONTROL_MANIFEST_SHA256", "sha256"),
    "VERIFIER_SNAPSHOT_DIR": (re.compile(r"^VERIFIER_SNAPSHOT_DIR=(.*)$", re.M), "PIN_VERIFIER_SNAPSHOT_DIR", "path"),
    "VERIFIER_MANIFEST_SHA256": (re.compile(r"^VERIFIER_MANIFEST_SHA256=(.*)$", re.M), "PIN_VERIFIER_MANIFEST_SHA256", "sha256"),
    "R1I_TOOL_SHA256": (re.compile(r"^R1I_TOOL_SHA256=(.*)$", re.M), "PIN_R1I_TOOL_SHA256", "sha256"),
    "PROTOCOL_DB": (re.compile(r"^PROTOCOL_DB=(.*)$", re.M), "PIN_PROTOCOL_DB_PATH", "path"),
    "AUDIT_DB": (re.compile(r"^AUDIT_DB=(.*)$", re.M), "PIN_AUDIT_DB_PATH", "path"),
    "R1B_EVIDENCE_DIR": (re.compile(r"^R1B_EVIDENCE_DIR=(.*)$", re.M), "PIN_R1B_EVIDENCE_DIR", "path"),
    "EXPECTED_SOURCE_IP": (re.compile(r"^EXPECTED_SOURCE_IP=(.*)$", re.M), "PIN_EXPECTED_SOURCE_IP", "ipv4"),
    "DETECTOR_UID": (re.compile(r"^DETECTOR_UID=(.*)$", re.M), "PIN_DETECTOR_UID", "uid"),
    "RUNTIME_DIR": (re.compile(r"^RUNTIME_DIR=(.*)$", re.M), "PIN_RUNTIME_DIR", "path"),
    "REPO": (re.compile(r"^REPO=(\S+)   # ", re.M), "/home/PIN_OPERATOR_HOME/PIN_PINNED_WORKTREE_NOT_A_REAL_PATH", "path"),
    "PY": (re.compile(r"^PY=(.*)$", re.M), "PIN_PYTHON_BIN", "path"),
    "EVIDENCE_ROOT": (re.compile(r"^EVID_ROOT=(.*)$", re.M), "/PIN_EVIDENCE_ROOT", "path"),
    "CTU_LIVE_RECEIPT_RELATIVE": (re.compile(r"^CTU_LIVE_RECEIPT_RELATIVE=(.*)$", re.M), "PIN_CTU_LIVE_RECEIPT_RELATIVE", "path"),
    "CTU_REPO_RECEIPT_SHA256": (re.compile(r"^CTU_REPO_RECEIPT_SHA256=(.*)$", re.M), "PIN_CTU_REPO_RECEIPT_SHA256", "sha256"),
    "CTV_LIVE_RECEIPT_RELATIVE": (re.compile(r"^CTV_LIVE_RECEIPT_RELATIVE=(.*)$", re.M), "PIN_CTV_LIVE_RECEIPT_RELATIVE", "relative"),
    "CTV_REPO_RECEIPT_SHA256": (re.compile(r"^CTV_REPO_RECEIPT_SHA256=(.*)$", re.M), "PIN_CTV_REPO_RECEIPT_SHA256", "sha256"),
}


TEST_SEAM_ENABLED = "RECOVERY_TEST_ONLY_RUNNER_TRUST_ENABLED"
TEST_SEAM_ROOT = "RECOVERY_TEST_ONLY_RUNNER_TRUST_ROOT"
CTU_CLOSEOUT = "/var/lib/aegis-idea3-governance/CTU-GLOBAL-CLOSEOUT-PASS"
CTU_TEST_CLOSEOUT = "RECOVERY_TEST_ONLY_CTU_CLOSEOUT"


def _initial_user_namespace() -> bool:
    """True in the real (initial) user namespace, i.e. on the production host. Inside a user namespace the uid map is not the identity map."""
    try:
        parts = Path("/proc/self/uid_map").read_text().split()
    except OSError:
        return True  # unknown: treat as the real namespace (the seam stays refused)
    return parts[:3] == ["0", "0", "4294967295"]


def trust_root() -> str:
    """The designated trusted parent: the literal ``/`` in production. The ONLY alternative is the explicit test seam, refused outside a user namespace and refused when only half-set."""
    enabled, root = os.environ.get(TEST_SEAM_ENABLED), os.environ.get(TEST_SEAM_ROOT)
    if enabled is None and root is None:
        return snapshot_tool.PRODUCTION_TRUST_ROOT
    if enabled != "YES" or not root:
        raise FreezeError("TEST_TRUST_SEAM_INCOMPLETE")
    if _initial_user_namespace():
        raise FreezeError("TEST_TRUST_SEAM_REFUSED_IN_THE_REAL_ROOT_NAMESPACE")
    if not root.startswith("/") or ".." in root.split("/") or not Path(root).is_dir() or Path(os.path.realpath(root)) != Path(os.path.abspath(root)):
        raise FreezeError("TEST_TRUST_SEAM_ROOT_INVALID")
    return root


def _git_env() -> dict[str, str]:
    """A clean Git environment: nothing from the caller can redirect the repository or re-enable replacement objects."""
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    env["GIT_NO_REPLACE_OBJECTS"] = "1"
    env["GIT_CONFIG_NOSYSTEM"] = "1"
    return env


def _git(repo: Path, *args: str) -> str:
    done = subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True, env=_git_env(), check=False)
    if done.returncode != 0:
        raise FreezeError("GIT_READ_FAILED")
    return done.stdout


def read_template(repo: Path, main: str) -> str:
    """The reviewed template, as the bytes of the exact EXPECTED_MAIN Git object (replacement objects disabled). Never a working-tree file."""
    if not VALIDATORS["main"](main):
        raise FreezeError("MAIN_MALFORMED")
    if _git(Path(repo), "rev-parse", "--verify", f"{main}^{{commit}}").strip() != main:
        raise FreezeError("MAIN_NOT_A_COMMIT_OBJECT")
    return _git(Path(repo), "show", f"{main}:{TEMPLATE_REL}")


def load_pins(text: str) -> dict[str, str]:
    """Strict pin input: ONE JSON object, string values, no duplicate key, the key set EXACTLY the allowlist."""
    def no_duplicates(pairs):
        keys = [k for k, _ in pairs]
        if len(keys) != len(set(keys)):
            raise FreezeError("DUPLICATE_PIN")
        return dict(pairs)

    try:
        pins = json.loads(text, object_pairs_hook=no_duplicates)
    except json.JSONDecodeError:
        raise FreezeError("PINS_NOT_JSON") from None
    if not isinstance(pins, dict) or not all(isinstance(v, str) for v in pins.values()):
        raise FreezeError("PINS_NOT_A_STRING_OBJECT")
    unknown = sorted(set(pins) - set(PIN_SPECS))
    if unknown:
        raise FreezeError(f"UNKNOWN_PIN:{unknown[0]}")
    missing = sorted(set(PIN_SPECS) - set(pins))
    if missing:
        raise FreezeError(f"MISSING_PIN:{missing[0]}")
    for name, value in pins.items():
        if "PIN_" in value or not VALIDATORS[PIN_SPECS[name][2]](value):
            raise FreezeError(f"PIN_VALUE_REJECTED:{name}")
    return pins


def _sites(text: str, name: str) -> list[re.Match[str]]:
    return list(PIN_SPECS[name][0].finditer(text))


def render(template: str, pins: dict[str, str]) -> str:
    """The template with ONLY the captured pin site of each allowlisted pin replaced. The template must be genuinely unfrozen (every site carries its exact placeholder, exactly once)."""
    edits = []
    for name, (_, placeholder, _) in PIN_SPECS.items():
        matches = _sites(template, name)
        if len(matches) != 1 or matches[0].group(1) != placeholder:
            raise FreezeError(f"TEMPLATE_PIN_SITE_INVALID:{name}")
        edits.append((matches[0].span(1), pins[name]))
    out = template
    for (start, end), value in sorted(edits, reverse=True):
        out = out[:start] + value + out[end:]
    return out


def extract(frozen: str) -> dict[str, str]:
    """The pin values carried by a frozen runner (each site must match exactly once)."""
    values = {}
    for name in PIN_SPECS:
        matches = _sites(frozen, name)
        if len(matches) != 1:
            raise FreezeError(f"FROZEN_PIN_SITE_NOT_UNIQUE:{name}")
        values[name] = matches[0].group(1)
    return values


def check_equivalence(template: str, frozen: str) -> dict[str, str]:
    """FROZEN == TEMPLATE + ONLY the approved pin substitutions: restoring each placeholder in the frozen text must reproduce the reviewed template byte for byte."""
    values = extract(frozen)
    for name, value in values.items():
        if "PIN_" in value or not VALIDATORS[PIN_SPECS[name][2]](value):
            raise FreezeError(f"FROZEN_PIN_VALUE_REJECTED:{name}")
    edits = sorted(((_sites(frozen, name)[0].span(1), PIN_SPECS[name][1]) for name in PIN_SPECS), reverse=True)
    restored = frozen
    for (start, end), placeholder in edits:
        restored = restored[:start] + placeholder + restored[end:]
    if restored != template:
        raise FreezeError("NON_PIN_BYTES_DIFFER_FROM_THE_REVIEWED_TEMPLATE")
    return values


def sha256_of(path: Path) -> str:
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def verify(repo: Path, main: str, runner: Path, *, owner_uid: int | None = snapshot_tool.PRODUCTION_OWNER_UID) -> dict[str, str]:
    """The four owner-facing results plus the runner SHA-256. ``owner_uid=None`` skips ONLY the ownership/non-writable proof (hermetic tests of the byte logic); the CLI never does."""
    if _initial_user_namespace() and os.environ.get(TEST_SEAM_ENABLED) == "YES" and os.environ.get(TEST_SEAM_ROOT):
        raise FreezeError("TEST_TRUST_SEAM_REFUSED_IN_THE_REAL_ROOT_NAMESPACE")
    runner = Path(runner)
    template = read_template(repo, main)
    results = {"RUNNER_TEMPLATE_AUTHORITY": "PASS"}
    frozen = runner.read_text(encoding="utf-8")
    values = check_equivalence(template, frozen)
    if values["EXPECTED_MAIN"] != main:
        raise FreezeError("FROZEN_EXPECTED_MAIN_IS_NOT_THE_REVIEWED_MAIN")
    results["RUNNER_ONLY_APPROVED_PINS_CHANGED"] = "PASS"
    if owner_uid is not None:
        try:
            snapshot_tool.check_trusted_path(runner.parent, owner_uid, trust_root())
        except snapshot_tool.SnapshotError as exc:
            raise FreezeError(f"RUNNER_NOT_ROOT_OWNED:{exc}") from None
        st = runner.lstat()
        if stat.S_ISLNK(st.st_mode) or not stat.S_ISREG(st.st_mode) or Path(os.path.realpath(runner)) != Path(os.path.abspath(runner)):
            raise FreezeError("RUNNER_NOT_A_CANONICAL_REGULAR_FILE")
        if st.st_uid != owner_uid:
            raise FreezeError("RUNNER_NOT_ROOT_OWNED:file")
        results["RUNNER_ROOT_OWNED"] = "PASS"
        if st.st_mode & 0o222:
            raise FreezeError("RUNNER_WRITABLE")
        results["RUNNER_NONWRITABLE"] = "PASS"
        _verify_ctu_pass_for_freeze(repo, main, values)
    results["RUNNER_SHA256"] = sha256_of(runner)
    return results


def _prewrite_path_proof(out: Path) -> int:
    """For a ROOT-OWNED freeze: prove the destination path BEFORE anything is created. Returns an open directory fd of the verified parent (the file is then created relative to it)."""
    out = Path(os.path.abspath(out))
    if os.path.lexists(out):  # exists, is a symlink (even dangling) or anything else: never created over, never followed
        raise FreezeError("DESTINATION_EXISTS")
    parent = out.parent
    if not parent.is_dir() or parent.is_symlink():
        raise FreezeError("RUNNER_PARENT_MISSING_OR_SYMLINK")  # an untrusted parent is never auto-created or followed
    try:
        snapshot_tool.check_trusted_path(parent, snapshot_tool.PRODUCTION_OWNER_UID, trust_root())  # canonical; parent and EVERY ancestor to the trust root: real dir, uid 0, not group/world writable
    except snapshot_tool.SnapshotError as exc:
        raise FreezeError(f"RUNNER_PARENT_NOT_TRUSTED:{exc}") from None
    fd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    st, now = os.fstat(fd), parent.lstat()
    if (st.st_dev, st.st_ino) != (now.st_dev, now.st_ino) or st.st_uid != snapshot_tool.PRODUCTION_OWNER_UID or st.st_mode & 0o022:
        os.close(fd)
        raise FreezeError("RUNNER_PARENT_CHANGED_DURING_PROOF")
    return fd


def _prove_privileged_authority(repo: Path) -> None:
    """DEFENCE IN DEPTH for a ROOT-OWNED freeze (it does not replace running the tool FROM the root-owned exact-main authority): the tool directory (the tool and its sibling), and the Git repository the template
    is read from, must be canonical, root-owned, non-writable and under trusted root-owned ancestors to the trust root, with no symlink and no special file."""
    trust = trust_root()
    if not SIBLING_IN_SAME_DIRECTORY:
        raise FreezeError("SIBLING_TOOL_NOT_IN_THE_SAME_AUTHORITY_DIRECTORY")
    try:
        snapshot_tool.check_tool_authority(trust, Path(os.path.abspath(__file__)).parent)
        snapshot_tool.check_source_authority(repo, trust)  # the exact-main authority repository itself (read BY Git below)
    except snapshot_tool.SnapshotError as exc:
        raise FreezeError(f"PRIVILEGED_AUTHORITY_NOT_TRUSTED:{exc}") from None


def _ctu_closeout_for_freeze() -> Path:
    """Return the fixed CTu successor proof, with one user-namespace-only test seam."""
    candidate = os.environ.get(CTU_TEST_CLOSEOUT)
    if candidate:
        if _initial_user_namespace() or os.environ.get(TEST_SEAM_ENABLED) != "YES":
            raise FreezeError("CTU_CLOSEOUT_TEST_SEAM_REFUSED")
        path = Path(candidate)
    else:
        path = Path(CTU_CLOSEOUT)
    if not path.is_absolute() or ".." in path.parts or path.is_symlink() or not path.is_file():
        raise FreezeError("CTU_PASS_CLOSEOUT_MISSING_OR_UNSAFE")
    siblings = [item for item in path.parent.glob("CTU-GLOBAL-CLOSEOUT-*") if item.is_file()]
    if not os.environ.get(CTU_TEST_CLOSEOUT):
        if len(siblings) != 1 or siblings[0] != path:
            raise FreezeError("CTU_PASS_CLOSEOUT_NOT_UNIQUE")
    else:
        if len(siblings) > 1 or (len(siblings) == 1 and siblings[0] != path):
            raise FreezeError("CTU_PASS_CLOSEOUT_NOT_UNIQUE")
    st = path.lstat()
    if not stat.S_ISREG(st.st_mode) or st.st_uid != 0 or st.st_mode & 0o022:
        raise FreezeError("CTU_PASS_CLOSEOUT_NOT_ROOT_OWNED")
    if not os.environ.get(CTU_TEST_CLOSEOUT):
        try:
            snapshot_tool.check_trusted_path(path.parent, 0, trust_root())
        except snapshot_tool.SnapshotError as exc:
            raise FreezeError(f"CTU_PASS_CLOSEOUT_PARENT_NOT_TRUSTED:{exc}") from None
    return path


def _verify_ctu_pass_for_freeze(repo: Path, main: str, pins: dict[str, str]) -> None:
    path = _ctu_closeout_for_freeze()
    lines = path.read_text(encoding="utf-8").splitlines()
    pairs = [line.split("=", 1) for line in lines if "=" in line]
    if len(pairs) != len({key for key, _ in pairs}):
        raise FreezeError("CTU_PASS_CLOSEOUT_DUPLICATE_KEYS")
    values = dict(pairs)
    required_keys = {
        "CTU_ATTEMPT_CONSUMED", "CTU_AUTHENTICATED_STATUS_PROOF", "CTU_DETECTOR_BASELINE_MODE",
        "CTU_DETECTOR_LIFECYCLE_PROOF", "CTU_DEVICE_ID", "CTU_EVIDENCE_MANIFEST_SHA256", "CTU_EVIDENCE_ROOT", "CTU_EXECUTION_MAIN", "CTU_EXPECTED_MAIN",
        "CTU_FAILURE_RESULT", "CTU_LIVE", "CTU_LIVE_EXECUTED", "CTU_PRE_POST_PRESERVATION",
        "CTU_RERUN_ALLOWED", "CTU_RESULT", "CTU_RUNTIME_PROOF", "CTU_RUNNER_SHA256", "CTU_STAGE", "CTU_UNIT_SHA256",
        "RECOVERY_ATTEMPT_CONSUMED", "RECOVERY_LIVE_EXECUTED",
    }
    if set(values.keys()) != required_keys:
        raise FreezeError("CTU_PASS_CLOSEOUT_FIELDS_INVALID")
    required = {
        "CTU_LIVE": "CLOSED_PASS", "CTU_LIVE_EXECUTED": "YES", "CTU_RESULT": "PASS",
        "CTU_ATTEMPT_CONSUMED": "YES", "CTU_RERUN_ALLOWED": "NO",
        "CTU_STAGE": "CTu", "CTU_RUNTIME_PROOF": "PASS", "CTU_AUTHENTICATED_STATUS_PROOF": "PASS",
        "CTU_DETECTOR_LIFECYCLE_PROOF": "PASS", "CTU_PRE_POST_PRESERVATION": "PASS",
        "RECOVERY_LIVE_EXECUTED": "NO", "RECOVERY_ATTEMPT_CONSUMED": "NO", "CTU_FAILURE_RESULT": "NONE",
    }
    if any(values.get(key) != value for key, value in required.items()):
        raise FreezeError("CTU_PASS_CLOSEOUT_NOT_VALID_FOR_MAIN")
    if values.get("CTU_DETECTOR_BASELINE_MODE") not in ("ACTIVE", "INACTIVE"):
        raise FreezeError("CTU_PASS_CLOSEOUT_DETECTOR_MODE_INVALID")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}", values.get("CTU_DEVICE_ID", "")):
        raise FreezeError("CTU_PASS_CLOSEOUT_DEVICE_ID_INVALID")
    ctu_main = values.get("CTU_EXPECTED_MAIN", "")
    if not re.fullmatch(r"[0-9a-f]{40}", ctu_main):
        raise FreezeError("CTU_PASS_CLOSEOUT_MAIN_INVALID")
    if ctu_main != main:
        try:
            done = subprocess.run(
                ["git", "-C", str(repo), "merge-base", "--is-ancestor", ctu_main, main],
                capture_output=True,
                env=_git_env(),
                check=False,
            )
            if done.returncode != 0:
                raise FreezeError("CTU_PASS_CLOSEOUT_MAIN_NOT_ANCESTOR")
        except OSError:
            raise FreezeError("GIT_READ_FAILED")
    if values.get("CTU_EXECUTION_MAIN") != ctu_main:
        raise FreezeError("CTU_PASS_CLOSEOUT_EXECUTION_MAIN_INVALID")
    if not re.fullmatch(r"[0-9a-f]{64}", values.get("CTU_RUNNER_SHA256", "")):
        raise FreezeError("CTU_PASS_CLOSEOUT_RUNNER_SHA_INVALID")
    if not re.fullmatch(r"[0-9a-f]{64}", values.get("CTU_EVIDENCE_MANIFEST_SHA256", "")):
        raise FreezeError("CTU_PASS_CLOSEOUT_EVIDENCE_MANIFEST_INVALID")
    if not re.fullmatch(r"[0-9a-f]{64}", values.get("CTU_UNIT_SHA256", "")):
        raise FreezeError("CTU_PASS_CLOSEOUT_UNIT_BINDING_INVALID")
    if not _path_ok(values.get("CTU_EVIDENCE_ROOT", "")):
        raise FreezeError("CTU_PASS_CLOSEOUT_EVIDENCE_ROOT_INVALID")
    host_sum = Path(f"{path}.sha256")
    if not host_sum.is_file() or host_sum.is_symlink() or host_sum.stat().st_mode & 0o077 or host_sum.stat().st_uid != 0:
        raise FreezeError("CTU_HOST_CLOSEOUT_DIGEST_MISSING_OR_UNSAFE")
    try:
        subprocess.run(["sha256sum", "-c", "--quiet", "--strict", host_sum.name], cwd=host_sum.parent, check=True, capture_output=True)
    except (OSError, subprocess.CalledProcessError):
        raise FreezeError("CTU_HOST_CLOSEOUT_DIGEST_INVALID") from None
    host_sha = host_sum.read_text(encoding="utf-8").split()[0]
    receipt_override = os.environ.get("RECOVERY_TEST_ONLY_CTU_LIVE_RECEIPT")
    receipt = Path(receipt_override) if receipt_override else Path(repo) / pins["CTU_LIVE_RECEIPT_RELATIVE"].lstrip("/")
    if not receipt.is_file() or receipt.is_symlink():
        raise FreezeError("CTU_LIVE_REPOSITORY_RECEIPT_MISSING")
    receipt_sha = hashlib.sha256(receipt.read_bytes()).hexdigest()
    if not receipt_override:
        if receipt_sha != pins["CTU_REPO_RECEIPT_SHA256"]:
            raise FreezeError("CTU_LIVE_REPOSITORY_RECEIPT_DIGEST_INVALID")
        rel = receipt.relative_to(repo).as_posix()
        if _git(repo, "hash-object", "--", rel).strip() != receipt_sha or _git(repo, "rev-parse", f"{main}:{rel}").strip() != receipt_sha:
            raise FreezeError("CTU_LIVE_REPOSITORY_RECEIPT_NOT_IN_EXACT_MAIN")
    receipt_text = receipt.read_text(encoding="utf-8")
    for line in (
        "CTU_LIVE=CLOSED_PASS", "CTU_LIVE_EXECUTED=YES", "CTU_ATTEMPT_CONSUMED=YES",
        "CTU_RESULT=PASS", "RECOVERY_LIVE_EXECUTED=NO", "RECOVERY_ATTEMPT_CONSUMED=NO",
        f"CTU_EXPECTED_MAIN={values['CTU_EXPECTED_MAIN']}", f"CTU_EXECUTION_MAIN={values['CTU_EXECUTION_MAIN']}",
        f"CTU_HOST_CLOSEOUT_SHA256={host_sha}", f"CTU_RUNNER_SHA256={values['CTU_RUNNER_SHA256']}",
        f"CTU_UNIT_SHA256={values['CTU_UNIT_SHA256']}", f"CTU_DEVICE_ID={values['CTU_DEVICE_ID']}",
        f"CTU_DETECTOR_BASELINE_MODE={values['CTU_DETECTOR_BASELINE_MODE']}",
        f"CTU_EVIDENCE_MANIFEST_SHA256={values['CTU_EVIDENCE_MANIFEST_SHA256']}",
    ):
        if line not in receipt_text.splitlines():
            raise FreezeError("CTU_LIVE_REPOSITORY_RECEIPT_BINDING_INVALID")
    recovery_marker = path.parent / "RECOVERY-GLOBAL-ATTEMPT-CONSUMED"
    if recovery_marker.exists() or recovery_marker.is_symlink():
        raise FreezeError("RECOVERY_ALREADY_CONSUMED")
    if not os.environ.get(CTU_TEST_CLOSEOUT) or os.environ.get("AEGIS_CORE_UNIT_FILE"):
        unit_file = os.environ.get("AEGIS_CORE_UNIT_FILE", "/etc/systemd/system/aegis-idea3-core.service")
        unit_path = Path(unit_file)
        if unit_path.is_file() and not unit_path.is_symlink():
            content = unit_path.read_text(encoding="utf-8")
            h = hashlib.sha256(unit_path.read_bytes()).hexdigest()
            if h != values["CTU_UNIT_SHA256"]:
                raise FreezeError("INSTALLED_UNIT_MISMATCH")
            if not re.search(r"^\s*ProtectClock\s*=\s*(false|no)\s*$", content, re.M):
                raise FreezeError("CORE_PROTECTCLOCK_INVALID")
            if not re.search(r"^\s*User\s*=\s*aegis-idea3\s*$", content, re.M):
                raise FreezeError("CORE_SECURITY_HARDENING_INVALID")


def freeze(repo: Path, main: str, pins: dict[str, str], out: Path, *, root_owned: bool = False) -> dict[str, str]:
    """Create a NEW frozen runner (never overwrites, never touches the template), then prove it exactly as ``verify`` does. ``--root-owned`` proves the path BEFORE creating."""
    out = Path(out)
    if root_owned:
        if os.geteuid() != 0:
            raise FreezeError("ROOT_REQUIRED_FOR_ROOT_OWNED_RUNNER")
        _prove_privileged_authority(Path(repo))  # tool + sibling + the Git repository are root-owned and trusted BEFORE anything is read from them
        _verify_ctu_pass_for_freeze(repo, main, pins)  # Recovery authority cannot be frozen before the exact-main CTu live closeout exists
    template = read_template(repo, main)
    if pins.get("EXPECTED_MAIN") != main:
        raise FreezeError("EXPECTED_MAIN_PIN_IS_NOT_THE_REVIEWED_MAIN")
    frozen = render(template, pins)
    if root_owned:
        parent_fd = _prewrite_path_proof(out)  # raises BEFORE any file exists
        try:
            fd = os.open(out.name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o555, dir_fd=parent_fd)  # exclusive, relative to the verified parent, never through a symlink
        except FileExistsError:
            raise FreezeError("DESTINATION_EXISTS") from None
        finally:
            os.close(parent_fd)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(frozen)
            handle.flush()
            os.fchmod(handle.fileno(), 0o555)
            os.fchown(handle.fileno(), 0, 0)
        return verify(repo, main, out, owner_uid=0)  # the full proof again, after creation
    try:
        with open(out, "x", encoding="utf-8") as handle:  # exclusive: an existing destination is refused
            handle.write(frozen)
    except FileExistsError:
        raise FreezeError("DESTINATION_EXISTS") from None
    out.chmod(0o555)
    return verify(repo, main, out, owner_uid=None)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    fr = sub.add_parser("freeze")
    fr.add_argument("--repo", type=Path, required=True)
    fr.add_argument("--main", required=True)
    fr.add_argument("--pins", type=Path, required=True)
    fr.add_argument("--out", type=Path, required=True)
    fr.add_argument("--root-owned", action="store_true", help="FREEZE: chown root:root (root only) and prove the production invariant")
    vf = sub.add_parser("verify")
    vf.add_argument("--repo", type=Path, required=True)
    vf.add_argument("--main", required=True)
    vf.add_argument("--runner", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        if args.command == "freeze":
            pins = load_pins(args.pins.read_text(encoding="utf-8"))
            results = freeze(args.repo, args.main, pins, args.out, root_owned=args.root_owned)
            if not args.root_owned:
                print("NOTE: not root-owned; RUNNER_ROOT_OWNED and RUNNER_NONWRITABLE are NOT proven (rerun with --root-owned as root before any Authorization)")
        else:
            results = verify(args.repo, args.main, args.runner)
    except (FreezeError, OSError, UnicodeDecodeError) as exc:
        print(f"RECOVERY_RUNNER_FREEZE=FAIL reason={exc}", file=sys.stderr)
        return 1
    for key, value in results.items():
        print(f"{key}={value}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
