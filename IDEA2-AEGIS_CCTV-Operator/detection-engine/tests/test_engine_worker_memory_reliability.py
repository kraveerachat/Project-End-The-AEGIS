from __future__ import annotations

import os
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

import numpy as np

import aegis_engine.engine as engine_module
import aegis_engine.nas_sync as nas_sync_module
import aegis_engine.segment_recorder as segment_recorder_module
import aegis_engine.stream_hub as stream_hub_module

from aegis_engine.config import EngineConfig
from aegis_engine.engine import DetectionEngine, EngineContext
from aegis_engine.event_hub import EventHub
from aegis_engine.metrics import MetricsRegistry
from aegis_engine.models import DetectionResult, Frame
from aegis_engine.nas_sync import NASSyncWorker
from aegis_engine.video_catcher import VideoCatcher


class EngineWorkerMemoryReliabilityRedTests(unittest.TestCase):

    @staticmethod
    def strict_components():
        cfg = EngineConfig(
            capture_on_demand=True,
            stream_enabled=True,
            detection_engine_api_key="test-key",
            record_queue_size=240,
        ).validate()

        context = EngineContext(
            config=cfg,
            metrics=MetricsRegistry(),
            event_hub=EventHub(),
            stop_event=threading.Event(),
            on_detection=lambda *_args: None,
        )

        components = DetectionEngine._build_default_components(
            context,
            recognizer=None,
        )

        return cfg, context, components

    def test_unhandled_capture_worker_failure_requests_engine_shutdown(self):
        demand = threading.Event()
        demand.set()

        stop = threading.Event()

        catcher = VideoCatcher(
            EngineConfig(
                capture_on_demand=True,
                detection_engine_api_key="test-key",
            ),
            MetricsRegistry(),
            sinks=[],
            stop_event=stop,
            capture_demand_event=demand,
        )

        def unexpected_failure():
            raise MemoryError("simulated terminal capture worker failure")

        catcher._wait_for_demand = unexpected_failure

        catcher.start()
        catcher.join(timeout=1.0)

        self.assertFalse(
            catcher.is_alive(),
            "test fixture expected the capture worker to terminate",
        )

        self.assertTrue(
            stop.is_set(),
            "terminal VideoCatcher failure left Engine process alive",
        )

    def test_strict_archive_queue_is_small_even_when_legacy_queue_is_240(self):
        _cfg, _context, components = self.strict_components()

        recorder = next(
            worker
            for worker in components.workers
            if getattr(worker, "name", "") == "SegmentRecorder"
        )

        self.assertGreater(
            recorder._queue.maxsize,
            0,
            "strict Archive queue must remain explicitly bounded",
        )

        self.assertLessEqual(
            recorder._queue.maxsize,
            4,
            "strict Archive must not buffer 240 full 1280x720 RGB frames",
        )

    def test_live_and_archive_render_annotation_once_per_detection_frame(self):
        _cfg, _context, components = self.strict_components()

        detector = next(
            worker
            for worker in components.workers
            if getattr(worker, "name", "") == "FaceDetector"
        )

        stream = next(
            worker
            for worker in components.workers
            if getattr(worker, "name", "") == "StreamHub"
        )

        lease = stream.add_viewer(
            producer_generation=1,
            logical_camera_id="CAM-01",
        )

        calls = []

        def render_once(result, frame):
            calls.append((result.frame_seq, frame.seq))

            return Frame(
                seq=frame.seq,
                image=frame.image.copy(),
                captured_at=frame.captured_at,
                captured_wall=frame.captured_wall,
            )

        frame = Frame(
            seq=42,
            image=np.zeros((120, 160, 3), dtype=np.uint8),
            captured_at=time.monotonic() + 0.050,
        )

        result = DetectionResult(
            camera_id="CAM-01",
            frame_seq=42,
            entities=[],
            processing_ms=1.0,
        )

        try:
            with (
                patch.object(
                    engine_module,
                    "annotate_detection_frame",
                    side_effect=render_once,
                    create=True,
                ),
                patch.object(
                    stream_hub_module,
                    "annotate_detection_frame",
                    side_effect=render_once,
                ),
                patch.object(
                    segment_recorder_module,
                    "annotate_detection_frame",
                    side_effect=render_once,
                ),
            ):
                detector._on_result(result, frame)
        finally:
            stream.remove_viewer(*lease)

        self.assertEqual(
            len(calls),
            1,
            "Live + strict Archive rendered a full-frame annotation more than once",
        )

    def test_strict_fanout_rejects_mismatched_result_frame_before_render(self):
        _cfg, _context, components = self.strict_components()

        detector = next(
            worker
            for worker in components.workers
            if getattr(worker, "name", "") == "FaceDetector"
        )

        recorder = next(
            worker
            for worker in components.workers
            if getattr(worker, "name", "") == "SegmentRecorder"
        )

        frame = Frame(
            seq=42,
            image=np.zeros((120, 160, 3), dtype=np.uint8),
            captured_at=time.monotonic() + 0.050,
        )

        result = DetectionResult(
            camera_id="CAM-01",
            frame_seq=41,
            entities=[],
            processing_ms=1.0,
        )

        with patch.object(
            engine_module,
            "annotate_detection_frame",
        ) as render:
            detector._on_result(result, frame)

        render.assert_not_called()

        self.assertEqual(
            recorder._queue.qsize(),
            0,
            "mismatched detection/frame pair entered strict Archive queue",
        )

    def test_h264_transcode_does_not_retry_after_shutdown_during_backoff(self):
        class StopDuringBackoff:
            def __init__(self):
                self.stopped = False

            def is_set(self):
                return self.stopped

            def wait(self, _timeout):
                self.stopped = True
                return True

        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "segment.mp4")

            with open(path, "wb") as handle:
                handle.write(b"original-mp4")

            stop = StopDuringBackoff()

            config = EngineConfig(
                nas_enabled=True,
                nas_user="aegis",
                nas_host="nas.local",
                nas_retry_backoff_s=0.1,
                nas_max_retries=3,
            ).validate()

            worker = NASSyncWorker(
                config,
                MetricsRegistry(),
                stop,
            )

            commands = []

            def fake_run(command, timeout):
                commands.append(list(command))
                return 1, "", "Cannot allocate memory"

            worker._run = fake_run

            with patch.object(
                nas_sync_module.shutil,
                "which",
                return_value="ffmpeg",
            ):
                result = worker._prepare_browser_playback(path)

            self.assertFalse(result)

            self.assertEqual(
                len(commands),
                1,
                "shutdown during transcode backoff launched another ffmpeg attempt",
            )

            with open(path, "rb") as handle:
                self.assertEqual(
                    handle.read(),
                    b"original-mp4",
                    "shutdown path modified the preserved source clip",
                )
    def test_h264_transcode_bounds_threads_and_retries_transient_oom(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "segment.mp4")

            with open(path, "wb") as handle:
                handle.write(b"original-mp4")

            config = EngineConfig(
                nas_enabled=True,
                nas_user="aegis",
                nas_host="nas.local",
                nas_retry_backoff_s=0,
                nas_max_retries=3,
            ).validate()

            worker = NASSyncWorker(
                config,
                MetricsRegistry(),
                threading.Event(),
            )

            commands = []

            def fake_run(command, timeout):
                commands.append(list(command))

                if len(commands) == 1:
                    return 1, "", "Cannot allocate memory"

                tmp_path = command[-1]

                with open(tmp_path, "wb") as handle:
                    handle.write(b"h264-video")

                return 0, "", ""

            worker._run = fake_run

            with patch.object(
                nas_sync_module.shutil,
                "which",
                return_value="ffmpeg",
            ):
                result = worker._prepare_browser_playback(path)

            self.assertTrue(
                result,
                "transient ffmpeg allocation failure was not retried",
            )

            self.assertEqual(
                len(commands),
                2,
                "transient allocation failure must use one bounded retry",
            )

            for command in commands:
                self.assertIn(
                    "-threads",
                    command,
                    "ffmpeg encoder thread count is not explicitly bounded",
                )

                thread_index = command.index("-threads")

                self.assertEqual(
                    command[thread_index + 1],
                    "1",
                    "archive transcode must use the reviewed single-thread bound",
                )

            self.assertTrue(os.path.exists(path))
            self.assertGreater(os.path.getsize(path), 0)


if __name__ == "__main__":
    unittest.main()