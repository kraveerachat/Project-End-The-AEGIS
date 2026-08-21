---
title: Task Receipt — Windows edge auto-start
date: 2026-08-21T10:21:24+07:00
owner: pub
area: idea2
branch: feat/idea2-windows-edge-autostart
status: partial
edit_policy: append-by-new-file
---

# Task Receipt — Windows edge auto-start

## What changed

- Added current-user Windows Scheduled Task scripts for the modular Detection Engine and an optional independent IDEA2 reverse SSH tunnel.
- Kept camera capture in the interactive `AtLogOn` session instead of Session 0, used limited current-user principals, and configured bounded restart without granting privileges to another account.
- Made the tunnel reverse-only and parameter-driven, with fail-fast forwarding, SSH keepalives and unattended `BatchMode`; private keys and service secrets remain outside Git.
- Added status and uninstall behavior for both tasks. Rollback removes scheduled tasks only and preserves source, `.env`, identity keys, logs, recordings and snapshots.

## Source files changed

- `IDEA2-AEGIS_CCTV-Operator/detection-engine/windows/install_autostart.ps1` — validates local prerequisites and registers the current-user engine plus optional tunnel tasks.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/windows/run_detection_engine.ps1` — starts the modular engine from its own directory with external lifecycle/stdout/stderr logs.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/windows/run_reverse_tunnel.ps1` — maintains the configured reverse-only SSH forward and exposes failures to Task Scheduler.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/windows/status_autostart.ps1` — reports both task states and recent local engine/tunnel logs.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/windows/uninstall_autostart.ps1` — stops and removes only the two IDEA2 scheduled tasks.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_windows_autostart.py` — enforces current-user, reverse-only, restart, validation and no-hardcoded-secret contracts.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/README.md` — documents install, tunnel security, verification and rollback.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea2/idea2-status.md` — records the durable Windows edge auto-start boundary and its verification gap.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-08-21_102124_pub_windows-edge-autostart.md` — records this task's immutable evidence.

## Verification evidence

- `python -m unittest test_windows_autostart -v` from `detection-engine/tests` — **PASS**, 10/10 Windows edge auto-start contract tests.
- PowerShell AST parsing of `detection-engine/windows/*.ps1` using `System.Management.Automation.Language.Parser::ParseFile` — **PASS**, 5/5 scripts parsed without errors.
- Earlier user-run real Laptop evidence for the engine task — **PASS**: current-user `AtLogOn`, fresh sign-in, real camera reopen, `/health`, local authenticated MJPEG and recording startup were observed.
- Automatic reverse-tunnel task installation, logon trigger and reconnect — **NOT VERIFIED**; this task did not mutate Task Scheduler or connect to Production.
- Docker, Internal and Production execution — **NOT RUN** by this task.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea2/idea2-status.md` — added the optional current-user reverse-tunnel task boundary and retained its unverified automatic reconnect status.

## Shared surfaces touched

- None — all changed paths remain inside IDEA2 code and IDEA2-owned knowledge.

## Integration requests

- Pub must install and verify the tunnel task on each approved camera node with a unique infrastructure-approved listener, then test fresh sign-in, failure restart and reconnect.
- Kla infrastructure review is required before rollout because the server-side `PermitListen` and firewall rules remain the authorization boundary; this task does not modify them.
- The exposed Telegram credential must be rotated before Internal or Production testing, and the replacement must stay only in ignored local/production secret storage.

## Known limitations

- Engine auto-start has real Laptop evidence, but the newly automated tunnel task has only static/test evidence.
- PC/USB-camera installation, multi-node port allocation, SSH-agent availability for protected keys and tunnel reconnect after network loss remain unverified.
- Monitor heartbeat/RBAC live view, Telegram delivery with a rotated token, real NAS transfer, Docker AI build/up and Production deployment remain unverified.
- No Git push, Pull Request, Internal access or Production mutation was performed.
