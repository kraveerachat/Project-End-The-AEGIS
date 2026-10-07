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
- `RECOVERY_ATTEMPT_CONSUMED=NO`
- `PRODUCTION_MUTATION_PERFORMED=NO`
- `MERGE_PERFORMED=NO`
- `CTU_FIRST_LIVE_ATTEMPT_NOT_YET_CONSUMED=YES`
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
- Pre-live security closure:
- `CTU_DIRECT_APPLY_BYPASS_CLOSED=YES`, `CTU_DIRECT_ROLLBACK_BYPASS_CLOSED=YES`: CTu apply and rollback files are permanent refusal-only stubs; mutation and rollback routines are embedded in the frozen owner runner.
- `RECOVERY_DIRECT_PRIVILEGED_HANDLER_GATED=YES`: standalone Recovery apply/verify invocation refuses before privileged execution; the frozen owner runner embeds the only privileged read-only execution boundary.
  - `ROOT_EXECUTES_MUTABLE_WORKTREE_CODE=NO`, `AMBIENT_CTU_PYTHON_ACCEPTED=NO`, `GIT_TRUST_CLOSURE=PASS`, `CORE_ENV_TOCTOU_CLOSED=YES`, `TRANSIENT_INACTIVE_EXECUTION_MECHANICALLY_REFUSED=YES`, and `FREEZE_TEMPLATE_PIN_CARDINALITY_ENFORCED=YES`.
  - `CTU_DIRECT_APPLY_BYPASS_CLOSED=YES`, `PROVENANCE_FORGEABLE_BY_PRIVILEGED_OPERATOR=NO`, `DIRECT_HANDLER_DYNAMIC_NEGATIVE_TEST=PASS`.
  - `RECOVERY_DIRECT_PRIVILEGED_HANDLER_GATED=YES`, `RECOVERY_PROVENANCE_FORGEABLE_BY_PRIVILEGED_OPERATOR=NO`, `RECOVERY_CTU_HOST_PROVENANCE_BOUND=YES`.
- `CORE_RESTART_CONTRACT_TRUTHFUL=YES`: pre-consume=0, success=1, post-consume failure max=2, rollback additional max=1; no undocumented third restart is present.
- `CTU_TRUSTED_SHELL_STARTUP=PASS`, `CTU_BASH_ENV_NEUTRALIZED_BEFORE_EFFECT=YES`, `CTU_PATH_FAKE_BASH_REFUSED=YES`, `CTU_AMBIENT_SHELL_FUNCTION_IMPORT_REFUSED=YES`.
- `RECOVERY_CLEAN_STARTUP_BOUNDARY=PASS`, `RECOVERY_BASH_ENV_NEUTRALIZED_BEFORE_EFFECT=YES`, `RECOVERY_PATH_FAKE_BASH_REFUSED=YES`, `RECOVERY_AMBIENT_SHELL_FUNCTION_IMPORT_REFUSED=YES`, `RECOVERY_ENV_STARTUP_REFUSED=YES`.
- `RECOVERY_TRUSTED_INTERPRETER=PASS`, `RECOVERY_PYTHON_ENV_CLOSED=YES`, `RECOVERY_GIT_ENV_CLOSED=YES`; the Recovery shell boundary strips caller variables before the frozen body, while native loader behavior remains an OS trust-base assumption rather than an arbitrary-root guarantee.
- `TRUSTED_INTERPRETER=PASS`, `ALL_CTU_PYTHON_INVOCATIONS_ISOLATED=YES`, `PYTHONPATH_INJECTION_REFUSED=YES`, `PYTHONHOME_INJECTION_REFUSED=YES`, `LD_PRELOAD_INJECTION_REFUSED=YES`, `LD_LIBRARY_PATH_INJECTION_REFUSED=YES`.

