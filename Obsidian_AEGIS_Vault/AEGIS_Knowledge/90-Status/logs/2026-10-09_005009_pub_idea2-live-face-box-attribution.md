---
title: Task Receipt — IDEA2 Live face-box attribution
date: 2026-10-09T00:50:09+07:00
owner: pub
area: idea2
branch: fix/idea2-live-face-box-attribution
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA2 Live face-box attribution

## What changed

- Removed the Monitor's fixed-position Live overlays because persisted detection rows contain no current-frame bounding-box geometry.
- Preserved the Engine as the single renderer of exact-frame face geometry for Operator and passive SOC streams.
- Added the measured entity confidence to the Engine-rendered label.
- Forced Unknown status to render `UNKNOWN` even if malformed input contains a name; only current-frame Authorized entities may render ADMIN.
- Preserved multiple faces, recognition thresholds, stream authority, recording, Archive, Telegram, capture-on-demand and viewer-release behavior.

## Source files changed

- `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/stream_hub.py`
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_live_face_annotation.py`
- `IDEA2-AEGIS_Monitor/src/data.js`
- `IDEA2-AEGIS_Monitor/src/views/Live.jsx`
- `IDEA2-AEGIS_Monitor/src/views/SocLive.jsx`
- `IDEA2-AEGIS_Monitor/tests/browser/operatorLivePersistence.spec.mjs`
- `IDEA2-AEGIS_Monitor/tests/browser/socPassiveLive.spec.mjs`
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea2/idea2-status.md`
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-10-09_005009_pub_idea2-live-face-box-attribution.md`

## Verification evidence

- RED: new Engine annotation tests failed because labels omitted measured confidence; new Operator/SOC browser tests each found one synthetic `.bbox` overlay.
- `python -m unittest discover -s tests -p test_live_face_annotation.py -v` — PASS 3/3.
- `python -m unittest discover -s tests -p test_stream_lifecycle_regression.py` — PASS 9/9.
- `python -m unittest discover -s tests -p test_engine_worker_memory_reliability.py` — PASS 6/6.
- `python -m unittest discover -s tests -p test_yolo_sface_admin_recognizer.py` — PASS 15/15.
- `npm run test:browser -- --workers=1` — PASS 35/35 using synthetic localhost fixtures.
- `npm run build` — PASS.
- `node --test tests/collaborationPolicy.test.mjs tests/vaultStructure.test.mjs` — PASS 58/58.
- `git diff --check` — PASS.
- Full Engine discovery: 358 tests executed; 7 environment errors because the available interpreter lacks `cryptography`, plus 7 native conditional skips. No affected face/stream test failed.
- Full Monitor neutral suite: one pre-existing PR #348 source-contract mismatch in `archiveRecordingContract.test.mjs`; affected Live and SOC tests pass. This task does not claim the whole suite green.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea2/idea2-status.md`

## Shared surfaces touched

- None. All changed source, tests and knowledge paths are IDEA2-owned.

## Integration requests

- Pub: independently review exact-frame attribution, confidence formatting and removal of synthetic Monitor geometry.
- After merge and separately authorized deployment, the Machine C operator must visually confirm real current-frame face boxes; Codex must not activate the camera.

## Known limitations

- Exact installed Machine C revision and sanitized runtime configuration were not inspected because Machine C access/runtime mutation was forbidden.
- No Production deployment or real-camera acceptance was performed.
- Source tests do not prove 60 FPS or any real RTX 5070 performance target.
