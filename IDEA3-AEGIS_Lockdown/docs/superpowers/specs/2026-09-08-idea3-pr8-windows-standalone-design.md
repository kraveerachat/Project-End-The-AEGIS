# IDEA3 PR8 Windows Standalone Runtime Design

**Date:** 2026-09-08
**Area / owner:** `idea3` / `music`
**Branch:** `feat/idea3-windows-standalone-pr8`
**Base:** `c68946cbe917a71349a8234a4bc028fbf4c6967d`
**Decision:** Approved Option A — a Windows launcher executable with bundled components in a one-folder distribution.

## Objective

Deliver an x64 Windows package that starts, supervises, reports, stops, and opens the IDEA3 Security Center without requiring an evaluator to install Python or Node.js or run development commands. The package must keep mutable data and secrets outside its application payload, retain the existing authenticated command path, and report missing upstream or physical evidence as unavailable or unknown.

PR8 does not implement upstream IDEA1/IDEA2 feeds, publish Web actions to MQTT, prove ESP32 or relay state, deploy to production, or close project-sequence PR9–PR12.

## Evidence behind the decision

The current system has two independent runtimes:

- Python owns MQTT, the authenticated command controller, supervisor state, and the Core audit database.
- Node/Express owns Web authentication, PR7 read-only adapters, containment acceptance, and the Web SQLite audit database.
- React is a Vite build with base path `/security/`; the current production Express entry point does not serve the build.

Python also contains POSIX-only assumptions (`fcntl`, `/proc`, POSIX signals, `journalctl`, `pkexec`, `ufw`, `DISPLAY`, and Linux audio commands). A monolithic executable would obscure rather than remove these boundaries. A one-folder package makes both runtimes inspectable, replaceable, and testable while still giving evaluators one executable entry point.

## Supported candidate

- Windows 10 or Windows 11, x64.
- Built on Windows x64; a Linux-built artifact cannot satisfy Windows acceptance.
- CPython 3.14.x x64 with PyInstaller 6.22.2 in `onedir` mode.
- Bundled official Node.js 24.20.0 x64 ZIP, SHA-256 `6cac9ffbca8f6a47091e4b5c772e0606049c3871cb67d900c0cedde630e545ba`.
- Node production dependencies installed from the committed lockfile with `npm ci --omit=dev`.
- React assets produced by `npm run build` and served by Express; Vite is never required on the evaluator machine.

The build toolchain versions are build inputs, not runtime claims. Exact Windows, Python, Node, npm, and PyInstaller versions must be captured in the PR8 receipt from the machine that creates the candidate.

## Distribution layout

```text
AEGIS-IDEA3/
├── AEGIS-IDEA3.exe
├── _internal/                 PyInstaller runtime
├── node/node.exe              pinned official Node runtime
├── server/                    Express server and production dependencies
├── web/                       prebuilt Vite assets
├── defaults/.env.example      non-secret configuration template
├── manifest.json              version, source SHA, input versions and hashes
└── THIRD_PARTY_NOTICES.txt
```

`dist/`, `build/`, downloaded Node archives, the unpacked Node runtime, `node_modules/`, ZIPs, EXEs, databases, logs, and local configuration remain generated artifacts and are not committed. Git stores only source, manifests, lockfiles, build scripts, tests, documentation, and textual evidence.

## Writable-data contract

The immutable application directory and writable state are separate.

```text
%LOCALAPPDATA%\AEGIS\IDEA3\
├── config/.env
├── data/core-audit.sqlite3
├── data/security-center-audit.sqlite3
├── logs/aegis-supervisor.log
├── logs/aegis-components.log
├── logs/aegis-events.jsonl
└── runtime/
    ├── status.json
    ├── launcher-status.json
    ├── launcher.lock
    └── control.token
```

`AEGIS_DATA_DIR` may override the root with an absolute writable path. Relative overrides fail validation. Development source execution retains repository-local defaults unless `AEGIS_DATA_DIR` is set.

The launcher resolves the data root before importing configuration-dependent Core modules. It loads only `<data>/config/.env`, without overwriting environment variables already supplied by the operator. Every default database, log, and runtime path is then derived from the data root and passed to Node through environment variables. No secret is placed in command-line arguments, status JSON, logs, or the package manifest.

## Evaluator interface

