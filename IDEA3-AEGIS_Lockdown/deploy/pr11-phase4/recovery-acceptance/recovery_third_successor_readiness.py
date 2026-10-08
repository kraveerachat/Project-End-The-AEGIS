#!/usr/bin/python3 -I -B
"""AEGIS IDEA3 — THIRD GOVERNED RECOVERY SUCCESSOR readiness verifier.

OFFLINE. READ-ONLY. NON-CONSUMING. NOT AN AUTHORIZATION. NOT A STAGE. NOT WIRED INTO RECOVERY OR ANY GATE.

It answers one question only: "which of the independently checkable prerequisites of a possible, separately governed third Recovery
successor are verified, partial, blocked or unknown?"  It never converts the immutable CTv CLOSED_FAIL into a PASS, never reads a retry into
history, never consumes or creates a marker, and always prints RECOVERY_AUTHORIZED=NO.  The existing CTu-PASS-or-CTv-CLOSED_PASS predecessor
gate in p4-recovery-run-lib.sh is untouched and keeps refusing the historical failure.

Authority model
  * Pins (CTv closeout digest, marker digest, unit digest, detector unit digest, release sums digest, reviewed successor authority id) are read ONLY
    from the reviewed file ``third-successor-pins.kv`` as a Git blob of the exact pinned main.  No command-line value can supply a pin.  The file
    does not exist today, so every dependent fact is UNKNOWN until a reviewed change supplies it.
  * This tool's own bytes must equal the exact-main blob; replacement objects are disabled; HEAD must equal the pinned main.
  * Every evidence file (canonical-directory copy, transcripts of the CTv attestation and the release proof, owner authorization) is untrusted
    data: it must be a root- or operator-owned, single-link regular file reached through a symlink-free, not group/world-writable path chain, and
    is parsed with a strict KEY=VALUE grammar (duplicate keys, unknown keys, malformed lines are refused).
  * A transcript is a CLAIM, not fresh proof.  CURRENT_RUNTIME therefore never exceeds PARTIAL offline, and nothing produced in HERMETIC_TEST mode
    (a test world) is ever production evidence: it is capped at PARTIAL readiness.
  * An owner-authorization file is only checked structurally and for binding to this main and this CTv closeout.  Its authenticity, the K3 binding
    and same-instant freshness are enforced by the live Recovery gates, not here (OWNER_AUTHORIZATION_AUTHENTICITY=NOT_VERIFIED_OFFLINE).

Exit status: 1 FAIL (bad input / authority), 3 PARTIAL, 2 BLOCKED, 4 AWAITING_APPROVAL (never 0: a zero exit could be mistaken for permission).
"""
from __future__ import annotations

import argparse
import hashlib
import os
import re
import stat
import subprocess
import sys
import time
from pathlib import Path

STAGE = "Recovery-third-successor-readiness"
REL = "IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/recovery-acceptance"
SELF_REL = f"{REL}/recovery_third_successor_readiness.py"
PINS_REL = f"{REL}/third-successor-pins.kv"
RECOVERY_LIB_REL = "IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-recovery-run-lib.sh"
HEX40 = re.compile(r"[0-9a-f]{40}")
HEX64 = re.compile(r"[0-9a-f]{64}")
ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{7,63}")
KV = re.compile(r"([A-Z][A-Z0-9_]*)=([^\n\r]*)")
FORBIDDEN_ENV = (
    "PYTHONPATH", "PYTHONHOME", "PYTHONSTARTUP", "PYTHONUSERBASE", "PYTHONINSPECT", "PYTHONBREAKPOINT", "PYTHONSAFEPATH", "PYTHONDONTWRITEBYTECODE",
    "LD_PRELOAD", "LD_LIBRARY_PATH", "LD_AUDIT", "BASH_ENV", "ENV", "GIT_DIR", "GIT_WORK_TREE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_REPLACE_REF_BASE", "GIT_CONFIG", "GIT_CONFIG_COUNT", "GIT_EXEC_PATH", "GIT_INDEX_FILE", "TMPDIR",
)
TRANSCRIPT_MAX_AGE_SECONDS = 900
MAX_BYTES = 1 << 20

