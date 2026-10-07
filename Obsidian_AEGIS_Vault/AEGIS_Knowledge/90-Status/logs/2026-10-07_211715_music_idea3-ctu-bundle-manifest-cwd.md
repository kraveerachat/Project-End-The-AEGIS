---
title: Task Receipt — IDEA3 CTu Bundle Manifest CWD Verification Repair
date: 2026-10-07T21:17:15+07:00
owner: music
area: idea3
branch: fix/idea3-ctu-bundle-manifest-cwd
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 CTu Bundle Manifest CWD Verification Repair

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

The latest CTu owner-run returned `CTU_RESULT=FAIL_IMMUTABLE CTU_ATTEMPT_CONSUMED=NO reason=CTU_BUNDLE` before stage governance initialization or marker consumption. Canonical marker state proves the one-shot attempt was NOT consumed (`CTU-GLOBAL-ATTEMPT-CONSUMED=ABSENT`, `CTU-GLOBAL-CLOSEOUT-PASS=ABSENT`, `CTU-GLOBAL-CLOSEOUT-FAIL=ABSENT`). The failed frozen runner bound to main `8f337dad15f4e89d2265a95741b90128c14e6a39` and SHA `ed1e656a24f7d126b87828b59d5b726b9d337d5887c4b4c5a8b26ed7b2b173e0` is invalidated for future LIVE use. Old Auth/K3 are invalid. CTu attempt remains unconsumed, CTu LIVE was NOT executed, and zero Production runtime mutation occurred.

## What changed

- Repaired CTu bundle preparation tooling (`IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-ctu-run-lib.sh` line 164): replaced `$CTU_SUDO sha256sum -c --quiet --strict "$bundle/CTU-BUNDLE-SHA256SUMS" >/dev/null 2>&1` with `( cd "$bundle" && $CTU_SUDO sha256sum -c --quiet --strict CTU-BUNDLE-SHA256SUMS ) >/dev/null 2>&1`. GNU `sha256sum` resolves relative filenames in a manifest relative to process CWD; when the runner CWD was outside `$bundle`, verification deterministically failed to find the files, failing bundle preparation before marker consumption.
- Consistency across bundle manifest consumers: verified that `ctu_prepare_bundle`, `ctu_verify_bundle`, `stages/CTu/verify.sh`, and the embedded apply/rollback routines all consistently subshell `cd` into `$bundle` (`$AEGIS_CTU_BUNDLE`) before verifying `CTU-BUNDLE-SHA256SUMS`.
- Pre-consume preparation chain audit: audited all steps before `ctu_consume_attempt`. Found and repaired that `$bundle/ctu-acceptance` was omitted from bundle directory `chmod 0555` (leaving it mode 0700). Updated line 162 to chmod `$bundle/ctu-acceptance` to `0555` alongside root and other subdirectories, and explicitly set `$bundle/CTU-BUNDLE-SHA256SUMS` to mode `0444`.
- Added comprehensive behavioral regression tests in `IDEA3-AEGIS_Lockdown/tests/test_ctu_blockers.py`:
  1. `test_ctu_bundle_manifest_relative_cwd_verification_matrix`: demonstrates points 1–6 (relative manifest paths, old verification failing from outside CWD, repaired verification passing from outside CWD, modified bundled file refused, missing file refused, malformed manifest refused under `--strict`).
  2. `test_ctu_prepare_bundle_end_to_end_behavioral`: exercises `ctu_prepare_bundle` and `ctu_verify_bundle` end-to-end with caller CWD outside bundle, proving success, directory modes `0555`, manifest mode `0444`, and refusal of tampered bundles.

## Source files changed

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-ctu-run-lib.sh` — repaired CWD handling in `ctu_prepare_bundle` manifest verification, sealed `$bundle/ctu-acceptance` to `0555`, and set `$bundle/CTU-BUNDLE-SHA256SUMS` to `0444`.
- `IDEA3-AEGIS_Lockdown/tests/test_ctu_blockers.py` — added behavioral regression matrix and end-to-end bundle preparation tests.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-moc.md` — updated current repair truth with bundle manifest CWD repair and invalidated runner SHA.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — recorded CTu bundle manifest relative CWD verification repair and CTu-S7 session register.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-10-07_211715_music_idea3-ctu-bundle-manifest-cwd.md` — this immutable task receipt.

## Verification evidence

- `pytest -v IDEA3-AEGIS_Lockdown/tests/test_core_trusted_time_repair.py IDEA3-AEGIS_Lockdown/tests/test_ctu_blockers.py` — pass: 80 passed in 2.16s.
- `pytest -q IDEA3-AEGIS_Lockdown/tests/recovery IDEA3-AEGIS_Lockdown/tests/test_recovery_stage.py IDEA3-AEGIS_Lockdown/tests/test_recovery_evidence.py IDEA3-AEGIS_Lockdown/tests/test_recovery_final_verify.py` — pass: 676 passed in 74.31s.
- `bash -n IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-ctu-run-lib.sh` — pass: zero syntax errors or warnings.
- `python3 -m py_compile IDEA3-AEGIS_Lockdown/tests/test_ctu_blockers.py` — pass.
- `git diff --check` — pass: clean whitespace, no trailing whitespace, no EOF issues.
- `node scripts/validate-vault.mjs` — pass with 2 pre-existing canvas owner-review warnings.
- `node --test tests/vaultStructure.test.mjs tests/vaultMultiWriter.test.mjs tests/collaborationPolicy.test.mjs` — pass: 59 passed in 777ms.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-moc.md` — updated current repair truth with bundle manifest CWD verification details and invalidated runner SHA.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — added CTu bundle manifest relative CWD verification repair section and CTu-S7 session register.

## Shared surfaces touched

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-ctu-run-lib.sh` — Phase-4 CTu library and bundle preparation tooling.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-moc.md` and `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — owner-maintained canonical IDEA3 state.

## Integration requests

- Music owner and independent Security/Governance reviewers must inspect the repaired CWD handling in `p4-ctu-run-lib.sh` line 164, the sealed `ctu-acceptance` mode, and the behavioral regression tests. Kla integration review is required for the shared Phase-4 deployment/governance surface before merge. After human merge of this repair PR, fresh post-merge exact-main clone, root authority, control snapshot, pins, frozen runner, Authorization, and K3 must be generated. The failed frozen runner (`ed1e656a...`) and historical failed authority must not be reused. HUMAN MERGE ONLY. No live execution is authorized by this receipt.

## Known limitations

- No Production host was contacted or mutated; CTu and Recovery remain unconsumed and unexecuted (`CTU_ATTEMPT_CONSUMED=NO`, `CTU_LIVE_EXECUTED=NO`, `RECOVERY_ATTEMPT_CONSUMED=NO`, `RECOVERY_LIVE_EXECUTED=NO`, `PRODUCTION_RUNTIME_MUTATION_PERFORMED=NO`).
- Live production host execution requires human review, human merge, and building fresh post-merge exact-main authority artifacts.
