---
title: Task Receipt — IDEA3 HEALTHY / uplink LOCKDOWN Web status semantics (Issue #440)
date: 2026-10-17T17:00:00+07:00
owner: music
area: idea3
branch: fix/idea3-health-lockdown-semantics
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 HEALTHY / uplink LOCKDOWN Web status semantics (Issue #440)

## What changed

- `normalizeRuntimeStatus` no longer reports overall runtime `HEALTHY` when the fresh producer status is `HEALTHY` but the `uplink` component is `DEGRADED` (the Web's mapping of Core uplink `LOCKDOWN`). The overall result is `DEGRADED`, per the Human Owner decision recorded in Issue #440.
- Component evidence is untouched: uplink stays `DEGRADED`, broker/ESP32 keep their own states, relay, heartbeat and ACK stay `UNKNOWN`. No status is ever promoted, and no new issue code was added.
- Stale, future-dated, malformed and unknown-vocabulary inputs behave as before (fail-closed `UNKNOWN`). A consistent `HEALTHY` + `NORMAL` projection stays `HEALTHY`.
- The recorded `it.fails` KNOWN GAP test became ordinary passing assertions; the existing `normalize.test.js` expectation that kept `HEALTHY` for `uplink: LOCKDOWN` now expects `DEGRADED`.
- Root cause: the Web adapter trusted the producer's overall `status`. The real Core projects LOCKDOWN as DEGRADED (`supervisor.py` -> `RuntimeState.LOCKDOWN`, `runtime.py`), so the contradictory document is abnormal input, not a confirmed Core output. The Purple Desktop observer's stricter CONTRADICTORY reader is unchanged.

## Source files changed

- `IDEA3-AEGIS_Lockdown/web/server/domain/normalize.js`
- `IDEA3-AEGIS_Lockdown/web/tests/server/labEvidenceContract.test.js`
- `IDEA3-AEGIS_Lockdown/web/tests/server/normalize.test.js`

## Verification evidence

- RED before the fix: the new ordinary assertion failed with `expected 'HEALTHY' to be 'DEGRADED'` on `TEST_ONLY_labRunningUplinkLockdownRaw`.
- GREEN after: `npx vitest run` (IDEA3-AEGIS_Lockdown/web, full checkout) — 43 files, 775/775 passed.
- `npm run build` — pass.
- No Python tests were run; no Core, Desktop or Python source changed.

## Canonical notes updated

- `None` — receipt only.

## Shared surfaces touched

- `None` — task stayed inside `IDEA3-AEGIS_Lockdown/web` and the receipt log.

## Integration requests

- None — valid only when no cross-scope/shared path changed

## Known limitations

- Only the uplink `DEGRADED` (LOCKDOWN) contradiction is handled; other producer/component contradictions keep their previous behavior.
- No physical, hardware or Production verification; this changes read-only Web normalization only.
- Stacked on PR #438; retarget to `main` only after the dependencies merge and rerun verification.
