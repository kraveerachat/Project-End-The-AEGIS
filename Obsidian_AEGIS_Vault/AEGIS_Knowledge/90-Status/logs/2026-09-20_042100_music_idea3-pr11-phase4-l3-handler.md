---
title: Task Receipt — IDEA3 PR11 Phase 4 L3 AP-radio runtime handler
date: 2026-09-20T04:21:00+07:00
owner: music
area: idea3
branch: feat/idea3-pr11-phase4-l3-handler
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 PR11 Phase 4 L3 AP-radio runtime handler

## What changed

- Registered the reviewed L3 stage handler (`stages/L3/`) with the T1 stage framework for the AP-radio runtime contract.
- Implemented `stages/L3/apply.sh`, `stages/L3/verify.sh`, `stages/L3/rollback.sh`, `stages/L3/allow-keys.txt`, and `stages/L3/allow-listeners.txt`.
- Restricted L3 scope strictly to AP radio on target interface `wlp0s20f3`: NetworkManager WPA2-PSK profile materialization (`/etc/NetworkManager/system-connections/aegis-idea3-ap.nmconnection`), 2.4 GHz AP mode, channel/regulatory domain verification, and target-specific soft-rfkill unblock.
- Strictly excluded AP addressing, DHCP, and DNS services from L3 (these belong to L4).
- Enforced zero NAT, zero masquerade/SNAT/DNAT, zero bridge creation, zero forwarding enable, zero nftables mutation, zero sysctl mutation, zero Mosquitto/NTP mutation, and zero listener additions (`allow-listeners.txt` has 0 active entries).
- Hardened capture and compare schema in `p4-l0-capture.sh` and `p4-compare.sh`: decomposed broad aggregate keys (`nm.active`, `nm.devices`, `wifi.dev.sha256`, `wifi.rfkill.wlan`) into deterministic per-device/per-interface keys (`nm.device.<iface>.*`, `nm.active.device.<iface>`, `wifi.iface.<iface>.*`, `wifi.rfkill.iface.<iface>.*`).
- Enforced that `nm.general`, `wifi.reg.*`, `wifi.rfkill.*.(id|hard)`, and `net.dns.*` are strictly protected and cannot be approved by allowlists.
- Removed all broad aggregate keys and synthetic fixture interfaces (`wlan-test0`) from Production `stages/L3/allow-keys.txt`.
- Enforced target guard: live mode strictly requires target interface `wlp0s20f3`.
- Enforced secret safety: PSK accepted only from private regular file (mode 0600/0400; never from CLI argument); no secret or PSK committed.
- Enforced complete fixture/live separation: fixture mode writes only beneath `AEGIS_P4_FS_ROOT` and executes zero live host mutations.
- Preserved existing L2 and L6b registrations and contracts.
- No live L3 execution was performed; no Production or network mutation occurred. PR #160 remains Draft at closeout.

Implementation checkpoint SHA: `49c0872f329409d735d3668028a559e4c45b481f`
The closeout commit containing this receipt is created after this receipt is staged.

```text
L2_HANDLER                   = REGISTERED
L3_HANDLER                   = REGISTERED
L4_HANDLER                   = NOT_REGISTERED
L5_HANDLER                   = NOT_REGISTERED
L6A_HANDLER                  = NOT_REGISTERED
L6B_HANDLER                  = REGISTERED

L2                           = NOT RUN
L3                           = NOT RUN
L4                           = NOT RUN
L5                           = NOT RUN
L6A                          = NOT RUN
L6B                          = NOT RUN

PRODUCTION_MUTATION          = NO
NETWORK_MUTATION             = NO
REAL_WIFI_MUTATION           = NO
REAL_RFKILL_MUTATION         = NO
REAL_NETWORKMANAGER_MUTATION = NO
LIVE_L3                      = NOT RUN
PHASE4_RUNTIME_COMPLETE      = NO
PHASE4_LIVE_READINESS        = NOT READY
```

