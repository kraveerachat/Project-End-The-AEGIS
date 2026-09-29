---
title: Task Receipt — L7 PROCESS_ENV_LEAK repository remediation
date: 2026-09-30T03:47:37+07:00
owner: music
area: idea3
branch: fix/idea3-l7-process-env-contract
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — L7 PROCESS_ENV_LEAK repository remediation

## What changed

- Task: L7 PROCESS_ENV_LEAK repository remediation (PR #261). Base SHA `fdc2dd3d3ee5d69f303a6767047509dc37150f75`; source-fix SHA `d4caea54a6dd71b5defd746e3b4fba750ed1fba9`.
- Historical L7 #4 live result (owner-run, before this task): `L7_APPLY=PASS`, `L7_VERIFY=FAIL reason=PROCESS_ENV_LEAK`, `L7_ROLLBACK=PASS`, `L7_MATERIAL_RESIDUE=NO`, `PRE_RB_COMPARE=PASS`, `PRESERVATION_S10=PASS`, `L7_LIVE_ACCEPTANCE=NOT_PROVEN`. Authorization #4 is consumed and must not be reused.
- Root cause: the blank `AEGIS_TG_TOKEN=` in the shared `deploy/aegis-idea3-core.env.example` was rendered into the Production `core.env`; systemd `EnvironmentFile=` projects even a blank key into `/proc/<MainPID>/environ`, and `verify.sh` (unchanged, strict) rejects the name.
- Implementation: `p4-l7-core-env.py` adds `AEGIS_TG_TOKEN` to `FORBIDDEN` (mirroring `verify.sh` `FORBIDDEN_ENV`), `render` omits forbidden keys, `check` rejects `AEGIS_TG_TOKEN` with `FORBIDDEN_KEY` even when blank; the `SECRET_IF_SET` path is removed. The shared example and `AEGIS_TG_CHAT` handling are unchanged. New regression tests parse `verify.sh` `FORBIDDEN_ENV` and assert none of its names are rendered or accepted.
- Production mutation = NO. L7 live rerun = NO. Authorization #5 = NOT_CREATED. ESP32/L8 = NOT_STARTED.

## Source files changed

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-l7-core-env.py` — renderer omits and checker rejects `AEGIS_TG_TOKEN`
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l7_core_env_helper.py` — updated contract tests plus the three regression tests

## Verification evidence

- `~/.venvs/aegis-idea3-core/bin/python -m pytest tests/test_pr11_phase4_l7_core_env_helper.py tests/test_pr11_phase4_l7_handler.py tests/test_pr11_phase4_l7_runner.py tests/test_pr11_phase4_l7_runner_flow.py tests/test_core_service.py tests/test_broker_config.py -q` — pass: 465 passed, 0 failed
- `~/.venvs/aegis-idea3-core/bin/python -m pytest tests -q -x -p no:cacheprovider` — pass: 4064 passed, 8 skipped, 0 failed
- `git diff --check` — pass
- RED before implementation — fail as expected: 6 failed, 73 passed (exact historical command not recorded in the task log)

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — added the L7 #4 PROCESS_ENV_LEAK entry: failed safely on a repository contract mismatch, rollback passed, no residue, acceptance NOT_PROVEN

## Shared surfaces touched

- None — task stayed inside its selected area

## Integration requests

- None — no cross-scope/shared path changed

## Known limitations

- Repository-verified only; L7 live acceptance remains NOT_PROVEN.
- The next live attempt requires merge + fresh freeze + fresh readiness + fresh A-L7/K3-L7.
