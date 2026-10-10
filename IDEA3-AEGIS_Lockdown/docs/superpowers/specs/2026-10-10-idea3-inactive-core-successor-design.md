# IDEA3 inactive-detector Core upgrade successor — repository-only design

Status: **DESIGN AND OFFLINE CONTRACT ONLY. LIVE EXECUTOR BLOCKED.** This document grants no authority, consumes no attempt, and makes no Production or physical-effect claim.

## Goal and boundary

Define the smallest separately governed Core-release successor that can preserve the supplied detector baseline `loaded/inactive/dead/disabled/PID 0` while deploying a future IDEA3 Core release. This change adds only a pure offline evidence-contract checker and deterministic tests. It does not implement a host executor, shell runner, frozen runner, attempt marker, or Recovery gate.

The base is `dbf00185331474053f46486fcefa795a46f5b821`. The supplied current release is `954ce1c191885e9e90198a6f54a3d990bcf144fc`. Neither value supplies the immutable installed release-tree digest or proves live systemd behavior. The executor therefore remains blocked.

## Authority separation

A future Core upgrade would need a new stage identity and its own exact-main frozen runner, one-attempt authorization, marker, journal, and closeout. F1u and R1Du authority, code gates, runners, markers, and historical receipts remain unchanged. CTu and CTv remain `FAIL_IMMUTABLE`, consumed, and non-retryable. Their evidence is checked only for immutable-history consistency.

Core-upgrade authority would cover only the Core release installation, `current` transition, one normal Core restart, verification, and bounded rollback. It would not imply Recovery authorization, alter the Recovery predecessor gate, or authorize CUT, RESTORE, ISOLATE, MQTT publishing, or physical containment.

## Release identity and content closure

The future upgrade must pin distinct exact OLD and NEW release IDs. OLD is the currently approved rollback target; NEW is built from one clean, reviewed, exact-main source commit. The supplied OLD ID is `954ce1c191885e9e90198a6f54a3d990bcf144fc`; its immutable installed tree digest and complete manifest are missing and must be measured and owner-reviewed before an executor can be designed.

For NEW, reuse the checked-in L7 builder/guard layout: exact top-level `venv/`, `aegis_soc/`, `requirements.txt`, `RELEASE-MANIFEST.json`, and `RELEASE-SHA256SUMS`. The sorted sums content must cover every regular payload file except the sums file itself; its parsed path set must exactly match a separately supplied builder/guard inventory and the payload digest map, with no duplicate, missing, extra, symlink, or unlisted entry. The checker compares those separate supplied claims structurally; their authenticity and independent provenance remain unverified blockers. The manifest must use the builder's exact allowlisted fields, clean source flag, source SHA, requirements digest, file count, and a NEW release ID distinct from OLD. Every shipped `aegis_soc/` source file must match the reviewed source-blob digest map, and the requirements digest must match. Generated venv files are bound by the offline-only builder/wheelhouse provenance and full sums list rather than claimed as source blobs. The reviewed runtime closure must include all four checked-in builder entrypoints and explicitly account for current-main changes in `recovery_core.py`, `supervisor.py`, and `local_cut.py`. The local CUT implementation must remain disabled unless a separate deployment authorization defines otherwise; this task grants none.

The offline checker compares separately supplied digest maps, builder/guard path inventory, parsed sums-file content, and identities. The file-set digest is SHA-256 over sorted ASCII lines `<sha256><two spaces><relative path><newline>`; the manifest digest is SHA-256 over sorted-key compact JSON plus one newline. It does not read Git, inspect `/opt`, build a release, or attest that supplied evidence is authentic. CTu/CTv status consistency is not a byte-level revalidation of their markers or closeouts.

## Detector and systemd contract

PRE must identify the detector unit and unit digest and show `LoadState=loaded`, `ActiveState=inactive`, `SubState=dead`, `UnitFileState=disabled`, `MainPID=0`, and zero matching detector processes. POST must show the same inactive values, the same reviewed unit digest, and zero detector processes. Any activation, PID/process drift, unit change, or unreadable/missing field rejects the evidence.

