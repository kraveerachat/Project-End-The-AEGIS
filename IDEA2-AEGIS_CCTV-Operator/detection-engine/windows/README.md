# Windows Detection Laptop bootstrap

These scripts install the canonical IDEA2 Detection Engine as a portable,
machine-local Windows runtime. They reproduce the architecture verified on a
real Detection Laptop without committing machine credentials or depending on a
virtual environment inside a Git checkout.

## Installed architecture

```text
Windows boot
  -> SYSTEM Scheduled Task: AEGIS Detection Tunnel
       -> run_detection_tunnel.ps1 reconnect loop
       -> SSH local forward 127.0.0.1:18002 -> Monitor :8002
       -> SSH reverse forward server :18077 -> Engine :8077

User login
  -> HKCU Run: AEGIS Detection Engine
       -> run_engine_supervisor.ps1 restart loop
       -> runtime-local .venv -> run.py -> webcam/API :8077
```

The tunnel is a SYSTEM task because it does not need the desktop. The Engine is
started only after the camera-laptop user logs in because webcam access belongs
to that interactive session. The old interactive Engine Scheduled Task is
disabled, not deleted, so it cannot race the HKCU supervisor.

## What never belongs in Git

- the machine `.env`;
- API, Telegram, or database credentials;
- SSH private keys;
- a copied `known_hosts` file that has not been fingerprint-verified;
- recordings, snapshots, logs, or `.venv`.

Every Detection Laptop must have its own SSH key. Never copy the key from a
different operator's machine.

## First installation

1. Clone the repository on the Detection Laptop.
2. Create a configuration file outside the repository from `.env.example`.
3. Set the real machine-specific values. For the verified tunnel topology,
   `AEGIS_MONITOR_API_BASE` points to `http://127.0.0.1:18002`, while
   `AEGIS_STREAM_PUBLIC_URL` points to the server-side reverse listener.
4. Provision a unique per-machine Ed25519 key whose public key was explicitly
   authorized on the tunnel server. The installer never generates, guesses,
   rotates, or changes server authorization for a key.
5. Obtain the server host key, verify its fingerprint through a trusted
   channel, and save the verified line in a machine-local `known_hosts` file.
6. Open **Windows PowerShell as Administrator** and run:

```powershell
$engine = 'C:\path\to\clone\IDEA2-AEGIS_CCTV-Operator\detection-engine'
$bootstrap = "$env:LOCALAPPDATA\AEGIS\bootstrap"

& "$engine\windows\install_autostart.ps1" `
  -ConfigurationFile "$bootstrap\.env" `
  -TunnelHost 'tunnel-user@aegis-server' `
  -IdentityFile "$bootstrap\idea2_tunnel_ed25519" `
  -KnownHostsFile "$bootstrap\known_hosts" `
  -StartNow
```

The installer copies durable source to
`%LOCALAPPDATA%\AEGIS\DetectionEngine\app`, creates
`%LOCALAPPDATA%\AEGIS\DetectionEngine\.venv`, installs requirements, validates
configuration/imports, applies and verifies a protected ACL on the runtime key
copy, registers startup, and writes non-secret installation settings to
`install.json`. The final service-key ACL is exact and intentionally narrow:
owner SYSTEM, inheritance disabled, and one explicit SYSTEM FullControl rule.
Administrators, the interactive user, Users, Authenticated Users, Everyone, and
all other identities are rejected in the final ACL.

An elevated Administrator never reads or copies an existing SYSTEM-only service
key. The installer delegates key selection, optional copy, hardening, and the
SSH acceptance probe to a short-lived Scheduled Task running as SYSTEM. Before
the persistent tunnel task can be registered, that helper must prove the exact
ACL, strict-host-key SSH authentication, `127.0.0.1:18002`, and Monitor
`/healthz`; it is unregistered in a `finally` block on success or failure. For a
fresh install, `-IdentityFile` names the explicitly provisioned source key. For
an existing installation, `install.json` selects the recorded key filename; a
legacy runtime without metadata uses only the known
`idea2_tunnel_autostart_ed25519` filename and never guesses another key.

## Status, repair, and uninstall

```powershell
& .\windows\status_autostart.ps1
& .\windows\repair_autostart.ps1 -StartNow
& .\windows\uninstall_autostart.ps1
```

`repair_autostart.ps1` refreshes durable runtime files, checks the runtime-local
Python environment, and re-registers the final startup architecture. It reuses
the existing machine `.env`, exact recorded key, `known_hosts`, models,
recordings, logs, and non-secret `install.json`. Repair uses the same one-time
SYSTEM helper and never broadens the final ACL or rotates the key automatically.

Run status from an elevated PowerShell session when exact key ACL evidence is
required. A non-elevated user may receive `PrivateKeyAclInspection =
RequiresElevation`, which is an honest unknown rather than a false pass. Status
also reports task principal/boot trigger, supervisor process, ports, health, and
the `UNPROTECTED_PRIVATE_KEY`, `BAD_PERMISSIONS`, and `PUBLICKEY_DENIED` flags
from recent SSH stderr without printing key or secret content.

Uninstall removes only the HKCU Run entry, SYSTEM tunnel task, and running
supervisors. It deliberately preserves the runtime, `.env`, SSH material,
recordings, logs, and `.venv` for recovery. Remove those manually only after
reviewing the exact machine-local path and backup requirements.

## Verification after reboot

Do not manually start either component during this verification.

```powershell
& .\windows\status_autostart.ps1
```

Required evidence:

- Engine supervisor is running after user login;
- SYSTEM tunnel task is running after boot;
- `127.0.0.1:8077` listens and `/health` is `idle` before a viewer connects;
- `127.0.0.1:18002` listens and `/healthz` reaches Monitor;
- opening an authorized Live Canvas changes Engine health to camera demanded
  and connected with non-zero capture/detect FPS;
- closing the viewer returns health to idle and releases the camera.

Source/unit tests and a successful installer preflight do not replace this real
reboot and webcam proof.
