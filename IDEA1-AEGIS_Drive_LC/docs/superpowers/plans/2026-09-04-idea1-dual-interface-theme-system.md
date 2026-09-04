# AEGIS Drive_LC Dual Interface Theme System Implementation Plan

> **For Codex:** Use `superpowers:executing-plans` to execute this plan task by task. Every behavioral task follows `superpowers:test-driven-development` and records the observed RED before production edits.

**Goal:** Deliver an authenticated-only Classic/Neo interface preference, Neo Light/Dark visual system, and save-then-logout switch flow without changing Login or IDEA1 business/security behavior.

**Architecture:** Extend the server-owned appearance preference with `interfaceStyle`, apply it synchronously at the single authenticated-session adoption gate, and skin the authenticated application through semantic root tokens and shared component hooks. Keep style switching transactional: confirmation, successful persistence, then logout; never optimistically apply Neo/Classic.

**Tech Stack:** React 19, Vite 7, Tailwind CSS 4, plain CSS custom properties, Express 4, PostgreSQL, Node test runner, JSDOM.

**Spec:** `IDEA1-AEGIS_Drive_LC/docs/superpowers/specs/2026-09-04-idea1-dual-interface-theme-system-design.md`

**Scope:** area `idea1`, owner `kla`. Intended paths are limited to `IDEA1-AEGIS_Drive_LC/**`, the IDEA1 canonical status note, and one new `kla` receipt. No shared infrastructure path is expected.

**Baseline:** `origin/main` at `9083799`; `npm run build` passes. The unmodified standard test suite emits passing assertions but does not exit after its last test because of an existing open handle. Node 24 `--test-force-exit` triggers unrelated Windows libuv assertions in server tests, so focused test files provide the red/green development gate and the standard suite will be rerun and reported honestly at completion.

---

### Task 1: Add the server-owned interface-style contract

**Files:**
- Modify: `IDEA1-AEGIS_Drive_LC/tests/userPreferences.test.js`
- Modify: `IDEA1-AEGIS_Drive_LC/server/db/connection.js`
- Modify: `IDEA1-AEGIS_Drive_LC/server/routes/api.js`
- Modify: `IDEA1-AEGIS_Drive_LC/server/db/schema.sql`
- Create: `IDEA1-AEGIS_Drive_LC/server/db/migrations/005_interface_style.sql`

1. Add failing API tests proving new accounts return `interfaceStyle: classic`, valid `neo` persists for only the authenticated user, omitted/spoofed identity cannot redirect the write, and invalid style leaves all preferences unchanged.
2. Add a failing migration test proving the additive migration is idempotent and constrains values to `classic|neo` with a `classic` default.
3. Run `node --test tests/userPreferences.test.js` and observe the expected failures.
4. Extend normalization, Postgres row mapping, SELECT/UPDATE statements, memory defaults, API payload handling, schema, and migration with the minimum implementation.
5. Re-run the focused test to green and refactor without changing the contract.

### Task 2: Gate the authenticated shell on the saved style

**Files:**
- Create: `IDEA1-AEGIS_Drive_LC/src/lib/interfaceStyle.js`
- Create: `IDEA1-AEGIS_Drive_LC/tests/interfaceStyleAuthTransition.test.js`
- Modify: `IDEA1-AEGIS_Drive_LC/src/App.jsx`
- Modify: test preference fixtures that model the complete server response.

1. Add behavior tests for strict normalization/default-to-Classic, synchronous root application before shell mount, Neo-to-Neo and Classic-to-Classic login with no wrong-style mutations, independent theme/density combinations, and removal of the authenticated style marker on logout.
2. Assert that Login renders with no authenticated Neo shell hook and receives no interface-style prop or pre-auth storage hint.
3. Run the focused transition test and observe RED.
4. Implement the style helper and call it before `setSession` in the existing authenticated-session adoption gate. Keep Login and `theme-bootstrap.js` unchanged.
5. Add a stable authenticated-shell class/attribute and clear style state when the session is cleared.
6. Re-run focused transition and existing theme-continuity tests to green.

### Task 3: Implement the transactional Settings switch flow

**Files:**
- Create: `IDEA1-AEGIS_Drive_LC/tests/interfaceStyleSwitch.test.js`
- Modify: `IDEA1-AEGIS_Drive_LC/src/App.jsx`
- Modify: `IDEA1-AEGIS_Drive_LC/src/screens/Settings.jsx`
- Modify: `IDEA1-AEGIS_Drive_LC/src/lib/strings.js`

