---
title: Task Receipt — IDEA1 PUBLIC-SHARE-2 public share backend contract
date: 2026-09-08T00:59:29+07:00
owner: kla
area: idea1
branch: feat/idea1-public-share-backend-contract
status: complete
integration-review: yes
edit_policy: append-by-new-file
---

# Task Receipt — IDEA1 PUBLIC-SHARE-2 public share backend contract

```text
Backend public-share contract = IMPLEMENTED / TESTED LOCALLY
Public Share Gateway          = NOT IMPLEMENTED
Public Internet ingress       = NOT IMPLEMENTED
Public Internet UI option     = NOT ENABLED
Production deployment         = NOT DONE
External 4G/5G acceptance     = NOT DONE
```

Status is `complete` for the **PUBLIC-SHARE-2 scope only**. AEGIS can now
understand and enforce the backend security contract for a public share. It
still has no way for the public Internet to reach that feature, which is
intentional. **Production was not changed.**

Base: `origin/main` at `867f1ccf7714394217987978df00ba5fad7882e8` (the PR #97
merge). No open PRs and no unmerged dependency at branch time.

Owner gates used: **G1 APPROVED** (contract acceptance) and **G2 APPROVED FOR
IMPLEMENTATION** (trusted-proxy design). G3, G4, G5 and G6 remain open and
nothing in this task depends on them.

## What changed

**`scope=public` is a third explicit scope, gated on configuration.**
`SCOPES` becomes `['any', 'zones', 'public']`. It is deliberately not an alias of
`any`: overloading `any` would have made every share ever created with it
Internet-redeemable the moment a gateway was deployed, retroactively, without
its creator agreeing. `users.share_default_scope` stays `('any','zones')`, so a
saved preference can never publish a file on the sharer's behalf.

Creating one additionally requires a configured public origin. `createShare`
takes an explicit `{ publicShareEnabled }` option and returns `null` without it,
so the rejection reuses the existing generic `400 Invalid input` and tells a
caller nothing about server configuration.

**The identity split from the PR #97 review is implemented, not just described.**
Two accessors, and neither may be substituted for the other:

| | Client source identity | Ingress provenance |
| :--- | :--- | :--- |
| Accessor | `requestSourceIp(req)` → `req.ip` — **unchanged** | new `requestIngressKind(req)` over `req.socket.remoteAddress` |
| Used for | `zones` CIDR enforcement, the rate-limit IP axis, the audit source | the `scope=public` ingress rule, and nothing else |
| On a public request | the external recipient | the public gateway |

Measured in this task through the real Express stack (`PS2-INGRESS-1`): a
request arriving from the gateway peer with `X-Forwarded-For: 203.0.113.50`
audits its source as `203.0.113.50`, **not** the gateway address. `PS2-INGRESS-2`
pins the other half: the same peer sending no forwarding header at all, where
`req.ip` falls back to the peer, still classifies as public-gateway ingress —
which is exactly why the rule reads the socket and not `req.ip`.

`requestIngressKind()` returns a third value, `unknown`, when a gateway is
configured but the peer cannot be read. The scope rule is written as "private
only", so an unreadable peer fails toward denial rather than smuggling a
`zones`/`any` share through the public ingress.

**The public-ingress scope rule.** In `resolveShare()`, before the CIDR check:
a share whose scope is not `public` is refused when the request did not arrive
privately. No bytes, no hit increment, audited `SHARE_REDEEM_OUT_OF_SCOPE /
BLOCKED`, and rendered through the existing restricted page so the ingress does
not become an oracle for which scope a link carries. When no gateway is
configured the helper always answers `private`, so **the rule is inert for the
configuration production runs today**.

**Rate-limit namespaces are separated.** The password limiter selects
`share-public` instead of `share` by ingress, chosen before any database access
so the existing pre-DB lockout ordering is preserved. Without this, one Internet
recipient's five wrong passwords would have locked the `share|<ip>` axis for the
internal office NAT too — the same self-inflicted lockout already found once when
share guessing locked the login page for everyone behind one address. Both remain
distinct from `login`.

**Trusted proxy: two approved production states, not a widened rule.**

```text
Legacy / private mode        PUBLIC_SHARE_GATEWAY_CIDR unset
                             TRUSTED_PROXY_CIDRS = { HUB /32 }     ← deployed today
Public-gateway-enabled mode  PUBLIC_SHARE_GATEWAY_CIDR = one /32
                             TRUSTED_PROXY_CIDRS = { HUB /32, that /32 }
```

