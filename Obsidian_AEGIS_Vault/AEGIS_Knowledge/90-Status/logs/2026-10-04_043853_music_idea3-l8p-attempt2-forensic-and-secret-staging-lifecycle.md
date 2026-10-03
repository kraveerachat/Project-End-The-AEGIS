---
title: Task Receipt — IDEA3 L8p attempt 2 forensic closeout and secret-staging lifecycle fix (repository only)
date: 2026-10-04T04:38:53+07:00
owner: music
area: idea3
branch: fix/idea3-l8p-secret-staging-lifecycle
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 L8p attempt 2 forensic closeout and secret-staging lifecycle fix (repository only)

> [!important] Repository-only. IMPLEMENTED != DEPLOYED. This repository fix performed **no** Production mutation, NTP or service change, serial access, ESP32 action, MQTT publish, CUT/RESTORE and created **no** Authorization/K3, frozen runner or attempt marker. Attempt 2's Authorization, K3, consumed marker, frozen runner and evidence were not modified (read-only metadata/forensics only). **No retry, no device action, no physical recovery** happened in this task.

```text
BASE_SHA=b440b102cf35131291e330e2109adaa29c8e43c9
ATTEMPT2_CONSUMED=YES
ATTEMPT2_FIRST_HARDWARE_WRITE=STARTED
ATTEMPT2_FLASH_RESULT=PASS
ATTEMPT2_NVS_READBACK_MATCH=PASS
ATTEMPT2_FIRMWARE_READBACK_MATCH=PASS
ATTEMPT2_BOOT_VERIFICATION=PASS
ATTEMPT2_BOOT_VERIFICATION_DETAIL=PASS_BOOT_LOCKDOWN
ATTEMPT2_FAILURE_BOUNDARY=NONE
ATTEMPT2_VERIFY=PASS
ATTEMPT2_PRE_POST_COMPARE=PASS
ATTEMPT2_PRE_RB_COMPARE=PASS
ATTEMPT2_PRESERVATION_S10=PASS
ATTEMPT2_SECRET_SCAN_FILES=142
ATTEMPT2_SECRET_SCAN_HITS=2
ATTEMPT2_SECRET_SCAN_HIT_FILES=l8p-work/nvs.csv,l8p-work/nvs.bin
ATTEMPT2_SECRET_VALUE_LEAK_OUTSIDE_WORK_DIR=NO
ATTEMPT2_ROLLBACK=FAIL_SECURE_HOLD_AND_EVIDENCE (zero device action, no retry)
ATTEMPT2_DEVICE_RETRY_PERFORMED=NO
L8P_PROVISIONING=NOT_PROVEN
ATTEMPT2_RECONCILIATION=OWNER_DECISION_REQUIRED
PRODUCTION_MUTATION_PERFORMED_BY_THIS_FIX=NO
ESP32_TOUCHED_BY_THIS_FIX=NO
```

The runner prints its success claim only on the full success path, which attempt 2 did not complete; this receipt records **no** L8p result and claims no acceptance.

## What changed

