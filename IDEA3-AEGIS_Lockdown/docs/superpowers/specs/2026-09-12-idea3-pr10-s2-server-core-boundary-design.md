# IDEA3 PR10 S2 Server → Core Accepted-Action Boundary Design

## Status and evidence boundary

This design covers PR10 session S2. S2 is repository-only and
non-Production: it adds the durable, authenticated Server → Core
accepted-action boundary to IDEA3 source and tests. It covers inventory §13.3,
decision D7, and the IDEA3 side of decision D5.

The design is based on `origin/main` at
`b2f61ebf361a5e22f00d28e7e99dcbf3ce006d95`, the merge of GitHub PR #122. It
continues from these records:

- **PR #120:** the premature human merge of the S1 documentation checkpoint
  (`93170862cbf5b5a802042d12c84944abd39d9123`).
- **The S1 inventory:**
  `IDEA3-AEGIS_Lockdown/docs/operations/PR10_DEPLOYMENT_INVENTORY.md`, §13.3,
  §14, and §15A.
- **PR #121:** the post-merge workflow reconciliation.
- **PR #122:** the S1 closeout. It recorded D1–D8, the live inventory, and the
  K1–K12 package approved for architecture/integration only.

```text
AREA = idea3
OWNER = music
TASK = IDEA3 PR10 S2 — Server → Core durable accepted-action machine boundary (repository-only, non-Production)
BRANCH = feat/idea3-pr10-s2-server-core-boundary
BASE = b2f61ebf361a5e22f00d28e7e99dcbf3ce006d95
PRODUCTION_MUTATION_ALLOWED = NO
PRODUCTION_CHANGE_AUTHORIZED = NONE
G1 = AWAITING OWNER REVIEW (this design and the TDD plan; no source changed)
EVIDENCE_CLASS = LOCAL / SIMULATED ONLY
```

**Evidence environment.** All S2 evidence uses only:

- disposable paths, and in-memory or temporary SQLite files;
- loopback listeners;
- injected clocks;
- fake HTTP transports, fake MQTT managers, and dry-run controllers.

**Not used:** no real broker, ESP32, relay, HUB, NGINX, certificate, CA,
network path, or Production service. Nothing here authorizes or performs a
Production change.

## 1. Scope

**Web (`IDEA3-AEGIS_Lockdown/web/server`)**

- **A1** — additive SQLite schema v3.
- **A2** — Admin acceptance mints one immutable `action_id`, with a 120 s TTL.
- **A3** — machine endpoints: list, claim, and report.
- **A4** — machine identity check.
- **A5** — dispatch status display.
- **A6** — append-only reconciliation ingest.

**Core (`IDEA3-AEGIS_Lockdown/aegis_soc`)**

- **B1** — durable dispatch ledger.
- **B2** — dispatch client.
- **B3** — claim → publish through the single command owner.
- **B4** — reconciliation outbox.
- **B5** — credential pause.

**Out of scope:**

- **Other decisions:**
  - D8 session store;
  - D3 container, Dockerfile, browser trusted-proxy mode, and the K2 Helmet
    header enumeration;
  - D4 `aegisctl restore` CLI;
  - D1/D2 access point, broker TLS/ACL, and ESP32 signing;
  - D6 host work.
- **Runtime and edge files:** Core-only systemd owner or unit; Compose
  overlays; NGINX files; the Production bind address, network attachment, and
  HUB wiring of the machine listener (K4/K5/K7, D3).
- **Integration:** PR11 feeds; any IDEA1, IDEA2, HUB, shared, or
  infrastructure file.
- **Production and hardware:** every Production, hardware, certificate,
  network, or firewall action.

## 2. Source facts at `b2f61ebf`

These facts were PROVEN by reading source at `b2f61ebf`.

