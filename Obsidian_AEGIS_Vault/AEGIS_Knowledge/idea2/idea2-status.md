---
title: IDEA2 AEGIS Monitor
aliases: ["03 - 📹 IDEA2 AEGIS Monitor"]
tags: [aegis, monitor, cctv, soc, face-recognition, dual-view, mjpeg, heartbeat, telegram, i18n]
type: module-doc
created: 2026-07-20
updated: 2026-08-21
sources: ["[[raw/AEGIS_System_Design_extracted]]", "[[raw/AEGIS_Project_Knowledge_v7]]"]
owner: pub
edit_policy: owner-writable
---

# 📹 IDEA2: AEGIS Monitor (Dual-View SOC & CCTV Operator)

> [!info] Ownership
> Owner: **Pub**. This is the canonical IDEA2 status fragment. Kla reviews only shared integration surfaces; IDEA1/IDEA3 tasks do not write here.

### 🧪 Local run check (2026-08-06)

For a quick UI check, run `npm run dev:server` and `npm run dev` in separate terminals from `IDEA2-AEGIS_Monitor`; the UI is at `http://localhost:5176/monitor/` and the API at `http://localhost:8002`. For the full localhost integration stack, start Docker Desktop, ensure the repository-root `.env` exists, then run `docker compose up -d --build` from the repository root and open `http://localhost/` (or `http://localhost/monitor/`). The repository's Monitor tests passed **6/6** on 2026-08-06. The local Docker daemon was unavailable during that check, and the standalone Vite build was blocked by the execution sandbox's directory access restriction; neither result was a code failure. As of Task 2 on 2026-08-13, root Compose builds the canonical modular runtime from `IDEA2-AEGIS_CCTV-Operator/detection-engine/`; the same runtime remains directly runnable with `python run.py` after dependencies and environment are configured.

## Current-state audit (2026-08-13)

> [!warning] This section supersedes older implementation and verification claims below wherever they conflict. The audit inspected the current source, configuration, tests, and root orchestration. It did not use a real camera, NAS, Telegram account, PostgreSQL runtime, or Docker daemon.

### Executive verdict

- The authenticated Monitor UI/API is implemented and builds, but several operational values remain static, synthetic, or UI-only.
- The repository has **two materially different detection engines**. The root `docker-compose.yml` starts legacy `AEGIS_Camera/aegis_scanner.py`; the newer modular engine under `IDEA2-AEGIS_CCTV-Operator/detection-engine/` is manual-only. There is therefore no single canonical runtime in deployment configuration.
- The modular engine has the stronger capture, retry, recording, heartbeat, and NAS design, but its default configuration fails validation because NAS is enabled while host/user are unset. Its recognition remains an explicit placeholder that reports every detected face as `Unknown`.
- The legacy engine used by Compose cannot be considered production-ready: its referenced YOLO model is absent, its internal stream port does not match the advertised Docker URL, it has no camera reconnect loop, and it treats generic YOLO object detections as `Authorized / Admin` identities.
- A committed Telegram bot credential exists in `AEGIS_Camera/run_engine.ps1`. Its value is intentionally omitted here. Revoke/rotate it immediately and remove the tracked credential in a dedicated security fix.

### Feature matrix

Legend: **Real code** means the behavior has a concrete implementation; **placeholder/mock** means it deliberately substitutes for the required behavior; **unverified** means source exists but this audit did not prove it against real infrastructure.