`AEGIS-IDEA3.exe` is a console launcher with these commands:

```text
AEGIS-IDEA3.exe configure
AEGIS-IDEA3.exe start [--profile development|lab|production] [--no-open]
AEGIS-IDEA3.exe stop [--timeout 15]
AEGIS-IDEA3.exe status [--json]
AEGIS-IDEA3.exe logs [--structured] [--lines 50] [--open-folder]
AEGIS-IDEA3.exe open
AEGIS-IDEA3.exe doctor [--profile development|lab|production]
```

Double-clicking or invoking without arguments is equivalent to `start --profile lab`: Web runs with production authentication while Core runs headless, detector-disabled, and dry-run. This allows evaluation without hardware and cannot publish relay commands. Explicit production mode remains fail-closed unless the existing non-demo HMAC and Admin PIN requirements are satisfied.

`configure` prompts without echo for the Web administrator password, creates a random session secret, delegates bcrypt hashing to a bundled Node helper, and writes the resulting external `.env` atomically. It never prints or logs the password, hash, session secret, integration tokens, MQTT password, HMAC material, or Admin PIN. Existing configuration is not overwritten without an explicit confirmation flag.

## Launcher process model

`start` performs preflight and spawns a detached `run` instance of the same executable. The long-lived runner:

1. Acquires an exclusive launcher lock. OS release of the file lock prevents stale lock files from blocking restart.
2. Creates a random control token in the external runtime directory.
3. Starts a loopback-only control/status HTTP server on `127.0.0.1`.
4. Starts the packaged Core as `AEGIS-IDEA3.exe core ...`.
5. Starts bundled `node.exe server/index.js` with production configuration.
6. Waits for Core status and Web health, writes an atomic launcher status document, and opens `http://localhost:<port>/security/` unless disabled.
7. Monitors both children. Unexpected exit is reported as `FAILED` or `DEGRADED`; it is never converted to healthy.
8. On an authenticated local stop request, stops Web and Core, waits for clean exit, uses a bounded forced termination only if necessary, closes the control server, removes the control token, and releases the lock.

The control service exposes:

- `GET /v1/core-status`: public only on loopback and returns `safe_status_projection(...)`.
- `GET /v1/launcher-status`: public only on loopback and returns allowlisted component states and paths omitted.
- `POST /v1/stop`: requires the random control token in `X-AEGIS-Control-Token`.

Node receives only the Core status URL. It never receives the control token.

## Cross-platform Core boundary

New focused modules isolate operating-system behavior:

- `aegis_soc/paths.py`: application/data path discovery and default path derivation.
- `aegis_soc/platform_lock.py`: POSIX `flock` and Windows `msvcrt.locking` behind the same context-owned lock interface.
- `aegis_soc/windows_launcher.py`: command parsing, configuration bootstrap, status/control server, child orchestration, and browser/log-folder opening.

`aegis_soc/supervisor.py` consumes the lock abstraction instead of importing `fcntl`. Child process creation receives platform-specific flags through a helper; no `shell=True` is introduced. The existing Linux `aegisctl` interface and systemd example remain supported.

Windows PR8 deliberately does not package the Linux detector, UFW control, voice prototype, or Tkinter operator GUI as operational components. If requested on Windows, preflight reports a specific unsupported/unavailable result. The Security Center remains the packaged evaluator UI. No missing component is represented as running.

## Web production runtime

Web configuration adds:

- `AEGIS_WEB_BASE_PATH`, fixed to `/security` by the launcher.
- `AEGIS_WEB_STATIC_DIR`, fixed to the packaged `web` directory.
- `AEGIS_BIND_HOST`, accepted only when it resolves to the loopback contract; package default `127.0.0.1`.

API routes remain `/api/...` in direct test/development mode and become `/security/api/...` when the base path is configured. The server registers APIs before static middleware, serves immutable hashed assets with long-lived caching, serves `index.html` with `no-store`, and returns the SPA fallback only for HTML `GET`/`HEAD` requests below `/security`. It never rewrites `/security/api/...` failures to HTML.

An unauthenticated `GET <base>/api/health` endpoint returns only `{ status: "ok" }`; it reveals no configuration or dependency state. The production process handles `SIGINT` and `SIGTERM`, stops accepting requests, closes the HTTP server, and closes the SQLite repository. The launcher opens the hostname `localhost` while the server binds `127.0.0.1`; Windows browser acceptance must prove the production `Secure` session cookie works on this loopback origin.

