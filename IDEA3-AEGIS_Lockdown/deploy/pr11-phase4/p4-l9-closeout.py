#!/usr/bin/env python3
"""L9 closeout: LIVE host provenance verification and repository-receipt derivation.

Two layers, kept strictly apart:

1. LIVE host layer (this tool, run on the host after a real L9 run): the root-owned host terminal closeout
   ``L9-GLOBAL-CLOSEOUT-PASS`` is verified against the canonical attempt marker, the single-use claim, the evidence bundle
   (recomputed invariants, digest, run id, main, runner SHA, marker binding) and the runner's terminal result. Only a host
   result that passes ALL of that can ORIGINATE a repository receipt: ``derive`` writes the receipt's machine fields from the
   verified host values, never from caller input, and ``verify-receipt`` recomputes them and refuses any hand-written receipt
   that does not match.
2. Git-history layer (``p4-l9-gates.py final-closeout``): after the receipt is merged, only immutable Git history can be read.
   It proves uniqueness, single-commit immutability, ancestry and the L8 binding. It does NOT, and cannot, prove that the physical
   host still exists; that proof is exactly what layer 1 produced before the merge.

Repository tooling only: it reads host files, writes at most the one derived receipt (exclusive create) and nothing else.
"""

from __future__ import annotations

import argparse
import datetime as dt
import importlib.util
import os
import re
import stat
import sys
from pathlib import Path
from zoneinfo import ZoneInfo

_HERE = Path(__file__).resolve().parent


def _load(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, _HERE / filename)
    module = importlib.util.module_from_spec(spec)
    sys.modules.setdefault(name, module)
    spec.loader.exec_module(module)
    return module


observe = _load("p4_l9_live_observe", "p4-l9-live-observe.py")
gates = _load("p4_l9_gates", "p4-l9-gates.py")

HOST_NAME = "L9-GLOBAL-CLOSEOUT-PASS"
TERMINAL_RESULT = "terminal-result"
_HEX40, _HEX64 = re.compile(r"[0-9a-f]{40}"), re.compile(r"[0-9a-f]{64}")

# The host closeout's exact, ordered key set. Fixed values come from the gate contract so the two layers cannot drift.
HOST_FIXED = {
    "L9_LIVE": "CLOSED_PASS", "L9_LIVE_EXECUTED": "YES", "L9_RESULT": "PASS", "L9_ATTEMPT_CONSUMED": "YES", "L9_RERUN_ALLOWED": "NO",
    "L9_STAGE": "L9", "L9_EVIDENCE_CLASS": "LIVE_CORE_OBSERVATION", "L9_AUTHENTICATED_STATUS_OBSERVED": "YES",
    "L9_DEADMAN_ABSENT_OVER_WINDOW": "YES", "L9_COMMANDS_EMITTED": "0", "L9_RELAY_ACTUATION": "NONE",
    "L9_NEGATIVE_PROBES_INJECTED_LIVE": "NO", "L9_PRE_POST_PRESERVATION": "PASS", "L9_SECRET_SCAN": "PASS", "L9_FAILURE_RESULT": "NONE",
}
HOST_VARIABLE = ("L9_EXPECTED_MAIN", "L9_RUN_ID", "L9_RUNNER_SHA256", "L8_EXECUTION_MAIN", "L9_EVIDENCE_BUNDLE_SHA256", "L9_EVIDENCE_ROOT", "L9_TERMINAL_EPOCH")
HOST_KEYS = (*HOST_FIXED, *HOST_VARIABLE)


class CloseoutError(RuntimeError):
    """Provenance or derivation refused; ``str(exc)`` is one stable reason code."""


def _private_file(path: Path, owner_uid: int, label: str) -> None:
    try:
        st = path.lstat()
    except OSError:
        raise CloseoutError(f"{label}_MISSING") from None
    if stat.S_ISLNK(st.st_mode) or not stat.S_ISREG(st.st_mode):
        raise CloseoutError(f"{label}_NOT_A_REGULAR_FILE")
    if st.st_uid != owner_uid or st.st_mode & 0o022:
        raise CloseoutError(f"{label}_NOT_ROOT_OWNED_PRIVATE")


def _pairs(text: str, label: str) -> dict[str, str]:
    values: dict[str, str] = {}
    for line in text.splitlines():
        if "=" in line:
            key, value = line.split("=", 1)
            if key in values:
                raise CloseoutError(f"{label}_DUPLICATE_KEY")
            values[key] = value
    return values


