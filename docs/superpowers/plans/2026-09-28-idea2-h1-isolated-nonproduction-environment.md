# IDEA2 H1 Isolated Non-Production Environment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record and statically enforce the smallest isolated, production-safe environment required before Machine A H1 may begin.

**Architecture:** A candidate-only HTTPS ingress, Monitor, and PostgreSQL run as the independent `aegis-h1-lab` Compose project on the existing host only after a read-only collision gate passes. Browser and Agent paths share one canonical HTTPS origin but use distinct gateway prefixes; all database, network, volume, credential, registry, and lifecycle state remains isolated from `aegis-prod`. The current Agent lacks managed private-CA bundle support, so N8 remains blocked until a separate bounded `AEGIS_AGENT_CA_BUNDLE` implementation is tested and accepted.

**Tech Stack:** Markdown runbook, Node.js built-in test runner, Docker Compose contract, nginx route contract, PostgreSQL 15, Python Requests/Certifi trust model.

**Spec:** `docs/superpowers/specs/2026-09-28-idea2-h1-isolated-nonproduction-environment-design.md`

## Global Constraints

- Repository-only design, documentation, and static contract-test work.
- Do not provision DNS, TLS, containers, databases, services, tunnels, or credentials.
- Do not mutate Machine A, Production, Production PostgreSQL, or `aegis-prod`.
- Candidate hostnames and ports remain inactive until their numbered human gate passes.
- TLS verification remains enabled; HTTP fallback, `verify=False`, and unmanaged `REQUESTS_CA_BUNDLE` are forbidden.
- H1 remains `BLOCKED_PREREQUISITES` until N0 through N7 pass.
- Create no receipt, push, PR, or live infrastructure from this plan.

## Review Focus

- A candidate hostname or port accidentally treated as already provisioned must fail the static contract.
- Any route model that exposes arbitrary `/internal/*` traffic instead of the five approved Agent families must fail closed.
- Any database, volume, network, or Compose-project reuse with Production must be rejected.
- Private-CA trust must not be claimed through Windows trust alone while Python Requests uses Certifi.
- Account alias changes must never alter Machine A physical-camera ownership or stream destination.

---

### Task 1: Add the H1 isolation contract test

**Files:**
- Create: `IDEA2-AEGIS_Monitor/tests/h1NonProductionEnvironmentContract.test.mjs`
- Test: `IDEA2-AEGIS_Monitor/tests/h1NonProductionEnvironmentContract.test.mjs`

**Interfaces:**
- Consumes: approved H1 isolation decisions in this plan.
- Produces: static assertions over the design/runbook, parent Machine A plan, and canonical IDEA2 status.

- [ ] **Step 1: Write the failing contract test**

Assert the exact project/host/port candidates, N0-N8 phase headings, five Agent route families, Production isolation, CA-bundle prerequisite, physical-camera/alias boundary, plan link, and canonical H0/H1 status.

- [ ] **Step 2: Run the test and capture RED**

Run: `node --test tests/h1NonProductionEnvironmentContract.test.mjs`

Expected: FAIL because the design/runbook and status reconciliation do not yet exist.

---

### Task 2: Write the authoritative design and N0-N8 runbook

**Files:**
- Create: `docs/superpowers/specs/2026-09-28-idea2-h1-isolated-nonproduction-environment-design.md`

**Interfaces:**
- Consumes: Task 1 assertions and the approved architecture.
- Produces: one authoritative design/runbook with prerequisites, mutation scope, expected result, abort conditions, rollback, and evidence for every N0-N8 phase.

- [ ] **Step 1: Define the isolated topology and handoff values**

Document the `aegis-h1-lab` project, candidate HTTPS and stream names, conditional ports, separate database/volume/network, browser and Agent route split, audience, registry policy, stream authority, and cleanup boundaries.

- [ ] **Step 2: Define the CA-bundle prerequisite**

Specify the later `AEGIS_AGENT_CA_BUNDLE` lifecycle and negative coverage without claiming that current Agent source implements it.

- [ ] **Step 3: Write N0-N8**

Each phase must contain prerequisite, exact mutation scope, expected result, abort conditions, rollback, and evidence. N8 may authorize H1 only after N0-N7 pass.

- [ ] **Step 4: Run the focused contract test**

Run: `node --test tests/h1NonProductionEnvironmentContract.test.mjs`

Expected: remaining failures are limited to the parent-plan/status links owned by Task 3.

---

### Task 3: Reconcile the parent plan and canonical IDEA2 status

**Files:**
- Modify: `docs/superpowers/plans/2026-09-19-idea2-machine-a-no-powershell-runtime.md`
- Modify: `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea2/idea2-status.md`

**Interfaces:**
- Consumes: Task 2 design/runbook.
- Produces: explicit Task 15 prerequisite link and truthful `H0=HUMAN_PROVEN_COMPLETE`, `H1=BLOCKED_PREREQUISITES` state.

- [ ] **Step 1: Add the H1 environment prerequisite to Task 15**

Link the new design/runbook and prohibit H1 until N0-N7 pass plus the managed CA-bundle prerequisite is implemented and verified.

- [ ] **Step 2: Replace the stale current-state claim**

Record the human-proven H0 completion without claiming H1, provisioning, Production, or Machine A runtime mutation.

- [ ] **Step 3: Run the focused contract test GREEN**

Run: `node --test tests/h1NonProductionEnvironmentContract.test.mjs`

Expected: all tests pass.

---

### Task 4: Verify, review, and create one local checkpoint

**Files:**
- Verify: all five changed paths from Tasks 1-3, including this implementation plan.

**Interfaces:**
- Consumes: Tasks 1-3.
- Produces: one local documentation/test checkpoint; no push, PR, receipt, live provisioning, or machine mutation.

- [ ] **Step 1: Run focused and governance validation**

Run the focused contract test, collaboration/governance tests, Vault validator, `git diff --check`, changed-path inspection, secret/private-key scan, and scoped security/lifecycle review.

- [ ] **Step 2: Inspect exact staged paths**

Stage only the design/runbook, implementation plan, contract test, parent plan, and canonical IDEA2 status. Run cached diff checks and confirm no receipt exists.

- [ ] **Step 3: Commit locally**

Commit message: `docs(idea2): design isolated h1 environment`

- [ ] **Step 4: Verify the checkpoint**

Confirm parent SHA, exact committed files, clean index/worktree, no push/PR, and no Production or Machine A mutation.
