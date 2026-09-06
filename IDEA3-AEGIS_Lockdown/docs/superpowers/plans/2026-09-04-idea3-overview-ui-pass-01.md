# IDEA3 Overview UI Pass 01 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Security Center Overview into an evidence-honest architecture and integration-readiness surface without changing Dashboard, backend contracts, or cyber-physical behavior.

**Architecture:** Build a presentation-only derivation layer inside `OverviewPage.jsx` that converts existing snapshot evidence into conservative canonical statuses. Add only two backward-compatible shared affordances—an optional `Panel` region label and an Overview route description—then render a boundary-first hierarchy with Overview-scoped CSS. The branch stays stacked on the accepted Dashboard/trilingual branch and receives local commits only.

**Tech Stack:** React 19, Vite 7, Vitest 3, Testing Library, Lucide React, plain CSS, Obsidian Markdown receipts.

**Spec:** `IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-09-04-idea3-overview-ui-pass-01-design.md`

## Global Constraints

- Work only on `feat/idea3-overview-ui-pass-01`, based on `origin/feature/aegis-security-ui-redesign` at `eaa605d`.
- Treat `/home/kittipat/Workspace/Final Project Network Cyber/Projects/The_AEGIS` as read-only recovery evidence, not as a Git repository.
- Never copy whole shared files from the recovery source: its `AppShell.jsx`, `app.css`, and `corePages.test.jsx` contain unrelated hunks outside this receipt.
- Do not modify Dashboard, other pages, Python, MQTT, ESP32, relay, gateway, network, database, deployment, APIs, authentication, RBAC, or CSRF.
- Use only `HEALTHY`, `DEGRADED`, `FAILED`, `UNKNOWN`, `NOT_CONFIGURED`, `STALE`, and `DISABLED` as Overview status vocabulary.
- `HEALTHY` requires fresh evidence plus a validation timestamp; stale evidence overrides health.
- Requested state, ACK state, executed state, and physical evidence remain separate.
- Never migrate `node_modules/`, `dist/`, coverage, caches, `.env`, credentials, tokens, or secrets.
- Add exactly one new Music-owned task receipt after implementation and verification.
- Do not push, merge, or create a Pull Request.

---

### Task 1: Add the Overview-specific page purpose without changing Dashboard

**Files:**
- Modify: `IDEA3-AEGIS_Lockdown/web/tests/client/shell.test.jsx:14-103`
- Modify: `IDEA3-AEGIS_Lockdown/web/src/lib/routes.js:6-18`
- Modify: `IDEA3-AEGIS_Lockdown/web/src/components/AppShell.jsx:103-108`
- Modify: `IDEA3-AEGIS_Lockdown/web/src/styles/app.css:33`

**Interfaces:**
- Consumes: `routeById(id)` returning the existing route object.
- Produces: optional `route.description: string`; `.page-heading__description` rendered only when `currentRoute !== 'dashboard'`.

- [ ] **Step 1: Install the locked web dependencies in the isolated worktree**

Run:

```bash
cd IDEA3-AEGIS_Lockdown/web
npm ci
```

Expected: dependencies install from `package-lock.json`; Git continues to ignore `node_modules/`.

- [ ] **Step 2: Write the failing shell test**

Append this case inside `describe('authenticated application shell', ...)`:

```jsx
it('describes Overview as architecture and integration readiness in the page heading', () => {
  render(
    <AppShell identity={identity} mode="DEMO" currentRoute="overview">
      <p>Page</p>
    </AppShell>,
  )

  expect(screen.getByRole('heading', { name: 'ภาพรวมระบบ', level: 1 })).toBeVisible()
  expect(screen.getByText('สถาปัตยกรรมการเชื่อมต่อ หลักฐาน และความพร้อมของ AEGIS')).toBeVisible()
})
```

- [ ] **Step 3: Run the shell test and confirm the new assertion fails**

Run:

```bash
npm test -- tests/client/shell.test.jsx
```

Expected: FAIL because the architecture/readiness description is not rendered yet.

- [ ] **Step 4: Add the route description and render it only outside Dashboard**

Change the Overview route object to:

```js
{
  id: 'overview',
  label: 'ภาพรวมระบบ',
  description: 'สถาปัตยกรรมการเชื่อมต่อ หลักฐาน และความพร้อมของ AEGIS',
  eyebrow: 'Workspace',
  group: 'พื้นที่ทำงาน',
  icon: ChartNoAxesCombined,
}
```

