---
title: Task Receipt — IDEA1 Storage & Backup functional data phase
date: 2026-09-03T23:05:00+07:00
owner: kla
area: idea1
branch: feat/idea1-storage-backup-data-phase
status: complete
integration-review: yes
edit_policy: append-by-new-file
---

# Task Receipt — IDEA1 Storage & Backup functional data phase

`FUNCTION_DATA_PHASE = COMPLETE` (source). `PRODUCTION_CHANGED = NO`.
`PRODUCTION_ACCEPTANCE = NOT TESTED`. The Capacity visualization is
deliberately unchanged; the Storage redesign is the next, separate phase.

## What changed

- **Physical disk health is now measurable without giving Drive any device
  access.** A new bounded oneshot (`aegis-disk-health.service` + `.timer`;
  dedicated user 29101; `CAP_SYS_RAWIO` only; `DevicePolicy=closed`,
  `DeviceAllow=/dev/sda r`; no network) runs
  `smartctl --json --info --health --attributes /dev/sda` every 10 minutes and
  writes an allowlisted evidence file. The unprivileged telemetry agent reads
  that one file (still file-reads-only, empty capability set) and publishes it
  on a new, separately versioned route `GET /internal/disk-health`
  (`schemaVersion: 1`). `/internal/telemetry` V1 is byte-for-byte unchanged.
- **Drive derives disk status deterministically** after fail-closed
  validation: SMART failure or a critical warning code → `CRITICAL`; SMART
  passed with a measured warning → `WARNING`; SMART passed, no warning →
  `HEALTHY`; missing / stale (>30 min) / unreported evidence → `UNKNOWN`.
  UNKNOWN is never promoted; `null` means not reported, never 0; no serial,
  attribute table, path or command output crosses either boundary.
- **A real backup foundation replaces the "Set up now" dead end.** New
  `shared/host-backup-agent/` (user `aegis-backup` 29102, own socket
  `/run/aegis-backup/backup.sock`, `CAP_DAC_READ_SEARCH` only,
  `ProtectSystem=strict`, `ReadWritePaths` = the external mount) runs
  **restic** (encrypted, deduplicated, `check`, verified restore,
  `forget --prune`) plus `pg_dump --format=custom` proven readable by
  `pg_restore --list`. Backup set: `uploads/`, `versions/`, `vault/`
  (ciphertext only), `avatars/`, DB dump; `.staging/` excluded. Drive never
  executes a backup.
- **Target failure-domain policy:** `/proc/self/mountinfo` +
  `/sys/class/block` (partition → disk, device-mapper → slaves) classify a
  target as `OFF_HOST` / `DIFFERENT_DEVICE` (protected) or
  `SAME_FAILURE_DOMAIN` / `NOT_MOUNTED` / `UNKNOWN` (not). A target on the
  same SSD as the Data Lake renders *Unprotected — same failure domain*.
- **Consistency model:** bounded write-freeze lease with acknowledgement.
  Drive refuses destructive mutations (delete, same-name replace/commit,
  version restore, vault delete/commit) with `503 BACKUP_MAINTENANCE`, drains
  in-flight ones, acknowledges; only then `pg_dump` → `restic backup`. Lease
  enforced on Drive's own clock; late snapshot = `FAILED/LEASE_EXPIRED`; no
  ack = `FAILED/QUIESCE_TIMEOUT`. Reads, downloads, shares and uncommitted
  uploads continue.
- **Restore verification:** `restic check --read-data-subset=10%`, expected
  content present in the latest snapshot, isolated restore of the dump into
  the agent's own state dir, `pg_restore --list` → `PASS/FAIL`; `NOT_TESTED`
  until run. Never touches production.
- **Facts and risk derived from recorded job history only:**
  `lastSuccessfulBackup`, `lastFailedBackup`, `backupAgeSeconds`,
  `bytesCovered`, `integrity`, `restoreVerification`, `successRate30d` (null
  with no completed jobs — not 0 %, not 100 %); risk `UNKNOWN` /
  `NOT_CONFIGURED` / `CRITICAL` / `WARNING` / `HEALTHY` per the rules in
  `server/backup/derive.js`. Configuration alone never yields HEALTHY. RAID
  stays `NOT_CONFIGURED`, declared.
