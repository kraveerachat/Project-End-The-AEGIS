# IDEA3 PR8 Windows Standalone Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a policy-compliant Windows x64 one-folder candidate that an evaluator can configure and operate through `AEGIS-IDEA3.exe` without preinstalled Python or Node.js.

**Architecture:** A PyInstaller `onedir` launcher owns lifecycle and a loopback control/status boundary, starts the packaged Python Core and a pinned bundled Node runtime, and serves the prebuilt React application through production Express. All secrets, SQLite databases, logs, and runtime state live under an external writable data root.

**Tech Stack:** Python 3.14, PyInstaller 6.22.2, stdlib HTTP/process/file-lock APIs, Node.js 24.20.0, Express 5, React 19, Vite 7, Node `DatabaseSync` SQLite, pytest, Vitest, PowerShell.

**Spec:** `IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-09-08-idea3-pr8-windows-standalone-design.md`

## Global Constraints

- Target Windows 10/11 x64; only a build and smoke test performed on Windows can close Windows acceptance.
- Use PyInstaller 6.22.2 `onedir`; do not use one-file extraction.
- Bundle official Node.js 24.20.0 x64 ZIP with SHA-256 `6cac9ffbca8f6a47091e4b5c772e0606049c3871cb67d900c0cedde630e545ba`.
- Bind launcher and Web services to `127.0.0.1`; open the Web UI as `http://localhost:<port>/security/`.
- Keep application payload read-only and mutable state under `%LOCALAPPDATA%\AEGIS\IDEA3` unless `AEGIS_DATA_DIR` supplies an absolute override.
- Never bundle or log `.env`, credentials, integration tokens, MQTT credentials, HMAC material, Admin PINs, runtime tokens, databases, WAL/SHM files, or logs.
- Preserve `WEB_TO_MQTT = NO`, `WEB_TO_ESP32 = NO`, `WEB_TO_RELAY = NO`, and `ACK != PHYSICAL EVIDENCE`.
- Missing IDEA1/IDEA2 feeds remain `NOT_CONFIGURED` or `UNAVAILABLE`; absent device/relay evidence remains `UNKNOWN`.
- Never send `RESTORE_UPLINK` during start, stop, restart, crash recovery, packaging, or tests.
- Do not modify IDEA1, IDEA2, infrastructure, firmware secrets, network equipment, or physical relay state.
- Generated EXEs, ZIPs, build trees, `dist/`, `node_modules/`, databases, logs, and runtime state are verification artifacts and must not be committed.
- Add exactly one immutable `music` receipt after final verification.

---

## File map

### New runtime files

- `IDEA3-AEGIS_Lockdown/aegis_soc/paths.py`: immutable application-root and external data-root discovery.
- `IDEA3-AEGIS_Lockdown/aegis_soc/platform_lock.py`: POSIX/Windows exclusive file lock.
- `IDEA3-AEGIS_Lockdown/aegis_soc/windows_launcher.py`: launcher CLI, configuration, control server, child orchestration, status, logs, browser opening.
- `IDEA3-AEGIS_Lockdown/tests/test_paths.py`: path/bootstrap contracts.
- `IDEA3-AEGIS_Lockdown/tests/test_platform_lock.py`: lock ownership/release contracts.
- `IDEA3-AEGIS_Lockdown/tests/test_windows_launcher.py`: launcher command and process orchestration contracts.
- `IDEA3-AEGIS_Lockdown/web/server/runtime.js`: testable HTTP server startup and graceful shutdown.
- `IDEA3-AEGIS_Lockdown/web/server/passwordHash.js`: bounded stdin-to-bcrypt helper used by `configure`.
- `IDEA3-AEGIS_Lockdown/web/tests/server/productionRuntime.test.js`: base path, static serving, health, and close tests.
- `IDEA3-AEGIS_Lockdown/web/tests/server/passwordHash.test.js`: password helper non-disclosure and hash-policy tests.

### New packaging files

- `IDEA3-AEGIS_Lockdown/windows/aegis-idea3.spec`: deterministic PyInstaller `onedir` definition.
- `IDEA3-AEGIS_Lockdown/windows/requirements-build.txt`: pinned Windows build dependencies.
- `IDEA3-AEGIS_Lockdown/windows/toolchain-lock.json`: Node/PyInstaller source and hash lock.
- `IDEA3-AEGIS_Lockdown/windows/build.ps1`: clean Windows build and package validation.
- `IDEA3-AEGIS_Lockdown/windows/smoke.ps1`: clean-machine lifecycle and persistence smoke checks.
- `IDEA3-AEGIS_Lockdown/windows/README.md`: evaluator, build, backup, upgrade, and rollback instructions.

### Existing files to modify

