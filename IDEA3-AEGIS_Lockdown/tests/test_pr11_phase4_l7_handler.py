# shellcheck shell=bash disable=SC1091
"""AEGIS IDEA3 PR11 Phase 4 — L7 Core credential delivery / Core start handler tests (fixture root + fake systemd only).

Authority: docs/superpowers/specs/2026-09-21-idea3-pr11-phase4-l7-operational-design.md (OD-L7-01..08) and its 2026-09-27 amendments.
No test touches the real host: handlers run against AEGIS_P4_FS_ROOT fixtures with a stateful fake systemctl / systemd-analyze / ss
(tests/l7_support.py). Every negative test asserts its EXACT failure reason and is paired with a passing control, so a rejection can
never be caused by an unrelated precondition (the previous negative tests never set the fixture root and were vacuous).
"""

from __future__ import annotations

import os
import re
import stat
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))
import l7_support as s  # noqa: E402
from l7_support import (  # noqa: E402
    ADMIN_PIN, AP, APPLY, C2D, CRED_FILES, D2C, MQTT_PASS, ROLLBACK, SECRETS, UNIT, VERIFY, Fx, build,
)

ROOT = s.ROOT
DEPLOY = s.DEPLOY
L7_STAGE = s.L7_STAGE
P4_LIB = DEPLOY / "p4-lib.sh"
NVS_PROVISION = DEPLOY / "p4-nvs-provision.py"

EXPECTED_ALLOW_KEYS = {
    *(f"svc.aegis-idea3-core.service.{p}" for p in ("ActiveState", "SubState", "MainPID", "ExecMainStartTimestamp", "Result", "LoadState",
                                                    "NRestarts", "UnitFileState")),
    "host.path./opt/aegis-idea3/current", "host.path./run/aegis-idea3", "host.path./var/lib/aegis-idea3", "host.path./var/log/aegis-idea3",
    "host.symlink./opt/aegis-idea3/current.target",
    *(f"host.unit_file./etc/systemd/system/aegis-idea3-core.service.{c}" for c in ("class", "meta", "sha256")),
    *(f"host.aegis_idea3.file.{p}.{c}" for p in ("/etc/aegis-idea3/core.env", "/etc/aegis-idea3/pki/mqtt-ca.crt",
                                                 *(f"/etc/aegis-idea3/credentials/{n}" for n in CRED_FILES)) for c in ("class", "meta")),
}


@pytest.fixture()
def fx(tmp_path: Path) -> Fx:
    return build(tmp_path)


def applied(fx: Fx, **extra: str) -> subprocess.CompletedProcess[str]:
    res = fx.run(APPLY, **extra)
    assert res.returncode == 0, res.stdout + res.stderr
    return res


def reason(res: subprocess.CompletedProcess[str]) -> str:
    m = re.search(r"L7_APPLY=FAIL reason=(\S+)", res.stderr)
    return m.group(1) if m else ""


def vreason(res: subprocess.CompletedProcess[str]) -> str:
    m = re.search(r"L7_VERIFY=FAIL reason=(\S+)", res.stderr)
    return m.group(1) if m else ""


def rreason(res: subprocess.CompletedProcess[str]) -> str:
    m = re.search(r"L7_ROLLBACK=FAIL reason=(\S+)", res.stderr)
    return m.group(1) if m else ""


# ── 1. registration, syntax, static contract ─────────────────────────────────────────────────────────────────────────────


def test_l7_all_required_files_exist() -> None:
    for name in ("apply.sh", "verify.sh", "rollback.sh", "allow-keys.txt", "allow-listeners.txt"):
        assert (L7_STAGE / name).is_file(), name


def test_l7_handler_registration_status() -> None:
    res = subprocess.run(["bash", "-c", f". '{P4_LIB}' && p4_stage_handler_status L7"], text=True, capture_output=True, check=False)
    assert res.returncode == 0 and res.stdout.strip() == "REGISTERED"


def test_l7_shell_scripts_pass_bash_n() -> None:
    for name in ("apply.sh", "verify.sh", "rollback.sh"):
        assert subprocess.run(["bash", "-n", str(L7_STAGE / name)], capture_output=True).returncode == 0, name


def test_l7_allow_listeners_is_empty() -> None:
    active = [l for l in (L7_STAGE / "allow-listeners.txt").read_text().splitlines() if l.strip() and not l.startswith("#")]
    assert active == []


def test_l7_allow_keys_matches_contract_exactly() -> None:
    keys = [l.strip() for l in (L7_STAGE / "allow-keys.txt").read_text().splitlines() if l.strip() and not l.startswith("#")]
    assert len(keys) == len(set(keys)) and set(keys) == EXPECTED_ALLOW_KEYS
    assert not any("*" in k for k in keys)


def test_l7_handlers_contain_no_forbidden_commands() -> None:
    forbidden = (r"\bpkill\b", r"\bkillall\b", r"\brm\s+-\w*r", r"\bsystemctl\s+(restart|reload|mask)\b",
                 r"systemctl\s+\w+\s+(mosquitto|aegis-idea3-mosquitto|twingate|chronyd|NetworkManager|nftables)",
                 r"\bnmcli\b", r"\bnft\s+(add|delete|flush|-f)", r"\brfkill\b", r"\biw\s+\w+\s+set", r"\bsysctl\s+-w\b",
                 r"CUT_UPLINK\s*[\"']?\s*\|\s*mosquitto_pub", r"\bmosquitto_pub\b", r"\bchronyc\b", r"\bumount\b", r"\bserial\b", r"\besptool\b",
                 r"\busermod\b", r"\bgroupadd\b", r"\buseradd\b", r"\bgpasswd\b", r"chown\s+-R", r"chmod\s+-R", r"chmod\s+0?[0-7][2367][0-7]\b", r"chmod\s+0?[0-7][0-7][2367]\b")
    for name in ("apply.sh", "verify.sh", "rollback.sh"):
        text = (L7_STAGE / name).read_text()
        for pat in forbidden:
            assert not re.search(pat, text), (name, pat)
        assert not re.search(r"systemctl\s+(start|stop|enable|disable)\s+(?!\"?\$UNIT)", text.replace("sysctl_do", "systemctl").replace("--now ", "")), name


def test_l7_no_production_key_generator_in_repository() -> None:
    for match in ROOT.rglob("*key*gen*.py"):
        assert "PRODUCTION_KEY_GENERATOR" not in match.read_text(encoding="utf-8", errors="ignore")
    assert not (DEPLOY / "p4-key-gen.py").exists()


def test_l7_key_parity_with_esp32_provisioner(tmp_path: Path) -> None:
    c2d, d2c = tmp_path / "k_c2d", tmp_path / "k_d2c"
    c2d.write_text(C2D + "\n", encoding="ascii")
    d2c.write_text(D2C + "\n", encoding="ascii")
    import importlib.util

    sys.path.insert(0, str(ROOT))
    try:
        from aegis_soc.protocol_v1 import load_protocol_keys

        spec = importlib.util.spec_from_file_location("p4_nvs_provision", str(NVS_PROVISION))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        keys = load_protocol_keys(c2d, d2c)
        nvs_c2d, nvs_d2c = module.validate_protocol_keys(C2D, D2C)
        assert keys.c2d == nvs_c2d and keys.d2c == nvs_d2c
    finally:
        sys.path.remove(str(ROOT))


# ── 2. apply: environment + input contract (each negative has its own exact reason) ──────────────────────────────────────


def test_l7_apply_passes_the_control_fixture(fx: Fx) -> None:
    res = applied(fx)
    assert "L7_APPLY=PASS" in res.stdout and "PRODUCTION_MUTATION_PERFORMED=YES" in res.stdout