- **API:** `GET /api/storage` (all authenticated users) adds `diskHealth`,
  `raid`, `backup`, `maintenance`; capacity/usage unchanged. Admin-only
  `GET /api/backup`, `PATCH /api/backup/policy` (four allowlisted
  IDs/booleans only), `POST /api/backup/run`, `POST /api/backup/verify`.
  Audit: `BACKUP_CONFIG_UPDATE`, `BACKUP_RUN_REQUEST`, `BACKUP_VERIFY_REQUEST`
  (Admin actor) and `BACKUP_RUN_SUCCESS/FAILED`, `BACKUP_VERIFY_PASS/FAIL`
  (actor `SYSTEM:backup-agent`, `target_hash = sha256(jobId)`).
- **UI (data-driven, not redesigned):** Storage shows the disk evidence and
  the backup facts/risk/history with honest unavailable states in EN/TH/ZH;
  Settings → Storage & Data gives Admin a form of allowlisted IDs plus *Back
  up now* / *Verify restore*; DataLake-User sees a read-only note; no free-text
  path/host/command field exists.

## Source files changed

- `shared/host-telemetry-agent/collectors/smart.js` — pure smartctl JSON → evidence reducer (allowlisted warning codes, `null` for unreported metrics).
- `shared/host-telemetry-agent/collectors/disk-health.js`, `collectors/run-disk-health.js` — oneshot runner: device-name allowlist, fixed binary/args, atomic evidence write.
- `shared/host-telemetry-agent/src/diskHealth.js` — agent-side evidence validation and allowlisted projection.
- `shared/host-telemetry-agent/src/config.js`, `src/sampler.js`, `src/server.js` — sixth file read (`AEGIS_TELEMETRY_DISK_HEALTH_FILE`), `/internal/disk-health` route; V1 route untouched.
- `shared/host-telemetry-agent/deploy/aegis-disk-health.service`, `aegis-disk-health.timer`, `aegis-disk-health.sysusers.conf` — new units; `deploy/aegis-telemetry.service` — one `Environment=` line; `deploy/README.md`, `README.md` — docs.
- `shared/host-telemetry-agent/tests/smartParser.test.js`, `diskHealthCollector.test.js`, `diskHealthAgent.test.js`, `diskHealthDeploy.test.js`, `tests/fixtures/smartctl-*.json` — new; `tests/agent.test.js`, `tests/config.test.js` — updated for the sixth source.
- `shared/host-backup-agent/package.json`, `README.md`, `src/{config,policy,schedule,targets,exec,restic,pgdump,history,job,server,agent,index}.js`, `deploy/{aegis-backup.service,aegis-backup.sysusers.conf,backup-agent.example.json,README.md,production-delta.md}`, `tests/{helpers,config,targets,tools,history,job,server,deploy}.test.js` — new package.
- `IDEA1-AEGIS_Drive_LC/server/telemetry/client.js` — generalized `fetchAgentJson` (HTTP status as `httpStatus`), `fetchHostDiskHealth`; `fetchHostTelemetry` behaviour unchanged.
- `IDEA1-AEGIS_Drive_LC/server/telemetry/diskHealthSchema.js`, `server/telemetry/diskHealth.js` — contract validation, status rules, projection.
- `IDEA1-AEGIS_Drive_LC/server/backup/client.js`, `schema.js`, `derive.js`, `maintenance.js`, `index.js` — backup agent client, contract, facts/risk, write-freeze gate + coordinator, singleton.
- `IDEA1-AEGIS_Drive_LC/server/storage/storageReport.js` — composes `/api/storage`.
- `IDEA1-AEGIS_Drive_LC/server/routes/api.js` — `/storage` uses the report; maintenance gate on destructive routes (session-holders only); Admin `/backup*` routes with audit.
- `IDEA1-AEGIS_Drive_LC/server/index.js` — starts the backup coordinator.
- `IDEA1-AEGIS_Drive_LC/.env.example` — `AEGIS_TELEMETRY_SOCKET`, `AEGIS_BACKUP_SOCKET` documented.
- `IDEA1-AEGIS_Drive_LC/src/screens/Storage.jsx`, `src/screens/Settings.jsx`, `src/components/BackupConfiguration.jsx`, `src/lib/strings.js` — data-driven cards, Admin form, EN/TH/ZH copy.
- `IDEA1-AEGIS_Drive_LC/tests/diskHealthSchema.test.js`, `backupSchema.test.js`, `backupDerive.test.js`, `backupMaintenance.test.js`, `storageBackupApi.test.js`, `storageBackupUi.test.js`, `tests/fixtures/backupAgentStatus.js` — new; `tests/fileVersions.test.js` — `unavailable` reasons updated (`needs-host-access` → `agent-unreachable`).
- `.github/workflows/idea1-server-telemetry-linux.yml` — adds `host-backup-agent-linux` job + path trigger (shared surface, see below).

