"""Alias recording contracts exercised without a camera or disk codec."""

import queue
import threading
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

import numpy as np

from aegis_engine.config import EngineConfig
from aegis_engine.engine import DetectionEngine
from aegis_engine.metrics import MetricsRegistry
from aegis_engine.models import Frame
from aegis_engine.recording_authority import RecordingAuthority
from aegis_engine.segment_recorder import SegmentRecorder
from aegis_engine.stream_hub import StreamHub
from aegis_engine.video_catcher import VideoCatcher
import aegis_engine.segment_recorder as recorder_module


class AuthorityProbe:
    def __init__(self):
        self.active = {}
        self.transitions = []

    def activate(self, generation, alias, started_monotonic):
        self.active[(generation, alias)] = started_monotonic
        self.transitions.append(("activate", generation, alias))

    def deactivate(self, generation, alias):
        self.active.pop((generation, alias), None)
        self.transitions.append(("deactivate", generation, alias))

    def retire(self, generation):
        self.active = {key: value for key, value in self.active.items() if key[0] != generation}
        self.transitions.append(("retire", generation))

    def snapshot(self):
        return dict(self.active)

    def observe(self, generation, alias, started_monotonic):
        return self.active.get((generation, alias)) == started_monotonic

    def closed_boundary(self, generation, alias, started_monotonic):
        return None

    def unobserve(self, generation, alias, started_monotonic):
        pass


