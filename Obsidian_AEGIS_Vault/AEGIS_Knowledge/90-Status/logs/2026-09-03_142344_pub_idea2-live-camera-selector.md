---
title: Task Receipt — IDEA2 Live Canvas camera selector
date: 2026-09-03T14:23:44+07:00
owner: pub
area: idea2
branch: feat/idea2-live-camera-selector
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA2 Live Canvas camera selector

## What changed

- Source-only feature based on main `d3e240239936577875965165f5c32111fe5e6568`.
  Root cause: the old secondary-camera list used a fixed ID priority, filtered
  out offline cameras, excluded the selected camera, and capped the list at
  three. App additionally preferred CAM-02. Right panels combined detections
  from all visible cameras and could display another camera's authorization.
- Reuse App's `heroCam` state. Default to server order; retain a valid choice;
  reject missing/revoked IDs through the authorized-list fallback; clear
  selection when there is no session/list.
- Render assigned-camera ID/name/status/selected cards below the main player.
  Cards contain no image, fetch, polling interval or preview connection.
  Follow-up layout clarification: three columns at desktop, reflowing by
  container width to two/one columns; extra cameras wrap rather than disappear.
  Two available cameras produce two buttons, never a fake third camera.
- Main image/header/overlay, latest-detection access result and event list all
  use the same selected camera. Offline/empty states are explicit. New unknown
  detections do not inherit old clean authorizations.
- LiveFeed has keyed camera sessions and explicit image-source/listener cleanup,
  plus retry and recovery-timer cancellation. There is no mount-time nonce bump.
  Selection/availability changes clear the prior Live badge; visual tests wait
  for the new image's decoded pixels rather than accepting a cached badge.
- Preserve `GET /api/cameras` server membership, `GET /api/link` availability,
  `GET /api/detections` input and the same-origin stream proxy. No server/API/
  RBAC contract or real runtime changes. Existing server-side `getVisibleCameras`,
  `canSeeCamera` and stream-session revalidation remain authoritative.
- GitHub open PRs audited: #60, #61 and #62 are IDEA1/IDEA3 work; no open Monitor
  source dependency was found. The cold-start deployment difference below is
  deliberately not folded into this UI task.

## Source files changed

- `IDEA2-AEGIS_Monitor/package.json` — unit/browser test commands and test dependency.
- `IDEA2-AEGIS_Monitor/package-lock.json` — pinned Playwright test-only dependencies.
- `IDEA2-AEGIS_Monitor/playwright.config.js` — isolated Chromium test configuration.
- `IDEA2-AEGIS_Monitor/src/App.jsx` — server-order default and session reset.
- `IDEA2-AEGIS_Monitor/src/lib/liveCamera.js` — authorized selection/context/status helpers.
- `IDEA2-AEGIS_Monitor/src/components/CameraSelector.jsx` — metadata-only accessible buttons.
- `IDEA2-AEGIS_Monitor/src/components/CameraSelector.css` — existing-theme responsive cards.
- `IDEA2-AEGIS_Monitor/src/components/LiveFeed.jsx` — keyed session and stream/timer teardown.
- `IDEA2-AEGIS_Monitor/src/views/Live.jsx` — selector and synchronized main/right contexts.
- `IDEA2-AEGIS_Monitor/tests/designContract.test.mjs` — current responsive-card contract.
- `IDEA2-AEGIS_Monitor/tests/liveCamera.test.mjs` — selection/filter/status unit regressions.
- `IDEA2-AEGIS_Monitor/tests/browser/server.mjs` — loopback-only API/multipart test fixture.
- `IDEA2-AEGIS_Monitor/tests/browser/cameraSelector.spec.mjs` — actual-App browser regressions.
- `IDEA2-AEGIS_Monitor/tests/browser/README.md` — reproducible tests and real acceptance boundary.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea2/idea2-status.md` — replace stale selector facts.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-09-03_142344_pub_idea2-live-camera-selector.md`
  — this task's sole new receipt.

## Verification evidence

- `npm test` — **PASS 9/9**, from `IDEA2-AEGIS_Monitor/`.
- `npx playwright install chromium`, then `npm run test:browser` —
  **PASS 17/17** on the final follow-up rerun, Chromium 151, Playwright 1.62.1.
- Browser tests render actual App/Live/LiveFeed with TEST-ONLY server responses
  and real local multipart HTTP requests. Assert assigned cards only, first
  server camera, click/back/keyboard selection, stream URL/selected marker,
  main/right context, offline/empty states, idle availability, no extra preview
  demand, old viewer close, retry cancellation across the 2s deadline,
  availability loss, session expiry and browser-page close.
