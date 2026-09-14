---
title: AEGIS IDEA2 CP3 Machine A Agent Identity Design
date: 2026-09-13
owner: pub
area: idea2
status: proposed
---

# AEGIS IDEA2 CP3 — Machine A Agent Identity and Authenticated Ingest

## 1. Goals

CP3 gives Machine A a cryptographically verifiable application identity without
placing that identity in the browser or in the interactive Detection Engine.
The Monitor authenticates an outbound Windows Identity Agent with Ed25519,
issues a short-lived in-memory Agent session, and requires a route-specific
proof-of-possession signature on every authenticated heartbeat, detection,
alert, and clip request.

The design must:

- prove possession of Machine A's registered Ed25519 private key;
- derive `nodeId`, `keyVersion`, and `physicalCameraId` from server-side state;
- preserve logical `CAM-01` and `CAM-02` as business aliases only;
- keep Machine A's private key outside browser and Detection Engine memory;
- preserve Detector B while its current shared-key runtime is migrated later;
- keep camera activation entirely outside authentication, heartbeat, and
  session renewal; and
- fail closed before application or database writes when proof is invalid.

## 2. Non-goals

CP3 does not implement browser-to-machine association, Operator stream demand,
producer acquisition, camera release, UI changes, model changes, camera-device
configuration, biometric enrollment, or Production deployment. It does not
replace SSH transport identity, move the webcam into a service, persist
challenge/session/replay state in PostgreSQL, or migrate Detector B to Ed25519.

CP3 does not make logical aliases physical identities and does not use
`camera_assignment`, heartbeat telemetry, IP address, hostname, User-Agent,
query parameters, browser storage, or unsigned headers as machine authority.

## 3. Threat model

### Protected assets

- Machine A's Ed25519 private key and decrypted key material.
- The binding between a registered Node and its physical camera.
- Authenticity and physical provenance of heartbeat and ingest writes.
- Replay state for challenges, Agent sessions, nonces, and sequence numbers.
- The existing camera-demand and SOC-passive safety contract.

### In-scope attackers

- A remote client that knows or guesses a `node_id`.
- A browser session, including one with a valid Operator login.
- A holder of the legacy shared Detection Engine API key.
- A process running as an ordinary interactive Windows user other than the
  designated Detection Engine identity.
- A network observer or request replayer that cannot break TLS or Ed25519.
- A caller that changes a body, method, path, proof domain, nonce, timestamp,
  or sequence after a signature is created.

### Trust assumptions and residual risk

- Windows `SYSTEM`, the dedicated Identity Agent service identity, the Monitor
  host administrator, and the PostgreSQL administrator remain privileged trust
  anchors. A local administrator can ultimately take ownership of files or
  alter service configuration; ACLs prevent ordinary access, not hostile local
  administration.
- The designated interactive Detection Engine identity is trusted to submit
  truthful operation data. It cannot obtain a generic signing oracle or the
  private key, but a compromise of that identity can submit the four allowed
  operation shapes to the Agent.
- TLS certificate and hostname validation use the platform trust store and
  remain mandatory. Ed25519 application proof supplements TLS; it does not
  replace it.
- The legacy shared-key path remains a transitional bearer-token risk for
  nodes explicitly configured as `legacy_shared_key`. It never creates trusted
  Machine A physical provenance.

## 4. Current architecture

At commit `9bdcf0647cf5c66cdb303066e6cad15f552ebf25`, Monitor already stores
`detection_nodes.public_key`, `public_key_fingerprint`, `key_version`, and
`active`. `physical_cameras` supplies the authoritative one-Node-to-one-physical-
camera registration. Logical alias policy is represented independently.

Runtime ingest still mounts the whole `/internal` router behind one shared
`X-Detection-Engine-Key`. The Engine sends `cameraId` and `nodeId` in JSON;
the current route and store flow can therefore treat client-provided identity
as if it were authority. There is no runtime Ed25519 verification, Agent
challenge, Agent session, request proof, DPAPI application-key store, or
dedicated Identity Agent service.

