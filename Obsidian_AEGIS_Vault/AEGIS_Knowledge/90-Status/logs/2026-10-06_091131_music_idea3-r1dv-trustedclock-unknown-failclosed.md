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

## Verification

- `/usr/bin/python3 -m pytest -q tests/r1dv` — 218 passed.

## Known limitations

- Repository only; R1Dv has not run live and the current live TrustedClock state is not probed here.
