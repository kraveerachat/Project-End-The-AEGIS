---
title: Task Receipt — IDEA3 CTu Runner Git Eval Quoting Repair
date: 2026-10-07T20:38:39+07:00
owner: music
area: idea3
branch: fix/idea3-ctu-runner-git-eval-quoting
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 CTu Runner Git Eval Quoting Repair

## Operational truth

- `CTU_ATTEMPT_CONSUMED=NO`
- `CTU_LIVE_EXECUTED=NO`
- `RECOVERY_ATTEMPT_CONSUMED=NO`
- `RECOVERY_LIVE_EXECUTED=NO`
- `PRODUCTION_RUNTIME_MUTATION_PERFORMED=NO`
- `MERGE_PERFORMED=NO`
- `PRECONSUME_MUTATION=0`
- `SUCCESS_CORE_RESTARTS=1`
- `POSTCONSUME_FAILURE_MAX_CORE_RESTARTS=2`
- `EXPLICIT_DETECTOR_LIFECYCLE_COMMANDS=0`
- `MARKER_ORDER=PASS`
- `RECOVERY_SUCCESSOR_CONTRACT=PASS`

The frozen CTu runner entry failed closed before stage governance initialization (`fatal: cannot change to '"/home/kittipat/Workspace/IDEA3-Cyber-Last/ctu-live-main-6a5a7a7f"': No such file or directory` and `run-ctu-owner.FROZEN.sh: line 51: ctu_operator_identity_gate: command not found`). The failed frozen runner bound to main `6a5a7a7f31912b1bf51c0349beca6699184bcca3` and SHA `5fe09edc51133aa502e865fb817ee5b5b95faec126c447873e5bc574955b89d1` is invalidated for future LIVE use. CTu attempt remains unconsumed, CTu LIVE was NOT executed, and no Production runtime mutation occurred.

## What changed

- Repaired CTu owner runner template (`IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/owner-run/run-ctu-owner.sh` line 49): replaced `eval "$(git -C \"$REPO\" show \"$EXPECTED_MAIN:IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-ctu-run-lib.sh\")"` with `eval "$(git -C "$REPO" show "$EXPECTED_MAIN:IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-ctu-run-lib.sh")"`. Inside bash command substitution `"$( ... )"`, double quotes nest directly; escaping them as `\"` caused literal double quotes in `argv` passed to `git -C`, causing `chdir` to fail and leaving `ctu_operator_identity_gate` undefined.
- Audited the entire runner script for command substitution, eval, and quote escaping patterns. All other command substitutions use normal unescaped quotes (e.g. `$(git -C "$REPO" rev-parse HEAD)`, `$(sha256sum "$UNIT_SOURCE" | cut -d' ' -f1)`, `$(sudo -n systemctl ...)`). Line 49 was the only instance of backslash-escaped quotes.
- Preserved exact-main git object loading with `GIT_NO_REPLACE_OBJECTS=1`; did not switch to mutable worktree sourcing or direct filesystem sourcing.
- Added comprehensive behavioral regression test `test_ctu_runner_git_eval_library_load_regression` in `IDEA3-AEGIS_Lockdown/tests/test_ctu_blockers.py`:
  1. Proves the exact library-load expression extracted from the runner executes successfully against a real Git repository, loads `p4-ctu-run-lib.sh`, and defines `ctu_operator_identity_gate`.
  2. Proves that executing the BASE_MAIN expression with escaped quotes fails with `cannot change to '"` and leaves `ctu_operator_identity_gate: command not found`.
  3. Negative control proves that genuine git object loading failure fails with non-zero exit code (127) and does not silently proceed under `set -Eeuo pipefail`.

## Source files changed

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/owner-run/run-ctu-owner.sh` — removed backslash escaping from nested double quotes in line 49 git show eval expression.
- `IDEA3-AEGIS_Lockdown/tests/test_ctu_blockers.py` — added behavioral regression test covering repaired library load, BASE_MAIN regression failure, and negative control.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-moc.md` — updated current repair truth with runner quoting repair.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — recorded CTu runner git eval library load quoting repair and CTu-S6 session register.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-10-07_203839_music_idea3-ctu-runner-git-eval-quoting.md` — this immutable task receipt.

## Verification evidence

- `pytest -v IDEA3-AEGIS_Lockdown/tests/test_core_trusted_time_repair.py IDEA3-AEGIS_Lockdown/tests/test_ctu_blockers.py` — pass: 78 passed in 2.17s.
- `pytest -q IDEA3-AEGIS_Lockdown/tests/recovery IDEA3-AEGIS_Lockdown/tests/test_recovery_stage.py IDEA3-AEGIS_Lockdown/tests/test_recovery_evidence.py IDEA3-AEGIS_Lockdown/tests/test_recovery_final_verify.py` — pass: 676 passed in 75.63s.
- `bash -n IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/owner-run/run-ctu-owner.sh` — pass: zero syntax errors or warnings.
- `python3 -m py_compile IDEA3-AEGIS_Lockdown/tests/test_ctu_blockers.py` — pass.
- `git diff --check` — pass: clean whitespace, no trailing whitespace, no EOF issues.
- `node scripts/validate-vault.mjs` — pass with 2 pre-existing canvas owner-review warnings.
- `node --test tests/vaultStructure.test.mjs tests/vaultMultiWriter.test.mjs tests/collaborationPolicy.test.mjs` — pass: 59 passed in 769ms.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-moc.md` — updated current repair truth with runner quoting repair details and failed frozen runner invalidation.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — added CTu runner git eval library load quoting repair section and CTu-S6 session register.

## Shared surfaces touched

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/owner-run/run-ctu-owner.sh` — CTu owner runner template.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-moc.md` and `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — owner-maintained canonical IDEA3 state.

## Integration requests

- Music owner and independent Security/Governance reviewers must inspect the repaired quoting in `run-ctu-owner.sh` line 49 and the behavioral regression tests. Kla integration review is required for the shared Phase-4 deployment/governance surface before merge. After human merge of this repair PR, fresh post-merge exact-main clone, root authority, control snapshot, pins, frozen runner, Authorization, and K3 must be generated. The failed frozen runner (`5fe09edc...`) and historical failed authority must not be reused. HUMAN MERGE ONLY. No live execution is authorized by this receipt.

## Known limitations

- No Production host was contacted or mutated; CTu and Recovery remain unconsumed and unexecuted (`CTU_ATTEMPT_CONSUMED=NO`, `CTU_LIVE_EXECUTED=NO`, `RECOVERY_ATTEMPT_CONSUMED=NO`, `RECOVERY_LIVE_EXECUTED=NO`, `PRODUCTION_RUNTIME_MUTATION_PERFORMED=NO`).
- Live production host execution requires human review, human merge, and building fresh post-merge exact-main authority artifacts.
