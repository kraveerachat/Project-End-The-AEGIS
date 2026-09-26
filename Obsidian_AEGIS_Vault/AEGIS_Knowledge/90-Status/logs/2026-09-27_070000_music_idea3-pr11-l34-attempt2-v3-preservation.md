---
title: Task Receipt — IDEA3 PR11 Phase 4 L3/L4 reactivation live attempt 2 and V3 preservation remediation
date: 2026-09-27T07:00:00+07:00
owner: music
area: idea3
branch: fix/idea3-pr11-l34-v3-preservation-sideeffects
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 PR11 Phase 4 L3/L4 reactivation live attempt 2 and V3 preservation remediation

> [!important] Two different things are recorded here
> **Owner-run live attempt 2 reached the accepted runtime (apply PASS, verify PASS) and then failed the preservation comparison; the rollback handler passed but the pre-state was NOT restored byte-for-byte.** Final acceptance is NOT proven.
> **This remediation task is repository-only and performed NO host mutation:** no retry, no authorization records, no runner freeze, no `wpa_supplicant` stop, no p2p device removal, no regulatory-domain change, no NetworkManager restart, no L6b, no ESP32/Twingate change.

## What changed

- Records the attempt (evidence `/home/kittipat/Workspace/idea3-p4-evidence/2026-09-27-l34-reactivation-20260927-032057`):

```text
L34_REACTIVATION_ATTEMPT=2
AUTHORIZATION_CONSUMED=YES
RETRY_PERFORMED=NO

L34_APPLY=PASS
L34_VERIFY=PASS
NM_RADIO_REMEDIATION=PASS

PRE_POST_COMPARE=FAIL
PRESERVATION_S10=FAIL

L34_ROLLBACK_HANDLER=PASS
PRE_RB_COMPARE=FAIL

SAFE_NETWORK_BOUNDARY_RESTORED=YES
EXACT_PRESTATE_RESTORED=NO

FINAL_ACCEPTANCE=NOT_PROVEN
L6B_REMAINS_BLOCKED=YES
```

- Rollback is **not** called exact. Safe boundary (rfkill 1 soft-blocked, radio disabled, target unavailable/DOWN/managed, no Wi-Fi active, dnsmasq inactive, AP not active) is recorded separately from exact pre-state (not achieved).
- Proven side effects, all created by NetworkManager Wi-Fi initialization: the p2p pseudo-device `p2p-dev-wlp0s20f3`, `wpa_supplicant.service` started (unit disabled, `NRestarts=0`, `Result=success`), target phy `00 -> TH` (already approved), and a raw `wifi.phy.sha256` change caused by regulatory annotations on the `iw phy` frequency entries (channel 14 `22 dBm -> disabled`, 5 GHz `no IR` / `radar detection`). The residuals stayed identical for more than two minutes.
- V3 preservation model in the comparator (opt-in, closed catalogs, value classes; wpa_supplicant and phy-digest rules are relational to the authorized radio transition, the active AP, absence of unrelated Wi-Fi, unit facts, the approved `00 -> TH` transition, an equal regulatory-insensitive digest and channel 6 permitted). No generic `wifi.phy.sha256` or `wpa_supplicant` allow key.
- New capture keys `wifi.phy.regnorm_sha256` and `wifi.phy.channel6_permitted` from `p4-iw-phy-regnorm.awk`.
- Handlers: V3 baseline classification (FRESH and the proven RESIDUAL baseline accepted, mixed rejected before any mutation), exact-envelope verify, rollback that reports the safe boundary separately from exactness.
- Runner template: V3 scope (168 chars), baseline-driven catalog selection, L6b-inactive / no-8883 re-check in the rollback flow; still an unpinned template.
- Not claimed: final acceptance, runtime restoration, L3/L4 acceptance, K12 automatic reboot persistence.

## Source files changed

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-compare.sh` — V3 operations, value classes, relational gates.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-l0-capture.sh`, `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-iw-phy-regnorm.awk` — regulatory-insensitive phy digest and channel-6 fact (new helper).
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-l34-reactivation-lib.sh` — baseline classification helpers.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/reactivation/l34/apply.sh`, `verify.sh`, `rollback.sh` — V3 baseline, envelope and safe-boundary proofs.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/reactivation/l34/allow-dynamic-transitions-v3-post-fresh.txt`, `…-v3-post-residual.txt`, `…-v3-rollback-fresh.txt`, `…-v3-rollback-residual.txt` — exact catalogs (new).
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/owner-run/run-l34-reactivation-owner.sh` — V3 scope and baseline-driven comparison (unpinned template).
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/README.md` — V3 section.
- `IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-09-27-idea3-pr11-phase4-l34-v3-preservation-design.md` — design (new); `…l34-nm-radio-remediation-design.md` — supersession note.
- `IDEA3-AEGIS_Lockdown/tests/l34_sim.py`, `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l34_reactivation.py`, `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l34_nm_radio.py`, `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l34_v3_preservation.py`, `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l34_v3_handlers.py` — simulator and tests.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — attempt 2 and V3 section.

## Verification evidence

- `pytest tests/test_pr11_phase4_l34_v3_preservation.py tests/test_pr11_phase4_l34_v3_handlers.py` — pass: reproduces the exact live comparator findings (8 drift findings PRE->POST, the residuals PRE->RB) under the V2 files and turns them green under V3; wrong p2p name/type/state, enabled unit, restarts, unrelated Wi-Fi, non-regulatory phy deltas, unsafe rollback residuals and mixed baselines all still fail.
- `pytest tests -k "pr11_phase4 or broker or mqtt"` — pass: 1769 passed, 2 skipped, 0 failed (includes L3/L4, capture/compare/harness, L6b runner and earlier L34 suites).
- `bash -n` on all changed scripts — pass; `git diff --check` — pass; `node scripts/validate-vault.mjs` — pass (see PR checks).
- One test-run intermittent failure was seen twice during development in `test_pr11_phase4_l34_v3_handlers.py` (two verify-envelope cases in one run, one case in another) and did not reproduce in 18 further full-file/targeted reruns or in the final full regression; the cause was not identified. Recorded, not hidden.
- Live proof of V3 — not run: repository-only task.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — attempt 2 runtime PASS, preservation INCOMPLETE, rollback safe-equivalent only, V3 remediation repository-only.

## Shared surfaces touched

- None — the task stayed inside IDEA3.

## Integration requests

- None — no cross-scope or shared path changed.

## Known limitations

- Nothing is proven on the real host; the simulator models NetworkManager, wpa_supplicant, p2p and the regulatory move.
- The current host is in the RESIDUAL baseline (p2p unavailable, wpa_supplicant running, phy `TH`); V3 is designed to accept it but has not been run.
- A fresh authorization, a newly frozen runner and one more bounded attempt are required; the V2 authorization and runner are spent.
- The rollback boundary is safe-equivalent, not exact; `wpa_supplicant` is deliberately not stopped (that would need its own owner decision).
