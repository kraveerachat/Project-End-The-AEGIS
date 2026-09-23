---
title: Task Receipt — IDEA3 PR11 Phase 4 evidence-harness fix (UDP listeners, passive chrony)
date: 2026-09-24T02:16:03+07:00
owner: music
area: idea3
branch: fix/idea3-pr11-phase4-evidence-harness
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 PR11 Phase 4 evidence-harness fix (UDP listeners, passive chrony)

## What changed

- `p4-l0-capture.sh` no longer records transient UDP sockets bound to kernel-assigned ephemeral ports as listeners. UDP sockets whose local port lies inside the host `ip_local_port_range` are excluded from the per-port inventory; the range is recorded as `listen.udp.ephemeral_filter` (`kernel-range-LO-HI`, or `none-range-unreadable` which disables filtering). Fixed UDP listeners (DNS, DHCP, NTP, IDEA3 ports) and all TCP listeners keep their semantics. No port number is special-cased.
- A passive L1 chrony state (chronyc present, `chronyd.service` loaded and `inactive`, tracking query failing) is recorded as `time.chrony.leap=installed-inactive`. Any other failed or unparseable chrony query stays `UNAVAILABLE` and fails closed. Active chrony still reports its leap status.
- `p4-compare.sh` is unchanged: its `UNAVAILABLE` check already runs before approved-key handling, so an approved key cannot turn unreadable evidence into PASS (locked by a new test).
- Context: the 2026-09-24 L1 live attempt was rolled back; formal S10 proof is `BLOCKED_BY_EVIDENCE_HARNESS`; no L2 ran. This task performed no Production mutation.

## Source files changed

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-l0-capture.sh` — UDP ephemeral filter and passive-chrony sentinel
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_harness.py` — RED→GREEN tests, port-range fixture, `extra_tools` fixture option
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — canonical status

## Verification evidence

- `pytest tests/test_pr11_phase4_harness.py -k "udp or chrony"` before the fix — fail: 5 failed / 8 passed (ephemeral rotation produced 6 LISTENER_ADDED/REMOVED findings; filter-policy key absent; range-unreadable key absent; `time.chrony.leap` was `UNAVAILABLE`, not `installed-inactive`).
- same command after the fix — pass: 13 passed.
- `pytest tests/test_pr11_phase4_*.py` — pass: 824 passed.
- `pytest tests` (IDEA3 full) — pass: 1911 passed, 6 skipped.
- `bash -n deploy/pr11-phase4/p4-l0-capture.sh` — pass. `shellcheck` — not run (not installed).

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — L1 live attempt rolled back, formal S10 proof blocked by the harness, harness-fix semantics.

## Shared surfaces touched

- `None` — task stayed inside its selected area

## Integration requests

- None — valid only when no cross-scope/shared path changed

## Known limitations

- L1 live results in this receipt are as reported by the owner; the agent did not run the apply, verify, rollback or the original comparisons.
- A real UDP service bound inside the ephemeral port range is not distinguishable from a client socket by `ss` output alone and is not inventoried.
- The historical `pre-root`, `post-root` and `rb-root` bundles lack the new keys and are not comparable under the fixed semantics; a fresh L1 PRE window is required.
- Identical `UNAVAILABLE` chrony values on both sides are still ignored by the pre-existing `b == a` rule for `time.chrony.*`.
- No live-host verification of the fixed capture was performed.
