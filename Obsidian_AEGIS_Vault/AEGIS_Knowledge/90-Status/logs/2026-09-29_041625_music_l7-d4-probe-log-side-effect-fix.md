---
title: Task Receipt — L7 D4 credential-probe import side effect fix
date: 2026-09-29T04:16:25+07:00
owner: music
area: idea3
branch: fix/idea3-pr11-l7-d4-probe-import-side-effect
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — L7 D4 credential-probe import side effect fix

## What changed

- A real authorized L7 owner-run attempt (2026-09-29, evidence at
  `idea3-p4-evidence/2026-09-29-l7-20260929-034536`) failed with `L7_APPLY=FAIL reason=D4_CREDENTIAL_UNSAFE` and
  rolled back cleanly (independently re-verified: all 8 journaled L7-owned paths absent afterward).
- Root cause, confirmed by direct source inspection and a standalone sandbox reproduction (not guessed):
  `aegis_soc.local_restore` imports `aegis_soc.database` at module scope, and `database.py` creates a
  `RotatingFileHandler(config.LOG_PATH, ...)` the instant it is imported. `config.LOG_PATH` falls back to the
  relative path `"aegis_soc.log"` whenever `AEGIS_LOG_PATH` is unset and no systemd runtime path is available —
  exactly the condition for `deploy/pr11-phase4/stages/L7/apply.sh`'s two D4 probes (a plain format-only
  `RestoreCredential.parse` check and the `as_service` `RestoreCredential.load` check), which import
  `aegis_soc.local_restore` directly, outside the production systemd environment. The probe therefore attempted to
  write a log file relative to whatever CWD `apply.sh` happened to run from; when that directory wasn't writable
  by the invoking identity, `RotatingFileHandler`'s `open()` raised `PermissionError` before `RestoreCredential`'s
  own checks ever ran — masked as `D4_CREDENTIAL_UNSAFE` (or `RESTORE_CREDENTIAL_INVALID` for the first probe)
  because both probes redirect stdout+stderr to `/dev/null`.
- The credential itself was never the problem: independently re-verified `RestoreCredential.load()` against the
  owner's actual restore.credential — valid scrypt format, correct mode/owner contract.
- Fix: both D4 probes in `apply.sh`, and the identical one in the sibling `verify.sh` (same file family, same
  one-line pattern — extending the mission's literal apply.sh-only scope since leaving verify.sh broken would only
  move the next live failure from L7_APPLY to L7_VERIFY), now explicitly set `AEGIS_LOG_PATH=/dev/null` for the
  probe subprocess. `RestoreCredential.load()`'s own security checks (regular file, exact mode 0600, owner ==
  running euid, O_NOFOLLOW, ASCII/size/scrypt-format validation) are completely untouched.
- A RED-first regression suite proves the defect against the unmodified handler and the fix against the patched
  one, using the real, unmocked `aegis_soc.local_restore` code throughout.
- Follow-up (same PR, still Draft): independent review found the identical import-side-effect pattern in
  `deploy/pr11-phase4/p4-l7-run-lib.sh`'s `l7_input_gate` — the read-only pre-gate `run-l7-owner.sh` runs before
  any authorization is consumed. It runs the same `RestoreCredential.parse` probe outside the production systemd
  environment and was originally left as a "known limitation" in this receipt; that limitation is now fixed and no
  longer true (see updated Source files / Verification evidence below). `protocol_v1.py`'s probe in the same gate
  is pure stdlib and does not import `aegis_soc.database`, so it was correctly left untouched.

## Source files changed

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/L7/apply.sh` — both D4 probes now run under
  `AEGIS_LOG_PATH=/dev/null` (`env AEGIS_LOG_PATH=/dev/null` / `as_service env AEGIS_LOG_PATH=/dev/null`), with a
  comment explaining the import-side-effect hazard.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/L7/verify.sh` — identical fix to its own D4 `as_service` probe.
