---
title: Task Receipt — IDEA1 D-1 Stage 1 Production package preparation
date: 2026-10-02T14:28:01+07:00
owner: kla
area: idea1
branch: deploy/idea1-preview-d1-stage1
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA1 D-1 Stage 1 Production package preparation

## What changed

- Prepared the Human-controlled D-1 Stage 1 (compatibility / read-only, writer OFF) package. After PR #297 merged, the package was refreshed by a normal merge of `origin/main` `9f5a01148ce016bc0056dbbcc85ac8a3e5fac23f`. That is the Stage 1 candidate; it contains PR-A #283 (`fa22edd5`), PR-B #285 (head `3747a183`) and PR #297 (head `04890e18`). The original candidate `4a8cc3c95e2f4147fbab9c505079c0377a271d99` is superseded and not deployable: its migration 012 left `drive_app` DELETE on the preview-index tables.
- Per-SHA overlays: exact-source image `aegis-prod-drive:preview-d1-s1-9f5a01148ce0`. Flags: `VAULT_PREVIEW_INDEX_SCHEMA_AVAILABLE=true`, `_READ_ENABLED=true`, `_WRITE_ENABLED=false`, `VAULT_MEDIA_PREVIEW_ENABLED=true`, `VAULT_DESTRUCTIVE_PURGE_ENABLED=false`. The retained-bytes budget is absent and `VAULT_TREE_*` are inherited unchanged. The `4a8cc3c9` overlay files were renamed, so no stale overlay remains.
- The runbook covers:
  - build and transfer, with an LF checkout for byte-reproducible images;
  - the backup gate;
  - fail-closed, read-only preconditions read from the live Compose labels;
  - the migration 012 Human command (SHA-256 `aac26537c1500737f2fada157696ca5522d34e3386099f3d580151c45cbcb239`, superuser, `ON_ERROR_STOP`, lock timeout, no down-migration);
  - pre/post read-only verification;
  - render validation and the Drive-only cutover;
  - server acceptance and the per-account `/state` + `/preview-index/head` check;
  - the LAN/REMOTE browser matrix for ADMIN / EXISTING_USER / NEWLY_CREATED_USER;
  - rollback Case A′ to the P1 image with migration 012 retained, and the forward redeploy.
- Runbook §9 again requires exactly SELECT/INSERT/UPDATE for `drive_app` on the three preview-index tables (no DELETE, no TRUNCATE). An enforced `PRIV_BAD` STOP check and an OID-based check that no unrelated table lost DELETE were added. The temporary "expect DELETE" text was removed.
- Human package review decided D1–D5 (runbook §3):
  - `D1_STAGE1_WRITE_503_SUBSTITUTE=APPROVED`: `STAGE1_WRITE_ROUTE_PRESENT=NO`, `STAGE1_WRITE_ROUTE_404=EXPECTED`, `STAGE1_WRITE_CAPABILITY=NOT_ROUTABLE`, `STAGE2_WRITE_DISABLED_503_REQUIRED=YES`.
  - `D2`: a NEWLY_CREATED_USER 409 before Vault setup = `ACCOUNT_NOT_SETUP`.
  - `D3`: the direct server head check is mandatory.
  - `D4`: local rollback A′ is required before HG-S1.
  - `D5`: live Compose discovery is fail-closed.
- Local disposable rollback A′ was re-run on the refreshed candidate with the corrected migration 012: `ROLLBACK_A_PRIME_LOCAL=PASS`. The harness is committed under `IDEA1-AEGIS_Drive_LC/deploy/production/d1/rehearsal/`; it now enforces the privilege contract and re-applies 012.
- `PRODUCTION_MIGRATION_EXECUTED=NO`, `PRODUCTION_DEPLOYED=NO`, `PRODUCTION_FLAGS_CHANGED=NO`, `WRITER_ENABLED=NO`. No Production image was built (only local rehearsal images), and no Production host was contacted.

## Source files changed

