"""F1 deployment package: identity, detector unit, core.env contract, safe start order, bounded rollback (all repository-side, fixture-only).

Nothing here starts a process, touches systemd, a real core.env or the Core: the tool is driven through a fake Host/Backend, and the one
subprocess use is the tool's own CLI refusing before it acts or the read-only helper CLIs on temporary files. F1 stays NOT deployed.
"""

from __future__ import annotations

import ast
import importlib.util
import os
import re
import shutil
import stat
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))
import l7u_support as s

ROOT = Path(__file__).resolve().parents[1]
TOOL_PATH = ROOT / "deploy" / "pr11-phase4" / "p4-f1-alert-source.py"
ENV_TOOL = ROOT / "deploy" / "pr11-phase4" / "p4-l7-core-env.py"
EXAMPLE = ROOT / "deploy" / "aegis-idea3-core.env.example"
UNIT_EXAMPLE = ROOT / "deploy" / "aegis-idea3-detector.service.example"
CORE_UID = 952
KEY = "AEGIS_ALERT_SOURCE_UID"



def load_tool():
    spec = importlib.util.spec_from_file_location("p4_f1_alert_source", TOOL_PATH)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


tool = load_tool()
DETECTOR_UID = s.DETECTOR_UID
ALERT_GID = 948
CORE_UID = s.CORE_UID


_REAL_RUN = subprocess.run


@pytest.fixture(autouse=True)
def _never_start_a_real_process(monkeypatch):
    real_run = subprocess.run

    def guarded(argv, *args, **kwargs):
        if isinstance(argv, (list, tuple)) and argv and argv[0] == sys.executable:
            return real_run(argv, *args, **kwargs)
        raise AssertionError(f"a real process must never be started by the F1 package tests: {argv!r}")

    monkeypatch.setattr(subprocess, "run", guarded)


def code_only(path: Path) -> str:
    tree = ast.parse(path.read_text())
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.FunctionDef, ast.ClassDef)) and ast.get_docstring(node, clean=False):
            node.body = node.body[1:] or [ast.Pass()]
    return ast.unparse(tree)


def refusal(fn, *args, **kwargs) -> str:
    with pytest.raises(tool.Refusal) as exc:
        fn(*args, **kwargs)
    return str(exc.value)


def rendered_unit() -> str:
    return tool.render_unit(UNIT_EXAMPLE.read_bytes()).decode()


# ═══ identity (OD-F1-DEPLOY-01): the dedicated non-root account at the owner-frozen uid ═════════════════════════════════════════


@pytest.mark.parametrize("bad", ["", " ", "-1", "+5", "01", "00", " 5", "5 ", "0x10", "1e3", "1.0", "4294967295", "99999999999", "٣", "root", "5\n", "5;6"])
def test_malformed_uid_is_refused(bad):
    assert refusal(tool.parse_uid, bad) == "ALERT_SOURCE_UID_INVALID"


@pytest.mark.parametrize("good,value", [("1", 1), ("953", 953), ("4294967294", 4294967294)])
def test_canonical_decimal_uids_are_accepted(good, value):
    assert tool.parse_uid(good) == value


def test_the_tool_and_the_core_env_helper_share_one_uid_syntax_contract():
    helper = importlib.util.spec_from_file_location("h", ENV_TOOL)
    module = importlib.util.module_from_spec(helper)
    helper.loader.exec_module(module)
    for candidate in ("0", "7", "01", "-1", "4294967295", "x", ""):
        assert module.valid_alert_uid(candidate) == (candidate in ("0", "7"))
        try:
            tool.parse_uid(candidate)
            ok = True
        except tool.Refusal:
            ok = False
        assert ok == module.valid_alert_uid(candidate)


def test_the_account_and_group_names_are_fixed_constants_never_an_input_or_a_default_uid():
    assert (tool.DETECTOR_ACCOUNT, tool.ALERT_GROUP) == ("aegis-idea3-detector", "aegis-idea3-alert")
    source = code_only(TOOL_PATH)
    assert not re.search(r"useradd|groupadd|usermod|getent|adduser", source)
    assert "DEFAULT_UID" not in source
    parser_text = source[source.index("def main("):]
    assert "--account" not in parser_text and "--user" not in parser_text and "--group" not in parser_text


class FakeAccounts(tool.Host):
    def __init__(self, users=None, groups=None):
        self.users = {tool.DETECTOR_ACCOUNT: DETECTOR_UID} if users is None else users
        self.groups = {tool.ALERT_GROUP: ALERT_GID} if groups is None else groups

    def resolve_user(self, name):
        return self.users.get(name)

    def resolve_group(self, name):
        return self.groups.get(name)


def test_the_exact_account_must_resolve_to_exactly_the_frozen_uid():
    tool.verify_account(FakeAccounts(), DETECTOR_UID, CORE_UID)


def test_a_missing_detector_account_is_refused():
    assert refusal(tool.verify_account, FakeAccounts(users={}), DETECTOR_UID, CORE_UID) == "DETECTOR_ACCOUNT_MISSING"
    assert refusal(tool.verify_account, FakeAccounts(users={"some-other-name": DETECTOR_UID}), DETECTOR_UID, CORE_UID) == "DETECTOR_ACCOUNT_MISSING"


def test_a_uid_mismatch_with_the_account_is_refused():
    assert refusal(tool.verify_account, FakeAccounts(users={tool.DETECTOR_ACCOUNT: 954}), DETECTOR_UID, CORE_UID) == "DETECTOR_UID_MISMATCH"


def test_root_is_refused_even_when_the_account_name_resolves_to_it():
    assert refusal(tool.verify_account, FakeAccounts(users={tool.DETECTOR_ACCOUNT: 0}), 0, CORE_UID) == "ALERT_SOURCE_IS_ROOT"
    assert refusal(tool.verify_identity, 0, CORE_UID) == "ALERT_SOURCE_IS_ROOT"


