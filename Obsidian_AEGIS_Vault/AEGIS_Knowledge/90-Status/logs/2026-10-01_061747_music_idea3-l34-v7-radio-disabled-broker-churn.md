---
title: Task Receipt — IDEA3 L34 V7 radio-disabled broker-churn reactivation (repository only)
date: 2026-10-01T06:17:47+07:00
owner: music
area: idea3
branch: fix/idea3-l34-v7-radio-disabled-broker-churn
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 L34 V7 radio-disabled broker-churn reactivation (repository only)

## What changed

- Added a NEW governed owner-run reactivation stage `l34-v7-radio-disabled-broker-churn` for exactly one baseline: target phy soft-blocked (not hard-blocked), NM Wi-Fi radio disabled, `wlp0s20f3` unavailable, dnsmasq failed/`start-limit-hit`, the L6b broker crash-looping through its own `Restart=on-failure` because `10.77.30.1` is absent, Core healthy. Repository implementation only; **V7 has not run and is not authorized**.
- Why: after L7u post-merge verification, Recovery runtime was BLOCKED. V1-V3 own the rfkill/radio head but their runner requires the broker inactive; V4/V5/V6 require the radio already enabled. The original L34 runner is deliberately NOT weakened.
- V7 reuses the reviewed V3 head (exact-ID rfkill unblock, autoconnect guard, ONE radio enable, bounded wait for `disconnected`, `ifname`-bound activation) and the V5 tail (dnsmasq reset-failed+start, READ-ONLY wait for the broker's own restart), plus a strict broker-churn contract (`Restart=on-failure`, `RestartUSec=5s`, `activating/auto-restart`, `MainPID=0`, `Result=exit-code`, `ExecMainStatus=1`, bind-failure journal signature AND no other `Error:` line, exact two-listener broker config, no 8883 listener, AP address absent), a 4 x 5 s broker-tuple stability sample, one handshake-only TLS probe, and a Core-tuple-unchanged proof. No broker or Core command exists anywhere.
- Rollback is journal/ownership based and SAFE_EQUIVALENT (V3 model). Limit: with broker control forbidden, rollback cannot restore the broker's crash loop (it may crash-loop again or hold a stale `10.77.30.1:8883`, the V6 baseline).
- Truthful history recorded (canonical note + design): an earlier manual owner attempt on 2026-10-01 (~05:38-05:40 +07) was a temporary **production mutation (`PRODUCTION_MUTATION_PERFORMED=YES`)**; the AP activation raced NetworkManager's `unavailable -> disconnected` transition (radio on :39.1468, activation refused :39.1748, device ready :39.1907) and was apparently not `ifname`-bound; the manual rollback was safe-equivalent; the exact original pre-state was not proven; Core was never restarted; Recovery R1-R8 and L8 were not executed; ESP32 not touched.
- This task itself performed NO production mutation, no live command, no Core restart, no Recovery run, no ESP32 access, no L8.

## Source files changed

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/reactivation/l34-v7-radio-disabled-broker-churn/apply.sh` — new V7 apply handler (journal-before-mutation, fail-closed baseline gate, ready-wait before the one bound activation).
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/reactivation/l34-v7-radio-disabled-broker-churn/verify.sh` — new read-only end-state proof (including a fresh stability sample and Core tuple).
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/reactivation/l34-v7-radio-disabled-broker-churn/rollback.sh` — new journal-owned SAFE_EQUIVALENT rollback.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/reactivation/l34-v7-radio-disabled-broker-churn/allow-keys.txt` — new PRE->POST comparator allow keys (no persistent artifact, no Core key).
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/reactivation/l34-v7-radio-disabled-broker-churn/allow-keys-rollback.txt` — new PRE->RB comparator allow keys.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/reactivation/l34-v7-radio-disabled-broker-churn/allow-listeners.txt` — the five approved listeners only.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/owner-run/run-l34-v7-radio-disabled-broker-churn-owner.sh` — new dedicated unpinned-template runner (exact scope, K3/stage gate, one attempt, prints `RECOVERY_R1_R8_PROVEN=NO` and `L8_AUTHORIZED=NO`).
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-l34-reactivation-lib.sh` — APPENDED `l34_v7_*` section only (pre-V7 part byte-identical, pinned by test).
- `IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-10-01-idea3-pr11-phase4-l34-v7-radio-disabled-broker-churn-design.md` — design/contract/non-goals.
- `IDEA3-AEGIS_Lockdown/tests/l34_sim.py` — additive simulator keys (`nm_ready_lag_polls`, `stray_8883`, `broker_journal_extra`, `broker_restart_every_shows`) plus Restart/RestartUSec/ExecMainStatus/InvocationID in crash-loop mode; defaults keep V1-V6 behavior.
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l34_v7_radio_disabled_broker_churn.py` — new handler tests (cases A-P).
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l34_v7_owner_run_flow.py` — new runner control-flow tests.
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l34_v7_scope_contract.py` — scope/stage-gate contract and V1-V6 byte-identity pins.
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l34_v6_scope_contract.py` — one line: the existing "library only appended" test now cuts the V6 section at the V7 marker (V7 is a later, separate section); its assertion is otherwise unchanged.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — new canonical V7 section (owner-writable).

## Verification evidence

- RED first: `pytest tests/test_pr11_phase4_l34_v7_radio_disabled_broker_churn.py` before any V7 file existed — fail: `73 failed` (every test; handler files absent). All tests use `~/.venvs/aegis-idea3-core/bin/python -m pytest -p no:cacheprovider` against the stub-command simulator only; nothing touched the live host.
- `pytest tests/test_pr11_phase4_l34_v7_radio_disabled_broker_churn.py tests/test_pr11_phase4_l34_v7_owner_run_flow.py tests/test_pr11_phase4_l34_v7_scope_contract.py` — pass: `128 passed`.
- Negative control (readiness wait removed from `apply.sh`, not committed): `pytest ... -k "waits_until or bounded_readiness or ifname_bound or exact_current_baseline or exactly_once"` — expected fail: `3 failed, 1 passed` (race tests fail, incl. `NMCLI_UP_FAILED`); source restored byte-identical (sha256 verified) — pass: `4 passed`.
- Full L34 regression at the exact PR head (independent review re-run, `pytest $(ls tests/test_pr11_phase4_l34_*.py tests/test_pr11_phase4_l3_rfkill.py)`: V1-V3, nm_radio, V4, V5, V6, V7, runner-flow and scope-contract suites) — pass: `853 passed, 0 failed, 0 skipped`, exit 0. (The implementation run first saw `724 passed, 1 failed` — the V6 library-section pin reading into the V7 section — fixed by a one-line test scoping change; the complete set was then re-run in full at head.)
- Remaining Phase 4 harness/stage tests (all other `tests/test_pr11_phase4_*.py`, incl. L7u stage governance), run twice (implementation and independent review) — pass: `2354 passed, 2 skipped`, exit 0.
- `bash -n` on the three V7 handlers, the V7 runner and `p4-l34-reactivation-lib.sh` — pass.
- `git diff --check` — pass.
- `node scripts/validate-vault.mjs` — pass: `Vault validation passed with 2 warning(s)` (the two pre-existing canvas owner-review warnings).
- `node scripts/validate-collaboration-policy.mjs --event <simulated Draft PR event> --changed-files <git diff --cached --name-status origin/main>` — pass: `Collaboration policy passed.` (area idea3, owner music, integration-review no, one new receipt, Draft).
- Secret-pattern scan over every changed file (private-key headers, AWS/GitHub/Slack token shapes, `password=`/`secret=`/Bearer values) — pass: no hits. The test fixtures contain the synthetic canary string `CANARY-wifi-psk-...` by design (a leak canary), not a credential.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — added the V7 section (why it exists, exact baseline gap, earlier manual mutation and its findings, safe-equivalent rollback, exact pre-state not proven, Core untouched, Recovery not executed, L8 not started, limits); `updated:` set to 2026-10-01.

## Shared surfaces touched

- None — every changed path is inside the IDEA3 boundary (`IDEA3-AEGIS_Lockdown/`) or the owner-writable IDEA3 canonical note and this receipt.

## Integration requests

- None — no cross-scope path changed. Note for the reviewer (Kla, temporary IDEA3 reviewer): V7 must not be merged-and-run in one step; live use needs an owner freeze/re-pin of the runner, a fresh same-day `stage=L4` authorization with the exact V7 scope (183 chars) and K3 record.

## Known limitations

- Simulator-tested only: no real-host run. Review-time synthetic-bundle analysis (real `p4-compare.sh`, V7 allow files + exact V3 catalogs) accepted PRE->POST for RESIDUAL and FRESH and PRE->RB (broker crash-looping again or stale pair) and rejected a broker `LoadState` change and a wildcard 8883 listener; it has NOT been run against a real host capture, and the simulated runner uses a stand-in comparator.
- `READY_FOR_LIVE_REACTIVATION=NO`, `READY_FOR_MERGE=NO` (Draft; awaiting human review). Recovery R1-R8 NOT proven, L8 NOT started, F1/R5 unresolved.
- Rollback cannot restore the broker's crash loop (no broker control is permitted); it may leave a stale `10.77.30.1:8883` (V6 baseline) or crash-loop again.
- IDEA2 / S10: the PRE->POST and PRE->RB compares require `FINDINGS_BASELINE_UNHEALTHY_BUT_UNCHANGED=0` (S10). Last accepted PASS evidence is L7 #7 (2026-09-30); the 2026-10-01 state is NOT re-proven (a coarse read-only look showed the IDEA2 engine and tunnel units active and :8077/:18002 listening, tunnel `NRestarts=17` historical, which the window-delta criterion treats as non-failing by itself). Fresh IDEA2 health evidence is required before any live V7 run; if the IDEA2 baseline is unhealthy the V7 compare cannot pass and V7 live stays blocked. V7 does not change that policy.
- The exact pre-attempt host state of 2026-10-01 was never snapshotted, so V7's FRESH-vs-RESIDUAL choice is decided by the live preflight, not by history.
- The stability sample (4 x 5 s = 15 s) covers about three 5 s restart cycles; it does not prove long-term broker stability.
