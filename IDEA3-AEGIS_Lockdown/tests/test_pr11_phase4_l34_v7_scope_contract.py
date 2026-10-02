# shellcheck shell=bash disable=SC1091
"""AEGIS IDEA3 PR11 Phase 4 — V7 authorization scope, stage-gate contract and V1–V6 non-regression pins.

Proves:
1. V7 EXPECTED_SCOPE is <=200 printable-ASCII characters (global stage-gate contract), distinct from V3/V4/V5/V6, and passes the REAL p4-stage-gate.sh.
2. Owner-run freeze/auth/one-attempt semantics are present and V7's consume ordering is preflight -> PRE capture -> consume -> apply (once).
3. NOTHING in V1–V6 changed: every V1–V6 handler, allow file and owner runner is byte-identical to the main it was reviewed at (07633c93), and the
   shared gate library's pre-V7 part is byte-identical (V7 only APPENDED l34_v7_* functions). The original L34 runner and its broker-inactive gate are intact.
4. The V7 file set is exactly the frozen set and the V7 allow files never approve a persistent artifact, plaintext 1883, or any Core key.
Pure repository test: no live commands, no Production mutation.
"""

from __future__ import annotations

import hashlib
import os
import re
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
DEPLOY = ROOT / "deploy" / "pr11-phase4"
HND = DEPLOY / "reactivation" / "l34-v7-radio-disabled-broker-churn"
RUNNER_V7 = DEPLOY / "owner-run" / "run-l34-v7-radio-disabled-broker-churn-owner.sh"
OTHER_RUNNERS = {
    "v3": DEPLOY / "owner-run" / "run-l34-reactivation-owner.sh", "v4": DEPLOY / "owner-run" / "run-l34-v4-post-l6b-owner.sh",
    "v5": DEPLOY / "owner-run" / "run-l34-v5-post-l6b-degraded-owner.sh", "v6": DEPLOY / "owner-run" / "run-l34-v6-stale-broker-ap-down-owner.sh",
}
STAGE_GATE = DEPLOY / "p4-stage-gate.sh"
LIB = DEPLOY / "p4-l34-reactivation-lib.sh"
V7_MARKER = "# ── V7 (RADIO-DISABLED + BROKER-CHURN) reactivation"
# sha256 of the shared gate library up to (excluding) the V7 section, as merged at main 07633c93: V7 may only append after V7_MARKER.
# AMENDED (PR #305, owner-approved re-pin): the only change to the shared lib is l34_dnsmasq_unit_gate + new l34_render_dnsmasq_unit, so the byte-identity
# authority is the canonical template rendered with the fixed L34 values. The pre-amendment pin was f985a26e506e1694c907821707df301b935eee4782da9cadf12b91839685c035.
LIB_PRE_V7_SHA256 = "ee5f992ab4486e1238788de40d0f74faca9e7ebad8d64546f83a1df7c36afdd3"
# sha256 of every V1–V6 handler / allow file / owner runner at main 07633c93. A deliberate future V1–V6 change must update this pin.
V1_V6_PINS = {
    "reactivation/l34/allow-dynamic-transitions-rollback.txt": "0768b4c5aa08f67e28fc8da7f39162d7023ec95b0f6b23e79f9740fa7500f18c",
    "reactivation/l34/allow-dynamic-transitions-v3-post-fresh.txt": "7487c9cdf2f0306950b31ce4fd5fb60ca4fa590a984ade5721a54772dbbf1115",
    "reactivation/l34/allow-dynamic-transitions-v3-post-residual.txt": "662eccb7e84bec9d29c1a5b72e0a80cb6cb91003dd8ea29a3bd8e59fa6ea5f09",
    "reactivation/l34/allow-dynamic-transitions-v3-rollback-fresh.txt": "409fcc535344a672e7af6af42b43c2b8c903a90081a9a8a409ec0aaf6c67ed80",
    "reactivation/l34/allow-dynamic-transitions-v3-rollback-residual.txt": "3a3c407dde4f8874410f220a8e36d9776bd48dc93cf0cc38bab8a1491b4055d8",
    "reactivation/l34/allow-dynamic-transitions.txt": "e8b2e030fdf8ecd3ad6ca1b8134073375f1711f0744a783b944f0d24910eeedf",
    "reactivation/l34/allow-keys-rollback.txt": "0eb11afd9a672b88f9fdf06ae360134e034c983ee2e30884f6e138901a8fd8bc",
    "reactivation/l34/allow-keys.txt": "169edfc01ce8fa00bdb7bd36a2c2f0d56f23006a1bacf41806513cc6c6f5b940",
    "reactivation/l34/allow-listeners.txt": "06371f4dacdc7105ed11a20e987219106de96ee67e1a42a30c17abd6e30a953d",
    "reactivation/l34/allow-transitions.txt": "98208caac4e7bf856581f8fea06939e885b4b24f0b8455a5110f036e84c005df",
    "reactivation/l34/apply.sh": "1f6ffdb6b097d6af7a1dfd8ffe57ee0a868548b7d2901b1ad2e8be78ded328d1",
    "reactivation/l34/rollback.sh": "f785577d627f01068a0c839e2db8539bd05a207a23f74548ab1ab57d2a9668ae",
    "reactivation/l34/verify.sh": "ddf061fe51254bc511d1af5565e95ec40f2e054f823d62d50f7a64d0bbec1ccf",
    "reactivation/l34-v4-post-l6b/allow-keys.txt": "86e126e548389792249eaa3ca9b906a6ee695a60c979b4d4456b1ce022a6e87b",
    "reactivation/l34-v4-post-l6b/allow-listeners.txt": "9e70ee157a9eb06490787c73df79b57372d42230eebdc7f20f218c60556e1075",
    "reactivation/l34-v4-post-l6b/apply.sh": "8293550b303ede3118f56228fe7ac6b8ad650c7d394e67ef4dd1e09687905ba9",
    "reactivation/l34-v4-post-l6b/rollback.sh": "a4c6225abc2b601d9eb4d1456fab4db439d7523002d4f16f3d6fb05ea09a0f75",
    "reactivation/l34-v4-post-l6b/verify.sh": "ff02fb18b21ffea9e305ff6ec921b87614b8a805aa89103149c5a84a61cec95e",
    "reactivation/l34-v5-post-l6b-degraded/allow-keys.txt": "a9bc86dcaf627c752cfbbbee995dc0656cf90307f317d329c70a809c65372b58",
    "reactivation/l34-v5-post-l6b-degraded/allow-listeners.txt": "386adaaa3da53f9dfa5630fb2f01afcd42ea288cfffa243d0f020ae8e131b893",
    "reactivation/l34-v5-post-l6b-degraded/apply.sh": "cf7bf0eb860a2385c9ee231d2f2fa56b636241832ce12bbef5b1254cba13cead",
    "reactivation/l34-v5-post-l6b-degraded/rollback.sh": "9b8b6226e40c11274c7b5408cb7d1609dc97384dc099eeed791665754ff8c4d0",
    "reactivation/l34-v5-post-l6b-degraded/verify.sh": "6164ed32bf8e3cd01126ea7d4c21f843c993d79ae331da3e1f9c5d4298620e4c",
    "reactivation/l34-v6-stale-broker-ap-down/allow-keys.txt": "56d85806d59803d0636578eba8f874f00c934001b99b42f42798e951f374e6f8",
    "reactivation/l34-v6-stale-broker-ap-down/allow-listeners.txt": "fbf09ce7644f633a2aad326ff67a6a05fe626a8792ace6fadb9ae9de3309f363",
    "reactivation/l34-v6-stale-broker-ap-down/apply.sh": "4df3bfcd39db127fe526db5023c6a4f47b4c3c514b976cf4da3fc6f03a9114c4",
    "reactivation/l34-v6-stale-broker-ap-down/rollback.sh": "f607388fd560334a339123d9932dce01122a28c061fcc3f601bea288893a3ea1",
    "reactivation/l34-v6-stale-broker-ap-down/verify.sh": "b10134c03bc88230b1321619a1036ace2fdc38d20913ea38deb2c86ad06cedf9",
    "owner-run/run-l34-reactivation-owner.sh": "4b34fa61e9c084b0b286ade9c60c479e1f63371c80cc7fbfc39d4bcaf6f205d5",
    "owner-run/run-l34-v4-post-l6b-owner.sh": "3fcebce8d1c17cc66c7af81833493db415b3bb19d68f26cd548588f9f3c7e173",
    "owner-run/run-l34-v5-post-l6b-degraded-owner.sh": "8e75ae835ec0850d28e6beea4aa7bdb4af9f742f5fac9017f01873aec376552c",
    "owner-run/run-l34-v6-stale-broker-ap-down-owner.sh": "98bfc8dddef8a99a0e0b8b44f31b9e0a526560c88f68fe422e60dc736adf9f59",
}
AUTHORITATIVE_V7_SCOPE = "L3_L4_RUNTIME_REACTIVATION_V7_RADIO_DISABLED_BROKER_CHURN: rfkill and radio on once, one ifname-bound AP up, one dnsmasq start; no broker or Core control, no MQTT/ESP32/L7/L8/Recovery"


