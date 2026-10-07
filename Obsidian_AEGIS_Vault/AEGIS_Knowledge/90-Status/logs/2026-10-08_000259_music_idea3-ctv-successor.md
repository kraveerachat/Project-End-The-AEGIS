---
title: Task Receipt — IDEA3 CTv immutable-CTu-failure successor
date: 2026-10-08T00:02:59+07:00
owner: music
area: idea3
branch: feat/idea3-ctv-ctu-immutable-failure-successor
status: partial
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 CTv immutable-CTu-failure successor

## What changed

- Added repository-only CTv successor governance after the immutable CTu APPLY failure.
- Preserved CTu history: `CTU_RESULT=FAIL_IMMUTABLE`, `CTU_ATTEMPT_CONSUMED=YES`, `CTU_RERUN_ALLOWED=NO`; CTu was not rerun.
- Separated frozen-runner, exact-main template, bundle-manifest, and control-manifest provenance identities.
- Added a non-consuming pre-consume rehearsal contract and durable `phase=consumed-no-production-mutation` journal with zero-restart rollback.
- Added the Recovery successor gate for a reviewed CTv PASS without fabricating CTu PASS.

## Source files changed

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-ctv-run-lib.sh` — CTv provenance, bundle, rehearsal, one-attempt, and journal primitives.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/ctv-acceptance/ctv_runner_freeze.py` — separate CTv frozen-runner provenance helper.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/ctv-acceptance/ctv_verifier_snapshot.py` — CTv control-manifest helper.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/owner-run/run-ctv-owner.sh` — inert repository template and pre-consume boundary.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/CTv/*` — registered refusal-only public handlers and allowlists.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-lib.sh` — CTv stage registration and authorization fields.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-stage-gate.sh` — CTv binding validation.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-recovery-run-lib.sh` — reviewed CTv successor Recovery gate.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/owner-run/run-recovery-owner.sh` — CTu PASS or CTv PASS predecessor selection.
- `IDEA3-AEGIS_Lockdown/tests/test_ctv_successor.py` — hermetic provenance, journal, handler, and rehearsal regressions.
- `IDEA3-AEGIS_Lockdown/tests/**` — existing stage-order expectations updated for the registered CTv successor.
- `docs/superpowers/plans/2026-10-08-idea3-ctv-immutable-failure-successor.md` — implementation plan and safety boundary.

## Verification evidence

- `python3` direct execution of all focused CTv test functions — pass.
- `bash -n` on changed shell scripts — pass.
- `python3 -m pytest -q IDEA3-AEGIS_Lockdown/tests/test_ctv_successor.py` — blocked: pytest is not installed in this environment; direct execution passed.
- `pytest -q tests/test_ctv_successor.py tests/test_ctu_blockers.py tests/test_ctu_l0_dependency_closure.py tests/test_core_trusted_time_repair.py tests/rru` — pass: 216 tests.
- `node --test tests/collaborationPolicy.test.mjs tests/vaultMultiWriter.test.mjs tests/vaultStructure.test.mjs` — pass: 59 tests with host Git permissions.
- `node scripts/validate-vault.mjs` — pass with two pre-existing canvas owner-data warnings.
- CTv LIVE / Recovery LIVE — intentionally not run.
- Production mutation, Core restart, Detector lifecycle, and governance-marker mutation — none.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — current CTv repository state, immutable CTu facts, and session register.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-moc.md` — current CTv successor and Recovery gating truth.

## Shared surfaces touched

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-lib.sh` — shared Phase-4 stage registry and authorization contract; requires integration review.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-stage-gate.sh` — shared governance gate; requires integration review.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-recovery-run-lib.sh` — Recovery successor contract; requires Recovery-owner integration review.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/owner-run/run-recovery-owner.sh` — Recovery predecessor selection; requires integration review.
- `docs/superpowers/plans/2026-10-08-idea3-ctv-immutable-failure-successor.md` — implementation plan; requires integration review because it is outside the IDEA3 owned code/knowledge boundary.

## Integration requests

- Kla/integration reviewer: inspect CTv stage registration and authorization field contract before any authority is generated.
- Recovery owner: review the CTv CLOSED_PASS successor path and confirm Recovery remains blocked until a separately reviewed CTv closeout exists.
- Human owner: independently review exact-main frozen-runner derivation, then decide whether any future LIVE authority may be created. No LIVE execution is authorized by this receipt.

## Known limitations

- CTv LIVE execution, Production mutation, and Recovery LIVE execution were not performed by design.
- The implementation is repository-only and remains pending independent security/governance review and broad regression verification.
- One Recovery socket rehearsal remains host-capability blocked in the sandbox (`EPERM`); no Production or service state was touched.
