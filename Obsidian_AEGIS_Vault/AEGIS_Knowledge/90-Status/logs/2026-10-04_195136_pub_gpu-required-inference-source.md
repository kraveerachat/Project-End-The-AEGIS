---
title: Task Receipt — GPU-required inference source policy
date: 2026-10-04T19:51:36+07:00
owner: pub
area: idea2
branch: feat/idea2-gpu-required-inference
status: partial
edit_policy: append-by-new-file
---

# Task Receipt — GPU-required inference source policy

## What changed

- Added opt-in, fail-closed CUDA policy to the Detection Engine's YOLO backend. Development remains CPU by default; future Production configuration must explicitly select `AEGIS_GPU_REQUIRED=true` and `AEGIS_INFERENCE_DEVICE=cuda:0`.
- YOLO predictions specify the configured device; startup verifies CUDA availability and the model's reported device before camera workers start. Required-mode runtime YOLO failure stops the Engine with a nonzero process result. GPU telemetry is based on completed inference samples, not merely an installed CUDA runtime.
- Kept YuNet/SFace failures fail-secure and kept accelerator policy independent of the existing camera-demand lifecycle.
- Source/test completion only; Production and real GPU hardware acceptance remain unverified.

## Source files changed

- `IDEA2-AEGIS_CCTV-Operator/detection-engine/.env.example` — document CPU defaults and future explicit Production settings.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/config.py` — validate accelerator policy independently of camera demand.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/engine.py` — publish configuration and exit nonzero after an accelerator failure.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/face_detector.py` — stop the Engine on required-GPU runtime failure.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/local_api.py` — expose safe accelerator status in local health.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/metrics.py` — track truthful device, backend, sample and failure status.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/yolo_sface_admin_recognizer.py` — explicit YOLO device selection and fail-closed checks.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_config.py` — configuration RED/GREEN tests.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_engine_lifecycle.py` — nonzero fatal-exit RED/GREEN test.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_gpu_inference_runtime.py` — worker stop and truthful telemetry RED/GREEN tests.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_yolo_sface_admin_recognizer.py` — device, CUDA, malformed-result, YuNet and SFace RED/GREEN tests.

## Verification evidence

- `python -B -m unittest discover -s tests -p test_config.py -v` — passed: 14 tests after initial expected RED.
- `python -B -m unittest discover -s tests -p test_yolo_sface_admin_recognizer.py -q` — passed: focused recognizer tests after expected RED.
- `python -B -m unittest discover -s tests -p test_gpu_inference_runtime.py -q` — passed: 3 tests after expected RED, including status-read failure.
- `python -B -m unittest discover -s tests -q` — passed: 290 tests, 7 environment skips.
- `node --test tests/collaborationPolicy.test.mjs` — passed: 33/33.
- `node scripts/validate-vault.mjs` — passed with two pre-existing owner-data Canvas warnings.
- `git diff --check` — passed.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea2/idea2-status.md` — source-only GPU policy and unverified real hardware/Production state.

## Shared surfaces touched

None — changed paths are within the IDEA2 code and knowledge boundary.

## Integration requests

None — no cross-scope paths changed. Owner review is still required before merge; any future Production setting or rollout is separate.

## Known limitations

- No CUDA-enabled PyTorch installation, real GPU inference sample, Machine A run, camera access or Production deployment was performed.
- PR2 recording/archive work and any real-hardware GPU acceptance remain separate.
