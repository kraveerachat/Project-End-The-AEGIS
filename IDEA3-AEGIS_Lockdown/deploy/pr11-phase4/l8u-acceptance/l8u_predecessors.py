#!/usr/bin/env python3
"""L8u predecessor authority: the ONE implementation of "LVR PASS, then L8" used by the freeze tool AND by the frozen owner runner.

Read-only. Every trust decision reads Git OBJECTS of the exact pinned main (replacement objects disabled, scrubbed ``GIT_*`` environment), never a working-tree file and never a host file.

What must hold at ``EXPECTED_MAIN`` (each refusal is one reason code, nothing is repaired or guessed):

* L8p historical provisioning: exactly ONE status-log receipt carries BOTH whole-line fields ``L8P_LIVE_EXECUTED=YES`` and ``L8P_PROVISIONING=PASS`` and it is the canonical L8p closeout
  receipt. L8p is read-only predecessor proof here: L8u never reruns, reflashes or reprovisions.
* LVR PASS: exactly ONE receipt is a LVR result (any receipt carrying ``LVR_PROVEN=YES``, ``LVR_LIVE=CLOSED_PASS``, ``LVR_RESULT=PASS`` or ``LVR_LIVE_EXECUTED=YES``); its file name ends
  ``_music_idea3-lvr-live-closeout.md``; it carries EVERY required whole-line field exactly once; no receipt records an LVR failure; no receipt already records L8 acceptance or an L8u result.
* Descendant rule (the closeout merge moves main): ``LVR_EXECUTION_MAIN`` is a real commit, a STRICT ancestor of ``EXPECTED_MAIN``, the LVR closeout receipt does NOT exist at that execution
  main (it was added by a later commit) and the canonical L8p closeout receipt DOES exist there (L8p came first).
* Optional pin: the SHA-256 of the LVR closeout bytes at ``EXPECTED_MAIN`` equals the frozen ``LVR_CLOSEOUT_SHA256``.

The LVR closeout field contract below is the INTEGRATION POINT with the LVR work stream: LVR is an owner-runbook ceremony today (README: "LVR-6 and LVR9 remain owner-runbook ceremonies"), so
this module defines what the L8u gate will accept and nothing else. If the LVR stream chooses other field names, change ``LVR_REQUIRED`` here (and only here) and the tests that pin it.
"""

from __future__ import annotations

import argparse
import hashlib
import os
import re
import subprocess
import sys
from pathlib import Path

LOGS_REL = "Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs"
L8P_CLOSEOUT_REL = f"{LOGS_REL}/2026-10-04_075127_music_idea3-l8p-attempt2-reconciliation-closeout.md"
LVR_CLOSEOUT_SUFFIX = "_music_idea3-lvr-live-closeout.md"

# Whole-line FIELD=VALUE pairs the ONE canonical LVR closeout must carry (each exactly once). LVR_EXECUTION_MAIN is validated separately (40-hex, strict ancestor).
LVR_REQUIRED = {
    "LVR_LIVE": "CLOSED_PASS",
    "LVR_LIVE_EXECUTED": "YES",
    "LVR_RESULT": "PASS",
    "LVR_PROVEN": "YES",
    "LVR_ATTEMPT_CONSUMED": "YES",
    "LVR_RERUN_ALLOWED": "NO",
    "RECOVERY_R2_R8_EXECUTED": "YES",
    "RECOVERY_RESULT": "PASS",
    "L8_ACCEPTANCE": "NO",
    "L9_PROVEN": "NO",
}
# A receipt that carries ANY of these is an LVR result receipt (so it must be the one canonical receipt).
LVR_RESULT_MARKERS = (("LVR_PROVEN", "YES"), ("LVR_LIVE", "CLOSED_PASS"), ("LVR_RESULT", "PASS"), ("LVR_LIVE_EXECUTED", "YES"))
# A receipt carrying ANY of these records an LVR failure: no L8u while one exists (there is no retry model for L8u to invent).
LVR_FAILURE_MARKERS = (("LVR_RESULT", "FAIL"), ("LVR_RESULT", "FAIL_IMMUTABLE"), ("LVR_LIVE", "CLOSED_FAIL"), ("LVR_PROVEN", "FAIL"))
# Already-closed L8 / L8u claims: L8u is one attempt TOTAL.
L8_DONE_MARKERS = (("L8_ACCEPTANCE", "YES"), ("L8U_LIVE_EXECUTED", "YES"), ("L8U_LIVE", "CLOSED_PASS"), ("L8U_RESULT", "PASS"), ("L8U_RESULT", "FAIL_IMMUTABLE"))


