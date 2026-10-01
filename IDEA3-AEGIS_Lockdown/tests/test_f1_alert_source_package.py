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


def rendered_unit(uid: int = 0) -> str:
    return tool.render_unit(UNIT_EXAMPLE.read_bytes(), uid).decode()


# ═══ identity: owner-supplied, frozen, fail-closed ═══════════════════════════════════════════════════════════════════════════


@pytest.mark.parametrize("bad", ["", " ", "-1", "+5", "01", "00", " 5", "5 ", "0x10", "1e3", "1.0", "4294967295", "99999999999", "٣", "root", "5\n", "5;6"])
def test_malformed_uid_is_refused(bad):
    assert refusal(tool.parse_uid, bad) == "ALERT_SOURCE_UID_INVALID"


@pytest.mark.parametrize("good,value", [("0", 0), ("1", 1), ("952", 952), ("4294967294", 4294967294)])
def test_canonical_decimal_uids_are_accepted(good, value):
    assert tool.parse_uid(good) == value


def test_the_tool_and_the_core_env_helper_share_one_uid_contract():
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


def test_the_identity_is_owner_input_never_a_repository_default():
    text = UNIT_EXAMPLE.read_text()
    assert "User=@AEGIS_ALERT_SOURCE_UID@" in text and text.count("@AEGIS_ALERT_SOURCE_UID@") >= 1
    assert not re.search(r"^User=\d", text, re.MULTILINE) and not re.search(r"^Group=", text, re.MULTILINE)
    source = code_only(TOOL_PATH)
    assert not re.search(r"useradd|groupadd|usermod|getent|adduser", source)
    assert "uid = 0" not in source and "DEFAULT_UID" not in source
    # no `--uid` means no render: the value must be supplied
    done = subprocess.run([sys.executable, str(TOOL_PATH), "render-unit", "--output", "/nonexistent/x"], capture_output=True, text=True, check=False)
    assert done.returncode != 0 and "--uid" in done.stderr


def test_the_unfilled_template_never_passes_the_unit_contract():
    assert refusal(tool.verify_unit, UNIT_EXAMPLE.read_bytes(), 0) == "UNIT_PLACEHOLDER_LEFT"


def test_render_requires_exactly_one_placeholder_and_substitutes_only_the_user_line():
    out = rendered_unit(0)
    assert "User=0" in out and "@" not in "".join(tool._active_lines(out))
    template = UNIT_EXAMPLE.read_text()
    assert refusal(tool.render_unit, template.replace("User=@AEGIS_ALERT_SOURCE_UID@", "User=root").encode(), 0) == "TEMPLATE_INVALID"
    doubled = template.replace("[Service]", "[Service]\nUser=@AEGIS_ALERT_SOURCE_UID@")
    assert refusal(tool.render_unit, doubled.encode(), 0) == "TEMPLATE_INVALID"


def test_unit_uid_must_equal_core_env_uid():
    unit = rendered_unit(0).encode()
    tool.verify_unit(unit, 0)
    assert refusal(tool.verify_unit, unit, 1000) == "UNIT_USER_MISMATCH"
    env = f"AEGIS_PROFILE=production\n{KEY}=0\n".encode()
    tool.verify_env(env, 0)
    assert refusal(tool.verify_env, env, 1000) == "ALERT_SOURCE_UID_MISMATCH"
    # the pair is only coherent when BOTH name the same uid
    other = rendered_unit(1000).encode()
    assert refusal(tool.verify_unit, other, 0) == "UNIT_USER_MISMATCH"


def test_a_uid_the_core_socket_contract_cannot_serve_is_refused_fail_closed():
    assert refusal(tool.verify_identity, 1000, CORE_UID) == "ALERT_SOURCE_CANNOT_REACH_SOCKET"  # 0600 socket, 0700 directory, Core-owned
    assert refusal(tool.verify_identity, CORE_UID, CORE_UID) == "ALERT_SOURCE_IS_CORE_ACCOUNT"
    assert refusal(tool.verify_identity, 0, 0) == "CORE_UID_INVALID"
    tool.verify_identity(0, CORE_UID)  # root keeps CAP_DAC_OVERRIDE in the unit and can connect


