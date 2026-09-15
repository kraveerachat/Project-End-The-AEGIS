# IDEA3 Production Runtime Operations

## Current PR11 ownership boundary — Core-only repository preparation

PR11 Phase 3 uses split Production ownership:

```text
IDEA3 Web  = PR132 container behind the HUB (sole Production Web owner)
IDEA3 Core = aegis-idea3-core.service on the Core appliance
```

The new Core unit is `deploy/aegis-idea3-core.service.example`. It executes
`aegis_soc.supervisor` directly with `--profile production --live --headless
--no-detector --no-voice`. It starts no Web, GUI, or detector process and has
no restart, kill, or availability dependency on IDEA2. The historical
`aegis_soc.production_runtime` and `deploy/aegis-idea3.service.example` remain
for PR9 local/composite compatibility only; they are not Phase 3 installation
candidates.

This is repository preparation. The unit has not been copied, verified on the
Core, enabled, started, stopped, or restarted. No user, directory, network,
certificate, broker, firmware, relay, or live system was changed.

### Core filesystem contract

```text
/opt/aegis-idea3/releases/<git-sha>/                 immutable release
/opt/aegis-idea3/current                            selected release
/etc/aegis-idea3/core.env                           configuration
/etc/aegis-idea3/pki/                               certificate material
/var/lib/aegis-idea3/data/core-audit.sqlite3        durable Core audit
/var/lib/aegis-idea3/data/core-dispatch.sqlite3     durable dispatch ledger
/run/aegis-idea3/                                   ephemeral PID/lock/status only
/var/log/aegis-idea3/                               Core logs
```

The service identity is `aegis-idea3:aegis-idea3`. Application files are not
writable by it. The Core private key is generated and stored on Core during a
later authorized certificate process and never leaves Core. The dispatch
ledger is never placed under `/run` or the source checkout.

Start from `deploy/aegis-idea3-core.env.example` when a separately authorized
live phase creates `/etc/aegis-idea3/core.env`. Keep it root-owned and readable
only by the service group. Never print, source into an interactive trace, or
commit the completed file.

### Core lifecycle and status contract

The future owner-run lifecycle is systemd-owned:

```bash
sudo systemctl start aegis-idea3-core.service
sudo systemctl status aegis-idea3-core.service --no-pager
sudo systemctl restart aegis-idea3-core.service
sudo systemctl stop aegis-idea3-core.service
sudo journalctl -u aegis-idea3-core.service --since today --no-pager
```

These commands are documentation, not commands authorized or executed by this
task. SIGTERM drives the supervisor's normal shutdown path. No stop, restart,
failure, credential problem, or network problem sends RESTORE. On restart, any
uncertain claimed/published action becomes `OUTCOME_UNKNOWN` and is never
republished.

Dispatch is disabled by default. When enabled later, missing or TLS-rejected
credentials report `PAUSED_CREDENTIAL`; network/server unavailability reports
`UNAVAILABLE`. Both degrade dispatch without issuing CUT. The client accepts
HTTPS only and retains certificate and hostname verification. An ACK, STATUS,
or runtime status is not physical containment evidence.

The unit enables CPU, memory, task, and I/O accounting. It intentionally sets
no CPU, RAM, task, or I/O quota; Production limits are chosen only after the
authorized live phase measures the Core and co-resident IDEA2 workloads.

### Future owner-run read-only Core evidence package

Run this package only in a separately authorized read-only evidence session.
It prints no password, token, private-key content, or environment value.
Absence of output is not PASS.