def extract_expected_scope(runner_path: Path) -> str:
    match = re.search(r"^EXPECTED_SCOPE='([^']+)'", runner_path.read_text(), re.M)
    assert match is not None, f"EXPECTED_SCOPE not found in {runner_path}"
    return match.group(1)


def _today() -> str:
    return subprocess.run(["date", "+%F"], text=True, capture_output=True, env=dict(os.environ, TZ="Asia/Bangkok"), check=True).stdout.strip()


def _records(tmp_path: Path, scope: str) -> tuple[Path, Path]:
    today = _today()
    ref_file = tmp_path / "owner-ref.txt"
    ref_file.write_text("Owner authorization record reference.\n")
    auth_file = tmp_path / "authorization-L4.txt"
    auth_file.write_text(f"AEGIS_P4_AUTHORIZATION_V1\nstage=L4\ndate={today}\nauthorizer=music\nscope={scope}\nreference=file://{ref_file}\n")
    k3_file = tmp_path / "k3-L4.txt"
    k3_file.write_text(
        f"AEGIS_P4_K3_CONFIRMATION_V2\nstage=L4\ndate={today}\nconfirmed_by=music\n"
        f"confirmation_mode=IDEA3_OWNER_SELF_ATTESTATION\nidea1_window_overlap=NONE_KNOWN\nreference=file://{ref_file}\n"
    )
    return auth_file, k3_file