Immediately after the existing page `<h1>` in `AppShell.jsx`, add:

```jsx
{!dashboardRoute && route.description && (
  <p className="page-heading__description">{route.description}</p>
)}
```

Do not port the recovery source’s `useRef`, mobile-navigation state, `inert`, Escape handling, or drawer-focus changes; they are not part of Overview UI Pass 01.

Add only this page-heading rule to `app.css`:

```css
.page-heading p.page-heading__description { max-width: 72ch; margin: 8px 0 0; color: var(--ink-secondary); font: 13px InterVariable, "IBM Plex Sans Thai", sans-serif; line-height: 1.7; letter-spacing: 0; text-transform: none; }
```

Do not port global navigation, icon-button, button, or mobile-menu sizing changes from the recovery source.

- [ ] **Step 5: Run shell and Dashboard-language regressions**

Run:

```bash
npm test -- tests/client/shell.test.jsx tests/client/appLanguage.test.jsx tests/client/dashboardPage.test.jsx
```

Expected: PASS; Dashboard language scope and heading remain unchanged.

- [ ] **Step 6: Commit the focused shell change**

```bash
git add IDEA3-AEGIS_Lockdown/web/tests/client/shell.test.jsx IDEA3-AEGIS_Lockdown/web/src/lib/routes.js IDEA3-AEGIS_Lockdown/web/src/components/AppShell.jsx IDEA3-AEGIS_Lockdown/web/src/styles/app.css
git diff --cached --check
git commit -m "feat(idea3): clarify overview page purpose"
```

### Task 2: Derive honest integration status and rebuild the Overview hierarchy

**Files:**
- Modify: `IDEA3-AEGIS_Lockdown/web/tests/client/corePages.test.jsx:1-70`
- Modify: `IDEA3-AEGIS_Lockdown/web/src/components/Panel.jsx:3-16`
- Replace: `IDEA3-AEGIS_Lockdown/web/src/pages/OverviewPage.jsx:1-66`
- Modify: `IDEA3-AEGIS_Lockdown/web/src/styles/app.css:56-62`

**Interfaces:**
- Consumes: the unchanged Security Center snapshot (`mode`, `sources`, `idea1`, `idea2`, `runtime`, `devices`, `settings`, `provenance`, `recovery`, `deployment`).
- Produces: `safeStatus(value, fallback)`, `safeText(value, fallback)`, `evidenceStatus({ status, freshness, generatedAt })`, `sourceById(snapshot, id)`, `adapterById(snapshot, id)`, `integrationStatus(source, domain)`, and `securityReadiness(snapshot)` inside `OverviewPage.jsx`.
- Produces: `Panel({ title, description, action, className, ariaLabel, children })`, where `ariaLabel` is optional and existing callers remain valid.

- [ ] **Step 1: Replace the old Overview assertion with three failing behavior tests**

Import `within`:

```jsx
import { render, screen, within } from '@testing-library/react'
```

Inside `describe('Overview', ...)`, add these behaviors:

```jsx
it('leads with the evidence boundary and architecture flow before integration details', () => {
  render(<OverviewPage snapshot={snapshot} />)

  const boundary = screen.getByRole('region', { name: 'ขอบเขตสภาพแวดล้อมและหลักฐาน' })
  const flow = screen.getByRole('region', { name: 'เส้นทางของหลักฐาน' })
  const contracts = screen.getByRole('region', { name: 'สัญญาการเชื่อมต่อ' })
  const matrix = screen.getByRole('region', { name: 'Integration matrix' })

  expect(within(boundary).getByText('DEMO')).toBeVisible()
  expect(within(boundary).getByText('isolated-demo-provider')).toBeVisible()
  expect(within(boundary).getByText('SESSION_AND_MEMORY_ONLY')).toBeVisible()
  expect(within(boundary).getByText('NOT ALLOWED')).toBeVisible()
  expect(flow.compareDocumentPosition(contracts) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(contracts.compareDocumentPosition(matrix) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(within(flow).getByText((_, element) => element?.tagName === 'SPAN' && element.textContent === 'IDEA1 Evidence')).toBeVisible()
  expect(within(flow).getByText((_, element) => element?.tagName === 'SPAN' && element.textContent === 'IDEA2 Evidence')).toBeVisible()
  expect(within(flow).getByText((_, element) => element?.tagName === 'SPAN' && element.textContent === 'IDEA3 Runtime')).toBeVisible()
  expect(screen.getByText('Validate & normalize')).toBeVisible()
  expect(screen.getByText('ไม่มีการรวม Demo กับ Live')).toBeVisible()
})

it('keeps stale evidence and physical evidence uncertainty visible instead of implying health', () => {
  const staleSnapshot = {
    ...snapshot,
    idea1: { ...snapshot.idea1, status: 'HEALTHY', freshness: 'STALE' },
  }
  render(<OverviewPage snapshot={staleSnapshot} />)

  const idea1Card = screen.getByRole('article', { name: 'IDEA1 Access Security integration' })
  const idea3Card = screen.getByRole('article', { name: 'IDEA3 Runtime integration' })
  const idea1Row = screen.getByRole('row', { name: /IDEA1 Access Security/ })
  const contractReadiness = screen.getByText('Sanitized evidence contract').closest('.readiness-ledger > div')

  expect(within(idea1Card).getByLabelText('สถานะ STALE')).toBeVisible()
  expect(within(idea1Card).getAllByText('STALE')).toHaveLength(2)
  expect(within(idea1Row).getAllByText('STALE')).toHaveLength(2)
  expect(within(contractReadiness).getByText('STALE')).toBeVisible()
  expect(within(idea3Card).getByText('MONITOR ONLY')).toBeVisible()
  expect(within(idea3Card).getByText('DRY RUN')).toBeVisible()
  expect(within(idea3Card).getByText('UNKNOWN')).toBeVisible()
})

it('uses honest fallback states when provider metadata or integrations are missing', () => {
  const incompleteSnapshot = {
    ...snapshot,
    provenance: { liveMerged: false },
    sources: [],
    settings: { ...snapshot.settings, adapters: [] },
  }
  render(<OverviewPage snapshot={incompleteSnapshot} />)

  const boundary = screen.getByRole('region', { name: 'ขอบเขตสภาพแวดล้อมและหลักฐาน' })
  expect(within(boundary).getByText('UNKNOWN')).toBeVisible()
  expect(within(boundary).getByText('NOT_CONFIGURED')).toBeVisible()
  expect(screen.getByText('ยังไม่มีผลการตรวจสอบ integration')).toBeVisible()
})
```

Do not port the recovery source’s separate `EvidenceState` cached-refresh test; it is outside the Overview receipt.

- [ ] **Step 2: Run the focused test and verify the new cases fail**

Run:

```bash
npm test -- tests/client/corePages.test.jsx
```

Expected: FAIL because named regions, integration cards, conservative stale derivation, and missing-metadata fallbacks do not exist yet.

- [ ] **Step 3: Add the backward-compatible Panel region label**

Change only the signature and opening `<section>`:

```jsx
export function Panel({ title, description, action, className = '', ariaLabel, children }) {
  return (
    <section className={`panel ${className}`.trim()} aria-label={ariaLabel}>
```

- [ ] **Step 4: Implement the conservative status helpers**

At the top of `OverviewPage.jsx`, define:

```jsx
const CANONICAL_STATUSES = new Set([
  'HEALTHY', 'DEGRADED', 'FAILED', 'UNKNOWN', 'NOT_CONFIGURED', 'STALE', 'DISABLED',
])

function safeStatus(value, fallback = 'UNKNOWN') {
  return CANONICAL_STATUSES.has(value) ? value : fallback
}

function safeText(value, fallback = 'UNKNOWN') {
  return typeof value === 'string' && value.trim() ? value : fallback
}

function evidenceStatus({ status, freshness, generatedAt }) {
  const normalized = safeStatus(status)
  if (freshness === 'STALE') return 'STALE'
  if (normalized === 'HEALTHY' && (freshness !== 'FRESH' || !generatedAt)) return 'UNKNOWN'
  return normalized
}

function sourceById(snapshot, id) {
  return snapshot.sources?.find((source) => source.id === id)
}

function adapterById(snapshot, id) {
  return snapshot.settings?.adapters?.find((adapter) => adapter.id === id)
}

function integrationStatus(source, domain) {
  if (!source) return 'NOT_CONFIGURED'
  return evidenceStatus({
    status: source.status,
    freshness: domain?.freshness ?? source.freshness,
    generatedAt: domain?.generatedAt ?? source.generatedAt,
  })
}
```

Implement `securityReadiness(snapshot)` with this exact precedence:

1. Fewer than three source contracts → `NOT_CONFIGURED`.
2. Any `FAILED` → `FAILED`.
3. Any `STALE` → `STALE`.
4. Any `UNKNOWN` or `NOT_CONFIGURED` → `UNKNOWN`.
5. Any `DEGRADED` → `DEGRADED`.
6. Otherwise → `HEALTHY`.

Use this implementation so every row is derived from the snapshot:

```jsx
function securityReadiness(snapshot) {
  const security = snapshot.settings?.security
  const provenance = snapshot.provenance
  const integrationSources = ['idea1', 'idea2', 'idea3']
    .map((id) => ({
      id,
      source: sourceById(snapshot, id),
      domain: id === 'idea3' ? snapshot.runtime : snapshot[id],
    }))
    .filter(({ source }) => Boolean(source))
  const contractStates = integrationSources.map(({ source, domain }) => integrationStatus(source, domain))
  const contractStatus = integrationSources.length < 3
    ? 'NOT_CONFIGURED'
    : contractStates.includes('FAILED')
      ? 'FAILED'
      : contractStates.includes('STALE')
        ? 'STALE'
        : contractStates.includes('UNKNOWN') || contractStates.includes('NOT_CONFIGURED')
          ? 'UNKNOWN'
          : contractStates.includes('DEGRADED') ? 'DEGRADED' : 'HEALTHY'

  const adminStatus = !security
    ? 'NOT_CONFIGURED'
    : security.adminRbac === 'ENFORCED' && security.csrf === 'ENFORCED' ? 'HEALTHY' : 'DEGRADED'
  const isolationStatus = provenance?.liveMerged === false
    ? 'HEALTHY'
    : provenance?.liveMerged === true ? 'FAILED' : 'UNKNOWN'
  const persistence = safeText(provenance?.persistence, 'NOT_CONFIGURED')
  const storeStatus = persistence === 'NOT_CONFIGURED' || /MEMORY/.test(persistence) ? 'NOT_CONFIGURED' : 'UNKNOWN'

  return [
    { label: 'Durable production store', status: storeStatus, detail: persistence === 'NOT_CONFIGURED' ? 'ไม่มี persistence metadata' : `ปัจจุบัน: ${persistence}` },
    { label: 'Hardware control gateway', status: safeStatus(snapshot.recovery?.gatewayStatus, 'NOT_CONFIGURED'), detail: 'หน้าเว็บไม่มีสิทธิ์สั่ง Relay หรือ network isolation' },
    { label: 'Production deployment', status: safeStatus(snapshot.deployment?.status), detail: 'ไม่มี deployment evidence ใน snapshot นี้' },
    { label: 'Sanitized evidence contract', status: contractStatus, detail: `${integrationSources.length}/3 integration มีผล validation` },
    { label: 'Admin RBAC + CSRF', status: adminStatus, detail: adminStatus === 'HEALTHY' ? 'API ประกาศว่า ENFORCED' : 'ยังยืนยัน enforcement ไม่ครบ' },
    { label: 'Demo / Live isolation', status: isolationStatus, detail: isolationStatus === 'HEALTHY' ? 'provider ประกาศว่าไม่รวมข้อมูลข้าม boundary' : 'ยังยืนยันการแยก boundary ไม่ได้' },
  ]
}
```

- [ ] **Step 5: Replace the Overview structure with the approved hierarchy**

The reviewed complete `OverviewPage.jsx` recovery artifact is:

```text
/home/kittipat/Workspace/Final Project Network Cyber/Projects/The_AEGIS/IDEA3-AEGIS_Lockdown/web/src/pages/OverviewPage.jsx
SHA-256: 1fc79e5b5c219aaf511114451bb6ae1135ac8143746e1b86795824ce5ec8b166
```

Verify that checksum, inspect the whole file, then use `apply_patch` to port that file into the isolated worktree. This file is safe to replace as a unit; unlike the shared files, its entire diff belongs to Overview UI Pass 01.

The resulting semantic order must be: `.evidence-boundary` named “ขอบเขตสภาพแวดล้อมและหลักฐาน”; `.evidence-flow-panel` named “เส้นทางของหลักฐาน”; `.integration-contracts` named “สัญญาการเชื่อมต่อ”; the named “Integration matrix” panel; then `.overview-support-grid` named “แหล่งข้อมูลและความพร้อมสำหรับ Production”.

Use `safeText` for provider/persistence/mode labels. Set Live merge to `NOT ALLOWED`, `ALLOWED`, or `UNKNOWN`. Derive matrix rows from the three named source IDs and expose `effectiveStatus`, freshness, validation time, contract/mode, and safe adapter alias. Do not use `snapshot.sources.slice(0, 3)`.