def test_connectability_model_follows_the_modes_so_a_future_core_change_is_judged_not_assumed():
    assert not tool.can_connect(1000, socket_uid=CORE_UID, socket_mode=0o600, dir_uid=CORE_UID, dir_mode=0o700)
    assert not tool.can_connect(1000, socket_uid=CORE_UID, socket_mode=0o600, dir_uid=CORE_UID, dir_mode=0o755)
    assert not tool.can_connect(1000, socket_uid=CORE_UID, socket_mode=0o660, dir_uid=CORE_UID, dir_mode=0o750)  # groups are never assumed
    assert tool.can_connect(1000, socket_uid=CORE_UID, socket_mode=0o666, dir_uid=CORE_UID, dir_mode=0o755)
    assert tool.can_connect(CORE_UID, socket_uid=CORE_UID, socket_mode=0o600, dir_uid=CORE_UID, dir_mode=0o700)
    assert tool.can_connect(0, socket_uid=CORE_UID, socket_mode=0o000, dir_uid=CORE_UID, dir_mode=0o000)


def test_the_frozen_core_socket_contract_matches_what_the_core_actually_creates():
    from aegis_soc import recovery_core

    assert tool.SOCKET_PATH == f"/run/aegis-idea3/{recovery_core.ALERT_CHANNEL_NAME}"
    core_unit = (ROOT / "deploy" / "aegis-idea3-core.service.example").read_text()
    assert "RuntimeDirectory=aegis-idea3" in core_unit and "RuntimeDirectoryMode=0700" in core_unit
    server_source = code_only(ROOT / "aegis_soc" / "recovery_core.py")
    assert "socket_gid=None" in server_source and "os.chmod(self.path, 384)" in server_source  # ast.unparse renders 0o600 as 384
    assert tool.SOCKET_MODE == 0o600 and tool.RUNTIME_DIR_MODE == 0o700


# ═══ detector unit: static contract ══════════════════════════════════════════════════════════════════════════════════════════


def test_the_rendered_unit_passes_and_is_deterministic():
    assert rendered_unit(0) == rendered_unit(0)
    tool.verify_unit(rendered_unit(0).encode(), 0)


def test_the_unit_is_af_unix_only_without_mqtt_network_secrets_or_shell():
    lines = tool._active_lines(rendered_unit(0))
    blob = "\n".join(lines).lower()
    for token in ("mqtt", "1883", "8883", "attacker_ip", "paho", "environmentfile", "loadcredential", "/bin/sh", "bash", "af_inet",
                  "restore", "containment", "nft", "iptables", "execstartpost", "execstop=", "execreload"):
        assert token not in blob, token
    assert not re.search(r"\bcut\b", blob)
    assert "RestrictAddressFamilies=AF_UNIX" in lines and "NoNewPrivileges=true" in lines and "CapabilityBoundingSet=CAP_DAC_OVERRIDE" in lines
    assert sum(1 for line in lines if line.startswith("ExecStart=")) == 1 and not any(re.search(r"[;&|`$]", line) for line in lines)


def test_the_unit_enforces_core_first_ordering_and_never_restarts_itself():
    lines = tool._active_lines(rendered_unit(0))
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
    lines = tool._active_lines(rendered_unit(0))
    execs = [line.split("=", 1)[1] for line in lines if line.startswith(("ExecStartPre=", "ExecStart="))]
    assert all(e.startswith("/opt/aegis-idea3/current/venv/bin/python -m aegis_soc.") for e in execs)
    assert not any(line.startswith(("EnvironmentFile=", "Environment=", "ReadWritePaths=")) for line in lines)


