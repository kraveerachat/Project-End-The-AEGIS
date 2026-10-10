# IDEA3 inactive-detector Core upgrade successor — repository-only design

Status: **ICu REPOSITORY EXECUTOR IMPLEMENTED; LIVE EXECUTION BLOCKED.** This document records the governed repository implementation. It grants no execution authority, consumes no attempt, and makes no Production or physical-effect claim.

## Goal and boundary

Define the smallest separately governed Core-release successor that can preserve the supplied detector baseline `loaded/inactive/dead/disabled/PID 0` while deploying a future IDEA3 Core release. The repository now registers ICu after CTv and before Recovery and provides a frozen-runner generator, exact authority gate, exclusive one-attempt marker, durable journal writer, preflight, and exact-release rollback path. The live owner runner has a hard-coded `SYSTEMD_RESTART_EFFECT_PROVEN=NO` gate: it exits before consuming the marker while the installed-unit restart consequence remains unknown.

The verified base is `728c2d9b56d2d8b0b5933202ca20f45e6687602b`. The active Core release baseline remains `954ce1c191885e9e90198a6f54a3d990bcf144fc`; the Detector baseline is loaded/inactive/dead/disabled/PID 0. The owner approves the OLD release as an `EXACT_RELEASE` rollback target **for design only**. `ROLLBACK_LIVE_AUTHORIZED=NO`. CTu/CTv remain consumed immutable FAIL; Recovery remains unauthorized.

## Authority separation

A Core upgrade is registered as distinct stage `ICu` (“inactive Detector Core upgrade”), after CTv and before Recovery. It has its own exact-main frozen runner, one-attempt authorization and marker, durable journal, preflight, and bounded rollback. F1u and R1Du authority, gates, runners, markers, and receipts remain unchanged. CTu/CTv remain immutable consumed FAIL and non-retryable. Their records are neither promoted nor rewritten. Recovery authority remains separate and ungranted.

Core-upgrade authority would cover only the Core release installation, `current` transition, one normal Core restart, verification, and bounded rollback. It would not imply Recovery authorization, alter the Recovery predecessor gate, or authorize CUT, RESTORE, ISOLATE, MQTT publishing, or physical containment.

## Release identity and content closure

The future upgrade pins distinct exact OLD and NEW identities:

| Evidence | OLD rollback release | NEW candidate |
|---|---|---|
| Release ID | `954ce1c191885e9e90198a6f54a3d990bcf144fc` | `idea3-core-728c2d9b-20261010` |
| Guard result / file count | owner-reported `PASS` / 54 | owner-reported `PASS` / 55 |
| `RELEASE-SHA256SUMS` SHA-256 | `9b2faeb4f44225bcf38ba6df5b5403e014998c7310e7c04a77c30c03f2d177df` | `0fbe8c208b49242c4ede3a097f019879dad2e0e1ab2dd7ec1a468bc289fc5749` |
| `RELEASE-MANIFEST.json` SHA-256 | `732d6af5afb0451e51655078abd8c6dc04a72ed258fb04e79c806210f2002a18` | `b6dfa93168f43d7471de3d5092baefda9f0b1027cf5dba3d6b1e3f99eb5a16cf` |
| Source / closure | installed OLD identity, owner-reported guard PASS | exact main `728c2d9b56d2d8b0b5933202ca20f45e6687602b`, clean tree, runtime closure PASS, `local_cut.py` default disabled |

The owner’s `EXACT_RELEASE` decision is approval of the design target only. It is not rollback execution authorization or Core-upgrade authorization. Under the L7 guard contract, `RELEASE-SHA256SUMS` is a sorted, complete per-file content index, checked against the release tree and manifest; the SHA-256 of that exact file is therefore the content-index/tree pin used by this design. OLD evidence is **OWNER_ATTESTED**, not independently re-inspected here: its artifact is not present in the repository or supplied workspace. Before any future live attempt, a read-only guard against the installed OLD path must reproduce this digest, manifest digest, release ID, and count. No further owner decision is needed to use OLD as the design rollback target; that future live preflight is still required.