Order is irrelevant — these are identities, not a forwarding chain. The gateway
identity is optional until its rollout phase, so **Drive still boots on the
existing production configuration** and a rollback to legacy mode needs no code
change. A gateway that is named but not trusted is refused rather than started:
Express would otherwise stop at it when walking `X-Forwarded-For` and `req.ip`
would collapse to the gateway's own address, which is precisely the attribution
failure that produces the self-DoS above.

**One real defect was found and fixed while testing.** `findShareByToken()` did
not project `scope`, so every share read as non-`public` on the redemption path
and a legitimate public share was refused through the public ingress. Caught by
`PS2-INGRESS-1` failing, not by inspection.

## Review amendment — PR #99 (2026-09-08)

Amended in place under `AGENTS.md` §9: same task, same branch, same PR, **same
receipt**. No second receipt, branch, or PR. Reviewed head
`43c2f05dfe2c8c037a0a345649c56b68302d346d`.

Two code/contract defects were found in owner review. Both were real and both are
corrected. The verification gate this section originally recorded as blocked —
running migration 009 against a real isolated PostgreSQL database — has since
been **completed**; see "Verification C" below.

### Blocker A — shared-bridge validation was too narrow (fixed)

`server/config/publicShare.js` compared the configured gateway against an
exact-string set:

```js
const FORBIDDEN_GATEWAY_RANGES = new Set(['172.18.0.0/16', '172.18.0.1/32'])
// …
if (FORBIDDEN_GATEWAY_RANGES.has(value)) throw …
```

Because the input is constrained to a single `/32`, that only ever rejected the
one address someone had thought to write down. `172.18.0.1/32` was refused while
`172.18.0.2/32`, `172.18.0.5/32`, `172.18.1.20/32`, `172.18.10.20/32` and
`172.18.255.254/32` were all **accepted** — every one of them still on the
shared `aegis_internal` bridge that carries PostgreSQL and Monitor. The rule was
about the network; the check was about a string.

Corrected to real containment. `FORBIDDEN_GATEWAY_NETWORKS` holds the network,
and a new exported `forbiddenGatewayNetworkFor(address)` decides membership by
masking the parsed IPv4 host against the prefix. The parser is the single
authoritative rejection point; `trustedProxy.js` reaches the same verdict by
calling it, and the production-state test proves the end-to-end configuration
fails too rather than relying on the unit alone. The error now names the network
it matched.

### Blocker B — trailing slash silently widened the G1 contract (fixed)

The merged PUBLIC-SHARE-1 contract states the configured origin carries **no
trailing slash**. The first implementation accepted `https://share.example.invalid/`
and normalised it away, and a test approved that behaviour. That is a contract
change, not an implementation detail, and PUBLIC-SHARE-2 has no authority to
reopen an accepted gate.

`parsePublicShareBaseUrl()` now rejects a trailing slash outright. The check runs
on the raw text, because `new URL()` normalises both `https://host` and
`https://host/` to pathname `/` and the distinction does not survive parsing.
A side benefit worth keeping: the configured string and the emitted URL are now
literally the same text, so an operator reading `.env` sees exactly what
recipients receive. Every other rejection (non-HTTPS, credentials, non-root path,
query, fragment) is unchanged, and a valid value is still normalised once.

### Verification C — isolated PostgreSQL migration evidence — **COMPLETED**

The owner started Docker Desktop, and the verification the earlier revision
recorded as blocked has now been executed. Everything below is observed output,
not inference.

**Environment.** `docker version` reports Server *Docker Desktop 4.43.2, engine
28.3.2*. A throwaway container `aegis-public-share2-pgtest` ran
`postgres:16` (**PostgreSQL 16.15**) published on `127.0.0.1:55439` only, with a
synthetic password. Its **only** mount is the anonymous volume the image declares
for `PGDATA` (`12cbe9333188…`), verified by `docker inspect`; no AEGIS volume
(`aegis_system_postgres_data`, `aegis_system_drive_storage`,
`aegisdrivetest_postgres_data`) is attached. The six pre-existing local dev
containers were all `Exited` and none was started, stopped, or altered.
**No Production database, credential, dump, volume, host or `.env` was used or
contacted at any point.**