def _stage_gate(auth_file: Path, k3_file: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["bash", str(STAGE_GATE), "--stage", "L4", "--mode", "live", "--authorization", str(auth_file), "--k3", str(k3_file)],
        text=True, capture_output=True, env=dict(os.environ, TZ="Asia/Bangkok", LC_ALL="C"), check=False,
    )


def test_v7_expected_scope_length_le_200_and_printable_ascii() -> None:
    scope = extract_expected_scope(RUNNER_V7)
    assert scope == AUTHORITATIVE_V7_SCOPE
    raw = scope.encode("ascii")
    assert 1 <= len(raw) <= 200, f"V7 EXPECTED_SCOPE exceeds the global <=200 character limit: {len(raw)}"
    assert all(32 <= b <= 126 for b in raw)


def test_v7_scope_is_distinct_from_v3_v4_v5_v6() -> None:
    scopes = {n: extract_expected_scope(p) for n, p in OTHER_RUNNERS.items()}
    assert AUTHORITATIVE_V7_SCOPE not in scopes.values()
    assert AUTHORITATIVE_V7_SCOPE.startswith("L3_L4_RUNTIME_REACTIVATION_V7_RADIO_DISABLED_BROKER_CHURN:")
    for n in ("V3", "V4", "V5", "V6"):
        assert f"L3_L4_RUNTIME_REACTIVATION_{n}" not in AUTHORITATIVE_V7_SCOPE


def test_v7_scope_passes_real_stage_gate_parser(tmp_path: Path) -> None:
    proc = _stage_gate(*_records(tmp_path, extract_expected_scope(RUNNER_V7)))
    assert proc.returncode == 0, f"stage gate failed:\nstdout:\n{proc.stdout}\nstderr:\n{proc.stderr}"
    assert "AUTHORIZATION_RECORD=VALID" in proc.stdout and "K3_CONFIRMATION=VALID" in proc.stdout and "STAGE_GATE=PASS_SIMULATION" in proc.stdout


def test_overlong_v7_scope_fails_real_stage_gate_parser(tmp_path: Path) -> None:
    prefix = "L3_L4_RUNTIME_REACTIVATION_V7_RADIO_DISABLED_BROKER_CHURN: "
    scope = prefix + "x" * (201 - len(prefix))
    proc = _stage_gate(*_records(tmp_path, scope))
    assert proc.returncode == 1 and "AUTHORIZATION_RECORD=INVALID" in proc.stdout and "STAGE_GATE=FAIL" in proc.stdout


def test_v7_owner_run_freeze_auth_and_one_attempt_semantics() -> None:
    text = RUNNER_V7.read_text()
    assert "EXPECTED_MAIN=PIN_MAIN_SHA" in text
    assert 'grep -qxF "scope=$EXPECTED_SCOPE" "$AUTH_DIR/authorization-L4.txt"' in text
    assert '[ ! -e "$AUTH_DIR/L34-V7-REACTIVATION-ATTEMPT-CONSUMED" ]' in text
    assert 'marker="$AUTH_DIR/L34-V7-REACTIVATION-ATTEMPT-CONSUMED"' in text
    assert 'p4-stage-gate.sh" --stage L4 --mode live' in text
    assert "set -o noclobber" in text
    assert "K3_CONFIRMATION=VALID" in text and "AUTHORIZATION_RECORD=VALID" in text
    assert 'git -C "$REPO" status --porcelain' in text and 'rev-parse origin/main' in text
    assert 'sudo -v' in text and '[ "$(id -u)" != 0 ]' in text