The Windows Detection Engine runs in the interactive user's session so OpenCV
can access the webcam. Its SSH tunnel is a separate `SYSTEM` startup task. This
split is retained: CP3 adds a third process boundary instead of moving camera
capture into a service.

## 5. Target architecture

```text
interactive Windows session                 dedicated Windows service
+---------------------------+               +----------------------------+
| Detection Engine          | named pipe    | AEGIS Identity Agent       |
| webcam + AI + event data  |-------------->| validate operation         |
| no application key       |               | build exact HTTP body      |
| no Agent session         |<--------------| sign + send outbound HTTPS |
+---------------------------+ result only   +-------------+--------------+
                                                           |
                                                           | TLS + Ed25519
                                                           v
                                              +----------------------------+
                                              | Monitor                    |
                                              | challenge/session/replay   |
                                              | live registry validation   |
                                              | trusted physical context   |
                                              +----------------------------+

Browser -> authenticated Monitor UI only; no CP3 Agent or pipe access.
```

The Identity Agent owns the private key, Monitor authentication, session token,
renewal, request nonces, and sequence allocation. The Agent, rather than the
Engine, transmits authenticated requests. The Engine receives only a bounded
success/failure result over the pipe. The Monitor derives physical identity
from its registry after verifying proof; request bodies may retain a logical
camera alias as event data but cannot supply physical authority.

## 6. Windows process and identity model

The service name is `AEGISIdentityAgent` and it runs as the Windows virtual
service account `NT SERVICE\AEGISIdentityAgent`. This gives the service a
dedicated SID without storing a service-account password. Installation must
enable the service SID, start automatically, and fail before key generation if
the service identity cannot load a usable user profile and complete a DPAPI
CurrentUser encrypt/decrypt round trip.

The Agent is a separate Python package and runtime from `aegis_engine`. Its
Windows service host, DPAPI, service-control, token/SID, ACL, and named-pipe
adapters use `pywin32`; Ed25519 uses the already-established Python
`cryptography` library family. Agent binaries and its isolated virtual
environment live under `%ProgramFiles%\AEGIS\IdentityAgent`; mutable encrypted
state and non-secret service logs live under `%ProgramData%\AEGIS\IdentityAgent`.
The implementation plan must pin Windows-only dependencies in an Agent-specific
requirements file rather than adding them to the cross-platform Engine runtime.

The Detection Engine stays in its existing interactive user session. The
installer records that user's SID as the sole Engine client identity for the
named pipe. Account display names are never used in ACLs. `SYSTEM` may manage
the service and protected files but does not run the webcam process.

The service must have no webcam permission or camera code dependency. Starting,
authenticating, renewing, stopping, or repairing the service must not contact
the local camera API or alter stream demand.

## 7. DPAPI and key lifecycle

The Agent generates one Ed25519 key pair locally using the operating-system
cryptographic random source. The private key is serialized as PKCS#8 DER and
immediately protected with DPAPI `CurrentUser` while running as
`NT SERVICE\AEGISIdentityAgent`. Plaintext private bytes exist only in bounded
Agent memory, are never returned through IPC, and are overwritten where the
runtime permits before buffers are released.

The encrypted blob lives at:

```text
%ProgramData%\AEGIS\IdentityAgent\machine-identity.dpapi
```

The parent directory and file disable inheritance. Their explicit DACL grants
FullControl only to the `AEGISIdentityAgent` service SID and `SYSTEM`. No
interactive user, `Users`, `Authenticated Users`, or `Everyone` ACE is allowed.
No explicit `Administrators` ACE is added. Windows administrators' inherent
ability to take ownership is a platform trust assumption, not a file grant.

The public key is exported separately in canonical SubjectPublicKeyInfo PEM
for one-time server registration. Export never includes private material. The
existing SSH Ed25519 key and its ACL are neither read nor reused.

Repair revalidates the file owner, inheritance, explicit ACEs, DPAPI round trip,
and public-key fingerprint. It never silently creates a replacement identity.
Rotation is an explicit generate-register-activate operation: create a new
local key under the Agent identity, register its public key and next
`key_version`, atomically activate it server-side, then retire the previous
encrypted blob only after new authentication succeeds. Uninstall preserves the
encrypted blob by default and never decrypts or prints it.