- `IDEA3-AEGIS_Lockdown/aegis_soc/config.py`: explicit dotenv bootstrap and data-root-derived defaults.
- `IDEA3-AEGIS_Lockdown/aegis_soc/runtime.py`: Windows capability checks and honest safe projection.
- `IDEA3-AEGIS_Lockdown/aegis_soc/supervisor.py`: platform lock and frozen child-command compatibility.
- `IDEA3-AEGIS_Lockdown/web/server/config.js`: base/static/bind configuration.
- `IDEA3-AEGIS_Lockdown/web/server/createApp.js`: configurable API prefix, health route, static assets, SPA fallback, repository close hook.
- `IDEA3-AEGIS_Lockdown/web/server/index.js`: use the testable runtime and bounded signal shutdown.
- `IDEA3-AEGIS_Lockdown/web/package.json`: password-helper and packaging scripts.
- `IDEA3-AEGIS_Lockdown/.env.example`: external data/Web path documentation without values.
- `IDEA3-AEGIS_Lockdown/.gitignore`: Windows package/runtime artifacts if current ignores do not cover them.
- `IDEA3-AEGIS_Lockdown/README.md` and `IDEA3-AEGIS_Lockdown/web/README.md`: Windows operation and SQLite v2 correction.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md`: current PR7 merge and corrected PR8–PR12 roadmap.
- `IDEA3-AEGIS_Lockdown/doc/Content/04_SESSION_HANDOFF.md`: current PR8 decision, evidence, limitations, and next action.

---

### Task 1: External data-root and configuration bootstrap

**Files:**
- Create: `IDEA3-AEGIS_Lockdown/aegis_soc/paths.py`
- Create: `IDEA3-AEGIS_Lockdown/tests/test_paths.py`
- Modify: `IDEA3-AEGIS_Lockdown/aegis_soc/config.py`
- Modify: `IDEA3-AEGIS_Lockdown/tests/test_core.py`

**Interfaces:**
- Produces: `application_root() -> Path`, `data_root(env: Mapping[str, str] | None = None, platform: str | None = None) -> Path`, `RuntimePaths.from_environment(...) -> RuntimePaths`, and `load_dotenv(path: Path, environ: MutableMapping[str, str]) -> None`.
- Consumed by: Core runtime settings, launcher bootstrap, packaging tests.

- [ ] **Step 1: Write failing path and dotenv tests**

```python
def test_windows_data_root_uses_local_appdata(monkeypatch, tmp_path):
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    assert data_root(platform="win32") == (tmp_path / "AEGIS" / "IDEA3").resolve()

def test_relative_data_root_is_rejected(monkeypatch):
    monkeypatch.setenv("AEGIS_DATA_DIR", "relative/runtime")
    with pytest.raises(ValueError, match="absolute"):
        data_root(platform="win32")

def test_dotenv_does_not_override_process_environment(tmp_path):
    env = {"SESSION_SECRET": "operator-value"}
    dotenv = tmp_path / ".env"
    dotenv.write_text("SESSION_SECRET=file-value\nPORT=8003\n", encoding="utf-8")
    load_dotenv(dotenv, env)
    assert env == {"SESSION_SECRET": "operator-value", "PORT": "8003"}
```

- [ ] **Step 2: Run the focused tests and confirm failure**

Run: `python -m pytest IDEA3-AEGIS_Lockdown/tests/test_paths.py IDEA3-AEGIS_Lockdown/tests/test_core.py -q`

Expected: collection fails because `aegis_soc.paths` and explicit `load_dotenv` do not exist.

- [ ] **Step 3: Implement immutable/writable path separation**

```python
@dataclass(frozen=True)
class RuntimePaths:
    root: Path
    config_file: Path
    core_db: Path
    web_db: Path
    runtime_dir: Path
    log_dir: Path

    @classmethod
    def from_environment(cls, env=None, platform=None):
        root = data_root(env=env, platform=platform)
        return cls(root, root / "config" / ".env", root / "data" / "core-audit.sqlite3",
                   root / "data" / "security-center-audit.sqlite3",
                   root / "runtime", root / "logs")
```

Remove import-time current-directory dotenv discovery. Launcher mode sets `AEGIS_CONFIG_FILE`; source development continues to accept repository `.env` only when no explicit config file/data root is supplied. Derive DB/log defaults from `RuntimePaths` when `AEGIS_DATA_DIR` is set.

- [ ] **Step 4: Run focused and existing config tests**

Run: `python -m pytest IDEA3-AEGIS_Lockdown/tests/test_paths.py IDEA3-AEGIS_Lockdown/tests/test_core.py IDEA3-AEGIS_Lockdown/tests/test_runtime.py -q`

Expected: all selected tests pass; no real secret value is printed.

- [ ] **Step 5: Commit the self-contained path contract**

```bash
git add IDEA3-AEGIS_Lockdown/aegis_soc/paths.py IDEA3-AEGIS_Lockdown/aegis_soc/config.py IDEA3-AEGIS_Lockdown/tests/test_paths.py IDEA3-AEGIS_Lockdown/tests/test_core.py
git diff --cached --check
git commit -m "feat(idea3): add external runtime path contract"
```

### Task 2: Cross-platform single-instance and child-process substrate

**Files:**
- Create: `IDEA3-AEGIS_Lockdown/aegis_soc/platform_lock.py`
- Create: `IDEA3-AEGIS_Lockdown/tests/test_platform_lock.py`
- Modify: `IDEA3-AEGIS_Lockdown/aegis_soc/supervisor.py`
- Modify: `IDEA3-AEGIS_Lockdown/tests/test_runtime.py`

**Interfaces:**
- Consumes: `RuntimeSettings.lock_path` and `RuntimeSettings.pid_path`.
- Produces: `ExclusiveFileLock(path: Path, owner_text: str)`, `.acquire()`, `.release()`, and `supervisor_command(argv: Sequence[str]) -> list[str]` that returns a frozen self-command or source module command.

- [ ] **Step 1: Write failing exclusive-lock tests**

```python
def test_second_lock_owner_is_rejected(tmp_path):
    first = ExclusiveFileLock(tmp_path / "aegis.lock", "first")
    second = ExclusiveFileLock(tmp_path / "aegis.lock", "second")
    first.acquire()
    try:
        with pytest.raises(AlreadyRunningError):
            second.acquire()
    finally:
        first.release()

