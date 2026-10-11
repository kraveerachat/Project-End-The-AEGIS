# IDEA2 PR #348 — account-specific recording attribution design

Date: 2026-10-06
Area/owner: IDEA2 / Pub
Branch: `feat/idea2-multi-node-camera-provisioning`
Dependency: Draft PR #344, `feat/idea2-pr2-recording-archive-5min-download`
Status: design for owner review; no live acceptance or deployment claimed

## Purpose and boundary

One physical camera belongs to each registered Detection Node. The independently
authorized accounts `operator` and `operator2` use logical aliases `CAM-01` and
`CAM-02` respectively on Machines A, B and C. Changing account must never
change the physical camera. A real PR #344 recording currently inherits the
Engine's static `AEGIS_CAMERA_ID`; a CAM-02 viewer can therefore produce a
clip attributed to CAM-01 or no CAM-02 clip. Fix recording and Archive
attribution without weakening physical producer ownership or requiring a
second capture device/session.

This design covers recording/clip attribution only. Detection and alert event
alias attribution remain explicitly pending. It does not authorize Machine A,
Machine B/C, Production, database, network or storage mutation. PR #344 stays
Draft and unchanged; PR #348 remains a Draft stacked PR with no final receipt.

## Existing authority

The Monitor stream route resolves the authenticated user, camera assignment,
local Node association, account alias and physical camera before calling the
transactional producer lifecycle. The lifecycle returns a server-only demand
handle with exact decimal-string `producerGeneration`, `logicalCameraId`,
`physicalCameraId` and `nodeId`. Multiple authorized aliases can share one
physical producer epoch but have distinct viewer demands. Monitor currently
sends only the Engine key and generation to `/stream.mjpg`. The Engine currently
has one `StreamHub` and one static-alias `SegmentRecorder`. Verified NAS sync
publishes `cameraId` only after integrity verification; clip ingest derives
physical provenance from authenticated Node identity, while the existing
nullable `clips.producer_generation` is not written.

## Decision: shared capture, separate alias recording contexts

Retain one physical capture, one producer generation and the existing
per-viewer StreamHub leases. Each accepted Engine viewer lease also carries the
Monitor-authorized logical alias for that lease. The Engine maintains an
alias-to-active-viewer count scoped to the exact producer generation. The first
viewer of an alias opens that alias's recording context on the next captured
raw frame. A second viewer of the same alias shares it. The last viewer of
that alias finalizes its current truthful partial, even if another alias
continues viewing and the physical camera remains open. A later session
starts a new segment; no idle/private gap is appended. Concurrent CAM-01 and
CAM-02 have separate writers fed the same raw captured frames, not separate
camera opens or competing producer epochs.

The recorder owns the alias-context writers and their frame fan-out. State
changes from StreamHub and frame consumption use one documented lock/order or
serialized command boundary, so viewer release cannot race a queued frame into
a finalized alias context. Each context keeps its own start time, frame count,
300-second rotation clock and measured partial duration. Camera capture
continues until the final attached physical viewer releases. Generation
replacement invalidates old leases and finalizes their recording contexts
before new-generation frames are attributed. Zero Engine viewers stops capture
and closes alias recordings, but is **not** proof that Monitor's producer epoch
has retired: another authorized demand may already exist in the same epoch.
Existing legacy/always-on behavior remains explicitly bounded and must never
override an authenticated alias.

## Revised distributed demand/retirement authority (design-review gate)

The current Engine implementation sets `_producer_generation_retired` when its
last local viewer leaves. That is an incorrect distributed retirement signal:
Monitor can acquire demand B on the same live epoch while viewer A is still
attached, then A can close before B's Engine request or before its deferred
body iterator attaches. Engine's local count cannot observe B's database row.
The failure appears as 409/502 for a valid late request or an empty 200 after
successful preflight. Task 2 recording work is paused until this is corrected.