## 8. Named-pipe protocol

The local endpoint is `\\.\pipe\AEGIS.IdentityAgent.v1`. The Agent creates the
first pipe instance with remote clients rejected. Its DACL permits the Agent
service SID and the one configured Detection Engine user SID; all other SIDs
are denied by absence. The protocol uses UTF-8 JSON messages with a 64 KiB hard
limit, a 5-second read timeout, and one request followed by one response per
connection.

Request envelope:

```json
{"version":1,"operation":"heartbeat","payload":{}}
```

Allowed operations are exactly `heartbeat`, `detection`, `alert`, and `clip`.
Each operation has a closed schema matching the existing Monitor body fields;
unknown properties, unknown operations, invalid types, over-limit collections,
and any `nodeId`, `physicalCameraId`, session, signature, raw bytes-to-sign, URL,
method, path, or header field are rejected. The Agent supplies Node identity,
physical identity context, destination, method, path, session, nonce, sequence,
and signature itself. Clip messages carry metadata and a path reference only,
not arbitrary file bytes.

There is no `sign(data)` operation and no response containing a signature,
private key, session ID, request nonce, or canonical payload. Responses are
`{"ok":true,"status":<http-status>}` or a stable non-secret error code.

When supported, the server records the pipe client's process ID and confirms
that its token SID matches the already-authorized Engine SID. An executable-
path check may reject an unexpected binary under an ACL-protected runtime root,
but PID or path is defense in depth and never replaces the pipe DACL. No
browser-facing HTTP endpoint, WebSocket, extension, or helper bridges to this
pipe in CP3.

## 9. Agent authentication

The Agent calls two internal, non-browser routes over outbound HTTPS:

```text
POST /internal/agent-auth/challenge
POST /internal/agent-auth/verify
```

The public gateway continues to block `/monitor/internal`; the Machine A
service uses its approved internal Monitor path. The challenge endpoint accepts
`nodeId` only as a lookup hint. It performs a live registry lookup, requires a
registered Ed25519 public key, active Node, supported authentication mode, and
active physical camera, and returns a one-time challenge with a 60-second TTL.
Ed25519 authentication is permitted while a Node is still in
`legacy_shared_key` rollout mode; that mode permits the legacy path in addition
to Ed25519. `ed25519_required` disables the legacy path. Unknown and disabled
registrations use the same external failure shape.

The challenge contains a 256-bit random canonical Base64URL `challengeId`, a
256-bit random Base64URL `nonce`, issue/expiry times, configured audience,
purpose `agent-authenticate`, `nodeId`, and current `keyVersion`. The Agent
verifies all returned values against its configuration, signs the canonical
auth payload with domain `AEGIS-AGENT-AUTH-V1`, and submits the proof.

The Monitor reloads the Node row and physical registration, verifies the exact
registered key version and Ed25519 signature, and then atomically consumes the
challenge. A failed proof never consumes it. For two concurrent valid proofs,
one synchronous consume operation wins and every later attempt returns the
generic authentication failure.

The challenge store is in memory, permits at most four live challenges per
Node and 1,024 globally, purges expired entries before allocation, and refuses
new allocation when the global bound remains full. Source IP may be used for
rate limiting but never for identity.

## 10. Agent session

Successful authentication returns a 256-bit random canonical Base64URL session
ID and an expiry 10 minutes after issuance. The Monitor stores session state in
memory only:

```text
session ID digest
nodeId
keyVersion
physicalCameraId
issuedAt
expiresAt
highestSequence (initially absent)
64-bit sequence bitmap (initially zero)
recent request-nonce digests
```

Only one current Agent session is permitted per Node. Creating a replacement
session invalidates the previous session after the new proof succeeds. The
Agent keeps its raw session ID in memory only, begins renewal when two minutes
remain, and continues using the existing session until replacement succeeds or
the old session expires. A failed renewal does not create camera demand.

Monitor restart invalidates every challenge and Agent session. Agent restart
forgets its session and sequence, then authenticates again. Session state is
never placed in cookies, browser storage, files, logs, receipts, or PostgreSQL.