class PredecessorError(ValueError):
    pass


def _git_env() -> dict[str, str]:
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    env["GIT_NO_REPLACE_OBJECTS"] = "1"
    env["GIT_CONFIG_NOSYSTEM"] = "1"
    return env


def _git(repo: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    done = subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True, env=_git_env(), check=False)
    if check and done.returncode != 0:
        raise PredecessorError("GIT_READ_FAILED")
    return done


def _commit(repo: Path, ref: str) -> str:
    if not re.fullmatch(r"[0-9a-f]{40}", ref):
        raise PredecessorError("COMMIT_MALFORMED")
    done = _git(repo, "rev-parse", "--verify", f"{ref}^{{commit}}", check=False)
    if done.returncode != 0 or done.stdout.strip() != ref:
        raise PredecessorError("COMMIT_NOT_A_COMMIT_OBJECT")
    return ref


def _field_re(field: str) -> re.Pattern[str]:
    return re.compile(rf"^[ \t]*(?:[-*][ \t]+)?`?{re.escape(field)}[ \t]*=[ \t]*([^`\n]*?)`?[ \t]*$", re.M)


def receipts(repo: Path, main: str) -> dict[str, str]:
    """Every status-log receipt of the pinned commit that mentions a field this module reads: ``path -> text`` (read from the Git object)."""
    listed = _git(repo, "grep", "-l", "-E", r"(LVR_|L8P_|L8_ACCEPTANCE|L8U_)", main, "--", LOGS_REL, check=False)
    if listed.returncode not in (0, 1):
        raise PredecessorError("GIT_READ_FAILED")
    out: dict[str, str] = {}
    for line in listed.stdout.splitlines():
        ref, _, path = line.partition(":")
        if ref != main or not path.startswith(f"{LOGS_REL}/"):
            raise PredecessorError("GIT_GREP_OUTPUT_UNEXPECTED")
        out[path] = _git(repo, "show", f"{main}:{path}").stdout
    return out


def _values(text: str, field: str) -> list[str]:
    return _field_re(field).findall(text)


def _has(text: str, pairs: tuple[tuple[str, str], ...]) -> bool:
    return any(value == want for field, want in pairs for value in _values(text, field))


def _exists_at(repo: Path, commit: str, path: str) -> bool:
    return _git(repo, "cat-file", "-e", f"{commit}:{path}", check=False).returncode == 0