def _mutations():
    base = rendered_unit(0)
    return {
        "mqtt_env": base.replace("[Service]", "[Service]\nEnvironment=AEGIS_BROKER_PORT=1883"),
        "mqtt_topic_exec": base.replace("production_detector", "production_detector --topic aegis/attacker_ip"),
        "shell_exec": base.replace("ExecStart=/opt/aegis-idea3/current/venv/bin/python -m aegis_soc.production_detector", "ExecStart=/bin/sh -c 'x'"),
        "chained": base.replace("production_detector", "production_detector; id"),
        "af_inet": base.replace("RestrictAddressFamilies=AF_UNIX", "RestrictAddressFamilies=AF_UNIX AF_INET"),
        "restart_always": base.replace("Restart=no", "Restart=always"),
        "no_requires": base.replace("Requires=aegis-idea3-core.service\n", ""),
        "no_pre_check": base.replace("ExecStartPre=", "#ExecStartPre="),
        "second_user": base.replace("[Service]", "[Service]\nUser=0"),
        "group": base.replace("[Service]", "[Service]\nGroup=aegis-idea3"),
        "envfile": base.replace("[Service]", "[Service]\nEnvironmentFile=/etc/aegis-idea3/core.env"),
        "credential": base.replace("[Service]", "[Service]\nLoadCredential=k_c2d:/etc/aegis-idea3/credentials/k_c2d"),
        "post_hook": base.replace("[Service]", "[Service]\nExecStartPost=/usr/bin/true"),
        "restore_word": base.replace("[Service]", "[Service]\nDescription=RESTORE"),
        "cut_word": base.replace("Description=AEGIS IDEA3 F1 production detector (Core alert source)", "Description=CUT now"),
        "caps_widened": base.replace("CapabilityBoundingSet=CAP_DAC_OVERRIDE", "CapabilityBoundingSet=CAP_NET_ADMIN"),
        "no_nnp": base.replace("NoNewPrivileges=true", "NoNewPrivileges=false"),
        "wantedby": base.replace("WantedBy=multi-user.target", "WantedBy=default.target"),
        "rw_paths": base.replace("[Service]", "[Service]\nReadWritePaths=/run/aegis-idea3"),
        "second_execstart": base.replace("[Service]", "[Service]\nExecStart=/usr/bin/true"),
    }


@pytest.mark.parametrize("name", sorted(_mutations()))
def test_unit_mutations_are_refused(name):
    assert refusal(tool.verify_unit, _mutations()[name].encode(), 0)


@pytest.mark.skipif(shutil.which("systemd-analyze") is None, reason="systemd-analyze not installed")
def test_systemd_analyze_verify_accepts_the_rendered_unit(tmp_path, monkeypatch):
    unit = tmp_path / tool.DETECTOR_UNIT
    unit.write_text(rendered_unit(0))
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
    assert refusal(tool.verify_env, path.read_bytes(), 0) in {"ALERT_SOURCE_UID_INVALID", "CORE_ENV_LINE_MALFORMED"}


def test_duplicate_uid_lines_are_refused_by_the_helper_and_the_tool(tmp_path):
    path = render_env(tmp_path, "0")
    path.write_text(path.read_text() + f"{KEY}=0\n")
    assert "reason=DUPLICATE_KEY" in env_cli("check", tmp_path, "--alert-source-uid", "0").stdout
    assert refusal(tool.verify_env, path.read_bytes(), 0) == "ALERT_SOURCE_UID_DUPLICATE"
    path.write_text(path.read_text().replace(f"{KEY}=0\n", "", 1) + f"{KEY}=7\n")
    assert refusal(tool.verify_env, path.read_bytes(), 0) == "ALERT_SOURCE_UID_DUPLICATE"


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
    assert refusal(tool.verify_env, path.read_bytes(), 0) == "CORE_ENV_FORBIDDEN_KEY"


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
    code = tool.main(["verify-env", "--uid", "0", "--file", str(path)])
    out = capsys.readouterr()
    assert code == 1 and "952" not in out.out + out.err and "ALERT_SOURCE_UID_MISMATCH" in out.err


def test_verify_env_rejects_export_and_indentation_forms():
    for line in (f"export {KEY}=0", f" {KEY}=0", f"{KEY} =0"):
        assert refusal(tool.verify_env, f"{line}\n".encode(), 0) == "ALERT_SOURCE_UID_INVALID"


