import os
import tempfile
import threading
import unittest

from aegis_engine.config import EngineConfig
from aegis_engine.metrics import MetricsRegistry
from aegis_engine.models import SegmentInfo
from aegis_engine.nas_sync import NASSyncWorker


class FakeMonitor:
    def __init__(self):
        self.clips = []

    def post_clip(self, **payload):
        self.clips.append(payload)


def segment(path):
    return SegmentInfo(
        path=path,
        camera_id="CAM-TEST",
        started_wall="2026-08-13T00:00:00+00:00",
        ended_wall="2026-08-13T00:00:01+00:00",
        duration_s=1.0,
        size_bytes=os.path.getsize(path),
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
            worker._ensure_remote_dir = lambda: None
            worker._transfer = lambda *_args: (0, "", "")
            worker._verify = lambda *_args: False

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
            worker._ensure_remote_dir = lambda: None
            worker._transfer = lambda *_args: (0, "", "")
            worker._verify = lambda *_args: True

            worker._sync_one(segment(path))

            self.assertFalse(os.path.exists(path))
            self.assertEqual(len(monitor.clips), 1)
            self.assertTrue(monitor.clips[0]["stored_on_nas"])
            self.assertEqual(metrics.snapshot()["nas"]["last_status"], "ok")


if __name__ == "__main__":
    unittest.main()
