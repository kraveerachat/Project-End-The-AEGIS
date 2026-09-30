---
title: Task Receipt — IDEA3 L7 post-acceptance receipt-gate test regression
date: 2026-09-30T22:30:00+07:00
owner: music
area: idea3
branch: fix/idea3-l7-receipt-gate-post-acceptance-test
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 L7 post-acceptance receipt-gate test regression

> [!important] Repository test maintenance only
> No Production mutation, no L7 re-run, no authorization/K3 created, no service/Core restart, no `/etc`/`/opt`/network/nftables/broker change, no ESP32, no L8. The production gate `p4-l7-run-lib.sh` is unchanged.

## What changed

- **Regression:** after the L7 #7 closeout receipt merged (`L7_LIVE_ACCEPTANCE = PROVEN`), `tests/test_pr11_phase4_l7_runner.py::test_l7_receipt_gate_passes_against_the_real_repository_history` failed on clean `main` (`c1dc3c90`), independent of PR #252. It was the only failure in the full IDEA3 suite (4150 passed, 8 skipped, 1 failed).
- **Old test assumption:** the real repository history contains only L2..L6b acceptance, so `l7_receipt_gate` returns 0.
- **Expected post-L7 behavior (unchanged in source):** real history contains predecessor acceptance AND the merged L7 acceptance, so `l7_receipt_gate` returns 1 with `L7_ALREADY_ACCEPTED` (one-shot).
- **Fix (test only):** the test is renamed `test_l7_receipt_gate_refuses_a_new_attempt_against_the_real_post_l7_repository_history`. It skips if the L6b or L7 acceptance receipt is absent at HEAD, asserts `l6b_receipt_gate` passes on real history (predecessors intact), then asserts `l7_receipt_gate` returns 1 with `L7_ALREADY_ACCEPTED` and without `L7_L6B_ACCEPTANCE_RECEIPT_MISSING`.
- The four fixture tests (predecessors pass before L7 receipt, missing predecessor fails, already-accepted fails, unmerged working-tree receipt ignored) are untouched.

## Source files changed

- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l7_runner.py` — stale real-history test rewritten for the post-L7 contract.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-l7-run-lib.sh` — NOT changed.

## Verification evidence

- Focused failing test before fix (`pytest tests/test_pr11_phase4_l7_runner.py -k real_repository`) — fail: `L7_ALREADY_ACCEPTED`, reproduced.
- Focused renamed test — pass (1 passed).
- `pytest tests/test_pr11_phase4_l7_runner.py -q` — pass: 124 passed.
- `pytest tests/test_pr11_phase4_l7_runner_flow.py tests/test_pr11_phase4_l7_handler.py tests/test_pr11_phase4_l6b_runner.py -q` — pass: 343 passed.
- `pytest tests -q` (full IDEA3 suite, nothing deselected, no `-x`) — pass: 4078 passed, 8 skipped, 0 failed (this base does not include PR #252's extra tests).
- `git diff --check` — pass: clean.
- `node scripts/validate-vault.mjs --vault Obsidian_AEGIS_Vault/AEGIS_Knowledge` — pass with 2 pre-existing canvas owner-data warnings.
- Secret-pattern scan of the diff — pass: 0 hits.

## Canonical notes updated

- `None` — no durable project fact changed; the L7 #7 status section already records the acceptance and this only aligns a test with it.

## Shared surfaces touched

- `None` — task stayed inside its selected area

## Integration requests

- None — valid only when no cross-scope/shared path changed

## Known limitations

- The renamed test depends on the real repository containing the merged L7 acceptance receipt; it skips on a checkout that lacks it.
- Production mutation = NO; L7 rerun = NO; ESP32 touched = NO; L8 started = NO.
