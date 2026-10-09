---
title: Task Receipt — IDEA3 SYSTEM-2 Core to Web
date: 2026-10-09T23:24:18+07:00
owner: music
area: idea3
branch: feat/idea3-system2-a1
status: partial
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 SYSTEM-2 Core to Web

## What changed

- Added a bounded, read-only Core evidence projection for authoritative IDEA3 incidents, allowlisted audit aggregates, and ESP32/Core state.
- Added a loopback-only, launcher-token-authenticated Core evidence route and passed a separate ephemeral evidence token to the Web process.
- Added strict Web validation and live snapshot merging for IDEA3 incidents/devices while preserving IDEA1/IDEA2 correlation and Demo isolation.
- No browser command path, MQTT publish, relay action, Recovery action, Production restart, or Production deployment was performed.

## Source files changed

- `IDEA3-AEGIS_Lockdown/aegis_soc/runtime.py` — bounded SQLite read-only evidence projection.
- `IDEA3-AEGIS_Lockdown/aegis_soc/windows_launcher.py` — authenticated `/v1/core-evidence` boundary and child token wiring.
- `IDEA3-AEGIS_Lockdown/aegis_soc/production_runtime.py` — private runtime token environment wiring.
- `IDEA3-AEGIS_Lockdown/tests/test_runtime.py` — Core evidence projection and fail-closed tests.
- `IDEA3-AEGIS_Lockdown/tests/test_windows_launcher.py` — authenticated evidence route tests.
- `IDEA3-AEGIS_Lockdown/web/server/config.js` — runtime producer credential configuration.
- `IDEA3-AEGIS_Lockdown/web/server/domain/normalize.js` — strict IDEA3 evidence schema and projection normalization.
- `IDEA3-AEGIS_Lockdown/web/server/providers/liveProvider.js` — authenticated Core ingestion and snapshot merge.
- `IDEA3-AEGIS_Lockdown/web/tests/server/liveIntegrationProvider.test.js` — real Core incident/device, duplicate, malformed, and credential tests.

## Verification evidence

- `pytest -q tests/test_runtime.py tests/test_windows_launcher.py tests/test_production_runtime.py` from `IDEA3-AEGIS_Lockdown/` — pass: 181 passed, 6 skipped.
- `npm test -- --run tests/server/liveIntegrationProvider.test.js tests/server/normalize.test.js tests/server/config.test.js` from `IDEA3-AEGIS_Lockdown/web/` — pass: 155 passed.
- `TMPDIR="$PWD/.tmp" npx vitest run --maxWorkers=1 --minWorkers=1 tests/server/liveIntegrationProvider.test.js tests/server/securityRoutes.test.js tests/acceptance/liveContract.acceptance.test.js tests/client/corePages.test.jsx` — pass: 52 passed.
- `TMPDIR="$PWD/.tmp" npm run build` — pass: Vite production build completed.
- `TMPDIR="$PWD/.tmp" npm test -- --maxWorkers=1 --minWorkers=1` — partial: 35 test files passed; 606 tests passed and 3 pre-existing production static-runtime tests returned HTTP 500 after temporary SQLite quota exhaustion. The generated dependencies/build/temp files were removed afterward.
- `python -m compileall -q ...; node --check ...; git diff --check` — pass.
- `gh pr view 258 ...` — observed PR #258 OPEN/DRAFT/CONFLICTING at `1d981aee241b772eea196b6259a4b8d63dbcffda`.
- `git diff --name-only origin/main...refs/review/pr258` — no overlap with the changed Core/Web server paths.

## Canonical notes updated

- `None` — the IDEA3 functional owner’s canonical status note was not rewritten by the integrator; the durable implementation fact is submitted for owner review through this receipt and the Draft PR.

## Shared surfaces touched

- `IDEA3-AEGIS_Lockdown/aegis_soc/runtime.py` — Core/Web evidence contract and SQLite trust boundary require integration review.
- `IDEA3-AEGIS_Lockdown/aegis_soc/windows_launcher.py` — authenticated machine transport and token separation require integration review.
- `IDEA3-AEGIS_Lockdown/aegis_soc/production_runtime.py` — runtime environment contract carries the evidence credential.
- `IDEA3-AEGIS_Lockdown/web/server/config.js` — Web producer-authentication configuration.
- `IDEA3-AEGIS_Lockdown/web/server/domain/normalize.js` — shared incident/device evidence semantics.
- `IDEA3-AEGIS_Lockdown/web/server/providers/liveProvider.js` — live snapshot source merge and Demo/Live boundary.

## Integration requests

- Kla/integration reviewer: review the Core-to-Web trust boundary, token lifecycle, allowlist, source-IP exposure, freshness behavior, and rollback to the previous runtime-only adapter before merge.
- Music functional owner: reconcile the durable IDEA3 status note and verify the live deployment configuration exposes the authenticated `/v1/core-evidence` route without restarting Production in this task.
- UI owner/integrator: review PR #258 head `1d981aee241b772eea196b6259a4b8d63dbcffda` after its merge conflict is resolved; this branch preserves its UI diff and does not resolve or mutate that PR.

## Known limitations

- `PRODUCTION_DEPLOYED=NO`; `REAL_LIVE_WEB_ACCEPTANCE=NOT_YET_PROVEN`.
- The local Core/Web bridge and fixtures are not Production evidence; no live Production SQLite was read or modified.
- Physical relay state remains `NOT_VERIFIED`; heartbeat and ACK remain `UNKNOWN` unless independently evidenced.
- The full Web suite’s three production static-runtime failures require a clean host temporary directory/quota and were not re-run after cleanup; focused Core/Web/security/UI integration tests passed.
- A2/A3 branches contained no implementation commits at integration time, so no contributor SHA was cherry-picked.