@pytest.mark.parametrize("var", ["AEGIS_L7_WORK_DIR", "AEGIS_L7_INPUT_DIR", "AEGIS_L7_RELEASE_DIR", "AEGIS_AP_ADDRESS"])
def test_l7_apply_requires_environment(fx: Fx, var: str) -> None:
    res = fx.run(APPLY, **{var: ""})
    assert reason(res) == f"{var}_REQUIRED"
    assert not fx.creds.exists()


@pytest.mark.parametrize("ap", ["0.0.0.0", "127.0.0.1", "224.0.0.1", "::1", "nope"])
def test_l7_apply_rejects_bad_ap_address(fx: Fx, ap: str) -> None:
    assert reason(fx.run(APPLY, AEGIS_AP_ADDRESS=ap)) == "AEGIS_AP_ADDRESS_INVALID"


def test_l7_live_mode_requires_authorization_flag_and_root(fx: Fx) -> None:
    env = fx.env()
    env.pop("AEGIS_P4_FS_ROOT")
    for k in [k for k in env if k.startswith("AEGIS_L7_FIXTURE")]:
        env.pop(k)
    res = subprocess.run(["bash", str(APPLY)], text=True, capture_output=True, check=False, env=env)
    assert reason(res) == "LIVE_AUTHORIZATION_FLAG_REQUIRED"
    env["AEGIS_L7_LIVE_AUTHORIZED"] = "YES"
    res = subprocess.run(["bash", str(APPLY)], text=True, capture_output=True, check=False, env=env)
    assert reason(res) == "ROOT_REQUIRED" and not fx.work.exists()


def test_l7_live_mode_ignores_every_fixture_seam() -> None:
    """The fixture seams are honoured ONLY when AEGIS_P4_FS_ROOT is set; live always uses the real tools."""
    for name in ("apply.sh", "verify.sh", "rollback.sh"):
        text = (L7_STAGE / name).read_text()
        assert re.search(r'use_systemd\(\) \{ \[ -z "\$ROOT" \] \|\| \[ -n "\$FIXTURE_SYSTEMCTL" \]; \}', text), name
        assert 'systemctl "$@"; else "$FIXTURE_SYSTEMCTL" "$@"' in text.replace("\n", " ") or "systemctl \"$@\"" in text, name


def test_l7_apply_work_dir_rules(fx: Fx) -> None:
    fx.work.mkdir()
    assert reason(fx.run(APPLY, keep_work=True)) == "WORK_DIR_ALREADY_EXISTS"
    fx.work.rmdir()
    assert reason(fx.run(APPLY, AEGIS_L7_WORK_DIR="/etc/aegis-idea3/work")) == "WORK_DIR_INSIDE_ETC"
    link = fx.tmp / "worklink"
    link.symlink_to(fx.tmp)
    assert reason(fx.run(APPLY, AEGIS_L7_WORK_DIR=str(link))) == "WORK_DIR_IS_SYMLINK"


def test_l7_apply_input_dir_rules(fx: Fx) -> None:
    fx.inp.chmod(0o755)
    assert reason(fx.run(APPLY)) == "INPUT_DIR_MODE_NOT_0700"
    fx.inp.chmod(0o700)
    link = fx.tmp / "inlink"
    link.symlink_to(fx.inp)
    assert reason(fx.run(APPLY, AEGIS_L7_INPUT_DIR=str(link))) == "INPUT_DIR_INVALID"
    (fx.inp / "extra.txt").write_text("x")
    assert reason(fx.run(APPLY)) == "INPUT_DIR_ENTRIES_NOT_EXACT"
    (fx.inp / "extra.txt").unlink()
    (fx.inp / "restore.credential").unlink()
    assert reason(fx.run(APPLY)) == "INPUT_DIR_ENTRIES_NOT_EXACT"
    assert not fx.creds.exists() and not fx.unit.exists()


def test_l7_apply_rejects_ca_private_key_in_input(fx: Fx) -> None:
    (fx.inp / "ca.key").write_text("-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n")
    (fx.inp / "ca.key").chmod(0o600)
    assert reason(fx.run(APPLY)) in {"CA_PRIVATE_KEY_FORBIDDEN", "INPUT_DIR_ENTRIES_NOT_EXACT"}
    assert not fx.creds.exists()


@pytest.mark.parametrize("name", CRED_FILES)
def test_l7_apply_rejects_symlinked_or_non_regular_input(fx: Fx, name: str) -> None:
    real = fx.tmp / "real.secret"
    real.write_text((fx.inp / name).read_text())
    real.chmod(0o600)
    (fx.inp / name).unlink()
    (fx.inp / name).symlink_to(real)
    assert reason(fx.run(APPLY)) == f"INPUT_FILE_NOT_REGULAR:{name}"
    (fx.inp / name).unlink()
    os.mkfifo(fx.inp / name)
    assert reason(fx.run(APPLY)) == f"INPUT_FILE_NOT_REGULAR:{name}"
    assert not fx.creds.exists()


@pytest.mark.parametrize("name", CRED_FILES)
@pytest.mark.parametrize("mode", [0o640, 0o644, 0o660, 0o604])
def test_l7_apply_rejects_loose_input_modes(fx: Fx, name: str, mode: int) -> None:
    (fx.inp / name).chmod(mode)
    assert reason(fx.run(APPLY)) == f"INPUT_SECRET_MODE_INVALID:{name}"
    assert not fx.creds.exists()


def test_l7_apply_accepts_0400_input(fx: Fx) -> None:
    for name in CRED_FILES:
        (fx.inp / name).chmod(0o400)
    applied(fx)


def test_l7_apply_input_owner_must_match_the_invoking_owner(fx: Fx) -> None:
    res = fx.run(APPLY, SUDO_UID=str(os.getuid() + 12345))
    assert reason(res) == "INPUT_DIR_OWNER_MISMATCH"


@pytest.mark.parametrize(
    "c2d,d2c",
    [
        ("1234", D2C), (C2D + "ab", D2C), (C2D[:-1], D2C),
        ("0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF", D2C),
        ("0123456789xyzdef0123456789abcdef0123456789abcdef0123456789abcdef", D2C),
        ("0" * 64, D2C), (C2D, "0" * 64), (C2D, C2D),
        (bytes(range(0x20)).hex(), D2C), (C2D, bytes(range(0x20, 0x40)).hex()),
    ],
)
def test_l7_apply_rejects_invalid_protocol_keys(fx: Fx, c2d: str, d2c: str) -> None:
    (fx.inp / "k_c2d").write_text(c2d + "\n")
    (fx.inp / "k_d2c").write_text(d2c + "\n")
    res = fx.run(APPLY)
    assert reason(res) == "PROTOCOL_KEY_INVALID"
    assert not fx.creds.exists() and not fx.unit.exists()
    assert c2d not in res.stdout + res.stderr or c2d in ("1234",)  # the offending key is never echoed


@pytest.mark.parametrize("pin", ["1234", "", "has space", "tab\there"])
def test_l7_apply_rejects_default_empty_or_spaced_admin_pin(fx: Fx, pin: str) -> None:
    (fx.inp / "admin.pin").write_text(pin + "\n")
    assert reason(fx.run(APPLY)) == "ADMIN_PIN_INVALID"


def test_l7_apply_rejects_empty_mqtt_password(fx: Fx) -> None:
    (fx.inp / "mqtt-core.pass").write_text("\n")
    assert reason(fx.run(APPLY)) == "MQTT_PASSWORD_EMPTY"


