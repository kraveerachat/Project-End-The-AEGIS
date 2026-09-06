---
title: Task Receipt — IDEA1 avatar removal and responsive tile-menu regressions
date: 2026-09-06T21:00:16+07:00
owner: kla
area: idea1
branch: fix/idea1-avatar-remove-and-responsive-tiles
status: complete
integration-review: no
edit_policy: append-by-new-file
---

# Task Receipt — IDEA1 avatar removal and responsive tile-menu regressions

Three UI regression fixes. Base `origin/main` was
`9ade0dab6361f2bb1212fd67dc7469122463c989`; the branch was later synced to
`a8ea876` (PR #88, #90, #91) by merge — no rebase, no force-push, and no edit
to PR #90's documentation.

**Amended after PR #92 review** (this receipt is still part of the same
unmerged task, which AGENTS.md §9 permits and §7's one-receipt rule requires
rather than a second file). Review found one blocking regression; see
"Review round 2" below.

`PRODUCTION_CHANGED = NO`. `PRODUCTION_ACCEPTANCE = NOT TESTED`.
No authorization, RBAC, vault cryptography, share, audit or retention semantics
were changed.

## What changed

All three defects had the same shape: **the browser, not the application, was
deciding what the user saw.**

- **Removing the profile picture did not remove it.** The avatar URL is
  constant, and `GET /api/users/:id/avatar` answers
  `Cache-Control: private, max-age=60`. The screen never asked whether a picture
  existed — it rendered an `<img>` and waited for a 404 that the cache would not
  deliver for another minute. So after a successful `DELETE` the old bytes came
  straight back: through the React remount (same URL), through a refresh, and
  through logout/login inside that window. The TopBar was worse — it had no
  remount trigger at all, because the only signal was a counter local to the
  Settings card, and the TopBar reads the session.

  The fix is to stop asking for an image the server has already said is gone.
  `publicUser()` now carries `hasAvatar` and an opaque `avatarVersion`, `Avatar`
  renders no `<img>` at all when `hasAvatar === false`, and Settings publishes
  the change through `onProfileSaved` into the session — which is what both the
  Settings card and the TopBar render from. Cache behaviour stops mattering,
  because no request is made.

  `avatarVersion` (a 12-char SHA-256 of the storage key, never the key itself)
  covers the twin defect: **replacing** a picture had the same 60-second stale
  window in the TopBar. A new version means a new URL, so the cache cannot win.

  The session is refreshed on both mutations. `/api/me` reads the session
  snapshot, so a DB-only update would have kept reporting the deleted picture
  until the next login — the "remains removed after refresh and logout/login"
  requirement is what forced this.

- **The Files and Private Vault tile menus were clipped and out-layered.** The
  Vault tile is `overflow-hidden` because its ciphertext veil is an absolutely
  positioned `clip-path` layer, so **the tile clipped its own menu** — worse the
  narrower the viewport got. Its menu wrapper also set `z-index: 2`, which traps
  the menu's own `--z-dropdown` (10) at level 2 relative to the page. The Files
  tile lifts on hover with `transform`, which creates a stacking context, so a
  neighbouring tile could paint over an open menu; and a menu anchored to the
  right edge could run off a narrow screen.

  None of that is fixable by changing coordinates — the menu has to be drawn
  outside the tile. A new shared `AnchoredMenu` portals to the existing overlay
  root and positions itself `fixed` from the anchor button's real rect, clamped
  into the viewport and flipped above the anchor when there is no room below. It
  follows its anchor on scroll using a capture listener, because the element
  that actually scrolls is `<main>`, not `window`.

  **Vault's command sets are untouched.** This pass moved where the menu is
  drawn, never what it offers: the locked menu still exposes only the two
  neutral entries, the button's accessible name still avoids the real filename
  until unlocked, and `previewable` is still structurally false while locked.

## Review round 2 — the fresh-session avatar regression

