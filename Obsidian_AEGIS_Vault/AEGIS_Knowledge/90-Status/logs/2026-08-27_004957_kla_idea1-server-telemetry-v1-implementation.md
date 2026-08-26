---
title: Task Receipt — IDEA1 Server Telemetry V1 implementation
date: 2026-08-27T00:49:57+07:00
owner: kla
area: idea1
branch: feat/idea1-server-telemetry-v1
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA1 Server Telemetry V1 implementation

`SERVER_TELEMETRY_V1_IMPLEMENTATION = IMPLEMENTED / LOCALLY VERIFIED / NOT DEPLOYED`

`PRODUCTION_DEPLOYMENT = NOT PERFORMED`
`PRODUCTION_ACCEPTANCE = NOT STARTED`

Server Telemetry production availability remains **unclaimed**. Nothing in this
task touched a running host, container, gateway, firewall, or database.

## What changed

Server Telemetry moved from a UI contract with no data source to an implemented,
locally verified feature that is **not deployed**.

- A dedicated least-privilege host telemetry agent (`shared/host-telemetry-agent/`)
  reads five allowlisted files — `/proc/stat`, `/proc/meminfo`, `/proc/uptime`,
  and the `rx_bytes`/`tx_bytes` counters for the explicitly configured interface
  `enp1s0` — samples them on a ~5 s background timer, and serves one normalized
  snapshot on a Unix socket at `GET /internal/telemetry`. No TCP listener, no
  shell execution, no capability, no Docker socket, no host PID namespace.
- Drive gained a strict-validating client and an authenticated
  `GET /api/telemetry` that combines host metrics with two things Drive can
  already measure itself: Data Lake capacity (`statfs`, reusing the existing
  `filesystemCapacity()`) and Drive process uptime. Twingate is reported
  explicitly unavailable with reason `no-approved-source`.
- The Dashboard tiles now render real measurements, poll every 10 s, and
  distinguish three states: available, **stale** (host data older than 15 s,
  shown and labelled rather than blanked), and unavailable. An unavailable
  metric renders no number at all — never a fabricated `0`.

Architecture: **OPTION_B** (host-native dedicated agent). Disk is deliberately
**not** collected by the agent; Drive measures its own mount.

## Source files changed

Host telemetry agent — new package:

- `shared/host-telemetry-agent/package.json` — standalone ESM package, `node --test`
- `shared/host-telemetry-agent/README.md` — contract, design rationale, limits
- `shared/host-telemetry-agent/src/parsers.js` — pure `/proc` and `/sys` parsers plus CPU/network delta maths
- `shared/host-telemetry-agent/src/config.js` — approved constants; explicit interface validation
- `shared/host-telemetry-agent/src/sources.js` — the only I/O edge; five fixed absolute paths
- `shared/host-telemetry-agent/src/sampler.js` — background sampler holding one in-memory snapshot
- `shared/host-telemetry-agent/src/server.js` — Unix-socket HTTP service, strict output allowlist, safe stale-socket reclamation
- `shared/host-telemetry-agent/src/agent.js` — side-effect-free assembly
- `shared/host-telemetry-agent/src/index.js` — process entry with signal handling
- `shared/host-telemetry-agent/tests/parsers.test.js` — TELEM-1A/1B/2A/4A/4B/6A
- `shared/host-telemetry-agent/tests/sampler.test.js` — TELEM-SAMPLER-1..6
- `shared/host-telemetry-agent/tests/socket.test.js` — TELEM-SOCKET-1..7, TELEM-11B
- `shared/host-telemetry-agent/tests/config.test.js` — interface boundary, TELEM-11G
- `shared/host-telemetry-agent/tests/agent.test.js` — read surface, no-shell and no-TCP structural proofs
- `shared/host-telemetry-agent/tests/deploy.test.js` — asserts the unit's required and forbidden directives

Deployment packaging — prepared, **not installed**:

- `shared/host-telemetry-agent/deploy/aegis-telemetry.service`
- `shared/host-telemetry-agent/deploy/aegis-telemetry.sysusers.conf` — pins GID 29100
- `shared/host-telemetry-agent/deploy/README.md` — per-directive rationale and the required Linux-host verification block
- `shared/host-telemetry-agent/deploy/production-delta.md` — the proposed, **unapplied** Drive Compose delta

Drive backend:

