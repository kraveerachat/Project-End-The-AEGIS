"""AEGIS IDEA3 PR11 Phase 4 — L7u (post-L7 Recovery Core upgrade) engine tests.

The engine (deploy/pr11-phase4/p4-l7u-upgrade.py) owns every mutation logic of the stage. These tests run it against a FIXTURE host root
with a stateful fake system backend; nothing touches the real host. RED-first: they define the contract.
"""

from __future__ import annotations

import json
import os
import re
import stat
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))
import l7u_support as s


@pytest.fixture(autouse=True)
def _never_start_a_real_process(monkeypatch):
    """This workstation may really run the Core: engine tests use fixtures and fakes only, so any real process start (other than this
    interpreter running the engine CLI, which refuses before acting) is a test failure. Tests that exercise SystemBackend install their own
    fake over this guard."""
    real_run = subprocess.run

    def guarded(argv, *args, **kwargs):
        if isinstance(argv, (list, tuple)) and argv and argv[0] == sys.executable:
            return real_run(argv, *args, **kwargs)
        raise AssertionError(f"a real process must never be started by the engine tests: {argv!r}")

    monkeypatch.setattr(subprocess, "run", guarded)


DROPIN = "/etc/systemd/system/aegis-idea3-core.service.d/10-recovery.conf"
TMPFILES = "/etc/tmpfiles.d/aegis-idea3-recovery.conf"
RUNTIME = "/run/aegis-idea3-recovery"
SOCKET = f"{RUNTIME}/recovery.sock"
CORE_ENV = "/etc/aegis-idea3/core.env"


def refusal(fx, fn, *args) -> str:
    with pytest.raises(fx.engine.Refusal) as exc:
        fn(*args)
    return str(exc.value)


def do_apply(fx):
    return fx.engine.apply(fx.cfg, fx.host, fx.system)


def do_rollback(fx):
    return fx.engine.rollback(fx.cfg, fx.host, fx.system)


# ── 0. templates are repository-owned, minimal and exact ────────────────────────────────────────────────────────────────


def test_engine_and_templates_exist() -> None:
    assert s.ENGINE_PATH.is_file() and s.DROPIN_TEMPLATE.is_file() and s.TMPFILES_TEMPLATE.is_file()


def test_dropin_template_grants_only_the_group_and_the_socket_directory() -> None:
    lines = [l for l in s.DROPIN_TEMPLATE.read_text().splitlines() if l.strip() and not l.startswith("#")]
    assert lines == ["[Service]", "SupplementaryGroups=aegis-idea3-recovery", "ReadWritePaths=/run/aegis-idea3-recovery"]


def test_tmpfiles_template_provisions_the_directory_0750_core_owner_recovery_group() -> None:
    lines = [l for l in s.TMPFILES_TEMPLATE.read_text().splitlines() if l.strip() and not l.startswith("#")]
    assert lines == ["d /run/aegis-idea3-recovery 0750 aegis-idea3 aegis-idea3-recovery -"]


def test_templates_never_widen_the_core_umask_or_existing_runtime_directory() -> None:
    text = s.DROPIN_TEMPLATE.read_text() + s.TMPFILES_TEMPLATE.read_text()
    active = "\n".join(l for l in text.splitlines() if not l.startswith("#"))
    assert "UMask" not in active and "RuntimeDirectory" not in active and "/run/aegis-idea3 " not in active
    assert "CapabilityBoundingSet" not in active and "ProtectSystem" not in active


# ── 1. preflight (read-only) ─────────────────────────────────────────────────────────────────────────────────────────────


def test_preflight_accepts_the_owner_baseline_and_mutates_nothing(tmp_path: Path) -> None:
    fx = s.build(tmp_path)
    before = s.snapshot(fx)
    plan = fx.engine.preflight(fx.cfg, fx.host, fx.system)
    assert plan.group_exists is False and plan.group_created_by_attempt is True
    assert s.snapshot(fx) == before
    assert not fx.work.exists()
    assert fx.system.state.calls == [c for c in fx.system.state.calls if c[0] == "systemctl" and c[1] == "show"]


@pytest.mark.parametrize("target", ["/opt/aegis-idea3/releases/deadbeef", s.NEW_LOGICAL, "releases/x", s.OLD_LOGICAL + "/"])
def test_preflight_refuses_an_unexpected_current_pointer(tmp_path: Path, target: str) -> None:
    fx = s.build(tmp_path, current_target=target)
    assert refusal(fx, fx.engine.preflight, fx.cfg, fx.host, fx.system).startswith("CURRENT_POINTER_MISMATCH")


def test_preflight_refuses_a_current_that_is_not_a_symlink(tmp_path: Path) -> None:
    fx = s.build(tmp_path)
    os.unlink(fx.p("/opt/aegis-idea3/current"))
    os.mkdir(fx.p("/opt/aegis-idea3/current"))
    assert refusal(fx, fx.engine.preflight, fx.cfg, fx.host, fx.system).startswith("CURRENT_NOT_SYMLINK")


def test_preflight_refuses_when_the_old_release_fails_the_real_guard(tmp_path: Path) -> None:
    fx = s.build(tmp_path)
    (fx.p(s.OLD_LOGICAL) / "aegis_soc/supervisor.py").write_text("tampered\n")
    assert refusal(fx, fx.engine.preflight, fx.cfg, fx.host, fx.system).startswith("OLD_RELEASE_GUARD_FAILED")


def test_preflight_refuses_when_the_new_release_source_fails_the_real_guard(tmp_path: Path) -> None:
    fx = s.build(tmp_path)
    (fx.source / "aegis_soc/supervisor.py").write_text("tampered\n")
    assert refusal(fx, fx.engine.preflight, fx.cfg, fx.host, fx.system).startswith("NEW_RELEASE_GUARD_FAILED")


def test_preflight_refuses_a_new_release_not_built_from_exactly_the_pinned_main(tmp_path: Path) -> None:
    fx = s.build(tmp_path, new_sha="b" * 40)
    assert refusal(fx, fx.engine.preflight, fx.cfg, fx.host, fx.system).startswith("NEW_RELEASE_SOURCE_NOT_PINNED_MAIN")


