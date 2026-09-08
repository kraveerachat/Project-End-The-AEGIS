---
title: Task Receipt — IDEA1 PUBLIC-SHARE-5 public share security regression suite
date: 2026-09-08T16:45:56+07:00
owner: kla
area: idea1
branch: chore/idea1-public-share-security-regression
status: complete
integration-review: yes
edit_policy: append-by-new-file
---

# Task Receipt — IDEA1 PUBLIC-SHARE-5 public share security regression suite

## What changed

- Automated the full public-share negative and positive security matrix from the
  architecture's §16. **This phase added no product behaviour: no shipped
  gateway, backend or UI source changed.** The only new code is a test file.
- Added `IDEA1-AEGIS_Drive_LC/tests/publicShareSecurityRegression.test.js`, which
  owns the recipient-facing and forensic half of the matrix that no single
  existing suite covered end to end. It deliberately does not duplicate what
  `publicShareConfig`, `publicShareBackend`, `trustedProxy`, `shareScopeTruthUi`
  and the two gateway suites already pin.
- **Indistinguishability.** Unknown, malformed, revoked and trashed links return
  one byte-identical refusal — same status, same content-type, same body — with
  no file name, owner, storage path, file bytes or echoed token. Only the CSP
  nonce is normalised out of that comparison, and the real nonce values are
  captured first and asserted **distinct across the four exercised responses**,
  so the normalisation cannot hide a fixed nonce. This measures freshness per
  exercised response; it is **not** a claim about entropy quality.
- **The audit is deliberately NOT flattened.** A separate test asserts the
  forensic record still distinguishes `SHARE_REDEEM_REVOKED` from an unknown
  token, because indistinguishability is a recipient-facing property, not an
  audit one.
- **Raw-token secrecy.** The token is returned once at creation and is absent
  from `GET /api/shares`, from the audit, and from the stored row, which holds
  only a sha256 hex digest.
- **Password secrecy.** The plaintext link password never appears in the
  creation response, the listing, the audit, the failed password form or the
  success response, and is stored only as a bcrypt hash. Separately, the real
  Public Share Gateway runtime test now submits a unique password sentinel in an
  allowed `application/x-www-form-urlencoded` POST and asserts it is absent from
  the **real nginx container's own Docker logs**, alongside the existing raw-token
  sentinel — a request-BODY leak path the token check never covered.
- **Password correctness and lockout.** A wrong password is denied, the right one
  delivers the bytes, and sustained guessing is stopped server-side with a
  `Retry-After` header and no file content. The existing threshold is asserted as
  observed behaviour; no limiter policy was changed.
- **T-05 in BOTH directions.** A public-path lockout leaves the same address able
  to redeem the same link privately and to sign in; and private-share plus login
  failures do not consume the public namespace.
- **Forged headers.** An untrusted peer rotating `X-Forwarded-For` / `X-Real-IP` /
  `Forwarded` on every attempt cannot buy a fresh guessing quota.
- **Lifecycle.** Vault exclusion is proven at redemption as well as creation;
  only the owner may revoke, and a non-owner — including Admin — receives the
  object-hiding 404 while the link demonstrably stays alive; trashing kills live
  links without counting a hit; delivery counts exactly one hit per delivery and
  revoked/expired attempts count none.
- **Response headers.** A successful delivery keeps `attachment`,
  `application/octet-stream`, `nosniff`, `no-store` and `no-referrer`; refusal
  and password pages stay `noindex,nofollow` under a `default-src 'none'` CSP.
- **Audit content and absence.** A successful public redemption is attributed to
  the canonical **recipient** address, never the gateway peer, and the audit
  contains no raw token, no plaintext password and no public URL.
- No accepted invariant failed against current `main`, so no source defect had to
  be reported under §27.

## Source files changed