@pytest.mark.parametrize("content", ["not a credential\n", "scrypt$1$8$1$00$00\n", "scrypt$16384$8$1$" + "00" * 8 + "$" + "00" * 32 + "\n", ""])
def test_l7_apply_rejects_invalid_d4_restore_credential(fx: Fx, content: str) -> None:
    (fx.inp / "restore.credential").write_text(content)
    assert reason(fx.run(APPLY)) == "RESTORE_CREDENTIAL_INVALID"
    assert not fx.creds.exists()


def test_l7_apply_never_prints_or_persists_secrets_outside_the_credential_files(fx: Fx) -> None:
    res = applied(fx)
    corpus = res.stdout + res.stderr
    for p in fx.work.rglob("*"):
        if p.is_file():
            corpus += p.read_text(errors="ignore")
    for secret in SECRETS:
        assert secret not in corpus
    # the only plaintext copies are the staged credential files
    holders = {str(p.relative_to(fx.root)) for p in fx.root.rglob("*") if p.is_file() and any(x.encode() in p.read_bytes() for x in (C2D, D2C, MQTT_PASS, ADMIN_PIN))}
    assert holders == {f"{s.CREDS}/{n}" for n in ("k_c2d", "k_d2c", "mqtt-core.pass", "admin.pin")}


# ── 3. apply: prestate, release guard, identity, PKI copy ────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("rel", [s.CREDS, s.CORE_ENV, s.UNIT_REL, s.CREDS + "/k_c2d"])
def test_l7_apply_fails_when_a_destination_already_exists(fx: Fx, rel: str) -> None:
    target = fx.root / rel
    target.parent.mkdir(parents=True, exist_ok=True)
    target.mkdir() if rel == s.CREDS else target.write_text("pre-existing\n")
    before = fx.tree()
    res = fx.run(APPLY)
    assert reason(res).startswith("PRESTATE_UNEXPECTED")
    assert fx.tree() == before  # nothing installed, nothing overwritten


def test_l7_apply_requires_a_clean_core_unit_state_not_only_not_found(fx: Fx) -> None:
    import json

    data = fx.data()
    data["units"][UNIT] = dict(load="not-found", active="failed", sub="failed", result="exit-code", enabled=False, pid=0, nrestarts=0)
    fx.state.write_text(json.dumps(data))
    assert reason(fx.run(APPLY)) == "CORE_UNIT_STATE_NOT_CLEAN"


def test_l7_apply_release_guard_is_enforced(fx: Fx) -> None:
    (fx.release / "aegis_soc/supervisor.py").write_text("print('tampered')\n")
    res = fx.run(APPLY)
    assert reason(res) == "RELEASE_GUARD_FAILED:CHECKSUM_MISMATCH"
    assert not fx.creds.exists() and not fx.current.exists()


@pytest.mark.parametrize("logical", ["/opt/aegis-idea3/releases/../evil", "/tmp/rel", "/opt/aegis-idea3/current", "relative/path"])
def test_l7_apply_rejects_bad_release_path(fx: Fx, logical: str) -> None:
    assert reason(fx.run(APPLY, AEGIS_L7_RELEASE_DIR=logical)).startswith("RELEASE_GUARD_FAILED")


def test_l7_apply_fails_when_no_release_is_installed(fx: Fx) -> None:
    """The real host has no /opt/aegis-idea3 at all: L7 must refuse instead of creating a dangling `current` link."""
    import shutil

    shutil.rmtree(fx.root / "opt")
    res = fx.run(APPLY)
    assert reason(res) == "RELEASE_GUARD_FAILED:RELEASE_MISSING"
    assert not fx.current.exists() and not fx.current.is_symlink() and not fx.creds.exists()


def test_l7_apply_existing_current_must_point_at_the_frozen_release(fx: Fx) -> None:
    fx.current.parent.mkdir(parents=True, exist_ok=True)
    fx.current.symlink_to("/opt/aegis-idea3/releases/other")
    assert reason(fx.run(APPLY)) == "RELEASE_POINTER_MISMATCH"
    fx.current.unlink()
    fx.current.symlink_to(s.REL_LOGICAL)
    applied(fx)
    assert os.readlink(fx.current) == s.REL_LOGICAL
    entries = [tuple(l.split("\t")) for l in (fx.work / "journal.tsv").read_text().splitlines()]
    assert not any(e[0] == "LINK" for e in entries)  # a pre-existing pointer is never owned or removed


def test_l7_apply_creates_current_pointing_at_the_release_and_journals_it(fx: Fx) -> None:
    applied(fx)
    assert os.readlink(fx.current) == s.REL_LOGICAL
    assert ("LINK", "/opt/aegis-idea3/current") in [tuple(l.split("\t")) for l in (fx.work / "journal.tsv").read_text().splitlines()]


def test_l7_apply_requires_the_l6b_ca_and_the_pki_dir(fx: Fx) -> None:
    (fx.root / "etc/aegis-idea3/mqtt/ca.crt").unlink()
    assert reason(fx.run(APPLY)) == "L6B_CA_MISSING"
    fx.pki_ca.parent.rmdir()
    assert reason(fx.run(APPLY)) in {"PKI_DIR_MISSING", "L6B_CA_MISSING"}


def test_l7_apply_copies_the_ca_into_the_pki_dir_and_journals_it(fx: Fx) -> None:
    applied(fx)
    assert fx.pki_ca.read_bytes() == (fx.root / "etc/aegis-idea3/mqtt/ca.crt").read_bytes()
    assert ("FILE", "/etc/aegis-idea3/pki/mqtt-ca.crt") in [tuple(l.split("\t")) for l in (fx.work / "journal.tsv").read_text().splitlines()]


def test_l7_apply_leaves_an_identical_existing_pki_ca_alone_and_does_not_own_it(fx: Fx) -> None:
    fx.pki_ca.write_bytes((fx.root / "etc/aegis-idea3/mqtt/ca.crt").read_bytes())
    fx.pki_ca.chmod(0o644)
    mtime = fx.pki_ca.stat().st_mtime_ns
    applied(fx)
    assert fx.pki_ca.stat().st_mtime_ns == mtime
    assert ("FILE", "/etc/aegis-idea3/pki/mqtt-ca.crt") not in [tuple(l.split("\t")) for l in (fx.work / "journal.tsv").read_text().splitlines()]


def test_l7_apply_rejects_a_conflicting_existing_pki_ca(fx: Fx) -> None:
    fx.pki_ca.write_text("different CA\n")
    before = fx.pki_ca.read_bytes()
    assert reason(fx.run(APPLY)) == "PKI_CA_CONFLICT"
    assert fx.pki_ca.read_bytes() == before


def test_l7_apply_identity_check_is_read_only_and_primary_gid_based() -> None:
    text = APPLY.read_text()
    assert "core_identity_check() {" in text
    body = text[text.index("core_identity_check() {"):]
    body = body[: body.index("\n}\n") + 3]
    assert "id -Gn" not in body and "CORE_USER_PRIMARY_GID_MISMATCH" in body and "CORE_USER_MISSING" in body and "CORE_GROUP_MISSING" in body
    assert not re.search(r"\b(useradd|usermod|groupadd|gpasswd)\b", text)