PR #92 review found a real defect **introduced by the first round of this
task**, and it was the mirror image of the bug being fixed.

`publicUser()` derives `hasAvatar` / `avatarVersion` from `u.avatarKey`, and
`/api/me` serialises the **session** user. But the session user is assembled
field by field in two places, and neither carried `avatarKey`:

- `verifyCredentials()` returns an explicit whitelist of fields, and
- `establishSession()` builds `req.session.user` from that return value.

So an account that genuinely had a picture got `hasAvatar: true` from
POST /api/login (which serialises the DB row) and hasAvatar: false from the
very next `GET /api/me`. Before this task nothing read `avatarKey` off the
session, so the omission was harmless; adding the derivation is what gave it
teeth. `login.js` already carried the identical warning for `preferences` —
"omitting them here makes a new session silently fall back to defaults" — so
the fix follows that established precedent in both files.

Second defect: `DELETE /profile/avatar` returned 404 early when there was
nothing to delete, which could leave a stale `avatarKey` on the session. A
repeat delete, or one racing another device, left `/api/me` still asserting a
picture the database no longer had. Session reconciliation now happens on that
path too; the HTTP contract is unchanged (nothing to delete is still 404).

The raw `avatar_key` still never leaves the server — it is held server-side
only, and `publicUser()` publishes just the boolean and a 12-char hash.

**Test-quality correction.** `AVATAR-6` had asserted, by regex, that each
route called a specifically-named session setter. That was the wrong altitude
twice over: refactoring the two call sites into one helper broke it while the
product was correct, and it would have passed happily while `/api/me` returned
the wrong answer, because it never called `/api/me`. It is replaced by real
integration coverage through the actual app, sessions and cookies.

## Source files changed

- `IDEA1-AEGIS_Drive_LC/src/components/ui.jsx` — new `AnchoredMenu`; `Avatar`
  gains `hasAvatar` / `version` and skips the `<img>` when the server says there
  is none.
- `IDEA1-AEGIS_Drive_LC/src/components/TopBar.jsx` — the header avatar is driven
  by the session's avatar facts.
- `IDEA1-AEGIS_Drive_LC/src/screens/Settings.jsx` — avatar upload/remove publish
  to the session instead of bumping a card-local remount counter.
- `IDEA1-AEGIS_Drive_LC/src/screens/Files.jsx` — `FileMenu` is now pure content
  inside `AnchoredMenu`, anchored to the overflow button.
- `IDEA1-AEGIS_Drive_LC/src/screens/Vault.jsx` — same; the stale
  `menuRef.contains()` click-away is removed (every menu item is outside that
  subtree once portalled, so it would have closed the menu before the action
  ran).
- `IDEA1-AEGIS_Drive_LC/server/routes/api.js` — `publicUser` exposes
  `hasAvatar` + `avatarVersion`; both avatar mutations refresh the session.
- `IDEA1-AEGIS_Drive_LC/server/auth/session.js` — `setSessionAvatarKey`; and
  `establishSession()` now persists `avatarKey` onto the new session.
- `IDEA1-AEGIS_Drive_LC/server/auth/login.js` — `verifyCredentials()` carries
  `avatarKey` through, for the same reason it already carries `preferences`.
- `IDEA1-AEGIS_Drive_LC/tests/avatarSessionPersistence.test.js` — new;
  9 integration tests against the real app.
- `IDEA1-AEGIS_Drive_LC/tests/avatarRemovalAndTileMenus.test.js` — new.

`dist/` was rebuilt only to verify the build and restored before staging.

## Verification evidence

- `npm test` (IDEA1) — **1032 tests, 964 pass, 1 fail, 67 skipped**. The single
  failure is `AUTOLOCK-5 migration 008 replaces the CHECK without touching the
  column`, still **pre-existing on the updated unmodified `main`**: re-running
  it with this branch's `src/` and `server/` changes stashed reproduces it
  (8/9 pass). It concerns vault auto-lock migration 008, touches nothing in
  this task's scope, and is reported rather than silently fixed here.