def test_the_core_account_is_refused():
    assert refusal(tool.verify_account, FakeAccounts(users={tool.DETECTOR_ACCOUNT: CORE_UID}), CORE_UID, CORE_UID) == "ALERT_SOURCE_IS_CORE_ACCOUNT"
    assert refusal(tool.verify_identity, DETECTOR_UID, 0) == "CORE_UID_INVALID"


def test_no_arbitrary_username_is_ever_consulted():
    seen = []

    class Spy(FakeAccounts):
        def resolve_user(self, name):
            seen.append(name)
            return super().resolve_user(name)

    tool.verify_account(Spy(), DETECTOR_UID, CORE_UID)
    assert seen == [tool.DETECTOR_ACCOUNT]


# ═══ connectability: filesystem reachability through the GROUP, never a capability, never an authorization ═════════════════════


def test_connectability_follows_plain_dac_with_the_group_and_no_root_special_case():
    kw = {"socket_uid": CORE_UID, "socket_gid": ALERT_GID, "socket_mode": 0o620, "dir_uid": CORE_UID, "dir_gid": ALERT_GID, "dir_mode": 0o2750}
    assert tool.can_connect(DETECTOR_UID, (ALERT_GID,), **kw)  # reachability through the supplementary group
    assert not tool.can_connect(DETECTOR_UID, (), **kw)  # without the group: no access
    assert not tool.can_connect(0, (), **kw)  # root has NO DAC override here (the capability is forbidden)
    assert not tool.can_connect(DETECTOR_UID, (ALERT_GID,), **{**kw, "socket_mode": 0o600})  # group write is the connect right
    assert not tool.can_connect(DETECTOR_UID, (ALERT_GID,), **{**kw, "dir_mode": 0o2700})  # group traverse is required
    assert tool.can_connect(CORE_UID, (), **kw)


def test_the_frozen_surface_constants_are_the_narrow_owner_approved_contract():
    assert tool.RUNTIME_DIR == "/run/aegis-idea3-alert" and tool.SOCKET_PATH == "/run/aegis-idea3-alert/alert.sock"
    assert tool.RUNTIME_DIR_MODE == 0o2750 and tool.SOCKET_MODE == 0o620
    assert not tool.RUNTIME_DIR_MODE & 0o027 and not tool.SOCKET_MODE & 0o007  # no group write on the directory, nothing for others
    assert tool.SOCKET_MODE & 0o020 and not tool.SOCKET_MODE & 0o040  # the group may connect (write) but not read


def test_the_group_alone_never_authorizes_an_alert_the_core_side_stays_exact_uid():
    from aegis_soc import recovery_core

    source = code_only(ROOT / "aegis_soc" / "recovery_core.py")
    assert "allowed_uid" in source and "SO_PEERCRED" in source
    # the sink-side and package-side surfaces never grant authority from a group id
    for path in (TOOL_PATH, ROOT / "aegis_soc" / "alert_sink.py"):
        text = code_only(path)
        assert "getgrouplist" not in text and "os.getgroups" not in text
    assert recovery_core.ALERT_CHANNEL_NAME == "alert.sock"


# ═══ detector unit: static contract ══════════════════════════════════════════════════════════════════════════════════════════


def test_the_unit_is_static_names_the_dedicated_account_and_has_no_placeholder():
    text = UNIT_EXAMPLE.read_text()
    assert "@" not in "".join(tool._active_lines(text))
    lines = tool._active_lines(text)
    assert "User=aegis-idea3-detector" in lines and not any(line.startswith("Group=") for line in lines)
    assert not re.search(r"^User=\d", text, re.MULTILINE) and not re.search(r"^User=root", text, re.MULTILINE)
    assert rendered_unit() == text


def test_cap_dac_override_is_absent_and_no_capability_of_any_kind_is_held():
    text = UNIT_EXAMPLE.read_text()
    assert "CAP_DAC_OVERRIDE" not in text and "cap_dac_override" not in text.lower()
    lines = tool._active_lines(text)
    assert "CapabilityBoundingSet=" in lines and "AmbientCapabilities=" in lines  # both present and EMPTY
    assert not any("CAP_" in line for line in lines)  # no substitute broad capability
    assert "NoNewPrivileges=true" in lines
    assert not any(line.startswith(("User=root", "User=0")) for line in lines)  # the detector stays non-root


def test_the_detector_gets_filesystem_access_through_the_alert_group_and_no_other_transport_group():
    lines = tool._active_lines(UNIT_EXAMPLE.read_text())
    groups = [line for line in lines if line.startswith("SupplementaryGroups=")]
    assert len(groups) == 1
    names = groups[0].split("=", 1)[1].split()
    assert names[0] == "aegis-idea3-alert"  # the one alert transport group
    assert set(names) == {"aegis-idea3-alert", "systemd-journal"}  # journal = journalctl access only; no recovery/core/other group
    assert "aegis-idea3-recovery" not in names and "aegis-idea3" not in names


def test_the_unit_uses_only_the_dedicated_alert_path_never_the_general_runtime_path():
    text = UNIT_EXAMPLE.read_text()
    assert "/run/aegis-idea3-alert" in text
    assert not re.search(r"/run/aegis-idea3(?![-\w])", text)  # the general runtime directory is not mentioned at all
    assert "recovery" not in "\n".join(tool._active_lines(text)).lower()


def test_the_rendered_unit_passes_and_is_deterministic():
    assert rendered_unit() == rendered_unit()
    tool.verify_unit(rendered_unit().encode())


