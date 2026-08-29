---
title: Task Receipt — IDEA2 Windows auto-start main reconciliation
date: 2026-08-29T20:34:32+07:00
owner: pub
area: idea2
branch: codex/idea2-windows-autostart-v2
status: partial
edit_policy: append-by-new-file
---

# Task Receipt — IDEA2 Windows auto-start main reconciliation

## What changed

- Recreated the useful Windows Detection Laptop auto-start work from the obsolete PR #46 on current `main`, without merging its diverged history or restoring its stale receipt.
- Added a portable installer that deploys durable Engine source and a runtime-local Python environment under Local AppData while keeping `.env`, SSH material, recordings, snapshots, logs, and virtual environments out of Git.
- Replaced the unreliable interactive Scheduled Task design with an HKCU Engine supervisor after login and a SYSTEM tunnel task after boot. Both wrappers reconnect/restart, avoid duplicate Engine supervisors, and preserve strict SSH host-key checking.
- Added status, repair, and non-destructive uninstall commands. Repair can reuse an existing runtime `.env`, key, `known_hosts`, and settings without copying a file onto itself, and it reapplies the required SYSTEM-only ACL to the runtime key.

## Source files changed

- `IDEA2-AEGIS_CCTV-Operator/detection-engine/README.md` — links the portable Windows bootstrap and states its machine-level acceptance boundary.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/windows/README.md` — documents installation, architecture, machine-only secrets, repair, uninstall, and reboot verification.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/windows/install_autostart.ps1` — installs the runtime-local environment and final HKCU/SYSTEM startup architecture.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/windows/repair_autostart.ps1` — refreshes the installed runtime and registrations from saved non-secret settings.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/windows/run_detection_engine.ps1` — starts the Engine with machine-local configuration and redirected logs.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/windows/run_detection_tunnel.ps1` — maintains strict local and reverse SSH forwards with retry behavior.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/windows/run_engine_supervisor.ps1` — supervises the Engine in the logged-in webcam user session and prevents duplicate supervisors.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/windows/status_autostart.ps1` — reports registrations, processes, ports, health endpoints, and recent logs.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/windows/uninstall_autostart.ps1` — removes registrations and running wrappers while preserving machine data for recovery.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_windows_autostart.py` — covers portable paths, startup roles, strict forwarding, secret exclusion, and in-place repair.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea2/idea2-status.md` — records the reconciled source architecture and pending per-laptop acceptance evidence.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-08-29_203414_pub_windows-autostart-main-reconcile.md` — records this task and its honest verification boundary.

## Verification evidence

- `python -m unittest discover -s tests -v` from `IDEA2-AEGIS_CCTV-Operator/detection-engine` — pass: 26 tests.
- PowerShell AST parser over `detection-engine/windows/*.ps1` — pass: all seven scripts parsed without errors.
- `install_autostart.ps1 -TunnelHost 'test-user@127.0.0.1' -WhatIf` — pass: validated parameters and reached the mutation boundary without changing the machine.
- `node --test --test-concurrency=1 tests/*.test.mjs` — pass: 56 repository governance and integration tests.
- `python -m compileall -q IDEA2-AEGIS_CCTV-Operator/detection-engine` — pass: canonical Python sources compile.
- `node scripts/validate-vault.mjs --vault Obsidian_AEGIS_Vault/AEGIS_Knowledge` — pass with only the repository's pre-existing owner-review canvas warnings.
- `node scripts/validate-collaboration-policy.mjs --event <event> --changed-files <changed-files>` — pass: simulated IDEA2 PR has exactly one new Pub receipt and no undeclared cross-scope path.
- Changed-path secret/artifact scan — pass: no `.env`, private key, token, model binary, recording, snapshot, log, dependency directory, or build output is included.
- `git diff --check` — pass: no whitespace errors; Windows emitted only expected LF-to-CRLF checkout notices.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea2/idea2-status.md` — records the portable Windows startup architecture as implemented in source while keeping elevated installation, reboot, and webcam proof pending per laptop.

## Shared surfaces touched

- None — task stayed inside the IDEA2 source and owner-maintained knowledge boundary.

## Integration requests

- None — no cross-scope or shared path changed. IDEA2 functional review should confirm the operator workflow and evidence wording before merge.

## Known limitations

- The reconciled installer has not yet been executed from an elevated fresh clone on the operator laptop; no machine registration was changed by this source task.
- A post-install Windows reboot and real authorized Live Canvas session remain required to prove automatic Engine/tunnel recovery and webcam capture on each laptop.
- Current machine read-only inspection found healthy local Engine and Monitor endpoints from older runtime processes, but the final runtime-local Python, HKCU registration, and install receipt were not all present; that existing state is not proof of this installer.
- Scheduled Task and process enumeration from the non-elevated Codex process returned access restrictions, so task ownership/state must be confirmed from elevated PowerShell during acceptance.
- Telegram credential rotation and real delivery remain required independently of this auto-start task.
