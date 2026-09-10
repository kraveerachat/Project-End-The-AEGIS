# IDEA3 PR9 Production Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the source, tests, runbook, and isolated evidence needed for the safe pre-PR5 portion of IDEA3 PR9 without touching Production or hardware.

**Architecture:** Reuse the PR8 Core+Web lifecycle owner for a Linux/server entry point with explicit payload paths and one external data root. Add a separate Web readiness probe, strict production configuration validation, fail-on-child-death cleanup, and a systemd example that restarts the composite service rather than supervising Core alone.

**Tech Stack:** Python 3.10+, pytest 9.1.1, Node.js 22.13+, Express 5, `node:sqlite`, Vitest 3, Vite 7, systemd unit syntax.

**Spec:** `IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-09-10-idea3-pr9-production-runtime-design.md`

## Global Constraints

- `PRODUCTION_MUTATION_ALLOWED = NO`.
- Use only disposable paths, loopback endpoints, test credentials, and absent or injected external dependencies.
- Preserve `WEB_TO_MQTT = NO`, `WEB_TO_ESP32 = NO`, and `WEB_TO_RELAY = NO`.
- Preserve `Requested != Published != ACK != Executed != Physical Evidence`.
- Shutdown, restart, and rollback never issue `RESTORE_UPLINK`.
- Do not add Docker/Compose, change firmware, access a real broker, or create the final PR9 receipt.
- PR5 merge sync, final acceptance, Ready-for-review state, deployment, and closeout remain blocked.

---

### Task 1: Strict production Web configuration and readiness

**Files:**
- Modify: `IDEA3-AEGIS_Lockdown/web/server/config.js`
- Modify: `IDEA3-AEGIS_Lockdown/web/server/createApp.js`
- Modify: `IDEA3-AEGIS_Lockdown/web/tests/server/config.test.js`
- Modify: `IDEA3-AEGIS_Lockdown/web/tests/server/productionRuntime.test.js`

**Interfaces:**
- Consumes: `loadConfig(env)`, repository `schemaVersion()`.
- Produces: production-only strict positive integer parsing, an absolute audit DB path contract, and `GET <base>/api/readiness -> {status, audit, schemaVersion}`.

- [ ] **Step 1: Write failing config tests**

Add table-driven cases proving malformed `PORT`, `AEGIS_SESSION_IDLE_MS`,
`AEGIS_MAX_EVIDENCE_AGE_MS`, and `AEGIS_ADAPTER_TIMEOUT_MS` throw in production,
and that a relative `AEGIS_IDEA3_AUDIT_DB_PATH` throws while an absolute path is
accepted.

- [ ] **Step 2: Verify RED**

Run `npx vitest run tests/server/config.test.js` and expect the new cases to fail
because production currently falls back or accepts the relative DB path.

- [ ] **Step 3: Implement minimal strict parsing**

Add `configuredPositiveInteger(name, value, fallback, production)` and
`auditDatabasePath(value, nodeEnv)` helpers. Retain safe defaults when a value is
absent, but throw an error naming the supplied variable when it is malformed in
production. Resolve and require an absolute non-test audit path in production.

- [ ] **Step 4: Write and verify failing readiness tests**

Add one test where a real schema-v2 repository returns HTTP 200 with literal
`{ status: 'READY', audit: 'READY', schemaVersion: 2 }`, and one repository whose
`schemaVersion()` throws and must return HTTP 503 with literal
`{ status: 'DEGRADED', audit: 'DEGRADED' }`. Run the focused test and expect 404
before the route exists.

- [ ] **Step 5: Implement and verify readiness**

Register the readiness route beside health. Probe only `schemaVersion()`; do not
contact adapters, MQTT, or hardware. Run both focused suites and expect PASS.

- [ ] **Step 6: Checkpoint**

Run focused Web tests and `git diff --check`, then commit exact paths with
`feat(idea3): harden production web readiness`.

### Task 2: Server production settings and external paths

