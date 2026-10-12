---
title: Task Receipt — IDEA3 CTu Trusted Work Directory Traversal Contract Repair
date: 2026-10-07T22:19:00+07:00
owner: music
area: idea3
branch: fix/idea3-ctu-trusted-work-traverse
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 CTu Trusted Work Directory Traversal Contract Repair

## Operational truth

- `CTU_ATTEMPT_CONSUMED=NO`
- `CTU_LIVE_EXECUTED=NO`
- `RECOVERY_ATTEMPT_CONSUMED=NO`
- `RECOVERY_LIVE_EXECUTED=NO`
- `PRODUCTION_RUNTIME_MUTATION_PERFORMED=NO`
- `MERGE_PERFORMED=NO`
- `FAILURE_PHASE=PRE_CONSUME_BUNDLE_PREPARATION`
- `FAILURE_REASON=CTU_BUNDLE`
- `PRECONSUME_MUTATION=0`
- `SUCCESS_CORE_RESTARTS=1`
- `POSTCONSUME_FAILURE_MAX_CORE_RESTARTS=2`
- `EXPLICIT_DETECTOR_LIFECYCLE_COMMANDS=0`
- `MARKER_ORDER=PASS`
- `RECOVERY_SUCCESSOR_CONTRACT=PASS`

The latest CTu owner-run returned `CTU_RESULT=FAIL_IMMUTABLE CTU_ATTEMPT_CONSUMED=NO CTU_RERUN_ALLOWED=NO CTU_FAILURE_REASON=CTU_BUNDLE` before stage governance initialization or marker consumption. Canonical marker state proves the one-shot attempt was NOT consumed (`CTU-GLOBAL-ATTEMPT-CONSUMED=ABSENT`, `CTU-GLOBAL-CLOSEOUT-PASS=ABSENT`, `CTU-GLOBAL-CLOSEOUT-FAIL=ABSENT`, `RECOVERY-GLOBAL-ATTEMPT-CONSUMED=ABSENT`). Forensic analysis of `/home/kittipat/Workspace/idea3-p4-evidence/2026-10-07-ctu-20261007-214845` proved all 18 bundle files existed, matched expected manifest counts, and passed sha256sum verification under root. However, the parent work directory `$WORK` (`ctu-work`) was created implicitly as `root:root 0700` (`---` for others), preventing the unprivileged operator (`kittipat`, UID 1000) from traversing (`cd`) into `$bundle` (`0555`), triggering `Permission denied`. The failed frozen runner bound to main `5d3245eaab9aa7337b570ef7fb949e937a46575b` / SHA `35441dd71996b4def12a89d948afe0c8fdbf43ab91291fead525378c0811df4c` is invalidated for future LIVE use. Old Auth/K3 are invalid. CTu attempt remains unconsumed, CTu LIVE was NOT executed, and zero Production runtime mutation occurred.

## What changed

- Added `ctu_prepare_work_dir()` and `ctu_verify_work_dir()` in `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-ctu-run-lib.sh`:
  - `ctu_prepare_work_dir()` creates `$work` (`ctu-work`) explicitly with mode `0711` and owner `root:root` (or current user when running unprivileged without sudo), syncs, and validates the directory.
  - `ctu_verify_work_dir()` validates that `$work` is a directory, not a symlink, owned by `0:0`, has mode `0711`, has no group/other write permissions (`-perm /022`), is executable (`[ -x "$work" ]`), is NOT writable by non-root (`[ ! -w "$work" ]`), and is NOT readable by non-root (`[ ! -r "$work" ]`).
- Updated bundle preparation and snapshot routines in `p4-ctu-run-lib.sh`:
  - `ctu_prepare_bundle()` prepares `$work` as `0711` and validates it via `ctu_verify_work_dir` before verifying bundle contents.
  - `ctu_verify_bundle()` and `ctu_verify_unit_snapshot()` verify `$work` using `ctu_verify_work_dir`.
  - `ctu_prepare_unit_snapshot()` prepares `$work` as `0711` via `ctu_prepare_work_dir` and asserts snapshot file mode `0644`.
- Updated `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/owner-run/run-ctu-owner.sh`:
  - Explicitly creates `$WORK` via `ctu_prepare_work_dir "$WORK"` after creating `$EVID`.
  - Added pre-bundle verification `ctu_verify_work_dir "$WORK" || post_fail WORK_DIR`.
  - Added work directory mode/owner validation (`0:711`) in both `ctu_apply_governed` and `ctu_rollback_governed`.
- Updated `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/CTu/verify.sh`:
  - Added validation ensuring `$AEGIS_CTU_WORK_DIR` is owned `0:0` with mode `711`.
