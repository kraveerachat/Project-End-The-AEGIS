import asyncio
import unittest

from starlette.requests import Request

from aegis_engine.config import EngineConfig
from aegis_engine.local_api import LocalEventAPI
from aegis_engine.metrics import MetricsRegistry
from aegis_engine.stream_hub import StreamHub

import queue
import threading


class RecordingStreamHub:
    def __init__(self):
        self.viewer_generations = []

    def add_viewer(self, *, producer_generation):
        self.viewer_generations.append(producer_generation)
        return "viewer-owner", 1

    def prepare_producer_generation(self, _producer_generation):
        return None

    def remove_viewer(self, *_lease):
        return None

    def viewer_is_active(self, *_lease):
        return True

    def latest(self):
        return 1, b"test-jpeg"

    def wait_for(self, _after_seq, _timeout):
        return None


class ProducerGenerationContractTests(unittest.TestCase):
    def endpoint(self, stream_hub=None, *, capture_on_demand=True):
        api = LocalEventAPI(
            EngineConfig(
                detection_engine_api_key="test-key",
                capture_on_demand=capture_on_demand,
            ),
            MetricsRegistry(),
            stream_hub=stream_hub or RecordingStreamHub(),
        )
        return next(
            route.endpoint for route in api._app.routes if route.path == "/stream.mjpg"
        )

    @staticmethod
    def request(*headers, query_string=b"", body=b""):
        delivered = False

        async def receive():
            nonlocal delivered
            if delivered:
                return {"type": "http.disconnect"}
            delivered = True
            return {"type": "http.request", "body": body, "more_body": False}

        return Request(
            {
                "type": "http",
                "method": "GET",
                "path": "/stream.mjpg",
                "query_string": query_string,
                "headers": list(headers),
            },
            receive,
        )

    def test_engine_key_is_checked_before_generation(self):
        response = asyncio.run(
            self.endpoint()(
                self.request((b"x-aegis-producer-generation", b"not-valid"))
            )
        )

        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.body, b'{"error":"unauthorized"}')

    def test_authenticated_stream_requires_exactly_one_generation_header(self):
        async def exercise():
            endpoint = self.endpoint()
            missing = await endpoint(
                self.request((b"x-detection-engine-key", b"test-key"))
            )
            duplicate = await endpoint(
                self.request(
                    (b"x-detection-engine-key", b"test-key"),
                    (b"x-aegis-producer-generation", b"21"),
                    (b"x-aegis-producer-generation", b"22"),
                )
            )
            return missing, duplicate

        missing, duplicate = asyncio.run(exercise())

        for response in (missing, duplicate):
            self.assertEqual(response.status_code, 400)
            self.assertEqual(response.body, b'{"error":"invalid producer generation"}')

    def test_always_on_compatibility_stream_does_not_invent_generation_authority(self):
        async def exercise():
            stream_hub = RecordingStreamHub()
            response = await self.endpoint(
                stream_hub, capture_on_demand=False
            )(
                self.request((b"x-detection-engine-key", b"test-key"))
            )
            receive_queue = asyncio.Queue()
            await receive_queue.put(
                {"type": "http.request", "body": b"", "more_body": False}
            )

            async def send(message):
                if message["type"] == "http.response.body" and message.get("body"):
                    await receive_queue.put({"type": "http.disconnect"})

            await asyncio.wait_for(
                response(
                    {"type": "http", "asgi": {"spec_version": "2.4"}},
                    receive_queue.get,
                    send,
                ),
                timeout=1.0,
            )
            return response.status_code, stream_hub.viewer_generations

        status, generations = asyncio.run(exercise())

        self.assertEqual(status, 200)
        self.assertEqual(generations, [None])

    def test_authenticated_stream_rejects_noncanonical_or_out_of_range_generation(self):
        invalid_values = (
            b"",
            b"0",
            b"-1",
            b"+1",
            b" 1",
            b"1 ",
            b"01",
            b"1.0",
            b"not-a-generation",
            "١".encode("utf-8"),
            b"9223372036854775808",
            b"9" * 5_000,
        )

        async def exercise(value):
            return await self.endpoint()(
                self.request(
                    (b"x-detection-engine-key", b"test-key"),
                    (b"x-aegis-producer-generation", value),
                )
            )

        for value in invalid_values:
            with self.subTest(value=value):
                response = asyncio.run(exercise(value))
                self.assertEqual(response.status_code, 400)
                self.assertEqual(
                    response.body, b'{"error":"invalid producer generation"}'
                )

    def test_query_string_cannot_substitute_for_generation_header(self):
        response = asyncio.run(
            self.endpoint()(
                self.request(
                    (b"x-detection-engine-key", b"test-key"),
                    query_string=b"producer_generation=21",
                )
            )
        )

        self.assertEqual(response.status_code, 400)

    def test_request_body_cannot_substitute_for_generation_header(self):
        response = asyncio.run(
            self.endpoint()(
                self.request(
                    (b"x-detection-engine-key", b"test-key"),
                    (b"content-type", b"application/json"),
                    body=b'{"producerGeneration":"21"}',
                )
            )
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.body, b'{"error":"invalid producer generation"}')

    def test_max_postgresql_bigint_generation_reaches_viewer_lease_exactly(self):
        async def exercise():
            stream_hub = RecordingStreamHub()
            response = await self.endpoint(stream_hub)(
                self.request(
                    (b"x-detection-engine-key", b"test-key"),
                    (
                        b"x-aegis-producer-generation",
                        b"9223372036854775807",
                    ),
                )
            )
            receive_queue = asyncio.Queue()
            await receive_queue.put(
                {"type": "http.request", "body": b"", "more_body": False}
            )

            async def send(message):
                if message["type"] == "http.response.body" and message.get("body"):
                    await receive_queue.put({"type": "http.disconnect"})

            await asyncio.wait_for(
                response(
                    {"type": "http", "asgi": {"spec_version": "2.4"}},
                    receive_queue.get,
                    send,
                ),
                timeout=1.0,
            )
            return response.status_code, stream_hub.viewer_generations

        status, generations = asyncio.run(exercise())

        self.assertEqual(status, 200)
        self.assertEqual(generations, [9223372036854775807])

    def test_stale_generation_is_rejected_before_stream_response_or_new_demand(self):
        hub = StreamHub(
            EngineConfig(),
            queue.Queue(maxsize=1),
            capture_demand_event=threading.Event(),
        )
        current = hub.add_viewer(producer_generation=22)

        response = asyncio.run(
            self.endpoint(hub)(
                self.request(
                    (b"x-detection-engine-key", b"test-key"),
                    (b"x-aegis-producer-generation", b"21"),
                )
            )
        )

        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.body, b'{"error":"stale producer generation"}')
        self.assertEqual(hub.viewers, 1)
        self.assertTrue(hub.viewer_is_active(*current))
        self.assertTrue(hub._capture_demand_event.is_set())

    def test_generation_superseded_before_body_iteration_closes_without_demand(self):
        async def exercise():
            demand = threading.Event()
            hub = StreamHub(
                EngineConfig(),
                queue.Queue(maxsize=1),
                capture_demand_event=demand,
            )
            response = await self.endpoint(hub)(
                self.request(
                    (b"x-detection-engine-key", b"test-key"),
                    (b"x-aegis-producer-generation", b"21"),
                )
            )

            # A newer producer may win after route preflight but before the
            # streaming response body begins acquiring its viewer lease.
            hub.prepare_producer_generation(22)
            chunks = [chunk async for chunk in response.body_iterator]
            return response.status_code, chunks, hub, demand

        status, chunks, hub, demand = asyncio.run(exercise())

        self.assertEqual(status, 200)
        self.assertEqual(chunks, [])
        self.assertEqual(hub.viewers, 0)
        self.assertFalse(demand.is_set())
        self.assertEqual(hub._current_producer_generation, 22)

    def test_active_http_generator_stops_when_newer_generation_wins(self):
        async def exercise():
            demand = threading.Event()
            hub = StreamHub(
                EngineConfig(),
                queue.Queue(maxsize=1),
                capture_demand_event=demand,
            )
            response = await self.endpoint(hub)(
                self.request(
                    (b"x-detection-engine-key", b"test-key"),
                    (b"x-aegis-producer-generation", b"21"),
                )
            )
            first_old_chunk = asyncio.create_task(anext(response.body_iterator))
            for _ in range(100):
                if hub.viewers == 1:
                    break
                await asyncio.sleep(0.001)
            self.assertEqual(hub.viewers, 1)

            current = hub.add_viewer(producer_generation=22)
            with self.assertRaises(StopAsyncIteration):
                await asyncio.wait_for(first_old_chunk, timeout=1.0)

            self.assertEqual(hub.viewers, 1)
            self.assertTrue(hub.viewer_is_active(*current))
            self.assertTrue(demand.is_set())
            hub.remove_viewer(*current)
            return hub, demand

        hub, demand = asyncio.run(exercise())

        self.assertEqual(hub.viewers, 0)
        self.assertFalse(demand.is_set())


if __name__ == "__main__":
    unittest.main()
