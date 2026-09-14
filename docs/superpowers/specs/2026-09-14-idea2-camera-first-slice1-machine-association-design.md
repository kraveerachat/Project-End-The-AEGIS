---
title: AEGIS IDEA2 Camera-First Slice 1 Machine Association Design
date: 2026-09-14
status: owner-review
owner: pub
area: idea2
---

# AEGIS IDEA2 Camera-First Slice 1 — Machine Association Design

## 1. Goal

Camera-First Slice 1 establishes the first currently broken runtime boundary:
an authenticated Monitor Operator session must become cryptographically bound
to the verified local Node and therefore to that Node's registered physical
camera before Monitor opens an upstream stream.

The first acceptance target is Machine A. A successful flow is:

```text
authenticated browser session
  -> one-time Monitor challenge
  -> Machine A Identity Agent assertion
  -> Monitor verifies Node registration and Ed25519 signature
  -> server session stores verified Node and physical camera identity
  -> authenticated account resolves its logical alias
  -> Monitor resolves the physical stream source
  -> existing Engine /stream.mjpg
```

This design is documentation only. It does not authorize source, test,
database, Windows, Docker, or Production mutation.

## 2. Non-goals

Slice 1 does not implement CP3 authenticated heartbeat, detection, alert, or
clip ingest. It does not implement producer leases, producer generations,
cross-machine logical-alias exclusivity, complete demanding/passive viewer
lifecycle, final SOC passive remediation, multi-machine Production rollout,
camera-device redesign, model changes, retraining, biometric changes, or a
Monitor visual redesign.

The slice does not move a physical camera between accounts or machines. It
does not make heartbeat, camera assignment, browser input, IP address,
hostname, User-Agent, browser storage, query strings, or unsigned headers an
identity or camera-authority source.

## 3. Current proven boundary

The current Monitor login creates a server-side authenticated session with a
user, creation time, and CSRF token. It does not create a verified local-Node
association. The current `GET /api/cameras/:id/stream` route authorizes the
browser-supplied logical ID through legacy visibility checks and then calls
`streamSourceFor(cameraId)`, which reads logical `camera_heartbeat` state.

The authoritative registry and physical source primitive already exist:
`detection_nodes`, `physical_cameras`, `node_camera_alias_policy`,
`node_account_camera_alias`, `getPhysicalCameraForNode()`, and
`streamSourceForPhysicalCamera()`. The first broken boundary is therefore:

```text
AUTHENTICATED_MONITOR_SESSION
  -> VERIFIED_LOCAL_NODE_AND_PHYSICAL_MACHINE_ASSOCIATION
```

The Engine already exposes API-key-protected `/stream.mjpg`, `StreamHub`
counts stream viewers, and `VideoCatcher` supports deferred camera open and
release. No physical camera hardware failure is proven by the current audit.

## 4. Camera contract

Physical origin is machine-based and immutable for the session:

```text
Machine A -> physical camera A only
Machine B -> physical camera B only
Machine C -> physical camera C only
```

Logical alias is account-based policy:

```text
operator  -> CAM-01
operator2 -> CAM-02
```

The resulting contract is:

| Machine | Account | Physical producer | Logical alias |
|---|---|---|---|
| A | operator | physical camera A | CAM-01 |
| A | operator2 | physical camera A | CAM-02 |
| B | operator | physical camera B | CAM-01 |
| B | operator2 | physical camera B | CAM-02 |
| C | operator | physical camera C | CAM-01 |
| C | operator2 | physical camera C | CAM-02 |

An account never moves or selects physical origin. One physical camera must
not actively produce CAM-01 and CAM-02 simultaneously. That exclusivity is a
CP5 producer-lifecycle concern and is not implemented by Slice 1.

