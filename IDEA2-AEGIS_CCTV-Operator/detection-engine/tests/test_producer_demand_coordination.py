"""RED design gate: Monitor demand authority must survive Engine handoff races.

These tests intentionally fail against the Task 1 checkpoint. They do not
open a camera or claim the proposed coordination protocol is implemented.
"""

import asyncio
import base64
import hashlib
import hmac
import json
import queue
import threading
import time
import unittest

from aegis_engine.config import EngineConfig
from aegis_engine.metrics import MetricsRegistry
from aegis_engine.models import Frame
from aegis_engine.recording_authority import RecordingAuthority
from aegis_engine.stream_hub import StreamHub
from aegis_engine.video_catcher import OverflowPolicy, Sink, VideoCatcher
import test_producer_generation_contract as contract


def _b64(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _grant(*, owner, generation=51, alias="CAM-02", expiry=None, trusted=True,
           boot_id="red-fixture-boot", action="attach", changes=None):
    """Test-only proposal for a canonical, bounded Monitor-signed grant."""
    demand_owner = _b64(hashlib.sha256(f"owner:{owner}".encode()).digest())
    grant_id = _b64(hashlib.sha256(f"grant:{owner}:{action}:{expiry}".encode()).digest())
    claims = {
        "v": 1,
        "action": action,
        "jti": grant_id,
        "demandOwnerId": demand_owner,
        "producerGeneration": str(generation),
        "logicalCameraId": alias,
        "nodeId": "edge-node-01",
        "physicalCameraId": 1,
        "engineBootId": boot_id,
        "userId": "2",
        "sessionBindingHash": "v1:" + "a" * 64,
        "expiresAtMs": expiry if expiry is not None else int(time.time() * 1000) + 30_000,
    }
    for name, value in (changes or {}).items():
        if value is None:
            claims.pop(name, None)
        else:
            claims[name] = value
    payload = json.dumps(claims, sort_keys=True, separators=(",", ":")).encode()
    key = hmac.new(b"test-key", b"AEGIS-demand-grant-v1-key", hashlib.sha256).digest()
    if not trusted:
        key = hmac.new(b"wrong-key", b"AEGIS-demand-grant-v1-key", hashlib.sha256).digest()
    signature = hmac.new(key, b"aegis-producer-demand-v1\n" + payload, hashlib.sha256).digest()
    return f"{_b64(payload)}.{_b64(signature)}".encode("ascii")


class ProducerDemandCoordinationRedTests(unittest.TestCase):
    def setUp(self):
        self.hub = StreamHub(
            EngineConfig(), queue.Queue(maxsize=1),
            capture_demand_event=threading.Event(),
        )
        self.endpoint = contract.ProducerGenerationContractTests().endpoint(self.hub)
        self.boot_id = getattr(self.hub, "producer_boot_id", "red-fixture-boot")

    def tearDown(self):
        self.hub.stop()

    async def control(self, action, *, owner, **kwargs):
        from aegis_engine.local_api import LocalEventAPI
        from aegis_engine.metrics import MetricsRegistry
        app = LocalEventAPI(EngineConfig(detection_engine_api_key="test-key"),
                            MetricsRegistry(), stream_hub=self.hub)._app
        route = next((r.endpoint for r in app.routes
                      if r.path == "/producer/control"), None)
        self.assertIsNotNone(route, "authenticated demand control route is missing")
        return await route(self.request(grant=self.grant(owner=owner, action=action, **kwargs)))

    def request(self, *, alias="CAM-02", generation=51, grant=None):
        headers = [
            (b"x-detection-engine-key", b"test-key"),
            (b"x-aegis-producer-generation", str(generation).encode()),
            (b"x-aegis-logical-camera-id", alias.encode()),
        ]
        if grant is not None:
            headers.append((b"x-aegis-demand-grant", grant))
        return contract.ProducerGenerationContractTests.request(*headers)

    def grant(self, **kwargs):
        return _grant(boot_id=self.boot_id, **kwargs)

    async def assert_frame_from(self, response):
        pending = asyncio.create_task(anext(response.body_iterator))
        try:
            for _ in range(100):
                if self.hub.viewers or pending.done():
                    break
                await asyncio.sleep(0.002)
            if self.hub.viewers:
                with self.hub._cond:
                    self.hub._seq += 1
                    self.hub._jpeg = b"fixture-jpeg"
                    self.hub._cond.notify_all()
            try:
                part = await asyncio.wait_for(pending, 0.5)
            except StopAsyncIteration:
                self.fail("authorized B received an empty stream after A closed")
            self.assertIn(b"fixture-jpeg", part)
        finally:
            if not pending.done():
                pending.cancel()
                await asyncio.gather(pending, return_exceptions=True)
            await response.body_iterator.aclose()

    async def attach_a(self):
        response = await self.endpoint(self.request(
            alias="CAM-01", grant=self.grant(owner="a", alias="CAM-01")))
        self.assertEqual(response.status_code, 200)
        pending = asyncio.create_task(anext(response.body_iterator))
        for _ in range(100):
            if self.hub.viewers or pending.done():
                break
            await asyncio.sleep(0.002)
        self.assertEqual(self.hub.viewers, 1)
        with self.hub._cond:
            self.hub._seq += 1
            self.hub._jpeg = b"a-frame"
            self.hub._cond.notify_all()
        self.assertIn(b"a-frame", await asyncio.wait_for(pending, 0.5))
        return response

    async def assert_denial_preserves_a(self, *, grant, alias="CAM-02"):
        a = await self.attach_a()
        try:
            response = await self.endpoint(self.request(
                generation=99, alias=alias, grant=grant))
            self.assertEqual(
                (response.status_code in (401, 403), self.hub.viewers,
                 self.hub._current_producer_generation,
                 self.hub._capture_demand_event.is_set()),
                (True, 1, 51, True),
                "unauthorized high-generation preflight must not disrupt A",
            )
        finally:
            await a.body_iterator.aclose()

    def test_race_a_demand_b_acquired_before_a_closes_b_arrives_after(self):
        async def exercise():
            a = await self.attach_a()
            b_grant = self.grant(owner="b-after-a")
            # B's grant represents a distinct demand committed before A closes.
            await a.body_iterator.aclose()
            self.assertFalse(self.hub._capture_demand_event.is_set())
            response = await self.endpoint(self.request(grant=b_grant))
            self.assertEqual(response.status_code, 200)
            await self.assert_frame_from(response)
        asyncio.run(exercise())

    def test_race_b_b_preflight_before_a_closes_deferred_attach_after(self):
        async def exercise():
            a = await self.attach_a()
            response = await self.endpoint(self.request(grant=self.grant(owner="b-preflight")))
            self.assertEqual(response.status_code, 200)
            await a.body_iterator.aclose()
            await self.assert_frame_from(response)
        asyncio.run(exercise())

    def test_bare_generation_without_monitor_grant_is_not_authority(self):
        asyncio.run(self.assert_denial_preserves_a(grant=None))

    def test_forged_grant_is_rejected_before_viewer_side_effect(self):
        asyncio.run(self.assert_denial_preserves_a(
            grant=self.grant(owner="forged", generation=99, trusted=False)))

    def test_expired_demand_grant_is_rejected_before_viewer_side_effect(self):
        asyncio.run(self.assert_denial_preserves_a(grant=self.grant(
            owner="expired", generation=99, expiry=int(time.time() * 1000) - 1000)))

    def test_signed_grant_cannot_authorize_a_different_alias(self):
        asyncio.run(self.assert_denial_preserves_a(grant=self.grant(
            owner="wrong-alias", generation=99, alias="CAM-01")))

    def test_same_one_use_grant_cannot_be_reserved_twice(self):
        async def exercise():
            grant = self.grant(owner="replay")
            first = await self.endpoint(self.request(grant=grant))
            self.assertEqual(first.status_code, 200)
            second = await self.endpoint(self.request(grant=grant))
            self.assertIn(second.status_code, (401, 403))
            self.assertEqual(self.hub.viewers, 0)
            await first.body_iterator.aclose()
        asyncio.run(exercise())

    def test_lower_generation_stays_stale_after_higher_observed(self):
        async def exercise():
            higher = await self.endpoint(self.request(
                generation=52, grant=self.grant(owner="higher", generation=52)))
            self.assertEqual(higher.status_code, 200)
            lower = await self.endpoint(self.request(
                generation=51, grant=self.grant(owner="lower", generation=51)))
            self.assertEqual(lower.status_code, 409)
            self.assertEqual(self.hub.viewers, 0)
            await higher.body_iterator.aclose()
        asyncio.run(exercise())

    def test_pre_restart_grant_cannot_replay_into_new_engine_boot(self):
        old_grant = self.grant(owner="pre-restart")
        replacement = StreamHub(EngineConfig(), queue.Queue(maxsize=1),
                                capture_demand_event=threading.Event())
        endpoint = contract.ProducerGenerationContractTests().endpoint(replacement)
        response = asyncio.run(endpoint(self.request(grant=old_grant)))
        self.assertIn(response.status_code, (401, 403))
        self.assertEqual(replacement.viewers, 0)
        replacement.stop()

    def test_missing_identity_fields_and_wrong_node_fail_before_mutation(self):
        for changes in ({"userId": None}, {"sessionBindingHash": None},
                        {"nodeId": "wrong-node"}, {"physicalCameraId": None},
                        {"physicalCameraId": 0}, {"userId": "01"},
                        {"sessionBindingHash": "raw-session"}):
            with self.subTest(changes=changes):
                response = asyncio.run(self.endpoint(self.request(
                    generation=99, grant=self.grant(owner="missing", generation=99, changes=changes))))
                self.assertIn(response.status_code, (401, 403))
                self.assertIsNone(self.hub._current_producer_generation)
                self.assertFalse(self.hub._capture_demand_event.is_set())

    def test_duplicate_grant_header_fails_before_mutation(self):
        request = self.request(grant=self.grant(owner="duplicate"))
        request.scope["headers"].append((b"x-aegis-demand-grant", self.grant(owner="other")))
        response = asyncio.run(self.endpoint(request))
        self.assertIn(response.status_code, (401, 403))
        self.assertIsNone(self.hub._current_producer_generation)

    def test_revoke_between_preflight_and_attach_blocks_b_not_a_or_late_refresh(self):
        async def exercise():
            a = await self.attach_a()
            b = await self.endpoint(self.request(grant=self.grant(owner="b")))
            self.assertEqual(b.status_code, 200)
            revoked = await self.control("revoke", owner="b")
            self.assertEqual(revoked.status_code, 204)
            self.assertEqual([part async for part in b.body_iterator], [])
            late = await self.control("refresh", owner="b")
            self.assertIn(late.status_code, (401, 403))
            self.assertEqual(self.hub.viewers, 1)
            self.assertTrue(self.hub._capture_demand_event.is_set())
            await a.body_iterator.aclose()
        asyncio.run(exercise())

    def test_explicit_retirement_rejects_equal_generation_but_delayed_retire_not_higher(self):
        async def exercise():
            a = await self.attach_a()
            retired = await self.control("retire", owner="a", alias="CAM-01")
            self.assertEqual(retired.status_code, 204)
            self.assertEqual(self.hub.viewers, 0)
            denied = await self.endpoint(self.request(grant=self.grant(owner="late")))
            self.assertEqual(denied.status_code, 409)
            higher = await self.endpoint(self.request(generation=52,
                grant=self.grant(owner="higher", generation=52)))
            self.assertEqual(higher.status_code, 200)
            await self.control("retire", owner="old-again", generation=51)
            await self.assert_frame_from(higher)
            await a.body_iterator.aclose()
        asyncio.run(exercise())

    def test_autonomous_expiry_stops_stalled_viewer_and_pending_reservation(self):
        async def exercise():
            expiry = int(time.time() * 1000) + 200
            a = await self.endpoint(self.request(grant=self.grant(owner="short", expiry=expiry)))
            pending = asyncio.create_task(anext(a.body_iterator))
            for _ in range(100):
                if self.hub.viewers: break
                await asyncio.sleep(.002)
            self.assertEqual(self.hub.viewers, 1)
            with self.hub._cond:
                self.hub._seq += 1
                self.hub._jpeg = b"one-frame"
                self.hub._cond.notify_all()
            await pending
            b = await self.endpoint(self.request(grant=self.grant(owner="pending", expiry=expiry)))
            await asyncio.sleep(.6)
            self.assertEqual(self.hub.viewers, 0, "expiry must not depend on iterator resumption")
            self.assertFalse(self.hub._capture_demand_event.is_set())
            self.assertIsNone(self.hub.latest())
            self.assertEqual([part async for part in b.body_iterator], [])
            await a.body_iterator.aclose()
        asyncio.run(exercise())

    def test_wall_clock_rollback_cannot_extend_attached_monotonic_lease(self):
        async def exercise():
            expiry = int(time.time() * 1000) + 200
            response = await self.endpoint(self.request(grant=self.grant(owner="rollback", expiry=expiry)))
            pending = asyncio.create_task(anext(response.body_iterator))
            for _ in range(100):
                if self.hub.viewers: break
                await asyncio.sleep(.002)
            self.assertEqual(self.hub.viewers, 1)
            self.hub._wall_clock = lambda: time.time() - 3600
            await asyncio.sleep(.6)
            self.assertEqual(self.hub.viewers, 0)
            self.assertFalse(self.hub._capture_demand_event.is_set())
            with self.assertRaises(StopAsyncIteration):
                await pending
        asyncio.run(exercise())

    def test_alias_b_lease_refresh_survives_a_revoke_and_expires_independently(self):
        async def exercise():
            a = await self.attach_a()
            expiry = int(time.time() * 1000) + 200
            b = await self.endpoint(self.request(grant=self.grant(owner="b-live", expiry=expiry)))
            pending = asyncio.create_task(anext(b.body_iterator))
            await asyncio.wait_for(pending, .5)  # shares A's current frame
            self.assertEqual(self.hub.viewers, 2)
            refresh = await self.control("refresh", owner="b-live", expiry=expiry + 600)
            self.assertEqual(refresh.status_code, 204)
            revoked = await self.control("revoke", owner="a", alias="CAM-01")
            self.assertEqual(revoked.status_code, 204)
            await asyncio.sleep(.4)
            self.assertEqual(list(self.hub._viewer_aliases.values()), ["CAM-02"])
            self.assertTrue(self.hub._capture_demand_event.is_set())
            late_a = await self.control("refresh", owner="a", alias="CAM-01")
            self.assertEqual(late_a.status_code, 403)
            await asyncio.sleep(.7)
            self.assertEqual(self.hub.viewers, 0)
            self.assertFalse(self.hub._capture_demand_event.is_set())
            await b.body_iterator.aclose()
            await a.body_iterator.aclose()
        asyncio.run(exercise())

    def test_capacity_is_fail_closed_without_generation_mutation(self):
        async def exercise():
            for index in range(2048):
                response = await self.endpoint(self.request(grant=self.grant(owner=f"capacity-{index}")))
                self.assertEqual(response.status_code, 200)
            full = await self.endpoint(self.request(generation=99,
                grant=self.grant(owner="over-cap", generation=99)))
            self.assertEqual(full.status_code, 403)
            self.assertEqual(self.hub._current_producer_generation, 51)
            self.assertFalse(self.hub._capture_demand_event.is_set())
        asyncio.run(exercise())

    def test_clock_rollback_after_replay_cache_expiry_cannot_reauthorize_old_grant(self):
        async def exercise():
            wall = time.time()
            mono = time.monotonic()
            self.hub._wall_clock = lambda: wall
            self.hub._monotonic_clock = lambda: mono
            token = self.grant(owner="rollback-replay", expiry=int(wall * 1000) + 200)
            first = await self.endpoint(self.request(grant=token))
            self.assertEqual(first.status_code, 200)
            wall -= .1
            mono += .3
            with self.hub._cond:
                self.hub._sweep_locked()
            replay = await self.endpoint(self.request(grant=token))
            self.assertEqual(replay.status_code, 403)
        asyncio.run(exercise())

    def test_higher_revoke_supersedes_old_viewer_and_reservation_without_retire_delivery(self):
        async def exercise():
            a = await self.attach_a()
            b = await self.endpoint(self.request(grant=self.grant(owner="pending-old")))
            revoked = await self.control("revoke", owner="higher-released", generation=52)
            self.assertEqual(revoked.status_code, 204)
            self.assertEqual(self.hub.viewers, 0)
            self.assertFalse(self.hub._capture_demand_event.is_set())
            self.assertEqual([part async for part in b.body_iterator], [])
            stale = await self.endpoint(self.request(grant=self.grant(owner="other-old")))
            self.assertEqual(stale.status_code, 409)
            current = await self.endpoint(self.request(generation=52,
                grant=self.grant(owner="current", generation=52)))
            self.assertEqual(current.status_code, 200)
            delayed = await self.control("revoke", owner="a", generation=51, alias="CAM-01")
            self.assertEqual(delayed.status_code, 204)
            await self.assert_frame_from(current)
            await a.body_iterator.aclose()
        asyncio.run(exercise())


class _MutableClock:
    def __init__(self):
        self.wall = 1_800_000_000.0
        self.monotonic = 10_000.0

    def advance(self, seconds):
        self.wall += seconds
        self.monotonic += seconds


class ProducerDemandSynchronousExpiryTests(unittest.TestCase):
    """Expiry must be enforced at operation boundaries, not by scheduler luck."""

    def setUp(self):
        self.clock = _MutableClock()
        self.capture_demand = threading.Event()
        self.recording_authority = RecordingAuthority(
            monotonic_clock=lambda: self.clock.monotonic,
        )
        self.hub = StreamHub(
            EngineConfig(),
            queue.Queue(maxsize=1),
            capture_demand_event=self.capture_demand,
            wall_clock=lambda: self.clock.wall,
            monotonic_clock=lambda: self.clock.monotonic,
            recording_authority=self.recording_authority,
        )
        # Prove correctness independently of the 250 ms defense-in-depth sweep.
        self.hub._ensure_sweeper_locked = lambda: None
        expiry = int((self.clock.wall + 1.0) * 1000)
        self.claims = {
            "v": 1,
            "action": "attach",
            "jti": "expiry-fixture-jti",
            "demandOwnerId": "expiry-fixture-owner",
            "producerGeneration": "51",
            "logicalCameraId": "CAM-02",
            "nodeId": "edge-node-01",
            "physicalCameraId": 1,
            "engineBootId": self.hub.producer_boot_id,
            "userId": "2",
            "sessionBindingHash": "v1:" + "a" * 64,
            "expiresAtMs": expiry,
        }
        reservation = self.hub.reserve_demand(self.claims)
        self.lease = self.hub.attach_demand(reservation)

    def tearDown(self):
        self.hub.stop()

    def expire(self):
        self.clock.advance(1.001)

    def test_viewer_and_capture_demand_release_synchronously_without_sweeper(self):
        self.assertTrue(self.capture_demand.is_set())
        self.assertIn((51, "CAM-02"), self.recording_authority.snapshot())

        self.expire()

        self.assertFalse(self.hub.viewer_is_active(*self.lease))
        self.assertEqual(self.hub.viewers, 0)
        self.assertFalse(self.capture_demand.is_set())
        self.assertNotIn((51, "CAM-02"), self.recording_authority.snapshot())

    def test_expired_authority_cannot_publish_or_deliver_frames(self):
        with self.hub._cond:
            self.hub._seq = 1
            self.hub._jpeg = b"pre-expiry-frame"
        self.expire()
        frame = Frame(seq=2, image=object(), captured_at=self.clock.monotonic)

        self.assertIsNone(self.hub.latest())
        self.assertIsNone(self.hub.wait_for(0, 0))
        self.assertFalse(self.hub.submit_annotated(frame))
        self.assertTrue(self.hub._queue.empty())

    def test_frame_wait_is_capped_at_demand_deadline_without_sweeper(self):
        waits = []
        original_wait = self.hub._cond.wait

        def advance_at_wait(timeout):
            waits.append(timeout)
            self.clock.advance(timeout)

        self.hub._cond.wait = advance_at_wait
        try:
            self.assertIsNone(self.hub.wait_for(-1, 5.0))
        finally:
            self.hub._cond.wait = original_wait

        self.assertEqual(len(waits), 1)
        self.assertAlmostEqual(waits[0], 1.0, places=6)
        self.assertFalse(self.capture_demand.is_set())

    def test_camera_read_result_is_discarded_when_authority_expires_in_flight(self):
        class _Capture:
            def read(inner_self):
                self.clock.advance(1.001)
                return True, object()

            def release(inner_self):
                return None

        stop = threading.Event()
        sink_queue = queue.Queue(maxsize=1)
        catcher = VideoCatcher(
            EngineConfig(),
            MetricsRegistry(),
            sinks=[Sink("detect", sink_queue, OverflowPolicy.LATEST_ONLY)],
            stop_event=stop,
            capture_demand_event=self.capture_demand,
            capture_authority_check=self.hub.capture_is_authorized,
        )
        catcher._cap = _Capture()
        catcher._connect_with_backoff = lambda: True
        catcher._start_read_watchdog = lambda: threading.current_thread()

        original_check = catcher._capture_authority_check

        def checked_authority():
            active = original_check()
            if not active:
                stop.set()
            return active

        catcher._capture_authority_check = checked_authority
        catcher.run()

        self.assertTrue(sink_queue.empty())
        self.assertEqual(catcher._seq, 0)
        self.assertFalse(self.capture_demand.is_set())

    def test_camera_guard_rejects_a_new_read_after_authority_expiry(self):
        self.expire()
        catcher = VideoCatcher(
            EngineConfig(),
            MetricsRegistry(),
            sinks=[],
            capture_demand_event=self.capture_demand,
            capture_authority_check=self.hub.capture_is_authorized,
        )

        self.assertFalse(catcher._capture_is_demanded())
        self.assertFalse(self.capture_demand.is_set())


if __name__ == "__main__":
    unittest.main()
