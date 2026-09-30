# IDEA1 Unified Preview — P3 Encrypted Motion Derivatives Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Smooth, muted, bounded hover/press motion for Vault video and animated-image tiles from a small **encrypted motion derivative**, replacing hover streaming of the original, while leaving Normal Files hover behaviour unchanged.

**Architecture:** Motion clips (≤ 480×270, ≤ 12 fps, ≤ 6 s, no audio, ≤ 4 MiB) are recorded in the browser with the **native** `MediaRecorder` from a canvas fed by the local plaintext source (video element or WebCodecs `ImageDecoder` frames). Primary container MP4/H.264 where `MediaRecorder.isTypeSupported('video/mp4;codecs=avc1…')`; fallback WebM VP9/VP8 (spec §10 allows it); otherwise no motion derivative. The clip is encrypted and stored exactly like P2b derivatives and read whole (single chunk) on hover. **No third-party mux/demux library is used**, so D-6 is not triggered; if execution proves native recording unusable, the executor must stop with `DEPENDENCY_APPROVAL_REQUIRED` (see Task 2 note).

**Tech Stack:** `MediaRecorder`, `HTMLCanvasElement.captureStream`, `requestVideoFrameCallback`, WebCodecs `ImageDecoder` (capability-detected), P2b derivative upload/read modules, `node:test`, jsdom.

**Spec:** §10 (motion), §13, §15, §21–§25, §28, §31 item 3 (D-8), §35, §36 (T-LOCK, T-NEUTRAL), §37 H8, H14.

**Depends on:** P2b merged (manifest `previews`, `setNodePreviews`, derivative upload/read). Production acceptance requires the P2b writer flag enabled. **Branch:** `feat/idea1-preview-p3-motion` from `origin/main`.

## Global Constraints

- Master plan §3 block applies verbatim (D-2 no padding, D-3 8 MiB minimum, D-4 audit unchanged, D-5 cache off).
- Automatic motion backfill **only** from plaintext already decrypted for a visible user action (e.g. a small GIF already played on hover within `gifMaxFullPlayBytes`). Large legacy videos/GIFs: explicit **Build Preview** only. **Never** fetch an original on unlock for motion.
- Normal Files: `server/media/motion.js`, `src/lib/mediaTile.js`, `src/components/MediaThumb.jsx` unchanged.
- Motion never plays under `prefers-reduced-motion: reduce`; at most one motion plays per grid.

## File Map

| Action | Path | Responsibility |
|---|---|---|
| Create | `src/lib/vaultMotionRecorder.js` | `detectMotionEncoder`, `recordMotion` (canvas → MediaRecorder) |
| Modify | `src/lib/vaultDerivativeGenerate.js` | `generateMotion(source, opts)` |
| Modify | `src/lib/vaultTreeUpload.js` | motion after thumb/poster within budget; else follow-up `setNodePreviews` |
| Create | `src/lib/vaultMotionController.js` | single-active hover controller, reduced motion, release |
| Modify | `src/screens/VaultTreeScreen.jsx`, `src/components/vault/VaultFileTile.jsx`, `src/components/vault/VaultTileMenu.jsx` | hover wiring; **Build Preview** menu action |
| Modify | `src/lib/vaultVideoPreview.js` | tiles no longer call `openVideoMotion` on the original |
| Modify | `src/lib/vaultDerivativeBackfill.js` | accept `motion` only with `origin: 'visible-plaintext'` |
| Create | `src/components/vault/BuildPreviewDialog.jsx` | explicit action: estimate, progress, cancel |
| Modify | `src/lib/vaultUnlockedState.js` | recorder/stream disposers |
| Create | tests per task | |

## Interfaces

