# AEGIS host telemetry agent — deployment

**Status: prepared, not installed.** Nothing in this directory has been run on
any host. Installation is a separate, reviewed step.

## What the agent is

A single Node process that reads five files and publishes one normalized
snapshot on a Unix socket:

| Metric | Source |
|---|---|
| CPU | `/proc/stat` (aggregate row, two samples ~5 s apart) |
| Memory | `/proc/meminfo` (`MemTotal`, `MemAvailable`) |
| Network | `/sys/class/net/enp1s0/statistics/{rx_bytes,tx_bytes}` |
| Host uptime | `/proc/uptime` |

It does **not** collect disk. Drive measures the Data Lake itself with `statfs`
on the mount it already has, which needs no host access at all.

There is no TCP listener, no shell execution, no Docker socket, no host PID
namespace, and no capability of any kind. The agent's entire write surface is
one socket file inside its own `RuntimeDirectory`.

## Identity and the socket boundary

```
User / Group   aegis-telemetry
Numeric UID/GID 29100          (fixed — see below)
Directory      /run/aegis-telemetry        0750  aegis-telemetry:aegis-telemetry
Socket         /run/aegis-telemetry/telemetry.sock  0660
```

The GID is **pinned, not allocated**. Drive joins it with `group_add: ["29100"]`,
and a container supplementary group is a bare number — if the host allocated a
different GID, Drive would lose access to the socket while every other part of
the system still looked healthy. Preflight confirmed 29100 free on the host and
free inside the Drive image.

`0750` on the directory plus `0660` on the socket means: the agent owns it, the
group (which Drive joins) can read it, and no other account on the host can
reach host metrics.

### Runtime-directory lifetime and the Drive bind mount

The service sets `RuntimeDirectoryPreserve=yes`. This is required because Drive
bind-mounts `/run/aegis-telemetry` read-only. A bind mount follows the directory
inode that existed when the container was created; if systemd removes that
directory during `systemctl stop` and creates a new one during a later
`systemctl start`, the running Drive container remains attached to the removed
inode and cannot see the new `telemetry.sock`.

`RuntimeDirectoryPreserve=restart` is intentionally not used. In systemd 259 it
preserves the directory for automatic restart and `systemctl restart`, but not
for a separate stop followed by start—the lifecycle that exposed this defect.
The `yes` value keeps the same directory inode across both forms. This does not
make runtime state persistent across a host reboot: `/run` is `tmpfs` and is
cleared at reboot. Operators can explicitly remove the managed directory with
`systemctl clean aegis-telemetry.service` when the service is stopped and no
running Drive container depends on that bind.

## Hardening: why each directive is there

Every directive in the unit leaves the five required reads working. The ones
worth explaining:

| Directive | Why it is safe here |
|---|---|
| `ProtectSystem=strict` | Makes `/usr`, `/boot`, `/etc` read-only. `/proc` and `/sys` are not affected. |
| `PrivateDevices=true` | Provides a private `/dev`. Does not touch `/proc` or `/sys`. |
| `ProtectKernelTunables=true` | Makes `/proc/sys` read-only. `/proc/stat` is not under `/proc/sys`. |
| `ProtectControlGroups=true` | Makes `/sys/fs/cgroup` read-only. Cgroups are not read. |
| `ProtectProc=invisible` | Hides other processes' `/proc/<pid>`. The files read here are aggregates, not per-PID. |
| `RestrictAddressFamilies=AF_UNIX` | Makes "no TCP listener" a property of the deployment, not just of the code. |
| `CapabilityBoundingSet=` (empty) | The agent reads only world-readable files; it needs nothing. |

### Deliberately NOT used

These are on most hardening checklists and each would break this agent. They
are named here and in the unit file so nobody adds one and then debugs an agent
that reports everything as unavailable.

| Directive | What it would break |
|---|---|
| `ProcSubset=pid` | Restricts `/proc` to PID directories — hides `/proc/stat`, `/proc/meminfo`, `/proc/uptime`. |
| `PrivateNetwork=true` | Gives the agent its own network namespace where `enp1s0` does not exist; `/sys/class/net` would contain only `lo`. |
| `MemoryDenyWriteExecute=true` | V8 requires writable-executable pages. Node fails at startup. |
| `PrivateMounts=true` | A private mount namespace for `/run` would hide the socket from the Drive bind mount. |
| `PrivateUsers=true` | Breaks the shared numeric GID 29100 that Drive relies on. |
| `DynamicUser=true` | A UID that changes on restart cannot be joined by `group_add`. |

## Installation (not performed)

Run as root on the host, after review:

```bash
# 1. identity
install -m 0644 aegis-telemetry.sysusers.conf /usr/lib/sysusers.d/
systemd-sysusers
getent group aegis-telemetry        # expect: aegis-telemetry:x:29100:

# 2. code
install -d -m 0755 /opt/aegis/host-telemetry-agent
cp -r ../src ../package.json /opt/aegis/host-telemetry-agent/

# 3. unit
install -m 0644 aegis-telemetry.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now aegis-telemetry.service
```

## Verification on the Linux host (REQUIRED before Drive is pointed at it)

The unit's hardening cannot be executed on a Windows development machine, so
the following has **not** been run and must be, on the target host:

```bash
# the unit parses and the hardening is what we think it is
systemd-analyze verify /etc/systemd/system/aegis-telemetry.service
systemd-analyze security aegis-telemetry.service

# the five reads still work under the sandbox
systemd-run --uid=aegis-telemetry --gid=aegis-telemetry \
  --property=ProtectSystem=strict --property=ProtectProc=invisible \
  --property=PrivateDevices=true --property=RestrictAddressFamilies=AF_UNIX \
  --pty head -1 /proc/stat /proc/meminfo /proc/uptime \
  /sys/class/net/enp1s0/statistics/rx_bytes \
  /sys/class/net/enp1s0/statistics/tx_bytes

# the socket exists with the expected owner and mode
stat -c '%U:%G %a' /run/aegis-telemetry /run/aegis-telemetry/telemetry.sock
# expect: aegis-telemetry:aegis-telemetry 750
#         aegis-telemetry:aegis-telemetry 660

# it answers, and answers only on the socket
curl --unix-socket /run/aegis-telemetry/telemetry.sock http://localhost/internal/telemetry
ss -lntp | grep -i telemetry     # expect: no output — there is no TCP listener

# it is unreadable to an unrelated account
sudo -u nobody cat /run/aegis-telemetry/telemetry.sock   # expect: Permission denied
```

Three unit tests are also skipped on Windows and must be run on Linux, where
they exercise a real `AF_UNIX` socket file and its mode:

```bash
cd shared/host-telemetry-agent && npm test
```

They are: stale-socket reclamation, socket removal on stop, and the `0660` mode
assertion. On Windows they are reported as skipped, never as passed.

## Drive side (proposed, not applied)

See [`production-delta.md`](./production-delta.md) — the bounded, **not applied**
Compose change (`group_add: ["29100"]` plus one read-only bind mount).
