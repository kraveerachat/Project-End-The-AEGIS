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
- `gateway/public-share/integration/run-stage-b.sh` — same boundary, and the
  strongest reason for integration review in this PR: it is the script that would
  run Docker **as root** on the AEGIS server host. Its guards, its refusal
  conditions and its teardown scope should be read line by line before anyone
  executes it.
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

## Stage B — gate APPROVED, execution NOT PERFORMED (appended 2026-09-08)

The owner approved the Stage B scope interpretation and then the PS6-SERVER-GATE
itself: run the same isolated harness on the AEGIS server hardware while touching
no existing production service, data, network, runtime Compose, `.env`, migration
or public ingress.

**Stage B was not executed.** This session has no working SSH path to the server
host, so no Stage B result exists and none is claimed.

- TCP `192.168.10.10:22` is reachable over Twingate and the host key is already
  trusted. The blocker is authentication: `ssh -v` previously reported
  `Server accepts key: ...id_ed25519_admin-main_thispc` — the public key **is**
  in `admin-main`'s `authorized_keys` — and then `Permission denied (publickey)`,
  because the private key is passphrase-protected and the signature step cannot
  complete without an agent.
- On this machine the Windows `ssh-agent` service is **Stopped / Disabled**,
  `ssh-add -l` returns `Error connecting to agent`, `SSH_AUTH_SOCK` is unset, and
  no agent process or named pipe exists. An agent loaded in another shell window
  is not visible to this session. Four authentication attempts were made across
  the task and then stopped, to avoid walking a production account into a
  lockout.
- Enabling the agent service is a system setting and was deliberately **not**
  changed. Passing or handling the key passphrase is out of the question.

### Preflight figures are OWNER-SUPPLIED, not measured here

The host, Docker, production-container, network, capacity and image figures used
to plan Stage B were supplied by the owner. They are recorded as owner-supplied
and are **not** reproduced or independently verified by this task, in the same
way the architecture note keeps owner-supplied acceptance separate from
repository-recorded evidence. Every one of the fourteen host facts remains
**NOT MEASURED** by this session.

### One preflight finding did change the harness

The owner's preflight established that on the server host the administrative
account is **not** in the `docker` group and `DOCKER_HOST` points at a Podman
socket that does not exist, so every Docker command must run as
`sudo env -u DOCKER_HOST docker`.

The Stage A harness hardcoded `docker`, so it could not have run there at all —
it would have failed on the daemon socket in a way that reads like a harness bug.
That is a real Stage B blocker independent of SSH, and it is now fixed:

- `IDEA1-AEGIS_Drive_LC/tests/publicShareInternalIntegration.test.js` — every
  Docker call now goes through `PS6_DOCKER` (default `docker`, split on
  whitespace so a wrapper with arguments works). No call site invokes `docker`
  directly.
- `gateway/public-share/integration/run-stage-b.sh` — **new**: a Stage B runner
  that refuses to start unless the daemon is reachable through the required
  wrapper, the temporary work directory is outside the production checkout, the
  three required base images are already present locally, the PS6 and
  `aegis_public_share` network names are free, and no existing network already
  uses `172.31.250-252.0/29`. It pins the source tree to PR #105 HEAD
  `ef77c00f1b17b4fa85511baeb760665d9aee2237` and verifies the SHA before
  building, never touching `/opt/aegis/Project-End-The-AEGIS`. It records a
  read-only pre/post inventory of containers, networks, volumes and images and
  diffs them, checks for surviving PS6 objects, and removes its temporary source.
  It never pulls, prunes, or starts/stops/restarts/execs a production container.
- `gateway/public-share/integration/README.md` — documents `PS6_DOCKER`,
  including the warning that on such a host the harness runs Docker as root while
  still creating only its own project, networks and anonymous volumes.

Re-verified after that refactor, on the developer machine:

- `PUBLIC_SHARE_INTEGRATION_RUNTIME=1 node --test --test-concurrency=1 --test-timeout=1800000 tests/publicShareInternalIntegration.test.js`
  — **passed: 16 tests, 16 passed, 0 failed, 0 skipped, 192.6 s**, with the
  default `PS6_DOCKER` (plain `docker`). Teardown clean: `docker ps -a` and
  `docker network ls` afterwards showed zero PS6 containers and zero PS6
  networks. The override therefore changes nothing when it is not set.
- `sh -n gateway/public-share/integration/run-stage-b.sh` — passed (syntax only).
- `sh run-stage-b.sh` with no argument, and with an abbreviated SHA — both
  refused, as designed, with exit code 2 and an actionable message. This is the
  only part of the runner with real runtime evidence; every Docker-touching path
  in it remains unexecuted.
- ⚠️ **The runner deliberately has no default source SHA.** An earlier draft
  hardcoded the Stage A commit `ef77c00…`, which was wrong the moment the runner
  existed: that commit predates the `PS6_DOCKER` override and therefore cannot
  run on the server host at all. A pinned default is also always one commit
  stale, because adding it changes the branch head. The SHA is now a required
  argument, validated as full 40-char lowercase hex and verified against the
  checkout before any build. **Stage B must be run against PR #105 HEAD at the
  time of the run — not against `ef77c00`.**
