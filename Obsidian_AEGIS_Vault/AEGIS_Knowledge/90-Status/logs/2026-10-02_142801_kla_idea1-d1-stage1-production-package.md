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

- Prepared the Human-controlled D-1 Stage 1 (compatibility / read-only, writer OFF) package for candidate `origin/main` `4a8cc3c95e2f4147fbab9c505079c0377a271d99`, which contains PR-A #283 (`fa22edd5`) and PR-B #285 (head `3747a183`), satisfying `STAGE_1_BUILD=PR_A_MERGED + PR_B_MERGED`.
- Per-SHA overlays: exact-source image `aegis-prod-drive:preview-d1-s1-4a8cc3c95e2f`; flags `VAULT_PREVIEW_INDEX_SCHEMA_AVAILABLE=true`, `_READ_ENABLED=true`, `_WRITE_ENABLED=false`, `VAULT_MEDIA_PREVIEW_ENABLED=true`, `VAULT_DESTRUCTIVE_PURGE_ENABLED=false`; retained-bytes budget absent; `VAULT_TREE_*` inherited unchanged.
- Runbook: build/transfer, backup gate, read-only preconditions from the live Compose labels, migration 012 Human command (`psql -v ON_ERROR_STOP=1`, superuser, lock timeout, no down-migration), pre/post read-only verification queries and fingerprints, render validation, Drive-only cutover, server acceptance, per-account `/state` + `/preview-index/head` check, LAN/REMOTE browser matrix for ADMIN / EXISTING_USER / NEWLY_CREATED_USER, rollback Case A′ to the P1 image with migration 012 retained, and forward redeploy checklist.
- Human package review decided D1–D5 (runbook §3): `D1_STAGE1_WRITE_503_SUBSTITUTE=APPROVED` (`STAGE1_WRITE_ROUTE_PRESENT=NO`, `STAGE1_WRITE_ROUTE_404=EXPECTED`, `STAGE1_WRITE_CAPABILITY=NOT_ROUTABLE`, `STAGE2_WRITE_DISABLED_503_REQUIRED=YES`); `D2` NEWLY_CREATED_USER 409 before Vault setup = `ACCOUNT_NOT_SETUP`; `D3` direct server head check mandatory; `D4` local rollback A′ required before HG-S1; `D5` live Compose discovery fail-closed. The runbook now encodes all five.
- Local disposable rollback A′ runtime rehearsal (D4): P1 code `8634360f` and the Stage 1 candidate as local Docker images on one PostgreSQL 15.18 database with the P1-era schema, the Production role model, and migration 012 applied as the runbook specifies — `ROLLBACK_A_PRIME_LOCAL=PASS`. Harness committed under `IDEA1-AEGIS_Drive_LC/deploy/production/d1/rehearsal/`.
- The rehearsal corrected one runbook defect: Production default privileges grant `drive_app` DELETE on the three new tables, so the previous "no DELETE" requirement would have stopped a correct Production migration; the runbook now expects and records it.
- `PRODUCTION_MIGRATION_EXECUTED=NO`, `PRODUCTION_DEPLOYED=NO`, `PRODUCTION_FLAGS_CHANGED=NO`, `WRITER_ENABLED=NO`. No Production image was built (only local rehearsal images); no Production host was contacted.

## Source files changed

