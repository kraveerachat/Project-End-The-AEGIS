# IDEA1 Unified Preview — P1 Audio, Text Family, and Normal Files Inline Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** First-class audio preview (MP3 required; other browser-playable formats by capability) and text-family preview (TXT, Markdown, JSON, CSV/TSV, source-like text; SVG/HTML/XML shown as source only) in **both** Normal Files and the Private Vault, with the Normal Files `/preview` route extended additively and its fast poster/motion derivative pipeline left untouched.

**Architecture:** The single server allowlist in `server/config/previewMedia.js` becomes a format table that separates *inline-previewable* entries from *derivative-eligible* entries, so the derivative pipeline keeps its exact current 9-extension set. `/preview` gains a head-signature check (after the owner gate) using a server copy of the P0 signature table, kept identical by a parity test. Client providers are added to the P0 registry. Markdown and CSV use small in-house parsers so P1 introduces **no third-party parsing dependency** (D-6 not triggered).

**Tech Stack:** Express, Node streams, React 19, native `<audio>`, `TextDecoder`, `node:test`, jsdom.

**Spec:** §4.2, §5, §6.2 items 1–3, §17, §18.2, §35 T6/T11, §36 T-NF-AUDIO/TEXT, T-TEXT, T-AUDIO, §37 H3, H9, H11, H15, H16.

**Depends on:** P0 merged. **Branch:** `feat/idea1-preview-p1-audio-text` from `origin/main`.

## Global Constraints

