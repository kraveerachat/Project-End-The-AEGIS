---
title: Task Receipt — IDEA1 PUBLIC-SHARE-6 internal integration acceptance (Stage A)
date: 2026-09-08T19:37:59+07:00
owner: kla
area: idea1
branch: feat/idea1-public-share-internal-integration
status: partial
integration-review: yes
edit_policy: append-by-new-file
---

# Task Receipt — IDEA1 PUBLIC-SHARE-6 internal integration acceptance (Stage A)

## What changed

- Built the first harness in this repository that puts the **real** PUBLIC-SHARE-3
  gateway image in front of the **real** AEGIS Drive image on a **real**
  PostgreSQL 15.18, and an acceptance suite that drives it. **This phase added no
  product behaviour: no shipped gateway, backend or UI source changed.** The new
  code is one test file plus one isolated harness stack.
- PUBLIC-SHARE-3 measured the gateway against a purpose-built recorder;
  PUBLIC-SHARE-5 measured the application in-process against a modelled peer.
  Both recorded the same gap in the same words — *"No test in this repository yet
  puts the real gateway in front of the real Drive — that is exactly
  PUBLIC-SHARE-6's job."* This closes that gap.
- **Topology is three networks, not one, and that is the point.** The recipient
  sits only on the edge network, so *"a recipient cannot reach Drive except
  through the gateway"* is enforced by Docker and probed, rather than asserted
  about a diagram. PUBLIC-SHARE-3 could not make that claim: there, the client
  **was** the upstream. Every network carries `internal: true` **and**
  `gateway_mode_ipv4: isolated`, so no host port exists anywhere in the stack.
  The gateway being dual-homed does not weaken B5: both of its networks are
  internal and isolated, so it has no Internet path, no host path and no route to
  PostgreSQL.
- **Migration 009 now has real-database evidence.** The harness deliberately
  provisions the database at its **pre-009 (008-era)** constraint and leaves 009
  unapplied. Production is not a fresh `schema.sql` database, and `schema.sql`
  already carries `public` — so a database built from it would have made 009 a
  no-op and the evidence worthless. The suite observes the before state, proves a
  `scope=public` share **cannot** be minted through the real API while the old
  constraint stands, applies the real migration file, observes the after state,
  proves re-running is a no-op, and proves the scoped `drive_app` role is
  **refused** the migration.
- **Delivery is byte-exact across a real nginx hop.** A 64 MiB
  (67,108,864-byte) deterministic payload is uploaded on the private path and
  redeemed on the public one; the server-side digest, the digest of the generated
  payload, and the digest the recipient computes all match.
- **The slow-client tuning is measurable, not decorative.** With
  `proxy_buffering off` the gateway stops reading from Drive while the recipient
  is not draining, so a single **75 s** client stall lands directly on
  `proxy_read_timeout` and `send_timeout` — whose nginx defaults are 60 s. The
  transfer completes only because the shipped template raises both to 300 s.
- Also proven end to end: an interrupted transfer harms neither tier and a later
  redemption is intact; four concurrent downloads all complete with matching
  digests and one hit each; `/`, `/healthz`, `/drive/`, `/monitor/`, `/api/*`,
  `/s/`, `/s`, both traversal spellings and a `PUT` are all refused **without one
  of them reaching the application**; an unknown `Host` terminates at the
  gateway; forged `X-Forwarded-For` / `X-Real-IP` / `Forwarded` cannot move
  attribution off the real recipient address; a `scope=any` link is refused
  through the public ingress while still redeemable privately; the gateway holds
  no default route and no path to PostgreSQL; revocation is immediate; and the
  teardown is asserted to have removed every container, network and volume.
- **A real product control caught the harness before the harness caught
  anything.** The first run failed to boot Drive with
  `TRUSTED_PROXY_CIDRS must contain exactly the approved HUB proxy identity and
  PUBLIC_SHARE_GATEWAY_CIDR`. That is `config/trustedProxy.js` enforcing the
  production "State B" pair, refusing to start rather than half-starting a
  deployment whose attribution would collapse onto the gateway (T-05). The
  harness was corrected to carry the real production pair
  (`172.19.255.2/32,172.31.251.2/32`); the control was not weakened. **No product
  defect was found by this phase.**

## Source files changed

- `gateway/public-share/integration/docker-compose.yml` — **new**: the isolated
  four-service stack (PostgreSQL 15, real Drive, real gateway, recipient) across
  three internal isolated networks. The gateway is built from `context: ..` on
  purpose, so this harness cannot test a modified gateway; the parent
  `.dockerignore` is an allowlist (`**` plus four files), so the PUBLIC-SHARE-3
  build context is unaffected by this new subdirectory.
