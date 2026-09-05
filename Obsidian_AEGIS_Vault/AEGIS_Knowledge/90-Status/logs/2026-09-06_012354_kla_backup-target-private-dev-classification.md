---
title: Task Receipt — Backup Target PrivateDevices classification update
date: 2026-09-06T01:23:54+07:00
owner: kla
area: idea1
branch: fix/backup-target-private-dev-classification
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — Backup Target PrivateDevices classification update

## What changed

- Reconciled the IDEA1 canonical status/handoff against the latest Production acceptance evidence instead of leaving superseded 2026-09-05 states as current truth.
- Recorded current Production Drive source `2806373bb300728a0babb953a63f98bcd714ffef` (PR #80) and the accepted Drive-only deployment boundary.
- Closed stale documentation states for SECURITY-2 Vault auto-lock (**PASS / CLOSED**), Twingate local connector runtime telemetry (**PASS / CLOSED**), Administrator Encryption-at-Rest truthfulness (**ADMIN-ENC-1 PASS / CLOSED**) and Administrator Network Zones (**PASS / CLOSED**).
- Preserved Twingate control-plane telemetry as **NOT MEASURED**; local Docker/runtime health is not a control-plane claim.
- Preserved Settings as **PARTIAL** because Backup Targets / Backup Job remain open and profile/avatar has not been re-tested in the latest exhaustive sweep.
- Reconciled RAID from an immediate field-work plan to **DEFERRED / FUTURE HARDWARE**, because the discovered HGST/Lexar devices are existing/shared equipment that must not be erased.
- Preserved the current Backup Target truth: HGST `hgst-usb-1` is safely mounted/registered, Production classification remains `UNKNOWN / physical-device-unresolved`, source commit `a68de6f145d7e0f6935f2a2a0609ca4be432cdff` passes 9/9 focused and 52/52 full tests, and PR/merge/deployment/real `DIFFERENT_DEVICE` acceptance remain.
- Preserved the safe policy: `activeTargetId=null`, schedule disabled, retention `keep-7d-4w`, `enabled=false`.
- This receipt closes the documentation reconciliation only. It does not close Backup Target overall, Backup Job E2E, STORAGE-AUTO-2, or real RAID1.

## Source files changed

- `shared/host-backup-agent/src/targets.js` — existing feature commit preserves
  mountinfo `major:minor`, resolves through `/sys/dev/block`, retains `/dev`
  fallback, and remains fail-closed.
- `shared/host-backup-agent/tests/helpers.js` — existing feature commit models
  major:minor-to-sysfs resolution with hidden `/dev` support.
- `shared/host-backup-agent/tests/targets.test.js` — existing feature commit adds
  `TARGET-9` and updates target-classification regressions.
- `shared/host-backup-agent/README.md` — correct deployed-service versus
  not-yet-deployed classifier status, architecture, and removable-media safety
  boundary.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-status.md` — canonical root
  cause, gate matrix, exact commit/tests, current safe policy, pending
  Production acceptance, Backup Job, RAID, and data-preservation status.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/IDEA1-Progress-Update-6.1.md`
  — replace stale absent-target/current-policy wording with the current
  mounted/registered-but-unaccepted target state and continuation sequence.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-moc.md` — route future work
  to the current Backup Target checkpoint.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-09-06_012354_kla_backup-target-private-dev-classification.md`
  — this immutable task receipt.

## Verification evidence

Repository / PR evidence cross-checked during reconciliation:
- PR #79 is merged and records Drive **992 total / 925 pass / 0 fail / 67 skips** and host telemetry **139 total / 136 pass / 0 fail / 3 platform-gated skips**.
- PR #80 is merged at `2806373bb300728a0babb953a63f98bcd714ffef`; it records Drive **1012 total / 945 pass / 0 fail / 67 skips**, with focused auto-lock suites **9/9 + 9/9 PASS**.
- Current classifier source commit: `a68de6f145d7e0f6935f2a2a0609ca4be432cdff`.
- Backup target focused tests previously recorded on this branch: **9/9 PASS**, including fail-closed TARGET-8 and PrivateDevices TARGET-9.
- Full host-backup-agent suite previously recorded on this branch: **52/52 PASS**, 0 failed, 0 skipped.
- Previous branch documentation validation recorded collaboration/vault structure tests **43/43 PASS**, vault validation PASS with only the two existing canvas owner-review warnings, and `git diff --check` PASS.

Production acceptance facts reconciled from the active 2026-09-05/06 acceptance session:
- Production Drive source = `2806373...`.
- migration 008 applied before the PR #80 Drive image.
- SECURITY-2 measured 1-minute acceptance = PASS / CLOSED.
- local Twingate connector runtime telemetry = PASS / CLOSED.
- Administrator Encryption-at-Rest truthfulness = ADMIN-ENC-1 PASS / CLOSED.
- Administrator Network Zones = PASS / CLOSED.
- Backup Target Production classification remains `UNKNOWN / physical-device-unresolved`; therefore it is not closed.

No new application/runtime test is claimed by this documentation-only reconciliation. Historical receipts remain historical; stale current-state claims were corrected in the owner-maintained canonical notes and this still-unmerged task receipt.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-status.md` — current
  Backup Target root cause, gate states, safety boundary, and continuation state.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/IDEA1-Progress-Update-6.1.md`
  — current Backup Target handoff and next-gate sequence.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-moc.md` — current resume map.

## Shared surfaces touched

- `shared/host-backup-agent/src/targets.js` — shared host-agent physical-device
  classification behavior; requires integration review before deployment.
- `shared/host-backup-agent/tests/helpers.js` — shared classifier test model.
- `shared/host-backup-agent/tests/targets.test.js` — shared regression contract.
- `shared/host-backup-agent/README.md` — shared host-agent engineering and
  deployment-status documentation.

## Integration requests

- Kla/infrastructure review: verify the sysfs-first classifier preserves
  fail-closed behavior and `PrivateDevices=true`, then merge through the Pull
  Request. Rollback is the prior classifier, which returns `UNKNOWN` and leaves
  the target unprotected rather than fabricating safety.
- After merge only, perform a separate controlled Production gate: fast-forward
  Production `main`, preserve configuration and credential files, restart only
  `aegis-backup.service`, and require observed
  `hgst-usb-1 → DIFFERENT_DEVICE` with `PrivateDevices=true` still enabled.
- Keep `activeTargetId=null`, schedule disabled, and `enabled=false` until that
  Production acceptance succeeds.

## Known limitations

- The classifier fix has not yet been reviewed/merged/deployed to Production; Production still reports `UNKNOWN / physical-device-unresolved`.
- No real backup job, repository integrity check, or isolated restore verification has been performed.
- `restic`, `pg_dump`, `pg_restore`, and the dedicated PostgreSQL backup credential path still require safe runtime verification/configuration.
- Real RAID1 remains `DEFERRED / FUTURE HARDWARE`; the UI truthfully remains `NOT CONFIGURED`.
- Twingate **control-plane** telemetry remains `NOT MEASURED`; only local connector runtime health is measured.
- Account profile/avatar has not been re-accepted in the latest exhaustive Settings sweep.
- No Production source/configuration/service was changed by this documentation reconciliation, and no existing HGST or Lexar data was modified.

