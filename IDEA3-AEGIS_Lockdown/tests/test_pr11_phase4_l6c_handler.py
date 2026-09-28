"""AEGIS IDEA3 PR11 Phase 4 — L6c "Immutable Release Install" handler tests (fixture root + fake systemd only).

Authority: docs/superpowers/specs/2026-09-27-idea3-pr11-phase4-l6c-release-install-governance.md. No test touches the real
host: handlers run against AEGIS_P4_FS_ROOT fixtures with a fake systemctl/ss that dies loudly on any verb beyond
show/is-active/is-enabled, proving L6c never issues a real mutation to systemd, a service, or a listener.
"""

from __future__ import annotations

import os
import re
import shutil
import stat
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))
import l6c_support as s  # noqa: E402
from l6c_support import APPLY, LOGICAL, REL_ID, ROLLBACK, VERIFY, Fx  # noqa: E402
from test_pr11_phase4_l7_release_guard_helper import build_release  # noqa: E402


@pytest.fixture()
def fx(tmp_path: Path) -> Fx:
    return s.build(tmp_path)


def applied(fx: Fx, **extra: str) -> subprocess.CompletedProcess[str]:
    res = fx.run(APPLY, **extra)
    assert res.returncode == 0, res.stdout + res.stderr
    return res


def reason(res: subprocess.CompletedProcess[str]) -> str:
    m = re.search(r"L6C_APPLY=FAIL reason=(\S+)", res.stderr)
    return m.group(1) if m else ""


def vreason(res: subprocess.CompletedProcess[str]) -> str:
    m = re.search(r"L6C_VERIFY=FAIL reason=(\S+)", res.stderr)
    return m.group(1) if m else ""


def rreason(res: subprocess.CompletedProcess[str]) -> str:
    m = re.search(r"L6C_ROLLBACK=FAIL reason=(\S+)", res.stderr)
    return m.group(1) if m else ""


def journal(fx: Fx) -> list[tuple[str, ...]]:
    return [tuple(l.split("\t")) for l in (fx.work / "journal.tsv").read_text().splitlines()]


# ── 1. registration, syntax, static contract ─────────────────────────────────────────────────────────────────────────────


def test_l6c_all_required_files_exist() -> None:
    for name in ("apply.sh", "verify.sh", "rollback.sh", "allow-keys.txt", "allow-listeners.txt"):
        assert (s.L6C_STAGE / name).is_file(), name


def test_l6c_shell_scripts_pass_bash_n() -> None:
    for name in ("apply.sh", "verify.sh", "rollback.sh"):
        assert subprocess.run(["bash", "-n", str(s.L6C_STAGE / name)], capture_output=True).returncode == 0, name


def test_l6c_allow_listeners_is_empty() -> None:
    active = [l for l in (s.L6C_STAGE / "allow-listeners.txt").read_text().splitlines() if l.strip() and not l.startswith("#")]
    assert active == []


def test_l6c_allow_keys_are_exact_and_never_broad() -> None:
    keys = [l.strip() for l in (s.L6C_STAGE / "allow-keys.txt").read_text().splitlines() if l.strip() and not l.startswith("#")]
    assert set(keys) == {"host.path./opt/aegis-idea3", "host.path./opt/aegis-idea3/releases"}
    assert not any("*" in k for k in keys)
    assert "host.aegis_idea3.release_catalog" not in keys  # approved only via ALLOW_L6C_RELEASE_FILE, never a plain key


def test_l6c_handlers_never_duplicate_the_install_or_guard_predicate() -> None:
    """The handler may call p4-l7-install-release.py / p4-l7-release-guard.py, but must not reimplement their checks."""
    for name in ("apply.sh", "rollback.sh"):
        assert "p4-l7-install-release.py" in (s.L6C_STAGE / name).read_text() or "p4-l7-release-guard.py" in (s.L6C_STAGE / name).read_text()
    for name in ("apply.sh", "verify.sh", "rollback.sh"):
        text = (s.L6C_STAGE / name).read_text()
        assert "RELEASE-SHA256SUMS" not in text and "RELEASE-MANIFEST" not in text  # never re-parses the provenance files


