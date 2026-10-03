"""AEGIS IDEA3 PR11 Phase 4 — L8p: the esptool subprocess runs under its OWN frozen interpreter, never the orchestration interpreter.

Root cause (found by the L8p final preflight, before any live attempt): the owner runner passes `AEGIS_PYTHON_BIN="$PY"` (the orchestration interpreter, `aegis-idea3-core`), the handler
runs `p4-l8p-device.py` under it, and the canonical flow then launched `[sys.executable, <pinned esptool.py>, ...]`. That interpreter cannot import the pinned esptool's dependencies, so a
live run would have failed AFTER the one-shot attempt was consumed. The fix is a dedicated frozen pin (`ESPTOOL_PYTHON`) threaded through runner -> apply.sh -> `--esptool-python` ->
`load_backend` -> `HardwareDevice`/`SubprocessExecutor`, plus a read-only pre-consume gate (tested in test_pr11_phase4_l8p_owner_runner.py).

Hermetic: no /dev or serial access (guarded below), no real esptool, no network. The "esptool Python" here is a recording shell script.
"""

from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))
import test_pr11_phase4_l8_hardware_backend as HW
import test_pr11_phase4_l8p_provisioning as P

ROOT = Path(__file__).resolve().parents[1]
DEPLOY = ROOT / "deploy" / "pr11-phase4"
CANON_PATH = DEPLOY / "p4-l8-device.py"
APPLY = DEPLOY / "stages" / "L8p" / "apply.sh"

_real_open, _real_os_open = open, os.open


@pytest.fixture(autouse=True)
def _no_device_access(monkeypatch):
    """Any attempt to open a /dev/tty* node fails the test: nothing here may touch a serial device."""
    def guarded_open(file, *a, **k):
        assert not str(file).startswith("/dev/tty"), f"serial device access attempted: {file}"
        return _real_open(file, *a, **k)

    def guarded_os_open(path, *a, **k):
        assert not str(path).startswith("/dev/tty"), f"serial device access attempted: {path}"
        return _real_os_open(path, *a, **k)
    monkeypatch.setattr("builtins.open", guarded_open)
    monkeypatch.setattr(os, "open", guarded_os_open)


def load_canon():
    spec = importlib.util.spec_from_file_location("p4_l8_device_esp", str(CANON_PATH))
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture()
def pinned(tmp_path: Path):
    """A pinned PlatformIO-style tool package, an esptool 'interpreter' that RECORDS how it was launched, and the binding."""
    pkg = tmp_path / "tool-esptoolpy"
    pkg.mkdir()
    script = pkg / "esptool.py"
    script.write_text("# stand-in\n")
    (pkg / "package.json").write_text(json.dumps({"name": "tool-esptoolpy", "version": "2.41100.0"}))
    log = tmp_path / "launch.log"
    interpreter = tmp_path / "venv-esptool" / "bin" / "python"
    interpreter.parent.mkdir(parents=True)
    interpreter.write_text(f'#!/usr/bin/env bash\nprintf "%s\\n" "$0 $*" >> "{log}"\necho "Detected flash size: 4MB"\n')
    interpreter.chmod(0o755)
    return {"script": str(script), "interpreter": str(interpreter), "log": log, "binding": {"serial_port": HW.BOUND_PORT}, "work": tmp_path / "work"}


def build(mod, pin, *, esptool_python="__pinned__", executor=None):
    pin["work"].mkdir(exist_ok=True)
    return mod.load_backend(
        "hardware", None, pin["work"] / "flash", binding=pin["binding"], live_authorized=True, executor=executor, esptool_script=pin["script"],
        esptool_python=pin["interpreter"] if esptool_python == "__pinned__" else esptool_python, work_dir=pin["work"], boot_verifier=lambda: "PASS")


# ── the exact original issue: orchestration Python differs from esptool Python ─────────────────────────────────────────────────────────────────

def test_hardware_argv_is_exactly_the_pinned_esptool_python_then_the_pinned_script(pinned) -> None:
    mod = load_canon()
    device = build(mod, pinned)
    assert device.launcher == [pinned["interpreter"], pinned["script"]]
    assert device.argv_prefix[:2] == [pinned["interpreter"], pinned["script"]]
    assert device.launcher[0] != sys.executable, "the orchestration interpreter must never launch esptool"


def test_executor_launcher_equals_the_hardware_device_launcher(pinned) -> None:
    mod = load_canon()
    device = build(mod, pinned)
    executor = device._runner
    assert isinstance(executor, mod.SubprocessExecutor)
    assert executor.launcher == device.launcher == [pinned["interpreter"], pinned["script"]]


def test_the_esptool_subprocess_uses_only_the_explicit_interpreter_and_never_the_orchestration_one(pinned) -> None:
    """Regression: with orchestration Python != esptool Python, the real subprocess is the pinned esptool interpreter and nothing else."""
    mod = load_canon()
    device = build(mod, pinned)
    result = device._runner.run(device.build_argv("flash_id", after="no_reset"), timeout=30)
    assert result.returncode == 0 and "Detected flash size" in result.stdout
    launches = pinned["log"].read_text().splitlines()
    assert len(launches) == 1 and launches[0].startswith(f'{pinned["interpreter"]} {pinned["script"]} --chip '), launches
    assert sys.executable not in launches[0]
    assert "--port " + HW.BOUND_PORT in launches[0] and launches[0].endswith(" --after no_reset flash_id")


