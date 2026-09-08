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

## Source files changed

- `IDEA1-AEGIS_Drive_LC/server/config/publicShare.js` — adds `parsePublicShareUiEnabled` (strict `true`/`false`, boot-fail otherwise) and the frozen `publicShareUiEnabled` / `publicSelectable` facts.
- `IDEA1-AEGIS_Drive_LC/server/routes/api.js` — `GET /api/shares` additively returns the coarse `capabilities.publicSelectable` boolean, read from the boot-frozen config rather than `process.env`.
- `IDEA1-AEGIS_Drive_LC/.env.example` — documents the new variable commented out and default-off, with the "do not enable before G6 / PUBLIC-SHARE-7 acceptance" warning.
- `IDEA1-AEGIS_Drive_LC/src/screens/Shares.jsx` — server-owned capability read, conditional third scope option, public scope panel, forced password for public, split private/public auth and expiry state, backend-owned public URL with fail-closed handling, public chip and scope filter.
- `IDEA1-AEGIS_Drive_LC/src/lib/strings.js` — EN/TH/ZH copy for the public scope, its risk panel, the password rule, the public chip, the fail-closed message and the created-link note; replaces the stale unavailability wording in `publicShareBody`, `scopeAnyBody` and `newShareSub`.
- `IDEA1-AEGIS_Drive_LC/tests/shareScopeTruthUi.test.js` — rewritten from the obsolete "only zones and any exist" claim into the two-state UI matrix, driven through the real component in jsdom.
- `IDEA1-AEGIS_Drive_LC/tests/fixtures/publicShareUiApi.js` — **new**: records what the screen actually POSTs, so the URL-ownership and password assertions test the composed request rather than a copy of the UI's own logic.
- `IDEA1-AEGIS_Drive_LC/tests/publicShareConfig.test.js` — adds the `PUBLIC_SHARE_UI_ENABLED` parsing matrix and the effective-selector matrix.
- `IDEA1-AEGIS_Drive_LC/tests/publicShareBackend.test.js` — adds the coarse capability shape, its authentication, and proof that the flag does not change what `POST /api/shares` accepts.
- `IDEA1-AEGIS_Drive_LC/tests/i18nCopyAudit.test.js` — the locale audit pinned the old always-visible “not currently available” claim in `newShareSub`/`scopeAnyBody`. That claim becomes false once a deployment may enable the scope, so the guard was **moved rather than deleted**: it now asserts the honest replacement in `publicShareBody` (the notice rendered only while the capability is off) and asserts the stale wording is absent from the always-visible copy, in all three languages.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-public-share-architecture.md` — adds §8.1.2, records how invariant 20 is satisfied, and marks the PUBLIC-SHARE-4 rollout row delivered-not-activated.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-status.md` — records the UI source as implemented, locally verified and not activated.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-09-08_154042_kla_idea1-public-share-ui.md` — this one immutable task receipt.

## Verification evidence

- `git fetch origin; git rev-parse origin/main` — passed: `origin/main` was `5f30bc54f8603195ed9618e755fe3726ea343bb6` and no Pull Request was open, so the branch was cut from current `main` with no dependency to stack on.
- `node --test tests/shareScopeTruthUi.test.js` — passed: 17 tests, 17 passed, 0 failed. Covers both capability states, the unknown/failed read, public-vs-any distinctness, the private-only saved default, the forced password, the 1h transient expiry with private restore, all three URL-ownership cases, EN/TH/ZH parity, the active-table chip and filter, and the mobile layout contract.
- `node --test tests/publicShareConfig.test.js` — passed: 24 tests, 24 passed, 0 failed; includes `PS4-CFG-1..6` proving absent/false/true/malformed handling, the three-way effective selector, and that the flag never moves `publicShareEnabled`.
- `node --test tests/publicShareBackend.test.js` — passed: 23 tests, 21 passed, 0 failed, 2 skipped (PostgreSQL-only); includes `PS4-API-1..4` proving the payload is exactly `{shares, capabilities}` with one boolean, that no origin/gateway/subnet string leaks, that an anonymous caller gets 401 and learns nothing, and that public creation is identical with the flag on, off and absent.
- `node --test --test-concurrency=1 tests/shareScopeTruthUi.test.js tests/publicShareConfig.test.js tests/publicShareBackend.test.js tests/shareRedemption.test.js tests/trustedProxy.test.js` — passed: 92 tests, 87 passed, 0 failed, 5 skipped.
- `node --test tests/i18nCopyAudit.test.js` — passed: 7 tests, 7 passed, 0 failed. The first full-suite run of this task **failed** here, because the audit pinned the pre-existing always-visible “not currently available” claim; the guard was rewritten to assert the truthful replacement rather than removed, and the copy audit then passed.
- `node --test --test-concurrency=1 --test-timeout=120000 "tests/**/*.test.js"` (the `npm test` script plus an explicit per-test timeout) — failed only at the accepted pre-existing `AUTOLOCK-5`: 1,133 tests, 1,062 passed, 1 failed, 0 cancelled, 70 skipped, 143.8 s. **PUBLIC-SHARE-4 introduced failures = 0.** The count rose from 1,112 to 1,133 because of the new UI-matrix, config and backend cases. The explicit per-test timeout is used because bare `npm test` runs with `--test-timeout=0` and the pre-existing `vaultChunkedUploadClient.test.js` flake can otherwise hang the suite indefinitely; that flake did not fire in this run. PostgreSQL-only tests stayed skipped without `TEST_DATABASE_URL`, and the pre-existing React `act(...)` warnings remained.
- Real-browser responsive/accessibility check at 320, 375, 640 and 1280 px, across Classic and Neo and EN/TH/ZH (12 rendered states) — passed: 2 radios in the unavailable state and 3 in the enabled state everywhere, 44 px touch-target height at ≤640 px, zero clipped scope labels, and no horizontal document overflow at any width.
- `npm run build` — passed: Vite built in 10.69 s, retaining the existing >500 kB chunk warning for the 609.95 kB main chunk. The regenerated `dist/index.html` was restored; `dist` is not part of this change.
- `node scripts/validate-vault.mjs --vault Obsidian_AEGIS_Vault/AEGIS_Knowledge` — passed with the two pre-existing owner-review warnings for the architecture/network canvas files.
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

- **Public Internet Share remains NOT IMPLEMENTED.** This task delivers UI source only. Production gateway = NO, Production migration 009 = NO, public DNS/TLS/NAT/tunnel/ingress = NO, Production UI activation = NO, external 4G/5G acceptance = NO. G4, G5 and G6 remain open, and PUBLIC-SHARE-5/6/7 were not started.
- The enabled state was verified against a **fixture** capability and a fixture backend, not against a deployment that has actually set `PUBLIC_SHARE_UI_ENABLED=true` with a real gateway behind it. It proves the interface behaves correctly when told the capability is on; it does not prove any deployment can serve such a link. PUBLIC-SHARE-6 owns that.
- The responsive/accessibility check rendered the real component with the real compiled CSS at four widths, both interface styles and all three languages, but it is a static server-rendered snapshot: it proves layout, touch-target size, wrapping and overflow, not hydrated keyboard traversal in a live browser session.
- The public scope filter in the active-links table is offered regardless of the capability, deliberately: public rows can exist from a prior activation or from direct API use, and hiding the filter would hide the ability to find them.
- `npm test` retains the unrelated pre-existing `AUTOLOCK-5` failure and the intermittent `vaultChunkedUploadClient.test.js` timing flake, plus the existing React `act(...)` warnings and the existing >500 kB chunk warning. None of these was hidden or fixed here.
- `npm ci` reported 6 dependency audit findings (4 moderate, 2 high) in this fresh worktree; no dependency or lockfile was changed and `npm audit fix` was not run.
