---
title: Task Receipt — IDEA2 VideoCatcher OpenCV resilience
date: 2026-10-07T03:14:26+07:00
owner: pub
area: idea2
branch: fix/idea2-video-catcher-resilience
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA2 VideoCatcher OpenCV resilience

## What changed

- Production reproduced a persistent Detection Engine capture-worker failure while the Engine HTTP/API process remained alive. One incident raised an OpenCV exception while applying CAP_PROP_FRAME_HEIGHT and a later incident raised an OpenCV exception while applying CAP_PROP_FPS.
- Both failures escaped the camera-open path and terminated the sole long-lived VideoCatcher worker. Because CAM-01 and CAM-02 share the same physical camera worker, both logical camera aliases subsequently lost fresh frames.
- Camera width, height, FPS and buffer settings are now explicitly best-effort hints. Backend rejection or exception no longer terminates capture.
- Unexpected camera-open exceptions now become bounded reconnect/backoff attempts.
- Camera geometry reads fall back to configured dimensions when the backend raises.
- Camera read exceptions now mark the camera disconnected, release the device and reconnect instead of terminating the worker.
- Viewer-demand release behavior and producer-generation authority remain unchanged.
- This task is a repository/source fix only. Production runtime deployment and live hardware acceptance remain separately gated.

## Source files changed

- `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/video_catcher.py` — fail-soft OpenCV camera hints, guarded open path and read-exception reconnect.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_viewer_demand.py` — focused regressions for property-hint, camera-open and camera-read exceptions.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-10-07_031426_pub_idea2-video-catcher-resilience.md` — this immutable final task receipt.

## Verification evidence

- `python -m unittest discover -s tests -p 'test_viewer_demand.py' -v` against the fixed source — PASS: 13/13.
- The same focused resilience tests against the authorized old source — FAIL as expected in all three new resilience cases; mutation/RED proof PASS.
- `python -m unittest discover -s tests -p 'test_stream_lifecycle_regression.py' -v` — PASS: 9/9.
- `python -m unittest discover -s tests -p 'test_producer_generation_contract.py' -v` — PASS: 10/10.
- `python -m unittest discover -s tests -p 'test_machine_a_runtime_contract.py' -v` using the installed Machine A Engine virtual environment — PASS: 2/2.
- `python -m unittest discover -s tests -p 'test_*.py' -v` — PASS: 389 tests, with 7 environment-only native-pywin32 skips.
- PowerShell exact-head technical review of PR #374 — PASS: authority, exact scope, diff check, resilience 13/13, stream lifecycle 9/9, producer generation 10/10 and Machine A contract all passed.
- Final review verdict — PASS: Critical 0, Important 0, Minor 0.

## Canonical notes updated

- None in this narrow source-fix PR. The immutable task receipt records the reviewed source checkpoint and preserves the remaining Production acceptance boundary.

## Shared surfaces touched

- None — implementation and tests are IDEA2-owned paths; the only knowledge change is this immutable IDEA2 task receipt.

## Integration requests

- IDEA2 owner: after repository merge, perform a separately controlled Machine A Detection Engine runtime refresh from the reviewed source.
- Re-run CAM-01 and CAM-02 physical-camera acceptance, repeated open/close cycles, recording/NAS finalization and a live soak longer than the previously observed five-minute boundary before declaring Production acceptance.
- Do not modify Identity Agent, Monitor database schema, Twingate, firewall, SSH/tunnel configuration, IDEA1 or IDEA3 as part of this rollout.

## Known limitations

- The reviewed fix has not yet been deployed into the installed Machine A Detection Engine runtime.
- The currently running Engine process still contains the pre-fix source and its VideoCatcher worker previously terminated after the reproduced OpenCV exception.
- No post-fix physical-camera soak has occurred yet.
- Browser visual confirmation, post-fix CAM-01/CAM-02 long-session stability, recording/NAS regression and final Production freeze remain pending.
