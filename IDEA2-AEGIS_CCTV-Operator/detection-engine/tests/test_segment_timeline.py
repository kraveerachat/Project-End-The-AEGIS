"""Distinct synthetic images exercise CFR content timing without any camera."""
import os
import queue
import tempfile
import unittest
from unittest.mock import patch

import numpy as np

from aegis_engine.config import EngineConfig
from aegis_engine.metrics import MetricsRegistry
from aegis_engine.models import Frame
from aegis_engine.segment_recorder import SegmentRecorder


class ImageWriter:
    def __init__(self):
        self.images = []
        self.released = False

    def write(self, image):
        self.images.append(image.copy())

    def release(self):
        self.released = True

    def isOpened(self):
        return True


class SegmentTimelineTests(unittest.TestCase):
    def recorder(self, **config):
        recorder = SegmentRecorder(
            EngineConfig(target_fps=2, **config), MetricsRegistry(),
            queue.Queue(), on_segment=lambda _info: None,
        )
        writer = ImageWriter()
        recorder._writer = writer
        recorder._writer_size = (16, 16)
        recorder._segment_capture_started_monotonic = 100.0
        return recorder, writer

    def frame(self, value, seconds, size=16):
        return Frame(
            seq=int(seconds * 100), captured_at=100.0 + seconds,
            image=np.full((size, size, 3), value, dtype=np.uint8),
        )

    def values(self, writer):
        return [int(image[0, 0, 0]) for image in writer.images]

    def test_a_at_zero_b_at_thirty_never_backdates_b_into_elapsed_gap(self):
        recorder, writer = self.recorder()
        recorder._write(self.frame(10, 0))
        recorder._write(self.frame(200, 30))
        self.assertEqual(self.values(writer), [10] * 60 + [200])
        self.assertEqual(len(writer.images), 61)

    def test_distinct_images_across_repeated_capture_gaps(self):
        recorder, writer = self.recorder()
        for value, seconds in [(10, 0), (100, 1), (200, 2)]:
            recorder._write(self.frame(value, seconds))
        self.assertEqual(self.values(writer), [10, 10, 100, 100, 200])

    def test_fast_source_drops_surplus_but_holds_latest_captured_image(self):
        recorder, writer = self.recorder()
        recorder._write(self.frame(10, 0))
        recorder._write(self.frame(100, 0.1))
        self.assertEqual(self.values(writer), [10], "no surplus CFR slot")
        recorder._write(self.frame(200, 1))
        self.assertEqual(self.values(writer), [10, 100, 200])

    def test_held_image_does_not_alias_a_reused_input_buffer(self):
        recorder, writer = self.recorder()
        first = self.frame(10, 0)
        recorder._write(first)
        first.image[:] = 240
        recorder._write(self.frame(200, 1))
        self.assertEqual(self.values(writer), [10, 10, 200])

    def test_between_slots_frame_is_not_backdated_to_previous_cfr_slot(self):
        recorder, writer = self.recorder()
        recorder._write(self.frame(10, 0))
        recorder._write(self.frame(100, 0.6))
        self.assertEqual(self.values(writer), [10, 10], "0.5s slot precedes B capture")
        recorder._write(self.frame(200, 1.6))
        self.assertEqual(self.values(writer), [10, 10, 100, 100])

    def test_dropped_capture_snapshot_does_not_alias_reused_input_buffer(self):
        recorder, writer = self.recorder()
        recorder._write(self.frame(10, 0))
        dropped = self.frame(100, 0.1)
        recorder._write(dropped)
        dropped.image[:] = 240
        recorder._write(self.frame(200, 1))
        self.assertEqual(self.values(writer), [10, 100, 200])

    def test_rollover_resets_held_image_before_next_segment(self):
        with tempfile.TemporaryDirectory() as directory:
            recorder, first_writer = self.recorder(segment_dir=directory)
            recorder._write(self.frame(10, 0))
            recorder._segment_started_monotonic = 100.0
            with patch("aegis_engine.segment_recorder.time.monotonic", return_value=400.0):
                recorder._maybe_rotate()
            self.assertTrue(first_writer.released)
            self.assertIsNone(recorder._held_frame)
            next_writer = ImageWriter()
            with patch("aegis_engine.segment_recorder.cv2.VideoWriter", return_value=next_writer):
                recorder._ensure_writer(self.frame(200, 300))
            recorder._write(self.frame(200, 300))
            recorder._write(self.frame(240, 301))
            self.assertEqual(self.values(next_writer), [200, 200, 240])

    def test_logout_partial_reset_does_not_carry_pixels_into_new_session(self):
        with tempfile.TemporaryDirectory() as directory:
            recorder, first_writer = self.recorder(segment_dir=directory)
            path = os.path.join(directory, "partial.mp4")
            with open(path, "wb") as output:
                output.write(b"synthetic-writer-output")
            recorder._current_path = path
            recorder._segment_started_monotonic = 100.0
            recorder._segment_started_wall = "2026-10-11T00:00:00+00:00"
            finalized = []
            recorder._on_segment = finalized.append
            recorder._write(self.frame(10, 0))
            with patch("aegis_engine.segment_recorder.time.monotonic", return_value=107.5):
                recorder._finalize_segment()
            self.assertEqual(finalized[0].duration_s, 7.5)
            self.assertEqual(finalized[0].camera_id, recorder._cfg.camera_id)
            self.assertIsNone(recorder._held_frame)
            second_writer = ImageWriter()
            with patch("aegis_engine.segment_recorder.cv2.VideoWriter", return_value=second_writer):
                recorder._ensure_writer(self.frame(200, 30))
            recorder._write(self.frame(200, 30))
            self.assertEqual(self.values(second_writer), [200])

    def test_resolution_boundary_resets_previous_frame(self):
        with tempfile.TemporaryDirectory() as directory:
            recorder, previous = self.recorder(segment_dir=directory)
            recorder._write(self.frame(10, 0))
            current = ImageWriter()
            with patch("aegis_engine.segment_recorder.cv2.VideoWriter", return_value=current):
                recorder._ensure_writer(self.frame(200, 1, size=32))
            recorder._write(self.frame(200, 1, size=32))
            self.assertTrue(previous.released)
            self.assertEqual(self.values(current), [200])
            self.assertEqual(current.images[0].shape, (32, 32, 3))

    def test_separate_recorders_never_share_held_pixels(self):
        first, first_writer = self.recorder(camera_id="CAM-01")
        second, second_writer = self.recorder(camera_id="CAM-02")
        first._write(self.frame(10, 0))
        second._write(self.frame(100, 0))
        first._write(self.frame(200, 1))
        second._write(self.frame(240, 1))
        self.assertEqual(self.values(first_writer), [10, 10, 200])
        self.assertEqual(self.values(second_writer), [100, 100, 240])
