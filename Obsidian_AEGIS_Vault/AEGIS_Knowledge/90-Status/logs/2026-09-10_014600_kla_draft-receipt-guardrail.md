---
title: Task Receipt — Draft receipt guardrail
date: 2026-09-10T01:46:00+07:00
owner: kla
area: shared
branch: fix/shared-draft-receipt-guardrail
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — Draft receipt guardrail

## What changed

- Align the collaboration validator with the canonical session workflow: a Draft task Pull Request may temporarily have zero task receipts while the one immutable receipt is deferred to final task closeout.
- Preserve the merge gate: a non-Draft task Pull Request still requires exactly one new receipt.
- Preserve all receipt immutability and cross-scope declaration checks.

## Source files changed

- `scripts/validate-collaboration-policy.mjs` — distinguish Draft receipt deferral from non-Draft merge readiness and skip receipt-only cross-scope assertions only while no receipt exists on a Draft PR.
- `tests/collaborationPolicy.test.mjs` — add regression coverage for Draft deferral, undeclared deferral rejection, and cross-scope Draft behavior.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-09-10_014600_kla_draft-receipt-guardrail.md` — immutable task receipt for this governance correction.

## Verification evidence

- `node --test tests/collaborationPolicy.test.mjs` — pass via GitHub `Collaboration guardrails` run #318; workflow conclusion `success`.
- PR #112 collaboration guardrail — pass; the updated validator accepted the shared governance task with exactly one receipt.
- PR #111 collaboration failure was inspected directly before the fix: its only policy errors were zero new receipts plus receipt-only cross-scope declarations, despite the PR remaining Draft and explicitly deferring its final task receipt.

## Canonical notes updated

- None — the canonical development-session workflow already requires one receipt at final task closeout and explicitly says sessions do not create receipts. This task corrects enforcement to match that existing rule.

## Shared surfaces touched

- `scripts/validate-collaboration-policy.mjs` — repository-wide collaboration enforcement.
- `tests/collaborationPolicy.test.mjs` — repository-wide governance regression suite.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-09-10_014600_kla_draft-receipt-guardrail.md` — shared governance receipt.

## Integration requests

- Kla/human integration review must confirm that Draft PRs may defer the receipt only while Draft, while Ready/non-Draft task PRs still require exactly one receipt before merge.
- After this governance fix merges, PR #111 must merge current `main` and rerun collaboration guardrails; S5.1 itself must still remain Draft with no receipt until PUBLIC-SHARE-7 final task closeout.

## Known limitations

- GitHub CI run #318 verified this correction successfully before final review.
- This task does not modify PR #111, Production, Public Share source, deployment state, G5, or G6.
