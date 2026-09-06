---
title: Task Receipt — IDEA1 host CPU package temperature telemetry
date: 2026-09-07T04:17:12+07:00
owner: kla
area: idea1
branch: feat/idea1-host-temperature-telemetry
status: partial
integration-review: yes
edit_policy: append-by-new-file
---

# Task Receipt — IDEA1 host CPU package temperature telemetry

Status is `partial`, not `complete`: the whole chain is implemented and verified
locally — bounded sensor discovery, the agent contract, the Drive projection and
the Dashboard tile — but **nothing in this task has run on the production host**.
No agent was restarted, no Drive image was built or deployed, and the tile has
never rendered against the real `x86_pkg_temp` zone. Recorded under Known
limitations, along with the deployment ordering constraint this change creates.

## What changed

- **The Dashboard has a real CPU temperature tile**, fed by a new host
  measurement rather than by reusing a number that means something else. Before
  this change `/internal/telemetry` published only `cpu`, `memory`, `network`
  and `uptime`, and there was no host temperature anywhere in the contract.

- **The sensor is discovered, not hardcoded.** The preflight found
  `x86_pkg_temp` on `thermal_zone1` today, but the kernel makes no promise about
  the number. Pinning zone 1 would not have been the conservative choice — a
  BIOS or kernel change that renumbers the zones would have silently begun
  publishing `acpitz`, the ~27.8 °C chassis sensor, as the CPU package. The
  agent therefore lists `/sys/class/thermal`, reads only `type` and `temp` for
  entries matching `thermal_zone[0-9]+`, and selects the zone whose `type` is
  exactly `x86_pkg_temp`.

- **There is no fallback, deliberately.** If no zone reports `x86_pkg_temp`, or
  its value fails validation, the metric is exactly `{ available: false }`. It
  never degrades to `acpitz`, to the SSD's SMART temperature (~40 °C, a real
  number about a different device, reported separately by `/api/storage`), to
  another arbitrary zone, or to `0`. Each of those would render on the dashboard
  with the authority of a measurement.

- **Validation happens before conversion.** A `temp` value must be an integer
  string, non-negative, and land inside a 1–150 °C plausibility band *after*
  the millidegree division. That band is doing real work in both directions: it
  rejects `55000000` (malformed millidegrees → 55000 °C) and it rejects a bare
  `56` (degrees mistaken for millidegrees → 0.056 °C), which is the failure mode
  most likely to look plausible on screen.

- **The approved sensor is enforced twice.** The agent selects it, and Drive
  independently refuses any `sensor` outside `APPROVED_TEMPERATURE_SENSORS`.
  A replaced or impersonated agent therefore cannot get a chassis or SSD reading
  onto the Temperature tile by relabelling it.

- **No systemd privilege change was made, and none was needed.** Production
  preflight verified UID/GID 29100 reading the thermal sysfs files under the
  existing sandbox. `PrivateDevices=yes`, `ProtectSystem=strict`,
  `ProtectKernelTunables=yes`, `NoNewPrivileges=true` and the empty
  `CapabilityBoundingSet`/`AmbientCapabilities` are all unchanged. The only edit
  to `aegis-telemetry.service` is a comment; **zero directives changed**
  (verified: `git diff -U0` yields no non-comment line).

- **`metrics.temperature` is an optional group inside the existing V1 contract**,
  not a new schema version and not a fourth route. Drive validates it exactly as
  strictly as a required group when present, and accepts its absence — which is
  what lets Drive be deployed ahead of the agent. See Known limitations for the
  ordering constraint this creates in the other direction.

- **Stale documentation about the fixed read surface was corrected**, since the
  agent no longer reads only a fixed file map: `sources.js`'s "every byte enters
  through here" header, the "read five numbers"/"five files" claims in both
  READMEs, the unit-file comment, the read-surface test's own header, and the
  Drive route comment in `api.js` that claimed not one new telemetry field had
  been opened.

