# IDEA3 Production Reliability and Persistence Hardening Design

## Scope and current boundary

This design covers Project Sequence PR6 only: operational error reporting,
production Web authentication/session hardening, and durable Security Center
audit persistence. The selected repository area is `idea3`, owned by `music`.
It does not alter IDEA1, IDEA2, shared infrastructure, MQTT protocol signing,
firmware, relay behavior, or production deployment.

Current `origin/main` already provides two relevant but separate persistence
surfaces:

- the Python Core has a SQLite hash-chain audit in `aegis_soc/database.py`;
- the Web Security Center has a repository interface implemented only by
  `createMemoryRepository()`, so Web authentication, acknowledgement, note,
  settings, and recovery-validation audit entries disappear on restart.

Current Web authentication already has HttpOnly/SameSite sessions, Admin-only
RBAC, same-origin validation, CSRF, session regeneration, logout destruction,
and per-IP login throttling. Production disables the development-login branch,
requires a password hash, and requires a 32-character session secret, but does
not reject known development/default or trivially weak 32-character secrets,
does not validate the bcrypt hash shape/cost, and does not durably audit auth
outcomes.

Current runtime normalization rejects stale/future evidence as `UNKNOWN` and
allow-lists a small issue set, but operational failures do not share one safe,
structured error contract and are not recorded to the Web audit ledger.

## Chosen architecture

PR6 will extend the existing Web repository boundary rather than introduce a
new service or make the browser talk to Python, MQTT, ESP32, or the relay.

1. A small operational-error module owns the allow-listed taxonomy, normalized
   shape, safe public messages, correlation fields, and recursive redaction.
2. A SQLite repository implemented with the Node runtime's `node:sqlite` module
   implements the same action methods as the memory repository. It stores a
   deterministic schema version, ordered audit records, durable mutation state,
   and active operational-error fingerprints. No external database or native
   package is added.
3. `createApp()` uses an in-memory SQLite database under `NODE_ENV=test` and a
   configured local SQLite path otherwise. Tests may continue injecting the
   memory repository where persistence is not the subject under test.
4. Auth routes receive the repository. Authentication success, uniform failure,
   throttling, and logout are recorded with server-owned actor/resource fields.
   A failed security-critical audit write prevents login success and returns a
   generic safe service error.
5. Live-provider failures become structured operational errors. The authenticated
   snapshot route records only newly active error fingerprints, clears recovered
   fingerprints, and returns allow-listed errors with no raw exception, path,
   request body, credential, token, or secret.
6. Audit reads are chronological and bounded (`1..250`). The existing Admin
   middleware remains the authorization boundary for both snapshot audit data
   and a dedicated audit query route.

The Python Core SQLite hash chain remains unchanged. PR6 hardens the Web
Security Center's current missing persistence contract rather than attempting a
cross-process migration or a second implementation of the Core command path.

## Operational error semantics

Every client-visible operational error has these fields:

```text
code
category
severity
message
component
occurredAt
recoverable
correlationId
```

The taxonomy covers:

```text
CORE_PROCESS_FAILURE
MQTT_DISCONNECTED
MQTT_RECONNECTING
ESP32_UNAVAILABLE
RUNTIME_EVIDENCE_STALE
MALFORMED_RUNTIME_STATUS
COMMAND_SEND_FAILURE
COMMAND_TIMEOUT
ACK_TIMEOUT
STATUS_TIMEOUT
PHYSICAL_CONFIRMATION_TIMEOUT
PHYSICAL_STATE_MISMATCH
UNAUTHORIZED_RESTORE
AUDIT_PERSISTENCE_FAILURE
AUTHENTICATION_FAILURE
SESSION_FAILURE
ADAPTER_UNAVAILABLE
ADAPTER_TIMEOUT
ADAPTER_RESPONSE_REJECTED
```

Unknown error codes are converted to `CORE_PROCESS_FAILURE`; arbitrary incoming
messages are never reflected to the browser. Raw errors may be used only to
classify a code inside the server. Redaction removes values beneath keys matching
password, token, secret, credential, authorization, cookie, HMAC, key, path,
stack, or payload before an audit detail is serialized.

Evidence states `ERROR`, `STALE`, `UNAVAILABLE`, `TIMEOUT`, and `UNKNOWN` never
produce `HEALTHY`. A stale or malformed runtime response leaves the runtime and
its components `UNKNOWN` while exposing a safe corresponding operational error.
ACK, STATUS, and physical confirmation stay distinct.

## Production authentication/session contract

Production startup fails closed unless all of the following are true:

- `SESSION_SECRET` is present, at least 32 characters, is not the checked-in
  development fallback, is not a single repeated character, and contains at
  least three character classes;
- `AEGIS_IDEA3_ADMIN_PASSWORD_HASH` is a valid bcrypt `$2a$`, `$2b$`, or `$2y$`
  hash with cost 12 or higher;