- The non-default `PS6_DOCKER` path — `sudo env -u DOCKER_HOST docker` — is
  **untested**, because this machine has neither `sudo` nor the server's daemon
  configuration. Its first real exercise will be the first Stage B run.

### Two requested post-run checks cannot be performed as written

The owner's post-run list asks to verify that Production migration 009 remains
NOT APPLIED and that the Public UI remains OFF. Both conflict with the same
instruction set: the first requires connecting to Production PostgreSQL, and the
second requires reading Production configuration — each explicitly forbidden.

The runner therefore does **not** attempt either. What it proves instead is that
no path to them existed: the pre/post inventory diff shows no production
container, network or volume changed, no PS6 container was ever attached to a
production network, no production volume was mounted, and the harness's own
PostgreSQL is a throwaway instance on an internal isolated network. That is an
argument from absence of contact, not a reading of the two values, and it is
recorded as such rather than presented as equivalent. Confirming the values
themselves is an owner-side read.

## Stage B runner amendment — still NOT EXECUTED (appended 2026-09-08, on the host)

This session runs **locally on the Beelink host `aegis-system`**, in a neutral
workspace at `/home/admin-main/aegis-ps6-claude/aegis-repo`, cloned fresh from
GitHub. `/opt/aegis/Project-End-The-AEGIS` was **not** cloned into, read, fetched,
checked out, modified or built from at any point. The earlier SSH blocker is
therefore gone; **Stage B was still not executed**, and nothing below claims
otherwise.

No sudoers file, group membership, passwordless-sudo setting, global
`DOCKER_HOST`, Docker service or Podman service was changed, and no sudo password
was requested, captured, stored, echoed or handled.

### Why the previous runner was not safe to run

Six defects, each of which would only have shown up on the production host:

1. **It did not own its Compose project.** The suite chose
   `aegis-ps6-${process.pid}` inside its own process — a name the launching
   script cannot know. So the runner's teardown named a project that never
   existed, while the real one kept its containers, networks, volumes and two
   built images. **This is not hypothetical: a dry run reproduced it** (the
   runner owned `aegis-ps6-stage-b-20260908-144116-1903775`; `compose up` ran
   under `aegis-ps6-1903863`).
2. **No cleanup trap.** A `Ctrl-C`, a `SIGTERM`, or any guard failure after
   `compose up` left the whole stack running on a production host.
3. **No built-image cleanup.** Two images were built per run and never removed.
4. **Evidence files escaped their own cleanup.** `$WORKDIR.pre` and
   `$WORKDIR.post` are *siblings* of `$WORKDIR`, so `rm -rf "$WORKDIR"` left them
   behind, every run, forever.
5. **The pre/post comparison could not pass.** It diffed
   `docker ps --format '{{.Status}}'`, i.e. the human string `Up 4 days
   (healthy)`, whose uptime advances between the two snapshots. A guaranteed
   false positive is not a check.
6. **Interactive sudo inside Node.** `DOCKER="sudo env -u DOCKER_HOST docker"`
   invoked through `execFile`/`spawn` would block on a password prompt that
   nothing can answer.

### Runner changes

`gateway/public-share/integration/run-stage-b.sh`

- **Owned project.** `PS6_PROJECT` is minted as
  `aegis-ps6-stage-b-<UTC timestamp>-<pid>` before any Docker object exists, or
  accepted from the caller, and is validated against
  `^aegis-ps6-[a-z0-9][a-z0-9_-]*$`, a 64-character cap, an exact-match
  blocklist and a `*prod*` substring refusal. It is exported to the suite, so
  runner and suite name the same project for the whole run.
- **Cleanup trap on `EXIT`/`INT`/`TERM`,** armed *before* anything is created.
  `INT`/`TERM` only choose the exit status; `EXIT` performs the teardown, so
  there is exactly one cleanup path however the script ends. Both halves are
  idempotent, so the main flow can call them in order (to measure the post-state
  *after* cleanup) and the trap re-runs them harmlessly.
- **What cleanup may remove:** the one Compose project; the three PS6 networks;
  the project's anonymous volumes; the images the project built; the one owned
  temporary directory. Nothing else is reachable — every destructive command is
  filtered by `$PS6_PROJECT`, and there is **no `prune` of any kind** in the
  file (`system`, `image`, `volume` or `builder`).
- **Built-image cleanup is Compose's own scoping,** not a filter written by
  hand: `down --rmi local` removes only images with no custom tag, and
  `postgres:15-alpine`, `node:20-alpine` and `nginx:alpine` all carry an explicit
  `image:` key. A second sweep by repository prefix catches stragglers, and
  refuses any candidate that is a base image or matches `aegis-prod`/`aegis_prod`
  even if it somehow matched the prefix.
