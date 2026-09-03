# AEGIS IDEA3 Security Center 11-Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a secure, responsive, Thai-first IDEA3 Security Center with an authenticated shell, eleven evidence-led pages, safe Demo/Live separation, and no browser or server path capable of issuing live hardware commands.

**Architecture:** A React/Vite client consumes one same-origin Express API. The API owns authentication, Admin authorization, CSRF, bounded query validation, evidence normalization, correlation, audit actions, and the Demo/Live provider boundary; React only renders server-approved view models. All source and tests live in `IDEA3-AEGIS_Lockdown/web/`, while the IDEA3 status note and one immutable receipt record the verified outcome.

**Tech Stack:** Node.js 22+, React 19, Vite 7, Express 4, Zod, Helmet, express-session, bcryptjs, Lucide React, Vitest, Testing Library, Supertest, CSS custom properties.

**Spec:** `IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-09-03-idea3-security-center-11-page-design.md`

## Global Constraints

- All production source remains under `IDEA3-AEGIS_Lockdown/`; IDEA1 and IDEA2 are read-only upstream concepts and receive no source edits.
- Canonical status values are exactly `HEALTHY`, `DEGRADED`, `FAILED`, `UNKNOWN`, `NOT_CONFIGURED`, and `DISABLED`.
- Live evidence is server-only; the browser never connects to MQTT, ESP32, GPIO, relay, producer databases, or producer files.
- No route may execute `CUT_UPLINK`, `RESTORE_UPLINK`, MQTT publish, GPIO write, firmware flash, or relay actuation.
- Demo state is session-scoped, starts disabled, is clearly labelled on every page, never merges with Live data, and is denied when `NODE_ENV=production`.
- All API routes require an authenticated Admin; every state-changing route also requires an origin check and CSRF token.
- Missing, stale, malformed, oversized, or future-dated evidence resolves to `UNKNOWN`; the client never invents healthy telemetry.
- Typography uses Inter Variable, IBM Plex Sans Thai, and JetBrains Mono; both themes use the exact tokens in the design specification.
- Every behavior change follows RED → verify RED → GREEN → verify GREEN → refactor.
- No secret, `.env`, credential, recording, database dump, dependency tree, build output, generated screenshot, or local AI setting is committed.

---

## File map

### Runtime and configuration

- `web/package.json`: scripts and pinned dependency ranges.
- `web/vite.config.js`: `/security/` base path and same-origin API proxy.
- `web/index.html`: semantic app mount and theme bootstrap.
- `web/server/index.js`: startup only; no domain behavior.
- `web/server/createApp.js`: Express composition and middleware ordering.
- `web/server/config.js`: validated environment configuration and production fail-closed rules.
- `web/server/security/auth.js`: credential verification and session regeneration.
- `web/server/security/csrf.js`: same-origin and token enforcement.
- `web/server/security/rateLimit.js`: bounded in-memory login/write limiter.
- `web/server/domain/status.js`: canonical status and freshness rules.
- `web/server/domain/normalize.js`: allowlisted upstream normalization.
- `web/server/domain/correlate.js`: deterministic alert/incident derivation.
- `web/server/providers/liveProvider.js`: safe read-only adapter boundary.
- `web/server/providers/demoProvider.js`: immutable deterministic fixtures.
- `web/server/repositories/memoryRepository.js`: injected operational/audit repository.
- `web/server/routes/authRoutes.js`: login/logout/session/CSRF routes.
- `web/server/routes/securityRoutes.js`: page snapshots, filters, acknowledge, notes, dry-run, settings.

### Client

- `web/src/main.jsx`, `web/src/App.jsx`: mount, session gate, route state.
- `web/src/styles/tokens.css`, `web/src/styles/app.css`: design tokens, themes, responsive shell, component styling.
- `web/src/lib/api.js`: same-origin fetch wrapper and safe error mapping.
- `web/src/lib/routes.js`: eleven route definitions and grouped navigation.
- `web/src/lib/format.js`: Thai-safe dates, evidence age, IP and count formatting.
- `web/src/components/AppShell.jsx`: sidebar, top bar, breadcrumbs, mobile drawer.
- `web/src/components/StatusBadge.jsx`: canonical status rendering with text and icon.
- `web/src/components/EvidenceState.jsx`: loading, empty, stale, error, and partial-failure surfaces.
- `web/src/components/DataTable.jsx`: accessible responsive ledger.
- `web/src/components/MetricCard.jsx`, `Panel.jsx`, `Timeline.jsx`, `DemoBanner.jsx`: shared visual primitives.
- `web/src/pages/LoginPage.jsx`: credential form and uniform failure state.
- `web/src/pages/DashboardPage.jsx`: overall state, KPIs, source ledger, recent evidence.
- `web/src/pages/OverviewPage.jsx`: architecture, integration matrix, provenance, readiness.
- `web/src/pages/Idea1SecurityPage.jsx`: normalized denied/blocked evidence.
- `web/src/pages/Idea2DetectionPage.jsx`: sanitized detection evidence.
- `web/src/pages/LockdownPage.jsx`: runtime chain and disabled command area.
- `web/src/pages/AlertsPage.jsx`: bounded triage and audited acknowledge action.
- `web/src/pages/IncidentsPage.jsx`: correlated incidents, evidence stages, audited note.
- `web/src/pages/AuditPage.jsx`: security audit ledger and audited export request.
- `web/src/pages/DevicesPage.jsx`: evidenced device inventory and topology relationships.
- `web/src/pages/RecoveryPage.jsx`: readiness and no-side-effect dry-run.
- `web/src/pages/SettingsPage.jsx`: safe configuration summaries and session Demo toggle.

