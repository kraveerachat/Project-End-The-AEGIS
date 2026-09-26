# shellcheck shell=bash disable=SC1091
"""AEGIS IDEA3 PR11 Phase 4 — L6b owner-runner gate library and runner contract tests.

Nothing here runs the runner against a host: the library gates are exercised with PATH stubs, fixture git repositories
and fixture input directories, and the runner template is checked statically plus by proving it refuses to run unpinned.
"""

from __future__ import annotations

import os
import re
import stat
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
DEPLOY = ROOT / "deploy" / "pr11-phase4"
LIB = DEPLOY / "p4-l6b-run-lib.sh"
RUNNER = DEPLOY / "owner-run" / "run-l6b-owner.sh"
LOGS = "Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs"

sys.path.insert(0, str(Path(__file__).parent))
import test_pr11_phase4_l6b_handler as h  # noqa: E402  (shared throwaway-PKI helper)


def lib(script: str, *, env: dict[str, str] | None = None, path_prefix: Path | None = None) -> subprocess.CompletedProcess[str]:
    e = os.environ.copy()
    e["SUDO"] = ""
    e.pop("AEGIS_L6B_ACCEPT_UPLINK", None)
    if path_prefix:
        e["PATH"] = f"{path_prefix}:{e['PATH']}"
    if env:
        e.update(env)
    return subprocess.run(["bash", "-c", f"source '{LIB}'; {script}"], text=True, capture_output=True, env=e, check=False)


def stub(bin_dir: Path, name: str, body: str) -> None:
    bin_dir.mkdir(parents=True, exist_ok=True)
    f = bin_dir / name
    f.write_text("#!/usr/bin/env bash\n" + body + "\n")
    f.chmod(0o755)


# ── static runner contract ───────────────────────────────────────────────────────────────────────────────────────────


def test_runner_template_is_unpinned_and_refuses_to_run(tmp_path: Path) -> None:
    text = RUNNER.read_text()
    assert "EXPECTED_MAIN=PIN_MAIN_SHA" in text
    res = subprocess.run(["bash", str(RUNNER), str(tmp_path)], text=True, capture_output=True)
    assert res.returncode == 2 and "not pinned" in res.stdout
    assert stat.S_IMODE(RUNNER.stat().st_mode) & 0o111
    assert subprocess.run(["bash", "-n", str(RUNNER)]).returncode == 0
    assert subprocess.run(["bash", "-n", str(LIB)]).returncode == 0


def test_runner_refuses_a_malformed_pin(tmp_path: Path) -> None:
    pinned = tmp_path / "run.sh"
    pinned.write_text(RUNNER.read_text().replace("PIN_MAIN_SHA", "not-a-sha"))
    res = subprocess.run(["bash", str(pinned), str(tmp_path)], text=True, capture_output=True)
    assert res.returncode == 2


def test_runner_never_runs_as_root_and_requires_sudo_before_mutation() -> None:
    text = RUNNER.read_text()
    assert 'id -u)" != 0' in text
    assert text.index("sudo -v") < text.index("l6b_consume_attempt") < text.index("PRE capture")


def test_runner_pre_capture_precedes_any_l6b_production_change_and_apply_is_invoked_once() -> None:
    text = RUNNER.read_text()
    assert len(re.findall(r"handler apply\.sh", text)) == 1
    assert len(re.findall(r"handler verify\.sh", text)) == 1
    assert len(re.findall(r"handler rollback\.sh", text)) == 1
    assert text.index("capture PRE") < text.index("handler apply.sh") < text.index("handler verify.sh")
    assert text.index("handler verify.sh") < text.index("capture POST")
    assert text.index("capture POST") < text.index("compare \"$EVID/pre-root\" \"$EVID/post-root\"")


def test_runner_success_is_persistent_and_never_rolls_back() -> None:
    text = RUNNER.read_text()
    tail = text[text.index("trap - ERR INT TERM\necho \"L6B_LIVE_EXECUTED"):]
    assert "rollback" not in tail.lower().replace("rollback_flow", "")
    assert "PERSISTENT" in tail and "NOT deleted" in tail
    # every rollback_flow call site is a failure path
    for m in re.finditer(r"rollback_flow ", text):
        line = text[text.rfind("\n", 0, m.start()) + 1: text.find("\n", m.start())]
        assert "||" in line or "rollback_flow()" in line or "fail_after_mutation" in line, line


