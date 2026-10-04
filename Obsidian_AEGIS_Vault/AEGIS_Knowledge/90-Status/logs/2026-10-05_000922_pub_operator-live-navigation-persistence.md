---
title: Task Receipt — Operator Live navigation persistence and single-camera view
date: 2026-10-05T00:09:22+07:00
owner: pub
area: idea2
branch: fix/idea2-operator-live-navigation-persistence
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — Operator Live navigation persistence and single-camera view

## What changed

- After a CCTV-Operator activates Live, its one mounted Live subtree and existing Monitor-proxied viewer survive Archive, Diagnostics, and Settings navigation; returning does not reopen the stream. The hidden subtree is inert, inaccessible, and takes no layout space. Logout or session loss still unmounts it. SOC Live navigation retains its prior release behavior.
- A CCTV-Operator with exactly one server-authorized camera sees only the hero video, not the redundant lower selector. Multi-camera Operators and SOC keep their selector and switching behavior.
- The owner kept the existing Live landing: landing there after login counts as activation. Re-authentication while on Archive does not activate Live until the user selects it.

## Source files changed

- `IDEA2-AEGIS_Monitor/src/App.jsx` — session-bound Operator Live mount and inactive wrapper.
- `IDEA2-AEGIS_Monitor/src/views/Live.jsx` — omit CameraSelector only for one-camera CCTV-Operator scope.
- `IDEA2-AEGIS_Monitor/tests/browser/operatorLivePersistence.spec.mjs` — real-App MJPEG connection/viewer lifecycle and UI regression cases.
- `IDEA2-AEGIS_Monitor/tests/browser/cameraSelector.spec.mjs` — retain old navigation teardown/paging expectations for SOC.
- `IDEA2-AEGIS_Monitor/tests/browser/server.mjs` — isolated Operator/SOC/single-camera and re-login fixture scenarios.
- `IDEA2-AEGIS_Monitor/tests/browser/README.md` — current Operator/SOC navigation acceptance contract.

## Verification evidence

- `npx playwright test tests/browser/operatorLivePersistence.spec.mjs --reporter=line` — expected RED on current behavior: Live subtree absent after Archive navigation and selector present for both one-camera Operator fixtures; 3 failed / 4 passed in the corrected initial RED run.
- `npx playwright test tests/browser/operatorLivePersistence.spec.mjs --reporter=line` — GREEN: all nine focused cases passed after the final re-authentication addition; the single-camera layout screenshot was visually inspected and showed one hero video, retained right-side panels, and no lower selector/gap.
- `npm run test:browser` — passed 30/30, including all nine new cases, actual generated-frame multipart opens/closes and active-viewer counts.
- `npm test` — passed 184, failed 0, conditional skips 58 (real PostgreSQL gates not enabled).
- `npm run build` — Vite production build passed, 2,077 modules transformed.
- `node --test tests/collaborationPolicy.test.mjs tests/vaultMultiWriter.test.mjs tests/vaultStructure.test.mjs tests/coreEntryGovernanceR4.test.mjs` — passed 61/61.
- `node scripts/validate-vault.mjs --vault Obsidian_AEGIS_Vault/AEGIS_Knowledge` — passed with two pre-existing owner-data Canvas warnings.
- `git diff --check` — passed.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea2/idea2-status.md` — records navigation persistence and single-camera UI as separate source/local outcomes and keeps Production/Machine A acceptance unproven.

## Shared surfaces touched

None — all changed paths are within IDEA2 code, tests, and owned knowledge.

## Integration requests

None — no shared or cross-scope surface changed. Human owner review and any later Production rollout remain separate gates.

## Known limitations

- Browser evidence uses the real App/Live/LiveFeed with a local generated-frame HTTP fixture; it does not prove real Machine A camera LED, Production viewer leases, or Production deployment.
- Initial Operator login still lands on Live and intentionally activates it. The no-premature-demand proof covers re-authentication while on Archive and a session without Live permission.
- Real PostgreSQL-dependent Monitor tests were conditionally skipped in the neutral suite; stream authorization/revalidation source and server behavior were not changed by this task.
- Recording/Archive PR2 and GPU runtime PR3 are outside this task.
