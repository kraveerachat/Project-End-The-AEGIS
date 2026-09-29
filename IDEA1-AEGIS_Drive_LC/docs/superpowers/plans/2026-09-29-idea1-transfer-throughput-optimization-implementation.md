# AEGIS IDEA1 Transfer Throughput Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Identify and remove the dominant application-side throughput bottlenecks for AEGIS IDEA1 upload and download while preserving security, integrity, resumability, recovery, and zero-knowledge Vault behavior across Remote/Twingate and Direct LAN.

**Architecture:** Reconcile PR216 with current `main`, then diagnose before mutating runtime behavior. Upload and download are independent gates: each may move to TDD implementation only after evidence isolates a limiting stage. Normal Files upload uses the existing resumable V2 session protocol; if request serialization is proven limiting, introduce bounded deployment-controlled concurrency modeled on the already-proven Vault 1–4 lane policy. Download changes are conditional on measured evidence and must not copy Public Share trust/security semantics into authenticated Files. Preview remains a secondary follow-up after the core transfer gate.

**Tech Stack:** React 19, Vite 7, browser XHR/fetch, Node.js/Express, Node streams, PostgreSQL/in-memory test DB, NGINX HUB reverse proxy, `node:test`, `hash-wasm`, WebCrypto AES-GCM for Vault.

**Spec:** `IDEA1-AEGIS_Drive_LC/docs/superpowers/specs/2026-09-29-idea1-transfer-throughput-optimization-design.md`

## Global Constraints

- Human Owner is the only Production mutation and final-merge authority.
- No agent SSH/deploy, no Production Compose mutation, no broad Docker recreate/prune, no destructive rollback.
- No rebase, force push, reset/history rewrite.
- Root cause must be investigated before each optimization; no speculative multi-variable tuning.
- TDD is mandatory for each runtime behavior change: RED first, then minimal GREEN.
- Performance policy is shared platform behavior: no username/user-ID/role-specific fast path. Admin, current users, and future users use the same implementation.
- Preserve authentication, owner isolation, CSRF, resumable missing-chunk semantics, refresh recovery, cancellation, retry, server-side integrity verification, and storage correctness.
- Preserve Vault zero-knowledge and AES-GCM invariants; no server-side plaintext Vault derivative or plaintext fallback.
- Keep memory/request/file-descriptor growth bounded. Never introduce unbounded concurrency.
- Do not increase the 5 GiB deployment logical file-size limit as part of throughput optimization; throughput and logical-size ceilings remain separate controls.
- Existing PRE-FIX evidence remains immutable: P1/P2/C1 raw runs and historical labels are not rewritten.
- Core upload/download work takes priority. Preview optimization must not delay the core POST-FIX transfer gate.

## Review Focus

1. Out-of-order Normal Files chunk completions must not corrupt session state, progress, checkpoint state, or final bytes.
2. Retry/failure of one concurrent chunk must not duplicate a successful index or incorrectly discard other acknowledged chunks.
3. Abort, refresh/unmount, and explicit Cancel must retain their current distinct semantics with multiple in-flight requests.
4. Concurrent authorized transfers from different accounts must never mix sessions, bytes, progress, or recovery records; Admin receives no cross-owner override.
5. Any selected concurrency/resource setting must remain bounded and must not trade benchmark speed for memory explosion, excessive open requests, integrity weakening, or LAN regression.

---

### Task 0: Reconcile PR216 with current main before source work

**Files:**
- Existing PR216 branch: `docs/idea1-transfer-media-performance-study`
- Expected conflict surface: performance docs and `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-status.md`

**Interfaces:**
- Consumes: current `origin/main` after PR243 merge or any newer legitimate main commit.
- Produces: clean PR216 branch containing current main plus the approved optimization spec and this plan.

- [ ] **Step 1: Establish repository truth**

Fetch and report local HEAD, remote PR216 HEAD, `origin/main`, merge-base, worktree state, PR base, and whether current main contains PR220/PR241/PR243 merge commits.

- [ ] **Step 2: Merge current `origin/main` into PR216 normally**

Use a normal merge only. No rebase/force. Resolve documentation conflicts by preserving current-main completed-task chronology plus PR216 as the active performance task.

- [ ] **Step 3: Fail closed on application conflicts**

If reconciliation produces a non-trivial application/runtime/config conflict, stop and report it before choosing behavior. Do not silently resolve source conflicts.