| Feature | Monitor / modular engine | Legacy engine selected by Compose | Audit verdict |
|---|---|---|---|
| Camera Capture | `VideoCatcher` opens index or URL and reconnects with backoff | Hard-coded `VideoCapture(0)` | Real code, hardware unverified; legacy is fixed-source |
| Camera Selection | `setup_camera.py` probes local devices and writes selection | None | Implemented, unverified |
| Camera Configuration | Environment-driven source and timing values | Most capture behavior hard-coded | Partial; modular `.env.example` omits required Monitor/stream variables |
| Auto Start | `run.py` starts API, capture, detector, recorder, alerts, NAS, and heartbeat | Docker CMD auto-starts scanner | Implemented in both paths, but neither default path is currently reliable |
| Face Detection | Haar-based face boxes in `PlaceholderRecognizer` | Haar boxes plus YOLO object detections | Placeholder quality; no production face model |
| Face Recognition | No identity model | No face identity model | Missing |
| Authorization Classification | All modular detections are honestly `Unknown` | Generic YOLO objects become `Authorized / Admin` | Modular placeholder; legacy classification is invalid and unsafe |
| Live Stream | API-key-gated MJPEG stream proxied through Monitor RBAC | Unauthenticated MJPEG endpoints with permissive CORS | Modular real code, unverified; legacy exposes stream on LAN |
| Continuous Recording | `SegmentRecorder` records continuously | Continuous camera loop records segments | Real code, unverified |
| Segment Recording | Configurable rotation, default 600 seconds | Segment rotation plus optional ffmpeg transcode | Real code, unverified |
| Detection Events | Posted to authenticated Monitor internal API | Posted to Monitor when configured | Real code, unverified end to end |
| Clips / Playback | Monitor serves registered clips; modular registers only after verified NAS upload | Local read-only clip mount may support playback | Partial; modular local-only clips are not registered when NAS is disabled/fails |
| Telegram | Queue/retry/dry-run with one static chat ID | Dynamic route lookup exists | Real code, delivery unverified; routing behavior differs by runtime |
| Heartbeat | Posts even when camera is disconnected and records metrics | Posts scanner state | Real code, unverified against deployed DB |
| Monitor API | User API is role/camera scoped; internal ingest fails secure if key unset | Uses the same Monitor ingest contract when configured | Real code; no API/RBAC integration tests |
| NAS Sync | Real `rsync`/`scp` path with remote size/hash verification | Hashes the same local file and reports `storedOnNas: true` without transfer | Modular implemented but unverified; legacy is a false operational claim |
| Retry | Camera reconnect, alert retry, and NAS retry exist | No camera reconnect and no real NAS retry | Partial |
| Integrity Check | Remote size/hash verification before modular registration/deletion | Local self-hash only | Modular real code, unverified; legacy check does not prove transfer |
| Error Recovery | Modular workers expose stop/retry behavior | Camera loop exits permanently after open failure | Partial; unsynced modular clips are not reconstructed after restart |
| Logging | Structured/component logging exists | Basic scanner logging/prints | Implemented, operational retention unverified |
| Runtime Startup | Manual modular entry point exists | Compose selects legacy entry point | Conflicting; consolidation is required before deployment can be called canonical |

### Monitor truthfulness and coverage gaps

- Without `DATABASE_URL`, the server silently enters memory mode with demo users and static camera records. `/healthz` reports the mode, but the fallback must never be mistaken for deployed persistence.
- Per-camera status in Nodes and Live still reads the seeded/static `cameras.online` field. Heartbeat data is returned separately, so the prior claim that all node online/offline state is heartbeat-derived is incorrect.
- Detection labels are real event data, but displayed box positions come from fixed `BOX_SLOTS` because the schema has no bounding-box geometry.
- Settings notification controls are UI-only even though the interface shows a saved-success toast. The SOC outage control is an explicitly labeled simulation/drill.
- The Monitor package currently has three test files with six passing tests. They cover request-state classification, password-reset defaults, and a CSS/design contract; they do **not** cover API authorization, camera assignment, internal ingest, streaming, database integration, or either detection engine.
- `src/lib/i18n.js` does not exist. Login and Settings contain inline translations, so the documented app-wide i18n rollout is not complete.
- The modular local API protects `/stream.mjpg`, but `/health`, `/metrics`, `/detections/recent`, and `/ws/events` are unauthenticated and use permissive CORS. Legacy stream endpoints are also unauthenticated. Restrict network exposure before deployment.

### Requirement-to-implementation conflicts

1. **Canonical engine:** documentation presents the modular engine as shipped, while root Compose deploys the legacy engine.
2. **Authorization:** the requirement needs face identity matching; modular code has no recognizer, while legacy code incorrectly converts object detections into authorized identities.
3. **NAS truth:** modular code implements real remote transfer but was not exercised here; the currently composed legacy path performs no transfer while claiming NAS storage.
4. **Operational status:** global link state is heartbeat-driven, but camera cards and feed filtering still use a static database boolean.
5. **Configuration:** modular defaults are described as usable, but startup validation fails unless NAS is explicitly disabled or its host/user are supplied; the example environment omits additional required integration variables.
6. **Documentation:** Monitor and root READMEs still describe simulated/direct-database/old-port behavior that no longer matches the current HTTP-ingest architecture.

### Recommended migration order

1. Revoke/rotate the exposed Telegram credential and remove it from tracked history/workflows.
2. Choose one detection engine. Prefer migrating Compose to the modular engine, then quarantine or delete the legacy authorization path after compatibility review.
3. Add a real face embedding/identity pipeline with explicit thresholds and a fail-unknown policy; never infer authorization from object detection.
4. Make modular startup configuration complete and fail-secure, including Monitor API, API key, stream URL, heartbeat, NAS, and camera source examples.
5. Replace `cameras.online` UI decisions with heartbeat-derived camera state and add bounding-box geometry if spatial overlays are required.
6. Add API/RBAC/stream/engine integration tests before claiming end-to-end readiness; then verify camera, PostgreSQL, NAS, and Telegram behavior on the target VLAN.