def test_verify_env_checks_the_identity_when_the_core_uid_is_known():
    env = f"{KEY}=1000\n".encode()
    tool.verify_env(env, 1000)
    assert refusal(tool.verify_env, env, 1000, core_uid=CORE_UID) == "ALERT_SOURCE_CANNOT_REACH_SOCKET"
    env = f"{KEY}={CORE_UID}\n".encode()
    assert refusal(tool.verify_env, env, CORE_UID, core_uid=CORE_UID) == "ALERT_SOURCE_IS_CORE_ACCOUNT"


# ═══ ordering: Core first, socket verified, then (and only then) the detector ═══════════════════════════════════════════════


class FakeDirStat:
    def __init__(self, mode, uid, kind=stat.S_IFDIR):
        self.st_mode, self.st_uid = kind | mode, uid


class FakeHost(tool.Host):
    def __init__(self, uid=0, *, env_uid="0", socket_mode=0o600, socket_owner=CORE_UID, socket_kind=stat.S_IFSOCK, with_socket=True,
                 running_env_uid="0", dir_mode=0o700, unit_uid=None):
        self.files = {
            tool.CORE_ENV: (f"AEGIS_PROFILE=production\n{KEY}={env_uid}\n".encode() if env_uid is not None else b"AEGIS_PROFILE=production\n"),
            tool.UNIT_PATH: rendered_unit(uid if unit_uid is None else unit_uid).encode(),
        }
        self.stats = {tool.RUNTIME_DIR: FakeDirStat(dir_mode, CORE_UID)}
        if with_socket:
            self.stats[tool.SOCKET_PATH] = FakeDirStat(socket_mode, socket_owner, socket_kind)
        self.proc = (f"AEGIS_PROFILE=production\0{KEY}={running_env_uid}\0".encode() if running_env_uid is not None else b"AEGIS_PROFILE=production\0")

    def read_bytes(self, path):
        return self.files[path]

    def lstat(self, path):
        if path not in self.stats:
            raise FileNotFoundError(path)
        return self.stats[path]

    def proc_environ(self, pid):
        return self.proc


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
    assert tool.start_detector(0, CORE_UID, host, backend) == {"F1_DETECTOR_START": "PASS"}
    assert backend.calls == [("show", tool.CORE_UNIT, "-pActiveState", "-pSubState", "-pMainPID"), ("start", tool.DETECTOR_UNIT)]


@pytest.mark.parametrize("label,host_kw,backend_kw,reason", [
    ("env_key_missing", {"env_uid": None}, {}, "ALERT_SOURCE_UID_MISSING"),
    ("env_mismatch", {"env_uid": "7"}, {}, "ALERT_SOURCE_UID_MISMATCH"),
    ("unit_for_another_uid", {"unit_uid": 7}, {}, "UNIT_USER_MISMATCH"),
    ("core_inactive", {}, {"active": "inactive", "sub": "dead"}, "CORE_NOT_RUNNING"),
    ("core_activating", {}, {"active": "activating", "sub": "start"}, "CORE_NOT_RUNNING"),
    ("core_no_main_pid", {}, {"pid": "0"}, "CORE_NOT_RUNNING"),
    ("core_not_restarted_after_env_change", {"running_env_uid": None}, {}, "CORE_RUNNING_WITHOUT_ALERT_SOURCE_UID"),
    ("core_running_with_other_uid", {"running_env_uid": "7"}, {}, "CORE_RUNNING_WITHOUT_ALERT_SOURCE_UID"),
    ("socket_missing", {"with_socket": False}, {}, "ALERT_SOCKET_MISSING"),
    ("socket_not_a_socket", {"socket_kind": stat.S_IFREG}, {}, "ALERT_SOCKET_NOT_A_SOCKET"),
    ("socket_wrong_owner", {"socket_owner": 0}, {}, "ALERT_SOCKET_WRONG_OWNER"),
    ("socket_wrong_mode", {"socket_mode": 0o666}, {}, "ALERT_SOCKET_WRONG_MODE"),
    ("runtime_dir_writable", {"dir_mode": 0o777}, {}, "ALERT_RUNTIME_DIR_UNEXPECTED"),
])
def test_detector_cannot_start_unless_every_earlier_gate_holds(label, host_kw, backend_kw, reason):
    host, backend = FakeHost(**host_kw), FakeBackend(**backend_kw)
    assert refusal(tool.start_detector, 0, CORE_UID, host, backend) == reason, label
    assert starts(backend) == []


