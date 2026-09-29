---
title: Task Receipt — IDEA3 L34 V5 listener convergence + IDEA2 engine heartbeat baseline fix
date: 2026-09-29T11:51:12+07:00
owner: music
area: idea3
branch: fix/idea3-l34-v5-convergence-preservation
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 L34 V5 listener convergence + IDEA2 engine heartbeat baseline fix

## What changed

- Repository-only fix for the two defects found by the read-only forensic of the consumed L3/L4 V5 attempt (`2026-09-29-l34-v5-20260929-111559`). No Production mutation, no L4 retry, no service/NM/nft action, no L6c, no L7, no ESP32.
- V5 `apply.sh`: the exact-set 8883 listener gate (`l34_v4_broker_listeners_gate`, unchanged) is now polled read-only and bounded (`AEGIS_L34_V5_LISTEN_TRIES=15`, `AEGIS_L34_V5_LISTEN_INTERVAL=1`) after the broker reaches active/running, because the broker is `Type=simple` and reports running ~20 ms before it binds. On final failure the observed set is written to `broker-listeners-observed.txt`. No broker command added.
- `p4-compare.sh`: `idea2.engine.journal.heartbeat_failed|refused` growth is `BASELINE_UNHEALTHY_BUT_UNCHANGED` only when runtime_healthy=NO and `idea2.listen.18002` absent in both captures and the count did not decrease. All other engine classes, 18002 state changes, healthy-to-unhealthy and decreases still fail.
- Simulator gained three knobs (`broker_listener_lag_polls`, `broker_listener_lag_shape`, `broker_listener_extra`).

## Source files changed

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/reactivation/l34-v5-post-l6b-degraded/apply.sh` — bounded listener poll and diagnostics.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-compare.sh` — narrow engine heartbeat baseline rule.
- `IDEA3-AEGIS_Lockdown/tests/l34_sim.py` — lagged/extra listener simulation.
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l34_v5_post_l6b_degraded.py` — 7 new tests (knob pins, empty→pair, one→pair, bounded failure with observed set, rollback without broker touch, extra listener still fails).
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_harness.py` — 9 new test cases for the compare rule (exact 0→1 case plus five guard cases, four parametrized).
- `IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-09-28-idea3-pr11-phase4-l34-v5-post-l6b-degraded-reactivation-design.md` — amendment for the listener poll.

## Verification evidence

- `pytest tests/test_pr11_phase4_l34_v5_post_l6b_degraded.py -k "waits_for or poll"` against the ORIGINAL apply.sh (RED) — fail: 4 failed (race tests); with the fix (GREEN) — pass.
- `pytest tests/test_pr11_phase4_harness.py -k engine_heartbeat_growth_pre_zero` against the ORIGINAL p4-compare.sh (RED) — fail: 1 failed; with the fix (GREEN) — pass.
- `pytest tests/test_pr11_phase4_l34_v5_post_l6b_degraded.py` — pass: 47 passed.
- `pytest tests/test_pr11_phase4_harness.py -k engine_` — pass: 10 passed.
- `pytest tests/test_pr11_phase4*.py` (53 files) — fail: 2647 passed, 2 skipped, 1 failed. The one failure, `test_only_reviewed_stage_handlers_are_registered`, also fails on unmodified main (`stages/L7/l7-listener-lib.sh` from PR #246 is missing from the expected registry); not caused by this task and not fixed here.
- `pytest tests/test_pr11_phase4_l6c_capture_gap.py::test_real_end_to_end_capture_then_compare_requires_the_allow_file` repeated — fail (flaky, NOT fixed): old compare 2 of 8 runs failed; new compare 9 of 40 failed. All new-compare failures were unrelated live-host churn (ephemeral enp62s0 UDP listeners, IDEA2 tunnel activating/active); the engine heartbeat drift appeared in none.
- `bash -n p4-compare.sh apply.sh` — pass.
- `git diff --check` — pass.
- `node scripts/validate-vault.mjs` — pass: 2 pre-existing canvas warnings.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — V5 attempt 1 failure, forensic classification, repository fix and remaining limits.

## Shared surfaces touched

- None — task stayed inside `idea3`.

## Integration requests

- None — valid: no cross-scope path changed. IDEA2 owner (Pub) decision is still needed on the S10 policy: S10 requires zero BASELINE_UNHEALTHY_BUT_UNCHANGED findings, so while IDEA2 is unhealthy (tunnel/runtime NO, 18002 absent) any V5 compare still fails S10.

## Known limitations

- Repository/simulator only; the race fix is not proven live.
- This fix does not make a V5 retry pass: the compare still fails S10 while the IDEA2 baseline is unhealthy, and the host no longer matches V5's PRE gate (broker running with a stale 10.77.30.1 bind, dnsmasq inactive). A V6 baseline decision and a re-freeze with fresh authorization are required.
- The exact listener set the failed attempt saw was never logged; the race is inferred from journal timing.
- The L6c end-to-end test remains host-coupled and flaky; a hermetic journal fixture is a follow-up.
- Pre-existing main failure in the stage-handler registry test (see above).