```bash
uname -a
cat /etc/os-release
systemd --version

ip -brief link
ip -4 address show
ip -4 route show table all
ip -6 route show table all
iw dev
sysctl net.ipv4.ip_forward net.ipv6.conf.all.forwarding

systemctl list-unit-files \
  aegis-detection-engine.service \
  aegis-detection-tunnel.service \
  aegis-idea3-core.service
systemctl show \
  aegis-detection-engine.service \
  aegis-detection-tunnel.service \
  aegis-idea3-core.service \
  --property=Id,LoadState,ActiveState,SubState,User,Group,MainPID,ControlGroup,CPUAccounting,MemoryAccounting,TasksAccounting,IOAccounting

getent passwd aegis-idea3
getent group aegis-idea3
stat -c '%A %U %G %n' \
  /opt/aegis-idea3/current \
  /etc/aegis-idea3 \
  /etc/aegis-idea3/pki \
  /var/lib/aegis-idea3 \
  /var/lib/aegis-idea3/data \
  /run/aegis-idea3 \
  /var/log/aegis-idea3

df -h /opt /etc /var/lib /run /var/log
free -h
lscpu
ps -eo pid,ppid,user,group,stat,%cpu,%mem,rss,etimes,comm,args
ss -lntup

find /etc/aegis-idea3/pki -maxdepth 1 -type f \
  -printf '%M %u %g %s %TY-%Tm-%TdT%TH:%TM:%TS %p\n'
openssl x509 -in /etc/aegis-idea3/pki/idea3-core-client.crt \
  -noout -subject -issuer -serial -dates -ext extendedKeyUsage

getent ahosts idea3-core.aegis.internal
P3_HUB_IP=$(getent ahostsv4 idea3-core.aegis.internal | awk 'NR == 1 {print $1}')
ip route get "$P3_HUB_IP"
curl --fail --show-error --silent --head \
  --cacert /etc/aegis-idea3/pki/hub-server-ca.crt \
  --cert /etc/aegis-idea3/pki/idea3-core-client.crt \
  --key /etc/aegis-idea3/pki/idea3-core-client.key \
  https://idea3-core.aegis.internal/
```

The final `curl` performs an authenticated HTTPS HEAD only after Phase 2's
machine route and K10 credentials exist. It must not use `-k`, HTTP fallback,
verbose TLS output, or a browser credential. Expected reachability remains
NOT PROVEN until this package is actually run and reviewed.

### Live prerequisites, rollout, and rollback boundary

Live installation remains blocked until `PHASE2_RUNTIME_COMPLETE=YES`, K8 is
approved, K9 DNS/server-certificate evidence exists, K10 issues the approved
client certificate, Pub accepts D6, the conflicting IDEA1 Production window is
closed, and Music explicitly authorizes Core mutation. K12 remains for the next
planned reboot; this task does not schedule one.

Future rollout creates only the dedicated service identity and roots, places a
reviewed immutable release/configuration/certificate set, verifies the unit,
and starts it in an announced window. Future rollback stops/disables only
`aegis-idea3-core.service` and preserves durable data and certificate roots. It
does not restart or kill IDEA2 or Web and never sends RESTORE.

## Historical PR9 composite evidence and safety boundary

This runbook describes the PR9 server candidate. The example service has not
been installed or exercised in Production. Local acceptance uses loopback and a
disposable lab/headless/dry-run data root. It does not prove MQTT delivery,
ESP32 behavior, relay state, WAN isolation, IDEA1/IDEA2 availability, systemd
installation, or Production deployment.

The following PR9 reference is retained for local compatibility. It is not the
PR11 Phase 3 installation procedure. The composite runtime owns Python Core
first and Node/Express Web second. Stop
order is Web then Core. Startup, shutdown, restart, rollback, and crash cleanup
never send `RESTORE_UPLINK`. Browser/Web code has no MQTT, ESP32, GPIO, or relay
command path.

## Prerequisites and layout

Create a dedicated unprivileged `aegis-idea3` account and group. Install each
reviewed release beneath an immutable SHA-specific directory and point `current`
to the selected release only during a controlled upgrade or rollback:

```text
/opt/aegis-idea3/releases/<git-sha>/    immutable source, venv, Web build
/opt/aegis-idea3/current               selected immutable release
/var/lib/aegis-idea3/config/.env       mode 0600 external configuration
/var/lib/aegis-idea3/data/             Core and Web SQLite files
/var/lib/aegis-idea3/logs/             Core and component logs
/var/lib/aegis-idea3/runtime/          replaceable status, lock, and token files
```

