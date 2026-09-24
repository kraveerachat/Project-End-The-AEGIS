---
title: Task Receipt — IDEA3 PR11 Phase 4 L3 NetworkManager device readiness fix
date: 2026-09-24T19:42:10+07:00
owner: music
area: idea3
branch: fix/idea3-pr11-l3-nm-device-readiness
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 PR11 Phase 4 L3 NetworkManager device readiness fix

## What changed

- Repository-only fix after the third L3 live attempt (rerun5, owner-run): rfkill and Model B regulatory gates passed, then `nmcli connection up` failed ("No suitable device found ... device enp62s0 not available because profile is not compatible with device (mismatching interface name)"). `L3_APPLY=FAIL reason=NMCLI_UP_FAILED`; rollback PASS, no residue, PRE→RB compare PASS (0/0/0), S10 PASS. Attempt truth: `L3_PRODUCTION_MUTATION=YES` (target rfkill soft state + temporary NetworkManager profile), `ROLLBACK_COMPLETE=YES`, `POST_ROLLBACK_RESIDUE=NO`, `L3_LIVE_ACCEPTANCE=NOT_PROVEN`. The comparator's `PRODUCTION_MUTATION_PERFORMED=NO` is comparator-scope only.
- Forensic (read-only journal, ms precision): NM saw the unblock at 19:34:19.8543, activation failed 37 ms later, and no `wlp0s20f3` state change appears in the window; in the earlier rerun3 window NM saw "now enabled" and no state change occurred in 10 s either. Root cause classified: target device stayed `unavailable` in NM (`PROVEN`); NM's persisted software Wi-Fi state ("disabled by state file", `nmcli radio` WIFI disabled) is `STRONGLY_SUPPORTED`, not `PROVEN` (state file is root-only); it is not a short race.
- New read-only gate `p4-l3-nm.sh` wired into `apply.sh` after the rfkill and regulatory gates and before profile install: exact target device state from NetworkManager, only `disconnected` is ready, bounded to 10 polls x 0.5 s, transitions logged, stable reasons `NM_WIFI_RADIO_DISABLED` / `NM_TARGET_DEVICE_NOT_READY` / `NM_TARGET_DEVICE_NOT_FOUND`, never runs `connection up` on failure. Activation is now `nmcli connection up "$CONN_ID" ifname "$AP_IF"`.
- Not changed: AP addressing, DHCP, DNS, NAT, forwarding, M-14 Model B, country intent TH, the effective 00/TH policy, the channel gate, rollback. No `nmcli radio wifi on`, no global rfkill, no `iw reg set`, `enp62s0` never referenced.
- **This fix is not expected to make L3 pass on this host**: it turns an opaque failure into a deterministic, explicit one.
- Owner decision M-15 APPROVED (recorded as a decision, not a proof): `M15_NM_WIFI_STATE_MODEL=OWNER_ONE_TIME_OUTSIDE_L3` — the owner enables NetworkManager's global software Wi-Fi state once outside the L3 stage (`M15_NM_WIFI_ENABLE_COMMAND="sudo nmcli radio wifi on"`). `M15_L3_HANDLER_GLOBAL_RADIO_MUTATION=FORBIDDEN`, `M15_L3_ROLLBACK_GLOBAL_RADIO_MUTATION=FORBIDDEN`, `M15_FRESH_PRE_AFTER_OWNER_CHANGE=REQUIRED` (the enabled NM Wi-Fi state becomes the accepted baseline for L3 and later AP stages), `M15_PR206_MERGE_REQUIRED_BEFORE_L3_RETRY=YES`. No claim that rfkill unblock alone enables the NM target device; no host change was made by this record.

## Source files changed

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-l3-nm.sh` — new read-only NetworkManager readiness gate and bound activation.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/L3/apply.sh` — gate wired before install; activation bound to the approved interface.
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l3_nm_readiness.py` — new, 20 tests with a fake `nmcli`.
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l3_regulatory.py`, `test_pr11_phase4_l3_regulatory_live.py`, `test_pr11_phase4_l3_rfkill.py` — ordering assertions now index `l3_nm_activate` instead of the literal command.

## Verification evidence

- `pytest tests/test_pr11_phase4_l3_nm_readiness.py` against the original `apply.sh` and no helper (RED) — fail: 13 failed, 7 passed; with the fix (GREEN) — pass: 20 passed.
- `pytest tests/test_pr11_phase4_l3_nm_readiness.py tests/test_pr11_phase4_l3_regulatory_live.py tests/test_pr11_phase4_l3_regulatory.py tests/test_pr11_phase4_l3_rfkill.py tests/test_pr11_phase4_l3_handler.py` — pass: 151 passed.
- `pytest tests -k phase4` — pass: 955 passed, 1093 deselected.
- `pytest tests` (full IDEA3, sequential) — pass: 2042 passed, 6 skipped; no flake observed.
- `bash -n p4-l3-nm.sh stages/L3/apply.sh`, `git diff --check`, `node scripts/validate-vault.mjs` (2 pre-existing canvas warnings), diff secret scan — pass.
- Forensics used read-only `journalctl`, `nmcli`, `systemctl` on the live host; no host change.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — third-attempt (rerun5) facts, forensic classification and the fix; the #204 receipt is untouched.

## Shared surfaces touched

- None — task stayed inside `idea3`.

## Integration requests

- None — valid: no cross-scope path changed. The owner decision on the NetworkManager Wi-Fi baseline is made (M-15, one-time owner change outside L3).

## Known limitations

- Not run live. Whether the gate reaches `disconnected` after the owner's one-time NM Wi-Fi enable (M-15) plus the exact rfkill unblock is still unproven; without that baseline the gate reports `NM_WIFI_RADIO_DISABLED` or `NM_TARGET_DEVICE_NOT_READY`.
- `/var/lib/NetworkManager/NetworkManager.state` is root-only, so the state-file cause is not proven.
- Later L-stage handlers (e.g. L4 `nmcli connection up "$CONN_ID"`) were not changed; they need the same explicit binding when refreshed.
- Live evidence bundles are root-only; live facts are the owner's report plus read-only journal checks.