- **One owned temporary directory.** `/tmp/$PS6_PROJECT/` holds `src/` (the
  pinned source tree) and `evidence/` (pre, post, diff). `PS6_WORKDIR` is refused
  unless it is under `/tmp/aegis-ps6-`. No sibling file is created anywhere.
- **Stable inventory instead of uptime strings.** For every container outside the
  project: name, container ID, image ID, Compose project label, running state,
  health state (`none` when no healthcheck exists) and every network attachment
  with its IP — plus every network (ID, name, driver, scope), volume and image.
  Sorted under `LC_ALL=C`, so the diff is deterministic.
- **Post-cleanup checks,** each failing the run independently: the inventory is
  byte-identical; no production container reports an unhealthy state;
  `aegis_postgres_data` and `aegis_drive_storage` still exist; no PS6 container,
  volume, network or image survives; every built image is gone **by ID**; all
  three base images are still present; every `aegis-prod` row is unchanged; and
  nothing matches `/tmp/aegis-ps6-*` or `/tmp/ps6-stage-b*`.
- **Guard 7 — the pinned source must honour `PS6_PROJECT`.** Added *because the
  dry run caught defect 1*. Against a tree whose suite still picks its own pid
  project, the runner would clean an empty project and report success while the
  real one leaked. Ownership is verified against the pinned tree, not assumed
  from the branch name.
- **Source verification is stricter.** The 40-char lowercase-hex SHA is still
  required and never defaulted; additionally the checkout must resolve to exactly
  that SHA **and** the SHA must be an ancestor of
  `origin/feat/idea1-public-share-internal-integration`, so a valid commit from
  some other branch is refused.
- **Host-side `npm ci` removed.** See below.

`IDEA1-AEGIS_Drive_LC/tests/publicShareInternalIntegration.test.js`

- `PROJECT` now resolves from `PS6_PROJECT` with the same validation, throwing
  immediately on an invalid value. Unset keeps the previous `aegis-ps6-<pid>`
  default, so a developer machine behaves exactly as before.
- `PS6-INT-15` additionally asserts that no volume carries the project label
  after `down --volumes`, and that `postgres:15-alpine` and `node:20-alpine` are
  still present — the cheap negative that would catch a future `--rmi all`.

`gateway/public-share/integration/README.md` — documents `PS6_PROJECT`, the
owner-mediated sudo model, what the cleanup trap may and may not remove, the
stable-inventory rationale, and why there is no host-side `npm ci`.

### Sudo / privilege execution model

The runner never prompts for a credential and never handles one. It uses
`sudo -n` exclusively.

1. The **owner** runs `sudo -v` by hand, in their own terminal.
2. Guard 0 checks `sudo -n true`. If that fails the runner **refuses to start**
   with exit 2 and tells the owner to run `sudo -v` — it does not retry, and it
   does not fall back to an interactive path.
3. Every Docker child process is `sudo -n env -u DOCKER_HOST docker …`, both from
   the script and from Node's `execFile`/`spawn` via `PS6_DOCKER`. A password
   prompt therefore cannot appear anywhere a process could not answer it.
4. If authorisation lapses mid-run, cleanup **fails closed**: it prints the exact
   commands the owner must run by hand (`sudo -v`, the project-scoped
   `compose down`, the label query, the `rm -rf`) and returns non-zero. It does
   not retry with interactive credential handling.
5. The bounded keepalive is opt-out (`PS6_SUDO_KEEPALIVE=0`), runs `sudo -n -v`
   every 50 s, is capped by `PS6_SUDO_KEEPALIVE_MAX_SECONDS` (default 5400 s),
   and is killed by the cleanup trap. Because `-n` cannot prompt, it can only
   refresh a timestamp the owner already created — it can never create one.

Nothing persists a credential. `DOCKER_HOST` is unset **per child process** via
`env -u`; the host's global setting is untouched.

### Host-side `npm ci` removed

The acceptance suite imports `node:test`, `node:assert/strict`,
`node:child_process`, `node:crypto`, `node:fs/promises`, `node:url` and
`node:util` — Node built-ins, every one. It loads nothing from `node_modules`, so
the host-side `npm ci` installed roughly a thousand packages the run never
touched. Removing it deletes a host mutation, removes the audit noise, and
*shrinks* the Drive build context, because this repository ships no
`.dockerignore` for `IDEA1-AEGIS_Drive_LC` and a populated `node_modules` would
otherwise be uploaded to the daemon on every build.

**The Drive image is unaffected.** It is still built from the shipped
`IDEA1-AEGIS_Drive_LC/Dockerfile`, which runs its own `npm ci` inside its build
stage. **No Dockerfile was modified.**

### Stage A verification after the amendment

Run on `aegis-system`, Node **v22.22.1**, in the neutral workspace clone.

- `node --test --test-concurrency=1 --test-timeout=120000 "tests/**/*.test.js"` —
  **passed: 1,152 tests, 1,081 passed, 0 failed, 0 cancelled, 71 skipped,
  271.4 s.** PostgreSQL-only tests stayed skipped without `TEST_DATABASE_URL`.
