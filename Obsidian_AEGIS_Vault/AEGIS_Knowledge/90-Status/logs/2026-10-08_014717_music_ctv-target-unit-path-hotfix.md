---
title: Task Receipt — IDEA3 CTv Target Unit Path Hotfix
date: 2026-10-08T01:47:17+07:00
owner: music
area: idea3
branch: fix/idea3-ctv-target-unit-path
status: partial
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 CTv Target Unit Path Hotfix

## What changed

- Corrected the non-hermetic CTv owner-runner default from the obsolete nonexistent Core unit path to the reviewed repository Core unit example.
- Added a real-tree regression proving the exact target path, Core security contract, obsolete-path rejection, and preserved hermetic `--unit-source` override.
- Audited the complete CTv production repository dependency closure against exact main `56beb898f5b4f8bd4b39d0934ef0f80bc9dc63e2`; all listed and bundle-declared paths exist.

## Source files changed

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/owner-run/run-ctv-owner.sh` — corrected production `UNIT_SOURCE` default.
- `IDEA3-AEGIS_Lockdown/tests/test_ctv_successor.py` — added TDD regression for default path, unit properties, obsolete path, and override support.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-moc.md` — recorded the repository-only path repair and exact-main closure audit.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — updated the owner current-task/session record.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-10-08_014717_music_ctv-target-unit-path-hotfix.md` — this immutable receipt.

## Verification evidence

- `/usr/bin/python3 -m pytest -q tests/test_ctv_successor.py -k production_default_targets_reviewed_core_unit_and_override_is_preserved` — RED before fix: 1 failed; GREEN after fix: 1 passed.
- `/usr/bin/python3 -m pytest -q tests/test_ctv_successor.py` — pass: 63 passed.
- `/usr/bin/python3 -m pytest -q tests/test_ctu_blockers.py` — pass: 30 passed.
- `/usr/bin/python3 -m pytest -q tests/test_ctu_l0_dependency_closure.py` — pass: 5 passed.
- `/usr/bin/python3 -m pytest -q tests/test_core_trusted_time_repair.py tests/test_core_service.py` — pass: 58 passed.
- `/usr/bin/python3 -m pytest -q tests/recovery/test_recovery_preservation.py tests/recovery/test_recovery_runner_authority.py tests/recovery/test_recovery_runner_freeze.py tests/recovery/test_recovery_snapshot_freeze.py tests/recovery/test_recovery_bootstrap_authority.py` — partial: 314 passed, 3 `BLOCKED_ENVIRONMENT` failures caused by sandbox trust-seam/user-namespace ownership behavior (`SNAPSHOT_ANCESTOR_NOT_TRUSTED_OWNER` instead of the expected refusal token).
- `/usr/bin/python3 -m pytest -q tests/test_recovery_stage.py tests/test_recovery_evidence.py tests/test_recovery_final_verify.py` — pass: 239 passed.
- Exact-main CTv dependency audit using `git cat-file -e` for the owner runner, libraries, helpers, freeze/snapshot tooling, CTv handlers, allow files, reviewed Core unit, and all bundle entries — pass: `ALL_CTV_PRODUCTION_REPO_PATHS_EXIST=PASS`; no additional missing paths.
- `bash -n IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/owner-run/run-ctv-owner.sh` — pass.
- `/usr/bin/python3 -m py_compile IDEA3-AEGIS_Lockdown/tests/test_ctv_successor.py` — pass.
- `node --test tests/collaborationPolicy.test.mjs tests/vaultMultiWriter.test.mjs tests/vaultStructure.test.mjs` — `BLOCKED_ENVIRONMENT`: collaboration/vault multi-writer fixtures require child `git`, which returns `EPERM` in this sandbox; vault structure passed.
- `node --test tests/coreEntryGovernanceR4.test.mjs` — pass: 2 passed.
- `node scripts/validate-vault.mjs` — pass with 2 pre-existing canvas owner-review warnings.
- `git diff --check` — pass.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-moc.md` — current CTv summary now records the corrected default and audit result.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — current task/session record now describes this branch and evidence boundary.

## Shared surfaces touched

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/owner-run/run-ctv-owner.sh` — privileged Phase-4 CTv production/rollback boundary; integration review must confirm the target path is the reviewed Core unit and that no governance or rollback contract changed.

## Integration requests

- Music owner and Kla integration reviewer must inspect the exact-head runner default, reviewed Core unit security properties, preserved `--unit-source` hermetic seam, and exact-main dependency audit before merge. After human merge, regenerate fresh exact-main CTv authority/freeze artifacts; do not reuse pre-hotfix artifacts. No CTv LIVE, Recovery LIVE, Production mutation, Core restart, Detector lifecycle command, governance-marker mutation, merge, or Ready transition is authorized by this receipt.

## Known limitations

- Recovery trust-seam tests remain blocked by this host sandbox’s user-namespace/root-ownership behavior; rerun on a host with the required capability.
- Collaboration policy and vault multi-writer tests remain blocked by sandbox `EPERM` on child `git`; no test result was converted to PASS.
- CTu remains immutable consumed FAIL; CTv and Recovery remain unconsumed and unexecuted.
