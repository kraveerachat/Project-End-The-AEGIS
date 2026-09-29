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
- Recovery merge remains blocked until L7 #4 live acceptance is proven and the
  Recovery stack is reconciled against the then-current `main`.

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