def test_released_lock_can_be_reacquired(tmp_path):
    lock = ExclusiveFileLock(tmp_path / "aegis.lock", "owner")
    lock.acquire(); lock.release(); lock.acquire(); lock.release()
```

- [ ] **Step 2: Confirm the new tests fail**

Run: `python -m pytest IDEA3-AEGIS_Lockdown/tests/test_platform_lock.py -q`

Expected: import failure for `aegis_soc.platform_lock`.

- [ ] **Step 3: Implement POSIX and Windows locking behind one class**

Use `fcntl.flock(... LOCK_EX | LOCK_NB)` only inside the POSIX backend and `msvcrt.locking(... LK_NBLCK, 1)` only inside the Windows backend. Keep the file handle open for ownership, write only the supplied non-secret owner text, and always unlock/close in `release()`.

- [ ] **Step 4: Replace direct `fcntl` use and make frozen invocation explicit**

```python
def supervisor_command(arguments):
    if getattr(sys, "frozen", False):
        return [sys.executable, "core", *arguments]
    return [sys.executable, "-m", "aegis_soc.supervisor", *arguments]
```

The existing Linux supervisor continues using the same lock semantics. Do not change command authentication or shutdown behavior.

- [ ] **Step 5: Run lock and supervisor regressions**

Run: `python -m pytest IDEA3-AEGIS_Lockdown/tests/test_platform_lock.py IDEA3-AEGIS_Lockdown/tests/test_runtime.py -q`

Expected: all tests pass, including duplicate-instance and no-restore shutdown assertions.

- [ ] **Step 6: Commit**

```bash
git add IDEA3-AEGIS_Lockdown/aegis_soc/platform_lock.py IDEA3-AEGIS_Lockdown/aegis_soc/supervisor.py IDEA3-AEGIS_Lockdown/tests/test_platform_lock.py IDEA3-AEGIS_Lockdown/tests/test_runtime.py
git diff --cached --check
git commit -m "fix(idea3): isolate platform runtime primitives"
```

### Task 3: Honest Windows capability and runtime projection

**Files:**
- Modify: `IDEA3-AEGIS_Lockdown/aegis_soc/runtime.py`
- Modify: `IDEA3-AEGIS_Lockdown/tests/test_runtime.py`

**Interfaces:**
- Produces: `platform_capabilities(platform: str | None = None) -> Mapping[str, bool]` and an unchanged `safe_status_projection(...) -> dict` schema.
- Consumed by: launcher doctor/status endpoint and PR7 live provider.

- [ ] **Step 1: Add failing capability and truth tests**

```python
def test_windows_rejects_linux_only_components(monkeypatch):
    settings = RuntimeSettings.from_profile("lab", start_detector=True, start_gui=True)
    errors, _ = settings.preflight(platform="win32")
    assert "detector is unavailable on Windows" in errors
    assert "Tk operator GUI is not packaged on Windows" in errors

def test_dry_run_with_unknown_device_is_not_projected_healthy():
    projection = safe_status_projection(RuntimeStatus(
        state="RUNNING", dry_run=True, broker="UNKNOWN", device="UNKNOWN", uplink="UNKNOWN"
    ))
    assert projection["status"] == "UNKNOWN"
    assert "ESP32_UNAVAILABLE" in projection["issues"]
```

- [ ] **Step 2: Confirm tests fail for current false-healthy behavior**

Run: `python -m pytest IDEA3-AEGIS_Lockdown/tests/test_runtime.py -q`

Expected: the Windows capability interface is absent and dry-run projects `HEALTHY`.

- [ ] **Step 3: Implement fail-closed capability checks and projection**

Keep Core `RUNNING` as a process state, but return `UNKNOWN` from the safe projection when broker/device/uplink evidence required for health is unknown. Return `DEGRADED` for known disconnected/failed states. Do not add `NORMAL`, `EXECUTED`, or physical-state claims.

- [ ] **Step 4: Run all runtime tests**

Run: `python -m pytest IDEA3-AEGIS_Lockdown/tests/test_runtime.py -q`

Expected: all tests pass and historical security-state tests remain unchanged.

- [ ] **Step 5: Commit**

```bash
git add IDEA3-AEGIS_Lockdown/aegis_soc/runtime.py IDEA3-AEGIS_Lockdown/tests/test_runtime.py
git diff --cached --check
git commit -m "fix(idea3): preserve unknown hardware truth on Windows"
```

### Task 4: Production Web base path, assets, health, and shutdown

**Files:**
- Create: `IDEA3-AEGIS_Lockdown/web/server/runtime.js`
- Create: `IDEA3-AEGIS_Lockdown/web/tests/server/productionRuntime.test.js`
- Modify: `IDEA3-AEGIS_Lockdown/web/server/config.js`
- Modify: `IDEA3-AEGIS_Lockdown/web/server/createApp.js`
- Modify: `IDEA3-AEGIS_Lockdown/web/server/index.js`
- Modify: `IDEA3-AEGIS_Lockdown/web/tests/server/config.test.js`

**Interfaces:**
- Produces: `startServer({ config, appFactory, onSignal }) -> Promise<{ server, close }>` and `createApp({ ..., basePath, staticDir })` while preserving existing test-mode `/api` routes.
- Consumed by: bundled Node entry point and launcher health checks.

- [ ] **Step 1: Write failing production-runtime tests**

```javascript
it('serves the built application and prefixed API without an API-to-HTML fallback', async () => {
  const app = createApp({ config: productionConfig({ webBasePath: '/security', staticDir }), repository })
  expect((await request(app).get('/security/')).status).toBe(200)
  expect((await request(app).get('/security/assets/app.js')).headers['cache-control']).toMatch(/immutable/)
  expect((await request(app).get('/security/api/health')).body).toEqual({ status: 'ok' })
  expect((await request(app).get('/security/api/not-real')).type).toMatch(/json/)
})

