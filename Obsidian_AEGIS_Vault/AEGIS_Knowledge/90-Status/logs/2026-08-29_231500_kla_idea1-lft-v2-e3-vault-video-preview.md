---
title: Task Receipt — IDEA1 LFT-V2-E3 streaming preview for large encrypted video
date: 2026-08-29T23:15:00+07:00
owner: kla
area: idea1
branch: feat/idea1-lft-v2-e3-vault-video-preview
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA1 LFT-V2-E3 streaming preview for large encrypted video

> **Branched from `origin/main`, independent of LFT-V2-E1 (#50) and E2 (#51).**
> It touches no file those branches change, so it can merge in any order.

## What changed

A Private Vault V2 **video** larger than 64 MiB can now be previewed. It plays
through a same-origin Service Worker that decrypts only the chunks a Range request
actually needs, so peak memory is one chunk regardless of file size.

**What was deliberately not done:** the 64 MiB buffered ceiling was not raised, no
plaintext server endpoint was added, no transcode, no volume mounted into another
service, no CSP directive widened, and no key was written to any persistent store.

### The limitation this replaces, and why it existed

Preview built a whole plaintext object URL, so a multi-gigabyte video could only be
refused. That refusal was **correct**: assembling gigabytes of decrypted video in a
tab to make a button look functional reintroduces, through the back door, the exact
problem V2 was built to remove.

What was missing was not a bigger buffer but a way to answer *part* of the file.
Players ask for `bytes=start-end`; V2 already stores independently authenticated
chunks; the mapping is arithmetic. The only thing absent was somewhere to do it.

### Shape of the path

```text
<video src="/drive/__vault_preview/<ephemeral-token>">
        │
        ▼  (never leaves the browser)
   Service Worker, scope /drive/
        │   token → { non-extractable DEK, blob metadata }  ← memory only
        ▼
   GET /drive/api/vault/blobs/:id/chunks/:index   ← existing authenticated route
        │   X-Vault-Chunk-IV
        ▼
   AAD rebuilt locally · AES-GCM decrypt · slice to the requested range
        ▼
   206 Partial Content, streamed chunk by chunk
```

### Why the logic is not inside the Service Worker

A Service Worker cannot be exercised by `node:test` — no `FetchEvent`, no
registration, no scope. Logic placed there becomes code nobody tests, and here that
code decides byte offsets and whether a failed authentication tag stops playback.
The worker file is therefore a thin shell over three ordinary modules carrying 55
tests between them. An off-by-one in range mapping is the failure that matters
most: the video still plays, but seeks land wrong and frames are subtly incorrect,
with no error anywhere. The range tests state expected offsets literally rather
than comparing against the function under test.

### Rules pinned by test

| Rule | How it is proven |
| :--- | :--- |
| Only required chunks are fetched | A 1 MiB request into a 4 GiB file touches one or two chunks; a test counts the URLs actually requested. |
| Opening a preview downloads nothing | Building the response plan issues no request at all; bytes move only when the player pulls. `preload="metadata"` stops the browser prefetching the rest of a multi-gigabyte file just because a modal opened. |
| Nothing is fully assembled | 206 *and* plain 200 both stream one chunk at a time; a test asserts no emitted piece exceeds one chunk and that the piece count equals the chunk count. |
| A failed tag stops the stream | No skipping, no zero-fill, no remainder. Tampered bytes, a reordered chunk, and a chunk from another file all fail identically — the AAD binds `contentId`, `chunkIndex`, `chunkCount`, exactly as the download path does. |
| Key in memory only | Non-extractable `CryptoKey` via structured clone. No localStorage/sessionStorage/IndexedDB, **no Cache API**, `Cache-Control: no-store` on every response. Only id, `contentIdB64`, chunk size and count are sent — not the filename, wrapped DEK, or encrypted metadata; a test asserts those strings are absent from the message. |
| Closing means the key is gone | Modal close, vault lock, auto-lock and unmount each revoke; lock clears *every* session, not just the visible one. Four separate tests, because a preview URL whose key is still resident is a file still decryptable after the user believes they locked the vault. |

### CSP unchanged, deliberately

The virtual URL is same-origin, so `media-src 'self'` already permits it, and
`worker-src` is left undeclared so it inherits `default-src 'self'` — precisely
the grant a same-origin worker needs. Two new tests assert nothing was widened,
that `connect-src` stays `'self'` (a worker holding a DEK must never reach another
origin), and that `worker-src`/`child-src` remain undeclared. If a future change
"needs" a new CSP source for preview, that is the signal something is being fetched
from where it should not be.

### Truthful fallback

No Service Worker, no `ReadableStream`, or an insecure context produces **"this
browser cannot stream large encrypted video — download the file to watch it"**
plus the Download button. There is no silent fallback to whole-file buffering,
which would trade a clear message for a dead tab. The same message appears when
registration succeeds but the worker never takes control, because the user-visible
outcome is identical.

Still-image preview is untouched and still refuses above 64 MiB: an `<img>` asks
for the whole file regardless, so range streaming buys it nothing.

## Source files changed

- `IDEA1-AEGIS_Drive_LC/src/lib/vaultPreviewRange.js` — **new.** Pure arithmetic:
  `Range` parsing (including `bytes=X-`, `bytes=-N`, unsatisfiable, multi-range),
  byte-range → chunk plan, header construction, virtual-path token extraction.
- `IDEA1-AEGIS_Drive_LC/src/lib/vaultPreviewResponder.js` — **new.** Fetch, decrypt,
  slice, stream, fail closed. Takes `fetch` as a parameter so the whole path is
  testable against a simulated server with real crypto.
- `IDEA1-AEGIS_Drive_LC/src/lib/vaultPreviewSession.js` — **new.** Capability
  detection, worker registration, key handover, revocation.
- `IDEA1-AEGIS_Drive_LC/src/vaultPreviewServiceWorker.js` — **new.** Event wiring only.
- `IDEA1-AEGIS_Drive_LC/src/screens/Vault.jsx` — streamed branch for large V2 video;
  session revoked on close/lock/auto-lock/unmount; integrity failures reported
  distinctly from generic errors; `preload="metadata"` on the streamed player.
- `IDEA1-AEGIS_Drive_LC/src/lib/strings.js` — EN/TH/ZH for the unsupported-browser
  and integrity-failure states, kept separate from the existing generic messages.
- `IDEA1-AEGIS_Drive_LC/vite.config.js` — second build entry emitting
  `dist/vault-preview-sw.js` with a **fixed, unhashed name at the dist root**: a
  worker's scope is its own directory (a file under `assets/` could never intercept
  `/drive/…`), and a hashed name reads as a different worker on every deploy. The
  main entry key stays `index` so existing asset naming is unchanged.