CLOSEOUT_FIXED = {
    "CTV_RESULT": "FAIL_IMMUTABLE", "CTV_LIVE": "CLOSED_FAIL", "CTV_LIVE_EXECUTED": "YES", "CTV_ATTEMPT_CONSUMED": "YES",
    "CTV_RERUN_ALLOWED": "NO", "CTV_IS_CTU_RETRY": "NO", "CTV_ROLLBACK_COMPLETE": "NO", "CTV_TARGET_UNIT_RETAINED": "YES",
    "CTV_ADDITIONAL_CORE_RESTART": "NO", "CTV_S10_HISTORICAL_COMPARE": "FAIL", "CTV_S10_PROMOTED_TO_PASS": "NO", "CTV_RECOVERY_AUTHORIZED": "NO",
    "CTV_JOURNAL_PHASE": "apply-verified", "CTV_DETECTOR_BASELINE_MODE": "INACTIVE", "CTV_TRUSTEDCLOCK_AT_DISPOSITION": "SYNCED",
}
CTU_CLOSEOUT_FIXED = {"CTU_RESULT": "FAIL_IMMUTABLE", "CTU_ATTEMPT_CONSUMED": "YES", "CTU_RERUN_ALLOWED": "NO"}
AUTH_KEYS = (
    "AUTH_SCHEMA", "AUTH_ID", "AUTH_DATE_UTC", "AUTH_MAIN", "AUTH_CTV_CLOSEOUT_SHA256", "AUTH_STAGE", "AUTH_IS_CTV_RETRY",
    "AUTH_INHERITS_PREVIOUS_AUTHORIZATION", "AUTH_SINGLE_ATTEMPT", "AUTH_K3_BINDING_SHA256", "AUTH_REVIEWED_SUCCESSOR_AUTHORITY_ID",
)
AUTH_FIXED = {
    "AUTH_SCHEMA": "recovery-third-successor-authorization-v1", "AUTH_STAGE": "RECOVERY_THIRD_SUCCESSOR", "AUTH_IS_CTV_RETRY": "NO",
    "AUTH_INHERITS_PREVIOUS_AUTHORIZATION": "NO", "AUTH_SINGLE_ATTEMPT": "YES",
}
PIN_KEYS = (
    "CTV_CLOSEOUT_SHA256", "CTV_MARKER_SHA256", "CTV_UNIT_SHA256", "DETECTOR_UNIT_SHA256", "RELEASE_SUMS_SHA256", "THIRD_SUCCESSOR_AUTHORITY_ID",
)
# The 15 requirements of the contract. STATUS is one of VERIFIED, PARTIAL, BLOCKED, UNKNOWN, NOT_CHECKED_BY_THIS_TOOL.
REQUIREMENTS = (
    "CTV_IMMUTABLE_FAILURE", "CTV_CLOSEOUT_DIGEST", "CONSUMED_ATTEMPT_MARKERS", "HISTORICAL_S10_FAILURE", "ROOT_TRUST_BOUNDARIES", "CURRENT_RUNTIME_IDENTITY",
    "RELEASE_AND_RESTORE_CLI_PINS", "DETECTOR_IDENTITY", "FRESH_R1I_R1B_R1BV_FACTS", "TRUSTEDCLOCK_AND_EVENT_PROVENANCE", "SINGLE_ATTEMPT_SEMANTICS",
    "NON_RETRY_CONSTRAINTS", "RESTORE_CUT_RESTRICTIONS", "SAME_DAY_OWNER_AUTHORIZATION_AND_K3", "INDEPENDENTLY_REVIEWED_SUCCESSOR_AUTHORITY",
)


class Refuse(Exception):
    pass


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


# ─── environment and tool authority ──────────────────────────────────────────────────────────────────────────────────────────────────────
def check_environment() -> None:
    if not sys.flags.isolated:
        raise Refuse("PYTHON_NOT_ISOLATED")
    for name in FORBIDDEN_ENV:
        if os.environ.get(name):
            raise Refuse(f"ENVIRONMENT_OVERRIDE_SET:{name}")
    for name in os.environ:
        if name.startswith(("PYTHON", "LD_")) and name not in ("PYTHONIOENCODING",) and os.environ[name]:
            raise Refuse(f"ENVIRONMENT_OVERRIDE_SET:{name}")


def git(repo: Path, *args: str, check: bool = True) -> bytes:
    env = {"PATH": "/usr/bin:/bin", "LC_ALL": "C", "HOME": "/nonexistent", "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null",
           "GIT_CONFIG_SYSTEM": "/dev/null", "GIT_NO_REPLACE_OBJECTS": "1"}
    r = subprocess.run(["/usr/bin/git", "-C", str(repo), *args], env=env, capture_output=True, check=False)  # noqa: S603
    if check and r.returncode != 0:
        raise Refuse("GIT_READ_FAILED")
    return r.stdout if r.returncode == 0 else b""


def git_blob(repo: Path, main: str, rel: str) -> bytes:
    return git(repo, "show", f"{main}:{rel}")


def pinned_main(repo: Path, main: str) -> None:
    if not HEX40.fullmatch(main):
        raise Refuse("MAIN_NOT_40_HEX")
    if git(repo, "rev-parse", "--verify", f"{main}^{{commit}}", check=False).decode().strip() != main:
        raise Refuse("MAIN_NOT_A_COMMIT_OBJECT")
    if git(repo, "rev-parse", "--verify", "HEAD^{commit}").decode().strip() != main:
        raise Refuse("REPO_HEAD_NOT_THE_PINNED_MAIN")
    if git(repo, "status", "--porcelain"):
        raise Refuse("REPO_NOT_CLEAN")


