---
title: Task Receipt — IDEA1 Vault Preview and Locked Action Policy
date: 2026-08-28T00:00:29+07:00
owner: kla
area: idea1
branch: fix/idea1-vault-preview-lock-policy
status: complete
integration-review: yes
edit_policy: append-by-new-file
---

# Task Receipt — IDEA1 Vault Preview and Locked Action Policy

`POST_UPLOAD_STATE_SYNC = PRODUCTION CONFIRMED (browser)`

`LOCKED_ACTION_POLICY = CHANGED BY PRODUCT OWNER`

`LOCKED_DELETE = REMOVED FROM CLIENT`

`VAULT_MEDIA_PREVIEW = ADDED`

`VAULT_FILE_DETAILS = ADDED`

`SERVER_API_CHANGED = NO`

`DATABASE_CHANGED = NO`

`PRODUCTION_CHANGED = NO`

## What changed

### Prior state confirmed in production before any edit

PR #39 is merged and deployed. The production Drive image
`sha256:e00262710d8202205ecfa89015e4d8b9b6ab74fb902de9ba04ff937b3354e31b`
was accepted in a real browser with:

- `POST_UPLOAD_STATE_SYNC_BROWSER = PASS`
- `IMMEDIATE_LOCK_BLOB_VISIBLE = PASS`
- `IMMEDIATE_REUNLOCK = PASS`
- `NO_REFRESH_REQUIRED = PASS`
- `DATA_LOSS = NO`

Observed: unlocked, real plaintext filenames return immediately; locked, the
same files remain visible as opaque ciphertext cards such as
`6.aegisenc · 411 KB` and `5.aegisenc · 49.7 MB`.

The stale-inventory defect is therefore closed by browser evidence, not only by
tests. **No part of that fix was revisited in this task.** `vaultInventory`,
`vaultStateSync`, and the upload → immediate Lock → immediate Unlock behaviour
were treated as a regression surface to protect, and are re-proven below.

### Locked mode: the PR #39 policy is reversed on the product owner's decision

PR #39 deliberately **enabled** deletion while the vault is locked, and recorded
the reasoning: a vault whose key is lost is unrecoverable by design, so refusing
locked deletion would leave such a user holding blobs that can neither be opened
nor removed, consuming quota forever.

The product owner has changed that decision. The new policy is:

> **A locked vault is view-opaque-information-only.**

While locked the client now offers no way to delete a blob, download plaintext,
download ciphertext as a normal user action, preview content, or inspect
decrypted metadata. The trade-off named in PR #39 was accepted knowingly: the
worse outcome is destroying data the user cannot identify, and the way out is to
unlock first.

Two independent things enforce this, on purpose:

1. **The menu.** The locked overflow menu is now `Encrypted item details` plus a
   disabled, non-activatable `Unlock to view or manage` hint. Delete, Download,
   Preview and the unlocked `File details` are absent.
2. **The handlers.** `requestDelete`, `download` and `openPreview` each refuse
   while locked, independently of what the menu renders. A hidden button is not
   an access control, and a later menu edit must not be able to re-open a
   destructive path by accident. The suite drives the destructive labels
   directly to prove this second layer is load-bearing.

⚠️ This is a **client product policy only**. `DELETE /api/vault/blobs/:id` is
untouched, still `requireAuth`, still owner-scoped through `findVaultBlob`, and
still derives authorization from `req.user`. Deletion remains fully available
once the user unlocks.

The locked confirmation dialog and its `vaultDeleteLocked*` strings became dead
code and were removed. The *opaque* confirmation form survives, but for a
different and now-truthful reason: an entry that is **unlocked** yet whose
envelope will not decrypt still cannot be named, so it is confirmed by opaque id
and ciphertext size. That copy previously said "the Vault is locked", which is
false in the only case that now reaches it; the keys were renamed to
`vaultDeleteOpaqueTitle` / `vaultDeleteOpaqueBody` and reworded to say that
AEGIS cannot read this item's metadata.

### Locked encrypted details