def test_runner_rollback_compares_pre_to_rb_without_allow_files() -> None:
    text = RUNNER.read_text()
    assert 'compare "$EVID/pre-root" "$EVID/rb-root" "$EVID/compare-pre-rb.txt" &&' in text
    assert 'compare-pre-rb.txt" allow' not in text
    assert 'compare-pre-post.txt" allow' in text


def test_runner_has_no_reactivation_or_forbidden_host_mutations() -> None:
    text = "\n".join(l for l in RUNNER.read_text().splitlines() if not l.lstrip().startswith("#"))
    for pat in (
        r"nmcli\s+(connection|con|device)\s+(up|down|modify|delete)", r"\bnft\s+(add|delete|flush|-f)", r"sysctl\s+-w",
        r"systemctl\s+(restart|stop|start|reload|enable|disable|mask)\b", r"\bpkill\b", r"\bkillall\b", r"\brm\s+-\w*r", r"\bchronyc\b",
        r"\btwingate\s+(stop|start|restart)", r"\breboot\b", r"/dev/tty", r"esptool", r"platformio",
    ):
        assert not re.search(pat, text), pat
    assert "PREDECESSOR_RUNTIME_REACTIVATION_REQUIRED" in RUNNER.read_text() + LIB.read_text()


def test_runner_freezes_owner_decisions() -> None:
    text = RUNNER.read_text()
    assert "AP_IF=wlp0s20f3" in text and "AP_ADDR=10.77.30.1" in text
    assert "EXP_UPLINK_ADDR=192.168.1.144" in text and "AEGIS_UPLINK_ADDRESS=\"$UPLINK_ADDR\"" in text
    assert "UPLINK_ADDR=${L6B_UPLINK_ADDR" in text  # fresh runtime value, not the expected constant
    assert "AEGIS_L6B_LIVE_AUTHORIZED=YES" in text


def test_runner_uses_only_allowed_stage_gate_invocation_and_records() -> None:
    text = RUNNER.read_text()
    assert "--stage L6b --mode live" in text
    assert "authorization-L6b.txt" in text and "k3-L6b.txt" in text and 'stage=L6b' in text


# ── one attempt per authorization ────────────────────────────────────────────────────────────────────────────────────


def test_one_attempt_marker_is_atomic_and_final(tmp_path: Path) -> None:
    auth = tmp_path / "auth"
    auth.mkdir()
    assert lib(f"l6b_consume_attempt '{auth}'").returncode == 0
    assert (auth / "L6B-ATTEMPT-CONSUMED").is_file()
    second = lib(f"l6b_consume_attempt '{auth}'")
    assert second.returncode == 1 and "L6B_ATTEMPT_ALREADY_CONSUMED" in second.stderr


def test_one_attempt_marker_rejects_symlinked_or_missing_auth_dir(tmp_path: Path) -> None:
    real = tmp_path / "real"
    real.mkdir()
    link = tmp_path / "link"
    link.symlink_to(real)
    assert lib(f"l6b_consume_attempt '{link}'").returncode == 1
    assert lib(f"l6b_consume_attempt '{tmp_path / 'nope'}'").returncode == 1


# ── receipt gate (bound to the pinned commit, not the working tree) ──────────────────────────────────────────────────

L6A_RECEIPT = "2026-09-27_002532_music_idea3-pr11-l6a-live-acceptance.md"
L6A_TEXT = "# r\n\n```text\nL6A_LIVE_ACCEPTANCE=PROVEN\nL6A_COMPLETE=YES\nL6B_STARTED=NO\n```\n"


def git(repo: Path, *args: str) -> None:
    env = dict(os.environ, GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@t", GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@t")
    subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True, env=env)


def make_repo(tmp_path: Path, *, skip: str = "", l6a_text: str = L6A_TEXT, extra_l6a: bool = False, commit_l6a: bool = True) -> Path:
    repo = tmp_path / "repo"
    logs = repo / LOGS
    logs.mkdir(parents=True)
    git(repo, "init", "-q")
    for n in (2, 3, 4, 5):
        if f"L{n}" == skip:
            continue
        (logs / f"2026-09-2{n}_000000_music_idea3-pr11-l{n}-live-acceptance.md").write_text(f"`L{n}_LIVE_ACCEPTANCE = PROVEN`\n")
    if commit_l6a:
        (logs / L6A_RECEIPT).write_text(l6a_text)
        if extra_l6a:
            (logs / ("2026-09-28_000000_music_idea3-pr11-l6a-live-acceptance.md")).write_text(l6a_text)
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "fixture")
    if not commit_l6a:  # present in the working tree only
        (logs / L6A_RECEIPT).write_text(l6a_text)
    return repo