Monitor remains the sole demand/epoch authority. After the existing locked
authorization/acquire transaction commits, Monitor issues a short-lived,
per-demand Engine grant bound to the exact canonical BIGINT generation,
logical alias, opaque demand-owner ID, registered Node and physical camera,
and the Engine's current 128-bit-or-stronger random boot nonce,
and the database demand lease expiry. The proposed v1 wire form is
`base64url(canonical-json).base64url(mac)`: JSON keys are sorted with compact
separators, generation is a decimal string, and the MAC is HMAC-SHA256 over
`aegis-producer-demand-v1\n` plus those exact JSON bytes. Its key is
HMAC-SHA256 of the existing server-only Monitor↔Engine API key over
`AEGIS-demand-grant-v1-key` (domain separation). Verification uses constant-time
MAC comparison and strict canonical parsing. The grant is never accepted from
or returned to the browser. The test-only grant mint in the RED fixture uses
this exact format; Production minting is not implemented at this gate.
Its absolute expiry is no later than the database demand expiry (currently
30 seconds); clocks/skew must be checked fail-closed, with no expiry grace that
extends authority. The envelope has a unique one-use grant ID. Its payload
must not contain a raw session binding, user credential, key, or physical
device selection. Engine verifies the key, signature, strict field syntax,
expiry and highest observed generation before any viewer/capture side effect.
The authenticated alias is access/recording context only, not source selection.

Engine preflight atomically reserves this grant against the generation under
the StreamHub condition. The reservation is one-use and expires no later than
the grant/demand lease; the later streaming-body attachment consumes that same
reservation atomically, instead of performing a second uncoordinated
generation preparation. This closes both races: B arriving after A closes,
and A closing between B preflight and deferred attachment. Replaying a used,
expired, malformed, mismatched or untrusted grant fails closed. A grant for a
lower generation can never override a higher generation already observed.
The process-local highest-observed generation is monotonic; an explicit
Monitor retirement of generation G permanently tombstones G in that process.
The boot nonce changes on every Engine process start. Monitor obtains it only
over an Engine-key-authenticated server-to-server endpoint before minting a
grant; Engine rejects any grant bound to a prior boot. This makes process-local
one-use IDs, demand revocation tombstones, generation retirement tombstones and
highest-observed generation safe across restart: no old token can be replayed
into the new process. After restart, Monitor may issue a **new** boot-bound
grant only after rechecking the still-live DB demand/epoch under the existing
authority model; an already-retired G cannot receive one. A bare generation
header is never authority. The Engine compares the signed Node ID with
its configured Node ID; Monitor binds physical-camera ID to the registered
producer in its locked DB transaction after resolving the reviewed physical
stream route target. Engine
has no independent trusted physical-camera ID today: it verifies the signed
physical ID's canonical form and integrity, but Monitor supplies the
physical-world binding. A wrong physical registration must fail at Monitor,
not be claimed as an Engine-side check. Neither claim selects a camera device.

Monitor's 10-second serialized revalidation renews the database demand first,
then refreshes the corresponding Engine grant/lease through an authenticated
server-only control operation. Failed renewal or failed grant refresh closes
that stream; an Engine lease cannot outlive its last authenticated expiry.
After Monitor commits a demand release, it revokes that demand's Engine grant.
Engine holds a revoke tombstone for `(generation, demandOwnerId)` until no
previously minted grant/refresh for that demand can remain valid (at most the
30-second demand lease plus the 1-second sweep bound after receipt). It
atomically invalidates that demand's unused reservations,
attached viewer and pending refresh under the same StreamHub lock. A refresh
that arrives after revocation cannot revive the demand, regardless of its
signature or timestamp. Revoking A must not invalidate B on the same G;
revoking B between its preflight and deferred attach must prevent that attach.
Only when the same database transaction proves the epoch has no valid demands
and retires it may Monitor issue a generation-retire command. A late or
out-of-order retire for G cannot retire a later G+1. If a control delivery is
lost, an already-issued unused grant may still admit a viewer until its signed
expiry, and an attached viewer may remain until its last authenticated lease
expires. This is a **bounded post-release residual window**, not immediate
revocation or proof that Engine knows current DB state. Autonomous Engine
expiry sweeping must clear viewers/capture within the existing 30-second lease
plus a bounded 1-second sweep interval even if the MJPEG iterator is stalled.
Used grant IDs likewise expire only after their signed expiry; they cannot be
discarded sooner and are never reusable while their token remains valid.
Reserve/replay/revoke state has an explicit 4096-entry process cap; at cap,
Engine fails new grants closed without touching existing viewers/capture.
This prevents long-running memory growth while retaining the current highest
generation plus a retired flag in constant space. Retirement control should
be retried/acknowledged within the Monitor cleanup
budget, but missing acknowledgement never extends Engine authority. No
equal-generation reopening is possible forever. Engine zero-viewer state
immediately stops physical capture and finalizes that alias's partial clip,
but does not permanently retire G by inference from its local count.