- Added comprehensive behavioral regression tests in `IDEA3-AEGIS_Lockdown/tests/test_ctu_blockers.py`:
  - `test_ctu_trusted_work_live_permission_topology_matrix`: tests full root-owned preparation (`$work` 0711, `$bundle` 0555, manifest 0444, snapshot 0644) and dropped-privilege operator execution across all 8 actions:
    1. Operator traverses `$work` (`os.chdir(bundle)`) — PASS.
    2. Operator cannot list `$work` (`os.listdir(work) -> PermissionError`) — PASS.
    3. Operator cannot write to `$work` (`open(work/probe, 'w') -> PermissionError`) — PASS.
    4. Operator reads unit snapshot (`open(snapshot, 'r')`) — PASS.
    5. Operator reads manifest (`open(bundle/CTU-BUNDLE-SHA256SUMS, 'r')`) — PASS.
    6. Operator sources `p4-ctu-run-lib.sh` — PASS.
    7. Operator sources `p4-l7u-run-lib.sh` — PASS.
    8. Operator executes `p4-stage-gate.sh` — PASS.
    9. Operator reads manifest for provenance in `ctu_consume_attempt` — PASS.
    10. BASE_MAIN regression verification: under mode `0700`, operator traversal and reading are blocked (`PermissionError`).
  - Updated `test_ctu_prepare_bundle_end_to_end_behavioral` to assert `0711` mode for `$work`.

## Source files changed

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-ctu-run-lib.sh` — added `ctu_prepare_work_dir` (mode 0711) and `ctu_verify_work_dir`, updated bundle and snapshot preparation/verification.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/owner-run/run-ctu-owner.sh` — explicit `$WORK` creation as 0711, pre-bundle verification, and apply/rollback work directory validation.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/CTu/verify.sh` — verified `$AEGIS_CTU_WORK_DIR` permissions as `0:711`.
- `IDEA3-AEGIS_Lockdown/tests/test_ctu_blockers.py` — added live permission topology matrix and updated end-to-end bundle tests.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-moc.md` — updated current repair truth with trusted work directory traversal contract and invalidated runner SHA.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — added CTu-S8 session register and trusted work traversal contract repair section.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-10-07_221000_music_idea3-ctu-trusted-work-traverse.md` — this immutable task receipt.

## Verification evidence

- `pytest -v IDEA3-AEGIS_Lockdown/tests/test_core_trusted_time_repair.py IDEA3-AEGIS_Lockdown/tests/test_ctu_blockers.py` — pass: 81 passed in 2.58s.
- `pytest -q IDEA3-AEGIS_Lockdown/tests/recovery IDEA3-AEGIS_Lockdown/tests/test_recovery_stage.py IDEA3-AEGIS_Lockdown/tests/test_recovery_evidence.py IDEA3-AEGIS_Lockdown/tests/test_recovery_final_verify.py` — pass: 676 passed in 75.67s.
- `bash -n IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/owner-run/run-ctu-owner.sh IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-ctu-run-lib.sh IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/CTu/verify.sh` — pass: zero syntax errors or warnings.
- `git diff --check` — pass: clean whitespace, no trailing whitespace, no EOF issues.
- `node scripts/validate-vault.mjs` — pass with 2 pre-existing canvas owner-review warnings.
- `node --test tests/vaultStructure.test.mjs tests/vaultMultiWriter.test.mjs tests/collaborationPolicy.test.mjs` — pass.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-moc.md` — updated current repair truth with trusted work traversal contract details and invalidated runner SHA.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — added CTu trusted work directory traversal contract repair section and CTu-S8 session register.

## Shared surfaces touched

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-ctu-run-lib.sh` — Phase-4 CTu library, work directory preparation and verification.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/owner-run/run-ctu-owner.sh` — Phase-4 CTu owner-run script, work directory creation, pre-bundle verification, and apply/rollback validation.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/CTu/verify.sh` — Phase-4 CTu verification script, work directory validation.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-moc.md` and `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — owner-maintained canonical IDEA3 state.

## Integration requests

- Music owner and independent Security/Governance reviewers must inspect the repaired trusted work directory traversal contract in `p4-ctu-run-lib.sh`, `run-ctu-owner.sh`, and `verify.sh`, ensuring mode `0711` safely permits traversal without read or write access for non-root users, and the permission matrix tests in `test_ctu_blockers.py`. Kla integration review is required for the shared Phase-4 deployment/governance surface before merge. After human merge of this repair PR, fresh post-merge exact-main clone, root authority, control snapshot, pins, frozen runner, Authorization, and K3 must be generated. The failed frozen runner (`35441dd7...`) and historical failed authority must not be reused. HUMAN MERGE ONLY. No live execution is authorized by this receipt.

## Known limitations

- No Production host was contacted or mutated; CTu and Recovery remain unconsumed and unexecuted (`CTU_ATTEMPT_CONSUMED=NO`, `CTU_LIVE_EXECUTED=NO`, `RECOVERY_ATTEMPT_CONSUMED=NO`, `RECOVERY_LIVE_EXECUTED=NO`, `PRODUCTION_RUNTIME_MUTATION_PERFORMED=NO`).
- Live production host execution requires human review, human merge, and building fresh post-merge exact-main authority artifacts.