- ⚠️ **A previously recorded failure did not reproduce, and the earlier note is
  now wrong.** The Stage A entry above records `AUTOLOCK-5` failing on
  `doesNotMatch(/ADD COLUMN/i)`. It passes here, and
  `node --test tests/vaultAutoLockDuration.test.js` passes 9/9: the test strips
  SQL line comments before asserting, so migration 008's comment can no longer
  trip it. The earlier figures (1,080 passed / 1 failed) are left in place
  unedited as the record of what that run actually reported; **this run's figures
  are 1,081 passed / 0 failed and are the ones being claimed now.**
- `node --test tests/publicShareGatewayStructure.test.js` — passed: **12 tests,
  12 passed, 0 failed.** The PUBLIC-SHARE-3 structural contract is unaffected.
- `node --test tests/publicShareInternalIntegration.test.js` (no env var) —
  passed: 1 test, 0 passed, 1 skipped. The harness stays inert by default, and
  stays inert with a valid `PS6_PROJECT` set.
- `PS6_PROJECT` validation, four cases: `aegis-prod`, `ps6-run`,
  `aegis-ps6-Bad` and a 70-character name were each **refused** at module load
  with the explanatory error; `aegis-ps6-stage-b-20260908-120000` was accepted.
- `node scripts/validate-vault.mjs --vault Obsidian_AEGIS_Vault/AEGIS_Knowledge`
  — passed with the same two pre-existing owner-review canvas warnings.
- `node --test tests/collaborationPolicy.test.mjs` — passed: **18 tests, 18
  passed, 0 failed.**
- `sh -n gateway/public-share/integration/run-stage-b.sh` — passed.
- `git diff --check`, `git diff --cached --check`, `git status --short` — clean;
  no whitespace error and no unintended path.

⚠️ **`PUBLIC_SHARE_INTEGRATION_RUNTIME=1` 16/16 was NOT re-run, deliberately.**
On this host that command builds two images and starts four containers through
the production Docker daemon as root — which *is* Stage B. There is no second
daemon and no developer machine here, so re-running it is not a Stage A check
that happens to need Docker; it is the gated run itself. The instruction to stop
before Stage B wins over the instruction to re-run it. **The 16/16 figure being
carried forward is the Stage A figure from the developer machine, unchanged and
not re-measured on this host.**

### Runner evidence: every refusal, the trap and the interrupt path

Driven against a **recording Docker/sudo stub** on this host — no daemon
contacted, no privilege used, nothing mutated. This proves the runner's own
control flow and **nothing whatsoever about Production**.

Refusals, all exit 2 or 1, all before anything was created:

| Input | Result |
| :--- | :--- |
| no SHA | refused, with the `git ls-remote` command to find it |
| `fb02537` (abbreviated) | refused — must be the full 40 characters |
| `ZZ02537…` (non-hex) | refused — must be 40-char lowercase hex |
| `PS6_PROJECT=aegis-prod` | refused — fails the `aegis-ps6-` pattern |
| `PS6_PROJECT=ps6-run` | refused — fails the `aegis-ps6-` pattern |
| `PS6_PROJECT=aegis-ps6-prod-test` | refused — may not contain `prod` |
| `PS6_WORKDIR=/opt/aegis/Project-End-The-AEGIS/tmp` | refused — must be `/tmp/aegis-ps6-*` |
| no `sudo -n` authorisation | refused — tells the owner to run `sudo -v`; no prompt |
| pinned SHA `fb02537…` | **refused by guard 7** — that tree does not read `PS6_PROJECT` |

Full green path, against a local mirror pinned to `6a3775da…` (a copy of the
runner with only `REPO_URL` repointed at that mirror; `diff` confirmed the copy
differs from the shipped file in that one line):

- `compose up` ran as `-p aegis-ps6-stage-b-20260908-145022-1910254` — **the
  runner's project, not a pid the runner cannot see.**
- Built images captured before cleanup: `…-drive:latest`
  (`sha256:img_ps6_drive`) and `…-public-share-gateway:latest`
  (`sha256:img_ps6_gateway`).
- After cleanup: **`removed: sha256:img_ps6_drive`**, **`removed:
  sha256:img_ps6_gateway`** — verified by ID, not by name.
- **`preserved: postgres:15-alpine`, `node:20-alpine`, `nginx:alpine`.**
- Pre/post inventory **IDENTICAL**: both production containers matched on
  container ID, image ID, Compose project, running state, `healthy`, and network
  attachment; every network, volume and image row unchanged.
- `aegis_postgres_data` and `aegis_drive_storage` present; 4 `aegis-prod` rows
  unchanged.
- No PS6 container, volume, network or image survived.
- `/tmp/aegis-ps6-stage-b-…` **removed**; `nothing matches /tmp/aegis-ps6-* or
  /tmp/ps6-stage-b*`.
- The acceptance itself exited 1, as intended — the stub is not a Docker daemon
  and cannot start containers. The run's purpose was the surrounding machinery.

