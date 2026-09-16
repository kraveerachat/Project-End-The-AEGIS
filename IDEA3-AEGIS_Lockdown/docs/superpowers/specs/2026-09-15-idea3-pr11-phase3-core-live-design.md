# AEGIS IDEA3 PR11 Phase 3 Core Live Repository Preparation Design

> Status: **APPROVED FOR REPOSITORY-ONLY IMPLEMENTATION**
>
> Architecture gate: `ARCHITECTURE_GATE_P3_CORE_ONLY=APPROVED`
>
> Area / owner: `idea3` / `music`
>
> Branch: `feat/idea3-pr11-phase3-core-live`, created from `origin/main`
> `509723680207b6fb8cbbe409d19ac7ad7dd9cc8a`
>
> `PHASE3_RUNTIME_COMPLETE=NO`
>
> `PRODUCTION_MUTATION_AUTHORIZED=NO`
>
> `IDEA3_PRODUCTION_DEPLOYED=NO`

This design prepares an IDEA3-owned Core-only Linux service contract and its
local tests. It does not install a unit, create a user, change a host, contact
Production, issue a certificate, change networking, or perform CUT or RESTORE.

Companion plan:
`IDEA3-AEGIS_Lockdown/docs/superpowers/plans/2026-09-15-idea3-pr11-phase3-core-live.md`.

## 1. Authoritative starting state

```text
CURRENT_MAIN                    = 509723680207b6fb8cbbe409d19ac7ad7dd9cc8a
PR132                           = MERGED
PR132_MERGE_COMMIT              = 509723680207b6fb8cbbe409d19ac7ad7dd9cc8a
PHASE2_REPOSITORY_PREPARATION   = COMPLETE
PHASE2_RUNTIME_COMPLETE         = NO
K8_VLAN20_PATH                  = NOT_PROVEN
K9_MACHINE_SNI                  = idea3-core.aegis.internal
K9_DNS_CERT_EVIDENCE            = NOT_PROVEN
K10_DEDICATED_CLIENT_CA         = YES
K10_CERTIFICATE_ISSUANCE        = NOT_DONE
K10_EXPIRY_BEHAVIOR             = PAUSE_DISPATCH
D6_IDEA2_CORE_CORESIDENCE       = APPROVE in Music decision package
PUB_D6_REVIEW                   = NOT_RECORDED
K12_REBOOT_PERSISTENCE          = NOT_PROVEN
PRODUCTION_MUTATION_AUTHORIZED  = NO
```

Baseline at the unchanged base:

```text
ruff check aegis_soc tests --no-cache                  = PASS
python -m compileall -q aegis_soc tests                = PASS
/usr/bin/python3 -m pytest -p no:cacheprovider -q      = 8 failed, 326 passed, 6 skipped
```

The eight failures are all `tests/test_mqtt_client.py` under system
`paho-mqtt 1.6.1`, which lacks `CallbackAPIVersion`. Four additional
`test_windows_launcher.py` failures inside the restricted sandbox were caused
by denied loopback sockets and disappeared in the permitted rerun. The shell's
default PlatformIO `python` has no pytest; `/usr/bin/python3` is the baseline
interpreter.

## 2. Source-backed architecture decision

### Decision: dedicated Core-only systemd owner

The new Production service executes `aegis_soc.supervisor` directly with the
fixed arguments `--profile production --live --headless --no-detector
--no-voice`. The supervisor is the systemd main process. It does not spawn
IDEA3 Web, a GUI, or a detector.

PR132's container remains the sole Production Web owner. The historical
`aegis_soc.production_runtime` composite launcher remains unchanged for local
PR9 compatibility and is not referenced by the new unit.

### Why the historical composite cannot own Phase 3

Current source proves that:

- `ProductionRuntime` subclasses `LauncherRuntime`;
- `LauncherRuntime._start_children()` always starts `core` and `web`;
- composite readiness requires both child processes and Web schema readiness;
- `deploy/aegis-idea3.service.example` invokes the composite launcher and is
  explicitly described as “Core and Web.”

Using that unit after PR132 would create two competing Production Web owners.
A mode flag was rejected because one configuration error could re-enable the
second Web. Refactoring the composite was rejected because PR9 acceptance
drivers still use it and Phase 3 does not need to disturb that compatibility.

