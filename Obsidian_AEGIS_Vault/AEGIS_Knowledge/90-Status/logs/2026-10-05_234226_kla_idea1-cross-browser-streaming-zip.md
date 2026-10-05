---
title: Task Receipt — IDEA1 cross-browser large ZIP streaming fallback
date: 2026-10-05T23:42:26+07:00
owner: kla
area: idea1
branch: feat/idea1-cross-browser-streaming-zip
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA1 cross-browser large ZIP streaming fallback

## What changed

- Root cause: Brave on Windows is a secure context without `window.showSaveFilePicker`, so 4+ files entered the existing no-FSA path: archive > 64 MiB → Files per-file fallback ("This browser can't save large archives…"), Vault refusal. The ZIP core was correct.
- New capability-detected transport `worker-stream` (no user-agent detection): no FSA + secure context + Service Worker + streams + MessageChannel → ONE streaming ZIP through the EXISTING same-origin `/drive/` worker (`vault-preview-sw.js`), for archives of any size. Transport order: `fsa` (unchanged) → `worker-stream` → `buffered` (unchanged).
- Protocol: ephemeral CSPRNG token + MessagePort; a hidden same-origin iframe navigates to `<scope>__aegis-download/<token>`; the worker answers once with a ReadableStream (`application/zip`, attachment with sanitised filename, `Cache-Control: no-store`, `nosniff`, exact `Content-Length`). Credit backpressure bounds the worker queue to highWater 4 MiB + window 2 MiB (a producer ignoring credit is cut off). Close only at the declared length; page abort, signal abort, Vault lock (`vault-preview-close-all` also ends Vault download sessions), browser cancel, worker restart (keepalive), expiry and protocol violations error the stream and delete the session. Memory only — no Cache API, IndexedDB or browser storage.
- `runBulkZip` keeps its safety order (preflight before destination, first write error retained, abort once, no later entry after failure, done only after close). On worker-stream it never calls `showSaveFilePicker`, never builds a Blob, never calls `finalizeBufferedZip`. If the worker cannot be opened before any byte is written: ≤ 64 MiB → existing buffered path; Files > 64 MiB → existing per-file path with the existing notice; Vault > 64 MiB → failed `stream-unavailable`.
- Unchanged: `MAX_BUFFERED_PLAINTEXT_BYTES = 64 MiB`, `BULK_ZIP_ENABLED = true`, `ZIP_THRESHOLD = 4`, `zipStreamWriter` / ZIP64, sources, V1 refusal, Vault plaintext warning first, FSA path.
- Production: **NOT TOUCHED** (Production still runs release `3895ac0e`).

## Source files changed

