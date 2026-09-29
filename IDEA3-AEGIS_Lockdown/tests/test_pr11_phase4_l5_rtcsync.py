"""L5 attempt #2 remediation (failed live attempt l5-20260925-191827). Tests first.

Root cause (proven): chronyd 4.8 on Linux clears STA_UNSYNC only when `rtcsync` is configured
(sys_timex.c set_sync_status: "On Linux clear the UNSYNC flag only if rtcsync is enabled"). Without it the kernel-based
TrustedClock predicate can never pass while chronyd owns the clock, so the L5 contract was unsatisfiable.

A. canonical render / validation / T6 contract: exactly four active directives, rtcsync required, rtcfile rejected.
B. p4-l5-clock.py preserves raw kernel evidence (adjtimex return/status/STA_UNSYNC/TIME_ERROR).
C. whole-run production mutation accounting (first actual mutation, never erased, compare-local NO not propagated).
D. owner-readable diagnostics copy that never modifies the root-owned originals.
"""
from __future__ import annotations

import hashlib
import importlib.util
import os
import subprocess
from pathlib import Path

import pytest

import test_pr11_phase4_l5_handler as h

DEPLOY = h.DEPLOY
HANDLER = h.HANDLER
P4_NTP = DEPLOY / "p4-ntp.py"
CLOCK = DEPLOY / "p4-l5-clock.py"
RUNLIB = DEPLOY / "p4-l5-run-lib.sh"

FOUR = ["server 198.51.100.123 iburst", "bindaddress 192.0.2.1", "allow 192.0.2.0/28", "rtcsync"]


