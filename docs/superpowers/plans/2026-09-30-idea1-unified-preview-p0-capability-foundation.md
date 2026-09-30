# IDEA1 Unified Preview — P0 Capability Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce one shared, pure capability model (format detection → provider registry → `FileCapability`) and one shared preview modal shell used by both Normal Files and the Private Vault; replace the Vault's `mediaType`-only preview gate with content-signature verification; and lock arbitrary upload, byte-exact download, and account neutrality behind regression tests.

**Architecture:** Pure modules under `src/lib/preview/` (no I/O, no role input). The resolver returns a `FileCapability` whose `download` is always `true`. Normal Files feeds it `file.ext` (already lower-cased server-side) with no signature yet (P1 adds media-info `format`); the Vault feeds it the decrypted manifest name, the `mediaType` **hint**, and — when a tile/preview job has decrypted chunk 0 — a sniffed signature memoized in page memory. Rendering is authorized only after signature confirmation. Normal Files' server poster/motion pipeline is untouched.

**Tech Stack:** React 19, `node:test`, jsdom, existing `tests/helpers/*`.

**Spec:** §2, §3, §4, §5, §7 (tile gate), §19, §29–§30, §36 (T-DETECT-1/2, T-REG-1, T-DL-1/2, T-UP-1, T-NEUTRAL), §37 H1/H2/H13/H15. Master plan: `2026-09-30-idea1-unified-preview-master-implementation.md`.

**Branch:** `feat/idea1-preview-p0-capability-foundation` from `origin/main`.

## Global Constraints

- Master plan §3 constraint block applies verbatim.
- `UPLOAD_ARBITRARY_BINARY=TRUE`, `DOWNLOAD_ARBITRARY_BINARY=TRUE`; preview support never gates upload or download.
- Normal Files poster/motion derivative code (`server/media/**`, `server/routes/media.js`, `src/lib/mediaApi.js`, `src/lib/mediaTile.js`, `src/components/MediaThumb.jsx`) is **not modified** in P0.
- No new dependency. No server route change in P0.
- No persistent storage API anywhere in new modules (SA-1 rule).

## File Map

| Action | Path | Responsibility |
|---|---|---|
| Create | `src/lib/preview/formats.js` | `FORMAT_IDS`, signature table, `normalizeExtension`, `sniffFormat`, `detectFormat` |
| Create | `src/lib/preview/env.js` | `detectPreviewEnv(win)` feature detection snapshot |
| Create | `src/lib/preview/registry.js` | frozen `PROVIDERS`, `resolveCapability` |
| Create | `src/lib/preview/capabilityCache.js` | page-memory memo of sniffed formats per identity; `clear()` for lock |
| Create | `src/components/preview/PreviewModalShell.jsx` | shared modal: header, status/alert regions, body slot, Download action |
| Create | `src/components/preview/PreviewUnsupported.jsx` | stable fallback body |
| Modify | `src/lib/filesView.js` | `previewKindFor` delegates to resolver (behavior-equivalent for current image/video set) |
| Modify | `src/screens/Files.jsx` | `FilePreviewModal` renders inside `PreviewModalShell`; existing `<img>/<video>` bodies unchanged |
| Modify | `src/lib/useVaultTree.js` (~L176) | `caps.preview` from resolver, not `previewKindFor(n.mediaType)` |
| Modify | `src/lib/vaultPreview.js` | keep exports for compatibility; `previewKindFor(type)` marked hint-only, used nowhere for authorization |
| Modify | `src/screens/VaultTreeScreen.jsx` | Vault preview modal uses `PreviewModalShell`; signature confirmation before render; memo sniff from thumbnail jobs |
| Modify | `src/lib/vaultUnlockedState.js` | register `capabilityCache.clear` in purge |
| Create | `tests/previewFormats.test.js` | T-DETECT-1 |
| Create | `tests/previewRegistry.test.js` | T-REG-1, T-DL-1, unsupported mapping |
| Create | `tests/previewVaultCapability.test.js` | T-DETECT-2, Vault gate |
| Create | `tests/previewModalShell.test.js` | shell states, Download always present |
| Create | `tests/arbitraryTransferRegression.test.js` | T-UP-1, T-DL-2 (memory DB; PG-gated variant) |
| Create | `tests/helpers/accountClasses.mjs` | `withAccountClasses` |
| Create | `tests/previewAccountNeutrality.test.js` | T-NEUTRAL (runtime + source scan) |

