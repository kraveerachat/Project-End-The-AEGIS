---
title: Task Receipt — Collaboration workflow rules
date: 2026-08-13T16:08:33+07:00
owner: kla
area: shared
branch: codex/collaboration-workflow-rules
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — Collaboration workflow rules

## What changed

- Expanded the repository-wide agent runbook into a step-by-step branch, scope,
  verification, Obsidian, push, and Pull Request workflow.
- Defined how IDEA work may cross into deployment or infrastructure paths while
  remaining reviewable and safe for parallel development.
- Strengthened the collaboration validator so every cross-scope path must appear
  in both the Pull Request and its immutable Obsidian receipt.
- Added `deploy/` as a valid branch type and fixed multiline section parsing.

## Source files changed

- `AGENTS.md` — canonical professional collaboration runbook.
- `scripts/validate-collaboration-policy.mjs` — enforce matching PR and receipt declarations.
- `tests/collaborationPolicy.test.mjs` — cover IDEA2 server deployment and missing receipt declarations.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/_template.md` — clarify cross-scope receipt requirements.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/core/agent-operating-rules.md` — synchronize durable workflow rules.

## Verification evidence

- `node --test tests/collaborationPolicy.test.mjs` — pass: 18 tests, 0 failures.
- `node --test tests/*.test.mjs` — pass: 27 tests, 0 failures.
- `git diff --check` — pass: no whitespace errors.
- `node scripts/validate-vault.mjs` — fail: pre-existing untracked `03 - 📹 IDEA2 AEGIS Monitor.md` lacks required `owner` and `edit_policy` metadata; the user-owned file was intentionally left untouched.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/core/agent-operating-rules.md` — added the cross-scope deployment contract, branch publication sequence, and owner reconciliation rule.

## Shared surfaces touched

- `AGENTS.md` — changes the mandatory workflow for all humans and AI agents.
- `scripts/validate-collaboration-policy.mjs` — changes the repository-wide PR policy gate.
- `tests/collaborationPolicy.test.mjs` — changes shared governance tests.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/_template.md` — changes the receipt contract used by every area.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/core/agent-operating-rules.md` — changes canonical shared governance knowledge.

## Integration requests

- Kla should review and merge this shared governance task before IDEA1, IDEA2,
  IDEA3, or infrastructure contributors base new work on the revised workflow.
- All contributors should use the updated PR/receipt path declarations for their
  next cross-scope or server deployment task.

## Known limitations

- This task does not configure GitHub branch protection itself; it defines and
  enforces the repository workflow through the existing Pull Request policy check.
- Music's GitHub username remains unknown, so Kla remains the temporary IDEA3 reviewer.
- Live vault validation remains blocked by the unrelated untracked
  `03 - 📹 IDEA2 AEGIS Monitor.md` file and warns about three untracked untitled
  Canvas files; none are included in this task.
