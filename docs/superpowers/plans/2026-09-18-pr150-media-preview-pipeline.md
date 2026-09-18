# PR150 Media Preview Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Files-grid thumbnails/posters and hover motion independent of original media size after derivative generation, using server-side Sharp/FFmpeg derivatives and a rebuildable content-addressed cache, without changing upload throughput, upload limits, Private Vault semantics, or the database.

**Architecture:** The Drive gains a `server/media/` subsystem: a boot-time **capability probe** (FFmpeg/FFprobe/sharp presence; missing tools degrade to `UNSUPPORTED`, never a failed boot), a validated **`MEDIA_*` configuration** with `MEDIA_PROFILE_VERSION = 'v1'`, a **content-addressed cache** on a separate rebuildable volume keyed `v<profile>/<ab>/<cd>/<sha256>/{probe.json,state.json,poster.webp,motion.mp4}` (filename never enters the key; atomic tmp + rename; startup tmp cleanup; LRU eviction between high/low water marks with a free-space reserve), a **bounded in-process job queue** (de-duplicated by `profile/sha/type`, priorities P0 interactive / P1 upload / P2 warm-up, `MEDIA_WORKERS=1` hard concurrency, per-job timeouts with TERM→KILL, no media bytes in Node), a **family-specific bounded media probe** (GIF two-packet, WebP `VP8X`+pages, APNG `acTL`-before-`IDAT`, AVIF `avis`+sample count; inconclusive → `ANIMATION_UNKNOWN` → poster-only), a **static poster generator** (sharp for still JPEG/PNG/WebP/AVIF; FFmpeg for BMP, animated first frames and video frames; WebP ≤ 640×360 ≤ 512 KiB, metadata stripped), a **motion-proxy generator** (FFmpeg MP4/H.264 ≤ 480×270, 12 fps, 6 s window, no audio, yuv420p, faststart, ≤ 4 MiB, per-stage soft thread options), a **derivative service** state machine (`PENDING/READY/UNSUPPORTED/GENERATION_FAILED/RETRYABLE`, TRANSIENT vs PERMANENT retry classes), and **owner-only derivative routes** `GET /api/files/:id/media-info`, `POST /api/files/media-info/batch`, `GET /api/files/:id/poster?v=<sha256>&p=<profile>`, `GET /api/files/:id/motion-preview?v=<sha256>&p=<profile>` (object-hiding 404, Vault never probed, both identities validated, `ETag "<sha256>-<profile>-<type>"`, `Cache-Control: private, max-age=31536000, immutable` + `Vary: Cookie` justified by the regenerate/destroy session lifecycle and pinned by a contract test, `MEDIA_CACHE_POLICY=revalidate` fallback). Upload/commit/restore success paths **enqueue asynchronously after the response**. The frontend replaces the browser-side GIF Blob poster with a pure **tile state machine** (poster layer never removed; motion `<video>` overlay; first hover auto-plays when the prefetched proxy becomes ready; leave pauses/resets; content identity = `sha256`), a **viewport scheduler** (IntersectionObserver P0–P3, in-flight caps 1 info batch / 6 posters / 3 motion, hover promotion, cancel on unregister) and a `media-info` batch client with bounded backoff. The Preview dialog keeps the unchanged original `/preview` Range route. Packaging pins the Alpine minor, an exact `ffmpeg` apk version and sharp's musl prebuilt; the repo compose gets a dev/test named volume; Production uses a separate service-scoped overlay generated on the host in a later gate. Full contract: the spec below.

**Tech Stack:** Node.js 20/24 (ESM), Express 4, React 19 + Vite 7, sharp (libvips, musl prebuilt), FFmpeg/FFprobe (Alpine package), Docker Compose v2, `node:test` + TAP reporter, jsdom for screen tests, PostgreSQL 15 (disposable, `scripts/pg-integration-env.sh`) for authorization/store-gated cases.

**Spec:** `docs/superpowers/specs/2026-09-18-pr150-media-preview-pipeline-design.md` (revision 2, DESIGN APPROVED)

## Global Constraints

```
UPLOAD_LIMIT_CHANGE=NO
UPLOAD_PERFORMANCE_CHANGE=NO
DB_MIGRATION=NO
PRIVATE_VAULT_MEDIA_DERIVATIVE=NO
PUBLIC_SHARE_MEDIA_DERIVATIVE=NO
ORIGINAL_GRID_FETCH=NO

POSTER_ENGINE=SHARP_FOR_STILL_FAST_PATH_PLUS_FFMPEG_WHERE_REQUIRED
MOTION_ENGINE=FFMPEG
MOTION_OUTPUT=MP4_H264
POSTER_OUTPUT=WEBP

CACHE_STORAGE=SEPARATE_REBUILDABLE_VOLUME
CACHE_IDENTITY=SOURCE_SHA256_PLUS_PROFILE_VERSION
GENERATION_MODEL=ASYNC_BOUNDED_QUEUE

PRODUCTION_BASE_COMPOSE_MUTATION=NO
PUBLIC_SHARE_OVERLAY_MUTATION=NO

PRODUCTION_RUNTIME_CURRENT=e5bea949a917a84b20e337d8d9d1406ff115af36
CURRENT_PLAN_BASE_HEAD=9a9e161c2ab085358601f2497952c7b9ca6e2568

FINAL_RECEIPT_DURING_IMPLEMENTATION=NO
PR150_READY_DURING_IMPLEMENTATION=NO
```

- Work only on PR #150 branch `feat/idea1-files-management-ux`; the PR stays Draft with `DO_NOT_MERGE=TRUE`; never push to `main`; never rebase/squash/force-push.
- Every task is TDD: tests are written and proven RED with the exact command before source changes; the same command proves GREEN; the task's local regression runs before its commit.
- Nothing in Tasks 1–17 touches Production, the Production database, `/opt/aegis/runtime/**`, or the Public Share overlays. Task 15 changes only repository packaging files. Task 18 is a hand-off list of future gates, not work performed under this plan.
- Nothing changes `server/config/transferLimits.js`, `MAX_UPLOAD_BYTES`, chunk sizes, session TTLs, upload routes' status codes/bodies, or the upload protocol. The only upload-path change is Task 10's post-response enqueue.
- Vault rows (`vault = true`) are rejected in the routes **and** in the derivative service; no test or code path passes a vault storage key to the probe, poster, or motion generators.
- The original preview route `GET /api/files/:id/preview` is not modified except to import the extracted `parseByteRange()` from `server/request/byteRange.js` (behaviour-preserving; `tests/filesPreviewRoute.test.js` must stay 5/5).
- Tracked `IDEA1-AEGIS_Drive_LC/dist/` is never rebuilt in a commit: build to verify, then `git checkout -q -- IDEA1-AEGIS_Drive_LC/dist && git clean -fdXq IDEA1-AEGIS_Drive_LC/dist && git clean -fdq IDEA1-AEGIS_Drive_LC/dist`.
- No large binary fixtures are committed: every media fixture is generated at test time by `tests/helpers/mediaFixtures.mjs` (sharp/FFmpeg) or is a sparse file made by `fs.truncate`; fixtures live under `os.tmpdir()` and are deleted in `after()`.
- FFmpeg-gated tests skip with the marker `# SKIP media-tools-unavailable` when the capability probe reports tools missing; the Linux verification gate (Task 17) requires `MEDIA_SKIP=0` (no such skips) the same way it requires `PR150_POSTGRES_SKIP=0`.
- All commands below run from `IDEA1-AEGIS_Drive_LC/` unless a path says otherwise; `node --test --test-concurrency=1 --test-reporter=tap` is the counting form (Node 24 needs `--test-reporter=tap` for reliable counts).
- Existing accepted baselines: broad suite 1574/1489/1 fail/84 skip with the single `PS6-ENV-4` reporter-sensitivity failure at `tests/publicShareStageBCredentialPlumbing.test.js:233`; `npm audit` 8 (5 moderate, 3 high, 0 critical). New work must not add failures or advisories; a new dependency that raises the audit count stops Task 15 for review.

## File map

Every new file has exactly one responsibility. "Tests" names the suite that owns the file's contract.

### Server — configuration

| File | Purpose | Imports / dependencies | Public interface | Tests |
|---|---|---|---|---|
| `server/config/mediaLimits.js` (create) | Validate every `MEDIA_*` environment value at construction (same pattern as `transferLimits.js`: invalid → throw), expose profile version and frozen limits. | none (pure) | `MEDIA_PROFILE_VERSION = 'v1'`; `mediaLimitsFromEnv(env = process.env)` → frozen `MediaLimits`; `MEDIA_DEFAULTS` (frozen defaults object); `MediaLimits` shape: `{ enabled, cacheDir, cacheMaxBytes, cacheLowWater, cacheFreeReserveBytes, cachePolicy: 'immutable'\|'revalidate', workers, decoderThreads, filterThreads, encoderThreads, maxSourcePixels, maxVideoFramePixels, posterBox: {width,height}, motionBox: {width,height}, motionFps, motionMaxSeconds, probesizeBytes, posterMaxBytes, motionMaxBytes, probeTimeoutMs, posterTimeoutMs, motionTimeoutMs, queueMax, stillEngine: 'sharp'\|'ffmpeg', batchMaxIds, profile }` | `tests/mediaLimits.test.js` |

### Server — `server/media/`

| File | Purpose | Imports / dependencies | Public interface | Tests |
|---|---|---|---|---|
| `capabilities.js` (create) | Detect FFmpeg/FFprobe/sharp presence and the encoder/decoder set at boot; produce a frozen capability object; never throw. | `processRunner.js`; dynamic `import('sharp')` | `detectCapabilities({ runner, ffmpegBin = 'ffmpeg', ffprobeBin = 'ffprobe', loadSharp = () => import('sharp'), timeoutMs = 10000 })` → `Capabilities`; `CAPABILITIES_NONE` (all `ok:false`, `enabled:false`); `Capabilities` shape: `{ enabled, ffmpeg: {ok, version}, ffprobe: {ok, version}, encoders: {libx264, libwebp}, decoders: {gif, apng, webp, webpAnimated, av1, h264, vp8, vp9}, sharp: {ok, version, avif}, reasons: string[] }` (`enabled = ffmpeg.ok && ffprobe.ok`; sharp optional) | `tests/mediaCapabilities.test.js` |
| `processRunner.js` (create) | The only place that spawns child processes: `execFile`-style argument arrays, `shell:false`, minimal env, bounded stdio, TERM→KILL timeout, optional Linux `/proc` metrics; never returns media bytes. | `node:child_process`, `node:fs` | `createProcessRunner({ env = MINIMAL_CHILD_ENV, cwd, metrics = process.platform === 'linux' })` → `{ run({ bin, args, timeoutMs, killGraceMs = 2000, stdioCapBytes = 65536, signal }) → Promise<RunResult> }`; `MINIMAL_CHILD_ENV = { PATH, HOME: '/tmp', LANG: 'C' }` (frozen; no other keys copied); `RunResult = { code, signal, stdout, stderr, timedOut, killed, durationMs, metrics: { rchar, readBytes, vmHwmKb } \| null }`; throws `TypeError` if any arg is not a string or contains `\0` | `tests/mediaProcessRunner.test.js` |
| `queue.js` (create) | Generic bounded, de-duplicated, prioritized job queue with fixed worker slots. | none | `createJobQueue({ concurrency = 1, maxDepth = 500, now = Date.now })` → `{ enqueue(key, priority, run) → { promise, deduplicated }, promote(key, priority), has(key), size(), running(), stats(), shutdown({ reason }) }`; `PRIORITY = { INTERACTIVE: 0, UPLOAD: 1, WARMUP: 2 }`; `QueueFullError`; `run` receives `{ signal }` and must observe it | `tests/mediaQueue.test.js` |
| `cache.js` (create) | Content-addressed cache layout, key validation, atomic writes, state/probe JSON, tmp cleanup, scan; knows nothing about media or HTTP. | `node:fs/promises`, `node:path`, `node:crypto` | `createMediaCache({ root, profile, storageRoot })` → `{ root, profile, isValidSha256(s), entryDir(sha), paths(sha) → { dir, probe, state, poster: (ext) => path, motion, tmpDir }, readState(sha), writeState(sha, state), readProbe(sha), writeProbe(sha, probe), writeAtomic(finalPath, produce: (tmpPath) => Promise<void>), statDerivative(sha, type) → { path, bytes, mime } \| null, touch(sha, at), cleanupTmp({ olderThanMs }), scanEntries() → AsyncIterable<{ sha, profile, bytes, lastAccess }>, removeEntry(sha), staleProfileDirs() }`; constructor throws if `root` is inside `storageRoot` or `profile` is not `/^v\d+$/` | `tests/mediaCache.test.js` |
| `probe.js` (create) | Sniff family from bytes, run the bounded family-specific animation rule, gather dimensions, produce `probe.json`; rejects family/extension mismatch and dimension guards. | `processRunner.js` (ffprobe), optional sharp, `node:fs/promises` | `probeMedia({ absPath, ext, limits, capabilities, runner, sharp })` → `ProbeResult`; `sniffFamily(headerBytes, ext)` → `'jpeg'\|'png'\|'webp'\|'avif'\|'bmp'\|'gif'\|'mp4'\|'webm'\|null`; family rules exported for unit tests: `probeGifAnimation`, `probeWebpAnimation`, `probeApngAnimation`, `probeAvifAnimation`; `ProbeResult` = spec §13.3 (`animated: true\|false\|null`, `animationEvidence`) or `{ unsupported: true, reason }` with `reason ∈ { FAMILY_MISMATCH, DIMENSIONS, PROBE_FAILED, NO_CONTENT_IDENTITY }` | `tests/mediaProbe.test.js` |
| `poster.js` (create) | Produce one static poster (WebP; PNG only when `libwebp` is absent) into a tmp path using sharp or FFmpeg per family/engine switch. | `processRunner.js`, optional sharp | `generatePoster({ absPath, probe, tmpPath, limits, capabilities, runner, sharp })` → `{ file: 'poster.webp'\|'poster.png', mime, width, height, bytes }`; throws `MediaJobError` (`{ class: 'PERMANENT'\|'TRANSIENT', reason }`) | `tests/mediaPoster.test.js` |
| `motion.js` (create) | Produce one motion proxy MP4 into a tmp path with FFmpeg. | `processRunner.js` | `generateMotion({ absPath, probe, tmpPath, limits, capabilities, runner })` → `{ file: 'motion.mp4', mime: 'video/mp4', width, height, fps, seconds, bytes }`; `motionArgs(...)` exported (pure) for argument-contract tests; throws `MediaJobError` | `tests/mediaMotion.test.js` |
| `eviction.js` (create) | In-memory LRU index of cache entries and the high/low-water eviction pass with pinning. | `cache.js` | `createEvictor({ cache, limits, isPinned, now = Date.now, log })` → `{ buildIndex(), record(sha, bytes, at), touch(sha, at), totalBytes(), runIfNeeded() → { evicted, bytesFreed }, evictTo(targetBytes), schedule(intervalMs) → stop() }` | `tests/mediaEviction.test.js` |
| `derivatives.js` (create) | The media service: state machine per `(sha, type)`, probe→poster/motion dependencies, retry classes, cache lookups, media-info projection, serve descriptors, upload scheduling, admin status, invalidate. Owns nothing about HTTP framing. | `cache.js`, `queue.js`, `probe.js`, `poster.js`, `motion.js`, `eviction.js`, `capabilities.js` | `createDerivativeService({ limits, capabilities, cache, queue, runner, evictor, sharp, now, log, statfs })` → `{ init(), start(), stop(), info(row) → MediaInfo, infoBatch(rows) → Map, ensure(row, type, priority), serve(row, type, { v, p }) → ServeResult, scheduleForFile(row, priority), adminStatus(), invalidate(sha), isPinned(sha) }`; `MEDIA_STATE = { PENDING, READY, UNSUPPORTED, GENERATION_FAILED, RETRYABLE }`; `ServeResult = { kind: 'ready', path, mime, bytes, etag } \| { kind: 'pending', retryAfterSeconds } \| { kind: 'unsupported', reason } \| { kind: 'failed', reason } \| { kind: 'retryable', retryAfterSeconds } \| { kind: 'stale' } \| { kind: 'bad-request' }`; `MediaInfo` = spec §14.1 JSON | `tests/mediaDerivatives.test.js` |
| `warmup.js` (create, Task 14) | Enumerate eligible file rows and enqueue P2 jobs with a token bucket; pause while P0/P1 work waits. | `derivatives.js`, `db/store.js` | `runWarmup({ service, store, ratePerMinute = 30, limit, newestFirst, dryRun, types = ['poster','motion'], log })` → `{ scanned, skippedReady, enqueued, unsupported, failed }` | `tests/mediaDerivatives.test.js` (warm-up section) |

