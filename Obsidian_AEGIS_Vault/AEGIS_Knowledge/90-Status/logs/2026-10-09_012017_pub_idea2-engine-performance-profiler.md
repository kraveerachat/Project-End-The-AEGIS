---
title: Task Receipt — IDEA2 Engine performance profiler
date: 2026-10-09T01:20:17+07:00
owner: pub
area: idea2
branch: feat/idea2-engine-performance-profiler
status: partial
edit_policy: append-by-new-file
---

# Task Receipt — IDEA2 Engine performance profiler

## What changed

- Added a disabled-by-default, bounded, aggregate-only Engine profiler that
  separates pipeline stages and distinguishes CPU YOLO timing from accurately
  synchronized CUDA-event timing.
- Exposed only sample counts, p50/p95/p99 latency, completed throughput, and
  CUDA timing counters through the existing safe metrics snapshot.
- Preserved normal asynchronous CUDA behavior because synchronization occurs
  only when profiling is explicitly enabled.

## Source files changed

- `IDEA2-AEGIS_CCTV-Operator/detection-engine/.env.example` — document the explicit profiling opt-in and bounded sample window.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/config.py` — load and validate disabled-by-default profiler settings.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/engine.py` — own one profiler and time exact-frame render work.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/face_detector.py` — record detector queue wait and callback/recording submission latency.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/metrics.py` — publish the aggregate-only profile in the existing metrics snapshot.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/performance_profiler.py` — implement bounded aggregates and opt-in synchronized CUDA-event timing.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/stream_hub.py` — record JPEG encoding and stream-delivery timing without changing viewer authority.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/video_catcher.py` — record physical capture-read duration.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/yolo_sface_admin_recognizer.py` — time preprocessing, YuNet, SFace, and truthful CPU/CUDA YOLO stages.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_performance_instrumentation_contract.py` — cover configuration, aggregate output, and required stage wiring.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_performance_profiler.py` — cover bounded percentiles, throughput, stage allow-list, disabled mode, and CUDA synchronization.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea2/idea2-status.md` — record the source checkpoint and blocked hardware gates.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-10-09_012017_pub_idea2-engine-performance-profiler.md` — immutable task receipt.

## Verification evidence

- `python -m unittest discover -s tests -p 'test_performance*.py' -v` — pass: 11/11 focused profiler tests.
- `python -m py_compile ...` for all changed Engine modules — pass.
- `python -m unittest discover -s tests -v` — pass: 408 tests, 0 failures, 7 environment-conditional native pywin32 skips.
- `git diff --check` — pass.
- `node --test tests/collaborationPolicy.test.mjs tests/vaultStructure.test.mjs tests/vaultMultiWriter.test.mjs` — pass: 59/59.
- `node scripts/validate-vault.mjs` — pass with the two pre-existing owner-canvas warnings.
- Changed-content high-confidence secret scan — pass: zero matches.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea2/idea2-status.md` — records the disabled-by-default source implementation and separates it from unperformed real RTX 5070 profiling.

## Shared surfaces touched

- None — task stayed inside the IDEA2 Engine and IDEA2 knowledge boundaries.

## Integration requests

- Pub/IDEA2 owner: review the aggregate-only telemetry contract and confirm profiling remains disabled for normal Machine A operation. A separate authorization is required before any Machine C deployment, camera access, profiling session, or ten-minute hardware acceptance.

## Known limitations

- The exact installed Machine C Engine revision and sanitized effective runtime settings were not read because Machine C access is forbidden in this source-only task.
- No real camera, microphone, GPU, CUDA, Production, or Machine A/C runtime was accessed or modified.
- No RTX 5070 bottleneck, camera-mode capability, unique-frame rate, Detection FPS, or 60 FPS acceptance result is claimed from offline tests.