## Canonical modular runtime update (Task 2, 2026-08-13)

> [!success] `IDEA2-AEGIS_CCTV-Operator/detection-engine/` is now the canonical IDEA2 development detection runtime. This update supersedes the runtime-split findings in the audit above; the legacy `AEGIS_Camera/` directory is retained but is no longer selected by root Compose.

### Runtime before and after

```text
Before: docker compose -> aegis-camera -> AEGIS_Camera/Dockerfile -> uvicorn aegis_scanner:app
After:  docker compose -> aegis-camera -> detection-engine/Dockerfile -> python run.py -> DetectionEngine
```

- Development defaults now set NAS to disabled. Core API, capture/reconnect loop, detector abstraction, recorder, alert manager, Monitor client, and heartbeat worker can initialize without production NAS configuration.
- Disabled NAS reports `disabled`, leaves local recordings in place, creates no successful clip record, and never deletes the local file. Enabled NAS rejects missing host/user and rejects unverified success modes; only transfer plus checksum/size verification may set `storedOnNas=true` and delete local footage.
- Startup is transactional: a component failure stops/joins components that already started and reports the failing component. SIGINT/SIGTERM use the same cooperative shutdown path.
- The modular configuration now owns Monitor URL/key/timeout values; the service key is redacted from startup logs. Monitor remains optional/fail-soft for standalone development and the engine still holds no database credential.
- The legacy helper no longer contains or prints hard-coded Telegram or engine credentials. **Credential Rotation Required Before Telegram Real Testing.**
- The placeholder recognizer remains explicit: face boxes can only produce `Unknown` with no identity. No YOLO/object-to-authorization behavior was migrated.
- Root Compose keeps service name `aegis-camera` for compatibility, maps the modular API to host loopback `127.0.0.1:8005`, and uses named local development volumes. These volumes are not a production NAS claim.

### Verification boundary

- 17 modular Python tests passed, covering configuration, NAS-disabled startup, lifecycle rollback/shutdown, startup errors, NAS verification truthfulness, Compose wiring, credential removal, and placeholder authorization safety.
- Default runtime components started with a deliberately unavailable camera, returned `/health` HTTP 200 with `status=degraded` and `camera_connected=false`, reported NAS `disabled`, and shut down cleanly.
- Python syntax compilation passed. Docker configuration/container execution could not be verified because Docker CLI is unavailable in the audit environment.
- **REAL CAMERA VERIFICATION PENDING.** Monitor real heartbeat integration, Telegram real routing, and production NAS integration remain pending and are not claimed by this task.

> **Codebase Status**: ✅ Monitor UI/API built; modular engine is the canonical development runtime. ⚠️ Real camera, Monitor heartbeat, Telegram routing, production NAS, and production deployment verification remain pending.
> **Primary Source Files**: `IDEA2-AEGIS_Monitor/server/`, `IDEA2-AEGIS_Monitor/src/`, `IDEA2-AEGIS_CCTV-Operator/detection-engine/`

## Viewer-demand camera update (2026-08-21)

The modular Detection Engine now has an opt-in
`AEGIS_CAPTURE_ON_DEMAND=true` mode for interactive camera nodes. The Engine
process, local API, and heartbeat stay available, while the physical camera
opens for the first authenticated Monitor stream and is released after the
last viewer disconnects. Disconnect also clears the previous JPEG and
finalizes the active recording segment. Continuous capture remains the default.

This does not move authorization to the camera node. Monitor still validates
the browser session and `camera_assignment`, and the Engine stream still
requires `AEGIS_DETECTION_ENGINE_API_KEY`. Viewer-demand configuration is
rejected unless streaming and the service key are both enabled. The live MJPEG
path draws detector geometry on a copy of the exact processed frame; recorded
frames remain unmodified.

Automated evidence passed for first/last viewer tracking, camera release,
segment finalization, ASGI disconnect cleanup, aligned boxes, raw-frame
preservation, and fresh-idle Monitor stream availability. Local real-camera
evidence previously showed idle → active → idle behavior. Docker camera access,
deployed browser E2E, production heartbeat, tunnel auto-start, Telegram after
credential rotation, and production NAS remain unverified.

## YOLO + SFace Admin recognition update (2026-08-21)

