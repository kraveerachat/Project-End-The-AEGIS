"""
AEGIS Monitor · Detection Engine
================================

Headless, multi-threaded edge sensor service for the AEGIS Cyber-Physical
Security System. Runs on the Edge Node (laptop + webcam) and acts as the
*sensor layer*: it captures video, runs face recognition, records rolling
segments, ships them to the NAS, raises alerts, and exposes a local API for
the external Monitoring Web App.

There is **no UI in this package** — the UI is a separate web application that
consumes :class:`~aegis_engine.local_api.LocalEventAPI` (real-time) and the
shared database (persisted).

Thread topology (all glued together in :mod:`aegis_engine.engine`)::

                         +----------------------+
                         |    VideoCatcher      |  (1 thread, owns the camera)
                         +----------+-----------+
                                    | fan-out
              record_queue  <-------+------->  detect_queue (latest-frame only)
                   |                                   |
         +---------v---------+              +----------v-------------+
         |  SegmentRecorder  |              |  FaceDetectorProcessor |
         | (~10 min .mp4)    |              |  << AI MODEL INJECTED   |
         +---------+---------+              +----------+-------------+
                   | finalized segment                 | DetectionResult
            +------v-------+                    +-------+--------+---------+
            | NASSyncWorker|                    |               |         |
            | rsync/scp    |             MetricsRegistry   AlertManager  EventHub
            | verify+del   |             (FPS/latency)    (Telegram)   (WebSocket)
            +--------------+                                                |
                                                              +------------v-----------+
                                                              |     LocalEventAPI      |
                                                              | FastAPI + WS (web app) |
                                                              +------------------------+

Every worker is a :class:`threading.Thread` subclass that honours a shared
stop :class:`threading.Event` for cooperative, graceful shutdown.
"""

from __future__ import annotations

__all__ = [
    "__version__",
    "EngineConfig",
    "DetectedEntity",
    "DetectionResult",
    "DetectionStatus",
    "Frame",
    "MetricsRegistry",
    "EventHub",
    "VideoCatcher",
    "FaceDetectorProcessor",
    "SegmentRecorder",
    "AlertManager",
    "NASSyncWorker",
    "LocalEventAPI",
    "DetectionEngine",
]

__version__ = "0.1.0"

# NOTE: submodules are imported lazily by :mod:`aegis_engine.engine` and the
# entrypoint so that, e.g., importing :mod:`aegis_engine.config` does not drag
# in OpenCV / FastAPI. We deliberately avoid eager re-exports here to keep the
# import graph cheap for tooling and unit tests.