### Tests and documentation

- `web/tests/server/*.test.js`: status, normalization, correlation, configuration, auth, CSRF, API, Demo/Live tests.
- `web/tests/client/*.test.jsx`: shell, routing, pages, interaction, accessibility-state tests.
- `web/tests/fixtures/evidence.js`: complete hand-checked safe fixtures.
- `web/README.md`: setup, environment contract, commands, security limitations, routes.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md`: owner-maintained durable implementation fact.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-09-03_HHMMSS_music_idea3-security-center.md`: immutable task receipt created with the real completion timestamp.

---

### Task 1: Establish the tested project shell and canonical evidence contract

**Files:**
- Create: `IDEA3-AEGIS_Lockdown/web/package.json`
- Create: `IDEA3-AEGIS_Lockdown/web/vite.config.js`
- Create: `IDEA3-AEGIS_Lockdown/web/index.html`
- Create: `IDEA3-AEGIS_Lockdown/web/server/domain/status.js`
- Create: `IDEA3-AEGIS_Lockdown/web/server/config.js`
- Create: `IDEA3-AEGIS_Lockdown/web/tests/server/status.test.js`
- Create: `IDEA3-AEGIS_Lockdown/web/tests/server/config.test.js`

**Interfaces:**
- Produces: `canonicalStatusSchema`, `evaluateFreshness({ generatedAt, now, maxAgeMs })`, `deriveOverallStatus(statuses)`, and `loadConfig(env)`.
- Consumes: no earlier task output.

- [ ] **Step 1: Add the package manifest and test configuration**

```json
{
  "name": "aegis-idea3-security-center",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite --port 5176",
    "dev:server": "node --watch server/index.js",
    "start": "node server/index.js",
    "build": "vite build",
    "test": "vitest run",
    "test:watch": "vitest"
  }
}
```

- [ ] **Step 2: Write failing status and configuration tests**

```js
it('returns UNKNOWN when evidence is stale', () => {
  expect(evaluateFreshness({ generatedAt: '2026-09-03T00:00:00.000Z', now: new Date('2026-09-03T00:02:01.000Z'), maxAgeMs: 120000 })).toEqual({ freshness: 'STALE', status: 'UNKNOWN', ageMs: 121000 })
})

it('fails closed in production without an admin password hash', () => {
  expect(() => loadConfig({ NODE_ENV: 'production', SESSION_SECRET: 'x'.repeat(32) })).toThrow(/ADMIN_PASSWORD_HASH/)
})
```

- [ ] **Step 3: Run the focused tests and verify RED**

Run: `npm test -- tests/server/status.test.js tests/server/config.test.js`
Expected: FAIL because `status.js` and `config.js` do not exist.

- [ ] **Step 4: Implement minimal canonical status, freshness, and environment validation**

```js
export const CANONICAL_STATUSES = ['HEALTHY', 'DEGRADED', 'FAILED', 'UNKNOWN', 'NOT_CONFIGURED', 'DISABLED']

export function evaluateFreshness({ generatedAt, now = new Date(), maxAgeMs }) {
  const timestamp = Date.parse(generatedAt)
  if (!Number.isFinite(timestamp)) return { freshness: 'MALFORMED', status: 'UNKNOWN', ageMs: null }
  const ageMs = now.getTime() - timestamp
  if (ageMs < -5000) return { freshness: 'FUTURE', status: 'UNKNOWN', ageMs }
  if (ageMs > maxAgeMs) return { freshness: 'STALE', status: 'UNKNOWN', ageMs }
  return { freshness: 'FRESH', ageMs }
}
```

- [ ] **Step 5: Run tests and verify GREEN**

