---
title: Task Receipt — Canonical modular detection runtime
date: 2026-08-13T22:12:56+07:00
owner: pub
area: idea2
branch: feat/idea2-canonical-modular-runtime
status: partial
edit_policy: append-by-new-file
---

# Task Receipt — Canonical modular detection runtime

## What changed

- Made `IDEA2-AEGIS_CCTV-Operator/detection-engine/` the canonical IDEA2 development runtime selected by root Compose while retaining `AEGIS_Camera/` as legacy code.
- Made NAS optional and disabled by default for development. Disabled/failed/unverified paths keep local footage and cannot claim NAS success; enabled NAS requires real host/user plus checksum or size verification.
- Added transactional startup rollback, cooperative shutdown, operator-readable failures, dependency-injected lifecycle tests, and configuration-owned Monitor integration.
- Preserved `FaceRecognizer` as a placeholder seam: the built-in recognizer returns only `Unknown` and does not import legacy object-to-authorization behavior.
- Removed hard-coded credentials from the legacy launch helper without using or reproducing the exposed Telegram value.

## Source files changed

- `.env.example` — documented secret-free canonical runtime development settings.
- `.gitignore` — excludes modular runtime segment/snapshot output.
- `AEGIS_Camera/run_engine.ps1` — removed hard-coded Telegram/engine credentials and marked the helper legacy-only.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/.env.example` — complete optional-integration configuration with NAS disabled by default.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/Dockerfile` — container entry point for `python run.py` as a non-root user.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/README.md` — canonical runtime, real-vs-placeholder state, startup, security, and deferred work.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/config.py` — development-safe defaults, Monitor configuration, strict validation, and secret redaction.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/engine.py` — dependency-light component factory and canonical orchestration.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/lifecycle.py` — transactional startup and clean shutdown.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/local_api.py` — consumes the validated/redacted service-key configuration.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/metrics.py` — explicit NAS-disabled state.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/monitor_client.py` — explicit optional configuration without truthiness fallback.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/nas_sync.py` — disabled-mode retention and verified-success-only behavior.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/requirements.txt` — headless OpenCV runtime dependency.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/run.py` — operator-readable startup failure.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/` — 17 focused configuration, lifecycle, NAS, recognition, entry-point, and wiring tests.
- `README.md` — corrected the root module map to the canonical HTTP-ingest runtime.
- `docker-compose.yml` — switched only the IDEA2 camera service/build/environment/storage/port wiring to the modular runtime.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea2/idea2-status.md` — recorded verified canonical development-runtime status and honest remaining integrations.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-08-13_221256_pub_canonical-modular-runtime.md` — this immutable receipt.

## Verification evidence

- `python -m unittest discover -s tests -v` from the modular engine — pass: 17/17 tests.
- Python `compile()` over modular, test, and legacy Python files — pass: 27 files.
- Default-component smoke script with unavailable camera index, NAS/Monitor/Telegram disabled — pass: runtime started, NAS reported `disabled`, camera reported disconnected, and shutdown completed.
- Default-component `/health` smoke script — pass: HTTP 200, `status=degraded`, `camera_connected=false`, and clean shutdown.
- PyYAML Compose structure check — pass: YAML parsed, `aegis-camera` build context resolved to the modular engine, NAS default was false, local recording volume was present, and port mapping was loopback-only.
- `npm.cmd test` from `IDEA2-AEGIS_Monitor` — pass: 6/6 tests.
- `node --test tests/*.test.mjs` — pass: 42/42 repository governance and Vault tests.
- `node scripts/validate-vault.mjs --vault Obsidian_AEGIS_Vault/AEGIS_Knowledge` — fail: the known validator defect assigns all receipt paths to owner `kla`; both correctly owned IDEA2 `pub` receipts are rejected while the dedicated collaboration-policy tests accept IDEA2 `pub` receipts.
- `docker compose config` — not run: Docker CLI is unavailable; PyYAML parsing and source-level Compose wiring tests passed instead.
- `git diff --check` — pass before receipt creation; final staged check required before commit.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea2/idea2-status.md` — modular engine is now canonical for development; real camera, Monitor heartbeat, Telegram, production NAS, and deployment remain explicitly pending.

## Shared surfaces touched

- `.env.example` — shared development configuration contract for the canonical IDEA2 service.
- `.gitignore` — repository-wide exclusion for modular runtime evidence output.
- `README.md` — shared repository module map.
- `docker-compose.yml` — shared local orchestration; only the `aegis-camera` service, Monitor's camera recording mount, and IDEA2 camera volumes changed.

## Integration requests

- Kla integration review: confirm the root Compose service switch, local volume lifecycle, loopback port mapping, and rollback to the preceding `aegis-camera` block if the modular container fails on a Docker-capable host.
- Pub/security owner: revoke and rotate the previously committed Telegram credential before any real Telegram test; the value was removed and is intentionally not reproduced.
- Pub deployment follow-up: run `docker compose config`, build/start the service, and verify target-host camera access before treating this as a deployed runtime.

## Known limitations

- **REAL CAMERA VERIFICATION PENDING.** No camera frame, recorded segment, or MJPEG frame was produced in this environment.
- Monitor real heartbeat integration, Telegram real routing, production NAS integration, and production deployment remain pending.
- Face recognition remains `PlaceholderRecognizer`; all placeholder faces are `Unknown` and no enrollment exists.
- Docker CLI is unavailable, so container build, Compose parsing, volume permissions, device pass-through, and container health were not executed.
- Full Vault validation remains blocked by the known receipt-owner validator defect; this task does not fix that unrelated shared validator.
- The branch is stacked on Task 1 audit commit `ee5151e`; publication must preserve that dependency until Task 1 merges.