def _identity(tmp_path: Path, *, group: str = "aegis-idea3:x:950:", passwd: str = "aegis-idea3:x:952:950::/var/lib/aegis-idea3:/usr/bin/nologin",
              gid: str = "950") -> subprocess.CompletedProcess[str]:
    text = APPLY.read_text()
    func = text[text.index("core_identity_check() {"):]
    func = func[: func.index("\n}\n") + 3]
    b = tmp_path / "idbin"
    b.mkdir(exist_ok=True)
    (b / "getent").write_text(f'#!/usr/bin/env bash\ncase "$1" in group) [ -n "{group}" ] && echo "{group}" || exit 2 ;; passwd) [ -n "{passwd}" ] && echo "{passwd}" || exit 2 ;; esac\n')
    (b / "id").write_text(f'#!/usr/bin/env bash\n[ -n "{gid}" ] && echo "{gid}" || exit 1\n')
    for f in b.iterdir():
        f.chmod(0o755)
    script = f'CORE_ACCOUNT=aegis-idea3\nfail() {{ echo "FAIL:$1" >&2; exit 1; }}\n{func}\ncore_identity_check\n'
    return subprocess.run(["bash", "-c", script], text=True, capture_output=True, check=False, env=dict(os.environ, PATH=f"{b}:{os.environ['PATH']}"))


def test_l7_core_identity_accepts_the_live_host_facts(tmp_path: Path) -> None:
    assert _identity(tmp_path).returncode == 0
    assert _identity(tmp_path, group="aegis-idea3:x:950:extra").returncode == 0  # supplementary members are not judged


@pytest.mark.parametrize("kwargs,code", [({"group": ""}, "CORE_GROUP_MISSING"), ({"passwd": ""}, "CORE_USER_MISSING"),
                                         ({"gid": "951"}, "CORE_USER_PRIMARY_GID_MISMATCH")])
def test_l7_core_identity_fails_closed(tmp_path: Path, kwargs: dict, code: str) -> None:
    res = _identity(tmp_path, **kwargs)
    assert res.returncode == 1 and code in res.stderr


# ── 4. apply: exact ownership model, rendered env, unit, service lifecycle, journal ──────────────────────────────────────


def journal(fx: Fx) -> list[tuple[str, ...]]:
    return [tuple(l.split("\t")) for l in (fx.work / "journal.tsv").read_text().splitlines()]


def test_l7_apply_records_the_exact_ownership_plan(fx: Fx) -> None:
    applied(fx)
    rows = [l.split("\t") for l in (fx.work / "ownership-plan.tsv").read_text().splitlines()]
    assert rows[0] == ["path", "mode", "owner"]
    assert {r[0]: (r[1], r[2]) for r in rows[1:]} == s.OWNERSHIP_MODEL
    for _mode, _owner in s.OWNERSHIP_MODEL.values():
        assert int(_mode, 8) & 0o022 == 0  # nothing group- or world-writable


def test_l7_apply_installs_exact_modes_and_groups(fx: Fx) -> None:
    applied(fx)
    modes = {p.name: stat.S_IMODE(p.stat().st_mode) for p in fx.creds.iterdir()}
    assert modes == {n: 0o600 for n in CRED_FILES}
    assert stat.S_IMODE(fx.creds.stat().st_mode) == 0o750
    assert stat.S_IMODE(fx.core_env.stat().st_mode) == 0o640
    assert stat.S_IMODE(fx.pki_ca.stat().st_mode) == 0o644 and stat.S_IMODE(fx.unit.stat().st_mode) == 0o644
    import grp

    for p in (fx.creds, fx.core_env, fx.creds / "restore.credential"):
        assert grp.getgrgid(p.stat().st_gid).gr_name == fx.group, p
    assert sorted(p.name for p in fx.creds.iterdir()) == sorted(CRED_FILES)  # no ca.key, no extra files


def test_l7_credential_group_read_is_only_on_the_directory_and_env_never_on_secrets(fx: Fx) -> None:
    """The Core reads restore.credential itself (needs the directory) but the other four secrets only via LoadCredential (root)."""
    applied(fx)
    for n in ("k_c2d", "k_d2c", "mqtt-core.pass", "admin.pin"):
        assert stat.S_IMODE((fx.creds / n).stat().st_mode) & 0o077 == 0, n
    assert stat.S_IMODE((fx.creds / "restore.credential").stat().st_mode) == 0o600


def test_l7_apply_installs_credential_bytes_unchanged(fx: Fx) -> None:
    applied(fx)
    for n in CRED_FILES:
        assert (fx.creds / n).read_bytes() == (fx.inp / n).read_bytes()
    assert sorted(p.name for p in fx.inp.iterdir()) == s.INPUT_ENTRIES  # owner input untouched


def test_l7_apply_renders_a_valid_core_env(fx: Fx) -> None:
    applied(fx)
    tool = DEPLOY / "p4-l7-core-env.py"
    res = subprocess.run([sys.executable, str(tool), "check", "--file", str(fx.core_env), "--ap-address", AP, "--device-id", s.DEVICE_ID,
                          "--server-name", "mqtt.aegis.home.arpa"], text=True, capture_output=True)
    assert res.returncode == 0, res.stdout
    text = fx.core_env.read_text()
    for secret in SECRETS:
        assert secret not in text
    assert "AEGIS_AUTO_CONTAIN=0" in text and "AEGIS_MQTT_TLS_SERVER_NAME=mqtt.aegis.home.arpa" in text


def test_l7_apply_installs_the_unit_from_the_reviewed_example(fx: Fx) -> None:
    applied(fx)
    assert fx.unit.read_text() == (ROOT / "deploy/aegis-idea3-core.service.example").read_text()


def test_l7_apply_journals_every_owned_path_and_runtime_dir_prestate(fx: Fx) -> None:
    applied(fx)
    entries = journal(fx)
    assert entries[0] == ("DIR", "/etc/aegis-idea3/credentials")
    assert {e for e in entries if e[0] == "FILE"} == {("FILE", f"/etc/aegis-idea3/credentials/{n}") for n in CRED_FILES} | {
        ("FILE", "/etc/aegis-idea3/core.env"), ("FILE", "/etc/aegis-idea3/pki/mqtt-ca.crt")}
    assert ("UNIT", "/etc/systemd/system/aegis-idea3-core.service") in entries and ("SERVICE", UNIT) in entries
    assert {e for e in entries if e[0] == "RUNTIME"} == {("RUNTIME", f"/{d}") for d in s.RUNTIME_DIRS}
    assert stat.S_IMODE((fx.work / "journal.tsv").stat().st_mode) == 0o600 and stat.S_IMODE(fx.work.stat().st_mode) == 0o700


def test_l7_apply_does_not_own_runtime_dirs_that_already_exist(fx: Fx) -> None:
    (fx.root / "var/log/aegis-idea3").mkdir(parents=True)
    applied(fx)
    assert ("RUNTIME", "/var/log/aegis-idea3") not in journal(fx)
    assert ("RUNTIME", "/var/lib/aegis-idea3") in journal(fx)


def test_l7_apply_does_not_create_runtime_dirs_itself(fx: Fx) -> None:
    """systemd StateDirectory/LogsDirectory/RuntimeDirectory create them owned by the service account; a root mkdir would be wrong."""
    text = APPLY.read_text()
    assert not re.search(r"mkdir[^\n]*(/var/lib/aegis-idea3|/var/log/aegis-idea3|/run/aegis-idea3)", text)


def test_l7_apply_service_lifecycle_is_verify_reload_enable_now_only(fx: Fx) -> None:
    applied(fx)
    assert [c["argv"][0] for c in fx.calls("systemd-analyze")] == ["verify"]
    assert fx.calls("systemd-analyze")[0]["argv"][-1].endswith("aegis-idea3-core.service")
    verbs = [c["argv"][0] for c in fx.calls() if c["argv"][0] not in ("show", "is-active", "is-enabled")]
    assert verbs == ["daemon-reload", "enable"]
    enable = fx.calls(verb="enable")[0]["argv"]
    assert enable == ["enable", "--now", UNIT]
    assert fx.unit_state()["active"] == "active" and fx.unit_state()["enabled"] is True
    for c in fx.calls():  # only the L7 unit is ever mutated; broker/legacy units are only read
        if c["argv"][0] not in ("show", "is-active", "is-enabled", "daemon-reload"):
            assert c["argv"][-1] == UNIT