- `node --test tests/avatarSessionPersistence.test.js` — pass **9/9**
  (integration: real Express app, real session store, real cookies).
  Verified to actually catch the defect: reverting the one-line `login.js`
  change makes `AVATAR-SESSION-A` fail, and restoring it makes it pass.
- `node --test` on `avatarSessionPersistence`, `avatarRemovalAndTileMenus`,
  `vaultTileActions`, `filesUnifiedWorkflow`, `profileIdentity`,
  `vaultV2ScreenUi`, `vaultMediaPreview`, `userPreferences`,
  `modalGlobalLayer` — pass **131/131**.
- `npm run build` — pass, built in 5.00s.

All of the above were re-run after the round-2 fixes, on the branch synced to `main@a8ea876`.
- `node --test tests/avatarRemovalAndTileMenus.test.js` — pass 12/12.
- `node --test tests/vaultTileActions.test.js` — pass 22/22.
- `node --test tests/filesUnifiedWorkflow.test.js tests/profileIdentity.test.js
  tests/vaultV2ScreenUi.test.js tests/vaultMediaPreview.test.js
  tests/modalFocusStability.test.js tests/modalGlobalLayer.test.js
  tests/userPreferences.test.js` — pass 101/101.
- `git diff --check` — clean; no credential or secret added.
- Browser QA against a temporary local harness (deleted before commit; real
  screens over fixture responses, no backend, no production contact):
  - Vault locked tile menu, last tile at 900×700 — measured
    `parentElement.id = aegis-modal-root`, not inside the tile, rect fully
    within the viewport, and the locked item set intact.
  - Files tile menu at 760×720 and at 375×812 (mobile, dark) — portalled,
    `fitsHorizontally` and `fitsVertically` both true, flipped above the anchor
    when there was no room below, painting over neighbouring tiles rather than
    under them.

## Canonical notes updated

- `None` — receipt only. These are UI regression fixes on already-accepted
  screens; no durable implemented/tested/deployed fact changed, and nothing here
  is production evidence.

## Shared surfaces touched

- `None` — every changed path is inside `IDEA1-AEGIS_Drive_LC/`. No migration
  was added, and no shared/reconciliation document was touched. In particular
  this branch deliberately does not edit any of the Storage/Backup
  reconciliation notes currently owned by the open PR #90.

## Integration requests

- None — no cross-scope or shared path changed.

## Known limitations

- **The fresh-session regression escaped the first round because that round
  had no integration coverage of `/api/me`.** Every avatar assertion was either
  a component-level render test or a source regex, and neither can observe a
  session round trip. That gap is now closed by
  `avatarSessionPersistence.test.js`; the lesson is recorded here because the
  same shape would recur for any other field `publicUser()` learns to derive.
- **The avatar fix was verified by tests and code inspection, not by pixels.**
  The QA harness stubs `window.fetch`, but `<img>` loads bypass `fetch`
  entirely, so the harness could never display a real avatar to photograph a
  before/after. `AVATAR-1..7` cover the behaviour directly, including that no
  `<img>` element is created when `hasAvatar === false`, that a version change
  produces a different URL, and that other users' avatars keep the original
  blind-load + 404 fallback. Production visual acceptance is still outstanding.
- `publicUser()` is a small additive API change. It exposes only whether a
  picture exists plus an opaque hash; `hasAvatar` was already exposed on the
  users list, and the raw `avatar_key` still never leaves the server.
- One pre-existing suite failure (`AUTOLOCK-5`) remains, unrelated and unfixed
  here — see verification above.
- `AnchoredMenu` positions on open and follows scroll/resize. It does not
  reposition if the anchor moves for some other reason (an animation, a layout
  shift under it); the menu closes on any outside interaction, so this has not
  been observable, but it is a real bound on the implementation.