def test_preflight_refuses_a_new_release_without_the_recovery_runtime(tmp_path: Path) -> None:
    fx = s.build(tmp_path, new_recovery=False)
    assert refusal(fx, fx.engine.preflight, fx.cfg, fx.host, fx.system).startswith("NEW_RELEASE_LACKS_RECOVERY_RUNTIME")


def test_preflight_refuses_when_the_new_release_is_already_installed(tmp_path: Path) -> None:
    fx = s.build(tmp_path)
    s.make_release(fx.root / "opt/aegis-idea3/releases", s.NEW_ID, s.MAIN, recovery=True)
    assert refusal(fx, fx.engine.preflight, fx.cfg, fx.host, fx.system).startswith("NEW_RELEASE_ALREADY_INSTALLED")


def test_preflight_refuses_old_equal_new_and_a_malformed_main_pin(tmp_path: Path) -> None:
    fx = s.build(tmp_path)
    same = fx.engine.Config(**{**fx.cfg.__dict__, "new_release_id": s.OLD_ID})
    assert refusal(fx, fx.engine.preflight, same, fx.host, fx.system).startswith("OLD_EQUALS_NEW")
    bad = fx.engine.Config(**{**fx.cfg.__dict__, "expected_main": "main"})
    assert refusal(fx, fx.engine.preflight, bad, fx.host, fx.system).startswith("MAIN_PIN_INVALID")


def test_owner_expectation_root_is_the_default_and_any_is_fixture_only(tmp_path: Path) -> None:
    fx = s.build(tmp_path)
    assert fx.engine.Config.__dataclass_fields__["owner_expect"].default == "root"
    plain = fx.engine.Host("")  # a real (non-fixture) host
    cfg = fx.engine.Config(**{**fx.cfg.__dict__, "owner_expect": "any"})
    assert refusal(fx, fx.engine.preflight, cfg, plain, fx.system).startswith("OWNER_ANY_REQUIRES_FIXTURE_ROOT")


@pytest.mark.parametrize("fail_state", [("active", "failed"), ("sub", "dead"), ("enabled", "disabled"), ("result", "exit-code")])
def test_preflight_requires_the_running_old_core_baseline(tmp_path: Path, fail_state: tuple[str, str]) -> None:
    fx = s.build(tmp_path)
    setattr(fx.system.state, *fail_state)
    assert refusal(fx, fx.engine.preflight, fx.cfg, fx.host, fx.system).startswith("CORE_PRESTATE_NOT_HEALTHY")


def test_preflight_requires_a_zero_restart_old_core(tmp_path: Path) -> None:
    fx = s.build(tmp_path)
    fx.system.state.nrestarts = 2
    assert refusal(fx, fx.engine.preflight, fx.cfg, fx.host, fx.system).startswith("CORE_PRESTATE_NOT_HEALTHY")


@pytest.mark.parametrize("surface", [DROPIN, TMPFILES, RUNTIME])
def test_preflight_refuses_when_an_l7u_owned_surface_already_exists(tmp_path: Path, surface: str) -> None:
    fx = s.build(tmp_path)
    p = fx.p(surface)
    p.parent.mkdir(parents=True, exist_ok=True)
    if surface == RUNTIME:
        p.mkdir()
    else:
        p.write_text("x\n")
    assert "ALREADY_EXISTS" in refusal(fx, fx.engine.preflight, fx.cfg, fx.host, fx.system)


def test_preflight_requires_the_operator_identity_to_match_exactly(tmp_path: Path) -> None:
    fx = s.build(tmp_path)
    cfg = fx.engine.Config(**{**fx.cfg.__dict__, "operator_uid": 1001})
    assert refusal(fx, fx.engine.preflight, cfg, fx.host, fx.system).startswith("OPERATOR_IDENTITY_MISMATCH")
    cfg = fx.engine.Config(**{**fx.cfg.__dict__, "operator_user": "nobody-such"})
    assert refusal(fx, fx.engine.preflight, cfg, fx.host, fx.system).startswith("OPERATOR_IDENTITY_MISMATCH")


def test_preflight_refuses_the_core_account_as_operator(tmp_path: Path) -> None:
    fx = s.build(tmp_path)
    cfg = fx.engine.Config(**{**fx.cfg.__dict__, "operator_user": "aegis-idea3", "operator_uid": s.CORE_UID})
    assert refusal(fx, fx.engine.preflight, cfg, fx.host, fx.system).startswith("OPERATOR_IS_CORE_ACCOUNT")


# ── 2. dedicated group cases ─────────────────────────────────────────────────────────────────────────────────────────────


def test_a_preexisting_empty_system_group_is_adopted_and_never_deleted(tmp_path: Path) -> None:
    fx = s.build(tmp_path, group_rows=[f"{s.GROUP}:x:{s.NEW_GROUP_GID}:"])
    plan = fx.engine.preflight(fx.cfg, fx.host, fx.system)
    assert plan.group_exists and not plan.group_created_by_attempt and plan.group_gid == s.NEW_GROUP_GID
    do_apply(fx)
    assert not any(c[0] == "groupadd" for c in fx.system.state.calls)
    do_rollback(fx)
    assert not any(c[0] == "groupdel" for c in fx.system.state.calls)
    assert any(r.startswith(f"{s.GROUP}:") for r in fx.host.read_text("/etc/group").splitlines())


def test_a_preexisting_group_already_holding_only_the_operator_is_adopted_and_membership_is_kept(tmp_path: Path) -> None:
    fx = s.build(tmp_path, group_rows=[f"{s.GROUP}:x:{s.NEW_GROUP_GID}:{s.OPERATOR}"])
    before = s.snapshot(fx)
    do_apply(fx)
    assert not any(c[0] in ("groupadd", "gpasswd_add") for c in fx.system.state.calls)
    do_rollback(fx)
    assert not any(c[0] in ("groupdel", "gpasswd_del") for c in fx.system.state.calls)
    assert s.snapshot(fx) == before


