"""Test-only: build a disposable status sidecar from this checkout's six allowlisted files and print its path.

Usage: build_sidecar_fixture.py <empty-work-dir>. It creates a throwaway git repository inside that directory, builds with the real
``build-status-sidecar.py`` and prints the verified package directory. Stdlib only; no network, no root, nothing outside <work-dir>.
"""

from __future__ import annotations

import importlib.util
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BUILDER = ROOT / "deploy" / "status-sidecar" / "build-status-sidecar.py"


def main(argv: list[str]) -> int:
    work = Path(argv[1]).resolve()
    repo = work / "repo"
    project = repo / "IDEA3-AEGIS_Lockdown"
    spec = importlib.util.spec_from_file_location("build_status_sidecar_fixture", BUILDER)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    for rel in module.SIDECAR_FILES:
        (project / rel).parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / rel, project / rel)
    env = {**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.invalid", "GIT_COMMITTER_NAME": "t",
           "GIT_COMMITTER_EMAIL": "t@example.invalid", "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_NOSYSTEM": "1"}
    for args in (["init", "-q"], ["add", "-A"], ["commit", "-q", "-m", "fixture"]):
        subprocess.run(["git", *args], cwd=repo, env=env, check=True, capture_output=True)
    print(module.build_sidecar(repo, work / "staging", "e2e-sidecar"))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
