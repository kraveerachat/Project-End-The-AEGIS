---
title: Task Receipt — IDEA1 Vault Interaction Polish
date: 2026-08-27T22:22:59+07:00
owner: kla
area: idea1
branch: fix/idea1-vault-interaction-polish
status: complete
integration-review: yes
edit_policy: append-by-new-file
---

# Task Receipt — IDEA1 Vault Interaction Polish

`POST_UPLOAD_STATE_SYNC = FIXED`

`VAULT_OVERFLOW_MENU = ADDED`

`VAULT_DELETE_ACTION = ADDED`

`GLOBAL_MODAL_PORTAL = ADDED`

`SERVER_API_CHANGED = NO`

`DATABASE_CHANGED = NO`

`PRODUCTION_CHANGED = NO`

## What changed

### Issue A — post-upload stale blob inventory (root cause confirmed)

Reproduced from the production report: unlock → upload → the file appears →
click Lock immediately → the screen renders **Empty Vault** → unlock again → the
file is still missing → refresh the page → the file returns.

No data was ever lost. The defect was a split source of truth in
`src/screens/Vault.jsx`:

- locked mode rendered `vaultApi.data.blobs`, which is the result of the
  **previous** `GET /api/vault`; while
- a successful `POST /api/vault/blobs` mutated only the decrypted `entries`.

`vaultApi.retry()` cannot close that gap. It is asynchronous, and a user can —
and in production did — click Lock before it resolves. Worse, `retry()` resets
`useApi` to `loading: true, data: null`, so the screen would have flashed back
through "no vault configured" on the way.

The fix introduces a deterministic client-side opaque blob inventory,
`src/lib/vaultInventory.js`. The rendered list is now
`server blobs + successful POST results − tombstoned deletes`, deduplicated
strictly by blob id, newest local upload first. Consequences:

- a successful upload is renderable as ciphertext with **zero** further HTTP;
- an immediate Lock keeps the new blob as an opaque card;
- an immediate correct Unlock decrypts that same blob without a remount, because
  the POST response carries the full envelope the client needs;
- a later `GET /api/vault` reconciles to the same set — the id dedupe means the
  server's copy of an already-known blob does not become a second card; and
- a stale GET that still lists a deleted blob cannot resurrect it.

`useApi` gained a `refresh()` alongside the existing `retry()`. `refresh()` is a
silent reconcile that keeps the current data on screen; `retry()` keeps its old
screen-clearing semantics for the ErrorState button. No other screen changed
behaviour.

### Issue B — vault card three-dot action menu

Every Vault tile now carries a `MoreHorizontal` overflow control at the top
right, reusing the Files screen's interaction and visual language: a rounded
bordered button, a dropdown of real `<button>` elements, hover/focus reveal, and
danger colouring for Delete. The Files screen itself is unchanged.

The **actions** are deliberately not borrowed. The server sees only ciphertext,
so Rename, Move, Secure Share, SHA verification and filesystem metadata are not
offered — offering them would promise something the system cannot do.

- Unlocked menu: `Download`, `Delete`.
- Locked menu: `Delete encrypted item` only.

The previous standalone hover-only Download icon was removed so there is exactly
one coherent Download control.

Touch access: hover-reveal is now a CSS concern (`.tile-hover-control`) gated on
`@media (hover: hover) and (pointer: fine)`. Coarse pointers keep the control
visible at all times, so the menu never depends on a hover event that a touch
device cannot produce. The button is a real `<button>` with `aria-haspopup`,
`aria-expanded`, and no `tabindex` override, so it stays keyboard reachable
regardless of opacity.

### Issue C — delete vault file

The server was inspected before any change. `DELETE /api/vault/blobs/:id`
already exists with `requireAuth`, owner-scoped `findVaultBlob`, DB deletion,
ciphertext removal, and a `VAULT_BLOB_DELETE` audit entry. It is used as-is. No
second endpoint was added and no server file was touched. The request carries a
blob id and nothing else — authorization stays derived from `req.user`.