def load_host_closeout(directory: Path, owner_uid: int) -> dict[str, str]:
    path = directory / HOST_NAME
    _private_file(path, owner_uid, "HOST_CLOSEOUT")
    others = sorted(p.name for p in directory.glob("L9-GLOBAL-CLOSEOUT-*") if p.name != HOST_NAME)
    if others:
        raise CloseoutError("HOST_CLOSEOUT_CONFLICTING_RECORD")
    values = _pairs(path.read_text(encoding="utf-8"), "HOST_CLOSEOUT")
    if list(values) != list(HOST_KEYS):
        raise CloseoutError("HOST_CLOSEOUT_KEY_SET_INVALID")
    for key, want in HOST_FIXED.items():
        if values[key] != want:
            raise CloseoutError(f"HOST_CLOSEOUT_FIELD_INVALID:{key}")
    if not (_HEX40.fullmatch(values["L9_EXPECTED_MAIN"]) and _HEX40.fullmatch(values["L8_EXECUTION_MAIN"])
            and _HEX64.fullmatch(values["L9_RUNNER_SHA256"]) and _HEX64.fullmatch(values["L9_EVIDENCE_BUNDLE_SHA256"])
            and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}", values["L9_RUN_ID"]) and re.fullmatch(r"/[A-Za-z0-9._/-]{1,200}", values["L9_EVIDENCE_ROOT"])
            and ".." not in values["L9_EVIDENCE_ROOT"].split("/")):
        raise CloseoutError("HOST_CLOSEOUT_IDENTITY_INVALID")
    try:
        float(values["L9_TERMINAL_EPOCH"])
    except ValueError:
        raise CloseoutError("HOST_CLOSEOUT_TIME_INVALID") from None
    return values


def verify_host_provenance(directory: Path, evidence_path: Path, owner_uid: int) -> dict[str, str]:
    """Everything that makes the host result genuine, derived only from host-owned files."""
    host = load_host_closeout(directory, owner_uid)
    marker_path = directory / observe.MARKER_NAME
    _private_file(marker_path, owner_uid, "MARKER")
    marker_text = marker_path.read_text(encoding="utf-8")
    device = _pairs(marker_text, "MARKER").get("L9_DEVICE_ID", "")
    try:
        marker = observe.parse_marker(marker_text, device)
        claim = observe.read_used_claim(directory / observe.USED_NAME)
    except observe.ObserveError as exc:
        raise CloseoutError(f"MARKER_INVALID:{exc}") from None
    _private_file(directory / observe.USED_NAME, owner_uid, "USE_CLAIM")
    for key in ("L9_RUN_ID", "L9_EXPECTED_MAIN", "L9_RUNNER_SHA256"):
        if marker[key] != host[key]:
            raise CloseoutError(f"HOST_MARKER_MISMATCH:{key}")
    expected_bundle = Path(marker["L9_EVIDENCE_DIR"]) / observe.EVIDENCE_NAME
    if Path(os.path.abspath(evidence_path)) != expected_bundle:
        raise CloseoutError("EVIDENCE_NOT_THE_MARKER_BOUND_BUNDLE")
    try:
        data = observe.verify_evidence(evidence_path, None, binding={
            "marker": marker, "claim": claim, "evidence_dir": marker["L9_EVIDENCE_DIR"], "run_id": host["L9_RUN_ID"],
            "expected_main": host["L9_EXPECTED_MAIN"], "runner_sha256": host["L9_RUNNER_SHA256"], "device_id": device})
    except observe.ObserveError as exc:
        raise CloseoutError(f"EVIDENCE_INVALID:{exc}") from None
    if data["evidence_class"] != observe.EVIDENCE_CLASS:
        raise CloseoutError("EVIDENCE_CLASS_NOT_LIVE")
    if observe.evidence_sha256(evidence_path) != host["L9_EVIDENCE_BUNDLE_SHA256"]:
        raise CloseoutError("EVIDENCE_SHA256_MISMATCH")
    terminal = Path(host["L9_EVIDENCE_ROOT"]) / TERMINAL_RESULT
    _private_file_user = terminal.lstat() if terminal.exists() or terminal.is_symlink() else None
    if _private_file_user is None or stat.S_ISLNK(_private_file_user.st_mode) or not stat.S_ISREG(_private_file_user.st_mode):
        raise CloseoutError("TERMINAL_RESULT_MISSING")
    result = _pairs(terminal.read_text(encoding="utf-8"), "TERMINAL_RESULT")
    if result.get("L9_RESULT") != "PASS" or result.get("L9_FAILURE_RESULT") != "NONE" or "L9_FAILURE_REASON" in result:
        raise CloseoutError("TERMINAL_RESULT_CONFLICTS_WITH_PASS")
    for key in ("L9_EXPECTED_MAIN", "L8_EXECUTION_MAIN", "L9_EVIDENCE_BUNDLE_SHA256", "L9_EVIDENCE_ROOT"):
        if result.get(key) != host[key]:
            raise CloseoutError(f"TERMINAL_RESULT_MISMATCH:{key}")
    return host


def machine_fields(host: dict[str, str]) -> dict[str, str]:
    """The receipt's machine fields, derived from verified host values and the gate contract only."""
    fields = dict(gates.L9_CONTRACT)
    fields["L9_EXECUTION_MAIN"] = host["L9_EXPECTED_MAIN"]
    fields["L8_EXECUTION_MAIN"] = host["L8_EXECUTION_MAIN"]
    fields["L9_EVIDENCE_BUNDLE_SHA256"] = host["L9_EVIDENCE_BUNDLE_SHA256"]
    return fields


