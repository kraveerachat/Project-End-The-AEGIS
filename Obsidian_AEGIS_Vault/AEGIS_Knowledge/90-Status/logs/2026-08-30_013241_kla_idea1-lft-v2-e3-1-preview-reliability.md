---
title: Task Receipt — IDEA1 LFT-V2-E3.1 preview reliability
date: 2026-08-30T01:32:41+07:00
owner: kla
area: idea1
branch: fix/idea1-lft-v2-e3-1-preview-reliability
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA1 LFT-V2-E3.1 preview reliability

## What changed

- Bounded `Range: bytes=X-` responses to a 16 MiB 206 window, so logical files
  from 100 MiB through 32 GiB do not produce a whole-file decrypt plan.
- Added one-shot Service Worker session rehydration from an unlocked page's
  in-memory, non-extractable DEK. Close, replacement, Vault lock and component
  teardown remove recovery; a lock racing a decrypt prevents late plaintext.
- Added a token+chunk scoped, memory-only LRU with at most two entries and a hard
  64 MiB resolved-plaintext ceiling. Integrity failures are never cached.
- Added explicit failure reasons and truthful EN/TH/ZH UI groups for unsupported,
  temporary worker/session, network, integrity and playback failures.
- Added opt-in diagnostics that allowlist only ranges, chunk counts, timings,
  cache/rehydration counts and failure categories. Tokens, keys, plaintext,
  filenames, credentials and headers are not accepted by the logger.
- Preserved the existing buffered path for videos at or below 64 MiB. No server
  route, schema, CSP, gateway, nginx, compose, storage mount or production runtime
  changed. No deployment or real-browser acceptance occurred.

## Source files changed

- `IDEA1-AEGIS_Drive_LC/src/lib/strings.js` — truthful EN/TH/ZH preview failures.
- `IDEA1-AEGIS_Drive_LC/src/lib/vaultPreviewDiagnostics.js` — safe opt-in metrics.
- `IDEA1-AEGIS_Drive_LC/src/lib/vaultPreviewErrors.js` — explicit failure contract.
- `IDEA1-AEGIS_Drive_LC/src/lib/vaultPreviewRange.js` — 16 MiB open-range window marker.
- `IDEA1-AEGIS_Drive_LC/src/lib/vaultPreviewResponder.js` — bounded 206 planning and instrumentation hooks.
- `IDEA1-AEGIS_Drive_LC/src/lib/vaultPreviewSession.js` — classified startup plus page-memory recovery registry.
- `IDEA1-AEGIS_Drive_LC/src/lib/vaultPreviewWorkerState.js` — ephemeral session recovery and bounded plaintext LRU.
- `IDEA1-AEGIS_Drive_LC/src/screens/Vault.jsx` — recovery listener and truthful error rendering.
- `IDEA1-AEGIS_Drive_LC/src/vaultPreviewServiceWorker.js` — recovery/cache/diagnostic wiring.
- `IDEA1-AEGIS_Drive_LC/tests/vaultPreviewDiagnostics.test.js` — disabled-default and secret filtering.
- `IDEA1-AEGIS_Drive_LC/tests/vaultPreviewErrors.test.js` — complete reason taxonomy/grouping.
- `IDEA1-AEGIS_Drive_LC/tests/vaultPreviewRange.test.js` — open-ended marker/window contract.
- `IDEA1-AEGIS_Drive_LC/tests/vaultPreviewReliability.test.js` — fake 100 MiB–32 GiB range plans.
- `IDEA1-AEGIS_Drive_LC/tests/vaultPreviewSession.test.js` — startup classification and page recovery.
- `IDEA1-AEGIS_Drive_LC/tests/vaultPreviewWorkerState.test.js` — LRU, byte ceiling, recovery, restart and lock races.
- `IDEA1-AEGIS_Drive_LC/tests/vaultV2ScreenUi.test.js` — error groups, page rehydration and small-video preservation.