**Files:**
- Create: `IDEA3-AEGIS_Lockdown/aegis_soc/production_runtime.py`
- Create: `IDEA3-AEGIS_Lockdown/tests/test_production_runtime.py`
- Modify: `IDEA3-AEGIS_Lockdown/.env.example`

**Interfaces:**
- Consumes: `RuntimePaths.from_environment()`, `LauncherRuntime`, `ControlServer`,
  `status_command()`, and `stop_command()` from the PR8 lifecycle.
- Produces: `ProductionSettings.from_environment(env=None)`,
  `ProductionRuntime(settings)`, `build_parser()`, and `main(argv=None)`.

- [ ] **Step 1: Write failing path/layout tests**

Cover a missing/relative `AEGIS_DATA_DIR`, data root inside the application root,
missing config, missing built `index.html`, non-loopback bind, equal ports, a path
containing spaces, and explicit Node/Web/static paths. The break caught is a
server process writing into or starting from an invalid payload/data layout.

- [ ] **Step 2: Verify RED**

Run `pytest -q tests/test_production_runtime.py` and expect import failure because
the module does not exist.

- [ ] **Step 3: Implement minimal settings**

Create an immutable settings object with explicit Node executable, Web entrypoint,
static directory, application root, runtime paths, profile, dry-run, ports, and
loopback bind. Its `child_environment()` must set absolute Core/Web DB, log,
runtime, static, and config paths without exposing values in output.

- [ ] **Step 4: Verify GREEN and regress PR8 paths**

Run the focused production-runtime tests plus `tests/test_paths.py` and the
launcher-settings subset in `tests/test_windows_launcher.py`; expect PASS.

- [ ] **Step 5: Checkpoint**

Run Ruff on the new files and commit exact paths with
`feat(idea3): add server production runtime settings`.

### Task 3: Composite lifecycle, crash cleanup, and status model

**Files:**
- Modify: `IDEA3-AEGIS_Lockdown/aegis_soc/windows_launcher.py`
- Modify: `IDEA3-AEGIS_Lockdown/aegis_soc/production_runtime.py`
- Modify: `IDEA3-AEGIS_Lockdown/tests/test_windows_launcher.py`
- Modify: `IDEA3-AEGIS_Lockdown/tests/test_production_runtime.py`

**Interfaces:**
- Consumes: `LauncherRuntime.run()`, token-protected `ControlServer`, Core safe
  status, and Web readiness URL.
- Produces: fail-on-child-exit behavior, `ProductionRuntime.snapshot()` with
  `processHealth`, `serviceReadiness`, `audit`, `mqtt`, `idea1`, `idea2`, and
  `physicalEvidence`; `start`, `stop`, `status`, `restart`, and `doctor` commands.

- [ ] **Step 1: Write failing lifecycle tests**

Add behavior tests for Core-before-Web start, Web-before-Core stop, duplicate
start, idempotent stop, spawn failure cleanup, Core exit cleanup, Web exit cleanup,
and no `RESTORE_UPLINK` import/call. Each fake process exposes only `poll`,
`terminate`, `wait`, and `kill`, matching `subprocess.Popen` behavior used here.

- [ ] **Step 2: Verify RED**

Run the focused tests and expect the post-start child-exit cases to fail because
the current loop does not terminate on child failure.

- [ ] **Step 3: Implement minimal crash contract**

Make `LauncherRuntime.run()` detect any exited owned child, persist `FAILED`,
clean the peer child, remove the token, release the lock, and return non-zero.
Keep normal stop `STOPPED`. Do not add internal auto-restart; systemd owns
unexpected restarts.

- [ ] **Step 4: Write and implement service status tests**

Test literal state combinations: both children plus Web/audit ready -> service
`READY`; live process with Web unavailable -> `DEGRADED`; blank MQTT ->
`NOT_CONFIGURED`; absent IDEA1/IDEA2 -> `NOT_CONFIGURED`; physical evidence ->
`UNKNOWN` unless current correlated Core truth proves otherwise. Implement the
smallest snapshot/probe functions that satisfy these cases.

- [ ] **Step 5: Write and implement command tests**