it('closes the listener and repository exactly once', async () => {
  const closeRepository = vi.fn()
  const runtime = await startServer({ config, repository: { ...repository, close: closeRepository } })
  await runtime.close(); await runtime.close()
  expect(closeRepository).toHaveBeenCalledTimes(1)
})
```

- [ ] **Step 2: Run the focused tests and verify failure**

Run: `cd IDEA3-AEGIS_Lockdown/web && npm test -- --run tests/server/productionRuntime.test.js tests/server/config.test.js`

Expected: failures for missing static/base-path/runtime behavior.

- [ ] **Step 3: Add validated Web configuration**

`AEGIS_WEB_BASE_PATH` accepts `''` or one normalized absolute URL path without traversal. `AEGIS_WEB_STATIC_DIR` must be absolute in production and contain `index.html`. `AEGIS_BIND_HOST` must be `127.0.0.1` or `::1`; the Windows launcher sets `127.0.0.1`.

- [ ] **Step 4: Implement API-first static serving**

Register `${basePath}/api/auth`, `${basePath}/api/security`, and `${basePath}/api/health` before static middleware. Use `express.static` with immutable caching for hashed assets and `no-store` for `index.html`. SPA fallback applies only to HTML `GET`/`HEAD` outside `${basePath}/api`.

- [ ] **Step 5: Implement idempotent graceful shutdown**

`runtime.js` owns `http.Server`, stops accepting requests, awaits close, then calls `repository.close()` once. `index.js` handles `SIGINT` and `SIGTERM`, reports error types without secret-bearing messages, and sets a nonzero exit code on startup/shutdown failure.

- [ ] **Step 6: Run Web security and production tests**

Run: `cd IDEA3-AEGIS_Lockdown/web && npm test -- --run tests/server/productionRuntime.test.js tests/server/config.test.js tests/server/auth.test.js tests/server/security.test.js tests/server/securityRoutes.test.js`

Expected: all selected files pass; existing auth, CSRF, RBAC, and same-origin behavior remains intact.

- [ ] **Step 7: Commit**

```bash
git add IDEA3-AEGIS_Lockdown/web/server/runtime.js IDEA3-AEGIS_Lockdown/web/server/index.js IDEA3-AEGIS_Lockdown/web/server/config.js IDEA3-AEGIS_Lockdown/web/server/createApp.js IDEA3-AEGIS_Lockdown/web/tests/server/productionRuntime.test.js IDEA3-AEGIS_Lockdown/web/tests/server/config.test.js
git diff --cached --check
git commit -m "feat(idea3): serve the production security center"
```

### Task 5: Launcher control/status service and child orchestration

**Files:**
- Create: `IDEA3-AEGIS_Lockdown/aegis_soc/windows_launcher.py`
- Create: `IDEA3-AEGIS_Lockdown/tests/test_windows_launcher.py`

**Interfaces:**
- Consumes: `RuntimePaths`, `ExclusiveFileLock`, `safe_status_projection`, bundled application paths, Core and Web commands.
- Produces: `LauncherSettings`, `LauncherRuntime.run() -> int`, `ControlServer`, and `main(argv: Sequence[str] | None = None) -> int`.

- [ ] **Step 1: Write failing control-boundary tests**

```python
def test_core_status_is_safe_and_stop_requires_token(running_control_server):
    status = request_json(running_control_server.url("/v1/core-status"))
    assert "pid" not in json.dumps(status)
    assert post(running_control_server.url("/v1/stop")).status == 403
    assert post(running_control_server.url("/v1/stop"), headers={
        "X-AEGIS-Control-Token": running_control_server.token
    }).status == 202

def test_missing_children_never_report_healthy(fake_processes):
    runtime = LauncherRuntime(settings(), process_factory=fake_processes.factory)
    fake_processes.node.exit(1)
    assert runtime.snapshot()["components"]["web"] == "FAILED"
    assert runtime.snapshot()["status"] != "HEALTHY"
