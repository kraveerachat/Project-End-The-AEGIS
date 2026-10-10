"""Distinct uid/gid verification of the local CUT channel using an unprivileged user namespace (no root, no host change).

Skipped where the host cannot create a multi-id user namespace (no ``unshare --map-users``, no ``/etc/subuid`` range).
The checks themselves live in ``local_cut_identity_harness.py`` and fail the subprocess with the list of broken properties.
"""

from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

import pytest

HARNESS = Path(__file__).resolve().parent / "local_cut_identity_harness.py"
ROOT = Path(__file__).resolve().parent.parent


def _namespace_available() -> bool:
    if shutil.which("unshare") is None or not Path("/etc/subuid").exists():
        return False
    probe = subprocess.run(
        ["unshare", "--user", "--map-users=auto", "--map-groups=auto", "--map-root-user", "true"],
        capture_output=True, timeout=20,
    )
    return probe.returncode == 0


pytestmark = pytest.mark.skipif(not sys.platform.startswith("linux") or not _namespace_available(),
                                reason="multi-id user namespace is unavailable")


def test_real_distinct_identities_enforce_the_cut_boundary():
    completed = subprocess.run(
        ["unshare", "--user", "--map-users=auto", "--map-groups=auto", "--map-root-user",
         sys.executable, "-B", str(HARNESS), str(ROOT)],
        capture_output=True, text=True, timeout=120, env={"PYTHONDONTWRITEBYTECODE": "1", "PATH": "/usr/bin:/bin"},
    )
    assert completed.returncode == 0, completed.stdout + completed.stderr
