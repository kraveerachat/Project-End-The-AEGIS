---
title: Task Receipt — IDEA3 PRE-L8p NTP runtime reactivation governed successor (repository only)
date: 2026-10-03T09:52:00+07:00
owner: music
area: idea3
branch: fix/idea3-pre-l8p-ntp-runtime-reactivation
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 PRE-L8p NTP runtime reactivation governed successor (repository only)

> [!important] Repository-only. IMPLEMENTED != DEPLOYED. **Nothing was executed live**: no `systemctl` action, no `/etc/chrony.conf` or `UnitFileState` change, no AP/network/dnsmasq/broker/Core change, no serial/esptool/ESP32 access, no MQTT publish, no CUT/RESTORE, no relay/uplink wiring, no Authorization/K3/attempt marker/frozen runner/evidence directory created. PR #312's branch and the historical L5 receipt were not touched.

```text
BASE_SHA=2f174eca1cf3ad539f3ebec1692bfcc5642eb94d
L5_LIVE_ACCEPTANCE=HISTORICAL_PROVEN_UNCHANGED
K12_AUTOMATIC_REBOOT_PERSISTENCE=NOT_PROVEN
PRE_L8P_NTP_RUNTIME_REACTIVATION=NOT_RUN
NTP_RUNTIME_READY_FOR_L8P=NO
SUCCESSOR_IMPLEMENTATION=REPOSITORY_ONLY
L8P_LIVE_EXECUTED=NO
ESP32_FLASH_PERFORMED=NO
RECOVERY_EXECUTED=NO
LVR_EXECUTED=NO
L8_ACCEPTANCE=NO
PRODUCTION_MUTATION_PERFORMED=NO
```

## What changed

- Root cause of the observed host state: historical L5 mutated runtime `ActiveState` only and never enabled/disabled a unit, so after a reboot `chronyd` is inactive/disabled, `systemd-timesyncd` active/enabled and nothing listens on UDP/123, with `/etc/chrony.conf` still the rendered L5 config. This is consistent with the approved L5 design and `K12 = NOT_PROVEN`, not a regression.
- New governed successor package `pre-l8p-ntp-runtime-reactivation`: read-only PRE gates (exact unit states and `UnitFileState`, AP `10.77.30.1/28` only, approved config SHA-256 equal to the L5 renderer output, no alternate chronyd config path, no port-123 listener, shared L5 TrustedClock predicate); apply = exactly `systemctl stop systemd-timesyncd.service` then `systemctl start chronyd.service`; read-only verify (exact `udp 10.77.30.1:123`, no wildcard, TrustedClock SYNCED within the L5 bound, config SHA-256/metadata PRE == POST, `UnitFileState` unchanged); runtime-only rollback that proves but never repairs `UnitFileState` and the config.
- Governance: fresh same-day `stage=L5` Authorization/K3 bound by the exact `PRE_L8P_NTP_RUNTIME_REACTIVATION` scope, dedicated one-attempt marker consumed after preflight/PRE capture/pre-consume S10 guard and before the first mutation, frozen operator identity and runner digest (runner refused if inside the repository), historical L5 reference and any foreign attempt marker refused, no automatic retry. Inert `PIN_*` runner template.
- `allow-keys.txt` is a strict subset of the historical L5 catalog without `/etc/chrony.conf` or `UnitFileState` keys. `stages/L5` is unchanged.

## Source files changed

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-ntp-reactivation-lib.sh` (new) — constants and read-only gate library
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/reactivation/pre-l8p-ntp-runtime-reactivation/{apply,verify,rollback}.sh, allow-keys.txt, allow-listeners.txt` (new)
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/owner-run/run-pre-l8p-ntp-runtime-reactivation-owner.sh` (new, inert template)
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/README.md` — section 11
- `IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-10-03-idea3-pre-l8p-ntp-runtime-reactivation-design.md` (new)
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_pre_l8p_ntp_reactivation.py`, `…_owner_run_flow.py` (new)

## Verification evidence
- `pytest tests/test_pr11_phase4_pre_l8p_ntp_reactivation.py tests/test_pr11_phase4_pre_l8p_ntp_reactivation_owner_run_flow.py` — PASS, 154 passed (all results here are from the dedicated NTPREACT worktree after migration; origin/main re-fetched, still `2f174eca`; simulated host only, nothing live).
- Overlap: `pytest tests/test_pr11_phase4_l5_*.py tests/test_pr11_phase4_ntp.py tests/test_pr11_phase4_l34_*.py tests/test_pr11_phase4_dnsmasq_*.py tests/test_pr11_phase4_harness.py tests/test_pr11_phase2_harness.py` — PASS, 1949 passed, 3 skipped.
- `bash -n` on the lib, owner-run runner, apply/verify/rollback — PASS.
- `git diff --cached --check` — PASS.
- `node scripts/validate-vault.mjs --vault Obsidian_AEGIS_Vault/AEGIS_Knowledge` — PASS (0 errors).
- Collaboration policy check and changed-line secret scan — PASS (see PR body).

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — new "PRE-L8p NTP runtime reactivation successor" section. No historical receipt edited.

## Shared surfaces touched

- `None` — all code is under `IDEA3-AEGIS_Lockdown/`.

## Integration requests

- None — valid only when no cross-scope/shared path changed

## Known limitations

- Simulated-host proof only; the real PRE gates, apply, comparator window and rollback have never run on the host.
- A live run still needs: independent review and merge, a NEW exact-main frozen runner and operator pin, a brand-new same-day AUTH_DIR/Authorization/K3, fresh read-only S10 proof and explicit owner authorization. This PR creates none of them.
- The approved config SHA-256 is pinned from the L5 live receipt; if the host file was edited after L5 the PRE gate refuses (fail-closed) and reconciliation is a separate owner decision.