**Upgrade path, not a fresh install.** The test database was built from the
pre-PR#99 base schema taken from Git, not from this branch:
`git show 867f1ccf7714394217987978df00ba5fad7882e8:IDEA1-AEGIS_Drive_LC/server/db/schema.sql`
(blob `4c325785a4e8dc9152b864aa633555ce24484f3d`). Its constraint before any
migration was, read from the catalog:

```text
shares_scope_check => CHECK ((scope = ANY (ARRAY['any'::text, 'zones'::text, 'vlan'::text, 'subnet'::text])))
```

**Synthetic seed.** One synthetic user (id 9001), one synthetic file (id 9101)
and four shares, one per pre-migration legal scope — no real AEGIS user, file,
token or password anywhere:

| id | scope | hits | token_hash prefix | vlan_scope |
| :--- | :--- | :--- | :--- | :--- |
| 9201 | `any` | 3 | `aaaaaaaa` | `{}` |
| 9202 | `zones` | 0 | `bbbbbbbb` | `{192.0.2.0/24}` |
| 9203 | `vlan` | 7 | `cccccccc` | `{198.51.100.0/24}` |
| 9204 | `subnet` | 1 | `dddddddd` | `{203.0.113.0/24}` |

`PRE_COUNT=4`. A `scope='public'` insert **before** the migration was rejected —
`ERROR: new row for relation "shares" violates check constraint
"shares_scope_check"` — proving the migration is what enables the value.

**Migration runs.** `009_public_share_scope.sql` applied with
`psql -v ON_ERROR_STOP=1`:

```text
run #1 → BEGIN / DO / ALTER TABLE / COMMIT   exit 0   PASS
run #2 → BEGIN / DO / ALTER TABLE / COMMIT   exit 0   PASS   (idempotent, observed)
```

**Real catalog end state**, read with `pg_get_constraintdef` rather than trusted
from the file:

```text
shares_scope_check => CHECK ((scope = ANY (ARRAY['any'::text, 'zones'::text, 'public'::text, 'vlan'::text, 'subnet'::text])))
```

**Post-migration assertions, all observed:**

- **Rows preserved** — all four seeded rows intact after both runs
  (`POST_COUNT=4`), with `scope`, `hits`, `token_hash`, `password_hash`,
  `vlan_scope`, `revoked` and a still-future `expires_at` unchanged.
- **`public` insert succeeds** — `INSERT 0 1` (id 9205).
- **Legacy `vlan` / `subnet` still accepted** — `INSERT 0 2` (ids 9206, 9207).
- **Invalid `scope='internet'` rejected** — check-constraint violation inside a
  savepoint, rolled back; the session stayed usable (`still_usable=7`).
- **Unrelated columns unchanged in contract** — `token_hash character NULL`,
  `password_hash text NULL`, `vlan_scope ARRAY NOT NULL DEFAULT '{}'::text[]`,
  `expires_at timestamptz NOT NULL`, `revoked boolean NOT NULL DEFAULT false`,
  `hits integer NOT NULL DEFAULT 0`; `shares_token_hash_idx` unique index still
  present.
- **`users.share_default_scope` still private-only** —
  `CHECK ((share_default_scope = ANY (ARRAY['any'::text, 'zones'::text])))`, and
  an `UPDATE … SET share_default_scope='public'` was rejected by that constraint.
- **Fresh install and migrated database agree** — a second database created from
  this branch's `schema.sql` produces a byte-identical `shares_scope_check`
  definition, so `PS2-MIG-5` is now observed rather than argued.

**PostgreSQL-gated tests, run against the isolated database only.** The harness
target was `postgresql://drive_app:…@127.0.0.1:55439/aegis_drive_apptest`, checked
before running anything that resets tables. A least-privilege `drive_app` role was
provisioned exactly as `postgres/init/02-app-roles.sh` does (LOGIN NOSUPERUSER
NOCREATEDB NOCREATEROLE, DML-only, `REVOKE CONNECT … FROM PUBLIC`), and confirmed
unable to alter schema (`ERROR: must be owner of table shares`) — without that,
two identity-decoupling tests fail for the wrong reason.

```text
tests/publicShareBackend.test.js  19 tests, 19 pass, 0 fail, 0 skips
tests/shareRedemption.test.js     17 tests, 17 pass, 0 fail, 0 skips
full npm test (PostgreSQL)      1099 tests, 1098 pass, 1 fail, 0 skips
```

The full PostgreSQL run additionally set `AEGIS_PGTEST_SUPER_URL`, which closes
the last five migration-probe skips, so **every one of the 69 previously gated
tests was observed**. The single failure is the pre-existing `AUTOLOCK-5`.

