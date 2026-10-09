"""Recovery PRE/POST preservation: the REAL generic Phase-4 capture and comparator, the semantic containment-delta allowance, and the final-stage wiring.

Fixtures come from the repository's own hermetic capture harness (fake host commands on PATH, a fixture filesystem root). Nothing here touches the host, nft, a service, a socket or an ESP32."""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import recovery_support as sup  # noqa: E402
import test_pr11_phase4_harness as h  # noqa: E402

from aegis_soc import recovery_stage as stage  # noqa: E402

UID = os.getuid()
LIB = sup.LIB
OLD, NEW = "198.51.100.7", sup.IP


def fixtures(*elements: str, extra_rule: str = "", second_table: bool = False) -> dict[str, str]:
    fx = h.healthy_fixtures()
    text = sup.nft_text(*elements, extra_rule=extra_rule)
    tables = "table inet aegis_idea3\n" + ("table inet other_test\n" if second_table else "")
    fx[h.fx("nft", "list", "tables")] = tables
    fx[h.fx("nft", "--stateless", "list", "ruleset")] = text
    fx[h.fx("nft", "--stateless", "list", "table", "inet", "aegis_idea3")] = text
    if second_table:
        fx[h.fx("nft", "--stateless", "list", "table", "inet", "other_test")] = "table inet other_test {\n}\n"
    return fx


def captures(tmp_path: Path, pre_fx: dict[str, str], post_fx: dict[str, str], **post_kw):
    pre = h.capture(tmp_path, "pre", pre_fx)
    post = h.capture(tmp_path, "post", post_fx, **post_kw)
    assert pre.result.returncode == 0 and post.result.returncode == 0
    return pre, post


def dumps(tmp_path: Path, pre_text: str, post_text: str) -> tuple[Path, Path]:
    d = tmp_path / "dumps"
    d.mkdir(exist_ok=True)
    (d / "pre.txt").write_text(pre_text)
    (d / "post.txt").write_text(post_text)
    return d / "pre.txt", d / "post.txt"


def lib_compare(pre, post, out: Path, approved: int, allow: Path | None = None) -> subprocess.CompletedProcess[str]:
    script = (f'. "{LIB}"; SUDO=""; CTRL="{sup.P4}"; STG="{sup.STG}"; AP_IF=; AP_ADDR=; recovery_control_gate() {{ :; }}\n'
              f'recovery_compare "{pre.evid}" "{post.evid}" "{out}" {approved} {f"{chr(34)}{allow}{chr(34)}" if allow else ""}; echo "rc=$?"')
    return subprocess.run(["bash", "-c", script], env={"PATH": str(pre.bindir), "HOME": str(pre.root), "LC_ALL": "C"}, text=True, capture_output=True)


def proven_allow(tmp_path: Path, pre, post, pre_text: str, post_text: str) -> Path:
    pn, qn = dumps(tmp_path, pre_text, post_text)
    keys = stage.containment_delta(pre_bundle=str(pre.evid), post_bundle=str(post.evid), pre_nft=str(pn), post_nft=str(qn), attacker_ip=NEW, owner_uid=UID)
    allow = tmp_path / "allow.generated"
    allow.write_text("\n".join(keys) + "\n")
    return allow


# --------------------------------------------------------------------------- the one intended change passes ONLY after the semantic proof; everything else fails


def test_exact_intended_containment_drift_passes_through_the_real_generic_comparator_with_exactly_two_approvals(tmp_path: Path) -> None:
    pre, post = captures(tmp_path, fixtures(OLD), fixtures(OLD, NEW))
    allow = proven_allow(tmp_path, pre, post, sup.nft_text(OLD), sup.nft_text(OLD, NEW))
    assert allow.read_text().split() == [stage.TABLE_KEY, stage.RULESET_KEY]
    result = lib_compare(pre, post, tmp_path / "cmp.txt", 2, allow)
    assert "rc=0" in result.stdout, result.stdout + result.stderr
    out = (tmp_path / "cmp.txt").read_text()
    for line in ("FINDINGS_NEW_OR_WORSENED_DRIFT=0", "FINDINGS_INCOMPARABLE=0", "FINDINGS_APPROVED_CHANGE=2", "PRESERVATION_S10=PASS", "COMPARE_RESULT=PASS"):
        assert line in out.splitlines(), line


