---
title: Task Receipt — IDEA1 LFT-V2-E3.2 media cancellation and worker claim recovery
date: 2026-08-30T03:29:46+07:00
owner: kla
area: idea1
branch: fix/idea1-lft-v2-e3-2-cancel-and-claim
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA1 LFT-V2-E3.2 media cancellation and worker claim recovery

Follow-up to PR #55 (receipt
`2026-08-30_013241_kla_idea1-lft-v2-e3-1-preview-reliability.md`, not modified
here). Base `main` = `56f3a9f052e156f5b812461340208fce67295b98`.

## What changed

- **Normal media cancellation is no longer reported as failure.** A Range
  response that Chromium supersedes and cancels now emits no `onFailure`, no
  `chunk-fetch-failed` and no UI network error. Cancellation carries an explicit
  attributable kind (`preview-request-canceled` for a superseded response,
  `preview-session-invalidated` for deliberate teardown); nothing else is
  suppressed. A genuine HTTP/transport fault on a live response still emits
  `chunk-fetch-failed`, a bare `AbortError` with no cancellation context is still
  a real failure, and an integrity failure stays fatal even on a cancelled
  response.
- **In-flight chunk loads are owned by the preview session, not by one Range
  response.** The shared chunk Promise now carries the session's `AbortSignal`,
  so cancelling range A can no longer reject a load that range B is consuming.
  Request-local cancellation only stops that response from enqueuing bytes.
  `close`, Vault `lock`, `close-all` and session replacement abort every
  session-owned load, and the existing lifecycle guard still rejects any
  plaintext that arrives after those boundaries.
- **An activated worker that does not control the page recovers without a
  reload.** When `registration.active` exists and
  `navigator.serviceWorker.controller` is `null`, the page sends exactly one
  `vault-preview-claim` message; the worker calls `clients.claim()`; the page
  waits for `controllerchange` under a deadline. An already-controlled page keeps
  the fast path and sends nothing. Failure or timeout still reports
  `worker-controller-timeout` truthfully. A Vault locked while the claim is in
  flight receives no session, key or virtual URL (`vault-locked`, grouped as
  temporary, reusing existing EN/TH/ZH copy — no new user-facing string). No code
  path on this branch reloads the page.
- **A stale superseded Range can no longer global-fail the player.** Each
  response's cancellation state is request-local, so one dropped probe cannot
  mark the live preview broken.
- Unchanged: Zero-Knowledge boundary, non-extractable DEK, server never receives
  plaintext/KEK/DEK, `MAX_BUFFERED_PLAINTEXT_BYTES` = 64 MiB, the two-chunk and
  64 MiB retained-plaintext ceilings, no whole-file buffering, no Cache API, no
  IndexedDB/localStorage/sessionStorage, no CSP change, and no nginx, runtime
  compose, Postgres or IDEA2 change.

## Source files changed

- `IDEA1-AEGIS_Drive_LC/src/lib/vaultPreviewClaim.js` — **new**; the
  `vault-preview-claim` contract and its worker-side handler, extracted from the
  Service Worker so it is reachable by `node:test`.
- `IDEA1-AEGIS_Drive_LC/src/lib/vaultPreviewErrors.js` — cancellation taxonomy
  (`PREVIEW_CANCELLATION`, `markPreviewCancellation`, `previewCancellationKind`,
  `isPreviewAbortError`, `isBenignPreviewCancellation`, and the two marked abort
  reasons); adds the `vault-locked` reason to the temporary group.
- `IDEA1-AEGIS_Drive_LC/src/lib/vaultPreviewResponder.js` — `createPreviewStream`
  tracks request-local cancellation, suppresses only attributable cancellation,
  and stops enqueuing bytes for a response the browser has dropped.
- `IDEA1-AEGIS_Drive_LC/src/lib/vaultPreviewSession.js` — bounded claim-on-demand
  recovery, controller wait that ignores a null-controller `controllerchange`,
  and a live `isUnlocked` gate on the whole open path.
- `IDEA1-AEGIS_Drive_LC/src/lib/vaultPreviewWorkerState.js` — session-owned
  `AbortController` per token; loads receive the session signal; close,
  close-all and replacement abort it; lifecycle errors are marked as deliberate
  teardown.
- `IDEA1-AEGIS_Drive_LC/src/vaultPreviewServiceWorker.js` — claim message case
  and the ownership boundary that binds each ciphertext fetch to the session
  signal rather than to the triggering Range response.
- `IDEA1-AEGIS_Drive_LC/src/screens/Vault.jsx` — passes a live unlock predicate
  into `openPreviewSession`.
- `IDEA1-AEGIS_Drive_LC/tests/vaultPreviewCancellation.test.js` — **new**; 15
  regressions wiring the stream to the worker state exactly as the Service Worker
  does.
- `IDEA1-AEGIS_Drive_LC/tests/vaultPreviewClaim.test.js` — **new**; 7 claim
  handshake regressions.
- `IDEA1-AEGIS_Drive_LC/tests/vaultPreviewErrors.test.js` — cancellation
  classification and the completed reason taxonomy.
