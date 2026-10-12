---
title: Task Receipt — IDEA3 RRu Recovery-capable release successor
date: 2026-10-06T22:33:38+07:00
owner: music
area: idea3
branch: fix/idea3-recovery-release-cli-successor
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 RRu Recovery-capable release successor

## What changed

- Added the corrected deterministic release-builder `cli` entrypoint and complete closure proof, including manifested `aegis_soc/cli.py`, real release import, and D4 terminal refusal rehearsal.
- Completed the repository-only governed `RRu` successor stage: exactly one stage after `R1Bv` and before `Recovery`, one-attempt authority, R1B/R1Bv predecessor gates, immutable release installation, atomic `current` switch, preservation checks, and bounded rollback.
- RRu remains repository/local only. No RRu LIVE attempt, Recovery attempt, Production mutation, or ESP32 action occurred.

## Source files changed

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-l7-build-release.py` — make `cli` a first-class deterministic release entrypoint.
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l7_release_builder.py` — prove CLI closure, manifest/sums, import, and D4 rehearsal.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-compare.sh` — register the RRu one-release comparison allowance.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-lib.sh` — register exactly one `RRu` stage between `R1Bv` and `Recovery`.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-stage-gate.sh` — recognize RRu authorization metadata rules.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-rru-upgrade.py` — implement read-only preflight, journaled install/switch, unchanged-process proof, verify, and bounded rollback.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-rru-run-lib.sh` — implement RRu owner gates, predecessor/marker checks, capture transition proofs, and rollback output validation.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/owner-run/run-rru-owner.sh` — inert frozen-runner template; refuses unpinned execution.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/RRu/apply.sh` — root apply handler.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/RRu/verify.sh` — root read-only verify handler.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/RRu/rollback.sh` — root bounded rollback handler.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/RRu/allow-keys.txt` — exact forward pointer allowance.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/RRu/allow-keys-rollback.txt` — zero rollback comparison allowance.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/RRu/allow-listeners.txt` — zero listener allowance.
- `IDEA3-AEGIS_Lockdown/tests/rru/test_rru_stage.py` — load-bearing RRu registry, safety, predecessor, mutation, preservation, rollback, and claim-boundary tests.
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l7u_release_builder_recovery_runtime.py` — reconcile the existing recovery-runtime closure regression to four entrypoints.
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l7u_stage_governance.py` — preserve older stage semantics while asserting the RRu successor order.
- `IDEA3-AEGIS_Lockdown/tests/test_recovery_stage.py` — assert `R1Bv -> RRu -> Recovery -> L8` registry order.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — record repository implementation and current no-LIVE truth.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-moc.md` — reconcile current Recovery/RRu sequence and readiness boundary.

## Verification evidence

- `TMPDIR=/home/kittipat/Workspace/.pytest-aegis /home/kittipat/.venvs/aegis-idea3-core/bin/python -m pytest --basetemp=/home/kittipat/Workspace/.pytest-aegis/builder-venv -q IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l7_release_builder.py IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l7u_release_builder_recovery_runtime.py` — pass: 107 passed.
- `TMPDIR=/dev/shm /home/kittipat/.venvs/aegis-idea3-core/bin/python -m pytest --basetemp=/dev/shm/pytest-rru -q IDEA3-AEGIS_Lockdown/tests/rru/test_rru_stage.py` — pass: 92 passed.
- `TMPDIR=/home/kittipat/x /home/kittipat/.venvs/aegis-idea3-core/bin/python -m pytest --basetemp=/home/kittipat/x/final -q IDEA3-AEGIS_Lockdown/tests/rru/test_rru_stage.py IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l7_release_builder.py IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l7u_release_builder_recovery_runtime.py IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l7u_stage_governance.py IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l7u_upgrade_engine.py IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l7u_recovery_runtime_contract.py IDEA3-AEGIS_Lockdown/tests/recovery/test_recovery_d4_readiness.py IDEA3-AEGIS_Lockdown/tests/recovery/test_recovery_attempt.py IDEA3-AEGIS_Lockdown/tests/recovery/test_recovery_preservation.py IDEA3-AEGIS_Lockdown/tests/test_recovery_stage.py` — pass: 641 passed.
- `bash -n` on all changed shell handlers/libraries and `/home/kittipat/.venvs/aegis-idea3-core/bin/python -m py_compile IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-rru-upgrade.py` — pass.
- `node --test tests/collaborationPolicy.test.mjs tests/vaultMultiWriter.test.mjs tests/vaultStructure.test.mjs` — pass: 59 passed.
- `node scripts/validate-vault.mjs` — pass with 2 pre-existing owner-data canvas warnings.
- Corrected secret-shaped content scan over changed deployment/tests/IDEA3 knowledge paths — pass.
- `git diff --check` — pass.
- `git fetch origin main` and `git rev-parse origin/main` — pass; `origin/main=ee1f58c118d64bc635e16feefad6d1d6da0d5432`, unchanged from task start.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — added current RRu repository-only state, safety boundary, and session register.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-moc.md` — updated current Recovery state to include the unexecuted RRu preparation stage.

## Shared surfaces touched

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-compare.sh` — shared Phase-4 preservation comparator now accepts only the exact RRu one-release catalog delta.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-lib.sh` — shared Phase-4 stage registry now orders RRu before Recovery.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-stage-gate.sh` — shared stage authorization gate recognizes RRu as a mutating governed stage.

## Integration requests

- Kla/integration review: verify the shared Phase-4 comparator, registry, and stage-gate changes preserve older stage semantics and approve the exact `R1Bv -> RRu -> Recovery` ordering. RRu rollout remains owner-authorized only; if a future RRu attempt fails, rollback may remove only its journal-proven NEW release and restore `current` if the pointer still matches its target. No Recovery rollout is authorized by this task.

## Known limitations

- RRu LIVE is intentionally not executed; no host release install, `current` transition, RRu marker consumption, Recovery marker consumption, Production mutation, or ESP32 action is proven by this receipt.
- The committed owner runner is intentionally unpinned and refuses to run until an owner creates a fresh exact-main authority, control/verifier snapshots, Authorization, K3, and frozen runner outside the repository.
- The system `/usr/bin/python` lacks pip in this environment; builder verification used the repository’s pinned `/home/kittipat/.venvs/aegis-idea3-core/bin/python` as shown above.
- The unrelated untracked `.impeccable/hook.cache.json` was preserved and excluded from this task.