def test_the_unit_is_af_unix_only_without_mqtt_network_secrets_or_shell():
    lines = tool._active_lines(rendered_unit())
    blob = "\n".join(lines).lower()
    for token in ("mqtt", "1883", "8883", "attacker_ip", "paho", "environmentfile", "loadcredential", "/bin/sh", "bash", "af_inet",
                  "restore", "containment", "nft", "iptables", "execstartpost", "execstop=", "execreload"):
        assert token not in blob, token
    assert not re.search(r"\bcut\b", blob)
    assert "RestrictAddressFamilies=AF_UNIX" in lines and "NoNewPrivileges=true" in lines and "CapabilityBoundingSet=" in lines
    assert sum(1 for line in lines if line.startswith("ExecStart=")) == 1 and not any(re.search(r"[;&|`$]", line) for line in lines)


def test_the_unit_enforces_core_first_ordering_and_never_restarts_itself():
    lines = tool._active_lines(rendered_unit())
    assert "Requires=aegis-idea3-core.service" in lines and "After=aegis-idea3-core.service" in lines
    assert "Restart=no" in lines and not any(line.startswith("Restart=") and line != "Restart=no" for line in lines)
    pre = next(line for line in lines if line.startswith("ExecStartPre="))
    assert pre.endswith("-m aegis_soc.alert_sink check-socket --wait-sec 15")
    wait = int(re.search(r"--wait-sec (\d+)", pre).group(1))
    assert 0 < wait <= 60
    timeout = int(next(line for line in lines if line.startswith("TimeoutStartSec=")).split("=")[1])
    assert timeout > wait
    assert not any(line.startswith("ConditionPath") for line in lines)  # a skipped condition would be a SILENT non-start


def test_the_unit_runs_nothing_but_the_release_python_modules():
    lines = tool._active_lines(rendered_unit())
    execs = [line.split("=", 1)[1] for line in lines if line.startswith(("ExecStartPre=", "ExecStart="))]
    assert all(e.startswith("/opt/aegis-idea3/current/venv/bin/python -m aegis_soc.") for e in execs)
    assert not any(line.startswith(("EnvironmentFile=", "Environment=", "ReadWritePaths=")) for line in lines)


def _mutations():
    base = rendered_unit()
    return {
        "mqtt_env": base.replace("[Service]", "[Service]\nEnvironment=AEGIS_BROKER_PORT=1883"),
        "mqtt_topic_exec": base.replace("production_detector", "production_detector --topic aegis/attacker_ip"),
        "shell_exec": base.replace("ExecStart=/opt/aegis-idea3/current/venv/bin/python -m aegis_soc.production_detector", "ExecStart=/bin/sh -c 'x'"),
        "chained": base.replace("production_detector", "production_detector; id"),
        "af_inet": base.replace("RestrictAddressFamilies=AF_UNIX", "RestrictAddressFamilies=AF_UNIX AF_INET"),
        "restart_always": base.replace("Restart=no", "Restart=always"),
        "no_requires": base.replace("Requires=aegis-idea3-core.service\n", ""),
        "no_pre_check": base.replace("ExecStartPre=", "#ExecStartPre="),
        "second_user": base.replace("[Service]", "[Service]\nUser=root"),
        "root_user": base.replace("User=aegis-idea3-detector", "User=root"),
        "numeric_user": base.replace("User=aegis-idea3-detector", "User=953"),
        "core_user": base.replace("User=aegis-idea3-detector", "User=aegis-idea3"),
        "group": base.replace("[Service]", "[Service]\nGroup=aegis-idea3"),
        "envfile": base.replace("[Service]", "[Service]\nEnvironmentFile=/etc/aegis-idea3/core.env"),
        "credential": base.replace("[Service]", "[Service]\nLoadCredential=k_c2d:/etc/aegis-idea3/credentials/k_c2d"),
        "post_hook": base.replace("[Service]", "[Service]\nExecStartPost=/usr/bin/true"),
        "restore_word": base.replace("[Service]", "[Service]\nDescription=RESTORE"),
        "cut_word": base.replace("Description=AEGIS IDEA3 F1 production detector (Core alert source)", "Description=CUT now"),
        "dac_override_returns": base.replace("CapabilityBoundingSet=\n", "CapabilityBoundingSet=CAP_DAC_OVERRIDE\n"),
        "dac_override_in_comment": base.replace("[Unit]", "# CAP_DAC_OVERRIDE\n[Unit]"),
        "caps_widened": base.replace("CapabilityBoundingSet=\n", "CapabilityBoundingSet=CAP_NET_ADMIN\n"),
        "ambient_cap": base.replace("AmbientCapabilities=\n", "AmbientCapabilities=CAP_NET_BIND_SERVICE\n"),
        "bounding_set_dropped": base.replace("CapabilityBoundingSet=\n", ""),
        "ambient_dropped": base.replace("AmbientCapabilities=\n", ""),
        "recovery_group": base.replace("SupplementaryGroups=aegis-idea3-alert systemd-journal", "SupplementaryGroups=aegis-idea3-alert aegis-idea3-recovery"),
        "core_group": base.replace("SupplementaryGroups=aegis-idea3-alert systemd-journal", "SupplementaryGroups=aegis-idea3-alert aegis-idea3"),
        "alert_group_missing": base.replace("SupplementaryGroups=aegis-idea3-alert systemd-journal", "SupplementaryGroups=systemd-journal"),
        "second_group_line": base.replace("[Service]", "[Service]\nSupplementaryGroups=wheel"),
        "no_nnp": base.replace("NoNewPrivileges=true", "NoNewPrivileges=false"),
        "wantedby": base.replace("WantedBy=multi-user.target", "WantedBy=default.target"),
        "rw_paths": base.replace("[Service]", "[Service]\nReadWritePaths=/run/aegis-idea3-alert"),
        "second_execstart": base.replace("[Service]", "[Service]\nExecStart=/usr/bin/true"),
    }