- `gateway/public-share/integration/db-init/00-aegis-drive.sh` — **new**: creates
  `aegis_drive` from the repository's own `schema.sql` + `seed.sql`, rolls the
  `shares.scope` CHECK back to its pre-009 definition, and creates `drive_app`
  with the production `NOSUPERUSER`/DML-only attributes mirrored from
  `postgres/init/02-app-roles.sh`, including the `REVOKE CONNECT ... FROM PUBLIC`
  that makes the grant meaningful.
- `gateway/public-share/integration/README.md` — **new**: what the harness is,
  how to run it, why the database starts old, and an explicit list of what it
  does **not** prove.
- `IDEA1-AEGIS_Drive_LC/tests/publicShareInternalIntegration.test.js` — **new,
  and the only code file**: the 15-check `PS6-INT` acceptance suite, gated behind
  `PUBLIC_SHARE_INTEGRATION_RUNTIME=1` so the default suite never builds an image
  or mutates Docker implicitly.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-public-share-architecture.md`
  — marks the PUBLIC-SHARE-6 rollout row as internal-acceptance-passed, updates
  the top warning callout, and records what was proven, the three newly
  established facts, and that G4/G5/G6 remain open.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-status.md` — new
  PUBLIC-SHARE-6 section recording the acceptance as internal-only evidence with
  Production deployment and Public Internet Share still NO.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-09-08_193759_kla_idea1-public-share-internal-integration.md`
  — this one immutable task receipt.

**No shipped source changed.** `git status --short` carried no modification under
`gateway/public-share/` (outside the new `integration/` subdirectory),
`IDEA1-AEGIS_Drive_LC/server/`, `IDEA1-AEGIS_Drive_LC/src/`,
`server/db/migrations/`, `docker-compose.yml` or `.env.example` at any point.

## Verification evidence

- `git fetch origin; git rev-parse origin/main` — passed: `origin/main` was
  `95a59b4a16292df8687131c9b3ac29fcf06b6c0a` (the merge commit of PR #103), with
  no PUBLIC-SHARE-6 branch, PR or worktree in existence, so the branch was cut
  from current `main` with no dependency to stack on. The work was done in a
  fresh worktree because the shared main tree was on an unrelated branch 165
  commits behind `origin/main`.
- `docker compose -p ps6-validate config --quiet` — passed: the harness compose
  file is valid.
- `PUBLIC_SHARE_INTEGRATION_RUNTIME=1 node --test --test-concurrency=1 --test-timeout=1800000 tests/publicShareInternalIntegration.test.js`
  — **passed: 16 tests, 16 passed, 0 failed, 0 skipped, 148.2 s.** All fifteen
  `PS6-INT` checks plus the parent. Notable observed durations: `PS6-INT-6`
  75,790 ms (the 75 s stall genuinely taken and outlived), `PS6-INT-13` 7,317 ms,
  `PS6-INT-15` 13,262 ms.
- The **first** run of the same command reported 16 tests, 14 passed, 2 failed in
  146.3 s — one real subtest failure plus the parent that carries it.
  `PS6-INT-5` asserted an `X-Robots-Tag` response header that
  `server/routes/share.js` has never set; the page carries
  `<meta name="robots" content="noindex,nofollow">` in its body instead. The
  assertion was wrong, not the product. It was corrected to assert the controls
  where they actually live — the per-response CSP, `Referrer-Policy`,
  `Cache-Control`, the robots meta tag, and the absence of any `<script>` — and
  the suite was re-run in full. **This is recorded rather than quietly
  overwritten: the first run's numbers are not the numbers being claimed.**
- The run before that failed at `docker compose up` because Drive refused to boot
  on `TRUSTED_PROXY_CIDRS`. See "What changed" — the control working.
- `docker version` — Docker Engine **28.3.2**; `docker compose version` —
  **v2.38.2-desktop.1**. Host Node for the runner: **v24.14.0**.
- `docker run --rm postgres:15-alpine postgres --version` — **PostgreSQL 15.18**,
  the version the harness database ran. Recorded as observed; no other version
  was tested and none is claimed.
- `node --test tests/publicShareInternalIntegration.test.js` (no env var) —
  passed: 1 test, 0 passed, 1 skipped. The harness stays inert by default.
- `node --test --test-concurrency=1 --test-timeout=120000 "tests/**/*.test.js"`
  (the `npm test` script plus an explicit per-test timeout) — **1,152 tests,
  1,080 passed, 1 failed, 0 cancelled, 71 skipped, 155.6 s.** The single failure
  is the accepted pre-existing `AUTOLOCK-5`
  (`tests/vaultAutoLockDuration.test.js`), whose `doesNotMatch(/ADD COLUMN/i)`
  assertion trips on the phrase inside migration 008's own comment block. It is
  unrelated to this work and was not hidden or fixed. **PUBLIC-SHARE-6 introduced
  failures = 0.** Against the PUBLIC-SHARE-5 baseline of 1,151 / 1,080 / 1 / 70
  the deltas are exactly **+1 test and +1 skipped** — this phase's one new
  top-level test, correctly inert without its env gate. The explicit per-test
  timeout is used because bare `npm test` runs with `--test-timeout=0` and the
  pre-existing `vaultChunkedUploadClient.test.js` flake can otherwise hang the
  suite indefinitely; that flake did not fire in this run. PostgreSQL-only tests
  stayed skipped without `TEST_DATABASE_URL`, and the pre-existing React
  `act(...)` warnings remained.
- `node --test tests/publicShareGatewayStructure.test.js` — passed: 12 tests, 12
  passed, 0 failed. The PUBLIC-SHARE-3 structural contract is unaffected.
- `PUBLIC_SHARE_GATEWAY_RUNTIME=1 node --test --test-timeout=600000 tests/publicShareGatewayRuntime.test.js`
  — passed: 18 tests, 18 passed, 0 failed, 77.2 s on the real PUBLIC-SHARE-3
  Docker harness. Run **after** this phase's files were added, confirming the new
  `integration/` subdirectory does not disturb the PUBLIC-SHARE-3 harness. It
  cannot: `gateway/public-share/.dockerignore` is an allowlist (`**` plus
  `Dockerfile`, `nginx.conf.template`, `entrypoint.sh` and
  `validate-public-share-host.sh`), so the new directory is excluded from both
  build contexts and both harnesses build byte-identical gateway images.
- `npm run build` — passed: Vite built in 8.47 s, retaining the existing >500 kB
  chunk warning for the 613.03 kB main chunk. The regenerated `dist/index.html`
  was restored with `git checkout -- IDEA1-AEGIS_Drive_LC/dist`; `dist` is not
  part of this change.
- `node scripts/validate-vault.mjs --vault Obsidian_AEGIS_Vault/AEGIS_Knowledge`
  — passed with the two pre-existing owner-review warnings for the
  architecture/network canvas files.
- `git status --short`, `git diff --check` — passed; no whitespace error and no
  unintended path.
- `npm ci` reported 6 dependency audit findings (4 moderate, 2 high) in this fresh
  worktree; no dependency or lockfile was changed and `npm audit fix` was not run.

### Isolation evidence

- The suite **refuses to start** if `aegis_ps6_edge`, `aegis_ps6_upstream` or
  `aegis_ps6_data` already exists, so it can never adopt or delete a network it
  did not create.
- Credentials (superuser password, `drive_app` password, `SESSION_SECRET`) are
  generated per run with `randomBytes`. No `.env` was read or written.
- The only mounts are **read-only** copies of the repository's own
  `schema.sql`, `seed.sql` and `migrations/`. No named volume is declared; Drive's
  `/datalake` is an anonymous volume removed by `down --volumes`.
- `PS6-INT-15` asserts the teardown removed every network, every container and
  every project-labelled object. `docker ps -a` and `docker network ls` after the
  run showed **no** `ps6` container and **no** `ps6` network.
- No Production database, gateway, network, volume, migration, host port or `.env`
  was contacted at any point. Nothing was deployed, activated or exposed.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-public-share-architecture.md`
  — the PUBLIC-SHARE-6 rollout row now reads *internal acceptance passed; not
  deployed* and enumerates what was proven; the top warning callout records the
  new harness while keeping `Public Internet Share = NOT IMPLEMENTED`; a success
  callout records the three newly established facts (real-database migration 009
  evidence, the boot-enforced State B trusted-proxy pair, and the measurable
  timeout tuning).
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-status.md` — new
  PUBLIC-SHARE-6 section with the YES/NO posture, the run figures, and the
  explicit statement that G4, G5 and G6 remain open.

## Shared surfaces touched

- `gateway/public-share/integration/docker-compose.yml` — a new file under the
  infrastructure-owned `gateway/` boundary. It defines containers, three Docker
  networks and a database role model, so it needs integration-owner sight even
  though it is a test harness and no Production stack references it.
- `gateway/public-share/integration/db-init/00-aegis-drive.sh` — same boundary;
  it reproduces the production role/grant split and applies repository SQL.
- `gateway/public-share/integration/README.md` — same boundary; it documents a
  topology and a set of claims about B5.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-public-share-architecture.md`
  — an IDEA1-owned canonical note, but the contract it records spans the
  infrastructure-owned gateway boundary and the shared trusted-proxy/ingress
  behaviour.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-status.md` — same reason: it
  now carries a durable verification claim about the gateway and ingress
  boundaries, not only about IDEA1 application code.

No file under `IDEA1-AEGIS_Drive_LC/server/`, `IDEA1-AEGIS_Drive_LC/src/`,
`gateway/public-share/` (outside `integration/`), `postgres/`, `shared/`,
`docker-compose.yml` or `.env.example` changed.

## Integration requests

- **Kla infrastructure review of the harness topology**, specifically the
  judgement that a dual-homed gateway across two `internal` + `isolated` networks
  preserves B5. The reviewer should confirm that reaching one upstream is the
  intended capability and that no other reachability was introduced —
  `PS6-INT-13` probes the negative side (no default route, no PostgreSQL, no host
  bridge address).
- **Confirm the accepted reading of what this phase proves**: gateway↔Drive
  integration on an isolated internal network, not Production evidence and not
  Internet evidence. A container on an isolated Docker network is not a recipient
  on ordinary Internet access.
- **PS6-SERVER-GATE — not requested, not approved, not executed.** Any Stage B
  work that runs this or any successor harness against a real server is owner
  gated and was deliberately not attempted. Nothing in this PR requires it.
- Confirm that no shipped source changed and that the deliberate pre-009 database
  state is the right rehearsal shape for Production's 008-era database.
- Rollback is PR revert. There is no Production rollback because nothing was
  deployed, activated or migrated.

## Known limitations

- **Public Internet Share remains NOT IMPLEMENTED.** Production gateway = NO,
  Production migration 009 = NO, Production UI activation = NO, public
  DNS/TLS/NAT/tunnel/ingress = NO, external 4G/5G acceptance = NO. **G4, G5 and
  G6 remain open**, and PUBLIC-SHARE-7 was not started.
- **This is Stage A only.** The PS6-SERVER-GATE and everything behind it were not
  requested and not approved, so no server-side Stage B execution, no Production
  service restart, no Production data mount and no host-port or ingress change
  was attempted or claimed.
- **The hit counter increments before delivery, not on completion.**
  `server/routes/share.js` counts, then streams, so an authorised-then-interrupted
  download still counts one hit. `PS6-INT-7` records this as observed behaviour
  rather than asserting it is desirable; it means the counter measures authorised
  redemptions, not completed byte deliveries. No behaviour was changed here.
- **`PS6-INT-6` measures one 75 s stall, not a timeout matrix.** It demonstrates
  that the shipped 300 s values carry a stall the 60 s defaults would have cut,
  on this hardware. It does not establish a maximum tolerable stall, a throughput
  figure, or behaviour under sustained load — the architecture's load check
  before Internet exposure is a separate obligation.
- **An alternate-case spelling of the share route reaches Drive.** Both the
  gateway location/route map (`~*`) and Express's default routing are
  case-insensitive, so `/S/<token>` is a spelling of `/s/<token>` rather than a
  new surface. `PS6-INT-9` deliberately does **not** assert a 404 there; it
  asserts the security property that no spelling delivers the file without the
  link password. This is recorded so a future reader does not mistake the absence
  of a 404 assertion for an oversight.
- **Concurrency was exercised at 4, from one container.** That is a correctness
  check, not a capacity measurement, and it does not model many independent
  Internet clients on varied paths.
- **The recipient is a Docker container, so "slow" and "interrupted" are
  synthetic.** Real mobile networks add packet loss, MTU changes, re-ordering and
  mid-transfer address changes that this harness cannot produce.
- **The suite needs Docker and builds two images**, so it is opt-in and is not
  part of CI. It takes ~150 s after the images are cached, and the first run also
  pays the Drive image build.
- **PostgreSQL 15.18 is the observed version**, from `postgres:15-alpine`. No
  other version was tested and none is claimed. Production has still never had
  migration 009 applied.
- `npm test` retains the unrelated pre-existing `AUTOLOCK-5` failure and the
  intermittent `vaultChunkedUploadClient.test.js` timing flake, plus the existing
  React `act(...)` warnings and the >500 kB chunk warning. None was hidden or
  fixed here.
