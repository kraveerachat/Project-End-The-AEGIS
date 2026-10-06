"""R1Bv: READ-ONLY successor validation of the EXISTING, immutably FAILED R1B attempt's evidence.

R1Bv is NOT a retry, replay, new observation window, new external event or repair of the missing window record. R1B stays ``R1B_RESULT=FAIL_IMMUTABLE``. This module opens SQLite only ``mode=ro`` (through
``r1_acceptance``), runs only the fixed read-only ``systemctl show`` / ``journalctl`` argvs, has no socket, no marker or window-record writer and no incident/audit write. It never creates
``R1B-ATTEMPT-WINDOW``: the historical bound it derives is a validation bound only.

Time authority (no widening, no grace):

* PRIMARY lower bound ``L`` is the ROOT-OWNED canonical marker ``R1B-GLOBAL-ATTEMPT-CONSUMED`` (lstat/O_NOFOLLOW, owner uid, not group/world writable, trusted ancestors, exact ``consumed_at`` content
  agreeing with the file's modification time; ``L`` = ``st_mtime_ns``). The deadline is ``D = L + 600``.
* The operator-writable authorization-local marker and the preserved runner output are CORROBORATION only: each must exist, parse and agree with ``L`` within ``CORROBORATION_TOLERANCE_SEC``; they
  can never set or move the bound.
* Every chain time must lie inside ``[L, D]``. ``r1_acceptance.verify`` (unchanged, fail-closed) tolerates a small skew, so R1Bv feeds it ONLY evidence pre-filtered to ``[L, D]`` and then re-checks every
  chain time strictly.

The interpretation of the evidence is the existing ``r1_acceptance`` verifier over the PRESERVED R1B baseline (never invented). Current TrustedClock state is handled by the runner and proves the R1Bv
environment only. This module can never promote a claim: every document carries the unpromoted claim boundary.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import stat
import sys
import time
from calendar import timegm
from pathlib import Path
from typing import Any, Callable

from . import r1_acceptance as r1
from .ip_containment import ContainmentRejected, validate_block_target

BASELINE_SCHEMA = "aegis.idea3.r1bv-baseline/1"
RESULT_SCHEMA = "aegis.idea3.r1bv-result/1"
OBSERVE_SECONDS = 600  # the pinned R1B observation duration; a constant, never an input
CORROBORATION_TOLERANCE_SEC = 2.0
BASELINE_MAX_LEAD_SEC = 900.0  # the preserved pre-consume baseline must precede the marker closely
CANONICAL_MARKER = "/var/lib/aegis-idea3-governance/R1B-GLOBAL-ATTEMPT-CONSUMED"
WINDOW_RECORD_NAME = "R1B-ATTEMPT-WINDOW"
MAX_FILE_BYTES = 262144
CLAIMS = {
    "F1_REAL_DETECTOR_ACCEPTANCE": "NOT_PROVEN", "R1_VERIFIED": "NOT_CLAIMED", "RECOVERY_R1_R8_PROVEN": "NO", "RECOVERY_R2_R8_EXECUTED": "NO",
    "R1B_RESULT": "FAIL_IMMUTABLE", "R1B_RESULT_REWRITTEN": "NO", "R1BV_IS_R1B_RETRY": "NO",
}
_CONSUMED_AT = re.compile(rb"consumed_at=(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z\n")
_LOCAL = re.compile(r"consumed_at=\S+\nconsumed_epoch=(\d{9,11}\.\d{1,9})\n")
_RUNNER_START = re.compile(r"R1B_WINDOW_START_EPOCH=(\d{9,11}\.\d{1,9})\b")


class ValidationError(Exception):
    """A refusal with a stable, secret-free code."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


# ----------------------------------------------------------------------------------------------- safe reads