def test_l6c_handlers_never_touch_credentials_core_esp32_or_forbidden_surfaces() -> None:
    for name in ("apply.sh", "verify.sh", "rollback.sh"):
        text = "\n".join(l for l in (s.L6C_STAGE / name).read_text().splitlines() if not l.lstrip().startswith("#"))
        for bad in ("k_c2d", "k_d2c", "mqtt-core.pass", "admin.pin", "restore.credential", "esptool",
                    "platformio", "mosquitto_pub", "CUT_UPLINK", "RESTORE_UPLINK", "runuser", "nmcli", "nft ", "chronyc",
                    "twingate stop", "twingate start", "IDEA1-", "systemctl enable", "systemctl start", "systemctl stop",
                    "systemctl disable", "systemctl restart"):
            assert bad not in text, (name, bad)


# ── 2. apply: environment + prestate ─────────────────────────────────────────────────────────────────────────────────────


def test_l6c_apply_passes_the_control_fixture(fx: Fx) -> None:
    res = applied(fx)
    assert "L6C_APPLY=PASS" in res.stdout and f"L6C_RELEASE_ID={REL_ID}" in res.stdout
    assert "PRODUCTION_MUTATION_PERFORMED=YES" in res.stdout


@pytest.mark.parametrize("var", ["AEGIS_L6C_WORK_DIR", "AEGIS_L6C_SOURCE_DIR", "AEGIS_L6C_RELEASE_ID"])
def test_l6c_apply_requires_environment(fx: Fx, var: str) -> None:
    res = fx.run(APPLY, **{var: ""})
    assert reason(res) == f"{var}_REQUIRED"
    assert not fx.release.exists()


@pytest.mark.parametrize("bad_id", ["../evil", "a/b", "has space", "-leading"])
def test_l6c_apply_rejects_invalid_release_id(fx: Fx, bad_id: str) -> None:
    res = fx.run(APPLY, AEGIS_L6C_RELEASE_ID=bad_id)
    assert reason(res) == "RELEASE_ID_INVALID"


def test_l6c_live_mode_requires_authorization_flag_and_root(fx: Fx) -> None:
    env = fx.env()
    env.pop("AEGIS_P4_FS_ROOT")
    for k in [k for k in env if k.startswith("AEGIS_L6C_FIXTURE")]:
        env.pop(k)
    res = subprocess.run(["bash", str(APPLY)], text=True, capture_output=True, check=False, env=env)
    assert reason(res) == "LIVE_AUTHORIZATION_FLAG_REQUIRED"
    env["AEGIS_L6C_LIVE_AUTHORIZED"] = "YES"
    res = subprocess.run(["bash", str(APPLY)], text=True, capture_output=True, check=False, env=env)
    assert reason(res) == "ROOT_REQUIRED" and not fx.work.exists()


def test_l6c_apply_work_dir_rules(fx: Fx) -> None:
    fx.work.mkdir()
    assert reason(fx.run(APPLY, keep_work=True)) == "WORK_DIR_ALREADY_EXISTS"
    fx.work.rmdir()
    assert reason(fx.run(APPLY, AEGIS_L6C_WORK_DIR="/etc/aegis-idea3/work")) == "WORK_DIR_INSIDE_ETC"
    link = fx.tmp / "worklink"
    link.symlink_to(fx.tmp)
    assert reason(fx.run(APPLY, AEGIS_L6C_WORK_DIR=str(link))) == "WORK_DIR_IS_SYMLINK"


def test_l6c_apply_fails_when_target_release_already_exists(fx: Fx) -> None:
    fx.release.parent.mkdir(parents=True)
    fx.release.mkdir()
    before = fx.tree()
    res = fx.run(APPLY)
    assert reason(res).startswith("PRESTATE_UNEXPECTED")
    assert fx.tree() == before


def test_l6c_apply_fails_when_target_release_is_a_symlink(fx: Fx) -> None:
    fx.release.parent.mkdir(parents=True)
    fx.release.symlink_to("/etc")
    res = fx.run(APPLY)
    assert reason(res).startswith("PRESTATE_UNEXPECTED")
    assert fx.release.is_symlink()


def test_l6c_apply_rejects_a_symlinked_source(fx: Fx) -> None:
    link = fx.tmp / "src-link"
    link.symlink_to(fx.source)
    res = fx.run(APPLY, AEGIS_L6C_SOURCE_DIR=str(link))
    assert reason(res) == "SOURCE_DIR_INVALID"


