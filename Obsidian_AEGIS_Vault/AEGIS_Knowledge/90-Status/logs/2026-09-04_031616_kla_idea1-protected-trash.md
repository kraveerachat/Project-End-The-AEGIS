---
title: Task Receipt — IDEA1 Protected Trash
date: 2026-09-04T03:16:16+07:00
owner: kla
area: idea1
branch: feat/idea1-protected-trash
status: partial
edit_policy: append-by-new-file
---

# Task Receipt — IDEA1 Protected Trash

## What changed

- Added a real owner-only Protected Trash for normal Data Lake files: 30-day soft deletion, password-gated metadata, restore, permanent deletion, bounded automatic purge, and immediate Secure Share invalidation.
- Preserved current and historical file bytes while an item is recoverable. Private Vault remains outside this lifecycle and was not changed.
- Added a dedicated responsive Trash screen using the existing IDEA1 Precision Light design system, truthful locked/empty/error states, non-native confirmation dialogs, and focus restoration.
- Source is local only. Production was not changed and production acceptance was not performed.

## Source files changed

- `IDEA1-AEGIS_Drive_LC/server/app.js` — pre-authenticates Trash mutations before the shared CSRF boundary so no-session requests have an explicit 401 contract.
- `IDEA1-AEGIS_Drive_LC/server/auth/session.js` — holds the five-minute Trash unlock and 60-second destructive re-auth windows only in the server session.
- `IDEA1-AEGIS_Drive_LC/server/db/schema.sql` — adds nullable Trash lifecycle columns, invariant, ownership FK, and partial indexes.
- `IDEA1-AEGIS_Drive_LC/server/db/migrations/005_protected_trash.sql` — additive, idempotent existing-database migration.
- `IDEA1-AEGIS_Drive_LC/server/db/store.js` — scopes active/trash queries, performs atomic soft-delete/share revoke, restores owner rows, and supports final/expired metadata deletion.
- `IDEA1-AEGIS_Drive_LC/server/index.js` — starts bounded Trash cleanup without delaying server readiness.
- `IDEA1-AEGIS_Drive_LC/server/rbac/permissions.js` — exposes Trash to both authenticated IDEA1 roles without an Admin content override.
- `IDEA1-AEGIS_Drive_LC/server/routes/api.js` — implements the Protected Trash API, current-password verification, owner isolation, object hiding, and audit outcomes.
- `IDEA1-AEGIS_Drive_LC/server/routes/share.js` — blocks redemption when a linked normal file is trashed.
- `IDEA1-AEGIS_Drive_LC/server/storage/trashCleanup.js` — removes bytes before metadata and serializes restore/purge races with per-file locks.
- `IDEA1-AEGIS_Drive_LC/src/App.jsx` — lazy-loads the Trash screen and preserves the existing app shell.
- `IDEA1-AEGIS_Drive_LC/src/components/Sidebar.jsx` — maps the Trash icon.
- `IDEA1-AEGIS_Drive_LC/src/components/ui.jsx` — restores focus to a still-connected dialog opener on close.
- `IDEA1-AEGIS_Drive_LC/src/lib/strings.js` — adds EN/TH/ZH Trash copy and corrects normal-file delete/history semantics.
- `IDEA1-AEGIS_Drive_LC/src/screens/Trash.jsx` — implements locked, list, restore, permanent-delete, empty, search, sort, countdown, and feedback states.
- `IDEA1-AEGIS_Drive_LC/tests/auditViewer.test.js` — updates the normal delete audit expectation to soft-delete.
- `IDEA1-AEGIS_Drive_LC/tests/fileVersions.test.js` — verifies Trash preserves versions and permanent deletion removes them.
- `IDEA1-AEGIS_Drive_LC/tests/filesOwnership.test.js` — verifies owner-only soft and permanent deletion semantics.
- `IDEA1-AEGIS_Drive_LC/tests/modalFocusStability.test.js` — pins dialog focus return after Escape/close.
- `IDEA1-AEGIS_Drive_LC/tests/protectedTrash.test.js` — covers schema/store/API/security/byte/share/purge parity contracts.
- `IDEA1-AEGIS_Drive_LC/tests/protectedTrashUi.test.js` — pins navigation, localization, migration, UI, and Vault-separation contracts.

## Verification evidence

- Red gate: `node --test --test-concurrency=1 tests/protectedTrash.test.js tests/protectedTrashUi.test.js` — expected fail: 0 pass, 10 fail before implementation.
- `node --test --test-concurrency=1 tests/protectedTrash.test.js tests/protectedTrashUi.test.js` — pass: 16/16 in memory mode.
- `node --test --test-concurrency=1 tests/modalFocusStability.test.js tests/protectedTrashUi.test.js` — pass: 17/17 after a captured red focus-return regression.
- `npm test` — pass before the final focus/timestamp adjustment: 800 discovered, 733 pass, 0 fail, 67 PostgreSQL-only skips. A final post-reconciliation run remains required.
- Disposable PostgreSQL fresh-schema `tests/protectedTrash.test.js` — pass: 12/12, 0 fail, 0 skip.
- Real browser QA — pass: light desktop locked/unlocked/list/modal; dark mobile 390x844; tablet 768x1024; no horizontal overflow; no console warning/error; Escape closes and restores focus.
- `npm run build` — pass before final reconciliation; final build remains required.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-moc.md` — adds Protected Trash to the real primary-screen map and security boundary.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-status.md` — records local implementation/API/migration/security semantics without claiming deployment or production acceptance.

## Shared surfaces touched

- `IDEA1-AEGIS_Drive_LC/server/db/schema.sql` — changes the deployed IDEA1 database contract and requires migration-order review.
- `IDEA1-AEGIS_Drive_LC/server/db/migrations/005_protected_trash.sql` — must be applied by the database owner before a future Drive deployment.

## Integration requests

- Kla/integration owner: review the additive schema and migration, confirm migration `005_protected_trash.sql` runs before the application revision, and confirm rollback stops the new app revision without deleting retained Trash rows or bytes.
- IDEA1 code owner: review owner-only object hiding, server-session re-auth windows, share invalidation, and byte-before-metadata purge ordering.

## Known limitations

- Production is unchanged; deployment and real production browser acceptance are separate work.
- The migration-from-latest-main preservation harness and final full-suite/build/policy gates are still in progress while this unmerged receipt remains amendable.
- Trash covers normal Data Lake files only. Private Vault deletion semantics are unchanged.
- Retained versions remain on the same storage volume and are not an off-site backup.