```ts
// src/lib/vaultMotionRecorder.js
export function detectMotionEncoder(win?: Window): { mime: string, container: 'mp4' | 'webm' } | null
  // order: 'video/mp4;codecs=avc1.4D401E' → 'video/webm;codecs=vp9' → 'video/webm;codecs=vp8'
export async function recordMotion(o: {
  drawFrame: (ctx: CanvasRenderingContext2D, tMs: number) => Promise<boolean>,  // false = source ended
  width: number, height: number, fps: 12, maxMs: 6000, videoBitsPerSecond: 1_200_000,
  encoder: { mime: string }, signal?: AbortSignal, createCanvas?: Function, MediaRecorderImpl?: Function
}): Promise<{ bytes: Uint8Array, mime: string, width: number, height: number, durationMs: number } | null>

// src/lib/vaultDerivativeGenerate.js
export async function generateMotion(source:
  { kind: 'video', file?: File, url?: string } | { kind: 'animated', file?: File, bytes?: Uint8Array },
  o: { profile, env, signal, budgetMs: 30_000 }): Promise<MotionResult | null>   // > 4 MiB → null (no quality search)

// src/lib/vaultMotionController.js
export function createMotionController(o: { reducedMotion: () => boolean, read: (preview) => Promise<{ok, url}> })
  : { enter(nodeId, preview, el): void, leave(nodeId): void, releaseOutside(nodeIds: Set<string>): void, dispose(): void }
```

---

### Task 0: Baseline

- [ ] Worktree + `npm ci`; `npm test` → `$SCRATCH/p3-baseline-failures.txt`.

### Task 1: Encoder capability detection

**Files:** Create `src/lib/vaultMotionRecorder.js`, `tests/vaultMotionRecorder.test.js`.

- [ ] **Step 1 — RED:** stubbed `MediaRecorder.isTypeSupported` truth tables → MP4 preferred, WebM fallbacks, `null` when none or when `MediaRecorder`/`captureStream` absent.
- [ ] **Step 2 — verify RED:** module not found.
- [ ] **Step 3 — GREEN.** **Step 4 — verify GREEN.**
- [ ] **Step 5 — commit:** `feat(idea1): detect native motion encoder support`.

### Task 2: Bounded motion recording

**Files:** `src/lib/vaultMotionRecorder.js`, `src/lib/vaultDerivativeGenerate.js`, `tests/vaultMotionRecorder.test.js`, `tests/vaultDerivativeGenerate.test.js`.

