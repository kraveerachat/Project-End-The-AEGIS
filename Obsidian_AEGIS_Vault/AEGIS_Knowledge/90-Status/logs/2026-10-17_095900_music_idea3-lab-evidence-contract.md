---
title: Task Receipt — IDEA3 LAB read-only evidence contract tests
date: 2026-10-17T09:59:00+07:00
owner: music
area: idea3
branch: fix/idea3-lab-evidence-contract
status: partial
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 LAB read-only evidence contract tests

## What changed

- Offline-only contract tests for the existing Core `safe_status_projection` → `normalizeRuntimeStatus` path, using synthetic `TEST_ONLY` fixtures. No endpoint, bridge, feed or live evidence was activated and no LIVE/DEMO semantics changed.
- A narrowly scoped opt-in config guard: with `AEGIS_IDEA3_LAB_RUNTIME_STATUS=true`, `AEGIS_IDEA3_RUNTIME_STATUS_URL` must be a loopback http(s) URL without credentials and production is rejected. With the flag unset or false behavior is unchanged.
- A known gap is recorded as an `it.fails` test: Core `HEALTHY` with uplink `LOCKDOWN` is passed through as overall `HEALTHY` by the Web adapter. Core/Web semantics were deliberately not changed.

## Source files changed

- `IDEA3-AEGIS_Lockdown/web/tests/fixtures/labCoreProjection.js` — synthetic TEST_ONLY projections (not captures).
- `IDEA3-AEGIS_Lockdown/web/tests/server/labEvidenceContract.test.js` — 23 tests: LOCKDOWN not NORMAL, fail-closed UNKNOWN/stale/malformed/missing, 120 s freshness boundaries, no relay/ACK/heartbeat inference.
- `IDEA3-AEGIS_Lockdown/web/server/config.js` — opt-in loopback guard and `labRuntimeStatus` flag.
- `IDEA3-AEGIS_Lockdown/web/tests/server/config.test.js` — guard tests.

## Verification evidence

- `npx vitest run tests/server/labEvidenceContract.test.js` — pass: 23/23.
- `npx vitest run tests/server/config.test.js` — pass: 118/118.
- `npm run build` — pass.
- `git diff --check` — pass.
- `npx vitest run` (full) — 9 failed / 699 passed. The same 9 fail on an unmodified origin/main baseline (`dockerContainerContract`, `phase2bOverlayContract`, `dispatchContract`, `liveContract.acceptance`); root cause not investigated here.

## Canonical notes updated

- `None` — no durable implemented/deployed fact changed; tests and an opt-in guard only.

## Shared surfaces touched

- `None` — task stayed inside `IDEA3-AEGIS_Lockdown/`.

## Integration requests

- None — valid only when no cross-scope/shared path changed

## Known limitations

- No authentic LAB capture was available; fixtures are synthetic and prove contract behavior only, not LAB state.
- The guard validates configuration only; no endpoint exists or was started. No Core/MQTT/ESP32 interaction occurred.
- Overall HEALTHY with uplink LOCKDOWN is an unresolved semantic gap needing an owner decision.
- Full-suite baseline has 9 pre-existing failures.
