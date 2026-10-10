---
title: AEGIS IDEA2 SOC Passive Live and Physical Archive Design
date: 2026-10-02
status: owner-review
owner: pub
area: idea2
---

# AEGIS IDEA2 — SOC Passive Live and Physical Archive Design

## 1. Goal and authority

Prepare the repository implementation that makes the Production Monitor satisfy
the owner-approved camera rules without changing Production while this branch is
under review.

The final behavior is:

- A CCTV-Operator session resolves the physical camera from the verified local
  machine/Node. The logged-in account selects only its logical alias.
- The same logical alias may exist on Machines A/B/C without globally binding
  that alias to one machine.
- SOC-Responder may observe only a producer that an authorized Operator has
  already made active.
- SOC-Responder must never create, renew, or otherwise keep alive producer
  demand. If the final demanding Operator leaves, the physical camera closes
  and every passive SOC viewer is disconnected.
- SOC-Responder may review archived footage from both `operator` and
  `operator2`, across registered physical machines.
- CCTV-Operator archive/playback/download remains scoped to both its logical
  alias and its verified local physical camera, so CAM-01 footage from another
  machine cannot leak into the local Operator session.
- Recording identity is physical-machine/Node + logical alias + producer/time
  context, not a globally unique logical camera ID.

This task is repository/source only. It does not deploy, migrate Production,
start Machine A/B/C services, register Nodes, create keys, or merge itself.

## 2. Current source gap

At base `f967ac4c11d0b02dbf4c08c98aac48437ff2efb5`:

1. Strict Operator live streaming already acquires a server/DB producer demand,
   then sends the server-owned Engine key and generation.
2. Strict SOC live streaming does not have an equivalent physical passive path;
   it falls through the compatibility logical-heartbeat stream path.
3. A naive SOC implementation that opens a second Engine MJPEG connection would
   violate the owner rule: the SOC connection could itself keep Engine capture
   alive after the final Operator demand is gone.
4. `clips` already carries nullable `physical_camera_id` and
   `producer_generation`, but archive listing/playback authorization is still
   primarily logical-camera scoped. Two machines using CAM-01 therefore need an
   additional physical boundary for Operator archive access.
5. The current video route provides playback but there is no explicit
   attachment/download endpoint with the same physical authorization contract.
6. The edge recorder filename currently begins with logical `camera_id`; that
   is insufficient as the sole cross-machine recording identity.

The existing physical producer schema is reused. This task should avoid a new
migration unless implementation proves one is necessary.

## 3. Required live architecture: Monitor-owned physical stream hub

SOC passive viewing must not open an independent Engine connection.

Introduce a server-owned physical stream hub keyed by the exact active physical
producer identity (physical camera + exact producer generation). The hub owns
the Engine upstream. Browser sessions are subscribers only.

A demanding Operator flow is:

1. Authenticate.
2. Verify local Node association.
3. Resolve Node -> physical camera and account -> logical alias.
4. Recheck live assignment and registry authority.
5. Acquire/renew a producer demand in PostgreSQL.
6. Join the hub as a **demanding** subscriber.
7. Only the hub may open the Engine MJPEG upstream with the server Engine key
   and exact server/DB generation.

SOC flow is:

1. Authenticate live SOC role.
2. Request one server-advertised active physical view.
3. Server revalidates that the selected physical producer is currently backed
   by at least one live demanding Operator demand.
4. Join the already-existing hub as a **passive** subscriber.
5. No producer demand row is inserted, renewed, or released on behalf of SOC.
6. No second Engine upstream is opened because of SOC.

The hub closes its Engine upstream when its demanding-subscriber count reaches
zero, regardless of how many passive SOC subscribers remain. Closing the source
also terminates passive subscribers. A passive subscriber cannot create a hub,
reopen a source, extend an epoch, or delay source closure.

Multiple demanding viewers may share one physical producer. Multiple logical
aliases can therefore be represented on one physical feed, while same aliases
on different physical cameras remain separate active views.

## 4. Active-view discovery and client authority

SOC needs a server-provided active-view list because CAM-01 may be active on
more than one physical machine at the same time.

Expose only bounded display/reference data needed by the SOC UI, for example:

- an opaque or untrusted view selector,
- logical alias,
- safe Node display identity,
- physical camera ID only if required for display/debug,
- active/availability state.

Do not return producer generation, Engine API key, stream URL, session binding,
or registration key material.

Any client selector is only a request to view an item. The server must resolve
and revalidate current DB producer authority before attaching the passive
subscriber. Browser values are never producer authority.

## 5. Fail-closed passive semantics

The SOC path must prove all of the following:

