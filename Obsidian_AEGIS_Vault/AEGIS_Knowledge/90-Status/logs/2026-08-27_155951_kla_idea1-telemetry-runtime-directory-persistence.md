---
title: Task Receipt — IDEA1 Telemetry Runtime Directory Persistence
date: 2026-08-27T15:59:51+07:00
owner: kla
area: idea1
branch: fix/idea1-telemetry-runtime-directory-persistence
status: partial
integration-review: yes
edit_policy: append-by-new-file
---

# Task Receipt — IDEA1 Telemetry Runtime Directory Persistence

`ROOT_CAUSE = STALE RUNTIME DIRECTORY BIND`

`SELECTED_FIX = RuntimeDirectoryPreserve=yes`

`IMPLEMENTATION = LOCALLY VERIFIED / NOT DEPLOYED`

`PRODUCTION_ACCEPTANCE = PENDING`

## What changed

- Preserves `/run/aegis-telemetry` across automatic restart, manual restart,
  and a separate service stop followed by start so an already-running Drive
  container remains attached to the current directory inode and can see the
  recreated `telemetry.sock`.
- Selects `yes` rather than `restart` because systemd 259 documents that
  `restart` covers automatic restart and `systemctl restart`, while `yes`
  additionally prevents removal on a standalone stop. `/run` remains `tmpfs`
  and is still cleared at host reboot.
- Adds a regression assertion for the exact lifecycle property. No capability,
  identity, GID, socket mode, Docker mount, application code, or production
  runtime was changed.

## Source files changed

- `shared/host-telemetry-agent/deploy/aegis-telemetry.service` — adds
  `RuntimeDirectoryPreserve=yes` and documents the inode-stability boundary.
- `shared/host-telemetry-agent/deploy/README.md` — explains the stale Docker
  bind mechanism, why `restart` is insufficient, and reboot/explicit-clean
  behavior.
- `shared/host-telemetry-agent/tests/deploy.test.js` — pins the directive in
  `[Service]` and explains the production regression it prevents.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-08-27_155951_kla_idea1-telemetry-runtime-directory-persistence.md` — this immutable task receipt.

## Verification evidence

- `node --test --test-concurrency=1 tests/deploy.test.js` before the unit edit — FAIL as expected: `RuntimeDirectoryPreserve` was absent.
- `node --test --test-concurrency=1 tests/deploy.test.js` after the unit edit —
  PASS: 12 discovered, 12 passed, 0 failed, 0 skipped.
- `npm test` in `shared/host-telemetry-agent` — PASS: 57 discovered, 54 passed,
  0 failed, 3 POSIX-only tests honestly skipped on Windows.
- `node scripts/validate-vault.mjs --vault Obsidian_AEGIS_Vault/AEGIS_Knowledge`
  — PASS with two unchanged owner-review Canvas warnings.
- `node --test tests/vaultStructure.test.mjs tests/vaultMultiWriter.test.mjs tests/collaborationPolicy.test.mjs tests/dockerBootstrap.test.mjs tests/endpointOnboarding.test.mjs`
  — PASS: 53 discovered, 53 passed, 0 failed, 0 skipped.
- `git diff --check` — PASS.

## Canonical notes updated

- `None` — production behavior has not been re-accepted after the fix, so the
  canonical IDEA1 production state is intentionally unchanged.

## Shared surfaces touched

- `shared/host-telemetry-agent/deploy/aegis-telemetry.service` — shared host
  service lifecycle contract; integration review must confirm the systemd
  directory-lifetime choice.
- `shared/host-telemetry-agent/deploy/README.md` — shared deployment/runbook
  explanation used by the production operator.
- `shared/host-telemetry-agent/tests/deploy.test.js` — shared deployment-policy
  regression coverage.

## Integration requests

- Kla/integration reviewer: confirm that `RuntimeDirectoryPreserve=yes` is the
  minimum correct systemd 259 setting for the proven stop/start lifecycle and
  that the unchanged `0750` directory, `0660` socket, fixed GID `29100`, empty
  capability sets, and read-only Drive bind retain the approved least-privilege
  boundary.
- After merge, an authorized production operator must run the controlled
  stop/start regression without recreating Drive, compare host and container
  directory inodes, verify the socket and direct Unix-socket client, then check
  `/api/telemetry` and Drive health before closing the defect.

## Known limitations

- No production file, service, container, or runtime setting was changed.
- Windows cannot execute systemd or the three real AF_UNIX filesystem tests;
  those checks remain a Linux/production gate.
- Static and unit tests do not prove the already-running production Drive bind
  observes the socket after service stop/start. Production acceptance remains
  pending and this receipt is therefore `partial`.
- The Formal Report was not changed.