- Master plan §3 block applies verbatim.
- `NORMAL_FILES_POSTER_MOTION_PIPELINE=UNCHANGED`: `server/media/**`, `server/routes/media.js`, `src/lib/mediaApi.js`, `src/lib/mediaTile.js`, `src/components/MediaThumb.jsx` behaviour must not change; the set of derivative-eligible extensions stays exactly `jpg jpeg png gif webp avif bmp mp4 webm`.
- `/preview` keeps, in order: `requireAuth` → row missing 404 → owner mismatch 404 + `FILE_PREVIEW DENIED` → Vault 404 + DENIED → folder 400 → inline format entry (415 if none) → storage existence (404 + DENIED) → head signature check (415 on mismatch) → headers. Headers keep `nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, `Cross-Origin-Resource-Policy: same-origin`, `Accept-Ranges: bytes`, `Cache-Control: private, no-store`.
- SVG/HTML/XML are never served with an active MIME: they are `text/plain; charset=utf-8`.
- No new npm dependency.
- The grid issues **no new request type** for audio/text tiles (no media-info calls for non-derivative files).

## File Map

| Action | Path | Responsibility |
|---|---|---|
| Modify | `server/config/previewMedia.js` | `FORMAT_TABLE` (`ext → { formatId, family, inlineMime, derivative }`); `isPreviewableExtension` = derivative-eligible only (unchanged set); `previewMimeForName` = any inline entry |
| Create | `server/config/formatSignatures.js` | server copy of the signature table (server image ships only `server/` + `dist/`, so it cannot import `src/`) |
| Modify | `server/routes/api.js` `GET /files/:id/preview` | head signature check after owner gate; 415 on family mismatch |
| Modify | `server/media/derivatives.js` (`info`/`infoBatch` output only) | add `format` to media-info items already being returned; no scheduling change |
| Modify | `src/lib/preview/registry.js` | register `audio-native`, `text-plain`, `markdown-safe`, `json-view`, `csv-table` |
| Create | `src/lib/preview/markdownLite.js` | bounded Markdown subset → plain AST (no HTML) |
| Create | `src/lib/preview/csvLite.js` | RFC 4180 subset parser, row/column caps |
| Create | `src/lib/preview/textHead.js` | `readTextHead(source, { maxBytes })` for Files (Range) and Vault (decrypted chunks) |
| Create | `src/components/preview/providers/AudioPreview.jsx` | native audio renderer |
| Create | `src/components/preview/providers/TextPreview.jsx`, `MarkdownPreview.jsx`, `JsonPreview.jsx`, `CsvPreview.jsx` | text renderers (React elements / `textContent` only) |
| Modify | `src/lib/vaultPreviewResponder.js` | non-`video/*` SW responses add `nosniff` + sandbox CSP (§18.1) |
| Modify | `src/lib/vaultTreeLimits.js` + `tests/vaultTreeLimits.test.js` | add `audioWholeDecryptMaxBytes` (provisional, measured in Task 9) and `textPreviewMaxBytes: 1 MiB` |
| Modify | `src/screens/Files.jsx`, `src/screens/VaultTreeScreen.jsx` | mount new providers inside `PreviewModalShell` |
| Create | tests listed per task | |

## Interfaces

```ts
// server/config/previewMedia.js
export const FORMAT_TABLE: Readonly<Record<string, {
  formatId: string, family: 'image'|'animated-image'|'video'|'audio'|'text',
  inlineMime: string, derivative: 'poster+motion' | 'none' }>>
export const PREVIEW_MIME      // UNCHANGED 9-entry object (derivative-eligible), kept for derivatives.js
export function isPreviewableExtension(ext: string): boolean   // derivative-eligible only (unchanged)
export function inlineEntryForName(name: string): (typeof FORMAT_TABLE)[string] | null
export function previewMimeForName(name: string): string | null // now any inline entry

// server/config/formatSignatures.js
export function sniffFormatServer(head: Buffer): string | null   // must equal client sniffFormat on the parity corpus
export function familyMatches(entry, sniffed: string | null, head: Buffer): boolean
  // image/video/audio: sniffed family must equal entry.family
  // text: sniffed === null AND head is valid UTF-8/UTF-16-BOM with no NUL in first 8 KiB

// src/lib/preview/textHead.js
export async function readTextHead(source:
  { kind: 'files', url: string } | { kind: 'vault', readPlainRange: (start: number, end: number) => Promise<Uint8Array> },
  opts: { maxBytes: number, signal?: AbortSignal }
): Promise<{ text: string, truncated: boolean, encoding: 'utf-8'|'utf-16le'|'utf-16be' }>

// src/lib/preview/markdownLite.js
export function parseMarkdownLite(src: string, opts?: { maxNodes?: number }): MdNode[]
  // supported: ATX headings, paragraphs, emphasis/strong, inline code, fenced code, ordered/unordered lists,
  // blockquote, horizontal rule, links (href kept as text + inert attribute), no images, no raw HTML (escaped as text)

// src/lib/preview/csvLite.js
export function parseDelimited(src: string, opts: { delimiter: ',' | '\t', maxRows: 1000, maxCols: 50 })
  : { rows: string[][], truncatedRows: boolean, truncatedCols: boolean }
```

Audio MIME map (client and server): `mp3 → audio/mpeg`, `m4a → audio/mp4`, `aac → audio/aac`, `ogg|oga|opus → audio/ogg`, `wav → audio/wav`, `flac → audio/flac`, `weba → audio/webm`.

Text extensions (inline `text/plain; charset=utf-8`): `txt log md markdown json csv tsv xml svg html htm css js mjs cjs ts tsx jsx py java c h cpp hpp cs go rs rb php sh ps1 bat yml yaml toml ini cfg conf sql kt swift`.

---

### Task 0: Baseline

- [ ] Worktree + `npm ci`; `npm test` → save failing names to `$SCRATCH/p1-baseline-failures.txt`; record the p50 of `tests/mediaResponsiveness.test.js` timings if it reports them.

### Task 1: Format table preserves the derivative set

**Files:** Modify `server/config/previewMedia.js`; create `tests/previewFormatTable.test.js`.

- [ ] **Step 1 — RED:** tests: `PREVIEW_MIME` keys deep-equal the current 9; `isPreviewableExtension('mp3') === false`; `isPreviewableExtension('JPG') === true`; `previewMimeForName('song.MP3') === 'audio/mpeg'`; `previewMimeForName('page.svg') === 'text/plain; charset=utf-8'`; `previewMimeForName('a.docx') === null` (P5); `inlineEntryForName('x.tar.gz') === null`.
- [ ] **Step 2 — verify RED:** `node --test --test-concurrency=1 tests/previewFormatTable.test.js` → `FORMAT_TABLE` undefined / mp3 mime null.
- [ ] **Step 3 — GREEN:** add `FORMAT_TABLE`, derive `PREVIEW_MIME` from `derivative !== 'none'` entries.
- [ ] **Step 4 — verify GREEN** + `node --test --test-concurrency=1 tests/mediaDerivatives.test.js tests/mediaUploadEnqueue.test.js tests/mediaRoutes.test.js tests/filesMediaTiles.test.js` (derivative behaviour unchanged).
- [ ] **Step 5 — commit:** `feat(idea1): split inline preview formats from derivative-eligible formats`.

### Task 2: Server signature table + parity with client

**Files:** Create `server/config/formatSignatures.js`, `tests/formatSignatureParity.test.js`.

- [ ] **Step 1 — RED:** a shared fixture corpus (same byte literals/crafted helpers as `tests/previewFormats.test.js`) fed to client `sniffFormat` and server `sniffFormatServer`; assert identical output for every item; `familyMatches` truth table for text (UTF-8 ok, NUL rejected, UTF-16 BOM ok).
- [ ] **Step 2 — verify RED:** module not found.
- [ ] **Step 3 — GREEN:** implement server copy (Buffer-based).
- [ ] **Step 4 — verify GREEN.**
- [ ] **Step 5 — commit:** `feat(idea1): add server format signatures with client parity test`.

### Task 3: `/preview` audio + text with signature check (T-NF-AUDIO/TEXT)

**Files:** Modify `server/routes/api.js`; extend `tests/filesPreviewRoute.test.js`.

- [ ] **Step 1 — RED:** tests using `tests/helpers/accountClasses.mjs`:
  - owner requests `song.mp3` (ID3 head) → 200 `audio/mpeg`, Range `bytes=0-99` → 206 with correct `Content-Range`; headers include nosniff, sandbox CSP, CORP, no-store.
  - `notes.md` (UTF-8) → 200 `text/plain; charset=utf-8`; `page.html` / `icon.svg` → `text/plain; charset=utf-8` (never `text/html`/`image/svg+xml`).
  - `fake.mp3` containing PNG bytes → 415; `bin.txt` containing NUL bytes → 415.
  - existing image/video fixtures → unchanged 200 responses (regression).
  - ordering: cross-owner request for a mismatching file → 404 (not 415), DENIED audited; Vault row → 404; folder → 400; Admin on user file → 404.
  - all three account classes produce identical headers for their own files.
- [ ] **Step 2 — verify RED:** mp3 → 415 today (not in allowlist).
- [ ] **Step 3 — GREEN:** after folder check, `entry = inlineEntryForName(file.name)` (415 if null); after the existing storage-existence check, read ≤ 8 KiB head from the resolved path; `familyMatches` else 415; then existing streaming with `entry.inlineMime`.
- [ ] **Step 4 — verify GREEN:** focused (memory) + `bash scripts/pg-integration-env.sh node --test --test-concurrency=1 tests/filesPreviewRoute.test.js tests/fileObjectAuthorization.test.js`.
- [ ] **Step 5 — commit:** `feat(idea1): serve audio and text previews with signature verification`.

### Task 4: media-info `format` (additive field)

**Files:** Modify `server/media/derivatives.js` (response shaping only); extend `tests/mediaRoutes.test.js`.

- [ ] **Step 1 — RED:** media-info for an owned JPEG includes `format: 'jpeg'`; for an owned `.mp4` `format: 'mp4'`; response shape otherwise deep-equal to before (snapshot of keys); Vault/foreign ids still `NOT_FOUND`.
- [ ] **Step 2 — verify RED:** `format` undefined.
- [ ] **Step 3 — GREEN:** derive from the probe result already computed, falling back to `inlineEntryForName(name).formatId`; no extra I/O on the batch path.
- [ ] **Step 4 — verify GREEN:** + `node --test --test-concurrency=1 tests/mediaResponsiveness.test.js tests/mediaDerivatives.test.js tests/filesMediaTiles.test.js`; compare responsiveness to Task 0 (no regression beyond noise).
- [ ] **Step 5 — commit:** `feat(idea1): expose detected format in media-info`.

### Task 5: Audio provider — Normal Files (MP3 required) (T-AUDIO)

**Files:** Create `src/components/preview/providers/AudioPreview.jsx`, `tests/previewAudio.test.js`; modify `src/lib/preview/registry.js`, `src/screens/Files.jsx`.

Props: `AudioPreview({ t, src, fileName, onPhase })`.

- [ ] **Step 1 — RED:** jsdom tests: registry maps `mp3` → `audio-native` when `env.canPlay['audio/mpeg']`, else `unsupported-codec` (Download present); rendered `<audio controls preload="metadata">` with `aria-label` containing the file name; `loadedmetadata` → phase ready + duration text; `waiting` → `role="status"` buffering text; `error` → `role="alert"` + Download still enabled; keyboard: the element is focusable and not wrapped in a focus trap that blocks Space/arrow keys; Files modal for `song.MP3` mounts the provider with `src = apiUrl(previewPathFor(file))`.
- [ ] **Step 2 — verify RED:** provider missing.
- [ ] **Step 3 — GREEN.**
- [ ] **Step 4 — verify GREEN** + `node --test --test-concurrency=1 tests/previewModalShell.test.js tests/filesPreviewRoute.test.js`.
- [ ] **Step 5 — commit:** `feat(idea1): add first-class audio preview for Files`.

### Task 6: Audio provider — Vault

**Files:** Modify `src/screens/VaultTreeScreen.jsx`, `src/lib/vaultTreeLimits.js`, `tests/vaultTreeLimits.test.js`; create `tests/vaultAudioPreview.test.js`.

- [ ] **Step 1 — RED:** tests with `vaultTreeFakeServer.mjs`: V2 MP3 ≤ `audioWholeDecryptMaxBytes` → whole decrypt → Blob URL registered with `unlockedState`; V2 larger → SW session opened with `contentType: 'audio/mpeg'` taken from the **detected** format (spy on `openSession`), not from `mediaType`; V1 above cap → `too-large` + Download; lock revokes URL and closes session; `installStorageGuards` zero writes. In `tests/vaultPreviewResponder.test.js`: every SW session response whose content type is not `video/*` (audio, and later PDF/text) carries `X-Content-Type-Options: nosniff` and `Content-Security-Policy: default-src 'none'; sandbox` (spec §18.1); video responses unchanged; `Cache-Control: no-store` retained.
- [ ] **Step 2 — verify RED.**
- [ ] **Step 3 — GREEN:** add limits `audioWholeDecryptMaxBytes: 32 MiB` (provisional) and `textPreviewMaxBytes: 1 MiB` with a Limits Register comment; update `tests/vaultTreeLimits.test.js` table in the same commit.
- [ ] **Step 4 — verify GREEN** + `node --test --test-concurrency=1 tests/vaultPreviewSession.test.js tests/vaultPreviewResponder.test.js tests/vaultUnlockedState.test.js tests/vaultTreeLimits.test.js`.
- [ ] **Step 5 — commit:** `feat(idea1): add audio preview to the Private Vault`.

### Task 7: Text head reader + plain/source provider (T-TEXT part A)

**Files:** Create `src/lib/preview/textHead.js`, `src/components/preview/providers/TextPreview.jsx`, `tests/previewText.test.js`.

- [ ] **Step 1 — RED:** `readTextHead` Files source sends `Range: bytes=0-1048575` and reports `truncated` when `Content-Range` total > 1 MiB; Vault source requests only the plaintext range `[0, 1 MiB)` through `readPlainRange`; UTF-16 BOM decode; invalid UTF-8 replaced (no throw). `TextPreview` renders via `textContent` in `<pre>`: an HTML file containing `<script>alert(1)</script>` and an SVG with `onload=` appear as literal text; `container.querySelector('script, svg, iframe')` is null; truncation banner shown.
- [ ] **Step 2 — verify RED.**
- [ ] **Step 3 — GREEN.**
- [ ] **Step 4 — verify GREEN.**
- [ ] **Step 5 — commit:** `feat(idea1): add bounded plain and source text preview`.

### Task 8: Markdown, JSON, CSV/TSV providers (T-TEXT part B)

**Files:** Create `src/lib/preview/markdownLite.js`, `src/lib/preview/csvLite.js`, `src/components/preview/providers/MarkdownPreview.jsx`, `JsonPreview.jsx`, `CsvPreview.jsx`, `tests/markdownLite.test.js`, `tests/csvLite.test.js`; extend `tests/previewText.test.js`.

- [ ] **Step 1 — RED:**
  - `parseMarkdownLite`: headings/lists/code/blockquote; raw `<img src=x onerror=…>` becomes a text node; `[x](javascript:alert(1))` rendered as inert text/link without `href` execution (rendered anchor has no `href`, shows target text); node cap enforced.
  - `parseDelimited`: quoted fields, escaped quotes, CRLF, TSV, row cap 1000 and column cap 50 with truncation flags.
  - JSON: valid → indented tree/pre; invalid → falls back to plain text view with a notice; > 1 MiB → head only + notice.
  - Renderers never call `dangerouslySetInnerHTML` (source scan of `src/components/preview/providers/*.jsx`).
- [ ] **Step 2 — verify RED.**
- [ ] **Step 3 — GREEN.**
- [ ] **Step 4 — verify GREEN.**
- [ ] **Step 5 — commit:** `feat(idea1): add Markdown, JSON, and CSV previews without active content`.

### Task 9: Measure provisional Vault audio cap

**Files:** scratchpad evidence; possibly `src/lib/vaultTreeLimits.js` value + test table.

- [ ] **Step 1:** In Chromium (Edge/Chrome), unlock a test Vault, preview a 32 MiB MP3 via whole decrypt; record process-tree peak memory using the existing native measurement method (see IDEA1 vault image native-memory harness notes); repeat for 64 MiB.
- [ ] **Step 2:** If peak exceeds `memoryCeilingBytes` headroom, lower the cap (larger files use the SW session path). Update value + test table + evidence comment. Commit only if changed: `chore(idea1): pin measured Vault audio whole-decrypt cap`.

### Task 10: Regression, governance, handoff

- [ ] `npm test` vs baseline — no new failures.
- [ ] Normal Files regression set: `node --test --test-concurrency=1 tests/mediaRoutes.test.js tests/mediaDerivatives.test.js tests/mediaPoster.test.js tests/mediaMotion.test.js tests/mediaResponsiveness.test.js tests/filesMediaTiles.test.js tests/filesPreviewRoute.test.js tests/arbitraryTransferRegression.test.js tests/previewAccountNeutrality.test.js`.
- [ ] PG: `bash scripts/pg-integration-env.sh node --test --test-concurrency=1 tests/filesPreviewRoute.test.js tests/arbitraryTransferRegression.test.js tests/previewAccountNeutrality.test.js`.
- [ ] `npm run build && git checkout -- dist`.
- [ ] `git diff --check`; policy validation; receipt + `idea1-status.md` update; push; Draft PR only when authorized.

## Rollback boundary

Code revert. The format table split keeps `PREVIEW_MIME` identical, so reverting cannot affect cached derivatives.

## Human review gate

Human verifies §37 H3 (Files thumbnails unchanged), H9 (**MP3 play/pause/seek/duration** in Files and Vault; M4A/WAV/FLAC/OGG by browser capability; unsupported → message + Download), H11 (TXT/MD/JSON/CSV readable; SVG/HTML as source), H15 (cross-account 404), H16 (download/authorization unchanged), on ADMIN, EXISTING_USER, NEWLY_CREATED_USER.