| Area | Fact | Location |
|---|---|---|
| Web schema | `SCHEMA_VERSION = 2`; `MIGRATABLE_VERSIONS = {1}`; the migration runs inside the opening `BEGIN IMMEDIATE` transaction | `web/server/repositories/sqliteRepository.js` |
| Web decisions | `containment_decisions` is keyed by `incident_id`. A repeated identical decision is `UNCHANGED`; the opposite decision is `CONFLICT` | same |
| Web readiness | readiness fails unless `schemaVersion === 2` | `web/server/createApp.js` |
| Web proxying | `trust proxy` is false; one session middleware covers every route; the bind host must be loopback | `createApp.js`, `config.js` |
| Acceptance route | requires Admin, same-origin, and CSRF. It refuses Demo Mode, writes one decision, and returns all five `containmentBoundary()` fields as false | `web/server/routes/securityRoutes.js`, `web/server/domain/containment.js` |
| Repository parity | the memory repository mirrors the SQLite containment contract | `web/server/repositories/memoryRepository.js` |
| Incident display | live incidents carry `responseState: 'NOT_REQUESTED'`. The dashboard treats any `responseState` containing `ACK` as acknowledged | `web/server/domain/correlate.js`, `web/src/pages/DashboardPage.jsx` |
| Core command owner | `AegisSupervisor.issue_command` wraps `AegisCommandController.issue`. RESTORE without `authorize_restore` is rejected. Dry-run returns `sent=False` with a nonce. An unavailable MQTT client returns `sent=False` | `aegis_soc/supervisor.py`, `aegis_soc/controller.py` |
| Core pending state | `pending_command` is a single in-memory slot. ACK and STATUS are correlated by nonce; `ACK_TIMEOUT_SEC = 8` and `PHYSICAL_CONFIRM_TIMEOUT_SEC = 8` | `supervisor.py`, `aegis_soc/config.py` |
| Core shutdown | no shutdown path publishes `RESTORE_UPLINK` | `supervisor.py` |
| Core data | `RuntimePaths` places `core-audit.sqlite3` and `security-center-audit.sqlite3` under the external data root; the Core audit log is hash-chained | `aegis_soc/paths.py`, `aegis_soc/database.py` |
| Cross-host channel | none exists | inventory §13.3 (PROVEN) |

## 3. Lifecycle and ownership

```text
Server-owned (Web SQLite v3)                       Core-owned (Core dispatch ledger)
CONTAINMENT_ACCEPTED (existing decision row)
  └─► PENDING_DISPATCH  (action_id minted, expires_at = accepted_at + 120 s)
        ├─► EXPIRED     (never claimable, never listed)
        └─► CORE_CLAIMED (atomic, single-shot) ───►  CLAIM_REQUESTED → CLAIMED
                                                         ├─► EXPIRED_AT_CORE (re-check on Core clock)
                                                         ├─► DRY_RUN_ONLY | FAILED
                                                         └─► PUBLISHED → ACK_RECEIVED → STATUS_CORRELATED
                                                     any unresolved stage ─► OUTCOME_UNKNOWN (human review)
Server mirror: dispatch_evidence (append-only) ◄── Core → server reconciliation, idempotent by (action_id, sequence)
```

**Ownership rules:**

- **Server side:** the server owns only Candidate → Admin Accepted → Pending
  Dispatch → Claimed/Expired.
- **Core side:** every post-claim stage is owned by the Core. The server
  mirrors those stages; it never infers them.
- **Evidence classes:** relay evidence and physical network evidence remain
  separate classes. S2 records neither.

`containmentBoundary()` mapping:

| Field | S2 rule |
|---|---|
| `command_requested` | true only once a `PENDING_DISPATCH` row exists (dispatch enabled) |
| `command_published` | true only after the Core reports `PUBLISHED`. A `DRY_RUN` report keeps it false |
| `acknowledged` | true only after the Core reports an `ACK` stage (OK) |
| `executed` | stays **false** in S2; a correlated STATUS is shown as its own stage |
| `physical_evidence` | stays **false** in S2 |

When dispatch is disabled (the default), acceptance behaves exactly as today:
no action is minted and every field stays false.

## 4. Web design

### 4.1 Schema v3 (additive)

```sql
CREATE TABLE IF NOT EXISTS dispatch_actions (
  action_id   TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL UNIQUE REFERENCES containment_decisions(incident_id),
  action      TEXT NOT NULL CHECK (action = 'CUT_UPLINK'),
  state       TEXT NOT NULL CHECK (state IN ('PENDING_DISPATCH', 'CORE_CLAIMED', 'EXPIRED')),
  accepted_at TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  claimed_at  TEXT,
  claimed_by  TEXT,
  audit_id    INTEGER NOT NULL REFERENCES audit_log(id)
);
CREATE TABLE IF NOT EXISTS dispatch_evidence (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  action_id   TEXT NOT NULL REFERENCES dispatch_actions(action_id),
  sequence    INTEGER NOT NULL CHECK (sequence BETWEEN 1 AND 1000),
  stage       TEXT NOT NULL CHECK (stage IN ('PUBLISHED', 'DRY_RUN', 'ACK', 'STATUS',
                                             'OUTCOME_UNKNOWN', 'EXPIRED_AT_CORE', 'FAILED')),
  observed_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  UNIQUE (action_id, sequence)
);
```