Exercise `start`, `status`, `stop`, `restart`, and `doctor` through injected
factories and HTTP functions. Restart must stop, observe the old control boundary
gone, then start once. An idempotent stop of a missing instance returns success.

- [ ] **Step 6: Verify GREEN and PR8 regression**

Run both launcher test files, the full Python suite, Ruff, and compileall; expect
PASS with only the existing six Windows-only skips on Linux.

- [ ] **Step 7: Checkpoint**

Commit exact lifecycle paths with
`feat(idea3): own core and web service lifecycle`.

### Task 4: Linux service definition and operator runbook

**Files:**
- Delete: `IDEA3-AEGIS_Lockdown/deploy/aegis-supervisor.service.example`
- Create: `IDEA3-AEGIS_Lockdown/deploy/aegis-idea3.service.example`
- Create: `IDEA3-AEGIS_Lockdown/docs/operations/production-runtime.md`
- Modify: `IDEA3-AEGIS_Lockdown/README.md`

**Interfaces:**
- Consumes: `python -m aegis_soc.production_runtime` commands and the external
  data-root contract.
- Produces: install/layout, account/permission, configuration, lifecycle,
  health/readiness, log, backup/restore, diagnosis, rollback, upgrade, absent
  dependency, and secret-rotation procedures.

- [ ] **Step 1: Replace the Core-only service example**

Define `User=aegis-idea3`, `Group=aegis-idea3`, `UMask=0077`, an external
EnvironmentFile, `ExecStart ... production_runtime start`, token-boundary
`ExecStop`, `Restart=on-failure`, bounded stop, `ProtectSystem=strict`,
`ProtectHome=true`, and `ReadWritePaths=/var/lib/aegis-idea3`. Keep it an example;
do not install or run it.

- [ ] **Step 2: Write the runbook**

Document prerequisites, immutable `/opt/aegis-idea3/releases/<sha>` payload,
`/var/lib/aegis-idea3` data, configuration variable names without values,
permissions, exact start/stop/restart/status/doctor/log commands, liveness versus
readiness, schema-v2 DB/WAL/SHM backup and stopped restore, failure diagnosis,
upgrade/rollback, no-hardware/upstream behavior, secret rotation, and explicit
non-deployment status.

- [ ] **Step 3: Update root operator routing**

Link the runbook and replace Core-only systemd wording without claiming that the
example was installed or Production was deployed.

- [ ] **Step 4: Checkpoint**

Run documentation scans, vault validation, and `git diff --check`; commit exact
paths with `docs(idea3): document production runtime operation`.

### Task 5: Focused negative controls and durable regression

**Files:**
- Modify only if a real defect is exposed by existing tests.

**Interfaces:**
- Consumes: existing MQTT, adapter, schema-v2, auth, and audit-persistence suites.
- Produces: fresh PR9 evidence without reimplementing PR6/PR7/PR8 behavior.

- [ ] **Step 1: Run MQTT and Core fail-closed cases**

Run focused Python config/MQTT/runtime/controller tests covering blank and
unavailable broker, dry-run no publication, ACK/physical separation, and shutdown
without RESTORE.

- [ ] **Step 2: Run adapter and evidence cases**

Run Web integration adapter/provider/normalization/correlation tests covering
missing IDEA1/IDEA2, unavailable transport, stale/future/malformed evidence, no
false incident, and containment ineligibility.

- [ ] **Step 3: Run schema-v2 and audit failure cases**

Run SQLite and production reliability tests covering fresh init, v1 migration,
reopen/restart ordering, bounded reads, invalid/unwritable/open/migration/write
failures, and absence of secret canaries.

- [ ] **Step 4: Run production auth/session cases**

Run config/auth/security/production runtime tests covering dev-login denial,
valid/invalid Admin auth, RBAC, CSRF, logout, secret/hash rejection, protected
Security Center, and no secret-bearing response.

- [ ] **Step 5: Record results**

Keep implementation unchanged when existing behavior passes. If any actual
defect appears, open a new RED/GREEN cycle inside the same file boundary and
record the initial failure and fix in the status/handoff.

### Task 6: Production-like isolated acceptance