## Interfaces (decisions fixed here)

```ts
// src/lib/preview/formats.js
export const FORMAT_IDS: readonly string[]        // closed enum, spec §5.2
export function normalizeExtension(name: string): string
  // NFC → lower-case → last segment; 'tar.gz' special case; '' when none
export function sniffFormat(head: Uint8Array): string | null
  // signature table only (≤ 4 KiB input); returns FormatId or null
export function detectFormat(input: { head?: Uint8Array | null, name: string, hintMime?: string })
  : { format: string, family: string, basis: 'signature' | 'extension' | 'none', ext: string }
  // rules §5.3: signature wins; extension only when no signature match (text family requires
  // UTF-8/no-NUL check on head when head is present); hintMime never changes `format`

// src/lib/preview/env.js
export function detectPreviewEnv(win?: Window): Readonly<{
  canPlay: Readonly<Record<string, boolean>>,     // keyed by mime, from canPlayType !== ''
  webCodecs: { videoDecode: boolean, videoEncode: boolean, imageDecode: boolean },
  swRange: boolean, webpEncode: boolean, engine: 'chromium' | 'gecko' | 'webkit' | 'other'
}>

// src/lib/preview/registry.js
export const PROVIDERS: ReadonlyArray<PreviewProvider>   // spec §4.1 shape; P0 registers
  // 'image-native', 'animated-native', 'video-native', 'generic' (P1+ append)
export function resolveCapability(
  descriptor: { format: string | null, basis: string, ext: string, size: number,
                formatVersion?: 1 | 2, derivatives?: unknown[] },
  context: 'files' | 'vault',
  env: ReturnType<typeof detectPreviewEnv>,
  opts?: { locked?: boolean }
): FileCapability  // spec §2; download === true always; locked → state 'locked', tile 'icon'
```

`FileCapability.state` is `'available'` with `verify: 'signature'` when `basis === 'extension'` in the Vault (provider must confirm on open); `basis === 'signature'` needs no confirmation.

---

### Task 0: Baseline

**Files:** none (scratchpad only).

- [ ] **Step 1:** Create worktree (master §4.1), `npm ci`.
- [ ] **Step 2:** `npm test 2>&1 | tee "$SCRATCH/p0-baseline.txt"`; extract failing test names to `$SCRATCH/p0-baseline-failures.txt`.
- [ ] **Step 3:** Record `git rev-parse HEAD`. No commit.

### Task 1: Extension normalization and signature table (T-DETECT-1 part A)

**Files:** Create `src/lib/preview/formats.js`, `tests/previewFormats.test.js`.

- [ ] **Step 1 — RED:** tests:
  - `normalizeExtension('IMG_0001.JPG') === 'jpg'`, `'a.Jpg'`, `'a.jpg'` identical; `'x.tar.gz' → 'tar.gz'`; `'README' → ''`; `'.bashrc' → 'bashrc'`; NFC fullwidth-free names unchanged.
  - `sniffFormat` for crafted heads from `tests/helpers/mediaFixtures.mjs` (`craftedPng`, `craftedWebp`, `craftedFtyp`, `craftedGifHeader`) and inline byte literals for JPEG `FF D8 FF`, `%PDF-`, `PK\x03\x04`, `D0 CF 11 E0`, `OggS`, `ID3`, `fLaC`, `RIFF….WAVE`, EBML `1A 45 DF A3`, APNG (`acTL`), animated WebP (`ANIM`); random bytes → `null`.
- [ ] **Step 2 — verify RED:** `node --test --test-concurrency=1 tests/previewFormats.test.js` → fails with `ERR_MODULE_NOT_FOUND` for `src/lib/preview/formats.js`.
- [ ] **Step 3 — GREEN:** implement `FORMAT_IDS`, `normalizeExtension`, `sniffFormat` (pure; no DOM).
- [ ] **Step 4 — verify GREEN:** same command → all pass.
- [ ] **Step 5 — commit:** `feat(idea1): add preview format signature table and extension normalization`.