```

- [ ] **Step 2: Confirm launcher tests fail**

Run: `python -m pytest IDEA3-AEGIS_Lockdown/tests/test_windows_launcher.py -q`

Expected: import failure for the new launcher.

- [ ] **Step 3: Implement allowlisted settings and status documents**

`LauncherSettings` validates absolute payload/data paths, ports in 1–65535, distinct Web/control ports, loopback host, and existing `node.exe`, server entry, static `index.html`, and config file. Status exposes only state vocabulary, timestamps, profile, dry-run, and component states.

- [ ] **Step 4: Implement authenticated loopback control server**

Use `ThreadingHTTPServer`. Compare the stop token with `secrets.compare_digest`. Set `Cache-Control: no-store`, reject non-loopback clients, cap request bodies at zero for stop, and suppress default request logging.

- [ ] **Step 5: Implement child lifecycle**

Start Core before Web. Inject secrets only through the inherited environment. Node receives `NODE_ENV=production`, database/static/base paths, adapter configuration, and only the public Core status URL. Shutdown order is Web, Core, control server; wait 15 seconds, then terminate only the known child process. Never issue a controller action.

- [ ] **Step 6: Implement detached start and command routing**

In frozen mode, `start` invokes `[sys.executable, "run", ...]`; `core` invokes `AegisSupervisor(...).run()`. On Windows detached start uses explicit `creationflags` and an explicit argument list, never `shell=True`. Source-mode tests inject all subprocess/browser functions.

- [ ] **Step 7: Run launcher/runtime tests**

Run: `python -m pytest IDEA3-AEGIS_Lockdown/tests/test_windows_launcher.py IDEA3-AEGIS_Lockdown/tests/test_runtime.py IDEA3-AEGIS_Lockdown/tests/test_platform_lock.py -q`

Expected: all pass; stop-without-token, duplicate-instance, child-failure, cleanup, no-restore, and redaction cases are covered.

- [ ] **Step 8: Commit**

```bash
git add IDEA3-AEGIS_Lockdown/aegis_soc/windows_launcher.py IDEA3-AEGIS_Lockdown/tests/test_windows_launcher.py
git diff --cached --check
git commit -m "feat(idea3): add Windows launcher lifecycle"
```

### Task 6: Secure configuration provisioning and evaluator commands

**Files:**
- Create: `IDEA3-AEGIS_Lockdown/web/server/passwordHash.js`
- Create: `IDEA3-AEGIS_Lockdown/web/tests/server/passwordHash.test.js`
- Modify: `IDEA3-AEGIS_Lockdown/aegis_soc/windows_launcher.py`
- Modify: `IDEA3-AEGIS_Lockdown/tests/test_windows_launcher.py`
- Modify: `IDEA3-AEGIS_Lockdown/web/package.json`

**Interfaces:**
- Produces: `hashPasswordFromStdin({ input, output }) -> Promise<number>` and launcher commands `configure`, `start`, `stop`, `status`, `logs`, `open`, `doctor`.
- Consumed by: evaluator workflow and Windows smoke script.

- [ ] **Step 1: Write failing password and configuration tests**

```javascript
it('writes only a policy-valid bcrypt hash', async () => {
  const output = captureOutput()
  await hashPasswordFromStdin({ input: streamOf('correct horse battery staple\n'), output })
  expect(output.text()).toMatch(/^\$2[aby]\$12\$/)
  expect(output.text()).not.toContain('correct horse battery staple')
})
```

```python
def test_configure_writes_atomic_external_config_without_plaintext(tmp_path, fake_hasher):
    result = configure(paths_for(tmp_path), username="admin", password="secret-value", overwrite=False,
                       password_hasher=fake_hasher)
    text = result.read_text(encoding="utf-8")
    assert "SESSION_SECRET=" in text
    assert "AEGIS_IDEA3_ADMIN_PASSWORD_HASH=$2b$12$" in text
    assert "secret-value" not in text
```

- [ ] **Step 2: Confirm focused tests fail**

Run: `cd IDEA3-AEGIS_Lockdown/web && npm test -- --run tests/server/passwordHash.test.js`

Run: `python -m pytest IDEA3-AEGIS_Lockdown/tests/test_windows_launcher.py -q`

Expected: missing helper and configure command failures.

- [ ] **Step 3: Implement stdin-only bcrypt helper**

Read one bounded password line from stdin, reject empty or over-1024-byte input, hash at cost 12 with `bcryptjs`, write only the hash plus newline, and return nonzero without echoing input on error.

- [ ] **Step 4: Implement atomic external configuration**

Generate `SESSION_SECRET` with `secrets.token_urlsafe(48)`. Write `NODE_ENV=production`, Web user/hash, external DB path, base/static settings, and blank optional integration/MQTT values to a temporary file, `fsync`, and `os.replace`. Reject overwrite unless `--force` is provided. Password and secret values must never enter command arguments or output.

- [ ] **Step 5: Complete evaluator commands**

`status` queries the launcher endpoint and returns nonzero for stopped/degraded/failed states. `logs` tails external logs or opens their folder. `open` uses `webbrowser.open` only after Web health succeeds. `doctor` validates config, payload, writable paths, ports, and platform capabilities without contacting or actuating hardware.

- [ ] **Step 6: Run focused security tests**

Run: `cd IDEA3-AEGIS_Lockdown/web && npm test -- --run tests/server/passwordHash.test.js tests/server/config.test.js tests/server/auth.test.js tests/server/security.test.js`

Run: `python -m pytest IDEA3-AEGIS_Lockdown/tests/test_windows_launcher.py IDEA3-AEGIS_Lockdown/tests/test_paths.py -q`

Expected: all pass and captured stdout/stderr contain no input password or generated secret.

- [ ] **Step 7: Commit**

```bash
git add IDEA3-AEGIS_Lockdown/web/server/passwordHash.js IDEA3-AEGIS_Lockdown/web/tests/server/passwordHash.test.js IDEA3-AEGIS_Lockdown/web/package.json IDEA3-AEGIS_Lockdown/aegis_soc/windows_launcher.py IDEA3-AEGIS_Lockdown/tests/test_windows_launcher.py
git diff --cached --check
git commit -m "feat(idea3): add secure standalone configuration"
```

### Task 7: Deterministic Windows package build

**Files:**
- Create: `IDEA3-AEGIS_Lockdown/windows/aegis-idea3.spec`
- Create: `IDEA3-AEGIS_Lockdown/windows/requirements-build.txt`
- Create: `IDEA3-AEGIS_Lockdown/windows/toolchain-lock.json`
- Create: `IDEA3-AEGIS_Lockdown/windows/build.ps1`
- Modify: `IDEA3-AEGIS_Lockdown/.gitignore`
- Modify: `IDEA3-AEGIS_Lockdown/tests/test_windows_launcher.py`

**Interfaces:**
- Consumes: launcher entry point, Web build, production Node dependencies, pinned Node archive.
- Produces: untracked `windows/out/AEGIS-IDEA3/` and `windows/out/AEGIS-IDEA3-<source-sha>.zip`, plus a manifest containing source/toolchain/artifact hashes but no secret values.

- [ ] **Step 1: Write failing packaging-contract tests**

```python
def test_toolchain_lock_pins_verified_node_archive():
    lock = json.loads((WINDOWS / "toolchain-lock.json").read_text())
    assert lock["node"]["version"] == "24.20.0"
    assert lock["node"]["sha256"] == "6cac9ffbca8f6a47091e4b5c772e0606049c3871cb67d900c0cedde630e545ba"