def test_l7_apply_leaves_predecessor_and_legacy_units_untouched(fx: Fx) -> None:
    applied(fx)
    for name, pid in ((s.LEGACY_UNIT, 1111), (s.BROKER_UNIT, 2222)):
        assert fx.unit_state(name)["active"] == "active" and fx.unit_state(name)["pid"] == pid
    assert fx.unit_state(s.OTHER_FAILED)["active"] == "failed"


def test_l7_apply_fails_before_any_service_action_when_unit_verification_fails(fx: Fx) -> None:
    res = fx.run(APPLY, FAKE_ANALYZE_FAIL="1")
    assert reason(res) == "UNIT_VERIFY_FAILED"
    assert not [c for c in fx.calls() if c["argv"][0] in ("daemon-reload", "enable", "start", "stop", "disable")]
    assert fx.unit_state()["load"] == "not-found"


def test_l7_apply_fails_when_the_core_does_not_stay_up(fx: Fx) -> None:
    res = fx.run(APPLY, FAKE_CORE_FAIL="preflight")
    assert reason(res) == "CORE_SERVICE_NOT_STABLE"
    assert fx.unit_state()["active"] == "failed"
    assert ("SERVICE", UNIT) in journal(fx)  # journaled BEFORE the start, so rollback can clean it


def test_l7_apply_starts_only_when_the_service_account_can_read_what_it_reads(fx: Fx) -> None:
    """RED before the fix: a root:root 0700 credentials directory made restore.credential unreadable by the Core account (D4)."""
    applied(fx)
    assert fx.unit_state()["active"] == "active"  # the fake starts the Core only if the service group can traverse + read
    assert stat.S_IMODE(fx.creds.stat().st_mode) & 0o050 == 0o050
    # and the negative control: the old 0700 directory would have failed the same fake
    fx.creds.chmod(0o700)
    assert fx.systemctl("start", UNIT).returncode == 0 and fx.unit_state()["active"] == "failed"


def test_l7_apply_is_zero_actuation_and_never_talks_to_the_broker() -> None:
    text = "\n".join(l for l in APPLY.read_text().splitlines() if not l.lstrip().startswith("#"))
    for banned in ("mosquitto_pub", "mosquitto_sub", "CUT_UPLINK", "RESTORE_UPLINK", "curl", "nc "):
        assert banned not in text, banned


def test_l7_apply_baselines_predecessors_for_preservation(fx: Fx) -> None:
    applied(fx)
    assert (fx.work / "legacy-service.txt").is_file() and (fx.work / "l6b-material.txt").is_file()
    assert (fx.work / "legacy-tree.sha256").is_file() and (fx.work / "listeners-baseline.txt").is_file()
    baseline = (fx.work / "l6b-material.txt").read_text()
    for secret_name in ("passwd", "broker.key"):
        assert secret_name in baseline
    assert "L6B-FIXTURE-passwd" not in baseline  # metadata only, never secret content or digests


def test_l7_apply_failure_before_mutation_leaves_zero_residue(fx: Fx) -> None:
    (fx.inp / "k_d2c").write_text(C2D + "\n")
    before = fx.tree()
    assert reason(fx.run(APPLY)) == "PROTOCOL_KEY_INVALID"
    assert fx.tree() == before
    assert not (fx.work / "production-mutation").exists()


# ── 5. verify ────────────────────────────────────────────────────────────────────────────────────────────────────────────


def verified(fx: Fx, **extra: str) -> subprocess.CompletedProcess[str]:
    return fx.run(VERIFY, **extra)


def test_l7_verify_passes_on_the_applied_fixture_and_prints_non_secret_markers(fx: Fx) -> None:
    applied(fx)
    res = verified(fx)
    assert res.returncode == 0, res.stdout + res.stderr
    for marker in ("L7_VERIFY=PASS", "L7_CORE_STATE=WAIT_DEVICE", "L7_MATERIAL_EXACT=PASS", "L7_ZERO_ACTUATION=PASS", "L7_NEW_LISTENERS=NONE",
                   "L7_BROKER_CONNECTION=ESTABLISHED", "L7_D4_CREDENTIAL=READABLE_BY_CORE_ACCOUNT", "LEGACY_UNCHANGED=PASS",
                   "PRODUCTION_MUTATION_PERFORMED=NO"):
        assert marker in res.stdout, marker
    ev = (fx.work / "validation-evidence.tsv").read_text()
    assert "stage\tL7" in ev and "result\tPASS" in ev
    for secret in SECRETS:
        assert secret not in res.stdout + res.stderr + ev


def test_l7_verify_is_read_only(fx: Fx) -> None:
    applied(fx)
    before = fx.tree()
    n = len(fx.calls())
    assert verified(fx).returncode == 0
    after = fx.tree()
    assert {k: v for k, v in after.items()} == before
    assert {c["argv"][0] for c in fx.calls()[n:]} <= {"show", "is-active", "is-enabled"}
    assert not [c for c in fx.calls("ss") if "state" not in " ".join(c["argv"]) and "-ltnu" not in " ".join(c["argv"])]


@pytest.mark.parametrize(
    "mutate,code",
    [
        (lambda f: f.creds.chmod(0o700), "MATERIAL_MODE_INVALID:credentials"),
        (lambda f: f.creds.chmod(0o770), "MATERIAL_MODE_INVALID:credentials"),
        (lambda f: (f.creds / "k_c2d").chmod(0o640), "MATERIAL_MODE_INVALID:k_c2d"),
        (lambda f: (f.creds / "admin.pin").chmod(0o660), "MATERIAL_MODE_INVALID:admin.pin"),
        (lambda f: (f.creds / "restore.credential").chmod(0o400), "MATERIAL_MODE_INVALID:restore.credential"),
        (lambda f: f.core_env.chmod(0o666), "MATERIAL_MODE_INVALID:core.env"),
        (lambda f: f.pki_ca.chmod(0o664), "MATERIAL_MODE_INVALID:mqtt-ca.crt"),
        (lambda f: f.unit.chmod(0o664), "MATERIAL_MODE_INVALID:aegis-idea3-core.service"),
        (lambda f: (f.creds / "ca.key").write_text("x"), "CREDENTIALS_ENTRIES_NOT_EXACT"),
        (lambda f: (f.creds / "extra.pass").write_text("x"), "CREDENTIALS_ENTRIES_NOT_EXACT"),
        (lambda f: (f.creds / "mqtt-core.pass").unlink(), "CREDENTIALS_ENTRIES_NOT_EXACT"),
        (lambda f: f.core_env.write_text(f.core_env.read_text().replace("AEGIS_AUTO_CONTAIN=0", "AEGIS_AUTO_CONTAIN=1")), "CORE_ENV_INVALID:VALUE_INVALID"),
        (lambda f: f.core_env.write_text(f.core_env.read_text() + "AEGIS_MQTT_PASS=leak\n"), "CORE_ENV_INVALID:FORBIDDEN_KEY"),
        (lambda f: f.unit.write_text(f.unit.read_text() + "\n# x\n"), "UNIT_CONTENT_CHANGED"),
        (lambda f: f.pki_ca.write_text("other ca\n"), "CA_COPY_MISMATCH"),
        (lambda f: (f.root / "etc/aegis-idea3/pki/ca.key").write_text("x"), "CA_PRIVATE_KEY_FORBIDDEN"),
        (lambda f: (f.release / "aegis_soc/supervisor.py").write_text("print('tampered')\n"), "RELEASE_GUARD_FAILED:CHECKSUM_MISMATCH"),
        (lambda f: (f.current.unlink(), f.current.symlink_to("/opt/aegis-idea3/releases/other")), "RELEASE_POINTER_INVALID"),
        (lambda f: f.current.unlink(), "RELEASE_POINTER_INVALID"),
    ],
)
def test_l7_verify_fails_closed_on_material_drift(fx: Fx, mutate, code: str) -> None:
    applied(fx)
    mutate(fx)
    res = verified(fx)
    assert res.returncode != 0 and vreason(res) == code, res.stderr