The modular Detection Engine now has an opt-in
`AEGIS_RECOGNIZER_BACKEND=yolo-sface-admin` backend. YOLO supplies an Admin
candidate region, but it cannot authorize identity by itself. The overlapping
YuNet face must also match an enrolled SFace template before the result becomes
`Authorized/Admin`; missing models, weak matches, inference errors, and all
other faces remain `Unknown`. The safe default is still the placeholder backend.

Enrollment images, SFace templates, YOLO weights, and OpenCV model files remain
local runtime material and are excluded from Git and Docker build contexts.
The Dockerfile can install optional AI dependencies, but actual Docker AI
build/up is still unverified because Docker CLI is unavailable in the current
verification environment. Automated Detection Engine evidence is 40/40 tests;
earlier local Windows-camera testing exercised enrolled Admin and Unknown
results. Internal/Production rollout remains blocked on Docker evidence,
credential rotation, and integration review.

> **Folder boundary clarification (2026-07-28).** `IDEA2-AEGIS_Monitor/` is the single authenticated Monitor application: login, Monitor identity store, server-resolved `SOC-Responder` / `CCTV-Operator` menus, scoped views, API, and `camera_assignment` enforcement all live here. The old `IDEA2-AEGIS_CCTV-Operator/` folder is only partially deprecated: its former `web-app/` UI is merged and is no longer present, but `detection-engine/` remains the Laptop-side sensor layer that captures camera frames, writes telemetry to Monitor, and must not be deleted unless that edge pipeline is migrated first. Do not delete the entire old folder.

> ⚠️ **Historical audit boundary (2026-07-27; superseded in part on 2026-08-21).**
> The July audit used the safe placeholder and therefore had no real identity recognition. The modular runtime now includes the opt-in YOLO+SFace backend described above, while placeholder remains the default. This is local implementation evidence, not an Internal/Production deployment claim.

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
| 1 | Live canvas | SOC + Operator | ✅ Real MJPEG video + overlays from real detections; CAM-02 hardcoded `host.docker.internal` removed, now proxied like every other camera (2026-08-01). CCTV Operator motion/hierarchy pass (2026-08-01, follow-up): real camera-swap fade transition, page-load choreography removed, brief live-state recovery flash, `prefers-reduced-motion` now respected by Framer Motion via `MotionConfig`, not just raw CSS. |
| 2 | Archival footage | SOC + Operator | ✅ Real clip metadata + **real playback** — `GET /api/clips/:id/video` + `<video>` element (2026-08-01, closes the prior open item). Independently re-verified live in the 2026-08-01 follow-up session (see below) after a regression briefly broke it. |
| 3 | Detection stream | SOC | ✅ Real rows; multi-person frames reveal tailgating |
| 4 | Alerts | SOC | ✅ Real rows; Acknowledge is the console's only write; Telegram delivery now routes per-camera via `camera_assignment` instead of one hardcoded chat id (2026-08-01), independently verified live in the follow-up session |
| 5 | Nodes & routing | SOC | ✅ Real fleet + assignment + link state, now derived from `camera_heartbeat` rows instead of a static column (2026-08-01); live preview frame added to node cards |
| 6 | **Operators** | SOC | ✅ **Built 2026-07-27** — table + assignment editor |
| 7 | Camera diagnostics | Operator | ✅ Rebuilt on real heartbeat data |
| 8 | Settings | SOC + Operator | 🟡 Display/theme real; notification prefs are UI-only; language selector now persists to `localStorage` and syncs cross-tab like theme (2026-08-01 follow-up), but only `Settings.jsx` itself reads translated strings so far |

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
| `192.168.1.42 · LAN` / `v3.0-spatial` (`Footer.jsx`, found + fixed 2026-08-01 follow-up) | A fixed IP with nothing measured behind it (identical regardless of which node was actually reporting, or whether any node was reporting at all), and a version string that disagreed with the one `Settings.jsx` already read from `__APP_VERSION__`. Footer now shows the real `node_id` from the freshest `camera_heartbeat` row (or "No edge node reporting") and the same `__APP_VERSION__` as Settings. |

Overlays are now derived from the newest real detection for that camera and render **nothing** when there is none. With the placeholder recogniser in play every box reads `UNKNOWN`, which is the truth.

---

## 🐛 Bugs Found & Fixed Along The Way