Flow: three dots → Delete → confirmation modal → `DELETE` → on **204** the blob
is removed from the opaque inventory, from the decrypted entries, and tombstoned
so a later GET cannot bring it back; then a silent `refresh()` reconciles. No
page refresh, no ghost card, no duplicate card.

On failure the card **stays** and the dialog states the failure. There is no
optimistic removal: the ciphertext genuinely still exists on the server, and
pretending otherwise would be a lie the next refetch would expose.

### Locked-card menu policy — deletion while locked is ENABLED

Chosen policy: **locked deletion is allowed**, behind a stronger confirmation
that shows only what the system can actually see.

Rationale, recorded here because the task asked for it explicitly:

- a vault whose key is lost is unrecoverable **by design** — there is no reset
  endpoint and there never will be;
- if deletion were disabled while locked, such a user would be left holding
  blobs that can be neither opened nor removed, consuming quota forever, with no
  path out;
- server-side authorization is identical either way — the same owner-scoped
  route, the same `req.user` derivation — so disabling it in the client buys no
  security, only a dead end; and
- the real hazard is *misidentification*, and that is addressed by the
  confirmation copy rather than by removing the capability.

The locked confirmation therefore states plainly that the Vault is locked and
that AEGIS cannot show the original filename, and displays only the opaque blob
id and the ciphertext size. **No metadata is decrypted to populate it** — the
dialog is built from the same opaque blob record the locked tile renders. Plain
Download is not offered while locked, because the only thing it could deliver is
a `.aegisenc` the user cannot open.

If an unlocked entry's metadata fails to decrypt (a corrupted envelope), its
confirmation falls back to the same opaque form rather than inventing a name.

A delete confirmation that is open when the vault locks — including the 10-minute
idle auto-lock — is closed with the key, so a plaintext filename never outlives
the lock it was displayed under.

### Issue D — modal scrim did not cover the TopBar (root cause confirmed)

The cause was structural, not a z-index value:

- `TopBar` is `sticky` with `z-index: var(--z-sticky)` (20), so it establishes
  its own stacking context as a sibling in the root; while
- the Modal was rendered from inside the screen subtree, under
  `<div className="fade-in">` in `src/App.jsx`. `.fade-in` animates opacity with
  `animation-fill-mode: both`, so the browser keeps that div's stacking context
  alive after the animation finishes.

The Modal's `z-index: 50` was therefore scoped **inside** a `z-index: auto` box
and could never outrank a real z-20 sibling of that box. The scrim covered the
Sidebar and the page content (both painted in the non-positioned layer) and
passed under the TopBar (painted in the positioned layer). Raising numbers
inside `Vault.jsx` could not have fixed this, which is why it was not attempted.

The shared `Modal` now renders through `createPortal` into an explicit
application-level modal root, `#aegis-modal-root`, appended to `document.body`.
The layer therefore lives in the root stacking context and covers the TopBar,
the page header, the page content, and the Sidebar with one scrim. The portal
root is resolved per render rather than cached at module scope, so a test that
swaps jsdom documents cannot end up writing into a detached node.

### Modal visual polish — the "NO backdrop blur" decision is intentionally reversed

The scrim moved out of inline styles into `.modal-layer` / `.modal-scrim` in
`src/index.css`, driven by two new tokens:

- `--modal-scrim` — the dim. Light mode keeps the existing ink-based mix. Dark
  mode gets its own value, because `--ink` is near-white there and the light
  formula would *wash the shell out* rather than dim it.
- `--modal-blur: 3px` — restrained, inside the requested 2–4px band. Not a
  frosted-glass panel.

The dialog card explicitly sets `backdrop-filter: none` so it stays crisp. It is
one global scrim; the TopBar is not blurred separately. Under
`prefers-reduced-motion` the entrance animation is dropped while the dim and the
blur remain, because they are static treatment rather than motion.

### PR #38 focus behaviour

Preserved intact and re-proven. `onCloseRef`, the `[open]`-only Escape effect,
the `[open]`-only initial-focus effect, and the
`data-modal-autofocus` → first form control → generic control priority order are
all unchanged; only the render target moved. The new delete confirmation marks
its **Cancel** button `data-modal-autofocus`, so initial focus lands on the
non-destructive action rather than on the close X or the Delete button.

