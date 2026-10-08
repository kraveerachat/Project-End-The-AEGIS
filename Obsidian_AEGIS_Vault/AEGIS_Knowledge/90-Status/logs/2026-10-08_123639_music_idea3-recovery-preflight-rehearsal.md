---
title: Task Receipt — IDEA3 Recovery non-consuming pre-live rehearsal (tooling only)
date: 2026-10-08T12:36:39+07:00
owner: music
area: idea3
branch: feat/idea3-recovery-preflight-rehearsal
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 Recovery non-consuming pre-live rehearsal (tooling only)

## What changed

- Added a read-only, non-consuming rehearsal for the single governed Recovery R2–R8 attempt, on main `6ed423457e3b886b9cecdfc25b9a0eca7a2c2671` (b858bd12 plus the web-only PR #400, merged into this branch without conflicts). It is repository tooling only: not an authorization, not wired into the Recovery runner or any gate, and not executed on Production.
- `recovery-preflight-rehearse.sh` re-proves the tool is the exact-main code, `recovery_rehearsal_build.py` derives a private rehearsal copy of a frozen runner (frozen runner only read; it must equal the reviewed template plus approved pins and end in the known attempt block), and `recovery_preflight_rehearsal.sh` replaces the final `recovery_run_attempt` call with a driver that runs ONLY the runner's existing read-only checks: pre-gates (all failures collected, including the existing CTu-PASS-or-CTv-PASS predecessor gate), pre-marker re-gate, attempt-unconsumed, and `aegisctl restore --help` from the pinned release.
- Every consuming or mutating runner/library function is a tripwire, the Core client wrapper allows only `socket-check` and `check-reason`, and privileged commands go through a default-deny read-only wrapper. Results are PASS, BLOCKED or NOT_REHEARSED; baseline, root captures, the exact D4 terminal refusal, the marker and all post-marker steps are NOT_REHEARSED. A PASS prints `AUTHORIZES_RECOVERY=NO` and carries no token or digest any gate accepts.
- No existing gate, predecessor criterion, runner template, freeze tool, library, CTv/CTu script or evidence was edited.

## Source files changed

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/recovery-acceptance/recovery-preflight-rehearse.sh` — entry point.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/recovery-acceptance/recovery_rehearsal_build.py` — derived-copy builder.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/recovery-acceptance/recovery_preflight_rehearsal.sh` — driver library (functions only).
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/recovery-acceptance/RECOVERY-PREFLIGHT-REHEARSAL.md` — usage and limits.
- `IDEA3-AEGIS_Lockdown/tests/recovery/test_recovery_preflight_rehearsal.py` — builder and entry tests.
- `IDEA3-AEGIS_Lockdown/tests/recovery/test_recovery_preflight_rehearsal_driver.py` — driver, wrapper, repeatability and mutation tests.

## Verification evidence

- `pytest tests/recovery/test_recovery_preflight_rehearsal.py tests/recovery/test_recovery_preflight_rehearsal_driver.py` — pass (all hermetic: stub sudo, stub release CLI, temp canonical-directory seam). Covers a positive rehearsal; blocked pre-gates, re-gate, CLI parse and consumed marker; CTv CLOSED_FAIL reported as the blocking predecessor while the real CTu and CTv gates still refuse; tripwires for every poisoned function including inside subshells; the wrapper denying mutation verbs and unknown programs and allowing only read verbs; no restore invocation; no marker or work directory; repeated rehearsals leaving no residue; environment overrides; frozen-runner immutability; and mutation tests of five safeguards.
- `pytest tests/recovery tests/test_recovery_stage.py tests/test_pr11_phase4_harness.py tests/test_ctv_successor.py tests/test_ctv_incident_option_b.py tests/test_ctu_blockers.py tests/rru tests/r1bv` — 1538 passed, 3 failed. All 3 fail identically on a tree containing only main plus unrelated web files: `test_only_reviewed_stage_handlers_are_registered`, `test_r1bv_is_registered_exactly_once_right_after_r1b_and_is_non_mutating`, `test_the_recovery_stage_reuses_the_r1bv_predecessor_gate_without_bypassing_r1bv_or_rru` (stale stage-order expectations: CTv is registered after CTu); unrelated.
- `git diff --check`, `bash -n` on the shell files, vault validation — pass.

## Canonical notes updated

- `None` — no durable project fact changed.

## Shared surfaces touched

- `None` — IDEA3-owned paths only

## Integration requests

- None — valid only when no cross-scope/shared path changed

## Known limitations

- NOT EXECUTED on Production: the real runner prefix needs an interactive `sudo -v`, a pinned control snapshot and a frozen runner, none of which exist for Recovery yet (and the existing freeze requires a CTu PASS). Hermetic tests cover the builder, entry guards, driver and wrapper; the derived runner is shown to stop at the runner's own prefix gates, not run end to end.
- Privileged Python gates of the reviewed libraries take their code from stdin; the wrapper constrains the interpreter and script location, not those reviewed bodies. The exact D4 terminal-refusal rehearsal is not run (it would execute the restore entry point); the baseline and root captures are not rehearsed.
- The rehearsal reports the existing predecessor gate's verdict; against the current CTv CLOSED_FAIL history it reports BLOCKED. It does not change that gate or the successor feasibility work.