1. Add failing interaction tests proving selecting the other style only opens a labelled confirmation; cancel/Escape preserve the session/style; confirmation PATCHes the full preference first; successful save logs out and clears authenticated UI; failed save never logs out or changes style; selecting the current style is a no-op.
2. Add EN/TH/ZH parity expectations for style labels, preview descriptions, warning, modal copy, and save/logout errors.
3. Run the focused tests and observe RED.
4. Add preview-card radio controls and use the shared Modal for confirmation.
5. Add a dedicated App transaction that does not share optimistic theme/language/density behavior: save, update server-derived preference, logout, then clear transient authenticated state.
6. Re-run focused switch, modal, i18n, and theme tests to green.

### Task 4: Build semantic Neo tokens and shared primitives

**Files:**
- Create: `IDEA1-AEGIS_Drive_LC/tests/neoVisualSystem.test.js`
- Modify: `IDEA1-AEGIS_Drive_LC/src/index.css`
- Modify: `IDEA1-AEGIS_Drive_LC/src/components/ui.jsx`
- Modify: `IDEA1-AEGIS_Drive_LC/src/components/Sidebar.jsx`
- Modify: `IDEA1-AEGIS_Drive_LC/src/components/TopBar.jsx`

1. Add behavior-oriented rendering/style-contract tests for Classic stability, authenticated-only Neo hooks, solid content cards, shell-only glass hooks, semantic token presence, selected capsule navigation, radiogroup semantics, visible focus, 44px mobile targets, and reduced-motion suppression.
2. Run the focused test and observe RED.
3. Add Neo Light/Dark token layers scoped to `data-ui-style="neo"` and the authenticated shell. Map existing semantic variables so all screens inherit the system without hardcoded component colors.
4. Add shared class hooks and Neo geometry for cards, buttons, segmented controls, modal, Sidebar, Topbar, dropdowns, inputs, and tables. Keep data cards solid and glass static at shell-level surfaces only.
5. Add transform/opacity-only interaction transitions and reduced-motion overrides.
6. Re-run the focused visual-system and shared component tests to green.

### Task 5: Apply and verify Neo across every authenticated route

**Files:**
- Modify only route components requiring semantic hooks under `IDEA1-AEGIS_Drive_LC/src/screens/**`
- Modify: `IDEA1-AEGIS_Drive_LC/tests/appShellRevision.test.js`
- Modify: `IDEA1-AEGIS_Drive_LC/tests/allScreensEmptyState.test.js`

1. Add focused route rendering checks that the nine authenticated destinations mount inside the styled shell without changing navigation/RBAC or replacing truthful empty/loading/error states.
2. Observe RED only where a semantic hook is genuinely missing.
3. Add the smallest shared/screen hooks needed; do not duplicate page-specific palettes.
4. Re-run route, RBAC, authorization, audit, storage, backup, and vault regression suites affected by changed markup.

### Task 6: Visual QA, critique, audit, and polish

**Files:**
- Modify implementation files only for verified findings.
- Save screenshots under `IDEA1-AEGIS_Drive_LC/docs/visual-qa/dual-interface-theme-system/`.

1. Start the local IDEA1 client/server with isolated temporary storage and real in-memory accounts.
2. Capture Neo Light/Comfortable and Neo Dark/Compact Settings plus representative Dashboard, Files, Vault, Storage, Audit, and Access views at desktop and mobile widths. Capture Classic after implementation for regression comparison. Do not modify Login.
3. Run the Impeccable critique pass; rank hierarchy, composition, typography, color, states, and motion findings.
4. Run the Impeccable audit pass for accessibility, responsiveness, theme coverage, content overflow, focus, touch targets, and performance.
5. Apply only high-confidence fixes through fresh red/green tests where behavior changes.
6. Run the Impeccable polish and animate checks; confirm no excessive glow, no animated blur/shadow/layout, and reduced-motion parity.

### Task 7: Documentation, receipt, and full verification

**Files:**
- Modify: `IDEA1-AEGIS_Drive_LC/DESIGN.md`
- Modify: `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-status.md`
- Create exactly one: `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-09-04_<HHMMSS>_kla_idea1-dual-interface-theme-system.md`

1. Update the module design contract to distinguish Classic from Neo and state the authenticated-only/Login exclusion.
2. Update the IDEA1 canonical status with the durable tested implementation fact.
3. Create one immutable receipt from the repository template, listing every exact changed source path, verification command/result, visual evidence, limitations, and `Shared surfaces touched: None` if still true.
4. Run focused tests, `npm test`, `npm run build`, `git diff --check`, and repository governance tests. Record the actual standard-suite exit behavior without hiding the baseline leak.
5. Use `superpowers:verification-before-completion`, `superpowers:requesting-code-review`, and the repository review workflow.
6. Stage only intentional paths, commit with `feat(idea1): add dual interface theme system`, push `feat/idea1-dual-interface-theme-system`, and open one PR against `main` using the repository template. Declare dependencies on open PRs #67–#69 as separate/non-copied work, not branch prerequisites.