def test_v7_consume_order_is_pre_gates_then_preflight_then_pre_capture_then_consume_then_one_apply() -> None:  # F1
    lines = [l for l in RUNNER_V7.read_text().splitlines() if not l.lstrip().startswith("#")]

    def at(pattern: str) -> int:
        hits = [i for i, l in enumerate(lines) if re.search(pattern, l)]
        assert hits, pattern
        return hits[0]

    i_gate = at(r"one or more pre-gates failed")
    i_con = at(r"set -o noclobber")
    i_pre = at(r'handler apply\.sh "\$PREFLIGHT_WORK"')
    i_cap = at(r'capture PRE "\$EVID/pre-root"')
    i_mut = at(r"MUTATED=1")
    i_app = at(r"apply_rc=0; apply_out=\$\(handler apply\.sh")
    assert i_gate < i_pre < i_cap < i_con < i_mut <= i_app, "the one-shot authorization is consumed only after preflight and PRE capture"
    assert len([l for l in lines if "set -o noclobber" in l]) == 1
    assert len([l for l in lines if re.search(r'handler apply\.sh(?! "\$PREFLIGHT_WORK")', l)]) == 1, "exactly one apply invocation: never a retry"
    assert not any("rollback_flow" in l and "() {" not in l for l in lines[:i_con])


@pytest.mark.parametrize("rel", sorted(V1_V6_PINS))
def test_v1_to_v6_files_are_byte_identical(rel: str) -> None:
    got = hashlib.sha256((DEPLOY / rel).read_bytes()).hexdigest()
    assert got == V1_V6_PINS[rel], f"{rel} changed: V7 must not modify any V1–V6 handler, allow file or runner"


def test_shared_gate_library_was_only_appended_to() -> None:
    text = LIB.read_text()
    assert text.count(V7_MARKER) == 1
    prefix, v7 = text.split(V7_MARKER, 1)
    assert hashlib.sha256((prefix.rstrip("\n") + "\n").encode()).hexdigest() == LIB_PRE_V7_SHA256
    assert not re.search(r"^l34_(?!v7_)\w+\(\)", v7, re.M), "V7 adds only l34_v7_* functions"
    for d in ("l34", "l34-v4-post-l6b", "l34-v5-post-l6b-degraded", "l34-v6-stale-broker-ap-down"):
        assert "l34_v7_" not in "".join(p.read_text() for p in (DEPLOY / "reactivation" / d).glob("*.sh"))


def test_v7_file_set_is_exactly_the_frozen_set() -> None:
    assert sorted(p.name for p in HND.iterdir()) == ["allow-keys-rollback.txt", "allow-keys.txt", "allow-listeners.txt", "apply.sh", "rollback.sh", "verify.sh"]
    assert RUNNER_V7.is_file()
    assert (ROOT / "docs" / "superpowers" / "specs" / "2026-10-01-idea3-pr11-phase4-l34-v7-radio-disabled-broker-churn-design.md").is_file()


def _keys(path: Path) -> list[str]:
    return [l.strip() for l in path.read_text().splitlines() if l.strip() and not l.lstrip().startswith("#")]


def test_v7_allow_files_never_approve_persistent_artifacts_plaintext_1883_or_core() -> None:
    for name in ("allow-keys.txt", "allow-keys-rollback.txt", "allow-listeners.txt"):
        for key in _keys(HND / name):
            assert not re.search(r"^(nm\.profile|net\.idea3_dnsmasq_conf|fw\.idea3_nft)", key), (name, key)
            assert "1883" not in key and "aegis-idea3-core" not in key, (name, key)
            assert not re.search(r"(LoadState|UnitFileState)$", key), (name, key)
            assert "*" not in key, (name, key)


def test_v7_listener_catalog_is_exactly_the_five_approved_listeners() -> None:
    assert sorted(_keys(HND / "allow-listeners.txt")) == sorted([
        "listen.udp.0.0.0.0%<AEGIS_AP_INTERFACE>:67", "listen.tcp.<AEGIS_AP_ADDRESS>:53", "listen.udp.<AEGIS_AP_ADDRESS>:53",
        "listen.tcp.127.0.0.1:8883", "listen.tcp.<AEGIS_AP_ADDRESS>:8883",
    ])


def test_original_l34_owner_runner_was_not_weakened() -> None:
    text = OTHER_RUNNERS["v3"].read_text()
    assert 'gate "L6b broker is not inactive (L6b must not have started)"' in text
    assert 'gate "an 8883 listener exists (L6b must not have started)"' in text
