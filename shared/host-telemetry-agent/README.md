# AEGIS host telemetry agent

A minimal, dedicated agent that publishes host metrics to AEGIS Drive over a
Unix socket. It exists so the Drive container can show real CPU, memory,
network and uptime numbers **without** being granted host access.

**Not deployed.** See [`deploy/README.md`](./deploy/README.md).

## Design in one page

```
        host                                     container
  ┌───────────────────────┐              ┌──────────────────────┐
  │ /proc/stat            │              │ AEGIS Drive          │
  │ /proc/meminfo         │──┐           │  (uid 1000, node)    │
  │ /proc/uptime          │  │           │                      │
  │ /sys/.../rx_bytes     │  │           │  statfs /datalake ───┼─→ disk
  │ /sys/.../tx_bytes     │  │           │  process.uptime() ───┼─→ service
  └───────────────────────┘  │           │                      │
                             ▼           │                      │
                    ┌─────────────────┐  │                      │
                    │ telemetry agent │  │                      │
                    │ uid aegis-      │  │                      │
                    │  telemetry      │  │                      │
                    │ samples ~5s     │  │                      │
                    └────────┬────────┘  │                      │
                             │           │                      │
              /run/aegis-telemetry/telemetry.sock (0660)        │
                             └──────────►│ GET /internal/       │
                                    ro   │     telemetry        │
                                         └──────────────────────┘
```

Why an agent rather than giving Drive host access: the alternative designs all
require something this system should not have — a privileged container, the
Docker socket, the host PID namespace, or a host `/proc` mount. Each of those
grants far more than "read five numbers". A separate unprivileged process that
can only ever read those five files, exposed through one group-restricted
socket, is the smallest thing that works.

## Contract

`GET /internal/telemetry` over the Unix socket. No TCP listener exists — the
systemd unit sets `RestrictAddressFamilies=AF_UNIX`, so one cannot be opened
even by a compromised process.

```json
{
  "schemaVersion": 1,
  "measuredAt": "2026-08-27T09:59:58.000Z",
  "metrics": {
    "cpu":     { "available": true, "percent": 12.3, "windowSeconds": 5 },
    "memory":  { "available": true, "usedBytes": 0, "totalBytes": 0, "percent": 0 },
    "network": { "available": true, "interface": "enp1s0",
                 "rxBytesPerSec": 0, "txBytesPerSec": 0, "windowSeconds": 5 },
    "uptime":  { "available": true, "hostSeconds": 86400.55 }
  }
}
```

Response keys are strictly allowlisted. The agent publishes no hostname, no
usernames, no process list, no container or Docker data, no MAC or IP address,
no filesystem paths, and no raw `/proc` or `/sys` content.

**`available: false` is always alone.** An unmeasurable metric is exactly
`{ "available": false }` with no numbers beside it. A zero would be
indistinguishable from a genuinely idle host, which would make the whole
dashboard untrustworthy.

## Why background sampling

CPU and network throughput are rates, and a rate needs two reads separated by a
real window. Sampling at request time would make every Drive telemetry call
block for that window. Instead the agent samples on its own ~5 s timer and keeps
one snapshot in memory; the socket handler answers from it synchronously.

Drive caps its client at 1500 ms and marks any measurement older than 15 s as
stale — enough for two missed agent cycles before the dashboard says so.

## Disk is not here

Deliberately. Drive already has the Data Lake mounted, so it measures capacity
itself with `statfs`, reusing the same `filesystemCapacity()` that `/api/storage`
and `/api/dashboard` have always used. Collecting it here would need a host
mount and would risk two implementations disagreeing.

Physical drive health (SMART, RAID) is reported as `available: false` with
reason `smart-not-observable`: it needs raw device access that nothing in this
design has, and a green "Healthy" nothing measured is worse than an honest
"unknown".

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `AEGIS_TELEMETRY_INTERFACE` | `enp1s0` | Explicit. Never auto-selected. |
| `AEGIS_TELEMETRY_SOCKET` | `/run/aegis-telemetry/telemetry.sock` | |
| `AEGIS_TELEMETRY_INTERVAL_MS` | `5000` | Must be 1000–15000. |

Anything unusable makes the agent refuse to start. A telemetry agent running
with a wrong interface is worse than one that is down, because its output still
looks authoritative.

## Tests

```bash
npm test
```

Three tests need a real `AF_UNIX` socket file and are reported as **skipped** on
Windows, never as passed: stale-socket reclamation, socket removal on stop, and
the `0660` mode assertion. Run the suite on the Linux host before deployment.