## Verification evidence

- `node --test --test-concurrency=1 tests/vaultPreviewReliability.test.js tests/vaultPreviewWorkerState.test.js tests/vaultPreviewErrors.test.js tests/vaultPreviewDiagnostics.test.js tests/vaultV2ScreenUi.test.js` — EXPECTED FAIL: 0 pass / 5 module-contract failures before implementation.
- `node --test --test-concurrency=1 tests/vaultPreviewRange.test.js tests/vaultPreviewReliability.test.js tests/vaultPreviewResponder.test.js tests/vaultPreviewSession.test.js tests/vaultPreviewWorkerState.test.js tests/vaultPreviewErrors.test.js tests/vaultPreviewDiagnostics.test.js tests/vaultV2ScreenUi.test.js` — PASS: 105/105.
- `node --test --test-concurrency=1 tests/contentSecurityPolicy.test.js tests/vaultCrypto.test.js tests/vaultChunkCrypto.test.js tests/vaultChunkedDownloadClient.test.js tests/vaultChunkedUploadClient.test.js tests/vaultMediaPreview.test.js` — PASS: 117/117.
- `npm test` — PASS: 708 discovered, 641 pass, 0 fail, 67 PostgreSQL-gated skips.
- `npm run build` — PASS; Vite transformed 2,671 modules and emitted `dist/vault-preview-sw.js`. The tracked `dist/` artifact was restored to its committed state afterwards, so this branch ships no rebuilt bundle.
- `node scripts/validate-vault.mjs --vault Obsidian_AEGIS_Vault/AEGIS_Knowledge` — PASS with the two existing owner-data review warnings.
- `node --test tests/vaultStructure.test.mjs tests/vaultMultiWriter.test.mjs tests/collaborationPolicy.test.mjs` — PASS: 43/43.
- `node scripts/validate-collaboration-policy.mjs --event .codex-pr-event.json --changed-files .codex-changed-files.txt` — PASS against the intended PR body and all 19 changed paths.
- `node .agents/skills/impeccable/scripts/detect.mjs --json IDEA1-AEGIS_Drive_LC/src/screens/Vault.jsx IDEA1-AEGIS_Drive_LC/src/lib/strings.js` — PASS: no deterministic UI/design findings.
- `git diff --cached --check` and targeted staged secret/artifact plus preview-persistence API scans — PASS.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-status.md` — production failure evidence plus local E3.1 source status; `LARGE_V2_VIDEO_PREVIEW = IN_PROGRESS`.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/concepts/Large_File_Transfer_V2.md` — durable E3.1 range, recovery, cache, browser-scope and acceptance contract.

## Shared surfaces touched

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/concepts/Large_File_Transfer_V2.md` — cross-scope transfer architecture note requires integration-owner review for the E3.1 contract.

## Integration requests

- Kla integration owner: confirm the shared LFT-V2 concept accurately preserves
  Zero-Knowledge, the 64 MiB buffered ceiling, Edge/Chrome primary acceptance,
  Firefox secondary compatibility, Safari deferral, and source-only status.

## Known limitations

- `LARGE_V2_VIDEO_PREVIEW = IN_PROGRESS`; this branch is not deployed and does not
  prove the existing ~1.1 GB MP4 plays or seeks reliably in production.
- Edge/Chrome production acceptance is pending. Firefox manual acceptance is
  desirable but non-blocking. Safari/WebKit production acceptance is deferred.
- PostgreSQL-gated tests remained skipped because `TEST_DATABASE_URL` was not set;
  this change has no database or server persistence contract.
- The cache's retained resolved plaintext is capped at 64 MiB and decrypt admission
  is limited to two concurrent loads. Ciphertext and browser-owned response buffers
  may still coexist, so the retained-cache ceiling is not the entire transient
  process-memory peak; it remains independent of total file size.
- No production deployment, nginx/runtime compose change or Formal Report change.
