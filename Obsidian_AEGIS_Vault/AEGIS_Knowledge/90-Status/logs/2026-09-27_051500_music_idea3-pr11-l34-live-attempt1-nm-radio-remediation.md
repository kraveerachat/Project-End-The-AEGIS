---
title: Task Receipt — IDEA3 PR11 Phase 4 L3/L4 reactivation live attempt 1 failure and NM radio remediation
date: 2026-09-27T05:15:00+07:00
owner: music
area: idea3
branch: fix/idea3-pr11-l34-nm-radio-live-failure
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 PR11 Phase 4 L3/L4 reactivation live attempt 1 failure and NM radio remediation

> [!important] Two different things are recorded here
> **The owner-run live attempt 1 FAILED CLOSED and was rolled back.** Runtime was NOT restored to the active L3/L4 state; only the safe pre-state and safety boundary were restored.
> **This remediation task is repository-only and performed NO host mutation:** no rfkill, NetworkManager, systemd, nftables, forwarding, Twingate, Mosquitto or ESP32 change, no retry, no new authorization records, no frozen runner.

## What changed

- Records the failed attempt:

```text
L34_REACTIVATION_ATTEMPT=1
L34_REACTIVATION_RESULT=FAIL
FAIL_REASON=NM_WIFI_RADIO_DISABLED
ROLLBACK_RESULT=PASS
PRE_RB_COMPARE=PASS
PRESERVATION_S10=PASS
AUTHORIZATION_CONSUMED=YES
RETRY_PERFORMED=NO
```

- Evidence: `/home/kittipat/Workspace/idea3-p4-evidence/2026-09-27-l34-reactivation-20260927-021304`; frozen runner sha256 `2d3157baf34f7b0e79dffd7148c21857e733a2ce806be2e9718682824edf1681` at main `896ca419942af93a73a1218698f1760ad7b6a267`. Apply made exactly one change (`rfkill unblock 1`); rollback re-blocked exactly rfkill 1; the compare showed 0 drift and 3 INFO disk-availability findings.
- Root cause (live journal + readback): after the exact unblock NetworkManager logged "Wi-Fi now enabled by radio killswitch", yet `nmcli radio wifi` stayed `disabled` and the device `unavailable` — NM's own software radio flag is off. There is no target-scoped NM action; enabling the radio is a global change and a new owner decision boundary (OD-L34-RADIO).
- Repository remediation, behind the explicit flag `AEGIS_L34_NM_RADIO_ENABLE=YES` (set by the runner only after the exact V2 scope): sole-Wi-Fi-device / sole-wlan-rfkill / no-active-Wi-Fi preflight; runtime device-autoconnect guard (12 saved Wi-Fi profiles have autoconnect); journaled single `nmcli radio wifi on`; PRE autoconnect restored; verify proves no unrelated Wi-Fi is active; rollback turns the radio off only if this run enabled it. Without the flag the old fail-closed behaviour is unchanged.
- Runner defect fixed: `compare()` had `local kind=${4:-post} rc=0 local -a env_allow` (`not a valid identifier` at run time; `bash -n` cannot see it). Regression tests now execute the function.
- Simulator corrected: it had encoded the wrong assumption that rfkill alone controls NM's radio; it now models the software flag and defaults to the proven live state.
- Comparator unchanged (the exact `nm.general#WIFI disabled -> enabled` rule already existed; the rollback catalog has none).
- Not claimed: runtime restoration, `L3_LIVE_ACCEPTANCE`, `L4_LIVE_ACCEPTANCE`, `K12_AUTOMATIC_REBOOT_PERSISTENCE`.

## Source files changed

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/reactivation/l34/apply.sh`, `verify.sh`, `rollback.sh` — radio model, guards, journal entries.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-l34-reactivation-lib.sh` — topology, active-Wi-Fi and autoconnect gates.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/owner-run/run-l34-reactivation-owner.sh` — `compare()` fix, V2 scope, flag pass-through (still an unpinned template).
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/README.md` — remediation section.
- `IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-09-27-idea3-pr11-phase4-l34-nm-radio-remediation-design.md` — design (new).
- `IDEA3-AEGIS_Lockdown/tests/l34_sim.py`, `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l34_reactivation.py`, `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l34_nm_radio.py` — simulator, updated and new tests.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — failed attempt and remediation section.

## Verification evidence

- `pytest tests/test_pr11_phase4_l34_nm_radio.py` — pass: reproduces the exact live sequence (old workflow fails closed with no global command; rollback restores rfkill), the remediation path, topology refusals, rollback exactness/idempotence, one-attempt and single-activation checks, comparator values and the `compare()` regression.
- `pytest tests -k "pr11_phase4 or broker or mqtt"` — pass: 1617 passed, 2 skipped, 0 failed on the final run (includes L3/L4, capture/compare/harness, L6b runner). An earlier run had one failure in `test_validator_rejects_config_that_real_mosquitto_cannot_start` (real Mosquitto) that did not reproduce: it passed twice in isolation and in the full rerun.
- `bash -n` on all changed scripts — pass; the `compare()` defect is covered by execution tests because `bash -n` accepts it.
- `git diff --check` — pass.
- `node scripts/validate-vault.mjs` — pass (see PR checks).
- Live proof of the remediation — not run: repository-only task.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — attempt 1 FAIL_CLOSED, rolled back, runtime not restored; remediation implemented in the repository only.

## Shared surfaces touched

- None — the task stayed inside IDEA3.

## Integration requests

- None — no cross-scope or shared path changed.

## Known limitations

- The persisted NM `WirelessEnabled` value is unread (root-only file); confirming read: `sudo grep -E '^WirelessEnabled' /var/lib/NetworkManager/NetworkManager.state`.
- Unproven live: `nmcli device set … autoconnect no` while the device is `unavailable`, NM timing after the radio is enabled, and the phy possibly still reporting AP mode after a failed run's rollback.
- The v1 frozen runner and its authorization are spent; a new runner freeze and same-day A-L4 (V2 scope) and K3 are required, after an owner decision on OD-L34-RADIO.
