# IDEA3 PR7 Live Security Integration Design

## Purpose and evidence boundary

PR7 integrates read-only security evidence from IDEA1 and IDEA2 into the IDEA3
Security Center. This design is based on current `main` at
`5f30bc54f8603195ed9618e755fe3726ea343bb6`. It does not authorize a command,
MQTT publication, relay action, physical-containment claim, merge, or deployment.

The lifecycle remains explicit:

```text
Observed -> Normalized -> Correlated -> Containment Candidate
-> Containment Accepted -> Command Requested -> Command Published
-> ACK -> Executed -> Physical Evidence
```

PR7 ends at `Containment Accepted`. Acceptance never implies that a command was
requested, published, acknowledged, executed, or physically verified.

## PR6 evidence audit

| Area | Expected | Source | Tests | Commit | Obsidian | Classification | Gap |
|---|---|---|---|---|---|---|---|
| PR6 error reporting | Safe operational failures | `web/server/domain/operationalErrors.js:6` | `web/tests/server/operationalErrors.test.js:9` | `ee2668a8`, `cf1461b6` | PR6 receipt | VERIFIED_CURRENT | None |
| PR6 operational normalization | Preserve safe error identity | `web/server/domain/normalize.js:117` | `web/tests/server/normalize.test.js:121` | `ee2668a8`, `cf1461b6` | PR6 receipt | VERIFIED_CURRENT | None |
| PR6 durable Web audit | SQLite-backed application repository | `web/server/createApp.js:20` | `web/tests/server/productionReliability.test.js:47` | `a18bc083`, `a72aeda8` | `idea3-status.md:196` | VERIFIED_CURRENT | Live-provider metadata is stale; see separate row. |
| PR6 SQLite schema v1 | Versioned audit schema | `web/server/repositories/sqliteRepository.js:15` | `web/tests/server/sqliteRepository.test.js:47` | `a18bc083`, `a72aeda8` | PR6 receipt | VERIFIED_CURRENT | None |
| PR6 SQLite WAL | WAL journal mode | `web/server/repositories/sqliteRepository.js:105` | `web/tests/server/sqliteRepository.test.js:55` | `a18bc083` | PR6 receipt | VERIFIED_CURRENT | None |
| PR6 reopen/restart durability | Committed records survive reopen | `web/server/repositories/sqliteRepository.js:94` | `web/tests/server/productionReliability.test.js:75` | `a18bc083` | PR6 receipt | VERIFIED_CURRENT | None |
| PR6 audit sanitization | Allowlisted bounded audit entries | `web/server/repositories/auditRecords.js:39` | `web/tests/server/sqliteRepository.test.js:212` | `fb466c99` | PR6 receipt | VERIFIED_CURRENT | None |
| PR6 Windows path redaction | Drive, UNC, and rooted paths rejected | `web/server/repositories/auditRecords.js:7` | `web/tests/server/sqliteRepository.test.js:243` | `57a9fd65` | PR6 receipt | VERIFIED_CURRENT | None |
| PR6 production session secret | >=32, non-default, non-repeated, >=3 classes | `web/server/config.js:1` | `web/tests/server/config.test.js:24` | `5da3b19e` | PR6 receipt | VERIFIED_CURRENT | None |
| PR6 bcrypt policy | `$2a$`/`$2b$`/`$2y$`, cost 12-31 | `web/server/config.js:3` | `web/tests/server/config.test.js:47` | `5da3b19e` | PR6 receipt | VERIFIED_CURRENT | None |
| PR6 development login disabled | Production forces development login off | `web/server/config.js:44` | `web/tests/server/config.test.js:82` | `5da3b19e` | PR6 receipt | VERIFIED_CURRENT | None |
| PR6 login throttling | Five failures per 15 minutes | `web/server/createApp.js:59` | `web/tests/server/auth.test.js:100` | `5da3b19e` | PR6 receipt | VERIFIED_CURRENT | None |
| PR6 rate-limit coalescing | One audit per source/window | `web/server/routes/authRoutes.js:31` | `web/tests/server/auth.test.js:148` | `efd8b0b5` | PR6 receipt | VERIFIED_CURRENT | None |
| PR6 server-side auth audit | Login success/failure/rate-limit/logout | `web/server/routes/authRoutes.js:40` | `web/tests/server/auth.test.js:45` | `5da3b19e`, `efd8b0b5` | PR6 receipt | VERIFIED_CURRENT | None |
| PR6 operational failure audit | Live-only failure activation/recurrence | `web/server/routes/securityRoutes.js:44` | `web/tests/server/productionReliability.test.js:96` | `d3ffd9c2` | PR6 receipt | VERIFIED_CURRENT | Recovery clears active state but has no positive recovery audit row. |
| PR6 bounded Admin audit read | Admin-only `limit=1..250`, newest first | `web/server/routes/securityRoutes.js:52` | `web/tests/server/securityRoutes.test.js:59` | `d3ffd9c2` | PR6 receipt | VERIFIED_CURRENT | None |
| PR6 audit fail-closed | HTTP 503 `AUDIT_PERSISTENCE_FAILURE` | `web/server/createApp.js:68` | `web/tests/server/productionReliability.test.js:157` | `d3ffd9c2` | PR6 receipt | VERIFIED_CURRENT | None |
| PR6 environment documentation | Production/audit variables documented | `.env.example:29` | Current file inspection | `ec88cdca` | PR6 receipt | VERIFIED_CURRENT | None |
| PR6 README documentation | Auth, SQLite lifecycle, and limitations | `README.md:123`, `web/README.md:61` | Current file inspection | `ec88cdca` | PR6 receipt | VERIFIED_CURRENT | None |
| PR6 canonical Obsidian reconciliation | Durable audit wording current | `web/server/createApp.js:20` | Current vault validation | `ec88cdca` | `idea3-status.md:196` | VERIFIED_CURRENT | Detailed PR6 closure/PR #101 facts were missing before this PR7 reconciliation. |
| PR6 task receipt | Exactly one immutable Music receipt | `90-Status/logs/2026-09-08_111604_music_idea3-production-reliability.md` | Filename count = 1 | `ec88cdca` | Same receipt | VERIFIED_CURRENT | None |
| PR6 vault validation | Current vault passes | `scripts/validate-vault.mjs` | PASS, two known canvas warnings | `ec88cdca` | PR6 receipt | VERIFIED_CURRENT | None |
| PR6 collaboration policy | Policy evidence recorded and current tests pass | `scripts/validate-collaboration-policy.mjs` | Repository tests 56/56 | `ec88cdca` | PR6 receipt | VERIFIED_HISTORICAL | PR6 event fixture is not retained; current policy is rerun for this branch. |
| GitHub PR #101 | Merged into main | `git log` merge commit | Ancestry exit 0 | `5f30bc54` | PR6 receipt | VERIFIED_CURRENT | None |
| Fix1A application startup | Application starts LOCKDOWN/GPIO27 LOW | `firmware/src/main.cpp` | `tests/test_firmware_contract.py` | Pre-PR6 history | `idea3-status.md:59` | VERIFIED_HISTORICAL | Does not cover pre-application reset window. |
| Deadman -> relay -> RJ45 | Reconnect does not restore; explicit RESTORE does | Firmware/runtime source | Historical cable-tester receipt | Pre-PR6 history | `idea3-status.md:59` | VERIFIED_HISTORICAL | Router/switch traffic isolation not proven. |
| PR8 reset window | GPIO may float before application code | Not implemented | Not physically closed | Not PR6 | `idea3-status.md:86` | OPEN_BY_DESIGN | PR8 owns mitigation and evidence. |
| PR8 real Ethernet E2E | RESTORE/CUT/RESTORE traffic proof | Not implemented | Not performed | Not PR6 | `idea3-status.md:90` | OPEN_BY_DESIGN | PR8 owns real router/switch proof. |
| Total power-loss fail-secure | Pre-application electrical proof | Not implemented | Not performed | Not PR6 | `idea3-status.md:86` | OPEN_BY_DESIGN | Must not be inferred from compile or post-boot evidence. |
| Live audit provenance metadata | Must say Web audit is durable | `web/server/providers/liveProvider.js:76,93` says in-memory/`MEMORY_ONLY` | No regression covers provenance truth | PR6 did not remove it | Canonical note says durable | STALE_DOC | Correct in PR7 source without changing event-store truth. |

