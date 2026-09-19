import pathlib
import sys
import threading
import unittest


ENGINE_ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(ENGINE_ROOT) not in sys.path:
    sys.path.insert(0, str(ENGINE_ROOT))

from aegis_identity_agent.windows_service import (
    IdentityAgentServiceHost,
    SERVICE_ACCOUNT,
    SERVICE_NAME,
)


class AgentWindowsServiceTests(unittest.TestCase):
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

    def test_installer_uses_isolated_runtime_exact_account_and_safe_copy_contract(self):
        script = (ENGINE_ROOT / "windows" / "identity-agent" / "install_identity_agent.ps1").read_text(encoding="utf-8")
        for required in (
            "AEGISIdentityAgent", "NT SERVICE\\AEGISIdentityAgent", "ProgramFiles", "ProgramData",
            "requirements-identity-agent-windows.txt", "python.exe", "start= auto", "sidtype",
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