The service account must own `/var/lib/aegis-idea3`; directories should be mode
0700 and the configuration file mode 0600. Application files must not be
writable by the service account. Required software is a supported Python with
the pinned requirements installed in `venv`, Node.js compatible with the Web
lockfile, and a successful `npm run build` under `web/`.

## External configuration

Start from `.env.example`, store the result only at
`/var/lib/aegis-idea3/config/.env`, and fill values through the operator's secret
management procedure. Never paste values into Git, tickets, logs, status output,
or this runbook.

Required server path and process keys are:

```text
AEGIS_APPLICATION_ROOT=/opt/aegis-idea3/current
AEGIS_DATA_DIR=/var/lib/aegis-idea3
AEGIS_CONFIG_FILE=/var/lib/aegis-idea3/config/.env
AEGIS_NODE_EXECUTABLE=<absolute-node-path>
AEGIS_WEB_ENTRYPOINT=/opt/aegis-idea3/current/web/server/index.js
AEGIS_WEB_STATIC_DIR=/opt/aegis-idea3/current/web/dist
AEGIS_BIND_HOST=127.0.0.1
PORT=8003
AEGIS_CONTROL_PORT=8103
```

Production Web also requires a policy-compliant `SESSION_SECRET`, an Admin user,
and a bcrypt cost 12-31 `AEGIS_IDEA3_ADMIN_PASSWORD_HASH`. Set
`NODE_ENV=production`, `AEGIS_ALLOW_DEV_LOGIN=false`, and
`AEGIS_DEMO_ALLOWED=false`. The runtime derives absolute Core/Web database,
runtime, and log paths beneath `AEGIS_DATA_DIR`; do not point them into `/opt`.

A live Core profile additionally requires reviewed MQTT host/port/Core
credentials, a readable dedicated MQTT CA, independent per-device C2D/D2C key
credentials, durable Protocol v1 storage, and a non-default `AEGIS_ADMIN_PIN`. Keep
IDEA1/IDEA2 URL/token pairs blank until their owners provision reviewed
read-only endpoints. Blank optional dependencies are `NOT_CONFIGURED`, not
healthy. Use `AEGIS_PROFILE=lab` and `AEGIS_DRY_RUN=1` only for isolated
non-actuating acceptance; never label that state Production-deployed.

Telegram notification is optional and outbound-only in this Production Runtime.
Set both `AEGIS_TG_TOKEN` and `AEGIS_TG_CHAT` in the external configuration to
enable one notification when an observed uplink state transitions to `LOCKDOWN`
and one restore notification when it transitions to `NORMAL`. With either value
blank, no Telegram request is made. Repeated unchanged state does not send a
duplicate. Delivery runs outside the MQTT callback and failure is fail-soft;
logs and status never include the token, chat ID, bot URL, or exception details.
Production starts Core with `--headless`, does not start `TelegramListener`, and
does not enable inbound `/cut` or `/restore` commands.

Telegram acceptance or delivery proves notification transport only. It never
counts as command publication, ACK, execution, relay confirmation, WAN
isolation, or physical evidence.

## Preflight and service installation

From the selected immutable release, build and verify before installation:

```bash
./venv/bin/python -m aegis_soc.production_runtime doctor
cd web
npm ci
npm test -- --run
npm run build
cd ..
./venv/bin/pytest -q
./venv/bin/ruff check aegis_soc tests
```

`doctor` validates the configuration, payload, external writable paths, and
loopback boundary without contacting a broker, device, relay, or upstream feed.
Copy `deploy/aegis-idea3.service.example` to the systemd unit directory only
after review, reload systemd, and enable the reviewed unit through the normal
change process. The repository task itself does none of those host mutations.

## Lifecycle commands

For a reviewed systemd installation:

```bash
sudo systemctl start aegis-idea3
sudo systemctl status aegis-idea3 --no-pager
sudo systemctl restart aegis-idea3
sudo systemctl stop aegis-idea3
sudo journalctl -u aegis-idea3 --since today --no-pager
```

For an isolated foreground review under the service account and configured
environment:

```bash
./venv/bin/python -m aegis_soc.production_runtime doctor
./venv/bin/python -m aegis_soc.production_runtime start
./venv/bin/python -m aegis_soc.production_runtime status
./venv/bin/python -m aegis_soc.production_runtime restart
./venv/bin/python -m aegis_soc.production_runtime stop
```

Only one owner may run for a data root. A duplicate start returns non-zero and
does not replace the active control token or status. `stop` is idempotent. An
unexpected Core or Web exit makes the owner fail, cleans the surviving child,
and lets systemd's bounded `Restart=on-failure` policy decide whether to restart.

## Liveness, readiness, and evidence

- `GET http://localhost:8003/security/api/health` proves only that Express can
  answer a liveness request.
- `GET http://localhost:8003/security/api/readiness` returns HTTP 200 `READY`
  only when the schema-v3 audit repository probe succeeds; audit failure returns
  HTTP 503 `DEGRADED`.
- `production_runtime status` reads `runtime/service-status.json` and separates
  process health, service readiness, audit, MQTT, IDEA1, IDEA2, ESP32, and
  physical evidence.

`Requested != Published != ACK != Executed != Physical Evidence`. A listener,
HTTP 200, MQTT connection, publication, ACK, or status file is not proof of a
relay contact or WAN isolation. Missing, stale, malformed, or unavailable
evidence must remain `UNKNOWN`, `UNAVAILABLE`, `NOT_CONFIGURED`, or `DEGRADED`.

## Logs and diagnosis

Inspect the journal plus external `logs/aegis-components.log` and
`logs/aegis_soc.log`. Status and logs must not contain secret values. Diagnose in
this order:

1. Run `doctor` and resolve invalid absolute paths, missing `web/dist/index.html`,
   missing configuration, ownership, or permissions.
2. Inspect `systemctl status`, the journal, and component logs for the first
   child failure.
3. Check Web liveness, then readiness. Treat liveness-without-readiness as an
   audit/storage failure, not success.
4. Check free space and directory ownership before investigating SQLite.
5. Check optional adapters and MQTT independently. Do not enable hardware just
   to make a health indicator green.

After any failed start, require no surviving Core/Web child and no control token.
A `FAILED` service-status file is diagnostic state; it is not durable audit
evidence.

## Backup and stopped restore

Stop the service and verify it is inactive before copying data. Back up the whole
`/var/lib/aegis-idea3` tree so each SQLite database travels with any `-wal` and
`-shm` companions, configuration, and logs. Restrict the backup at least as
tightly as the source because it contains credentials and audit records.

Restore only while stopped. Preserve the failed/current tree separately, restore
the complete captured tree with service-account ownership and restrictive
permissions, then run `doctor`, start, readiness, Admin login, and ordered audit
read verification. Do not copy a live SQLite file alone and do not use runtime
status as the backup record.

## Upgrade and rollback

For an upgrade, stage and verify a new immutable SHA directory, stop, back up the
external root, switch `current`, start, then verify process status, readiness,
authentication, and ordered durable audit. Do not delete the previous payload or
backup during the acceptance window.

For rollback, stop, preserve the current external root, switch `current` to the
previous reviewed payload, and start against the compatible external data. If a
schema compatibility decision is required, restore the matching stopped backup
instead of editing the database manually. Re-run `doctor`, readiness, login, and
audit checks. Rollback never means resetting hardware state or sending RESTORE.

## Secret rotation

Rotate one credential class at a time through the approved secret store. Stop,
update the external `.env` without echoing values, preserve mode 0600, start, and
verify the affected boundary. Rotating the session secret invalidates sessions;
rotating the Admin password hash requires a new login; rotating integration
tokens requires the upstream owner; rotating MQTT/HMAC material requires a
separately authorized device/broker rollout. Never reuse a human session cookie
as an integration credential.

## Container runtime behind the HUB (PR11 Phase 2 — prepared, not deployed)