**Files:**
- Create: `IDEA3-AEGIS_Lockdown/deploy/production-like-acceptance.py`
- Create: `IDEA3-AEGIS_Lockdown/tests/test_production_like_acceptance.py`

**Interfaces:**
- Consumes: built Web assets, composite production runtime, loopback APIs, and a
  disposable external data root.
- Produces: one automated acceptance command with structured PASS/FAIL and cleanup
  output; no Production or hardware access.

- [ ] **Step 1: Write a failing acceptance-driver contract test**

Test that the driver requires an explicit disposable root, refuses a path inside
the source tree, uses lab/headless/dry-run Core with production Web auth, checks
health/readiness/login/snapshot/audit/stop/restart/logout, and always cleans child
processes. Expect import failure before the driver exists.

- [ ] **Step 2: Implement the driver**

Use standard-library subprocess and HTTP clients, dynamically selected loopback
ports, generated test-only session/password material, absolute paths, bounded
deadlines, and `finally` cleanup. Record only value-presence and state names;
never print the generated credential/hash/secret.

- [ ] **Step 3: Verify RED/GREEN unit coverage**

Run `pytest -q tests/test_production_like_acceptance.py`; expect PASS after the
minimal driver exists.

- [ ] **Step 4: Run real isolated acceptance twice across one data root**

Build Web assets, run the driver, require Web `READY`, Admin login, Security
snapshot, audit write/read, stop, restart, old plus new ordered audit, absent
upstreams/hardware, logout, clean stop, and zero live child/residue. Label the
result `PRODUCTION_LIKE_VERIFIED`, never `PRODUCTION_DEPLOYED`.

- [ ] **Step 5: Run negative controls**

Run missing required secret, bad DB path, unavailable IDEA1, malformed/unavailable
IDEA2, unavailable MQTT, and stale evidence cases using disposable config. Every
case must fail closed or degrade explicitly and leave no child process.

- [ ] **Step 6: Checkpoint**

Commit exact acceptance files with
`test(idea3): verify isolated production runtime`.

### Task 7: Reconcile canonical evidence and prepare the Draft handoff

**Files:**
- Modify: `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md`
- Modify: `IDEA3-AEGIS_Lockdown/doc/Content/04_SESSION_HANDOFF.md`
- Modify: this plan only to mark executed checkboxes/results if useful.

**Interfaces:**
- Consumes: exact checkpoint SHAs, commands, counts, failures, cleanup, and Git
  diff from Tasks 1-6.
- Produces: PR9 Current Task, Session Register S1-S8, acceptance matrix, Git
  reconciliation matrix, and handoff at the PR5 merge gate.

- [ ] **Step 1: Record exact evidence**

Update closed sessions with work, defects, fixes, exact files, exact commands and
results, checkpoint SHA, limitations, remaining work, and next session. Keep S7
PR5 sync and S8 final closeout blocked.

- [ ] **Step 2: Build reconciliation matrices**

Record every added/modified/deleted file, before/after behavior, tests, config and
schema state, plus separate planned/implemented/automated/runtime/documented/open
states. Do not collapse maturity levels.

- [ ] **Step 3: Run final verification**

Run focused and full Python/Web tests, Vite build, Ruff, compileall, production
npm audit, repository tests, vault validation, collaboration-policy validation,
Git diff check, secret scan, artifact scan, and cleanup/residue checks.

- [ ] **Step 4: Commit documentation checkpoint**

Record the preceding implementation/evidence checkpoint SHA in the Session
Register and commit exact documentation paths with
`docs(idea3): record partial PR9 runtime evidence`.

- [ ] **Step 5: Publish Draft only**

Fetch `origin`, merge `origin/main` if it advanced, rerun affected checks, push
`feat/idea3-production-runtime-pr9`, and open or update exactly one Draft PR with
`area: idea3`, `owner: music`, `integration-review: no`, and receipt listed as
pending. Do not mark Ready, merge, deploy, or create the final receipt.

- [ ] **Step 6: Stop at the dependency gate**

Report S1-S6 results and leave S7/S8 blocked until the owner states `PR5 MERGED`.