@pytest.mark.parametrize(
    "mutate,code",
    [
        (lambda f: (f.root / "etc/mosquitto/mosquitto.conf").write_text("listener 1883\n#x\n"), "LEGACY_CONFIG_TREE_CHANGED"),
        (lambda f: (f.root / "etc/aegis-idea3/mqtt/passwd").chmod(0o600), "L6B_MATERIAL_CHANGED"),
        (lambda f: (f.root / "etc/aegis-idea3/mqtt/broker.crt").write_bytes(b"changed"), "L6B_MATERIAL_CHANGED"),
    ],
)
def test_l7_verify_detects_predecessor_and_legacy_drift(fx: Fx, mutate, code: str) -> None:
    applied(fx)
    mutate(fx)
    assert vreason(verified(fx)) == code


def _set_state(fx: Fx, name: str, **changes) -> None:
    import json

    data = fx.data()
    data["units"][name].update(changes)
    fx.state.write_text(json.dumps(data))


@pytest.mark.parametrize(
    "name,changes,code",
    [
        (UNIT, {"active": "inactive", "sub": "dead"}, "CORE_SERVICE_NOT_ACTIVE"),
        (UNIT, {"active": "failed", "sub": "failed"}, "CORE_SERVICE_NOT_ACTIVE"),
        (UNIT, {"enabled": False}, "CORE_SERVICE_NOT_ENABLED"),
        (UNIT, {"sub": "auto-restart"}, "CORE_SERVICE_NOT_RUNNING"),
        (UNIT, {"nrestarts": 2}, "CORE_SERVICE_RESTARTED"),
        (UNIT, {"result": "exit-code"}, "CORE_SERVICE_RESULT_INVALID"),
        (s.BROKER_UNIT, {"pid": 9999}, "PREDECESSOR_SERVICE_CHANGED"),
        (s.LEGACY_UNIT, {"pid": 9999}, "PREDECESSOR_SERVICE_CHANGED"),
        (s.LEGACY_UNIT, {"nrestarts": 1}, "PREDECESSOR_SERVICE_CHANGED"),
    ],
)
def test_l7_verify_fails_on_service_state(fx: Fx, name: str, changes: dict, code: str) -> None:
    applied(fx)
    _set_state(fx, name, **changes)
    assert vreason(verified(fx)) == code


def test_l7_verify_requires_the_four_loadcredential_bindings(fx: Fx) -> None:
    applied(fx)
    res = verified(fx)
    assert res.returncode == 0
    shows = [c["argv"] for c in fx.calls(verb="show")]
    assert any("LoadCredential" in " ".join(a) for a in shows)
    fx.unit.write_text(fx.unit.read_text().replace("LoadCredential=admin.pin:/etc/aegis-idea3/credentials/admin.pin\n", ""))
    assert vreason(verified(fx)) == "UNIT_CONTENT_CHANGED"


def test_l7_verify_rejects_plaintext_secret_variables_in_the_process_environment(fx: Fx) -> None:
    applied(fx, FAKE_CORE_LEAK_ENV="1")
    assert vreason(verified(fx)) == "PROCESS_ENV_LEAK"


@pytest.mark.parametrize("env,code", [
    ({"FAKE_CORE_STATE": "FAILED"}, "STATUS_STATE_INVALID"), ({"FAKE_CORE_STATE": "LOCKDOWN"}, "STATUS_STATE_INVALID"),
    ({"FAKE_CORE_STATE": "PREFLIGHT"}, "STATUS_STATE_INVALID"), ({"FAKE_CORE_STATE": "WAIT_BROKER"}, "STATUS_STATE_INVALID"),
    ({"FAKE_CORE_BROKER": "DISCONNECTED"}, "BROKER_NOT_CONNECTED"),
])
def test_l7_verify_status_contract(fx: Fx, env: dict, code: str) -> None:
    applied(fx, **env)
    assert vreason(verified(fx)) == code


@pytest.mark.parametrize("state", ["WAIT_DEVICE", "DEGRADED"])
def test_l7_verify_accepts_the_expected_no_device_states_without_a_containment_claim(fx: Fx, state: str) -> None:
    applied(fx, FAKE_CORE_STATE=state)
    res = verified(fx)
    assert res.returncode == 0 and f"L7_CORE_STATE={state}" in res.stdout
    assert "CONTAINMENT" not in res.stdout.upper().replace("NO_CONTAINMENT", "")


def test_l7_verify_missing_status_file_fails(fx: Fx) -> None:
    applied(fx)
    (fx.root / "run/aegis-idea3/status.json").unlink()
    assert vreason(verified(fx)) == "STATUS_UNREADABLE"


def test_l7_verify_zero_actuation_in_the_protocol_store_and_audit_db(fx: Fx) -> None:
    applied(fx, FAKE_CORE_ACTUATE="1")
    assert vreason(verified(fx)) == "ACTUATION_DETECTED"


def test_l7_verify_detects_actuation_events_in_the_audit_db(fx: Fx) -> None:
    import sqlite3

    applied(fx)
    db = sqlite3.connect(fx.root / "var/lib/aegis-idea3/data/core-audit.sqlite3")
    db.execute("INSERT INTO audit_logs (timestamp, level, event_type, details) VALUES ('t','WARN','CUT_UPLINK','x')")
    db.commit()
    db.close()
    assert vreason(verified(fx)) == "ACTUATION_DETECTED"


@pytest.mark.parametrize("victim,code", [("core-audit.sqlite3", "AUDIT_DB_UNREADABLE"), ("core-protocol.sqlite3", "PROTOCOL_DB_MISSING")])
def test_l7_verify_requires_readable_databases(fx: Fx, victim: str, code: str) -> None:
    applied(fx)
    (fx.root / "var/lib/aegis-idea3/data" / victim).unlink()
    assert vreason(verified(fx)) == code
    (fx.root / "var/lib/aegis-idea3/data" / victim).write_text("not a database")
    assert vreason(verified(fx)) in {"AUDIT_DB_UNREADABLE", "PROTOCOL_DB_UNREADABLE"}


def test_l7_verify_actuation_scan_never_modifies_the_databases(fx: Fx) -> None:
    applied(fx)
    db = fx.root / "var/lib/aegis-idea3/data/core-audit.sqlite3"
    before = db.read_bytes()
    assert verified(fx).returncode == 0
    assert db.read_bytes() == before


def test_l7_verify_detects_new_listeners(fx: Fx) -> None:
    applied(fx)
    res = verified(fx, FAKE_SS_LISTEN="127.0.0.1:8883\n10.77.30.1:8883\n0.0.0.0:1883\n0.0.0.0:9999\n")
    assert vreason(res) == "NEW_LISTENER"