The lifecycle contract remains: Engine startup, login, and association leave
the camera closed; the first legitimate Operator stream opens it; the camera
stays open while at least one legitimate demanding Operator stream remains;
the final disconnect or logout releases it. SOC is passive and must not wake,
own, demand, or retain a camera. Slice 1 proves the Machine A Operator path but
does not claim final SOC compliance.

## 5. Existing reusable architecture

Slice 1 builds on these current components without redefining them:

- Monitor authentication, session fixation protection, HttpOnly session
  cookie, SameSite policy, absolute session timeout, and CSRF token.
- Server-authoritative `detection_nodes` public-key registration and key
  version.
- One active `physical_cameras` registration per Node.
- `node_camera_alias_policy` and `node_account_camera_alias` as logical policy,
  separate from physical identity and `camera_assignment`.
- `streamSourceForPhysicalCamera(physicalCameraId)` over
  `physical_camera_heartbeat`.
- Monitor's backend-only stream proxy and Engine API-key boundary.
- Engine `/stream.mjpg`, `StreamHub`, and `VideoCatcher` capture-on-demand
  behavior.
- CP3's dedicated `AEGISIdentityAgent`, service identity, Ed25519 application
  key, public-key-only server registration, DPAPI CurrentUser storage, and
  separation from SSH identity.

Reuse does not mean the current route is already safe. Session association and
physical stream selection remain absent and must be introduced under TDD.

## 6. Target Slice 1 architecture

```text
Browser / Monitor origin
  | authenticated cookie + CSRF only to Monitor
  | public one-time challenge only to loopback
  v
Identity Agent browser listener (127.0.0.1:8078)
  | fixed AEGIS-BROWSER-NODE-ASSOCIATION-V1 assertion
  | Node ID and key version supplied by Agent, not browser
  v
Monitor association verifier
  | live user, Node, key version, public key, physical mapping checks
  v
server-side session.localNode
  | nodeId + physicalCameraId + keyVersion + bounded times
  v
camera authorization
  | user+Node policy -> logical alias
  | Node registration -> physical camera
  v
streamSourceForPhysicalCamera(physicalCameraId)
  v
existing Engine /stream.mjpg
```

The browser transports public challenge and proof material but never becomes
authority for Node ID, physical-camera ID, or machine identity. The logical
alias in the route is a requested display/business alias and must equal the
server-authorized alias.

## 7. Browser association protocol

The proof domain is exactly `AEGIS-BROWSER-NODE-ASSOCIATION-V1`. It is distinct
from the CP3 domains `AEGIS-AGENT-AUTH-V1`,
`AEGIS-AGENT-HEARTBEAT-V1`, `AEGIS-ENGINE-DETECTION-V1`,
`AEGIS-ENGINE-ALERT-V1`, and `AEGIS-ENGINE-CLIP-V1`. Cross-domain proof use
must fail.

Monitor issues a JSON challenge with exactly these public wire fields:

```text
version
purpose
audience
challenge_id
challenge_nonce
session_binding
issued_at_ms
expires_at_ms
```

`version` is `1`; `purpose` is
`AEGIS-BROWSER-NODE-ASSOCIATION-V1`; `audience` is the configured canonical
Monitor audience; IDs/nonces/session binding are canonical Base64URL opaque
tokens beginning with an ASCII alphanumeric character; timestamps are safe
integer UTC epoch milliseconds. Challenge lifetime is 30 seconds.

The Agent returns exactly:

```json
{
  "claims": {
    "version": 1,
    "purpose": "AEGIS-BROWSER-NODE-ASSOCIATION-V1",
    "audience": "configured-monitor-audience",
    "challenge_id": "opaque",
    "challenge_nonce": "opaque",
    "session_binding": "opaque",
    "node_id": "agent-owned-node",
    "key_version": 1,
    "issued_at_ms": 0,
    "expires_at_ms": 1
  },
  "signature": "canonical-base64url-ed25519-signature"
}
```

