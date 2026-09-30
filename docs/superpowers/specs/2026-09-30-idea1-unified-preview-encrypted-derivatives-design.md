# IDEA1 Unified File Capability, Preview Providers, and Encrypted Vault Derivatives — Design

- **Status:** FINAL APPROVED FOR IMPLEMENTATION PLANNING (2026-09-30) — Human
  Owner final spec approval recorded (`HUMAN_FINAL_SPEC_APPROVAL=APPROVED`,
  `IMPLEMENTATION_PLANNING=APPROVED`); D-1…D-11 in Appendix A remain binding.
  Runtime implementation remains phase-gated by the approved plans under
  `docs/superpowers/plans/2026-09-30-idea1-unified-preview-*.md`.
- **Date:** 2026-09-30
- **Area / owner:** `idea1` / `kla`
- **Repository truth:** `origin/main` at `5df959055075171ea5734238aa83693371d00d9d`
- **Scope group:** GROUP A — file capability + preview (active). GROUP B —
  upload/download throughput — is **deferred** and not reopened here.
- **Supersedes (D-10 approved 2026-09-30):** the "all Vault derivatives are ephemeral client
  products" clause of
  `docs/superpowers/specs/2026-09-19-idea1-private-vault-encrypted-hierarchy-design.md` §16
  (see §9.4 and Decision D-10). Every other clause of that spec, and all of
  `docs/superpowers/specs/2026-09-18-pr150-media-preview-pipeline-design.md`,
  remains in force unless a section below says otherwise.
- **No runtime code, no implementation plan, no deployment is part of this document.**

---

## 0. Repository truth and evidence reconciliation

Everything in this section was verified against source at the SHA above, not
inferred from older documents.

### 0.1 Normal Files (server-side derivatives, already fast)

| Fact | Evidence |
|---|---|
| One preview allowlist for route + derivative pipeline: `jpg jpeg png gif webp avif bmp mp4 webm`. No audio, PDF, text, office, SVG. | `server/config/previewMedia.js` (`PREVIEW_MIME`) |
| Extension is taken from the DB file name, lower-cased (`name.toLowerCase().split('.').pop()`); `.JPG` and `.jpg` already resolve identically for Normal Files. | `previewExtForName`; `server/db/store.js` `displayTypeFor` |
| Client preview kind mirrors that allowlist: image = 7 exts, video = `mp4`/`webm`; `file.ext` is already lower-cased server-side. | `src/lib/filesView.js` `PREVIEW_IMAGE_EXTS`, `PREVIEW_VIDEO_EXTS`, `previewKindFor` |
| Derivative identity = `files.sha256` + profile (`MEDIA_PROFILE_VERSION='v1'`) + type; URLs carry `v=<sha256>&p=<profile>`; stale → 404; ready → `private, max-age=31536000, immutable` + `Vary: Cookie`. | `server/routes/media.js`, `server/config/mediaLimits.js` |
| Poster: ≤ 640×360 WebP (q80, retry q60, PNG fallback) via sharp or FFmpeg; motion: 480×270, 12 fps, 6 s, H.264 CRF 28 / maxrate 1200k, no audio, ≤ 4 MiB. | `server/media/poster.js`, `server/media/motion.js`, `mediaLimits.js` |
| Grid uses one in-flight `POST /api/files/media-info/batch` (≤ 64 ids) with bounded polling (15 s cap, 120 s stall). | `src/lib/mediaApi.js` |
| Vault rows are refused at route **and** service level; the service never sees a Vault key. | `routes/media.js` `ownedFileOr404`, `derivatives.js` `hidden()` |
| Download is always `application/octet-stream` + `attachment` + `nosniff`, independent of type. | `server/routes/api.js` (download handlers ~L673, ~L1123) |
| Original preview route: owner gate before Range/MIME, `inline`, `nosniff`, `CSP: default-src 'none'; sandbox`, `CORP: same-origin`, `no-store`; 415 outside allowlist. | `server/routes/api.js` `GET /files/:id/preview` |
| No extension/MIME allowlist exists on any upload route (Normal V1/V2, Vault V1/V2, tree uploads). Arbitrary binary upload is **already** accepted; this spec turns that into a tested invariant. | `routes/uploads.js`, `routes/api.js`, `routes/vaultUploads.js`, `routes/vaultTreeUploads.js` (no type gate found) |
| App CSP: `script-src 'self' 'wasm-unsafe-eval'`, `img-src 'self' data: blob:`, `media-src 'self' blob:`, `connect-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`. | `server/middleware/securityHeaders.js` |

### 0.2 Private Vault (client-only, Zero-Knowledge)

| Fact | Evidence |
|---|---|
| Key hierarchy: passphrase →Argon2id→ KEK; per-file random DEK wrapped by KEK (V1 and V2 identical at the envelope layer); tree: KEK wraps TRK (two slots), TRK wraps a per-revision Manifest DEK. All CryptoKeys non-extractable. | `src/lib/vaultCrypto.js`, `src/lib/vaultChunkCrypto.js`, `src/lib/vaultTreeKeys.js` |
| V2 blob = many independent AES-GCM messages, random 96-bit IV per chunk, AAD `"AEGIS-VLT2" ‖ contentId(16) ‖ index(u32be) ‖ count(u32be)`; metadata `{name,type,plainSize}` encrypted with DEK + AAD. Client-chosen plaintext chunk size 8–64 MiB, default **32 MiB**. | `vaultChunkCrypto.js`, `server/config/vaultTransferLimits.js`, `routes/vaultUploads.js` L182–217 |
| Server tables hold no name/MIME/thumbnail column (`vault_v2_blobs`, `vault_tree_*`). Blob lifecycle (`UNREFERENCED → TREE_MANAGED → PURGE_PENDING → PURGED`) is driven by `attachBlobIds`/`purgeBlobIds` in the head CAS; physical purge is flag-gated. | `server/db/schema.sql`, `migrations/011_vault_tree_v1.sql`, `routes/vaultTree.js` `POST /head` |
| Manifest node key set is **closed**: `nodeId kind parentNodeId name createdAtClient modifiedAtClient lifecycle blobRef mediaType plainSize`; unknown key → `ManifestError('UNKNOWN_KEY')`; `MANIFEST_SCHEMA_VERSION = 1`; blob formats `{1,2}`. | `src/lib/vaultTreeManifest.js`, `src/lib/vaultTreeCanonical.js` |
| `mediaType` is the browser's `File.type` at upload time (client hint, may be `''`). | `src/lib/vaultTreeUpload.js` L45 |
| **Vault preview capability is decided from `mediaType` alone** (`previewKindFor(n.mediaType)` — image: jpeg/png/gif/webp; video: mp4/webm/ogg). A file whose `File.type` was empty or unusual gets no preview even when its bytes are a valid JPEG. Content sniffing (`sniffImageFormat`) exists but only *after* the MIME gate admits the file. | `src/lib/useVaultTree.js` L176, `src/lib/vaultPreview.js`, `src/lib/vaultImageFormats.js` |
| Image tiles: decrypt the **original** each unlock, decode (normal lane ≤ 16 MP; reduced JPEG lane ≤ 152 MP via worker `ImageDecoder`), poster ≤ 512 px long edge, Object URL in an LRU of 256, 4 concurrent jobs, 256 MiB estimated ceiling. | `vaultImageThumb.js`, `vaultImageReducedDecode.js`, `vaultThumbScheduler.js`, `vaultTreeLimits.js` |
| Video poster: opens a Service-Worker range-decryption session on the **original**, seeks a representative frame, draws a JPEG, closes the session — **every unlock, every tile**. Hover opens a session on the **original** too. | `src/lib/vaultVideoPreview.js` `openVideoPoster`, `openVideoMotion` |
| SW responder streams one chunk at a time, stops on first AEAD failure, no Cache API, `no-store`; read-ahead window bounded by a 64 MiB plaintext budget independent of file size. | `vaultPreviewResponder.js`, `vaultPreviewWorkerState.js`, `vaultPreviewReadAhead.js` |
| Chunk read route audits `VAULT_V2_READ` on **every chunk-0 read**; V2 whole-blob GET returns 409 (chunk route only). | `server/routes/api.js` `GET /vault/blobs/:id/chunks/:index` |
| Lock/logout boundary `purgeUnlockedVaultState(reason)` aborts work, revokes Object URLs, closes SW tokens, drops keys. | hierarchy spec §17, `vaultUnlockedState.js` |

### 0.3 Why the Vault is slow (causal chain, not a guess)

1. A video tile poster requires the browser `<video>` element to read container
   metadata and one representative frame from the **original**. With 32 MiB
   plaintext chunks, that is at least one full 32 MiB chunk (usually two — MP4
   files whose `moov` box is at the tail need the last chunk as well), fetched
   and AEAD-decrypted before any pixel exists.
2. `START_LIVE.mp4` is 1,206,241,622 bytes over ~120 s ≈ **10 MB/s (~80 Mbps)**
   average media rate (`vaultPreviewReadAhead.js` header).
3. PR216 proved a **100 Mbps router-trunk ceiling** on the shared path
   (`2026-09-29-idea1-transfer-throughput-optimization-implementation.md`
   Completion Gate: `P1_SHARED_PATH_CAPACITY_LIMITER`), and the Remote path is
   materially below that.
