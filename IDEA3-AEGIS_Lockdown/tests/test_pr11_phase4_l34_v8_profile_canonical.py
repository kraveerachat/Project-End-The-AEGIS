# shellcheck shell=bash disable=SC1091
"""AEGIS IDEA3 PR11 Phase 4 — V8 canonical AP-profile proof (regression for the PR #291 review blocker).

A real libnm rewrite of the hand-rendered AP keyfile re-orders keys inside sections (and the NetworkManager daemon assigns a connection uuid), so a file-order
digest would flag a legitimate rewrite as drift and make the first live V8 attempt fail closed for a cosmetic reason. `l34_v8_profile_canonical` therefore proves
the profile on canonical `[section]/key=value` records: order-insensitive, section-qualified, insensitive ONLY to connection.autoconnect, the daemon-assigned
connection uuid and secret fields (never printed or hashed), and still sensitive to every other semantic change.

Fixtures under tests/fixtures/l34_v8/ were produced by libnm's own keyfile reader/writer (NM 1.58.1) from the hand-rendered template; a gi-conditional test
regenerates them and compares byte for byte, so they are provably real libnm output and not hand-edited.
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))
import l34_sim as sim  # noqa: E402
import test_pr11_phase4_l34_reactivation as base  # noqa: E402
import test_pr11_phase4_l34_v8_post_v7_persistent_ap_recovery as h  # noqa: E402

DEPLOY = base.DEPLOY
LIB = base.LIB
V8_LIB = DEPLOY / "p4-l34-v8-lib.sh"
FIX = Path(__file__).parent / "fixtures" / "l34_v8"
TEMPLATE = (FIX / "profile-template-order.nmconnection").read_text()
LIBNM_YES = (FIX / "profile-libnm-autoconnect-yes.nmconnection").read_text()
LIBNM_NO = (FIX / "profile-libnm-autoconnect-no.nmconnection").read_text()
LIBNM_YES_TS = (FIX / "profile-libnm-autoconnect-yes-timestamp.nmconnection").read_text()
LIBNM_NO_TS = (FIX / "profile-libnm-autoconnect-no-timestamp.nmconnection").read_text()
TIMESTAMP = "1790896283"  # the value observed in the live S-11 hold, 2026-10-02
PSK = "NOT-A-REAL-PSK-FIXTURE"


def bash(body: str, cwd: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["bash", "-c", f'source "{LIB}"\nsource "{V8_LIB}"\n{body}'], text=True, capture_output=True, cwd=cwd, check=False)


class Prof:
    """A profile on disk plus the V8 snapshot taken from the TEMPLATE (autoconnect=false, hand-rendered order) — the PRE state of the real host."""

    def __init__(self, tmp: Path) -> None:
        self.tmp = tmp
        self.file = tmp / "aegis-idea3-ap.nmconnection"
        self.file.write_text(TEMPLATE)
        self.file.chmod(0o600)
        self.snap = tmp / "persistent-pre.tsv"
        res = bash(f'l34_v8_persistent_snapshot "{self.snap}" "{self.file}"', tmp)
        assert res.returncode == 0, res.stderr

    def write(self, text: str) -> None:
        self.file.write_text(text)

    def verify(self, expect: str) -> subprocess.CompletedProcess[str]:
        return bash(f'l34_v8_persistent_verify "{self.snap}" {expect}', self.tmp)


def with_uuid(text: str) -> str:
    return text.replace("id=aegis-idea3-ap\n", "id=aegis-idea3-ap\nuuid=b158569b-6281-4b88-b3bc-639a1b1c40c7\n", 1)


# ── PASS: only the approved differences ───────────────────────────────────────────────────────────────────────────────

def test_libnm_reordered_profile_with_autoconnect_yes_passes(tmp_path: Path) -> None:  # LIBNM_REORDER_TEST
    p = Prof(tmp_path)
    p.write(LIBNM_YES)
    assert LIBNM_YES != TEMPLATE and "mode=ap\nband=bg" in TEMPLATE and "band=bg\nchannel=6\nmode=ap" in LIBNM_YES, "the fixture really is re-ordered"
    res = p.verify("yes")
    assert res.returncode == 0, res.stderr


def test_daemon_added_uuid_is_ignored(tmp_path: Path) -> None:  # UUID_TEST
    p = Prof(tmp_path)
    p.write(with_uuid(LIBNM_YES))
    assert "uuid=" in p.file.read_text()
    assert p.verify("yes").returncode == 0
    p.write(with_uuid(LIBNM_NO))
    assert p.verify("no").returncode == 0, "rollback direction: reordered, uuid-bearing, autoconnect=false"


def test_autoconnect_false_to_true_only_passes(tmp_path: Path) -> None:
    p = Prof(tmp_path)
    p.write(TEMPLATE.replace("autoconnect=false", "autoconnect=true"))
    assert p.verify("yes").returncode == 0
    p.write(TEMPLATE.replace("autoconnect=false\n", ""))
    assert p.verify("yes").returncode == 0, "NetworkManager omits the default value"


def test_rollback_direction_libnm_no_passes_against_the_template_snapshot(tmp_path: Path) -> None:
    p = Prof(tmp_path)
    p.write(LIBNM_NO)
    assert "autoconnect=false" in LIBNM_NO
    assert p.verify("no").returncode == 0


def test_comments_blank_lines_whitespace_and_empty_sections_are_ignored(tmp_path: Path) -> None:
    p = Prof(tmp_path)
    p.write("# comment\n" + LIBNM_YES.replace("ssid=AEGIS-IDEA3", " ssid = AEGIS-IDEA3 ") + "\n[proxy]\n\n; trailing\n")
    assert p.verify("yes").returncode == 0


def test_secret_values_are_not_part_of_the_proof_but_the_secret_line_count_is(tmp_path: Path) -> None:
    p = Prof(tmp_path)
    p.write(LIBNM_YES.replace(PSK, "ANOTHER-FIXTURE-VALUE"))
    assert p.verify("yes").returncode == 0, "a secret VALUE is never hashed, so it cannot be part of the proof"
    p.write(LIBNM_YES.replace(f"psk={PSK}\n", ""))
    res = p.verify("yes")
    assert res.returncode == 1 and "L34_V8_PROFILE_CHANGED_BEYOND_AUTOCONNECT" in res.stderr, "removing the secret line changes the recorded count"
    p.write(LIBNM_YES + f"psk={PSK}\n")
    assert p.verify("yes").returncode == 1


# ── FAIL: any other semantic drift ────────────────────────────────────────────────────────────────────────────────────

NEG = {
    "ssid": ("ssid=AEGIS-IDEA3", "ssid=OTHER-AP"),                                         # SSID_NEGATIVE_TEST
    "channel": ("channel=6", "channel=11"),                                                # CHANNEL_NEGATIVE_TEST
    "address1": ("address1=10.77.30.1/28", "address1=10.77.30.9/28"),                      # ADDRESS_NEGATIVE_TEST
    "method": ("method=manual", "method=shared"),                                          # METHOD_NEGATIVE_TEST
    "id": ("id=aegis-idea3-ap", "id=other-profile"),
    "mode": ("mode=ap", "mode=infrastructure"),
    "band": ("band=bg", "band=a"),
    "interface-name": ("interface-name=wlp0s20f3", "interface-name=wlan1"),
    "ipv6-method": ("method=disabled", "method=auto"),
    "key-mgmt": ("key-mgmt=wpa-psk", "key-mgmt=none"),
}


@pytest.mark.parametrize("name", sorted(NEG))
def test_changed_non_secret_value_fails(tmp_path: Path, name: str) -> None:
    old, new = NEG[name]
    assert old in LIBNM_YES
    p = Prof(tmp_path)
    p.write(LIBNM_YES.replace(old, new, 1))
    res = p.verify("yes")
    assert res.returncode == 1 and "L34_V8_PROFILE_CHANGED_BEYOND_AUTOCONNECT" in res.stderr, (name, res.stderr)


def test_added_unrelated_non_secret_key_fails(tmp_path: Path) -> None:  # ADDED_KEY_NEGATIVE_TEST
    p = Prof(tmp_path)
    p.write(LIBNM_YES.replace("ssid=AEGIS-IDEA3\n", "ssid=AEGIS-IDEA3\nhidden=true\n", 1))
    res = p.verify("yes")
    assert res.returncode == 1 and "L34_V8_PROFILE_CHANGED_BEYOND_AUTOCONNECT" in res.stderr


def test_removed_unrelated_non_secret_key_fails(tmp_path: Path) -> None:  # REMOVED_KEY_NEGATIVE_TEST
    p = Prof(tmp_path)
    p.write(LIBNM_YES.replace("never-default=true\n", "", 1))
    res = p.verify("yes")
    assert res.returncode == 1 and "L34_V8_PROFILE_CHANGED_BEYOND_AUTOCONNECT" in res.stderr


def test_key_moved_to_a_different_section_fails(tmp_path: Path) -> None:  # SECTION_MOVE_NEGATIVE_TEST
    p = Prof(tmp_path)
    moved = LIBNM_YES.replace("never-default=true\n", "", 1).replace("method=disabled", "method=disabled\nnever-default=true", 1)
    assert moved.count("never-default=true") == 1
    p.write(moved)
    res = p.verify("yes")
    assert res.returncode == 1 and "L34_V8_PROFILE_CHANGED_BEYOND_AUTOCONNECT" in res.stderr


def test_uuid_outside_the_connection_section_is_not_ignored(tmp_path: Path) -> None:
    p = Prof(tmp_path)
    p.write(LIBNM_YES.replace("ssid=AEGIS-IDEA3\n", "ssid=AEGIS-IDEA3\nuuid=b158569b-6281-4b88-b3bc-639a1b1c40c7\n", 1))
    assert p.verify("yes").returncode == 1


def test_a_duplicated_key_fails(tmp_path: Path) -> None:
    p = Prof(tmp_path)
    p.write(LIBNM_YES.replace("channel=6\n", "channel=6\nchannel=6\n", 1))
    assert p.verify("yes").returncode == 1


def test_autoconnect_value_is_still_enforced_in_each_direction(tmp_path: Path) -> None:
    p = Prof(tmp_path)
    p.write(LIBNM_YES)
    res = p.verify("no")
    assert res.returncode == 1 and "L34_V8_PROFILE_AUTOCONNECT_NOT_FALSE" in res.stderr
    p.write(LIBNM_NO)
    res = p.verify("yes")
    assert res.returncode == 1 and "L34_V8_PROFILE_AUTOCONNECT_NOT_ENABLED" in res.stderr


def test_profile_mode_owner_change_still_fails(tmp_path: Path) -> None:
    p = Prof(tmp_path)
    p.write(LIBNM_YES)
    p.file.chmod(0o640)
    assert p.verify("yes").returncode == 1


# ── S-11 (live V8, 2026-10-02): NetworkManager persists connection.timestamp on its own rewrite ──────────────────────────

def test_networkmanager_maintained_connection_timestamp_is_ignored_in_both_directions(tmp_path: Path) -> None:  # TIMESTAMP_REGRESSION_TEST
    p = Prof(tmp_path)
    assert f"timestamp={TIMESTAMP}" in LIBNM_YES_TS and f"timestamp={TIMESTAMP}" in LIBNM_NO_TS
    p.write(LIBNM_YES_TS)
    assert p.verify("yes").returncode == 0, "apply direction: the libnm rewrite after `nmcli connection modify … autoconnect yes`"
    p.write(LIBNM_NO_TS)
    assert p.verify("no").returncode == 0, "rollback direction: no -> NetworkManager rewrite with timestamp -> canonical integrity still passes"
    p.write(with_uuid(LIBNM_YES_TS))
    assert p.verify("yes").returncode == 0, "uuid and timestamp together, exactly as the daemon writes them"


def test_the_timestamp_is_the_only_difference_from_the_proven_fixtures() -> None:
    assert LIBNM_YES_TS.replace(f"timestamp={TIMESTAMP}\n", "") == LIBNM_YES
    assert LIBNM_NO_TS.replace(f"timestamp={TIMESTAMP}\n", "") == LIBNM_NO


@pytest.mark.parametrize("stamp", ["0", "1", TIMESTAMP, "9999999999"])
def test_any_numeric_timestamp_value_is_ignored(tmp_path: Path, stamp: str) -> None:
    p = Prof(tmp_path)
    p.write(LIBNM_YES_TS.replace(TIMESTAMP, stamp))
    assert p.verify("yes").returncode == 0


@pytest.mark.parametrize("stamp", ["", "abc", "-1", "12 34", "1790896283x", "0x10", "1.5"])
def test_a_non_numeric_timestamp_is_not_ignored(tmp_path: Path, stamp: str) -> None:  # TIMESTAMP_NOT_A_BYPASS_TEST
    p = Prof(tmp_path)
    p.write(LIBNM_YES_TS.replace(f"timestamp={TIMESTAMP}", f"timestamp={stamp}"))
    res = p.verify("yes")
    assert res.returncode == 1 and "L34_V8_PROFILE_CHANGED_BEYOND_AUTOCONNECT" in res.stderr, (stamp, res.stderr)


@pytest.mark.parametrize("section", ["wifi", "wifi-security", "ipv4", "ipv6", "proxy"])
def test_a_timestamp_key_outside_the_connection_section_is_not_ignored(tmp_path: Path, section: str) -> None:  # TIMESTAMP_SECTION_NEGATIVE_TEST
    p = Prof(tmp_path)
    body = LIBNM_YES + f"\n[{section}]\ntimestamp={TIMESTAMP}\n"
    p.write(body)
    res = p.verify("yes")
    assert res.returncode == 1 and "L34_V8_PROFILE_CHANGED_BEYOND_AUTOCONNECT" in res.stderr, section


@pytest.mark.parametrize("other", ["hidden=true", "permissions=user:root:;", "timestamps=1", "last-timestamp=1", "Timestamp=1", "stamp=1", "metered=2"])
def test_timestamp_exception_is_not_a_generic_unknown_key_bypass(tmp_path: Path, other: str) -> None:  # NO_UNKNOWN_KEY_BYPASS_TEST
    p = Prof(tmp_path)
    p.write(LIBNM_YES_TS.replace(f"timestamp={TIMESTAMP}\n", f"timestamp={TIMESTAMP}\n{other}\n", 1))
    res = p.verify("yes")
    assert res.returncode == 1 and "L34_V8_PROFILE_CHANGED_BEYOND_AUTOCONNECT" in res.stderr, (other, res.stderr)


@pytest.mark.parametrize("name", sorted(NEG))
def test_protected_values_still_fail_when_the_networkmanager_timestamp_is_present(tmp_path: Path, name: str) -> None:  # PROTECTED_WITH_TIMESTAMP_TEST
    old, new = NEG[name]
    assert old in LIBNM_YES_TS
    p = Prof(tmp_path)
    p.write(LIBNM_YES_TS.replace(old, new, 1))
    res = p.verify("yes")
    assert res.returncode == 1 and "L34_V8_PROFILE_CHANGED_BEYOND_AUTOCONNECT" in res.stderr, (name, res.stderr)


def test_psk_line_count_mismatch_and_mode_change_still_fail_with_the_timestamp_present(tmp_path: Path) -> None:
    p = Prof(tmp_path)
    p.write(LIBNM_YES_TS.replace(f"psk={PSK}\n", ""))
    assert p.verify("yes").returncode == 1, "PSK line removed"
    p.write(LIBNM_YES_TS + f"psk={PSK}\n")
    assert p.verify("yes").returncode == 1, "PSK line duplicated"
    p.write(LIBNM_YES_TS)
    p.file.chmod(0o640)
    assert p.verify("yes").returncode == 1, "mode drift"


def test_autoconnect_is_still_enforced_with_the_timestamp_present(tmp_path: Path) -> None:
    p = Prof(tmp_path)
    p.write(LIBNM_YES_TS)
    res = p.verify("no")
    assert res.returncode == 1 and "L34_V8_PROFILE_AUTOCONNECT_NOT_FALSE" in res.stderr
    p.write(LIBNM_NO_TS)
    res = p.verify("yes")
    assert res.returncode == 1 and "L34_V8_PROFILE_AUTOCONNECT_NOT_ENABLED" in res.stderr


def test_the_timestamp_never_reaches_the_canonical_output_and_secrets_stay_out(tmp_path: Path) -> None:
    p = Prof(tmp_path)
    p.write(LIBNM_YES_TS)
    out = bash(f'l34_v8_profile_canonical "{p.file}"', tmp_path).stdout
    assert "timestamp" not in out and PSK not in out
    assert out == bash(f'l34_v8_profile_canonical "{FIX / "profile-libnm-autoconnect-no.nmconnection"}"', tmp_path).stdout


# ── secret boundary ───────────────────────────────────────────────────────────────────────────────────────────────────

def test_canonical_records_and_the_snapshot_never_contain_a_secret_value(tmp_path: Path) -> None:
    p = Prof(tmp_path)
    canon = bash(f'l34_v8_profile_canonical "{p.file}"', tmp_path)
    assert canon.returncode == 0 and PSK not in canon.stdout + canon.stderr and "]/psk=" not in canon.stdout
    assert "[wifi-security]/key-mgmt=wpa-psk" in canon.stdout, "non-secret neighbours of the secret stay in the proof"
    snap = p.snap.read_text()
    assert PSK not in snap and "psk_lines=1" in snap
    for secret_key in ("wep-key0", "leap-password", "password", "private-key-password", "pin"):
        p.write(LIBNM_YES + f"\n[wifi-security]\n{secret_key}=SECRET-{secret_key}\n")
        out = bash(f'l34_v8_profile_canonical "{p.file}"', tmp_path).stdout
        assert f"SECRET-{secret_key}" not in out and secret_key + "=" not in out


# ── one canonical function everywhere ────────────────────────────────────────────────────────────────────────────────────

def test_one_canonical_record_function_backs_snapshot_apply_verify_and_rollback() -> None:
    lib = V8_LIB.read_text()
    assert lib.count("l34_v8_profile_canonical") >= 2 and "l34_v8_profile_canonical \"$f\" | sha256sum" in lib
    rec = lib.split("l34_v8_profile_record() {", 1)[1].split("\n}\n", 1)[0]
    assert "l34_v8_profile_canonical" in rec and "grep -viE" not in rec, "no file-order digest remains"
    assert lib.count("sha256sum") == 1, "the only digest in the V8 library is the canonical one"
    for name in ("apply.sh", "verify.sh", "rollback.sh"):
        text = base.code_lines(h.HND / name)
        assert "l34_v8_persistent_verify" in text, name
        assert "sha256sum" not in text and "grep -viE" not in text, f"{name} must not compute its own profile digest"
    snap = lib.split("l34_v8_persistent_snapshot() {", 1)[1].split("\n}\n", 1)[0]
    assert "l34_v8_profile_record" in snap
    ver = lib.split("l34_v8_persistent_verify() {", 1)[1].split("\n}\n", 1)[0]
    assert "l34_v8_profile_record" in ver


def test_only_the_approved_exclusions_exist_in_the_canonicalizer() -> None:
    body = canonicalizer_body()
    assert re.findall(r'k == "([a-z-]+)"', body) == ["autoconnect", "uuid", "timestamp"]
    assert 'sec == "connection"' in body
    assert "(psk|wep-key[0-9]*|leap-password|password|private-key-password|pin)" in body
    assert body.count("next") == 5, "comments/blank, section headers, secret keys, the two approved connection keys and the numeric connection timestamp only"


def canonicalizer_body() -> str:
    return V8_LIB.read_text().split("l34_v8_profile_canonical() {", 1)[1].split("\n}\n", 1)[0]


# ── handler-level: the simulator re-serializes like NetworkManager ─────────────────────────────────────────────────────

@pytest.mark.parametrize("over", [
    dict(profile_modify_reorders=True),
    dict(profile_modify_reorders=True, profile_modify_adds_uuid=True),
    dict(profile_modify_adds_uuid=True),
    dict(profile_modify_reorders=True, profile_modify_adds_uuid=True, profile_modify_writes="true"),
    dict(profile_modify_adds_timestamp=True),                                                      # S-11 regression
    dict(profile_modify_reorders=True, profile_modify_adds_uuid=True, profile_modify_adds_timestamp=True),  # S-11 regression: exactly what the daemon writes
])
def test_apply_verify_and_rollback_accept_a_networkmanager_style_rewrite(tmp_path: Path, over: dict) -> None:
    fx = h.v8(tmp_path, **over)
    res = h.run(fx, h.APPLY)
    assert res.returncode == 0, res.stdout + res.stderr
    text = fx.file(base.PROFILE_REL).read_text()
    if over.get("profile_modify_reorders"):
        assert text.index("band=bg") < text.index("mode=ap"), "the simulator really re-ordered the keyfile"
    if over.get("profile_modify_adds_uuid"):
        assert "uuid=" in text
    if over.get("profile_modify_adds_timestamp"):
        assert f"timestamp={TIMESTAMP}" in text, "the simulator really persisted the NetworkManager timestamp"
    ver = h.run(fx, h.VERIFY)
    assert ver.returncode == 0, ver.stdout + ver.stderr
    rb = h.run(fx, h.ROLLBACK)
    assert rb.returncode == 0, rb.stdout + rb.stderr
    assert fx.state()["ap_profile_autoconnect"] == "no" and "autoconnect=false" in fx.file(base.PROFILE_REL).read_text()
    assert "semantically identical" in rb.stdout


@pytest.mark.parametrize("extra", ["wifi|hidden=true", "ipv4|dns=10.77.30.1", "connection|permissions=user:root:;", "wifi|timestamp=1790896283", "connection|timestamp=notanumber"])
def test_apply_fails_closed_when_the_rewrite_adds_an_unrelated_non_secret_key(tmp_path: Path, extra: str) -> None:
    fx = h.v8(tmp_path, profile_modify_reorders=True, profile_modify_adds_timestamp=True, profile_modify_extra=extra)
    res = h.run(fx, h.APPLY)
    assert res.returncode == 1 and "L34_V8_PROFILE_CHANGED_BEYOND_AUTOCONNECT" in res.stderr, res.stdout + res.stderr
    assert (fx.work / "production-mutation").exists() and "nmcli connection up aegis-idea3-ap ifname wlp0s20f3" not in fx.calls()
    rb = h.run(fx, h.ROLLBACK)
    assert rb.returncode == 1 and "L34_V8_PROFILE_CHANGED_BEYOND_AUTOCONNECT" in rb.stderr, "rollback cannot prove an unrelated key away: it escalates"


def test_apply_fails_closed_when_the_rewrite_changes_a_value_even_with_reordering(tmp_path: Path) -> None:
    fx = h.v8(tmp_path, profile_modify_reorders=True, profile_modify_corrupts=True)
    res = h.run(fx, h.APPLY)
    assert res.returncode == 1 and "L34_V8_PROFILE_CHANGED_BEYOND_AUTOCONNECT" in res.stderr


def test_verify_still_refuses_a_value_change_made_after_a_clean_networkmanager_style_apply(tmp_path: Path) -> None:
    fx = h.v8(tmp_path, profile_modify_reorders=True, profile_modify_adds_uuid=True)
    assert h.run(fx, h.APPLY).returncode == 0
    p = fx.file(base.PROFILE_REL)
    p.write_text(p.read_text().replace("ssid=AEGIS-IDEA3", "ssid=OTHER"))
    ver = h.run(fx, h.VERIFY)
    assert ver.returncode == 1 and "L34_V8_PROFILE_CHANGED_BEYOND_AUTOCONNECT" in ver.stderr


# ── the fixtures are real libnm output ─────────────────────────────────────────────────────────────────────────────────────

def _libnm():
    gi = pytest.importorskip("gi")
    try:
        gi.require_version("NM", "1.0")
        from gi.repository import NM, GLib
    except (ValueError, ImportError):  # pragma: no cover - libnm typelib not installed
        pytest.skip("libnm GObject introspection is not available")
    return NM, GLib


def test_committed_fixtures_are_byte_for_byte_libnm_output() -> None:
    NM, GLib = _libnm()
    kf = GLib.KeyFile.new()
    kf.load_from_file(str(FIX / "profile-template-order.nmconnection"), GLib.KeyFileFlags.NONE)
    conn = NM.keyfile_read(kf, str(FIX), NM.KeyfileHandlerFlags.NONE, None, None)
    for name, value, committed in (("yes", True, LIBNM_YES), ("no", False, LIBNM_NO)):
        conn.get_setting_connection().set_property("autoconnect", value)
        assert NM.keyfile_write(conn, NM.KeyfileHandlerFlags.NONE, None, None).to_data()[0] == committed, name


def test_libnm_output_for_the_real_template_passes_the_canonical_proof_live_regenerated(tmp_path: Path) -> None:
    NM, GLib = _libnm()
    p = Prof(tmp_path)
    kf = GLib.KeyFile.new()
    kf.load_from_file(str(p.file), GLib.KeyFileFlags.NONE)
    conn = NM.keyfile_read(kf, str(tmp_path), NM.KeyfileHandlerFlags.NONE, None, None)
    conn.get_setting_connection().set_property("autoconnect", True)
    p.write(NM.keyfile_write(conn, NM.KeyfileHandlerFlags.NONE, None, None).to_data()[0])
    assert p.verify("yes").returncode == 0



def test_committed_timestamp_fixtures_are_byte_for_byte_libnm_output() -> None:
    NM, GLib = _libnm()
    kf = GLib.KeyFile.new()
    kf.load_from_file(str(FIX / "profile-template-order.nmconnection"), GLib.KeyFileFlags.NONE)
    conn = NM.keyfile_read(kf, str(FIX), NM.KeyfileHandlerFlags.NONE, None, None)
    for name, value, committed in (("yes", True, LIBNM_YES_TS), ("no", False, LIBNM_NO_TS)):
        sc = conn.get_setting_connection()
        sc.set_property("autoconnect", value)
        sc.set_property("timestamp", int(TIMESTAMP))
        assert NM.keyfile_write(conn, NM.KeyfileHandlerFlags.NONE, None, None).to_data()[0] == committed, name