def test_receipt_gate_passes_with_all_predecessors_and_merged_l6a(tmp_path: Path) -> None:
    res = lib(f"l6b_receipt_gate '{make_repo(tmp_path)}'")
    assert res.returncode == 0, res.stderr
    assert f"L6A_RECEIPT={LOGS}/{L6A_RECEIPT}" in res.stdout


@pytest.mark.parametrize("skip", ["L2", "L3", "L4", "L5"])
def test_receipt_gate_requires_each_l2_to_l5_acceptance(tmp_path: Path, skip: str) -> None:
    res = lib(f"l6b_receipt_gate '{make_repo(tmp_path, skip=skip)}'")
    assert res.returncode == 1 and f"L6B_PREDECESSOR_RECEIPT_MISSING:{skip}" in res.stderr


def test_receipt_gate_rejects_an_unmerged_working_tree_only_l6a_receipt(tmp_path: Path) -> None:
    res = lib(f"l6b_receipt_gate '{make_repo(tmp_path, commit_l6a=False)}'")
    assert res.returncode == 1 and "L6B_L6A_RECEIPT_NOT_EXACTLY_ONE:0" in res.stderr


@pytest.mark.parametrize(
    "text,reason",
    [
        ("# r\nL6A_COMPLETE=YES\nL6B_STARTED=NO\n", "L6B_L6A_ACCEPTANCE_MARKER_MISSING"),
        ("# r\nL6A_LIVE_ACCEPTANCE=NOT_PROVEN\nL6A_COMPLETE=YES\nL6B_STARTED=NO\n", "L6B_L6A_ACCEPTANCE_MARKER_MISSING"),
        ("# r\nL6A_LIVE_ACCEPTANCE=PROVEN\nL6B_STARTED=NO\n", "L6B_L6A_COMPLETE_MARKER_MISSING"),
        ("# r\nL6A_LIVE_ACCEPTANCE=PROVEN\nL6A_COMPLETE=YES\nL6B_STARTED=YES\n", "L6B_L6A_RECEIPT_CLAIMS_L6B_STARTED"),
        ("# r\nL6A_LIVE_ACCEPTANCE = PROVEN\nL6A_COMPLETE = YES\n", "L6B_L6A_ACCEPTANCE_MARKER_MISSING"),
    ],
)
def test_receipt_gate_requires_exact_l6a_markers(tmp_path: Path, text: str, reason: str) -> None:
    res = lib(f"l6b_receipt_gate '{make_repo(tmp_path, l6a_text=text)}'")
    assert res.returncode == 1 and reason in res.stderr


def test_receipt_gate_rejects_ambiguous_duplicate_l6a_receipts(tmp_path: Path) -> None:
    res = lib(f"l6b_receipt_gate '{make_repo(tmp_path, extra_l6a=True)}'")
    assert res.returncode == 1 and "L6B_L6A_RECEIPT_NOT_EXACTLY_ONE:2" in res.stderr


def test_receipt_gate_passes_against_the_real_repository_history() -> None:
    """The gate must accept the actual merged L6A receipt on this branch's base (proves marker/regex compatibility)."""
    repo = ROOT.parent
    if subprocess.run(["git", "-C", str(repo), "cat-file", "-e", f"HEAD:{LOGS}/{L6A_RECEIPT}"], capture_output=True).returncode != 0:
        pytest.skip("L6A receipt not present at HEAD of this checkout")
    res = lib(f"l6b_receipt_gate '{repo}'")
    assert res.returncode == 0, res.stderr


# ── uplink resolution (OD-L6B-06) ────────────────────────────────────────────────────────────────────────────────────


def ip_stub(bin_dir: Path, *, routes: str, addrs: dict[str, str]) -> None:
    body = ['case "$*" in', f'  "-4 route show default") printf "%b" {routes!r} ;;']
    for dev, out in addrs.items():
        body.append(f'  "-4 -o addr show dev {dev} scope global") printf "%b" {out!r} ;;')
    body += ['  *) exit 0 ;;', "esac"]
    stub(bin_dir, "ip", "\n".join(body))