### Server — request/route integration

| File | Purpose | Imports / dependencies | Public interface | Tests |
|---|---|---|---|---|
| `server/request/byteRange.js` (create) | Extract the existing `parseByteRange()` from `routes/api.js` unchanged so preview and motion routes share it. | none | `parseByteRange(header, size)` (identical semantics) | `tests/filesPreviewRoute.test.js` (R8-RANGE) + `tests/mediaRoutes.test.js` |
| `server/routes/media.js` (create) | The four derivative routes plus the two Admin routes; owner gate identical to `/preview`; maps `ServeResult` to HTTP status/headers/cache policy. | `middleware/requireRole.js`, `db/store.js`, `request/byteRange.js`, `derivatives.js` (via `req.app.get('mediaService')`) | `mediaRouter` (Express router mounted inside `apiRouter` before any `/files/:id` GET); `derivativeHeaders({ etag, mime, policy })` exported for tests | `tests/mediaRoutes.test.js` |
| `server/routes/api.js` (modify) | Import `parseByteRange` from `request/byteRange.js`; mount `mediaRouter`; add post-response enqueue to V1 upload and version restore. | | unchanged public routes | existing suites + `tests/mediaUploadEnqueue.test.js` |
| `server/routes/uploads.js` (modify) | Post-response enqueue after V2 commit `201`. | | unchanged | `tests/mediaUploadEnqueue.test.js` |
| `server/app.js` (modify) | `app.set('mediaLimits', mediaLimitsFromEnv(env))`; `app.set('mediaService', options.mediaService ?? createDefaultService(limits))`; `/healthz` gains the additive `media` block. | `config/mediaLimits.js`, `media/derivatives.js` | `createApp({ env, mediaService })` | `tests/mediaRoutes.test.js`, `tests/mediaCapabilities.test.js` (health block) |
| `server/index.js` (modify) | After storage init: `detectCapabilities()` → `service.init()`; after `listen`: `service.start()` (tmp cleanup, index scan, eviction timer); on `SIGTERM`: `service.stop()`. | | | Task 15 boot evidence (image run) |
| `scripts/media-warmup.mjs` (create, Task 14) | Operator CLI wrapper around `runWarmup` with argument parsing and exit codes. | `server/media/warmup.js` | CLI flags `--limit --rate --newest-first --dry-run --types` | `tests/mediaDerivatives.test.js` (argument parsing) |

### Frontend — `src/`

| File | Purpose | Imports / dependencies | Public interface | Tests |
|---|---|---|---|---|
| `src/lib/mediaApi.js` (create) | Batch `media-info` client with request coalescing and bounded backoff; URL fields are opaque strings from the server. | `lib/api.js` (`apiFetch`) | `createMediaInfoClient({ fetchImpl = apiFetch, batchMax = 64, backoff = [2000, 4000, 8000, 15000], maxPendingMs = 120000, now })` → `{ request(id) → Promise<MediaInfo\|{status:'NOT_FOUND'}>, flush(), retryPending(id), stats() }` | `tests/filesMediaTiles.test.js` (client section) |
| `src/lib/mediaTile.js` (create) | Pure per-tile state machine (reducer + selectors); no DOM, no React. | none | `initialTileState({ contentId, family, previewable })`; `tileReducer(state, event)`; events: `INFO_LOADED{info}`, `INFO_PENDING{retryAfterMs}`, `INFO_UNSUPPORTED`, `INFO_FAILED`, `POSTER_LOADED`, `POSTER_ERROR`, `MOTION_READY`, `MOTION_ERROR`, `HOVER_ENTER`, `HOVER_LEAVE`, `VISIBILITY{band:'visible'\|'near'\|'off'}`, `REDUCED_MOTION{value}`, `CONTENT_CHANGED{contentId}`; selectors `posterSrc(s)`, `motionSrc(s)`, `shouldPlay(s)`, `wantsMotionPrefetch(s)`, `dataAttrs(s)` → `{ 'data-poster', 'data-motion', 'data-info' }` | `tests/filesMediaTiles.test.js` |
| `src/lib/mediaScheduler.js` (create) | Viewport-priority scheduler with in-flight caps and hover promotion; IntersectionObserver injected. | none (observer factory injected) | `createMediaScheduler({ createObserver, caps = { info: 1, poster: 6, motion: 3 }, onInfo, onPoster, onMotion })` → `{ register(key, element, meta), unregister(key), hover(key, on), done(kind, key), snapshot() }`; `PRIORITY_BANDS = ['visible','near','off']` | `tests/mediaScheduler.test.js` |
| `src/lib/useMediaTile.js` (create) | React hook binding one tile's reducer to the scheduler, the info client, `<img>`/`<video>` events and reduced-motion. | `react`, `mediaTile.js`, `hooks.js` (`useReducedMotion`) | `useMediaTile({ file, scheduler, infoClient, tileRef })` → `{ state, posterProps, videoProps, videoRef, containerProps }` | `tests/filesMediaTiles.test.js` (hook section) |
| `src/components/MediaThumb.jsx` (create) | The thumbnail DOM: icon/badge layer, poster `<img>` (never unmounted while `contentId` unchanged), motion `<video>` overlay; `data-*` attributes from the reducer. | `react`, `useMediaTile.js`, `lucide-react` | `<MediaThumb file scheduler infoClient vault />` | `tests/filesMediaTiles.test.js`, updated `tests/filesRound10.test.js` / `filesVisualHierarchy.test.js` / `filesInteractionPolish.test.js` |
| `src/screens/Files.jsx` (modify) | `FileTile` and `FileListRow` render `<MediaThumb>`; create one scheduler + info client per grid; drop `createGifPoster` import and the GIF poster effect; keep `FilePreviewModal` on `/preview`. | | | Task 13 suites |
| `src/lib/filesView.js` (modify) | Keep `previewKindFor`/`previewPathFor` for the dialog; add `mediaFamilyFor(file)` (allowlist family by extension for the icon/badge before info arrives). | | `mediaFamilyFor(file)` | `tests/filesVisualHierarchy.test.js` |
| `src/lib/strings.js` (modify) | Add `en/th/zh`: `mediaPending`, `mediaUnsupported`, `badgeGif`, `badgeVideo`, `badgeAnimated`. | | | `tests/filesMediaTiles.test.js` (strings parity) |
| `src/lib/gifPoster.js` (delete in Task 13) | Retired browser-side Blob poster. | | | `tests/filesRound10.test.js` proves no caller remains before deletion |

### Packaging / infra (Task 15 only)

| File | Change | Tests / evidence |
|---|---|---|
| `IDEA1-AEGIS_Drive_LC/Dockerfile` | Pin `node:20-alpine3.<n>`; `apk add --no-cache ffmpeg=<exact>`; `mkdir -p /var/cache/aegis-media && chown node:node /var/cache/aegis-media` before `USER node`. | image build + capability evidence recorded in PR body |
| `IDEA1-AEGIS_Drive_LC/package.json`, `package-lock.json` | add `sharp` (pinned minor). | `npm ci` on Alpine resolves `@img/sharp-linuxmusl-x64`; audit delta 0 |
| `docker-compose.yml` (root, cross-scope) | `aegis_drive_media_cache` volume with `name:`; mount on `drive`; `MEDIA_*` passthrough. | `docker compose config` render; declared under PR `## Shared Surfaces Touched` |
| `.env.example` (root, cross-scope) | document `MEDIA_CACHE_DIR`, `MEDIA_CACHE_MAX_BYTES`, `MEDIA_WORKERS`, `MEDIA_FFMPEG_ENCODER_THREADS`, `MEDIA_STILL_ENGINE`, `MEDIA_CACHE_POLICY`, `MEDIA_ENABLED`. | policy validator |

### Tests (owner → file)

`tests/mediaLimits.test.js`, `tests/mediaCapabilities.test.js`, `tests/mediaCache.test.js`, `tests/mediaProbe.test.js`, `tests/mediaProcessRunner.test.js`, `tests/mediaQueue.test.js`, `tests/mediaPoster.test.js`, `tests/mediaMotion.test.js`, `tests/mediaDerivatives.test.js`, `tests/mediaRoutes.test.js`, `tests/mediaCacheSessionContract.test.js`, `tests/filesMediaTiles.test.js`, `tests/mediaScheduler.test.js`, `tests/mediaUploadEnqueue.test.js`, `tests/mediaEviction.test.js`, `tests/mediaResponsiveness.test.js`, `tests/mediaLargeSources.test.js` (Task 16), plus shared helper `tests/helpers/mediaFixtures.mjs` (generated fixtures; Task 4 creates it) and modified `tests/filesRound10.test.js`, `tests/filesVisualHierarchy.test.js`, `tests/filesInteractionPolish.test.js` (Task 13).

## Commit boundaries

One commit per task, tests and implementation together (each task is independently reviewable at its commit):

1. `test+feat(idea1): add media limits and capability contracts`
2. `feat(idea1): add content-addressed media cache core`
3. `feat(idea1): add bounded media process runner and job queue`
4. `feat(idea1): add family-specific media probe`
5. `feat(idea1): add static poster generation`
6. `feat(idea1): add motion proxy generation`
7. `feat(idea1): add derivative service and cache eviction`
8. `feat(idea1): add authenticated media derivative routes`
9. `test(idea1): pin session cache-isolation contract`
10. `feat(idea1): enqueue media derivatives after upload success`
11. `feat(idea1): add media tile state machine and info client`
12. `feat(idea1): add viewport media scheduler`
13. `feat(idea1): render Files grid media from server derivatives`
14. `feat(idea1): add media cache admin status and warm-up`
15. `build(idea1): package media preview toolchain`
16. `test(idea1): add large-media and responsiveness gates`
17. `docs(idea1): record media pipeline verification evidence` (PR body/verification only; no receipt)
18. (no commit — hand-off)

---

### Task 1: Media configuration + runtime capability contract

**Files:**
- Create: `server/config/mediaLimits.js`
- Create: `server/media/capabilities.js`
- Create: `server/media/processRunner.js` (minimal `run()` needed by capability detection; full contract in Task 3)
- Modify: `server/app.js` (`app.set('mediaLimits', …)`; `/healthz` additive `media` block sourced from `app.get('mediaService')?.health()` or, before Task 7, from a static `{ enabled: false, reason: 'MEDIA_SERVICE_NOT_STARTED' }`)
- Test: `tests/mediaLimits.test.js`, `tests/mediaCapabilities.test.js`

**Interfaces:**
- Consumes: `process.env` / `createApp({ env })` injection (same seam `transferLimitsFromEnv`/`publicShareConfigFromEnv` use); `processRunner.run()` for `ffmpeg -version`, `ffmpeg -hide_banner -encoders`, `ffmpeg -hide_banner -decoders`, `ffprobe -version`; dynamic `import('sharp')`.
- Produces: `MEDIA_PROFILE_VERSION`, `mediaLimitsFromEnv()`, `MEDIA_DEFAULTS`, `detectCapabilities()`, `CAPABILITIES_NONE`, `/healthz.media`.

- [ ] **Step 1: Write the failing limits tests**

`tests/mediaLimits.test.js` (memory-only, no app boot), test names and contracts:

```
ML-1 defaults: mediaLimitsFromEnv({}) equals MEDIA_DEFAULTS and is frozen; profile === 'v1'; enabled === true
ML-2 MEDIA_ENABLED=false → enabled false, every other field still validated
ML-3 MEDIA_WORKERS: '1' ok, '2' ok, '3' throws /MEDIA_WORKERS must be between 1 and 2/, '0' throws, 'x' throws
ML-4 pixel guards: MEDIA_MAX_SOURCE_PIXELS below 1_000_000 throws; above 400_000_000 throws; default 40_000_000; MEDIA_MAX_VIDEO_FRAME_PIXELS default 35_389_440
ML-5 cache limits: MEDIA_CACHE_MAX_BYTES default 2147483648, min 64 MiB; MEDIA_CACHE_LOW_WATER default 0.8, must be in (0,1); MEDIA_CACHE_FREE_RESERVE_BYTES default 512 MiB
ML-6 MEDIA_CACHE_POLICY: default 'immutable'; 'revalidate' ok; 'public' throws /immutable|revalidate/
ML-7 MEDIA_STILL_ENGINE: default 'sharp'; 'ffmpeg' ok; 'magick' throws
ML-8 boxes and motion: posterBox 640x360, motionBox 480x270, motionFps 12 (range 1..30), motionMaxSeconds 6 (range 1..15), probesizeBytes 32 MiB, posterMaxBytes 512 KiB, motionMaxBytes 4 MiB
ML-9 timeouts: probe 20000, poster 60000, motion 120000; each min 1000, max 600000
ML-10 threads: decoderThreads 1, filterThreads 1, encoderThreads 2 (1..8); queueMax 500 (1..10000); batchMaxIds 64 (fixed, not env)
ML-11 cacheDir: default '/var/cache/aegis-media'; MEDIA_CACHE_DIR must be absolute (relative throws); trailing slash normalised
ML-12 a limits object built from env is deep-frozen (assigning to posterBox.width throws in strict mode)
```

- [ ] **Step 2: Run the limits suite and record RED**

`node --test --test-reporter=tap tests/mediaLimits.test.js` → expected RED: `ERR_MODULE_NOT_FOUND` for `../server/config/mediaLimits.js` (1 failing top-level file).

- [ ] **Step 3: Write the failing capability tests**

`tests/mediaCapabilities.test.js` uses a **fake runner** (`run()` returns scripted `{ code, stdout, stderr }` per `bin/args`) and a fake `loadSharp`:

```
MC-1 all tools present: scripted `ffmpeg -version` → "ffmpeg version 6.1.2 …", `-encoders` containing " V..... libx264" and " V..... libwebp", `-decoders` containing gif, apng, webp, av1, h264, vp8, vp9; sharp resolves {versions:{vips:'8.15.3'}} → enabled true, encoders/decoders true, sharp.ok true, reasons []
MC-2 ffmpeg missing (runner rejects ENOENT) → enabled false, reasons includes 'FFMPEG_MISSING', ffprobe still probed, sharp.ok still true; detectCapabilities never rejects
MC-3 ffprobe times out (runner returns timedOut:true) → enabled false, reasons includes 'FFPROBE_TIMEOUT'
MC-4 libx264 absent from encoders → enabled true, encoders.libx264 false, reasons includes 'ENCODER_LIBX264_MISSING'
MC-5 animated WebP decode: decoders.webpAnimated true only when `ffmpeg -version` major.minor >= 7.1 AND webp decoder listed; 6.1.2 → false
MC-6 sharp import throws → sharp.ok false, enabled unaffected, reasons includes 'SHARP_UNAVAILABLE'
MC-7 CAPABILITIES_NONE is frozen with enabled false
MC-8 /healthz (createApp with env MEDIA_ENABLED=true, no service started) returns 200 with media: { enabled:false, reason:'MEDIA_SERVICE_NOT_STARTED' } and the existing application/db/storage blocks unchanged (shape assertion against current keys)
MC-9 createApp with env MEDIA_WORKERS='9' throws at construction (config validated at app build, like transfer limits)
```

- [ ] **Step 4: Run the capability suite and record RED**

`node --test --test-reporter=tap tests/mediaCapabilities.test.js` → expected RED: `ERR_MODULE_NOT_FOUND` for `../server/media/capabilities.js`; MC-8/MC-9 fail on missing `media` key / no throw.

- [ ] **Step 5: Implement `mediaLimits.js`, minimal `processRunner.js`, `capabilities.js`, app wiring**

`mediaLimitsFromEnv` mirrors `transferLimits.js` helpers (`readInteger`, `readFraction`, plus `readEnum`, `readAbsolutePath`, `readBox`); freeze with a recursive `deepFreeze`. `processRunner.run()` in this task: `execFile(bin, args, { shell:false, env, timeout, maxBuffer, killSignal:'SIGTERM', windowsHide:true })` with the TERM→KILL grace implemented via `child.kill('SIGKILL')` on a timer — the same code Task 3 hardens. `detectCapabilities` parses `ffmpeg version (\d+)\.(\d+)`; encoders/decoders by regex on the listing lines. `app.js`: `const mediaLimits = mediaLimitsFromEnv(env); app.set('mediaLimits', mediaLimits)`; health block reads `app.get('mediaService')?.health?.() ?? { enabled:false, reason:'MEDIA_SERVICE_NOT_STARTED' }`.

- [ ] **Step 6: Run both suites and record GREEN**

`node --test --test-reporter=tap tests/mediaLimits.test.js tests/mediaCapabilities.test.js` → expected `# tests 21 # pass 21 # fail 0`.

- [ ] **Step 7: Local regression**

`node --test --test-concurrency=1 --test-reporter=tap tests/publicShareConfig.test.js tests/filesPreviewRoute.test.js tests/transferLimitsConfig.test.js` → all pass (5/5 for the preview route; the other two at their current counts), health shape unchanged for existing callers.

- [ ] **Step 8: `git diff --check`** → clean.

- [ ] **Step 9: Reviewer checklist checkpoint** — config validated at construction; invalid env cannot boot; missing tools degrade (`enabled:false`) rather than throw; no route/frontend integration yet; no upload file touched.

- [ ] **Step 10: Commit**

`git add server/config/mediaLimits.js server/media/capabilities.js server/media/processRunner.js server/app.js tests/mediaLimits.test.js tests/mediaCapabilities.test.js` → `test+feat(idea1): add media limits and capability contracts`

---

### Task 2: Content-addressed cache core

**Files:**
- Create: `server/media/cache.js`
- Test: `tests/mediaCache.test.js`

**Interfaces:**
- Consumes: `MediaLimits.cacheDir`, `MEDIA_PROFILE_VERSION`, `STORAGE_ROOT` (from `fileStore.js`, passed in as `storageRoot`).
- Produces: `createMediaCache()` per the file map; `MediaState` JSON shape (spec §13.4); `ProbeResult` JSON persisted verbatim.

- [ ] **Step 1: Write the failing cache tests** (tmp dirs via `fs.mkdtemp`; no DB; no media tools)