## Source files changed

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-lib.sh` — added `device_id` to CTu authorization extra fields.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-stage-gate.sh` — added `device_id` grammar and cross-record binding validation for CTu.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-ctu-run-lib.sh` — added safe `ctu_validate_core_env_device_id`, updated `ctu_record_success` to record `CTU_DETECTOR_BASELINE_MODE` and `CTU_DEVICE_ID`.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/ctu-acceptance/ctu_runner_freeze.py` — added `DEVICE_ID=PIN_DEVICE_ID` pin spec and validation.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/owner-run/run-ctu-owner.sh` — frozen `DEVICE_ID` pin, pre-consume `core.env` validation, dual detector baseline contract (Mode A active implicit cycle / Mode B inactive preservation), recording baseline mode and device ID in terminal result.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/CTu/apply.sh` — permanent refusal-only non-mutating public/bundle stub.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/CTu/rollback.sh` — permanent refusal-only non-mutating public/bundle stub.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/CTu/verify.sh` — required `AEGIS_CTU_DETECTOR_PRE_MODE` (`ACTIVE|INACTIVE`), asserting single implicit cycle for ACTIVE and baseline preservation for INACTIVE without issuing detector commands.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-ctu-runtime-verify.py` — added `--detector-mode` CLI argument and dual mode verification in `verify_detector()`.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-recovery-run-lib.sh` — updated `recovery_ctu_successor_gate` key list and validations for `CTU_DETECTOR_BASELINE_MODE` and `CTU_DEVICE_ID`.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-recovery-run-lib.sh` — bound Recovery to the root-owned host closeout sidecar and reviewed exact-main CTu LIVE receipt.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/recovery-acceptance/recovery_runner_freeze.py` — pinned the reviewed CTu LIVE receipt path/digest and host closeout digest.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/owner-run/run-ctu-owner.sh` — embedded CTu mutation/rollback routines and enforces the truthful restart contract.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/owner-run/run-recovery-owner.sh` — embedded Recovery privileged read-only routines and removed standalone handler execution.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/recovery-acceptance/recovery_runner_freeze.py` — updated `_verify_ctu_pass_for_freeze` to require and validate `CTU_DETECTOR_BASELINE_MODE` and `CTU_DEVICE_ID`.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/README.md` — Section 26 updated with pre-live host reconciliation findings, dual detector baseline contract, and device pin binding.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/README.md` — current architecture corrected to document refusal-only public handlers, private frozen-runner routines, host-to-receipt Recovery binding, and clean startup/interpreter closure.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-recovery-run-lib.sh` — all changed Recovery Python execution uses `/usr/bin/python3 -I -B` and absolute trusted snapshot module paths, without ambient `PYTHONPATH` authority.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/owner-run/run-ctu-owner.sh` — executable entrypoint now performs a POSIX clean-environment re-exec before Bash runner code; status inspection uses isolated Python.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/owner-run/run-recovery-owner.sh` — embedded Recovery Python execution uses isolated Python and absolute snapshot module paths.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/owner-run/run-recovery-owner.sh` — executable Recovery entrypoint now establishes the pre-body clean shell boundary before the frozen runner body.
- `IDEA3-AEGIS_Lockdown/tests/recovery/test_recovery_runner_authority.py` — dynamic hostile Recovery startup/environment fixture covering PATH, startup files, imported functions, Python, loader, and Git variables.
- `IDEA3-AEGIS_Lockdown/tests/test_ctu_blockers.py` — updated and added tests for dual detector baseline modes and 7 `core.env` parsing cases.
- `IDEA3-AEGIS_Lockdown/tests/test_core_trusted_time_repair.py` — fixed PIN_DEVICE collision and updated mock closeouts.
- `IDEA3-AEGIS_Lockdown/tests/recovery/test_recovery_runner_freeze.py` — updated mock closeouts with baseline mode and device ID.
- Takeover continuation also changed exactly: `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/README.md`, `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/owner-run/run-ctu-owner.sh`, `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/owner-run/run-recovery-owner.sh`, `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-ctu-run-lib.sh`, `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-ctu-runtime-verify.py`, `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-recovery-run-lib.sh`, `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/CTu/apply.sh`, `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/CTu/verify.sh`, `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/Recovery/apply.sh`, `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/Recovery/verify.sh`, `IDEA3-AEGIS_Lockdown/tests/recovery/recovery_support.py`, and `IDEA3-AEGIS_Lockdown/tests/test_ctu_blockers.py`.

## Verification evidence

- `/usr/bin/python3 -m pytest -q tests/test_ctu_blockers.py tests/test_core_trusted_time_repair.py tests/recovery/test_recovery_runner_authority.py tests/recovery/test_recovery_runner_freeze.py tests/recovery/test_recovery_attempt.py` — 297 passed; 3 pre-existing environment-only trust-seam expectation failures
- `/usr/bin/python3 -m pytest -q tests/test_ctu_blockers.py tests/test_core_trusted_time_repair.py tests/recovery tests/rru/test_rru_stage.py tests/r1bv/test_r1bv_contract.py tests/test_recovery_stage.py tests/test_pr11_phase4_harness.py` — final rerun: 1046 passed; 4 environment-only failures (socket permission plus three root/user-namespace trust-seam expectation mismatches), no PR-introduced failures
- `/usr/bin/python3 -m pytest -q tests/test_ctu_blockers.py tests/test_core_trusted_time_repair.py` — pass after final one-shot CTu handler-provenance tightening: 42 passed
- `pytest -v IDEA3-AEGIS_Lockdown/tests/test_core_trusted_time_repair.py` — pass: 24 passed in 2.21s
- `pytest -v IDEA3-AEGIS_Lockdown/tests/recovery/test_recovery_runner_freeze.py` — pass: 74 passed in 25.10s
- `pytest -q IDEA3-AEGIS_Lockdown/tests/r1bv/ IDEA3-AEGIS_Lockdown/tests/r1i/ IDEA3-AEGIS_Lockdown/tests/rru/ IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_harness.py` — pass: 757 passed in 165.23s
- `bash -n` on all changed shell scripts — pass: exit 0, no syntax errors
- `/usr/bin/python3 -m py_compile` on all changed Python files — pass: exit 0, no syntax errors
- `git diff --check` — pass: exit 0, clean whitespace
- `node scripts/validate-vault.mjs` — pass: exit 0, 0 errors, 2 pre-existing canvas owner-review warnings
- `/usr/bin/python3 -m pytest -q IDEA3-AEGIS_Lockdown/tests/test_ctu_blockers.py -k 'interpreter or frozen_entrypoint'` — pass: 4 passed.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-moc.md` — updated Current repair state with pre-live host reconciliation details.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — updated Current Task and Session Register with CTu-S3 pre-live host reconciliation.

