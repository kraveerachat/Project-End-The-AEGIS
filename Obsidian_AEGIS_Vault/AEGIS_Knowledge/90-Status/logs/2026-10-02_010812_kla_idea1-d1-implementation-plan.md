---
title: Task Receipt — IDEA1 D-1 Separate Encrypted Preview Index Implementation Plan
date: 2026-10-02T01:08:12+07:00
owner: kla
area: idea1
branch: docs/idea1-preview-d1-implementation-plan
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA1 D-1 Separate Encrypted Preview Index Implementation Plan

## What changed

- Plan-only task, PR #280. Base `origin/main` `fff78feb7f7296a742794a31dffeb35a134a7660` (PR #279 merged). `APPROVED_PLAN_REVISION_SHA=5279be8e9f7ce99461ca53e22493e847121c27e4` (Implementation Plan Revision 2, the final plan/status checkpoint before this receipt correction; not the final branch HEAD, which is reported in the PR).
- Human review: Revision 1 (checkpoint `8b2ec6f4`, 44 tasks) returned `PLAN_REVIEW=APPROVE_WITH_REQUIRED_CHANGES`; Revision 2 resolved all three required changes and was approved: `PLAN_REVIEW=APPROVED`, `REQUIRED_CHANGES_RESOLVED=YES`. The Human Owner authorized correcting this same task's unmerged receipt in place to match Revision 2.
- Status: `IMPLEMENTATION_PLAN_COMPLETE=YES`, `IMPLEMENTATION_STARTED=NO`, `IMPLEMENTATION_AUTHORIZED=NO`, `PRODUCTION_MUTATION_PERFORMED=NO`, `WRITER_IMPLEMENTED=NO`, `WRITER_ENABLED=NO`.
- The plan implements the Human-approved D-1 architecture (owner-scoped sharded encrypted preview index, no main-manifest linkage, main manifest schema v1) as **46 TDD tasks**: A7, B10, C7, D4, E4, F5, G3, H3, I3 — compatibility/read-only foundation; codec/crypto/reader; index CAS and storage budget; lifecycle/orphan classification; default-OFF writer; thumb/poster generation; IDX-SIZE hard stop; security gates; old-client/rollback/browser evidence — plus Human-only Production Stages 1–4 (Phase J) and closeout criteria (Phase K).
- Implementation PR split: PR-A compat/read-only + budget config/accounting (**not deployed alone**) → PR-B codec + reader (**Stage 1 requires PR-A + PR-B**) → PR-C CAS + lifecycle + orphan safety + server-enforced retained-storage budget → PR-D writer default-OFF + thumb/poster + budget fail-soft circuit breaker → PR-E capacity / storage-budget inputs / security / compatibility / rollback evidence.
- Revision-2 durable facts:
  - `PREVIEW_INDEX_STORAGE_BUDGET=SERVER_ENFORCED`, `BUDGET_SCOPE=PER_OWNER`, `BUDGET_VALUE=PROVISIONAL_TO_BE_MEASURED`, `BUDGET_EXCEEDED=FAIL_CLOSED_FOR_PREVIEW_ONLY` — counts committed `INDEX_STAGED` + `INDEX_MANAGED` root/shard/derivative ciphertext; checked at preview-index upload create and authoritatively at commit under the owner row lock; exhaustion rejects only new preview persistence (originals, downloads, main manifest, existing index objects unaffected; nothing deleted).
  - `VAULT_PREVIEW_INDEX_MAX_RETAINED_BYTES_PER_OWNER=HUMAN_APPROVAL_REQUIRED_AT_HG_G`; `WRITE_TRUE_WITHOUT_BUDGET=BOOT_FAIL_CLOSED`.
  - `STAGE_1_BUILD=PR_A_MERGED_PLUS_PR_B_MERGED`, `STAGE_1_SCHEMA=true`, `STAGE_1_READ=true`, `STAGE_1_WRITE=false`, `NO_PRODUCTION_DEPLOY_BETWEEN_PR_A_AND_PR_B=YES`; Stage 1 acceptance `GET /preview-index/head` → 404 with no index; rollback target = previous accepted P1 runtime image with migration 012 retained.
  - `SUPERSEDED_REF=ADVISORY_ONLY`, `SUPERSEDED_REF_IS_DELETION_AUTHORITY=NO`; `INITIAL_DESTRUCTIVE_GC=FORBIDDEN`; `HG_GC=FUTURE_SEPARATE_TASK`.
  - `EXISTING_P3_P5_PLANS=STALE_FOR_D1_ARCHITECTURE`; `P3_P4_P5_REQUIRE_REPLAN_AFTER_D1_CLOSE=YES`.
- Writer capability env `VAULT_PREVIEW_INDEX_WRITE_ENABLED` (concept `VAULT_PREVIEW_INDEX_WRITE`) defaults false and is server-served and server-enforced. Source inspection facts carried by the plan: blob lifecycle CHECK gains `INDEX_STAGED`/`INDEX_MANAGED` so index blobs are never recoverable `UNREFERENCED` orphans for old clients; `GET /api/vault` excludes index blobs server-side with a bounded envelope route. All shard/root limits remain PROVISIONAL; IDX-SIZE stops at `IDX_SIZE_EVIDENCE=READY`, `LIMITS=AWAITING_HUMAN_APPROVAL`.