- `IDEA1-AEGIS_Drive_LC/tests/vaultPreviewRange.test.js` — **new**, 20 tests.
- `IDEA1-AEGIS_Drive_LC/tests/vaultPreviewResponder.test.js` — **new**, 19 tests
  against real AES-GCM.
- `IDEA1-AEGIS_Drive_LC/tests/vaultPreviewSession.test.js` — **new**, 16 tests.
- `IDEA1-AEGIS_Drive_LC/tests/vaultV2ScreenUi.test.js` — 8 new screen tests; the
  existing over-64-MiB test now asserts the truthful unsupported-browser message,
  which is the correct behaviour in an environment without a Service Worker.
- `IDEA1-AEGIS_Drive_LC/tests/contentSecurityPolicy.test.js` — 2 new tests pinning
  that this work widened nothing.
- `IDEA1-AEGIS_Drive_LC/tests/fixtures/vaultScreenBackend.js` — stub gains
  `unwrapVaultV2Dek`, now imported by the screen.

## Verification evidence

- `npm test` (in `IDEA1-AEGIS_Drive_LC/`) — **pass**: 649 tests, 582 pass, 0 fail,
  67 PostgreSQL-gated skips (count unchanged from `origin/main`).
- `npm run build` — **pass**; emits `dist/vault-preview-sw.js` at the dist root
  alongside `assets/index-<hash>.js`, confirmed by listing the output.