- **Migration:**
  - `SCHEMA_VERSION = 3` and `MIGRATABLE_VERSIONS = {1, 2}`.
  - The tables are created with `IF NOT EXISTS`, and the version is bumped in
    the existing opening transaction.
  - v1 and v2 tables and rows are untouched.
  - An unknown version fails closed, as today.
- **Readiness:** requires `schemaVersion === 3`.
- **Uniqueness:** `incident_id UNIQUE` enforces one dispatch per accepted
  decision.
- **Stored values:** `action_id` is a server-minted `crypto.randomUUID()`
  value. It is distinct from the incident ID and from any firmware nonce, and
  the nonce is never sent to or stored on the server. `claimed_by` stores the
  verified machine subject, never a network address.

### 4.2 Minting at Admin acceptance

When dispatch is enabled and the decision is `ACCEPT`, the repository mints the
action in the **same transaction** as the containment decision and its audit
row, then returns it.

- **Atomicity:** if either insert fails, both roll back.
- **Not minted** for:
  - a `REJECT` decision;
  - a repeated `UNCHANGED` acceptance (which returns the existing action);
  - a `CONFLICT` (409, nothing written);
  - Demo Mode (refused, as today).
- **Action type:** only `CUT_UPLINK` can be minted, enforced by a domain check
  and the table `CHECK`.
- **Response:** the acceptance response adds
  `dispatch: { action_id, state: 'PENDING_DISPATCH', expires_at }`.

### 4.3 Expiry

- **TTL:** fixed by D7 at 120 000 ms from acceptance. It is a domain constant,
  not configurable.
- **When rows expire:** every list and claim first moves unexpired-past-due
  `PENDING_DISPATCH` rows to `EXPIRED` in the same transaction, with one audit
  row each. An `EXPIRED` row is never listed and never claimable.
- **Restart:** pending rows survive a server restart until they expire.

### 4.4 Machine listener and route contract

The machine API runs as a **separate Express app on a separate listener port
inside the IDEA3 Web application** (in Production, inside the IDEA3
container), not on the browser app. It is started only when dispatch is
enabled.

**Topology (D5, K5).** The separate listener isolates machine code inside the
application. It does not change the approved network topology:

- **No new host-published port.** `AEGIS_IDEA3_DISPATCH_PORT` is an
  application/container-internal listener port. It must never appear in a host
  port mapping, a Compose `ports:` entry, or a firewall rule.
- **Reachable only through the HUB.** In the later Production topology, the
  machine listener is reachable only from the HUB container, over the
  dedicated HUB↔IDEA3 internal Docker network. Under K5 that network is
  `internal: true`, not attachable, and has only the HUB and IDEA3 Web as
  members.
- **One external entry.** HUB/NGINX remains the only external/server entry
  point, on HTTPS 443 (D5, K8). The Core reaches the machine route only through
  the HUB's machine SNI block (K9).
- **Production bind.** The Production machine listener must bind to an
  address the HUB container can reach on that internal network. It must not be
  bound only to `127.0.0.1` inside the IDEA3 container, because the HUB
  container could not reach it there.
- **Wiring deferred.** The exact Production bind address, network attachment,
  and HUB upstream wiring are deferred to the separately authorized K4/K5/K7
  Production work, together with the D3 container work. S2 changes no Compose,
  Docker, network, or NGINX file.
- **Local tests are not the Production topology.** S2 tests bind both
  listeners to loopback and use a loopback address as the trusted-peer
  placeholder. These are local fixtures only. They are not evidence about the
  Production topology and must not be mistaken for it.

- **Browser app isolation:** the browser app never mounts machine routes, and
  the machine app mounts no session, auth, CSRF, static, or Admin routes.
- **Why a separate listener:** a request arriving through the browser
  `/security/` block cannot reach machine code, whatever its path case or
  headers.
