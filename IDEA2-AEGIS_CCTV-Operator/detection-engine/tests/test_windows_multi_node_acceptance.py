from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ENGINE_ROOT = Path(__file__).resolve().parents[1]
MULTI = ENGINE_ROOT / "windows" / "multi-node"
COLLECTOR = MULTI / "collect_acceptance_snapshot.ps1"
VERIFIER = MULTI / "verify_acceptance_bundle.py"
CHECKLIST = MULTI / "ACCEPTANCE.md"


class WindowsMultiNodeAcceptancePreparationTests(unittest.TestCase):
    def read(self, path: Path) -> str:
        self.assertTrue(path.is_file(), f"missing {path}")
        return path.read_text(encoding="utf-8")

    def test_collector_is_local_only_and_does_not_read_sensitive_runtime_files(self) -> None:
        source = self.read(COLLECTOR)

        self.assertIn("http://127.0.0.1:8077/health", source)
        self.assertIn("SERVER_CONTACT=NO", source)
        self.assertIn("PRODUCTION_MUTATION=NO", source)
        self.assertIn("TWINGATE_MUTATION=NO", source)
        self.assertIn("CAMERA_OPEN_BY_COLLECTOR=NO", source)
        self.assertIn("PRIVATE_KEY_READ=NO", source)
        self.assertIn("CONFIG_READ=NO", source)

        forbidden = (
            "setup_camera.py",
            "/stream.mjpg",
            "AEGIS_DETECTION_ENGINE_API_KEY",
            "machine-identity.dpapi",
            "idea2_tunnel_ed25519",
            "known_hosts",
            "Invoke-WebRequest",
            "Test-NetConnection",
            "Resolve-DnsName",
            "ssh.exe",
        )
        for token in forbidden:
            self.assertNotIn(token, source)

    def test_collector_supports_exact_acceptance_phases(self) -> None:
        source = self.read(COLLECTOR)

        for phase in (
            "pre_viewer",
            "operator_live",
            "post_operator_release",
            "operator2_live",
            "post_operator2_release",
            "post_reboot",
        ):
            self.assertIn(f"'{phase}'", source)

    def test_checklist_does_not_overclaim_account_or_event_authority(self) -> None:
        source = self.read(CHECKLIST)

        self.assertIn("Current Engine `AEGIS_CAMERA_ID` remains one static", source)
        self.assertIn("ACCOUNT_ALIAS_EVENT_ATTRIBUTION=PASS", source)
        self.assertIn("cannot be inferred from Live routing", source)
        self.assertIn("operator / CAM-01", source)
        self.assertIn("operator2 / CAM-02", source)

    def make_snapshot(self, phase: str, *, live: bool) -> dict:
        return {
            "schema_version": 1,
            "node_label": "node-b",
            "phase": phase,
            "collection_boundary": {
                "server_contact": "NO",
                "production_mutation": "NO",
                "twingate_mutation": "NO",
                "camera_open_by_collector": "NO",
                "private_key_read": "NO",
                "config_read": "NO",
                "localhost_engine_health_only": "YES",
            },
            "lifecycle": {
                "identity_agent_installed": True,
                "identity_agent_state": "Running",
                "identity_agent_start_mode": "Auto",
                "detection_tunnel_task_present": True,
                "detection_tunnel_task_state": "Running",
                "legacy_engine_task_present": True,
                "legacy_engine_task_state": "Disabled",
                "engine_hkcu_run_present": True,
            },
            "engine_health": {
                "reachable": True,
                "status": "ok" if live else "idle",
                "camera_connected": live,
                "camera_demanded": live,
                "stream_viewers": 1 if live else 0,
                "capture_fps": 12.0 if live else 0.0,
            },
        }

    def test_verifier_accepts_complete_local_lifecycle_but_keeps_remote_claims_unproven(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            paths = []

            for phase in (
                "pre_viewer",
                "operator_live",
                "post_operator_release",
                "operator2_live",
                "post_operator2_release",
                "post_reboot",
            ):
                path = root / f"{phase}.json"
                path.write_text(
                    json.dumps(self.make_snapshot(phase, live=phase.endswith("_live"))),
                    encoding="utf-8",
                )
                paths.append(path)

            proc = subprocess.run(
                [sys.executable, str(VERIFIER), *map(str, paths)],
                text=True,
                capture_output=True,
                check=False,
            )

            self.assertEqual(proc.returncode, 0, proc.stderr)
            self.assertIn("MN_P3_LOCAL_LIFECYCLE=PASS", proc.stdout)
            self.assertIn("ACCOUNT_ALIAS_ROUTING=NOT_PROVEN_BY_LOCAL_BUNDLE", proc.stdout)
            self.assertIn("CROSS_NODE_ISOLATION=NOT_PROVEN_BY_LOCAL_BUNDLE", proc.stdout)
            self.assertIn("EVENT_ALIAS_ATTRIBUTION=NOT_PROVEN_BY_LOCAL_BUNDLE", proc.stdout)

    def test_verifier_rejects_false_idle_release(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            paths = []

            for phase in (
                "pre_viewer",
                "operator_live",
                "post_operator_release",
                "operator2_live",
                "post_operator2_release",
                "post_reboot",
            ):
                live = phase.endswith("_live")
                snapshot = self.make_snapshot(phase, live=live)
                if phase == "post_operator_release":
                    snapshot["engine_health"]["camera_demanded"] = True

                path = root / f"{phase}.json"
                path.write_text(json.dumps(snapshot), encoding="utf-8")
                paths.append(path)

            proc = subprocess.run(
                [sys.executable, str(VERIFIER), *map(str, paths)],
                text=True,
                capture_output=True,
                check=False,
            )

            self.assertNotEqual(proc.returncode, 0)
            self.assertIn("MN_P3_LOCAL_LIFECYCLE=FAIL", proc.stderr)


if __name__ == "__main__":
    unittest.main()