### Historical unit disposition

`deploy/aegis-idea3.service.example` is retained as a historical PR9 artifact.
It is not the Phase 3 installation candidate. The repository reference scan is
recorded before closeout; current operational references move to
`deploy/aegis-idea3-core.service.example`, while historical PR9 specs and plans
remain truthful history.

## 3. Core process and systemd model

The new example unit is a separate service named `aegis-idea3-core.service`.

- `Type=simple`; the supervisor stays in the foreground.
- `User=aegis-idea3`, `Group=aegis-idea3`, `UMask=0077`.
- `After=network-online.target` and `Wants=network-online.target` only.
- `WantedBy=multi-user.target`; no graphical, display, login-session, or
  desktop target.
- `Restart=on-failure`, `RestartSec=5`, bounded start rate.
- No `ExecStop`: systemd sends SIGTERM to the supervisor, whose existing
  shutdown path stops children/MQTT and deliberately sends no RESTORE.
- `KillMode=control-group` is retained as a containment boundary, but the Core
  service has no configured child GUI, detector, or Web process.
- No `Requires`, `PartOf`, `BindsTo`, restart propagation, or kill relationship
  with IDEA2, HUB, Web, Docker, or MQTT.
- `NoNewPrivileges`, `PrivateTmp`, `ProtectSystem=strict`, `ProtectHome`, and
  restrictive address-family/system-call/device policies harden the process.
- CPU, memory, and task accounting are enabled. `CPUQuota`, `MemoryMax`, and
  other Production quotas remain unset until owner-measured live evidence is
  available.

The unit is repository input only. It is not copied to `/etc/systemd/system`,
verified against a live Core, enabled, started, restarted, or stopped here.

## 4. Runtime path and ownership contract

```text
/opt/aegis-idea3/current
  immutable selected application release; not writable by aegis-idea3

/etc/aegis-idea3/core.env
  Core configuration; root-owned, readable by the service group only

/etc/aegis-idea3/pki/
  CA certificate, Core client certificate, and Core private key
  Core private key is generated on Core later and never leaves Core

/var/lib/aegis-idea3/
  durable service-owned root

/var/lib/aegis-idea3/data/core-audit.sqlite3
  durable hash-chained Core audit

/var/lib/aegis-idea3/data/core-dispatch.sqlite3
  the one accepted durable dispatch ledger

/run/aegis-idea3/
  ephemeral PID, lock, and status state only

/var/log/aegis-idea3/
  Core structured and text logs
```

The unit uses `StateDirectory=aegis-idea3`,
`RuntimeDirectory=aegis-idea3`, and `LogsDirectory=aegis-idea3`. It does not use
`DynamicUser`, because the long-lived identity must own durable data and Core
key access consistently across releases.

The environment contract pins:

```text
AEGIS_APPLICATION_ROOT=/opt/aegis-idea3/current
AEGIS_DATA_DIR=/var/lib/aegis-idea3
AEGIS_CONFIG_FILE=/etc/aegis-idea3/core.env
AEGIS_DB_PATH=/var/lib/aegis-idea3/data/core-audit.sqlite3
AEGIS_CORE_DISPATCH_DB_PATH=/var/lib/aegis-idea3/data/core-dispatch.sqlite3
AEGIS_RUNTIME_DIR=/run/aegis-idea3
AEGIS_RUNTIME_LOG_DIR=/var/log/aegis-idea3
AEGIS_LOG_PATH=/var/log/aegis-idea3/aegis_soc.log
AEGIS_CORE_DISPATCH_ENABLED=0
```

Tests instantiate the real settings/path resolution with this environment and
prove the dispatch ledger is below `/var/lib/aegis-idea3/data`, never below
`/run/aegis-idea3` or the application checkout.

## 5. Dispatch and transport behavior

The accepted PR10 durable model is unchanged:

```text
durable intent before claim
claim before publish
no redispatch after uncertain restart
OUTCOME_UNKNOWN when evidence is incomplete
outbox retained during server unavailability
no automatic retry of CUT
no RESTORE from the dispatch worker
action_id remains unique
Requested != Published != ACK != Executed != Relay Confirmation != Physical Evidence
```

