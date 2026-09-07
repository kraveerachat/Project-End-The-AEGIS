---
title: Task Receipt — IDEA1 host temperature wire projection fix
date: 2026-09-07T15:09:11+07:00
owner: kla
area: idea1
branch: fix/idea1-host-temperature-wire-projection
status: partial
integration-review: yes
edit_policy: append-by-new-file
---

# Task Receipt — IDEA1 host temperature wire projection fix

Status is `partial`, not `complete`. The defect Production exposed is fixed and
covered by wire-level regression tests, but **nothing in this task has run on the
production host**: no agent was rebuilt or restarted, no image was deployed, and
the Dashboard tile has still never rendered a real `x86_pkg_temp` reading.
**Production acceptance remains incomplete.**

## What changed

**Production proved that x86_pkg_temp discovery and the sampler were correct,
but `server.js` strict wire projection omitted `metrics.temperature`, preventing
Drive from receiving the measurement.**

The evidence separated the three layers cleanly for the first time. On the
production host the thermal reader worked, and `sampler.snapshot()` carried:

```json
{ "available": true, "celsius": 55, "sensor": "x86_pkg_temp" }
```

with `samplerMetricKeys` = `cpu, memory, network, uptime, temperature`. The
response to `GET /internal/telemetry` over the Unix socket carried only `cpu`,
`memory`, `network` and `uptime`. The temperature was measured and then
discarded on the way out.

The cause is in `shared/host-telemetry-agent/src/server.js`. That module does not
serialize the snapshot — it *rebuilds* the body from a fixed allowlist, so that a
field added upstream cannot leak by accident. PR #95 added `temperature` to the
sampler but not to that allowlist, so the projector did exactly what it was
designed to do and dropped an unlisted metric group. `AGENT_METRIC_KEYS` gained
no `temperature` entry, and `projectAgentSnapshot()` copied no `temperature`
key.

Two changes, both inside the existing design rather than around it:

- `AGENT_METRIC_KEYS.temperature` now lists exactly `available`, `celsius`,
  `sensor` — the same three keys Drive's V1 schema already declares for the
  optional `temperature` group.
- `projectAgentSnapshot()` now projects `temperature` through the same
  `projectMetric()` helper every other group uses.

**Strict projection is preserved.** No spread syntax was introduced, no sampler
object is passed through, and nothing outside the three allowlisted keys can
reach the wire. `projectMetric()` still returns the bare `{ available: false }`
shape whenever the metric does not claim availability, so an unusable sensor is
still reported as unusable rather than as a number.

**Sensor truthfulness is untouched.** `src/thermal.js`, sensor discovery, the
`x86_pkg_temp` target, the 1–150 °C plausibility band, the disk-health and
Twingate collectors, the systemd unit, Docker Compose and the Drive schema were
all left exactly as they are. There is still no hardcoded thermal zone, no
`acpitz` fallback, no SSD/SMART fallback, no fabricated zero, and no privilege
change.

**No Drive-side change was needed, and this was verified rather than assumed.**
`IDEA1-AEGIS_Drive_LC/server/telemetry/schema.js` already carries `temperature`
in `OPTIONAL_METRIC_NAMES` with keys `['available', 'celsius', 'sensor']`, and
the Drive image currently running in production
(`sha256:fd9d8f74f0d3df73c21cdb46256f2afb101b7b9fbf1d4e3d95142c22712e23a1`) is
built from that code. The documented rollout constraint — Drive first, then the
agent — is therefore **already satisfied**: the deployed Drive accepts the group
whether or not the agent sends it.

## Source files changed

Modified:

- `shared/host-telemetry-agent/src/server.js` — the fix. Adds the
  `temperature` entry to `AGENT_METRIC_KEYS` and the `temperature` projection to
  `projectAgentSnapshot()`.
- `shared/host-telemetry-agent/tests/socket.test.js` — three new wire-level
  regression tests (below); `readySampler()` gained an optional `extraReaders`
  argument so one test can supply a `hostTemperature` reader while the default
  remains an agent built without one; `TELEM-SOCKET-4`'s metric-name assertion
  now expects `temperature` in the projected body.