The canonical signed bytes use UTF-8, the prefix
`AEGIS-BROWSER-NODE-ASSOCIATION-V1\n`, one field per line in the exact order
shown above, decimal integers without leading zeros, and Base64URL encoding of
text field bytes. Unknown, missing, repeated, non-canonical, oversized, or
wrong-type fields are rejected. The browser cannot supply `node_id` or
`key_version`; the Agent appends its configured public identity before
canonicalization and signing.

The browser requests a challenge from Monitor with authenticated cookie and
valid CSRF, sends only the challenge to loopback with credentials omitted,
then returns the assertion to Monitor with its authenticated cookie and CSRF.
No association data is persisted in browser storage or custom authority
headers.

## 8. Local Agent browser endpoint

The browser-facing listener is part of the dedicated Identity Agent, not the
Detection Engine. It binds exactly `127.0.0.1:8078`; IPv6 and non-loopback
binding are disabled unless a later reviewed design adds an equivalent exact
loopback binding. Its only browser protocol is:

```text
OPTIONS /v1/browser-association/assert
POST    /v1/browser-association/assert
```

The listener accepts only `Content-Type: application/json`, reads at most
16,384 bytes including chunked bodies, rejects invalid UTF-8, duplicate JSON
keys, non-object roots, unknown fields, redirects, query strings, and path
variants. It never follows or accepts a browser-supplied URL.

Allowed origins come from the mandatory Agent configuration
`AEGIS_IDENTITY_BROWSER_ALLOWED_ORIGINS`. Each entry is an exact serialized
origin. Wildcards, suffix matching, credentials in origins, path/query parts,
and `null` Origin are rejected. HTTPS is required except for explicit
loopback development origins. CORS echoes only the matched origin, permits
only `POST, OPTIONS` and `Content-Type`, sets `Vary: Origin`, never enables
credentials, and answers Private Network Access preflight only after the same
exact checks. Origin is a request boundary, never machine identity.

The Agent enforces a historical-compatible limit of 12 assertion attempts per
allowed origin per rolling 60 seconds. Errors are bounded generic JSON without
claims, key bytes, signatures, configured paths, stack traces, or timing
details. The browser endpoint exposes neither generic `sign(data)` nor CP3
Agent sessions, ingest signing, internal named-pipe operations, Engine IPC,
private-key bytes, or raw canonical signing primitives.

## 9. Monitor verification

Monitor adds two authenticated, CSRF-protected routes:

```text
POST /api/local-node/challenge
POST /api/local-node/verify
```

Only a live, active `CCTV-Operator` account may receive or verify a challenge.
The challenge is stored under the current server session and may not be moved
between sessions. Verification consumes the challenge atomically before any
asynchronous registry lookup, checks the exact stored challenge, time bounds,
domain, audience, canonical encoding, Ed25519 signature, live Node active
state, exact key version, and active Node-to-physical-camera mapping.

Monitor derives the public key from `detection_nodes` and physical identity
from `physical_cameras`. It never derives either from heartbeat or assertion
body claims beyond using Agent-signed `node_id`/`key_version` to select and
then verify the registered identity. A body/query/header logical camera,
physical camera, IP, hostname, User-Agent, or browser-stored value is ignored
as authority and cannot override the registry.

## 10. Server-side session binding

Each successful login regeneration creates a new 32-byte canonical Base64URL
`nodeSessionBinding` in the server-side session. A successful proof creates:

```js
session.localNode = {
  nodeId,
  physicalCameraId,
  keyVersion,
  verifiedAt,
  expiresAt,
}
```

The cookie remains an opaque session ID; these fields are never returned as
browser-settable authority. Association lifetime is five minutes. Re-login or
session regeneration replaces the binding and clears all prior challenges and
local-Node context. Logout destroys the entire server session. Absolute or
idle session expiry therefore also clears association.

