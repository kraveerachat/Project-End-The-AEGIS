# IDEA3 Dashboard Trilingual UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a Thai-first Dashboard that switches completely among Thai, English, and Simplified Chinese while preserving raw evidence, security semantics, and every non-Dashboard page.

**Architecture:** `App.jsx` owns an allowlisted persisted language preference and passes it into a Dashboard-only shell control and `DashboardPage`. A new flat dictionary module translates presentation copy and status labels; the existing Dashboard selectors continue deriving raw facts, and shared components accept optional localized display labels while keeping their current defaults for all other pages.

**Tech Stack:** React 19, Vite 7, Vitest 3, Testing Library, Intl APIs, CSS design tokens.

**Spec:** `IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-09-03-idea3-dashboard-trilingual-design.md`

## Global Constraints

- Work only on `feature/aegis-security-ui-redesign`; do not create a Pull Request or merge into `main`.
- Translate and reduce copy only for Dashboard at `/security/` and `/security/dashboard`.
- Preserve raw API values, evidence selectors, RBAC, session, CSRF, routes, and backend contracts.
- Keep `IDEA1`, `IDEA2`, `IDEA3`, `AEGIS`, `MQTT`, `ACK`, `IP`, `API`, `RBAC`, and `ESP32` unchanged.
- Thai is the default; persistence uses the allowlisted `aegis_lang` values `th`, `en`, and `zh`.
- Shared component changes must be optional and backward compatible for non-Dashboard callers.
- Preserve unrelated working-tree changes and stage exact files/hunks only.
- Use one final Dashboard-specific implementation commit after verification, then stop.

---

### Task 1: Translation and locale foundation

**Files:**
- Create: `IDEA3-AEGIS_Lockdown/web/src/lib/i18n.js`
- Create: `IDEA3-AEGIS_Lockdown/web/tests/client/i18n.test.js`
- Modify: `IDEA3-AEGIS_Lockdown/web/src/lib/format.js`

**Interfaces:**
- Produces: `LANGS`, `LANGUAGE_OPTIONS`, `STRINGS`, `normalizeLanguage(value)`, `htmlLanguage(lang)`, `localeFor(lang)`, `makeT(lang)`, and `statusLabel(status, lang)`.
- Produces: `formatDateTime(value, lang = 'th')`, `formatCount(value, lang = 'th')`, and `formatEvidenceAge(ageMs, lang = 'th')`.
- Translation keys are flat and identical across all three dictionaries.

- [ ] **Step 1: Write failing dictionary and formatter tests**

Add tests with literal expectations that prove invalid languages fall back to Thai, dictionaries have identical key sets, interpolation works, canonical statuses localize, and dates/counts/relative ages use each locale:

```js
expect(normalizeLanguage('fr')).toBe('th')
expect(Object.keys(STRINGS.en).sort()).toEqual(Object.keys(STRINGS.th).sort())
expect(Object.keys(STRINGS.zh).sort()).toEqual(Object.keys(STRINGS.th).sort())
expect(statusLabel('CONNECTED', 'th')).toBe('เชื่อมต่อแล้ว')
expect(statusLabel('CONNECTED', 'en')).toBe('Connected')
expect(statusLabel('CONNECTED', 'zh')).toBe('已连接')
expect(makeT('zh')('count.items', { count: 3 })).toBe('3 项')
expect(formatEvidenceAge(65_000, 'en')).toBe('1 minute 5 seconds ago')
expect(formatEvidenceAge(65_000, 'zh')).toBe('1 分钟 5 秒前')
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm test -- tests/client/i18n.test.js`

Expected: FAIL because `src/lib/i18n.js` does not exist and formatters do not accept language-specific output.

- [ ] **Step 3: Implement the minimal translation module and locale-aware formatters**

Use allowlisted lookup and bounded token interpolation:

```js
export const LANGS = Object.freeze(['th', 'en', 'zh'])

export function normalizeLanguage(value) {
  return LANGS.includes(value) ? value : 'th'
}

export function makeT(language) {
  const table = STRINGS[normalizeLanguage(language)]
  return (key, variables = {}) => {
    if (!Object.hasOwn(table, key)) return key
    return Object.entries(variables).reduce(
      (copy, [name, value]) => copy.replaceAll(`{${name}}`, String(value)),
      table[key],
    )
  }
}
```

Create memoized `Intl.DateTimeFormat` and `Intl.NumberFormat` instances for `th-TH`, `en-US`, and `zh-CN`. Relative-time branches must use translated literals rather than browser-dependent `Intl.RelativeTimeFormat` phrasing so tests and UI remain stable.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `npm test -- tests/client/i18n.test.js`

Expected: PASS with dictionary parity, fallback, status, interpolation, and locale formatting covered.

### Task 2: Dashboard-only language state and shell control

**Files:**
- Modify: `IDEA3-AEGIS_Lockdown/web/src/App.jsx`
- Modify: `IDEA3-AEGIS_Lockdown/web/src/components/AppShell.jsx`
- Modify: `IDEA3-AEGIS_Lockdown/web/src/components/DemoBanner.jsx`
- Modify: `IDEA3-AEGIS_Lockdown/web/src/components/EvidenceState.jsx`
- Modify: `IDEA3-AEGIS_Lockdown/web/src/styles/app.css`
- Create: `IDEA3-AEGIS_Lockdown/web/tests/client/appLanguage.test.jsx`
- Modify: `IDEA3-AEGIS_Lockdown/web/tests/client/shell.test.jsx`

**Interfaces:**
- `AppShell` consumes optional `language = 'th'` and `onLanguageChange` props and resolves its Dashboard-only copy through `makeT(language)`.
- The selector renders only when `currentRoute === 'dashboard'` and calls `onLanguageChange('th' | 'en' | 'zh')`.
- `DemoBanner` and `EvidenceState` consume optional `language = 'th'` and retain existing Thai defaults.

- [ ] **Step 1: Write failing shell behavior tests**

Test the real `AppShell` in Dashboard and non-Dashboard routes:

```jsx
render(<AppShell currentRoute="dashboard" language="th" onLanguageChange={change} {...requiredProps}><p>Page</p></AppShell>)
fireEvent.click(screen.getByRole('radio', { name: 'EN' }))
expect(change).toHaveBeenCalledWith('en')
expect(screen.getByRole('radiogroup', { name: 'ภาษา' })).toBeVisible()

rerender(<AppShell currentRoute="overview" language="en" {...requiredProps}><p>Page</p></AppShell>)
expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument()
```

Also prove English and Chinese Dashboard shell copy/date locale can be supplied without changing the sidebar destinations or non-Dashboard defaults.

Add an App integration test with only the HTTP boundary mocked. Return complete
session, CSRF, and snapshot fixtures; assert that `aegis_lang=en` initializes an
English Dashboard, selecting Chinese writes `aegis_lang=zh`, updates `<html
lang="zh-CN">`, and re-renders Chinese without an API refetch.

- [ ] **Step 2: Run shell tests and verify RED**

Run: `npm test -- tests/client/shell.test.jsx`

Expected: FAIL because no language radio group or optional localized shell copy exists.

- [ ] **Step 3: Implement persisted language state in App**

Initialize safely from local storage:

```js
function initialLanguage() {
  try { return normalizeLanguage(localStorage.getItem('aegis_lang')) }
  catch { return 'th' }
}
```

On change, validate the value, update state, attempt to persist it, and set
`document.documentElement.lang` to `th`, `en`, or `zh-CN`. Pass language only to
the Dashboard rendering path and pass localized wrapper copy only when the
current route is Dashboard. Mark untranslated sidebar/non-Dashboard containers
with `lang="th"` so assistive technology receives the correct language.

