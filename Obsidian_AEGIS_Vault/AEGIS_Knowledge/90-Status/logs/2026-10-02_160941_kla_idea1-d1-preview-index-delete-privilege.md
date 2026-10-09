---
title: Task Receipt — IDEA1 D-1 preview-index DELETE privilege contract
date: 2026-10-02T16:09:41+07:00
owner: kla
area: idea1
branch: fix/idea1-d1-preview-index-delete-privilege
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA1 D-1 preview-index DELETE privilege contract

## What changed

- Verified the Stage 1 rehearsal finding on disposable PostgreSQL 15 in Production order: P1-era schema → exact `postgres/init/02-app-roles.sh` Drive SQL (blanket DML + `ALTER DEFAULT PRIVILEGES`) → migration 012 as the same superuser → `has_table_privilege('drive_app', …, 'DELETE') = true` on all three preview-index tables. The fresh-install path (current schema.sql → 02 SQL) also gave `DELETE = true`. `PRODUCTION_MODEL_DELETE_REPRODUCED=YES`.
- Root cause: 02-app-roles.sh grants DELETE on every table and on future tables through default privileges. Migration 012 only added `GRANT SELECT, INSERT, UPDATE` and never revoked, and schema.sql has no grants, so fresh installs got the blanket DML. PI-PG-2 passed because `ALTER DEFAULT PRIVILEGES` is per database and its disposable database never ran the role script.
- Fix (narrow): migration 012's role-guarded block now does `REVOKE ALL` then `GRANT SELECT, INSERT, UPDATE` per preview-index table. 02-app-roles.sh and its three mirrors narrow exactly the same three tables after their blanket grant, guarded by `to_regclass`. No other table's privileges change, no ownership is granted, no down-migration, and no data rows are touched.
- Head table: the approved plan (C.1 CAS: "upsert head. No row or blob is ever deleted"; `INITIAL_DESTRUCTIVE_GC=FORBIDDEN`) never needs DELETE. Removing the privilege makes the head row undeletable by `drive_app` while UPDATE (upsert) and owner-deletion cascade keep working (PI-PG-7). No new trigger was added.
- Migration 012 bytes changed: LF SHA-256 `aac26537c1500737f2fada157696ca5522d34e3386099f3d580151c45cbcb239` (was `aaeee44afc11ada90e91e311ce3dcafe88ddcf493586fc06c6b45defbed1edb5`). Migration 012 has not been applied in Production.

## Source files changed