- `IDEA1-AEGIS_Drive_LC/src/lib/downloadStreamWorkerState.js` — new: worker-side session state, exact-path matcher, headers, backpressure, message/fetch handlers.
- `IDEA1-AEGIS_Drive_LC/src/lib/downloadStreamSession.js` — new: capability check, hidden-frame trigger, page-side sink (write/close/abort, credit, keepalive).
- `IDEA1-AEGIS_Drive_LC/src/vaultPreviewServiceWorker.js` — thin wiring of the download protocol; Vault close-all also ends Vault downloads.
- `IDEA1-AEGIS_Drive_LC/src/lib/bulkDownloadPlan.js` — `workerStream` capability → `transport: 'worker-stream'`.
- `IDEA1-AEGIS_Drive_LC/src/lib/bulkZipDownload.js` — worker-stream destination + run-time fallback.
- `IDEA1-AEGIS_Drive_LC/src/screens/Files.jsx` — passes capability; `stream-unavailable` → existing per-file fallback.
- `IDEA1-AEGIS_Drive_LC/src/screens/VaultTreeScreen.jsx` — passes capability.
- Tests: new `tests/bulkDownloadPlanWorkerStream.test.js`, `tests/downloadStreamWorker.test.js`, `tests/bulkZipWorkerStream.test.js`, `tests/downloadStreamSourceGuard.test.js`; extended `tests/filesBulkZip.test.js`, `tests/vaultTreeBulkZip.test.js`.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-status.md` — canonical note.

## Verification evidence

- RED first: plan tests 2/8 failed before the plan change; protocol/orchestrator suites failed on missing modules; `FZ-WS-1/2` and `VZS-WS-1/2` failed against the base `Files.jsx` / `VaultTreeScreen.jsx` — then GREEN.
- `node --test tests/bulkDownloadPlanWorkerStream.test.js tests/downloadStreamWorker.test.js tests/bulkZipWorkerStream.test.js tests/downloadStreamSourceGuard.test.js` — pass 8 + 24 + 11 + 6.
- Focused regression `node --test --test-concurrency=1 tests/bulk*.test.js tests/vaultTreeBulkZip*.test.js tests/zipStreamWriter.test.js tests/zipAcceptanceTooling.test.js tests/vaultPreviewSession.test.js tests/vaultStorageAbsence.test.js tests/vaultTreeSourceScan.test.js tests/download*.test.js` — pass 214/214; `tests/filesBulkZip.test.js` 11/11; `VZS-WS-1/2` pass.
- Full suite `node --test --test-reporter=tap --test-concurrency=1 "tests/**/*.test.js"` — 3145 tests: 2809 pass, 103 fail, 233 skip. The 17 failing files re-run at baseline `origin/main` `b412918f`: the same 103 failing test names, 0 new, 0 fixed (known legacy-FLAT Vault, i18nCopyAudit, publicShareStageB PS6-ENV, mediaPoster `sharp`, Neo token/layout suites).
- `npx vite build --outDir <scratch>` — pass; output has `vault-preview-sw.js`, the `bulkZipDownload` chunk and the protocol chunk imported by the worker (no `window`/`document`/storage use other than the pre-existing hash-wasm global probe); tracked `dist/` untouched.
- Source scans (`tests/downloadStreamSourceGuard.test.js`): no Cache API / IndexedDB / local/session storage / console / Blob in the new path; exactly one `serviceWorker.register`; constants 64 MiB / true / 4 unchanged. `git diff --check` — clean.
- Local acceptance (agent-driven with Playwright on real installed browsers; local non-Production: PG 15 container + IDEA1 server + `vite preview` of the production build; 4 fixtures 100.0 MiB):
  - Brave 1.96.61 (Chromium 154): `isSecureContext=true`, `showSaveFilePicker=undefined`. 4 files → ONE download `AEGIS-Files-*.zip`, 104,859,220 bytes, from `/drive/__aegis-download/<token>`; progress panel visible file 1→4 with byte counts; one SW registration (`/drive/`). Python `zipfile.testzip()` OK, all 4 SHA-256 match; Windows Explorer shell (Shell.Application) lists the 4 entries; extracted `ws-delta.bin` SHA-256 matches. **PASS**.
  - Brave cancel at ~17 %: browser download result `canceled`, no file saved, panel cleared (not done, not success). **PASS**.
  - Chrome 154.0.8037.95: `showSaveFilePicker=function`; Download reached the native Save picker (no iframe, no worker download). Completing the native dialog was not done by the agent → Chrome real-browser FSA **PARTIAL**; FSA regression is otherwise proven by `ORCH-WS-11` and the unchanged `filesBulkZip`/`bulkZip*` suites.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-status.md` — new Current Task `IDEA1-ZIP-NO-FSA-STREAM`; previous task closed and its stale "`main` keeps false until #354 merges" replaced (#354 merged; Production runs `3895ac0e`).

## Shared surfaces touched

- None — task stayed inside its selected area

## Integration requests

- None — valid only when no cross-scope/shared path changed

## Known limitations

- Vault worker-stream not run in a real browser (local Vault tree requires its migrations/protocol); covered by jsdom UI tests and real-WebCrypto orchestrator tests only.
- Edge and Opera: share the native FSA capability path and are expected to use it when present — **NOT HUMAN VERIFIED, not run**. Firefox/macOS not run.
- All browser results are agent-driven, not human-verified; Owner retest requested (Brave > 64 MiB + cancel; Chrome FSA 4+).
- After the worker closes the stream, the browser still writes the last ≤ 6 MiB; a disk error at that point is reported by the browser's download UI, not by the app.
- If the worker is unavailable at run time, the Files per-file fallback runs after the click (outside the user gesture), so Chromium may ask to allow multiple downloads.