- development login remains disabled regardless of `AEGIS_ALLOW_DEV_LOGIN`;
- the persistent audit repository opens and initializes successfully.

The accepted session contract remains intentionally process-local. A Web restart
invalidates browser sessions; audit persistence is independent and survives.
Cookies remain HttpOnly, SameSite=Strict, Secure in production, rolling, and
bounded by the configured idle timeout. Invalid, expired, logged-out, or
non-Admin sessions are denied. CSRF, same-origin checks, and rate limiting remain
in force. Responses and audit rows use uniform, safe auth outcomes and never
store a submitted username/password, cookie, CSRF token, session ID, hash, or
secret.

## Audit persistence contract

The Web repository stores SQLite schema version `1` with:

- `audit_log`: monotonic integer id, ISO timestamp, category, action, outcome,
  actor reference, resource type/id, optional correlation id, and sanitized JSON
  detail;
- `alert_acknowledgements`, `incident_notes`, and `settings`: durable state used
  by the current repository behavior;
- `active_operational_errors`: one fingerprint per currently active failure so
  polling does not create duplicate audit rows; recovery removes the fingerprint
  and a later recurrence can be recorded again;
- `schema_meta`: deterministic schema version.

Writes use SQLite transactions. Persistence errors raise an
`AuditPersistenceError`; callers never report success after a failed write. The
HTTP error boundary maps that error to status 503 and the public code
`AUDIT_PERSISTENCE_FAILURE` without returning the filesystem path, SQL, record,
or stack.

Audit queries accept a server-validated limit from 1 through 250, sort newest
first for the UI, and preserve stable id ordering when timestamps match. Restart
tests open a file, write audit/state, close it, reopen it, verify old records and
state, append a new record, and verify deterministic ordering/correlation.
Malformed detail JSON degrades to an empty safe object; database open/write
failure is explicit, never silent success. Runtime database files remain ignored
by Git.

## Cross-area behavior within PR6

- auth success/failure/throttling/logout becomes safe durable audit;
- runtime/adapter operational errors become safe durable audit once per active
  failure transition;
- CUT lifecycle remains `REQUESTED != COMMAND_SENT != ACK != STATUS !=
  PHYSICAL_CONFIRMATION` and is not reimplemented in Web;
- RESTORE authorization remains distinct from command lifecycle;
- restarting Web invalidates sessions but preserves audit history;
- no test publishes MQTT or operates hardware.

## Failure handling and rollback

If the audit database cannot open at startup, the Web process fails before
listening. If a write fails during a request, the request returns a generic 503
and does not claim that the security action succeeded. If an evidence adapter
times out, rejects a response, returns malformed JSON, or yields stale runtime
evidence, the response stays fail-closed and includes only the normalized error.

Rollback is code-only: stop the Web process, revert this PR, and restart. The
SQLite file can remain as inert evidence or be archived by an operator; rollback
does not require schema downgrade because schema version 1 is additive and no
existing Web database existed. PR6 does not deploy or remove any runtime file.

## Compatibility

`node:sqlite` requires the Node version documented by this package. The package
will declare Node `>=22.13.0`; current verification uses Node 24.16.0. The local
SQLite path and synchronous API are compatible with a later Windows standalone
packaging task, but PR6 does not build an EXE or claim packaging acceptance.

## Non-goals and downstream guard

The following are preserved as OPEN/PLANNED and receive no implementation,
adapter, endpoint, fake event, schema, or receipt in PR6:

```text
IDEA1_IDEA3_LIVE_EVENT_INTEGRATION = OPEN / PR7
IDEA2_IDEA3_LIVE_EVENT_INTEGRATION = OPEN / PR7
CROSS_IDEA_EVENT_NORMALIZATION = OPEN / PR7
CROSS_IDEA_INCIDENT_CORRELATION = OPEN / PR7
CROSS_IDEA_CONTAINMENT_ACCEPTANCE = OPEN / PR7
1B_RESET_WINDOW = OPEN / PR8
ROUTER_SWITCH_REAL_ETHERNET_E2E = OPEN / PR8
KALI_E2E = OPEN / PR9
WINDOWS_EXE = OPEN / PR10
PRODUCTION_DEPLOYMENT = OPEN / PR11
FINAL_SYSTEM_ACCEPTANCE = OPEN / PR12
IDEA3_PRODUCTION_COMPLETE = NO
```

No live MQTT, relay actuation, firmware upload, real network change, deployment,
production credential provisioning, or final acceptance is part of PR6.

## Verification strategy

Each behavior change follows red-green-refactor with focused Vitest tests. The
final gate reruns the complete Web and Python suites, Web production build,
Python Ruff and compileall, firmware compile-only, repository Node tests, vault
validation, collaboration policy validation, diff/secret/artifact review, and a
SQLite close/reopen test using an isolated temporary directory.
