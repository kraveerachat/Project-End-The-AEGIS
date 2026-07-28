---
title: IDEA2 AEGIS Monitor
tags: [aegis, monitor, cctv, soc, face-recognition, dual-view, mjpeg, heartbeat]
type: module-doc
created: 2026-07-20
updated: 2026-07-28
sources: ["[[raw/AEGIS_System_Design_extracted]]", "[[raw/AEGIS_Project_Knowledge_v7]]"]
---

# 📹 IDEA2: AEGIS Monitor (Dual-View SOC & CCTV Operator)

> **Codebase Status**: ✅ Built & Implemented — Backend Express `:8002` + unified React app `:5176` + database `aegis_monitor` + Python Detection Engine (in-repo, runs on the Laptop edge node, **not** in `docker-compose`).
> **Primary Source Files**: `IDEA2-AEGIS_Monitor/server/`, `IDEA2-AEGIS_Monitor/src/`, `IDEA2-AEGIS_CCTV-Operator/detection-engine/`

> **Folder boundary clarification (2026-07-28).** `IDEA2-AEGIS_Monitor/` is the single authenticated Monitor application: login, Monitor identity store, server-resolved `SOC-Responder` / `CCTV-Operator` menus, scoped views, API, and `camera_assignment` enforcement all live here. The old `IDEA2-AEGIS_CCTV-Operator/` folder is only partially deprecated: its former `web-app/` UI is merged and is no longer present, but `detection-engine/` remains the Laptop-side sensor layer that captures camera frames, writes telemetry to Monitor, and must not be deleted unless that edge pipeline is migrated first. Do not delete the entire old folder.