Fresh checks on this baseline: Python 63/63, Ruff PASS, compileall PASS, Web
168/168 (18 files), Web build PASS, `npm audit --omit=dev --offline` 0
vulnerabilities, repository tests 56/56, firmware compile-only PASS in an
isolated copy, and vault validation PASS with the two known canvas warnings.
The compile used the checked-in placeholder header and therefore its binary
hash is not compared with the historical secret-dependent firmware hash.

Audit totals: `VERIFIED=26`, `STALE_DOC=1`, `MISSING_EVIDENCE=0`,
`UNRESOLVED=3`.

## Verified source contracts

| Source | Interface | Purpose | Auth | Event ID | Timestamp | Severity | Type | Subject/Resource | Evidence | Freshness | Dedup | Live/Demo | IDEA3 Consumer | Source file:line |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| IDEA1 Drive | `GET /healthz` | Layer health | None; Docker probe | None | Probe-time only | None | Health | Drive layers | `application`, `metadata`, `storage` | Request-time | None | Live; development DB can be unconfigured | No event consumer | `IDEA1-AEGIS_Drive_LC/server/app.js:47` |
| IDEA1 Drive | `GET /api/audit` | Newest audit rows | Admin session; password-reset gate | Not exposed | `at` (JSON ISO after serialization) | Not explicit; derive only from `result` | `action`; result `OK/DENIED/BLOCKED` | `target_hash`, actor, role, source IP | Privacy-preserving audit row | Event `at`; no envelope freshness | Weak composite only; DB id omitted | PostgreSQL live or 500-row development memory fallback | Current IDEA3 schema is incompatible and has no upstream session | `IDEA1-AEGIS_Drive_LC/server/routes/api.js:298`; `server/db/connection.js:620` |
| IDEA2 Monitor | `GET /api/alerts` | Newest security alerts | SOC-Responder session only | PostgreSQL `id` | `at` epoch ms | `sev`: amber/red | `type` | `cam`, `camName`, route | title, snapshot path, Telegram/ACK state | Event `at` | Stable alert `id` | PostgreSQL live; empty without DB | Current IDEA3 schema is incompatible and has no upstream session | `IDEA2-AEGIS_Monitor/server/routes/api.js:317`; `server/db/store.js:417` |
| IDEA2 Monitor | `GET /api/detections` | Newest recognition frames | Authenticated; camera-assignment scoped | `frame_id` as `id` | `at` epoch ms | None | Detection implicit | `cam` | people status/name/confidence, NAS flag | Event `at` | Stable frame id | PostgreSQL live; empty without DB | Usable only through a new service read contract | `IDEA2-AEGIS_Monitor/server/routes/api.js:309`; `server/db/store.js:384` |
| IDEA2 Monitor | `GET /api/link` | Per-visible-camera heartbeat status | Authenticated; camera-assignment scoped | Camera id | `lastFrameAt` epoch ms | None | Link health | Camera | connection and measured metrics | Derived from heartbeat age | Camera id | Live plus explicitly flagged SOC-only simulated outage | Status-only; not an event feed | `IDEA2-AEGIS_Monitor/server/routes/api.js:293`; `server/db/store.js:159` |
| IDEA2 Detection Engine | `GET /detections/recent?limit=N` | Low-latency ring-buffer detections | No auth on this route | No stable event id; frame sequence only | ISO `timestamp` | No normalized severity | `detection` | `camera_id` | entities include name, boxes, track id, confidence | Timestamp present; consumer must derive | Camera + frame sequence is not restart-stable | Live memory ring, max configured 100 | Rejected for production integration: unauthenticated, sensitive, non-durable | `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/local_api.py:251`; `models.py:103` |
| IDEA3 Python | Atomic `status.json` | Supervisor/runtime truth | Local filesystem permissions | None | `updated_at` epoch seconds | None | Runtime state | Broker/device/uplink/components | Safe state fields | Consumer must derive | Latest snapshot only | Live runtime file | Current Web HTTP schema is incompatible | `IDEA3-AEGIS_Lockdown/aegis_soc/runtime.py:162` |
| IDEA3 Web | Three configured GET adapters | Read upstream JSON with timeout/size/redirect limits | Sends no credential; `Accept` only | Synthesized hash after normalization | Assumes ISO `timestamp` | Hard-coded enums | Hard-coded IDEA1/IDEA2 schemas | IP/target | Strict allowlist after parsing | Runtime only; upstream events incorrectly marked fresh on fetch | 60-second content key | Explicit Live/Demo providers | Base exists but cannot consume real upstream contracts | `IDEA3-AEGIS_Lockdown/web/server/providers/liveProvider.js:7`; `domain/normalize.js:8` |

