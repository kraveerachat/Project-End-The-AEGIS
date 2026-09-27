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
       -> SSH reverse forward explicit server interface :18077 -> Engine :8077

  -> Automatic Windows service: AEGISIdentityAgent
       -> isolated pinned Python/pywin32 runtime
       -> DPAPI CurrentUser-protected Ed25519 machine identity
       -> named pipe for Engine ingest plus 127.0.0.1:8078 browser proof

User login
  -> HKCU Run: AEGIS Detection Engine
       -> run_engine_supervisor.ps1 restart loop
       -> runtime-local .venv -> run.py -> webcam/API :8077
```

The tunnel is a SYSTEM task because it does not need the desktop. The Engine is
started only after the camera-laptop user logs in because webcam access belongs
to that interactive session. The old interactive Engine Scheduled Task is
disabled, not deleted, so it cannot race the HKCU supervisor.

The camera-independent Identity Agent is a separate automatic service. Its
repository-native install/status/repair/uninstall lifecycle is documented in
`windows/identity-agent/README.md`. Installation and repair preserve the single
Engine HKCU Run owner and never create camera demand. Uninstall preserves the
protected machine identity by default.

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
   `AEGIS_STREAM_PUBLIC_URL` and `AEGIS_AGENT_ENGINE_STREAM_URL` use the
   deployment-owned stable hostname for the server-side reverse listener.
4. Provision a unique per-machine Ed25519 key whose public key was explicitly
   authorized on the tunnel server. The installer never generates, guesses,
   rotates, or changes server authorization for a key.
5. Obtain the server host key, verify its fingerprint through a trusted
   channel, and save the verified line in a machine-local `known_hosts` file.
6. Open **Windows PowerShell as Administrator** and run:

```powershell
$engine = 'C:\path\to\clone\IDEA2-AEGIS_CCTV-Operator\detection-engine'
$bootstrap = "$env:LOCALAPPDATA\AEGIS\bootstrap"
$monitorTargetHost = '<deployment-monitor-hostname>'
$streamBindAddress = '<deployment-stream-interface-ip>'

& "$engine\windows\install_autostart.ps1" `
  -ConfigurationFile "$bootstrap\.env" `
  -TunnelHost 'tunnel-user@aegis-server' `
  -MonitorTargetHost $monitorTargetHost `
  -RemoteBindAddress $streamBindAddress `
  -RemotePort 18077 `
  -IdentityFile "$bootstrap\idea2_tunnel_ed25519" `
  -KnownHostsFile "$bootstrap\known_hosts" `
  -StartNow