Every authenticated request reloads current Node and physical-camera registry
state. It requires active registrations and an exact `keyVersion` and
`physicalCameraId` match with the session. This is the rotation/disable
observation boundary; no long-lived registry cache is authoritative.

## 11. Request proof

The four authenticated write routes remain:

| Method | Canonical path | Proof domain |
|---|---|---|
| `POST` | `/internal/heartbeat` | `AEGIS-AGENT-HEARTBEAT-V1` |
| `POST` | `/internal/detections` | `AEGIS-ENGINE-DETECTION-V1` |
| `POST` | `/internal/alerts` | `AEGIS-ENGINE-ALERT-V1` |
| `POST` | `/internal/clips` | `AEGIS-ENGINE-CLIP-V1` |

Each request carries these headers:

```text
X-Aegis-Agent-Session
X-Aegis-Request-Nonce
X-Aegis-Request-Timestamp
X-Aegis-Request-Sequence
X-Aegis-Request-Signature
```

The Agent allocates a 128-bit random Base64URL nonce and a unique uint64
sequence centrally, serializes the JSON body once to UTF-8 bytes, hashes those
exact bytes, signs the route-specific canonical request, and transmits the same
bytes with `Content-Type: application/json`. Sequence is carried as an unsigned
decimal string so JavaScript does not lose precision above `2^53 - 1`.

The Monitor rejects query strings on signed routes. It accepts only the exact
uppercase method and fixed canonical path. It captures the raw request body
within the existing 16 KiB limit and hashes it before JSON parsing; it never
re-serializes parsed JSON for verification. A bodyless request hashes the SHA-256
of zero bytes.

Proof validation completes, including atomic replay-state acceptance, before a
route handler or store write runs. The middleware exposes only server-derived:

```text
verifiedNode.nodeId
verifiedNode.keyVersion
verifiedNode.physicalCameraId
verifiedNode.agentSessionId
```

Agent-auth routes are mounted separately from the legacy shared-key middleware.
For the four write routes, the presence of the complete Agent proof header set
selects Ed25519 verification; partial proof headers fail and never fall through.
Only a request with no Agent proof headers may enter the explicitly bounded
legacy compatibility branch. No authentication error triggers an automatic
fallback from Ed25519 to the shared key.

## 12. Canonical serialization

All canonical payloads are UTF-8, use LF (`0x0A`) separators, contain no BOM,
and have no trailing LF. Ed25519 signs the resulting bytes. Signatures are
unpadded Base64URL. Tokens are unpadded Base64URL and must begin with an ASCII
alphanumeric character. Integers are unsigned base-10 without leading zeroes
except the value zero. Hashes are 64 lowercase hexadecimal characters.

Text values are encoded as unpadded Base64URL of their exact UTF-8 bytes. This
prevents separators or Unicode normalization from changing field boundaries;
neither side performs Unicode normalization.

Auth canonical order:

```text
AEGIS-AGENT-AUTH-V1
challenge_id=<token>
nonce=<token>
issued_at_ms=<uint64>
expires_at_ms=<uint64>
audience_b64=<base64url(UTF-8 audience)>
purpose_b64=<base64url(UTF-8 "agent-authenticate")>
node_id_b64=<base64url(UTF-8 nodeId)>
key_version=<positive uint32>
```

Request canonical order:

```text
<route-specific proof domain>
session_id=<token>
request_nonce=<token>
timestamp_ms=<uint64>
sequence=<uint64>
method_b64=<base64url(UTF-8 uppercase method)>
path_b64=<base64url(UTF-8 canonical path)>
body_sha256=<lowercase hexadecimal digest>
```

Production audience is the non-secret constant
`urn:aegis:monitor:idea2:production`; isolated tests use
`urn:aegis:monitor:idea2:test`. Agent and Monitor configuration must match
exactly, and an unset or different audience fails closed.

## 13. Replay protection

The Agent owns one uint64 sequence counter per session and increments it under
one process-wide lock before any concurrent heartbeat or Engine operation can
sign. Sequence zero is invalid. Exhausting uint64 invalidates the session and
requires reauthentication.

