import unittest

from aegis_engine.config import EngineConfig
from aegis_engine.engine import DetectionEngine, EngineComponents


class FakeAPI:
    def __init__(self, events):
        self.events = events

    def start(self):
        self.events.append("api:start")

    def stop(self):
        self.events.append("api:stop")

    def join(self, timeout=None):
        self.events.append("api:join")

    def publish_event(self, _event):
        pass


class FakeWorker:
    def __init__(self, name, events, fail=False):
        self.name = name
        self.events = events
        self.fail = fail
        self.started = False

    def start(self):
        self.events.append(f"{self.name}:start")
        if self.fail:
            raise OSError("device initialization failed")
        self.started = True

    def join(self, timeout=None):
        self.events.append(f"{self.name}:join")
        self.started = False

    def is_alive(self):
        return self.started


class NullMonitor:
    def post_detection(self, **_kwargs):
        pass


class NullAlerts:
    def submit(self, *_args):
        pass


def component_factory(events, *, fail_second=False):
    def build(_context, _recognizer):
        first = FakeWorker("capture", events)
        second = FakeWorker("recorder", events, fail=fail_second)
        return EngineComponents(
            monitor=NullMonitor(),
            api=FakeAPI(events),
            alerts=NullAlerts(),
            workers=[first, second],
            shutdown_order=[first, second],
        )

    return build


class DetectionEngineLifecycleTests(unittest.TestCase):
    def test_runtime_starts_without_nas_and_shuts_down_cleanly(self):
        events = []
        engine = DetectionEngine(
            config=EngineConfig(nas_enabled=False),
            component_factory=component_factory(events),
        )

        engine.start()
        engine.stop()

        self.assertEqual(events[:3], ["api:start", "capture:start", "recorder:start"])
        self.assertIn("capture:join", events)
        self.assertIn("recorder:join", events)
        self.assertEqual(events[-2:], ["api:stop", "api:join"])

    def test_partial_startup_rolls_back_with_component_name(self):
        events = []
        engine = DetectionEngine(
            config=EngineConfig(nas_enabled=False),
            component_factory=component_factory(events, fail_second=True),
        )

        with self.assertRaisesRegex(
            RuntimeError, "startup failed while starting recorder: device initialization failed"
        ):
            engine.start()

        self.assertIn("capture:join", events)
        self.assertIn("recorder:join", events)
        self.assertEqual(events[-2:], ["api:stop", "api:join"])


if __name__ == "__main__":
    unittest.main()