@pytest.mark.parametrize("name", sorted(_mutations()))
def test_unit_mutations_are_refused(name):
    assert refusal(tool.verify_unit, _mutations()[name].encode())


@pytest.mark.skipif(shutil.which("systemd-analyze") is None, reason="systemd-analyze not installed")
def test_systemd_analyze_verify_accepts_the_rendered_unit(tmp_path, monkeypatch):
    unit = tmp_path / tool.DETECTOR_UNIT
    unit.write_text(rendered_unit())
    monkeypatch.setattr(subprocess, "run", _REAL_RUN)  # the verifier is read-only and offline; the autouse guard is lifted for exactly this test
    done = subprocess.run(["systemd-analyze", "verify", "--man=no", str(unit)], capture_output=True, text=True, check=False)
    assert done.returncode == 0, done.stderr



# ═══ core.env contract (through the canonical helper, not an ad-hoc .env) ═════════════════════════════════════════════════════

AP, DEVICE, NAME = "10.77.30.1", "aegis-relay-01", "mqtt.aegis.home.arpa"


def env_cli(command: str, tmp_path: Path, *extra: str, file: Path | None = None):
    args = [sys.executable, str(ENV_TOOL), command, "--ap-address", AP, "--device-id", DEVICE, "--server-name", NAME, *extra]
    if command == "render":
        args += ["--example", str(EXAMPLE), "--output", str(tmp_path / "core.env")]
    else:
        args += ["--file", str(file or tmp_path / "core.env")]
    return subprocess.run(args, capture_output=True, text=True, check=False)


def render_env(tmp_path: Path, uid: str | None = None) -> Path:
    extra = [] if uid is None else ["--alert-source-uid", uid]
    done = env_cli("render", tmp_path, *extra)
    assert done.returncode == 0, done.stdout + done.stderr
    return tmp_path / "core.env"


def test_the_example_leaves_the_uid_unset_and_documents_it():
    active = [line for line in EXAMPLE.read_text().splitlines() if line.strip() and not line.startswith("#")]
    assert not any(line.startswith(KEY) for line in active)
    assert KEY in EXAMPLE.read_text() and "OWNER_INPUT_REQUIRED" in EXAMPLE.read_text()


def test_render_without_the_owner_value_is_byte_identical_to_before(tmp_path):
    plain = render_env(tmp_path).read_text()
    assert KEY not in "\n".join(line for line in plain.splitlines() if not line.startswith("#"))


def test_render_with_the_uid_adds_exactly_one_line_and_changes_nothing_else(tmp_path):
    a, b = tmp_path / "a", tmp_path / "b"
    a.mkdir()
    b.mkdir()
    plain = render_env(a).read_text()
    with_uid = render_env(b, "0").read_text()
    assert with_uid == plain + f"{KEY}=0\n"
    assert stat.S_IMODE((b / "core.env").stat().st_mode) == 0o600


def test_check_accepts_the_exact_uid_and_still_passes_without_the_flag_when_the_key_is_well_formed(tmp_path):
    path = render_env(tmp_path, "952")
    done = env_cli("check", tmp_path, "--alert-source-uid", "952")
    assert done.returncode == 0 and "L7_CORE_ENV=PASS" in done.stdout
    assert env_cli("check", tmp_path).returncode == 0  # an installed key stays acceptable to the pre-existing L7 verification
    assert sum(1 for line in path.read_text().splitlines() if line.startswith(f"{KEY}=")) == 1


def test_missing_required_deployment_value_fails_the_deployment_preflight(tmp_path):
    render_env(tmp_path)
    done = env_cli("check", tmp_path, "--alert-source-uid", "952")
    assert done.returncode == 1 and "reason=REQUIRED_KEY_MISSING" in done.stdout
    assert refusal(tool.verify_env, (tmp_path / "core.env").read_bytes(), 952) == "ALERT_SOURCE_UID_MISSING"


def test_without_the_flag_a_file_lacking_the_key_still_passes_the_legacy_l7_check(tmp_path):
    render_env(tmp_path)
    assert env_cli("check", tmp_path).returncode == 0  # F1 inert; existing L7 evidence/tests keep their meaning


@pytest.mark.parametrize("bad", ["", "-1", "01", " 5", "0x1", "abc", "4294967295", "5 6", "1.0"])
def test_malformed_uid_values_are_refused_by_render_and_check(tmp_path, bad):
    done = env_cli("render", tmp_path, "--alert-source-uid", bad)
    assert done.returncode == 1 and "ALERT_SOURCE_UID_INVALID" in done.stdout and not (tmp_path / "core.env").exists()
    path = render_env(tmp_path)
    path.write_text(path.read_text() + f"{KEY}={bad}\n")
    done = env_cli("check", tmp_path)
    assert done.returncode == 1 and "reason=ALERT_SOURCE_UID_INVALID" in done.stdout
    assert refusal(tool.verify_env, path.read_bytes(), 952) in {"ALERT_SOURCE_UID_INVALID", "CORE_ENV_LINE_MALFORMED"}


def test_duplicate_uid_lines_are_refused_by_the_helper_and_the_tool(tmp_path):
    path = render_env(tmp_path, "0")
    path.write_text(path.read_text() + f"{KEY}=0\n")
    assert "reason=DUPLICATE_KEY" in env_cli("check", tmp_path, "--alert-source-uid", "0").stdout
    assert refusal(tool.verify_env, path.read_bytes(), 952) == "ALERT_SOURCE_UID_DUPLICATE"
    path.write_text(path.read_text().replace(f"{KEY}=0\n", "", 1) + f"{KEY}=7\n")
    assert refusal(tool.verify_env, path.read_bytes(), 952) == "ALERT_SOURCE_UID_DUPLICATE"