### IDEA2 ownership and tamper findings

- `camera_assignment.camera_id` is the primary key: a camera has at most one
  assigned operator. SOC-Responder sees the fleet; CCTV-Operator reads only
  assigned cameras through server-side filtering.
- Detection Engine writes through API-key-protected `/internal/*`; it holds no
  Monitor database credential. Missing server key returns 503 and a wrong key
  returns 401.
- No current producer emits `CAMERA_TAMPER`. The value exists only in IDEA3's
  assumed normalizer enum and must remain design-only.

### PR6-documented adapter variables

| Variable | Classification | Evidence |
|---|---|---|
| `AEGIS_IDEA1_STATUS_URL` | USED_IN_SOURCE | `web/server/config.js:76` -> `liveProvider.js:53` |
| `AEGIS_IDEA2_STATUS_URL` | USED_IN_SOURCE | `web/server/config.js:77` -> `liveProvider.js:54` |
| `AEGIS_IDEA3_RUNTIME_STATUS_URL` | USED_IN_SOURCE | `web/server/config.js:78` -> `liveProvider.js:55` |
| `AEGIS_MAX_EVIDENCE_AGE_MS` | USED_IN_SOURCE | `web/server/config.js:67` -> runtime normalization |
| `AEGIS_ADAPTER_TIMEOUT_MS` | USED_IN_SOURCE | `web/server/config.js:68` -> abort timer |

