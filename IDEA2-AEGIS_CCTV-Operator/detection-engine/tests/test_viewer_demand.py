import asyncio
import os
import queue
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

import numpy as np

import aegis_engine.stream_hub as stream_hub_module
import aegis_engine.video_catcher as video_catcher_module
from aegis_engine.config import EngineConfig
from aegis_engine.metrics import MetricsRegistry
from aegis_engine.models import DetectedEntity, DetectionResult, DetectionStatus, Frame
from aegis_engine.local_api import _DisconnectAwareStreamingResponse
from aegis_engine.segment_recorder import SegmentRecorder
from aegis_engine.stream_hub import StreamHub
from aegis_engine.video_catcher import VideoCatcher


class FakeCapture:
    def __init__(self):
        self.released = threading.Event()

    def read(self):
        time.sleep(0.01)
        return True, object()

    def get(self, _prop):
        return 640

    def release(self):
        self.released.set()


class ViewerDemandTests(unittest.TestCase):
    def test_stream_response_releases_viewer_on_asgi_disconnect(self):
        demand = threading.Event()
        with patch.object(
            stream_hub_module.cv2, "IMWRITE_JPEG_QUALITY", 1, create=True
        ):
            hub = StreamHub(
                EngineConfig(),
                queue.Queue(maxsize=1),
                capture_demand_event=demand,
            )

        async def exercise_disconnect():
            receive_queue = asyncio.Queue()
            await receive_queue.put(
                {"type": "http.request", "body": b"", "more_body": False}
            )
            first_chunk_sent = asyncio.Event()

            async def body():
                hub.add_viewer()
                try:
                    while True:
                        yield b"frame"
                        await asyncio.sleep(0)
                finally:
                    hub.remove_viewer()

            async def receive():
                return await receive_queue.get()

            async def send(message):
                if message["type"] == "http.response.body" and message.get("body"):
                    if not first_chunk_sent.is_set():
                        first_chunk_sent.set()
                        await receive_queue.put({"type": "http.disconnect"})

            response = _DisconnectAwareStreamingResponse(body())
            await asyncio.wait_for(
                response(
                    {"type": "http", "asgi": {"spec_version": "2.4"}},
                    receive,
                    send,
                ),
                timeout=1.0,
            )
            return first_chunk_sent.is_set()

        first_chunk_sent = asyncio.run(exercise_disconnect())

        self.assertTrue(first_chunk_sent)
        self.assertEqual(hub.viewers, 0)
        self.assertFalse(demand.is_set())

    def test_stream_hub_tracks_first_and_last_viewer(self):
        demand = threading.Event()
        with patch.object(
            stream_hub_module.cv2, "IMWRITE_JPEG_QUALITY", 1, create=True
        ):
            hub = StreamHub(
                EngineConfig(),
                queue.Queue(maxsize=1),
                capture_demand_event=demand,
            )

        hub.add_viewer()
        hub.add_viewer()
        self.assertTrue(demand.is_set())

        hub.remove_viewer()
        self.assertTrue(demand.is_set())
        hub.remove_viewer()
        self.assertFalse(demand.is_set())
        self.assertIsNone(hub.latest())

    def test_stream_uses_aligned_detection_boxes_without_mutating_source(self):
        frames = queue.Queue(maxsize=1)
        def fake_rectangle(image, first, _second, color, _thickness):
            image[first[1], first[0]] = color
            return image

        with (
            patch.object(stream_hub_module.cv2, "IMWRITE_JPEG_QUALITY", 1, create=True),
            patch.object(stream_hub_module.cv2, "FONT_HERSHEY_SIMPLEX", 0, create=True),
            patch.object(stream_hub_module.cv2, "FILLED", -1, create=True),
            patch.object(stream_hub_module.cv2, "LINE_AA", 16, create=True),
            patch.object(
                stream_hub_module.cv2,
                "rectangle",
                side_effect=fake_rectangle,
                create=True,
            ),
            patch.object(
                stream_hub_module.cv2,
                "getTextSize",
                return_value=((40, 10), 2),
                create=True,
            ),
            patch.object(
                stream_hub_module.cv2,
                "putText",
                side_effect=lambda image, *_args, **_kwargs: image,
                create=True,
            ),
        ):
            hub = StreamHub(EngineConfig(), frames)
            hub.add_viewer()
            source = np.zeros((120, 160, 3), dtype=np.uint8)
            frame = Frame(seq=7, image=source)
            result = DetectionResult(
                camera_id="CAM-05",
                frame_seq=7,
                entities=[
                    DetectedEntity(
                        status=DetectionStatus.UNKNOWN,
                        confidence=99.0,
                        bbox=(30, 20, 60, 70),
                    )
                ],
                processing_ms=4.0,
            )

            hub.submit_detection(result, frame)
            annotated = frames.get_nowait()

            self.assertEqual(annotated.seq, frame.seq)
            self.assertIsNot(annotated.image, source)
            self.assertFalse(source.any(), "raw recording frame was mutated")
            self.assertTrue(annotated.image.any(), "real bbox was not drawn")
            self.assertTupleEqual(
                tuple(int(v) for v in annotated.image[20, 30]),
                (0, 157, 255),
            )

    def test_stream_does_not_annotate_without_a_viewer(self):
        frames = queue.Queue(maxsize=1)
        with patch.object(
            stream_hub_module.cv2, "IMWRITE_JPEG_QUALITY", 1, create=True
        ):
            hub = StreamHub(EngineConfig(), frames)
        frame = Frame(seq=1, image=np.zeros((40, 40, 3), dtype=np.uint8))
        result = DetectionResult(
            camera_id="CAM-05",
            frame_seq=1,
            entities=[],
            processing_ms=1.0,
        )

        hub.submit_detection(result, frame)

        self.assertTrue(frames.empty())

    def test_segment_finalizes_when_last_viewer_leaves(self):
        demand = threading.Event()
        demand.set()
        stop = threading.Event()
        metrics = MetricsRegistry()
        finalized = []

        class FakeWriter:
            def __init__(self):
                self.released = threading.Event()

            def release(self):
                self.released.set()

        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "active.mp4")
            with open(path, "wb") as handle:
                handle.write(b"video")
            writer = FakeWriter()
            recorder = SegmentRecorder(
                EngineConfig(segment_dir=tmp),
                metrics,
                queue.Queue(),
                on_segment=finalized.append,
                stop_event=stop,
                capture_demand_event=demand,
            )
            recorder._writer = writer
            recorder._writer_size = (640, 480)
            recorder._current_path = path
            recorder._segment_started_monotonic = time.monotonic()
            recorder._segment_started_wall = "2026-08-15T00:00:00+00:00"
            recorder._segment_frames = 1
            recorder.start()

            demand.clear()
            self.assertTrue(writer.released.wait(1.5), "segment stayed open")
            stop.set()
            recorder.join(1.0)

        self.assertEqual(len(finalized), 1)

    def test_camera_opens_only_while_viewer_demand_exists(self):
        demand = threading.Event()
        stop = threading.Event()
        metrics = MetricsRegistry()
        catcher = VideoCatcher(
            EngineConfig(capture_on_demand=True, detection_engine_api_key="key"),
            metrics,
            sinks=[],
            stop_event=stop,
            capture_demand_event=demand,
        )
        opened = threading.Event()
        captures = []

        def open_camera():
            cap = FakeCapture()
            captures.append(cap)
            catcher._cap = cap
            opened.set()
            return True

        catcher._open_camera = open_camera
        with (
            patch.object(video_catcher_module.cv2, "CAP_PROP_FRAME_WIDTH", 3, create=True),
            patch.object(video_catcher_module.cv2, "CAP_PROP_FRAME_HEIGHT", 4, create=True),
        ):
            catcher.start()
            self.assertFalse(opened.wait(0.2), "camera opened without a viewer")

            demand.set()
            self.assertTrue(opened.wait(1.0), "camera did not open for a viewer")
            deadline = time.monotonic() + 1.0
            while not metrics.snapshot()["camera_connected"] and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertTrue(metrics.snapshot()["camera_connected"])

            demand.clear()
            self.assertTrue(captures[0].released.wait(1.0), "camera was not released")
            deadline = time.monotonic() + 1.0
            while metrics.snapshot()["camera_connected"] and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertFalse(metrics.snapshot()["camera_connected"])

            stop.set()
            catcher.join(1.0)
            self.assertFalse(catcher.is_alive())


if __name__ == "__main__":
    unittest.main()