For IDEA3, build runtime-mode chips only from `snapshot.runtime.modes.monitorOnly` and `snapshot.runtime.modes.dryRun`, and read physical evidence only from `snapshot.devices?.[0]?.physicalRelayState` with `UNKNOWN` fallback.

- [ ] **Step 6: Add only Overview-scoped layout and responsive CSS**

Replace the old `.domain-grid`, `.pipeline`, and `.overview-grid` rules with selectors rooted in:

```css
.overview-page
.evidence-boundary
.evidence-flow-panel
.evidence-flow
.flow-sources
.flow-source
.flow-stage
.integration-contracts
.integration-contract-grid
.integration-card
.integration-facts
.overview-support-grid
.provenance-list--overview
.readiness-groups
.readiness-ledger--overview
```

Use four boundary columns and a seven-track evidence flow on wide screens. At `max-width: 1120px`, stack the flow and integration cards and reduce the boundary to two columns. At `max-width: 520px`, use one boundary column, stack card facts, and keep statuses text-visible. Preserve existing `.lockdown-grid`, `.runtime-hero`, `.mode-strip`, Dashboard rules, and global control sizes.

- [ ] **Step 7: Run focused Overview and shared-component tests**

Run:

```bash
npm test -- tests/client/corePages.test.jsx tests/client/shell.test.jsx
```

Expected: PASS with all Overview hierarchy, stale-evidence, physical-uncertainty, missing-metadata, Panel-region, and shell-description assertions green.

- [ ] **Step 8: Commit the Overview behavior and styling**

```bash
git add IDEA3-AEGIS_Lockdown/web/tests/client/corePages.test.jsx IDEA3-AEGIS_Lockdown/web/src/components/Panel.jsx IDEA3-AEGIS_Lockdown/web/src/pages/OverviewPage.jsx IDEA3-AEGIS_Lockdown/web/src/styles/app.css
git diff --cached --check
git commit -m "feat(idea3): expose overview integration readiness"
```

### Task 3: Verify regressions, browser behavior, and the exact recovery boundary

**Files:**
- Inspect: all paths changed by Tasks 1–2
- Modify only if a failing test or observed Overview defect requires a scoped fix

**Interfaces:**
- Consumes: the completed Overview UI and the unchanged Demo/Live API behavior.
- Produces: current automated, build, design-detector, browser, and scope evidence for the receipt.

- [ ] **Step 1: Run affected client regressions**

Run:

```bash
cd IDEA3-AEGIS_Lockdown/web
npm test -- tests/client/appLanguage.test.jsx tests/client/dashboardPage.test.jsx tests/client/corePages.test.jsx tests/client/shell.test.jsx
```

Expected: PASS; Dashboard language and mission-control behavior remain unchanged while Overview tests pass.

- [ ] **Step 2: Run the full web suite**

Run:

```bash
npm test
```

Expected: record the real result. Known recovery-source evidence reported 120/127 passing with six server assertions, one missing `server/domain/recovery.js`, and an intermittent Dashboard-language assertion; do not assume those numbers remain current and do not fix unrelated server failures in this task.

- [ ] **Step 3: Build the production bundle**

Run:

```bash
npm run build
```

Expected: Vite build succeeds. Confirm `dist/` remains ignored and unstaged.

- [ ] **Step 4: Run repository UI checks**

From repository root, first follow `.agents/skills/impeccable/SKILL.md` setup, then run the bundled detector on exact task UI paths:

```bash
node .agents/skills/impeccable/scripts/detect.mjs --json IDEA3-AEGIS_Lockdown/web/src/pages/OverviewPage.jsx IDEA3-AEGIS_Lockdown/web/src/components/Panel.jsx IDEA3-AEGIS_Lockdown/web/src/components/AppShell.jsx IDEA3-AEGIS_Lockdown/web/src/styles/app.css
```

Expected: JSON `[]`. If it reports a finding, fix only the scoped Overview cause, add or update the nearest regression, rerun focused tests, and create a focused fix commit.

- [ ] **Step 5: Perform browser QA on the real Overview route**

Start the existing API and Vite commands in separate sessions:

```bash
cd IDEA3-AEGIS_Lockdown/web
npm run dev:server
```

```bash
cd IDEA3-AEGIS_Lockdown/web
npm run dev
```

Open `/security/overview` and verify:

- Demo: provider, memory-only persistence, and no-Live-merge boundary are explicit.
- Live with missing adapters: `NOT_CONFIGURED`/`UNKNOWN`, never healthy fallback.
- Stale evidence: card, matrix, and readiness show `STALE`.
- IDEA3: `MONITOR ONLY`/`DRY RUN` remain distinct from physical `UNKNOWN`.
- Light and dark themes: readable secondary text and status labels.
- 1920×1080, 1440×900, 1366×768 when available, plus one narrow viewport: no page-level horizontal overflow and the flow stacks in reading order.
- Console: no significant error or warning introduced by this task.

Record actual viewport dimensions if the browser cannot reproduce an exact requested size.

- [ ] **Step 6: Prove the scope boundary**

Run from repository root:

```bash
git diff --check origin/feature/aegis-security-ui-redesign...HEAD
git diff --name-status origin/feature/aegis-security-ui-redesign...HEAD
git status --short
```

Expected: only the design/plan documents and intended Overview UI/test paths are present; no Dashboard page, backend, runtime, firmware, infrastructure, generated output, or secret file appears.

### Task 4: Record durable truth and finish the local branch

**Files:**
- Modify: `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md:52-75`
- Create: one `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/YYYY-MM-DD_HHMMSS_music_idea3-overview-ui-pass-01.md`

**Interfaces:**
- Consumes: exact verification output from Task 3 and the final `git diff --name-status` list.
- Produces: one owner-maintained current-state update and one immutable task receipt with `status: partial` while the branch remains local-only.

- [ ] **Step 1: Update the canonical IDEA3 status with verified facts only**

Update the Security Center date and add one implementation bullet covering:

```text
architecture-first Overview: environment/provider/persistence boundary,
validated evidence flow, per-IDEA integration contracts,
freshness-aware matrix, and production-readiness gaps,
without treating runtime ACK or requested mode as physical relay proof
```

Replace stale test/build/browser counts with Task 3’s actual results. Keep live adapters, durable storage, hardware control, and production deployment listed as unproven.

- [ ] **Step 2: Create exactly one immutable receipt**

Run:

```bash
date '+%Y-%m-%d_%H%M%S %Y-%m-%dT%H:%M:%S%:z'
```

Use that output once for the receipt filename and frontmatter date. Copy the headings from `90-Status/logs/_template.md`, then record:

- branch `feat/idea3-overview-ui-pass-01` and `status: partial`;
- observable architecture/readiness outcome;
- every exact changed source, test, spec, plan, canonical-note, and receipt path;
- every Task 3 command and observed pass/fail result;
- `idea3-status.md` as the canonical note updated;
- `None` under shared surfaces and integration requests only if the final diff is entirely within the IDEA3 owned boundary;
- local-only status, stacked dependency, missing nested `doc/Content/*.md`, unproven production/hardware claims, and any full-suite or browser limitations;
- explicit confirmation that no push or Pull Request occurred.

Do not copy the orphan `2026-09-04_003838_music_idea3-overview-ui-pass-01.md`; its old Git-root and test results are historical recovery evidence, not current branch evidence.

- [ ] **Step 3: Run final repository gates**

Run from repository root:

```bash
git status --short
git diff --check
git diff --name-status origin/feature/aegis-security-ui-redesign...HEAD
rg -n '(BEGIN (RSA|OPENSSH|EC) PRIVATE KEY|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9_]{20,}|password\s*=|token\s*=)' IDEA3-AEGIS_Lockdown/web Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3 Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs
```

Run the repository’s collaboration-policy test command discovered from `.github/` or the root package configuration. Record the exact command and result; do not invent a script name.

Expected: no whitespace errors, no secret material in the candidate diff, exactly one new receipt for this task, and no undeclared cross-scope path.

- [ ] **Step 4: Stage only documentation and the receipt, then commit**

```bash
git add Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-09-04_*_music_idea3-overview-ui-pass-01.md
git diff --cached --check
git diff --cached --name-status
git commit -m "docs(idea3): record overview ui pass evidence"
```

- [ ] **Step 5: Verify the local handoff and stop**

Run:

```bash
git status --short --branch
git log --oneline --decorate -6
git diff --name-status origin/feature/aegis-security-ui-redesign...HEAD
```

Expected: clean local branch ahead of the dependency branch, with implementation, tests, design, plan, canonical note, and exactly one receipt represented. Do not run `git push`, `gh pr create`, merge, or force-push.