def test_l6c_apply_source_guard_failure_fails_before_any_mutation(fx: Fx) -> None:
    (fx.source / "aegis_soc" / "supervisor.py").write_text("print('tampered')\n")
    before = fx.tree()
    res = fx.run(APPLY)
    assert reason(res) == "INSTALL_FAILED:RELEASE_GUARD_FAILED:CHECKSUM_MISMATCH"
    assert not fx.release.exists()
    assert (fx.work / "production-mutation").exists()  # the marker is written BEFORE the one installer call, as required
    remainder = {k: v for k, v in fx.tree().items() if not k.startswith("work/")}
    remainder_before = {k: v for k, v in before.items() if not k.startswith("work/")}
    assert remainder == remainder_before


def test_l6c_apply_never_builds_or_chowns_the_source(fx: Fx) -> None:
    before_mtimes = {p: p.stat().st_mtime_ns for p in fx.source.rglob("*") if p.is_file()}
    applied(fx)
    after_mtimes = {p: p.stat().st_mtime_ns for p in fx.source.rglob("*") if p.is_file()}
    assert before_mtimes == after_mtimes
    assert sorted(p.name for p in fx.source.iterdir()) == sorted(p.name for p in build_release(fx.tmp / "control").iterdir())


# ── 3. apply: journal, evidence, one call, no retry ──────────────────────────────────────────────────────────────────────


def test_l6c_apply_journals_the_exact_mutation_boundary(fx: Fx) -> None:
    applied(fx)
    entries = journal(fx)
    assert ("DIR", "/opt/aegis-idea3") in entries
    assert ("DIR", "/opt/aegis-idea3/releases") in entries
    assert ("RELEASE", LOGICAL) in entries
    assert stat.S_IMODE((fx.work / "journal.tsv").stat().st_mode) == 0o600


def test_l6c_apply_does_not_journal_a_preexisting_opt_or_releases_dir(fx: Fx) -> None:
    (fx.root / "opt/aegis-idea3/releases").mkdir(parents=True)
    applied(fx)
    entries = journal(fx)
    assert ("DIR", "/opt/aegis-idea3") not in entries
    assert ("DIR", "/opt/aegis-idea3/releases") not in entries
    assert ("RELEASE", LOGICAL) in entries


def test_l6c_apply_calls_the_installer_exactly_once_and_never_retries(fx: Fx) -> None:
    applied(fx)
    assert (fx.work / "install-output.txt").read_text().count("L7_RELEASE_INSTALL=PASS") == 1
    text = "\n".join(l for l in APPLY.read_text().splitlines() if not l.lstrip().startswith("#"))
    assert not re.search(r"\b(for|while|until)\b", text)  # no loop that could retry the installer


def test_l6c_apply_records_non_secret_evidence(fx: Fx) -> None:
    applied(fx)
    evid = (fx.work / "install-evidence.tsv").read_text()
    assert "release_id" in evid and REL_ID in evid and "source_git_sha" in evid and LOGICAL in evid
    assert str(fx.tmp) not in evid


def test_l6c_apply_never_touches_a_preexisting_release(fx: Fx) -> None:
    other = fx.root / "opt/aegis-idea3/releases/rel-other"
    other.parent.mkdir(parents=True)
    build_release(fx.tmp / "other-staging", release_id="rel-other")
    shutil.copytree(fx.tmp / "other-staging/rel-other", other)
    before = other.read_bytes() if other.is_file() else None
    before_files = {p: p.read_bytes() for p in other.rglob("*") if p.is_file()}
    applied(fx)
    after_files = {p: p.read_bytes() for p in other.rglob("*") if p.is_file()}
    assert before_files == after_files


def test_l6c_apply_installs_exact_content_and_the_real_guard_accepts_it(fx: Fx) -> None:
    applied(fx)
    assert fx.release.is_dir() and not fx.release.is_symlink()
    guard_res = subprocess.run([sys.executable, str(s.GUARD), "check", "--logical-path", LOGICAL, "--host-path", str(fx.release),
                               "--expect-owner", "any"], text=True, capture_output=True)
    assert guard_res.returncode == 0, guard_res.stdout + guard_res.stderr


def test_l6c_apply_never_touches_current(fx: Fx) -> None:
    fx.current.parent.mkdir(parents=True, exist_ok=True)
    fx.current.symlink_to("/opt/aegis-idea3/releases/some-other")
    applied(fx)
    assert os.readlink(fx.current) == "/opt/aegis-idea3/releases/some-other"