def test_detector_cannot_start_for_an_identity_the_core_cannot_serve():
    host, backend = FakeHost(uid=1000, env_uid="1000", running_env_uid="1000", unit_uid=1000), FakeBackend()
    assert refusal(tool.start_detector, 1000, CORE_UID, host, backend) == "ALERT_SOURCE_CANNOT_REACH_SOCKET"
    assert backend.calls == []  # not even a Core `show`: the cheap static refusals come first


def test_a_missing_socket_is_checked_after_the_core_is_known_up_and_before_any_start():
    host, backend = FakeHost(with_socket=False), FakeBackend()
    refusal(tool.start_detector, 0, CORE_UID, host, backend)
    assert backend.calls == [("show", tool.CORE_UNIT, "-pActiveState", "-pSubState", "-pMainPID")]


def test_start_failure_is_one_attempt_with_no_retry():
    host, backend = FakeHost(), FakeBackend(start_rc=1)
    assert refusal(tool.start_detector, 0, CORE_UID, host, backend) == "DETECTOR_START_FAILED"
    assert len(starts(backend)) == 1


def test_no_core_verb_is_ever_issued_by_the_package():
    host, backend = FakeHost(), FakeBackend()
    tool.start_detector(0, CORE_UID, host, backend)
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
    assert tool.main(["start-detector", "--uid", "0"]) == 1
    assert "LIVE_AUTHORIZATION_FLAG_REQUIRED" in capsys.readouterr().err
    assert tool.main(["stop-detector"]) == 1
    assert "LIVE_AUTHORIZATION_FLAG_REQUIRED" in capsys.readouterr().err
    monkeypatch.setenv("AEGIS_F1_LIVE_AUTHORIZED", "YES")
    monkeypatch.setattr(os, "geteuid", lambda: 1000)
    assert tool.main(["start-detector", "--uid", "0"]) == 1
    assert "ROOT_REQUIRED" in capsys.readouterr().err


def test_every_other_start_path_is_gated_by_the_core_alert_socket_check():
    lines = tool._active_lines(rendered_unit(0))
    assert any(line.startswith("ExecStartPre=") and "check-socket" in line for line in lines)
    assert [i for i, line in enumerate(lines) if line.startswith("ExecStartPre=")] < [i for i, line in enumerate(lines) if line.startswith("ExecStart=")]


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
    assert imported <= {"__future__", "argparse", "importlib", "os", "re", "stat", "subprocess", "sys", "pathlib", "typing", "pwd"}
    run_calls = [n for n in ast.walk(tree) if isinstance(n, ast.Call) and getattr(n.func, "attr", "") == "run"]
    assert len(run_calls) == 1


def test_the_tool_never_writes_core_env_or_installs_units():
    source = code_only(TOOL_PATH)
    assert source.count("os.open(") == 1  # only the O_EXCL render output
    assert "write_atomic" not in source and "CORE_ENV, " not in source.replace("host.read_bytes(CORE_ENV)", "")
    assert "shutil" not in source and "os.remove" not in source and "unlink" not in source and "chmod" not in source and "chown" not in source


def test_render_unit_cli_refuses_overwrite_and_writes_0644(tmp_path):
    out = tmp_path / "det.service"
    done = subprocess.run([sys.executable, str(TOOL_PATH), "render-unit", "--uid", "0", "--output", str(out)], capture_output=True, text=True, check=False)
    assert done.returncode == 0 and "F1_RENDER_UNIT=PASS" in done.stdout and stat.S_IMODE(out.stat().st_mode) == 0o644
    again = subprocess.run([sys.executable, str(TOOL_PATH), "render-unit", "--uid", "0", "--output", str(out)], capture_output=True, text=True, check=False)
    assert again.returncode == 1 and "OUTPUT_EXISTS" in again.stderr
    bad = subprocess.run([sys.executable, str(TOOL_PATH), "render-unit", "--uid", "x", "--output", str(tmp_path / "n")], capture_output=True, text=True, check=False)
    assert bad.returncode == 1 and "ALERT_SOURCE_UID_INVALID" in bad.stderr and not (tmp_path / "n").exists()