Run: `npm test -- tests/server/status.test.js tests/server/config.test.js`
Expected: both files PASS with no warnings.

- [ ] **Step 6: Commit the contract foundation**

```bash
git add IDEA3-AEGIS_Lockdown/web/package.json IDEA3-AEGIS_Lockdown/web/vite.config.js IDEA3-AEGIS_Lockdown/web/index.html IDEA3-AEGIS_Lockdown/web/server/domain/status.js IDEA3-AEGIS_Lockdown/web/server/config.js IDEA3-AEGIS_Lockdown/web/tests/server/status.test.js IDEA3-AEGIS_Lockdown/web/tests/server/config.test.js
git commit -m "feat(idea3): establish security center evidence contract"
```

### Task 2: Enforce authentication, Admin RBAC, CSRF, and fail-closed API behavior

**Files:**
- Create: `IDEA3-AEGIS_Lockdown/web/server/security/auth.js`
- Create: `IDEA3-AEGIS_Lockdown/web/server/security/csrf.js`
- Create: `IDEA3-AEGIS_Lockdown/web/server/security/rateLimit.js`
- Create: `IDEA3-AEGIS_Lockdown/web/server/routes/authRoutes.js`
- Create: `IDEA3-AEGIS_Lockdown/web/server/createApp.js`
- Create: `IDEA3-AEGIS_Lockdown/web/server/index.js`
- Create: `IDEA3-AEGIS_Lockdown/web/tests/server/auth.test.js`
- Create: `IDEA3-AEGIS_Lockdown/web/tests/server/security.test.js`

**Interfaces:**
- Consumes: `loadConfig(env)` from Task 1.
- Produces: `createApp({ config, provider, repository, clock })`, `requireAdmin`, `requireCsrf`, `createRateLimiter`, and `/api/auth/{session,csrf,login,logout}`.

- [ ] **Step 1: Write failing tests for uniform login errors and Admin-only API access**

```js
it('returns the same 401 response for unknown user and wrong password', async () => {
  const unknown = await request(app).post('/api/auth/login').send({ username: 'nobody', password: 'wrong' })
  const wrong = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'wrong' })
  expect(unknown.body).toEqual({ error: { code: 'AUTH_FAILED', message: 'เข้าสู่ระบบไม่สำเร็จ' } })
  expect(wrong.body).toEqual(unknown.body)
})

it('rejects an authenticated write without a valid CSRF token', async () => {
  const response = await authenticatedAgent.post('/api/security/demo-mode').send({ enabled: true })
  expect(response.status).toBe(403)
  expect(response.body.error.code).toBe('CSRF_INVALID')
})
```

- [ ] **Step 2: Run auth/security tests and verify RED**

Run: `npm test -- tests/server/auth.test.js tests/server/security.test.js`
Expected: FAIL because the application and security middleware are absent.

- [ ] **Step 3: Implement session regeneration, Admin middleware, CSRF, origin validation, headers, and rate bounds**

```js
export function requireAdmin(req, res, next) {
  if (!req.session?.identity || req.session.identity.role !== 'ADMIN') {
    return res.status(401).json({ error: { code: 'AUTH_REQUIRED', message: 'กรุณาเข้าสู่ระบบ' } })
  }
  next()
}

export function requireCsrf(req, res, next) {
  const token = req.get('x-csrf-token')
  if (!token || token !== req.session?.csrfToken) {
    return res.status(403).json({ error: { code: 'CSRF_INVALID', message: 'คำขอหมดอายุ กรุณาลองใหม่' } })
  }
  next()
}
```

- [ ] **Step 4: Run auth/security tests and verify GREEN**

Run: `npm test -- tests/server/auth.test.js tests/server/security.test.js`
Expected: login/session/CSRF/RBAC/origin/rate-bound tests PASS.

- [ ] **Step 5: Commit the secure API gate**

```bash
git add IDEA3-AEGIS_Lockdown/web/server IDEA3-AEGIS_Lockdown/web/tests/server/auth.test.js IDEA3-AEGIS_Lockdown/web/tests/server/security.test.js
git commit -m "feat(idea3): enforce admin session and csrf controls"
```

### Task 3: Build safe Live and Demo providers, normalization, deduplication, and correlation

**Files:**
- Create: `IDEA3-AEGIS_Lockdown/web/server/domain/normalize.js`
- Create: `IDEA3-AEGIS_Lockdown/web/server/domain/correlate.js`
- Create: `IDEA3-AEGIS_Lockdown/web/server/providers/liveProvider.js`
- Create: `IDEA3-AEGIS_Lockdown/web/server/providers/demoProvider.js`
- Create: `IDEA3-AEGIS_Lockdown/web/server/repositories/memoryRepository.js`
- Create: `IDEA3-AEGIS_Lockdown/web/server/routes/securityRoutes.js`
- Create: `IDEA3-AEGIS_Lockdown/web/tests/fixtures/evidence.js`
- Create: `IDEA3-AEGIS_Lockdown/web/tests/server/normalize.test.js`
- Create: `IDEA3-AEGIS_Lockdown/web/tests/server/correlate.test.js`
- Create: `IDEA3-AEGIS_Lockdown/web/tests/server/securityRoutes.test.js`