* **Dev login was entirely broken** — `vite.config.js` had `changeOrigin: true`, which rewrites `Host` to the proxy target while the browser still sends its own `Origin`. The CSRF Origin↔Host check (`csrf.js:23`) then rejected **every** mutation with `403`, including login (`PRE_SESSION_PATHS` exempts only the *token* check, which runs after). Measured `403` before, `200` after. Same fix and reasoning as IDEA1's `vite.config.js`.
* **Seeded credentials were live forever** — the three demo accounts landed with `must_reset_password = FALSE`, so bcrypt hashes committed to a public repo were working credentials on every deployment. Now `TRUE`, plus an idempotent `UPDATE` (matched on the git-known hashes) to close databases initialised earlier. Plaintext passwords removed from the seed file's own header comment — a comment recording real credentials is itself the leak.
* **Any operator could black out every console** — `POST /api/link/outage` was `requireAuth` only, but the state it flips is process-wide. One request (or pressing `L`) put every connected console into LINK LOST for 60s.
* **A dying stream could hang forever** — found during Phase B testing of my own implementation: when the upstream socket went quiet without FIN/RST, the client hung >30s with no bytes and no error, freezing the last frame with nobody told. Fixed with a 6s idle watchdog on the proxy.
* **Streams outlived their session** — authorisation was checked only at open, so a logged-out user kept receiving video. Fixed with 10s revalidation.
* **[2026-08-01 follow-up] `GET /api/clips/:id/video` silently disappeared for one deploy cycle** — an earlier same-day edit pass re-copied the pristine uploaded `api.js` as a base for the `/api/nodes` heartbeat-status fix instead of continuing from the version that already had the clip-video route, dropping the route entirely while the `/nodes` fix rode along on top of the reset file. Not caught by any test or lint; only surfaced as a plain 404 in the browser against a clip independently confirmed present on disk (`sha256sum` matching the `nas_sync` log line) and readable by the `node` user (`fs.existsSync` from inside the container). Re-added, and `Cache-Control: no-store` — previously only set on the success path — was moved to the top of the handler so it now covers every response branch (403/404/409/503), closing a related caching footgun the route had already been bitten by once before.

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

## 🔧 2026-08-01 Pass — CAM-02 fix, clip playback, Telegram routing, heartbeat nodes, Operators rebuild, i18n kickoff

> ⚠️ **User-reported at the time this was first logged, not independently re-verified in that session.** A follow-up same-day session (below) did have live source-code access and a running stack, and independently re-confirmed several of these claims against real terminal output — see the section directly below for exactly which ones.