## Source files changed

New:

- `shared/host-telemetry-agent/src/thermal.js` — bounded discovery, sensor
  selection, validation and millidegree conversion.
- `shared/host-telemetry-agent/tests/thermal.test.js` — 17 tests.
- `IDEA1-AEGIS_Drive_LC/tests/hostTemperatureTelemetry.test.js` — 17 tests.

Modified:

- `shared/host-telemetry-agent/src/config.js` — adds `THERMAL_ROOT` and the
  `thermalRoot` config field, deliberately outside `sources` (that map is
  file-only; this is a directory).
- `shared/host-telemetry-agent/src/agent.js` — injects `readdir`, assembles the
  thermal reader through the same injected `readFile`.
- `shared/host-telemetry-agent/src/sampler.js` — reads temperature on the
  existing cycle and re-checks its shape before publishing it.
- `shared/host-telemetry-agent/src/sources.js` — header corrected: this module
  is no longer the agent's only I/O edge.
- `shared/host-telemetry-agent/README.md` — diagram, read-surface bounds table,
  contract example, and the rollout-order warning.
- `shared/host-telemetry-agent/deploy/README.md` — source table and read counts.
- `shared/host-telemetry-agent/deploy/aegis-telemetry.service` — **comment only**.
- `shared/host-telemetry-agent/tests/agent.test.js` — read-surface test now
  stubs the thermal listing so it measures the fixed file surface alone, plus a
  new test pinning the thermal surface to one directory and two files per zone.
- `shared/host-telemetry-agent/tests/diskHealthAgent.test.js`,
  `shared/host-telemetry-agent/tests/twingateAgent.test.js` — the V1 snapshot
  shape assertions now include `temperature`; what they prove is unchanged
  (that the disk-health and connector reads add no metric group).
- `IDEA1-AEGIS_Drive_LC/server/telemetry/schema.js` — optional `temperature`
  group, approved-sensor allowlist, plausibility band.
- `IDEA1-AEGIS_Drive_LC/server/telemetry/index.js` — projects `temperature`;
  explicitly excluded from the response-level `ok` flag.
- `IDEA1-AEGIS_Drive_LC/server/routes/api.js` — corrected the comment claiming
  no telemetry field had been added.
- `IDEA1-AEGIS_Drive_LC/src/components/ServerTelemetry.jsx` — the tile, with
  absolute °C thresholds (warn ≥ 80, critical ≥ 90) since it has no percentage.
- `IDEA1-AEGIS_Drive_LC/src/lib/strings.js` — `telemetryTemperature` in en/th/zh.
- `IDEA1-AEGIS_Drive_LC/tests/serverTelemetryUi.test.js`,
  `IDEA1-AEGIS_Drive_LC/tests/telemetryApi.test.js` — tile count six → seven and
  the approved-key allowlist extended.

`IDEA1-AEGIS_Drive_LC/dist/` was rebuilt only to verify the build and then
restored; it is **not** part of this change.

## Verification evidence

- `npm test` in `shared/host-telemetry-agent` — **pass: 157 tests, 154 pass,
  0 fail** (3 are suite wrappers).
- `node --test tests/thermal.test.js` — **pass 17/17**.
- `npm test` in `IDEA1-AEGIS_Drive_LC` — **1049 tests, 981 pass, 1 fail,
  67 PostgreSQL-gated skips**. The single failure is `AUTOLOCK-5 migration 008
  replaces the CHECK without touching the column`, which is **pre-existing and
  unrelated**: it fails identically on a clean `origin/main` checkout of this
  worktree with every change stashed (verified, not assumed). It is not fixed
  here because it is outside this task's scope.
- `node --test tests/hostTemperatureTelemetry.test.js` — **pass 17/17**.
- `npm run build` (Drive) — **pass**, built in 11.26s; `dist/` restored to the
  committed state afterwards and confirmed clean in `git status`.