- **Shared state:** `web/server/index.js` creates one repository and one
  in-memory machine-contact tracker and passes them to both apps.

Machine app properties:

- **Middleware:**
  - `trust proxy` stays false;
  - Helmet defaults;
  - `Cache-Control: no-store`;
  - JSON body limit 8 KB, strict;
  - zod `.strict()` schemas.
- **Path prefix:** `${AEGIS_WEB_BASE_PATH}/api/machine/v1`; in production this
  is `/security/api/machine/v1`. Matching is exact-case: any other casing
  returns 404.

| Method and path | Success | Failures |
|---|---|---|
| `GET …/dispatch/pending` | 200 `{ actions: [{ actionId, action, acceptedAt, expiresAt }] }`: unexpired `PENDING_DISPATCH` only, oldest first, at most 10 | 403 identity |
| `POST …/dispatch/:actionId/claim` (body `{}`) | 200 `{ actionId, action, state: 'CORE_CLAIMED', claimedAt, expiresAt }` | 400 invalid ID, 403 identity, 404 `ACTION_NOT_FOUND`, 409 `ACTION_ALREADY_CLAIMED`, 410 `ACTION_EXPIRED` |
| `POST …/dispatch/:actionId/evidence` | 201 `RECORDED`, or 200 `UNCHANGED` for an identical replay | 400 invalid, 403 identity, 404 unknown action, 409 `ACTION_NOT_CLAIMED`, 409 `EVIDENCE_CONFLICT` |

Any other path or method returns 404.

### 4.5 Machine identity (IDEA3 side of D5, K9)

A machine request is accepted only when **all** of these hold:

1. **No `Cookie` header and no `Origin` header.** A browser credential or
   browser-originated request is never accepted.
2. **Trusted peer.** `req.socket.remoteAddress`, normalized from
   `::ffff:`-mapped form, equals the configured pinned HUB address (K4).
   Forwarded headers are never consulted.
3. **Verified client certificate.** `X-AEGIS-Client-Verify` is exactly
   `SUCCESS`.
