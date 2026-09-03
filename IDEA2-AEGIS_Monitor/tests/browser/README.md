# Live Canvas camera-selector verification

Run from `IDEA2-AEGIS_Monitor/` with Node 20.19+ (or 22.12+):

```sh
npm ci
npx playwright install chromium
npm test
npm run test:browser
npm run build
```

The browser suite launches a loopback-only Vite fixture on port 15176 and
renders the **actual App, Live, CameraSelector and LiveFeed**. API responses,
users, camera names and detection identities in `server.mjs` are TEST FIXTURES,
not runtime telemetry. Multipart image requests are real HTTP connections;
the fixture records opens/closes and active viewers. No production services,
private keys, webcams or database are used. Its control routes must never be
installed or exposed as part of the Monitor backend. Production builds use
the normal Vite config and do not import these tests.

Coverage includes API-assigned membership/order, both camera-context panels,
offline/empty states, idle-but-streamable capture, switching back, cancellation
on unmount/availability loss/session expiry/page close, retry cancellation,
keyboard selection and 360/768/1024/1440px layouts. At 1920px the suite also
verifies three columns below the main feed and wrapping of a fourth camera.
Cards use container width to reflow to two or one column on narrower layouts.
A two-camera SOC fixture verifies that no third camera is fabricated; it is
not a real SOC login or production RBAC test. Screenshots and failure output
are written below the ignored `node_modules/.cache/camera-selector-results/`.
This is frontend/transport regression evidence, not production RBAC or
real-camera acceptance. Server authorization remains unchanged:
`getVisibleCameras` → `canSeeCamera` → authorized stream proxy.

## Deployment limitation and real-machine acceptance

This UI consumes `/api/link` camera-level `hasStream` without requiring
`cameraConnected=true`. Thus an idle camera remains demandable **when the
server advertises it**. The audited main baseline still gates `hasStream` on
capture connection; the existing `deploy/idea2-monitor-cold-start` branch
instead derives availability from heartbeat freshness and stream URL. This
PR does not merge or replace that backend patch. Reconcile the intended
production revision before deployment; do not replace the known-working
cold-start runtime blindly with a main-only backend build.

After source review/merge and an approved deployment:

1. Log in as a real CCTV Operator and verify only assigned cards.
2. Select camera A, then B (live or genuinely offline), then A again.
3. Confirm the selected ID/name, image, latest detection and event list agree.
4. Confirm no unselected camera starts merely because its card exists.
5. Exit Live Canvas/close the page and verify viewer-demand release after the
   existing engine idle timeout.
6. Re-enter from idle to verify cold start against the actual deployed backend.

Do not change installer, tunnel/key ACL, engine runtime or database for this UI
acceptance. A rollback is to restore the previous approved Monitor revision,
preserving its existing cold-start patch and runtime configuration.