def test_a_different_installed_uid_is_a_mismatch(tmp_path):
    render_env(tmp_path, "952")
    done = env_cli("check", tmp_path, "--alert-source-uid", "0")
    assert done.returncode == 1 and "reason=VALUE_INVALID" in done.stdout


def test_the_key_is_part_of_the_canonical_allowlist_and_unknown_keys_are_still_refused(tmp_path):
    helper = importlib.util.spec_from_file_location("h2", ENV_TOOL)
    module = importlib.util.module_from_spec(helper)
    helper.loader.exec_module(module)
    assert KEY in module.ALLOWED and KEY not in module.FIXED and KEY not in module.FORBIDDEN
    path = render_env(tmp_path, "0")
    path.write_text(path.read_text() + "AEGIS_ALERT_SOURCE_GID=5\n")
    assert "reason=UNKNOWN_KEY" in env_cli("check", tmp_path, "--alert-source-uid", "0").stdout


@pytest.mark.parametrize("secret", ["AEGIS_MQTT_PASS", "AEGIS_ADMIN_PIN", "AEGIS_P1_C2D_KEY_FILE", "AEGIS_P1_D2C_KEY_FILE", "AEGIS_TG_TOKEN"])
def test_secret_bearing_keys_stay_forbidden_even_with_the_uid_present(tmp_path, secret):
    path = render_env(tmp_path, "0")
    path.write_text(path.read_text() + f"{secret}=CANARY-secret\n")
    done = env_cli("check", tmp_path, "--alert-source-uid", "0")
    assert done.returncode == 1 and "reason=FORBIDDEN_KEY" in done.stdout and "CANARY" not in done.stdout + done.stderr
    assert refusal(tool.verify_env, path.read_bytes(), 952) == "CORE_ENV_FORBIDDEN_KEY"


def test_unrelated_fixed_production_settings_are_unchanged_by_the_uid(tmp_path):
    path = render_env(tmp_path, "0")
    for needle, replacement in (("AEGIS_AUTO_CONTAIN=0", "AEGIS_AUTO_CONTAIN=1"), ("AEGIS_PROFILE=production", "AEGIS_PROFILE=lab"),
                                ("AEGIS_MQTT_TLS=1", "AEGIS_MQTT_TLS=0"), ("AEGIS_BROKER_PORT=8883", "AEGIS_BROKER_PORT=1883")):
        good = path.read_text()
        path.write_text(good.replace(needle, replacement))
        done = env_cli("check", tmp_path, "--alert-source-uid", "0")
        assert done.returncode == 1 and "reason=VALUE_INVALID" in done.stdout, needle
        path.write_text(good)


def test_verify_env_never_echoes_values(tmp_path, capsys):
    path = render_env(tmp_path, "952")
    code = tool.main(["verify-env", "--uid", "953", "--file", str(path)])
    out = capsys.readouterr()
    assert code == 1 and "952" not in out.out + out.err and "ALERT_SOURCE_UID_MISMATCH" in out.err


def test_verify_env_rejects_export_and_indentation_forms():
    for line in (f"export {KEY}=0", f" {KEY}=0", f"{KEY} =0"):
        assert refusal(tool.verify_env, f"{line}\n".encode(), 952) == "ALERT_SOURCE_UID_INVALID"


def test_verify_env_checks_the_identity_when_the_core_uid_is_known():
    env = f"{KEY}=953\n".encode()
    tool.verify_env(env, 953, core_uid=CORE_UID)
    assert refusal(tool.verify_env, f"{KEY}=0\n".encode(), 0, core_uid=CORE_UID) == "ALERT_SOURCE_IS_ROOT"
    assert refusal(tool.verify_env, f"{KEY}={CORE_UID}\n".encode(), CORE_UID, core_uid=CORE_UID) == "ALERT_SOURCE_IS_CORE_ACCOUNT"



# ═══ ordering: Core first, socket verified, then (and only then) the detector ═══════════════════════════════════════════════


class FakeStat:
    def __init__(self, mode, uid, gid, kind=stat.S_IFDIR):
        self.st_mode, self.st_uid, self.st_gid = kind | mode, uid, gid


class FakeHost(FakeAccounts):
    def __init__(self, *, env_uid=str(DETECTOR_UID), socket_mode=0o620, socket_owner=CORE_UID, socket_gid=ALERT_GID, socket_kind=stat.S_IFSOCK,
                 with_socket=True, running_env_uid=str(DETECTOR_UID), dir_mode=0o2750, dir_gid=ALERT_GID, unit=None, users=None, groups=None,
                 proc_groups=(CORE_UID, ALERT_GID)):
        super().__init__(users, groups)
        self.files = {
            tool.CORE_ENV: (f"AEGIS_PROFILE=production\n{KEY}={env_uid}\n".encode() if env_uid is not None else b"AEGIS_PROFILE=production\n"),
            tool.UNIT_PATH: (unit if unit is not None else rendered_unit().encode()),
        }
        self.stats = {tool.RUNTIME_DIR: FakeStat(dir_mode, CORE_UID, dir_gid)}
        if with_socket:
            self.stats[tool.SOCKET_PATH] = FakeStat(socket_mode, socket_owner, socket_gid, socket_kind)
        self.proc = (f"AEGIS_PROFILE=production\0{KEY}={running_env_uid}\0".encode() if running_env_uid is not None else b"AEGIS_PROFILE=production\0")
        self._proc_groups = list(proc_groups)

    def read_bytes(self, path):
        return self.files[path]

    def lstat(self, path):
        if path not in self.stats:
            raise FileNotFoundError(path)
        return self.stats[path]

    def proc_environ(self, pid):
        return self.proc

    def proc_groups(self, pid):
        return self._proc_groups