- `IDEA1-AEGIS_Drive_LC/tests/publicShareSecurityRegression.test.js` — **new, and the only code file**: the 16-test public-share security regression matrix described above, exercised through the same Express app production runs plus two modelled trusted edges (`127.0.0.2` private, `127.0.0.3` public gateway) and one untrusted peer (`127.0.0.4`).
- `IDEA1-AEGIS_Drive_LC/tests/publicShareGatewayRuntime.test.js` — **amended** (PR #103 review): `PS3-RUNTIME-12` now also submits a unique link-password sentinel through an allowed form POST and asserts it is absent from the real gateway container's Docker logs, not only the raw token.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-public-share-architecture.md` — marks the PUBLIC-SHARE-5 rollout row delivered-in-source and records which suite owns which part of the §16 matrix, the negative controls, and the two row-access-dependent gates.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-status.md` — records the matrix as implemented and locally verified, with Public Internet Share still NOT IMPLEMENTED.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-09-08_164556_kla_idea1-public-share-security-regression.md` — this one immutable task receipt.

**No shipped source changed.** `git diff --name-only` against `origin/main`
shows no file under `gateway/`, `IDEA1-AEGIS_Drive_LC/server/`,
`IDEA1-AEGIS_Drive_LC/src/`, `server/db/migrations/` or `.env.example`.

## Verification evidence

- `git fetch origin; git rev-parse origin/main` — passed: `origin/main` was `cda1db551b1cb242c761c6bd919fc2cf7a3966ab` (matching the merge commit of PR #102) with no Pull Request open, so the branch was cut from current `main` with no dependency to stack on.
- `node --test tests/publicShareSecurityRegression.test.js` (memory store) — passed: 16 tests, 16 passed, 0 failed (re-run after the PR #103 amendment). The Vault-redemption and expiry gates reported their evidence as **unavailable** in this mode rather than substituting a weaker assertion.
- `TEST_DATABASE_URL=… node --test tests/publicShareSecurityRegression.test.js` (PostgreSQL 15.18, re-provisioned isolated instance) — passed: 16 tests, 16 passed, 0 failed, with the Vault-redemption and expiry gates genuinely exercised (re-run after the amendment).
- `node --test tests/publicShareGatewayStructure.test.js` — passed: 12 tests, 12 passed, 0 failed (re-run after the amendment).
- `PUBLIC_SHARE_GATEWAY_RUNTIME=1 node --test tests/publicShareGatewayRuntime.test.js` — passed: 18 tests, 18 passed, 0 failed on the real Docker harness (re-run after the amendment), including the amended `PS3-RUNTIME-12` which inspected 8,550 bytes of the real gateway container's Docker logs and found neither the raw-token nor the link-password sentinel, in-container `nginx -t` reporting `syntax is ok` / `test is successful`, the route/method deny matrix with zero upstream contacts, header sanitation, Host poisoning, the edge rate limit, token-safe logs, and the `internal: true` + `gateway_mode_ipv4=isolated` two-member B5 structure.
- `node --test --test-concurrency=1 --test-timeout=120000 "tests/**/*.test.js"` (the `npm test` script plus an explicit per-test timeout) — failed only at the accepted pre-existing `AUTOLOCK-5`: 1,151 tests, 1,080 passed, 1 failed, 0 cancelled, 70 skipped, 163.7 s. **This is the pre-amendment run and was deliberately NOT re-run for the PR #103 amendment**, which changed only two test files; the PS5, gateway structure and gateway runtime suites were all re-run and are green. No new full-suite numbers are claimed. **PUBLIC-SHARE-5 introduced failures = 0.** The count rose from 1,133 to 1,151 because of the 16 new regression tests plus two run-mode variants. The explicit per-test timeout is used because bare `npm test` runs with `--test-timeout=0` and the pre-existing `vaultChunkedUploadClient.test.js` flake can otherwise hang the suite indefinitely; that flake did not fire in this run. PostgreSQL-only tests stayed skipped without `TEST_DATABASE_URL`, and the pre-existing React `act(...)` warnings remained.
- `npm run build` — passed: re-run after the amendment; Vite built in 4.62 s, retaining the existing >500 kB chunk warning for the 609.95 kB main chunk. The regenerated `dist/index.html` was restored; `dist` is not part of this change.
- `node scripts/validate-vault.mjs --vault Obsidian_AEGIS_Vault/AEGIS_Knowledge` — passed with the two pre-existing owner-review warnings for the architecture/network canvas files.
- `node scripts/validate-collaboration-policy.mjs --event <local-pr-event> --changed-files <local-name-status>` — POLICY_PENDING_2
- `git status --short`, `git diff --check`, `git diff --name-status origin/main...HEAD` — passed; the working tree carried no shipped-source modification at any point after the negative controls were reverted.

### Negative controls — the five high-risk guards are load-bearing

Each invariant was temporarily broken, the expected test was confirmed to fail,
and the mutation was reverted. **None of these mutations is committed**, and
`git status` was verified clean after each.

- **T-05 namespace separation** — collapsed `limiterScopeFor()` in `server/routes/share.js` to always return `'share'`. Expected failures observed: `PS5-T05-1` and `PS5-T05-2`.
- **Public-ingress scope block** — disabled the `share.scope !== 'public' && requestIngressKind(req) !== INGRESS_PRIVATE` gate. Expected failures observed: `PS2-RULE-1 zones` and `PS2-RULE-1 any`.
- **Gateway default deny** — replaced the public listener's `location / { return 404; }` with `proxy_pass http://drive:8001;` in `gateway/public-share/nginx.conf.template`. Expected failures observed: `PS3-RUNTIME-5` (forbidden routes reached upstream) and `PS3-RUNTIME-10`.
- **Gateway token-safe logging** — added `$request_uri` back to the `public_share_safe` log format. Expected failure observed: `PS3-RUNTIME-12`.
- **UI public-URL ownership** — made the public branch of `Shares.jsx` compose `window.location.origin + apiUrl(path)`. Expected failures observed: `SHARE-SCOPE-UI-7` and `SHARE-SCOPE-API-1`.
- **CSP nonce freshness** (PR #103 review) — replaced both `randomBytes(16).toString('base64')` nonce sites in `server/routes/share.js` with a constant. Expected failure observed: `PS5-T02-1`, reporting four identical captured nonces. Before the amendment this mutation would have PASSED, which is exactly why the assertion was strengthened.
- **Gateway password-log secrecy** (PR #103 review) — added `$request_body` to the `public_share_safe` log format in `gateway/public-share/nginx.conf.template`. Expected failure observed: `PS3-RUNTIME-12` with `link password leaked into gateway logs`.

### PostgreSQL evidence

- Instance: `postgres:15-alpine`, reporting **PostgreSQL 15.18** on x86_64-pc-linux-musl. Recorded as observed; no other version was tested and none is claimed.
- Isolation: started by the repository's own `scripts/pg-integration-env.sh`, on its own container (`aegis-lftv2pg-db`) and its own network (`aegis-lftv2pg-net`), published only to `127.0.0.1:55433`, with throwaway generated credentials. **No Production database was touched**, and no `.env` was read.
- Coverage: the full 16-test regression suite, which under PostgreSQL additionally exercises the two gates a well-behaved API cannot reach — a Vault-backed share row and an already-expired row.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-public-share-architecture.md` — the PUBLIC-SHARE-5 rollout row is marked delivered-in-source/not-deployed, and a callout records which suite owns which part of the §16 matrix, that five guards were proved load-bearing, and that two gates depend on direct row access.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-status.md` — new PUBLIC-SHARE-5 section recording the matrix as implemented and locally verified, with Production deployment and Public Internet Share still NO.

## Shared surfaces touched

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-public-share-architecture.md` — an IDEA1-owned canonical note, but the contract it records spans the infrastructure-owned public gateway boundary and the shared trusted-proxy/ingress behaviour, so the durable claim about what is now regression-pinned needs integration-owner sight.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-status.md` — same reason: it now carries a durable verification claim about the gateway and ingress boundaries, not only about IDEA1 application code.

No code path outside `IDEA1-AEGIS_Drive_LC/tests/` changed. The gateway harness
under `gateway/public-share/**` was exercised and temporarily mutated for one
negative control, then restored; it is **not** part of this PR's diff.

## Integration requests

- **Kla infrastructure review of the claim boundary**, not of new behaviour: this PR asserts that the merged PUBLIC-SHARE-1..4 controls hold, including the gateway route/log/isolation matrix and the trusted-proxy/ingress split. The reviewer should confirm the matrix is the right one and that nothing here overstates what is proven.
- Confirm the accepted reading of what the regression suite does **not** prove: it is source/test enforcement on a developer machine, not Production perimeter evidence, and it does not exercise a real gateway in front of a real Drive over a real network — that is PUBLIC-SHARE-6.
- Confirm that no shipped source changed, that the five negative-control mutations were reverted, and that no Production database, `.env`, gateway or migration was touched.
- Rollback is PR revert. There is no Production rollback because nothing was deployed, activated or migrated.

## Known limitations

- **Public Internet Share remains NOT IMPLEMENTED.** Production gateway = NO, Production migration 009 = NO, Production UI activation = NO, public DNS/TLS/NAT/tunnel/ingress = NO, external 4G/5G acceptance = NO. G4, G5 and G6 remain open, and PUBLIC-SHARE-6/7 were not started.
- The "public gateway" in the backend suites is a **local TCP hop modelling the peer a real gateway would be**, not the PUBLIC-SHARE-3 nginx container. The real gateway is exercised separately by the runtime suite against its own recorder. No test in this repository yet puts the real gateway in front of the real Drive — that is exactly PUBLIC-SHARE-6's job.
- Two gates depend on direct database row access because a well-behaved API cannot reach them: a Vault-backed share row (creation is refused) and an already-expired row (the shortest offered expiry is 1h). They are real under PostgreSQL and are reported as unavailable — not silently weakened — in memory-only mode.
- The rate limiter is process-global with no reset hook, so every test in the new suite uses its own recipient address. One test deliberately burns a **throwaway** username on the login axis, because `recordFailure()` bumps a global per-account counter and using the shared demo account would have locked later tests out of signing in. That is a test-isolation constraint, not a product finding.
- Lockout timing is asserted as "eventually locks with a positive `Retry-After`" rather than pinned to an exact attempt count, so the suite documents the accepted server-side behaviour without freezing a threshold this phase has no authority to set.
- The audit-absence assertions cover the surfaces a test can safely inspect — the audit store, API responses, rendered pages and gateway logs. They are not a proof that no secret can ever reach any log anywhere.
- `npm test` retains the unrelated pre-existing `AUTOLOCK-5` failure and the intermittent `vaultChunkedUploadClient.test.js` timing flake, plus the existing React `act(...)` warnings and the >500 kB chunk warning. None was hidden or fixed here.
- `npm ci` reported 6 dependency audit findings (4 moderate, 2 high) in this fresh worktree; no dependency or lockfile was changed and `npm audit fix` was not run.