The code paths are tested with hand-built configuration objects, but none of
the five environment keys has a direct configuration-wiring assertion. They
are therefore not classified `USED_AND_TESTED`.

## Approach decision

1. **Recommended: upstream-owned versioned service feeds plus IDEA3 adapters.**
   Each upstream owner exposes a bounded read-only event feed protected by a
   dedicated integration credential. IDEA3 translates that feed into one
   internal contract. This preserves identity/database ownership and supports
   stable IDs and freshness.
2. **Rejected: IDEA3 logs into human Admin/SOC sessions.** Session cookies are
   rotating human identity artifacts, spread privileged credentials, and do
   not form a stable service boundary.
3. **Rejected: direct PostgreSQL or unauthenticated Detection Engine reads.**
   Direct DB access breaks identity decoupling; the local ring buffer is
   unauthenticated, sensitive, and non-durable.

Until reviewed upstream feeds exist, the live integration remains OPEN and the
adapters must fail closed as `NOT_CONFIGURED` or `ADAPTER_UNAVAILABLE`.

## Task 1 execution — upstream dependency gate

Task 1 was re-executed on branch
`feat/idea3-live-security-integration` at
`2e638b41dbec6740ecbfb46b89e72572a130c9ee`. The worktree was clean and matched
the pushed remote branch before this evidence-only update. Current source still
contains no reviewed service event feed for either upstream system.

| Candidate surface | Current source truth | Dependency verdict |
|---|---|---|
| IDEA1 `GET /api/audit` | `requireRole(ROLES.ADMIN)` protects the human-session route. It returns `{ events }` from `readAudit(200)`; rows expose `at`, actor label, role, action, target hash, result, and source IP, but no stable event ID or explicit severity. | REJECTED_AS_SERVICE_FEED |
| IDEA2 `GET /api/alerts` | `requireRole(ROLES.SOC)` protects the human-session route. It returns `{ alerts }` with stable database IDs, but no versioned envelope or dedicated integration authentication, and includes snapshot/acknowledger presentation fields that must not cross the integration boundary. | REJECTED_AS_SERVICE_FEED |
| IDEA2 `GET /api/detections` | `requireAuth` plus server-owned `camera_assignment` filtering protects the human-session route. It returns recognition names/confidence and has no event severity or service authentication. | REJECTED_AS_SERVICE_FEED |
| IDEA2 `/internal/*` | `X-Detection-Engine-Key` is a real fail-secure service credential, but the event routes are write-only ingest. The sole GET returns Telegram routing data, not security events. | NOT_A_READ_FEED |
| Detection Engine `GET /detections/recent` and `WS /ws/events` | Both expose a process-local recent-event ring without authentication. Events may contain recognition names, bounding boxes, track IDs, and confidence; the buffer is non-durable and does not supply the required stable IDs/envelope. | REJECTED_FOR_PRODUCTION |

The required-source search found no upstream implementation of
`schema_version`, `generated_at`, `event_id`, `occurred_at`, or
`correlation_key` in the reviewed IDEA1/IDEA2 server and Detection Engine
source. The existing `DETECTION_ENGINE_API_KEY` cannot be repurposed for an
IDEA3 read path because it authenticates a different producer-to-Monitor trust
boundary.