## Verification evidence

- `cd shared/host-telemetry-agent && npm test` — pass: 99 tests / 96 pass / 0 fail / 3 POSIX-only skips (Windows; stale-socket reclaim, socket removal, 0660 mode).
- `cd shared/host-backup-agent && npm test` — pass: 51 / 51.
- `cd IDEA1-AEGIS_Drive_LC && npm test` — pass: 833 tests / 766 pass / 0 fail / 67 PostgreSQL-gated skips (no `TEST_DATABASE_URL`).
- `cd IDEA1-AEGIS_Drive_LC && npm run build` — pass (built in 9.5 s; `dist/` restored afterwards and not included).
- `node --test tests/collaborationPolicy.test.mjs tests/vaultStructure.test.mjs` — pass: 42 / 42.
- `node scripts/validate-vault.mjs --vault Obsidian_AEGIS_Vault/AEGIS_Knowledge` — pass with 2 pre-existing canvas warnings.
- `git diff --check` — pass.
- `node scripts/validate-collaboration-policy.mjs --event <pr-event.json> --changed-files <origin/main...HEAD name-status>` — pass: "Collaboration policy passed" (run locally after listing every cross-scope path; the first CI run failed on directory globs, the `edited` run on the corrected body passed).
- Not run: Linux socket-file tests (covered by the CI job), any real `smartctl`, `restic`, `pg_dump`, any host unit, any browser session. `PRODUCTION_ACCEPTANCE = NOT TESTED`.

