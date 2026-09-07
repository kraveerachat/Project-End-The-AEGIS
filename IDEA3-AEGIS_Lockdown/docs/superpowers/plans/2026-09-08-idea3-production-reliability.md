# IDEA3 Production Reliability and Persistence Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver PR6 with safe structured operational errors, fail-closed production Admin sessions, and a restart-durable bounded Web audit ledger.

**Architecture:** Extend the existing Security Center repository interface with a `node:sqlite` implementation and keep an injectable in-memory implementation for focused tests. Normalize operational failures through one allow-listed/redacted error module, feed them from the live provider into the authenticated snapshot boundary, and record auth and operational outcomes through the repository without adding browser hardware authority.

**Tech Stack:** Node.js 22.13+ ESM, Express 5, express-session, bcryptjs, Zod, built-in `node:sqlite`, Vitest, Supertest, Python 3.10+ regression suite, PlatformIO compile-only verification.

**Spec:** `IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-09-08-idea3-production-reliability-design.md`

## Global Constraints

- Work only on `feat/idea3-production-reliability`, based on `origin/main@c650cf2eda1c963e9f97fab8c7c34c3644022cb3`.
- Selected area is `idea3`; receipt owner is `music`.
- Preserve `WEB_TO_MQTT = NO`, `WEB_TO_ESP32 = NO`, and `WEB_TO_RELAY = NO`.
- Preserve `REQUESTED != COMMAND_SENT != ACK != STATUS != PHYSICAL_CONFIRMATION`.
- Preserve explicit RESTORE authorization separately from command lifecycle.
- Do not change HMAC, nonce, timestamp, firmware, IDEA1, IDEA2, gateway, database-service, network, or deployment behavior.
- Never expose or persist passwords, cookies, session IDs, CSRF tokens, password hashes, HMAC secrets, MQTT credentials, filesystem paths, stack traces, or raw payloads.
- Treat PR7 through PR12 as OPEN/PLANNED documentation only; create no downstream implementation and no PR7 receipt.
- Use TDD: each production behavior is preceded by a focused test that is observed failing for the intended reason.
- Create exactly one new PR6 receipt after fresh final verification.

---

### Task 1: Safe operational error model and provider classification

**Files:**

- Create: `IDEA3-AEGIS_Lockdown/web/server/domain/operationalErrors.js`
- Modify: `IDEA3-AEGIS_Lockdown/web/server/domain/normalize.js`
- Modify: `IDEA3-AEGIS_Lockdown/web/server/providers/liveProvider.js`
- Create: `IDEA3-AEGIS_Lockdown/web/tests/server/operationalErrors.test.js`
- Modify: `IDEA3-AEGIS_Lockdown/web/tests/server/normalize.test.js`

**Interfaces:**

- Produces: `OPERATIONAL_ERROR_CODES`, `createOperationalError(code, fields)`, `redactSensitive(value)`, and `operationalErrorFingerprint(error)`.
- Produces: live snapshots with `operationalErrors: OperationalError[]`.
- Consumes: the existing `normalizeRuntimeStatus()`, canonical status/freshness functions, and live adapter result codes.

- [ ] **Step 1: Write failing taxonomy and redaction tests**

Add focused cases proving allow-listed shape, unknown-code fallback, correlation preservation, and recursive secret/path/stack/payload removal:

