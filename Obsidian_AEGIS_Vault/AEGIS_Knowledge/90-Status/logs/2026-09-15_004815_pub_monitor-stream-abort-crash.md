---
title: Task Receipt — Monitor stream abort crash
date: 2026-09-15T00:48:15+07:00
owner: pub
area: idea2
branch: fix/idea2-monitor-stream-abort-crash
status: partial
edit_policy: append-by-new-file
---

# Task Receipt — Monitor stream abort crash

## What changed

- Proved that the Monitor MJPEG idle watchdog duplicated upstream reader cancellation after the shared lifecycle helper had already taken ownership, allowing the second asynchronous `AbortError` rejection to terminate Node under strict unhandled-rejection handling.
- Removed the duplicate watchdog cancellation so `createUpstreamLifecycle()` remains the single idempotent cleanup owner.
- Added process-level regression coverage for normal EOF, idle cancellation, asynchronous cancel/read rejection, browser-close overlap, and session-revalidation overlap without changing visible UI or the on-demand camera contract.

## Source files changed

- `IDEA2-AEGIS_Monitor/server/routes/api.js` — remove the duplicate direct `reader.cancel()` from the idle watchdog.
- `IDEA2-AEGIS_Monitor/tests/streamLifecycle.test.mjs` — exercise the real stream route in strict child processes and assert single-owner cleanup and process survival.
- `IDEA2-AEGIS_Monitor/tests/fixtures/streamAbortCrashChild.mjs` — provide deterministic loopback-only MJPEG route scenarios with asynchronous cancellation failure behavior.
- `IDEA2-AEGIS_Monitor/tests/fixtures/streamAbortCrashLoader.mjs` — inject bounded test-only route timers and a non-authoritative stream-source fixture through the Node 20-compatible module loader API.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea2/idea2-status.md` — record the active runtime-unblocker scope, evidence, and human acceptance boundary.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-09-15_004815_pub_monitor-stream-abort-crash.md` — immutable task evidence receipt.

## Verification evidence

- `node --test tests/streamLifecycle.test.mjs` before the source fix — fail as intended: 2 passed / 1 failed; the strict child exited on the watchdog's second `reader.cancel()` with `DOMException [AbortError]` at `server/routes/api.js`.
- `1..3 | ForEach-Object { node --test tests/streamLifecycle.test.mjs }` — passed: 6/6 on each of three runs.
- `node --test tests/streamLifecycle.test.mjs tests/liveCamera.test.mjs tests/viewerDemandAvailability.test.mjs` — passed: 12/12.
- `npm test` — passed: 32 passed / 0 failed / 2 conditional PostgreSQL skips.
- `npm run test:ui-freeze` — passed: 4/4; visible Monitor UI source was not changed.
- `npm run test:browser` — passed: 18/18 after running the local Playwright/Vite subprocess outside the filesystem sandbox.
- `npm run build` — passed: Vite transformed 2,075 modules and produced the production bundle.
- `python -m unittest discover -s tests -p 'test_viewer_demand.py' -v` — passed: 6/6, including first/last viewer demand and camera release behavior.
- `python -m unittest discover -s tests -p 'test_engine_lifecycle.py' -v` — passed: 2/2, including clean idle-capable Engine startup/shutdown wiring.
- `python -m unittest discover -s tests -p 'test_config.py' -v` — passed: 10/10.
- `python -m unittest discover -s tests -v` — 74 passed / 2 failed; both failures are pre-existing current-main generation-isolation failures in `test_stream_lifecycle_regression.py`, and no Detection Engine source or test changed in this task.
- `git diff --check` — passed.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea2/idea2-status.md` — replaced the previous current-task block with the Monitor stream-abort crash scope and recorded the automated verification boundary.

## Shared surfaces touched

- None — task stayed inside the IDEA2 source, tests, and Pub-owned knowledge boundary.

## Integration requests

- None — no cross-scope or shared path changed; Pub and Kla should review the Draft PR before any human merge or runtime deployment.

## Known limitations

- The source fix has not yet been exercised on the real Machine A webcam/runtime; that human acceptance remains the next gate.
- The full Detection Engine baseline remains 74/76 because two current-main generation-isolation tests fail independently of this Monitor-only diff.
- SOC passive/no-wake behavior, permanent runtime automation, Machine B/C, and Telegram delivery remain separate follow-up work.
- Production was not accessed or modified, and no runtime was deployed.
