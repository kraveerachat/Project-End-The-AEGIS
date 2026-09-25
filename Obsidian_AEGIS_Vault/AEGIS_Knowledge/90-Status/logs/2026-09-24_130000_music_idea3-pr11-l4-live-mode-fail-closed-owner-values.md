---
title: Task Receipt — IDEA3 PR11 Phase 4 L4 live-mode fail-closed owner values
date: 2026-09-24T13:00:00+07:00
owner: music
area: idea3
branch: fix/idea3-pr11-l4-live-values-fail-closed
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 PR11 Phase 4 L4 live-mode fail-closed owner values

## What changed

- Live L4 (`AEGIS_P4_FS_ROOT` unset) no longer falls back to the `192.0.2.x` / `mqtt.aegis.invalid` documentation defaults: `AEGIS_AP_INTERFACE`, `AEGIS_AP_ADDRESS`, `AEGIS_AP_SUBNET`, `AEGIS_DHCP_START`, `AEGIS_DHCP_END`, `AEGIS_BROKER_HOSTNAME` must be explicit (`LIVE_REQUIRES_EXPLICIT_<VAR>`); fixture mode keeps its defaults.
- Live-only rejections: documentation ranges, non-private/CGNAT/link-local subnets, reserved hostnames (`.invalid/.example/.test/.local/.localhost`); all modes: subnets longer than /30, RFC1123 label checks; overlap check now also covers routed prefixes (`ip -4 route show`).
- Validation moved before any work-dir/profile state; new `AEGIS_L4_VALUES_ONLY=YES` validates and exits with no mutation (usable as an owner pre-check).
- Read-only check: `10.77.30.0/28` overlaps none of 192.168.1.0/24, 100.96.0.0/12, 192.168.10.10/32 or current interfaces/routes; no Docker network present.
- Refresh after L3 live acceptance (PR #207, main `70b0fdf0`; merged `origin/main` into this branch, no textual conflict): live L4 now requires the applied L3 AP (AP type, SSID `AEGIS-IDEA3`, channel 6, no IPv4, no global IPv6, no AP default route, alternate default route) and runs the M-14 regulatory/channel gate read-only before the profile changes (`p4-l4-live.sh`, reusing `l3_reg_gate`).
- Reactivation is bound with `nmcli connection up "$CONN_ID" ifname "$AP_IF"` (also in `rollback.sh`), then `l3_reg_verify_active` re-checks AP type, exact channel 6, target-phy country TH-or-00 and an unrestricted channel before dnsmasq starts; SSID re-checked.
- New `stages/L4/allow-transitions.txt` (`stage L4` + `wifi.reg.<AEGIS_AP_PHY> 00 TH`); `p4-compare.sh` accepts exactly one of `stage L3`/`stage L4`. Target phy accepts only 00->00, 00->TH, TH->TH; TH->00 and other regulatory drift fail. No `iw reg set`, `nmcli radio wifi on`, rfkill, NAT or forwarding enable; M-15 baseline stays outside L4.
- Repository-only. `PRODUCTION_MUTATION_PERFORMED=NO`, live stage not executed, `PR11_COMPLETE=NO`.

## Source files changed

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/L4/apply.sh`
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/L4/verify.sh`
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l4_live_values.py`
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-l4-live.sh`
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-compare.sh`
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/README.md`
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/L4/allow-transitions.txt`
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/L4/rollback.sh`
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l4_reactivation_gate.py`
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_harness.py`
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l3_regulatory.py`

## Verification evidence

- `pytest tests/test_pr11_phase4_l4_live_values.py tests/test_pr11_phase4_l4_handler.py tests/test_pr11_phase4_ap_network.py` — pass: 153 passed
- RED first: `pytest tests/test_pr11_phase4_l4_reactivation_gate.py` before implementation — 38 failed, 12 passed
- `pytest tests/test_pr11_phase4_l4_reactivation_gate.py` after implementation — pass: 50 passed
- `pytest tests/test_pr11_phase4_*.py tests/test_pr11_k10_server_ca.py` — pass: 1088 passed
- `pytest tests` (IDEA3 full, sequential) — pass: 2139 passed, 6 skipped
- `bash -n` on touched shell scripts — pass
- `git diff --cached --check` — pass
- `node scripts/validate-vault.mjs` — pass (2 pre-existing canvas warnings)
- staged-diff secret scan — pass: no hits
- `scripts/validate-collaboration-policy.mjs` on the PR body and changed files — pass

## Canonical notes updated

- `None` — repository-only fix; no durable project status fact changed (the L3 fix PR carries the canonical status update, avoiding parallel edits to the same note).

## Shared surfaces touched

- `None` — task stayed inside its selected area

## Integration requests

- None — valid only when no cross-scope/shared path changed

## Known limitations

- Live L4 not executed; `L4_LIVE_ACCEPTANCE=NOT_PROVEN`. Tests use fake `iw`/`nmcli`/`ip`; the full live apply path needs root and real `/etc` and is not exercised.
- The comparator's L4 transition window is fixture-verified only; the live phy state at L4 start is read, never assumed TH (M-14 Model B).
- dnsmasq unit ordering/enablement across reboot (K12) is not addressed.