Tests added: telemetry agent 40 new tests in 4 new files (+2 updated); backup agent 51 new tests in 7 files; IDEA1 48 new tests in 6 new files (+1 updated).

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-status.md` — new section "Storage & Backup data phase (2026-09-03)" (architecture, contracts, consistency model, risk rules, verification, limitations); "What is real" rows for Disk health / RAID / Off-site backup replaced with *source-complete, not deployed*; `updated: 2026-09-03`.

## Shared surfaces touched

- `.github/workflows/idea1-server-telemetry-linux.yml` — CI (shared): adds the host-backup-agent-linux job and path trigger; existing job unchanged; no secrets
- `shared/host-backup-agent/README.md` — infrastructure (shared): new least-privilege host backup runner (restic + pg_dump)
- `shared/host-backup-agent/deploy/README.md` — infrastructure (shared): new backup agent unit/identity/example config/deployment docs — not installed
- `shared/host-backup-agent/deploy/aegis-backup.service` — infrastructure (shared): new backup agent unit/identity/example config/deployment docs — not installed
- `shared/host-backup-agent/deploy/aegis-backup.sysusers.conf` — infrastructure (shared): new backup agent unit/identity/example config/deployment docs — not installed
- `shared/host-backup-agent/deploy/backup-agent.example.json` — infrastructure (shared): new backup agent unit/identity/example config/deployment docs — not installed
- `shared/host-backup-agent/deploy/production-delta.md` — infrastructure (shared): new backup agent unit/identity/example config/deployment docs — not installed
- `shared/host-backup-agent/package.json` — infrastructure (shared): new least-privilege host backup runner (restic + pg_dump)
- `shared/host-backup-agent/src/agent.js` — infrastructure (shared): new least-privilege host backup runner (restic + pg_dump)
- `shared/host-backup-agent/src/config.js` — infrastructure (shared): new least-privilege host backup runner (restic + pg_dump)
- `shared/host-backup-agent/src/exec.js` — infrastructure (shared): new least-privilege host backup runner (restic + pg_dump)
- `shared/host-backup-agent/src/history.js` — infrastructure (shared): new least-privilege host backup runner (restic + pg_dump)
- `shared/host-backup-agent/src/index.js` — infrastructure (shared): new least-privilege host backup runner (restic + pg_dump)
- `shared/host-backup-agent/src/job.js` — infrastructure (shared): new least-privilege host backup runner (restic + pg_dump)
- `shared/host-backup-agent/src/pgdump.js` — infrastructure (shared): new least-privilege host backup runner (restic + pg_dump)
- `shared/host-backup-agent/src/policy.js` — infrastructure (shared): new least-privilege host backup runner (restic + pg_dump)
- `shared/host-backup-agent/src/restic.js` — infrastructure (shared): new least-privilege host backup runner (restic + pg_dump)
- `shared/host-backup-agent/src/schedule.js` — infrastructure (shared): new least-privilege host backup runner (restic + pg_dump)
- `shared/host-backup-agent/src/server.js` — infrastructure (shared): new least-privilege host backup runner (restic + pg_dump)
- `shared/host-backup-agent/src/targets.js` — infrastructure (shared): new least-privilege host backup runner (restic + pg_dump)
- `shared/host-backup-agent/tests/config.test.js` — infrastructure (shared): backup agent test coverage
- `shared/host-backup-agent/tests/deploy.test.js` — infrastructure (shared): backup agent test coverage
- `shared/host-backup-agent/tests/helpers.js` — infrastructure (shared): backup agent test coverage
- `shared/host-backup-agent/tests/history.test.js` — infrastructure (shared): backup agent test coverage
- `shared/host-backup-agent/tests/job.test.js` — infrastructure (shared): backup agent test coverage
- `shared/host-backup-agent/tests/server.test.js` — infrastructure (shared): backup agent test coverage
- `shared/host-backup-agent/tests/targets.test.js` — infrastructure (shared): backup agent test coverage
- `shared/host-backup-agent/tests/tools.test.js` — infrastructure (shared): backup agent test coverage
- `shared/host-telemetry-agent/README.md` — infrastructure (shared): sixth file read + /internal/disk-health route; /internal/telemetry V1 contract unchanged
- `shared/host-telemetry-agent/collectors/disk-health.js` — infrastructure (shared): the only host module that executes smartctl; fixed binary, fixed args, one allowlisted device
- `shared/host-telemetry-agent/collectors/run-disk-health.js` — infrastructure (shared): the only host module that executes smartctl; fixed binary, fixed args, one allowlisted device
- `shared/host-telemetry-agent/collectors/smart.js` — infrastructure (shared): the only host module that executes smartctl; fixed binary, fixed args, one allowlisted device
- `shared/host-telemetry-agent/deploy/README.md` — infrastructure (shared): sixth file read + /internal/disk-health route; /internal/telemetry V1 contract unchanged
- `shared/host-telemetry-agent/deploy/aegis-disk-health.service` — infrastructure (shared): new bounded disk-health collector unit/timer/identity — not installed
- `shared/host-telemetry-agent/deploy/aegis-disk-health.sysusers.conf` — infrastructure (shared): new bounded disk-health collector unit/timer/identity — not installed
- `shared/host-telemetry-agent/deploy/aegis-disk-health.timer` — infrastructure (shared): new bounded disk-health collector unit/timer/identity — not installed
- `shared/host-telemetry-agent/deploy/aegis-telemetry.service` — infrastructure (shared): one Environment= line naming the evidence file; capability set and device policy unchanged
- `shared/host-telemetry-agent/src/config.js` — infrastructure (shared): sixth file read + /internal/disk-health route; /internal/telemetry V1 contract unchanged
- `shared/host-telemetry-agent/src/diskHealth.js` — infrastructure (shared): sixth file read + /internal/disk-health route; /internal/telemetry V1 contract unchanged
- `shared/host-telemetry-agent/src/sampler.js` — infrastructure (shared): sixth file read + /internal/disk-health route; /internal/telemetry V1 contract unchanged
- `shared/host-telemetry-agent/src/server.js` — infrastructure (shared): sixth file read + /internal/disk-health route; /internal/telemetry V1 contract unchanged
- `shared/host-telemetry-agent/tests/agent.test.js` — infrastructure (shared): agent test coverage for the disk-health contract
- `shared/host-telemetry-agent/tests/config.test.js` — infrastructure (shared): agent test coverage for the disk-health contract
- `shared/host-telemetry-agent/tests/diskHealthAgent.test.js` — infrastructure (shared): agent test coverage for the disk-health contract
- `shared/host-telemetry-agent/tests/diskHealthCollector.test.js` — infrastructure (shared): agent test coverage for the disk-health contract
- `shared/host-telemetry-agent/tests/diskHealthDeploy.test.js` — infrastructure (shared): agent test coverage for the disk-health contract
- `shared/host-telemetry-agent/tests/fixtures/smartctl-nvme-no-temperature.json` — infrastructure (shared): agent test coverage for the disk-health contract
- `shared/host-telemetry-agent/tests/fixtures/smartctl-sata-failing.json` — infrastructure (shared): agent test coverage for the disk-health contract
- `shared/host-telemetry-agent/tests/fixtures/smartctl-sata-healthy.json` — infrastructure (shared): agent test coverage for the disk-health contract
- `shared/host-telemetry-agent/tests/smartParser.test.js` — infrastructure (shared): agent test coverage for the disk-health contract

## Integration requests

- **Kla (infrastructure):** review the two new host units and the one-line telemetry unit change. A future *deployment* task must: install `smartmontools`, `restic`, `postgresql-client`; install the units and identities; create the read-only `drive_backup` PostgreSQL role (SQL in `shared/host-backup-agent/deploy/README.md`); choose one PostgreSQL reachability option; mount an external disk; apply the Drive Compose delta in `shared/host-backup-agent/deploy/production-delta.md` (`group_add: ["29102"]` + read-only bind of `/run/aegis-backup`); then run the on-host verification blocks and a real Backup / Verify from Drive. Rollback is disabling the units and reverting the three Compose lines; no schema or data migration exists.
- **Kla (shared knowledge):** after merge, update `summaries/08_Outstanding_Items_Consolidated.md` rows "No off-site backup" and "SMART/RAID telemetry … unavailable" to *source-complete, deployment pending* (Core/summary note; not edited here).
- **CI reviewer:** confirm the added workflow job.

## Known limitations

- Nothing is deployed and nothing on the production host was touched. Whether `smartctl` can open `/dev/sda` with `CAP_SYS_RAWIO` alone on this SATA controller is unverified; if it cannot, the evidence file states `device-open-failed` and Drive shows *Unknown* with that reason. Widening the grant is a reviewed change, not a fix.
- Backup agent tests use fakes for restic, pg_dump and the clock; no real repository or dump was produced.
- The Dashboard Server-Telemetry disk tile still reports `health: smart-not-observable` (unchanged); Storage is the surface that shows disk health.
- Storage UI is data-driven but not redesigned; browser QA (light/dark, breakpoints, keyboard) belongs to the redesign phase.
- Process note: another session switched the main working tree's branch and stashed this task's tracked edits mid-implementation; the work was recovered from `stash@{0}` into a dedicated worktree (`C:\Users\User\AEGIS_System_worktrees\feat-idea1-storage-backup-data-phase`). That stash entry was left in place and not dropped.