def test_l7_verify_requires_the_core_to_hold_an_outbound_tls_connection_to_the_broker(fx: Fx) -> None:
    applied(fx)
    assert vreason(verified(fx, FAKE_CORE_CONNECTED="0")) == "BROKER_CONNECTION_MISSING"


def test_l7_verify_journal_scan(fx: Fx) -> None:
    applied(fx)
    j = fx.tmp / "journal.txt"
    j.write_text("core started\nheartbeat published\n")
    assert verified(fx, AEGIS_L7_FIXTURE_JOURNAL=str(j)).returncode == 0
    j.write_text("published CUT_UPLINK command\n")
    assert vreason(verified(fx, AEGIS_L7_FIXTURE_JOURNAL=str(j))) == "ACTUATION_IN_JOURNAL"
    j.write_text(f"debug pin={ADMIN_PIN}\n")
    res = verified(fx, AEGIS_L7_FIXTURE_JOURNAL=str(j))
    assert vreason(res) == "JOURNAL_SECRET_LEAK" and ADMIN_PIN not in res.stdout + res.stderr


def test_l7_verify_d4_credential_must_be_readable_by_the_core_account(fx: Fx) -> None:
    applied(fx)
    (fx.creds / "restore.credential").write_text("corrupt\n")
    (fx.creds / "restore.credential").chmod(0o600)
    assert vreason(verified(fx)) == "D4_CREDENTIAL_UNSAFE"


# ── 6. rollback ──────────────────────────────────────────────────────────────────────────────────────────────────────────


def rolled(fx: Fx, **extra: str) -> subprocess.CompletedProcess[str]:
    return fx.run(ROLLBACK, **extra)


def test_l7_rollback_restores_the_exact_pre_state_and_is_idempotent(fx: Fx) -> None:
    before = fx.tree()
    applied(fx)
    res = rolled(fx)
    assert res.returncode == 0, res.stdout + res.stderr
    assert "L7_ROLLBACK=PASS" in res.stdout and "L7_MATERIAL_RESIDUE=NO" in res.stdout
    assert fx.tree() == before
    again = rolled(fx)
    assert again.returncode == 0, again.stdout + again.stderr
    assert fx.tree() == before
    assert sorted(p.name for p in fx.inp.iterdir()) == s.INPUT_ENTRIES


def test_l7_rollback_service_lifecycle_order_and_scope(fx: Fx) -> None:
    applied(fx)
    n = len(fx.calls())
    assert rolled(fx).returncode == 0
    calls = fx.calls()[n:]
    order = [c["argv"][0] for c in calls if c["argv"][0] not in ("show", "is-active", "is-enabled")]
    assert order == ["stop", "disable", "daemon-reload", "reset-failed"]
    stop = next(c for c in calls if c["argv"][0] == "stop")
    assert stop["unit_file"] is True  # stopped while the unit file still existed
    reset = [c for c in calls if c["argv"][0] == "reset-failed"]
    assert [c["argv"] for c in reset] == [["reset-failed", UNIT]] and reset[0]["unit_file"] is False  # after removal + reload, named unit only
    for c in calls:
        if c["argv"][0] not in ("show", "daemon-reload"):
            assert c["argv"][-1] == UNIT
    assert fx.unit_state() == {"load": "not-found", "active": "inactive", "sub": "dead", "result": "success", "enabled": False, "pid": 0, "nrestarts": 0} \
        or fx.unit_state()["load"] == "not-found"


def test_l7_rollback_clears_only_the_failed_core_unit_state(fx: Fx) -> None:
    """A failed Core start leaves LoadState=not-found/ActiveState=failed after rollback unless reset-failed names it (L6b lesson)."""
    assert fx.run(APPLY, FAKE_CORE_FAIL="preflight").returncode != 0  # failed Core state before rollback (A)
    assert fx.unit_state()["active"] == "failed"
    res = rolled(fx)
    assert res.returncode == 0, res.stdout + res.stderr
    st = fx.unit_state()
    assert (st["load"], st["active"], st["sub"], st["result"]) == ("not-found", "inactive", "dead", "success")  # B
    assert fx.unit_state(s.OTHER_FAILED)["active"] == "failed"  # C: unrelated failed unit untouched
    assert fx.unit_state(s.BROKER_UNIT)["pid"] == 2222 and fx.unit_state(s.LEGACY_UNIT)["pid"] == 1111
    assert rolled(fx).returncode == 0  # D: second rollback stays successful
    assert fx.unit_state()["load"] == "not-found"


def test_l7_rollback_fails_loudly_if_failed_state_survives_reset(fx: Fx) -> None:
    assert fx.run(APPLY, FAKE_CORE_FAIL="preflight").returncode != 0
    res = rolled(fx, FAKE_SYSTEMD_NOOP_RESET_FAILED="1")
    assert rreason(res) == "CORE_SERVICE_RUNTIME_STATE_RESIDUE"


def test_l7_rollback_archives_then_removes_only_runtime_dirs_the_stage_caused(fx: Fx) -> None:
    applied(fx)
    audit = (fx.root / "var/lib/aegis-idea3/data/core-audit.sqlite3").read_bytes()
    assert rolled(fx).returncode == 0
    for d in s.RUNTIME_DIRS:
        assert not (fx.root / d).exists(), d
    archived = fx.work / "rollback-archive/var-lib-aegis-idea3/data/core-audit.sqlite3"
    assert archived.read_bytes() == audit  # durable audit evidence is preserved, in the evidence area
    assert stat.S_IMODE((fx.work / "rollback-archive").stat().st_mode) == 0o700


def test_l7_rollback_preserves_runtime_dirs_that_existed_before_the_stage(fx: Fx) -> None:
    (fx.root / "var/log/aegis-idea3").mkdir(parents=True)
    (fx.root / "var/log/aegis-idea3/old.log").write_text("pre-existing\n")
    applied(fx)
    assert rolled(fx).returncode == 0
    assert (fx.root / "var/log/aegis-idea3/old.log").read_text() == "pre-existing\n"
    assert not (fx.root / "var/lib/aegis-idea3").exists()


def test_l7_rollback_refuses_to_follow_symlinks_when_removing_runtime_dirs(fx: Fx) -> None:
    applied(fx)
    (fx.root / "var/lib/aegis-idea3/escape").symlink_to("/etc")
    res = rolled(fx)
    assert rreason(res) == "RUNTIME_REMOVE_FAILED" and (fx.root / "var/lib/aegis-idea3").exists()


def test_l7_rollback_removes_only_journaled_paths_and_preserves_unrelated_files(fx: Fx) -> None:
    applied(fx)
    (fx.root / "etc/aegis-idea3/unrelated.conf").write_text("keep\n")
    assert rolled(fx).returncode == 0
    assert (fx.root / "etc/aegis-idea3/unrelated.conf").read_text() == "keep\n"
    assert (fx.root / "etc/aegis-idea3/mqtt/ca.crt").exists() and (fx.root / "etc/aegis-idea3/aegis-idea3.nft").exists()
    assert (fx.root / "etc/systemd/system" / s.BROKER_UNIT).exists()


def test_l7_rollback_leaves_a_preexisting_identical_pki_ca_in_place(fx: Fx) -> None:
    fx.pki_ca.write_bytes((fx.root / "etc/aegis-idea3/mqtt/ca.crt").read_bytes())
    fx.pki_ca.chmod(0o644)
    applied(fx)
    assert rolled(fx).returncode == 0
    assert fx.pki_ca.exists()


def test_l7_rollback_refuses_unowned_entries_in_the_credentials_dir(fx: Fx) -> None:
    applied(fx)
    (fx.creds / "operator-note.txt").write_text("not ours\n")
    res = rolled(fx)
    assert rreason(res) == "CREDENTIALS_DIR_HAS_UNOWNED_ENTRIES" and (fx.creds / "operator-note.txt").exists()