def test_l6c_apply_never_mutates_systemd_or_listeners(fx: Fx) -> None:
    applied(fx)
    assert fx.calls() == [] or all(c["argv"][0] == "show" for c in fx.calls())


def test_l6c_apply_leaves_predecessor_services_untouched(fx: Fx) -> None:
    applied(fx)
    for name, pid in ((s.LEGACY_UNIT, "1111"), (s.BROKER_UNIT, "3333"), (s.IDEA2_ENGINE, "2222"), (s.IDEA2_TUNNEL, "4444")):
        assert fx.unit_state(name)["pid"] == pid and fx.unit_state(name)["active"] == "active"


# ── 4. verify ─────────────────────────────────────────────────────────────────────────────────────────────────────────────


def verified(fx: Fx, **extra: str) -> subprocess.CompletedProcess[str]:
    return fx.run(VERIFY, **extra)


def test_l6c_verify_passes_on_the_applied_fixture(fx: Fx) -> None:
    applied(fx)
    res = verified(fx)
    assert res.returncode == 0, res.stdout + res.stderr
    assert f"L6C_RELEASE_ID={REL_ID}" in res.stdout


def test_l6c_verify_is_read_only(fx: Fx) -> None:
    applied(fx)
    before = fx.tree()
    assert verified(fx).returncode == 0
    assert fx.tree() == before


def test_l6c_verify_fails_when_release_missing(fx: Fx) -> None:
    applied(fx)
    shutil.rmtree(fx.release)
    assert vreason(verified(fx)) == "RELEASE_NOT_INSTALLED"


def test_l6c_verify_catches_content_drift(fx: Fx) -> None:
    applied(fx)
    (fx.release / "aegis_soc" / "supervisor.py").write_text("print('tampered')\n")
    assert vreason(verified(fx)) == "RELEASE_GUARD_FAILED:CHECKSUM_MISMATCH"


def test_l6c_verify_catches_metadata_drift(fx: Fx) -> None:
    applied(fx)
    (fx.release / "aegis_soc" / "supervisor.py").chmod(0o666)
    assert vreason(verified(fx)) == "RELEASE_GUARD_FAILED:WRITABLE_BY_GROUP_OR_OTHER"


def test_l6c_verify_checks_expected_source_sha_when_given(fx: Fx) -> None:
    applied(fx)
    assert verified(fx, AEGIS_L6C_EXPECTED_SOURCE_SHA="a" * 40).returncode == 0  # matches the fixture's own default source sha
    assert vreason(verified(fx, AEGIS_L6C_EXPECTED_SOURCE_SHA="b" * 40)) == "SOURCE_SHA_MISMATCH"


def test_l6c_verify_fails_if_current_changed(fx: Fx) -> None:
    applied(fx)
    fx.current.parent.mkdir(parents=True, exist_ok=True)
    fx.current.symlink_to(str(fx.release))
    assert vreason(verified(fx)) == "CURRENT_LINK_CHANGED"


def test_l6c_verify_fails_if_l7_credential_material_present(fx: Fx) -> None:
    applied(fx)
    (fx.root / "etc/aegis-idea3/credentials").mkdir()
    assert vreason(verified(fx)) == "L7_MATERIAL_PRESENT:/etc/aegis-idea3/credentials"


def test_l6c_verify_fails_if_core_unit_becomes_loaded_during_the_run(fx: Fx) -> None:
    """The Core unit is part of the predecessor snapshot: any change to it, including newly loading, is drift."""
    applied(fx)
    import json

    data = fx.data()
    data["units"][s.CORE_UNIT] = dict(load="loaded", active="inactive", sub="dead", result="success", enabled=False, pid="0", nrestarts="0")
    fx.state.write_text(json.dumps(data))
    assert vreason(verified(fx)) == "PREDECESSOR_SERVICE_CHANGED"


def test_l6c_verify_fails_if_core_unit_was_already_loaded_before_this_stage_ran(fx: Fx) -> None:
    """Defense in depth: even if the Core unit was (unusually) already loaded before AND after this stage — so the
    predecessor snapshot shows no change — verify still refuses, since L6c must never run alongside a loaded Core unit."""
    import json

    data = fx.data()
    data["units"][s.CORE_UNIT] = dict(load="loaded", active="inactive", sub="dead", result="success", enabled=False, pid="0", nrestarts="0")
    fx.state.write_text(json.dumps(data))
    applied(fx)
    assert vreason(verified(fx)) == "CORE_UNIT_LOADED"