For NEW, reuse the checked-in L7 builder/guard layout and complete runtime closure. The existing candidate is at `/home/kittipat/Workspace/idea3-p4-evidence/2026-10-10-core-release-candidate-728c2d9b/idea3-core-728c2d9b-20261010`; it was not rebuilt. This review independently hashed its existing sums and manifest files and matched both supplied digests; the manifest records the exact main SHA, clean source flag, release ID, Python version, requirements digest, and `file_count=55`. The sums file has 56 lines (the 55 payload files plus manifest). The owner-reported full release guard and runtime-closure PASS are recorded as supplied evidence, not rerun. This establishes the repository design pins without claiming production deployment or fresh host verification. Local CUT remains disabled by default.

The existing generic offline checker compares separately supplied digest maps, builder/guard inventory, parsed sorted sums content, and identities. `evaluate_pinned_evidence()` now binds this successor’s owner-supplied release and baseline record to the exact values above. It reports pin consistency only; it does not authenticate the owner transcript or read the external candidate directory. The file-set digest is SHA-256 over sorted ASCII lines `<sha256><two spaces><relative path><newline>`. The manifest digest follows the checked-in builder: declared field order, two-space indentation, trailing newline. CTu/CTv consistency remains non-byte-level and does not revalidate their markers or closeouts.

## Detector and systemd contract

PRE must identify the detector unit and unit digest and show `LoadState=loaded`, `ActiveState=inactive`, `SubState=dead`, `UnitFileState=disabled`, `MainPID=0`, and zero matching detector processes. POST must show the same inactive values, the same reviewed unit digest, and zero detector processes. Any activation, PID/process drift, unit change, or unreadable/missing field rejects the evidence.

The supplied installed-unit evidence states `Requires=aegis-idea3-core.service` and `After=aegis-idea3-core.service`. F1u documents its active-detector restart consequence; R1Du’s inactive behavior is a fake-world model. The owner explicitly reports `ACTUAL_RESTART_EFFECT=NOT_PROVEN`. These facts do not establish whether a plain Core restart leaves this inactive Detector down. Unknown behavior is a hard fail-closed condition: no pointer switch or restart is permitted while it remains unknown. The design forbids job-mode overrides, unit edits, and direct Detector lifecycle commands. A future review must bind exact installed unit and drop-in digests and establish the inactive-unit outcome without relying on the fake-world test. No Core restart was run for this task.

## Rollback and service preservation

The only design-approved rollback target is the exact pinned OLD release. Its safety class is `EXACT_RELEASE`: byte-identical release tree and manifest, while a new Core process is permitted. It is not `EXACT_PROCESS` restoration. Before any rollback action, the future runner must re-prove OLD guard and digests, exact `current`, Core and Detector unit/drop-in identities, and Detector inactive state. Unknown or changed facts mean refuse rollback mutation and escalate; never start or repair the Detector. The owner has approved this target for design only. Live rollback remains unauthorized.

A future PRE/POST/RB comparison must preserve all captured services and shared state outside the explicit Core-owned release/pointer/process identity allowlist, including IDEA1, IDEA2, IDEA3 database/audit/dispatch state, both MQTT services, Twingate/tunnel, firewall/nftables, network, relay, ESP32, incident data, and Recovery markers. The sole mutation allowlist would be new immutable Core release content, atomic `current` switch, and the one normal Core restart plus at most one bounded rollback restart. No Detector action, incident/history write, Recovery action, or external service mutation is allowed. The current checker compares supplied claims only.

## Attempt and journal semantics (design, not implementation)

A future ICu stage must perform strict read-only preflight before consuming its own authority: verify exact main and frozen runner provenance; exact OLD/NEW IDs, counts, sums and manifest pins; installed old pointer and release guard; Core and Detector unit/drop-in hashes and systemd properties; Core active and Detector inactive/dead/disabled/PID0 with zero matching processes; disk and required preserved-service snapshots; immutable CTu/CTv history; Recovery remains unauthorized; and no declared prohibited effect. If the exact inactive-Detector restart consequence is unknown—or evidence indicates the Detector would become active—the runner must refuse before install or pointer mutation. Only after a fresh, exact PRE succeeds and independent/human approvals are bound may a unique global ICu marker be atomically created. Marker existence permanently consumes the one attempt. A root-trusted durable journal is written before each owned mutation and binds both release IDs/digests, pointer, pre-state and phase; it records forward and rollback restart invocation counts. Recovery acts only on that attempt's proved ownership, never deletes a foreign/unproven release, never retries, and escalates on unknown state. A recorded restart invocation is never replayed; rollback is attempted at most once and only after the exact OLD guard, units, and safety preconditions pass. CTu/CTv markers and closeouts remain byte-for-byte untouched.

