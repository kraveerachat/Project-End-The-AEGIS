---
title: Task Receipt — Docker AI headless OpenCV readiness
date: 2026-08-21T16:10:44+07:00
owner: pub
area: idea2
branch: fix/idea2-docker-ai-headless-opencv
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — Docker AI headless OpenCV readiness

## What changed

- The optional IDEA2 AI container no longer retains Ultralytics' GUI OpenCV
  package. It reinstalls `opencv-python-headless` last so importing `cv2` does
  not require Linux X11 `libxcb` libraries.
- An isolated Compose smoke test proved healthy startup, honest degraded health
  without a camera, zero restart loops, and clean SIGTERM shutdown without
  touching the running AEGIS stack.

## Source files changed

- `IDEA2-AEGIS_CCTV-Operator/detection-engine/Dockerfile` — make the optional AI dependency layer Linux-headless compatible.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea2/idea2-status.md` — replace the stale Docker-unverified statement with the observed local evidence and limitations.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-08-21_161044_pub_docker-ai-headless-opencv.md` — immutable task evidence.

## Verification evidence

- `docker build --build-arg AEGIS_INSTALL_AI=true -t aegis-ai-validation-aegis-camera:latest IDEA2-AEGIS_CCTV-Operator/detection-engine` — pass: optional AI image built successfully.
- `docker run --rm --entrypoint python aegis-ai-validation-aegis-camera:latest -c "import cv2, torch, fastapi, uvicorn; from ultralytics import YOLO"` — pass: OpenCV, Torch, FastAPI, Uvicorn, and YOLO imported; CUDA reported unavailable on this Docker Desktop host.
- `docker compose -p aegis-idea2-compose-validation -f docker-compose.yml -f compose.ai-validation.override.yml up --no-deps --no-build -d aegis-camera` — pass: isolated container became healthy on `127.0.0.1:18005`, returned HTTP 200 with `status=degraded` for unavailable camera 99, and kept `restart_count=0`.
- `docker compose ... stop -t 20 aegis-camera` — pass: SIGTERM stopped capture, alert, detector, stream, and recorder workers; process exited 0 and port 18005 closed.
- `python -m unittest discover -s tests -v` — pass: 40/40 Detection Engine tests.
- `git diff --check` — pass.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea2/idea2-status.md` — Docker AI build/up is now locally verified while Docker webcam, CUDA, and Internal/Production deployment remain unclaimed.

## Shared surfaces touched

- None — task stayed inside the IDEA2 code and knowledge boundaries.

## Integration requests

- None — no cross-scope or shared path changed; normal Pub owner review is still required before merge.

## Known limitations

- Docker Desktop reported `CUDA_AVAILABLE=False`; GPU execution was not verified.
- Docker webcam passthrough was not verified. Real camera evidence remains from the native Windows runtime.
- Monitor, reverse-tunnel, Telegram-after-rotation, production NAS, and Internal/Production end-to-end verification are separate tasks.