Interrupt path — `SIGINT` to the process group (what `Ctrl-C` at a terminal
does) while `compose up` was in flight, with both built images present:

- the trap fired and issued, in order: `compose -p <project> -f <file> down
  --volumes --remove-orphans --rmi local --timeout 10`; the three label-scoped
  sweeps for containers, volumes and networks; the repository-prefix image sweep;
  then `rm -rf` of the owned directory;
- afterwards: no PS6 image, **`NONE`** for `/tmp/aegis-ps6-*`;
- **`grep -c prune` over the complete recorded command log of every run: `0`.**

### Proof obligations that remain open

- The `sudo -n env -u DOCKER_HOST docker` path has still **never reached a real
  Docker daemon**. Its first real exercise is the first Stage B run.
- Everything in the section above is stub evidence. It says the runner does the
  right things in the right order; it says nothing about how a real daemon, a
  real build or the real production containers behave.
- No image was built, no container started, no network created and no volume
  written on this host by this session.

### Stage B boundaries, all still in force and all still unexercised

Not done, not attempted, not claimed: stop/restart/recreate/exec into
`aegis-prod`; attach a production container to a PS6 network; use Production
PostgreSQL; mount Production storage; edit Production Compose or Production
`.env`; apply migration 009 to Production; enable the Public UI; publish a host
port; configure DNS/TLS/NAT/tunnel; change MikroTik/UFW/VLAN/Twingate; run
PUBLIC-SHARE-7; prune anything; mark PR #105 Ready; merge.

PR #105 remains **Draft**.

## Stage B attempt #1 — EXECUTED, FAILED SAFELY (appended 2026-09-08)

⚠️ **This attempt is recorded as it happened. Nothing below is edited or removed
by the amendment that follows it.**

Run on the `aegis-system` host against PR #105 HEAD
`160612de791f65ce094cafa6f6b357e82012c027`, project
`aegis-ps6-stage-b-20260908-161132-1950905`.

| Fact | Result |
| :--- | :--- |
| How far execution got | **Compose interpolation only** |
| Acceptance matrix | **NOT EXECUTED** — 1 test, 0 passed, 1 failed, 577 ms |
| Root cause | the PS6 **throwaway** Compose variables were stripped at the `sudo` boundary |
| PS6 stack created | **none** — no container, network, volume or image |
| Cleanup | **PASS** |
| Production pre/post identity | **IDENTICAL** |
| Production services | **all healthy** |
| Runner RC | **1** |
| Product defect found | **none** |

Guards 0–7 all passed: `sudo -n` was authorised, the daemon answered
`server 29.7.1`, the project name and the three PS6 network names were free, the
three base images were present, no network used `172.31.250-252.0/29`, the source
tree resolved to exactly `160612de…` and was contained in the PR branch, and the
pinned suite honoured `PS6_PROJECT`.

Execution then stopped at the first Compose invocation:

```
Command failed: sudo -n env -u DOCKER_HOST docker compose -p aegis-ps6-stage-b-… \
  -f …/docker-compose.yml up --build -d --wait --wait-timeout 300
error while interpolating services.drive.environment.SESSION_SECRET:      required variable PS6_SESSION_SECRET is missing a value
error while interpolating services.postgres.environment.DRIVE_DB_PASSWORD: required variable PS6_DRIVE_DB_PASSWORD is missing a value
error while interpolating services.postgres.environment.POSTGRES_PASSWORD: required variable PS6_SUPER_PASSWORD is missing a value
error while interpolating services.postgres.environment.POSTGRES_USER:     required variable PS6_SUPER_USER is missing a value
```

### Root cause

The acceptance suite generates `PS6_SUPER_USER`, `PS6_SUPER_PASSWORD`,
`PS6_DRIVE_DB_PASSWORD` and `PS6_SESSION_SECRET` as throwaway random values in
its own child environment. `PS6_DOCKER` on this host is

```
sudo -n env -u DOCKER_HOST docker
```

and a process environment does not cross a `sudo` boundary — sudo **correctly**
declined to carry arbitrary `PS6_*` variables. Compose therefore saw none of the
four and refused to interpolate.

**This is a harness credential-plumbing defect, not a product defect.** No
shipped gateway, backend, UI or database behaviour is implicated, and nothing in
the failure says anything about the product under test.

### What the failure cost, and did not cost