def load(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def active(text: str) -> list[str]:
    return [l.strip() for l in text.splitlines() if l.strip() and not l.lstrip().startswith("#")]


def render(tmp: Path) -> Path:
    return h.setup_t6_render(tmp / "render")


def validate(dir_: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["python3", str(P4_NTP), "validate", "--input-dir", str(dir_)],
                          text=True, capture_output=True, check=False)


# ── A. render / validate / contract ──────────────────────────────────────────

def test_a_render_contains_exactly_the_four_approved_active_directives(tmp_path: Path) -> None:
    r = render(tmp_path)
    assert active((r / "aegis-idea3-chrony.conf").read_text()) == FOUR
    assert validate(r).returncode == 0


def test_a_render_without_rtcsync_fails_the_linux_trustedclock_contract(tmp_path: Path) -> None:
    ntp = load(P4_NTP, "p4_ntp")
    with_rtc = "\n".join(FOUR) + "\n"
    without = "\n".join(FOUR[:3]) + "\n"
    assert ntp.chrony_kernel_sync_possible(with_rtc) is True
    assert ntp.chrony_kernel_sync_possible(without) is False   # chrony 4.8 keeps STA_UNSYNC set on Linux
    r = render(tmp_path)
    conf = r / "aegis-idea3-chrony.conf"
    conf.write_text("\n".join(FOUR[:3]) + "\n", encoding="utf-8")
    res = validate(r)
    assert res.returncode != 0 and "rtcsync" in res.stderr


def test_a_rtcfile_with_rtcsync_is_rejected(tmp_path: Path) -> None:
    ntp = load(P4_NTP, "p4_ntp2")
    assert ntp.chrony_kernel_sync_possible("\n".join(FOUR) + "\nrtcfile /var/lib/chrony/rtc\n") is False
    r = render(tmp_path)
    conf = r / "aegis-idea3-chrony.conf"
    conf.write_text(conf.read_text() + "rtcfile /var/lib/chrony/rtc\n", encoding="utf-8")
    res = validate(r)
    assert res.returncode != 0 and "rtcfile" in res.stderr


@pytest.mark.parametrize("extra", ["makestep 1 3", "rtcsync", "local stratum 10", "pool x.example.invalid iburst"])
def test_a_no_other_directive_and_no_duplicate_rtcsync(tmp_path: Path, extra: str) -> None:
    r = render(tmp_path)
    conf = r / "aegis-idea3-chrony.conf"
    conf.write_text(conf.read_text() + extra + "\n", encoding="utf-8")
    assert validate(r).returncode != 0


def test_a_bind_exposure_rules_are_preserved(tmp_path: Path) -> None:
    r = render(tmp_path)
    conf = r / "aegis-idea3-chrony.conf"
    conf.write_text(conf.read_text().replace("bindaddress 192.0.2.1", "bindaddress 0.0.0.0"), encoding="utf-8")
    assert validate(r).returncode != 0


def test_a_contract_declares_rtcsync_and_rejects_tampering(tmp_path: Path) -> None:
    r = render(tmp_path)
    contract = r / "aegis-idea3-t6-contract.txt"
    assert "CHRONY_RTCSYNC=REQUIRED" in contract.read_text().splitlines()
    contract.write_text(contract.read_text().replace("CHRONY_RTCSYNC=REQUIRED", "CHRONY_RTCSYNC=NO"), encoding="utf-8")
    assert validate(r).returncode != 0


def test_a_apply_rejects_a_render_without_rtcsync(tmp_path: Path) -> None:
    fs_root, work, r = tmp_path / "fs", tmp_path / "work", render(tmp_path)
    h.setup_l4_fs(fs_root)
    (r / "aegis-idea3-chrony.conf").write_text("\n".join(FOUR[:3]) + "\n", encoding="utf-8")
    res = h.run_handler(HANDLER / "apply.sh", fs_root=fs_root, work_dir=work, render_dir=r)
    assert res.returncode != 0 and "L5_APPLY=PASS" not in res.stdout


def test_a_apply_installs_exactly_four_directives_and_verify_requires_them(tmp_path: Path) -> None:
    fs_root, work, r = tmp_path / "fs", tmp_path / "work", render(tmp_path)
    h.setup_l4_fs(fs_root)
    assert h.run_handler(HANDLER / "apply.sh", fs_root=fs_root, work_dir=work, render_dir=r).returncode == 0
    conf = fs_root / "etc" / "chrony.conf"
    assert active(conf.read_text()) == FOUR
    v = h.run_handler(HANDLER / "verify.sh", fs_root=fs_root, work_dir=work)
    assert v.returncode == 0, v.stdout + v.stderr
    conf.write_text("\n".join(FOUR[:3]) + "\n")
    os.chmod(conf, 0o640)
    v = h.run_handler(HANDLER / "verify.sh", fs_root=fs_root, work_dir=work)
    assert v.returncode != 0 and "L5_VERIFY=PASS" not in v.stdout


def test_a_rollback_allowance_files_are_not_widened() -> None:
    keys = [l.strip() for l in (HANDLER / "allow-keys.txt").read_text().splitlines() if l.strip() and not l.startswith("#")]
    assert not any("rtcsync" in k.lower() for k in keys)
    assert (HANDLER / "allow-listeners.txt").read_text().count("listen.") == 3


# ── B. raw kernel evidence ───────────────────────────────────────────────────

def test_b_raw_fields_are_emitted_for_a_fixture() -> None:
    r = subprocess.run(["python3", str(CLOCK), "raw", "--fixture-raw", "5:0x2041:16000000"],
                       text=True, capture_output=True, check=False)
    out = r.stdout.strip()
    for token in ("adjtimex_ret=5", "status=0x2041", "sta_unsync=1", "time_error=1", "maxerror_us=16000000"):
        assert token in out.split(), (token, out)


def test_b_raw_decodes_synced_state() -> None:
    r = subprocess.run(["python3", str(CLOCK), "raw", "--fixture-raw", "0:0x2001:17288"],
                       text=True, capture_output=True, check=False)
    assert "sta_unsync=0" in r.stdout and "time_error=0" in r.stdout and "adjtimex_ret=0" in r.stdout


def test_b_raw_reports_unavailable_without_inventing_values() -> None:
    r = subprocess.run(["python3", str(CLOCK), "raw", "--fixture-raw", "none"], text=True, capture_output=True, check=False)
    assert "adjtimex_ret=UNAVAILABLE" in r.stdout and "sta_unsync" not in r.stdout


def test_b_probe_and_state_outputs_keep_their_prefix_and_append_raw() -> None:
    r = subprocess.run(["python3", str(CLOCK), "probe", "--fixture-probe", "unsynced:16000000"],
                       text=True, capture_output=True, check=False)
    assert r.stdout.startswith("state=UNTRUSTED reason=KERNEL_UNSYNCED maxerror_us=16000000")
    assert "sta_unsync=1" in r.stdout and "adjtimex_ret=" in r.stdout


def test_b_readiness_log_records_raw_status_per_poll(tmp_path: Path) -> None:
    fs_root, work, r = tmp_path / "fs", tmp_path / "work", render(tmp_path)
    h.setup_l4_fs(fs_root)
    (fs_root / "run" / "aegis-idea3-fixture" / "clock_sequence").write_text(
        "leap=Normal probe=unsynced maxerror=16000000 ret=5 status=0x2041\n"
        "leap=Normal probe=synced maxerror=17288 ret=0 status=0x2001\n", encoding="utf-8")
    env = {"AEGIS_L5_READINESS_TIMEOUT_SEC": "1", "AEGIS_L5_READINESS_INTERVAL_SEC": "0.01"}
    res = h.run_handler(HANDLER / "apply.sh", fs_root=fs_root, work_dir=work, render_dir=r, extra_env=env)
    assert res.returncode == 0, res.stdout + res.stderr
    log = (work / "readiness.log").read_text().splitlines()
    assert "sta_unsync=1" in log[0] and "time_error=1" in log[0] and "status=0x2041" in log[0]
    assert "sta_unsync=0" in log[-1] and "reason=OK" in log[-1]


def test_b_trusted_time_exposes_raw_reader_and_probe_semantics_unchanged() -> None:
    import sys
    sys.path.insert(0, str(DEPLOY.parents[1]))
    from aegis_soc import trusted_time as tt
    assert hasattr(tt, "adjtimex_raw")
    raw = tt.RawAdjtimex(ret=5, status=0x2041, maxerror_us=1)
    assert tt.clock_sync_from_raw(raw) == tt.ClockSync(synced=False, maxerror_us=1)     # TIME_ERROR => unsynced
    assert tt.clock_sync_from_raw(tt.RawAdjtimex(0, 0x40, 1)).synced is False            # STA_UNSYNC => unsynced
    assert tt.clock_sync_from_raw(tt.RawAdjtimex(0, 0x2001, 5)).synced is True
    assert tt.clock_sync_from_raw(None) is None


# ── C. whole-run production mutation accounting ──────────────────────────────

def _apply(tmp: Path, env: dict[str, str] | None = None, fixture: dict[str, str] | None = None):
    fs_root, work, r = tmp / "fs", tmp / "work", render(tmp)
    h.setup_l4_fs(fs_root)
    for k, v in (fixture or {}).items():
        (fs_root / "run" / "aegis-idea3-fixture" / k).write_text(v, encoding="utf-8")
    return work, h.run_handler(HANDLER / "apply.sh", fs_root=fs_root, work_dir=work, render_dir=r, extra_env=env)


def test_c_failed_apply_after_first_mutation_still_reports_mutation(tmp_path: Path) -> None:
    work, res = _apply(tmp_path, env={"AEGIS_L5_INJECT_FAIL_CHRONYD_START": "1"})
    assert res.returncode != 0 and "L5_APPLY=PASS" not in res.stdout
    assert "PRODUCTION_MUTATION_PERFORMED=FIXTURE_ONLY" in res.stdout      # live: =YES; FIXTURE_ONLY under a fixture root
    assert (work / "production_mutation_performed").read_text().strip() == "FIXTURE_ONLY"


def test_c_readiness_failure_does_not_erase_the_mutation_fact(tmp_path: Path) -> None:
    work, res = _apply(tmp_path, env={"AEGIS_L5_READINESS_TIMEOUT_SEC": "1", "AEGIS_L5_READINESS_INTERVAL_SEC": "0.01"},
                       fixture={"clock_sequence": "leap=Normal probe=unsynced maxerror=16000000\n"})
    assert res.returncode != 0 and "KERNEL_UNSYNCED" in res.stderr
    assert "PRODUCTION_MUTATION_PERFORMED=FIXTURE_ONLY" in res.stdout
    assert (work / "production_mutation_performed").exists()


def test_c_marker_appears_before_the_first_write_to_etc() -> None:
    text = h.code_text(HANDLER / "apply.sh")
    marker = text.index("production_mutation_performed")
    assert marker < text.index('mktemp "${target_conf}.tmp.')
    assert marker < text.index("mv -f")


def test_c_pre_mutation_failure_reports_no_mutation(tmp_path: Path) -> None:
    work, res = _apply(tmp_path, fixture={"timesyncd_active": "inactive\n"})
    assert res.returncode != 0 and "TIMESYNCD_NOT_ACTIVE" in res.stderr
    assert "PRODUCTION_MUTATION_PERFORMED" not in res.stdout
    assert not (work / "production_mutation_performed").exists()


def sh(script: str, **env: str) -> subprocess.CompletedProcess[str]:
    e = os.environ.copy()
    e.update({"SUDO": "", **env})
    return subprocess.run(["bash", "-c", f'source "{RUNLIB}"\n{script}'], text=True, capture_output=True, env=e, check=False)


def test_c_run_marker_is_yes_when_apply_reported_mutation_even_if_compare_says_no(tmp_path: Path) -> None:
    apply_out = "PRODUCTION_MUTATION_PERFORMED=YES\nL5_APPLY=FAIL reason=TRUSTEDCLOCK_READINESS_TIMEOUT:KERNEL_UNSYNCED\n"
    compare_out = "COMPARE_RESULT=PASS\nPRODUCTION_MUTATION_PERFORMED=NO\n"
    r = sh(f'l5_run_mutation_marker "$APPLY" "{tmp_path}/none"\nprintf "%s" "$CMP" | l5_relabel_compare_marker',
           APPLY=apply_out, CMP=compare_out)
    lines = r.stdout.splitlines()
    assert lines[0] == "RUN_PRODUCTION_MUTATION_PERFORMED=YES", r.stdout + r.stderr
    assert "PRODUCTION_MUTATION_PERFORMED=NO" not in [l for l in lines[1:]]           # bare compare-local NO is gone
    assert "COMPARE_LOCAL_PRODUCTION_MUTATION_PERFORMED=NO" in lines


def test_c_run_marker_reads_the_work_marker_when_apply_output_is_lost(tmp_path: Path) -> None:
    (tmp_path / "production_mutation_performed").write_text("YES\n")
    r = sh(f'l5_run_mutation_marker "" "{tmp_path}/production_mutation_performed"')
    assert r.stdout.strip() == "RUN_PRODUCTION_MUTATION_PERFORMED=YES"


def test_c_run_marker_is_no_only_when_nothing_mutated(tmp_path: Path) -> None:
    r = sh(f'l5_run_mutation_marker "L5_APPLY=FAIL reason=TIMESYNCD_NOT_ACTIVE" "{tmp_path}/absent"')
    assert r.stdout.strip() == "RUN_PRODUCTION_MUTATION_PERFORMED=NO"


def test_c_run_marker_ignores_a_compare_no_line_passed_as_apply_output(tmp_path: Path) -> None:
    r = sh(f'l5_run_mutation_marker "PRODUCTION_MUTATION_PERFORMED=NO" "{tmp_path}/production_mutation_performed"')
    assert r.stdout.strip() == "RUN_PRODUCTION_MUTATION_PERFORMED=NO"
    (tmp_path / "production_mutation_performed").write_text("YES\n")
    r = sh(f'l5_run_mutation_marker "PRODUCTION_MUTATION_PERFORMED=NO" "{tmp_path}/production_mutation_performed"')
    assert r.stdout.strip() == "RUN_PRODUCTION_MUTATION_PERFORMED=YES"


# ── D. owner-readable diagnostics copy ───────────────────────────────────────

def _digest(root: Path) -> dict[str, tuple[str, int]]:
    return {str(p.relative_to(root)): (hashlib.sha256(p.read_bytes()).hexdigest(), int(p.stat().st_mtime))
            for p in sorted(root.rglob("*")) if p.is_file()}


def test_d_copy_preserves_originals_and_is_byte_identical(tmp_path: Path) -> None:
    src, dst = tmp_path / "l5-work", tmp_path / "copy"
    src.mkdir()
    (src / "readiness.log").write_text("ts=1 leap='Normal' reason=KERNEL_UNSYNCED\n")
    (src / "chronyc-tracking.txt").write_text("Leap status     : Normal\n")
    (src / "chrony.conf.meta.orig").write_text("644:0:0:13964:1790333201\n")
    os.utime(src / "readiness.log", (1_700_000_000, 1_700_000_000))
    before = _digest(src)
    os.chmod(src, 0o500)
    try:
        r = sh(f'l5_copy_work_diagnostics "{src}" "{dst}"')
    finally:
        os.chmod(src, 0o700)
    assert r.returncode == 0, r.stdout + r.stderr
    assert _digest(src) == before                                            # originals untouched (content and mtime)
    for name, (digest, _) in before.items():
        assert hashlib.sha256((dst / name).read_bytes()).hexdigest() == digest
    assert (os.stat(dst).st_mode & 0o777) == 0o700 and (os.stat(dst / "readiness.log").st_uid == os.getuid())
    assert "SHA256SUMS" in [p.name for p in dst.iterdir()]


def test_d_copy_refuses_to_overwrite_and_fails_on_missing_source(tmp_path: Path) -> None:
    dst = tmp_path / "copy"
    dst.mkdir()
    assert sh(f'l5_copy_work_diagnostics "{tmp_path}/absent" "{dst}/x"').returncode != 0
    (tmp_path / "s").mkdir()
    (tmp_path / "s" / "f").write_text("1")
    assert sh(f'l5_copy_work_diagnostics "{tmp_path}/s" "{dst}"').returncode != 0   # existing destination


def test_d_library_never_writes_into_the_source() -> None:
    text = h.code_text(RUNLIB)
    assert "rm " not in text and "chown" not in text and " mv " not in text
