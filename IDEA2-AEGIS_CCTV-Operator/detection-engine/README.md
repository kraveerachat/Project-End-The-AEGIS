# AEGIS Monitor · Detection Engine

**Runs on: Laptop (GPU host). Headless background service — no UI.**

The sensor layer of the AEGIS Cyber-Physical Security System. It reads the
webcam, runs face recognition, records rolling ~10-minute segments, ships them
to the NAS, raises Telegram alerts on unknown faces, and exposes a local API so
the external Monitoring Web App can stream live detections / FPS / latency.

- AI face-recognition pipeline: capture → detect → recognize → results.
- **No UI.** This is a headless worker/service. The Beelink `web-app/` reads
  what this engine writes; the two never call each other directly.
- Model files (`.pt`, `.h5`, weights) live **here**, in this folder, and are
  **git-ignored** — never commit model binaries.
- Writes to shared tables (e.g. `camera_assignment`, detection/event tables).
  Read the central notes in `../../shared/db-schema/` before adding columns.

## Architecture

Six modules, each an independent, cooperatively-stoppable thread, glued by
`aegis_engine/engine.py` with thread-safe Queues:

```
                       ┌────────────────────┐
                       │    VideoCatcher     │  owns the camera (1 thread)
                       └─────────┬──────────┘
                        fan-out  │
        record_queue  ◀──────────┼──────────▶  detect_queue (latest frame only)
        (drop-oldest) │                        │
        ┌─────────────▼─────────┐   ┌──────────▼───────────────┐
        │   SegmentRecorder     │   │  FaceDetectorProcessor    │
        │   ~10 min .mp4 files  │   │  << INJECT AI MODEL HERE  │
        └─────────────┬─────────┘   └──────────┬───────────────┘
                      │ finalized segment       │ DetectionResult
              ┌───────▼──────┐        ┌─────────┼──────────┬───────────┐
              │ NASSyncWorker │       │          │          │           │
              │ rsync/scp     │  MetricsRegistry │   AlertManager   LocalEventAPI
              │ verify+delete │  (FPS/latency)   │   (Telegram)   FastAPI + WS
              └──────────────┘        └──────────┴───────────────────┘
```

| Module | File | Responsibility |
| ------ | ---- | -------------- |
| `VideoCatcher` | `video_catcher.py` | Dedicated capture thread; fans frames to record/detect queues with drop policies; reconnects with backoff. |
| `FaceDetectorProcessor` | `face_detector.py` | **AI injection point.** Consumes the freshest frame, runs the model, emits `DetectedEntity` lists. Ships with a placeholder recognizer. |
| `SegmentRecorder` | `segment_recorder.py` | Continuous recording; rolls a new file every ~10 min (interval-based, *not* detection-triggered). |
| `AlertManager` | `alert_manager.py` | Debounces `Unknown` detections; async-sends snapshot + payload to a Telegram bot. |
| `NASSyncWorker` | `nas_sync.py` | rsync/scp segments to the NAS, verify checksum/size, delete local **only** on verified success. |
| `LocalEventAPI` | `local_api.py` | FastAPI + WebSocket; streams detection JSON, FPS and latency to the web app. |

## Quick start

```bash
cd detection-engine
python -m venv .venv && . .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install -r requirements.txt

cp .env.example .env        # edit camera source, NAS host, Telegram token…
python run.py
```

Runs out of the box with a **placeholder** recognizer (Haar face boxes, all
labelled `Unknown`), so the full pipeline — recording, alerts, NAS sync, API —
is exercisable before the AI model exists.

### Consume the live API

```bash
curl http://localhost:8077/health
curl http://localhost:8077/metrics
curl http://localhost:8077/detections/recent
# WebSocket stream of detections + metrics heartbeat:
#   ws://localhost:8077/ws/events
```

## Plugging in the real face-recognition model

Implement one method — no import from this package required on the model side:

```python
class ArcFaceRecognizer:
    def __init__(self, weights="./model.pt"):
        ...  # load weights (files live in this folder, git-ignored)

    def recognize(self, image_bgr):
        # image_bgr: HxWx3 uint8 numpy array (OpenCV BGR)
        # return a list[DetectedEntity], one per face
        return [DetectedEntity(status=DetectionStatus.AUTHORIZED,
                               name="M. REYES", confidence=98.2,
                               bbox=(x, y, w, h))]
```

Then wire it in `run.py`:

```python
DetectionEngine(recognizer=ArcFaceRecognizer()).run_forever()
```

Everything else keeps working unchanged. The `DetectedEntity` / `DetectionResult`
shapes in `aegis_engine/models.py` are the single source of truth for the JSON
the web app consumes.

## Threading & safety notes

- Every worker is a `threading.Thread` honouring a shared stop `Event` for
  graceful shutdown (SIGINT/SIGTERM handled in `run_forever`).
- Frames pass between threads via `queue.Queue`. The **detect** queue is size-1
  (always process the freshest frame); the **record** queue drops the oldest
  frame under back-pressure to bound memory.
- Frames are passed by reference — treat `Frame.image` as read-only downstream.
- A model exception never kills the pipeline: it is logged and the frame skipped.
- Segments are deleted locally **only** after a verified NAS transfer; a segment
  that never verifies is kept on disk and logged loudly.

## Boundary

Writes to the DB; it does **not** serve the web UI. The Beelink `web-app/` reads
what this engine writes. The `../../shared/db-schema/` notes own the shared
tables. Persisting `DetectionResult` to the DB is left as a marked seam in
`engine.py` (`_on_detection`) — add a `DBWriter` worker there to keep the
engine → DB → web-app boundary intact.