**One defect in this task's own test code was found by the PostgreSQL run.**
`PS2-INGRESS-1` read `event.sourceIp`, but `readAudit()` returns snake_case rows
from PostgreSQL and camelCase from the in-memory store, so the assertion was
silently `undefined` under PostgreSQL. The **production behaviour was correct** —
the audit row read directly from the database is
`share-link | SHARE_REDEEM | OK | 203.0.113.50`, the external recipient and not
the gateway peer. The test now uses `event?.source_ip ?? event?.sourceIp`, the
same guard `tests/shareRedemption.test.js` already used. This was a test bug that
only a real database could expose, which is precisely why the review required
this gate.

### Correction to an earlier figure in this receipt

The pre-amendment entry reporting `tests/shareRedemption.test.js` as **24 tests,
21 pass** was a *combined* run of `shareRedemption` and `trustedProxy` in one
command. Alone, `shareRedemption` is **17 tests, 14 pass, 0 fail, 3 skips**. The
figures below are corrected; no test result changed, only how it was reported.

## Source files changed

New:

- `IDEA1-AEGIS_Drive_LC/server/config/publicShare.js` — parses and validates
  `PUBLIC_SHARE_BASE_URL` and `PUBLIC_SHARE_GATEWAY_CIDR` once, at boot.
- `IDEA1-AEGIS_Drive_LC/server/request/ingress.js` — the ingress-provenance
  helper; the sibling of `sourceIp.js` and deliberately not a replacement.
- `IDEA1-AEGIS_Drive_LC/server/db/migrations/009_public_share_scope.sql`
- `IDEA1-AEGIS_Drive_LC/tests/publicShareBackend.test.js` — 19 tests over real
  HTTP through the production app.