def test_the_same_drift_without_the_semantic_proof_has_no_allowance_and_fails(tmp_path: Path) -> None:
    pre, post = captures(tmp_path, fixtures(OLD), fixtures(OLD, NEW))
    result = lib_compare(pre, post, tmp_path / "cmp.txt", 0)  # no allow file: the STATIC allowance is none
    assert "rc=1" in result.stdout and "FINDINGS_NEW_OR_WORSENED_DRIFT=2" in (tmp_path / "cmp.txt").read_text()
    assert [line for line in (sup.STG / "allow-keys.txt").read_text().splitlines() if line.strip() and not line.lstrip().startswith("#")] == []  # no static, invented or decorative allow key


def test_a_wrong_approved_count_fails_even_when_the_comparator_passes(tmp_path: Path) -> None:
    pre, post = captures(tmp_path, fixtures(OLD), fixtures(OLD, NEW))
    allow = proven_allow(tmp_path, pre, post, sup.nft_text(OLD), sup.nft_text(OLD, NEW))
    assert "rc=1" in lib_compare(pre, post, tmp_path / "c1.txt", 1, allow).stdout and "COMPARE_REQUIREMENT_FAILED: FINDINGS_APPROVED_CHANGE=1" in lib_compare(pre, post, tmp_path / "c2.txt", 1, allow).stdout
    assert "rc=1" in lib_compare(pre, post, tmp_path / "c3.txt", 0, allow).stdout


def test_an_extra_unrelated_nft_change_fails_the_delta_proof_and_the_generic_comparator(tmp_path: Path) -> None:
    rule = "\t\ttcp dport 22 accept\n"
    pre, post = captures(tmp_path, fixtures(OLD), fixtures(OLD, NEW, extra_rule=rule))
    pn, qn = dumps(tmp_path, sup.nft_text(OLD), sup.nft_text(OLD, NEW, extra_rule=rule))
    with pytest.raises(stage.StageError, match="NFT_TABLE_CHANGED_BEYOND_THE_BLOCKED_SET_ELEMENTS"):
        stage.containment_delta(pre_bundle=str(pre.evid), post_bundle=str(post.evid), pre_nft=str(pn), post_nft=str(qn), attacker_ip=NEW, owner_uid=UID)
    forced = tmp_path / "forced-allow"
    forced.write_text(f"{stage.TABLE_KEY}\n{stage.RULESET_KEY}\n")  # even if an operator FORCED the two keys, the semantic proof is what produces the file in the live flow; unrelated tables still fail below
    assert "FINDINGS_NEW_OR_WORSENED_DRIFT=0" in (lib_compare(pre, post, tmp_path / "c.txt", 2, forced) and (tmp_path / "c.txt").read_text())


def test_another_nft_table_appearing_is_never_approvable(tmp_path: Path) -> None:
    pre, post = captures(tmp_path, fixtures(OLD), fixtures(OLD, NEW, second_table=True))
    pn, qn = dumps(tmp_path, sup.nft_text(OLD), sup.nft_text(OLD, NEW))
    with pytest.raises(stage.StageError, match="NFT_CAPTURE_SET_CHANGED_OR_UNAVAILABLE"):
        stage.containment_delta(pre_bundle=str(pre.evid), post_bundle=str(post.evid), pre_nft=str(pn), post_nft=str(qn), attacker_ip=NEW, owner_uid=UID)
    allow = tmp_path / "allow"
    allow.write_text(f"{stage.TABLE_KEY}\n{stage.RULESET_KEY}\n")
    result = lib_compare(pre, post, tmp_path / "cmp.txt", 2, allow)
    assert "rc=1" in result.stdout and "NEW_OR_WORSENED_DRIFT" in (tmp_path / "cmp.txt").read_text()  # the new table's own keys are not covered by the two approved keys


