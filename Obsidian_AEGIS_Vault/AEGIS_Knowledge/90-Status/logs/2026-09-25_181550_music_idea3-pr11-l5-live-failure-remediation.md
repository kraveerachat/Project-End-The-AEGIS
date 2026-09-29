---
title: Task Receipt — IDEA3 PR11 L5 live-failure remediation
date: 2026-09-25T18:15:50+07:00
owner: music
area: idea3
branch: fix/idea3-pr11-l5-live-failure-remediation
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 PR11 L5 live-failure remediation

> [!important] Repository-only. No Production mutation, no live retry. `L5_ATTEMPT_RESULT = FAIL` (attempt `2026-09-25-l5-20260925-174630`) is NOT changed; `L5_LIVE_ACCEPTANCE = NOT_PROVEN`, `LIVE_RETRY_AUTHORIZED = NO`.

## What changed

Failed live attempt, recorded accurately: apply PASS (chronyd active, UDP/123 only on 10.77.30.1) then `L5_VERIFY=FAIL reason=FINAL_TRUSTED_CLOCK_NOT_SYNCED`; the L5 rollback PASSED and functionally recovered the host (chrony.conf content/mode/owner exact, timesyncd active, chronyd inactive, nft/listeners/L4/S10 processes unchanged); the PRE→RB comparison FAILED on two keys, so `PRESERVATION_S10 = FAIL`. No witness stage was reached. No retry occurred.

- **A. Readiness.** `verify` root cause is **PARTIAL**: journal timeline proves chronyd selected a source 0.806 s before the rollback stopped it, so apply's chronyd-only predicate (`Leap status : Normal`) can pass before verify's kernel TrustedClock predicate; which sub-predicate failed is UNKNOWN (verify discarded the reason; no kernel evidence was captured). The timing-race hypothesis is supported, not proven. Fix: one shared predicate `p4-l5-clock.py` (probe readable, kernel synced, maxerror ≤ 1,000,000 µs, TrustedClock SYNCED); apply waits bounded (60 s) for Leap Normal AND that predicate; failures name the reason; readiness log + chronyc tracking/sources are saved.
- **B. Rollback mtime (real defect).** rollback restored content/mode/uid but used `cp -f` and never applied the snapshot mtime (PRE 1777584149 vs RB 1790333201). Fix: restore mtime from the snapshot and verify bytes, size, mode, mtime (and live uid/gid).
- **C. timesyncd ServerName.** `2.arch.pool.ntp.org → 0.arch.pool.ntp.org` is expected reselection on restart (timesyncd has no configured servers, only `FallbackNTPServers`), not restorable by rollback. Owner decision CONSTRAINED_INFORMATIONAL_DYNAMIC_STATE: comparator treats only this key as INFO when timesyncd is active/running, TrustedClock is SYNCED, the captured fallback set is unchanged and contains the new name; otherwise drift. It is NOT an allowance key; the three rollback-only allowance keys are unchanged. Capture now records `time.timesyncd.FallbackNTPServers` and `time.trustedclock.state`.

## Source files changed

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-l5-clock.py` (new), `stages/L5/apply.sh`, `stages/L5/verify.sh`, `stages/L5/rollback.sh`
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-compare.sh`, `p4-l0-capture.sh`, `p4-lib.sh` (one exact read-only helper call allowed)
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/README.md`
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l5_remediation.py` (new), `tests/test_pr11_phase4_l5_trustedclock_path.py` (narrow update: apply/verify now delegate the import to the helper)

## Verification evidence

- `pytest tests/test_pr11_phase4_l5_remediation.py` before implementation — RED: 16 failed, 6 passed (the 6 already fail closed)
- `pytest tests/test_pr11_phase4_l5_remediation.py tests/test_pr11_phase4_l5_handler.py tests/test_pr11_phase4_l5_trustedclock_path.py` — pass: 80 passed
- `pytest tests -k phase4` — fail (pre-existing only): 7 failed, 1112 passed; same 7 as base (broker_validate ×3, l6a_handler ×4)
- `pytest tests` — fail (same pre-existing only): 7 failed, 2198 passed, 7 skipped
- `bash -n` on L5 apply/verify/rollback, p4-lib.sh, p4-l0-capture.sh, p4-compare.sh — pass
- `git diff --check` — pass
- `node scripts/validate-vault.mjs` — pass

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — L5 live-failure remediation section.

## Shared surfaces touched

- None outside the IDEA3 boundary.

## Integration requests

- Human review and merge before any L5 retry. The frozen L5 runner/probe must be re-frozen (new hashes) after merge because the capture, comparator and handlers changed.

## Known limitations

- Not run live; the kernel-sync behaviour of chronyd after start is still unproven (root cause PARTIAL).
- The owner runner (outside the repository) still needs: capture of the new keys is automatic, but its RB rule and hashes must be reviewed and re-frozen.
- Any retry needs merge, new frozen hashes, fresh authorization, fresh K3 and a fresh one-attempt approval. `Pboo_5G` autoconnect stays `no` until L5 closes or the owner ends the AP runtime.
