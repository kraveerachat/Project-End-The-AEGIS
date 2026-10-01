---
title: Task Receipt — IDEA3 L6c/L7 broker runtime stability gate (repository only)
date: 2026-09-29T21:00:00+07:00
owner: music
area: idea3
branch: fix/idea3-l6c-broker-stability-gate
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 L6c/L7 broker runtime stability gate (repository only)

## What changed

- `l7_broker_runtime_gate` (shared by the L6c and L7 owner runners) no longer requires `NRestarts=0`. It now requires the broker to be healthy and stable NOW: active/running/enabled/success, numeric non-zero MainPID, numeric NRestarts (may be > 0), non-empty InvocationID and exactly `10.77.30.1:8883` + `127.0.0.1:8883`, on each of 3 read-only samples 2 s apart with an identical MainPID/NRestarts/InvocationID tuple. Window constants are unconditional assignments, not environment-derived. Any change or bad sample fails closed.
- Old policy: NRestarts must equal 0 (rejected the V5-recovered broker at NRestarts=646). New policy: historical restarts allowed only with current stability.
- The gate stays strictly read-only (no start/stop/restart/reset-failed). BROKER_PRE snapshots, `s10_unchanged()`, `p4-compare.sh`, release builder/guard/install, `aegis_soc/**` and `requirements.txt` are unchanged, so staged release `3c8dae69ca17fae2c7949ceb4bbca8f20239ba1b` remains reusable (`RELEASE_CLOSURE_CHANGED=NO`, `RELEASE_TOOLING_CHANGED=NO`).

## Source files changed

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-l7-run-lib.sh` — stability-window gate.
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l7_runner.py` — RED-first gate tests (old lib at BASE rejects NRestarts=646; new accepts), unhealthy/identity/listener/transition rejects, env non-weakening, read-only scan, snapshot-unchanged checks.

## Verification evidence

- `pytest tests/test_pr11_phase4_l7_runner.py` — pass: 124 passed.
- `pytest tests/test_pr11_phase4_l6c_runner.py tests/test_pr11_phase4_l6c_runner_flow.py tests/test_pr11_phase4_l7_runner_flow.py` — pass: 86 passed.
- `pytest tests/test_pr11_phase4*.py` — pass: 2825 passed, 2 skipped (final run after the wait-failure fix). An earlier run overlapping another pytest process had one failure in `test_pr11_phase4_l6c_capture_gap.py::test_real_end_to_end_capture_then_compare_requires_the_allow_file`; that file passes in isolation on this branch (33) and on unmodified BASE 21b52d5e (33) — load flake, not a regression.
- The wait between samples is checked explicitly: a failed/interrupted `sleep` returns `L7_BROKER_STABILITY_WAIT_FAILED` (fail closed, covered by a test).
- `bash -n` on `p4-l7-run-lib.sh` — pass. `git diff --check` — pass. `node scripts/validate-vault.mjs` — passed.
- No live command against Production was run.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — L6c/L7 broker stability gate section.

## Shared surfaces touched

- None — task stayed inside `idea3`.

## Integration requests

- None. Live L6c still needs its own fresh A-L6c authorization + K3 (owner decision).

## Known limitations

- Repository/stub-tested only; not proven against the live broker. The 3-sample, 2-second-spacing window (~4 s first-to-last) is a prerequisite gate, not a soak.