def test_a_mismatched_executor_and_device_launcher_is_refused(pinned, tmp_path: Path) -> None:
    mod = load_canon()
    other = tmp_path / "other" / "python"
    other.parent.mkdir()
    other.write_text("#!/bin/sh\nexit 0\n")
    other.chmod(0o755)
    with pytest.raises(mod.L8Error, match="launcher does not match"):
        build(mod, pinned, executor=mod.SubprocessExecutor([str(other), pinned["script"]]))
    # an executor built from the SAME interpreter is accepted
    assert build(mod, pinned, executor=mod.SubprocessExecutor([pinned["interpreter"], pinned["script"]])).launcher[0] == pinned["interpreter"]


def test_the_legacy_l8_default_is_unchanged_when_no_esptool_python_is_given(pinned) -> None:
    mod = load_canon()
    device = build(mod, pinned, esptool_python=None)
    assert device.launcher == [sys.executable, pinned["script"]] and device._runner.launcher == device.launcher


@pytest.mark.parametrize("bad,reason", [
    ("python", "absolute"), ("relative/venv/bin/python", "absolute"), ("/nonexistent/venv/bin/python", "not an executable file"),
    ("/bin/true", "python interpreter"), ("/", "python interpreter"),
])
def test_an_unusable_esptool_python_value_is_refused_without_fallback(pinned, bad: str, reason: str) -> None:
    mod = load_canon()
    with pytest.raises(mod.L8Error, match=reason):
        build(mod, pinned, esptool_python=bad)
    assert not pinned["log"].exists(), "nothing was launched"


def test_a_non_executable_esptool_python_is_refused(pinned, tmp_path: Path) -> None:
    mod = load_canon()
    noexec = tmp_path / "python-noexec"
    noexec.write_text("#!/bin/sh\n")
    noexec.chmod(0o644)
    with pytest.raises(mod.L8Error, match="not an executable file"):
        build(mod, pinned, esptool_python=str(noexec))


def test_forbidden_esptool_commands_stay_refused_under_the_explicit_interpreter(pinned) -> None:
    mod = load_canon()
    device = build(mod, pinned)
    for sub in ("erase_flash", "erase_region", "write_mem", "read_mem", "get_security_info", "run"):
        with pytest.raises(mod.L8Error):
            device._runner.run(device.build_argv(sub, after="no_reset"))
    assert not pinned["log"].exists(), "no forbidden command reached the interpreter"


# ── L8p enforces the explicit interpreter; L8 does not change ──────────────────────────────────────────────────────────────────────────────

def test_the_l8p_profile_requires_the_explicit_interpreter_and_l8_does_not() -> None:
    mod = load_canon()
    assert mod.L8_PROFILE.require_explicit_tool_python is False
    l8p = P.load_module()
    assert l8p.build_profile().require_explicit_tool_python is True


def test_l8p_hardware_without_the_frozen_interpreter_fails_before_any_device_command(tmp_path: Path) -> None:
    mod = P.load_module()
    env = P.stage_env(tmp_path, hardware=True)
    ex = P.Ex(HW.load_mod(), work_dir=env["AEGIS_L8P_WORK_DIR"])
    args = P.hw_args(env)
    args.esptool_python = None
    with pytest.raises(mod.L8Error, match="esptool-python"):
        mod.provision(args, executor=ex, boot_verifier=lambda: "PASS")
    assert ex.calls == [], "no device command (flash_id/write/read/reset) was issued"
    args.esptool_python = ""
    with pytest.raises(mod.L8Error, match="esptool-python"):
        mod.provision(args, executor=ex, boot_verifier=lambda: "PASS")
    assert ex.calls == []


def test_l8p_hardware_with_the_frozen_interpreter_still_completes_on_the_canonical_flow(tmp_path: Path) -> None:
    _mod, _env, ex, rc = P.run_hw(tmp_path)
    assert rc == 0, rc
    assert [c[c.index("--after") + 1] for c in ex.calls].count("hard_reset") == 1


# ── apply.sh: hardware mode demands the distinct interpreter; fixture mode is unchanged ────────────────────────────────────────────────────

def test_apply_sh_hardware_mode_requires_the_distinct_esptool_python_before_anything(tmp_path: Path) -> None:
    env = P.stage_env(tmp_path, hardware=True, AEGIS_L8P_LIVE_AUTHORIZED="YES", AEGIS_L8P_ESPTOOL=HW.FAKE_ESPTOOL)
    env.pop("AEGIS_L8P_ESPTOOL_PYTHON", None)
    res = subprocess.run(["bash", str(APPLY)], text=True, capture_output=True, check=False, env=env)
    assert res.returncode != 0 and "AEGIS_L8P_ESPTOOL_PYTHON required" in res.stderr
    assert not Path(env["AEGIS_L8P_WORK_DIR"]).exists(), "nothing was created"


def test_apply_sh_passes_the_distinct_interpreter_and_keeps_aegis_python_bin_separate() -> None:
    code = "\n".join(l for l in APPLY.read_text().splitlines() if not l.lstrip().startswith("#"))
    assert '--esptool-python "${AEGIS_L8P_ESPTOOL_PYTHON:-}"' in code
    assert 'PYTHON_BIN="${AEGIS_PYTHON_BIN:-python3}"' in code and '"$PYTHON_BIN" "$P4_HERE/p4-l8p-device.py" provision' in code
    assert "AEGIS_L8P_ESPTOOL_PYTHON" not in code.split('PYTHON_BIN="${AEGIS_PYTHON_BIN')[1].split("provision")[0], "the esptool interpreter must not become the orchestration interpreter"


def test_fixture_mode_is_unchanged_and_needs_no_esptool_python(tmp_path: Path) -> None:
    env = P.stage_env(tmp_path)
    assert "AEGIS_L8P_ESPTOOL_PYTHON" not in env
    assert P.run("apply.sh", env).returncode == 0
