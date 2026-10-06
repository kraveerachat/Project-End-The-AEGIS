# shellcheck shell=bash disable=SC1091
"""AEGIS IDEA3 PR11 Phase 4 — V8 (post-V7 persistent AP recovery) authorization scope, one-shot governance and V1–V7 non-regression pins.

Proves:
1. V8 EXPECTED_SCOPE is <=200 printable-ASCII characters (global stage-gate contract), distinct from V3–V7, and passes the REAL p4-stage-gate.sh; a V7 scope
   does not satisfy the V8 runner (covered in the owner-run flow test).
2. Owner-run freeze/auth/one-attempt semantics: the V8 runner is inert in the repository (PIN_MAIN_SHA), uses its OWN marker, and its consume order is
   preflight -> PRE capture -> consume -> apply (once), with no retry after consume.
3. NOTHING in V1–V7 changed: every V1–V7 handler, allow file and owner runner, the shared V1–V7 gate library, the stage gate and the comparator/capture are
   byte-identical to main a4b48cde (V8 adds a NEW library file instead of touching them), and the three V7 receipts are unchanged (V7's live result is immutable).
4. The V8 file set is exactly the frozen set; its allow files approve exactly ONE persistent-artifact key (the AP profile metadata) and never plaintext 1883,
   Core, an rfkill/NetworkManager state file or any wildcard.
5. Exactly one V8 repository receipt exists and it states the V7-immutability and K12 non-claims.
Pure repository test: no live commands, no Production mutation, no authorization or K3 is created.
"""

from __future__ import annotations

import hashlib
import os
import re
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))
import test_pr11_phase4_l34_v7_scope_contract as v7c  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT.parent
DEPLOY = ROOT / "deploy" / "pr11-phase4"
HND = DEPLOY / "reactivation" / "l34-v8-post-v7-persistent-ap-recovery"
RUNNER_V8 = DEPLOY / "owner-run" / "run-l34-v8-post-v7-persistent-ap-recovery-owner.sh"
V8_LIB = DEPLOY / "p4-l34-v8-lib.sh"
STAGE_GATE = DEPLOY / "p4-stage-gate.sh"
LOGS = REPO / "Obsidian_AEGIS_Vault" / "AEGIS_Knowledge" / "90-Status" / "logs"
SPEC = ROOT / "docs" / "superpowers" / "specs" / "2026-10-02-idea3-pr11-phase4-l34-v8-post-v7-persistent-ap-recovery-design.md"
AUTHORITATIVE_V8_SCOPE = (
    "L3_L4_RUNTIME_RECOVERY_V8_POST_V7_PERSISTENT_AP: rfkill and radio on once, AP profile autoconnect no->yes once, one ifname-bound AP up, "
    "one dnsmasq start; no broker or Core control"
)
PERSISTENT_KEY = "nm.profile./etc/NetworkManager/system-connections/aegis-idea3-ap.nmconnection.meta"