- Responsive 360/768/1024/1440/1920px and light-theme browser screenshots inspected;
  all cards remain selectable and document width stays within the viewport.
  Visual QA caught an inherited tablet hero-height collapse; the selector
  stylesheet now preserves a 340px minimum and the browser suite asserts it.
  Additional checks assert three cards on the first desktop row, a fourth on
  the next row, placement below the main feed, and a two-camera SOC fixture.
  The first follow-up run passed 16/17: the added SOC display-name assertion
  exposed a fixture using `name` instead of public API `displayName`. The
  fixture now uses `username`/`displayName`; production auth was not changed.
  Visual inspection also caught inherited 901-1240px CSS squeezing the two
  right panels into a narrow rail. At those widths the rail now gets its own
  full-width row below the selector; the 1024px test verifies placement,
  usable access-panel width and no internally clipped text. That assertion
  initially caught a later legacy `.canvas` rule overriding the fix; the final
  rule is scoped specifically to the canvas containing this selector.
- `npm run build` — **PASS** (Vite production bundle).
- Lint — **not configured** in Monitor package.json; no lint PASS claimed.
- `npm audit --json` — **not clean**: six existing dependency advisories
  (four moderate, two high: body-parser, browserslist, express, nanoid, postcss,
  qs). The lockfile diff adds only Playwright's dev dependency tree; none of
  these existing dependency versions changed. No unrelated audit fix applied.

From repository root:

- `node --test --test-concurrency=1 tests/collaborationPolicy.test.mjs tests/dockerBootstrap.test.mjs tests/endpointOnboarding.test.mjs tests/vaultMultiWriter.test.mjs tests/vaultStructure.test.mjs`
  — **PASS 56/56**.
- `node scripts/validate-vault.mjs --vault Obsidian_AEGIS_Vault/AEGIS_Knowledge`
  — **PASS**, two unchanged owner-review Canvas warnings.
- `node scripts/validate-collaboration-policy.mjs --event IDEA2-AEGIS_Monitor/node_modules/.cache/selector-policy/event.json --changed-files IDEA2-AEGIS_Monitor/node_modules/.cache/selector-policy/changed-files.txt`
  — **PASS** for IDEA2/Pub, no cross-scope paths, one new receipt.
- `git diff --check` and staged changed-path/secret-artifact review —
  **PASS**: 16 intended paths, one receipt, no forbidden runtime artifacts or
  credential patterns in staged additions. This is a targeted review, not a
  claim that dependency security advisories are resolved.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea2/idea2-status.md` — server-driven
  metadata cards replace hardcoded preview tiles; selected context and cleanup
  verified in isolated browser tests; production acceptance still pending.

## Shared surfaces touched

None — all changed paths are inside IDEA2's source and Pub-owned knowledge.

## Integration requests

None — no cross-scope/shared change. Functional owner Pub should review the
selector; Kla should review merge/rollout coordination and preserve the
existing cold-start backend behavior before any later deployment.

## Known limitations

- This receipt records **source verification only**. A user-authorized read-only
  browser inspection of the existing production SOC session confirmed username
  `soc`, CAM-01/CAM-02 listed in Settings, the old CAM-02 main/CAM-01 right-panel
  mismatch, and no new selector. This is pre-rollout observation, not acceptance
  of the branch. No deployment, credential change, reboot, key ACL, tunnel,
  database or network change was performed. Source verification does not prove
  real RBAC/database acceptance or camera hardware idle release.
- Main's existing `server/db/store.js` still gates `hasStream` on
  `camera_connected`; the existing `deploy/idea2-monitor-cold-start` branch
  uses heartbeat freshness/stream URL. The selector respects server-advertised
  availability, including idle capture, but this PR deliberately does not
  import that backend patch. Do not blindly replace the working deployed
  cold-start backend with a main-only build.
- The authorized camera list still refreshes on session initialization as
  before. Mid-session assignment revocation remains enforced by the existing
  server stream revalidation; refreshing the page retrieves updated cards.
- Existing polling cadence and server proxy idle/session watchdogs are
  unchanged. Cards are not independent health probes. Multi-hour stability,
  real-device responsiveness and other browser engines are not verified.
- After merge/approved rollout: login as real Operator, verify assignments,
  select A → B → A, confirm main/right identity, exit/close and verify idle
  release, then re-enter from idle. No automatic merge/deployment in this task.
