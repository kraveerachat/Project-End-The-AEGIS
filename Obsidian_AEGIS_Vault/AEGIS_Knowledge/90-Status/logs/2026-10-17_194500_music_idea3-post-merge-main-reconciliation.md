---
title: Task Receipt — IDEA3 post-merge main reconciliation (stacked PRs #437 #438 #439 #441)
date: 2026-10-17T19:45:00+07:00
owner: music
area: idea3
branch: fix/idea3-post-merge-main-reconciliation
status: partial
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 post-merge main reconciliation (stacked PRs #437 #438 #439 #441)

## What changed

- PRs #435 and #436 were merged directly into `main` (`b788d6bf`). PRs #437, #438, #441 and #439 were merged into stacked feature branches (`fix/idea3-lab-mqtt-observer`, `fix/idea3-ui-logo-mqtt-integration`), so their changes never reached `main`.
- This branch is `origin/main` (`b788d6bf`) plus one normal, non-fast-forward merge of `origin/fix/idea3-ui-logo-mqtt-integration` (`0877131d`). That branch already contains #437 (`55f7fa51`), #438 (`3f26e77a`), #441 (`e4f6bba8`) and #439 (`def963cd`); #436 and #435 are already in `main`.
- The merge had no conflicts. The resulting tree equals the integration branch tree plus the #435 receipt that only `main` has. No source file was edited by hand.
- Delivered to `main` only by this PR: LAB MQTT read-only observer (#437), UI + LAB integration receipt (#438), `normalize.js` HEALTHY + uplink DEGRADED -> DEGRADED (#441), local Core status bridge / local stack / graceful exit / Phase D e2e (#439), and their four receipts.
- No historical receipt was edited. All six receipts exist: 095900 (#436), 125900 (#437), 134954 (#438), 144752 (#439), 170000 (#441), 180046 (#435).

## Verification evidence

- `npx vitest run` (IDEA3-AEGIS_Lockdown/web, full checkout) — 43 files, 775/775 passed; `npm run build` passed.
- Focused Python (`test_local_core_web_desktop_integration`, `test_local_status_bridge`, `test_live_purple_observer`, `test_preview_purple_desktop`, `test_live_purple_desktop`, `test_graceful_exit`, `test_local_e2e_acceptance`) — 92 passed.
- The 135 inherited Python failures (121 host-dependent, 14 stale pins) were recorded on the pre-merge candidate with identical IDs on `main`; they were not re-run in this task and the full Python suite is not green.
- No Production, hardware, MQTT publish, CUT/RESTORE or sudo activity.

## Canonical notes updated

- `None` — receipt only.

## Shared surfaces touched

- `None` — changes are the already-reviewed IDEA3 paths plus this receipt.

## Integration requests

- None — valid only when no cross-scope/shared path changed

## Known limitations

- Only `collaboration-guardrails` runs in CI; Web and Python results are local.
- Pre-existing `sudo -n cat` fallback in `aegis_soc/observer.py` (not added here); #441 handles only the uplink contradiction; status badge clipping (VISUAL_MINOR) unfixed; 390px mobile check was human-reported.
- No Production or hardware acceptance. The original PRs #437/#438/#439/#441 were merged without reaching `main`; this PR is what delivers them.
