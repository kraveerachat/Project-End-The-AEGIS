# AEGIS IDEA2 SOC Passive Live and Physical Archive Implementation Plan

> **For agentic workers:** implement by TDD in a clean worktree. Do not deploy or mutate Machine A/B/C or Production.

**Goal:** Make SOC live viewing truly passive, make archive/playback/download physically scoped for Operators, and prevent cross-machine recording collisions while retaining SOC review across both operator aliases.

**Base:** `f967ac4c11d0b02dbf4c08c98aac48437ff2efb5`

**Branch:** `feat/idea2-soc-passive-live-archive`

**Spec:** `docs/superpowers/specs/2026-10-02-idea2-soc-passive-live-archive-design.md`

## Non-negotiable constraints

- SOC never inserts or renews `camera_producer_demands`.
- SOC never causes a new Engine MJPEG upstream.
- Final demanding Operator departure closes the Engine upstream even if passive SOC viewers remain.
- Operator physical source always comes from verified local Node association.
- Same alias on different machines never collapses into one physical source or archive scope.
- Producer generation and Engine key remain server-only.
- No Identity Agent SCM-maintenance edits in this branch.
- No Production mutation, no service start, no key generation, no merge.

## Task 1 — RED tests for passive live semantics

Create focused Monitor tests proving current source is wrong before implementation.

Required RED cases:
- `soc_idle_camera_has_zero_demand_and_zero_engine_fetch`
- `soc_cannot_create_stream_hub_without_demanding_operator`
- `soc_attaches_to_existing_physical_hub_without_new_upstream`
- `multiple_soc_viewers_do_not_change_demand_count`
- `final_operator_close_terminates_soc_and_closes_upstream`
- `same_alias_on_machine_a_and_b_remains_two_active_views`
- `forged_soc_generation_node_or_source_is_ignored`

Prefer a new focused suite such as `tests/socPassiveLive.test.mjs` and add it to
`package.json` only after RED is reproduced.

## Task 2 — Monitor physical stream hub

Add a bounded server module such as `server/stream/physicalStreamHub.js`.

The hub key is exact physical producer identity: physical camera + generation.
It owns one Engine upstream and a subscriber set.

Interfaces should separate:
- demanding join: requires already-authorized DB producer handle;
- passive join: requires an existing live hub only;
- publish/backpressure/abort lifecycle;
- demanding leave;
- passive leave.

A passive join must never call Engine `fetch`.

When demanding count becomes zero:
- abort Engine source immediately;
- terminate every passive subscriber;
- delete hub state;
- allow producer lifecycle release to retire DB authority.

Do not allow a passive subscriber to delay closure.

Refactor strict Operator stream route to obtain its frames from the hub after
producer acquisition. Preserve existing release-on-every-exit behavior.

## Task 3 — SOC active physical view discovery

Add server-side read-only active producer lookup. It must derive views from
unreleased, unexpired epochs backed by at least one unreleased, unexpired
Operator demand.

Expose a SOC-only endpoint returning bounded display/reference fields and no
generation/key/stream URL/session binding.

SOC stream selection must be treated as untrusted input and revalidated against
current active producer state before passive hub attach.

Update Live UI so SOC selects distinct active physical views when the same alias
is active on multiple machines. Operator UI remains account alias + verified
local machine.

## Task 4 — Physical archive authorization

Refactor clip authorization into one server helper reused by list/playback/
download.

Strict Operator:
- verified local Node required;
- logical alias from Node/account policy required;
- clip logical alias must match;
- clip `physical_camera_id` must match verified local physical camera;
- missing physical provenance fails closed.

SOC:
- may list/play/download clips from both operator/operator2 and all physical
  machines;
- file path remains server-only.

Update `store.listClips` / `getClipById` to carry physical provenance
internally and return safe physical/Node labels where useful.

Add `GET /api/clips/:id/download` with the same authorization helper as video,
`Content-Disposition: attachment`, `Cache-Control: no-store`, verified
storage requirement, and basename hardening.

## Task 5 — Recording identity

Inspect `aegis_engine/segment_recorder.py`, `nas_sync.py`,
`monitor_client.py`, strict ingest provenance, and related tests.

Replace logical-alias-only recording filenames with collision-resistant names
that include stable machine/physical context plus alias and UTC/unique context.
Do not put secrets in paths.

Preserve NAS transfer verification and fail-soft Monitor persistence.

Add Python tests proving:
- Machine A CAM-01 and Machine B CAM-01 cannot collide;
- CAM-01 and CAM-02 on one physical machine remain distinguishable;
- filenames are safe and bounded;
- existing finalized-segment/NAS callbacks still work.

## Task 6 — Archive UI

Show enough safe provenance in Archive for SOC to distinguish:
- machine/Node,
- logical alias,
- clip time.

Operator must never receive another machine's clips in the API payload, so
client filtering is convenience only.

Add an explicit Download control wired to the new authenticated download route.

## Task 7 — Verification

At minimum run:
- focused passive-live tests;
- physical stream routing/lifecycle tests;
- producer lifecycle tests;
- device-owned access tests;
- archive/clip authorization tests;
- focused Engine recorder/NAS tests;
- full Monitor `npm test`;
- Monitor `npm run build`;
- applicable Python tests;
- governance tests;
- Vault validation;
- `git diff --check`;
- changed-content secret scan.

Use disposable PostgreSQL for active-producer and physical archive assertions.
Do not claim DB-backed behavior green if PostgreSQL was skipped.

## Task 8 — Final branch reconciliation

Before Ready:
- fetch current main;
- prove overlap with PR #292/current main;
- normal merge only if main advanced;
- rerun affected tests;
- create exactly one immutable final task receipt;
- update `idea2-status.md`;
- open/refresh PR as Draft until human review.

Stop before merge or deployment.