The locked menu's one action opens a details dialog built **entirely from the
opaque blob record**. It shows the encrypted item ID, the ciphertext size, and
the server-side `createdAt` when the blob response carries one, plus the line
"Unlock the Vault to view the original filename and file details."

No decryption is attempted to populate it, and the suite asserts zero
`GET /api/vault/blobs/:id` requests were made while it was open. Original
filename, extension, MIME type, plaintext size, thumbnails and decrypted
metadata are absent from `innerHTML` and from every `title`, `aria-label` and
`alt` attribute while locked.

`lockedVaultEntry` was widened to state `name: null` and `type: null`
explicitly, and to carry `createdAt`. The timestamp is the server's own row
fact — the server already knows when it stored the ciphertext — so surfacing it
while locked reveals nothing the server does not hold. Setting `name` and `type`
to `null` at that boundary means a blob record that somehow arrives carrying a
filename has it dropped there, rather than relying on every caller to remember.

### Unlocked mode: Google-Drive-like preview, zero-knowledge intact

For a previewable file the overflow menu is `Preview`, `File details`,
`Download`, `Delete`. For everything else it is `File details`, `Download`,
`Delete` — no Preview command is rendered at all.

The preview pipeline reuses the existing encrypted download route exactly:

```text
GET /api/vault/blobs/:id  →  ciphertext bytes
  →  decryptFileContent(kek, entry.blob, ciphertext)   ← in the browser only
  →  a temporary Blob / object URL
  →  <img>  or  <video controls>
```

There is **no new endpoint**, no server-side transcoding, and no server-side
thumbnail generation. The server never receives or creates plaintext, a preview
image, a filename, a MIME type, a KEK, or a DEK. AES-GCM authenticates the
ciphertext during decryption, so a tampered blob throws instead of rendering
corrupted pixels.

`decryptBlobMeta()` already returned `{ name, type, size }`, but the screen was
discarding `type`. Unlocked entries now preserve it:
`{ id, name, type, plainSize, size, blob }`. That value decides what may be
rendered, so it is kept from the envelope rather than re-derived from a filename
extension later — the extension is a guess, the recorded MIME type is the fact.
`type` is never exposed while locked.

### What may be rendered inline, and why the list is written out by hand

`src/lib/vaultPreview.js` is a pure policy module holding two explicit
allowlists:

- images — `image/jpeg`, `image/png`, `image/gif`, `image/webp`
- video — `video/mp4`, `video/webm`, `video/ogg`

A `type.startsWith('image/')` prefix match would have been shorter and is the
obvious wrong answer: `image/svg+xml` is an XML document that can carry
`<script>` and `<foreignObject>`. Text, HTML, SVG, PDF, DOCX, XLSX, PPTX,
archives, executables, unknown types and generic `application/*` are
download-only, and no `<iframe>`, `<object>` or `<embed>` ever receives
decrypted content. Rendering those needs a document-embedding element or a
parser of our own, which is the "the vault interprets what it stores" hazard the
product explicitly avoids. MIME comparison normalises case and strips
parameters, so `IMAGE/PNG` matches and `image/svg+xml; charset=utf-8` still does
not.

Image preview contains the image inside the viewport with `object-contain` and a
`68vh` ceiling — aspect ratio preserved, no forced crop. Video uses
`<video controls>` with no `autoplay`, no `loop`, no `<source>` children and no
remote URL: its only source is the local object URL. A vault file must not start
playing sound by itself.

Video preview genuinely requires fetching and decrypting the whole ciphertext
first — GCM authenticates the entire blob, so there is no per-range decrypt —
and the dialog says "Decrypting…" while that happens rather than showing a
placeholder frame that implies the file is already open.

### Object URL and plaintext lifetime

An object URL that is never revoked is decrypted plaintext the tab is still
holding, reachable by anyone who can read the URL. Revocation here is a
confidentiality property, not memory tidiness, and it is enforced on every exit
path: preview close, manual Lock, the 10-minute idle auto-lock, component
unmount, and one preview replacing another.

A monotonic `previewToken` guards the asynchronous window. `openPreview`
captures the token, then re-checks it **after** the fetch and again **after** the
decrypt. Locking mid-decrypt bumps the token, so the in-flight work returns
without ever calling `URL.createObjectURL` — the failure mode being prevented is
a URL that nobody holds a reference to and therefore nobody can revoke. The
suite proves that path: lock while decrypting, then release the response, and
assert zero object URLs were created.

