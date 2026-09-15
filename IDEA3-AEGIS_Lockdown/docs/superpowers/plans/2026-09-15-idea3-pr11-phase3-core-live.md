# AEGIS IDEA3 PR11 Phase 3 Core Live Repository Preparation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prepare and locally verify a dedicated IDEA3 Core-only systemd
runtime without installing it or changing any live host.

**Architecture:** `aegis_soc.supervisor` is the systemd main process and is
started with fixed production/headless/no-detector/no-voice arguments. PR132's
container remains the only Production Web owner, while the historical PR9
composite launcher and unit remain available only as historical/local
compatibility artifacts. Runtime, durable data, configuration, certificate,
and log roots follow the approved FHS separation, and dispatch state becomes an
allowlisted Core status dimension.

**Tech Stack:** Python 3.14, pytest, Ruff, systemd unit configuration, SQLite,
stdlib TLS/urllib.

**Spec:**
`IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-09-15-idea3-pr11-phase3-core-live-design.md`

## Global Constraints

- `PHASE3_RUNTIME_COMPLETE=NO`.
- `PRODUCTION_MUTATION_AUTHORIZED=NO`.
- `IDEA3_PRODUCTION_DEPLOYED=NO`.
- Do not install, enable, start, restart, or stop a real systemd service.
- Do not change a live host, network, VLAN, private AP, HUB, NGINX, Docker,
  MQTT broker, firmware, certificate, CA, CUT, RESTORE, or reboot state.
- Do not modify IDEA1, IDEA2, HUB, shared, infrastructure canonical, PR129, or
  historical-receipt paths.
- Preserve `aegis_soc/production_runtime.py` and its PR9 acceptance drivers.
- Dispatch is disabled by default. Credential/network failures cause no CUT;
  shutdown/restart causes no RESTORE; restart recovery never redispatches.
- `/run/aegis-idea3` is ephemeral only. The dispatch ledger remains exactly
  `/var/lib/aegis-idea3/data/core-dispatch.sqlite3`.
- Do not set CPU/RAM quotas. Repository work may enable systemd accounting and
  hardening only.
- The accepted baseline is Ruff PASS, compileall PASS, and system Python
  `8 failed, 326 passed, 6 skipped` from the pre-existing paho-mqtt 1.6.1
  mismatch.

---

## Change map

| Task | Files | Responsibility |
|---|---|---|
| 1 | `deploy/aegis-idea3-core.service.example`, `deploy/aegis-idea3-core.env.example`, `tests/test_core_service.py`, `aegis_soc/paths.py`, `tests/test_paths.py` | Core-only systemd/process and separated path contract |
| 2 | `aegis_soc/runtime.py`, `aegis_soc/supervisor.py`, `tests/test_runtime.py`, `tests/test_dispatch_boundary.py` | allowlisted dispatch status and degraded/paused reporting |
| 3 | `tests/test_dispatch_client.py`, `tests/test_dispatch_boundary.py` | exact expired-certificate classification and HTTPS/hostname-verification regression |
| 4 | `README.md`, `docs/operations/production-runtime.md` | current Core runtime, future read-only evidence, rollout, and rollback documentation |
| 5 | `idea3-status.md`, `idea3-moc.md`, one new Music receipt at final closeout | canonical task/session state and immutable evidence |

`deploy/aegis-idea3.service.example` is retained. The final reference scan must
show that current Phase 3 operational instructions use the new Core unit while
historical PR9 specifications/plans continue to reference the historical unit
truthfully.

### Task 1: Core-only systemd and path contract

**Files:**

- Create: `IDEA3-AEGIS_Lockdown/deploy/aegis-idea3-core.service.example`
- Create: `IDEA3-AEGIS_Lockdown/deploy/aegis-idea3-core.env.example`
- Create: `IDEA3-AEGIS_Lockdown/tests/test_core_service.py`
- Modify: `IDEA3-AEGIS_Lockdown/aegis_soc/paths.py`
- Modify: `IDEA3-AEGIS_Lockdown/tests/test_paths.py`

