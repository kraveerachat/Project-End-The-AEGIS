---
title: Task Receipt — IDEA3 hardware H0 readiness and local E2E acceptance
date: 2026-10-08T19:45:00+07:00
owner: music
area: idea3
branch: feat/idea3-hardware-h0-local-e2e
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 hardware H0 readiness and local E2E acceptance

## What changed

- On main `2cb731aeadd40d25e3e4970494c57fefe1ac44c5`: a local E2E acceptance (`SIMULATED_LOCAL_E2E`) of synthetic attack → production detector → Core alert ingress → web-minted CUT (real Node machine app over loopback HTTP, real `DispatchClient`) → Core policy → Protocol v1 command → firmware-model device → signed ACK/STATUS → correlation → hash-chained audit → web audit/snapshot; 29 hermetic tests covering the 20 requested scenarios.
- Hardware H0 (read-only): USB/serial discovery without opening the port, pin map and relay logic review, compile-only firmware build with digests, and a readiness matrix. A physical bench plan for an isolated lab (nothing authorized or executed).
- One genuine defect fixed: the web runtime normalizer did not understand the Core's own status projection, so a healthy Core still displayed every component UNKNOWN. `normalize.js` now maps only the documented Core values (relay, heartbeat and ACK are never inferred; canonical values still win; stale/future evidence still forced UNKNOWN).
- No frozen gate, Recovery script, marker, firmware, CTv/CTu evidence or Production surface was changed.

## Source files changed

- `IDEA3-AEGIS_Lockdown/tests/test_local_e2e_acceptance.py` — 29 E2E tests.
- `IDEA3-AEGIS_Lockdown/tests/e2e/loopback_web_bridge.mjs` — test-support launcher (loopback only, disposable DB, random one-shot password).
- `IDEA3-AEGIS_Lockdown/web/server/domain/normalize.js` — Core projection vocabulary adapter.
- `IDEA3-AEGIS_Lockdown/web/tests/server/normalize.test.js` — 8 added cases (4 fail without the fix).
- `IDEA3-AEGIS_Lockdown/docs/operations/idea3-hardware-h0-and-local-e2e.md`, `idea3-physical-bench-test-plan.md`.

## Verification evidence

- `pytest tests/test_local_e2e_acceptance.py` — 29 passed (3 consecutive runs; removing MAC verification makes the HMAC test fail).
- `python3 tests/offline_acceptance.py` — PASS, 486 tests (unchanged).
- `npx vitest run` in `web/` — 607 passed (baseline on main: 599).
- Firmware `pio run` (scratch copy, placeholder CA, no secrets) — SUCCESS; `firmware.bin` sha256 `d3d244b2…fce52e`.
- `ruff check` on the new Python test — pass. `git diff --check`, vault validation — see the PR.

## Canonical notes updated

- `None` — no durable project fact changed.

## Shared surfaces touched

- `None` — IDEA3-owned paths only

## Integration requests

- None — valid only when no cross-scope/shared path changed

## Known limitations

- Nothing physical ran: the serial port was never opened, no reset, flash, NVS, GPIO or relay action, no live MQTT, no network disruption. A CP2102 bridge is enumerated; it does not prove an ESP32 is attached. ESP32 identity/MAC and the deployed firmware digest are unread.
- Hardware design finding (analysis, unmeasured): losing the relay-coil supply de-energizes the relay and closes COM-NC (uplink restored). The firmware dead-man switch cannot prevent that.
- Integration gaps: no broker/TLS/ACL/HUB mTLS in the E2E; the web shows no Core incident or device record (incidents come from IDEA1/IDEA2 feeds only); a delivery path for the Core status document to `AEGIS_IDEA3_RUNTIME_STATUS_URL` is not part of the Linux Core deployment; physical relay state is never available to the web.
- Recovery R2–R8 stays blocked by the immutable CTv CLOSED_FAIL; the real predecessor gate refusal is asserted (scenario 20). Fixture RESTORE authorization is not Production authority.
