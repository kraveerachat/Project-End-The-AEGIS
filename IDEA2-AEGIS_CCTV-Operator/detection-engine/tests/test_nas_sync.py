import os
import shutil
import subprocess
import tempfile
import threading
import unittest
from unittest import mock

from aegis_engine.config import EngineConfig
from aegis_engine.metrics import MetricsRegistry
from aegis_engine.models import SegmentInfo
from aegis_engine.nas_sync import NASSyncWorker


class FakeMonitor:
    def __init__(self, acknowledged=True):
        self.clips = []
        self.acknowledged = acknowledged

    def post_clip(self, **payload):
        self.clips.append(payload)
        return self.acknowledged


def segment(path, *, camera_id="CAM-TEST", producer_generation=None):
    return SegmentInfo(
        path=path,
        camera_id=camera_id,
        started_wall="2026-08-13T00:00:00+00:00",
        ended_wall="2026-08-13T00:00:01+00:00",
        duration_s=1.0,
        size_bytes=os.path.getsize(path),
        producer_generation=producer_generation,
    )


class NASSyncTruthTests(unittest.TestCase):
    def _file(self, directory):
        path = os.path.join(directory, "segment.mp4")
        with open(path, "wb") as handle:
            handle.write(b"camera-segment")
        return path

    def test_disabled_nas_keeps_local_file_and_claims_no_success(self):
        with tempfile.TemporaryDirectory() as directory:
            path = self._file(directory)
            metrics = MetricsRegistry()
            monitor = FakeMonitor()
            worker = NASSyncWorker(
                EngineConfig(nas_enabled=False), metrics, monitor=monitor
            )

            worker.submit(segment(path))

            self.assertTrue(os.path.exists(path))
            self.assertEqual(worker._queue.qsize(), 0)
            self.assertEqual(monitor.clips, [])
            nas = metrics.snapshot()["nas"]
            self.assertEqual(nas["last_status"], "disabled")
            self.assertEqual(nas["synced_total"], 0)

    def test_failed_integrity_verification_keeps_file_and_posts_no_clip(self):
        with tempfile.TemporaryDirectory() as directory:
            path = self._file(directory)
            metrics = MetricsRegistry()
            monitor = FakeMonitor()
            config = EngineConfig(
                nas_enabled=True,
                nas_user="aegis",
                nas_host="nas.local",
                nas_verify="checksum",
                nas_max_retries=1,
                nas_retry_backoff_s=0,
            ).validate()
            worker = NASSyncWorker(config, metrics, threading.Event(), monitor)
            worker._prepare_browser_playback = lambda *_args: True
            worker._ensure_remote_dir = lambda: None
            worker._transfer = lambda *_args: (0, "", "")
            worker._verify = lambda *_args: False

            worker._sync_one(segment(path))

            self.assertTrue(os.path.exists(path))
            self.assertEqual(monitor.clips, [])
            self.assertEqual(metrics.snapshot()["nas"]["last_status"], "failed")

    def test_browser_transcode_failure_keeps_file_and_posts_no_clip(self):
        with tempfile.TemporaryDirectory() as directory:
            path = self._file(directory)
            metrics = MetricsRegistry()
            monitor = FakeMonitor()
            config = EngineConfig(
                nas_enabled=True,
                nas_user="aegis",
                nas_host="nas.local",
                nas_max_retries=1,
            ).validate()
            worker = NASSyncWorker(config, metrics, threading.Event(), monitor)
            worker._prepare_browser_playback = lambda *_args: False
            worker._ensure_remote_dir = lambda: self.fail("must not transfer unplayable clip")

            worker._sync_one(segment(path))

            self.assertTrue(os.path.exists(path))
            self.assertEqual(monitor.clips, [])
            self.assertEqual(metrics.snapshot()["nas"]["last_status"], "failed")

    def test_verified_transfer_is_only_path_to_nas_success(self):
        with tempfile.TemporaryDirectory() as directory:
            path = self._file(directory)
            metrics = MetricsRegistry()
            monitor = FakeMonitor()
            config = EngineConfig(
                nas_enabled=True,
                nas_user="aegis",
                nas_host="nas.local",
                nas_verify="checksum",
                nas_delete_after_sync=True,
            ).validate()
            worker = NASSyncWorker(config, metrics, threading.Event(), monitor)
            worker._prepare_browser_playback = lambda *_args: True
            worker._ensure_remote_dir = lambda: None
            worker._transfer = lambda *_args: (0, "", "")
            worker._verify = lambda *_args: True

            worker._sync_one(segment(path))

            self.assertFalse(os.path.exists(path))
            self.assertEqual(len(monitor.clips), 1)
            self.assertTrue(monitor.clips[0]["stored_on_nas"])
            self.assertEqual(metrics.snapshot()["nas"]["last_status"], "ok")

    def test_verified_strict_segment_preserves_alias_generation_and_end_time(self):
        with tempfile.TemporaryDirectory() as directory:
            path = self._file(directory)
            monitor = FakeMonitor()
            worker = NASSyncWorker(
                EngineConfig(nas_enabled=True, nas_user="aegis", nas_host="nas.local",
                             nas_dest_dir="/recordings",
                             nas_delete_after_sync=True).validate(),
                MetricsRegistry(), monitor=monitor,
            )
            worker._prepare_browser_playback = lambda *_args: True
            worker._ensure_remote_dir = lambda: None
            worker._transfer = lambda *_args: (0, "", "")
            worker._verify = lambda *_args: True

            info = segment(path, camera_id="CAM-02", producer_generation=9007199254740993)
            self.assertEqual(9007199254740993, info.to_dict()["producer_generation"])
            worker._sync_one(info)

            self.assertEqual([{
                "camera_id": "CAM-02",
                "started_at": "2026-08-13T00:00:00+00:00",
                "duration_sec": 1.0,
                "file_path": "/recordings/segment.mp4",
                "stored_on_nas": True,
                "producer_generation": 9007199254740993,
                "ended_at": "2026-08-13T00:00:01+00:00",
            }], monitor.clips)

    def test_failed_transfer_keeps_strict_segment_and_publishes_nothing(self):
        with tempfile.TemporaryDirectory() as directory:
            path = self._file(directory)
            monitor = FakeMonitor()
            worker = NASSyncWorker(
                EngineConfig(nas_enabled=True, nas_user="aegis", nas_host="nas.local",
                             nas_max_retries=1, nas_retry_backoff_s=0).validate(),
                MetricsRegistry(), monitor=monitor,
            )
            worker._prepare_browser_playback = lambda *_args: True
            worker._ensure_remote_dir = lambda: None
            worker._transfer = lambda *_args: (1, "", "transfer failed")
            worker._sync_one(segment(path, camera_id="CAM-02", producer_generation=7))
            self.assertTrue(os.path.exists(path))
            self.assertEqual([], monitor.clips)

    def test_rejected_publication_keeps_verified_local_source(self):
        with tempfile.TemporaryDirectory() as directory:
            path = self._file(directory)
            monitor = FakeMonitor(acknowledged=False)
            worker = NASSyncWorker(
                EngineConfig(nas_enabled=True, nas_user="aegis", nas_host="nas.local",
                             nas_delete_after_sync=True).validate(),
                MetricsRegistry(), monitor=monitor,
            )
            worker._prepare_browser_playback = lambda *_args: True
            worker._ensure_remote_dir = lambda: None
            worker._transfer = lambda *_args: (0, "", "")
            worker._verify = lambda *_args: True
            worker._sync_one(segment(path, camera_id="CAM-02", producer_generation=7))
            self.assertTrue(os.path.exists(path))
            self.assertEqual(1, len(monitor.clips))
            nas = worker._metrics.snapshot()["nas"]
            self.assertEqual("failed", nas["last_status"])
            self.assertEqual(0, nas["synced_total"])

    def test_browser_transcode_maps_optional_audio_to_aac(self):
        with tempfile.TemporaryDirectory() as directory:
            path = self._file(directory)
            worker = NASSyncWorker(EngineConfig(), MetricsRegistry())
            commands = []

            def fake_run(command, **_kwargs):
                commands.append(command)
                with open(command[-1], "wb") as handle:
                    handle.write(b"synthetic-transcoded-mp4")
                return (0, "", "")

            worker._run = fake_run
            with mock.patch("aegis_engine.nas_sync.shutil.which", return_value="ffmpeg"):
                self.assertTrue(worker._prepare_browser_playback(path))

            command = commands[0]
            self.assertNotIn("-an", command)
            self.assertEqual("0:v:0", command[command.index("-map") + 1])
            self.assertEqual("0:a:0?", command[command.index("-map", command.index("-map") + 1) + 1])
            self.assertEqual("aac", command[command.index("-c:a") + 1])
            self.assertEqual("libx264", command[command.index("-c:v") + 1])

    @unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "offline ffmpeg tools unavailable")
    def test_synthetic_video_and_aac_survive_browser_transcode(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "synthetic.mp4")
            subprocess.run([
                "ffmpeg", "-v", "error", "-y",
                "-f", "lavfi", "-i", "testsrc=size=64x64:rate=10:duration=1",
                "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1",
                "-c:v", "mpeg4", "-c:a", "aac", "-shortest", path,
            ], check=True, capture_output=True)
            worker = NASSyncWorker(EngineConfig(), MetricsRegistry())
            self.assertTrue(worker._prepare_browser_playback(path))
            probe = subprocess.run([
                "ffprobe", "-v", "error", "-show_entries", "stream=codec_type,codec_name",
                "-of", "csv=p=0", path,
            ], check=True, capture_output=True, text=True)
            streams = probe.stdout.splitlines()
            self.assertIn("h264,video", streams)
            self.assertIn("aac,audio", streams)

    @unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "offline ffmpeg tools unavailable")
    def test_legacy_video_only_survives_optional_audio_mapping(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "legacy-video-only.mp4")
            subprocess.run([
                "ffmpeg", "-v", "error", "-y",
                "-f", "lavfi", "-i", "testsrc=size=64x64:rate=10:duration=1",
                "-c:v", "mpeg4", path,
            ], check=True, capture_output=True)
            worker = NASSyncWorker(EngineConfig(), MetricsRegistry())
            self.assertTrue(worker._prepare_browser_playback(path))
            probe = subprocess.run([
                "ffprobe", "-v", "error", "-show_entries", "stream=codec_type,codec_name",
                "-of", "csv=p=0", path,
            ], check=True, capture_output=True, text=True)
            self.assertIn("h264,video", probe.stdout.splitlines())
            self.assertNotIn("aac,audio", probe.stdout.splitlines())


if __name__ == "__main__":
    unittest.main()