## Source files changed

- `docs/superpowers/plans/2026-10-02-idea1-d1-separate-encrypted-preview-index-implementation.md` — implementation plan, Revision 2 (binding conditions, verified source truth, file map, interfaces, 46 tasks with RED/GREEN/commit/acceptance, PR split, Human gates, risks, self-review incl. R1–R10 review checks).
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-status.md` — D-1 plan Current Task, Session Register D1P-S1/D1P-S2 (review revision and approval); D-1 design block marked closed with PR #279 merge SHA.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-10-02_010812_kla_idea1-d1-implementation-plan.md` — this one final task receipt (corrected in place to Revision 2 with Human authorization).

## Verification evidence

- `node --test tests/collaborationPolicy.test.mjs tests/vaultStructure.test.mjs` — PASS (exit 0): 49 pass, 0 fail, 0 skip, 0 cancelled at Revision 1 (`8b2ec6f4`), Revision 2 (`5279be8e`), and after this receipt correction. Windows local linked worktree, Node v24.
- `node scripts/validate-vault.mjs` — PASS (exit 0) at each checkpoint, with two pre-existing owner-data canvas warnings (`AEGIS_Architecture_Canvas.canvas`, `AEGIS_Knowledge_Network.canvas`); neither changed.
- `node scripts/validate-collaboration-policy.mjs --event <PR #280 body as Draft> --changed-files <git diff --name-status origin/main...HEAD>` — PASS locally at each revision; GitHub collaboration-guardrails PASS on `c4a743c6` and `5279be8e`.
- `git diff --check` / `git diff --cached --check` — PASS (exit 0).
- Secret-pattern scan over the branch diff (private keys, GitHub/API tokens, credentialed connection strings, password assignments) — PASS: no credential, key, or connection string; only plan prose about logging/audit rules.
- `git fetch origin` — PASS; `origin/main` equals `fff78feb7f7296a742794a31dffeb35a134a7660`; no reconciliation needed.
- Plan self-review — PASS: 10-point writing-plans checklist plus review-revision checks R1–R10 (storage bounded without GC, Stage 1 only after PR-A + PR-B, READ=true/WRITE=false consistency, superseded refs never deletion authority, budget never affects originals, PG concurrent commits cannot exceed the cap, no writer before HG-G and HG-H, no `VAULT_MANIFEST_V2_UPGRADE` dependency, no main-manifest preview arrays, P3–P5 blocked pending re-plan).
- Not run (documentation-only): IDEA1 full suite, PostgreSQL suites, build, browser. No runtime, PG, or browser result is claimed.
- Negative controls: NOT APPLICABLE to a plan; specified for future tasks (C.7, D.3, H.1).
- Production safety: no Production connection, command, deployment, flag change, migration, or mutation.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-status.md` — plan task/session record (D1P-S1, D1P-S2 with Human approval of Revision 2) and D-1 design task closed (PR #279 merged at `fff78feb`).

## Shared surfaces touched

- `docs/superpowers/plans/2026-10-02-idea1-d1-separate-encrypted-preview-index-implementation.md` — repository-wide plan path outside the IDEA1 primary boundary; it specifies future IDEA1 DB migration, CAS, lifecycle, storage-budget, flag and rollout contracts, so Kla integration review is required. No runtime shared surface changed.

## Integration requests

- Kla/Human Owner: plan Revision 2 is approved (`PLAN_REVIEW=APPROVED`); Human merge of PR #280 remains. Merging does **not** authorize implementation; a separate Human authorization is required before Task A.0. Implementation review focus stays: migration 012 (lifecycle CHECK widening, no down-migration), `GET /api/vault` index-blob exclusion and envelope route, independent index CAS, server-enforced per-owner retained-storage budget (value approved only at HG-G), default-OFF writer, Stage 1 = PR-A + PR-B, advisory-only superseded refs, and Stage 1–4 Human gates. Rollback of this PR is a documentation revert; no runtime or data change exists.

## Known limitations

- The plan is PLANNED only: nothing is implemented, verified, deployed, or accepted. Every numeric limit, including the retained-storage budget, is PROVISIONAL; capacity, latency, storage-growth, budget-check cost and audit-volume numbers are TO_BE_MEASURED.
- With destructive GC forbidden, heavy users are expected to reach the storage budget, after which tiles fall back to originals until a future, separately gated GC task exists.
- Request-pattern/opaque co-occurrence leakage and malicious-server valid-head replay remain Human-accepted D-1 limitations; no zero-leakage or durable anti-rollback claim is made.
- The `superpowers:writing-plans` skill is not installed in this environment; its methodology was followed manually.
- Existing P3–P5 plans are stale for D-1 and must be re-planned (P3, then P4, then P5) after D-1 closes.