def _trusted_chain(path: str, *, owner_uid: int, trust_root: str, code: str) -> None:
    """Every ancestor up to ``trust_root`` is a real directory owned by ``owner_uid`` and not group/world writable (no symlink component)."""
    d = os.path.dirname(path)
    while True:
        try:
            info = os.lstat(d)
        except OSError:
            raise ValidationError(code) from None
        if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_uid != owner_uid or info.st_mode & 0o022:
            raise ValidationError(code)
        if d == trust_root or d == os.sep:
            if d != trust_root:
                raise ValidationError(code)
            return
        d = os.path.dirname(d)


def _read_regular(path: str, *, code: str, owner_uid: int | None = None) -> tuple[bytes, os.stat_result]:
    """Read ONE regular file without following a symlink or blocking; optionally require its owner and that it is not group/world writable."""
    if not isinstance(path, str) or not path.startswith(os.sep) or os.path.normpath(path) != path:
        raise ValidationError(code)
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    except OSError:
        raise ValidationError(code) from None
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > MAX_FILE_BYTES:
            raise ValidationError(code)
        if owner_uid is not None and (info.st_uid != owner_uid or info.st_mode & 0o022):
            raise ValidationError(code)
        with os.fdopen(fd, "rb", closefd=False) as handle:
            data = handle.read(MAX_FILE_BYTES + 1)
    finally:
        os.close(fd)
    if len(data) > MAX_FILE_BYTES:
        raise ValidationError(code)
    return data, info


# ----------------------------------------------------------------------------------------------- the historical bound


def derive_bound(canonical_marker: str = CANONICAL_MARKER, *, local_marker: str | None, runner_log: str | None, owner_uid: int = 0,
                 trust_root: str = os.sep, observe_seconds: int = OBSERVE_SECONDS) -> dict[str, Any]:
    """The conservative historical validation bound from the ROOT-OWNED canonical marker (primary) with mandatory corroboration. It is NOT an R1B window record."""
    if observe_seconds != OBSERVE_SECONDS:
        raise ValidationError("OBSERVE_SECONDS_NOT_THE_PINNED_VALUE")
    if not isinstance(canonical_marker, str) or not canonical_marker.startswith(os.sep) or os.path.normpath(canonical_marker) != canonical_marker:
        raise ValidationError("CANONICAL_MARKER_PATH_INVALID")
    _trusted_chain(canonical_marker, owner_uid=owner_uid, trust_root=trust_root, code="CANONICAL_MARKER_ANCESTRY_NOT_TRUSTED")
    data, info = _read_regular(canonical_marker, code="CANONICAL_MARKER_MISSING_OR_UNTRUSTED", owner_uid=owner_uid)
    match = _CONSUMED_AT.fullmatch(data)
    if match is None:
        raise ValidationError("CANONICAL_MARKER_CONTENT_MALFORMED")
    lower = info.st_mtime_ns / 1e9
    recorded = timegm(tuple(int(g) for g in match.groups()) + (0, 0, 0))
    if not 0 <= math.floor(lower) - recorded <= 1:
        raise ValidationError("CANONICAL_MARKER_CONTENT_DISAGREES_WITH_MTIME")
    corroboration: dict[str, float] = {}
    if not local_marker:
        raise ValidationError("LOCAL_MARKER_PATH_REQUIRED")
    local_data, _ = _read_regular(local_marker, code="LOCAL_MARKER_MISSING_OR_MALFORMED")
    local = _LOCAL.fullmatch(local_data.decode("ascii", "replace"))
    if local is None:
        raise ValidationError("LOCAL_MARKER_MISSING_OR_MALFORMED")
    corroboration["local_marker_epoch"] = float(local.group(1))
    if not runner_log:
        raise ValidationError("RUNNER_LOG_PATH_REQUIRED")
    log_data, _ = _read_regular(runner_log, code="RUNNER_LOG_MISSING_OR_MALFORMED")
    starts = _RUNNER_START.findall(log_data.decode("utf-8", "replace"))
    if len(starts) != 1:
        raise ValidationError("RUNNER_LOG_WINDOW_START_MISSING_OR_AMBIGUOUS")
    corroboration["runner_window_start_epoch"] = float(starts[0])
    for name, value in corroboration.items():
        if abs(value - lower) > CORROBORATION_TOLERANCE_SEC:
            raise ValidationError("TIMING_DISAGREES_WITH_CANONICAL_MARKER:" + name)
    return {"lower": lower, "deadline": lower + float(observe_seconds), "observe_seconds": observe_seconds, "canonical_marker": canonical_marker, "canonical_marker_ino": info.st_ino,
            "canonical_marker_mtime_ns": info.st_mtime_ns, "corroboration": corroboration, "derivation": "CANONICAL_MARKER_MTIME_PLUS_PINNED_SECONDS_NO_GRACE"}