The existing Engine-key boundary is necessary but not sufficient: a bare
Engine key plus generation/alias is not a valid demand grant. All demand,
renewal and retirement signals originate in Monitor after server-side
authorization/transactional lifecycle decisions. Do not expose these headers
through CORS/browser APIs, use heartbeat as authority, or add Engine database
credentials. The 30-second lease is the current bound, not an invitation to
extend it; if clocks cannot be proven adequately synchronized, fail closed
and return to design review before runtime implementation.

## Monitor → Engine trust boundary

Only after route-level authorization and successful producer demand acquisition
may Monitor send an alias context to the Engine. It sends one strict logical
alias alongside the existing authenticated Engine key and canonical decimal
generation. The alias is derived from the server-owned demand handle, never
from browser parameters, browser headers, heartbeat or `AEGIS_CAMERA_ID`.
Engine rejects missing/duplicate/malformed alias in strict capture-on-demand
mode, stale/invalid generation, or any alias/generation mismatch with the
current producer. No alias may select an upstream URL or physical device. The
browser sees only the same-origin Monitor stream and receives no Engine key,
generation, physical identity, session binding or storage path.

Logout, session expiry/revocation, assignment loss, failed renewal, upstream
error, client close and idle timeout retain the existing Monitor release
contract. Exactly-once demand release remains at Monitor; Engine viewer removal
is idempotent and alias-scoped. One alias leaving cannot stop another alias's
stream or recording. Physical final-viewer release still stops capture.

## Segment, storage and clip provenance

Each new `SegmentInfo` carries the authorized logical `camera_id` and exact
producer generation in addition to existing times/path/size. The filename
uses a validated alias, generation and a collision-resistant unique suffix;
two aliases or rapid rotations can never overwrite one another even within
the same second. Filenames are local implementation details, not client
authority. H.264/yuv420p conversion, SHA-256/size verification, retry and
publish-only-after-verify remain unchanged. Failed conversion/transfer/verify
publishes no clip row and retains the local source under the existing policy.

`MonitorClient` and NAS sync carry `producerGeneration` unchanged to internal
clip ingest. The ingest transaction validates the authenticated Ed25519 Node's
registered physical camera against the epoch's exact Node and physical camera.
The generation must be a canonical positive PostgreSQL BIGINT decimal string,
never a JavaScript Number. At least one recorded demand for that generation
must carry the claimed logical alias and a non-null `viewer_user_id`. The
demand was inserted only after the producer lifecycle transaction locked and
rechecked that user's active Operator status, camera assignment, Node, physical
camera and account alias policy. Ingest requires that historical demand/user
association but does not require a currently active assignment: later revocation
must prevent new demand, renewal and post-revocation capture authority, not
retroactively invalidate previously authorized footage awaiting verified
transfer. The existing schema does not retain independent assignment history;
the historical demand's lifecycle write invariant is the available evidence.
Static `AEGIS_CAMERA_ID`, a matching filename or
the Engine's mere possession of a generation never substitutes for these
checks. No wrong-alias fallback exists.

Ingest sanity-checks positive finite duration, parseable chronological clip
times, no future segment, and the segment's relationship to the epoch's
`acquired_at`, optional `released_at` and demand `released_at`. A released
generation is not treated as *current*. Its already-finalized partial or
full segment may publish after transfer only when its claimed capture interval
is bounded by the recorded lifecycle; a new interval after release is
rejected. A configurable 30-second default timestamp tolerance is a bounded
clock/close sanity allowance, not an authorization boundary; tests cover its
exact and just-outside boundaries. Duplicate publication of the same verified
storage object must not
create a second row. Any ambiguous or unverifiable combination fails closed.

