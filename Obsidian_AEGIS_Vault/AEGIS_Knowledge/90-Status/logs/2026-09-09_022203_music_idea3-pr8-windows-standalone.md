---
title: Task Receipt — IDEA3 PR8 Windows standalone runtime
date: 2026-09-09T02:22:03+07:00
owner: music
area: idea3
branch: feat/idea3-windows-standalone-pr8
status: partial
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 PR8 Windows standalone runtime

## What changed

- Implemented the IDEA3 Windows standalone runtime on the source side: an
  external writable data root, cross-platform single-instance locking, honest
  Windows capability projection, a production Web runtime at `/security`, a
  loopback launcher control and lifecycle boundary, secure configuration
  provisioning, evaluator commands, deterministic packaging inputs, restart
  persistence coverage, and operator documentation.
- The installed payload stays immutable. Configuration, SQLite audit databases,
  logs, and runtime status live outside it under `%LOCALAPPDATA%\AEGIS\IDEA3`
  by default, overridable with an absolute `AEGIS_DATA_DIR`.
- No Windows build or clean-machine smoke acceptance was performed. Plan Task 11
  is BLOCKED and PR8 is recorded as PARTIAL.

## Source files changed

- `IDEA3-AEGIS_Lockdown/aegis_soc/paths.py` — external data-root and config-path contract.
- `IDEA3-AEGIS_Lockdown/aegis_soc/platform_lock.py` — cross-platform exclusive locking without `fcntl` on Windows.
- `IDEA3-AEGIS_Lockdown/aegis_soc/supervisor.py` — use the platform lock abstraction.
- `IDEA3-AEGIS_Lockdown/aegis_soc/config.py` — resolve paths through the external contract.
- `IDEA3-AEGIS_Lockdown/aegis_soc/runtime.py` — honest Windows capability/status projection.
- `IDEA3-AEGIS_Lockdown/aegis_soc/windows_launcher.py` — launcher settings, loopback control server, child orchestration, `write_configuration()`, and the `status`/`open`/`logs`/`doctor` evaluator commands.
- `IDEA3-AEGIS_Lockdown/web/server/runtime.js` — production static/SPA runtime and idempotent shutdown.
- `IDEA3-AEGIS_Lockdown/web/server/createApp.js`, `web/server/index.js`, `web/server/config.js` — production base path, health route, and configuration keys.
- `IDEA3-AEGIS_Lockdown/web/server/passwordHash.js` — stdin-only bcrypt cost-12 helper.
- `IDEA3-AEGIS_Lockdown/web/package.json` — `hash-password` script.
- `IDEA3-AEGIS_Lockdown/windows/toolchain-lock.json`, `windows/requirements-build.txt` — pinned Node 24.20.0 x64 with SHA-256 and PyInstaller 6.22.2.
- `IDEA3-AEGIS_Lockdown/windows/aegis-idea3.spec`, `windows/launcher_main.py` — one-folder PyInstaller layer and console entry point.
- `IDEA3-AEGIS_Lockdown/windows/build.ps1`, `windows/smoke.ps1` — fail-fast build and clean-machine smoke acceptance scripts (never executed).
- `IDEA3-AEGIS_Lockdown/windows/README.md`, `IDEA3-AEGIS_Lockdown/README.md`, `IDEA3-AEGIS_Lockdown/web/README.md`, `IDEA3-AEGIS_Lockdown/.env.example` — operator, build, backup, upgrade, and rollback documentation; Web schema statement corrected from v1 to v2.
- `IDEA3-AEGIS_Lockdown/.gitignore` — ignore `windows/{cache,build,dist,out}/`.
- `IDEA3-AEGIS_Lockdown/tests/test_paths.py`, `tests/test_platform_lock.py`, `tests/test_windows_launcher.py`, `tests/test_runtime.py` — Python coverage.
- `IDEA3-AEGIS_Lockdown/web/tests/server/productionRuntime.test.js`, `tests/server/passwordHash.test.js`, `tests/server/sqliteRepository.test.js`, `tests/server/config.test.js` — Web coverage.
- `IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-09-08-idea3-pr8-windows-standalone-design.md`, `docs/superpowers/plans/2026-09-08-idea3-pr8-windows-standalone.md` — approved design and executable plan.
- `IDEA3-AEGIS_Lockdown/doc/Content/04_SESSION_HANDOFF.md` — sections 30-32.