GOOD_ROUTE = "default via 192.168.1.1 dev enp62s0 proto dhcp src 192.168.1.144 metric 100\n"
GOOD_ADDR = {"enp62s0": "2: enp62s0    inet 192.168.1.144/24 brd 192.168.1.255 scope global dynamic enp62s0\n"}


def resolve(tmp_path: Path, *, routes: str = GOOD_ROUTE, addrs: dict[str, str] | None = None, env: dict[str, str] | None = None):
    b = tmp_path / "bin"
    ip_stub(b, routes=routes, addrs=addrs if addrs is not None else GOOD_ADDR)
    return lib(
        "l6b_resolve_uplink wlp0s20f3 10.77.30.1 enp62s0 192.168.1.144 && echo \"FROZEN=$L6B_UPLINK_IF:$L6B_UPLINK_ADDR\"",
        path_prefix=b, env=env,
    )


def test_uplink_resolves_the_fresh_runtime_value(tmp_path: Path) -> None:
    res = resolve(tmp_path)
    assert res.returncode == 0, res.stderr
    assert "FROZEN=enp62s0:192.168.1.144" in res.stdout


def test_uplink_expectation_mismatch_is_reported_not_silently_substituted(tmp_path: Path) -> None:
    other = {"enp62s0": "2: enp62s0    inet 192.168.1.200/24 scope global enp62s0\n"}
    res = resolve(tmp_path, addrs=other)
    assert res.returncode == 1
    assert "L6B_UPLINK_EXPECTATION_MISMATCH observed=enp62s0:192.168.1.200 expected=enp62s0:192.168.1.144" in res.stderr
    assert "FROZEN=" not in res.stdout


def test_uplink_mismatch_is_accepted_only_by_naming_exactly_the_observed_pair(tmp_path: Path) -> None:
    other = {"enp62s0": "2: enp62s0    inet 192.168.1.200/24 scope global enp62s0\n"}
    ok = resolve(tmp_path, addrs=other, env={"AEGIS_L6B_ACCEPT_UPLINK": "enp62s0:192.168.1.200"})
    assert ok.returncode == 0 and "FROZEN=enp62s0:192.168.1.200" in ok.stdout
    wrong = resolve(tmp_path, addrs=other, env={"AEGIS_L6B_ACCEPT_UPLINK": "enp62s0:192.168.1.144"})
    assert wrong.returncode == 1


@pytest.mark.parametrize(
    "routes,addrs,reason",
    [
        ("", GOOD_ADDR, "L6B_UPLINK_DEFAULT_ROUTE_COUNT:0"),
        (GOOD_ROUTE + "default via 10.0.0.1 dev sdwan0 metric 50\n", GOOD_ADDR, "L6B_UPLINK_DEFAULT_ROUTE_COUNT:2"),
        ("default via 10.77.30.2 dev wlp0s20f3 metric 5\n", GOOD_ADDR, "L6B_UPLINK_IS_AP_INTERFACE"),
        (GOOD_ROUTE, {"enp62s0": ""}, "L6B_UPLINK_ADDRESS_COUNT:0"),
        (GOOD_ROUTE, {"enp62s0": "2: e inet 192.168.1.144/24 scope global e\n2: e inet 192.168.1.145/24 scope global e\n"}, "L6B_UPLINK_ADDRESS_COUNT:2"),
        (GOOD_ROUTE, {"enp62s0": "2: e inet 127.0.0.5/8 scope global e\n"}, "L6B_UPLINK_ADDRESS_NOT_ROUTABLE"),
        (GOOD_ROUTE, {"enp62s0": "2: e inet 10.77.30.1/24 scope global e\n"}, "L6B_UPLINK_EQUALS_AP_ADDRESS"),
        ("default via 1.1.1.1\n", GOOD_ADDR, "L6B_UPLINK_INTERFACE_UNKNOWN"),
    ],
)
def test_uplink_fails_closed(tmp_path: Path, routes: str, addrs: dict[str, str], reason: str) -> None:
    res = resolve(tmp_path, routes=routes, addrs=addrs)
    assert res.returncode == 1 and reason in res.stderr, res.stderr


# ── current predecessor runtime gates (fresh proof, never repair) ────────────────────────────────────────────────────


