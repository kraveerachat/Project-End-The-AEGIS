# shellcheck shell=bash disable=SC1091
"""AEGIS IDEA3 PR11 Phase 4 — V6 authorization scope, stage-gate contract and V1–V5 non-regression pins.

Proves:
1. V6 EXPECTED_SCOPE is <=200 printable-ASCII characters (global stage-gate contract) and distinct from V3/V4/V5.
2. A real AEGIS_P4_AUTHORIZATION_V1 record using the exact V6 scope passes the REAL p4-stage-gate.sh for stage L4 with a valid K3
   fixture; an overlong scope fails it.
3. Owner-run freeze/auth/one-attempt semantics are present and V6's consume ordering is the frozen one.
4. NOTHING in V1–V5 changed: every V1–V5 handler, allow file and runner is byte-identical to the PR #250/#251 main it was reviewed
   at, and the shared gate library's pre-V6 part is byte-identical (V6 only APPENDED functions).
5. The V6 file set is exactly the frozen file set. Pure repository test: no live commands, no Production mutation.
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
RUNNER_V6 = DEPLOY / "owner-run" / "run-l34-v6-stale-broker-ap-down-owner.sh"
RUNNER_V5 = DEPLOY / "owner-run" / "run-l34-v5-post-l6b-degraded-owner.sh"
RUNNER_V4 = DEPLOY / "owner-run" / "run-l34-v4-post-l6b-owner.sh"
RUNNER_V3 = DEPLOY / "owner-run" / "run-l34-reactivation-owner.sh"
STAGE_GATE = DEPLOY / "p4-stage-gate.sh"
LIB = DEPLOY / "p4-l34-reactivation-lib.sh"
# The exact, frozen V6 authorization scope (authoritative; the owner runner must carry precisely this ASCII string).
AUTHORITATIVE_V6_SCOPE = (
    "L3_L4_RUNTIME_REACTIVATION_V6_STALE_BROKER_AP_DOWN: one AP up, one dnsmasq start, one TLS handshake probe; no broker control, no nft/forwarding, no IDEA1/IDEA2 change, no MQTT/ESP32/L6c/L7"
)
V6_MARKER = "# ── V6 (STALE-BROKER / AP-DOWN) reactivation"
# sha256 of the shared gate library as merged in PR #250/#251 (main a888457e): V6 may only append after V6_MARKER.
LIB_PRE_V6_SHA256 = "1adb7a803dc3652070ce7ac88b6f28e5dbd97cf68e825381caacd282dcb8716c"

# sha256 of every V1–V5 handler / allow file / owner runner at main a888457e. A deliberate future V1–V5 change must update this pin.
V1_V5_PINS = {
    "reactivation/l34/apply.sh": "1f6ffdb6b097d6af7a1dfd8ffe57ee0a868548b7d2901b1ad2e8be78ded328d1",
    "reactivation/l34/rollback.sh": "f785577d627f01068a0c839e2db8539bd05a207a23f74548ab1ab57d2a9668ae",
    "reactivation/l34/verify.sh": "ddf061fe51254bc511d1af5565e95ec40f2e054f823d62d50f7a64d0bbec1ccf",
    "reactivation/l34/allow-dynamic-transitions-rollback.txt": "0768b4c5aa08f67e28fc8da7f39162d7023ec95b0f6b23e79f9740fa7500f18c",
    "reactivation/l34/allow-dynamic-transitions.txt": "e8b2e030fdf8ecd3ad6ca1b8134073375f1711f0744a783b944f0d24910eeedf",
    "reactivation/l34/allow-dynamic-transitions-v3-post-fresh.txt": "7487c9cdf2f0306950b31ce4fd5fb60ca4fa590a984ade5721a54772dbbf1115",
    "reactivation/l34/allow-dynamic-transitions-v3-post-residual.txt": "662eccb7e84bec9d29c1a5b72e0a80cb6cb91003dd8ea29a3bd8e59fa6ea5f09",
    "reactivation/l34/allow-dynamic-transitions-v3-rollback-fresh.txt": "409fcc535344a672e7af6af42b43c2b8c903a90081a9a8a409ec0aaf6c67ed80",
    "reactivation/l34/allow-dynamic-transitions-v3-rollback-residual.txt": "3a3c407dde4f8874410f220a8e36d9776bd48dc93cf0cc38bab8a1491b4055d8",
    "reactivation/l34/allow-keys-rollback.txt": "0eb11afd9a672b88f9fdf06ae360134e034c983ee2e30884f6e138901a8fd8bc",
    "reactivation/l34/allow-keys.txt": "169edfc01ce8fa00bdb7bd36a2c2f0d56f23006a1bacf41806513cc6c6f5b940",
    "reactivation/l34/allow-listeners.txt": "06371f4dacdc7105ed11a20e987219106de96ee67e1a42a30c17abd6e30a953d",
    "reactivation/l34/allow-transitions.txt": "98208caac4e7bf856581f8fea06939e885b4b24f0b8455a5110f036e84c005df",
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
    "owner-run/run-l34-reactivation-owner.sh": "4b34fa61e9c084b0b286ade9c60c479e1f63371c80cc7fbfc39d4bcaf6f205d5",
    "owner-run/run-l34-v4-post-l6b-owner.sh": "3fcebce8d1c17cc66c7af81833493db415b3bb19d68f26cd548588f9f3c7e173",
    "owner-run/run-l34-v5-post-l6b-degraded-owner.sh": "8e75ae835ec0850d28e6beea4aa7bdb4af9f742f5fac9017f01873aec376552c",
}


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
    auth_file.write_text(
        f"AEGIS_P4_AUTHORIZATION_V1\nstage=L4\ndate={today}\nauthorizer=music\nscope={scope}\nreference=file://{ref_file}\n"
    )
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


def test_v6_expected_scope_length_le_200_and_printable_ascii() -> None:
    assert extract_expected_scope(RUNNER_V6) == AUTHORITATIVE_V6_SCOPE
    raw = extract_expected_scope(RUNNER_V6).encode("ascii")
    assert 1 <= len(raw) <= 200, f"V6 EXPECTED_SCOPE exceeds the global <=200 character limit: {len(raw)}"
    assert all(32 <= b <= 126 for b in raw)


def test_v6_scope_is_distinct_from_v3_v4_v5() -> None:
    scopes = {n: extract_expected_scope(p) for n, p in (("v3", RUNNER_V3), ("v4", RUNNER_V4), ("v5", RUNNER_V5), ("v6", RUNNER_V6))}
    assert len(set(scopes.values())) == 4
    v6 = scopes["v6"]
    assert v6.startswith("L3_L4_RUNTIME_REACTIVATION_V6_STALE_BROKER_AP_DOWN:")
    for other in ("L3_L4_RUNTIME_REACTIVATION_V3", "L3_L4_RUNTIME_REACTIVATION_V4", "L3_L4_RUNTIME_REACTIVATION_V5"):
        assert other not in v6
    assert v6 == AUTHORITATIVE_V6_SCOPE


def test_v6_scope_passes_real_stage_gate_parser(tmp_path: Path) -> None:
    proc = _stage_gate(*_records(tmp_path, extract_expected_scope(RUNNER_V6)))
    assert proc.returncode == 0, f"stage gate failed:\nstdout:\n{proc.stdout}\nstderr:\n{proc.stderr}"
    assert "AUTHORIZATION_RECORD=VALID" in proc.stdout and "K3_CONFIRMATION=VALID" in proc.stdout
    assert "STAGE_GATE=PASS_SIMULATION" in proc.stdout


def test_overlong_v6_scope_fails_real_stage_gate_parser(tmp_path: Path) -> None:
    prefix = "L3_L4_RUNTIME_REACTIVATION_V6_STALE_BROKER_AP_DOWN: "
    scope = prefix + "x" * (201 - len(prefix))
    assert len(scope) == 201
    proc = _stage_gate(*_records(tmp_path, scope))
    assert proc.returncode == 1
    assert "GATE_FAIL AUTHORIZATION_MALFORMED" in proc.stdout and "AUTHORIZATION_RECORD=INVALID" in proc.stdout and "STAGE_GATE=FAIL" in proc.stdout


def test_v3_and_v5_scopes_still_pass_the_real_stage_gate(tmp_path: Path) -> None:
    # V4's committed scope predates the <=200 limit (that is why V5 added its scope contract); it is pinned unchanged below, not re-litigated here.
    for i, runner in enumerate((RUNNER_V3, RUNNER_V5)):
        d = tmp_path / str(i)
        d.mkdir()
        proc = _stage_gate(*_records(d, extract_expected_scope(runner)))
        assert proc.returncode == 0 and "AUTHORIZATION_RECORD=VALID" in proc.stdout


def test_v6_owner_run_freeze_auth_and_one_attempt_semantics() -> None:
    text = RUNNER_V6.read_text()
    assert "EXPECTED_MAIN=PIN_MAIN_SHA" in text
    assert 'grep -qxF "scope=$EXPECTED_SCOPE" "$AUTH_DIR/authorization-L4.txt"' in text
    assert '[ ! -e "$AUTH_DIR/L34-V6-REACTIVATION-ATTEMPT-CONSUMED" ]' in text
    assert 'MARKER="$AUTH_DIR/L34-V6-REACTIVATION-ATTEMPT-CONSUMED"' in text
    assert 'p4-stage-gate.sh" --stage L4 --mode live' in text
    assert "set -o noclobber" in text  # atomic create-if-absent


def test_v6_consume_order_is_preflight_then_pre_capture_then_tuple_equality_then_consume_then_apply() -> None:
    lines = [l for l in RUNNER_V6.read_text().splitlines() if not l.lstrip().startswith("#")]
    def at(pattern: str) -> int:
        hits = [i for i, l in enumerate(lines) if re.search(pattern, l)]
        assert hits, pattern
        return hits[0]
    i_pre = at(r"handler apply\.sh \"\$PREFLIGHT_WORK\"")
    i_cap = at(r"capture PRE \"\$EVID/pre-root\"")
    i_tup = at(r"broker_unchanged \"\$PREFLIGHT_WORK/broker-tuple-pre\.txt\" \|\| die")
    i_con = at(r"set -o noclobber")
    i_mut = at(r"MUTATED=1")
    i_app = at(r"apply_rc=0; apply_out=\$\(handler apply\.sh")
    assert i_pre < i_cap < i_tup < i_con < i_mut <= i_app
    assert len([l for l in lines if "set -o noclobber" in l]) == 1
    # every failure before the marker is a plain `die` (nothing changed, attempt NOT consumed); none is a rollback
    assert not any("rollback_flow" in l and "() {" not in l for l in lines[:i_con])
    # exactly one apply invocation: the runner never retries
    assert len([l for l in lines if re.search(r"handler apply\.sh(?! \"\$PREFLIGHT_WORK\")", l)]) == 1


@pytest.mark.parametrize("rel", sorted(V1_V5_PINS))
def test_v1_to_v5_files_are_byte_identical(rel: str) -> None:
    got = hashlib.sha256((DEPLOY / rel).read_bytes()).hexdigest()
    assert got == V1_V5_PINS[rel], f"{rel} changed: V6 must not modify any V1–V5 handler, allow file or runner"


def test_shared_gate_library_was_only_appended_to() -> None:
    text = LIB.read_text()
    assert text.count(V6_MARKER) == 1
    prefix = text.split(V6_MARKER, 1)[0]
    assert hashlib.sha256((prefix.rstrip("\n") + "\n").encode()).hexdigest() == LIB_PRE_V6_SHA256
    v6 = text.split(V6_MARKER, 1)[1]
    assert not re.search(r"^l34_(?!v6_)\w+\(\)", v6, re.M), "V6 adds only l34_v6_* functions"
    for script in (DEPLOY / "reactivation" / d for d in ("l34", "l34-v4-post-l6b", "l34-v5-post-l6b-degraded")):
        assert "l34_v6_" not in "".join(p.read_text() for p in script.glob("*.sh"))


def test_v6_file_set_is_exactly_the_frozen_set() -> None:
    hnd = DEPLOY / "reactivation" / "l34-v6-stale-broker-ap-down"
    assert sorted(p.name for p in hnd.iterdir()) == ["allow-keys.txt", "allow-listeners.txt", "apply.sh", "rollback.sh", "verify.sh"]
    assert RUNNER_V6.is_file()
    assert (ROOT / "docs" / "superpowers" / "specs" / "2026-09-29-idea3-pr11-phase4-l34-v6-stale-broker-ap-down-design.md").is_file()


def test_probe_script_is_reused_unchanged() -> None:
    probe = DEPLOY / "p4-l7-broker-probe.py"
    text = probe.read_text()
    assert "L7_BROKER_TLS_PROBE=PASS" in text and "build_mqtt_ssl_context" in text
    assert "--repo-root" in text  # the probe requires it, so V6 passes it (documented in the design spec)
