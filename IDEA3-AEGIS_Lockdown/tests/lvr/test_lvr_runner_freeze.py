"""Tests for LVR runner freeze and verification tooling."""
from __future__ import annotations

import json
import os
import stat
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
FREEZE_TOOL = REPO_ROOT / "deploy/pr11-phase4/lvr-acceptance/lvr_runner_freeze.py"
OWNER_TEMPLATE = REPO_ROOT / "deploy/pr11-phase4/owner-run/run-lvr-owner.sh"

sys.path.insert(0, str(FREEZE_TOOL.parent))
import lvr_runner_freeze  # noqa: E402


def run_cmd(cmd: str, cwd: Path | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(cmd, shell=True, capture_output=True, text=True, cwd=cwd)


@pytest.fixture
def git_repo_with_template(tmp_path: Path) -> tuple[Path, str]:
    repo = tmp_path / "repo"
    repo.mkdir()
    template_dest = repo / lvr_runner_freeze.TEMPLATE_REL
    template_dest.parent.mkdir(parents=True)
    template_dest.write_text(OWNER_TEMPLATE.read_text(encoding="utf-8"), encoding="utf-8")

    run_cmd("git init -q", cwd=repo)
    run_cmd("git config user.email 'test@example.com'", cwd=repo)
    run_cmd("git config user.name 'Tester'", cwd=repo)
    run_cmd("git add -A && git commit -qm 'commit template'", cwd=repo)
    commit = run_cmd("git rev-parse HEAD", cwd=repo).stdout.strip()
    return repo, commit


@pytest.fixture
def valid_pins(git_repo_with_template: tuple[Path, str]) -> dict[str, str]:
    _, commit = git_repo_with_template
    return {
        "EXPECTED_MAIN": commit,
        "OPERATOR_USER": "testuser",
        "OPERATOR_UID": "1000",
        "RECOVERY_EXECUTION_MAIN": commit,
        "CONTROL_SNAPSHOT_DIR": "/tmp/control/snapshots",
        "CONTROL_MANIFEST_SHA256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        "AUDIT_DB": "/var/lib/aegis/audit.db",
        "STATUS_PATH": "/run/aegis/status.json",
        "RECOVERY_MARKER": "/var/run/aegis/recovery.marker",
        "EVIDENCE_ROOT": "/var/log/aegis/evidence",
        "REPO": "/tmp/repo",
        "PY": "/usr/bin/python3",
    }


def test_freeze_and_verify_success(git_repo_with_template: tuple[Path, str], valid_pins: dict[str, str], tmp_path: Path) -> None:
    repo, commit = git_repo_with_template
    out_file = tmp_path / "frozen-runner.sh"

    # Freeze without root ownership enforcement (in test environment)
    res = lvr_runner_freeze.freeze(repo, commit, valid_pins, out_file, owner_uid=None)
    assert res["RUNNER_TEMPLATE_AUTHORITY"] == "PASS"
    assert res["RUNNER_ONLY_APPROVED_PINS_CHANGED"] == "PASS"
    assert len(res["RUNNER_SHA256"]) == 64

    # File properties: mode 0555, non-writable
    st = out_file.stat()
    assert stat.S_IMODE(st.st_mode) == 0o555
    assert not (st.st_mode & 0o222)

    # Verify existing file
    v_res = lvr_runner_freeze.verify(repo, commit, out_file, owner_uid=None)
    assert v_res["RUNNER_SHA256"] == res["RUNNER_SHA256"]


def test_freeze_fails_if_destination_exists(git_repo_with_template: tuple[Path, str], valid_pins: dict[str, str], tmp_path: Path) -> None:
    repo, commit = git_repo_with_template
    out_file = tmp_path / "frozen-runner.sh"
    out_file.write_text("existing")

    with pytest.raises(lvr_runner_freeze.FreezeError, match="DESTINATION_ALREADY_EXISTS"):
        lvr_runner_freeze.freeze(repo, commit, valid_pins, out_file, owner_uid=None)


def test_verify_fails_if_non_pin_bytes_altered(git_repo_with_template: tuple[Path, str], valid_pins: dict[str, str], tmp_path: Path) -> None:
    repo, commit = git_repo_with_template
    out_file = tmp_path / "frozen-runner.sh"
    lvr_runner_freeze.freeze(repo, commit, valid_pins, out_file, owner_uid=None)

    # Make mutable temporarily and tamper with non-pin line
    out_file.chmod(0o755)
    text = out_file.read_text(encoding="utf-8")
    assert "set -Eeuo pipefail" in text
    tampered = text.replace("set -Eeuo pipefail", "set -uo pipefail")
    out_file.write_text(tampered, encoding="utf-8")
    out_file.chmod(0o555)

    with pytest.raises(lvr_runner_freeze.FreezeError, match="NON_PIN_BYTES_DIFFER_FROM_THE_REVIEWED_TEMPLATE"):
        lvr_runner_freeze.verify(repo, commit, out_file, owner_uid=None)


def test_verify_fails_if_expected_main_does_not_match(git_repo_with_template: tuple[Path, str], valid_pins: dict[str, str], tmp_path: Path) -> None:
    repo, commit = git_repo_with_template
    other_commit = "1" * 40
    valid_pins["EXPECTED_MAIN"] = other_commit
    template = lvr_runner_freeze.read_template(repo, commit)
    rendered = lvr_runner_freeze.render(template, valid_pins)
    out_file = tmp_path / "frozen-runner.sh"
    out_file.write_text(rendered, encoding="utf-8")
    out_file.chmod(0o555)

    with pytest.raises(lvr_runner_freeze.FreezeError, match="FROZEN_EXPECTED_MAIN_IS_NOT_THE_REVIEWED_MAIN"):
        lvr_runner_freeze.verify(repo, commit, out_file, owner_uid=None)


def test_load_pins_rejections(valid_pins: dict[str, str]) -> None:
    # Not JSON
    with pytest.raises(lvr_runner_freeze.FreezeError, match="PINS_NOT_JSON"):
        lvr_runner_freeze.load_pins("not-json")

    # Not string object
    with pytest.raises(lvr_runner_freeze.FreezeError, match="PINS_NOT_A_STRING_OBJECT"):
        lvr_runner_freeze.load_pins(json.dumps([1, 2, 3]))
    with pytest.raises(lvr_runner_freeze.FreezeError, match="PINS_NOT_A_STRING_OBJECT"):
        lvr_runner_freeze.load_pins(json.dumps({"EXPECTED_MAIN": 123}))

    # Unknown pin
    bad_unknown = dict(valid_pins)
    bad_unknown["UNKNOWN_EXTRA"] = "val"
    with pytest.raises(lvr_runner_freeze.FreezeError, match="UNKNOWN_PIN:UNKNOWN_EXTRA"):
        lvr_runner_freeze.load_pins(json.dumps(bad_unknown))

    # Missing pin
    bad_missing = dict(valid_pins)
    del bad_missing["REPO"]
    with pytest.raises(lvr_runner_freeze.FreezeError, match="MISSING_PIN:REPO"):
        lvr_runner_freeze.load_pins(json.dumps(bad_missing))

    # Duplicate pin
    raw_dup = '{"EXPECTED_MAIN": "abc", "EXPECTED_MAIN": "def"}'
    with pytest.raises(lvr_runner_freeze.FreezeError, match="DUPLICATE_PIN"):
        lvr_runner_freeze.load_pins(raw_dup)

    # Pin retains PIN_ placeholder
    bad_ph = dict(valid_pins)
    bad_ph["OPERATOR_USER"] = "PIN_OPERATOR_USER"
    with pytest.raises(lvr_runner_freeze.FreezeError, match="PIN_VALUE_REJECTED:OPERATOR_USER"):
        lvr_runner_freeze.load_pins(json.dumps(bad_ph))


@pytest.mark.parametrize("key,val", [
    ("EXPECTED_MAIN", "not-a-sha"),
    ("EXPECTED_MAIN", "12345"),
    ("OPERATOR_USER", "123user"),
    ("OPERATOR_USER", "user with space"),
    ("OPERATOR_UID", "0"),
    ("OPERATOR_UID", "-1"),
    ("OPERATOR_UID", "not_num"),
    ("CONTROL_MANIFEST_SHA256", "tooshort"),
    ("CONTROL_SNAPSHOT_DIR", "relative/path"),
    ("CONTROL_SNAPSHOT_DIR", "/path/with/../traversal"),
    ("CONTROL_SNAPSHOT_DIR", "/path//double_slash"),
    ("CONTROL_SNAPSHOT_DIR", "/trailing/slash/"),
])
def test_pin_value_validation(valid_pins: dict[str, str], key: str, val: str) -> None:
    bad = dict(valid_pins)
    bad[key] = val
    with pytest.raises(lvr_runner_freeze.FreezeError, match=f"PIN_VALUE_REJECTED:{key}"):
        lvr_runner_freeze.load_pins(json.dumps(bad))


def test_cli_freeze_and_verify(git_repo_with_template: tuple[Path, str], valid_pins: dict[str, str], tmp_path: Path) -> None:
    repo, commit = git_repo_with_template
    pins_file = tmp_path / "pins.json"
    pins_file.write_text(json.dumps(valid_pins), encoding="utf-8")
    out_file = tmp_path / "cli-frozen.sh"

    # CLI freeze (without --root-owned)
    freeze_cmd = f'python3 "{FREEZE_TOOL}" freeze --repo "{repo}" --main "{commit}" --pins "{pins_file}" --out "{out_file}"'
    res = run_cmd(freeze_cmd)
    assert res.returncode == 0
    assert "RUNNER_TEMPLATE_AUTHORITY=PASS" in res.stdout
    assert "RUNNER_SHA256=" in res.stdout

    # CLI verify with --skip-ownership
    verify_cmd = f'python3 "{FREEZE_TOOL}" verify --repo "{repo}" --main "{commit}" --runner "{out_file}" --skip-ownership'
    v_res = run_cmd(verify_cmd)
    assert v_res.returncode == 0
    assert "RUNNER_TEMPLATE_AUTHORITY=PASS" in v_res.stdout
    assert "RUNNER_ONLY_APPROVED_PINS_CHANGED=PASS" in v_res.stdout
    assert "RUNNER_SHA256=" in v_res.stdout

    # CLI verify failing on bad main
    bad_verify_cmd = f'python3 "{FREEZE_TOOL}" verify --repo "{repo}" --main "0000000000000000000000000000000000000000" --runner "{out_file}" --skip-ownership'
    bad_res = run_cmd(bad_verify_cmd)
    assert bad_res.returncode == 1
    assert "LVR_RUNNER_FREEZE=FAIL" in bad_res.stderr