4. **Expected subject.** `X-AEGIS-Client-DN` is parsed as an RFC 2253 subject.
   It must contain exactly one `CN` equal to the configured expected subject.
   A DN with escapes (`\`), multi-valued RDNs (`+`), or a duplicate `CN` is
   rejected.

**On failure:** the response is 403 `MACHINE_IDENTITY_INVALID`, and no durable
state changes. Rejections are not written to the audit log per request, which
prevents an unauthenticated audit flood; the HUB edge log is the record of
rejected TLS attempts. **On success:** the in-memory machine-contact timestamp
is updated.

### 4.6 Claim

The claim runs inside `BEGIN IMMEDIATE`:

1. Expire past-due rows (§4.3).
2. Run
   `UPDATE dispatch_actions SET state = 'CORE_CLAIMED', claimed_at = ?, claimed_by = ? WHERE action_id = ? AND state = 'PENDING_DISPATCH' AND expires_at > ?`.
3. If exactly one row changed, write one audit row and return 200.
4. Otherwise return:
   - 404 if the row is absent;
   - 410 if the row is `EXPIRED`;
   - 409 if the row is `CORE_CLAIMED`.

A replayed claim, even from the same subject, returns 409. The Core's own
ledger guarantees it never republishes (§5.2).

### 4.7 Evidence ingest (Core → server reconciliation)

**Body:**

```text
{ sequence: 1..1000,
  stage: PUBLISHED | DRY_RUN | ACK | STATUS | OUTCOME_UNKNOWN | EXPIRED_AT_CORE | FAILED,
  observedAt: <ISO-8601>,
  detail }
```

**`detail` allowlist**, stable codes only:

- `ackCode` ∈ {`OK`};
- `deviceState` ∈ {`NORMAL`, `LOCKDOWN`};
- `reasonCode` matching `^[A-Z][A-Z0-9_]{0,63}$`.

**Ingest rules:**

- **Precondition:** the action must be `CORE_CLAIMED`.
- **Append-only:** rows are never updated or deleted.
- **Idempotent by `(action_id, sequence)`:** an identical replay returns
  `UNCHANGED`; a different body for the same sequence returns 409.
- **No promotion:** evidence never promotes one class into another. An ACK
  never implies STATUS, relay, or physical evidence.

### 4.8 Display

`repository.apply(snapshot)` overlays each incident that has a dispatch action.
It sets `responseState` using this precedence:

```text
FAILED | OUTCOME_UNKNOWN | EXPIRED | EXPIRED_AT_CORE        (terminal)
  > STATUS_CORRELATED > ACK_RECEIVED > PUBLISHED | DRY_RUN_ONLY
  > CORE_CLAIMED
  > DISPATCH_PENDING, or DISPATCH_UNAVAILABLE when no authenticated machine
    contact has occurred within the last 120 s (always the case just after a
    server restart)
```

- **Never "Contained":** no stage, label, or combination produces a
  "Contained" state.
- **Human review:** `OUTCOME_UNKNOWN` is labelled as requiring human review.
- **UI files, only if W13 requires them:** W13 may show that the current
  substring match mislabels a dispatch state; for example,
  `STATUS_CORRELATED` contains no `ACK` substring. In that case the dashboard's
  acknowledgement label changes to an explicit allowlist (`ACK_RECEIVED`,
  `STATUS_CORRELATED`), and i18n labels are added for the new states.

### 4.9 Web configuration

| Key | Default | Rule |
|---|---|---|
| `AEGIS_IDEA3_DISPATCH_ENABLED` | `false` | only `true` or `false`; any other value throws |
| `AEGIS_IDEA3_DISPATCH_PORT` | — | required when enabled; a positive integer different from `PORT`. An application/container-internal listener port, never host-published (§4.4) |
| `AEGIS_IDEA3_DISPATCH_TRUSTED_PROXY` | — | required when enabled; one IP literal (`net.isIP`) |
| `AEGIS_IDEA3_DISPATCH_EXPECTED_SUBJECT` | — | required when enabled; `^[a-z0-9][a-z0-9-]{0,62}$` |

- **Bind host in S2:** S2 does not change the bind-host rule. Both listeners
  use the existing validated `AEGIS_BIND_HOST`, which is loopback-only; this is
  the local and test configuration.
- **Production bind (deferred):** serving a real HUB peer requires the IDEA3
  listeners to bind to the container's address on the dedicated internal
  network, not to container loopback (§4.4). Changing the bind-host rule
  belongs to the separately authorized D3 and K4/K5/K7 work, not to S2.
- **`.env.example`:** gains these keys empty or `false`, with comments. Real
  values are never committed.

### 4.10 Repository parity and audit

The memory repository implements the same dispatch functions and results, and
the existing interface-parity test is extended. Audit rows use:

- category `DISPATCH`;
- actions `ACTION_MINTED`, `ACTION_CLAIMED`, `ACTION_EXPIRED`, and
  `EVIDENCE_RECORDED`;
- `actorRef` `session-admin` for minting and `machine-core` for machine
  actions;
- resource `dispatch_action` with `action_id`.

## 5. Core design

### 5.1 Dispatch ledger (`aegis_soc/dispatch_ledger.py`)

This is a separate SQLite file, `<data root>/data/core-dispatch.sqlite3`. It
keeps the existing hash-chained Core audit database untouched.

```sql
CREATE TABLE IF NOT EXISTS core_dispatch_actions (
  action_id TEXT PRIMARY KEY,
  action TEXT NOT NULL CHECK (action = 'CUT_UPLINK'),
  expires_at REAL NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('CLAIM_REQUESTED', 'CLAIMED', 'PUBLISHED', 'ACK_RECEIVED',
    'STATUS_CORRELATED', 'DRY_RUN_ONLY', 'FAILED', 'EXPIRED_AT_CORE', 'CLAIM_REJECTED', 'OUTCOME_UNKNOWN')),
  nonce TEXT,
  claim_requested_at REAL NOT NULL,
  published_at REAL,
  ack_at REAL,
  updated_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS core_reconciliation_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action_id TEXT NOT NULL REFERENCES core_dispatch_actions(action_id),
  sequence INTEGER NOT NULL,
  stage TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  delivered_at REAL,
  disposition TEXT CHECK (disposition IN ('DELIVERED', 'REJECTED_BY_SERVER')),
  UNIQUE (action_id, sequence)
);
```

- **Durable writes:** every state change is committed before its side effect
  runs. The nonce stays Core-local.
- **Replay guard:** `begin_claim()` inserts `CLAIM_REQUESTED`. If the
  `action_id` already exists, it returns a replay result, which never leads to
  a publish.

### 5.2 Worker algorithm (`aegis_soc/dispatch_worker.py`)

`DispatchWorker.tick()` runs from the supervisor loop. It handles at most one
action per tick, and only when all of these hold:

- dispatch is enabled;
- the credential is available (§5.6);
- the Core is `ARMED`;
- no command is in flight: `supervisor.pending_command is None`, and no ledger
  row is `PUBLISHED` or `ACK_RECEIVED`.

Each tick:

1. **Deliver the outbox.** Deliver pending outbox rows in order (§5.3). A
   network failure defers delivery; a definitive 4xx sets
   `disposition = REJECTED_BY_SERVER`.
2. **Time out stale stages.** Set a row to `OUTCOME_UNKNOWN` when:
   - it is `PUBLISHED` with no ACK after `ACK_TIMEOUT_SEC`; or
   - it is `ACK_RECEIVED` with no correlated STATUS after
     `PHYSICAL_CONFIRM_TIMEOUT_SEC`.

   No retry follows either case.
3. **Pick an action.** `list_pending()`. Skip any action that is not
   `CUT_UPLINK`, or that is already expired on the **Core wall clock**; a
   clock-ahead skew therefore fails secure.
4. **Record the claim intent.** `ledger.begin_claim(action)`. On replay, skip.
5. **Claim.** `client.claim(action_id)`:
   - 200 → `CLAIMED`;
   - 404, 409, or 410 → `CLAIM_REJECTED` (terminal, never published);
   - network error → `OUTCOME_UNKNOWN`, because the claim may have applied
     server-side. This goes to human review, and nothing is published.
6. **Re-check expiry.** Check again on the Core clock immediately before
   publishing. If expired → `EXPIRED_AT_CORE`, reported, not published.
7. **Publish.** `supervisor.issue_command('CUT_UPLINK', …, origin='server-dispatch')`,
   the single command owner:
   - `sent` → `PUBLISHED`, with the nonce stored;
   - dry-run → `DRY_RUN_ONLY`, with the nonce stored;
   - not sent → `FAILED` (`MQTT_UNAVAILABLE`), no retry.
8. **Queue evidence.** Each stage appends one outbox row, with `sequence`
   increasing per action.

**Scope limits:** the worker never calls the controller or MQTT directly,
never issues `RESTORE_UPLINK`, and never passes `authorize_restore`.

### 5.3 Client and transport (`aegis_soc/dispatch_client.py`)

`DispatchClient(base_url, transport)` exposes `list_pending()`,
`claim(action_id)`, and `report(action_id, entry)`. It maps HTTP status codes
to typed results, and raises `DispatchUnavailable` with a reason for
network/TLS failures.

The default transport is `urllib.request` over an `ssl.SSLContext` built from
configured absolute CA, client-certificate, and client-key paths. It requires
`https://`. Tests inject a fake transport and never build a context with key
material.

