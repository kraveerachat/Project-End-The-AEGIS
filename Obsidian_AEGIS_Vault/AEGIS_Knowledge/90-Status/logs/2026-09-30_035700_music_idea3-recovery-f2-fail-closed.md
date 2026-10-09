---
title: Task Receipt — IDEA3 Recovery F2 fail-closed one-shot invariant
date: 2026-09-30T03:57:00+07:00
owner: music
area: idea3
branch: fix/idea3-recovery-f2-fail-closed
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 Recovery F2 fail-closed one-shot invariant

> [!important] IMPLEMENTED != DEPLOYED
> Repository-only hardening stacked on PR #255 (`fix/idea3-recovery-security-f1-f4`,
> head at task start `b98f3925b2fbf74a3949aa04cec8f25db36d7f49`).
> No Production mutation, Core restart, Recovery live execution, MQTT publish,
> RESTORE/CUT, L7/L8 execution, ESP32 access, authorization creation, or merge
> occurred in this task.

## Current-state reconciliation (post-L7 / post-PR #255 reconcile, 2026-10-01)

> [!note] Historical text below is preserved
> The original verification history and the original "L7 #4 hold" wording in
> this receipt are kept as historical evidence of the task at the time. This
> section supersedes them for current state only.

- The old L7 #4 hold is **historical** and is **satisfied by L7 #7 live
  acceptance (PROVEN)**; PR #267 (L7 closeout) and PR #269 (post-L7 test
  regression fix) are merged.
- Parent PR #255 is now reconciled at
  `ab90f27e2f00c688bcd3cc1a69e694ba29904999` (on top of PR #252 reconciled
  post-L7 at `ba5caa3cbf042a00133fcc662c5f1800fd3a8edc`). The earlier parent
  head `b98f3925…` named above is the task-start head only.
- PR #262 is stacked on that reconciled parent (merged cleanly; parent is an
  ancestor; 3-path stack-local scope unchanged) and remains **repository-only /
  NOT DEPLOYED**.
- Recovery live acceptance (R1–R8) remains **NOT PROVEN**.
- Production Core has **not** been upgraded or restarted for Recovery.
- F1 (production alert provenance) remains **unresolved**.
- R5 break-glass / production precondition remains **unresolved**; its strict
  XFAIL (`test_production_supervisor_enforces_r3_before_restore`) is unchanged
  and intentional.
- LVR remains **not proven**.
- L8 / ESP32 remains **blocked**.
- No Production mutation, Recovery live run, Core restart, authorization/K3
  creation, ESP32 access, or L8 start occurred during this reconciliation.
- Post-reconcile verification: F2 test `1 passed`; security suite
  `36 passed, 1 xfailed`; release-builder `86 passed`; Ruff and compileall
  pass; `git diff --check` against the parent passes.
- Post-reconcile full IDEA3 suite (`pytest tests -q`, serial, nothing
  deselected): `1 failed, 4186 passed, 8 skipped, 1 xfailed`. The single failure,
  `tests/test_local_restore.py::test_closing_the_channel_cancels_an_incomplete_client_before_returning`
  (a 1-second wait), passed 3/3 in isolation, passed in its whole file
  (`150 passed`), and passed 2/2 on the unmodified parent `ab90f27e`. This PR
  does not touch that code path; it is recorded as a non-reproducing
  timing-sensitive failure under a ~20-minute full-suite load, not as a clean
  full-suite pass. *(Historical; superseded by the final run below. The root
  cause of that one-off failure was not proven.)*
- **FINAL / superseding full IDEA3 verification** (same command, serial, no
  `-x`, nothing deselected, no xdist, no code changes between runs):
  `4187 passed, 8 skipped, 1 xfailed` in 1154s, exit code 0.

## What changed

- F2 Recovery one-shot initialization now fails closed when historical
  `RESTORE_REQUESTED` rows for the same non-null `incident_id` prevent SQLite
  from creating the durable partial UNIQUE index
  `ux_audit_restore_requested_incident`.
- The previous behavior printed a warning and continued startup without the
  database-level one-shot invariant. That fallback is removed.
- Existing duplicate audit history is not deleted, rewritten, deduplicated, or
  migrated automatically. `sqlite3.IntegrityError` propagates from
  `init_db()` so an operator must explicitly remediate the historical conflict
  before the Recovery Core can initialize with the invariant proven.