## Source files changed

- `IDEA1-AEGIS_Drive_LC/src/lib/vaultInventory.js` — **new.** Pure, deterministic
  opaque blob inventory: `reconcileVaultInventory`, `addLocalVaultBlob`,
  `removeLocalVaultBlob`, `tombstoneVaultBlob`, `vaultBlobId`,
  `lockedVaultEntry`. No I/O, no crypto, no plaintext.
- `IDEA1-AEGIS_Drive_LC/src/screens/Vault.jsx` — inventory-backed list for both
  lock states; upload records its POST result locally before any refetch;
  per-tile overflow menu with click-away, Escape, and touch support; delete flow
  with unlocked and locked confirmation variants; delete dialog closed on lock;
  `encodeURIComponent` on blob ids in request paths. No cryptography changed.
- `IDEA1-AEGIS_Drive_LC/src/components/ui.jsx` — shared `Modal` renders through
  `createPortal` into `#aegis-modal-root` on `document.body`; scrim styling moved
  to CSS classes. Focus, Escape, and close semantics unchanged.
- `IDEA1-AEGIS_Drive_LC/src/index.css` — `--modal-scrim` (light + dark) and
  `--modal-blur` tokens; `.modal-layer`, `.modal-scrim`, `.modal-card` rules;
  reduced-motion handling for the modal layer; `.tile-hover-control` so
  hover-reveal never gates access on a coarse pointer.
- `IDEA1-AEGIS_Drive_LC/src/lib/hooks.js` — `useApi` gains `refresh()`, a silent
  reconcile that keeps existing data on screen. `retry()` is unchanged.
- `IDEA1-AEGIS_Drive_LC/src/lib/strings.js` — 11 new keys × 3 languages
  (en/th/zh): `vaultDeleteTitle`, `vaultDeleteBody`, `vaultDeleteConfirm`,
  `vaultDeleting`, `vaultDeleteFailed`, `vaultDeleteLockedAction`,
  `vaultDeleteLockedTitle`, `vaultDeleteLockedBody`, `vaultOpaqueId`,
  `vaultCiphertextSize`. Existing generic strings (`download`, `delete`,
  `cancel`, `close`, `moreActions`, `actionFailed`) are reused rather than
  duplicated. No English or Thai is hardcoded in JSX.
- `IDEA1-AEGIS_Drive_LC/tests/vaultInventory.test.js` — **new**, 13 tests.
- `IDEA1-AEGIS_Drive_LC/tests/vaultStateSync.test.js` — **new**, 8 tests.
- `IDEA1-AEGIS_Drive_LC/tests/vaultTileActions.test.js` — **new**, 21 tests.
- `IDEA1-AEGIS_Drive_LC/tests/modalGlobalLayer.test.js` — **new**, 14 tests.
- `IDEA1-AEGIS_Drive_LC/tests/helpers/vaultScreenHarness.js` — **new**, shared
  jsdom harness for the Vault screen suites.
- `IDEA1-AEGIS_Drive_LC/tests/fixtures/vaultScreenBackend.js` — **new**,
  controllable stand-in for `hooks.js`, `api.js`, and `vaultCrypto.js`.
- `IDEA1-AEGIS_Drive_LC/tests/fixtures/mockHooks.js` — adds the `refresh` no-op
  so the existing stub still matches the `useApi` shape.

## Verification evidence

- `node --test --test-concurrency=1 tests/vaultInventory.test.js` — pass: 13/13.
- `node --test --test-concurrency=1 tests/vaultStateSync.test.js` — pass: 8/8
  (CASE 1–4 plus lock/wrong-key/stale-GET/empty-state cover).
- `node --test --test-concurrency=1 tests/vaultTileActions.test.js` — pass: 21/21.
- `node --test --test-concurrency=1 tests/modalGlobalLayer.test.js` — pass: 14/14.
- `node --test --test-concurrency=1 tests/modalFocusStability.test.js` — pass:
  12/12, unchanged by the portal.
- `node --test --test-concurrency=1 tests/vaultSetupTyping.test.js` — pass: 4/4,
  unchanged by the portal.
