"""
Logging configuration.

A single :func:`configure` call at process start wires up a consistent format
across every worker thread. The thread name is included in every record, which
makes the multi-threaded pipeline easy to follow in the logs
(``VideoCatcher``, ``FaceDetector``, ``SegmentRecorder`` …).

Set ``AEGIS_LOG_JSON=true`` for line-delimited JSON logs suitable for shipping
to a log aggregator; otherwise a human-readable console format is used.
"""

from __future__ import annotations

import json
import logging
import sys
from datetime import datetime, timezone

_CONFIGURED = False


class _JsonFormatter(logging.Formatter):
    """Minimal, dependency-free JSON log formatter."""

    def format(self, record: logging.LogRecord) -> str:
        payload = {
            "ts": datetime.fromtimestamp(record.created, timezone.utc).isoformat(),
            "level": record.levelname,
            "thread": record.threadName,
            "logger": record.name,
            "msg": record.getMessage(),
        }
        if record.exc_info:
            payload["exc"] = self.formatException(record.exc_info)
        return json.dumps(payload, ensure_ascii=False)


def configure(level: str = "INFO", json_logs: bool = False) -> None:
    """Idempotently configure the root logger for the engine.

    Safe to call more than once; only the first call takes effect.
    """
    global _CONFIGURED
    if _CONFIGURED:
        return

    handler = logging.StreamHandler(stream=sys.stderr)
    if json_logs:
        handler.setFormatter(_JsonFormatter())
    else:
        handler.setFormatter(
            logging.Formatter(
                fmt="%(asctime)s | %(levelname)-7s | %(threadName)-16s | %(name)s | %(message)s",
                datefmt="%Y-%m-%d %H:%M:%S",
            )
        )

    root = logging.getLogger()
    root.handlers.clear()
    root.addHandler(handler)
    root.setLevel(getattr(logging, level.upper(), logging.INFO))

    # Third-party servers are noisy at INFO; keep them at WARNING.
    for noisy in ("uvicorn", "uvicorn.error", "uvicorn.access", "asyncio"):
        logging.getLogger(noisy).setLevel(logging.WARNING)

    _CONFIGURED = True


def get_logger(name: str) -> logging.Logger:
    """Convenience accessor so callers don't import ``logging`` directly."""
    return logging.getLogger(name)
