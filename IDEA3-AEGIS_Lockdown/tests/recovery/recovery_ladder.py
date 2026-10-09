"""A prepared operator-side ladder (up to and including PROBE_POST_ISOLATE) produced by the REAL stage functions against a scripted fake Core, for the shell-level D4 tests."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import test_recovery_stage as ts  # noqa: E402

from aegis_soc import recovery_stage as stage  # noqa: E402


def steps_to_post_isolate(tmp_path: Path) -> str:
    steps = tmp_path / "steps"
    steps.mkdir()
    core = ts.Core()
    for fn in (stage.step_status, stage.step_probe_pre, stage.step_isolate, stage.step_probe_post_isolate):
        fn(core, str(steps))
    return str(steps)
