# Proposed production delta — Server Telemetry V1

**Status: PROPOSED. Not applied. No production file has been modified by this
task.**

`/opt/aegis/runtime/docker-compose.production.yml` is production runtime state
and is explicitly out of scope here. This document states the exact, bounded
change a future deployment task would need, so that change can be reviewed
before anyone touches a running system.

## Drive service — the entire delta

```yaml
  drive:
    # unchanged: build, environment, depends_on, expose, healthcheck,
    #            restart, networks
    group_add:
      - "29100"
    volumes:
      - aegis_drive_storage:/datalake                       # unchanged
      - /run/aegis-telemetry:/run/aegis-telemetry:ro        # added
```

Optionally, only if the socket path ever differs from the default:

```yaml
    environment:
      AEGIS_TELEMETRY_SOCKET: /run/aegis-telemetry/telemetry.sock
```

That is the whole change. Nothing else in the Drive service is touched.

### Why each line

**`group_add: ["29100"]`** — the socket is `0660 aegis-telemetry:aegis-telemetry`.
Drive runs as `uid=1000(node) gid=1000(node)` and needs the supplementary group
to open it. A numeric GID is used because the group does not exist inside the
container image; the number is what the kernel checks. Preflight confirmed GID
29100 free both on the host and in the image.

**`/run/aegis-telemetry:/run/aegis-telemetry:ro`** — a read-only bind of one
directory containing exactly one socket. Drive gains no view of the host
filesystem, no `/proc`, no `/sys`, and no device.

## What this delta explicitly does not include

Confirmed against the running configuration during preflight, and unchanged by
this proposal:

| | |
|---|---|
| `privileged` | stays `false` |
| `cap_add` | stays empty |
| `cap_drop` | stays empty |
| `pid: host` | not used |
| Docker socket | not mounted |
| Host `/proc` or `/sys` mount | not mounted |
| `/` or `/var/lib/docker` mount | not mounted |
| `read_only` rootfs | unchanged (`false`) |
| `user` | unchanged (`node`) |
| Networks | unchanged — `aegis_internal`, `aegis_vlan10` (192.168.10.11), `aegis_drive_proxy` (172.19.255.3, alias `drive-proxy`) |
| Ports | none added; no new listener of any kind |
| nginx | no route added or changed |
| Firewall / Twingate / MikroTik | no change |
| PostgreSQL | no migration, no schema change |
| Monitor service | not touched |
| HUB service | not touched |

## Order of operations for the future deployment task

1. Install and start the host agent (see `README.md`), and run the host
   verification block there. The agent is harmless on its own: it publishes a
   socket nothing yet reads.
2. Confirm `/run/aegis-telemetry/telemetry.sock` exists with mode `0660` and
   answers over `curl --unix-socket`.
3. Only then apply the Drive delta and recreate **the Drive container only**.
4. Confirm `GET /api/telemetry` reports host metrics as available and not stale.

Step 1 can be rolled back with `systemctl disable --now aegis-telemetry`; step 3
by reverting the two lines. Neither step changes data, schema, or routing, so
neither has a migration to undo.

## Development and test environments

`docker-compose.yml` in this repository needs **no change** and has not been
modified. Without the socket, Drive's telemetry client returns `unreachable`,
the host metrics report `available: false`, and the dashboard shows the truthful
unavailable tiles — while Data Lake disk and Drive service uptime keep working,
because Drive measures those itself. That is the correct development behaviour
and it is covered by tests (`TELEM-API-4`, `TELEM-API-7`).
