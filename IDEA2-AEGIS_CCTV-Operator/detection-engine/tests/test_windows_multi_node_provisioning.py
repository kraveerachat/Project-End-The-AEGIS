from __future__ import annotations

import re
import unittest
from pathlib import Path


ENGINE_ROOT = Path(__file__).resolve().parents[1]
MULTI = ENGINE_ROOT / "windows" / "multi-node"
RUNBOOK = MULTI / "README.md"
ENGINE_ENV = MULTI / "engine.env.example"
AGENT_ENV = MULTI / "identity-agent.env.example"


class WindowsMultiNodeProvisioningTests(unittest.TestCase):
    def read(self, path: Path) -> str:
        self.assertTrue(path.is_file(), f"missing {path}")
        return path.read_text(encoding="utf-8")

    def test_runbook_preserves_node_scoped_alias_authority(self) -> None:
        source = self.read(RUNBOOK)

        for token in (
            "operator  -> CAM-01",
            "operator2 -> CAM-02",
            "exactly one physical-camera identity",
            "Do not register a second physical camera for `operator2`",
            "CROSS_NODE_CAMERA_ISOLATION=PASS",
            "STOP BEFORE SERVER REGISTRATION",
        ):
            self.assertIn(token, source)

    def test_runbook_keeps_private_identity_target_local_and_production_gated(self) -> None:
        source = self.read(RUNBOOK)

        for token in (
            "Agent DPAPI identity",
            "SSH private key",
            "Twingate configuration changes are out of scope",
            "separate owner-approved action",
            "private Agent identity stays DPAPI-protected on target",
        ):
            self.assertIn(token, source)

        for forbidden in (
            r"C:\Users\puppu",
            "NARUEBET",
            "machine-a-node",
            "physical-camera-a",
            "192.168.",
            "172.18.",
        ):
            self.assertNotIn(forbidden, source)

    def test_engine_template_has_no_real_secret_or_physical_identity(self) -> None:
        source = self.read(ENGINE_ENV)

        self.assertIn("AEGIS_NODE_ID=", source)
        self.assertIn("AEGIS_CAMERA_ID=", source)
        self.assertNotIn("AEGIS_CAMERA_ID=CAM-01", source)
        self.assertNotIn("AEGIS_CAMERA_ID=CAM-02", source)
        self.assertIn("NOT A STANDALONE INSTALLABLE .env", source)
        self.assertIn("AEGIS_CAMERA_SOURCE=", source)
        self.assertIn("AEGIS_DETECTION_ENGINE_API_KEY=", source)
        self.assertIn("Recording/NAS settings intentionally omitted", source)

        self.assertNotRegex(source, r"AEGIS_DETECTION_ENGINE_API_KEY=.+")
        self.assertNotIn("AEGIS_SEGMENT_SECONDS=", source)
        self.assertNotIn("AEGIS_NAS_HOST=", source)

    def test_agent_template_contains_only_non_secret_configuration_shape(self) -> None:
        source = self.read(AGENT_ENV)

        for key in (
            "AEGIS_AGENT_MONITOR_BASE_URL=",
            "AEGIS_AGENT_AUTH_AUDIENCE=",
            "AEGIS_AGENT_NODE_ID=",
            "AEGIS_AGENT_KEY_VERSION=",
            "AEGIS_AGENT_ENGINE_USER_SID=",
            "AEGIS_IDENTITY_BROWSER_ALLOWED_ORIGINS=",
            "AEGIS_AGENT_ENGINE_STREAM_URL=",
            "AEGIS_AGENT_CA_BUNDLE=",
        ):
            self.assertIn(key, source)

        self.assertNotIn("PRIVATE KEY", source)
        self.assertNotIn("PASSWORD=", source)
        self.assertNotIn("TOKEN=", source)

    def test_runbook_requires_target_preflight_and_real_hardware_acceptance(self) -> None:
        source = self.read(RUNBOOK)

        self.assertIn("preflight_target_node.ps1", source)
        self.assertIn("setup_camera.py --list", source)
        self.assertIn("Do not claim the target accepted until both accounts pass on real hardware", source)
        self.assertIn("REBOOT_LIFECYCLE=PASS", source)

    def test_static_engine_event_alias_is_not_confused_with_account_alias_policy(self) -> None:
        runbook = self.read(RUNBOOK)
        engine_env = self.read(ENGINE_ENV)

        self.assertIn("one static event-time logical alias per Engine process", runbook)
        self.assertIn("Do not infer dual-account event attribution from Live routing", runbook)
        self.assertIn("ACCOUNT_ALIAS_EVENT_ATTRIBUTION=PASS", runbook)

        self.assertIn("one static value per process", engine_env)
        self.assertNotIn("AEGIS_CAMERA_ID=CAM-01", engine_env)
        self.assertNotIn("AEGIS_CAMERA_ID=CAM-02", engine_env)


if __name__ == "__main__":
    unittest.main()