def test_l6c_verify_fails_on_predecessor_service_or_listener_drift(fx: Fx) -> None:
    applied(fx)
    import json

    data = fx.data()
    data["units"][s.LEGACY_UNIT]["pid"] = "9999"
    fx.state.write_text(json.dumps(data))
    assert vreason(verified(fx)) == "PREDECESSOR_SERVICE_CHANGED"


def test_l6c_verify_fails_on_legacy_config_drift(fx: Fx) -> None:
    applied(fx)
    (fx.root / "etc/mosquitto/mosquitto.conf").write_text("listener 1883\n#changed\n")
    assert vreason(verified(fx)) == "LEGACY_CONFIG_TREE_CHANGED"


# ── 5. rollback ───────────────────────────────────────────────────────────────────────────────────────────────────────────


def rolled(fx: Fx, **extra: str) -> subprocess.CompletedProcess[str]:
    return fx.run(ROLLBACK, **extra)


def test_l6c_rollback_restores_exact_pre_state_and_is_idempotent(fx: Fx) -> None:
    before = fx.tree()
    applied(fx)
    res = rolled(fx)
    assert res.returncode == 0, res.stdout + res.stderr
    assert "L6C_ROLLBACK=PASS" in res.stdout and "L6C_MATERIAL_RESIDUE=NO" in res.stdout
    assert fx.tree() == before
    again = rolled(fx)
    assert again.returncode == 0, again.stdout + again.stderr
    assert fx.tree() == before


def test_l6c_rollback_removes_only_the_stage_created_release(fx: Fx) -> None:
    applied(fx)
    assert rolled(fx).returncode == 0
    assert not fx.release.exists()


def test_l6c_rollback_refuses_an_altered_target(fx: Fx) -> None:
    applied(fx)
    (fx.release / "aegis_soc" / "supervisor.py").write_text("print('tampered')\n")
    res = rolled(fx)
    assert rreason(res) == "RELEASE_DRIFTED_REFUSING_ROLLBACK:CHECKSUM_MISMATCH"
    assert fx.release.exists()  # never removed when drifted


def test_l6c_rollback_preserves_a_preexisting_release(fx: Fx) -> None:
    other = fx.root / "opt/aegis-idea3/releases/rel-other"
    other.parent.mkdir(parents=True)
    build_release(fx.tmp / "other-staging", release_id="rel-other")
    shutil.copytree(fx.tmp / "other-staging/rel-other", other)
    applied(fx)
    assert rolled(fx).returncode == 0
    assert other.exists()


def test_l6c_rollback_removes_parent_dirs_only_when_stage_owned_and_empty(fx: Fx) -> None:
    other = fx.root / "opt/aegis-idea3/releases/rel-other"
    other.parent.mkdir(parents=True)
    build_release(fx.tmp / "other-staging", release_id="rel-other")
    shutil.copytree(fx.tmp / "other-staging/rel-other", other)
    applied(fx)
    assert rolled(fx).returncode == 0
    assert (fx.root / "opt/aegis-idea3/releases").exists()  # not stage-owned (rel-other pre-existed) -> not empty -> kept
    assert (fx.root / "opt/aegis-idea3").exists()


def test_l6c_rollback_never_removes_a_preexisting_parent_directory(fx: Fx) -> None:
    (fx.root / "opt/aegis-idea3/releases").mkdir(parents=True)
    applied(fx)
    assert rolled(fx).returncode == 0
    assert (fx.root / "opt/aegis-idea3/releases").is_dir()  # pre-existed -> never removed even though now empty
    assert (fx.root / "opt/aegis-idea3").is_dir()


def test_l6c_rollback_never_touches_current(fx: Fx) -> None:
    fx.current.parent.mkdir(parents=True, exist_ok=True)
    fx.current.symlink_to("/opt/aegis-idea3/releases/some-other")
    applied(fx)
    assert rolled(fx).returncode == 0
    assert os.readlink(fx.current) == "/opt/aegis-idea3/releases/some-other"


def test_l6c_rollback_refuses_if_current_already_drifted(fx: Fx) -> None:
    applied(fx)
    fx.current.parent.mkdir(parents=True, exist_ok=True)
    fx.current.symlink_to(str(fx.release))
    assert rreason(rolled(fx)) == "CURRENT_LINK_CHANGED"