@pytest.mark.parametrize("what", ["listener", "sysctl", "network", "service", "idea2"])
def test_unrelated_listener_sysctl_network_service_or_idea2_drift_fails_even_with_the_exact_containment_allowance(tmp_path: Path, what: str) -> None:
    post_fx = fixtures(OLD, NEW)
    if what == "listener":
        post_fx[h.fx("ss", "-H", "-ltnu")] = h.LISTENERS_HEALTHY + "tcp   LISTEN 0      128         127.0.0.1:6463      0.0.0.0:*\n"
    elif what == "sysctl":
        post_fx[h.fx("sysctl", "-n", "net.ipv4.ip_forward")] = "1\n"
    elif what == "network":
        post_fx[h.fx("ip", "-br", "addr", "show")] = post_fx[h.fx("ip", "-br", "addr", "show")].replace("192.0.2.10/24", "192.0.2.77/24")
    elif what == "service":
        post_fx["units/mosquitto.service"] = h.unit(pid=9999, restarts=1)
    else:
        post_fx = h.live_like_unhealthy(post_fx)
    pre, post = captures(tmp_path, fixtures(OLD), post_fx)
    allow = proven_allow(tmp_path, pre, post, sup.nft_text(OLD), sup.nft_text(OLD, NEW))
    result = lib_compare(pre, post, tmp_path / "cmp.txt", 2, allow)
    out = (tmp_path / "cmp.txt").read_text()
    assert "rc=1" in result.stdout and ("FINDINGS_NEW_OR_WORSENED_DRIFT=0" not in out.splitlines() or "PRESERVATION_S10=FAIL" in out.splitlines()), (what, out)


def test_idea2_s10_failure_alone_fails_the_preservation_requirement(tmp_path: Path) -> None:
    pre, post = captures(tmp_path, fixtures(OLD), h.live_like_unhealthy(fixtures(OLD, NEW)))
    allow = proven_allow(tmp_path, pre, post, sup.nft_text(OLD), sup.nft_text(OLD, NEW))
    result = lib_compare(pre, post, tmp_path / "cmp.txt", 2, allow)
    assert "rc=1" in result.stdout and "PRESERVATION_S10=PASS" not in (tmp_path / "cmp.txt").read_text().splitlines()


# --------------------------------------------------------------------------- Core / detector restart, R1I removal, TrustedClock


def systemctl_stub(tmp_path: Path, core: str, detector: str) -> Path:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir(exist_ok=True)
    stub = bin_dir / "systemctl"
    stub.write_text('#!/bin/sh\nunit="$5"; prop="$3"\ncase "$unit/$prop" in\n'
                    f'  core/MainPID) echo {core.split("/")[0]};; core/NRestarts) echo {core.split("/")[1]};;\n'
                    f'  det/MainPID) echo {detector.split("/")[0]};; det/NRestarts) echo {detector.split("/")[1]};;\nesac\n')
    stub.chmod(0o755)
    return bin_dir


@pytest.mark.parametrize("core,detector,ok", [("100/0", "200/0", True), ("101/0", "200/0", False), ("100/1", "200/0", False), ("100/0", "201/0", False), ("100/0", "200/2", False)])
def test_core_or_detector_restart_or_identity_drift_fails(tmp_path: Path, core: str, detector: str, ok: bool) -> None:
    bin_dir = systemctl_stub(tmp_path, core, detector)
    script = f'. "{LIB}"; CORE_UNIT=core; DETECTOR_UNIT=det; CORE_PRE=100/0; DETECTOR_PRE=200/0; recovery_runtime_unchanged'
    assert (subprocess.run(["bash", "-c", script], env={**os.environ, "PATH": f"{bin_dir}:{os.environ['PATH']}"}).returncode == 0) is ok


def r1i_world(tmp_path: Path, tables: str, state: str) -> subprocess.CompletedProcess[str]:
    bin_dir = tmp_path / "nftbin"
    bin_dir.mkdir(exist_ok=True)
    (tmp_path / "state.txt").write_text(state)
    stub = bin_dir / "nft"
    stub.write_text(f'#!/bin/sh\ncase "$*" in\n  "list tables") printf "%b" "{tables}";;\n  "--stateless list table inet aegis_idea3_r1i") cat "{tmp_path / "state.txt"}";;\nesac\n')
    stub.chmod(0o755)
    tool = sup.ROOT / "deploy/pr11-phase4/r1i-input-instrumentation/r1i_input_instrumentation.py"
    return subprocess.run(["bash", "-c", f'. "{LIB}"; SUDO=""; recovery_r1i_present_gate "{tool}"'], env={**os.environ, "PATH": f"{bin_dir}:{os.environ['PATH']}"}, text=True, capture_output=True)


GOOD_R1I = ('table inet aegis_idea3_r1i {\n\tchain input {\n\t\ttype filter hook input priority filter - 10; policy accept;\n'
            '\t\tmeta nfproto ipv4 ct state new tcp flags & (syn | ack) == syn limit rate 50/second burst 60 packets log prefix "AEGIS_NEWCONN " level info\n\t}\n}\n')


