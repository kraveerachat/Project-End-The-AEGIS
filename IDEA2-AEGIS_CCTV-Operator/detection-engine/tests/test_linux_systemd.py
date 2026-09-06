from __future__ import annotations

import re
import unittest
from pathlib import Path


ENGINE_ROOT = Path(__file__).resolve().parents[1]
LINUX_ROOT = ENGINE_ROOT / "linux"


class LinuxSystemdSourceTests(unittest.TestCase):
    def read(self, name: str) -> str:
        return (LINUX_ROOT / name).read_text(encoding="utf-8")

    def test_complete_linux_operator_script_set_is_present(self) -> None:
        expected = {
            "install_systemd.sh",
            "repair_systemd.sh",
            "status_systemd.sh",
            "uninstall_systemd.sh",
        }
        self.assertTrue(expected.issubset({path.name for path in LINUX_ROOT.glob("*.sh")}))

    def test_installer_is_machine_configurable_and_not_arch_user_specific(self) -> None:
        installer = self.read("install_systemd.sh")
        for option in (
            "--config",
            "--tunnel-host",
            "--identity-file",
            "--known-hosts-file",
            "--local-forward-port",
            "--remote-port",
            "--engine-port",
        ):
            self.assertIn(option, installer)
        joined = "\n".join(path.read_text(encoding="utf-8") for path in LINUX_ROOT.rglob("*.*"))
        self.assertNotIn("kittipat", joined)
        self.assertNotIn("pubpup2006p", joined)
        self.assertNotIn("CAM-02", joined)

    def test_runtime_copy_excludes_local_and_secret_material(self) -> None:
        installer = self.read("install_systemd.sh")
        copy_block = installer.split("# Copy durable source only", 1)[1].split(
            "install -m 600", 1
        )[0]
        for excluded in (
            "./.env",
            "./.venv",
            "./segments",
            "./snapshots",
            "./models",
            "./identity",
            "./.git",
        ):
            self.assertIn(excluded, copy_block)

    def test_private_key_and_host_trust_are_hardened(self) -> None:
        installer = self.read("install_systemd.sh")
        self.assertIn("Private key must not grant group or other permissions", installer)
        self.assertIn('install -m 600 "$identity_file"', installer)
        self.assertIn('install -m 600 "$known_hosts_file"', installer)
        self.assertIn('ssh-keygen -F "$tunnel_server"', installer)
        self.assertIn("StrictHostKeyChecking=yes", installer)
        self.assertNotIn("StrictHostKeyChecking=no", installer)

    def test_installer_proves_both_forwards_before_persistent_units(self) -> None:
        installer = self.read("install_systemd.sh")
        probe = installer.index("# Prove the exact key")
        unit_install = installer.index('sudo install -o root -g root -m 644 "$engine_unit"')
        self.assertLess(probe, unit_install)
        self.assertIn('-L "127.0.0.1:${local_forward_port}', installer)
        self.assertIn('-R "${remote_bind_address}:${remote_port}', installer)
        self.assertIn("ExitOnForwardFailure=yes", installer)
        self.assertIn('"http://127.0.0.1:${local_forward_port}/healthz"', installer)

    def test_units_are_boot_enabled_restartable_and_least_privilege(self) -> None:
        installer = self.read("install_systemd.sh")
        for field in (
            "User=${target_user}",
            "SupplementaryGroups=video",
            "Restart=always",
            "NoNewPrivileges=true",
            "WantedBy=multi-user.target",
            'sudo systemctl enable "$TUNNEL_SERVICE" "$ENGINE_SERVICE"',
        ):
            self.assertIn(field, installer)
        self.assertNotIn("User=root", installer)

    def test_required_monitor_settings_are_checked_without_printing_values(self) -> None:
        installer = self.read("install_systemd.sh")
        for key in (
            "AEGIS_MONITOR_API_BASE",
            "AEGIS_DETECTION_ENGINE_API_KEY",
            "AEGIS_STREAM_PUBLIC_URL",
        ):
            self.assertIn(key, installer)
        self.assertIn("values were not printed", installer)

    def test_selected_ai_backend_is_validated_before_units_are_installed(self) -> None:
        installer = self.read("install_systemd.sh")
        validation = installer.index("build_configured_recognizer(config)")
        unit_install = installer.index('sudo install -o root -g root -m 644 "$engine_unit"')
        self.assertLess(validation, unit_install)
        self.assertIn('requirements-ai.txt', installer)

    def test_receipt_contains_no_secret_values(self) -> None:
        installer = self.read("install_systemd.sh")
        receipt = installer.split('data = {', 1)[1].split('path.write_text', 1)[0]
        self.assertNotIn("DETECTION_ENGINE_API_KEY", receipt)
        self.assertNotIn("TELEGRAM", receipt)
        self.assertIn('"identityFileName"', receipt)
        self.assertNotIn('"identityFile"', receipt)

    def test_uninstall_preserves_runtime_and_key_material(self) -> None:
        uninstall = self.read("uninstall_systemd.sh")
        self.assertIn("Preserved runtime", uninstall)
        self.assertIn("SSH material were not deleted", uninstall)
        self.assertNotIn('rm -rf "$runtime_root"', uninstall)

    def test_repair_stops_running_ports_and_restores_services_on_failure(self) -> None:
        repair = self.read("repair_systemd.sh")
        self.assertIn('sudo systemctl stop "$engine_service" "$tunnel_service"', repair)
        self.assertIn("restore_previous_state", repair)
        self.assertIn("Repair failed; restoring", repair)
        self.assertIn('"$script_dir/install_systemd.sh" "${args[@]}"', repair)

        installer = self.read("install_systemd.sh")
        self.assertIn('if [[ "$source_root" != "$runtime_app" ]]', installer)

    def test_no_private_key_payload_is_present_under_linux_source(self) -> None:
        private_key_marker = re.compile(r"BEGIN (?:OPENSSH|RSA|EC) PRIVATE KEY")
        for path in LINUX_ROOT.rglob("*"):
            if path.is_file():
                self.assertIsNone(private_key_marker.search(path.read_text(encoding="utf-8")))


if __name__ == "__main__":
    unittest.main()