- `IDEA1-AEGIS_Drive_LC/tests/publicShareConfig.test.js` — 18 configuration,
  ingress-unit and migration-DDL tests (16 at first push, plus `PS2-CFG-2b` and
  `PS2-CFG-6b` from the PR #99 review amendment).

Modified:

- `server/app.js` — parses the public-share config once and freezes it onto the
  app, so routes never read `process.env` per request and injected test envs are
  honoured.
- `server/config/trustedProxy.js` — the two approved states above.
- `server/db/store.js` — `SCOPES` gains `public`; `createShare` gains the
  `publicShareEnabled` gate; `findShareByToken` now projects `scope` (both the
  PostgreSQL and in-memory paths).
- `server/db/schema.sql` — `shares.scope` CHECK widened for fresh databases.
- `server/routes/api.js` — passes the config to `createShare` and returns
  `publicUrl` for a public share only.
- `server/routes/share.js` — the public-ingress scope rule and the limiter
  namespace.
- `.env.example` — both new variables documented as optional and non-secret;
  `PUBLIC_SHARE_GATEWAY_CIDR` ships **commented out** so a copied file stays in
  legacy/private mode.
- `tests/shareScopeTruthUi.test.js` — `SHARE-SCOPE-API-1` rewritten (below) and a
  new `SHARE-SCOPE-API-2`.
- `tests/trustedProxy.test.js` — `TP-S1..S4` added; every pre-existing case kept
  unchanged.

`IDEA1-AEGIS_Drive_LC/dist/` was rebuilt only to verify the build and then
restored; it is **not** part of this change.

### The truthfulness test was updated, not deleted

`SHARE-SCOPE-API-1` asserted that the backend could not represent `public` at
all. That claim is now obsolete, and deleting the test to make the suite green
would have discarded the only guard on UI honesty. It now asserts the boundary
that is still true: the backend understands a public share, the saved default
stays private-only, no gateway identity is configured by default — and a user
still cannot select the option. New `SHARE-SCOPE-API-2` pins that the Shares
screen offers exactly `zones` and `any` and still renders the unavailable notice.

## Verification evidence

- `npm test` in `IDEA1-AEGIS_Drive_LC` (in-memory store, canonical) — **1099 tests, 1029 pass, 1 fail, 69 PostgreSQL-gated skips**. **PUBLIC-SHARE-2 introduced failures = 0.** The suite is not reported as PASS while the runner reports one failure.
- `npm test` against the isolated PostgreSQL 16.15, as the least-privilege `drive_app` role, with `AEGIS_PGTEST_SUPER_URL` set — **1099 tests, 1098 pass, 1 fail, 0 skips**. Every previously gated test was observed. The single failure is the pre-existing `AUTOLOCK-5`. The single failure is `AUTOLOCK-5 migration 008 replaces the CHECK without touching the column`, which is **pre-existing and unrelated**: verified, not assumed, by stashing every change in this branch and re-running the same file on the resulting pristine `origin/main` tree, where it fails identically (`9 tests, 8 pass, 1 fail`). It concerns migration 008 and its own test file, both byte-identical to `origin/main` on this branch (`git diff origin/main --name-only` over both paths is empty). Out of scope here and left untouched.
- `node --test --test-concurrency=1 tests/publicShareBackend.test.js` — **19/17/0 fail/2 skips** in memory mode, and **19 tests, 19 pass, 0 fail, 0 skips** against the isolated PostgreSQL.
- `node --test --test-concurrency=1 tests/publicShareConfig.test.js` — **pass 18/18**, including the two new amendment tests.
- `node --test --test-concurrency=1 tests/trustedProxy.test.js` — **pass 11/11**, including the 7 pre-existing cases unchanged.
- `node --test --test-concurrency=1 tests/shareScopeTruthUi.test.js` — **pass 6/6**.
- `node --test --test-concurrency=1 tests/shareRedemption.test.js` — **17/14/0 fail/3 skips** in memory mode, and **17 tests, 17 pass, 0 fail, 0 skips** against the isolated PostgreSQL; the existing private-path behaviour (CIDR allow/deny, forged-XFF rejection, password, expiry, revoke, Vault, hits, audit, trash) is unchanged.
- `npm run build` — **pass**, re-run after Verification C (5.18 s). `dist/` restored afterwards and confirmed clean in `git status`.
- `node scripts/validate-vault.mjs --vault Obsidian_AEGIS_Vault/AEGIS_Knowledge` — **pass**, 0 errors (2 pre-existing owner-data canvas warnings, unrelated).
- `node scripts/validate-collaboration-policy.mjs --event … --changed-files …` — **pass**, run locally against a synthesised event carrying this PR's body and this branch's real `git diff --name-status origin/main...HEAD`.
- `git status --short` / `git diff --check` — **clean**; only the intended paths, no whitespace or conflict-marker error.
- Secret scan over the branch diff — **pass (clean)**. `PUBLIC_SHARE_BASE_URL` ships the deliberately non-routable placeholder `https://share.example.invalid`; `PUBLIC_SHARE_GATEWAY_CIDR` ships commented out with no real address. No credential, key, certificate, token, real domain, or real gateway IP is added.
- **No production access of any kind**: no SSH, no deployment, no migration run against production, no container, network, firewall, DNS, NAT, tunnel, or certificate action. None is claimed.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-status.md` — records the
  backend contract as implemented and locally verified but **not deployed**;
  records the two approved trusted-proxy states with legacy mode still the
  deployed one; records the implemented client/ingress identity split; and
  restates that the gateway, the Internet ingress, the UI option and Production
  acceptance all remain outstanding.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-public-share-architecture.md`
  — the PUBLIC-SHARE-2 row of the rollout table and the §16.1 verification plan
  now point at the delivered module and test names; §18 drops the limitation that
  said the ingress helper did not exist, because it now does.

No new canonical note was introduced, so `index.md` is deliberately **not**
touched.

## Shared surfaces touched

**None.** Every changed path is inside the `idea1` boundary
(`IDEA1-AEGIS_Drive_LC/` and `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/` plus
this receipt). `gateway/`, `HUB-AEGIS_Entry/`, `docker-compose.yml`,
`postgres/`, `shared/`, and the root `.env.example` are untouched.

`integration-review: yes` is carried anyway, because the change alters a
**production-verified security control** (`trustedProxy.js`) and a **deployment
contract** (`IDEA1-AEGIS_Drive_LC/.env.example`) and adds a database migration,
even though all three live inside the owned area.

## Integration requests

- **Kla, as infrastructure owner, must accept the trusted-proxy two-state
  implementation before any deployment.** G2 approved the design; this is the
  code. The control's single-identity form is what made B4.3's production spoof
  resistance provable. **Downstream impact:** none until a gateway identity is
  configured — legacy mode is the default and the currently deployed
  `TRUSTED_PROXY_CIDRS=172.19.255.2/32` still boots unchanged. **Rollback:**
  revert the PR; no configuration change is required because the new variables
  are optional and unset.

- **Migration 009 must be applied before a Drive image carrying this code is
  deployed**, and the ordering matters in one direction only: 009 is additive, so
  a database that has it works with both old and new application code, while new
  code without 009 would have its `INSERT` rejected by the old CHECK the moment
  someone created a public share. Apply 009 first, then deploy. **Rollback:**
  leave 009 in place. It is additive and reverting it would invalidate any
  `public` row that already exists; existing shares stay listable and revocable.

- **Gate G3 (public-path audit personal data) must be decided before
  PUBLIC-SHARE-3 deploys a gateway.** This PR makes the recipient's real address
  the audit source for a public redemption, which is the behaviour the gate is
  about. Nothing records an Internet address today because no ingress exists.

- Gates G4, G5 and G6 remain untouched by this task, and no ingress, DNS, NAT,
  TLS, tunnel, firewall or Twingate work was performed or prepared.

## Known limitations

- **Public Internet Share is still not usable, by design.** No gateway, no
  ingress, no UI option, no deployment, no external acceptance.
- **A third defect — in this task's own test code — was found only by the real
  database**: `PS2-INGRESS-1` read `event.sourceIp`, which is `undefined` for
  PostgreSQL rows. Production behaviour was correct throughout; the assertion was
  silently vacuous in the one mode that could not run before. Fixed, and a
  reminder that in-memory-only test evidence has a blind spot.
- **Two defects reached the first pushed head (`43c2f05d`) and were caught in
  owner review, not by this task's own checks**: the shared-bridge check compared
  strings instead of testing network containment, and the base-URL parser
  silently widened the accepted G1 no-trailing-slash contract. Both are fixed and
  covered by tests, but the miss is recorded rather than smoothed over — neither
  would have been caught by any check that existed before the review.
- **Migration 009 was verified on PostgreSQL 16.15, not on the production
  PostgreSQL 15 line.** The throwaway container ran `postgres:16` while the
  deployed stack uses `postgres:15-alpine`. The DDL involved (`pg_constraint`
  lookup, `DROP CONSTRAINT`, `ADD CONSTRAINT … CHECK`) is identical across both
  majors and nothing version-specific is used, but the observed run is 16.15 and
  the receipt says so rather than implying 15 was exercised.
- **The migration was applied by a superuser to a database whose tables that
  superuser owns.** That matches how a deployment applies migrations, and the
  no-GRANT reasoning was re-checked: 009 creates no object, and `drive_app`
  retained working DML afterwards (the full PostgreSQL suite runs as that role).
  It does not prove the cross-superuser ownership case that the LFT-V2-A rule was
  written for, because 009 creates nothing for that rule to apply to.
- **Production has still never had 009 applied**, and applying it remains a
  prerequisite of any deployment of this code.
- **Mode-dependent skips, all of them since observed.** In the default in-memory
  mode two `publicShareBackend` tests skip (the Vault-file rejection and the
  raw-token-not-persisted checks need PostgreSQL to set `files.vault` and read
  `shares.token_hash`), and three `shareRedemption` tests skip for the same kind
  of reason. **Under Verification C's isolated PostgreSQL both suites ran with
  zero skips and zero failures** — `publicShareBackend` 19/19 and
  `shareRedemption` 17/17 — so these are a limitation of the *in-memory* run, not
  an outstanding gap in what has been verified.
- **`AUTOLOCK-5` fails on this branch and on pristine `origin/main` alike.**
  Pre-existing, proven by stashing, out of scope, untouched.
- **The gateway peer in tests is a loopback alias (`127.0.0.3`), not a
  container.** It models the socket peer correctly, which is what the ingress
  rule reads, but it is not evidence about a real deployed gateway.
- **Ingress provenance is an address comparison, not authentication.** It is
  sound only because the future `aegis_public_share` network is specified with
  exactly two members and Drive publishes no port. A third member on that network
  would weaken it silently — the Compose structural test named in threat T-10
  belongs to PUBLIC-SHARE-3 and does not exist yet.
- **No real public origin has been chosen.** `.env.example` carries a
  deliberately non-routable placeholder, and `PUBLIC_SHARE_GATEWAY_CIDR` ships
  commented out with no address at all.
- The in-memory rate limiter and `MemoryStore` sessions remain single-process, as
  recorded in `summaries/08_Outstanding_Items_Consolidated`. No Redis or shared
  store was introduced, deliberately.
- HTTP Range is still unsupported on the redemption path, so an interrupted
  public download would restart from zero. Out of scope here.
