import asyncio
import queue
import threading
import unittest
from unittest.mock import patch

import numpy as np
from starlette.requests import Request

from aegis_engine.config import EngineConfig
from aegis_engine.local_api import LocalEventAPI, _DisconnectAwareStreamingResponse, _stream_wait_limit
from aegis_engine.metrics import MetricsRegistry
from aegis_engine.models import DetectionResult, Frame
from aegis_engine.stream_hub import StreamHub


class StreamLifecycleRegressionTests(unittest.TestCase):
    def hub(self):
        return StreamHub(EngineConfig(), queue.Queue(maxsize=1),
                         capture_demand_event=threading.Event())

    def test_late_detection_from_closed_session_is_not_queued(self):
        hub = self.hub()
        hub.add_viewer()
        old = Frame(1, np.zeros((40, 40, 3), dtype=np.uint8))
        hub.remove_viewer()
        hub.add_viewer()
        hub.submit_detection(DetectionResult('CAM-01', 1, [], 0), old)
        self.assertTrue(hub._queue.empty())

    def test_wrong_frame_result_pair_is_not_drawn(self):
        hub = self.hub()
        hub.add_viewer()
        frame = Frame(2, np.zeros((40, 40, 3), dtype=np.uint8))
        hub.submit_detection(DetectionResult('CAM-01', 1, [], 0), frame)
        self.assertTrue(hub._queue.empty())

    def test_encode_in_flight_cannot_replay_previous_session(self):
        hub = self.hub()
        encoding = threading.Event()
        release = threading.Event()
        finished = threading.Event()

        def encode(*_args):
            encoding.set()
            release.wait(2)
            finished.set()
            return True, np.array([1, 2, 3], dtype=np.uint8)

        with patch('aegis_engine.stream_hub.cv2.imencode', side_effect=encode):
            hub.add_viewer()
            hub.start()
            try:
                hub._queue.put(Frame(1, np.zeros((40, 40, 3), dtype=np.uint8)))
                self.assertTrue(encoding.wait(1))
                hub.remove_viewer()
                hub.add_viewer()
                release.set()
                self.assertTrue(finished.wait(1))
                self.assertIsNone(hub.wait_for(-1, .1))
            finally:
                release.set()
                hub.stop()
                hub.join(2)
        self.assertFalse(hub._capture_demand_event.is_set())

    def test_health_is_idle_and_rejected_streams_never_activate_camera(self):
        async def exercise():
            for expected_key, provided_key, status in [('secret-test', '', 401), ('', '', 503), ('secret-test', 'wrong-test', 401)]:
                hub = self.hub()
                cfg = EngineConfig(capture_on_demand=True, detection_engine_api_key=expected_key)
                api = LocalEventAPI(cfg, MetricsRegistry(), stream_hub=hub,
                                    capture_demand_event=hub._capture_demand_event)
                routes = {r.path: r.endpoint for r in api._app.routes}
                health = await routes['/health']()
                self.assertEqual(health['status'], 'idle')
                self.assertFalse(health['camera_demanded'])
                self.assertEqual(health['stream_viewers'], 0)
                req = Request({'type': 'http', 'headers': [(b'x-detection-engine-key', provided_key.encode())]})
                response = await routes['/stream.mjpg'](req)
                self.assertEqual(response.status_code, status)
                self.assertFalse(hub._capture_demand_event.is_set())
        asyncio.run(exercise())

    def test_camera_failure_is_degraded_not_idle_when_demanded(self):
        hub = self.hub()
        hub.add_viewer()
        api = LocalEventAPI(EngineConfig(capture_on_demand=True), MetricsRegistry(),
                            stream_hub=hub, capture_demand_event=hub._capture_demand_event)
        endpoint = next(r.endpoint for r in api._app.routes if r.path == '/health')
        self.assertEqual(asyncio.run(endpoint())['status'], 'degraded')

    def test_authorized_http_stream_acquires_and_releases_demand(self):
        async def exercise():
            hub = self.hub()
            cfg = EngineConfig(capture_on_demand=True, detection_engine_api_key='test-key')
            api = LocalEventAPI(cfg, MetricsRegistry(), stream_hub=hub,
                                capture_demand_event=hub._capture_demand_event)
            endpoint = next(r.endpoint for r in api._app.routes if r.path == '/stream.mjpg')
            response = await endpoint(Request({'type': 'http', 'headers': [(b'x-detection-engine-key', b'test-key')]}))
            self.assertEqual(response.status_code, 200)
            self.assertEqual(hub.viewers, 0)
            events = asyncio.Queue()
            received_frame = False

            async def send(message):
                nonlocal received_frame
                if message['type'] == 'http.response.body' and message.get('body'):
                    self.assertEqual(hub.viewers, 1)
                    self.assertTrue(hub._capture_demand_event.is_set())
                    received_frame = True
                    await events.put({'type': 'http.disconnect'})

            with patch.object(hub, 'wait_for', return_value=(1, b'test-jpeg')):
                await asyncio.wait_for(response({'type': 'http'}, events.get, send), 1)
            self.assertTrue(received_frame)
            self.assertEqual(hub.viewers, 0)
            self.assertFalse(hub._capture_demand_event.is_set())
        asyncio.run(exercise())

    def test_first_frame_and_idle_deadlines_are_distinct(self):
        cfg = EngineConfig(stream_first_frame_timeout_s=45, stream_idle_timeout_s=15)
        self.assertEqual(_stream_wait_limit(cfg, False), 45)
        self.assertEqual(_stream_wait_limit(cfg, True), 15)

    def exercise_teardown(self, mode):
        async def exercise():
            hub = self.hub()
            reached_send = asyncio.Event()

            async def body():
                hub.add_viewer()
                try:
                    while True:
                        yield b'frame'
                        await asyncio.sleep(0)
                finally:
                    hub.remove_viewer()

            async def receive():
                await asyncio.Future()

            async def send(message):
                if message['type'] == 'http.response.body':
                    reached_send.set()
                    if mode == 'write-error':
                        raise OSError('peer closed')
                    await asyncio.Future()

            response = _DisconnectAwareStreamingResponse(body())
            task = asyncio.create_task(response({'type': 'http'}, receive, send))
            await asyncio.wait_for(reached_send.wait(), 1)
            if mode == 'cancel':
                task.cancel()
            await asyncio.wait_for(asyncio.gather(task, return_exceptions=True), 1)
            self.assertEqual(hub.viewers, 0)
            self.assertFalse(hub._capture_demand_event.is_set())
        asyncio.run(exercise())

    def test_write_error_releases_viewer_immediately(self):
        self.exercise_teardown('write-error')

    def test_server_cancellation_releases_viewer_immediately(self):
        self.exercise_teardown('cancel')


if __name__ == '__main__':
    unittest.main()
