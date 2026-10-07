"""L8u freeze: the frozen runner is MECHANICALLY DERIVED from the reviewed template (the EXPECTED_MAIN Git object) plus ONLY the approved pin substitutions, and it cannot be generated before LVR PASS."""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path

import pytest

import l8u_support as s

tool = s.load(s.FREEZE, "l8u_runner_freeze")
snap = s.load(s.SNAP, "l8u_control_snapshot")


def pins_for(main: str, lvr_sha: str, **override: str) -> dict[str, str]:
    pins = {
        "EXPECTED_MAIN": main, "OPERATOR_USER": "owner", "OPERATOR_UID": "1000", "CONTROL_SNAPSHOT_DIR": "/opt/x/control", "CONTROL_MANIFEST_SHA256": s.SHA["d"], "CORE_UNIT_SHA256": s.SHA["e"],
        "DEVICE_ID": "esp32-01", "DEVICE_MAC": s.MAC, "FIRMWARE_SHA256": s.SHA["f"], "L8P_EVIDENCE_FILE": "/srv/evidence/l8p/l8p-run.json", "L8P_EVIDENCE_SHA256": s.SHA["a"], "LVR_CLOSEOUT_SHA256": lvr_sha,
        "EXPECTED_STATE": "LOCKDOWN", "OBSERVE_SECONDS": "120", "REPO": "/srv/worktree", "PY": "/usr/bin/python3", "EVIDENCE_ROOT": "/srv/evidence",
    }
    pins.update(override)
    return pins


def frozen(tmp_path: Path, **override: str):
    repo, _, main = s.world(tmp_path)
    lvr_sha = hashlib.sha256((repo / s.LVR_REL).read_bytes()).hexdigest()
    pins = pins_for(main, lvr_sha, **override)
    out = tmp_path / "frozen.sh"
    return repo, main, lvr_sha, pins, out, tool.freeze(repo, main, pins, out)


def test_the_frozen_runner_is_the_reviewed_template_plus_only_the_pin_sites(tmp_path: Path) -> None:
    repo, main, lvr_sha, pins, out, results = frozen(tmp_path)
    assert results["RUNNER_TEMPLATE_AUTHORITY"] == "PASS" and results["RUNNER_ONLY_APPROVED_PINS_CHANGED"] == "PASS"
    template, frozen_lines = s.RUNNER.read_text().splitlines(), out.read_text().splitlines()
    assert len(template) == len(frozen_lines)
    changed = [i for i, (a, b) in enumerate(zip(template, frozen_lines)) if a != b]
    assert len(changed) == len(tool.PIN_SPECS) == 17  # exactly one line per approved pin site, nothing else
    assert oct(out.stat().st_mode & 0o777) == "0o555"
    assert s.git(repo, "status", "--porcelain") == ""
    assert tool.verify(repo, main, out, owner_uid=None)["RUNNER_SHA256"] == hashlib.sha256(out.read_bytes()).hexdigest()  # the Authorization names this exact digest
    assert subprocess.run(["bash", "-n", str(out)], capture_output=True).returncode == 0
    assert not re.search(r"^[A-Z0-9_]+=PIN_", out.read_text(), re.M)


def test_the_template_is_read_from_the_git_object_never_the_working_tree(tmp_path: Path) -> None:
    repo, _, main = s.world(tmp_path)
    (repo / s.TEMPLATE_REL).write_text("#!/bin/sh\necho EVIL\n")  # uncommitted edit of the template in the worktree
    lvr_sha = hashlib.sha256((repo / s.LVR_REL).read_bytes()).hexdigest()
    out = tmp_path / "frozen.sh"
    tool.freeze(repo, main, pins_for(main, lvr_sha), out)
    assert "EVIL" not in out.read_text() and out.read_text().startswith("#!/usr/bin/env bash")


def test_no_frozen_runner_before_lvr_pass(tmp_path: Path) -> None:
    repo = s.new_repo(tmp_path)
    main = s.commit(repo, {s.TEMPLATE_REL: s.RUNNER.read_text(), s.L8P_REL: s.L8P_RECEIPT}, "no LVR yet")
    with pytest.raises(tool.FreezeError, match="PREDECESSOR_NOT_SATISFIED:LVR_PASS_CLOSEOUT_MISSING"):
        tool.freeze(repo, main, pins_for(main, s.SHA["a"]), tmp_path / "frozen.sh")
    assert not (tmp_path / "frozen.sh").exists()


def test_the_lvr_closeout_pin_must_equal_the_receipt_bytes(tmp_path: Path) -> None:
    repo, _, main = s.world(tmp_path)
    with pytest.raises(tool.FreezeError, match="LVR_CLOSEOUT_SHA256_PIN_MISMATCH"):
        tool.freeze(repo, main, pins_for(main, s.SHA["a"]), tmp_path / "frozen.sh")


