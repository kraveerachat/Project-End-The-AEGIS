---
title: Task Receipt — IDEA1 D-1 PR-E preview-index capacity, security, compatibility and rollback evidence
date: 2026-10-04T01:07:57+07:00
owner: kla
area: idea1
branch: codex/idea1-pr-e-idx-size
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA1 D-1 PR-E preview-index capacity, security, compatibility and rollback evidence

## What changed

- D-1 PR-E (PR #310) carries plan Phases G, H and I in one PR by Human decision. Evidence/code head reviewed at HG-H: `5d3b450ba8c2d4a4340c014cf5e54edd0e0a7606` (frozen code head `f69f7aa6`, docs `8dac2746`, normal merge of `origin/main` `ed351310`). This receipt commit is docs-only on top of that head.
- **G.1/G.2 (Codex):** IDX-SIZE harness and disposable-local matrix. Under Human `D1_G2_PLAN_REVISION_OPTION_B_APPROVED` (Revision 3): 14/14 required cells (PostgreSQL 6 + Chrome 6 + exact Memory 1k 2), 20 runs each, 0 B main-manifest delta; four Memory 5k/10k cells historically `NOT_MEASURED`, now `NOT_APPLICABLE_BY_HUMAN_APPROVED_PLAN_REVISION`. Raw JSON preserved outside Git with SHA-256 index in PR #310.
- **G.3 (Human `HG_G_APPROVED` 2026-10-03 at `89da7f84`; codified `7c51dced`; verified by Claude #1 after the Human sole-writer handoff Codex → Claude #1):** client `APPROVED_KEYS` `initialPrefixBits=6`, `maxPrefixBits=7`, `maxShards=128`, `maxShardDecodedBytes=196608`, `maxRootDecodedBytes=16379`, `maxEntriesPerCas=16`, `ciphertextLruBytes=33554432`; server KEEP `maxPreviewIndexAttachPerCas=64`, `maxPreviewIndexEnvelopeBatch=32`. KEEP_UNMEASURED (not measured approvals): `casMaxAttempts=5`, `writeQueueMax=64`, `backfillMaxPerSession=50`, `derivativeLaneConcurrency=6`, `maxLiveDecodedShards=16`, `generationBudgetMs=10000`, `maxPreviewIndexSupersededPerCas=64`. Padding buckets and `backfillConcurrency` stay provisional.
- **Retained budget:** exactly 8,589,934,592 B (8 GiB) per owner, recorded as approval constant `HG_G_RETAINED_BUDGET_APPROVAL` only. Runtime default stays `null`; `WRITE=true` without an explicit env budget fails at boot (`PI-BUDGET-3`). `VAULT_PREVIEW_INDEX_WRITE_ENABLED` default stays `false`. The G.3 Stage 3 budget-prep overlay was removed from PR-E (`e4632cb9`, Human scope decision; Production overlays belong to Phase J).
- **H.1 `7db1e36c`:** consolidated security gates — shared server spec memory 21/21 (spec 10 + client gates 10 + coverage map SG-MAP-1), PostgreSQL 10/10, 0 skips; 7 negative controls (content id, upload-session owner, source binding, CAS expectation, write gate, create-time budget, AN-4 identity) each FAIL when broken and PASS when restored; SG-SUP-2 full SQL capture: no DELETE/TRUNCATE/DROP on protected tables, no purge-candidate insert.
- **H.2 `21a992f4`:** account neutrality ADMIN / EXISTING_USER / NEWLY_CREATED_USER — memory 5/5 + PostgreSQL 5/5, 0 skips; AN-4 source scan: D-1 code never branches on account identity.
- **H.3 `60539bc7`:** audit-volume probe, memory 1k + PostgreSQL 1k × 20 runs; reference scenario (60-tile cold view + one 16-job backfill) PostgreSQL 160 rows; privacy scan 0 violations (memory 4,930 rows, PostgreSQL 8,573 rows). Human: acceptance threshold 200 rows — evidence threshold only, not a runtime limit; PostgreSQL authoritative.
- **I.1 `52de775d`:** baseline client `2dc596d1` on the current server — memory 8/8 + PostgreSQL 8/8, 0 skips.
- **I.2 `48afe548`:** rollback A / A′ / B / C / D / E on one PostgreSQL database served by current, Stage 1 (`9f5a0114`) and baseline code — 8/8, 0 skips; no down-migration, no destructive SQL on protected tables.
- **I.3 `f69f7aa6`:** real Chrome 154 local acceptance PASS (lock during backfill, no extra original GET, derivative-first fresh unlock, UI upload ordering, corruption fallback, pagehide, browser storage, memory, Object URLs); evidence `i3-chrome-pg-r2.json` SHA-256 `3570893d90499e47fdf41c545af6f75671c6d67fc7ca0072faf79c346d86276c`.
- **HG-H:** independent review `PASS_FOR_HG_H_SUBMISSION` at `5d3b450b`; Human `HG_H_APPROVED` 2026-10-04.
- `PRODUCTION_MUTATION=NO`, `WRITER_ENABLED=NO` (every environment), `PR_MERGED=NO` at receipt creation, `MAIN_MANIFEST_SCHEMA_WRITE=1`, `DESTRUCTIVE_GC=NONE`. Phase J (Production deployment) is a separate post-merge workstream; none of its evidence is claimed here.

## Source files changed

- `IDEA1-AEGIS_Drive_LC/scripts/measure/vault-preview-index-size.mjs` — G.1 codec/e2e CLI, local-server guards, exclusive-create raw output.
- `IDEA1-AEGIS_Drive_LC/scripts/measure/vault-preview-index-e2e.mjs` — G.1 actual V2 upload/index/CAS/writer/reader + Chrome measurement; H.3 helper exports and optional retained budget.
- `IDEA1-AEGIS_Drive_LC/scripts/measure/vault-preview-index-audit-volume.mjs` — H.3 audit-volume probe.
- `IDEA1-AEGIS_Drive_LC/scripts/measure/vault-preview-index-browser-i3.mjs` — I.3 real-Chrome local acceptance driver.
- `IDEA1-AEGIS_Drive_LC/src/lib/vaultPreviewIndexConstants.js` — G.3 `HG_G_APPROVAL`, `APPROVED_KEYS`, remaining `PROVISIONAL_KEYS`; no numeric value changed.
- `IDEA1-AEGIS_Drive_LC/server/config/vaultTreeLimits.js` — G.3 `HG_G_RETAINED_BUDGET_APPROVAL` (8,589,934,592 B); no runtime default.
- `IDEA1-AEGIS_Drive_LC/tests/previewIndexSizeProbe.test.js`, `tests/previewIndexConstants.test.js`, `tests/vaultTreeConfig.test.js` — G.1/G.3 tests (PIK-3, PI-BUDGET-3).
- `IDEA1-AEGIS_Drive_LC/tests/helpers/previewIndexSecurityGateSpec.mjs`, `tests/previewIndexSecurityGates.test.js`, `tests/previewIndexSecurityGatesPostgres.test.js` — H.1.
- `IDEA1-AEGIS_Drive_LC/tests/helpers/previewIndexNeutralitySpec.mjs`, `tests/previewIndexAccountNeutrality.test.js`, `tests/previewIndexAccountNeutralityPostgres.test.js`, `tests/previewAccountNeutrality.test.js` — H.2.
- `IDEA1-AEGIS_Drive_LC/tests/previewIndexAuditVolumeProbe.test.js` — H.3 guards.
- `IDEA1-AEGIS_Drive_LC/tests/helpers/previewIndexOldClientSpec.mjs`, `tests/previewIndexOldClientCompat.test.js`, `tests/previewIndexOldClientCompatPostgres.test.js` — I.1.
- `IDEA1-AEGIS_Drive_LC/tests/previewIndexRollback.test.js` — I.2.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-status.md` — canonical note (below).
- `docs/superpowers/plans/2026-10-02-idea1-d1-separate-encrypted-preview-index-implementation.md` — cross-scope (below).

## Verification evidence

- `timeout --kill-after=30 5400 node --test --test-reporter=tap --test-concurrency=1 "tests/**/*.test.js"` at frozen code head `f69f7aa6` — fail (literal FAIL by count): 2,909 tests / 2,576 pass / 101 fail / 0 cancelled / 232 skipped, 47 min. Exact failing-name comparison: 101 identical to the G.3 baseline names (identical on base `89da7f84`), 0 new; `vaultTreeApi OR-4` Windows EPERM flake passed this run. `NEW_DETERMINISTIC_FAILURES=0`. `FULL_SUITE_PASS` not claimed.
- Earlier full suites (classification history): G.3 `7c51dced` 2,841 / 102 fail = 101 baseline + OR-4 EPERM flake (3/3 isolated pass); H head `60539bc7` INCOMPLETE (host low memory after 2,165 tests, 40 fail all baseline) — diagnostic only, no claim; Human `H_FULL_SUITE_RERUN_NOW=NO`.
- Focused memory at `f69f7aa6`: `node --test tests/previewIndexSecurityGates.test.js tests/previewIndexAccountNeutrality.test.js tests/previewAccountNeutrality.test.js tests/previewIndexAuditVolumeProbe.test.js tests/previewIndexSizeProbe.test.js tests/previewIndexOldClientCompat.test.js tests/previewIndexConstants.test.js tests/vaultTreeConfig.test.js` — pass 61/61, 0 skips.
- PostgreSQL 15 disposable (`AEGIS_PGTEST_PORT=55750 sh scripts/pg-integration-env.sh up`, `drive_app`, one process per file) at `f69f7aa6` — pass 68/68, 0 skips: Store 15, CAS 6, StorageBudget 3, Migration 13, SecurityGates 10, AccountNeutrality 5, OldClientCompat 8, Rollback 8.
- I.3 `D1_I3_CONFIRMED=1 node scripts/measure/vault-preview-index-browser-i3.mjs --chrome <chrome.exe> --playwright-core <path> --out …/i3-chrome-pg-r2.json --files 24` after `npm run build` — pass (Chrome 154.0.8037.95); tracked `dist` restored.
- H.3 `node scripts/measure/vault-preview-index-audit-volume.mjs --server memory|pg --nodes 1000 --runs 20` — pass (exit 0, 0 privacy violations); raw SHA-256 `01d355ac…431611` (memory), `a300d556…b530e` (PostgreSQL).
- Repo root `node --test tests/vaultStructure.test.mjs tests/vaultMultiWriter.test.mjs tests/collaborationPolicy.test.mjs tests/coreEntryGovernanceR4.test.mjs` — pass 61/61. `node scripts/validate-vault.mjs --vault Obsidian_AEGIS_Vault/AEGIS_Knowledge` — pass (2 pre-existing canvas warnings). `npx vite build --outDir <scratch>` — pass, 2,764 modules, no tracked file touched. `git diff --check origin/main...HEAD` — pass. Added-line secret scan — pass, 0 sensitive paths (only disclosed dummy guard URLs). `node scripts/validate-collaboration-policy.mjs` (local event + changed files) — pass. Closeout re-run after this receipt (docs-only, no runtime source change since `f69f7aa6`): governance, vault validation, diff check, collaboration policy, receipt count 1 and added-line secret scan — pass; full suite not re-run.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-status.md` — Current Task D1-E: G/H/I complete, HG-G and HG-H approved, one final receipt, Ready for Human merge; session register D1E-S1..S8; Production unchanged; writer OFF.

## Shared surfaces touched

- `docs/superpowers/plans/2026-10-02-idea1-d1-separate-encrypted-preview-index-implementation.md` — cross-scope approved implementation plan: G.2 Revision 3 (gate applicability), HG-G decision record, G.3 checklist (`7c51dced`), Stage 3 approved-budget checklist line. No runtime/deployment behavior change. Rollback: revert plan text after a new Human decision.

## Integration requests

- Kla/integration review of the cross-scope plan path above (G.2 Revision 3 authority and HG-G record).
- Human Owner merge of PR #310. Phase J Production stages (J1–J4), writer enablement and any Production budget overlay remain separately Human-gated and are not part of this task.

## Known limitations

- Full suite is not green: 101 pre-existing baseline failures (e.g. `vaultV2ScreenUi` 29, `vaultMediaPreview` 24, `vaultTileActions` 22), 0 new. No literal full-suite PASS.
- All server latency is local loopback, not LAN; Chrome timings are client-side. Four Memory 5k/10k cells never measured (excluded by Human revision). Raw timing JSON keeps p50/p95 only and lacks embedded Git SHA/seed.
- H.3 is one owner, 1k nodes; memory 500-row audit ring truncates the informational initial-build count.
- KEEP_UNMEASURED values carry forward unmeasured; padding buckets and `backfillConcurrency` provisional.
- Capacity guard (2 writer-eligible owners × 8 GiB vs 31,215,161,344 B Human snapshot) not re-measured; repeat Production filesystem review before more than 2 writer-eligible owners.
- I.3 is local headless Chrome with a disposable PostgreSQL; GPU/decoded-image memory not included. No Production, LAN or deployed acceptance is claimed.
