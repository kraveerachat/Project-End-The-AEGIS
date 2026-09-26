from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import unittest


ENGINE_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = ENGINE_ROOT.parents[1]
MONITOR_ROOT = REPO_ROOT / "IDEA2-AEGIS_Monitor"
ENGINE_FIXTURE = MONITOR_ROOT / "tests" / "fixtures" / "machineAEngineHarness.py"


class MachineARuntimeContractTests(unittest.TestCase):
    def test_protocol_real_engine_process_is_idle_until_stream_demand_and_releases_final_viewer(self):
        completed = subprocess.run(
            [sys.executable, str(ENGINE_FIXTURE), "--contract-probe"],
            cwd=ENGINE_ROOT,
            env={**os.environ, "AEGIS_ENGINE_ROOT": str(ENGINE_ROOT)},
            check=True,
            capture_output=True,
            text=True,
            timeout=30,
        )
        evidence = json.loads(completed.stdout.strip().splitlines()[-1])
        self.assertEqual(
            {
                "startupDemanded": False,
                "startupViewers": 0,
                "streamDemanded": True,
                "streamViewers": 1,
                "finalDemanded": False,
                "finalViewers": 0,
                "protectedPortUsed": False,
            },
            evidence,
        )

    def test_task13_runner_is_repository_native_and_does_not_claim_machine_a_installation(self):
        package = json.loads((MONITOR_ROOT / "package.json").read_text(encoding="utf-8"))
        self.assertEqual(
            "node --test tests/machineANoPowerShellIntegration.test.mjs",
            package["scripts"]["test:machine-a-integration"],
        )
        self.assertNotIn("18078", package["scripts"]["test:machine-a-integration"])
        self.assertNotIn("install_identity_agent", package["scripts"]["test:machine-a-integration"])


if __name__ == "__main__":
    unittest.main()