Dispatch remains disabled unless `AEGIS_CORE_DISPATCH_ENABLED` is explicitly
enabled. Disabled startup constructs no worker and opens no dispatch route.

When enabled, the client accepts only an `https://` base URL. The default
`ssl.create_default_context(cafile=...)` keeps certificate verification and
hostname verification enabled, sets TLS 1.2 as the minimum, and loads the Core
certificate/key pair. There is no HTTP fallback and no browser authentication
fallback.

Missing credential paths pause before list/claim/publish. TLS verification,
certificate, and machine-identity failures are classified `CREDENTIAL`; the
worker exposes `PAUSED_CREDENTIAL` and performs no CUT. An exact regression
test supplies an expired-certificate `SSLCertVerificationError` through the
current transport boundary and proves the chain
`expired certificate -> CREDENTIAL -> PAUSED_CREDENTIAL -> zero claim/publish`.
Until that test passes, repository documentation must not claim the expiry
mapping as verified.

Network/server unavailability exposes `UNAVAILABLE`, retains the outbox, and
performs no new claim or CUT on the failed tick. Neither failure class triggers
RESTORE.

## 6. Status and evidence honesty

`RuntimeStatus` gains an allowlisted dispatch dimension:

```text
DISABLED | ACTIVE | PAUSED_CREDENTIAL | UNAVAILABLE | UNKNOWN
```

The supervisor refreshes it from the worker. If enabled dispatch is paused or
unavailable, the Core state is `DEGRADED`. Dispatch-disabled remains a normal
default and does not degrade the Core.

The safe status projection includes only the allowlisted value and a stable
issue code. It never exposes paths, certificate names, URLs, errors, secrets,
physical claims, or free text. `physicalEvidence` remains outside this status
projection and no dispatch state becomes “contained.”

## 7. Startup, restart, stop, and shutdown

- Startup runs preflight, initializes the Core audit, binds MQTT callbacks,
  recovers the dispatch ledger if enabled, and then enters the supervisor loop.
- No Web readiness probe exists in the Core service.
- A missing or invalid live MQTT configuration fails preflight as today.
- Dispatch-disabled startup does not require machine credentials.
- Enabled startup with missing credentials remains running but degraded/paused;
  it never issues CUT just to make readiness green.
- On worker recovery, `CLAIM_REQUESTED`, `CLAIMED`, `PUBLISHED`, and
  `ACK_RECEIVED` become `OUTCOME_UNKNOWN`; none is republished.
- SIGTERM requests normal supervisor shutdown. It does not issue RESTORE.
- `Restart=on-failure` restarts only IDEA3 Core. It does not restart IDEA2 or
  IDEA3 Web.

## 8. D6 IDEA2 co-residence and resource isolation

The Phase 3 unit:

- is separately named and owned;
- uses only IDEA3 writable directories, credentials, certificates, logs, and
  state;
- contains no IDEA2 unit name, path, credential, port, restart directive, or
  dependency;
- has no MQTT, firewall, routing, or access-point mutation for IDEA2;
- enables resource accounting without inventing live quotas.

Tests parse the systemd unit structurally and compare it with the accepted
IDEA2 service names (`aegis-detection-engine.service` and
`aegis-detection-tunnel.service`). They prove no cross-service dependency or
restart/kill chain. They do not inspect or modify IDEA2 files.

`PUB_D6_REVIEW=NOT_RECORDED` remains a live gate. Repository preparation does
not convert D6 to runtime PASS.

## 9. P3 contract matrix

| ID | Repository proof |
|---|---|
| P3-C1 | The new systemd service command owns only `aegis_soc.supervisor`; no Node/Web command or composite launcher |
| P3-C2 | Environment and worker construction keep dispatch disabled by default |
| P3-C3 | Missing credentials and exact expired-certificate TLS classification pause dispatch with zero CUT |
| P3-C4 | Reopened durable ledger converts unresolved state to `OUTCOME_UNKNOWN` and never republishes |
| P3-C5 | SIGTERM/shutdown and unit stop model issue no RESTORE |
| P3-C6 | Real path resolution keeps data/config/runtime/log roots external and the ledger outside `/run` |
| P3-C7 | Unit targets `multi-user.target` and fixed headless/no-detector/no-voice arguments |
| P3-C8 | Parsed unit has no IDEA2 dependency, restart, or kill relation; accounting is enabled and quotas unset |
| P3-C9 | HTTPS-only client and SSL context retain certificate and hostname verification |
| P3-C10 | Safe status reports `DEGRADED` / `PAUSED_CREDENTIAL` without physical-containment claims |

