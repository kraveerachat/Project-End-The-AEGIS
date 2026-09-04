---
title: Task Receipt — TWIN-2 local Twingate connector telemetry
date: 2026-09-05T05:13:33+07:00
owner: kla
area: idea1
branch: feat/idea1-twin2-local-connector-telemetry
status: partial
edit_policy: append-by-new-file
---

# Task Receipt — TWIN-2 local Twingate connector telemetry

Status is `partial`, not `complete`: the full chain is implemented and verified
locally end to end against a controllable fake agent, but **nothing in this task
has run on the production host**. The collector, its systemd units, and the
`docker inspect` call have never executed against the real
`twingate-aegis-connector-02`. Recorded under Known limitations.

## What changed

Settings → Security & Privacy stopped saying "Connector telemetry: Not measured"
for something that is, in fact, measurable on this host — while continuing to say
exactly that for the thing that is not.

The screen now separates two questions that were previously collapsed into one:

- **LOCAL CONNECTOR** — is the connector container running on this AEGIS host, and
  what does Docker's own healthcheck say? This is now real measured evidence.
- **TWINGATE CONTROL PLANE** — does Twingate itself consider the connector
  connected? Still **not measured**, and still declared as such.

The distinction is load-bearing, not cosmetic: a container can be up and passing
its healthcheck while the control plane considers the connector disconnected
(expired token, revoked resource, upstream partition). The UI states that in
words under the local block so a healthy container cannot be read as a working
tunnel.

Evidence path, mirroring the existing disk-health design:

```
Docker daemon
  → aegis-twingate-health.service   (bounded oneshot, 60 s timer, docker group)
  → /var/lib/aegis-twingate-health/twingate-health.json   (0640, root-owned dir)
  → aegis-telemetry agent           (file read only — never touches Docker)
  → GET /internal/twingate-connector (new versioned route)
  → Drive validates fail-closed
  → GET /api/remote-access
  → Settings → Security & Privacy
```

## Source files changed

### Owned (`idea1`)

- `IDEA1-AEGIS_Drive_LC/server/telemetry/twingateHealthSchema.js` — **new.**
  Fail-closed validator for the agent body plus the one status derivation
  (RUNNING+HEALTHY → HEALTHY; RUNNING+NOT_CONFIGURED → NOT_CONFIGURED, never
  HEALTHY; stale → UNKNOWN). Stale threshold 300 s.
- `IDEA1-AEGIS_Drive_LC/server/telemetry/twingateHealth.js` — **new.** The
  projection for the API, and `CONTROL_PLANE_NOT_MEASURED` as a declared constant.
- `IDEA1-AEGIS_Drive_LC/server/telemetry/client.js` — `fetchHostTwingateConnector`
  on a third route; the V1 and disk-health clients are untouched.
- `IDEA1-AEGIS_Drive_LC/server/routes/api.js` — `GET /api/remote-access`
  (`requireAuth`, `no-store`).
- `IDEA1-AEGIS_Drive_LC/src/components/SettingsPanels.jsx` — Remote Access card
  split into the two blocks; Security overview gains a `Local connector` row and
  keeps `Control-plane telemetry: Not measured`.
- `IDEA1-AEGIS_Drive_LC/src/screens/Settings.jsx` — fetches `/api/remote-access`
  (60 s refresh, matching the collector cadence) and gates its error through
  `visibleFetchError`.
- `IDEA1-AEGIS_Drive_LC/src/lib/strings.js` — 39 new keys in EN/TH/ZH; two keys
  this change orphaned (`remoteTelemetryLabel`, `remoteLiveStateLabel`) removed.
- `IDEA1-AEGIS_Drive_LC/tests/twingateConnectorApi.test.js` — **new**, 14 tests.
- `IDEA1-AEGIS_Drive_LC/tests/twingateSettingsUi.test.js` — **new**, 12 tests.
- `IDEA1-AEGIS_Drive_LC/tests/allScreensEmptyState.test.js` — **updated**; it
  asserted `t('remoteTelemetryLabel')`, a key this change replaces. Same intent,
  now asserting the control-plane rows and the local-scope note specifically.

### Cross-scope (`infrastructure` — `shared/`)

- `shared/host-telemetry-agent/collectors/twingate.js` — **new.** Pure projection
  and enums. Deliberately separate so the agent can import it without pulling the
  Docker-executing module into its process (the same split as `smart.js`).
- `shared/host-telemetry-agent/collectors/twingate-health.js` — **new.** The
  privileged edge: one fixed `docker inspect` with a fixed Go template.
- `shared/host-telemetry-agent/collectors/run-twingate-health.js` — **new.** Oneshot entry.
- `shared/host-telemetry-agent/src/twingateHealth.js` — **new.** Agent-side reader,
  validator, and allowlist projection.