### Task 2: `detectFormat` resolution rules (T-DETECT-1 part B)

**Files:** Modify `src/lib/preview/formats.js`, `tests/previewFormats.test.js`.

- [ ] **Step 1 — RED:** cases: `.jpg` name + PDF head → `format:'pdf', basis:'signature'`; `.txt` + UTF-8 head → `text`; `.txt` + head with NUL → `unknown`; `.md` no head → `basis:'extension'`; `.docx` + ZIP head → `ooxml-docx` candidate with `basis:'signature'` family `office-document` (provider confirms `[Content_Types].xml` in P5); `.zip` + ZIP head → `zip`; `.svg`/`.html` → text family variants; `hintMime:'image/png'` with PDF head → still `pdf`; no head + `hintMime:'image/jpeg'` + name `photo` → `unknown` (hint never promotes).
- [ ] **Step 2 — verify RED:** `detectFormat is not a function`.
- [ ] **Step 3 — GREEN:** implement per spec §5.3.
- [ ] **Step 4 — verify GREEN.**
- [ ] **Step 5 — commit:** `feat(idea1): resolve preview formats signature-first with MIME as hint only`.

### Task 3: Registry and `resolveCapability` (T-REG-1, T-DL-1)

**Files:** Create `src/lib/preview/registry.js`, `src/lib/preview/env.js`, `tests/previewRegistry.test.js`.

- [ ] **Step 1 — RED:** tests:
  - purity: same inputs → deep-equal outputs across 100 calls; module has no `fetch`/`localStorage`/`indexedDB`/`caches` tokens (source scan).
  - every `(format × context × env-variant)` output has `download === true` (T-DL-1), including `unsupported`, `too-large`, `unsupported-codec`, `integrity-failed`, `locked`.
  - `locked` → `{ state:'locked', tile:'icon', family:'none' }`.
  - `jpeg/png/webp/gif/bmp` → `image-native`; `avif` only when `env.canPlay`-style image support flag true; `heif`/`raw` → `unsupported`; `mp4`/`webm` → `video-native` when `canPlay['video/mp4']` etc. else `unsupported-codec`; `zip`/`unknown` → `generic`/`unsupported`.
  - `detectPreviewEnv({})` (no window APIs) returns all-false snapshot without throwing.
- [ ] **Step 2 — verify RED:** module not found.
- [ ] **Step 3 — GREEN:** implement registry entries for `image-native`, `animated-native`, `video-native`, `generic`; `load` returns lazy renderer references (existing bodies).
- [ ] **Step 4 — verify GREEN.**
- [ ] **Step 5 — commit:** `feat(idea1): add shared preview provider registry and capability resolver`.

### Task 4: Normal Files wiring (behavior-equivalent)

**Files:** Modify `src/lib/filesView.js`; tests `tests/filesPreviewRoute.test.js` (unchanged, must stay green), add cases to `tests/previewRegistry.test.js`.

- [ ] **Step 1 — RED:** assert `filesView.previewKindFor({ ext:'JPG' })` → `'image'` via resolver path (spy import) and `previewKindFor({ ext:'mov' })` → `null` (current behavior preserved); folder/vault → `null`.
- [ ] **Step 2 — verify RED:** spy shows resolver not called.
- [ ] **Step 3 — GREEN:** `previewKindFor` maps `resolveCapability(detectFormat({ name: file.name }) …, 'files', env)` family to `'image' | 'video' | null`; image/video set unchanged in P0.
- [ ] **Step 4 — verify GREEN:** focused tests + `node --test --test-concurrency=1 tests/filesMediaTiles.test.js tests/filesPreviewRoute.test.js tests/mediaRoutes.test.js`.
- [ ] **Step 5 — commit:** `refactor(idea1): route Files preview kind through shared capability resolver`.

### Task 5: Vault capability from content signature (T-DETECT-2)

**Files:** Create `src/lib/preview/capabilityCache.js`, `tests/previewVaultCapability.test.js`; modify `src/lib/useVaultTree.js`, `src/lib/vaultUnlockedState.js`, `src/screens/VaultTreeScreen.jsx`.