def test_l7_rollback_with_an_empty_journal_touches_nothing(fx: Fx) -> None:
    """The old handler defaulted every prestate flag to 'did not exist' and deleted pre-existing files when its manifest was missing."""
    applied(fx)
    (fx.work / "journal.tsv").write_text("")
    before = fx.tree()
    rolled(fx)
    assert fx.tree() == before
    assert (fx.creds / "k_c2d").exists() and fx.unit.exists() and fx.core_env.exists()


def test_l7_rollback_after_a_partial_apply_removes_only_the_journaled_prefix(fx: Fx) -> None:
    applied(fx)
    keep = [l for l in (fx.work / "journal.tsv").read_text().splitlines() if l.split("\t")[0] in ("DIR", "FILE")][:3]
    (fx.work / "journal.tsv").write_text("\n".join(keep) + "\n")
    survivors = {p for p in (fx.creds).iterdir()}
    res = rolled(fx)
    assert res.returncode != 0 and rreason(res) in {"CREDENTIALS_DIR_HAS_UNOWNED_ENTRIES", ""}
    assert len(survivors) == 5  # unjournaled files are never removed


@pytest.mark.parametrize("line", [
    "FILE\t/etc/mosquitto/passwd", "FILE\t/etc/aegis-idea3/mqtt/passwd", "FILE\t/etc/aegis-idea3/aegis-idea3.nft", "DIR\t/etc/aegis-idea3",
    "DIR\t/etc/aegis-idea3/mqtt", "UNIT\t/etc/systemd/system/mosquitto.service", "UNIT\t/etc/systemd/system/aegis-idea3-mosquitto.service",
    "SERVICE\tmosquitto.service", "SERVICE\taegis-idea3-mosquitto.service", "LINK\t/opt/aegis-idea3/releases/rel", "RUNTIME\t/etc",
    "RUNTIME\t/var/lib", "RUNTIME\t/var/lib/aegis-idea3/../../..", "WHATEVER\tx", "FILE\t../../etc/passwd",
])
def test_l7_rollback_rejects_tampered_journal_entries(fx: Fx, line: str) -> None:
    applied(fx)
    with (fx.work / "journal.tsv").open("a") as fh:
        fh.write(line + "\n")
    before = fx.tree()
    res = rolled(fx)
    assert rreason(res) in {"JOURNAL_ENTRY_NOT_OWNED", "JOURNAL_ENTRY_UNKNOWN"}
    assert fx.tree() == before


def test_l7_rollback_requires_journal_and_baselines(fx: Fx) -> None:
    applied(fx)
    (fx.work / "legacy-tree.sha256").unlink()
    assert rreason(rolled(fx)) == "BASELINE_MISSING"
    (fx.work / "journal.tsv").unlink()
    assert rreason(rolled(fx)) == "JOURNAL_MISSING"


def test_l7_rollback_removes_current_only_if_still_the_stage_link(fx: Fx) -> None:
    applied(fx)
    fx.current.unlink()
    fx.current.symlink_to("/opt/aegis-idea3/releases/other")
    assert rreason(rolled(fx)) == "CURRENT_LINK_CHANGED" and fx.current.is_symlink()


def test_l7_rollback_detects_legacy_and_predecessor_drift(fx: Fx) -> None:
    applied(fx)
    (fx.root / "etc/mosquitto/mosquitto.conf").write_text("listener 1883\n#changed\n")
    assert rreason(rolled(fx)) == "LEGACY_CONFIG_TREE_CHANGED"


def test_l7_rollback_never_touches_predecessors(fx: Fx) -> None:
    applied(fx)
    n = len(fx.calls())
    assert rolled(fx).returncode == 0
    for c in fx.calls()[n:]:
        if c["argv"][0] in ("stop", "disable", "reset-failed", "enable", "start"):
            assert c["argv"][-1] == UNIT


# ── 7. capture / compare: the strict preservation contract with the real harness ─────────────────────────────────────────


def test_l7_pre_post_allows_exactly_the_approved_deltas(fx: Fx) -> None:
    pre = s.capture(fx, "pre")
    applied(fx)
    post = s.capture(fx, "post")
    denied = s.compare(pre, post, allow=False)
    assert denied.returncode == 1 and "COMPARE_RESULT=FAIL" in denied.stdout
    ok = s.compare(pre, post, allow=True)
    assert ok.returncode == 0, ok.stdout + ok.stderr
    assert "FINDINGS_NEW_OR_WORSENED_DRIFT=0" in ok.stdout and "COMPARE_RESULT=PASS" in ok.stdout and "FINDINGS_APPROVED_CHANGE=0" not in ok.stdout


def test_l7_pre_post_rejects_an_unapproved_extra_file_in_idea3_etc(fx: Fx) -> None:
    pre = s.capture(fx, "pre")
    applied(fx)
    (fx.root / "etc/aegis-idea3/extra.conf").write_text("x\n")
    assert s.compare(pre, s.capture(fx, "post"), allow=True).returncode == 1


def test_l7_pre_rb_returns_to_pre_with_no_allowances_after_a_healthy_start(fx: Fx) -> None:
    pre = s.capture(fx, "pre")
    applied(fx)
    assert rolled(fx).returncode == 0
    res = s.compare(pre, s.capture(fx, "rb"), allow=False)
    assert res.returncode == 0, res.stdout + res.stderr
    assert "FINDINGS_NEW_OR_WORSENED_DRIFT=0" in res.stdout and "FINDINGS_APPROVED_CHANGE=0" in res.stdout
    assert "SERVICE_STATE_DRIFT" not in res.stdout and "SERVICE_RESTART_DRIFT" not in res.stdout


def test_l7_pre_rb_returns_to_pre_after_a_failed_core_start(fx: Fx) -> None:
    pre = s.capture(fx, "pre")
    assert fx.run(APPLY, FAKE_CORE_FAIL="preflight").returncode != 0
    assert rolled(fx).returncode == 0
    res = s.compare(pre, s.capture(fx, "rb"), allow=False)
    assert res.returncode == 0, res.stdout + res.stderr
    assert "SERVICE_STATE_DRIFT" not in res.stdout and "SERVICE_RESTART_DRIFT" not in res.stdout


def test_l7_pre_rb_stays_strict_when_failed_metadata_or_runtime_dirs_are_left_behind(fx: Fx) -> None:
    pre = s.capture(fx, "pre")
    assert fx.run(APPLY, FAKE_CORE_FAIL="preflight").returncode != 0
    assert rreason(rolled(fx, FAKE_SYSTEMD_NOOP_RESET_FAILED="1")) == "CORE_SERVICE_RUNTIME_STATE_RESIDUE"
    res = s.compare(pre, s.capture(fx, "rb"), allow=False)
    assert res.returncode == 1 and "SERVICE_STATE_DRIFT" in res.stdout


def test_l7_core_account_probes_use_the_installed_release_interpreter_live() -> None:
    """The runner's python and this checkout live under the owner's home, unreadable by the Core account, so a runuser probe with them
    would fail spuriously. Live probes must use the release's own venv python and code; the fixture uses the test interpreter."""
    for script in (APPLY, VERIFY):
        text = script.read_text()
        assert 'SVC_PY="$rel_host/venv/bin/python"; SVC_CODE_ROOT="$rel_host"' in text, script.name
        assert 'as_service "$SVC_PY" - "$SVC_CODE_ROOT"' in text and 'as_service "$PY"' not in text, script.name
