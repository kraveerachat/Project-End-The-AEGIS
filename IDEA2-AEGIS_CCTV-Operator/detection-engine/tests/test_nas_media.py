"""Real, temporary video-only media; transfers/publication are always mocked."""
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import cv2
import numpy as np

from aegis_engine.config import EngineConfig
from aegis_engine.metrics import MetricsRegistry
from aegis_engine.models import SegmentInfo
from aegis_engine.nas_sync import NASSyncWorker


FFMPEG = shutil.which("ffmpeg")
FFPROBE = shutil.which("ffprobe")


class Monitor:
    def __init__(self):
        self.clips = []

    def post_clip(self, **payload):
        self.clips.append(payload)


class NASMediaTests(unittest.TestCase):
    def worker(self):
        monitor = Monitor()
        metrics = MetricsRegistry()
        worker = NASSyncWorker(EngineConfig(
            nas_enabled=True, nas_host="offline.invalid", nas_user="fixture",
            nas_verify="checksum", nas_delete_after_sync=True,
            nas_max_retries=1, nas_retry_backoff_s=0,
        ).validate(), metrics, monitor=monitor)
        worker._ensure_remote_dir = lambda: self.fail("must not access NAS")
        worker._transfer = lambda *_args: self.fail("must not transfer failed conversion")
        worker._verify = lambda *_args: self.fail("must not verify failed conversion")
        return worker, monitor, metrics

    def info(self, path):
        return SegmentInfo(
            path=path, camera_id="CAM-TEST",
            started_wall="2026-10-11T00:00:00+00:00",
            ended_wall="2026-10-11T00:00:01+00:00",
            duration_s=1.0, size_bytes=os.path.getsize(path),
        )

    def fixture(self, directory):
        path = os.path.join(directory, "synthetic.mp4")
        writer = cv2.VideoWriter(path, cv2.VideoWriter_fourcc(*"mp4v"), 12, (64, 48))
        self.assertTrue(writer.isOpened(), "OpenCV mp4v encoder required")
        try:
            for index in range(12):
                image = np.full((48, 64, 3), index * 20, dtype=np.uint8)
                writer.write(image)
        finally:
            writer.release()
        self.assertGreater(os.path.getsize(path), 0)
        return path

    def probe(self, path):
        result = subprocess.run([
            FFPROBE, "-v", "error", "-show_streams", "-show_format",
            "-of", "json", path,
        ], capture_output=True, text=True, timeout=20, check=True)
        return json.loads(result.stdout)

    @unittest.skipUnless(FFMPEG and FFPROBE, "ffmpeg/ffprobe unavailable")
    def test_real_mp4v_converts_to_nonempty_decodable_h264_mp4(self):
        encoders = subprocess.run([FFMPEG, "-hide_banner", "-encoders"],
                                  capture_output=True, text=True, timeout=20, check=True)
        self.assertTrue(any(line.split()[1:2] == ["libx264"]
                            for line in encoders.stdout.splitlines()))
        with tempfile.TemporaryDirectory() as directory:
            path = self.fixture(directory)
            self.assertEqual(self.probe(path)["streams"][0]["codec_name"], "mpeg4")
            worker, monitor, metrics = self.worker()
            self.assertTrue(worker._prepare_browser_playback(path))
            output = self.probe(path)
            self.assertGreater(os.path.getsize(path), 0)
            self.assertEqual(len(output["streams"]), 1, "video-only fixture")
            video = output["streams"][0]
            self.assertEqual(video["codec_name"], "h264")
            self.assertEqual(video["pix_fmt"], "yuv420p")
            self.assertEqual((video["width"], video["height"]), (64, 48))
            self.assertEqual(int(video["nb_frames"]), 12)
            self.assertAlmostEqual(float(output["format"]["duration"]), 1.0, delta=1 / 12)
            decoded = subprocess.run([FFMPEG, "-v", "error", "-i", path,
                                      "-f", "null", "-"],
                                     capture_output=True, text=True, timeout=20)
            self.assertEqual(decoded.returncode, 0, decoded.stderr)
            self.assertFalse(os.path.exists(path + ".h264tmp.mp4"))
            self.assertEqual(monitor.clips, [])
            self.assertEqual(metrics.snapshot()["nas"]["synced_total"], 0)

    @unittest.skipUnless(FFMPEG, "ffmpeg unavailable")
    def test_real_conversion_failure_retains_source_and_publishes_nothing(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "invalid.mp4")
            original = b"not-a-valid-mp4-but-recoverable-source"
            with open(path, "wb") as output:
                output.write(original)
            worker, monitor, metrics = self.worker()
            worker._sync_one(self.info(path))
            with open(path, "rb") as source:
                self.assertEqual(source.read(), original)
            self.assertFalse(os.path.exists(path + ".h264tmp.mp4"))
            self.assertEqual(monitor.clips, [])
            self.assertEqual(metrics.snapshot()["nas"]["synced_total"], 0)
            self.assertEqual(metrics.snapshot()["nas"]["last_status"], "failed")

    def test_missing_ffmpeg_retains_source_without_transfer_or_publication(self):
        with tempfile.TemporaryDirectory() as directory:
            path = self.fixture(directory)
            with open(path, "rb") as source:
                original = source.read()
            worker, monitor, metrics = self.worker()
            with patch("aegis_engine.nas_sync.shutil.which", return_value=None):
                worker._sync_one(self.info(path))
            with open(path, "rb") as source:
                self.assertEqual(source.read(), original)
            self.assertEqual(monitor.clips, [])
            self.assertEqual(metrics.snapshot()["nas"]["last_status"], "failed")

    def test_empty_encoder_output_is_not_archive_success(self):
        with tempfile.TemporaryDirectory() as directory:
            path = self.fixture(directory)
            with open(path, "rb") as source:
                original = source.read()
            worker, monitor, metrics = self.worker()
            def empty_output(*_args, **_kwargs):
                with open(path + ".h264tmp.mp4", "wb"):
                    pass
                return 0, "", ""
            worker._run = empty_output
            with patch("aegis_engine.nas_sync.shutil.which", return_value="offline-ffmpeg"):
                worker._sync_one(self.info(path))
            with open(path, "rb") as source:
                self.assertEqual(source.read(), original)
            self.assertEqual(monitor.clips, [])
            self.assertEqual(metrics.snapshot()["nas"]["synced_total"], 0)
            self.assertFalse(os.path.exists(path + ".h264tmp.mp4"))
