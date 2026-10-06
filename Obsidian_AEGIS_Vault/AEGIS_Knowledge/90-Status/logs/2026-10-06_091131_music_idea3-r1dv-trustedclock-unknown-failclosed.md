---
title: Task Receipt — IDEA3 R1Dv TrustedClock UNKNOWN fail-closed hotfix
date: 2026-10-06T09:11:31+07:00
owner: music
area: idea3
branch: fix/idea3-r1dv-trustedclock-unknown-failclosed
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 R1Dv TrustedClock UNKNOWN fail-closed hotfix

## What changed

- The merged R1Dv runner's `clock_available` accepted `UNKNOWN`, which `p4-l5-clock.py state` emits (`reason=PROBE_UNAVAILABLE`) when the kernel probe is unavailable. It now accepts exactly one `time.trustedclock.state` record whose value is `SYNCED`, `HOLDOVER` or `UNTRUSTED`; `UNKNOWN`, `UNAVAILABLE`, `NOT_RECORDED`, empty, missing, duplicate and any other value are refused.
- Regression tests cover every state plus the real failure mode via a hermetic stub (live clock untouched). `p4-compare`, the allowlists, historical R1D and R1B semantics are unchanged.
- Docs: README section 20 now states the reviewed R1Dv execution order; the `r1dv_verifier_snapshot.py` docstring names `historical_validation` + `trusted_time` instead of `r1_acceptance`.

## Boundary

- Repository only. `R1DV_LIVE_EXECUTED=NO`, `R1DV_AUTHORITY_CREATED=NO`, `R1DV_AUTHORIZATION_CREATED=NO`, `R1D_RERUN_EXECUTED=NO`, `R1D_SOCKET_CONNECTED=NO`, `R1B_LIVE_EXECUTED=NO`, `RECOVERY_R2_R8_EXECUTED=NO`, `PRODUCTION_MUTATION_PERFORMED=NO`.
- `F1_REAL_DETECTOR_ACCEPTANCE=NOT_PROVEN`, `R1_VERIFIED=NOT_CLAIMED`.

## Verification evidence

- `/usr/bin/python3 -m pytest -q tests/r1dv` — 218 passed.
- `node scripts/validate-vault.mjs` — pass (2 known canvas warnings). No Production command was run.

## Source files changed

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/owner-run/run-r1dv-owner.sh`, `r1dv-acceptance/r1dv_verifier_snapshot.py` (docstring only), `deploy/pr11-phase4/README.md` (section 20), `tests/r1dv/test_r1dv_contract.py`, and this receipt.

## Canonical notes updated

- None (hotfix; no canonical note change).

## Shared surfaces touched

- None — all paths are inside the IDEA3/Music-owned boundary.

## Integration requests

- Independent review. R1Dv LIVE preparation resumes after merge; nothing here authorizes it.

## Known limitations

- Repository only; R1Dv has not run live and the current live TrustedClock state is not probed here.