- `IDEA1-AEGIS_Drive_LC/tests/vaultPreviewSession.test.js` — claim recovery, fast
  path, timeout truthfulness, no-reload, and lock-during-recovery.
- `IDEA1-AEGIS_Drive_LC/tests/vaultPreviewWorkerState.test.js` — session signal
  lifecycle and teardown marking.

## Verification evidence

- `node --test --test-concurrency=1 tests/vaultPreviewCancellation.test.js tests/vaultPreviewClaim.test.js tests/vaultPreviewErrors.test.js tests/vaultPreviewSession.test.js tests/vaultPreviewWorkerState.test.js tests/vaultPreviewResponder.test.js tests/vaultPreviewRange.test.js tests/vaultPreviewReliability.test.js tests/vaultPreviewDiagnostics.test.js tests/vaultV2ScreenUi.test.js` — PASS: 144/144, 0 fail.
- `npm test` (full IDEA1 suite, includes all E3.1 regressions) — PASS: 747 discovered, 680 pass, 0 fail, 67 PostgreSQL-gated skips.
- `npm run build` — PASS; Vite emitted `dist/vault-preview-sw.js` at the dist root with its fixed unhashed name. The tracked `dist/` artifact was restored to its committed state afterwards, so this branch ships no rebuilt bundle.
- Pre-fix reproduction (scratch script, not committed): the E3.1 wiring — shared chunk load carrying the request's `AbortSignal` plus the unconditional `onFailure` — was replayed against the same modules. Cancelling range A produced `A failures: ['chunk-fetch-failed']` **and** `B failures: ['chunk-fetch-failed'] | B outcome: POISONED`. This is the reported production symptom, and it confirms the new regressions are not vacuous.
- Security-invariant scan of the preview path — PASS: no `localStorage`, `sessionStorage`, `indexedDB`, `caches` or `CacheStorage` usage in `src/lib/vaultPreview*.js` or `src/vaultPreviewServiceWorker.js` (only comments stating their absence); `MAX_PREVIEW_PLAINTEXT_CACHE_BYTES` still `64 * 1024 * 1024`.
- `git diff --name-only` — PASS: no CSP, nginx, docker-compose, Postgres or IDEA2 path is touched; every source path is inside `IDEA1-AEGIS_Drive_LC/`.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-status.md` — replaced the
  stale "E3.1 not deployed" limitation with the post-deploy production evidence,
  recorded the E3.2 source fix, and kept `LARGE_V2_VIDEO_PREVIEW = IN_PROGRESS`.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/concepts/Large_File_Transfer_V2.md` —
  added invariants 10–12 (cancellation is not failure; session-owned in-flight
  loads; claim recovery without reload), section 13.8, and the refreshed
  `LARGE_V2_VIDEO_PREVIEW` table row.

## Shared surfaces touched

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/concepts/Large_File_Transfer_V2.md` —
  cross-scope transfer architecture note; the E3.2 cancellation, load-ownership
  and controller-recovery contracts require integration-owner review, as for E3.1.

## Integration requests

- Kla integration owner: confirm the shared LFT-V2 concept still states the
  Zero-Knowledge boundary, the non-extractable DEK, the unraised 64 MiB buffered
  ceiling and two-chunk/64 MiB retained ceilings, the absence of Cache API,
  IndexedDB and web storage, Edge/Chrome-on-Windows primary acceptance, and
  source-only status — and specifically that invariant 10 ("cancellation is not
  failure") cannot be read as permission to suppress integrity failures. No
  migration, rollout or rollback is required; reverting this PR restores the E3.1
  behaviour with no data or schema effect.

## Known limitations

- `E3_2_PRODUCTION_ACCEPTANCE = NOT RUN`. Nothing on this branch was deployed and
  no real browser ran it. `LARGE_V2_VIDEO_PREVIEW` stays `IN_PROGRESS` until the
  existing ~1.1 GB MP4 passes on Windows Edge/Chrome for first frame, sustained
  play, middle/end seeks, close/reopen, worker restart and lock invalidation —
  and specifically until the "Video data could not be retrieved from the server"
  message is confirmed gone during normal probing.
- The claim-recovery path is proven against a simulated container, not a real
  Chromium lifecycle. Whether Chromium always fires `controllerchange` after a
  message-driven `clients.claim()` on an already-open page is an assumption this
  branch cannot verify without a browser; if it does not, the result is the same
  truthful `worker-controller-timeout` as before, never a reload loop.
- A bounded chunk load may still complete after its triggering range is
  cancelled, by design, while the Vault is unlocked and the session is open. That
  work is bounded by the two-chunk and 64 MiB ceilings; it is not free.
- Retained plaintext is capped at 64 MiB and decrypt admission at two concurrent
  loads, but ciphertext and browser-owned response buffers still coexist, so that
  ceiling is not the whole transient process-memory peak. It remains independent
  of total file size.
- PostgreSQL-gated tests stayed skipped (`TEST_DATABASE_URL` unset); this change
  has no database or server persistence contract.
- Firefox is secondary compatibility and Safari/WebKit acceptance remains
  deferred, unchanged from E3.1.
