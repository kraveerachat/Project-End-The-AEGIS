import pathlib
import sys
import threading
import types
import unittest
from unittest.mock import Mock, patch


ENGINE_ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(ENGINE_ROOT) not in sys.path:
    sys.path.insert(0, str(ENGINE_ROOT))

from aegis_identity_agent.windows_service import (
    IdentityAgentServiceHost,
    SERVICE_ACCOUNT,
    SERVICE_NAME,
    build_pywin32_service,
)
import run_identity_agent


class AgentWindowsServiceTests(unittest.TestCase):
    @staticmethod
    def _fake_pywin32_modules():
        class ServiceFramework:
            def __init__(self, args):
                self.args = args
                self.statuses = []

            def ReportServiceStatus(self, status, **kwargs):
                self.statuses.append((status, kwargs))

        return {
            "win32event": types.SimpleNamespace(
                CreateEvent=lambda *_args: object(),
                SetEvent=lambda _handle: None,
            ),
            "win32service": types.SimpleNamespace(
                SERVICE_STOP_PENDING=3,
                SERVICE_STOPPED=1,
            ),
            "win32serviceutil": types.SimpleNamespace(ServiceFramework=ServiceFramework),
            "winerror": types.SimpleNamespace(ERROR_SERVICE_SPECIFIC_ERROR=1066),
        }

    def test_service_maintenance_enters_dispatcher_before_executing_action(self):
        events = []
        service_class = object()
        fake_manager = types.SimpleNamespace(
            Initialize=lambda: events.append("initialize"),
            PrepareToHostSingle=lambda value: events.append(("prepare", value)),
            StartServiceCtrlDispatcher=lambda: events.append("dispatcher"),
        )

        def capture_service(_host_factory, *, maintenance_action=None):
            self.assertIsNotNone(maintenance_action)
            events.append("build")
            return service_class

        with (
            patch.dict(sys.modules, {"servicemanager": fake_manager}),
            patch.object(run_identity_agent, "build_pywin32_service", side_effect=capture_service),
            patch.object(run_identity_agent, "_dpapi_preflight") as preflight,
        ):
            result = run_identity_agent.main(
                ["--service", "--dpapi-preflight", "--preflight-output", "evidence.json"]
            )

        self.assertEqual(0, result)
        self.assertEqual(
            ["build", "initialize", ("prepare", service_class), "dispatcher"],
            events,
        )
        preflight.assert_not_called()

    def test_old_direct_maintenance_shape_is_rejected_before_action(self):
        with patch.object(run_identity_agent, "_dpapi_preflight") as preflight:
            with self.assertRaises(SystemExit):
                run_identity_agent.main(
                    ["--dpapi-preflight", "--preflight-output", "evidence.json"]
                )
        preflight.assert_not_called()

    def test_service_host_dispatches_exactly_one_maintenance_action_without_normal_surfaces(self):
        events = []
        fake_modules = self._fake_pywin32_modules()
        with patch.dict(sys.modules, fake_modules):
            service_type = build_pywin32_service(
                lambda: events.append("normal-host-created"),
                maintenance_action=lambda: events.append("maintenance"),
            )
            service = service_type([SERVICE_NAME])
            service.SvcDoRun()

        self.assertEqual(["maintenance"], events)
        self.assertEqual([], service.statuses)

    def test_normal_service_still_creates_and_runs_the_long_lived_host(self):
        host = Mock()
        host_factory = Mock(return_value=host)
        fake_modules = self._fake_pywin32_modules()
        with patch.dict(sys.modules, fake_modules):
            service_type = build_pywin32_service(host_factory)
            service = service_type([SERVICE_NAME])
            service.SvcDoRun()

        host_factory.assert_called_once_with()
        host.run.assert_called_once_with()
        self.assertEqual([], service.statuses)

    def test_each_maintenance_mode_selects_only_its_bounded_action(self):
        cases = (
            ("dpapi_preflight", "_dpapi_preflight"),
            ("provision_key", "_provision_key"),
            ("validate_key_store_acl", "_validate_key_store_acl"),
        )
        for selected, target in cases:
            with self.subTest(mode=selected):
                args = types.SimpleNamespace(
                    dpapi_preflight=False,
                    provision_key=False,
                    validate_key_store_acl=False,
                    preflight_output="evidence.json",
                )
                setattr(args, selected, True)
                with patch.object(run_identity_agent, target) as operation:
                    action = run_identity_agent._maintenance_action(args)
                    self.assertIsNotNone(action)
                    action()
                operation.assert_called_once()

    def test_failed_maintenance_action_reports_service_specific_failure(self):
        fake_modules = self._fake_pywin32_modules()
        with patch.dict(sys.modules, fake_modules):
            service_type = build_pywin32_service(
                Mock(side_effect=AssertionError("normal host must not start")),
                maintenance_action=Mock(side_effect=RuntimeError("maintenance failed")),
            )
            service = service_type([SERVICE_NAME])
            with self.assertRaisesRegex(RuntimeError, "maintenance failed"):
                service.SvcDoRun()

        self.assertEqual([], service.statuses)

    def test_service_identity_and_host_are_camera_independent(self):
        self.assertEqual("AEGISIdentityAgent", SERVICE_NAME)
        self.assertEqual(r"NT SERVICE\AEGISIdentityAgent", SERVICE_ACCOUNT)
        forbidden = {"cv2", "aegis_engine.camera_devices", "aegis_engine.stream_hub", "aegis_engine.local_api"}
        before = set(sys.modules)
        stop = threading.Event()
        ticks = []
        host = IdentityAgentServiceHost(run_once=lambda: ticks.append("tick"), stop_event=stop, interval_s=0.001)
        worker = threading.Thread(target=host.run)
        worker.start()
        while not ticks:
            pass
        host.stop()
        worker.join(timeout=1)
        self.assertFalse(worker.is_alive())
        self.assertFalse(forbidden.intersection(set(sys.modules) - before))
        self.assertEqual(0, host.camera_demand_side_effects)

    def test_transient_auth_failures_retry_with_a_bounded_backoff(self):
        stop = threading.Event()
        attempts = []

        def run_once():
            attempts.append(len(attempts) + 1)
            if len(attempts) < 3:
                raise RuntimeError("monitor unavailable")
            stop.set()

        host = IdentityAgentServiceHost(
            run_once=run_once,
            stop_event=stop,
            interval_s=0.001,
            retry_max_s=0.002,
        )
        host.run()
        self.assertEqual([1, 2, 3], attempts)
        self.assertLessEqual(host.last_retry_delay_s, 0.002)
        self.assertEqual(0, host.camera_demand_side_effects)

    def test_service_starts_browser_listener_once_and_closes_both_owned_surfaces(self):
        stop = threading.Event()
        events = []

        def run_once():
            events.append("pipe")
            stop.set()

        host = IdentityAgentServiceHost(
            run_once=run_once,
            stop_event=stop,
            interval_s=0.001,
            on_start=lambda: events.append("browser-start"),
            on_stop=lambda: events.append("close"),
        )
        host.run()
        host.stop()
        self.assertEqual(["browser-start", "pipe", "close"], events)

    def test_service_stop_interrupts_the_owned_pipe_wait(self):
        entered = threading.Event()
        release = threading.Event()

        def run_once():
            entered.set()
            release.wait(1)

        host = IdentityAgentServiceHost(
            run_once=run_once,
            interval_s=0.001,
            wait_after_success=False,
            on_stop=release.set,
        )
        worker = threading.Thread(target=host.run)
        worker.start()
        self.assertTrue(entered.wait(1))
        host.stop()
        worker.join(1)
        self.assertFalse(worker.is_alive())

    def test_installer_uses_isolated_runtime_exact_account_and_safe_copy_contract(self):
        script = (ENGINE_ROOT / "windows" / "identity-agent" / "install_identity_agent.ps1").read_text(encoding="utf-8")
        for required in (
            "AEGISIdentityAgent", "NT SERVICE\\AEGISIdentityAgent", "ProgramFiles", "ProgramData",
            "requirements-identity-agent-windows.txt", "python.exe", "sidtype",
        ):
            self.assertIn(required, script)
        for excluded in (".env", ".git", ".venv", "segments", "snapshots", "*.pt", "*.npz"):
            self.assertIn(excluded, script)
        self.assertNotIn("aegis_engine.run", script)
        self.assertNotIn("::HashData", script)
        self.assertIn("WindowsPrincipal", script)
        self.assertIn("-Filter '*.py'", script)
        self.assertNotIn("Copy-Item -LiteralPath $identitySource -Destination $InstallRoot -Recurse", script)

    def test_agent_requirements_are_exact_and_separate(self):
        lines = [
            line.strip() for line in (ENGINE_ROOT / "requirements-identity-agent-windows.txt").read_text().splitlines()
            if line.strip() and not line.startswith("#")
        ]
        self.assertEqual(
            ["cryptography==50.0.1", "requests==2.34.2", "pywin32==312"],
            lines,
        )

    def test_runner_and_service_source_have_no_engine_or_camera_imports(self):
        sources = [
            (ENGINE_ROOT / "run_identity_agent.py").read_text(encoding="utf-8"),
            (ENGINE_ROOT / "aegis_identity_agent" / "windows_service.py").read_text(encoding="utf-8"),
        ]
        joined = "\n".join(sources)
        self.assertNotIn("import cv2", joined)
        self.assertNotIn("aegis_engine", joined)
        self.assertNotIn("VideoCapture", joined)
        self.assertIn("StartServiceCtrlDispatcher", joined)
        self.assertNotIn("HandleCommandLine", joined)
        self.assertIn("--dpapi-preflight", joined)
        self.assertIn("--generate-key", joined)
        self.assertIn("--export-public-key", joined)


if __name__ == "__main__":
    unittest.main()