Tests exercise Python behavior and parse the unit as a systemd configuration.
They do not rely only on substring presence.

## 10. Read-only evidence package for the later live phase

The operations document prepares commands for the owner to run later. The
commands reveal no password, token, key content, or environment-secret value.
They cover:

- OS, kernel, and boot state;
- wired interface, VLAN20 address, routes, and source address;
- Wi-Fi/private-AP candidate state without changing it;
- existing IDEA2 and IDEA3 unit definitions/states;
- service-account existence and directory metadata;
- disk, memory, CPU, and process baselines;
- conflicting listener ports;
- candidate certificate file metadata and certificate dates only;
- resolution and HTTPS 443 reachability for `idea3-core.aegis.internal` when
  Phase 2 runtime exists.

Missing output remains NOT PROVEN. These commands are prepared but not run by
this task.

## 11. K8, K9, K10, K12, rollout, and rollback

- **K8:** expected path is wired VLAN20 -> HUB HTTPS 443. No route or network
  change is made; reachability remains NOT PROVEN. The private ESP32 AP must
  not forward or route general traffic.
- **K9:** SNI is `idea3-core.aegis.internal`; DNS and server-certificate
  evidence remain NOT PROVEN.
- **K10:** dedicated client CA remains required; nothing is issued. Kla keeps
  the CA key offline; the Core private key remains on Core. Expiry pauses
  dispatch only after P3-C3 proves the classification.

> **Forward reference (added 2026-09-16):** for future execution, the K10 CA key custody recorded here is superseded by `IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-09-16-idea3-pr11-k10-server-held-ca-amendment.md` (server-held dedicated client CA), **as accepted through authorized CODEOWNER review on PR #146**. This record is unchanged and remains accurate for its date.
- **K12:** reboot persistence remains NOT PROVEN; no reboot is authorized.

Future rollout is a separate owner-authorized change: collect read-only
evidence, create the service identity and roots, place a reviewed release and
configuration, place approved certificate material without revealing it,
verify the unit, then enable/start it. None of those actions occurs here.

Repository rollback is a human revert or non-merge of this PR. Future live
rollback stops/disables only `aegis-idea3-core.service` and preserves the
durable data and certificate roots. It never sends RESTORE and never restarts
or kills IDEA2 or Web.

## 12. Scope and stop rules

Owned implementation may touch only `IDEA3-AEGIS_Lockdown/**`, the two
Music-owned IDEA3 canonical notes, and one new Music receipt at final
repository-preparation closeout.

Forbidden here:

- any IDEA1 or IDEA2 file;
- `HUB-AEGIS_Entry/**`, `shared/**`, infrastructure canonical files, PR129
  history, or historical receipts;
- Production, Core-host, Docker, NGINX, firewall, VLAN, access-point, MQTT,
  firmware, certificate, systemd, CUT, RESTORE, or reboot mutation;
- agent approval on behalf of Kla or Pub;
- merge.

If a cross-owner file becomes necessary, stop that path and record
`INTEGRATION_CHANGE_REQUIRED=YES` with its path, owner, reason, proposed
contract, and reviewer.

## 13. Evidence state after repository preparation

Even after all local tests pass:

```text
PHASE3_REPOSITORY_PREPARATION = LOCAL_VERIFIED (subject to human review)
PHASE3_RUNTIME_COMPLETE       = NO
PRODUCTION_MUTATION_AUTHORIZED= NO
IDEA3_PRODUCTION_DEPLOYED     = NO
K8                             = NOT_PROVEN
K9_DNS_CERT_EVIDENCE           = NOT_PROVEN
K10_CERTIFICATE_ISSUANCE       = NOT_DONE
PUB_D6_REVIEW                  = NOT_RECORDED
K12                            = NOT_PROVEN
```