### 5.4 ACK/STATUS correlation

The supervisor keeps its existing `_on_ack` and `_on_status` behaviour
unchanged. It additionally forwards nonce-correlated events to
`worker.on_ack` and `worker.on_status`.

- **ACK:** an `OK` ACK for the stored nonce → `ACK_RECEIVED`. A non-`OK` ACK →
  `OUTCOME_UNKNOWN` (`ACK_NOT_OK`).
- **STATUS:** a STATUS whose `command_nonce` equals the stored nonce and whose
  state is `LOCKDOWN` → `STATUS_CORRELATED`. A mismatched or missing nonce is
  ignored, as today.

### 5.5 Restart recovery

On worker start, `ledger.recover_after_restart()` moves every non-terminal row
to `OUTCOME_UNKNOWN` (`CORE_RESTART`) and queues its evidence. This covers
`CLAIM_REQUESTED`, `CLAIMED`, `PUBLISHED`, and `ACK_RECEIVED`.

Nothing is republished, and no restart or shutdown path publishes
`RESTORE_UPLINK`.

### 5.6 Credential pause

The credential counts as unavailable when either:

- a configured certificate, key, or CA file is missing; or
- the transport reports a TLS or certificate failure.

**Effect:** the worker reports `dispatch = PAUSED_CREDENTIAL` in its status and
performs no claim and no publish. A credential problem never causes a CUT. The
existing supervisor safety behaviour, including the Deadman heartbeat, is
unchanged.

