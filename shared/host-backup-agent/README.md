# AEGIS host backup agent

A dedicated, least-privilege host service that performs **real backups** of
AEGIS Drive (IDEA1) — the Data Lake bytes and the PostgreSQL metadata — with
restic, and publishes sanitized status to Drive over one Unix socket.

**Not deployed.** See [`deploy/README.md`](./deploy/README.md).

## Why a separate agent

The Drive container must never hold backup privileges: reading the Docker
volume from the host side, writing to an external disk, and running `pg_dump`
with a database credential are all host-level powers. Giving them to the web
container would make every Drive vulnerability a backup-destruction
vulnerability. The telemetry agent must not gain them either: an agent that
can read host metrics should not thereby be able to trigger or alter backups.

So this is a third identity with its own user, group, socket, capability and
write set — and Drive is only its client.

```
        host                                                container
 ┌──────────────────────────────┐                      ┌─────────────────────┐
 │ /var/lib/docker/volumes/     │  read-only           │ AEGIS Drive         │
 │   aegis_drive_storage/_data  │─────┐                │                     │
 │ PostgreSQL (docker bridge)   │─pg_dump─┐            │  GET  status ───────┼─▶ /api/storage
 │                              │         ▼            │  POST run/verify ◀──┼── Admin (RBAC)
 │                     ┌────────────────────┐          │  POST policy    ◀───┼── Admin (IDs only)
 │                     │  aegis-backup      │          │  POST quiesced  ────┼─▶ write-freeze ack
 │                     │  uid 29102         │◀── sock ─┤                     │
 │                     │  CAP_DAC_READ_SEARCH          │                     │
 │                     └────────┬───────────┘          └─────────────────────┘
 │                              │ restic (encrypted repo)
 │                              ▼
 │  /mnt/aegis-backup (external disk)  or  sftp:/rest: off-host
 └──────────────────────────────┘
```

## What is backed up

| Content | Source | Why |
|---|---|---|
| Normal Data Lake bytes | `<datalake>/uploads/` | the files themselves |
| File-version bytes | `<datalake>/versions/` | File History restore targets |
| Private Vault ciphertext | `<datalake>/vault/` | zero-knowledge blobs; no key is ever present to back up |
| Profile avatars | `<datalake>/avatars/` | account recovery |
| PostgreSQL `aegis_drive` | `pg_dump --format=custom` | `users`, `files`, `file_versions`, `vault_*`, `shares`, `audit_log` — the rows that say what the bytes are and who owns them |

`.staging/` (in-flight chunked uploads) is deliberately excluded: an
uncommitted upload is not durable data and its session row would not survive
a restore anyway.

## Failure-domain policy

A target only counts as protected when kernel evidence says it is on
**different hardware**:

| Classification | How it is decided | Protected? |
|---|---|---|
| `OFF_HOST` | remote repository (`sftp:`/`rest:`) or a network filesystem mount | yes |
| `DIFFERENT_DEVICE` | mount source resolves (partition → disk, dm → slaves) to a physical disk not shared with the Data Lake's | yes |
| `SAME_FAILURE_DOMAIN` | shares a physical disk with the Data Lake (e.g. another partition of `sda`) | **no** |
| `NOT_MOUNTED` | nothing mounted at the configured mount point | no |
| `UNKNOWN` | mountinfo unreadable or device unresolvable | no |

Backup state is then `NOT_CONFIGURED`, `SAME_FAILURE_DOMAIN`,
`TARGET_UNAVAILABLE`, `READY` or `RUNNING`. `READY` means "could run"; it is
never presented as healthy. See `src/targets.js`.

## Consistency model

A bounded **write-freeze lease with acknowledgement**, documented in full in
`src/job.js`:

1. The agent enters `QUIESCE_REQUESTED` with a lease (`leaseUntil`) and an
   acknowledgement deadline.
2. Drive sees this on its next poll, refuses destructive mutations (delete,
   same-name replace/commit, version restore, vault delete/commit) with
   `503 BACKUP_MAINTENANCE`, waits for in-flight ones to finish, then POSTs
   `/internal/backup/quiesced`.
3. Only then: `pg_dump` (transaction-consistent) → `pg_restore --list`
   (readable) → `restic backup` of the dump directory plus the four Data Lake
   subdirectories.
4. The freeze ends when the snapshot completes; Drive also ends it on its own
   clock at `leaseUntil`. A job whose snapshot finishes after the lease is
   recorded `FAILED / LEASE_EXPIRED`, never `SUCCESS`.
5. `restic check` and retention pruning run after release.

Reads, downloads, shares and un-committed uploads continue throughout.

## Status contract

`GET /internal/backup/status` (`schemaVersion: 1`). IDs, enums, numbers, ISO
timestamps. No credential path, no repository password, no command line, no
tool output. See `src/server.js` and the Drive-side validator
`IDEA1-AEGIS_Drive_LC/server/backup/schema.js`.

Job history records: `jobId`, `kind`, `trigger`, `startedAt`, `finishedAt`,
`status`, `targetId`, `targetType`, `protection`, `bytesScanned`,
`bytesBackedUp`, `snapshotId`, `integrityCheck`, `restoreVerification`,
`errorCode` (from a fixed list). Drive derives `lastSuccessfulBackup`,
`lastFailedBackup`, `backupAge`, `successRate30d` (null when no completed job
in 30 days — not 0 %, not 100 %) and the risk word.

## Restore verification

`POST /internal/backup/verify` runs, without touching production:

1. `restic check --read-data-subset=10%`;
2. `restic ls latest` must contain the dump file and the four subdirectories;
3. `restic restore latest --include <dump>` into a per-job directory under
   the agent's own state dir, then `pg_restore --list` on the restored dump.

Result: `restoreVerification` `PASS` / `FAIL`; `NOT_TESTED` until it has run.

## Configuration

Static, root-owned `/etc/aegis/backup-agent.json` (see
`deploy/backup-agent.example.json`): binaries, source path, PostgreSQL
connection with a **password file**, restic **password file**, and the
allowlist of targets. Admin-editable policy (`policy.json` in the state dir):
`activeTargetId`, `scheduleId`, `retentionId`, `enabled` — all IDs from fixed
sets. Nothing a browser sends is ever a path, host or command.

| Variable | Default |
|---|---|
| `AEGIS_BACKUP_CONFIG` | `/etc/aegis/backup-agent.json` |

## Tests

```bash
npm test
```

Everything runs on any platform with fakes for the clock, the filesystem,
restic, pg_dump and the socket. The socket tests use a Windows named pipe on
Windows and a real `AF_UNIX` socket on Linux.