@pytest.mark.parametrize("row,code", [
    (f"{s.GROUP}:x:1500:", "GROUP_GID_NOT_SYSTEM"),
    (f"{s.GROUP}:x:{s.CORE_GID}:", "GROUP_GID_CONFLICT"),
    (f"{s.GROUP}:x:{s.OPERATOR_GID}:", "GROUP_GID_CONFLICT"),
    (f"{s.GROUP}:x:0:", "GROUP_GID_CONFLICT"),
    (f"{s.GROUP}:x:{s.NEW_GROUP_GID}:{s.OPERATOR},mallory", "GROUP_UNEXPECTED_MEMBERS"),
    (f"{s.GROUP}:x:{s.NEW_GROUP_GID}:aegis-idea3", "GROUP_UNEXPECTED_MEMBERS"),
])
def test_group_conflicts_and_unsafe_preexisting_groups_are_refused(tmp_path: Path, row: str, code: str) -> None:
    fx = s.build(tmp_path, group_rows=[row])
    assert refusal(fx, fx.engine.preflight, fx.cfg, fx.host, fx.system).startswith(code)


def test_a_duplicate_group_name_or_gid_is_refused(tmp_path: Path) -> None:
    fx = s.build(tmp_path, group_rows=[f"{s.GROUP}:x:{s.NEW_GROUP_GID}:", f"{s.GROUP}:x:948:"])
    assert refusal(fx, fx.engine.preflight, fx.cfg, fx.host, fx.system).startswith("GROUP_DB_DUPLICATE")
    fx = s.build(tmp_path / "b", group_rows=[f"{s.GROUP}:x:{s.NEW_GROUP_GID}:", f"other:x:{s.NEW_GROUP_GID}:"])
    assert refusal(fx, fx.engine.preflight, fx.cfg, fx.host, fx.system).startswith("GROUP_DB_DUPLICATE")


def test_a_user_account_named_like_the_group_is_refused(tmp_path: Path) -> None:
    fx = s.build(tmp_path, passwd_extra=[f"{s.GROUP}:x:2000:2000::/nonexistent:/usr/bin/nologin"])
    assert refusal(fx, fx.engine.preflight, fx.cfg, fx.host, fx.system).startswith("GROUP_NAME_IS_USER")


def test_a_group_created_by_the_attempt_must_land_on_a_safe_gid(tmp_path: Path) -> None:
    fx = s.build(tmp_path)
    fx.system.new_gid = 1200  # groupadd produced a non-system gid
    assert refusal(fx, do_apply, fx).startswith("GROUP_GID_NOT_SYSTEM")
    do_rollback(fx)
    assert not any(r.startswith(f"{s.GROUP}:") for r in fx.host.read_text("/etc/group").splitlines())


# ── 3. happy path: exact mutation set ───────────────────────────────────────────────────────────────────────────────────


def test_apply_performs_the_exact_l7u_mutation_set(tmp_path: Path) -> None:
    fx = s.build(tmp_path)
    before = s.snapshot(fx)
    result = do_apply(fx)
    assert result["L7U_APPLY"] == "PASS"
    after = s.snapshot(fx)
    changed = {k for k in set(before) | set(after) if before.get(k) != after.get(k)}
    rel_new = s.NEW_LOGICAL.lstrip("/")
    allowed_prefix = (rel_new, "etc/group", "etc/aegis-idea3/core.env", "etc/systemd/system/aegis-idea3-core.service.d",
                      "etc/tmpfiles.d/aegis-idea3-recovery.conf", "run/aegis-idea3-recovery", "opt/aegis-idea3/current",
                      "opt/aegis-idea3/releases")
    for k in changed:
        assert k.startswith(allowed_prefix), k
    # the existing unit, every other release, credentials, /run/aegis-idea3 and /var/lib are byte-identical
    assert after["etc/systemd/system/aegis-idea3-core.service"] == before["etc/systemd/system/aegis-idea3-core.service"]
    assert after["run/aegis-idea3"] == before["run/aegis-idea3"]
    old = s.OLD_LOGICAL.lstrip("/")
    assert {k: v for k, v in after.items() if k.startswith(old)} == {k: v for k, v in before.items() if k.startswith(old)}
    assert fx.host.readlink("/opt/aegis-idea3/current") == s.NEW_LOGICAL
    assert fx.system.state.pid != 4242


def test_apply_creates_group_membership_dropin_tmpfiles_and_runtime_directory_with_exact_metadata(tmp_path: Path) -> None:
    fx = s.build(tmp_path)
    do_apply(fx)
    rows = {r.split(":")[0]: r.split(":") for r in fx.host.read_text("/etc/group").splitlines()}
    assert rows[s.GROUP][2] == str(s.NEW_GROUP_GID) and rows[s.GROUP][3] == s.OPERATOR
    assert fx.host.read_bytes(DROPIN) == s.DROPIN_TEMPLATE.read_bytes()
    assert fx.host.read_bytes(TMPFILES) == s.TMPFILES_TEMPLATE.read_bytes()
    for path in (DROPIN, TMPFILES):
        ident = fx.host.identity(path)
        assert (ident.mode, ident.uid, ident.gid) == (0o644, 0, 0)
    ident = fx.host.identity(RUNTIME)
    assert (ident.mode, ident.uid, ident.gid) == (0o750, s.CORE_UID, s.NEW_GROUP_GID)
    sock = fx.host.identity(SOCKET)
    assert stat.S_ISSOCK(os.lstat(fx.p(SOCKET)).st_mode)
    assert (sock.mode, sock.uid, sock.gid) == (0o660, s.CORE_UID, s.NEW_GROUP_GID)


def test_operator_primary_gid_is_never_used_as_the_socket_gid(tmp_path: Path) -> None:
    fx = s.build(tmp_path)
    do_apply(fx)
    env = fx.host.read_text(CORE_ENV)
    assert f"AEGIS_RECOVERY_SOCKET_GID={s.NEW_GROUP_GID}\n" in env
    assert f"AEGIS_RECOVERY_SOCKET_GID={s.OPERATOR_GID}" not in env and f"AEGIS_RECOVERY_SOCKET_GID={s.CORE_GID}" not in env


