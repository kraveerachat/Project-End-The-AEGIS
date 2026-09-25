---
title: Task Receipt — IDEA3 PR11 L5 attempt #2 rtcsync remediation
date: 2026-09-25T20:06:00+07:00
owner: music
area: idea3
branch: fix/idea3-pr11-l5-rtcsync-contract
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 PR11 L5 attempt #2 rtcsync remediation

> [!important] Repository-only. No Production mutation, no live retry. `L5_ATTEMPT2_RESULT = FAIL` (evidence `2026-09-25-l5-20260925-191827`) is NOT changed; the attempt-2 authorization is consumed; `L5_LIVE_ACCEPTANCE = NOT_PROVEN`, `LIVE_RETRY_AUTHORIZED = NO`.

## What changed

Attempt #2, recorded accurately: apply failed `TRUSTEDCLOCK_READINESS_TIMEOUT:KERNEL_UNSYNCED` after the 60 s bound; the L5 rollback PASSED (exact chrony.conf sha/mode/size/mtime, PRE→RB compare PASS, S10 PASS, no artifact residue). `readiness.log` proved chronyd Leap became Normal about 5 s after start and maxerror fell from 16,000,000 to 17,288 µs, yet every poll reported `KERNEL_UNSYNCED`.

- **Root cause (PROVEN).** Upstream chrony 4.8 `sys_timex.c` `set_sync_status()`: "On Linux clear the UNSYNC flag only if rtcsync is enabled". The rendered L5 config omitted `rtcsync`, so the kernel-based TrustedClock predicate was unsatisfiable under chronyd. Not observed running with `rtcsync` (that is the next live attempt).
- **A. rtcsync.** Canonical template/render/validation/contract now require exactly four active directives (`server … iburst`, `bindaddress`, `allow`, `rtcsync`); `rtcfile` and a missing `rtcsync` are rejected; contract `CHRONY_RTCSYNC=REQUIRED`; apply/verify handlers require the four. Owner-accepted side effect: kernel RTC copy about every 11 min while synchronised (not rollback-reversible). TrustedClock predicate and 60 s bound unchanged; the three rollback-only allowances unchanged; `rtcsync` is not an allowance.
- **B. Raw kernel evidence.** `aegis_soc.trusted_time` gains `adjtimex_raw` / `clock_sync_from_raw` (probe semantics identical); `p4-l5-clock.py` appends `adjtimex_ret status=0x.. sta_unsync time_error` to `state`/`probe` and every `readiness.log` line and gains a `raw` subcommand.
- **C. Mutation accounting.** `apply.sh` records `PRODUCTION_MUTATION_PERFORMED` (YES live, FIXTURE_ONLY in fixtures) and `$WORK/production_mutation_performed` before its first `/etc` write. `p4-l5-run-lib.sh` (sourced by the external owner runner) derives `RUN_PRODUCTION_MUTATION_PERFORMED` from that marker only and relabels `p4-compare.sh`'s comparison-local `NO`.
- **D. Evidence copy.** `l5_copy_work_diagnostics` streams root-owned `l5-work` files into a 0700 owner-readable copy with `SHA256SUMS`; originals are never modified.

## Source files changed

- `IDEA3-AEGIS_Lockdown/deploy/chrony/aegis-idea3-chrony.conf.example`, `deploy/pr11-phase4/p4-ntp.py`, `p4-l5-clock.py`, `p4-l5-run-lib.sh` (new), `stages/L5/apply.sh`, `stages/L5/verify.sh`, `deploy/pr11-phase4/README.md`
- `IDEA3-AEGIS_Lockdown/aegis_soc/trusted_time.py`
- `IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-09-18-idea3-pr11-phase4-t6-local-ntp-design.md`
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l5_rtcsync.py` (new) and narrow updates to existing NTP/L5 tests

## Verification evidence

- `pytest tests/test_pr11_phase4_l5_rtcsync.py` before implementation — RED: 20 failed, 9 passed (the 9 are guards for preserved behavior)
- `pytest tests/test_pr11_phase4_l5_rtcsync.py` after implementation — pass: 29 passed
- `pytest tests/test_pr11_phase4_l5_rtcsync.py tests/test_pr11_phase4_l5_remediation.py tests/test_pr11_phase4_l5_handler.py tests/test_pr11_phase4_l5_trustedclock_path.py tests/test_pr11_phase4_ntp.py tests/test_trusted_time.py tests/test_private_ap_contract.py` — pass: 152 passed
- `pytest tests/test_pr11_phase4_*.py` — fail (pre-existing only): 7 failed, 1141 passed; the same 7 fail on untouched main (broker_validate ×3, l6a_handler ×4: installed paho lacks `CallbackAPIVersion`)
- `pytest tests` — fail (pre-existing 7 plus one load flake): 8 failed, 2226 passed, 7 skipped; the extra `test_local_restore.py::test_closing_the_channel_cancels_an_incomplete_client_before_returning` passes 150/150 on three isolated reruns
- `bash -n` on every `deploy/pr11-phase4/*.sh` and `stages/L5/*.sh` — pass
- `git diff --check` — pass
- `python3 deploy/pr11-phase4/p4-ntp.py validate` on a fresh render — pass (four active directives)
- `node scripts/validate-vault.mjs --vault Obsidian_AEGIS_Vault/AEGIS_Knowledge` — pass

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — attempt #2 remediation section.

## Shared surfaces touched

- None outside the IDEA3 boundary.

## Integration requests

- Human review and merge before any L5 retry. After merge: re-render from merged main (new timestamped render; the render embeds the template text), re-pin and re-freeze the owner runner and probe, then fresh authorization, K3 and one-attempt approval.

## Known limitations

- Not run live; that `rtcsync` makes chronyd clear `STA_UNSYNC` is proven from upstream source and the failed-attempt evidence, not observed. The Arch `4.8-3` build was not source-verified.
- The external owner runner is not in the repository: it must source `p4-l5-run-lib.sh`, gate on four active directives, and use the new markers (done in a draft outside the repository, not frozen).
- Attempt #3 needs merge, new frozen hashes, fresh authorization, fresh K3 and a one-attempt approval. `Pboo_5G` autoconnect stays `no`.