The same missing values also broke the runner's own teardown: `cleanup — Docker
objects owned by project …` emitted the identical four interpolation errors,
because a `compose down` interpolates the file it is handed just as `up` does.
That teardown consequently did nothing — which was harmless **only** because
`compose up` had already failed before creating anything. Had the failure come
one step later, the project-scoped `down` would have been unable to remove a live
stack. That is the second defect this amendment fixes.

All post-run checks passed anyway, through the label-scoped sweeps and the
inventory diff:

- pre/post inventory **IDENTICAL** — every production container ID, image ID,
  Compose project, running state, health state and network attachment matched, as
  did every network, volume and image outside the project;
- all five containers `running=true health=healthy`
  (`aegis-prod-drive-1`, `-hub-1`, `-monitor-1`, `-postgres-1`,
  `twingate-aegis-connector-02`);
- `aegis_postgres_data` and `aegis_drive_storage` present;
- **50 `aegis-prod` rows, all unchanged**;
- no PS6 container, volume, network or image survived — because none was ever
  created;
- the three base images preserved;
- `/tmp/aegis-ps6-stage-b-20260908-161132-1950905` removed; nothing matched
  `/tmp/aegis-ps6-*` or `/tmp/ps6-stage-b*`;
- post-run check failures: **0**. Runner exit code **1**, from the acceptance.

Nothing in the forbidden list was touched: no
`/opt/aegis/Project-End-The-AEGIS`, no aegis-prod restart/recreate/exec, no
Production PostgreSQL, no `aegis_postgres_data` or `aegis_drive_storage` mount,
no Production Compose or `.env` edit, no Production migration 009, no Public UI,
no host port, no DNS/TLS/NAT/tunnel/MikroTik/UFW/VLAN/Twingate change, no prune,
no PUBLIC-SHARE-7, PR #105 still Draft, not merged.

## Stage B credential-plumbing amendment — explicit Compose env file (appended 2026-09-08)

**Stage B was NOT re-run.** This amendment is code, tests and documentation only.

### The rule this fix had to obey

The privilege boundary is unchanged and stays unchanged. **Not** used, anywhere:
`sudo -E`, `sudo --preserve-env`, a sudoers `env_keep` entry, a docker-group
change, passwordless sudo, or any global environment change. The entry point is
still exactly

```
DOCKER="sudo -n env -u DOCKER_HOST docker"
```

The insight is that an **argument** crosses a privilege boundary that an
**environment variable** does not. So the four values travel as a file path.

### Design

| Piece | Behaviour |
| :--- | :--- |
| `PS6_COMPOSE_ENV_FILE` | new, opt-in. Absolute path, and — when `PS6_WORKDIR` is set — required to be **inside** it. Invalid values throw at module load. |
| Default in the runner | `$PS6_WORKDIR/evidence/compose.env`, i.e. inside the one temporary directory the runner already owns and already cleans up. |
| Contents | exactly four lines: `PS6_SUPER_USER`, `PS6_SUPER_PASSWORD`, `PS6_DRIVE_DB_PASSWORD`, `PS6_SESSION_SECRET`. Nothing else is ever written. Values are still minted per run with `randomBytes`; each is refused unless it matches `[A-Za-z0-9_-]+`, so nothing can be injected into the file's syntax. |
| Every Compose call | `docker compose --env-file <path> -p <project> -f <file> …`. `--env-file` is a **top-level** flag and is emitted **before** `-p` and `-f` and before the subcommand; after the subcommand it is a different, service-scoped flag that supplies no interpolation. |
| Unset | the developer-machine path, byte-for-byte unchanged: no file, no `--env-file`, Compose reads the inherited environment as before. |

### Permission and lifetime model

- Created by the runner **before the suite starts**, as
  `(umask 077; : > "$PS6_COMPOSE_ENV_FILE")`, then an explicit `chmod 600`, then a
  verified `stat -c '%a'` that must read `600` or the run refuses. There is never
  a window at a wider mode.
- Written by the suite with `writeFile(…, { mode: 0o600 })`, then `chmod` again
  (Node's `mode` is masked by the umask on create and ignored on truncate), then
  a `stat` check inside the suite — so Stage B carries its own permission
  evidence in its own output.
- **Never printed.** The runner echoes the path and the mode; nothing reads,
  `cat`s, sources or logs the contents. The suite's error paths name keys only.
- **Never committed.** It only ever exists under `/tmp/$PS6_PROJECT/`.
- Removed by the **existing** cleanup trap: explicitly by name, then with the
  whole directory, on success, on failure and on `INT`/`TERM`. A new post-run
  check fails the run if it survives.

### Cleanup behaviour

The runner's own teardown now supplies the same file:

```sh
$DOCKER compose --env-file "$PS6_COMPOSE_ENV_FILE" -p "$PS6_PROJECT" -f "$COMPOSE_FILE" \
  down --volumes --remove-orphans --rmi local --timeout 10