def ap_stubs(tmp_path: Path, *, addr: str = "10.77.30.1", mode: str = "AP", ssid: str = "AEGIS-IDEA3",
             conn: str = "aegis-idea3-ap", link: bool = True) -> Path:
    b = tmp_path / "apbin"
    stub(b, "ip", f'''case "$*" in
  "-o link show dev wlp0s20f3") {'echo "3: wlp0s20f3: <UP>"' if link else 'exit 1'} ;;
  "-4 -o addr show dev wlp0s20f3") {f'echo "3: wlp0s20f3    inet {addr}/28 brd 10.77.30.15 scope global wlp0s20f3"' if addr else 'true'} ;;
esac''')
    stub(b, "iw", f'printf "Interface wlp0s20f3\\n\\ttype {mode}\\n\\tssid {ssid}\\n"')
    stub(b, "nmcli", f'echo "{conn}"')
    return b


def ap_gate(b: Path) -> subprocess.CompletedProcess[str]:
    return lib("l6b_ap_runtime_gate wlp0s20f3 10.77.30.1", path_prefix=b)


def test_ap_runtime_gate_passes_when_l3_l4_topology_is_applied(tmp_path: Path) -> None:
    assert ap_gate(ap_stubs(tmp_path)).returncode == 0


@pytest.mark.parametrize(
    "kwargs,reason",
    [
        ({"link": False}, "AP_INTERFACE_MISSING"),
        ({"addr": ""}, "AP_ADDRESS_NOT_PRESENT"),
        ({"addr": "192.168.1.115"}, "AP_ADDRESS_NOT_PRESENT"),
        ({"mode": "managed"}, "AP_NOT_IN_AP_MODE"),
        ({"ssid": "Pboo_5G"}, "AP_SSID_MISMATCH"),
        ({"conn": "Pboo_5G"}, "AP_PROFILE_NOT_ACTIVE"),
    ],
)
def test_ap_runtime_gate_demands_reactivation_instead_of_repairing(tmp_path: Path, kwargs: dict, reason: str) -> None:
    res = ap_gate(ap_stubs(tmp_path, **kwargs))
    assert res.returncode == 1
    assert "PREDECESSOR_RUNTIME_REACTIVATION_REQUIRED=YES" in res.stderr and reason in res.stderr


GOOD_NFT = (
    "table inet aegis_idea3 {\n  chain input {\n    type filter hook input priority filter; policy accept;\n"
    '    iifname "wlp0s20f3" tcp dport 1883 drop\n    iifname "wlp0s20f3" tcp dport 8883 accept\n  }\n}\n'
)


def nft_gate(text: str) -> subprocess.CompletedProcess[str]:
    return lib(f"printf '%b' {text!r} | l6b_nft_text_gate wlp0s20f3")


def test_nft_gate_passes_with_table_and_pf01() -> None:
    assert nft_gate(GOOD_NFT).returncode == 0


@pytest.mark.parametrize(
    "text,reason",
    [
        ("", "L2_NFT_TABLE_ABSENT"),
        (GOOD_NFT.replace("aegis_idea3", "other"), "L2_NFT_TABLE_ABSENT"),
        (GOOD_NFT.replace("tcp dport 1883 drop", "tcp dport 1883 accept"), "PF01_EXPLICIT_1883_DROP_MISSING"),
        (GOOD_NFT.replace('iifname "wlp0s20f3" tcp dport 1883 drop', 'iifname "enp62s0" tcp dport 1883 drop'), "PF01_EXPLICIT_1883_DROP_MISSING"),
        (GOOD_NFT.replace("}\n}", "  masquerade\n  }\n}"), "L6B_NAT_IN_IDEA3_TABLE"),
    ],
)
def test_nft_gate_fails_closed(text: str, reason: str) -> None:
    res = nft_gate(text)
    assert res.returncode == 1 and reason in res.stderr


@pytest.mark.parametrize(
    "probe,ok",
    [
        ("state=SYNCED reason=OK maxerror_us=65000 adjtimex_ret=0 status=0x2001 sta_unsync=0 time_error=0", True),
        ("state=UNSYNCED reason=KERNEL_UNSYNCED maxerror_us=16000000 adjtimex_ret=5", False),
        ("Traceback (most recent call last)", False),
        ("", False),
    ],
)
def test_trustedclock_gate_needs_fresh_read_only_proof_not_chronyd(probe: str, ok: bool) -> None:
    res = lib(f"l6b_trustedclock_gate {probe!r}")
    assert (res.returncode == 0) is ok
    body = LIB.read_text().split("l6b_trustedclock_gate() {")[1].split("\n}")[0]
    assert "chrony" not in body.lower() and "systemctl" not in body