def test_unknown_missing_and_duplicate_pins_are_refused(tmp_path: Path) -> None:
    good = pins_for("a" * 40, s.SHA["a"])
    with pytest.raises(tool.FreezeError, match="UNKNOWN_PIN"):
        tool.load_pins(json.dumps({**good, "SNAPSHOT_OWNER_UID": "1000"}))
    with pytest.raises(tool.FreezeError, match="UNKNOWN_PIN"):
        tool.load_pins(json.dumps({**good, "SUDO": "x"}))
    missing = dict(good)
    missing.pop("DEVICE_MAC")
    with pytest.raises(tool.FreezeError, match="MISSING_PIN:DEVICE_MAC"):
        tool.load_pins(json.dumps(missing))
    with pytest.raises(tool.FreezeError, match="DUPLICATE_PIN"):
        tool.load_pins('{"EXPECTED_MAIN": "' + "a" * 40 + '", "EXPECTED_MAIN": "' + "b" * 40 + '"}')
    with pytest.raises(tool.FreezeError, match="PINS_NOT_A_STRING_OBJECT"):
        tool.load_pins(json.dumps({**good, "OPERATOR_UID": 1000}))


@pytest.mark.parametrize("name,value", [
    ("EXPECTED_STATE", "ANY"), ("EXPECTED_STATE", "lockdown"), ("OBSERVE_SECONDS", "5"), ("OBSERVE_SECONDS", "99999"), ("DEVICE_MAC", "AA:BB:CC:DD:EE:01"), ("DEVICE_MAC", "aa-bb-cc-dd-ee-01"),
    ("DEVICE_ID", "esp 32"), ("DEVICE_ID", "esp32;rm"), ("OPERATOR_UID", "0"), ("OPERATOR_USER", "Root"), ("FIRMWARE_SHA256", "abc"), ("CONTROL_SNAPSHOT_DIR", "/opt/../etc"), ("CONTROL_SNAPSHOT_DIR", "rel/path"),
    ("L8P_EVIDENCE_FILE", "/a/b\n"), ("PY", "PIN_PYTHON_BIN"), ("EVIDENCE_ROOT", "/srv/$HOME"), ("REPO", "/srv/a b"), ("EXPECTED_MAIN", "A" * 40),
])
def test_pin_values_are_strictly_validated(name: str, value: str) -> None:
    good = pins_for("a" * 40, s.SHA["a"])
    with pytest.raises(tool.FreezeError, match="PIN_VALUE_REJECTED"):
        tool.load_pins(json.dumps({**good, name: value}))


def test_a_trailing_newline_or_a_placeholder_in_a_value_is_refused_before_anything_is_written(tmp_path: Path) -> None:
    good = pins_for("a" * 40, s.SHA["a"])
    with pytest.raises(tool.FreezeError, match="PIN_VALUE_REJECTED:DEVICE_ID"):
        tool.load_pins(json.dumps({**good, "DEVICE_ID": "esp32-01\n"}))
    with pytest.raises(tool.FreezeError, match="PIN_VALUE_REJECTED"):
        tool.load_pins(json.dumps({**good, "EVIDENCE_ROOT": "/srv/PIN_EVIDENCE_ROOT"}))


def test_expected_main_pin_must_be_the_reviewed_main(tmp_path: Path) -> None:
    repo, _, main = s.world(tmp_path)
    lvr_sha = hashlib.sha256((repo / s.LVR_REL).read_bytes()).hexdigest()
    with pytest.raises(tool.FreezeError, match="EXPECTED_MAIN_PIN_IS_NOT_THE_REVIEWED_MAIN"):
        tool.freeze(repo, main, pins_for("c" * 40, lvr_sha), tmp_path / "frozen.sh")


def test_any_byte_outside_a_pin_site_is_detected(tmp_path: Path) -> None:
    repo, main, lvr_sha, pins, out, _ = frozen(tmp_path)
    text = out.read_text()
    for needle, repl in (("SNAPSHOT_OWNER_UID=0", "SNAPSHOT_OWNER_UID=1000"), ("SNAPSHOT_TRUST_ROOT=/\n", "SNAPSHOT_TRUST_ROOT=/tmp\n"), ("control_gate || die", "true || die"), ("set -Eeuo pipefail", "set -Eeo pipefail"),
                         ("[ \"${SUDO+x}\" != x ]", "true")):
        assert needle in text, needle
        tampered = tmp_path / "tampered.sh"
        tampered.write_text(text.replace(needle, repl, 1))
        with pytest.raises(tool.FreezeError, match="NON_PIN_BYTES_DIFFER_FROM_THE_REVIEWED_TEMPLATE"):
            tool.verify(repo, main, tampered, owner_uid=None)
    extra = tmp_path / "extra.sh"
    extra.write_text(text + "\n# one extra line\n")
    with pytest.raises(tool.FreezeError):
        tool.verify(repo, main, extra, owner_uid=None)