- idle physical camera + SOC request -> no Engine fetch, no epoch, no demand;
- active Operator producer + SOC request -> SOC receives frames from the
  existing Monitor hub;
- SOC-only viewer count never appears in `camera_producer_demands`;
- closing the final Operator demand closes the Engine upstream even while SOC
  is connected;
- SOC stream ends when the demanding authority disappears, expires, or is
  revoked;
- SOC cannot supply or override producer generation, Node, Engine key, or source
  URL;
- a stale/unknown active-view selector fails closed;
- SOC does not need local Machine A/B/C association because SOC is observing
  server-known active producers, not claiming local physical ownership.

## 6. Archive, playback, and download authority

The `clips` row physical provenance is part of authorization, not metadata
only.

For CCTV-Operator:

- resolve the verified local Node and physical camera;
- resolve that account's authorized logical alias;
- list only clips where both `camera_id` equals that alias and
  `physical_camera_id` equals that verified physical camera;
- playback and download repeat the same server-side check by clip ID;
- a clip with missing physical provenance fails closed in strict mode rather
  than falling back to another machine's logical alias.

For SOC-Responder:

- archive may include both CAM-01/operator and CAM-02/operator2 footage;
- archive may span all registered physical machines;
- playback/download still require authenticated SOC role and a valid stored
  clip; file paths are never returned in list JSON;
- physical camera and safe Node labels may be returned for disambiguation.

Add an explicit download route, e.g. `GET /api/clips/:id/download`, using the
same authorization helper as playback and `Content-Disposition: attachment`.
Both playback and download use `Cache-Control: no-store`, basename/path
hardening, and verified-storage checks.

## 7. Recording identity and collision prevention

A logical alias is not globally unique recording identity.

The recording/NAS naming contract must contain stable machine/physical context
plus logical alias and time/unique context. Acceptable examples are conceptually:

`<node-or-physical>__<logical-alias>__<UTC timestamp>__<unique suffix>.mp4`

The exact filename format may differ, but it must:

- avoid collisions between Machine A CAM-01 and Machine B CAM-01;
- preserve safe filename characters;
- avoid putting secrets or private key material in paths;
- preserve the logical alias for operator/SOC review;
- remain compatible with NAS verification and Monitor clip persistence.

Clip persistence in strict ingest should continue binding
`physical_camera_id` from authenticated Node provenance; browser input cannot
supply it. Where available, exact producer generation should remain event/clip
provenance rather than browser authority.

## 8. Multi-machine acceptance matrix

The implementation is not complete until tests cover at least:

| Machine | Account | Logical alias | Physical source |
|---|---|---|---|
| A | operator | CAM-01 | A only |
| A | operator2 | CAM-02 | A only |
| B | operator | CAM-01 | B only |
| B | operator2 | CAM-02 | B only |
| C | operator | CAM-01 | C only |
| C | operator2 | CAM-02 | C only |

SOC may observe any row only while its physical producer is already demanded by
an authorized Operator.

Same CAM-01 on A and B may be active simultaneously and must appear as distinct
SOC physical views and distinct archive provenance.

## 9. Verification gates

Required tests include:

- passive SOC cannot create producer demand;
- passive SOC cannot open an idle Engine source;
- passive SOC attaches to an existing hub only;
- final demanding Operator disconnect terminates passive SOC;
- multiple SOC viewers do not change demanding count;
- two Operator aliases can share one physical hub/generation;
- same alias on separate machines remains isolated;
- Operator archive list/playback/download is physical + logical scoped;
- SOC archive list/playback/download spans operator/operator2 and physical
  machines;
- missing physical provenance fails closed for strict Operator archive;
- explicit download uses the same authorization helper as playback;
- recording filenames are collision-resistant across same alias on different
  Nodes;
- Engine key, producer generation, stream URL, private key and raw session
  binding never enter browser payloads/logs.

Use focused Node tests plus real disposable PostgreSQL tests for active producer
and physical archive claims. Engine recorder/NAS naming changes require focused
Python tests. Full Monitor neutral suite and build remain required before Ready.

## 10. Rollout boundary

This branch may be developed in parallel with PR #292 because its intended
runtime/source files are Monitor streaming/archive plus bounded recorder naming;
it must not edit Identity Agent SCM-maintenance files.

If main advances, normal-merge current `origin/main` before final review. Do
not rebase or force-push.

Production enablement waits for:
- PR #292 merge and Machine A Identity Agent preflight/provisioning;
- physical Node registration for every participating machine;
- final Monitor image/config rollout;
- real Operator and SOC acceptance proving passive semantics;
- recording/download storage availability and rollback evidence.
