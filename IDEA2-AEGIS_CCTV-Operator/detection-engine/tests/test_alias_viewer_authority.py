import asyncio
import queue
import threading
import unittest

from aegis_engine.config import EngineConfig
from aegis_engine.stream_hub import StaleProducerGenerationError, StreamHub
import test_producer_generation_contract as contract


class AliasViewerAuthorityTests(unittest.TestCase):
    def hub(self):
        return StreamHub(EngineConfig(), queue.Queue(maxsize=1),
                         capture_demand_event=threading.Event())

    def endpoint(self, hub, *, capture_on_demand=True):
        return contract.ProducerGenerationContractTests().endpoint(
            hub, capture_on_demand=capture_on_demand)

    def request(self, *context, **kwargs):
        return contract.ProducerGenerationContractTests.request(
            (b"x-detection-engine-key", b"test-key"), *context, **kwargs)

    def test_alias_headers_rejected_before_generation_preparation_or_viewer(self):
        invalid_aliases = (
            (), ((b"x-aegis-logical-camera-id", b"CAM-01"),
                 (b"X-Aegis-Logical-Camera-Id", b"CAM-02")),
            *((((b"x-aegis-logical-camera-id", value),)) for value in (
                b"", b"CAM-", b"cam-01", b"CAM-01 ", b" CAM-01",
                b"CAM-01\n", b"CAM-01,CAM-02", b"../CAM-01",
                "CAM-١".encode(), b"CAM-" + b"1" * 61)),
        )
        for aliases in invalid_aliases:
            with self.subTest(aliases=aliases):
                hub = self.hub()
                response = asyncio.run(self.endpoint(hub)(self.request(
                    (b"x-aegis-producer-generation", b"51"), *aliases)))
                self.assertEqual(response.status_code, 400)
                self.assertEqual(response.body, b'{"error":"invalid logical camera id"}')
                self.assertIsNone(hub._current_producer_generation)
                self.assertEqual(hub.viewers, 0)
                self.assertFalse(hub._capture_demand_event.is_set())

    def test_query_or_body_cannot_supply_alias(self):
        hub = self.hub()
        response = asyncio.run(self.endpoint(hub)(self.request(
            (b"x-aegis-producer-generation", b"51"),
            query_string=b"logicalCameraId=CAM-01",
            body=b'{"logicalCameraId":"CAM-02"}')))
        self.assertEqual(response.status_code, 400)
        self.assertIsNone(hub._current_producer_generation)

    def test_engine_key_is_checked_before_alias_validation(self):
        hub = self.hub()
        request = contract.ProducerGenerationContractTests.request(
            (b"x-aegis-producer-generation", b"51"),
            (b"x-aegis-logical-camera-id", b"bad"))
        response = asyncio.run(self.endpoint(hub)(request))
        self.assertEqual(response.status_code, 401)
        self.assertIsNone(hub._current_producer_generation)

    def test_authenticated_alias_reaches_lease_and_disconnect_removes_it(self):
        async def exercise(alias):
            hub = self.hub()
            response = await self.endpoint(hub)(self.request(
                (b"x-aegis-producer-generation", b"51"),
                (b"x-aegis-logical-camera-id", alias)))
            pending = asyncio.create_task(anext(response.body_iterator))
            try:
                for _ in range(100):
                    if hub.viewers:
                        break
                    await asyncio.sleep(0.001)
                self.assertEqual(list(hub._viewer_aliases.values()), [alias.decode()])
            finally:
                pending.cancel()
                await asyncio.gather(pending, return_exceptions=True)
                await response.body_iterator.aclose()
            self.assertEqual(hub.viewers, 0)
            self.assertEqual(hub._viewer_aliases, {})
            self.assertFalse(hub._capture_demand_event.is_set())
        for alias in (b"CAM-01", b"CAM-02", b"CAM-" + b"1" * 60):
            with self.subTest(alias=alias):
                asyncio.run(exercise(alias))

    def test_different_aliases_coexist_until_final_physical_release(self):
        hub = self.hub()
        first = hub.add_viewer(producer_generation=51, logical_camera_id="CAM-01")
        second = hub.add_viewer(producer_generation=51, logical_camera_id="CAM-02")
        self.assertEqual(hub._viewer_aliases, {first[0]: "CAM-01", second[0]: "CAM-02"})
        hub.remove_viewer(*first)
        hub.remove_viewer(*first)
        self.assertEqual(hub._viewer_aliases, {second[0]: "CAM-02"})
        self.assertTrue(hub.viewer_is_active(*second))
        self.assertTrue(hub._capture_demand_event.is_set())
        hub.remove_viewer(*second)
        with self.assertRaises(StaleProducerGenerationError):
            hub.add_viewer(producer_generation=51, logical_camera_id="CAM-01")
        current = hub.add_viewer(producer_generation=52, logical_camera_id="CAM-02")
        with self.assertRaises(StaleProducerGenerationError):
            hub.add_viewer(producer_generation=50, logical_camera_id="CAM-01")
        hub.remove_viewer(*second)
        self.assertEqual(hub._viewer_aliases, {current[0]: "CAM-02"})

    def test_always_on_alias_without_generation_cannot_supply_attribution(self):
        hub = self.hub()
        response = asyncio.run(self.endpoint(hub, capture_on_demand=False)(self.request(
            (b"x-aegis-logical-camera-id", b"CAM-01"))))
        self.assertEqual(response.status_code, 400)
        self.assertEqual(hub.viewers, 0)

    def test_hub_rejects_malformed_or_unversioned_alias_without_state_change(self):
        hub = self.hub()
        for alias, generation in (("CAM-01", None), ("CAM-../1", 51),
                                  ("CAM-١", 51), ("CAM-" + "1" * 61, 51)):
            with self.subTest(alias=alias, generation=generation):
                with self.assertRaises(ValueError):
                    hub.add_viewer(producer_generation=generation, logical_camera_id=alias)
                self.assertEqual(hub.viewers, 0)
                self.assertIsNone(hub._current_producer_generation)
                self.assertFalse(hub._capture_demand_event.is_set())


if __name__ == "__main__":
    unittest.main()