Every stream open and periodic long-stream revalidation must re-read the live
account, active Node registration, exact key version, active physical mapping,
and session expiry. Node disable, key rotation, mapping removal, mapping
deactivation, or physical-camera remap clears the association and terminates
the stream fail closed. Monitor process restart invalidates its in-memory
sessions/challenges and requires login/association again; no browser value may
reconstruct authority.

## 11. Account logical-alias authorization

The live authenticated account decides whether camera operation is allowed
and which logical alias is authorized; the verified Node decides which
physical camera exists on that machine. The server reads
`node_camera_alias_policy` and `node_account_camera_alias(node_id, user_id)`.
For the approved A/B/C policy, every registered Node uses account mode and has
server-provisioned rows mapping the `operator` account to CAM-01 and
`operator2` to CAM-02. Usernames are not hardcoded in route logic; policy rows
refer to live user IDs.

`camera_assignment` remains the responsibility, notification, and
administrative-scoping model. It is not machine-local activation authority.
Heartbeat remains telemetry. The route path may contain CAM-01 or CAM-02, but
Monitor must compare it to the live policy result and return denial on a
mismatch before opening an Engine connection.

## 12. Physical stream resolution

Slice 1 changes the Operator stream authorization path conceptually as
follows:

```text
GET /api/cameras/:id/stream
  -> authenticated, active Operator
  -> current valid session.localNode
  -> live Node/key/physical mapping validation
  -> live account logical-alias resolution
  -> require params.id == authorized logical alias
  -> streamSourceForPhysicalCamera(physicalCameraId)
  -> freshness/source validation
  -> existing API-key-protected Engine fetch
```

The physical source comes only from `physical_camera_heartbeat` keyed by the
registry-derived `physicalCameraId`. Logical `camera_heartbeat`, a body field,
or URL alias cannot redirect physical source. A missing association, invalid
mapping, or alias mismatch is denied before network I/O. A missing or stale
physical source returns service unavailable without falling back to logical
heartbeat.

For source rollout, strict association is controlled by a server deployment
switch named `AEGIS_REQUIRE_LOCAL_NODE_ASSOCIATION`, defaulting to false until
the human runtime gates are complete. When false, the already-existing legacy
route remains unchanged for non-Machine-A operation. When true, Operator
streaming has no legacy fallback. Machine A acceptance must run with the
switch true. Production-wide enablement is not permitted until Machines B/C
have compatible Agents or a separately reviewed isolated canary deployment is
available. This switch controls route selection only; it never grants identity
or camera authority.

## 13. Capture-on-demand runtime requirement

Machine A must run with `AEGIS_CAPTURE_ON_DEMAND=true`. The repository default
stays false. This is a human-controlled Machine A runtime/configuration gate,
not a source-default change.

Acceptance evidence must record fresh Engine health/metrics at five points:

| Point | Required camera state |
|---|---|
| Engine startup | disconnected, not demanded, zero viewers |
| Operator login | unchanged |
| successful local association | unchanged |
| first authorized stream | demanded and physical camera A connected |
| final stream disconnect or logout | zero viewers/demand and camera released |

Source tests may prove state transitions, but only the human Machine A gate
may claim real webcam open/release behavior.

## 14. Error and fail-closed behavior

| Condition | Result | Authority created |
|---|---|---|
| unauthenticated challenge/verify | `401 NOT_AUTHENTICATED` | no |
| inactive or wrong-role account | `403 LOCAL_NODE_ASSOCIATION_DENIED` | no |
| malformed/expired/replayed/wrong-domain proof | `401 LOCAL_NODE_PROOF_INVALID` | no |
| Agent unavailable or loopback timeout | camera UI reports association unavailable; login remains valid | no |
| registry/database unavailable | `503 LOCAL_NODE_REGISTRY_UNAVAILABLE` | no |
| unknown/disabled Node or key mismatch | `403 LOCAL_NODE_ASSOCIATION_DENIED` | no |
| missing/stale/remapped physical mapping | `403 LOCAL_NODE_ASSOCIATION_DENIED` | no |
| missing association on strict stream route | `403 LOCAL_NODE_ASSOCIATION_REQUIRED` | no |
| logical alias mismatch | `403 CAMERA_ALIAS_DENIED` | no |
| missing/stale physical heartbeat/source | `503 PHYSICAL_STREAM_UNAVAILABLE` | no |