def window_record_absent(canonical_marker: str = CANONICAL_MARKER) -> str:
    """R1B history says the durable window record is ABSENT. Present now means history differs: refuse. This module never creates it."""
    path = os.path.join(os.path.dirname(canonical_marker), WINDOW_RECORD_NAME)
    try:
        os.lstat(path)
    except FileNotFoundError:
        return "YES"
    except OSError:
        raise ValidationError("WINDOW_RECORD_UNREADABLE") from None
    raise ValidationError("R1B_WINDOW_RECORD_UNEXPECTEDLY_PRESENT")


# ----------------------------------------------------------------------------------------------- the validation


def load_baseline(path: str, bound: dict[str, Any], *, owner_uid: int = 0) -> dict[str, Any]:
    """The PRESERVED pre-consume R1B baseline. It lives in the root-private R1B work directory, which sits under an operator-owned evidence directory: the TRUST is the file AND its own directory being
    owned by ``owner_uid`` and not group/world writable (an operator cannot create root-owned entries). Never invented: absent / unreadable / malformed / inconsistent refuses."""
    try:
        parent = os.lstat(os.path.dirname(path))
    except OSError:
        raise ValidationError("PRESERVED_BASELINE_MISSING_OR_UNTRUSTED") from None
    if not stat.S_ISDIR(parent.st_mode) or stat.S_ISLNK(parent.st_mode) or parent.st_uid != owner_uid or parent.st_mode & 0o022:
        raise ValidationError("PRESERVED_BASELINE_MISSING_OR_UNTRUSTED")
    data, _ = _read_regular(path, code="PRESERVED_BASELINE_MISSING_OR_UNTRUSTED", owner_uid=owner_uid)
    try:
        baseline = json.loads(data.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        raise ValidationError("PRESERVED_BASELINE_MALFORMED") from None
    if not isinstance(baseline, dict) or baseline.get("schema") != r1.SCHEMA_BASELINE:
        raise ValidationError("PRESERVED_BASELINE_MALFORMED")
    needed = ("started_at", "release_id", "detector_sha256", "detector_uid", "audit_max_id", "incident_max_id", "open_incidents", "core", "detector")
    if any(k not in baseline for k in needed):
        raise ValidationError("PRESERVED_BASELINE_MALFORMED")
    started = baseline["started_at"]
    if isinstance(started, bool) or not isinstance(started, (int, float)):
        raise ValidationError("PRESERVED_BASELINE_MALFORMED")
    if baseline["open_incidents"] != 0:
        raise ValidationError("PRESERVED_BASELINE_HAD_OPEN_INCIDENT")
    if not 0 <= bound["lower"] - float(started) <= BASELINE_MAX_LEAD_SEC:
        raise ValidationError("PRESERVED_BASELINE_NOT_THE_PRE_CONSUME_BASELINE")
    return baseline


def _services_now() -> dict[str, dict[str, str]]:
    return {"core": r1.service_snapshot(r1.CORE_UNIT), "detector": r1.service_snapshot(r1.DETECTOR_UNIT)}


def _bounded_journal(deadline: float) -> Callable[[float], dict[str, list[dict[str, Any]]]]:
    """The fixed read-only ``journalctl`` argv of ``r1_acceptance`` with ONE added ``--until``: the stage reads only the bounded interval (a day-long journal cannot overflow the reducer), never anything after D."""
    def run(argv, **kwargs):
        return r1.subprocess.run([*argv, f"--until=@{int(deadline) + 2}"], **kwargs)

    return lambda since: r1.read_journal(since, run=run)


def validate(*, baseline: dict[str, Any], bound: dict[str, Any], audit_db: str, expected_source_ip: str,
             services: Callable[[], dict[str, dict[str, str]]] = _services_now,
             journal: Callable[[float], dict[str, list[dict[str, Any]]]] | None = None) -> dict[str, Any]:
    """Validate the EXISTING R1B chain inside ``[lower, deadline]``. Raises ``ValidationError`` for ANY deviation. Read-only."""
    try:
        expected = str(validate_block_target(expected_source_ip, ()))
    except (ContainmentRejected, ValueError, TypeError):
        raise ValidationError("EXPECTED_SOURCE_NOT_AN_EXTERNALLY_CAPABLE_IPV4") from None
    if expected != expected_source_ip:
        raise ValidationError("EXPECTED_SOURCE_NOT_AN_EXTERNALLY_CAPABLE_IPV4")
    lower, deadline = bound["lower"], bound["deadline"]
    if not (isinstance(lower, float) and deadline - lower == float(OBSERVE_SECONDS)):
        raise ValidationError("BOUND_WIDENED_OR_MALFORMED")
    horizon = r1.SOURCE_TO_ALERT_MAX_SEC + r1.TIME_WINDOW
    raw = (journal or _bounded_journal(deadline))(lower - horizon)
    if not isinstance(raw, dict) or not isinstance(raw.get("detector"), list) or not isinstance(raw.get("source"), list):
        raise ValidationError("JOURNAL_RECORD_MALFORMED")
    # NO GRACE: only evidence inside the bound reaches the verifier (detector lines in [L, D]; source events from the rule horizon before L up to D)
    detector = [e for e in raw["detector"] if lower <= e["at"] <= deadline]
    source = [e for e in raw["source"] if lower - horizon <= e["at"] <= deadline]
    verified_baseline = dict(baseline, started_at=lower)
    final = r1.capture_final(now=deadline, services=services(), journal={"detector": detector, "source": source})
    result = r1.verify(verified_baseline, final, audit_db)
    if result.get("result") != "PASS":
        raise ValidationError("R1_VERIFIER_REFUSED:" + str(result.get("reason")))
    if result["attacker_ip"] != expected:
        raise ValidationError("INCIDENT_SOURCE_IS_NOT_THE_PINNED_EXPECTED_SOURCE")
    times = result["evidence_times"]
    floor_lower = math.floor(lower)
    if not (floor_lower <= times["incident_opened_at"] <= deadline and floor_lower <= times["alert_accepted_at"] <= deadline):
        raise ValidationError("AUDIT_ROW_OUTSIDE_THE_HISTORICAL_BOUND")
    if not lower <= times["detector_alert_at"] <= deadline:
        raise ValidationError("DETECTOR_ALERT_OUTSIDE_THE_HISTORICAL_BOUND")
    completed = times["source_completed_at"]
    if not completed or not all(lower <= t <= deadline for t in completed):
        raise ValidationError("SOURCE_EVENT_OUTSIDE_THE_HISTORICAL_BOUND")
    return {
        "incident_id": result["incident_id"], "attacker_ip": result["attacker_ip"], "reconstructed_rules": result["reconstructed_rules"],
        "evidence_times": times,
        "checks": {
            "R1BV_CANONICAL_MARKER_TIME_AUTHORITY": "PASS", "R1BV_TIMING_CORROBORATION": "PASS", "R1BV_HISTORICAL_BOUND": "PASS", "R1BV_EXPECTED_SOURCE_BOUND": "PASS",
            "R1BV_REAL_DETECTOR_CHAIN": "PASS", "R1BV_NEW_INCIDENT_CREATED_SEMANTICS": "PASS", "R1BV_AUDIT_PROVENANCE": "PASS", "R1BV_WINDOW_RECORD_ABSENT": window_record_absent(bound["canonical_marker"]),
        },
    }


def fingerprint(*, bound: dict[str, Any], audit_db: str, services: Callable[[], dict[str, dict[str, str]]] = _services_now) -> dict[str, Any]:
    """The no-mutation fingerprint compared between the two read-only validations."""
    marks = r1._audit_marks(audit_db)
    snap = services()
    return {
        "audit_max_id": marks["audit_max_id"], "incident_max_id": marks["incident_max_id"], "open_incidents": marks["open_incidents"],
        "canonical_marker_ino": bound["canonical_marker_ino"], "canonical_marker_mtime_ns": bound["canonical_marker_mtime_ns"],
        "core": [snap["core"]["MainPID"], snap["core"]["NRestarts"]], "detector": [snap["detector"]["MainPID"], snap["detector"]["NRestarts"]],
    }


def compare_fingerprints(before: dict[str, Any], after: dict[str, Any]) -> None:
    if before != after:
        for key in before:
            if before[key] != after.get(key):
                raise ValidationError("STATE_CHANGED_BETWEEN_VALIDATIONS:" + key)
        raise ValidationError("STATE_CHANGED_BETWEEN_VALIDATIONS")


# ----------------------------------------------------------------------------------------------- CLI (read-only)


def _write_exclusive(path: str, document: dict[str, Any]) -> None:
    text = json.dumps(document, sort_keys=True, indent=2, ensure_ascii=True) + "\n"
    if re.search(r"scrypt\$|PRIVATE KEY|password\s*[=:]|secret\s*[=:]|token\s*[=:]|core\.env", text, re.IGNORECASE):
        raise ValidationError("SECRET_SHAPED_OUTPUT_REFUSED")
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(text)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="aegis_soc.r1bv_validation", description="R1Bv read-only observer")
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("baseline", "final"):
        item = sub.add_parser(name)
        item.add_argument("--audit-db", required=True)
        item.add_argument("--r1b-baseline", required=True)
        item.add_argument("--expected-source-ip", required=True)
        item.add_argument("--local-marker", required=True)
        item.add_argument("--runner-log", required=True)
        item.add_argument("--out", required=True)
        if name == "final":
            item.add_argument("--baseline", required=True)
    args = parser.parse_args(argv)
    try:
        bound = derive_bound(CANONICAL_MARKER, local_marker=args.local_marker, runner_log=args.runner_log)
        preserved = load_baseline(args.r1b_baseline, bound)
        observed = validate(baseline=preserved, bound=bound, audit_db=args.audit_db, expected_source_ip=args.expected_source_ip)
        fp = fingerprint(bound=bound, audit_db=args.audit_db)
        public_bound = {k: bound[k] for k in ("lower", "deadline", "observe_seconds", "derivation")}
        if args.command == "baseline":
            document = {"schema": BASELINE_SCHEMA, "expected_source_ip": args.expected_source_ip, "fingerprint": fp, "bound": public_bound, **observed}
        else:
            prior = json.loads(Path(args.baseline).read_text(encoding="utf-8"))
            if prior.get("schema") != BASELINE_SCHEMA or prior.get("expected_source_ip") != args.expected_source_ip or prior.get("bound") != public_bound:
                raise ValidationError("BASELINE_INVALID_OR_BOUND_CHANGED")
            compare_fingerprints(prior["fingerprint"], fp)
            for key in ("incident_id", "attacker_ip", "evidence_times"):
                if prior.get(key) != observed[key]:
                    raise ValidationError("VALIDATION_RESULT_CHANGED_BETWEEN_OBSERVATIONS:" + key)
            document = {"schema": RESULT_SCHEMA, "result": "PASS", "reason": "OK", "expected_source_ip": args.expected_source_ip, "fingerprint": fp, "bound": public_bound,
                        "claims": dict(CLAIMS), **observed}
        _write_exclusive(args.out, document)
        print(f"R1BV_OBSERVER={'BASELINE' if args.command == 'baseline' else 'PASS'}")
    except (ValidationError, r1.AcceptanceError, OSError, ValueError, KeyError, TypeError) as error:
        code = getattr(error, "code", None) or type(error).__name__
        print(f"R1BV_OBSERVER=FAIL reason={code}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