- `shared/host-telemetry-agent/tests/diskHealthAgent.test.js` — `DISKAGENT-7`'s
  V1-shape assertion now expects `temperature` in `/internal/telemetry`, and
  gained an explicit assertion that `metrics.disk` is still absent, so the test
  keeps proving what it was written to prove: that the disk-health route adds no
  metric group to the V1 body.

No new files. No production, deployment, network, database, systemd, Docker or
Drive source file was touched.

### New regression tests

All three assert against the response body of a real `GET /internal/telemetry`
over the path-addressed socket, not against `projectAgentSnapshot()` in
isolation. That distinction is the whole point: every sampler-level and
thermal-level unit test stayed green throughout the production outage, because
the defect lived only in the projection step between them and the wire.

- **`TELEM-SOCKET-8 an available temperature is published on the wire`** — a
  sampler with a `hostTemperature` reader returning
  `{ available: true, celsius: 55.8, sensor: 'x86_pkg_temp' }` must produce
  `body.metrics.temperature` deep-equal to exactly that.
- **`TELEM-SOCKET-8 an unavailable temperature keeps the bare unavailable
  shape`** — an agent built with no thermal reader must publish exactly
  `{ "available": false }`: asserted both by `deepEqual` and by pinning
  `Object.keys()` to `['available']`, so a future null `celsius` or placeholder
  `sensor` fails the test.
- **`TELEM-SOCKET-8 strict projection strips an unexpected temperature field`**
  — a sampler snapshot mutated to carry `zonePath` and `criticalCelsius` inside
  `metrics.temperature` must still yield exactly `available`, `celsius`,
  `sensor` on the wire, with an explicit assertion that no `thermal_zone` path
  string appears anywhere in the response body.

## Verification evidence

- `node --test --test-concurrency=1` in `shared/host-telemetry-agent` (full agent suite) — **pass: 160 tests, 157 pass, 0 fail, 3 skipped**. The three
  skips are the POSIX-only socket-file and `chmod 0660` assertions, which the
  suite skips by design on Windows. The pre-existing baseline was 157 tests;
  this task adds the 3 new wire tests.
- `node --test --test-concurrency=1 tests/socket.test.js` — **pass: 17 tests,
  14 pass, 0 fail, 3 POSIX-only skips**.
- **The regression coverage was proved, not assumed.** `src/server.js` was
  reverted to its `origin/main` content with the new tests left in place and the
  socket suite re-run: **fail — 17 tests, 10 pass, 4 fail**. All three new
  `TELEM-SOCKET-8` tests failed, along with `TELEM-SOCKET-4`'s metric-name
  assertion. `server.js` was then restored to the fixed content and the tree
  confirmed clean. This is the evidence that the previous 157/157 result could
  not have caught the production defect.
- `node --test --test-concurrency=1 tests/thermal.test.js` — **pass 17/17**.
- `node --test --test-concurrency=1 tests/sampler.test.js` — **pass 7/7**.
- `node --test --test-concurrency=1 tests/diskHealthAgent.test.js` — **pass
  8/8**.
- `node --test --test-concurrency=1 tests/hostTemperatureTelemetry.test.js
  tests/telemetryApi.test.js tests/serverTelemetryUi.test.js` in
  `IDEA1-AEGIS_Drive_LC` — **pass: 63 tests, 63 pass, 0 fail**. Drive is
  unchanged by this task; these were run to prove the agent's new wire body is
  the shape Drive already validates.
- `node scripts/validate-collaboration-policy.mjs` — **pass** (run locally
  against a synthesised event file carrying this PR's body and this branch's
  `git diff --name-status origin/main...HEAD`).
- `node scripts/validate-vault.mjs --vault Obsidian_AEGIS_Vault/AEGIS_Knowledge`
  — **pass**, 0 errors. Two pre-existing `WARNING` lines about the two owner-data
  canvases are unrelated to this task and unchanged by it.