**Interfaces:**
- Consumes: canonical statuses and `createApp(...)`.
- Produces: `normalizeIdea1Event`, `normalizeIdea2Event`, `normalizeRuntimeStatus`, `deduplicateEvents`, `correlateIncidents`, `createDemoProvider({ clock })`, `createLiveProvider({ config, fetchImpl, clock })`, and the snapshot/action endpoints under `/api/security`.

- [ ] **Step 1: Write failing contract tests for field allowlists and unsafe evidence**

```js
it('drops raw payload, media, biometric, and credential fields', () => {
  const normalized = normalizeIdea2Event({ timestamp: '2026-09-03T00:00:00.000Z', type: 'PERSON_DETECTED', severity: 'HIGH', source_ip: '10.30.0.24', target: 'CAM-02', result: 'DETECTED', frame: 'base64', embedding: [1, 2], password: 'secret' })
  expect(normalized).toEqual({ id: expect.any(String), timestamp: '2026-09-03T00:00:00.000Z', source: 'IDEA2', type: 'PERSON_DETECTED', severity: 'HIGH', sourceIp: '10.30.0.24', target: 'CAM-02', result: 'DETECTED' })
})

it('marks future runtime evidence UNKNOWN', () => {
  expect(normalizeRuntimeStatus(futureRuntime, { now: new Date('2026-09-03T00:00:00.000Z') }).status).toBe('UNKNOWN')
})
```

- [ ] **Step 2: Run normalization/correlation tests and verify RED**

Run: `npm test -- tests/server/normalize.test.js tests/server/correlate.test.js`
Expected: FAIL because normalization and correlation functions are absent.

- [ ] **Step 3: Implement strict allowlists, stable IDs, freshness, dedup, and ten-minute correlation**

```js
export function correlateIncidents(events, windowMs = 600000) {
  const idea1 = events.filter((event) => event.source === 'IDEA1' && ['DENIED', 'BLOCKED'].includes(event.result))
  const idea2 = events.filter((event) => event.source === 'IDEA2')
  return idea1.flatMap((access) => idea2
    .filter((detection) => detection.sourceIp === access.sourceIp && Math.abs(Date.parse(detection.timestamp) - Date.parse(access.timestamp)) <= windowMs)
    .map((detection) => buildIncident(access, detection)))
    .filter(uniqueIncident)
}
```

- [ ] **Step 4: Write failing route tests for Demo/Live isolation and production Demo denial**

```js
it('never merges demo records into a live snapshot', async () => {
  await enableDemo(agent, csrf)
  const demo = await agent.get('/api/security/snapshot')
  await disableDemo(agent, csrf)
  const live = await agent.get('/api/security/snapshot')
  expect(demo.body.mode).toBe('DEMO')
  expect(live.body.mode).toBe('LIVE')
  expect(live.body.events.some((event) => event.id.startsWith('demo-'))).toBe(false)
})
```

- [ ] **Step 5: Implement providers, repository interfaces, bounded query parsing, snapshots, acknowledge/note/dry-run/settings actions**

```js
router.get('/snapshot', requireAdmin, asyncHandler(async (req, res) => {
  const provider = req.session.demoMode ? demoProvider : liveProvider
  const snapshot = await provider.getSnapshot(parseBoundedFilters(req.query))
  res.set('Cache-Control', 'no-store').json(snapshot)
}))
```

- [ ] **Step 6: Run provider and route tests and verify GREEN**

Run: `npm test -- tests/server/normalize.test.js tests/server/correlate.test.js tests/server/securityRoutes.test.js`
Expected: allowlist, malformed/stale/future, dedup, correlation, Demo isolation, production denial, action audit, and bounds tests PASS.

- [ ] **Step 7: Commit the evidence pipeline**

```bash
git add IDEA3-AEGIS_Lockdown/web/server/domain IDEA3-AEGIS_Lockdown/web/server/providers IDEA3-AEGIS_Lockdown/web/server/repositories IDEA3-AEGIS_Lockdown/web/server/routes/securityRoutes.js IDEA3-AEGIS_Lockdown/web/tests/fixtures IDEA3-AEGIS_Lockdown/web/tests/server/normalize.test.js IDEA3-AEGIS_Lockdown/web/tests/server/correlate.test.js IDEA3-AEGIS_Lockdown/web/tests/server/securityRoutes.test.js
git commit -m "feat(idea3): add isolated security evidence providers"
```

