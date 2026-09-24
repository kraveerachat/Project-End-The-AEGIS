"""Fixture-root behavioural tests for the L6b separate-broker handler (apply / verify / rollback).

Everything runs against AEGIS_P4_FS_ROOT below tmp_path: no systemctl, no /etc, no broker process.
"""
from __future__ import annotations

import getpass
import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
L6B = ROOT / "deploy" / "pr11-phase4" / "stages" / "L6b"
AP = "10.77.30.1"
UPLINK = "192.168.1.144"

CONF = """per_listener_settings false
allow_anonymous false
password_file /etc/aegis-idea3/mqtt/passwd
acl_file /etc/aegis-idea3/mqtt/acl
persistence false
retain_available false
listener 8883 127.0.0.1
protocol mqtt
cafile /etc/aegis-idea3/mqtt/ca.crt
certfile /etc/aegis-idea3/mqtt/broker.crt
keyfile /etc/aegis-idea3/mqtt/broker.key
tls_version tlsv1.2
listener 8883 {ap}
protocol mqtt
cafile /etc/aegis-idea3/mqtt/ca.crt
certfile /etc/aegis-idea3/mqtt/broker.crt
keyfile /etc/aegis-idea3/mqtt/broker.key
tls_version tlsv1.2
"""
ACL = "user idea3-core\ntopic write aegis/idea3/v1/aegis-relay-01/command\nuser idea3-dev-aegis-relay-01\ntopic write aegis/idea3/v1/aegis-relay-01/status\n"
IDEA3_PASSWD = "idea3-core:$7$fixture\nidea3-dev-aegis-relay-01:$7$fixture\n"
LEGACY_PASSWD = "aegis:$7$legacyfixture\nother:$7$legacyfixture2\n"


def build(tmp: Path, *, conf: str | None = None, acl: str = ACL, passwd: str = IDEA3_PASSWD, legacy: str = LEGACY_PASSWD) -> Path:
    root = tmp / "root"
    mqtt = root / "etc/aegis-idea3/mqtt"
    legacy_dir = root / "etc/mosquitto"
    mqtt.mkdir(parents=True)
    legacy_dir.mkdir(parents=True)
    (mqtt / "aegis-idea3-mosquitto.conf").write_text(conf if conf is not None else CONF.format(ap=AP))
    (mqtt / "acl").write_text(acl)
    (mqtt / "passwd").write_text(passwd)
    for name in ("ca.crt", "broker.crt", "broker.key"):
        (mqtt / name).write_text("fixture\n")
    (mqtt / "passwd").chmod(0o600)
    (mqtt / "broker.key").chmod(0o600)
    (legacy_dir / "passwd").write_text(legacy)
    (legacy_dir / "passwd").chmod(0o600)
    (legacy_dir / "mosquitto.conf").write_text("listener 1883\nallow_anonymous false\n")
    return root


def run(script: str, root: Path, work: Path, **env: str) -> subprocess.CompletedProcess[str]:
    e = {k: v for k, v in os.environ.items() if not k.startswith("AEGIS_")}
    e.update({"AEGIS_P4_FS_ROOT": str(root), "AEGIS_L6B_WORK_DIR": str(work), "AEGIS_AP_ADDRESS": AP,
              "AEGIS_UPLINK_ADDRESS": UPLINK, "AEGIS_AP_INTERFACE": "wlp0s20f3"})
    e.update(env)
    return subprocess.run(["bash", str(L6B / script)], text=True, capture_output=True, env=e)


def out(r: subprocess.CompletedProcess[str]) -> str:
    return r.stdout + r.stderr


UNIT = "etc/systemd/system/aegis-idea3-mosquitto.service"


def test_apply_verify_rollback_happy_path(tmp_path: Path) -> None:
    root, work = build(tmp_path), tmp_path / "work"
    a = run("apply.sh", root, work)
    assert a.returncode == 0 and "L6B_APPLY=PASS" in a.stdout and "LEGACY_SERVICE_MUTATED=NO" in a.stdout, out(a)
    assert (root / UNIT).is_file()
    v = run("verify.sh", root, work)
    assert v.returncode == 0 and "L6B_VERIFY=PASS" in v.stdout and "IDEA3_8883_SCOPE=NOT_RUN_FIXTURE" in v.stdout, out(v)
    rb = run("rollback.sh", root, work)
    assert rb.returncode == 0 and "L6B_ROLLBACK=PASS" in rb.stdout, out(rb)
    assert not (root / UNIT).exists()


