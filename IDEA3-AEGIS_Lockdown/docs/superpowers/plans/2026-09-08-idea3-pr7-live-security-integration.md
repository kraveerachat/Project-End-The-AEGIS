# IDEA3 PR7 Live Security Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Safely normalize and correlate reviewed IDEA1/IDEA2 event feeds and durably record an Admin containment-acceptance decision without requesting or publishing a physical command.

**Architecture:** Upstream-owned, bearer-authenticated, bounded event feeds remain separate from IDEA3. IDEA3 adapters translate them into one versioned internal contract, apply freshness/dedup/correlation deterministically, and use the existing PR6 SQLite/audit and Admin/CSRF boundaries. The plan stops at `Containment Accepted`; MQTT, ACK, execution, and physical evidence are separate stages.

**Tech Stack:** Node.js 22.13+ ESM, Express 5, Zod, built-in `node:sqlite`, Vitest, Supertest, Python 3.10+ runtime contract tests.

**Spec:** `IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-09-08-idea3-pr7-live-security-integration-design.md`

## Global Constraints

- Current `main` source is implementation truth.
- Do not use human Admin/SOC sessions or direct upstream database access.
- `Requested != Published != ACK != Executed != Physical Evidence`.
- PR7 ends at `Containment Accepted`; it performs no command publication or hardware action.
- Missing, malformed, stale, future, conflicting, timed-out, or unavailable evidence fails closed and cannot create a containment candidate.
- Preserve PR6 audit sanitization, WAL durability, bounded Admin access, and HTTP 503 failure behavior.
- Do not edit IDEA1/IDEA2 source without separate owner-approved dependency PRs and integration review.
- Do not merge or deploy from this implementation plan.

---

### Task 1: Upstream Interface Inventory and Dependency Gate

**Files:**
- Read: `IDEA1-AEGIS_Drive_LC/server/routes/api.js`
- Read: `IDEA1-AEGIS_Drive_LC/server/db/connection.js`
- Read: `IDEA2-AEGIS_Monitor/server/routes/api.js`
- Read: `IDEA2-AEGIS_Monitor/server/db/store.js`
- Read: `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/local_api.py`
- Modify: `IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-09-08-idea3-pr7-live-security-integration-design.md`

**Interfaces:**
- Consumes: Current upstream route and persistence source.
- Produces: A dependency verdict for versioned IDEA1/IDEA2 service feeds.

- [ ] **Step 1: Reconfirm current source contracts**

Run:

```bash
rg -n "apiRouter.get\('/audit'|apiRouter.get\('/alerts'|apiRouter.get\('/detections'" IDEA1-AEGIS_Drive_LC IDEA2-AEGIS_Monitor
rg -n "readAudit|listAlerts|listDetections|camera_assignment" IDEA1-AEGIS_Drive_LC/server IDEA2-AEGIS_Monitor/server
```

Expected: IDEA1 audit requires Admin session; IDEA2 alerts/detections require user session/RBAC; no service read feed is present on the audited baseline.

- [ ] **Step 2: Gate implementation on reviewed dependencies**

Require each upstream feed to return HTTP 200 JSON shaped as:

```json
{"schema_version":1,"generated_at":"2026-09-08T08:00:00.000Z","events":[]}
```

Require a dedicated integration credential, response limit <=256 KiB, stable
event IDs, and no raw secrets/media/biometrics. If either dependency is absent,
record the task as blocked/partial and do not claim live integration.

- [ ] **Step 3: Commit any evidence-only correction**

```bash
git add IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-09-08-idea3-pr7-live-security-integration-design.md
git commit -m "docs(idea3): refresh PR7 upstream contract evidence"
```

### Task 2: Canonical Cross-IDEA Event Contract

**Files:**
- Create: `IDEA3-AEGIS_Lockdown/web/server/domain/integrationEvents.js`
- Create: `IDEA3-AEGIS_Lockdown/web/tests/server/integrationEvents.test.js`

**Interfaces:**
- Consumes: Upstream feed events from Task 1.
- Produces: `normalizeIntegrationEvent(raw, { source, receivedAt, maxAgeMs })` and `deduplicateIntegrationEvents(events)`.

- [ ] **Step 1: Write failing contract tests**