4. Therefore: poster cost ≈ 32–64 MiB per tile per unlock (seconds to tens of
   seconds Remote); playback of an ~80 Mbps original over a path that cannot
   sustain ~80 Mbps **must** starve, whatever the read-ahead window. No bounded
   cache or memory increase can fix a bitrate that exceeds capacity.
5. Normal Files is fast because its tiles fetch a ~20–100 KB poster and a
   ≤ 4 MiB motion clip produced once and cached — not the original.

Conclusion: the Vault needs **small, persisted derivatives** exactly like Normal
Files, but produced and encrypted **in the browser**. That is the core of this
design.

### 0.4 Diagnostic findings carried forward

- `DRIVE_SERVER_CPU_BOTTLENECK=NOT_PROVEN`, `CONNECTOR_CPU_BOTTLENECK=NOT_PROVEN`.
  Short-lived high-CPU `node` processes were host telemetry collectors
  (`run-twingate-health.js`, `run-disk-health.js`), not Drive. This design adds
  **no** server CPU work for the Vault and does not change Normal Files'
  server media pipeline.
- Throughput plan Task 8 (secondary preview responsiveness) stays **deferred**
  for GROUP B purposes. This spec replaces Task 8 Step 2's Vault clause
  ("bounded read-ahead/range coalescing only") with encrypted derivatives, and
  reuses Task 8 Step 1's metrics (TTFB, time-to-first-frame, spinner duration,
  Range request count, seek recovery) as acceptance measurements (§37).

---

## 1. Goals and non-goals

### 1.1 Goals

1. **G-UP:** any file type uploads into Normal Files and the Vault, limited only by
   existing name, size, ownership, integrity, and isolation rules.
2. **G-DOWN:** any stored file downloads as its exact original bytes; download is
   a separate capability from preview and never depends on it.
3. **G-CAP:** one user-facing capability model and one provider registry shared by
   both contexts; new providers are additive.
4. **G-DETECT:** format detection is case-insensitive and content-verified; the
   client MIME is never trusted to authorize inline rendering.
5. **G-FAMILIES:** still image, animated image, video, audio, PDF, text family,
   common office documents, and a graceful unsupported fallback.
6. **G-VAULT-PERF:** Vault tile/poster latency approaches Normal Files after
   unlock through **client-generated, client-encrypted** derivatives; large-video
   preview uses a low-bitrate encrypted proxy sized to measured capacity.
7. **G-ZK:** no Vault plaintext on the server, no server-generated Vault
   derivative, no persistent decrypted cache; lock/logout releases everything.
8. **G-NOREG:** no measurable regression to Normal Files thumbnails, hover,
   posters, download, or authorization.
9. **G-NEUTRAL:** identical behavior for Admin, existing, and future accounts.

### 1.1a Human-approved final product scope (binding)

1. The Normal Files thumbnail/poster path is already fast. Preserve it; do not
   rewrite it for symmetry (`NORMAL_FILES_THUMBNAIL_REGRESSION_ALLOWED=NO`).
2. The Vault thumbnail/poster path is the main cover-speed optimization target:
   approach Normal Files perceived responsiveness while preserving Zero-Knowledge
   (`VAULT_THUMBNAIL_OPTIMIZATION=REQUIRED`).
3. Click-to-Preview improvements apply to **both** Normal Files and the Private
   Vault (`BOTH_CONTEXT_CLICK_PREVIEW=REQUIRED`).
4. Preview capability applies identically to Admin, current accounts, and
   future/new accounts (`ACCOUNT_NEUTRALITY=REQUIRED`).
5. Upload: arbitrary binary files remain accepted independent of preview support
   (`ARBITRARY_UPLOAD=REQUIRED`).
6. Download: exact original bytes remain downloadable independent of preview
   support (`ARBITRARY_DOWNLOAD=REQUIRED`).
7. Preview is capability-based — not a promise to decode every historical or
   proprietary format.
8. Required preview families: image, animated image, video, audio **including
   MP3** (`MP3_AUDIO_PREVIEW=REQUIRED`), PDF, text/Markdown/JSON/CSV/source-like
   text, and common Office formats where a safe provider exists.
9. Unsupported preview: stable metadata/icon state, Download available, no crash,
   no endless spinner.
10. Video acceptance: preview, poster, and playback are the best safely
    achievable under the measured hardware/network ceiling. **Zero buffering and
    Google Drive quality/performance parity are NOT requirements.**

### 1.2 Non-goals

- **GROUP B — upload/download throughput optimization remains DEFERRED**
  (`GROUP_B_THROUGHPUT_SCOPE=DEFERRED`): chunk-size tuning of originals **or of
  the global V2 minimum** (D-3), transport concurrency, network/hardware
  remediation. GROUP A uses measured throughput only to choose proxy vs original
  (§16.2, §33).
- Claiming that every format can be previewed. Unsupported formats get a stable
  generic representation and download.
- Server-side Vault processing of any kind; server-side decryption.
- Executing user content: no SVG/HTML rendering as active documents, no PDF
  JavaScript, no Office macros, no `<object>`/`<embed>`.
- Public sharing of previews; search/indexing of content.
- Replacing the Normal Files derivative pipeline for symmetry.
- Editing documents.

---

## 2. User-visible capability contract

Every file row/tile in both contexts exposes one `FileCapability` value computed
by the same pure resolver (§4):

```ts
type PreviewFamily =
  | 'image' | 'animated-image' | 'video' | 'audio' | 'pdf'
  | 'text' | 'office-document' | 'office-spreadsheet' | 'office-presentation'
  | 'none'

type PreviewState =
  | 'available'          // Preview button enabled
  | 'too-large'          // family supported, this file exceeds a measured cap
  | 'unsupported-codec'  // container known, this browser cannot decode it
  | 'unsupported'        // no provider for this format
  | 'locked'             // Vault locked: nothing about the type is known
  | 'integrity-failed'   // authenticated decrypt or structural check failed

interface FileCapability {
  download: true                 // ALWAYS true for a stored, owned file
  family: PreviewFamily
  provider: string | null        // registry id, e.g. 'image-native', 'pdfjs'
  state: PreviewState
  tile: 'thumbnail' | 'poster' | 'motion' | 'icon'
  reason?: string                // stable machine code for tests/diagnostics
}
```

Rules:

1. `download` is independent of every other field. No preview state, provider
   failure, decode error, or missing derivative may disable Download.
2. `state !== 'available'` never throws, never blanks the modal, never blocks the
   grid. The modal shows name, size, detected type label, the reason in plain
   language, and a Download action.
3. Normal Files and the Vault present the **same** families, labels, controls,
   and fallbacks. Differences are only where a context lacks a source (e.g. a
   Vault file without a derivative shows the original-derived path until one
   exists) and are invisible to the user except as latency.
4. Locked Vault: `state='locked'`, `tile='icon'`; no type is shown because none is
   known.

---

## 3. Arbitrary upload and download semantics

### 3.1 Upload

- **Invariant U-1:** no upload route, client picker, or drop surface may reject a
  file because of its extension, `File.type`, detected format, or the absence of
  a preview provider. (Already true in source; becomes a regression test.)
- Retained constraints: name validation (length, control characters, separators,
  Vault `nameProblem`), per-context size limits (`transferLimits`,
  `vaultTransferLimits` `MAX_VAULT_LOGICAL_FILE_BYTES`), ownership, integrity
  (server SHA-256 for Normal Files; client AEAD for Vault), quarantine/staging
  semantics, CSRF.
- Normal Files stores the filename verbatim (existing behavior); Vault stores it
  inside the encrypted manifest.
- Vault `mediaType`: the browser `File.type` is kept as a **hint** only. If it is
  longer than the manifest's 255-byte cap, store `''` rather than failing.
- Derivative generation (Vault) and scheduling (Normal Files) run **after** the
  original upload succeeds and can never change the upload's result (§11).

### 3.2 Download

- **Invariant DL-1:** download returns exact original bytes for every stored
  file. Normal Files keeps `Content-Type: application/octet-stream`,
  `Content-Disposition: attachment; filename*=UTF-8''…`, `nosniff` for **all**
  types (current behavior — not switched to a detected MIME, because a detected
  MIME adds no value to an attachment and invites sniffing mistakes).
- Vault download keeps the chunk-streamed decrypt-to-sink path; the saved Blob
  uses `application/octet-stream` regardless of `mediaType`.
- A derivative is **never** offered as "the file". Download always refers to the
  original blob/row.

---

## 4. Preview provider / capability registry

### 4.1 Shape

One client module family (proposed `src/lib/preview/`) holds a static,
frozen registry. Each provider declares data, not behavior branches:

```ts
interface PreviewProvider {
  id: string                          // 'image-native', 'video-proxy', 'pdfjs', ...
  family: PreviewFamily
  formats: readonly FormatId[]        // canonical detected formats it accepts (§5)
  contexts: readonly ('files' | 'vault')[]
  source: 'range-url' | 'whole-bytes' | 'derivative' | 'range-url-or-derivative'
  limits: { maxInputBytes?: number, maxDecodedPixels?: number, maxPages?: number, ... }
  requires?: readonly EnvFeature[]    // 'webcodecs-video-decode', 'sw-range', 'canPlayType:audio/flac', ...
  load: () => Promise<RendererModule> // lazy import; heavy libs never in the main bundle
}
```

`resolveCapability(descriptor, context, env) → FileCapability` is a **pure
function** of:

- `descriptor`: `{ format, ext, hintMime, size, formatVersion?, derivatives? }`
  (§5, §8);
