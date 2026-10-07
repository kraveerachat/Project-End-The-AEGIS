---
title: Task Receipt — IDEA3 CTu Control Snapshot Directory Seal Repair
date: 2026-10-07T19:50:00+07:00
owner: music
area: idea3
branch: fix/idea3-ctu-control-snapshot-directory-seal
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 CTu Control Snapshot Directory Seal Repair

## Operational truth

- `CTU_ATTEMPT_CONSUMED=NO`
- `CTU_LIVE_EXECUTED=NO`
- `RECOVERY_ATTEMPT_CONSUMED=NO`
- `RECOVERY_LIVE_EXECUTED=NO`
- `PRODUCTION_RUNTIME_MUTATION_PERFORMED=NO`
- `MERGE_PERFORMED=NO`

Historical authority preparation failed closed before frozen runner, Authorization, K3, or LIVE execution (`reason=CONTROL_SOURCE_WRITABLE:ctu-acceptance`). The failed preparation authority (`/opt/aegis-idea3-ctu-authority-23f5d0f8b55ce1478f840b6df0ae8b75b9e62f46`) is historical failed-preparation evidence only; it was neither modified nor reused.

## What changed

- Repaired CTu control snapshot tooling (`IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/ctu-acceptance/ctu_verifier_snapshot.py`): `control_snapshot()` now deterministically seals every directory in the snapshot tree (the destination root directory and all nested subdirectories: `ctu-acceptance/`, `stages/CTu/`, `owner-run/`) to mode `0555` after all snapshot files and the manifest have been written.
- Maintained file mode invariants: executable/script trust-closure files remain `0555`, non-executable trust-closure files remain `0444`, and `CTU-CONTROL-SHA256SUMS` remains `0444`.
- Maintained fail-closed verification: `control_check()` verifies that neither the root directory nor any nested directory or file possesses any write bit (`stat.S_IWUSR | stat.S_IWGRP | stat.S_IWOTH`), and root-owned builds automatically execute `control_check()` upon creation.
- Added comprehensive behavioral regression tests proving all 14 required properties: nested directories 0555/non-writable, root directory 0555/non-writable, `ctu-acceptance/` 0555/non-writable, `stages/CTu/` 0555/non-writable, copied scripts 0555, non-executable files 0444, manifest 0444, immediate success of `control_check` on fresh valid snapshot, failure of `control_check` upon re-adding write bit to any directory, failure upon re-adding write bit to any file, fail-closed symlink protections, exactness of trust closure set, root-owned behavior protection, and preservation of existing CTu freeze blocker tests.

## Source files changed

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/ctu-acceptance/ctu_verifier_snapshot.py` — seals all snapshot directories to mode `0555`, verifies root directory write bits in `control_check`, and validates freshly created root-owned snapshots.
- `IDEA3-AEGIS_Lockdown/tests/test_ctu_blockers.py` — added behavioral regression tests verifying directory seal, file mode contracts, writable directory/file refusal, symlink refusal, trust closure exactness, and user-namespace root-owned verification.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/README.md` — updated CTu freeze & verifier documentation with directory seal contract.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-moc.md` — updated current repair truth with snapshot directory seal repair.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — recorded CTu control snapshot directory seal repair and CTu-S5 session register.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-10-07_195000_music_idea3-ctu-control-snapshot-directory-seal.md` — this immutable task receipt.

## Verification evidence

- `/usr/bin/python3 -m pytest -q tests/test_core_trusted_time_repair.py tests/test_ctu_blockers.py` — pass: 77 passed in 1.92s.
- `/usr/bin/python3 -m pytest -q tests/recovery tests/test_recovery_stage.py tests/test_recovery_evidence.py tests/test_recovery_final_verify.py` — pass: 676 passed in 76.19s.
- `bash -n IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/owner-run/run-ctu-owner.sh IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/CTu/verify.sh IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/CTu/apply.sh IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/CTu/rollback.sh IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-ctu-run-lib.sh` — pass.
- `/usr/bin/python3 -m py_compile IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/ctu-acceptance/ctu_verifier_snapshot.py IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/ctu-acceptance/ctu_runner_freeze.py IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/ctu-acceptance/ctu_dropin_contract.py IDEA3-AEGIS_Lockdown/tests/test_ctu_blockers.py IDEA3-AEGIS_Lockdown/tests/test_core_trusted_time_repair.py` — pass.
- `git diff --check` — pass.
- `node scripts/validate-vault.mjs` — pass with 2 pre-existing canvas owner-review warnings.
- `node --test tests/vaultStructure.test.mjs tests/vaultMultiWriter.test.mjs tests/collaborationPolicy.test.mjs` — pass: 59 passed in 745ms.
- `node --test tests/coreEntryGovernanceR4.test.mjs` — pass: 2 passed in 39ms.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-moc.md` — updated current repair truth with CTu control snapshot directory seal contract.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — added CTu control snapshot directory seal repair section and CTu-S5 session register.

## Shared surfaces touched

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/ctu-acceptance/ctu_verifier_snapshot.py` — shared Phase-4 privileged authority and root-owned snapshot trust closure tooling.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-moc.md` and `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — owner-maintained canonical IDEA3 state.

## Integration requests

- Music owner and independent Security/Governance reviewers must inspect the deterministic directory sealing (mode `0555`), fail-closed `control_check` write-bit rejection on both root and nested directories, and behavioral regression tests. Kla integration review is required for the shared Phase-4 authority/trust-closure surface before merge. After human merge of this repair PR, a fresh exact-main CTu authority must be built from the merged commit; the failed `/opt` authority (`23f5d0f8...`) must remain untouched and must not be reused. No live execution is authorized by this receipt.

## Known limitations

- No Production host was contacted or mutated; CTu and Recovery remain unconsumed and unexecuted (`CTU_ATTEMPT_CONSUMED=NO`, `CTU_LIVE_EXECUTED=NO`, `RECOVERY_ATTEMPT_CONSUMED=NO`, `RECOVERY_LIVE_EXECUTED=NO`, `PRODUCTION_RUNTIME_MUTATION_PERFORMED=NO`).
- Live production host execution requires human review, human merge, and building fresh post-merge exact-main authority artifacts.