- `IDEA3-AEGIS_Lockdown/tests/l7_support.py` — `Fx.run()` gained an optional `cwd` parameter so a test can pin the
  handler's working directory; no other behavior changed (default `cwd=None` matches the prior, uncontrolled cwd).
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l7_d4_probe_log_side_effect.py` — new RED→GREEN regression suite:
  proves no `aegis_soc.log` is created in a monitored, writable CWD, and that an unwritable CWD (faithfully
  reproducing the live incident) no longer causes `D4_CREDENTIAL_UNSAFE`/`RESTORE_CREDENTIAL_INVALID`; apply must
  still succeed and no secret appears in output.
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l7_handler.py` — updated one pre-existing static-text assertion
  (`test_l7_core_account_probes_use_the_installed_release_interpreter_live`) to match the new exact `as_service`
  invocation string; its actual security intent (must use `$SVC_PY`/`$SVC_CODE_ROOT` via `as_service`, never plain
  `$PY`) is unchanged and still enforced.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-l7-run-lib.sh` — `l7_input_gate`'s restore-credential probe now runs
  under `AEGIS_LOG_PATH=/dev/null`, same fix as apply.sh/verify.sh. `RestoreCredential` itself and the
  `protocol_v1` key probe are untouched.
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l7_runner.py` — `lib()` test helper gained `unset` (env keys to
  remove) and `cwd` parameters, mirroring `Fx.run()`'s earlier `cwd` addition; no other behavior changed.
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l7_input_gate_log_side_effect.py` — new RED→GREEN regression suite
  (5 tests) for `l7_input_gate`: proves no stray log in a writable monitored CWD, proves an unwritable CWD no
  longer false-fails with `L7_RESTORE_CREDENTIAL_INVALID`, proves a genuinely invalid credential is still rejected,
  and proves the gate passes regardless of ambient `AEGIS_LOG_PATH`. Uses only synthetic fixture secrets.

## Verification evidence

- `pytest tests/test_pr11_phase4_l7_d4_probe_log_side_effect.py -q` on pre-fix apply.sh — fail: 2 of 2 failed (RED confirmed; one proves the stray log appears, the other reproduces the exact live masked-failure symptom).
- `pytest tests/test_pr11_phase4_l7_d4_probe_log_side_effect.py -q` after the fix — pass: 2 passed.
- `pytest tests/test_pr11_phase4_l7_d4_probe_log_side_effect.py tests/test_pr11_phase4_l7_handler.py -q` — pass: 200 passed.
- `pytest tests/test_local_restore.py tests/test_systemd_credentials.py tests/test_pr11_phase4_l7_runner.py tests/test_pr11_phase4_l7_runner_flow.py tests/test_pr11_phase4_l7_core_env_helper.py -q` — pass: 346 passed.
- `bash -n deploy/pr11-phase4/stages/L7/apply.sh` — pass.
- `bash -n deploy/pr11-phase4/stages/L7/verify.sh` — pass.
- `bash -n deploy/pr11-phase4/stages/L7/rollback.sh` — pass (file unmodified).
- `ruff check tests/test_pr11_phase4_l7_d4_probe_log_side_effect.py` — pass: all checks passed. (Pre-existing ruff findings in `tests/l7_support.py` and `tests/test_pr11_phase4_l7_handler.py` were confirmed present on unmodified `origin/main` via a temporary stash-and-check — not introduced by this change, out of scope.)
- `git diff --check` — pass: no whitespace errors.
- Standalone sandbox reproduction (outside pytest): ran the real `RestoreCredential.load()` against the owner's actual restore.credential from a monitored CWD with `AEGIS_LOG_PATH=/dev/null` (the fix's exact override) — pass: `D4_LOAD_RESULT=PASS`, zero files created in the monitored CWD.
- `node scripts/validate-vault.mjs` — pass: 2 pre-existing owner-data warnings on unrelated canvas files, no new warnings from this task.
- `pytest tests/test_pr11_phase4_l7_input_gate_log_side_effect.py -q` on pre-fix p4-l7-run-lib.sh — fail: 2 of 5 failed (RED confirmed).
- `pytest tests/test_pr11_phase4_l7_input_gate_log_side_effect.py -q` after the fix — pass: 5 passed.
- `pytest tests/test_pr11_phase4_l7_input_gate_log_side_effect.py tests/test_pr11_phase4_l7_d4_probe_log_side_effect.py tests/test_pr11_phase4_l7_handler.py tests/test_pr11_phase4_l7_runner.py tests/test_local_restore.py tests/test_systemd_credentials.py -q` — pass: 469 passed.
- `pytest tests/test_pr11_phase4_l7_runner_flow.py -q` — pass: 31 passed.
- `pytest tests/test_pr11_phase4_harness.py -q` — pass: 222 passed.
- `bash -n deploy/pr11-phase4/p4-l7-run-lib.sh` — pass.
- `ruff check tests/test_pr11_phase4_l7_input_gate_log_side_effect.py` — pass: all checks passed. (Pre-existing findings in `tests/test_pr11_phase4_l7_runner.py` confirmed present on the unmodified file via a temporary stash-and-check — not introduced by this change.)
- Standalone sandbox reproduction (outside pytest, plain system `python3`, not even the pinned venv): ran the real `l7_input_gate` against a synthetic fixture input from a monitored CWD with `AEGIS_LOG_PATH` genuinely unset — `GATE_EXIT=0`, zero files created in the monitored CWD.

## Canonical notes updated

- `None` — scoped bug-fix task; no durable idea3 architecture/status fact changed beyond the fix itself.

## Shared surfaces touched

- `None` — task stayed inside `IDEA3-AEGIS_Lockdown/`.

## Integration requests

- None — idea3-only change, no cross-scope/shared path touched. Falls under the current approve-only-package convention (any of the three CODEOWNERS satisfies review).

## Known limitations

- L7 has not been retried; the authorization consumed by the failed attempt was not replaced. A fresh A-L7/K3 record and owner decision are required before any new live attempt, per this task's explicit instructions.
- None remaining from the import-side-effect defect: all three call sites that import `aegis_soc.local_restore` outside the production systemd environment (`apply.sh`'s two D4 probes, `verify.sh`'s D4 probe, and `p4-l7-run-lib.sh`'s `l7_input_gate` pre-gate probe) now pin `AEGIS_LOG_PATH=/dev/null`.