- **Root cause (confirmed from source and tests):** the canonical flow stages `$WORK/nvs.csv` (all four provisioned secrets in plaintext) and `$WORK/nvs.bin` (the encoded Wi-Fi/MQTT values) with `WORK = $EVID/l8p-work`; `l8p_secret_scan` recursively scans the whole `$EVID` with no exclusions. A successful provisioning therefore always leaves legitimate secret-bearing staging files inside the tree the scan requires to be clean. The hermetic success tests did not reproduce it because their handler stub never wrote real secret-bearing staging files; the stub now does. Owner forensic over the whole historical tree (209 files): exactly those two files hold secret values (nvs.csv: wifi.psk, mqtt.pass, k_c2d, k_d2c; nvs.bin: wifi.psk, mqtt.pass); nothing else, no value printed.
- **Fix (no weakening of the scan):** new host-only handler `stages/L8p/cleanup.sh` removes EXACTLY `nvs.csv` and `nvs.bin` from the exact stage WORK_DIR (absolute, canonical, a real directory, no `.`/`..`/empty components; each artifact absent or a regular non-symlink file, otherwise it fails closed before removing anything), never `first-write.marker`, never the l8p JSON evidence, never recursively, coreutils only, idempotent, with `NVS_CSV_PRESENT=NO`, `NVS_BIN_PRESENT=NO`, `FIRST_WRITE_MARKER_PRESENT=YES` and `L8P_SECRET_WORK_CLEANUP=PASS`. The owner runner calls it only after apply and verify passed, before the POST capture, and requires all those lines (otherwise it rolls back). `l8p_secret_scan` is unchanged and still covers the entire EVID tree.
- **Post-write rollback contract:** reconciled against the L8p design (spec section 3: after the first write no retry, reflash, rollback write, RESTORE or fallback; `rollback.sh` performs zero device action and starts no process other than coreutils; failure is `FAIL_SECURE_HOLD_AND_EVIDENCE`) and against the pre-first-write branch, which already removes exactly these two files. Removing host-side secret staging files is not a device action and is not evidence loss, so the post-first-write branch now removes exactly `nvs.csv` and `nvs.bin` (same guards), preserves the marker and the JSON evidence, stays idempotent and still reports `FAIL_SECURE_HOLD_AND_EVIDENCE`.
- **ATTEMPT2_RECONCILIATION=OWNER_DECISION_REQUIRED:** no existing reviewed contract defines a post-hoc closeout of a consumed post-write attempt. Evidence: the success claim `L8P_LIVE_EXECUTED=YES L8P_PROVISIONING=PASS` exists only at `owner-run/run-l8p-owner.sh` line 207, after the full success path including the secret scan; the failure path prints `L8P_PROVISIONING=NOT_PROVEN` and "physical recovery is MANUAL and out-of-band" (line 174); `p4-l8p-run-lib.sh` `l8p_receipt_gate` (lines 38-55) only blocks a new attempt when one receipt already carries both whole-line result fields and defines no way to produce them post hoc; spec section 3 (lines 47-48) and `stages/L8p/apply.sh` line 141 call physical recovery a manual owner action after a post-write failure but no gate or later-stage contract consumes it or the L8p result, and no text makes it a mandatory precondition for a read-only closeout. Neither a read-only closeout path nor a mandatory physical-recovery gate is established, so the owner must decide. This task did not perform or prepare that closeout.
- **Leftover host artifacts of attempt 2:** its historical evidence tree still contains the two secret-bearing staging files. This task did not touch them; whether to remove them is part of the same owner decision.

## Source files changed

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/L8p/cleanup.sh` (new)
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/L8p/rollback.sh`, `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/owner-run/run-l8p-owner.sh` (inert template)
- `IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-10-02-idea3-pr11-phase4-l8p-device-provisioning-only.md` (section 8)
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l8p_provisioning.py`, `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l8p_owner_runner.py`, `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_harness.py` (registers the new reviewed L8p handler)

## Verification evidence

- `pytest -q -p no:cacheprovider tests -k "pr11_phase4 or pr11_phase2 or firmware_contract"` — PASS, 4671 passed, 5 skipped, 0 failed, on the final tree (based on `origin/main` `b440b102`; simulated host only). An earlier full run of the same code failed exactly one test, the harness registry pin of reviewed stage handlers (`cleanup.sh` was not yet registered for L8p); it was fixed and the full suite rerun.
- `pytest tests/test_pr11_phase4_l8p_owner_runner.py` — PASS, 171 passed. `pytest tests/test_pr11_phase4_l8p_provisioning.py` — PASS, 131 passed. `pytest tests/test_pr11_phase4_l8p_esptool_interpreter.py` — PASS, 18 passed.
- `pytest` on L8 handler / hardware backend / boot verify / NVS provision / firmware contract / p4 harness — PASS, 77 / 80 / 69 / 10 / 16 / 235 passed.
- RED before the fix: the success-path test failed with `SECRET_OUTPUT_SCAN failed` followed by a rollback, and the independent root-cause test showed exactly the two staging files as the only hits (with the unchanged scanner); both pass after the fix, and all 28 real-leak cases (each of four secrets into five non-work locations plus the work directory) still fail the scan.
- `bash -n` on `run-l8p-owner.sh`, `p4-l8p-run-lib.sh`, `stages/L8p/{apply,verify,rollback,cleanup}.sh` — PASS. `git diff --check` — PASS.
- `node scripts/validate-vault.mjs --vault Obsidian_AEGIS_Vault/AEGIS_Knowledge` — PASS (0 errors; 2 pre-existing canvas warnings).
- `scripts/validate-collaboration-policy.mjs` needs a PR event payload; run locally against the PR body and changed paths before pushing.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — new "L8p attempt 2 forensic closeout" section.

## Shared surfaces touched

- `None` — all code is under `IDEA3-AEGIS_Lockdown/`.

## Integration requests

- None

## Known limitations

- Simulated-host proof only. No successful L8p result is recorded and none is claimed; attempt 2 is consumed and its formal result stays NOT_PROVEN.
- A successor attempt, or an owner-defined reconciliation of attempt 2, needs an explicit owner decision; the old Authorization/K3 and the old frozen runner are not reusable.
