#!/usr/bin/env python3
"""
AEGIS Monitor · Detection Engine — process entrypoint.

Headless service. Run it directly on the edge node:

    python run.py

Configuration is entirely via environment variables (see ``.env.example``);
copy that to ``.env`` and edit, or export the variables in your process
manager (systemd, supervisor, Task Scheduler…).

Injecting the real face-recognition model
-----------------------------------------
The engine ships with a placeholder recognizer so the whole pipeline runs
today. When the AI model is ready, implement the tiny ``FaceRecognizer``
contract (see ``aegis_engine/face_detector.py``) and pass an instance in::

    from aegis_engine.engine import DetectionEngine
    from my_team.model import ArcFaceRecognizer   # your module

    DetectionEngine(recognizer=ArcFaceRecognizer(weights="./model.pt")).run_forever()
"""

from __future__ import annotations

import sys

from aegis_engine.engine import DetectionEngine


def main() -> int:
    try:
        # >>> To enable real recognition, construct your model and pass it here:
        #     engine = DetectionEngine(recognizer=YourModel())
        engine = DetectionEngine()
        engine.run_forever()
        return 0
    except Exception as exc:
        # Keep the first operator-facing failure concise and actionable. Worker
        # and dependency errors already preserve their component/setting name.
        print(
            f"AEGIS Detection Engine failed to start: {type(exc).__name__}: {exc}",
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    sys.exit(main())