For each Monitor session, `highest` is absent and `bitmap` is an unsigned
64-bit zero value initially. Bit zero represents `highest`; bit `n` represents
`highest - n`.

1. For the first valid sequence `s`, set `highest = s` and `bitmap = 1`.
2. If `s > highest`, set `delta = s - highest`. If `delta >= 64`, replace the
   bitmap with `1`. Otherwise set
   `bitmap = ((bitmap << delta) & ((1 << 64) - 1)) | 1`. Set `highest = s`.
3. If `s <= highest`, set `offset = highest - s`. Reject when `offset >= 64`.
   Otherwise compute `mask = 1 << offset`; reject when `bitmap & mask` is set,
   or atomically set `bitmap |= mask` when it is clear.

The replay transition is synchronous and atomic within the Monitor process.
Out-of-order requests inside the window are accepted once. Duplicate and
too-old sequences are rejected.

Nonce digests are also accepted once. They are retained until their request
timestamp can no longer pass the 30-second past/10-second future window, then
purged. This bounds memory by authenticated request rate while ensuring any
otherwise-acceptable nonce replay is rejected. Timestamp is accepted only when:

```text
MonitorNow - 30,000 <= timestamp_ms <= MonitorNow + 10,000
```

The exact boundaries are accepted; values outside them fail. Signature,
session, registry, timestamp, sequence, and nonce checks form one admission
operation. Replay state changes only after signature and registry checks pass
and before the application handler runs.

## 14. Key rotation

The current `detection_nodes` row remains the sole active public-key authority.
An Agent session binds the exact `nodeId` and `keyVersion` used to create it.
Every request performs a live registry read. A request admitted before a
concurrent rotation commits is ordered before that rotation; any admission
that reads after the committed rotation sees the new version and rejects the
old session. No cache grace period or legacy-key fallback exists for an
`ed25519_required` node.

`manage_nodes.py rotate-key` remains the server-side key update mechanism and
must increment `key_version` atomically with the public key/fingerprint update.
The implementation plan must add an explicit Windows provisioning workflow
that proves new Agent authentication before deleting the old encrypted blob.
Unknown versions, inactive Nodes, inactive physical cameras, and sessions whose
physical mapping changed all fail closed.

## 15. Detector B staged transition

The latest accepted Detector B receipt identifies the current Linux Node as
`edge-node-02` and documents shared-key ingest. CP3 does not encode that value
in a migration or assume the Production registry still matches the receipt.
Rollout must first list the live registry without printing public-key payloads
and confirm the exact Detector B row operationally.

Migration 004 adds an explicit per-Node `ingest_auth_mode` with allowed values
`legacy_shared_key` and `ed25519_required`. Existing rows receive
`legacy_shared_key`, preserving Detector B. The Monitor deploys dual-mode
middleware before any row is changed. Machine A's registered row is switched
to `ed25519_required` only after its Agent proves the new path in the controlled
environment.

The legacy shared key remains a compatibility principal, not physical Node
proof. A legacy request may retain current logical-only behavior, but middleware
sets no trusted `verifiedNode` and no trusted `physical_camera_id`. A body
claim naming an `ed25519_required` Node or its physical camera is rejected; a
shared key can never downgrade or mint trusted provenance for Machine A.
Detector B remains operational until a separately approved key-provisioning
session changes its exact registry row.

Because the current global shared key cannot distinguish legacy nodes from one
another, a shared-key caller is represented as `legacy_unverified`, never as a
specific authenticated Node. A supplied Node value may be used only to reject a
claim against an `ed25519_required` registration. It cannot populate trusted
Node or physical-camera fields. This preserves existing Detector B behavior
without overstating the security of the transitional credential.

## 16. Physical provenance

For Ed25519-authenticated writes, handlers ignore body `nodeId` and
`physicalCameraId`. They receive `verifiedNode` from proof middleware and pass
its server-resolved values to the store. Heartbeat is keyed by
`physicalCameraId`; detections, alerts, and clips persist that same trusted
physical provenance where the current schema supports it.

