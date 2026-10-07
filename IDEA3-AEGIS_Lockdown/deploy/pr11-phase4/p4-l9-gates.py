#!/usr/bin/env python3
"""L9 governance gates: L8 -> L9 predecessor gate and the final L9 closeout gate.

Repository tooling only. It reads Git objects of one pinned commit with replacement objects
disabled, never the working tree, and it creates, changes and deletes nothing. Every gate either
returns a small result mapping or raises ``GateError`` with one stable reason code.

Contracts (single source of truth for this stage; the L8 work must emit exactly the L8 contract):

* The L8 predecessor is ONE unique closeout receipt of the pinned commit whose name ends with
  ``_music_idea3-l8-live-closeout.md`` and whose whole-line fields equal ``L8_CONTRACT``.
* Every occurrence of an L8-owned field in ANY receipt of the pinned commit must be that closeout's
  own value (a failed, repository-only, stale, duplicated or split L8 record is a refusal).
* ``L8_EXECUTION_MAIN`` must be a commit that is a STRICT ancestor of the pinned commit (the
  closeout merge moves main, so equality is impossible) and the closeout must not exist at it.
* No receipt may carry an L9-owned result field before L9 runs (replay prevention).
* The final L9 closeout is ONE unique receipt, introduced by exactly one commit, whose fields equal
  ``L9_CONTRACT`` and which binds the same L8 predecessor evaluated at ``L9_EXECUTION_MAIN``.
"""

from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
from pathlib import Path

LOGS_REL = "Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs"
L8_SUFFIX = "_music_idea3-l8-live-closeout.md"
L9_SUFFIX = "_music_idea3-l9-live-closeout.md"

_HEX40 = re.compile(r"[0-9a-f]{40}")
_HEX64 = re.compile(r"[0-9a-f]{64}")

# Fixed-value fields (key -> required value). Everything else is validated by a grammar below.
L8_CONTRACT = {
    "L8_LIVE": "CLOSED_PASS",
    "L8_LIVE_EXECUTED": "YES",
    "L8_RESULT": "PASS",
    "L8_ATTEMPT_CONSUMED": "YES",
    "L8_RERUN_ALLOWED": "NO",
    "L8_STAGE": "L8",
    "L8_FAILURE_RESULT": "NONE",
}
L8_GRAMMAR = {
    "L8_EXECUTION_MAIN": _HEX40,
    "L8_EVIDENCE_CLASS": re.compile(r"LIVE_[A-Z][A-Z0-9_]{0,40}"),
}
# L9 keys that may appear in the L8 closeout (and anywhere before L9 runs) only in this negative form.
PRE_L9_FIELDS = {"L9_LIVE_EXECUTED": "NO", "L9_ATTEMPT_CONSUMED": "NO"}
# L9 result keys that must be absent from every receipt before L9 runs.
L9_RESULT_KEYS = ("L9_LIVE", "L9_RESULT", "L9_RERUN_ALLOWED", "L9_FAILURE_RESULT", "L9_EVIDENCE_CLASS", "L9_EXECUTION_MAIN",
                  "L9_EVIDENCE_BUNDLE_SHA256", "L9_COMMANDS_EMITTED", "L9_RELAY_ACTUATION", "L9_STAGE")

L9_CONTRACT = {
    "L9_LIVE": "CLOSED_PASS",
    "L9_LIVE_EXECUTED": "YES",
    "L9_RESULT": "PASS",
    "L9_ATTEMPT_CONSUMED": "YES",
    "L9_RERUN_ALLOWED": "NO",
    "L9_STAGE": "L9",
    "L9_EVIDENCE_CLASS": "LIVE_CORE_OBSERVATION",
    "L9_AUTHENTICATED_STATUS_OBSERVED": "YES",
    "L9_DEADMAN_ABSENT_OVER_WINDOW": "YES",
    "L9_COMMANDS_EMITTED": "0",
    "L9_RELAY_ACTUATION": "NONE",
    "L9_NEGATIVE_PROBES_INJECTED_LIVE": "NO",
    "L9_PRE_POST_PRESERVATION": "PASS",
    "L9_SECRET_SCAN": "PASS",
    "L9_FAILURE_RESULT": "NONE",
    "L9_FINAL_CLOSEOUT_EVIDENCE_COMPLETE": "YES",
}
L9_GRAMMAR = {
    "L9_EXECUTION_MAIN": _HEX40,
    "L9_EVIDENCE_BUNDLE_SHA256": _HEX64,
    "L8_EXECUTION_MAIN": _HEX40,
}
_FIELD = re.compile(r"^\s*(?:[-*]\s+)?`?([A-Z][A-Z0-9_]*)=([^\s`]+)`?\s*$")


