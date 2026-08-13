# GitHub Collaboration Guardrails Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce a Branch → Test → Obsidian receipt → Pull Request workflow for concurrent AEGIS team development.

**Architecture:** A dependency-free Node validator reads Pull Request metadata and Git changed-file status, while repository templates and AI/human instructions produce the required inputs. The initial change adds only the minimal Obsidian receipt directory; broad vault folder migration remains separate.

**Tech Stack:** GitHub Actions, GitHub CODEOWNERS, Node.js 24 built-in test runner, Markdown, Git.

**Spec:** `docs/superpowers/specs/2026-08-13-github-collaboration-guardrails-design.md`

## Global Constraints

- `main` remains the integration source of truth.
- One task uses one branch and one Pull Request.
- Every task creates exactly one new receipt at `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/YYYY-MM-DD_HHMMSS_<owner>_<topic>.md`.
- Do not append new task entries to legacy `log.md` after the guardrail lands.
- Shared changes are allowed only when declared for integration review.
- Do not move the existing Obsidian category folders in this change.
- Do not claim IDEA3 implementation, server deployment, or network setup is complete.

---

### Task 1: Collaboration policy validator

**Files:**
- Create: `tests/collaborationPolicy.test.mjs`
- Create: `scripts/validate-collaboration-policy.mjs`

**Interfaces:**
- Consumes: `--event <json-path>` and `--changed-files <name-status-path>`.
- Produces: exit code `0` with a policy summary, or exit code `1` with one line per policy violation.

- [ ] Write spawn-based tests for valid IDEA1/IDEA2 changes, missing receipt, owner mismatch, undeclared cross-scope change, and declared shared change.
- [ ] Run `node --test tests/collaborationPolicy.test.mjs` and verify RED because the validator script is absent.
- [ ] Implement argument parsing, policy-block parsing, changed-file parsing, area ownership, receipt validation, verification-section validation, and cross-scope detection.
- [ ] Run `node --test tests/collaborationPolicy.test.mjs` and verify all policy cases pass.
- [ ] Refactor names/output while keeping the policy tests green.

### Task 2: GitHub review and CI surfaces

**Files:**
- Create: `.github/PULL_REQUEST_TEMPLATE.md`
- Create: `.github/CODEOWNERS`
- Create: `.github/workflows/collaboration-guardrails.yml`

**Interfaces:**
- Consumes: validator CLI from Task 1.
- Produces: Pull Request metadata, automatic reviewers, and required `collaboration-guardrails` check.

- [ ] Add a static policy test asserting that all three files exist and contain the machine-readable fields/action invocation.
- [ ] Run the policy test and verify RED because the GitHub files are absent.
- [ ] Add the PR template with `area`, `owner`, and `integration-review`; add human sections for source changes, tests, receipt, canonical notes, shared surfaces, and limitations.
- [ ] Add CODEOWNERS routing Kla to governance/core/IDEA1/Infrastructure/IDEA3 and Kla plus Pub to IDEA2 review.
- [ ] Add a least-privilege workflow using `contents: read`, full checkout history, name-status diff generation, and the validator.
- [ ] Run the policy tests and verify GREEN.

### Task 3: Human and AI operating rules

**Files:**
- Modify: `AGENTS.md`
- Modify: `CLAUDE.md`
- Create: `GEMINI.md`
- Create: `.github/copilot-instructions.md`
- Create: `CONTRIBUTING.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: task lifecycle and ownership model from the design spec.
- Produces: one canonical workflow for humans, Codex, Claude, Gemini, and Copilot.

- [ ] Add static tests for required reading order, branch/PR lifecycle, mandatory receipt, ownership routing, maturity wording, and shared-change declaration.
- [ ] Run tests and verify RED against the old instructions.
- [ ] Rewrite `AGENTS.md` to replace broad “update every related file” and shared `log.md` appends with measurable scope and receipt rules.
- [ ] Point Claude, Gemini, and Copilot instructions to `AGENTS.md` and repeat the non-negotiable safety boundaries.
- [ ] Add copy-paste Git commands and reviewer checklist to `CONTRIBUTING.md`.
- [ ] Replace the README's conflicting shared-log instruction with the receipt workflow.
- [ ] Run tests and verify GREEN.

### Task 4: Minimal Obsidian receipt contract

**Files:**
- Create: `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/_template.md`
- Create: `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-08-13_170000_kla_github-guardrails.md`
- Modify: `Obsidian_AEGIS_Vault/AEGIS_Knowledge/log.md`
- Modify: `Obsidian_AEGIS_Vault/AEGIS_Knowledge/06 - 🤖 Agent Operating Rules.md`
- Modify: `Obsidian_AEGIS_Vault/AEGIS_Knowledge/.schema.md`

**Interfaces:**
- Consumes: receipt fields enforced by Task 1.
- Produces: the first immutable task receipt and a legacy-log freeze marker.

- [ ] Add static tests for lowercase timestamped receipt naming, required frontmatter/sections, and the legacy-log freeze marker.
- [ ] Run tests and verify RED because the receipt contract is absent.
- [ ] Add `_template.md` with owner, area, branch, status, verification, shared surfaces, integration requests, and limitations.
- [ ] Add this task's Kla-owned receipt with exact baseline/policy verification evidence.
- [ ] Add a freeze notice to `log.md` without rewriting historical entries.
- [ ] Replace the contradictory shared-log instructions in the vault operating rules and schema.
- [ ] Run tests and verify GREEN.

### Task 5: Full verification and publication handoff

**Files:**
- Verify all files from Tasks 1–4.

**Interfaces:**
- Consumes: complete guardrail implementation.
- Produces: one reviewed commit, a published branch, and a draft Pull Request.

- [ ] Run `node --test tests/collaborationPolicy.test.mjs tests/dockerBootstrap.test.mjs`.
- [ ] Run the validator against a synthetic valid Pull Request and confirm exit code `0`.
- [ ] Run `git diff --check` and inspect `git diff --name-status origin/main...HEAD`.
- [ ] Commit only guardrail, instruction, receipt, test, and plan/spec files.
- [ ] Push `codex/github-collaboration-guardrails`.
- [ ] Open a draft Pull Request into `main` with the completed template.
- [ ] Keep the Pull Request unmerged until GitHub web settings and collaborator access are configured.
