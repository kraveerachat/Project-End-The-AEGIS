---
title: Task Receipt — IDEA2 Monitor cold-start deployment
date: 2026-08-24T16:09:10+07:00
owner: pub
area: idea2
branch: deploy/idea2-monitor-cold-start
status: partial
edit_policy: append-by-new-file
---

# Task Receipt — IDEA2 Monitor cold-start deployment

## What changed

- Prepared a minimal IDEA2 Monitor patch so a fresh Detection Engine heartbeat can advertise an authenticated stream while the physical camera is intentionally idle.
- Kept camera connectivity truthful: the Monitor may request the stream to wake the camera, but does not report `camera_connected=true` until the Engine reports it.
- Extended only the first-byte timeout for YOLO and SFace cold startup; an established stream still closes promptly when frames stall.

## Source files changed

- `IDEA2-AEGIS_Monitor/package.json` — include the stream availability and proxy policy tests.
- `IDEA2-AEGIS_Monitor/server/db/store.js` — separate fresh stream availability from physical camera connectivity.
- `IDEA2-AEGIS_Monitor/server/routes/api.js` — use separate first-byte and established-stream watchdog behavior.
- `IDEA2-AEGIS_Monitor/server/streamProxyPolicy.js` — define the cold-start timeout and no-throw reader cleanup boundary.
- `IDEA2-AEGIS_Monitor/tests/streamAvailability.test.mjs` — verify idle Engine stream advertisement remains fresh-only.
- `IDEA2-AEGIS_Monitor/tests/streamProxyPolicy.test.mjs` — verify watchdog selection and asynchronous cancellation cleanup.

## Verification evidence

- `npm test` — pass: 10 tests passed, 0 failed.
- `npm run build` — pass: Vite production build completed successfully.
- `npm audit --omit=dev --json` — pass: 0 production dependency vulnerabilities reported.
- `git diff --check` — pass: no whitespace errors.
- `node --test tests/vaultStructure.test.mjs` — pass: 21 tests passed, 0 failed.
- `node --test tests/collaborationPolicy.test.mjs` — pass: 18 tests passed, 0 failed.
- `node scripts/validate-vault.mjs --vault Obsidian_AEGIS_Vault/AEGIS_Knowledge` — failed because `origin/main` still assigns every receipt under `90-Status/logs/` to Kla; the already-prepared dependency `fix/shared-vault-receipt-ownership` maps IDEA2 receipts to Pub according to repository policy.
- Intended-path secret scan — pass: no Telegram token, chat ID, private key block, `.env`, Admin photo, or model artifact was added by this task.
- Production rollout and internal live-camera verification — pending at receipt creation; this receipt will be updated before the task PR is ready.

## Canonical notes updated

- `None` — the durable deployment fact will be written only after the Production Monitor rollout and live viewer-demand evidence pass.

## Shared surfaces touched

- `None` — source changes stay inside the IDEA2 Monitor boundary.

## Integration requests

- Kla/integration reviewer: review the Production Monitor-only rollout, confirm the existing production Compose architecture remains unchanged, and accept rollback to the pre-deployment Monitor image if health or streaming fails.

## Known limitations

- The Production Monitor image has not yet been rebuilt or restarted from this branch.
- The internal browser flow from `idle` to live and back to `idle` has not yet been re-verified against the new Monitor image.
- The repository vault validator cannot pass on the current `origin/main` until the existing `fix/shared-vault-receipt-ownership` dependency is merged; changing this IDEA2 receipt owner to Kla would violate the canonical owner mapping.
- The previously disclosed Telegram token remains an explicitly accepted security risk and is not changed by this deployment.
