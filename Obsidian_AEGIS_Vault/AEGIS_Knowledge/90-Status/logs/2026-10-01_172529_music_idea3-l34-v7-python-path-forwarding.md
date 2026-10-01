---
title: Task Receipt — IDEA3 L34 V7 python-path forwarding fix
date: 2026-10-01T17:25:29+07:00
owner: music
area: idea3
branch: fix/idea3-l34-v7-python-path-forwarding
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 L34 V7 python-path forwarding fix

## What changed

- Repository-only fix after the owner's first V7 live attempt (2026-10-01 16:49 +07, frozen runner sha256 `477ac802d583503f4f54d42b8671c9b6aa11d2e6616e9859814012f4193bcef1`, main `352b755083b23c97642d84e0c1400bdc436adb4e`) stopped in the read-only handler preflight with `L34_V7_APPLY=FAIL reason=V7_PROBE_PYTHON_INVALID`. **V7 was NOT run by this task; the failed attempt changed nothing; the one-shot authorization was NOT consumed; no production mutation; Core NOT restarted; no ESP32; no L8; Recovery R1-R8 NOT run.**
- Read-only incident verification: no `L34-V7-REACTIVATION-ATTEMPT-CONSUMED` in the authorization directory; the failed attempt's evidence directory holds only the authorization copies, `frozen-inputs.txt`, `journal_since.txt` and `owner-run.log` (no `production-mutation` marker, no work/preflight directory); host state still the V7 baseline (phy0 soft-blocked, NM radio disabled, dnsmasq failed/start-limit-hit, broker auto-restart, Core unchanged, no 8883 listener).
- Root cause `V7_OWNER_RUNNER_PYTHON_ENV_NOT_FORWARDED`: `apply.sh` reads `AEGIS_L34_V7_PYTHON` (default `python3`) and in live mode accepts only an absolute executable path; the runner's `handler()` never forwarded its frozen absolute `PY`, so `sudo env` left the handler on `python3`. The V6 runner already forwards `AEGIS_L34_V6_PYTHON="$PY"`.
- Fix: the V7 owner-run template `handler()` now passes `AEGIS_L34_V7_PYTHON="$PY"`. `apply.sh` is NOT loosened: PATH-relative or non-executable python stays fail-closed.

## Source files changed

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/owner-run/run-l34-v7-radio-disabled-broker-churn-owner.sh` — `handler()` forwards `AEGIS_L34_V7_PYTHON="$PY"` (one token).
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l34_v7_owner_run_flow.py` — stand-in handler models apply.sh's live absolute-python gate and logs the forwarded value; `Sim(py=, forward_python=)`; 8 new tests (incl. negative control and 4 bad-python cases).
- `IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-10-01-idea3-pr11-phase4-l34-v7-radio-disabled-broker-churn-design.md` — documents the python-authority forwarding.

## Verification evidence

- RED first: `pytest tests/test_pr11_phase4_l34_v7_owner_run_flow.py` before the runner change — `10 failed, 20 passed`; the existing full-flow test reproduced `V7_PROBE_PYTHON_INVALID` / `preflight failed; NOTHING was changed`.
- After the fix: same file — `30 passed`.
- Negative control (temporary source mutation, restored byte-identical, sha256 asserted): removing the forwarding from the runner — `10 failed, 20 passed`; restored — `30 passed`.
- Full Phase 4 (`pytest tests/test_pr11_phase4_*.py`, includes all L34 modules) — pass: `3251 passed, 2 skipped, 0 failed` (1320 s), run before the doc edits.
- `bash -n` on the V7 runner — pass. `git diff --check` — pass.
- Doc-reading modules re-run after the doc edits (17 modules referencing the vault/specs/status note) — pass: `1362 passed`.
- `node scripts/validate-vault.mjs` — pass: `Vault validation passed with 2 warning(s)` (pre-existing canvas owner-review warnings). `node scripts/validate-collaboration-policy.mjs --event <simulated Draft event> --changed-files <git diff --cached --name-status origin/main>` — pass: `Collaboration policy passed.` Secret-pattern scan over the staged diff — pass: no hits.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — added the V7 python-path forwarding section; repository-only, nothing live; marks the `477ac802…` frozen runner DO_NOT_RETRY.

## Shared surfaces touched

- `None` — task stayed inside its selected area

## Integration requests

- None — valid only when no cross-scope/shared path changed

## Known limitations

- Simulator-tested only; the real `sudo env` environment reset and the real handler preflight are verified only by the next live attempt, which fails closed.
- The frozen runner `477ac802…` embeds the unfixed template and must not be retried. After human merge a NEW runner must be frozen at the new main, with a fresh same-day `stage=L4` authorization and K3 record and explicit owner live authorization.
- The pre-V7 S10 result (`FAIL_EXPECTED_BROKER_CHURN`, `FRESH_IDEA2_HEALTH=PASS_LIMITED`) was collected before this fix and may need re-confirmation at the owner's discretion.
