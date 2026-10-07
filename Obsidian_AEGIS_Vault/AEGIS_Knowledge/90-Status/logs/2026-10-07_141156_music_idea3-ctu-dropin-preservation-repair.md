---
title: Task Receipt — IDEA3 CTu Exact-Two Drop-in Preservation Repair
date: 2026-10-07T14:11:56+07:00
owner: music
area: idea3
branch: fix/idea3-ctu-dropin-preservation
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 CTu Exact-Two Drop-in Preservation Repair

## Operational truth

- `CTU_LIVE_EXECUTED=NO`
- `CTU_ATTEMPT_CONSUMED=NO`
- `RECOVERY_LIVE_EXECUTED=NO`
- `RECOVERY_ATTEMPT_CONSUMED=NO`
- `PRODUCTION_MUTATION_PERFORMED=NO`
- `MERGE_PERFORMED=NO`

## What changed

- Replaced CTu's incorrect empty-`DropInPaths` assumption with a strict semantic exact-two contract for `/etc/systemd/system/aegis-idea3-core.service.d/10-recovery.conf` and `/etc/systemd/system/aegis-idea3-core.service.d/20-f1-alert.conf`.
- The contract rejects missing, foreign, modified, symlinked, wrong-owner, and wrong-mode drop-ins before marker consumption; compares systemd ordering as a set; binds expected bytes through `GIT_NO_REPLACE_OBJECTS=1` exact-main Git objects; and is rechecked after install/reload/restart and during rollback.
- Added effective Core unit verification after the single restart: proves SupplementaryGroups contains `aegis-idea3-recovery` and `aegis-idea3-alert`, ReadWritePaths contains `/var/lib/aegis-idea3`, `/run/aegis-idea3`, `/var/log/aegis-idea3`, `/run/aegis-idea3-recovery`, and `/run/aegis-idea3-alert`, ProtectClock is false/no, User is aegis-idea3, NoNewPrivileges is true/yes, and CapabilityBoundingSet and AmbientCapabilities are empty using semantic set comparison.
- Rollback remains unit-only and never removes or rewrites either predecessor drop-in. Existing CTu detector, marker, provenance, restart, Recovery successor, and historical immutability contracts remain preserved.

## Source files changed

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/ctu-acceptance/ctu_dropin_contract.py` — new exact-main drop-in authority and metadata/digest verifier with effective properties validator.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/ctu-acceptance/ctu_verifier_snapshot.py` — includes the verifier in the root-owned trust closure.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-ctu-run-lib.sh` — freezes and manifests the verifier in the CTu bundle.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/owner-run/run-ctu-owner.sh` — adds pre-consume, post-reload, post-restart, and rollback preservation gates.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/CTu/verify.sh` — validates the exact-two semantic set and effective SupplementaryGroups and ReadWritePaths in governed post verification.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/README.md` — documents the exact topology, authority, and rollback boundary.
- `IDEA3-AEGIS_Lockdown/tests/test_core_trusted_time_repair.py` — adds valid/reordered, missing, foreign, byte, symlink, owner, mode, exact-main, preconsume, rollback, and effective properties regression tests.
- `IDEA3-AEGIS_Lockdown/tests/test_ctu_blockers.py` — updates existing restart/order assertions for the new trusted verifier boundary.
- `IDEA3-AEGIS_Lockdown/docs/superpowers/plans/2026-10-07-idea3-ctu-dropin-preservation.md` — implementation plan.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-moc.md` — current repair truth updated.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — CTu-S4 task/session state and exact-two contract recorded.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-10-07_141156_music_idea3-ctu-dropin-preservation-repair.md` — this immutable receipt.

## Verification evidence

- `/usr/bin/python3 -m pytest -q tests/test_core_trusted_time_repair.py tests/test_ctu_blockers.py` — pass: 71 passed in 1.88s.
- `/usr/bin/python3 -m pytest -q tests/test_core_trusted_time_repair.py tests/test_ctu_blockers.py tests/recovery tests/rru/test_rru_stage.py tests/r1bv/test_r1bv_contract.py tests/test_recovery_stage.py tests/test_pr11_phase4_harness.py` — pass: 1,062 passed in 200.80s, 0 failures.
- `bash -n IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/owner-run/run-ctu-owner.sh IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/CTu/verify.sh IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-ctu-run-lib.sh` — pass.
- `/usr/bin/python3 -m py_compile IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/ctu-acceptance/ctu_dropin_contract.py IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/ctu-acceptance/ctu_verifier_snapshot.py IDEA3-AEGIS_Lockdown/tests/test_core_trusted_time_repair.py IDEA3-AEGIS_Lockdown/tests/test_ctu_blockers.py` — pass.
- `git diff --check` — pass.
- `node scripts/validate-vault.mjs` — pass with 2 pre-existing canvas owner-review warnings.
- `node --test tests/vaultStructure.test.mjs tests/vaultMultiWriter.test.mjs tests/collaborationPolicy.test.mjs` — pass: 59 passed in 770ms.
- `node --test tests/coreEntryGovernanceR4.test.mjs` — pass: 2 passed in 40ms.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-moc.md` — replaced the CTu current-repair paragraph with exact-two drop-in preservation truth.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — added the CTu exact-two successor section and CTu-S4 register.

## Shared surfaces touched

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/ctu-acceptance/ctu_dropin_contract.py` — shared Phase-4 privileged authority/trust-closure surface; CTu relies on it before and after host mutation.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/ctu-acceptance/ctu_verifier_snapshot.py` — shared Phase-4 root-owned snapshot trust closure.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-ctu-run-lib.sh` — shared Phase-4 CTu bundle/provenance surface.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/owner-run/run-ctu-owner.sh` — privileged CTu mutation/rollback boundary affecting Recovery successor acceptance.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/CTu/verify.sh` — shared stage verification contract.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-moc.md` and `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — owner-maintained canonical IDEA3 state.

## Integration requests

- Music owner and independent Security/Governance reviewers must inspect the exact-main Git-object binding, root-owned verifier snapshot inclusion, semantic two-path comparison, and proof that rollback never mutates predecessor drop-ins. Kla integration review is required for the shared Phase-4 authority/trust-closure surfaces before merge; after merge, fresh CTu Authorization/K3/freeze artifacts must be generated and the CTu LIVE boundary independently reviewed. No live execution is authorized by this receipt.

## Known limitations

- No Production host was contacted or mutated; CTu and Recovery remain unconsumed/unexecuted (`CTU_ATTEMPT_CONSUMED=NO`, `CTU_LIVE_EXECUTED=NO`, `RECOVERY_ATTEMPT_CONSUMED=NO`, `RECOVERY_LIVE_EXECUTED=NO`, `PRODUCTION_MUTATION_PERFORMED=NO`).
- Live systemd effective properties, real root:root metadata, SupplementaryGroups, ReadWritePaths, and post-restart preservation are repository-contract verified only and require the separately authorized host run.
