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
| Face detection | Haar-based development placeholder |
| Face recognition | Identity-free placeholder by default; explicit local YOLO + YuNet + SFace enrollment backend available, never YOLO-only authorization |
| Recording | Implemented; local segments are retained when NAS is disabled |
| Monitor client | Implemented, optional/fail-soft; real heartbeat integration pending |
| Live MJPEG stream | Detection-aligned boxes/labels on copied frames; authenticated viewer-demand mode releases the camera when the last stream closes |
| Telegram | Dry-run when token/chat are absent; credential rotation required before real testing |
| NAS | Disabled by default; production transfer/integrity verification pending |
| Windows auto-start | Portable installer, Engine supervisor, SYSTEM tunnel reconnect, status/repair/uninstall scripts implemented; every laptop still needs machine-specific provisioning and reboot proof |

Object detection is not identity. The modular runtime does not import the
legacy `YOLO/object -> Authorized/Admin` behavior and must never infer access
authorization from an object class.

### Viewer-demand capture and locally enrolled recognition

`AEGIS_CAPTURE_ON_DEMAND=true` keeps API/heartbeat alive while the webcam is
released with no authenticated MJPEG viewers. Health reports `idle`,
`camera_demanded=false`, `camera_connected=false` and `stream_viewers=0`.
The first authorized stream opens the camera; the last disconnect releases it
and finalizes its recording segment. Multiple browser tabs count separately.
Always-on capture remains the default for compatibility. On-demand capture
means there is **no recording or detection while nobody is viewing**.

Live frames now come from the detector's exact frame/result pair. Bounding
boxes and names are burned into a copy, leaving recordings unmodified. Live FPS
is limited by inference throughput; an empty detection still sends its frame.
Frames from a closed viewer session cannot be replayed to a new session.

For an already enrolled node, install `pip install -r requirements-ai.txt` and
set `AEGIS_RECOGNIZER_BACKEND=yolo-sface-admin` plus the four local asset paths
in `.env.example`. This reuses existing YOLO weights, YuNet/SFace models and the
matching Admin `.npz` enrollment; it does not enroll or distribute a person.
Missing assets or dependencies fail startup, never silently select placeholder.
An Authorized result requires both a spatially overlapping YOLO candidate and
an SFace template match. This is a model verdict, **not liveness detection or
a replacement for Monitor's session/RBAC authorization**.

The optional [official headless Ultralytics distribution](https://docs.ultralytics.com/quickstart/#headless-server-installation)
preserves the existing headless OpenCV provider. Do not install both Ultralytics
distributions into one environment. Model weights, private images, enrollment,
credentials and virtual environments stay outside Git.

Cold first-frame timeout defaults to 45 seconds, separate from the 15-second
steady-state idle timeout. Actual device-open time still depends on the camera
driver; acceptance must measure real open, close, and reopen on the target node.

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

The default development configuration has:

- `AEGIS_NAS_ENABLED=false`
- Monitor persistence disabled until both Monitor URL and service key are set
- Telegram in dry-run until both token and chat ID are set
- `PlaceholderRecognizer`, which can return only `Unknown` identities

The runtime API can start while the camera is unavailable; `VideoCatcher`
reports disconnected state and retries with bounded exponential backoff.

## Windows Detection Laptop installation

Use [`windows/README.md`](windows/README.md) for the Windows bootstrap. It
installs a machine-local copy under `%LOCALAPPDATA%`, creates a runtime-local
Python environment, starts the webcam Engine after user login, and maintains
the SSH tunnel as a SYSTEM startup task. The installer requires a
machine-specific `.env`, a unique per-laptop SSH identity, and a verified
`known_hosts` file; none of those files are committed.

The service private key is finalized with a SYSTEM-only protected ACL. A
one-time SYSTEM task performs any key copy/migration, hardening, and strict SSH
forward/Monitor health probe before persistent tunnel registration; elevated
repair does not require or retain access to the service key.

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

## Persistent edge-node installation

- Windows nodes use the scripts and runbook in `windows/`.
- Arch Linux and other systemd nodes use `linux/install_systemd.sh` plus the
  status, repair and non-destructive uninstall helpers documented in
  `linux/README.md`.

Both installers keep `.env`, SSH private keys, models, biometric enrollment,
recordings and local virtual environments outside Git. Every additional node
must have a unique camera/node identity, its own SSH key and a server-approved
unique reverse-forward port; local ports `8077` and `18002` may be reused on
different machines.

They cover configuration loading, NAS-disabled startup, lifecycle rollback and
shutdown, NAS success truthfulness, placeholder/hybrid authorization safety,
viewer acquisition/release, send-error/cancellation cleanup, frame alignment,
old-session exclusion and operator-readable startup failures.

## Deferred work

- Enrollment provisioning and measured real-person accuracy/liveness evaluation
- Real camera verification on the edge node
- Real Monitor heartbeat integration
- Telegram routing/delivery after credential rotation
- Production NAS transfer verification
- Elevated installer execution, reboot recovery, and real-camera verification
  on every newly provisioned Detection Laptop