def test_the_operator_is_a_supplementary_not_primary_member_and_the_core_is_never_added_to_the_group_database(tmp_path: Path) -> None:
    fx = s.build(tmp_path)
    do_apply(fx)
    assert ("gpasswd_add", s.OPERATOR, s.GROUP) in fx.system.state.calls
    assert not any(c[0] == "gpasswd_add" and c[1] == "aegis-idea3" for c in fx.system.state.calls)
    assert f"{s.OPERATOR}:x:{s.OPERATOR_GID}:" in fx.host.read_text("/etc/group")  # operator primary group row unchanged


def test_the_core_process_really_gets_the_group_through_systemd_supplementary_groups(tmp_path: Path) -> None:
    fx = s.build(tmp_path)
    do_apply(fx)
    groups = fx.host.read_text(f"/proc/{fx.system.state.pid}/status")
    assert str(s.NEW_GROUP_GID) in groups.split("Groups:")[1].split()


# ── 4. core.env ───────────────────────────────────────────────────────────────────────────────────────────────────────────


def test_core_env_preserves_every_preexisting_byte_and_appends_only_the_three_owned_settings(tmp_path: Path) -> None:
    fx = s.build(tmp_path)
    pre = fx.host.read_bytes(CORE_ENV)
    do_apply(fx)
    post = fx.host.read_bytes(CORE_ENV)
    assert post.startswith(pre)
    suffix = post[len(pre):].decode().splitlines()
    assert suffix == [f"AEGIS_RECOVERY_OPERATOR_UID={s.OPERATOR_UID}", f"AEGIS_RECOVERY_SOCKET_GID={s.NEW_GROUP_GID}",
                      "AEGIS_RECOVERY_SOCKET=/run/aegis-idea3-recovery/recovery.sock"]
    ident = fx.host.identity(CORE_ENV)
    assert (ident.mode, ident.uid, ident.gid) == (0o640, 0, s.CORE_GID)


def test_the_three_existing_recovery_probe_settings_are_unchanged(tmp_path: Path) -> None:
    fx = s.build(tmp_path)
    do_apply(fx)
    lines = fx.host.read_text(CORE_ENV).splitlines()
    for key in ("MANAGEMENT_PROBE_TARGET", "NETWORK_PROBE_TARGETS", "WEB_READINESS_URL"):
        assert sum(1 for l in lines if l.startswith(f"AEGIS_RECOVERY_{key}=")) == 1
    assert [l for l in s.CORE_ENV_LINES if "RECOVERY_" in l] == [l for l in lines if "PROBE" in l or "WEB_READINESS" in l]


def test_no_env_value_or_secret_canary_reaches_journal_or_output(tmp_path: Path, capsys) -> None:
    fx = s.build(tmp_path)
    do_apply(fx)
    do_rollback(fx)
    blob = capsys.readouterr().out + capsys.readouterr().err
    for f in fx.work.rglob("*"):
        if f.is_file():
            blob += f.read_text(errors="replace")
    for canary in (s.ENV_SECRET_CANARY, s.PROBE_CANARY):
        assert canary not in blob


@pytest.mark.parametrize("line,code", [
    ("AEGIS_RECOVERY_OPERATOR_UID=0", "ENV_OWNED_KEY_UNEXPECTED_VALUE"),
    ("AEGIS_RECOVERY_SOCKET=/tmp/x.sock", "ENV_OWNED_KEY_UNEXPECTED_VALUE"),
    ("AEGIS_RECOVERY_SOCKET_GID=1000", "ENV_OWNED_KEY_UNEXPECTED_VALUE"),
    ("export AEGIS_RECOVERY_OPERATOR_UID=1000", "ENV_OWNED_KEY_UNEXPECTED_VALUE"),
    ("AEGIS_RECOVERY_OPERATOR_UID=\"1000\"", "ENV_OWNED_KEY_UNEXPECTED_VALUE"),
])
def test_an_owned_env_key_with_an_unexpected_value_fails_closed(tmp_path: Path, line: str, code: str) -> None:
    fx = s.build(tmp_path, env_lines=[*s.CORE_ENV_LINES, line])
    with pytest.raises(fx.engine.Refusal) as exc:
        do_apply(fx)
    assert str(exc.value).startswith(code) or str(exc.value).startswith("ENV_OWNED_KEY_WITHOUT_GROUP")
    assert not fx.work.exists() or not (fx.work / "production-mutation").exists()


def test_a_duplicate_owned_env_key_fails_closed_even_with_the_same_value(tmp_path: Path) -> None:
    fx = s.build(tmp_path, group_rows=[f"{s.GROUP}:x:{s.NEW_GROUP_GID}:"],
                 env_lines=[*s.CORE_ENV_LINES, "AEGIS_RECOVERY_OPERATOR_UID=1000", "AEGIS_RECOVERY_OPERATOR_UID=1000"])
    assert refusal(fx, fx.engine.preflight, fx.cfg, fx.host, fx.system).startswith("ENV_OWNED_KEY_DUPLICATE")


def test_a_commented_owned_key_is_not_a_setting(tmp_path: Path) -> None:
    fx = s.build(tmp_path, env_lines=[*s.CORE_ENV_LINES, "# AEGIS_RECOVERY_OPERATOR_UID=0"])
    fx.engine.preflight(fx.cfg, fx.host, fx.system)


def test_core_env_without_a_trailing_newline_fails_closed_rather_than_altering_the_last_line(tmp_path: Path) -> None:
    fx = s.build(tmp_path, env_newline=False)
    assert refusal(fx, fx.engine.preflight, fx.cfg, fx.host, fx.system).startswith("CORE_ENV_NOT_NEWLINE_TERMINATED")


@pytest.mark.parametrize("missing", ["AEGIS_RECOVERY_MANAGEMENT_PROBE_TARGET", "AEGIS_RECOVERY_NETWORK_PROBE_TARGETS", "AEGIS_RECOVERY_WEB_READINESS_URL"])
def test_a_missing_baseline_probe_setting_fails_closed_without_printing_values(tmp_path: Path, missing: str) -> None:
    fx = s.build(tmp_path, env_lines=[l for l in s.CORE_ENV_LINES if not l.startswith(missing + "=")])
    message = refusal(fx, fx.engine.preflight, fx.cfg, fx.host, fx.system)
    assert message.startswith("ENV_PROBE_KEY_MISSING") and s.PROBE_CANARY not in message


