---
title: Task Receipt — Windows Detection Laptop portable auto-start bootstrap
date: 2026-08-29T00:05:33+07:00
owner: pub
area: idea2
branch: fix/idea2-windows-autostart-portable
status: partial
edit_policy: append-by-new-file
---

# Task Receipt — Windows Detection Laptop portable auto-start bootstrap

## What changed

- Audited the reboot-tested machine runtime against canonical IDEA2 source without reading or copying `.env` values or private-key contents.
- Migrated the verified Engine HKCU supervisor and SYSTEM SSH reconnect architecture into portable source scripts.
- Added a full Windows bootstrap that installs a runtime copy under configurable Local AppData, creates a runtime-local Python environment, installs requirements, validates Monitor integration settings without printing values, and preserves machine artifacts outside Git.
- Added strict two-way SSH forwarding: local `:18002` to Monitor and reverse server `:18077` to Engine `:8077`, with verified `known_hosts`, per-machine key input, SYSTEM-only ACL on the runtime key copy, and reconnect after clean or failed SSH exit.
- Added operator status, repair, and non-destructive uninstall flows plus a Windows installation/reboot verification guide.
- Did not modify the working production Monitor deployment, Docker Compose, server firewall, live runtime, or any machine credential.

## Source files changed

- `IDEA2-AEGIS_CCTV-Operator/detection-engine/README.md` — route Windows operators to the portable bootstrap and replace the stale claim that OS auto-start source is absent.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/windows/README.md` — document installation, secret boundaries, architecture, repair/uninstall, and reboot/live-camera verification.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/windows/install_autostart.ps1` — copy durable runtime source, create local `.venv`, validate configuration, protect the machine key copy, register HKCU Engine and SYSTEM tunnel startup, and retain non-secret repair settings.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/windows/repair_autostart.ps1` — reapply runtime files, dependency/preflight checks, and startup registrations from saved non-secret settings.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/windows/run_detection_engine.ps1` — launch the runtime child with process-boundary logs under the configurable runtime root.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/windows/run_engine_supervisor.ps1` — keep one user-session supervisor, avoid racing an existing listener, and restart the Engine after exit.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/windows/run_detection_tunnel.ps1` — maintain strict local/reverse forwards as a reconnecting SYSTEM-compatible wrapper.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/windows/status_autostart.ps1` — report runtime/startup/process/port/health/log evidence without printing credential values.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/windows/uninstall_autostart.ps1` — remove startup registrations and supervisors while preserving runtime data and credentials.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_windows_autostart.py` — enforce the final architecture, portable paths, strict SSH behavior, machine-specific configuration, and absence of private-key payloads.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea2/idea2-status.md` — record real-machine proof separately from the still-partial fresh-machine installer proof.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-08-29_000533_pub_windows-detection-autostart-bootstrap.md` — immutable task evidence.

## Verification evidence

- PowerShell parser over `detection-engine/windows/*.ps1` — pass: 7/7 scripts have no parse errors.
- `python -m unittest discover -s tests -v` from the canonical Detection Engine using the bundled workspace Python — pass: 24/24 tests.
- `install_autostart.ps1 -TunnelHost 'test-user@127.0.0.1' -WhatIf` — pass: reported the intended runtime target and applied no change.
- `status_autostart.ps1 -LogTail 5` — pass after fixing empty-process handling: both live ports listened, Engine `/health` and forwarded Monitor `/healthz` were reachable; sandboxed task/registry/process enumeration was not treated as production evidence.
- Forbidden-content scan across `detection-engine/windows/` — pass: no `C:\Users\puppu`, OneDrive checkout dependency, private-key marker, hard-coded secret assignment, or `StrictHostKeyChecking=no`.
- `git check-ignore` for `.env`, `.venv`, `segments`, and `snapshots` — pass: every machine/runtime artifact remains ignored.
- `node --test tests/*.test.mjs` — pass: 45/45 repository governance and Vault tests.
- `node scripts/validate-vault.mjs --vault Obsidian_AEGIS_Vault/AEGIS_Knowledge` — pass with two unchanged owner-review canvas warnings.
- Intentional-file trailing-whitespace/final-newline scan plus `git diff --check` — pass; Git emitted only expected Windows line-ending notices.
- PSScriptAnalyzer — not run: the module is not installed in this environment; parser and focused behavior/source tests passed instead.
- Operator-supplied 2026-08-28 real-machine evidence — pass for Windows reboot recovery, SYSTEM tunnel startup, HKCU Engine startup, ports `8077`/`18002`, Live Canvas real webcam/detection, and viewer-disconnect camera release.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea2/idea2-status.md` — added the verified machine architecture, portable source migration, and fresh-machine verification boundary.

## Shared surfaces touched

- None — task stayed within Pub-owned IDEA2 source, tests, canonical knowledge, and receipt paths.

## Integration requests

- None — no shared or cross-scope path changed. Before a later PR is marked ready, retarget/reconcile this stacked branch after `feat/idea2-canonical-modular-runtime` merges and rerun the same verification.

## Known limitations

- The portable installer was not run elevated against a clean second-machine runtime; real task registration, SYSTEM key ACL, dependency installation, fresh reboot, and webcam proof remain required there.
- No private key, `.env`, API/Telegram credential, `known_hosts`, recording, snapshot, log, model weight, or virtual environment is included; every new laptop requires separate authorized machine provisioning.
- The existing working machine still uses the previously installed runtime until the owner explicitly approves migrating it with the new source installer.
- Credential rotation remains required for any credential previously exposed during debugging; no old value was reproduced.
