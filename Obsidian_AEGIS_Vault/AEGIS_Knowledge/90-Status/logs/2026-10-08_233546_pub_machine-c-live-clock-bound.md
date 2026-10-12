---
title: Task Receipt — IDEA2 synchronous capture authority expiry
date: 2026-10-08T23:35:46+07:00
owner: pub
area: idea2
branch: fix/idea2-machine-c-producer-clock-bound
status: partial
edit_policy: append-by-new-file
---

# Task Receipt — IDEA2 synchronous capture authority expiry

## Scope correction — 2026-10-12

This PR previously proposed a signed clock-offset change allowing ±900 ms and
revised Monitor grant minting. The proposed Monitor clock logic lacked independently
verified Production DB/Monitor and DB/Engine clock premises. **That code and the
associated Monitor test/fixture changes have been removed from the CURRENT diff
against main**, rather than bypassing the safety condition.

The original clock experiment is preserved in prior commits and historical PR
discussion, **not** accepted into `main` or claimed Production-validated.
The existing `main` clock/grant security contract remains untouched by this PR.

## What changed (current diff only)

- Synchronously revalidate existing StreamHub viewer/demand/capture lease
  authority at the physical capture boundary, including in-flight reads.
- Recheck authority before and after frame annotation and before recording
  submission, so an expired lease cannot rely on the 250 ms asynchronous
  sweeper to prevent stale-frame publication.
- Sweep expired demand when serving current/latest frames and frame waits;
  cap waits by the earliest applicable demand expiry.
- Maintain existing Machine A always-on behavior and existing signing,
  generation, session, RBAC and grant minting contracts unchanged.

## Source files changed (current diff)

- `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/engine.py` — synchronous authority validation around annotation, recording, Live and capture callback.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/stream_hub.py` — synchronous expired-demand sweeps, viewer/frame deadline guards.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/video_catcher.py` — authority check around physical reads.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_alias_segment_recorder.py` — authority callback wiring regression.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_producer_demand_coordination.py` — deterministic expiry, in-flight and recording-boundary regressions.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-10-08_233546_pub_machine-c-live-clock-bound.md` — this revised current-task receipt.

## Verification evidence

- Historical PR checkpoints before current-main reconciliation reported focused
  Engine 93 PASS / 0 FAIL / 0 SKIP and full Engine/Agent 403 PASS / 0 FAIL /
  0 SKIP on an older source checkout, with deterministic fake-clock tests
  demonstrating lease-expiry and annotation-race protection.
- Previous Monitor clock-test results (including 84 PASS / 1 PostgreSQL SKIP)
  apply **only** to the superseded clock experiment; those changes are no
  longer part of this PR's proposed diff.
- GitHub Collaboration guardrails were successful on an earlier exact head;
  a NEW HEAD CI run and exact-head Engine tests are required.
- **NOT YET TESTED on revised HEAD:** Engine focused/full suite, current-main
  compatibility, integration and security regression checks. Prior outcomes
  are historical evidence, not current test PASS.
- No real camera, Machine A/C runtime, NAS, credentials or Production accessed.

## Canonical notes updated

- None in this reduced current diff. The IDEA2 functional owner must reconcile
  `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea2/idea2-status.md` during final
  closeout, removing obsolete claims that this PR introduces ±900 ms clock
  acceptance, while preserving historic evidence.

## Shared surfaces touched

None — current changed paths remain within IDEA2-owned Engine and receipt.

## Integration requests

- IDEA2 functional owner and independent reviewer: verify strict and always-on
  capture/recording regressions, current-main compatibility, exact-head tests,
  documentation truth, and the final checklist before marking Ready.
- Human merge is separate. Deployment/hardware acceptance requires a separately
  authorized step and is not supplied by this source task.

## Known limitations

- This change **does not fix Machine C Live clock-skew compatibility** or
  promise acceptance of a +559/+811 ms clock offset. The existing main clock
  contract remains in force, and any genuine runtime clock mismatch must be
  handled as a separate owner-approved operational/design decision.
- Synchronous expiry defense is not an atomic cross-device frame guarantee;
  claims are limited to tested source operation boundaries.
- Final receipt status remains PARTIAL until current-head tests and responsible
  human review are completed. No merge or Production changes occurred.