This section describes the D3 server packaging prepared in PR11 Phase 2. It is
repository preparation only: no image has been built on the AEGIS Server, no
container or network exists there, and `PRODUCTION_MUTATION_AUTHORIZED = NO`.
The design and the full Production package (read-only evidence, the 17-step
sequence, and rollback) are in
`docs/superpowers/specs/2026-09-15-idea3-pr11-phase2-server-integration-design.md`.

The container runs only the Node/Express Web. The Python Core stays on the Core
host (D6) and is not part of this image.

- **Image:** `web/Dockerfile`, built with `web/` as the context. Production
  dependencies only; application files are root-owned; the process runs as
  `node` (UID/GID 1000) and can write only `/var/lib/aegis-idea3/data`. Build
  with a digest-pinned `NODE_IMAGE` and record the image ID.
- **Compose overlay:** `deploy/docker-compose.pr11-phase2.yml`, copied
  unchanged to `/opt/aegis/runtime/idea3/idea3-phase2.yml` and appended as the
  fifth canonical Compose file. The network and HUB-membership stanzas are
  Kla-owned and need Kla's integration review.
- **Network:** `aegis_idea3_internal` (`172.31.243.0/29`, internal, not
  attachable). The HUB is `.2`, IDEA3 Web `.3`. No host port is published.
- **Proxied browser listener:** `AEGIS_WEB_TRUSTED_PROXY=172.31.243.2` and
  `AEGIS_BIND_HOST=172.31.243.3`. Only the pinned HUB may supply
  `X-Forwarded-For`/`X-Forwarded-Proto`. The Secure session cookie is issued
  only when the HUB forwards `X-Forwarded-Proto: https`, and it is scoped to
  `Path=/security`.
- **Secrets:** `SESSION_SECRET_FILE` and `AEGIS_IDEA3_ADMIN_PASSWORD_HASH_FILE`
  point at Compose file secrets. The host files
  `/opt/aegis/runtime/idea3/secrets/session-secret` and `admin-password-hash`
  must exist before start, be readable by UID 1000 only (for example owner
  `1000:1000`, mode `0400`), and never be printed. A missing or unreadable
  file fails closed at startup.
- **Sessions (D8):** an in-memory, bounded TTL store. A container restart logs
  the Admin out; no session state is written to disk.
- **Readiness:** `http://172.31.243.3:8003/security/api/readiness` is the
  container health check. `READY` requires the schema-v3 audit database on the
  `aegis_idea3_web_data` volume.
- **Dispatch:** disabled in Phase 2A. Phase 2B sets
  `AEGIS_IDEA3_DISPATCH_ENABLED=true`, which starts the machine listener on
  `172.31.243.3:8004`, only after the K9/K10 certificate evidence exists.

Rollback removes only the IDEA3 container and, after zero-endpoint proof, the
IDEA3 network. It preserves the data volume, never sends `RESTORE_UPLINK`, and
never runs `docker compose down`.

## Phase 4 Protocol v1 — repository prepared, not deployed

The repository contains Protocol v1 codecs, durable replay/sequence storage,
trusted-time enforcement, a TLS MQTT adapter, broker/AP policy templates, and
compile-verified firmware. These are repository evidence only. No broker,
network, certificate, credential, firmware, relay, or Production runtime was
changed, and every command below is **NOT RUN**.

Live rollout remains blocked until the AP interface/radio/regulatory settings,
subnet and addresses, broker hostname/SAN, Wi-Fi mode, device address model,
hardware security capabilities, resource limits, and relay-feedback evidence
are discovered and jointly reviewed. Provision a dedicated MQTT CA, broker leaf
certificate, distinct Core/device broker credentials, independent per-device
C2D/D2C keys, versioned firmware NVS, durable Core protocol storage under
`/var/lib/aegis-idea3/data`, and runtime credentials under
`/run/credentials/<unit>/` before any device use.

The separately authorized cutover order is: validate repository tests; validate
an isolated broker; stage and validate TLS listeners/ACLs; passively inspect the
board; provision keys/NVS; authenticate without actuation; disable the plaintext
listener; then require separate authorization for CUT and, under D4, separate
local authenticated confirmation and reason for RESTORE. Production never runs
v1 and legacy v0 simultaneously and has no fallback to v0.

