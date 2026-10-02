---
title: Task Receipt — IDEA2 Engine producer-generation current-main reconciliation
date: 2026-10-03T01:11:09+07:00
owner: pub
area: idea2
branch: fix/idea2-engine-producer-generation-reconcile-v2
status: partial
edit_policy: append-by-new-file
---

# Task Receipt — IDEA2 Engine producer-generation current-main reconciliation

## What changed

- Base: `1579712866ef0e83c5b949b0afed7a7969e0f80f`, which includes merged PR #298. That PR's canonical SID comparison, staged DataRoot ACL lifecycle, and expected-current-key-version rotation CAS remain outside this change.
- Final implementation/evidence checkpoint: `86eec04b3d22c62a97ca07da9783806fe291d11b`. The authoritative historical Engine commits `f24367bd32ba369be765ce105d981ce3a0f024a7` and `dceb52f3b5452a11cee3f815af0d52fe74de1bd7` are absent from current main. Current Monitor already supplies its server-owned generation, but current-main Engine source lacked generation parsing and isolation.
- Reconciled the strict capture-on-demand Engine endpoint: it authenticates the independent Engine key first, requires exactly one canonical positive PostgreSQL BIGINT generation header, rejects malformed/duplicate/overflow values, and rejects stale preflight authority with 409. Query and body values cannot substitute for the header. A generation superseded after response creation ends cleanly without stale demand.
- One physical producer generation owns the Engine viewer leases. Same-generation viewers share demand, a newer generation invalidates old viewers and frames, stale cleanup cannot release current viewers, and final current-viewer cleanup releases capture. Always-on compatibility can omit generation only before numbered authority exists.
- This successor reused the reviewed code/test delta only after proving those five tracked paths byte-identical between the predecessor base and current main. The predecessor's old receipt and dirty worktree remain untouched; its plan and receipt were not copied into this branch.

## Source files changed

- `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/local_api.py` — key-first bounded generation parsing and stream lease handling.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/stream_hub.py` — generation-scoped leases, stale rejection, demand release and frame boundary.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_producer_generation_contract.py` — strict Engine HTTP contract and race regressions.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_producer_generation_isolation.py` — generation isolation and compatibility regressions.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_stream_lifecycle_regression.py` — generation-aware existing lifecycle fixtures.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_viewer_demand.py` — exact viewer lease and frame-timing fixtures.
- `IDEA2-AEGIS_Monitor/tests/fixtures/machineAEngineHarness.py` — local contract probe supplies the server generation header; the probe itself was not run in this no-service-start task.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea2/idea2-status.md` — successor checkpoint, current evidence, PR #298 merge state and remaining acceptance boundary.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-10-03_011109_pub_idea2-engine-producer-generation-reconcile-v2.md` — this single new final task receipt.

## Verification evidence

- On exact current main, `python -m unittest tests.test_producer_generation_contract tests.test_producer_generation_isolation` before source repair — FAIL as intended (RED): 11 tests, 15 failures and 6 errors, including missing generation lease API and accepted malformed authority.
- From Detection Engine, `python -m unittest tests.test_producer_generation_contract tests.test_producer_generation_isolation tests.test_stream_lifecycle_regression tests.test_viewer_demand` in the disposable Python 3.12 environment — PASS: 30/30.
- From Detection Engine, `python -m unittest discover -s tests` in the same environment — PASS: 232 tests, zero failures. No real Machine A service or camera was started.
- From Monitor, `node --test tests/physicalCameraStreamRouting.test.mjs tests/streamLifecycle.test.mjs tests/machineAAccountSymmetry.test.mjs tests/physicalCameraHeartbeat.test.mjs tests/viewerDemandAvailability.test.mjs` — PASS: 59 pass, 0 fail, 1 conditional disposable-PostgreSQL skip.
- From Monitor, `npm test` — PASS: 237 total, 179 pass, 0 fail, 58 conditional disposable-PostgreSQL skips. The initial dependency-free checkout attempt failed before assertions because `bcryptjs` was absent; `npm ci --no-audit --no-fund` installed the lockfile dependencies, then the rerun passed.
- From Monitor, `npm run build` — PASS: Vite built 2077 modules.
- From repository root, `node --test tests/collaborationPolicy.test.mjs tests/vaultStructure.test.mjs tests/vaultMultiWriter.test.mjs tests/coreEntryGovernanceR4.test.mjs` — PASS: 61/61.
- `node scripts/validate-vault.mjs --vault Obsidian_AEGIS_Vault/AEGIS_Knowledge` — PASS with two pre-existing Canvas owner-data warnings.
- `git diff --check` and exact seven-path cached implementation diff check — PASS. Changed-content high-confidence credential scan and forbidden-path scan — zero hits.
- Scoped source/security review — no open Critical or Important source defect in this patch; independent Engine key, server generation authority, stale-viewer isolation, exact release and no secret logging remain enforced. The separate SOC passive-live rollout blocker is recorded below.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea2/idea2-status.md` — records the successor source checkpoint and current-main test evidence; marks PR #298 merged without claiming its live Windows retest.

## Shared surfaces touched

- None — all changed paths are within Pub's IDEA2 code and knowledge boundary.

## Integration requests

- Pub: review the Engine key/generation order, PostgreSQL BIGINT string boundary, same-physical-producer viewer sharing and demand cleanup before source merge.
- Kla: review the Machine A rollout prerequisites and the separate SOC passive-live design before any deployment. If a reviewed Engine image is later installed, bind its immutable source/image identity to this checkpoint; rollback would restore the previously approved Engine image/config under a separate human-governed deployment plan.

## Known limitations

- The exact installed Machine A Engine source/image SHA remains unproven. The historical live 401/400 observation is compatible with the stranded commits but does not establish artifact provenance. No Machine A, Production, database, service, key or physical camera was touched here.
- The repository requires Human-gated Machine A values `AEGIS_MONITOR_INGEST_MODE=identity_agent`, `AEGIS_CAPTURE_ON_DEMAND=true`, `AEGIS_STREAM_ENABLED=true`, and both stream URLs at `http://aegis-stream-host.internal:18077/stream.mjpg`. Repository defaults are not installed-runtime evidence.
- Strict SOC currently sends no server-owned producer generation or passive no-wake viewer contract. Because logical aliases are not globally unique physical producers, SOC-to-active-physical-producer selection is a separate pre-live task. Capture-on-demand Production rollout remains blocked until it is designed and tested.
- Real disposable-PostgreSQL Monitor cases were conditionally skipped in this source-only task. The direct local Engine harness was not run because this task prohibited service start. Machine A browser acceptance and Production deployment were not performed.