Add tests asserting required fields, bounded optional evidence, derived
`received_at`/`freshness`, `UNKNOWN` severity ineligibility, invalid timestamp
rejection, stable `source:event_id` dedup, and conflicting-ID rejection.

```js
const event = normalizeIntegrationEvent(raw, {
  source: 'IDEA1', receivedAt: new Date('2026-09-08T08:00:00Z'), maxAgeMs: 120000,
})
expect(event.freshness).toBe('FRESH')
expect(event.received_at).toBe('2026-09-08T08:00:00.000Z')
expect(JSON.stringify(event)).not.toMatch(/password|token|embedding|snapshot_path/i)
```

- [ ] **Step 2: Verify the tests fail**

Run:

```bash
cd IDEA3-AEGIS_Lockdown/web
npx vitest run tests/server/integrationEvents.test.js
```

Expected: FAIL because `integrationEvents.js` does not exist.

- [ ] **Step 3: Implement the minimal contract**

Use Zod enums `IDEA1|IDEA2`, `INFO|WARNING|HIGH|CRITICAL|UNKNOWN`, bounded IDs
and text, ISO timestamps with offsets, confidence 0-100, and an explicit safe
evidence-key allowlist. Return a discriminated `{ ok, event, error }` result so
callers cannot confuse rejection with an empty source.

- [ ] **Step 4: Run the focused tests**

```bash
npx vitest run tests/server/integrationEvents.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add IDEA3-AEGIS_Lockdown/web/server/domain/integrationEvents.js IDEA3-AEGIS_Lockdown/web/tests/server/integrationEvents.test.js
git commit -m "feat(idea3): define cross-idea event contract"
```

### Task 3: Read-Only IDEA1 and IDEA2 Adapters

**Files:**
- Create: `IDEA3-AEGIS_Lockdown/web/server/providers/httpJsonClient.js`
- Create: `IDEA3-AEGIS_Lockdown/web/server/providers/idea1Adapter.js`
- Create: `IDEA3-AEGIS_Lockdown/web/server/providers/idea2Adapter.js`
- Modify: `IDEA3-AEGIS_Lockdown/web/server/config.js`
- Modify: `IDEA3-AEGIS_Lockdown/.env.example`
- Test: `IDEA3-AEGIS_Lockdown/web/tests/server/integrationAdapters.test.js`

**Interfaces:**
- Consumes: `AEGIS_IDEA1_STATUS_URL`, `AEGIS_IDEA2_STATUS_URL`, dedicated bearer credentials, and Task 2 normalizer.
- Produces: `fetchIdea1Events()` and `fetchIdea2Events()` returning bounded normalized results plus source lifecycle status.

- [ ] **Step 1: Write failing adapter tests**

Cover GET-only requests, `Accept: application/json`, dedicated Authorization
header without logging its value, redirect rejection, timeout, >256 KiB
rejection, malformed envelope, source mismatch, and biometric/media stripping.

- [ ] **Step 2: Verify failure**

```bash
npx vitest run tests/server/integrationAdapters.test.js
```

Expected: FAIL because the adapter modules do not exist.

- [ ] **Step 3: Implement the shared HTTP boundary and source translators**

Keep credentials separate per source. Do not accept cookies, username/password,
database URLs, redirects, arbitrary headers, or raw response logging. Require
`schema_version=1` and an allowlisted source before normalizing each event.

- [ ] **Step 4: Run focused and configuration tests**

```bash
npx vitest run tests/server/integrationAdapters.test.js tests/server/config.test.js
```

Expected: PASS, including direct assertions for all five original environment keys.

- [ ] **Step 5: Commit**

```bash
git add IDEA3-AEGIS_Lockdown/.env.example IDEA3-AEGIS_Lockdown/web/server/config.js IDEA3-AEGIS_Lockdown/web/server/providers/httpJsonClient.js IDEA3-AEGIS_Lockdown/web/server/providers/idea1Adapter.js IDEA3-AEGIS_Lockdown/web/server/providers/idea2Adapter.js IDEA3-AEGIS_Lockdown/web/tests/server/integrationAdapters.test.js
git commit -m "feat(idea3): add read-only integration adapters"
```

### Task 4: Failure, Freshness, and Runtime Status Semantics