- `shared/host-telemetry-agent/src/config.js` — `AEGIS_TELEMETRY_TWINGATE_HEALTH_FILE`.
- `shared/host-telemetry-agent/src/sampler.js` — reads the file on the same cycle.
- `shared/host-telemetry-agent/src/server.js` — `GET /internal/twingate-connector`.
- `shared/host-telemetry-agent/deploy/aegis-twingate-health.service` — **new.**
- `shared/host-telemetry-agent/deploy/aegis-twingate-health.timer` — **new.**
- `shared/host-telemetry-agent/deploy/aegis-twingate-health.sysusers.conf` — **new.** Pinned UID 29103 (see the UID correction below).
- `shared/host-telemetry-agent/deploy/aegis-telemetry.service` — one Environment line.
- `shared/host-telemetry-agent/tests/twingateCollector.test.js` — **new**, 19 tests.
- `shared/host-telemetry-agent/tests/twingateAgent.test.js` — **new**, 9 tests.
- `shared/host-telemetry-agent/tests/twingateDeploy.test.js` — **new**, 12 tests (including the two UID-collision guards).
- `shared/host-telemetry-agent/tests/agent.test.js` — the "exactly six approved
  sources" allowlist becomes seven; the seventh is a plain file, not a device.
- `shared/host-telemetry-agent/tests/config.test.js` — same allowlist, config side.

## Verification evidence

- `npm test` (IDEA1-AEGIS_Drive_LC) — pass: **992 tests, 925 pass, 0 fail, 67
  skipped.** The 67 skips are the pre-existing PostgreSQL-gated suites.
- `npm test` (shared/host-telemetry-agent) — pass: **138 tests, 135 pass, 0 fail**
  (3 platform-gated skips).
- `npm run build` — pass.
- `git diff --check` — pass (after restoring `dist/`, which was rebuilt only to
  verify the build and is not part of this change).
- `node scripts/validate-vault.mjs` — pass (2 pre-existing canvas warnings).
- Browser QA, driven through the real Drive API with a controllable fake agent on
  a named pipe (Classic + Neo, light + dark, EN + TH):
  - RUNNING + HEALTHY → `Runtime state: Running`, `Docker health: Healthy`,
    `Restart count: 0`, real `Last measured` timestamp; overview row
    `Local connector: Healthy`.
  - STOPPED → renders `Stopped` with the real restart count (12) and no `Running`.
  - RUNNING + no healthcheck → renders `Running` but `Local connector:
    Not configured` — **never** Healthy.
  - `connector-not-found` → `Not measured` for both readings, `—` for restart
    count and timestamp (not `0`), plus the fixed reason in words.
  - In every state the control-plane block still read `Telemetry: Not measured` /
    `Live control-plane state: Unavailable`.
  - No horizontal overflow at 420 px in either language.

## Canonical notes updated

- `None` — this branch is not merged and not deployed. The durable IDEA1 and
  infrastructure facts it would add (a third agent route, a second host collector,
  a new Drive endpoint) become true for `main` only on merge and true for
  production only after the units are installed there. The reconciliation entries
  are listed under Integration requests.

## Shared surfaces touched

Every path below is outside the `idea1` boundary and inside `infrastructure`
(`shared/`), so this PR carries `integration-review: yes`.

- `shared/host-telemetry-agent/collectors/twingate.js` — new pure projection module for the host agent toolchain.
- `shared/host-telemetry-agent/collectors/twingate-health.js` — new privileged collector; the only AEGIS host unit that can reach the Docker daemon.
- `shared/host-telemetry-agent/collectors/run-twingate-health.js` — new oneshot entry point invoked by the systemd unit.
- `shared/host-telemetry-agent/src/twingateHealth.js` — new agent-side reader/validator/projector.
- `shared/host-telemetry-agent/src/config.js` — adds one optional evidence-file path to the agent's configuration contract.
- `shared/host-telemetry-agent/src/sampler.js` — reads that file on the existing cycle; the V1 snapshot shape is unchanged.
- `shared/host-telemetry-agent/src/server.js` — adds `/internal/twingate-connector`; the two existing routes and their bodies are unchanged.
- `shared/host-telemetry-agent/deploy/aegis-twingate-health.service` — new systemd unit that joins the `docker` group.
- `shared/host-telemetry-agent/deploy/aegis-twingate-health.timer` — new 60 s timer.
- `shared/host-telemetry-agent/deploy/aegis-twingate-health.sysusers.conf` — new pinned UID 29103.
- `shared/host-telemetry-agent/deploy/aegis-telemetry.service` — one Environment line naming the evidence file the agent may read.
- `shared/host-telemetry-agent/tests/agent.test.js` — approved-source allowlist extended from six to seven.
- `shared/host-telemetry-agent/tests/config.test.js` — same allowlist on the config side.
- `shared/host-telemetry-agent/tests/twingateCollector.test.js` — new collector tests.
- `shared/host-telemetry-agent/tests/twingateAgent.test.js` — new agent-route tests.
- `shared/host-telemetry-agent/tests/twingateDeploy.test.js` — new unit/timer tests.

## Integration requests

