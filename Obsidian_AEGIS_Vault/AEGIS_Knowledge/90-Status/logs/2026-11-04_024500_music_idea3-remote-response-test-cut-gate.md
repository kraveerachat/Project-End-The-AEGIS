---
title: Task Receipt — IDEA3 remote-response tests follow the one-shot CUT gate
date: 2026-11-04T02:45:00+07:00
owner: music
area: idea3
branch: test/idea3-remote-response-cut-gate-tests
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 remote-response tests follow the one-shot CUT gate

## What changed

- Six tests written before the one-shot CUT authorization (#447/#448) still called `confirm_cut` without the pending
  `request_id` and, for the lab relay, without a Core grant. On `main` (95cafa17) with `cryptography` and `mosquitto`
  installed they failed with `REQUEST_ID_REQUIRED` and `CUT_AUTHORIZATION_REQUIRED`.
- The tests now pass the pending request id and, for the lab relay, the existing `_test_core_grant_dispatch` helper. The tests also
  assert the stronger behaviour: no request id is refused, and no Core grant sends no command.
- Tests only. No production code changed and no assertion was weakened.

## Source files changed

- `IDEA3-AEGIS_Lockdown/tests/test_remote_response_core.py`
- `IDEA3-AEGIS_Lockdown/tests/test_remote_alert_e2e.py`

## Verification evidence

- `python -m pytest tests/test_remote_response_core.py tests/test_remote_alert_e2e.py` — 42 passed.
- The 32 test files touched by the CUT-authorization work, run on this branch (Python 3.12, Xvfb, non-root, `cryptography` 50.0.2, `mosquitto` installed): 1,493 passed, 5 failed (was 1,488 passed, 10 failed on main).

## Canonical notes updated

- None — receipt only.

## Shared surfaces touched

- None — task stayed inside its selected area.

## Integration requests

- None.

## Known limitations

- Five tests still fail in that environment and are not changed here: `test_systemd_analyze_verify_accepts_the_rendered_unit`
  (needs the installed unit), `test_dry_run_preflight_accepts_an_explicitly_unconfigured_broker` (a non-root user cannot write `/dev`),
  and three timing- or order-dependent tests in `test_local_restore.py` and `test_runtime.py` that pass when those two files run on
  their own (248 passed, twice, and again as root). Their cause under the full run is not yet found.