Errors never include secrets, public-key bodies, raw signatures, challenge
nonces, session bindings, internal URLs, or stack traces. Registry uncertainty
does not fall back to heartbeat or legacy identity in strict mode.

## 15. Replay, expiry, and renewal

Challenge TTL is 30 seconds. At the exact expiry instant it is expired. A
server session retains at most eight unexpired outstanding challenges; issuing
another evicts the oldest. Verification removes the session challenge before
awaiting registry or signature work and records its digest in the
single-instance replay cache through expiry, so concurrent replay cannot win.
A failed proof is consumed.

Association TTL is five minutes. The browser begins renewal when 60 seconds
remain, uses a 10-second bounded attempt, and retries at five-second intervals
without extending authority. A failed renewal does not revoke an independently
valid prior association; it remains valid only to its original expiry and only
while live server revalidation passes. At expiry, stream authorization fails
closed and active streams terminate. Renewal restores access only after a new
valid assertion is stored server-side.

Browser tab closure stops renewal but does not itself create or release camera
demand; stream connection closure drives the existing Engine viewer release.
Logout destroys association and closes the proxied stream. Monitor restart
invalidates the association. Agent restart retains only its protected identity
key; it creates no browser authority until it signs a fresh Monitor challenge.

## 16. Historical work reconciliation

No historical commit is cherry-picked.

| Commit | Classification | Decision |
|---|---|---|
| `303e2398` | ADAPT | Reuse challenge/verify route and browser orchestration shapes, but bind them to the current registry/session model and dedicated Agent. |
| `05e64e54` | REJECT | Reject the Engine-hosted browser assertion endpoint and any coupling of browser association to Engine port 8077; retain only bounded-body/Origin test ideas. |
| `cc957886` | ADAPT | Reuse centralized camera authorization and live registry revalidation concepts; update them to the current physical identity and account-alias contract. |
| `2bce2dc3` | REUSE_CONCEPT | Preserve physical/logical separation and producer-exclusivity model; do not implement lease acquisition in Slice 1. |
| `2814add7` | REUSE_CONCEPT | Preserve explicit demanding versus passive semantics and release expectations; do not import CP5 runtime. |
| `38098892` | REJECT | Do not import the broad lifecycle/Engine diff into this slice; current Engine core is protected. |
| `d0c6d48f` | ADAPT | Reuse renewal timings, physical producer resolution tests, and fail-closed revalidation concepts; exclude authenticated ingest and producer generation. |
| `1fa3e105` | ADAPT | Reuse prior-proof bounded renewal and deterministic expiry/replay semantics; move signing to the dedicated Identity Agent and use the new domain. |

The current approved CP3 design overrides every stale pattern that exposes a
browser endpoint from the Engine, lets JavaScript reach the CP3 named pipe or
Agent session, or gives the browser a generic signing primitive.

## 17. File impact

Expected Slice 1 implementation work is bounded to:

- Monitor proof/canonicalization, challenge service, session establishment,
  camera authorization, stream route, database adapters, and focused tests.
- A minimal browser association client integrated without visual or styling
  changes.
- The dedicated Identity Agent package with one browser-association module,
  exact-origin configuration, service composition, and focused tests.
- Deployment examples/runbook entries documenting the dedicated loopback port,
  strict rollout switch, and human capture-on-demand gate without secrets.

Likely paths include `IDEA2-AEGIS_Monitor/server/nodeIdentity/`,
`server/auth/session.js`, `server/auth/cameraAccess.js`, `server/routes/api.js`,
`server/db/connection.js`, `server/db/store.js`, `src/lib/localNode.js`, focused
Monitor tests, and new modules under
`IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_identity_agent/`. Exact files
and commit boundaries belong in the reviewed implementation plan.