- `git diff --check` — **clean**, no whitespace or conflict-marker error.
- Secret scan over the branch diff — **pass (clean)**: the diff was searched
  case-insensitively for `password`, `passwd`, `secret`, `token`, `api[-_]?key`,
  `private[-_]?key`, `BEGIN .*PRIVATE KEY`, `authorization`, `bearer`,
  `AKIA[0-9A-Z]{16}` and `.env`. The only hit is the unchanged context line
  `delete process.env.AEGIS_TELEMETRY_LEAK_CANARY` inside the existing
  `TELEM-SOCKET-5` test, which exists to assert that such values must **not**
  appear in a response body. No credential, host address, or key is added by
  this change.
- **No production access of any kind.** No SSH, no agent restart, no image
  build, no deployment, no `smartctl`, no `systemctl`. None is claimed.

All of the above was run in the clean worktree `fix-host-temp-wire`, branched
from `origin/main` at `913758a3111fb74e31eb55b7982a84d127cae8f5`.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-status.md` — records the
  Production evidence that isolated the defect to the agent's wire projection,
  records the fix as implemented and locally verified but **not deployed**,
  records that the deployed Drive image already accepts the optional
  `temperature` group so the Drive-before-agent rollout constraint is satisfied,
  and keeps Production acceptance for host CPU temperature open.

## Shared surfaces touched

Every path below is outside the `idea1` boundary and inside `infrastructure`
(`shared/`), so this PR carries `integration-review: yes`.

- `shared/host-telemetry-agent/src/server.js` — widens the agent's wire
  allowlist for `/internal/telemetry` by one metric group. **This is the
  cross-module contract change.**
- `shared/host-telemetry-agent/tests/socket.test.js` — new wire-level
  regression tests and the corresponding V1 shape assertion.
- `shared/host-telemetry-agent/tests/diskHealthAgent.test.js` — V1 shape
  assertion for the `/internal/telemetry` body.

## Integration requests

- **Kla, as infrastructure owner, must accept the `/internal/telemetry` V1 wire
  contract change before the agent is redeployed.** `metrics.temperature` was
  approved into the sampler by PR #95, but this is the first time it actually
  reaches the wire, so the agent's published V1 body genuinely changes shape for
  the first time here. The decision belongs to the infrastructure owner
  explicitly, not implicitly through a bug fix.

- **Rollout order: the Drive-first constraint is already satisfied, and must
  still be checked before the agent is restarted.** The running Drive image
  `sha256:fd9d8f74f0d3df73c21cdb46256f2afb101b7b9fbf1d4e3d95142c22712e23a1`
  treats `temperature` as an optional group and tolerates an agent that omits
  it, which is why the current rolled-back agent is healthy. A Drive *older*
  than that image would reject the new body with `unexpected-metric-group` and
  blank **every** telemetry tile, so if the Drive image is rolled back for any
  other reason, the agent must be rolled back first.

- **Rollback for this change is an agent-only operation.** Reverting
  `server.js` returns the wire body to the four-metric shape the currently
  deployed Drive already accepts; no Drive redeploy, database migration, or
  systemd change is involved.

- No systemd, sandbox, capability, or privilege review is required: no unit
  file, no `sources.js` read surface, and no thermal discovery path changed.

## Known limitations

- **Production acceptance remains incomplete.** No agent was rebuilt or
  restarted, no Drive image was deployed, and the Dashboard CPU temperature tile
  has still never rendered a real reading from the production host. The fix is
  proven at the socket boundary in tests only.
- The production sampler evidence recorded `celsius` ≈ 55 as an owner-supplied
  observation; the regression test uses `55.8` as a fixture value. No figure in
  this receipt was measured by this task.
- The three POSIX-only socket assertions (stale socket-file reclamation and
  `chmod 0660`) are skipped on the Windows development machine, as they always
  have been. They are unaffected by this change, but this task did not exercise
  them on Linux.
- The previously recorded pre-existing Drive failure `AUTOLOCK-5` was not
  re-examined here: the full Drive suite was not run, only the three telemetry
  and temperature files relevant to this change.
- Nothing in this task revisits *why* PR #95 shipped a sampler metric that the
  projector dropped. The projector's fail-closed behaviour is correct and is
  kept; whether the agent should additionally fail loudly when the sampler
  publishes a group the allowlist does not know about is a separate design
  question and was not decided or implemented here.