- `git diff -U0 -- shared/host-telemetry-agent/deploy/aegis-telemetry.service |
  grep -vE '^[+-]#'` — **zero non-comment lines**, confirming no sandbox change.
- `git diff --check` — clean.
- No production host access, no deployment, and no smartctl/systemd execution:
  none is claimed.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-status.md` — records the new
  host temperature metric as implemented and locally verified, **not** deployed
  or production-accepted, and records the Drive-before-agent rollout constraint.

## Shared surfaces touched

Every path below is outside the `idea1` boundary and inside `infrastructure`
(`shared/`), so this PR carries `integration-review: yes`.

- `shared/host-telemetry-agent/src/thermal.js` — new module; introduces the
  agent's first and only directory listing.
- `shared/host-telemetry-agent/src/config.js` — adds `THERMAL_ROOT` /
  `thermalRoot` to the agent configuration contract.
- `shared/host-telemetry-agent/src/agent.js` — injects `readdir` into assembly.
- `shared/host-telemetry-agent/src/sampler.js` — adds `metrics.temperature` to
  the published V1 snapshot. **This is the cross-module contract change.**
- `shared/host-telemetry-agent/src/sources.js` — header comment corrected.
- `shared/host-telemetry-agent/README.md` — read surface, contract, rollout order.
- `shared/host-telemetry-agent/deploy/README.md` — read surface and sandbox note.
- `shared/host-telemetry-agent/deploy/aegis-telemetry.service` — comment only;
  no directive changed.
- `shared/host-telemetry-agent/tests/agent.test.js` — read-surface allowlist.
- `shared/host-telemetry-agent/tests/diskHealthAgent.test.js` — V1 shape.
- `shared/host-telemetry-agent/tests/twingateAgent.test.js` — V1 shape.
- `shared/host-telemetry-agent/tests/thermal.test.js` — new tests.

## Integration requests

- **Kla, as infrastructure owner, must accept the V1 snapshot contract change
  before this is deployed.** `metrics.temperature` is a new group inside the
  existing `/internal/telemetry` V1 body. This is the first time a metric group
  has been added there — disk health and Twingate connector health each got
  their own route precisely to avoid it — so the decision is deliberate and
  needs an explicit owner call, not an implicit one.

- **Rollout order is a hard constraint, not a preference: deploy the Drive image
  first, then restart the host agent.** Drive's validator rejects unknown metric
  groups by design. A Drive carrying this change treats `temperature` as
  optional and works against the current agent (tile reads unavailable). The
  reverse does not hold — an agent publishing `temperature` to the Drive
  currently in production trips `unexpected-metric-group` and blanks **every**
  telemetry tile, not just temperature.

- **Rollback has the mirror constraint:** roll the agent back before the Drive
  image.

- No systemd privilege review is required: the unit's directives are unchanged.

## Known limitations

- **Nothing here has run on the production host.** No agent restart, no image
  build, no deployment, and no observation of the real `x86_pkg_temp` zone
  through this code. Every temperature figure in this receipt comes from the
  owner-supplied preflight, not from this task.
- **The tile has never been rendered against real production data** — only
  against fixtures and a server-side render in tests.
- The 1–150 °C plausibility band and the 80/90 °C warn/critical thresholds are
  engineering judgements calibrated to x86 package behaviour, not values
  observed to trip in production. Neither has been exercised on real hardware.
- Only `x86_pkg_temp` is approved. A host without that zone — a VM, or different
  hardware — will show the tile as permanently unavailable. That is intended,
  and is why temperature is excluded from the response-level `ok` flag, but it
  does mean the tile is not portable across arbitrary hosts.
- `AUTOLOCK-5` fails in the Drive suite both with and without this change. It is
  pre-existing, out of scope here, and left untouched.
- Per-cycle cost grows by one `readdir` plus up to two small reads per thermal
  zone. Measured on this host it is negligible, but it has not been profiled
  under load on the production machine.