def test_core_env_that_is_a_symlink_is_refused(tmp_path: Path) -> None:
    fx = s.build(tmp_path)
    real = fx.p("/etc/aegis-idea3/real.env")
    os.replace(fx.p(CORE_ENV), real)
    os.symlink(real, fx.p(CORE_ENV))
    assert refusal(fx, fx.engine.preflight, fx.cfg, fx.host, fx.system).startswith("CORE_ENV_NOT_REGULAR")


# ── 5. atomic current switch ─────────────────────────────────────────────────────────────────────────────────────────────


def test_the_current_pointer_is_replaced_atomically_with_no_dangling_intermediate(tmp_path: Path) -> None:
    fx = s.build(tmp_path)
    seen: list[str] = []
    original = fx.host.symlink_atomic

    def spy(link: str, target: str) -> None:
        # the new target must already be a real installed release before the pointer is pointed at it
        seen.append(target)
        assert fx.host.lexists(target + "/RELEASE-MANIFEST.json")
        assert fx.host.lexists(link) and os.path.islink(fx.p(link))
        original(link, target)
        assert os.path.islink(fx.p(link)) and os.path.isdir(fx.p(target))

    fx.host.symlink_atomic = spy
    do_apply(fx)
    assert seen == [s.NEW_LOGICAL]
    leftovers = [p.name for p in fx.p("/opt/aegis-idea3").iterdir() if p.name != "current" and p.name != "releases"]
    assert leftovers == []


def test_the_switch_never_uses_unlink_then_symlink(tmp_path: Path) -> None:
    text = s.ENGINE_PATH.read_text()
    body = text[text.index("def symlink_atomic"):]
    body = body[:body.index("\n    def ", 10)]
    assert "self.replace(" in body and "os.unlink(" not in body and "os.remove(" not in body
    replace = text[text.index("    def replace"):]
    assert "os.replace" in replace[: replace.index("\n    def ", 10)]  # rename(2) over the old entry: atomic on one filesystem


def test_old_current_target_is_journaled_before_the_pointer_is_mutated(tmp_path: Path) -> None:
    fx = s.build(tmp_path)

    def boom(link: str, target: str) -> None:
        journal = [json.loads(l) for l in (fx.work / "journal.jsonl").read_text().splitlines()]
        entry = next(j for j in journal if j["kind"] == "CURRENT_SWITCH")
        assert entry["data"]["old_target"] == s.OLD_LOGICAL and entry["data"]["new_target"] == s.NEW_LOGICAL
        raise fx.engine.Refusal("INJECTED_SWITCH_FAILURE")

    fx.host.symlink_atomic = boom
    assert refusal(fx, do_apply, fx) == "INJECTED_SWITCH_FAILURE"
    assert fx.host.readlink("/opt/aegis-idea3/current") == s.OLD_LOGICAL


def test_the_old_immutable_release_is_never_mutated_or_removed(tmp_path: Path) -> None:
    fx = s.build(tmp_path)
    old = s.OLD_LOGICAL.lstrip("/")
    pre = {k: v for k, v in s.snapshot(fx).items() if k.startswith(old)}
    do_apply(fx)
    assert {k: v for k, v in s.snapshot(fx).items() if k.startswith(old)} == pre
    do_rollback(fx)
    assert {k: v for k, v in s.snapshot(fx).items() if k.startswith(old)} == pre


def test_the_new_release_is_installed_by_the_real_installer_once_and_guard_clean(tmp_path: Path) -> None:
    fx = s.build(tmp_path)
    do_apply(fx)
    guard = fx.engine.load_guard()
    assert guard.check(s.NEW_LOGICAL, fx.p(s.NEW_LOGICAL), "any") == (s.NEW_ID, s.MAIN)


# ── 6. restart + verification ────────────────────────────────────────────────────────────────────────────────────────────


def test_exactly_one_governed_core_restart_and_one_daemon_reload(tmp_path: Path) -> None:
    fx = s.build(tmp_path)
    do_apply(fx)
    verbs = [c[1] for c in fx.system.state.calls if c[0] == "systemctl"]
    assert verbs.count("restart") == 1 and verbs.count("daemon-reload") == 1
    assert not {"stop", "start", "enable", "disable", "mask", "reset-failed", "kill"} & set(verbs)
    assert verbs.index("daemon-reload") < verbs.index("restart")
    restart = next(c for c in fx.system.state.calls if c[0] == "systemctl" and c[1] == "restart")
    assert restart == ("systemctl", "restart", s.UNIT)


def test_apply_order_is_group_then_env_dropin_tmpfiles_then_switch_then_restart(tmp_path: Path) -> None:
    fx = s.build(tmp_path)
    do_apply(fx)
    kinds = [json.loads(l)["kind"] for l in (fx.work / "journal.jsonl").read_text().splitlines()]
    order = ["RELEASE_INSTALL", "GROUP", "MEMBERSHIP", "CORE_ENV", "DROPIN", "TMPFILES", "RUNTIME_DIR", "DAEMON_RELOAD", "CURRENT_SWITCH", "CORE_RESTART"]
    assert [k for k in kinds if k in order] == order


def test_verify_passes_after_a_good_apply_and_is_read_only(tmp_path: Path) -> None:
    fx = s.build(tmp_path)
    do_apply(fx)
    before = s.snapshot(fx)
    calls = len(fx.system.state.calls)
    assert fx.engine.verify(fx.cfg, fx.host, fx.system)["L7U_VERIFY"] == "PASS"
    assert s.snapshot(fx) == before
    assert {c[1] for c in fx.system.state.calls[calls:] if c[0] == "systemctl"} <= {"show"}