- NULL-incident legacy rows remain outside the partial UNIQUE index and their
  existing semantics are unchanged.
- Incident authority, F1 alert provenance, R5 production precondition wiring,
  MQTT behavior, Recovery UI, containment, and Production deployment are
  unchanged.

## Source files changed

- `IDEA3-AEGIS_Lockdown/aegis_soc/database.py` — fail closed when historical duplicates prevent creation of the Recovery one-shot UNIQUE index; preserve history.
- `IDEA3-AEGIS_Lockdown/tests/test_core_recovery_security.py` — replace the previous permissive duplicate-history characterization with a RED/GREEN fail-closed preservation test.

## Verification evidence

- `~/.venvs/aegis-idea3-core/bin/python -m pytest tests/test_core_recovery_security.py -q` — pass: `36 passed, 1 xfailed`.
- RED:
  `~/.venvs/aegis-idea3-core/bin/python -m pytest tests/test_core_recovery_security.py::test_init_db_fails_closed_and_preserves_history_when_old_duplicates_exist -q`
  — fail as expected before implementation:
  `Failed: DID NOT RAISE IntegrityError`; old code printed
  `DB warning: duplicate RESTORE_REQUESTED history; one-shot index not created (read guard still applies)`.
- Focused GREEN:
  `~/.venvs/aegis-idea3-core/bin/python -m pytest tests/test_core_recovery_security.py::test_init_db_fails_closed_and_preserves_history_when_old_duplicates_exist -q`
  — pass: `1 passed`.
- Security suite:
  `~/.venvs/aegis-idea3-core/bin/python -m pytest tests/test_core_recovery_security.py -q`
  — pass: `36 passed, 1 xfailed`.
- Affected Recovery suite:
  `~/.venvs/aegis-idea3-core/bin/python -m pytest tests/test_core_recovery.py tests/test_local_restore.py tests/test_core_recovery_security.py -q`
  — pass: `259 passed, 1 xfailed`.
- `~/.venvs/aegis-idea3-core/bin/python -m py_compile aegis_soc/database.py`
  — pass.
- `~/.venvs/aegis-idea3-core/bin/python -m ruff check aegis_soc/database.py tests/test_core_recovery_security.py`
  — pass: `All checks passed!`.
- `git diff --check`
  — pass.
- Full IDEA3 suite:
  `~/.venvs/aegis-idea3-core/bin/python -m pytest tests -q`
  — `3953 passed, 8 skipped, 1 xfailed, 2 failed`.
  Neither observed failure was attributed to the F2 changes:
  - `tests/test_pr11_phase4_harness.py::test_only_reviewed_stage_handlers_are_registered`
    also fails on the unmodified PR #255 base because the L7 directory contains
    the pre-existing extra `l7-listener-lib.sh`.
  - `tests/test_pr11_phase4_l6c_capture_gap.py::test_real_end_to_end_capture_then_compare_requires_the_allow_file`
    observed transient UDP-listener churn during the full run. The same targeted
    test passed on unmodified PR #255 and passed when rerun on this F2 branch.
- PR #255 base control:
  targeted harness + L6c tests — `1 failed, 1 passed`; only the known
  `l7-listener-lib.sh` harness failure remained.

## Canonical notes updated

- `None` — this task is repository-only hardening stacked on an unmerged Draft
  Recovery stack. No Production or merged project-maturity fact changed.

## Shared surfaces touched

- `None` — changes remain inside the IDEA3 Core-owned Recovery SQLite behavior,
  IDEA3 tests, and this IDEA3 receipt.

## Integration requests

- None — no cross-scope/shared path changed.
- *(Historical, at task time; see "Current-state reconciliation" above — the
  L7 #4 hold is now satisfied by L7 #7.)* Recovery merge remains blocked until
  L7 #4 live acceptance is proven and the Recovery stack is reconciled against
  the then-current `main`.

## Known limitations

- Repository/local evidence only; no live Core startup against the Production
  audit database was performed.
- No automatic remediation policy is introduced for an already-duplicated
  Production database. Historical conflicts deliberately require explicit
  operator remediation rather than destructive or inferred cleanup.
- F1 production alert provenance remains unresolved.
- R5 production `precondition_lookup` / break-glass enforcement remains an
  owner-decision item and its strict XFAIL remains intentionally present.
- Recovery R1–R8 live acceptance is not proven.
