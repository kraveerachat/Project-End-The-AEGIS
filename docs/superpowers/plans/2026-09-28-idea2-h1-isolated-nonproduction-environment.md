# IDEA2 H1 Isolated Non-Production Environment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record and statically enforce the smallest isolated, production-safe environment required before Machine A H1 may begin.

**Architecture:** A candidate-only HTTPS ingress, Monitor, and PostgreSQL run as the independent `aegis-h1-lab` Compose project on the existing host only after a read-only collision gate passes. Browser and Agent paths share one canonical HTTPS origin but use distinct gateway prefixes; all database, network, volume, credential, registry, and lifecycle state remains isolated from `aegis-prod`. The Agent now has source/local-tested managed private-CA bundle support; N8 remains blocked until N0-N7 and the live reviewed non-Production trust path pass separately.

**Tech Stack:** Markdown runbook, Node.js built-in test runner, Docker Compose contract, nginx route contract, PostgreSQL 15, Python Requests/Certifi trust model.

**Spec:** `docs/superpowers/specs/2026-09-28-idea2-h1-isolated-nonproduction-environment-design.md`

## Current N1 repository-only follow-up (2026-09-30)

The N0 statements below are historical planning evidence. Later human-run N0
and post-main-equivalence gates passed as recorded in the canonical IDEA2
status. The dedicated persistent N1 artifact is
`deploy/idea2/h1-runtime/compose.yml`; the capacity-probe Compose remains
disposable N0-only infrastructure and is not repurposed. Focused RED tests
must prove the absence of the N1 artifact before source creation, then cover
the fixed lab project, digest/build source, app-role isolation, private
networks/volume, memory ceilings, ordered migration/readiness, and scoped
cleanup. Run the H1, Monitor, governance, Vault, diff, and security gates before
publishing a repository-only checkpoint. N1 live provisioning, PostgreSQL
double-run evidence, gateway exposure, Machine A mutation, Production mutation,
and final receipt remain separate human gates. Keep PR #264 Draft.

## Global Constraints

- Repository-only design, documentation, and static contract-test work.
- Do not provision DNS, TLS, containers, databases, services, tunnels, or credentials.
- Do not mutate Machine A, Production, Production PostgreSQL, or `aegis-prod`.
- Candidate hostnames and ports remain inactive until their numbered human gate passes.
- TLS verification remains enabled; HTTP fallback, `verify=False`, and unmanaged `REQUESTS_CA_BUNDLE` are forbidden.
- H1 remains `BLOCKED_PREREQUISITES` until N0 through N7 pass.
- `N0_CAPACITY_CRITERION=NOT_DEFINED`, `N0_CAPACITY=NOT_PROVEN`, and
  `N0_STATE=BLOCKED_CAPACITY_CHARACTERIZATION` until an exact-candidate
  capacity characterization supplies every required disk, PostgreSQL,
  rollback/evidence, and peak-RAM term. N1 cannot begin before that follow-up
  rule is reviewed, recorded, and satisfied.
- Create no receipt, push, PR, or live infrastructure from this plan.

## Review Focus

- A candidate hostname or port accidentally treated as already provisioned must fail the static contract.
- Any route model that exposes arbitrary `/internal/*` traffic instead of the five approved Agent families must fail closed.
- Any database, volume, network, or Compose-project reuse with Production must be rejected.
- Private-CA trust must not be claimed through Windows trust alone while Python Requests uses Certifi.
- Account alias changes must never alter Machine A physical-camera ownership or stream destination.
- Free disk/RAM observations alone must not be promoted to a capacity PASS when
  the candidate image/layer cost, PostgreSQL growth allowance, rollback/evidence
  reserve, and concurrent peak container memory usage remain undefined.

## N0 capacity characterization follow-up

The repository review found no defensible pre-existing quantitative capacity
rule. A dedicated probe Compose and digest-bound source inputs now exist. The
Human subsequently supplied bounded service, PostgreSQL-growth, host-reserve,
workload, and evidence inputs, but no candidate image or active measurement exists.
The development Compose topology is not equivalent. The current `7.3 GiB` root
free-space and approximately `5.4 GiB` available-RAM observations therefore
remain evidence only, not acceptance.