- `IDEA1-AEGIS_Drive_LC/deploy/production/d1/drive-image-4a8cc3c95e2f.yml` — Stage 1 exact-source Drive image overlay (SHA-256 `3007843780120322fae5d5d8bf7f7edcf15e7982ba454a7d4fa28c6d39dd9151`).
- `IDEA1-AEGIS_Drive_LC/deploy/production/d1/drive-preview-index-stage1-4a8cc3c95e2f.yml` — Stage 1 preview-index flags overlay, writer OFF (SHA-256 `7c5f0df78c3f5cf46bb2edd83bb8b015ed63d9645ed8de22c69eb1d8d6216a59`).
- `IDEA1-AEGIS_Drive_LC/docs/superpowers/plans/2026-10-02-idea1-d1-stage1-production-runbook.md` — Human-only Stage 1 migration, acceptance, rollback A′ and forward-redeploy runbook; D1–D5 decisions and rehearsal evidence.
- `IDEA1-AEGIS_Drive_LC/deploy/production/d1/rehearsal/rollback-a-prime-rehearsal.sh` — local/disposable rollback A′ orchestration (PostgreSQL, P1 and Stage 1 containers; no Production).
- `IDEA1-AEGIS_Drive_LC/deploy/production/d1/rehearsal/rollback-a-prime-driver.mjs` — drives each revision with its own real client modules over HTTP.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-status.md` — D1-STAGE1 current task (sessions S1, S2); D1-B moved to closed/merged.

## Verification evidence

- `git fetch origin; git rev-parse origin/main` — pass: `4a8cc3c95e2f4147fbab9c505079c0377a271d99`, equal to the handoff candidate.
- `git merge-base --is-ancestor fa22edd5 HEAD` and `git merge-base --is-ancestor 3747a183 HEAD` — pass: PR-A and PR-B both in candidate.
- `bash -n` on every bash block extracted from the runbook — pass: 13/13; `node --check` on the browser console snippet — pass.
- Disposable `postgres:15-alpine` (15.18), P1-era `schema.sql` from `8634360f`, seeded lifecycle rows, runbook SQL blocks run verbatim (container name substituted) — pass: pre 7 tree tables / 0 D-1 tables / four-value CHECK; migration 012 (SHA-256 `aaeee44afc11ada90e91e311ce3dcafe88ddcf493586fc06c6b45defbed1edb5`) applied; post 3 D-1 tables, one six-value CHECK, 3 triggers, 9 `drive_app` grants (SELECT/INSERT/UPDATE; DELETE and TRUNCATE false), all D-1/INDEX rows 0, lifecycle distribution unchanged, protected-Vault and tree-state fingerprints unchanged; second application no-op with unchanged schema fingerprint.
- `docker compose config` with a synthetic base + PR187-style flags + both D-1 overlays — pass: candidate image only; SCHEMA/READ true, WRITE false, media true, purge false, tree flags inherited, no budget variable; omitting D-1 overlays renders the P1 image.
- `vaultTreeConfigFromEnv` at the candidate with the Stage 1 env — pass: boots, budget `null`; READ with media off and WRITE without budget are both rejected.
- `git show 4a8cc3c9:IDEA1-AEGIS_Drive_LC/server/routes/vaultPreviewIndex.js | grep -cE 'vaultPreviewIndexRouter\.(post|put|patch|delete|all)\('` — `0`; `requirePreviewIndexWrite` defined only.
- `git show :<overlay> | sha256sum` on both staged overlays — pass: equal to the runbook §1 values (LF bytes as committed).
- `node --test tests/vaultStructure.test.mjs tests/vaultMultiWriter.test.mjs tests/collaborationPolicy.test.mjs` — pass: 59/59.
- `node scripts/validate-vault.mjs` — pass with the two pre-existing owner-data canvas warnings.
- `git diff --cached --check` — pass; added-line secret-pattern scan — zero matches.
- `P1_ROOT=<clean 8634360f worktree>/IDEA1-AEGIS_Drive_LC S1_ROOT=<clean 4a8cc3c9 worktree>/IDEA1-AEGIS_Drive_LC bash IDEA1-AEGIS_Drive_LC/deploy/production/d1/rehearsal/rollback-a-prime-rehearsal.sh` — pass, run twice (working copy, then committed file verbatim), identical: seed on P1 10/10; migration 012 applied (SHA-256 `aaeee44a…edb5`), 12 `drive_app` grants incl. DELETE via default privileges, no TRUNCATE; Stage 1 19/19 (`/state` schema/read true, write false; GET head 404 `PREVIEW_INDEX_NOT_FOUND` for ADMIN / EXISTING_USER / NEWLY_CREATED_USER; authenticated POST head `404 {"error":"Not found"}`; NEWLY_CREATED_USER 409 before setup, 404 after); rollback A′ P1 on the same migrated DB 47/47 (login, unlock, browse, upload, byte-exact download, rename, move, trash, restore, recovery listing, lock — all three account classes); migration 012 retained; seed blob rows identical to pre-migration; forward Stage 1 23/23; 0 preview-index and `INDEX_*` rows throughout; all disposable containers/volumes/network removed.
- Local images: `aegis-local-rehearsal-drive:p1-8634360f74ed` (`sha256:b8285def…2f09`, OCI revision `8634360f…`), `aegis-local-rehearsal-drive:preview-d1-s1-4a8cc3c95e2f` (`sha256:0eea28d0…000e`); node v20.20.2, Alpine 3.23.4, user node. `ROLLBACK_IMAGE_EXACT_PRODUCTION_ARTIFACT=NO`, `ROLLBACK_CODE_REVISION_EXACT=YES`.
- Runbook re-check after edits: `bash -n` 13/13 blocks, `node --check` snippet — pass.
- No application tests were run: the PR changes no runtime code, test, or build input.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-status.md` — added D1-STAGE1 current task and session register; marked D1-B merged at `4a8cc3c9` and not deployed.

## Shared surfaces touched

- `IDEA1-AEGIS_Drive_LC/deploy/production/d1/drive-image-4a8cc3c95e2f.yml` — Production Drive image selection for Stage 1.
- `IDEA1-AEGIS_Drive_LC/deploy/production/d1/drive-preview-index-stage1-4a8cc3c95e2f.yml` — Production Vault preview-index flag contract (writer OFF).
- `IDEA1-AEGIS_Drive_LC/docs/superpowers/plans/2026-10-02-idea1-d1-stage1-production-runbook.md` — Human-only Production database migration, cutover, acceptance and rollback contract.
- `IDEA1-AEGIS_Drive_LC/deploy/production/d1/rehearsal/rollback-a-prime-rehearsal.sh` — deployment rehearsal tooling for the Production rollback contract (local only).
- `IDEA1-AEGIS_Drive_LC/deploy/production/d1/rehearsal/rollback-a-prime-driver.mjs` — deployment rehearsal tooling for the Production rollback contract (local only).

## Integration requests

- Kla (IDEA1 owner and integration reviewer): D1–D5 decided; local rollback A′ (D4) now PASS — decide HG-S1 (currently `WITHHELD_PENDING_LOCAL_ROLLBACK_A_PRIME`). Also for PR-C/HG-C: `drive_app` holds DELETE on the preview-index tables via Production default privileges and `vault_preview_index_heads` has no delete trigger. Execution of migration 012, cutover, acceptance, rollback A′ rehearsal, and forward redeploy is Human-only; migration 012 is retained on every rollback and has no down-migration.

## Known limitations

- Nothing has been executed in Production; no Stage 1 server, browser, or rollback result exists. No cell of the acceptance matrices may be read as PASS.
- The Production candidate image has not been built; its image ID, archive hash, and toolchain versions are recorded only at Human build time.
- The live Production Compose chain after P1 is not recorded in the repository; the runbook captures it from container labels at run time and stops on any unexplained difference.
- Rollback A′ was rehearsed with a local build of the exact P1 code revision, not the Production image artifact; no Production data, volume scale, gateway/Twingate path, or browser UI was involved (client modules ran in Node). The recovery listing had no orphan to show. Plan Task I.2 cases A–E for later stages remain PR-E work.
- The preview-index write-route 503 is not a Stage 1 requirement (D1); it is required at Stage 2.
