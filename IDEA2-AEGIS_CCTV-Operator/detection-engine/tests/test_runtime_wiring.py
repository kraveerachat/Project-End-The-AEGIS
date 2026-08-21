from pathlib import Path
import re
import unittest


REPOSITORY_ROOT = Path(__file__).resolve().parents[3]


class CanonicalRuntimeWiringTests(unittest.TestCase):
    def test_compose_camera_service_builds_modular_runtime(self):
        compose = (REPOSITORY_ROOT / "docker-compose.yml").read_text(encoding="utf-8")
        camera_service = compose.split("  aegis-camera:", 1)[1].split("\nvolumes:", 1)[0]

        self.assertIn(
            "context: ./IDEA2-AEGIS_CCTV-Operator/detection-engine",
            camera_service,
        )
        self.assertNotIn("context: ./AEGIS_Camera", camera_service)
        self.assertIn("AEGIS_NAS_ENABLED: ${AEGIS_NAS_ENABLED:-false}", camera_service)
        self.assertIn("AEGIS_STREAM_PUBLIC_URL: http://aegis-camera:8077/stream.mjpg", camera_service)

    def test_modular_dockerfile_runs_canonical_entrypoint(self):
        dockerfile = (
            REPOSITORY_ROOT
            / "IDEA2-AEGIS_CCTV-Operator"
            / "detection-engine"
            / "Dockerfile"
        ).read_text(encoding="utf-8")
        self.assertIn('CMD ["python", "run.py"]', dockerfile)
        self.assertIn("ARG AEGIS_INSTALL_AI=false", dockerfile)
        self.assertIn("requirements-ai.txt", dockerfile)
        self.assertNotRegex(dockerfile, r"(?i)COPY\s+.*\.(?:pt|onnx|npz)")

    def test_docker_context_excludes_secrets_models_and_biometrics(self):
        dockerignore = (
            REPOSITORY_ROOT
            / "IDEA2-AEGIS_CCTV-Operator"
            / "detection-engine"
            / ".dockerignore"
        ).read_text(encoding="utf-8")

        for pattern in (".env", "*.pt", "*.onnx", "*.npz", "admin_photos/"):
            self.assertIn(pattern, dockerignore)

    def test_legacy_helper_contains_no_hard_coded_credentials(self):
        helper = (REPOSITORY_ROOT / "AEGIS_Camera" / "run_engine.ps1").read_text(
            encoding="utf-8"
        )
        token_assignment = re.compile(
            r'(?m)^\s*\$env:(?:AEGIS_)?TELEGRAM_BOT_TOKEN\s*=\s*["\'][^"\']+["\']'
        )
        key_assignment = re.compile(
            r'(?m)^\s*\$env:DETECTION_ENGINE_API_KEY\s*=\s*["\'][^"\']+["\']'
        )
        self.assertIsNone(token_assignment.search(helper))
        self.assertIsNone(key_assignment.search(helper))
        self.assertIn("Credential Rotation Required Before Telegram Real Testing", helper)


if __name__ == "__main__":
    unittest.main()