**Files:**
- Modify: `IDEA3-AEGIS_Lockdown/web/server/providers/liveProvider.js`
- Modify: `IDEA3-AEGIS_Lockdown/web/server/domain/status.js`
- Modify: `IDEA3-AEGIS_Lockdown/web/server/domain/operationalErrors.js`
- Modify: `IDEA3-AEGIS_Lockdown/aegis_soc/runtime.py`
- Test: `IDEA3-AEGIS_Lockdown/web/tests/server/liveIntegrationProvider.test.js`
- Test: `IDEA3-AEGIS_Lockdown/tests/test_runtime.py`

**Interfaces:**
- Consumes: Task 3 adapter results and Python `RuntimeStatus`.
- Produces: Honest source states, upstream event freshness, recovery transitions, and one compatible runtime status v1 representation.

- [ ] **Step 1: Write failing failure/freshness tests**

Test stale, future, malformed, partial, timeout, unavailable, recovery, and
out-of-order evidence. Add a test that the audit source says durable SQLite
while the event snapshot store remains runtime-owned.

- [ ] **Step 2: Write the failing Python runtime-contract test**

Assert the safe exported representation has `schemaVersion`, `generatedAt`,
canonical `status`, allowlisted `components`, `modes`, `issues`, and
`evidenceSource`, with no secret/config values.

- [ ] **Step 3: Run both focused suites and observe failure**

```bash
cd IDEA3-AEGIS_Lockdown/web && npx vitest run tests/server/liveIntegrationProvider.test.js
cd ../.. && PYTHONDONTWRITEBYTECODE=1 python -m pytest -p no:cacheprovider IDEA3-AEGIS_Lockdown/tests/test_runtime.py -q
```

Expected: FAIL on missing lifecycle/runtime contract behavior.

- [ ] **Step 4: Implement minimal fail-closed behavior**

Reuse `evaluateFreshness`; never mark an event feed fresh merely because the
HTTP request succeeded. Correct `liveProvider` audit provenance to durable
SQLite without claiming event snapshots persist. Add a safe runtime projection;
do not add command or control routes.

