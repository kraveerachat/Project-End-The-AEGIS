---
title: Task Receipt — IDEA3 dnsmasq repair SAFE_STOPPED governed successor + pre-consume S10 guard (repository only)
date: 2026-10-03T04:05:00+07:00
owner: music
area: idea3
branch: fix/idea3-dnsmasq-safe-stopped-successor
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 dnsmasq repair SAFE_STOPPED governed successor + pre-consume S10 guard (repository only)

> [!important] Repository-only. IMPLEMENTED != DEPLOYED. **Nothing was executed live**: no dnsmasq start/stop/restart/reset-failed, no real `daemon-reload`, no NetworkManager/AP/nftables/forwarding change, no Core/broker/Twingate/IDEA2 restart, no Authorization/K3/frozen runner/marker created, no Recovery/L8p, no ESP32, no reboot.

```text
FIRST_ATTEMPT=CONSUMED_FAILED_S10
DNSMASQ_APPLY_VERIFY_IN_FIRST_ATTEMPT=PASS
FIRST_ATTEMPT_ROLLBACK_HANDLER=PASS
FIRST_ATTEMPT_FINAL_VERDICT=ROLLBACK_FAILED_ESCALATE
ROOT_CAUSE=IDEA2_TUNNEL_RESOURCE_AUTH_SESSION_NOT_ACTIVE
S10_RECOVERY_PROOF=PASS
SAFE_STOPPED_BASELINE=OBSERVED
SUCCESSOR_IMPLEMENTATION=REPOSITORY_ONLY
SUCCESSOR_LIVE_EXECUTED=NO
OLD_ATTEMPT_RETRY_ALLOWED=NO
ESP32_TOUCHED=NO
```

## What changed

- The historical first attempt is recorded truthfully and unchanged (consumed; apply/verify PASS; failed closed at S10 because IDEA2 was already unhealthy; rollback PASS; final PRE→RB compare failed on the same pre-existing IDEA2 baseline). Root cause: the Twingate daemon was active but the interactive Twingate Resource authorization was not; `twingate start` restored it and the existing `Restart=always` IDEA2 tunnel recovered. No daemon or Connector defect is claimed. Local evidence (not committed): `~/Workspace/idea3-p4-evidence/2026-10-03-dnsmasq-unit-repair-20261003-032626` and `…/2026-10-03-s10-recovery-20261003-034414`.
- Exact `SAFE_STOPPED` baseline (loaded/enabled/inactive/dead/success/MainPID 0 + old unit digest + no dnsmasq listener + all existing gates); every other inactive shape still refuses. SAFE_STOPPED apply = `daemon-reload` + `start` only (no reset-failed, no restart); rollback is journal-owned: old unit bytes, `daemon-reload`, `stop` only if this attempt started it, back to exact SAFE_STOPPED. FAILED/RUNNING unchanged.
- New task-specific comparator operation `DNSMASQ_SAFE_STOPPED_POST` (inactive→active, dead→running only) in `p4-compare.sh` + `allow-dynamic-transitions-safe-stopped-post.txt`; no existing catalog widened; `p4-compare.sh` intentionally re-pinned in the three tests that pin it.
- Pre-consume S10 stability guard in the owner runner: second canonical capture after a frozen 30 s window, canonical compare PRE→S10 with no allowance, five exact lines required; failure → `NOT_STARTED_NO_MUTATION`, no marker, authorization unconsumed. This catches the historical "IDEA2 tunnel unhealthy / :18002 absent" condition before consumption.
- Successor governance: the historical consumed AUTH_DIR is on a hard denylist and any AUTH_DIR with a consumed marker is refused; a brand-new same-day AUTH_DIR is required; no automatic retry.

## Source files changed

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-dnsmasq-repair-lib.sh` — SAFE_STOPPED classifier, successor constants
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-compare.sh` — additive `DNSMASQ_SAFE_STOPPED_POST` catalog
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/reactivation/dnsmasq-unit-boot-order-repair/apply.sh` — SAFE_STOPPED preflight and start-only sequence
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/reactivation/dnsmasq-unit-boot-order-repair/rollback.sh` — SAFE_STOPPED rollback
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/reactivation/dnsmasq-unit-boot-order-repair/allow-dynamic-transitions-safe-stopped-post.txt` (new)
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/owner-run/run-dnsmasq-unit-boot-order-repair-owner.sh` — S10 guard, SAFE_STOPPED compare, historical AUTH_DIR denylist (still inert as committed)
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/README.md` — section 10.1
- `IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-10-03-idea3-dnsmasq-safe-stopped-governed-successor-design.md` (new)
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_dnsmasq_safe_stopped_successor.py` (new)
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_dnsmasq_unit_repair_owner_run_flow.py` — successor/S10 guard tests; sim substitutes only the frozen window line
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_dnsmasq_unit_repair.py` — the obsolete "plain inactive refuses" case narrowed to a wrong-Result inactive
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_dnsmasq_unit_repair_reboot_and_scope.py` — frozen file set + `p4-compare.sh` re-pin
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l34_v6_clock_stabilization.py`, `…_l34_v8_scope_contract.py` — `p4-compare.sh` re-pin only

## Verification evidence

- New/changed tests written before the implementation was judged done; red check: the new successor + runner-flow tests run against unmodified `origin/main` code → 94 failed, 17 passed (they fail without the change).
- `pytest tests/test_pr11_phase4_dnsmasq_safe_stopped_successor.py` — pass: 63 passed. `…owner_run_flow.py` — pass: 48 passed.
- Full IDEA3 suite `pytest -q tests` (36m58s): **6040 passed, 11 skipped, 1 failed** — the failure is `test_pr11_phase4_l8p_owner_runner.py::test_run_against_the_current_repository_state_fails_closed` (`L8P_ALREADY_PROVISIONED`, host-state dependent); it fails identically on pristine `61786bfb` (not caused by this change). Targeted/overlap suites re-run after the docs were added: see PR body.
- `bash -n` on every changed shell script — pass; `git diff --check` — pass; changed-line secret/material scan — no findings; `node scripts/validate-vault.mjs` — pass (2 existing canvas warnings); collaboration policy — pass against the PR body.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — new successor section; stale "Draft PR, not merged" clause of the PR #308 section corrected. No historical receipt edited.

## Shared surfaces touched

- `None` — all code is under `IDEA3-AEGIS_Lockdown/`.

## Integration requests

- None — valid only when no cross-scope/shared path changed

## Known limitations

- Simulated-host proof only. The first real S10 guard capture, SAFE_STOPPED apply and its comparator window have never run on the host.
- A successor still needs: independent review and merge, a NEW exact-main frozen runner, a brand-new same-day AUTH_DIR/Authorization/K3, fresh read-only S10 proof and explicit owner authorization. This PR creates none of them.
- The 30 s guard window is a judgement call; it catches a restart-looping/absent tunnel but is not a proof of long-term IDEA2 stability.
- One host-state-dependent L8p test fails on main and here (see above).