- [ ] **Step 4: Verify reconciliation**

Run `git diff --check`, collaboration/governance checks relevant to docs, vault validation, and confirm no PR216 runtime behavior changed merely by reconciliation.

- [ ] **Step 5: Commit/push reconciliation normally**

Keep PR216 Draft. Do not mark Ready or merge.

---

### Task 1: Produce a root-cause diagnosis gate for core transfer paths

**Files:**
- Modify: `IDEA1-AEGIS_Drive_LC/docs/superpowers/specs/2026-09-25-idea1-transfer-media-performance-study-design.md`
- Modify: `IDEA1-AEGIS_Drive_LC/docs/superpowers/plans/2026-09-25-idea1-transfer-media-performance-measurement-plan.md`
- Modify only if useful for reusable non-Production analysis: `IDEA1-AEGIS_Drive_LC/scripts/diagnose-transfer-path.mjs`
- No application source mutation in this task.

**Interfaces:**
- Consumes: accepted 45-run PRE-FIX matrix, current source/config, historical parallel-transfer evidence, and current main.
- Produces: explicit `UPLOAD_ROOT_CAUSE_CLASSIFICATION` and `DOWNLOAD_ROOT_CAUSE_CLASSIFICATION`, each either `PROVEN_*` or `NOT_PROVEN`, plus the smallest missing Human-run probe if unresolved.

- [ ] **Step 1: Trace the Normal Files upload path end-to-end**

Account separately for browser hashing, session POST, each chunk PUT, retry/backoff, server streamed write/hash, DB acknowledgement, commit full-file SHA, and publish. Record architecture facts with exact source paths/SHA.

- [ ] **Step 2: Quantify the serialization hypothesis without changing runtime behavior**

Use the recorded 16 MiB chunk size and per-run/request timing evidence to compute how much elapsed time can be explained by request serialization/idle gaps versus payload-transfer time. Historical parallel-transfer results are supporting context only, not current proof.

- [ ] **Step 3: Trace the authenticated download path end-to-end**

Compare Drive `openReadStream(...).pipe(res)` with HUB route policy, which already has `proxy_buffering off`, and with the Public Share architecture. Separate TTFB-only costs from sustained-body throughput costs.

- [ ] **Step 4: Classify evidence, not guesses**

At minimum distinguish: client hash/crypto, request serialization/single-stream transport, server CPU/event loop, storage I/O, DB metadata acknowledgement, NGINX/HUB proxy behavior, and Twingate/network path.

- [ ] **Step 5: If existing evidence is insufficient, prepare one minimal Human probe per unresolved path**

Do not ask for the full 36-run POST matrix yet. Prepare only a read-only/controlled diagnostic that can distinguish the top competing hypotheses. Human Owner executes any Production/network probe.

- [ ] **Step 6: Gate implementation**

Normal Files upload may advance to Task 2 only when the report identifies a proven or experimentally isolated application-side limiter. Download may advance to Task 5 only when its own limiter is isolated. One path may proceed while the other remains `NOT_PROVEN`.

---

### Task 2: Add bounded Normal Files upload concurrency only if diagnosis proves it useful

**Status: SKIPPED / NOT JUSTIFIED BY U1+U2**

- Probe U1 (P2 Remote Twingate): `U1_R = 1.1581054`. Dual upload concurrency yielded only ~15.8% aggregate throughput gain while dropping per-file throughput by ~42% (~3.0 MB/s -> ~1.74 MB/s).
- Probe U2 (P1 Direct LAN): `U2_R = 0.944 <= 1.15`. Dual upload concurrency on LAN produced slightly lower aggregate throughput (~10.10 MB/s vs ~10.69 MB/s) while cutting per-file throughput roughly in half (~5.05 MB/s).
- Decision rule evaluation: `R <= 1.15` establishes `PROVEN_SHARED_PATH_CAPACITY_LIMITER on P1`.
- Conclusion: Client-side Normal Files chunk concurrency is disproven as an effective throughput lever. Entering Task 2 is not justified. Application runtime code is intentionally NOT modified (`TASK2_UPLOAD_CONCURRENCY_ENTERED=NO`, `UPLOAD_OPTIMIZATION=NO_SAFE_APP_FIX_PROVEN_AT_CURRENT_GATE`).

