---
title: Task Receipt — GitHub collaboration guardrails
date: 2026-08-13T17:00:00+07:00
owner: kla
area: shared
branch: codex/github-collaboration-guardrails
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — GitHub collaboration guardrails

## What changed

- Established one-task/one-branch/one-Pull-Request collaboration rules for humans and AI agents.
- Added machine validation for ownership, task receipts, verification evidence, and declared cross-scope changes.
- Replaced the multi-writer task-log pattern with one immutable receipt per completed task.

## Source files changed

- `scripts/validate-collaboration-policy.mjs` — validates Pull Request metadata and changed-file scope.
- `tests/collaborationPolicy.test.mjs` — covers allowed and rejected collaboration flows.
- `.github/PULL_REQUEST_TEMPLATE.md` — collects policy metadata and review evidence.
- `.github/CODEOWNERS` — routes review by IDEA and shared ownership.
- `.github/workflows/collaboration-guardrails.yml` — runs the validator on Pull Requests.
- `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.github/copilot-instructions.md` — align AI agents on one workflow.
- `CONTRIBUTING.md` — gives the team copy-paste branch and Pull Request commands.

## Verification evidence

- `node --test tests/collaborationPolicy.test.mjs` — pass: collaboration policy and repository contract tests.
- `node --test tests/dockerBootstrap.test.mjs` — pass: existing Docker bootstrap baseline remains healthy.
- `git diff --check` — pass: no whitespace errors.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/06 - 🤖 Agent Operating Rules.md` — records branch ownership and receipt routing.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/.schema.md` — defines the immutable receipt contract.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/log.md` — freezes new writes to the legacy shared task log.

## Shared surfaces touched

- Repository governance, AI instructions, GitHub automation, and the Obsidian operating contract — integration-owner review is required before merge.

## Integration requests

- Grant `pubpup2006p-design` Write access and enable `main` branch protection/rules before merging this Pull Request.

## Known limitations

- GitHub collaborator access and branch rules are web settings and are not changed by repository files.
- IDEA3 implementation is not established; its GitHub review route stays temporarily with Kla while receipts use owner `music`.
- Backend, identity, server deployment, and network setup remain evolving; this task does not mark them complete.
