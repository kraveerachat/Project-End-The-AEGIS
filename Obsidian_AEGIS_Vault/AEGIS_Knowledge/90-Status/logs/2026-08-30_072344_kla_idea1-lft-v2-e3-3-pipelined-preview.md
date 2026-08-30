---
title: Task Receipt — IDEA1 LFT-V2-E3.3 demand-priority pipelined preview
date: 2026-08-30T07:23:44+07:00
owner: kla
area: idea1
branch: fix/idea1-lft-v2-e3-3-pipelined-preview
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA1 LFT-V2-E3.3 demand-priority pipelined preview

Base `main` = `543fb082eb717bf583ab415df2282da8f36b6c18` (merged PR #56).
The immutable E3.1/E3.2 receipts from PRs #55/#56 were read but not modified.

## What changed

- Production reaches the encrypted streaming path and renders the first frame,
  but the real ~1.1 GB/two-minute MP4 repeatedly starves: observed ~16.8 MB
  virtual responses take 3.1–3.9 seconds (~4.3–5.5 MB/s), below the source's
  approximate 9–10 MB/s consumption. This task treats the remaining defect as a
  throughput/pipelining gap, not browser capability, Service Worker control,
  Range mapping, key recovery or adaptive-quality work.
- Each demanded chunk N now starts before bounded valid look-ahead N+1/N+2. A
  two-slot priority scheduler promotes demanded adjacent chunks, discards stale
  speculative work on a distant seek, never walks the file and never prefetches
  beyond `blob.chunkCount`.
- Cache capacity and concurrency are separate: at most three resolved plaintext
  entries, at most two active ciphertext-fetch/decrypt jobs, and at most 64 MiB
  retained plaintext. The byte ceiling is authoritative: three 16 MiB chunks use
  ~48 MiB, while three 32 MiB chunks reduce to two retained entries.
- Prefetch transport failure is fail-soft and not cached; later demand retries
  and reports a real network failure if it still fails. A prefetched AES-GCM
  integrity failure is retained only as a failure marker and becomes fatal when
  relevant; unauthenticated plaintext is never cached.
- Close, Vault lock, close-all and replacement abort or invalidate prefetch and
  prevent late plaintext delivery. E3.2's normal Range-cancellation and shared
  session-load behavior remains green.
- Opt-in secret-safe diagnostics now distinguish ciphertext fetch, decrypt,
  queue wait, cache/prefetch hit and miss, active load count, demand/prefetch
  chunk indexes, delivered plaintext bytes and effective plaintext MB/s.
- Unchanged: 16 MiB bounded virtual Range window, Zero-Knowledge boundary,
  non-extractable DEK, no persistent key/plaintext storage, no Cache API, no
  IndexedDB/localStorage/sessionStorage, no plaintext server route, no server
  transcoding, no CSP change, and no runtime/deployment/database change.

## Source files changed

- `IDEA1-AEGIS_Drive_LC/src/lib/vaultPreviewDiagnostics.js` — extends the
  opt-in numeric allowlist with queue, prefetch, concurrency and effective
  plaintext-throughput metrics while continuing to reject secret fields.
- `IDEA1-AEGIS_Drive_LC/src/lib/vaultPreviewResponder.js` — records decrypted
  plaintext byte counts and effective response MB/s without changing the bounded
  Range contract or fail-closed stream behavior.
- `IDEA1-AEGIS_Drive_LC/src/lib/vaultPreviewWorkerState.js` — separates the
  three-entry cache from the two-load scheduler, adds demand-priority N+1/N+2
  prefetch, stale-prefetch abort, failure semantics, lifecycle isolation and the
  authoritative 64 MiB retained-plaintext cap.
- `IDEA1-AEGIS_Drive_LC/src/vaultPreviewServiceWorker.js` — wires the bounded
  look-ahead and allowlisted scheduler diagnostics into the existing virtual
  preview response path.
- `IDEA1-AEGIS_Drive_LC/tests/vaultPreviewPipeline.test.js` — **new**; 15
  scheduler/prefetch tests covering demand order, adjacent promotion, distant
  seek, concurrency, cache bytes, failure truthfulness, lifecycle and logical
  1.1 GiB/5 GiB/32 GiB fixtures.
- `IDEA1-AEGIS_Drive_LC/tests/vaultPreviewCancellation.test.js` — updates the
  E3.2 shared-load assertion to distinguish an in-flight Promise from resolved
  retained plaintext while preserving the no-refetch regression.
- `IDEA1-AEGIS_Drive_LC/tests/vaultPreviewDiagnostics.test.js` — pins every new
  allowlisted metric and confirms secret-shaped fields remain excluded.
- `IDEA1-AEGIS_Drive_LC/tests/vaultPreviewResponder.test.js` — pins delivered
  plaintext throughput derived from literal bytes and elapsed time.
- `IDEA1-AEGIS_Drive_LC/tests/vaultPreviewWorkerState.test.js` — adopts separate
  cache/concurrency options while retaining E3.1/E3.2 cache and lifecycle tests.

## Verification evidence

- RED: `node --test tests/vaultPreviewPipeline.test.js` — expected fail before
  implementation: missing `MAX_PREVIEW_CACHED_CHUNKS` export.
- RED: pipeline replacement regression — expected fail before lifecycle-map fix:
  a replacement reused an old in-flight Promise (`newLoads = 0`).
- RED: lazy stale-Range regression — expected fail before response/session
  binding: an old response admitted its loader after replacement. The fix
  rejects it before loading or caching plaintext under the new session.
- `node --test --test-concurrency=1 tests/vaultPreviewPipeline.test.js tests/vaultPreviewWorkerState.test.js tests/vaultPreviewCancellation.test.js tests/vaultPreviewDiagnostics.test.js tests/vaultPreviewResponder.test.js tests/vaultPreviewSession.test.js tests/vaultPreviewReliability.test.js tests/vaultPreviewRange.test.js tests/vaultPreviewErrors.test.js tests/vaultPreviewClaim.test.js tests/vaultMediaPreview.test.js tests/vaultV2ScreenUi.test.js` — PASS: 186/186, 0 fail.
- `npm test` — PASS: 763 discovered, 696 pass, 0 fail, 67
  PostgreSQL-gated skips (`TEST_DATABASE_URL` unset). Skipped tests are not
  described as passed; this change has no database/storage/server contract.
- `npm run build` — PASS: Vite emitted fixed root artifact
  `dist/vault-preview-sw.js`; build output remains ignored and uncommitted.
- Security-invariant scan of the changed preview source — PASS: no executable
  Cache API, IndexedDB, local/session storage, persistent key/plaintext storage,
  plaintext endpoint or CSP change; secret-safe diagnostics tests pass.
- `node scripts/validate-vault.mjs --vault Obsidian_AEGIS_Vault/AEGIS_Knowledge`
  — PASS with the two pre-existing owner-review canvas warnings.
- `node --test tests/vaultStructure.test.mjs tests/vaultMultiWriter.test.mjs tests/collaborationPolicy.test.mjs`
  — PASS: 43/43 (vault structure/multi-writer 25/25; collaboration policy 18/18).
- `node scripts/validate-collaboration-policy.mjs --event <local-E3.3-event> --changed-files <local-E3.3-path-list>`
  — PASS against the actual 12-path PR scope, `area: idea1`, `owner: kla`,
  `integration-review: yes`, the receipt and the shared concept declaration.
- `git diff --check` — PASS after restoring the build-generated tracked
  `dist/index.html` byte-for-byte to HEAD; no `dist/` path is included.
- Targeted high-confidence secret scan over introduced lines — PASS: zero
  private-key blocks, credentialed URLs, provider token shapes or access-key
  shapes. Test-only secret strings exist solely to prove diagnostic filtering.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-status.md` — records the
  production throughput evidence and E3.3 source implementation while keeping
  `LARGE_V2_VIDEO_PREVIEW = IN_PROGRESS`, not deployed and not browser-accepted.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/concepts/Large_File_Transfer_V2.md` —
  updates the current cache/scheduler invariants and adds E3.3's bounded
  demand-priority pipeline, failure and diagnostic contracts.

## Shared surfaces touched

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/concepts/Large_File_Transfer_V2.md` —
  cross-scope transfer architecture note; the new demand-priority scheduling,
  three-entry/64 MiB cache and fail-soft/fatal prefetch contracts require
  integration-owner review.

## Integration requests

- Kla integration owner: confirm that the shared LFT-V2 concept states the exact
  two-load/three-entry/64 MiB model with the byte ceiling authoritative, that
  stale prefetch—not shared demand—is what seek preemption may abort, that
  transport prefetch failure is fail-soft while integrity remains fatal once
  relevant, and that no production playback success is claimed. Rollout is a
  Drive source rebuild/redeployment followed by Windows Edge/Chrome acceptance;
  rollback is the application image/commit only, with no schema or data action.

## Known limitations

- `E3_3_PRODUCTION_ACCEPTANCE = NOT RUN`. Nothing on this branch was deployed and
  no real browser playback test ran. `LARGE_V2_VIDEO_PREVIEW` remains
  `IN_PROGRESS` until the real ~1.1 GB MP4 sustains playback and middle/end seeks
  after merge and Drive redeployment on Windows Edge/Chrome.
- The implementation removes sequential idle time but does not prove the
  production path can reach the required ~9–10 MB/s. Diagnostics are intended to
  separate network/server-disk, WebCrypto and scheduler time during acceptance.
- The 64 MiB ceiling covers retained resolved plaintext, not transient
  ciphertext, decrypt buffers or browser-owned response buffers. Peak transient
  memory remains O(chunk × two active loads), independent of total file size.
- Existing source defaults use 32 MiB plaintext Vault chunks, so the byte ceiling
  allows two resolved entries there; deployments using 16 MiB chunks can retain
  the target three (~48 MiB). The code does not claim a fixed runtime chunk size.
- Firefox remains secondary compatibility and Safari/WebKit acceptance remains
  deferred. No HLS/DASH, adaptive quality or server-side transcoding was added.
- PostgreSQL-gated tests remain skipped honestly; no PostgreSQL path changed.
