---
title: Task Receipt — IDEA3 ICu governed executor
date: 2026-10-11T00:26:23+07:00
owner: music
area: idea3
branch: feat/idea3-icu-governed-executor
status: partial
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 ICu governed executor

## What changed

- Registered ICu between CTv and Recovery; added exact-pin frozen runner generation, stage authority binding, one-attempt marker, durable write-ahead journal, read-only preflight, existing-release install/switch path, and exact OLD release rollback.
- The runner hard-blocks before attempt consumption, installation, pointer mutation, or restart while the actual installed-unit restart consequence is NOT_PROVEN. CTu/CTv remain immutable FAIL; Recovery remains blocked.
- No Production mutation, Core restart, Detector lifecycle command, MQTT dispatch, CUT, RESTORE, or IDEA1/IDEA2 change occurred. NEW was not rebuilt.

## Source files changed

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-lib.sh` — register ICu after CTv and before Recovery; bind exact authority fields.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-stage-gate.sh` — validate ICu Authorization/K3 exact pins and reject unrelated authority.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-icu-upgrade.py` — durable marker/journal, exact authority/preflight, release/unit checks, bounded executor and rollback primitives.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/icu_runner_freeze.py` — freeze runner against authoritative main, operator, unit snapshot, and checkout path.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/owner-run/run-icu-owner.sh` — read-only host preflight and fixed restart-effect refusal before marker consumption.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/ICu/apply.sh` — consume only an authorized attempt with the required journal phase, install existing pinned release, atomically switch pointer.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/ICu/verify.sh` — verify Core and unchanged inactive Detector state.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/ICu/rollback.sh` — restore only exact pinned OLD release; no Detector command.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/ICu/allow-keys.txt` — permit only Core-owned release/pointer/process identity deltas.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/ICu/allow-listeners.txt` — declare no new listener.
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_icu_executor.py` — add 12 offline executor, authority, freeze, journal, rollback, and refusal tests.
- `IDEA3-AEGIS_Lockdown/tests/r1b/test_r1b_live_failure_closeout.py` — update stage order assertion.
- `IDEA3-AEGIS_Lockdown/tests/r1b/test_r1b_stage.py` — update stage order assertion.
- `IDEA3-AEGIS_Lockdown/tests/r1i/test_r1i_input_instrumentation.py` — update stage order assertion.
- `IDEA3-AEGIS_Lockdown/tests/rru/test_rru_stage.py` — update stage order assertion.
- `IDEA3-AEGIS_Lockdown/tests/test_core_trusted_time_repair.py` — update stage order assertion.
- `IDEA3-AEGIS_Lockdown/tests/test_ctv_successor.py` — update stage gate order assertion.
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_dnsmasq_unit_repair_reboot_and_scope.py` — update stage registry assertion.
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_f1u_stage.py` — update stage registry assertion.
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l7u_stage_governance.py` — update expected stage order.
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l8p_provisioning.py` — update expected stage order.
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_lvr_l8_l9_offline_contract.py` — update registry order while retaining Recovery's separate predecessor blocker.
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_r1du_stage.py` — update stage registry assertion.
- `IDEA3-AEGIS_Lockdown/tests/test_r1_acceptance.py` — update stage order assertion.
- `IDEA3-AEGIS_Lockdown/tests/test_recovery_stage.py` — update stage order assertion; Recovery gate unchanged.
- `IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-10-10-idea3-inactive-core-successor-design.md` — document executor implementation and retained live blocker.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — record ICu session S3 and current implementation/blocker state.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-10-11_002623_music_idea3-icu-governed-executor.md` — this immutable task receipt.

## Verification evidence

- `PYTHONDONTWRITEBYTECODE=1 /home/kittipat/.venvs/aegis-idea3-core/bin/python -m pytest -p no:cacheprovider -q tests/test_pr11_phase4_icu_executor.py` — pass: 12 passed.
- `PYTHONDONTWRITEBYTECODE=1 /home/kittipat/.venvs/aegis-idea3-core/bin/python -m pytest -p no:cacheprovider -q tests/test_pr11_phase4_icu_executor.py tests/test_recovery_stage.py tests/test_pr11_phase4_l7u_stage_governance.py tests/test_pr11_phase4_l8p_provisioning.py tests/test_pr11_phase4_lvr_l8_l9_offline_contract.py tests/test_pr11_phase4_r1du_stage.py tests/test_pr11_phase4_f1u_stage.py tests/test_ctv_successor.py` — partial: 1,107 passed, 1 xfailed, 1 failed in 53.08s. Failure: `test_recovery_acceptance_never_claims_lvr_l8_or_l9` found existing `("LVR_PROVEN", "YES")` in `deploy/pr11-phase4/recovery-acceptance`; no Recovery implementation source changed.
- `bash -n deploy/pr11-phase4/owner-run/run-icu-owner.sh deploy/pr11-phase4/stages/ICu/apply.sh deploy/pr11-phase4/stages/ICu/verify.sh deploy/pr11-phase4/stages/ICu/rollback.sh` — pass.
- Python `ast.parse` of `deploy/pr11-phase4/p4-icu-upgrade.py` and `deploy/pr11-phase4/icu_runner_freeze.py` — pass.
- `git diff --check` — pass.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — replace stale PR #430 draft/unregistered status with merged main `4ebade39a3ae2bf2c4fd75f0ebba0edb46248e17`, ICu implementation, and retained NOT_PROVEN blocker.
- `IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-10-10-idea3-inactive-core-successor-design.md` — replace stale “no executor” state with implemented repository state and live boundary.

## Shared surfaces touched

- None — task stayed inside IDEA3 source and knowledge boundaries.

## Integration requests

- Request independent Security review and functional-owner review from `kraveerachat`; reviewers must complete and tick the GitHub Review Checklist. Review the exact ICu authority binding, WAL ordering, attempt semantics, rollback ownership, and Detector-preservation controls. Keep the PR Draft until the suite failure is resolved or accepted by the reviewers.
- Keep live execution blocked until actual installed-unit restart behavior is proven and separately reviewed; then require fresh exact-host preflight and separate human authorization. This branch does not authorize rollout.

## Known limitations

- Actual installed-unit restart effect remains NOT_PROVEN. Runner exits before marker consumption and all Production mutations.
- CTu and CTv remain immutable consumed FAIL. Recovery remains blocked and its gate was not changed.
- Broad offline verification has the recorded unrelated Recovery acceptance assertion failure; do not claim the full batch passed.
- No installed OLD/NEW host artifact was inspected or mutated in this task; the runner will verify exact existing release bytes and will not rebuild NEW.
- Branch is based on the PR #430 merge tree confirmed through GitHub metadata; local network restrictions prevented fetching the authoritative merge commit object into the isolated clone.