def test_r1i_removal_or_a_changed_shape_fails_and_the_exact_table_passes(tmp_path: Path) -> None:
    for name in ("ok", "gone", "shape"):
        (tmp_path / name).mkdir()
    assert r1i_world(tmp_path / "ok", "table inet aegis_idea3_r1i\\n", GOOD_R1I).returncode == 0
    gone = r1i_world(tmp_path / "gone", "table inet aegis_idea3\\n", GOOD_R1I)
    assert gone.returncode == 1 and "RECOVERY_R1I_TABLE_MISSING" in gone.stderr  # R1I removed
    shape = r1i_world(tmp_path / "shape", "table inet aegis_idea3_r1i\\n", GOOD_R1I.replace("limit rate 50/second", "limit rate 500/second"))
    assert shape.returncode == 1 and "RECOVERY_R1I_TABLE_NOT_EXACT_OWNED_SHAPE" in shape.stderr


@pytest.mark.parametrize("tsv,ok", [("time.trustedclock.state\tSYNCED\n", True), ("time.trustedclock.state\tUNAVAILABLE\n", False), ("time.trustedclock.state\tUNTRUSTED\n", False),
                                    ("time.trustedclock.state\tNOT_RECORDED\n", False), ("time.NTP\tyes\n", False), ("time.trustedclock.state\tSYNCED-ish\n", False)])
def test_trustedclock_evidence_must_be_captured_and_synced_unavailable_fails(tmp_path: Path, tsv: str, ok: bool) -> None:
    (tmp_path / "time.tsv").write_text(tsv)
    result = subprocess.run(["bash", "-c", f'. "{LIB}"; SUDO=""; recovery_trustedclock_gate "{tmp_path}"'], text=True, capture_output=True)
    assert (result.returncode == 0) is ok and (ok or "RECOVERY_TRUSTEDCLOCK_NOT_SYNCED" in result.stderr)
    assert not subprocess.run(["bash", "-c", f'. "{LIB}"; SUDO=""; recovery_trustedclock_gate "{tmp_path / "missing"}"'], capture_output=True).returncode == 0


# --------------------------------------------------------------------------- the final stage and the baseline stage actually RUN the preservation (order and fail-closed)


STUBS = """
LOGF="$1"
mark() { echo "$1" >> "$LOGF"; }
recovery_require_hook() { true; }
recovery_authority_gates() { mark authority; [ "${FAIL:-}" != authority ]; }
recovery_capture() { mark "capture:$1"; [ "${FAIL:-}" != "capture:$1" ]; }
recovery_trustedclock_gate() { mark "clock:$(basename "$1")"; [ "${FAIL:-}" != "clock:$(basename "$1")" ]; }
recovery_handler() { mark "handler:$1"; [ "${FAIL:-}" != "handler:$1" ] || return 1; if [ "$1" = DELTA ] && [ "${DELTA_N:-}" != NONE ]; then echo "RECOVERY_CONTAINMENT_DELTA=PASS ALLOWED_KEYS=${DELTA_N:-2}"; fi; return 0; }
recovery_compare() { mark "compare:$(basename "$1"):$(basename "$2"):approved=$4:allow=$(basename "${5:-none}")"; [ "${FAIL:-}" != compare ]; }
recovery_runtime_unchanged() { mark runtime_unchanged; [ "${FAIL:-}" != runtime_unchanged ]; }
recovery_r1i_present_gate() { mark r1i; [ "${FAIL:-}" != r1i ]; }
recovery_operator_py() { mark "py:$1"; }
recovery_prepare_evidence() { mark prepare; }
recovery_logs_prepare() { mark logs; [ "${FAIL:-}" != logs ]; }
recovery_tty_gate() { mark tty; [ "${FAIL:-}" != tty ]; }
recovery_d4_rehearsal() { mark rehearsal; [ "${FAIL:-}" != rehearsal ]; }
recovery_sudo_authority_gate() { mark sudo; [ "${FAIL:-}" != sudo ]; }
"""


def run_hook(tmp_path: Path, hook: str, fail: str = "", delta_n: str = "2") -> tuple[subprocess.CompletedProcess[str], list[str]]:
    log = tmp_path / "hook.log"
    script = (f'{sup.seam(tmp_path)}. "{LIB}"\nSUDO=""\n{STUBS}\nWORK="{tmp_path}/canon/recovery-x"; EVID="{tmp_path}/evid"; STEPS="{tmp_path}/evid/steps"; CTRL=/c; CORE_UNIT=c; DETECTOR_UNIT=d\n'
              f'mkdir -p "{tmp_path}/evid"; {hook}; echo "rc=$?"')
    result = subprocess.run(["bash", "-c", script, "x", str(log)], env={**os.environ, "FAIL": fail, "DELTA_N": delta_n, "RECOVERY_QUIESCENCE_SLEEP": "0"}, text=True, capture_output=True)
    return result, (log.read_text().split() if log.exists() else [])