@pytest.mark.parametrize("edit,reason", [
    (lambda c: c.replace("listener 8883 127.0.0.1", "listener 1883 127.0.0.1"), "LOOPBACK_LISTENER_INVALID"),
    (lambda c: c.replace(f"listener 8883 {AP}", "listener 8883 0.0.0.0"), "AP_LISTENER_INVALID"),
    (lambda c: c + "listener 1883\n", "LISTENER_COUNT_INVALID"),
    (lambda c: c.replace(f"listener 8883 {AP}", f"listener 8883 {UPLINK}"), "AP_LISTENER_INVALID"),
    (lambda c: c.replace("allow_anonymous false", "allow_anonymous true"), "ANONYMOUS_POLICY_INVALID"),
    (lambda c: c.replace("persistence false", "persistence true"), "PERSISTENCE_POLICY_INVALID"),
    (lambda c: c.replace("retain_available false", "retain_available true"), "RETAIN_POLICY_INVALID"),
    (lambda c: c.replace("/etc/aegis-idea3/mqtt/passwd", "/etc/mosquitto/passwd"), "IDEA3_PASSWORD_PATH_INVALID"),
])
def test_apply_rejects_unsafe_config(tmp_path: Path, edit, reason: str) -> None:
    root = build(tmp_path, conf=edit(CONF.format(ap=AP)))
    r = run("apply.sh", root, tmp_path / "work")
    assert r.returncode != 0 and reason in out(r), out(r)
    assert not (root / UNIT).exists()


def test_apply_rejects_uplink_address_anywhere_in_config(tmp_path: Path) -> None:
    root = build(tmp_path, conf=CONF.format(ap=AP) + f"# bind {UPLINK}\n")
    r = run("apply.sh", root, tmp_path / "work")
    assert r.returncode != 0 and "UPLINK_BIND_FORBIDDEN" in out(r)


def test_apply_rejects_legacy_identity_in_idea3_acl_or_passwd(tmp_path: Path) -> None:
    r = run("apply.sh", build(tmp_path / "a", acl=ACL + "user aegis\ntopic readwrite #\n"), tmp_path / "wa")
    assert r.returncode != 0 and "LEGACY_USER_IN_IDEA3_ACL" in out(r)
    r = run("apply.sh", build(tmp_path / "b", passwd=IDEA3_PASSWD + "aegis:$7$x\n"), tmp_path / "wb")
    assert r.returncode != 0 and "LEGACY_USER_IN_IDEA3_PASSWORD_DB" in out(r)


def test_apply_requires_idea3_identities_and_legacy_aegis_user(tmp_path: Path) -> None:
    r = run("apply.sh", build(tmp_path / "a", passwd="idea3-dev-x:$7$f\n"), tmp_path / "wa")
    assert r.returncode != 0 and "IDEA3_CORE_IDENTITY_MISSING" in out(r)
    r = run("apply.sh", build(tmp_path / "b", passwd="idea3-core:$7$f\n"), tmp_path / "wb")
    assert r.returncode != 0 and "IDEA3_DEVICE_IDENTITY_MISSING" in out(r)
    r = run("apply.sh", build(tmp_path / "c", legacy="other:$7$x\n"), tmp_path / "wc")
    assert r.returncode != 0 and "LEGACY_AEGIS_USER_MISSING" in out(r)


@pytest.mark.parametrize("name", ["passwd", "broker.key"])
def test_apply_rejects_open_secret_modes(tmp_path: Path, name: str) -> None:
    root = build(tmp_path)
    (root / "etc/aegis-idea3/mqtt" / name).chmod(0o644)
    r = run("apply.sh", root, tmp_path / "work")
    assert r.returncode != 0 and "SECRET_MODE_TOO_OPEN" in out(r)


def test_apply_rejects_symlinked_required_file_and_existing_unit_and_workdir(tmp_path: Path) -> None:
    root = build(tmp_path / "a")
    key = root / "etc/aegis-idea3/mqtt/broker.key"
    real = key.with_name("real.key"); real.write_text("x"); real.chmod(0o600); key.unlink(); key.symlink_to(real)
    assert "REQUIRED_FILE_INVALID" in out(run("apply.sh", root, tmp_path / "wa"))
    root = build(tmp_path / "b")
    (root / UNIT).parent.mkdir(parents=True); (root / UNIT).write_text("x")
    assert "IDEA3_UNIT_ALREADY_EXISTS" in out(run("apply.sh", root, tmp_path / "wb"))
    root = build(tmp_path / "c"); (tmp_path / "wc").mkdir()
    assert "WORK_DIR_ALREADY_EXISTS" in out(run("apply.sh", root, tmp_path / "wc"))