> ⚠️ **Read this first — what is and is not real (audited 2026-07-27).**
> A full mock-vs-real audit was run against this module, followed by two build-out phases. The subsystems below are now genuinely wired end to end: capture → detection → segment recording → NAS sync → metadata → live video. **The one thing that is still not real is identity recognition itself** — see [Detection Engine](#-detection-engine-laptop-vlan-20) — and there is still **no clip playback**. Everything else on this page has been verified against a running system, not inferred from code.

---

## 📽️ Verified Architecture

```mermaid
flowchart TD
    subgraph EdgeEngine ["Detection Engine — Laptop, VLAN 20 (headless, no UI)"]
        CamFeed["📷 Camera source<br/>webcam index OR rtsp:// URL"] --> Catcher["VideoCatcher<br/>(only thread touching the device)"]
        Catcher -->|record sink| Rec["SegmentRecorder<br/>~10-min .mp4 files"]
        Catcher -->|detect sink, latest-only| Det["FaceDetectorProcessor<br/>⚠️ PlaceholderRecognizer"]
        Catcher -->|stream sink, latest-only| Hub["StreamHub<br/>JPEG encode once, share to N viewers"]
        Rec --> NASW["NASSyncWorker<br/>scp/rsync + sha256 verify"]
        NASW --> NAS[("Local NAS<br/>raw video bytes")]
        Det --> HB["HeartbeatWorker<br/>every 5s"]
    end

    subgraph BackendServer ["AEGIS Monitor Server :8002"]
        Internal["/internal/* ingest<br/>X-Detection-Engine-Key · no DB creds on engine"]
        Proxy["/api/cameras/:id/stream<br/>requireAuth → canSeeCamera → proxy"]
        CameraResolver["Camera Access Control<br/>server-side JOIN camera_assignment"]
    end

    subgraph ClientViews ["Unified React App :5176"]
        SOCView["🛡️ SOC-Responder<br/>live · archive · detection · alerts · nodes · operators"]
        OpView["🎥 CCTV-Operator<br/>live · archive · diagnostics (assigned cameras only)"]
    end

    Det -->|"POST /internal/detections"| Internal
    NASW -->|"POST /internal/clips (only after verify)"| Internal
    HB -->|"POST /internal/heartbeat<br/>metrics + stream_url"| Internal
    Internal --> MonitorDB[("aegis_monitor<br/>users · cameras · camera_assignment<br/>detections · alerts · clips · camera_heartbeat")]
    MonitorDB <--> BackendServer
    Hub -->|"GET /stream.mjpg (API key)"| Proxy
    Proxy -->|"multipart/x-mixed-replace → &lt;img&gt;"| ClientViews
    BackendServer --> CameraResolver
    CameraResolver -->|scoped payload| OpView
    BackendServer --> SOCView

    classDef socStyle fill:#0f172a,stroke:#38bdf8,stroke-width:2px,color:#fff;
    classDef opStyle fill:#0f172a,stroke:#4ade80,stroke-width:2px,color:#fff;
    classDef warnStyle fill:#1c1917,stroke:#f59e0b,stroke-width:2px,color:#fff;
    class SOCView socStyle;
    class OpView opStyle;
    class Det warnStyle;
```

---

## 🎥 Detection Engine (Laptop, VLAN 20)

**Where it lives**: `IDEA2-AEGIS_CCTV-Operator/detection-engine/` — in this repository (19 tracked files, ~2,700 lines of Python). The parent folder is marked deprecated but explicitly carves this out: *"`detection-engine/` is NOT deprecated — it remains the Laptop-side sensor layer."* It is **absent from `docker-compose.yml` by design** and is started manually with `python run.py` on the edge node.

**Camera source is config, not code.** `AEGIS_CAMERA_SOURCE` is passed straight to `cv2.VideoCapture`: an integer string opens a local device, anything else is treated as a URL. Moving to a real IP camera is a `.env` edit:

```bash
AEGIS_CAMERA_SOURCE=rtsp://user:pass@192.168.10.40:554/Streaming/Channels/101
```

**[NEW 2026-07-28] Local Camera-Device Picker.** The engine now provides `setup_camera.py`, an interactive CLI for probing and selecting local video capture devices (acting like a "microphone-picker" UX).
- **Probes**: Uses `cv2.VideoCapture` and OS-level APIs (like DirectShow via `pygrabber` on Windows) to verify which indices actually deliver frames.
- **Auto-Configures**: Interactively saves the chosen source and friendly name (`AEGIS_CAMERA_DEVICE_NAME`) directly into the local `.env`.
- **Heartbeat Integration**: The `cameraDeviceName` is now included in the heartbeat payload sent to the Monitor backend.

Verified by swapping a running engine between a webcam (index `1`) and a file path with **zero code changes**. There is no ONVIF discovery — the URL is supplied manually or selected via `setup_camera.py`.

> ⚠️ **The recognition model does not exist yet.** `face_detector.py` ships `PlaceholderRecognizer`, which uses an OpenCV Haar cascade to find face *boxes only* and labels **every** face `Unknown` with a confidence derived from box area (its own docstring calls this "NOT a real score"). Consequences that matter when reading any screen:
> * `detections.result` is **always** `'Unknown'`; `matched_name` is **always** `NULL`.
> * A row reading "Authorized — <name>" cannot be produced by the engine as shipped.
> * Model weights (`.pt`/`.h5`) are git-ignored and absent.
>
> The injection seam is clean and documented (`FaceRecognizer` Protocol) and was **deliberately left untouched** during both build-out phases — a real model is to be supplied separately.

**One camera per process.** `config.py` carries a single `camera_id`; six seeded cameras means six configured instances. There is no supervisor or orchestration for this yet.

---

## 💓 Heartbeat & Real Edge-Link State (2026-07-27)

Before this, `/api/link` was **two integers in memory plus a demo toggle** — it returned `online` forever, including when no engine had ever existed. Every screen showing link state was reporting a constant.

**Docker database initialisation.** A fresh `docker compose down -v` followed by `docker compose up -d --build` loads Monitor's own `server/db/schema.sql` and `seed.sql` into `aegis_monitor` before the scoped `monitor_app` role is granted DML-only access. The application role must not bootstrap DDL at runtime: its lack of `CREATE` privilege on `public` is intentional.

**[NEW 2026-07-28] UI Camera Loading State.** `src/views/Live.jsx` now checks for `cameras === null` (in-flight `/api/cameras` request) and renders a smooth loading state (`Connecting to AEGIS Monitor feed server...`) instead of prematurely flashing the empty camera error state ("No cameras available to this account").

### Strict request-state rendering (2026-07-28)

Data-driven Monitor views use `src/lib/viewState.js` as one strict state machine: `LOADING`, `ERROR`, `SUCCESS_EMPTY`, or `SUCCESS_DATA`. The error branch returns only its retry/error container, so stale cards, mock-looking skeleton markup, charts, and page widgets cannot render beneath it. A successful zero-result response retains the existing page layout and presents its ordinary empty/zero state instead of an outage. This covers Alerts, Detection stream, Archival footage, Nodes, and Operators. `npm test` runs the regression test that proves an error always wins over any residual data payload.

For the HTTP-only localhost compose stack, `ENFORCE_PASSWORD_RESET=false` lets seeded demo accounts reach the zero-data UI immediately. The server defaults to enforcing the reset gate when this variable is absent, so production retains its fail-closed password-reset policy.

### Unified dual-theme Monitor shell (2026-07-28)

All authenticated Monitor views now share one cyber-physical visual system in `src/index.css`; this was a presentation-only refactor and did not add any mock rows, invented telemetry, or replacement pages. The shell is aligned to IDEA1's hierarchy with a near-black `#07080B` canvas, a restrained 24px cyber grid, bounded blue/violet workspace ambience, and elevated dark glass panels. The brand lockup now lives in the left/start zone of the global topbar, while the sidebar is reserved for navigation and footer context; the main workspace is no longer wrapped in one heavy outer glass card. The topbar uses Drive's `h-16 px-6` rhythm, compact status capsules, stacked tactical clock, utility dividers, and a ringed profile badge. The same status semantics remain everywhere: emerald for real online state, cyan for metadata, and rose for unreachable state. `App.jsx` owns the root `dark` / `light` class, so the Settings theme control updates the whole Monitor app rather than only the current card.

The Drive dashboard was used as the approved visual north star for density and hierarchy: a compact status topbar, grouped sidebar navigation, violet-blue active route, and crisp panel borders. Monitor retains its own authenticated menus and real backend payloads. Empty and error branches now consume the shared `EmptyState` HUD card with an accessible status role and reduced-motion fallback. Feed cards, node cards, operator rows, filters, role badges, and Settings segmented rails consume the same tokens in both themes.

**Settings layout refinement (2026-07-28).** `src/index.css` now gives Settings a 12-column bento layout rather than four equal cards: Display spans 5 columns, Notifications 7, Account 7, and System Status 5. Related controls stay grouped, short information cards gain usable height, and the grid collapses to two columns and then one column at mobile breakpoints. This addresses the prior large unused lower canvas while preserving the existing settings state and server-derived account/status data.

### Monitor shell layout and contrast correction (2026-07-28)

`TopBar.jsx` owns the complete `AEGIS Monitor` / `AI CCTV · NEXT-GEN HUD` lockup in the navbar start zone. `AegisLockup` uses intrinsic-width, non-truncating text so the subtitle remains visible. The desktop sidebar is 280px wide; section headings and menu labels use no-wrap alignment so `INFRASTRUCTURE & CONFIG` stays on one line. The final Monitor CSS contract also assigns explicit readable colors to page subtitles, sidebar footer copy, and Live event-stream timestamps, camera ids, and messages in both dark and light themes. No application logic or telemetry flow changed.
### Media-surface overlay correction (2026-07-28)

Live canvas overlays are now treated as media-surface UI rather than theme-inherited page text. The hero top-left label group is separated from the right utility controls and uses explicit white/rose-on-black contrast; the lost-state center uses a flex column with a gap and bright subtitles. Small-camera labels use explicit light and dark surface colors. Nodes & routing camera cards do not render the unnecessary absolute `LIVE CAM-XX` status overlay; its stale CSS rule was removed. No data, RBAC, or telemetry logic changed.
### Repository-wide tactical surface pass (2026-07-28)

The comprehensive Impeccable `craft`, `delight`, `layout`, and `animate` directive was applied to the three production frontend stylesheets: HUB, Drive, and Monitor. Monitor's existing real telemetry, request-state classifier, RBAC, routes, and state machines were left untouched. The Monitor CSS adds the same restrained interaction contract as its siblings—theme-aware focus rings, active press feedback, paint containment for high-frequency panels, and reduced-motion fallbacks—while retaining the approved dark cyber grid, glass panels, and honest unavailable/error states.

### Dark/Light palette and alignment correction (2026-07-28)

The final Monitor CSS contract now explicitly enforces `#07080B` dark canvas, `rgba(12, 13, 18, .90)` dark panels, white/Slate-300/400/500 text roles, rose glass status capsules, and blue-to-purple active navigation. Light mode now uses Slate-100 with a 16px Slate dot grid, white elevated panels, dark Slate headings/labels/values, and cyan-to-blue active states. TopBar status, clock, dividers, and profile now share a three-column baseline grid; Nodes and Settings use consistent 20px card padding and readable key/value alignment. This was a CSS-only correction in `src/index.css`; no new motion was introduced.

### Docker deployment verification (2026-07-28)

The latest Monitor CSS build was deployed through the root `docker compose up -d --build` workflow. `monitor`, `gateway`, `drive`, and `postgres` all report `healthy`, and the gateway route `http://localhost/monitor/` returned HTTP 200. This is a local HTTP test stack; production deployment remains the separate HUB production compose/nginx configuration.

### Live canvas feed HUD and click-to-swap (2026-07-28)

`src/views/Live.jsx` now keeps the active camera in the existing `heroCam` state while maintaining a local swap order so clicking a secondary camera promotes it to the main player and returns the previous main camera to the secondary grid. The main player remounts by camera id with a short opacity transition; the feed request lifecycle remains owned by `LiveFeed` and no API/data contract changed. Secondary tiles now use a structured HUD overlay for camera id, LIVE/STALE status, and location. `src/index.css` forces the main player/error copy to remain high-contrast on its always-dark surface in both themes, and gives light/dark tile labels their own glass treatment and readable status colors.

### Presentation-only CCTV redesign (2026-07-28)

The Live canvas and authenticated Monitor shell now use the confirmed IDEA1 visual language as a presentation skin over the existing real product: near-black canvas, quiet 24px grid, IDEA1-style compact topbar and sidebar, blue/violet active navigation, teal live state, restrained panels, and a balanced two-column Live workspace. The primary feed remains the visual anchor; camera thumbnails, access-control result, and event stream retain their existing real payloads and controls. At `≤900px` the rail stacks below the feed; at `≤640px` the thumbnail row collapses to two columns.

This change is intentionally presentation-only. `IDEA2-AEGIS_Monitor/src/index.css` owns the redesign, `tests/designContract.test.mjs` protects the layout and reduced-motion contract, and `package.json` includes that test in `npm test`. A pre-existing malformed JSX newline/tag mismatch in `src/views/Live.jsx` was corrected only so the unchanged Live behavior can compile; no API, RBAC, camera assignment, MJPEG lifecycle, state machine, or event handling was changed. `npm test` passes 6/6 and `npm run build` succeeds.

### Nodes & routing information hierarchy and Docker cache behavior (2026-07-28)

`src/views/Nodes.jsx` now presents Nodes & routing as an information-only routing workspace: camera feed thumbnails, hatch placeholders, and redundant absolute `LIVE CAM-XX` overlays were removed from the routing cards. The cards retain the real camera identity, zone, resolution, assignment, link status, and operator data, with a restrained loading skeleton while the real request is in flight. This is a presentation-only change; the camera list, assignment scope, RBAC, and status payload are unchanged. `server/index.js` also marks the HTML shell as `no-store, no-cache, must-revalidate` while keeping fingerprinted assets immutable, preventing a Docker deployment from serving the previous Monitor bundle after rebuild.

* `HeartbeatWorker` POSTs a `MetricsRegistry` snapshot to `/internal/heartbeat` every 5s.
* Monitor UPSERTs one row per camera into **`camera_heartbeat`** (real columns: `camera_connected`, `capture_fps`, `detect_fps`, `latency_ms`, `latency_ms_avg`, `uptime_s`, `frames_captured`, `segments_written`, `nas_last_status`, `nas_pending`, `node_id`, `stream_url`).
* `store.linkStatus(visibleIds)` derives status **purely from row age**: `≤15s → online`, `≤45s → degraded`, older or absent → `lost`.
* Scoped like every other data endpoint — an operator sees health for their own cameras only.

**Silence is the signal.** The engine never posts "I am down". If the process dies or the network drops, rows simply stop arriving and Monitor ages the status itself. A live process cannot fake health, and a dead one cannot hide. Measured:

| condition | result |
| :--- | :--- |
| engine alive | `status=online`, `age=2314ms`, `captureFps=346`, `latencyAvg=13.7ms` |
| engine killed | `status=lost`, `simulated=false`, `age=55979ms` |
| `operator2` (CAM-06, no engine) | `cameras=[]`, `status=lost` — honest, not fabricated |

**`POST /api/link/outage`** is a deliberate drill control, restricted to **SOC-Responder** (`requireRole(ROLES.SOC)`). It no longer fabricates state silently: the payload carries `simulated: true` alongside `realStatus`, so a drill is distinguishable from a real outage. An operator with a valid, non-gated session gets `403 Forbidden`.

---

## 📺 Live Video — Proxied MJPEG (Phase B, 2026-07-27)

Previously there was **no video display at all**: the "feed" surfaces were a CSS diagonal hatch (`repeating-linear-gradient`), with zero `<video>` elements and no stream endpoint anywhere.

```mermaid
sequenceDiagram
    participant B as Browser &lt;img&gt;
    participant M as Monitor :8002
    participant DB as aegis_monitor
    participant E as Engine :8077

    B->>M: GET /api/cameras/CAM-05/stream (session cookie)
    M->>M: requireAuth
    M->>M: canSeeCamera — same logic as /api/cameras
    Note over M: 403 here if not assigned — before any socket opens
    M->>DB: SELECT stream_url FROM camera_heartbeat
    Note over M: 503 if absent or heartbeat older than 45s
    M->>E: GET /stream.mjpg (X-Detection-Engine-Key)
    E-->>M: multipart/x-mixed-replace
    M-->>B: piped through, same origin
    loop every 10s while open
        M->>M: reload session + re-check camera_assignment
    end
```

**Why proxy instead of browser → engine directly**: the engine sits on VLAN 20 and holds the service key. A direct connection would require exposing the engine to browsers and shipping the key to the client. The proxy keeps the browser on Monitor's own origin and `stream_url` server-side only — verified absent from every client payload (the client sees a `hasStream` boolean).

**Frames come from a third sink on the existing capture fan-out**, not a second `cv2.VideoCapture` and *not* the detector's queue — items on that queue are consumed once, so sharing it would steal frames from inference. `StreamHub` encodes each frame once and shares the bytes with all viewers, encodes nothing when nobody is watching, and drops stale frames rather than queueing them.

**Rendering**: a plain `<img src="/monitor/api/cameras/:id/stream">`. `multipart/x-mixed-replace` is the browser's native path — no player library, no decoding JS.

### Verified live, not merely connected

10 consecutive frames pulled through the proxy as the `operator` session: **10/10 distinct SHA-256 hashes**, all valid 1280×720 JPEGs at ~10.4 fps, with the burned-in timestamp region changing on every transition and a `mean|Δ| = 3.947` spike when a second subject entered frame.

### CSP — no change was required

`img-src 'self' data:` is already present, and CSP governs `<img>` fetches through **`img-src`**, not `media-src` (which covers `<audio>`/`<video>`/`<track>`). The stream is same-origin with the page, so it matches `'self'`. **No `media-src` amendment and no relaxation of any kind was needed.** Verified by inspecting the CSP served on both the page and the stream response (one header; the doubling issue is confined to the production HUB config).

---

## 🔐 Server-Side Privilege Control

1. **Single app, server-resolved dual views** — the backend issues the menu; a view the role lacks is never in the payload, so it cannot appear in the DOM.
2. **Server-side camera JOIN** — `camera_assignment` lives in `aegis_monitor`. `CCTV-Operator` requests JOIN through it server-side; an unassigned camera id yields `403`. `soc` has no rows and sees everything.
   * Demo scope: `operator` → CAM-05, `operator2` → CAM-06.
   * This now covers **live video too**: `operator2` requesting CAM-05's stream gets `403` before any socket to the engine is opened.
3. **Streams re-check authorisation while open** — checking only at open would let a logged-out operator keep receiving live video until they closed the tab. The session is re-read from the store every 10s and `camera_assignment` re-checked on the same tick.
4. **Force-reset gate** — seeded demo accounts carry `must_reset_password = TRUE`; everything except `/me`, `/logout`, `/password/reset` answers `403 PASSWORD_RESET_REQUIRED` until changed.

---

## 🖥️ Screens

| # | View | Roles | Status |
| :-- | :--- | :--- | :--- |
| 1 | Live canvas | SOC + Operator | ✅ Real MJPEG video + overlays from real detections |
| 2 | Archival footage | SOC + Operator | 🟡 Real clip metadata; **no playback** (see outstanding) |
| 3 | Detection stream | SOC | ✅ Real rows; multi-person frames reveal tailgating |
| 4 | Alerts | SOC | ✅ Real rows; Acknowledge is the console's only write |
| 5 | Nodes & routing | SOC | ✅ Real fleet + assignment + link state |
| 6 | **Operators** | SOC | ✅ **Built 2026-07-27** — table + assignment editor |
| 7 | Camera diagnostics | Operator | ✅ Rebuilt on real heartbeat data |
| 8 | Settings | SOC + Operator | 🟡 Display/theme real; notification prefs are UI-only |

### Operators view (View #6) — the dead menu entry, resolved

`permissions.js` had always issued `operators` in the SOC menu, but `nav.js` had no `DISPLAY` entry, so `buildSections` dropped it silently and no component existed. Three layers were already finished — the README specified it, `index.css` carried a purpose-built `/* operators */` block (`.tablewrap`, `.dt`, `.opav`, `.opassign`, `.edrow`, `.camopts`) with zero consumers, and `PUT /api/assignments` existed **uncalled**. Building it was chosen over deleting, and it is now the first and only caller of that endpoint. Reassignment takes effect on the operator's scope immediately (verified: adding CAM-01 changed their visible set within one request).

### Camera diagnostics — rebuilt, with honest gaps

Previously fabricated end to end: `LAT_SERIES` was three hard-coded 12-point arrays feeding the "last 12 samples" sparkline, heartbeat was always `'2s ago'`, uptime always `'99.2%'`, stream always `'24fps'`, and all five checks derived from one (also fake) flag. Now every field comes from `camera_heartbeat`. Where a metric genuinely cannot be computed it says **`unavailable`** and why:

* **Uptime % and disconnects (24h)** → unavailable: the table UPSERTs one row per camera and keeps no history.
* **Latency sparkline** → removed outright for the same reason.
* **A camera with no heartbeat** → renders "No engine" with every field unavailable, never a healthy-looking card.

See [[concepts/Honest_Telemetry_and_Unavailable_States]].

---

## 🧹 Fabricated Content Removed (2026-07-27)

| Removed | Was |
| :--- | :--- |
| `HERO_SCENES` / `TILE_BOXES` (`data.js`) | Bounding boxes hard-keyed to camera ids with **invented people and match scores** — `AUTH // J. SMITH // 98%`, `SOMCHAI T. // 98%`, `A. OKAFOR // 95%`, `UNKNOWN PERSON // 82%`. Drawn whether or not the system had ever seen anyone. On a security console this is fabricated evidence, not a placeholder. |
| `FACE_RECOGNITION V1.3` | A model name for a model that does not exist. |
| `REC • 1080p • 24fps` | Hard-coded. Resolution now from the `cameras` table, fps from the heartbeat, omitted when unmeasured. |
| `AI auto-elevated CAM-02 on unknown detection` | Driven by a static flag; no auto-elevate mechanism exists. |
| `LAN · 4 ms` / `LAN · 210 ms` (TopBar) | Latency never measured anywhere. Now real mean inference latency, or `Inference · unavailable`. |
| `AI engine: running` | Pinned green regardless. Now derived from how many engines are actually reporting. |
| `Running v1.3` / `AEGIS Monitor v3.0` (Settings) | Version strings typed into the screen. Version now from `package.json` via a vite `define`. |
| `demo · user / aegis-user · admin / aegis-admin` (login page) | Credentials printed to every unauthenticated visitor — **and they were IDEA1's, not Monitor's**, so the hint also misdirected. |

Overlays are now derived from the newest real detection for that camera and render **nothing** when there is none. With the placeholder recogniser in play every box reads `UNKNOWN`, which is the truth.

---

## 🐛 Bugs Found & Fixed Along The Way

* **Dev login was entirely broken** — `vite.config.js` had `changeOrigin: true`, which rewrites `Host` to the proxy target while the browser still sends its own `Origin`. The CSRF Origin↔Host check (`csrf.js:23`) then rejected **every** mutation with `403`, including login (`PRE_SESSION_PATHS` exempts only the *token* check, which runs after). Measured `403` before, `200` after. Same fix and reasoning as IDEA1's `vite.config.js`.
* **Seeded credentials were live forever** — the three demo accounts landed with `must_reset_password = FALSE`, so bcrypt hashes committed to a public repo were working credentials on every deployment. Now `TRUE`, plus an idempotent `UPDATE` (matched on the git-known hashes) to close databases initialised earlier. Plaintext passwords removed from the seed file's own header comment — a comment recording real credentials is itself the leak.
* **Any operator could black out every console** — `POST /api/link/outage` was `requireAuth` only, but the state it flips is process-wide. One request (or pressing `L`) put every connected console into LINK LOST for 60s.
* **A dying stream could hang forever** — found during Phase B testing of my own implementation: when the upstream socket went quiet without FIN/RST, the client hung >30s with no bytes and no error, freezing the last frame with nobody told. Fixed with a 6s idle watchdog on the proxy.
* **Streams outlived their session** — authorisation was checked only at open, so a logged-out user kept receiving video. Fixed with 10s revalidation.

### Measured failure behaviour (live video)

| scenario | result |
| :--- | :--- |
| engine dies mid-stream | EOF at **t=5.23s** → `<img>` fires `error` → backoff retry (2s…30s) |
| camera never started | **503** — client never dials, shows `NO LIVE STREAM` |
| session ends mid-stream | cut at **t=10.06s**, log `session ended — closing` |
| access revoked mid-stream | cut at **t=10.03s**, log `access revoked — closing` |

---

## ✅ End-to-End Verification (2026-07-27)

Run against the live compose stack with a real camera and a synthetic feed:

* **Pipeline**: real 1280×720 capture → 20s segments (603 frames, 1.2 MB) → `scp` + **sha256 verify** → delete-after-verify → `clips` row. At peak, **187 clip rows ↔ 187 real files on the NAS (3.0 GB)**, every sampled path present.
* **Detections**: 375 rows across 232 frames — **all `Unknown`, zero `Authorized`** (correct for the placeholder), with 2-person frames proving the shared-`frame_id` tailgating path.
* **Regression**: **27/27**, covering every operator-denial case, both stream-denial cases, engine key enforcement, the gateway still 404-ing `/monitor/internal/`, and CSRF.

> ⚠️ **Note on the NAS used for testing**: a disposable Alpine + sshd container standing in for the Synology. The transfer, the sha256 verification and the delete-after-verify were all the real code path — only the host differed. It was torn down afterwards, so those 187 rows were removed.

---

## 📂 Codebase File Paths

**Monitor (Beelink, `:8002`)**
* `server/index.js` — Express API server
* `server/routes/api.js` — user-facing API incl. **`GET /api/cameras/:id/stream`** (scoped MJPEG proxy)
* `server/routes/internal.js` — engine ingest incl. **`POST /internal/heartbeat`**
* `server/db/schema.sql` — incl. **`camera_heartbeat`**
* `server/db/store.js` — `linkStatus()`, `recordHeartbeat()`, `streamSourceFor()`, `provisionOperator()`
* `server/rbac/permissions.js` — view registry (source of truth for menus)
* `src/components/LiveFeed.jsx` — **[NEW]** MJPEG `<img>` + reconnect/failure states
* `src/components/ui.jsx` · `src/index.css` — shared dual-theme HUD state, controls, panels and motion rules for all Monitor views
* `src/views/Operators.jsx` — **[NEW]** View #6
* `src/components/AddOperator.jsx` — **[NEW]** shared provisioning modals (lifted out of `Nodes.jsx`)
* `src/views/Diagnostics.jsx` — rebuilt on real heartbeat data
* `src/data.js` — display helpers only; `bboxesFor()` replaced the fabricated scene tables

**Detection Engine (Laptop, VLAN 20)**
* `aegis_engine/video_catcher.py` — the only thread touching the device
* `aegis_engine/face_detector.py` — ⚠️ **model injection seam** (`PlaceholderRecognizer` today)
* `aegis_engine/segment_recorder.py` · `nas_sync.py` — recording and verified off-load
* `aegis_engine/heartbeat_worker.py` — **[NEW]** liveness publisher
* `aegis_engine/stream_hub.py` — **[NEW]** JPEG encode-once, share-to-N
* `aegis_engine/local_api.py` — FastAPI; incl. **`GET /stream.mjpg`** (API-key gated)

---

## 🚧 Open Items (IDEA2)

| Item | Status | Notes |
| :--- | :--- | :--- |
| **Real face-recognition model** | 🔴 Open | The seam is ready; the model is not. Until injected, every detection is `Unknown` and identity-based UI has nothing to show. Deliberately out of scope for both build-out phases. |
| **Clip playback** | 🔴 Open | `clips.file_path` points at the NAS, but the `monitor` service declares **no volume mounts at all** and there is no `/api/clips/:id/stream`. Archive's play button only toggles a text panel. Needs NAS access plus a Range-capable endpoint. |
| **`gateway/nginx.conf` case-sensitivity gap** | 🔴 Open | `location /monitor/internal/` is a case-sensitive literal, but Express matches paths case-insensitively — `/monitor/Internal/...` bypasses the edge guard. The production HUB config already uses `location ~* ^/monitor/internal(/\|$)` and its comment records that the gateway has the same hole. Still guarded by the API key; the *edge* layer is what is bypassable. |
| **Heartbeat history / uptime %** | 🔴 Open | `camera_heartbeat` keeps only the latest row per camera. Uptime %, 24h disconnects and a real latency sparkline all need a time-series table. Currently shown as `unavailable`. |
| **Multi-camera engine deployment** | 🔴 Open | One process serves one camera; six cameras means six configured instances. No supervisor or compose service. |
| **Real bbox geometry** | 🟠 Design constraint | `detections` has no bbox column, so overlay boxes are evenly-spaced slots. `.feedimg` uses `object-fit: cover`, which crops within the box — **when real bbox telemetry arrives this must become `contain` or letterbox-aware**, or normalised coordinates will be wrong by the cropped margin. |
| **Safari live video** | 🟠 Known limitation | `multipart/x-mixed-replace` in `<img>` works in Chrome/Edge/Firefox; **Safari does not support it** and will sit in the reconnect state. |
| **Notification preferences (Settings)** | 🔴 Open | Sound / desktop push / snooze are `useState` only — never persisted — yet each toggle fires a "saved successfully" toast. |
| **No audit log** | 🔴 Open | IDEA2 has **no `audit_log` table at all** (unlike IDEA1). Operator creation, camera reassignment, alert acknowledgement, password resets and every login leave no record. If built, use awaited writes from the start rather than repeating IDEA1's fire-and-forget bug. |
| **Zero automated tests** | 🔴 Open | No test script, no test dependency, no `tests/` directory (IDEA1 has 11 suites). The RBAC/scoping boundary — the project's headline security claim — has no automated proof. |

---

## 🔗 Related Notes
* [[00 - 🗺️ AEGIS System Overview]]
* [[01 - 🚪 HUB-AEGIS Entry]]
* [[04 - 🔒 IDEA3 AEGIS Lockdown]]
* [[05 - 🛡️ Security Architecture]]
* [[concepts/Identity_Decoupling]]
* [[concepts/Honest_Telemetry_and_Unavailable_States]]
* [[concepts/OWASP_Security_Defense]]