def test_spec_is_onedir_and_excludes_secret_runtime_inputs():
    spec = (WINDOWS / "aegis-idea3.spec").read_text()
    assert "EXE(" in spec and "COLLECT(" in spec
    assert ".env" not in spec
    assert "*.sqlite" not in spec
```

- [ ] **Step 2: Confirm packaging tests fail**

Run: `python -m pytest IDEA3-AEGIS_Lockdown/tests/test_windows_launcher.py -q`

Expected: missing packaging files.

- [ ] **Step 3: Add pinned toolchain inputs**

`requirements-build.txt` contains `pyinstaller==6.22.2`. `toolchain-lock.json` contains the exact official HTTPS Node archive URL, filename, version, architecture, and SHA-256 from the design.

- [ ] **Step 4: Implement the PyInstaller spec**

Use `console=True`, name `AEGIS-IDEA3`, explicit project `pathex`, and `COLLECT` for `onedir`. Include only required Python packages/resources; do not include Web, Node, configuration, databases, logs, tests, or source documentation inside the PyInstaller executable layer.

- [ ] **Step 5: Implement fail-fast PowerShell build stages**

The script checks Windows/x64, clean Git status, exact Python/PyInstaller/Node inputs, and Node SHA-256. It runs Python tests, Web tests/build, copies an allowlisted server payload, prunes dev dependencies, invokes PyInstaller, copies Node/server/Web/default template/notices, writes manifest hashes, scans forbidden filename/content patterns, ZIPs output, and verifies source Git remains clean.

- [ ] **Step 6: Add artifact ignores and run source-side tests**

Ignore `windows/cache/`, `windows/build/`, `windows/dist/`, and `windows/out/`. Do not broaden ignores to secret files outside IDEA3.

Run: `python -m pytest IDEA3-AEGIS_Lockdown/tests/test_windows_launcher.py -q`

Expected: packaging contract tests pass.

- [ ] **Step 7: Run PowerShell parser validation where available**

Run: `pwsh -NoProfile -Command '$errors=$null; [System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path "IDEA3-AEGIS_Lockdown/windows/build.ps1"),[ref]$null,[ref]$errors) > $null; if ($errors.Count) { $errors | Out-String | Write-Error }'`

Expected: exit 0. If `pwsh` is unavailable on Linux, record `NOT_RUN_ON_LINUX`; Windows build execution remains mandatory.

- [ ] **Step 8: Commit**

```bash
git add IDEA3-AEGIS_Lockdown/windows IDEA3-AEGIS_Lockdown/.gitignore IDEA3-AEGIS_Lockdown/tests/test_windows_launcher.py
git diff --cached --check
git commit -m "build(idea3): add deterministic Windows bundle"
```

### Task 8: Restart persistence and clean-machine smoke acceptance

**Files:**
- Create: `IDEA3-AEGIS_Lockdown/windows/smoke.ps1`
- Modify: `IDEA3-AEGIS_Lockdown/web/tests/server/productionRuntime.test.js`
- Modify: `IDEA3-AEGIS_Lockdown/web/tests/server/sqliteRepository.test.js`
- Modify: `IDEA3-AEGIS_Lockdown/tests/test_windows_launcher.py`

**Interfaces:**
- Consumes: built bundle, launcher commands, Web login/API, external SQLite path.
- Produces: machine-readable `windows/out/evidence/smoke-result.json` and console pass/fail summary; evidence directory stays untracked.

- [ ] **Step 1: Add failing restart-order and audit-persistence tests**

Test that launcher stop waits for Web close before reporting stopped, leaves external databases untouched, and does not call any controller command. Extend Web persistence coverage to open schema v1, migrate to v2, record an auth audit, close, reopen, and recover the same audit.

- [ ] **Step 2: Run the focused tests and observe failure**

Run: `python -m pytest IDEA3-AEGIS_Lockdown/tests/test_windows_launcher.py -q`

Run: `cd IDEA3-AEGIS_Lockdown/web && npm test -- --run tests/server/productionRuntime.test.js tests/server/sqliteRepository.test.js`

Expected: new lifecycle assertions fail until shutdown/persistence hooks are complete.

- [ ] **Step 3: Make the minimum lifecycle corrections**

Correct only defects exposed by the tests. Do not change schema version, containment semantics, or audit record allowlists.

- [ ] **Step 4: Implement Windows smoke script**

The script accepts `-BundlePath` and a disposable `-DataPath`, confirms `python`, `node`, and `npm` are not used from `PATH`, configures credentials through stdin, starts, waits for health, logs in, logs out, records audit count, stops, restarts, confirms audit count is preserved, checks missing feeds/hardware truth, stops, and checks no bundle child remains. It writes no password/token values to output.

- [ ] **Step 5: Run source-side lifecycle tests**

Run: `python -m pytest IDEA3-AEGIS_Lockdown/tests/test_windows_launcher.py -q`

Run: `cd IDEA3-AEGIS_Lockdown/web && npm test -- --run tests/server/productionRuntime.test.js tests/server/sqliteRepository.test.js tests/server/productionReliability.test.js`

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add IDEA3-AEGIS_Lockdown/windows/smoke.ps1 IDEA3-AEGIS_Lockdown/tests/test_windows_launcher.py IDEA3-AEGIS_Lockdown/web/tests/server/productionRuntime.test.js IDEA3-AEGIS_Lockdown/web/tests/server/sqliteRepository.test.js
git diff --cached --check
git commit -m "test(idea3): cover Windows restart persistence"
```