**Files:**
- Modify: `IDEA1-AEGIS_Drive_LC/server/config/transferLimits.js` (SKIPPED)
- Modify: `IDEA1-AEGIS_Drive_LC/server/routes/uploads.js` (SKIPPED)
- Modify: `IDEA1-AEGIS_Drive_LC/src/lib/chunkedUpload.js` (SKIPPED)
- Test: `IDEA1-AEGIS_Drive_LC/tests/transferLimitsConfig.test.js` (SKIPPED)
- Test: `IDEA1-AEGIS_Drive_LC/tests/chunkedUploadClient.test.js` (SKIPPED)
- Test: `IDEA1-AEGIS_Drive_LC/tests/resumableUpload.test.js` (SKIPPED)

**Interfaces:**
- Consumes: diagnosis from Task 1 proving that more than one in-flight chunk is justified.
- Produces: deployment-controlled `uploadConcurrency` recommendation in the existing `/api/files/uploads/limits` response and a bounded client worker pool.

If Task 1 disproves concurrency as a useful lever, skip this task and implement the proven upload limiter instead using the same RED/GREEN discipline.

- [ ] **Step 1: RED — configuration contract**

Extend `tests/transferLimitsConfig.test.js` first. Pin a supported Normal Files concurrency range of `1..4`; pin default `2`; invalid deployment values (`0`, `5`, non-integer) must fail startup/config parsing rather than clamp silently. Do not change chunk size or logical file-size defaults.

- [ ] **Step 2: Run the configuration test and verify RED**

Run the exact test file with `node --test`. Confirm failure is because Normal Files upload concurrency does not yet exist.

- [ ] **Step 3: GREEN — add deployment-controlled concurrency**

Add `UPLOAD_CONCURRENCY` parsing to `transferLimitsFromEnv()` with default `2`, min `1`, max `4`, and include it in `TRANSFER_LIMITS`. Return `uploadConcurrency` from `GET /api/files/uploads/limits`.

- [ ] **Step 4: Verify configuration GREEN**

Re-run `tests/transferLimitsConfig.test.js` and the limits-related resumable API tests.

- [ ] **Step 5: RED — bounded client worker pool**

Add focused tests to `tests/chunkedUploadClient.test.js` that assert all of the following with deterministic deferred promises: at least two chunks can be in flight when concurrency is `2`; maximum simultaneous PUTs never exceeds the selected lane count; every missing index is sent once on success; commit starts only after every lane is settled successfully.

- [ ] **Step 6: RED — out-of-order progress/state**

Add a test where chunk 1 finishes before chunk 0. Progress must equal server-confirmed completed bytes plus current per-lane loaded bytes, must never exceed total bytes, and final result must still include every exact chunk once.

- [ ] **Step 7: RED — retry isolation**

Make one lane fail transiently while another succeeds. Only the failed index is retried; a successful index is not resent; final commit succeeds after the retry.

- [ ] **Step 8: RED — cancellation/recovery**

Abort while two PUTs are in flight. Both receive the AbortSignal, no commit is issued, the function returns `cancelled`, and the durable server session remains resumable rather than being deleted implicitly.

- [ ] **Step 9: Verify all new client tests fail for the intended serial-path reason**

Do not edit runtime code until the failures are observed and understood.

- [ ] **Step 10: GREEN — implement the minimal bounded worker pool**

In `uploadFileResumable(...)`, add an optional `concurrency` input resolved from the limits recommendation used by the calling UI. Use a synchronous missing-index queue with at most `N` workers. Maintain per-index in-flight progress and recompute aggregate transferred bytes rather than deriving progress from one mutable `upload` object. Merge only server-confirmed completions into authoritative session state. Keep `CHUNK_ATTEMPTS=3` and existing retry/backoff semantics.

- [ ] **Step 11: RED/GREEN — concurrent server writes to distinct indices**

Add a real Express test in `tests/resumableUpload.test.js` that opens one multi-chunk session, PUTs two distinct chunk indices concurrently, then sends remaining chunks, commits, and proves byte-for-byte final integrity. The server must not treat distinct-index concurrency as same-index collision.

- [ ] **Step 12: Run focused GREEN suite**

Run `chunkedUploadClient.test.js`, `resumableUpload.test.js`, `transferLimitsConfig.test.js`. Exact pass/fail/skip counts must be reported.

- [ ] **Step 13: Commit the upload optimization as one reviewable unit**

Do not tune chunk size, NGINX, download path, or Vault in the same commit.