def test_a_frozen_runner_for_another_main_is_not_valid_for_this_one(tmp_path: Path) -> None:
    repo, main, lvr_sha, pins, out, _ = frozen(tmp_path)
    other = tmp_path / "other.sh"
    other.write_text(out.read_text().replace(f"EXPECTED_MAIN={main}", f"EXPECTED_MAIN={'c' * 40}", 1))
    with pytest.raises(tool.FreezeError, match="FROZEN_EXPECTED_MAIN_IS_NOT_THE_REVIEWED_MAIN"):
        tool.verify(repo, main, other, owner_uid=None)


def test_an_existing_destination_is_never_overwritten(tmp_path: Path) -> None:
    repo, main, lvr_sha, pins, out, _ = frozen(tmp_path)
    with pytest.raises(tool.FreezeError, match="DESTINATION_EXISTS"):
        tool.freeze(repo, main, pins, out)


def test_the_root_owned_freeze_refuses_for_a_non_root_user(tmp_path: Path) -> None:
    repo, _, main = s.world(tmp_path)
    if os.geteuid() == 0:
        pytest.skip("root")
    with pytest.raises(tool.FreezeError, match="ROOT_REQUIRED_FOR_ROOT_OWNED_RUNNER"):
        tool.freeze(repo, main, pins_for(main, s.SHA["a"]), tmp_path / "x.sh", root_owned=True)


def test_the_production_verify_requires_root_ownership_and_lvr_pass(tmp_path: Path) -> None:
    repo, main, lvr_sha, pins, out, _ = frozen(tmp_path)
    if os.geteuid() == 0:
        pytest.skip("root")
    with pytest.raises(tool.FreezeError, match="RUNNER_NOT_ROOT_OWNED"):
        tool.verify(repo, main, out)  # the production default: not root-owned => refused


def test_the_unfrozen_template_refuses_to_run_and_the_frozen_runner_dies_before_sourcing_anything(tmp_path: Path) -> None:
    refused = subprocess.run(["bash", str(s.RUNNER), str(tmp_path)], capture_output=True, text=True, env={"PATH": os.environ["PATH"], "HOME": str(tmp_path)})
    assert refused.returncode == 2 and "runner is not pinned" in refused.stderr
    repo, main, lvr_sha, pins, out, _ = frozen(tmp_path, OPERATOR_UID=str(os.getuid()), OPERATOR_USER=os.environ.get("USER", "owner"), REPO=str(repo := tmp_path / "repo"), CONTROL_SNAPSHOT_DIR=str(tmp_path / "no-control"),
                                                 EVIDENCE_ROOT=str(tmp_path / "evidence"))
    auth = tmp_path / "auth"
    auth.mkdir(mode=0o700)
    run = subprocess.run(["bash", str(out), str(auth)], capture_output=True, text=True, env={"PATH": os.environ["PATH"], "HOME": str(tmp_path)})
    assert run.returncode == 1 and "control snapshot is not the frozen immutable authority; nothing was sourced, created or touched" in run.stderr
    assert not (tmp_path / "evidence").exists()


def test_the_live_runner_refuses_every_environment_override(tmp_path: Path) -> None:
    repo, main, lvr_sha, pins, out, _ = frozen(tmp_path, OPERATOR_UID=str(os.getuid()), OPERATOR_USER=os.environ.get("USER", "owner"), REPO=str(tmp_path / "repo"), CONTROL_SNAPSHOT_DIR=str(tmp_path / "no-control"))
    auth = tmp_path / "auth"
    auth.mkdir(mode=0o700)
    base_env = {"PATH": os.environ["PATH"], "HOME": str(tmp_path)}
    for var in ("SUDO", "PYTHONPATH", "LD_PRELOAD", "BASH_ENV", "GIT_DIR", "GIT_CONFIG_COUNT", "AEGIS_L8_BACKEND", "AEGIS_L8_LIVE_AUTHORIZED", "AEGIS_L8P_LIVE_AUTHORIZED", "L8U_TEST_ONLY_CANONICAL_DIR_ENABLED", "L8U_TEST_ONLY_BOUNDARY"):
        run = subprocess.run(["bash", str(out), str(auth)], capture_output=True, text=True, env={**base_env, var: "x"})
        assert run.returncode == 2 and ("override" in run.stderr or "forbidden" in run.stderr), (var, run.stderr)
    # an AUTH_DIR that is a symlink, relative, group-writable or not canonical is refused
    link = tmp_path / "link"
    link.symlink_to(auth)
    assert subprocess.run(["bash", str(out), str(link)], capture_output=True, text=True, env=base_env).returncode == 2
    loose = tmp_path / "loose"
    loose.mkdir()
    loose.chmod(0o770)
    assert subprocess.run(["bash", str(out), str(loose)], capture_output=True, text=True, env=base_env).returncode == 2