- [ ] **Step 1 — RED:** tests (jsdom + `tests/helpers/vaultScreenHarness.js` / `vaultTreeFakeServer.mjs`):
  - node `{ name:'photo.JPG', mediaType:'' }` with JPEG bytes → Preview menu item enabled; thumbnail renders (today: disabled — the defect).
  - node `{ name:'scan.bin', mediaType:'image/png' }` with PDF bytes → no image render; after chunk-0 sniff capability becomes `pdf` family → P0 has no PDF provider → `unsupported` modal + Download.
  - node `{ name:'a.png', mediaType:'image/png' }` with random bytes → opening Preview shows `integrity-failed`/`unsupported` body, Download button present and enabled.
  - `capabilityCache` cleared on lock (`purgeUnlockedVaultState`); `installStorageGuards` shows zero storage reads/writes.
- [ ] **Step 2 — verify RED:** first case fails (`preview` capability false).
- [ ] **Step 3 — GREEN:** `useVaultTree` computes `caps.preview` from `resolveCapability(detectFormat({ name, hintMime: n.mediaType, head: capabilityCache.get(nodeId) }), 'vault', env)`; thumbnail/preview jobs that already decrypt chunk 0 call `capabilityCache.set(nodeId, sniffFormat(head))`; preview open path sniffs first bytes before choosing a renderer. No extra network fetch is introduced for capability.
- [ ] **Step 4 — verify GREEN:** focused + `node --test --test-concurrency=1 tests/vaultTreeScreen.test.js tests/vaultMediaPreview.test.js tests/vaultImageThumb.test.js tests/vaultThumbScheduler.test.js tests/vaultUnlockedState.test.js tests/vaultPreviewCancellation.test.js`.
- [ ] **Step 5 — commit:** `fix(idea1): decide Vault preview capability from content signature, not client MIME`.

### Task 6: Shared modal shell and unsupported fallback (§2, §19)

**Files:** Create `src/components/preview/PreviewModalShell.jsx`, `src/components/preview/PreviewUnsupported.jsx`, `tests/previewModalShell.test.js`; modify `src/screens/Files.jsx` (`FilePreviewModal`), `src/screens/VaultTreeScreen.jsx` (preview modal).

Props: `PreviewModalShell({ t, open, title, meta: { typeLabel, size, modified }, capability, phase: 'loading'|'ready'|'failed', onClose, onDownload, children })`.

- [ ] **Step 1 — RED:** tests: for each `state` value the shell renders name, size, type label, a plain-language reason for non-available states, and an enabled Download button; `phase:'loading'` shows `role="status"`; `failed` shows `role="alert"`; no state renders an infinite spinner (loading has a timeout-to-failed prop honored with fake timers); Files and Vault both render the shell (`data-preview-shell` attribute) — Files existing `data-file-preview-kind/phase` attributes retained.
- [ ] **Step 2 — verify RED:** module not found.
- [ ] **Step 3 — GREEN:** implement shell; move existing `<img>/<video>` bodies inside it unchanged; i18n keys added alongside existing `previewLoading`/`previewUnavailable`.
- [ ] **Step 4 — verify GREEN:** focused + `node --test --test-concurrency=1 tests/filesPreviewRoute.test.js tests/vaultTreeScreen.test.js tests/vaultMediaPreview.test.js`.
- [ ] **Step 5 — commit:** `feat(idea1): share one preview modal shell across Files and Vault`.

### Task 7: Build and bundle check

**Files:** none changed.

- [ ] **Step 1:** `npm run build` → success; note main bundle size delta in scratchpad (resolver/registry must be small; no heavy provider in main chunk).
- [ ] **Step 2:** `git checkout -- dist` (restore tracked dist). `git status --short` shows no `dist/` change.
- [ ] No commit.

### Task 8: Arbitrary upload / byte-exact download regression (T-UP-1, T-DL-2)

**Files:** Create `tests/arbitraryTransferRegression.test.js` (memory mode; honours `TEST_DATABASE_URL` for PG like `tests/fileObjectAuthorization.test.js`).