class GateError(RuntimeError):
    """A governance gate refused; ``str(exc)`` is one stable reason code."""


def _env() -> dict[str, str]:
    """A clean Git environment: nothing from the caller can redirect the repository, re-enable replacement objects or inject config."""
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    env["GIT_NO_REPLACE_OBJECTS"] = "1"
    env["GIT_CONFIG_NOSYSTEM"] = "1"
    env["GIT_CONFIG_GLOBAL"] = "/dev/null"
    env["GIT_TERMINAL_PROMPT"] = "0"
    return env


# Repository-local config is still read by Git, so the options that could execute a program are pinned off explicitly.
_SAFE_OPTIONS = ("-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "core.pager=cat", "-c", "protocol.allow=never")


def _git(repo: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess:
    done = subprocess.run(["git", *_SAFE_OPTIONS, "-C", str(repo), *args], capture_output=True, text=True, env=_env(), check=False)
    if check and done.returncode != 0:
        raise GateError("GIT_READ_FAILED")
    return done


def commit_gate(repo: Path, main: str, *, require_head: bool) -> None:
    if not _HEX40.fullmatch(main or ""):
        raise GateError("L9_PINNED_COMMIT_MALFORMED")
    if _git(repo, "rev-parse", "--verify", f"{main}^{{commit}}", check=False).stdout.strip() != main:
        raise GateError("L9_PINNED_COMMIT_NOT_A_COMMIT_OBJECT")
    if require_head and _git(repo, "rev-parse", "--verify", "HEAD^{commit}", check=False).stdout.strip() != main:
        raise GateError("L9_HEAD_NOT_THE_PINNED_COMMIT")


def receipt_fields(repo: Path, main: str) -> dict[str, dict[str, list[str]]]:
    """Whole-line ``FIELD=VALUE`` lines of every status-log receipt of ``main``: path -> key -> [values]."""
    # Read each receipt blob once: the file name matters for the canonical-suffix rule.
    names = _git(repo, "ls-tree", "-r", "--name-only", main, "--", LOGS_REL).stdout.splitlines()
    out: dict[str, dict[str, list[str]]] = {}
    for name in names:
        if not name.endswith(".md"):
            continue
        blob = _git(repo, "show", f"{main}:{name}").stdout
        for line in blob.splitlines():
            match = _FIELD.match(line)
            if match:
                out.setdefault(name, {}).setdefault(match.group(1), []).append(match.group(2))
    return out


def _files_with(fields: dict[str, dict[str, list[str]]], key: str) -> set[str]:
    return {path for path, values in fields.items() if key in values}


def _enforce_contract(fields, contract: dict[str, str], grammar: dict, suffix: str, label: str, negatives: dict[str, str] | None = None) -> tuple[str, dict[str, str]]:
    """The ONE receipt carrying the whole contract; every occurrence of an owned key anywhere is that receipt's own value.

    ``negatives`` are keys other receipts may carry ONLY in the stated pre-run form; grammar keys of another stage (not ``label``-prefixed) may repeat."""
    negatives = negatives or {}
    anchor_key, anchor_value = next(iter(contract.items()))
    anchors = {p for p, v in fields.items() if anchor_value in v.get(anchor_key, [])}
    if len(anchors) != 1:
        raise GateError(f"{label}_CLOSEOUT_MISSING_OR_AMBIGUOUS")
    path = next(iter(anchors))
    if not path.startswith(f"{LOGS_REL}/") or not path.endswith(suffix):
        raise GateError(f"{label}_CLOSEOUT_NOT_THE_CANONICAL_RECEIPT_NAME")
    own = fields[path]
    values: dict[str, str] = {}
    for key, want in contract.items():
        if own.get(key) != [want]:
            raise GateError(f"{label}_CLOSEOUT_FIELD_INVALID:{key}")
        values[key] = want
    for key, rx in grammar.items():
        got = own.get(key)
        if not got or len(got) != 1 or not rx.fullmatch(got[0]):
            raise GateError(f"{label}_CLOSEOUT_FIELD_INVALID:{key}")
        values[key] = got[0]
    for key in (*contract, *grammar):
        if not key.startswith(f"{label}_"):
            continue
        for other_path, other in fields.items():
            if other_path == path or key not in other:
                continue
            if key in negatives and all(v == negatives[key] for v in other[key]):
                continue
            raise GateError(f"{label}_EVIDENCE_DUPLICATED_OR_SPLIT:{key}")
    return path, values


def _single_introducing_commit(repo: Path, main: str, path: str, label: str) -> None:
    log = _git(repo, "log", "--format=%H", main, "--", path).stdout.split()
    if len(log) != 1:
        raise GateError(f"{label}_CLOSEOUT_NOT_IMMUTABLE_SINGLE_COMMIT")


def _strict_ancestor(repo: Path, ancestor: str, main: str, path: str, label: str) -> None:
    if _git(repo, "rev-parse", "--verify", f"{ancestor}^{{commit}}", check=False).stdout.strip() != ancestor:
        raise GateError(f"{label}_EXECUTION_MAIN_NOT_A_COMMIT")
    if ancestor == main:
        raise GateError(f"{label}_EXECUTION_MAIN_EQUALS_PINNED_MAIN")
    if _git(repo, "merge-base", "--is-ancestor", ancestor, main, check=False).returncode != 0:
        raise GateError(f"{label}_EXECUTION_MAIN_NOT_AN_ANCESTOR")
    if _git(repo, "cat-file", "-e", f"{ancestor}:{path}", check=False).returncode == 0:
        raise GateError(f"{label}_CLOSEOUT_PREDATES_ITS_EXECUTION")


# ---------------------------------------------------------------------------- L8 predecessor: ONE interface, two layers
#
# Layer 1 (implemented, pure Git): the receipt contract above. A hand-written receipt satisfies it.
# Layer 2 (NOT implemented — SECURITY BLOCKER ``L8_HOST_PROVENANCE_REQUIRED``): proof from the canonical L8 host closeout that the
# receipt was derived from a real, root-owned L8 result. Its schema belongs to the L8 implementation and must not be guessed here.
# ``l8_host_provenance`` is the single wiring point; until it is implemented, every LIVE-capable caller (the owner runner, the
# production freeze and verify) refuses with ``L8_HOST_PROVENANCE_REQUIRED``. Only the receipt-contract layer is available to
# tests and to the later pure Git-history verification, via ``require_host_provenance=False``.
L8_HOST_PROVENANCE_IMPLEMENTED = False


def l8_host_provenance(receipt: dict[str, str]) -> None:
    """Wire the canonical L8 host closeout cross-check here (run on the host, before any LIVE use). Not implemented on purpose."""
    if not L8_HOST_PROVENANCE_IMPLEMENTED:
        raise GateError("L8_HOST_PROVENANCE_REQUIRED")
    raise GateError("L8_HOST_PROVENANCE_REQUIRED")  # unreachable guard: an implementation must replace this body, never flip the flag alone


def l8_predecessor_gate(repo: Path, main: str, *, require_head: bool = True, require_host_provenance: bool = True) -> dict[str, str]:
    """Canonical L8 PASS at ``main``: unique, truthful, ancestry-bound and with no L9 result recorded yet.

    ``require_host_provenance=True`` (the default, and the only mode any LIVE-capable caller may use) additionally runs the
    L8 host-provenance layer, which is a deliberate blocker until the L8 host closeout contract is wired."""
    repo = Path(repo)
    commit_gate(repo, main, require_head=require_head)
    fields = receipt_fields(repo, main)
    path, values = _enforce_contract(fields, L8_CONTRACT, L8_GRAMMAR, L8_SUFFIX, "L8")
    own = fields[path]
    for key, want in PRE_L9_FIELDS.items():
        if own.get(key) != [want]:
            raise GateError(f"L8_CLOSEOUT_FIELD_INVALID:{key}")
    for key, want in PRE_L9_FIELDS.items():
        for other in fields.values():
            if any(v != want for v in other.get(key, [])):
                raise GateError(f"L9_ALREADY_RECORDED:{key}")
    for key in L9_RESULT_KEYS:
        if _files_with(fields, key):
            raise GateError(f"L9_ALREADY_RECORDED:{key}")
    _single_introducing_commit(repo, main, path, "L8")
    _strict_ancestor(repo, values["L8_EXECUTION_MAIN"], main, path, "L8")
    result = {"L8_CLOSEOUT_PATH": path, "L8_EXECUTION_MAIN": values["L8_EXECUTION_MAIN"], "L8_EVIDENCE_CLASS": values["L8_EVIDENCE_CLASS"]}
    if require_host_provenance:
        l8_host_provenance(result)
    return {"L8_CLOSEOUT_PATH": path, "L8_EXECUTION_MAIN": values["L8_EXECUTION_MAIN"], "L8_EVIDENCE_CLASS": values["L8_EVIDENCE_CLASS"]}


def final_closeout_gate(repo: Path, main: str, *, require_head: bool = True) -> dict[str, str]:
    """The unique, immutable, exact-history-bound L9 CLOSED_PASS receipt that the final project report may cite."""
    repo = Path(repo)
    commit_gate(repo, main, require_head=require_head)
    fields = receipt_fields(repo, main)
    path, values = _enforce_contract(fields, L9_CONTRACT, L9_GRAMMAR, L9_SUFFIX, "L9", PRE_L9_FIELDS)
    # L9 is a success-only closeout: a FAIL record anywhere is a refusal, never reconciled (the contract loop above refuses any
    # other L9-owned occurrence except the L8 closeout's own pre-run negatives).
    if not fields[path].get("L9_LIVE_EXECUTED") == ["YES"]:
        raise GateError("L9_CLOSEOUT_FIELD_INVALID:L9_LIVE_EXECUTED")
    _single_introducing_commit(repo, main, path, "L9")
    _strict_ancestor(repo, values["L9_EXECUTION_MAIN"], main, path, "L9")
    # The L8 predecessor, evaluated exactly at the commit L9 executed on, must be the one the closeout names.
    execution = values["L9_EXECUTION_MAIN"]
    prior = l8_predecessor_gate(repo, execution, require_head=False, require_host_provenance=False)  # pure Git history: the host is not readable forever
    if prior["L8_EXECUTION_MAIN"] != values["L8_EXECUTION_MAIN"]:
        raise GateError("L9_CLOSEOUT_L8_BINDING_MISMATCH")
    return {"L9_CLOSEOUT_PATH": path, "L9_EXECUTION_MAIN": execution, "L8_EXECUTION_MAIN": values["L8_EXECUTION_MAIN"],
            "L9_EVIDENCE_BUNDLE_SHA256": values["L9_EVIDENCE_BUNDLE_SHA256"]}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="AEGIS L9 governance gates (read-only)")
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("l8-predecessor", "final-closeout"):
        p = sub.add_parser(name)
        p.add_argument("--repo", required=True)
        p.add_argument("--main", required=True)
        p.add_argument("--no-require-head", action="store_true")
        if name == "l8-predecessor":
            p.add_argument("--receipt-contract-only", action="store_true", help="skip the L8 host-provenance layer (tests / history checks only; never for LIVE)")
    args = parser.parse_args(argv)
    try:
        if args.command == "l8-predecessor":
            result = l8_predecessor_gate(Path(args.repo), args.main, require_head=not args.no_require_head, require_host_provenance=not args.receipt_contract_only)
        else:
            result = final_closeout_gate(Path(args.repo), args.main, require_head=not args.no_require_head)
    except GateError as exc:
        print(f"L9_GATE=FAIL reason={exc}", file=sys.stderr)
        return 1
    for key, value in result.items():
        print(f"{key}={value}")
    print("L9_GATE=PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