### Task 9: Operator, build, backup, and rollback documentation

**Files:**
- Modify: `IDEA3-AEGIS_Lockdown/.env.example`
- Modify: `IDEA3-AEGIS_Lockdown/README.md`
- Modify: `IDEA3-AEGIS_Lockdown/web/README.md`
- Create: `IDEA3-AEGIS_Lockdown/windows/README.md`

**Interfaces:**
- Documents: exact configure/start/stop/status/log/open/doctor commands, data locations, known unsupported components, build inputs, backup/restore, upgrade/rollback, and no-secret rules.

- [ ] **Step 1: Update the non-secret configuration template**

Add blank or safe example entries for `AEGIS_DATA_DIR`, `AEGIS_CONFIG_FILE`, `AEGIS_WEB_BASE_PATH`, `AEGIS_WEB_STATIC_DIR`, `AEGIS_BIND_HOST`, and launcher control port. Keep all credential/token values blank.

- [ ] **Step 2: Document evaluator workflow and limitations**

State that default package launch is lab/headless/dry-run with Web production authentication; detector, voice, UFW, and Tk GUI are unavailable in the Windows candidate; hardware and upstream states remain unknown/not configured. Explain that production requires explicit HMAC/Admin PIN/MQTT configuration and still does not prove physical state.

- [ ] **Step 3: Correct current Web persistence documentation**

Change the stale schema-v1 statement to schema v2 and retain the stop-before-backup rule for the DB plus WAL/SHM companions.

- [ ] **Step 4: Document build and rollback**

Document pinned toolchain, exact PowerShell build/smoke commands, output locations, non-commit artifact rule, manifest/hash inspection, external data preservation, and rollback by replacing only the immutable application directory.

- [ ] **Step 5: Check documentation and commit**

Run: `git diff --check`

Run: `rg -n "SESSION_SECRET=.+|INTEGRATION_TOKEN=.+|AEGIS_HMAC_SECRET=.+|AEGIS_ADMIN_PIN=.+" IDEA3-AEGIS_Lockdown/.env.example IDEA3-AEGIS_Lockdown/windows IDEA3-AEGIS_Lockdown/README.md IDEA3-AEGIS_Lockdown/web/README.md`

Expected: diff check passes and the secret-value scan returns no matches.

```bash
git add IDEA3-AEGIS_Lockdown/.env.example IDEA3-AEGIS_Lockdown/README.md IDEA3-AEGIS_Lockdown/web/README.md IDEA3-AEGIS_Lockdown/windows/README.md
git diff --cached --check
git commit -m "docs(idea3): document Windows standalone operation"
```

### Task 10: Fresh Linux regression and generated-artifact checks

**Files:**
- Modify only files required to fix failures caused by PR8.

**Interfaces:**
- Produces: fresh Linux evidence; does not produce Windows acceptance.

- [ ] **Step 1: Run Python verification**

Run: `python -m pytest IDEA3-AEGIS_Lockdown/tests -q`

Run: `python -m ruff check IDEA3-AEGIS_Lockdown/aegis_soc IDEA3-AEGIS_Lockdown/tests`

Run: `python -m compileall -q IDEA3-AEGIS_Lockdown/aegis_soc`

Expected: zero failures/errors.

- [ ] **Step 2: Run Web verification**

Run: `cd IDEA3-AEGIS_Lockdown/web && npm test -- --run`

Run: `cd IDEA3-AEGIS_Lockdown/web && npm run build`

Run: `cd IDEA3-AEGIS_Lockdown/web && npm audit --omit=dev --offline`

Expected: tests/build pass; audit result recorded exactly.

- [ ] **Step 3: Run repository and policy-adjacent checks**

Run: `node --test tests/*.test.mjs`

Run: `node scripts/validate-vault.mjs`

Run: `git diff --check`

Expected: all applicable checks pass; known vault warnings are recorded, not hidden.

- [ ] **Step 4: Scan secrets and generated artifacts**

Run: `git ls-files | rg '(^|/)(dist|build|node_modules|windows/out|windows/cache)/|\.exe$|\.sqlite3?$|\.db$|\.log$|(^|/)\.env$'`

Run: `git diff --cached --name-only`

Expected: no forbidden tracked/generated paths and only intentional IDEA3 paths.

- [ ] **Step 5: Fix only root causes and rerun the affected complete suite**