```js
const error = createOperationalError('ACK_TIMEOUT', {
  component: 'ack',
  occurredAt: '2026-09-08T01:00:00.000Z',
  correlationId: 'nonce-safe-1',
  detail: { password: 'hidden', nested: { token: 'hidden', count: 2 } },
})
expect(error).toMatchObject({
  code: 'ACK_TIMEOUT', category: 'COMMAND', severity: 'HIGH',
  component: 'ack', recoverable: true, correlationId: 'nonce-safe-1',
})
expect(JSON.stringify(error)).not.toMatch(/hidden|password|token/)
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run:

```bash
cd IDEA3-AEGIS_Lockdown/web
npm test -- tests/server/operationalErrors.test.js
```

Expected: fail because `operationalErrors.js` and its exports do not exist.

- [ ] **Step 3: Implement the minimal error module**

Define immutable metadata for every spec code and return only:

```js
{
  code, category, severity, message, component,
  occurredAt, recoverable, correlationId,
}
```

`createOperationalError()` must ignore arbitrary input messages. `redactSensitive()` must preserve safe scalar metadata while replacing or dropping values whose keys match the spec's sensitive-key set. `operationalErrorFingerprint()` must hash or join only code, component, and correlation id.

- [ ] **Step 4: Add failing provider/normalization cases**

Cover broker disconnected/reconnecting, stale runtime status, malformed runtime JSON/schema, adapter timeout/rejection/unavailability, command timeout, ACK missing, STATUS missing, physical confirmation missing, and physical mismatch. Assert every non-healthy evidence state remains non-healthy and raw secret-like fields never appear.

```js
expect(snapshot.operationalErrors.map(({ code }) => code)).toContain('RUNTIME_EVIDENCE_STALE')
expect(snapshot.runtime.status).toBe('UNKNOWN')
expect(JSON.stringify(snapshot)).not.toMatch(/mqttPassword|rawLog|stack|private\/path/)
```

- [ ] **Step 5: Run the new provider cases and confirm RED**

Run:

```bash
cd IDEA3-AEGIS_Lockdown/web
npm test -- tests/server/operationalErrors.test.js tests/server/normalize.test.js
```

Expected: taxonomy tests pass; provider/error mapping cases fail because snapshots do not yet publish structured operational errors.

- [ ] **Step 6: Implement minimal provider mapping**

Return distinct safe result codes from `fetchJson()` for timeout, unavailable, rejected response, malformed JSON, and malformed runtime schema. Convert accepted runtime issue codes to the PR6 taxonomy, using `commandNonce`/`correlationId` only when allow-listed. Add `operationalErrors` to live snapshots and keep stale/malformed runtime state `UNKNOWN`.

- [ ] **Step 7: Run focused tests and the full Web suite**

Run:

```bash
cd IDEA3-AEGIS_Lockdown/web
npm test -- tests/server/operationalErrors.test.js tests/server/normalize.test.js
npm test
```

Expected: all focused cases and the full baseline pass with no secret-bearing output.

- [ ] **Step 8: Commit Task 1**

```bash
git add IDEA3-AEGIS_Lockdown/web/server/domain/operationalErrors.js IDEA3-AEGIS_Lockdown/web/server/domain/normalize.js IDEA3-AEGIS_Lockdown/web/server/providers/liveProvider.js IDEA3-AEGIS_Lockdown/web/tests/server/operationalErrors.test.js IDEA3-AEGIS_Lockdown/web/tests/server/normalize.test.js
git diff --cached --check
git commit -m "feat(idea3): normalize operational failures"
```

---

### Task 2: Restart-durable SQLite audit repository

**Files:**

- Create: `IDEA3-AEGIS_Lockdown/web/server/repositories/auditRecords.js`
- Create: `IDEA3-AEGIS_Lockdown/web/server/repositories/sqliteRepository.js`
- Modify: `IDEA3-AEGIS_Lockdown/web/server/repositories/memoryRepository.js`
- Create: `IDEA3-AEGIS_Lockdown/web/tests/server/sqliteRepository.test.js`
- Modify: `IDEA3-AEGIS_Lockdown/web/package.json`

**Interfaces:**

- Produces: `AuditPersistenceError`, `sanitizeAuditEntry(entry)`, `createSqliteRepository({ path, clock })`.
- Both repositories expose: `recordAction`, `acknowledgeAlert`, `addIncidentNote`, `updateSettings`, `recordOperationalErrors`, `queryAudit`, `apply`, and `close`.
- Consumes: `OperationalError` and `operationalErrorFingerprint()` from Task 1.

- [ ] **Step 1: Write the failing repository contract and restart tests**

Use `mkdtemp()` and a file beneath the test directory's temporary root. Prove schema version 1, write/read, close/reopen, durable alert/note/settings state, new append after reopen, correlation id, newest-first stable ordering, limit clamping/rejection at the caller-facing method, active-error deduplication, recurrence after recovery, malformed JSON fallback, and absence of sensitive values.

```js
const first = createSqliteRepository({ path: dbPath, clock })
first.recordAction({
  category: 'COMMAND', action: 'ACK_TIMEOUT', outcome: 'FAILED',
  actorRef: 'system', resourceType: 'command', resourceId: 'cut-1',
  correlationId: 'nonce-safe-1', detail: { token: 'hidden', timeoutMs: 8000 },
})
first.close()
const reopened = createSqliteRepository({ path: dbPath, clock })
expect(reopened.queryAudit({ limit: 10 })[0]).toMatchObject({ correlationId: 'nonce-safe-1' })
expect(JSON.stringify(reopened.queryAudit({ limit: 10 }))).not.toContain('hidden')
```

- [ ] **Step 2: Run the repository test and confirm RED**

Run:

```bash
cd IDEA3-AEGIS_Lockdown/web
npm test -- tests/server/sqliteRepository.test.js
```

Expected: fail because the SQLite repository module does not exist.

- [ ] **Step 3: Implement audit sanitization and explicit failure type**

`sanitizeAuditEntry()` must supply server-safe defaults, bound each text field,
allow only the documented fields, redact `detail`, and serialize no undefined or
sensitive values. `AuditPersistenceError` must expose the public code only and
retain the original error as a non-serialized cause.

- [ ] **Step 4: Implement SQLite schema version 1 and repository methods**

Create the parent directory for file databases, open `DatabaseSync`, set
`journal_mode=WAL` for files, enable foreign keys, create `schema_meta`,
`audit_log`, `alert_acknowledgements`, `incident_notes`, `settings`, and
`active_operational_errors`, and reject any schema version other than `1`.
Wrap every transaction/open/query failure in `AuditPersistenceError`.

`queryAudit({ limit })` must require an integer `1..250` and execute:

```sql
SELECT id, occurred_at, category, action, outcome, actor_ref,
       resource_type, resource_id, correlation_id, detail_json