- `IDEA1-AEGIS_Drive_LC/server/telemetry/schema.js` — strict fail-closed validation of the agent contract; 15 s stale threshold
- `IDEA1-AEGIS_Drive_LC/server/telemetry/client.js` — Unix-socket-only client, 1500 ms cap, never throws
- `IDEA1-AEGIS_Drive_LC/server/telemetry/disk.js` — Data Lake projection over the existing `filesystemCapacity()`
- `IDEA1-AEGIS_Drive_LC/server/telemetry/index.js` — normalized contract and partial-availability rules
- `IDEA1-AEGIS_Drive_LC/server/routes/api.js` — added `GET /api/telemetry` behind `requireAuth`, `Cache-Control: no-store`, no audit write
- `IDEA1-AEGIS_Drive_LC/server/storage/fileStore.js` — `filesystemCapacity()` gained optional injected `statfs`/`root` for testing; **semantics unchanged**, and the existing semantics are now documented in code and pinned by tests

Frontend:

- `IDEA1-AEGIS_Drive_LC/src/components/ServerTelemetry.jsx` — renders the real contract; adds the stale state
- `IDEA1-AEGIS_Drive_LC/src/App.jsx` — polls `/api/telemetry` every 10 s, only while the Dashboard is the visible screen
- `IDEA1-AEGIS_Drive_LC/src/screens/Dashboard.jsx` — comment corrected to describe the wired source
- `IDEA1-AEGIS_Drive_LC/src/lib/strings.js` — four new keys in en/th/zh (`telemetryStateStale`, `telemetryUptimeHost`, `telemetryUptimeService`, `telemetryDiskHealth`); `serverTelemetrySub` corrected — it still claimed no source existed

Drive tests:

- `IDEA1-AEGIS_Drive_LC/tests/telemetrySchema.test.js` — TELEM-8, TELEM-11E/11G
- `IDEA1-AEGIS_Drive_LC/tests/telemetryClient.test.js` — TELEM-11C, timeout cap, failure containment
- `IDEA1-AEGIS_Drive_LC/tests/dataLakeCapacity.test.js` — pins the disk semantics below
- `IDEA1-AEGIS_Drive_LC/tests/telemetryApi.test.js` — TELEM-API-1..10, TELEM-11D/11F, TELEM-12, audit hygiene
- `IDEA1-AEGIS_Drive_LC/tests/serverTelemetryUi.test.js` — TELEM-UI-1..10; the pre-existing truthful-unavailable test is preserved unchanged

## Disk semantics gate — inspected before implementing, unchanged

`filesystemCapacity()` (`server/storage/fileStore.js`) uses `blocks` for total
and **`bavail`** (not `bfree`) for free, because Drive runs as uid 1000 and
cannot write the root reserve. Therefore:

```
totalBytes = blocks * bsize
freeBytes  = bavail * bsize
usedBytes  = total - free          (root-reserved blocks count as USED)
used + free == total exactly
```

`/api/storage` and `/api/dashboard` already publish these, and `Dashboard.jsx`
derives free as `total - used`, which round-trips to exactly `bavail`.
**No inconsistency was found**, so nothing was changed. `DISK_SEMANTICS_CHANGED=NO`.
The semantics are now stated in the function's own comment and pinned by three
tests, so a future change breaks a test instead of quietly moving what the
Storage KPI means.

## Verification evidence

- `node --test --test-concurrency=1 "tests/**/*.test.js"` (shared/host-telemetry-agent) — pass: **54 discovered, 51 pass, 0 fail, 3 skipped**. Run three consecutive times with identical results after fixing a flaky assertion of my own (see Known limitations).
- `node --test --test-concurrency=1 "tests/**/*.test.js"` (IDEA1-AEGIS_Drive_LC) — pass: **293 discovered, 274 pass, 0 fail, 19 skipped**. The 19 skips are the pre-existing `TEST_DATABASE_URL` Postgres-gated tests, unrelated to this task.
- Telemetry-focused subset — pass: **64 pass, 0 fail** (13 schema + 10 client + 8 disk + 18 API + 13 UI, of which 2 UI tests pre-date this task).
- `npm run build` (IDEA1-AEGIS_Drive_LC) — pass: built in 15.80s, no chunk warning. `dist/index.html` is gitignored-but-tracked build output and was reverted; no build artifact is staged.
- `node --test --test-concurrency=1 "tests/**/*.test.mjs"` (repository root) — pass: **53 pass, 0 fail, 0 skipped**.
- `node --check` on every new/changed server and agent module — pass.
- `git diff --check` — pass, no whitespace errors.
- Conflict-marker scan over all changed paths — pass, none found.
- Secret scan over all changed paths — pass. One match is `SESSION_SECRET = 'telemetry-test-session-secret-not-used-in-production'`, a test-only literal following the existing convention in `healthTelemetry.test.js` and `vaultApi.test.js`.
- Lint/static: the repository defines no ESLint/Prettier/Biome configuration at root or in IDEA1; `node --check` plus the test suites are the available static gate.
- Compose validation: **not applicable** — `docker-compose.yml` was deliberately not modified.

