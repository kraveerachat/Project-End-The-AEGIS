---
title: Task Receipt — IDEA3 LVR/L8/L9 offline acceptance
date: 2026-10-08T14:00:00+07:00
owner: music
area: idea3
branch: feat/idea3-lvr-l8-l9-offline-acceptance
status: partial
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 LVR/L8/L9 offline acceptance

## What changed

- Ran the existing L8/L9 offline suites against `origin/main` 6ed423457e3b886b9cecdfc25b9a0eca7a2c2671: 1027 passed, 3 failed. All 3 failures were stale stage-registry assertions that predate the merged CTu/CTv insertion into `P4_STAGES` (source was correct; tests were stale). Corrected the expectations.
- Added an offline cross-stage contract suite pinning the Recovery → L8 → L9 boundary: `LVR` is not a registered stage and the gate refuses it as `STAGE_UNKNOWN`; L8 alone carries `recovery_authorization`; the gate never prints `LIVE_STAGE_AUTHORIZED=YES` for L8/L9; stale and cross-stage-replayed authorizations are refused; Recovery acceptance claims LVR/L8/L9 as not proven.
- Finding (not fixed, recorded as a strict xfail): the digest-frozen `p4-stage-gate.sh` accepts `recovery_authorization` on an L9 record although its comment declares the field L8-only. Not edited because the gate sha256 is pinned and it is a frozen predecessor gate.
- No Production, hardware, broker, Recovery, CTu or CTv action was performed.

## Source files changed

- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l8p_provisioning.py` — registry-order expectation updated to the real `P4_STAGES`.
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l7u_stage_governance.py` — registry-order expectation now includes `CTv`.
- `IDEA3-AEGIS_Lockdown/tests/r1b/test_r1b_stage.py` — adjacency expectation now `R1Bv → RRu … CTv → Recovery → L8`.
- `IDEA3-AEGIS_Lockdown/tests/r1b/test_r1b_live_failure_closeout.py` — registry-order expectation now includes `CTv`.
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_lvr_l8_l9_offline_contract.py` — new offline contract suite.

## Verification evidence

- `python3 -m pytest tests -k "l8 or l9" -q` (baseline, before edits) — fail: 3 failed, 1027 passed (stale registry assertions).
- `python3 -m pytest tests/r1b/test_r1b_stage.py tests/test_pr11_phase4_l7u_stage_governance.py tests/test_pr11_phase4_l8p_provisioning.py -q` — pass: 381 passed.
- `python3 -m pytest tests/test_pr11_phase4_lvr_l8_l9_offline_contract.py -q -rx` — pass: 15 passed, 1 xfailed (the L9 gate finding).
- `python3 -m pytest tests -q` (full suite, this branch) — fail: 163 failed, 10314 passed, 9 skipped, 1 xfailed, 56 errors.
- Same 22 failing files re-run on a pristine `origin/main` worktree — identical 163 failed + 56 errors (all pre-existing, none introduced here; e.g. sandbox lacks `pip` for release-builder tests). One extra ID, `tests/test_local_restore.py::test_closing_the_channel_cancels_an_incomplete_client_before_returning`, was flaky and passed 3/3 in isolation.

## Canonical notes updated

- `None` — no durable implemented/deployed fact changed; LVR remains an owner-runbook ceremony and L8/L9 live remain not executed.

## Shared surfaces touched

- `None` — task stayed inside `IDEA3-AEGIS_Lockdown/` and the IDEA3 receipt folder.

## Integration requests

- None — valid only when no cross-scope/shared path changed

## Known limitations

- 163 failures + 56 errors pre-exist on `origin/main` (environment-dependent owner-run-flow and release-builder suites); they are not fixed or hidden by this task.
- LIVE_L8 and LIVE_L9 are NOT_AUTHORIZED and NOT executed; LVR is not implemented as a stage; all are blocked behind Recovery, which remains unauthorized.
- The L9 `recovery_authorization` gate gap needs an owner-approved gate successor (the current gate is digest-frozen).
- Fixture and simulated devices only; no evidence of physical CUT/RESTORE, device flash, or Production MQTT behavior.
