# AEGIS IDEA2 — Canonical Modular Detection Runtime

This directory is the **primary development runtime for IDEA2 detection**.
The legacy `../../AEGIS_Camera/` implementation remains in the repository for
compatibility review, but root `docker-compose.yml` no longer starts it.

The canonical entry point is:

```text
python run.py
```

Root Compose now follows:

```text
docker compose
  -> service: aegis-camera
  -> detection-engine/Dockerfile
  -> python run.py
  -> aegis_engine.engine.DetectionEngine
```

## Honest feature state

| Subsystem | Current state |
|---|---|
| Configuration and logging | Implemented |
| Camera capture/reconnect | Implemented; real camera verification pending |
| Viewer-demand camera | Implemented behind `AEGIS_CAPTURE_ON_DEMAND`; real Monitor E2E pending |
| Face detection | Placeholder Haar fallback; optional trained YOLO candidate gate plus YuNet face/landmark detection |
| Face recognition | Placeholder by default; `yolo-sface-admin` requires YOLO and an enrolled SFace identity match before returning `Authorized` |
| Recording | Implemented; local segments are retained when NAS is disabled |
| Monitor client | Implemented, optional/fail-soft; real heartbeat integration pending |
| Live MJPEG stream | Implemented; detector-aligned `Unknown` boxes verified on a real Windows webcam; Production proxy remains unverified |
| Telegram | Dry-run when token/chat are absent; credential rotation required before real testing |
| NAS | Disabled by default; production transfer/integrity verification pending |

Object detection is not identity. The optional hybrid backend keeps the trained
YOLO model as its first gate, then verifies the aligned face against a local
SFace Admin template. A YOLO box alone, a missing model, a weak identity match,
or an inference failure cannot become `Authorized`.

## Development quick start

```bash
python -m venv .venv
# Windows: .venv\Scripts\activate
# Linux/macOS: source .venv/bin/activate
pip install -r requirements.txt
copy .env.example .env      # Windows
# cp .env.example .env      # Linux/macOS
python run.py
```

For a node using the trained local Admin model, install the optional YOLO
backend (YuNet/SFace run through the existing OpenCV dependency):

```bash
pip install -r requirements-ai.txt
```

Create the biometric template from at least three trusted images of the same
Admin. Source photos, ONNX files, the generated `.npz`, `.pt`, and `.env` all
remain local and must never be committed:

```bash
python enroll_admin.py \
  --input C:/local/trusted-admin-photos \
  --detector-model C:/local/models/face_detection_yunet_2023mar.onnx \
  --recognizer-model C:/local/models/face_recognition_sface_2021dec.onnx \
  --output C:/local/identity/admin_sface_v1.npz
```

Then set these local `.env` values:

```text
AEGIS_RECOGNIZER_BACKEND=yolo-sface-admin
AEGIS_ADMIN_MODEL_PATH=C:/path/to/admin-model.pt
AEGIS_ADMIN_CLASS_NAME=Admin-Face-Scan
AEGIS_ADMIN_DISPLAY_NAME=Admin
AEGIS_ADMIN_MIN_CONFIDENCE=50
AEGIS_FACE_DETECTOR_MODEL_PATH=C:/path/to/face_detection_yunet_2023mar.onnx
AEGIS_FACE_RECOGNIZER_MODEL_PATH=C:/path/to/face_recognition_sface_2021dec.onnx
AEGIS_ADMIN_EMBEDDINGS_PATH=C:/path/to/admin_sface_v1.npz
AEGIS_FACE_MATCH_COSINE_THRESHOLD=0.50
AEGIS_YOLO_GATE_TTL_S=2.0
```

The default development configuration has:

- `AEGIS_NAS_ENABLED=false`
- Monitor persistence disabled until both Monitor URL and service key are set
- Telegram in dry-run until both token and chat ID are set
- `PlaceholderRecognizer`, which can return only `Unknown` identities; real
  Admin recognition requires the explicit `yolo-sface-admin` configuration above

The runtime API can start while the camera is unavailable; `VideoCatcher`
reports disconnected state and retries with bounded exponential backoff.

### Viewer-demand camera mode