Before N1, separately authorized characterization must measure
`CANDIDATE_IMAGE_UNIQUE_BYTES`, `CANDIDATE_WRITABLE_LAYER_PEAK_BYTES`,
`POSTGRES_INITIAL_VOLUME_BYTES`, `ROLLBACK_ARTIFACT_BYTES`,
`EVIDENCE_LOG_ALLOWANCE_BYTES`, and `LAB_PEAK_MEMORY_USAGE_BYTES`, and the Human Owner
must approve `POSTGRES_APPROVED_GROWTH_BYTES` plus the host RAM operating
reserve. No Docker prune or cleanup may be assumed. The authoritative spec and
focused contract test define the fail-closed formula and preserve the supplied
port results: the active `172.18.0.1:18077` forward is retained, candidate
`192.168.10.10:18077` and `192.168.10.10:18443` are available, and `18078`
remains forbidden.

The spec now owns the exact owner-run read-only command set for Production
reference identity/image sizes, container memory usage/limits, PostgreSQL volume bytes, Monitor
writable-layer bytes, filesystem bytes/inodes, Docker totals/cache, and host
memory/swap pressure. Production observations are `REFERENCE_ONLY`; they never
substitute for an exact H1 candidate measurement.

Artifact state remains fail-closed while the source boundary is now complete:

- the H1 probe execution-boundary checkpoint is
  `f1e3dbdfc106d296402dee9df0a2353df9323a7e`, with this measurement
  remediation following as one local checkpoint; the Monitor build still uses
  `IDEA2-AEGIS_Monitor/Dockerfile` and context `IDEA2-AEGIS_Monitor`;
- read-only registry metadata resolved reviewed OCI index and Linux/amd64 child
  digests for Node 20 Alpine, PostgreSQL 15 Alpine, and nginx Alpine;
- a dedicated H1-only TLS/exact-route gateway and bounded capacity-probe
  Compose, runner, watchdog, and cleanup source now exist;
- Attempts 1 through 3 pulled/built only disposable probe artifacts, started only
  the isolated probe project, then exact cleanup removed every introduced
  artifact;
  and
- initialized PostgreSQL bytes, candidate writable peak, unique image/build
  bytes, and lab peak container memory usage remain
  `NOT_MEASURED_ACTIVE_PROBE_REQUIRED`.

The implemented H1 gateway is a dedicated nginx-only artifact: TLS material is
runtime-mounted and never built in, `/monitor/internal` is denied
case-insensitively, only the six approved exact `/agent/internal/...` routes
are admitted with `/agent` stripped, all other Agent paths deny, and the probe
publishes no host port or Production network. The existing Production/root
gateway is not reused. Source implementation and static review are complete;
review of this remediation, restaging its exact source, one separately
authorized rerun, and final evidence review remain blockers before capacity can
be characterized.

Owner decisions stay measurement-derived. The spec presents minimum and
conservative formulas for PostgreSQL growth, non-lab RAM reserve, disk safety,
and redacted evidence caps. Minimum represents one bounded acceptance cycle;
conservative preserves a failed cycle plus a clean rerun. Neither is selected,
and neither can be evaluated against current `7.3 GiB` disk / approximately
`5.4 GiB` available RAM until the named measurements exist.

The formula and policy boundary are now explicit: disk is the sum of unique
candidate image bytes, build transients, initialized PostgreSQL, owner-approved
PostgreSQL growth, writable layers, rollback artifacts, evidence/log allowance,
and owner-approved safety reserve; RAM is characterized lab peak container
memory usage plus the
owner-approved host reserve; inode headroom is measured peak new inodes plus an
owner-approved reserve. The agent does not select growth or reserve values.

If the Human Owner separately authorizes active characterization, it uses only
`aegis-h1-capacity-probe` and a dedicated builder, publishes no host ports,
joins no Production network/volume, uses no Production credentials or Machine A
traffic, and stops at the owner-approved disk/RAM/inode boundaries. Exact probe
resources are removed by identity afterward; no prune is permitted. This probe
cannot create `aegis-h1-lab`, cannot satisfy N1, and must finish review/cleanup
before N0 can be reconsidered.

