---
title: Work Summary — IDEA2 Monitor & Detection Engine
tags: [aegis, summary, idea2, monitor, detection-engine, cctv]
type: summary
created: 2026-08-06
updated: 2026-08-06
sources: ["[[log]]"]
---

# 📹 IDEA2 Monitor & Detection Engine — Consolidated

> Current-state spec: [[03 - 📹 IDEA2 AEGIS Monitor]]. UI-only passes on this module are covered in [[summaries/01_UI_Design_and_Theming]] and only cross-referenced here.

---

## Early build-out (2026-07-21 → 07-25)

- **In-web Add Operator, end-to-end verified against real Postgres**: 201 + 24-char temp password on create, 409 + rollback on duplicate, 403 for non-SOC roles and out-of-scope camera access, and a bcrypt version-prefix finding — the JS side (`bcryptjs`) produces `$2a$12$` hashes while the Python CLI (`bcrypt`) produces `$2b$12$`; both cross-verify correctly, but the sample docs were updated to show the real prefix instead of an idealized one.
- **Detection Engine wired to the real `aegis_monitor` DB**, removing an in-memory demo generator entirely. New trust boundary: the engine never holds a DB credential — it posts to `POST /internal/{detections,clips,alerts}` behind a timing-safe `X-Detection-Engine-Key` header, and the backend is the only thing that touches Postgres. Verified with API-key negative tests (no key / wrong key → 401), a gateway-level 404 defense-in-depth check on `/monitor/internal/*`, and a full pipeline smoke test (tailgating detections, NAS-verified clips via rsync+sha256, dry-run Telegram alerts).
- **Local camera-device picker** (`setup_camera.py`) — interactive OpenCV-based hardware probing/enumeration/selection for the engine, plus `AEGIS_CAMERA_DEVICE_NAME` propagated through config → heartbeat payload → Monitor backend.
- **Self-healing DDL fix**: `bootstrapDbIfNeeded()` was missing full `CREATE TABLE IF NOT EXISTS` DDL for several tables, causing an HTTP 500 on the Alerts view under certain DB-init timing; added complete DDL for all seven system tables plus a decoupled circular import between `connection.js` and `store.js`.

---

## The mock-vs-real audit + two build-out phases (2026-07-27)

Same discipline as the IDEA1 audit: read every screen and endpoint before touching anything.

### What the module actually was (audit findings)
- `/api/link` had **no data source** — `store.linkStatus()` was two module-level integers and a demo toggle, permanently reporting `online` even with no engine ever connected.
- The Live canvas had **no video at all** — not a placeholder image, literally an empty `<div className="grid2" />` with a CSS hatch pattern standing in for "feeds." Zero `<video>` elements anywhere; the engine exposed no stream endpoint to point at even if there had been.
- **Fabricated identity overlays** — hardcoded strings like `AUTH // J. SMITH // 98%` and `UNKNOWN PERSON // 82%` were drawn regardless of whether the system had ever actually seen anyone. On a security console, this is fabricated evidence, not a placeholder — flagged as the most serious finding.
- **Diagnostics was 100% fictional** — hardcoded 12-point latency arrays, a heartbeat that always read "2s ago," uptime always "99.2%," all five health checks derived from one (also fake) flag.
- The login page **printed credentials that were also wrong** (IDEA1's hints, not IDEA2's).
- A dead `operators` menu entry the server issued but no component existed for.
- Zero automated tests, no `audit_log` table.

### Scope-boundary finding (report-only, no code change)
The Detection Engine genuinely exists in-repo (`IDEA2-AEGIS_CCTV-Operator/detection-engine/`) despite its parent folder being marked deprecated. Capture, NAS off-load with sha256 verification, and alerting are real; it posts metadata-only, and the `monitor` service has **no volume mounts at all** — it structurally cannot read a video clip even in principle (this became the basis for the later clip-playback fix, which instead serves the file from where the engine actually wrote it).

⚠️ **The recognition model does not exist** — `PlaceholderRecognizer` only finds Haar boxes and labels everything `Unknown`. This was explicitly left untouched, since building a real model was out of scope, and it remains the largest tracked gap (see [[summaries/08_Outstanding_Items_Consolidated]]).

### Five immediate fixes
Dev-login CSRF break (same `changeOrigin` root cause as IDEA1, see [[summaries/02_Security_Auth_and_Identity]]); demo credentials made single-use; the misleading login credential hint deleted; `POST /api/link/outage` restricted to SOC (previously any operator could flip every console to LINK LOST for 60s); and the dead `operators` route was **built**, not deleted, after evidence showed it had been genuinely specified (a real screen in the design README, a purpose-built unused CSS block, and an uncalled `PUT /api/assignments` endpoint).

### Phase A — real data end to end
- First real run of the engine against a real **EMEET C60E** webcam: 20s segments → scp + sha256-verified NAS transfer → delete-after-verify → real `clips` rows (peak state: 187 clip rows matched by 187 real files, 3.0 GB, every sampled path present on the NAS).
- **RTSP swappability proven** — switched a running engine between webcam index and a file path with zero code changes.
- Real heartbeat delivery (`camera_heartbeat` table, `POST /internal/heartbeat`, 5s worker); `/api/link` now derives status from row age (15s/45s thresholds) instead of a static flag. Measured both the alive case and the killed case (age crossing the threshold).
- Fabricated overlays deleted outright; `bboxesFor()` now derives boxes only from the newest *real* detection and renders nothing when there is none — verified against the **built bundle**, not just source, that the old invented strings can no longer render.
- The `operators` view was built as the first and only caller of `PUT /api/assignments`.