def test_verify_unit_and_verify_env_clis(tmp_path):
    unit, env = tmp_path / "u", tmp_path / "e"
    unit.write_text(rendered_unit(0))
    env.write_text(f"{KEY}=0\n")
    ok = subprocess.run([sys.executable, str(TOOL_PATH), "verify-unit", "--uid", "0", "--file", str(unit)], capture_output=True, text=True, check=False)
    assert ok.returncode == 0 and "F1_VERIFY_UNIT=PASS" in ok.stdout
    ok = subprocess.run([sys.executable, str(TOOL_PATH), "verify-env", "--uid", "0", "--file", str(env)], capture_output=True, text=True, check=False)
    assert ok.returncode == 0 and "F1_VERIFY_ENV=PASS" in ok.stdout
    bad = subprocess.run([sys.executable, str(TOOL_PATH), "verify-env", "--uid", "0", "--core-uid", "0", "--file", str(env)], capture_output=True, text=True, check=False)
    assert bad.returncode == 1 and "CORE_UID_INVALID" in bad.stderr


# ═══ L7u: no integration without an owner policy; but the engine and the new key must coexist ═══════════════════════════════


def test_l7u_does_not_own_the_alert_key_and_never_names_the_detector_unit():
    engine = s.load_engine()
    assert KEY not in engine.OWNED_ENV_KEYS and tuple(engine.OWNED_ENV_KEYS) == (
        "AEGIS_RECOVERY_OPERATOR_UID", "AEGIS_RECOVERY_SOCKET_GID", "AEGIS_RECOVERY_SOCKET")
    text = code_only(ROOT / "deploy" / "pr11-phase4" / "p4-l7u-upgrade.py")
    assert "detector" not in text.lower() and "alert" not in text.lower()


def _run_engine(tmp_path, env_lines):
    fx = s.build(tmp_path, env_lines=env_lines)
    pre = (fx.host.read_bytes("/etc/aegis-idea3/core.env"), fx.host.identity("/etc/aegis-idea3/core.env"))
    fx.engine.apply(fx.cfg, fx.host, fx.system)
    return fx, pre


def test_an_f1_uid_already_in_core_env_is_preserved_byte_for_byte_by_the_l7u_apply_with_one_restart(tmp_path):
    fx, pre = _run_engine(tmp_path, [*s.CORE_ENV_LINES, f"{KEY}=0"])
    after = fx.host.read_bytes("/etc/aegis-idea3/core.env")
    assert after.startswith(pre[0]) and after.count(f"{KEY}=0\n".encode()) == 1 and after.count(KEY.encode()) == 1
    verbs = [c[1] for c in fx.system.state.calls if c[0] == "systemctl"]
    assert verbs.count("restart") == 1
    assert not any(tool.DETECTOR_UNIT in " ".join(map(str, c)) for c in fx.system.state.calls)  # L7u never starts the detector


def test_l7u_rollback_restores_a_core_env_that_carries_the_f1_uid_exactly(tmp_path):
    fx = s.build(tmp_path, env_lines=[*s.CORE_ENV_LINES, f"{KEY}=0"], fail="unhealthy_after")
    pre = (fx.host.read_bytes("/etc/aegis-idea3/core.env"), fx.host.identity("/etc/aegis-idea3/core.env"))
    with pytest.raises(fx.engine.Refusal):
        fx.engine.apply(fx.cfg, fx.host, fx.system)
    fx.system.state.fail = ""
    fx.engine.rollback(fx.cfg, fx.host, fx.system)
    assert (fx.host.read_bytes("/etc/aegis-idea3/core.env"), fx.host.identity("/etc/aegis-idea3/core.env")) == pre
    assert not any(tool.DETECTOR_UNIT in " ".join(map(str, c)) for c in fx.system.state.calls)


def test_l7u_refuses_nothing_new_for_a_core_env_without_the_key(tmp_path):
    fx, _ = _run_engine(tmp_path, s.CORE_ENV_LINES)
    assert KEY.encode() not in fx.host.read_bytes("/etc/aegis-idea3/core.env")  # F1 stays inert unless the owner supplies the value