```text
BOUNDED_ACTIVE_CHARACTERIZATION_REQUIRED=YES
CAPACITY_PROBE_PROJECT=aegis-h1-capacity-probe
CAPACITY_INPUT_FREEZE_SOURCE_SHA=9e39fe5786a5ac7428d2e5eb47cb2285a63bc606
H1_PROBE_IMPLEMENTATION_SOURCE_SHA=d725365875f54e82f12a592878e382fa2dfa6978
MONITOR_FINAL_SOURCE_SHA=d725365875f54e82f12a592878e382fa2dfa6978
H1_GATEWAY=IMPLEMENTED_SOURCE_ONLY
CAPACITY_PROBE=IMPLEMENTED_SOURCE_ONLY
CAPACITY_PROBE_DOCKER_EXECUTION=EXPLICIT_DIRECT_OR_SUDO_NONINTERACTIVE
ACTIVE_CAPACITY_PROBE=ATTEMPT_4_FAILED_CLEANED
ATTEMPT_4_SERVICE_EXIT=GATEWAY_MONITOR_EXIT_1
STARTUP_EXIT_ROOT_CAUSE=NOT_PROVEN
STARTUP_LOG_DIAGNOSTICS=IMPLEMENTED_SOURCE_ONLY
OPTIONAL_HEALTH_DIAGNOSTIC=IMPLEMENTED_SOURCE_ONLY
SERVICE_READINESS_DIAGNOSTICS=IMPLEMENTED_SOURCE_ONLY
ACTIVE_CAPACITY_PROBE_READY=HUMAN_RERUN_REVIEW_REQUIRED
N1_STARTED=NO
```

Attempt 1 reached healthy disposable PostgreSQL plus running Monitor/gateway
containers, then the first compound Compose-exec PostgreSQL volume measurement
hit its bounded timeout. Attempt 2 proved that remediation through preflight,
validate-only, image build, and Compose start, but the old running-only service
discovery then lost at least one expected service and replaced the last service
state with a generic 120-second timeout. Exact cleanup completed after both
attempts and Production identity stayed unchanged. Attempt 3 reached the new
state inspection but Docker rejected direct access to the optional
`.State.Health` key on a container without a healthcheck. Exact cleanup again
completed and Production identity stayed unchanged. The current remediation
keeps the timeout and all-state discovery while guarding the optional health
map and persisting only safe state/exit/health evidence. Another active attempt
remains a separate Human action after reviewing this source checkpoint.

Attempt 4 proved that optional-health inspection works: PostgreSQL was running
and healthy, while gateway and Monitor were each retained as exited with code
`1`. Exact cleanup completed and Production identity stayed unchanged, but the
retained evidence omitted application startup stderr/stdout. Source inspection
does not prove a common crash cause across the distinct nginx and Node
entrypoints, so no startup fix is invented. The bounded source-only remediation
captures redacted gateway/Monitor startup tails before stop/cleanup, with a
32-KiB per-service cap and no environment, PostgreSQL-log, or TLS-key-material
collection. Attempt 5 remains a separate Human action after checkpoint review,
restaging, preflight, and validate-only.

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

Specify the implemented-source-only `AEGIS_AGENT_CA_BUNDLE` lifecycle and its
negative coverage without claiming live H1 provisioning or acceptance.

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

---

## Approved continuation: implement H1 gateway and capacity-probe source

The Human Owner subsequently approved repository-only implementation of the
dedicated gateway and bounded capacity-probe harness. The source checkpoint is
`d725365875f54e82f12a592878e382fa2dfa6978`.

Implemented boundaries:

- digest-required Monitor, PostgreSQL, and nginx inputs;
- dedicated H1 TLS gateway with exact six-route Agent allowlist and fail-closed
  wrong-host/internal-route handling;
- isolated `aegis-h1-capacity-probe` Compose resources with no host ports or
  Production network/volume membership;
- explicit positive owner budgets and per-service memory ceilings;
- explicit synthetic request/row/payload workload bounds;
- a clean committed build context bound to commit and tree identity;
- fail-closed actual-growth/inode/RAM/container-memory/PostgreSQL-growth/evidence
  watchdog checks with immediate stop and a final evidence-cap recheck;
- an exact-scope runner and finally-safe cleanup path with no broad prune; and
- static contract coverage, Compose rendering, Python parsing, Monitor
  regression, and production frontend build verification.

This checkpoint did not build or pull an image, start a container, run the
active probe, create `aegis-h1-lab`, start N1, or mutate Machine A or
Production. `N0_CAPACITY` remains `NOT_PROVEN` until the owner selects the
budget fields, separately authorizes the active probe, and reviews its measured
result and cleanup evidence.