### Phase B — real live video
- Engine `GET /stream.mjpg` (multipart/x-mixed-replace), gated by the same shared key.
- **Deliberate deviation from the literal prompt**: asked to stream off the same queue the face detector reads from, a *third* sink was added to the existing frame fan-out instead — sharing the actual detection queue would have halved inference throughput any time someone watched the stream. Documented as an intentional interpretation, not a shortcut.
- `GET /api/cameras/:id/stream` authorizes through the same `canSeeCamera` function `/api/cameras` already used — an out-of-scope operator gets 403 *before any socket opens*.
- Proof of a genuinely live (not cached/looping) feed: 10 consecutive proxied frames gave 10/10 distinct SHA-256 hashes, valid 1280×720 JPEGs at ~10.4 fps, a burned-in timestamp changing every frame, and a visible frame delta when a person entered the shot.

### Bugs found while building Phase A/B
- The proxy could hang forever if the upstream socket went quiet without FIN/RST — added a 6s idle watchdog.
- Streams outlived their session — authorization was checked only at connection open; added 10s revalidation of both session and camera assignment (see [[summaries/02_Security_Auth_and_Identity]]).
- `stream_url` is an SSRF surface — validated to `http`/`https` on ingest.
- A dead translation string (`Running v1.3`) survived its own UI removal — only caught by grepping the built bundle.

### Verification
27/27 regression against the live compose stack (every denial case, engine-key enforcement, gateway 404 guard, CSRF); 375 detection rows across 232 frames, correctly all `Unknown`/zero `Authorized` given the placeholder recognizer, with 2-person frames proving the shared-`frame_id` tailgating path works.

---

## UI-state discipline (2026-07-28)
Refactored Monitor's request-driven views (`Alerts`, `Detection`, `Archive`, `Nodes`, `Operators`) to render exactly one of four states — `LOADING` / `ERROR` / `SUCCESS_EMPTY` / `SUCCESS_DATA` — removing any mock/skeleton fall-through. See [[summaries/01_UI_Design_and_Theming]] for the visual pass that followed on the same shell.

---

## 2026-08-01 — closing several 🔴 open items

- **CAM-02 live stream fixed** — a hardcoded `host.docker.internal` in `LiveFeed.jsx` was bypassing the standard `/api/cameras/:id/stream` proxy every other camera used; removed so CAM-02 goes through the same authorized path.
- **Docker/CSP/OpenCV/codec cluster fix** — port mapping, volume mounts, env vars, CSP header, an `opencv-python` version conflict, and an ffmpeg mp4v→H.264 transcode step added to `aegis_scanner.py` (clips are recorded in a codec browsers can actually play).
- **Clip playback shipped** — previously an open gap (`monitor` has no volume mount, no streaming endpoint). Added `GET /api/clips/:id/video`, `getClipById()`, and a real `<video>` element in `Archive.jsx`; also fixed a URL bug that had been dropping the `/monitor/` path prefix.
- **Telegram alert routing by camera, not a hardcoded chat ID** — new `telegram_chat_id` column, `telegramRouteFor()` + `GET /internal/route/:cameraId`, engine switched to route through `camera_assignment`, new `set-telegram` CLI command.
- **Nodes & routing now reflects real heartbeat state** — online/offline derived from `camera_heartbeat` row age instead of a static column; added a live preview frame to node cards.
- **`Operators.jsx` (View #6) rebuilt** — it was missing from the working tree despite the backend already being wired for it.
- **i18n kickoff** — new `src/lib/i18n.js`; `Settings.jsx` migrated to it. **Not complete**: `App.jsx` and the remaining views still render hardcoded strings.

### Same-day follow-up (live-verified, not user-reported)
- **Regression found and fixed**: `GET /api/clips/:id/video` had silently vanished from `api.js` — traced to an earlier edit that re-based `api.js` from a pristine upload instead of the version that already had the clip-video route, dropping it while adding an unrelated heartbeat-status fix on top. Re-added, plus moved `Cache-Control: no-store` to the top of the handler so it now covers every response path (403/404/409/503), not only the success path — closing a caching footgun the same route had already been bitten by once.
- **`App.jsx`** wrapped in `<MotionConfig reducedMotion="user">`; `lang` now persists to `localStorage` and syncs cross-tab like theme already did.
- **`Footer.jsx` honesty fix** — a hardcoded `192.168.1.42 · LAN` and `v3.0-spatial` replaced with real `camera_heartbeat.node_id` and the same `__APP_VERSION__` build constant `Settings.jsx` already used.
- **End-to-end Telegram routing verified live** on a relabeled camera (`CAM-02`→`CAM-05` via engine env, no code change): `GET /internal/route/CAM-05` correctly resolved to the operator's chat ID once both a camera assignment and a `telegram_chat_id` were set, rather than falling back to the SOC-team default.
- **Operational issues found during verification** (not code bugs): the project's root `.env` didn't exist yet (only `.env.example`), which had been silently leaving `DETECTION_ENGINE_API_KEY` empty and triggering the fail-secure 503 on the internal route endpoint; and a freshly-copied `.env`'s DB password placeholder didn't match what Postgres had actually initialized with on first boot.

---

## Open items
See [[summaries/08_Outstanding_Items_Consolidated]]: real face-recognition model, i18n rollout completion, IDEA2 audit log, multi-camera deployment, dev-gateway case-sensitivity gap, Safari MJPEG support, and the stacked-CSS-blocks cleanup.
