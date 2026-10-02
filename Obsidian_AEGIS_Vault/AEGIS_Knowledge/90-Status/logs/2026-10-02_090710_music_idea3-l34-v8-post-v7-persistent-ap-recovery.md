---
title: Task Receipt — IDEA3 L34 V8 post-V7 persistent AP recovery
date: 2026-10-02T09:07:10+07:00
owner: music
area: idea3
branch: feat/idea3-l34-v8-post-v7-persistent-ap-recovery
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 L34 V8 post-V7 persistent AP recovery

## What changed

- Repository-only implementation of owner decision `OD-L34-V8-01`: a NEW one-shot governed stage `l34-v8-post-v7-persistent-ap-recovery` that recovers the radio-disabled / AP-down / broker-churn state the host returned to after two reboots and makes exactly ONE persistent change, the NetworkManager `aegis-idea3-ap` `connection.autoconnect` transition no → yes.
- V7 historical live result remains immutable. V8 exists because V7 was explicitly `RUNTIME_ONLY` and `K12_AUTOMATIC_REBOOT_PERSISTENCE` was `NOT_PROVEN`. No V7 file, receipt, authorization, marker, runner or evidence was modified or reused (a V7 marker in the authorization directory refuses the V8 run).
- New handlers, allow files, owner-run template (inert, `EXPECTED_MAIN=PIN_MAIN_SHA`), new gate library, design spec and tests. Every mutation is journaled before it is made; rollback restores `autoconnect=no` first and owns only journaled changes. No broker command, no Core command, no direct rfkill/NetworkManager state-file edit.
- Nothing was run live: no Production mutation, no network change, no authorization or K3 created, no Core restart, no L7u, no ESP32.