def check(repo: Path, main: str, lvr_closeout_sha256: str | None = None) -> dict[str, str]:
    """Raise PredecessorError(reason) unless LVR PASS (a strict ancestor execution) and the historical L8p closeout both hold at ``main``."""
    repo = Path(repo)
    _commit(repo, main)
    found = receipts(repo, main)

    # L8p: exactly one receipt with BOTH fields, and it is the canonical closeout. Read-only predecessor proof; never an instruction to rerun.
    l8p = sorted(p for p, t in found.items() if "YES" in _values(t, "L8P_LIVE_EXECUTED") and "PASS" in _values(t, "L8P_PROVISIONING"))
    if l8p != [L8P_CLOSEOUT_REL]:
        raise PredecessorError("L8P_HISTORICAL_CLOSEOUT_MISSING_OR_NOT_CANONICAL" if not l8p else "L8P_HISTORICAL_CLOSEOUT_NOT_UNIQUE_OR_NOT_CANONICAL")

    # No LVR failure, no L8 / L8u result recorded anywhere.
    for path, text in sorted(found.items()):
        if _has(text, LVR_FAILURE_MARKERS):
            raise PredecessorError("LVR_FAILURE_RECORDED")
        if _has(text, L8_DONE_MARKERS):
            raise PredecessorError("L8_OR_L8U_ALREADY_RECORDED")

    # LVR: exactly one result receipt, the canonical suffix, every required field exactly once with the exact value.
    lvr = sorted(p for p, t in found.items() if _has(t, LVR_RESULT_MARKERS))
    if not lvr:
        raise PredecessorError("LVR_PASS_CLOSEOUT_MISSING")
    if len(lvr) != 1:
        raise PredecessorError("LVR_EVIDENCE_DUPLICATE_OR_SPLIT")
    path = lvr[0]
    if not path.startswith(f"{LOGS_REL}/") or not path.endswith(LVR_CLOSEOUT_SUFFIX):
        raise PredecessorError("LVR_RESULT_NOT_IN_THE_CANONICAL_CLOSEOUT_RECEIPT")
    text = found[path]
    for field, want in LVR_REQUIRED.items():
        values = _values(text, field)
        if len(values) != 1:
            raise PredecessorError(f"LVR_FIELD_MISSING_OR_DUPLICATE:{field}")
        if values[0] != want:
            raise PredecessorError(f"LVR_FIELD_VALUE_INVALID:{field}")

    # Descendant rule: LVR_EXECUTION_MAIN is a strict ancestor of the L8u main; the closeout was added AFTER it; L8p was already there.
    exec_values = _values(text, "LVR_EXECUTION_MAIN")
    if len(exec_values) != 1 or not re.fullmatch(r"[0-9a-f]{40}", exec_values[0]):
        raise PredecessorError("LVR_EXECUTION_MAIN_MISSING_OR_MALFORMED")
    execution = _commit(repo, exec_values[0])
    if execution == main:
        raise PredecessorError("LVR_EXECUTION_MAIN_IS_NOT_A_STRICT_ANCESTOR")
    if _git(repo, "merge-base", "--is-ancestor", execution, main, check=False).returncode != 0:
        raise PredecessorError("LVR_EXECUTION_MAIN_NOT_AN_ANCESTOR_OF_L8U_MAIN")
    if _exists_at(repo, execution, path):
        raise PredecessorError("LVR_CLOSEOUT_ALREADY_EXISTED_AT_EXECUTION_MAIN")
    if not _exists_at(repo, execution, L8P_CLOSEOUT_REL):
        raise PredecessorError("L8P_CLOSEOUT_NOT_IN_LVR_EXECUTION_HISTORY")

    digest = hashlib.sha256(_git(repo, "show", f"{main}:{path}").stdout.encode()).hexdigest()
    if lvr_closeout_sha256 is not None and digest != lvr_closeout_sha256:
        raise PredecessorError("LVR_CLOSEOUT_SHA256_PIN_MISMATCH")
    return {"L8P_PREDECESSOR": "PASS", "LVR_PREDECESSOR": "PASS", "LVR_EXECUTION_MAIN": execution, "LVR_CLOSEOUT_PATH": path, "LVR_CLOSEOUT_SHA256": digest}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="L8u predecessor gate (read-only)")
    parser.add_argument("--repo", type=Path, required=True)
    parser.add_argument("--main", required=True)
    parser.add_argument("--lvr-closeout-sha256")
    args = parser.parse_args(argv)
    try:
        results = check(args.repo, args.main, args.lvr_closeout_sha256)
    except PredecessorError as exc:
        print(f"L8U_PREDECESSOR=FAIL reason={exc}", file=sys.stderr)
        return 1
    for key, value in results.items():
        print(f"{key}={value}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
