"""Offline AlertManager contracts: no devices and no real Telegram requests."""

import os
import threading
import unittest
from unittest import mock

import requests

from aegis_engine.alert_manager import AlertManager, _AlertJob
from aegis_engine.config import EngineConfig
from aegis_engine.metrics import MetricsRegistry
from aegis_engine.models import DetectedEntity, DetectionResult, DetectionStatus


class TelegramDeliveryTests(unittest.TestCase):
    def manager(self, *, safe=False, display="", node="mr-tk-01"):
        cfg = EngineConfig(node_id=node, telegram_bot_token="fixture-token",
            telegram_chat_id="fixture-chat", telegram_node_display_name=display,
            telegram_no_ambiguous_retry=safe).validate()
        manager = AlertManager(cfg, MetricsRegistry(), stop_event=mock.Mock())
        manager._stop_event.is_set.return_value = False
        return manager

    def job(self, camera="CAM-02", generation=51, seq=7):
        payload = {"node_id": "mr-tk-01", "camera_id": camera,
                   "camera_label": camera, "unknown_count": 1,
                   "confidence": 91.2, "frame_seq": seq,
                   "producer_generation": generation,
                   "timestamp": "2026-10-06T04:41:22Z"}
        return _AlertJob(payload, b"fixture-jpeg", "fixture.jpg")

    def response(self, status=200, payload=None):
        response = mock.Mock(status_code=status, text="sensitive-response")
        response.json.return_value = {"ok": True} if payload is None else payload
        return response

    def test_machine_c_caption_is_presentation_only(self):
        manager = self.manager(safe=True, display="Machine C")
        job = self.job()
        manager._persist_alert = mock.Mock()
        with mock.patch("requests.post", return_value=self.response()) as post:
            manager._handle(job)
        self.assertEqual(post.call_args.kwargs["data"], {
            "chat_id": "fixture-chat", "caption":
            "🚨 UNKNOWN FACE\nCamera: CAM-02 · CAM-02\n"
            "Node: Machine C (mr-tk-01)\nCount: 1 · Conf: 91.2%\n"
            "Time: 2026-10-06 11:41:22"})
        self.assertTrue(post.call_args.args[0].endswith("/sendPhoto"))
        self.assertEqual(post.call_args.kwargs["files"]["photo"][1], b"fixture-jpeg")
        self.assertEqual(job.payload["node_id"], "mr-tk-01")
        self.assertEqual(job.payload["producer_generation"], 51)
        manager._persist_alert.assert_called_once_with(job.payload, True)

    def test_machine_a_legacy_caption_and_retry_are_unchanged(self):
        manager = self.manager(node="pub-laptop-01")
        job = self.job(camera="CAM-01")
        job.payload["node_id"] = "pub-laptop-01"
        manager._persist_alert = mock.Mock()
        with mock.patch("requests.post", side_effect=[requests.Timeout("fixture"), self.response()]) as post:
            manager._handle(job)
        self.assertEqual(post.call_count, 2)
        self.assertEqual(post.call_args.kwargs["data"]["caption"],
            "🚨 UNKNOWN FACE\nCamera: CAM-01 · CAM-01\nNode: pub-laptop-01\n"
            "Count: 1 · Conf: 91.2%\nTime: 2026-10-06 11:41:22")
        manager._stop_event.wait.assert_called_once_with(2.0)
        self.assertEqual(post.call_args.kwargs["timeout"], 10.0)
        self.assertNotIn("allow_redirects", post.call_args.kwargs)
        manager._persist_alert.assert_called_once_with(job.payload, True)

    def test_machine_c_timeout_is_not_retried_and_not_claimed_sent(self):
        manager = self.manager(safe=True)
        manager._persist_alert = mock.Mock()
        with mock.patch("requests.post", side_effect=requests.Timeout("fixture-token fixture-chat")) as post:
            manager._handle(self.job())
        self.assertEqual(post.call_count, 1)
        self.assertFalse(manager._persist_alert.call_args.args[1])

    def test_machine_c_malformed_acknowledgement_is_not_retried(self):
        manager = self.manager(safe=True)
        response = self.response()
        response.json.side_effect = ValueError("sensitive malformed response")
        with mock.patch("requests.post", return_value=response) as post:
            self.assertFalse(manager._send_telegram(b"jpeg", "caption"))
        self.assertEqual(post.call_count, 1)

    def test_machine_c_explicit_rejection_can_retry(self):
        manager = self.manager(safe=True)
        with mock.patch("requests.post", side_effect=[self.response(400, {"ok": False}), self.response()]) as post:
            self.assertTrue(manager._send_telegram(b"jpeg", "caption"))
        self.assertEqual(post.call_count, 2)

    def test_duplicate_job_does_not_send_or_persist_twice(self):
        manager = self.manager(safe=True)
        manager._persist_alert = mock.Mock()
        with mock.patch("requests.post", return_value=self.response()) as post:
            manager._handle(self.job())
            manager._handle(self.job())
        self.assertEqual(post.call_count, 1)
        self.assertEqual(manager._persist_alert.call_count, 1)

    def test_duplicate_scope_keeps_alias_and_generation_independent(self):
        manager = self.manager(safe=True)
        manager._persist_alert = mock.Mock()
        with mock.patch("requests.post", return_value=self.response()) as post:
            manager._handle(self.job("CAM-01", 51))
            manager._handle(self.job("CAM-02", 51))
            manager._handle(self.job("CAM-02", 52))
        self.assertEqual(post.call_count, 3)
        self.assertEqual(manager._persist_alert.call_count, 3)

    def test_credentials_and_response_details_never_reach_failure_logs(self):
        manager = self.manager(safe=True)
        with mock.patch("requests.post", side_effect=requests.Timeout(
                "https://api.telegram.org/botfixture-token fixture-chat")), \
                self.assertLogs("AlertManager", level="WARNING") as logs:
            self.assertFalse(manager._send_telegram(b"jpeg", "caption"))
        output = " ".join(logs.output)
        for secret in ("fixture-token", "fixture-chat", "api.telegram.org"):
            self.assertNotIn(secret, output)

    def test_environment_options_do_not_change_canonical_identity(self):
        with mock.patch.dict(os.environ, {"AEGIS_NODE_ID": "mr-tk-01",
                "AEGIS_TELEGRAM_NODE_DISPLAY_NAME": "Machine C",
                "AEGIS_TELEGRAM_NO_AMBIGUOUS_RETRY": "true"}, clear=True):
            cfg = EngineConfig.from_env().validate()
        self.assertEqual(cfg.node_id, "mr-tk-01")
        self.assertEqual(getattr(cfg, "telegram_node_display_name", None), "Machine C")
        self.assertTrue(getattr(cfg, "telegram_no_ambiguous_retry", False))

    def test_defaults_and_caption_only_option_preserve_machine_a_retries(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            cfg = EngineConfig.from_env().validate()
        self.assertEqual(cfg.telegram_node_display_name, "")
        self.assertFalse(cfg.telegram_no_ambiguous_retry)
        manager = self.manager(display="Display only", node="pub-laptop-01")
        with mock.patch("requests.post", side_effect=requests.Timeout("fixture")) as post:
            self.assertFalse(manager._send_telegram(b"jpeg", "caption"))
        self.assertEqual(post.call_count, 3)
        self.assertEqual(manager._stop_event.wait.call_args_list,
                         [mock.call(2.0), mock.call(4.0), mock.call(5.0)])

    def test_display_rejects_control_characters_and_oversize_values(self):
        for display in ("Machine C\nNode: Other", "Bad\x00label", "x" * 65):
            with self.subTest(display=repr(display)), self.assertRaises(ValueError):
                EngineConfig(telegram_node_display_name=display).validate()

    def test_config_masks_both_telegram_credentials(self):
        cfg = EngineConfig(telegram_bot_token="fixture-token", telegram_chat_id="fixture-chat")
        self.assertEqual(cfg.redacted()["telegram_chat_id"], "***set***")
        self.assertEqual(cfg.redacted()["telegram_bot_token"], "***set***")

    def test_safe_mode_requires_unambiguous_boolean_acknowledgement(self):
        for status, payload in ((500, {"ok": False}), (200, {"ok": "true"}),
                                (200, {}), (200, []), (302, {"ok": False})):
            manager = self.manager(safe=True)
            with self.subTest(status=status, payload=payload), \
                    mock.patch("requests.post", return_value=self.response(status, payload)) as post:
                self.assertFalse(manager._send_telegram(b"jpeg", "caption"))
                self.assertEqual(post.call_count, 1)
                self.assertFalse(post.call_args.kwargs["allow_redirects"])

    def test_ambiguous_job_is_not_resubmitted(self):
        manager = self.manager(safe=True)
        manager._persist_alert = mock.Mock()
        with mock.patch("requests.post", side_effect=requests.Timeout("fixture")) as post:
            manager._handle(self.job())
            manager._handle(self.job())
        self.assertEqual(post.call_count, 1)
        manager._persist_alert.assert_called_once_with(self.job().payload, False)

    def test_concurrent_duplicate_cannot_enter_sender_twice(self):
        manager = self.manager(safe=True)
        manager._persist_alert = mock.Mock()
        entered, release = threading.Event(), threading.Event()
        def send(*args, **kwargs):
            entered.set()
            self.assertTrue(release.wait(2))
            return self.response()
        with mock.patch("requests.post", side_effect=send) as post:
            worker = threading.Thread(target=manager._handle, args=(self.job(),))
            worker.start()
            try:
                self.assertTrue(entered.wait(2))
                manager._handle(self.job())
            finally:
                release.set()
                worker.join(2)
            self.assertFalse(worker.is_alive())
        self.assertEqual(post.call_count, 1)

    def test_duplicate_memory_is_bounded_and_capacity_fails_closed(self):
        manager = self.manager(safe=True)
        manager._persist_alert = mock.Mock()
        manager._publish = mock.Mock()
        with mock.patch("requests.post", return_value=self.response()) as post, \
                mock.patch("aegis_engine.alert_manager.time.monotonic", return_value=100):
            for seq in range(257):
                manager._handle(self.job(seq=seq))
        self.assertEqual(post.call_count, 256)
        self.assertEqual(len(manager._recent_jobs), 256)
        self.assertEqual(manager._persist_alert.call_count, 257)
        self.assertFalse(manager._persist_alert.call_args.args[1])
        self.assertEqual(manager._publish.call_count, 257)

    def test_completed_duplicate_window_expires_at_documented_boundary(self):
        manager = self.manager(safe=True)
        manager._persist_alert = mock.Mock()
        with mock.patch("requests.post", return_value=self.response()) as post, \
                mock.patch("aegis_engine.alert_manager.time.monotonic") as clock:
            clock.return_value = 100
            manager._handle(self.job())
            clock.return_value = 159
            manager._handle(self.job())
            self.assertEqual(post.call_count, 1)
            clock.return_value = 160
            manager._handle(self.job())
            self.assertEqual(post.call_count, 2)

    def test_inflight_claim_does_not_expire(self):
        manager = self.manager(safe=True)
        with mock.patch("aegis_engine.alert_manager.time.monotonic") as clock:
            clock.return_value = 100
            self.assertIsNotNone(manager._claim_job(self.job()))
            clock.return_value = 10000
            self.assertIsNone(manager._claim_job(self.job()))

    def test_blocked_send_remains_claimed_after_time_jump(self):
        manager = self.manager(safe=True)
        entered, release = threading.Event(), threading.Event()
        def send(*args, **kwargs):
            entered.set()
            release.wait(2)
            return self.response()
        with mock.patch("aegis_engine.alert_manager.time.monotonic") as clock, \
                mock.patch("requests.post", side_effect=send) as post:
            clock.return_value = 100
            worker = threading.Thread(target=manager._handle, args=(self.job(),))
            worker.start()
            try:
                self.assertTrue(entered.wait(2))
                clock.return_value = 10000
                manager._handle(self.job())
                self.assertEqual(post.call_count, 1)
            finally:
                release.set()
                worker.join(2)
            self.assertFalse(worker.is_alive())

    def test_node_identity_is_also_part_of_duplicate_scope(self):
        manager = self.manager(safe=True)
        other = self.job()
        other.payload["node_id"] = "other-fixture-node"
        with mock.patch.object(manager, "_handle_claimed") as handle:
            manager._handle(self.job())
            manager._handle(other)
        self.assertEqual(handle.call_count, 2)

    def test_unknown_eligibility_cooldown_and_alias_payload_are_unchanged(self):
        manager = self.manager(safe=True, display="Machine C")
        result = DetectionResult("CAM-02", 7, [DetectedEntity(DetectionStatus.UNKNOWN, 91.2)], 1,
                                 producer_generation=51)
        authorized = DetectionResult("CAM-02", 8, [DetectedEntity(DetectionStatus.AUTHORIZED)], 1)
        with mock.patch.object(manager, "_make_snapshot", return_value=(b"jpeg", "fixture.jpg")) as snapshot, \
                mock.patch("aegis_engine.alert_manager.time.monotonic", return_value=100):
            manager.submit(authorized, None)
            manager.submit(result, None)
            manager.submit(result, None)
        snapshot.assert_called_once_with(result, None)
        self.assertEqual(manager._queue.qsize(), 1)
        payload = manager._queue.get_nowait().payload
        self.assertEqual((payload["node_id"], payload["camera_id"], payload["camera_label"],
                          payload["producer_generation"]), ("mr-tk-01", "CAM-02", "CAM-02", 51))
        self.assertNotIn("Machine C", str(payload))

    def test_persistence_receives_exact_camera_generation_and_unconfirmed_outcome(self):
        manager = self.manager(safe=True)
        manager._monitor = mock.Mock()
        with mock.patch("requests.post", side_effect=requests.Timeout("fixture")):
            manager._handle(self.job())
        call = manager._monitor.post_alert.call_args.kwargs
        self.assertEqual(call["camera_id"], "CAM-02")
        self.assertEqual(call["producer_generation"], 51)
        self.assertIs(call["telegram_sent"], False)

    def test_dry_run_and_stopped_sender_never_contact_telegram(self):
        manager = self.manager(safe=True)
        manager._stop_event.is_set.return_value = True
        with mock.patch("requests.post") as post:
            self.assertFalse(manager._send_telegram(b"jpeg", "caption"))
            manager._dry_run = True
            manager._handle(self.job())
        post.assert_not_called()

    def test_machine_a_does_not_enable_duplicate_suppression(self):
        manager = self.manager(node="pub-laptop-01")
        with mock.patch("requests.post", return_value=self.response()) as post:
            manager._handle(self.job())
            manager._handle(self.job())
        self.assertEqual(post.call_count, 2)
        self.assertEqual(manager._recent_jobs, {})

    def test_http_failure_body_is_redacted_in_both_modes(self):
        for safe in (False, True):
            manager = self.manager(safe=safe)
            with mock.patch("requests.post", return_value=self.response(400, {"ok": False})), \
                    self.assertLogs("AlertManager", level="WARNING") as logs:
                self.assertFalse(manager._send_telegram(b"jpeg", "caption"))
            self.assertNotIn("sensitive-response", " ".join(logs.output))

    def test_default_mode_exception_logs_also_redact_credentials(self):
        manager = self.manager(node="pub-laptop-01")
        with mock.patch("requests.post", side_effect=requests.Timeout(
                "https://api.telegram.org/botfixture-token fixture-chat")), \
                self.assertLogs("AlertManager", level="WARNING") as logs:
            self.assertFalse(manager._send_telegram(b"jpeg", "caption"))
        for secret in ("fixture-token", "fixture-chat", "api.telegram.org"):
            self.assertNotIn(secret, " ".join(logs.output))


if __name__ == "__main__":
    unittest.main()
