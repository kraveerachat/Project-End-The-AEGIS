# AEGIS Drive UI Revision Follow-up Implementation Plan

> **For agentic workers:** Execute inline in the existing isolated worktree. Do not dispatch subagents, commit, push, open a PR, deploy, or modify backend/infrastructure without the owner's later approval.

**Goal:** Add truthful unavailable-state Server Telemetry UI and consolidate Upload into the Files workspace without changing backend, database, production, Docker privileges, nginx, network, or Twingate configuration.

**Architecture:** Keep the existing React screen-state shell and server-filtered RBAC menu. Add a frontend navigation-intent adapter that removes only the redundant Upload destination after RBAC, normalizes legacy upload intents to Files, and carries safe selected-file IDs between existing screens. Extract upload state and interaction into a Files-owned drawer, and render telemetry from a prop-driven contract whose absent source resolves to explicit unavailable states.

**Tech Stack:** React 19, Vite 7, Tailwind CSS 4 utilities, Lucide React, Node test runner, jsdom.

**Spec:** `IDEA1-AEGIS_Drive_LC/DESIGN.md` plus the owner-approved “AEGIS Drive_LC — UI Revision Follow-up” prompt in this task.

## Global Constraints

- Frontend UI/UX only; do not modify `server/**`, PostgreSQL, production data, deployment, Docker privileges, nginx, firewall, network, or Twingate configuration.
- Do not fabricate telemetry values or render numeric zeroes as measurements when no source exists.
- Preserve existing APIs, server-side RBAC, Data Lake Health, Private Vault security language, and existing redesigned page structures.
- Main navigation shows nine destinations; Upload remains a workflow inside Files.
- No commit, push, PR, merge, or production deployment before explicit owner approval.

---

### Task 1: Frontend navigation intent and nine-item navigation

**Files:**
- Create: `src/lib/navigationIntent.js`
- Modify: `src/App.jsx`
- Test: `tests/navigationIntent.test.js`

**Interfaces:**
- Produces: `normalizeNavigationIntent(destination, params)` returning `{ screen, params }`.
- Produces: `readLocationIntent(pathname, search, basePath)` returning a normalized intent.
- Produces: `visiblePrimaryNav(serverNav)` filtering only the redundant `uploads` destination after server RBAC.

- [ ] Write failing behavior tests for legacy upload intent, direct `/upload` paths, normal screen navigation, query preservation, and Upload menu filtering.
- [ ] Run `node --test tests/navigationIntent.test.js` and confirm failure because the module is missing.
- [ ] Implement the pure navigation functions.
- [ ] Run the focused test and confirm pass.
- [ ] Integrate one `navigate()` function into `App.jsx`, pass filtered navigation to Sidebar/GlobalSearch, and carry safe navigation params.
- [ ] Extend the focused test through SSR/jsdom to confirm Dashboard Upload opens Files with the drawer requested.

### Task 2: Truthful Server Telemetry section

**Files:**
- Create: `src/components/ServerTelemetry.jsx`
- Modify: `src/screens/Dashboard.jsx`
- Modify: `src/lib/strings.js`
- Test: `tests/serverTelemetryUi.test.js`

**Interfaces:**
- Consumes: `{ cpu, memory, disk, network, twingate, uptime }` data prop.
- Each metric supports `loading | available | warning | critical | unavailable`.
- Missing metric values render text-only unavailable state and never `0`, `0 ms`, `0 °C`, or `0 Mbps`.

- [ ] Write failing render tests for six cards, unavailable copy, accessible status text, and absence of fake numeric values.
- [ ] Run the focused test and confirm the expected missing-component failure.
- [ ] Implement the six compact AEGIS cards with 3/2/1-column responsive layout and hatch only for unmeasured values.
- [ ] Insert the section adjacent to, but not replacing, Data Lake Health.
- [ ] Run focused tests and verify green.

### Task 3: Reusable upload drawer and real queue states

**Files:**
- Create: `src/components/UploadDrawer.jsx`
- Modify: `src/screens/Uploads.jsx`
- Modify: `src/lib/strings.js`
- Test: `tests/uploadDrawerUi.test.js`
- Test: `tests/uploadProgress.test.js`

**Interfaces:**
- Consumes: `open`, `onClose`, `destination`, `onUploaded`.
- Queue states: `waiting`, `processing`, `uploading`, `complete`, `failed`, `cancelled`.
- Uses existing `apiUpload(..., { signal, onProgress })`; stores the selected `File` in memory only for retry during the current session.