### Task 4: Create the themed authenticated application shell and navigation

**Files:**
- Create: `IDEA3-AEGIS_Lockdown/web/src/main.jsx`
- Create: `IDEA3-AEGIS_Lockdown/web/src/App.jsx`
- Create: `IDEA3-AEGIS_Lockdown/web/src/styles/tokens.css`
- Create: `IDEA3-AEGIS_Lockdown/web/src/styles/app.css`
- Create: `IDEA3-AEGIS_Lockdown/web/src/lib/api.js`
- Create: `IDEA3-AEGIS_Lockdown/web/src/lib/routes.js`
- Create: `IDEA3-AEGIS_Lockdown/web/src/lib/format.js`
- Create: `IDEA3-AEGIS_Lockdown/web/src/components/AppShell.jsx`
- Create: `IDEA3-AEGIS_Lockdown/web/src/components/StatusBadge.jsx`
- Create: `IDEA3-AEGIS_Lockdown/web/src/components/EvidenceState.jsx`
- Create: `IDEA3-AEGIS_Lockdown/web/src/components/DataTable.jsx`
- Create: `IDEA3-AEGIS_Lockdown/web/src/components/MetricCard.jsx`
- Create: `IDEA3-AEGIS_Lockdown/web/src/components/Panel.jsx`
- Create: `IDEA3-AEGIS_Lockdown/web/src/components/Timeline.jsx`
- Create: `IDEA3-AEGIS_Lockdown/web/src/components/DemoBanner.jsx`
- Create: `IDEA3-AEGIS_Lockdown/web/src/pages/LoginPage.jsx`
- Create: `IDEA3-AEGIS_Lockdown/web/tests/client/shell.test.jsx`
- Create: `IDEA3-AEGIS_Lockdown/web/tests/client/login.test.jsx`
- Create: `IDEA3-AEGIS_Lockdown/web/tests/setup.js`

**Interfaces:**
- Consumes: auth/session/snapshot endpoints from Tasks 2–3.
- Produces: `apiFetch`, `APP_ROUTES`, `AppShell`, shared evidence components, theme persistence, mobile navigation, and the login gate.

- [ ] **Step 1: Write failing shell tests for all eleven links, server identity, theme, and Demo warning**

```jsx
it('renders all eleven authorized destinations and the server identity', () => {
  render(<AppShell identity={{ displayName: 'System Administrator', role: 'ADMIN' }} mode="LIVE"><p>content</p></AppShell>)
  expect(screen.getAllByRole('link')).toHaveLength(11)
  expect(screen.getByText('System Administrator')).toBeVisible()
  expect(screen.getByText('ADMIN')).toBeVisible()
})

it('shows a persistent warning when the server mode is DEMO', () => {
  render(<DemoBanner mode="DEMO" />)
  expect(screen.getByText('ข้อมูลจำลองเพื่อสาธิต UI — ไม่ใช่สถานะระบบจริง')).toBeVisible()
})
```

- [ ] **Step 2: Run client shell tests and verify RED**

Run: `npm test -- tests/client/shell.test.jsx tests/client/login.test.jsx`
Expected: FAIL because React entry points and components do not exist.

- [ ] **Step 3: Implement semantic shell, theme tokens, API wrapper, login gate, and common components**

```js
export const APP_ROUTES = [
  ['dashboard', 'แดชบอร์ด'], ['overview', 'ภาพรวม'], ['idea1', 'IDEA1 Security'],
  ['idea2', 'IDEA2 Detection'], ['lockdown', 'IDEA3 Lockdown'], ['alerts', 'การแจ้งเตือน'],
  ['incidents', 'เหตุการณ์'], ['audit', 'บันทึกตรวจสอบ'], ['devices', 'อุปกรณ์'],
  ['recovery', 'การกู้คืน'], ['settings', 'ตั้งค่า']
]
```

- [ ] **Step 4: Run shell tests and verify GREEN**

Run: `npm test -- tests/client/shell.test.jsx tests/client/login.test.jsx`
Expected: navigation, identity, login errors, theme, drawer, and Demo banner tests PASS.

- [ ] **Step 5: Commit the application shell**

```bash
git add IDEA3-AEGIS_Lockdown/web/src IDEA3-AEGIS_Lockdown/web/tests/client/shell.test.jsx IDEA3-AEGIS_Lockdown/web/tests/client/login.test.jsx IDEA3-AEGIS_Lockdown/web/tests/setup.js
git commit -m "feat(idea3): create authenticated security center shell"
```

