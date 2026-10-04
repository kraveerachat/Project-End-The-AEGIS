---
title: Task Receipt — L6c capture-gap test determinism
date: 2026-10-03T23:50:10+07:00
owner: music
area: idea3
branch: fix/idea3-l6c-capture-gap-test-determinism
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — L6c capture-gap test determinism

## What changed

- Root cause: `test_real_end_to_end_capture_then_compare_requires_the_allow_file` ran the real `p4-l0-capture.sh` against the live host and asserted the host-wide `FINDINGS_NEW_OR_WORSENED_DRIFT=0`. An unrelated ephemeral high-port UDP listener appearing between the test's PRE and POST captures added a drift finding, so unrelated listener churn could decide the result. It also failed on pristine `origin/main`.
- Fix: the test proof is now scoped to the L6c release surface only (the `host.path./opt/aegis-idea3*` keys and `host.aegis_idea3.release_catalog*`) through a new `release_drift()` helper. Without the allow files the release surface must still report `RELEASE_UNAPPROVED_ADDITION` for `rel-a`; with them it must report no drift and `L6C_RELEASE_INSTALLED`.
- Regression: `test_unrelated_host_listener_churn_cannot_decide_the_release_proof` binds a real UDP socket during the POST capture; unrelated host listener churn no longer decides this L6c release-specific proof.
- Production capture semantics unchanged (`p4-l0-capture.sh` untouched). Production compare semantics unchanged (`p4-compare.sh` untouched). No NTP or L8p implementation path changed.
- This does not claim the host is globally drift-free; the host-wide total is simply no longer asserted by this one test, and the production drift tests elsewhere are unchanged.
- No Production mutation. No ESP32 access.

## Source files changed

- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l6c_capture_gap.py` — test-harness-only: release-scoped assertions, `release_drift()` helper, listener-churn regression test.

## Verification evidence

- `pytest -q -p no:cacheprovider tests/test_pr11_phase4_l6c_capture_gap.py -k "end_to_end or churn"` x10 — pass: 3 passed on each of 10 repetitions.
- `pytest -q -p no:cacheprovider tests -k "pr11_phase4 or pr11_phase2 or firmware_contract"` on exact main `7d7e40b3ab3c8ffc2b766073c190b6876578d257` plus this change — pass: 4528 passed, 5 skipped, 0 failed.
- `git diff --check` — pass.

## Canonical notes updated

- `None` — test-harness repair only; no durable project fact changed.

## Shared surfaces touched

- `None` — task stayed inside the IDEA3 area

## Integration requests

- None — no cross-scope/shared path changed

## Known limitations

- The test no longer asserts host-wide drift-free state during the live-host capture; that was the nondeterministic input.
