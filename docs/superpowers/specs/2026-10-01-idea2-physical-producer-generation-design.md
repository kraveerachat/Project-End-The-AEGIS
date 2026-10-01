---
title: AEGIS IDEA2 Physical Producer Generation Design
date: 2026-10-01
status: owner-review
owner: pub
area: idea2
---

# AEGIS IDEA2 — Physical Producer Generation Design

## 1. Goal and authority

Implement the missing Monitor-side producer-generation lifecycle for an
authenticated, authorized camera stream. This is a source/test/Git task on a
successor branch stacked on `feat/idea2-machine-a-no-powershell-runtime`.
It does not authorize a Production migration, node registration, deployment,
Machine A runtime change, or PR merge.

The human-approved ownership rule is **one physical producer per physical
camera and Detection Node**, independent of the logical alias used to view it.
Each viewer's account and Node policy determine its logical alias. The
producer generation is server/DB authority; browser input never supplies it.

For each of Machines A/B/C, both `operator -> CAM-01` and
`operator2 -> CAM-02` may resolve to that machine's one registered physical
camera. Two independently authorized viewers of the same physical camera and
Node may share one active producer generation concurrently, even with different
aliases. The physical camera cannot move between machines when the account
changes. Identical logical aliases on different machines must not collide as
producer identities.

## 2. Current source and evidence boundary

At base `37db029fc641ec9dff687dc6506c88f67a438631`, the Monitor stream
route in `server/routes/api.js` sends `X-Detection-Engine-Key` but no
`X-Aegis-Producer-Generation`. The owner-provided live preflight observed
401 without the key and 400 `invalid producer generation` with the key.
`server/auth/cameraAccess.js` already resolves the authenticated session's
registered Node, physical camera, and account alias. The stream route's strict
Operator branch does not yet acquire a DB producer epoch or per-viewer demand.

Migration 002 and `schema.sql` define `camera_producer_epochs` with a required
`logical_camera_id` and active unique indexes on both logical and physical
camera. This encodes the wrong producer boundary: it prevents same-alias
producers on separate physical machines and forces one alias into the epoch
shared by multiple account aliases. `camera_producer_demands` has a session
binding hash but no logical alias or user context. No Monitor lifecycle code
uses either table yet.

The branch's Engine source does not currently contain the live Engine's
generation-header check. Treat the owner-provided live HTTP response as
external evidence, not as a claim that this branch's Engine tests prove that
deployed behavior. Do not weaken, duplicate, or change Engine validation in
this task. A controlled fake upstream can verify the Monitor request contract.

Production has not applied migrations 001–003 and has no physical registry or
producer tables. Migration 004 exists in this source branch. The isolated H1
N1 lab has already run the earlier migration chain according to owner evidence.
Source completion cannot, by itself, activate the Production camera: migration,
explicit Node/physical registration, account alias reconciliation, and rollout
remain separate owner-gated prerequisites.

## 3. Schema choice: preserve migration history and add 005

**Option A — edit not-yet-Production-applied migration 002.** This would make a
fresh Production rollout shorter, but it would rewrite a committed migration
already executed in the H1 lab. Rerunning `CREATE TABLE IF NOT EXISTS` would
not remove the old columns/indexes there. It also makes source and applied
migration provenance diverge. Reject A.

**Option B — add migration 005 and update the fresh `schema.sql`. Recommended.**
Keep migrations 001–004 byte-identical. Migration 005 removes the active
logical-camera uniqueness rule, retains active uniqueness on
`physical_camera_id`, and makes the epoch's historical `logical_camera_id`
nullable/deprecated rather than deleting it. New epochs leave that column
NULL; it is never consulted for ownership. Add a `logical_camera_id` FK to
each demand, backfill it from the epoch's former alias for any historical
demands, then require it for future rows. Add nullable `viewer_user_id` FK so
new runtime demands can record the authenticated user without fabricating an
owner for historical rows. New runtime demands must always supply this field;
NULL historical rows cannot be renewed or accepted as current authority.
Retain historical rows and event provenance. No data truncation, broad CASCADE,
or automatic Node registration is permitted.

The fresh schema must match the 001→005 end state. Migration tests must prove
both fresh apply and 001→004 upgrade, rerun safety, existing-row preservation,
two aliases sharing one physical epoch, and the active physical uniqueness
constraint. The migration must fail rather than guess if an unexpected
historical demand cannot be safely backfilled.

## 4. Producer and demand lifecycle

The demanding Operator route first authenticates the session and checks the
requested logical camera against live `camera_assignment`, registered
Node/physical identity, and account/node alias policy. No producer transaction
or upstream fetch occurs before authorization. The route then validates the
server-approved physical source and acquires a demand in PostgreSQL. Strict
mode has no in-memory or logical-heartbeat producer-authority fallback; absent
schema/registry/DB authority fails closed.

