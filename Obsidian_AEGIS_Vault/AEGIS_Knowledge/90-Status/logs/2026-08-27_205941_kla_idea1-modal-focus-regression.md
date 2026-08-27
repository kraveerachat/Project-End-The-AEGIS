---
title: Task Receipt — IDEA1 Shared Modal Focus Regression
date: 2026-08-27T20:59:41+07:00
owner: kla
area: idea1
branch: fix/idea1-modal-focus-regression
status: complete
integration-review: yes
edit_policy: append-by-new-file
---

# Task Receipt — IDEA1 Shared Modal Focus Regression

`ROOT_CAUSE_CONFIRMED = YES`

`SHARED_MODAL_FIXED = YES`

`VAULT_TYPING_REGRESSION_TEST = PASS`

`PRODUCTION_CHANGED = NO`

## What changed

- The Private Vault setup modal could not accept normal typing in production.
  After the first character, focus jumped to the top-right ModalClose X and the
  rest of the passphrase never reached the field.
- The root cause was confirmed by instrumenting the shared `Modal` under jsdom
  before any code was changed. Two defects combined:
  1. the single `useEffect` had dependencies `[open, onClose]`. Every screen
     passes `onClose` as an inline arrow (`onClose={() => setModal(null)}`), so
     each controlled-input keystroke re-rendered the owner screen, produced a
     new `onClose` identity, and re-ran the effect; and
  2. that effect focused `querySelector('input, button')`, which returns the
     first match in **document order**. `ModalClose` is rendered before the form
     in every consuming screen, so the close button won both the initial focus
     and every re-render focus.
  The recorded probe output for the unfixed component was
  `after open: BUTTON[aria-label=Close]` and, for each keystroke,
  `[modal effect ran] target = BUTTON` followed by focus returning to that
  button — the exact production symptom.
- The shared `Modal` was fixed rather than special-casing Vault, so every modal
  in IDEA1 Drive benefits:
  - `onClose` is now held in `onCloseRef` and read through it, so Escape, the
    scrim click, and modal lifecycle no longer depend on callback identity;
  - the Escape listener effect depends on `[open]` only;
  - initial focus is a separate effect that also depends on `[open]` only, so it
    runs on the closed→open transition and never on a re-render; and
  - the focus target is chosen in priority order: an explicit
    `[data-modal-autofocus]` element, then the first enabled form control
    (`input`/`select`/`textarea`), and only then a generic control such as the
    close button.
- The Vault key inputs (`#vault-key` for unlock, `#vault-new-key` for setup) are
  now marked `data-modal-autofocus`, so an opening Vault modal puts the caret in
  the passphrase field.
- No timeout-based focus hack was introduced, `ModalClose` remains a real
  `button` with no `tabindex` override, and no focus behaviour was removed.

## Source files changed

- `IDEA1-AEGIS_Drive_LC/src/components/ui.jsx` — shared `Modal`: `onCloseRef`
  for the latest callback, Escape and initial-focus split into two `[open]`
  effects, and a form-control-first initial focus target with an explicit
  `data-modal-autofocus` override.
- `IDEA1-AEGIS_Drive_LC/src/screens/Vault.jsx` — marks the unlock and setup
  vault key inputs as the intended initial focus target. No cryptography, API,
  state, or validation behaviour changed.
- `IDEA1-AEGIS_Drive_LC/tests/modalFocusStability.test.js` — new shared Modal
  focus regression suite (12 tests).
- `IDEA1-AEGIS_Drive_LC/tests/vaultSetupTyping.test.js` — new Vault screen
  regression suite (4 tests) driving the real setup and unlock modals.

## Verification evidence

- `node --test --test-concurrency=1 tests/modalFocusStability.test.js` — pass:
  12 tests, 12 passed, 0 failed.
- `node --test --test-concurrency=1 tests/vaultSetupTyping.test.js` — pass:
  4 tests, 4 passed, 0 failed.
- Regression guard proved against the unfixed component: with only
  `src/components/ui.jsx` reverted, `modalFocusStability` failed 7 of 12 and
  `vaultSetupTyping` failed 2 of 4. Both suites pass with the fix applied.
- `npm test` (IDEA1) — pass: 323 tests, 304 passed, 0 failed, 19 skipped. The
  19 skips are the pre-existing `TEST_DATABASE_URL`-gated Postgres vault tests.
- `npm run build` (IDEA1) — pass: built in 13.39s.
- `node --test tests/vaultStructure.test.mjs tests/vaultMultiWriter.test.mjs tests/collaborationPolicy.test.mjs tests/dockerBootstrap.test.mjs tests/endpointOnboarding.test.mjs` — pass: 53 tests, 53 passed, 0 failed.
- `node scripts/validate-vault.mjs --vault Obsidian_AEGIS_Vault/AEGIS_Knowledge` — pass with the two unchanged owner-review Canvas warnings.
- `node scripts/validate-collaboration-policy.mjs --event <event> --changed-files <delta>` — pass.
- `git diff --check` — pass: no whitespace errors.
- Targeted secret scan over the changed delta — pass: no key material,
  credential assignment, token, password, secret, or API-key value found. The
  only passphrase-shaped literals are test fixtures typed into a jsdom input.

### Regression coverage recorded

- Opening the setup modal focuses `#vault-new-key`, not the close X.
- A full 25-character passphrase reaches the controlled field with
  `document.activeElement` never leaving it.
- A re-render carrying a new inline `onClose` identity does not move focus.
- Escape invokes the current `onClose`, not the one captured when the modal
  opened, and stops firing once the modal is closed.
- The close button still closes the modal, keeps its `button` role, and is not
  removed from the tab order.
- Reopening a modal performs initial focus again.
- A confirm-style modal with no form control still focuses a real control and
  still closes on Escape.
- Disabled form controls are skipped when choosing the initial focus target.

## Canonical notes updated

- `None` — this is a UI defect fix inside the existing IDEA1 boundary. No
  durable implemented, tested, deployed, blocked, or maturity fact in
  `idea1/idea1-status.md` changed, and the task scope explicitly limits
  documentation to one new immutable receipt.

## Shared surfaces touched

- `None` — every changed path is inside `IDEA1-AEGIS_Drive_LC/`. No server API,
  vault cryptography, PostgreSQL, schema, migration, Docker, Compose, systemd,
  gateway, or deployment file was changed.

## Integration requests

- Kla integration review: `src/components/ui.jsx` is the IDEA1-wide shared UI
  module, so the `Modal` change reaches every Drive modal — Files new-folder and
  delete, Shares revoke, Access add-user, File History restore, and both Vault
  modals. Please confirm the new initial-focus order is the intended behaviour
  for confirm-style modals, where focus now lands on the first enabled control
  rather than always on the close X. No migration is required; rollback is a
  revert of this Pull Request, and no production artefact was rebuilt or
  deployed by this task.

## Known limitations

- Verification is automated only. The fix was proven under jsdom with real
  React commit and event handling; it was not re-tested by hand in a browser
  against the deployed Drive, and no production deployment was performed.
- The `Modal` still has no focus trap and does not restore focus to the element
  that opened it. Both were pre-existing gaps and were left unchanged because
  adding them would alter keyboard behaviour beyond this regression's scope.
- The committed `IDEA1-AEGIS_Drive_LC/dist/` build output was deliberately left
  untouched. `npm run build` was run as verification only, and the regenerated
  `dist/index.html` was reverted so this task changes no build artefact.
- The 19 skipped IDEA1 tests require `TEST_DATABASE_URL` and a real Postgres
  instance; they were skipped here exactly as they are on `main`.
