---
title: Task Receipt — IDEA1 PUBLIC-SHARE-4 gated public share UI
date: 2026-09-08T15:40:42+07:00
owner: kla
area: idea1
branch: feat/idea1-public-share-ui
status: complete
integration-review: yes
edit_policy: append-by-new-file
---

# Task Receipt — IDEA1 PUBLIC-SHARE-4 gated public share UI

## What changed

- The Shares screen can now offer **Public Internet** as a third network scope,
  but only when a server-owned capability says so. Security invariant 20 is
  preserved rather than traded away: the interface *supports* `public`, and the
  deployment decides whether it is *offered*.
- Added one optional, non-secret deployment variable `PUBLIC_SHARE_UI_ENABLED`,
  parsed once at boot beside the existing public-share configuration. Absent or
  empty is false; anything that is not exactly `true` or `false` **fails the
  boot** rather than being coerced. Public is selectable only when all three of
  `PUBLIC_SHARE_BASE_URL`, `PUBLIC_SHARE_GATEWAY_CIDR` and this flag are set,
  and every one of them defaults to off.
- `GET /api/shares` gained an additive `capabilities: { publicSelectable }`
  object carrying exactly one coarse boolean. The public origin, pinned gateway
  identity, dedicated Docker subnet, real public hostname and the G4 ingress
  choice are never sent to the client. Unknown, missing, non-boolean and failed
  reads all mean unavailable, so the screen fails toward the safe answer.
- **The flag is not authorization.** `POST /api/shares` still decides for
  itself, from `PUBLIC_SHARE_BASE_URL` alone, whether a `scope=public` share may
  be minted. A test proves the outcome is byte-identical with the flag on and
  off, so a UI switch can never quietly become an access-control switch.
- With the capability **off** (the default everywhere) the screen shows two
  interactive scopes and keeps Public Internet as a read-only unavailable fact.
  The stale copy claiming a separate gateway "would be required" was replaced
  with the truthful "not enabled on this deployment", in all three languages.
- With the capability **on** the screen offers three scopes, with
  public-specific risk copy that is not reused from `any`, a **mandatory link
  password** at the existing 8-character backend minimum (not a raised one), and
  a transient **1h** public expiry default that the user may still widen.
- Private auth and expiry are held in separate state and restored intact when
  switching back from public. Nothing about a one-off public selection is
  written to the account; `users.share_default_scope` stays `any | zones`.
- The public URL is the backend `publicUrl` verbatim. It is never derived from
  `window.location`, the `Host` header, `apiUrl(path)` or a hard-coded domain,
  and a successful public response without a non-empty `publicUrl` **fails
  closed**: no link is shown at all, rather than the internal path being handed
  to an external recipient.
- The active-links table gained a real `public` chip. Previously a public row
  would have fallen through `?? SCOPE_CHIP.any` and been labelled
  AEGIS-REACHABLE, which would have reported the wrong scope for the most
  sensitive link on the screen. The scope filter can now select public rows.
- No gateway source, migration, database schema, Production configuration or
  Production activation was touched.

### PR #102 review amendment (2026-09-08)

- **Integration review APPROVED** `PUBLIC_SHARE_UI_ENABLED`, the exact
  `true`/`false` parser, boot failure on a malformed value, absent/false meaning
  unavailable, the additive `GET /api/shares` `capabilities.publicSelectable`
  boolean with no extra deployment detail, no new capability endpoint, and
  `POST /api/shares` authorization unchanged. The three-way effective selector
  was accepted as delivered. G4/G5/G6 remain open; Production activation stays
  off.
- **Acceptance gap closed — the created-link confirmation now shows the
  expiry.** The panel already showed the URL, the Public Internet indication,
  the password-protected state and the one-time-copy warning, but not the
  expiry of the link that was actually issued. The pre-create selector is not
  the same fact: the form can still be edited after creation, while the issued
  link cannot change.
- The confirmation reads `res.data.share.expiresAt` — the stored result — for
  **both** public and private creation, and renders it with the existing
  `fmtCountdown` and `colExpiresIn`, so no new string was needed and EN/TH/ZH
  parity is automatic. It is never reconstructed from form state,
  `publicExpiry`, `privateExpiry`, or client wall-clock plus a selected
  duration. No server contract changed; the field was already returned.