* **CAM-02 live stream fixed.** `LiveFeed.jsx` had a hardcoded `host.docker.internal` URL that bypassed the documented `/api/cameras/:id/stream` proxy architecture (see [Live Video — Proxied MJPEG](#-live-video--proxied-mjpeg-phase-b-2026-07-27) above). Removed; CAM-02 now goes through the proxy like every other camera.
* **Docker/CSP/OpenCV/codec cluster fixed.** `docker-compose.yml` port mapping, volume mounts, and env vars corrected; CSP header fixed; a conflicting `opencv-python` version resolved; `aegis_scanner.py` gained an ffmpeg transcode step (mp4v → H.264) so recorded segments are broadly playable.
* **Clip playback closed** — see the Screens table and Open Items table above.
* **Alerts now route by camera, not a single hardcoded chat.** `telegram_chat_id` added to the schema; `telegramRouteFor()` + `GET /internal/route/:cameraId` resolve the right Telegram destination per camera; `aegis_scanner.py` routes through `camera_assignment` instead of one fixed chat id; a `set-telegram` CLI command was added for provisioning.
* **Nodes & routing online/offline now sourced from `camera_heartbeat`** rather than a static column, plus a live stream preview frame added to node cards. Note this is described as a fix to a *different* signal than the `linkStatus()` row-age logic documented under [Heartbeat & Real Edge-Link State](#-heartbeat--real-edge-link-state-2026-07-27) — worth reconciling in a future audit pass to confirm there was only ever one source of truth for online/offline.
* **`Operators.jsx` (View #6) rebuilt** — the file was missing from the working tree despite the backend (`PUT /api/assignments`, etc., documented above) already being wired up.
* **Central i18n started, not finished.** New `src/lib/i18n.js`; `Settings.jsx` now imports from it. `App.jsx` and the remaining views still need to accept a `lang` prop and use translated strings — tracked as a new open item below.

---

## 🔧 2026-08-01 Follow-up — video-route regression, Live canvas motion pass, Footer honesty fix, live-verified Telegram routing

This is a same-day continuation of the pass immediately above, this time run with live source-code access and a real running dev stack, so the claims here are backed by terminal output rather than a developer's own summary.

**The video-route regression** is documented in [Bugs Found & Fixed Along The Way](#-bugs-found--fixed-along-the-way) above (`GET /api/clips/:id/video` disappearing during the `/nodes` edit, then re-added with `Cache-Control: no-store` moved to cover every response branch).

**Live canvas motion/hierarchy pass**, per an explicit CCTV-Operator-focused design brief (feed → switcher → access/event rail hierarchy; a real camera-swap transition; live-state feedback; no page-load choreography; full `prefers-reduced-motion` support):

* `App.jsx` — wrapped the whole app in `<MotionConfig reducedMotion="user">`. The existing `@media (prefers-reduced-motion: reduce)` CSS rules only ever covered raw CSS `animation`/`transition` properties; every Framer Motion `whileHover`/`whileTap`/`animate` interaction across the entire app was previously **not** honoring the OS-level reduced-motion setting at all. One wrapper fixes it site-wide. `lang` also now persists to `localStorage` and syncs cross-tab, matching how `theme` already worked (`aegis_theme`) — closing a small gap where language reset to Thai on every reload.
* `Live.jsx` — removed staggered entrance animation from `.pagehead` and `.canvasR` (the `.canvasR` panel was fading/sliding in **150ms after** the left column on every page visit — literal page-load choreography). Fixed the hero's camera-swap transition, previously `initial={{opacity:1}} animate={{opacity:1}}` (a no-op — both values identical, nothing ever animated despite the code appearing to intend a swap effect), to a real 200ms fade tied to the `key={cam.id}` remount. Replaced `motion.button` wrappers on the three secondary-camera tiles with plain `<button>` elements — those wrappers also had matching `initial`/`animate` values and no `whileHover`/`whileTap` props, so they did nothing that the existing `.sfeed--clickable:hover`/`:active` CSS wasn't already doing.
* `LiveFeed.jsx` — added a `justRecovered` state that briefly flashes a teal inset ring (`.feed-recovered`, 700ms CSS keyframe) specifically when a stream **recovers from a prior error** (`attempts.current > 0` at the moment `onLoad` fires), not on first connect — this was a deliberate design choice to avoid reintroducing page-load choreography under a different name; a flash on every fresh page load would be exactly that.
* `src/index.css` — new rules appended at the very end of the file (`.feed-recovered` keyframe, `.hero`/`.secondrow`/`.sfeed` weighting tweaks, `.sfeed--clickable:focus-visible`). **Not** consolidated with the file's existing ~5 stacked "redesign pass" blocks (several of which redeclare `:root`/`.hero`/`.topbar`/`.panel`/`.side` with different values, where only the last-in-file declaration is ever live) — that cleanup was explicitly proposed to the user and explicitly deferred by their own choice, so this pass deliberately followed the file's existing "append last, let it win the cascade" convention rather than touching anything upstream.

**`Footer.jsx` honesty fix** — see the new row in [Fabricated Content Removed](#-fabricated-content-removed-2026-07-27) above. `link` replaces the narrower `linkStatus` prop so the component can read `camera_heartbeat.node_id` from the freshest row.

**Independently verified live in this session** (terminal output, not self-reported):

* `docker compose exec monitor grep -c "clips/:id/video" server/routes/api.js` → `2`; `grep -c "getClipById" server/db/store.js` → `1` — confirms the regression fix actually deployed.
* A camera was relabeled from `CAM-02` to `CAM-05` purely via the engine's `AEGIS_CAMERA_ID` env var (no code change), to exercise the Telegram-routing logic against a camera that already had a real `camera_assignment` row (`operator` / M. Reyes). `GET /internal/route/CAM-05` → `{"chatId":"8686991056","routeLabel":"M. Reyes"}`; the running engine's own log then showed `OK: Telegram alert sent -> M. Reyes` repeatedly, confirming `telegramRouteFor()` resolves through `camera_assignment` correctly once an operator has both a camera and a `telegram_chat_id`, rather than always falling back to SOC-Team.
* `ffprobe` on the newly recorded CAM-05 clip: `Video: h264 (High) ... encoder: Lavc62.28.102 libx264` — confirms the ffmpeg mp4v→H.264 transcode step from the earlier same-day pass is still working correctly after the camera relabel.

**Operational issues found and resolved during this verification (not code changes, recorded for anyone else hitting the same thing)**:

* The project's root `.env` did not exist — only `.env.example` did. `DETECTION_ENGINE_API_KEY` was silently empty inside the `monitor` container the entire time, so `requireDetectionEngineKey.js`'s fail-secure design correctly returned `503` on `/internal/route/:cameraId` (this is the fail-secure behavior working as designed — the bug was the missing `.env`, not the 503). Recreating `.env` from `.env.example` then surfaced a second, unrelated issue: the freshly-copied `.env`'s DB password placeholders didn't match what Postgres had actually been initialized with on first boot (`password authentication failed for user "monitor_app"`, `500`) until corrected to match the `docker-compose.yml` defaults.
* `telegram_chat_id` for `operator` (M. Reyes) was set via a direct `UPDATE users ... WHERE username = 'operator'` SQL statement, not a code change, to complete the routing verification above (reusing the same chat id already set for `soc`, since both route to the same tester's own Telegram in this dev environment).

---

## 📂 Codebase File Paths

**Monitor (Beelink, `:8002`)**
* `server/index.js` — Express API server
* `server/routes/api.js` — user-facing API incl. **`GET /api/cameras/:id/stream`** (scoped MJPEG proxy), **[NEW 2026-08-01]** `GET /api/clips/:id/video` (briefly regressed and re-fixed same-day — see Bugs Found)
* `server/routes/internal.js` — engine ingest incl. **`POST /internal/heartbeat`**, **[NEW 2026-08-01]** `telegramRouteFor()` + `GET /internal/route/:cameraId`
* `server/db/schema.sql` — incl. **`camera_heartbeat`**, **[NEW 2026-08-01]** `telegram_chat_id`
* `server/db/store.js` — `linkStatus()`, `recordHeartbeat()`, `streamSourceFor()`, `provisionOperator()`, **[NEW 2026-08-01]** `getClipById()`
* `server/rbac/permissions.js` — view registry (source of truth for menus)
* `src/App.jsx` — **[UPDATED 2026-08-01 follow-up]** `<MotionConfig reducedMotion="user">` wraps the app; `lang` persists to `localStorage` and syncs cross-tab
* `src/components/LiveFeed.jsx` — MJPEG `<img>` + reconnect/failure states; **[FIXED 2026-08-01]** removed hardcoded `host.docker.internal` for CAM-02; **[UPDATED 2026-08-01 follow-up]** brief `.feed-recovered` flash on error recovery
* `src/components/Footer.jsx` — **[FIXED 2026-08-01 follow-up]** `link` prop replaces `linkStatus`; real `node_id` + `__APP_VERSION__` replace a hardcoded IP and a mismatched version string
* `src/components/ui.jsx` · `src/index.css` — shared dual-theme HUD state, controls, panels and motion rules for all Monitor views; **[UPDATED 2026-08-01 follow-up]** additive block appended at file end for the Live canvas motion pass
* `src/views/Operators.jsx` — View #6; **[REBUILT 2026-08-01]** — was missing from the working tree
* `src/components/AddOperator.jsx` — shared provisioning modals (lifted out of `Nodes.jsx`)
* `src/views/Diagnostics.jsx` — rebuilt on real heartbeat data
* `src/views/Archive.jsx` — **[NEW 2026-08-01]** real `<video>` playback via `GET /api/clips/:id/video`
* `src/views/Nodes.jsx` — **[UPDATED 2026-08-01]** online/offline sourced from `camera_heartbeat`; live preview frame on node cards
* `src/views/Live.jsx` — **[UPDATED 2026-08-01 follow-up]** removed page-load choreography from `.pagehead`/`.canvasR`; real camera-swap fade transition; simplified no-op `motion.button` wrappers to plain buttons on secondary tiles
* `src/lib/api.js` — **[UPDATED 2026-08-01]** `GET /api/clips/:id/video`
* `src/lib/store.js` — **[UPDATED 2026-08-01]** `getClipById()`
* `src/lib/i18n.js` — **[NEW 2026-08-01]** central i18n module; only `Settings.jsx` consumes it so far
* `src/data.js` — display helpers only; `bboxesFor()` replaced the fabricated scene tables
* `aegis_scanner.py` — **[UPDATED 2026-08-01]** ffmpeg transcode (mp4v → H.264); Telegram routing via `camera_assignment` — independently re-confirmed working in the 2026-08-01 follow-up session (`ffprobe` on a CAM-05 clip, live Telegram delivery log)

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
| **Real face-recognition model** | 🟠 Partial | The modular runtime has an opt-in YOLO+SFace backend with fail-secure dual-gate authorization and 40/40 automated tests. Model weights and enrolled SFace templates stay local and are not committed. Docker AI build/up, Internal/Production deployment, threshold calibration for all three Admins, and post-rotation Telegram verification remain open. |
| ~~**Clip playback**~~ | ✅ Resolved (2026-08-01) | `GET /api/clips/:id/video` + `getClipById()` in `store.js` + a real `<video>` element in `Archive.jsx` replaced the text-panel-only play button; a URL bug that dropped the `/monitor/` prefix was fixed in the same pass. **Independently re-verified live in the 2026-08-01 follow-up session** after briefly regressing to a 404 (see Bugs Found) — `grep` confirms the route is deployed and a real CAM-05 clip was confirmed playable end to end. |
| **`gateway/nginx.conf` case-sensitivity gap** | 🔴 Open | `location /monitor/internal/` is a case-sensitive literal, but Express matches paths case-insensitively — `/monitor/Internal/...` bypasses the edge guard. The production HUB config already uses `location ~* ^/monitor/internal(/\|$)` and its comment records that the gateway has the same hole. Still guarded by the API key; the *edge* layer is what is bypassable. |
| **Heartbeat history / uptime %** | 🔴 Open | `camera_heartbeat` keeps only the latest row per camera. Uptime %, 24h disconnects and a real latency sparkline all need a time-series table. Currently shown as `unavailable`. |
| **Multi-camera engine deployment** | 🔴 Open | One process serves one camera; six cameras means six configured instances. No supervisor or compose service. Running two instances against two different cameras (e.g. CAM-02 + CAM-05) simultaneously was design-confirmed with the user 2026-08-01 (distinct `AEGIS_CAMERA_ID`/`AEGIS_STREAM_URL` per instance, shared `MONITOR_INTERNAL_URL`/`DETECTION_ENGINE_API_KEY`) but not yet implemented. |
| **Real bbox geometry** | 🟠 Design constraint | `detections` has no bbox column, so overlay boxes are evenly-spaced slots. `.feedimg` uses `object-fit: cover`, which crops within the box — **when real bbox telemetry arrives this must become `contain` or letterbox-aware**, or normalised coordinates will be wrong by the cropped margin. |
| **Safari live video** | 🟠 Known limitation | `multipart/x-mixed-replace` in `<img>` works in Chrome/Edge/Firefox; **Safari does not support it** and will sit in the reconnect state. |
| **Notification preferences (Settings)** | 🔴 Open | Sound / desktop push / snooze are `useState` only — never persisted — yet each toggle fires a "saved successfully" toast. |
| **No audit log** | 🔴 Open | IDEA2 has **no `audit_log` table at all** (unlike IDEA1). Operator creation, camera reassignment, alert acknowledgement, password resets and every login leave no record. If built, use awaited writes from the start rather than repeating IDEA1's fire-and-forget bug. |
| **Automated coverage remains incomplete** | 🟠 Partial | Task 2 added 17 modular-engine tests for configuration, lifecycle, NAS truthfulness, wiring, credential safety, and placeholder recognition. Monitor still has only 6 narrow UI/design/default tests; API RBAC, camera assignment, streaming, database integration, and real-device integration remain unproved. |
| **Production NAS integration** | 🔴 Open | The canonical modular worker implements `rsync`/`scp` plus remote checksum/size verification, but NAS is deliberately disabled by default and no production NAS was exercised in Task 2. Local Compose volumes are explicitly not NAS. Real target-host transfer and operational recovery remain pending. |
| **i18n rollout incomplete** | 🟡 In progress (2026-08-01, still incomplete as of the same-day follow-up) | `src/lib/i18n.js` exists and `Settings.jsx` consumes it. The 2026-08-01 follow-up pass added `lang` persistence (`localStorage` + cross-tab sync) to `App.jsx`, but **no additional view or shell component was wired to read translated strings** — `Live.jsx`, `TopBar.jsx`, `Sidebar.jsx`, `Footer.jsx`, `Detection.jsx`, `Diagnostics.jsx`, and `Login.jsx` still render hardcoded English/Thai strings. |
| **`src/index.css` has ~5 stacked redesign-pass blocks with duplicate declarations** | 🟡 Flagged, deferred by user choice (2026-08-01) | Several blocks redeclare the same `:root`/`.hero`/`.topbar`/`.panel`/`.side` selectors with different values; only the last one in the file is ever live, so the earlier ones are dead code that makes the file harder to reason about. Flagged to the user before the 2026-08-01 follow-up motion pass; the user explicitly chose to defer the cleanup rather than have it done as part of that pass. |

---

## 🔗 Related Notes
* [[core/system-overview]]
* [[core/hub-aegis-entry]]
* [[idea3/idea3-status]]
* [[core/security-architecture]]
* [[concepts/Identity_Decoupling]]
* [[concepts/Honest_Telemetry_and_Unavailable_States]]
* [[concepts/OWASP_Security_Defense]]
