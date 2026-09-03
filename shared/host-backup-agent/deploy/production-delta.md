# Proposed production delta — Backup agent

**Status: PROPOSED. Not applied. No production file has been modified by this
task.**

`/opt/aegis/runtime/docker-compose.production.yml` is production runtime state
and is out of scope here. This document states the exact, bounded change a
future deployment task needs, so it can be reviewed before anyone touches a
running system.

## Drive service — the entire delta

```yaml
  drive:
    # unchanged: build, environment, depends_on, expose, healthcheck, restart, networks
    group_add:
      - "29100"                                             # telemetry (already proposed/applied)
      - "29102"                                             # backup agent — added
    volumes:
      - aegis_drive_storage:/datalake                       # unchanged
      - /run/aegis-telemetry:/run/aegis-telemetry:ro        # unchanged
      - /run/aegis-backup:/run/aegis-backup:ro              # added
```

Optionally, only if the socket path ever differs from the default:

```yaml
    environment:
      AEGIS_BACKUP_SOCKET: /run/aegis-backup/backup.sock
```

### Why each line

**`group_add: ["29102"]`** — the socket is `0660 aegis-backup:aegis-backup`.
Drive runs as `uid=1000(node)` and needs the supplementary group to open it.
A separate GID from telemetry (29100) is deliberate: the two grants are
independent and revocable independently.

**`/run/aegis-backup:/run/aegis-backup:ro`** — a read-only bind of one
directory containing exactly one socket.

## PostgreSQL — one of two options (integration review required)

The host-side `pg_dump` must reach the `postgres` container:

- **(a)** pin `ipv4_address` for `postgres` on `aegis_internal` and set
  `postgres.host` in `/etc/aegis/backup-agent.json` to it; or
- **(b)** publish `127.0.0.1:5432:5432` on the `postgres` service and set
  `postgres.host` to `127.0.0.1`.

Neither option exposes PostgreSQL beyond the host. Plus the read-only
`drive_backup` role from `README.md`.

## What this delta explicitly does not include

| | |
|---|---|
| `privileged` / `cap_add` on Drive | unchanged (none) |
| Docker socket in any container | not mounted |
| Host paths mounted into Drive beyond the two sockets | none |
| Any write path from a container to the external disk | none — only the host agent writes there |
| nginx / HUB / gateway routes | no change |
| Firewall / Twingate / MikroTik / VLAN | no change |
| IDEA2 / IDEA3 | untouched |

## Order of operations

1. Install `restic`, `postgresql-client`, the `drive_backup` role, the
   credential files, the external mount, and the agent (deploy/README.md).
   Confirm `/internal/backup/status` answers over the socket.
2. Apply the PostgreSQL reachability option and confirm
   `pg_isready -h <host> -U drive_backup -d aegis_drive` from the host.
3. Apply the Drive delta and recreate **the Drive container only**.
4. As Admin in Drive: Settings → Storage & Data → select target, save, *Back
   up now*; then *Verify restore*. Record the results in the acceptance
   receipt. Until step 4 has been performed, production backup acceptance is
   **NOT TESTED**.

Rollback: step 3 by reverting the three lines; step 1 by
`systemctl disable --now aegis-backup`. No schema or data migration exists to
undo.

## Development and test environments

`docker-compose.yml` in this repository needs **no change**. Without the
socket, Drive reports `backup.available: false, reason: agent-unreachable`,
the Storage screen shows the honest not-connected state, and the write-freeze
gate never engages. Covered by `tests/storageBackupApi.test.js` (STORAGE-2,
BACKUP-API-4).