Only then insert `camera_id`, `physical_camera_id` and
`producer_generation`. Reject mismatch, missing association, invalid decimal
encoding and untrusted legacy claims fail closed for new attributed clips.
Use the existing nullable clip column and existing demand history; no schema
migration is proposed. Do not update historical rows. The evidence claims are
exactly:

```text
HISTORICAL_DEMAND_ASSOCIATION=PROVEN
PHYSICAL_PROVENANCE=PROVEN
PER_FRAME_HISTORICAL_AUTHORIZATION=NOT_CLAIMED
```

The current demand schema has no acquisition timestamp or per-frame proof;
the Engine's alias-scoped lifecycle enforces segment start/stop boundaries.

Archive listing, playback and Download continue to enforce the existing
server-side camera assignment/session scope. `operator` sees CAM-01 clips only,
`operator2` sees CAM-02 clips only, even when both share the same physical ID.
SOC behavior and no-raw-storage-path responses remain unchanged.

## Tests and verification

Write RED tests first for the existing static-alias misattribution. Then cover:

- A/B/C simulated Node mappings with both accounts; same physical camera per
  Node and account-specific logical clip alias;
- concurrent mixed aliases sharing one physical capture/generation but using
  distinct recording contexts/files, plus one alias joining/leaving later;
- same-alias viewer reference counting, final alias partial, final physical
  release, navigation continuity and 300-second rollover;
- stale generation, unauthorized/malformed/duplicate alias and static
  `AEGIS_CAMERA_ID` override attempts fail closed without publication;
- exact generation survives SegmentInfo → NAS sync → signed clip payload →
  PostgreSQL clip row, with verified Node/physical/demand/user-assignment
  association and a released-generation delayed-finalization positive case;
- post-release new-interval, impossible/future timestamp, excessive or
  nonpositive duration, duplicate storage object, post-revocation new demand
  or renewal, and generation/alias/physical mismatch cases fail closed;
- delayed publication after later assignment revocation succeeds for a
  pre-revocation authorized interval; timestamp tolerance has exact-boundary,
  just-outside-boundary and configured-override coverage;
- transfer/conversion/checksum failure publishes no row; rapid rotations and
  simultaneous aliases have collision-safe names;
- Archive operator/operator2 scope, SOC behavior, playback/Download RBAC and
  absence of raw storage paths or secrets in browser responses.

Run focused Engine/Monitor tests, full applicable suites, disposable
PostgreSQL ingest tests, browser/build checks where affected, governance and
Vault validation, `git diff --check`, changed-content secret scan and scoped
security review. Report environmental skips honestly. Repository tests do not
prove live Machine A recording or Production Archive acceptance.

## Integration and rollback

The PR-owned change is expected in IDEA2 Engine/Monitor source, tests, this
design/plan and the mutable IDEA2 status. The current detection pipeline uses
a static camera ID and does not persist producer generation on detections;
therefore new attributed Archive clips have a neutral detection-result-unavailable
state, not a false Authorized-only or Unknown claim. The approved Archive UI
change affects only that label/filter behavior; playback and RBAC are unchanged.
A narrow IDEA2 Identity Agent pipe
protocol extension carries the authenticated clip alias/generation, and its
clip HTTP transport rejects redirects so an unrelated 200 response cannot
acknowledge publication. These source changes do not change Agent keys,
signing authority, service lifecycle, installation or installed runtime.
No shared deployment, HUB, Drive, IDEA1/IDEA3, Production DB or Machine A runtime changes are in
scope. If a shared/deployment path becomes necessary, stop for integration
review before editing it. Keep PR #348 stacked on Draft PR #344; only PR #348
may be pushed. Do not create a final immutable receipt, mark Ready, merge,
deploy or provision nodes in this source checkpoint.

Rollback is branch/PR withdrawal before live use. Any future deployment needs
a separate reviewed rollout/rollback and real Machine A dual-alias acceptance.
No live clip row or historical file is changed by this repository design.