def test_l6c_rollback_with_empty_journal_touches_nothing(fx: Fx) -> None:
    applied(fx)
    (fx.work / "journal.tsv").write_text("")
    before = fx.tree()
    rolled(fx)
    assert fx.tree() == before
    assert fx.release.exists()


@pytest.mark.parametrize("line", ["DIR\t/etc/aegis-idea3", "RELEASE\t/opt/aegis-idea3/releases/other-id",
                                  "DIR\t/opt/aegis-idea3/../evil", "SERVICE\taegis-idea3-core.service", "WHATEVER\tx"])
def test_l6c_rollback_rejects_tampered_journal_entries(fx: Fx, line: str) -> None:
    applied(fx)
    with (fx.work / "journal.tsv").open("a") as fh:
        fh.write(line + "\n")
    before = fx.tree()
    res = rolled(fx)
    assert rreason(res) in {"JOURNAL_ENTRY_NOT_OWNED", "JOURNAL_ENTRY_UNKNOWN"}
    assert fx.tree() == before


def test_l6c_rollback_never_mutates_systemd_or_listeners(fx: Fx) -> None:
    applied(fx)
    n = len(fx.calls())
    rolled(fx)
    assert all(c["argv"][0] == "show" for c in fx.calls()[n:])


def test_l6c_rollback_never_touches_esp32_or_l8() -> None:
    text = ROLLBACK.read_text()
    for bad in ("esptool", "platformio", "/dev/tty", "serial"):
        assert bad not in text


def test_l6c_apply_default_installed_ownership_requires_root(fx: Fx) -> None:
    """Without the fixture override, the real default (root) contract applies even in a fixture root."""
    if os.getuid() == 0:
        pytest.skip("test process is root; the negative default-root contract cannot be exercised unprivileged here")
    res = fx.run(APPLY, AEGIS_L6C_FIXTURE_DEST_OWNER_ANY="NO")
    assert reason(res) == "INSTALL_FAILED:POST_COPY_GUARD_FAILED:OWNER_INVALID"
    assert not fx.release.exists()


# ── 6. rollback ownership contract mirrors verify (2026-09-27 correctness fix) ───────────────────────────────────────────
# rollback.sh must never be weaker than verify.sh: it derives owner_expect the exact same way (any under a fixture root,
# root by live default) rather than hard-coding --expect-owner any, since the stage-created installed release contract is
# root-owned live and a rollback that accepts "any" ownership could be tricked into deleting a tree that has drifted away
# from root ownership.


def test_l6c_rollback_owner_check_is_never_hardcoded_to_any() -> None:
    text = ROLLBACK.read_text()
    assert "--expect-owner any\n" not in text and "--expect-owner any 2>&1" not in text
    assert "owner_expect=any" in text and '[ -z "$ROOT" ] && owner_expect=root' in text


def test_l6c_rollback_owner_contract_matches_verify_exactly() -> None:
    """rollback.sh and verify.sh must derive owner_expect identically — the exact same two lines — so the two can never
    silently diverge again."""
    wanted = {"owner_expect=any", '[ -z "$ROOT" ] && owner_expect=root'}
    lines = {l.strip() for l in VERIFY.read_text().splitlines() if l.strip() in wanted}
    assert lines == wanted
    lines = {l.strip() for l in ROLLBACK.read_text().splitlines() if l.strip() in wanted}
    assert lines == wanted


def test_l6c_rollback_still_works_under_the_fixture_owner_contract(fx: Fx) -> None:
    """Fixture rollback (owner_expect=any, since AEGIS_P4_FS_ROOT is always set under fixtures) still succeeds and still
    removes only the stage-created release."""
    applied(fx)
    res = rolled(fx)
    assert res.returncode == 0, res.stdout + res.stderr
    assert not fx.release.exists()


def test_l6c_rollback_refuses_on_metadata_drift_rather_than_deleting_the_tree(fx: Fx) -> None:
    """Ownership/metadata drift on the release (the same guard predicate --expect-owner root would enforce live) is
    refused rather than silently deleted, exactly like verify's metadata-drift check."""
    applied(fx)
    (fx.release / "aegis_soc" / "supervisor.py").chmod(0o666)
    res = rolled(fx)
    assert rreason(res) == "RELEASE_DRIFTED_REFUSING_ROLLBACK:WRITABLE_BY_GROUP_OR_OTHER"
    assert fx.release.exists()  # never deleted when drifted