### Task 5: Implement Dashboard, Overview, and IDEA3 Lockdown pages

**Files:**
- Create: `IDEA3-AEGIS_Lockdown/web/src/pages/DashboardPage.jsx`
- Create: `IDEA3-AEGIS_Lockdown/web/src/pages/OverviewPage.jsx`
- Create: `IDEA3-AEGIS_Lockdown/web/src/pages/LockdownPage.jsx`
- Create: `IDEA3-AEGIS_Lockdown/web/tests/client/corePages.test.jsx`
- Modify: `IDEA3-AEGIS_Lockdown/web/src/App.jsx`
- Modify: `IDEA3-AEGIS_Lockdown/web/src/styles/app.css`

**Interfaces:**
- Consumes: normalized `snapshot` containing `overall`, `sources`, `events`, `incidents`, `issues`, `runtime`, `readiness`, and `mode`.
- Produces: three responsive evidence pages and route selection for `/security/dashboard`, `/security/overview`, and `/security/lockdown`.

- [ ] **Step 1: Write failing tests for observable page decisions**

```jsx
it('does not call stale runtime evidence healthy', () => {
  render(<LockdownPage snapshot={snapshotWithStaleRuntime} />)
  expect(screen.getByText('UNKNOWN')).toBeVisible()
  expect(screen.getByText(/หลักฐานล่าสุดเก่าเกินกำหนด/)).toBeVisible()
})

it('explains why command controls are unavailable', () => {
  render(<LockdownPage snapshot={demoSnapshot} />)
  expect(screen.getByRole('button', { name: 'ตัดการเชื่อมต่อเครือข่าย' })).toBeDisabled()
  expect(screen.getByText(/ไม่มี command endpoint ใน milestone นี้/)).toBeVisible()
})
```

- [ ] **Step 2: Run core page tests and verify RED**

Run: `npm test -- tests/client/corePages.test.jsx`
Expected: FAIL because the three page components do not exist.

- [ ] **Step 3: Implement the IDEA1-inspired ledger Dashboard, architecture Overview, and evidence-only Lockdown page**

```jsx
<Panel title="สถานะแหล่งหลักฐาน" description="เวลาและสถานะมาจาก API ฝั่งเซิร์ฟเวอร์">
  <DataTable columns={sourceColumns} rows={snapshot.sources} emptyLabel="ยังไม่มีหลักฐานจากแหล่งข้อมูล" />
</Panel>
```

- [ ] **Step 4: Run core page tests and verify GREEN**

Run: `npm test -- tests/client/corePages.test.jsx`
Expected: KPIs, source ledger, provenance, readiness, UNKNOWN, issues, timeline, and disabled-command tests PASS.

- [ ] **Step 5: Commit the operational core pages**

```bash
git add IDEA3-AEGIS_Lockdown/web/src/pages/DashboardPage.jsx IDEA3-AEGIS_Lockdown/web/src/pages/OverviewPage.jsx IDEA3-AEGIS_Lockdown/web/src/pages/LockdownPage.jsx IDEA3-AEGIS_Lockdown/web/src/App.jsx IDEA3-AEGIS_Lockdown/web/src/styles/app.css IDEA3-AEGIS_Lockdown/web/tests/client/corePages.test.jsx
git commit -m "feat(idea3): add core evidence and lockdown pages"
```

### Task 6: Implement IDEA1, IDEA2, Alerts, Incidents, and Audit ledgers

**Files:**
- Create: `IDEA3-AEGIS_Lockdown/web/src/pages/Idea1SecurityPage.jsx`
- Create: `IDEA3-AEGIS_Lockdown/web/src/pages/Idea2DetectionPage.jsx`
- Create: `IDEA3-AEGIS_Lockdown/web/src/pages/AlertsPage.jsx`
- Create: `IDEA3-AEGIS_Lockdown/web/src/pages/IncidentsPage.jsx`
- Create: `IDEA3-AEGIS_Lockdown/web/src/pages/AuditPage.jsx`
- Create: `IDEA3-AEGIS_Lockdown/web/tests/client/evidencePages.test.jsx`
- Modify: `IDEA3-AEGIS_Lockdown/web/src/App.jsx`
- Modify: `IDEA3-AEGIS_Lockdown/web/src/styles/app.css`

**Interfaces:**
- Consumes: `snapshot.idea1`, `snapshot.idea2`, `snapshot.alerts`, `snapshot.incidents`, `snapshot.audit`; calls `apiFetch` for acknowledge, incident note, and bounded audit export.
- Produces: five filterable evidence pages whose mutations refresh from server state.

- [ ] **Step 1: Write failing tests for privacy, evidence stages, and audited actions**

