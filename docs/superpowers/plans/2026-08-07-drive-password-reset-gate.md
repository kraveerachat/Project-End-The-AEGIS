# AEGIS Drive Mandatory Password Reset Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Treat `PASSWORD_RESET_REQUIRED` as a first-class client state, block the Drive shell and all protected reads until reset succeeds, then unlock without a page reload.

**Architecture:** `apiFetch` preserves the server error code. `App` derives one `dataAccessReady` boolean from the in-memory session and passes `null` to every App-level data hook while reset is required. A focused full-screen `MandatoryPasswordReset` component calls the existing endpoint and reports success upward so `App` clears only the in-memory flag.

**Tech Stack:** React 19, Vite 7, Node test runner, jsdom, existing AEGIS Drive UI components and i18n.

## Global Constraints

- Do not change `src/lib/fetchState.js` or `src/lib/dashboardState.js`.
- Do not create a backend endpoint or weaken `requireAuth`/`requireRole`.
- Password fields remain React component state only; no browser storage.
- Add Thai comments above the security component, submit handler, and App hook gate.
- Keep the reset gate full-screen: no Sidebar, TopBar, GlobalSearch, or protected screen mounts.
- Mock HTTP in UI tests; never point this test at live PostgreSQL.

---

### Task 1: Lock the API and App contracts with failing tests

**Files:**
- Create: `IDEA1-AEGIS_Drive_LC/tests/passwordResetGate.test.js`

**Interfaces:**
- Consumes: `apiFetch(path, options)` and the default `App` component.
- Produces: regression coverage for `errorCode`, reset-only rendering, paused protected calls, post-reset unlock, and the normal-user bypass.

- [ ] Write a direct `apiFetch` test whose mocked 403 body is `{ error: 'PASSWORD_RESET_REQUIRED' }` and expect `errorKind === 'password-reset-required'` plus `errorCode === 'PASSWORD_RESET_REQUIRED'`.
- [ ] Render the real `App` in jsdom with `/api/me` returning `mustResetPassword: true`; assert the reset form is visible and Dashboard/Files/Storage/Users endpoints have not been requested.
- [ ] Fill the three fields, submit a mocked successful `/api/password/reset`, and assert the shell appears and protected reads begin.
- [ ] Render with `mustResetPassword: false` and assert the normal shell appears without the reset form.
- [ ] Run `node --test --test-concurrency=1 tests/passwordResetGate.test.js`; expect failures caused by the missing first-class error and missing reset screen.

### Task 2: Preserve the server reset code and build the gate screen

**Files:**
- Modify: `IDEA1-AEGIS_Drive_LC/src/lib/api.js`
- Create: `IDEA1-AEGIS_Drive_LC/src/screens/MandatoryPasswordReset.jsx`
- Modify: `IDEA1-AEGIS_Drive_LC/src/lib/strings.js`

**Interfaces:**
- Produces: failed API result `{ ok: false, status: 403, data, errorKind: 'password-reset-required', errorCode: 'PASSWORD_RESET_REQUIRED' }` and component `MandatoryPasswordReset({ t, user, onReset, onSignOut })`.

- [ ] Add the smallest 403 branch that preserves `PASSWORD_RESET_REQUIRED` before generic Forbidden handling.
- [ ] Build a full-screen form with current/new/confirm password inputs, client-side confirmation mismatch feedback, server-aligned wrong-current/weak/general messages, and one logout action.
- [ ] Submit `{ currentPassword, newPassword }` to the existing `/api/password/reset`; clear all password state on success before invoking `onReset()`.
- [ ] Add TH/EN/ZH strings for labels, policy, mismatch, busy state, and security explanation.
- [ ] Run the focused test and resolve only API/component failures.

### Task 3: Gate App hooks and unlock the shell

**Files:**
- Modify: `IDEA1-AEGIS_Drive_LC/src/App.jsx`

**Interfaces:**
- Consumes: `MandatoryPasswordReset` callbacks.
- Produces: `dataAccessReady` as the sole permission for App-level Dashboard, health, Files, and Users hooks.

- [ ] Derive `dataAccessReady = Boolean(session && !session.mustResetPassword)` and pass `null` to every App-level fetch path until true.
- [ ] Return `MandatoryPasswordReset` after auth resolution/login handling but before the normal shell and screen tree.
- [ ] On reset success, update only the in-memory session to `mustResetPassword: false`; React then starts the paused hooks naturally.
- [ ] On logout, call the existing server logout and clear the session.
- [ ] Run the focused test until all reset and normal-session cases pass.

### Task 4: Verify and document

**Files:**
- Modify in place: relevant files under `Obsidian_AEGIS_Vault/AEGIS_Knowledge`

- [ ] Run `npm test` and confirm the new total, zero failures, and the existing empty-state/error-gating suites remain green.
- [ ] Run `npm run build`.
- [ ] Rebuild/restart only the Drive service if runtime verification is possible, then confirm first-login reset → shell unlock through `/drive/` without a protected-request storm.
- [ ] Update the IDEA1 module note, system overview, outstanding-items status, summary, and `log.md` without creating duplicate notes.