- `node --test tests/vaultPreviewRange.test.js` — **pass**: 20/20.
- `node --test tests/vaultPreviewResponder.test.js` — **pass**: 19/19.
- `node --test tests/vaultPreviewSession.test.js` — **pass**: 16/16.
- `node --test tests/vaultV2ScreenUi.test.js` — **pass**: 25/25.
- `node --test tests/contentSecurityPolicy.test.js` — **pass**: 10/10.
- `node --test HUB-AEGIS_Entry/tests/driveCspParity.test.mjs` — **pass**: 10/10.
- `node scripts/validate-vault.mjs --vault Obsidian_AEGIS_Vault/AEGIS_Knowledge` —
  **pass**, 2 pre-existing canvas warnings.

**A real leak this work introduced and fixed:** the first full run of the screen
suite passed every test but the process never exited. `askWorker` created a
`MessageChannel` per request and never closed it, and left its timeout running
after settling. Both are now cleaned up on every path. Worth recording because the
symptom was a hung test process rather than a failing assertion — in a browser it
would have been an accumulating resource leak with no visible error at all.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-status.md` — new LFT-V2-E3
  section covering the design, why the logic sits outside the worker, every pinned
  rule, the unchanged CSP, the truthful fallback, and the verification totals.
  `LARGE_FILE_TRANSFER_V2` remains `IN_PROGRESS`.

## Shared surfaces touched

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/concepts/Large_File_Transfer_V2.md` — a
  cross-area concept note outside the `idea1/` boundary. §7.8's
  `LARGE_V2_VIDEO_PREVIEW` marker moves from `LIMITED` to `STREAMED` for video
  while staying `LIMITED` for images, and a new §13 documents the path, the rules,
  the CSP reasoning and what was not verified.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/summaries/08_Outstanding_Items_Consolidated.md`
  — the consolidated cross-area outstanding list records LFT-V2-E3 as
  source-complete and locally verified, and states explicitly that it has never run
  in a real browser.

No server route, schema, deployment, gateway, database, authentication or network
surface was touched. `vite.config.js` is inside the IDEA1 boundary.

## Integration requests

- **Kla — review of the two shared vault notes above**, both outside the `idea1/`
  ownership boundary.
- **Kla — confirm the deployment serves `dist/vault-preview-sw.js` unmodified at
  `/drive/vault-preview-sw.js`.** The image builds `dist/` itself
  (`Dockerfile` build stage) and Express serves it with `express.static`, so this
  should hold with no configuration change, and **no gateway edit is requested**.
  It is called out because a future caching or rewrite rule on that path would
  silently break preview: a Service Worker whose script is rewritten, redirected,
  or served from a different directory loses its scope and stops intercepting, and
  the visible symptom is only "preview does not work".

## Known limitations

- **Never run in a real browser.** This is the most important limitation on this
  branch. The modules are proven against real AES-GCM in Node and the screen
  against a scripted Service Worker container, but **no video was played, no seek
  was performed, no `<video>` element ever issued a real Range request, and no
  browser-compatibility matrix was produced.** Everything below follows from that.
- **Module Service Worker support is assumed, not measured.** Registration uses
  `{ type: 'module' }`. That is supported by current Chromium, Firefox and Safari,
  but the specific versions in use here were not tested. If a target browser
  rejects it, the user sees the truthful unsupported message — the failure is safe,
  but it is a failure.
- **Safari's Range behaviour is not verified.** Safari is the strictest consumer of
  partial media responses and is the most likely place for this to need work.
- **Concurrent range requests multiply memory.** Peak is one chunk *per in-flight
  request*. A player opening several ranges at once uses correspondingly more —
  still bounded and independent of file size, but not a single-chunk ceiling.
- **The 1.1 GB MP4 named in the task brief was not tested.** Nothing in this
  repository confirms that file exists in a deployment; `idea1-status.md` records
  the largest file moved through the Vault protocol in any test as ~16 MiB.
- **Twingate / remote-path behaviour is unverified.** Range requests over the
  remote path were not exercised.
- **Nothing was deployed and no production acceptance was performed.**
  `LARGE_FILE_TRANSFER_V2` stays `IN_PROGRESS` pending `LFT-V2-D`.
- **Not part of this branch:** the truthful speed/ETA work (E1, PR #50) and the
  bounded-concurrency upload (E2, PR #51).