FROM audit_log
ORDER BY occurred_at DESC, id DESC
LIMIT ?
```

- [ ] **Step 5: Bring the memory repository to interface parity**

Use the shared sanitizer and add bounded `queryAudit`, operational-error active
fingerprints, and a no-op `close()`. Keep its current action/state behavior so
existing route tests remain focused and deterministic.

- [ ] **Step 6: Declare the Node runtime floor**

Add to `package.json`:

```json
"engines": { "node": ">=22.13.0" }
```

No package dependency is added for SQLite.

- [ ] **Step 7: Run repository and full Web tests**

Run:

```bash
cd IDEA3-AEGIS_Lockdown/web
npm test -- tests/server/sqliteRepository.test.js
npm test
```

Expected: restart/reopen and failure tests pass; the full Web suite remains green.

- [ ] **Step 8: Commit Task 2**

```bash
git add IDEA3-AEGIS_Lockdown/web/server/repositories/auditRecords.js IDEA3-AEGIS_Lockdown/web/server/repositories/sqliteRepository.js IDEA3-AEGIS_Lockdown/web/server/repositories/memoryRepository.js IDEA3-AEGIS_Lockdown/web/tests/server/sqliteRepository.test.js IDEA3-AEGIS_Lockdown/web/package.json
git diff --cached --check
git commit -m "feat(idea3): persist security center audit"
```

---

### Task 3: Fail-closed production authentication and durable auth audit

**Files:**

- Modify: `IDEA3-AEGIS_Lockdown/web/server/config.js`
- Modify: `IDEA3-AEGIS_Lockdown/web/server/createApp.js`
- Modify: `IDEA3-AEGIS_Lockdown/web/server/routes/authRoutes.js`
- Modify: `IDEA3-AEGIS_Lockdown/web/tests/server/config.test.js`
- Modify: `IDEA3-AEGIS_Lockdown/web/tests/server/auth.test.js`
- Modify: `IDEA3-AEGIS_Lockdown/web/tests/server/security.test.js`

**Interfaces:**

- Produces: `config.auditDbPath`, validated production secret/hash contract, and repository-owned app lifetime.
- Consumes: `createSqliteRepository()` and `AuditPersistenceError` from Task 2.
- Auth router consumes `repository.recordAction()` without receiving client-supplied actor fields.

- [ ] **Step 1: Add failing production config cases**

Cover missing/known-development/repeated-character/insufficient-character-class
session secrets, malformed bcrypt, bcrypt cost below 12, explicit development
login request in production, and accepted strong production values. Assert error
messages name only variable/policy names, never supplied values.

```js
expect(() => loadConfig({
  NODE_ENV: 'production', SESSION_SECRET: 'x'.repeat(32),
  AEGIS_IDEA3_ADMIN_PASSWORD_HASH: '$2b$12$012345678901234567890u1234567890123456789012345678901',
})).toThrow(/SESSION_SECRET/)
```

- [ ] **Step 2: Run config tests and confirm RED**

Run:

```bash
cd IDEA3-AEGIS_Lockdown/web
npm test -- tests/server/config.test.js
```

Expected: new weak-secret/hash cases fail against the current length/presence-only validation.

- [ ] **Step 3: Implement production validation and audit path config**

Keep development login disabled whenever `NODE_ENV=production`. Validate the
session secret and bcrypt format/cost without logging values. Set
`auditDbPath=':memory:'` for tests by default and
`.aegis-runtime/security-center-audit.sqlite3` otherwise, with
`AEGIS_IDEA3_AUDIT_DB_PATH` as the explicit override.

- [ ] **Step 4: Add failing auth audit/session cases**

Inject a recording repository and prove login success, uniform failure,
throttling, and logout produce safe server-owned audit entries. Prove invalid
cookie, non-Admin identity, logged-out session, and a short expired session are
denied. Inject a repository whose `recordAction()` throws
`AuditPersistenceError` and prove login does not establish a session and returns
the generic 503 code without a path, credential, hash, cookie, or stack.

```js
expect(records.at(-1)).toMatchObject({
  category: 'AUTHENTICATION', action: 'LOGIN', outcome: 'FAILED',
  actorRef: 'anonymous', resourceType: 'session', resourceId: 'current',
})
expect(JSON.stringify(records)).not.toMatch(/correct-horse|cookie|csrf|password/)
```

- [ ] **Step 5: Run auth/security tests and confirm RED**

Run:

```bash
cd IDEA3-AEGIS_Lockdown/web
npm test -- tests/server/auth.test.js tests/server/security.test.js
```

Expected: audit and explicit invalid/expired/failure cases fail because auth routes do not yet use the repository and app errors map only to status 500.

- [ ] **Step 6: Wire repository ownership and auth auditing**

Construct SQLite when `createApp()` receives no repository; pass the selected
repository into auth/security routers; keep explicit injection for tests. Record
only outcome/reason codes, never request credentials. On audit failure, call the
error boundary before establishing a successful session. On logout, record the
event before destruction and fail closed if the write fails.

Map `AuditPersistenceError` to:

```js
res.status(503).json({
  error: { code: 'AUDIT_PERSISTENCE_FAILURE', message: 'ระบบบันทึกเหตุการณ์ไม่พร้อมใช้งาน' },
})
```

- [ ] **Step 7: Run focused and full Web tests**

Run:

```bash
cd IDEA3-AEGIS_Lockdown/web
npm test -- tests/server/config.test.js tests/server/auth.test.js tests/server/security.test.js
npm test
```

Expected: production dev login is disabled, Admin/RBAC/CSRF/logout/rate-limit/session tests pass, and no secret-bearing response is present.

- [ ] **Step 8: Commit Task 3**

```bash
git add IDEA3-AEGIS_Lockdown/web/server/config.js IDEA3-AEGIS_Lockdown/web/server/createApp.js IDEA3-AEGIS_Lockdown/web/server/routes/authRoutes.js IDEA3-AEGIS_Lockdown/web/tests/server/config.test.js IDEA3-AEGIS_Lockdown/web/tests/server/auth.test.js IDEA3-AEGIS_Lockdown/web/tests/server/security.test.js
git diff --cached --check
git commit -m "feat(idea3): harden production admin sessions"
```

---

### Task 4: Persist operational failures and expose bounded Admin audit

**Files:**

- Modify: `IDEA3-AEGIS_Lockdown/web/server/routes/securityRoutes.js`
- Modify: `IDEA3-AEGIS_Lockdown/web/tests/server/securityRoutes.test.js`
- Create: `IDEA3-AEGIS_Lockdown/web/tests/server/productionReliability.test.js`

**Interfaces:**

- Consumes: snapshot `operationalErrors`, repository `recordOperationalErrors(errors)`, `queryAudit({ limit })`, and `apply(snapshot, { auditLimit })`.
- Produces: authenticated `GET /api/security/audit?limit=1..250` and safe persistence-failure responses.

- [ ] **Step 1: Write failing authorization/bounds/integration tests**

Prove unauthenticated audit denial, Admin bounded audit query, limit rejection,
auth failure to durable audit, operational failure to durable audit, restart
retention, active-error deduplication, recovery/recurrence, and a mocked CUT
lifecycle whose separate `REQUESTED`, `COMMAND_SENT`, `ACK`, `STATUS`, and
`PHYSICAL_CONFIRMATION` records retain one correlation id. Prove RESTORE
`AUTHORIZATION` precedes its independent command lifecycle.

```js
const denied = await request(app).get('/api/security/audit?limit=10')
expect(denied.status).toBe(401)
const audit = await agent.get('/api/security/audit?limit=10')
expect(audit.body.audit.length).toBeLessThanOrEqual(10)
expect(audit.body.audit.map(({ action }) => action)).toEqual(expect.arrayContaining(['ACK_TIMEOUT']))
```

- [ ] **Step 2: Run the integration tests and confirm RED**

Run:

```bash
cd IDEA3-AEGIS_Lockdown/web
npm test -- tests/server/securityRoutes.test.js tests/server/productionReliability.test.js
```

Expected: fail because the audit route and operational-error persistence wiring do not exist.

- [ ] **Step 3: Implement route wiring**

After a live snapshot is built, call `recordOperationalErrors()` before returning
`repository.apply(snapshot, { auditLimit: query.data.limit })`. Add the bounded
Admin audit GET route before CSRF-only write middleware. Do not add any MQTT,
ESP32, relay, CUT, or RESTORE execution route.

- [ ] **Step 4: Make action routes truthfully fail on persistence errors**

Allow repository errors to reach the centralized safe 503 boundary. Return a
success payload only after the write has completed. Keep current same-origin,
CSRF, Admin, Demo-policy, input validation, and recovery dry-run constraints.

- [ ] **Step 5: Run focused and full Web tests**

Run:

```bash
cd IDEA3-AEGIS_Lockdown/web
npm test -- tests/server/securityRoutes.test.js tests/server/productionReliability.test.js
npm test
npm run build
```

Expected: integration/restart/bounds/authz/failure tests and the complete Web suite/build pass.

- [ ] **Step 6: Commit Task 4**

```bash
git add IDEA3-AEGIS_Lockdown/web/server/routes/securityRoutes.js IDEA3-AEGIS_Lockdown/web/tests/server/securityRoutes.test.js IDEA3-AEGIS_Lockdown/web/tests/server/productionReliability.test.js
git diff --cached --check
git commit -m "feat(idea3): audit operational failures"
```

---

### Task 5: Documentation, canonical reconciliation, receipt, and final evidence

**Files:**

- Modify: `IDEA3-AEGIS_Lockdown/.env.example`
- Modify: `IDEA3-AEGIS_Lockdown/.gitignore`
- Modify: `IDEA3-AEGIS_Lockdown/README.md`
- Modify: `IDEA3-AEGIS_Lockdown/web/README.md`
- Modify: `IDEA3-AEGIS_Lockdown/doc/Content/04_SESSION_HANDOFF.md`
- Modify: `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md`
- Modify only if the roadmap summary needs reconciliation: `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-moc.md`
- Create exactly one: `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/YYYY-MM-DD_HHMMSS_music_idea3-production-reliability.md`

**Interfaces:**

- Consumes: final source behavior and fresh command output from Tasks 1-4.
- Produces: truthful operator config/rollback guidance, canonical PR6 status, downstream OPEN matrix, and one immutable receipt.

- [ ] **Step 1: Document runtime configuration and persistence**

Add `AEGIS_IDEA3_AUDIT_DB_PATH` with a safe local default description, document
the Node 22.13+ requirement, startup/write failure behavior, session-reset versus
audit-survival contract, schema version 1, backup/rollback handling, and bounded
Admin audit access. Ensure `*.sqlite`, `*.sqlite3`, WAL, and SHM runtime files are
ignored while `.env.example` remains tracked.

- [ ] **Step 2: Run fresh component verification**

Run from `IDEA3-AEGIS_Lockdown`:

```bash
PYTHONDONTWRITEBYTECODE=1 .venv/bin/python -m pytest -p no:cacheprovider -q
.venv/bin/ruff check aegis_soc detector.py sim_auto_detector.py tests --no-cache
PYTHONPYCACHEPREFIX=/tmp/aegis-production-reliability-pycache .venv/bin/python -m compileall -q aegis_soc detector.py server_admin.py sim_auto_detector.py tests
pio run -d firmware
```

Run from `IDEA3-AEGIS_Lockdown/web`:

```bash
npm test
npm run build
npm audit --omit=dev
```

- [ ] **Step 3: Run repository verification**

Run from repository root:

```bash
node --test --test-concurrency=1 tests/*.test.mjs
node scripts/validate-vault.mjs --vault Obsidian_AEGIS_Vault/AEGIS_Knowledge
git diff --check origin/main...HEAD
```

Create the current collaboration-policy event/changed-files fixtures using the
repository's existing tests/template, then run
`node scripts/validate-collaboration-policy.mjs` against the exact final path set.

- [ ] **Step 4: Review security and artifact hygiene**

Inspect exact changed paths and scan the delta for private-key markers, GitHub/AWS
tokens, password/session/HMAC/MQTT/Wi-Fi values, `.env`, runtime databases,
`node_modules`, `.venv`, `web/dist`, firmware build output, recordings, logs, and
caches. Record false-positive identifiers/test literals separately from secrets.

```bash
git status --short
git diff --name-status origin/main...HEAD
git diff --stat origin/main...HEAD
git diff --check origin/main...HEAD
```

- [ ] **Step 5: Reconcile canonical IDEA3 status and roadmap**

Record only results proven by Step 2-4. Preserve these exact semantics:

```text
IDEA1_IDEA3_LIVE_EVENT_INTEGRATION = OPEN / PR7
IDEA2_IDEA3_LIVE_EVENT_INTEGRATION = OPEN / PR7
CROSS_IDEA_EVENT_NORMALIZATION = OPEN / PR7
CROSS_IDEA_INCIDENT_CORRELATION = OPEN / PR7
CROSS_IDEA_CONTAINMENT_ACCEPTANCE = OPEN / PR7
1B_RESET_WINDOW = OPEN / PR8
ROUTER_SWITCH_REAL_ETHERNET_E2E = OPEN / PR8
KALI_E2E = OPEN / PR9
WINDOWS_EXE = OPEN / PR10
PRODUCTION_DEPLOYMENT = OPEN / PR11
FINAL_SYSTEM_ACCEPTANCE = OPEN / PR12
IDEA3_PRODUCTION_COMPLETE = NO
```

- [ ] **Step 6: Create exactly one PR6 receipt**

Copy the repository receipt template to a timestamped `music` filename. Record
base SHA, branch, final pre-receipt HEAD, every exact changed source path, every
verification command and observed count/result, limitations, downstream OPEN
matrix, and `Shared surfaces touched: None`. Do not create or edit another task
receipt.

- [ ] **Step 7: Validate the final documented candidate**

Rerun vault/policy/diff checks after the canonical notes and receipt exist. Any
failed or unrun gate must be recorded as a limitation; do not label its area
closed.

- [ ] **Step 8: Commit Task 5**

Stage only the exact reviewed paths, including the single receipt, then run:

```bash
git diff --cached --check
git diff --cached --name-status
git commit -m "docs(idea3): record production reliability evidence"
```

- [ ] **Step 9: Push and open a Draft Pull Request**

Push without force, open a Draft PR against current `main`, preserve the hidden
policy block, use actual GitHub numbering only, and include Project Sequence PR6,
verification, restart evidence, rollback, limitations, exact shared surfaces,
receipt path, and PR7-PR12 OPEN work. Do not merge.