# ---- control snapshot (the root-owned execution bundle) -------------------------------------------------------------------------------------------


def make_tree(root: Path) -> Path:
    src = root / "p4"
    (src / "stages/L8u").mkdir(parents=True)
    (src / "a.sh").write_text("#!/bin/sh\n")
    os.chmod(src / "a.sh", 0o755)
    (src / "stages/L8u/verify.sh").write_text("echo hi\n")
    return src


def test_control_snapshot_is_complete_manifested_readonly_and_tamper_evident(tmp_path: Path) -> None:
    src = make_tree(tmp_path)
    dest = tmp_path / "control"
    digest = snap.control_snapshot(src, dest, trust_root=str(tmp_path))
    assert (dest / "L8U-CONTROL-SHA256SUMS").is_file() and oct((dest / "a.sh").stat().st_mode & 0o777) == "0o555"
    snap.control_check(dest, digest, owner_uid=None)
    (dest / "a.sh").chmod(0o755)
    (dest / "a.sh").write_text("#!/bin/sh\nevil\n")
    (dest / "a.sh").chmod(0o555)
    with pytest.raises(snap.SnapshotError, match="CONTROL_FILE_DIGEST_MISMATCH"):
        snap.control_check(dest, digest, owner_uid=None)


def test_control_snapshot_refuses_symlinks_wrong_manifest_extra_files_and_writable_entries(tmp_path: Path) -> None:
    src = make_tree(tmp_path)
    (src / "link").symlink_to(src / "a.sh")
    with pytest.raises(snap.SnapshotError, match="CONTROL_SYMLINK_IN_SOURCE"):
        snap.control_snapshot(src, tmp_path / "c1", trust_root=str(tmp_path))
    (src / "link").unlink()
    dest = tmp_path / "c2"
    digest = snap.control_snapshot(src, dest, trust_root=str(tmp_path))
    with pytest.raises(snap.SnapshotError, match="CONTROL_MANIFEST_DIGEST_MISMATCH"):
        snap.control_check(dest, s.SHA["a"], owner_uid=None)
    dest.chmod(0o755)
    (dest / "extra.sh").write_text("x")
    with pytest.raises(snap.SnapshotError, match="CONTROL_FILE_SET_MISMATCH|CONTROL_SOURCE_WRITABLE"):
        snap.control_check(dest, digest, owner_uid=None)
    (dest / "extra.sh").unlink()
    (dest / "a.sh").chmod(0o777)
    with pytest.raises(snap.SnapshotError, match="CONTROL_SOURCE_WRITABLE"):
        snap.control_check(dest, digest, owner_uid=None)


def test_control_snapshot_production_check_requires_root_ownership(tmp_path: Path) -> None:
    src = make_tree(tmp_path)
    dest = tmp_path / "control"
    digest = snap.control_snapshot(src, dest, trust_root=str(tmp_path))
    if os.geteuid() == 0:
        pytest.skip("root")
    with pytest.raises(snap.SnapshotError):
        snap.control_check(dest, digest)  # production default uid 0 / trust root `/`
    cli = subprocess.run([sys.executable, str(s.SNAP), "control-check", str(dest), digest], capture_output=True, text=True)
    assert cli.returncode == 1 and "L8U_CONTROL_SNAPSHOT=FAIL" in cli.stderr


def test_the_real_phase4_tree_snapshots_the_l8u_runtime_closure(tmp_path: Path) -> None:
    dest = tmp_path / "control"
    digest = snap.control_snapshot(s.P4, dest, trust_root=str(tmp_path))
    for rel in ("p4-l8u-run-lib.sh", "p4-l8u-observe.py", "stages/L8u/apply.sh", "stages/L8u/verify.sh", "stages/L8u/rollback.sh", "stages/L8u/allow-keys.txt", "l8u-acceptance/l8u_predecessors.py",
                "p4-stage-gate.sh", "p4-l0-capture.sh", "p4-compare.sh", "p4-l7u-run-lib.sh", "p4-f1u-run-lib.sh", "p4-lib.sh"):
        assert (dest / rel).is_file(), rel
    snap.control_check(dest, digest, owner_uid=None)


def test_every_imported_sibling_must_live_in_the_same_authority_directory() -> None:
    assert tool.SIBLING_IN_SAME_DIRECTORY is True  # the control snapshot tool AND the predecessor authority sit next to the freeze tool, so one directory proof covers all three
    assert {Path(tool.snapshot_tool.__file__).resolve().parent, Path(tool.predecessors.__file__).resolve().parent, Path(tool.__file__).resolve().parent} == {s.FREEZE.parent}
