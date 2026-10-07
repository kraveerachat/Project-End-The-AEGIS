---
title: Task Receipt — IDEA3 CTu Pre-Live Host Reconciliation
date: 2026-10-07T10:51:12+07:00
owner: music
area: idea3
branch: fix/idea3-ctu-prelive-host-reconcile
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 CTu Pre-Live Host Reconciliation

## Operational Truth and Execution Boundaries

- `CTU_LIVE_EXECUTED=NO`
- `CTU_ATTEMPT_CONSUMED=NO`
- `RECOVERY_LIVE_EXECUTED=NO`
- `PRODUCTION_MUTATION_PERFORMED=NO`
- `CTU_STAGE_REUSED_WITHOUT_RETRY=YES`

## Post-Reboot Host Findings (Read-Only Host State)

- `DETECTOR_PRE_BASELINE=INACTIVE_DISABLED`
- `PRODUCTION_DEVICE_ID=aegis-relay-01`
- `OLD_CTURUNNER_DEVICE_LITERAL=esp32-01`

Read-only host inspection post-reboot revealed two blockers before CTu first execution:
1. The post-reboot host detector is inactive and disabled (`LoadState=loaded`, `ActiveState=inactive`, `SubState=dead`, `UnitFileState=disabled`, `Restart=no`, `MainPID=0`, `InvocationID=""`, `monotonic=0`, `NRestarts=0`, `proc_count=0`). Core does not require/want detector, so restarting Core does not start an inactive detector.
2. Production configuration `/etc/aegis-idea3/core.env` sets `AEGIS_P1_DEVICE_ID=aegis-relay-01`, but CTu previously hardcoded literal `esp32-01`.

## What changed

- Reconciled CTu in the repository without stage retry, without creating a new stage name, and without any production mutation.
- Dual Detector Baseline Contract:
  - Supported exactly two PRE baseline modes: Mode A (ACTIVE) and Mode B (INACTIVE).
  - Mode A (ACTIVE): requires single implicit lifecycle proof (`PRE != POST_APPLY`, `VERIFY == POST_APPLY`, `NRestarts=0`, `proc_count=1`).
  - Mode B (INACTIVE): requires baseline preservation across Core restart (`ActiveState=inactive`, `SubState=dead`, `UnitFileState=disabled`, `Restart=no`, `MainPID=0`, `InvocationID=""`, `NRestarts=0`, `proc_count=0`).
  - Zero explicit detector lifecycle commands issued in either mode. Any unexpected active->inactive or inactive->active transition fails closed.
  - Recorded `CTU_DETECTOR_BASELINE_MODE` in terminal closeout.
- Parameterized Device ID Pin Binding:
  - Parameterized `DEVICE_ID=PIN_DEVICE_ID` across CTu freeze tools, pins JSON, runner, Auth extra fields, K3 bindings, and runtime verifier.
  - Enforced `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` grammar on `device_id`.
  - Added pre-consume verification `ctu_validate_core_env_device_id` reading only `AEGIS_P1_DEVICE_ID` from `/etc/aegis-idea3/core.env` without leaking environment or secrets.
  - Recorded `CTU_DEVICE_ID` in terminal closeout.
- Recovery Gate Update:
  - Updated `recovery_ctu_successor_gate` and `recovery_runner_freeze.py` to validate `CTU_DETECTOR_BASELINE_MODE=(ACTIVE|INACTIVE)` and `CTU_DEVICE_ID` in CTu closeout without weakening security.

## Source files changed

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-lib.sh` — added `device_id` to CTu authorization extra fields.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-stage-gate.sh` — added `device_id` grammar and cross-record binding validation for CTu.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-ctu-run-lib.sh` — added safe `ctu_validate_core_env_device_id`, updated `ctu_record_success` to record `CTU_DETECTOR_BASELINE_MODE` and `CTU_DEVICE_ID`.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/ctu-acceptance/ctu_runner_freeze.py` — added `DEVICE_ID=PIN_DEVICE_ID` pin spec and validation.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/owner-run/run-ctu-owner.sh` — frozen `DEVICE_ID` pin, pre-consume `core.env` validation, dual detector baseline contract (Mode A active implicit cycle / Mode B inactive preservation), recording baseline mode and device ID in terminal result.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/CTu/apply.sh` — captured detector load, unit_file, and restart state for baseline preservation.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/CTu/verify.sh` — required `AEGIS_CTU_DETECTOR_PRE_MODE` (`ACTIVE|INACTIVE`), asserting single implicit cycle for ACTIVE and baseline preservation for INACTIVE without issuing detector commands.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-ctu-runtime-verify.py` — added `--detector-mode` CLI argument and dual mode verification in `verify_detector()`.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-recovery-run-lib.sh` — updated `recovery_ctu_successor_gate` key list and validations for `CTU_DETECTOR_BASELINE_MODE` and `CTU_DEVICE_ID`.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/recovery-acceptance/recovery_runner_freeze.py` — updated `_verify_ctu_pass_for_freeze` to require and validate `CTU_DETECTOR_BASELINE_MODE` and `CTU_DEVICE_ID`.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/README.md` — Section 26 updated with pre-live host reconciliation findings, dual detector baseline contract, and device pin binding.
- `IDEA3-AEGIS_Lockdown/tests/test_ctu_blockers.py` — updated and added tests for dual detector baseline modes and 7 `core.env` parsing cases.
- `IDEA3-AEGIS_Lockdown/tests/test_core_trusted_time_repair.py` — fixed PIN_DEVICE collision and updated mock closeouts.
- `IDEA3-AEGIS_Lockdown/tests/recovery/test_recovery_runner_freeze.py` — updated mock closeouts with baseline mode and device ID.

## Verification evidence

- `pytest -v IDEA3-AEGIS_Lockdown/tests/test_ctu_blockers.py` — pass: 13 passed in 1.48s
- `pytest -v IDEA3-AEGIS_Lockdown/tests/test_core_trusted_time_repair.py` — pass: 24 passed in 2.21s
- `pytest -v IDEA3-AEGIS_Lockdown/tests/recovery/test_recovery_runner_freeze.py` — pass: 74 passed in 25.10s
- `pytest -q IDEA3-AEGIS_Lockdown/tests/r1bv/ IDEA3-AEGIS_Lockdown/tests/r1i/ IDEA3-AEGIS_Lockdown/tests/rru/ IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_harness.py` — pass: 757 passed in 165.23s
- `bash -n` on all changed shell scripts — pass: exit 0, no syntax errors
- `python3 -m py_compile` on all changed Python files — pass: exit 0, no syntax errors
- `git diff --check` — pass: exit 0, clean whitespace
- `node scripts/validate-vault.mjs` — pass: exit 0, 0 errors

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-moc.md` — updated Current repair state with pre-live host reconciliation details.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — updated Current Task and Session Register with CTu-S3 pre-live host reconciliation.

## Shared surfaces touched

- `None` — task stayed inside its selected area (`idea3`)

## Integration requests

- `None` — valid only when no cross-scope/shared path changed

## Known limitations

- `CTU_LIVE_EXECUTED=NO`: Repository-only reconciliation; CTu has not run live on the host.
- `CTU_ATTEMPT_CONSUMED=NO`: Attempt marker `CTU-GLOBAL-ATTEMPT-CONSUMED` is absent.
- `RECOVERY_LIVE_EXECUTED=NO`: Recovery remains unexecuted.
- `PRODUCTION_MUTATION_PERFORMED=NO`: Zero live mutations performed.
- Human review and merge required before any live execution.