- The plaintext password is still never displayed, and the missing-`publicUrl`
  fail-closed path is unchanged.

## Source files changed

- `IDEA1-AEGIS_Drive_LC/server/config/publicShare.js` — adds `parsePublicShareUiEnabled` (strict `true`/`false`, boot-fail otherwise) and the frozen `publicShareUiEnabled` / `publicSelectable` facts.
- `IDEA1-AEGIS_Drive_LC/server/routes/api.js` — `GET /api/shares` additively returns the coarse `capabilities.publicSelectable` boolean, read from the boot-frozen config rather than `process.env`.
- `IDEA1-AEGIS_Drive_LC/.env.example` — documents the new variable commented out and default-off, with the "do not enable before G6 / PUBLIC-SHARE-7 acceptance" warning.
- `IDEA1-AEGIS_Drive_LC/src/screens/Shares.jsx` — server-owned capability read, conditional third scope option, public scope panel, forced password for public, split private/public auth and expiry state, backend-owned public URL with fail-closed handling, public chip and scope filter, and (PR #102 amendment) the created-link confirmation expiry read from `res.data.share.expiresAt` for both public and private links.
- `IDEA1-AEGIS_Drive_LC/src/lib/strings.js` — EN/TH/ZH copy for the public scope, its risk panel, the password rule, the public chip, the fail-closed message and the created-link note; replaces the stale unavailability wording in `publicShareBody`, `scopeAnyBody` and `newShareSub`.
- `IDEA1-AEGIS_Drive_LC/tests/shareScopeTruthUi.test.js` — rewritten from the obsolete "only zones and any exist" claim into the two-state UI matrix, driven through the real component in jsdom.
- `IDEA1-AEGIS_Drive_LC/tests/fixtures/publicShareUiApi.js` — **new**: records what the screen actually POSTs, so the URL-ownership and password assertions test the composed request rather than a copy of the UI's own logic; also publishes the frozen clock and two deterministic server expiries (`now + 2d 5h`, `now + 3h`) so the confirmation countdown can be asserted exactly.
- `IDEA1-AEGIS_Drive_LC/tests/publicShareConfig.test.js` — adds the `PUBLIC_SHARE_UI_ENABLED` parsing matrix and the effective-selector matrix.
- `IDEA1-AEGIS_Drive_LC/tests/publicShareBackend.test.js` — adds the coarse capability shape, its authentication, and proof that the flag does not change what `POST /api/shares` accepts.
- `IDEA1-AEGIS_Drive_LC/tests/i18nCopyAudit.test.js` — the locale audit pinned the old always-visible “not currently available” claim in `newShareSub`/`scopeAnyBody`. That claim becomes false once a deployment may enable the scope, so the guard was **moved rather than deleted**: it now asserts the honest replacement in `publicShareBody` (the notice rendered only while the capability is off) and asserts the stale wording is absent from the always-visible copy, in all three languages.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-public-share-architecture.md` — adds §8.1.2, records how invariant 20 is satisfied, and marks the PUBLIC-SHARE-4 rollout row delivered-not-activated.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-status.md` — records the UI source as implemented, locally verified and not activated.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-09-08_154042_kla_idea1-public-share-ui.md` — this one immutable task receipt.

## Verification evidence

- `git fetch origin; git rev-parse origin/main` — passed: `origin/main` was `5f30bc54f8603195ed9618e755fe3726ea343bb6` and no Pull Request was open, so the branch was cut from current `main` with no dependency to stack on.
- `node --test tests/shareScopeTruthUi.test.js` — passed: 19 tests, 19 passed, 0 failed (17 before the PR #102 amendment). Covers both capability states, the unknown/failed read, public-vs-any distinctness, the private-only saved default, the forced password, the 1h transient expiry with private restore, all three URL-ownership cases, EN/TH/ZH parity, the active-table chip and filter, and the mobile layout contract.
- `node --test tests/publicShareConfig.test.js` — passed: 24 tests, 24 passed, 0 failed; includes `PS4-CFG-1..6` proving absent/false/true/malformed handling, the three-way effective selector, and that the flag never moves `publicShareEnabled`.
- `node --test tests/publicShareBackend.test.js` — passed: 23 tests, 21 passed, 0 failed, 2 skipped (PostgreSQL-only); includes `PS4-API-1..4` proving the payload is exactly `{shares, capabilities}` with one boolean, that no origin/gateway/subnet string leaks, that an anonymous caller gets 401 and learns nothing, and that public creation is identical with the flag on, off and absent.
- `node --test --test-concurrency=1 tests/shareScopeTruthUi.test.js tests/publicShareConfig.test.js tests/publicShareBackend.test.js tests/shareRedemption.test.js tests/trustedProxy.test.js` — passed: 94 tests, 89 passed, 0 failed, 5 skipped (92/87 before the amendment).
- Amendment coverage — `SHARE-SCOPE-UI-7` now asserts all five required confirmation facts (exact `publicUrl`, Public Internet indication, password-protected indication, the server expiry rendered as `3h 00m` from a stored `now + 3h`, and the one-time-copy warning) plus the absence of the plaintext password; `UI-7b` asserts private links still compose the internal URL and now also show the stored `2d 5h`; new `UI-7d` proves the confirmation uses the stored value rather than the form (the form said 1h while the server said 3h) and that editing the expiry select or the scope afterwards does not rewrite the issued link; new `UI-7e` pins the source at the code level.
- Negative controls for the amendment — recomputing the confirmation expiry client-side (`Date.now() + 1h`) failed `UI-7`, `UI-7d` and `UI-7e`; removing the expiry from the confirmation entirely failed `UI-7`, `UI-7b`, `UI-7d` and `UI-7e`. The file was restored and the suite returned to 19/19, so the new assertions are load-bearing rather than decorative.
- `node --test tests/i18nCopyAudit.test.js` — passed: 7 tests, 7 passed, 0 failed. The first full-suite run of this task **failed** here, because the audit pinned the pre-existing always-visible “not currently available” claim; the guard was rewritten to assert the truthful replacement rather than removed, and the copy audit then passed.
- `node --test --test-concurrency=1 --test-timeout=120000 "tests/**/*.test.js"` (the `npm test` script plus an explicit per-test timeout) — failed only at the accepted pre-existing `AUTOLOCK-5`: 1,133 tests, 1,062 passed, 1 failed, 0 cancelled, 70 skipped, 143.8 s. **This is the pre-amendment run and was deliberately NOT re-run for the PR #102 amendment**, which changed only `src/screens/Shares.jsx`, the UI test file and its fixture; the focused suite was re-run and is green. No new full-suite numbers are claimed. **PUBLIC-SHARE-4 introduced failures = 0.** The count rose from 1,112 to 1,133 because of the new UI-matrix, config and backend cases. The explicit per-test timeout is used because bare `npm test` runs with `--test-timeout=0` and the pre-existing `vaultChunkedUploadClient.test.js` flake can otherwise hang the suite indefinitely; that flake did not fire in this run. PostgreSQL-only tests stayed skipped without `TEST_DATABASE_URL`, and the pre-existing React `act(...)` warnings remained.
- Real-browser responsive/accessibility check at 320, 375, 640 and 1280 px, across Classic and Neo and EN/TH/ZH (12 rendered states) — passed: 2 radios in the unavailable state and 3 in the enabled state everywhere, 44 px touch-target height at ≤640 px, zero clipped scope labels, and no horizontal document overflow at any width.
- `npm run build` — passed: re-run after the amendment, built in 4.49 s, retaining the existing >500 kB chunk warning for the 609.95 kB main chunk. The regenerated `dist/index.html` was restored; `dist` is not part of this change.
- `node scripts/validate-vault.mjs --vault Obsidian_AEGIS_Vault/AEGIS_Knowledge` — passed with the two pre-existing owner-review warnings for the architecture/network canvas files (re-run after the amendment).
- `node scripts/validate-collaboration-policy.mjs --event <local-pr-event> --changed-files <local-name-status>` — passed (`Collaboration policy passed.`) against the final Draft PR body and all 13 changed paths.
- `git diff --check` and `git diff --cached --check` — passed.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-public-share-architecture.md` — new §8.1.2 documents `PUBLIC_SHARE_UI_ENABLED`, the three-way effective selector, and the two properties that matter (it is not authorization, and it is not evidence that G6 passed); invariant 20 now records how PUBLIC-SHARE-4 satisfies it; the rollout row is marked delivered-in-source, not-activated.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-status.md` — new PUBLIC-SHARE-4 section recording UI source implemented / locally verified / not activated, and the share-capability table now says the UI capability ships off by default rather than that "the UI remains disabled".

## Shared surfaces touched

- `IDEA1-AEGIS_Drive_LC/.env.example` — cross-scope deployment contract: introduces the `PUBLIC_SHARE_UI_ENABLED` activation variable. It ships commented out, so a deployment copying this file stays in the current private state; downstream effect is nil until an operator sets it, and rollback is PR revert plus removing the variable from any `.env` that adopted it. No secret is committed and no Production `.env` was touched.
- `IDEA1-AEGIS_Drive_LC/server/config/publicShare.js` — cross-scope server configuration boundary: parses the new activation variable and computes `publicSelectable`. A malformed value now fails the boot, which is a deliberate availability trade chosen for the same reason as the existing base-URL and trusted-proxy rules; rollback is PR revert.
- `IDEA1-AEGIS_Drive_LC/server/routes/api.js` — cross-scope server contract: `GET /api/shares` gains one additive `capabilities` object. Existing clients that read only `shares` are unaffected; no authorization behaviour changed; rollback is PR revert.

## Integration requests

- **Kla infrastructure/deployment review is required for the three shared paths above**, specifically: that `PUBLIC_SHARE_UI_ENABLED` is an acceptable name and contract for a deployment activation signal; that boot-failing on a malformed value is the right trade for this variable; and that the additive `capabilities` object on `GET /api/shares` is an acceptable client contract.
- **The activation switch must stay off until G6 / PUBLIC-SHARE-7 acceptance.** This PR does not set it anywhere, and `.env.example` carries the warning. Enabling it earlier would advertise Internet sharing that no deployed gateway, DNS, TLS or ingress can serve.
- Confirm that no Production `.env`, migration 009 application, gateway deployment, DNS, TLS, NAT, tunnel, MikroTik, UFW, VLAN or Twingate change is included — none is.
- Rollback is PR revert. There is no Production rollback because nothing was deployed or activated.

## Known limitations

- The PR #102 amendment was scoped to the created-link confirmation, its tests and the test fixture. The full 1,133-test suite was **not** re-run for it; the prior run's numbers are retained above and labelled as such.
- **Public Internet Share remains NOT IMPLEMENTED.** This task delivers UI source only. Production gateway = NO, Production migration 009 = NO, public DNS/TLS/NAT/tunnel/ingress = NO, Production UI activation = NO, external 4G/5G acceptance = NO. G4, G5 and G6 remain open, and PUBLIC-SHARE-5/6/7 were not started.
- The enabled state was verified against a **fixture** capability and a fixture backend, not against a deployment that has actually set `PUBLIC_SHARE_UI_ENABLED=true` with a real gateway behind it. It proves the interface behaves correctly when told the capability is on; it does not prove any deployment can serve such a link. PUBLIC-SHARE-6 owns that.
- The responsive/accessibility check rendered the real component with the real compiled CSS at four widths, both interface styles and all three languages, but it is a static server-rendered snapshot: it proves layout, touch-target size, wrapping and overflow, not hydrated keyboard traversal in a live browser session.
- The public scope filter in the active-links table is offered regardless of the capability, deliberately: public rows can exist from a prior activation or from direct API use, and hiding the filter would hide the ability to find them.
- `npm test` retains the unrelated pre-existing `AUTOLOCK-5` failure and the intermittent `vaultChunkedUploadClient.test.js` timing flake, plus the existing React `act(...)` warnings and the existing >500 kB chunk warning. None of these was hidden or fixed here.
- `npm ci` reported 6 dependency audit findings (4 moderate, 2 high) in this fresh worktree; no dependency or lockfile was changed and `npm audit fix` was not run.