@pytest.mark.parametrize("mutation", ["socket_mode", "socket_gid", "dir_mode", "dir_gid", "env_gid", "current"])
def test_verify_detects_each_broken_contract(tmp_path: Path, mutation: str) -> None:
    fx = s.build(tmp_path)
    do_apply(fx)
    if mutation == "socket_mode":
        os.chmod(fx.p(SOCKET), 0o666)
    elif mutation == "socket_gid":
        fx.host.chown(SOCKET, -1, s.OPERATOR_GID)
    elif mutation == "dir_mode":
        os.chmod(fx.p(RUNTIME), 0o755)
    elif mutation == "dir_gid":
        fx.host.chown(RUNTIME, -1, s.OPERATOR_GID)
    elif mutation == "env_gid":
        text = fx.host.read_text(CORE_ENV).replace(f"SOCKET_GID={s.NEW_GROUP_GID}", f"SOCKET_GID={s.OPERATOR_GID}")
        fx.p(CORE_ENV).write_text(text)
    elif mutation == "current":
        os.unlink(fx.p("/opt/aegis-idea3/current"))
        os.symlink(s.OLD_LOGICAL, fx.p("/opt/aegis-idea3/current"))
    with pytest.raises(fx.engine.Refusal):
        fx.engine.verify(fx.cfg, fx.host, fx.system)


def test_verify_detects_a_core_without_the_supplementary_group(tmp_path: Path) -> None:
    fx = s.build(tmp_path, fail="no_supp_group")
    assert refusal(fx, do_apply, fx).startswith("CORE_PROCESS_LACKS_RECOVERY_GROUP")


# ── 7. failure → bounded rollback that restores the exact prestate ─────────────────────────────────────────────────────────


@pytest.mark.parametrize("fail,code", [
    ("restart_rc", "CORE_RESTART_FAILED"),
    ("unhealthy_after", "CORE_NOT_HEALTHY"),
    ("no_channel", "RECOVERY_CHANNEL_MISSING"),
    ("bad_socket_mode", "RECOVERY_CHANNEL_METADATA_INVALID"),
    ("no_supp_group", "CORE_PROCESS_LACKS_RECOVERY_GROUP"),
    ("daemon-reload", "DAEMON_RELOAD_FAILED"),
    ("tmpfiles", "TMPFILES_FAILED"),
    ("tmpfiles_wrong_mode", "RUNTIME_DIR_METADATA_INVALID"),
    ("groupadd", "GROUPADD_FAILED"),
    ("gpasswd_add", "GPASSWD_ADD_FAILED"),
])
def test_every_post_mutation_failure_is_rolled_back_to_the_exact_prestate(tmp_path: Path, fail: str, code: str) -> None:
    fx = s.build(tmp_path, fail=fail)
    before = s.snapshot(fx)
    assert refusal(fx, do_apply, fx).startswith(code)
    # rollback may start the OLD core again; that is part of the bounded rollback and never a retry of the upgrade
    fx.system.state.fail = ""
    result = do_rollback(fx)
    assert result["L7U_ROLLBACK"] == "PASS"
    assert s.snapshot(fx) == before
    assert fx.host.readlink("/opt/aegis-idea3/current") == s.OLD_LOGICAL
    assert not fx.p(s.NEW_LOGICAL).exists() and not fx.p(RUNTIME).exists()


def test_a_failure_before_the_core_restart_never_stops_or_restarts_the_core(tmp_path: Path) -> None:
    fx = s.build(tmp_path, fail="tmpfiles")
    refusal(fx, do_apply, fx)
    do_rollback(fx)
    verbs = [c[1] for c in fx.system.state.calls if c[0] == "systemctl"]
    assert "restart" not in verbs and "stop" not in verbs and "start" not in verbs
    assert fx.system.state.pid == 4242


def test_a_failed_restart_rollback_stops_then_starts_the_old_core_once_and_verifies_it(tmp_path: Path) -> None:
    fx = s.build(tmp_path, fail="unhealthy_after")
    refusal(fx, do_apply, fx)
    fx.system.state.fail = ""
    fx.system.state.nrestarts = 3
    do_rollback(fx)
    verbs = [c[1] for c in fx.system.state.calls if c[0] == "systemctl"]
    assert verbs.count("restart") == 1 and verbs.count("stop") == 1 and verbs.count("start") == 1
    st = fx.system.state
    assert (st.active, st.sub, st.enabled, st.result) == ("active", "running", "enabled", "success")
    assert not fx.p(SOCKET).exists()


def test_rollback_exits_nonzero_when_the_old_core_cannot_be_restored(tmp_path: Path) -> None:
    fx = s.build(tmp_path, fail="restart_rc")
    refusal(fx, do_apply, fx)
    fx.system.state.fail = "rollback_start"
    assert refusal(fx, do_rollback, fx).startswith("OLD_CORE_NOT_HEALTHY")


def test_rollback_restores_current_atomically_to_the_exact_old_target(tmp_path: Path) -> None:
    fx = s.build(tmp_path, fail="unhealthy_after")
    refusal(fx, do_apply, fx)
    fx.system.state.fail = ""
    seen: list[str] = []
    original = fx.host.symlink_atomic

    def spy(link: str, target: str) -> None:
        seen.append(target)
        original(link, target)
        assert os.path.isdir(fx.p(target))

    fx.host.symlink_atomic = spy
    do_rollback(fx)
    assert seen == [s.OLD_LOGICAL]


def test_rollback_removes_membership_only_if_this_attempt_added_it_and_the_group_only_if_it_created_it(tmp_path: Path) -> None:
    fx = s.build(tmp_path, fail="unhealthy_after")
    refusal(fx, do_apply, fx)
    fx.system.state.fail = ""
    do_rollback(fx)
    calls = fx.system.state.calls
    assert ("gpasswd_del", s.OPERATOR, s.GROUP) in calls and ("groupdel", s.GROUP) in calls
    assert [c for c in calls if c[0] in ("gpasswd_del", "groupdel")] == [("gpasswd_del", s.OPERATOR, s.GROUP), ("groupdel", s.GROUP)]