Each upstream owner must separately review and provide a bounded read-only feed
whose route name remains that owner's decision. IDEA3 requires HTTP 200 JSON
with `schema_version=1`, a valid `generated_at`, and bounded `events`; a
dedicated source-specific integration credential; a response limit no greater
than 256 KiB; stable event IDs and occurrence timestamps; and no raw secrets,
media, biometric names/templates, embeddings, filesystem paths, or human-session
artifacts. The two feeds must also define a reviewed privacy-safe correlation
key before real cross-IDEA correlation can be claimed.

```text
PR7_TASK_1_UPSTREAM_INTERFACE_INVENTORY = CLOSED
PR7_UPSTREAM_DEPENDENCY_GATE = BLOCKED
IDEA1_SERVICE_EVENT_FEED = ABSENT
IDEA2_SERVICE_EVENT_FEED = ABSENT
TASK_1_IMPLEMENTATION_RESULT = PARTIAL / EVIDENCE-ONLY
IDEA1_IDEA3_LIVE_EVENT_INTEGRATION = OPEN
IDEA2_IDEA3_LIVE_EVENT_INTEGRATION = OPEN
CROSS_IDEA_EVENT_NORMALIZATION = OPEN
CROSS_IDEA_INCIDENT_CORRELATION = OPEN
CROSS_IDEA_CONTAINMENT_ACCEPTANCE = OPEN
```

No upstream or IDEA3 application source changed in Task 1. No endpoint path,
schema, credential, production data, command state, MQTT behavior, ACK,
execution, physical evidence, hardware, deployment, or PR8–PR12 state was
created or claimed.

## Component map

| Component | Decision | Reason |
|---|---|---|
| `web/server/config.js` | EXTEND_IDEA3_ONLY | Keep five existing settings; add bounded service-credential inputs without logging values. |
| Generic HTTP fetch boundary | NEW_IDEA3_COMPONENT | Separate size, timeout, redirect, authentication, and JSON-envelope validation. |
| IDEA1 adapter | NEW_IDEA3_COMPONENT | Translate the reviewed IDEA1 feed, never a human session response. |
| IDEA2 adapter | NEW_IDEA3_COMPONENT | Translate the reviewed IDEA2 feed and strip biometric/media fields. |
| `domain/normalize.js` | EXTEND_IDEA3_ONLY | Replace assumed producer shapes with canonical normalized validation. |
| `domain/status.js` | REUSE_AS_IS | Existing future/stale fail-closed behavior applies to event timestamps too. |
| `domain/correlate.js` | EXTEND_IDEA3_ONLY | Use stable IDs/correlation keys and deterministic ordering. |
| `domain/operationalErrors.js` | EXTEND_IDEA3_ONLY | Add malformed/conflicting event and source-recovery lifecycle codes. |
| SQLite/audit repositories | EXTEND_IDEA3_ONLY | Preserve PR6 sanitization/fail-closed rules; add additive v2 decision/lifecycle state. |
| Admin/CSRF security routes | EXTEND_IDEA3_ONLY | Add acceptance-only endpoint; no command transport. |
| Demo provider | REUSE_AS_IS | Remains session-isolated and cannot create live audit evidence. |
| Python runtime HTTP v1 producer | UPSTREAM_CHANGE_REQUIRED | Current Python output is a local snake_case file, not the Web contract. |
| IDEA1/IDEA2 service feeds | UPSTREAM_CHANGE_REQUIRED | Current human-session routes cannot be used by IDEA3 safely. |
| MQTT/controller/firmware command path | NOT_NEEDED | PR7 acceptance must not publish or claim execution. |

## Normalized event contract

The upstream envelope is versioned and bounded:

```json
{
  "schema_version": 1,
  "generated_at": "2026-09-08T08:00:00.000Z",
  "events": []
}
```

IDEA3 creates this internal shape for each event:

```json
{
  "source": "IDEA1",
  "event_id": "source-stable-id",
  "event_type": "ACCESS_DENIED",
  "severity": "WARNING",
  "occurred_at": "2026-09-08T07:59:55.000Z",
  "received_at": "2026-09-08T08:00:00.000Z",
  "resource": "AEGIS Drive",
  "subject": null,
  "confidence": null,
  "evidence": { "result": "DENIED" },
  "freshness": "FRESH",
  "correlation_key": null
}
```

Required producer fields are `source`, `event_id`, `event_type`, `severity`,
`occurred_at`, and `resource`. Optional producer fields are `subject`,
`confidence`, `evidence`, and `correlation_key`. `received_at` and `freshness`
are always IDEA3-owned. Text is trimmed and bounded; confidence is 0-100;
evidence is a shallow allowlisted object without paths, media, biometrics,
credentials, raw payloads, names, or embeddings.

