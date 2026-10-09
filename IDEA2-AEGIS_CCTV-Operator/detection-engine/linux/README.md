# AEGIS Detection Engine on Arch Linux/systemd

This directory installs one Detection Engine and one strict two-way SSH tunnel
as system services. It is the Linux equivalent of `windows/`, but it does not
copy Windows ACL assumptions onto Linux.

## Current Machine B support boundary

Machine B is a Linux machine whose local webcam device is discovered and chosen
at deployment through `AEGIS_CAMERA_SOURCE`. The repository currently provides
source and static tests for Engine startup, the SSH tunnel, systemd boot enable,
status, repair, and non-destructive uninstall. Cross-platform Linux camera
discovery exists in source but does not yet have a dedicated Linux discovery
test or real Machine B acceptance.

The dedicated Ed25519 Identity Agent is currently a Windows service/named-pipe
implementation. This Linux directory does not install an equivalent identity
runtime service. Therefore strict Linux Machine B identity-agent operation and
end-to-end runtime acceptance are `NOT_IMPLEMENTED` / `NOT_VERIFIED`; they need
a future Linux adapter behind the existing machine-proof interface. Do not copy
PowerShell, HKCU Run, Windows Service, Scheduled Task, or DPAPI mechanics into
that adapter. Shared Node/physical-camera authorization, account aliases,
demand/release, and trained-model semantics remain unchanged.

## Runtime model

```text
Linux boot
  -> aegis-detection-tunnel.service
       -> 127.0.0.1:18002 -> Monitor :8002
       -> server unique reverse port -> local Engine :8077
  -> aegis-detection-engine.service
       -> runtime-local .venv -> run.py -> local webcam/API :8077
```

Services run as the user who invokes the installer. The installer adds that
user to the existing `video` group when needed. The private key remains owned
by that user with mode `0600`; verified `known_hosts` is mandatory. A fresh
Detector must use a fresh private key and a unique server reverse port.

## Files that stay outside Git

- machine `.env` and service API keys;
- SSH private key and verified `known_hosts`;
- YOLO/YuNet/SFace models;
- biometric embeddings/enrollment material;
- recordings, snapshots, logs and the runtime `.venv`.

## Install

Run from the Detection Engine checkout as the target camera user, not as root.
The example values below are placeholders; use a server-approved reverse port
and machine-local files.

```bash
./linux/install_systemd.sh \
  --config /path/to/machine.env \
  --tunnel-host tunnel-user@aegis-server \
  --identity-file "$HOME/.local/share/aegis/detection-engine/ssh/detector-key" \
  --known-hosts-file "$HOME/.local/share/aegis/detection-engine/ssh/known_hosts" \
  --monitor-target-host DEPLOYMENT_MONITOR_HOST \
  --remote-bind-address DEPLOYMENT_STREAM_BIND_ADDRESS \
  --remote-port SERVER_APPROVED_UNIQUE_PORT \
  --start-now
```

`--monitor-target-host`, `--remote-bind-address`, and `--remote-port` are
mandatory reviewed deployment inputs. The bind address must be one explicit
non-loopback IPv4 server interface. There is no Docker bridge, private-network
address, or unique reverse-port default in reusable source.

The installer copies durable source to
`~/.local/share/aegis/detection-engine/app`, creates a runtime-local `.venv`,
validates the selected recognition backend, proves both SSH forwards and
Monitor `/healthz`, then installs/enables the two systemd units. It never prints
secret values.

## Operate

```bash
./linux/status_systemd.sh
./linux/repair_systemd.sh --start-now
./linux/uninstall_systemd.sh
```

Uninstall removes only the systemd registrations. Runtime configuration, key
material, models, biometric data and recordings remain in place for recovery.

## Machine B onboarding status

Repository-proven steps are limited to:

1. discover the local Linux camera with the existing cross-platform camera
   inventory and set its `AEGIS_CAMERA_SOURCE` in Machine B's private `.env`;
2. provide unique Node/physical-camera registration, SSH identity, verified
   `known_hosts`, Monitor host, stream bind, ports, and model paths as deployment
   data;
3. run the systemd install/status/repair/uninstall scripts and their static
   tests; and
4. prove real reboot, camera demand/reference counting, account switching, and
   final release on Machine B before claiming runtime readiness.

The first three steps have repository implementation or static coverage. Real
Machine B provisioning, the Linux identity-agent adapter, and the fourth step
are `FOLLOW-UP_REQUIRED`; no command in this document claims they have passed.