## Source files changed

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-compare.sh` — hardened drift classifications and unapprovable protected key patterns.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-l0-capture.sh` — decomposed broad aggregate NM, Wi-Fi, and rfkill state into narrow per-device/per-interface records.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/L3/allow-keys.txt` — restricted permitted drift strictly to target `wlp0s20f3` keys; zero broad aggregate or fixture keys.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/L3/allow-listeners.txt` — verified zero permitted listener additions (0 active entries).
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/L3/apply.sh` — L3 AP radio materialization and activation handler with fail-closed target guard.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/L3/rollback.sh` — idempotent L3 rollback handler removing profile and restoring radio state.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/L3/verify.sh` — read-only verification of L3 radio state, interface, and security parameters.
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_harness.py` — updated fixture assertions and negative controls for narrow per-device/per-interface capture.
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l3_handler.py` — comprehensive regression suite for L3 handler, allowlists, and negative drift controls.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/README.md` — updated handler registration status and added L3 handler documentation.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — recorded canonical L3 handler registration facts, test evidence, and safety boundaries.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-09-20_042100_music_idea3-pr11-phase4-l3-handler.md` — this immutable task receipt.

## Verification evidence

- Bash syntax validation (`bash -n` on `p4-l0-capture.sh`, `p4-compare.sh`, `stages/L3/apply.sh`, `stages/L3/verify.sh`, `stages/L3/rollback.sh`): PASS.
- Focused L3 pytest (`test_pr11_phase4_l3_handler.py`): 20 passed, 0 warnings.
- Phase 4 harness pytest (`test_pr11_phase4_harness.py`): 160 passed.
- AP-network pytest (`test_pr11_phase4_ap_network.py`): 55 passed.
- All Phase 4 pytest suite (`test_pr11_phase4_*.py`): 307 passed.
- Broad allowlist scan (`grep -nE '^(nm\.active|nm\.devices|nm\.general|wifi\.dev\.sha256|wifi\.rfkill\.wlan)$|wlan-test0' stages/L3/allow-keys.txt`): PASS (0 matches).
- Listener allowlist check (`stages/L3/allow-listeners.txt`): 0 active entries.
- `node --test --test-concurrency=1 tests/collaborationPolicy.test.mjs`: PASS (24 passed, 0 failed).
- `node --test --test-concurrency=1 tests/vaultMultiWriter.test.mjs`: PASS (1 passed, 0 failed).
- `node --test --test-concurrency=1 tests/vaultStructure.test.mjs`: PASS (25 passed, 0 failed).
- `node scripts/validate-vault.mjs --vault Obsidian_AEGIS_Vault/AEGIS_Knowledge`: PASS (with the 2 pre-existing Canvas owner-review warnings).
- `git diff --check`: PASS (clean).
- BASH stage registration probe:
  - `L2   REGISTERED`
  - `L3   REGISTERED`
  - `L4   NOT_REGISTERED`
  - `L5   NOT_REGISTERED`
  - `L6a  NOT_REGISTERED`
  - `L6b  REGISTERED`

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — records repository-only L3 handler registration, test results, verification evidence, unchanged live boundaries, and the open IDEA2 preservation caveat.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/README.md` — updates stage rollback handlers summary to `L2, L3, L6b REGISTERED` and adds the L3 handler scope/boundary documentation.

## Shared surfaces touched

- None — task stayed strictly inside IDEA3 ownership.
- No IDEA1 or IDEA2 runtime/configuration surface was modified.

## Integration requests

- Human code-owner review required.
- Human merge required.
- PR #160 remains Draft at closeout; marking Ready for Review is reserved for human review.
- This receipt does not authorize live L3.
- Future live L3 remains separately gated by:
  - L2 live PASS
  - fresh same-day A-L3 authorization
  - fresh K3 key
  - approved owner-supplied values (OV-01, OV-02, OV-04)
  - required management-path proof
  - resolution or formally accepted reconciliation of the open IDEA2 §10 caveat
  - all standard stop conditions.

## Known limitations

- L3 handler repository registration does not prove live execution.
- L3 remains NOT RUN.
- L4/L5/L6a remain unregistered.
- L2 and L6b are registered but remain NOT RUN.
- IDEA2 §10 preservation caveat remains open and blocking.
- Addressing, DHCP, and DNS belong to L4 and are not provided by L3.
- PHASE4_RUNTIME_COMPLETE remains NO.
- PHASE4_LIVE_READINESS remains NOT READY.