**Interfaces:**

- Consumes: `aegis_soc.supervisor.build_parser()`,
  `settings_from_args(args)`, `RuntimePaths.from_environment(env=...)`, and
  `configuration_path(env=...)`.
- Produces: a validated unit whose `ExecStart` parses into a production/live,
  headless, detector-disabled, voice-disabled `RuntimeSettings`; an environment
  template resolving the approved external roots.

- [x] **Step 1: Write the failing P3-C1/C6/C7/C8 service tests**

  Parse the unit with `configparser.ConfigParser(interpolation=None,
  strict=True)` and `shlex.split`. Feed the module arguments following
  `aegis_soc.supervisor` to the real supervisor parser and settings builder.
  Assert literal outcomes:

  ```python
  assert settings.profile == "production"
  assert settings.dry_run is False
  assert settings.start_gui is False
  assert settings.start_detector is False
  assert settings.voice_enabled is False
  assert exec_tokens[1:4] == ["-m", "aegis_soc.supervisor", "--profile"]
  ```

  Assert the parsed unit has `WantedBy=multi-user.target`, no graphical target,
  no IDEA2 dependency/restart relation, accounting enabled, and no CPU/RAM
  quota property. Assert the historical unit and composite module still exist.

- [x] **Step 2: Write the failing real path-resolution tests**

  Load the example environment with `load_dotenv` into a dictionary and call
  `RuntimePaths.from_environment` and `configuration_path` with it. Assert:

  ```python
  assert paths.root == Path("/var/lib/aegis-idea3")
  assert paths.dispatch_db == Path("/var/lib/aegis-idea3/data/core-dispatch.sqlite3")
  assert paths.runtime_dir == Path("/run/aegis-idea3")
  assert paths.log_dir == Path("/var/log/aegis-idea3")
  assert configuration_path(env=values) == Path("/etc/aegis-idea3/core.env")
  assert not paths.dispatch_db.is_relative_to(paths.runtime_dir)
  ```

- [x] **Step 3: Run RED**

  Run:

  ```bash
  /usr/bin/python3 -m pytest -p no:cacheprovider -q \
    tests/test_core_service.py tests/test_paths.py
  ```

  Expected: failure because the Core unit/environment files do not exist and
  `RuntimePaths.from_environment` does not yet honor explicit runtime/log/config
  roots.

- [x] **Step 4: Implement the minimum Core artifacts and path resolution**

  Create the unit with fixed Core-only arguments, systemd directory ownership,
  hardening/accounting, and no quota. Create the non-secret environment
  template with the exact approved paths and `AEGIS_CORE_DISPATCH_ENABLED=0`.
  Change `RuntimePaths.from_environment` to resolve explicit
  `AEGIS_CONFIG_FILE`, `AEGIS_RUNTIME_DIR`, and `AEGIS_RUNTIME_LOG_DIR`, while
  preserving existing defaults when those variables are absent.

- [x] **Step 5: Run GREEN and the path regression**

  Run the Task 1 command again, then:

  ```bash
  /usr/bin/python3 -m pytest -p no:cacheprovider -q tests/test_production_runtime.py
  ```

  Expected: Task 1 tests pass; historical composite tests remain green.

### Task 2: Dispatch status and honest degradation

**Files:**

- Modify: `IDEA3-AEGIS_Lockdown/aegis_soc/runtime.py`
- Modify: `IDEA3-AEGIS_Lockdown/aegis_soc/supervisor.py`
- Modify: `IDEA3-AEGIS_Lockdown/tests/test_runtime.py`
- Modify: `IDEA3-AEGIS_Lockdown/tests/test_dispatch_boundary.py`

**Interfaces:**

- Produces: `RuntimeStatus.dispatch` with
  `DISABLED|ACTIVE|PAUSED_CREDENTIAL|UNAVAILABLE|UNKNOWN`; safe projection key
  `dispatch`; stable issue `DISPATCH_PAUSED`; supervisor degradation when an
  enabled worker is paused/unavailable.
