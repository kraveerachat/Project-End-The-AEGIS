# shellcheck shell=bash disable=SC1091
"""AEGIS IDEA3 PR11 Phase 4 — L6b stage-owned live broker handler tests (fixture root only).

Authority: docs/superpowers/specs/2026-09-27-idea3-pr11-phase4-l6b-operational-design.md
Decisions: OD-L6B-01 .. OD-L6B-09. No test touches the real host: handlers run with AEGIS_P4_FS_ROOT fixtures,
and the live-probe tests start throwaway Mosquitto processes on loopback ephemeral ports as the test user.
"""

from __future__ import annotations

import os
import re
import socket
import stat
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
DEPLOY = ROOT / "deploy" / "pr11-phase4"
STAGE = DEPLOY / "stages" / "L6b"
APPLY, VERIFY, ROLLBACK = (STAGE / n for n in ("apply.sh", "verify.sh", "rollback.sh"))
CAPTURE = DEPLOY / "p4-l0-capture.sh"
COMPARE = DEPLOY / "p4-compare.sh"
VALIDATOR = DEPLOY / "p4-broker-validate.py"

AP = "10.77.30.1"
UPLINK = "192.168.1.144"
DEVICE_ID = "aegis-relay-01"
CORE_PW = "CANARY-core-secret-7f3a91c2d5e84b60a1f2c3d4e5f60718"
DEV_PW = "CANARY-device-secret-0b9e8d7c6a5f4e3d2c1b0a9988776655"
MQTT = "etc/aegis-idea3/mqtt"
MATERIAL = ("aegis-idea3-mosquitto.conf", "acl", "passwd", "ca.crt", "broker.crt", "broker.key")
UNIT_REL = "etc/systemd/system/aegis-idea3-mosquitto.service"


def make_pki(directory: Path, *, ca_cn: str = "AEGIS IDEA3 MQTT CA") -> None:
    """Throwaway TEST PKI. ca.key is created in a sibling scratch dir and never placed in the input dir."""
    scratch = directory.parent / (directory.name + "-pki-scratch")
    scratch.mkdir(parents=True, exist_ok=True)
    ext = scratch / "broker.ext"
    ext.write_text(
        "\n".join(
            [
                "subjectAltName=DNS:mqtt.aegis.home.arpa",
                "basicConstraints=critical,CA:FALSE",
                "keyUsage=critical,digitalSignature,keyEncipherment",
                "extendedKeyUsage=serverAuth",
                "",
            ]
        ),
        encoding="ascii",
    )
    for cmd in (
        ["openssl", "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes",
         "-keyout", str(scratch / "ca.key"), "-out", str(directory / "ca.crt"), "-days", "1", "-subj", f"/CN={ca_cn}"],
        ["openssl", "req", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes",
         "-keyout", str(directory / "broker.key"), "-out", str(scratch / "broker.csr"),
         "-subj", "/CN=mqtt.aegis.home.arpa"],
        ["openssl", "x509", "-req", "-in", str(scratch / "broker.csr"), "-CA", str(directory / "ca.crt"),
         "-CAkey", str(scratch / "ca.key"), "-CAcreateserial", "-CAserial", str(scratch / "ca.srl"), "-out", str(directory / "broker.crt"),
         "-days", "1", "-extfile", str(ext)],
    ):
        subprocess.run(cmd, check=True, capture_output=True)