class FakeBackend(tool.Backend):
    def __init__(self, *, active="active", sub="running", pid="4242", start_rc=0, stop_rc=0):
        self.props = f"ActiveState={active}\nSubState={sub}\nMainPID={pid}\n"
        self.calls: list[tuple[str, ...]] = []
        self.start_rc, self.stop_rc = start_rc, stop_rc

    def systemctl(self, *args):
        self.calls.append(args)
        # reuse the real allow-list: anything it would refuse raises here too
        allowed = args == ("show", tool.CORE_UNIT, "-pActiveState", "-pSubState", "-pMainPID") or (
            len(args) == 2 and args[0] in ("start", "stop") and args[1] == tool.DETECTOR_UNIT)
        if not allowed:
            raise tool.Refusal("SYSTEMCTL_VERB_NOT_ALLOWED")
        if args[0] == "show":
            return tool.CommandResult(0, self.props)
        return tool.CommandResult(self.start_rc if args[0] == "start" else self.stop_rc, "")


def starts(backend):
    return [c for c in backend.calls if c[0] == "start"]


def test_happy_path_starts_the_detector_exactly_once_after_every_gate():
    host, backend = FakeHost(), FakeBackend()
    assert tool.start_detector(DETECTOR_UID, CORE_UID, host, backend) == {"F1_DETECTOR_START": "PASS"}
    assert backend.calls == [("show", tool.CORE_UNIT, "-pActiveState", "-pSubState", "-pMainPID"), ("start", tool.DETECTOR_UNIT)]


@pytest.mark.parametrize("label,host_kw,backend_kw,reason", [
    ("account_missing", {"users": {}}, {}, "DETECTOR_ACCOUNT_MISSING"),
    ("account_uid_differs", {"users": {tool.DETECTOR_ACCOUNT: 954}}, {}, "DETECTOR_UID_MISMATCH"),
    ("alert_group_missing", {"groups": {}}, {}, "ALERT_GROUP_MISSING"),
    ("env_key_missing", {"env_uid": None}, {}, "ALERT_SOURCE_UID_MISSING"),
    ("env_mismatch", {"env_uid": "7"}, {}, "ALERT_SOURCE_UID_MISMATCH"),
    ("unit_names_another_account", {"unit": _mutations()["root_user"].encode()}, {}, "UNIT_USER_MISMATCH"),
    ("unit_carries_a_capability", {"unit": _mutations()["dac_override_returns"].encode()}, {}, "UNIT_FORBIDDEN_CONTENT"),
    ("core_inactive", {}, {"active": "inactive", "sub": "dead"}, "CORE_NOT_RUNNING"),
    ("core_activating", {}, {"active": "activating", "sub": "start"}, "CORE_NOT_RUNNING"),
    ("core_no_main_pid", {}, {"pid": "0"}, "CORE_NOT_RUNNING"),
    ("core_not_restarted_after_env_change", {"running_env_uid": None}, {}, "CORE_RUNNING_WITHOUT_ALERT_SOURCE_UID"),
    ("core_running_with_other_uid", {"running_env_uid": "7"}, {}, "CORE_RUNNING_WITHOUT_ALERT_SOURCE_UID"),
    ("core_process_lacks_the_alert_group", {"proc_groups": (CORE_UID,)}, {}, "CORE_LACKS_ALERT_GROUP"),
    ("socket_missing", {"with_socket": False}, {}, "ALERT_SOCKET_MISSING"),
    ("socket_not_a_socket", {"socket_kind": stat.S_IFREG}, {}, "ALERT_SOCKET_NOT_A_SOCKET"),
    ("socket_wrong_owner", {"socket_owner": 0}, {}, "ALERT_SOCKET_WRONG_OWNER"),
    ("socket_wrong_group", {"socket_gid": 0}, {}, "ALERT_SOCKET_WRONG_OWNER"),
    ("socket_legacy_0600", {"socket_mode": 0o600}, {}, "ALERT_SOCKET_WRONG_MODE"),
    ("socket_world_writable", {"socket_mode": 0o622}, {}, "ALERT_SOCKET_WRONG_MODE"),
    ("socket_group_readable", {"socket_mode": 0o660}, {}, "ALERT_SOCKET_WRONG_MODE"),
    ("runtime_dir_group_writable", {"dir_mode": 0o2770}, {}, "ALERT_RUNTIME_DIR_UNEXPECTED"),
    ("runtime_dir_world_access", {"dir_mode": 0o2755}, {}, "ALERT_RUNTIME_DIR_UNEXPECTED"),
    ("runtime_dir_no_setgid", {"dir_mode": 0o750}, {}, "ALERT_RUNTIME_DIR_UNEXPECTED"),
    ("runtime_dir_wrong_group", {"dir_gid": 0}, {}, "ALERT_RUNTIME_DIR_UNEXPECTED"),
])
def test_detector_cannot_start_unless_every_earlier_gate_holds(label, host_kw, backend_kw, reason):
    host, backend = FakeHost(**host_kw), FakeBackend(**backend_kw)
    assert refusal(tool.start_detector, DETECTOR_UID, CORE_UID, host, backend) == reason, label
    assert starts(backend) == []


def test_detector_cannot_start_for_root_or_the_core_account_and_nothing_is_called():
    for uid, users in ((0, {tool.DETECTOR_ACCOUNT: 0}), (CORE_UID, {tool.DETECTOR_ACCOUNT: CORE_UID})):
        backend = FakeBackend()
        assert refusal(tool.start_detector, uid, CORE_UID, FakeHost(users=users, env_uid=str(uid), running_env_uid=str(uid)), backend) in (
            "ALERT_SOURCE_IS_ROOT", "ALERT_SOURCE_IS_CORE_ACCOUNT")
        assert backend.calls == []  # not even a Core `show`: the cheap static refusals come first


def test_a_missing_socket_is_checked_after_the_core_is_known_up_and_before_any_start():
    host, backend = FakeHost(with_socket=False), FakeBackend()
    refusal(tool.start_detector, DETECTOR_UID, CORE_UID, host, backend)
    assert backend.calls == [("show", tool.CORE_UNIT, "-pActiveState", "-pSubState", "-pMainPID")]