# ── private JIT input gate ───────────────────────────────────────────────────────────────────────────────────────────


def input_gate(inp: Path):
    return lib(f"l6b_input_gate '{inp}' '{sys.executable}' '{DEPLOY}'")


def test_input_gate_accepts_the_exact_private_input(tmp_path: Path) -> None:
    fx = h.build(tmp_path)
    assert input_gate(fx.inp).returncode == 0


@pytest.mark.parametrize(
    "mutate,reason",
    [
        (lambda i: i.chmod(0o755), "L6B_INPUT_DIR_MODE_NOT_0700"),
        (lambda i: (i / "ca.key").write_text("x"), "L6B_CA_PRIVATE_KEY_FORBIDDEN"),
        (lambda i: (i / "extra").write_text("x"), "L6B_INPUT_ENTRIES_NOT_EXACT"),
        (lambda i: (i / "core.pass").unlink(), "L6B_INPUT_ENTRIES_NOT_EXACT"),
        (lambda i: (i / "device.pass").chmod(0o644), "L6B_INPUT_SECRET_MODE_INVALID:device.pass"),
        (lambda i: (i / "broker.key").chmod(0o660), "L6B_INPUT_SECRET_MODE_INVALID:broker.key"),
        (lambda i: (i / "broker.crt").chmod(0o666), "L6B_INPUT_CERT_WRITABLE:broker.crt"),
    ],
)
def test_input_gate_fails_closed(tmp_path: Path, mutate, reason: str) -> None:
    fx = h.build(tmp_path)
    mutate(fx.inp)
    res = input_gate(fx.inp)
    assert res.returncode == 1 and reason in res.stderr, res.stderr


def test_input_gate_rejects_key_that_does_not_match_certificate(tmp_path: Path) -> None:
    fx = h.build(tmp_path)
    other = tmp_path / "other"
    other.mkdir()
    h.make_pki(other)
    (fx.inp / "broker.key").write_bytes((other / "broker.key").read_bytes())
    (fx.inp / "broker.key").chmod(0o600)
    res = input_gate(fx.inp)
    assert res.returncode == 1 and "L6B_PKI_VALIDATION_FAILED" in res.stderr


def test_input_gate_never_prints_secret_contents(tmp_path: Path) -> None:
    fx = h.build(tmp_path)
    (fx.inp / "extra").write_text("x")
    res = input_gate(fx.inp)
    assert h.CORE_PW not in res.stdout + res.stderr and h.DEV_PW not in res.stdout + res.stderr


# ── secret-output scan ───────────────────────────────────────────────────────────────────────────────────────────────


def scan(fx: h.Fx, evid: Path):
    return lib(f"l6b_secret_scan '{fx.inp}' '{evid}' '{sys.executable}'")


@pytest.mark.parametrize(
    "content,hit",
    [
        ("stage L6b PASS\nlisteners 127.0.0.1:8883\n", False),
        (f"debug password={h.CORE_PW}\n", True),
        (f"debug password={h.DEV_PW}\n", True),
        ("-----BEGIN EC PRIVATE KEY-----\nMHcCAQEE\n-----END EC PRIVATE KEY-----\n", True),
        ("idea3-core:$7$101$AbCdEfGh$xyz\n", True),
    ],
)
def test_secret_scan_detects_plaintext_keys_and_password_hashes(tmp_path: Path, content: str, hit: bool) -> None:
    fx = h.build(tmp_path)
    evid = tmp_path / "evid"
    (evid / "sub").mkdir(parents=True)
    (evid / "sub" / "log.txt").write_text(content)
    res = scan(fx, evid)
    assert (res.returncode == 1) is hit, res.stdout + res.stderr
    assert h.CORE_PW not in res.stdout + res.stderr and h.DEV_PW not in res.stdout + res.stderr


def test_secret_scan_detects_private_key_body_lines(tmp_path: Path) -> None:
    fx = h.build(tmp_path)
    body = [l for l in (fx.inp / "broker.key").read_text().splitlines() if not l.startswith("-----")][0]
    evid = tmp_path / "evid"
    evid.mkdir()
    (evid / "x.txt").write_text(f"leak {body}\n")
    assert scan(fx, evid).returncode == 1