Rollback preserves the protocol database, dispatch ledger, audit evidence,
keys/certificates needed to classify outcomes, and the last accepted device
sequence. It must not reopen plaintext MQTT, disable certificate validation,
replay a command, or issue RESTORE. If safety cannot be established, hold or
enter fail-secure CUT and classify the command outcome as unknown; recovery is a
separately authorized D4 operation.

### D4 Core-local RESTORE provisioning and use — not run

The repository now has an optional, local-only D4 channel. It stays disabled
unless `AEGIS_RESTORE_CREDENTIAL_FILE` names a valid private scrypt credential.
The example Core environment uses
`/etc/aegis-idea3/credentials/restore.credential`. The example service runs as
`User=aegis-idea3`, creates `/run/aegis-idea3` with mode `0700`, and makes
`/etc/aegis-idea3` read-only inside the unit. The socket refuses a runtime
directory that is not Core-owned or is group/world writable.

The commands in this subsection are a future operator procedure and were
**NOT RUN** by repository work. During a separately authorized maintenance
window, keep the service stopped, generate the hash through an interactive
terminal, and install it with the exact ownership/mode required by Core:

```bash
sudo systemctl stop aegis-idea3-core.service
sudo install -d -o aegis-idea3 -g aegis-idea3 -m 0700 /run/aegis-idea3-credential-staging
sudo -u aegis-idea3 /opt/aegis-idea3/current/aegisctl restore-credential \
  --output /run/aegis-idea3-credential-staging/restore.credential
sudo install -d -o root -g aegis-idea3 -m 0750 /etc/aegis-idea3/credentials
sudo install -o aegis-idea3 -g aegis-idea3 -m 0600 \
  /run/aegis-idea3-credential-staging/restore.credential \
  /etc/aegis-idea3/credentials/restore.credential
sudo rm /run/aegis-idea3-credential-staging/restore.credential
sudo rmdir /run/aegis-idea3-credential-staging
sudo systemctl start aegis-idea3-core.service
```

The credential command prompts twice and refuses non-interactive input,
short/mismatched secrets, symlinks, or an existing output. Never put either the
plaintext secret or generated hash in `core.env`, Git, shell history, logs, or a
task receipt. The persistent credential must be a regular mode-`0600` file owned
by `aegis-idea3`; its parent remains root-managed. Startup fails closed if the
configured file is missing, malformed, unsafe, or unreadable.

After an operator independently verifies that Core reports `LOCKDOWN`, the
future local invocation is:

```bash
sudo -u aegis-idea3 /opt/aegis-idea3/current/aegisctl restore \
  --reason "planned maintenance complete; local inspection recorded" \
  --wait 30
```

The command requires an interactive terminal, prompts for the operator secret,
and requires the exact confirmation `RESTORE UPLINK`. The printable reason is
bounded to 12–240 characters. `--wait` is bounded to 0–300 seconds; evidence
polling is read-only and never resends the command.

Exit codes are evidence-sensitive:

| Code | Meaning |
|---|---|
| `0` | With no wait, Core accepted and published once. With wait, the device reported correlated `NORMAL`. This is still not relay or physical proof. |
| `1` | The Core-local channel was unavailable. Before the first request this means nothing was sent; during evidence polling it does not change the prior outcome. |
| `2` | Local validation/refusal, authentication failure, disabled/dry-run authority, or another known pre-publication failure. |
| `3` | With wait, the device rejected the command, reported a contradictory/non-NORMAL state, or did not resolve before the deadline. RESTORE was not resent. |
| `4` | `OUTCOME_UNKNOWN`: the connection or handler crossed an uncertain boundary. Do not re-run or retry automatically; reconcile durable evidence first. |

The CLI prints requested, published, ACK, executed, relay-confirmation, and
physical-evidence rungs separately. Protocol ACK/STATUS never becomes physical
evidence. There is no Web, browser API, machine dispatch, Telegram, reconnect,
restart, certificate/time recovery, heartbeat, or shutdown/startup RESTORE path.