def test_start_failure_is_one_attempt_with_no_retry():
    host, backend = FakeHost(), FakeBackend(start_rc=1)
    assert refusal(tool.start_detector, DETECTOR_UID, CORE_UID, host, backend) == "DETECTOR_START_FAILED"
    assert len(starts(backend)) == 1


def test_no_core_verb_is_ever_issued_by_the_package():
    host, backend = FakeHost(), FakeBackend()
    tool.start_detector(DETECTOR_UID, CORE_UID, host, backend)
    tool.rollback_detector(backend)
    assert {c[0] for c in backend.calls} == {"show", "start", "stop"}
    assert all(c[1] != tool.CORE_UNIT or c[0] == "show" for c in backend.calls)


@pytest.mark.parametrize("args", [("restart", tool.CORE_UNIT), ("stop", tool.CORE_UNIT), ("start", tool.CORE_UNIT), ("daemon-reload",),
                                  ("enable", tool.DETECTOR_UNIT), ("restart", tool.DETECTOR_UNIT), ("kill", tool.DETECTOR_UNIT),
                                  ("start", tool.DETECTOR_UNIT, "extra"), ("show", "mosquitto.service", "-pActiveState"),
                                  ("stop", "aegis-idea3-containment.service"), ("start", "aegis-idea3-containment.socket"),
                                  ("show", tool.CORE_UNIT, "-pEnvironment")])
def test_the_real_backend_refuses_every_verb_outside_the_allow_list_without_running_anything(args):
    assert refusal(tool.Backend().systemctl, *args) == "SYSTEMCTL_VERB_NOT_ALLOWED"


def test_the_real_backend_runs_a_fixed_argv_without_a_shell_and_bounds_the_timeout(monkeypatch):
    seen = {}

    def fake_run(argv, **kw):
        seen.update(argv=argv, kw=kw)
        return subprocess.CompletedProcess(argv, 0, stdout="ok", stderr="")

    monkeypatch.setattr(subprocess, "run", fake_run)
    assert tool.Backend().systemctl("start", tool.DETECTOR_UNIT) == tool.CommandResult(0, "ok")
    assert seen["argv"] == ["systemctl", "start", tool.DETECTOR_UNIT] and not seen["kw"].get("shell") and 0 < seen["kw"]["timeout"] <= 60


def test_a_systemctl_timeout_is_a_failure_not_a_hang(monkeypatch):
    def fake_run(argv, **kw):
        raise subprocess.TimeoutExpired(argv, kw["timeout"])

    monkeypatch.setattr(subprocess, "run", fake_run)
    assert tool.Backend().systemctl("stop", tool.DETECTOR_UNIT).rc == 124
    assert refusal(tool.rollback_detector, tool.Backend()) == "DETECTOR_STOP_FAILED"


def test_live_actions_need_the_authorization_flag_and_root(monkeypatch, capsys):
    monkeypatch.delenv("AEGIS_F1_LIVE_AUTHORIZED", raising=False)
    assert tool.main(["start-detector", "--uid", "953"]) == 1
    assert "LIVE_AUTHORIZATION_FLAG_REQUIRED" in capsys.readouterr().err
    assert tool.main(["stop-detector"]) == 1
    assert "LIVE_AUTHORIZATION_FLAG_REQUIRED" in capsys.readouterr().err
    monkeypatch.setenv("AEGIS_F1_LIVE_AUTHORIZED", "YES")
    monkeypatch.setattr(os, "geteuid", lambda: 1000)
    assert tool.main(["start-detector", "--uid", "953"]) == 1
    assert "ROOT_REQUIRED" in capsys.readouterr().err


def test_every_other_start_path_is_gated_by_the_core_alert_socket_check():
    lines = tool._active_lines(rendered_unit())
    assert any(line.startswith("ExecStartPre=") and "check-socket" in line for line in lines)
    assert [i for i, line in enumerate(lines) if line.startswith("ExecStartPre=")] < [i for i, line in enumerate(lines) if line.startswith("ExecStart=")]


# ═══ Phase A gap: the real Core hook is NOT implemented, so a live success claim is impossible ═════════════════════════════════


def test_phase_a_gap_the_real_core_still_creates_its_socket_at_the_legacy_path_so_the_dedicated_surface_never_exists():
    """CORE_ALERT_SOCKET_HOOK_IMPLEMENTED=NO. The Core AlertServer (PR #287-shared files) is untouched in Phase A: it builds the socket from its
    general runtime directory. This tripwire fails the moment Phase B changes that, forcing the status flags to be revisited together."""
    core_source = (ROOT / "aegis_soc" / "recovery_core.py").read_text() + (ROOT / "aegis_soc" / "supervisor.py").read_text()
    assert "/run/aegis-idea3-alert" not in core_source and "aegis-idea3-alert" not in core_source
    assert "self.settings.runtime_dir / rc.ALERT_CHANNEL_NAME" in (ROOT / "aegis_soc" / "supervisor.py").read_text()
    assert tool.SOCKET_PATH != "/run/aegis-idea3/alert.sock"


def test_phase_a_gap_cannot_produce_a_successful_start_even_with_every_other_gate_green():
    """A host where L7u had provisioned everything but the (unimplemented) Core hook never created the dedicated socket: the start gate
    refuses at the socket check and issues no `systemctl start`."""
    host, backend = FakeHost(with_socket=False), FakeBackend()
    assert refusal(tool.start_detector, DETECTOR_UID, CORE_UID, host, backend) == "ALERT_SOCKET_MISSING"
    assert starts(backend) == []