def test_adopted_group_with_unrelated_later_member_is_not_deleted_on_rollback(tmp_path: Path) -> None:
    fx = s.build(tmp_path, fail="unhealthy_after")
    refusal(fx, do_apply, fx)
    fx.system.state.fail = ""
    fx.system.gpasswd_add("mallory", s.GROUP)  # someone else joined the group during the window
    message = refusal(fx, do_rollback, fx)
    assert message.startswith("GROUP_IN_USE_REFUSING_DELETE")
    assert ("groupdel", s.GROUP) not in fx.system.state.calls


def test_rollback_refuses_unknown_current_state_before_changing_anything(tmp_path: Path) -> None:
    fx = s.build(tmp_path, fail="unhealthy_after")
    refusal(fx, do_apply, fx)
    os.unlink(fx.p("/opt/aegis-idea3/current"))
    os.symlink("/opt/aegis-idea3/releases/intruder", fx.p("/opt/aegis-idea3/current"))
    before = s.snapshot(fx)
    assert refusal(fx, do_rollback, fx).startswith("CURRENT_UNKNOWN_STATE")
    assert s.snapshot(fx) == before


@pytest.mark.parametrize("tamper", ["env", "dropin", "tmpfiles", "release", "journal_kind", "journal_path"])
def test_rollback_refuses_tampered_or_mismatched_state_and_changes_nothing(tmp_path: Path, tamper: str) -> None:
    fx = s.build(tmp_path, fail="unhealthy_after")
    refusal(fx, do_apply, fx)
    fx.system.state.fail = ""
    if tamper == "env":
        fx.p(CORE_ENV).write_text(fx.host.read_text(CORE_ENV).replace("AEGIS_PROFILE=production", "AEGIS_PROFILE=changed"))
    elif tamper == "dropin":
        fx.p(DROPIN).write_text("[Service]\nSupplementaryGroups=wheel\n")
    elif tamper == "tmpfiles":
        fx.p(TMPFILES).write_text("d /run/x 0777 root root -\n")
    elif tamper == "release":
        (fx.p(s.NEW_LOGICAL) / "aegis_soc/supervisor.py").write_text("evil\n")
    elif tamper == "journal_kind":
        with open(fx.work / "journal.jsonl", "a") as handle:
            handle.write(json.dumps({"seq": 99, "kind": "RM_RF", "phase": "intent", "data": {"path": "/"}}) + "\n")
    elif tamper == "journal_path":
        lines = (fx.work / "journal.jsonl").read_text().replace(s.NEW_LOGICAL, "/etc")
        (fx.work / "journal.jsonl").write_text(lines)
    before = s.snapshot(fx)
    with pytest.raises(fx.engine.Refusal):
        do_rollback(fx)
    assert s.snapshot(fx) == before


def test_rollback_restores_core_env_bytes_mode_owner_and_mtime_exactly(tmp_path: Path) -> None:
    fx = s.build(tmp_path, fail="unhealthy_after")
    pre = (fx.host.read_bytes(CORE_ENV), fx.host.identity(CORE_ENV))
    refusal(fx, do_apply, fx)
    fx.system.state.fail = ""
    do_rollback(fx)
    post = (fx.host.read_bytes(CORE_ENV), fx.host.identity(CORE_ENV))
    assert post == pre


def test_rollback_is_idempotent(tmp_path: Path) -> None:
    fx = s.build(tmp_path, fail="unhealthy_after")
    before = s.snapshot(fx)
    refusal(fx, do_apply, fx)
    fx.system.state.fail = ""
    do_rollback(fx)
    do_rollback(fx)
    assert s.snapshot(fx) == before


def test_rollback_without_a_journal_is_refused(tmp_path: Path) -> None:
    fx = s.build(tmp_path)
    assert refusal(fx, do_rollback, fx).startswith("JOURNAL_MISSING")


def test_a_stale_socket_left_by_the_failed_core_is_removed_but_only_if_it_is_a_socket(tmp_path: Path) -> None:
    fx = s.build(tmp_path, fail="unhealthy_after")
    refusal(fx, do_apply, fx)
    fx.system.state.fail = ""
    os.unlink(fx.p(SOCKET)) if fx.p(SOCKET).exists() else None
    fx.p(SOCKET).write_text("not a socket")  # a regular file planted in the directory
    before = s.snapshot(fx)
    assert refusal(fx, do_rollback, fx).startswith("RUNTIME_DIR_NOT_EMPTY")
    assert s.snapshot(fx) == before


def test_there_is_no_automatic_retry_after_a_failed_apply(tmp_path: Path) -> None:
    fx = s.build(tmp_path, fail="restart_rc")
    refusal(fx, do_apply, fx)
    assert [c[1] for c in fx.system.state.calls if c[0] == "systemctl"].count("restart") == 1
    # the work directory now exists, so a second apply against it is refused (one attempt, one work directory)
    assert refusal(fx, do_apply, fx).startswith("WORK_DIR_ALREADY_EXISTS")


def test_apply_refuses_to_start_when_the_work_directory_is_a_symlink_or_inside_etc(tmp_path: Path) -> None:
    fx = s.build(tmp_path)
    os.symlink(tmp_path, fx.work)
    assert refusal(fx, do_apply, fx).startswith("WORK_DIR")
    cfg = fx.engine.Config(**{**fx.cfg.__dict__, "work_dir": fx.root / "etc/leaky"})
    assert refusal(fx, fx.engine.apply, cfg, fx.host, fx.system).startswith("WORK_DIR")


# ── 8. real backend argv (no shell, exact verbs, nothing forbidden) ──────────────────────────────────────────────────────


