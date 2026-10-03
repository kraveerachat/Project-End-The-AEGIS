---
title: Task Receipt — IDEA3 L8p attempt 1 forensic closeout and PRE-capture / compare-arity fixes (repository only)
date: 2026-10-04T03:20:49+07:00
owner: music
area: idea3
branch: fix/idea3-l8p-pre-capture-contract-and-compare-arity
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 L8p attempt 1 forensic closeout and PRE-capture / compare-arity fixes (repository only)

> [!important] Repository-only. IMPLEMENTED != DEPLOYED. This repository fix performed **no** Production mutation, NTP change, service change, serial access, ESP32 reset/read/write/erase, MQTT publish, CUT/RESTORE, and created **no** Authorization/K3, frozen runner or attempt marker. The consumed attempt-1 files (`L8p-ATTEMPT-CONSUMED`, its Authorization/K3, its frozen runner and evidence) were read at most, never modified.

```text
BASE_SHA=720ca262b4f5688686f717d7f3b67d5f3e5700f6
ATTEMPT1_AUTHORIZATION_CONSUMED=YES
ATTEMPT1_FAILURE_POINT=apply.sh PRE evidence gate (after the attempt was consumed, before any device action)
ATTEMPT1_L8P_PROVISIONING=NOT_PROVEN
ATTEMPT1_FIRST_HARDWARE_WRITE=NOT_STARTED
ATTEMPT1_FIRST_WRITE_MARKER=NO
ATTEMPT1_DEVICE_ACTION_TAKEN=NONE
ATTEMPT1_FLASH_PERFORMED=NO
FORENSIC_PRE_RB_COMPARE=PASS
FORENSIC_PRESERVATION_S10=PASS
FORENSIC_NEW_OR_WORSENED_DRIFT=0
FORENSIC_INCOMPARABLE=0
SUCCESSOR_ATTEMPT_REQUIRED=YES
OLD_AUTH_REUSABLE=NO
OLD_RUNNER_REUSABLE=NO
PRODUCTION_MUTATION_PERFORMED_BY_THIS_REPO_FIX=NO
ESP32_TOUCHED_BY_THIS_REPO_FIX=NO
```

The runner prints its two success claim lines only on the full success path, and it did not reach it; this receipt therefore records **no** L8p result and claims no acceptance. `ATTEMPT1_L8P_PROVISIONING` stays `NOT_PROVEN`.

## What changed

- **ROOT_CAUSE_PRE_CAPTURE_CHECK:** the canonical `p4-l0-capture.sh` log line is timestamped and suffixed (`<TIMESTAMP> L0_CAPTURE=COMPLETE evidence=<path>`), but `apply.sh` required the whole line to equal `L0_CAPTURE=COMPLETE`. It rejected legitimate canonical evidence after the one-shot attempt was consumed. Fix: a field-aware check (`L0_CAPTURE=COMPLETE` must be a distinct whitespace-delimited field: start of line or whitespace before it, whitespace or end of line after it); `INCOMPLETE`, `NOT_L0_CAPTURE=COMPLETE`, `COMPLETED` and embedded substrings are refused; the `SHA256SUMS` verification is unchanged and still mandatory.
- **ROOT_CAUSE_COMPARE:** the L8p runner passed the report filename as a third positional argument to the two-argument `p4-compare.sh` (`<BEFORE_DIR> <AFTER_DIR>`), which stops at its usage gate. Fix: `bash "$P4/p4-compare.sh" "$1" "$2" > "$3" 2>&1`; the comparator's public contract is unchanged, no allow keys added, the L8p allow files stay empty. No other owner runner has this defect (all other callers pass exactly two arguments).
- **Tests:** the capture stand-in now writes the real p4_log shape and the comparator stand-in exits 2 unless exactly two arguments are given; with those, current main fails 56 provisioning tests and 31 owner-runner tests (both live failures reproduced), and the fix passes them. New tests cover accepted/refused log formats, tampered/missing `SHA256SUMS`, the refusal boundary (no work dir, no first-write marker, no device action), the two-argument invocation and report redirection, the pre-first-write rollback running the formal PRE->RB comparator, the consumed attempt staying consumed, and tests that run the REAL `p4-l0-capture.sh` bundle through the gate and the REAL comparator.

## Source files changed

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/L8p/apply.sh`
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/owner-run/run-l8p-owner.sh` (inert template)
- `IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-10-02-idea3-pr11-phase4-l8p-device-provisioning-only.md` (section 7)
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l8p_provisioning.py`, `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l8p_owner_runner.py`

## Verification evidence

- `pytest -q -p no:cacheprovider tests -k "pr11_phase4 or pr11_phase2 or firmware_contract"` — PASS, 4627 passed, 5 skipped, 0 failed, on the final tree (based on `origin/main` `720ca262`; simulated host only).
- `pytest tests/test_pr11_phase4_l8p_owner_runner.py` — PASS, 144 passed. `pytest tests/test_pr11_phase4_l8p_provisioning.py` — PASS, 114 passed. `pytest tests/test_pr11_phase4_l8p_esptool_interpreter.py` — PASS, 18 passed.
- `pytest` on L8 handler / hardware backend / boot verify / NVS provision / firmware contract / p4 harness (capture + compare) / L6c capture gap — PASS, 77 / 80 / 69 / 10 / 16 / 235 / 34 passed.
- Before the fixes, with the real log format and a real-arity comparator stand-in, current main failed 56 provisioning tests and 31 owner-runner tests (both live failures reproduced); after the fixes they pass.
- `bash -n` on `run-l8p-owner.sh`, `p4-l8p-run-lib.sh`, `stages/L8p/{apply,verify,rollback}.sh` — PASS. `git diff --check` — PASS.
- `node scripts/validate-vault.mjs --vault Obsidian_AEGIS_Vault/AEGIS_Knowledge` — PASS (0 errors; 2 pre-existing canvas warnings).
- `scripts/validate-collaboration-policy.mjs` needs a PR event payload; run locally against the PR body and changed paths before pushing.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — new "L8p attempt 1 forensic closeout" section.

## Shared surfaces touched

- `None` — all code is under `IDEA3-AEGIS_Lockdown/`.

## Integration requests

- None

## Known limitations

- Simulated-host proof only; no live L8p attempt has succeeded and none is claimed. A successor attempt needs a new freeze pinned to the then-current main, a fresh same-day Authorization/K3 and explicit owner authorization.
- The runner's own capture check (`sudo grep -q 'L0_CAPTURE=COMPLETE'` in `capture()`) is a plain substring match and was left as is; the stricter field-aware check now guards the device-side gate in `apply.sh`.