---

### Task 3: Preserve upload UX, recovery, Vault, and multi-account safety

**Files:**
- Test: `IDEA1-AEGIS_Drive_LC/tests/uploadRecovery.test.js`
- Test: `IDEA1-AEGIS_Drive_LC/tests/uploadRecoveryLifecycle.test.js`
- Test: `IDEA1-AEGIS_Drive_LC/tests/filesUploadTargeting.test.js`
- Test: `IDEA1-AEGIS_Drive_LC/tests/filesUploadTray.test.js`
- Test: `IDEA1-AEGIS_Drive_LC/tests/uploadBatchSummary.test.js`
- Test: `IDEA1-AEGIS_Drive_LC/tests/transferRate.test.js`
- Test: `IDEA1-AEGIS_Drive_LC/tests/fileObjectAuthorization.test.js`
- Test: `IDEA1-AEGIS_Drive_LC/tests/vaultChunkedUploadClient.test.js`
- Test: `IDEA1-AEGIS_Drive_LC/tests/vaultV2Api.test.js`
- Create only if existing coverage cannot express the scenario cleanly: `IDEA1-AEGIS_Drive_LC/tests/multiAccountTransferIsolation.test.js`

**Interfaces:**
- Consumes: Task 2 upload implementation, or whichever upload fix Task 1 proved.
- Produces: proof that performance behavior remains platform-wide and security/recovery behavior is unchanged.

- [ ] **Step 1: Verify refresh/unmount vs explicit Cancel semantics**

Run upload recovery and lifecycle suites. A page teardown may abort local requests but must not delete server sessions or recovery records; explicit Cancel still releases them.

- [ ] **Step 2: Verify progress/rate truthfulness under concurrent lanes**

Run transfer-rate, tray, and batch-summary suites. Add RED/GREEN assertions only if concurrent per-lane callbacks expose a real accounting defect.

- [ ] **Step 3: Verify folder targeting and resume identity**

Run `filesUploadTargeting.test.js` and recovery identity tests; concurrency must not alter the session-bound destination.

- [ ] **Step 4: Verify account-neutral behavior**

Test Admin and DataLake-User transfers through the same code path. Add a newly-created account case if current helpers support account creation. No role-dependent concurrency/throughput policy is permitted.

- [ ] **Step 5: Verify concurrent multi-account isolation**

Run two authorized sessions concurrently and prove upload IDs, bytes, metadata, and final files do not mix. Cross-owner status/chunk/commit/download access remains denied exactly as before.

- [ ] **Step 6: Verify Vault unchanged before tuning it**

Run Vault V2 API and client concurrency/crypto suites. Do not modify Vault merely to make its code look like Normal Files. Existing zero-knowledge/AES-GCM behavior is authoritative.

---

### Task 4: Select the best bounded upload policy with one-variable experiments

**Files:**
- Modify documentation/evidence only unless the selected default/config value changes: PR216 study design, measurement plan, and status note.

**Interfaces:**
- Consumes: Task 2/3 green candidate and Task 1 diagnosis.
- Produces: evidence-backed selected concurrency/resource policy, or rejection of the candidate.

- [ ] **Step 1: Compare lane counts one variable at a time**

Test `1`, `2`, `3`, and `4` lanes without simultaneously changing chunk size, proxy buffering, retry policy, or integrity checks. Local/synthetic tests may establish correctness; only Human-run controlled path measurements can establish Production path gain.

- [ ] **Step 2: Record resource cost**

For each lane count record browser memory trend, request count, retry/failure count, server CPU/event-loop/storage observations available from the existing study method, and achieved throughput.

- [ ] **Step 3: Keep the smallest lane count that captures the useful gain**

Do not choose `4` merely because it is maximum. If concurrency gives no material gain, revert the performance behavior while retaining only truthful diagnostic documentation and return to Task 1 with the new evidence.

---

### Task 5: Diagnose and optimize authenticated download independently

**Status: DIAGNOSIS COMPLETE TO CURRENT GATE / NO_SAFE_APP_FIX_PROVEN**

- P1 shared-path capacity limitation established:
  Probe D1 on P1 Direct LAN yielded `D1_R = 0.993 <= 1.15`, proving that two concurrent download streams divide the available throughput without increasing aggregate speed (~11.03 MB/s dual vs ~11.12 MB/s single).