`server/streamLifecycle.js` is not expected to change. Any discovered need to
change it stops Slice 1 for review because lifecycle ownership belongs to CP5.

## 18. Protected files

These files are strong no-change boundaries:

```text
IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/stream_hub.py
IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/video_catcher.py
IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/camera_devices.py
```

All model source, model weights, training data, biometric enrollment, and
biometric data remain unchanged. The implementation must record pre/post
hashes or Git diffs for these boundaries. Private keys, recordings, clips,
models, enrollment data, database dumps, dependencies, build output, and local
AI settings are never committed.

## 19. Test strategy

Implementation is test-driven. Each implementation task starts with a focused
failure, records the intended reason, applies the smallest source change, runs
targeted and regression tests, receives scoped review, and has an isolated
commit boundary.

Association tests cover valid Machine A proof; forged Node; wrong signature;
wrong domain; expired/exact-boundary challenge; replay and concurrent replay;
stale association; disabled Node; key rotation; remapped/deactivated physical
camera; wrong role; inactive account; registry failure; strict Origin/CORS;
chunked/oversized body; duplicate keys; and rejection of browser authority.

Account tests prove operator -> CAM-01, operator2 -> CAM-02, both use the same
Machine A physical camera, path alias mismatch is denied, and physical identity
cannot be selected from browser fields or heartbeat.

Stream tests prove valid Machine A association calls
`streamSourceForPhysicalCamera`, missing association fails in strict mode,
missing/stale physical source fails, logical heartbeat cannot override
physical authority, and long streams close after live account/Node/key/mapping
revocation.

Camera regression tests prove startup, login, and association leave capture
closed; first real Operator stream opens it; and final disconnect/logout
closes it. Existing Monitor tests, `liveCamera`, browser tests, design-contract
tests, UI-freeze tests, and the full Engine suite run before completion.
Historical Engine stream-generation failures are recorded separately if they
reappear; Slice 1 does not relabel an unrelated baseline failure as its own
regression.

Mutation checks temporarily remove the post-challenge consume guard, signature
verification, live mapping equality check, logical alias equality check, and
physical source selection in turn; each focused test must fail before the guard
is restored. Mutations are never staged or committed.

## 20. Human runtime gates

`S1-H1` verifies and, only after separate approval, installs the dedicated
Machine A Identity Agent prerequisites, service identity, protected key, exact
Origin configuration, and public registration. It records no private material.

`S1-H2` runs a real Machine A browser association: authenticated login,
challenge, loopback assertion, Monitor verification, live registry lookup, and
server-session binding. It proves forged/replayed proof denial without exposing
tokens.

`S1-H3` reads the installed Machine A runtime configuration and confirms
`AEGIS_CAPTURE_ON_DEMAND=true`, stream enabled, and Engine API-key availability.
It changes no unrelated setting; a mismatch blocks acceptance until the human
authorizes a separate configuration change.

`S1-H4` performs the local real-camera sequence: Engine start closed; login
closed; association closed; first authorized Operator stream open; final
disconnect/logout closed. It captures redacted Engine/Monitor state and viewer
counts.

`S1-H5` is a controlled server/Production deployment acceptance only after PR
review and merge plus a separately approved rollout/rollback command. Codex
does not execute any of these runtime gates automatically.

## 21. Machine A acceptance

Slice 1 succeeds only when all twelve conditions are proven:

1. Machine A Engine starts with its camera closed.
2. Browser authentication works normally.
3. The server-side browser session cryptographically associates with Machine A.
4. Monitor resolves Machine A's physical camera from the live registry.
5. `operator` resolves CAM-01.
6. `operator2` resolves CAM-02.
7. Both accounts use Machine A's same physical camera.
8. Login and association alone leave the camera closed.
9. The first authorized stream demand opens physical camera A.
10. Final disconnect or logout releases physical camera A.
11. Browser attempts to forge another Node, physical camera, or alias fail.
12. Protected camera/model/training paths remain unchanged.

