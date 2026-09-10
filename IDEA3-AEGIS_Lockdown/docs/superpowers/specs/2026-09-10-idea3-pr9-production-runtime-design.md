# IDEA3 PR9 Production Runtime Design

## Status and evidence boundary

This design covers only the PR9 work that is safe before the open PR5 hardware
task merges. It is based on `origin/main` at
`50ce6e1638c6bcdb2a378a3cee660050b9cb41d8`.

```text
AREA = idea3
OWNER = music
BRANCH = feat/idea3-production-runtime-pr9
PRODUCTION_MUTATION_ALLOWED = NO
PR5_DEPENDENCY = OPEN / WAITING FOR MERGE
FINAL_PR9_ACCEPTANCE = NOT RUN
FINAL_PR9_RECEIPT = NOT CREATED
```

All runtime acceptance in this phase uses disposable paths, loopback listeners,
test credentials, intentionally absent or injected dependencies, and no real
broker, device, relay, network, database, or Production service.

## Source-of-truth conflict discovered at preflight

The execution prompt describes PR8 as merged and closed with final Windows
acceptance. Current Git proves only the following narrower statement:

- GitHub PR #107 is merged through `f320bbf55456450406fe0c5547848fbdce099a96`.
- `25fb442d15cdf2037817c9e63add4d7e96bcd568` is reachable from current `main`.
- That checkpoint records a Windows build and a 25/25 smoke against the staging
  bundle at `c7cdc2b2b6f26907fca3203fe5cd12585a4ecea25f09e4`, not an
  extracted-ZIP smoke and not a final-SHA Windows rerun.
- The immutable PR8 receipt remains `partial`, and the canonical status/handoff
  still say acceptance pending.

Current Git and recorded evidence therefore win: PR8 source is a valid PR9
baseline, but PR8 final extracted-ZIP acceptance is not promoted. PR9 does not rewrite
the historical receipt and does not attempt Windows acceptance.

## PR5 read-only dependency state

The fetched remote ref `origin/fix/idea3-final-hardware-closure` resolves to
`3f07f80c996b9b9db3b428adf469f56e85c904f6`, which is already an ancestor of
current `main` and contains no unmerged diff. No newer PR5 hardware commit is
present in fetched Git refs. The owner-supplied execution prompt is therefore the
authority that PR5 remains open; no hardware truth is imported into PR9.

## PR9 audit matrix

| Area | Existing implementation | Existing tests | Existing docs | Gap for PR9 | Action |
|---|---|---|---|---|---|
| Core process lifecycle | `aegis_soc.supervisor` plus Core-only `aegisctl` | supervisor, CLI, lock and failure tests | root README and legacy service example | no server owner for Core plus Web | add a Linux/server composite service entry point reusing the PR8 lifecycle owner |
| Web process lifecycle | `startServer()` and signal shutdown | production runtime tests | Web README, Windows README | not owned by the Linux service | run as the composite service's second child and stop before Core |
| Production Web serving | Express serves built assets under `/security` | static/API/cache/shutdown tests | Web and Windows READMEs | no Linux/server launch contract | validate explicit source layout and built asset path |
| SQLite path/persistence | Core DB and Web schema-v2 DB support external paths | fresh/v1 migration/reopen/ordering tests | PR6/PR7/PR8 docs | direct production Web accepts a relative audit path | require an absolute production audit path; composite service supplies it |
| Config parsing/validation | Core preflight and Web production secret/hash checks | Python and Web config suites | `.env.example` | malformed production numeric values silently default | reject malformed production numeric configuration explicitly |
| Runtime status file | atomic Core status plus PR8 launcher status | path/runtime/launcher tests | PR8 docs | launcher state can be stale and does not separate health/readiness | add timestamped process-health and service-readiness projection |
| Logging | rotating Core JSONL/log plus component log | Core tests | root README | service account/layout and server log location not canonical | bind all logs to external data root and document permissions |
| MQTT configuration | blank broker is optional in dry-run; live mode fails closed | config/MQTT/runtime tests | `.env.example` | operational state matrix not assembled at service boundary | report `NOT_CONFIGURED` or `UNAVAILABLE`; never claim publication |
| IDEA1 adapter | bounded read-only tokenized adapter | integration adapter/provider tests | PR7 docs | real upstream feed absent | preserve optional `NOT_CONFIGURED`; negative-test no false incident |
| IDEA2 adapter | bounded read-only tokenized adapter | integration adapter/provider tests | PR7 docs | real upstream feed absent | preserve optional `NOT_CONFIGURED`; negative-test malformed/unavailable behavior |
| Health endpoint | Web `/security/api/health` liveness | production runtime test | PR8 docs | liveness does not prove audit readiness | retain liveness and add `/security/api/readiness` |
| Readiness semantics | Core safe projection and Web snapshot states | normalization/provider tests | PR7/PR8 docs | no explicit local Web/audit readiness endpoint | return `READY` only when schema-v2 audit access succeeds |
| Startup dependencies | PR8 starts Core then Web | launcher tests | Windows README | Linux/server payload and path validation absent | validate before spawn; fail closed and clean partial starts |
| Shutdown behavior | PR8 stops Web then Core; Core never auto-RESTOREs | launcher/supervisor tests | PR8 docs | Linux server does not use this lifecycle | reuse and regression-test the same order |
| Restart behavior | Windows launcher is restartable; Core CLI has restart | tests | Windows/root README | no Linux service restart contract | explicit CLI restart plus systemd `Restart=on-failure` |
| Crash handling | child state becomes degraded | launcher tests | limited | composite launcher does not exit on child death | fail the service, clean the peer child, let service manager restart |
| Service account/file permissions | hardening directives in a Core-only example | source assertions only | service example | no dedicated account or external writable root contract | update example for `aegis-idea3`, umask 0077, and one external root |
| Docker/Compose/systemd assets | one Core-only systemd example; no IDEA3 Compose | repository search | root README | example conflicts with Core+Web topology | keep systemd, do not add Docker/Compose |
| Production runbook | Windows-only operations plus scattered Linux notes | none | READMEs | no server runbook | add `docs/operations/production-runtime.md` |
| Rollback documentation | Windows payload rollback | none | Windows README | no Linux/server rollback boundary | stop, preserve data, switch immutable payload, start, verify |
| Backup instructions | Web/Windows stop-before-copy guidance | DB reopen tests | READMEs | no unified server procedure | document stopped-service copy of the whole external data root |

