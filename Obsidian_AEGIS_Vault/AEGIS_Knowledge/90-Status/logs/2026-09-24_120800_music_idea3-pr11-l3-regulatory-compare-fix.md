---
title: Task Receipt — IDEA3 PR11 Phase 4 L3 regulatory comparator fix (Option 1(a))
date: 2026-09-24T12:08:00+07:00
owner: music
area: idea3
branch: fix/idea3-pr11-l3-regulatory-compare
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 PR11 Phase 4 L3 regulatory comparator fix (Option 1(a))

## What changed

- Repository-only fix. Observed live (read-only): global and `phy0` regulatory state `00` while the target radio is soft-blocked; approved country `TH`. The generic comparator treats every `wifi.reg.*` change as protected drift, so the expected L3 observation `00 -> TH` would fail the PRE→POST comparison.
- Owner decision Option 1(a): the L3 handler stays verify-only for regulatory state (`IW_REG_SET_ADDED=NO`); `p4-compare.sh` gains an optional `ALLOW_TRANSITIONS_FILE` (L3 only) accepting exactly `stage L3` plus `wifi.reg.<AEGIS_AP_PHY> 00 TH` for the phy behind `wlp0s20f3`. `TH -> TH` passes; every other regulatory change, missing/unparseable state, wrong phy/interface, non-L3 use, and any unrelated drift stays fail-closed. `wifi.reg.*` remains unapprovable via `ALLOW_KEYS_FILE`.
- Capture records the read-only `wifi.iface.<if>.phy` mapping; older bundles stay comparable outside L3 (INFO `CAPTURE_FIELD_ADDED`), L3 mode requires the key in both bundles.
- L3 apply ordering bug fixed: the live `country TH` observation ran before `rfkill unblock` and could never pass from the observed baseline; it now runs (bounded read-only poll of the target phy) after the unblock and before any profile install; live `AEGIS_AP_COUNTRY` must be `TH`.
- `L3_LIVE_EXECUTED=NO`, `PRODUCTION_MUTATION_PERFORMED=NO`, `PR11_COMPLETE=NO`. L2 acceptance stays PROVEN; containment `HOST_VERIFIED=NO`.

## Source files changed

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-compare.sh` — strict transitions-file contract and semantic regulatory transition
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-l0-capture.sh` — `wifi.iface.<if>.phy` key
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/L3/allow-transitions.txt` — new stage-scoped contract file
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/L3/apply.sh` — regulatory observation moved after unblock; country must be TH
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/README.md` — ALLOW_TRANSITIONS_FILE description
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l3_regulatory.py` — new (59 cases)
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l3_handler.py`, `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_harness.py` — handler-file inventory and capture-key assertions

## Verification evidence

- `pytest tests/test_pr11_phase4_l3_regulatory.py` with the implementation removed — RED as intended: 29 failed, 30 passed (the 30 are pre-existing protections)
- `pytest tests/test_pr11_phase4_l3_regulatory.py tests/test_pr11_phase4_l3_handler.py` — pass: 79 passed
- `pytest tests/test_pr11_phase4_*.py tests/test_pr11_k10_server_ca.py` — pass: 919 passed
- `pytest tests` (IDEA3 full) — pass: 1970 passed, 6 skipped
- `bash -n` on the 35 Phase 4 shell scripts — pass
- `git diff --cached --check` — pass
- `node scripts/validate-vault.mjs` — pass (2 pre-existing canvas warnings)
- staged-diff secret scan (regex for credentials, private keys, tokens, 64-hex) — pass: no hits
- Branch name matches the collaboration branch pattern; `scripts/validate-collaboration-policy.mjs` run against the PR body — see PR

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — L3 regulatory comparator repository-fix section added

## Shared surfaces touched

- `None` — task stayed inside its selected area

## Integration requests

- None — valid only when no cross-scope/shared path changed

## Known limitations

- Live L3 not executed; whether the driver reports `TH` after unblock and before activation is NOT PROVEN (the apply gate fails closed and rollback re-blocks).
- `global` regulatory change is treated as drift; if live L3 shows it moving, the comparator will fail and the design needs revisiting.
- The L3 live stage still needs a fresh same-day authorization, K3, PRE capture with a new `JOURNAL_SINCE`, and the POST comparison with `ALLOW_TRANSITIONS_FILE`.