- `IDEA1-AEGIS_Drive_LC/deploy/production/d1/drive-image-9f5a01148ce0.yml` — Stage 1 exact-source Drive image overlay (SHA-256 `49b0ad5fbe0f49a9cfe168ec28c12aeb3f6fe1ead6dd870105423f4b37b96f78`).
- `IDEA1-AEGIS_Drive_LC/deploy/production/d1/drive-preview-index-stage1-9f5a01148ce0.yml` — Stage 1 preview-index flags overlay, writer OFF (SHA-256 `7c5f0df78c3f5cf46bb2edd83bb8b015ed63d9645ed8de22c69eb1d8d6216a59`).
- `IDEA1-AEGIS_Drive_LC/docs/superpowers/plans/2026-10-02-idea1-d1-stage1-production-runbook.md` — Human-only Stage 1 migration, acceptance, rollback A′ and forward-redeploy runbook; D1–D5 decisions; refreshed evidence.
- `IDEA1-AEGIS_Drive_LC/deploy/production/d1/rehearsal/rollback-a-prime-rehearsal.sh` — local/disposable rollback A′ orchestration (PostgreSQL, P1 and Stage 1 containers; privilege contract + re-apply checks; no Production).
- `IDEA1-AEGIS_Drive_LC/deploy/production/d1/rehearsal/rollback-a-prime-driver.mjs` — drives each revision with its own real client modules over HTTP.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-status.md` — D1-STAGE1 task (sessions S1–S3); D1-B and D1-PRIV recorded as merged.

## Verification evidence

- `P1_ROOT=<clean 8634360f worktree>/IDEA1-AEGIS_Drive_LC S1_ROOT=<clean 9f5a0114 worktree>/IDEA1-AEGIS_Drive_LC bash IDEA1-AEGIS_Drive_LC/deploy/production/d1/rehearsal/rollback-a-prime-rehearsal.sh` — pass, run twice on candidate `9f5a0114` (once with an earlier harness revision, once with the committed file verbatim):
  - seed on P1: 10/10;
  - corrected migration 012 (SHA-256 `aac26537…b239`) applied, with `PRIVILEGE_CONTRACT=PASS`: each preview-index table `S=true I=true U=true D=false T=false`, and `OTHER_TABLES=21 WITHOUT_FULL_DML=0`;
  - re-apply: privilege contract PASS again and `MIGRATION_012_REAPPLY_NOOP=YES`;
  - Stage 1: 19/19 — `/state` schema/read true, write false; GET head 404 `PREVIEW_INDEX_NOT_FOUND` for all three account classes; authenticated POST head `404 {"error":"Not found"}`; NEWLY_CREATED_USER 409 before setup, 404 after;
  - rollback A′, exact P1 code on the same migrated DB: 47/47 across all three account classes (login, unlock, browse, upload, byte-exact download, rename, move, trash, restore, recovery listing, lock);
  - after rollback: migration 012 retained; seed blob rows identical to pre-migration;
  - forward Stage 1: 23/23;
  - 0 preview-index and `INDEX_*` rows throughout; all disposable resources removed.
- Local images: `aegis-local-rehearsal-drive:p1-8634360f74ed` (`sha256:b8285def…2f09`, OCI revision `8634360f…`) and `aegis-local-rehearsal-drive:preview-d1-s1-9f5a01148ce0` (`sha256:21c967c3…9922`, OCI revision `9f5a0114…`). Both are node v20.20.2, Alpine 3.23.4, user node, built from a Windows CRLF checkout. `ROLLBACK_IMAGE_EXACT_PRODUCTION_ARTIFACT=NO`, `ROLLBACK_CODE_REVISION_EXACT=YES`.
- Runbook SQL blocks run verbatim (§6 2.5 → §8 → §9 → re-apply) on disposable PostgreSQL 15.18 with the P1-era schema, the exact `02-app-roles.sh` Drive SQL and seeded lifecycle rows — pass:
  - exactly 9 `drive_app` grants (SELECT/INSERT/UPDATE ×3);
  - `DRIVE_APP_PRIV` `D=false T=false` on all three tables, and `OTHER_TABLES_WITHOUT_DRIVE_APP_DELETE=0 OF 21`;
  - `PRIV_BAD=0`;
  - lifecycle rows and protected-Vault/tree fingerprints unchanged;
  - re-apply leaves the schema fingerprint unchanged.

  The first attempt exposed a runbook query error: a name-based `has_table_privilege` over `pg_tables` evaluated against system tables. It was fixed to an OID-based check and re-run clean.
- `git fetch origin` — pass: `origin/main` = `9f5a01148ce016bc0056dbbcc85ac8a3e5fac23f`, the merge of PR #297 (MERGED); `git show origin/main:<012> | sha256sum` = `aac26537…b239`.
- `git merge-base --is-ancestor` for `fa22edd5`, `3747a183`, `04890e18` against the candidate — pass.
- `docker compose config` with a synthetic base + PR187-style flags + both refreshed overlays — pass: image `aegis-prod-drive:preview-d1-s1-9f5a01148ce0` only; SCHEMA/READ true, WRITE false, media true, purge false, tree flags inherited, no budget variable; omitting the D-1 overlays renders the P1 image.
- `vaultTreeConfigFromEnv` at the candidate with the Stage 1 env — pass: boots, budget `null`. Static mutating-handler count in `vaultPreviewIndex.js` at the candidate — `0`.
- `bash -n` on all 13 runbook bash blocks and `node --check` on the console snippet — pass.
- `git show :<overlay> | sha256sum` on both overlays — pass: equal to the runbook §1 values.
- Governance tests, `validate-vault.mjs`, `git diff --cached --check`, and an added-line secret scan — recorded in the PR at commit time.
- History (superseded, not evidence for this package): the earlier package for `4a8cc3c9` passed the same harness and checks with the pre-PR #297 migration (SHA-256 `aaeee44a…edb5`), which granted `drive_app` DELETE via default privileges.
- No application tests were run: this PR changes no runtime code, test, or build input.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-status.md` — D1-STAGE1 task refreshed to candidate `9f5a0114` (session S3); D1-B and D1-PRIV recorded as merged.

