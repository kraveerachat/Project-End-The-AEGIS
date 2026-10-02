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
- Recorded five Human decisions (runbook §3), notably: the Stage 1 build has no preview-index write route, so "write route → 503 `PREVIEW_INDEX_WRITE_DISABLED`" cannot be observed until Stage 2; Stage 1 substitutes static absence + `/state` write=false + boot line + zero index rows.
- `PRODUCTION_MIGRATION_EXECUTED=NO`, `PRODUCTION_DEPLOYED=NO`, `PRODUCTION_FLAGS_CHANGED=NO`, `WRITER_ENABLED=NO`. No image was built; no Production host was contacted.

## Source files changed

- `IDEA1-AEGIS_Drive_LC/deploy/production/d1/drive-image-4a8cc3c95e2f.yml` — Stage 1 exact-source Drive image overlay (SHA-256 `3007843780120322fae5d5d8bf7f7edcf15e7982ba454a7d4fa28c6d39dd9151`).
- `IDEA1-AEGIS_Drive_LC/deploy/production/d1/drive-preview-index-stage1-4a8cc3c95e2f.yml` — Stage 1 preview-index flags overlay, writer OFF (SHA-256 `7c5f0df78c3f5cf46bb2edd83bb8b015ed63d9645ed8de22c69eb1d8d6216a59`).
- `IDEA1-AEGIS_Drive_LC/docs/superpowers/plans/2026-10-02-idea1-d1-stage1-production-runbook.md` — Human-only Stage 1 migration, acceptance, rollback A′ and forward-redeploy runbook.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-status.md` — D1-STAGE1 current task; D1-B moved to closed/merged.

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
- No application tests were run: the PR changes no runtime code, test, or build input.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-status.md` — added D1-STAGE1 current task and session register; marked D1-B merged at `4a8cc3c9` and not deployed.

## Shared surfaces touched

- `IDEA1-AEGIS_Drive_LC/deploy/production/d1/drive-image-4a8cc3c95e2f.yml` — Production Drive image selection for Stage 1.
- `IDEA1-AEGIS_Drive_LC/deploy/production/d1/drive-preview-index-stage1-4a8cc3c95e2f.yml` — Production Vault preview-index flag contract (writer OFF).
- `IDEA1-AEGIS_Drive_LC/docs/superpowers/plans/2026-10-02-idea1-d1-stage1-production-runbook.md` — Human-only Production database migration, cutover, acceptance and rollback contract.

## Integration requests

- Kla (IDEA1 owner and integration reviewer): review the Stage 1 package; decide runbook §3 D1–D5 (Stage 1 substitute for the unobservable write-route 503, NEWLY_CREATED_USER TREE_V1 precondition, whether Case A′ needs a local rehearsal before HG-S1); then grant or withhold HG-S1. Execution of migration 012, cutover, acceptance, rollback A′ rehearsal, and forward redeploy is Human-only; migration 012 is retained on every rollback and has no down-migration.

## Known limitations

- Nothing has been executed in Production; no Stage 1 server, browser, or rollback result exists. No cell of the acceptance matrices may be read as PASS.
- The candidate image has not been built; image ID, archive hash, and toolchain versions are recorded only at Human build time.
- The live Production Compose chain after P1 is not recorded in the repository; the runbook captures it from container labels at run time and stops on any unexplained difference.
- Rollback Case A′ (P1 image on a migration-012 database) is supported by source inspection and the PostgreSQL rehearsal of the migration only; plan Task I.2 (PR-E) has not run, so the P1 server has not been booted against a migrated database.
- The preview-index write-route 503 is not observable at Stage 1; it moves to Stage 2 acceptance.
