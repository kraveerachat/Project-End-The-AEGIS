# Shared Development Session Workflow Implementation Plan

> **For execution:** Apply this plan on `docs/shared-development-session-workflow` only; stop at a Draft Pull Request.

**Goal:** Make multi-session work durable without changing the repository's one-task/one-branch/one-PR/one-receipt lifecycle.

**Architecture:** Add one owner-only Core governance note, route both agent entry points to it, clarify its relationship with task receipts in existing canonical governance notes, and enforce discoverability through the existing vault validator.

**Scope:** Shared governance documentation, its focused validator/test, one immutable GOV-1 receipt, and no product/runtime/deployment changes.

## Task 1: Enforce workflow discoverability

**Files:**
- Modify: `tests/vaultStructure.test.mjs`
- Modify: `scripts/validate-vault.mjs`

1. Add a failing fixture test for the missing workflow and missing routes.
2. Run `node --test tests/vaultStructure.test.mjs` and observe the expected failure.
3. Add the workflow to required workspace entry points and required links.
4. Re-run the focused test and require zero failures.

## Task 2: Publish the canonical workflow

**Files:**
- Create: `Obsidian_AEGIS_Vault/AEGIS_Knowledge/core/development-session-workflow.md`
- Modify: `AGENTS.md`
- Modify: `Obsidian_AEGIS_Vault/AEGIS_Knowledge/START_HERE.md`
- Modify: `Obsidian_AEGIS_Vault/AEGIS_Knowledge/core/agent-operating-rules.md`
- Modify: `Obsidian_AEGIS_Vault/AEGIS_Knowledge/core/core-moc.md`
- Modify: `Obsidian_AEGIS_Vault/AEGIS_Knowledge/.schema.md`
- Modify: `Obsidian_AEGIS_Vault/AEGIS_Knowledge/index.md`

1. Add the supplied workflow with schema-valid ownership.
2. Preserve one task branch/PR/receipt while defining session states, evidence, checkpoints, handoff, and closeout.
3. Add the narrow publication-only exception and explicit human-only merge rule.
4. Reconcile reading order and remove stale rebase wording.
5. Add navigation links without introducing an orphan.

## Task 3: Verify and close GOV-1

**Files:**
- Create: `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/<timestamp>_kla_shared-development-session-workflow.md`

1. Run focused governance/vault tests and validators.
2. Run the collaboration validator against the real intended PR body and changed-file list.
3. Run the requested negative consistency checks A-H.
4. Record exact results in one immutable receipt.
5. Inspect and stage exact paths, commit, push, and open a Draft PR.
6. Stop without merge or deployment.