- Startup cost excluded:
  `ttfbShareA = 0.0008 < 0.05` proves that authorization, file metadata lookup, and audit row creation account for under 0.1% of elapsed time and do not limit sustained throughput.
- End-to-end application inspection confirms no software bottleneck:
  Authenticated download streams directly from disk with normal Node stream backpressure; HUB NGINX route already pins `proxy_buffering off`; zero in-memory buffering; zero rate/connection limiting (`no limit_rate/req/conn`); zero artificial delays.
- Hardware limiter strongly supported:
  Canonical hardware baseline records deployed router as MikroTik RB750r2 (hEX lite). Official vendor datasheets establish 5x 10/100 Ethernet ports. The ~11.1 MB/s transfer ceiling matches 100BASE-TX Fast Ethernet wire-rate capacity (~95 Mbps payload).
- Consequence:
  `APPLICATION_DEFECT_PROVEN=NO`, `DOWNLOAD_OPTIMIZATION=NO_SAFE_APP_FIX_PROVEN`. No application code changes will be made.

**Files:**
- Inspected: `IDEA1-AEGIS_Drive_LC/server/routes/api.js` (no defect found)
- Inspected: `IDEA1-AEGIS_Drive_LC/server/storage/fileStore.js` (no defect found)
- Inspected: `HUB-AEGIS_Entry/nginx.conf` (`proxy_buffering off` already present)
- Inspected: `HUB-AEGIS_Entry/tests/driveTransferEdge.test.mjs` (pinned)
- Test: `IDEA1-AEGIS_Drive_LC/tests/fileObjectAuthorization.test.js` (preserved)
- Runtime/config file to modify: NONE (`NO_SAFE_APP_FIX_PROVEN`)

**Interfaces:**
- Consumes: download diagnosis gate from Task 1.
- Produces: one isolated download fix, or `DOWNLOAD_OPTIMIZATION=NO_SAFE_APP_FIX_PROVEN` if the residual limit is outside the application.

- [ ] **Step 1: Preserve known architecture facts**

Authenticated Files download already streams `openReadStream(...).pipe(res)`, and the HUB download route already declares `proxy_buffering off`. Treat these as facts, not proof that neither layer can bottleneck.

- [ ] **Step 2: Separate startup latency from sustained throughput**

Measure/derive TTFB separately from body-transfer span. Awaited audit/auth work can explain startup latency but cannot be blamed for a sustained 1 GB throughput ceiling without evidence.

- [ ] **Step 3: Locate the limiting boundary**

Use the smallest Human-run read-only ladder needed to distinguish Drive backend/storage read speed, HUB/private-path speed, and Remote/Twingate speed. Do not weaken auth or expose a new public bypass for benchmarking.

- [ ] **Step 4: Write a failing test for the proven defect**

Examples: if route/config backpressure is proven, pin the exact stream/config contract; if a server buffer/highWaterMark defect is proven, create a deterministic stream test; if no application defect is proven, do not manufacture a code change.

- [ ] **Step 5: Implement one minimal fix and verify GREEN**

Do not bundle upload concurrency, download changes, and preview changes into the same experimental commit.

- [ ] **Step 6: Re-run authorization tests**

Owner-only download must remain 200 for the owner and 404 for cross-owner access in both directions; Admin has no override.

---

### Task 6: Core verification before any Production candidate

**Files:**
- All runtime/test files changed by Tasks 2–5.

**Interfaces:**
- Consumes: completed core upload/download candidate.
- Produces: a source candidate eligible for Human-controlled deployment preparation.

- [ ] **Step 1: Run all focused transfer suites**

At minimum: chunked client, resumable upload, transfer limits, recovery, recovery lifecycle, upload targeting, transfer rate, upload tray/batch, file object authorization, Vault V2 client/API, and HUB drive-transfer edge tests.

- [ ] **Step 2: Run affected broader IDEA1 tests and build**

Run `npm run build`. If the full IDEA1 suite is run, report exact pass/fail/skip counts and classify any baseline failures; do not rewrite historical evidence.

- [ ] **Step 3: Run repository governance**

Run root collaboration/governance tests, vault validation, `git diff --check`, added-line secret scan, and collaboration guardrails.

- [ ] **Step 4: Independent source review**

Review specifically for unbounded concurrency, stale-session state races, progress overcount, duplicate chunk sends, auth/owner regression, Vault crypto regression, whole-file buffering, and unrelated scope creep.

