# IDEA3 Production Runtime Operations

## Evidence and safety boundary

This runbook describes the PR9 server candidate. The example service has not
been installed or exercised in Production. Local acceptance uses loopback and a
disposable lab/headless/dry-run data root. It does not prove MQTT delivery,
ESP32 behavior, relay state, WAN isolation, IDEA1/IDEA2 availability, systemd
installation, or Production deployment.

The composite runtime owns Python Core first and Node/Express Web second. Stop
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

A live Core profile additionally requires reviewed MQTT host/port/credentials,
a non-demo `AEGIS_HMAC_SECRET`, and a non-default `AEGIS_ADMIN_PIN`. Keep
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
  only when the schema-v2 audit repository probe succeeds; audit failure returns
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
