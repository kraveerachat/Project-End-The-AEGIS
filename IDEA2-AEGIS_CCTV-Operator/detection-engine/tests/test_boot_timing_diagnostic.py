import asyncio
import json
import logging
import os
import queue
import threading
import unittest
from unittest.mock import patch
from starlette.requests import Request
from aegis_engine.config import EngineConfig
from aegis_engine.local_api import LocalEventAPI
from aegis_engine.metrics import MetricsRegistry
from aegis_engine.stream_hub import StreamHub
from aegis_engine.boot_timing_diagnostic import BootTimingDiagnostic


class BootTimingDiagnosticTests(unittest.TestCase):
    def exercise(self, key=b'fixture-only-key', diagnostic_id=b'a' * 32):
        cfg = EngineConfig(detection_engine_api_key='fixture-only-key')
        hub = StreamHub(cfg, queue.Queue())
        api = LocalEventAPI(cfg,
                            MetricsRegistry(), stream_hub=hub)
        endpoint = next(r.endpoint for r in api._app.routes if r.path == '/producer/boot')
        request = Request({'type': 'http', 'method': 'GET', 'path': '/producer/boot',
                           'headers': [(b'x-detection-engine-key', key),
                                       (b'x-aegis-clock-nonce', b'b' * 64),
                                       (b'x-aegis-boot-diagnostic-id', diagnostic_id)]})
        async def run():
            response = await endpoint(request)
            async def receive():
                return {'type': 'http.disconnect'}
            async def send(message):
                pass
            await response(request.scope, receive, send)
            return response
        return asyncio.run(run())

    def test_authenticated_boot_emits_correlated_redacted_timing_only_when_enabled(self):
        from aegis_engine.boot_timing_diagnostic import _records
        captured = []
        def write(fd, line):
            self.assertEqual(fd, 2)
            captured.append(line.decode('utf-8'))
            return len(line)
        with patch.dict(os.environ, {'AEGIS_BOOT_TIMING_DIAGNOSTIC': 'true'}):
            with patch('os.write', side_effect=write):
                response = self.exercise()
                _records.join()
        self.assertEqual(response.status_code, 200)
        self.assertTrue(any('a' * 32 in line for line in captured))
        self.assertFalse(any('fixture-only-key' in line or 'b' * 64 in line
                             for line in captured))
        record = json.loads(captured[0])
        self.assertEqual(set(record['phasesMs']), {'handler_entry', 'authentication',
            'authority_clock', 'signing', 'response_submission'})
        self.assertEqual(set(json.loads(__import__('base64').urlsafe_b64decode(
            response.body.split(b'.')[0] + b'==='))), {'engineBootId', 'nodeId', 'nonce', 'engineNowMs'})
        self.assertEqual(response.headers['cache-control'], 'no-store')

    def test_default_off_and_unauthorized_or_invalid_id_never_emit(self):
        records = []
        for enabled, key, identifier in [(False, b'fixture-only-key', b'a' * 32),
                                        (True, b'wrong-key', b'a' * 32),
                                        (True, b'fixture-only-key', b'SECRET\n' * 8)]:
            controller = BootTimingDiagnostic(enabled=lambda: enabled, sink=records.append)
            with patch('aegis_engine.local_api.engine_boot_timing', controller):
                response = self.exercise(key, identifier)
            self.assertEqual(response.status_code, 401 if key == b'wrong-key' else 200)
        self.assertEqual(records, [])

    def test_monotonic_phases_have_fixed_shape_and_cap(self):
        records, now = [], [10.0]
        controller = BootTimingDiagnostic(enabled=lambda: True, clock=lambda: now[0], sink=records.append)
        headers = [(b'x-aegis-boot-diagnostic-id', b'c' * 32)]
        trace = controller.begin(headers)
        now[0] += 4
        trace.mark('authentication')
        now[0] += 6
        trace.mark('authority_clock')
        trace.mark('SECRET')
        now[0] += 50_000
        trace.mark('signing')
        trace.finish('submitted')
        trace.finish('submitted')
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]['phasesMs'], {'handler_entry': 0, 'authentication': 4,
                         'authority_clock': 10, 'signing': 10_000})
        self.assertEqual(records[0]['elapsedMs'], 10_000)
        for _ in range(200):
            controller.begin(headers).finish('submitted')
        self.assertEqual(len(records), 128)
        now[0] = 300_010
        controller.begin(headers).finish('submitted')
        self.assertEqual(len(records), 128)

    def test_invalid_or_duplicate_id_and_clock_sink_errors_cannot_break_boot(self):
        def broken(*args):
            raise RuntimeError('SECRET')
        for controller in [BootTimingDiagnostic(enabled=broken),
                           BootTimingDiagnostic(enabled=lambda: True, clock=broken),
                           BootTimingDiagnostic(enabled=lambda: True, sink=broken)]:
            with patch('aegis_engine.local_api.engine_boot_timing', controller):
                self.assertEqual(self.exercise().status_code, 200)
        records = []
        controller = BootTimingDiagnostic(enabled=lambda: True, sink=records.append)
        duplicate = [(b'x-aegis-boot-diagnostic-id', b'a' * 32)] * 2
        controller.begin(duplicate).finish('submitted')
        self.assertEqual(records, [])

    def test_response_submission_and_failure_are_observed_without_swallowing_errors(self):
        from aegis_engine.local_api import _BootTimingResponse
        records = []
        controller = BootTimingDiagnostic(enabled=lambda: True, sink=records.append)
        trace = controller.begin([(b'x-aegis-boot-diagnostic-id', b'd' * 32)])
        async def send(_message):
            raise OSError('SECRET')
        async def run():
            response = _BootTimingResponse(content='signed-fixture', timing=trace)
            with self.assertRaises(OSError):
                await response({'type': 'http'}, None, send)
        asyncio.run(run())
        self.assertEqual(records[0]['outcome'], 'response_failure')
        self.assertIn('response_submission', records[0]['phasesMs'])
        self.assertNotIn('SECRET', json.dumps(records))

    def test_loop_observer_is_bounded_and_default_off_schedules_nothing(self):
        callbacks, records, now = [], [], [0.0]
        class FakeLoop:
            def call_later(self, delay, callback):
                callbacks.append(callback)
        loop = FakeLoop()
        headers = [(b'x-aegis-boot-diagnostic-id', b'e' * 32)]
        with patch('asyncio.get_running_loop', return_value=loop):
            off = BootTimingDiagnostic(clock=lambda: now[0], sink=records.append)
            off.begin(headers).finish('submitted')
            self.assertEqual(callbacks, [])
            controller = BootTimingDiagnostic(enabled=lambda: True, clock=lambda: now[0], sink=records.append)
            trace = controller.begin(headers)
            now[0] = 62
            callbacks.pop(0)()
            now[0] = 64
            trace.finish('submitted')
            self.assertEqual(records[0]['loopLagMs'], 12)
            self.assertEqual(records[0]['loopLagSampleAgeMs'], 2)
            now[0] = 300_000
            callbacks.pop(0)()
            self.assertEqual(callbacks, [])
            self.assertFalse(controller.sampling)

    def test_slow_or_broken_output_does_not_block_response_path(self):
        from aegis_engine.boot_timing_diagnostic import _records
        entered, release = threading.Event(), threading.Event()
        def slow_logger(*args):
            entered.set()
            release.wait(2)
            raise RuntimeError('SECRET')
        with patch.dict(os.environ, {'AEGIS_BOOT_TIMING_DIAGNOSTIC': 'true'}):
            with patch('os.write', side_effect=slow_logger):
                try:
                    self.assertEqual(self.exercise().status_code, 200)
                    self.assertTrue(entered.wait(1))
                    self.assertEqual(self.exercise().status_code, 200)
                finally:
                    release.set()
                    _records.join()

    def test_diagnostic_output_cannot_hold_the_application_logging_handler_lock(self):
        from aegis_engine.boot_timing_diagnostic import _records
        entered, release, ordinary = threading.Event(), threading.Event(), threading.Event()
        class SlowHandler(logging.Handler):
            def emit(self, record):
                if 'boot_timing' in record.getMessage():
                    entered.set()
                    release.wait(2)
                else:
                    ordinary.set()
        logger = logging.getLogger('LocalEventAPI')
        old_handlers, old_level, old_propagate = logger.handlers[:], logger.level, logger.propagate
        logger.handlers = [SlowHandler()]
        logger.setLevel(logging.INFO)
        logger.propagate = False
        def slow_write(*args):
            entered.set()
            release.wait(2)
            return len(args[-1])
        try:
            with patch.dict(os.environ, {'AEGIS_BOOT_TIMING_DIAGNOSTIC': 'true'}):
                with patch('os.write', side_effect=slow_write):
                    self.assertEqual(self.exercise().status_code, 200)
                    self.assertTrue(entered.wait(1))
                    application_log = threading.Thread(target=lambda: logger.info('ordinary application log'))
                    application_log.start()
                    try:
                        self.assertTrue(ordinary.wait(0.05), 'diagnostic held shared logging handler lock')
                    finally:
                        release.set()
                        application_log.join(2)
                        _records.join()
        finally:
            logger.handlers, logger.level, logger.propagate = old_handlers, old_level, old_propagate