`lock()` closes the preview, closes the details dialog, revokes the object URL,
and clears the preview reference, alongside the existing key and entry teardown.
Manual lock and idle auto-lock run the same function, so they cannot drift. No
preview data is written to `localStorage`, `sessionStorage`, `IndexedDB` or the
Cache API — nothing in this task writes to browser storage at all.

### Card interaction

The three-dot menu remains the authoritative interaction. As an optional extra,
the thumbnail of an unlocked previewable file is rendered as a real, labelled
`<button>` that opens Preview. For a type that cannot be previewed the thumbnail
stays a plain `<div>`: an unsupported card has no clickable region that does
nothing, and clicking a card never silently downloads. The shortcut lives on the
thumbnail only, so it cannot interfere with the absolutely-positioned overflow
control.

### Modal layer and focus

Unchanged. Preview and Details use the same shared `Modal`, so they inherit the
PR #39 `#aegis-modal-root` portal, the single global scrim, and the 3px
restrained backdrop blur that covers TopBar and Sidebar. `Vault.jsx` still
declares no private z-index, no `--z-modal` reference and no duplicated scrim
treatment, which `modalGlobalLayer` asserts statically. PR #38 focus behaviour
is untouched; the Details dialog marks its Close button `data-modal-autofocus`.
Only one Vault modal is open at a time by construction — opening Preview clears
Details, opening Details closes Preview, and Delete is unreachable from either.

## Source files changed

- `IDEA1-AEGIS_Drive_LC/src/lib/vaultPreview.js` — **new.** Pure preview policy:
  `PREVIEW_IMAGE_TYPES`, `PREVIEW_VIDEO_TYPES`, `normalizeMimeType`,
  `previewKindFor`, `canPreviewEntry`. No I/O, no crypto, no KEK/DEK.
- `IDEA1-AEGIS_Drive_LC/src/screens/Vault.jsx` — locked menu reduced to
  encrypted details plus a disabled hint; locked delete/download/preview refused
  in the handlers as well as the menu; unlocked menu gains Preview and File
  details; browser-only preview with object-URL lifetime management and an
  async-supersede token; unlocked and locked Details dialogs; `type` preserved
  through `decryptEntries` and through a fresh upload; delete confirmation
  retargeted from "locked" to "unreadable envelope"; `lang` prop for timestamp
  formatting. **No cryptography changed.**
- `IDEA1-AEGIS_Drive_LC/src/lib/vaultInventory.js` — `lockedVaultEntry` states
  `name: null` and `type: null` explicitly and carries the server-side
  `createdAt`. Still no plaintext field, still pure.
- `IDEA1-AEGIS_Drive_LC/src/lib/strings.js` — 6 new keys × 3 languages
  (en/th/zh): `preview`, `vaultPlaintextSize`, `vaultEncryptedDetails`,
  `vaultLockedManageHint`, `vaultLockedDetailsBody`, `vaultPreviewUnavailable`.
  `vaultDeleteLockedTitle` / `vaultDeleteLockedBody` renamed to
  `vaultDeleteOpaqueTitle` / `vaultDeleteOpaqueBody` and reworded truthfully;
  `vaultDeleteLockedAction` removed as dead code. Existing keys reused rather
  than duplicated: `download`, `delete`, `cancel`, `close`, `fileDetails`,
  `size`, `type`, `colName`, `uploadedAt`, `vaultOpaqueId`,
  `vaultCiphertextSize`, `vaultDecrypting`, `vaultUnnamed`, `moreActions`. No
  English or Thai is hardcoded in JSX.
- `IDEA1-AEGIS_Drive_LC/src/App.jsx` — passes `lang` to `Vault` so the details
  timestamp uses the selected locale. One line; no other screen affected.
- `IDEA1-AEGIS_Drive_LC/tests/vaultMediaPreview.test.js` — **new**, 25 tests.
- `IDEA1-AEGIS_Drive_LC/tests/vaultTileActions.test.js` — locked-policy section
  rewritten for the reversed decision; unlocked menu expectation updated. 22
  tests.