```
CC-1 isValidSha256: 64 lowercase hex ok; uppercase rejected; 63/65 chars rejected; '../' rejected
CC-2 entryDir(sha) === `<root>/v1/<sha[0:2]>/<sha[2:4]>/<sha>` and paths(sha).poster('webp') ends with '/poster.webp'; the original filename never appears (construct with a row name 'evil/../../x.png' — cache API has no name parameter at all)
CC-3 traversal impossible: entryDir throws on any invalid sha; path.resolve(entryDir) startsWith root
CC-4 constructor throws when root is inside storageRoot (`/datalake/cache` with storageRoot `/datalake`) and when profile is 'x1'
CC-5 writeAtomic: producer writes to tmpPath under `<root>/tmp/`; final path appears only after producer resolves; if producer throws, no final file and no tmp file remain
CC-6 writeAtomic concurrent: two producers for the same final path → last rename wins, no partial file observed by a concurrent reader (reader loop sees either ENOENT or full length)
CC-7 state round-trip: writeState(sha, {profile:'v1', sha256, poster:{state:'READY',file:'poster.webp',mime:'image/webp',width:640,height:360,bytes:1,attempts:1,generatedAt}, motion:{state:'PENDING',attempts:0,nextRetryAt:null,reason:null}, lastAccess}) → readState deep-equals; readState on missing entry → null (never throws)
CC-8 identity contracts: rename = same sha → same entryDir; replacement = different sha → different dir; profile 'v2' cache instance → different dir for the same sha (PROFILE_V1_CACHE_URL ≠ PROFILE_V2 path)
CC-9 statDerivative: returns {path, bytes, mime} for an existing poster.webp; null when missing; mime from state.json when present (poster.png fallback)
CC-10 touch(sha, at) updates in-memory lastAccess immediately and persists to state.json at most once per 3600 s (call twice within 1 s → one write; fake clock +3601 s → second write)
CC-11 cleanupTmp({olderThanMs:120000}): removes `tmp/*.tmp-*` older than the threshold, keeps newer ones, returns {removed}
CC-12 scanEntries yields {sha, profile, bytes(sum of derivative files), lastAccess} for every entry across v1/ and a stale v0/ dir; staleProfileDirs() returns ['v0']
CC-13 removeEntry renames the entry dir into tmp/evict-<uuid> and unlinks recursively; a concurrent readState during removal returns null or the full object, never a parse error
```

- [ ] **Step 2: RED**: `node --test --test-reporter=tap tests/mediaCache.test.js` → `ERR_MODULE_NOT_FOUND ../server/media/cache.js`.

- [ ] **Step 3: Implement `cache.js`** — pure `node:fs/promises`; JSON written with `writeAtomic` too; `touch` keeps a `Map<sha, {lastAccess, persistedAt}>`.

- [ ] **Step 4: GREEN**: same command → `# tests 13 # pass 13`.

- [ ] **Step 5: Local regression**: `node --test --test-reporter=tap tests/mediaLimits.test.js tests/mediaCapabilities.test.js tests/mediaCache.test.js` → 34/34.

- [ ] **Step 6: `git diff --check`** → clean.

- [ ] **Step 7: Reviewer checklist checkpoint** — no DB; no filename in path; root outside `STORAGE_ROOT` enforced; atomic writes; missing cache = regenerable state.

- [ ] **Step 8: Commit** → `feat(idea1): add content-addressed media cache core`

---

### Task 3: Process runner + bounded queue

**Files:**
- Modify: `server/media/processRunner.js` (full contract)
- Create: `server/media/queue.js`
- Test: `tests/mediaProcessRunner.test.js`, `tests/mediaQueue.test.js`

**Interfaces:**
- Consumes: `node:child_process`; `/proc/<pid>/io` and `/proc/<pid>/status` on Linux (best-effort sampling every 50 ms; `metrics: null` elsewhere).
- Produces: `createProcessRunner()`, `MINIMAL_CHILD_ENV`, `RunResult`; `createJobQueue()`, `PRIORITY`, `QueueFullError`.

- [ ] **Step 1: Write the failing runner tests** — real child processes using `process.execPath` (Node itself) as `bin` so the tests run on every platform without FFmpeg:

```
PR-1 shell is never used: args ['-e', 'console.log(process.argv.length)', '$(echo x)', 'a b'] → stdout '5' (arguments passed verbatim, not expanded); TypeError when an arg contains '\0' or is not a string
PR-2 minimal env: child prints JSON.stringify(Object.keys(process.env).sort()) → exactly ['HOME','LANG','PATH'] even when the parent has DATABASE_URL and SESSION_SECRET set in the test
PR-3 stdio cap: child writes 1 MiB to stdout → result.stdout.length === 65536 and result.stdoutTruncated === true; process still exits code 0
PR-4 timeout TERM→KILL: child ignores SIGTERM (`process.on('SIGTERM', ()=>{}); setInterval(()=>{},1000)`), timeoutMs 300, killGraceMs 200 → resolves within 1500 ms with timedOut true, killed true, signal 'SIGKILL'
PR-5 timeout TERM honoured: child exits on SIGTERM → signal 'SIGTERM', killed true, durationMs < killGraceMs + 300
PR-6 abort signal: aborting the passed AbortSignal kills the child and resolves with killed true
PR-7 no media bytes: run() result has no Buffer-typed field; a child that writes 4 MiB of binary to stdout yields a capped string, never a Buffer
PR-8 metrics on Linux: child reads 3 MiB from a temp file → metrics.readBytes >= 0 and metrics.vmHwmKb > 0 (test skips with '# SKIP linux-only' elsewhere)
PR-9 cwd: child prints process.cwd() → equals the runner cwd
```

- [ ] **Step 2: RED**: `node --test --test-reporter=tap tests/mediaProcessRunner.test.js` → PR-2/3/4/6/7/8 fail against the Task 1 minimal runner (env not minimal, no cap, no KILL escalation, no abort, no metrics).

- [ ] **Step 3: Write the failing queue tests** (fake clock; `run` functions are async stubs with controllable resolution):

```
JQ-1 dedup: enqueue('v1/a/poster', 0, run) twice → second returns deduplicated true, run called once, both promises resolve to the same value
JQ-2 priority order: three P2 jobs queued, then one P0 → P0 runs next after the current job
JQ-3 promote: a queued P2 key promoted to P0 moves ahead of other P2 jobs; promoting a running job is a no-op
JQ-4 concurrency 1: two jobs never overlap (running() never exceeds 1); concurrency 2 allows 2
JQ-5 maxDepth 3: fourth distinct enqueue rejects with QueueFullError synchronously (promise rejected; size() stays 3)
JQ-6 failure isolation: a run that rejects does not stop the queue; next job runs; stats().failed increments
JQ-7 shutdown({reason}): running job's signal is aborted; queued jobs reject with `QueueShutdownError`; enqueue after shutdown rejects
JQ-8 stats(): { depth, running, byPriority:{0,1,2}, completed, failed }
JQ-9 has(key) true while queued or running, false after completion
```

- [ ] **Step 4: RED**: `node --test --test-reporter=tap tests/mediaQueue.test.js` → `ERR_MODULE_NOT_FOUND ../server/media/queue.js`.

- [ ] **Step 5: Implement** the full runner (`spawn` with `stdio: ['ignore','pipe','pipe']`, per-stream byte counters that stop buffering after the cap but keep draining, TERM→KILL timer, AbortSignal, `/proc` sampler) and the queue (three FIFO arrays by priority, `Map<key, Job>`, worker loop).

- [ ] **Step 6: GREEN**: `node --test --test-reporter=tap tests/mediaProcessRunner.test.js tests/mediaQueue.test.js` → `# tests 18 # pass 18` on Linux (17 pass + 1 skip elsewhere).

- [ ] **Step 7: Local regression**: `node --test --test-reporter=tap tests/mediaCapabilities.test.js` (still uses the runner) → 9/9.

- [ ] **Step 8: `git diff --check`** → clean.

- [ ] **Step 9: Reviewer checklist checkpoint** — real timeout fixtures used (PR-4/5/6), not string inspection; env minimal; no Buffer of media.

- [ ] **Step 10: Commit** → `feat(idea1): add bounded media process runner and job queue`

---

### Task 4: Family-specific media probe

**Files:**
- Create: `server/media/probe.js`
- Create: `tests/helpers/mediaFixtures.mjs`
- Test: `tests/mediaProbe.test.js`

**Interfaces:**
- Consumes: `processRunner.run()` for `ffprobe`; optional sharp (`metadata()`); `MediaLimits` guards; `Capabilities` (for AVIF/WebP animated decode availability).
- Produces: `probeMedia()`, `sniffFamily()`, `probeGifAnimation()`, `probeWebpAnimation()`, `probeApngAnimation()`, `probeAvifAnimation()`, `ProbeResult`; fixture helper `makeFixtures(dir, { runner, sharp, capabilities })` → `{ stillJpeg, stillPng, apng, stillWebp, animatedWebp, stillAvif, animatedAvif, bmp, oneFrameGif, multiFrameGif, mp4Faststart, mp4MoovAtEnd, webmWithCues, webmWithoutCues, mismatchedJpeg, truncatedMp4, largeStill(width,height), longGif({seconds, highBitrate}), sparse(path, bytes) }` — each entry `{ path, bytes } | { skipped: reason }`.

- [ ] **Step 1: Write `tests/helpers/mediaFixtures.mjs`** (generation only; no assertions): stills via sharp `create` (or FFmpeg `color=`/`testsrc` when sharp is absent); APNG via `ffmpeg -f lavfi -i testsrc=size=64x64:rate=5 -t 1 -f apng -plays 0`; animated WebP via `-c:v libwebp -loop 0` (multi-frame) and still WebP via sharp; AVIF via sharp `.avif()` (still) and `ffmpeg -f avif` with `libaom-av1`/`libsvtav1` when an encoder exists (else `skipped:'AV1_ENCODER_MISSING'`); GIFs via `palettegen`/`paletteuse` with `-frames:v 1` vs `-t 2`; MP4 via `-c:v libx264 -movflags +faststart` and default (moov at end); WebM via `-c:v libvpx` default (Cues) and `-live 1` (no Cues); mismatched: text bytes written as `.jpg`; truncated: first 40 % of a valid MP4; `sparse(path, bytes)` = `fs.truncate` after copying a valid short file.

- [ ] **Step 2: Write the failing probe tests** (skip whole file with `# SKIP media-tools-unavailable` when `detectCapabilities()` reports `enabled:false`; pure header-rule tests for WebP/APNG run without tools using hand-built byte arrays):

```
FP-STILL_AVIF_NOT_ANIMATED: still AVIF → family 'avif', animated false, animationEvidence 'avif-no-avis-brand'
FP-ANIMATED_AVIF_ANIMATED_WHEN_SUPPORTED: animated AVIF fixture → animated true with evidence 'avif-avis-sample-count' when decoders.av1 and the encoder existed; otherwise the fixture is skipped and a crafted `ftyp` with `avis` but no moov within probesize → animated null, evidence 'avif-avis-unproven'
FP-STILL_WEBP_NOT_ANIMATED: still WebP → animated false, evidence 'webp-no-vp8x-animation-flag'
FP-ANIMATED_WEBP_ANIMATED: animated WebP → animated true, evidence 'webp-vp8x-flag-and-pages'
FP-PNG_NOT_ANIMATED: still PNG → animated false, evidence 'png-no-actl'
FP-APNG_ANIMATED: APNG → animated true, evidence 'apng-actl-before-idat', frames from acTL num_frames
FP-ONE_FRAME_GIF_NOT_ANIMATED: → animated false, evidence 'gif-single-packet'
FP-MULTIFRAME_GIF_ANIMATED: → animated true, evidence 'gif-second-packet'; ffprobe args include '-read_intervals', '%+#2' and never '-count_frames'
FP-ANIMATION_UNKNOWN_IS_POSTER_ONLY: crafted WebP with VP8X animation flag set but sharp pages 1 → animated null; probeMedia result carries `posterOnly: true`
FP-BUDGETS: APNG rule reads at most 64 KiB (fixture with 40 KiB of tEXt chunks before IDAT → still decided; 100 KiB → animated null 'apng-budget-exhausted'); WebP rule reads exactly the first 64 bytes (fs.read spy)
FP-MISMATCH: mismatchedJpeg → { unsupported:true, reason:'FAMILY_MISMATCH' }; ffprobe never invoked (runner spy)
FP-DIMENSIONS: largeStill(9000,5000) → unsupported 'DIMENSIONS' without decode (elapsed < 200 ms, sharp `metadata()` only); largeStill(12000,3000) → ok with pixels 36_000_000
FP-MALFORMED: truncatedMp4 → unsupported 'PROBE_FAILED' with the ffprobe exit code recorded; runner called with '-probesize', String(limits.probesizeBytes)
FP-VIDEO: mp4Faststart / webmWithCues → family mp4/webm, animated true, evidence 'family-video', width/height/duration numbers
FP-SNIFF: sniffFamily on the first 32 bytes of every fixture returns its family; a PNG named .jpg → null (mismatch)
FP-NO_GLOBAL_RULE: source scan — `grep -n "durationSeconds > 0" server/media/probe.js` returns no line outside the `probeAvifAnimation` comment (assert via fs.readFile + regex: no `frames > 1 ||` / `duration > 0 ||` expression exists)
```

- [ ] **Step 3: RED**: `node --test --test-reporter=tap tests/mediaProbe.test.js` → `ERR_MODULE_NOT_FOUND ../server/media/probe.js`.

- [ ] **Step 4: Implement `probe.js`**: `sniffFamily` (JPEG `FF D8 FF`, PNG signature, RIFF/WEBP, `ftyp` + avif/avis brands, `BM`, `GIF87a/89a`, `ftyp` mp4 brands, EBML `1A 45 DF A3`); family rules exactly per spec §6.1; dimensions from sharp metadata (stills) or ffprobe `-show_streams -select_streams v:0 -print_format json` (video/GIF/APNG/animated AVIF) with `-probesize`, `-analyzeduration 5000000`, timeout `probeTimeoutMs`; pixel guard before any decode; result persisted by the service (Task 7), not here.

- [ ] **Step 5: GREEN**: same command → `# tests 17 # pass 17` (with animated-AVIF possibly `# SKIP av1-encoder-missing` — recorded, not hidden).

- [ ] **Step 6: Local regression**: `node --test --test-reporter=tap tests/mediaProcessRunner.test.js tests/mediaCapabilities.test.js` → pass.

- [ ] **Step 7: `git diff --check`** → clean.

- [ ] **Step 8: Reviewer checklist checkpoint** — no global `frames>1||duration>0`; every rule byte-bounded; mismatch/dimension/malformed covered; vault not reachable (probe has no notion of rows; service/route tests cover it in Tasks 7–8).

- [ ] **Step 9: Commit** → `feat(idea1): add family-specific media probe`

---

### Task 5: Static poster generation

**Files:**
- Create: `server/media/poster.js`
- Test: `tests/mediaPoster.test.js`

**Interfaces:**
- Consumes: `ProbeResult`, `MediaLimits` (`posterBox`, `posterMaxBytes`, `posterTimeoutMs`, `stillEngine`, `maxSourcePixels`), `Capabilities` (`encoders.libwebp`, `sharp.ok`), `runner`, sharp; tmp path from `cache.writeAtomic`.
- Produces: `generatePoster()` → `{ file, mime, width, height, bytes }`; `MediaJobError`.

- [ ] **Step 1: Write the failing poster tests** (fixtures from Task 4; sharp `metadata()` and `ffprobe` used to inspect outputs):

```
PG-1 still JPEG 1920x1080 → poster.webp 640x360, format webp, no exif/icc/xmp in metadata, bytes ≤ 524288, engine reported 'sharp'
PG-2 no upscale: 200x100 PNG → 200x100 poster
PG-3 orientation: JPEG with EXIF orientation 6 (sharp .withMetadata({orientation:6})) → output 360x640 (rotated) and no orientation tag
PG-4 alpha: RGBA PNG with transparent corner → WebP output with hasAlpha true (sharp metadata) — no PNG branch taken
PG-5 BMP → engine 'ffmpeg', args contain '-frames:v','1' and '-c:v','libwebp'; output webp 640x360 box
PG-6 animated GIF poster → engine 'ffmpeg', first frame only ('-frames:v','1'), no '-t'
PG-7 video poster: mp4Faststart 4 s → args contain '-ss', '0.5' (clamp(0.05×4, 0.5, 3)); 30 s video → '-ss','1.5'; 0.3 s video → '-ss','0.3' (clamped to duration)
PG-8 output cap: limits.posterMaxBytes 2000 with a noisy 1920x1080 source → second encode at quality 60 attempted (spy on sharp/ffmpeg args), then MediaJobError PERMANENT 'OUTPUT_TOO_LARGE'; no final file
PG-9 malformed: mismatchedJpeg with a forged probe → MediaJobError PERMANENT 'DECODE_FAILED'; tmpPath removed
PG-10 timeout: limits.posterTimeoutMs 50 against largeStill(7000,5000) via the ffmpeg engine → MediaJobError TRANSIENT 'TIMEOUT', child killed (runner result killed true), tmp removed
PG-11 stillEngine 'ffmpeg' → JPEG uses ffmpeg (engine 'ffmpeg'); output still webp
PG-12 libwebp encoder absent (capabilities.encoders.libwebp false) → ffmpeg path writes poster.png with mime image/png; sharp path unaffected (still webp)
PG-13 sharp guard: sharp invoked with limitInputPixels === limits.maxSourcePixels, sequentialRead true, failOn 'error' (spy via a wrapped sharp factory)
PG-14 large still 12000x3000 PNG (36 MP, generated) → success; process.memoryUsage().rss delta during the call < 256 MiB (Linux gate; recorded elsewhere)
PG-15 atomic: producer writes only to tmpPath; final path is created by the caller's rename (generatePoster never touches a path other than tmpPath — fs spy)
```

- [ ] **Step 2: RED**: `node --test --test-reporter=tap tests/mediaPoster.test.js` → `ERR_MODULE_NOT_FOUND ../server/media/poster.js`.

- [ ] **Step 3: Implement `poster.js`**: sharp pipeline `sharp(absPath, { limitInputPixels, sequentialRead: true, failOn: 'error' }).rotate().resize(w, h, { fit: 'inside', withoutEnlargement: true }).toColourspace('srgb').webp({ quality, effort: 4 }).toFile(tmpPath)`; FFmpeg pipeline per spec §8 with `-threads 1 -filter_threads 1` before `-i`; size-cap re-encode once at quality 60; error classification (timeout/kill → TRANSIENT; exit ≠ 0 → PERMANENT `DECODE_FAILED`; ENOSPC → TRANSIENT `DISK`).

- [ ] **Step 4: GREEN**: same command → `# tests 15 # pass 15` (PG-14 `# SKIP linux-only` elsewhere).

- [ ] **Step 5: Local regression**: `node --test --test-reporter=tap tests/mediaProbe.test.js tests/mediaProcessRunner.test.js` → pass.

- [ ] **Step 6: `git diff --check`** → clean.

- [ ] **Step 7: Reviewer checklist checkpoint** — no committed binaries; 200/300 MB-class covered by generated large stills within the pixel guard; timeout cleanup proven; PNG fallback only when libwebp is absent.

- [ ] **Step 8: Commit** → `feat(idea1): add static poster generation`

---

### Task 6: Motion proxy generation

**Files:**
- Create: `server/media/motion.js`
- Test: `tests/mediaMotion.test.js`

**Interfaces:**
- Consumes: `ProbeResult` (must have `animated === true`), `MediaLimits` (`motionBox`, `motionFps`, `motionMaxSeconds`, `motionMaxBytes`, `motionTimeoutMs`, thread counts, `probesizeBytes`), `Capabilities` (`encoders.libx264`, `decoders.*`), `runner`.
- Produces: `generateMotion()`, `motionArgs({ absPath, tmpPath, limits })` (pure array), `MediaJobError`.

- [ ] **Step 1: Write the failing motion tests**

```
MG-ARGS motionArgs is exactly: ['-nostdin','-hide_banner','-loglevel','error','-protocol_whitelist','file','-threads',String(decoderThreads),'-filter_threads',String(filterThreads),'-probesize',String(probesizeBytes),'-analyzeduration','5000000','-ss','0','-t',String(motionMaxSeconds + 0.5),'-i',absPath,'-an','-t',String(motionMaxSeconds),'-vf',`fps=${fps},scale='min(${W},iw)':'min(${H},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,format=yuv420p`,'-c:v','libx264','-threads:v',String(encoderThreads),'-preset','veryfast','-crf','28','-maxrate','1200k','-bufsize','2400k','-g','24','-profile:v','main','-level','3.1','-movflags','+faststart','-y',tmpPath]; no '-filter_complex_threads' present; absPath is the only path-like element besides tmpPath
MG-GIF multiFrameGif → motion.mp4: ffprobe of output → codec h264, pix_fmt yuv420p, width ≤ 480, height ≤ 270, both even, r_frame_rate ≤ 12/1, duration ≤ 6.1, no audio stream, 'moov' offset < 'mdat' offset (read the first 64 KiB of the file and compare indexOf)
MG-APNG apng → same assertions
MG-WEBP animatedWebp → same assertions when capabilities.decoders.webpAnimated, else generateMotion throws MediaJobError PERMANENT 'DECODER_UNAVAILABLE' before spawning (runner not called)
MG-AVIF animatedAvif → same assertions when decoders.av1 and fixture exists, else PERMANENT 'DECODER_UNAVAILABLE' / fixture skipped
MG-MP4 mp4Faststart (10 s) → output duration ≤ 6.1 s; MG-WEBM webmWithCues → same
MG-STILL probe with animated false → throws PERMANENT 'NOT_ANIMATED' without spawning
MG-UNKNOWN probe with animated null → throws PERMANENT 'ANIMATION_UNKNOWN' without spawning
MG-CAP motionMaxBytes 20000 with a noisy 480x270 source → PERMANENT 'OUTPUT_TOO_LARGE', tmp removed
MG-MALFORMED truncatedMp4 with a forged animated probe → PERMANENT 'ENCODE_FAILED', tmp removed, stderr captured (≤ 64 KiB) in error.detail
MG-TIMEOUT motionTimeoutMs 100 against longGif({seconds:30}) → TRANSIENT 'TIMEOUT', killed true, tmp removed
MG-NOX264 capabilities.encoders.libx264 false → PERMANENT 'ENCODER_UNAVAILABLE' without spawning
MG-WINDOW truthfulness: longGif({seconds:30, highBitrate:true}) vs longGif({seconds:30, highBitrate:false}) — both outputs ≤ 6.1 s; the runner metrics.readBytes of the two runs are recorded in the TAP diagnostic output (`t.diagnostic`) and the test asserts only that the high-bitrate read is ≥ the low-bitrate read (no fixed byte bound is asserted)
```

- [ ] **Step 2: RED**: `node --test --test-reporter=tap tests/mediaMotion.test.js` → `ERR_MODULE_NOT_FOUND ../server/media/motion.js`.

- [ ] **Step 3: Implement `motion.js`** with `motionArgs` as the single source of the argument array; post-encode `stat` for the byte cap; `ffprobe`-free success check (exit 0 + file exists + bytes > 0); error classification as in Task 5.

- [ ] **Step 4: GREEN**: same command → `# tests 15 # pass 15` (WebP/AVIF cases may report `# SKIP decoder-unavailable` with the capability reason in the diagnostic).

- [ ] **Step 5: Local regression**: `node --test --test-reporter=tap tests/mediaPoster.test.js tests/mediaProbe.test.js` → pass.

- [ ] **Step 6: `git diff --check`** → clean.

- [ ] **Step 7: Reviewer checklist checkpoint** — thread options are per-stage; no fixed source-byte read claim (MG-WINDOW records, does not bound); still/unknown never spawn.

- [ ] **Step 8: Commit** → `feat(idea1): add motion proxy generation`

---

### Task 7: Derivative service + eviction

**Files:**
- Create: `server/media/eviction.js`
- Create: `server/media/derivatives.js`
- Test: `tests/mediaEviction.test.js`, `tests/mediaDerivatives.test.js`

**Interfaces:**
- Consumes: everything from Tasks 1–6; file rows shaped like `mapFileRow()` output (`{ id, name, kind, vault, sha256, path, size, ownerId }`); `statfs` (injected; default `fs.statfs`).
- Produces: `createDerivativeService()`, `MEDIA_STATE`, `ServeResult`, `MediaInfo`; `createEvictor()`.

- [ ] **Step 1: Write the failing eviction tests** (fake cache with in-memory entries; fake clock)

```
EV-1 buildIndex sums bytes and records lastAccess from scanEntries
EV-2 runIfNeeded below high water → {evicted:0}
EV-3 total 2.5 GiB with max 2 GiB, low water 0.8 → evicts LRU entries until ≤ 1.6 GiB; order strictly by lastAccess ascending
EV-4 pinned entries (isPinned true: in-flight job or accessed < 60 s ago) are skipped even if LRU
EV-5 stale profile dirs are evicted first regardless of lastAccess
EV-6 record()/touch() keep the index consistent after generation and serve
EV-7 schedule(600000) calls runIfNeeded on the timer; stop() clears it (fake timers)
EV-8 removeEntry failure (EBUSY) is logged and skipped, pass continues
```

- [ ] **Step 2: RED**: `node --test --test-reporter=tap tests/mediaEviction.test.js` → module not found.

- [ ] **Step 3: Write the failing service tests** (real `cache.js` on a tmp root; **fake** probe/poster/motion functions injected as `generators: { probe, poster, motion }` overrides so no media tools are needed; real queue with concurrency 1; fake clock)

```
DS-1 info(row) on a cold cache → status PENDING, poster.state PENDING with retryAfterMs ≥ 1000, motion.state PENDING; a probe job and a poster job are enqueued once (queue.has)
DS-2 after fake generators resolve → info READY/PARTIAL: poster.url === `/api/files/${id}/poster?v=${sha}&p=v1`, etag `"${sha}-v1-poster"`, motion.url likewise with -motion; sourceVersion === sha; profile 'v1'
DS-3 still image (probe animated false) → motion.state 'UNSUPPORTED' reason 'NOT_ANIMATED'; status READY once poster ready
DS-4 animated null → motion UNSUPPORTED reason 'ANIMATION_UNKNOWN'; poster still generated
DS-5 vault row → info returns { status:'NOT_FOUND' } and generators are never called; ensure()/scheduleForFile() return false and enqueue nothing (defence in depth independent of routes)
DS-6 folder row → NOT_FOUND; row without sha256 → UNSUPPORTED reason 'NO_CONTENT_IDENTITY', nothing enqueued
DS-7 extension outside allowlist → UNSUPPORTED reason 'UNSUPPORTED_TYPE', nothing enqueued; allowlist is the exact PREVIEW_MIME key set (import and compare)
DS-8 dedup across rows: two rows (different ids/names/owners) with the same sha → one job; both infos READY after it
DS-9 retry classes: poster generator throws TRANSIENT twice then succeeds → attempts 3, nextRetryAt follows 60 s → 300 s; a fourth TRANSIENT → GENERATION_FAILED; PERMANENT → GENERATION_FAILED immediately with reason; info reports RETRYABLE with retryAfterMs while nextRetryAt is in the future and does not enqueue before it
DS-10 serve(row,'poster',{v:sha,p:'v1'}) → {kind:'ready', path, mime, bytes, etag}; v mismatch → {kind:'stale'}; p 'v0' → {kind:'stale'}; missing v → {kind:'bad-request'}; while pending → {kind:'pending', retryAfterSeconds}; unsupported → {kind:'unsupported'}; failed → {kind:'failed'}; retryable → {kind:'retryable'}
DS-11 serve touches lastAccess (evictor.touch called) and pins recently served entries
DS-12 disk reserve: statfs returns free < cacheFreeReserveBytes → generation not started, state RETRYABLE reason 'DISK', retryAfterMs 60000
DS-13 queue full (queueMax 1 with one running) → info RETRYABLE reason 'QUEUE_FULL' and nothing enqueued
DS-14 eviction regeneration: after evictor removes the entry, info → PENDING and a new job is enqueued
DS-15 stale profile: an entry under v0/ is never served (serve with p:'v0' → stale) and is listed by staleProfileDirs for eviction
DS-16 invalidate(sha) removes the entry (audit hook called with 'MEDIA_CACHE_INVALIDATE') and resets attempts; adminStatus() returns { enabled, capabilities, cache:{dir,bytes,entries,highWater,lowWater,lastEvictionAt}, queue:{depth,running,byPriority}, failures:{last24h} } with no file names anywhere (JSON.stringify contains no fixture name)
DS-17 init()/start(): start runs cleanupTmp and buildIndex and schedules eviction; stop() aborts running jobs and stops timers; health() → { enabled, ffmpeg, sharp, cacheWritable, cacheVolume: 'volume'|'ephemeral' } (ephemeral when cacheDir is not a mount point — decided by comparing st_dev of cacheDir and its parent)
DS-18 infoBatch([rows]) returns a Map with per-row info; enqueues once per distinct sha; max 64 rows enforced by the caller (service accepts any length)
```

- [ ] **Step 4: RED**: `node --test --test-reporter=tap tests/mediaDerivatives.test.js` → module not found.

- [ ] **Step 5: Implement `eviction.js` and `derivatives.js`**: per-`(sha,type)` state derived from `state.json` + in-memory job map; `ensure()` chains probe → type job through the queue with key `${profile}/${sha}/${type}`; `MediaJobError` classes map to retry policy 60 s/300 s/1800 s, max 3; `serve()` never opens the file (returns path/mime/bytes; the route streams it); `scheduleForFile()` guards vault/folder/allowlist/sha/enabled; `health()`; `adminStatus()` aggregate only.

- [ ] **Step 6: GREEN**: `node --test --test-reporter=tap tests/mediaEviction.test.js tests/mediaDerivatives.test.js` → `# tests 26 # pass 26`.

- [ ] **Step 7: Local regression**: `node --test --test-concurrency=1 --test-reporter=tap tests/media*.test.js` → all media suites pass (skips only for tool/decoder availability).

- [ ] **Step 8: `git diff --check`** → clean.

- [ ] **Step 9: Reviewer checklist checkpoint** — cache stays non-authoritative (service reads/writes only under cache root; never touches `STORAGE_ROOT` except read-only via `resolveKey`); vault refused in the service; no DB access in the service (rows are passed in).

- [ ] **Step 10: Commit** → `feat(idea1): add derivative service and cache eviction`

---

### Task 8: Authenticated derivative API

**Files:**
- Create: `server/request/byteRange.js`
- Create: `server/routes/media.js`
- Modify: `server/routes/api.js` (import `parseByteRange` from the new module — delete the local copy; `apiRouter.use(mediaRouter)` placed immediately after `apiRouter.use('/files/uploads', uploadsRouter)`)
- Modify: `server/app.js` (`createApp({ env, mediaService })`; default service built from `mediaLimitsFromEnv(env)` with `CAPABILITIES_NONE` until `index.js` runs `init()`; `/healthz.media` from `service.health()`)
- Test: `tests/mediaRoutes.test.js`

**Interfaces:**
- Consumes: `store.findFile`, `store.findOwnFolder` (unchanged), `requireAuth`, `requireRole(ROLES.ADMIN)`, `csrfProtection` (already applied to `/api`), `mediaService.info/infoBatch/serve/adminStatus/invalidate`, `parseByteRange`.
- Produces: routes `GET /api/files/:id/media-info`, `POST /api/files/media-info/batch`, `GET /api/files/:id/poster`, `GET /api/files/:id/motion-preview`, `GET /api/admin/media-cache/status`, `DELETE /api/admin/media-cache/entries/:sha256`; `derivativeHeaders()`.

- [ ] **Step 1: Write the failing route tests** (app boot like `filesPreviewRoute.test.js`; **stub `mediaService`** injected via `createApp({ mediaService })` whose `serve()` returns scripted `ServeResult`s and whose `info()` returns scripted `MediaInfo`s, backed by real small files in a tmp dir for streaming; PostgreSQL mode when `TEST_DATABASE_URL` is set, memory otherwise)

```
MR-OWNER owner GET media-info → 200 JSON with sourceVersion === file.sha256 and profile 'v1'; Cache-Control 'private, no-store'
MR-CROSS other user's id → 404 {error:'Not found'} on media-info/poster/motion-preview; audit row FILE_PREVIEW DENIED written (readAudit); service.info/serve NOT called (spy)
MR-NULLOWNER row with uploaded_by NULL (PostgreSQL: UPDATE files SET uploaded_by=NULL; memory: seeded row) → 404 for everyone
MR-ADMIN admin requesting a user's file → 404 (no override)
MR-VAULT vault row (seed via helpers/seedRealVault.mjs pattern or a memory row with vault true) → 404 on all three routes AND service never invoked (spy count 0)
MR-FOLDER folder id → 400 {error:'Not a file'}
MR-UNSUPPORTED .txt file → media-info 200 {status:'UNSUPPORTED', reason:'UNSUPPORTED_TYPE'}; poster → 415; motion-preview → 415
MR-PENDING serve → pending {retryAfterSeconds:3} → poster 202, empty body, Retry-After '3', Cache-Control no-store
MR-READY serve → ready → poster 200 image/webp, Content-Length = bytes, X-Content-Type-Options nosniff, Content-Disposition inline; filename*=UTF-8''poster.webp, CSP "default-src 'none'; sandbox", CORP same-origin, ETag `"<sha>-v1-poster"`, Cache-Control 'private, max-age=31536000, immutable', Vary 'Cookie'
MR-RETRYABLE → 503 + Retry-After; MR-FAILED → 422 {error, reason}
MR-STALE_V poster?v=<other sha>&p=v1 → 404; MR-UNKNOWN_P p=v0 → 404 (service serve receives {v,p} and the route ALSO pre-validates p against limits.profile so the service is not called for unknown p — spy asserts 0 calls)
MR-MISSING poster without v → 400; without p → 400; malformed v (63 chars) → 400
MR-ETAG If-None-Match matching → 304 with the same Cache-Control/Vary/ETag headers and no body
MR-REVALIDATE env MEDIA_CACHE_POLICY=revalidate → 200 carries 'private, max-age=0, must-revalidate', ETag present, Vary absent
MR-RANGE motion-preview with Range bytes=0-99 → 206, Content-Range 'bytes 0-99/<bytes>', Accept-Ranges bytes; bytes=<bytes>- → 416 'bytes */<bytes>'; invalid syntax → 200 full
MR-BATCH POST /api/files/media-info/batch {ids:[own, other-owner, vault, folder, 'nope']} → 200 items: own → info, others → {status:'NOT_FOUND'}; 65 ids → 400; missing CSRF token → 403 (existing csrfProtection contract); non-array → 400
MR-NOHASHROUTE GET /api/media/<sha256>/poster and GET /api/files/by-sha/<sha256> → 404 from apiNotFound (no bare-hash route exists)
MR-ADMIN-STATUS user → 403; admin → 200 aggregate JSON (no 'name' keys anywhere in the payload)
MR-ADMIN-INVALIDATE admin DELETE valid sha → 204 and service.invalidate called with the sha; malformed sha → 400; user → 403
MR-PREVIEW-REGRESSION tests/filesPreviewRoute.test.js still 5/5 after parseByteRange extraction (run inside this task's regression)
```

- [ ] **Step 2: RED**: `node --test --test-reporter=tap tests/mediaRoutes.test.js` → 404s from `apiNotFound` on every media path; `createApp({ mediaService })` option ignored.

- [ ] **Step 3: Implement** `byteRange.js` (move the function verbatim + its JSDoc), `routes/media.js`, the `api.js` import/mount, `app.js` option and health wiring; owner gate copied from `/preview` (same comment block), `p` pre-validated against `req.app.get('mediaLimits').profile`, streaming via `fs.createReadStream(path, {start,end})` with `stream.on('error', () => res.destroy())`.

- [ ] **Step 4: GREEN (memory)**: same command → `# tests 22 # pass 22`.

- [ ] **Step 5: GREEN (PostgreSQL)**: `sh scripts/pg-integration-env.sh up` → export the printed vars → `TEST_DATABASE_URL=… node --test --test-reporter=tap tests/mediaRoutes.test.js` → 22/22 (MR-NULLOWNER and MR-VAULT run against real rows) → `sh scripts/pg-integration-env.sh down`.

- [ ] **Step 6: Local regression**: `node --test --test-concurrency=1 --test-reporter=tap tests/filesPreviewRoute.test.js tests/filesRound10.test.js tests/filesVisualHierarchy.test.js tests/protectedTrash.test.js tests/filesRenameMove.test.js` → unchanged counts (5, 24, 21, 12, 27).

- [ ] **Step 7: `git diff --check`** → clean.

- [ ] **Step 8: Reviewer checklist checkpoint** — owner gate before every other check; object-hiding; Vault never reaches the service; both identities validated; immutable only on 200/304 with `Vary: Cookie`; revalidate fallback; no bare-hash route.

- [ ] **Step 9: Commit** → `feat(idea1): add authenticated media derivative routes`

---

### Task 9: Session cache-isolation contract

**Files:**
- Test: `tests/mediaCacheSessionContract.test.js` (no source change expected; if any assertion fails, `MEDIA_CACHE_POLICY=revalidate` becomes the mandatory default in Task 15's compose/env and the spec §14.6 fallback clause is invoked — recorded in the PR body)

**Interfaces:**
- Consumes: `server/auth/session.js` (`establishSession`, `destroySession`, `SESSION_COOKIE`), the login/logout routes through `tests/helpers/testClient.mjs`, `mediaRoutes` from Task 8 (stub service returning `ready`).
- Produces: the executable form of spec §14.6's three invariants.

- [ ] **Step 1: Write the contract tests** (memory mode; two users `DEMO_USER` and a second user created through the Admin API as the existing user-management tests do; a `poster` URL for a file owned by A)

```
SC-1 pre-login request sets no `aegis.drive.sid` cookie (saveUninitialized false)
SC-2 login A → Set-Cookie aegis.drive.sid present, HttpOnly, SameSite=Strict; a second login for A on a fresh jar → a different sid value (regenerate)
SC-3 poster GET as A → 200 with Vary: Cookie; a repeat GET with the same jar → 200/304 (server still gates; test asserts the owner check ran by spying store.findFile call count)
SC-4 logout A → Set-Cookie clears aegis.drive.sid (Max-Age=0 or Expires in the past); the same poster URL with an empty jar → 401
SC-5 replay: the old A sid sent after logout → 401 (destroyed server-side)
SC-6 login B on the same "browser" jar (jar cleared by logout, then B's cookie) → same URL → 404 and a FILE_PREVIEW DENIED audit row (ownership gate executed); B's sid !== A's old sid
SC-7 rolling: two consecutive requests by A → Set-Cookie sid value unchanged (only expiry refreshed) — the Vary key is stable within a session
SC-8 static contract: source scan of server/auth/session.js asserts `req.session.regenerate(` occurs inside establishSession and `req.session.destroy(` + `res.clearCookie(SESSION_COOKIE)` inside destroySession (guards against a refactor silently removing them)
```

- [ ] **Step 2: Run**: `node --test --test-reporter=tap tests/mediaCacheSessionContract.test.js` → expected GREEN on first run (`# tests 8 # pass 8`) because the session code at `e5bea949` already satisfies the contract; if any of SC-2/4/5/6 fails, STOP: set the plan default to `MEDIA_CACHE_POLICY=revalidate`, note it in the PR body, and continue with revalidate as the shipped default.

- [ ] **Step 3: Prove the test bites**: temporarily comment out `regenerate` in a scratch copy (not committed) or monkey-patch `establishSession` in the test to skip regeneration → SC-2 must fail; restore.

- [ ] **Step 4: Local regression**: `node --test --test-concurrency=1 --test-reporter=tap tests/mediaRoutes.test.js tests/avatarSessionPersistence.test.js` (the existing suite that exercises `establishSession`) → pass.

- [ ] **Step 5: `git diff --check`** → clean.

- [ ] **Step 6: Reviewer checklist checkpoint** — contract is separate and executable; browser-level cache replay is a Task 18 acceptance step (DevTools "from disk cache" must be absent for B and anonymous).

- [ ] **Step 7: Commit** → `test(idea1): pin session cache-isolation contract`

---

### Task 10: Post-success derivative enqueue

**Files:**
- Modify: `server/routes/api.js` (V1 `POST /files/upload` success path; `POST /files/:id/versions/:versionId/restore` success path)
- Modify: `server/routes/uploads.js` (V2 `POST /:uploadId/commit` after the `201`)
- Test: `tests/mediaUploadEnqueue.test.js`

**Interfaces:**
- Consumes: `req.app.get('mediaService').scheduleForFile(row, PRIORITY.UPLOAD)`; the committed row (`result.file` / `row`).
- Produces: nothing new on the wire; upload/commit/restore responses, status codes, bodies, audits, limits unchanged.

- [ ] **Step 1: Write the failing enqueue tests** (app with a **stub service** whose `scheduleForFile` records calls and can be made to throw or to hang for 2 s)

```
UE-1 V1 upload of a .png → 201 as before; scheduleForFile called exactly once with the committed row (id, sha256, path) and priority 1, AFTER the response ('finish' listener: the spy records `res.headersSent === true` at call time)
UE-2 V2 init/chunk/commit of a .gif → 201 as before; scheduleForFile called once after the response
UE-3 version restore → 200 as before; scheduleForFile called once with the row carrying the restored sha256
UE-4 response does not wait: stub scheduleForFile hangs 2000 ms → upload 201 returned in < 500 ms (measured)
UE-5 scheduling failure is harmless: stub throws → upload still 201; error logged once (console.error spy) ; no audit change
UE-6 Vault: vault V2 commit path → scheduleForFile never called (spy 0) — vault commit route untouched
UE-7 unsupported: .txt upload → scheduleForFile called (the service decides) OR not called (route pre-filters on allowlist) — contract: either way no error and 201; assert no job in the service (stub reports enqueued 0)
UE-8 protocol unchanged: `tests/resumableUpload.test.js`, `tests/uploadRecovery.test.js`, `tests/filesUploadTargeting.test.js` byte-for-byte counts unchanged (run in regression); `server/config/transferLimits.js` unchanged (git diff --quiet on that path)
UE-9 same-name replace (V1) → scheduleForFile called with the NEW sha256
```

- [ ] **Step 2: RED**: `node --test --test-reporter=tap tests/mediaUploadEnqueue.test.js` → UE-1/2/3/9 fail (spy count 0).

- [ ] **Step 3: Implement**: a 12-line helper `scheduleDerivativesAfterResponse(req, res, row)` in `routes/media.js` (exported) that attaches `res.once('finish', () => { Promise.resolve(service.scheduleForFile(row, PRIORITY.UPLOAD)).catch(err => console.error('[media] schedule failed:', err.message)) })`; call it at the three success sites only.

- [ ] **Step 4: GREEN**: same command → `# tests 9 # pass 9`.

- [ ] **Step 5: Local regression**: `node --test --test-concurrency=1 --test-reporter=tap tests/resumableUpload.test.js tests/uploadRecovery.test.js tests/uploadRecoveryLifecycle.test.js tests/filesUploadTargeting.test.js tests/uploadBatchSummary.test.js tests/chunkedUploadClient.test.js tests/commitCrashRecoveryPostgres.test.js` → counts unchanged versus `main`; `git diff --quiet e5bea949 -- server/config/transferLimits.js` exit 0.

- [ ] **Step 6: `git diff --check`** → clean.

- [ ] **Step 7: Reviewer checklist checkpoint** — no upload optimisation; response never waits; failure harmless; Vault never scheduled.

- [ ] **Step 8: Commit** → `feat(idea1): enqueue media derivatives after upload success`

---

### Task 11: Frontend media API + pure tile state machine

**Files:**
- Create: `src/lib/mediaApi.js`, `src/lib/mediaTile.js`, `src/lib/useMediaTile.js`
- Modify: `src/lib/strings.js` (five keys × en/th/zh)
- Test: `tests/filesMediaTiles.test.js` (sections: client, reducer, hook)

**Interfaces:**
- Consumes: `apiFetch` (existing), `useReducedMotion` (existing), a scheduler object (Task 12; a stub in this task).
- Produces: `createMediaInfoClient()`, `initialTileState()`, `tileReducer()`, selectors, `useMediaTile()`.

- [ ] **Step 1: Write the failing client tests** (fake `fetchImpl`, fake clock)

```
MA-1 request(id) for 70 ids within one tick → two POST /api/files/media-info/batch calls (64 + 6), each body {ids:[…]}, never more than one in flight
MA-2 responses are dispatched per id; NOT_FOUND propagates as {status:'NOT_FOUND'}
MA-3 pending backoff: info PENDING with retryAfterMs 1000 → next poll at 1000 ms, then 2000, 4000, 8000, 15000, 15000 …; stops after maxPendingMs 120000 (no further fetch); retryPending(id) restarts once
MA-4 network error → the promise resolves {status:'FAILED'} (never rejects into React)
MA-5 URLs are opaque: the client never builds '?v=' itself (source scan of src/lib/mediaApi.js has no 'v=' / 'p=' literal)
```

- [ ] **Step 2: Write the failing reducer tests** (pure)

```
TS-1 initial: {info:'unknown', poster:'none', motion:'none', hover:false, play:false, band:'off', reducedMotion:false, contentId}
TS-2 VISIBILITY visible → info 'loading' allowed (selector wantsInfo true); INFO_LOADED with poster READY → poster 'loading', posterSrc === info.poster.url
TS-3 POSTER_LOADED → poster 'shown'; subsequent INFO_PENDING/INFO_FAILED/HOVER/VISIBILITY events never move poster away from 'shown' (poster never disappears) — property test over 200 random event sequences without CONTENT_CHANGED
TS-4 animated + motion READY + band visible/near + !reducedMotion → wantsMotionPrefetch true; band off → false; reducedMotion → false
TS-5 first-hover race (RED test for the Round 10 bug): sequence VISIBILITY visible → INFO_LOADED(animated, poster READY, motion READY) → POSTER_LOADED → HOVER_ENTER (motion still 'prefetching') → shouldPlay false and poster still 'shown' → MOTION_READY → shouldPlay true WITHOUT any HOVER_LEAVE/HOVER_ENTER in between
TS-6 HOVER_LEAVE → shouldPlay false; motion stays 'ready' (no refetch); poster 'shown'
TS-7 hover before prefetch started (motion 'none') → HOVER_ENTER sets motion 'prefetching' with priority 'p0' (selector hoverPromote true)
TS-8 REDUCED_MOTION true → shouldPlay false even when hovering and motion ready; motion 'none'
TS-9 CONTENT_CHANGED(newSha) → full reset to initial with the new contentId; CONTENT_CHANGED(same sha) → no-op (rename keeps everything)
TS-10 INFO_UNSUPPORTED / INFO_FAILED → info 'unsupported'/'failed' remembered; a later VISIBILITY visible does not request again (wantsInfo false); INFO_PENDING → wantsInfo false until retryAfter elapses (reducer stores nextInfoAt)
TS-11 MOTION_ERROR → motion 'failed', no retry, poster unaffected
TS-12 dataAttrs: {'data-poster':'icon|loading|shown','data-motion':'none|prefetching|ready|playing','data-info':'unknown|loading|ready|pending|unsupported|failed'}
TS-13 video idle uses poster: family 'mp4' → posterSrc from info, motionSrc only when wantsMotionPrefetch; never a '/preview' URL (assert no selector returns a string containing '/preview')
```

- [ ] **Step 3: Write the failing hook tests** (jsdom + `createRoot` + `act`, stub scheduler `{register, unregister, hover, done}` recording calls, stub client)

```
UH-1 mount registers the tile with the scheduler using contentId as key; unmount unregisters
UH-2 scheduler callback onInfo → client.request → INFO_LOADED dispatched; posterProps.src set; onLoad → POSTER_LOADED; onError → POSTER_ERROR
UH-3 videoProps: muted, playsInline, loop, preload 'auto', tabIndex -1, aria-hidden 'true'; src only when motion ≠ 'none'; onCanPlayThrough → MOTION_READY (and onLoadedData fallback)
UH-4 shouldPlay true → videoRef.current.play() called once; leave → pause() and currentTime = 0 (stubbed HTMLMediaElement)
UH-5 containerProps.onMouseEnter/onMouseLeave dispatch hover and call scheduler.hover(key, bool)
UH-6 strings parity: en/th/zh all define mediaPending, mediaUnsupported, badgeGif, badgeVideo, badgeAnimated
```

- [ ] **Step 4: RED**: `node --test --test-reporter=tap tests/filesMediaTiles.test.js` → `ERR_MODULE_NOT_FOUND` for the three modules (vite `ssrLoadModule` pattern as in `filesRound10.test.js`).

- [ ] **Step 5: Implement** the three modules and the strings.

- [ ] **Step 6: GREEN**: same command → `# tests 24 # pass 24`.

- [ ] **Step 7: Local regression**: `node --test --test-reporter=tap tests/filesInteractionPolish.test.js` (strings/hook imports untouched) → 28/28.

- [ ] **Step 8: `git diff --check`** → clean.

- [ ] **Step 9: Reviewer checklist checkpoint** — pure logic before Files.jsx; first-hover race has an explicit RED test (TS-5); poster never disappears (TS-3 property test).

- [ ] **Step 10: Commit** → `feat(idea1): add media tile state machine and info client`

---

### Task 12: Viewport media scheduler

**Files:**
- Create: `src/lib/mediaScheduler.js`
- Test: `tests/mediaScheduler.test.js`

**Interfaces:**
- Consumes: injected `createObserver(callback, { rootMargin })` (two observers: `'0px'` visible, `'50% 0px 50% 0px'` near); `onInfo(keys[])`, `onPoster(key)`, `onMotion(key)` callbacks that resolve when the resource finishes (or the tile calls `done(kind,key)`).
- Produces: `createMediaScheduler()`, `snapshot()` → `{ queued:{info,poster,motion}, inflight:{info,poster,motion} }`.

- [ ] **Step 1: Write the failing scheduler tests** (fake observer that the test drives with `enter(key, band)` / `leave(key)`)

```
VS-1 register 10 tiles, 4 visible → one onInfo call with those 4 keys (batch), then onPoster for each after info; queued info for the other 6 stays 0 (off band)
VS-2 near band → info + poster at P2 after visible work; motion for near animated tiles only after visible motion (P3)
VS-3 caps: 20 visible tiles → inflight.poster never exceeds 6; inflight.motion never exceeds 3; inflight.info never exceeds 1 (assert on every tick)
VS-4 hover(key,true) on a near tile with motion queued → its motion moves to the front (next started); if 3 in flight, the lowest-priority in-flight prefetch is preempted (its onMotion promise receives an AbortSignal abort) and re-queued
VS-5 unregister(key) removes queued work for the key and aborts in-flight work for it
VS-6 leave(key) to 'off' band removes queued (not in-flight) work
VS-7 2,000 registered tiles with 12 visible + 24 near → total motion requests over the run ≤ 36 and info requests ≤ ceil(36/64)=1 batch per band change; never 2,000
VS-8 done('poster', key) frees a slot even if the callback promise never settled (defensive)
VS-9 order within a band follows registration order (DOM order)
VS-10 reducedMotion flag passed in meta → no motion work ever queued for that tile
```

- [ ] **Step 2: RED**: `node --test --test-reporter=tap tests/mediaScheduler.test.js` → module not found.

- [ ] **Step 3: Implement**: three priority lanes per kind, `Map<key, entry>`, band tracking from the two observers, promotion/preemption with `AbortController` per in-flight motion.

- [ ] **Step 4: GREEN**: same command → `# tests 10 # pass 10`.

- [ ] **Step 5: Local regression**: `node --test --test-reporter=tap tests/filesMediaTiles.test.js` → 24/24.

- [ ] **Step 6: `git diff --check`** → clean.

- [ ] **Step 7: Reviewer checklist checkpoint** — no motion prefetch outside visible/near; caps enforced; hover promotes; unregister cancels.

- [ ] **Step 8: Commit** → `feat(idea1): add viewport media scheduler`

---

### Task 13: Files grid integration

**Files:**
- Create: `src/components/MediaThumb.jsx`
- Modify: `src/screens/Files.jsx` (FileTile/FileListRow → `<MediaThumb>`; one `createMediaScheduler` with real `IntersectionObserver` and one `createMediaInfoClient` per `FilesSections` instance; remove the GIF poster effect, `isGif`/`poster` state, `videoRef` effect, and the `createGifPoster` import; `FilePreviewModal` unchanged)
- Modify: `src/lib/filesView.js` (`mediaFamilyFor`)
- Delete: `src/lib/gifPoster.js` (only after Step 6 proves no importer)
- Modify tests: `tests/filesRound10.test.js` (R10-GIF-1..10, R10-SR1-A..D rewritten to the derivative contract; R10-ROOTDROP-* and R10-SR2-* unchanged), `tests/filesVisualHierarchy.test.js` (R8-PREVIEW-2/-3/-7b thumbnail source → poster URL), `tests/filesInteractionPolish.test.js` (R9-MOTION-* → motion proxy `<video>`)
- Test: `tests/filesMediaTiles.test.js` (integration section using the real `Files` screen with stubbed fetch, as `filesInteractionPolish.test.js` does)

**Interfaces:**
- Consumes: Tasks 11–12; `IntersectionObserver` (jsdom lacks it → tests inject a fake via `window.IntersectionObserver`).
- Produces: user-facing grid behaviour; `data-poster`/`data-motion`/`data-info` attributes on the thumbnail box; `data-thumb` retained for backward-compatible selectors with values `icon|poster|motion`.

- [ ] **Step 1: Write the failing integration tests** (real `Files` screen; fetch stub serves `GET /api/files`, `POST /api/files/media-info/batch`, and poster/motion bytes; fake IntersectionObserver exposing `enter(el, band)`)

```
GI-STATIC-1 cold: png tile shows icon (data-poster icon, data-info pending) and NO request to /api/files/<id>/preview (fetch log)
GI-STATIC-2 batch info READY → <img src="/api/files/<id>/poster?v=…&p=v1"> mounted; after load data-poster shown; still no /preview request
GI-ANIM-1 gif tile idle: poster shown; <video> not mounted until visible+info motion READY; then video src is motion-preview URL with preload auto, muted, loop, playsInline, opacity 0
GI-ANIM-2 first hover while video canplaythrough not yet fired → play() not called, poster still shown; dispatch canplaythrough → play() called once, video opacity 1, no mouseleave/mouseenter in between (the Round 10 race, end-to-end)
GI-ANIM-3 mouseleave → pause(), currentTime 0, opacity 0, poster still in DOM (same element identity via a WeakRef/`data-mounted-at` attribute)
GI-VIDEO-1 mp4 tile idle uses poster derivative; hover uses motion-preview; the grid never issues a request containing '/preview' (fetch log) — GI-PREVIEW-1 opening the Preview dialog DOES request /api/files/<id>/preview (unchanged dialog)
GI-UNSUPPORTED .txt → icon, data-info unsupported, no poster request
GI-PENDING-BACKOFF pending → one batch poll at retryAfterMs, then backoff; hover restarts once after the 120 s stop (fake timers)
GI-RENAME renaming a.gif → b.gif (PATCH stub + refetch) keeps data-poster shown and issues no new poster request; GI-REPLACE a new sha in the refetched list resets to icon and requests info again
GI-REDUCED matchMedia reduce → no <video> mounted, hover does nothing; Preview menu still present
GI-BADGES gif/apng/webp-animated show badge 'GIF'/'Animated' text from strings; mp4 shows 'VIDEO'
GI-REGRESSION folder tiles unchanged (data-tile-variant folder-compact); marquee selection test scene from filesInteractionPolish still selects f3; sort select still works; root breadcrumb drop still moves (R10-ROOTDROP-1 rerun in place); upload drawer opens
GI-NO-GIFPOSTER `grep -rn gifPoster src/ tests/` returns only the deletion-era test file (before deletion) → after deletion returns nothing; vite build has no chunk containing 'createImageBitmap' from src (grep dist after build in Task 17)
```

- [ ] **Step 2: RED**: `node --test --test-reporter=tap tests/filesMediaTiles.test.js` → GI-* fail (thumbnail still `<img src=/preview>` and GIF Blob poster path).

- [ ] **Step 3: Rewrite the three existing suites' affected cases** to the new contract (keep their IDs and intent; e.g. R10-GIF-3 "idle never shows an animating `<img>` of the original" becomes "idle shows the poster derivative and no original URL"; R10-SR1-A "49.7 MB acceptance GIF gets a poster" becomes "size does not gate anything: a 49.7 MB gif tile requests media-info and shows the poster when READY"), run them → RED against the old implementation.

- [ ] **Step 4: Implement** `MediaThumb.jsx` and the `Files.jsx` changes; `mediaFamilyFor`.

- [ ] **Step 5: GREEN**: `node --test --test-concurrency=1 --test-reporter=tap tests/filesMediaTiles.test.js tests/filesRound10.test.js tests/filesVisualHierarchy.test.js tests/filesInteractionPolish.test.js` → all pass; record the new counts in the PR body (expected: filesMediaTiles 24 + 14 GI; filesRound10 24 → 24 with rewritten GIF cases; filesVisualHierarchy 21; filesInteractionPolish 28).

- [ ] **Step 6: Delete `src/lib/gifPoster.js`** only after `grep -rn "gifPoster" src tests server` prints nothing; re-run Step 5.

- [ ] **Step 7: Local regression**: `node --test --test-concurrency=1 --test-reporter=tap tests/filesManagementUi.test.js tests/filesRenameMove.test.js tests/filesTrashLifecycle.test.js tests/filesCreatedTimestamp.test.js tests/uploadDrawerUi.test.js tests/filesUploadTray.test.js` → unchanged counts; `npm run build` → pass; restore dist.

- [ ] **Step 8: `git diff --check`** → clean.

- [ ] **Step 9: Reviewer checklist checkpoint** — ORIGINAL_GRID_FETCH=NO proven by fetch-log assertions; dialog unchanged; reduced motion honoured; regression list green; gifPoster deleted with proof.

- [ ] **Step 10: Commit** → `feat(idea1): render Files grid media from server derivatives`

---

### Task 14: Admin observability + controlled warm-up

**Files:**
- Create: `server/media/warmup.js`, `scripts/media-warmup.mjs`
- Modify: `server/routes/media.js` (admin routes were added in Task 8 as thin wrappers; this task completes `adminStatus` content with queue/failure counters if Task 7 left any field static)
- Test: `tests/mediaDerivatives.test.js` (warm-up section, appended)

**Interfaces:**
- Consumes: `store.listFiles`-class read access — a new read-only store query `store.iterateMediaCandidates({ pageSize, newestFirst })` (PostgreSQL: `SELECT id, name, path, sha256, size_bytes, uploaded_by, kind, vault FROM files WHERE vault=false AND kind='file' AND deleted_at IS NULL AND sha256 IS NOT NULL ORDER BY id [DESC] LIMIT $1 OFFSET $2`; memory: filter of the in-memory list). This is a SELECT-only addition to `db/store.js`; no schema change.
- Produces: `runWarmup()`, CLI exit codes (0 ok, 2 tools missing, 3 DB unreachable).

- [ ] **Step 1: Write the failing warm-up tests** (fake store iterator with 250 rows incl. vault/folder/no-sha/.txt rows; fake service recording `scheduleForFile` priority)

```
WU-1 enumerates only vault=false, kind file, sha present rows (store predicate asserted via the SQL text in PostgreSQL mode and via the filter in memory mode)
WU-2 skips entries already READY in cache (service.info stub) without enqueueing
WU-3 token bucket: ratePerMinute 60 → at most 1 enqueue per second (fake clock)
WU-4 pauses while queue.stats().byPriority[0]+[1] > 0; resumes when 0
WU-5 --limit 10 stops after 10 enqueues; --dry-run enqueues nothing and reports would-enqueue counts; --types poster only requests poster
WU-6 summary {scanned, skippedReady, enqueued, unsupported, failed} exact for the fixture set
WU-7 CLI arg parsing: invalid --rate → exit 1 with usage; capabilities.enabled false → exit 2 before touching the DB
WU-8 no filenames in any log line or in adminStatus JSON (regex over captured output)
```

- [ ] **Step 2: RED** → module not found.
- [ ] **Step 3: Implement** `warmup.js`, the store query, the CLI.
- [ ] **Step 4: GREEN**: `node --test --test-reporter=tap tests/mediaDerivatives.test.js` → 26 + 8 = 34 pass.
- [ ] **Step 5: Local regression**: `node --test --test-reporter=tap tests/mediaRoutes.test.js` → 22/22.
- [ ] **Step 6: `git diff --check`** → clean.
- [ ] **Step 7: Reviewer checklist checkpoint** — warm-up is CLI-only, throttled, P2, never automatic, never run against Production in this plan.
- [ ] **Step 8: Commit** → `feat(idea1): add media cache admin status and warm-up`

---

### Task 15: Packaging / Docker / dev compose

**Files:**
- Modify: `IDEA1-AEGIS_Drive_LC/Dockerfile`, `IDEA1-AEGIS_Drive_LC/package.json`, `IDEA1-AEGIS_Drive_LC/package-lock.json`
- Modify (cross-scope, declared): `docker-compose.yml`, `.env.example`
- Modify: `server/index.js` (boot wiring: `detectCapabilities` → `service.init()` → `start()` after listen → `stop()` on SIGTERM)
- Test/evidence: image build log, `docker run --rm <image> ffmpeg -version`, `ffprobe -version`, `ffmpeg -hide_banner -encoders | grep -E 'libx264|libwebp'`, `ffmpeg -hide_banner -decoders | grep -E ' (gif|apng|webp|av1|h264|vp8|vp9) '`, `node -e "import('sharp').then(s=>console.log(s.default.versions))"`, `docker image inspect --format '{{.Size}}'` delta vs the Round 10 image, `/healthz` from a container run with the dev compose.

**Interfaces:**
- Consumes: Tasks 1–14 application behaviour.
- Produces: a buildable image with the toolchain; the dev/test named volume; documented env variables.

- [ ] **Step 1: Resolve exact versions before editing**: `docker run --rm node:20-alpine cat /etc/alpine-release` → pin `FROM node:20-alpine3.<minor>` for both stages; `docker run --rm node:20-alpine3.<minor> sh -c 'apk update >/dev/null && apk policy ffmpeg'` → exact `ffmpeg=<version>-r<n>`; `npm view sharp version` → pin `^<major.minor>` in `package.json`.

- [ ] **Step 2: STOP CONDITION check**: build a throwaway image with only `apk add ffmpeg=<exact>` and run the encoder/decoder greps. If `libx264` or `libwebp` is missing from encoders, or `gif`/`apng`/`h264`/`vp8`/`vp9` from decoders → STOP this task, record the evidence in the PR body, and re-review packaging (spec §10.3 strategy) — do not weaken the design (no codec switch, no silent MP4→WebM change). Missing `av1` decoder or animated-WebP decode is a documented degradation (poster-only), not a stop.

- [ ] **Step 3: Edit the Dockerfile**: pinned base tags; in the runtime stage before `USER node`: `RUN apk add --no-cache ffmpeg=<exact>` and `RUN mkdir -p /var/cache/aegis-media && chown -R node:node /var/cache/aegis-media`; keep `/datalake` block unchanged.

- [ ] **Step 4: Add sharp**: `npm install --save-exact sharp@<version>` (Windows/Linux dev: prebuilt for the host); verify `npm ci --omit=dev` inside the Alpine build stage resolves `@img/sharp-linuxmusl-x64` (log line) and that `npm audit` total stays 8/5/3/0 — a higher count stops the task for review.

- [ ] **Step 5: Root compose + env**: `docker-compose.yml` → `drive.volumes` += `aegis_drive_media_cache:/var/cache/aegis-media`; `drive.environment` += `MEDIA_CACHE_DIR: /var/cache/aegis-media`, `MEDIA_CACHE_MAX_BYTES: ${MEDIA_CACHE_MAX_BYTES:-2147483648}`, `MEDIA_WORKERS: ${MEDIA_WORKERS:-1}`, `MEDIA_STILL_ENGINE: ${MEDIA_STILL_ENGINE:-sharp}`, `MEDIA_CACHE_POLICY: ${MEDIA_CACHE_POLICY:-immutable}`; top-level `volumes:` += `aegis_drive_media_cache:` with `name: aegis_drive_media_cache` and the comment `# rebuildable derivative cache — not backed up, safe to delete when unused`. `.env.example` documents the same variables under the Storage Layer section (documentation only). `docker compose config --quiet` → exit 0.

- [ ] **Step 6: Wire `index.js`** and run the image: `docker compose build drive` → `docker compose up -d postgres drive` → `curl -s http://127.0.0.1:8001/healthz` (inside the network or via `docker compose exec drive wget -qO- http://127.0.0.1:8001/healthz`) shows `media.enabled true`, `cacheVolume "volume"`, capability object; `docker compose exec drive ls -ld /var/cache/aegis-media` → owner `node`; `docker compose down` (volumes retained).

- [ ] **Step 7: Record evidence** (image size delta ≤ +150 MB or stop for review; `ffmpeg -version` line; encoder/decoder greps; sharp versions) in the PR body Verification section.

- [ ] **Step 8: Local regression**: `node --test --test-concurrency=1 --test-reporter=tap tests/media*.test.js` on the Linux clone with real tools → `MEDIA_SKIP=0` (no `media-tools-unavailable` skips; decoder-specific skips listed by reason).

- [ ] **Step 9: `git diff --check`** → clean; restore `dist/` if the build touched it.

- [ ] **Step 10: Reviewer checklist checkpoint** — Production overlay NOT created; base compose and Public Share overlays untouched; cross-scope paths declared in the PR body (`docker-compose.yml`, `.env.example`) under `## Shared Surfaces Touched` with `integration-review: yes` (already set).

- [ ] **Step 11: Commit** → `build(idea1): package media preview toolchain`

---

### Task 16: Large-media / resource verification (Linux gate)

**Files:**
- Test: `tests/mediaLargeSources.test.js`, `tests/mediaResponsiveness.test.js` (both skip outside Linux or without tools; both marked `# SKIP linux-gate` elsewhere)
- Modify: `tests/helpers/mediaFixtures.mjs` (large/sparse generators if not already complete)

**Interfaces:**
- Consumes: real service (Tasks 7–8) with real tools; `processRunner` metrics; `/proc/<pid>/status` `VmHWM`; fixtures generated at test time (never committed).
- Produces: recorded evidence lines (TAP diagnostics) and pass/fail on the bounded contracts of spec §23–§24.

- [ ] **Step 1: Write the large-source tests**

```
LS-SMALL 64 KiB JPEG → poster ≤ 512 KiB; wall clock recorded
LS-200MB generated 200 MB-class still (e.g. 8000×5000 PNG with noise, ~200 MB on disk) → poster succeeds within posterTimeoutMs; child/sharp peak RSS recorded; output ≤ 512 KiB
LS-300MB 300 MB-class still within 40 MP (e.g. 8000×5000 16-bit PNG) → succeeds; a 9000×5000 (over guard) → UNSUPPORTED DIMENSIONS in < 200 ms
LS-GIF-518K and LS-GIF-49MB generated GIFs of those byte sizes (testsrc noise, palette) → poster + motion succeed; readBytes recorded; output caps hold
LS-ANIM-HI/LO 200 MB and 300 MB-class GIF and APNG with high- and low-bitrate first windows → motion ≤ 6.1 s, ≤ 4 MiB, within timeout; readBytes recorded and high ≥ low; NO fixed byte bound asserted
LS-VIDEO-196MB generated 196 MB MP4 (faststart) → poster + motion; grid-relevant transfer = derivative bytes only
LS-SPARSE-10G for each class {mp4Faststart, mp4MoovAtEnd, webmWithCues, webmWithoutCues} extended to 10 GiB by truncate → poster + motion succeed or fail truthfully within timeout; readBytes recorded per class; assert readBytes < 64 MiB ONLY for mp4Faststart and webmWithCues; assert child VmHWM < 1 GiB for all; assert no process leak (pgrep -f the fixture path after the run → none) and no tmp leak (cache tmp/ empty)
LS-SPARSE-20G same four classes at 20 GiB (skipped when the tmp filesystem lacks sparse support or free inodes; skip reason recorded)
```

- [ ] **Step 2: Write the responsiveness test** — exactly spec §23 "Resource / responsiveness": 30 s baseline at 5 req/s for `/healthz` and `GET /api/files`, then during LS-ANIM-HI (300 MB) and during LS-SPARSE-10G mp4MoovAtEnd; asserts zero non-200, none > 5 s, process alive, child VmHWM recorded; computes and prints `REGRESSION_RATIO` per endpoint (no threshold assertion; printed for review).

- [ ] **Step 3: Run on the Linux clone** (`~/aegis-pr148-verify` pattern; tools present from Task 15's image or host `apk`/`apt` FFmpeg + sharp prebuilt): `node --test --test-concurrency=1 --test-reporter=tap tests/mediaLargeSources.test.js tests/mediaResponsiveness.test.js > $OUT/media_large.tap` → record counts, every `# readBytes`/`# vmHwm`/`# ratio` diagnostic line into the PR body.

- [ ] **Step 4: `git diff --check`** → clean.

- [ ] **Step 5: Reviewer checklist checkpoint** — no giant bytes committed; claims limited to proven fixture classes; ratio recorded, not invented.

- [ ] **Step 6: Commit** → `test(idea1): add large-media and responsiveness gates`

---

### Task 17: Full regression / PostgreSQL / build / policy

**Files:**
- Modify: PR #150 body (Verification section, Source Files Changed, Shared Surfaces; status-only, no receipt)
- No application source changes expected; any failure here loops back to the owning task.

**Interfaces:**
- Consumes: the whole branch at a frozen SHA.
- Produces: the recorded evidence block for Task 18.

- [ ] **Step 1: Memory-mode media suites** — `node --test --test-concurrency=1 --test-reporter=tap tests/media*.test.js tests/filesMediaTiles.test.js` → all pass; list skips by reason.

- [ ] **Step 2: PostgreSQL-gated suites** — `sh scripts/pg-integration-env.sh up`; one fresh DB per file (`CREATE DATABASE x TEMPLATE aegis_drive_test` + `REVOKE CONNECT … FROM PUBLIC; GRANT … TO drive_app`); `TEST_DATABASE_URL=… node --test --test-reporter=tap tests/mediaRoutes.test.js tests/mediaUploadEnqueue.test.js tests/mediaCacheSessionContract.test.js` → pass with `PR150_POSTGRES_SKIP=0`; also on clones upgraded through migration 010 (`mig_tpl` procedure) → same; `sh scripts/pg-integration-env.sh down`; delete the exported credential file.

- [ ] **Step 3: Existing PR150 suites** — the 13 files (`filesHierarchyIntegrity filesInteractionPolish filesCreatedTimestamp filesKindIdentity filesKindMigrationPostgres filesManagementUi filesPreviewRoute filesRenameMove filesTrashLifecycle filesUploadTargeting filesVisualHierarchy filesRound10 protectedTrash`) in memory and PostgreSQL modes → counts recorded (expected: unchanged except the Task 13 rewrites; `filesPreviewRoute` 5/5; `NEW_FAILURE_COUNT=0`).

- [ ] **Step 4: PR148 regression** — `tests/uploadRecovery.test.js tests/uploadRecoveryLifecycle.test.js tests/uploadBatchSummary.test.js tests/filesUploadTray.test.js tests/uploadDrawerUi.test.js tests/uploadCompletionUx.test.js tests/chunkedUploadClient.test.js tests/resumableUpload.test.js` → 101/101 (PostgreSQL) as at `e5bea949`.

- [ ] **Step 5: Upload crash recovery** — `tests/commitCrashRecoveryPostgres.test.js tests/resumableUploadPostgres.test.js` on a migrated clone → 66/66 group as at `e5bea949`.

- [ ] **Step 6: Build** — `npm run build` → pass; `grep -rl createImageBitmap dist/assets/*.js` → no match from `src` (vault preview worker may legitimately match — confirm the match is `vaultPreview*` only); restore `dist/`.

- [ ] **Step 7: Broad suite** — `node --test --test-concurrency=1 --test-reporter=tap "tests/**/*.test.js"` on the Linux clone → expected `fail 1` = `PS6-ENV-4` at `tests/publicShareStageBCredentialPlumbing.test.js:233:1` with the identical assertion signature; any other failure = `NEW_FAILURE_COUNT > 0` = STOP.

- [ ] **Step 8: Audit baseline** — `npm audit --json` → total 8 / moderate 5 / high 3 / critical 0 (sharp must not add advisories; otherwise STOP and review).

- [ ] **Step 9: Hygiene** — `git diff --check origin/main...HEAD`; NUL scan over changed files (`node -e` byte scan); secret regex over added lines (`password|secret|token|api[_-]?key … | postgres(ql)?://[^:]+:[^@]+@ | BEGIN .* PRIVATE`); artifact regex (`node_modules|\.env$|coverage|\.tap$|\.log$|\.tmp$`); `git diff --name-only origin/main...HEAD | grep -c '^IDEA1-AEGIS_Drive_LC/dist/'` → 0; receipts added → 0.

- [ ] **Step 10: Governance** — `node scripts/validate-vault.mjs --vault Obsidian_AEGIS_Vault/AEGIS_Knowledge` (2 pre-existing canvas warnings only); `node --test tests/collaborationPolicy.test.mjs tests/vaultStructure.test.mjs tests/vaultMultiWriter.test.mjs` → 50/50; `node scripts/validate-collaboration-policy.mjs --event <pull_request-shaped json from gh pr view --json body,isDraft,headRefName,baseRefName,number> --changed-files <git diff --name-status origin/main...HEAD>` → "Collaboration policy passed." with `docker-compose.yml` and `.env.example` listed under Shared Surfaces.

- [ ] **Step 11: PR body update (status-only)** — Verification block with every count above, capability evidence, image delta, `MEDIA_SKIP`, `PR150_POSTGRES_SKIP`, `NEW_FAILURE_COUNT`, large-source diagnostics; Source Files Changed extended with the file map; no receipt; `DO_NOT_MERGE=TRUE`.

- [ ] **Step 12: `git diff --check`** → clean; worktree clean.

- [ ] **Step 13: Commit** → `docs(idea1): record media pipeline verification evidence` (only if a tracked doc changed; the PR body itself is not a commit).

---

### Task 18: Exact-SHA review hand-off (future gates — not executed under this plan)

**Files:** none changed by this task.

**Interfaces:**
- Consumes: the frozen implementation SHA from Task 17.
- Produces: the ordered list of separately authorized gates.

- [ ] **Step 1: Freeze** — record `IMPLEMENTATION_SHA=<sha>` in the PR body; no further source commits without a new review round.
- [ ] **Step 2: Independent source review** (`CHATGPT_REVIEW_PR150_MEDIA_PREVIEW_IMPLEMENTATION`) against the spec's §29 checklist and this plan's task contracts.
- [ ] **Step 3: Exact-SHA Linux/PostgreSQL verifier** (read-only; the Task 17 command set re-run by a verifier on the exact SHA; `MEDIA_SKIP=0`, `PR150_POSTGRES_SKIP=0`, `NEW_FAILURE_COUNT=0`).
- [ ] **Step 4: Main drift reconciliation** if `origin/main` advanced (normal `--no-ff` merge, IDEA1 tree equivalence check, re-verify).
- [ ] **Step 5: Production candidate build/prep** — image `aegis-prod-drive:media-preview-<sha12>` built from the exact SHA; image-size delta, capability evidence, rollback tag of the running Round 10 image recorded.
- [ ] **Step 6: Production service-scoped media overlay generated on the host** at `/opt/aegis/runtime/pr150/drive-media-preview-<sha12>.yml` (spec §25.2); rendered `docker compose … config` inspected for the exact invariants list; base compose and Public Share overlays untouched.
- [ ] **Step 7: Drive-only cutover** — `up -d --no-deps --no-build drive`; post-recreate proof (mounts, `/healthz.media`, volume name, `RestartCount`).
- [ ] **Step 8: Browser acceptance** — cold cache (pending icon, no broken image), warm hard refresh (poster ≤ 1 s after list on LAN), first-hover ≤ 300 ms from prefetched proxy, mouseleave poster, reduced motion.
- [ ] **Step 9: Real 49.7 MB GIF acceptance** (mandatory) and **real 196 MB video acceptance** — network log shows derivative-sized transfers only, no `/preview` request from the grid.
- [ ] **Step 10: Cross-account cache isolation** — A views → logout → anonymous 401 → B login same browser profile → 404, DevTools shows a real network request (not "from disk cache").
- [ ] **Step 11: Resource responsiveness** — `docker stats`, `RestartCount`, child `VmHWM`, p95 before/during a 300 MB-class and a 10 GB-class job; `REGRESSION_RATIO` recorded; > 2.0 triggers review.
- [ ] **Step 12: Final docs reconciliation** — canonical `idea1-status.md`, PR body, spec status line (implementation complete), plan checkboxes.
- [ ] **Step 13: Immutable receipt** — exactly one, at closeout, per AGENTS.md.
- [ ] **Step 14: Ready / merge** — only after Steps 2–13 pass and the Human Owner authorizes.

## Plan self-review record

- Spec coverage: §6/§6.1 → Task 4; §8 → Task 5; §9 → Task 6; §10 → Tasks 1, 15; §11–§12 → Task 2; §13 → Tasks 3, 7; §14 → Tasks 8, 9; §15 → Task 11; §16 → Task 12; §17 → Tasks 7, 8, 9; §18 → Tasks 1, 5, 6; §19 → Task 7; §20 → Task 10; §21 → Task 14; §22 → Tasks 7, 8; §23–§24 → Tasks 4–13, 16, 17; §25–§26 → Tasks 15, 18; §27–§28 → Global Constraints.
- Interface consistency: every module's public interface is defined once in the file map and referenced by name in the tasks that consume it (`ServeResult`, `MediaInfo`, `ProbeResult`, `MediaJobError`, `PRIORITY`, `RunResult`, `Capabilities`, `MediaLimits`).
- Upload limits/performance: only Task 10 touches upload routes, and only after the response; `transferLimits.js` is asserted unchanged (UE-8).
- Vault: refused in service (DS-5) and routes (MR-VAULT); never scheduled (UE-6).
- No DB migration: the only store change is a SELECT-only query (Task 14).
- Production overlay: Task 18 only.
- Security/cache isolation: Task 9 is its own task with its own commit.
- First-hover race: explicit RED tests TS-5 (pure) and GI-ANIM-2 (integration).
- 49.7 MB GIF: LS-GIF-49MB fixture in Task 16 and the real-file browser acceptance in Task 18 Step 9 (mandatory).
- Large-media truthfulness: MG-WINDOW, LS-ANIM-HI/LO and LS-SPARSE-* record measurements; fixed bounds are asserted only for the proven fixture classes.
