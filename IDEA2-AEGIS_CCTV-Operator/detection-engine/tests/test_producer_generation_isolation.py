import queue
import threading
import unittest

from aegis_engine.config import EngineConfig
from aegis_engine.stream_hub import StaleProducerGenerationError, StreamHub


class ProducerGenerationIsolationTests(unittest.TestCase):
    def hub(self):
        demand = threading.Event()
        return StreamHub(
            EngineConfig(),
            queue.Queue(maxsize=1),
            capture_demand_event=demand,
        )

    def test_same_generation_viewers_share_physical_capture_demand(self):
        hub = self.hub()

        first = hub.add_viewer(producer_generation=21)
        second = hub.add_viewer(producer_generation=21)

        self.assertEqual(hub.viewers, 2)
        self.assertTrue(hub._capture_demand_event.is_set())
        hub.remove_viewer(*first)
        self.assertEqual(hub.viewers, 1)
        self.assertTrue(hub._capture_demand_event.is_set())
        hub.remove_viewer(*second)
        self.assertEqual(hub.viewers, 0)
        self.assertFalse(hub._capture_demand_event.is_set())

    def test_newer_generation_invalidates_old_viewers_without_stale_cleanup_damage(self):
        hub = self.hub()
        old = hub.add_viewer(producer_generation=21)

        current = hub.add_viewer(producer_generation=22)

        self.assertFalse(hub.viewer_is_active(*old))
        self.assertTrue(hub.viewer_is_active(*current))
        self.assertEqual(hub.viewers, 1)
        hub.remove_viewer(*old)
        self.assertEqual(hub.viewers, 1)
        self.assertTrue(hub._capture_demand_event.is_set())
        hub.remove_viewer(*current)
        self.assertEqual(hub.viewers, 0)
        self.assertFalse(hub._capture_demand_event.is_set())

    def test_stale_generation_cannot_change_current_viewer_or_demand_state(self):
        hub = self.hub()
        current = hub.add_viewer(producer_generation=22)

        with self.assertRaises(StaleProducerGenerationError):
            hub.add_viewer(producer_generation=21)

        self.assertTrue(hub.viewer_is_active(*current))
        self.assertEqual(hub.viewers, 1)
        self.assertTrue(hub._capture_demand_event.is_set())

    def test_invalid_generation_cannot_wake_capture(self):
        hub = self.hub()

        for invalid in (True, 0, -1, 9223372036854775808):
            with self.subTest(invalid=invalid):
                with self.assertRaises(ValueError):
                    hub.add_viewer(producer_generation=invalid)
                self.assertEqual(hub.viewers, 0)
                self.assertFalse(hub._capture_demand_event.is_set())

    def test_unversioned_compatibility_viewer_cannot_join_versioned_producer(self):
        hub = self.hub()
        current = hub.add_viewer(producer_generation=22)

        with self.assertRaises(StaleProducerGenerationError):
            hub.add_viewer(producer_generation=None)

        self.assertTrue(hub.viewer_is_active(*current))
        self.assertEqual(hub.viewers, 1)
        self.assertTrue(hub._capture_demand_event.is_set())

    def test_only_explicit_monitor_retirement_retires_idle_generation(self):
        hub = self.hub()
        first = hub.add_viewer(producer_generation=51)
        second = hub.add_viewer(producer_generation=51)
        hub.remove_viewer(*first)
        third = hub.add_viewer(producer_generation=51)
        hub.remove_viewer(*second)
        hub.remove_viewer(*third)
        hub.remove_viewer(*third)  # cleanup remains idempotent
        self.assertFalse(hub._producer_generation_retired)
        from test_producer_demand_coordination import _grant
        from aegis_engine.demand_grant import verify_grant
        import time
        claims = verify_grant(_grant(owner="final", action="retire", boot_id=hub.producer_boot_id),
            secret="test-key", boot_id=hub.producer_boot_id, node_id="edge-node-01", now_ms=int(time.time() * 1000))
        hub.control_demand(claims)
        with self.assertRaises(StaleProducerGenerationError):
            hub.add_viewer(producer_generation=51)
        with self.assertRaises(StaleProducerGenerationError):
            hub.prepare_producer_generation(51)
        self.assertEqual(hub.viewers, 0)
        self.assertFalse(hub._capture_demand_event.is_set())
        current = hub.add_viewer(producer_generation=52)
        hub.remove_viewer(*first)  # old cleanup cannot retire the new producer
        self.assertTrue(hub.viewer_is_active(*current))


if __name__ == "__main__":
    unittest.main()