- **Host privilege review (kla, infrastructure owner) — required before install.**
  `aegis-twingate-health.service` adds `SupplementaryGroups=docker`, and
  membership in `docker` is equivalent to root on the host. The mitigations are:
  a Type=oneshot that lives well under a second per minute; a dedicated UID
  (29103) used by nothing else; an empty `CapabilityBoundingSet`;
  `PrivateNetwork=true` + `IPAddressDeny=any` (so the unit provably cannot reach
  the Twingate API); `PrivateDevices=true`; and a Docker command whose verb,
  flags, and output template are constants in trusted source — only the container
  name comes from the unit, and it is pattern-checked first. Please confirm this
  trade is acceptable before the unit is installed.
- **Host install (kla) — not performed by this task.** Install
  `aegis-twingate-health.sysusers.conf`, run `systemd-sysusers`, install the
  `.service` and `.timer`, `systemctl enable --now aegis-twingate-health.timer`,
  then restart `aegis-telemetry` so it picks up the new Environment line. Rollback
  is `systemctl disable --now aegis-twingate-health.timer`; Drive then reports
  `collector-not-run` and the UI falls back to "Not measured", which is the
  pre-TWIN-2 behaviour.
- **No Drive deployment change is required.** The new route reuses the
  `/run/aegis-telemetry` socket Drive already bind-mounts read-only, so
  `docker-compose.yml` and `deploy/production-delta.md` need no edit. This is
  asserted by test (`TWDEPLOY-11`).
- **Owner reconciliation after merge (kla):** record in `idea1/idea1-status.md`
  that Settings reports measured LOCAL connector runtime health via
  `/api/remote-access`, and in the infrastructure MOC that the host agent now
  publishes a third route from a second collector.

## Correction — pinned UID moved 29102 → 29103

This branch originally pinned `aegis-twingate-health` to **UID 29102** and
described it as the third host identity. Both were wrong, and a read-only
production preflight caught it before any deployment:

| UID | Owner | State |
|---|---|---|
| 29100 | `aegis-telemetry` | in use |
| 29101 | `aegis-disk-health` | in use |
| 29102 | **`aegis-backup`** | **in use — collision** |
| 29103 | `aegis-twingate-health` | free (UID and GID) — now claimed here |

29102 belongs to the host backup agent (`shared/host-backup-agent/deploy/aegis-backup.sysusers.conf`),
which is the actual third identity. The collision was not a paper reservation:
the backup agent is deployed, and the **Drive container joins GID 29102** via
`group_add` to reach `/run/aegis-backup`. Reusing it would have entangled this
collector's identity with a socket Drive already talks to, in both directions.

The assignment is now 29103, the sysusers header carries the full identity map
and states plainly that 29102 is taken, and two tests pin it: `TWDEPLOY-8`
rejects reuse of 29100, 29101 **and** 29102, while `TWDEPLOY-8b` cross-checks the
neighbouring sysusers files in the repo so a future identity that claims 29103
fails the build rather than colliding on the host.

Nothing about `aegis-backup`, UID/GID 29102, the production host, Docker, the
Twingate credentials, the Drive Compose runtime, MikroTik/UFW, or the database
was changed by this correction.

⚠️ Process note for the next host identity: the collision was discoverable in the
repository — `aegis-backup.sysusers.conf` has pinned 29102 since the storage and
backup phase. Grep the existing sysusers files before choosing a UID; do not
assume the next number after the one you last saw is free.

## Known limitations

- **Nothing here has run on the production host.** The collector has never
  executed `docker inspect` against the real `twingate-aegis-connector-02`, the
  systemd units have never been loaded, and the evidence file has never been
  written. Every test uses an injected executor or a fake agent. The units are
  asserted as *text* (directives, not behaviour) — `systemd-analyze verify` was
  not run, because this environment has no systemd. Treat the deployment as
  unproven until the install step above is done and the Settings screen shows a
  real `Last measured` timestamp.
- **The Twingate control plane remains NOT MEASURED.** This task measures local
  container runtime only. A healthy local connector does not prove the tunnel
  works. Implementing control-plane status needs an authenticated Twingate API
  call with a credential Drive does not hold and should not hold — a separate
  task, deliberately not started here.
- **`/api/telemetry` was left alone on purpose.** It has carried a `twingate`
  metric since V1 (`available:false`, `scope:'server-connector'`,
  `reason:'no-approved-source'`), which the Dashboard renders. That metric
  describes the connector as a whole, control plane included, so it is still
  truthful and was not touched; a test now pins it against silent drift. The
  follow-up worth considering is whether the Dashboard tile should also show the
  local runtime evidence — that is a Dashboard change, not a Settings one.
- **`ProtectSystem=strict` and the Docker socket.** Connecting to an existing
  Unix socket does not modify the filesystem, so a read-only mount does not block
  it, and no `ReadWritePaths=` exception was added. This is standard for hardened
  units that talk to dbus/journald sockets, but it is reasoning rather than
  something observed on the target host — worth confirming on first install.
- **Three pre-existing orphaned i18n keys** (`remoteConnectorStatus`,
  `remoteInactiveHint`, `remoteInactive`) were left in place. They were orphaned
  by the earlier Settings redesign, not by this task, and removing them is
  unrelated cleanup.
- **No production deployment or production acceptance was performed.**