Set `AEGIS_CAPTURE_ON_DEMAND=true` on an interactive webcam node to keep the
Detection Engine API and heartbeat online without holding the physical camera
open. Monitor still authenticates the browser session and checks
`camera_assignment` before opening its upstream MJPEG connection. The first
authenticated upstream viewer activates capture; the last disconnect releases
the camera, clears the previous JPEG, and finalizes the active segment.

This mode requires `AEGIS_STREAM_ENABLED=true` and a non-empty
`AEGIS_DETECTION_ENGINE_API_KEY`. Configuration validation fails closed when
either boundary is missing. Multiple authorized viewers share one camera
handle, so one logout does not interrupt another viewer who is still watching.

The MJPEG feed is produced from the exact frame/result pair processed by the
detector. Bounding boxes are drawn on a copy for live viewing only; the
recording queue keeps the original camera pixels. The placeholder backend
labels every visible box `UNKNOWN`; the optional trained backend labels a face
authorized only after both the YOLO candidate gate and SFace identity gate pass.
No unrelated object class, YOLO-only result, or model failure is treated as an
authorized identity. This recognition label does not grant Monitor RBAC; web
access remains enforced server-side by Monitor.

The hybrid backend retains an overlapping YOLO candidate for two seconds to
smooth normal detector flicker in video. The cache is position-scoped and never
replaces SFace: identity verification still runs on every Authorized frame, and
an inference exception clears the cache immediately.
## Windows edge auto-start

Use the current-user Scheduled Task workflow after the virtual environment,
dependencies, `.env`, and camera selection are ready. It runs at user logon,
keeps the engine in the interactive Windows session where webcam access works,
starts with a hidden PowerShell window, and asks Task Scheduler to restart a
failed process.

Windows Service / `AtStartup` execution is intentionally not the default:
services run in Session 0 before the user's camera session is available and can
turn a working webcam into a false disconnected state.

From this directory in PowerShell:

```powershell
# Select/test the camera and write only the local .env first.
.\.venv\Scripts\python.exe setup_camera.py

# Safe parse/preflight: shows what would be registered without changing Task Scheduler.
powershell -NoProfile -ExecutionPolicy Bypass -File .\windows\install_autostart.ps1 -WhatIf

# Register only the engine for the current Windows user and start it now.
powershell -NoProfile -ExecutionPolicy Bypass -File .\windows\install_autostart.ps1 -StartNow

# Read task state and the latest local log lines.
powershell -NoProfile -ExecutionPolicy Bypass -File .\windows\status_autostart.ps1
```

When Monitor reaches this Detection Laptop through the approved IDEA2 SSH
reverse-tunnel boundary, register the optional tunnel task in the same command:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass `
  -File .\windows\install_autostart.ps1 `
  -TunnelHost "<ssh-user>@<server-ip>" `
  -IdentityFile "$env:USERPROFILE\.ssh\<private-key-file>" `
  -RemoteBindAddress "<approved-server-bind-ip>" `
  -RemotePort 18077 `
  -LocalPort 8077 `
  -StartNow
```

The tunnel is reverse-only and uses `BatchMode`, fail-fast forwarding, and SSH
keepalives. Its private key stays outside the repository. A protected key must
already be available to `ssh-agent`; otherwise the unattended task exits and
Task Scheduler applies the bounded restart policy. The SSH server's
`PermitListen` policy remains the authorization boundary, so this client task
cannot grant itself a broader bind address or port.

The wrapper stores lifecycle, stdout, and stderr logs under
`%LOCALAPPDATA%\AEGIS\DetectionEngine\logs`, outside the repository. Keeping
native process streams separate avoids Windows PowerShell 5.1 treating normal
Python stderr logging as a task failure. Configuration remains in the ignored
local `.env`; the scheduled task contains paths only and never copies secrets
into its definition.