- `IDEA1-AEGIS_Drive_LC/server/db/migrations/012_vault_preview_index_v1.sql` — upgrade path: revoke defaults, re-grant SELECT/INSERT/UPDATE on the three tables; header grant note corrected.
- `IDEA1-AEGIS_Drive_LC/tests/previewIndexMigration.test.js` — PI-PG-5 (upgrade, Production role model), PI-PG-6 (fresh install, Production role model), PI-PG-7 (as `drive_app`: no DELETE/TRUNCATE, head updatable, owner cascade), PI-MIG-5 (all four role setups narrow after the blanket grant).
- `IDEA1-AEGIS_Drive_LC/scripts/pg-integration-env.sh` — test harness role mirror narrows the three tables.
- `postgres/init/02-app-roles.sh` — fresh-install Drive narrowing block after the blanket grant (aegis_drive only).
- `gateway/public-share/integration/db-init/00-aegis-drive.sh` — Public Share test DB role mirror narrows the three tables.
- `gateway/public-share/managed-tunnel/db-init/00-aegis-drive.sh` — Public Share test DB role mirror narrows the three tables.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-status.md` — D1-PRIV current task.

## Verification evidence

- `node --test --test-concurrency=1 tests/previewIndexMigration.test.js` (isolated PostgreSQL 15, fixed harness) — pass: 13/13, 0 skipped.
- Reproduction (before the fix): P1 `schema.sql` (`8634360f`) → extracted 02 Drive SQL → 012 (origin/main) — `DELETE=true` on all three tables. Default ACL `drive_app=arwd/<superuser>`. Fresh current schema → 02 SQL — `DELETE=true` on all three tables.
- RED: `node --test --test-concurrency=1 tests/previewIndexMigration.test.js` with an isolated copy of `scripts/pg-integration-env.sh` (container `aegis-dprivpg-db`, port 55791) — 13 tests, 9 pass, 4 fail (PI-PG-5/6 `DELETE: true`; PI-PG-7 DELETE on heads succeeded; PI-MIG-5 no narrowing).
- GREEN, each PG suite on a freshly provisioned isolated database with the fixed harness: previewIndexMigration 13/13, previewIndexStorePostgres 5/5, vaultV2Postgres 17/17, vaultPostgres 9/9, resumableUploadPostgres 19/19, commitCrashRecoveryPostgres 12/12, filesKindMigrationPostgres 5/5, vaultTreePostgres 34/35 on the first run (PG-MG-2 lease race, the order-sensitive test already recorded in the PR187 runbook), then 35/35 and 35/35 on two fresh re-runs. **0 skipped in every PG run.**
- Real fresh install through the Postgres image's init sequence (`00-databases.sql`, `01-run-app-init.sh`, `02-app-roles.sh` + schema/seed as mounted by `docker-compose.yml`): three preview-index tables SELECT/INSERT/UPDATE true, DELETE/TRUNCATE false; 21 other Drive tables full DML; 15 Monitor tables keep DELETE.
- Both Public Share db-init mirrors executed in real Postgres init containers: preview-index DELETE false, UPDATE true; 21 other tables keep DELETE.
- `node --test tests/dockerBootstrap.test.mjs tests/vaultStructure.test.mjs tests/vaultMultiWriter.test.mjs tests/collaborationPolicy.test.mjs` — 61/61 pass.
- Memory mode `previewIndexMigration`, `previewIndexApi`, `previewIndexCompatA`, `previewIndexStore`, `vaultTreeConfig` — 38 pass, 0 fail, 7 skipped (PG-gated tests by design when no database is set; the same tests ran with 0 skips above).
- `sh -n` on all four shell files — pass. Disposable containers, volumes, and networks removed after each check.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-status.md` — added D1-PRIV task: root cause, fix, migration hash change, and effect on Stage 1.

## Shared surfaces touched

- `postgres/init/02-app-roles.sh` — Production database role initialization (infrastructure); narrows only the three D-1 tables.
- `gateway/public-share/integration/db-init/00-aegis-drive.sh` — Public Share integration test database role mirror.
- `gateway/public-share/managed-tunnel/db-init/00-aegis-drive.sh` — Public Share managed-tunnel test database role mirror.
- `IDEA1-AEGIS_Drive_LC/server/db/migrations/012_vault_preview_index_v1.sql` — Production database migration (not yet applied in Production).

## Integration requests

- Kla (integration reviewer, database/role surfaces): review the narrowing in 02-app-roles.sh and the 012 revoke/re-grant. After merge, the Stage 1 package (PR #294) must be rebuilt on the new `origin/main`: new candidate SHA and image, migration 012 SHA-256 `aac26537…b239`, runbook §9 back to "no DELETE / no TRUNCATE" (9 grants), and the rollback A′ rehearsal re-run. HG-S1 should not be granted on `4a8cc3c9`. No Production rollback impact: 012 has never been applied there, and re-applying the corrected 012 on a database that has the old 012 restores the contract (same idempotent block).

## Known limitations

- The full Public Share docker stacks (ps6/ps7) were not run end to end; their db-init scripts were executed in plain Postgres init containers.
- Existing Production databases are only corrected by applying the corrected 012. Re-running 02-app-roles.sh does not happen after first boot.
- `vaultTreePostgres` PG-MG-2 remains an intermittent pre-existing lease-race test; it is unrelated to privileges.
- PR #294 (Stage 1 package) is not modified by this task and is now stale on migration 012 and the grant expectation.