- [ ] **Step 1 — RED:** with fake canvas/MediaRecorder: dimensions fit-inside 480×270 and even; frame pacing 12 fps; stops at 6 s or source end; no audio track requested; output > 4 MiB → `null`; abort stops recorder and all stream tracks; budget 30 s → `null`; animated source uses `ImageDecoder` frame durations and returns `null` without `ImageDecoder`; video source Object URL revoked in `finally`.
- [ ] **Step 2 — verify RED.** **Step 3 — GREEN.** **Step 4 — verify GREEN.**
- [ ] **Step 5 — commit:** `feat(idea1): record bounded motion clips in the browser`.
- Note: if Chromium browser QA (Task 8) shows native output unplayable/unloopable in `<video>`, stop and report `DEPENDENCY_APPROVAL_REQUIRED` (D-6: an MP4/WebM mux tool would be needed; the P4 plan's D-6 table covers candidates). Do not add a package.

### Task 3: Motion at upload for new files

**Files:** `src/lib/vaultTreeUpload.js`, `tests/vaultDerivativeUploadFlow.test.js`.

- [ ] **Step 1 — RED:** video/animated upload: thumb/poster attach as in P2b; motion generated after; if ready within the attach window → same CAS, else follow-up `setNodePreviews` CAS; motion failure never affects upload result; derivative session `chunkSize === 8 MiB + 16`; flag-off + v1 head → no generation.
- [ ] **Step 2 — verify RED.** **Step 3 — GREEN.** **Step 4 — verify GREEN** + `node --test --test-concurrency=1 tests/vaultTreeUploadClient.test.js tests/previewGuardrails.test.js`.
- [ ] **Step 5 — commit:** `feat(idea1): attach encrypted motion derivatives to new Vault uploads`.

### Task 4: Hover lifecycle from motion derivative only

**Files:** Create `src/lib/vaultMotionController.js`, `tests/vaultMotionController.test.js`; modify `src/screens/VaultTreeScreen.jsx`, `src/components/vault/VaultFileTile.jsx`, `src/lib/vaultVideoPreview.js`, `tests/vaultVideoPreview.test.js`, `tests/vaultTreeScreen.test.js`.

- [ ] **Step 1 — RED:** hover on a tile with motion → `<video muted loop playsInline>` from a Blob URL; entering a second tile pauses/stops the first (one active); pointer-leave pauses and keeps URL in LRU; scroll-out/folder change releases; reduced motion → no playback, poster stays; tile **without** motion → static poster, and spies prove **no** `openSession` on the original and no original chunk request (spec §7.3); long-press on touch equivalent.
- [ ] **Step 2 — verify RED:** current hover opens an SW session.
- [ ] **Step 3 — GREEN.** **Step 4 — verify GREEN** + `node --test --test-concurrency=1 tests/vaultGifPreview.test.js tests/vaultPreviewCancellation.test.js`.
- [ ] **Step 5 — commit:** `feat(idea1): play Vault hover motion from encrypted derivatives only`.

### Task 5: Lock cleanup and Object URL lifecycle

**Files:** `src/lib/vaultUnlockedState.js`, `tests/vaultDerivativeLock.test.js`.

- [ ] **Step 1 — RED:** lock during recording / hover playback / Build Preview: recorder stopped, canvas stream tracks stopped, `ImageDecoder.close()` called, Object URLs revoked, controller disposed; zero storage access (`installStorageGuards`); source scan covers new modules.
- [ ] **Step 2 — verify RED.** **Step 3 — GREEN.** **Step 4 — verify GREEN.**
- [ ] **Step 5 — commit:** `feat(idea1): release motion recording and playback on Vault lock`.

### Task 6: Legacy motion — visible-plaintext automatic + explicit Build Preview (D-8)

**Files:** `src/lib/vaultDerivativeBackfill.js`, create `src/components/vault/BuildPreviewDialog.jsx`, modify `src/components/vault/VaultTileMenu.jsx`; create `tests/vaultBuildPreview.test.js`; extend `tests/vaultDerivativeBackfill.test.js`.

- [ ] **Step 1 — RED:**
  - unlock + grid render of 20 legacy videos → zero original chunk requests attributable to motion (spy), zero motion generation.
  - small GIF (≤ `gifMaxFullPlayBytes`) played on hover via the existing path → `offer({ kind:'motion', origin:'visible-plaintext' })` accepted → one derivative upload + `setNodePreviews`; `offer` of `motion` without that origin → rejected.
  - Build Preview on a legacy video: dialog shows estimated bytes to fetch; confirm → one generation via the original's SW range session URL (user-initiated), progress, cancel aborts and uploads nothing; completion attaches motion.
  - Build Preview hidden when a valid motion entry exists or the writer cannot write.
- [ ] **Step 2 — verify RED.** **Step 3 — GREEN.** **Step 4 — verify GREEN.**
- [ ] **Step 5 — commit:** `feat(idea1): add user-initiated Build Preview for legacy motion`.

### Task 7: Neutrality, isolation, Normal Files non-regression

- [ ] **Step 1 — RED/GREEN:** extend `tests/previewAccountNeutrality.test.js` with motion derivative upload/read per class and cross-class 404; source scan includes `vaultMotion*.js`.
- [ ] **Step 2:** `node --test --test-concurrency=1 tests/mediaMotion.test.js tests/filesMediaTiles.test.js tests/mediaRoutes.test.js` unchanged-green.
- [ ] **Step 3 — commit:** `test(idea1): cover motion derivatives in account neutrality`.

### Task 8: Browser QA, regression, governance

- [ ] Chromium manual QA (Edge/Chrome): record motion for an MP4, a WebM, an animated GIF; verify `<video>` plays and loops the clip; note encoder mime used. Firefox/Safari spot check: graceful absence (poster only), no errors (D-11).
- [ ] `npm test` vs baseline; Vault + Normal Files regression lists from the P2b plan Task 16; PG neutrality run.
- [ ] `npm run build && git checkout -- dist`; `git diff --check`; policy validation; receipt; push.

## Rollback boundary

Reversible: motion entries are optional manifest data; a build without P3 ignores or renders them safely. No manifest version change.

## Human review gate

§37 H8 (hover smooth, muted, stops on leave, none under reduced motion) in both contexts (Files unchanged), H14 (lock during motion work), on ADMIN / EXISTING_USER / NEWLY_CREATED_USER, LAN and Remote.