## Shared surfaces touched

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-lib.sh` and `p4-stage-gate.sh` — shared Phase-4 authorization/stage-governance surfaces changed for CTu device binding.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-ctu-run-lib.sh`, `p4-recovery-run-lib.sh`, owner runners, CTu/Recovery handlers, freeze tools, and affected tests/README — shared Phase-4 CTu/Recovery governance surfaces changed for provenance, host closeout binding, and source-only handler execution.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-moc.md` and `idea3-status.md` — IDEA3 canonical state updates.
- `REPAIR_RECEIPT_SCOPE_TRUTHFUL=YES`

## Integration requests

- Independent Security and Governance review must verify the exact new head, especially private owner-runner mutation boundaries, host closeout/receipt binding, and the two-restart maximum failure paths. Human owner performs the merge; no live execution is authorized by this receipt.
- The linked worktree Git administrative files are read-only in this environment; normal commit/push and Draft PR update require the human/integration environment to retry after local verification.

## Known limitations

- `CTU_LIVE_EXECUTED=NO`: Repository-only reconciliation; CTu has not run live on the host.
- `CTU_ATTEMPT_CONSUMED=NO`: Attempt marker `CTU-GLOBAL-ATTEMPT-CONSUMED` is absent.
- `RECOVERY_LIVE_EXECUTED=NO`: Recovery remains unexecuted.
- `PRODUCTION_MUTATION_PERFORMED=NO`: Zero live mutations performed.
- Human review and merge required before any live execution. Independent exact-head Security and Governance review remains required; no Draft PR was merged.