class AliasSegmentRecorderTests(unittest.TestCase):
    def test_authorized_queued_tail_survives_rotation_after_release(self):
        clock = [10.0]
        def wall_time():
            return datetime.fromtimestamp(clock[0], timezone.utc).isoformat()
        authority = RecordingAuthority(monotonic_clock=lambda: clock[0], wall_clock=wall_time)
        with tempfile.TemporaryDirectory() as tmp:
            finalized, writers = [], []
            recorder = SegmentRecorder(EngineConfig(segment_dir=tmp, capture_on_demand=True,
                                                    segment_seconds=300), MetricsRegistry(),
                                       queue.Queue(), finalized.append,
                                       recording_authority=authority,
                                       monotonic_clock=lambda: clock[0])
            class Writer:
                def __init__(self, path, *_args):
                    self.path, self.frames = path, 0
                    writers.append(self)
                def isOpened(self): return True
                def write(self, _image): self.frames += 1
                def release(self): Path(self.path).write_bytes(b"video")
            image = np.zeros((16, 16, 3), dtype=np.uint8)
            with patch.object(recorder_module.cv2, "VideoWriter", Writer):
                authority.activate(51, "CAM-01", 9.0)
                recorder._process_frame(Frame(1, image, captured_at=10.0))
                clock[0] = 320.0
                authority.deactivate(51, "CAM-01")
                recorder._process_frame(Frame(2, image, captured_at=311.0))
                recorder._process_frame(Frame(3, image, captured_at=312.0))
                recorder._reconcile_strict_contexts()
            self.assertEqual(len(writers), 2)
            self.assertGreater(writers[1].frames, 1)
            self.assertEqual(len(finalized), 2)
            self.assertEqual(finalized[1].ended_wall, wall_time())

    def test_authorized_queued_tail_drains_after_final_viewer_release(self):
        clock = [9.0]
        def wall_time():
            return datetime.fromtimestamp(clock[0], timezone.utc).isoformat()
        authority = RecordingAuthority(monotonic_clock=lambda: clock[0], wall_clock=wall_time)
        with tempfile.TemporaryDirectory() as tmp:
            finalized, writers = [], []
            recorder = SegmentRecorder(EngineConfig(segment_dir=tmp, capture_on_demand=True),
                                       MetricsRegistry(), queue.Queue(), finalized.append,
                                       recording_authority=authority,
                                       monotonic_clock=lambda: clock[0])
            class Writer:
                def __init__(self, path, *_args):
                    self.path, self.frames = path, 0
                    writers.append(self)
                def isOpened(self): return True
                def write(self, _image): self.frames += 1
                def release(self): Path(self.path).write_bytes(b"video")
            image = np.zeros((16, 16, 3), dtype=np.uint8)
            with patch.object(recorder_module.cv2, "VideoWriter", Writer):
                authority.activate(51, "CAM-01", 9.0)
                recorder._process_frame(Frame(1, image, captured_at=10.0))
                clock[0] = 12.0
                authority.deactivate(51, "CAM-01")
                recorder._process_frame(Frame(2, image, captured_at=11.0))
                recorder._reconcile_strict_contexts()  # queue-empty finalization
            self.assertEqual(len(writers), 1)
            self.assertGreater(writers[0].frames, 1)
            self.assertEqual(len(finalized), 1)
            self.assertEqual(finalized[0].ended_wall, wall_time())

    def test_short_authorized_session_queued_entirely_before_release_still_records(self):
        clock = [9.0]
        def wall_time():
            return datetime.fromtimestamp(clock[0], timezone.utc).isoformat()
        authority = RecordingAuthority(monotonic_clock=lambda: clock[0], wall_clock=wall_time)
        with tempfile.TemporaryDirectory() as tmp:
            finalized, writers = [], []
            recorder = SegmentRecorder(EngineConfig(segment_dir=tmp, capture_on_demand=True),
                                       MetricsRegistry(), queue.Queue(), finalized.append,
                                       recording_authority=authority,
                                       monotonic_clock=lambda: clock[0])
            class Writer:
                def __init__(self, path, *_args):
                    self.path, self.frames = path, 0
                    writers.append(self)
                def isOpened(self): return True
                def write(self, _image): self.frames += 1
                def release(self): Path(self.path).write_bytes(b"video")
            image = np.zeros((16, 16, 3), dtype=np.uint8)
            with patch.object(recorder_module.cv2, "VideoWriter", Writer):
                authority.activate(51, "CAM-01", 9.0)
                clock[0] = 12.0
                authority.deactivate(51, "CAM-01")
                recorder._process_frame(Frame(1, image, captured_at=10.0))
                recorder._process_frame(Frame(2, image, captured_at=11.0))
                recorder._reconcile_strict_contexts()
            self.assertEqual(len(writers), 1)
            self.assertGreater(writers[0].frames, 1)
            self.assertEqual(len(finalized), 1)
            self.assertEqual(finalized[0].ended_wall, wall_time())

    def test_failed_writer_open_does_not_strand_observed_authority(self):
        authority = RecordingAuthority()
        recorder = SegmentRecorder(EngineConfig(capture_on_demand=True), MetricsRegistry(),
                                   queue.Queue(), lambda _: None,
                                   recording_authority=authority)
        authority.activate(51, "CAM-01", 9.0)
        frame = Frame(1, np.zeros((16, 16, 3), dtype=np.uint8), captured_at=10.0)
        with patch.object(recorder_module.cv2, "VideoWriter", side_effect=RuntimeError("codec unavailable")):
            with self.assertRaisesRegex(RuntimeError, "codec unavailable"):
                recorder._open_strict_writer((51, "CAM-01"), frame)
        self.assertEqual(authority._observed, set())

    def test_sibling_deactivation_during_slow_release_uses_its_actual_stop_boundary(self):
        clock = [10.0]
        def wall_time():
            return datetime.fromtimestamp(clock[0], timezone.utc).isoformat()
        authority = RecordingAuthority(monotonic_clock=lambda: clock[0], wall_clock=wall_time)
        with tempfile.TemporaryDirectory() as tmp:
            finalized = []
            recorder = SegmentRecorder(EngineConfig(segment_dir=tmp, capture_on_demand=True),
                                       MetricsRegistry(), queue.Queue(), finalized.append,
                                       recording_authority=authority,
                                       monotonic_clock=lambda: clock[0])
            class SlowWriter:
                def __init__(self, path, *_args):
                    self.path = path
                def isOpened(self):
                    return True
                def write(self, _image):
                    pass
                def release(self):
                    if "CAM-01" in self.path:
                        clock[0] = 12.0
                        authority.deactivate(51, "CAM-02")
                        clock[0] = 72.0
                    Path(self.path).write_bytes(b"video")
            with (patch.object(recorder_module.cv2, "VideoWriter", SlowWriter),
                  patch.object(recorder_module, "utc_now_iso", side_effect=wall_time)):
                authority.activate(51, "CAM-01", 9.0)
                authority.activate(51, "CAM-02", 9.0)
                recorder._process_frame(Frame(1, np.zeros((16, 16, 3), dtype=np.uint8),
                                              captured_at=10.0, captured_wall=wall_time()))
                clock[0] = 11.0
                authority.deactivate(51, "CAM-01")
                recorder._reconcile_strict_contexts()
                recorder._reconcile_strict_contexts()
        self.assertEqual({clip.camera_id: clip.duration_s for clip in finalized},
                         {"CAM-01": 1.0, "CAM-02": 2.0})
        self.assertEqual({clip.camera_id: clip.ended_wall for clip in finalized},
                         {"CAM-01": "1970-01-01T00:00:11+00:00",
                          "CAM-02": "1970-01-01T00:00:12+00:00"})

    def test_slow_writer_release_does_not_extend_either_alias_capture_interval(self):
        authority = AuthorityProbe()
        clock = [10.0]
        with tempfile.TemporaryDirectory() as tmp:
            finalized = []
            recorder = SegmentRecorder(EngineConfig(segment_dir=tmp, capture_on_demand=True),
                                       MetricsRegistry(), queue.Queue(), finalized.append,
                                       recording_authority=authority,
                                       monotonic_clock=lambda: clock[0])

            class SlowWriter:
                def __init__(self, path, *_args):
                    self.path = path

                def isOpened(self):
                    return True

                def write(self, _image):
                    pass

                def release(self):
                    clock[0] += 60.0
                    Path(self.path).write_bytes(b"video")

            def wall_time():
                return datetime.fromtimestamp(clock[0], timezone.utc).isoformat()

            with (patch.object(recorder_module.cv2, "VideoWriter", SlowWriter),
                  patch.object(recorder_module, "utc_now_iso", side_effect=wall_time)):
                authority.activate(51, "CAM-01", 9.0)
                authority.activate(51, "CAM-02", 9.0)
                recorder._process_frame(Frame(1, np.zeros((16, 16, 3), dtype=np.uint8),
                                              captured_at=10.0, captured_wall=wall_time()))
                clock[0] = 11.0
                authority.deactivate(51, "CAM-01")
                authority.deactivate(51, "CAM-02")
                recorder._reconcile_strict_contexts()

        self.assertEqual(len(finalized), 2)
        self.assertEqual({info.camera_id for info in finalized}, {"CAM-01", "CAM-02"})
        self.assertEqual([info.duration_s for info in finalized], [1.0, 1.0])
        self.assertEqual([info.ended_wall for info in finalized],
                         ["1970-01-01T00:00:11+00:00"] * 2)

    def test_finalizing_one_alias_keeps_other_active_segment_metric(self):
        metrics = MetricsRegistry()
        metrics.on_segment_started("CAM-01-clip.mp4")
        metrics.on_segment_started("CAM-02-clip.mp4")
        metrics.on_segment_finalized("CAM-01-clip.mp4")
        self.assertEqual(metrics.snapshot()["recorder"], {
            "active_segment": "CAM-02-clip.mp4", "segments_written": 1,
        })
        metrics.on_segment_finalized("CAM-02-clip.mp4")
        self.assertEqual(metrics.snapshot()["recorder"], {
            "active_segment": None, "segments_written": 2,
        })
        # Preserve the legacy single-writer no-argument call shape.
        metrics.on_segment_started("legacy.mp4")
        metrics.on_segment_finalized()
        self.assertIsNone(metrics.snapshot()["recorder"]["active_segment"])

    def test_engine_wires_one_recording_authority_to_hub_and_recorder(self):
        engine = DetectionEngine(config=EngineConfig(capture_on_demand=True,
                                                     detection_engine_api_key="test-key"))
        recorder = next(worker for worker in engine._threads if isinstance(worker, SegmentRecorder))
        hub = engine._api._stream
        self.assertIsNotNone(recorder._recording_authority)
        self.assertIs(recorder._recording_authority, hub._recording_authority)
        self.assertEqual(sum(isinstance(worker, VideoCatcher) for worker in engine._threads), 1)

    def test_authority_snapshot_is_immutable_and_copied(self):
        from aegis_engine.recording_authority import RecordingAuthority
        authority = RecordingAuthority()
        authority.activate(51, "CAM-01", 10.0)
        old = authority.snapshot()
        authority.deactivate(51, "CAM-01")
        self.assertEqual(old[(51, "CAM-01")], 10.0)
        self.assertEqual(dict(authority.snapshot()), {})
        with self.assertRaises(TypeError):
            old[(51, "CAM-02")] = 11.0

    def test_same_alias_reference_count_and_other_alias_survives_release(self):
        authority = AuthorityProbe()
        demand = threading.Event()
        hub = StreamHub(EngineConfig(), queue.Queue(maxsize=1),
                        capture_demand_event=demand, recording_authority=authority,
                        monotonic_clock=lambda: 100.0)
        one = hub.add_viewer(producer_generation=51, logical_camera_id="CAM-01")
        two = hub.add_viewer(producer_generation=51, logical_camera_id="CAM-01")
        other = hub.add_viewer(producer_generation=51, logical_camera_id="CAM-02")
        self.assertEqual(authority.transitions.count(("activate", 51, "CAM-01")), 1)
        self.assertEqual(set(authority.snapshot()), {(51, "CAM-01"), (51, "CAM-02")})
        hub.remove_viewer(*one)
        self.assertIn((51, "CAM-01"), authority.snapshot())
        hub.remove_viewer(*two)
        self.assertEqual(set(authority.snapshot()), {(51, "CAM-02")})
        self.assertTrue(demand.is_set())
        hub.remove_viewer(*other)
        self.assertEqual(authority.snapshot(), {})
        self.assertFalse(demand.is_set())

    def test_late_join_excludes_queued_pre_authorization_frame(self):
        authority = AuthorityProbe()
        recorder = SegmentRecorder(EngineConfig(capture_on_demand=True), MetricsRegistry(),
                                   queue.Queue(), on_segment=lambda _: None,
                                   recording_authority=authority)
        image = np.zeros((16, 16, 3), dtype=np.uint8)
        old_frame = Frame(1, image, captured_at=10.0)
        authority.activate(51, "CAM-02", 11.0)
        recorder._process_frame(old_frame)
        self.assertEqual(recorder._strict_contexts, {})

    def test_strict_contexts_fan_out_and_static_camera_id_cannot_override(self):
        authority = AuthorityProbe()
        recorder = SegmentRecorder(EngineConfig(camera_id="CAM-05", capture_on_demand=True),
                                   MetricsRegistry(), queue.Queue(), on_segment=lambda _: None,
                                   recording_authority=authority)
        authority.activate(51, "CAM-01", 10.0)
        authority.activate(51, "CAM-02", 10.0)
        opened = []
        recorder._open_strict_writer = lambda key, frame: opened.append(key)
        recorder._process_frame(Frame(1, np.zeros((16, 16, 3), dtype=np.uint8), captured_at=11.0))
        self.assertEqual(opened, [(51, "CAM-01"), (51, "CAM-02")])
        self.assertNotIn((51, "CAM-05"), opened)

    def test_generation_replacement_removes_old_alias_authority(self):
        authority = AuthorityProbe()
        hub = StreamHub(EngineConfig(), queue.Queue(maxsize=1),
                        recording_authority=authority)
        hub.add_viewer(producer_generation=51, logical_camera_id="CAM-01")
        hub.add_viewer(producer_generation=52, logical_camera_id="CAM-02")
        self.assertEqual(set(authority.snapshot()), {(52, "CAM-02")})

    def test_alias_rejoin_before_queue_reconcile_cannot_append_to_old_segment(self):
        clock = [10.0]
        def wall_time():
            return datetime.fromtimestamp(clock[0], timezone.utc).isoformat()
        authority = RecordingAuthority(monotonic_clock=lambda: clock[0], wall_clock=wall_time)
        with tempfile.TemporaryDirectory() as tmp:
            finalized = []
            recorder = SegmentRecorder(EngineConfig(segment_dir=tmp, capture_on_demand=True),
                                       MetricsRegistry(), queue.Queue(), finalized.append,
                                       recording_authority=authority,
                                       monotonic_clock=lambda: clock[0])
            writers = []

            class FakeWriter:
                def __init__(self, path, *_args):
                    self.path = path
                    self.frames = 0
                    writers.append(self)

                def isOpened(self):
                    return True

                def write(self, _image):
                    self.frames += 1

                def release(self):
                    Path(self.path).write_bytes(b"video")

            image = np.zeros((16, 16, 3), dtype=np.uint8)
            with (patch.object(recorder_module.cv2, "VideoWriter", FakeWriter),
                  patch.object(recorder_module, "utc_now_iso", side_effect=wall_time)):
                authority.activate(51, "CAM-01", 10.0)
                clock[0] = 11.0
                recorder._process_frame(Frame(1, image, captured_at=11.0, captured_wall=wall_time()))
                clock[0] = 12.0
                authority.deactivate(51, "CAM-01")
                authority.activate(51, "CAM-01", 20.0)
                # An old queued frame still belongs to the first interval,
                # even though the same alias has already re-entered.
                recorder._process_frame(Frame(2, image, captured_at=11.5, captured_wall=wall_time()))
                self.assertEqual(len(writers), 1)
                self.assertGreater(writers[0].frames, 1)
                clock[0] = 21.0
                recorder._process_frame(Frame(3, image, captured_at=21.0, captured_wall=wall_time()))
                self.assertEqual(len(writers), 2)
                self.assertEqual(len(finalized), 1)
                self.assertEqual(finalized[0].duration_s, 1.0)
                self.assertEqual(finalized[0].ended_wall, "1970-01-01T00:00:12+00:00")
                authority.deactivate(51, "CAM-01")
                recorder._reconcile_strict_contexts()
            self.assertEqual(len(finalized), 2)
            self.assertTrue(all(info.camera_id == "CAM-01" for info in finalized))

    def test_aliases_rotate_on_independent_clocks_and_leave_with_measured_partials(self):
        authority = AuthorityProbe()
        clock = [10.0]
        with tempfile.TemporaryDirectory() as tmp:
            finalized = []
            metrics = MetricsRegistry()
            recorder = SegmentRecorder(EngineConfig(segment_dir=tmp, capture_on_demand=True,
                                                    camera_id="CAM-05"),
                                       metrics, queue.Queue(), finalized.append,
                                       recording_authority=authority,
                                       monotonic_clock=lambda: clock[0])
            writers = []

            class FakeWriter:
                def __init__(self, path, *_args):
                    self.path = path
                    self.frames = 0
                    writers.append(self)

                def isOpened(self):
                    return True

                def write(self, _image):
                    self.frames += 1

                def release(self):
                    Path(self.path).write_bytes(b"video")

            image = np.zeros((16, 16, 3), dtype=np.uint8)
            with patch.object(recorder_module.cv2, "VideoWriter", FakeWriter):
                authority.activate(51, "CAM-01", 10.0)
                clock[0] = 11.0
                recorder._process_frame(Frame(1, image, captured_at=11.0))
                authority.activate(51, "CAM-02", 150.0)
                clock[0] = 151.0
                recorder._process_frame(Frame(2, image, captured_at=151.0))
                self.assertEqual(len(writers), 2)
                # Navigation that retains the viewer does not split either clip.
                clock[0] = 200.0
                recorder._process_frame(Frame(3, image, captured_at=200.0))
                self.assertEqual(len(writers), 2)
                clock[0] = 311.0
                recorder._process_frame(Frame(4, image, captured_at=311.0))
                self.assertEqual(len(writers), 3)
                self.assertEqual([(info.camera_id, info.producer_generation)
                                  for info in finalized], [("CAM-01", 51)])
                self.assertGreaterEqual(finalized[0].duration_s, 300.0)
                authority.deactivate(51, "CAM-01")
                clock[0] = 320.0
                recorder._reconcile_strict_contexts()
                self.assertEqual(len(finalized), 2)
                self.assertEqual(finalized[1].camera_id, "CAM-01")
                self.assertAlmostEqual(finalized[1].duration_s, 9.0)
                self.assertIn((51, "CAM-02"), recorder._strict_contexts)
                self.assertEqual(metrics.snapshot()["recorder"]["active_segment"],
                                 recorder._strict_contexts[(51, "CAM-02")].path)
                authority.deactivate(51, "CAM-02")
                clock[0] = 321.0
                recorder._reconcile_strict_contexts()
            self.assertEqual(finalized[2].camera_id, "CAM-02")
            self.assertAlmostEqual(finalized[2].duration_s, 170.0)
            self.assertEqual(len({info.path for info in finalized}), 3)
            self.assertTrue(all("CAM-05" not in info.path for info in finalized))


if __name__ == "__main__":
    unittest.main()
