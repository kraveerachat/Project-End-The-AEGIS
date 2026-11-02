---
title: Task Receipt — IDEA3 RESTORE after an uncommanded lockdown
date: 2026-10-24T10:30:00+07:00
owner: music
area: idea3
branch: fix/idea3-restore-after-uncommanded-lockdown
status: partial
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 RESTORE after an uncommanded lockdown

## What changed

- A new operator RESTORE is no longer refused with `RESTORE_ALREADY_PENDING` after a RESTORE that was already physically confirmed
  when the device later locks down without any Core command (dead-man's switch, power loss, a frozen Core). Found in the lab
  on 2026-10-24: after a confirmed RESTORE, a dead-man LOCKDOWN left a stale record and every RESTORE was refused until a CUT
  replaced the record or the Core restarted.
- The guard keeps its purpose: a RESTORE that is ACKed but not yet confirmed by the device (matching nonce and expected state)
  is still refused, and every other check (COMMAND_PENDING, UPLINK_NOT_LOCKDOWN, authentication, incident and episode checks,
  the one-shot attempt row) is unchanged.

## Source files changed

- `IDEA3-AEGIS_Lockdown/aegis_soc/local_restore.py` — new `_restore_awaits_evidence()` used at both call sites (normal RESTORE and
  break-glass): pending only while the RESTORE is ACKed and `physical_confirmed_at` is unset
- `IDEA3-AEGIS_Lockdown/tests/test_local_restore.py` — regression tests for the normal path (DEADMAN and BOOT), plus tests that an
  ACKed-but-unconfirmed RESTORE, a contradicting correlated status, and a RESTORE awaiting its ACK are still refused
- `IDEA3-AEGIS_Lockdown/tests/test_core_break_glass.py` — the same pair for the break-glass call site

## Verification evidence

- The new regression tests failed on unmodified `main` `cc096de` with `RESTORE_ALREADY_PENDING` (4 failed, 4 guard-purpose tests passed) and pass with the fix.
- `pytest tests/test_local_restore.py tests/test_core_break_glass.py` — 221 passed.
- 12 related files (guard users, recovery, runtime, acceptance) — 813 passed, 10 skipped.
- Full suite in 12 parallel shards, fix branch vs clean `main` (display disabled): no test fails on the branch that does not also fail on `main`;
  error sets identical; 12 more passes on the branch (8 new tests and 4 load-sensitive tests that failed only on `main` in the parallel
  run and pass alone on `main`). Pre-existing failures are the owner-run/governance tests already listed for `main`.
- `ruff check` on the three changed files — pass.
- No hash pin covers `local_restore.py` (pinned: `recovery_core.py`, `recovery_protocol.py`, `recovery_evidence.py`, `r1_acceptance.py`; none touched).

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — added the finding and the fix state

## Shared surfaces touched

- None — task stayed inside its selected area

## Integration requests

- None — valid only when no cross-scope/shared path changed

## Known limitations

- Verified with offline tests only; not yet re-run on the lab hardware.
- A RESTORE that was ACKed but whose status evidence will never arrive (device power-cycled before the matching status) is still
  refused until a CUT replaces the record or the Core restarts. That is the guard's original purpose; whether it should expire is an owner decision.
- The release builder and closure tests already fail on clean `main` in this environment, so they cannot confirm that a release
  package containing `local_restore.py` will still verify; rebuild any release package from this source.
- Core code change: needs owner review before any production use. Not pushed.