```

If the file is missing or empty — a run that died before the suite could write it
— that project-scoped `down` is **skipped**, because without interpolation it
could only fail, and the teardown falls through to what needs no interpolation at
all:

- containers, volumes and networks swept by
  `label=com.docker.compose.project=$PS6_PROJECT`;
- images swept by the `$PS6_PROJECT-` repository prefix, with an explicit refusal
  for the three base images and for anything matching `aegis-prod`/`aegis_prod`;
- protected volumes `aegis_postgres_data` and `aegis_drive_storage` refused by
  name;
- no `prune` of any kind, as before;
- if `sudo -n` has lapsed, cleanup still **fails closed** and prints the exact
  by-hand commands — now including `--env-file` when the file exists, and a note
  that a project-scoped `down` is not possible when it does not.

### Guard 8

New, and the same shape as guard 7. It refuses a pinned source tree whose
acceptance suite does not read `PS6_COMPOSE_ENV_FILE` and does not pass
`--env-file`, because such a tree would reach exactly as far as attempt #1 did —
on a production host, before anyone found out. Verified to discriminate:

```
$ git show 160612de:…/publicShareInternalIntegration.test.js | grep -c PS6_COMPOSE_ENV_FILE
0          # the attempt #1 source — guard 8 refuses it
$ grep -c PS6_COMPOSE_ENV_FILE …/publicShareInternalIntegration.test.js
3          # the amended source — guard 8 accepts it
```

### The regression that reproduces the server condition

`IDEA1-AEGIS_Drive_LC/tests/publicShareStageBCredentialPlumbing.test.js` — new,
9 tests, **no Docker, no sudo, no daemon, no network, no privilege**.

The sudo boundary is modelled by a wrapper that strips the environment *harder*
than sudo does — `env -i PATH=… HOME=…`, where sudo keeps a small whitelist — and
Docker is modelled by a recorder that implements only Compose's interpolation
rule. The recorder logs argv, the surviving `PS6_*` keys, and for each resolved
variable its **source** and a **sha256 of its value**; it never logs a value.

| Test | What it proves |
| :--- | :--- |
| PS6-ENV-1 | no `sudo -E`, `--preserve-env`, `env_keep`, `NOPASSWD`, sudoers edit, `usermod`/`gpasswd`/`adduser`, `docker.sock` permission change or `prune` in the runner or the suite; after blanking quoted strings, **every** executed `sudo` is `sudo -n`; exactly one privileged entry point, still `sudo -n env -u DOCKER_HOST docker` |
| PS6-ENV-2 | one env file, defaulted under the owned evidence directory, refused outside `PS6_WORKDIR` or containing `..`, created `umask 077` + `chmod 600` + verified `stat`, handed to the suite, used by the teardown with `--env-file` before `-p`/`-f`, removed and checked; contents never `cat`/`head`/`tail`/`od`/`xxd`/`base64`'d or sourced |
| PS6-ENV-3 | the suite emits `--env-file` before `-p`/`-f`; writes **exactly** the four keys; mints them with `randomBytes`; reads no `.env`; names no `aegis-prod` object, no Production volume and no Production address |
| PS6-ENV-4 | path validation at module load: relative **refused**, outside `PS6_WORKDIR` **refused**, climbing out with `..` **refused**, inside **accepted** (harness still skipped), unset **accepted** (developer path) |
| **PS6-ENV-5** | **the regression.** Across the stripping boundary: no `PS6_*` variable survives it; `compose up` carries `--env-file <path>` as its first top-level flag, before `-p`/`-f`; interpolation **succeeds**; all four values resolve with source `env-file` — there is no environment left for them to come from; their sha256 digests match the file on disk, so they crossed intact; the file is `0600`; **not one of the four values appears anywhere in the run's output or in the recorder's log**; the suite's own teardown uses the same file |
| **PS6-ENV-6** | **the negative control.** Same boundary, `PS6_COMPOSE_ENV_FILE` unset → no `--env-file`, interpolation **fails**, all four reported missing, and the output carries the exact attempt #1 text `required variable PS6_SUPER_USER is missing a value` (and the other three). The regression therefore reproduces the server condition rather than asserting it |
| PS6-ENV-7 | the **real runner**, driven against non-privileged `sudo`/`docker`/`git` stubs, creates the env file and then fails at `git clone`: the env file and the whole `/tmp/aegis-ps6-…` directory are **gone** |
| PS6-ENV-8 ×2 | `SIGINT` and `SIGTERM` delivered to the runner's process group while the env file is on disk: file **gone**, directory **gone**, exit non-zero |

### Files changed

- `IDEA1-AEGIS_Drive_LC/tests/publicShareInternalIntegration.test.js` —
  `COMPOSE_INTERPOLATION_KEYS`, `resolveComposeEnvFile()` (module-load
  validation), `writeComposeEnvFile()` (0600, four keys, charset-checked, never
  printed), and `--env-file` in the single `compose()` helper every Compose call
  already went through.
- `IDEA1-AEGIS_Drive_LC/tests/publicShareStageBCredentialPlumbing.test.js` —
  **new**, the nine tests above.
- `gateway/public-share/integration/run-stage-b.sh` — `PS6_COMPOSE_ENV_FILE`
  definition and validation, `umask 077` creation with a verified mode, guard 8,
  the variable handed to the suite alongside `PS6_WORKDIR`, `--env-file` in the
  project teardown with the empty-file fallback, explicit removal in
  `cleanup_workdir`, the fail-closed by-hand instructions updated, and a new
  post-run check that the file is gone.
- `gateway/public-share/integration/README.md` — the third environment variable,
  why it exists, the top-level-flag rule, the permission and lifetime model, the
  teardown behaviour and its fallback, and guard 8.
- This receipt, and the PUBLIC-SHARE-6 paragraph in `idea1/idea1-status.md`.

**No shipped gateway, backend, UI, database, Dockerfile, Production Compose or
`.env.example` file changed.** `docker-compose.yml` under
`gateway/public-share/integration/` was **not** modified — `--env-file` supplies
the same interpolation the file already declared.

### Verification after the amendment — non-Production only

Run on `aegis-system`, Node **v22.22.1**, in the neutral workspace clone at
`/home/admin-main/aegis-ps6-claude/aegis-repo`.

- `node --test --test-concurrency=1 --test-timeout=180000 tests/publicShareStageBCredentialPlumbing.test.js`
  — **passed: 9 tests, 9 passed, 0 failed, 6.2 s.** This is both the
  sudo/environment-stripping regression and the cleanup/refusal evidence.
- `node --test --test-concurrency=1 --test-timeout=120000 "tests/**/*.test.js"` —
  **passed: 1,161 tests, 1,090 passed, 0 failed, 0 cancelled, 71 skipped,
  277.3 s.** (Was 1,152 / 1,081 before; the nine new tests are the difference.)
  PostgreSQL-only tests stayed skipped without `TEST_DATABASE_URL`.
- `node --test tests/publicShareInternalIntegration.test.js` (no env var) —
  **1 test, 0 passed, 1 skipped.** The harness is still inert by default.
- `node --test tests/publicShareGatewayStructure.test.js` — **12 tests, 12
  passed, 0 failed.**
- `sh -n gateway/public-share/integration/run-stage-b.sh` — passed.
- Runner refusals, re-driven by hand, every one before anything was created:

  | Input | Result |
  | :--- | :--- |
  | no SHA | refused, exit 2 |
  | `fb02537` (abbreviated) | refused, exit 2 |
  | 40 non-hex characters | refused, exit 2 |
  | `PS6_PROJECT=aegis-prod` | refused — fails the `aegis-ps6-` pattern |
  | `PS6_PROJECT=aegis-ps6-prod-test` | refused — may not contain `prod` |
  | `PS6_WORKDIR=/opt/aegis/Project-End-The-AEGIS/tmp` | refused — must be `/tmp/aegis-ps6-*` |
  | `PS6_COMPOSE_ENV_FILE=/tmp/elsewhere.env` | **refused — must be inside `PS6_WORKDIR`** |
  | `PS6_COMPOSE_ENV_FILE=/tmp/aegis-ps6-x/../escape.env` | **refused — may not contain `..`** |

  `ls -d /tmp/aegis-ps6-*` afterwards: **nothing.**
- `node --test tests/collaborationPolicy.test.mjs` — **18 tests, 18 passed, 0
  failed.**
- `node scripts/validate-vault.mjs --vault Obsidian_AEGIS_Vault/AEGIS_Knowledge`
  — passed, with the same two pre-existing owner-review canvas warnings.
- `git diff --check`, `git diff --cached --check`, `git status --short` — clean.

⚠️ **`PUBLIC_SHARE_INTEGRATION_RUNTIME=1` 16/16 was again NOT re-run.** On this
host that command builds images and starts containers through the production
Docker daemon as root — which *is* Stage B. The carried-forward 16/16 remains the
developer machine's Stage A figure and is labelled as such.

### What is still unproven

- **The fix has never met a real `sudo` or a real Docker daemon.** PS6-ENV-5
  proves Compose receives the four values only through `--env-file` across a
  boundary that strips the environment; it does not prove how Docker Compose
  29.x, the production daemon or the real build behave. Stage B attempt #2 is the
  first real exercise.
- Stage B attempt #1 reached Compose interpolation and stopped, so **the
  acceptance matrix has still never run on server hardware.** No PS6-INT result
  in this receipt is a server result.
- Production migration 009 and the Public UI flag were, again, not read — doing
  so requires connecting to Production PostgreSQL or reading Production
  configuration, both out of scope. Their state is unchanged because nothing here
  writes to them.

**Stage B was not re-run. PUBLIC-SHARE-7 was not started. PR #105 remains Draft
and is not merged.**

## Known limitations

- **Public Internet Share remains NOT IMPLEMENTED.** Production gateway = NO,
  Production migration 009 = NO, Production UI activation = NO, public
  DNS/TLS/NAT/tunnel/ingress = NO, external 4G/5G acceptance = NO. **G4, G5 and
  G6 remain open**, and PUBLIC-SHARE-7 was not started.
- **This is Stage A only, and Stage B is gate-approved but unexecuted.** The
  PS6-SERVER-GATE was approved by the owner on 2026-09-08; execution did not
  happen, for the SSH reason recorded in the Stage B section. No server-side run,
  no Production service restart, no Production data mount, no host-port and no
  ingress change was attempted or claimed. `run-stage-b.sh` is written and
  syntax-checked but **has never been executed anywhere**, so it carries no
  runtime evidence of its own — its guards are unproven until a real run.
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
