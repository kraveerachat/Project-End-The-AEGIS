---
title: Task Receipt — IDEA3 L34 V7 pre-live hardening (F1/F2/F3)
date: 2026-10-01T08:15:32+07:00
owner: music
area: idea3
branch: fix/idea3-l34-v7-prelive-hardening
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 L34 V7 pre-live hardening (F1/F2/F3)

## What changed

- Repository-only hardening of the merged V7 (PR #272, main `42039d47`). **V7 was NOT run; no authorization or K3 record was created, used or consumed; no production mutation; Core NOT restarted; no ESP32; no L8; Recovery R1-R8 NOT run.**
- **F1:** the V7 owner runner now consumes the one-shot marker only after handler preflight and PRE capture, immediately before `apply.sh` (pre-gates → preflight → PRE capture → consume → mutation). A refused preflight / failed PRE capture leaves the authorization usable; after consumption the attempt is spent even if apply fails (rollback runs); replay is refused before any work.
- **F2:** the broker bind-failure journal is captured with `journalctl -u UNIT -b _SYSTEMD_INVOCATION_ID=<failed InvocationID>` from the same `systemctl show` capture the churn gate reads; the gate requires a non-empty 32-hex InvocationID and a matching correlation line. Previous-boot / earlier-invocation bind evidence (alone or with an unrelated current failure) is refused. All existing churn checks kept; no broker start/stop/restart added.
- **F3:** regression tests for missing / mismatched rfkill identity evidence (verify, rollback) and rollback fail-closed ownership.

## Source files changed

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/owner-run/run-l34-v7-radio-disabled-broker-churn-owner.sh` — F1 ordering; F2 single show capture feeding journal capture and gate.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-l34-reactivation-lib.sh` — V7 section only: `InvocationID` in `l34_v7_broker_show`, new `l34_v7_broker_journal_capture`, correlation checks in `l34_v7_broker_churn_gate` (V1–V6 part byte-identical).
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/reactivation/l34-v7-radio-disabled-broker-churn/apply.sh` — uses the correlated capture.
- `IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-10-01-idea3-pr11-phase4-l34-v7-radio-disabled-broker-churn-design.md` — documents F1 ordering and F2 binding.
- `IDEA3-AEGIS_Lockdown/tests/l34_sim.py` — defaulted keys: `broker_journal_stale_bind`, per-entry (boot, invocation) journal model, crash-loop InvocationID.
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l34_v7_owner_run_flow.py` — F1 tests.
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l34_v7_radio_disabled_broker_churn.py` — F2/F3 tests.
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l34_v7_scope_contract.py` — consume-order pin updated to the corrected order.

## Verification evidence

- `pytest -p no:cacheprovider tests/test_pr11_phase4_l34_v7_owner_run_flow.py tests/test_pr11_phase4_l34_v7_radio_disabled_broker_churn.py` RED first (before the runner/lib/handler changes) — expected fail: 5 F1 tests and 17 F2 tests failed; F3 characterization tests passed on unchanged code (regression coverage only).
- `pytest tests/test_pr11_phase4_l34_v7_*.py` — pass (V7 focused: 128 baseline + 35 new, all passing within the full L34 run).
- Negative controls (temporary source mutation, restored byte-identical, sha256 asserted): consume-before-preflight; drop `-b`; drop invocation filter; drop gate correlation; drop InvocationID validity — each fails the targeted tests as expected.
- Full L34 (`pytest $(ls tests/test_pr11_phase4_l34_*.py tests/test_pr11_phase4_l3_rfkill.py)`) at final tree — pass: `888 passed, 0 failed, 0 skipped`, exit 0 (baseline was 853).
- All other `tests/test_pr11_phase4_*.py` — pass: `2354 passed, 2 skipped` (unchanged from baseline); the 12 modules that read vault/spec docs re-run after the doc edits — pass: `1054 passed`.
- `bash -n` on lib, V7 runner, apply/verify/rollback — pass. `git diff --check` — pass.
- `node scripts/validate-vault.mjs` — pass: `Vault validation passed with 2 warning(s)` (pre-existing canvas owner-review warnings). `node scripts/validate-collaboration-policy.mjs --event <simulated Draft event> --changed-files <git diff --cached --name-status origin/main>` — pass: `Collaboration policy passed.` Secret-pattern scan over changed files — pass: no new hits (two pre-existing prose mentions of "bearer" in `idea3-status.md`).

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — added the V7 pre-live hardening (F1/F2/F3) section; repository-only, nothing live.

## Shared surfaces touched

- `None` — task stayed inside its selected area

## Integration requests

- None — valid only when no cross-scope/shared path changed

## Known limitations

- Simulator-tested only; no real-host evidence. `REAL_HOST_COMPARATOR_EVIDENCE=MISSING`.
- Real systemd/journald behavior of `_SYSTEMD_INVOCATION_ID` on a unit in `auto-restart` (InvocationID retained from the failed run) is assumed from systemd semantics and is verified only by the live preflight, which fails closed if the id is empty or the journal lacks the bind signature.
- Fresh formal IDEA2/S10 evidence, an owner-frozen runner, a fresh same-day authorization + K3 and an explicit owner live authorization are all still required before V7 live.