- Consumes: `DispatchWorker.status`, updated by `_tick_dispatch()`.

- [x] **Step 1: Write failing P3-C10 projection tests**

  Assert that a `RuntimeStatus(dispatch="PAUSED_CREDENTIAL")` projects only the
  allowlisted value and `DISPATCH_PAUSED`, while an arbitrary string projects
  `UNKNOWN`. Assert no URL, path, credential detail, physical-containment field,
  or free-text dispatch error enters the projection.

- [x] **Step 2: Write failing supervisor-state tests**

  Inject a worker with `status="PAUSED_CREDENTIAL"`, call `_tick_dispatch()`,
  and assert `status.dispatch` updates and `evaluate_state()` returns
  `RuntimeState.DEGRADED`. Repeat for `UNAVAILABLE`; assert a missing worker
  reports `DISABLED` without degrading.

- [x] **Step 3: Run RED**

  ```bash
  /usr/bin/python3 -m pytest -p no:cacheprovider -q \
    tests/test_runtime.py tests/test_dispatch_boundary.py
  ```

  Expected: failures because the dispatch dimension is not yet represented in
  runtime status and cannot influence `evaluate_state()`.

- [x] **Step 4: Implement the minimum allowlist and state propagation**

  Add the field and allowlist in `runtime.py`. Update `_tick_dispatch()` to
  copy only the worker's known state, using `DISABLED` when no worker exists.
  In `evaluate_state()`, return `DEGRADED` for `PAUSED_CREDENTIAL` or
  `UNAVAILABLE` before the dry-run success branch.

- [x] **Step 5: Run GREEN**

  Run the Task 2 command again and keep every existing runtime/dispatch test
  green.

### Task 3: Exact expired-certificate and HTTPS regression

**Files:**

- Modify: `IDEA3-AEGIS_Lockdown/tests/test_dispatch_client.py`
- Modify: `IDEA3-AEGIS_Lockdown/tests/test_dispatch_boundary.py`

**Interfaces:**

- Consumes: current `DispatchClient._request()` classification of
  `ssl.SSLError` as `CREDENTIAL`, and `DispatchWorker._handle_unavailable()`.
- Produces: regression evidence for the exact expired-certificate exception
  and zero claim/publish side effects.

- [x] **Step 1: Add the exact current-transport characterization**

  Use a transport that raises:

  ```python
  ssl.SSLCertVerificationError(
      1,
      "certificate verify failed: certificate has expired",
  )
  ```

  Assert `DispatchClient.list_pending()` raises
  `DispatchUnavailable(reason="CREDENTIAL")`.

- [x] **Step 2: Add the worker-chain regression**

  Supply the real `DispatchClient` with that failing transport to a real
  `DispatchWorker`/temporary `DispatchLedger`; assert:

  ```python
  assert worker.status == "PAUSED_CREDENTIAL"
  assert ledger.get(ACTION_ID) is None
  assert supervisor.calls == []
  ```

- [x] **Step 3: Verify existing behavior and HTTPS invariants**

  These are characterization tests and may pass immediately because the
  current transport already classifies `SSLError` as `CREDENTIAL`. Also assert
  the existing SSL-context builder does not disable `check_hostname` or
  `CERT_REQUIRED`, and retain the plain-HTTP rejection test.

  Run:

  ```bash
  /usr/bin/python3 -m pytest -p no:cacheprovider -q \
    tests/test_dispatch_client.py tests/test_dispatch_boundary.py
  ```

  Expected: pass. If any exact classification fails, write the smallest
  production change only after observing that failure.

### Task 4: Operations and current documentation

**Files:**

- Modify: `IDEA3-AEGIS_Lockdown/README.md`
- Modify: `IDEA3-AEGIS_Lockdown/docs/operations/production-runtime.md`

**Interfaces:**

- Consumes: Tasks 1–3 exact service, environment, status, and failure behavior.
- Produces: current repository-preparation instructions, future owner-run
  read-only evidence commands, future rollout/rollback gates, and an explicit
  historical PR9 compatibility boundary.