## Runtime component inventory

| Component | Entry point | Process/static | Dependency | Config | Writable data | Startup owner |
|---|---|---|---|---|---|---|
| Production service owner | `python -m aegis_soc.production_runtime start` | process | Python, Node, built assets | external `.env` and CLI flags | service status, control token, component log | systemd/operator |
| Python Core | `python -m aegis_soc.supervisor` | continuous process | SQLite; MQTT only for live actuation | Core `AEGIS_*` values | Core DB, status, JSONL/logs | production service owner |
| Core CLI/runtime supervisor | `aegis_soc.supervisor` | continuous process | child detector only when explicitly enabled | profile and runtime flags | PID/lock/status/logs | production service owner |
| Node/Express backend | `node web/server/index.js` | continuous process | SQLite and static assets | production Web `AEGIS_*` values | schema-v2 Web audit DB | production service owner |
| React/Vite assets | `web/dist` | static | successful `npm run build` | `/security` base | none | Express |
| SQLite audit stores | Core and Web database paths | persistent files | writable data directory | absolute external paths | DB plus WAL/SHM | owning process |
| Runtime state | `runtime/status.json` and `runtime/service-status.json` | ephemeral state | external runtime directory | derived from `AEGIS_DATA_DIR` | replaceable JSON/token/locks | Core/service owner |
| Logs | external `logs/` | persistent operational files | writable data directory | derived paths | rotating Core and component logs | Core/service owner |
| MQTT | Core `MQTTManager` | optional/live dependency | configured broker and credentials | broker/HMAC variables | no local durable truth | Python Core only |
| IDEA1 adapter | `idea1Adapter.js` | optional read-only client | reviewed feed and token | URL/token | no durable upstream mirror | Web backend |
| IDEA2 adapter | `idea2Adapter.js` | optional read-only client | reviewed feed and token | URL/token | no durable upstream mirror | Web backend |
| Windows standalone | `AEGIS-IDEA3.exe` | separate packaged runtime | bundled Python/Node/assets | Windows external `.env` | Windows external data root | PR8 launcher |
| Linux deployment definition | `deploy/aegis-idea3.service.example` | static unit | installed payload and service account | EnvironmentFile | no in-repo state | systemd after operator install |

Continuous processes are the service owner, Core, and Web. React assets are
static. Audit databases and logs persist. Runtime status, tokens, PID, and lock
files are operational state, not durable audit evidence. MQTT and IDEA1/IDEA2
may be absent only in an explicitly dry-run safe profile; live production Core
startup fails closed without required actuation configuration.

The Python Core remains the only physical-command authority. Web has no MQTT,
ESP32, relay, CUT, or RESTORE path. Shutdown ownership belongs to the composite
service, and its order is Web then Core. Shutdown, restart, and rollback never
send RESTORE.

## Selected topology

```text
systemd or foreground operator
└── IDEA3 production service owner
    ├── Python Core supervisor
    │   ├── external Core SQLite
    │   ├── atomic Core status
    │   └── optional MQTT/device path (Core only)
    ├── Node/Express Security Center
    │   ├── static React build
    │   ├── external schema-v2 audit SQLite
    │   └── optional read-only IDEA1/IDEA2 adapters
    └── external runtime/log directories
```

Docker Compose is not introduced. The repository already carries a hardened
systemd direction, and a single service owner provides deterministic ordering
without creating a second inter-process orchestration technology.

## Lifecycle contract