Logical `cameraId` remains the event-time/business alias and is validated by
existing policy/lifecycle boundaries. It does not move the physical camera.
Heartbeat remains telemetry and cannot register a Node, select an alias,
authenticate a caller, acquire a producer, or create stream demand.

Legacy shared-key writes keep nullable physical provenance. They must never
copy `physicalCameraId` from a body into a trusted column. Reads that need
cryptographically trusted physical provenance distinguish non-null verified
values from legacy logical-only rows.

## 17. Error behavior

The public error contract is deterministic and non-secret:

| Condition | Result | Write allowed |
|---|---:|---:|
| malformed challenge request | `400 INVALID_REQUEST` | no |
| unknown/disabled Node or inactive physical camera | `401 AUTHENTICATION_FAILED` | no |
| unknown/rotated key version | `401 AUTHENTICATION_FAILED` | no |
| expired/reused challenge | `401 AUTHENTICATION_FAILED` | no |
| wrong signature/audience/purpose/domain | `401 AUTHENTICATION_FAILED` | no |
| missing/expired/replaced Agent session | `401 AUTHENTICATION_FAILED` | no |
| bad body hash, method, path, or query string | `401 REQUEST_PROOF_FAILED` | no |
| stale/future timestamp | `401 REQUEST_PROOF_FAILED` | no |
| duplicate nonce/sequence or too-old sequence | `401 REQUEST_PROOF_FAILED` | no |
| malformed or unauthorized pipe operation | local `INVALID_OPERATION` | no |
| Agent unavailable from Engine | local `AGENT_UNAVAILABLE`; Engine fails soft | no |
| registry/database unavailable during verification | `503 IDENTITY_SERVICE_UNAVAILABLE` | no |
| bounded challenge/session capacity reached | `503 IDENTITY_SERVICE_UNAVAILABLE` | no |

Challenge expiry and session expiry use `now >= expiresAt` as expired. Error
bodies never reveal whether a public key, challenge, Node, session, or nonce
exists. Security logs contain stable reason categories, request correlation,
and non-secret Node fingerprint metadata only; they never contain keys,
signatures, session IDs, nonces, canonical payloads, bodies, credentials, or
biometric data.

## 18. Camera invariants

CP3 preserves these rules without editing camera lifecycle code:

- Machine A can run only physical camera A; Machine B only physical camera B;
  Machine C only physical camera C.
- `operator` selects logical `CAM-01`; `operator2` selects `CAM-02`.
- A username never selects or relocates a physical camera.
- Engine or Agent startup leaves the camera closed.
- Authentication, heartbeat, session renewal, failed IPC, and retry traffic
  create zero demand and acquire no producer lease.
- Only a legitimate Operator stream demand may activate a camera in CP5.
- Multiple demanding Operator tabs remain reference-counted; the last release
  or logout releases the camera.
- SOC remains passive and cannot wake, own, or retain a camera.
- One physical camera cannot emit `CAM-01` and `CAM-02` simultaneously.

The complete account/machine matrix is therefore:

| Verified machine | Authenticated account | Physical camera | Logical alias |
|---|---|---|---|
| Machine A | `operator` | physical camera A | `CAM-01` |
| Machine A | `operator2` | physical camera A | `CAM-02` |
| Machine B | `operator` | physical camera B | `CAM-01` |
| Machine B | `operator2` | physical camera B | `CAM-02` |
| Machine C | `operator` | physical camera C | `CAM-01` |
| Machine C | `operator2` | physical camera C | `CAM-02` |

SOC may observe an alias only while legitimate Operator demand already owns its
producer. SOC never creates the producer or demand that makes it active.

Regression tests must prove these properties even though CP3 does not own their
implementation.

## 19. Database and migration impact

Migrations 001–003 remain byte-for-byte immutable. CP3 requires one additive,
idempotent migration named conceptually
`004_detection_node_ingest_auth_mode.sql`. It adds to `detection_nodes`:

```text
ingest_auth_mode TEXT NOT NULL DEFAULT 'legacy_shared_key'
CHECK (ingest_auth_mode IN ('legacy_shared_key', 'ed25519_required'))
```

