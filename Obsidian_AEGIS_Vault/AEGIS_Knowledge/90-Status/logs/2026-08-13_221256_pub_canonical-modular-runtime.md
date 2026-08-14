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
- Added `docs/reports/2026-08-14-idea2-canonical-modular-runtime-th.md`, a Thai reviewer/operator report covering the implementation, verification checklist, pending real-runtime proof, dependency chain, integration review, and rollback.

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
- `docs/reports/2026-08-14-idea2-canonical-modular-runtime-th.md` — Thai Task 2 implementation and verification report.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea2/idea2-status.md` — recorded verified canonical development-runtime status and honest remaining integrations.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-08-13_221256_pub_canonical-modular-runtime.md` — this immutable receipt.

## Verification evidence

- `python -m unittest discover -s tests -v` from the modular engine — pass on 2026-08-14: 17/17 tests.
- Python in-memory `compile()` over modular, test, and legacy Python files — pass on 2026-08-14: 27 files.
- Default-component smoke with unavailable camera index 9999 and NAS/Monitor/Telegram disabled — pass: runtime started, NAS reported `disabled`, camera remained disconnected, and shutdown completed.
- Default-component `/health` smoke — pass: HTTP 200, `status=degraded`, `camera_connected=false`, and clean shutdown.
- Python `signal.raise_signal(SIGINT)` smoke through `run_forever()` — pass: cooperative shutdown completed.
- PyYAML Compose structure check — pass: YAML parsed, `aegis-camera` build context resolved to the modular engine, NAS default was false, local recording volumes were present, Monitor mounted recordings read-only, and port mapping was loopback-only.
- `npm.cmd test` from `IDEA2-AEGIS_Monitor` — pass on 2026-08-14: 6/6 tests.
- `node --test tests/*.test.mjs` — pass on 2026-08-14: 45/45 repository governance and Vault tests.
- `node scripts/validate-vault.mjs --vault Obsidian_AEGIS_Vault/AEGIS_Knowledge` — pass after the shared validator fix: no errors; two pre-existing canvas owner-review warnings remain.
- `docker compose config` — not run: Docker CLI is unavailable; PyYAML parsing and source-level Compose wiring tests passed instead.
- `git diff --check` — pass after adding the Thai report and updating this receipt; no whitespace errors.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea2/idea2-status.md` — modular engine is now canonical for development; real camera, Monitor heartbeat, Telegram, production NAS, and deployment remain explicitly pending.

## Shared surfaces touched

- `.env.example` — shared development configuration contract for the canonical IDEA2 service.
- `.gitignore` — repository-wide exclusion for modular runtime evidence output.
- `README.md` — shared repository module map.
- `docker-compose.yml` — shared local orchestration; only the `aegis-camera` service, Monitor's camera recording mount, and IDEA2 camera volumes changed.
- `docs/reports/2026-08-14-idea2-canonical-modular-runtime-th.md` — shared reviewer-facing Task 2 implementation, verification, rollout, and rollback report.

## Integration requests

- Kla integration review: confirm the root Compose service switch, local volume lifecycle, loopback port mapping, and rollback to the preceding `aegis-camera` block if the modular container fails on a Docker-capable host.
- Pub/security owner: revoke and rotate the previously committed Telegram credential before any real Telegram test; the value was removed and is intentionally not reproduced.
- Pub deployment follow-up: run `docker compose config`, build/start the service, and verify target-host camera access before treating this as a deployed runtime.

## Known limitations

- **REAL CAMERA VERIFICATION PENDING.** No camera frame, recorded segment, or MJPEG frame was produced in this environment.
- Monitor real heartbeat integration, Telegram real routing, production NAS integration, and production deployment remain pending.
- Face recognition remains `PlaceholderRecognizer`; all placeholder faces are `Unknown` and no enrollment exists.
- Docker CLI is unavailable, so container build, Compose runtime parsing, volume permissions, device pass-through, SIGTERM inside Linux, and container health were not executed.
- Vault validation now passes after merging the dedicated shared validator-fix dependency; the two canvas owner-review warnings are unchanged.
- As of 2026-08-14, `origin/main` still does not contain Task 1 or the validator fix. This branch is stacked on `fix/shared-vault-receipt-ownership` until those dependencies merge and must be retargeted/reverified afterward.
