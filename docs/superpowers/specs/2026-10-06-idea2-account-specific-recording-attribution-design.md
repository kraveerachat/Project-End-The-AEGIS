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
continues until the final physical viewer releases. Generation replacement
invalidates old leases and finalizes/retires their recording contexts before
new-generation frames are attributed. Once the final viewer retires a
generation, a stale request with that same generation cannot restart a
recording. Existing legacy/always-on behavior remains explicitly bounded and
must never override an authenticated alias.

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
camera and account alias policy. Ingest additionally rechecks the current
assignment/user where available; if that authority was revoked before a
delayed NAS publication, the clip stays local/unpublished rather than being
attributed optimistically. Static `AEGIS_CAMERA_ID`, a matching filename or
the Engine's mere possession of a generation never substitutes for these
checks. No wrong-alias fallback exists.

Ingest sanity-checks positive finite duration, parseable chronological clip
times, no future segment, and the segment's relationship to the epoch's
`acquired_at`, optional `released_at` and demand `released_at`. A released
generation is not treated as *current*. Its already-finalized partial or
full segment may publish after transfer only when its claimed capture interval
is bounded by the recorded lifecycle; a new interval after release is
rejected. The implementation plan must specify the source-derived scheduling
and clock-skew allowance before tests/code, including the valid final-release
race. Duplicate publication of the same verified storage object must not
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
  nonpositive duration, duplicate storage object, revoked assignment and
  generation/alias/physical mismatch cases fail closed;
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
design/plan and the mutable IDEA2 status. No shared deployment, Engine Agent,
HUB, Drive, IDEA1/IDEA3, Production DB or Machine A runtime changes are in
scope. If a shared/deployment path becomes necessary, stop for integration
review before editing it. Keep PR #348 stacked on Draft PR #344; only PR #348
may be pushed. Do not create a final immutable receipt, mark Ready, merge,
deploy or provision nodes in this source checkpoint.

Rollback is branch/PR withdrawal before live use. Any future deployment needs
a separate reviewed rollout/rollback and real Machine A dual-alias acceptance.
No live clip row or historical file is changed by this repository design.
