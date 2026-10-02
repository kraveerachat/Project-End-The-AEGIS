---
title: Task Receipt — Shared stacked inherited receipt guardrail
date: 2026-10-02T06:12:58+07:00
owner: kla
area: shared
branch: fix/shared-stacked-inherited-receipts
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — Shared stacked inherited receipt guardrail

## What changed

- Added explicit handling for immutable receipts inherited through stacked/dependency Pull Request history.
- Current-task receipts are distinguished from inherited receipts by branch metadata.
- Inherited receipts must be declared under `## Inherited task receipts`; they remain attributed to their original branch and do not satisfy the parent task's final-receipt requirement.
- Ready/non-Draft Pull Requests still require exactly one valid current-task receipt.
- Parent-task shared/cross-scope enforcement and historical receipt immutability remain enforced.
- This governance task did not modify PR #264, IDEA2 runtime source, Production, the Production database, or Machine A.

## Source files changed

- `scripts/validate-collaboration-policy.mjs` — classify current-task versus explicitly declared inherited receipts while preserving fail-closed receipt rules.
- `tests/collaborationPolicy.test.mjs` — add regression fixtures for Draft/Ready stacked receipt behavior, undeclared/fake inherited declarations, current-task receipt limits, cross-scope separation, and immutability.
- `AGENTS.md` — document inherited-receipt handling for stacked Pull Requests.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-10-02_061258_kla_shared-stacked-inherited-receipts.md` — this immutable final task receipt.

## Verification evidence

- `node scripts/validate-collaboration-policy.mjs --event "$GITHUB_EVENT_PATH" --changed-files "$RUNNER_TEMP/aegis-changed-files.txt"` — pass in GitHub Actions run 36939218033 after reconciliation with main.
- GitHub Actions `collaboration-guardrails` — pass; both collaboration policy validation and Obsidian ownership/link validation completed successfully.
- `git diff --name-status 8a41a8548c82c99d5934e89ea8b3428f3dae79f8...f57bd40a38bb8bba7717601b5ae3cbfa74c39957` — reviewed as shared-governance-only delta before this receipt; the incoming main reconciliation was IDEA3-only and did not overlap the three governance files.
- Focused test cases are present in `tests/collaborationPolicy.test.mjs`; no separate local `node --test tests/collaborationPolicy.test.mjs` execution is claimed by this receipt.

## Canonical notes updated

- `AGENTS.md` — repository collaboration workflow now explicitly distinguishes inherited dependency receipts from the current task's final receipt.
- No IDEA1, IDEA2, or IDEA3 canonical status note was changed by this governance task.

## Shared surfaces touched

- `scripts/validate-collaboration-policy.mjs` — repository-wide collaboration policy enforcement.
- `tests/collaborationPolicy.test.mjs` — repository-wide collaboration-policy regression coverage.
- `AGENTS.md` — repository-wide agent collaboration workflow.

## Integration requests

- Human integration review is required because this is a shared governance task.
- Existing PR review records include an APPROVED review from `Kittipat050871`.
- Before merge, the Ready/non-Draft guardrail must rerun successfully with this current-task receipt present.
- After this shared fix merges, PR #264 must sync current main, declare the inherited PR #281 receipt explicitly, update its own evidence/body, and rerun collaboration guardrails.

## Known limitations

- This task changes repository governance only; it does not itself prove PR #264 merge-readiness or Production readiness.
- The dedicated policy test file was extended, but this receipt does not claim an independent local execution of the full `node --test tests/collaborationPolicy.test.mjs` command.
- Production, Production database, Machine A runtime, and Identity Agent service were not mutated.