Any failure changes the plan status to partial until its exact suite passes. Do not weaken assertions or label Linux results as Windows evidence.

### Task 11: Windows build and clean-machine acceptance

**Files:**
- No tracked source changes expected; generated evidence remains outside Git.

**Interfaces:**
- Produces: exact Windows environment/version record, artifact SHA-256, build result, smoke JSON, and limitations for the receipt.

- [ ] **Step 1: Build on Windows x64**

Run from PowerShell:

```powershell
Set-Location IDEA3-AEGIS_Lockdown
pwsh -NoProfile -File windows/build.ps1
```

Expected: `windows/out/AEGIS-IDEA3/` and ZIP exist, Node input hash matches the lock, package scan passes, and Git remains clean.

- [ ] **Step 2: Run the package on a clean Windows VM**

Copy only the candidate ZIP to a Windows 10/11 x64 VM without project Python/Node installations, expand it, and run:

```powershell
pwsh -NoProfile -File windows/smoke.ps1 -BundlePath .\AEGIS-IDEA3 -DataPath "$env:TEMP\AEGIS-PR8-SMOKE"
```

Expected: configure, start, login, logout, status, logs, stop, restart, audit persistence, and child cleanup pass.

- [ ] **Step 3: Inspect truth and security manually**

Confirm IDEA1/IDEA2 are `NOT_CONFIGURED` or `UNAVAILABLE`, ESP32/relay/physical state is `UNKNOWN`, Web cannot publish MQTT/relay commands, production cookie login works at `http://localhost:<port>`, and no secret appears in console/log/status/manifest.

- [ ] **Step 4: Record exact evidence**

Record Windows edition/build, architecture, Python/Node/npm/PyInstaller versions, source SHA, commands, pass/fail counts, warnings, ZIP SHA-256, and whether forced termination was needed. If this environment is unavailable, mark Task 11 `BLOCKED` and PR8 `IMPLEMENTED_UNEXERCISED`; do not fabricate results.

### Task 12: Canonical knowledge, receipt, collaboration policy, push, and Draft PR

**Files:**
- Modify: `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md`
- Modify: `IDEA3-AEGIS_Lockdown/doc/Content/04_SESSION_HANDOFF.md`
- Create: one receipt under `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/`; Step 3 assigns its exact filename from the actual Bangkok completion timestamp.

**Interfaces:**
- Produces: canonical current status, immutable task evidence, pushed branch, and one Draft PR.

- [ ] **Step 1: Reconcile durable facts**

Record PR7 as merged through GitHub PR #104 at `c68946cb`, correct the project sequence to PR8 Windows, PR9 deployment preparation, PR10 hardware closure, PR11 Kali E2E, PR12 final acceptance, and retain all upstream/hardware open states. Record PR8 as closed only if Windows Task 11 passed; otherwise use `IMPLEMENTED_UNEXERCISED` or `BLOCKED` with the exact reason.

- [ ] **Step 2: Update the persistent handoff**

Append a current PR8 section containing base/branch/HEAD, implemented files, exact verification, Windows evidence state, safety invariants, no-deploy/no-merge state, and the next command. Do not rewrite historical sections.

- [ ] **Step 3: Create exactly one receipt from the template**

Use the actual Bangkok timestamp after verification:

```bash
receipt_path="Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/$(TZ=Asia/Bangkok date +%Y-%m-%d_%H%M%S)_music_idea3-pr8-windows-standalone.md"
cp Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/_template.md "$receipt_path"
```

Fill every required field with exact results, paths, limitations, canonical updates, and `Shared surfaces touched: None` only if the final diff confirms IDEA3-only ownership.

- [ ] **Step 4: Run final policy and integrity checks**

Run: `git status --short`

Run: `git diff --check`

Run: `git diff --name-status origin/main...HEAD`

Run: `node scripts/validate-vault.mjs`

Run: `node scripts/validate-collaboration-policy.mjs --base origin/main --head HEAD --event pull_request --body-file /tmp/aegis-idea3-pr8-pr-body.md`

Expected: exactly one new receipt, no old receipt changes, all changed paths declared, and policy validation passes. The PR body file is local/untracked and contains the actual completed policy block and exact receipt path.

- [ ] **Step 5: Stage and commit only final knowledge/evidence paths**

```bash
git add Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md IDEA3-AEGIS_Lockdown/doc/Content/04_SESSION_HANDOFF.md "$receipt_path"
git diff --cached --check
git diff --cached --name-status
git commit -m "docs(idea3): record PR8 standalone evidence"
```

- [ ] **Step 6: Push normally and open a Draft PR**

```bash
git push -u origin feat/idea3-windows-standalone-pr8
gh pr create --draft --base main --head feat/idea3-windows-standalone-pr8 --title "feat(idea3): add Windows standalone runtime" --body-file /tmp/aegis-idea3-pr8-pr-body.md
```

Request the IDEA3 functional reviewer (`kraveerachat` temporarily, because Music's GitHub username is not recorded). Do not merge or deploy. If Windows acceptance is blocked, keep the Draft PR explicitly partial.

---

## Self-review checklist

- Every design requirement maps to Tasks 1–12.
- Python/Node/Web/runtime/config/secret/SQLite/evaluator/build/documentation boundaries have explicit files and tests.
- Windows acceptance is isolated from Linux regression evidence.
- No task changes Web-to-MQTT, command authentication, containment semantics, or physical truth.
- No step commits generated binaries or runtime state.
- All referenced interfaces use consistent names across tasks.
- No historical receipt is edited.