# sha256 of every V7 handler / allow file / owner runner and of the shared V1–V7 gate library, the stage gate, the registry, the comparator and the capture at
# main a4b48cde. V8 must not modify them; a deliberate future change must update these pins.
V7_AND_SHARED_PINS = {
    "reactivation/l34-v7-radio-disabled-broker-churn/allow-keys-rollback.txt": "7e76838ae3464951ec95370530f60f9912525c26525b259428768f4d1e73418b",
    "reactivation/l34-v7-radio-disabled-broker-churn/allow-keys.txt": "86e50f5f80057973908b39e521feed3f38bde49d3f08b2ae9bea162cd0f67770",
    "reactivation/l34-v7-radio-disabled-broker-churn/allow-listeners.txt": "8b5400f0e92b258fbf31f6c1d0fc4fd76ecc6d781f74aa9bad451d8e4546ef5d",
    "reactivation/l34-v7-radio-disabled-broker-churn/apply.sh": "6e19f998e956d0923df3cfb1df97084ac7dc346ab6b8e805b20dcd46a9702ebe",
    "reactivation/l34-v7-radio-disabled-broker-churn/rollback.sh": "3d1f506b2fbb39c50f28e54a2025691c77ab153ae6f8d989e3eea99e084d07a5",
    "reactivation/l34-v7-radio-disabled-broker-churn/verify.sh": "5d190aff25cf9258886e55f91b26c7ff9c89d8c75855fd1ca0b5614b0140678d",
    "owner-run/run-l34-v7-radio-disabled-broker-churn-owner.sh": "c0b072c226b8e89b2b4cac5aed4062ecf717aa7251e816b7362d0b453163ec71",
    # AMENDED (PR #305, owner-approved re-pin): only l34_dnsmasq_unit_gate + new l34_render_dnsmasq_unit changed (rendered-template authority). Pre-amendment pin b6e1d0d956c08fb87dea4733c569ae718ebf9a0321d4a8084f7c190a80bd3370.
    "p4-l34-reactivation-lib.sh": "08dd7de16cbc57a43b79f35f11e7b1dff011b29dffca5ddeef478f3524621a37",
    # re-pinned by the governed F1 detector install/start stage task (2026-10-04): stage F1 registered (p4-lib.sh) + its no-extra-field authorization rule (p4-stage-gate.sh).
    # re-pinned by the F1u post-F1 Core upgrade stage task (2026-10-05): p4-lib.sh registers stage F1u (after F1, before L8; no repository gap), p4-stage-gate.sh binds F1u to the no-extra-field rule,
    # p4-compare.sh accepts the label `stage F1u` for the relational one-release catalog allowance, p4-l0-capture.sh additionally records the detector unit (state + unit file) and the running Core/detector release identity (cwd).
    # re-pinned by the F1i post-L7 repaired-release install stage task (2026-10-04): p4-lib.sh registers stage F1i (after L8p, before F1r; no repository gap), p4-stage-gate.sh binds F1i
    # to the same no-extra-field authorization rule, and p4-compare.sh adds the label `stage F1i` to the existing RELATIONAL one-release catalog allowance (behavior unchanged:
    # every release already present must stay byte-identical, exactly one named id may be added). No other stage, gate or record rule changed.
    # re-pinned by the Recovery R2-R8 stage task (2026-10-06): p4-stage-gate.sh binds Recovery to the no-extra-field rule.
    "p4-stage-gate.sh": "352aeea2400d109fe235b8888250d1f91ab7e8f8a8cb44b8c4b5ec9d19093480",
    # re-pinned by the owner-approved R1B successor stage registration (2026-10-06): p4-lib.sh registers stage R1B after the historical R1A (no repository gap) and updates the documented stage order;
    # re-pinned again by the R1Du/R1D historical-disposition task (2026-10-06): p4-lib.sh registers R1Du and R1D between R1A and R1B, p4-stage-gate.sh binds both to the no-extra-field rule and p4-compare.sh accepts the label `stage R1Du`.
    # re-pinned by the Recovery R2-R8 stage task (2026-10-06): p4-lib.sh registers the one Recovery stage after R1Bv and before L8 (no repository gap).
    "p4-lib.sh": "0e4017fe2c168f2adafcb72c8070961cca1a41171a058e78a22bd9eb57b8297c",
    "p4-compare.sh": "75d0a0dc0e4d529ed39bf2929cd3c54a9ef7a8a4eb8d643725af1d61862f6294",
    "p4-l0-capture.sh": "e5d82dc5959dbcd1aa13ca0d58aa15ed5375a77e918be9a1ec2a8a2ac740a61b",
}
V7_RECEIPT_PINS = {
    "2026-10-01_061747_music_idea3-l34-v7-radio-disabled-broker-churn.md": "8afd6eb96aead14598cd57299090ef01988d89643ed93ea2598467fe70873a06",
    "2026-10-01_081532_music_idea3-l34-v7-prelive-hardening.md": "76d0f7f2991899993d0fbedaffdaf760c3bb9bc31f1cc87f432cae5c388c249b",
    "2026-10-01_172529_music_idea3-l34-v7-python-path-forwarding.md": "df446c8c1f2ab26a03848d28463de6951111dedc27029fc30a82187afe3aa024",
}


def extract_expected_scope(path: Path) -> str:
    return v7c.extract_expected_scope(path)


def test_v8_expected_scope_length_le_200_and_printable_ascii() -> None:
    scope = extract_expected_scope(RUNNER_V8)
    assert scope == AUTHORITATIVE_V8_SCOPE
    raw = scope.encode("ascii")
    assert 1 <= len(raw) <= 200, f"V8 EXPECTED_SCOPE exceeds the global <=200 character limit: {len(raw)}"
    assert all(32 <= b <= 126 for b in raw)


