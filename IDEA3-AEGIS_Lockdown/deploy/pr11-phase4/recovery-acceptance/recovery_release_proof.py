#!/usr/bin/env python3
"""Recovery RELEASE / RESTORE-CLI identity proof (repository tooling; READ-ONLY; authorises NOTHING; runs no stage and no command on the host).

Recovery pins a release id, the digest of that release's manifest, and the digest of the restore CLI inside it. This tool establishes which of those facts can be TRUSTED and
which cannot, deterministically, and says so in machine-readable form.

TRUSTED SOURCE AUTHORITY (derived, never supplied):
  * the exact-main Git objects (replacement objects disabled; repository HEAD must be the pinned main);
  * the ONE canonical RRu LIVE closeout receipt at that main (the reviewed record of which immutable release was deployed): it names the release id, no other receipt may name or contradict it;
  * the release id is the 40-hex source commit of that release; it must be a real commit object and an ancestor of the pinned main;
  * the Recovery restore CLI, Recovery Core and production detector digests are the SHA-256 of the blobs at THAT release commit (the release carries exactly the merged runtime of its source commit).
INPUTS THAT CANNOT BE DERIVED FROM THE REPOSITORY (owner-supplied, reported as such, never invented here):
  * RELEASE_SUMS_SHA256, the digest of the deployed release's RELEASE-SHA256SUMS (it covers the venv, which only the host holds). It is accepted only as a pin that the HOST must match
    byte for byte; a pin that merely matches itself proves nothing, so the verdict is PASS only when the host release also passes the reviewed release guard.

What it checks on the host (``--host``): the reviewed ``p4-l7-release-guard.py`` (layout, no symlink or special file, nothing group/world writable, root ownership, RELEASE-SHA256SUMS matches EVERY payload
file, manifest fields), the release path and the ``current`` link under a root-owned non-writable ancestor chain, the manifest release id and source commit, every ``aegis_soc`` entry of the manifest against
the release-commit blob, the restore CLI / Core / detector digests, the interpreter, and that ``current`` names exactly this release. With ``--frozen-runner`` it also refuses any frozen pin that is not the derived value.

Output: stable ``RECOVERY_RELEASE_PROOF_<KEY>=<VALUE>`` lines plus ``PROOF_SHA256`` over them. Exit status: 0 only for VERDICT=PASS (release and restore-CLI IDENTITY only), 3 for PARTIAL (something is UNKNOWN or was not
performed), 1 for FAIL (a contradiction, tamper, invented pin or untrusted authority). It NEVER states that Recovery is authorized or ready.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import os
import re
import stat
import subprocess
import sys
import types
from pathlib import Path

STAGE = "Recovery-release-cli-proof"
APP_REL = "IDEA3-AEGIS_Lockdown"
P4_REL = f"{APP_REL}/deploy/pr11-phase4"
ACC_REL = f"{P4_REL}/recovery-acceptance"
LOGS_REL = "Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs"
RRU_SUFFIX = "_music_idea3-rru-live-closeout.md"
RELEASES_BASE = "/opt/aegis-idea3/releases"
CURRENT_LINK = "/opt/aegis-idea3/current"
TEST_ENV = "RECOVERY_RELEASE_PROOF_TEST_ONLY"
SHA1 = re.compile(r"[0-9a-f]{40}")
SHA256 = re.compile(r"[0-9a-f]{64}")
# Files this tool executes or imports: each must equal its exact-main blob BEFORE it is loaded, and is loaded from the very bytes that were hashed.
TOOL_FILES = {
    "guard": f"{P4_REL}/p4-l7-release-guard.py",
    "snapshot": f"{ACC_REL}/recovery_verifier_snapshot.py",
    "freeze": f"{ACC_REL}/recovery_runner_freeze.py",
}
SELF_REL = f"{ACC_REL}/recovery_release_proof.py"
# The receipt fields that must live in the ONE canonical RRu closeout and in no other receipt (the release-specific claims).
RRU_UNIQUE = (
    ("RRU_LIVE", "CLOSED_PASS"), ("RRU_LIVE_EXECUTED", "YES"), ("RRU_RESULT", "PASS"), ("RRU_PRODUCTION_DEPLOYED", "YES"), ("RRU_ATTEMPT_CONSUMED", "YES"), ("RRU_RERUN_ALLOWED", "NO"),
    ("RECOVERY_RUNTIME_RELEASE_READY", "YES"), ("NEW_RELEASE_IS_OLD_PLUS_CLI_ONLY", "YES"), ("RRU_RECOVERY_EXECUTED", "NO"),
)
# Fields the canonical closeout must also carry; many receipts legitimately restate them, so they are required here but not required to be unique.
RRU_PRESENT = (("RECOVERY_ATTEMPT_CONSUMED", "NO"), ("RECOVERY_LIVE_EXECUTED", "NO"), ("RECOVERY_R2_R8_EXECUTED", "NO"))
# A claim like these anywhere in the receipts contradicts "Recovery has not run" and makes the release record untrustworthy.
CONTRADICTIONS = (
    ("RECOVERY_R2_R8_EXECUTED", "YES"), ("RECOVERY_R1_R8_PROVEN", "YES"), ("RECOVERY_RESULT", "PASS"), ("F1_REAL_DETECTOR_ACCEPTANCE", "PROVEN"), ("R1_VERIFIED", "VERIFIED"),
    ("LVR_PROVEN", "YES"), ("L8_ACCEPTANCE", "YES"), ("L9_PROVEN", "YES"), ("RRU_RECOVERY_EXECUTED", "YES"), ("RRU_INCIDENT_MUTATED", "YES"),
)
# aegis_soc files whose release-commit blob digests are derived; the first three are Recovery pin candidates, the rest must merely exist in the release.
DERIVED_PINS = (("RESTORE_CLI_SHA256", "cli.py"), ("RECOVERY_CORE_SHA256", "recovery_core.py"), ("PRODUCTION_DETECTOR_SHA256", "production_detector.py"))
REQUIRED_IN_RELEASE = ("cli.py", "recovery_core.py", "production_detector.py", "historical_disposition.py", "supervisor.py")


class ProofError(Exception):
    """A hard refusal: the proof FAILS (exit 1)."""


class Report:
    """Ordered KEY=VALUE facts. The proof digest covers every fact except itself."""

    def __init__(self) -> None:
        self.facts: list[tuple[str, str]] = []
        self.unknown: list[str] = []

    def add(self, key: str, value: str) -> None:
        assert re.fullmatch(r"[A-Z0-9_]+", key) and "\n" not in str(value)
        self.facts.append((key, str(value)))

    def lines(self) -> list[str]:
        body = [f"RECOVERY_RELEASE_PROOF_{k}={v}" for k, v in self.facts]
        digest = hashlib.sha256(("\n".join(body) + "\n").encode()).hexdigest()
        return [*body, f"RECOVERY_RELEASE_PROOF_PROOF_SHA256={digest}"]


# ------------------------------------------------------------------------------------------------------------------------------- Git (exact-main objects)
def _git_env() -> dict[str, str]:
    return {"PATH": "/usr/bin:/bin", "HOME": "/nonexistent", "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_SYSTEM": "/dev/null", "GIT_NO_REPLACE_OBJECTS": "1", "LC_ALL": "C"}


def git(repo: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess[bytes]:
    done = subprocess.run(["git", "-C", str(repo), *args], capture_output=True, env=_git_env(), stdin=subprocess.DEVNULL, check=False)
    if check and done.returncode != 0:
        raise ProofError("GIT_READ_FAILED")
    return done


def git_blob(repo: Path, commit: str, path: str) -> bytes:
    done = git(repo, "show", f"{commit}:{path}", check=False)
    if done.returncode != 0:
        raise ProofError(f"GIT_OBJECT_MISSING:{path}")
    return done.stdout


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def pinned_main(repo: Path, main: str) -> None:
    if not SHA1.fullmatch(main):
        raise ProofError("MAIN_MALFORMED")
    if git(repo, "rev-parse", "--verify", f"{main}^{{commit}}", check=False).stdout.decode().strip() != main:
        raise ProofError("MAIN_NOT_A_COMMIT_OBJECT")
    if git(repo, "rev-parse", "--verify", "HEAD^{commit}").stdout.decode().strip() != main:
        raise ProofError("REPO_HEAD_NOT_THE_PINNED_MAIN")


# --------------------------------------------------------------------------------------------------------------------- tool authority (hash before load)
def load_verified(repo: Path, main: str, key: str, tool_dir: Path) -> types.ModuleType:
    """Load a sibling tool from the bytes that were hashed against the exact-main blob (no second read between check and use)."""
    rel = TOOL_FILES[key]
    path = (tool_dir.parent if key == "guard" else tool_dir) / rel.rsplit("/", 1)[1]   # the guard sits one directory above recovery-acceptance/
    try:
        data = path.read_bytes()
    except OSError:
        raise ProofError(f"TOOL_FILE_UNREADABLE:{key}") from None
    if path.is_symlink() or sha256_bytes(data) != sha256_bytes(git_blob(repo, main, rel)):
        raise ProofError(f"TOOL_FILE_DIFFERS_FROM_THE_PINNED_MAIN:{key}")
    name = "recovery_verifier_snapshot" if key == "snapshot" else f"_rrp_{key}"
    module = types.ModuleType(name)
    module.__file__ = str(path)
    sys.modules[name] = module
    exec(compile(data, str(path), "exec"), module.__dict__)  # noqa: S102 - the bytes are the hashed, reviewed exact-main blob
    return module


def verify_self(repo: Path, main: str) -> None:
    me = Path(os.path.abspath(__file__))
    if me.is_symlink() or sha256_bytes(me.read_bytes()) != sha256_bytes(git_blob(repo, main, SELF_REL)):
        raise ProofError("TOOL_FILE_DIFFERS_FROM_THE_PINNED_MAIN:self")
    if me.stat().st_mode & (stat.S_IWGRP | stat.S_IWOTH):
        raise ProofError("TOOL_FILE_GROUP_OR_WORLD_WRITABLE:self")


# ------------------------------------------------------------------------------------------------------------------------- derive trusted pins (repository)
def _field_re(name: str, value: str) -> re.Pattern[str]:
    return re.compile(rf"^[ \t]*(?:[-*][ \t]+)?`?{re.escape(name)}[ \t]*=[ \t]*{re.escape(value)}`?[ \t]*$", re.M)


def read_logs(repo: Path, main: str) -> dict[str, str]:
    listing = git(repo, "ls-tree", "-r", "--name-only", main, "--", LOGS_REL).stdout.decode().splitlines()
    out: dict[str, str] = {}
    for rel in listing:
        if rel.endswith(".md"):
            out[rel] = git_blob(repo, main, rel).decode("utf-8", errors="replace")
    return out


def derive(repo: Path, main: str, report: Report) -> dict[str, str]:
    """Everything below comes from exact-main Git objects. Anything ambiguous, contradictory or missing is a refusal."""
    logs = read_logs(repo, main)
    canonical = [rel for rel in logs if rel.endswith(RRU_SUFFIX)]
    if len(canonical) != 1:
        raise ProofError("RRU_CLOSEOUT_MISSING_OR_AMBIGUOUS")
    receipt = canonical[0]
    for name, value in RRU_UNIQUE:
        holders = sorted(rel for rel, text in logs.items() if _field_re(name, value).search(text))
        if holders != [receipt]:
            raise ProofError(f"RRU_FIELD_NOT_ONLY_IN_THE_CANONICAL_CLOSEOUT:{name}")
    for name, value in RRU_PRESENT:
        if not _field_re(name, value).search(logs[receipt]):
            raise ProofError(f"RRU_FIELD_MISSING_FROM_THE_CANONICAL_CLOSEOUT:{name}")
    for name, value in CONTRADICTIONS:
        if any(_field_re(name, value).search(text) for text in logs.values()):
            raise ProofError(f"CONTRADICTORY_CLAIM:{name}")
    ids = {rel: set(re.findall(r"^[ \t]*(?:[-*][ \t]+)?`?RRU_RELEASE_ID[ \t]*=[ \t]*([^`\s]+)`?[ \t]*$", text, re.M)) for rel, text in logs.items()}
    holders = {rel for rel, found in ids.items() if found}
    if holders != {receipt} or len(ids[receipt]) != 1:
        raise ProofError("RELEASE_ID_NOT_UNIQUE")
    release_id = next(iter(ids[receipt]))
    if not SHA1.fullmatch(release_id):
        raise ProofError("RELEASE_ID_NOT_A_COMMIT_ID")
    if git(repo, "cat-file", "-t", release_id, check=False).stdout.decode().strip() != "commit":
        raise ProofError("RELEASE_COMMIT_NOT_A_COMMIT_OBJECT")
    if git(repo, "merge-base", "--is-ancestor", release_id, main, check=False).returncode != 0:
        raise ProofError("RELEASE_COMMIT_NOT_AN_ANCESTOR_OF_MAIN")
    derived = {"release_id": release_id, "release_commit": release_id, "receipt": receipt, "receipt_sha256": sha256_bytes(logs[receipt].encode())}
    report.add("SOURCE_AUTHORITY", "EXACT_MAIN_GIT_OBJECTS_REPLACEMENT_DISABLED")
    report.add("RRU_CLOSEOUT_RECEIPT", receipt)
    report.add("RRU_CLOSEOUT_RECEIPT_SHA256", derived["receipt_sha256"])
    report.add("RELEASE_ID", release_id)
    report.add("RELEASE_COMMIT_IS_ANCESTOR_OF_MAIN", "YES")
    for rel in REQUIRED_IN_RELEASE:
        derived[f"blob:{rel}"] = sha256_bytes(git_blob(repo, release_id, f"{APP_REL}/aegis_soc/{rel}"))
    for pin, rel in DERIVED_PINS:
        derived[pin] = derived[f"blob:{rel}"]
        report.add(f"DERIVED_{pin}", derived[pin])
        at_main = sha256_bytes(git_blob(repo, main, f"{APP_REL}/aegis_soc/{rel}")) if git(repo, "cat-file", "-e", f"{main}:{APP_REL}/aegis_soc/{rel}", check=False).returncode == 0 else "ABSENT"
        report.add(f"{pin}_AT_MAIN_DIFFERS_FROM_RELEASE", "NO" if at_main == derived[pin] else "YES")
    report.add("PIN_SOURCE_OF_RELEASE_ID_AND_SOURCE_DIGESTS", "DERIVED_FROM_THE_PINNED_MAIN_NOT_SUPPLIED")
    return derived


# --------------------------------------------------------------------------------------------------------------------------------- frozen-runner pins
def check_frozen(repo: Path, main: str, derived: dict[str, str], frozen: Path, freeze: types.ModuleType, report: Report) -> str | None:
    try:
        text = frozen.read_text(encoding="utf-8")
        values = freeze.check_equivalence(freeze.read_template(repo, main), text)
    except (OSError, UnicodeDecodeError, freeze.FreezeError) as exc:
        raise ProofError(f"FROZEN_RUNNER_NOT_THE_REVIEWED_TEMPLATE:{str(exc)[:80]}") from None
    if values["EXPECTED_MAIN"] != main:
        raise ProofError("FROZEN_EXPECTED_MAIN_IS_NOT_THE_PINNED_MAIN")
    wrong = []
    for name, expected in (("RELEASE_ID", derived["release_id"]), *[(pin, derived[pin]) for pin, _ in DERIVED_PINS]):
        ok = values[name] == expected
        report.add(f"FROZEN_PIN_{name}", "MATCHES_THE_DERIVED_VALUE" if ok else "NOT_THE_DERIVED_VALUE")
        if not ok:
            wrong.append(name)
    if wrong:
        raise ProofError("INVENTED_OR_STALE_PIN:" + ",".join(wrong))
    report.add("FROZEN_PIN_RELEASE_SUMS_SHA256", "OWNER_SUPPLIED_NOT_DERIVABLE_FROM_THE_REPOSITORY")
    return values["RELEASE_SUMS_SHA256"]


# ------------------------------------------------------------------------------------------------------------------------------------- host verification
def host_paths(hermetic: bool, test_root: Path | None, release_id: str) -> tuple[Path, Path, str]:
    base = Path(RELEASES_BASE)
    current = Path(CURRENT_LINK)
    if hermetic:
        assert test_root is not None
        base, current = test_root / RELEASES_BASE.lstrip("/"), test_root / CURRENT_LINK.lstrip("/")
    return base / release_id, current, f"{RELEASES_BASE}/{release_id}"


def verify_host(repo: Path, main: str, derived: dict[str, str], *, guard: types.ModuleType, snapshot: types.ModuleType, hermetic: bool, test_root: Path | None, sums_pin: str | None,
                report: Report) -> None:
    release_id = derived["release_id"]
    owner_uid = os.getuid() if hermetic else snapshot.PRODUCTION_OWNER_UID
    trust = str(test_root) if hermetic else snapshot.PRODUCTION_TRUST_ROOT
    release, current, logical = host_paths(hermetic, test_root, release_id)
    try:
        snapshot.check_trusted_path(release, owner_uid, trust)
        snapshot.check_tree_owner(release, owner_uid)
    except snapshot.SnapshotError as exc:
        raise ProofError(f"RELEASE_PATH_NOT_TRUSTED:{str(exc)[:100]}") from None
    report.add("HOST_RELEASE_PATH_TRUST_CHAIN", "PASS")
    try:
        guard_id, guard_sha = guard.check(logical, release, "any" if hermetic else "root")
    except UnicodeDecodeError:
        raise ProofError("RELEASE_GUARD_INPUT_UNDECODABLE") from None
    except (OSError, ValueError):
        raise ProofError("RELEASE_GUARD_INPUT_MALFORMED") from None
    except guard.Refusal as exc:
        raise ProofError(f"RELEASE_GUARD_REFUSED:{exc}") from None
    if guard_id != release_id or guard_sha != derived["release_commit"]:
        raise ProofError("MANIFEST_SOURCE_COMMIT_NOT_THE_RELEASE_COMMIT")
    report.add("HOST_RELEASE_GUARD", "PASS")
    report.add("HOST_MANIFEST_RELEASE_ID_AND_SOURCE_COMMIT", "MATCH_THE_DERIVED_RELEASE")
    sums_path = release / guard.SUMS
    try:
        sums_bytes = sums_path.read_bytes()
    except OSError:
        raise ProofError("RELEASE_SUMS_UNREADABLE") from None
    try:
        sums_text = sums_bytes.decode("utf-8")
    except UnicodeDecodeError:
        raise ProofError("RELEASE_SUMS_UNDECODABLE") from None
    listed = {}
    for line in sums_text.splitlines():
        parsed = re.fullmatch(r"([0-9a-f]{64})  (\S.*)", line)
        if not parsed:
            raise ProofError("RELEASE_SUMS_LINE_MALFORMED")
        digest, rel = parsed.groups()
        listed[rel] = digest
    aegis = {rel: digest for rel, digest in listed.items() if rel.startswith("aegis_soc/")}
    if len(aegis) < 3:
        raise ProofError("RELEASE_CONTENT_TOO_SMALL")
    for rel, digest in sorted(aegis.items()):
        try:
            want = sha256_bytes(git_blob(repo, derived["release_commit"], f"{APP_REL}/{rel}"))
        except ProofError:
            want = None  # a manifested file the release commit does not contain is not the release commit's source either
        if want != digest:
            raise ProofError(f"RELEASE_CONTENT_NOT_THE_RELEASE_COMMIT_SOURCE:{rel}")
    for needed in REQUIRED_IN_RELEASE:
        if f"aegis_soc/{needed}" not in aegis:
            raise ProofError(f"RELEASE_FILE_NOT_MANIFESTED:{needed}")
    report.add("HOST_AEGIS_SOC_ENTRIES_EQUAL_THE_RELEASE_COMMIT", str(len(aegis)))
    for pin, rel in DERIVED_PINS:
        host_digest = sha256_bytes((release / "aegis_soc" / rel).read_bytes())
        if host_digest != derived[pin] or aegis[f"aegis_soc/{rel}"] != host_digest:
            raise ProofError(f"HOST_FILE_NOT_THE_DERIVED_{pin}")
    report.add("HOST_RESTORE_CLI_SHA256", derived["RESTORE_CLI_SHA256"])
    report.add("HOST_RESTORE_CLI_IS_A_MANIFESTED_ENTRY", "YES")
    interpreter = release / "venv" / "bin" / "python"
    info = interpreter.lstat()
    if not stat.S_ISREG(info.st_mode) or not os.access(interpreter, os.X_OK) or info.st_uid != owner_uid:
        raise ProofError("INTERPRETER_NOT_A_TRUSTED_EXECUTABLE")
    interpreter_digest = sha256_bytes(interpreter.read_bytes())
    if listed.get("venv/bin/python") != interpreter_digest:
        raise ProofError("INTERPRETER_NOT_A_MANIFESTED_ENTRY")
    report.add("HOST_INTERPRETER_SHA256", interpreter_digest)
    link_info = os.lstat(current) if os.path.lexists(current) else None
    if link_info is None or not stat.S_ISLNK(link_info.st_mode):
        raise ProofError("CURRENT_LINK_MISSING_OR_NOT_A_SYMLINK")
    if link_info.st_uid != owner_uid or os.readlink(current) != str(release):
        raise ProofError("CURRENT_LINK_NOT_THE_RELEASE")
    try:
        snapshot.check_trusted_path(current.parent, owner_uid, trust)
    except snapshot.SnapshotError as exc:
        raise ProofError(f"CURRENT_LINK_PARENT_NOT_TRUSTED:{str(exc)[:80]}") from None
    report.add("HOST_CURRENT_LINK_NAMES_THIS_RELEASE", "YES")
    observed = sha256_bytes(sums_bytes)
    if sums_pin is None:
        report.add("HOST_RELEASE_SUMS_SHA256_OBSERVED_NOT_A_PIN", observed)
        report.add("RELEASE_SUMS_SHA256", "UNKNOWN")
        report.unknown.append("RELEASE_SUMS_SHA256")
        return
    if not SHA256.fullmatch(sums_pin) or sums_pin != observed:
        raise ProofError("RELEASE_SUMS_PIN_NOT_THE_HOST_MANIFEST")
    report.add("HOST_RELEASE_SUMS_SHA256", observed)
    report.add("RELEASE_SUMS_SHA256", "OWNER_PIN_MATCHES_THE_HOST_MANIFEST_WHICH_PASSES_THE_RELEASE_GUARD")


# ---------------------------------------------------------------------------------------------------------------------------------------------- driver
def _hermetic_ok(test_root: Path, snapshot_module: types.ModuleType | None) -> None:
    if os.environ.get(TEST_ENV) != "YES":
        raise ProofError("HERMETIC_REQUIRES_THE_TEST_ENVIRONMENT")
    root = Path(os.path.abspath(test_root))
    if root != Path(os.path.realpath(root)) or not root.is_dir() or str(root) == "/":
        raise ProofError("TEST_ROOT_INVALID")
    for forbidden in ("/opt", "/etc", "/usr", "/boot", "/bin", "/sbin", "/lib", "/root", "/var/lib", "/run"):
        if str(root) == forbidden or str(root).startswith(forbidden + "/"):
            raise ProofError("TEST_ROOT_UNSAFE")
    st = root.stat()
    if st.st_uid != os.getuid() or st.st_mode & (stat.S_IWGRP | stat.S_IWOTH):
        raise ProofError("TEST_ROOT_NOT_PRIVATE")
    if os.getuid() == 0:
        parts = Path("/proc/self/uid_map").read_text().split() if Path("/proc/self/uid_map").exists() else []
        if parts[:3] == ["0", "0", "4294967295"]:
            raise ProofError("TEST_SEAM_REFUSED_IN_THE_REAL_ROOT_NAMESPACE")


def run(args: argparse.Namespace) -> tuple[Report, str]:
    report = Report()
    repo, main = Path(args.repo), args.main
    hermetic = bool(args.hermetic)
    test_root = Path(args.test_root) if args.test_root else None
    if hermetic != (test_root is not None):
        raise ProofError("TEST_SEAM_INCOMPLETE")
    if hermetic:
        _hermetic_ok(test_root, None)
    elif os.getuid() != 0 and args.host:
        raise ProofError("ROOT_REQUIRED_FOR_THE_HOST_PROOF")
    report.add("STAGE", STAGE)
    report.add("MODE", "HERMETIC_TEST" if hermetic else "PRODUCTION")
    report.add("MAIN", main)
    for path in (repo, Path(args.frozen_runner) if args.frozen_runner else repo):
        if not path.is_absolute() or ".." in path.parts:
            raise ProofError("PATH_NOT_ABSOLUTE")
    pinned_main(repo, main)
    verify_self(repo, main)
    tool_dir = Path(os.path.abspath(__file__)).parent
    snapshot = load_verified(repo, main, "snapshot", tool_dir)
    freeze = load_verified(repo, main, "freeze", tool_dir)
    guard = load_verified(repo, main, "guard", tool_dir)
    if not hermetic:
        try:
            snapshot.check_tool_authority(snapshot.PRODUCTION_TRUST_ROOT, tool_dir)
            snapshot.check_trusted_path(repo, snapshot.PRODUCTION_OWNER_UID, snapshot.PRODUCTION_TRUST_ROOT)
        except snapshot.SnapshotError as exc:
            raise ProofError(f"TOOL_OR_REPOSITORY_AUTHORITY_NOT_TRUSTED:{str(exc)[:100]}") from None
    report.add("TOOL_AUTHORITY", "EXACT_MAIN_BLOBS_LOADED_FROM_THE_HASHED_BYTES")
    derived = derive(repo, main, report)
    sums_pin = args.release_sums_sha256
    if sums_pin is not None and not SHA256.fullmatch(sums_pin):
        raise ProofError("RELEASE_SUMS_PIN_MALFORMED")
    if args.frozen_runner:
        frozen_pin = check_frozen(repo, main, derived, Path(args.frozen_runner), freeze, report)
        if sums_pin is not None and sums_pin != frozen_pin:
            raise ProofError("RELEASE_SUMS_PIN_DISAGREES_WITH_THE_FROZEN_RUNNER")
        sums_pin = frozen_pin
    if args.host:
        verify_host(repo, main, derived, guard=guard, snapshot=snapshot, hermetic=hermetic, test_root=test_root, sums_pin=sums_pin, report=report)
        report.add("HOST_PROOF", "PERFORMED")
    else:
        report.add("HOST_PROOF", "NOT_PERFORMED")
        report.unknown.append("HOST_RELEASE_AND_CLI_STATE")
        if sums_pin is None:
            report.add("RELEASE_SUMS_SHA256", "UNKNOWN")
            report.unknown.append("RELEASE_SUMS_SHA256")
    report.unknown = sorted(set(report.unknown))
    complete = args.host and not report.unknown
    report.add("RELEASE_IDENTITY", "PASS" if complete else "UNKNOWN")
    report.add("RESTORE_CLI_PROOF", "PASS" if complete else "UNKNOWN")
    report.add("MANIFEST_PROOF", "PASS" if complete else "UNKNOWN")
    report.add("UNKNOWN_INPUTS", ",".join(report.unknown) if report.unknown else "NONE")
    report.add("NOT_PROVEN_BY_THIS_TOOL", "INTERPRETER_AND_VENV_CONTENT_BEYOND_THE_HOST_MANIFEST,DETECTOR_UNIT_SHA256,CORE_AND_DETECTOR_RUNTIME_STATE,RECOVERY_AUTHORIZATION_INPUTS")
    report.add("PASS_SCOPE", "RELEASE_AND_RESTORE_CLI_IDENTITY_ONLY")
    report.add("RECOVERY_AUTHORIZED", "NO")
    report.add("RECOVERY_READINESS", "NOT_ASSESSED")
    report.add("READ_ONLY", "YES")
    report.add("PRODUCTION_MUTATION", "NO")
    verdict = "PASS" if complete else "PARTIAL"
    report.add("VERDICT", verdict)
    return report, verdict


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--repo", required=True)
    parser.add_argument("--main", required=True)
    parser.add_argument("--host", action="store_true", help="also verify the deployed release on this host (root; read-only)")
    parser.add_argument("--frozen-runner", help="refuse any frozen pin that is not the derived value")
    parser.add_argument("--release-sums-sha256", help="owner-supplied pin of the deployed RELEASE-SHA256SUMS (verified against the host, never trusted by itself)")
    parser.add_argument("--hermetic", action="store_true")
    parser.add_argument("--test-root")
    args = parser.parse_args(argv)
    try:
        report, verdict = run(args)
    except ProofError as exc:
        print(f"RECOVERY_RELEASE_PROOF_VERDICT=FAIL reason={str(exc)[:200]}", file=sys.stderr)
        print("RECOVERY_RELEASE_PROOF_RECOVERY_AUTHORIZED=NO", file=sys.stderr)
        return 1
    print("\n".join(report.lines()))
    return 0 if verdict == "PASS" else 3


if __name__ == "__main__":
    raise SystemExit(main())