The default is compatibility-safe and performs no Node-specific data update.
Schema bootstrap receives the same column/constraint. The administrative CLI
gains an explicit mode-change command that requires an exact Node ID and prints
only non-secret metadata. Setting `ed25519_required` is a reviewed operational
action, not a migration side effect.

Challenges, Agent sessions, sequence windows, and nonce replay state remain
memory-only. The existing `node_request_nonces` table is not deleted or
repurposed by CP3. No table is dropped, truncated, recreated, or destructively
rewritten. Existing nullable `physical_camera_id` event provenance remains
backward compatible for legacy rows.

## 20. Test strategy

Implementation follows TDD with deterministic clocks, random sources, and
cross-language vectors.

### Monitor tests

- challenge shape, 60-second TTL, audience/purpose binding, bounds, and generic
  failures for unknown/disabled/inactive registrations;
- valid Ed25519 proof and atomic one-winner challenge consumption;
- failed proof does not consume; exact-expiry failure; replay failure;
- 10-minute session, two-minute renewal behavior, replacement, restart loss,
  and live key-version/active/physical-registration revalidation;
- canonical Node/Python vectors and every cross-domain rejection pair;
- exact raw-body hashing, empty-body hash, changed body/method/path, and query
  rejection;
- past/future timestamp boundaries and failures;
- 64-entry bitmap transitions, accepted out-of-order sequences, duplicates,
  old values, uint64 bounds, nonce replay, and concurrent acceptance;
- middleware-derived physical provenance and ignored client identity claims;
- migration 004 additive/idempotent behavior and administrative mode changes;
- `ed25519_required` cannot use shared key; legacy Detector B compatibility
  stays logical-only and never gains trusted physical provenance.

### Agent and Engine tests

- fixed canonical auth/request vectors match Node byte-for-byte;
- DPAPI adapter never exposes plaintext through its public interface;
- Agent session acquisition, renewal, expiry, Monitor restart, Agent restart,
  and fail-soft recovery;
- exact transmitted JSON bytes equal the bytes hashed before signing;
- concurrent four-operation load allocates unique monotonic sequences/nonces;
- named pipe accepts only the four schemas and rejects signing-oracle fields,
  identity fields, oversized messages, remote access, and unauthorized SIDs;
- Engine process contains no application private key, DPAPI decrypt call,
  Agent session ID, or signing primitive.

### Windows acceptance tests

- service runs under `NT SERVICE\AEGISIdentityAgent` and DPAPI CurrentUser
  round trip succeeds under that identity;
- encrypted key survives service restart and Windows reboot;
- file owner/inheritance/DACL match the exact service-SID-plus-SYSTEM contract;
- designated interactive user cannot read the encrypted blob directly and no
  plaintext private key is persisted;
- repair/uninstall do not print or broaden access to the key;
- the existing SSH identity files and fingerprints remain unchanged;
- pipe rejects a process under an unauthorized SID and accepts the configured
  Engine identity.

### Regression and negative controls

- Engine startup, Agent authentication, heartbeat, and renewal leave camera
  closed with zero demand;
- Monitor full suite, Engine full suite, browser suite, `liveCamera`, design
  contract, UI-freeze, and Vite production build stay green;
- no Monitor React source changes occur;
- Detector B legacy heartbeat/ingest remains green in an isolated PostgreSQL
  environment;
- controlled mutations prove domain, body-hash, replay-window, rotation,
  physical-provenance, and pipe-schema guards are load-bearing, then restore
  the source before staging.

## 21. Rollout boundaries

CP3 rollout is staged and stops at each evidence boundary:

1. Implement and verify migration 004, Monitor dual-mode authentication, and
   Agent protocol locally with disposable PostgreSQL.
2. Build/install the Identity Agent on Machine A without changing the Engine's
   camera startup or Producer lifecycle.
3. Generate the application key under the service identity, export only its
   public key, and register it through the reviewed server CLI.
4. Verify Agent auth, renewal, heartbeat, each ingest operation, restart loss,
   key ACLs, and camera-stays-closed negative controls while Machine A remains
   in compatibility mode.
5. Change only the verified Machine A registry row to `ed25519_required` and
   repeat the complete acceptance matrix.