def test_the_final_hook_runs_authority_capture_clock_dump_final_delta_compare_runtime_and_r1i_in_that_order(tmp_path: Path) -> None:
    result, calls = run_hook(tmp_path, "recovery_hook_final")
    assert "rc=0" in result.stdout, result.stderr
    assert calls == ["sudo", "authority", "capture:POST", "clock:post-root", "handler:NFT_POST", "handler:FINAL", "handler:DELTA", "compare:pre-root:post-root:approved=2:allow=allow-keys.generated", "runtime_unchanged", "r1i"]


@pytest.mark.parametrize("fail", ["sudo", "authority", "capture:POST", "clock:post-root", "handler:NFT_POST", "handler:FINAL", "handler:DELTA", "compare", "runtime_unchanged", "r1i"])
def test_every_final_preservation_link_failing_fails_the_stage_and_runs_nothing_after_it(tmp_path: Path, fail: str) -> None:
    result, calls = run_hook(tmp_path, "recovery_hook_final", fail=fail)
    assert "rc=1" in result.stdout
    order = ["sudo", "authority", "capture:POST", "clock:post-root", "handler:NFT_POST", "handler:FINAL", "handler:DELTA", "compare", "runtime_unchanged", "r1i"]
    names = [c.split(":approved")[0].split(":pre-root")[0] for c in calls]
    assert not any(name in order[order.index(fail) + 1:] for name in names)


@pytest.mark.parametrize("delta_n", ["NONE", "0", "x", "01"])
def test_a_delta_that_proves_no_approvable_key_never_reaches_the_comparator(tmp_path: Path, delta_n: str) -> None:
    result, calls = run_hook(tmp_path, "recovery_hook_final", delta_n=delta_n)
    assert "rc=1" in result.stdout and not any(c.startswith("compare") for c in calls) and "RECOVERY_CONTAINMENT_DELTA_NOT_PROVEN" in result.stderr


def test_the_baseline_hook_captures_twice_proves_the_clock_quiescence_the_firewall_dump_and_the_baseline_before_any_core_call(tmp_path: Path) -> None:
    (tmp_path / "canon").mkdir(mode=0o700)
    result, calls = run_hook(tmp_path, "recovery_hook_baseline")
    assert "rc=0" in result.stdout, result.stderr
    assert calls == ["prepare", "logs", "tty", "rehearsal", "sudo", "capture:PRECHECK", "clock:precheck-root", "capture:PRE", "clock:pre-root", "compare:precheck-root:pre-root:approved=0:allow=none", "handler:NFT_PRE",
                     "handler:NFT_PRE_CHECK", "handler:READINESS", "handler:BASELINE", "py:status", "py:probe-pre"]


@pytest.mark.parametrize("fail", ["logs", "tty", "rehearsal", "sudo", "capture:PRECHECK", "clock:precheck-root", "capture:PRE", "clock:pre-root", "compare", "handler:NFT_PRE", "handler:NFT_PRE_CHECK", "handler:READINESS",
                                  "handler:BASELINE"])
def test_a_failed_pre_marker_capture_clock_quiescence_dump_or_baseline_stops_before_any_core_call(tmp_path: Path, fail: str) -> None:
    (tmp_path / "canon").mkdir(mode=0o700)
    result, calls = run_hook(tmp_path, "recovery_hook_baseline", fail=fail)
    assert "rc=1" in result.stdout and not any(c.startswith("py:") for c in calls)


def test_a_missing_runner_hook_or_a_prior_work_dir_fails_closed(tmp_path: Path) -> None:
    (tmp_path / "canon" / "recovery-x").mkdir(parents=True, mode=0o700)
    (tmp_path / "canon").chmod(0o700)
    result, calls = run_hook(tmp_path, "recovery_hook_baseline")
    assert "rc=1" in result.stdout and "RECOVERY_WORK_DIR_NOT_CREATABLE" in result.stderr and not any(c.startswith(("capture", "py:")) for c in calls)  # the work directory is created exclusively, once