Rollback removes only the engine and tunnel scheduled tasks and preserves
source, `.env`, the SSH identity, logs, recordings, and snapshots:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\windows\uninstall_autostart.ps1
```

Auto-start installation does not prove real-camera capture, tunnel reachability,
or Monitor heartbeat. Verify those independently after a fresh Windows
logoff/logon. Do not reuse one remote port for multiple camera nodes; each node
needs an infrastructure-approved listener and unique camera/node identity.

## Docker development stack

From the repository root:

```bash
docker compose up --build
```

The service is named `aegis-camera` for compatibility with Monitor's internal
stream URL, but it is built from this directory. Port `8077` is exposed to the
Docker network and mapped to host loopback `127.0.0.1:8005`. Local development
recordings use the `camera_segments` named volume. This volume is local storage,
not a production NAS and not evidence of a successful NAS transfer.

Camera device pass-through varies by Docker host. A running/degraded container
does not prove webcam capture; record that separately as
`REAL CAMERA VERIFICATION PENDING` until tested on the target edge node.

The default image installs only the safe core runtime and therefore keeps the
placeholder recognizer. Build the same Dockerfile with the optional AI layer
only on a node that will use the hybrid recognizer:

```bash
docker build \
  --build-arg AEGIS_INSTALL_AI=true \
  -t aegis-detection-engine:ai \
  IDEA2-AEGIS_CCTV-Operator/detection-engine
```

The YOLO weight, YuNet/SFace ONNX files, and enrolled `.npz` template must be
read-only runtime mounts outside the image. Point the corresponding
`AEGIS_*_MODEL_PATH` and `AEGIS_ADMIN_EMBEDDINGS_PATH` variables at those mount
paths. Never add those artifacts to a Docker build context, image layer, or Git.
Without the AI build argument and all four local artifacts, keep
`AEGIS_RECOGNIZER_BACKEND=placeholder`; the runtime must not claim Admin
recognition.

## Optional integrations

### Monitor

Set both values to enable event and heartbeat persistence:

```dotenv
AEGIS_MONITOR_API_BASE=http://monitor:8002
AEGIS_DETECTION_ENGINE_API_KEY=<same value as Monitor DETECTION_ENGINE_API_KEY>
```

If either is absent, `MonitorClient` logs that it is disabled and the core
runtime continues without claiming that rows were persisted. The engine never
holds a PostgreSQL credential.

### NAS

Development keeps NAS disabled. To enable it, configuration validation requires
at least:

```dotenv
AEGIS_NAS_ENABLED=true
AEGIS_NAS_METHOD=rsync
AEGIS_NAS_USER=<service account>
AEGIS_NAS_HOST=<reachable NAS host>
AEGIS_NAS_VERIFY=checksum
```

The only valid success path is:

```text
transfer -> destination exists -> checksum/size verification -> success
```

Only that path may post `storedOnNas=true` or delete the local recording.
Disabled, failed, interrupted, or unverified work keeps the local file and does
not post a successful clip.

### Telegram

Leave `AEGIS_TELEGRAM_BOT_TOKEN` and `AEGIS_TELEGRAM_CHAT_ID` blank for dry-run.
Never copy credentials from the legacy helper. The required security state is:

```text
Credential Rotation Required Before Telegram Real Testing
```

## Architecture

`DetectionEngine` initializes and manages:

1. configuration and logging;
2. `VideoCatcher` camera abstraction;
3. `FaceDetectorProcessor` recognition abstraction;
4. `SegmentRecorder`;
5. `MonitorClient`;
6. `HeartbeatWorker`;
7. `LocalEventAPI`, alerts, optional stream, and optional NAS worker.

Startup is transactional. If a component fails to start, already-started
components are stopped/joined and the entry point reports the component name.
SIGINT/SIGTERM trigger cooperative shutdown through one shared stop event.

## Tests

The tests use camera/runtime doubles and do not require real hardware:

```bash
python -m unittest discover -s tests -v
```

They cover configuration loading, NAS-disabled startup, lifecycle rollback and
shutdown, NAS success truthfulness, placeholder authorization safety,
YOLO+SFace two-gate authorization/fail-secure fallback, viewer-demand capture,
detector-aligned live boxes without raw-frame mutation, and operator-readable
startup failures.

## Deferred work

- Unknown-person negative-set calibration, liveness, and production accuracy acceptance
- Real camera verification on the edge node
- Real Monitor heartbeat integration
- Telegram routing/delivery after credential rotation
- Production NAS transfer verification
- Automatic reverse-tunnel startup after Windows logon
- PC/USB-camera auto-start verification