```

`-MonitorTargetHost` and `-RemoteBindAddress` are mandatory deployment values;
the source has no Docker bridge IP default. For this gate the stream bind must
be one explicit non-loopback IPv4 server interface and must match the address assigned to Monitor's
stable host alias by deployment configuration. If Compose uses `host-gateway`,
preflight must resolve that alias from inside the Monitor container and prove it
reaches this same SSH listener before strict association is enabled. Do not
assume the current `aegis_internal` gateway address, and do not use the former
diagnostic `:18078` bridge.

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

## Original Task 15 Human Gate

The exact Machine A H0–H5 package is maintained in
`windows/identity-agent/README.md`. It is preparation for a Human Owner session,
not permission for an agent to run installation commands. The mutation boundary
is after H0; stop there until ChatGPT has reviewed the read-only evidence and
authorized one bounded Human-run step.

The gate keeps this startup model unchanged:

- Engine: the sole `HKCU Run` owner after interactive login;
- tunnel: the reviewed SYSTEM AtStartup Scheduled Task;
- Identity Agent: automatic `AEGISIdentityAgent` service under
  `NT SERVICE\AEGISIdentityAgent`;
- Agent browser proof: loopback only at `127.0.0.1:8078`;
- Engine API: `127.0.0.1:8077`;
- physical reverse stream: deployment-owned
  `aegis-stream-host.internal:18077` with one explicit non-loopback IPv4 SSH
  bind;
- old diagnostic bridge: absent; port `18078` is not part of installation or
  acceptance.

The Human Owner must supply these deployment/runtime-discovered values only at
the gate: approved Task 15 checkpoint SHA, external Engine `.env`, tunnel
identity path, verified `known_hosts`, `user@host`, Monitor target host, explicit
server bind address, Machine A Node ID, and registry key version. Those values
plus the isolated non-Production Monitor base URL/audience/browser origin must
be taken from reviewed local/deployment evidence, never guessed or copied from
another machine. A Production URL is forbidden in this gate. File contents,
credentials, private keys, cookies, and database URLs are never returned to
chat.

If H0-2 reports `CPYTHON_3_12_X64_REQUIRED`, stop before H0-3. The bounded
H0-2R procedure in `windows/identity-agent/README.md` records Python 3.14 by
path and SHA-256, verifies the exact `Python.Python.3.12` 3.12.10 x64 WinGet
manifest, and prepares a separately approved machine-scope installation at
`C:\Program Files\Python312`. The first WinGet install invocation was proven to
have stopped before installer execution because Windows PowerShell 5.1 split
the nested `--override` value at `Program Files`. The corrected procedure uses
the exact official installer only after mandatory SHA-256 and Authenticode
validation, with Python's adjacent `unattend.xml` format to disable PATH,
file-association, shortcut, and shared-launcher changes without nested native
quoting. The installer, configuration, and hash-bound original baseline remain
in an ACL-hardened Program Files staging directory through verification or
rollback. This scope makes the interpreter readable by the later virtual-account
service while preserving the existing per-user Python 3.14 installation.
H0-2R is a prerequisite only: it does not install Agent dependencies or modify
Agent, Engine, tunnel, camera, or Production state.

The corrected installer subsequently exited zero and produced the exact
3.12.10 x64 runtime under `C:\Program Files\Python312`. Its Burn maintenance
entry is in HKCU while the selected all-users MSI components are registered in
HKLM; the earlier runbook incorrectly required the Burn bundle GUID itself in
HKLM. That location mismatch is a Human Gate registration-model defect, not
evidence of a per-user runtime. The bounded continuation requires one exact HKCU
bundle entry, the seven exact expected HKLM PSF component registrations, no
additional matching registration, `py.exe -0p`, exact 3.12.10/x64/path proof,
and the hash-bound original Python 3.14, PATH, launcher, and Store-alias
baseline. H0-2 is then repeated and returned to ChatGPT. H0-3 remains blocked
until that evidence is accepted. A
Python-3.12-only rollback through the same revalidated official installer is
prepared for use before H1; it must not remove Python 3.14 or the existing
launcher.

The installer command uses the reviewed repository script and retains its exact
parameters:

```powershell
& "$EngineSource\windows\install_autostart.ps1" `
  -ConfigurationFile $EngineConfigurationFile `
  -BasePythonPath $Python312 `
  -TunnelHost $TunnelHost `
  -MonitorTargetHost $MonitorTargetHost `
  -RemoteBindAddress $RemoteBindAddress `
  -RemotePort 18077 `
  -IdentityFile $TunnelIdentityFile `
  -KnownHostsFile $KnownHostsFile `
  -StartNow
```

Do not run that block during Task 15. Immediate and post-reboot verification
must use `status_autostart.ps1`, `status_identity_agent.ps1`, and
`verify_machine_a_no_powershell.ps1`, with the camera still idle before any
authorized browser demand. Operator must resolve to logical CAM-01 and
operator2 to logical CAM-02, both using the same server-registered Machine A
physical camera. Account switching never changes the heartbeat identity,
restarts a bridge, or creates a second camera process.

Default rollback is non-destructive: Engine uninstall preserves runtime data
and SSH material; Agent uninstall preserves the DPAPI-protected identity.
Permanent identity destruction is a separate, explicitly destructive option
and is never implied by uninstall, repair, or failed acceptance.