6. Leave the confirmed Detector B row in `legacy_shared_key` until its own
   migration is separately approved.

The current Machine A runtime posts HTTP through an SSH local forward. That is
not the CP3 application-transport endpoint. Before Machine A can be switched to
`ed25519_required`, infrastructure review must provide a certificate-validated
internal HTTPS origin in `AEGIS_AGENT_MONITOR_BASE_URL` that reaches only the
required `/internal/agent-auth/*` and signed ingest routes. The Agent does not
disable TLS verification and does not treat SSH tunnelling alone as HTTPS.

No step authorizes Production database mutation, Docker changes, firewall or
Twingate changes, model/training changes, browser association, or camera
lifecycle changes. Those actions require their own reviewed execution gate.

## 22. Rollback considerations

Before Machine A is set to `ed25519_required`, rollback is removal/disablement
of the new Agent service and restoration of the prior Engine package; Detector
B is unaffected. After the mode switch, rollback must be explicit: first
disable Machine A ingest or, only with human approval and a documented security
exception, change that exact registry row back to `legacy_shared_key`. The
Monitor must never auto-downgrade after authentication failure.

Migration 004 is additive and normally remains in place during rollback. The
default and constraint are compatible with the previous runtime. The encrypted
Machine A key blob is preserved for forensic recovery unless the human owner
separately approves secure deletion. Rollback never restores body-provided
physical provenance as trusted data.

## 23. CP4 boundary

CP4 owns browser-to-local-machine association. It may use a separately scoped
local Agent challenge to bind a verified Node to a server-side browser session,
but it must use a distinct proof domain and must not expose the CP3 private key,
Agent session, request-signing endpoint, or named pipe to JavaScript. Browser
`nodeId`, `cameraId`, IP, hostname, User-Agent, local/session storage, query
parameters, and unsigned headers remain non-authoritative.

CP3 provides no browser route to the Agent and no verified-browser-node
context. CP4 must consume this spec's Node/physical identity model without
changing the ingest domains or turning a browser into an Engine principal.

## 24. CP5 boundary

CP5 owns Operator demand, account-to-logical-alias resolution, producer lease
acquisition/renewal/release, Engine camera activation, multi-tab reference
counting, logout cleanup, SOC passive observation, and the invariant that one
physical camera cannot produce two logical aliases simultaneously.

CP3 authentication establishes who the Agent is and the physical camera
registered to its Node. It does not authorize a logical producer, create or
retain demand, call the local camera API, or decide which account is active.
CP5 may rely on CP3 `verifiedNode` provenance, but CP3 may not pre-empt CP5 by
embedding camera lifecycle behavior in authentication or heartbeat.

## 25. Known limitations

- CP3 in-memory challenge/session/replay state is single-Monitor-process state.
  Multiple Monitor replicas require a future shared atomic store before this
  protocol can scale horizontally.
- Monitor restart forces reauthentication and may temporarily drop heartbeat
  or event mirrors; the Engine remains fail-soft and local footage remains the
  authoritative source described by the current runtime.
- Proof acceptance is at-most-once per sequence/nonce, but CP3 does not add a
  cross-retry application idempotency key. A response lost after a committed
  write can leave the Agent uncertain; safe backfill/deduplication is separate
  work.
- A compromised designated Engine account can submit allowed structured events
  through the pipe. The design isolates the key and prevents arbitrary signing,
  but it does not attest camera hardware, executable integrity, or biometric
  correctness.
- DPAPI CurrentUser behavior under the selected virtual service account and
  exact pipe/ACL behavior require real Windows acceptance; source tests alone
  cannot prove them. Failure of the DPAPI preflight has no weaker fallback.
- Detector B remains on a legacy shared bearer key and lacks cryptographically
  trusted physical provenance until a separate staged migration.
- The existing public gateway blocks `/monitor/internal`; Machine A requires a
  separately reviewed internal HTTPS route and certificate trust before runtime
  cutover. The current HTTP-over-SSH Monitor URL is insufficient for the locked
  CP3 transport contract.
- CP3 supplies no browser association and no camera demand. Those user-visible
  outcomes remain explicitly assigned to CP4 and CP5.