- `npm test` (IDEA1) — pass: 379 tests, 360 passed, 0 failed, 19 skipped. The 19
  skips are the pre-existing `TEST_DATABASE_URL`-gated Postgres vault tests,
  skipped exactly as they are on `main`.
- `npm run build` (IDEA1) — pass: built in 12.53s.
- `node --test tests/vaultStructure.test.mjs tests/vaultMultiWriter.test.mjs tests/collaborationPolicy.test.mjs tests/dockerBootstrap.test.mjs tests/endpointOnboarding.test.mjs`
  — pass: 53 tests, 53 passed, 0 failed.
- `node scripts/validate-vault.mjs --vault Obsidian_AEGIS_Vault/AEGIS_Knowledge`
  — pass with the two unchanged owner-review Canvas warnings.
- `node scripts/validate-collaboration-policy.mjs` over the changed-file delta —
  pass.
- `git diff --check` — pass: no whitespace errors.
- Targeted secret scan over the changed delta — pass: no key material,
  credential assignment, token, password, secret, or API-key value. The only
  passphrase-shaped literal is a jsdom test fixture.

### Regression guards proven against the unfixed code

Each new suite was re-run with its fix reverted, to prove it fails for the right
reason rather than passing vacuously:

- Modal reverted to the in-tree scrim: `modalGlobalLayer` failed **7 of 14**.
- Locked list reverted to reading the last GET: `vaultStateSync` failed **3 of
  8** — CASE 1, CASE 4, and the stale-GET test. CASE 2 still passed, correctly:
  it tests duplicate prevention after the server catches up, not stale
  inventory, and is honest about that.
- Delete tombstone removed: `vaultTileActions` failed **2 of 21** — the two
  tests asserting a deleted blob is not resurrected by a later refetch.

All files were restored and the six suites re-run together: 72/72 pass.

### Coverage recorded

State synchronisation — upload visible before any refetch; immediate Lock keeps
the ciphertext card; immediate re-Unlock decrypts it without a remount; a
pre-existing blob plus a new upload reconcile to exactly two cards after the
server reports both; a failed upload leaves no ghost blob and no ghost plaintext
entry and requests no reconcile; the real 10-minute idle auto-lock timer keeps
the newly uploaded blob as ciphertext; a stale GET omitting a just-uploaded blob
does not remove its card.

Menu — one control per tile; real button, keyboard reachable, not removed from
the tab order; opens on click with no hover event at all; click-away closes;
a click inside the dropdown does not; Escape closes; the button toggles rather
than stacking; the control container outranks the hatch veil and the dropdown
uses `--z-dropdown`; the unlocked menu is exactly Download + Delete with Files-only
actions explicitly asserted absent; Delete carries danger colour; Download works
and produces a decrypted blob URL; opening the menu triggers neither Download nor
a confirmation.

Delete — confirmation names the decrypted file while unlocked; Cancel keeps the
blob and sends no DELETE; focus lands on Cancel; a 204 removes the card
immediately, sends exactly one DELETE to the existing endpoint with no user id in
the body, and survives Lock, a stale refetch, and Unlock; a failed DELETE keeps
the card and shows a truthful `role="alert"`; a confirmation open at lock time is
closed with the key.

Locked zero-knowledge — the locked menu offers only "Delete encrypted item" and
no Download; the locked confirmation shows only opaque id and ciphertext size,
with the filename and MIME type absent from `innerHTML` and from every `title`,
`aria-label`, and `alt` attribute; a locked delete uses the same endpoint and the
blob does not return on unlock; an undecryptable entry uses the opaque form.

Global modal layer — the dialog is inside `#aegis-modal-root` on `document.body`
and provably **not** inside `<main>`, not inside the `.fade-in` wrapper, and not
inside the React host; exactly one `.modal-layer` and one `.modal-scrim`; three
sibling Modals produce one scrim; `--z-modal` > `--z-sticky` and > `--z-drawer`;
neither dialog nor scrim carries an ad-hoc inline z-index; closing removes the
layer but keeps the reusable root; autofocus, Escape, scrim click, close button,
reopen-autofocus, and inline-`onClose`-identity stability all still hold through
the portal.