All of the above ran on the Windows development host from the isolated worktree.

Not run, and not claimed: `systemd-analyze verify`, `systemd-analyze security`,
any container build or run, any deployment, any production acceptance.

## Security properties proven by test

- `TELEM-API-1` — unauthenticated `GET /api/telemetry` returns 401 and leaks no metric.
- `TELEM-11B` — the agent's listener address is a path, never `{ address, port }`; `RestrictAddressFamilies=AF_UNIX` is asserted in the unit.
- `TELEM-11C` — the Drive client refuses anything URL- or `host:port`-shaped; the module contains no `http://`, `https://`, `port:`, or `hostname:`.
- `TELEM-11D` / `TELEM-SOCKET-5` — neither response contains an environment canary, hostname, username, cwd, exec path, or the words token/password/secret/docker/container.
- `TELEM-11E` — the schema **rejects** extra fields rather than stripping them, including a MAC address smuggled into `network`, and rejects an unavailable metric that carries a value.
- `TELEM-11F` / `TELEM-11G` — query strings such as `?interface=eth0`, `?socket=/var/run/docker.sock`, `?root=/` are inert; the interface is server-side only and validated against path traversal, separators, NUL, and over-length.
- `TELEM-12` — both the agent and the API response are checked against explicit key allowlists.
- Audit hygiene — eight consecutive polls add **zero** audit rows.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-status.md` — added the dated "Server Telemetry V1 implementation (2026-08-27)" subsection recording `IMPLEMENTED / LOCALLY VERIFIED / NOT DEPLOYED`, and corrected the two places that stated Server Telemetry has no data source. Both edits preserve `PRODUCTION_DEPLOYMENT=NOT PERFORMED`.

The Formal Report was **not** modified.

## Shared surfaces touched

`integration-review: yes`. Every path below is new and lives under the shared
`shared/` boundary, which AGENTS.md assigns to infrastructure ownership and
which always requires integration review:

- `shared/host-telemetry-agent/package.json` — introduces a second independent Node package in the repository; affects how CI would discover and run tests.
- `shared/host-telemetry-agent/README.md` — shared contract documentation.
- `shared/host-telemetry-agent/src/parsers.js` — host metric parsing.
- `shared/host-telemetry-agent/src/config.js` — fixes the approved socket path, GID-bearing mode, and interface.
- `shared/host-telemetry-agent/src/sources.js` — the agent's entire host read surface.
- `shared/host-telemetry-agent/src/sampler.js` — background sampling.
- `shared/host-telemetry-agent/src/server.js` — the host-side IPC boundary Drive will consume.
- `shared/host-telemetry-agent/src/agent.js` — assembly.
- `shared/host-telemetry-agent/src/index.js` — the process systemd would run as a new host service.
- `shared/host-telemetry-agent/tests/parsers.test.js`
- `shared/host-telemetry-agent/tests/sampler.test.js`
- `shared/host-telemetry-agent/tests/socket.test.js`
- `shared/host-telemetry-agent/tests/config.test.js`
- `shared/host-telemetry-agent/tests/agent.test.js`
- `shared/host-telemetry-agent/tests/deploy.test.js`
- `shared/host-telemetry-agent/deploy/aegis-telemetry.service` — proposes a new systemd service on the production host.
- `shared/host-telemetry-agent/deploy/aegis-telemetry.sysusers.conf` — proposes a new host user and the fixed GID 29100.
- `shared/host-telemetry-agent/deploy/README.md` — host installation and verification procedure.
- `shared/host-telemetry-agent/deploy/production-delta.md` — proposes a bounded change to the Drive service definition.

`docker-compose.yml`, `gateway/`, `postgres/`, and `.env.example` were **not**
modified.

## Integration requests

1. **Kla, as infrastructure owner — approve or reject the new host service
   identity before any installation.** The proposal creates the host user and
   group `aegis-telemetry` with the fixed numeric **GID 29100** (verified free
   on the host and inside the Drive image during preflight). The GID cannot be
   dynamic: Drive joins it via `group_add`, and a container supplementary group
   is matched by number. Rollback is `systemctl disable --now
   aegis-telemetry` plus removing the sysusers file; no data or schema is
   involved.

2. **Kla, as infrastructure owner — approve the Drive Compose delta before a
   future deployment task applies it.** The complete delta is
   `group_add: ["29100"]` and the read-only bind
   `/run/aegis-telemetry:/run/aegis-telemetry:ro`, with the existing
   `aegis_drive_storage:/datalake` unchanged. Downstream effect: the Drive
   container must be recreated (Drive only — no Monitor, HUB, PostgreSQL, or
   nginx change). Rollback is reverting the two lines and recreating Drive.
   **This task did not apply it**, and
   `/opt/aegis/runtime/docker-compose.production.yml` was not opened.

3. **Kla — decide the deployment order.** `deploy/production-delta.md` proposes
   installing and verifying the agent first (harmless in isolation: it publishes
   a socket nothing reads), then applying the Drive delta. The two steps are
   independently reversible.

4. **Reviewer decision needed — CI test discovery.** `shared/host-telemetry-agent`
   is a second Node package with its own `npm test`. No CI workflow was modified
   by this task, so its 54 tests will not run in CI until someone adds them.
   Requesting a decision on whether to extend the existing workflow.

## Known limitations

- **Three agent tests are skipped on Windows and must be run on Linux before
  deployment.** They need a real `AF_UNIX` socket *file*: stale-socket
  reclamation, socket removal on stop, and the `0660` mode assertion. Node maps
  `listen(<path>)` to a named pipe on Windows, so the remaining socket tests do
  exercise the same code and the same client call, but not the same kernel
  transport and not POSIX permissions. They are reported as skipped, never as
  passed.
- **No systemd directive was executed.** Every hardening choice in the unit is
  justified by reasoning and pinned by `deploy.test.js`, including the six
  directives deliberately *not* used (`ProcSubset`, `PrivateNetwork`,
  `MemoryDenyWriteExecute`, `PrivateMounts`, `PrivateUsers`, `DynamicUser`) and
  the specific read each would break. `systemd-analyze verify`,
  `systemd-analyze security`, and the five-read smoke test in
  `deploy/README.md` remain **required and unrun**.
- **`RestrictAddressFamilies=AF_UNIX` is unverified against this Node build.**
  It is the correct directive for a Unix-socket-only service, but whether this
  Node/libuv version needs any other address family at startup must be
  confirmed by the host smoke test.
- **The agent has never read a real `/proc`.** All parser tests use captured
  kernel-format strings. Field shapes on the actual host should be confirmed
  during the host verification step.
- **`enp1s0` throughput has not been observed.** The interface was confirmed UP
  with readable counters during preflight; no rate has been measured.
- **PostgreSQL-backed verification was not run** for this feature. Telemetry
  touches no table and writes no audit row, so the memory-mode suite exercises
  the same code path, but the 19 Postgres-gated tests remain skipped as they
  were before this task.
- **A flaky assertion I introduced was found and fixed during the run.**
  `TELEM-SOCKET-5` originally scanned the response body for `String(process.pid)`
  as a substring, which fails at random when the PID's digits occur inside a
  byte count (for example `3365` inside `8333651968`). It now checks for a `pid`
  *field* instead. Recorded because it passed in isolation and failed only in
  the full run.
- **The `serverTelemetryUi.test.js` contract changed.** Its second test
  previously asserted the placeholder shape (`usagePercent`, `temperatureC`,
  `load`); it now asserts the real contract. The first test — six truthful
  unavailable cards from a `null` contract — is preserved verbatim.
- **No production deployment, no production acceptance, no container build, no
  push, and no Pull Request.** `READY_FOR_PRODUCTION_DEPLOYMENT=NO`.

## Related

- [[concepts/Honest_Telemetry_and_Unavailable_States]]
- [[idea1/idea1-status]]
- [[summaries/08_Outstanding_Items_Consolidated]]