The offline ICu readiness validator requires the exact release IDs and digest pins, fresh installed Core/Detector unit and drop-in digests, the inactive Detector baseline, a separately approved authority record, an absent one-shot marker and journal plus implementation semantics, the exact OLD `EXACT_RELEASE` rollback target, matching PRE/POST preservation snapshots, and an empty effect list. Synthetic or fixture systemd results are explicitly rejected as proof of the Production restart consequence. Even an input labelled as an actual installed-unit observation remains unauthenticated evidence and does not change the fixed `LIVE_EXECUTOR=BLOCKED` result.

The implementation does not override the restart-effect blocker. The owner runner reports `ACTUAL_INSTALLED_UNIT_RESTART_EFFECT_NOT_PROVEN`, leaves `ATTEMPT_CONSUMED=NO`, and exits before marker creation, install, pointer switch, or restart. Its post-gate mutation path is governed by exact release pins and write-ahead journal phases, but is unreachable until that fixed proof gate is deliberately reviewed and updated in a separately authorized task. No Production mutation, Core restart, Detector lifecycle action, MQTT dispatch, CUT, or RESTORE occurred. The readiness evaluator remains unchanged; it is not duplicate executor evidence. CTu/CTv remain immutable FAIL and Recovery remains blocked.

## Offline checker contract

`inactive_core_successor_contract.py` exposes a pure `evaluate(evidence)` function. It consumes an in-memory mapping and returns deterministic offline check findings plus explicit blockers. It uses no filesystem, subprocess, clock, network, MQTT, systemd, or production imports. It recomputes canonical file-list and manifest digests, checks exact payload/source path inventories and regular-file kinds, rejects malformed schemas, detector drift, incomplete or mismatched release closure, an unsafe/mismatched rollback target, changed CTu/CTv history claims, changed preservation snapshots, and any declared effect.

Its output always states:

- `LIVE_EXECUTOR=BLOCKED`
- `PRODUCTION_READINESS=NOT_ASSESSED`
- `AUTHORIZATION=NONE`
- `PHYSICAL_CONTAINMENT=NOT_PROVEN`

Even a structurally consistent fixture is only an offline contract result, never Production readiness, authorization, deployment evidence, or physical containment evidence.

## Explicit blockers before any live executor

1. Fresh read-only host PRE must prove installed `current`, OLD release guard and both pinned digests; current repository has only the owner-attested OLD verifier facts, not its release artifact.
2. Exact installed Core/Detector unit and drop-in digests plus safe behavior of a plain Core restart with Detector inactive. The supplied dependencies are known, but actual effect remains NOT_PROVEN.
3. Fresh exact host/service/disk evidence and preservation snapshot, including Detector still inactive. Supplied baseline is not a fresh stage PRE.
4. A separate approved ICu authority, one-attempt marker schema/location, journal trust boundary, authorization/K3 contract, and failure/rollback decision ownership.
5. Independent Security/Governance review and separate human authorization to execute. `EXACT_RELEASE` design approval does not grant this. Recovery authority remains separately blocked and is not granted here.
6. Physical containment remains not proven; this Core-upgrade successor cannot claim or authorize it.

## Verification boundary

The added focused tests use in-memory fixtures and verify exact release pins, installed unit metadata shape, inactive Detector state, systemd evidence provenance, one-attempt/journal declarations, exact-release rollback, preservation snapshots, authority separation, and prohibited effects. They do not prove Production unit behavior, installed release bytes, rollback feasibility, Detector operation, Recovery, network state, or physical hardware effect. No Production execution is enabled by the validator.