def test_apply_rejects_bad_addresses(tmp_path: Path) -> None:
    root = build(tmp_path)
    for env, reason in [({"AEGIS_AP_ADDRESS": "0.0.0.0"}, "AEGIS_AP_ADDRESS_INVALID"), ({"AEGIS_UPLINK_ADDRESS": "nope"}, "AEGIS_UPLINK_ADDRESS_INVALID"),
                        ({"AEGIS_UPLINK_ADDRESS": AP}, "AP_EQUALS_UPLINK")]:
        r = run("apply.sh", root, tmp_path / f"w-{reason}", **env)
        assert r.returncode != 0 and reason in out(r), (reason, out(r))


def test_verify_detects_legacy_tree_and_user_changes(tmp_path: Path) -> None:
    root, work = build(tmp_path), tmp_path / "work"
    assert run("apply.sh", root, work).returncode == 0
    legacy = root / "etc/mosquitto"
    (legacy / "mosquitto.conf").write_text("listener 1883\nallow_anonymous true\n")
    r = run("verify.sh", root, work)
    assert r.returncode != 0 and "LEGACY_CONFIG_TREE_CHANGED" in out(r)
    (legacy / "mosquitto.conf").write_text("listener 1883\nallow_anonymous false\n")
    (legacy / "passwd").write_text("other:$7$x\n")
    r = run("verify.sh", root, work)
    assert r.returncode != 0 and ("LEGACY_CONFIG_TREE_CHANGED" in out(r) or "LEGACY_USER_SET_CHANGED" in out(r))


def test_verify_requires_unit_and_config(tmp_path: Path) -> None:
    root, work = build(tmp_path), tmp_path / "work"
    assert run("apply.sh", root, work).returncode == 0
    (root / UNIT).unlink()
    assert "IDEA3_UNIT_MISSING" in out(run("verify.sh", root, work))


def test_rollback_detects_legacy_tree_change(tmp_path: Path) -> None:
    root, work = build(tmp_path), tmp_path / "work"
    assert run("apply.sh", root, work).returncode == 0
    (root / "etc/mosquitto/extra.conf").write_text("x")
    r = run("rollback.sh", root, work)
    assert r.returncode != 0 and "LEGACY_CONFIG_TREE_CHANGED" in out(r)


def test_rollback_is_idempotent_on_missing_unit(tmp_path: Path) -> None:
    root, work = build(tmp_path), tmp_path / "work"
    assert run("apply.sh", root, work).returncode == 0
    assert run("rollback.sh", root, work).returncode == 0
    assert run("rollback.sh", root, work).returncode == 0


# ---- candidate guards (RED first) ----
def test_secret_files_must_be_owned_by_the_broker_user(tmp_path: Path) -> None:
    me = getpass.getuser()
    root = build(tmp_path / "ok")
    r = run("apply.sh", root, tmp_path / "w-ok", AEGIS_L6B_BROKER_USER=me)
    assert r.returncode == 0, out(r)
    root = build(tmp_path / "bad")
    r = run("apply.sh", root, tmp_path / "w-bad", AEGIS_L6B_BROKER_USER="mosquitto-not-owner")
    assert r.returncode != 0 and "IDEA3_FILE_OWNER_NOT_BROKER_USER" in out(r), out(r)
    assert not (root / UNIT).exists()


def test_acl_file_owner_is_checked_too(tmp_path: Path) -> None:
    root = build(tmp_path)
    r = run("apply.sh", root, tmp_path / "w", AEGIS_L6B_BROKER_USER="someone-else")
    assert "acl" in out(r) or "passwd" in out(r) or "broker.key" in out(r)


def _code(name: str) -> str:
    return "\n".join(ln for ln in (L6B / name).read_text().splitlines() if not ln.lstrip().startswith("#"))


def test_live_apply_refuses_when_8883_already_listening() -> None:
    text = _code("apply.sh")
    live = text[text.index('if [ -z "$ROOT" ]; then\n  systemctl show'):]
    assert "IDEA3_8883_ALREADY_IN_USE" in live
    assert live.index("IDEA3_8883_ALREADY_IN_USE") < live.index('install -D -m 0644 "$UNIT_SOURCE"')


def test_live_verify_requires_no_restarts() -> None:
    text = _code("verify.sh")
    assert "IDEA3_SERVICE_RESTARTED" in text and "NRestarts" in text


def test_live_apply_verifies_service_stays_up_after_start() -> None:
    text = _code("apply.sh")
    assert "IDEA3_SERVICE_NOT_STABLE" in text
    assert text.index("IDEA3_SERVICE_START_FAILED") < text.index("IDEA3_SERVICE_NOT_STABLE")