### 5.7 Configuration, paths, and the disabled default

**New keys:**

| Key | Default |
|---|---|
| `AEGIS_CORE_DISPATCH_ENABLED` | `0` |
| `AEGIS_CORE_DISPATCH_BASE_URL` | none; `https://` only |
| `AEGIS_CORE_DISPATCH_CA_FILE` | none; absolute path |
| `AEGIS_CORE_DISPATCH_CLIENT_CERT` | none; absolute path |
| `AEGIS_CORE_DISPATCH_CLIENT_KEY` | none; absolute path |
| `AEGIS_CORE_DISPATCH_POLL_SEC` | `5` |
| `AEGIS_CORE_DISPATCH_DB_PATH` | none |

**Paths:** `RuntimePaths` gains `dispatch_db`, and `ProductionSettings` passes
it as `AEGIS_CORE_DISPATCH_DB_PATH`.

**Disabled default:** when disabled, the supervisor constructs no worker,
and every PR9 behaviour and test is unchanged.

## 6. Failure modes

| Failure | Behaviour |
|---|---|
| Core offline or never polls | display `DISPATCH_UNAVAILABLE`; the action expires at 120 s → `EXPIRED`; nothing is published |
| Claim response lost | Core `OUTCOME_UNKNOWN`; server `CORE_CLAIMED`; human review; never republished |
| Second or replayed claim | server 409; Core replay guard; no second publish |
| Core clock ahead or behind | the Core re-checks on its own clock; ahead → no publish (fail-secure). Clock sync is an implementation-time requirement (inventory §12.9) |
| MQTT unavailable | `FAILED`, no retry |
| No ACK, or no correlated STATUS | `OUTCOME_UNKNOWN`, no retry |
| Server unreachable after a publish | outbox deferred; delivered idempotently later |
| Credential missing, expired, or rejected | dispatch paused; no CUT |
| Core `DISARMED` | no claim; the action expires and shows as `EXPIRED` |
| Spoofed identity headers, wrong peer, browser cookie | 403; no state change; the browser listener has no machine routes |
| Server restart | pending rows kept until expiry; display `DISPATCH_UNAVAILABLE` until the next machine contact |

## 7. Edge contract supplied to Kla (documentation only)

Under K1, IDEA3 supplies the contract and Kla alone edits NGINX. S2 changes
no NGINX, Compose, network, or certificate file. For the later, separately
authorized Kla change:

- **Machine SNI block (K9).** It:
  - requires `ssl_verify_client on`;
  - trusts only the IDEA3 machine-client CA (K10);
  - proxies only `/security/api/machine/v1/` to the IDEA3 container-internal
    **machine port**, over the dedicated HUB↔IDEA3 internal network (K5);
  - returns 404 for everything else;
  - overwrites `X-AEGIS-Client-Verify` with `$ssl_client_verify` and
    `X-AEGIS-Client-DN` with `$ssl_client_s_dn`;
  - clears `Cookie`.
- **Browser `/security/` block (K2).** It:
  - never proxies to the machine port;
  - returns 404 for `^/security/api/machine/` case-insensitively;
  - clears both identity headers.
- **Trusted peer (K4/K5).** The IDEA3 trusted peer is the HUB's pinned
  address on the dedicated internal network; Kla supplies the final value.
- **No new server port (D5).** HUB/NGINX stays the only external/server entry
  point, on HTTPS 443. The IDEA3 machine port is never host-published. The
  exact bind, address, and network wiring belong to the later K4/K5/K7 change.

## 8. Inherited K1–K12 constraints

| K | S2 consequence |
|---|---|
| K1 | IDEA3 supplies the §7 contract and edits no NGINX |
| K2 | the machine prefix `/security/api/machine/` is fixed here for the browser-block 404. The Helmet header enumeration is D3 work and out of S2 |
| K3, K12 | S2 proceeds only because it is non-Production; the rollout stays blocked until K12 is confirmed |
| K4 | the trusted peer is configuration. Tests use a loopback placeholder, which is a local fixture and not the Production topology |
| K5 | the server never calls the Core; the Core pulls (compatible with `internal: true`). The machine listener is reachable only over the dedicated HUB↔IDEA3 internal network, with no host-published port |
| K6, K7, K8 | untouched by S2. The machine listener's Production bind and HUB wiring are deferred to the K7 change (with K4/K5); under K8, HUB 443 stays the only machine route |
| K9 | identity comes only from HUB-set headers from the pinned peer, and requires `SUCCESS` and the expected subject |
| K10 | expected subject placeholder `idea3-core`; the client only loads configured paths; credential problems pause dispatch |
| K11 | no IP allowlist in IDEA3; mTLS is primary |