## SQLite durability

The Python Core database and Web audit database remain distinct. Both live in the external data directory.

The existing Web schema v2 and additive v1-to-v2 migration remain unchanged unless a failing test exposes a packaging defect. The launcher never deletes, replaces, or copies a live database. Shutdown closes Web before marking the launcher stopped. Documentation requires stopping the launcher before copying the database together with any `-wal` and `-shm` files.

Acceptance must prove fresh initialization, v1-to-v2 migration, v2 reopen, audit survival after launcher restart, and absence of database files from Git and the release payload.

## Honest state rules

The following remain mandatory:

```text
IDEA1 missing                 -> NOT_CONFIGURED or UNAVAILABLE
IDEA2 missing                 -> NOT_CONFIGURED or UNAVAILABLE
ESP32 absent                 -> UNKNOWN or NOT_CONFIGURED
Relay without evidence       -> UNKNOWN
Physical state without proof -> UNKNOWN
```

Dry-run may mean that the Core process is running; it does not make the device, relay, or complete system healthy. The safe runtime projection must not return top-level `HEALTHY` when required device/broker evidence is unknown or disconnected. PR7 containment acceptance remains acceptance-only:

```text
WEB_TO_MQTT = NO
WEB_TO_ESP32 = NO
WEB_TO_RELAY = NO
ACK != PHYSICAL EVIDENCE
```

Shutdown, restart, launcher crash recovery, and upgrade never send `RESTORE_UPLINK`.

## Build and supply-chain boundary

`windows/toolchain-lock.json` pins the Node archive URL/name/hash and PyInstaller version. `windows/build.ps1`:

1. Refuses non-Windows or non-x64 execution.
2. Creates a disposable build directory.
3. Installs Python build requirements from a pinned file.
4. Runs `npm ci`, Web tests, and `npm run build`.
5. Runs `npm prune --omit=dev` in a copied server payload.
6. Downloads or accepts the pinned Node archive and verifies SHA-256 before extraction.
7. Runs Python tests and PyInstaller in `onedir` mode.
8. Copies only allowlisted runtime files and writes `manifest.json` with source SHA and hashes.
9. Runs a generated-artifact/secret scan and creates a ZIP outside tracked source paths.

The build must fail if the Node hash differs, required assets are missing, configuration or database files appear in the payload, or source Git status becomes dirty.

## Verification strategy

Behavior changes follow red-green-refactor tests. Linux CI/local verification covers platform-independent logic using fakes for process and browser operations. It cannot close the Windows acceptance gate.

Required Windows evidence:

- Build on clean Windows x64 with the pinned toolchain.
- Start on a VM without preinstalled Python or Node.
- Configure valid Web credentials; login and logout.
- Missing/invalid configuration fails closed without leaking values.
- Start, status, logs, open, stop, restart, and relaunch.
- No upstream feeds and no hardware remain honest.
- Fresh Web DB, v1 migration, v2 reopen, and audit survival across restart.
- Clean shutdown leaves no Core or Node child process.
- Package contains no `.env`, database, log, token, or unapproved generated input.
- Record artifact SHA-256; do not commit the artifact.

If no Windows executor is available, implementation may be `IMPLEMENTED_UNEXERCISED`, but PR8 cannot be called closed or Windows-verified.

## Rollback

Stop the launcher, preserve the external data directory, and replace the versioned application folder with the previous package. Because PR8 does not introduce a schema newer than v2, the prior PR7 Web runtime can reopen the audit database. If a later change alters that fact, the receipt must replace this rollback statement with migration-specific evidence.

## Documentation and policy

After implementation and fresh verification:

- Correct the current PR7 merge/roadmap facts in `idea3-status.md` and the latest handoff section without editing historical receipts.
- Update IDEA3 and Web runtime documentation, including the current SQLite schema version.
- Add exactly one immutable PR8 receipt owned by `music`.
- Keep the PR Draft until Windows evidence and policy checks pass; if Windows evidence is unavailable, record the limitation and keep the result partial.
- No shared or cross-scope source path is planned. Any later cross-scope change requires explicit integration review and matching PR/receipt declarations.
