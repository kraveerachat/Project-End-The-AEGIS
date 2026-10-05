"""R1B successor acceptance adapter.

R1B is a NEW governed stage after the immutable, consumed R1A failure. It is
not an R1A retry and never edits/closes the preserved R1A incident. The
underlying evidence predicates remain those of :mod:`r1_acceptance`.

The only baseline difference is explicit and fail-closed: exactly ONE existing
OPEN incident must already be present and is snapshotted as preserved evidence.
A PRE-CONSUME command then proves the audit maxima and preserved incident are
unchanged before the R1B one-shot marker may be consumed.

No command here generates traffic, writes the Core store, mutates a service, or
promotes F1_REAL_DETECTOR_ACCEPTANCE / R1_VERIFIED.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from . import r1_acceptance as r1


def _write_new(path: str, document: dict) -> None:
    with open(path, "x", encoding="utf-8") as handle:
        handle.write(json.dumps(document, sort_keys=True, indent=2, ensure_ascii=True) + "\n")


def preconsume(*, baseline_path: str, audit_db: str) -> dict:
    try:
        baseline = json.loads(Path(baseline_path).read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise r1.AcceptanceError("BASELINE_UNREADABLE") from exc
    if baseline.get("schema") != r1.SCHEMA_BASELINE:
        raise r1.AcceptanceError("BASELINE_MALFORMED")
    preserved = baseline.get("preserved_open_incidents")
    if not isinstance(preserved, list) or len(preserved) != 1 or not isinstance(preserved[0], dict):
        raise r1.AcceptanceError("PRESERVED_INCIDENT_BASELINE_MALFORMED")
    marks, preserved_now = r1._audit_baseline_state(audit_db)
    expected = {k: baseline.get(k) for k in ("audit_max_id", "incident_max_id", "open_incidents")}
    if marks != expected:
        raise r1.AcceptanceError("PRECONSUME_AUDIT_DRIFT")
    if preserved_now != preserved:
        raise r1.AcceptanceError("PRESERVED_INCIDENT_CHANGED")
    return {
        "schema": "aegis.idea3.r1b-preconsume/1",
        "result": "PASS",
        "reason": "OK",
        "audit_max_id": marks["audit_max_id"],
        "incident_max_id": marks["incident_max_id"],
        "open_incidents": marks["open_incidents"],
        "preserved_incident_id": preserved[0]["id"],
        "claims": dict(r1.CLAIMS),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="r1b_acceptance")
    sub = parser.add_subparsers(dest="command", required=True)

    b = sub.add_parser("baseline")
    b.add_argument("--audit-db", required=True)
    b.add_argument("--release-id", required=True)
    b.add_argument("--detector-sha256", required=True)
    b.add_argument("--detector-uid", type=int, required=True)
    b.add_argument("--out", required=True)

    p = sub.add_parser("preconsume")
    p.add_argument("--baseline", required=True)
    p.add_argument("--audit-db", required=True)
    p.add_argument("--out", required=True)

    f = sub.add_parser("final")
    f.add_argument("--baseline", required=True)
    f.add_argument("--audit-db", required=True)
    f.add_argument("--out", required=True)

    args = parser.parse_args(argv)
    try:
        if args.command == "baseline":
            services = {"core": r1.service_snapshot(r1.CORE_UNIT), "detector": r1.service_snapshot(r1.DETECTOR_UNIT)}
            document = r1.capture_baseline(
                audit_db=args.audit_db,
                release_id=args.release_id,
                detector_sha256=args.detector_sha256,
                detector_uid=args.detector_uid,
                now=r1.time.time(),
                services=services,
                allowed_open_incidents=1,
            )
            r1._write_new(args.out, r1.render(document))
            return 0
        if args.command == "preconsume":
            _write_new(args.out, preconsume(baseline_path=args.baseline, audit_db=args.audit_db))
            print("R1B_PRECONSUME_AUDIT_QUIESCENT=YES")
            print("F1_REAL_DETECTOR_ACCEPTANCE=NOT_PROVEN")
            print("R1_VERIFIED=NOT_CLAIMED")
            return 0

        baseline = json.loads(Path(args.baseline).read_text(encoding="utf-8"))
        services = {"core": r1.service_snapshot(r1.CORE_UNIT), "detector": r1.service_snapshot(r1.DETECTOR_UNIT)}
        final = r1.capture_final(now=r1.time.time(), services=services, journal=r1.read_journal(baseline["started_at"]))
        result = r1.verify(baseline, final, args.audit_db)
        r1._write_new(args.out, r1.render(result))
        print(r1.claim_lines(result), end="")
        return 0 if result["result"] == "PASS" else 2
    except (r1.AcceptanceError, OSError, ValueError, KeyError) as error:
        print(f"r1b_acceptance: refused: {getattr(error, 'code', type(error).__name__)}", file=r1.sys.stderr)
        return 4


if __name__ == "__main__":
    raise SystemExit(main())