- [ ] **Step 5: Rerun focused suites**

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add IDEA3-AEGIS_Lockdown/web/server/providers/liveProvider.js IDEA3-AEGIS_Lockdown/web/server/domain/status.js IDEA3-AEGIS_Lockdown/web/server/domain/operationalErrors.js IDEA3-AEGIS_Lockdown/aegis_soc/runtime.py IDEA3-AEGIS_Lockdown/web/tests/server/liveIntegrationProvider.test.js IDEA3-AEGIS_Lockdown/tests/test_runtime.py
git commit -m "fix(idea3): enforce integration freshness semantics"
```

### Task 5: Deterministic Cross-IDEA Correlation

**Files:**
- Modify: `IDEA3-AEGIS_Lockdown/web/server/domain/correlate.js`
- Modify: `IDEA3-AEGIS_Lockdown/web/tests/server/correlate.test.js`

**Interfaces:**
- Consumes: Fresh, normalized, deduplicated Task 2 events.
- Produces: Stable `CONTAINMENT_CANDIDATE` incidents or an empty list.

- [ ] **Step 1: Replace fixture-only assumptions with the required matrix**

Add named tests for IDEA1-only, IDEA2-only, matching correlation keys, unrelated
keys, outside-window, duplicate, out-of-order, stale/future, unknown severity,
and conflicting IDs.

- [ ] **Step 2: Run tests to prove current source fails the new contract**

```bash
npx vitest run tests/server/correlate.test.js
```

Expected: FAIL because current code assumes `sourceIp` and does not enforce freshness.

- [ ] **Step 3: Implement deterministic correlation**

Sort by `occurred_at` then `source:event_id`; require a non-null equal
`correlation_key`, one event from each source, both eligible, and delta <= the
configured window. Hash sorted evidence IDs plus the correlation key for the
incident ID. Set state only to `CONTAINMENT_CANDIDATE`.

- [ ] **Step 4: Run focused tests**

Expected: PASS for the full matrix.

- [ ] **Step 5: Commit**

```bash
git add IDEA3-AEGIS_Lockdown/web/server/domain/correlate.js IDEA3-AEGIS_Lockdown/web/tests/server/correlate.test.js
git commit -m "feat(idea3): correlate verified cross-idea evidence"
```

### Task 6: Containment Acceptance Boundary

**Files:**
- Create: `IDEA3-AEGIS_Lockdown/web/server/domain/containment.js`
- Modify: `IDEA3-AEGIS_Lockdown/web/server/routes/securityRoutes.js`
- Modify: `IDEA3-AEGIS_Lockdown/web/server/repositories/memoryRepository.js`
- Modify: `IDEA3-AEGIS_Lockdown/web/server/repositories/sqliteRepository.js`
- Test: `IDEA3-AEGIS_Lockdown/web/tests/server/containmentAcceptance.test.js`
- Test: `IDEA3-AEGIS_Lockdown/web/tests/server/sqliteRepository.test.js`

**Interfaces:**
- Consumes: A current stable containment-candidate incident and authenticated Admin + same-origin + CSRF context.
- Produces: Durable `CONTAINMENT_ACCEPTED|CONTAINMENT_REJECTED` decision with all command/evidence booleans false.

- [ ] **Step 1: Write failing acceptance tests**

Assert unauthenticated 401, cross-origin/CSRF denial, non-candidate rejection,
idempotent same decision, conflict on opposite repeated decision, SQLite reopen
durability, and response fields `command_requested=false`,
`command_published=false`, `acknowledged=false`, `executed=false`, and
`physical_evidence=false`.

- [ ] **Step 2: Verify failure**

```bash
npx vitest run tests/server/containmentAcceptance.test.js tests/server/sqliteRepository.test.js
```

Expected: FAIL because decision APIs/storage do not exist.

- [ ] **Step 3: Implement additive schema v2 and acceptance route**

Migrate schema v1 additively to v2 with `containment_decisions`; keep all v1
audit rows. The route must call only the repository/domain layer and must not
import controller, MQTT, broker, firmware, or command modules.

- [ ] **Step 4: Rerun focused tests**

Expected: PASS including v1-to-v2 reopen migration.

- [ ] **Step 5: Commit**

```bash
git add IDEA3-AEGIS_Lockdown/web/server/domain/containment.js IDEA3-AEGIS_Lockdown/web/server/routes/securityRoutes.js IDEA3-AEGIS_Lockdown/web/server/repositories/memoryRepository.js IDEA3-AEGIS_Lockdown/web/server/repositories/sqliteRepository.js IDEA3-AEGIS_Lockdown/web/tests/server/containmentAcceptance.test.js IDEA3-AEGIS_Lockdown/web/tests/server/sqliteRepository.test.js
git commit -m "feat(idea3): persist containment acceptance decisions"
```

### Task 7: Durable Integration Audit Wiring

**Files:**
- Modify: `IDEA3-AEGIS_Lockdown/web/server/repositories/auditRecords.js`
- Modify: `IDEA3-AEGIS_Lockdown/web/server/repositories/sqliteRepository.js`
- Modify: `IDEA3-AEGIS_Lockdown/web/server/routes/securityRoutes.js`
- Modify: `IDEA3-AEGIS_Lockdown/web/tests/server/productionReliability.test.js`
- Modify: `IDEA3-AEGIS_Lockdown/web/tests/server/sqliteRepository.test.js`

**Interfaces:**
- Consumes: Adapter lifecycle, rejection/conflict, correlation, and acceptance outcomes.
- Produces: Sanitized, coalesced, durable audit rows with recovery/recurrence semantics.

- [ ] **Step 1: Write failing audit lifecycle tests**

Assert one failure per active period, one recovery after success, recurrence
after recovery/restart, one correlation row per stable incident, one decision
row per Admin action, Demo isolation, secret/media/path/stack stripping, and
HTTP 503 on persistence failure.

- [ ] **Step 2: Run focused tests and observe failure**

```bash
npx vitest run tests/server/productionReliability.test.js tests/server/sqliteRepository.test.js
```

Expected: FAIL on recovery and integration lifecycle rows.

- [ ] **Step 3: Implement safe audit records**

Use only `ADAPTER_FAILURE`, `ADAPTER_RECOVERED`, `EVENT_REJECTED`,
`EVENT_ID_CONFLICT`, `INCIDENT_CORRELATED`, `CONTAINMENT_ACCEPTED`, and
`CONTAINMENT_REJECTED`. Store stable IDs/codes/counts only; never store raw
events, credentials, names, media, paths, or payloads.

- [ ] **Step 4: Rerun focused tests**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add IDEA3-AEGIS_Lockdown/web/server/repositories/auditRecords.js IDEA3-AEGIS_Lockdown/web/server/repositories/sqliteRepository.js IDEA3-AEGIS_Lockdown/web/server/routes/securityRoutes.js IDEA3-AEGIS_Lockdown/web/tests/server/productionReliability.test.js IDEA3-AEGIS_Lockdown/web/tests/server/sqliteRepository.test.js
git commit -m "feat(idea3): audit integration lifecycle durably"
```

