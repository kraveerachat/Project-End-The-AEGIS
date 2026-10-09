---
title: Task Receipt — L7 BROKER_NOT_CONNECTED status convergence remediation
date: 2026-09-30T05:05:00+07:00
owner: music
area: idea3
branch: fix/idea3-l7-broker-status-convergence
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — L7 BROKER_NOT_CONNECTED status convergence remediation

## What changed

- Task: L7 #5 BROKER_NOT_CONNECTED repository remediation. Base main `ca8c0133b59695a4b9f0689d7efd61991af8ab32` (freshness rechecked, exact match).
- Historical L7 #5 live result (owner-run, before this task): `L7_APPLY=PASS`, `L7_VERIFY=FAIL reason=BROKER_NOT_CONNECTED`, `L7_ROLLBACK=PASS`, `L7_MATERIAL_RESIDUE=NO`, `PRE_RB_COMPARE=PASS`, `PRESERVATION_S10=PASS`, `L7_LIVE_ACCEPTANCE=NOT_PROVEN`. Authorization #5 is CONSUMED; no retry.
- Root cause: the Core connected to the broker over TLS 1.3 at 04:37:10 (supervisor audit and broker journal agree), but `AegisSupervisor._on_connection` only updated in-memory state; `status.json` was rewritten by the next health-loop pass (default 5 s) while L7 apply waits 3 s before verify, so verify read a stale broker value. Classified as a repository/runtime status convergence defect, not broker connectivity.
- Implementation: `_on_connection` persists status via `RuntimeStatus.write` on every connect/disconnect; `OSError` is logged and never raised into the MQTT thread. `verify.sh` and `apply.sh` are unchanged; no sleep or verifier wait added; all L7 checks remain strict.
- Review finding (PR #265): `os.replace` is atomic but does not order concurrent writers, so an older supervisor-loop snapshot (taken while broker=UNKNOWN) could land after the callback's CONNECTED write. Remediation: `RuntimeStatus.write` now takes a module-level lock around snapshot + temp write + `os.replace`, so every writer (`transition()`, `set_armed()`, `_on_connection()`) snapshots live state after all earlier writes have landed. No verifier wait or sleep was added; `verify.sh`/`apply.sh` remain unchanged and strict.
- Production mutation = NO. L7 live rerun = NO. Authorization #6 = NOT_CREATED. ESP32/L8 = NOT_STARTED. L7 is not claimed proven.

## Source files changed

- `IDEA3-AEGIS_Lockdown/aegis_soc/supervisor.py` — persist broker status on the MQTT connection callback
- `IDEA3-AEGIS_Lockdown/aegis_soc/runtime.py` — serialize `RuntimeStatus.write` (snapshot + replace) under a lock
- `IDEA3-AEGIS_Lockdown/tests/test_supervisor_broker_status_convergence.py` — new regression tests (connect, disconnect, write-failure safety, out-of-order in-flight write for `transition` and `set_armed`)

## Verification evidence

- RED: `~/.venvs/aegis-idea3-core/bin/python -m pytest tests/test_supervisor_broker_status_convergence.py -q` before the fix — fail as expected: 2 failed, 1 passed (the write-failure test passes vacuously pre-fix)
- Same command after the fix — pass: 3 passed
- `~/.venvs/aegis-idea3-core/bin/python -m pytest tests/test_runtime.py tests/test_mqtt_client.py tests/test_protocol_ordering.py tests/test_local_restore.py tests/test_pr11_phase4_l7_*.py tests/test_dispatch_boundary.py -q` — pass: 951 passed, 0 failed (includes the existing strict verifier tests: DISCONNECTED broker, missing status, and missing outbound :8883 connection each still fail)
- `~/.venvs/aegis-idea3-core/bin/python -m pytest -q -p no:cacheprovider` (IDEA3 full suite) — pass: 4067 passed, 8 skipped, 0 failed
- `git diff --check` — pass
- `node scripts/validate-vault.mjs` — pass with 2 pre-existing owner-data canvas warnings

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — added the L7 #5 BROKER_NOT_CONNECTED entry: failed safely on a status persistence race, rollback passed, acceptance NOT_PROVEN

## Shared surfaces touched

- None — task stayed inside its selected area

## Integration requests

- None — no cross-scope/shared path changed

## Known limitations

- Repository-verified only; L7 live acceptance remains NOT_PROVEN.
- The next live attempt requires merge + fresh freeze + fresh readiness + fresh A-L7/K3-L7.

## Post-review verification history (PR #265)

- After merging main `1ea2efbf` into the branch: full suite run 1 — 1 failed, 4066 passed, 8 skipped; failing test `tests/test_pr11_phase4_l6c_capture_gap.py::test_real_end_to_end_capture_then_compare_requires_the_allow_file`; that module passed alone (33 passed); full suite run 2 — 4067 passed, 8 skipped. The intermittent run is disclosed, cause not established.
- Concurrency RED (2 failed: file regressed to UNKNOWN for both in-flight `transition` and `set_armed`), GREEN after the lock (5 passed). Final full-suite result for the remediated head is recorded in the PR body.
