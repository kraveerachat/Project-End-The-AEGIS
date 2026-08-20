# IDEA1 UI Foundation Revision Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist IDEA1 appearance preferences server-side, tighten the application shell, add direct first-value actions, and reduce the initial JavaScript bundle without weakening RBAC or data-honesty rules.

**Architecture:** Extend the existing `users` record and in-memory development user shape with a validated preference object exposed by `/api/me`, login, and a current-user-only PATCH endpoint. Keep authorization and navigation server-owned. Split authenticated screens with `React.lazy`, reuse the existing skeleton/error boundary, and keep all shell changes within IDEA1.

**Tech Stack:** React 19, Vite 7, Express 4, PostgreSQL, Node test runner, Tailwind CSS v4.

**Spec:** `docs/superpowers/specs/2026-08-20-idea1-ui-foundation-revision-design.md`

## Global Constraints

- Never use `localStorage` or `sessionStorage`.
- Theme, language, and density belong to the authenticated user and default to `light`, `th`, and `comfortable`.
- Client requests never select a user id or role; server authorization comes from the session/DB.
- Unauthorized menu entries are filtered before reaching the DOM.
- No telemetry, notification count, or status may be fabricated.
- No production deployment occurs without separate explicit approval.

---

### Task 1: Server-owned appearance preferences

**Files:**
- Modify: `IDEA1-AEGIS_Drive_LC/server/db/schema.sql`
- Create: `IDEA1-AEGIS_Drive_LC/server/db/migrations/002_user_preferences.sql`
- Modify: `IDEA1-AEGIS_Drive_LC/server/db/connection.js`
- Modify: `IDEA1-AEGIS_Drive_LC/server/routes/api.js`
- Test: `IDEA1-AEGIS_Drive_LC/tests/userPreferences.test.js`

**Interfaces:**
- Produces: `normalizeUserPreferences(value) -> { theme, language, density } | null`
- Produces: `updateUserPreferences(userId, preferences) -> normalized preferences | null`
- Produces: `PATCH /api/preferences {theme,language,density}` for the current session user
- Consumed by: login, `/api/me`, and App preference state.

- [ ] Write failing tests for defaults, persistence, invalid values, and rejection of a client-supplied `userId` as an ownership selector.
- [ ] Run `node --test --test-concurrency=1 tests/userPreferences.test.js` and confirm expected failures.
- [ ] Add idempotent user columns with constrained defaults and matching memory-fallback fields.
- [ ] Add a transaction-safe idempotent migration for an already-initialised `aegis_drive` database.
- [ ] Return normalized preferences from public user payloads and add the authenticated PATCH endpoint.
- [ ] Run the focused test and the existing auth/profile suites.

### Task 2: App shell, contextual onboarding, and honest utilities

**Files:**
- Modify: `IDEA1-AEGIS_Drive_LC/src/App.jsx`
- Modify: `IDEA1-AEGIS_Drive_LC/src/components/TopBar.jsx`
- Modify: `IDEA1-AEGIS_Drive_LC/src/components/GlobalSearch.jsx`
- Modify: `IDEA1-AEGIS_Drive_LC/src/screens/Settings.jsx`
- Modify: `IDEA1-AEGIS_Drive_LC/src/screens/Dashboard.jsx`
- Modify: `IDEA1-AEGIS_Drive_LC/src/lib/strings.js`
- Test: `IDEA1-AEGIS_Drive_LC/tests/appShellRevision.test.js`

**Interfaces:**
- Consumes: `/api/preferences` and the `preferences` field from auth payloads.
- Produces: `navigateToSettings(tab)` and page-specific search prompt keys.

- [ ] Write failing tests for absence of browser storage and notification UI, profile/settings/sign-out menu actions, contextual search labels, and dashboard quick actions.
- [ ] Run the focused test and confirm each missing behavior fails.
- [ ] Initialize preferences from the authenticated payload, persist changes inline, and surface save failure without losing current UI state.
- [ ] Add Profile/Settings menu destinations and remove the unwired notification control.
- [ ] Add contextual search copy and existing-route Dashboard quick actions.
- [ ] Run the focused test plus UI negative-state suites.

### Task 3: Route-level bundle optimization and detector cleanup

**Files:**
- Modify: `IDEA1-AEGIS_Drive_LC/src/App.jsx`
- Modify: `IDEA1-AEGIS_Drive_LC/src/screens/Dashboard.jsx`
- Modify: `IDEA1-AEGIS_Drive_LC/src/screens/Login.jsx`
- Modify: `IDEA1-AEGIS_Drive_LC/src/components/ui.jsx`
- Test: `IDEA1-AEGIS_Drive_LC/tests/appShellRevision.test.js`

**Interfaces:**
- Produces: lazy screen modules rendered through one `Suspense` content-skeleton boundary.

- [ ] Extend the focused test to require lazy screen imports and solid heading text.
- [ ] Run the test and confirm it fails against eager imports/gradient text.
- [ ] Convert authenticated screens to `React.lazy`, retaining eager Login/reset gates and authorized screen selection.
- [ ] Replace gradient text with semantic solid ink and make Avatar render fallback-first until a valid image loads.
- [ ] Run focused tests, `npm run build`, and compare output against the 969.77 kB baseline entry bundle.

### Task 4: IDEA1 design-system documentation and audit artifacts

**Files:**
- Create: `IDEA1-AEGIS_Drive_LC/DESIGN.md`
- Create: `IDEA1-AEGIS_Drive_LC/.impeccable/design.json`
- Create: `IDEA1-AEGIS_Drive_LC/docs/ui-audit-2026-08-20.md`
- Create: `.impeccable/critique/<generated snapshot>`

**Interfaces:**
- Consumes: actual `src/index.css` tokens and repeated component patterns.
- Produces: parseable DESIGN.md frontmatter plus six mandated sections and an extension-only sidecar.

- [ ] Extract only reused colors, type, radii, spacing, shadows, motion, and 5–10 canonical components.
- [ ] Document the module with the creative north star “Quiet Control Plane,” preserving Precision Light and hatch semantics.
- [ ] Record baseline/final technical scores, deterministic detector evidence, browser limitation, remaining attachment IDs, and the G-A architecture block.
- [ ] Run the detector and design sidecar JSON parse check.

### Task 5: Full verification, receipt, and PR-ready branch

**Files:**
- Update: `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-status.md` only if a durable tested fact changed.
- Create: `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-08-20_<time>_kla_idea1-ui-foundation-revision.md`

**Interfaces:**
- Produces: one immutable IDEA1 receipt with exact changed paths and command results.

- [ ] Run `npm test`, `npm run build`, detector, `git diff --check`, and collaboration-policy checks applicable to the final diff.
- [ ] Record exact pass/fail/skip counts, bundle sizes, limitations, and all changed paths in one new receipt.
- [ ] Stage only intentional IDEA1/docs/receipt paths, commit, push, and open a Draft PR with the repository template.