### Task 8: Full Test Matrix and Regression

**Files:**
- Modify only if a verified regression requires a scoped fix; declare every exact path.
- Test: All IDEA3 Python, Web, repository, and compile-only firmware checks.

**Interfaces:**
- Consumes: Tasks 2-7.
- Produces: Evidence that PR7 changes preserve PR6 and hardware boundaries.

- [ ] **Step 1: Run IDEA3 Python verification**

```bash
cd IDEA3-AEGIS_Lockdown
PYTHONDONTWRITEBYTECODE=1 .venv/bin/python -m pytest -p no:cacheprovider -q
.venv/bin/ruff check aegis_soc detector.py sim_auto_detector.py tests --no-cache
PYTHONPYCACHEPREFIX=/tmp/aegis-pr7-compile-cache .venv/bin/python -m compileall -q aegis_soc detector.py server_admin.py sim_auto_detector.py tests
```

Expected: all tests/checks pass.

- [ ] **Step 2: Run Web verification**

```bash
cd web
npm test
npm run build
npm audit --omit=dev --offline
```

Expected: all tests and build pass; 0 production vulnerabilities.

- [ ] **Step 3: Run repository and compile-only checks**

```bash
cd ../..
node --test --test-concurrency=1 tests/*.test.mjs
git diff --check
```

Expected: repository tests and diff check pass. Firmware may be compiled only
with a non-secret temporary header; do not upload or flash it and do not compare
its secret-dependent hash to historical hardware evidence.

- [ ] **Step 4: Confirm forbidden effects remain absent**

Verify no MQTT connection, command publication, firmware flash, relay action,
network change, production database access, deployment, or physical evidence
claim occurred.

- [ ] **Step 5: Commit any scoped regression-only fixes**

Use an exact-path `git add` and a focused `fix(idea3): ...` message. Do not use
`git add .`.

### Task 9: Evidence and Obsidian Closure

**Files:**
- Modify: `IDEA3-AEGIS_Lockdown/doc/Content/04_SESSION_HANDOFF.md`
- Modify: `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md`
- Create: exactly one timestamped Music-owned receipt under `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/`

**Interfaces:**
- Consumes: Exact Git diff and Task 8 verification output.
- Produces: Current owner-maintained status, persistent handoff, and one immutable receipt.

- [ ] **Step 1: Reconcile durable facts without overclaiming**

Record exact source state, tests, upstream dependency status, and limitations.
Keep PR8-PR12 OPEN and `IDEA3_PRODUCTION_COMPLETE = NO`. Mark PR7 live items
CLOSED only when real reviewed upstream feeds were exercised successfully.

- [ ] **Step 2: Create one receipt from the template**

List every changed path, exact command/result, canonical update, shared surface,
integration request, rollback, and explicit non-claim. Never edit an old receipt.

- [ ] **Step 3: Validate vault and collaboration policy**

```bash
node scripts/validate-vault.mjs --vault Obsidian_AEGIS_Vault/AEGIS_Knowledge
node scripts/validate-collaboration-policy.mjs --event /tmp/aegis-pr7-event.json --changed-files /tmp/aegis-pr7-changed-files.txt
git diff --check
```

Expected: both validators and diff check pass. The known two canvas warnings are
allowed only if neither canvas changed.

- [ ] **Step 4: Commit and push the implementation branch**

```bash
git add IDEA3-AEGIS_Lockdown/doc/Content/04_SESSION_HANDOFF.md IDEA3-AEGIS_Lockdown/docs/superpowers/plans/2026-09-08-idea3-pr7-live-security-integration.md IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-09-08-idea3-pr7-live-security-integration-design.md Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-09-08_153936_music_idea3-pr7-inventory-design.md
git diff --cached --check
git diff --cached --name-status
git commit -m "feat(idea3): integrate live security evidence"
git push -u origin feat/idea3-live-security-integration
```

Expected: push succeeds. Do not merge, deploy, force-push, or claim physical containment.