- `context`: `'files' | 'vault'`;
- `env`: feature detection results computed once per page (`canPlayType` table,
  WebCodecs availability, SW range support, measured engine family).

It has no I/O, no role, no user id, and no account input (§30).

### 4.2 Initial providers

| Provider id | Family | Formats | Files source | Vault source |
|---|---|---|---|---|
| `image-native` | image | jpeg, png, webp, gif(static), bmp, avif* | `/preview` URL | thumb derivative (tile), decrypted original (modal) |
| `image-reduced` | image | jpeg (high-res) | server poster | reduced-decode lane (existing) |
| `animated-native` | animated-image | gif, apng, animated webp | server motion | motion derivative, or decrypted original ≤ cap |
| `video-native` | video | mp4/webm with browser-decodable codecs | `/preview` Range | SW range session (original) |
| `video-proxy` | video | any video with a proxy derivative | — (not used; §6) | SW range session (proxy) |
| `audio-native` | audio | mp3, m4a/aac, ogg/opus, wav, flac, webm-audio (by `canPlayType`) | `/preview` Range | whole decrypt ≤ cap, else SW range session |
| `pdfjs` | pdf | pdf | `/preview` Range | SW range session URL |
| `text-plain` | text | txt, log, source-like, svg/html/xml **as source** | `/preview` bounded Range | decrypted first N bytes |
| `markdown-safe` | text | md | same | same |
| `json-view` / `csv-table` | text | json / csv, tsv | same | same |
| `docx-html` | office-document | docx | bytes via `/preview` | decrypted bytes |
| `sheet-table` | office-spreadsheet | xlsx, xls (BIFF8), ods | same | same |
| `pptx-outline` | office-presentation | pptx | same | same |
| `generic` | none | everything else | — | — |

`*` avif remains preview-capable only where the engine decodes it (`env`);
HEIF/HEIC and camera RAW stay `unsupported` (no decoder shipped), consistent with
`vaultImageFormats.js`.

Legacy binary **DOC** and **PPT** have no safe, maintained browser parser; they
resolve to `PREVIEW_UNSUPPORTED` with `DOWNLOAD_AVAILABLE` (D-7 approved: no
server LibreOffice or other server-side converter in vp1).

### 4.3 Extension

Adding a provider = add a registry entry + renderer module + tests. The resolver,
modal shell, tile pipeline, and both contexts need no change. The server
allowlist (§6.1) is extended in the same PR when a Normal Files provider needs a
new inline MIME.

---

## 5. MIME / extension / signature detection policy

### 5.1 Inputs and trust

| Input | Normal Files | Vault | Trust |
|---|---|---|---|
| Content signature (magic bytes, structural probe) | server reads original | client reads decrypted chunk 0 | **authoritative** for family |
| Normalized extension | from DB name | from decrypted manifest name | hint; disambiguates within a family |
| Client MIME (`File.type`) | ignored | stored `mediaType` hint | never authorizes rendering |

Normalization: NFC → lower-case (full Unicode case folding not needed for ASCII
extensions) → last dot segment, with `tar.gz` special case (matching
`displayTypeFor`). `.JPG`, `.Jpg`, `.jpg` are identical by construction.

### 5.2 Canonical `FormatId`

A closed enum (`jpeg png gif apng webp webp-animated bmp avif heif raw mp4 mov
webm mkv ogg-video mp3 aac m4a ogg-audio opus wav flac pdf zip ooxml-docx
ooxml-xlsx ooxml-pptx odf-ods cfb-legacy text utf8-text svg html xml json csv
unknown`) extended as providers are added.

### 5.3 Resolution algorithm

1. Read ≤ 4 KiB head (Normal: server; Vault: decrypted chunk 0 / first bytes of
   the local `File` at upload).
2. Signature table → family candidate (JPEG `FF D8 FF`, PNG, GIF8, RIFF/WEBP,
   ISO-BMFF `ftyp` brands → mp4/mov/m4a/avif/heif, EBML → webm/mkv, `OggS`,
   `ID3`/MPEG sync, `RIFF…WAVE`, `fLaC`, `%PDF-`, `PK\3\4`, CFB `D0 CF 11 E0`,
   UTF-8 BOM/UTF-16 BOM).
3. Container disambiguation:
   - ISO-BMFF: brand + (for Vault/local) track handler inspection deferred to the
     decoder; `m4a` vs `mp4` by brand and extension.
   - ZIP: OOXML only if `[Content_Types].xml` declares the matching main part
     (verified by the provider on open; the resolver uses the extension as the
     candidate and the provider confirms, failing to `integrity-failed`/
     `unsupported` if absent). APK/JAR/plain ZIP → `zip` → `unsupported`.
   - CFB: `cfb-legacy` → xls only via SheetJS probe; doc/ppt → unsupported.
4. No signature match: if the extension is in the text family **and** the first
   8 KiB is valid UTF-8 (or BOM-declared UTF-16) with no NUL bytes → `text`
   variant by extension (`md`, `json`, `csv`, source extensions, `svg`, `html`,
   `xml`); otherwise `unknown`.
5. Mismatch (extension says `.jpg`, bytes say PDF): the **signature wins**; the
   UI labels the detected type. Nothing is rendered by extension alone.
6. Result is cached per identity: Normal Files in the media-info state keyed by
   `sha256` (no new DB column; §6.2); Vault as `contentFormat` in the manifest
   node (§8.2) and in page memory.

### 5.4 Security rules

- SVG, HTML, XML are **never** rendered as documents; they are text-family
  source views (`textContent`, no `innerHTML`).
- `nosniff` on every inline response; inline responses keep
  `CSP: default-src 'none'; sandbox` and `CORP: same-origin`.
- Client MIME never promotes a file into an inline-capable provider.

---

## 6. Normal Files preview pipeline

### 6.1 Preserve

The server derivative pipeline (probe → poster → motion, sha256+profile
identity, immutable caching, batch media-info, admission/queue, eviction) is
**unchanged**. No regression budget is spent on symmetry.

### 6.2 Extend (additive only)

1. **Single allowlist grows into a format table** in `server/config/previewMedia.js`
   (still the only source): each entry `{ ext, formatId, family, inlineMime,
   derivative: 'poster+motion'|'none' }`. New inline entries: audio
   (`mp3 audio/mpeg`, `m4a audio/mp4`, `aac audio/aac`, `ogg/oga/opus audio/ogg`,
   `wav audio/wav`, `flac audio/flac`), `pdf application/pdf`, text family served
   as `text/plain; charset=utf-8` (including svg/html/xml/md/json/csv),
   office formats served as `application/octet-stream` (bytes are fetched, not
   navigated).
2. **Server signature check on `/preview`**: before streaming, the route
   verifies the head bytes match the entry's family (reusing the probe's
   reading discipline); mismatch → 415 (the client falls back to `generic`).
3. **media-info adds `format`** (the detected `FormatId`) and, for audio/video,
   optional `durationMs` from the existing ffprobe step. The grid thus learns the
   capability from the batch call it already makes; no new request type.
4. Poster/motion derivatives remain images/video only. Audio tiles show an icon
   plus duration; document tiles show an icon (first-page thumbnails are a later,
   separately approved profile).
5. Deferred (D-9 (b)): a server `proxy` derivative for **non-browser-playable
   containers** (mov/mkv/HEVC) only. Not in vp1; not required for current Human
   acceptance.

### 6.3 Client

`src/lib/filesView.js` `previewKindFor` is replaced by the shared resolver fed
from media-info (`format`) and `file.ext`. `FilePreviewModal` becomes the shared
modal shell (§4) with the provider renderer inside.

---

## 7. Private Vault preview pipeline

### 7.1 Tile pipeline (after unlock)

```
manifest node ──► resolveCapability ──► tile source selection
                                          │
     derivative present & profile ok ─────┤──► fetch 1 small ciphertext chunk
                                          │     → unwrap DEK (envelope already in inventory)
                                          │     → AEAD decrypt → Blob → Object URL (LRU)
                                          │
     no derivative ───────────────────────┴──► existing original-derived path
                                                 (image lanes / SW poster)
                                                 → on success: lazy backfill (§31)
```

- The thumbnail scheduler (`vaultThumbScheduler.js`) keeps its concurrency,
  memory, LRU, visibility, and folder-release rules. A derivative job's
  `estimateBytes` is the derivative's plain size, not the original's.
- Derivative jobs get a separate, higher-priority lane (small, cheap), bounded
  at 6 concurrent fetches (below the browser's per-host connection limit, leaving
  room for interactive work). Original-derived jobs keep the existing 4-job
  lane.

### 7.2 Modal preview

- Image: decrypt original through the existing lanes (full fidelity), showing the
  thumbnail derivative instantly as a placeholder.
- Video: proxy-first policy (§16), original on demand.
- Audio / PDF / text / office: provider-specific (§17, §18).

### 7.3 Hover

Motion derivative only (≤ 4 MiB, whole decrypt → Blob URL). Hover **never**
opens an SW session on the original once this design ships; files without a
motion derivative show the static poster on hover.

---

## 8. Encrypted derivative object model

### 8.1 Physical form: a derivative is an ordinary V2 blob

- Uploaded through the **existing** V2 session endpoints
  (`routes/vaultUploads.js`), stored in `vault_v2_blobs` /
  `vault_v2_blob_chunks`, read through `GET /api/vault/blobs/:id/chunks/:index`.