Static style contract — `.modal-scrim` is positioned, `inset: 0`, dims from
`--modal-scrim`, and declares `backdrop-filter` plus the `-webkit-` prefix;
`--modal-blur` is a token in the 2–4px band; both themes define `--modal-scrim`;
the **only** blurring rule in the whole stylesheet is `.modal-scrim`;
`.modal-card` opts out; `TopBar.jsx` declares no blur of its own; reduced motion
drops the animation but not the dim or blur; `ui.jsx` no longer carries the
retired "NO backdrop blur" comment and introduces no 3-digit z-index; and
`Vault.jsx` contains no private z-index, no `--z-modal` reference, and no
duplicated scrim treatment.

## Canonical notes updated

- `None` — this is a UI defect fix and interaction addition inside the existing
  IDEA1 boundary. No durable implemented, tested, deployed, blocked, or maturity
  fact in `idea1/idea1-status.md` changed. Nothing here has been accepted in
  production yet, and recording vault delete as a delivered production capability
  before deployment would manufacture maturity the evidence does not support.

## Shared surfaces touched

- `None` — every changed path is inside `IDEA1-AEGIS_Drive_LC/`. No server route,
  vault cryptography, PostgreSQL schema, migration, Docker, Compose, systemd,
  nginx, firewall, or Twingate file was changed. `DELETE /api/vault/blobs/:id`
  was inspected and reused unchanged.

## Integration requests

- Kla integration review: two IDEA1-wide shared modules changed.
  `src/components/ui.jsx` moves **every** Drive modal into a body-level portal —
  Files new-folder and delete, Shares revoke, Access add-user, File History
  restore, Settings, and both Vault modals — and `src/index.css` now applies a
  3px backdrop blur behind all of them, reversing the previous documented "NO
  backdrop blur" product decision. `src/lib/hooks.js` adds `useApi().refresh()`,
  which every screen now receives even though only Vault calls it. Please confirm
  (a) the reversed blur decision and its dark-mode scrim value, and (b) the
  locked-deletion policy recorded above — it is the one genuinely debatable
  product call in this task, and the documented alternative ("Delete disabled
  while locked / Unlock to delete") remains implementable without touching the
  server. No migration is required. Rollback is a revert of this Pull Request; no
  production artefact was rebuilt or deployed by this task.

## Known limitations

- **Verification is automated only.** Manual production browser acceptance is
  still required and has not been performed. jsdom computes no blur, no
  compositing, and no paint order, so the visual quality of the dim/blur and the
  actual stacking above the TopBar are proven **structurally** (portal target,
  single scrim, token ordering, static CSS contract) and not visually. The
  claim "the scrim now covers the TopBar" rests on the root-cause analysis plus
  the portal placement test, not on a screenshot.
- No production deployment was performed and no production Drive image was
  rebuilt. The three existing encrypted blobs in the DataLake-User vault were not
  touched.
- The committed `IDEA1-AEGIS_Drive_LC/dist/` build output was deliberately left
  unchanged. `npm run build` ran as verification only and the regenerated
  `dist/index.html` was reverted, so this task changes no build artefact.
- The Vault screen suites stub `vaultCrypto.js` with a deterministic fake
  envelope. Real Argon2id and AES-256-GCM behaviour is covered by the untouched
  `tests/vaultCrypto.test.js`; these suites test the screen's state machine, not
  the cryptography.
- While the vault is unlocked, a background reconcile that discovers a blob the
  client has never seen (for example, uploaded from a second tab) lists it only
  after the next unlock — the screen does not decrypt newly appeared blobs
  mid-session. This is pre-existing behaviour, is not the reported bug, and was
  left unchanged rather than widened into an unrequested feature.
- The shared `Modal` still has no focus trap and does not restore focus to the
  element that opened it. Both were pre-existing gaps on `main` and were left
  unchanged because fixing them would alter keyboard behaviour beyond this
  task's scope.
- The 19 skipped IDEA1 tests require `TEST_DATABASE_URL` and a real Postgres
  instance. No destructive suite was run against the live production database.