1. Validate loopback bind, distinct ports, immutable payload files, absolute
   external data/config/database paths, required production Web secrets, and
   selected Core profile before starting children.
2. Create the external data tree with owner-only defaults and acquire the
   single-instance lock.
3. Start the control boundary, then Core, then Web.
4. Report process health independently from Web/audit readiness and dependency
   evidence.
5. A duplicate start exits non-zero and leaves the running instance untouched.
6. A child spawn failure or later child exit marks the service failed, stops the
   surviving child, removes the control token, and exits non-zero.
7. Stop is idempotent and travels through the loopback token boundary. Shutdown
   order is Web then Core. Forced termination is only the bounded child-cleanup
   fallback; it never invokes a physical command.
8. Restart is stop, bounded wait for the prior instance to leave, then a fresh
   start. Under systemd, unexpected failure is restarted by `Restart=on-failure`.

## Health, readiness, and physical truth

| Dimension | States | Meaning |
|---|---|---|
| Service owner/process health | `HEALTHY`, `DEGRADED`, `FAILED`, `STOPPED` | only whether owned processes are alive |
| Web readiness | `READY`, `UNAVAILABLE` | Express is listening and schema-v2 audit access succeeds |
| Audit DB | `READY`, `DEGRADED` | schema/read probe succeeds or fails |
| MQTT | `CONNECTED`, `UNAVAILABLE`, `NOT_CONFIGURED` | transport/config state; never physical proof |
| IDEA1/IDEA2 | canonical existing `HEALTHY`/`UNKNOWN`/`NOT_CONFIGURED` plus freshness | reviewed evidence state only |
| ESP32 | `ONLINE`, `OFFLINE`, `UNKNOWN`, `NOT_CONFIGURED` as supported by current source | device evidence only |
| Relay physical | `CONFIRMED`, `UNKNOWN` | command-correlated physical evidence boundary |

`/security/api/health` remains a cheap process-liveness route. The new
`/security/api/readiness` probes the repository schema and returns HTTP 200
`READY` or HTTP 503 `DEGRADED`. A successful listener, HTTP request, command
publication, or ACK never becomes physical evidence. Missing or stale evidence
never becomes healthy.

## Configuration and path contract

Production Web requires the existing secret and bcrypt policies, a loopback
bind, an absolute static directory, and an absolute Web audit database path.
Malformed explicitly supplied numeric values fail startup in production instead
of silently falling back. The service requires an absolute `AEGIS_DATA_DIR`
outside the immutable application root; it derives configuration, both SQLite
files, logs, and runtime state beneath that root. Paths containing spaces are
supported because all commands are argument arrays, never shell strings.

Optional integration URL/token pairs remain blank until provisioned. Blank
integration config maps to `NOT_CONFIGURED`. Live Core requires a configured
broker, non-demo HMAC secret, and non-default Admin PIN. The isolated acceptance
profile is lab/headless/dry-run; it is startable with MQTT absent, reports
`NOT_CONFIGURED`, publishes nothing, and claims no physical success.

No secret value is written to Git, logs, status JSON, HTTP responses, or the
runbook. The existing generated external configuration boundary is reused; PR9
does not add a new secret format.

## Persistence, backup, and rollback

Application code and static assets are immutable. Configuration, Core SQLite,
Web SQLite, logs, runtime state, and temporary files have distinct subpaths under
the external root. Permission errors are startup failures. Database migration and
reopen use disposable schema-v1/v2 fixtures and never Production data.

Backup occurs only after stop and copies the whole external data root, including
SQLite WAL/SHM companions. Restore occurs while stopped, then doctor/start and
readiness/audit verification run. Code rollback preserves the external root and
switches only the immutable application payload. Runtime status is replaceable
and cannot be used as durable audit evidence.

## Test strategy

- Python RED/GREEN tests: production layout validation, paths with spaces,
  duplicate start, partial start cleanup, child failure, shutdown order,
  idempotent stop, restart contract, status freshness, and no RESTORE imports.
- Web RED/GREEN tests: strict production numerics/absolute DB path and separate
  liveness/readiness with a forced audit probe failure.
- Existing negative suites: absent/unavailable MQTT, IDEA1/IDEA2, stale and
  malformed evidence, unavailable audit persistence, invalid production auth.
- Existing schema-v2 acceptance: fresh init, v1 migration, reopen/restart,
  ordered bounded reads, unavailable paths, migration failure, and secret scan.
- Isolated acceptance: fresh data directory, generated test bcrypt/session
  values, production Web plus dry-run Core, login, snapshot, durable audit,
  stop/restart, unavailable dependencies, logout, clean stop, and residue check.

## Work gated on PR5 merge

The following are not executed in this phase: merge current `origin/main` after
PR5, reconcile hardware/reset/relay/CUT/RESTORE status fields, rerun the final
full gate on that merged tree, create the immutable PR9 receipt, mark the Draft
ready, deploy, perform Kali E2E, mutate Production, or claim PR9/IDEA3 complete.