## Verification evidence

- `python -m pytest -p no:cacheprovider tests -q` — pass: 145 passed.
- `ruff check aegis_soc tests windows detector.py sim_auto_detector.py --no-cache` — pass: All checks passed.
- `python -m compileall -q aegis_soc windows detector.py server_admin.py sim_auto_detector.py tests` — pass.
- `npx vitest run` (full Web suite) — pass: 292 passed across 24 files.
- `vite build` — pass.
- `npm audit --omit=dev --offline` — pass: 0 vulnerabilities.
- `node --test --test-concurrency=1 tests/*.test.mjs` — pass: 56 passed, 0 failed.
- `node scripts/validate-vault.mjs --vault Obsidian_AEGIS_Vault/AEGIS_Knowledge` — pass with 2 pre-existing owner-data canvas warnings; neither canvas changed.
- `git diff --check` — pass.
- `windows/build.ps1` — NOT RUN (requires Windows x64).
- `windows/smoke.ps1` — NOT RUN (requires Windows x64).
- PowerShell parser validation — NOT_RUN_ON_LINUX (`pwsh` unavailable).

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — replaced the
  stale `DESIGN_APPROVED_IMPLEMENTATION_NOT_STARTED` PR8 checkpoint with
  `LINUX_IMPLEMENTATION_COMPLETE / WINDOWS_ACCEPTANCE_BLOCKED`, added the PR8
  implementation section with exact verification, recorded
  `WINDOWS_BUILD_VERIFIED = NO` and `WINDOWS_SMOKE_VERIFIED = NO`, and kept
  every upstream/hardware state and `IDEA3_PRODUCTION_COMPLETE = NO` unchanged.

## Shared surfaces touched

- `None` — every changed path is inside `IDEA3-AEGIS_Lockdown/` or
  `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/` plus this receipt.
  `IDEA3-AEGIS_Lockdown/.env.example` is the IDEA3-local template, not the
  repository-root deployment contract, and documents new variable names with
  empty values only.

## Integration requests

- Kla (temporary IDEA3 GitHub reviewer) must decide whether PR8 may merge while
  Windows acceptance is outstanding, or whether the Draft PR stays open until a
  Windows x64 machine is available. Rollback is to drop the PR8 commits
  `eb05c89d..HEAD`; `main` is untouched and no artifact was published.
- IDEA1 owner (Kla) and IDEA2 owner (Pub) — unchanged PR7 request: each must
  still provide a reviewed bounded read-only service event feed and one agreed
  privacy-safe `correlation_key`. PR8 does not alter that boundary.

## Known limitations

- `WINDOWS_BUILD_VERIFIED = NO` and `WINDOWS_SMOKE_VERIFIED = NO`. Plan Task 11
  is BLOCKED: no Windows x64 machine is available, `build.ps1` and `smoke.ps1`
  refuse non-Windows hosts, and `pwsh` is absent, so even parser validation did
  not run. No EXE has been produced, run, or distributed.
- All test evidence above is Arch Linux only and is not Windows acceptance.
- Live IDEA1/IDEA2 integration remains OPEN and cross-IDEA normalization,
  correlation, and containment acceptance remain `IMPLEMENTED_UNEXERCISED`.
- No MQTT connection or publication, ACK, relay CUT/RESTORE, firmware compile or
  flash, network change, production database access, deployment, or physical
  evidence occurred.
- Python verification used a task-local `.venv` created for this workspace
  because the active interpreter was PlatformIO's and had no pytest;
  `ruff 0.16.6` was installed where `requirements-dev.txt` pins `0.16.3`.
- `IDEA3_PRODUCTION_COMPLETE = NO`; PR9-PR12 remain OPEN.