Acquisition and renewal run in a transaction. They lock the authoritative
user, Node, physical camera, alias-policy, applicable account-alias, and
assignment rows in a deterministic order, using locks that conflict with
authority updates/deletes; the registered `physical_cameras` row additionally
serializes physical producers (`FOR UPDATE`), and the active physical unique
index is a second guard. After all applicable locks are held and before any
demand/epoch write, they recheck user and Node activity, Node key version,
physical binding/activity, applicable alias policy, and live assignment. A
revocation committed first must deny acquisition with no authority written;
one committed after acquisition locks must serialize behind it. Merely locking
the physical row while reading other authority rows unlocked is not sufficient.
The transaction retires expired
demands/epochs, reuses an unexpired epoch only when its physical camera and
Node match, or inserts one new epoch. PostgreSQL's identity value is the
positive `producer_generation`; preserve its decimal string without unsafe
JavaScript Number conversion. A different alias is not a conflict. An epoch
whose physical/Node binding differs, or one already released, is never reused.

Each stream response gets an unguessable server-created `demand_owner_id`,
one demand row with authenticated `viewer_user_id`, logical alias, and a hash
of the server-side session binding, plus a bounded DB-clock lease expiry. The
raw session binding and Engine key are never logged, stored in a demand row, or
sent to the browser. The route uses the returned generation only in its
server-side Engine request headers:

```text
X-Detection-Engine-Key: <server secret>
X-Aegis-Producer-Generation: <positive DB identity decimal>
```

The existing stream revalidation loop must check the live session, assignment,
Node/physical registration, and alias; renew the demand/epoch before expiry in
a serialized transaction; and abort on failure or uncertainty. Renewal and
release compare the exact generation, owner ID, session hash, active state, and
expiry so stale/released demands cannot revive an epoch. No client-supplied
generation, Node, or physical ID enters acquisition or renewal.

On normal close, tab/socket close, upstream error, route error after acquire,
idle timeout, logout/session revocation, authorization revocation, or lease
failure, cleanup releases that one demand idempotently. Under the physical-row
lock, final valid-demand release marks the epoch released; releasing one of
several viewers leaves the shared epoch active. Expired leases cannot authorize
new streams. A subsequent acquisition gets a new DB identity generation.
Existing reader cancellation and abort behavior remain intact.

## 5. Compatibility and security boundaries

- `CAM-01`/`CAM-02` remain account/node access aliases and event-time business
  context, never global physical or producer identifiers.
- Existing legacy logical-heartbeat paths remain compatibility telemetry only;
  heartbeat cannot register a Node or acquire producer authority.
- Explicit host-side `manage_nodes.py` remains the registration path. Do not add
  Python to Monitor, a web registration endpoint, or heartbeat registration.
- The strict registered-Operator stream path fails closed when migrations or
  registration are absent. Do not make the old compatibility route a downgrade
  path after strict association is required.
- SOC passive-view semantics are not newly proven by this Monitor-side change;
  do not claim them without separate Engine/runtime evidence.
- Do not send Engine API keys, generation values, raw session bindings, or
  registry internals to browser responses or logs.
- No UI, trained-model, Engine validation, Production, installed Machine A,
  or original dirty worktree change is in this task.

## 6. Verification and rollout gates

TDD covers header pair and server generation origin; forged browser authority;
authorization before any DB/upstream side effect; account/node alias mapping;
same physical camera with CAM-01 and CAM-02 concurrently; same alias on
different physical cameras concurrently; physical/Node mismatch denial;
concurrent acquisition and unique-index protection; per-viewer close,
upstream failure, logout/revocation and final-demand cleanup; stale/released
generation and lease expiry denial; heartbeat non-authority; and no key/browser
leakage. Real disposable PostgreSQL tests are required for transaction,
uniqueness, migration, and concurrency claims. Mocks alone cannot prove them.

Run focused lifecycle and camera tests, full Monitor tests, applicable Engine
tests, migration tests, `git diff --check`, and scoped security review. Record
exact pass/fail/skip counts and distinguish local tests from owner-reported
live HTTP evidence. Keep the successor PR Draft, stacked on
`feat/idea2-machine-a-no-powershell-runtime`; never merge or deploy it here.

Production rollout prerequisites remain separately approved migration 001–005
execution, configured `SESSION_SECRET` presence (never disclose its value),
explicit Node and physical registration, alias policy setup,
server-approved physical stream destination, Engine source/image provenance,
and real Machine A browser/stream acceptance. None is performed by this task.