```jsx
it('shows only normalized IDEA2 evidence fields', () => {
  render(<Idea2DetectionPage snapshot={demoSnapshot} />)
  expect(screen.getByText('PERSON_DETECTED')).toBeVisible()
  expect(screen.queryByText(/base64|embedding|face/i)).not.toBeInTheDocument()
})

it('separates requested, accepted, acked, executed, and physically verified stages', () => {
  render(<IncidentsPage snapshot={demoSnapshot} />)
  for (const label of ['REQUESTED', 'ACCEPTED', 'ACKED', 'EXECUTED', 'PHYSICALLY VERIFIED']) {
    expect(screen.getByText(label)).toBeVisible()
  }
})
```

- [ ] **Step 2: Run evidence page tests and verify RED**

Run: `npm test -- tests/client/evidencePages.test.jsx`
Expected: FAIL because the five page components do not exist.

- [ ] **Step 3: Implement bounded filters, tables, alert acknowledgement, incident detail/timeline, and audit export request**

```jsx
<button type="button" className="button button--secondary" onClick={() => onAcknowledge(alert.id)} disabled={alert.status === 'ACKNOWLEDGED'}>
  รับทราบ
</button>
```

- [ ] **Step 4: Run evidence page tests and verify GREEN**

Run: `npm test -- tests/client/evidencePages.test.jsx`
Expected: sanitized fields, filters, partial-source state, dedup count, acknowledge, evidence-stage, analyst-note, tamper-state, and export tests PASS.

- [ ] **Step 5: Commit the evidence and response pages**

```bash
git add IDEA3-AEGIS_Lockdown/web/src/pages/Idea1SecurityPage.jsx IDEA3-AEGIS_Lockdown/web/src/pages/Idea2DetectionPage.jsx IDEA3-AEGIS_Lockdown/web/src/pages/AlertsPage.jsx IDEA3-AEGIS_Lockdown/web/src/pages/IncidentsPage.jsx IDEA3-AEGIS_Lockdown/web/src/pages/AuditPage.jsx IDEA3-AEGIS_Lockdown/web/src/App.jsx IDEA3-AEGIS_Lockdown/web/src/styles/app.css IDEA3-AEGIS_Lockdown/web/tests/client/evidencePages.test.jsx
git commit -m "feat(idea3): add normalized evidence response pages"
```

### Task 7: Implement Devices, Recovery, and Settings with safe write workflows

**Files:**
- Create: `IDEA3-AEGIS_Lockdown/web/src/pages/DevicesPage.jsx`
- Create: `IDEA3-AEGIS_Lockdown/web/src/pages/RecoveryPage.jsx`
- Create: `IDEA3-AEGIS_Lockdown/web/src/pages/SettingsPage.jsx`
- Create: `IDEA3-AEGIS_Lockdown/web/tests/client/systemPages.test.jsx`
- Modify: `IDEA3-AEGIS_Lockdown/web/src/App.jsx`
- Modify: `IDEA3-AEGIS_Lockdown/web/src/styles/app.css`

**Interfaces:**
- Consumes: device evidence, recovery readiness/history, safe settings; calls `/api/security/recovery/dry-run`, `/api/security/settings`, and `/api/security/demo-mode` with CSRF.
- Produces: three system pages and Demo toggle refresh behavior.

- [ ] **Step 1: Write failing tests for evidence wording, dry-run side-effect safety, and Demo controls**

```jsx
it('does not present a requested relay state as physically verified', () => {
  render(<DevicesPage snapshot={demoSnapshot} />)
  expect(screen.getByText('คำขอ: OPEN')).toBeVisible()
  expect(screen.getByText('หลักฐานทางกายภาพ: UNKNOWN')).toBeVisible()
})

it('labels recovery validation as a dry-run with no device action', () => {
  render(<RecoveryPage snapshot={demoSnapshot} />)
  expect(screen.getByRole('button', { name: 'ตรวจสอบความพร้อมแบบ Dry-run' })).toBeEnabled()
  expect(screen.getByText(/ไม่ส่ง MQTT และไม่เปลี่ยนสถานะ Relay/)).toBeVisible()
})
```

- [ ] **Step 2: Run system page tests and verify RED**

Run: `npm test -- tests/client/systemPages.test.jsx`
Expected: FAIL because the three page components do not exist.

- [ ] **Step 3: Implement device evidence/topology, recovery readiness/runbook, and safe setting summaries**

```jsx
<label className="switch-row">
  <span><strong>Demo Mode</strong><small>เฉพาะ session นี้และปิดอัตโนมัติเมื่อเข้าสู่ระบบใหม่</small></span>
  <input type="checkbox" checked={snapshot.mode === 'DEMO'} onChange={(event) => onDemoMode(event.target.checked)} />
</label>
```