## Shared surfaces touched

- `IDEA1-AEGIS_Drive_LC/deploy/production/d1/drive-image-9f5a01148ce0.yml` — Production Drive image selection for Stage 1.
- `IDEA1-AEGIS_Drive_LC/deploy/production/d1/drive-preview-index-stage1-9f5a01148ce0.yml` — Production Vault preview-index flag contract (writer OFF).
- `IDEA1-AEGIS_Drive_LC/docs/superpowers/plans/2026-10-02-idea1-d1-stage1-production-runbook.md` — Human-only Production database migration, cutover, acceptance and rollback contract.
- `IDEA1-AEGIS_Drive_LC/deploy/production/d1/rehearsal/rollback-a-prime-rehearsal.sh` — deployment rehearsal tooling for the Production rollback contract (local only).
- `IDEA1-AEGIS_Drive_LC/deploy/production/d1/rehearsal/rollback-a-prime-driver.mjs` — deployment rehearsal tooling for the Production rollback contract (local only).

## Integration requests

- Kla (IDEA1 owner and integration reviewer): the package is refreshed onto the post-PR #297 candidate `9f5a0114`, D1–D5 are decided, and local rollback A′ passes with corrected migration 012. Decide HG-S1 for `9f5a0114`; it was `WITHHELD_PENDING_LOCAL_ROLLBACK_A_PRIME`. Do not use `4a8cc3c9`. The following are Human-only: execution of migration 012, cutover, acceptance, the rollback A′ rehearsal, and the forward redeploy. Migration 012 is retained on every rollback and has no down-migration.

## Known limitations

- Nothing has been executed in Production; no Stage 1 server, browser, or rollback result exists. No cell of the acceptance matrices may be read as PASS.
- The Production candidate image has not been built; its image ID, archive hash, and toolchain versions are recorded only at Human build time.
- The live Production Compose chain after P1 is not recorded in the repository; the runbook captures it from container labels at run time and stops on any unexplained difference.
- Rollback A′ was rehearsed with local builds (exact code revisions, Windows CRLF checkout), not the Production artifacts. No Production data, volume scale, gateway/Twingate path, or browser UI was involved (client modules ran in Node). The recovery listing had no orphan to show. Plan Task I.2 cases A–E for later stages remain PR-E work.
- The fresh-install privilege path is evidenced by PR #297 at the same merged files, not re-run here.
- The preview-index write-route 503 is not a Stage 1 requirement (D1); it is required at Stage 2.