def test_v8_scope_is_distinct_from_v3_to_v7() -> None:
    scopes = {n: extract_expected_scope(p) for n, p in v7c.OTHER_RUNNERS.items()}
    scopes["v7"] = extract_expected_scope(v7c.RUNNER_V7)
    assert AUTHORITATIVE_V8_SCOPE not in scopes.values()
    assert AUTHORITATIVE_V8_SCOPE.startswith("L3_L4_RUNTIME_RECOVERY_V8_POST_V7_PERSISTENT_AP:")
    for n in ("V3", "V4", "V5", "V6", "V7"):
        assert f"L3_L4_RUNTIME_REACTIVATION_{n}" not in AUTHORITATIVE_V8_SCOPE


def test_v8_scope_passes_real_stage_gate_parser(tmp_path: Path) -> None:
    proc = v7c._stage_gate(*v7c._records(tmp_path, extract_expected_scope(RUNNER_V8)))
    assert proc.returncode == 0, f"stage gate failed:\nstdout:\n{proc.stdout}\nstderr:\n{proc.stderr}"
    assert "AUTHORIZATION_RECORD=VALID" in proc.stdout and "K3_CONFIRMATION=VALID" in proc.stdout and "STAGE_GATE=PASS_SIMULATION" in proc.stdout


def test_overlong_v8_scope_fails_real_stage_gate_parser(tmp_path: Path) -> None:
    prefix = "L3_L4_RUNTIME_RECOVERY_V8_POST_V7_PERSISTENT_AP: "
    proc = v7c._stage_gate(*v7c._records(tmp_path, prefix + "x" * (201 - len(prefix))))
    assert proc.returncode == 1 and "AUTHORIZATION_RECORD=INVALID" in proc.stdout and "STAGE_GATE=FAIL" in proc.stdout


def test_v8_owner_run_freeze_auth_and_one_attempt_semantics() -> None:
    text = RUNNER_V8.read_text()
    assert "EXPECTED_MAIN=PIN_MAIN_SHA" in text and "runner is not pinned" in text
    assert 'grep -qxF "scope=$EXPECTED_SCOPE" "$AUTH_DIR/authorization-L4.txt"' in text
    assert '[ ! -e "$AUTH_DIR/L34-V8-REACTIVATION-ATTEMPT-CONSUMED" ]' in text
    assert 'marker="$AUTH_DIR/L34-V8-REACTIVATION-ATTEMPT-CONSUMED"' in text
    assert 'p4-stage-gate.sh" --stage L4 --mode live' in text
    assert "set -o noclobber" in text
    assert "K3_CONFIRMATION=VALID" in text and "AUTHORIZATION_RECORD=VALID" in text
    assert 'git -C "$REPO" status --porcelain' in text and "rev-parse origin/main" in text
    assert "sudo -v" in text and '[ "$(id -u)" != 0 ]' in text
    assert "L34-V7-REACTIVATION-ATTEMPT-CONSUMED" in text and "historical V7 attempt marker" in text, "a V7 marker in AUTH_DIR is refused, never reused"
    assert 'REPO=/home/kittipat/Workspace/IDEA3-Cyber-Last/worktrees/Project-End-The-AEGIS-L34V8LIVE' in text, "its own future pinned execution worktree, not a V7 one"


def test_v8_consume_order_is_pre_gates_then_preflight_then_pre_capture_then_consume_then_one_apply() -> None:
    lines = [l for l in RUNNER_V8.read_text().splitlines() if not l.lstrip().startswith("#")]

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
    assert i_gate < i_pre < i_cap < i_con < i_mut <= i_app, "marker is consumed only after preflight and PRE capture and BEFORE the first mutation"
    assert len([l for l in lines if "set -o noclobber" in l]) == 1
    assert len([l for l in lines if re.search(r'handler apply\.sh(?! "\$PREFLIGHT_WORK")', l)]) == 1, "exactly one apply invocation: never a retry"
    assert not any("rollback_flow" in l and "() {" not in l for l in lines[:i_con]), "no rollback path exists before the attempt is consumed"


@pytest.mark.parametrize("rel", sorted(v7c.V1_V6_PINS))
def test_v1_to_v6_files_are_still_byte_identical(rel: str) -> None:
    assert hashlib.sha256((DEPLOY / rel).read_bytes()).hexdigest() == v7c.V1_V6_PINS[rel], f"{rel} changed: V8 must not modify V1–V6"