- [ ] **Step 1 — RED-first check:** write tests for Normal Files V1 upload (`POST /api/files/upload`), Normal Files V2 resumable session, and Vault V2 session with (a) random 256 KiB bytes named `blob.xyz`, (b) no extension `README`, (c) misleading `photo.jpg` containing PDF bytes, (d) 0-byte file; then download and compare SHA-256. Also assert download headers `Content-Type: application/octet-stream`, `Content-Disposition: attachment`, `nosniff` for all.
  - Expected: these pass **immediately** (behavior already correct). This is a characterization test; record "GREEN on first run — invariant pinned" in the commit body. To prove the test can fail, temporarily add a throwaway extension gate in a local scratch copy (not committed) and observe failure, then discard.
- [ ] **Step 2:** `node --test --test-concurrency=1 tests/arbitraryTransferRegression.test.js` → pass (memory); `bash scripts/pg-integration-env.sh node --test --test-concurrency=1 tests/arbitraryTransferRegression.test.js` → pass (PG).
- [ ] **Step 3 — commit:** `test(idea1): pin arbitrary upload and byte-exact download for all types`.

### Task 9: Account neutrality (T-NEUTRAL)

**Files:** Create `tests/helpers/accountClasses.mjs`, `tests/previewAccountNeutrality.test.js`.

`withAccountClasses(baseUrl, fn)` logs in `ADMIN`, `EXISTING_USER`, creates and logs in `NEWLY_CREATED_USER` (Admin `POST /api/users`), and calls `fn(client, className)` for each.

- [ ] **Step 1 — RED:** tests:
  - runtime: each class uploads the same four files (Task 8 set + a JPEG), requests `/api/files/:id/preview` for its own JPEG (200, identical headers) and for another class's JPEG (404 + no body leak); media-info batch for foreign ids → `NOT_FOUND`; Admin gets 404 on user files (no override).
  - source scan: files under `src/lib/preview/**`, `src/components/preview/**` contain none of `/\brole\b|ROLES|isAdmin|username|userId|user\.id|accountAge/`.
  - capability parity: `resolveCapability` output for the same descriptor is identical regardless of which class's session produced it (inputs contain no account data — assert the descriptor type has no account field).
- [ ] **Step 2 — verify RED:** helper module not found.
- [ ] **Step 3 — GREEN:** implement helper (tests only; no product change expected). If any runtime assertion fails, STOP: that is an existing authorization defect — report, do not patch silently.
- [ ] **Step 4 — verify GREEN:** memory + PG commands as Task 8.
- [ ] **Step 5 — commit:** `test(idea1): prove preview capability and access parity across account classes`.

### Task 10: Phase regression, governance, handoff

- [ ] **Step 1:** `npm test`; diff failing names against `p0-baseline-failures.txt` → no new failures.
- [ ] **Step 2:** Core entry guards unaffected, but Files.jsx changed — run `node --test --test-concurrency=1 tests/authBackBoundaryR4.test.js tests/shellThemeR4.test.js tests/loginExperienceR3.test.js tests/themeAuthTransition.test.js`.
- [ ] **Step 3:** `npm run build && git checkout -- dist`.
- [ ] **Step 4:** Storage scan: `node --test --test-concurrency=1 tests/vaultPreviewSession.test.js tests/vaultThumbScheduler.test.js` (existing SA-1/SA-SW-1 scans) + new source-scan in Task 9.
- [ ] **Step 5:** `git diff --check`; `git diff --name-status origin/main...HEAD`; collaboration policy validation (master §4.3).
- [ ] **Step 6:** Obsidian receipt `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/<ts>_kla_idea1-preview-p0-capability-foundation.md`; update `idea1/idea1-status.md` durable facts.
- [ ] **Step 7:** Push branch; open Draft PR (only when the Human authorizes PR creation for execution).

## Rollback boundary

Pure client + tests. Revert the PR to roll back. No data, manifest, or server state is written.

## Human review gate (G-P0)

Human verifies spec §37 rows H1, H2 (upload/download arbitrary), H13 (unsupported fallback, Download works), H15 (cross-account 404), and that Vault `.JPG` with empty MIME now previews. Approval unblocks P1 and P2a.