def receipt_name(host: dict[str, str]) -> str:
    stamp = dt.datetime.fromtimestamp(float(host["L9_TERMINAL_EPOCH"]), ZoneInfo("Asia/Bangkok"))
    return f"{stamp:%Y-%m-%d_%H%M%S}{gates.L9_SUFFIX}"


def render_receipt(host: dict[str, str]) -> str:
    stamp = dt.datetime.fromtimestamp(float(host["L9_TERMINAL_EPOCH"]), ZoneInfo("Asia/Bangkok"))
    lines = "".join(f"- `{k}={v}`\n" for k, v in machine_fields(host).items())
    return f"""---
title: Task Receipt — IDEA3 L9 LIVE closeout
date: {stamp:%Y-%m-%dT%H:%M:%S}+07:00
owner: music
area: idea3
branch: docs/idea3-l9-live-closeout
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 L9 LIVE closeout

> Derived by `p4-l9-closeout.py derive` from the root-owned host closeout `{HOST_NAME}`; the machine fields below are verified
> by `verify-receipt` and must not be edited. Add the narrative sections required by the receipt template before committing.

## Machine fields

{lines}
## Honest scope

- L9 was a read-only observation of the running Core's own authenticated evidence; it sent nothing, injected nothing and changed nothing.
- Negative probes were not injected live (`REPOSITORY_FIXTURE_ONLY`); the device-side heartbeat effect is evidenced only by the absence of a DEADMAN status over the window.
"""


def derive(directory: Path, evidence_path: Path, repo: Path, logs_dir: Path, owner_uid: int) -> Path:
    host = verify_host_provenance(directory, evidence_path, owner_uid)
    try:
        prior = gates.l8_predecessor_gate(repo, host["L9_EXPECTED_MAIN"], require_head=False, require_host_provenance=False)
    except gates.GateError as exc:
        raise CloseoutError(f"L8_PREDECESSOR_NOT_SATISFIED:{exc}") from None
    if prior["L8_EXECUTION_MAIN"] != host["L8_EXECUTION_MAIN"]:
        raise CloseoutError("L8_BINDING_MISMATCH")
    out = Path(logs_dir) / receipt_name(host)
    try:
        fd = os.open(out, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
    except OSError as exc:
        raise CloseoutError(f"RECEIPT_NOT_WRITABLE:{type(exc).__name__}") from None
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(render_receipt(host))
    return out


def verify_receipt(receipt: Path, directory: Path, evidence_path: Path, repo: Path, owner_uid: int) -> dict[str, str]:
    """A receipt is accepted only if its machine fields equal the ones derived from a verified live host result."""
    host = verify_host_provenance(directory, evidence_path, owner_uid)
    if not receipt.name.endswith(gates.L9_SUFFIX) or receipt.is_symlink() or not receipt.is_file():
        raise CloseoutError("RECEIPT_NAME_OR_TYPE_INVALID")
    found: dict[str, list[str]] = {}
    for line in receipt.read_text(encoding="utf-8").splitlines():
        match = gates._FIELD.match(line)
        if match:
            found.setdefault(match.group(1), []).append(match.group(2))
    want = machine_fields(host)
    if any(found.get(k) != [v] for k, v in want.items()) or any(k.startswith("L9_") and k not in want for k in found):
        raise CloseoutError("RECEIPT_NOT_DERIVED_FROM_THE_HOST_RESULT")
    if receipt.name != receipt_name(host):
        raise CloseoutError("RECEIPT_NAME_NOT_DERIVED_FROM_THE_HOST_RESULT")
    return want


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("derive", "verify-receipt", "verify-host"):
        p = sub.add_parser(name)
        p.add_argument("--evidence-bundle", type=Path, required=True)
        if name != "verify-host":
            p.add_argument("--repo", type=Path, required=True)
        if name == "derive":
            p.add_argument("--logs-dir", type=Path, required=True)
        if name == "verify-receipt":
            p.add_argument("--receipt", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        directory, owner_uid = observe._canonical_dir()
        if args.command == "verify-host":
            verify_host_provenance(directory, args.evidence_bundle, owner_uid)
            print("L9_HOST_PROVENANCE=PASS")
        elif args.command == "derive":
            print(f"L9_RECEIPT_DERIVED={derive(directory, args.evidence_bundle, args.repo, args.logs_dir, owner_uid)}")
        else:
            verify_receipt(args.receipt, directory, args.evidence_bundle, args.repo, owner_uid)
            print("L9_RECEIPT_DERIVED_FROM_HOST_RESULT=YES")
    except (CloseoutError, observe.ObserveError, OSError, UnicodeDecodeError) as exc:
        print(f"L9_CLOSEOUT=FAIL reason={exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