- Its V2 metadata envelope is `{ name: '', type: <derivative mime>, plainSize }`
  (existing JSON shape; no new metadata field, so V2 metadata validation is
  unchanged).
- It has its own random DEK wrapped by the KEK (existing envelope). **No new
  cryptographic primitive, key type, AAD layout, or server table is introduced.**
- The server cannot distinguish a derivative from any other V2 blob.
- Lifecycle: attached with `attachBlobIds` in the same head CAS that records it in
  the manifest; becomes `TREE_MANAGED`; replaced derivatives fall back to
  `UNREFERENCED` and follow the existing flag-gated purge
  (`VAULT_DESTRUCTIVE_PURGE_ENABLED=false` stays false).

### 8.2 Logical form: manifest schema v2

`MANIFEST_SCHEMA_VERSION` becomes `2`. A file node may carry two new optional
keys (folders may not):

```jsonc
{
  "contentFormat": "mp4",                 // detected FormatId (§5), '' if unknown
  "previews": [                           // ≤ 4 entries, at most one per kind
    {
      "kind": "thumb" | "poster" | "motion" | "proxy",
      "profile": "vp1",                   // derivative profile id (§10)
      "blobRef": { "formatVersion": 2, "id": "<opaque>" },
      "contentId": "<b64 16 bytes>",      // must equal the blob envelope's contentId
      "sourceBlobRef": { "formatVersion": 1|2, "id": "<original id>" },
      "mime": "image/webp" | "image/jpeg" | "video/mp4",
      "width": 512, "height": 288,
      "durationMs": 6000,                 // motion/proxy only
      "plainSize": 41234,
      "createdAtClient": 1790000000000
    }
  ]
}
```

Validation (added to `vaultTreeManifest.js` / `vaultTreeCanonical.js`): closed key
sets, kind uniqueness, `blobRef.formatVersion === 2`, `sourceBlobRef` equals the
node's current `blobRef` (otherwise the entry is **ignored**, not an error, so a
content replacement never renders a stale preview), size/dimension bounds per
profile, total manifest still within `maxDecodedBytes` (16 MiB).

Budget: ≈ 300 bytes per preview entry; 10,000 nodes × 3 entries ≈ 9 MB worst
case, inside the 16 MiB manifest ceiling but large. Implementation must measure
manifest encode/decode/upload/CAS cost per mutation at 1k/5k/10k nodes (§36
T-MAN-SIZE). **D-1 (approved conditionally): the v2 writer MUST NOT be enabled
until T-MAN-SIZE proves acceptable cost at all three sizes; the P2a v2 reader
MUST ship and be accepted before the P2b writer (§38).** If T-MAN-SIZE fails, the
writer stays off and a separate encrypted preview index is designed as a new
decision.

### 8.3 Tree operation

New intent `setNodePreviews { nodeId, expectedSourceBlobRef, contentFormat?,
upsert: Preview[], remove: kind[] }` with standard `operationId` idempotency and
semantic rebase:

- node missing / trashed → drop intent (no error to user);
- node `blobRef` ≠ `expectedSourceBlobRef` → drop (file was replaced);
- concurrent upsert of the same kind → last writer wins; the loser's blob stays
  `UNREFERENCED`.

`attachBlob` (upload) may carry initial `previews` and `contentFormat` in the same
operation so that the common case is one CAS.

---

## 9. Encryption, key derivation, ownership

### 9.1 Keys

`KEK ─wraps→ derivative DEK` (random 256-bit, per derivative blob) — identical to
originals. Rejected alternatives:

- *HKDF from the original DEK*: DEKs are non-extractable AES-GCM CryptoKeys; HKDF
  would require extractable key material or a key-type change → rejected.
- *Raw derivative keys inside the manifest*: puts key bytes into JS strings that
  cannot be zeroed and lengthens the lifetime of plaintext key material →
  rejected.
- *New per-tree Preview Root Key*: requires a new server envelope table and
  rotation logic for little benefit → rejected.

### 9.2 Binding

- Chunk AAD binds every chunk to the derivative's `contentId`, index, and count
  (existing V2 rule).
