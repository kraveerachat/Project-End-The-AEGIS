# AEGIS Detection Engine on Arch Linux/systemd

This directory installs one Detection Engine and one strict two-way SSH tunnel
as system services. It is the Linux equivalent of `windows/`, but it does not
copy Windows ACL assumptions onto Linux.

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
  --remote-port SERVER_APPROVED_UNIQUE_PORT \
  --start-now
```

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
