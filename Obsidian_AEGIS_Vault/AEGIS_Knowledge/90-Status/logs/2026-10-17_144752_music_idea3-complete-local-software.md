---
title: Task Receipt — IDEA3 complete local Web + Python Desktop software
date: 2026-10-17T14:47:52+07:00
owner: music
area: idea3
branch: feat/idea3-complete-local-software
status: partial
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 complete local Web + Python Desktop software

## What changed

- Verified the accepted purple Desktop (offline demo and read-only live observer) and the PR #438 Web in a safe local profile: Login, all eight pages, Logout, failure states (missing, stale, contradictory, malformed Core status), zero MQTT/controller calls.
- New `tools/local_status_bridge.py`: loopback-only, `GET /status` only; serves the Core `safe_status_projection` of one explicit status file for the Web runtime feed. Missing, malformed, oversized or stale evidence is UNKNOWN; relay, ACK and heartbeat stay UNKNOWN.
- New `tools/local_stack.py`: start/status/stop of the bridge and the Web server (development mode, 0600 generated password file, LAB MQTT observer off unless `--lab-mqtt`).
- Bug fix: the Desktop entrypoints died on SIGTERM (exit 143) and leaked `aegis-purple-demo-*` temp directories. New `tools/graceful_exit.py` closes them through their own `_on_close`.
- Gap fix: `AEGIS_CORE_STATUS_FILE` (absolute, read-only) lets `tools.live_purple_desktop` avoid the observer's exact-file `sudo -n cat` fallback.
- No CUT/RESTORE, MQTT publish, sudo-requiring step, service change or hardware action was added or intentionally executed.

## Source files changed

- `IDEA3-AEGIS_Lockdown/tools/local_status_bridge.py`, `tools/local_stack.py`, `tools/graceful_exit.py` — new.
- `IDEA3-AEGIS_Lockdown/tools/demo_purple_desktop.py`, `live_purple_desktop.py`, `live_purple_observer.py`, `live_purple_incident_desktop.py`, `live_purple_cut_desktop.py` — graceful exit; status-file override in `live_purple_desktop.py`.
- `IDEA3-AEGIS_Lockdown/tests/test_local_status_bridge.py` (22), `tests/test_graceful_exit.py` (5), `tests/test_live_purple_desktop.py` (+2) — new tests.
- `IDEA3-AEGIS_Lockdown/README.md`, `doc/Content/04_SESSION_HANDOFF.md` — run instructions and handoff.

## Verification evidence

- Web, full Git checkout: `npx vitest run` — pass: 773/773 (43 files); `npm run build` — pass.
- Python, every test file run separately in a full checkout: 11,239 passed, 135 failed across 19 files; every failing file gives the identical failure count on pristine `origin/main` (checked for 18 of 19; `test_pr11_phase4_l34_v8_post_v7_persistent_ap_recovery.py` exceeded the 240 s per-file limit and was not compared). Failures are in PR11 Phase 4 host/deploy harnesses, `r1bv_contract` and `r1i`; none is in Desktop, Web, runtime or controller tests.
- Combined run of the purple Desktop tests plus `test_local_e2e_acceptance.py` fails 1 test (`test_the_machine_route_refuses_a_non_core_identity_and_never_dispatches_restore`, DispatchUnavailable CREDENTIAL); the same combination fails identically at PR #438 HEAD without these changes, and the e2e file passes alone (29/29). It is a pre-existing test-order interaction, not fixed here.
- `ruff check` on new/changed tool and test files — pass; `compileall aegis_soc tools` — pass.
- Live-process smoke: bridge + Web started, fresh fixture gave HEALTHY with relay/ACK/heartbeat UNKNOWN, 130 s later UNKNOWN/STALE; `stop` left no listener or process.

## Canonical notes updated

- `None` — owner reconciles durable facts after review.

## Shared surfaces touched

- `None` — task stayed inside `IDEA3-AEGIS_Lockdown/` and the receipt log.

## Integration requests

- None — valid only when no cross-scope/shared path changed

## Known limitations

- Hardware E2E, relay, ACK, signed Core heartbeat and Production behavior are not observed; no fresh ESP32 message was available.
- During the first live-Desktop smoke the default status path `/run/aegis-idea3/status.json` was used for about six seconds; the observer's fallback may have attempted one non-interactive `sudo -n cat` of that exact file. The outcome was not recorded.
- Windows packaging and the Core supervisor were not exercised.
- The 135 pre-existing Python failures and the test-order interaction above remain open.