`severity=UNKNOWN` is accepted for visibility but is never containment-eligible.
An unknown source/type, missing required field, invalid timestamp, invalid
confidence, oversized response, or invalid correlation key rejects that event,
emits a sanitized operational failure, and cannot create an incident. Partial
optional evidence remains visible with `evidence_completeness=PARTIAL`.

## Freshness, deduplication, and source lifecycle

- Envelope and event timestamps use the configured maximum evidence age. More
  than five seconds in the future is `FUTURE`; older than the window is `STALE`.
  Both remain observable but are excluded from correlation and containment.
- Primary dedup key is `source:event_id`. The first valid occurrence wins.
  Repeated identical IDs increment a bounded count. The same ID with different
  canonical content is an `EVENT_ID_CONFLICT`, excluded fail-closed.
- Events are sorted by `occurred_at`, then `source:event_id`; out-of-order input
  therefore produces the same result as ordered input.
- Timeout, unavailable, malformed response, and oversized response retain the
  existing safe adapter errors. One active period creates one durable failure
  audit row. The first successful validated cycle after failure creates one
  `ADAPTER_RECOVERED` audit row; a later failure is a new active period.
- Demo mode cannot update live source lifecycle, event, correlation, or
  containment-decision audit state.

## Correlation semantics

Only fresh, normalized, non-conflicting events participate. A cross-IDEA
incident requires one eligible IDEA1 event and one eligible IDEA2 event with the
same non-null, validated `correlation_key` inside the configured 10-minute
window. Current source lacks such a shared key, so no real cross-IDEA incident
may be claimed before the upstream contract supplies one.

The incident ID is a hash of the sorted `source:event_id` evidence IDs and the
correlation key. Severity is the maximum known event severity. Single-source,
unrelated, outside-window, stale, future, unknown-severity, malformed, and
conflicting evidence produces no cross-IDEA incident. Duplicates do not inflate
evidence counts. Input order does not affect output.

Minimum tests cover IDEA1-only, IDEA2-only, matching sources, unrelated keys,
outside window, duplicate IDs, and out-of-order input.

## Containment acceptance boundary

A correlated incident first becomes a `CONTAINMENT_CANDIDATE`. An authenticated
IDEA3 Admin may accept or reject that candidate through same-origin + CSRF
enforcement. The decision is durable and auditable. Acceptance returns:

```json
{
  "incident_id": "inc-stable-id",
  "state": "CONTAINMENT_ACCEPTED",
  "command_requested": false,
  "command_published": false,
  "acknowledged": false,
  "executed": false,
  "physical_evidence": false
}
```

The route has no import of the Python controller, MQTT client, broker config, or
firmware path. Converting an accepted decision into `Command Requested` is a
separate reviewed boundary and is not part of this baseline.

## Durable audit and persistence

PR7 reuses PR6's sanitizer, bounded Admin read, 503 fail-closed response, WAL,
and newest-first audit. An additive SQLite schema v2 stores containment
decisions and integration lifecycle fingerprints while preserving schema v1
audit rows. Required audit actions are `ADAPTER_FAILURE`, `ADAPTER_RECOVERED`,
`EVENT_REJECTED`, `EVENT_ID_CONFLICT`, `INCIDENT_CORRELATED`,
`CONTAINMENT_ACCEPTED`, and `CONTAINMENT_REJECTED`.

Audit detail contains only source, safe code, freshness, bounded counts, and
stable IDs. It never stores raw upstream bodies, secrets, cookies, tokens,
biometrics, media, filesystem paths, stack traces, or human names. Persistence
failure remains HTTP 503 and must not report a successful acceptance.

## Non-goals

- No IDEA1/IDEA2 source edits in this baseline.
- No human-session automation or direct database access.
- No tamper claim without a verified producer.
- No command request/publication, MQTT, ACK, execution, relay, or physical proof.
- No PR8 hardware evidence, PR9 Kali work, PR10 Windows packaging, PR11
  deployment, or PR12 acceptance/freeze work.
- No merge, deployment, force-push, or production configuration change.

## Closure criteria

The design baseline closes when the contract/evidence tables, detailed plan,
canonical status, handoff, and one receipt are committed and pushed with vault
and collaboration validation passing. All five PR7 integration outcomes remain
OPEN until source implementation and real upstream integration evidence exist.