def test_the_f1_deployment_package_and_sink_do_not_use_the_general_runtime_path():
    from aegis_soc import alert_sink

    assert alert_sink.ALERT_SOCKET_PATH == tool.SOCKET_PATH == "/run/aegis-idea3-alert/alert.sock"
    for path in (TOOL_PATH, ROOT / "aegis_soc" / "alert_sink.py", ROOT / "aegis_soc" / "production_detector.py"):
        code = code_only(path)
        assert "/run/aegis-idea3/" not in code and "'/run/aegis-idea3'" not in code, path
    assert not any("/run/aegis-idea3/" in line or line.endswith("/run/aegis-idea3") for line in tool._active_lines(UNIT_EXAMPLE.read_text()))


# ═══ rollback: bounded, detector only, fail closed ═════════════════════════════════════════════════════════════════════════


def test_rollback_stops_only_the_detector_unit_once():
    backend = FakeBackend()
    assert tool.rollback_detector(backend) == {"F1_DETECTOR_STOP": "PASS"}
    assert backend.calls == [("stop", tool.DETECTOR_UNIT)]


def test_a_failed_stop_fails_closed_without_retry_and_without_touching_anything_else():
    backend = FakeBackend(stop_rc=1)
    assert refusal(tool.rollback_detector, backend) == "DETECTOR_STOP_FAILED"
    assert backend.calls == [("stop", tool.DETECTOR_UNIT)]


def test_the_tool_source_has_no_esp32_serial_cut_restore_containment_mqtt_or_shell_surface():
    source = code_only(TOOL_PATH)
    for pattern in (r"shell\s*=\s*True", r"os\.system", r"useradd|groupadd", r"serial", r"esp32|esptool", r"issue_command",
                    r"daemon-reload", r"\"restart\"", r"\"enable\"", r"/etc/passwd"):
        assert not re.search(pattern, source, re.IGNORECASE), pattern
    tree = ast.parse(source)
    imported = {a.name.split(".")[0] for n in ast.walk(tree) if isinstance(n, ast.Import) for a in n.names}
    imported |= {(n.module or "").split(".")[0] for n in ast.walk(tree) if isinstance(n, ast.ImportFrom) and n.level == 0}
    assert imported <= {"__future__", "argparse", "importlib", "os", "re", "stat", "subprocess", "sys", "pathlib", "typing", "pwd", "grp"}
    run_calls = [n for n in ast.walk(tree) if isinstance(n, ast.Call) and getattr(n.func, "attr", "") == "run"]
    assert len(run_calls) == 1


def test_the_tool_never_writes_core_env_or_installs_units():
    source = code_only(TOOL_PATH)
    assert source.count("os.open(") == 1  # only the O_EXCL render output
    assert "write_atomic" not in source and "CORE_ENV, " not in source.replace("host.read_bytes(CORE_ENV)", "")
    assert "shutil" not in source and "os.remove" not in source and "unlink" not in source and "chmod" not in source and "chown" not in source


def test_render_unit_cli_refuses_overwrite_and_writes_0644(tmp_path):
    out = tmp_path / "det.service"
    done = subprocess.run([sys.executable, str(TOOL_PATH), "render-unit", "--output", str(out)], capture_output=True, text=True, check=False)
    assert done.returncode == 0 and "F1_RENDER_UNIT=PASS" in done.stdout and stat.S_IMODE(out.stat().st_mode) == 0o644
    again = subprocess.run([sys.executable, str(TOOL_PATH), "render-unit", "--output", str(out)], capture_output=True, text=True, check=False)
    assert again.returncode == 1 and "OUTPUT_EXISTS" in again.stderr
    assert out.read_bytes() == UNIT_EXAMPLE.read_bytes()  # the unit is static: a byte-exact copy of the reviewed template


def test_verify_unit_and_verify_env_clis(tmp_path):
    unit, env = tmp_path / "u", tmp_path / "e"
    unit.write_text(rendered_unit())
    env.write_text(f"{KEY}=953\n")
    ok = subprocess.run([sys.executable, str(TOOL_PATH), "verify-unit", "--file", str(unit)], capture_output=True, text=True, check=False)
    assert ok.returncode == 0 and "F1_VERIFY_UNIT=PASS" in ok.stdout
    ok = subprocess.run([sys.executable, str(TOOL_PATH), "verify-env", "--uid", "953", "--file", str(env)], capture_output=True, text=True, check=False)
    assert ok.returncode == 0 and "F1_VERIFY_ENV=PASS" in ok.stdout
    bad = subprocess.run([sys.executable, str(TOOL_PATH), "verify-env", "--uid", "953", "--core-uid", "0", "--file", str(env)], capture_output=True, text=True, check=False)
    assert bad.returncode == 1 and "CORE_UID_INVALID" in bad.stderr



# ═══ L7u owns the Core-side activation (see test_f1_l7u_alert_integration.py); the F1 package never does ═════════════════════════


def test_the_f1_package_never_writes_core_env_the_group_database_or_the_core_unit_state():
    source = code_only(TOOL_PATH)
    for pattern in (r"groupadd|groupdel|gpasswd|useradd", r"tmpfiles", r"/etc/group", r"write_atomic", r"daemon-reload"):
        assert not re.search(pattern, source), pattern


def test_l7u_owns_the_alert_key_and_the_engine_never_names_the_detector_unit():
    engine = s.load_engine()
    assert tuple(engine.OWNED_ENV_KEYS) == ("AEGIS_RECOVERY_OPERATOR_UID", "AEGIS_RECOVERY_SOCKET_GID", "AEGIS_RECOVERY_SOCKET", KEY)
    text = code_only(ROOT / "deploy" / "pr11-phase4" / "p4-l7u-upgrade.py")
    assert tool.DETECTOR_UNIT not in text and "aegis-idea3-detector.service" not in text  # the account is verified; the UNIT is never touched
