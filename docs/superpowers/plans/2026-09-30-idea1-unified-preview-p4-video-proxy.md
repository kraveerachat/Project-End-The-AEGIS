# IDEA1 Unified Preview — P4 Low-Bitrate Encrypted Video Proxy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Tasks marked **BLOCKED_FOR_DEPENDENCY_APPROVAL** must not start until the Human Owner approves the D-6 table in this plan.

**Goal:** Materially better Vault video preview where a high-bitrate original exceeds measured throughput, by playing a client-generated, client-encrypted low-bitrate proxy (vp1: 854×480, ~1.0 Mbps video target / 1.5 Mbps max, bounded audio, ≤ 30 fps, faststart/moov-first, bounded duration) through the existing Service Worker range-decryption session, with a visible Preview-quality ↔ Original toggle.

**Architecture:** Two halves. **(A) Playback policy — executable now:** an in-memory EWMA throughput meter, a pure source-selection policy (proxy when present and either no sample exists or throughput < 1.25 × the original's average bitrate), modal toggle, fallback to the original, lock cleanup, and Build Preview wiring. **(B) Proxy generation — BLOCKED_FOR_DEPENDENCY_APPROVAL (D-6):** WebCodecs decode/encode in a dedicated worker, MP4 demux/mux via an approved library, streamed into the V2 chunk encryptor at the current 8 MiB chunk size, cancellable with progress. Large legacy proxies only via explicit Build Preview (D-8).

**Tech Stack:** WebCodecs `VideoDecoder`/`VideoEncoder`/`AudioDecoder`/`AudioEncoder` (capability-detected), module Worker, existing SW responder and read-ahead, P2b derivative modules, `node:test`, jsdom.

**Spec:** §10 (proxy), §16.1–§16.4, §20–§25, §28, §31 item 4, §33, §36 (T-PROXY-POLICY, T-PERF-VAULT, T-CHUNK-RULES), §37 H6, H7, H14, §38.1 P4. Decisions D-3 (deferred), D-6, D-8, D-9, D-11.

**Depends on:** P3 merged. **Branch:** `feat/idea1-preview-p4-video-proxy` from `origin/main`.

## Global Constraints

```
VAULT_V2_MIN_PLAINTEXT_CHUNK=8 MiB     (D-3 deferred — proxy uploads use exactly the minimum; do NOT lower it)
GROUP_B_THROUGHPUT_SCOPE=DEFERRED      (no transport, chunk, concurrency, or read-ahead tuning)
REMOTE_EQUALS_LAN=NO                   (throughput is used ONLY to choose proxy vs original)
NETWORK_TYPE_DETECTION=NONE            (no "if LAN / if Remote" branch anywhere)
ACCEPTANCE≠ZERO_BUFFERING, ACCEPTANCE≠GOOGLE_DRIVE_PARITY
```

- Master plan §3 block applies verbatim.
- Proxy plaintext never leaves the browser; output is encrypted chunk-by-chunk before upload; peak proxy memory ≤ one 8 MiB plaintext chunk + encoder queues (bounded).
- Automatic generation only for **new uploads** from the local `File`; legacy proxies only via explicit Build Preview.

## File Map

| Action | Path | Responsibility | Status |
|---|---|---|---|
| Create | `src/lib/vaultProxyPolicy.js` | eligibility + source selection (pure) | executable |
| Create | `src/lib/vaultThroughputMeter.js` | in-memory EWMA; `clear()` on lock | executable |
| Modify | `src/lib/vaultPreviewResponder.js`, `src/vaultPreviewServiceWorker.js`, `src/lib/vaultPreviewSession.js` | SW posts `{ bytes, ms }` timing samples (no plaintext, no ids) | executable |
| Modify | `src/lib/vaultDerivativeRead.js`, `src/lib/vaultChunkedDownload.js` | feed meter samples | executable |
| Create | `src/components/preview/providers/VaultVideoPlayer.jsx` | proxy/original selection, toggle, badge, fallback | executable |
| Modify | `src/components/vault/BuildPreviewDialog.jsx`, `VaultTileMenu.jsx` | proxy option (hidden unless a generator is injected) | executable |
| Create | `src/workers/vaultProxyWorker.js` | decode → scale → encode → mux → chunk stream | **BLOCKED_FOR_DEPENDENCY_APPROVAL** |
| Create | `src/lib/vaultProxyGenerate.js` | page-side controller: progress, cancel, upload | **BLOCKED_FOR_DEPENDENCY_APPROVAL** |
| Modify | `src/lib/vaultTreeUpload.js` | new-upload proxy after commit | **BLOCKED_FOR_DEPENDENCY_APPROVAL** |
| Modify | `package.json`, `package-lock.json` | approved mux/demux package | **BLOCKED_FOR_DEPENDENCY_APPROVAL** |

## Interfaces

```ts
// src/lib/vaultProxyPolicy.js
export const PROXY_VP1: Readonly<{ maxWidth: 854, maxHeight: 480, maxFps: 30, videoTargetBps: 1_000_000,
  videoMaxBps: 1_500_000, audioBps: 96_000, maxSeconds: 3600 }>
export function proxyEligibility(o: { plainSize: number, durationMs: number, profile?: typeof PROXY_VP1 })
  : { eligible: boolean, reason: 'OK' | 'LOW_BITRATE' | 'TOO_LONG' | 'UNKNOWN_DURATION' }
  // eligible iff durationMs known, ≤ maxSeconds, and plainSize*8/(durationMs/1000) > 2 × videoTargetBps
export function selectPlaybackSource(o: { hasProxy: boolean, originalAvgBps: number | null,
  throughputBps: number | null, userChoice: 'auto' | 'proxy' | 'original' }): 'proxy' | 'original'
  // userChoice wins; auto: proxy iff hasProxy && (throughputBps == null || originalAvgBps == null
  //   || throughputBps < 1.25 × originalAvgBps)

// src/lib/vaultThroughputMeter.js
export function createThroughputMeter(o?: { alpha?: 0.3, minSampleBytes?: 262_144 })
  : { sample(bytes: number, ms: number): void, bps(): number | null, clear(): void }

// src/lib/vaultProxyGenerate.js  (BLOCKED)
export async function generateProxy(source: { file?: File, url?: string },
  o: { profile: typeof PROXY_VP1, kek: CryptoKey, signal: AbortSignal, onProgress: (f: number) => void })
  : Promise<{ blobRef, contentId, plainSize, width, height, durationMs, mime: 'video/mp4' } | null>
```

---

### Task 0: Baseline

- [ ] Worktree + `npm ci`; `npm test` → `$SCRATCH/p4-baseline-failures.txt`.

### Task 1: Proxy eligibility (pure)

**Files:** Create `src/lib/vaultProxyPolicy.js`, `tests/vaultProxyPolicy.test.js`.

- [ ] **Step 1 — RED:** START_LIVE-like input (1,206,241,622 B / 120 s ≈ 80 Mbps) → eligible; 1.5 Mbps source → `LOW_BITRATE`; 2 h source → `TOO_LONG`; unknown duration → `UNKNOWN_DURATION`; `PROXY_VP1` frozen and equal to spec values.
- [ ] **Step 2 — verify RED.** **Step 3 — GREEN.** **Step 4 — verify GREEN.**
- [ ] **Step 5 — commit:** `feat(idea1): define vp1 proxy profile and eligibility`.

### Task 2: Throughput meter and SW timing samples

**Files:** Create `src/lib/vaultThroughputMeter.js`, `tests/vaultThroughputMeter.test.js`; modify SW responder/session/worker and read/download modules; extend `tests/vaultPreviewResponder.test.js`, `tests/vaultPreviewSession.test.js`.

- [ ] **Step 1 — RED:** EWMA math; samples below `minSampleBytes` ignored; `clear()` resets; SW responder emits `{ type: 'vault-preview-throughput', bytes, ms }` after each ciphertext chunk fetch — message contains no token, blob id, name, or plaintext (key whitelist assertion); page forwards samples to the meter; meter never persisted (storage guards); no code path reads connection type / network interface (source scan for `navigator.connection`).
- [ ] **Step 2 — verify RED.** **Step 3 — GREEN.** **Step 4 — verify GREEN** + `node --test --test-concurrency=1 tests/vaultPreviewWorkerState.test.js tests/vaultPreviewReadAhead.test.js` (read-ahead behaviour unchanged).
- [ ] **Step 5 — commit:** `feat(idea1): measure achieved Vault throughput in memory for preview selection`.

### Task 3: Source-selection policy (T-PROXY-POLICY)

**Files:** `src/lib/vaultProxyPolicy.js`, `tests/vaultProxyPolicy.test.js`.

- [ ] **Step 1 — RED:** truth table for `selectPlaybackSource` including user overrides; identical output regardless of any account or network label (the function accepts none).
- [ ] **Step 2 — verify RED.** **Step 3 — GREEN.** **Step 4 — verify GREEN.**
- [ ] **Step 5 — commit:** `feat(idea1): choose proxy or original from measured throughput only`.

### Task 4: Vault video player with toggle and fallback

**Files:** Create `src/components/preview/providers/VaultVideoPlayer.jsx`, `tests/vaultVideoPlayer.test.js`; modify `src/screens/VaultTreeScreen.jsx`.

- [ ] **Step 1 — RED:** node with a valid proxy entry (synthetic, test fake server) → modal opens an SW session on the **proxy** blob with `contentType: 'video/mp4'` (spy) and shows a "Preview quality" badge; toggle → closes proxy session, opens original session, keeps approximate position; proxy `CONTENT_ID_MISMATCH`/`INTEGRITY` → falls back to original with a notice and schedules no automatic proxy regeneration (D-8); no proxy → original (today's behaviour); `waiting` events counted into diagnostics; choice persists only for the modal instance; proxy blob chunk size in the fixture is 8 MiB (assert policy did not assume smaller chunks).
- [ ] **Step 2 — verify RED.** **Step 3 — GREEN.** **Step 4 — verify GREEN** + `node --test --test-concurrency=1 tests/vaultVideoPreview.test.js tests/vaultMediaPreview.test.js tests/vaultPreviewReliability.test.js`.
- [ ] **Step 5 — commit:** `feat(idea1): play Vault proxy with an Original toggle and safe fallback`.

### Task 5: Lock cleanup

**Files:** `src/lib/vaultUnlockedState.js`, `tests/vaultDerivativeLock.test.js`.

- [ ] **Step 1 — RED:** lock during proxy playback closes the proxy SW token, clears the meter, revokes URLs; storage guards zero.
- [ ] **Step 2 — verify RED.** **Step 3 — GREEN.** **Step 4 — verify GREEN.**
- [ ] **Step 5 — commit:** `feat(idea1): release proxy playback and throughput state on Vault lock`.

### Task 6: Build Preview wiring for proxy (generator-injected)

**Files:** `src/components/vault/BuildPreviewDialog.jsx`, `src/components/vault/VaultTileMenu.jsx`, `tests/vaultBuildPreview.test.js`.

- [ ] **Step 1 — RED:** proxy option appears only when a `proxyGenerator` is injected **and** `proxyEligibility` is eligible **and** no valid proxy exists; dialog shows estimated original bytes to read and estimated proxy size (`durationMs × ~1.1 Mbps`); with no generator injected (state until Task 7 is approved) the option is absent; unlock never triggers proxy work (spy).
- [ ] **Step 2 — verify RED.** **Step 3 — GREEN.** **Step 4 — verify GREEN.**
- [ ] **Step 5 — commit:** `feat(idea1): expose explicit Build Preview for eligible legacy videos`.

---

## D-6 dependency table (MP4/WebM demux/mux) — **NOT APPROVED**

Licenses and maintenance status below are as understood at planning time and **must be re-verified against each package's published LICENSE and repository at approval time**. No package is installed by this plan.

| Field | Candidate A (recommended) | Candidate B (alternative pair) | Candidate B2 | Candidate C (WebM) |
|---|---|---|---|---|
| PACKAGE | `mediabunny` | `mp4box` (demux) | `mp4-muxer` (mux) | `webm-muxer` |
| VERSION_POLICY | exact pin in `package-lock.json`; upgrades only by reviewed PR with changelog + this table updated | same | same | same |
| LICENSE | MPL-2.0 | BSD-3-Clause | MIT | MIT |
| PURPOSE | demux source MP4/MOV/WebM, feed WebCodecs, mux fragmented (moov-first) MP4 | demux MP4/MOV | mux MP4 (fast-start/fragmented) | mux WebM (only if MP4 AVC encode unavailable) |
| PROCESSES_ATTACKER_BYTES | YES (parses the user's source container) | YES | NO (consumes encoder output only) | NO |
| EXECUTION_BOUNDARY | browser, dedicated module Worker only; never server | browser worker | browser worker | browser worker |
| CSP_IMPACT | none expected: bundled same-origin script/worker (`script-src 'self'`); must verify no `eval`/`new Function` and no remote fetch; `wasm-unsafe-eval` already allowed if any wasm | same | same | same |
| FALLBACK | no proxy generated → original playback (current behaviour); Build Preview hidden | same | same | same |
| REPLACEMENT_OPTION | Candidate B pair | Candidate A | Candidate A | Candidate A |
| NOTES | single maintained library covering demux+mux; supersedes the author's earlier `mp4-muxer`/`webm-muxer` | long-lived GPAC project | author marks it superseded by `mediabunny` — maintenance risk | same maintenance note |

**Gate G-D6-MUX:** Tasks 7–9 below are `BLOCKED_FOR_DEPENDENCY_APPROVAL` until the Human Owner approves one candidate (package + exact version) in writing.

---

### Task 7: Proxy generation worker — **BLOCKED_FOR_DEPENDENCY_APPROVAL**

**Files:** Create `src/workers/vaultProxyWorker.js`, `src/lib/vaultProxyGenerate.js`, `tests/vaultProxyGenerate.test.js`; modify `package.json`/`package-lock.json` (approved package only).

- [ ] **Step 0:** Confirm written D-6 approval (package + version). Install with `npm install --save-exact <approved-package>@<approved-version>`; record license file hash in the PR.
- [ ] **Step 1 — RED:** with injected fakes for demuxer/decoder/encoder/muxer: output ≤ 854×480 fit-inside even dims; fps ≤ min(source, 30); encoder configured at target 1.0 Mbps with 1.5 Mbps cap; audio encoded at 96 kbps when `AudioEncoder.isConfigSupported` else silent proxy flagged `audio: false`; muxer configured moov-first (fragmented); output bytes stream into the V2 chunk encryptor in 8 MiB plaintext chunks (never more than one plaintext chunk buffered — assert max buffered bytes); `VideoFrame.close()` called for every frame; abort → worker terminated, no commit; progress monotonic 0→1; `VideoDecoder` unsupported codec → `null` (no throw); duration > 3600 s → not started.
- [ ] **Step 2 — verify RED.** **Step 3 — GREEN.** **Step 4 — verify GREEN** + `node --test --test-concurrency=1 tests/vaultDerivativeUpload.test.js tests/previewGuardrails.test.js`.
- [ ] **Step 5 — commit:** `feat(idea1): generate encrypted Vault video proxies in a worker`.

### Task 8: New-upload proxy integration — **BLOCKED_FOR_DEPENDENCY_APPROVAL**

**Files:** `src/lib/vaultTreeUpload.js`, `src/components/VaultUploadDrawer.jsx`, `tests/vaultDerivativeUploadFlow.test.js`.

- [ ] **Step 1 — RED:** eligible upload: original + thumb/poster/motion attach as before; proxy runs after commit with drawer progress and Cancel; completion → `setNodePreviews` with `proxy`; closing the tab mid-generation leaves the file without proxy and no orphan committed; upload result unaffected by proxy failure; ineligible sources skip generation.
- [ ] **Step 2 — verify RED.** **Step 3 — GREEN.** **Step 4 — verify GREEN.**
- [ ] **Step 5 — commit:** `feat(idea1): build proxies for newly uploaded high-bitrate Vault videos`.

### Task 9: Legacy Build Preview proxy — **BLOCKED_FOR_DEPENDENCY_APPROVAL**

**Files:** `src/lib/vaultProxyGenerate.js`, `src/components/vault/BuildPreviewDialog.jsx`, `tests/vaultBuildPreview.test.js`.

- [ ] **Step 1 — RED:** user confirms Build Preview → generator reads the original through its SW range-decryption session URL (user-initiated only), progress, Cancel; success attaches proxy; failure leaves no partial entry; still no work on unlock.
- [ ] **Step 2 — verify RED.** **Step 3 — GREEN.** **Step 4 — verify GREEN.**
- [ ] **Step 5 — commit:** `feat(idea1): allow explicit proxy builds for legacy Vault videos`.

### Task 10: Measurement (T-PERF-VAULT) — after Tasks 7–9

- [ ] Human-run with START_LIVE.mp4 on LAN and Remote (record measured download throughput of each path; judge each against its own ceiling): proxy size, poster time, proxy time-to-first-frame (≈ one 8 MiB chunk fetch), `waiting` count/duration over full playback for proxy vs original. Record in the PR; no threshold tuning of transport.

### Task 11: Regression and governance

- [ ] `npm test` vs baseline; Vault + Normal Files regression lists (P2b Task 16); PG neutrality.
- [ ] Source scan: no `navigator.connection`, no LAN/Remote branching, no role/account tokens in `vaultProxy*.js`, `vaultThroughputMeter.js`.
- [ ] `npm run build && git checkout -- dist`; `git diff --check`; policy validation; receipt; push.

## Rollback boundary

Reversible: proxy entries are optional manifest data; builds without P4 ignore them. If the approved dependency is later rejected, remove the generator (Tasks 7–9); playback policy (Tasks 1–6) keeps working for existing proxies.

## Human review gates

1. **G-D6-MUX** before Task 7.
2. Acceptance (ADMIN / EXISTING_USER / NEWLY_CREATED_USER; LAN and Remote): §37 H6 (poster appears quickly), H7 (Preview opens; content recognizable; proxy playback materially better than the original where proxy bitrate fits measured download throughput; no repeated 4–6 s starvation loops in that case; Original toggle works), H14. Zero buffering and Google Drive parity are **not** criteria.