- `IDEA1-AEGIS_Drive_LC/tests/vaultInventory.test.js` — locked-entry key-set
  assertion updated and strengthened to prove a handed-in `type` is dropped too.
- `IDEA1-AEGIS_Drive_LC/tests/helpers/vaultScreenHarness.js` — records object-URL
  revocations instead of swallowing them, and adds `trackObjectUrls()` so a
  suite can assert on only the URLs its own interaction created.

## Verification evidence

- `node --test --test-concurrency=1 tests/vaultMediaPreview.test.js` — pass: 25/25.
- `node --test --test-concurrency=1 tests/vaultTileActions.test.js` — pass: 22/22.
- `node --test --test-concurrency=1 tests/vaultInventory.test.js` — pass: 13/13.
- `node --test --test-concurrency=1 tests/vaultStateSync.test.js` — pass: 8/8,
  unchanged by this task (the PR #39 state-sync regression surface).
- `node --test --test-concurrency=1 tests/modalGlobalLayer.test.js` — pass: 14/14.
- `node --test --test-concurrency=1 tests/modalFocusStability.test.js` — pass: 12/12.
- `node --test --test-concurrency=1 tests/vaultSetupTyping.test.js` — pass: 4/4.
- `node --test --test-concurrency=1 tests/i18nCopyAudit.test.js` — pass: 7/7
  (en/th/zh key parity, no empty values, no wrong-script fallback).
- `npm test` (IDEA1) — pass: 405 tests, 386 passed, 0 failed, 19 skipped. The 19
  skips are the pre-existing `TEST_DATABASE_URL`-gated Postgres vault tests,
  skipped exactly as they are on `main`. No destructive Vault PostgreSQL test
  was run against production.
- `npm run build` (IDEA1) — pass: built in 4.06s.
- `node --test tests/vaultStructure.test.mjs tests/vaultMultiWriter.test.mjs tests/collaborationPolicy.test.mjs tests/dockerBootstrap.test.mjs tests/endpointOnboarding.test.mjs`
  — pass: 53 tests, 53 passed, 0 failed.
- `node scripts/validate-vault.mjs --vault Obsidian_AEGIS_Vault/AEGIS_Knowledge`
  — pass with the same two unchanged owner-review Canvas warnings recorded on
  `main`.
- `node scripts/validate-collaboration-policy.mjs` over this branch's PR body and
  changed-file delta — pass.
- `git diff --check` — pass: no whitespace errors.
- Targeted secret scan over the changed delta — pass: no key material,
  credential assignment, token, password, secret, or API-key value. The two
  regex hits are `const token = previewToken.current` (a render counter) and the
  i18n label `password: 'Password'`.

### Guards proven against un-fixed code

Each new guarantee was re-run with its implementation reverted, to prove the
tests fail for the right reason rather than passing vacuously. All reverts were
undone and the suites re-run green afterwards.

- **Delete put back in the locked menu** → `vaultTileActions` failed 1 of 22
  (the locked menu contents). The direct-drive test still passed, correctly: the
  handler guard was still in place, which is exactly the defence-in-depth claim.
- **Locked menu Delete *and* the `requestDelete` unlock guard both removed** →
  `vaultTileActions` failed 2 of 22, the second being the test that drives the
  destructive labels directly. Both layers are load-bearing and are proven
  separately.
- **`closePreview()` removed from `lock()`** (preview state cleared without
  revoking) → `vaultMediaPreview` failed 3 of 25: revoke on manual lock, revoke
  on idle auto-lock, and no dangling URL when locking mid-decrypt.
- **Allowlist replaced with a `startsWith('image/')` / `startsWith('video/')`
  prefix match** → `vaultMediaPreview` failed 3 of 25, including the SVG case.
  This is the specific mistake the module exists to prevent.

A defect was found and fixed in the new suite itself while doing this: the
locked-delete test originally iterated one snapshot of the menu items, but the
menu closes as soon as an item runs, detaching the rest — so it silently
exercised only the first item and passed against reverted code. It now reopens
the menu per label. It was rewritten before the reverts above were re-run.

### Coverage recorded

Preview policy — every allowlisted image and video type resolves to its kind;
`text/plain`, `text/html`, `text/csv`, `image/svg+xml`, `image/bmp`,
`image/tiff`, `application/pdf`, `application/zip`,
`application/octet-stream`, DOCX, XLSX, `application/x-msdownload`,
`video/quicktime`, `audio/mpeg`, empty, `null`, `undefined` and nonsense all
resolve to "not previewable"; case and MIME parameters are normalised, and a
parameter cannot smuggle a refused type past the allowlist.

Unlocked menu — an image entry and a video entry each offer exactly Preview,
File details, Download, Delete in that order; TXT, PDF, ZIP, unknown binary and
SVG each offer exactly File details, Download, Delete with Preview absent and no
preview affordance on the tile; Files-only actions (Rename, Move, Secure Share,
SHA verify, view metadata, view history) are asserted absent; Delete keeps its
danger colour; a freshly uploaded image is previewable before any refetch lands,
proving the MIME type recorded at upload time is kept rather than re-derived.

Image preview — the existing encrypted route is the only request made, no
thumbnail/preview/render path is ever requested, the rendered `<img>` carries a
`blob:` source, and no `iframe`/`object`/`embed` exists anywhere in the document.

Video preview — same single ciphertext request; `<video>` has `controls`, has no
`autoplay`, no `loop`, no `<source>` child, and a `blob:` source only; the
decrypting state is shown truthfully before the bytes arrive and is replaced by
the player once they do.

Object URL lifetime — revoked on close, on manual lock, on the real 10-minute
idle auto-lock timer, on unmount, and when a second preview replaces the first
(exactly one live URL at a time); a failed fetch creates no object URL at all;
locking mid-decrypt creates none either. Each assertion is scoped to URLs minted
by that test, so a leftover from another test cannot make it pass or fail
spuriously.

Locked zero-knowledge — the locked menu is exactly `Encrypted item details` plus
the disabled hint; Delete, Download, Preview and File details are absent; the
hint is `disabled` and `aria-disabled`, opens nothing and sends nothing; driving
every destructive label from a freshly opened menu produces zero DELETE and zero
ciphertext fetches; the locked details dialog shows opaque id, ciphertext size
and the server timestamp only, with plaintext size and MIME type absent, no
decryption performed, and the filename and MIME type absent from `innerHTML` and
from every `title`, `aria-label` and `alt` attribute.

Details — unlocked details report the decrypted name, the MIME type, and
plaintext size and ciphertext size under distinct labels, plus the server
timestamp; no filesystem path, `storage_key`, or server internal appears; an
unreadable envelope fabricates neither a name nor a plaintext size; a details
dialog open when the vault locks closes with the key and leaves no plaintext.

Regression surface held — `vaultInventory` 13/13, `vaultStateSync` 8/8
(including upload → immediate Lock → blob remains → immediate Unlock → filename
returns, with no refresh), `modalGlobalLayer` 14/14, `modalFocusStability`
12/12, `vaultSetupTyping` 4/4, and the existing Vault delete tests, updated only
where the locked policy changed.

## Canonical notes updated

- `None` — this is a client-side interaction policy change and a UI addition
  inside the existing IDEA1 boundary. No durable implemented, tested, deployed,
  blocked, or maturity fact in `idea1/idea1-status.md` changed. Nothing in this
  task has been accepted in production; recording vault media preview as a
  delivered production capability before deployment would manufacture maturity
  the evidence does not support. The production facts that *are* newly
  confirmed (PR #39 browser acceptance) belong to that task's scope and were
  recorded as evidence above rather than restated as new capability here.

## Shared surfaces touched

- `IDEA1-AEGIS_Drive_LC/src/App.jsx` — the IDEA1 application shell. One line:
  `lang` is now passed to the `Vault` screen. No routing, state, auth, or other
  screen's props changed. Declared because the shell is read by every IDEA1
  screen, and the same exact path is listed in the Pull Request.

No server route, vault cryptography, PostgreSQL schema, migration, Docker,
Compose, systemd, nginx, firewall, or Twingate file was changed.
`DELETE /api/vault/blobs/:id` and `GET /api/vault/blobs/:id` were inspected and
reused unchanged.

## Integration requests

- **Kla, decision required — confirm the reversed locked-action policy.** PR #39
  recorded "locked deletion is allowed" as a deliberate product decision with a
  written rationale; this task reverses it to "locked = view opaque information
  only" on the product owner's instruction. The concrete downstream effect: a
  user who has permanently lost their vault key can no longer remove their own
  encrypted blobs from the UI at all, and those blobs will consume storage quota
  indefinitely. That consequence was named in PR #39 and is now accepted rather
  than solved. It is reversible without touching the server — the backend route
  is unchanged and still owner-scoped — so restoring locked deletion later is a
  client change only. Please confirm this is the intended standing policy, and
  whether an operator-side path for a key-lost user is wanted as separate work.
- **Kla, integration review — one shared IDEA1 path.**
  `IDEA1-AEGIS_Drive_LC/src/App.jsx` gains a single `lang` prop on the Vault
  screen. No migration. Rollback for the whole task is a revert of this Pull
  Request; no production artefact was rebuilt or deployed.
- **Kla, review the inline-render allowlist as a security boundary.** Preview
  renders decrypted user content in the application origin. The allowlist in
  `src/lib/vaultPreview.js` is the control, and SVG, PDF, HTML and all
  document-embedding elements are excluded by design. Any future request to
  "also preview PDFs" is a security decision, not a UI decision, and should come
  back through review rather than being added to the list.

## Known limitations

- **Verification is automated only.** No manual production browser acceptance of
  preview, details, or the locked policy has been performed. jsdom does not
  decode images, does not play video, and computes no layout, so "the image is
  contained within the viewport with its aspect ratio preserved" and "the video
  plays" are **not** proven here — only that the correct element receives a local
  object URL with the correct attributes. Manual acceptance is still required.
- No production deployment was performed and no production Drive image was
  rebuilt. The existing encrypted blobs in the DataLake-User vault were not
  touched.
- The committed `IDEA1-AEGIS_Drive_LC/dist/` build output was deliberately left
  unchanged. `npm run build` ran as verification only and the regenerated
  artefacts were reverted, so this task changes no build artefact.
- A user who permanently loses their vault key can no longer delete their blobs
  from the UI. This is the accepted cost of the new policy, is recorded above as
  an integration decision, and is not a defect.
- Video preview downloads and decrypts the entire file before the first frame
  exists. For a large video this is a real wait with no progress percentage —
  the state is truthful but coarse. Streamed or chunked decryption would need an
  envelope format change (per-chunk GCM segments) and was not attempted, because
  it would alter the cryptographic contract this task is required to preserve.
- The plaintext bytes of a preview live in a JavaScript variable between decrypt
  and object-URL creation. If the vault locks in that exact window the URL is
  never created and the buffer becomes unreachable, but it is released by garbage
  collection rather than by an explicit wipe. `Uint8Array.fill(0)` is used for
  raw key material in `vaultCrypto.js`; it is not applied to file plaintext,
  which the browser also holds inside the `Blob` for as long as the preview is
  open.
- The Vault screen suites stub `vaultCrypto.js` with a deterministic fake
  envelope. Real Argon2id and AES-256-GCM behaviour is covered by the untouched
  `tests/vaultCrypto.test.js`; these suites test the screen's policy and its
  plaintext lifetime, not the cryptography.
- The shared `Modal` still has no focus trap and does not restore focus to the
  element that opened it. Both were pre-existing gaps on `main` and were left
  unchanged, because fixing them would alter keyboard behaviour across every
  Drive screen beyond this task's scope.
- While unlocked, a background reconcile that discovers a blob the client has
  never seen (for example, uploaded from a second tab) still lists it only after
  the next unlock. Pre-existing behaviour, unchanged, and not widened here.
- The 19 skipped IDEA1 tests require `TEST_DATABASE_URL` and a real Postgres
  instance. No destructive suite was run against the live production database.