- [ ] **Step 4: Run system page tests and verify GREEN**

Run: `npm test -- tests/client/systemPages.test.jsx`
Expected: device evidence stages, topology labels, recovery preconditions, dry-run wording, production Demo denial, and settings tests PASS.

- [ ] **Step 5: Commit the system pages**

```bash
git add IDEA3-AEGIS_Lockdown/web/src/pages/DevicesPage.jsx IDEA3-AEGIS_Lockdown/web/src/pages/RecoveryPage.jsx IDEA3-AEGIS_Lockdown/web/src/pages/SettingsPage.jsx IDEA3-AEGIS_Lockdown/web/src/App.jsx IDEA3-AEGIS_Lockdown/web/src/styles/app.css IDEA3-AEGIS_Lockdown/web/tests/client/systemPages.test.jsx
git commit -m "feat(idea3): add device recovery and settings surfaces"
```

### Task 8: Verify responsive behavior, document operation, and prepare the IDEA3 receipt

**Files:**
- Create: `IDEA3-AEGIS_Lockdown/web/README.md`
- Modify: `IDEA3-AEGIS_Lockdown/web/src/styles/app.css`
- Modify: `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md`
- Create: `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-09-03_HHMMSS_music_idea3-security-center.md`

**Interfaces:**
- Consumes: the complete tested application.
- Produces: verified build/test evidence, screenshots for eleven routes in both themes, operating instructions, durable IDEA3 status, and one immutable task receipt.

- [ ] **Step 1: Run the complete automated suite before visual inspection**

Run: `npm test`
Expected: all server and client tests PASS with zero failures and no unexpected warnings.

- [ ] **Step 2: Build the production client**

Run: `npm run build`
Expected: Vite exits 0 and creates `dist/`; `dist/` remains ignored and unstaged.

- [ ] **Step 3: Start the server using development-only credentials and inspect all routes**

```bash
NODE_ENV=development \
AEGIS_ALLOW_DEV_LOGIN=true \
AEGIS_IDEA3_ADMIN_USER=admin \
AEGIS_IDEA3_DEV_PASSWORD='<local-only-password>' \
SESSION_SECRET='<local-secret-at-least-32-characters>' \
npm start
```

Inspect: `/security/dashboard`, `/security/overview`, `/security/idea1`, `/security/idea2`, `/security/lockdown`, `/security/alerts`, `/security/incidents`, `/security/audit`, `/security/devices`, `/security/recovery`, and `/security/settings` at 1440×900, 1024×768, and 390×844 in Light and Dark themes.

- [ ] **Step 4: Correct any visual defect through a focused RED/GREEN component test**

For each defect, add a test naming the observable broken behavior, run the focused test to see it fail, make the smallest CSS/component change, rerun the focused test, and rerun `npm test`.

- [ ] **Step 5: Run repository and scope checks**

```bash
git diff --check
git diff --name-status origin/main...HEAD
node .agents/skills/impeccable/scripts/detect.mjs IDEA3-AEGIS_Lockdown/web/src --gpt
node --test tests/vaultStructure.test.mjs tests/vaultMultiWriter.test.mjs tests/collaborationPolicy.test.mjs
```

Expected: formatting, UI detector/audit, Vault validation, and collaboration-policy tests PASS; every source path is inside IDEA3, while the owner-authorized IDEA3 status and receipt paths are the only documentation paths outside the primary code directory.

- [ ] **Step 6: Write operating documentation and exact evidence receipt**

Record the exact commands and real pass/fail counts, branch, observable pages, source paths, limitations, canonical note update, and shared surfaces. The receipt must say hardware control, live producer validation, durable production storage, and deployment remain unverified/out of scope. Shared surfaces must be `None` unless the final diff proves otherwise.

- [ ] **Step 7: Stage only reviewed paths and commit documentation**

```bash
git add IDEA3-AEGIS_Lockdown Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-09-03_HHMMSS_music_idea3-security-center.md
git diff --cached --check
git diff --cached --name-status
git commit -m "docs(idea3): record security center implementation"
```

- [ ] **Step 8: Push and open a Draft Pull Request**

```bash
git push -u origin feat/idea3-security-center-11-page
gh pr create --draft --base main --head feat/idea3-security-center-11-page --title "feat(idea3): build 11-page security center" --body-file /tmp/idea3-security-center-pr.md
```

The PR policy block uses `area: idea3`, `owner: music`, and `integration-review: no` only if the final diff has no cross-scope/shared path. Request Kla as the temporary GitHub reviewer for IDEA3. Mark Ready only after all local verification and required policy checks pass.