SOC final compliance is not claimed by this acceptance.

## 22. B/C forward compatibility

No code may encode `Machine A == CAM-01`. The reusable relation is:

```text
verified Node -> its one active registered physical camera
authenticated account + verified Node -> one authorized logical alias
```

The same implementation therefore supports Machine B + operator as physical B
+ CAM-01 and Machine C + operator2 as physical C + CAM-02 once each machine has
an approved Agent and registry/policy provisioning. Slice 1 does not deploy to
Machines B/C. The rollout switch stays false for legacy installations until
their compatibility gate is complete; strict mode never falls back after it is
enabled.

## 23. Rollback

Source rollback disables `AEGIS_REQUIRE_LOCAL_NODE_ASSOCIATION` and restores
the previously reviewed Monitor image/code without deleting Node, physical
camera, or alias-policy data. Machine A Agent rollback stops/removes only the
dedicated browser listener/service package under its reviewed runbook while
preserving the encrypted identity key unless key deletion receives separate
approval. Engine code, camera device configuration, models, enrollment, SSH
tunnel, and physical-camera registration are not rewritten.

Every deployment requires an immutable prior Monitor image/reference, exact
installed source SHA, health check, and copy/paste-safe rollback command before
activation. Rollback cannot be used to claim the strict machine-association
security property; legacy mode is explicitly a compatibility state.

## 24. CP3 compatibility

CP3 design and plan remain authoritative for Agent service identity, DPAPI key
ownership, Ed25519 key format, public registration, Windows lifecycle, internal
named-pipe isolation, authenticated ingest domains, and Detector B transition.
CP3 runtime implementation is paused, not cancelled.

Slice 1 adds only the smallest browser-facing capability to the same dedicated
Agent. It uses the same protected Ed25519 identity but a distinct listener,
configuration, protocol parser, replay/rate state, and proof domain. It neither
creates nor exposes a CP3 Agent session and does not sign or send heartbeat,
detection, alert, or clip ingest. Later CP3 implementation must be able to add
those operations without changing the Slice 1 browser proof contract.

## 25. Deferred CP5 and SOC work

CP5 retains ownership of producer lease acquisition/release, producer epochs,
cross-machine CAM-01/CAM-02 exclusivity, multiple demanding viewers,
crash/expiry takeover, and complete passive SOC behavior. Slice 1 must not
import historical producer-generation headers or change
`server/streamLifecycle.js`, `StreamHub`, or `VideoCatcher` to approximate CP5.

The current SOC route/UI behavior is a known secondary boundary. SOC may not be
used as Slice 1 camera-activation acceptance, and no Slice 1 report may claim
that final SOC passive behavior is complete.

## 26. Known limitations

- Real Windows service identity, DPAPI behavior, loopback Origin/PNA behavior,
  and webcam activation/release require human Machine A evidence; source tests
  alone cannot prove them.
- The current single-process session/replay model invalidates associations on
  Monitor restart and does not support horizontal Monitor replicas. A shared
  atomic session/replay store would require a separate reviewed design.
- Strict association cannot be enabled fleet-wide until every Operator machine
  that must remain available has the compatible Agent. The default-off rollout
  switch preserves existing B/C behavior but is not the final security state.
- Cross-machine logical-alias exclusivity and final SOC passive enforcement are
  intentionally deferred to CP5.
- CP3 authenticated ingest is intentionally absent, so Slice 1 does not replace
  the existing Engine-to-Monitor authentication transport.
- Machine A acceptance proves application routing and camera lifecycle, not
  biometric accuracy, fairness, anti-spoofing, liveness, or model quality.