## Source files changed

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/reactivation/l34-v8-post-v7-persistent-ap-recovery/apply.sh` — V8 apply handler (new)
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/reactivation/l34-v8-post-v7-persistent-ap-recovery/verify.sh` — V8 read-only verification (new)
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/reactivation/l34-v8-post-v7-persistent-ap-recovery/rollback.sh` — V8 journal-owned rollback (new)
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/reactivation/l34-v8-post-v7-persistent-ap-recovery/allow-keys.txt` — PRE→POST keys incl. the one profile `.meta` key (new)
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/reactivation/l34-v8-post-v7-persistent-ap-recovery/allow-keys-rollback.txt` — PRE→RB keys (new)
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/reactivation/l34-v8-post-v7-persistent-ap-recovery/allow-listeners.txt` — the five approved listeners (new)
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-l34-v8-lib.sh` — V8 gate library (new; the shared V1–V7 library is untouched)
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/owner-run/run-l34-v8-post-v7-persistent-ap-recovery-owner.sh` — inert owner-run template (new)
- `IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-10-02-idea3-pr11-phase4-l34-v8-post-v7-persistent-ap-recovery-design.md` — design (new)
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l34_v8_post_v7_persistent_ap_recovery.py` — handler tests (new)
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l34_v8_owner_run_flow.py` — runner control-flow tests (new)
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l34_v8_scope_contract.py` — scope, one-shot governance and V1–V7 byte-identity pins (new)
- `IDEA3-AEGIS_Lockdown/tests/l34_sim.py` — test simulator: backward-compatible `nmcli connection modify … connection.autoconnect` support (previously exit 99)

## Verification evidence

- `pytest tests/test_pr11_phase4_l34_v8_post_v7_persistent_ap_recovery.py tests/test_pr11_phase4_l34_v8_owner_run_flow.py tests/test_pr11_phase4_l34_v8_scope_contract.py` (targeted V8: 128 + 33 + 59 tests) — pass: all passed inside the full L34 run below (the handler file alone: `128 passed`, first V7-derived pass `99 passed`; the owner-run flow file alone: `33 passed`)
- `pytest tests/test_pr11_phase4_l34_*.py` (full L34 regression: V3–V8, includes the unchanged V1–V7 suites and the V1–V7 byte-identity pins) — pass: `1093 passed in 1150.13s`
- `pytest tests/test_pr11_phase4_harness.py tests/test_pr11_phase4_l7u_stage_governance.py tests/test_pr11_phase4_l8p_owner_runner.py tests/test_pr11_phase4_l6c_runner.py tests/test_pr11_phase4_l7_runner.py` (stage-gate / runner related) — pass: `572 passed in 131.59s`
- `bash -n` on the three V8 handlers, the V8 owner-run template and `p4-l34-v8-lib.sh` — pass
- `git diff --cached --check` — pass
- `node scripts/validate-vault.mjs` — pass (the two pre-existing canvas owner-review warnings only)
- `node scripts/validate-collaboration-policy.mjs --event <simulated Draft event> --changed-files <git diff --name-status origin/main>` — pass
- Secret scan: grep of every added line for private-key blocks, cloud/GitHub/Slack/API token shapes, `scrypt$` hashes and `psk|password|secret|token = <value>` assignments — pass: only a prose sentence matched; no secret value, real SSID passphrase or credential was read, written or committed (the simulator uses the pre-existing `CANARY-wifi-psk` fixture only)
- NEGATIVE CONTROLS covered by tests: direct rfkill-state-file/NetworkManager-state access is statically impossible; a keyfile rewrite that changes any other profile line fails closed and the rollback escalates; a profile that already autoconnects, a keyfile whose autoconnect is not exactly `false`, a V7 marker in the authorization directory and a V7-scoped authorization are all refused with no mutation.
- Reconciliation with main (PR #290, IDEA2): GitHub `collaboration-guardrails` failed on the first head `4d7d6d9a` because PR #290 (`fix(idea2): preserve Identity Agent sc.exe config argv`) merged into main as `f967ac4c` while V8 was being implemented. `git merge --no-edit origin/main` (no rebase, no squash, no force) merged it cleanly with zero conflicts and zero overlap with any V8 path; the incoming IDEA2 paths and the IDEA2 receipt are byte-identical to main and are NOT part of this PR: `git diff --name-status origin/main...HEAD` lists only the V8 files, the single V8 receipt and `idea3-status.md` (IDEA2 files in PR diff: 0; foreign receipts in PR diff: 0). PR #290 content was not modified.
- Post-reconciliation verification (head after the merge commit): `pytest` on the three V8 suites — pass: `220 passed in 253.40s`; `pytest tests/test_pr11_phase4_l34_*.py` — pass: `1093 passed in 1106.15s`; stage-gate / runner set (`harness`, `l7u_stage_governance`, `l8p_owner_runner`, `l6c_runner`, `l7_runner`) — pass: `572 passed in 113.84s`; `bash -n` on every V8 shell file, `git diff --check origin/main...HEAD` and `node scripts/validate-vault.mjs` — pass (2 existing canvas warnings only); `node scripts/validate-collaboration-policy.mjs` with the ACTUAL PR #291 body and the final `git diff --name-status origin/main...HEAD` — pass.
- NOT run: anything live. No authorization or K3 exists; the runner remains an inert `PIN_MAIN_SHA` template.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — added the V8 repository-implementation section (not run live; K12 NOT_PROVEN; V7 immutable)

## Shared surfaces touched

- `None` — task stayed inside its selected area

## Integration requests

- None — valid only when no cross-scope/shared path changed

## Known limitations

- Simulator-tested only. The real `nmcli connection modify` keyfile rewrite, the real `sudo env` reset and the real comparator behaviour on the profile `.meta` key are verified only by the first live attempt, which fails closed and rolls back.
- V8 does NOT prove `K12_AUTOMATIC_REBOOT_PERSISTENCE`, L3, L4 or L6b acceptance. Reboot persistence acceptance is a separate later activity; dnsmasq may still lose its race with the interface at boot, and the rfkill state file follows the radio state at the last shutdown.
- Before any live V8: human merge, post-merge verification, a NEW owner-frozen runner at the new main, a fresh same-day `stage=L4` authorization and K3 record with the exact V8 scope, and a read-only preflight that finds the exact baseline. L7u stays blocked until the broker is recovered.
