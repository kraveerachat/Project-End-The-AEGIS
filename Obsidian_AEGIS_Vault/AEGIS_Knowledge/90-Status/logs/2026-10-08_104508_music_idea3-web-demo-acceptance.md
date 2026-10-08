---
title: Task Receipt — IDEA3 Security Center local demo acceptance and Demo isolation fix
date: 2026-10-08T10:45:08+07:00
owner: music
area: idea3
branch: feat/idea3-web-demo-acceptance
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 Security Center local demo acceptance and Demo isolation fix

## What changed

- Ran the existing Security Center (Express + React) end to end on isolated local resources and fixed two real defects found by that run. Baseline main `c96e1c80dbeac16dffe0983b7e2e052f7bb9b911`: 566 tests passed, build passed.
- **Demo isolation defect (fixed).** While Demo Mode was active, alert acknowledgement, incident notes, recovery dry-run, policy edits and audit export were written to the durable Live SQLite repository. A Demo policy edit persisted into Live policy and simulated rows (for example `ALERT/ACKNOWLEDGE/demo-alert-001`) appeared in the Live audit ledger. Demo Mode now uses a session-scoped, memory-only repository (`demoRegistry`) built on the existing `memoryRepository`; it is discarded on deactivation, re-activation, logout and login, and is bounded to 32 sessions. Only the mode switch itself is recorded in the durable ledger. `GET /audit` returns the active mode's ledger only.
- **Audit page truthfulness defect (fixed).** The Audit page hard-coded "Tamper evidence VERIFIED / chain check succeeded" (neither audit store has a hash chain) and a fixed retention and export limit in Live as well as Demo. It now reports `NOT VERIFIED` and reads retention and export limit from the active policy.
- Added a deterministic local launcher `npm run demo:local` and `npm run acceptance`. The launcher refuses `NODE_ENV=production`, binds loopback, uses a random one-run password and a temporary audit database deleted on exit, strips IDEA1/IDEA2/runtime URLs, tokens, dispatch and proxy settings, and cannot reach MQTT, an ESP32 or a relay.
- Added acceptance suites that drive the real stack: real Express session, CSRF and origin checks, real SQLite repository, real `App` UI with its `fetch` bridged to a listening server. Only upstream HTTP responses and the Core machine-identity headers are test-injected.

## Source files changed

- `IDEA3-AEGIS_Lockdown/web/server/repositories/demoRegistry.js` — new session-scoped memory-only Demo repository registry.
- `IDEA3-AEGIS_Lockdown/web/server/routes/securityRoutes.js` — route reads and writes use the Demo repository while Demo Mode is active.
- `IDEA3-AEGIS_Lockdown/web/server/routes/authRoutes.js` — release Demo state on login and logout.
- `IDEA3-AEGIS_Lockdown/web/server/createApp.js` — create and inject the Demo registry.
- `IDEA3-AEGIS_Lockdown/web/src/pages/AuditPage.jsx` — remove invented tamper-evidence, retention and export-limit claims.
- `IDEA3-AEGIS_Lockdown/web/scripts/demo-local.mjs` — local, non-production launcher.
- `IDEA3-AEGIS_Lockdown/web/package.json` — `acceptance` and `demo:local` scripts.
- `IDEA3-AEGIS_Lockdown/web/README.md` — local demo and acceptance usage, Demo isolation behaviour.
- `IDEA3-AEGIS_Lockdown/web/tests/server/demoIsolation.test.js` — regression tests for the isolation defect (4 + 1).
- `IDEA3-AEGIS_Lockdown/web/tests/client/auditTruthfulness.test.jsx` — regression tests for the Audit page claims (3).
- `IDEA3-AEGIS_Lockdown/web/tests/server/demoLocalLauncher.test.js` — launcher environment tests (4).
- `IDEA3-AEGIS_Lockdown/web/tests/acceptance/liveContract.acceptance.test.js` — live contract acceptance (10).
- `IDEA3-AEGIS_Lockdown/web/tests/acceptance/presenterFlow.acceptance.test.jsx` — UI to API presenter-flow acceptance (4).

## Verification evidence

- `cd IDEA3-AEGIS_Lockdown/web && npm ci && npm test` — pass: 36 files, 592 tests (baseline 566).
- `npm run build` — pass.
- `npm run acceptance` — pass: 2 files, 14 tests.
- The 8 new Demo-isolation, Audit-page and presenter-flow tests fail with the four fixed source files reverted to main and pass with the fixes.
- Real-server run (loopback, temporary audit database): wrong password 401, unauthenticated snapshot 401, write without CSRF 403, cross-origin write 403, Live snapshot reports `idea1`/`idea2` `NOT_CONFIGURED` and overall `UNKNOWN`, Demo containment 409 `DEMO_MODE_ACTIVE`, logout 204 then 401. After the fix a Demo session's actions left only the two mode-switch rows in the Live ledger and the Live policy unchanged (it was changed before the fix).
- Real-process production-mode check: dev login with a production environment and no bcrypt hash fails at startup; with a valid hash the development password is rejected (401); `AEGIS_DEMO_ALLOWED=true` still returns 403 `DEMO_DISABLED`; the session cookie is `Secure; HttpOnly; SameSite=Strict`.
- `npm run demo:local` real run on port 18005 with `AEGIS_IDEA1_STATUS_URL` set in the caller environment — pass: URL stripped (IDEA1 reported `NOT_CONFIGURED`), login, Demo on, static UI served, SIGINT removes the temporary audit directory.
- `npm audit --omit=dev` — finding, unchanged: transitive `proxy-addr` advisory GHSA-jqcg-44mw-7w3h (critical); `npm audit fix --dry-run` offers no non-breaking fix. Present on main; not modified here.

## Canonical notes updated

- `None` — no durable project fact changed; this receipt records the acceptance result.

## Shared surfaces touched

- `None` — task stayed inside `IDEA3-AEGIS_Lockdown/web/**` and its own receipt

## Integration requests

- None — valid only when no cross-scope/shared path changed

## Known limitations

- No real browser was available; the UI was exercised with the real `App` in jsdom against a real listening server, not in Chrome or Firefox.
- In LIVE mode the IDEA1, IDEA2, Alerts and Devices evidence pages stay empty by design (`events: []`; live events travel only in `integration.events` and correlated incidents) because live IDEA1/IDEA2 event integration is OPEN in the PR7 design. Their zero-count metrics are therefore not evidence of absence. The Demo path is the presentation path for those pages.
- Physical relay confirmation, real MQTT, ESP32 and Core claim/ACK flows were not exercised against hardware; the Core is simulated through the shared dispatch contract.
- The unfixed `proxy-addr` advisory above needs an owner decision about the dependency set.
- Recovery R2–R8, CTv, CTu, the Recovery runner, predecessor gates and all incident evidence were not touched. `04_SESSION_HANDOFF.md` was not edited to avoid conflicts with parallel work.