def test_system_backend_issues_only_the_exact_reviewed_argv(monkeypatch) -> None:
    engine = s.load_engine()
    seen: list[list[str]] = []

    def fake_run(argv, **kwargs):
        assert kwargs.get("shell") is not True and isinstance(argv, list)
        seen.append(list(argv))
        return subprocess.CompletedProcess(argv, 0, "", "")

    monkeypatch.setattr(engine.subprocess, "run", fake_run)
    backend = engine.SystemBackend()
    backend.groupadd("aegis-idea3-recovery")
    backend.gpasswd_add("kittipat", "aegis-idea3-recovery")
    backend.gpasswd_del("kittipat", "aegis-idea3-recovery")
    backend.groupdel("aegis-idea3-recovery")
    backend.tmpfiles_create("/etc/tmpfiles.d/aegis-idea3-recovery.conf")
    for args in (("daemon-reload",), ("restart", s.UNIT), ("stop", s.UNIT), ("start", s.UNIT), ("reset-failed", s.UNIT)):
        backend.systemctl(*args)
    assert seen == [
        ["groupadd", "--system", "aegis-idea3-recovery"],
        ["gpasswd", "-a", "kittipat", "aegis-idea3-recovery"],
        ["gpasswd", "-d", "kittipat", "aegis-idea3-recovery"],
        ["groupdel", "aegis-idea3-recovery"],
        ["systemd-tmpfiles", "--create", "/etc/tmpfiles.d/aegis-idea3-recovery.conf"],
        ["systemctl", "daemon-reload"], ["systemctl", "restart", s.UNIT], ["systemctl", "stop", s.UNIT],
        ["systemctl", "start", s.UNIT], ["systemctl", "reset-failed", s.UNIT],
    ]


@pytest.mark.parametrize("args", [("restart", "sshd.service"), ("stop", "twingate.service"), ("enable", s.UNIT), ("mask", s.UNIT),
                                  ("reset-failed",), ("kill", s.UNIT), ("isolate", "rescue.target"), ("poweroff",)])
def test_system_backend_refuses_any_other_systemctl_verb_or_unit(args) -> None:
    engine = s.load_engine()
    with pytest.raises(engine.Refusal):
        engine.SystemBackend().systemctl(*args)


@pytest.mark.parametrize("name", ["wheel", "root", "aegis-idea3", "sudo", "../x", "a b", ""])
def test_system_backend_only_manages_the_dedicated_group(name: str) -> None:
    engine = s.load_engine()
    backend = engine.SystemBackend()
    for call in (backend.groupadd, backend.groupdel):
        with pytest.raises(engine.Refusal):
            call(name)
    with pytest.raises(engine.Refusal):
        backend.gpasswd_add("kittipat", name)


def test_system_backend_only_creates_the_reviewed_tmpfiles_rule() -> None:
    engine = s.load_engine()
    for path in ("/etc/tmpfiles.d/evil.conf", "/usr/lib/tmpfiles.d/aegis-idea3-recovery.conf", "/tmp/x.conf"):
        with pytest.raises(engine.Refusal):
            engine.SystemBackend().tmpfiles_create(path)


# ── 9. static safety of the engine itself ───────────────────────────────────────────────────────────────────────────────


def test_engine_has_no_forbidden_operations() -> None:
    text = "\n".join(l for l in s.ENGINE_PATH.read_text().splitlines() if not l.lstrip().startswith("#"))
    for pat in (r"shell\s*=\s*True", r"os\.system", r"\bsudo\b", r"esptool", r"platformio", r"pyserial|import serial", r"/dev/tty",
                r"CUT_UPLINK", r"RESTORE_UPLINK", r"\bnft\b", r"nmcli", r"mosquitto", r"twingate", r"rm\s+-", r"shutil\.rmtree",
                r"IDEA1-", r"IDEA2-", r"aegis-detection", r"\benable\b.*systemctl", r"\bmask\b", r"/dev/urandom", r"secrets\.token"):
        assert not re.search(pat, text), pat


def test_engine_cli_has_no_host_root_option_so_a_live_run_cannot_be_redirected() -> None:
    text = s.ENGINE_PATH.read_text()
    assert "--host-root" not in text and "--fixture" not in text
    res = subprocess.run([sys.executable, str(s.ENGINE_PATH), "apply", "--help"], capture_output=True, text=True, check=False)
    assert "--host-root" not in res.stdout


def test_engine_cli_refuses_without_root_and_the_live_flag(tmp_path: Path) -> None:
    res = subprocess.run([sys.executable, str(s.ENGINE_PATH), "apply", "--old-release-id", s.OLD_ID, "--new-release-id", s.NEW_ID,
                          "--expected-main", s.MAIN, "--source-dir", str(tmp_path), "--work-dir", str(tmp_path / "w"),
                          "--operator-user", "kittipat", "--operator-uid", "1000"], capture_output=True, text=True,
                         env={"PATH": os.environ["PATH"]}, check=False)
    assert res.returncode != 0 and "LIVE_AUTHORIZATION_FLAG_REQUIRED" in res.stdout + res.stderr
    assert not (tmp_path / "w").exists()


def test_a_runtime_directory_that_the_operator_cannot_traverse_is_caught_before_the_core_is_restarted(tmp_path: Path) -> None:
    """UMask 0077 regression: the stage pre-provisions the directory and VERIFIES 0750 + group BEFORE restarting; it never relies on the
    application's mkdir (which would create 0700 under the Core's UMask=0077)."""
    fx = s.build(tmp_path, fail="tmpfiles_wrong_mode")
    assert refusal(fx, do_apply, fx).startswith("RUNTIME_DIR_METADATA_INVALID")
    assert "restart" not in [c[1] for c in fx.system.state.calls if c[0] == "systemctl"]


def test_the_runtime_directory_exists_with_the_exact_contract_before_the_restart_call(tmp_path: Path) -> None:
    fx = s.build(tmp_path)
    original = fx.system.systemctl
    seen = {}

    def spy(*args):
        if args[0] == "restart":
            ident = fx.host.identity(RUNTIME)
            seen["runtime"] = (ident.mode, ident.uid, ident.gid)
            seen["dropin"] = fx.host.lexists(DROPIN)
            seen["env"] = "AEGIS_RECOVERY_SOCKET=" in fx.host.read_text(CORE_ENV)
            seen["current"] = fx.host.readlink("/opt/aegis-idea3/current")
        return original(*args)

    fx.system.systemctl = spy
    do_apply(fx)
    assert seen == {"runtime": (0o750, s.CORE_UID, s.NEW_GROUP_GID), "dropin": True, "env": True, "current": s.NEW_LOGICAL}