- The **authenticated manifest** records the expected `contentId`. The client
  refuses a derivative whose envelope `content_id_b64` differs before decrypting.
  A malicious server therefore cannot substitute another blob (even another of the
  same user's derivatives) without an AEAD failure.
- `sourceBlobRef` binds the derivative to the exact original version.

### 9.3 Ownership

Derivative blobs are created under the uploading session's `user_id` by the
existing owner-scoped V2 routes; every read goes through the existing owner check
(`findVaultV2Blob(req.user.id, id)` → 404 cross-owner). No route, role, or
account branch is added.

### 9.4 Amendment to the hierarchy spec

The hierarchy spec (§2 goal 6, §16) keeps decrypted thumbnails/posters ephemeral
and client-only. This design keeps **decrypted** derivatives ephemeral and
client-only, and adds **persisted ciphertext** derivatives produced by the owner's
browser. Plaintext still never leaves the browser or persists. **D-10 approved
(2026-09-30):**

```
PERSISTED_VAULT_CIPHERTEXT_DERIVATIVES=ALLOWED
PERSISTED_VAULT_PLAINTEXT_DERIVATIVES=FORBIDDEN
SERVER_GENERATED_VAULT_PLAINTEXT_DERIVATIVES=FORBIDDEN
```

---

## 10. Derivative identity, version, and profile model

| Profile `vp1` | Kind | Output | Bounds |
|---|---|---|---|
| thumb | still image / animated-image first frame / PDF page 1 (later) | WebP q≈0.80 (JPEG q≈0.82 where WebP encode unsupported) | long edge ≤ 512 px (matches measured `posterMaxEdge`), ≤ 256 KiB |
| poster | video representative frame | same as thumb | ≤ 512 px, ≤ 256 KiB |
| motion | video / animated image | MP4 H.264 (AVC main) — WebM VP8/VP9 fallback where AVC encode is unavailable | ≤ 480×270, ≤ 12 fps, ≤ 6 s, no audio, ≤ 4 MiB (mirrors Normal Files motion) |
| proxy | video | MP4 H.264 + AAC-LC/Opus if encodable, `moov` first (faststart) | ≤ 854×480, ≤ 30 fps, target 1.0 Mbps video (max 1.5), audio 96 kbps; duration ≤ `proxyMaxSeconds` (D-9) |

Identity of a derivative = `(sourceBlobRef, kind, profile)`. The derivative blob
id is opaque; the manifest entry is the only lookup path.

Versioning:

- Profile ids are immutable strings. Changing any bound or codec creates `vp2`.
- Readers accept any profile they know; entries with unknown profiles are ignored
  (treated as missing) and regenerated lazily.
- Normal Files keeps its own `MEDIA_PROFILE_VERSION` (`v1`); the two profile
  spaces are independent.

---

## 11. Thumbnail lifecycle (Vault)

1. **Upload (new files):** while the original is read for encryption, the client
   also has the plaintext `File`. After the original's chunks are committed, a
   bounded generator builds `thumb` (images) or `poster` (+ `motion`) (videos)
   from the **local File** (no network, no decrypt). Derivatives are encrypted and
   uploaded as V2 blobs, then included in the same `attachBlob` operation.
2. If generation fails, exceeds its time budget (10 s for thumb/poster, 30 s for
   motion — provisional, measured in §36), or the tab is closing: attach the
   original **without** previews. The upload result is never changed or delayed
   beyond the derivative budget; derivatives are strictly best-effort.
3. **View:** derivative present → one chunk GET (a few tens of KB) → decrypt →
   Object URL. Absent → existing original-derived path, then lazy backfill (§31).
4. **Release:** folder change, scroll-out beyond the LRU, visibility loss, or lock
   → revoke URL, drop bytes.

## 12. Image preview lifecycle

- Tile: `thumb` derivative, else existing lanes.
- Modal: thumbnail shown immediately; the full image decrypts through the existing
  normal/reduced lanes with their pixel/byte caps; beyond caps → `too-large` with
  the thumbnail still visible and Download available.
- Normal Files: unchanged (server poster in tile, `/preview` original in modal).

## 13. Animated-image lifecycle

- Detection: GIF, APNG (`acTL` chunk), animated WebP (`ANIM`).
- Tile idle: `thumb` (first frame).
- Hover/press: `motion` derivative. Fallback when absent: existing behavior
  (whole decrypt only ≤ `gifMaxFullPlayBytes` 8 MiB), else poster + "download to
  view animation".
- Generation from local File at upload uses WebCodecs `ImageDecoder` frames →
  `VideoEncoder` (bounded to 6 s / 12 fps / 480×270). Without WebCodecs: no motion
  derivative; the ≤ 8 MiB rule still applies.
- Modal: original animated image (≤ cap) or motion derivative with a
  "reduced preview" label.

## 14. Video poster lifecycle

- Upload: seek a representative frame on a local Object URL of the **plaintext
  File** (`vaultVideoPosterSeekSeconds` rule reused), draw, encode, encrypt.
  Cost: local decode only; no network.
- View: poster derivative (tens of KB). The SW session on the original is
  **no longer** used for posters of files that have a derivative.
- Legacy files: first view uses the existing SW poster path **once**; the
  produced poster bytes (`openVideoPoster({ returnBytes: true })` already exists)
  are encrypted and attached via `setNodePreviews` (§31). Every later unlock is a
  derivative hit.
- Undecodable video (browser cannot decode codec): `tile='icon'`,
  `state='unsupported-codec'`, Download available.

## 15. Motion / hover lifecycle

- Tile hover (pointer) or long-press (touch) plays the `motion` derivative muted,
  looped, `playsInline`, from a Blob URL.
- Pointer-leave: pause, keep URL in the LRU for re-hover; release on
  scroll-out/lock.
- Reduced-motion preference: hover plays nothing; poster stays.
- Only one motion playing at a time per grid.

## 16. Low-bitrate video preview (proxy) lifecycle

### 16.1 Generation

- Only when WebCodecs `VideoDecoder` can decode the source **and**
  `VideoEncoder.isConfigSupported` accepts the proxy config; audio via
  `AudioDecoder`/`AudioEncoder` when available, otherwise a silent proxy (labelled).
- Only when the source is heavy enough to matter: source average bitrate
  (`plainSize·8 / duration`) > 2 × proxy target, and duration ≤ `proxyMaxSeconds`.
- New uploads: generated from the local File after the original commits, in a
  dedicated worker, progress shown in the upload drawer, cancellable; a closed tab
  leaves the file without a proxy (backfill later, §31).
- Output streamed through the V2 chunk encryptor (no whole-proxy buffer beyond one
  chunk), demuxing via an MP4/WebM demuxer and muxing to faststart MP4
  (library choice: Decision D-6).

### 16.2 Playback policy

- The client keeps an in-memory EWMA of achieved Vault chunk throughput for the
  unlocked session (bytes/second of recent chunk GETs; no persistence).
- Modal opens with the **proxy** when present and either (a) no throughput sample
  exists yet, or (b) measured throughput < 1.25 × the original's average bitrate.
  Otherwise the original.
- A visible control switches "Preview quality ↔ Original"; the choice persists only
  for the modal instance.
- Both play through the existing SW range-decryption session and read-ahead
  window.
- **Chunk size uses the current supported V2 rules** (plaintext chunk 8–64 MiB;
  D-3 is deferred and not approved for vp1). Derivative uploads choose the
  **current minimum (8 MiB)** chunk size: thumb/poster/motion (≤ 4 MiB) are a
  single short chunk; a proxy's time-to-first-frame is bounded by one ≤ 8 MiB
  chunk fetch (vs a 32 MiB original chunk today). Lowering the global minimum is
  **not** required for P4. If Human POST measurement later proves the 8 MiB
  minimum is the dominant time-to-first-preview blocker, that becomes a separate
  cross-cut decision/task with its own TDD and performance evidence.

### 16.3 Expected effect (targets, not guarantees)

`START_LIVE.mp4` proxy ≈ 120 s × ~1.1 Mbps ≈ **16–17 MB** (vs 1.2 GB), i.e. ~2–3
chunks of 8 MiB. Time-to-first-frame ≈ one 8 MiB fetch at the measured download
throughput (e.g. ~4 s at 2 MB/s); after that, sustained throughput above ~0.2 MB/s
avoids starvation. The repeated 4–6 s starvation loops observed on the original
are expected to disappear whenever the proxy bitrate fits measured capacity. The
original remains subject to the measured ceiling. Zero buffering is not a
requirement (§1.1a item 10).

### 16.4 Initial profile status (D-9)

The vp1 proxy (854×480, ~1.0 Mbps video, bounded audio bitrate, faststart,
bounded duration `proxyMaxSeconds`) is an **initial measured profile**, not a
permanent optimum. Human acceptance: poster appears quickly, Preview opens,
content is recognizable, and playback is materially better than the original
where the proxy bitrate fits available throughput. A better profile ships as
`vp2` (§10).

## 17. Audio preview lifecycle

- Detection: §5; capability requires `audio.canPlayType(mime)` ≠ `''` for the
  detected format (`env`), else `unsupported-codec` + Download.
- Renderer: native `<audio controls preload="metadata">` inside the shared modal
  with play/pause, seek bar, current time / duration, volume, keyboard operable,
  labelled (`aria-label` with file name), loading (`waiting`), error (`error`)
  states mapped to the modal's status/alert regions.
- Normal Files: `/preview` with Range (after allowlist extension, §6.2).
- Vault: plain size ≤ `audioWholeDecryptMaxBytes` (provisional 32 MiB) → whole
  decrypt to Blob URL; larger V2 → SW range session URL; larger V1 → too-large.
- No audio derivative in `vp1`. An encrypted Opus derivative for formats the
  browser cannot play (e.g. ALAC) is a future profile; not required.
- Tile: icon + duration (from `durationMs` when known).

## 18. PDF and document preview lifecycle

### 18.1 PDF (`pdfjs`)

- pdf.js in its dedicated worker (bundled, same origin → allowed by current CSP
  `default-src 'self'`), with `isEvalSupported: false`, scripting disabled, no
  annotation-layer forms/JS, no external link navigation (links shown, not
  followed without explicit click that opens nothing outside the app),
  `disableAutoFetch` + range loading.
- Normal Files: range loading from `/preview` (`application/pdf`, sandbox CSP).
- Vault: range loading from the **SW range-decryption session URL** (same origin,
  existing responder, bounded memory). V1 ≤ 64 MiB: whole decrypt.
- The SW responder already takes `contentType` from the page
  (`vaultPreviewSession.js` → `vaultPreviewResponder.js` `buildPreviewHeaders`).
  It must be set from the **detected** format (§5), never from the `mediaType`
  hint, and non-media session responses (PDF, audio, text) must add `nosniff` and
  `Content-Security-Policy: default-src 'none'; sandbox` so a top-level navigation
  to a virtual preview URL cannot render an active document.
- Caps: render pages lazily, ≤ 2 rendered pages retained, page canvas ≤ 16 MP.

### 18.2 Text family

- Bounded head read: first 1 MiB (Normal: Range; Vault: needed chunks only),
  UTF-8/UTF-16 decode with replacement, rendered via `textContent` in a `<pre>`
  (monospace, line numbers optional). Truncation stated.
- Markdown: parsed to a restricted AST and rendered with React elements (no
  `innerHTML`, no raw HTML passthrough, links inert unless explicitly clicked,
  no remote images).
- JSON: pretty/tree view after bounded parse (≤ 1 MiB); CSV/TSV: first 1,000 rows
  × 50 columns table.

### 18.3 Office

| Format | Provider | Method | Cap (provisional, to measure) |
|---|---|---|---|
| DOCX | `docx-html` | OOXML → HTML conversion in a worker, sanitized with a strict allowlist, embedded images → Blob URLs, rendered in `<iframe sandbox="" srcdoc>` (no scripts, no same-origin) | 20 MiB |
| XLSX / XLS / ODS | `sheet-table` | parse in a worker, render first sheet(s) as a virtualized table, formulas shown as cached values only | 15 MiB, 100k cells |
| PPTX | `pptx-outline` | parse slide XML: per-slide title/text + embedded raster images (structural preview, labelled "simplified") | 50 MiB |
| DOC / PPT | — | `unsupported` + Download | — |

Identical providers in both contexts (bytes from `/preview` or decrypted
bytes). No document derivative in `vp1` (on-demand only); a first-page encrypted
`thumb` for PDF/Office is a later profile.

**Dependency gate (D-6, not yet approved):** the PDF renderer, DOCX provider,
XLS/XLSX/ODS parser, PPTX provider, and HTML sanitizer are third-party libraries
that process attacker-controlled bytes. Before P5, the implementation plan must
list for each: exact package, purpose, version policy, license, attacker-byte
exposure, execution boundary (browser/worker/server), CSP implications, and
replacement/fallback strategy (Appendix A D-6). The same listing applies to the
MP4/WebM demux/mux tooling used by P3/P4.

CSP: no policy change is expected (workers same-origin, blob: images already
allowed, `srcdoc` inherits the app CSP). Implementation must **prove** this in a
real browser before enabling (§36 T-CSP); any CSP change needs integration
review.

## 19. Unsupported-format fallback

- Tile: type icon chosen from the detected family/extension (existing icon maps).
- Modal: name, size, detected type label (or "Unknown type"), modified time,
  plain-language reason (`unsupported`, `unsupported-codec`, `too-large`,
  `integrity-failed`), Download button focused.
- Never an empty frame, spinner without end, or exception boundary.

---

## 20. Cache policy

| Layer | Normal Files | Vault |
|---|---|---|
| Server | existing media cache (disk, sha256+profile, eviction) | ciphertext blobs only |
| HTTP | derivatives `private, immutable` + `Vary: Cookie`; `/preview` `no-store` | chunk reads `no-store` (unchanged; D-5: HTTP caching of Vault ciphertext chunks stays **OFF** for vp1) |
| Browser memory | image cache | decrypted Object URL LRU (≤ 256, existing) + small **ciphertext** LRU for derivative chunks (≤ 32 MiB, page memory only) |
| Persistent client | none | **none** — no Cache API, IndexedDB, localStorage, sessionStorage, OPFS for plaintext **or** keys (existing SA-1/SA-SW-1 tests extended to new modules) |

"Warm thumbnail effectively immediate" is satisfied inside one unlocked session
by the Object URL LRU; after re-unlock, a derivative costs one small chunk GET.

## 21. Object URL lifecycle

- Every Object URL is created through the injected `createObjectUrl` and
  registered with `unlockedState` (existing rule), including provider renderer
  assets (DOCX images, PDF page bitmaps if any are URL-backed).
- Revoked on: LRU eviction, tile release, modal close, provider switch, lock,
  logout, unmount, `pagehide` (best effort).
- Normal Files providers that create Blob URLs (office images) follow the same
  registry, released on modal close.

## 22. Lock / logout cleanup

`purgeUnlockedVaultState(reason)` additionally:

1. aborts derivative fetches, derivative generation workers (WebCodecs
   decoders/encoders `close()`, `VideoFrame.close()`, `ImageDecoder.close()`),
   pending derivative uploads (the V2 session is abandoned; any committed-but-
   unattached blob stays `UNREFERENCED` ciphertext);
2. terminates document-provider workers (pdf.js, office parsers) and clears
   their buffers;
3. clears the ciphertext LRU, throughput EWMA, and backfill queue;
4. revokes every Object URL (existing) and closes SW tokens (existing);
5. only then renders the locked view.

Fail-secure: if any step throws, the remaining steps still run and the view still
locks (existing idempotent boundary semantics).

## 23. Storage and quota implications

| Derivative | Typical size | Relative to original |
|---|---|---|
| thumb / poster | 20–120 KB | negligible |
| motion | 0.5–4 MiB | small |
| proxy | ~7.5–11 MB per minute | ~1–10 % of a high-bitrate camera original |

- No per-user quota exists in the Drive today (`fileStore.js` storage report
  only). Derivatives count toward the user's Vault ciphertext usage and appear in
  storage reporting; no new enforcement is introduced.
- Replaced/corrupted derivatives become `UNREFERENCED` orphans; physical purge
  stays flag-gated. Growth is bounded by the regeneration caps (§28).
- Blob count per media file rises from 1 to ≤ 4 (≤ 5 rows including chunks for
  small derivatives). CAS `maxAttachBlobIdsPerCas` (256) accommodates ≥ 64 media
  files per CAS; batch upload must split beyond that.

## 24. Bounded concurrency and memory ceilings

| Resource | Bound (provisional where marked) |
|---|---|
| Derivative fetch+decrypt jobs | 6 concurrent (provisional) |
| Original-derived tile jobs | 4 (existing `maxConcurrentJobs`) |
| Decrypted preview memory | 256 MiB estimated (existing `memoryCeilingBytes`) |
| Retained Object URLs | 256 (existing) |
| Ciphertext derivative LRU | 32 MiB (provisional) |
| SW plaintext budget | 64 MiB (existing) |
| Derivative generation at upload | 1 file at a time; thumb/poster budget 10 s, motion 30 s; proxy 1 worker (provisional) |
| Derivative uploads | 1 concurrent, deferred while an interactive original upload is active (reuse `deferHighRes` signal) |
| Lazy backfill | thumb/poster only (motion/proxy per D-8); ≤ 1 concurrent, ≤ 50 files per unlocked session (provisional) |
| Document providers | 1 worker per open modal; caps per §18 |
| Derivative V2 chunk size | current supported minimum, 8 MiB plaintext (D-3 deferred; no change to `vaultTransferLimits.js`) |
| Vault ciphertext HTTP cache | off (D-5) |

All provisional values must be measured and recorded in a Limits Register update
(the `vaultTreeLimits.js` rule: values are measured, pinned by tests). None of
these bounds tune transport throughput; GROUP B remains deferred.

## 25. Cancellation

- Every job takes an `AbortSignal` linked to: tile release, folder change,
  visibility loss, modal close, lock.
- Generation workers check the signal between frames/chunks and close codec
  objects on abort.
- Aborted derivative uploads never CAS; aborted CAS attempts are retried only by
  the same intent path (idempotent `operationId`).

## 26. Recovery

- Tab closed mid-generation: original already attached (generation runs after
  commit); previews missing → lazy backfill next time.
- Tab closed after derivative commit but before CAS: derivative blob is an
  `UNREFERENCED` orphan; the existing orphan-recovery UI must **not** offer
  derivative orphans as user files. Detection: orphan whose decrypted metadata
  `name === ''` and `type` in the derivative MIME set → hidden from recovery,
  eligible for normal orphan retention (implementation must test this; §36).
- SW restarted: existing session recovery (page-held registry) applies to proxy
  sessions unchanged.

## 27. Corrupted derivative handling

Triggers: contentId mismatch, AEAD failure, decode failure, dimensions/duration
outside profile bounds, mime/signature mismatch.

Action: treat as **missing** for the rest of the session (no retry loop), fall
back to the original-derived path, schedule one regeneration (§28), emit a
diagnostic counter. Never display partially decrypted data (existing responder
rule).

## 28. Regeneration policy

- At most one regeneration per `(node, kind)` per unlocked session.
- Triggers: corrupted derivative, unknown/older profile, missing kind that the
  current profile would produce.
- Proxy regeneration requires the full original and is **never automatic**
  (Decision D-8): offered as an explicit "Build preview" action with size/time
  estimate.
- Replacement uses `setNodePreviews` (upsert); the replaced blob becomes
  `UNREFERENCED`.

## 29. Authorization and account isolation

- Normal Files: every new/extended route keeps `requireAuth` + owner equality +
  Vault refusal + object-hiding 404 + `FILE_PREVIEW DENIED` audit, exactly as
  `/preview` and `routes/media.js` today. Admin has no override.
- Vault: derivative blobs use existing owner-scoped V2 routes; cross-owner → 404;
  manifest is per-user; no shared derivative, no cross-account dedup.
- No new public or share-link surface for previews.
- Audit volume (D-4, `NO_RUNTIME_CHANGE_IN_VP1`): **current audit semantics are
  kept.** Derivative tile reads hit the existing chunk-0 audit rule
  (`VAULT_V2_READ` per chunk-0 read) and may increase audit volume. vp1 measures
  that volume (§34); no session-scoped dedup is introduced to support preview. If
  the volume becomes an operational problem, a separate security/audit design
  follows.

## 30. Admin / current-user / future-user neutrality

- Resolver inputs exclude role, user id, username, account age, and legacy flags.
- No module under `src/lib/preview/`, the Vault derivative modules, or the extended
  Normal Files routes may reference `role`, `ROLES`, `isAdmin`, usernames, or
  numeric account ids. A source-scan test enforces it (§36 T-NEUTRAL).
- Existing accounts get derivatives through lazy backfill (§31) — the same code
  path new uploads use for later views.
- Newly created accounts: first Vault setup creates a v2 manifest directly once
  writers are enabled.

## 31. Migration and backfill for existing Vault files

1. **Manifest:** v1 manifests are read unchanged. The first write by a v2-capable
   client (with writers enabled) re-encodes the manifest as v2 with no previews;
   nothing is rewritten eagerly.
2. **Lazy poster/thumb backfill (automatic, bounded):** whenever the existing
   original-derived path produces a tile image, its bytes are encrypted and
   attached with `setNodePreviews`. The expensive step (decrypting the original)
   has already happened for display; backfill adds only a small upload and a CAS.
   Result: each legacy file pays the slow poster cost **once, ever**, not once per
   unlock.
3. **Motion backfill (D-8):** automatic only from plaintext the client has
   **already decrypted for a user-visible display** (e.g. a small GIF already
   played on hover, within the motion budget). Otherwise — and always for large
   legacy videos — only via the explicit **Build Preview** action.
4. **Proxy backfill (D-8):** explicit user-initiated **Build Preview** action only
   (full original download + local transcode), with progress, cancel, and
   estimate.
4a. **Never** download or transcode a large legacy original merely because the
   Vault was unlocked. Automatic backfill never fetches original bytes beyond what
   the existing tile display path already fetches.
5. Ordering: backfill never competes with interactive work (deferred while
   uploads/downloads/modal playback are active).
6. No server-side migration, no bulk re-encryption, no change to existing blobs.

## 32. Compatibility with Vault V1 / V2

| Original | Derivative generation | Derivative format |
|---|---|---|
| V2 (any size) | local File at upload; original-derived path for backfill | V2 |
| V1 (≤ 64 MiB) | whole-file decrypt (existing V1 rule) for backfill | V2 |
| Flat (pre-tree) Vault | not supported — derivatives need the manifest; flat vaults migrate first (existing tree migration) | — |

Manifest v2 reader must accept `blobRef.formatVersion ∈ {1,2}` for originals and
require `2` for derivatives.

## 33. LAN and Remote behavior

### 33.1 Ceilings are not identical (`REMOTE_EQUALS_LAN=NO`)

- **LAN:** the current path contains a proven ~100 Mbps hardware ceiling
  (PR216 `P1_SHARED_PATH_CAPACITY_LIMITER`). No software change in this spec
  claims to exceed it without hardware replacement.
  `LAN_TARGET` = best safe throughput toward the proven LAN hardware ceiling.
- **Remote:** the ceiling is end-to-end and **direction-specific**; Remote upload
  and Remote download can differ. Client ISP, site ISP, Twingate overhead/path,
  and the shared router path all contribute.
  `REMOTE_UPLOAD_TARGET` = best safe throughput toward the measured Remote upload
  end-to-end ceiling; `REMOTE_DOWNLOAD_TARGET` = best safe throughput toward the
  measured Remote download end-to-end ceiling.
- These targets belong to **GROUP B, which remains DEFERRED**. GROUP A does not
  optimize transport throughput.

### 33.2 GROUP A behavior on LAN and Remote

- Same feature path, same security policy, same account behavior everywhere;
  **no branching of security policy by LAN vs Remote** and no network-type
  detection.
- Measured throughput is used **only** to select preview proxy vs original
  (§16.2): it naturally selects the original where capacity allows and the proxy
  on constrained paths.
- Tiles: derivative size dominates → tens of KB per tile on both paths.
- Derivative chunk size follows the current V2 rules (8 MiB minimum; D-3
  deferred, §16.2).

## 34. Observability

- Client diagnostics (extend `vaultPreviewDiagnostics.js`; in-memory only, opt-in
  export as today): derivative hit/miss/corrupt counts, cold-fetch ms, decrypt ms,
  decode ms, generation ms per kind, backfill attempts/successes, proxy-vs-original
  selections, starvation events (`waiting` count/duration), throughput EWMA,
  derivative chunk-0 reads per session (to quantify D-4 audit volume). No
  file names, node ids, or plaintext in any counter.
- Normal Files: existing media-info/state and admin cache status; add `format`
  distribution only in admin status (counts, no names).
- Server: no new telemetry that would reveal derivative roles.
- Human acceptance measurements (§37) capture TTFB, time-to-first-tile,
  time-to-first-frame, spinner duration, Range/chunk request count, seek recovery.

## 35. Security threat analysis

| # | Threat | Mitigation | Residual |
|---|---|---|---|
| T1 | Server learns Vault content from derivatives | derivatives encrypted client-side before upload; server stores ciphertext only | — |
| T2 | Server swaps derivative blobs (show wrong preview) | manifest-held `contentId` check + chunk AAD; `sourceBlobRef` binding | whole-original swap is pre-existing (manifest does not bind originals' contentId); optional hardening noted in §38 |
| T3 | Metadata leakage: count/size/timing of extra small blobs reveals "this is media" and approximate kind | **Accepted for vp1 (D-2)** and stated honestly; **no padding in vp1** (latency/storage/bandwidth prioritized); padding kept as optional future hardening (§38.3) | derivative count and approximate sizes per upload are observable by the server |
| T4 | Plaintext persists on client | no persistent storage APIs; source-scan tests; lock cleanup | OS swap/crash dumps (pre-existing, acknowledged) |
| T5 | Malicious file exploits a parser (PDF/Office/image/video) | parsers in workers, no eval, no scripting, sanitized HTML in `sandbox=""` iframe, bounded input sizes, browser-native decoders for media | browser/library 0-days; keep libraries pinned and updated |
| T6 | Active content execution (SVG/HTML/Markdown XSS) | never rendered as documents; `textContent`; React-only Markdown rendering | — |
| T7 | Client MIME spoofing | signature-authoritative detection; MIME never authorizes rendering | — |
| T8 | Cross-account access to derivatives | existing owner-scoped routes, object-hiding 404, no dedup | — |
| T9 | Stale derivative after content replacement | `sourceBlobRef` mismatch → ignored | — |
| T10 | Resource exhaustion (huge/decompression-bomb inputs) | caps on bytes, pixels, pages, cells, frames, durations; generation time budgets | — |
| T11 | Normal Files regression via server allowlist growth | signature check on `/preview`; audio/PDF/text inline with sandbox CSP + nosniff; office as octet-stream | — |
| T12 | Downgrade: old client writes v1 manifest over v2 | readers reject unknown schema versions > supported (fail-secure, no write); rollout order §38 | — |
| T13 | Audit trail volume grows with derivative tile reads | D-4: current audit semantics kept in vp1; volume measured (§34, T-AUDIT-VOL) | if volume becomes an operational problem, a separate security/audit design is required |

`SERVER_VAULT_PLAINTEXT=FORBIDDEN`, `SERVER_GENERATED_VAULT_PLAINTEXT_DERIVATIVE=FORBIDDEN`,
`PERSISTENT_DECRYPTED_VAULT_CACHE=FORBIDDEN` hold in every section above.

## 36. Tests required before implementation is accepted

Test-first (RED before GREEN) per the repository's existing discipline.

**Capability / detection**
- T-DETECT-1: signature table for every `FormatId`; `.JPG/.jpg/.Jpg` identical;
  extension/bytes mismatch → signature wins; unknown → `generic`.
- T-DETECT-2: client MIME cannot enable a provider (Vault node `mediaType='image/png'`
  with PDF bytes → pdf, not image; `mediaType=''` with JPEG bytes → image).
- T-REG-1: resolver purity (same inputs → same output; no I/O).
- T-DL-1: every state ≠ available keeps `download: true`.

**Upload / download**
- T-UP-1: Normal V1/V2 and Vault V2 accept random bytes with unknown extension,
  no extension, and misleading extension.
- T-DL-2: downloaded bytes equal uploaded bytes (SHA-256) for the same set.

**Normal Files**
- T-NF-REG: existing `mediaRoutes`, `mediaDerivatives`, `filesMediaTiles`,
  `filesPreviewRoute` suites pass unchanged; media-info latency benchmark within
  noise of baseline.
- T-NF-AUDIO/PDF/TEXT: `/preview` headers (nosniff, sandbox CSP, CORP, Range) per
  new family; signature mismatch → 415; owner/Vault/folder gates unchanged.

**Vault derivatives**
- T-MAN-V2: manifest v2 validation (closed keys, kind uniqueness, sourceBlobRef
  mismatch ignored, bounds); v1 still readable; unknown future version rejected
  without write.
- T-MAN-SIZE (**gates the P2b writer, D-1**): manifest encode, encrypt, decode,
  upload, and head-CAS cost at 1k, 5k and 10k nodes with previews, vs the same
  sizes without previews; the pass threshold is recorded in the implementation
  plan and approved by the Human Owner before P2b.
- T-AUDIT-VOL: count `VAULT_V2_READ` rows per unlock + grid view with derivatives
  (measurement only; no audit behavior change, D-4).
- T-CHUNK-RULES: derivative uploads use the current V2 chunk rules (8 MiB minimum);
  `vaultTransferLimits.js` unchanged (D-3).
- T-DER-CRYPTO: derivative contentId mismatch rejected before decrypt; AEAD
  tamper → corrupted path; no new AAD bytes (pin existing vectors).
- T-DER-UPLOAD: upload with derivatives = one CAS; derivative failure never
  changes upload result; derivative orphans hidden from recovery UI.
- T-DER-TILE: derivative hit renders without opening an SW session and without
  touching the original's chunks (request spy).
- T-BACKFILL: legacy poster produced once → `setNodePreviews` → next unlock hit;
  rebase drops intent when file replaced.
- T-CORRUPT: corrupted derivative → fallback, single regeneration, no loop.
- T-LOCK: lock during generation/fetch/upload/modal playback revokes URLs, closes
  codecs/workers, clears LRU/EWMA; SA-1/SA-SW-1 storage scans cover new modules.
- T-PROXY-POLICY: selection by EWMA vs source bitrate; manual toggle.
- T-NEUTRAL: source scan forbids role/user/account branching in preview modules;
  the same fixture suite runs as Admin, an existing user, and a freshly created
  user with identical results.

**Providers**
- T-PDF: scripting disabled, eval disabled, range loading from both sources,
  malformed PDF → `integrity-failed`.
- T-OFFICE: DOCX sanitizer strips scripts/event handlers/external refs; iframe
  sandbox attribute present and empty; XLSX cell cap; PPTX outline; DOC/PPT →
  unsupported.
- T-TEXT: SVG/HTML shown as source; Markdown raw HTML not rendered.
- T-AUDIO: controls, keyboard operability, duration, error state, `canPlayType`
  gating.
- T-CSP: real-browser check that pdf.js worker, office workers, `srcdoc` iframe,
  Blob URLs work under the unchanged CSP.

**Performance (measured, not asserted)**
- T-PERF-VAULT: cold/warm tile latency with derivatives vs Normal Files on LAN and
  Remote; START_LIVE.mp4 poster time, proxy time-to-first-frame, and proxy
  playback starvation count — each recorded with the measured throughput of the
  path under test (LAN and Remote judged against their own ceilings, §33.1).

## 37. Human acceptance matrix

Accounts: **Admin**, one **existing** DataLake user, one **newly created** user —
every row executed for each account, on **LAN and Remote** where marked. The
measured environment is recorded with each run.

**Ceiling clarification (`REMOTE_EQUALS_LAN=NO`, §33.1).** LAN is bounded by the
proven ~100 Mbps hardware ceiling; Remote is bounded by direction-specific
end-to-end ceilings (Remote upload and Remote download measured separately).
Rows are judged against the ceiling of the path under test, never against the
other path and never against Google Drive. Zero buffering is not a criterion.
Throughput targets themselves are GROUP B (deferred) and are not acceptance
rows here.

| # | Context | Path | Scenario | Pass criterion |
|---|---|---|---|---|
| H1 | Files | LAN+Remote | upload `.bin`, no-extension, `.xyz` file; download | upload succeeds; SHA-256 identical |
| H2 | Vault | LAN+Remote | same as H1 | same |
| H3 | Files | LAN+Remote | image grid (`.JPG` + `.jpg`), video posters, hover | no regression vs current fast path |
| H4 | Vault | LAN+Remote | image grid after unlock (new uploads) | tiles approach Files perceived responsiveness; warm = effectively immediate |
| H5 | Vault | LAN+Remote | legacy images/videos: first unlock, second unlock | second unlock shows thumbs/posters without the slow original-derived path |
| H6 | Vault | LAN+Remote | START_LIVE.mp4 tile poster (new upload) | poster appears quickly without consuming the original stream |
| H7 | Vault | Remote (and LAN) | START_LIVE.mp4 modal | Preview opens; content recognizable; proxy playback materially better than original where the proxy bitrate fits measured download throughput; no repeated 4–6 s starvation loops in that case; "Original" toggle works |
| H8 | Both | LAN+Remote | hover motion | smooth, muted, stops on leave, none under reduced motion |
| H9 | Both | LAN | **MP3** (required) / M4A / WAV / FLAC / OGG | play/pause/seek/duration/loading/error; unsupported codec → message + Download |
| H10 | Both | LAN | PDF multi-page | renders, pages navigate, no script execution |
| H11 | Both | LAN | TXT / MD / JSON / CSV / SVG / HTML | readable; SVG/HTML shown as source |
| H12 | Both | LAN | DOCX / XLSX / PPTX (after D-6 approval, P5) | readable simplified preview |
| H13 | Both | LAN | DOC / PPT / ZIP / unknown | stable metadata/icon, Download works, no crash, no endless spinner |
| H14 | Vault | LAN | lock during video playback / generation | view locks; playback stops; no preview remains visible |
| H15 | Both | LAN | cross-account id probing | 404 everywhere; no preview leakage |
| H16 | Files | LAN+Remote | existing download/authorization | unchanged |
| H17 | Both | LAN | Firefox/Safari spot check (D-11) | graceful degradation; Download and upload never broken, no data loss |

## 38. Rollout and rollback boundary

### 38.1 Phases (each its own PR; each Human-gated)

| Phase | Content | Gate | Reversible? |
|---|---|---|---|
| P0 | Detection module + registry + shared modal shell for **both** contexts; Vault capability from content signature (fixes the `mediaType`-only gate); arbitrary upload/download regression tests | — | yes (pure client) |
| P1 | Audio (incl. MP3) + text family providers in both contexts; Normal Files allowlist/format table + `/preview` signature check + media-info `format` | — | yes |
| P2a | Manifest **v2 reader** (reads v1+v2, writes v1) | must be deployed and accepted before P2b | yes |
| P2b | Manifest **v2 writer** + thumb/poster derivatives at upload + automatic lazy thumb/poster backfill, behind a server-served feature flag | **T-MAN-SIZE PASS at 1k/5k/10k (D-1)** and P2a accepted | **one-way for manifests** (38.2) |
| P3 | Motion derivatives (new uploads; legacy only via Build Preview, D-8) | P2b; MP4/WebM mux tooling listed per D-6 | yes (entries ignored if disabled) |
| P4 | Proxy derivatives (vp1 initial profile, D-9) + playback policy + Build Preview action; current V2 chunk rules (D-3 not part of P4) | P2b; MP4 mux/demux tooling listed per D-6 | yes (entries ignored) |
| P5 | PDF + Office providers | **D-6 dependency approval** | yes |

D-6 approval gates P5 (and any phase introducing a third-party parsing/rendering/
muxing library) but does **not** block P0–P4 implementation planning.

### 38.2 Rollback boundary

- **One-way rule (D-1):** once any v2 manifest is written, rollback may only go to
  a build that reads v2 (contains the P2a reader). P2a must be deployed and
  accepted before the P2b writer is enabled.
- Disabling the P2b flag stops new derivative writes; existing entries remain and
  are harmless (rendered or ignored — both safe).
- No rollback may delete blobs, rewrite manifests, or purge
  (`VAULT_DESTRUCTIVE_PURGE_ENABLED=false`, `PRE_TREE_ROLLBACK=FORBIDDEN`).
- Normal Files phases are revertible by code revert; the media cache is
  regenerable.

### 38.3 Optional future hardening (not in vp1)

- Record the original blob's `contentId` in the manifest node
  (`blobRef.contentId`) so whole-original substitution becomes detectable,
  closing T2's residual.
- Power-of-two size-bucket padding of derivatives (declined for vp1, D-2).
- Session-scoped read-audit dedup (declined for vp1, D-4) — only via a separate
  security/audit design.
- Lower global V2 minimum chunk (deferred, D-3) — only via a separate cross-cut
  task with TDD and performance evidence.

---

## Appendix A — Human Owner decisions (recorded 2026-09-30)

| id | Decision | Status |
|---|---|---|
| D-1 | Preview references in encrypted Manifest schema v2 | **APPROVED CONDITIONAL** — v2 writer MUST NOT be enabled until T-MAN-SIZE proves acceptable encode/decode/upload/CAS cost at 1k, 5k and 10k nodes; P2a reader precedes P2b writer; one-way rollback boundary preserved (§8.2, §38) |
| D-2 | Derivative count/size leakage and padding | **ACCEPT LEAKAGE, NO PADDING IN vp1** — latency/storage/bandwidth prioritized; padding is optional future hardening only (§35 T3, §38.3) |
| D-3 | Lower global V2 minimum plaintext chunk 8 MiB → 1 MiB | **DEFERRED — NOT APPROVED FOR vp1** (`D3_STATUS=DEFERRED_NOT_APPROVED_FOR_VP1`). Current V2 chunk rules apply; not required for P4; revisit only as a separate cross-cut task if Human POST measurement proves it the dominant time-to-first-preview blocker (§16.2, §24, §33) |
| D-4 | Audit volume of derivative chunk-0 reads | **KEEP CURRENT AUDIT SEMANTICS** (`D4_STATUS=NO_RUNTIME_CHANGE_IN_VP1`) — measure volume first; separate security/audit design later if it becomes an operational problem (§29, §34) |
| D-5 | HTTP caching of Vault ciphertext chunks | **OFF for vp1** (§20, §24) |
| D-6 | Third-party parsing/rendering/muxing libraries | **NOT YET APPROVED.** Before P5 or any implementation introducing such a library, the implementation plan must list per package: exact package name, purpose, version or version policy, license, whether it processes attacker-controlled bytes, browser/worker/server execution boundary, CSP implications, replacement/fallback strategy. Minimum coverage: PDF renderer, DOCX provider, XLS/XLSX/ODS parser, PPTX parser/provider, HTML sanitizer, MP4/WebM demux/mux tooling. Does not block P0–P4 planning (§38.1) |
| D-7 | Legacy DOC/PPT | **APPROVED** — `PREVIEW_UNSUPPORTED`, `DOWNLOAD_AVAILABLE`; no server LibreOffice in vp1 (§4.2, §18.3) |
| D-8 | Legacy large video proxy/motion backfill | **APPROVED** — user-initiated Build Preview only; automatic lazy thumb/poster backfill allowed; never silently download/transcode a large legacy original because the Vault was unlocked (§28, §31) |
| D-9 | Proxy profile | **APPROVED AS INITIAL MEASURED PROFILE** — 854×480, ~1.0 Mbps video, bounded audio bitrate, faststart, bounded duration; a starting vp1 profile, not a permanent optimum; Google Drive parity not required; (b) Normal Files proxy deferred (§10, §16.4, §37 H7) |
| D-10 | Hierarchy spec §16 amendment | **APPROVED** — `PERSISTED_VAULT_CIPHERTEXT_DERIVATIVES=ALLOWED`, `PERSISTED_VAULT_PLAINTEXT_DERIVATIVES=FORBIDDEN`, `SERVER_GENERATED_VAULT_PLAINTEXT_DERIVATIVES=FORBIDDEN` (§9.4) |
| D-11 | Browser baseline | **APPROVED** — Chromium/Edge/Chrome full measured baseline; Firefox/Safari degrade gracefully by real capability detection; no browser-specific data loss or broken Download (§37 H17) |

## Appendix B — Self-review record

### B.1 Initial draft (2026-09-30, `d9d96ca8`)

| Check | Result |
|---|---|
| All 38 required sections present (§1–§38) | yes |
| Every "current behavior" claim traced to a source path at `5df95905` (§0) | yes |
| No server plaintext, no server-generated Vault derivative, no persistent decrypted cache | yes (§8, §9, §20, §35) |
| No new cryptographic primitive, AAD layout, or server table | yes — manifest schema v2 is the only format change (client-side, encrypted) |
| Normal Files derivative pipeline unchanged | yes |
| Account neutrality enforceable by test | yes (§30, T-NEUTRAL) |
| Irreversible step identified with rollback boundary | yes (§38.2) |

### B.2 Human-review amendment (2026-09-30)

| Check | Result |
|---|---|
| §1, §16, §24, §33, §37, §38, Appendix A agree on D-1…D-11 | yes — D-1 gate in §8.2/§38.1/§38.2; D-3 deferred in §1.2/§16.2/§24/§33.2/§38; D-4 in §29/§34; D-5 in §20/§24; D-8 in §24/§31/§38.1; D-9 in §16.4/§37 |
| No remaining text requires lowering the global V2 minimum chunk for P4 | yes (§16.2, §38.1 P4) |
| No remaining text proposes derivative padding or audit dedup for vp1 | yes (§35 T3/T13, §38.3) |
| GROUP B throughput still deferred | yes (§1.2, §24, §33.1) |
| `REMOTE_EQUALS_LAN=NO` stated with direction-specific Remote ceilings | yes (§33.1, §37) |
| Measured throughput used only for proxy-vs-original selection; no LAN/Remote security branching | yes (§16.2, §33.2) |
| Final product scope recorded as binding | yes (§1.1a) |
| Runtime source changed | no — spec file only |