- [ ] Write failing tests for destination label, queue state text, Cancel/Retry/Dismiss controls, and measured progress only.
- [ ] Run focused tests and verify RED.
- [ ] Extract hashing/upload behavior from the standalone Upload screen into the drawer.
- [ ] Wire AbortController cancellation, local retry, dismiss, and cancel-all without adding backend behavior.
- [ ] Move Recent Uploads into a collapsible recently-completed region in the drawer.
- [ ] Run focused tests and verify GREEN.

### Task 4: Files becomes the single upload workspace

**Files:**
- Modify: `src/screens/Files.jsx`
- Modify: `src/lib/strings.js`
- Test: `tests/filesWorkspaceUi.test.js`

**Interfaces:**
- Consumes: `navigationParams.uploadOpen`, `navigationParams.fileId`, and the shared `navigate()` callback.
- Opens `UploadDrawer` from toolbar Upload, drag/drop over the explorer, or legacy navigation intent.

- [ ] Write failing tests for toolbar upload, drop target, local search, filter, visible `/Files` destination, mobile overflow controls, and no separate Upload navigation.
- [ ] Run focused tests and verify RED.
- [ ] Add the drawer, drop handling, local search/filter, and responsive toolbar to the existing explorer without replacing its grid/list or metadata drawer.
- [ ] Keep New Folder and current file actions intact.
- [ ] Run focused tests and verify GREEN.

### Task 5: Safe file cross-navigation

**Files:**
- Modify: `src/screens/Files.jsx`
- Modify: `src/screens/Shares.jsx`
- Modify: `src/screens/FileHistory.jsx`
- Modify: `src/App.jsx`
- Test: `tests/fileCrossNavigation.test.js`

**Interfaces:**
- `navigate('shares', { fileId })` preselects an existing non-vault file.
- `navigate('versions', { fileId })` selects the existing file in File History.
- Rename, Move, and Move to Private Vault remain unwired/omitted because no compatible backend operation exists.

- [ ] Write failing tests for selected-file ID propagation and fallback when the ID is missing.
- [ ] Run focused tests and verify RED.
- [ ] Implement state/query handoff without changing API contracts.
- [ ] Run focused tests and verify GREEN.

### Task 6: Dependency unavailable is not empty data

**Files:**
- Modify: `src/components/ui.jsx`
- Modify: `src/screens/Dashboard.jsx`
- Modify: `src/screens/Files.jsx`
- Modify: `src/screens/Shares.jsx`
- Modify: `src/screens/FileHistory.jsx`
- Modify: `src/screens/Audit.jsx`
- Modify: `src/screens/Access.jsx`
- Modify: `src/lib/strings.js`
- Modify: `tests/allScreensEmptyState.test.js`

**Interfaces:**
- Produces: `DependencyUnavailableState({ title, detail, compact })` with `role="status"` and hatch/unavailable semantics.
- `placeholderMode === true` renders dependency-unavailable copy; a connected service returning an empty collection retains the existing empty state.

- [ ] Update tests first to require visibly distinct unavailable and empty states on all six specified screens plus Dashboard.
- [ ] Run the focused test and verify RED against the current empty-state behavior.
- [ ] Add the reusable state component and integrate it without replacing each screen's surrounding controls/chrome.
- [ ] Run focused tests and verify GREEN.

### Task 7: Responsive, accessibility, regression, and live verification

**Files:**
- Modify only affected frontend files when verification exposes a concrete defect.

- [ ] Run all focused UI tests.
- [ ] Run `npm test` and record pass/fail/skip counts.
- [ ] Run `npm run build` and confirm no build failure or oversized main-chunk regression.
- [ ] Run the Impeccable detector on changed UI files and classify each finding.
- [ ] Start the real Vite/Express development surface from this worktree.
- [ ] Inspect Dashboard and Files at 1440, 1024, 768, and 375–430 px when browser tooling is available; otherwise report the exact tooling limitation and provide the live URL for owner inspection.
- [ ] Verify keyboard focus, drawer close behavior, text status independent of color, and no horizontal overflow.
- [ ] Stop before commit/push/PR and present CHANGED / UNCHANGED / BLOCKED / NEEDS BACKEND to the owner.
