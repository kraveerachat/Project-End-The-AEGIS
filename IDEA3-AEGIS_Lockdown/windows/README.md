# AEGIS IDEA3 — Windows Standalone Runtime

One-folder Windows distribution: a launcher executable plus a bundled Node
runtime, the production Express server, and prebuilt React assets.

> **Status.** The build and smoke scripts in this folder have **not** been
> executed on Windows. Source-side contract tests pass on Linux, which is not
> Windows acceptance evidence. `WINDOWS_BUILD_VERIFIED = NO` and
> `WINDOWS_SMOKE_VERIFIED = NO` until `build.ps1` and `smoke.ps1` are run on a
> real Windows x64 machine.

## Layout

```text
AEGIS-IDEA3/
├── AEGIS-IDEA3.exe        launcher (the only executable surface)
├── core/                  packaged Python core
├── node/node.exe          pinned Node runtime
├── server/                production Express runtime + production dependencies
│   ├── index.js           Web entrypoint the launcher starts
│   ├── passwordHash.js    stdin-only bcrypt helper used by `configure`
│   └── node_modules/      production dependencies installed by the build
├── web/                   prebuilt React production assets
├── config.env.template    non-secret configuration template
├── toolchain-lock.json    pinned build inputs
└── manifest.json          per-file SHA-256 of the built payload
```

The installed payload is immutable. **No writable state is stored inside it.**

## Data locations

Writable state lives outside the application directory:

```text
%LOCALAPPDATA%\AEGIS\IDEA3\
├── config\.env            generated configuration (never commit or copy between installs)
├── db\                    durable SQLite audit databases
├── logs\                  runtime logs
└── runtime\               launcher status, control token
```

Override with `AEGIS_DATA_DIR` (absolute path). `AEGIS_CONFIG_FILE` overrides the
config file path alone.

## Operator commands

```powershell
AEGIS-IDEA3.exe configure --username admin   # prompts twice on stdin; writes .env
AEGIS-IDEA3.exe doctor                       # validate config, payload, paths, ports
AEGIS-IDEA3.exe start                        # start Core then Web
AEGIS-IDEA3.exe status                       # non-zero unless RUNNING
AEGIS-IDEA3.exe open                         # browser, only after Web health succeeds
AEGIS-IDEA3.exe logs --lines 200             # tail the external Core log
AEGIS-IDEA3.exe stop                         # Web first, then Core
```

`configure` reads the password from stdin only and stores a bcrypt cost-12 hash.
The plaintext password never enters a command argument, the log, or the `.env`.

## What this package does and does not do

Default launch is **lab / headless / dry-run** with production Web
authentication. In this candidate:

- detector, voice, UFW integration, and the Tk GUI are **unavailable**;
- IDEA1 and IDEA2 upstream feeds are **not configured**, so their sources report
  `NOT_CONFIGURED` / `UNKNOWN` — never a fabricated healthy state;
- hardware state is **unknown**: no broker connection, no ESP32, no relay;
- `doctor` validates locally only. It contacts no broker, device, or relay.

Production use additionally requires explicit HMAC secret, Admin PIN, and MQTT
configuration. **Even fully configured, none of this proves physical state.**
`Requested != Published != ACK != Executed != Physical Evidence`.

## Build

Requires Windows x64, PowerShell 7+, Python 3.12+, and Node/npm for the source
build stages. Inputs are pinned in `toolchain-lock.json` and
`requirements-build.txt` (PyInstaller 6.22.2, Node 24.20.0 x64 with SHA-256).

```powershell
pip install -r windows\requirements-build.txt
.\windows\build.ps1
```

The script refuses a dirty source tree or a Node archive hash mismatch, runs
Python and Web tests plus the production build, prunes dev dependencies, scans
the payload for `.env`, database, log, and secret-value leaks, writes
`manifest.json`, and produces:

```text
windows\out\AEGIS-IDEA3\                  one-folder distribution
windows\out\AEGIS-IDEA3-<sha>.zip         distributable archive
```

**Generated artifacts are never committed.** `windows/{cache,build,dist,out}/`
are git-ignored. Publish binaries through a release or CI artifact instead.

Verify a bundle by comparing `manifest.json` hashes against the files on disk and
the `sourceCommit` against the tag you expect.

## Smoke acceptance

```powershell
.\windows\smoke.ps1 -BundlePath 'C:\AEGIS\AEGIS-IDEA3' -DataPath 'C:\Temp\aegis-smoke-01'
```

`-DataPath` must not already exist. The script proves the bundle does not depend
on a developer PATH toolchain, configures over stdin, checks health, login and
logout, records the audit row count, stops, restarts, confirms the audit survived,
asserts absent feeds and absent hardware stay honest, and confirms no bundle child
process survives. Results are written to `windows\out\evidence\smoke-result.json`
(untracked). No password or token value is printed.

## Backup, upgrade, rollback

Backup — **stop the service first**, then copy the whole data directory,
including each `.sqlite3` file together with its `.sqlite3-wal` and `.sqlite3-shm`
companions. Copying a live database, or the main file alone, can yield an
incomplete audit.

Upgrade — stop, replace **only** the application directory with the new bundle,
start. The external data directory is untouched, so audit history and
configuration survive. Schema v1 databases migrate to v2 automatically on reopen.

Rollback — stop, restore the previous application directory, start. Because the
payload is immutable and all state is external, rollback does not roll back audit
history. If a restore of data is also required, restore the backup taken above
while the service is stopped.

## Secret rules

Never commit or ship a real `.env`, database, log, token, or credential. The
template ships blank. `build.ps1` fails the build if a secret value or forbidden
artifact is found in the payload.