## 9. Invariants and tests

| Invariant | Tests |
|---|---|
| One immutable `action_id` per accepted decision, minted atomically | W4, W5 |
| TTL 120 s; expired actions are never claimable or listed | W8, C2 |
| Atomic single-shot claim | W6, W7 |
| Machine identity only via pinned peer + `SUCCESS` + subject; never a browser credential | W9, W10 |
| `CUT_UPLINK` only; RESTORE never through the boundary | W11, C6 |
| Append-only, idempotent reconciliation with no evidence promotion | W12, C4, C7 |
| Never "Contained"; `OUTCOME_UNKNOWN` goes to human review | W13, C5 |
| Durable claim before publish; no republish; restart gives `OUTCOME_UNKNOWN` | C1, C3 |
| Single command owner | C9 |
| Disabled by default; PR9 behaviour unchanged | C10, regression suites |
| Schema v3 additive and fail-closed | W1, W2, W3, W14 |
| Credential problem pauses dispatch, never a CUT | C8 |

## 10. Rollback, downgrade, and non-action boundaries

- **Rollback:** S2 is repository-only, so rollback means not merging or a
  human revert of the PR. No Production state exists to undo.
- **Downgrade:** v2 code refuses a v3 database (it fails closed with an
  unsupported schema). Anyone running a lab data root must back up the Web
  database before first starting S2 code. Migrations in S2 run only against
  in-memory or temporary test databases.
- **Hard boundaries:**
  - no Production deployment or Production database migration;
  - no HUB, NGINX, Docker, Compose, network, firewall, router, VLAN, or
    Twingate change;
  - no real certificate or CA issuance or installation;
  - no firmware flashing;
  - no hardware CUT/RESTORE;
  - no IDEA1, IDEA2, or shared change;
  - no SSH access to the server or the Core host;
  - no private key committed. TLS test fixtures are avoided in favour of
    injected transports.
- **Stop points:**
  - G1, before any source change;
  - any need to touch a non-IDEA3 path;
  - the final Draft PR, before Ready.

## 11. Design choices for G1 review

These are proposed in this design and are confirmed or changed at G1:

1. **Separate machine listener** (§4.4) rather than a path under the browser
   app, so browser traffic cannot reach machine code. It is a
   container-internal port, reachable only over the HUB↔IDEA3 internal
   network. It adds no host-published port, and HUB 443 remains the only
   entry.
2. **Dispatch minting only when enabled;** default off, so PR9 and PR7
   behaviour is unchanged.
3. **A `DISARMED` Core does not claim;** the action expires and is shown as
   `EXPIRED`.
4. **A lost claim response is `OUTCOME_UNKNOWN`,** never a publish.
5. **Identity failures return 403** with no per-request audit row.
6. **A separate Core dispatch SQLite file,** leaving the hash-chained Core
   audit database untouched.
7. **`executed` and `physical_evidence` stay false in S2;** correlated STATUS
   is its own stage.
8. **Header names** `X-AEGIS-Client-Verify` and `X-AEGIS-Client-DN`, and the
   path prefix `/security/api/machine/v1`.
9. **One action in flight at a time,** at most one per worker tick.

## 12. Known limitations (NOT PROVEN until later authorized work)

- **Edge and network:**
  - real HUB mTLS and header behaviour;
  - the VLAN 20 → 443 path;
  - real-source visibility;
  - edge 404 for machine-path case variants.
- **Web hosting:** the D3 container bind; the machine listener's Production
  bind and network wiring (K4/K5/K7); a real HUB peer.
- **Clocks:** server NTP; clock sync between the server and the Core.
- **Credentials:** the real certificate lifecycle and CRL behaviour.
- **Hardware:** real MQTT/ESP32 ACK and STATUS under dispatch.
- **Audit:** no per-request audit of rejected machine requests in IDEA3.
