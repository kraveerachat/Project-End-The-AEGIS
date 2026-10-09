"""Bounded observation only; no clock, grant, or lifecycle authority."""
from __future__ import annotations
import asyncio
import json
import math
import os
import queue
import re
import threading
import time

_PHASES = frozenset(('handler_entry', 'authentication', 'authority_clock', 'signing', 'response_submission'))
_OUTCOMES = frozenset(('submitted', 'request_rejection', 'handler_failure', 'response_failure'))


def _bounded(value):
    return round(min(value, 10_000), 2) if math.isfinite(value) and value >= 0 else None


class _Trace:
    def __init__(self, controller=None, correlation=None, start=0):
        self.controller, self.correlation, self.start = controller, correlation, start
        self.phases = {'handler_entry': 0}
        self.done = False

    def mark(self, phase):
        try:
            if self.controller and not self.done and phase in _PHASES and phase not in self.phases:
                self.phases[phase] = _bounded(self.controller.clock() - self.start)
        except Exception:
            pass

    def finish(self, outcome):
        try:
            if not self.controller or self.done or outcome not in _OUTCOMES:
                return
            self.done = True
            now = self.controller.clock()
            self.controller.sink({'event': 'boot_timing', 'role': 'engine',
                'id': self.correlation, 'outcome': outcome,
                'elapsedMs': _bounded(now - self.start), 'phasesMs': dict(self.phases),
                'loopLagMs': self.controller.lag,
                'loopLagSampleAgeMs': None if self.controller.lag_at is None else _bounded(now - self.controller.lag_at)})
        except Exception:
            pass


class BootTimingDiagnostic:
    def __init__(self, *, enabled=lambda: False, clock=lambda: time.monotonic() * 1000,
                 sink=lambda record: None):
        self.enabled, self.clock, self.sink = enabled, clock, sink
        self.started = None
        self.used = 0
        self.lock = threading.Lock()
        self.lag = self.lag_at = None
        self.sampling = False

    def begin(self, headers):
        try:
            if self.enabled() is not True:
                return _Trace()
            ids = [value for name, value in headers if name.lower() == b'x-aegis-boot-diagnostic-id']
            if len(ids) != 1 or re.fullmatch(rb'[0-9a-f]{32}', ids[0]) is None:
                return _Trace()
            now = self.clock()
            with self.lock:
                if self.started is None:
                    self.started = now
                if not math.isfinite(now) or not 0 <= now - self.started < 300_000 or self.used >= 128:
                    return _Trace()
                self.used += 1
            self._sample()
            return _Trace(self, ids[0].decode('ascii'), now)
        except Exception:
            return _Trace()

    def _sample(self):
        # One bounded loop observer, not a new await on the Boot critical path.
        try:
            if self.sampling:
                return
            self.sampling = True
            loop = asyncio.get_running_loop()
            def tick():
                try:
                    due = self.clock() + 50
                    def observe():
                        try:
                            now = self.clock()
                            self.lag, self.lag_at = _bounded(now - due), now
                            if 0 <= now - self.started < 300_000 and self.used < 128:
                                tick()
                            else:
                                self.sampling = False
                        except Exception:
                            self.sampling = False
                    loop.call_later(0.05, observe)
                except Exception:
                    self.sampling = False
            tick()
        except Exception:
            self.sampling = False


_records = queue.Queue(maxsize=128)
_writer_lock = threading.Lock()
_writer_started = False


def _enqueue(record):
    global _writer_started
    # No logger/disk/network call on the response path. Drop on queue overflow.
    with _writer_lock:
        if not _writer_started:
            def write():
                deadline = time.monotonic() + 300
                while time.monotonic() < deadline:
                    try:
                        record = _records.get(timeout=max(0.001, deadline - time.monotonic()))
                    except queue.Empty:
                        return
                    try:
                        # Never acquire the application's shared logging Handler lock.
                        line = (json.dumps(record, separators=(',', ':')) + '\n').encode('utf-8')
                        if len(line) <= 2048:
                            os.write(2, line)
                    except Exception:
                        pass
                    finally:
                        _records.task_done()
            threading.Thread(target=write, name='BootTimingDiagnostic', daemon=True).start()
            _writer_started = True
    try:
        _records.put_nowait(record)
    except queue.Full:
        pass


engine_boot_timing = BootTimingDiagnostic(
    enabled=lambda: os.environ.get('AEGIS_BOOT_TIMING_DIAGNOSTIC') == 'true', sink=_enqueue)