The checked-in detector unit example declares `Requires=aegis-idea3-core.service` and `After=aegis-idea3-core.service`. F1u/R1Du documentation models a normal Core restart as propagating a restart job to active units that require Core; the R1Du fake world models an inactive detector as remaining inactive. Those are repository models, not proof of the installed Production unit or its exact systemd job behavior. A future executor may use only the plain `systemctl restart aegis-idea3-core.service`; it must not use job-mode overrides or issue a detector lifecycle command. The real dependency graph and inactive-unit behavior remain blockers until independently verified under a separately approved read-only evidence step.

## Rollback and service preservation

The only proposed rollback target is the exact OLD release captured before the attempt. The required class is `EXACT_RELEASE`: same immutable release tree, with a new Core process permitted. It is not `EXACT_PROCESS` restoration. Before any rollback restart, the OLD release guard, source/tree digests, current pointer, Core/detector unit identities, and detector inactive state must be re-proved. If those checks fail, rollback automation must refuse further mutation and escalate; it must not start or repair the detector. The OLD tree digest, owner approval of this rollback target, and real rollback executability are currently unproven, so no live rollback contract is authorized.

A future PRE/POST/RB comparison must preserve all captured services and shared state outside the explicit Core-owned release/pointer/process identity allowlist, including IDEA1, IDEA2, both MQTT services, Twingate/tunnel, firewall/nftables, network, relay, ESP32, incident data, and Recovery markers. The present checker compares only supplied service snapshots; it does not observe Production.

## Attempt and journal semantics (design, not implementation)

A future stage must use a new stage-specific global marker created atomically only after all read-only preflight checks and PRE evidence pass. It is exactly one attempt: marker existence blocks rerun after every outcome. A root-trusted durable journal records each owned phase before action (`preflight`, `installing`, `installed`, `switching`, `switched`, `restarting`, `restarted`, `verified`, `rollback-*`, terminal outcome), exact release IDs/tree digests, and restart invocation count. Journal recovery acts only on that attempt's proven ownership; it never deletes an unproven or foreign release. CTu/CTv markers and closeouts remain byte-for-byte untouched.

No marker, journal, runner, authorization parser, live host command, or Recovery gate is implemented in this task.

## Offline checker contract

`inactive_core_successor_contract.py` exposes a pure `evaluate(evidence)` function. It consumes an in-memory mapping and returns deterministic offline check findings plus explicit blockers. It uses no filesystem, subprocess, clock, network, MQTT, systemd, or production imports. It recomputes canonical file-list and manifest digests, checks exact payload/source path inventories and regular-file kinds, rejects malformed schemas, detector drift, incomplete or mismatched release closure, an unsafe/mismatched rollback target, changed CTu/CTv history claims, changed preservation snapshots, and any declared effect.

Its output always states:

- `LIVE_EXECUTOR=BLOCKED`
- `PRODUCTION_READINESS=NOT_ASSESSED`
- `AUTHORIZATION=NONE`
- `PHYSICAL_CONTAINMENT=NOT_PROVEN`

Even a structurally consistent fixture is only an offline contract result, never Production readiness, authorization, deployment evidence, or physical containment evidence.

## Explicit blockers before any live executor

1. Owner-measured, integrity-bound OLD release manifest/tree digest and approval of `EXACT_RELEASE` as the rollback target.
2. Independently verified installed Core/detector unit files, drop-ins, dependency graph, and exact behavior of a plain Core restart with the detector inactive.
3. Reviewed NEW release builder output, source SHA, complete payload closure, and digest pins including `recovery_core.py`, `supervisor.py`, and disabled-by-default `local_cut.py` behavior.
4. An approved new stage identity, one-attempt marker location/schema, journal trust boundary, authorization/K3 contract, and failure/rollback decision ownership.
5. Independent Security/Governance review and a separate human authorization. Recovery authority remains separately blocked by its own successor contract and is not granted by this design.
6. Fresh host/service/disk evidence and a separately approved operational window. Physical containment remains not proven.

## Verification boundary

Tests use only in-memory fixtures. They verify the contract evaluator's logic and that the module has no host-effect interfaces. They do not prove the Production systemd dependency, installed release bytes, rollback feasibility, detector operation, Recovery, network state, or physical hardware effect.