- [x] **Step 1: Replace current operational ownership claims**

  Keep the PR9 composite description labelled historical/local. Add a Phase 3
  section naming PR132's container as Web owner and the new unit as Core owner.
  Do not rewrite historical specs/plans.

- [x] **Step 2: Document exact paths and safe lifecycle**

  Record the approved `/etc`, `/var/lib`, `/run`, and `/var/log` roots;
  dispatch-disabled default; systemd-owned start/stop/restart; no RESTORE;
  restart recovery; D6 isolation; and unmeasured quota gate.

- [x] **Step 3: Add the prepared read-only evidence package**

  Include only commands that report OS/kernel, interfaces/routes, existing
  units, users, storage/CPU/RAM, listeners, certificate metadata/dates, DNS,
  and HTTPS reachability. Never print an environment file, key, token,
  password, or certificate private content.

- [x] **Step 4: Run reference and scope scans**

  ```bash
  rg -n "aegis-idea3\.service|aegis-idea3-core\.service|production_runtime" \
    IDEA3-AEGIS_Lockdown --glob '!web/node_modules/**' --glob '!web/dist/**'
  git diff --name-only origin/main...HEAD
  ```

  Classify each old-unit reference as current (must update) or historical (must
  remain truthful). Confirm no acceptance driver depends on the unit file.

### Task 5: Full validation and canonical closeout

**Files:**

- Modify: `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md`
- Modify: `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-moc.md`
- Create at final handoff only: one timestamped file under
  `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/`, using the required
  `music_idea3-pr11-phase3-repository-preparation.md` topic suffix and the
  actual Asia/Bangkok closeout time.

**Interfaces:**

- Produces: one current Phase 3 Current Task/Session Register and exactly one
  immutable repository-preparation receipt. It never creates a Phase 3 runtime
  receipt.

- [x] **Step 1: Run focused tests**

  ```bash
  /usr/bin/python3 -m pytest -p no:cacheprovider -q \
    tests/test_core_service.py tests/test_paths.py tests/test_runtime.py \
    tests/test_production_runtime.py tests/test_dispatch_boundary.py \
    tests/test_dispatch_client.py
  ```

- [x] **Step 2: Run the complete Python bar**

  ```bash
  ruff check aegis_soc tests --no-cache
  python -m compileall -q aegis_soc tests
  PYTHONDONTWRITEBYTECODE=1 /usr/bin/python3 -m pytest -p no:cacheprovider -q
  ```

  Compare the full suite with `8 failed, 326 passed, 6 skipped`. Every added
  passing test must explain the new pass count. No new failure is acceptable.

- [x] **Step 3: Run repository governance checks**

  ```bash
  git diff --check
  node scripts/validate-vault.mjs --vault Obsidian_AEGIS_Vault/AEGIS_Knowledge
  node --test tests/collaborationPolicy.test.mjs
  git diff --name-status origin/main...HEAD
  ```

  Also inspect added lines for secrets/private-key blocks, binary changes,
  modified historical receipts, and every forbidden path.

- [x] **Step 4: Update canonical notes truthfully**

  Record repository preparation as LOCAL VERIFIED only if evidence supports
  it. Preserve `PHASE3_RUNTIME_COMPLETE=NO`, every K8/K9/K10/K12 runtime gate,
  `PUB_D6_REVIEW=NOT_RECORDED`, and no Production authorization/deployment.

- [x] **Step 5: Create exactly one repository-preparation receipt**

  Copy the repository receipt template and record exact changed paths,
  commands/results, limitations, reference-scan result, and human reviews
  still needed. Never call it a Phase 3 runtime closeout.

- [x] **Step 6: Final diff and readiness audit**

  Confirm the one task branch, exact ancestry, no forbidden changes, one new
  receipt, no historical receipt edits, and no secrets/binaries. The agent may
  prepare a Draft PR but never approve, merge, or perform live mutation.
