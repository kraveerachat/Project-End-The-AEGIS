#!/usr/bin/env python3
"""
AEGIS Monitor · Detection Engine — process entrypoint.

Headless service. Run it directly on the edge node:

    python run.py

Configuration is entirely via environment variables (see ``.env.example``);
copy that to ``.env`` and edit, or export the variables in your process
manager (systemd, supervisor, Task Scheduler…).

Selecting the face-recognition backend
--------------------------------------
The safe default is the identity-free placeholder. A camera node opts into the
trained YOLO model plus SFace identity verification with
``AEGIS_RECOGNIZER_BACKEND=yolo-sface-admin``. Model and biometric template
files remain outside Git.
"""

from __future__ import annotations

import sys

from aegis_engine.config import EngineConfig
from aegis_engine.engine import DetectionEngine
from aegis_engine.yolo_sface_admin_recognizer import build_configured_recognizer


def main() -> int:
    try:
        config = EngineConfig.from_env().validate()
        # Model selection is configuration-driven so every camera node can use
        # its own local weight path without editing or committing source code.
        recognizer = build_configured_recognizer(config)
        engine = DetectionEngine(config=config, recognizer=recognizer)
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