@pytest.mark.parametrize("rel", sorted(V7_AND_SHARED_PINS))
def test_v7_and_shared_gate_files_are_byte_identical(rel: str) -> None:
    assert hashlib.sha256((DEPLOY / rel).read_bytes()).hexdigest() == V7_AND_SHARED_PINS[rel], f"{rel} changed: V8 must not modify V7 or the shared gates"


@pytest.mark.parametrize("name", sorted(V7_RECEIPT_PINS))
def test_v7_receipts_are_immutable(name: str) -> None:
    assert hashlib.sha256((LOGS / name).read_bytes()).hexdigest() == V7_RECEIPT_PINS[name]


def test_v8_adds_a_new_library_instead_of_touching_the_shared_one() -> None:
    lib = (DEPLOY / "p4-l34-reactivation-lib.sh").read_text()
    assert "l34_v8_" not in lib and "L34_V8_" not in lib
    names = re.findall(r"^(l34_v8_[a-z_0-9]+)\(\)", V8_LIB.read_text(), re.M)
    assert names, "V8 functions live in their own file"
    assert not re.findall(r"^l34_(?!v8_)\w+\(\)", V8_LIB.read_text(), re.M), "the V8 library defines only l34_v8_* functions"
    for d in ("l34", "l34-v4-post-l6b", "l34-v5-post-l6b-degraded", "l34-v6-stale-broker-ap-down", "l34-v7-radio-disabled-broker-churn"):
        assert "l34_v8_" not in "".join(p.read_text() for p in (DEPLOY / "reactivation" / d).glob("*.sh"))


def test_v8_file_set_is_exactly_the_frozen_set() -> None:
    assert sorted(p.name for p in HND.iterdir()) == ["allow-keys-rollback.txt", "allow-keys.txt", "allow-listeners.txt", "apply.sh", "rollback.sh", "verify.sh"]
    assert RUNNER_V8.is_file() and V8_LIB.is_file() and SPEC.is_file()


def _keys(path: Path) -> list[str]:
    return [l.strip() for l in path.read_text().splitlines() if l.strip() and not l.lstrip().startswith("#")]


def test_v8_allow_files_approve_exactly_one_persistent_artifact_key_and_nothing_wider() -> None:
    for name in ("allow-keys.txt", "allow-keys-rollback.txt"):
        keys = _keys(HND / name)
        persistent = [k for k in keys if re.match(r"^(nm\.profile|net\.idea3_dnsmasq_conf|fw\.idea3_nft)", k)]
        assert persistent == [PERSISTENT_KEY], (name, persistent)
        assert len(keys) == len(set(keys))
        for key in keys:
            assert "1883" not in key and "aegis-idea3-core" not in key and "*" not in key, (name, key)
            assert not re.search(r"(LoadState|UnitFileState)$", key), (name, key)
            assert "rfkill" not in key.replace("wifi.rfkill.iface.wlp0s20f3.soft", "") and "NetworkManager.state" not in key, (name, key)
    assert not any(k.endswith(".class") for k in _keys(HND / "allow-keys.txt")), "the profile CLASS key is never approved"


def test_v8_listener_catalog_is_exactly_the_five_approved_listeners() -> None:
    assert sorted(_keys(HND / "allow-listeners.txt")) == sorted(_keys(v7c.HND / "allow-listeners.txt"))
    assert len(_keys(HND / "allow-listeners.txt")) == 5


def test_v8_runner_only_selects_stage_l4_and_the_v8_handlers() -> None:
    text = RUNNER_V8.read_text()
    for forbidden in ("--stage L7u", "--stage L8", "stages/L7u", "run-l7u-owner", "l34-v7-radio-disabled-broker-churn/", "AEGIS_L7U_"):
        assert forbidden not in text, forbidden


def test_exactly_one_v8_receipt_exists_and_states_the_non_claims() -> None:
    receipts = sorted(LOGS.glob("*_music_idea3-l34-v8-*.md"))
    assert len(receipts) == 1, receipts
    text = receipts[0].read_text()
    assert "K12_AUTOMATIC_REBOOT_PERSISTENCE=NOT_PROVEN" in text or "K12" in text
    assert "V7 historical live result remains immutable" in text
    assert "OD-L34-V8-01" in text and "status:" in text