@dataclass
class Fx:
    tmp: Path
    root: Path
    work: Path
    inp: Path

    @property
    def mqtt(self) -> Path:
        return self.root / MQTT

    @property
    def unit(self) -> Path:
        return self.root / UNIT_REL

    def env(self, **extra: str) -> dict[str, str]:
        env = {k: v for k, v in os.environ.items() if k not in {"SUDO_UID", "AEGIS_L6B_PROBE_PORT", "AEGIS_L6B_PROBE_ADDRESSES"}}
        env.update(
            AEGIS_P4_FS_ROOT=str(self.root),
            AEGIS_L6B_WORK_DIR=str(self.work),
            AEGIS_L6B_INPUT_DIR=str(self.inp),
            AEGIS_AP_ADDRESS=AP,
            AEGIS_UPLINK_ADDRESS=UPLINK,
            AEGIS_AP_INTERFACE="wlp0s20f3",
            AEGIS_PYTHON_BIN=sys.executable,
        )
        env.update(extra)
        return env

    def run(self, script: Path, **extra: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(["bash", str(script)], text=True, capture_output=True, check=False, env=self.env(**extra))

    def tree(self) -> dict[str, str]:
        out: dict[str, str] = {}
        for p in sorted(self.root.rglob("*")):
            if p.is_file() and not p.is_symlink():
                out[str(p.relative_to(self.root))] = p.read_bytes().hex()
        return out


def build(tmp_path: Path) -> Fx:
    root = tmp_path / "fs"
    (root / "etc/aegis-idea3").mkdir(parents=True)
    (root / "etc/aegis-idea3/aegis-idea3.nft").write_text("table inet aegis_idea3 {}\n", encoding="utf-8")
    (root / "etc/mosquitto").mkdir(parents=True)
    (root / "etc/mosquitto/mosquitto.conf").write_text("listener 1883\nallow_anonymous false\n", encoding="utf-8")
    (root / "etc/mosquitto/passwd").write_text("aegis:$7$101$legacyhashlegacyhash\n", encoding="utf-8")
    inp = tmp_path / "input"
    inp.mkdir(mode=0o700)
    make_pki(inp)
    (inp / "core.pass").write_text(CORE_PW + "\n", encoding="utf-8")
    (inp / "device.pass").write_text(DEV_PW + "\n", encoding="utf-8")
    for name in ("broker.key", "core.pass", "device.pass"):
        (inp / name).chmod(0o600)
    for name in ("ca.crt", "broker.crt"):
        (inp / name).chmod(0o644)
    inp.chmod(0o700)
    return Fx(tmp_path, root, tmp_path / "work", inp)


@pytest.fixture()
def fx(tmp_path: Path) -> Fx:
    return build(tmp_path)


def applied(fx: Fx) -> subprocess.CompletedProcess[str]:
    res = fx.run(APPLY)
    assert res.returncode == 0, res.stdout + res.stderr
    return res


# ── files / registration ─────────────────────────────────────────────────────────────────────────────────────────────


def test_l6b_handler_files_exist_and_are_syntactically_valid() -> None:
    for name in ("apply.sh", "verify.sh", "rollback.sh", "allow-keys.txt", "allow-listeners.txt"):
        assert (STAGE / name).is_file()
    for script in (APPLY, VERIFY, ROLLBACK):
        assert subprocess.run(["bash", "-n", str(script)], capture_output=True).returncode == 0


def test_l6b_allow_keys_are_exact_and_never_broad() -> None:
    keys = [l.strip() for l in (STAGE / "allow-keys.txt").read_text().splitlines() if l.strip() and not l.startswith("#")]
    assert len(keys) == len(set(keys))
    assert not any("*" in k for k in keys)
    assert "host.aegis_idea3.file./etc/aegis-idea3/mqtt/broker.key.meta" in keys
    assert "host.unit_file./etc/systemd/system/aegis-idea3-mosquitto.service.sha256" in keys
    host = [k for k in keys if k.startswith("host.")]
    for k in host:
        assert k.startswith(
            ("host.aegis_idea3.file./etc/aegis-idea3/mqtt/", "host.unit_file./etc/systemd/system/aegis-idea3-mosquitto.service.")
        ) or k == "host.path./etc/aegis-idea3/mqtt", k
    # the six material files x (class, meta) + unit x (class, sha256, meta) + the directory
    assert len(host) == 6 * 2 + 3 + 1


def test_l6b_allow_listeners_are_exactly_loopback_and_ap_8883() -> None:
    lines = [l.strip() for l in (STAGE / "allow-listeners.txt").read_text().splitlines() if l.strip() and not l.startswith("#")]
    assert lines == ["listen.tcp.127.0.0.1:8883", "listen.tcp.<AEGIS_AP_ADDRESS>:8883"]


def test_l6b_no_handler_contains_forbidden_commands() -> None:
    for script in (APPLY, VERIFY, ROLLBACK):
        text = script.read_text(encoding="utf-8")
        for pat in (r"\bpkill\b", r"\bkillall\b", r"rm\s+-\w*r", r"systemctl\s+(restart|stop|disable|enable\s+--now)\s+mosquitto\.service"):
            assert not re.search(pat, text), (script.name, pat)
        assert "nmcli" not in text and "nft " not in text.replace("nft list", "")


# ── apply: input contract ────────────────────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("var", ["AEGIS_L6B_WORK_DIR", "AEGIS_L6B_INPUT_DIR", "AEGIS_AP_ADDRESS", "AEGIS_UPLINK_ADDRESS"])
def test_l6b_apply_requires_environment(fx: Fx, var: str) -> None:
    res = fx.run(APPLY, **{var: ""})
    assert res.returncode != 0 and f"{var}_REQUIRED" in res.stderr
    assert not fx.mqtt.exists()


@pytest.mark.parametrize("ap,uplink", [("0.0.0.0", UPLINK), ("127.0.0.1", UPLINK), (AP, AP), (AP, "not-an-ip"), ("::1", UPLINK)])
def test_l6b_apply_rejects_bad_addresses(fx: Fx, ap: str, uplink: str) -> None:
    res = fx.run(APPLY, AEGIS_AP_ADDRESS=ap, AEGIS_UPLINK_ADDRESS=uplink)
    assert res.returncode != 0
    assert not fx.mqtt.exists() and not fx.unit.exists()


def test_l6b_apply_rejects_input_dir_that_is_not_private(fx: Fx) -> None:
    fx.inp.chmod(0o755)
    res = fx.run(APPLY)
    assert res.returncode != 0 and "INPUT_DIR_MODE_NOT_0700" in res.stderr
    assert not fx.mqtt.exists()


def test_l6b_apply_rejects_input_dir_symlink(fx: Fx) -> None:
    link = fx.tmp / "input-link"
    link.symlink_to(fx.inp)
    res = fx.run(APPLY, AEGIS_L6B_INPUT_DIR=str(link))
    assert res.returncode != 0 and "INPUT_DIR_INVALID" in res.stderr


def test_l6b_apply_rejects_ca_private_key_in_input(fx: Fx) -> None:
    (fx.inp / "ca.key").write_text("-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n")
    (fx.inp / "ca.key").chmod(0o600)
    res = fx.run(APPLY)
    assert res.returncode != 0 and "CA_PRIVATE_KEY_FORBIDDEN" in res.stderr
    assert not fx.mqtt.exists()


def test_l6b_apply_rejects_unknown_input_entry(fx: Fx) -> None:
    (fx.inp / "notes.txt").write_text("x")
    res = fx.run(APPLY)
    assert res.returncode != 0 and "INPUT_DIR_ENTRIES_NOT_EXACT" in res.stderr


def test_l6b_apply_rejects_missing_input_file(fx: Fx) -> None:
    (fx.inp / "device.pass").unlink()
    res = fx.run(APPLY)
    assert res.returncode != 0 and "INPUT_DIR_ENTRIES_NOT_EXACT" in res.stderr


def test_l6b_apply_rejects_symlinked_input_file(fx: Fx) -> None:
    real = fx.tmp / "real.pass"
    real.write_text(CORE_PW + "\n")
    real.chmod(0o600)
    (fx.inp / "core.pass").unlink()
    (fx.inp / "core.pass").symlink_to(real)
    res = fx.run(APPLY)
    assert res.returncode != 0 and "INPUT_FILE_NOT_REGULAR" in res.stderr


@pytest.mark.parametrize("name", ["broker.key", "core.pass", "device.pass"])
@pytest.mark.parametrize("mode", [0o640, 0o644, 0o660])
def test_l6b_apply_rejects_loose_secret_modes(fx: Fx, name: str, mode: int) -> None:
    (fx.inp / name).chmod(mode)
    res = fx.run(APPLY)
    assert res.returncode != 0 and f"INPUT_SECRET_MODE_INVALID:{name}" in res.stderr
    assert not fx.mqtt.exists()


def test_l6b_apply_accepts_0400_secrets(fx: Fx) -> None:
    for name in ("broker.key", "core.pass", "device.pass"):
        (fx.inp / name).chmod(0o400)
    assert fx.run(APPLY).returncode == 0


def test_l6b_apply_rejects_key_that_does_not_match_certificate(fx: Fx) -> None:
    other = fx.tmp / "other"
    other.mkdir()
    make_pki(other)
    (fx.inp / "broker.key").write_bytes((other / "broker.key").read_bytes())
    (fx.inp / "broker.key").chmod(0o600)
    res = fx.run(APPLY)
    assert res.returncode != 0 and "PKI_VALIDATION_FAILED" in res.stderr
    assert not fx.mqtt.exists() and not fx.unit.exists()


def test_l6b_apply_rejects_certificate_from_a_different_ca(fx: Fx) -> None:
    other = fx.tmp / "other"
    other.mkdir()
    make_pki(other, ca_cn="Some Other CA")
    (fx.inp / "ca.crt").write_bytes((other / "ca.crt").read_bytes())
    res = fx.run(APPLY)
    assert res.returncode != 0 and "PKI_VALIDATION_FAILED" in res.stderr


# ── apply: pre-state ─────────────────────────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("rel", [MQTT, UNIT_REL, MQTT + "/passwd"])
def test_l6b_apply_fails_when_destination_prestate_is_unexpected(fx: Fx, rel: str) -> None:
    target = fx.root / rel
    target.parent.mkdir(parents=True, exist_ok=True)
    if rel == MQTT:
        target.mkdir()
    else:
        target.write_text("pre-existing\n")
    before = fx.tree()
    res = fx.run(APPLY)
    assert res.returncode != 0 and "PRESTATE_UNEXPECTED" in res.stderr
    assert fx.tree() == before  # nothing installed, nothing overwritten


def test_l6b_apply_refuses_existing_work_dir(fx: Fx) -> None:
    fx.work.mkdir()
    res = fx.run(APPLY)
    assert res.returncode != 0 and "WORK_DIR_ALREADY_EXISTS" in res.stderr


def test_l6b_apply_requires_idea3_etc_root(fx: Fx) -> None:
    (fx.root / "etc/aegis-idea3/aegis-idea3.nft").unlink()
    (fx.root / "etc/aegis-idea3").rmdir()
    res = fx.run(APPLY)
    assert res.returncode != 0 and "IDEA3_ETC_MISSING_OR_SYMLINK" in res.stderr


def test_l6b_apply_requires_legacy_aegis_user(fx: Fx) -> None:
    (fx.root / "etc/mosquitto/passwd").write_text("someone:$7$101$x\n")
    res = fx.run(APPLY)
    assert res.returncode != 0 and "LEGACY_AEGIS_USER_MISSING" in res.stderr


def test_l6b_live_mode_requires_authorization_flag_and_root(fx: Fx) -> None:
    env = fx.env()
    env.pop("AEGIS_P4_FS_ROOT")
    res = subprocess.run(["bash", str(APPLY)], text=True, capture_output=True, check=False, env=env)
    assert res.returncode != 0 and "LIVE_AUTHORIZATION_FLAG_REQUIRED" in res.stderr
    env["AEGIS_L6B_LIVE_AUTHORIZED"] = "YES"
    res = subprocess.run(["bash", str(APPLY)], text=True, capture_output=True, check=False, env=env)
    assert res.returncode != 0 and ("ROOT_REQUIRED" in res.stderr)
    assert not fx.work.exists()


# ── apply: stage-owned installation ──────────────────────────────────────────────────────────────────────────────────


def test_l6b_apply_installs_exactly_the_stage_owned_material(fx: Fx) -> None:
    before = fx.tree()
    res = applied(fx)
    assert "L6B_APPLY=PASS" in res.stdout
    assert "L6B_PLAINTEXT_PASSWORDS_INSTALLED=NO" in res.stdout
    assert "PRODUCTION_MUTATION_PERFORMED=YES" in res.stdout
    assert sorted(p.name for p in fx.mqtt.iterdir()) == sorted(MATERIAL)
    modes = {p.name: stat.S_IMODE(p.stat().st_mode) for p in fx.mqtt.iterdir()}
    assert modes == {
        "aegis-idea3-mosquitto.conf": 0o640, "acl": 0o640, "passwd": 0o640,
        "ca.crt": 0o644, "broker.crt": 0o644, "broker.key": 0o640,
    }
    assert stat.S_IMODE(fx.mqtt.stat().st_mode) == 0o750
    assert stat.S_IMODE(fx.unit.stat().st_mode) == 0o644
    assert fx.unit.read_text() == (ROOT / "deploy/mosquitto/aegis-idea3-mosquitto.service.example").read_text()
    # only the L6b-owned paths appeared; nothing pre-existing changed
    after = fx.tree()
    added = set(after) - set(before)
    assert added == {f"{MQTT}/{m}" for m in MATERIAL} | {UNIT_REL}
    assert all(after[k] == v for k, v in before.items())
    # owner JIT input untouched
    assert sorted(p.name for p in fx.inp.iterdir()) == ["broker.crt", "broker.key", "ca.crt", "core.pass", "device.pass"]


def test_l6b_apply_installs_the_owner_pki_bytes_unchanged(fx: Fx) -> None:
    applied(fx)
    for name in ("ca.crt", "broker.crt", "broker.key"):
        assert (fx.mqtt / name).read_bytes() == (fx.inp / name).read_bytes()


def test_l6b_apply_never_persists_plaintext_passwords_or_leaks_them(fx: Fx) -> None:
    res = applied(fx)
    assert not (fx.mqtt / "core.pass").exists() and not (fx.mqtt / "device.pass").exists()
    corpus = [res.stdout, res.stderr]
    for p in list(fx.root.rglob("*")) + list(fx.work.rglob("*")):
        if p.is_file():
            corpus.append(p.read_text(errors="ignore"))
    joined = "\n".join(corpus)
    for secret in (CORE_PW, DEV_PW):
        assert secret not in joined
    # hashed DB is installed but its hashes are not copied into evidence/work/stdout
    hashes = [l.split(":", 1)[1] for l in (fx.mqtt / "passwd").read_text().splitlines()]
    assert len(hashes) == 2 and all(h.startswith("$") for h in hashes)
    evidence = "\n".join([res.stdout, res.stderr] + [p.read_text(errors="ignore") for p in fx.work.rglob("*") if p.is_file()])
    for h in hashes:
        assert h not in evidence
    assert not (fx.work / "stage" / "passwd").exists()


def test_l6b_password_db_has_only_idea3_identities_and_no_legacy_aegis(fx: Fx) -> None:
    applied(fx)
    users = sorted(l.split(":", 1)[0] for l in (fx.mqtt / "passwd").read_text().splitlines())
    assert users == ["idea3-core", f"idea3-dev-{DEVICE_ID}"]
    acl = (fx.mqtt / "acl").read_text()
    assert f"aegis/idea3/v1/{DEVICE_ID}/command" in acl and "device-id" not in acl
    assert "user aegis\n" not in acl


def test_l6b_rendered_config_scope_and_policy(fx: Fx) -> None:
    applied(fx)
    conf = (fx.mqtt / "aegis-idea3-mosquitto.conf").read_text()
    listeners = [l for l in conf.splitlines() if l.startswith("listener ")]
    assert listeners == ["listener 8883 127.0.0.1", f"listener 8883 {AP}"]
    assert UPLINK not in conf and "listener 1883" not in conf and "/etc/mosquitto" not in conf and "<AEGIS_" not in conf
    for line in ("allow_anonymous false", "persistence false", "retain_available false", "tls_version tlsv1.2"):
        assert line in conf.splitlines()
    for key in ("password_file", "acl_file", "cafile", "certfile", "keyfile"):
        m = re.search(rf"^{key} (\S+)$", conf, re.M)
        assert m and m.group(1).startswith("/etc/aegis-idea3/mqtt/")


def test_l6b_apply_journals_every_owned_path_before_creation(fx: Fx) -> None:
    applied(fx)
    entries = [tuple(l.split("\t")) for l in (fx.work / "journal.tsv").read_text().splitlines()]
    assert entries[0] == ("DIR", "/etc/aegis-idea3/mqtt")
    assert {e for e in entries if e[0] == "FILE"} == {("FILE", f"/etc/aegis-idea3/mqtt/{m}") for m in MATERIAL}
    assert ("UNIT", "/etc/systemd/system/aegis-idea3-mosquitto.service") in entries
    assert stat.S_IMODE((fx.work / "journal.tsv").stat().st_mode) == 0o600
    assert stat.S_IMODE(fx.work.stat().st_mode) == 0o700


def test_l6b_apply_manifest_records_digests_only_for_non_secret_material(fx: Fx) -> None:
    applied(fx)
    rows = [l.split("\t") for l in (fx.work / "apply-manifest.tsv").read_text().splitlines()[1:]]
    by_path = {r[0]: r for r in rows}
    assert by_path["/etc/aegis-idea3/mqtt/passwd"][4] == "SECRET_NOT_RECORDED"
    assert by_path["/etc/aegis-idea3/mqtt/broker.key"][4] == "SECRET_NOT_RECORDED"
    assert re.fullmatch(r"[0-9a-f]{64}", by_path["/etc/aegis-idea3/mqtt/ca.crt"][4])


def test_l6b_apply_leaves_legacy_tree_untouched(fx: Fx) -> None:
    legacy = {k: v for k, v in fx.tree().items() if k.startswith("etc/mosquitto/")}
    applied(fx)
    assert {k: v for k, v in fx.tree().items() if k.startswith("etc/mosquitto/")} == legacy


def test_l6b_apply_failure_after_validation_leaves_no_material_and_no_hashed_stage_copy(fx: Fx) -> None:
    (fx.inp / "broker.key").write_text("garbage\n")
    (fx.inp / "broker.key").chmod(0o600)
    res = fx.run(APPLY)
    assert res.returncode != 0
    assert not fx.mqtt.exists() and not fx.unit.exists()
    assert not (fx.work / "stage" / "passwd").exists()


# ── verify (fixture) ─────────────────────────────────────────────────────────────────────────────────────────────────


def test_l6b_verify_passes_on_applied_fixture_and_writes_non_secret_evidence(fx: Fx) -> None:
    applied(fx)
    res = fx.run(VERIFY)
    assert res.returncode == 0, res.stdout + res.stderr
    assert "L6B_VERIFY=PASS" in res.stdout and "L6B_MATERIAL_EXACT=PASS" in res.stdout
    assert "L6B_LIVE_TLS_AUTH_ACL=NOT_RUN_FIXTURE" in res.stdout
    ev = (fx.work / "validation-evidence.tsv").read_text()
    assert "stage\tL6b" in ev and "plaintext_passwords_installed\tNO" in ev
    assert CORE_PW not in ev and DEV_PW not in ev


@pytest.mark.parametrize(
    "mutate,reason",
    [
        (lambda f: (f.mqtt / "broker.key").chmod(0o644), "MATERIAL_MODE_INVALID:broker.key"),
        (lambda f: (f.mqtt / "passwd").chmod(0o600), "MATERIAL_MODE_INVALID:passwd"),
        (lambda f: (f.mqtt / "passwd").chmod(0o660), "MATERIAL_MODE_INVALID:passwd"),
        (lambda f: (f.mqtt / "broker.key").chmod(0o600), "MATERIAL_MODE_INVALID:broker.key"),
        (lambda f: (f.mqtt / "broker.key").chmod(0o660), "MATERIAL_MODE_INVALID:broker.key"),
        (lambda f: (f.mqtt / "acl").chmod(0o660), "MATERIAL_MODE_INVALID:acl"),
        (lambda f: f.mqtt.chmod(0o770), "MQTT_DIR_MODE_INVALID"),
        (lambda f: (f.mqtt / "core.pass").write_text("x"), "MQTT_DIR_ENTRIES_NOT_EXACT"),
        (lambda f: (f.mqtt / "ca.key").write_text("x"), "MQTT_DIR_ENTRIES_NOT_EXACT"),
        (lambda f: (f.mqtt / "aegis-idea3-mosquitto.conf").write_text((f.mqtt / "aegis-idea3-mosquitto.conf").read_text() + "# x\n"), "MATERIAL_DIGEST_CHANGED"),
        (lambda f: f.unit.write_text(f.unit.read_text() + "\n# x\n"), "MATERIAL_DIGEST_CHANGED"),
        (lambda f: (f.root / "etc/mosquitto/passwd").write_text("aegis:$7$101$changed\n"), "LEGACY_CONFIG_TREE_CHANGED"),
        (lambda f: (f.root / "etc/mosquitto/mosquitto.conf").write_text("listener 1883\n"), "LEGACY_CONFIG_TREE_CHANGED"),
    ],
)
def test_l6b_verify_fails_closed_on_drift(fx: Fx, mutate, reason: str) -> None:
    applied(fx)
    mutate(fx)
    res = fx.run(VERIFY)
    assert res.returncode != 0 and reason in res.stderr, res.stderr


def test_l6b_verify_fails_on_wildcard_or_uplink_bind_in_installed_config(fx: Fx) -> None:
    applied(fx)
    conf = fx.mqtt / "aegis-idea3-mosquitto.conf"
    text = conf.read_text().replace(f"listener 8883 {AP}", f"listener 8883 {UPLINK}")
    conf.write_text(text)
    res = fx.run(VERIFY)
    assert res.returncode != 0


# ── rollback ─────────────────────────────────────────────────────────────────────────────────────────────────────────


def test_l6b_rollback_restores_exact_pre_state_and_is_idempotent(fx: Fx) -> None:
    before = fx.tree()
    applied(fx)
    res = fx.run(ROLLBACK)
    assert res.returncode == 0, res.stdout + res.stderr
    assert "L6B_ROLLBACK=PASS" in res.stdout and "IDEA3_MATERIAL_RESIDUE=NO" in res.stdout
    assert fx.tree() == before
    assert not fx.mqtt.exists() and not fx.unit.exists()
    again = fx.run(ROLLBACK)
    assert again.returncode == 0, again.stdout + again.stderr
    assert fx.tree() == before
    assert sorted(p.name for p in fx.inp.iterdir()) == ["broker.crt", "broker.key", "ca.crt", "core.pass", "device.pass"]


def test_l6b_rollback_preserves_unrelated_idea3_etc_files(fx: Fx) -> None:
    applied(fx)
    assert fx.run(ROLLBACK).returncode == 0
    assert (fx.root / "etc/aegis-idea3/aegis-idea3.nft").read_text() == "table inet aegis_idea3 {}\n"


def test_l6b_rollback_refuses_to_remove_unowned_entries(fx: Fx) -> None:
    applied(fx)
    (fx.mqtt / "operator-note.txt").write_text("not ours\n")
    res = fx.run(ROLLBACK)
    assert res.returncode != 0 and "MQTT_DIR_HAS_UNOWNED_ENTRIES" in res.stderr
    assert (fx.mqtt / "operator-note.txt").exists()  # never recursively removed


def test_l6b_rollback_after_partial_apply_removes_only_journaled_paths(fx: Fx) -> None:
    applied(fx)
    # simulate a crash after the directory and two files: keep the journal prefix, drop the rest from disk and journal
    keep = {"DIR", "FILE"}
    lines = [l for l in (fx.work / "journal.tsv").read_text().splitlines() if l.split("\t")[0] in keep][:3]
    (fx.work / "journal.tsv").write_text("\n".join(lines) + "\n")
    for m in ("passwd", "ca.crt", "broker.crt", "broker.key"):
        (fx.mqtt / m).unlink()
    fx.unit.unlink()
    res = fx.run(ROLLBACK)
    assert res.returncode == 0, res.stdout + res.stderr
    assert not fx.mqtt.exists()


def test_l6b_rollback_with_empty_journal_touches_nothing(fx: Fx) -> None:
    applied(fx)
    (fx.work / "journal.tsv").write_text("")
    before = fx.tree()
    fx.run(ROLLBACK)
    assert fx.tree() == before  # nothing journaled => nothing removed (no broad cleanup)
    assert (fx.mqtt / "broker.key").exists() and fx.unit.exists()


@pytest.mark.parametrize(
    "line",
    ["FILE\t/etc/mosquitto/passwd", "FILE\t/etc/aegis-idea3/aegis-idea3.nft", "DIR\t/etc/aegis-idea3",
     "UNIT\t/etc/systemd/system/mosquitto.service", "SERVICE\tmosquitto.service", "WHATEVER\tx", "FILE\t../../etc/passwd"],
)
def test_l6b_rollback_rejects_tampered_journal_entries(fx: Fx, line: str) -> None:
    applied(fx)
    with (fx.work / "journal.tsv").open("a") as fh:
        fh.write(line + "\n")
    before = fx.tree()
    res = fx.run(ROLLBACK)
    assert res.returncode != 0 and ("JOURNAL_ENTRY_NOT_OWNED" in res.stderr or "JOURNAL_ENTRY_UNKNOWN" in res.stderr)
    assert fx.tree() == before


def test_l6b_rollback_requires_journal_and_legacy_baseline(fx: Fx) -> None:
    applied(fx)
    (fx.work / "journal.tsv").unlink()
    assert "JOURNAL_MISSING" in fx.run(ROLLBACK).stderr


def test_l6b_rollback_detects_legacy_tree_change(fx: Fx) -> None:
    applied(fx)
    (fx.root / "etc/mosquitto/mosquitto.conf").write_text("listener 1883\n#changed\n")
    res = fx.run(ROLLBACK)
    assert res.returncode != 0 and "LEGACY_CONFIG_TREE_CHANGED" in res.stderr


# ── capture / compare contract ───────────────────────────────────────────────────────────────────────────────────────


def _load_make_bundle():
    import importlib.util

    spec = importlib.util.spec_from_file_location("g15_host_artifacts_helpers", ROOT / "tests/test_pr11_phase4_g15_host_artifacts.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.make_bundle


def capture(fx: Fx, label: str) -> Path:
    """Run the REAL capture script on the fixture root, then rebuild a COMPLETE comparable bundle from its host records.

    The fixture host has no nft/boot_id, so a raw fixture capture is (correctly) PARTIAL and incomparable; the host.*
    records themselves are exactly what p4-l0-capture.sh produced.
    """
    evid = fx.tmp / f"evid-{label}"
    env = os.environ.copy()
    env.update(P4_FS_ROOT=str(fx.root), EVID_DIR=str(evid), JOURNAL_SINCE="2026-09-27 00:00:00 UTC", CAPTURE_LABEL=label)
    res = subprocess.run(["bash", str(CAPTURE)], text=True, capture_output=True, check=False, env=env)
    assert res.returncode in (0, 3), res.stdout + res.stderr
    records: dict[str, str] = {}
    for tsv in ("host.tsv",):  # listeners/services come from the real host, not the fixture root
        for line in (evid / tsv).read_text().splitlines():
            key, _, value = line.partition("\t")
            if value and value != "UNAVAILABLE" and key.startswith("host.") and not key.startswith("host.identity"):
                records[key] = value
    return _load_make_bundle()(fx.tmp / f"bundle-{label}", label, records)


def compare(before: Path, after: Path, *, allow: bool) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    env.update(DISK_THRESHOLD_PCT="90", AEGIS_AP_ADDRESS=AP, AEGIS_AP_INTERFACE="wlp0s20f3")
    if allow:
        env.update(ALLOW_KEYS_FILE=str(STAGE / "allow-keys.txt"), ALLOW_LISTENERS_FILE=str(STAGE / "allow-listeners.txt"))
    return subprocess.run(["bash", str(COMPARE), str(before), str(after)], text=True, capture_output=True, check=False, env=env)


def test_l6b_capture_records_owned_unit_and_directory_with_exact_keys(fx: Fx) -> None:
    pre = capture(fx, "pre")
    applied(fx)
    post = capture(fx, "post")
    pre_host = (fx.tmp / "evid-pre" / "host.tsv").read_text()
    post_host = (fx.tmp / "evid-post" / "host.tsv").read_text()
    assert "host.path./etc/aegis-idea3/mqtt\tabsent" in pre_host
    assert "host.path./etc/aegis-idea3/mqtt\tpresent" in post_host
    for name in MATERIAL:
        assert f"host.aegis_idea3.file./etc/aegis-idea3/mqtt/{name}.meta\t" in post_host
        assert f"host.aegis_idea3.file./etc/aegis-idea3/mqtt/{name}.meta\t" not in pre_host
    assert "host.unit_file./etc/systemd/system/aegis-idea3-mosquitto.service.sha256\t" in post_host
    # secrets are recorded by metadata only
    assert CORE_PW not in post_host and DEV_PW not in post_host
    assert "broker.key.sha256" not in post_host and "passwd.sha256" not in post_host


def test_l6b_pre_post_allows_exactly_the_approved_deltas(fx: Fx) -> None:
    pre = capture(fx, "pre")
    applied(fx)
    post = capture(fx, "post")
    denied = compare(pre, post, allow=False)
    assert denied.returncode == 1 and "COMPARE_RESULT=FAIL" in denied.stdout
    ok = compare(pre, post, allow=True)
    assert ok.returncode == 0, ok.stdout + ok.stderr
    assert "FINDINGS_NEW_OR_WORSENED_DRIFT=0" in ok.stdout and "COMPARE_RESULT=PASS" in ok.stdout
    assert "FINDINGS_APPROVED_CHANGE=" in ok.stdout and "FINDINGS_APPROVED_CHANGE=0" not in ok.stdout


def test_l6b_pre_post_rejects_unapproved_extra_file_in_idea3_etc(fx: Fx) -> None:
    pre = capture(fx, "pre")
    applied(fx)
    (fx.root / "etc/aegis-idea3/extra.conf").write_text("x\n")
    post = capture(fx, "post")
    res = compare(pre, post, allow=True)
    assert res.returncode == 1 and "COMPARE_RESULT=FAIL" in res.stdout


def test_l6b_pre_post_rejects_unapproved_extra_file_in_mqtt_dir(fx: Fx) -> None:
    pre = capture(fx, "pre")
    applied(fx)
    (fx.mqtt / "extra.pem").write_text("x\n")
    post = capture(fx, "post")
    res = compare(pre, post, allow=True)
    assert res.returncode == 1


def test_l6b_pre_post_still_rejects_legacy_or_unit_drift(fx: Fx) -> None:
    pre = capture(fx, "pre")
    applied(fx)
    (fx.root / "etc/systemd/system/aegis-idea3-core.service").write_text("[Unit]\n")
    post = capture(fx, "post")
    res = compare(pre, post, allow=True)
    assert res.returncode == 1  # the Core unit is not an approved L6b change


def test_l6b_pre_rb_returns_to_pre_with_no_allowances(fx: Fx) -> None:
    pre = capture(fx, "pre")
    applied(fx)
    assert fx.run(ROLLBACK).returncode == 0
    rb = capture(fx, "rb")
    res = compare(pre, rb, allow=False)
    assert res.returncode == 0, res.stdout + res.stderr
    assert "FINDINGS_NEW_OR_WORSENED_DRIFT=0" in res.stdout and "FINDINGS_APPROVED_CHANGE=0" in res.stdout


def test_l6b_pre_rb_detects_residue(fx: Fx) -> None:
    pre = capture(fx, "pre")
    applied(fx)
    assert fx.run(ROLLBACK).returncode == 0
    fx.mqtt.mkdir()
    rb = capture(fx, "rb")
    assert compare(pre, rb, allow=False).returncode == 1


# ── ownership model: root:mosquitto for what the privilege-dropped broker reads ──────────────────────────────────────

import grp
import json
import textwrap

UNIT = "aegis-idea3-mosquitto.service"
OTHER_FAILED = "aegis-idea3-dnsmasq.service"
BROKER_GROUP_FILES = ("aegis-idea3-mosquitto.conf", "acl", "passwd", "broker.key")
OWNERSHIP_MODEL = {
    "/etc/aegis-idea3/mqtt": ("750", "root:mosquitto"),
    "/etc/aegis-idea3/mqtt/aegis-idea3-mosquitto.conf": ("640", "root:mosquitto"),
    "/etc/aegis-idea3/mqtt/acl": ("640", "root:mosquitto"),
    "/etc/aegis-idea3/mqtt/passwd": ("640", "root:mosquitto"),
    "/etc/aegis-idea3/mqtt/broker.key": ("640", "root:mosquitto"),
    "/etc/aegis-idea3/mqtt/ca.crt": ("644", "root:root"),
    "/etc/aegis-idea3/mqtt/broker.crt": ("644", "root:root"),
    "/etc/systemd/system/aegis-idea3-mosquitto.service": ("644", "root:root"),
}


def fixture_broker_group() -> str:
    """A group of the test user that is NOT its primary group when possible, so a missing chgrp is detectable."""
    primary = os.getgid()
    for gid in os.getgroups():
        if gid != primary:
            return grp.getgrgid(gid).gr_name
    return grp.getgrgid(primary).gr_name


# A stateful fake of exactly the systemctl surface the L6b handlers use. It models the lifecycle facts observed live:
# a failed Type=simple unit stays in memory as failed after its unit file is removed and daemon-reload runs
# (LoadState=not-found, ActiveState=failed) until reset-failed names it; a bare reset-failed clears EVERY failed unit;
# and the broker "drops privileges" to a principal whose only group is the fixture broker group, never the file owner.
FAKE_SYSTEMCTL = r"""#!__PY__
import grp, json, os, sys
STATE, ROOT, GROUP = os.environ["FAKE_SYSTEMD_STATE"], os.environ["FAKE_ROOT"], os.environ["AEGIS_L6B_FIXTURE_BROKER_GROUP"]
UNIT = "aegis-idea3-mosquitto.service"
st = json.load(open(STATE))
argv = sys.argv[1:]
unit_file = os.path.exists(ROOT + "/etc/systemd/system/" + UNIT)
st["calls"].append({"argv": argv, "unit_file": unit_file})
def save():
    json.dump(st, open(STATE, "w"), indent=1)
def die(msg, rc):
    save(); sys.stderr.write(msg + "\n"); sys.exit(rc)
CLEAN = dict(load="not-found", active="inactive", sub="dead", result="success", enabled=False, pid=0, nrestarts=0, persistent=False)
def get(u):
    return st["units"].get(u, dict(CLEAN))
def readable(path):
    s = os.stat(ROOT + path); m = s.st_mode
    return bool(m & 0o004) or (bool(m & 0o040) and grp.getgrgid(s.st_gid).gr_name == GROUP)
def traversable(path):
    s = os.stat(ROOT + path); m = s.st_mode
    return bool(m & 0o001) or (bool(m & 0o010) and grp.getgrgid(s.st_gid).gr_name == GROUP)
def start():
    u = st["units"][UNIT]
    checks = [("/etc/aegis-idea3/mqtt/aegis-idea3-mosquitto.conf", "config"), ("/etc/aegis-idea3/mqtt/passwd", "password-file"),
              ("/etc/aegis-idea3/mqtt/acl", "acl-file"), ("/etc/aegis-idea3/mqtt/broker.key", "keyfile"),
              ("/etc/aegis-idea3/mqtt/ca.crt", "cafile"), ("/etc/aegis-idea3/mqtt/broker.crt", "certfile")]
    err = None
    if not traversable("/etc/aegis-idea3/mqtt"):
        err = "mqtt directory not traversable by mosquitto"
    for path, what in checks:
        if err is None and not readable(path):
            err = "%s: Error: Unable to open %s" % (what, path)
    u["load"] = "loaded"
    if err:
        u.update(active="failed", sub="failed", result="exit-code", pid=0)
        st["journal"].append("Info: running mosquitto as user: mosquitto.")
        st["journal"].append(err)
    else:
        u.update(active="active", sub="running", result="success", pid=4242)
def props(u):
    return {"LoadState": u["load"], "ActiveState": u["active"], "SubState": u["sub"], "Result": u["result"],
            "UnitFileState": ("enabled" if u["enabled"] else "disabled") if u["load"] == "loaded" else "",
            "MainPID": str(u["pid"]), "NRestarts": str(u["nrestarts"]), "ExecMainStartTimestamp": ""}
if not argv:
    die("no command", 2)
cmd, rest = argv[0], argv[1:]
if cmd == "show":
    want, value, name, i = [], False, None, 0
    while i < len(rest):
        if rest[i] == "-p": want.append(rest[i + 1]); i += 2
        elif rest[i] == "--value": value = True; i += 1
        else: name = rest[i]; i += 1
    p = props(get(name))
    for k in (want or list(p)):
        print(p[k] if value else "%s=%s" % (k, p[k]))
    save(); sys.exit(0)
if cmd == "is-active":
    save(); sys.exit(0 if get(rest[-1])["active"] == "active" else 3)
if cmd == "is-enabled":
    save(); sys.exit(0 if get(rest[-1])["enabled"] else 1)
if cmd == "daemon-reload":
    for name, u in list(st["units"].items()):
        if name == UNIT:
            if not unit_file:
                if u["active"] == "failed": u["load"] = "not-found"
                else: del st["units"][name]
            elif u["load"] == "not-found": u["load"] = "loaded"
    save(); sys.exit(0)
if cmd == "stop":
    u = st["units"].get(rest[-1])
    if u and u["active"] == "active": u.update(active="inactive", sub="dead", result="success", pid=0)
    save(); sys.exit(0)
if cmd == "disable":
    u = st["units"].get(rest[-1])
    if u: u["enabled"] = False
    save(); sys.exit(0)
if cmd in ("enable", "start"):
    name = rest[-1]
    if name != UNIT: die("fake: refusing to %s %s" % (cmd, name), 2)
    if not unit_file: die("Unit file does not exist", 1)
    u = st["units"].setdefault(UNIT, dict(CLEAN))
    if cmd == "enable": u["enabled"] = True
    if cmd == "start" or "--now" in rest: start()
    save(); sys.exit(0)
if cmd == "reset-failed":
    if os.environ.get("FAKE_SYSTEMD_NOOP_RESET_FAILED") == "1":
        save(); sys.exit(0)
    names = [a for a in rest if not a.startswith("-")]
    if not names:
        names = [n for n, u in st["units"].items() if u["active"] == "failed"]
    for name in names:
        u = st["units"].get(name)
        if u is None: die("Unit %s not loaded." % name, 1)
        if u["active"] == "failed":
            u.update(active="inactive", sub="dead", result="success", pid=0)
        if u["load"] == "not-found": del st["units"][name]
    save(); sys.exit(0)
die("fake systemctl: unsupported command " + cmd, 2)
"""


class Systemd:
    """Per-test fake systemd manager state + the environment that routes the handlers/capture to it."""

    def __init__(self, fx: Fx) -> None:
        self.fx = fx
        self.bin = fx.tmp / "fakebin"
        self.bin.mkdir()
        exe = self.bin / "systemctl"
        exe.write_text(FAKE_SYSTEMCTL.replace("__PY__", sys.executable), encoding="utf-8")
        exe.chmod(0o755)
        self.state = fx.tmp / "systemd-state.json"
        self.group = fixture_broker_group()
        live = dict(load="loaded", active="active", sub="running", result="success", enabled=True, pid=1111, nrestarts=0, persistent=True)
        failed = dict(load="loaded", active="failed", sub="failed", result="exit-code", enabled=True, pid=0, nrestarts=0, persistent=True)
        self.state.write_text(json.dumps({"calls": [], "journal": [], "units": {"mosquitto.service": live, OTHER_FAILED: failed}}))

    def env(self, **extra: str) -> dict[str, str]:
        env = {
            "AEGIS_L6B_FIXTURE_SYSTEMCTL": str(self.bin / "systemctl"),
            "AEGIS_L6B_FIXTURE_BROKER_GROUP": self.group,
            "FAKE_SYSTEMD_STATE": str(self.state),
            "FAKE_ROOT": str(self.fx.root),
        }
        env.update(extra)
        return env

    def data(self) -> dict:
        return json.loads(self.state.read_text())

    def unit(self, name: str = UNIT) -> dict:
        return self.data()["units"].get(name, {"load": "not-found", "active": "inactive", "sub": "dead", "result": "success"})

    def calls(self, verb: str | None = None) -> list[dict]:
        return [c for c in self.data()["calls"] if verb is None or c["argv"][0] == verb]

    def run_systemctl(self, *args: str) -> subprocess.CompletedProcess[str]:
        env = dict(os.environ, **self.env())
        return subprocess.run([str(self.bin / "systemctl"), *args], text=True, capture_output=True, env=env, check=False)


@pytest.fixture()
def sd(fx: Fx) -> Systemd:
    return Systemd(fx)


def sd_apply(fx: Fx, sd: Systemd) -> subprocess.CompletedProcess[str]:
    res = fx.run(APPLY, **sd.env())
    assert res.returncode == 0, res.stdout + res.stderr
    return res


def sd_rollback(fx: Fx, sd: Systemd, **extra: str) -> subprocess.CompletedProcess[str]:
    return fx.run(ROLLBACK, **sd.env(**extra))


CLEAN_STATE = {"load": "not-found", "active": "inactive", "sub": "dead", "result": "success"}


def state_of(unit: dict) -> dict:
    return {k: unit[k] for k in CLEAN_STATE}


def test_l6b_apply_records_the_exact_ownership_plan_for_all_installed_paths(fx: Fx) -> None:
    applied(fx)
    rows = [l.split("\t") for l in (fx.work / "ownership-plan.tsv").read_text().splitlines()]
    assert rows[0] == ["path", "mode", "owner"]
    assert {r[0]: (r[1], r[2]) for r in rows[1:]} == OWNERSHIP_MODEL
    assert len(rows) - 1 == 8  # directory + six broker files + unit
    for path, (mode, _owner) in OWNERSHIP_MODEL.items():
        assert int(mode, 8) & 0o133 == 0 or path.endswith("mqtt")  # never group/other-writable, no execute on files
        assert int(mode, 8) & 0o022 == 0


def test_l6b_installed_modes_have_no_write_bits_for_group_or_other_and_no_secret_world_read(fx: Fx) -> None:
    applied(fx)
    for path in [fx.mqtt, *fx.mqtt.iterdir(), fx.unit]:
        assert stat.S_IMODE(path.stat().st_mode) & 0o022 == 0, path
    for name in ("passwd", "broker.key"):
        assert stat.S_IMODE((fx.mqtt / name).stat().st_mode) & 0o007 == 0  # secrets are never world-readable


def test_l6b_dropped_privilege_broker_group_can_read_exactly_what_it_needs(fx: Fx) -> None:
    """RED before the fix: passwd/key were 0600, so a broker that dropped to mosquitto (uid 958, gid 958) could not open them."""
    applied(fx)
    for name in BROKER_GROUP_FILES:
        assert stat.S_IMODE((fx.mqtt / name).stat().st_mode) & 0o040, f"{name} is not group-readable"
    assert stat.S_IMODE(fx.mqtt.stat().st_mode) & 0o010, "mqtt dir is not group-traversable"


def test_l6b_apply_puts_the_broker_group_on_exactly_the_group_files(fx: Fx) -> None:
    group = fixture_broker_group()
    res = fx.run(APPLY, AEGIS_L6B_FIXTURE_BROKER_GROUP=group)
    assert res.returncode == 0, res.stdout + res.stderr
    for name in BROKER_GROUP_FILES:
        assert grp.getgrgid((fx.mqtt / name).stat().st_gid).gr_name == group, name
    assert grp.getgrgid(fx.mqtt.stat().st_gid).gr_name == group


def test_l6b_handlers_encode_root_mosquitto_model_without_widening() -> None:
    apply_text, verify_text = APPLY.read_text(), VERIFY.read_text()
    assert "BROKER_GROUP=mosquitto" in apply_text and "BROKER_GROUP=mosquitto" in verify_text
    assert '-o root -g "$group"' in apply_text and '-o root -g "$BROKER_GROUP"' in apply_text
    for script in (APPLY, VERIFY, ROLLBACK):
        text = script.read_text()
        for bad in ("0660", "0666", "0770", "0777", "usermod", "gpasswd", "groupadd", "chgrp -R", "chown -R"):
            assert bad not in text, (script.name, bad)
    # the unit-file, CA and broker certificate stay root:root
    assert re.search(r"install_owned 0644 .*ca\.crt.* root", apply_text) and re.search(r"install_owned 0644 .*\$CERT.* root", apply_text)


# ── mosquitto identity precheck: exists + primary GID equals group GID; supplementary groups are not judged ─────────────


def identity_check(tmp_path: Path, *, group: str = "mosquitto:x:958:", passwd: str = "mosquitto:x:958:958::/var/empty:/usr/bin/nologin",
                   uid_gid: str = "958") -> subprocess.CompletedProcess[str]:
    text = APPLY.read_text()
    func = text[text.index("broker_identity_check() {"):]
    func = func[: func.index("\n}\n") + 3]
    b = tmp_path / "idbin"
    b.mkdir()
    (b / "getent").write_text(f'#!/usr/bin/env bash\ncase "$1" in group) echo "{group}" ;; passwd) echo "{passwd}" ;; esac\n[ "$1 " = "group " ] || true\n'
                              f'case "$1" in group) [ -n "{group}" ] || exit 2 ;; passwd) [ -n "{passwd}" ] || exit 2 ;; esac\n')
    (b / "id").write_text(f'#!/usr/bin/env bash\n[ -n "{uid_gid}" ] && echo "{uid_gid}" || exit 1\n')
    for f in b.iterdir():
        f.chmod(0o755)
    script = f'BROKER_GROUP=mosquitto\nfail() {{ echo "FAIL:$1" >&2; exit 1; }}\n{func}\nbroker_identity_check\n'
    env = dict(os.environ, PATH=f"{b}:{os.environ['PATH']}")
    return subprocess.run(["bash", "-c", script], text=True, capture_output=True, env=env, check=False)


def test_l6b_broker_identity_accepts_the_live_host_facts(tmp_path: Path) -> None:
    assert identity_check(tmp_path).returncode == 0


def test_l6b_broker_identity_does_not_judge_supplementary_groups(tmp_path: Path) -> None:
    # `id -g` reports only the primary gid, so extra supplementary membership cannot change the verdict
    assert identity_check(tmp_path, group="mosquitto:x:958:extra-member").returncode == 0
    assert "id -Gn" not in APPLY.read_text() and "EXTRA_GROUPS" not in APPLY.read_text()


@pytest.mark.parametrize("kwargs,reason", [({"group": ""}, "BROKER_GROUP_MISSING"), ({"passwd": ""}, "BROKER_USER_MISSING"),
                                            ({"uid_gid": "959"}, "BROKER_USER_PRIMARY_GID_MISMATCH")])
def test_l6b_broker_identity_fails_closed(tmp_path: Path, kwargs: dict, reason: str) -> None:
    res = identity_check(tmp_path, **kwargs)
    assert res.returncode == 1 and reason in res.stderr


def test_l6b_apply_never_mutates_accounts_or_groups() -> None:
    for script in (APPLY, VERIFY, ROLLBACK):
        assert not re.search(r"\b(useradd|usermod|groupadd|groupmod|gpasswd|adduser|addgroup|chsh)\b", script.read_text()), script.name


# ── systemd lifecycle (fake systemctl) ───────────────────────────────────────────────────────────────────────────────


def test_l6b_apply_with_dropped_privilege_model_starts_a_running_service(fx: Fx, sd: Systemd) -> None:
    sd_apply(fx, sd)
    assert sd.unit()["active"] == "active" and sd.unit()["sub"] == "running" and sd.unit()["enabled"] is True
    assert ("SERVICE", UNIT) in [tuple(l.split("\t")) for l in (fx.work / "journal.tsv").read_text().splitlines()]
    verbs = [c["argv"][0] for c in sd.calls() if c["argv"][0] != "show"]
    assert verbs == ["daemon-reload", "enable"]  # apply never stops/restarts/resets anything
    assert all(UNIT in c["argv"] or c["argv"][0] in ("daemon-reload", "show") for c in sd.calls())
    assert sd.unit("mosquitto.service")["pid"] == 1111 and sd.unit(OTHER_FAILED)["active"] == "failed"


def incident(fx: Fx, sd: Systemd) -> None:
    """Replay the first live attempt: the broker starts, drops privileges, cannot open passwd (old root:root 0600 model)."""
    sd_apply(fx, sd)
    for name in ("passwd", "broker.key"):
        (fx.mqtt / name).chmod(0o600)
    assert sd.run_systemctl("start", UNIT).returncode == 0
    assert state_of(sd.unit()) == {"load": "loaded", "active": "failed", "sub": "failed", "result": "exit-code"}
    assert any("Unable to open /etc/aegis-idea3/mqtt/passwd" in l for l in sd.data()["journal"])


def test_l6b_old_root_root_0600_model_fails_a_privilege_dropped_broker_and_verify_reports_it(fx: Fx, sd: Systemd) -> None:
    incident(fx, sd)  # A: failed IDEA3 broker state before rollback
    res = fx.run(VERIFY, **sd.env())
    assert res.returncode != 0 and "MATERIAL_MODE_INVALID:passwd" in res.stderr  # the old modes are rejected up front
    for name in ("passwd", "broker.key"):
        (fx.mqtt / name).chmod(0o640)  # modes fixed but the manager still holds the failed state: live sequence
    res = fx.run(VERIFY, **sd.env())
    assert res.returncode != 0 and "IDEA3_SERVICE_NOT_ACTIVE" in res.stderr


def test_l6b_new_group_model_keeps_the_broker_alive_after_a_restart(fx: Fx, sd: Systemd) -> None:
    sd_apply(fx, sd)
    assert sd.run_systemctl("start", UNIT).returncode == 0
    assert sd.unit()["active"] == "active"
    res = fx.run(VERIFY, **sd.env())
    assert res.returncode == 0, res.stdout + res.stderr
    assert "L6B_VERIFY=PASS" in res.stdout


def test_l6b_group_bit_without_the_broker_group_would_still_fail_the_dropped_broker(fx: Fx, sd: Systemd) -> None:
    if sd.group == grp.getgrgid(os.getgid()).gr_name:
        pytest.skip("test user has no second group to distinguish from its primary group")
    sd_apply(fx, sd)
    os.chown(fx.mqtt / "passwd", -1, os.getgid())  # 0640 but the wrong group
    assert sd.run_systemctl("start", UNIT).returncode == 0
    assert sd.unit()["active"] == "failed"


def test_l6b_rollback_clears_only_the_failed_idea3_unit_state(fx: Fx, sd: Systemd) -> None:
    incident(fx, sd)
    res = sd_rollback(fx, sd)
    assert res.returncode == 0, res.stdout + res.stderr
    assert "L6B_ROLLBACK=PASS" in res.stdout
    # final modeled state for the IDEA3 broker (B)
    assert state_of(sd.unit()) == CLEAN_STATE
    assert sd.run_systemctl("show", "-p", "LoadState", "-p", "ActiveState", "-p", "SubState", "-p", "Result", UNIT).stdout.split() == [
        "LoadState=not-found", "ActiveState=inactive", "SubState=dead", "Result=success"]
    assert not fx.unit.exists() and not fx.mqtt.exists()
    # C: the unrelated failed unit and the legacy broker are untouched
    assert state_of(sd.unit(OTHER_FAILED)) == {"load": "loaded", "active": "failed", "sub": "failed", "result": "exit-code"}
    assert sd.unit("mosquitto.service")["active"] == "active" and sd.unit("mosquitto.service")["pid"] == 1111


def test_l6b_rollback_reset_failed_targets_exactly_one_named_unit_after_removal_and_reload(fx: Fx, sd: Systemd) -> None:
    incident(fx, sd)
    n_before = len(sd.calls())
    assert sd_rollback(fx, sd).returncode == 0
    calls = sd.calls()[n_before:]
    resets = [i for i, c in enumerate(calls) if c["argv"][0] == "reset-failed"]
    assert [calls[i]["argv"] for i in resets] == [["reset-failed", UNIT]]  # never bare, never --all, never another unit
    reloads = [i for i, c in enumerate(calls) if c["argv"][0] == "daemon-reload"]
    assert reloads and max(reloads) < resets[0]  # reset-failed is the last lifecycle step, after unit removal + reload
    assert calls[resets[0]]["unit_file"] is False  # the unit file was already removed
    # the failed unit is not active, so no stop; the unit is not enabled in the failed state we replay only if enabled
    assert all(c["argv"][0] in ("show", "is-active", "is-enabled", "stop", "disable", "daemon-reload", "reset-failed") for c in calls)
    for c in calls:
        if c["argv"][0] not in ("show", "daemon-reload"):
            assert c["argv"][-1] == UNIT, c  # only aegis-idea3-mosquitto.service is ever the target
    assert not any(c["argv"][0] in ("stop", "disable") and c["argv"][-1] != UNIT for c in calls)


def test_l6b_rollback_stops_and_disables_a_healthy_service_before_removing_it(fx: Fx, sd: Systemd) -> None:
    sd_apply(fx, sd)
    n_before = len(sd.calls())
    assert sd_rollback(fx, sd).returncode == 0
    order = [c["argv"][0] for c in sd.calls()[n_before:] if c["argv"][0] not in ("show", "is-active", "is-enabled")]
    assert order == ["stop", "disable", "daemon-reload", "reset-failed"]
    stop = next(c for c in sd.calls()[n_before:] if c["argv"][0] == "stop")
    assert stop["unit_file"] is True  # stopped while the unit still existed
    assert state_of(sd.unit()) == CLEAN_STATE


def test_l6b_rollback_second_run_is_idempotent_and_stays_clean(fx: Fx, sd: Systemd) -> None:
    incident(fx, sd)
    assert sd_rollback(fx, sd).returncode == 0  # first rollback
    tree = fx.tree()
    again = sd_rollback(fx, sd)  # D: the unit is now unknown to systemd, reset-failed reports "not loaded"
    assert again.returncode == 0, again.stdout + again.stderr
    assert "L6B_ROLLBACK=PASS" in again.stdout
    assert state_of(sd.unit()) == CLEAN_STATE and fx.tree() == tree
    assert state_of(sd.unit(OTHER_FAILED))["active"] == "failed"


def test_l6b_rollback_fails_loudly_if_failed_state_survives_reset(fx: Fx, sd: Systemd) -> None:
    incident(fx, sd)
    res = sd_rollback(fx, sd, FAKE_SYSTEMD_NOOP_RESET_FAILED="1")
    assert res.returncode != 0 and "IDEA3_SERVICE_RUNTIME_STATE_RESIDUE" in res.stderr


def test_l6b_rollback_without_service_journal_never_touches_systemd_lifecycle(fx: Fx, sd: Systemd) -> None:
    sd_apply(fx, sd)
    lines = [l for l in (fx.work / "journal.tsv").read_text().splitlines() if not l.startswith("SERVICE")]
    (fx.work / "journal.tsv").write_text("\n".join(lines) + "\n")
    n_before = len(sd.calls())
    assert sd_rollback(fx, sd).returncode == 0
    verbs = {c["argv"][0] for c in sd.calls()[n_before:]}
    assert not verbs & {"stop", "disable", "reset-failed"}


def test_l6b_rollback_with_the_service_never_started_is_clean_and_idempotent(fx: Fx, sd: Systemd) -> None:
    sd_apply(fx, sd)
    assert sd_rollback(fx, sd).returncode == 0
    assert sd_rollback(fx, sd).returncode == 0
    assert state_of(sd.unit()) == CLEAN_STATE


def test_l6b_fake_systemctl_models_the_live_failed_metadata_retention_and_bare_reset(fx: Fx, sd: Systemd) -> None:
    """Guards the harness itself: it must reproduce the live residue, so a bare reset-failed would be caught."""
    incident(fx, sd)
    fx.unit.unlink()
    assert sd.run_systemctl("daemon-reload").returncode == 0
    assert state_of(sd.unit()) == {"load": "not-found", "active": "failed", "sub": "failed", "result": "exit-code"}
    assert sd.run_systemctl("reset-failed").returncode == 0  # bare reset would also clear the unrelated unit
    assert sd.unit(OTHER_FAILED)["active"] == "inactive"


def capture_sd(fx: Fx, sd: Systemd, label: str) -> Path:
    evid = fx.tmp / f"evid-{label}"
    env = os.environ.copy()
    env.update(sd.env())
    env.update(PATH=f"{sd.bin}:{os.environ['PATH']}", P4_FS_ROOT=str(fx.root), EVID_DIR=str(evid),
               JOURNAL_SINCE="2026-09-27 00:00:00 UTC", CAPTURE_LABEL=label)
    res = subprocess.run(["bash", str(CAPTURE)], text=True, capture_output=True, check=False, env=env)
    assert res.returncode in (0, 3), res.stdout + res.stderr
    records: dict[str, str] = {}
    for tsv, prefixes in (("host.tsv", ("host.",)), ("services.tsv", ("svc.",))):
        for line in (evid / tsv).read_text().splitlines():
            key, _, value = line.partition("\t")
            if value and value != "UNAVAILABLE" and key.startswith(prefixes) and not key.startswith("host.identity"):
                records[key] = value
    return _load_make_bundle()(fx.tmp / f"bundle-{label}", label, records)


def test_l6b_pre_rb_has_no_service_drift_for_the_idea3_broker_after_the_incident(fx: Fx, sd: Systemd) -> None:
    pre = capture_sd(fx, sd, "pre")
    incident(fx, sd)
    assert sd_rollback(fx, sd).returncode == 0
    rb = capture_sd(fx, sd, "rb")
    res = compare(pre, rb, allow=False)  # E: strict, no allow files
    assert res.returncode == 0, res.stdout + res.stderr
    assert "SERVICE_STATE_DRIFT" not in res.stdout and "SERVICE_RESTART_DRIFT" not in res.stdout
    assert "FINDINGS_NEW_OR_WORSENED_DRIFT=0" in res.stdout and "FINDINGS_APPROVED_CHANGE=0" in res.stdout
    for prop in ("LoadState", "ActiveState", "SubState", "Result"):
        assert f"svc.{UNIT}.{prop}" in (fx.tmp / "evid-rb" / "services.tsv").read_text()


def test_l6b_pre_rb_still_reports_service_drift_when_failed_metadata_is_left_behind(fx: Fx, sd: Systemd) -> None:
    """Negative control: the comparator stays strict. Reproduce the live residue and require the exact drift findings."""
    pre = capture_sd(fx, sd, "pre")
    incident(fx, sd)
    res = sd_rollback(fx, sd, FAKE_SYSTEMD_NOOP_RESET_FAILED="1")
    assert res.returncode != 0  # the rollback itself refuses to claim success
    rb = capture_sd(fx, sd, "rb")
    cmp = compare(pre, rb, allow=False)
    assert cmp.returncode == 1 and "SERVICE_STATE_DRIFT" in cmp.stdout


# ── live probe against real (throwaway) brokers ──────────────────────────────────────────────────────────────────────


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def broker_conf(fx: Fx, port: int, *, acl: Path | None = None, anonymous: bool = False, passwd: Path | None = None) -> Path:
    conf = fx.tmp / f"probe-{port}.conf"
    lines = [
        "per_listener_settings false",
        f"allow_anonymous {'true' if anonymous else 'false'}",
        f"password_file {passwd or fx.mqtt / 'passwd'}",
        f"acl_file {acl or fx.mqtt / 'acl'}",
        "persistence false",
        "retain_available false",
    ]
    for addr in ("127.0.0.1", "127.0.0.2"):
        lines += [
            f"listener {port} {addr}", "protocol mqtt",
            f"cafile {fx.mqtt / 'ca.crt'}", f"certfile {fx.mqtt / 'broker.crt'}", f"keyfile {fx.mqtt / 'broker.key'}",
            "tls_version tlsv1.2", "require_certificate false",
        ]
    conf.write_text("\n".join(lines) + "\n")
    return conf


class Broker:
    def __init__(self, conf: Path, port: int) -> None:
        self.proc = subprocess.Popen(["mosquitto", "-c", str(conf)], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            try:
                for a in ("127.0.0.1", "127.0.0.2"):
                    socket.create_connection((a, port), timeout=0.2).close()
                return
            except OSError:
                time.sleep(0.05)
        self.stop()
        raise RuntimeError("probe broker did not start")

    def stop(self) -> None:
        self.proc.terminate()
        try:
            self.proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait(timeout=3)


PROBE_EXTRA = {"AEGIS_L6B_PROBE_ADDRESSES": "127.0.0.1 127.0.0.2"}


def test_l6b_verify_live_probe_passes_against_a_correct_broker_on_both_listeners(fx: Fx) -> None:
    applied(fx)
    port = free_port()
    broker = Broker(broker_conf(fx, port), port)
    try:
        res = fx.run(VERIFY, AEGIS_L6B_PROBE_PORT=str(port), **PROBE_EXTRA)
    finally:
        broker.stop()
    assert res.returncode == 0, res.stdout + res.stderr
    assert "L6B_LIVE_TLS_AUTH_ACL=PASS" in res.stdout
    assert CORE_PW not in res.stdout + res.stderr and DEV_PW not in res.stdout + res.stderr
    assert "live_tls_auth_acl\tPASS" in (fx.work / "validation-evidence.tsv").read_text()


def test_l6b_verify_live_probe_fails_when_anonymous_access_is_allowed(fx: Fx) -> None:
    applied(fx)
    port = free_port()
    broker = Broker(broker_conf(fx, port, anonymous=True), port)
    try:
        res = fx.run(VERIFY, AEGIS_L6B_PROBE_PORT=str(port), **PROBE_EXTRA)
    finally:
        broker.stop()
    assert res.returncode != 0 and "LIVE_TLS_AUTH_ACL_FAILED" in res.stderr


def test_l6b_verify_live_probe_fails_when_acl_is_too_permissive(fx: Fx) -> None:
    applied(fx)
    loose = fx.tmp / "loose.acl"
    loose.write_text((fx.mqtt / "acl").read_text() + f"topic write aegis/idea3/v1/{DEVICE_ID}/command\n")
    loose.chmod(0o600)
    port = free_port()
    broker = Broker(broker_conf(fx, port, acl=loose), port)
    try:
        res = fx.run(VERIFY, AEGIS_L6B_PROBE_PORT=str(port), **PROBE_EXTRA)
    finally:
        broker.stop()
    assert res.returncode != 0 and "LIVE_TLS_AUTH_ACL_FAILED" in res.stderr


def test_l6b_verify_live_probe_fails_with_wrong_passwords(fx: Fx) -> None:
    applied(fx)
    (fx.inp / "core.pass").write_text("some-other-core-password-value-0000\n")
    port = free_port()
    broker = Broker(broker_conf(fx, port), port)
    try:
        res = fx.run(VERIFY, AEGIS_L6B_PROBE_PORT=str(port), **PROBE_EXTRA)
    finally:
        broker.stop()
    assert res.returncode != 0 and "LIVE_TLS_AUTH_ACL_FAILED" in res.stderr


def test_l6b_verify_live_probe_fails_when_no_broker_is_running(fx: Fx) -> None:
    applied(fx)
    res = fx.run(VERIFY, AEGIS_L6B_PROBE_PORT=str(free_port()), **PROBE_EXTRA)
    assert res.returncode != 0 and "LIVE_TLS_AUTH_ACL_FAILED" in res.stderr


def test_l6b_validate_live_refuses_plaintext_port_and_needs_addresses() -> None:
    base = [sys.executable, str(VALIDATOR), "validate-live", "--ca-file", "/x", "--cert-file", "/x",
            "--core-password-file", "/x", "--device-password-file", "/x", "--device-id", DEVICE_ID]
    res = subprocess.run(base + ["--address", "127.0.0.1", "--port", "1883"], text=True, capture_output=True)
    assert res.returncode == 2 and "1883" in res.stderr
    res = subprocess.run(base, text=True, capture_output=True)
    assert res.returncode != 0


def test_l6b_validate_live_never_starts_a_broker() -> None:
    text = VALIDATOR.read_text()
    live = text[text.index("def validate_live_broker"):text.index("def main()")]
    assert "Popen" not in live and "mosquitto" not in live.replace("aegis-pr11", "")