def verify_self(repo: Path, main: str) -> str:
    here = Path(__file__).resolve()
    if here != (repo / SELF_REL).resolve():
        raise Refuse("TOOL_NOT_RUN_FROM_THE_PINNED_REPO")
    data = here.read_bytes()
    if sha256_bytes(data) != sha256_bytes(git_blob(repo, main, SELF_REL)):
        raise Refuse("TOOL_DIFFERS_FROM_THE_PINNED_MAIN")
    return sha256_bytes(data)


# ─── untrusted-file reading ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
def trusted_read(path: str, stop: Path | None) -> bytes:
    """Read an evidence file: absolute, no `..`, regular, single link, operator/root-owned, not group/world writable, symlink-free parent chain."""
    p = Path(path)
    if not p.is_absolute() or ".." in p.parts or "//" in path:
        raise Refuse("EVIDENCE_PATH_NOT_ABSOLUTE")
    me = os.geteuid()
    cur = Path("/")
    chain = []
    for part in p.parts[1:-1]:
        cur = cur / part
        chain.append(cur)
    for d in chain:
        if stop is not None and d != stop and stop not in d.parents and d not in stop.parents:
            raise Refuse("EVIDENCE_OUTSIDE_THE_TEST_ROOT")
        if stop is not None and d in stop.parents:
            continue  # the climb stops at the private test root (tests only)
        st = os.lstat(d)
        if stat.S_ISLNK(st.st_mode) or not stat.S_ISDIR(st.st_mode):
            raise Refuse("EVIDENCE_PATH_CHAIN_HAS_A_SYMLINK_OR_NON_DIRECTORY")
        if st.st_uid not in (0, me) or st.st_mode & 0o022:
            raise Refuse("EVIDENCE_PATH_CHAIN_UNTRUSTED")
    st = os.lstat(p)
    if not stat.S_ISREG(st.st_mode):
        raise Refuse("EVIDENCE_NOT_A_REGULAR_FILE")
    if st.st_nlink != 1:
        raise Refuse("EVIDENCE_HAS_MULTIPLE_HARD_LINKS")
    if st.st_uid not in (0, me) or st.st_mode & 0o022:
        raise Refuse("EVIDENCE_FILE_OWNER_OR_MODE_UNTRUSTED")
    if st.st_size > MAX_BYTES:
        raise Refuse("EVIDENCE_TOO_LARGE")
    fd = os.open(p, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        st2 = os.fstat(fd)
        if (st2.st_ino, st2.st_dev, st2.st_nlink) != (st.st_ino, st.st_dev, 1):
            raise Refuse("EVIDENCE_CHANGED_WHILE_OPENING")
        return os.read(fd, MAX_BYTES + 1)
    finally:
        os.close(fd)


def parse_kv(data: bytes, what: str, *, allow_prefix_noise: bool = False) -> dict[str, str]:
    try:
        text = data.decode("ascii")
    except UnicodeDecodeError:
        raise Refuse(f"{what}_NOT_ASCII") from None
    if not text.endswith("\n") or "\r" in text or "\n\n" in text or text.startswith("\n") or "\x00" in text:
        raise Refuse(f"{what}_NOT_STRICT_LINES")
    out: dict[str, str] = {}
    for line in text[:-1].split("\n"):
        m = KV.fullmatch(line)
        if not m:
            if allow_prefix_noise:
                continue
            raise Refuse(f"{what}_MALFORMED_LINE")
        k, v = m.group(1), m.group(2)
        if k in out:
            raise Refuse(f"{what}_DUPLICATE_KEY:{k}")
        out[k] = v
    return out


# ─── report ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
class Report:
    def __init__(self) -> None:
        self.facts: list[tuple[str, str]] = []

    def add(self, key: str, value: str) -> None:
        if not re.fullmatch(r"[A-Z0-9_]+", key) or "\n" in str(value):
            raise Refuse("INTERNAL_REPORT_KEY")
        self.facts.append((key, str(value)))

    def lines(self) -> list[str]:
        body = [f"THIRD_SUCCESSOR_{k}={v}" for k, v in self.facts]
        return [*body, f"THIRD_SUCCESSOR_REPORT_SHA256={sha256_bytes(('\n'.join(body) + '\n').encode())}"]


# ─── sections ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
def load_pins(repo: Path, main: str) -> dict[str, str]:
    blob = git(repo, "show", f"{main}:{PINS_REL}", check=False)
    if not blob:
        return {}
    pins = parse_kv(blob, "PINS")
    if set(pins) - set(PIN_KEYS):
        raise Refuse("PINS_UNKNOWN_KEY")
    for k, v in pins.items():
        if k == "THIRD_SUCCESSOR_AUTHORITY_ID":
            ok = bool(ID.fullmatch(v))
        else:
            ok = bool(HEX64.fullmatch(v))
        if not ok:
            raise Refuse(f"PINS_VALUE_INVALID:{k}")
    return pins


def predecessor_gate_anchors(repo: Path, main: str) -> bool:
    """The reviewed Recovery gate must still demand a CTv CLOSED_PASS and refuse a CTv FAIL closeout (static anchors on the exact-main blob)."""
    lib = git_blob(repo, main, RECOVERY_LIB_REL).decode()
    anchors = ("recovery_ctv_successor_gate()", "CTV_RESULT=CLOSED_PASS", "RECOVERY_CTV_FAIL_CLOSEOUT_PRESENT", "CTU_RESULT=FAIL_IMMUTABLE",
               "RECOVERY_CTV_CTU_PASS_MUST_BE_ABSENT", "RECOVERY_ALREADY_CONSUMED")
    return all(a in lib for a in anchors)


def read_history(canon: str, pins: dict[str, str], stop: Path | None) -> tuple[str, str, dict[str, str]]:
    """Returns (HISTORICAL_EVIDENCE, reason, facts)."""
    if not canon:
        return "UNKNOWN", "NO_CANONICAL_DIRECTORY_COPY_SUPPLIED", {}
    cdir = Path(canon)
    if not cdir.is_absolute() or ".." in cdir.parts:
        raise Refuse("CANON_PATH_INVALID")
    try:
        names = sorted(n for n in os.listdir(cdir))
    except PermissionError:
        return "UNKNOWN", "CANONICAL_DIRECTORY_NOT_READABLE", {}
    if any(n.startswith("RECOVERY-") for n in names):
        return "BLOCKED", "RECOVERY_ENTRY_PRESENT_ATTEMPT_ALREADY_CONSUMED_OR_AMBIGUOUS", {}
    ctv = [n for n in names if n.startswith("CTV-")]
    want = ["CTV-GLOBAL-ATTEMPT-CONSUMED", "CTV-GLOBAL-CLOSEOUT-FAIL", "CTV-GLOBAL-CLOSEOUT-FAIL.sha256"]
    if "CTV-GLOBAL-CLOSEOUT-PASS" in ctv:
        return "BLOCKED", "CTV_PASS_AND_FAIL_HISTORIES_CONTRADICT", {}
    if ctv != want:
        return "BLOCKED", "CTV_NAMESPACE_NOT_EXACTLY_ONE_MARKER_ONE_FAIL_CLOSEOUT_AND_ITS_SIDECAR", {}
    closeout_raw = trusted_read(str(cdir / "CTV-GLOBAL-CLOSEOUT-FAIL"), stop)
    marker_raw = trusted_read(str(cdir / "CTV-GLOBAL-ATTEMPT-CONSUMED"), stop)
    sidecar_raw = trusted_read(str(cdir / "CTV-GLOBAL-CLOSEOUT-FAIL.sha256"), stop)
    cs, ms = sha256_bytes(closeout_raw), sha256_bytes(marker_raw)
    if sidecar_raw != f"{cs}  CTV-GLOBAL-CLOSEOUT-FAIL\n".encode():
        return "BLOCKED", "CLOSEOUT_SIDECAR_DOES_NOT_MATCH_THE_CLOSEOUT", {}
    closeout = parse_kv(closeout_raw, "CLOSEOUT")
    marker = parse_kv(marker_raw, "MARKER")
    for k, v in CLOSEOUT_FIXED.items():
        if closeout.get(k) != v:
            return "BLOCKED", f"CLOSEOUT_FIELD_NOT_THE_IMMUTABLE_FAIL:{k}", {}
    for forbidden in ("CTV_RESULT=CLOSED_PASS", "CTV_LIVE=CLOSED_PASS"):
        if forbidden.split("=")[0] in closeout and closeout[forbidden.split("=")[0]] == forbidden.split("=")[1]:
            return "BLOCKED", "CLOSEOUT_CLAIMS_PASS", {}
    if marker.get("CTV_ATTEMPT_CONSUMED") != "YES" or marker.get("CTV_RERUN_ALLOWED") != "NO":
        return "BLOCKED", "CTV_MARKER_NOT_CONSUMED_NO_RERUN", {}
    if marker.get("CTV_FROZEN_RUNNER_SHA256") != closeout.get("CTV_FROZEN_RUNNER_SHA256") or not HEX64.fullmatch(marker.get("CTV_FROZEN_RUNNER_SHA256", "")):
        return "BLOCKED", "MARKER_AND_CLOSEOUT_RUNNER_DIFFER", {}
    ctu_marker, ctu_fail = cdir / "CTU-GLOBAL-ATTEMPT-CONSUMED", cdir / "CTU-GLOBAL-CLOSEOUT-FAIL"
    if "CTU-GLOBAL-CLOSEOUT-PASS" in names:
        return "BLOCKED", "CTU_PASS_PRESENT_CONTRADICTS_THE_RECORDED_HISTORY", {}
    if not (ctu_marker.name in names and ctu_fail.name in names):
        return "UNKNOWN", "CTU_HISTORY_NOT_PRESENT_IN_THE_SUPPLIED_COPY", {}
    ctu = parse_kv(trusted_read(str(ctu_fail), stop), "CTU_CLOSEOUT")
    for k, v in CTU_CLOSEOUT_FIXED.items():
        if ctu.get(k) != v:
            return "BLOCKED", f"CTU_CLOSEOUT_FIELD_INVALID:{k}", {}
    facts = {"CLOSEOUT_SHA256": cs, "MARKER_SHA256": ms}
    if not all(k in pins for k in ("CTV_CLOSEOUT_SHA256", "CTV_MARKER_SHA256", "CTV_UNIT_SHA256")):
        return "UNKNOWN", "NO_REVIEWED_PIN_FOR_THE_CTV_HISTORY_IN_THE_PINNED_MAIN", facts
    if cs != pins["CTV_CLOSEOUT_SHA256"] or ms != pins["CTV_MARKER_SHA256"] or closeout.get("CTV_UNIT_SHA256") != pins["CTV_UNIT_SHA256"]:
        return "BLOCKED", "HISTORY_DIGEST_DIFFERS_FROM_THE_REVIEWED_PIN", facts
    return "VERIFIED", "NONE", facts


def read_transcript(path: str, stop: Path | None, what: str) -> tuple[dict[str, str], bytes]:
    raw = trusted_read(path, stop)
    return parse_kv(raw, what), raw


def judge_attestation(t: dict[str, str], main: str, closeout_sha: str, hermetic: bool, age: float) -> tuple[str, str]:
    """CURRENT_RUNTIME from a transcript of the (separately reviewed) CTv FAIL successor attestation. Never VERIFIED offline."""
    p = "CTV_FAIL_SUCCESSOR_"
    must = {"MODE": "HERMETIC_TEST" if hermetic else "PRODUCTION", "AUTHORITY": "PASS", "EXPECTED_MAIN": main, "CTV_HISTORY": "IMMUTABLE_FAIL",
            "CURRENT_RUNTIME": "PASS", "EVIDENCE_INTEGRITY": "PASS", "HISTORICAL_S10": "FAIL", "PROMOTES_CTV_TO_PASS": "NO", "RECOVERY_AUTHORIZED": "NO",
            "READ_ONLY": "YES", "PRODUCTION_MUTATION": "NO", "ATTEMPT_CONSUMED": "NO", "WIRED_INTO_RECOVERY": "NO"}
    for k, v in must.items():
        if t.get(p + k) != v:
            return "NOT_VERIFIED", f"ATTESTATION_FIELD:{k}"
    if t.get(p + "CLOSEOUT_SHA256") != closeout_sha or not closeout_sha:
        return "NOT_VERIFIED", "ATTESTATION_NOT_BOUND_TO_THE_VERIFIED_CLOSEOUT"
    if t.get(p + "ATTESTATION") not in ("PASS", "PARTIAL"):
        return "NOT_VERIFIED", "ATTESTATION_VERDICT"
    if "TRUSTEDCLOCK_NOW" not in t.get(p + "CURRENT_STATE_SCOPE", ""):
        return "NOT_VERIFIED", "ATTESTATION_SCOPE_LACKS_TRUSTEDCLOCK"
    if age < 0 or age > TRANSCRIPT_MAX_AGE_SECONDS:
        return "NOT_VERIFIED", "ATTESTATION_TRANSCRIPT_STALE"
    return "PARTIAL", "TRANSCRIPT_IS_A_CLAIM_NOT_FRESH_PROOF"


def judge_release(t: dict[str, str], raw: bytes, main: str, pins: dict[str, str], hermetic: bool, age: float) -> tuple[str, str]:
    p = "RECOVERY_RELEASE_PROOF_"
    lines = raw.decode().rstrip("\n").split("\n")
    if not lines or not lines[-1].startswith(p + "PROOF_SHA256="):
        return "UNKNOWN", "RELEASE_PROOF_DIGEST_LINE_MISSING"
    body = "\n".join(lines[:-1]) + "\n"
    if sha256_bytes(body.encode()) != lines[-1].split("=", 1)[1]:
        return "UNKNOWN", "RELEASE_PROOF_DIGEST_MISMATCH"
    must = {"MODE": "HERMETIC_TEST" if hermetic else "PRODUCTION", "MAIN": main, "RECOVERY_AUTHORIZED": "NO", "PRODUCTION_MUTATION": "NO", "READ_ONLY": "YES",
            "HOST_PROOF": "PERFORMED", "PASS_SCOPE": "RELEASE_AND_RESTORE_CLI_IDENTITY_ONLY"}
    for k, v in must.items():
        if t.get(p + k) != v:
            return "UNKNOWN", f"RELEASE_PROOF_FIELD:{k}"
    if t.get(p + "RELEASE_IDENTITY") != "PASS" or t.get(p + "RESTORE_CLI_PROOF") != "PASS" or t.get(p + "VERDICT") != "PASS":
        return "PARTIAL", "RELEASE_PROOF_NOT_COMPLETE"
    if age < 0 or age > TRANSCRIPT_MAX_AGE_SECONDS:
        return "PARTIAL", "RELEASE_PROOF_TRANSCRIPT_STALE"
    if pins.get("RELEASE_SUMS_SHA256") is None or t.get(p + "HOST_RELEASE_SUMS_SHA256") != pins["RELEASE_SUMS_SHA256"]:
        return "PARTIAL", "NO_REVIEWED_RELEASE_SUMS_PIN_OR_MISMATCH"
    if hermetic:
        return "PARTIAL", "HERMETIC_TEST_IS_NEVER_PRODUCTION_EVIDENCE"
    return "VERIFIED", "NONE"


def judge_authorization(path: str, stop: Path | None, main: str, closeout_sha: str, pins: dict[str, str], today: str) -> tuple[str, str]:
    if not path:
        return "NOT_PRESENT", "NO_AUTHORIZATION_FILE_SUPPLIED"
    try:
        a = parse_kv(trusted_read(path, stop), "AUTH")
    except Refuse as e:
        return "INVALID", str(e)
    if set(a) != set(AUTH_KEYS):
        return "INVALID", "AUTH_KEY_SET_NOT_EXACT"
    for k, v in AUTH_FIXED.items():
        if a[k] != v:
            return "INVALID", f"AUTH_FIELD_INVALID:{k}"
    if not ID.fullmatch(a["AUTH_ID"]) or a["AUTH_DATE_UTC"] != today:
        return "INVALID", "AUTH_ID_OR_DATE_NOT_SAME_DAY"
    if a["AUTH_MAIN"] != main or not HEX64.fullmatch(a["AUTH_K3_BINDING_SHA256"]):
        return "INVALID", "AUTH_NOT_BOUND_TO_THE_PINNED_MAIN_OR_K3_MALFORMED"
    if not closeout_sha or a["AUTH_CTV_CLOSEOUT_SHA256"] != closeout_sha:
        return "INVALID", "AUTH_NOT_BOUND_TO_THE_VERIFIED_CTV_CLOSEOUT"
    if pins.get("THIRD_SUCCESSOR_AUTHORITY_ID") is None or a["AUTH_REVIEWED_SUCCESSOR_AUTHORITY_ID"] != pins["THIRD_SUCCESSOR_AUTHORITY_ID"]:
        return "INVALID", "AUTH_NOT_BOUND_TO_A_REVIEWED_SUCCESSOR_AUTHORITY"
    return "PRESENT_NOT_EXECUTED", "STRUCTURE_AND_BINDING_ONLY_AUTHENTICITY_AND_K3_ARE_LIVE_GATE_CHECKS"


# ─── driver ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
def run(args: argparse.Namespace) -> tuple[Report, int]:
    check_environment()
    hermetic = bool(args.hermetic)
    stop: Path | None = None
    if hermetic != bool(args.test_root):
        raise Refuse("TEST_SEAM_INCOMPLETE")
    if hermetic:
        if os.environ.get("RECOVERY_THIRD_SUCCESSOR_TEST_ONLY") != "YES":
            raise Refuse("TEST_SEAM_NOT_ENABLED")
        stop = Path(args.test_root)
        st = os.lstat(stop)
        if not stat.S_ISDIR(st.st_mode) or stat.S_ISLNK(st.st_mode) or st.st_uid != os.geteuid() or st.st_mode & 0o077:
            raise Refuse("TEST_ROOT_UNSAFE")
    repo = Path(args.repo)
    if not repo.is_absolute() or ".." in repo.parts:
        raise Refuse("PATH_NOT_ABSOLUTE")
    main = args.main
    pinned_main(repo, main)
    self_sha = verify_self(repo, main)
    now = float(args.test_now) if hermetic and args.test_now else time.time()
    if not hermetic and args.test_now:
        raise Refuse("TEST_CLOCK_REFUSED")
    today = time.strftime("%Y-%m-%d", time.gmtime(now))

    r = Report()
    r.add("STAGE", STAGE)
    r.add("MODE", "HERMETIC_TEST" if hermetic else "PRODUCTION")
    r.add("MAIN", main)
    r.add("TOOL_SHA256", self_sha)
    r.add("SOURCE_AUTHORITY", "EXACT_MAIN_GIT_OBJECTS_REPLACEMENT_DISABLED")
    pins = load_pins(repo, main)
    r.add("PINS_FILE", "PRESENT_IN_THE_PINNED_MAIN" if pins else "ABSENT_IN_THE_PINNED_MAIN")
    for k in PIN_KEYS:
        r.add(f"PIN_{k}", "PINNED" if k in pins else "UNKNOWN")
    gate_ok = predecessor_gate_anchors(repo, main)
    r.add("RECOVERY_PREDECESSOR_GATE", "STILL_REQUIRES_CTV_CLOSED_PASS_AND_REFUSES_CTV_FAIL" if gate_ok else "ANCHORS_MISSING_GATE_CHANGED")

    status: dict[str, str] = {}
    hist, hist_reason, facts = read_history(args.canon, pins, stop)
    if not gate_ok:
        hist, hist_reason = "BLOCKED", "RECOVERY_PREDECESSOR_GATE_ANCHORS_MISSING"
    closeout_sha = facts.get("CLOSEOUT_SHA256", "") if hist == "VERIFIED" else ""
    r.add("HISTORICAL_EVIDENCE", hist)
    r.add("HISTORICAL_EVIDENCE_REASON", hist_reason)
    for k, v in facts.items():
        r.add(f"OBSERVED_CTV_{k}", v)
    r.add("CTV_FAIL_PROMOTED_TO_PASS", "NO")
    r.add("CTV_RERUN_ALLOWED", "NO")

    runtime, runtime_reason = "NOT_VERIFIED", "NO_ATTESTATION_TRANSCRIPT_SUPPLIED"
    att: dict[str, str] = {}
    if args.attestation:
        try:
            att, raw = read_transcript(args.attestation, stop, "ATTESTATION")
            age = now - os.stat(args.attestation).st_mtime
            runtime, runtime_reason = judge_attestation(att, main, closeout_sha, hermetic, age)
        except Refuse as e:
            runtime, runtime_reason = "NOT_VERIFIED", str(e)
    if hermetic and runtime == "PARTIAL":
        runtime_reason = "HERMETIC_TEST_IS_NEVER_PRODUCTION_EVIDENCE"
    r.add("CURRENT_RUNTIME", runtime)
    r.add("CURRENT_RUNTIME_REASON", runtime_reason)
    r.add("CURRENT_RUNTIME_FRESHNESS", "NOT_PROVEN_OFFLINE_REQUIRES_THE_LIVE_ATTESTATION_AT_APPROVAL_TIME")

    rel, rel_reason = "UNKNOWN", "NO_RELEASE_PROOF_TRANSCRIPT_SUPPLIED"
    if args.release_proof:
        try:
            t, raw = read_transcript(args.release_proof, stop, "RELEASE_PROOF")
            rel, rel_reason = judge_release(t, raw, main, pins, hermetic, now - os.stat(args.release_proof).st_mtime)
        except Refuse as e:
            rel, rel_reason = "UNKNOWN", str(e)
    r.add("RELEASE_CLI", rel)
    r.add("RELEASE_CLI_REASON", rel_reason)

    auth, auth_reason = judge_authorization(args.authorization, stop, main, closeout_sha, pins, today)
    r.add("OWNER_AUTHORIZATION", auth)
    r.add("OWNER_AUTHORIZATION_REASON", auth_reason)
    r.add("OWNER_AUTHORIZATION_AUTHENTICITY", "NOT_VERIFIED_OFFLINE")
    r.add("OWNER_AUTHORIZATION_IS_ATTESTATION_BINDING", "NO")

    prereq = {k: att.get("CTV_FAIL_SUCCESSOR_PREREQ_" + k) for k in ("R1I", "R1B_AUTHORITY", "RECOVERY_ATTEMPT")}
    fresh_ok = runtime == "PARTIAL"
    prereq_pass = fresh_ok and all(v == "PASS" for v in prereq.values())
    detector = "UNKNOWN" if "DETECTOR_UNIT_SHA256" not in pins else ("PARTIAL" if rel in ("PARTIAL", "VERIFIED") else "UNKNOWN")
    pinned_ok = "THIRD_SUCCESSOR_AUTHORITY_ID" in pins
    req = {
        "CTV_IMMUTABLE_FAILURE": "VERIFIED" if hist == "VERIFIED" else ("BLOCKED" if hist == "BLOCKED" else "UNKNOWN"),
        "CTV_CLOSEOUT_DIGEST": "VERIFIED" if hist == "VERIFIED" else ("BLOCKED" if hist == "BLOCKED" else "UNKNOWN"),
        "CONSUMED_ATTEMPT_MARKERS": "VERIFIED" if hist == "VERIFIED" else ("BLOCKED" if hist == "BLOCKED" else "UNKNOWN"),
        "HISTORICAL_S10_FAILURE": "VERIFIED" if hist == "VERIFIED" else ("BLOCKED" if hist == "BLOCKED" else "UNKNOWN"),
        "ROOT_TRUST_BOUNDARIES": "PARTIAL" if hist in ("VERIFIED", "UNKNOWN") else "BLOCKED",
        "CURRENT_RUNTIME_IDENTITY": runtime if runtime != "NOT_VERIFIED" else "UNKNOWN",
        "RELEASE_AND_RESTORE_CLI_PINS": rel,
        "DETECTOR_IDENTITY": detector,
        "FRESH_R1I_R1B_R1BV_FACTS": "PARTIAL" if prereq_pass else "UNKNOWN",
        "TRUSTEDCLOCK_AND_EVENT_PROVENANCE": "PARTIAL" if fresh_ok else "UNKNOWN",
        "SINGLE_ATTEMPT_SEMANTICS": "PARTIAL" if prereq.get("RECOVERY_ATTEMPT") == "PASS" and fresh_ok else "UNKNOWN",
        "NON_RETRY_CONSTRAINTS": "VERIFIED" if hist == "VERIFIED" else "UNKNOWN",
        "RESTORE_CUT_RESTRICTIONS": "UNKNOWN",
        "SAME_DAY_OWNER_AUTHORIZATION_AND_K3": "PARTIAL" if auth == "PRESENT_NOT_EXECUTED" else "UNKNOWN",
        "INDEPENDENTLY_REVIEWED_SUCCESSOR_AUTHORITY": "PARTIAL" if pinned_ok else "UNKNOWN",
    }
    assert tuple(req) == REQUIREMENTS
    for k in REQUIREMENTS:
        r.add(f"REQUIREMENT_{k}", req[k])
    r.add("REQUIREMENT_RESTORE_CUT_RESTRICTIONS_NOTE", "NOT_DEFINED_BY_ANY_REVIEWED_REPOSITORY_SOURCE_NEEDS_A_GOVERNANCE_DECISION")

    if hist == "BLOCKED":
        readiness = "BLOCKED"
    elif (hist == "VERIFIED" and runtime == "PARTIAL" and rel == "VERIFIED" and prereq_pass and detector in ("PARTIAL", "VERIFIED")
          and auth == "PRESENT_NOT_EXECUTED" and pinned_ok and not hermetic):
        readiness = "AWAITING_APPROVAL"
    else:
        readiness = "PARTIAL"
    if hermetic and readiness == "AWAITING_APPROVAL":
        readiness = "PARTIAL"
    r.add("READINESS", readiness)
    r.add("MISSING_OWNER_EVIDENCE", ",".join(k for k, v in req.items() if v in ("UNKNOWN", "PARTIAL")) or "NONE")
    r.add("NOT_AN_AUTHORIZATION", "THIS_REPORT_IS_NOT_A_TOKEN_NO_GATE_ACCEPTS_IT")
    r.add("RECOVERY_AUTHORIZED", "NO")
    r.add("RECOVERY_EXECUTED", "NO")
    r.add("PRODUCTION_MUTATION", "NO")
    r.add("MARKER_CREATED_OR_CONSUMED", "NO")
    r.add("READ_ONLY", "YES")
    r.add("WIRED_INTO_RECOVERY", "NO")
    return r, {"BLOCKED": 2, "PARTIAL": 3, "AWAITING_APPROVAL": 4}[readiness]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0], allow_abbrev=False)
    ap.add_argument("--repo", required=True)
    ap.add_argument("--main", required=True)
    ap.add_argument("--canon", default="")
    ap.add_argument("--attestation", default="")
    ap.add_argument("--release-proof", default="")
    ap.add_argument("--authorization", default="")
    ap.add_argument("--hermetic", action="store_true")
    ap.add_argument("--test-root", default="")
    ap.add_argument("--test-now", default="")
    args = ap.parse_args()
    try:
        report, code = run(args)
    except Refuse as e:
        print(f"THIRD_SUCCESSOR_VERDICT=FAIL reason={e}")
        print("THIRD_SUCCESSOR_RECOVERY_AUTHORIZED=NO")
        return 1
    except (OSError, UnicodeError) as e:
        print(f"THIRD_SUCCESSOR_VERDICT=FAIL reason=IO_ERROR:{type(e).__name__}")
        print("THIRD_SUCCESSOR_RECOVERY_AUTHORIZED=NO")
        return 1
    print("\n".join(report.lines()))
    return code


if __name__ == "__main__":
    sys.exit(main())