- [ ] **Step 4: Implement the accessible segmented control**

Render three native buttons with `role="radio"`, `aria-checked`, stable visible
labels `ไทย`, `EN`, and `中文`, and an accessible group label from the active
Dashboard dictionary. Add restrained token-based CSS with a 44 px minimum touch
target, visible focus, selected shape/fill, no flag icons, and no new motion.

- [ ] **Step 5: Localize Dashboard wrapper states without changing other pages**

Pass the Dashboard language into `DemoBanner` and `EvidenceState`; each resolves
copy locally through `makeT`. Their no-prop behavior must remain byte-for-byte
equivalent at the UI level for existing callers and tests.

- [ ] **Step 6: Run shell and affected wrapper tests and verify GREEN**

Run: `npm test -- tests/client/appLanguage.test.jsx tests/client/shell.test.jsx tests/client/corePages.test.jsx`

Expected: PASS; selector is Dashboard-only and existing Demo/stale behavior remains.

### Task 3: Fully localized, lower-density Dashboard

**Files:**
- Modify: `IDEA3-AEGIS_Lockdown/web/src/components/MetricCard.jsx`
- Modify: `IDEA3-AEGIS_Lockdown/web/src/components/StatusBadge.jsx`
- Modify: `IDEA3-AEGIS_Lockdown/web/src/lib/dashboard.js`
- Modify: `IDEA3-AEGIS_Lockdown/web/src/pages/DashboardPage.jsx`
- Modify: `IDEA3-AEGIS_Lockdown/web/src/styles/app.css`
- Modify: `IDEA3-AEGIS_Lockdown/web/tests/client/dashboardPage.test.jsx`

**Interfaces:**
- `DashboardPage` consumes `language = 'th'` and creates `t = makeT(language)`.
- `StatusBadge` consumes optional `label` and `ariaLabel`; raw `status` still selects semantics.
- `MetricCard` forwards optional `statusLabel` and `statusAriaLabel`.
- `dashboardIssues` returns semantic `messageKey`, `detailKey`, and `variables`, never localized copy.
- `recommendedActions` returns an `actionKey` and variables, never localized copy.

- [ ] **Step 1: Write failing Dashboard language tests**

Add one parameterized test per language that renders the real Dashboard with the
same fixture and asserts literal, user-visible outcomes:

```jsx
render(<DashboardPage snapshot={snapshot} apiConnected={false} language="th" />)
expect(screen.getByText('เชื่อมต่อแล้ว')).toBeVisible()
expect(screen.queryByText('CONNECTED')).not.toBeInTheDocument()

render(<DashboardPage snapshot={snapshot} language="en" />)
expect(screen.getByRole('region', { name: 'System status' })).toBeVisible()
expect(screen.getByText('Not verified')).toBeVisible()

render(<DashboardPage snapshot={snapshot} language="zh" />)
expect(screen.getByRole('region', { name: '系统状态' })).toBeVisible()
expect(screen.getByText('未验证')).toBeVisible()
```

Cover statuses, source table headings, empty incident state, actions, issue copy,
Demo/Live wording, runtime modes, hardware/relay values, and relative time. Keep
navigation callback tests to prove translation does not change route IDs.

- [ ] **Step 2: Run Dashboard tests and verify RED**

Run: `npm test -- tests/client/dashboardPage.test.jsx`

Expected: FAIL because Dashboard ignores `language` and displays mixed Thai/English copy.

- [ ] **Step 3: Separate semantic state from localized display**

Change Dashboard issue selectors to emit stable keys and variables. Keep
`status`, `component`, and `route` unchanged. Translate keys only inside
`DashboardPage`. Runtime modes and evidence value labels use translation maps,
while IDs, IPs, incident IDs, and source names stay unchanged.

- [ ] **Step 4: Add backward-compatible localized badges and metrics**

Use raw status for icon/class and optional copy only for presentation:

```jsx
export function StatusBadge({ status = 'UNKNOWN', compact = false, label, ariaLabel }) {
  const safeStatus = icons[status] ? status : 'UNKNOWN'
  const displayLabel = label || safeStatus
  return <span className={`status status--${safeStatus.toLowerCase()}`} aria-label={ariaLabel || `สถานะ ${displayLabel}`}>…</span>
}
```

Existing non-Dashboard callers continue showing canonical raw labels.

- [ ] **Step 5: Translate Dashboard copy and reduce repetition**

Route every human-facing Dashboard string through `t()`. Keep the section order
and evidence boundaries, but apply the approved density rules: one Mission
Control purpose line, at most one detail line per fact/metric, shorter adapter
and action descriptions, no repeated healthy explanation, and no duplicate
incident title. Do not remove Demo/Live, API, freshness, requested state, ACK,
physical relay, hardware availability, or unverified facts.

- [ ] **Step 6: Tune only Dashboard/selector CSS**

Adjust existing Dashboard typography and spacing only where translated strings
need room. Preserve current tokens, 12–16 px surface radii, responsive structure,
dark/light parity, and internal table scrolling. Add `:lang(zh)` rules only to
remove inappropriate tracked-uppercase styling from Chinese UI copy.

- [ ] **Step 7: Run focused Dashboard tests and verify GREEN**

Run: `npm test -- tests/client/i18n.test.js tests/client/appLanguage.test.jsx tests/client/dashboardPage.test.jsx tests/client/shell.test.jsx tests/client/corePages.test.jsx`

Expected: PASS with no React warnings or Testing Library ambiguity failures.

### Task 4: Full validation, receipt, and one final commit

**Files:**
- Create at completion: `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/YYYY-MM-DD_HHMMSS_music_idea3-dashboard-trilingual-ui.md`, replacing the date/time pattern with the actual Asia/Bangkok completion timestamp.
- Include: this plan and every intentional source/test path from Tasks 1–3.

**Interfaces:**
- Produces one immutable receipt with exact commands/results, changed paths, no shared surfaces, and honest limitations.
- Produces one final Dashboard-specific implementation commit on the existing branch.

- [ ] **Step 1: Run affected and full verification**

Run from `IDEA3-AEGIS_Lockdown/web/`:

```bash
npm test -- tests/client/i18n.test.js tests/client/dashboardPage.test.jsx tests/client/shell.test.jsx tests/client/corePages.test.jsx
npm test
npm run build
```

Record exact pass/fail counts. Pre-existing unrelated failures must be named as limitations and must not be represented as passing.

- [ ] **Step 2: Validate the running Dashboard in the browser**

Authenticate through the existing local API, switch all three languages without
reload, reload to confirm persistence, and inspect light/dark themes. Capture
normal and stale/disconnected evidence behavior. Check 1920×1080, 1440×900,
1366×768, and one narrow mobile viewport for overflow, clipping, focus, and
console warnings/errors.

- [ ] **Step 3: Inspect exact scope and create the receipt**

Run:

```bash
git status --short
git diff --check
git diff --name-status HEAD
```

Write one new Music-owned receipt. Declare `None` for shared surfaces only if
every changed path remains inside IDEA3. Do not edit the prior Dashboard receipt.

- [ ] **Step 4: Stage exact intentional paths and verify the index**

Use exact-path staging plus patch staging for files containing unrelated user
changes. Then run:

```bash
git diff --cached --check
git diff --cached --name-status
git diff --cached
```

The staged diff must contain no backend hardening work, no modified prior
receipt, no `.agents`/`.codex` paths, and no other page redesign.

- [ ] **Step 5: Create and push the final implementation commit**

```bash
git commit -m "feat(idea3): add trilingual security dashboard"
git push https://github.com/kraveerachat/Project-End-The-AEGIS.git feature/aegis-security-ui-redesign
```

Stop after the push. Do not create a Pull Request and do not merge.