- [ ] **Step 5: Stop before Production mutation**

Report exact candidate SHA, changed files, diagnosis, test evidence, expected benefit, rollback boundary, and remaining uncertainty. Human Owner decides deployment.

---

### Task 7: Human-controlled POST-FIX transfer acceptance

**Files:**
- Update after evidence: PR216 study design, measurement plan, `idea1-status.md`.
- Final immutable receipt only after the complete PR216 task is accepted.

**Interfaces:**
- Consumes: Human-deployed exact candidate from Task 6.
- Produces: comparable POST-FIX evidence against the accepted PRE-FIX matrix.

- [ ] **Step 1: Human deploys the exact reviewed candidate using a bounded Drive-only rollout**

Agent prepares commands/package only. Human Owner executes Production mutation.

- [ ] **Step 2: Run P2 Remote/Twingate POST-FIX matrix**

Files upload and download at 100 MB, 300 MB, 1 GB; three runs each; same measurement method as PRE-FIX. Record median/min/max/mean, retry/failure count, and relevant timing breakdown.

- [ ] **Step 3: Run P1 Direct LAN POST-FIX matrix**

Same S/M/L × upload/download × three-run structure. LAN must not be silently traded away to improve Remote.

- [ ] **Step 4: Compare against PRE-FIX honestly**

Report absolute MB/s and percentage change for every fixture/path. A desirable Remote result such as 10 MB/s+ may be celebrated when supported by the path, but is not a pass/fail promise.

- [ ] **Step 5: Decide keep/revert/continue**

Keep only changes that deliver material repeatable gain without safety regressions or unacceptable resource cost. If a clearly proven application bottleneck remains, return to diagnosis for the next single variable. If residual limitation is the external network/Twingate path, classify it separately rather than stacking speculative application patches.

---

### Task 8: Secondary preview/video responsiveness follow-up

**Files:**
- Inspect: `IDEA1-AEGIS_Drive_LC/server/routes/media.js`
- Inspect: `IDEA1-AEGIS_Drive_LC/src/lib/mediaApi.js`
- Inspect: `IDEA1-AEGIS_Drive_LC/src/lib/vaultPreviewRange.js`
- Inspect: `IDEA1-AEGIS_Drive_LC/src/lib/vaultVideoPreview.js`
- Test: `IDEA1-AEGIS_Drive_LC/tests/mediaRoutes.test.js`
- Additional preview tests only after a preview-specific bottleneck is measured.

**Interfaces:**
- Consumes: stable core transfer candidate and Human-observed preview problem.
- Produces: optional secondary preview optimization that does not block PR216 core throughput closeout unless Human Owner explicitly makes it a blocker.

- [ ] **Step 1: Measure cold/warm Files preview and Vault video start/seek separately**

Record TTFB, time-to-first-frame, spinner duration, Range request count, and seek-to-frame recovery on LAN and Remote.

- [ ] **Step 2: Optimize only proven RTT/queue/decode amplification**

Normal Files may use its existing derivative/cache architecture. Vault may use bounded client-side read-ahead/range coalescing only if evidence supports it. Server-side plaintext Vault derivatives remain forbidden.

- [ ] **Step 3: TDD and verify**

RED first, minimal GREEN, then relevant media/Vault tests and a small Human POST measurement.

---

## Completion Gate

PR216 is not ready for final receipt/Ready/merge until all claims are evidence-backed. The closeout must state separately:

- `UPLOAD_ROOT_CAUSE=`
- `UPLOAD_OPTIMIZATION=`
- `UPLOAD_POST_FIX_P1=`
- `UPLOAD_POST_FIX_P2=`
- `DOWNLOAD_ROOT_CAUSE=`
- `DOWNLOAD_OPTIMIZATION=`
- `DOWNLOAD_POST_FIX_P1=`
- `DOWNLOAD_POST_FIX_P2=`
- `VAULT_TRANSFER_REGRESSION=PASS|FAIL|NOT_RUN`
- `MULTI_ACCOUNT_ISOLATION=PASS|FAIL`
- `PREVIEW_OPTIMIZATION=IMPLEMENTED|DEFERRED|NOT_REQUIRED`
- `PRODUCTION_ACCEPTANCE=`
- `FINAL_RECEIPT=`

No result may be upgraded from `NOT_PROVEN` merely because a plausible optimization was implemented.