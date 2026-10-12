---
title: Task Receipt — IDEA3 CTv consumed-incident remediation
date: 2026-10-08T08:22:01+07:00
owner: music
area: idea3
branch: fix/idea3-ctv-consumed-incident-remediation
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 CTv consumed-incident remediation

## What changed

Source-only fixes for three defects found by the consumed CTv attempt (authority main `67ee7dc8511e920afac9e2e6c8d4528ca01c741f`), plus a proposal-only incident disposition:

1. The CTv bundle now carries the `aegis_soc` import closure of `p4-l5-clock.py` (`__init__`, `trusted_time`, `protocol_v1`), hash-verified against exact main, so the bundled capture can report the real TrustedClock state instead of UNAVAILABLE.
2. `stages/CTv/allow-keys.txt` and `allow-keys-rollback.txt` name the evidence keys the capture actually records (Core unit file class/meta/sha256, Core and detector MainPID/ExecMainStartTimestamp) instead of unit directive names the capture never records.
3. `CTV_UNIT_DEST` is set in every runner mode, and the rollback validates it, fails in a controlled way instead of aborting the shell, and runs install/systemctl via `ctv_run`. The capture sets `PYTHONDONTWRITEBYTECODE=1`.

## Source files changed

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-ctv-run-lib.sh` — bundle closure + git-path mapping, rollback fix.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/owner-run/run-ctv-owner.sh` — export CTV_UNIT_DEST in all modes; no-bytecode capture.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/CTv/allow-keys.txt` — approved change contract keyed to captured evidence keys.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/CTv/allow-keys-rollback.txt` — same, rollback contract.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/CTV-INCIDENT-DISPOSITION.md` — new, proposal only; nothing authorized or executed.
- `IDEA3-AEGIS_Lockdown/tests/test_ctv_successor.py` — 5 new non-hermetic regression tests.

## Verification evidence

- `pytest -q IDEA3-AEGIS_Lockdown/tests/test_ctv_successor.py` — PASS: 80 passed (5 new tests all fail with the source fixes reverted)
- `pytest -q` on test_ctu_blockers, test_ctu_l0_dependency_closure, test_recovery_stage, test_pr11_phase4_harness, test_pr11_phase4_l7_core_env_helper — 406 passed, 1 failed: `test_only_reviewed_stage_handlers_are_registered`, identical failure on unmodified main (CTv handler absent from expected set); unrelated
- `bash -n` on p4-ctv-run-lib.sh and run-ctv-owner.sh — PASS
- `git diff --check` — PASS

## Canonical notes updated

None — source remediation and proposal only; no durable project fact changed.

## Shared surfaces touched

None — IDEA3-owned paths only.

## Integration requests

Independent security/governance review of the exact PR head. Human merge only. Any Production disposition step in CTV-INCIDENT-DISPOSITION.md needs separate explicit Human Owner authorization.

## Known limitations

The root-owned canonical directory, CTv work directory and journal were not readable in this session, so the incident state (marker consumed, closeouts absent, journal apply-verified, Core active, unit changed, rollback incomplete) comes from the Human Owner and is not independently verified. The new S10 contract is tested with synthetic evidence through the real comparator, not with the original captured evidence. The real Production capture and a full non-hermetic runner execution were not run (forbidden). CTv remains CONSUMED, NO RETRY; no closeout was written; no marker, Production unit, service, CTu/Recovery state or frozen runner was touched. The pre-existing harness failure is not addressed.
